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

// ── TEMPLATES_COM_BOTAO_DINAMICO (diagnostico da sessao de 2026-08-26/27) ──
//
// `templates_whatsapp.botao_parametro_fixo` so distingue DOIS estados (ver o comentario da
// coluna em db/schema.sql): NULL = "sem botao, nao manda componente nenhum", preenchido =
// "botao com valor FIXO, o mesmo em todo envio". Nao existe hoje um terceiro estado pra
// "tem botao de URL DINAMICA, o valor muda por destinatario" — e convite_grupo_vagas_vm e
// esse terceiro estado, confirmado contra o Central Whats de verdade (erro 400 real: "o
// botao de indice 0 tem URL dinamica e exige a variavel button0, que nao foi informada").
//
// Por que uma LISTA, e nao "botao_parametro_fixo === null" generalizado: nova_vaga_v1 e
// nova_vaga_v2 TAMBEM tem botao_parametro_fixo NULL hoje, e nao ha nenhuma evidencia de que
// tenham botao dinamico — pelo CONTRATO DOCUMENTADO da coluna, NULL neles significa "sem
// botao mesmo". Generalizar por NULL mandaria um button0 indevido pra eles no dia em que
// alguem os usar de verdade (divulgacao_vaga). Mesmo precedente de EXCECOES_PADRAO_VM acima:
// excecao por IDENTIDADE (nome do template), nao por inferencia de outro campo.
//
// Quando outro template com o mesmo caso for aprovado na Meta, esta lista cresce — uma linha
// de codigo, revisada, o mesmo raciocinio de EXCECOES_PADRAO_VM. Nao virou coluna nova (ex.:
// um enum 'tipo_botao') porque so ha UM caso confirmado ate agora; se um segundo aparecer
// vale reabrir essa decisao.
const TEMPLATES_COM_BOTAO_DINAMICO = ['convite_grupo_vagas_vm'];

function precisaBotaoDinamico(nomeMeta) {
  return TEMPLATES_COM_BOTAO_DINAMICO.includes(String(nomeMeta || '').trim());
}

module.exports = {
  pertenceVendedorMestre,
  EXCECOES_PADRAO_VM,
  precisaBotaoDinamico,
  TEMPLATES_COM_BOTAO_DINAMICO,
};
