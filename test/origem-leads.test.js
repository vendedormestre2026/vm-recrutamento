'use strict';

// B2: origem dos leads (db.obterOrigemLeads) — mesmo funil de 4 etapas, agrupado por
// utm_source em vez de por vaga. DB isolado, dados inseridos direto; sem LLM/STT/TTS/
// Drive/e-mail.
//
// Cobre:
//   1. sem filtro: contagem das 4 etapas por origem + totais;
//   2. bucketizacao: utm_source NULL -> 'Sem origem' e literal 'direto' -> 'Direto' sao
//      baldes DISTINTOS, e NULLs de tabelas diferentes caem no MESMO balde;
//   3. filtro de periodo (desde/ate): so conta o que cai no recorte;
//   4. filtro por vaga (jobId): restringe as 4 etapas aquela vaga;
//   5. ordenacao: origem com mais aplicacoes vem primeiro.

const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');

const TMP_DB = path.join(os.tmpdir(), `vm-test-origem-${process.pid}-${Date.now()}.db`);
process.env.DATABASE_PATH = TMP_DB;
process.env.INTERVIEW_MOCK = 'true';
process.env.SESSION_SECRET = 'segredo-de-teste';
process.env.ADMIN_PASSWORD = 'senha-teste';
process.env.ADMIN_USER = 'admin';
process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert/strict');

const db = require('../src/db');
const { migrar } = require('../src/db/migrate');

// Helpers de insercao direta (controle total de utm_source e timestamps).
function run(sql, ...params) {
  return Number(db.getDb().prepare(sql).run(...params).lastInsertRowid);
}
function criarVaga(slug, titulo, criadoEm) {
  return run(
    "INSERT INTO jobs (slug, titulo, perfil, criado_em) VALUES (?, ?, 'CLOSER', ?)",
    slug,
    titulo,
    criadoEm,
  );
}
function acesso(jobId, utm, criadoEm) {
  run(
    'INSERT INTO vaga_acessos (job_id, utm_source, criado_em) VALUES (?, ?, ?)',
    jobId,
    utm,
    criadoEm,
  );
}
let seqApp = 0;
function aplicacao(jobId, utm, status, criadoEm) {
  seqApp += 1;
  return run(
    'INSERT INTO applications (job_id, utm_source, status, token, criado_em) VALUES (?, ?, ?, ?, ?)',
    jobId,
    utm,
    status,
    `tok-app-${seqApp}`,
    criadoEm,
  );
}
function entrevista(appId, status, finalizadoEm) {
  return run(
    "INSERT INTO interviews (application_id, perfil, status, finalizado_em) VALUES (?, 'CLOSER', ?, ?)",
    appId,
    status,
    finalizadoEm,
  );
}
let seqRep = 0;
function report(interviewId, recomendacao, enviadoEm) {
  seqRep += 1;
  run(
    "INSERT INTO reports (interview_id, token, status, recomendacao, enviado_em) VALUES (?, ?, 'enviado', ?, ?)",
    interviewId,
    `tok-rep-${seqRep}`,
    recomendacao,
    enviadoEm,
  );
}

let jobA;
let jobB;

test.before(() => {
  migrar();

  jobA = criarVaga('vaga-a', 'Vaga A', '2026-05-01 09:00:00');
  jobB = criarVaga('vaga-b', 'Vaga B', '2026-05-02 09:00:00');

  // ── VAGA A ──────────────────────────────────────────────────────────────────
  // Acessos: google 2 (jun) + 1 (jan, fora) ; instagram 1 (jun) ; NULL 1 (jun).
  acesso(jobA, 'google', '2026-06-01 10:00:00');
  acesso(jobA, 'google', '2026-06-02 10:00:00');
  acesso(jobA, 'google', '2026-01-05 10:00:00'); // fora do periodo
  acesso(jobA, 'instagram', '2026-06-03 10:00:00');
  acesso(jobA, null, '2026-06-04 10:00:00'); // -> 'Sem origem'

  // Aplicacoes: google concluido x2 (jun) + x1 (jan, fora) ; instagram aplicado ;
  // 'direto' concluido ; NULL aplicado.
  const a1 = aplicacao(jobA, 'google', 'concluido', '2026-06-01 10:00:00');
  const a2 = aplicacao(jobA, 'google', 'concluido', '2026-06-02 10:00:00');
  aplicacao(jobA, 'instagram', 'aplicado', '2026-06-03 10:00:00'); // sem entrevista
  const a4 = aplicacao(jobA, 'direto', 'concluido', '2026-06-04 10:00:00'); // -> 'Direto'
  aplicacao(jobA, null, 'aplicado', '2026-06-05 10:00:00'); // -> 'Sem origem', sem entrevista
  const a6 = aplicacao(jobA, 'google', 'concluido', '2026-01-05 10:00:00'); // fora do periodo

  // Entrevistas concluidas + reports.
  report(entrevista(a1, 'concluido', '2026-06-01 11:00:00'), 'avancar', '2026-06-01 11:30:00'); // google pre-aprovado
  report(entrevista(a2, 'concluido', '2026-06-02 11:00:00'), 'talvez', '2026-06-02 11:30:00'); // google NAO pre
  report(entrevista(a4, 'concluido', '2026-06-04 11:00:00'), 'avancar', '2026-06-04 11:30:00'); // direto pre-aprovado
  report(entrevista(a6, 'concluido', '2026-01-05 11:00:00'), 'avancar', '2026-01-05 11:30:00'); // google pre FORA

  // ── VAGA B ── uma origem propria (linkedin), tudo em junho.
  acesso(jobB, 'linkedin', '2026-06-10 10:00:00');
  const b1 = aplicacao(jobB, 'linkedin', 'concluido', '2026-06-10 10:00:00');
  report(entrevista(b1, 'concluido', '2026-06-10 11:00:00'), 'avancar', '2026-06-10 11:30:00');
});

test.after(() => {
  for (const sufixo of ['', '-wal', '-shm']) {
    try {
      fs.rmSync(TMP_DB + sufixo, { force: true });
    } catch {
      /* ignore */
    }
  }
});

function porOrigem(res) {
  const m = new Map();
  for (const o of res.origens) m.set(o.origem, o);
  return m;
}
function metricas(o) {
  return {
    acessos: o.acessos,
    aplicacoes: o.aplicacoes,
    entrevistas_realizadas: o.entrevistas_realizadas,
    pre_aprovados: o.pre_aprovados,
  };
}

test('obterOrigemLeads (sem filtro): 4 etapas por origem + totais', () => {
  const res = db.obterOrigemLeads();
  const m = porOrigem(res);

  assert.deepEqual(metricas(m.get('google')), {
    acessos: 3,
    aplicacoes: 3,
    entrevistas_realizadas: 3,
    pre_aprovados: 2,
  });
  assert.deepEqual(metricas(m.get('instagram')), {
    acessos: 1,
    aplicacoes: 1,
    entrevistas_realizadas: 0,
    pre_aprovados: 0,
  });
  assert.deepEqual(metricas(m.get('linkedin')), {
    acessos: 1,
    aplicacoes: 1,
    entrevistas_realizadas: 1,
    pre_aprovados: 1,
  });

  assert.deepEqual(res.totais, {
    acessos: 6,
    aplicacoes: 7,
    entrevistas_realizadas: 5,
    pre_aprovados: 4,
  });
});

test('bucketizacao: "Direto" e "Sem origem" sao baldes distintos', () => {
  const m = porOrigem(db.obterOrigemLeads());

  // 'direto' (aplicacao sem UTM) -> 'Direto': 1 aplicacao concluida, 1 entrevista, 1 pre.
  assert.deepEqual(metricas(m.get('Direto')), {
    acessos: 0, // vaga_acessos nunca grava 'direto'
    aplicacoes: 1,
    entrevistas_realizadas: 1,
    pre_aprovados: 1,
  });

  // NULL (acesso + aplicacao sem UTM) -> 'Sem origem': 1 acesso + 1 aplicacao, sem entrevista.
  assert.deepEqual(metricas(m.get('Sem origem')), {
    acessos: 1,
    aplicacoes: 1,
    entrevistas_realizadas: 0,
    pre_aprovados: 0,
  });

  // Sao chaves diferentes (nao foram fundidas).
  assert.ok(m.has('Direto') && m.has('Sem origem'));
  assert.notEqual(m.get('Direto'), m.get('Sem origem'));
});

test('obterOrigemLeads (filtro junho): exclui o que cai fora do periodo', () => {
  const res = db.obterOrigemLeads({ desde: '2026-06-01', ate: '2026-06-30' });
  const m = porOrigem(res);

  // google perde 1 acesso (jan), 1 aplicacao (a6), 1 entrevista (a6) e 1 pre (a6).
  assert.deepEqual(metricas(m.get('google')), {
    acessos: 2,
    aplicacoes: 2,
    entrevistas_realizadas: 2,
    pre_aprovados: 1,
  });

  assert.deepEqual(res.totais, {
    acessos: 5,
    aplicacoes: 6,
    entrevistas_realizadas: 4,
    pre_aprovados: 3,
  });
});

test('obterOrigemLeads (filtro por vaga jobB): so a origem daquela vaga', () => {
  const res = db.obterOrigemLeads({ jobId: jobB });
  const m = porOrigem(res);

  assert.deepEqual([...m.keys()], ['linkedin']);
  assert.deepEqual(metricas(m.get('linkedin')), {
    acessos: 1,
    aplicacoes: 1,
    entrevistas_realizadas: 1,
    pre_aprovados: 1,
  });
  assert.deepEqual(res.totais, {
    acessos: 1,
    aplicacoes: 1,
    entrevistas_realizadas: 1,
    pre_aprovados: 1,
  });
});

test('obterOrigemLeads: ordena por aplicacoes desc (google no topo)', () => {
  const res = db.obterOrigemLeads();
  assert.equal(res.origens[0].origem, 'google'); // 3 aplicacoes, mais que qualquer outra
});
