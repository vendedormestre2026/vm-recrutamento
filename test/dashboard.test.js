'use strict';

// Func. 3, sub-commit 3: pagina /admin/dashboard (visualizacao do funil de conversao).
// Consome db.obterFunilConversao direto (server-side). Sem LLM/STT/TTS/Drive/e-mail.
//
// Cobre:
//   1. sem auth -> redireciona para o login (como as demais rotas do admin);
//   2. com dados: totais corretos, barras com largura proporcional, taxas corretas;
//   3. divisao por zero (vaga acessos=0) -> '—', sem NaN/Infinity/undefined;
//   4. filtro de periodo por querystring aplica o range;
//   5. data malformada -> aviso amigavel, pagina nao quebra (200);
//   6. vaga com tudo zero aparece na tabela (nao some).

const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');
const crypto = require('node:crypto');

const TMP_DB = path.join(os.tmpdir(), `vm-test-dashboard-${process.pid}-${Date.now()}.db`);
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

function cookieAdmin() {
  const sig = crypto.createHmac('sha256', SECRET).update(SENHA).digest('base64').replace(/=+$/, '');
  return `vm_admin=${encodeURIComponent(`s:${SENHA}.${sig}`)}`;
}

// ── Insercao direta (mesmo cenario do funil.test.js) ──
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

async function getDashboard(qs = '', comAuth = true) {
  const app = criarApp();
  const server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const opts = comAuth ? { headers: { Cookie: cookieAdmin() } } : { redirect: 'manual' };
    const res = await fetch(`${base}/admin/dashboard${qs}`, opts);
    const texto = res.status < 300 ? await res.text() : '';
    return { status: res.status, location: res.headers.get('location'), html: texto };
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

test.before(() => {
  migrar();

  const jobA = criarVaga('vaga-a', 'Vaga A', '2026-05-01 09:00:00');
  const jobB = criarVaga('vaga-b', 'Vaga B', '2026-05-02 09:00:00');
  criarVaga('vaga-c', 'Vaga C sem atividade', '2026-05-03 09:00:00'); // fica toda zero

  // VAGA A: acessos 2 (junho) + 1 (janeiro) = 3
  acesso(jobA, '2026-06-10 10:00:00');
  acesso(jobA, '2026-06-11 10:00:00');
  acesso(jobA, '2026-01-01 10:00:00');
  const a1 = aplicacao(jobA, 'concluido', '2026-06-10 10:00:00');
  const a2 = aplicacao(jobA, 'concluido', '2026-06-11 10:00:00');
  const a3 = aplicacao(jobA, 'concluido', '2026-06-12 10:00:00');
  aplicacao(jobA, 'aplicado', '2026-06-13 10:00:00');
  const a5 = aplicacao(jobA, 'concluido', '2026-01-01 10:00:00');
  report(entrevista(a1, 'concluido', '2026-06-10 11:00:00'), 'avancar', '2026-06-10 11:30:00');
  report(entrevista(a2, 'concluido', '2026-06-11 11:00:00'), 'talvez', '2026-06-11 11:30:00');
  report(entrevista(a3, 'concluido', '2026-06-12 11:00:00'), 'descartar', '2026-06-12 11:30:00');
  report(entrevista(a5, 'concluido', '2026-01-01 11:00:00'), 'avancar', '2026-01-01 11:30:00');

  // VAGA B
  acesso(jobB, '2026-06-20 10:00:00');
  const b1 = aplicacao(jobB, 'concluido', '2026-06-20 10:00:00');
  const b2 = aplicacao(jobB, 'concluido', '2026-06-21 10:00:00');
  const b3 = aplicacao(jobB, 'em_entrevista', '2026-06-22 10:00:00');
  report(entrevista(b1, 'concluido', '2026-06-20 11:00:00'), 'avancar', '2026-06-20 11:30:00');
  const ib2 = entrevista(b2, 'concluido', '2026-06-21 11:00:00');
  report(ib2, 'avancar', '2026-06-21 11:30:00');
  report(ib2, 'avancar', '2026-06-21 12:00:00');
  entrevista(b3, 'iniciada', null);
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

test('GET /admin/dashboard sem auth -> redireciona para o login', async () => {
  const r = await getDashboard('', false);
  assert.equal(r.status, 302);
  assert.match(r.location || '', /\/admin\/login/);
});

test('dashboard (sem filtro): totais, larguras proporcionais e taxas corretas', async () => {
  // Totais historicos: acessos=4, aplicacoes=8, entrevistas=6, pre=4. Max=8.
  // Larguras: 4/8=50.0, 8/8=100.0, 6/8=75.0, 4/8=50.0
  // Taxas: 8/4=200%, 6/8=75%, 4/6=67% (arred.)
  const { status, html } = await getDashboard();
  assert.equal(status, 200);

  assert.match(html, /Funil de Conversão/);
  assert.match(html, /Pré-aprovados pela IA/);

  // Larguras das barras (proporcionais ao maior total).
  assert.match(html, /width:100\.0%/);
  assert.match(html, /width:75\.0%/);
  assert.match(html, /width:50\.0%/);

  // Taxas de conversao entre etapas (a partir dos totais).
  assert.match(html, /200%/);
  assert.match(html, /75%/);
  assert.match(html, /67%/);

  // Nunca vaza NaN/Infinity/undefined.
  assert.ok(!/NaN|Infinity|undefined/.test(html));
});

test('dashboard: divisao por zero (vaga sem acessos) mostra "—", sem NaN/Infinity', async () => {
  const { html } = await getDashboard();
  // Vaga C aparece (nao some) e como linha discreta (classe linha-zero).
  assert.match(html, /Vaga C sem atividade/);
  assert.match(html, /linha-zero/);
  // Taxa com denominador zero vira travessao, nao NaN/Infinity.
  assert.match(html, /—/);
  assert.ok(!/NaN|Infinity|undefined/.test(html));
});

test('dashboard (filtro junho): totais refletem apenas o periodo', async () => {
  // Junho: acessos=3, aplicacoes=7, entrevistas=5, pre=3. Max=7.
  // Larguras: 3/7=42.9, 7/7=100.0, 5/7=71.4, 3/7=42.9
  const { status, html } = await getDashboard('?desde=2026-06-01&ate=2026-06-30');
  assert.equal(status, 200);
  assert.match(html, /Período: 2026-06-01 até 2026-06-30/);
  assert.match(html, /width:100\.0%/);
  assert.match(html, /width:71\.4%/);
  assert.match(html, /width:42\.9%/);
  assert.ok(!/NaN|Infinity|undefined/.test(html));
});

test('dashboard: data malformada -> aviso amigavel, sem crash (200)', async () => {
  const { status, html } = await getDashboard('?desde=2026-13-40');
  assert.equal(status, 200); // nao 500
  assert.match(html, /aviso-alerta/);
  assert.match(html, /inválid/i);
  assert.match(html, /Corrija as datas/); // funil nao e renderizado com data ruim
  assert.ok(!/NaN|Infinity|undefined/.test(html));
});
