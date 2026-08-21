'use strict';

// db.listarAplicacoesComCurriculoAntes — query de leitura usada pelo backup manual de
// curriculos (GET /admin/curriculos-backup, routes/admin.js). So testa a QUERY em si
// (candidaturas antes/depois do corte, sem curriculo_path ficam de fora, data de corte
// invalida); o comportamento HTTP da rota (headers, tar.gz, manifesto) tem cobertura
// propria em test/adminCurriculosBackup.test.js.

const os = require('node:os');
const path = require('node:path');

process.env.DATABASE_PATH = path.join(os.tmpdir(), `vm-test-db-curriculo-antes-${process.pid}-${Date.now()}.db`);
process.env.INTERVIEW_MOCK = 'true';
process.env.SESSION_SECRET = 'segredo-de-teste';
process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert/strict');

const db = require('../src/db');
const { migrar } = require('../src/db/migrate');

migrar();

const run = (sql, ...p) => Number(db.getDb().prepare(sql).run(...p).lastInsertRowid);

const jobId = run(
  "INSERT INTO jobs (slug, titulo, perfil, empresa, ativo) VALUES ('vaga-curriculo-antes', 'Vaga Teste', 'CLOSER', 'Empresa Teste', 1)",
);

function criarApplication({ criado_em, curriculo_path = '/data/curriculos/tok.pdf', nome = 'Fulano' }) {
  return run(
    `INSERT INTO applications (job_id, nome, sobrenome, email, telefone, curriculo_path, token, status, criado_em)
     VALUES (?, ?, 'Teste', 'x@x.com', '+5511999998888', ?, ?, 'aplicado', ?)`,
    jobId,
    nome,
    curriculo_path,
    `tok-${nome}-${Math.random()}`,
    criado_em,
  );
}

test('candidatura ANTES do corte, com curriculo: entra na lista', () => {
  const id = criarApplication({ criado_em: '2025-01-01 10:00:00' });
  const lista = db.listarAplicacoesComCurriculoAntes('2025-06-01');
  assert.ok(lista.some((l) => l.id === id), 'candidatura antiga com curriculo tem que aparecer');
});

test('candidatura DEPOIS do corte: fica de fora', () => {
  const id = criarApplication({ criado_em: '2025-12-01 10:00:00' });
  const lista = db.listarAplicacoesComCurriculoAntes('2025-06-01');
  assert.ok(!lista.some((l) => l.id === id), 'candidatura posterior ao corte nao pode aparecer');
});

test('candidatura SEM curriculo_path (NULL ou string vazia): fica de fora mesmo sendo antiga', () => {
  const idNull = criarApplication({ criado_em: '2025-01-01 10:00:00', curriculo_path: null, nome: 'SemCurriculoNull' });
  const idVazio = criarApplication({ criado_em: '2025-01-01 10:00:00', curriculo_path: '   ', nome: 'SemCurriculoVazio' });
  const lista = db.listarAplicacoesComCurriculoAntes('2025-06-01');
  assert.ok(!lista.some((l) => l.id === idNull), 'curriculo_path NULL nao pode entrar');
  assert.ok(!lista.some((l) => l.id === idVazio), 'curriculo_path so com espacos nao pode entrar');
});

test('data de corte invalida: devolve lista vazia, sem lancar', () => {
  criarApplication({ criado_em: '2025-01-01 10:00:00', nome: 'QualquerUm' });
  for (const invalida of ['', 'nao-e-data', '2025/01/01', '01-01-2025', null, undefined]) {
    assert.deepEqual(db.listarAplicacoesComCurriculoAntes(invalida), []);
  }
});

test('traz o titulo da vaga via JOIN e vem ordenado do mais antigo pro mais novo', () => {
  db.getDb().prepare('DELETE FROM applications').run();
  const idMeio = criarApplication({ criado_em: '2025-02-01 10:00:00', nome: 'Meio' });
  const idAntigo = criarApplication({ criado_em: '2025-01-01 10:00:00', nome: 'Antigo' });
  const idRecente = criarApplication({ criado_em: '2025-03-01 10:00:00', nome: 'MaisRecenteAindaAntesDoCorte' });

  const lista = db.listarAplicacoesComCurriculoAntes('2025-06-01');
  assert.deepEqual(lista.map((l) => l.id), [idAntigo, idMeio, idRecente]);
  assert.ok(lista.every((l) => l.vaga_titulo === 'Vaga Teste'));
});

// ══════════════════ marcarCurriculoRemovido + exclusao da listagem ══════════════════
// (backup manual, Etapa B: GET/POST /admin/curriculos-backup/apagar)

test('marcarCurriculoRemovido grava curriculo_removido_em com timestamp nao-nulo', () => {
  const id = criarApplication({ criado_em: '2025-01-01 10:00:00', nome: 'ParaMarcar' });
  const antes = db.getDb().prepare('SELECT curriculo_removido_em FROM applications WHERE id = ?').get(id);
  assert.equal(antes.curriculo_removido_em, null);

  db.marcarCurriculoRemovido(id);

  const depois = db.getDb().prepare('SELECT curriculo_removido_em FROM applications WHERE id = ?').get(id);
  assert.ok(depois.curriculo_removido_em, 'tem que gravar um timestamp');
  assert.match(depois.curriculo_removido_em, /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
});

test('candidatura com curriculo_removido_em preenchido NAO aparece na lista, mesmo antes do corte', () => {
  const id = criarApplication({ criado_em: '2025-01-01 10:00:00', nome: 'JaRemovido' });
  db.marcarCurriculoRemovido(id);

  const lista = db.listarAplicacoesComCurriculoAntes('2025-06-01');
  assert.ok(!lista.some((l) => l.id === id), 'ja removido nao pode reaparecer num novo backup/exclusao');
});
