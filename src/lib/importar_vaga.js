'use strict';

// Import de vaga por briefing (Func. 1). Le um Google Doc (via providers/drive) e usa o
// LLM para extrair os campos da vaga como JSON, para PRE-PREENCHER o form de nova vaga
// (revisao humana antes de salvar). NAO salva nada: o salvamento continua sendo o
// POST /vagas humano. Espelha o padrao de lib/relatorio.js (prompt + parse isolados da
// camada HTTP; deps injetaveis p/ teste sem rede/credencial/LLM real).

const { CIDADES_VALIDAS, normalizarCidade } = require('./cidades');

// Campos extraidos (ordem estavel p/ o aviso de "ausentes"). secoes_extras fica DE FORA
// de proposito: o formato "## Titulo + itens" e peculiar e a IA geraria lixo — melhoria
// futura. O admin preenche secoes_extras manualmente na revisao, se quiser.
const CAMPOS_STRING = [
  'titulo',
  'faixa_pagamento',
  'potencial_ganhos',
  'endereco',
  'horario',
  'descricao',
  'sobre_empresa',
];
const CAMPOS_ARRAY = ['atividades', 'requisitos', 'beneficios', 'skills'];

const PERFIS_VALIDOS = ['SDR', 'CLOSER'];
const REGIMES_VALIDOS = ['CLT', 'PJ'];

// Teto defensivo do texto do briefing enviado ao LLM (briefings sao curtos; isto so evita
// um Doc anomalo estourar tokens). Chamada unica, sem historico.
const MAX_BRIEFING_CHARS = 12000;

// ── Normalizadores de enum (variacao de caixa/acento NAO e "invalido"; so mapeamos ao
//    valor canonico. Fora da lista -> '' (tratado como ausente e sinalizado)). ──
function normalizarPerfil(v) {
  const s = String(v || '').trim().toUpperCase();
  return PERFIS_VALIDOS.includes(s) ? s : '';
}
function normalizarModalidade(v) {
  const s = String(v || '')
    .trim()
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, ''); // remove acentos p/ comparar (ex.: "híbrido" -> "hibrido")
  const mapa = { presencial: 'presencial', hibrido: 'híbrido', remoto: 'remoto' };
  return mapa[s] || '';
}
function normalizarRegime(v) {
  const s = String(v || '').trim().toUpperCase();
  return REGIMES_VALIDOS.includes(s) ? s : '';
}

// Monta as mensagens de extracao (system + user). Usa o LLM COMPLEXO por padrao (a
// selecao acontece em providers/llm quando nao passamos `modelo`/`tarefa`).
function montarMensagensExtracao(briefingTexto) {
  const briefing = String(briefingTexto || '').slice(0, MAX_BRIEFING_CHARS);

  const system = [
    'Voce extrai dados estruturados de um briefing de vaga de vendas (portugues do Brasil)',
    'e devolve APENAS um JSON valido — sem cercas markdown, sem texto antes ou depois.',
    '',
    'Extraia SOMENTE o que estiver no briefing. Para campos ausentes, use "" (string',
    'vazia) ou [] (array vazio). NUNCA invente valores.',
    '',
    'Formato EXATO (use estas chaves e tipos, e NENHUMA outra chave):',
    '{',
    '  "titulo": "string",',
    '  "perfil": "SDR" | "CLOSER",            // infira do briefing; se ambiguo, escolha o mais provavel',
    '  "faixa_pagamento": "string",',
    '  "potencial_ganhos": "string",',
    '  "endereco": "string",',
    // Enum fechado, mesma forma de modalidade/regime logo abaixo — a lista de opcoes vai
    // INTERPOLADA de CIDADES_VALIDAS, e nao escrita a mao aqui: uma praca nova acrescentada
    // em lib/cidades tem que aparecer no prompt sozinha, senao o LLM nunca a proporia e o
    // sintoma seria "a IA nunca acerta essa cidade" — difícil de ligar a esta linha.
    `  "cidade": ${CIDADES_VALIDAS.map((c) => `"${c}"`).join(' | ')} | "",  // so essas; se nao achar, ""`,
    // O par endereco/cidade e a unica redundancia proposital do formato: `endereco` e o
    // texto exibido na pagina da vaga ("Anita Garibaldi - Joinville-SC"), `cidade` e a praca
    // canonica para recorte de base. Pedir os dois separadamente e o que evita ter que
    // adivinhar um a partir do outro depois — e adivinhar erraria "Campinas, Sao Paulo-SP".
    '  // `endereco` e o texto completo; `cidade` e so a praca da lista acima.',
    // Campo IRMAO de `cidade`, sem restricao de lista — existe so para o caso em que o
    // briefing menciona uma praca fora do vocabulario fechado. `cidade` continua "" nesse
    // caso (o enum fechado nao muda aqui, isso e decisao de outro incremento), mas sem este
    // campo o texto que a IA leu se perde e o admin fica sem pista do que preencher na
    // revisao. Sempre preenchido quando ha alguma cidade/praca no texto, MESMO quando
    // `cidade` bateu com a lista (redundante nesse caso, e inofensivo).
    '  "cidade_bruta": "string",  // cidade/praca como aparece no briefing, SEM filtrar pela lista acima; "" se o briefing nao mencionar nenhuma',
    '  "modalidade": "presencial" | "híbrido" | "remoto" | "",  // so esses; se nao achar, ""',
    '  "regime": "CLT" | "PJ" | "",           // so esses; se nao achar, ""',
    '  "horario": "string",',
    '  "descricao": "string",',
    '  "atividades": ["string", ...],',
    '  "requisitos": ["string", ...],',
    '  "beneficios": ["string", ...],',
    '  "skills": ["string", ...],',
    '  "sobre_empresa": "string"',
    '}',
    '',
    'REGRAS DE TAMANHO (para caber na resposta e nao truncar):',
    '- descricao: no maximo 2-3 frases (um resumo, NAO uma copia do briefing).',
    '- sobre_empresa: no maximo 2-3 frases.',
    '- atividades / requisitos / beneficios / skills: cada item da lista deve ser CURTO',
    '  (uma linha, nao um paragrafo); nao copie trechos longos do briefing.',
    '- Resuma com suas palavras; NAO copie paragrafos inteiros do briefing.',
    '',
    'Responda so com o objeto JSON.',
  ].join('\n');

  const user = ['BRIEFING DA VAGA:', '', briefing || '(briefing vazio)'].join('\n');

  return [
    { papel: 'system', conteudo: system },
    { papel: 'user', conteudo: user },
  ];
}

// Recorta o JSON tolerando cercas markdown acidentais (mesma ideia do parseAvaliacao do
// relatorio). Retorna a string "cru" pronta p/ JSON.parse (que pode lancar).
function recortarJson(texto) {
  let cru = String(texto || '').trim();
  const fence = cru.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) cru = fence[1].trim();
  const ini = cru.indexOf('{');
  const fim = cru.lastIndexOf('}');
  if (ini !== -1 && fim !== -1 && fim > ini) cru = cru.slice(ini, fim + 1);
  return cru;
}

// Parseia + normaliza a resposta do LLM num objeto "vaga-like" (arrays CRUS — camposVagaHtml
// ja renderiza via linhasDeArray) + a lista de campos ausentes (vazios) para o aviso.
// LANCA se nao for JSON valido/objeto (o caller trata como extracao falhou).
function parseExtracaoVaga(textoLLM) {
  const obj = JSON.parse(recortarJson(textoLLM)); // pode lancar
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) {
    throw new Error('JSON de extracao nao e um objeto.');
  }

  const vaga = {};
  const ausentes = [];

  for (const c of CAMPOS_STRING) {
    const v = typeof obj[c] === 'string' ? obj[c].trim() : '';
    vaga[c] = v;
    if (!v) ausentes.push(c);
  }
  for (const c of CAMPOS_ARRAY) {
    const arr = Array.isArray(obj[c]) ? obj[c].map((x) => String(x).trim()).filter(Boolean) : [];
    vaga[c] = arr;
    if (!arr.length) ausentes.push(c);
  }

  // Enums (com guard): valor fora da lista NAO chega ao form; entra em "ausentes".
  vaga.perfil = normalizarPerfil(obj.perfil);
  if (!vaga.perfil) ausentes.push('perfil');
  // Guard identico ao de modalidade: valor fora da lista NAO chega ao form, vai para
  // `ausentes` e o operador preenche na revisao. Aceitar o que o LLM devolvesse reabriria
  // o campo livre por outra porta — que e exatamente o que este campo existe para fechar.
  //
  // `|| ''` porque normalizarCidade devolve null (o valor da coluna) e o form espera ''
  // para "vazio", igual aos outros dois enums. A conversao mora aqui, no ponto de uso.
  vaga.cidade = normalizarCidade(obj.cidade) || '';
  if (!vaga.cidade) {
    ausentes.push('cidade');
    // Preserva o texto BRUTO que a IA leu (cidade_bruta, ou o proprio `cidade` no caso
    // raro do modelo ignorar a restricao da lista e devolver texto livre ali) — hoje esse
    // dado se perdia no `|| ''` acima. Nao valida nem tenta casar com nada aqui: e so
    // insumo para o admin decidir, na revisao, se cadastra a praca nova (ver Incremento 5).
    // Ausente (nao "") quando a IA nao leu cidade nenhuma, para o consumidor distinguir
    // "sem sugestao" de "sugestao vazia" sem precisar de um sentinela por string.
    const bruta =
      (typeof obj.cidade_bruta === 'string' && obj.cidade_bruta.trim()) ||
      (typeof obj.cidade === 'string' && obj.cidade.trim()) ||
      '';
    if (bruta) vaga.cidadeSugeridaBruta = bruta;
  }
  vaga.modalidade = normalizarModalidade(obj.modalidade);
  if (!vaga.modalidade) ausentes.push('modalidade');
  vaga.regime = normalizarRegime(obj.regime);
  if (!vaga.regime) ausentes.push('regime');

  // Fora do escopo da extracao / defaults de exibicao do form de nova vaga.
  vaga.secoes_extras = [];
  vaga.ativo = true; // "Vaga ativa" marcada por padrao (igual ao form de nova vaga)

  return { vaga, ausentes };
}

// Orquestra o import: URL -> fileId -> texto do Doc -> extracao LLM -> objeto vaga-like.
// Resultado discriminado (nunca lanca):
//   { ok:false, erroCodigo:'LINK_INVALIDO' | 'DOC_SEM_ACESSO' | 'DOC_NAO_EXPORTAVEL'
//                          | 'EXTRACAO_TRUNCADA' | 'EXTRACAO_FALHOU' }
//   { ok:true, vaga, ausentes[] }
// deps = { drive, llm } injetaveis (providers agnosticos) — teste usa mocks.
async function importarVagaDeBriefing({ url, drive, llm } = {}) {
  const fileId = drive.extrairFileIdDeUrl(url);
  if (!fileId) return { ok: false, erroCodigo: 'LINK_INVALIDO' };

  let texto;
  try {
    texto = await drive.exportarTextoDoc(fileId);
  } catch (err) {
    const codigo = ['DOC_SEM_ACESSO', 'DOC_NAO_EXPORTAVEL'].includes(err && err.code)
      ? err.code
      : 'DOC_ERRO';
    return { ok: false, erroCodigo: codigo };
  }
  if (!texto || !texto.trim()) return { ok: false, erroCodigo: 'EXTRACAO_FALHOU' };

  // maxTokens folgado: o shape tem 14 campos, varios de texto livre (descricao,
  // atividades, requisitos, beneficios, sobre_empresa). 2200 da folga real sobre os 1500
  // do relatorio (shape mais simples) e evita o truncamento que cortava o JSON no meio de
  // uma string ("Unterminated string"). O prompt tambem pede concisao (menos tokens de saida).
  let resp;
  try {
    resp = await llm.completar(montarMensagensExtracao(texto), {
      temperatura: 0.2,
      maxTokens: 2200,
    });
    const { vaga, ausentes } = parseExtracaoVaga(resp && resp.texto);
    return { ok: true, vaga, ausentes };
  } catch (err) {
    // Observabilidade: loga finishReason e o TAMANHO do texto (nunca o texto inteiro em
    // prod) + uma amostra curta do inicio, para confirmar truncamento sem poluir o log.
    const finishReason = resp && resp.finishReason;
    const tam = resp && typeof resp.texto === 'string' ? resp.texto.length : 0;
    const amostra = resp && typeof resp.texto === 'string' ? resp.texto.slice(0, 200) : '';
    console.error(
      `[importar-vaga] falha na extracao/parse: ${err && err.message} ` +
        `(finishReason=${finishReason}, textoLen=${tam}, amostra=${JSON.stringify(amostra)})`,
    );
    // Truncamento por limite de tokens -> mensagem especifica (diferente do generico).
    if (finishReason === 'length') {
      return { ok: false, erroCodigo: 'EXTRACAO_TRUNCADA' };
    }
    return { ok: false, erroCodigo: 'EXTRACAO_FALHOU' };
  }
}

module.exports = {
  montarMensagensExtracao,
  parseExtracaoVaga,
  importarVagaDeBriefing,
  CAMPOS_STRING,
  CAMPOS_ARRAY,
};
