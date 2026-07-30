'use strict';

// POST /admin/candidato/:id/reprocessar — reprocessamento manual da avaliacao pelo painel.
//
// Promove para uma rota o que antes exigia `node -e` via railway ssh. O que importa testar
// aqui e a ROTA (guarda de estado + lock + disparo), nao o gerarRelatorio em si — esse ja
// e coberto por test/relatorio.test.js. Por isso gerarRelatorio e SUBSTITUIDO por um fake:
// nenhuma chamada de LLM, nenhum e-mail, e controle total sobre quando a promise resolve
// (essencial para o cenario 3, que precisa de uma execucao ainda pendente).
//
// A troca funciona porque a rota faz `require('../lib/relatorio')` DENTRO do handler e
// desestrutura na hora da chamada: mexer no objeto do modulo em cache basta.
//
// Cobre:
//   1. estado invalido (report 'enviado' | entrevista nao concluida | sem entrevista)
//      -> rejeita e NAO chama gerarRelatorio;
//   2. estado valido (sem report, e tambem report em 'erro')
//      -> grava status_ia='processando' e chama gerarRelatorio 1x com o interviewId certo;
//   3. segunda requisicao com a primeira ainda em curso -> rejeitada, total continua 1;
//      e, terminada a primeira, o lock e liberado.

const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');

const TMP_DB = path.join(os.tmpdir(), `vm-test-reprocessar-${process.pid}-${Date.now()}.db`);
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
const relatorio = require('../src/lib/relatorio');

const SECRET = process.env.SESSION_SECRET;
const SENHA = process.env.ADMIN_PASSWORD;

function cookieAdmin() {
  const sig = crypto.createHmac('sha256', SECRET).update(SENHA).digest('base64').replace(/=+$/, '');
  return `vm_admin=${encodeURIComponent(`s:${SENHA}.${sig}`)}`;
}

// ── Fake de gerarRelatorio ──
// Registra as chamadas e devolve uma promise que SO resolve quando o teste mandar, para
// que o cenario 3 encontre o lock realmente ocupado.
const chamadas = [];
let resolverPendente = null;

relatorio.gerarRelatorio = function gerarRelatorioFake(interviewId) {
  chamadas.push(interviewId);
  return new Promise((resolve) => {
    resolverPendente = () => resolve({ id: 999, interview_id: interviewId, status: 'enviado' });
  });
};

// Conclui a execucao pendente e cede o event loop para o .finally() da rota rodar
// (e o lock ser liberado) antes da proxima assercao.
async function concluirPendente() {
  if (resolverPendente) {
    resolverPendente();
    resolverPendente = null;
  }
  await new Promise((resolve) => setImmediate(resolve));
}

// ── Insercao direta (mesmo padrao de dashboard.test.js) ──
migrar();

function run(sql, ...params) {
  return Number(db.getDb().prepare(sql).run(...params).lastInsertRowid);
}

const jobId = run(
  "INSERT INTO jobs (slug, titulo, perfil) VALUES ('vaga-teste', 'Vaga de Teste', 'CLOSER')",
);

let seq = 0;
function aplicacao(status, statusIa = null) {
  seq += 1;
  return run(
    'INSERT INTO applications (job_id, nome, status, status_ia, token) VALUES (?, ?, ?, ?, ?)',
    jobId,
    `Candidato ${seq}`,
    status,
    statusIa,
    `tok-app-${seq}`,
  );
}

function entrevista(appId, status = 'concluido') {
  return run(
    "INSERT INTO interviews (application_id, perfil, status, finalizado_em) VALUES (?, 'CLOSER', ?, datetime('now'))",
    appId,
    status,
  );
}

let seqRep = 0;
function report(interviewId, status, extras = {}) {
  seqRep += 1;
  return run(
    'INSERT INTO reports (interview_id, token, status, resumo, erro_mensagem, erro_em) VALUES (?, ?, ?, ?, ?, ?)',
    interviewId,
    // Report de erro nasce com token NULL (nao ha pagina publica); os demais tem token.
    status === 'erro' ? null : `tok-rep-${seqRep}`,
    status,
    extras.resumo || null,
    extras.erro_mensagem || null,
    extras.erro_em || null,
  );
}

// ── Disparo da rota ──
// `comoFetch` escolhe entre as duas respostas da rota: com o header X-Requested-With
// vem JSON (status 200/409, facil de assertar); sem ele vem o redirect do form classico.
async function postReprocessar(appId, { comoFetch = true } = {}) {
  const app = criarApp();
  const server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const headers = { Cookie: cookieAdmin() };
    if (comoFetch) headers['X-Requested-With'] = 'fetch';
    const res = await fetch(`${base}/admin/candidato/${appId}/reprocessar`, {
      method: 'POST',
      headers,
      redirect: 'manual',
    });
    const corpo = comoFetch ? await res.json().catch(() => null) : null;
    return { status: res.status, location: res.headers.get('location'), corpo };
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

function statusIaDe(appId) {
  return db.getDb().prepare('SELECT status_ia FROM applications WHERE id = ?').get(appId).status_ia;
}

// ──────────────────── 1) Estado invalido -> rejeita, sem chamar o LLM ────────────────────

test('rejeita quando ja existe report enviado (nao ha o que reprocessar)', async () => {
  const antes = chamadas.length;
  const appId = aplicacao('concluido', 'talvez');
  const iid = entrevista(appId);
  report(iid, 'enviado', { resumo: 'Avaliacao ok.' });

  const res = await postReprocessar(appId);

  assert.equal(res.status, 409);
  assert.equal(res.corpo.ok, false);
  assert.equal(chamadas.length, antes, 'gerarRelatorio NAO deveria ter sido chamado');
  assert.equal(statusIaDe(appId), 'talvez', 'status_ia nao pode ser sobrescrito na recusa');
});

test('rejeita quando a candidatura ainda nao esta concluida', async () => {
  const antes = chamadas.length;
  const appId = aplicacao('em_entrevista');
  entrevista(appId, 'iniciada');

  const res = await postReprocessar(appId);

  assert.equal(res.status, 409);
  assert.equal(chamadas.length, antes);
  assert.equal(statusIaDe(appId), null);
});

test('rejeita quando nao ha entrevista nenhuma', async () => {
  const antes = chamadas.length;
  const appId = aplicacao('concluido');

  const res = await postReprocessar(appId);

  assert.equal(res.status, 409);
  assert.equal(chamadas.length, antes);
});

test('candidato inexistente -> 404, sem chamar gerarRelatorio', async () => {
  const antes = chamadas.length;
  const res = await postReprocessar(999999);

  assert.equal(res.status, 404);
  assert.equal(chamadas.length, antes);
});

test('form classico (sem X-Requested-With) recusado -> redirect com o erro na query', async () => {
  const antes = chamadas.length;
  const appId = aplicacao('concluido', 'descartar');
  const iid = entrevista(appId);
  report(iid, 'enviado', { resumo: 'Avaliacao ok.' });

  const res = await postReprocessar(appId, { comoFetch: false });

  assert.equal(res.status, 302);
  assert.equal(res.location, `/admin/candidato/${appId}?erro=reprocessar_estado`);
  assert.equal(chamadas.length, antes);
});

// ──────────────────── 2) Estado valido -> grava e dispara ────────────────────

test('sem report -> grava status_ia=processando e dispara gerarRelatorio uma vez', async () => {
  const antes = chamadas.length;
  const appId = aplicacao('concluido', 'erro'); // o caso da interview 84 (falha antiga)
  const iid = entrevista(appId);

  const res = await postReprocessar(appId);

  assert.equal(res.status, 200);
  assert.deepEqual(res.corpo, { ok: true, status: 'processando' });
  assert.equal(chamadas.length, antes + 1, 'gerarRelatorio deveria ter sido chamado 1x');
  assert.equal(chamadas[chamadas.length - 1], iid, 'chamado com o interviewId correto');
  assert.equal(statusIaDe(appId), 'processando');

  await concluirPendente();
});

test('report em erro -> tambem e reprocessavel', async () => {
  const antes = chamadas.length;
  const appId = aplicacao('concluido', 'erro');
  const iid = entrevista(appId);
  report(iid, 'erro', {
    erro_mensagem: 'Tempo esgotado ao chamar LLM (relatorio) (> 120000ms).',
    erro_em: '2026-07-29 22:54:52',
  });

  const res = await postReprocessar(appId);

  assert.equal(res.status, 200);
  assert.equal(chamadas.length, antes + 1);
  assert.equal(chamadas[chamadas.length - 1], iid);
  assert.equal(statusIaDe(appId), 'processando');

  await concluirPendente();
});

test('form classico aceito -> redirect com ?ok=reprocessando', async () => {
  const antes = chamadas.length;
  const appId = aplicacao('concluido', 'erro');
  entrevista(appId);

  const res = await postReprocessar(appId, { comoFetch: false });

  assert.equal(res.status, 302);
  assert.equal(res.location, `/admin/candidato/${appId}?ok=reprocessando`);
  assert.equal(chamadas.length, antes + 1);

  await concluirPendente();
});

// ──────────────────── 3) Lock: segunda requisicao em curso ────────────────────

test('segunda requisicao com a primeira em curso -> rejeitada, total continua 1', async () => {
  const antes = chamadas.length;
  const appId = aplicacao('concluido', 'erro');
  const iid = entrevista(appId);

  const primeira = await postReprocessar(appId);
  assert.equal(primeira.status, 200);
  assert.equal(chamadas.length, antes + 1);

  // A primeira execucao segue PENDENTE (o fake ainda nao resolveu), entao o lock esta ativo.
  const segunda = await postReprocessar(appId);
  assert.equal(segunda.status, 409, 'duplo clique deve ser recusado');
  assert.equal(segunda.corpo.ok, false);
  assert.equal(chamadas.length, antes + 1, 'nenhuma segunda chamada ao LLM');
  assert.equal(statusIaDe(appId), 'processando');

  // Terminada a primeira, o .finally() da rota libera o lock e um novo pedido passa
  // (o fake nao grava report, entao o estado do banco continua "reprocessavel").
  await concluirPendente();
  const terceira = await postReprocessar(appId);
  assert.equal(terceira.status, 200, 'lock liberado apos a conclusao');
  assert.equal(chamadas.length, antes + 2);
  assert.equal(chamadas[chamadas.length - 1], iid);

  await concluirPendente();
});

test('duas entrevistas diferentes nao disputam o mesmo lock', async () => {
  const antes = chamadas.length;
  const appA = aplicacao('concluido', 'erro');
  const iidA = entrevista(appA);
  const appB = aplicacao('concluido', 'erro');
  const iidB = entrevista(appB);

  const resA = await postReprocessar(appA);
  assert.equal(resA.status, 200);
  // O lock e por interviewId: B nao pode ser bloqueado por A estar em curso.
  const resB = await postReprocessar(appB);
  assert.equal(resB.status, 200);

  assert.equal(chamadas.length, antes + 2);
  assert.deepEqual(chamadas.slice(-2), [iidA, iidB]);

  await concluirPendente();
});
