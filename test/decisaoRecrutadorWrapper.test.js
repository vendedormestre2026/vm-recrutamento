'use strict';

// lib/decisaoRecrutador.js (ETAPA B, Incremento B2): os dois pontos de rota que gravam
// status_recrutador (individual e em lote) passam a chamar aplicarDecisaoRecrutador em vez
// de db.definirStatusRecrutador direto. Este arquivo garante que a TROCA e transparente —
// mesmo comportamento de gravacao de antes, mesmo contrato de retorno — antes de qualquer
// side-effect novo (agendamento da mensagem de reprovacao) entrar nos incrementos seguintes.

const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');

process.env.DATABASE_PATH = path.join(os.tmpdir(), `vm-test-decisao-recrutador-${process.pid}-${Date.now()}.db`);
process.env.INTERVIEW_MOCK = 'true';
process.env.SESSION_SECRET = 'segredo-de-teste';
process.env.ADMIN_USER = 'admin-teste';
process.env.ADMIN_PASSWORD = 'senha-teste';
process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert/strict');

const db = require('../src/db');
const { migrar } = require('../src/db/migrate');
const { criarApp } = require('../src/server');
const decisaoRecrutador = require('../src/lib/decisaoRecrutador');

migrar();

const SECRET = process.env.SESSION_SECRET;
const SENHA = process.env.ADMIN_PASSWORD;
function cookieAdmin() {
  const sig = crypto.createHmac('sha256', SECRET).update(SENHA).digest('base64').replace(/=+$/, '');
  return `vm_admin=${encodeURIComponent(`s:${SENHA}.${sig}`)}`;
}

async function comServidor(fn) {
  const app = criarApp();
  const server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    return await fn({
      async post(url, corpo, headersExtra = {}) {
        // Serializacao manual (nao new URLSearchParams(corpo) direto): um valor array
        // (ex.: ids: [id1, id2]) precisa virar MULTIPLAS entradas com o mesmo nome
        // ("ids=1&ids=2"), do jeito que um <form> com varios checkboxes manda e que o
        // express.urlencoded({extended:true}) sabe juntar de volta num array.
        const params = new URLSearchParams();
        for (const [chave, valor] of Object.entries(corpo)) {
          for (const v of Array.isArray(valor) ? valor : [valor]) params.append(chave, v);
        }
        const res = await fetch(`${base}${url}`, {
          method: 'POST',
          redirect: 'manual',
          headers: {
            Cookie: cookieAdmin(),
            'Content-Type': 'application/x-www-form-urlencoded',
            ...headersExtra,
          },
          body: params.toString(),
        });
        const texto = await res.text();
        let json = null;
        try { json = JSON.parse(texto); } catch { /* nao e JSON, tudo bem */ }
        return { status: res.status, location: res.headers.get('location') || '', json };
      },
    });
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

function run(sql, ...params) {
  return Number(db.getDb().prepare(sql).run(...params).lastInsertRowid);
}

const jobId = run(
  "INSERT INTO jobs (slug, titulo, perfil, ativo) VALUES ('vaga-decisao-recrutador', 'Closer', 'CLOSER', 1)",
);

let seq = 0;
function aplicacao() {
  seq += 1;
  return run(
    `INSERT INTO applications (job_id, nome, telefone, token) VALUES (?, 'Candidato', '+5547900001000', ?)`,
    jobId,
    `tok-decisao-rec-${seq}`,
  );
}

// ── Camada de lib, direto ──

test('aplicarDecisaoRecrutador grava o mesmo valor que db.definirStatusRecrutador gravaria', () => {
  const id = aplicacao();
  const gravado = decisaoRecrutador.aplicarDecisaoRecrutador(id, 'em_analise');
  assert.equal(gravado, 'em_analise');
  assert.equal(db.obterAplicacao(id).status_recrutador, 'em_analise');
});

test('aplicarDecisaoRecrutador com valor fora do enum grava null (mesmo contrato de sempre)', () => {
  const id = aplicacao();
  const gravado = decisaoRecrutador.aplicarDecisaoRecrutador(id, 'lixo-fora-do-enum');
  assert.equal(gravado, null);
  assert.equal(db.obterAplicacao(id).status_recrutador, null);
});

test("aplicarDecisaoRecrutador com 'aprovado' nao lanca e nao grava nada alem da propria coluna", () => {
  const id = aplicacao();
  assert.doesNotThrow(() => decisaoRecrutador.aplicarDecisaoRecrutador(id, 'aprovado'));
  assert.equal(db.obterAplicacao(id).status_recrutador, 'aprovado');
});

test("aplicarDecisaoRecrutador com 'reprovado' nao lanca (agendamento ainda e no-op neste incremento)", () => {
  const id = aplicacao();
  assert.doesNotThrow(() => decisaoRecrutador.aplicarDecisaoRecrutador(id, 'reprovado'));
  assert.equal(db.obterAplicacao(id).status_recrutador, 'reprovado');
});

// ── HTTP: os dois pontos de rota continuam gravando igual ──

test('POST /admin/candidato/:id/status-recrutador (individual, JSON) grava e devolve o valor gravado', async () => {
  const id = aplicacao();
  await comServidor(async ({ post }) => {
    const r = await post(
      `/admin/candidato/${id}/status-recrutador`,
      { status_recrutador: 'reprovado' },
      { 'X-Requested-With': 'fetch' },
    );
    assert.equal(r.status, 200);
    assert.deepEqual(r.json, { ok: true, status_recrutador: 'reprovado' });
    assert.equal(db.obterAplicacao(id).status_recrutador, 'reprovado');
  });
});

test('POST /admin/candidato/:id/status-recrutador (individual, form classico) redireciona e grava', async () => {
  const id = aplicacao();
  await comServidor(async ({ post }) => {
    const r = await post(`/admin/candidato/${id}/status-recrutador`, { status_recrutador: 'aprovado' });
    assert.equal(r.status, 302);
    assert.match(r.location, /ok=status_recrutador/);
    assert.equal(db.obterAplicacao(id).status_recrutador, 'aprovado');
  });
});

test('POST /admin/candidatos/status-recrutador-lote grava o mesmo valor pros ids selecionados', async () => {
  const id1 = aplicacao();
  const id2 = aplicacao();
  await comServidor(async ({ post }) => {
    const r = await post('/admin/candidatos/status-recrutador-lote', {
      ids: [String(id1), String(id2)],
      status_recrutador: 'em_analise',
    });
    assert.equal(r.status, 302);
    assert.match(r.location, /status_recrutador_aplicados=2/);
    assert.equal(db.obterAplicacao(id1).status_recrutador, 'em_analise');
    assert.equal(db.obterAplicacao(id2).status_recrutador, 'em_analise');
  });
});
