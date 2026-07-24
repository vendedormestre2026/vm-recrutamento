'use strict';

// Helper de UTM (first-touch). Funcoes puras e testaveis, sem dependencia de banco,
// req/res ou ambiente — para a captura (pages.js) e a persistencia (sqlite.js) usarem
// a MESMA regra de normalizacao/leitura, e os testes cobrirem tudo isoladamente.
//
// Formato canonico do objeto UTM: { source, medium, campaign, content, term }.
// null em qualquer campo = ausente. O objeto inteiro null = "nao ha UTM".

// Numero maximo de caracteres por valor de UTM (defesa contra querystrings enormes;
// os valores viram colunas/linhas no painel, entao truncar mantem o dado sao).
const MAX_UTM = 100;

// 2.1 Normaliza um unico valor de UTM:
//   - null/undefined/nao-string -> null
//   - trim
//   - vazio apos trim -> null
//   - lowercase (evita "Google" e "google" virarem duas origens distintas no painel)
//   - trunca em 100 caracteres
function normalizarValorUtm(valor) {
  if (typeof valor !== 'string') return null;
  const limpo = valor.trim();
  if (!limpo) return null;
  return limpo.toLowerCase().slice(0, MAX_UTM);
}

// 2.2 Extrai os cinco parametros UTM de req.query, cada um normalizado. Se TODOS forem
// null (nenhuma UTM na visita), retorna null — sinal de "nao ha UTM nesta visita".
function extrairUtmDaQuery(query) {
  const q = query || {};
  const obj = {
    source: normalizarValorUtm(q.utm_source),
    medium: normalizarValorUtm(q.utm_medium),
    campaign: normalizarValorUtm(q.utm_campaign),
    content: normalizarValorUtm(q.utm_content),
    term: normalizarValorUtm(q.utm_term),
  };
  const todosNulos =
    !obj.source && !obj.medium && !obj.campaign && !obj.content && !obj.term;
  return todosNulos ? null : obj;
}

// 2.3 Le o conteudo CRU do cookie vm_utm e devolve o formato canonico (ou null).
//
// RETROCOMPATIBILIDADE: o cookie legado guarda uma STRING SIMPLES (ex.: "instagram"),
// nao JSON. Se o valor nao for um OBJETO JSON valido, tratamos a string inteira como
// { source: <normalizado>, medium: null, campaign: null, content: null, term: null } —
// cookies antigos nunca quebram nem sao descartados. So consideramos "estruturado"
// quando o parse resulta num objeto simples (JSON que vira numero/array/string cai no
// caminho legado, por seguranca).
function lerUtmDoCookie(valorBruto) {
  if (typeof valorBruto !== 'string') return null;
  const cru = valorBruto.trim();
  if (!cru) return null;

  let obj = null;
  try {
    const parsed = JSON.parse(cru);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      obj = {
        source: normalizarValorUtm(parsed.source),
        medium: normalizarValorUtm(parsed.medium),
        campaign: normalizarValorUtm(parsed.campaign),
        content: normalizarValorUtm(parsed.content),
        term: normalizarValorUtm(parsed.term),
      };
    }
  } catch {
    // Nao era JSON: cookie legado em string simples. Tratado abaixo.
    obj = null;
  }

  // Legado (nao-JSON, ou JSON que nao e objeto): a string inteira vira o source.
  if (!obj) {
    obj = {
      source: normalizarValorUtm(cru),
      medium: null,
      campaign: null,
      content: null,
      term: null,
    };
  }

  const todosNulos =
    !obj.source && !obj.medium && !obj.campaign && !obj.content && !obj.term;
  return todosNulos ? null : obj;
}

// 2.4 Serializa o objeto UTM para gravar no cookie. null -> null (nada a gravar).
function serializarUtmParaCookie(objeto) {
  if (objeto == null) return null;
  return JSON.stringify(objeto);
}

module.exports = {
  normalizarValorUtm,
  extrairUtmDaQuery,
  lerUtmDoCookie,
  serializarUtmParaCookie,
};
