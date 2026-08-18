'use strict';

// Vocabulario de pracas (src/lib/cidades.js) — lido da tabela `cidades` desde a ETAPA B,
// Incremento 4 (era um array congelado ate aqui; ver o comentario no topo do proprio
// lib/cidades.js para o porque da migracao).
//
// ── O QUE ESTA EM JOGO ──
// Esta lista decide a praca de uma vaga, e a praca decide quem entra num disparo regional.
// Um falso positivo aqui manda convite de grupo de Sao Paulo para quem esta em Campinas —
// erro que so aparece do lado de fora, na conversa de alguem.
//
// O risco concreto e a TENTACAO DE ADIVINHAR. `jobs.endereco` e texto livre e contem os
// nomes das cidades ("Anita Garibaldi - Joinville-SC"), entao um "contem" resolveria varios
// casos — e erraria "Campinas, Sao Paulo-SP", que e uma vaga de Campinas com 156 candidatos
// e o literal "Sao Paulo" dentro. Os testes de recusa abaixo existem para que nenhuma
// "melhoria" futura transforme esta funcao num matcher.
//
// ── POR QUE HTTP/DB, e nao mais so-unidade ──
// A migracao trocou "array no codigo" por "tabela no banco": os testes agora precisam de um
// banco de verdade (migrar() semeia as 9 pracas originais, ver migrate.js), igual ao padrao
// ja usado por vagaCidade.test.js.

const os = require('node:os');
const path = require('node:path');

process.env.DATABASE_PATH = path.join(os.tmpdir(), `vm-test-cidades-${process.pid}-${Date.now()}.db`);

const test = require('node:test');
const assert = require('node:assert/strict');

const { migrar } = require('../src/db/migrate');
const { listarCidadesValidas, normalizarCidade, chave } = require('../src/lib/cidades');

migrar();

test('o seed cobre exatamente as 9 pracas do enum, em ordem pt-BR', () => {
  assert.deepEqual(listarCidadesValidas(), [
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
  // Mesma ordem de db.listarCidadesDistintas — as duas aparecem lado a lado em tela.
  assert.deepEqual(
    listarCidadesValidas(),
    [...listarCidadesValidas()].sort((a, b) => a.localeCompare(b, 'pt-BR')),
  );
});

test('cidade cadastrada pelo admin aparece na proxima chamada, sem reiniciar o processo', () => {
  // Nao ha cache: e o proprio ponto da migracao (Incremento 4/5) — congelar isto de novo
  // (mesmo que num Map local, em vez de Object.freeze) reintroduziria o problema que motivou
  // trocar array por tabela. Insercao direta no banco so para simular "cidade ja cadastrada"
  // sem depender do fluxo de admin (fora de escopo deste arquivo).
  const antes = listarCidadesValidas();
  assert.equal(antes.includes('Chapecó'), false);

  const db = require('../src/db');
  db.getDb().prepare('INSERT INTO cidades (nome, chave) VALUES (?, ?)').run('Chapecó', chave('Chapecó'));

  const depois = listarCidadesValidas();
  assert.equal(depois.includes('Chapecó'), true);
  assert.equal(normalizarCidade('chapeco'), 'Chapecó');

  // Limpeza: nao vazar para os testes seguintes deste arquivo.
  db.getDb().prepare('DELETE FROM cidades WHERE chave = ?').run(chave('Chapecó'));
});

test('a chave normalizada e UNIQUE — duas grafias da mesma cidade nao podem virar duas linhas', () => {
  // Este e o ponto central da migracao: o array congelado impedia "Sao Jose" e "São José"
  // de coexistirem porque so havia UMA edicao de codigo possivel. A tabela precisa da MESMA
  // garantia, agora como constraint de banco — e' `chave` que carrega o UNIQUE, nao `nome`
  // (ver schema.sql), exatamente para barrar duas grafias da mesma praca.
  const db = require('../src/db');
  const conn = db.getDb();
  conn.prepare('INSERT INTO cidades (nome, chave) VALUES (?, ?)').run('Chapeco Teste', chave('Chapeco Teste'));
  assert.throws(
    () => conn.prepare('INSERT INTO cidades (nome, chave) VALUES (?, ?)').run('Chapecó Teste', chave('Chapecó Teste')),
    /UNIQUE/,
  );
  conn.prepare('DELETE FROM cidades WHERE chave = ?').run(chave('Chapeco Teste'));
});

test('o sentinela de talento NAO e uma praca de vaga', () => {
  // 'Todas as cidades' marca uma PESSOA presente em qualquer praca (531 no legado). Uma
  // vaga acontece em um lugar ou e remota. Aceita-lo aqui faria uma vaga presencial entrar
  // em todo disparo regional.
  assert.equal(listarCidadesValidas().includes('Todas as cidades'), false);
  assert.equal(normalizarCidade('Todas as cidades'), null);
});

test('todo valor canonico normaliza para si mesmo', () => {
  // Idempotencia: reeditar uma vaga ja salva nao pode perder a cidade.
  for (const c of listarCidadesValidas()) assert.equal(normalizarCidade(c), c);
});

test('caixa e espaco nas bordas nao invalidam', () => {
  assert.equal(normalizarCidade('joinville'), 'Joinville');
  assert.equal(normalizarCidade('JOINVILLE'), 'Joinville');
  assert.equal(normalizarCidade('  Joinville  '), 'Joinville');
});

test('acento ausente normaliza para o canonico ACENTUADO', () => {
  // Sete das nove pracas tem acento, e a origem mais provavel do valor e um LLM redigindo a
  // partir de briefing, onde "Sao Paulo" e grafia corrente. Recusar por causa de um til
  // transformaria erro de digitacao em ausencia de dado. O que volta e sempre o canonico.
  assert.equal(normalizarCidade('sao paulo'), 'São Paulo');
  assert.equal(normalizarCidade('SAO PAULO'), 'São Paulo');
  assert.equal(normalizarCidade('balneario camboriu'), 'Balneário Camboriú');
  assert.equal(normalizarCidade('Florianopolis'), 'Florianópolis');
  assert.equal(normalizarCidade('jaragua do sul'), 'Jaraguá do Sul');
});

test('NAO faz fuzzy-match nem le endereco — enum fechado de verdade', () => {
  // Estes sao os enderecos REAIS das vagas em producao. Todos contem um nome de praca, e
  // NENHUM pode ser aceito: se esta funcao passasse a "encontrar" a cidade dentro do
  // endereco, ela acertaria os quatro primeiros e erraria o ultimo — e o ultimo tem 156
  // candidatos atras.
  for (const endereco of [
    'Anita Garibaldi - Joinville-SC',
    'Anita Garibaldi - Joinville/SC',
    'Joinville, SC (bairro Bom Retiro)',
    'Unidade Santo Antônio - Joinville',
    'São Paulo – Cidade Monções',
    'Alphaville Empresarial Barueri-SP',
    'Campinas, São Paulo-SP', // <- vaga de CAMPINAS contendo o literal "São Paulo"
  ]) {
    assert.equal(normalizarCidade(endereco), null, endereco);
  }
});

test('cidade fora da lista e recusada, e nao inventada', () => {
  // Cadastrar praca e acao deliberada (admin, Incremento 5). Aceitar aqui seria o campo
  // livre de volta, com outro nome.
  assert.equal(normalizarCidade('Blumenau'), null);
  assert.equal(normalizarCidade('Joinvile'), null, 'erro de digitacao nao vira acerto');
  assert.equal(normalizarCidade('Joinville/SC'), null, 'sufixo de UF nao e o canonico');
});

test('entrada degenerada devolve null sem lancar', () => {
  // Roda no parse de um POST de formulario e na leitura de um JSON de LLM: os dois podem
  // entregar qualquer coisa, e lancar ali viraria 500 numa tela de cadastro.
  for (const v of [null, undefined, '', '   ', 123, {}, [], true, NaN]) {
    assert.doesNotThrow(() => normalizarCidade(v));
    assert.equal(normalizarCidade(v), null);
  }
});
