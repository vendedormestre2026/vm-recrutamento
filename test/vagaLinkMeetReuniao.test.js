'use strict';

// WA3 (incremento 1) — o link da SALA do Google Meet (jobs.link_meet_reuniao), ponta a ponta
// pelo painel.
//
// ── POR QUE HTTP ──
// criarVaga e atualizarVaga escrevem por lista LITERAL de colunas: um campo pode estar no
// formulario, ser lido no POST e nunca chegar ao banco, sem erro nenhum. So a ida e volta pela
// rota pega isso (mesmo motivo de test/vagaEntrevistaGrupo.test.js).
//
// E o campo NOVO nao pode se confundir com o antigo: link_meet guarda o Calendly, e o lembrete
// precisa dos dois, cada um no seu lugar.

const os = require('node:os');
const path = require('node:path');

process.env.DATABASE_PATH = path.join(
  os.tmpdir(),
  `vm-test-vaga-link-meet-reuniao-${process.pid}-${Date.now()}.db`,
);
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

migrar();

const CALENDLY = 'https://calendly.com/vendedor-mestre/entrevista';
const MEET = 'https://meet.google.com/abc-defg-hij';

let cookieAdmin = '';

async function comServidor(fn) {
  const app = criarApp();
  const server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  try {
    return await fn(`http://127.0.0.1:${server.address().port}`);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

async function autenticar(base) {
  const res = await fetch(`${base}/admin/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ usuario: 'admin-teste', senha: 'senha-teste' }),
    redirect: 'manual',
  });
  const bruto = res.headers.getSetCookie ? res.headers.getSetCookie() : [res.headers.get('set-cookie')];
  cookieAdmin = bruto.filter(Boolean).map((c) => c.split(';')[0]).join('; ');
  assert.ok(cookieAdmin.includes('vm_admin'));
}

const comAuth = (extra = {}) => ({ Cookie: cookieAdmin, ...extra });

function corpoVaga(extra = {}) {
  return new URLSearchParams({
    titulo: 'Vaga de Teste',
    perfil: 'CLOSER',
    descricao: 'Descricao',
    ativo: 'on',
    ...extra,
  });
}

async function postar(base, url, extra) {
  const res = await fetch(`${base}${url}`, {
    method: 'POST',
    headers: comAuth({ 'Content-Type': 'application/x-www-form-urlencoded' }),
    body: corpoVaga(extra),
    redirect: 'manual',
  });
  assert.ok(res.status < 400, `POST ${url} devolveu ${res.status}`);
}

const ultimaVaga = () => db.getDb().prepare('SELECT * FROM jobs ORDER BY id DESC LIMIT 1').get();
const vagaPorId = (id) => db.getDb().prepare('SELECT * FROM jobs WHERE id = ?').get(id);

test('o formulario de nova vaga oferece o campo da sala do Meet, separado do Calendly', async () => {
  await comServidor(async (base) => {
    await autenticar(base);
    const html = await (await fetch(`${base}/admin/vagas/nova`, { headers: comAuth() })).text();
    assert.match(html, /name="link_meet_reuniao"/);
    assert.match(html, /Link da sala da entrevista \(Google Meet\)/);
    assert.match(html, /name="link_meet"/);
    assert.match(html, /Link para confirmar presença \(Calendly\)/);
  });
});

test('criar pelo formulario grava a sala do Meet e o Calendly, cada um na sua coluna', async () => {
  await comServidor(async (base) => {
    await autenticar(base);
    await postar(base, '/admin/vagas', { link_meet: CALENDLY, link_meet_reuniao: `  ${MEET}  ` });
    const vaga = ultimaVaga();
    assert.equal(vaga.link_meet_reuniao, MEET, 'sala do Meet nao persistiu (ou nao foi trimada)');
    assert.equal(vaga.link_meet, CALENDLY);
  });
});

test('editar pelo formulario troca a sala, e o valor aparece de volta no form', async () => {
  await comServidor(async (base) => {
    await autenticar(base);
    await postar(base, '/admin/vagas', { link_meet: CALENDLY, link_meet_reuniao: MEET });
    const id = ultimaVaga().id;
    const nova = 'https://meet.google.com/xyz-wxyz-xyz';
    await postar(base, `/admin/vagas/${id}`, { link_meet: CALENDLY, link_meet_reuniao: nova });
    assert.equal(vagaPorId(id).link_meet_reuniao, nova);
    assert.equal(vagaPorId(id).link_meet, CALENDLY);

    const html = await (await fetch(`${base}/admin/vagas/${id}`, { headers: comAuth() })).text();
    assert.match(html, new RegExp(`name="link_meet_reuniao" value="${nova.replace(/[.]/g, '\\.')}"`));
  });
});

test('apagar o campo na edicao grava NULL (vaga sem sala = sem lembrete)', async () => {
  await comServidor(async (base) => {
    await autenticar(base);
    await postar(base, '/admin/vagas', { link_meet_reuniao: MEET });
    const id = ultimaVaga().id;
    await postar(base, `/admin/vagas/${id}`, { link_meet_reuniao: '' });
    assert.equal(vagaPorId(id).link_meet_reuniao, null);
  });
});
