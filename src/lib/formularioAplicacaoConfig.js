'use strict';

// Vocabulario das DUAS chaves que controlam quais campos o formulario PUBLICO de
// candidatura (GET /aplicar/:slug, routes/pages.js) oferece — toggle GLOBAL (uma unica
// config vale pra TODAS as vagas, decisao da ETAPA B do diagnostico de 2026-08-27; POR
// VAGA exigiria coluna nova em `jobs` e threading manual em criarVaga/atualizarVaga, fora
// de escopo deste incremento). Mesmo mecanismo ja usado no projeto — obterConfigBool /
// definirConfigBool sobre a tabela `configuracoes` (key/value generica, sem migration
// nova) — so que aqui SAO DOIS booleans, nao um.
//
// ── MODULO PROPRIO, E NAO STRING LITERAL REPETIDA EM 3 ARQUIVOS ──
// admin.js (tela /admin/config, escreve), pages.js (form publico, le pra decidir o que
// renderizar) e api.js (POST /api/aplicacao, le pra decidir se recusa sem currículo)
// precisam ler a MESMA chave exata — um typo numa das tres desligaria o toggle
// silenciosamente so naquele ponto. Mesmo raciocinio de campanhaWhatsapp.CHAVE_ATIVO e
// dos demais CHAVE_* que os subsistemas do painel importam em vez de declarar de novo.
//
// ── DEFAULT TRUE NAS DUAS ──
// Ausencia de configuracao (banco recem-criado, ou linha nunca gravada em `configuracoes`)
// tem que preservar o comportamento de SEMPRE — os dois campos aparecem, e currículo
// continua obrigatorio. A ausencia da chave NUNCA pode significar "campo desligado".
const dbPadrao = require('../db');

const CHAVE_EXIBIR_LINKEDIN = 'formulario_exibir_linkedin';
const CHAVE_EXIBIR_CURRICULO = 'formulario_exibir_curriculo';

function exibirLinkedin(deps = {}) {
  const db = deps.db || dbPadrao;
  return db.obterConfigBool(CHAVE_EXIBIR_LINKEDIN, true);
}

function exibirCurriculo(deps = {}) {
  const db = deps.db || dbPadrao;
  return db.obterConfigBool(CHAVE_EXIBIR_CURRICULO, true);
}

module.exports = {
  CHAVE_EXIBIR_LINKEDIN,
  CHAVE_EXIBIR_CURRICULO,
  exibirLinkedin,
  exibirCurriculo,
};
