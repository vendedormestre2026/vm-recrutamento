'use strict';

// Toggle GLOBAL para os campos LinkedIn e Currículo do formulário público de candidatura
// (ETAPA B, Incremento 2 do diagnóstico de 2026-08-27) — lib/formularioAplicacaoConfig.js,
// routes/pages.js (GET /aplicar/:slug), routes/api.js (POST /api/aplicacao) e a aba nova
// "Formulário de candidatura" em /admin/config.
//
// LinkedIn já era opcional no servidor ANTES deste incremento (api.js nunca validou);
// o que muda pra ele aqui é só a VISIBILIDADE do campo no HTML. Currículo muda os dois:
// visibilidade E obrigatoriedade.
//
// O fallback "(curriculo nao disponivel)" do prompt da Vera (entrevista.js:337,420) para
// currículo ausente já tem teste próprio e não é duplicado aqui — ver
// test/curriculo.test.js: 'montarSystemPrompt com curriculo_texto vazio/null degrada pra
// "(curriculo nao disponivel)", nao quebra'.

const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');

process.env.DATABASE_PATH = path.join(os.tmpdir(), `vm-test-form-toggle-${process.pid}-${Date.now()}.db`);
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
const formularioAplicacaoConfig = require('../src/lib/formularioAplicacaoConfig');

migrar();

db.getDb()
  .prepare(
    "INSERT INTO jobs (slug, titulo, perfil, empresa, ativo) VALUES ('vaga-toggle-form', 'Vaga Toggle Form', 'CLOSER', 'Empresa Teste', 1)",
  )
  .run();

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

const SECRET = process.env.SESSION_SECRET;
const SENHA = process.env.ADMIN_PASSWORD;
function cookieAdmin() {
  const sig = crypto.createHmac('sha256', SECRET).update(SENHA).digest('base64').replace(/=+$/, '');
  return `vm_admin=${encodeURIComponent(`s:${SENHA}.${sig}`)}`;
}

// Volta as duas chaves ao estado "ausente" (default TRUE efetivo) entre testes — mesma
// disciplina de isolamento do resto da suite.
function limparConfig() {
  db.getDb().prepare('DELETE FROM configuracoes WHERE chave IN (?, ?)').run(
    formularioAplicacaoConfig.CHAVE_EXIBIR_LINKEDIN,
    formularioAplicacaoConfig.CHAVE_EXIBIR_CURRICULO,
  );
}

// ══════════════════════════════════════════════════════════════
// 1. lib/formularioAplicacaoConfig — default TRUE, ausência de linha
// ══════════════════════════════════════════════════════════════

test('exibirLinkedin/exibirCurriculo: default TRUE quando a chave nunca foi gravada', () => {
  limparConfig();
  assert.equal(formularioAplicacaoConfig.exibirLinkedin(), true);
  assert.equal(formularioAplicacaoConfig.exibirCurriculo(), true);
});

test('exibirLinkedin/exibirCurriculo: respeitam o valor gravado', () => {
  db.definirConfigBool(formularioAplicacaoConfig.CHAVE_EXIBIR_LINKEDIN, false);
  db.definirConfigBool(formularioAplicacaoConfig.CHAVE_EXIBIR_CURRICULO, false);
  assert.equal(formularioAplicacaoConfig.exibirLinkedin(), false);
  assert.equal(formularioAplicacaoConfig.exibirCurriculo(), false);
  limparConfig();
});

// ══════════════════════════════════════════════════════════════
// 2. GET /aplicar/:slug — HTML reflete o toggle
// ══════════════════════════════════════════════════════════════

test('GET /aplicar/:slug: por padrão os dois campos aparecem (comportamento de sempre)', async () => {
  limparConfig();
  await comServidor(async (base) => {
    const res = await fetch(`${base}/aplicar/vaga-toggle-form`);
    const html = await res.text();
    assert.equal(res.status, 200);
    assert.match(html, /name="linkedin_url"/);
    assert.match(html, /name="curriculo"/);
    assert.match(html, /Currículo<span class="vm-obrigatorio"/);
    assert.match(html, /nome, e-mail, telefone, LinkedIn e\s*\n?\s*currículo/);
  });
});

test('GET /aplicar/:slug: LinkedIn desativado — campo some, currículo continua', async () => {
  db.definirConfigBool(formularioAplicacaoConfig.CHAVE_EXIBIR_LINKEDIN, false);
  await comServidor(async (base) => {
    const html = await (await fetch(`${base}/aplicar/vaga-toggle-form`)).text();
    assert.doesNotMatch(html, /name="linkedin_url"/);
    assert.match(html, /name="curriculo"/);
  });
  limparConfig();
});

test('GET /aplicar/:slug: Currículo desativado — campo some, asterisco/obrigatório some, LinkedIn continua', async () => {
  db.definirConfigBool(formularioAplicacaoConfig.CHAVE_EXIBIR_CURRICULO, false);
  await comServidor(async (base) => {
    const html = await (await fetch(`${base}/aplicar/vaga-toggle-form`)).text();
    assert.doesNotMatch(html, /name="curriculo"/);
    assert.doesNotMatch(html, /data-upload/);
    assert.match(html, /name="linkedin_url"/);
    // Texto de consentimento nao pode mais citar "currículo".
    assert.doesNotMatch(html, /nome, e-mail, telefone, LinkedIn e\s*\n?\s*currículo/);
    assert.match(html, /nome, e-mail, telefone e LinkedIn/);
  });
  limparConfig();
});

test('GET /aplicar/:slug: os dois desativados — nenhum aparece, consentimento cita so os 3 campos fixos', async () => {
  db.definirConfigBool(formularioAplicacaoConfig.CHAVE_EXIBIR_LINKEDIN, false);
  db.definirConfigBool(formularioAplicacaoConfig.CHAVE_EXIBIR_CURRICULO, false);
  await comServidor(async (base) => {
    const html = await (await fetch(`${base}/aplicar/vaga-toggle-form`)).text();
    assert.doesNotMatch(html, /name="linkedin_url"/);
    assert.doesNotMatch(html, /name="curriculo"/);
    assert.match(html, /nome, e-mail e telefone/);
  });
  limparConfig();
});

// ══════════════════════════════════════════════════════════════
// 3. POST /api/aplicacao — obrigatoriedade de currículo segue a config
// ══════════════════════════════════════════════════════════════

function formularioSemArquivo(email) {
  const fd = new FormData();
  fd.set('slug', 'vaga-toggle-form');
  fd.set('nome', 'Candidata');
  fd.set('sobrenome', 'Teste');
  fd.set('email', email);
  fd.set('ddi', '+55');
  fd.set('telefone', '11940670469');
  fd.set('consentimento', '1');
  // SEM 'curriculo' no FormData — simula o campo ausente do form (toggle desligado no
  // cliente) OU um POST direto adulterado (o servidor tem que decidir sozinho, sem confiar
  // no HTML).
  return fd;
}

const buscarPorEmail = (email) => db.getDb().prepare('SELECT * FROM applications WHERE email = ?').get(email);

test('POST /api/aplicacao SEM currículo: config default (ligada) recusa com 400', async () => {
  limparConfig();
  await comServidor(async (base) => {
    const email = 'sem-curriculo.padrao@teste.com';
    const res = await fetch(`${base}/api/aplicacao`, { method: 'POST', body: formularioSemArquivo(email) });
    const corpo = await res.json();
    assert.equal(res.status, 400);
    assert.match(corpo.erro, /currículo/i);
    assert.equal(buscarPorEmail(email), undefined, 'nao pode ter criado candidatura');
  });
});

test('POST /api/aplicacao SEM currículo: config desativada aceita — curriculo_path/curriculo_texto vazios', async () => {
  db.definirConfigBool(formularioAplicacaoConfig.CHAVE_EXIBIR_CURRICULO, false);
  await comServidor(async (base) => {
    const email = 'sem-curriculo.desativado@teste.com';
    const res = await fetch(`${base}/api/aplicacao`, { method: 'POST', body: formularioSemArquivo(email) });
    const corpo = await res.json();
    assert.equal(res.status, 200, JSON.stringify(corpo));
    assert.equal(corpo.ok, true);

    const app = buscarPorEmail(email);
    assert.ok(app, 'candidatura precisa ter sido criada mesmo sem currículo');
    assert.equal(app.curriculo_path, null);
    assert.equal(app.curriculo_texto, null);
  });
  limparConfig();
});

test('POST /api/aplicacao: currículo desativado mas ENVIADO mesmo assim ainda é salvo normalmente', async () => {
  // Nao ha punicao por mandar o arquivo de qualquer forma (ex.: cliente com cache antigo
  // do form, ou um POST direto) — a config so torna o campo NAO OBRIGATORIO, nunca proibido.
  db.definirConfigBool(formularioAplicacaoConfig.CHAVE_EXIBIR_CURRICULO, false);
  await comServidor(async (base) => {
    const email = 'com-curriculo.mesmo-desativado@teste.com';
    const fd = formularioSemArquivo(email);
    fd.set('curriculo', new Blob(['conteudo fake'], { type: 'application/pdf' }), 'curriculo.pdf');
    const res = await fetch(`${base}/api/aplicacao`, { method: 'POST', body: fd });
    assert.equal(res.status, 200);

    const app = buscarPorEmail(email);
    assert.match(app.curriculo_path, /\.pdf$/);
  });
  limparConfig();
});

// ══════════════════════════════════════════════════════════════
// 4. /admin/config — aba nova, leitura e escrita
// ══════════════════════════════════════════════════════════════

test('GET /admin/config: aba "Formulário de candidatura" existe com os 2 checkboxes, marcados por padrão', async () => {
  limparConfig();
  await comServidor(async (base) => {
    const res = await fetch(`${base}/admin/config`, { headers: { Cookie: cookieAdmin() } });
    const html = await res.text();
    assert.equal(res.status, 200);
    assert.match(html, /data-tab-btn="formulario"/);
    assert.match(html, /<div data-tab-painel="formulario" hidden>/);
    assert.match(
      html,
      /<input type="checkbox" form="form-notificacoes" name="formulario_exibir_linkedin" value="1" checked>/,
    );
    assert.match(
      html,
      /<input type="checkbox" form="form-notificacoes" name="formulario_exibir_curriculo" value="1" checked>/,
    );
  });
});

test('POST /admin/config/notificacoes: desmarcar os 2 grava false; recarregar mostra desmarcado', async () => {
  limparConfig();
  await comServidor(async (base) => {
    // Envia SEM os dois campos (checkbox desmarcado nao manda o par name=value) — o handler
    // trata ausencia como false, mesmo contrato das outras 8 chaves ja existentes.
    const res = await fetch(`${base}/admin/config/notificacoes`, {
      method: 'POST',
      headers: { Cookie: cookieAdmin(), 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({}),
      redirect: 'manual',
    });
    assert.equal(res.status, 302);
  });

  assert.equal(formularioAplicacaoConfig.exibirLinkedin(), false);
  assert.equal(formularioAplicacaoConfig.exibirCurriculo(), false);

  await comServidor(async (base) => {
    const html = await (
      await fetch(`${base}/admin/config`, { headers: { Cookie: cookieAdmin() } })
    ).text();
    assert.doesNotMatch(html, /name="formulario_exibir_linkedin" value="1" checked/);
    assert.doesNotMatch(html, /name="formulario_exibir_curriculo" value="1" checked/);
  });

  limparConfig();
});
