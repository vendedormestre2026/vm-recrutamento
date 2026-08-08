'use strict';

// Fundacao de dados da Promocao de Vagas (src/db/schema.sql): as tres tabelas novas
// (campanhas, campanha_envios, descadastros) e os tres indices.
//
// POR QUE TESTAR SCHEMA: as constraints deste subsistema nao sao higiene de dados — sao
// as salvaguardas de um sistema que manda e-mail para fora. O UNIQUE(campanha_id, email)
// e a ULTIMA linha de defesa contra a mesma pessoa receber a mesma campanha duas vezes, e
// os CHECK de enum sao o que impede um status digitado errado virar um estado valido no
// banco. Nada disso e exercitado por um teste de logica de negocio; se alguem "limpar" o
// schema, o dano so apareceria em producao, num e-mail ja enviado, sem desfazer.
//
// NENHUMA REDE, NENHUM ENVIO: este incremento e so schema. Nao existe ainda funcao de
// acesso a estas tabelas — os INSERTs abaixo usam SQL direto de proposito, porque e
// exatamente a camada do banco que esta sob teste.
//
// migrar() roda ANTES de qualquer assercao, igual aos demais testes: as tabelas precisam
// existir de verdade, senao tudo falharia por "no such table" — um falso vermelho que
// esconderia o que esta sendo verificado.

const os = require('node:os');
const path = require('node:path');

process.env.DATABASE_PATH = path.join(os.tmpdir(), `vm-test-promocao-schema-${process.pid}-${Date.now()}.db`);
process.env.INTERVIEW_MOCK = 'true';
process.env.SESSION_SECRET = 'segredo-de-teste';
process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert/strict');

const db = require('../src/db');
const { migrar } = require('../src/db/migrate');

migrar(); // as tabelas precisam existir antes de qualquer coisa

// ── Helpers ──
const run = (sql, ...p) => Number(db.getDb().prepare(sql).run(...p).lastInsertRowid);

const existeNoSqliteMaster = (tipo, nome) =>
  Boolean(
    db
      .getDb()
      .prepare('SELECT name FROM sqlite_master WHERE type = ? AND name = ?')
      .get(tipo, nome),
  );

// Vaga real: campanhas.job_id tem FK para jobs(id) e o pragma foreign_keys esta ON
// (sqlite.js), entao um id inventado seria rejeitado antes de chegar na constraint que
// cada teste quer exercitar.
const vagaId = run(
  "INSERT INTO jobs (slug, titulo, perfil) VALUES ('vaga-promocao', 'Closer de Vendas', 'CLOSER')",
);

let seq = 0;

// Cria uma campanha valida (status cai no default 'rascunho'). Cada teste que precisa de
// uma campanha cria a SUA: o UNIQUE(campanha_id, email) e por campanha, e reaproveitar a
// mesma entre testes faria um teste contaminar o outro.
function criarCampanha(campos = {}) {
  seq += 1;
  return run(
    `INSERT INTO campanhas (job_id, assunto, corpo_html, criterios, status)
     VALUES (?, ?, ?, ?, COALESCE(?, 'rascunho'))`,
    campos.job_id === undefined ? vagaId : campos.job_id,
    campos.assunto === undefined ? `Vaga aberta ${seq}` : campos.assunto,
    campos.corpo_html === undefined ? '<p>Corpo</p>' : campos.corpo_html,
    campos.criterios === undefined ? '{"origem":"direto"}' : campos.criterios,
    campos.status === undefined ? null : campos.status,
  );
}

function inserirEnvio(campanhaId, campos = {}) {
  return run(
    `INSERT INTO campanha_envios (campanha_id, email, nome, origem_tipo, origem_id)
     VALUES (?, ?, ?, ?, ?)`,
    campanhaId,
    campos.email === undefined ? 'pessoa@exemplo.com' : campos.email,
    campos.nome === undefined ? 'Pessoa Teste' : campos.nome,
    campos.origem_tipo === undefined ? 'application' : campos.origem_tipo,
    campos.origem_id === undefined ? 1 : campos.origem_id,
  );
}

// ── 1. As tres tabelas existem ──

test('migrar() cria as tres tabelas da Promocao de Vagas', () => {
  for (const tabela of ['campanhas', 'campanha_envios', 'descadastros']) {
    assert.ok(existeNoSqliteMaster('table', tabela), `tabela ausente: ${tabela}`);
  }
});

// ── 2. Os tres indices existem ──

test('migrar() cria os tres indices da Promocao de Vagas', () => {
  const indices = [
    'idx_applications_email',
    'idx_talentos_email',
    'idx_campanha_envios_pendentes',
  ];
  for (const indice of indices) {
    assert.ok(existeNoSqliteMaster('index', indice), `indice ausente: ${indice}`);
  }
});

// ── 3. Idempotencia no nivel do banco ──

test('UNIQUE(campanha_id, email): a mesma pessoa nao recebe a mesma campanha duas vezes', () => {
  const campanhaId = criarCampanha();
  inserirEnvio(campanhaId, { email: 'repetida@exemplo.com' });

  assert.throws(
    () => inserirEnvio(campanhaId, { email: 'repetida@exemplo.com' }),
    /UNIQUE constraint failed/,
    'o segundo envio do mesmo e-mail na mesma campanha precisa ser rejeitado pelo banco',
  );
});

test('UNIQUE(campanha_id, email): o mesmo e-mail em campanhas DIFERENTES e permitido', () => {
  const primeira = criarCampanha();
  const segunda = criarCampanha();
  inserirEnvio(primeira, { email: 'duas-campanhas@exemplo.com' });

  // A constraint trava a repeticao DENTRO de uma campanha, nao a pessoa participar de
  // varias — travar isso impediria divulgar uma segunda vaga para a mesma base.
  assert.doesNotThrow(() => inserirEnvio(segunda, { email: 'duas-campanhas@exemplo.com' }));
});

// ── 4 e 5. CHECKs de enum ──

test('CHECK de campanhas.status rejeita valor fora do enum', () => {
  assert.throws(
    () => criarCampanha({ status: 'enviada_talvez' }),
    /CHECK constraint failed/,
    'status fora do enum precisa ser rejeitado pelo banco, nao so pelo app',
  );
});

test('campanhas.status aceita os cinco valores previstos e defaulta para rascunho', () => {
  for (const status of ['rascunho', 'enfileirada', 'enviando', 'concluida', 'cancelada']) {
    assert.doesNotThrow(() => criarCampanha({ status }), `status valido rejeitado: ${status}`);
  }
  const id = criarCampanha();
  const linha = db.getDb().prepare('SELECT status FROM campanhas WHERE id = ?').get(id);
  assert.equal(linha.status, 'rascunho');
});

test('CHECK de campanha_envios.origem_tipo rejeita valor fora do enum', () => {
  const campanhaId = criarCampanha();
  assert.throws(
    () => inserirEnvio(campanhaId, { email: 'origem-ruim@exemplo.com', origem_tipo: 'talentos' }),
    /CHECK constraint failed/,
    "origem_tipo so aceita 'application' | 'talento' (singular)",
  );
});

test('campanha_envios.origem_tipo aceita application e talento', () => {
  const campanhaId = criarCampanha();
  assert.doesNotThrow(() =>
    inserirEnvio(campanhaId, { email: 'do-funil@exemplo.com', origem_tipo: 'application' }),
  );
  assert.doesNotThrow(() =>
    inserirEnvio(campanhaId, { email: 'do-banco@exemplo.com', origem_tipo: 'talento' }),
  );
});

test('origem_id nao tem FK: aceita id inexistente e tambem NULL', () => {
  const campanhaId = criarCampanha();
  // E rastro de auditoria, nao relacao — a origem pode ter sumido, e o registro de que o
  // e-mail saiu precisa sobreviver a isso.
  assert.doesNotThrow(() =>
    inserirEnvio(campanhaId, { email: 'orfao@exemplo.com', origem_id: 999999 }),
  );
  assert.doesNotThrow(() =>
    inserirEnvio(campanhaId, { email: 'sem-origem@exemplo.com', origem_id: null }),
  );
});

test('descadastros: e-mail e chave primaria (opt-out nao duplica)', () => {
  run("INSERT INTO descadastros (email, origem) VALUES ('saiu@exemplo.com', 'link_email')");
  assert.throws(
    () => run("INSERT INTO descadastros (email, origem) VALUES ('saiu@exemplo.com', 'manual')"),
    /UNIQUE constraint failed/,
  );
});

// ── 6. Idempotencia da migracao ──

test('migrar() e idempotente: rodar de novo nao lanca nem duplica', () => {
  assert.doesNotThrow(() => {
    migrar();
    migrar();
  });

  // As tabelas continuam la (nada foi recriado nem derrubado).
  for (const tabela of ['campanhas', 'campanha_envios', 'descadastros']) {
    assert.ok(existeNoSqliteMaster('table', tabela), `tabela sumiu apos re-migrar: ${tabela}`);
  }

  // E os dados gravados antes da re-migracao sobreviveram — CREATE TABLE IF NOT EXISTS
  // nunca pode virar um DROP/recriacao silenciosa.
  const n = db.getDb().prepare('SELECT COUNT(*) AS n FROM campanha_envios').get().n;
  assert.ok(n > 0, 'a re-migracao apagou os envios gravados');
});
