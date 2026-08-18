'use strict';

// Func. 3, sub-commit 2: endpoint/dados do funil de conversao (Acessos -> Aplicacoes ->
// Entrevistas realizadas -> Pre-aprovados pela IA).
//
// Cobre (DB isolado, dados inseridos direto; sem LLM/STT/TTS/Drive/e-mail):
//   1. obterFunilConversao() sem filtro: os 4 numeros batem por vaga e no total;
//   2. filtro desde/ate: so conta o que cai no periodo (registros fora ficam de fora);
//   3. filtro jobId (Item 2 do ETAPA B "Ajustes no Admin"): so a vaga escolhida aparece,
//      com zero ou mais atividade, e totais batem com aquela vaga (nao o consolidado);
//   4. pre_aprovados conta APENAS recomendacao='avancar' (nao 'talvez'/'descartar'/null)
//      e sem duplicar quando ha mais de um report 'avancar' na mesma entrevista;
//   5. GET /admin/api/funil sem auth -> redireciona para o login (como as demais rotas);
//   6. GET /admin/api/funil com datas malformadas -> 400 claro (nao 500/crash);
//   7. GET /admin/api/funil autenticado + datas validas -> 200 JSON.

const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');
const crypto = require('node:crypto');

const TMP_DB = path.join(os.tmpdir(), `vm-test-funil-${process.pid}-${Date.now()}.db`);
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
const { criarApp } = require('../src/server');

const SECRET = process.env.SESSION_SECRET;
const SENHA = process.env.ADMIN_PASSWORD;

// Cookie de admin assinado (cookie-parser/cookie-signature): 's:' + valor + '.' + HMAC.
function cookieAdmin() {
  const sig = crypto.createHmac('sha256', SECRET).update(SENHA).digest('base64').replace(/=+$/, '');
  return `vm_admin=${encodeURIComponent(`s:${SENHA}.${sig}`)}`;
}

// Helpers de insercao direta (controle total de timestamps p/ testar o recorte de periodo).
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
function acesso(jobId, criadoEm) {
  run('INSERT INTO vaga_acessos (job_id, criado_em) VALUES (?, ?)', jobId, criadoEm);
}
let seqApp = 0;
function aplicacao(jobId, status, criadoEm) {
  seqApp += 1;
  return run(
    'INSERT INTO applications (job_id, status, token, criado_em) VALUES (?, ?, ?, ?)',
    jobId,
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
let jobC;

test.before(() => {
  migrar();

  jobA = criarVaga('vaga-a', 'Vaga A', '2026-05-01 09:00:00');
  jobB = criarVaga('vaga-b', 'Vaga B', '2026-05-02 09:00:00');
  jobC = criarVaga('vaga-c', 'Vaga C (sem atividade)', '2026-05-03 09:00:00');

  // ── VAGA A ── acessos: 2 dentro (junho) + 1 fora (janeiro) = 3
  acesso(jobA, '2026-06-10 10:00:00');
  acesso(jobA, '2026-06-11 10:00:00');
  acesso(jobA, '2026-01-01 10:00:00'); // fora do periodo

  const a1 = aplicacao(jobA, 'concluido', '2026-06-10 10:00:00');
  const a2 = aplicacao(jobA, 'concluido', '2026-06-11 10:00:00');
  const a3 = aplicacao(jobA, 'concluido', '2026-06-12 10:00:00');
  aplicacao(jobA, 'aplicado', '2026-06-13 10:00:00'); // sem entrevista
  const a5 = aplicacao(jobA, 'concluido', '2026-01-01 10:00:00'); // fora do periodo

  report(entrevista(a1, 'concluido', '2026-06-10 11:00:00'), 'avancar', '2026-06-10 11:30:00'); // pre-aprovado
  report(entrevista(a2, 'concluido', '2026-06-11 11:00:00'), 'talvez', '2026-06-11 11:30:00');
  report(entrevista(a3, 'concluido', '2026-06-12 11:00:00'), 'descartar', '2026-06-12 11:30:00');
  report(entrevista(a5, 'concluido', '2026-01-01 11:00:00'), 'avancar', '2026-01-01 11:30:00'); // pre-aprovado FORA

  // ── VAGA B ── 1 acesso dentro
  acesso(jobB, '2026-06-20 10:00:00');

  const b1 = aplicacao(jobB, 'concluido', '2026-06-20 10:00:00');
  const b2 = aplicacao(jobB, 'concluido', '2026-06-21 10:00:00');
  const b3 = aplicacao(jobB, 'em_entrevista', '2026-06-22 10:00:00'); // entrevista NAO concluida

  report(entrevista(b1, 'concluido', '2026-06-20 11:00:00'), 'avancar', '2026-06-20 11:30:00');
  const ib2 = entrevista(b2, 'concluido', '2026-06-21 11:00:00');
  report(ib2, 'avancar', '2026-06-21 11:30:00');
  report(ib2, 'avancar', '2026-06-21 12:00:00'); // 2o report 'avancar' da MESMA entrevista -> conta 1x
  entrevista(b3, 'iniciada', null); // nao concluida -> nao conta
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

function porJob(funil) {
  const m = new Map();
  for (const v of funil.vagas) m.set(v.job_id, v);
  return m;
}

test('obterFunilConversao (sem filtro): numeros por vaga e total batem com o inserido', () => {
  const funil = db.obterFunilConversao();
  const m = porJob(funil);

  // Vaga A
  assert.deepEqual(
    {
      acessos: m.get(jobA).acessos,
      aplicacoes: m.get(jobA).aplicacoes,
      entrevistas_realizadas: m.get(jobA).entrevistas_realizadas,
      pre_aprovados: m.get(jobA).pre_aprovados,
    },
    { acessos: 3, aplicacoes: 5, entrevistas_realizadas: 4, pre_aprovados: 2 },
  );

  // Vaga B (b2 tem 2 reports 'avancar' -> pre_aprovados conta 1; b3 nao concluida nao entra)
  assert.deepEqual(
    {
      acessos: m.get(jobB).acessos,
      aplicacoes: m.get(jobB).aplicacoes,
      entrevistas_realizadas: m.get(jobB).entrevistas_realizadas,
      pre_aprovados: m.get(jobB).pre_aprovados,
    },
    { acessos: 1, aplicacoes: 3, entrevistas_realizadas: 2, pre_aprovados: 2 },
  );

  // Vaga C: sem atividade -> aparece com zeros
  assert.deepEqual(
    {
      acessos: m.get(jobC).acessos,
      aplicacoes: m.get(jobC).aplicacoes,
      entrevistas_realizadas: m.get(jobC).entrevistas_realizadas,
      pre_aprovados: m.get(jobC).pre_aprovados,
    },
    { acessos: 0, aplicacoes: 0, entrevistas_realizadas: 0, pre_aprovados: 0 },
  );

  // Totais consolidados
  assert.deepEqual(funil.totais, {
    acessos: 4,
    aplicacoes: 8,
    entrevistas_realizadas: 6,
    pre_aprovados: 4,
  });
});

test('obterFunilConversao (filtro junho): so conta o que cai no periodo', () => {
  const funil = db.obterFunilConversao({ desde: '2026-06-01', ate: '2026-06-30' });
  const m = porJob(funil);

  // Vaga A: cai fora 1 acesso (jan), 1 aplicacao (a5), 1 entrevista (a5), 1 pre-aprovado (a5)
  assert.deepEqual(
    {
      acessos: m.get(jobA).acessos,
      aplicacoes: m.get(jobA).aplicacoes,
      entrevistas_realizadas: m.get(jobA).entrevistas_realizadas,
      pre_aprovados: m.get(jobA).pre_aprovados,
    },
    { acessos: 2, aplicacoes: 4, entrevistas_realizadas: 3, pre_aprovados: 1 },
  );

  // Vaga B: tudo dentro de junho
  assert.deepEqual(
    {
      acessos: m.get(jobB).acessos,
      aplicacoes: m.get(jobB).aplicacoes,
      entrevistas_realizadas: m.get(jobB).entrevistas_realizadas,
      pre_aprovados: m.get(jobB).pre_aprovados,
    },
    { acessos: 1, aplicacoes: 3, entrevistas_realizadas: 2, pre_aprovados: 2 },
  );

  assert.deepEqual(funil.totais, {
    acessos: 3,
    aplicacoes: 7,
    entrevistas_realizadas: 5,
    pre_aprovados: 3,
  });
});

test('obterFunilConversao (filtro por vaga jobB): so a vaga escolhida aparece', () => {
  const funil = db.obterFunilConversao({ jobId: jobB });

  assert.deepEqual(funil.vagas.map((v) => v.job_id), [jobB]);
  assert.deepEqual(
    {
      acessos: funil.vagas[0].acessos,
      aplicacoes: funil.vagas[0].aplicacoes,
      entrevistas_realizadas: funil.vagas[0].entrevistas_realizadas,
      pre_aprovados: funil.vagas[0].pre_aprovados,
    },
    { acessos: 1, aplicacoes: 3, entrevistas_realizadas: 2, pre_aprovados: 2 },
  );
  // Totais batem com a vaga unica (nao com o consolidado de todas as vagas).
  assert.deepEqual(funil.totais, {
    acessos: 1,
    aplicacoes: 3,
    entrevistas_realizadas: 2,
    pre_aprovados: 2,
  });
});

test('obterFunilConversao (filtro por vaga jobC, sem atividade nenhuma): 1 linha zerada', () => {
  const funil = db.obterFunilConversao({ jobId: jobC });
  assert.deepEqual(funil.vagas.map((v) => v.job_id), [jobC]);
  assert.deepEqual(funil.totais, {
    acessos: 0,
    aplicacoes: 0,
    entrevistas_realizadas: 0,
    pre_aprovados: 0,
  });
});

test('obterFunilConversao: pre_aprovados ignora talvez/descartar/null', () => {
  // Recorte estreito que pega apenas a2 (talvez) e a3 (descartar) da Vaga A: 0 pre-aprovados.
  const funil = db.obterFunilConversao({ desde: '2026-06-11', ate: '2026-06-12' });
  const m = porJob(funil);
  assert.equal(m.get(jobA).entrevistas_realizadas, 2); // a2 e a3
  assert.equal(m.get(jobA).pre_aprovados, 0); // nenhum 'avancar' nesse recorte
});

test('GET /admin/api/funil sem auth -> redireciona para o login', async () => {
  const app = criarApp();
  const server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const res = await fetch(`${base}/admin/api/funil`, { redirect: 'manual' });
    assert.equal(res.status, 302);
    assert.match(res.headers.get('location') || '', /\/admin\/login/);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('GET /admin/api/funil (autenticado) com data malformada -> 400 claro', async () => {
  const app = criarApp();
  const server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    for (const qs of ['desde=2026-13-40', 'ate=nao-e-data', 'desde=2026/06/01']) {
      const res = await fetch(`${base}/admin/api/funil?${qs}`, {
        headers: { Cookie: cookieAdmin() },
      });
      assert.equal(res.status, 400, `esperado 400 para ?${qs}`);
      const body = await res.json();
      assert.equal(body.ok, false);
      assert.match(body.erro, /inválid/i);
    }
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('GET /admin/api/funil (autenticado) com datas validas -> 200 JSON', async () => {
  const app = criarApp();
  const server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const res = await fetch(`${base}/admin/api/funil?desde=2026-06-01&ate=2026-06-30`, {
      headers: { Cookie: cookieAdmin() },
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.ok, true);
    assert.deepEqual(body.filtro, { desde: '2026-06-01', ate: '2026-06-30' });
    assert.deepEqual(body.totais, {
      acessos: 3,
      aplicacoes: 7,
      entrevistas_realizadas: 5,
      pre_aprovados: 3,
    });
    assert.ok(Array.isArray(body.vagas));
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
