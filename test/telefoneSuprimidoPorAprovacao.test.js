'use strict';

// db.telefoneSuprimidoPorAprovacao(telefone) (ETAPA B): supressao por aprovacao SEM coluna
// nova — deriva sempre da candidatura MAIS RECENTE (maior criado_em) daquele telefone.
// Reversibilidade automatica: uma candidatura nova (mais recente, status_recrutador NULL
// ao nascer) tira o telefone da supressao sozinha, sem nenhum UPDATE explicito.

const os = require('node:os');
const path = require('node:path');

process.env.DATABASE_PATH = path.join(os.tmpdir(), `vm-test-suprimido-aprovacao-${process.pid}-${Date.now()}.db`);
process.env.INTERVIEW_MOCK = 'true';
process.env.SESSION_SECRET = 'segredo-de-teste';
process.env.ADMIN_USER = 'admin-teste';
process.env.ADMIN_PASSWORD = 'senha-teste';
process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert/strict');

const db = require('../src/db');
const { migrar } = require('../src/db/migrate');

migrar();

function run(sql, ...params) {
  return Number(db.getDb().prepare(sql).run(...params).lastInsertRowid);
}

const jobId = run(
  "INSERT INTO jobs (slug, titulo, perfil, ativo) VALUES ('vaga-suprimido-aprovacao', 'Closer', 'CLOSER', 1)",
);

let seq = 0;
// criadoEm explicito (string 'YYYY-MM-DD HH:MM:SS') pra controlar qual e a "mais recente"
// sem depender do relogio da maquina rodando o teste rapido demais.
function aplicacao({ telefone, statusRecrutador = null, criadoEm }) {
  seq += 1;
  return run(
    `INSERT INTO applications (job_id, nome, telefone, status_recrutador, token, criado_em)
     VALUES (?, 'Candidato Teste', ?, ?, ?, ?)`,
    jobId,
    telefone,
    statusRecrutador,
    `tok-suprimido-${seq}`,
    criadoEm,
  );
}

test('telefone sem NENHUMA candidatura: nao suprimido (false)', () => {
  assert.equal(db.telefoneSuprimidoPorAprovacao('+5547900000001'), false);
  assert.equal(db.statusRecrutadorMaisRecente('+5547900000001'), null);
});

test('telefone cuja UNICA candidatura foi aprovada: suprimido (true)', () => {
  const tel = '+5547900000002';
  aplicacao({ telefone: tel, statusRecrutador: 'aprovado', criadoEm: '2026-08-01 10:00:00' });
  assert.equal(db.telefoneSuprimidoPorAprovacao(tel), true);
});

test('candidatura aprovada ANTIGA + candidatura NOVA sem decisao: a mais recente decide (false)', () => {
  const tel = '+5547900000003';
  aplicacao({ telefone: tel, statusRecrutador: 'aprovado', criadoEm: '2026-08-01 10:00:00' });
  aplicacao({ telefone: tel, statusRecrutador: null, criadoEm: '2026-08-20 10:00:00' });
  assert.equal(db.telefoneSuprimidoPorAprovacao(tel), false);
});

test('multiplas candidaturas: a mais recente e reprovada, uma ANTERIOR foi aprovada -> nao suprimido (false)', () => {
  const tel = '+5547900000004';
  aplicacao({ telefone: tel, statusRecrutador: 'aprovado', criadoEm: '2026-08-01 10:00:00' });
  aplicacao({ telefone: tel, statusRecrutador: 'reprovado', criadoEm: '2026-08-15 10:00:00' });
  assert.equal(db.telefoneSuprimidoPorAprovacao(tel), false);
});

test('desempate por id quando duas candidaturas tem o MESMO criado_em: a de id maior (inserida por ultimo) decide', () => {
  const tel = '+5547900000005';
  const mesmoInstante = '2026-08-10 12:00:00';
  aplicacao({ telefone: tel, statusRecrutador: 'reprovado', criadoEm: mesmoInstante });
  aplicacao({ telefone: tel, statusRecrutador: 'aprovado', criadoEm: mesmoInstante });
  assert.equal(db.telefoneSuprimidoPorAprovacao(tel), true);
});
