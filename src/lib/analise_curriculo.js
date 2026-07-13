'use strict';

// Motor de analise de curriculo do Banco de Talentos (T3). Compara o texto extraido do
// curriculo com o perfil ideal (perfis_curriculo.estrutura.criterios) via LLM e devolve
// score + notas por criterio + pontos fortes/atencao. Espelha o padrao de
// lib/importar_vaga.js e lib/relatorio.js (prompt + parse isolados da camada HTTP).
//
// SEM modo mock (decisao de design): diferente da entrevista (INTERVIEW_MOCK), esta
// feature chama o provider LLM real por padrao, inclusive em testes/smoke. `deps.llm`
// e injetavel apenas para quem QUISER testar sem rede — a chamada padrao e real.

const { config } = require('../config');

// Teto defensivo do texto do curriculo enviado ao LLM (mesmo espirito de
// MAX_BRIEFING_CHARS do importar_vaga). curriculo_texto ja vem truncado em 20.000
// caracteres pelo extrator (lib/curriculo.MAX_CARACTERES); este teto so protege contra
// um texto anomalo vindo de outra origem.
const MAX_CURRICULO_CHARS = 20000;

// Escala da nota por criterio (1-5, igual a rubrica dos relatorios de entrevista).
const NOTA_MIN = 1;
const NOTA_MAX = 5;

// Normaliza os criterios do perfil ideal: so entram os com nome nao-vazio; peso
// invalido/ausente => 1 (mesma regra de calcularPontuacaoGeral em relatorio.js).
function criteriosDe(perfilCurriculo) {
  const estrutura = (perfilCurriculo && perfilCurriculo.estrutura) || {};
  const lista = Array.isArray(estrutura.criterios) ? estrutura.criterios : [];
  return lista
    .filter((c) => c && String(c.nome || '').trim())
    .map((c, i) => {
      const peso = Number(c.peso);
      return {
        id: String(c.id || `criterio_${i + 1}`),
        nome: String(c.nome).trim(),
        peso: Number.isFinite(peso) && peso > 0 ? peso : 1,
        descricao_ideal: String(c.descricao_ideal || '').trim(),
      };
    });
}

// Monta as mensagens (system + user) da analise. score_geral e EMITIDO pela LLM (mesmo
// principio de `recomendacao` em relatorio.js: julgamento holistico, nao funcao
// deterministica das notas). A media ponderada das notas por criterio fica so como
// valor auxiliar de auditoria (score_referencia), calculado em calcularScoreGeral.
function montarMensagensAnalise({ perfilCurriculo, curriculoTexto }) {
  const criterios = criteriosDe(perfilCurriculo);
  const curriculo = String(curriculoTexto || '').slice(0, MAX_CURRICULO_CHARS);
  const instrucoes = String(
    ((perfilCurriculo && perfilCurriculo.estrutura) || {}).instrucoes || '',
  ).trim();

  const listaCriterios = criterios
    .map(
      (c) =>
        `- id "${c.id}" | ${c.nome} (peso ${c.peso}): curriculo ideal = ${c.descricao_ideal || 'n/d'}`,
    )
    .join('\n');

  const system = [
    'Voce e um avaliador senior de curriculos de vendedores, em portugues do Brasil.',
    `Avalie o curriculo do candidato contra o perfil ideal de ${
      (perfilCurriculo && perfilCurriculo.perfil) || 'vendas'
    } descrito abaixo.`,
    'Baseie-se SOMENTE no que estiver no curriculo. Nao invente fatos; se um criterio nao',
    'tiver evidencia no texto, atribua nota baixa e diga isso no comentario.',
    '',
    'CRITERIOS DO CURRICULO IDEAL (com peso e a descricao do que seria ideal):',
    listaCriterios,
    instrucoes ? `\nINSTRUCOES ADICIONAIS DO RECRUTADOR:\n${instrucoes}` : null,
    '',
    'FORMATO DE SAIDA — responda SOMENTE com um JSON valido, sem cercas markdown e sem',
    'texto antes ou depois. Use EXATAMENTE este formato:',
    '{',
    '  "score_geral": <numero inteiro de 0 a 100>,',
    '  "por_criterio": [',
    '    { "id": "<id exato do criterio>", "nome": "<nome exato do criterio>", "nota": <1 a 5>, "comentario": "1 a 2 frases" }',
    '  ],',
    '  "pontos_fortes": ["item curto", "..."],',
    '  "pontos_atencao": ["item curto", "..."]',
    '}',
    'Inclua TODOS os criterios listados em "por_criterio", com o id e o nome EXATOS.',
    'A nota vai de 1 (sem evidencia / muito distante do ideal) a 5 (forte evidencia de',
    'aderencia ao ideal). Cada item de pontos_fortes/pontos_atencao deve ser CURTO (uma',
    'linha). Nao adicione campos extras.',
  ]
    .filter((l) => l !== null)
    .join('\n');

  const user = ['CURRICULO DO CANDIDATO:', '', curriculo || '(curriculo vazio)'].join('\n');

  return [
    { papel: 'system', conteudo: system },
    { papel: 'user', conteudo: user },
  ];
}

// Recorta o JSON tolerando cercas markdown acidentais (replica de recortarJson do
// importar_vaga.js). Retorna a string "cru" pronta p/ JSON.parse (que pode lancar).
function recortarJson(texto) {
  let cru = String(texto || '').trim();
  const fence = cru.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) cru = fence[1].trim();
  const ini = cru.indexOf('{');
  const fim = cru.lastIndexOf('}');
  if (ini !== -1 && fim !== -1 && fim > ini) cru = cru.slice(ini, fim + 1);
  return cru;
}

// Media ponderada das notas por criterio, normalizada para 0-100 — valor AUXILIAR de
// auditoria (score_referencia), NAO o score exibido (esse e o score_geral da LLM).
// Serve para detectar divergencia entre o julgamento holistico da LLM e a media das
// notas individuais (log de aviso quando divergem muito).
// score = (soma(nota_i * peso_i) / soma(peso_i)) / NOTA_MAX * 100, arredondado.
// Itens sem nota valida nao entram na media; null quando nada e pontuavel.
function calcularScoreGeral(porCriterio) {
  let somaPesoNota = 0;
  let somaPeso = 0;
  for (const item of Array.isArray(porCriterio) ? porCriterio : []) {
    if (!Number.isFinite(item && item.nota)) continue;
    const peso = Number.isFinite(item.peso) && item.peso > 0 ? item.peso : 1;
    somaPesoNota += item.nota * peso;
    somaPeso += peso;
  }
  if (somaPeso <= 0) return null;
  return Math.round((somaPesoNota / somaPeso / NOTA_MAX) * 100);
}

// Parseia + valida a resposta do LLM campo a campo (padrao de parseAvaliacao em
// relatorio.js). LANCA se nao for JSON valido/objeto — o caller (analisarCurriculo)
// captura e converte em { ok:false }. Os criterios canonicos vem do PERFIL (id, nome e
// peso do banco); do LLM aproveitamos apenas nota + comentario, casados por id (ou por
// nome, se o modelo trocar o id) — o modelo nunca "inventa" criterio no resultado.
function parseAnalise(textoLLM, criterios) {
  const obj = JSON.parse(recortarJson(textoLLM)); // pode lancar
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) {
    throw new Error('JSON da analise nao e um objeto.');
  }

  const itensLlm = Array.isArray(obj.por_criterio) ? obj.por_criterio.filter(Boolean) : [];
  const porId = new Map();
  const porNome = new Map();
  for (const item of itensLlm) {
    if (item.id != null) porId.set(String(item.id).trim(), item);
    if (item.nome != null) porNome.set(String(item.nome).trim().toLowerCase(), item);
  }

  const porCriterio = criterios.map((c) => {
    const item = porId.get(c.id) || porNome.get(c.nome.toLowerCase()) || null;
    // Guard da nota: fora de 1-5 (ou nao-numerica) vira null (nao entra no score) — a
    // analise nunca falha inteira por um criterio ruim, so loga.
    let nota = null;
    if (item) {
      const n = Math.round(Number(item.nota));
      if (Number.isFinite(n) && n >= NOTA_MIN && n <= NOTA_MAX) nota = n;
    }
    if (!item || nota === null) {
      console.warn(
        `[analise-curriculo] criterio "${c.nome}" ${
          item ? `com nota invalida (${JSON.stringify(item.nota)})` : 'ausente na resposta do LLM'
        }; nota=null (fora do score).`,
      );
    }
    return {
      id: c.id,
      nome: c.nome,
      peso: c.peso,
      nota,
      comentario: item && typeof item.comentario === 'string' ? item.comentario.trim() : '',
    };
  });

  const listaCurta = (v) =>
    Array.isArray(v) ? v.map((x) => String(x).trim()).filter(Boolean) : [];

  // Score geral EMITIDO PELA LLM (mesmo principio de `recomendacao` em relatorio.js).
  // Enum-guard de faixa: inteiro 0-100; ausente / fora da faixa / nao-numerico => null
  // (nao trava a analise, apenas loga — igual ao tratamento de recomendacao invalida).
  const scoreLlm = Math.round(Number(obj.score_geral));
  let score_geral = null;
  if (Number.isFinite(scoreLlm) && scoreLlm >= 0 && scoreLlm <= 100) {
    score_geral = scoreLlm;
  } else if (obj.score_geral != null) {
    console.warn(
      `[analise-curriculo] "score_geral" invalido no JSON da LLM (${JSON.stringify(obj.score_geral)}); assumindo null.`,
    );
  }

  // Media ponderada das notas (auditoria). Divergencia grande (>=20 pts) vira log — nao
  // altera o score exibido, so sinaliza para revisao humana quando LLM e notas discordam.
  const score_referencia = calcularScoreGeral(porCriterio);
  if (
    score_geral != null &&
    score_referencia != null &&
    Math.abs(score_geral - score_referencia) >= 20
  ) {
    console.warn(
      `[analise-curriculo] score_geral da LLM (${score_geral}) diverge da media ponderada de referencia (${score_referencia}) em >=20 pontos.`,
    );
  }

  return {
    score_geral, // da LLM — vai para o candidato / relatorio
    score_referencia, // media ponderada calculada (auditoria/divergencia)
    por_criterio: porCriterio,
    pontos_fortes: listaCurta(obj.pontos_fortes),
    pontos_atencao: listaCurta(obj.pontos_atencao),
  };
}

// Orquestra a analise: perfil ideal + texto do curriculo -> LLM -> analise validada.
// Resultado discriminado (NUNCA lanca):
//   { ok:true, analise: { score_geral, score_referencia, por_criterio[],
//                         pontos_fortes[], pontos_atencao[] } }
//   { ok:false, erroCodigo:'PERFIL_SEM_CRITERIOS' | 'CURRICULO_SEM_TEXTO'
//                        | 'ANALISE_TRUNCADA' | 'ANALISE_FALHOU' }
async function analisarCurriculo({ perfilCurriculo, curriculoTexto }, deps = {}) {
  const llm = deps.llm || require('../providers/llm');

  const criterios = criteriosDe(perfilCurriculo);
  if (!criterios.length) return { ok: false, erroCodigo: 'PERFIL_SEM_CRITERIOS' };
  if (!String(curriculoTexto || '').trim()) return { ok: false, erroCodigo: 'CURRICULO_SEM_TEXTO' };

  // maxTokens folgado: score + N criterios com comentario + duas listas. Temperatura
  // baixa (avaliacao, nao criatividade). Modelo COMPLEXO explicito (LLM_MODEL_COMPLEXO).
  let resp;
  try {
    resp = await llm.completar(montarMensagensAnalise({ perfilCurriculo, curriculoTexto }), {
      modelo: config.provedores.llm.modeloComplexo,
      temperatura: 0.2,
      maxTokens: 1800,
    });
    const analise = parseAnalise(resp && resp.texto, criterios);
    return { ok: true, analise };
  } catch (err) {
    // Observabilidade no molde do importar_vaga: finishReason + tamanho + amostra curta
    // (nunca o texto inteiro em prod).
    const finishReason = resp && resp.finishReason;
    const tam = resp && typeof resp.texto === 'string' ? resp.texto.length : 0;
    const amostra = resp && typeof resp.texto === 'string' ? resp.texto.slice(0, 200) : '';
    console.error(
      `[analise-curriculo] falha na analise/parse: ${err && err.message} ` +
        `(finishReason=${finishReason}, textoLen=${tam}, amostra=${JSON.stringify(amostra)})`,
    );
    if (finishReason === 'length') return { ok: false, erroCodigo: 'ANALISE_TRUNCADA' };
    return { ok: false, erroCodigo: 'ANALISE_FALHOU' };
  }
}

module.exports = {
  analisarCurriculo,
  montarMensagensAnalise,
  parseAnalise,
  calcularScoreGeral,
  MAX_CURRICULO_CHARS,
};
