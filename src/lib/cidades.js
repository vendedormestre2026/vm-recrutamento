'use strict';

// Vocabulario fechado de CIDADES (pracas de atuacao).
//
// ── POR QUE ESTE ARQUIVO EXISTE ──
// `jobs.endereco` e texto livre — digitado no painel ou redigido pelo LLM a partir do
// briefing (lib/importar_vaga). Em 7 vagas preenchidas, produziu 7 formatos diferentes:
//
//   Anita Garibaldi - Joinville-SC        bairro + cidade-UF, hifen
//   Anita Garibaldi - Joinville/SC        MESMO endereco, barra
//   Joinville, SC (bairro Bom Retiro)     cidade, UF, bairro entre parenteses
//   Unidade Santo Antonio - Joinville     unidade + cidade, sem UF
//   Sao Paulo - Cidade Moncoes            cidade + bairro, travessao
//   Alphaville Empresarial Barueri-SP     bairro + cidade-UF, sem separador
//   Campinas, Sao Paulo-SP                cidade + ESTADO, e o pior caso: contem o
//                                         literal "Sao Paulo" sendo uma vaga de Campinas
//
// O ultimo e o que decide a favor de um campo estruturado. Nenhum parser resolve: um
// LIKE '%Sao Paulo%' classificaria aquela vaga como Sao Paulo e erraria 156 candidatos.
// E a taxa nao vai melhorar sozinha — o formato de cada endereco novo depende da redacao
// do briefing, entao 7 formatos em 7 vagas e o comportamento esperado, nao um acidente.
//
// A cidade passa a ser dado CATEGORICO, ao lado de `modalidade` e `regime`, que ja sao
// enums fechados no mesmo formulario e no mesmo prompt. `endereco` continua existindo e
// sendo exibido: ele responde "onde exatamente", que continua sendo texto livre legitimo.
// Este campo responde "qual praca", que e outra pergunta.
//
// ── POR QUE MODULO PROPRIO, e nao uma constante dentro de importar_vaga ou admin ──
// Sao tres consumidores previstos desde o inicio (normalizador, formulario do painel,
// prompt do LLM) e nenhum deles e dono da lista. Deixa-la em qualquer um dos tres faria
// os outros dois importarem de um lugar que nao explica por que a lista e aquela. Mesmo
// movimento de providers/emailCampanha/cabecalhos.js, extraido quando o terceiro
// transporte apareceu: a regra e do dominio, nao de quem a usa primeiro.

// As pracas onde ha operacao. Oito vieram do backfill da base legada (sao exatamente as
// que db.listarCidadesDistintas() ja devolve hoje, derivadas por dicionario de empresa de
// origem, nao digitadas). Barueri e a nona, e entra agora porque ja existe vaga la
// (Alphaville Empresarial Barueri-SP, 65 candidatos) sem representacao no vocabulario.
//
// Ordem alfabetica pt-BR, a MESMA de listarCidadesDistintas — as duas listas aparecem
// lado a lado em tela e divergir na ordem pareceria bug.
//
// ── LISTA FECHADA, E ESSE E O PONTO ──
// Acrescentar uma praca e uma edicao de codigo deliberada, com revisao. E mais atrito que
// um campo livre, de proposito: foi a ausencia desse atrito que produziu as sete
// variacoes acima. Quem opera nao deve conseguir inventar uma cidade sem que alguem note.
//
// Congelada (Object.freeze) porque a lista viaja por tres modulos e um `.push()` acidental
// em qualquer um deles mudaria o vocabulario dos outros dois em silencio.
const CIDADES_VALIDAS = Object.freeze([
  'Balneário Camboriú',
  'Barueri',
  'Campinas',
  'Curitiba',
  'Florianópolis',
  'Jaraguá do Sul',
  'Joinville',
  'São Paulo',
  'Tijucas',
]);

// NAO entra aqui: o sentinela 'Todas as cidades' de `talentos.cidade`.
//
// Ele marca uma PESSOA presente em qualquer praca (531 no legado) e serve ao filtro de
// publico, onde casa com qualquer selecao. Uma VAGA nao tem esse estado — ela acontece em
// um lugar, ou e remota (e ai `jobs.cidade` fica NULL). Oferecer o sentinela no seletor de
// vaga convidaria o operador a marca-lo achando que significa "qualquer lugar", e o
// resultado seria uma vaga presencial entrando em todo disparo regional.
//
// O sentinela vive hoje duplicado em lib/promocaoVagas.js e lib/limpezaLegado.js. Unificar
// os dois e limpeza legitima, mas e de outro assunto: aquilo e vocabulario de PESSOA, isto
// e de VAGA, e junta-los aqui so porque as strings se parecem seria o erro de sempre.

module.exports = { CIDADES_VALIDAS };
