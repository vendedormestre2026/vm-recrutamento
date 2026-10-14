'use strict';

// Hash do texto-base de uma campanha de massa — o "carimbo" das variacoes.
//
// Toda vez que as 7 variacoes sao gravadas (sementes, geracao por IA ou edicao manual), a
// campanha guarda o hash do texto-base daquele momento (campanhas_massa_wa.variacoes_base_hash).
// Se o texto-base mudar depois, o hash deixa de bater e as variacoes ficam DESATUALIZADAS: a tela
// avisa, materializar/ativar recusam e o worker pausa. Ver lib/variacoesMassaWa.
//
// Modulo proprio (e nao dentro de variacoesMassaWa) porque a camada de banco tambem precisa dele
// para carimbar no mesmo UPDATE que grava as variacoes, e variacoesMassaWa puxa dependencias que
// o db nao deve carregar.
//
// Normaliza antes do hash: o <textarea> do navegador devolve \r\n, e reabrir e salvar a tela sem
// mudar uma letra nao pode marcar as variacoes como desatualizadas.

const crypto = require('node:crypto');

function normalizarTextoBase(texto) {
  return String(texto == null ? '' : texto).replace(/\r\n?/g, '\n').trim();
}

function hashTextoBase(texto) {
  return crypto.createHash('sha256').update(normalizarTextoBase(texto)).digest('hex');
}

module.exports = { normalizarTextoBase, hashTextoBase };
