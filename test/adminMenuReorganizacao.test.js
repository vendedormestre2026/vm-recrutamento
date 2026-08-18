'use strict';

// Item 3 do ETAPA B "Ajustes no Admin" — Commit 4: reorganizacao do menu principal.
//
// Cobre:
//   1. menu principal (/admin) NAO tem mais "Ver aprovados pela IA", "Editar roteiro",
//      "Perfis de currículo", "WhatsApp (pareamento)" nem "Custos / Uso API";
//   2. menu principal continua com Funil de Conversão, Vagas, Banco de talentos,
//      Promoção de Vagas, Campanha por WhatsApp e Configurações (estas duas ultimas
//      substituidas por "Divulgação de Vagas" so no Commit 7);
//   3. /admin/config ganhou uma secao de links para as 4 telas que sairam do menu.
//
// Nao cobre o FILTRO "Aprovados pela IA" em si (select de status_ia) — so o item de
// menu-atalho, que era redundante com ele (ver diagnostico ETAPA A, Item 3).

const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');

const TMP_DB = path.join(os.tmpdir(), `vm-test-admin-menu-${process.pid}-${Date.now()}.db`);
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

async function getHtml(caminho) {
  const app = criarApp();
  const server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const res = await fetch(`${base}${caminho}`, { headers: { Cookie: cookieAdmin() } });
    return { status: res.status, html: await res.text() };
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

test.before(() => {
  migrar();
});

test('menu principal (/admin): itens movidos/removidos nao aparecem mais como atalho', async () => {
  const { status, html } = await getHtml('/admin');
  assert.equal(status, 200);

  assert.ok(!html.includes('>Ver aprovados pela IA<'), '"Ver aprovados pela IA" precisa ter sido removido');
  assert.ok(!html.includes('>Editar roteiro<'), '"Editar roteiro" precisa ter saido do menu principal');
  assert.ok(!html.includes('>Perfis de currículo<'), '"Perfis de currículo" precisa ter saido do menu principal');
  assert.ok(!html.includes('>WhatsApp (pareamento)<'), '"WhatsApp (pareamento)" precisa ter saido do menu principal');
  assert.ok(
    !html.includes('>Custos / Uso API<') && !html.includes('>Custos/Uso API<'),
    '"Custos / Uso API" precisa ter saido do menu principal',
  );
});

test('menu principal (/admin): os itens que continuam ainda aparecem', async () => {
  const { html } = await getHtml('/admin');

  assert.match(html, /href="\/admin\/dashboard">Funil de Conversão</);
  assert.match(html, /href="\/admin\/vagas">Vagas</);
  assert.match(html, /href="\/admin\/talentos">Banco de talentos</);
  assert.match(html, /href="\/admin\/promocao">Promoção de Vagas</);
  assert.match(html, /href="\/admin\/campanhas-whatsapp">Campanha por WhatsApp</);
  assert.match(html, /href="\/admin\/config">Configurações</);
});

test('/admin/config: ganhou links para as 4 telas que sairam do menu principal', async () => {
  const { status, html } = await getHtml('/admin/config');
  assert.equal(status, 200);

  assert.match(html, /href="\/admin\/roteiro">Editar roteiro</);
  assert.match(html, /href="\/admin\/perfis-curriculo">Perfis de currículo</);
  assert.match(html, /href="\/admin\/whatsapp">WhatsApp \(pareamento\)</);
  assert.match(html, /href="\/admin\/uso">Custos \/ Uso API</);
});
