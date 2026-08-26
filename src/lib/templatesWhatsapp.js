'use strict';

// Convencao de nome que distingue templates DA VENDEDOR MESTRE de outros usos da MESMA
// conta Central Whats — a instancia e compartilhada (ex.: convite_bni_workshop_ady, do
// workshop do BNI de Joinville, nao tem nada a ver com o Recrutador, mas passa pela mesma
// API de listagem).
//
// Modulo-FOLHA (nenhum require proprio) de proposito: e usado tanto por db/sqlite.js
// (sincronizarTemplateWhatsapp, o que ENTRA a partir de agora) quanto por db/migrate.js (a
// correcao pontual do que ja entrou errado antes desta regra existir) — mesmo raciocinio de
// lib/slug.js e lib/normalizarEmail.js, importaveis pela camada de dados sem abrir ciclo.
//
// ── SUFIXO "_vm" E A CONVENCAO, MAS SO 1 DOS 3 TEMPLATES ORIGINAIS A SEGUE DE VERDADE ──
// confirmacao_cadastro_vaga_vm bate a regra. nova_vaga_v1 e nova_vaga_v2 sao templates
// LEGITIMOS da Vendedor Mestre, ja aprovados e em uso — mas nasceram ANTES desta convencao
// de nome existir, com sufixo _v1/_v2 em vez de _vm. Tratar como "fora do padrao" os
// desativaria por engano, exatamente o oposto do que esta regra existe para proteger. Por
// isso entram como EXCECAO EXPLICITA — nao por regra de nome, por identidade — em vez de
// afrouxar o padrao (o que reabriria a porta pra qualquer coisa tipo "*_v[0-9]" colar aqui).
//
// O ideal, quando alguem tiver tempo, e renomear esses dois na Meta pra terminarem em _vm de
// verdade e eliminar esta lista — ate la, ela e o jeito deliberado de nao quebrar producao.
const EXCECOES_PADRAO_VM = ['nova_vaga_v1', 'nova_vaga_v2'];

function pertenceVendedorMestre(nomeMeta) {
  const nome = String(nomeMeta || '').trim();
  if (!nome) return false;
  return nome.endsWith('_vm') || EXCECOES_PADRAO_VM.includes(nome);
}

module.exports = { pertenceVendedorMestre, EXCECOES_PADRAO_VM };
