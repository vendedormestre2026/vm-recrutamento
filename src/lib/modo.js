'use strict';

// Decisao UNICA de modo do funil (Completo vs Simples). Toda tela/rota que precisa
// decidir o modo DEVE usar esta funcao — a regra de precedencia mora SO aqui.
//
// Precedencia (Func. 2):
//   entrevista_automatica_geral = OFF -> TODA vaga opera em modo SIMPLES.
//   entrevista_automatica_geral = ON  -> cada vaga decide por jobs.entrevista_ativa
//                                        (default 1 = Completo).
//
// FAIL-SAFE: qualquer erro ao ler config/coluna -> assume COMPLETO (preserva o
// comportamento historico; nunca "engole" o funil por causa de falha de infra).
//
// Modo COMPLETO = fluxo atual (Aplicacao -> Preparacao -> permissoes/testes ->
//                 Entrevista -> Relatorio).
// Modo SIMPLES  = Aplicacao -> pagina de confirmacao (botao WhatsApp), sem entrevista.

const db = require('../db');

// Retorna true quando a vaga opera em modo COMPLETO (entrevista automatica); false = Simples.
function modoEntrevistaAtivo(vaga) {
  try {
    if (!db.obterConfigBool('entrevista_automatica_geral', true)) return false; // geral OFF -> Simples
    if (!vaga) return true; // sem vaga: fail-safe Completo
    return vaga.entrevista_ativa !== 0; // por-vaga (default/ausente = Completo)
  } catch (e) {
    console.error('[modo] falha ao decidir modo; assumindo COMPLETO (fail-safe):', e.message);
    return true;
  }
}

module.exports = { modoEntrevistaAtivo };
