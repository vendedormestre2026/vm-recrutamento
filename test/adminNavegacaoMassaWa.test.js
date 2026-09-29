'use strict';

// Navegacao ate o disparo em massa (Baileys) sem digitar URL.
//
// O painel nao tem menu global: o menu principal sao os botoes do topo de /admin, e as
// campanhas ficam agrupadas no hub /admin/divulgacao-vagas. Este teste trava o caminho
//   /admin -> Divulgação de Vagas -> Disparo em massa (Baileys) -> campanha / nova
// e os atalhos laterais (/admin/whatsapp -> massa, massa -> Configurações). Se algum link
// sumir, a tela volta a ser alcancavel so pela URL — que e o problema que isto evita.
//
// Cobre tambem: as telas de pagina do massa exigem login (herdam o adminAuth).

const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');

process.env.DATABASE_PATH = path.join(os.tmpdir(), `vm-test-nav-massa-${process.pid}-${Date.now()}.db`);
process.env.INTERVIEW_MOCK = 'true';
process.env.SESSION_SECRET = 'segredo-de-teste';
process.env.ADMIN_PASSWORD = 'senha-teste';
process.env.ADMIN_USER = 'admin';
process.env.WHATSAPP_SECRETS_KEY = 'e'.repeat(64);
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

test('menu principal (/admin) leva ao hub Divulgação de Vagas', async () => {
  const { status, html } = await get('/admin');
  assert.equal(status, 200);
  assert.match(html, /href="\/admin\/divulgacao-vagas">Divulgação de Vagas</);
});

test('hub Divulgação de Vagas tem o item "Disparo em massa (Baileys)"', async () => {
  const { status, html } = await get('/admin/divulgacao-vagas');
  assert.equal(status, 200);
  assert.match(html, /<a class="btn btn--ghost" href="\/admin\/massa-wa">Disparo em massa \(Baileys\)<\/a>/);
});

test('/admin/whatsapp tem atalho para o disparo em massa', async () => {
  const { status, html } = await get('/admin/whatsapp');
  assert.equal(status, 200);
  assert.match(html, /href="\/admin\/massa-wa">Disparo em massa \(Baileys\)</);
});

test('/admin/massa-wa: Configurações no topo e caminho para "nova"', async () => {
  const { status, html } = await get('/admin/massa-wa');
  assert.equal(status, 200);
  const topo = html.slice(0, html.indexOf('<h1'));
  assert.match(topo, /href="\/admin\/config">Configurações</, 'link para Configurações precisa vir antes do título');
  assert.match(html, /href="\/admin\/massa-wa\/nova"/);
});

test('telas de pagina do massa exigem login de admin', async () => {
  for (const url of ['/admin/massa-wa', '/admin/massa-wa/nova', '/admin/massa-wa/1']) {
    const r = await get(url, false);
    assert.equal(r.status, 302, `${url} respondeu ${r.status} sem login`);
    assert.match(r.location || '', /\/admin\/login/);
  }
});

// ── O INTERRUPTOR massa_wa_ativa EM /admin/config ──
// A tela do massa manda o operador ligar o disparo "em Configurações". Sem esta caixa, nao havia
// como ligar pelo painel.

async function postForm(caminho, campos) {
  const app = criarApp();
  const server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  try {
    const res = await fetch(`http://127.0.0.1:${server.address().port}${caminho}`, {
      method: 'POST',
      headers: { Cookie: cookieAdmin(), 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(campos),
      redirect: 'manual',
    });
    return res.status;
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

test('/admin/config tem a caixa do disparo em massa, desligada por padrao e avisando o MOCK', async () => {
  const { status, html } = await get('/admin/config');
  assert.equal(status, 200);
  assert.match(html, /name="massa_wa_ativa" value="1">/, 'a caixa existe e nasce desmarcada');
  assert.match(html, /Disparo em massa \(Baileys\)/);
  assert.match(html, /Modo simulação:<\/b> nenhuma mensagem chega aos candidatos/);
  assert.doesNotMatch(html, /Envio real:<\/b>/);
});

test('salvar Configuracoes liga e desliga massa_wa_ativa', async () => {
  const db = require('../src/db');
  const { CHAVE_ATIVO } = require('../src/whatsapp/massaOutbox');

  assert.equal(await postForm('/admin/config/notificacoes', { massa_wa_ativa: '1' }), 302);
  assert.equal(db.obterConfigBool(CHAVE_ATIVO, false), true);
  const { html } = await get('/admin/config');
  assert.match(html, /name="massa_wa_ativa" value="1" checked>/);

  // Checkbox desmarcado = campo ausente = desligar.
  assert.equal(await postForm('/admin/config/notificacoes', {}), 302);
  assert.equal(db.obterConfigBool(CHAVE_ATIVO, false), false);
});
