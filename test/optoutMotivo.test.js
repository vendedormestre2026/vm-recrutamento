'use strict';

// B4: motivo OPCIONAL do descadastro na pagina publica, e a quebra por motivo no painel.
//
// A regra que este arquivo trava: o motivo NUNCA bloqueia a conclusao. Pedir o motivo como
// condicao para sair transformaria o exercicio de um direito numa pesquisa — e quem nao quer
// responder marcaria qualquer coisa, estragando o dado que a pergunta existe para coletar.

const os = require('node:os');
const path = require('node:path');

process.env.DATABASE_PATH = path.join(os.tmpdir(), `vm-test-optout-motivo-${process.pid}-${Date.now()}.db`);
process.env.INTERVIEW_MOCK = 'true';
process.env.SESSION_SECRET = 'segredo-de-teste';
process.env.ADMIN_USER = 'admin-teste';
process.env.ADMIN_PASSWORD = 'senha-teste';
process.env.OPTOUT_TOKEN_SECRET = 'segredo-hmac-de-teste';
process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert/strict');

const db = require('../src/db');
const { migrar } = require('../src/db/migrate');
const { criarApp } = require('../src/server');
const optout = require('../src/lib/optoutWhatsapp');
const { gerarTokenDescadastroWhatsapp } = require('../src/lib/descadastroWhatsapp');

migrar();

const exec = (sql, ...p) => db.getDb().prepare(sql).run(...p);
const zerar = () => exec('DELETE FROM whatsapp_optout');
const contar = () => db.getDb().prepare('SELECT COUNT(*) AS n FROM whatsapp_optout').get().n;

async function comServidor(fn) {
  const app = criarApp();
  const server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  try {
    return await fn(`http://127.0.0.1:${server.address().port}`);
  } finally {
    await new Promise((r) => server.close(r));
  }
}

const postForm = (base, caminho, campos) =>
  fetch(`${base}${caminho}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(campos),
  });

const MOTIVO_VALIDO = 'Recebo mensagens demais';

test('a pagina oferece os motivos e o campo de texto livre, todos opcionais', async () => {
  await comServidor(async (base) => {
    zerar();
    const html = await (await fetch(`${base}/descadastro/${gerarTokenDescadastroWhatsapp('5547999582500')}`)).text();
    assert.match(html, /conte o motivo/);
    assert.match(html, /Recebo mensagens demais/);
    assert.match(html, /Já consegui um emprego/);
    assert.match(html, /name="motivo_outro"/);
    // Nenhum campo obrigatorio: o motivo nunca pode barrar a saida.
    assert.doesNotMatch(html, /required/);
  });
});

test('SEM motivo: o opt-out e efetivado igual, com motivo NULL', async () => {
  await comServidor(async (base) => {
    zerar();
    const token = gerarTokenDescadastroWhatsapp('5547999582500');
    const res = await postForm(base, '/descadastro/whatsapp', { token, escopo: 'campanha' });
    assert.equal(res.status, 200);
    assert.match(await res.text(), /registramos seu pedido/);
    assert.equal(optout.estaOptout('5547999582500', 'campanha'), true);
    assert.equal(db.obterWhatsappOptout('5547999582500').motivo, null);
  });
});

test('COM motivo da lista: grava o rotulo escolhido', async () => {
  await comServidor(async (base) => {
    zerar();
    const token = gerarTokenDescadastroWhatsapp('5547999582501');
    await postForm(base, '/descadastro/whatsapp', { token, escopo: 'campanha', motivo: MOTIVO_VALIDO });
    assert.equal(db.obterWhatsappOptout('5547999582501').motivo, MOTIVO_VALIDO);
  });
});

test('motivo "outro" grava o texto livre', async () => {
  await comServidor(async (base) => {
    zerar();
    const token = gerarTokenDescadastroWhatsapp('5547999582502');
    await postForm(base, '/descadastro/whatsapp', {
      token,
      escopo: 'campanha',
      motivo: 'outro',
      motivo_outro: '  mudei de area  ',
    });
    assert.equal(db.obterWhatsappOptout('5547999582502').motivo, 'mudei de area');
  });
});

test('"outro" sem texto vira NULL, e o opt-out acontece do mesmo jeito', async () => {
  await comServidor(async (base) => {
    zerar();
    const token = gerarTokenDescadastroWhatsapp('5547999582503');
    const res = await postForm(base, '/descadastro/whatsapp', { token, escopo: 'campanha', motivo: 'outro' });
    assert.equal(res.status, 200);
    assert.equal(optout.estaOptout('5547999582503', 'campanha'), true);
    assert.equal(db.obterWhatsappOptout('5547999582503').motivo, null);
  });
});

test('motivo FORJADO (fora da lista) e ignorado, e nao impede a saida', async () => {
  await comServidor(async (base) => {
    zerar();
    const token = gerarTokenDescadastroWhatsapp('5547999582504');
    const res = await postForm(base, '/descadastro/whatsapp', {
      token,
      escopo: 'campanha',
      motivo: '<script>alert(1)</script>',
    });
    assert.equal(res.status, 200);
    assert.equal(optout.estaOptout('5547999582504', 'campanha'), true);
    assert.equal(db.obterWhatsappOptout('5547999582504').motivo, null, 'valor forjado nao entra no banco');
  });
});

test('texto livre e cortado no teto, nunca recusado', async () => {
  await comServidor(async (base) => {
    zerar();
    const token = gerarTokenDescadastroWhatsapp('5547999582505');
    await postForm(base, '/descadastro/whatsapp', {
      token,
      escopo: 'campanha',
      motivo: 'outro',
      motivo_outro: 'x'.repeat(5000),
    });
    const gravado = db.obterWhatsappOptout('5547999582505').motivo;
    assert.equal(gravado.length, 200);
  });
});

test('o motivo tambem vale no bloqueio TOTAL', async () => {
  await comServidor(async (base) => {
    zerar();
    const token = gerarTokenDescadastroWhatsapp('5547999582506');
    await postForm(base, '/descadastro/whatsapp', { token, escopo: 'total', motivo: MOTIVO_VALIDO });
    const linha = db.obterWhatsappOptout('5547999582506');
    assert.equal(linha.escopo, 'total');
    assert.equal(linha.motivo, MOTIVO_VALIDO);
  });
});

test('segundo clique PREENCHE motivo vazio, mas NUNCA sobrescreve um ja informado', async () => {
  await comServidor(async (base) => {
    zerar();
    const token = gerarTokenDescadastroWhatsapp('5547999582507');

    // 1. Sai sem dizer o motivo.
    await postForm(base, '/descadastro/whatsapp', { token, escopo: 'campanha' });
    assert.equal(db.obterWhatsappOptout('5547999582507').motivo, null);

    // 2. Volta e informa: o vazio e preenchido.
    await postForm(base, '/descadastro/whatsapp', { token, escopo: 'campanha', motivo: MOTIVO_VALIDO });
    assert.equal(db.obterWhatsappOptout('5547999582507').motivo, MOTIVO_VALIDO);

    // 3. Volta de novo com outro motivo: o primeiro e preservado.
    await postForm(base, '/descadastro/whatsapp', {
      token,
      escopo: 'campanha',
      motivo: 'Já consegui um emprego',
    });
    assert.equal(db.obterWhatsappOptout('5547999582507').motivo, MOTIVO_VALIDO, 'nao reescreve a historia');

    assert.equal(contar(), 1, 'e continua sendo uma linha so');
  });
});

test('o GET com motivo na query continua sem escrever nada', async () => {
  await comServidor(async (base) => {
    zerar();
    const token = gerarTokenDescadastroWhatsapp('5547999582508');
    await fetch(`${base}/descadastro/${token}?motivo=${encodeURIComponent(MOTIVO_VALIDO)}`);
    assert.equal(contar(), 0);
  });
});

test('resumo do painel quebra por motivo, com balde para quem nao informou', () => {
  zerar();
  optout.registrarOptout({ telefone: '5547999582511', origem: 'link', motivo: MOTIVO_VALIDO });
  optout.registrarOptout({ telefone: '5547999582512', origem: 'link', motivo: MOTIVO_VALIDO });
  optout.registrarOptout({ telefone: '5547999582513', origem: 'link', motivo: 'mudei de area' });
  optout.registrarOptout({ telefone: '5547999582514', origem: 'link' });

  const porMotivo = Object.fromEntries(db.resumoWhatsappOptouts().porMotivo.map((m) => [m.motivo, m.n]));
  assert.equal(porMotivo[MOTIVO_VALIDO], 2);
  assert.equal(porMotivo['mudei de area'], 1);
  assert.equal(porMotivo['(não informado)'], 1);
});

test('/admin/optouts mostra a quebra por motivo', async () => {
  await comServidor(async (base) => {
    zerar();
    optout.registrarOptout({ telefone: '5547999582521', origem: 'link', motivo: MOTIVO_VALIDO });
    optout.registrarOptout({ telefone: '5547999582522', origem: 'link' });

    const login = await fetch(`${base}/admin/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ usuario: 'admin-teste', senha: 'senha-teste' }),
      redirect: 'manual',
    });
    const bruto = login.headers.getSetCookie ? login.headers.getSetCookie() : [login.headers.get('set-cookie')];
    const cookie = bruto.filter(Boolean).map((c) => c.split(';')[0]).join('; ');

    const html = await (await fetch(`${base}/admin/optouts`, { headers: { Cookie: cookie } })).text();
    assert.match(html, /Por motivo/);
    assert.match(html, /Recebo mensagens demais/);
    assert.match(html, /\(não informado\)/);
  });
});
