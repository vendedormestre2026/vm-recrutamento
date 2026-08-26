'use strict';

// Supressao por aprovacao na fila Baileys (ETAPA B, Incremento B5):
// listarPendentesSequenciaWhatsapp (src/db/sqlite.js) para de devolver uma linha pendente
// (wa1/wa2/reprovacao) quando a candidatura MAIS RECENTE do MESMO TELEFONE foi aprovada —
// mesma logica de db.telefoneSuprimidoPorAprovacao (Incremento B1), embutida como subquery
// correlacionada na propria consulta (uma vez por ciclo, nao uma vez por linha).

const os = require('node:os');
const path = require('node:path');

process.env.DATABASE_PATH = path.join(os.tmpdir(), `vm-test-supressao-sequencia-${process.pid}-${Date.now()}.db`);
process.env.INTERVIEW_MOCK = 'true';
process.env.SESSION_SECRET = 'segredo-de-teste';
process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert/strict');

const db = require('../src/db');
const { migrar } = require('../src/db/migrate');

migrar();

const run = (sql, ...p) => Number(db.getDb().prepare(sql).run(...p).lastInsertRowid);

let seq = 0;
function aplicacao({ telefone, statusRecrutador = null, criadoEm }) {
  seq += 1;
  const jobId = run(
    "INSERT INTO jobs (slug, titulo, perfil, ativo) VALUES (?, 'Vendedor', 'CLOSER', 1)",
    `vaga-supressao-seq-${seq}`,
  );
  return run(
    `INSERT INTO applications (job_id, nome, telefone, status_recrutador, token, criado_em)
     VALUES (?, 'Candidato', ?, ?, ?, ?)`,
    jobId,
    telefone,
    statusRecrutador,
    `tok-supressao-seq-${seq}`,
    criadoEm,
  );
}

function agendarPendente(applicationId, telefoneE164, etapa = 'wa1') {
  db.agendarEnvioWhatsapp({
    applicationId,
    etapa,
    telefone: telefoneE164,
    agendadoPara: '2020-01-01 00:00:00', // bem no passado: sempre "ja venceu"
    templateNome: etapa,
  });
}

test('telefone SEM candidatura aprovada: a linha pendente aparece normalmente', () => {
  const tel = '+5547900000101';
  const appId = aplicacao({ telefone: tel, criadoEm: '2026-08-01 10:00:00' });
  agendarPendente(appId, '5547900000101');

  const pendentes = db.listarPendentesSequenciaWhatsapp({ limite: 100 });
  assert.ok(pendentes.some((p) => p.application_id === appId));
});

test('candidatura MAIS RECENTE do mesmo telefone aprovada: a linha pendente para de aparecer', () => {
  const tel = '+5547900000102';
  const appAntiga = aplicacao({ telefone: tel, criadoEm: '2026-08-01 10:00:00' });
  agendarPendente(appAntiga, '5547900000102');
  // Candidatura NOVA do mesmo telefone, aprovada.
  aplicacao({ telefone: tel, statusRecrutador: 'aprovado', criadoEm: '2026-08-20 10:00:00' });

  const pendentes = db.listarPendentesSequenciaWhatsapp({ limite: 100 });
  assert.ok(!pendentes.some((p) => p.application_id === appAntiga), 'linha suprimida nao pode aparecer na fila');
});

test('candidatura aprovada e ANTIGA, uma NOVA sem decisao: a mais recente decide — a linha volta a aparecer', () => {
  const tel = '+5547900000103';
  aplicacao({ telefone: tel, statusRecrutador: 'aprovado', criadoEm: '2026-08-01 10:00:00' });
  const appNova = aplicacao({ telefone: tel, criadoEm: '2026-08-20 10:00:00' });
  agendarPendente(appNova, '5547900000103');

  const pendentes = db.listarPendentesSequenciaWhatsapp({ limite: 100 });
  assert.ok(pendentes.some((p) => p.application_id === appNova), 'reversibilidade: candidatura nova tira a supressao');
});

test("vale pra 'reprovacao' tambem, nao so wa1/wa2", () => {
  const tel = '+5547900000104';
  const appAntiga = aplicacao({ telefone: tel, criadoEm: '2026-08-01 10:00:00' });
  agendarPendente(appAntiga, '5547900000104', 'reprovacao');
  aplicacao({ telefone: tel, statusRecrutador: 'aprovado', criadoEm: '2026-08-20 10:00:00' });

  const pendentes = db.listarPendentesSequenciaWhatsapp({ limite: 100 });
  assert.ok(!pendentes.some((p) => p.application_id === appAntiga && p.etapa === 'reprovacao'));
});

test('a subquery de supressao concorda com db.telefoneSuprimidoPorAprovacao para o mesmo cenario', () => {
  const tel = '+5547900000105';
  aplicacao({ telefone: tel, statusRecrutador: 'reprovado', criadoEm: '2026-08-01 10:00:00' });
  const appMaisRecente = aplicacao({ telefone: tel, statusRecrutador: 'aprovado', criadoEm: '2026-08-15 10:00:00' });
  agendarPendente(appMaisRecente, '5547900000105');

  assert.equal(db.telefoneSuprimidoPorAprovacao(tel), true);
  const pendentes = db.listarPendentesSequenciaWhatsapp({ limite: 100 });
  assert.ok(!pendentes.some((p) => p.application_id === appMaisRecente));
});
