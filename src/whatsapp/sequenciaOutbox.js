'use strict';

// Agendamento e disparo da sequencia WA1/WA2.
//
// SEXTA varredura periodica do projeto. A anatomia e a mesma das outras cinco
// (followupEntrevista, emailRecusa, lembreteInicio, limpezaAudio, dispararPromocao) —
// interruptor checado antes de tocar o banco, trava em memoria contra ciclos sobrepostos,
// teto por ciclo, marcacao SO apos sucesso, falha isolada por destinatario.
//
// ── O QUE MUDA EM RELACAO A CAMPANHA DE E-MAIL ──
//   campanha       drena TUDO que esta pendente             esta: respeita RELOGIO
//                  (agendado_para nao existe la)                  (agendado_para <= agora)
//   campanha       classificarErroEnvio, 4 categorias        esta: retry simples, teto 3
//   campanha       125 por ciclo, a cada 15 min             esta: 50 por ciclo, a cada 5
//
// O retry simples e escolha deliberada, e nao preguica: a classificacao de 4 categorias
// nasceu de 2.945 destinatarios perdidos por erro de provedor mal lido, num volume de
// milhares por campanha. Aqui sao 2 mensagens por candidatura e um punhado de candidaturas
// por dia — a sofisticacao que se paga la nao se paga aqui, e uma maquina de estados que
// ninguem exercita e uma maquina de estados que ninguem conserta quando quebra.
//
// ── DOIS KILL-SWITCHES, EM CAMADAS DIFERENTES ──
//   WHATSAPP_BAILEYS_ATIVO      env. Controla se a INSTANCIA sequer conecta.
//   whatsapp_sequencia_ativa    config de BANCO (/admin/config), como promocao_ativa.
// Os dois sao checados no agendamento E no disparo. Um agendamento antigo nao pode sair
// depois que alguem desligou o interruptor — e por isso a checagem no envio nao confia na
// que aconteceu no agendamento.

const dbPadrao = require('../db');
const conexao = require('./connection');
const { normalizarTelefoneWhatsapp, normalizarTelefoneRecebido } = require('../lib/whatsapp');
const { montarTextoWA1, montarTextoWA2, montarTextoReprovacao } = require('../lib/whatsappSequencia');
const optout = require('../lib/optoutWhatsapp');

// Interruptor de DISPARO, no mesmo store `configuracoes` das outras cinco varreduras.
// Confirmado no diagnostico: e config de banco (obterConfigBool), nao variavel de ambiente —
// o mesmo padrao de promocao_ativa. Por isso NAO ha WHATSAPP_SEQUENCIA_ATIVA no .env.
const CHAVE_ATIVO = 'whatsapp_sequencia_ativa';

// WA2 sai 15 MINUTOS depois da candidatura. Fechado por regra de negocio: e a premissa que
// deixa o texto do WA2 falar em "amanhã, ao meio-dia" sem calcular nenhuma data — se o atraso
// fosse maior o "amanhã" poderia nao bater mais com a realidade.
const WA2_ATRASO_MINUTOS = 15;

// Teto por ciclo. Muito menor que os 125 da campanha porque o volume e outro; existe mesmo
// assim, porque uma fila represada (instancia fora do ar por um dia) despejaria tudo de uma
// vez no minuto em que voltasse — e rajada e o padrao que derruba numero de WhatsApp.
const POR_CICLO = 50;

// Teto de tentativas antes de desistir.
const MAX_TENTATIVAS_PADRAO = 3;

// Intervalo minimo entre dois envios REAIS.
const INTERVALO_PADRAO_MS = 3000;

function ativo(deps = {}) {
  const db = deps.db || dbPadrao;
  return db.obterConfigBool(CHAVE_ATIVO, false);
}

function modoMock() {
  // Default TRUE: so sai mensagem de verdade quando alguem disser explicitamente que sim.
  // A ausencia da variavel nao pode significar "pode enviar".
  return String(process.env.WHATSAPP_SEQUENCIA_MOCK || 'true').toLowerCase() !== 'false';
}

function intervaloMs() {
  const n = Number(process.env.WHATSAPP_INTERVALO_MS);
  return Number.isFinite(n) && n >= 0 ? n : INTERVALO_PADRAO_MS;
}

function maxTentativas() {
  const n = Number(process.env.WHATSAPP_MAX_TENTATIVAS);
  return Number.isInteger(n) && n > 0 ? n : MAX_TENTATIVAS_PADRAO;
}

// Telefone mascarado para log. NUNCA logamos numero completo: o stdout do Railway e lido por
// mais gente que o banco, e um telefone e dado pessoal como qualquer outro.
function mascarar(telefone) {
  const d = String(telefone || '');
  if (d.length < 6) return '***';
  return `${d.slice(0, 4)}${'*'.repeat(Math.max(0, d.length - 8))}${d.slice(-4)}`;
}

// ── DATA DO BANCO E UTC, E O JS NAO SABE DISSO ──
//
// `applications.criado_em` vem de datetime('now') do SQLite, que e UTC e SEM sufixo de fuso:
// "2026-08-14 10:00:00". `new Date(...)` sobre essa string a interpreta como hora LOCAL, e
// toISOString() converte de volta somando o offset da maquina.
//
// Efeito medido: numa maquina em UTC-3, o WA2 saia 3 HORAS deslocado — e o teste que
// pegou isso comparava 14:00 esperado contra 17:00 gravado. Em producao o container roda em
// UTC e o bug desapareceria, o que e o pior tipo de defeito: invisivel onde importa e
// presente em toda maquina de desenvolvimento.
//
// A correcao e dizer ao JS o que a string ja e: acrescentar 'Z' quando nao ha fuso.
function paraDataUtc(valor) {
  if (valor instanceof Date) return valor;
  const s = String(valor || '').trim();
  if (!s) return new Date();
  // Ja tem fuso (Z ou +hh:mm)? Confia. Senao, e UTC do SQLite.
  const temFuso = /[zZ]$|[+-]\d{2}:?\d{2}$/.test(s);
  return new Date(temFuso ? s : `${s.replace(' ', 'T')}Z`);
}

// Formato do banco: "YYYY-MM-DD HH:MM:SS" em UTC, o mesmo que datetime('now') produz — para
// a comparacao `agendado_para <= datetime('now')` no SQL ser entre iguais.
function iso(data) {
  return paraDataUtc(data).toISOString().replace('T', ' ').slice(0, 19);
}

// ──────────────────────────────────────────────────────────────
// A. AGENDAMENTO — chamado na criacao da application
// ──────────────────────────────────────────────────────────────

// Agenda WA1 (agora) e WA2 (criado_em + 15min).
//
// NUNCA LANCA. A candidatura ja foi gravada quando isto roda; uma falha aqui nao pode
// derrubar o POST /api/aplicacao. Mesmo principio do middleware de funil: perder um
// agendamento e barato, travar um candidato no meio do cadastro nao e.
//
// Devolve { agendados, motivo } — util para log e teste, ignorado pelo chamador.
function agendarSequencia(application, deps = {}) {
  const db = deps.db || dbPadrao;
  try {
    if (!application || !application.id) return { agendados: 0, motivo: 'application invalida' };

    // Interruptor no agendamento: desligado significa NAO CRIAR LINHA, e nao "criar e
    // ignorar depois". A diferenca importa — linha criada com o switch desligado sairia
    // sozinha no minuto em que alguem ligasse, para gente que se candidatou semanas antes.
    if (!ativo({ db })) return { agendados: 0, motivo: 'whatsapp_sequencia_ativa desligado' };

    // Telefone normalizado JA no agendamento: gravar o formato cru faria a fila carregar um
    // numero que o envio nao consegue usar, e o problema so apareceria minutos depois.
    const telefone = normalizarTelefoneWhatsapp(application.telefone);
    if (!telefone) {
      console.warn(
        `[wa-seq] application ${application.id} sem telefone utilizavel; sequencia NAO agendada.`,
      );
      return { agendados: 0, motivo: 'telefone invalido' };
    }

    const base = paraDataUtc(application.criado_em);
    const agora = new Date();
    const quandoWa2 = new Date(base.getTime() + WA2_ATRASO_MINUTOS * 60 * 1000);

    let agendados = 0;
    // Idempotente pelo UNIQUE(application_id, etapa) + DO NOTHING: chamar duas vezes nao
    // duplica e nao lanca.
    if (db.agendarEnvioWhatsapp({ applicationId: application.id, etapa: 'wa1', telefone, agendadoPara: iso(agora), templateNome: 'wa1' })) agendados += 1;
    if (db.agendarEnvioWhatsapp({ applicationId: application.id, etapa: 'wa2', telefone, agendadoPara: iso(quandoWa2), templateNome: 'wa2' })) agendados += 1;

    if (agendados) {
      console.log(
        `[wa-seq] application ${application.id}: ${agendados} etapa(s) agendada(s) ` +
          `(wa1 agora, wa2 em ${iso(quandoWa2)}) para ${mascarar(telefone)}.`,
      );
    }
    return { agendados, motivo: null };
  } catch (err) {
    // O catch e o ponto todo desta funcao. Ver a nota do cabecalho.
    console.error(`[wa-seq] falha ao agendar sequencia (candidatura segue normal): ${err.message}`);
    return { agendados: 0, motivo: `erro: ${err.message}` };
  }
}

// ──────────────────────────────────────────────────────────────
// B. CICLO — roda a cada 5 min
// ──────────────────────────────────────────────────────────────

// `db` e parametro (nao dbPadrao direto) so por causa da etapa 'reprovacao': ela precisa
// consultar obterLinkGrupo NO MOMENTO DO ENVIO (nao no agendamento), pra refletir um link
// cadastrado/editado entre a decisao do recrutador e o ciclo que efetivamente manda a
// mensagem. wa1/wa2 nao tocam `db` aqui (o texto delas so usa colunas ja trazidas pelo
// JOIN de listarPendentesSequenciaWhatsapp) — o parametro fica disponivel pras tres por
// uniformidade de assinatura, nao porque as outras duas precisem.
function textoDaEtapa(linha, db) {
  const app = { nome: linha.app_nome };
  const job = {
    titulo: linha.job_titulo, empresa: linha.job_empresa, perfil: linha.job_perfil,
    slug: linha.job_slug, faixa_pagamento: linha.job_faixa_pagamento,
    potencial_ganhos: linha.job_potencial_ganhos, endereco: linha.job_endereco,
    cidade: linha.job_cidade, modalidade: linha.job_modalidade, regime: linha.job_regime,
  };
  if (linha.etapa === 'wa1') return montarTextoWA1(app, job);
  if (linha.etapa === 'wa2') return montarTextoWA2(app, job);

  // 'reprovacao': vaga remota (job_cidade NULL) e cidade sem link cadastrado caem no MESMO
  // caso aqui — linkGrupo fica null/undefined pros dois, e montarTextoReprovacao ja trata
  // "sem link" como "manda so o corpo base" sem distinguir o motivo (ver o comentario dela).
  const linkGrupo = job.cidade ? db.obterLinkGrupo(job.cidade) : null;
  return montarTextoReprovacao(job, linkGrupo);
}

// Contrato de ida-e-volta: um telefone so e aceito se, normalizado e depois re-normalizado
// pelo caminho "ja recebido", produzir exatamente ele mesmo. Mesmo criterio de
// telefoneUtilizavel em lib/publicoDisparoWhatsapp.js — um numero com DDI duplicado passa no
// teto de digitos isolado, mas nao sobrevive a essa comparacao.
function telefoneComRoundTrip(bruto) {
  const normalizado = normalizarTelefoneWhatsapp(bruto);
  if (!normalizado) return null;
  return normalizarTelefoneRecebido(normalizado) === normalizado ? normalizado : null;
}

function dormirPadrao(ms) {
  if (!(ms > 0)) return Promise.resolve();
  return new Promise((r) => setTimeout(r, ms));
}

// ── Variante SEM o nono digito (investigacao DDD 47/31, 2026-08-20) ──
//
// normalizarTelefoneWhatsapp SEMPRE monta o celular com 9 digitos apos o DDD — nao ha
// excecao regional. Em DDDs onde a operadora local nao adota esse formato (confirmado em
// producao para 47 e 31, via onWhatsAppLote testando as duas variantes), a conta real no
// WhatsApp esta registrada SEM o 9: o Baileys aceita o envio (JID sintaticamente valido,
// sendMessage resolve sem erro) e a mensagem nunca chega.
//
// A regex exige a ESTRUTURA COMPLETA (13 digitos: DDI 55 + DDD 2 + '9' + local 8), nao so o
// prefixo — por isso e inofensiva para qualquer numero que nao seja um celular BR com nono
// digito, incluindo numero internacional que tenha acidentalmente ganho um '55' na frente
// (o tamanho final nao bate com 13 digitos nesse caso). '55' e exclusivo do Brasil como
// codigo de pais, entao a combinacao "comeca com 55, 13 digitos, 9 logo apos o DDD" so
// acontece em celular brasileiro de verdade.
const RE_CELULAR_BR_COM_NOVE = /^55(\d{2})9(\d{8})$/;

function varianteSemNono(telefone) {
  const m = RE_CELULAR_BR_COM_NOVE.exec(String(telefone || ''));
  return m ? `55${m[1]}${m[2]}` : null;
}

// Uma passada completa. Sequencial de proposito — paralelizar envio de WhatsApp e como se
// perde um numero.
//
// Devolve { enviados, falhas, retentar, pulados } + `desativado` quando for o caso.
async function processarCicloSequencia(deps = {}) {
  const db = deps.db || dbPadrao;
  const resumo = { enviados: 0, falhas: 0, retentar: 0, pulados: 0 };

  // ── KILL-SWITCH, OS DOIS, ANTES DE TOCAR O BANCO ──
  // A checagem se repete aqui mesmo tendo acontecido no agendamento: uma linha agendada
  // ontem nao pode sair hoje se alguem desligou o interruptor no meio.
  const switchBanco = ativo({ db });
  const switchEnv = conexao.ligado();
  if (!switchBanco || !switchEnv) {
    const quais = [!switchBanco ? 'whatsapp_sequencia_ativa' : null, !switchEnv ? 'WHATSAPP_BAILEYS_ATIVO' : null]
      .filter(Boolean)
      .join(' e ');
    console.log(`[wa-seq] desativado (${quais}); ciclo pulado.`);
    return { ...resumo, desativado: true };
  }

  let pendentes = [];
  try {
    pendentes = db.listarPendentesSequenciaWhatsapp({ limite: deps.porCiclo || POR_CICLO, agora: deps.agora || null });
  } catch (err) {
    console.error(`[wa-seq] falha ao consultar a fila: ${err.message}`);
    return resumo;
  }
  if (!pendentes.length) return resumo;

  const mock = deps.mock === undefined ? modoMock() : deps.mock;
  const enviar = deps.enviarTexto || conexao.enviarTexto;
  const verificarExiste = deps.verificarExiste || conexao.verificarExisteWhatsapp;
  // So usado para celular BR de 9 digitos (varianteSemNono) — mesmo padrao de injecao de
  // lib/publicoDisparoWhatsapp.js. UMA chamada com as duas variantes, nao duas chamadas
  // separadas (onWhatsAppLote monta uma USyncQuery so; ver connection.js).
  const onWhatsAppLote = deps.onWhatsAppLote || conexao.onWhatsAppLote;
  const dormir = deps.dormir || dormirPadrao;
  const intervalo = deps.intervaloMs === undefined ? intervaloMs() : deps.intervaloMs;
  const teto = deps.maxTentativas || maxTentativas();

  for (const [i, linha] of pendentes.entries()) {
    // ── normalizarTelefoneRecebido, e NAO normalizarTelefoneWhatsapp ──
    // `telefone_e164` sai da fila JA normalizado (so digitos, com DDI, sem '+'). A funcao do
    // formulario nao reconhece DDI sem '+' e prefixaria 55 de novo:
    //     5547999582500 -> 555547999582500
    // que e o numero de outra pessoa, e passa no teto de sanidade sem recusa. E o MESMO bug
    // de round-trip que ja custou um disparo travado no subsistema de campanha por WhatsApp.
    //
    // ── O FALLBACK (app_telefone) PASSA PELO MESMO CONTRATO DE IDA-E-VOLTA ──
    // Achado real (candidatura da Maria Joao): telefone_e164 chegava aqui como
    // "555511985761491" (DDI duplicado, 15 digitos) e normalizarTelefoneRecebido REJEITAVA
    // corretamente (null). Mas o fallback antigo chamava normalizarTelefoneWhatsapp direto
    // sobre app_telefone CRU ("+55 +5511985761491"), que devolvia o MESMO numero corrompido
    // — e esse valor, isolado, cabia no teto [10,15] e passava sem recusa. O fallback
    // ressuscitava exatamente o defeito que a checagem primaria existe para pegar.
    // Agora o fallback tambem precisa SOBREVIVER a ida e volta (normalizarTelefoneWhatsapp
    // seguido de normalizarTelefoneRecebido, comparando o resultado com ele mesmo) — mesmo
    // padrao de telefoneUtilizavel em lib/publicoDisparoWhatsapp.js.
    //
    // Telefone invalido NAO vira retry: tentar de novo nao conserta o numero, e a linha
    // ficaria 'pendente' para sempre, reaparecendo em todo ciclo.
    const telefone =
      normalizarTelefoneRecebido(linha.telefone_e164) || telefoneComRoundTrip(linha.app_telefone);
    if (!telefone) {
      db.marcarSequenciaWhatsappFalha(
        linha.id,
        'telefone invalido (nao sobrevive a ida e volta da normalizacao — possivel DDI duplicado ou dado corrompido)',
      );
      resumo.falhas += 1;
      console.warn(`[wa-seq] ${linha.etapa} da application ${linha.application_id}: telefone invalido; marcado como falha.`);
      continue;
    }

    // ── OPT-OUT (Incremento 2) ──
    //
    // As tres etapas desta fila (wa1, wa2, reprovacao) sao TRANSACIONAIS: cada uma e
    // consequencia direta de um ato recente da propria pessoa — ela se candidatou, ou o
    // recrutador decidiu sobre a candidatura DELA. Por isso o escopo consultado e
    // `transacional`, e SO um opt-out `total` suprime aqui.
    //
    // ── O CENARIO QUE ESTA LINHA PRECISA ACERTAR (P2) ──
    // Pessoa pede descadastro em marco; em abril se candidata a uma vaga nova com o mesmo
    // numero. Ela DEVE receber WA1 e WA2 — foi ela quem se inscreveu, agora — e DEVE
    // continuar fora das campanhas. As duas coisas ao mesmo tempo so acontecem porque o
    // escopo aqui e diferente do escopo dos motores de campanha. E tambem por isso nada
    // neste arquivo revoga opt-out: a candidatura nova nao apaga o pedido de marco.
    //
    // Escopo consultado por ETAPA, e nao fixo: se uma etapa de natureza diferente entrar
    // nesta fila um dia, ela e classificada em ESCOPO_POR_TIPO_MENSAGEM (lib/optoutWhatsapp)
    // e nao aqui — e o default de la, para etapa desconhecida, e o escopo mais restritivo.
    //
    // ── ⚠️ ESTE MOTOR NAO LE whatsapp_opt_out (a tabela ANTIGA), E ISSO E DELIBERADO ──
    // Os tres motores de CAMPANHA leem as duas tabelas, porque uma supressao a mais ali
    // nunca e risco. Aqui seria: a tabela antiga NAO TEM ESCOPO, entao qualquer linha dela
    // valeria como bloqueio TOTAL e passaria a suprimir WA1/WA2 — travando o processo
    // seletivo de quem so tinha pedido para parar de receber ofertas. E exatamente o erro
    // que a coluna `escopo` da tabela nova existe para impedir (P1).
    // Quem estiver na tabela antiga e quiser bloqueio total precisa de um registro
    // `total` na tabela nova, feito por acao explicita.
    // Nao "corrija" esta ausencia por simetria com os outros motores sem reler isto.
    const escopoEtapa = optout.escopoDoTipoMensagem(linha.etapa);
    if (optout.estaOptout(telefone, escopoEtapa, { db })) {
      // Status TERMINAL, nunca retentavel: em 'pendente' esta linha voltaria em todo ciclo,
      // para sempre, ocupando uma vaga do teto por ciclo. Ver marcarSequenciaWhatsappOptout
      // em db/sqlite.js.
      db.marcarSequenciaWhatsappOptout(linha.id);
      resumo.pulados += 1;
      console.log(
        `[wa-seq] ${linha.etapa} da application ${linha.application_id}: ${mascarar(telefone)} ` +
          'com opt-out de escopo total; nao enviado.',
      );
      continue;
    }

    const texto = textoDaEtapa(linha, db);

    if (mock) {
      // MOCK: registra o que SAIRIA e marca como enviado, sem tocar o socket. E o default —
      // a ausencia da variavel nao pode significar "pode enviar de verdade".
      console.log(
        `[wa-seq] (mock) ${linha.etapa} -> ${mascarar(telefone)} ` +
          `(application ${linha.application_id}, ${texto.length} chars). NAO enviado.`,
      );
      db.marcarSequenciaWhatsappEnviada(linha.id, deps.agora || null);
      resumo.enviados += 1;
    } else {
      // Checagem BEST-EFFORT de existencia real (Incremento 4): so BLOQUEIA quando o
      // Baileys responde explicitamente "nao existe" — silencio/erro/sem socket mantem o
      // comportamento de sempre (tenta enviar), porque instabilidade de conexao nao pode
      // virar motivo pra marcar candidato legitimo como falha. Ver connection.js.
      //
      // ── VARIANTE SEM O NONO DIGITO (investigacao DDD 47/31) ──
      // So entra aqui um celular BR de 9 digitos. As DUAS variantes (com e sem o 9) vao
      // numa UNICA chamada a onWhatsAppLote. So troca para a variante sem o 9 quando ela
      // vier confirmada (true) E a original NAO vier confirmada (null ou false) — qualquer
      // outro caso (as duas true, as duas null/false) mantem a variante original, sem
      // regressao no criterio existente de "nao verificado = tenta mesmo assim".
      let telefoneEnvio = telefone;
      let existe;
      const semNono = varianteSemNono(telefone);
      if (semNono) {
        const mapa = await onWhatsAppLote([telefone, semNono]);
        const existeComNove = mapa.get(telefone);
        const existeSemNove = mapa.get(semNono);
        if (existeSemNove === true && existeComNove !== true) {
          telefoneEnvio = semNono;
          existe = true;
          console.warn(
            `[wa-seq] ${linha.etapa} da application ${linha.application_id}: numero sem o nono digito ` +
              `confirmado no WhatsApp (a variante com 9 nao foi confirmada); usando ${mascarar(semNono)}.`,
          );
        } else {
          existe = existeComNove;
        }
      } else {
        ({ existe } = await verificarExiste(telefone));
      }

      if (existe === false) {
        db.marcarSequenciaWhatsappFalha(linha.id, 'numero nao possui WhatsApp ativo');
        resumo.falhas += 1;
        console.warn(`[wa-seq] ${linha.etapa} da application ${linha.application_id}: numero sem WhatsApp (onWhatsApp); marcado como falha.`);
      } else {
        try {
          await enviar(telefoneEnvio, texto);
          db.marcarSequenciaWhatsappEnviada(linha.id, deps.agora || null);
          resumo.enviados += 1;
          console.log(`[wa-seq] ${linha.etapa} enviado para ${mascarar(telefoneEnvio)} (application ${linha.application_id}).`);
        } catch (err) {
          const tentativaAtual = (Number(linha.tentativas) || 0) + 1;
          if (tentativaAtual >= teto) {
            db.marcarSequenciaWhatsappFalha(linha.id, err.message);
            resumo.falhas += 1;
            console.error(`[wa-seq] ${linha.etapa} da application ${linha.application_id}: falha definitiva apos ${tentativaAtual} tentativa(s): ${err.message}`);
          } else {
            db.registrarTentativaSequenciaWhatsapp(linha.id, err.message);
            resumo.retentar += 1;
            console.warn(`[wa-seq] ${linha.etapa} da application ${linha.application_id}: tentativa ${tentativaAtual}/${teto} falhou (${err.message}); volta no proximo ciclo.`);
          }
        }
      }
    }

    // Throttle ENTRE envios, nao depois do ultimo. Aplicado tambem em mock para o ciclo
    // simulado ter a mesma forma do real — mas os testes injetam intervalo 0.
    if (i < pendentes.length - 1) await dormir(intervalo);
  }

  // `pulados` entra na condicao E no texto: um ciclo em que TUDO foi suprimido por opt-out
  // ficaria completamente silencioso sem isso, e "nao saiu nada e o log nao diz por que" e o
  // sintoma mais caro de diagnosticar que este projeto ja teve.
  if (resumo.enviados || resumo.falhas || resumo.retentar || resumo.pulados) {
    console.log(
      `[wa-seq] ciclo concluido — enviados: ${resumo.enviados}, falhas: ${resumo.falhas}, ` +
        `a retentar: ${resumo.retentar}, suprimidos por opt-out: ${resumo.pulados}${mock ? ' (MOCK)' : ''}`,
    );
  }
  return resumo;
}

// ── Trava em memoria contra ciclos sobrepostos ──
// Mesma razao das outras cinco varreduras. Aqui pesa: dois ciclos sobrepostos dobrariam a
// vazao contra o WhatsApp, que e exatamente o que o throttle existe para impedir.
let rodando = false;

async function varrerSeOcioso(deps = {}) {
  if (rodando) {
    console.warn('[wa-seq] ciclo anterior ainda em andamento; este foi ignorado.');
    return null;
  }
  rodando = true;
  try {
    return await processarCicloSequencia(deps);
  } catch (err) {
    console.error(`[wa-seq] erro inesperado no ciclo: ${err.message}`);
    return null;
  } finally {
    rodando = false;
  }
}

module.exports = {
  agendarSequencia,
  processarCicloSequencia,
  varrerSeOcioso,
  textoDaEtapa,
  ativo,
  modoMock,
  mascarar,
  CHAVE_ATIVO,
  WA2_ATRASO_MINUTOS,
  POR_CICLO,
  MAX_TENTATIVAS_PADRAO,
  INTERVALO_PADRAO_MS,
};
