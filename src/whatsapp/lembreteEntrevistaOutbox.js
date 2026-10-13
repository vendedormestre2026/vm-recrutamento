'use strict';

// Worker do WA3 — lembretes por WhatsApp (Baileys) da entrevista em grupo.
//
// NONA varredura periodica do projeto, com a anatomia das outras: interruptores checados antes
// de tocar o banco, trava em memoria contra ciclos sobrepostos, falha isolada por destinatario.
//
// ══════════════════════════════════════════════════════════════
// O QUE ESTE WORKER TEM DE DIFERENTE
// ══════════════════════════════════════════════════════════════
//
// ── NAO HA FILA. O QUE SAI E CALCULADO A CADA TICK ──
// Nenhuma linha e agendada de antemao. A cada minuto o worker olha as vagas com sala do Meet, as
// reunioes futuras, quem foi convidado (lib/publicoLembreteEntrevista) e o cronograma
// (lib/lembreteEntrevista), e decide o que esta vencido. Mudar a data da reuniao no admin muda o
// que sai, sem nada a reagendar nem a cancelar.
//
// ── RESERVA ANTES DE ENVIAR: NUNCA DUAS VEZES ──
// Antes de cada envio o worker grava a linha em lembretes_entrevista_enviados com status
// 'enviando' (INSERT OR IGNORE sobre o UNIQUE). So quem gravou envia. Dois ticks, dois boots ou
// dois ciclos concorrentes disputam a MESMA chave e so um ganha. Se o processo cair depois do
// envio e antes da marcacao, a linha fica 'enviando' e o lembrete nao sai de novo: perder um
// lembrete e melhor que mandar dois (a tela mostra esse caso como "indeterminado").
//
// ── CARENCIA DE 10 MIN ──
// Nada sai para uma reuniao antes de 10 min da primeira vez que o worker a viu: uma data
// digitada errado que caia dentro de uma janela de envio tem 10 min para ser corrigida.
//
// ── 9o DIGITO: A REGRA DO TRANSACIONAL ──
// Mesma regra de sequenciaOutbox.js (consulta com e sem o 9 numa chamada so; troca para a
// variante sem o 9 so quando ela vem confirmada e a com 9 nao; "nao verificado" tenta mesmo
// assim). Sem adiar lote: o lembrete tem hora para sair.
//
// ── SESSAO CAIU NO MEIO: PARA O CICLO ──
// Erro de socket/sessao fecha a linha daquele destinatario como 'falha' e INTERROMPE o ciclo.
// Os demais nao foram reservados, entao voltam no proximo tick, se ainda couberem na tolerancia.
// Seguir em frente queimaria a reserva de todo mundo contra um canal fechado.

const dbPadrao = require('../db');
const conexao = require('./connection');
const { mascarar, varianteSemNono } = require('./sequenciaOutbox');
const { paraTextoSqlUtc } = require('../lib/fusoBrasilia');
const L = require('../lib/lembreteEntrevista');
const { carregarPublicoLembrete, carregarOptout, suprimidoPorOptout } = require('../lib/publicoLembreteEntrevista');
const { montarTextoLembrete } = require('../lib/textosLembreteEntrevista');
const { linkPareceUrl } = require('../lib/entrevistaGrupo');

// Interruptor de banco (/admin/config). Default FALSE: chave ausente nao envia nada.
const CHAVE_ATIVO = 'wa3_ativo';

const INTERVALO_TICK_MS = 60 * 1000;

// Gap aleatorio entre duas mensagens. O wa3c sai para a vaga inteira no mesmo minuto: 60 pessoas
// levam ~7 min, dentro da tolerancia de 10 min.
const GAP_MIN_S = 4;
const GAP_MAX_S = 10;

// Ordem de envio dentro do ciclo: o mais urgente primeiro (o de 15 min tem a menor tolerancia).
const PRIORIDADE = { [L.WA3C]: 0, [L.WA3B]: 1, [L.WA3A]: 2 };

const RE_SESSAO_CAIDA = /sem socket|desconect|logout|logged out|401|WhatsApp em '/i;

function ativo(deps = {}) {
  const db = deps.db || dbPadrao;
  return db.obterConfigBool(CHAVE_ATIVO, false);
}

// Default TRUE, como WHATSAPP_SEQUENCIA_MOCK: a ausencia da variavel nao pode significar "envie".
function modoMock() {
  return String(process.env.WA3_MOCK || 'true').toLowerCase() !== 'false';
}

function dormirPadrao(ms) {
  if (!(ms > 0)) return Promise.resolve();
  return new Promise((r) => setTimeout(r, ms));
}

// ── LOG DE "DESATIVADO": uma linha por mudanca de estado, nao por tick (mesma regra da massa) ──
const TICKS_ENTRE_LEMBRETES = 60;
let ultimoMotivoDesativado = null;
let ticksDesativado = 0;

function logarDesativado(quais) {
  ticksDesativado += 1;
  if (quais !== ultimoMotivoDesativado) {
    ultimoMotivoDesativado = quais;
    ticksDesativado = 1;
    console.log(`[wa3] desativado (${quais}); ciclos serao pulados em silencio.`);
    return;
  }
  if (ticksDesativado % TICKS_ENTRE_LEMBRETES === 0) {
    console.log(`[wa3] segue desativado (${quais}) — ${ticksDesativado} ciclos pulados desde o aviso.`);
  }
}

function limparEstadoDesativado() {
  if (ultimoMotivoDesativado !== null) console.log(`[wa3] reativado (era: ${ultimoMotivoDesativado}).`);
  ultimoMotivoDesativado = null;
  ticksDesativado = 0;
}

function sortearGapMs(aleatorio) {
  return Math.round((GAP_MIN_S + (GAP_MAX_S - GAP_MIN_S) * aleatorio()) * 1000);
}

// Destino com a regra do 9o digito do transacional (sequenciaOutbox.js:393-412).
// Devolve { destino, existe } — existe: true | false | null (nao verificado).
async function resolverDestino(telefone, { onWhatsAppLote, verificarExiste }) {
  const semNono = varianteSemNono(telefone);
  if (semNono) {
    const mapa = await onWhatsAppLote([telefone, semNono]);
    const comNove = mapa.get(telefone);
    const semNove = mapa.get(semNono);
    if (semNove === true && comNove !== true) return { destino: semNono, existe: true };
    return { destino: telefone, existe: comNove };
  }
  const { existe } = await verificarExiste(telefone);
  return { destino: telefone, existe };
}

// ──────────────────────────────────────────────────────────────
// O CICLO
// ──────────────────────────────────────────────────────────────

// `deps` injetavel por inteiro: db, agora (Date do inicio do ciclo), relogio (() => Date, lido
// antes de cada envio), mock, baileysLigado, socketConectado, enviarTexto, onWhatsAppLote,
// verificarExiste, dormir, aleatorio. Nenhum teste toca rede, relogio real ou Math.random.
//
// Devolve { enviados, pulados, suprimidos, falhas, emCarencia, desativado?, motivo? }.
async function processarCicloLembretes(deps = {}) {
  const db = deps.db || dbPadrao;
  const resumo = { enviados: 0, pulados: 0, suprimidos: 0, falhas: 0, emCarencia: 0 };

  // ── KILL-SWITCHES, ANTES DE TOCAR O BANCO DE CANDIDATOS ──
  const switchBanco = ativo({ db });
  const switchEnv = deps.baileysLigado === undefined ? conexao.ligado() : deps.baileysLigado;
  if (!switchBanco || !switchEnv) {
    const quais = [!switchBanco ? CHAVE_ATIVO : null, !switchEnv ? 'WHATSAPP_BAILEYS_ATIVO' : null]
      .filter(Boolean)
      .join(' e ');
    logarDesativado(quais);
    return { ...resumo, desativado: true };
  }

  const mock = deps.mock === undefined ? modoMock() : deps.mock;
  if (!mock) {
    const conectado = deps.socketConectado === undefined
      ? conexao.status().status === 'conectado'
      : deps.socketConectado;
    if (!conectado) {
      logarDesativado('socket do WhatsApp desconectado');
      return { ...resumo, desativado: true, motivo: 'socket desconectado' };
    }
  }
  limparEstadoDesativado();

  const agora = deps.agora instanceof Date ? deps.agora : new Date();
  const relogio = deps.relogio || (() => (deps.agora instanceof Date ? deps.agora : new Date()));
  const agoraSql = paraTextoSqlUtc(agora);
  const aleatorio = deps.aleatorio || Math.random;
  const dormir = deps.dormir || dormirPadrao;
  const enviar = deps.enviarTexto || conexao.enviarTexto;
  const onWhatsAppLote = deps.onWhatsAppLote || conexao.onWhatsAppLote;
  const verificarExiste = deps.verificarExiste || conexao.verificarExisteWhatsapp;

  let vagas = [];
  try {
    vagas = db.listarVagasParaLembreteEntrevista();
  } catch (err) {
    console.error(`[wa3] falha ao consultar vagas: ${err.message}`);
    return resumo;
  }

  // ── 1. O QUE ESTA VENCIDO, EM TODAS AS VAGAS ──
  const fila = [];
  for (const vaga of vagas) {
    // Sala que nao comeca com http(s):// nao vira link no WhatsApp: lembrete sem sala clicavel
    // nao sai (a tela da vaga avisa — diagnosticarLembretesEntrevista).
    if (!linkPareceUrl(L.linkSalaDe(vaga))) continue;
    try {
      // Toda reuniao valida da vaga (inclusive as passadas) fica registrada: e o historico que
      // segura os convidados de um slot sobrescrito, e a referencia da carencia.
      const vistas = new Map();
      for (const r of L.reunioesDaVaga(vaga)) {
        const inicioUtc = paraTextoSqlUtc(r.instante);
        vistas.set(inicioUtc, db.registrarReuniaoVistaLembrete(vaga.id, inicioUtc, agoraSql));
      }

      const { reunioes } = carregarPublicoLembrete(vaga, { agora }, { db });
      for (const reuniao of reunioes) {
        if (!reuniao.destinatarios.length) continue;
        const vista = vistas.get(reuniao.inicioUtc);
        if (!L.carenciaCumprida(vista && vista.primeira_vez_vista, agora)) {
          resumo.emCarencia += 1;
          continue;
        }
        const chaves = db.chavesLembreteEntrevista(vaga.id, reuniao.inicioUtc, mock);
        for (const tipo of L.TIPOS) {
          for (const dest of reuniao.destinatarios) {
            if (chaves.has(`${dest.telefoneCanonico}|${tipo}`)) continue;
            const sit = L.situacaoLembrete({ tipo, inicio: reuniao.inicio, conviteEm: dest.conviteEm, agora });
            if (sit.acao === L.ACAO_AGUARDAR) continue;
            if (sit.acao === L.ACAO_PULAR) {
              const id = db.reservarLembreteEntrevista({
                jobId: vaga.id, applicationId: dest.applicationId, telefone: dest.telefone,
                telefoneCanonico: dest.telefoneCanonico, tipo, inicioUtc: reuniao.inicioUtc,
                mock, status: 'pulado', motivo: sit.motivo, quando: agoraSql,
              });
              if (id) resumo.pulados += 1;
              continue;
            }
            fila.push({ vaga, reuniao, dest, tipo });
          }
        }
      }
    } catch (err) {
      // Uma vaga com dado ruim nao derruba os lembretes das outras.
      console.error(`[wa3] vaga ${vaga.id}: falha ao calcular lembretes: ${err.message}`);
    }
  }
  if (!fila.length) return resumo;

  fila.sort((a, b) => PRIORIDADE[a.tipo] - PRIORIDADE[b.tipo] || a.reuniao.inicio - b.reuniao.inicio);

  // ── 2. ENVIO, UM POR VEZ ──
  const optout = carregarOptout({ db });
  let enviouAlgum = false;

  for (const item of fila) {
    const { vaga, reuniao, dest, tipo } = item;
    const chave = {
      jobId: vaga.id, applicationId: dest.applicationId, telefone: dest.telefone,
      telefoneCanonico: dest.telefoneCanonico, tipo, inicioUtc: reuniao.inicioUtc, mock,
    };

    // A tolerancia e conferida DE NOVO no relogio de agora: o ciclo pode levar minutos, e
    // "faltam 15 minutos" nao pode sair com 5.
    const agoraEnvio = relogio();
    const sit = L.situacaoLembrete({ tipo, inicio: reuniao.inicio, conviteEm: dest.conviteEm, agora: agoraEnvio });
    if (sit.acao === L.ACAO_PULAR) {
      if (db.reservarLembreteEntrevista({ ...chave, status: 'pulado', motivo: sit.motivo, quando: paraTextoSqlUtc(agoraEnvio) })) {
        resumo.pulados += 1;
      }
      continue;
    }
    if (sit.acao !== L.ACAO_ENVIAR) continue;

    if (suprimidoPorOptout(dest, tipo, optout)) {
      if (db.reservarLembreteEntrevista({ ...chave, status: 'opt_out', motivo: 'opt-out ativo no envio', quando: paraTextoSqlUtc(agoraEnvio) })) {
        resumo.suprimidos += 1;
        console.log(`[wa3] ${tipo} vaga ${vaga.id} -> ${mascarar(dest.telefone)}: opt-out; nao enviado.`);
      }
      continue;
    }

    const { texto, variacaoIndice, faltando } = montarTextoLembrete({
      tipo, nome: dest.nome, job: vaga, inicio: reuniao.inicio, aleatorio,
    });
    if (faltando.length) {
      if (db.reservarLembreteEntrevista({ ...chave, status: 'falha', motivo: `dado ausente: ${faltando.join(', ')}`, quando: paraTextoSqlUtc(agoraEnvio) })) {
        resumo.falhas += 1;
      }
      continue;
    }

    // Gap ENTRE envios, nao antes do primeiro.
    if (enviouAlgum) await dormir(sortearGapMs(aleatorio));

    // ── A RESERVA ──
    const id = db.reservarLembreteEntrevista({ ...chave, status: 'enviando', quando: paraTextoSqlUtc(relogio()) });
    if (!id) continue; // outro ciclo ja reservou esta chave
    enviouAlgum = true;

    if (mock) {
      console.log(
        `[wa3] (mock) ${tipo} vaga ${vaga.id} -> ${mascarar(dest.telefone)} ` +
          `(reuniao ${reuniao.inicioUtc} UTC, variacao ${variacaoIndice}, ${texto.length} chars). NAO enviado.`,
      );
      db.marcarLembreteEntrevistaEnviado(id, { variacaoIndice, quando: paraTextoSqlUtc(relogio()) });
      resumo.enviados += 1;
      continue;
    }

    try {
      const { destino, existe } = await resolverDestino(dest.telefone, { onWhatsAppLote, verificarExiste });
      if (existe === false) {
        db.marcarLembreteEntrevistaTerminal(id, 'sem_whatsapp', 'numero nao possui WhatsApp ativo');
        resumo.falhas += 1;
        console.warn(`[wa3] ${tipo} vaga ${vaga.id}: ${mascarar(dest.telefone)} sem WhatsApp; nao enviado.`);
        continue;
      }
      if (destino !== dest.telefone) {
        console.warn(`[wa3] ${mascarar(dest.telefone)}: WhatsApp registrado sem o nono digito; usando ${mascarar(destino)}.`);
      }
      await enviar(destino, texto);
      db.marcarLembreteEntrevistaEnviado(id, { variacaoIndice, quando: paraTextoSqlUtc(relogio()), telefone: destino });
      resumo.enviados += 1;
      console.log(`[wa3] ${tipo} vaga ${vaga.id} enviado para ${mascarar(destino)} (variacao ${variacaoIndice}).`);
    } catch (err) {
      db.marcarLembreteEntrevistaTerminal(id, 'falha', err.message);
      resumo.falhas += 1;
      if (RE_SESSAO_CAIDA.test(String(err.message))) {
        console.error(`[wa3] sessao do WhatsApp indisponivel (${err.message}); ciclo interrompido, o resto volta no proximo tick.`);
        break;
      }
      console.warn(`[wa3] ${tipo} vaga ${vaga.id}: falha no envio para ${mascarar(dest.telefone)}: ${err.message}`);
    }
  }

  if (resumo.enviados || resumo.pulados || resumo.suprimidos || resumo.falhas) {
    console.log(
      `[wa3] ciclo concluido — enviados: ${resumo.enviados}, pulados: ${resumo.pulados}, ` +
        `opt-out: ${resumo.suprimidos}, falhas: ${resumo.falhas}${mock ? ' (MOCK)' : ''}`,
    );
  }
  return resumo;
}

// ══════════════════════════════════════════════════════════════
// PRECEDENCIA SOBRE A MASSA (lido por whatsapp/massaOutbox)
// ══════════════════════════════════════════════════════════════
//
// Ha lembrete WA3 VENCIDO, ou que vence nos proximos HORIZONTE_PRECEDENCIA_MIN minutos, ainda sem
// linha gravada? A massa cede a vez enquanto isso for verdade — o lembrete tem hora, a campanha
// nao. NAO e permanente: cada lembrete deixa de contar assim que o worker o grava (enviado,
// pulado, opt-out, falha) ou quando passa da tolerancia (no maximo 3 h, a do wa3a).
//
// FALSE, sem tocar o banco de candidatos, quando o WA3 esta desligado ou em simulacao (mock nao
// usa o socket, entao nao disputa nada com a massa). Erro aqui tambem devolve false: uma falha de
// leitura nao pode travar a massa.
//
// Usa as MESMAS funcoes do ciclo (publico, cronograma, carencia, chaves gravadas), sem gravar
// nada: nem reserva, nem reuniao vista. Opt-out nao e consultado — um suprimido conta como
// pendente ate o proximo tick do WA3 grava-lo, o que custa no maximo um minuto de cessao.
const HORIZONTE_PRECEDENCIA_MIN = 5;

function existeLembretePendente(deps = {}) {
  const db = deps.db || dbPadrao;
  if (!ativo({ db })) return false;
  const mock = deps.mock === undefined ? modoMock() : deps.mock;
  if (mock) return false;

  const agora = deps.agora instanceof Date ? deps.agora : new Date();
  const horizonte = new Date(agora.getTime() + HORIZONTE_PRECEDENCIA_MIN * 60 * 1000);
  try {
    for (const vaga of db.listarVagasParaLembreteEntrevista()) {
      if (!linkPareceUrl(L.linkSalaDe(vaga))) continue;
      const vistas = new Map(db.listarReunioesVistasLembrete(vaga.id).map((v) => [v.inicio, v]));
      const { reunioes } = carregarPublicoLembrete(vaga, { agora }, { db });
      for (const reuniao of reunioes) {
        if (!reuniao.destinatarios.length) continue;
        const vista = vistas.get(reuniao.inicioUtc);
        if (!L.carenciaCumprida(vista && vista.primeira_vez_vista, horizonte)) continue;
        const chaves = db.chavesLembreteEntrevista(vaga.id, reuniao.inicioUtc, false);
        for (const tipo of L.TIPOS) {
          for (const dest of reuniao.destinatarios) {
            if (chaves.has(`${dest.telefoneCanonico}|${tipo}`)) continue;
            const base = { tipo, inicio: reuniao.inicio, conviteEm: dest.conviteEm };
            if (L.situacaoLembrete({ ...base, agora }).acao === L.ACAO_ENVIAR) return true;
            if (L.situacaoLembrete({ ...base, agora: horizonte }).acao === L.ACAO_ENVIAR) return true;
          }
        }
      }
    }
  } catch (err) {
    console.error(`[wa3] falha ao checar lembretes pendentes para a massa: ${err.message}`);
    return false;
  }
  return false;
}

// ── Trava em memoria contra ciclos sobrepostos ──
// O ciclo pode levar minutos (gap entre mensagens) e o tick e de 1 min. A trava descarta o tick
// que chega no meio; a garantia contra duplicidade, mesmo sem ela, e a reserva no banco.
let rodando = false;

async function varrerSeOcioso(deps = {}) {
  if (rodando) return null;
  rodando = true;
  try {
    return await processarCicloLembretes(deps);
  } catch (err) {
    console.error(`[wa3] erro inesperado no ciclo: ${err.message}`);
    return null;
  } finally {
    rodando = false;
  }
}

module.exports = {
  processarCicloLembretes,
  varrerSeOcioso,
  resolverDestino,
  existeLembretePendente,
  HORIZONTE_PRECEDENCIA_MIN,
  ativo,
  modoMock,
  CHAVE_ATIVO,
  INTERVALO_TICK_MS,
  GAP_MIN_S,
  GAP_MAX_S,
};
