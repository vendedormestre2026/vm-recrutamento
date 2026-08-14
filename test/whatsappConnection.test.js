'use strict';

// Ciclo de vida da conexao (src/whatsapp/connection.js) e resolucao de versao
// (src/whatsapp/waVersion.js).
//
// ── ZERO WHATSAPP REAL ──
// Nenhum teste aqui abre socket, le QR ou fala com a Meta. `criarSocket` e injetado como
// dublê e `connection.update` e alimentado a mao. Parear o numero e acao manual, fora daqui.
//
// ── O QUE ESTA EM JOGO ──
// Tres eventos que chegam iguais (`connection: 'close'`) e exigem respostas OPOSTAS. Errar
// a distincao produz um dos dois desastres:
//   tratar 401 como queda   -> laco infinito de reconexao com credencial morta
//   tratar 515 como queda   -> backoff atrasando o pareamento que estava DANDO CERTO

const os = require('node:os');
const path = require('node:path');

process.env.DATABASE_PATH = path.join(os.tmpdir(), `vm-test-wa-conn-${process.pid}-${Date.now()}.db`);
process.env.INTERVIEW_MOCK = 'true';
process.env.SESSION_SECRET = 'segredo-de-teste';
process.env.WHATSAPP_SECRETS_KEY = 'd'.repeat(64);
process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert/strict');

const { migrar } = require('../src/db/migrate');
const conn = require('../src/whatsapp/connection');
const { resolverVersaoWa, limparCacheVersao, VERSAO_EMBUTIDA } = require('../src/whatsapp/waVersion');

migrar();

// Silencia os logs do modulo (que sao propositalmente barulhentos em producao).
function semRuido(fn) {
  const { log, warn, error } = console;
  console.log = console.warn = console.error = () => {};
  try {
    return fn();
  } finally {
    Object.assign(console, { log, warn, error });
  }
}

// `lastDisconnect` no formato que o Baileys entrega (erro embrulhado por Boom).
const desconexao = (statusCode) => ({ error: { output: { statusCode } } });

// Captura a decisao de reconexao sem reabrir nada.
function espiao() {
  const chamadas = [];
  return { fn: (atraso) => chamadas.push(atraso), chamadas };
}

// ══════════════════ waVersion ══════════════════

test('versao remota valida e usada e cacheada', async () => {
  limparCacheVersao();
  let chamadas = 0;
  const buscar = async () => {
    chamadas += 1;
    return { version: [2, 9999, 1] };
  };
  const a = await semRuido(() => resolverVersaoWa({ buscar }));
  assert.deepEqual(a.version, [2, 9999, 1]);
  assert.equal(a.origem, 'remota');

  const b = await resolverVersaoWa({ buscar });
  assert.equal(b.origem, 'cache');
  // O cache existe porque a reconexao com backoff chamaria isto varias vezes por minuto —
  // justamente quando a rede ja esta ruim.
  assert.equal(chamadas, 1, 'a segunda chamada nao pode ir a rede');
});

test('falha na consulta cai para a versao EMBUTIDA, e nao derruba a conexao', async () => {
  limparCacheVersao();
  const r = await semRuido(() =>
    resolverVersaoWa({
      buscar: async () => {
        throw new Error('ENOTFOUND');
      },
    }),
  );
  assert.deepEqual(r.version, VERSAO_EMBUTIDA);
  assert.equal(r.origem, 'embutida');
});

test('timeout na consulta tambem cai para a embutida', async () => {
  limparCacheVersao();
  const r = await semRuido(() =>
    resolverVersaoWa({ buscar: () => new Promise(() => {}), timeoutMs: 30 }),
  );
  assert.equal(r.origem, 'embutida');
});

test('resposta malformada nao vira versao', async () => {
  // Guarda contra o pior caso: uma versao invalida aceita faz o WhatsApp recusar a conexao
  // com um erro que nao diz nada sobre versao.
  for (const ruim of [undefined, null, [1, 2], [1, 2, 3, 4], ['a', 'b', 'c'], 'x']) {
    limparCacheVersao();
    const r = await semRuido(() => resolverVersaoWa({ buscar: async () => ({ version: ruim }) }));
    assert.equal(r.origem, 'embutida', JSON.stringify(ruim));
  }
});

test('resolverVersaoWa NUNCA lanca', async () => {
  limparCacheVersao();
  await assert.doesNotReject(() =>
    semRuido(() =>
      resolverVersaoWa({
        buscar: () => {
          throw new Error('sincrono');
        },
      }),
    ),
  );
});

// ══════════════════ connection.update ══════════════════

test('open: conecta, zera tentativas e apaga o QR', () => {
  conn._resetar();
  semRuido(() => conn.tratarUpdate({ qr: 'QR-CRU' }));
  assert.equal(conn.status().status, 'pareando');
  assert.equal(conn.qrAtual(), 'QR-CRU');

  const r = semRuido(() => conn.tratarUpdate({ connection: 'open' }));
  assert.equal(r.acao, 'conectado');
  assert.equal(conn.status().status, 'conectado');
  assert.equal(conn.status().tentativas, 0);
  // QR velho na tela e pior que nenhum: quem escaneia espera funcionar.
  assert.equal(conn.qrAtual(), null);
});

test('401 loggedOut: NAO reconecta e APAGA a sessao', () => {
  conn._resetar();
  const rec = espiao();
  let limpou = 0;

  const r = semRuido(() =>
    conn.tratarUpdate(
      { connection: 'close', lastDisconnect: desconexao(401) },
      { reconectar: rec.fn, limparAuth: () => { limpou += 1; return 3; } },
    ),
  );

  assert.equal(r.acao, 'logout');
  // Insistir com credencial morta e laco infinito — o erro que este ramo existe para impedir.
  assert.deepEqual(rec.chamadas, [], 'nao pode agendar reconexao');
  assert.equal(limpou, 1, 'a sessao morta precisa sair do banco');
  assert.equal(conn.status().status, 'desconectado');
});

test('515 restartRequired: reconecta IMEDIATO e sem penalidade', () => {
  conn._resetar();
  const rec = espiao();

  // Simula que ja houve quedas antes, para provar que o 515 ZERA o contador.
  semRuido(() => conn.tratarUpdate({ connection: 'close', lastDisconnect: desconexao(500) }, { reconectar: () => {} }));
  semRuido(() => conn.tratarUpdate({ connection: 'close', lastDisconnect: desconexao(500) }, { reconectar: () => {} }));
  assert.equal(conn.status().tentativas, 2);

  const r = semRuido(() =>
    conn.tratarUpdate({ connection: 'close', lastDisconnect: desconexao(515) }, { reconectar: rec.fn }),
  );

  assert.equal(r.acao, 'restart');
  // 515 e parte NORMAL do pareamento — atrasar aqui seria penalizar o fluxo que esta dando
  // certo, e o candidato/operador veria o QR "travar".
  assert.deepEqual(rec.chamadas, [0]);
  assert.equal(conn.status().tentativas, 0);
  assert.equal(conn.status().status, 'pareando');
});

test('queda comum: reconecta com backoff exponencial ate o teto', () => {
  conn._resetar();
  const rec = espiao();
  for (let i = 0; i < 9; i += 1) {
    semRuido(() =>
      conn.tratarUpdate({ connection: 'close', lastDisconnect: desconexao(503) }, { reconectar: rec.fn }),
    );
  }
  assert.deepEqual(
    rec.chamadas,
    [1000, 2000, 4000, 8000, 16000, 32000, 60000, 60000, 60000],
    'base 1s, dobrando, com teto de 60s',
  );
});

test('close SEM statusCode conhecido tambem reconecta', () => {
  // Ficar offline por um codigo que ninguem previu e pior que tentar de novo.
  conn._resetar();
  const rec = espiao();
  const r = semRuido(() => conn.tratarUpdate({ connection: 'close' }, { reconectar: rec.fn }));
  assert.equal(r.acao, 'reconectar');
  assert.equal(rec.chamadas.length, 1);
});

test('fechamento NOSSO nao dispara reconexao', () => {
  // Sem o Set `fechando`, desligar o sistema reabriria o socket que acabamos de fechar.
  conn._resetar();
  const rec = espiao();
  conn.fechando.add('jean');

  const r = semRuido(() =>
    conn.tratarUpdate({ connection: 'close', lastDisconnect: desconexao(503) }, { reconectar: rec.fn }),
  );

  assert.equal(r.acao, 'fechado_por_nos');
  assert.deepEqual(rec.chamadas, []);
  assert.equal(conn.fechando.has('jean'), false, 'a marca e consumida');
});

test('o QR e apagado em QUALQUER fechamento', () => {
  for (const code of [401, 515, 503, null]) {
    conn._resetar();
    semRuido(() => conn.tratarUpdate({ qr: 'QR-CRU' }));
    assert.equal(conn.qrAtual(), 'QR-CRU');
    semRuido(() =>
      conn.tratarUpdate(
        { connection: 'close', lastDisconnect: code === null ? undefined : desconexao(code) },
        { reconectar: () => {}, limparAuth: () => 0 },
      ),
    );
    assert.equal(conn.qrAtual(), null, `QR sobreviveu ao close ${code}`);
  }
});

// ══════════════════ Kill-switch de conexao ══════════════════

test('sem WHATSAPP_BAILEYS_ATIVO=true, conectar() NAO abre socket', async () => {
  conn._resetar();
  const original = process.env.WHATSAPP_BAILEYS_ATIVO;
  let criou = 0;
  try {
    for (const valor of [undefined, 'false', '0', 'sim', 'TRUE-ish']) {
      if (valor === undefined) delete process.env.WHATSAPP_BAILEYS_ATIVO;
      else process.env.WHATSAPP_BAILEYS_ATIVO = valor;
      const s = await semRuido(() => conn.conectar({ criarSocket: () => { criou += 1; return {}; } }));
      assert.equal(s, null, `valor ${valor} nao pode ligar a conexao`);
    }
    // O default e desligado: todo o resto do sistema funciona sem instancia de WhatsApp.
    assert.equal(criou, 0);
  } finally {
    if (original === undefined) delete process.env.WHATSAPP_BAILEYS_ATIVO;
    else process.env.WHATSAPP_BAILEYS_ATIVO = original;
  }
});

test('com o switch ligado, conectar() usa o socket INJETADO (nunca o real)', async () => {
  conn._resetar();
  limparCacheVersao();
  const original = process.env.WHATSAPP_BAILEYS_ATIVO;
  process.env.WHATSAPP_BAILEYS_ATIVO = 'true';
  try {
    const eventos = {};
    const fake = { ev: { on: (nome, fn) => { eventos[nome] = fn; } }, end: () => {} };
    let recebido = null;

    const s = await semRuido(() =>
      conn.conectar({
        criarSocket: (opts) => {
          recebido = opts;
          return fake;
        },
      }),
    );

    assert.equal(s, fake);
    // O socket precisa nascer com versao resolvida e auth state — sem um dos dois, o
    // pareamento falha de um jeito que nao se parece com "faltou config".
    assert.ok(Array.isArray(recebido.version) && recebido.version.length === 3);
    assert.ok(recebido.auth && recebido.auth.creds, 'auth state precisa ir no socket');
    assert.equal(recebido.printQRInTerminal, false, 'o QR e servido pelo painel, nao pelo stdout');
    // Os dois listeners obrigatorios: sem creds.update a sessao nunca persiste.
    assert.equal(typeof eventos['creds.update'], 'function');
    assert.equal(typeof eventos['connection.update'], 'function');
  } finally {
    if (original === undefined) delete process.env.WHATSAPP_BAILEYS_ATIVO;
    else process.env.WHATSAPP_BAILEYS_ATIVO = original;
    await semRuido(() => conn.desconectar());
    conn._resetar();
  }
});

test('desconectar marca o fechamento como nosso e limpa o QR', async () => {
  conn._resetar();
  semRuido(() => conn.tratarUpdate({ qr: 'QR-CRU' }));
  await semRuido(() => conn.desconectar());
  assert.equal(conn.qrAtual(), null);
  assert.equal(conn.status().status, 'desconectado');
  assert.equal(conn.fechando.has('jean'), true);
  conn._resetar();
});

test('shouldReconnect e isRestartRequired isolados', () => {
  assert.equal(conn.shouldReconnect(desconexao(401)), false);
  for (const c of [515, 503, 428, 500, null]) {
    assert.equal(conn.shouldReconnect(c === null ? undefined : desconexao(c)), true, String(c));
  }
  assert.equal(conn.isRestartRequired(desconexao(515)), true);
  assert.equal(conn.isRestartRequired(desconexao(401)), false);
});
