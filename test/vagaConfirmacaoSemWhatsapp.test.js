'use strict';

// GET /vaga/:slug/confirmacao quando RECRUITER_WHATSAPP esta ausente/invalido — o botao
// "Voltar para o WhatsApp" tem que SOMAR, nao virar um link quebrado. Arquivo separado de
// test/vagaConfirmacao.test.js porque config.js le process.env.RECRUITER_WHATSAPP uma unica
// vez, no require — os dois cenarios (com/sem telefone) nao cabem no mesmo processo.

const os = require('node:os');
const path = require('node:path');

process.env.DATABASE_PATH = path.join(os.tmpdir(), `vm-test-vaga-confirmacao-sem-wa-${process.pid}-${Date.now()}.db`);
process.env.INTERVIEW_MOCK = 'true';
process.env.SESSION_SECRET = 'segredo-de-teste';
process.env.ADMIN_USER = 'admin-teste';
process.env.ADMIN_PASSWORD = 'senha-teste';
process.env.NODE_ENV = 'test';
delete process.env.RECRUITER_WHATSAPP;

const test = require('node:test');
const assert = require('node:assert/strict');

const db = require('../src/db');
const { migrar } = require('../src/db/migrate');
const { criarApp } = require('../src/server');

migrar();

db.getDb()
  .prepare(
    "INSERT INTO jobs (slug, titulo, perfil, empresa, ativo) VALUES ('vaga-confirmacao-sem-wa', 'Vaga Sem Whatsapp Recrutador', 'CLOSER', 'Empresa Y', 1)",
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

test('GET /vaga/:slug/confirmacao sem RECRUITER_WHATSAPP: pagina renderiza, sem botao quebrado', async () => {
  await comServidor(async (base) => {
    const res = await fetch(`${base}/vaga/vaga-confirmacao-sem-wa/confirmacao`);
    assert.equal(res.status, 200);
    const html = await res.text();
    assert.match(html, /Vaga Sem Whatsapp Recrutador/, 'conteudo da vaga continua aparecendo');
    assert.doesNotMatch(html, /wa\.me/, 'sem telefone valido nao pode sobrar link wa.me');
    assert.doesNotMatch(html, /VOLTAR PARA O WHATSAPP/, 'sem telefone valido, o botao inteiro some');
    assert.doesNotMatch(html, /vm-cta-fixa/, 'nao sobra um <div> de CTA vazio no lugar do botao');
  });
});
