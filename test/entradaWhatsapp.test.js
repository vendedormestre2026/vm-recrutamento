'use strict';

// B6 — captura do "SAIR": classificacao das mensagens recebidas + registro do opt-out.
//
// Nenhum socket. A classificacao e pura (lib/entradaWhatsapp) e o handler de connection.js e
// exercitado com o registrador injetado — nada e gravado no banco por estes testes.
//
// ══════════════════════════════════════════════════════════════
// O TESTE MAIS IMPORTANTE DESTE ARQUIVO E O DO HISTORICO
// ══════════════════════════════════════════════════════════════
// Ao parear, o Baileys despeja conversas antigas no MESMO evento. Agir sobre elas registraria
// opt-out em massa a partir de mensagens de meses atras — um apagao silencioso da base, feito por
// nos. As duas travas (type 'notify' e timestamp >= boot) tem teste cada uma.

const os = require('node:os');
const path = require('node:path');

// conectar() monta o auth state do Baileys, que le/grava em baileys_auth — entao o banco precisa
// existir. Nenhum teste daqui envia nada; o socket e um duble.
process.env.DATABASE_PATH = path.join(
  os.tmpdir(),
  `vm-test-entrada-wa-${process.pid}-${Date.now()}.db`,
);
process.env.INTERVIEW_MOCK = 'true';
process.env.SESSION_SECRET = 'segredo-de-teste';
process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert/strict');

const { migrar } = require('../src/db/migrate');
const entrada = require('../src/lib/entradaWhatsapp');
const conexao = require('../src/whatsapp/connection');

migrar();

const BOOT = Date.UTC(2026, 9, 1, 12, 0, 0); // 01/10/2026 12:00Z
const DEPOIS = BOOT + 60 * 1000;
const ANTES = BOOT - 60 * 1000;

// Mensagem no formato que o Baileys entrega. `ts` em MILISSEGUNDOS (a funcao converte de segundos).
function msg({ texto = 'sair', jid = '5547999582500@s.whatsapp.net', fromMe = false, ts = DEPOIS, extendida = false, semTexto = false } = {}) {
  const message = semTexto
    ? { imageMessage: { caption: texto } }
    : extendida
      ? { extendedTextMessage: { text: texto } }
      : { conversation: texto };
  return {
    key: { remoteJid: jid, fromMe, id: 'ABC123' },
    messageTimestamp: Math.floor(ts / 1000),
    message,
  };
}

const upsert = (mensagens, tipo = 'notify') => ({ type: tipo, messages: mensagens });
const decidir = (mensagens, tipo = 'notify') =>
  entrada.classificarUpsert(upsert(mensagens, tipo), { bootEm: BOOT });
const decisoes = (mensagens, tipo = 'notify') => decidir(mensagens, tipo).map((d) => d.decisao);

// ══════════════════ AS DUAS TRAVAS DO HISTORICO ══════════════════

test("TRAVA 1: type 'append' (despejo de historico) e integralmente descartado", () => {
  const ds = decisoes([msg({ texto: 'sair' }), msg({ texto: 'parar' })], 'append');
  assert.deepEqual(ds, [entrada.DESCARTE_TIPO, entrada.DESCARTE_TIPO]);
});

test("TRAVA 1: qualquer type que nao seja 'notify' e descartado", () => {
  // O evento e montado a mao (e nao pelo helper) porque o default do helper e 'notify': passar
  // `undefined` por ele cairia justamente no caso que o teste quer excluir.
  for (const tipo of ['append', 'prepend', '', undefined, 'NOTIFY']) {
    const ds = entrada.classificarUpsert({ type: tipo, messages: [msg()] }, { bootEm: BOOT });
    assert.deepEqual(ds.map((d) => d.decisao), [entrada.DESCARTE_TIPO], `tipo ${tipo}`);
  }
});

test('TRAVA 2: mensagem ANTERIOR ao boot e descartada, mesmo vindo como notify', () => {
  // Historico pode chegar marcado como 'notify' em algumas versoes. O timestamp e o que nao mente.
  const ds = decidir([msg({ texto: 'sair', ts: ANTES })]);
  assert.equal(ds[0].decisao, entrada.DESCARTE_HISTORICO);
});

test('TRAVA 2: sem timestamp legivel tambem e descartada (nao ha como afirmar que e nova)', () => {
  const semTs = { key: { remoteJid: '5547999582500@s.whatsapp.net' }, message: { conversation: 'sair' } };
  const comTsQuebrado = { ...msg(), messageTimestamp: { estranho: true } };
  assert.equal(entrada.classificarMensagem(semTs, { bootEm: BOOT }).decisao, entrada.DESCARTE_HISTORICO);
  assert.equal(entrada.classificarMensagem(comTsQuebrado, { bootEm: BOOT }).decisao, entrada.DESCARTE_HISTORICO);
});

test('TRAVA 2: uma leva de historico com 200 "sair" nao produz NENHUM opt-out', () => {
  // O cenario real do pareamento. Este e o teste que separa "funciona" de "destruiu a base".
  const historico = Array.from({ length: 200 }, (_, i) =>
    msg({ texto: 'sair', jid: `55479995${String(80000 + i).padStart(5, '0')}@s.whatsapp.net`, ts: ANTES }),
  );
  const ds = decidir(historico);
  assert.equal(ds.filter((d) => d.decisao === entrada.ACAO_OPTOUT).length, 0);
  assert.equal(ds.length, 200);
});

test('mensagem NOVA (depois do boot) e avaliada normalmente', () => {
  const d = decidir([msg({ texto: 'sair', ts: DEPOIS })])[0];
  assert.equal(d.decisao, entrada.ACAO_OPTOUT);
  assert.equal(d.telefone, '5547999582500');
});

test('timestamp exatamente no boot conta como nova (comparacao inclusiva)', () => {
  assert.equal(entrada.classificarMensagem(msg({ ts: BOOT }), { bootEm: BOOT }).decisao, entrada.ACAO_OPTOUT);
});

test('timestamp como Long do protobuf (toNumber / low) e entendido', () => {
  // Um Number(objeto) viraria NaN, e NaN compara falso com tudo — deixando TODO historico passar.
  const comToNumber = { ...msg(), messageTimestamp: { toNumber: () => Math.floor(DEPOIS / 1000) } };
  const comLow = { ...msg(), messageTimestamp: { low: Math.floor(DEPOIS / 1000), high: 0 } };
  const comString = { ...msg(), messageTimestamp: String(Math.floor(DEPOIS / 1000)) };

  for (const m of [comToNumber, comLow, comString]) {
    assert.equal(entrada.classificarMensagem(m, { bootEm: BOOT }).decisao, entrada.ACAO_OPTOUT);
  }
});

// ══════════════════ FILTROS DE ORIGEM ══════════════════

test('mensagem NOSSA (fromMe) e descartada', () => {
  // Nossa propria campanha termina com "responda SAIR". Se ela fosse avaliada, o disparo
  // descadastraria a base inteira, um destinatario por vez.
  const d = decidir([msg({ texto: 'Para sair, responda SAIR', fromMe: true })])[0];
  assert.equal(d.decisao, entrada.DESCARTE_FROM_ME);
});

test('mensagem de GRUPO e descartada', () => {
  const d = decidir([msg({ texto: 'sair', jid: '123456789-987654@g.us' })])[0];
  assert.equal(d.decisao, entrada.DESCARTE_GRUPO);
});

test('@lid e descartado com motivo PROPRIO (nao e o telefone)', () => {
  // Registrar opt-out a partir de um @lid gravaria uma chave que nao corresponde a pessoa nenhuma —
  // um opt-out que nao suprime ninguem e pior que nenhum, porque parece ter funcionado.
  const d = decidir([msg({ texto: 'sair', jid: '98765432101234@lid' })])[0];
  assert.equal(d.decisao, entrada.DESCARTE_LID);
});

test('JID desconhecido (newsletter, broadcast) e descartado', () => {
  for (const jid of ['status@broadcast', '123@newsletter', '', 'sem-arroba']) {
    assert.equal(decidir([msg({ jid })])[0].decisao, entrada.DESCARTE_JID, jid);
  }
});

test('mensagem sem texto (imagem, audio) e descartada', () => {
  const d = decidir([msg({ texto: 'sair', semTexto: true })])[0];
  assert.equal(d.decisao, entrada.DESCARTE_SEM_TEXTO);
});

test('texto vem de conversation OU de extendedTextMessage', () => {
  assert.equal(decidir([msg({ texto: 'sair' })])[0].decisao, entrada.ACAO_OPTOUT);
  assert.equal(decidir([msg({ texto: 'sair', extendida: true })])[0].decisao, entrada.ACAO_OPTOUT);
});

// ══════════════════ A HEURISTICA (reusada, nao recopiada) ══════════════════

test('reconhece os pedidos de saida reais', () => {
  for (const texto of ['sair', 'SAIR', 'Sair', 'quero sair', 'parar', 'pare', 'cancelar', 'remover', 'stop', 'me remover agora']) {
    assert.equal(decidir([msg({ texto })])[0].decisao, entrada.ACAO_OPTOUT, texto);
  }
});

test('NAO descadastra quem escreve outra coisa — inclusive as armadilhas', () => {
  const naoSao = [
    'obrigado',
    'qual o horario?',
    'ainda tem vaga?',
    'nao quero parar de receber',      // negacao derruba
    'nao posso parar de agradecer',     // substring nao casa
    'cancelar minha candidatura',       // contexto alheio
    'quero sair da vaga antiga mas continuar no processo', // longa
    'saindo do trabalho agora',         // prefixo nao casa
  ];
  for (const texto of naoSao) {
    assert.equal(decidir([msg({ texto })])[0].decisao, entrada.DESCARTE_NAO_PEDE_SAIDA, texto);
  }
});

test('o telefone sai normalizado a partir do JID', () => {
  const d = decidir([msg({ jid: '5547999582500@s.whatsapp.net' })])[0];
  assert.equal(d.telefone, '5547999582500');
});

test('JID com numero impossivel e descartado por telefone invalido', () => {
  const d = decidir([msg({ jid: '12@s.whatsapp.net' })])[0];
  assert.equal(d.decisao, entrada.DESCARTE_TELEFONE);
});

// ══════════════════ ROBUSTEZ ══════════════════

test('classificarUpsert nunca lanca, qualquer que seja a entrada', () => {
  for (const evento of [null, undefined, {}, { type: 'notify' }, { type: 'notify', messages: null }, { messages: [null, undefined, 1, 'x'] }]) {
    assert.doesNotThrow(() => entrada.classificarUpsert(evento, { bootEm: BOOT }));
  }
  assert.deepEqual(entrada.classificarUpsert({ type: 'notify', messages: [] }, { bootEm: BOOT }), []);
});

test('mensagem malformada no meio de um lote nao contamina as outras', () => {
  const ds = decidir([msg({ texto: 'sair' }), null, msg({ texto: 'obrigado' })]);
  assert.equal(ds.length, 3);
  assert.equal(ds[0].decisao, entrada.ACAO_OPTOUT);
  assert.equal(ds[2].decisao, entrada.DESCARTE_NAO_PEDE_SAIDA);
});

// ══════════════════ O HANDLER DE connection.js ══════════════════

function comLogsSilenciados(fn) {
  const { log, warn, error } = console;
  console.log = () => {};
  console.warn = () => {};
  console.error = () => {};
  try {
    return fn();
  } finally {
    console.log = log;
    console.warn = warn;
    console.error = error;
  }
}

test('o handler registra opt-out de ESCOPO CAMPANHA, nunca total', () => {
  // Quem responde "SAIR" a uma divulgacao quer parar de receber ofertas — nao perder o resultado de
  // uma candidatura futura (WA1/WA2), que so `total` suprimiria.
  const registros = [];
  const r = comLogsSilenciados(() =>
    conexao.tratarMensagensRecebidas(upsert([msg({ texto: 'sair' })]), {
      bootEm: BOOT,
      registrarOptout: (args) => registros.push(args),
    }),
  );

  assert.equal(r.optouts, 1);
  assert.equal(registros.length, 1);
  assert.equal(registros[0].telefone, '5547999582500');
  assert.equal(registros[0].escopo, 'campanha');
  assert.notEqual(registros[0].escopo, 'total');
  assert.equal(registros[0].origem, 'resposta');
  assert.match(registros[0].motivo, /sair/);
});

test('o handler NAO registra nada para historico, grupo, @lid e fromMe', () => {
  const registros = [];
  const r = comLogsSilenciados(() =>
    conexao.tratarMensagensRecebidas(
      upsert([
        msg({ texto: 'sair', ts: ANTES }),
        msg({ texto: 'sair', jid: '123-456@g.us' }),
        msg({ texto: 'sair', jid: '99999@lid' }),
        msg({ texto: 'sair', fromMe: true }),
        msg({ texto: 'obrigado' }),
      ]),
      { bootEm: BOOT, registrarOptout: (args) => registros.push(args) },
    ),
  );

  assert.equal(registros.length, 0);
  assert.equal(r.optouts, 0);
  assert.equal(r.descartadas, 5);
  assert.equal(r.porMotivo[entrada.DESCARTE_HISTORICO], 1);
  assert.equal(r.porMotivo[entrada.DESCARTE_GRUPO], 1);
  assert.equal(r.porMotivo[entrada.DESCARTE_LID], 1);
  assert.equal(r.porMotivo[entrada.DESCARTE_FROM_ME], 1);
});

test('falha ao gravar o opt-out NAO derruba o listener', () => {
  // Este codigo roda dentro de um listener do socket: uma excecao sobe pelo event emitter do
  // Baileys e pode derrubar a conexao — um texto inesperado de UMA pessoa tiraria o WhatsApp do ar.
  const r = comLogsSilenciados(() =>
    conexao.tratarMensagensRecebidas(upsert([msg({ texto: 'sair' }), msg({ texto: 'parar', jid: '5531996820290@s.whatsapp.net' })]), {
      bootEm: BOOT,
      registrarOptout: () => { throw new Error('banco fora'); },
    }),
  );
  assert.equal(r.optouts, 0, 'nenhum registro deu certo');
});

test('o handler nao lanca com evento invalido', () => {
  for (const evento of [null, undefined, {}, { type: 'notify', messages: 'x' }]) {
    assert.doesNotThrow(() =>
      comLogsSilenciados(() => conexao.tratarMensagensRecebidas(evento, { bootEm: BOOT, registrarOptout: () => {} })),
    );
  }
});

test('BOOT_EM e fixado no carregamento do modulo (reconexao nao move o corte)', () => {
  // Se o corte fosse na abertura do socket, cada reconexao descartaria as mensagens que chegaram
  // durante a queda — perdendo pedidos de saida legitimos.
  assert.equal(typeof conexao.BOOT_EM, 'number');
  assert.ok(conexao.BOOT_EM <= Date.now());
});

test('o socket registra o listener de messages.upsert', async () => {
  // Trava de fiacao: a classificacao pode estar perfeita e o listener nao existir. Era exatamente o
  // estado anterior a este incremento — o projeto nao lia mensagem de entrada nenhuma.
  process.env.WHATSAPP_BAILEYS_ATIVO = 'true';
  const eventos = [];
  const socketFalso = {
    ev: { on: (nome) => eventos.push(nome) },
    end: () => {},
  };

  conexao._resetar();
  await comLogsSilenciados(() => conexao.conectar({ criarSocket: () => socketFalso }));

  assert.ok(eventos.includes('messages.upsert'), 'o listener de entrada precisa estar registrado');
  assert.ok(eventos.includes('creds.update'));
  assert.ok(eventos.includes('connection.update'));
  conexao._resetar();
  delete process.env.WHATSAPP_BAILEYS_ATIVO;
});
