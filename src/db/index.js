'use strict';

// Camada de dados AGNOSTICA.
// O app (rotas, lib) importa daqui e so conhece funcoes de negocio
// (obterVagaAtiva, criarAplicacao, ...). A implementacao concreta (SQLite hoje,
// Postgres amanha) fica escondida atras deste modulo.
//
// Para trocar de banco: implemente o mesmo contrato em outro driver
// (ex.: ./postgres) e selecione-o aqui. As rotas nao mudam.

const driver = require('./sqlite');

module.exports = {
  // exposto para scripts de infra (migrate/seed) e healthcheck
  getDb: driver.getDb,
  aplicarSchema: driver.aplicarSchema,

  // vagas
  obterVaga: driver.obterVaga,
  obterVagaPorSlug: driver.obterVagaPorSlug,
  obterVagaAtiva: driver.obterVagaAtiva,
  listarVagas: driver.listarVagas,
  criarVaga: driver.criarVaga,
  atualizarVaga: driver.atualizarVaga,
  definirVagaAtiva: driver.definirVagaAtiva,

  // roteiros
  obterRoteiro: driver.obterRoteiro,
  obterRoteiroPorNome: driver.obterRoteiroPorNome,
  obterRoteiroPorPerfil: driver.obterRoteiroPorPerfil,
  atualizarEstruturaRoteiro: driver.atualizarEstruturaRoteiro,
  criarRoteiro: driver.criarRoteiro,

  // aplicacoes
  criarAplicacao: driver.criarAplicacao,
  obterAplicacao: driver.obterAplicacao,
  obterAplicacaoPorToken: driver.obterAplicacaoPorToken,
  atualizarStatusAplicacao: driver.atualizarStatusAplicacao,
  atualizarAplicacao: driver.atualizarAplicacao,
  arquivarAplicacao: driver.arquivarAplicacao,
  restaurarAplicacao: driver.restaurarAplicacao,
  registrarConsentGravacao: driver.registrarConsentGravacao,
  marcarRetomadaEnviada: driver.marcarRetomadaEnviada,

  // entrevistas
  criarInterview: driver.criarInterview,
  obterInterview: driver.obterInterview,
  obterInterviewEmAndamentoPorAplicacao: driver.obterInterviewEmAndamentoPorAplicacao,
  obterUltimaInterviewPorAplicacao: driver.obterUltimaInterviewPorAplicacao,
  definirUltimoRespId: driver.definirUltimoRespId,
  finalizarInterview: driver.finalizarInterview,
  definirVideoUrl: driver.definirVideoUrl,
  criarTurno: driver.criarTurno,
  listarTurnos: driver.listarTurnos,
  contarTurnos: driver.contarTurnos,

  // relatorios
  criarReport: driver.criarReport,
  atualizarStatusReport: driver.atualizarStatusReport,
  obterReportPorToken: driver.obterReportPorToken,
  obterReportEnviadoPorInterview: driver.obterReportEnviadoPorInterview,

  // painel do recrutador (Fase 5)
  listarAplicacoesComContexto: driver.listarAplicacoesComContexto,
  obterReportPorInterview: driver.obterReportPorInterview,
  registrarAcessoVaga: driver.registrarAcessoVaga,
  contarAplicacoes: driver.contarAplicacoes,
  contarEntrevistasConcluidas: driver.contarEntrevistasConcluidas,
  obterFunilConversao: driver.obterFunilConversao,

  // uso/custo de API (monitoramento de custos)
  registrarUsoApi: driver.registrarUsoApi,
  resumoUsoApi: driver.resumoUsoApi,
  usoApiPorOrigem: driver.usoApiPorOrigem,
  ultimasChamadasApi: driver.ultimasChamadasApi,

  // configuracoes (store chave/valor)
  obterConfig: driver.obterConfig,
  definirConfig: driver.definirConfig,
  obterConfigBool: driver.obterConfigBool,
  definirConfigBool: driver.definirConfigBool,
};
