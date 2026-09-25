'use strict';

// Worker do disparo em massa por WhatsApp (Baileys).
//
// OITAVA varredura periodica do projeto. A anatomia e a das sete anteriores (followupEntrevista,
// emailRecusa, lembreteInicio, limpezaAudio, dispararPromocao, sequenciaOutbox, campanhaWhatsapp):
// interruptor checado antes de tocar o banco, trava em memoria contra ciclos sobrepostos, teto por
// ciclo, marcacao SO apos sucesso, falha isolada por destinatario.
//
// ══════════════════════════════════════════════════════════════
// O QUE MUDA EM RELACAO AS OUTRAS SETE — E POR QUE
// ══════════════════════════════════════════════════════════════
//
//   as outras   drenam o que pode a cada ciclo      esta: CADENCIA (lote, gap aleatorio, pausa)
//   as outras   sem janela de horario               esta: 9h–18h, seg a sab, Brasilia
//   as outras   sem teto diario                    esta: teto diario em rampa
//   as outras   nao cedem a vez a ninguem           esta: CEDE ao transacional, sempre
//   as outras   erro isolado e segue                esta: DISJUNTOR pausa a campanha
//
// A razao de tudo isso e uma: aqui o canal pode ser BLOQUEADO, e bloqueio nao se recupera —
// perde-se o numero. Nenhuma das outras varreduras tem essa exposicao.
//
// ══════════════════════════════════════════════════════════════
// TRES DECISOES QUE VALEM SER LIDAS ANTES DE MEXER AQUI
// ══════════════════════════════════════════════════════════════
//
// ── 1. A CHECAGEM DE EXISTENCIA (onWhatsApp) ACONTECE AQUI, NAO NO PUBLICO ──
// lib/publicoMassaWhatsapp NAO fala com o socket, de proposito: consultar a existencia de milhares
// de numeros de uma vez e, ela mesma, um sinal de conta suspeita — seria pagar com risco de
// bloqueio por uma informacao que o envio descobre de graca. Aqui a consulta e do LOTE que esta
// prestes a sair (5 a 8 numeros, uma USyncQuery so), e quem o Baileys confirma NAO existir vira o
// status terminal 'sem_whatsapp'. "Nao verificado" (sem socket, erro, instabilidade) NAO exclui
// ninguem — mesmo criterio de tolerancia do motor transacional.
//
// ── 2. A INSTANCIA DO SOCKET E PARAMETRO, NUNCA CRAVADA ──
// Hoje ha uma sessao so (ver whatsapp/authState). A decisao de usar um NUMERO DEDICADO para
// a massa (B0) esta adiada, e este worker foi escrito para ela nao custar quase nada: tudo o que
// fala com o socket entra por `deps` (enviarTexto, onWhatsAppLote, socketConectado) e a instancia
// viaja em `deps.instancia`. Quando o B0 acontecer, muda-se quem injeta — nao este arquivo.
// NENHUM lugar daqui importa o nome da instancia nem chama conexao.enviarTexto sem passar por deps.
//
// ── 3. TODO O ESTADO DE CADENCIA VIVE NO BANCO ──
// `proximo_envio_em`, `ultima_variacao` e `erros_consecutivos` sao colunas (ver db/schema.sql). Um
// agendamento em memoria faria o worker, depois de um deploy, voltar disparando um lote inteiro no
// minuto em que o container subisse — a rajada que a cadencia existe para impedir.

const dbPadrao = require('../db');
const conexao = require('./connection');
const { normalizarTelefoneRecebido } = require('../lib/whatsapp');
const { chaveCanonicaTelefone } = require('../lib/chaveTelefone');
const optout = require('../lib/optoutWhatsapp');
const { proximaEntrevistaGrupo } = require('../lib/entrevistaGrupo');
const { inicioDoDiaBrasiliaUtc, paraTextoSqlUtc } = require('../lib/fusoBrasilia');
const cadencia = require('../lib/cadenciaMassaWa');
const variacoes = require('../lib/variacoesMassaWa');
const { mascarar } = require('./sequenciaOutbox');

// Interruptor de DISPARO, no store `configuracoes` — mesmo padrao de promocao_ativa,
// whatsapp_sequencia_ativa e campanha_whatsapp_ativa. Config de BANCO, com checkbox no painel.
//
// Default FALSE: a ausencia da chave NAO pode significar "pode disparar em massa".
const CHAVE_ATIVO = 'massa_wa_ativa';

// Intervalo do tick. Menor que a pausa entre lotes de proposito: o tick so CONFERE se ja pode
// enviar (a decisao esta em `proximo_envio_em`, no banco). Um tick longo faria a campanha perder
// janelas de envio por arredondamento.
const INTERVALO_TICK_MS = 60 * 1000;

// Quantas campanhas ativas um ciclo atende. Mais de uma campanha ativa ao mesmo tempo dobra a
// vazao no MESMO numero, o que anula a cadencia — o teto existe para isso nao passar batido, e o
// log avisa quando ha campanha ficando para tras.
const CAMPANHAS_POR_CICLO = 1;

function ativo(deps = {}) {
  const db = deps.db || dbPadrao;
  return db.obterConfigBool(CHAVE_ATIVO, false);
}

// Default TRUE: so sai mensagem de verdade quando alguem disser explicitamente que sim. Mesma
// regra de WHATSAPP_SEQUENCIA_MOCK.
function modoMock() {
  return String(process.env.MASSA_WA_MOCK || 'true').toLowerCase() !== 'false';
}

function dormirPadrao(ms) {
  if (!(ms > 0)) return Promise.resolve();
  return new Promise((r) => setTimeout(r, ms));
}

// Motivos de pausa do DISJUNTOR. Texto curto, gravado em campanhas_massa_wa.pausada_motivo e
// mostrado na tela — e a unica explicacao que o operador vai ter.
const MOTIVO_ERROS_CONSECUTIVOS = 'erros consecutivos no envio';
const MOTIVO_TAXA_FALHA = 'mais de 40% do lote falhou';
const MOTIVO_SESSAO_CAIDA = 'sessao do WhatsApp caiu ou foi desconectada (401/logout)';
const MOTIVO_LIMITACAO = 'sinal de limitacao do WhatsApp';
const MOTIVO_VARIACOES_INVALIDAS = 'as 7 variacoes nao passam a validacao';

// Sinais de limitacao/bloqueio na mensagem de erro do Baileys.
//
// Reconhecidos por SUBSTRING porque o Baileys nao expoe um codigo estavel para isso — a mensagem
// e o que ha. A lista e curta e explicita: qualquer um deles pausa a campanha na hora, sem esperar
// o terceiro erro, porque estes nao sao "falha de rede", sao o WhatsApp dizendo para parar.
const SINAIS_LIMITACAO = ['rate-overlimit', 'rate limit', 'too many', 'forbidden', 'not-authorized', 'blocked'];

function ehSinalDeLimitacao(mensagem) {
  const m = String(mensagem || '').toLowerCase();
  return SINAIS_LIMITACAO.some((s) => m.includes(s));
}

// ──────────────────────────────────────────────────────────────
// O CICLO
// ──────────────────────────────────────────────────────────────

// Uma passada. Sequencial de proposito — paralelizar envio de WhatsApp e como se perde um numero.
//
// `deps` injetavel por inteiro: db, relogio (`agora`), `aleatorio`, `dormir`, `enviarTexto`,
// `onWhatsAppLote`, `socketConectado`, `instancia`, `mock`. Nenhum teste deste worker toca rede,
// relogio real ou Math.random.
//
// Devolve { enviados, falhas, pulados, campanhas, desativado?, motivo? }.
async function processarCicloMassaWa(deps = {}) {
  const db = deps.db || dbPadrao;
  const resumo = { enviados: 0, falhas: 0, pulados: 0, campanhas: 0 };

  // ── KILL-SWITCHES, ANTES DE TOCAR O BANCO ──
  const switchBanco = ativo({ db });
  const switchEnv = deps.baileysLigado === undefined ? conexao.ligado() : deps.baileysLigado;
  if (!switchBanco || !switchEnv) {
    const quais = [!switchBanco ? CHAVE_ATIVO : null, !switchEnv ? 'WHATSAPP_BAILEYS_ATIVO' : null]
      .filter(Boolean)
      .join(' e ');
    console.log(`[massa-wa] desativado (${quais}); ciclo pulado.`);
    return { ...resumo, desativado: true };
  }

  const mock = deps.mock === undefined ? modoMock() : deps.mock;
  const agora = deps.agora instanceof Date ? deps.agora : new Date();
  const aleatorio = deps.aleatorio || Math.random;
  const dormir = deps.dormir || dormirPadrao;
  const enviar = deps.enviarTexto || conexao.enviarTexto;
  const onWhatsAppLote = deps.onWhatsAppLote || conexao.onWhatsAppLote;
  const espacamentoMs =
    deps.espacamentoGlobalMs === undefined ? cadencia.ESPACAMENTO_GLOBAL_MS : deps.espacamentoGlobalMs;

  // Socket conectado? Em mock nao importa (nada sai). No real, sem socket nao ha por que abrir a
  // fila: seria marcar tentativas contra um canal fechado.
  if (!mock) {
    const conectado = deps.socketConectado === undefined
      ? conexao.status().status === 'conectado'
      : deps.socketConectado;
    if (!conectado) {
      console.warn('[massa-wa] socket do WhatsApp nao esta conectado; ciclo pulado.');
      return { ...resumo, desativado: true, motivo: 'socket desconectado' };
    }
  }

  let ativas = [];
  try {
    ativas = db.listarCampanhasMassaWaAtivas();
  } catch (err) {
    console.error(`[massa-wa] falha ao consultar campanhas: ${err.message}`);
    return resumo;
  }
  if (!ativas.length) return resumo;

  if (ativas.length > CAMPANHAS_POR_CICLO) {
    // Nao e erro, e um aviso que precisa existir: duas campanhas ativas compartilham a MESMA
    // cadencia fisica (um socket), e o operador precisa saber que a segunda esta esperando.
    console.warn(
      `[massa-wa] ${ativas.length} campanhas ativas; este ciclo atende ${CAMPANHAS_POR_CICLO}. ` +
        'As demais ficam para os proximos ciclos (a cadencia e do NUMERO, nao da campanha).',
    );
  }

  for (const campanha of ativas.slice(0, CAMPANHAS_POR_CICLO)) {
    resumo.campanhas += 1;
    // eslint-disable-next-line no-await-in-loop
    const r = await processarCampanha(campanha, {
      db, mock, agora, aleatorio, dormir, enviar, onWhatsAppLote, espacamentoMs,
      instancia: deps.instancia,
    });
    resumo.enviados += r.enviados;
    resumo.falhas += r.falhas;
    resumo.pulados += r.pulados;
  }

  if (resumo.enviados || resumo.falhas || resumo.pulados) {
    console.log(
      `[massa-wa] ciclo concluido — enviados: ${resumo.enviados}, falhas: ${resumo.falhas}, ` +
        `pulados: ${resumo.pulados}${mock ? ' (MOCK)' : ''}`,
    );
  }
  return resumo;
}

// Uma campanha. Extraida para o ciclo acima ficar legivel e para o teste poder exercitar UMA
// campanha sem montar o resto.
async function processarCampanha(campanha, ctx) {
  const { db, mock, agora, aleatorio, dormir, enviar, onWhatsAppLote, espacamentoMs } = ctx;
  const resumo = { enviados: 0, falhas: 0, pulados: 0 };
  const cad = cadencia.resolverCadencia(campanha);

  // ── 1. JANELA DE HORARIO (relogio de Brasilia) ──
  const janela = cadencia.dentroDaJanela(agora, cad);
  if (!janela.ok) {
    console.log(`[massa-wa] campanha ${campanha.id}: fora da janela (${janela.motivo}); nada enviado.`);
    return resumo;
  }

  // ── 2. A PAUSA ENTRE LOTES AINDA ESTA CORRENDO? ──
  // Comparacao de string no formato do SQLite, que e como a coluna foi gravada.
  const agoraSql = paraTextoSqlUtc(agora);
  if (campanha.proximo_envio_em && agoraSql < campanha.proximo_envio_em) {
    return resumo;
  }

  // ── 3. O TRANSACIONAL TEM PRIORIDADE ABSOLUTA ──
  // WA1 e a primeira mensagem que um candidato recebe. Atrasa-la porque uma campanha esta no meio
  // de um lote inverte a importancia das duas coisas.
  if (db.existePendenciaSequenciaWhatsapp(agoraSql)) {
    console.log(`[massa-wa] campanha ${campanha.id}: ha WA1/WA2 pendente; cedendo a vez.`);
    return resumo;
  }

  // ── 4. TETO DIARIO (dia civil de Brasilia) ──
  const inicioDoDia = paraTextoSqlUtc(inicioDoDiaBrasiliaUtc(agora));
  const enviadosHoje = db.contarEnviosMassaWaDesde(campanha.id, inicioDoDia);
  const restanteDoDia = cad.tetoDiario - enviadosHoje;
  if (restanteDoDia <= 0) {
    console.log(
      `[massa-wa] campanha ${campanha.id}: teto diario atingido (${enviadosHoje}/${cad.tetoDiario}); ` +
        'retoma amanha dentro da janela.',
    );
    return resumo;
  }

  // ── 5. AS 7 VARIACOES PRECISAM ESTAR VALIDAS ──
  // Checado no ENVIO, e nao so no save: alguem pode ter editado as variacoes depois de ativar a
  // campanha. Invalidas -> pausa, porque mandar texto com token nao resolvido e pior que nao mandar.
  const lista = db.listarVariacoesMassaWa(campanha.id);
  const valid = variacoes.validarVariacoes(lista.map((v) => v.texto));
  if (!valid.ok) {
    db.definirStatusCampanhaMassaWa(campanha.id, 'pausada', { motivo: MOTIVO_VARIACOES_INVALIDAS });
    console.error(
      `[massa-wa] campanha ${campanha.id} PAUSADA: ${MOTIVO_VARIACOES_INVALIDAS} ` +
        `(${valid.problemas.map((p) => p.codigo).join(', ')}).`,
    );
    return resumo;
  }

  // ── 6. O LOTE ──
  const tamanho = cadencia.tamanhoDoLote(cad, restanteDoDia, aleatorio);
  if (tamanho <= 0) return resumo;

  const pendentes = db.listarPendentesCampanhaMassaWa(campanha.id, { limite: tamanho });
  if (!pendentes.length) {
    db.definirStatusCampanhaMassaWa(campanha.id, 'concluida');
    console.log(`[massa-wa] campanha ${campanha.id}: fila vazia; concluida.`);
    return resumo;
  }

  // ── 7. EXISTENCIA REAL, UMA CHAMADA PARA O LOTE ──
  // Ver a decisao 1 no cabecalho. Em mock nao consulta nada.
  let existencia = new Map();
  if (!mock) {
    try {
      existencia = await onWhatsAppLote(pendentes.map((p) => p.telefone));
    } catch (err) {
      // Best-effort: falha aqui NAO exclui ninguem (mapa vazio = "nao verificado" para todos).
      console.warn(`[massa-wa] onWhatsApp falhou (nao bloqueia envio): ${err.message}`);
    }
  }

  // Opt-out reconsultado AGORA, no momento do envio — e nao so na materializacao. Entre a
  // materializacao e este lote pode ter passado um dia, e alguem pode ter pedido para sair nesse
  // meio. As DUAS tabelas, como no motor de publico.
  const mapaOptout = optout.mapaOptoutAtivo({ db });
  const optoutAntigo = db.listarTelefonesOptOutWhatsapp();

  let tentativas = 0;
  let falhasNoLote = 0;
  const comecouEm = Date.now();

  for (const [i, linha] of pendentes.entries()) {
    // Teto de parede: um lote nunca prende o tick para sempre. Quem nao saiu continua 'pendente'.
    if (Date.now() - comecouEm > cadencia.TETO_PAREDE_LOTE_MS) {
      console.warn(`[massa-wa] campanha ${campanha.id}: teto de tempo do lote atingido; o resto volta no proximo ciclo.`);
      break;
    }

    // ── ESPACAMENTO MINIMO GLOBAL (conta os envios do transacional tambem) ──
    // eslint-disable-next-line no-await-in-loop
    await aguardarEspacamento({ db, dormir, espacamentoMs, agora });

    const telefone = normalizarTelefoneRecebido(linha.telefone);
    if (!telefone) {
      // O publico ja garantiu o round-trip; se chegou aqui, o dado mudou depois. Terminal: tentar
      // de novo nao conserta um numero.
      db.marcarEnvioMassaWaTerminal(linha.id, 'falha', 'telefone invalido no momento do envio');
      resumo.falhas += 1;
      continue;
    }

    // ── OPT-OUT ──
    const canonico = chaveCanonicaTelefone(telefone);
    const saiuPorOptout =
      optout.optoutAtivoNoMapa(mapaOptout, telefone, optout.CONSULTA_CAMPANHA)
      || optoutAntigo.has(telefone)
      || (canonico && optoutAntigo.has(canonico));
    if (saiuPorOptout) {
      db.marcarEnvioMassaWaTerminal(linha.id, 'opt_out', 'opt-out ativo no momento do envio');
      resumo.pulados += 1;
      console.log(`[massa-wa] ${mascarar(telefone)}: opt-out no envio; nao enviado.`);
      continue;
    }

    // ── NUMERO SEM WHATSAPP ──
    // So exclui quando o Baileys respondeu explicitamente `false`.
    if (existencia.get(linha.telefone) === false) {
      db.marcarEnvioMassaWaTerminal(linha.id, 'sem_whatsapp', 'numero nao possui WhatsApp ativo');
      resumo.pulados += 1;
      continue;
    }

    // ── A REUNIAO, RESOLVIDA AGORA E POR CANDIDATO ──
    // A vaga e a do CANDIDATO (a campanha pode ser de todas as vagas abertas), e a data vem da
    // proxima reuniao FUTURA. Congelar isso na materializacao faria uma campanha de tres dias
    // anunciar, no segundo dia, uma reuniao que passou.
    const job = jobDaLinha(linha);
    const proxima = proximaEntrevistaGrupo(job, agora);
    if (!proxima) {
      db.marcarEnvioMassaWaTerminal(
        linha.id,
        'sem_reuniao',
        'a vaga do candidato nao tem entrevista em grupo futura (ou nao tem link do Meet)',
      );
      resumo.pulados += 1;
      continue;
    }

    // ── SORTEIO DA VARIACAO + RESOLUCAO DOS TOKENS ──
    const escolhida = variacoes.sortearVariacao(lista, campanha.ultima_variacao, aleatorio);
    if (!escolhida) {
      // Inalcancavel depois da validacao acima; checado porque enviar '' seria pior que parar.
      db.definirStatusCampanhaMassaWa(campanha.id, 'pausada', { motivo: MOTIVO_VARIACOES_INVALIDAS });
      break;
    }
    const contexto = variacoes.montarContexto({ nome: linha.nome, job, proxima });
    const { texto, faltando } = variacoes.resolverTexto(escolhida.texto, contexto);
    if (faltando.length) {
      // Dado que falta na VAGA (tipicamente empresa nao cadastrada). Nao e retentavel: o proximo
      // ciclo encontraria o mesmo buraco. O erro diz exatamente o que preencher.
      db.marcarEnvioMassaWaTerminal(
        linha.id,
        'falha',
        `dado da vaga ausente para a mensagem: ${faltando.join(', ')}`,
      );
      resumo.falhas += 1;
      continue;
    }

    tentativas += 1;

    if (mock) {
      console.log(
        `[massa-wa] (mock) -> ${mascarar(telefone)} (envio ${linha.id}, variacao ${escolhida.indice}, ` +
          `${texto.length} chars). NAO enviado.`,
      );
      db.marcarEnvioMassaWaEnviado(linha.id, { variacaoIndice: escolhida.indice, quando: paraTextoSqlUtc(agora) });
      db.definirUltimaVariacaoMassaWa(campanha.id, escolhida.indice);
      db.zerarErrosConsecutivosMassaWa(campanha.id);
      resumo.enviados += 1;
    } else {
      try {
        // eslint-disable-next-line no-await-in-loop
        await enviar(telefone, texto, { instancia: ctx.instancia });
        // `quando` vem do relogio do CICLO, e nao de datetime('now'): e a mesma referencia que o
        // teto diario usa para contar "quantas sairam hoje". Sem isso as duas leituras usam
        // relogios diferentes e o teto para de limitar — foi o que um teste pegou.
        //
        // O desvio (o lote pode levar minutos) e inofensivo aqui: a janela fecha as 18h, entao o
        // carimbo nunca atravessa a meia-noite, que e a unica fronteira que o teto enxerga.
        db.marcarEnvioMassaWaEnviado(linha.id, {
          variacaoIndice: escolhida.indice,
          quando: paraTextoSqlUtc(agora),
        });
        db.definirUltimaVariacaoMassaWa(campanha.id, escolhida.indice);
        db.zerarErrosConsecutivosMassaWa(campanha.id);
        resumo.enviados += 1;
        console.log(`[massa-wa] enviado para ${mascarar(telefone)} (variacao ${escolhida.indice}).`);
      } catch (err) {
        falhasNoLote += 1;
        resumo.falhas += 1;
        db.marcarEnvioMassaWaTerminal(linha.id, 'falha', err.message);

        // ── DISJUNTOR: sinal de limitacao/sessao caida pausa NA HORA ──
        const motivo = ehSinalDeLimitacao(err.message)
          ? MOTIVO_LIMITACAO
          : /logout|logged out|401|sem socket|desconect/i.test(String(err.message))
            ? MOTIVO_SESSAO_CAIDA
            : null;
        if (motivo) {
          db.definirStatusCampanhaMassaWa(campanha.id, 'pausada', { motivo: `${motivo}: ${err.message}` });
          console.error(`[massa-wa] campanha ${campanha.id} PAUSADA — ${motivo}: ${err.message}`);
          return resumo;
        }

        const consecutivos = db.incrementarErrosConsecutivosMassaWa(campanha.id);
        if (consecutivos >= cadencia.ERROS_CONSECUTIVOS_LIMITE) {
          db.definirStatusCampanhaMassaWa(campanha.id, 'pausada', {
            motivo: `${MOTIVO_ERROS_CONSECUTIVOS} (${consecutivos}): ${err.message}`,
          });
          console.error(`[massa-wa] campanha ${campanha.id} PAUSADA — ${consecutivos} erros consecutivos.`);
          return resumo;
        }
        console.warn(`[massa-wa] falha no envio para ${mascarar(telefone)}: ${err.message}`);
      }
    }

    // ── GAP ALEATORIO ENTRE MENSAGENS (nao depois da ultima) ──
    if (i < pendentes.length - 1) {
      // eslint-disable-next-line no-await-in-loop
      await dormir(cadencia.gapMs(cad, aleatorio));
    }
  }

  // ── DISJUNTOR POR TAXA DE FALHA DO LOTE ──
  if (cadencia.taxaDeFalhaEstourou(tentativas, falhasNoLote)) {
    db.definirStatusCampanhaMassaWa(campanha.id, 'pausada', {
      motivo: `${MOTIVO_TAXA_FALHA} (${falhasNoLote}/${tentativas})`,
    });
    console.error(`[massa-wa] campanha ${campanha.id} PAUSADA — ${falhasNoLote}/${tentativas} falharam no lote.`);
    return resumo;
  }

  // ── PAUSA ATE O PROXIMO LOTE, gravada no BANCO ──
  const proximo = new Date(agora.getTime() + cadencia.pausaLoteMs(cad, aleatorio));
  db.definirProximoEnvioMassaWa(campanha.id, paraTextoSqlUtc(proximo));

  return resumo;
}

// Objeto `job` para a lib da entrevista em grupo, a partir da linha da fila.
//
// Os nomes das colunas vem do SELECT de listarPendentesCampanhaMassaWa. Campo esquecido aqui nao
// da erro: chega `undefined`, proximaEntrevistaGrupo devolve null e TODO destinatario vira
// 'sem_reuniao' — sem uma linha de log. Ha teste que falha se isso acontecer.
function jobDaLinha(linha) {
  return {
    titulo: linha.job_titulo,
    empresa: linha.job_empresa,
    slug: linha.job_slug,
    link_meet: linha.job_link_meet,
    entrevista_grupo_1_data: linha.job_entrevista_grupo_1_data,
    entrevista_grupo_1_hora: linha.job_entrevista_grupo_1_hora,
    entrevista_grupo_2_data: linha.job_entrevista_grupo_2_data,
    entrevista_grupo_2_hora: linha.job_entrevista_grupo_2_hora,
    entrevista_grupo_3_data: linha.job_entrevista_grupo_3_data,
    entrevista_grupo_3_hora: linha.job_entrevista_grupo_3_hora,
  };
}

// Espera o que falta para respeitar o espacamento minimo desde o ULTIMO envio de QUALQUER motor.
//
// Le o ultimo envio do transacional no banco (ver ultimoEnvioSequenciaWhatsapp em db/sqlite.js) e
// o ultimo da propria massa. Dorme so a diferenca.
async function aguardarEspacamento({ db, dormir, espacamentoMs, agora }) {
  if (!(espacamentoMs > 0)) return;
  const ultimoSeq = db.ultimoEnvioSequenciaWhatsapp();
  if (!ultimoSeq) return;
  // A coluna e UTC sem sufixo (datetime('now') do SQLite); o 'Z' diz ao JS o que ela ja e.
  const t = new Date(`${String(ultimoSeq).replace(' ', 'T')}Z`).getTime();
  if (Number.isNaN(t)) return;
  const decorrido = agora.getTime() - t;
  if (decorrido >= espacamentoMs) return;
  await dormir(espacamentoMs - decorrido);
}

// ── Trava em memoria contra ciclos sobrepostos ──
// Mesma razao das outras sete varreduras, e aqui ela pesa mais: dois ciclos sobrepostos dobrariam a
// vazao contra o WhatsApp, que e exatamente o que a cadencia existe para impedir.
let rodando = false;

async function varrerSeOcioso(deps = {}) {
  if (rodando) {
    console.warn('[massa-wa] ciclo anterior ainda em andamento; este foi ignorado.');
    return null;
  }
  rodando = true;
  try {
    return await processarCicloMassaWa(deps);
  } catch (err) {
    console.error(`[massa-wa] erro inesperado no ciclo: ${err.message}`);
    return null;
  } finally {
    rodando = false;
  }
}

module.exports = {
  processarCicloMassaWa,
  processarCampanha,
  varrerSeOcioso,
  ativo,
  modoMock,
  ehSinalDeLimitacao,
  jobDaLinha,
  aguardarEspacamento,
  CHAVE_ATIVO,
  INTERVALO_TICK_MS,
  CAMPANHAS_POR_CICLO,
  MOTIVO_ERROS_CONSECUTIVOS,
  MOTIVO_TAXA_FALHA,
  MOTIVO_SESSAO_CAIDA,
  MOTIVO_LIMITACAO,
  MOTIVO_VARIACOES_INVALIDAS,
  SINAIS_LIMITACAO,
};
