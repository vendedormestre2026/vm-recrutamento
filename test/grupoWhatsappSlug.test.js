'use strict';

// GET /grupo/:slug (routes/pages.js): link curto de convite ao grupo de WhatsApp da
// praca, usado no botao de URL dinamica do template de campanha (ETAPA B).
//
// Tres casos, os mesmos que db.obterLinkGrupoPorSlug colapsa em "achou" / "nao achou":
//   1. slug de uma praca ATIVA com link cadastrado -> redirect 302 pro link.
//   2. slug de uma praca que existe mas ainda NAO tem link (link_convite_grupo NULL,
//      o estado em que toda praca nasce) -> 404.
//   3. slug que nao bate com nenhuma linha -> 404.
// Os dois 404 respondem com o MESMO corpo generico, de proposito (ver o comentario da
// rota): o teste nao afirma nada sobre o texto alem de nao ser a pagina de sucesso.

const os = require('node:os');
const path = require('node:path');

process.env.DATABASE_PATH = path.join(os.tmpdir(), `vm-test-grupo-slug-${process.pid}-${Date.now()}.db`);
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

// Le de volta o slug que criarRegiaoGrupo atribuiu sozinho (normalizarSlug sobre a
// cidade) — o teste nao adivinha a regra de normalizacao, pergunta ao banco.
function slugDaCidade(cidade) {
  return db.getDb().prepare('SELECT slug FROM regioes_grupos_whatsapp WHERE cidade = ?').get(cidade).slug;
}

test('GET /grupo/:slug — slug valido com link cadastrado redireciona (302) pro link', async () => {
  db.criarRegiaoGrupo('Joinville', 'https://chat.whatsapp.com/exemplo-joinville');
  const slug = slugDaCidade('Joinville');
  assert.equal(slug, 'joinville');

  await comServidor(async (base) => {
    const res = await fetch(`${base}/grupo/${slug}`, { redirect: 'manual' });
    assert.equal(res.status, 302);
    assert.equal(res.headers.get('location'), 'https://chat.whatsapp.com/exemplo-joinville');
  });
});

test('GET /grupo/:slug — slug valido mas SEM link cadastrado (praca recem-criada) devolve 404', async () => {
  // criarRegiaoGrupo sem link: mesmo estado em que toda praca nasce ate o operador
  // preencher o link pela tela (ver o comentario de regioes_grupos_whatsapp em
  // schema.sql).
  db.criarRegiaoGrupo('Curitiba', null);
  const slug = slugDaCidade('Curitiba');
  assert.equal(slug, 'curitiba');

  await comServidor(async (base) => {
    const res = await fetch(`${base}/grupo/${slug}`, { redirect: 'manual' });
    assert.equal(res.status, 404);
    const corpo = await res.text();
    assert.match(corpo, /não encontrado/i);
  });
});

test('GET /grupo/:slug — slug inexistente devolve 404', async () => {
  await comServidor(async (base) => {
    const res = await fetch(`${base}/grupo/praca-que-nao-existe`, { redirect: 'manual' });
    assert.equal(res.status, 404);
    const corpo = await res.text();
    assert.match(corpo, /não encontrado/i);
  });
});

// ── Registro de clique (?campanha_id=) — a metrica da campanha de e-mail de grupo ──
//
// O MESMO botao serve dois chamadores: o template de WhatsApp (nunca manda campanha_id) e
// o e-mail de campanha (sempre manda, ver lib/ctaCampanha.montarUrlGrupo). Os testes abaixo
// cobrem os dois lados dessa fronteira: com o parametro, grava; sem ele, comportamento
// IDENTICO ao de antes (nenhuma linha em grupo_acessos, nenhum grep no request).

function contarGrupoAcessos(slug) {
  return db.getDb().prepare('SELECT COUNT(*) AS n FROM grupo_acessos WHERE slug = ?').get(slug).n;
}

test('GET /grupo/:slug com ?campanha_id= valido: redireciona E registra o clique', async () => {
  db.criarRegiaoGrupo('Blumenau', 'https://chat.whatsapp.com/exemplo-blumenau');
  const slug = slugDaCidade('Blumenau');

  const campanhaId = db.criarCampanha({
    job_id: null,
    tipo: 'convite_grupo',
    assunto: 'Entre no grupo',
    corpo_html: '<p>x</p>',
    criterios: { tipo: 'convite_grupo', cidadeGrupo: 'Blumenau' },
    total_destinatarios: 0,
  });

  await comServidor(async (base) => {
    const res = await fetch(`${base}/grupo/${slug}?campanha_id=${campanhaId}`, { redirect: 'manual' });
    assert.equal(res.status, 302);
    assert.equal(res.headers.get('location'), 'https://chat.whatsapp.com/exemplo-blumenau');
  });

  assert.equal(contarGrupoAcessos(slug), 1, 'o clique com campanha_id precisa gravar uma linha');
  assert.equal(db.contarCliquesGrupo(campanhaId).total, 1);

  const linha = db.getDb().prepare('SELECT * FROM grupo_acessos WHERE slug = ?').get(slug);
  assert.equal(linha.campanha_id, campanhaId);
});

test('GET /grupo/:slug SEM ?campanha_id= (botao do WhatsApp): redireciona e NAO registra nada — comportamento inalterado', async () => {
  db.criarRegiaoGrupo('Itajai', 'https://chat.whatsapp.com/exemplo-itajai');
  const slug = slugDaCidade('Itajai');
  const antes = contarGrupoAcessos(slug);

  await comServidor(async (base) => {
    const res = await fetch(`${base}/grupo/${slug}`, { redirect: 'manual' });
    assert.equal(res.status, 302);
    assert.equal(res.headers.get('location'), 'https://chat.whatsapp.com/exemplo-itajai');
  });

  assert.equal(contarGrupoAcessos(slug), antes, 'sem campanha_id o comportamento e IDENTICO ao de antes do clique de e-mail existir');
});

test('GET /grupo/:slug com ?campanha_id= invalido ou de campanha inexistente: ainda redireciona, grava com campanha_id NULL', async () => {
  db.criarRegiaoGrupo('Brusque', 'https://chat.whatsapp.com/exemplo-brusque');
  const slug = slugDaCidade('Brusque');

  await comServidor(async (base) => {
    for (const valor of ['abc', '999999', '-1', '0']) {
      const res = await fetch(`${base}/grupo/${slug}?campanha_id=${valor}`, { redirect: 'manual' });
      assert.equal(res.status, 302, `id invalido nao pode bloquear o redirect (valor=${valor})`);
      assert.equal(res.headers.get('location'), 'https://chat.whatsapp.com/exemplo-brusque');
    }
  });

  const linhas = db.getDb().prepare('SELECT campanha_id FROM grupo_acessos WHERE slug = ?').all(slug);
  assert.equal(linhas.length, 4, 'as quatro tentativas gravaram, mesmo com id invalido');
  assert.ok(linhas.every((l) => l.campanha_id === null), 'id invalido/inexistente colapsa em NULL, nunca lanca');
});
