'use strict';

// Navegacao ate /admin/convites-sem-data sem digitar URL.
//
// Os avisos que ja apontavam para a tela (listagem de vagas, ficha do candidato) so aparecem
// quando ha vaga sem reuniao ou candidato com fallback — sem isso a tela ficava sem caminho.
// O item fixo no menu principal (/admin) resolve; este teste falha se ele sumir.
//
// Cobre tambem: a tela exige login (herda o adminAuth).

const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');

process.env.DATABASE_PATH = path.join(os.tmpdir(), `vm-test-nav-convites-${process.pid}-${Date.now()}.db`);
process.env.INTERVIEW_MOCK = 'true';
process.env.SESSION_SECRET = 'segredo-de-teste';
process.env.ADMIN_PASSWORD = 'senha-teste';
process.env.ADMIN_USER = 'admin';
process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert/strict');

const { migrar } = require('../src/db/migrate');
const { criarApp } = require('../src/server');

function cookieAdmin() {
  const senha = process.env.ADMIN_PASSWORD;
  const sig = crypto.createHmac('sha256', process.env.SESSION_SECRET).update(senha).digest('base64').replace(/=+$/, '');
  return `vm_admin=${encodeURIComponent(`s:${senha}.${sig}`)}`;
}

async function get(caminho, comAuth = true) {
  const app = criarApp();
  const server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const opts = comAuth ? { headers: { Cookie: cookieAdmin() } } : { redirect: 'manual' };
    const res = await fetch(`${base}${caminho}`, opts);
    return { status: res.status, location: res.headers.get('location'), html: res.status < 300 ? await res.text() : '' };
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

test.before(() => {
  migrar();
});

test('menu principal (/admin) tem o item "Convites sem data", mesmo sem nenhum fallback', async () => {
  const { status, html } = await get('/admin');
  assert.equal(status, 200);
  assert.match(html, /<a class="btn btn--ghost" href="\/admin\/convites-sem-data">Convites sem data<\/a>/);
});

test('/admin/convites-sem-data abre com login', async () => {
  const { status, html } = await get('/admin/convites-sem-data');
  assert.equal(status, 200);
  assert.match(html, /<h1>Convites sem data<\/h1>/);
});

test('/admin/convites-sem-data exige login de admin', async () => {
  const r = await get('/admin/convites-sem-data', false);
  assert.equal(r.status, 302);
  assert.match(r.location || '', /\/admin\/login/);
});
