'use strict';

// WA3 (incremento 7) — interruptor wa3_ativo no painel /admin/config.
//
// Nasce DESLIGADO (chave ausente = desmarcado), liga e desliga pelo mesmo POST dos outros
// toggles, e a tela diz se o modo e simulacao ou envio real.

const os = require('node:os');
const path = require('node:path');

process.env.DATABASE_PATH = path.join(os.tmpdir(), `vm-test-wa3-config-${process.pid}-${Date.now()}.db`);
process.env.INTERVIEW_MOCK = 'true';
process.env.SESSION_SECRET = 'segredo-de-teste';
process.env.ADMIN_USER = 'admin-teste';
process.env.ADMIN_PASSWORD = 'senha-teste';
process.env.NODE_ENV = 'test';
delete process.env.WA3_MOCK;

const test = require('node:test');
const assert = require('node:assert/strict');

const db = require('../src/db');
const { migrar } = require('../src/db/migrate');
const { criarApp } = require('../src/server');
const wa3 = require('../src/whatsapp/lembreteEntrevistaOutbox');

migrar();

let cookie = '';

async function comServidor(fn) {
  const server = criarApp().listen(0);
  await new Promise((r) => server.once('listening', r));
  try {
    const base = `http://127.0.0.1:${server.address().port}`;
    const res = await fetch(`${base}/admin/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ usuario: 'admin-teste', senha: 'senha-teste' }),
      redirect: 'manual',
    });
    cookie = res.headers.getSetCookie().map((c) => c.split(';')[0]).join('; ');
    return await fn(base);
  } finally {
    await new Promise((r) => server.close(r));
  }
}

const get = async (base, url) => (await fetch(`${base}${url}`, { headers: { Cookie: cookie } })).text();
const post = (base, url, campos) =>
  fetch(`${base}${url}`, {
    method: 'POST',
    headers: { Cookie: cookie, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(campos),
    redirect: 'manual',
  });

test('wa3_ativo nasce desmarcado, e a tela avisa que o modo e simulacao', async () => {
  await comServidor(async (base) => {
    const html = await get(base, '/admin/config');
    assert.match(html, /name="wa3_ativo" value="1">/, 'checkbox deveria vir desmarcado');
    assert.match(html, /Lembretes da entrevista em grupo \(WA3\)/);
    const trecho = html.slice(html.indexOf('name="wa3_ativo"'), html.indexOf('name="wa3_ativo"') + 800);
    assert.match(trecho, /Modo simulação/);
  });
});

test('marcar liga, desmarcar desliga (checkbox ausente = desligar)', async () => {
  await comServidor(async (base) => {
    await post(base, '/admin/config/notificacoes', { wa3_ativo: '1' });
    assert.equal(wa3.ativo({ db }), true);
    assert.match(await get(base, '/admin/config'), /name="wa3_ativo" value="1" checked>/);
    await post(base, '/admin/config/notificacoes', {});
    assert.equal(wa3.ativo({ db }), false);
  });
});

test('salvar OUTRO toggle nao liga o WA3 por tabela', async () => {
  await comServidor(async (base) => {
    await post(base, '/admin/config/notificacoes', { whatsapp_sequencia_ativa: '1' });
    assert.equal(wa3.ativo({ db }), false);
  });
});
