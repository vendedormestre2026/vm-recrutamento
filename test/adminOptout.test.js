'use strict';

// Incremento 3: painel de opt-outs (src/routes/admin_optout.js), por HTTP.
//
// Cobre a tela, o registro manual com escolha de escopo, a revogacao, a acao de 1 clique na
// listagem de candidatos e o selo na ficha. Tudo pelo servidor de verdade — a protecao do
// painel (adminAuth herdado pelo mount) e parte do que esta sendo testado.

const os = require('node:os');
const path = require('node:path');

process.env.DATABASE_PATH = path.join(os.tmpdir(), `vm-test-admin-optout-${process.pid}-${Date.now()}.db`);
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
const optout = require('../src/lib/optoutWhatsapp');

migrar();

const exec = (sql, ...p) => db.getDb().prepare(sql).run(...p);

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

const get = (base, caminho) => fetch(`${base}${caminho}`, { headers: { Cookie: cookieAdmin } });

const post = (base, caminho, campos) =>
  fetch(`${base}${caminho}`, {
    method: 'POST',
    headers: { Cookie: cookieAdmin, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(campos),
    redirect: 'manual',
  });

let seq = 0;
function candidatura(nome, telefone) {
  seq += 1;
  const jobId = Number(
    exec(
      'INSERT INTO jobs (slug, titulo, perfil, cidade, ativo) VALUES (?, ?, ?, ?, 1)',
      `vaga-adm-optout-${seq}`,
      `Vaga ${seq}`,
      'CLOSER',
      'Joinville',
    ).lastInsertRowid,
  );
  return Number(
    exec(
      'INSERT INTO applications (job_id, nome, telefone, token) VALUES (?, ?, ?, ?)',
      jobId,
      nome,
      telefone,
      `tok-adm-optout-${seq}`,
    ).lastInsertRowid,
  );
}

function zerar() {
  exec('DELETE FROM applications');
  exec('DELETE FROM jobs');
  exec('DELETE FROM whatsapp_optout');
  exec("DELETE FROM configuracoes WHERE chave = 'optout_whatsapp_ativo'");
}

test('a tela exige login, como o resto do painel', async () => {
  await comServidor(async (base) => {
    const res = await fetch(`${base}/admin/optouts`, { redirect: 'manual' });
    assert.equal(res.status, 302, 'sem cookie, redireciona para o login');
    assert.match(res.headers.get('location') || '', /\/admin\/login/);
  });
});

test('GET /admin/optouts lista os registros com escopo, origem e data', async () => {
  await comServidor(async (base) => {
    zerar();
    await autenticar(base);
    optout.registrarOptout({ telefone: '+55 47 99958-2500', escopo: 'campanha', origem: 'link' });
    optout.registrarOptout({ telefone: '5511988887777', escopo: 'total', origem: 'manual', motivo: 'pediu no Live Chat' });

    const html = await (await get(base, '/admin/optouts')).text();
    assert.match(html, /Opt-outs de WhatsApp/);
    assert.match(html, /554799582500/, 'mostra a chave canonica do primeiro');
    assert.match(html, /Só campanhas/);
    assert.match(html, /Tudo \(inclusive processo seletivo\)/);
    assert.match(html, /Clicou no link/);
    assert.match(html, /pediu no Live Chat/);
  });
});

test('POST /marcar registra com escopo campanha (o padrao) e volta com aviso', async () => {
  await comServidor(async (base) => {
    zerar();
    await autenticar(base);
    const res = await post(base, '/admin/optouts/marcar', {
      telefone: '+55 47 99958-2501',
      escopo: 'campanha',
      motivo: 'teste',
      redirect: '/admin/optouts',
    });
    assert.equal(res.status, 302);
    assert.match(res.headers.get('location') || '', /msg=criado/);
    assert.equal(optout.estaOptout('5547999582501', 'campanha'), true);
    assert.equal(optout.estaOptout('5547999582501', 'transacional'), false);
  });
});

test('POST /marcar com escopo total bloqueia tambem o transacional', async () => {
  await comServidor(async (base) => {
    zerar();
    await autenticar(base);
    await post(base, '/admin/optouts/marcar', {
      telefone: '5547999582502',
      escopo: 'total',
      redirect: '/admin/optouts',
    });
    assert.equal(optout.estaOptout('5547999582502', 'transacional'), true);
  });
});

test('POST /marcar de novo NAO duplica e avisa que ja existia', async () => {
  await comServidor(async (base) => {
    zerar();
    await autenticar(base);
    const campos = { telefone: '5547999582503', escopo: 'campanha', redirect: '/admin/optouts' };
    await post(base, '/admin/optouts/marcar', campos);
    const res = await post(base, '/admin/optouts/marcar', campos);
    assert.match(res.headers.get('location') || '', /msg=ja_existia/);
    assert.equal(db.getDb().prepare('SELECT COUNT(*) AS n FROM whatsapp_optout').get().n, 1);
  });
});

test('POST /marcar com telefone invalido nao grava e avisa', async () => {
  await comServidor(async (base) => {
    zerar();
    await autenticar(base);
    const res = await post(base, '/admin/optouts/marcar', { telefone: 'abc', redirect: '/admin/optouts' });
    assert.match(res.headers.get('location') || '', /msg=telefone/);
    assert.equal(db.getDb().prepare('SELECT COUNT(*) AS n FROM whatsapp_optout').get().n, 0);
  });
});

test('POST /revogar desfaz, e revogar de novo avisa que nao havia o que revogar', async () => {
  await comServidor(async (base) => {
    zerar();
    await autenticar(base);
    optout.registrarOptout({ telefone: '5547999582504', origem: 'link' });

    const res = await post(base, '/admin/optouts/revogar', {
      telefone: '5547999582504',
      redirect: '/admin/optouts',
    });
    assert.match(res.headers.get('location') || '', /msg=revogado/);
    assert.equal(optout.estaOptout('5547999582504', 'campanha'), false);

    const res2 = await post(base, '/admin/optouts/revogar', {
      telefone: '5547999582504',
      redirect: '/admin/optouts',
    });
    assert.match(res2.headers.get('location') || '', /msg=nada_revogar/);
  });
});

test('redirect externo e recusado: a acao volta para o painel, nunca para fora', async () => {
  await comServidor(async (base) => {
    zerar();
    await autenticar(base);
    const res = await post(base, '/admin/optouts/marcar', {
      telefone: '5547999582505',
      redirect: 'https://exemplo.invalido/roubo',
    });
    const destino = res.headers.get('location') || '';
    assert.ok(destino.startsWith('/admin/optouts'), `destino inesperado: ${destino}`);
  });
});

test('filtro por escopo recorta a lista', async () => {
  await comServidor(async (base) => {
    zerar();
    await autenticar(base);
    optout.registrarOptout({ telefone: '5547999582511', escopo: 'campanha', origem: 'link' });
    optout.registrarOptout({ telefone: '5511988886666', escopo: 'total', origem: 'manual' });

    const html = await (await get(base, '/admin/optouts?escopo=total')).text();
    assert.match(html, /551198888666/, 'o de escopo total aparece');
    assert.doesNotMatch(html, /554799958251/, 'o de campanha nao aparece');
  });
});

test('busca por telefone com mascara acha o registro normalizado', async () => {
  await comServidor(async (base) => {
    zerar();
    await autenticar(base);
    optout.registrarOptout({ telefone: '5547999582521', origem: 'link' });
    const html = await (await get(base, '/admin/optouts?q=%2B55%20(47)%2099958-2521')).text();
    assert.match(html, /554799582521/);
  });
});

test('a tela avisa quando a supressao esta DESLIGADA', async () => {
  await comServidor(async (base) => {
    zerar();
    await autenticar(base);
    const ligada = await (await get(base, '/admin/optouts')).text();
    assert.doesNotMatch(ligada, /A supressão está/);

    db.definirConfigBool(optout.CHAVE_ATIVO, false);
    const desligada = await (await get(base, '/admin/optouts')).text();
    assert.match(desligada, /A supressão está/);
    assert.match(desligada, /estão recebendo/);
    db.definirConfigBool(optout.CHAVE_ATIVO, true);
  });
});

// ══════════════════════════════════════════════════════════════
// Acao de 1 clique na listagem e selo na ficha
// ══════════════════════════════════════════════════════════════

test('listagem de candidatos: a coluna Opt-out traz o botao de 1 clique', async () => {
  await comServidor(async (base) => {
    zerar();
    await autenticar(base);
    candidatura('Ana Teste', '+55 47 90000-3001');

    const html = await (await get(base, '/admin')).text();
    assert.match(html, /\/admin\/optouts\/marcar/, 'o form de 1 clique esta na listagem');
    assert.match(html, /Marcar opt-out\?/, 'com confirmacao antes de gravar');
  });
});

test('listagem: quem JA tem opt-out mostra o estado, sem botao de marcar de novo', async () => {
  await comServidor(async (base) => {
    zerar();
    await autenticar(base);
    candidatura('Bruno Teste', '+55 47 90000-3002');
    optout.registrarOptout({ telefone: '5547900003002', origem: 'link' });

    const html = await (await get(base, '/admin')).text();
    assert.match(html, /Opt-out ✓/);
  });
});

test('ficha do candidato: selo com escopo, origem e data quando ha opt-out ativo', async () => {
  await comServidor(async (base) => {
    zerar();
    await autenticar(base);
    const id = candidatura('Carla Teste', '+55 47 90000-3003');

    const semSelo = await (await get(base, `/admin/candidato/${id}`)).text();
    assert.doesNotMatch(semSelo, /Pediu para não receber/);

    optout.registrarOptout({
      telefone: '5547900003003',
      escopo: 'total',
      origem: 'resposta',
      motivo: 'respondeu SAIR',
    });
    const comSelo = await (await get(base, `/admin/candidato/${id}`)).text();
    assert.match(comSelo, /Pediu para não receber/);
    assert.match(comSelo, /Tudo \(inclusive processo seletivo\)/);
    assert.match(comSelo, /Respondeu pedindo/);
    assert.match(comSelo, /respondeu SAIR/);
    assert.match(comSelo, /Revogar opt-out/, 'e a acao de revogar no lugar da de marcar');
  });
});

test('ficha: o selo aparece mesmo com a supressao desligada (mostra o que esta registrado)', async () => {
  await comServidor(async (base) => {
    zerar();
    await autenticar(base);
    const id = candidatura('Diego Teste', '+55 47 90000-3004');
    optout.registrarOptout({ telefone: '5547900003004', origem: 'link' });
    db.definirConfigBool(optout.CHAVE_ATIVO, false);

    const html = await (await get(base, `/admin/candidato/${id}`)).text();
    assert.match(html, /Pediu para não receber/, 'o registro nao some porque o interruptor caiu');
    db.definirConfigBool(optout.CHAVE_ATIVO, true);
  });
});

test('/admin/config tem o checkbox da supressao, marcado por padrao', async () => {
  await comServidor(async (base) => {
    zerar();
    await autenticar(base);
    const html = await (await get(base, '/admin/config')).text();
    assert.match(html, /name="optout_whatsapp_ativo"[^>]*checked/, 'nasce ligado');
    assert.match(html, /Desmarcar volta a mandar campanha/);
  });
});

test('/admin/config: desmarcar grava 0 e a supressao para de valer', async () => {
  await comServidor(async (base) => {
    zerar();
    await autenticar(base);
    optout.registrarOptout({ telefone: '5547900003005', origem: 'link' });

    // O form de notificacoes manda todos os checkboxes juntos; a ausencia do campo e o
    // "desmarcado" (ver o comentario do POST /config/notificacoes).
    await post(base, '/admin/config/notificacoes', { notificar_nova_candidatura: '1' });
    assert.equal(optout.ativo(), false);
    assert.equal(optout.estaOptout('5547900003005', 'campanha'), false);

    await post(base, '/admin/config/notificacoes', { optout_whatsapp_ativo: '1' });
    assert.equal(optout.ativo(), true);
    assert.equal(optout.estaOptout('5547900003005', 'campanha'), true);
  });
});
