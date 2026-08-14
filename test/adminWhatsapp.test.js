'use strict';

// Tela de pareamento do WhatsApp (src/routes/admin_whatsapp.js), por HTTP.
//
// ── ZERO WHATSAPP REAL ──
// Nenhum socket e aberto. O estado da conexao e manipulado pela API do proprio modulo
// (tratarUpdate/_resetar), exatamente como no teste do Incremento 3.
//
// ── DIVERGENCIA REGISTRADA EM RELACAO AO ENUNCIADO ──
// Ele pedia "404 se nao houver QR pendente NO BANCO" e testes "com dados mockados no banco".
// O QR nao esta no banco e nao deve estar: vale ~20 segundos e o Baileys emite um novo
// quando expira. Persistir criaria a pior falha desta tela — servir QR morto a quem vai
// escanear. A fonte e connection.qrAtual(), memoria do processo, apagada em qualquer
// fechamento. Os testes abaixo mockam ESSA fonte.

const os = require('node:os');
const path = require('node:path');

process.env.DATABASE_PATH = path.join(os.tmpdir(), `vm-test-admin-wa-${process.pid}-${Date.now()}.db`);
process.env.INTERVIEW_MOCK = 'true';
process.env.SESSION_SECRET = 'segredo-de-teste';
process.env.ADMIN_USER = 'admin-teste';
process.env.ADMIN_PASSWORD = 'senha-teste';
process.env.WHATSAPP_SECRETS_KEY = 'e'.repeat(64);
process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert/strict');

const db = require('../src/db');
const { migrar } = require('../src/db/migrate');
const { criarApp } = require('../src/server');
const conn = require('../src/whatsapp/connection');

migrar();

let cookieAdmin = '';

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

const comAuth = () => ({ Cookie: cookieAdmin });

function semRuido(fn) {
  const { log, warn, error } = console;
  console.log = console.warn = console.error = () => {};
  try {
    return fn();
  } finally {
    Object.assign(console, { log, warn, error });
  }
}

// Coloca a conexao no estado desejado sem abrir socket nenhum.
function comEstado(qr, conectado = false) {
  conn._resetar();
  if (qr) semRuido(() => conn.tratarUpdate({ qr }));
  if (conectado) semRuido(() => conn.tratarUpdate({ connection: 'open' }));
}

// ══════════════════ Autenticacao ══════════════════

test('as tres rotas exigem sessao de admin', async () => {
  comEstado('QR-DE-TESTE');
  await comServidor(async (base) => {
    for (const caminho of ['/admin/whatsapp', '/admin/whatsapp/status', '/admin/whatsapp/qr.svg']) {
      const res = await fetch(`${base}${caminho}`, { redirect: 'manual' });
      // adminAuth REDIRECIONA para o login (diferente da API de servico, que devolve 401
      // JSON). Aqui o consumidor e um navegador, entao o redirect e o comportamento certo.
      assert.equal(res.status, 302, caminho);
      assert.match(res.headers.get('location') || '', /\/admin\/login/, caminho);
    }
  });
});

// ══════════════════ GET /admin/whatsapp/status ══════════════════

test('status devolve connection_status e updated_at', async () => {
  comEstado(null);
  await comServidor(async (base) => {
    await autenticar(base);
    const res = await fetch(`${base}/admin/whatsapp/status`, { headers: comAuth() });
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type') || '', /application\/json/);

    const e = await res.json();
    assert.equal(e.connection_status, 'desconectado');
    assert.ok(Date.parse(e.updated_at), 'updated_at precisa ser data valida');
    assert.equal(e.tem_qr, false);
  });
});

test('status acompanha as tres transicoes', async () => {
  await comServidor(async (base) => {
    await autenticar(base);
    const ler = async () => (await (await fetch(`${base}/admin/whatsapp/status`, { headers: comAuth() })).json());

    comEstado(null);
    assert.equal((await ler()).connection_status, 'desconectado');

    comEstado('QR-DE-TESTE');
    const pareando = await ler();
    assert.equal(pareando.connection_status, 'pareando');
    assert.equal(pareando.tem_qr, true);

    comEstado('QR-DE-TESTE', true);
    const conectado = await ler();
    assert.equal(conectado.connection_status, 'conectado');
    // Ao conectar, o QR e apagado — a tela nao pode continuar oferecendo um codigo que ja
    // foi usado.
    assert.equal(conectado.tem_qr, false);
  });
});

test('status expoe POR QUE nao conecta, e nao so que nao conecta', async () => {
  comEstado(null);
  await comServidor(async (base) => {
    await autenticar(base);
    const e = await (await fetch(`${base}/admin/whatsapp/status`, { headers: comAuth() })).json();
    // Sem estes tres, "desconectado" deixaria o operador adivinhar qual das coisas falta.
    assert.equal(e.baileys_ativo, false, 'WHATSAPP_BAILEYS_ATIVO nao esta true no teste');
    assert.equal(e.chave_cifragem_ok, true, 'a chave esta definida no setup deste arquivo');
    assert.equal(typeof e.sessao_gravada, 'boolean');
  });
});

test('updated_at avanca quando o status muda, e nao a cada leitura', async () => {
  await comServidor(async (base) => {
    await autenticar(base);
    const ler = async () => (await (await fetch(`${base}/admin/whatsapp/status`, { headers: comAuth() })).json());

    comEstado(null);
    const a = await ler();
    const b = await ler();
    // Duas leituras sem mudanca de estado nao podem mexer no carimbo — senao "desde" mentiria
    // dizendo que a sessao acabou de mudar toda vez que alguem abre a tela.
    assert.equal(a.updated_at, b.updated_at);

    comEstado('QR-DE-TESTE');
    const c = await ler();
    assert.notEqual(c.updated_at, a.updated_at);
  });
});

// ══════════════════ GET /admin/whatsapp/qr.svg ══════════════════

test('sem QR pendente: 404 JSON', async () => {
  comEstado(null);
  await comServidor(async (base) => {
    await autenticar(base);
    const res = await fetch(`${base}/admin/whatsapp/qr.svg`, { headers: comAuth() });
    // 404 e nao 200-com-svg-vazio: o polling do cliente usa o status para decidir se mostra
    // ou esconde a area do QR.
    assert.equal(res.status, 404);
    assert.ok((await res.json()).erro);
  });
});

test('com QR pendente: SVG renderizado, sem cache', async () => {
  comEstado('2@abcdef1234567890,QRZINHO,==');
  await comServidor(async (base) => {
    await autenticar(base);
    const res = await fetch(`${base}/admin/whatsapp/qr.svg`, { headers: comAuth() });
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type') || '', /image\/svg\+xml/);
    // O QR troca sozinho a cada ~20 s; um SVG cacheado seria um codigo morto na tela.
    assert.match(res.headers.get('cache-control') || '', /no-store/);

    const svg = await res.text();
    assert.match(svg, /^<\?xml|^<svg/, 'precisa ser SVG de verdade');
    assert.match(svg, /<path|<rect/, 'SVG sem geometria nao e um QR');
  });
});

test('depois de conectar, o qr.svg volta a 404', async () => {
  comEstado('QR-DE-TESTE');
  await comServidor(async (base) => {
    await autenticar(base);
    assert.equal((await fetch(`${base}/admin/whatsapp/qr.svg`, { headers: comAuth() })).status, 200);

    comEstado('QR-DE-TESTE', true); // open apaga o QR
    assert.equal((await fetch(`${base}/admin/whatsapp/qr.svg`, { headers: comAuth() })).status, 404);
  });
});

test('depois de 401 (despareado), o qr.svg tambem volta a 404', async () => {
  comEstado('QR-DE-TESTE');
  await comServidor(async (base) => {
    await autenticar(base);
    semRuido(() =>
      conn.tratarUpdate(
        { connection: 'close', lastDisconnect: { error: { output: { statusCode: 401 } } } },
        { reconectar: () => {}, limparAuth: () => 0 },
      ),
    );
    assert.equal((await fetch(`${base}/admin/whatsapp/qr.svg`, { headers: comAuth() })).status, 404);
  });
});

// ══════════════════ Tela ══════════════════

test('a tela renderiza e NAO usa <img src> para o QR', async () => {
  comEstado('QR-DE-TESTE');
  await comServidor(async (base) => {
    await autenticar(base);
    const html = await (await fetch(`${base}/admin/whatsapp`, { headers: comAuth() })).text();

    assert.match(html, /WhatsApp — pareamento/);
    // O ponto: <img src="/admin/whatsapp/qr.svg"> nao manda o cookie em toda configuracao de
    // SameSite, e a rota e protegida — renderizaria a tela de login dentro do <img>, ou nada,
    // sem dizer por que. O QR vem por fetch e e injetado no DOM.
    assert.doesNotMatch(html, /<img[^>]+qr\.svg/);
    assert.match(html, /fetch\('\/admin\/whatsapp\/qr\.svg'/);
    assert.match(html, /credentials: 'same-origin'/);
    // Polling de ~3s, como pedido.
    assert.match(html, /setInterval\(ciclo, 3000\)/);
  });
});

test('a tela diz o que falta para conectar', async () => {
  comEstado(null);
  await comServidor(async (base) => {
    await autenticar(base);
    const html = await (await fetch(`${base}/admin/whatsapp`, { headers: comAuth() })).text();
    // WHATSAPP_BAILEYS_ATIVO nao esta true neste teste — a tela tem que dizer isso, em vez
    // de mostrar "desconectado" e deixar o operador procurar.
    assert.match(html, /WHATSAPP_BAILEYS_ATIVO/);
  });
});

test('a tela NAO abre conexao — nenhum socket e criado ao visita-la', async () => {
  // Um GET de painel nao pode iniciar sessao de WhatsApp: um refresh acidental viraria
  // tentativa de conexao. Quem conecta e o boot do server.js.
  comEstado(null);
  await comServidor(async (base) => {
    await autenticar(base);
    await fetch(`${base}/admin/whatsapp`, { headers: comAuth() });
    await fetch(`${base}/admin/whatsapp/status`, { headers: comAuth() });
    assert.equal(conn.status().status, 'desconectado');
    assert.equal(conn.status().tentativas, 0);
  });
});
