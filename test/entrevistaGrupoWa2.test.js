'use strict';

// B4 — o convite da entrevista em grupo PONTA A PONTA: da coluna de `jobs` ate o texto que o
// socket receberia, passando pelo SELECT da fila e pela gravacao da variante.
//
// ══════════════════════════════════════════════════════════════
// O DEFEITO QUE ESTE ARQUIVO EXISTE PARA PEGAR
// ══════════════════════════════════════════════════════════════
//
// O texto do WA2 e montado a partir do objeto `job` que textoDaEtapa constroi, e esse objeto so
// tem o que o SELECT de listarPendentesSequenciaWhatsapp trouxe. Uma coluna esquecida em
// QUALQUER um dos dois pontos nao produz erro nenhum: o campo chega `undefined`,
// proximaEntrevistaGrupo devolve null, e TODO candidato passa a receber o fallback "estamos
// definindo as datas" — com link e datas cadastrados na vaga, visiveis no painel.
//
// O sintoma seria "por que ninguem recebe o convite?", dias depois, sem uma linha de erro em
// lugar nenhum. Os testes de unidade do texto (test/whatsappSequencia.test.js) NAO pegam isso,
// porque la o `job` e montado a mao pelo proprio teste.
//
// Por isso aqui o caminho e o real: grava na vaga pelo db, le pela fila, e confere o texto.
//
// NENHUMA REDE: o envio e um duble em memoria (mock do socket), como no resto da suite.

const os = require('node:os');
const path = require('node:path');

process.env.DATABASE_PATH = path.join(
  os.tmpdir(),
  `vm-test-entrevista-grupo-wa2-${process.pid}-${Date.now()}.db`,
);
process.env.INTERVIEW_MOCK = 'true';
process.env.SESSION_SECRET = 'segredo-de-teste';
process.env.NODE_ENV = 'test';
process.env.WHATSAPP_BAILEYS_ATIVO = 'true'; // o ciclo checa o kill-switch de env
process.env.WHATSAPP_SEQUENCIA_MOCK = 'false'; // queremos ver o texto chegando ao "socket"

const test = require('node:test');
const assert = require('node:assert/strict');

const db = require('../src/db');
const { migrar } = require('../src/db/migrate');
const outbox = require('../src/whatsapp/sequenciaOutbox');

migrar();

const LINK_MEET = 'https://meet.google.com/abc-defg-hij';
const TELEFONE = '+55 (47) 99958-2500';

let seq = 0;

// Vaga com o que o convite precisa. Gravada pela camada de dados REAL (criarVaga), e nao por
// INSERT direto: a lista literal de colunas do INSERT e parte do caminho sob teste.
function criarVagaComReunioes(campos = {}) {
  seq += 1;
  return db.criarVaga({
    slug: `vaga-wa2-grupo-${seq}`,
    titulo: 'Vendedor Externo',
    perfil: 'CLOSER',
    empresa: 'Labor Seg',
    link_meet: LINK_MEET,
    entrevista_grupo_1_data: '2026-10-01',
    entrevista_grupo_1_hora: '19:30',
    entrevista_grupo_2_data: '2026-10-08',
    entrevista_grupo_2_hora: '20:00',
    entrevista_grupo_3_data: '2026-10-15',
    entrevista_grupo_3_hora: '09:15',
    ...campos,
  });
}

function criarApplication(jobId) {
  return Number(
    db
      .getDb()
      .prepare(
        `INSERT INTO applications (job_id, nome, telefone, criado_em)
         VALUES (?, 'Maria Souza', ?, '2020-01-01 00:00:00')`,
      )
      .run(jobId, TELEFONE).lastInsertRowid,
  );
}

// Agenda so o WA2 (o WA1 nao interessa aqui) e devolve a linha da fila.
function agendarWa2(applicationId) {
  db.agendarEnvioWhatsapp({
    applicationId,
    etapa: 'wa2',
    telefone: '5547999582500',
    agendadoPara: '2020-01-01 00:15:00',
    templateNome: 'wa2',
  });
  return db.listarPendentesSequenciaWhatsapp({ limite: 50 }).find((l) => l.application_id === applicationId);
}

// Silencia o console do ciclo (ele loga por destinatario). Mesmo padrao do resto da suite.
async function comLogs(fn) {
  const log = console.log;
  const warn = console.warn;
  const error = console.error;
  console.log = () => {};
  console.warn = () => {};
  console.error = () => {};
  try {
    return await fn();
  } finally {
    console.log = log;
    console.warn = warn;
    console.error = error;
  }
}

// Duble do envio: guarda o que sairia, sem socket nenhum.
function envioDuble() {
  const chamadas = [];
  return { chamadas, fn: async (telefone, texto) => { chamadas.push({ telefone, texto }); } };
}

// Roda um ciclo com o relogio injetado.
async function rodarCiclo(agora) {
  const envio = envioDuble();
  await comLogs(() =>
    outbox.processarCicloSequencia({
      db,
      mock: false,
      enviarTexto: envio.fn,
      // Numero existe: nao e isso que este arquivo testa.
      onWhatsAppLote: async (telefones) => new Map(telefones.map((t) => [t, true])),
      verificarExiste: async () => ({ existe: true }),
      intervaloMs: 0,
      dormir: async () => {},
      agoraData: agora,
    }),
  );
  return envio;
}

function ligarInterruptor() {
  db.definirConfigBool('whatsapp_sequencia_ativa', true);
}

function limpar() {
  const conn = db.getDb();
  conn.exec('DELETE FROM whatsapp_sequencia_envios');
  conn.exec('DELETE FROM applications');
  conn.exec('DELETE FROM jobs');
}

// 25/09/2026 10:00 em Brasilia: antes das tres reunioes.
const ANTES_DE_TUDO = new Date('2026-09-25T13:00:00Z');

// ══════════════════ textoDaEtapa sobre a LINHA REAL DA FILA ══════════════════

test('a linha da fila carrega link e datas, e o convite sai completo', () => {
  limpar();
  const linha = agendarWa2(criarApplication(criarVagaComReunioes()));

  const { texto, variante } = outbox.textoDaEtapa(linha, db, ANTES_DE_TUDO);

  assert.equal(variante, 'convite_grupo');
  assert.ok(texto.includes(LINK_MEET), 'o convite saiu SEM o link do Meet');
  assert.ok(texto.includes('quinta-feira, 01/10/2026'), 'o convite saiu SEM a data');
  assert.ok(texto.includes('19:30'), 'o convite saiu SEM o horario');
  assert.ok(texto.includes('Vendedor Externo na Labor Seg'));
});

test('FALHA se qualquer campo da entrevista em grupo nao chegar pela fila', () => {
  // Esta e a assercao que guarda o SELECT e o objeto `job`. Ela olha a LINHA, e nao o texto:
  // um alias esquecido no SQL aparece aqui como `undefined` muito antes de virar "ninguem
  // recebe o convite" em producao.
  limpar();
  const linha = agendarWa2(criarApplication(criarVagaComReunioes()));

  const esperados = {
    job_link_meet: LINK_MEET,
    job_entrevista_grupo_1_data: '2026-10-01',
    job_entrevista_grupo_1_hora: '19:30',
    job_entrevista_grupo_2_data: '2026-10-08',
    job_entrevista_grupo_2_hora: '20:00',
    job_entrevista_grupo_3_data: '2026-10-15',
    job_entrevista_grupo_3_hora: '09:15',
  };
  for (const [campo, valor] of Object.entries(esperados)) {
    assert.equal(linha[campo], valor, `a fila nao trouxe ${campo} — o convite sairia sem esse dado`);
  }
});

test('passada a reuniao 1, o MESMO cadastro anuncia a 2 (sem ninguem editar a vaga)', () => {
  limpar();
  const linha = agendarWa2(criarApplication(criarVagaComReunioes()));

  const antes = outbox.textoDaEtapa(linha, db, ANTES_DE_TUDO);
  const depois = outbox.textoDaEtapa(linha, db, new Date('2026-10-02T11:00:00Z'));

  assert.ok(antes.texto.includes('01/10/2026'));
  assert.ok(depois.texto.includes('08/10/2026'));
  assert.equal(depois.variante, 'convite_grupo');
});

test('vaga sem link/datas: fallback, e NENHUM link vencido', () => {
  limpar();
  const linha = agendarWa2(criarApplication(criarVagaComReunioes({ link_meet: null, entrevista_grupo_1_data: null, entrevista_grupo_1_hora: null, entrevista_grupo_2_data: null, entrevista_grupo_2_hora: null, entrevista_grupo_3_data: null, entrevista_grupo_3_hora: null })));

  const { texto, variante } = outbox.textoDaEtapa(linha, db, ANTES_DE_TUDO);
  assert.equal(variante, 'sem_reuniao');
  assert.ok(texto.includes('Estamos definindo as próximas datas'));
  assert.doesNotMatch(texto, /meet\.google\.com/);
});

test('todas as reunioes vencidas: fallback, e o link NAO vaza', () => {
  limpar();
  const linha = agendarWa2(criarApplication(criarVagaComReunioes()));

  const { texto, variante } = outbox.textoDaEtapa(linha, db, new Date('2026-10-16T11:00:00Z'));
  assert.equal(variante, 'sem_reuniao');
  assert.doesNotMatch(texto, /meet\.google\.com/, 'link de reuniao vencida nao pode sair');
  assert.doesNotMatch(texto, /\d{2}\/\d{2}\/\d{4}/);
});

// ══════════════════ O CICLO: o que sai no socket e o que fica gravado ══════════════════

test('ciclo real: o convite chega ao socket e a variante fica gravada', async () => {
  limpar();
  ligarInterruptor();
  const appId = criarApplication(criarVagaComReunioes());
  agendarWa2(appId);

  const envio = await rodarCiclo(ANTES_DE_TUDO);

  assert.equal(envio.chamadas.length, 1);
  assert.ok(envio.chamadas[0].texto.includes(LINK_MEET));
  assert.ok(envio.chamadas[0].texto.includes('quinta-feira, 01/10/2026'));

  const wa2 = db.listarSequenciaWhatsappDaApplication(appId).find((l) => l.etapa === 'wa2');
  assert.equal(wa2.status, 'enviado');
  assert.equal(wa2.variante, 'convite_grupo', 'a variante enviada precisa ficar registrada');
});

test('ciclo real: fallback tambem fica registrado como sem_reuniao', async () => {
  // E este registro que da a lista de quem precisa ser reconvidado a mao — o unico jeito,
  // porque nada reenvia o convite quando a data nova e cadastrada.
  limpar();
  ligarInterruptor();
  const appId = criarApplication(criarVagaComReunioes({ link_meet: null }));
  agendarWa2(appId);

  const envio = await rodarCiclo(ANTES_DE_TUDO);

  assert.equal(envio.chamadas.length, 1);
  assert.ok(envio.chamadas[0].texto.includes('Estamos definindo as próximas datas'));

  const wa2 = db.listarSequenciaWhatsappDaApplication(appId).find((l) => l.etapa === 'wa2');
  assert.equal(wa2.status, 'enviado');
  assert.equal(wa2.variante, 'sem_reuniao');
});

test('cadastrar a data DEPOIS nao reescreve a variante de quem ja recebeu o fallback', async () => {
  // O ponto da coluna existir. Se a ficha inferisse a variante do estado ATUAL da vaga, esta
  // pessoa passaria a aparecer como "recebeu o convite" no minuto em que a data fosse
  // cadastrada — e ela nunca recebeu link nenhum.
  limpar();
  ligarInterruptor();
  const jobId = criarVagaComReunioes({ link_meet: null });
  const appId = criarApplication(jobId);
  agendarWa2(appId);
  await rodarCiclo(ANTES_DE_TUDO);

  db.atualizarVaga(jobId, {
    titulo: 'Vendedor Externo',
    link_meet: LINK_MEET,
    entrevista_grupo_1_data: '2026-11-05',
    entrevista_grupo_1_hora: '19:00',
  });

  const wa2 = db.listarSequenciaWhatsappDaApplication(appId).find((l) => l.etapa === 'wa2');
  assert.equal(wa2.variante, 'sem_reuniao', 'a variante e um FATO do envio, nao do estado atual');
});

test('wa1 continua sem variante (a coluna e do WA2)', async () => {
  limpar();
  ligarInterruptor();
  const appId = criarApplication(criarVagaComReunioes());
  db.agendarEnvioWhatsapp({
    applicationId: appId,
    etapa: 'wa1',
    telefone: '5547999582500',
    agendadoPara: '2020-01-01 00:00:00',
    templateNome: 'wa1',
  });

  await rodarCiclo(ANTES_DE_TUDO);

  const wa1 = db.listarSequenciaWhatsappDaApplication(appId).find((l) => l.etapa === 'wa1');
  assert.equal(wa1.status, 'enviado');
  assert.equal(wa1.variante, null);
});
