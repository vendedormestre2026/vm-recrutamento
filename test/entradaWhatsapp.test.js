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

const db = require('../src/db');
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
//
// ⚠️ A GRAVACAO E ASSINCRONA. O handler classifica e EMPILHA; quem grava e um dreno em
// setImmediate, uma entrada por tick. Por isso todo teste que confere `registros` precisa drenar
// antes — e e justamente essa espera que PROVA que nada foi gravado dentro do callback do socket.
async function drenar() {
  // Um tick por entrada da fila, com folga. O dreno se reagenda enquanto houver item.
  for (let i = 0; i < 400 && conexao.tamanhoFilaSaida() > 0; i += 1) {
    await new Promise((r) => setImmediate(r));
  }
  await new Promise((r) => setImmediate(r));
}

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

test('o handler registra opt-out de ESCOPO CAMPANHA, nunca total', async () => {
  // Quem responde "SAIR" a uma divulgacao quer parar de receber ofertas — nao perder o resultado de
  // uma candidatura futura (WA1/WA2), que so `total` suprimiria.
  const registros = [];
  const r = comLogsSilenciados(() =>
    conexao.tratarMensagensRecebidas(upsert([msg({ texto: 'sair' })]), {
      bootEm: BOOT,
      capturaAtiva: true,
      recebeuMassaRecente: () => true,
      registrarOptout: (args) => registros.push(args),
    }),
  );

  assert.equal(r.enfileirados, 1);
  assert.equal(registros.length, 0, 'nada gravado ainda: a gravacao sai do caminho do socket');
  await drenar();
  assert.equal(registros.length, 1);
  assert.equal(registros[0].telefone, '5547999582500');
  assert.equal(registros[0].escopo, 'campanha');
  assert.notEqual(registros[0].escopo, 'total');
  assert.equal(registros[0].origem, 'resposta');
  assert.match(registros[0].motivo, /sair/);
});

test('o handler NAO registra nada para historico, grupo, @lid e fromMe', async () => {
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
      { bootEm: BOOT, capturaAtiva: true, recebeuMassaRecente: () => true, registrarOptout: (args) => registros.push(args) },
    ),
  );

  await drenar();
  assert.equal(registros.length, 0);
  assert.equal(r.enfileirados, 0);
  assert.equal(r.descartadas, 5);
  assert.equal(r.porMotivo[entrada.DESCARTE_HISTORICO], 1);
  assert.equal(r.porMotivo[entrada.DESCARTE_GRUPO], 1);
  assert.equal(r.porMotivo[entrada.DESCARTE_LID], 1);
  assert.equal(r.porMotivo[entrada.DESCARTE_FROM_ME], 1);
});

test('falha ao gravar o opt-out NAO derruba o listener', async () => {
  // Este codigo roda dentro de um listener do socket: uma excecao sobe pelo event emitter do
  // Baileys e pode derrubar a conexao — um texto inesperado de UMA pessoa tiraria o WhatsApp do ar.
  const r = comLogsSilenciados(() =>
    conexao.tratarMensagensRecebidas(upsert([msg({ texto: 'sair' }), msg({ texto: 'parar', jid: '5531996820290@s.whatsapp.net' })]), {
      bootEm: BOOT,
      capturaAtiva: true,
      recebeuMassaRecente: () => true,
      registrarOptout: () => { throw new Error('banco fora'); },
    }),
  );
  assert.equal(r.enfileirados, 2, 'os dois foram enfileirados');
  // A excecao acontece no DRENO, fora do callback do socket. Drenar nao pode lancar.
  await assert.doesNotReject(async () => { await drenar(); });
  assert.equal(conexao.tamanhoFilaSaida(), 0, 'a fila drenou mesmo com as duas gravacoes falhando');
});

test('o handler nao lanca com evento invalido', () => {
  for (const evento of [null, undefined, {}, { type: 'notify', messages: 'x' }]) {
    assert.doesNotThrow(() =>
      comLogsSilenciados(() => conexao.tratarMensagensRecebidas(evento, { bootEm: BOOT, capturaAtiva: true, registrarOptout: () => {} })),
    );
  }
});

// ══════════════════ O INTERRUPTOR DA CAPTURA ══════════════════

test('DESLIGADO (o default): nao classifica e nao grava nada', () => {
  // O listener e registrado sob WHATSAPP_BAILEYS_ATIVO, que em producao ja esta ligado. Sem esta
  // chave propria, o simples deploy do codigo faria o sistema comecar a gravar opt-out a partir de
  // respostas — comportamento novo que escreve na base chegando como efeito colateral de um deploy.
  const registros = [];
  const r = comLogsSilenciados(() =>
    conexao.tratarMensagensRecebidas(upsert([msg({ texto: 'sair' }), msg({ texto: 'parar' })]), {
      bootEm: BOOT,
      capturaAtiva: false,
      registrarOptout: (args) => registros.push(args),
    }),
  );

  assert.equal(r.desativado, true);
  assert.equal(r.enfileirados, 0);
  assert.equal(r.descartadas, 0, 'nem chega a classificar');
  assert.equal(registros.length, 0);
});

test('o interruptor e LIDO DO BANCO quando nao e injetado, e o default e OFF', async () => {
  const registros = [];
  const deps = { bootEm: BOOT, recebeuMassaRecente: () => true, registrarOptout: (args) => registros.push(args) };

  // Sem a chave no banco: desligado.
  db.getDb().prepare('DELETE FROM configuracoes WHERE chave = ?').run(entrada.CHAVE_CAPTURA_ATIVA);
  assert.equal(
    comLogsSilenciados(() => conexao.tratarMensagensRecebidas(upsert([msg({ texto: 'sair' })]), deps)).desativado,
    true,
  );
  assert.equal(registros.length, 0);

  // Ligada pelo painel: passa a capturar.
  db.definirConfigBool(entrada.CHAVE_CAPTURA_ATIVA, true);
  const r = comLogsSilenciados(() => conexao.tratarMensagensRecebidas(upsert([msg({ texto: 'sair' })]), deps));
  assert.equal(r.desativado, undefined);
  assert.equal(r.enfileirados, 1);
  await drenar();

  // Desligada de novo: para na hora.
  db.definirConfigBool(entrada.CHAVE_CAPTURA_ATIVA, false);
  assert.equal(
    comLogsSilenciados(() => conexao.tratarMensagensRecebidas(upsert([msg({ texto: 'sair' })]), deps)).desativado,
    true,
  );
  assert.equal(registros.length, 1, 'so o envio da janela ligada foi gravado');
});

// ══════════════════ A FILA (a gravacao fora do caminho do socket) ══════════════════

test('uma rajada de N "SAIR" NAO executa N escritas dentro do callback do socket', async () => {
  // O teste que o ajuste existe para sustentar. A gravacao e SINCRONA (better-sqlite3): se ela
  // acontecesse no handler, N pedidos legitimos viravam N fsyncs seguidos no event loop do socket.
  const N = 50;
  const registros = [];
  const mensagens = Array.from({ length: N }, (_, i) =>
    msg({ texto: 'sair', jid: `55479995${String(80000 + i).padStart(5, '0')}@s.whatsapp.net` }),
  );

  const r = comLogsSilenciados(() =>
    conexao.tratarMensagensRecebidas(upsert(mensagens), {
      bootEm: BOOT,
      capturaAtiva: true,
      recebeuMassaRecente: () => true,
      registrarOptout: (args) => registros.push(args),
    }),
  );

  assert.equal(r.enfileirados, N);
  assert.equal(registros.length, 0, 'ZERO escritas dentro do callback');
  assert.equal(conexao.tamanhoFilaSaida(), N);

  // Uma por tick: depois de UM tick, no maximo uma escrita aconteceu.
  await new Promise((resolve) => setImmediate(resolve));
  assert.ok(registros.length <= 1, `escreveu ${registros.length} num unico tick`);

  await drenar();
  assert.equal(registros.length, N, 'todas gravadas ao final');
  assert.equal(conexao.tamanhoFilaSaida(), 0);
});

test('a fila tem TETO: o excedente e descartado, e a memoria nao cresce sem limite', async () => {
  // Crescer sem limite transformaria um banco travado em OOM, matando o processo e levando a conexao
  // do WhatsApp junto. Perder o registro de um pedido e ruim; perder a conexao para todos e pior.
  const acima = conexao.TETO_FILA_SAIDA + 20;
  const registros = [];
  const mensagens = Array.from({ length: acima }, (_, i) =>
    msg({ texto: 'sair', jid: `5547${String(900000000 + i)}@s.whatsapp.net` }),
  );

  const r = comLogsSilenciados(() =>
    conexao.tratarMensagensRecebidas(upsert(mensagens), {
      bootEm: BOOT,
      capturaAtiva: true,
      recebeuMassaRecente: () => true,
      registrarOptout: (args) => registros.push(args),
    }),
  );

  assert.equal(r.enfileirados, conexao.TETO_FILA_SAIDA);
  assert.equal(r.descartadosFila, 20);
  assert.ok(conexao.tamanhoFilaSaida() <= conexao.TETO_FILA_SAIDA);

  await drenar();
  assert.equal(registros.length, conexao.TETO_FILA_SAIDA);
});

test('o dreno sobrevive a uma gravacao que lanca e continua com as seguintes', async () => {
  const registros = [];
  let n = 0;
  comLogsSilenciados(() =>
    conexao.tratarMensagensRecebidas(
      upsert([
        msg({ texto: 'sair', jid: '5547999580001@s.whatsapp.net' }),
        msg({ texto: 'parar', jid: '5547999580002@s.whatsapp.net' }),
        msg({ texto: 'stop', jid: '5547999580003@s.whatsapp.net' }),
      ]),
      {
        bootEm: BOOT,
        capturaAtiva: true,
        recebeuMassaRecente: () => true,
        registrarOptout: (args) => {
          n += 1;
          if (n === 2) throw new Error('banco fora');
          registros.push(args);
        },
      },
    ),
  );

  await drenar();
  assert.equal(n, 3, 'as tres tentativas aconteceram');
  assert.equal(registros.length, 2, 'a do meio falhou, as outras duas passaram');
  assert.equal(conexao.tamanhoFilaSaida(), 0);
});

// ══════════════════ A TRAVA DE CONTEXTO: SO QUEM RECEBEU DISPARO EM MASSA RECENTE ══════════════════
//
// O listener le TODA mensagem que chega ao numero, inclusive de quem esta apenas no fluxo
// transacional (WA1/WA2) e nunca recebeu campanha. Um "sair" dessa pessoa quase sempre significa
// "quero sair do processo seletivo", nao "parem de me oferecer vagas" — e registrar opt-out de
// campanha ali responde a pergunta errada: ela continua recebendo o que a incomodava e perde o que
// nem citou.

const { JANELA_MASSA_DIAS } = entrada;

// Cria um envio em massa JA ENVIADO para um telefone canonico, com `enviado_em` controlado.
function envioEmMassa(telefoneCanonico, diasAtras) {
  const jobId = db.criarVaga({ slug: `v-trava-${Date.now()}-${Math.random().toString(16).slice(2)}`, titulo: 'Closer', perfil: 'CLOSER' });
  const campanhaId = db.criarCampanhaMassaWa({ nome: 'Campanha trava' });
  db.definirStatusCampanhaMassaWa(campanhaId, 'ativa');
  db.materializarCampanhaMassaWa(campanhaId, [
    { telefone: '5547999582500', telefoneCanonico, nome: 'Pessoa', jobId },
  ]);
  const envio = db.listarPendentesCampanhaMassaWa(campanhaId, { limite: 1 })[0];
  const quando = new Date(Date.now() - diasAtras * 24 * 60 * 60 * 1000)
    .toISOString().replace('T', ' ').slice(0, 19);
  db.marcarEnvioMassaWaEnviado(envio.id, { variacaoIndice: 1, quando });
  return campanhaId;
}

function limparMassa() {
  const conn = db.getDb();
  conn.exec('DELETE FROM campanhas_massa_wa_envios');
  conn.exec('DELETE FROM campanhas_massa_wa_variacoes');
  conn.exec('DELETE FROM campanhas_massa_wa');
  conn.exec('DELETE FROM jobs');
}

// O handler com a trava REAL (sem injetar recebeuMassaRecente), lendo do banco.
async function comTravaReal(texto, jid = '5547999582500@s.whatsapp.net') {
  const registros = [];
  comLogsSilenciados(() =>
    conexao.tratarMensagensRecebidas(upsert([msg({ texto, jid })]), {
      bootEm: BOOT,
      capturaAtiva: true,
      registrarOptout: (args) => registros.push(args),
    }),
  );
  await drenar();
  return registros;
}

test('COM disparo em massa recente: registra o opt-out', async () => {
  limparMassa();
  envioEmMassa('554799582500', 1); // ontem
  const registros = await comTravaReal('sair');
  assert.equal(registros.length, 1);
  assert.equal(registros[0].escopo, 'campanha');
});

test('SEM disparo em massa nenhum: NAO registra, so loga', async () => {
  // O caso de quem esta apenas no WA1/WA2. O "sair" dele nao vira opt-out de campanha.
  limparMassa();
  const registros = await comTravaReal('sair');
  assert.equal(registros.length, 0);
});

test('disparo em massa com MAIS de 7 dias: NAO registra', async () => {
  limparMassa();
  envioEmMassa('554799582500', JANELA_MASSA_DIAS + 1);
  const registros = await comTravaReal('sair');
  assert.equal(registros.length, 0, 'um "sair" semanas depois provavelmente e sobre outra coisa');
});

test('na borda da janela (dentro de 7 dias) ainda registra', async () => {
  limparMassa();
  envioEmMassa('554799582500', JANELA_MASSA_DIAS - 1);
  assert.equal((await comTravaReal('sair')).length, 1);
});

test('a trava usa a chave CANONICA: recebeu sem o 9, responde com o 9', async () => {
  // A pessoa recebeu no numero sem o nono digito e responde pelo numero com o 9 (ou o contrario).
  // Sem a chave canonica, a trava concluiria "essa pessoa nunca recebeu nada" e ignoraria o pedido.
  limparMassa();
  envioEmMassa('553196820290', 1);
  const registros = await comTravaReal('sair', '5531996820290@s.whatsapp.net');
  assert.equal(registros.length, 1);
});

test('envio em massa que NAO saiu (pendente/falha) nao habilita a captura', async () => {
  // A trava pergunta "nos incomodamos esta pessoa?", e uma linha pendente nao incomodou ninguem.
  limparMassa();
  const jobId = db.criarVaga({ slug: `v-pend-${Date.now()}`, titulo: 'Closer', perfil: 'CLOSER' });
  const campanhaId = db.criarCampanhaMassaWa({ nome: 'So pendente' });
  db.definirStatusCampanhaMassaWa(campanhaId, 'ativa');
  db.materializarCampanhaMassaWa(campanhaId, [
    { telefone: '5547999582500', telefoneCanonico: '554799582500', nome: 'P', jobId },
  ]);

  assert.equal((await comTravaReal('sair')).length, 0);
});

test('"sair" com contexto de candidatura continua sendo ignorado pela heuristica, ANTES da trava', async () => {
  // A regra 4 de pedeSaida (contexto alheio) derruba o pedido mesmo com disparo recente: quem
  // escreve "cancelar minha candidatura" esta falando da candidatura, nao da divulgacao.
  limparMassa();
  envioEmMassa('554799582500', 1);
  for (const texto of ['cancelar minha candidatura', 'quero sair da vaga', 'nao quero parar']) {
    // eslint-disable-next-line no-await-in-loop
    assert.equal((await comTravaReal(texto)).length, 0, texto);
  }
});

test('recebeuMassaWaDesde: contrato da consulta', async () => {
  limparMassa();
  envioEmMassa('554799582500', 2);
  const desde3dias = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000).toISOString().replace('T', ' ').slice(0, 19);
  const desde1dia = new Date(Date.now() - 1 * 24 * 60 * 60 * 1000).toISOString().replace('T', ' ').slice(0, 19);

  assert.equal(db.recebeuMassaWaDesde('554799582500', desde3dias), true);
  assert.equal(db.recebeuMassaWaDesde('554799582500', desde1dia), false, 'o envio e mais antigo que a janela');
  assert.equal(db.recebeuMassaWaDesde('550000000000', desde3dias), false);
  assert.equal(db.recebeuMassaWaDesde(null, desde3dias), false);
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
