'use strict';

// centralWhats.listarTemplatesCentralWhats (ETAPA C, Incremento 1): leitura de
// GET /api/instances/{id}/templates. Base do botao "Sincronizar templates" do admin —
// substitui o INSERT manual via railway ssh usado ate hoje pra cada template novo aprovado
// na Meta.
//
// NUNCA lanca (diferente de enviarTemplate): erro volta como { ok: false, erro }, sucesso
// como { ok: true, templates }. Nao passa por modoMock — e leitura, nao envio.

const os = require('node:os');
const path = require('node:path');

process.env.DATABASE_PATH = path.join(os.tmpdir(), `vm-test-listar-templates-cw-${process.pid}-${Date.now()}.db`);
process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert/strict');

const transporte = require('../src/providers/centralWhats/centralWhats');

const TEMPLATE_API = {
  id: 'tpl_abc123',
  instance_id: 'inst_xyz',
  name: 'confirmacao_pedido',
  category: 'UTILITY',
  language: 'pt_BR',
  status: 'APPROVED',
  wa_template_id: '123456789012345',
  components: [
    { type: 'BODY', text: 'Olá {{1}}, seu pedido {{2}} foi confirmado.' },
    { type: 'FOOTER', text: 'Responda STOP para sair' },
  ],
};

function comCredenciais(fn) {
  const antes = {
    base: process.env.CENTRALWHATS_BASE_URL,
    inst: process.env.CENTRALWHATS_INSTANCE_ID,
    key: process.env.CENTRALWHATS_API_KEY,
  };
  process.env.CENTRALWHATS_BASE_URL = 'https://exemplo-invalido.local';
  process.env.CENTRALWHATS_INSTANCE_ID = 'instancia-de-teste';
  process.env.CENTRALWHATS_API_KEY = 'chave-de-teste';
  try {
    return fn();
  } finally {
    for (const [k, v] of [
      ['CENTRALWHATS_BASE_URL', antes.base],
      ['CENTRALWHATS_INSTANCE_ID', antes.inst],
      ['CENTRALWHATS_API_KEY', antes.key],
    ]) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

test('sucesso: devolve { ok: true, templates } com o array cru da API', async () => {
  await comCredenciais(async () => {
    let urlChamada = null;
    let metodoChamado = null;
    let authChamado = null;
    const httpClient = async (url, opcoes) => {
      urlChamada = url;
      metodoChamado = opcoes.method;
      authChamado = opcoes.headers.Authorization;
      return { ok: true, json: async () => [TEMPLATE_API] };
    };

    const r = await transporte.listarTemplatesCentralWhats({ httpClient });

    assert.equal(r.ok, true);
    assert.deepEqual(r.templates, [TEMPLATE_API]);
    assert.match(urlChamada, /\/api\/instances\/instancia-de-teste\/templates$/);
    assert.equal(metodoChamado, 'GET');
    assert.equal(authChamado, 'Bearer chave-de-teste');
  });
});

test('array vazio (nenhum template aprovado ainda) e sucesso, nao erro', async () => {
  await comCredenciais(async () => {
    const httpClient = async () => ({ ok: true, json: async () => [] });
    const r = await transporte.listarTemplatesCentralWhats({ httpClient });
    assert.deepEqual(r, { ok: true, templates: [] });
  });
});

test('credenciais ausentes: nao chama a rede, devolve erro claro', async () => {
  const antes = {
    base: process.env.CENTRALWHATS_BASE_URL,
    inst: process.env.CENTRALWHATS_INSTANCE_ID,
    key: process.env.CENTRALWHATS_API_KEY,
  };
  delete process.env.CENTRALWHATS_BASE_URL;
  delete process.env.CENTRALWHATS_INSTANCE_ID;
  delete process.env.CENTRALWHATS_API_KEY;
  try {
    let chamou = false;
    const httpClient = async () => { chamou = true; return { ok: true, json: async () => [] }; };
    const r = await transporte.listarTemplatesCentralWhats({ httpClient });
    assert.equal(r.ok, false);
    assert.match(r.erro, /CENTRALWHATS_BASE_URL/);
    assert.match(r.erro, /CENTRALWHATS_INSTANCE_ID/);
    assert.match(r.erro, /CENTRALWHATS_API_KEY/);
    assert.equal(chamou, false, 'sem credenciais, a rede nem deveria ser tocada');
  } finally {
    for (const [k, v] of [
      ['CENTRALWHATS_BASE_URL', antes.base],
      ['CENTRALWHATS_INSTANCE_ID', antes.inst],
      ['CENTRALWHATS_API_KEY', antes.key],
    ]) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
});

test('falha de autenticacao (HTTP 401): devolve erro claro, nao lanca', async () => {
  await comCredenciais(async () => {
    const httpClient = async () => ({ ok: false, status: 401, text: async () => '{"error":"chave invalida"}' });
    const r = await transporte.listarTemplatesCentralWhats({ httpClient });
    assert.equal(r.ok, false);
    assert.match(r.erro, /HTTP 401/);
    assert.match(r.erro, /chave invalida/);
  });
});

test('falha de rede (DNS/timeout/socket): devolve erro claro, nao lanca', async () => {
  await comCredenciais(async () => {
    const httpClient = async () => { throw new Error('getaddrinfo ENOTFOUND'); };
    const r = await transporte.listarTemplatesCentralWhats({ httpClient });
    assert.equal(r.ok, false);
    assert.match(r.erro, /Falha de rede/);
    assert.match(r.erro, /ENOTFOUND/);
  });
});

test('resposta que nao e JSON valido: devolve erro claro, nao lanca', async () => {
  await comCredenciais(async () => {
    const httpClient = async () => ({ ok: true, json: async () => { throw new SyntaxError('Unexpected token'); } });
    const r = await transporte.listarTemplatesCentralWhats({ httpClient });
    assert.equal(r.ok, false);
    assert.match(r.erro, /JSON/);
  });
});

test('resposta que nao e array (formato inesperado): devolve erro claro, nao lanca', async () => {
  await comCredenciais(async () => {
    const httpClient = async () => ({ ok: true, json: async () => ({ error: 'algo mudou na API' }) });
    const r = await transporte.listarTemplatesCentralWhats({ httpClient });
    assert.equal(r.ok, false);
    assert.match(r.erro, /formato inesperado/);
  });
});
