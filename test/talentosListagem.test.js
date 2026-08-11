'use strict';

// Paginacao e filtros da listagem de talentos (db.listarTalentos / db.contarTalentos).
//
// POR QUE ESTE ARQUIVO EXISTE: a tela nasceu sem paginacao, quando `talentos` tinha zero
// linha. A importacao da base legada a levou a 7.215 de uma vez — ~3 MB de HTML numa
// requisicao. O que este arquivo guarda e que a pagina volte a crescer sem limite: se
// alguem remover o LIMIT "porque estava atrapalhando um teste", o primeiro teste abaixo
// quebra.
//
// A OUTRA metade: `contarTalentos` e o DENOMINADOR da paginacao. Se ele contar sobre um
// recorte diferente do que a tabela exibe, a tela diz "Pagina 3 de 7" e mostra vazio. Por
// isso os dois compartilham condicoesFiltroTalentos, e os testes conferem os dois juntos
// em cada cenario de filtro.

const os = require('node:os');
const path = require('node:path');

process.env.DATABASE_PATH = path.join(os.tmpdir(), `vm-test-talentos-lista-${process.pid}-${Date.now()}.db`);
process.env.INTERVIEW_MOCK = 'true';
process.env.SESSION_SECRET = 'segredo-de-teste';
process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert/strict');

const db = require('../src/db');
const { migrar } = require('../src/db/migrate');

migrar();

const run = (sql, ...p) => db.getDb().prepare(sql).run(...p);

// ── Cenario, montado UMA vez ──
// 30 legados (mais que uma pagina, de proposito: 25 + 5) e 4 de cadastro proprio.
// `criado_em` decrescente e controlado para a ordenacao ser verificavel.
const TOTAL_LEGADO = 30;
const TOTAL_PROPRIO = 4;

for (let i = 0; i < TOTAL_LEGADO; i++) {
  run(
    `INSERT INTO talentos (nome, email, perfil_interesse, categoria, cargo, status, criado_em)
     VALUES (?, ?, ?, 'legado', ?, ?, ?)`,
    `Legado ${i}`,
    `legado${String(i).padStart(2, '0')}@exemplo.com`,
    i % 3 === 0 ? 'SDR' : null, // 10 com perfil, 20 sem — espelha a base real
    i % 2 === 0 ? 'Vendedor' : 'Consultor Comercial',
    i === 0 ? 'descartado' : 'novo',
    `2025-01-${String(31 - i).padStart(2, '0')} 10:00:00`,
  );
}
for (let i = 0; i < TOTAL_PROPRIO; i++) {
  // Sem `categoria` — e exatamente o que criarTalento faz (a coluna nem entra no INSERT).
  db.criarTalento({
    nome: `Proprio ${i}`,
    email: `proprio${i}@exemplo.com`,
    perfil_interesse: 'CLOSER',
  });
}

const TOTAL_GERAL = TOTAL_LEGADO + TOTAL_PROPRIO;

// ══════════════════════════════════════════════════════════════
// 1. Paginacao
// ══════════════════════════════════════════════════════════════

test('a pagina tem no maximo TALENTOS_POR_PAGINA linhas', () => {
  const p1 = db.listarTalentos({});
  assert.equal(p1.length, db.TALENTOS_POR_PAGINA);
  assert.equal(db.TALENTOS_POR_PAGINA, 25, 'mesmo tamanho do painel de candidatos');
});

test('a segunda pagina traz o RESTO, e nao repete ninguem da primeira', () => {
  const p1 = db.listarTalentos({ pagina: 1 });
  const p2 = db.listarTalentos({ pagina: 2 });

  assert.equal(p2.length, TOTAL_GERAL - db.TALENTOS_POR_PAGINA);

  const ids1 = new Set(p1.map((t) => t.id));
  for (const t of p2) {
    assert.ok(!ids1.has(t.id), `id ${t.id} apareceu nas duas paginas`);
  }
  assert.equal(new Set([...p1, ...p2].map((t) => t.id)).size, TOTAL_GERAL);
});

test('pagina alem da ultima devolve vazio, e nao erro', () => {
  // A tela cobre isso com a mensagem de lista vazia que ja existia. Redirect ou 404 aqui
  // seria pior: quem chegou por URL na mao perderia os filtros.
  assert.deepEqual(db.listarTalentos({ pagina: 999 }), []);
});

test('pagina invalida cai em 1, nunca em erro nem em OFFSET negativo', () => {
  const p1 = db.listarTalentos({ pagina: 1 });
  for (const lixo of [0, -5, 'abc', null, undefined, 1.5, NaN]) {
    const r = db.listarTalentos({ pagina: lixo });
    assert.equal(r.length, p1.length, `pagina=${JSON.stringify(lixo)} deveria cair na 1`);
    assert.equal(r[0].id, p1[0].id);
  }
});

test('a ordenacao continua por criado_em DESC atravessando as paginas', () => {
  const todos = [...db.listarTalentos({ pagina: 1 }), ...db.listarTalentos({ pagina: 2 })];
  for (let i = 1; i < todos.length; i++) {
    assert.ok(
      todos[i - 1].criado_em >= todos[i].criado_em,
      'a lista tem que ficar decrescente inclusive na virada de pagina',
    );
  }
});

// ══════════════════════════════════════════════════════════════
// 2. Contagem — o denominador da paginacao
// ══════════════════════════════════════════════════════════════

test('contarTalentos devolve o total REAL, nao o tamanho da pagina', () => {
  assert.equal(db.contarTalentos({}), TOTAL_GERAL);
  assert.ok(TOTAL_GERAL > db.TALENTOS_POR_PAGINA, 'sanidade: o cenario tem mais de uma pagina');
});

test('contarTalentos IGNORA `pagina` — paginacao e recorte de exibicao, nao filtro', () => {
  assert.equal(db.contarTalentos({ pagina: 2 }), TOTAL_GERAL);
  assert.equal(db.contarTalentos({ pagina: 999 }), TOTAL_GERAL);
});

// ══════════════════════════════════════════════════════════════
// 3. Filtro por categoria
// ══════════════════════════════════════════════════════════════

test("categoria='legado' traz so os importados", () => {
  assert.equal(db.contarTalentos({ categoria: 'legado' }), TOTAL_LEGADO);
  for (const t of db.listarTalentos({ categoria: 'legado' })) {
    assert.equal(t.categoria, 'legado');
  }
});

test('o sentinela de cadastro proprio traz so quem tem categoria NULL', () => {
  // 'proprio' NAO existe no banco: e um valor de apresentacao, para o formulario poder
  // pedir "os que nao tem categoria" numa query string.
  assert.equal(db.CATEGORIA_FILTRO_PROPRIO, 'proprio');

  const proprios = db.listarTalentos({ categoria: db.CATEGORIA_FILTRO_PROPRIO });
  assert.equal(db.contarTalentos({ categoria: db.CATEGORIA_FILTRO_PROPRIO }), TOTAL_PROPRIO);
  assert.equal(proprios.length, TOTAL_PROPRIO);
  for (const t of proprios) assert.equal(t.categoria, null);
});

test('os dois filtros de categoria sao complementares e cobrem a base inteira', () => {
  const legado = db.contarTalentos({ categoria: 'legado' });
  const proprio = db.contarTalentos({ categoria: db.CATEGORIA_FILTRO_PROPRIO });
  assert.equal(legado + proprio, db.contarTalentos({}), 'ninguem pode ficar fora dos dois');
});

test('categoria invalida = filtro INATIVO (convencao do projeto), nunca erro', () => {
  for (const lixo of ['inventada', '', null, undefined, 'LEGADO', 123]) {
    assert.equal(
      db.contarTalentos({ categoria: lixo }),
      TOTAL_GERAL,
      `categoria=${JSON.stringify(lixo)} deveria ser ignorada, nao filtrar`,
    );
  }
});

// ══════════════════════════════════════════════════════════════
// 4. Os filtros antigos continuam valendo, e combinam com o novo
// ══════════════════════════════════════════════════════════════

test('filtros de perfil e status seguem funcionando', () => {
  const comPerfil = db.contarTalentos({ perfil: 'SDR' });
  assert.equal(comPerfil, 10, '1 a cada 3 dos 30 legados');
  assert.equal(db.contarTalentos({ status: 'descartado' }), 1);
});

test('categoria COMBINA com os outros filtros (AND, nao OR)', () => {
  // Os 4 proprios sao CLOSER; nenhum legado e. A combinacao tem que dar zero.
  assert.equal(db.contarTalentos({ categoria: 'legado', perfil: 'CLOSER' }), 0);
  assert.deepEqual(db.listarTalentos({ categoria: 'legado', perfil: 'CLOSER' }), []);

  // E a combinacao que existe tem que bater.
  assert.equal(db.contarTalentos({ categoria: 'legado', perfil: 'SDR' }), 10);
});

test('lista e contagem concordam sob o MESMO filtro (o bug do "Pagina 3 de 7" vazio)', () => {
  // Se um dia listarTalentos e contarTalentos deixarem de compartilhar a clausula, este
  // teste e o que grita — antes de a tela mostrar navegacao para paginas inexistentes.
  for (const filtros of [
    {},
    { categoria: 'legado' },
    { categoria: db.CATEGORIA_FILTRO_PROPRIO },
    { perfil: 'SDR' },
    { status: 'novo' },
    { categoria: 'legado', status: 'novo' },
  ]) {
    const total = db.contarTalentos(filtros);
    const paginas = Math.max(1, Math.ceil(total / db.TALENTOS_POR_PAGINA));
    let somadas = 0;
    for (let p = 1; p <= paginas; p++) somadas += db.listarTalentos({ ...filtros, pagina: p }).length;
    assert.equal(somadas, total, `divergencia com ${JSON.stringify(filtros)}`);
  }
});
