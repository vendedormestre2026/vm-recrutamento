'use strict';

// Adaptador LLM openrouter: erro HTTP com status e mensagem do provedor, sem vazar a chave, e
// chave saneada com trim. ZERO REDE: o fetch global e trocado por um duble.
//
// Motivo (2026-10-22): a chave trocada no Railway sem redeploy deu 401 "User not found." e a tela
// so mostrava "falha na chamada ao modelo".

const os = require('node:os');
const path = require('node:path');

const CHAVE = 'sk-or-v1-chave-de-teste-0bd3';
// Com espaco e quebra de linha nas pontas, como sai de um copiar-colar no painel do Railway.
process.env.OPENROUTER_API_KEY = `  ${CHAVE}\n`;
process.env.LLM_PROVIDER = 'openrouter';
process.env.DATABASE_PATH = path.join(os.tmpdir(), `vm-test-llm-openrouter-${process.pid}-${Date.now()}.db`);
process.env.INTERVIEW_MOCK = 'true';
process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert/strict');

const { config } = require('../src/config');
const openrouter = require('../src/providers/llm/openrouter');
const g = require('../src/lib/gerarVariacoesMassaWa');
const { BASE_LEMBRETE } = require('./fixtures/variacoesLembreteMassaWa');

const fetchOriginal = global.fetch;
test.afterEach(() => { global.fetch = fetchOriginal; });

// fetch duble: guarda o pedido e responde com status/corpo fixos.
function fetchQueResponde(status, corpo) {
  const pedidos = [];
  global.fetch = async (url, init) => {
    pedidos.push({ url, init });
    return new Response(corpo, { status, headers: { 'Content-Type': 'application/json' } });
  };
  return pedidos;
}

const MSG = [{ papel: 'user', conteudo: 'oi' }];

test('config: a chave do OpenRouter sai sem espaco nem quebra de linha nas pontas', () => {
  assert.equal(config.provedores.llm.openrouter.apiKey, CHAVE);
});

test('o Authorization vai com a chave saneada', async () => {
  const pedidos = fetchQueResponde(200, JSON.stringify({ choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }] }));
  await openrouter.completar(MSG);
  assert.equal(pedidos[0].init.headers.Authorization, `Bearer ${CHAVE}`);
});

test('401: o erro traz status e a mensagem do provedor', async () => {
  fetchQueResponde(401, '{"error":{"message":"User not found.","code":401}}');
  await assert.rejects(openrouter.completar(MSG), (err) => {
    assert.equal(err.status, 401);
    assert.equal(err.detalhe, 'User not found.');
    assert.match(err.message, /OpenRouter retornou erro 401/);
    return true;
  });
});

test('a chave nunca aparece no erro, nem se o provedor a ecoar no corpo', async () => {
  fetchQueResponde(401, JSON.stringify({ error: { message: `Invalid key ${CHAVE}`, code: 401 } }));
  await assert.rejects(openrouter.completar(MSG), (err) => {
    assert.ok(!err.message.includes(CHAVE), err.message);
    assert.ok(!err.detalhe.includes(CHAVE), err.detalhe);
    assert.match(err.detalhe, /Invalid key \[chave\]/);
    return true;
  });
});

test('corpo que nao e JSON vai cru e cortado no detalhe', async () => {
  fetchQueResponde(502, `<html>${'x'.repeat(1000)}</html>`);
  await assert.rejects(openrouter.completar(MSG), (err) => {
    assert.equal(err.status, 502);
    assert.ok(err.detalhe.startsWith('<html>'));
    assert.ok(err.detalhe.length <= 200);
    return true;
  });
});

test('ponta a ponta: 401 real do adaptador vira causa util no erro da geracao, sem a chave', async () => {
  fetchQueResponde(401, '{"error":{"message":"User not found.","code":401}}');
  const r = await g.gerarVariacoes(BASE_LEMBRETE, { llm: openrouter, db: { registrarUsoApi() {} } });
  assert.equal(r.ok, false);
  assert.deepEqual(r.variacoes, []);
  assert.match(r.erro, /A IA não gerou 7 variações válidas em 3 tentativa\(s\) \(a IA não respondeu: provedor retornou 401 \(chave inválida ou revogada: User not found\.\)\)/);
  assert.ok(!r.erro.includes(CHAVE));
});
