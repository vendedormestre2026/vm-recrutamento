'use strict';

// Fundacao de dados da importacao da base legada: as tres colunas novas de `talentos`
// (categoria, cargo, campos_extras).
//
// POR QUE TESTAR SCHEMA AQUI: `talentos` e a PRIMEIRA tabela do projeto a receber colunas
// por migracao incremental depois de ja existir em producao. O CREATE TABLE IF NOT EXISTS
// do schema.sql nao altera tabela criada — se alguem adicionar uma coluna nova so la e
// esquecer o adicionarColunaSeFaltar em migrate.js, o banco novo (e o de teste, e o de
// desenvolvimento) tem a coluna e SO PRODUCAO nao tem. O erro aparece no primeiro INSERT
// da importacao, contra o banco que importa. Este arquivo e o que torna esse esquecimento
// impossivel de passar despercebido.
//
// A OUTRA metade do que ele guarda: as tres colunas precisam continuar NULLABLE e SEM
// CHECK. Nullable porque os ~550 talentos ja cadastrados via /bancodecurriculos ficam com
// as tres em NULL e nao serao migrados retroativamente; sem CHECK porque o SQLite nao
// remove constraint depois — um CHECK aqui so sairia recriando a tabela.
//
// NENHUMA REDE: so schema. Os INSERTs usam SQL direto de proposito, porque e exatamente a
// camada do banco que esta sob teste (mesma decisao de promocao-schema.test.js).

const os = require('node:os');
const path = require('node:path');

process.env.DATABASE_PATH = path.join(os.tmpdir(), `vm-test-talentos-schema-${process.pid}-${Date.now()}.db`);
process.env.INTERVIEW_MOCK = 'true';
process.env.SESSION_SECRET = 'segredo-de-teste';
process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert/strict');

const db = require('../src/db');
const { migrar } = require('../src/db/migrate');

migrar(); // a tabela precisa existir antes de qualquer coisa

const COLUNAS_NOVAS = ['categoria', 'cargo', 'campos_extras'];

// pragma_table_info devolve uma linha por coluna: { name, type, notnull, dflt_value, pk }.
const colunasDeTalentos = () =>
  db.getDb().prepare('SELECT * FROM pragma_table_info(?)').all('talentos');

const coluna = (nome) => colunasDeTalentos().find((c) => c.name === nome);

// ── 1. As tres colunas existem ──

test('migrar() adiciona categoria, cargo e campos_extras em talentos', () => {
  for (const nome of COLUNAS_NOVAS) {
    assert.ok(coluna(nome), `coluna ausente em talentos: ${nome}`);
  }
});

test('as tres colunas novas sao TEXT', () => {
  for (const nome of COLUNAS_NOVAS) {
    assert.equal(coluna(nome).type, 'TEXT', `${nome} deveria ser TEXT`);
  }
});

// ── 2. Nullable e sem default ──

test('as tres colunas novas sao NULLABLE e sem default', () => {
  // NOT NULL sem default quebraria a importacao (7.215 linhas sem esse dado na origem) e,
  // pior, quebraria o cadastro normal de /bancodecurriculos, que nao preenche nenhuma das
  // tres. Default tambem nao: NULL tem significado proprio aqui ("nao e legado").
  for (const nome of COLUNAS_NOVAS) {
    const c = coluna(nome);
    assert.equal(c.notnull, 0, `${nome} nao pode ser NOT NULL`);
    assert.equal(c.dflt_value, null, `${nome} nao pode ter default`);
  }
});

// ── 3. Sem CHECK: a validacao de categoria/cargo mora no app ──

test('nenhuma das colunas novas tem CHECK no banco', () => {
  // O SQLite nao expoe constraints em pragma; o DDL cru e a fonte. O CHECK que EXISTE na
  // tabela (status, perfil_interesse) continua la — o que nao pode aparecer e um CHECK
  // mencionando as colunas novas.
  const ddl = db
    .getDb()
    .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'talentos'")
    .get().sql;

  for (const nome of COLUNAS_NOVAS) {
    assert.doesNotMatch(
      ddl,
      new RegExp(`CHECK\\s*\\([^)]*\\b${nome}\\b`, 'i'),
      `${nome} nao deve ter CHECK: SQLite nao remove constraint depois`,
    );
  }

  // Sanidade do proprio teste: os CHECK que sempre existiram continuam de pe. Sem isto, um
  // schema que perdesse TODOS os CHECK passaria nas assercoes acima.
  assert.match(ddl, /CHECK\s*\(\s*perfil_interesse/i, 'o CHECK de perfil_interesse continua');
  assert.match(ddl, /CHECK\s*\(\s*status/i, 'o CHECK de status continua');
});

test('categoria e cargo aceitam qualquer texto (validacao e no app, nao no banco)', () => {
  // Os seis cargos e a categoria 'legado' precisam entrar sem constraint reclamando. Um
  // valor absurdo tambem entra — e isso e o desenho, nao um furo: a allowlist vive em JS.
  assert.doesNotThrow(() =>
    db
      .getDb()
      .prepare("INSERT INTO talentos (email, categoria, cargo) VALUES (?, 'legado', ?)")
      .run('cargo-livre@exemplo.com', 'Lideranca Comercial'),
  );
});

// ── 4. O cadastro existente nao foi afetado ──

test('talento sem as colunas novas continua valido, com as tres em NULL', () => {
  // O caminho de /bancodecurriculos (db.criarTalento) nao preenche nenhuma das tres. Se
  // alguma tivesse virado obrigatoria, o cadastro publico quebraria — e o sintoma seria um
  // 500 no formulario, nao um erro na importacao.
  const id = Number(
    db
      .getDb()
      .prepare("INSERT INTO talentos (nome, email, perfil_interesse) VALUES (?, ?, 'CLOSER')")
      .run('Talento Normal', 'normal@exemplo.com').lastInsertRowid,
  );

  const linha = db.getDb().prepare('SELECT * FROM talentos WHERE id = ?').get(id);
  assert.equal(linha.categoria, null);
  assert.equal(linha.cargo, null);
  assert.equal(linha.campos_extras, null);
  // E o que sempre valeu continua valendo: status default e criado_em preenchido.
  assert.equal(linha.status, 'novo');
  assert.ok(linha.criado_em, 'criado_em continua com default');
});

// ── 5. Idempotencia ──

test('migrar() roda de novo sem erro e sem duplicar coluna', () => {
  // adicionarColunaSeFaltar checa pragma_table_info antes do ALTER. Um segundo ADD COLUMN
  // do mesmo nome seria erro de SQL — e migrar() roda no boot de TODO deploy.
  assert.doesNotThrow(() => migrar());

  for (const nome of COLUNAS_NOVAS) {
    const ocorrencias = colunasDeTalentos().filter((c) => c.name === nome).length;
    assert.equal(ocorrencias, 1, `${nome} apareceu ${ocorrencias} vezes apos migrar() duas vezes`);
  }
});
