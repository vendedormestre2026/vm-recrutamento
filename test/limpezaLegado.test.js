'use strict';

// Regras da limpeza pos-importacao (src/lib/limpezaLegado.js): exclusao por empresa e
// backfill de cidade.
//
// ZERO BANCO, ZERO DISCO: o modulo e puro. As regras aqui decidem quem sai da base e que
// cidade cada um recebe — sobre 7 mil pessoas reais, numa execucao unica e irreversivel.
//
// O que cada bloco guarda:
//   exclusao   — comparacao EXATA. 'ClickHero' nao e 'clickhero'; apagar por casamento
//                frouxo levaria junto quem nao devia sair.
//   dicionario — mesma disciplina do DICIONARIO_CARGO da importacao: por tabela, nunca por
//                prefixo/caixa. Empresa nova tem que aparecer como nao mapeada.
//   sentinela  — 'Todas as cidades' e o OPOSTO de NULL, e a confusao entre os dois e
//                exatamente o erro que um filtro de cidade futuro cometeria.
//   ordem      — excluir antes de atualizar: quem sai nao recebe cidade.

const test = require('node:test');
const assert = require('node:assert/strict');

const lim = require('../src/lib/limpezaLegado');

let seq = 0;

// Linha de `talentos` como o script a le.
function linha({ empresa, cidade = null, id } = {}) {
  seq += 1;
  return {
    id: id === undefined ? seq : id,
    email: `pessoa${seq}@exemplo.com`,
    campos_extras:
      empresa === undefined ? null : JSON.stringify({ empresa_origem: empresa, codigo_vaga_origem: 'PS0001' }),
    cidade,
  };
}

// ══════════════════════════════════════════════════════════════
// 1. Exclusao
// ══════════════════════════════════════════════════════════════

test('exclui clickhero e Wings, e so eles', () => {
  const { excluir, relatorio } = lim.planejarLimpeza([
    linha({ empresa: 'clickhero', id: 10 }),
    linha({ empresa: 'Wings', id: 11 }),
    linha({ empresa: 'Febracis', id: 12 }),
  ]);

  assert.deepEqual(excluir.sort((a, b) => a - b), [10, 11]);
  assert.equal(relatorio.excluirPorEmpresa.get('clickhero'), 1);
  assert.equal(relatorio.excluirPorEmpresa.get('Wings'), 1);
});

test('a comparacao de empresa a excluir e EXATA', () => {
  // Casamento frouxo levaria junto quem nao devia sair. Nenhuma destas e clickhero/Wings.
  const { excluir, relatorio } = lim.planejarLimpeza([
    linha({ empresa: 'ClickHero' }),
    linha({ empresa: 'clickhero ' }), // espaco final ja e aparado na leitura
    linha({ empresa: 'wings' }),
    linha({ empresa: 'Wings do Brasil' }),
  ]);
  // 'clickhero ' vira 'clickhero' pelo trim e SAI; as outras tres nao casam.
  assert.equal(excluir.length, 1);
  assert.equal(relatorio.naoMapeados.size, 3, 'as demais viram nao-mapeadas, nao exclusoes');
});

test('quem sai NAO recebe cidade (exclusao antes do backfill)', () => {
  const { excluir, atualizar } = lim.planejarLimpeza([linha({ empresa: 'clickhero', id: 7 })]);
  assert.deepEqual(excluir, [7]);
  assert.equal(atualizar.length, 0, 'UPDATE numa linha que vai ser apagada e trabalho jogado fora');
});

// ══════════════════════════════════════════════════════════════
// 2. Dicionario de cidade
// ══════════════════════════════════════════════════════════════

test('o dicionario mapeia cada grafia de empresa para a cidade certa', () => {
  const esperado = {
    Febracis: 'São Paulo',
    febracis: 'São Paulo',
    'febracis-sp': 'São Paulo',
    'febracis campinas': 'Campinas',
    'Febracis Campinas': 'Campinas',
    'Febracis Floripa': 'Florianópolis',
    'Sua Estética Dental': 'São Paulo',
    Infinity: 'São Paulo',
    'Marketing Labs': 'São Paulo',
    Telekomm: 'Curitiba',
    pinho: 'Tijucas',
    'Pinho Odontologia': 'Tijucas',
    'A Mare': 'Balneário Camboriú',
    'clinica-lsante': 'Jaraguá do Sul',
    matilha: 'Joinville',
    'donna-conecta': 'Joinville',
    'Contadores Digitais': 'Joinville',
    'contadores-digitais': 'Joinville',
    'Godi Transportes': 'Joinville',
    Godi: 'Joinville',
    'H+ Arquitetura': 'Joinville',
    Vaapty: 'Joinville',
    Beehouse: 'Joinville',
    BeeHouse: 'Joinville',
    DAICO: 'Joinville',
    'Mais Martins': 'Joinville',
  };

  for (const [empresa, cidade] of Object.entries(esperado)) {
    const { atualizar } = lim.planejarLimpeza([linha({ empresa })]);
    assert.equal(atualizar.length, 1, `${empresa} deveria receber cidade`);
    assert.equal(atualizar[0].cidade, cidade, `${empresa} -> ${cidade}`);
  }
});

test('o dicionario e case-sensitive e nao casa por prefixo', () => {
  // 'Febracis' e 'febracis' sao entradas SEPARADAS de proposito. Normalizar a caixa antes
  // do lookup reintroduziria o casamento acidental que a tabela evita.
  for (const empresa of ['FEBRACIS', 'Febracis Joinville', 'Godi Transportes LTDA', 'telekomm']) {
    const { atualizar, relatorio } = lim.planejarLimpeza([linha({ empresa })]);
    assert.equal(atualizar.length, 0, `${empresa} nao pode ser mapeada por acaso`);
    assert.equal(relatorio.naoMapeados.get(empresa), 1);
  }
});

test('empresa nao mapeada NAO vira palpite e NAO some — vai para o relatorio', () => {
  const { atualizar, relatorio } = lim.planejarLimpeza([
    linha({ empresa: 'Empresa Nova' }),
    linha({ empresa: 'Empresa Nova' }),
  ]);
  assert.equal(atualizar.length, 0);
  assert.equal(relatorio.naoMapeados.get('Empresa Nova'), 2);
});

// ══════════════════════════════════════════════════════════════
// 3. O valor sentinela
// ══════════════════════════════════════════════════════════════

test('Loureiro recebe o sentinela "Todas as cidades", nao uma cidade e nao NULL', () => {
  const { atualizar } = lim.planejarLimpeza([linha({ empresa: 'Loureiro' })]);
  assert.equal(atualizar.length, 1);
  assert.equal(atualizar[0].cidade, 'Todas as cidades');
  assert.equal(atualizar[0].cidade, lim.CIDADE_TODAS);
});

test('o sentinela e string, jamais NULL — eles significam coisas OPOSTAS', () => {
  // NULL = "nao sei onde essa pessoa esta". Sentinela = "esta em toda parte". Um filtro de
  // cidade futuro trata os dois de forma oposta, e confundi-los e o erro que este teste
  // existe para impedir.
  assert.equal(typeof lim.CIDADE_TODAS, 'string');
  assert.notEqual(lim.CIDADE_TODAS, null);
  assert.ok(lim.CIDADE_TODAS.length > 0);
});

test('o sentinela entra na distribuicao por cidade como qualquer outra', () => {
  const { relatorio } = lim.planejarLimpeza([
    linha({ empresa: 'Loureiro' }),
    linha({ empresa: 'Loureiro' }),
    linha({ empresa: 'Telekomm' }),
  ]);
  assert.equal(relatorio.porCidade.get(lim.CIDADE_TODAS), 2);
  assert.equal(relatorio.porCidade.get('Curitiba'), 1);
});

// ══════════════════════════════════════════════════════════════
// 4. Ausencias e dados tortos
// ══════════════════════════════════════════════════════════════

test('sem empresa_origem: fica sem cidade e e contado, sem virar nao-mapeado', () => {
  const { atualizar, relatorio } = lim.planejarLimpeza([
    linha({ empresa: '' }),
    linha({ empresa: '   ' }),
    linha({}), // campos_extras null
    { id: 99, email: 'x@x.com', campos_extras: '{}', cidade: null },
  ]);
  assert.equal(atualizar.length, 0);
  assert.equal(relatorio.semEmpresa, 4);
  assert.equal(relatorio.naoMapeados.size, 0, '"sem empresa" e diferente de "empresa desconhecida"');
});

test('campos_extras com JSON invalido nao derruba a limpeza', () => {
  // Uma linha torta nao pode impedir as outras 7 mil de serem processadas.
  const { relatorio } = lim.planejarLimpeza([
    { id: 1, email: 'a@x.com', campos_extras: '{isso nao e json', cidade: null },
    linha({ empresa: 'Telekomm' }),
  ]);
  assert.equal(relatorio.semEmpresa, 1);
  assert.equal(relatorio.porCidade.get('Curitiba'), 1, 'a linha boa segue processada');
});

test('empresaOrigemDe nunca lanca', () => {
  for (const v of [null, undefined, '', '{', '[]', '"texto"', '{"outra":1}', 123]) {
    assert.doesNotThrow(() => lim.empresaOrigemDe(v));
    assert.equal(typeof lim.empresaOrigemDe(v), 'string');
  }
});

test('entrada vazia devolve planos vazios sem quebrar', () => {
  const { excluir, atualizar, relatorio } = lim.planejarLimpeza([]);
  assert.deepEqual(excluir, []);
  assert.deepEqual(atualizar, []);
  assert.equal(relatorio.lidos, 0);
  assert.deepEqual(lim.planejarLimpeza().excluir, []);
});

// ══════════════════════════════════════════════════════════════
// 5. Idempotencia
// ══════════════════════════════════════════════════════════════

test('quem JA tem a cidade certa nao entra no plano de update', () => {
  const { atualizar, relatorio } = lim.planejarLimpeza([
    linha({ empresa: 'Telekomm', cidade: 'Curitiba' }),
    linha({ empresa: 'Telekomm', cidade: null }),
  ]);
  assert.equal(atualizar.length, 1, 'so a que falta');
  assert.equal(relatorio.jaCorretos, 1);
  assert.equal(relatorio.aAtualizar, 1);
});

test('cidade ERRADA e corrigida, nao preservada', () => {
  // Se um backfill anterior gravou errado (dicionario corrigido depois), a segunda passada
  // conserta. "Idempotente" e convergir para o estado certo, nao "nunca escrever de novo".
  const { atualizar } = lim.planejarLimpeza([linha({ empresa: 'Telekomm', cidade: 'Joinville' })]);
  assert.equal(atualizar.length, 1);
  assert.equal(atualizar[0].cidade, 'Curitiba');
});

test('rodar sobre uma base ja limpa produz plano vazio', () => {
  const jaLimpa = [
    linha({ empresa: 'Telekomm', cidade: 'Curitiba' }),
    linha({ empresa: 'Loureiro', cidade: 'Todas as cidades' }),
    linha({ empresa: 'Godi', cidade: 'Joinville' }),
  ];
  const { excluir, atualizar, relatorio } = lim.planejarLimpeza(jaLimpa);
  assert.deepEqual(excluir, []);
  assert.deepEqual(atualizar, []);
  assert.equal(relatorio.jaCorretos, 3);
});
