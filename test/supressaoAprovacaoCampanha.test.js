'use strict';

// Supressao por aprovacao na campanha em massa por WhatsApp (ETAPA B, Incremento B6):
// aplicarInvariantes (src/lib/publicoCampanhaWhatsapp.js), usada pelos objetivos 1 (convite
// de grupo) e 2 (divulgacao de vaga), passa a excluir telefone cuja candidatura MAIS
// RECENTE foi aprovada — mesma logica de db.telefoneSuprimidoPorAprovacao (Incremento B1).
//
// O objetivo 3 (status da candidatura) e testado aqui tambem, mas para provar o OPOSTO:
// ele PRECISA continuar incluindo aprovados — e o proprio mecanismo de avisar "voce foi
// aprovado" (ver o comentario extenso em publicoCampanhaWhatsapp.js sobre por que essa
// exclusao nao pode entrar la).

const os = require('node:os');
const path = require('node:path');

process.env.DATABASE_PATH = path.join(os.tmpdir(), `vm-test-supressao-campanha-${process.pid}-${Date.now()}.db`);
process.env.INTERVIEW_MOCK = 'true';
process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert/strict');

const db = require('../src/db');
const { migrar } = require('../src/db/migrate');
const publico = require('../src/lib/publicoCampanhaWhatsapp');

migrar();

const exec = (sql, ...p) => db.getDb().prepare(sql).run(...p);

let seq = 0;
function vagaCom(cidade) {
  seq += 1;
  return Number(
    exec(
      'INSERT INTO jobs (slug, titulo, perfil, cidade, ativo) VALUES (?, ?, ?, ?, 1)',
      `vaga-supressao-camp-${seq}`,
      `Vaga ${seq}`,
      'CLOSER',
      cidade,
    ).lastInsertRowid,
  );
}

function candidatura(jobId, nome, telefone, { statusRecrutador = null, criadoEm } = {}) {
  seq += 1;
  return Number(
    exec(
      `INSERT INTO applications (job_id, nome, telefone, status_recrutador, token, criado_em)
       VALUES (?, ?, ?, ?, ?, ?)`,
      jobId,
      nome,
      telefone,
      statusRecrutador,
      `tok-supressao-camp-${seq}`,
      criadoEm,
    ).lastInsertRowid,
  );
}

function zerar() {
  exec('DELETE FROM applications');
  exec('DELETE FROM talentos');
  exec('DELETE FROM jobs');
  exec('DELETE FROM whatsapp_opt_out');
}

const tels = (r) => r.itens.map((i) => i.telefone).sort();

// ── Convite de grupo (objetivo 1) e divulgacao de vaga (objetivo 2) ──

test('convite de grupo: telefone sem candidatura aprovada aparece normalmente', () => {
  zerar();
  candidatura(vagaCom('Joinville'), 'Ana', '+55 47 90000-1001', { criadoEm: '2026-08-01 10:00:00' });
  const r = publico.listarPublicoConviteGrupo({});
  assert.equal(r.total, 1);
});

test('convite de grupo: candidatura MAIS RECENTE aprovada -> telefone suprimido', () => {
  zerar();
  candidatura(vagaCom('Joinville'), 'Ana', '+55 47 90000-1002', { criadoEm: '2026-08-01 10:00:00' });
  candidatura(vagaCom('Joinville'), 'Ana', '+55 47 90000-1002', {
    statusRecrutador: 'aprovado',
    criadoEm: '2026-08-15 10:00:00',
  });
  assert.deepEqual(tels(publico.listarPublicoConviteGrupo({})), []);
});

test('convite de grupo: aprovada ANTIGA + candidatura NOVA sem decisao -> reversivel, volta a aparecer', () => {
  zerar();
  candidatura(vagaCom('Joinville'), 'Ana', '+55 47 90000-1003', {
    statusRecrutador: 'aprovado',
    criadoEm: '2026-08-01 10:00:00',
  });
  candidatura(vagaCom('Joinville'), 'Ana', '+55 47 90000-1003', { criadoEm: '2026-08-20 10:00:00' });
  const r = publico.listarPublicoConviteGrupo({});
  assert.equal(r.total, 1);
});

test('divulgacao de vaga: MESMA supressao (candidatura mais recente aprovada exclui)', () => {
  zerar();
  const vagaAntiga = vagaCom('Joinville');
  const vagaDivulgada = vagaCom('Joinville');
  candidatura(vagaAntiga, 'Ana', '+55 47 90000-1004', { criadoEm: '2026-08-01 10:00:00' });
  candidatura(vagaAntiga, 'Ana', '+55 47 90000-1004', {
    statusRecrutador: 'aprovado',
    criadoEm: '2026-08-15 10:00:00',
  });
  const r = publico.listarPublicoDivulgacaoVaga(vagaDivulgada, {});
  assert.deepEqual(tels(r), []);
});

// ── Status da candidatura (objetivo 3) — NAO suprime, de proposito ──

test("status da candidatura: aprovados CONTINUAM aparecendo (e o proprio mecanismo de avisar a aprovacao)", () => {
  zerar();
  const vaga = vagaCom('Joinville');
  candidatura(vaga, 'Ana', '+55 47 90000-1005', { statusRecrutador: 'aprovado', criadoEm: '2026-08-01 10:00:00' });

  const r = publico.listarPublicoStatusCandidatura(vaga, ['aprovado']);
  assert.equal(r.total, 1, 'suprimir aprovados aqui tornaria impossivel avisar quem foi aprovado');
});
