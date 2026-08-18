'use strict';

// Item 3 do ETAPA B "Ajustes no Admin" — Commit 7: nova pagina /admin/divulgacao-vagas,
// com abas Promoção de Vagas / Campanha por WhatsApp (os mesmos fragmentos das telas
// standalone, extraidos nos Commits 5-6 — sem duplicar HTML/logica).
//
// Cobre:
//   1. exige sessao (herda o adminAuth, como as demais rotas do painel);
//   2. sem ?aba (ou com valor invalido), a aba "Promoção de Vagas" e a padrao;
//   3. ?aba=whatsapp mostra o conteudo de Campanha por WhatsApp;
//   4. as duas rotas standalone continuam respondendo normalmente (nao foram substituidas).

const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');

const TMP_DB = path.join(os.tmpdir(), `vm-test-divulgacao-vagas-${process.pid}-${Date.now()}.db`);
process.env.DATABASE_PATH = TMP_DB;
process.env.INTERVIEW_MOCK = 'true';
process.env.SESSION_SECRET = 'segredo-de-teste';
process.env.ADMIN_PASSWORD = 'senha-teste';
process.env.ADMIN_USER = 'admin';
process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert/strict');

const { migrar } = require('../src/db/migrate');
const { criarApp } = require('../src/server');

const SECRET = process.env.SESSION_SECRET;
const SENHA = process.env.ADMIN_PASSWORD;

function cookieAdmin() {
  const sig = crypto.createHmac('sha256', SECRET).update(SENHA).digest('base64').replace(/=+$/, '');
  return `vm_admin=${encodeURIComponent(`s:${SENHA}.${sig}`)}`;
}

async function getHtml(caminho, comAuth = true) {
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

test('GET /admin/divulgacao-vagas sem auth -> redireciona para o login', async () => {
  const r = await getHtml('/admin/divulgacao-vagas', false);
  assert.equal(r.status, 302);
  assert.match(r.location || '', /\/admin\/login/);
});

test('sem ?aba: mostra Promoção de Vagas (aba padrao)', async () => {
  const { status, html } = await getHtml('/admin/divulgacao-vagas');
  assert.equal(status, 200);
  assert.match(html, /Promoção de Vagas/);
  assert.match(html, /Nenhuma campanha criada ainda/);
  // A aba ativa nao usa btn--ghost; a inativa usa.
  assert.match(html, /<a class="btn " href="\/admin\/divulgacao-vagas\?aba=promocao">Promoção de Vagas<\/a>/);
  assert.match(html, /<a class="btn btn--ghost" href="\/admin\/divulgacao-vagas\?aba=whatsapp">Campanha por WhatsApp<\/a>/);
});

test('?aba=invalida cai no padrao (Promoção de Vagas), nao quebra', async () => {
  const { status, html } = await getHtml('/admin/divulgacao-vagas?aba=lixo');
  assert.equal(status, 200);
  assert.match(html, /Promoção de Vagas/);
});

test('?aba=whatsapp mostra Campanha por WhatsApp', async () => {
  const { status, html } = await getHtml('/admin/divulgacao-vagas?aba=whatsapp');
  assert.equal(status, 200);
  assert.match(html, /Campanha por WhatsApp/);
  assert.match(html, /Links dos grupos por praça/);
  assert.match(html, /<a class="btn " href="\/admin\/divulgacao-vagas\?aba=whatsapp">Campanha por WhatsApp<\/a>/);
  assert.match(html, /<a class="btn btn--ghost" href="\/admin\/divulgacao-vagas\?aba=promocao">Promoção de Vagas<\/a>/);
});

test('rotas standalone continuam existindo e respondendo (nao foram substituidas)', async () => {
  const promocao = await getHtml('/admin/promocao');
  assert.equal(promocao.status, 200);
  assert.match(promocao.html, /Promoção de Vagas/);

  const campanha = await getHtml('/admin/campanhas-whatsapp');
  assert.equal(campanha.status, 200);
  assert.match(campanha.html, /Campanha por WhatsApp/);
});
