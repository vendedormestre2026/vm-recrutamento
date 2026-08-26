'use strict';

// Wrapper da decisao HUMANA do recrutador (status_recrutador) — ETAPA B.
//
// ── POR QUE UM MODULO NOVO, E NAO CHAMAR db.definirStatusRecrutador DIRETO DA ROTA ──
// src/db/sqlite.js e camada-folha por convencao do projeto: so SQL, sem side-effect de
// negocio (mesmo raciocinio do cabecalho de sqlite.js sobre por que so importa modulos
// FOLHA). Gravar o status e so metade do trabalho agora — marcar 'reprovado' precisa
// tambem agendar a mensagem automatica de reprovacao (fila Baileys, ver
// whatsapp/sequenciaOutbox.js), e esse side-effect nao pode morar em sqlite.js nem ser
// duplicado nos DOIS pontos de rota que mudam o status (routes/admin.js: a individual e a
// em lote). Mesmo padrao de lib/emailRecusa.js e lib/campanhaWhatsapp.js: a orquestracao
// de negocio fica numa lib, a rota so chama.
//
//   aplicarDecisaoRecrutador(applicationId, novoValor) -> valor FINAL gravado (mesmo
//   contrato de db.definirStatusRecrutador: string do enum ou null)
// NUNCA lanca por causa do agendamento — ver o comentario de agendarMensagemReprovacao.

const db = require('../db');
const { normalizarTelefoneWhatsapp } = require('./whatsapp');

// ── KILL-SWITCH DEDICADO (Incremento B3) ──
//
// Mesmo padrao de TODAS as outras varreduras do projeto (limpezaAudio.js, emailRecusa.js,
// sequenciaOutbox.js, dispararPromocao.js, campanhaWhatsapp.js): uma chave em
// `configuracoes` (tabela key/value: chave TEXT PRIMARY KEY, valor TEXT — '1'/'0'), lida
// via db.obterConfigBool(chave, padrao) e escrita via db.definirConfigBool. Nao exige
// migracao nenhuma: uma chave ausente devolve o `padrao` sozinha, ja com o comportamento
// de "desligado" antes mesmo de a linha existir na tabela.
//
// PROPOSITALMENTE UMA CHAVE PROPRIA — NAO reutiliza WHATSAPP_BAILEYS_ATIVO (env) nem
// whatsapp_sequencia_ativa (config de banco do WA1/WA2). As duas ja estao LIGADAS em
// producao para a sequencia existente; usa-las aqui faria esta automacao NOVA, ainda sem
// copy aprovada nem validacao nenhuma, nascer ativa por acidente no mesmo instante do
// deploy. `automacao_reprovacao_whatsapp_ativa` comeca 'false' e so o Rafael liga, quando
// decidir — e o INTERRUPTOR CHECADO em agendarMensagemReprovacao, no momento do
// AGENDAMENTO (nao do envio; o envio em si continua atras de whatsapp_sequencia_ativa e
// WHATSAPP_BAILEYS_ATIVO tambem, exatamente como wa1/wa2 ja funcionam).
const CHAVE_ATIVO = 'automacao_reprovacao_whatsapp_ativa';

function ativo(deps = {}) {
  const dbRef = deps.db || db;
  return dbRef.obterConfigBool(CHAVE_ATIVO, false);
}

// ── 'aprovado': NENHUMA escrita adicional, de proposito ──
//
// A supressao de disparo automatico/em massa (WA1/WA2, campanha, esta propria automacao de
// reprovacao) e SEMPRE calculada em tempo real por db.telefoneSuprimidoPorAprovacao —
// olhando qual e a candidatura MAIS RECENTE daquele telefone e checando se o
// status_recrutador dela e 'aprovado'. Nao ha coluna nem tabela de "supressao" para
// atualizar aqui: gravar status_recrutador='aprovado' (que definirStatusRecrutador ja fez,
// na linha de cima) e o UNICO fato que precisa existir no banco. Escrever um flag adicional
// duplicaria a fonte de verdade e abriria espaco para os dois divergirem.
function aplicarDecisaoRecrutador(applicationId, novoValor) {
  const gravado = db.definirStatusRecrutador(applicationId, novoValor);

  if (gravado === 'reprovado') {
    // agendarMensagemReprovacao NUNCA lanca (mesmo principio de agendarSequencia em
    // sequenciaOutbox.js): a decisao do recrutador ja foi gravada acima, e uma falha ao
    // agendar a mensagem automatica nao pode reverter isso nem quebrar a resposta da rota.
    agendarMensagemReprovacao(applicationId);
  }
  // 'aprovado' / 'em_analise' / null: nenhum side-effect. Ver o comentario acima sobre
  // 'aprovado' especificamente.

  return gravado;
}

// 'YYYY-MM-DD HH:MM:SS' UTC — mesmo formato que datetime('now') do SQLite produz, pra
// agendado_para de reprovacao ser comparavel com o de wa1/wa2 na mesma query
// (listarPendentesSequenciaWhatsapp). Mesma logica de iso(new Date()) em
// whatsapp/sequenciaOutbox.js — reimplementada aqui (3 linhas) em vez de importada,
// porque aquele helper e privado do modulo (nao exportado) e abrir uma segunda saida
// publica so pra isto nao vale o acoplamento extra entre os dois arquivos.
function agendadoParaAgora() {
  return new Date().toISOString().replace('T', ' ').slice(0, 19);
}

// Agenda a etapa 'reprovacao' na MESMA fila de wa1/wa2 (whatsapp_sequencia_envios) — mesmo
// padrao de agendarSequencia em whatsapp/sequenciaOutbox.js: idempotente via
// UNIQUE(application_id, etapa) + DO NOTHING (db.agendarEnvioWhatsapp), e NUNCA lanca — a
// decisao do recrutador ja foi gravada quando isto roda (ver aplicarDecisaoRecrutador
// acima); falhar aqui nao pode reverter isso nem derrubar a resposta da rota.
//
// SEM checagem de cidade/link da praca aqui, DE PROPOSITO: essa parte e responsabilidade
// de whatsapp/sequenciaOutbox.textoDaEtapa, no MOMENTO DO ENVIO (nao do agendamento) — o
// link pode ser cadastrado ou editado entre a decisao do recrutador e o ciclo que
// efetivamente manda a mensagem (Incremento B4), e a mensagem tem que refletir o estado
// mais atual, nao uma foto de quando foi agendada.
function agendarMensagemReprovacao(applicationId, deps = {}) {
  const dbRef = deps.db || db;
  try {
    if (!ativo({ db: dbRef })) {
      return { agendado: false, motivo: `${CHAVE_ATIVO} desligado` };
    }

    const aplicacao = dbRef.obterAplicacao(applicationId);
    if (!aplicacao) {
      return { agendado: false, motivo: 'application nao encontrada' };
    }

    const telefone = normalizarTelefoneWhatsapp(aplicacao.telefone);
    if (!telefone) {
      console.warn(
        `[decisao-recrutador] application ${applicationId} sem telefone utilizavel; ` +
          'reprovacao NAO agendada.',
      );
      return { agendado: false, motivo: 'telefone invalido' };
    }

    const inserido = dbRef.agendarEnvioWhatsapp({
      applicationId,
      etapa: 'reprovacao',
      telefone,
      agendadoPara: agendadoParaAgora(),
      templateNome: 'reprovacao',
    });
    return { agendado: inserido, motivo: inserido ? null : 'ja existia (idempotente)' };
  } catch (err) {
    console.error(
      `[decisao-recrutador] falha ao agendar mensagem de reprovacao (candidatura segue ` +
        `normal): ${err.message}`,
    );
    return { agendado: false, motivo: `erro: ${err.message}` };
  }
}

module.exports = {
  aplicarDecisaoRecrutador,
  agendarMensagemReprovacao,
  ativo,
  CHAVE_ATIVO,
};
