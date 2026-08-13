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

// Chave de comparacao: sem caixa, sem acento, sem espaco nas bordas.
//
// A remocao de acento e a mesma tecnica de normalizarModalidade em lib/importar_vaga
// ("híbrido" -> "hibrido"), e aqui pesa mais: sete das nove pracas tem acento, e a origem
// mais provavel dos valores e um LLM redigindo a partir de briefing — onde "Sao Paulo" e
// "Balneario Camboriu" sao grafias correntes. Recusar por causa de um til seria transformar
// um problema de digitacao em ausencia de dado.
//
// NFD separa a letra do diacritico e a faixa U+0300-U+036F apaga so o diacritico.
function chave(valor) {
  return String(valor || '')
    .trim()
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '');
}

// Indice chave -> valor canonico. Construido UMA vez, no load: a lista e congelada e nao
// muda em runtime, e reconstruir o mapa a cada chamada seria trabalho por nada num caminho
// que o formulario do painel percorre a cada salvamento de vaga.
const PORCHAVE = new Map(CIDADES_VALIDAS.map((c) => [chave(c), c]));

// Normaliza para o valor CANONICO da lista, ou null.
//
// ── ENUM FECHADO, IGUAL A MODALIDADE ──
// Espelha normalizarModalidade: variacao de caixa/acento NAO e "invalido" (mapeia-se ao
// canonico), mas qualquer coisa fora da lista e recusada. A diferenca de retorno e
// deliberada — modalidade devolve '' porque o parse do import trata '' como ausente; aqui
// devolvemos null, que e o que vai para a coluna `jobs.cidade`. Quem precisa de '' converte
// no ponto de uso (o import faz isso).
//
// ── O QUE ESTA FUNCAO NAO FAZ, E POR QUE ──
// Nao ha fuzzy-match, nem "contem", nem inferencia a partir de `endereco`. A tentacao e
// obvia — daria para varrer "Anita Garibaldi - Joinville-SC" e achar "Joinville" — e e
// exatamente o que nao pode existir aqui: a mesma varredura, aplicada a "Campinas, Sao
// Paulo-SP", acharia "Sao Paulo" e marcaria como Sao Paulo uma vaga de Campinas, com 156
// candidatos atras. Um acerto silencioso e um erro silencioso saem do mesmo codigo, e o
// erro so aparece quando alguem em Campinas recebe convite do grupo de Sao Paulo.
//
// Endereco livre continua livre; quem decide a praca e uma escolha explicita, no seletor ou
// no guard do import. Nao adivinhamos.
function normalizarCidade(valor) {
  return PORCHAVE.get(chave(valor)) || null;
}

module.exports = { CIDADES_VALIDAS, normalizarCidade };
