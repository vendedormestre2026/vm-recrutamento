'use strict';

// Cifragem da sessao (src/lib/whatsappSecrets.js) e auth state do Baileys sobre SQLite
// (src/whatsapp/authState.js).
//
// ── O QUE ESTA EM JOGO ──
// Estas duas pecas guardam credenciais que permitem ENVIAR MENSAGEM COMO O JEAN. Os dois
// modos de falha sao opostos e igualmente ruins:
//
//   cifragem frouxa   credencial legivel num dump do banco.
//   serializacao ruim sessao que PARECE funcionar e corrompe depois — JSON.stringify puro
//                     transforma Buffer em {"type":"Buffer","data":[...]}, e o Baileys usa
//                     aquilo como chave criptografica. O sintoma nao e erro na gravacao: e
//                     falha de decriptacao de mensagem dias depois.
//
// Por isso o teste central aqui e o de RELOAD: grava, joga o objeto em memoria fora, rele do
// banco e compara — inclusive que Buffer voltou Buffer, e nao objeto parecido com Buffer.
//
// ZERO REDE. Nenhum socket do Baileys e aberto; usamos so initAuthCreds/BufferJSON.

const os = require('node:os');
const path = require('node:path');

process.env.DATABASE_PATH = path.join(os.tmpdir(), `vm-test-wa-auth-${process.pid}-${Date.now()}.db`);
process.env.INTERVIEW_MOCK = 'true';
process.env.SESSION_SECRET = 'segredo-de-teste';
process.env.WHATSAPP_SECRETS_KEY = 'a'.repeat(64); // 32 bytes hex
process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert/strict');

const db = require('../src/db');
const { migrar } = require('../src/db/migrate');
const { sealSecret, openSecret, chaveConfigurada } = require('../src/lib/whatsappSecrets');
const { criarAuthState, limparAuthState, contarChavesAuth } = require('../src/whatsapp/authState');

migrar();

const zerar = () => db.getDb().prepare('DELETE FROM baileys_auth').run();

// Roda `fn` com outra chave de cifragem, restaurando sempre.
function comChave(valor, fn) {
  const original = process.env.WHATSAPP_SECRETS_KEY;
  if (valor === null) delete process.env.WHATSAPP_SECRETS_KEY;
  else process.env.WHATSAPP_SECRETS_KEY = valor;
  try {
    return fn();
  } finally {
    process.env.WHATSAPP_SECRETS_KEY = original;
  }
}

// ══════════════════ Cifragem ══════════════════

test('round-trip: o que sela abre igual', () => {
  for (const claro of ['x', '', 'acentuação e emoji 🔐', JSON.stringify({ a: 1, b: [1, 2, 3] })]) {
    assert.equal(openSecret(sealSecret(claro)), claro);
  }
});

test('o envelope nao contem o texto claro', () => {
  // O ponto da cifragem. Se isto falhar, tudo o mais e decoracao.
  const envelope = sealSecret('credencial-secreta-do-jean');
  assert.doesNotMatch(envelope, /credencial-secreta-do-jean/);
  assert.match(envelope, /^v1\./, 'o envelope precisa ser versionado');
});

test('IV aleatorio: selar duas vezes o mesmo texto da envelopes diferentes', () => {
  // Reusar IV em GCM vaza o XOR entre os dois textos. O IV precisa ser sorteado por chamada,
  // e nao derivado da chave ou do conteudo.
  const a = sealSecret('mesmo texto');
  const b = sealSecret('mesmo texto');
  assert.notEqual(a, b);
  assert.equal(openSecret(a), openSecret(b));
});

test('adulterar o blob faz openSecret LANCAR, nao devolver lixo', () => {
  // E o "A" do GCM: autenticado. Um blob editado no banco tem que falhar alto.
  const envelope = sealSecret('conteudo integro');
  const partes = envelope.split('.');
  const dados = Buffer.from(partes[3], 'base64url');
  dados[0] ^= 0xff; // vira um bit
  partes[3] = dados.toString('base64url');
  assert.throws(() => openSecret(partes.join('.')));
});

test('chave errada LANCA', () => {
  const envelope = sealSecret('conteudo');
  comChave('b'.repeat(64), () => {
    assert.throws(() => openSecret(envelope));
  });
});

test('chave ausente ou malformada LANCA nomeando a variavel', () => {
  // Sem fallback derivado de outro segredo, de proposito: um fallback silencioso gravaria a
  // sessao hoje e a tornaria ilegivel no dia em que a variavel certa fosse definida.
  comChave(null, () => {
    assert.throws(() => sealSecret('x'), /WHATSAPP_SECRETS_KEY ausente/);
    assert.equal(chaveConfigurada(), false);
  });
  for (const ruim of ['curta', 'z'.repeat(64), 'ab'.repeat(20)]) {
    comChave(ruim, () => assert.throws(() => sealSecret('x'), /WHATSAPP_SECRETS_KEY/));
  }
  assert.equal(chaveConfigurada(), true, 'com a chave boa, volta a funcionar');
});

test('formato de envelope desconhecido LANCA', () => {
  for (const ruim of ['', 'nao-e-envelope', 'v9.a.b.c', 'v1.so.tres']) {
    assert.throws(() => openSecret(ruim));
  }
});

// ══════════════════ Auth state ══════════════════

test('sessao nova nasce com creds geradas e nada no banco', () => {
  zerar();
  const { state } = criarAuthState();
  assert.ok(state.creds, 'initAuthCreds precisa ter rodado');
  assert.ok(state.creds.noiseKey, 'creds sem noiseKey nao serve para parear');
  // Ler nao grava: so o saveCreds grava.
  assert.equal(contarChavesAuth(), 0);
});

test('saveCreds grava CIFRADO — a coluna nao entrega a credencial', async () => {
  zerar();
  const { state, saveCreds } = criarAuthState();
  await saveCreds();

  const linha = db.getDb().prepare("SELECT value FROM baileys_auth WHERE key = 'creds'").get();
  assert.ok(linha, 'creds precisa estar no banco');
  assert.match(linha.value, /^v1\./);
  // O registrationId e um numero conhecido dentro das creds; ele nao pode aparecer cru.
  assert.doesNotMatch(linha.value, new RegExp(String(state.creds.registrationId)));
});

test('RELOAD: creds sobrevivem a descartar o objeto em memoria', async () => {
  // O teste central deste arquivo. Grava, joga fora, rele do banco, compara.
  zerar();
  const primeiro = criarAuthState();
  await primeiro.saveCreds();
  const antes = primeiro.state.creds;

  const segundo = criarAuthState(); // objeto novo, lido do banco
  const depois = segundo.state.creds;

  assert.equal(depois.registrationId, antes.registrationId);
  assert.equal(depois.advSecretKey, antes.advSecretKey);
  // ── O QUE MAIS IMPORTA: Buffer tem que voltar Buffer ──
  // Sem BufferJSON.reviver, isto seria { type:'Buffer', data:[...] } — um objeto que o
  // Baileys aceitaria e usaria como chave criptografica, corrompendo a sessao de um jeito
  // que so aparece depois, como falha de decriptacao.
  assert.ok(Buffer.isBuffer(depois.noiseKey.private), 'noiseKey.private precisa ser Buffer');
  assert.ok(Buffer.isBuffer(depois.noiseKey.public));
  assert.deepEqual(depois.noiseKey.private, antes.noiseKey.private);
  assert.deepEqual(depois.signedIdentityKey.private, antes.signedIdentityKey.private);
});

test('keys.set grava e keys.get devolve, com Buffer intacto', async () => {
  zerar();
  const { state } = criarAuthState();
  const valor = { keyPair: { private: Buffer.from([1, 2, 3]), public: Buffer.from([4, 5, 6]) } };

  await state.keys.set({ 'pre-key': { '7': valor } });
  const lido = await state.keys.get('pre-key', ['7']);

  assert.ok(Buffer.isBuffer(lido['7'].keyPair.private));
  assert.deepEqual(lido['7'].keyPair.private, valor.keyPair.private);
});

test('keys.get de id inexistente devolve objeto sem a chave, e nao undefined solto', async () => {
  zerar();
  const { state } = criarAuthState();
  const lido = await state.keys.get('pre-key', ['404', '405']);
  // Contrato do Baileys: objeto id->valor, com as ausentes simplesmente faltando.
  assert.deepEqual(lido, {});
});

test('keys.set com null APAGA — e parte do contrato, nao caso de borda', async () => {
  // E assim que o Baileys descarta pre-key ja consumida.
  zerar();
  const { state } = criarAuthState();
  await state.keys.set({ 'pre-key': { '9': { x: 1 } } });
  assert.equal(contarChavesAuth(), 1);

  await state.keys.set({ 'pre-key': { '9': null } });
  assert.equal(contarChavesAuth(), 0);
  assert.deepEqual(await state.keys.get('pre-key', ['9']), {});
});

test('keys.set grava o lote inteiro numa transacao', async () => {
  zerar();
  const { state } = criarAuthState();
  const lote = {};
  for (let i = 0; i < 25; i += 1) lote[String(i)] = { n: i };
  await state.keys.set({ 'pre-key': lote });
  assert.equal(contarChavesAuth(), 25);
});

test('saveCreds e idempotente: regravar nao duplica linha', async () => {
  zerar();
  const { saveCreds } = criarAuthState();
  await saveCreds();
  await saveCreds();
  await saveCreds();
  assert.equal(
    db.getDb().prepare("SELECT COUNT(*) n FROM baileys_auth WHERE key = 'creds'").get().n,
    1,
    'a PK composta (instance_id, key) e o upsert garantem uma linha so',
  );
});

test('chave de cifragem trocada: creds ilegivel LANCA em vez de virar sessao nova', async () => {
  // O caminho silencioso seria devolver null e deixar o Baileys pedir pareamento de novo —
  // sem ninguem entender por que o numero desconectou. Melhor falhar dizendo o motivo.
  zerar();
  const { saveCreds } = criarAuthState();
  await saveCreds();

  comChave('c'.repeat(64), () => {
    assert.throws(() => criarAuthState(), /Unsupported state|unable to authenticate|bad decrypt/i);
  });
});

test('limparAuthState apaga a sessao inteira e devolve quantas chaves sairam', async () => {
  // Usado no logout confirmado (401).
  zerar();
  const { state, saveCreds } = criarAuthState();
  await saveCreds();
  await state.keys.set({ 'pre-key': { '1': { a: 1 }, '2': { b: 2 } } });
  assert.equal(contarChavesAuth(), 3);

  assert.equal(limparAuthState(), 3);
  assert.equal(contarChavesAuth(), 0);
  // E depois de limpar, a proxima sessao nasce nova.
  assert.ok(criarAuthState().state.creds.noiseKey);
});
