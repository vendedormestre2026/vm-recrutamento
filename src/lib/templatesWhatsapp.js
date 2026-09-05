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

// ══════════════════════════════════════════════════════════════
// BOTOES DO TEMPLATE APROVADO
// ══════════════════════════════════════════════════════════════
//
// ── O FORMATO REAL, CONFIRMADO CONTRA O CENTRAL WHATS ──
// O componente e `type: 'BUTTONS'` (PLURAL), com um array `buttons` aninhado:
//
//   { type: 'BUTTONS', buttons: [ { type: 'URL', text: 'Entrar no Grupo',
//                                   url: 'https://.../grupo/{{1}}', example: [...] } ] }
//
// Um `components.find(c => c.type === 'BUTTON')` (singular) NUNCA casa — foi o erro que a
// sessao anterior cometeu e reverteu, e o comentario de sincronizarTemplateWhatsapp em
// db/sqlite.js registra o incidente.
//
// O `url` de um botao de URL DINAMICA contem o PADRAO com o placeholder ainda LITERAL
// ("https://.../grupo/{{1}}"). A Meta so aprova o padrao; o valor real vai por envio, na
// chave `button<indice>` de `vars` (ver montarPayload em providers/centralWhats).
// Botao ESTATICO nao tem placeholder na url e nao aceita parametro.

// Extrai os botoes de `components` na forma que guardamos: [{indice, tipo, texto, url}].
// O INDICE e a posicao no array, que e o que a Meta usa para casar `button<n>`.
//
// Tolerante por contrato: componente ausente, `buttons` que nao e array, botao sem url —
// tudo vira lista vazia ou entrada com campos vazios, nunca excecao. A origem e uma API
// externa, e um formato inesperado nao pode derrubar o sync inteiro.
function extrairBotoes(components) {
  const bloco = (Array.isArray(components) ? components : []).find(
    (c) => c && String(c.type || '').toUpperCase() === 'BUTTONS',
  );
  const lista = bloco && Array.isArray(bloco.buttons) ? bloco.buttons : [];
  return lista.map((b, indice) => ({
    indice,
    tipo: String((b && b.type) || '').toUpperCase(),
    texto: String((b && b.text) || ''),
    url: String((b && b.url) || ''),
  }));
}

// O botao tem URL dinamica? E o que distingue "aceita parametro por envio" de "link fixo".
function botaoEhDinamico(botao) {
  return Boolean(botao) && botao.tipo === 'URL' && /\{\{\s*\d+\s*\}\}/.test(botao.url || '');
}

// Caminho da pagina publica de descadastro. E por ele que um botao e reconhecido como "o
// botao de descadastro" — o RECONHECIMENTO E PELA URL, e nao pelo rotulo: o texto do botao
// e escrito a mao no painel da Meta e pode variar ("Não quero mais receber", "Sair da
// lista", com ou sem acento), enquanto a URL e a mesma sempre porque precisa bater com a
// rota registrada em routes/pages.js.
const CAMINHO_DESCADASTRO = '/descadastro/';

// Indice do botao de descadastro, ou null quando o template nao tem um.
//
// `botoes` e a lista devolvida por extrairBotoes (ou o JSON ja gravado, ver
// botoesDoTemplate). Exige URL DINAMICA: um botao apontando para /descadastro/ sem
// placeholder seria um link fixo para a mesma pagina para todo mundo — que nao descadastra
// ninguem, porque a pagina exige o token no caminho.
function indiceBotaoDescadastro(botoes) {
  const lista = Array.isArray(botoes) ? botoes : [];
  const achado = lista.find((b) => botaoEhDinamico(b) && String(b.url || '').includes(CAMINHO_DESCADASTRO));
  return achado ? achado.indice : null;
}

// Le a coluna `botoes_json` com tolerancia a JSON invalido/ausente. Devolve [] no pior caso —
// que significa "template sem botao", o lado seguro (nao manda parametro nenhum).
function botoesDoTemplate(botoesJson) {
  if (Array.isArray(botoesJson)) return botoesJson;
  if (!botoesJson) return [];
  try {
    const lido = JSON.parse(botoesJson);
    return Array.isArray(lido) ? lido : [];
  } catch {
    return [];
  }
}

// Monta a URL final EXATAMENTE como a Meta monta: substitui o placeholder do padrao pelo
// valor do parametro. Existe para o teste poder provar que o link que chega no aparelho da
// pessoa casa com a rota que o servidor registra — sem isso, um padrao errado no template
// so apareceria como 404 para o candidato, que e onde ninguem esta olhando.
function montarUrlDoBotao(padraoUrl, valor) {
  return String(padraoUrl || '').replace(/\{\{\s*\d+\s*\}\}/, String(valor == null ? '' : valor));
}

module.exports = {
  pertenceVendedorMestre,
  EXCECOES_PADRAO_VM,
  precisaBotaoDinamico,
  TEMPLATES_COM_BOTAO_DINAMICO,
  extrairBotoes,
  botaoEhDinamico,
  indiceBotaoDescadastro,
  botoesDoTemplate,
  montarUrlDoBotao,
  CAMINHO_DESCADASTRO,
};
