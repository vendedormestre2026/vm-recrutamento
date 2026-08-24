'use strict';

// Estrutura HTML dos formularios de vaga (criacao e edicao): o botao "Criar vaga"/
// "Salvar alterações" precisa estar de fato dentro de um <form>, e o mini-form de
// "Cadastrar cidade nova" precisa ser um <form> separado — nao aninhado dentro do
// principal.
//
// ── POR QUE ESTE TESTE, E NAO SO "PARECE CERTO VISUALMENTE" ──
// HTML nao permite <form> dentro de <form>: o parser do navegador ignora a tag <form>
// interna e fecha o form EXTERNO no primeiro </form> que encontrar. O sintoma nao aparece
// olhando o HTML bruto (o texto continua parecendo dois <form> completos), nem com um
// `assert.match(html, /<form.../)` simples — so aparece depois que um parser de verdade
// resolve a arvore DOM, exatamente como o navegador faz. Foi assim que o cadastro de vaga
// ficou quebrado em producao por dias sem nenhum erro (investigacao de 2026-08-24): o
// botao "Criar vaga" ficava sem <form> associado, e o clique nao disparava nenhuma
// requisicao — sem navegacao, sem erro.

const os = require('node:os');
const path = require('node:path');

process.env.DATABASE_PATH = path.join(os.tmpdir(), `vm-test-vaga-form-${process.pid}-${Date.now()}.db`);
process.env.INTERVIEW_MOCK = 'true';
process.env.SESSION_SECRET = 'segredo-de-teste';
process.env.ADMIN_USER = 'admin-teste';
process.env.ADMIN_PASSWORD = 'senha-teste';
process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');

const db = require('../src/db');
const { migrar } = require('../src/db/migrate');
const { criarApp } = require('../src/server');

migrar();

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

// Parseia `html` com um parser HTML de verdade (jsdom) e confirma: o botao de submit
// principal (`rotuloBotaoPrincipal`) esta associado a um <form>; existe um <form>
// SEPARADO para "Cadastrar cidade", com a action esperada, e ele nao e o mesmo form do
// botao principal (ou seja, nao foi absorvido por ele).
function assertFormularioNaoAninhado(html, { rotuloBotaoPrincipal, actionCidadeEsperada }) {
  const dom = new JSDOM(html);
  const doc = dom.window.document;

  const botoes = [...doc.querySelectorAll('button[type="submit"]')];

  const btnPrincipal = botoes.find((b) => b.textContent.trim() === rotuloBotaoPrincipal);
  assert.ok(btnPrincipal, `botao "${rotuloBotaoPrincipal}" precisa existir na pagina`);
  assert.ok(
    btnPrincipal.form,
    `botao "${rotuloBotaoPrincipal}" precisa estar associado a um <form> — ` +
      'um <form> aninhado no HTML deixaria esse botao orfao e o clique nao faria nada',
  );

  const btnCidade = botoes.find((b) => b.textContent.trim() === 'Cadastrar cidade');
  assert.ok(btnCidade, 'botao "Cadastrar cidade" precisa existir na pagina');
  assert.ok(btnCidade.form, 'botao "Cadastrar cidade" precisa estar associado a um <form>');
  assert.equal(
    btnCidade.form.getAttribute('action'),
    actionCidadeEsperada,
    'o form de "Cadastrar cidade" precisa apontar para a action correta — se tivesse sido ' +
      'absorvido pelo form principal (aninhamento), a action seria a do form principal',
  );
  assert.notEqual(
    btnCidade.form,
    btnPrincipal.form,
    'o form de "Cadastrar cidade" nao pode ser o mesmo <form> do botao principal',
  );
}

test('criacao: "Criar vaga" tem form proprio, e "Cadastrar cidade" nao fica aninhado nele', async () => {
  await comServidor(async (base) => {
    await autenticar(base);
    const html = await (await fetch(`${base}/admin/vagas/nova`, { headers: comAuth() })).text();
    assertFormularioNaoAninhado(html, {
      rotuloBotaoPrincipal: 'Criar vaga',
      actionCidadeEsperada: '/admin/vagas/cidades',
    });
  });
});

test('edicao: "Salvar alterações" tem form proprio, e "Cadastrar cidade" nao fica aninhado nele', async () => {
  await comServidor(async (base) => {
    await autenticar(base);

    const criar = await fetch(`${base}/admin/vagas`, {
      method: 'POST',
      headers: comAuth({ 'Content-Type': 'application/x-www-form-urlencoded' }),
      body: new URLSearchParams({ titulo: 'Vaga de Teste — Estrutura do Form', perfil: 'CLOSER' }),
      redirect: 'manual',
    });
    assert.ok(criar.status < 400, `POST /admin/vagas devolveu ${criar.status}`);
    const vaga = db.getDb().prepare('SELECT * FROM jobs ORDER BY id DESC LIMIT 1').get();

    const html = await (await fetch(`${base}/admin/vagas/${vaga.id}`, { headers: comAuth() })).text();
    assertFormularioNaoAninhado(html, {
      rotuloBotaoPrincipal: 'Salvar alterações',
      actionCidadeEsperada: `/admin/vagas/${vaga.id}/cidades`,
    });
  });
});
