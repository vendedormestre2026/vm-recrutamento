'use strict';

// GET /vaga/:slug/confirmacao — pagina de "voltar pro WhatsApp" que o link do WA1 usa
// (lib/whatsappSequencia.js#linkVaga), Incremento 10.
//
// ── POR QUE UMA ROTA NOVA, e nao um query param em /vaga/:slug ──
// A rota publica tem UTM/cookie/registrarAcessoVaga (metrica de topo de funil) que essa
// visita NAO deve disparar de novo — quem clica aqui JA se candidatou. Um query param
// mudando o comportamento da MESMA rota misturaria as duas responsabilidades; a rota
// separada deixa o guard e o conteudo compartilhados (carregarVagaOuNull,
// montarConteudoVaga) e so o CTA final diferente.
//
// Este arquivo fixa RECRUITER_WHATSAPP com um numero valido — o cenario "telefone ausente"
// (sem botao quebrado) tem arquivo proprio, porque config.js le o env UMA vez no require.

const os = require('node:os');
const path = require('node:path');

process.env.DATABASE_PATH = path.join(os.tmpdir(), `vm-test-vaga-confirmacao-${process.pid}-${Date.now()}.db`);
process.env.INTERVIEW_MOCK = 'true';
process.env.SESSION_SECRET = 'segredo-de-teste';
process.env.ADMIN_USER = 'admin-teste';
process.env.ADMIN_PASSWORD = 'senha-teste';
process.env.NODE_ENV = 'test';
process.env.RECRUITER_WHATSAPP = '+55 47 99958-2500';

const test = require('node:test');
const assert = require('node:assert/strict');

const db = require('../src/db');
const { migrar } = require('../src/db/migrate');
const { criarApp } = require('../src/server');

migrar();

const run = (sql, ...p) => db.getDb().prepare(sql).run(...p);

run(
  "INSERT INTO jobs (slug, titulo, perfil, empresa, ativo) VALUES ('vaga-confirmacao-ok', 'Consultor de Vendas Confirmacao', 'CLOSER', 'Empresa Confirmacao', 1)",
);
run(
  "INSERT INTO jobs (slug, titulo, perfil, empresa, ativo) VALUES ('vaga-confirmacao-encerrada', 'Vaga Encerrada Confirmacao', 'CLOSER', 'Empresa X', 0)",
);

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

test('GET /vaga/:slug/confirmacao: 200, mesmo conteudo da vaga, CTA "Voltar para o WhatsApp"', async () => {
  await comServidor(async (base) => {
    const res = await fetch(`${base}/vaga/vaga-confirmacao-ok/confirmacao`);
    assert.equal(res.status, 200);
    const html = await res.text();
    assert.match(html, /Consultor de Vendas Confirmacao/, 'titulo da vaga precisa aparecer');
    assert.match(html, /Vaga aberta · Perfil CLOSER/, 'mesmo cabecalho da pagina publica');
    assert.match(html, /https:\/\/wa\.me\/5547999582500/, 'link wa\\.me com o telefone do recrutador');
    assert.match(html, />VOLTAR PARA O WHATSAPP</, 'texto do botao');
    assert.doesNotMatch(html, /href="\/aplicar\//, 'nao pode ter o CTA de candidatura desta pagina');
  });
});

test('GET /vaga/:slug/confirmacao: vaga inexistente -> 404, mesmo guard da rota publica', async () => {
  await comServidor(async (base) => {
    const res = await fetch(`${base}/vaga/slug-que-nao-existe/confirmacao`);
    assert.equal(res.status, 404);
    const html = await res.text();
    assert.match(html, /Vaga nao encontrada|Vaga não encontrada/i);
  });
});

test('GET /vaga/:slug/confirmacao: vaga encerrada -> 404, mesmo guard da rota publica', async () => {
  await comServidor(async (base) => {
    const res = await fetch(`${base}/vaga/vaga-confirmacao-encerrada/confirmacao`);
    assert.equal(res.status, 404);
    const html = await res.text();
    assert.match(html, /Vaga encerrada/);
  });
});

test('GET /vaga/:slug (rota publica, sem /confirmacao) continua com "Aplicar" — refactor nao mudou o comportamento dela', async () => {
  await comServidor(async (base) => {
    const res = await fetch(`${base}/vaga/vaga-confirmacao-ok`);
    assert.equal(res.status, 200);
    const html = await res.text();
    assert.match(html, /href="\/aplicar\/vaga-confirmacao-ok"/);
    assert.doesNotMatch(html, /VOLTAR PARA O WHATSAPP/, 'a rota publica nao pode ganhar o CTA da confirmacao');
  });
});
