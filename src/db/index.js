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
  atualizarSlugVaga: driver.atualizarSlugVaga,
  definirCidadeVaga: driver.definirCidadeVaga,
  definirVagaAtiva: driver.definirVagaAtiva,

  // roteiros
  obterRoteiro: driver.obterRoteiro,
  obterRoteiroPorNome: driver.obterRoteiroPorNome,
  obterRoteiroPorPerfil: driver.obterRoteiroPorPerfil,
  atualizarEstruturaRoteiro: driver.atualizarEstruturaRoteiro,
  criarRoteiro: driver.criarRoteiro,

  // perfis de curriculo (Banco de Curriculos)
  criarPerfilCurriculo: driver.criarPerfilCurriculo,
  listarPerfisCurriculo: driver.listarPerfisCurriculo,
  buscarPerfilCurriculo: driver.buscarPerfilCurriculo,
  buscarPerfilCurriculoAtivoPara: driver.buscarPerfilCurriculoAtivoPara,
  atualizarPerfilCurriculo: driver.atualizarPerfilCurriculo,

  // talentos (Banco de Curriculos)
  criarTalento: driver.criarTalento,
  criarTalentosLegado: driver.criarTalentosLegado,
  listarTalentos: driver.listarTalentos,
  contarTalentos: driver.contarTalentos,
  buscarTalento: driver.buscarTalento,
  atualizarStatusTalento: driver.atualizarStatusTalento,
  STATUS_TALENTO_VALIDOS: driver.STATUS_TALENTO_VALIDOS,
  CATEGORIAS_TALENTO_VALIDAS: driver.CATEGORIAS_TALENTO_VALIDAS,
  CARGOS_TALENTO_VALIDOS: driver.CARGOS_TALENTO_VALIDOS,
  TALENTOS_POR_PAGINA: driver.TALENTOS_POR_PAGINA,
  CATEGORIA_FILTRO_PROPRIO: driver.CATEGORIA_FILTRO_PROPRIO,

  // aplicacoes
  criarAplicacao: driver.criarAplicacao,
  obterAplicacao: driver.obterAplicacao,
  obterAplicacaoPorToken: driver.obterAplicacaoPorToken,
  atualizarStatusAplicacao: driver.atualizarStatusAplicacao,
  definirStatusIa: driver.definirStatusIa,
  definirStatusIaSeVazio: driver.definirStatusIaSeVazio,
  obterStatusIaPorApplication: driver.obterStatusIaPorApplication,
  definirStatusRecrutador: driver.definirStatusRecrutador,
  statusRecrutadorMaisRecente: driver.statusRecrutadorMaisRecente,
  mapaStatusRecrutadorPorTelefone: driver.mapaStatusRecrutadorPorTelefone,
  telefoneSuprimidoPorAprovacao: driver.telefoneSuprimidoPorAprovacao,
  STATUS_RECRUTADOR_VALIDOS: driver.STATUS_RECRUTADOR_VALIDOS,
  atualizarAplicacao: driver.atualizarAplicacao,
  arquivarAplicacao: driver.arquivarAplicacao,
  restaurarAplicacao: driver.restaurarAplicacao,
  registrarConsentGravacao: driver.registrarConsentGravacao,
  marcarContatoWhatsapp: driver.marcarContatoWhatsapp,
  marcarRetomadaEnviada: driver.marcarRetomadaEnviada,
  // follow-up automatico de entrevista nao concluida (lib/followupEntrevista)
  listarPendentesFollowupEntrevista: driver.listarPendentesFollowupEntrevista,
  marcarFollowupEntrevistaEnviado: driver.marcarFollowupEntrevistaEnviado,
  listarPendentesEmailRecusa: driver.listarPendentesEmailRecusa,
  marcarEmailRecusaEnviado: driver.marcarEmailRecusaEnviado,
  // lembrete de inicio de entrevista (lib/lembreteInicio)
  listarPendentesLembreteInicio: driver.listarPendentesLembreteInicio,
  marcarLembreteInicioEnviado: driver.marcarLembreteInicioEnviado,

  // entrevistas
  criarInterview: driver.criarInterview,
  obterInterview: driver.obterInterview,
  obterInterviewEmAndamentoPorAplicacao: driver.obterInterviewEmAndamentoPorAplicacao,
  obterUltimaInterviewPorAplicacao: driver.obterUltimaInterviewPorAplicacao,
  definirUltimoRespId: driver.definirUltimoRespId,
  atualizarProgressoInterview: driver.atualizarProgressoInterview,
  // duracao ativa: ultima atividade + acumulador de pausa (retomadas tardias)
  ultimaAtividadeInterview: driver.ultimaAtividadeInterview,
  acumularTempoPausado: driver.acumularTempoPausado,
  finalizarInterview: driver.finalizarInterview,
  definirVideoUrl: driver.definirVideoUrl,
  listarElegiveisLimpezaAudio: driver.listarElegiveisLimpezaAudio,
  listarEntrevistasConcluidasSemVideo: driver.listarEntrevistasConcluidasSemVideo,
  marcarAudioRemovido: driver.marcarAudioRemovido,
  criarTurno: driver.criarTurno,
  listarTurnos: driver.listarTurnos,
  contarTurnos: driver.contarTurnos,

  // relatorios
  criarReport: driver.criarReport,
  atualizarStatusReport: driver.atualizarStatusReport,
  obterReportPorToken: driver.obterReportPorToken,
  obterReportEnviadoPorInterview: driver.obterReportEnviadoPorInterview,

  // painel do recrutador (Fase 5)
  CANDIDATOS_POR_PAGINA: driver.CANDIDATOS_POR_PAGINA,
  listarAplicacoesComContexto: driver.listarAplicacoesComContexto,
  contarAplicacoesComContexto: driver.contarAplicacoesComContexto,
  contarEntrevistasConcluidasComContexto: driver.contarEntrevistasConcluidasComContexto,
  listarOrigensDistintas: driver.listarOrigensDistintas,
  listarCidadesDistintas: driver.listarCidadesDistintas,
  listarAplicacoesComCurriculoAntes: driver.listarAplicacoesComCurriculoAntes,
  marcarCurriculoRemovido: driver.marcarCurriculoRemovido,
  obterReportPorInterview: driver.obterReportPorInterview,
  registrarAcessoVaga: driver.registrarAcessoVaga,
  registrarEventoFunil: driver.registrarEventoFunil,
  contarAplicacoes: driver.contarAplicacoes,
  contarEntrevistasConcluidas: driver.contarEntrevistasConcluidas,
  obterFunilConversao: driver.obterFunilConversao,
  obterOrigemLeads: driver.obterOrigemLeads,
  ORIGENS_POR_PAGINA: driver.ORIGENS_POR_PAGINA,

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

  // Promocao de Vagas — descadastro (opt-out global por e-mail)
  registrarDescadastro: driver.registrarDescadastro,
  estaDescadastrado: driver.estaDescadastrado,

  // Promocao de Vagas — campanhas (CRUD do rascunho)
  criarCampanha: driver.criarCampanha,
  listarCampanhas: driver.listarCampanhas,
  obterCampanha: driver.obterCampanha,
  excluirCampanha: driver.excluirCampanha,

  // Promocao de Vagas — disparo (lib/dispararPromocao)
  materializarEnviosCampanha: driver.materializarEnviosCampanha,
  contarEnviosCampanha: driver.contarEnviosCampanha,
  contarCliquesCampanha: driver.contarCliquesCampanha,
  listarEnviosPendentesCampanha: driver.listarEnviosPendentesCampanha,
  marcarEnvioCampanhaEnviado: driver.marcarEnvioCampanhaEnviado,
  marcarEnvioCampanhaFalha: driver.marcarEnvioCampanhaFalha,
  registrarTentativaEnvioCampanha: driver.registrarTentativaEnvioCampanha,
  listarCampanhasEmAndamento: driver.listarCampanhasEmAndamento,
  marcarCampanhaEnviando: driver.marcarCampanhaEnviando,
  concluirCampanha: driver.concluirCampanha,

  // Promocao de Vagas — motor de publico (lib/promocaoVagas)
  listarCandidatosParaCampanha: driver.listarCandidatosParaCampanha,
  listarTalentosParaCampanha: driver.listarTalentosParaCampanha,
  listarEmailsInscritosNaVaga: driver.listarEmailsInscritosNaVaga,
  listarEmailsDescadastrados: driver.listarEmailsDescadastrados,
  origemCanonica: driver.origemCanonica,

  // Disparo por WhatsApp — motor de publico (lib/publicoDisparoWhatsapp) e livro-razao
  listarCandidatosPorCidadeVaga: driver.listarCandidatosPorCidadeVaga,
  listarLegadoPorCidade: driver.listarLegadoPorCidade,
  listarTelefonesDisparados: driver.listarTelefonesDisparados,
  registrarDisparoWhatsapp: driver.registrarDisparoWhatsapp,

  // Sequencia WA1/WA2 (whatsapp/sequenciaOutbox)
  agendarEnvioWhatsapp: driver.agendarEnvioWhatsapp,
  listarPendentesSequenciaWhatsapp: driver.listarPendentesSequenciaWhatsapp,
  marcarSequenciaWhatsappEnviada: driver.marcarSequenciaWhatsappEnviada,
  registrarTentativaSequenciaWhatsapp: driver.registrarTentativaSequenciaWhatsapp,
  marcarSequenciaWhatsappFalha: driver.marcarSequenciaWhatsappFalha,
  contarSequenciaWhatsapp: driver.contarSequenciaWhatsapp,
  listarSequenciaWhatsappDaApplication: driver.listarSequenciaWhatsappDaApplication,
  confirmarVideoWa2: driver.confirmarVideoWa2,

  // Campanha por WhatsApp (Meta Cloud API)
  listarCandidatosParaCampanhaWhatsapp: driver.listarCandidatosParaCampanhaWhatsapp,
  listarTalentosParaCampanhaWhatsapp: driver.listarTalentosParaCampanhaWhatsapp,
  listarCandidatosPorVagaEStatusRecrutador: driver.listarCandidatosPorVagaEStatusRecrutador,
  listarTelefonesOptOutWhatsapp: driver.listarTelefonesOptOutWhatsapp,
  materializarCampanhaWhatsapp: driver.materializarCampanhaWhatsapp,
  definirTotalEstimadoCampanhaWhatsapp: driver.definirTotalEstimadoCampanhaWhatsapp,
  listarTemplatesWhatsapp: driver.listarTemplatesWhatsapp,
  obterTemplateWhatsapp: driver.obterTemplateWhatsapp,
  sincronizarTemplateWhatsapp: driver.sincronizarTemplateWhatsapp,
  listarCidades: driver.listarCidades,
  obterCidadePorChave: driver.obterCidadePorChave,
  criarCidade: driver.criarCidade,
  criarRegiaoGrupo: driver.criarRegiaoGrupo,
  listarRegioesGrupos: driver.listarRegioesGrupos,
  obterLinkGrupo: driver.obterLinkGrupo,
  obterLinkGrupoPorSlug: driver.obterLinkGrupoPorSlug,
  definirLinkGrupo: driver.definirLinkGrupo,
  criarCampanhaWhatsapp: driver.criarCampanhaWhatsapp,
  listarCampanhasWhatsapp: driver.listarCampanhasWhatsapp,
  obterCampanhaWhatsapp: driver.obterCampanhaWhatsapp,
  definirStatusCampanhaWhatsapp: driver.definirStatusCampanhaWhatsapp,
  contarEnviosCampanhaWhatsapp: driver.contarEnviosCampanhaWhatsapp,
  materializarEnvioCampanhaWhatsapp: driver.materializarEnvioCampanhaWhatsapp,
  listarPendentesCampanhaWhatsapp: driver.listarPendentesCampanhaWhatsapp,
  marcarEnvioWhatsappEnviado: driver.marcarEnvioWhatsappEnviado,
  marcarEnvioWhatsappFalha: driver.marcarEnvioWhatsappFalha,
  registrarTentativaEnvioWhatsapp: driver.registrarTentativaEnvioWhatsapp,
  marcarEnvioWhatsappOptOut: driver.marcarEnvioWhatsappOptOut,
  atualizarStatusPorWamid: driver.atualizarStatusPorWamid,
  registrarOptOutWhatsapp: driver.registrarOptOutWhatsapp,
  estaOptOutWhatsapp: driver.estaOptOutWhatsapp,

};
