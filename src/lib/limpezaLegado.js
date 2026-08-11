'use strict';

// Regras da limpeza pos-importacao da base legada: quem sai, e que cidade cada um recebe.
//
// ── MODULO PURO: NAO TOCA O BANCO ──
// Recebe as linhas ja lidas de `talentos` e devolve os dois planos (exclusoes e updates)
// mais um relatorio. Quem consulta e quem grava e o script
// (src/scripts/limpeza-legado.js). Mesma separacao de lib/importarLegado: as REGRAS sao
// testaveis sem banco, e sao elas que decidem o que acontece com 7 mil pessoas reais.
//
// A unica dependencia e nenhuma. Modulo folha.

// ── Empresas a REMOVER da base ──
//
// clickhero: pedido do Rafael antes da importacao. Wings: teste dele mesmo.
// Comparacao EXATA, como todo o resto deste modulo — ver a nota do dicionario abaixo.
const EMPRESAS_A_EXCLUIR = new Set(['clickhero', 'Wings']);

// ── Valor SENTINELA de cidade ──
//
// 'Todas as cidades' NAO e "sem cidade". Marca presenca ativa em qualquer praca — hoje so
// a Loureiro, que atende o estado inteiro. A distincao importa para o filtro de cidade que
// vem depois: NULL e "nao sei onde essa pessoa esta" (fica de fora de um recorte por
// cidade, salvo flag explicita), enquanto o sentinela e "esta em toda parte" e deve casar
// com QUALQUER cidade selecionada, sem depender de checkbox nenhum.
//
// String literal e nao NULL, e nao um booleano separado, porque o valor precisa sobreviver
// legivel no banco e na tela: quem abrir o registro no painel le "Todas as cidades" e
// entende, sem consultar documentacao.
const CIDADE_TODAS = 'Todas as cidades';

// ── Dicionario empresa_origem -> cidade ──
//
// Chave = o valor EXATO como veio do CSV, incluindo caixa e grafia inconsistente
// ('Febracis' e 'febracis' sao entradas separadas; 'Godi' e 'Godi Transportes' tambem).
// Nada de normalizar caixa nem casar por prefixo: e a mesma disciplina do DICIONARIO_CARGO
// em lib/importarLegado, e pela mesma razao — um valor novo num export futuro tem que
// APARECER como nao mapeado, nunca ser absorvido por uma heuristica que casou por acaso.
//
// Cada empresa da base antiga atendia uma praca so, e e isso que torna a derivacao valida.
const DICIONARIO_CIDADE = new Map([
  ['Febracis', 'São Paulo'],
  ['febracis', 'São Paulo'],
  ['febracis-sp', 'São Paulo'],
  ['febracis campinas', 'Campinas'],
  ['Febracis Campinas', 'Campinas'],
  ['Febracis Floripa', 'Florianópolis'],
  ['Sua Estética Dental', 'São Paulo'],
  ['Infinity', 'São Paulo'],
  ['Marketing Labs', 'São Paulo'],
  ['Telekomm', 'Curitiba'],
  ['pinho', 'Tijucas'],
  ['Pinho Odontologia', 'Tijucas'],
  ['A Mare', 'Balneário Camboriú'],
  ['clinica-lsante', 'Jaraguá do Sul'],
  ['matilha', 'Joinville'],
  ['donna-conecta', 'Joinville'],
  ['Contadores Digitais', 'Joinville'],
  ['contadores-digitais', 'Joinville'],
  ['Godi Transportes', 'Joinville'],
  ['Godi', 'Joinville'],
  ['H+ Arquitetura', 'Joinville'],
  ['Vaapty', 'Joinville'],
  ['Beehouse', 'Joinville'],
  ['BeeHouse', 'Joinville'],
  ['DAICO', 'Joinville'],
  ['Mais Martins', 'Joinville'],
  // Caso especial: presenca em qualquer praca. Ver CIDADE_TODAS.
  ['Loureiro', CIDADE_TODAS],
]);

// Le empresa_origem de um campos_extras que pode ser JSON invalido, null ou string vazia.
// NUNCA lanca: um JSON torto numa linha nao pode derrubar a limpeza inteira — a linha vira
// "sem empresa" e aparece no relatorio.
function empresaOrigemDe(camposExtrasJson) {
  if (!camposExtrasJson) return '';
  let obj;
  try {
    obj = JSON.parse(camposExtrasJson);
  } catch {
    return '';
  }
  if (!obj || typeof obj !== 'object') return '';
  return String(obj.empresa_origem == null ? '' : obj.empresa_origem).trim();
}

// Monta os dois planos a partir das linhas de `talentos` com categoria='legado'.
//
//   linhas: [{ id, email, campos_extras, cidade }]
//
// Devolve { excluir: [id], atualizar: [{ id, cidade }], relatorio }.
//
// ── ORDEM: EXCLUIR ANTES DE ATUALIZAR ──
// Quem sai nao precisa de cidade. Alem de inutil, um UPDATE numa linha que vai ser apagada
// em seguida gastaria escrita e poluiria a contagem de "quantos receberam cidade".
//
// ── IDEMPOTENCIA ──
// `atualizar` traz SO quem ainda nao tem a cidade certa. Rodar duas vezes produz um plano
// vazio na segunda — e o relatorio mostra isso como "ja corretos", nao como trabalho feito.
function planejarLimpeza(linhas) {
  const relatorio = {
    lidos: 0,
    excluirPorEmpresa: new Map(), // empresa -> qtd
    aAtualizar: 0,
    jaCorretos: 0,
    porCidade: new Map(), // cidade -> qtd (do resultado final, nao so dos atualizados)
    semEmpresa: 0,
    naoMapeados: new Map(), // empresa -> qtd  ← exige decisao humana
  };

  const inc = (mapa, chave) => mapa.set(chave, (mapa.get(chave) || 0) + 1);

  const excluir = [];
  const atualizar = [];

  for (const linha of linhas || []) {
    relatorio.lidos += 1;
    const empresa = empresaOrigemDe(linha.campos_extras);

    // 1. Exclusao primeiro.
    if (EMPRESAS_A_EXCLUIR.has(empresa)) {
      inc(relatorio.excluirPorEmpresa, empresa);
      excluir.push(linha.id);
      continue;
    }

    // 2. Sem empresa nao ha de onde derivar cidade. Nao e erro: fica NULL e e contado.
    if (!empresa) {
      relatorio.semEmpresa += 1;
      continue;
    }

    // 3. Empresa desconhecida NAO vira palpite. Vai para o relatorio e a linha fica sem
    //    cidade — mesma politica de "cargo nao mapeado" na importacao.
    if (!DICIONARIO_CIDADE.has(empresa)) {
      inc(relatorio.naoMapeados, empresa);
      continue;
    }

    const cidade = DICIONARIO_CIDADE.get(empresa);
    inc(relatorio.porCidade, cidade);

    if (linha.cidade === cidade) {
      relatorio.jaCorretos += 1;
      continue;
    }
    relatorio.aAtualizar += 1;
    atualizar.push({ id: linha.id, cidade });
  }

  return { excluir, atualizar, relatorio };
}

module.exports = {
  planejarLimpeza,
  empresaOrigemDe,
  EMPRESAS_A_EXCLUIR,
  DICIONARIO_CIDADE,
  CIDADE_TODAS,
};
