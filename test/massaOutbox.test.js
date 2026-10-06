'use strict';

// B4 — o worker do disparo em massa, sobre banco real e com envio/relogio SIMULADOS.
//
// ══════════════════════════════════════════════════════════════
// NENHUMA MENSAGEM SAI DAQUI
// ══════════════════════════════════════════════════════════════
// `enviarTexto` e um duble que guarda o que sairia; `onWhatsAppLote` e um mapa em memoria; o
// relogio e `agora` injetado; `dormir` e no-op e o gap/pausa vem 0 pela campanha. O socket do
// Baileys nunca e tocado — nao ha `require` de conexao que abra nada, e os testes que precisam
// simular "socket caido" fazem isso pelo parametro.
//
// Banco de verdade (tmp) porque metade do que este worker faz e transicao de estado (terminal,
// pausa, proximo_envio_em, teto diario) — com `db` mockado, um UPDATE errado passaria.

const os = require('node:os');
const path = require('node:path');

process.env.DATABASE_PATH = path.join(
  os.tmpdir(),
  `vm-test-massa-outbox-${process.pid}-${Date.now()}.db`,
);
process.env.INTERVIEW_MOCK = 'true';
process.env.SESSION_SECRET = 'segredo-de-teste';
process.env.OPTOUT_TOKEN_SECRET = 'segredo-hmac-de-teste';
process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert/strict');

const db = require('../src/db');
const { migrar } = require('../src/db/migrate');
const worker = require('../src/whatsapp/massaOutbox');
const cadencia = require('../src/lib/cadenciaMassaWa');
const { VARIACOES_SEED } = require('../src/lib/variacoesMassaWa');

migrar();

const LINK_MEET = 'https://meet.google.com/abc-defg-hij';

// Quinta-feira, 01/10/2026, 10:00 em Brasilia — dentro da janela (9h–18h, seg–sab).
const AGORA = new Date(Date.UTC(2026, 9, 1, 13, 0));
// A reuniao e no mesmo dia, as 19:30 (futura em relacao a AGORA).
const DATA_REUNIAO = '2026-10-01';
const HORA_REUNIAO = '19:30';

let seq = 0;

function criarVaga(campos = {}) {
  seq += 1;
  return db.criarVaga({
    slug: `vaga-massa-outbox-${seq}`,
    titulo: 'Closer de Vendas',
    perfil: 'CLOSER',
    empresa: 'Acme Ltda',
    link_meet: LINK_MEET,
    entrevista_grupo_1_data: DATA_REUNIAO,
    entrevista_grupo_1_hora: HORA_REUNIAO,
    ...campos,
  });
}

// Cadencia "de teste": gap e pausa ZERO (nada de esperar), lote fixo.
function criarCampanha({ jobId = null, lote = 5, teto = 30, extra = {} } = {}) {
  seq += 1;
  const id = db.criarCampanhaMassaWa({
    nome: `Campanha ${seq}`,
    jobId,
    cadencia: {
      loteMin: lote,
      loteMax: lote,
      gapMinS: 0,
      gapMaxS: 0,
      pausaLoteMinS: 0,
      pausaLoteMaxS: 0,
      tetoDiario: teto,
      ...extra,
    },
  });
  db.salvarVariacoesMassaWa(id, VARIACOES_SEED);
  db.definirStatusCampanhaMassaWa(id, 'ativa');
  return id;
}

let tel = 0;
function proximoTelefone() {
  tel += 1;
  return `55479995${String(80000 + tel).padStart(5, '0')}`;
}

function materializar(campanhaId, quantos, { jobId }) {
  const itens = [];
  for (let i = 0; i < quantos; i += 1) {
    const telefone = proximoTelefone();
    itens.push({
      telefone,
      telefoneCanonico: `5547${telefone.slice(-8)}`,
      nome: `Pessoa ${i + 1}`,
      applicationId: null,
      jobId,
    });
  }
  db.materializarCampanhaMassaWa(campanhaId, itens);
  return itens;
}

function envioDuble(comportamento) {
  const chamadas = [];
  return {
    chamadas,
    fn: async (telefone, texto, opcoes) => {
      chamadas.push({ telefone, texto, opcoes });
      if (typeof comportamento === 'function') return comportamento(chamadas.length, telefone);
      return undefined;
    },
  };
}

async function semLogs(fn) {
  const { log, warn, error } = console;
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

// Roda um ciclo com tudo simulado. `mock: false` para exercitar o caminho de envio real (com o
// duble), que e onde vivem o disjuntor e a checagem de existencia.
function rodar(extra = {}) {
  return semLogs(() =>
    worker.processarCicloMassaWa({
      db,
      agora: AGORA,
      mock: false,
      baileysLigado: true,
      socketConectado: true,
      dormir: async () => {},
      aleatorio: () => 0,
      espacamentoGlobalMs: 0,
      onWhatsAppLote: async (telefones) => new Map(telefones.map((t) => [t, true])),
      ...extra,
    }),
  );
}

const porStatus = (id) => Object.fromEntries(db.resumoCampanhaMassaWa(id).map((l) => [l.status, l.n]));
const campanhaDe = (id) => db.obterCampanhaMassaWa(id);

function ligar() {
  db.definirConfigBool(worker.CHAVE_ATIVO, true);
}

function limpar() {
  const conn = db.getDb();
  conn.exec('DELETE FROM campanhas_massa_wa_envios');
  conn.exec('DELETE FROM campanhas_massa_wa_variacoes');
  conn.exec('DELETE FROM campanhas_massa_wa');
  conn.exec('DELETE FROM whatsapp_sequencia_envios');
  conn.exec('DELETE FROM applications');
  conn.exec('DELETE FROM whatsapp_optout');
  conn.exec('DELETE FROM whatsapp_opt_out');
  conn.exec('DELETE FROM jobs');
  ligar();
}

// ══════════════════ KILL-SWITCHES ══════════════════

test('kill-switch de banco DESLIGADO: nada sai, e o default e desligado', async () => {
  limpar();
  db.definirConfigBool(worker.CHAVE_ATIVO, false);
  const jobId = criarVaga();
  const id = criarCampanha({ jobId });
  materializar(id, 3, { jobId });

  const envio = envioDuble();
  const r = await rodar({ enviarTexto: envio.fn });

  assert.equal(r.desativado, true);
  assert.equal(envio.chamadas.length, 0);
  assert.deepEqual(porStatus(id), { pendente: 3 });
});

test('WHATSAPP_BAILEYS_ATIVO desligado tambem barra o ciclo', async () => {
  limpar();
  const jobId = criarVaga();
  const id = criarCampanha({ jobId });
  materializar(id, 3, { jobId });

  const envio = envioDuble();
  const r = await rodar({ enviarTexto: envio.fn, baileysLigado: false });

  assert.equal(r.desativado, true);
  assert.equal(envio.chamadas.length, 0);
});

test('socket desconectado: nao abre a fila (nao marca tentativa contra canal fechado)', async () => {
  limpar();
  const jobId = criarVaga();
  const id = criarCampanha({ jobId });
  materializar(id, 3, { jobId });

  const envio = envioDuble();
  const r = await rodar({ enviarTexto: envio.fn, socketConectado: false });

  assert.equal(r.desativado, true);
  assert.equal(envio.chamadas.length, 0);
  assert.deepEqual(porStatus(id), { pendente: 3 });
});

test('MOCK: marca como enviado sem tocar o socket', async () => {
  limpar();
  const jobId = criarVaga();
  const id = criarCampanha({ jobId });
  materializar(id, 3, { jobId });

  const envio = envioDuble();
  const r = await rodar({ enviarTexto: envio.fn, mock: true, socketConectado: false });

  assert.equal(envio.chamadas.length, 0, 'em mock nada e enviado de verdade');
  assert.equal(r.enviados, 3);
  assert.deepEqual(porStatus(id), { enviado: 3 });
});

// ══════════════════ LOG DO CICLO DESATIVADO ══════════════════
//
// O tick e de 1 minuto: uma linha por passada seriam ~1.440 por dia de uma informacao que nao mudou,
// afogando no stdout justamente a linha que importa num incidente.

// Captura as linhas de console.log de um bloco.
async function capturandoLog(fn) {
  const linhas = [];
  const { log, warn, error } = console;
  console.log = (...a) => linhas.push(a.join(' '));
  console.warn = (...a) => linhas.push(a.join(' '));
  console.error = (...a) => linhas.push(a.join(' '));
  try {
    await fn();
  } finally {
    console.log = log;
    console.warn = warn;
    console.error = error;
  }
  return linhas;
}

const linhasDeDesativado = (linhas) => linhas.filter((l) => /\[massa-wa\] (desativado|segue desativado)/.test(l));

test('desativado loga UMA vez, e nao a cada tick', async () => {
  limpar();
  db.definirConfigBool(worker.CHAVE_ATIVO, false);
  const jobId = criarVaga();
  const id = criarCampanha({ jobId });
  materializar(id, 3, { jobId });

  const deps = { db, agora: AGORA, mock: true, baileysLigado: true, socketConectado: true, aleatorio: () => 0, espacamentoGlobalMs: 0, dormir: async () => {} };
  const linhas = await capturandoLog(async () => {
    for (let k = 0; k < 10; k += 1) {
      // eslint-disable-next-line no-await-in-loop
      await worker.processarCicloMassaWa(deps);
    }
  });

  assert.equal(linhasDeDesativado(linhas).length, 1, `logou ${linhasDeDesativado(linhas).length} vezes em 10 ticks`);
  assert.match(linhasDeDesativado(linhas)[0], /ciclos serao pulados em silencio/);
});

test('mudanca de MOTIVO loga de novo (ligaram um switch e nao o outro)', async () => {
  limpar();
  db.definirConfigBool(worker.CHAVE_ATIVO, false);
  const base = { db, agora: AGORA, mock: true, socketConectado: true, aleatorio: () => 0, espacamentoGlobalMs: 0, dormir: async () => {} };

  const linhas = await capturandoLog(async () => {
    // Motivo 1: os dois desligados.
    await worker.processarCicloMassaWa({ ...base, baileysLigado: false });
    await worker.processarCicloMassaWa({ ...base, baileysLigado: false });
    // Motivo 2: o env ligou, a config nao.
    await worker.processarCicloMassaWa({ ...base, baileysLigado: true });
    await worker.processarCicloMassaWa({ ...base, baileysLigado: true });
  });

  assert.equal(linhasDeDesativado(linhas).length, 2, 'uma linha por motivo, nao por tick');
});

test('quando o ciclo VOLTA a rodar, o log diz que reativou', async () => {
  limpar();
  db.definirConfigBool(worker.CHAVE_ATIVO, false);
  const jobId = criarVaga();
  const id = criarCampanha({ jobId });
  materializar(id, 2, { jobId });
  const deps = { db, agora: AGORA, mock: true, baileysLigado: true, socketConectado: true, aleatorio: () => 0, espacamentoGlobalMs: 0, dormir: async () => {} };

  const linhas = await capturandoLog(async () => {
    await worker.processarCicloMassaWa(deps);
    db.definirConfigBool(worker.CHAVE_ATIVO, true);
    await worker.processarCicloMassaWa(deps);
  });

  assert.ok(linhas.some((l) => /reativado/.test(l)), 'a volta ao normal precisa aparecer no log');
});

test('socket caido tambem nao loga por tick, e nao alterna com "reativado"', async () => {
  // Se o estado fosse limpo logo depois do kill-switch, um socket caido com o interruptor ligado
  // alternaria "reativado" e "desativado" a cada minuto — o DOBRO do ruido que o ajuste remove.
  limpar();
  const jobId = criarVaga();
  const id = criarCampanha({ jobId });
  materializar(id, 2, { jobId });
  const deps = { db, agora: AGORA, mock: false, baileysLigado: true, socketConectado: false, aleatorio: () => 0, espacamentoGlobalMs: 0, dormir: async () => {}, enviarTexto: async () => {} };

  const linhas = await capturandoLog(async () => {
    for (let k = 0; k < 5; k += 1) {
      // eslint-disable-next-line no-await-in-loop
      await worker.processarCicloMassaWa(deps);
    }
  });

  assert.equal(linhasDeDesativado(linhas).length, 1);
  assert.equal(linhas.filter((l) => /reativado/.test(l)).length, 0, 'nao pode alternar reativado/desativado');
});

// ══════════════════ CADENCIA ══════════════════

test('envia o LOTE sorteado, e o resto continua pendente', async () => {
  limpar();
  const jobId = criarVaga();
  const id = criarCampanha({ jobId, lote: 5 });
  materializar(id, 12, { jobId });

  const envio = envioDuble();
  const r = await rodar({ enviarTexto: envio.fn });

  assert.equal(envio.chamadas.length, 5);
  assert.equal(r.enviados, 5);
  assert.deepEqual(porStatus(id), { enviado: 5, pendente: 7 });
});

test('grava proximo_envio_em no BANCO (a cadencia sobrevive a um restart)', async () => {
  limpar();
  const jobId = criarVaga();
  // pausa de 300 s para o campo nao ficar igual a `agora`.
  const id = criarCampanha({ jobId, lote: 2, extra: { pausaLoteMinS: 300, pausaLoteMaxS: 300 } });
  materializar(id, 5, { jobId });

  await rodar({ enviarTexto: envioDuble().fn });

  const c = campanhaDe(id);
  assert.ok(c.proximo_envio_em, 'sem isso, um restart voltaria disparando um lote inteiro');
  assert.equal(c.proximo_envio_em, '2026-10-01 13:05:00');
});

test('a pausa entre lotes e respeitada: o ciclo seguinte nao envia nada', async () => {
  limpar();
  const jobId = criarVaga();
  const id = criarCampanha({ jobId, lote: 2, extra: { pausaLoteMinS: 300, pausaLoteMaxS: 300 } });
  materializar(id, 6, { jobId });

  const envio = envioDuble();
  await rodar({ enviarTexto: envio.fn });
  assert.equal(envio.chamadas.length, 2);

  // Mesmo instante: a pausa ainda corre.
  await rodar({ enviarTexto: envio.fn });
  assert.equal(envio.chamadas.length, 2, 'nao pode ter enviado mais nada');

  // 6 minutos depois: pode.
  await rodar({ enviarTexto: envio.fn, agora: new Date(AGORA.getTime() + 6 * 60 * 1000) });
  assert.equal(envio.chamadas.length, 4);
});

test('gap entre mensagens e pedido a `dormir` (e nao ignorado)', async () => {
  limpar();
  const jobId = criarVaga();
  const id = criarCampanha({ jobId, lote: 3, extra: { gapMinS: 20, gapMaxS: 60 } });
  materializar(id, 3, { jobId });

  const dormidas = [];
  await rodar({ enviarTexto: envioDuble().fn, dormir: async (ms) => { dormidas.push(ms); } });

  // 3 mensagens = 2 gaps (nao dorme depois da ultima). aleatorio=0 -> 20 s.
  assert.deepEqual(dormidas, [20000, 20000]);
});

test('fora da JANELA nao envia nada', async () => {
  limpar();
  const jobId = criarVaga();
  const id = criarCampanha({ jobId });
  materializar(id, 3, { jobId });

  const envio = envioDuble();
  // Domingo, 04/10/2026, 12:00 Brasilia.
  await rodar({ enviarTexto: envio.fn, agora: new Date(Date.UTC(2026, 9, 4, 15, 0)) });
  assert.equal(envio.chamadas.length, 0);

  // Quinta, 20:00 Brasilia (depois das 18h).
  await rodar({ enviarTexto: envio.fn, agora: new Date(Date.UTC(2026, 9, 1, 23, 0)) });
  assert.equal(envio.chamadas.length, 0);
  assert.deepEqual(porStatus(id), { pendente: 3 });
});

test('TETO DIARIO limita o lote e depois para o dia', async () => {
  limpar();
  const jobId = criarVaga();
  const id = criarCampanha({ jobId, lote: 5, teto: 7 });
  materializar(id, 20, { jobId });

  const envio = envioDuble();
  await rodar({ enviarTexto: envio.fn });
  assert.equal(envio.chamadas.length, 5);

  // Segundo lote do mesmo dia: o teto deixa passar so 2.
  await rodar({ enviarTexto: envio.fn, agora: new Date(AGORA.getTime() + 60 * 60 * 1000) });
  assert.equal(envio.chamadas.length, 7);

  // Terceiro: teto estourado, nada sai.
  await rodar({ enviarTexto: envio.fn, agora: new Date(AGORA.getTime() + 2 * 60 * 60 * 1000) });
  assert.equal(envio.chamadas.length, 7);
  assert.deepEqual(porStatus(id), { enviado: 7, pendente: 13 });
});

test('o teto diario vira no dia civil de BRASILIA, nao em UTC', async () => {
  // As 22h de Brasilia (01:00 UTC do dia seguinte) ainda e o MESMO dia para o teto. Se a virada
  // fosse em UTC, o teto zeraria as 21h e a campanha dobraria a vazao naquela noite.
  limpar();
  const jobId = criarVaga({ entrevista_grupo_1_data: '2026-10-10', entrevista_grupo_1_hora: '19:30' });
  const id = criarCampanha({ jobId, lote: 2, teto: 2, extra: { horaInicio: '00:00', horaFim: '23:59' } });
  materializar(id, 6, { jobId });

  const envio = envioDuble();
  // 20:00 de Brasilia (23:00 UTC).
  await rodar({ enviarTexto: envio.fn, agora: new Date(Date.UTC(2026, 9, 1, 23, 0)) });
  assert.equal(envio.chamadas.length, 2);

  // 22:00 de Brasilia = 02/10 01:00 UTC. Mesmo dia civil em Brasilia -> teto ja estourado.
  await rodar({ enviarTexto: envio.fn, agora: new Date(Date.UTC(2026, 9, 2, 1, 0)) });
  assert.equal(envio.chamadas.length, 2, 'o teto nao pode ter zerado com a virada de UTC');
});

test('fila vazia CONCLUI a campanha', async () => {
  limpar();
  const jobId = criarVaga();
  const id = criarCampanha({ jobId, lote: 5 });
  materializar(id, 2, { jobId });

  await rodar({ enviarTexto: envioDuble().fn });
  assert.equal(campanhaDe(id).status, 'ativa', 'ainda ha o que conferir no proximo ciclo');

  await rodar({ enviarTexto: envioDuble().fn, agora: new Date(AGORA.getTime() + 60 * 60 * 1000) });
  const c = campanhaDe(id);
  assert.equal(c.status, 'concluida');
  assert.ok(c.concluida_em);
});

// ══════════════════ PRIORIDADE DO TRANSACIONAL ══════════════════

test('havendo WA1/WA2 pendente VENCIDO, a massa cede a vez', async () => {
  limpar();
  const jobId = criarVaga();
  const id = criarCampanha({ jobId });
  materializar(id, 3, { jobId });

  const appId = Number(
    db.getDb().prepare("INSERT INTO applications (job_id, nome, telefone) VALUES (?, 'Maria', '5547999582500')").run(jobId).lastInsertRowid,
  );
  db.agendarEnvioWhatsapp({
    applicationId: appId,
    etapa: 'wa1',
    telefone: '5547999582500',
    agendadoPara: '2020-01-01 00:00:00',
    templateNome: 'wa1',
  });

  const envio = envioDuble();
  const r = await rodar({ enviarTexto: envio.fn });

  assert.equal(envio.chamadas.length, 0, 'WA1 e a primeira mensagem do candidato: ela vem antes');
  assert.equal(r.enviados, 0);
  assert.deepEqual(porStatus(id), { pendente: 3 });
});

test('agendamento FUTURO do transacional nao segura a massa', async () => {
  limpar();
  const jobId = criarVaga();
  const id = criarCampanha({ jobId, lote: 2 });
  materializar(id, 3, { jobId });

  const appId = Number(
    db.getDb().prepare("INSERT INTO applications (job_id, nome, telefone) VALUES (?, 'Joao', '5547999582501')").run(jobId).lastInsertRowid,
  );
  db.agendarEnvioWhatsapp({
    applicationId: appId,
    etapa: 'wa2',
    telefone: '5547999582501',
    agendadoPara: '2099-01-01 00:00:00',
    templateNome: 'wa2',
  });

  const envio = envioDuble();
  await rodar({ enviarTexto: envio.fn });
  assert.equal(envio.chamadas.length, 2, 'pendencia que ainda nao venceu nao e pendencia');
});

test('espacamento global: espera o que falta desde o ultimo envio do transacional', async () => {
  limpar();
  const jobId = criarVaga();
  const id = criarCampanha({ jobId, lote: 1 });
  materializar(id, 1, { jobId });

  // O transacional enviou 5 s antes de `agora`.
  const appId = Number(
    db.getDb().prepare("INSERT INTO applications (job_id, nome, telefone) VALUES (?, 'Ana', '5547999582502')").run(jobId).lastInsertRowid,
  );
  db.agendarEnvioWhatsapp({
    applicationId: appId,
    etapa: 'wa1',
    telefone: '5547999582502',
    agendadoPara: '2020-01-01 00:00:00',
    templateNome: 'wa1',
  });
  const fila = db.listarPendentesSequenciaWhatsapp({ limite: 10 })[0];
  db.marcarSequenciaWhatsappEnviada(fila.id, '2026-10-01 12:59:55');

  const dormidas = [];
  await rodar({
    enviarTexto: envioDuble().fn,
    espacamentoGlobalMs: cadencia.ESPACAMENTO_GLOBAL_MS,
    dormir: async (ms) => { dormidas.push(ms); },
  });

  assert.equal(dormidas[0], 10000, 'faltavam 10 s dos 15 s de espacamento');
});

// ══════════════════ ESTADOS TERMINAIS ══════════════════

test('opt-out no momento do envio: terminal, e nao sai mensagem', async () => {
  limpar();
  const jobId = criarVaga();
  const id = criarCampanha({ jobId, lote: 5 });
  const itens = materializar(id, 3, { jobId });
  // A pessoa pediu para sair DEPOIS da materializacao.
  db.registrarWhatsappOptout({ telefone: itens[1].telefone, escopo: 'campanha', origem: 'resposta' });

  const envio = envioDuble();
  const r = await rodar({ enviarTexto: envio.fn });

  assert.equal(envio.chamadas.length, 2);
  assert.equal(r.pulados, 1);
  assert.deepEqual(porStatus(id), { enviado: 2, opt_out: 1 });
});

test('opt-out na tabela ANTIGA tambem suprime no envio', async () => {
  limpar();
  const jobId = criarVaga();
  const id = criarCampanha({ jobId, lote: 5 });
  const itens = materializar(id, 2, { jobId });
  db.registrarOptOutWhatsapp(itens[0].telefone, 'manual');

  const envio = envioDuble();
  await rodar({ enviarTexto: envio.fn });

  assert.equal(envio.chamadas.length, 1);
  assert.deepEqual(porStatus(id), { enviado: 1, opt_out: 1 });
});

// ── NONO DIGITO E CONFIRMACAO (primeira campanha real, 2026-09-29: 50 "enviados", 4 entregues) ──

const semNove = (t) => t.replace(/^55(\d{2})9(\d{8})$/, '55$1$2');

test('DDD com WhatsApp registrado SEM o 9: envia para a variante sem o 9', async () => {
  limpar();
  const jobId = criarVaga();
  const id = criarCampanha({ jobId, lote: 5 });
  const itens = materializar(id, 1, { jobId });
  const tel = itens[0].telefone;
  assert.notEqual(semNove(tel), tel, 'o telefone do teste precisa ser celular com 9');

  const envio = envioDuble();
  await rodar({
    enviarTexto: envio.fn,
    // O WhatsApp so conhece a conta sem o 9 — o caso do DDD 47.
    onWhatsAppLote: async (telefones) => new Map(telefones.map((t) => [t, t === semNove(tel) ? true : null])),
  });

  assert.equal(envio.chamadas.length, 1);
  assert.equal(envio.chamadas[0].telefone, semNove(tel), 'mandar para o numero com 9 e mandar para o vazio');
  assert.deepEqual(porStatus(id), { enviado: 1 });
});

test('a consulta leva as DUAS variantes numa chamada so', async () => {
  limpar();
  const jobId = criarVaga();
  const id = criarCampanha({ jobId, lote: 5 });
  const itens = materializar(id, 2, { jobId });

  const consultas = [];
  await rodar({
    enviarTexto: envioDuble().fn,
    onWhatsAppLote: async (telefones) => {
      consultas.push(telefones);
      return new Map(telefones.map((t) => [t, true]));
    },
  });

  assert.equal(consultas.length, 1);
  for (const it of itens) {
    assert.ok(consultas[0].includes(it.telefone));
    assert.ok(consultas[0].includes(semNove(it.telefone)));
  }
});

test('confirmado com o 9: usa o numero como esta, mesmo que a variante sem 9 tambem exista', async () => {
  limpar();
  const jobId = criarVaga();
  const id = criarCampanha({ jobId, lote: 5 });
  const itens = materializar(id, 1, { jobId });

  const envio = envioDuble();
  await rodar({ enviarTexto: envio.fn });

  assert.equal(envio.chamadas[0].telefone, itens[0].telefone);
});

test('numero NAO confirmado (nem com nem sem o 9) vira sem_whatsapp e NUNCA enviado', async () => {
  limpar();
  const jobId = criarVaga();
  const id = criarCampanha({ jobId, lote: 5 });
  const itens = materializar(id, 3, { jobId });
  const naoConfirmado = itens[0].telefone;

  const envio = envioDuble();
  await rodar({
    enviarTexto: envio.fn,
    onWhatsAppLote: async (telefones) =>
      new Map(telefones.map((t) => [t, t === naoConfirmado || t === semNove(naoConfirmado) ? null : true])),
  });

  assert.equal(envio.chamadas.length, 2);
  assert.ok(!envio.chamadas.some((c) => c.telefone === naoConfirmado || c.telefone === semNove(naoConfirmado)));
  assert.deepEqual(porStatus(id), { enviado: 2, sem_whatsapp: 1 });
});

test('consulta que nao confirma NINGUEM (ou falha): nada sai, ninguem e queimado, lote volta depois', async () => {
  for (const onWhatsAppLote of [
    async () => { throw new Error('socket instavel'); },
    async (telefones) => new Map(telefones.map((t) => [t, null])),
  ]) {
    limpar();
    const jobId = criarVaga();
    const id = criarCampanha({ jobId, lote: 5 });
    materializar(id, 3, { jobId });

    const envio = envioDuble();
    await rodar({ enviarTexto: envio.fn, onWhatsAppLote });

    assert.equal(envio.chamadas.length, 0);
    assert.deepEqual(porStatus(id), { pendente: 3 }, 'ninguem vira sem_whatsapp por falha da consulta');
    assert.ok(campanhaDe(id).proximo_envio_em, 'a pausa entre lotes vale tambem aqui');
  }
});

test('vaga SEM reuniao futura: sem_reuniao, e nenhuma mensagem sai', async () => {
  limpar();
  const jobId = criarVaga({ entrevista_grupo_1_data: null, entrevista_grupo_1_hora: null });
  const id = criarCampanha({ jobId, lote: 5 });
  materializar(id, 2, { jobId });

  const envio = envioDuble();
  const r = await rodar({ enviarTexto: envio.fn });

  assert.equal(envio.chamadas.length, 0, 'nunca sai convite sem data');
  assert.equal(r.pulados, 2);
  assert.deepEqual(porStatus(id), { sem_reuniao: 2 });
});

test('reuniao VENCIDA conta como sem reuniao futura (nenhum link vencido sai)', async () => {
  limpar();
  const jobId = criarVaga({ entrevista_grupo_1_data: '2026-09-01', entrevista_grupo_1_hora: '19:30' });
  const id = criarCampanha({ jobId, lote: 5 });
  materializar(id, 1, { jobId });

  const envio = envioDuble();
  await rodar({ enviarTexto: envio.fn });
  assert.equal(envio.chamadas.length, 0);
  assert.deepEqual(porStatus(id), { sem_reuniao: 1 });
});

test('vaga sem link do Meet: sem_reuniao mesmo com data futura', async () => {
  limpar();
  const jobId = criarVaga({ link_meet: null });
  const id = criarCampanha({ jobId, lote: 5 });
  materializar(id, 1, { jobId });

  await rodar({ enviarTexto: envioDuble().fn });
  assert.deepEqual(porStatus(id), { sem_reuniao: 1 });
  // O motivo aparece no painel: o link da vaga e o de confirmacao (Calendly), nao a sala do Meet.
  const [linha] = db.listarEnviosCampanhaMassaWa(id);
  assert.match(linha.erro, /ou nao tem link de confirmacao\)/);
  assert.doesNotMatch(linha.erro, /Meet/);
});

test('vaga sem EMPRESA: falha com o motivo escrito (token obrigatorio sem valor)', async () => {
  // Caso real da base. Resolver {empresa} para '' mandaria "na ." para a pessoa.
  limpar();
  const jobId = criarVaga({ empresa: null });
  const id = criarCampanha({ jobId, lote: 5 });
  materializar(id, 1, { jobId });

  const envio = envioDuble();
  const r = await rodar({ enviarTexto: envio.fn });

  assert.equal(envio.chamadas.length, 0);
  assert.equal(r.falhas, 1);
  assert.deepEqual(porStatus(id), { falha: 1 });
  const linha = db.getDb().prepare('SELECT erro FROM campanhas_massa_wa_envios WHERE campanha_id = ?').get(id);
  assert.match(linha.erro, /empresa/);
});

// ══════════════════ O TEXTO QUE SAI ══════════════════

test('o texto sai com a vaga, a empresa, a data, o horario, o link e o link de descadastro', async () => {
  limpar();
  const jobId = criarVaga();
  const id = criarCampanha({ jobId, lote: 1 });
  materializar(id, 1, { jobId });

  const envio = envioDuble();
  await rodar({ enviarTexto: envio.fn });

  const { texto } = envio.chamadas[0];
  assert.match(texto, /Closer de Vendas/);
  assert.match(texto, /Acme Ltda/);
  assert.match(texto, /01\/10\/2026/);
  assert.match(texto, /19:30/);
  assert.ok(texto.includes(LINK_MEET));
  // Quem escreve: primeiro nome do recrutador (padrao 'Jean Dentz' sem config) e a Vendedor Mestre.
  assert.match(texto, /Jean/);
  assert.match(texto, /Vendedor Mestre/);
  assert.match(texto, /\/descadastro-whatsapp\/[A-Za-z0-9_-]+\.[0-9a-f]{32}/);
  assert.doesNotMatch(texto, /\bSAIR\b/);
  // Nenhum token sem resolver, e nenhum valor vazado.
  assert.doesNotMatch(texto, /[{}]/);
  assert.doesNotMatch(texto, /undefined|null|NaN/);
});

test('a saudacao usa o primeiro nome do destinatario', async () => {
  limpar();
  const jobId = criarVaga();
  const id = criarCampanha({ jobId, lote: 1 });
  db.materializarCampanhaMassaWa(id, [
    { telefone: '5547999580001', telefoneCanonico: '554799580001', nome: 'Maria Souza', jobId },
  ]);

  const envio = envioDuble();
  await rodar({ enviarTexto: envio.fn });
  assert.match(envio.chamadas[0].texto, /^Olá, Maria!/);
});

test('a variacao usada fica gravada, e a proxima nao repete', async () => {
  limpar();
  const jobId = criarVaga();
  const id = criarCampanha({ jobId, lote: 1 });
  materializar(id, 2, { jobId });

  await rodar({ enviarTexto: envioDuble().fn });
  const primeira = campanhaDe(id).ultima_variacao;
  assert.ok(primeira >= 1 && primeira <= 7);

  await rodar({ enviarTexto: envioDuble().fn, agora: new Date(AGORA.getTime() + 60 * 60 * 1000) });
  const segunda = campanhaDe(id).ultima_variacao;
  assert.notEqual(segunda, primeira, 'duas mensagens seguidas nao podem usar o mesmo texto');

  const dist = db.distribuicaoVariacoesMassaWa(id);
  assert.equal(dist.length, 2, 'as duas variacoes usadas ficam registradas');
});

test('a instancia do socket viaja por parametro (B0 fica barato)', async () => {
  limpar();
  const jobId = criarVaga();
  const id = criarCampanha({ jobId, lote: 1 });
  materializar(id, 1, { jobId });

  const envio = envioDuble();
  await rodar({ enviarTexto: envio.fn, instancia: 'massa' });

  assert.deepEqual(envio.chamadas[0].opcoes, { instancia: 'massa' });
});

test('nenhum lugar do worker crava a instancia "jean"', () => {
  // Trava arquitetural do B0 adiado: tudo o que fala com o socket entra por deps.
  const fonte = require('node:fs').readFileSync(require.resolve('../src/whatsapp/massaOutbox'), 'utf8');
  assert.doesNotMatch(fonte, /'jean'|"jean"/);
  assert.doesNotMatch(fonte, /INSTANCIA_PADRAO/);
});

// ══════════════════ DISJUNTOR ══════════════════

test('3 erros consecutivos PAUSAM a campanha, com motivo', async () => {
  limpar();
  const jobId = criarVaga();
  const id = criarCampanha({ jobId, lote: 5 });
  materializar(id, 5, { jobId });

  const envio = envioDuble(() => { throw new Error('timeout de rede'); });
  const r = await rodar({ enviarTexto: envio.fn });

  const c = campanhaDe(id);
  assert.equal(c.status, 'pausada');
  assert.match(c.pausada_motivo, /erros consecutivos/);
  assert.equal(envio.chamadas.length, 3, 'para na terceira, nao tenta o lote inteiro');
  assert.equal(r.falhas, 3);
});

test('sinal de limitacao do WhatsApp pausa NA HORA, sem esperar o terceiro erro', async () => {
  limpar();
  const jobId = criarVaga();
  const id = criarCampanha({ jobId, lote: 5 });
  materializar(id, 5, { jobId });

  const envio = envioDuble(() => { throw new Error('rate-overlimit: slow down'); });
  await rodar({ enviarTexto: envio.fn });

  const c = campanhaDe(id);
  assert.equal(c.status, 'pausada');
  assert.match(c.pausada_motivo, /limitacao/);
  assert.equal(envio.chamadas.length, 1);
});

test('sessao caida (401/logout) pausa na hora', async () => {
  limpar();
  const jobId = criarVaga();
  const id = criarCampanha({ jobId, lote: 5 });
  materializar(id, 5, { jobId });

  const envio = envioDuble(() => { throw new Error('WhatsApp sem socket ativo: mensagem nao enviada.'); });
  await rodar({ enviarTexto: envio.fn });

  assert.match(campanhaDe(id).pausada_motivo, /sessao/);
  assert.equal(envio.chamadas.length, 1);
});

test('ehSinalDeLimitacao reconhece os sinais e ignora erro comum', () => {
  for (const m of ['rate-overlimit', 'Rate Limit exceeded', 'too many requests', 'forbidden', 'not-authorized', 'blocked']) {
    assert.equal(worker.ehSinalDeLimitacao(m), true, m);
  }
  for (const m of ['timeout', 'ECONNRESET', 'socket hang up', '']) {
    assert.equal(worker.ehSinalDeLimitacao(m), false, m);
  }
});

test('taxa de falha do lote acima de 40% pausa a campanha', async () => {
  limpar();
  const jobId = criarVaga();
  const id = criarCampanha({ jobId, lote: 5 });
  materializar(id, 5, { jobId });

  // Falha a 1a e a 3a, acerta as outras: 2 falhas em 5 tentativas = 40% (nao estoura)...
  let n = 0;
  const envioNaoEstoura = envioDuble(() => {
    n += 1;
    if (n === 1 || n === 3) throw new Error('timeout');
    return undefined;
  });
  await rodar({ enviarTexto: envioNaoEstoura.fn });
  assert.equal(campanhaDe(id).status, 'ativa', '40% exato nao estoura');

  // ... agora 3 de 5 = 60%, mas alternando para nao bater 3 consecutivos.
  limpar();
  const jobId2 = criarVaga();
  const id2 = criarCampanha({ jobId: jobId2, lote: 5 });
  materializar(id2, 5, { jobId: jobId2 });
  let k = 0;
  const envioEstoura = envioDuble(() => {
    k += 1;
    if (k % 2 === 1) throw new Error('timeout');
    return undefined;
  });
  await rodar({ enviarTexto: envioEstoura.fn });

  const c2 = campanhaDe(id2);
  assert.equal(c2.status, 'pausada');
  assert.match(c2.pausada_motivo, /40%/);
});

test('um acerto ZERA o contador de erros consecutivos', async () => {
  limpar();
  const jobId = criarVaga();
  const id = criarCampanha({ jobId, lote: 5 });
  materializar(id, 5, { jobId });

  // Falha, falha, acerta, falha, falha -> nunca chega a 3 consecutivos.
  let n = 0;
  const envio = envioDuble(() => {
    n += 1;
    if (n === 3) return undefined;
    throw new Error('timeout');
  });
  await rodar({ enviarTexto: envio.fn });

  // 4 falhas em 5 -> o disjuntor de TAXA e que pausa (nao o de consecutivos).
  const c = campanhaDe(id);
  assert.equal(c.status, 'pausada');
  assert.match(c.pausada_motivo, /40%/, 'o motivo tem que ser a taxa, nao os consecutivos');
});

test('campanha PAUSADA nao volta a enviar sozinha', async () => {
  limpar();
  const jobId = criarVaga();
  const id = criarCampanha({ jobId, lote: 5 });
  materializar(id, 5, { jobId });
  db.definirStatusCampanhaMassaWa(id, 'pausada', { motivo: 'teste' });

  const envio = envioDuble();
  await rodar({ enviarTexto: envio.fn });

  assert.equal(envio.chamadas.length, 0, 'retomar depois de um sinal de bloqueio e como se perde o numero');
  assert.equal(campanhaDe(id).status, 'pausada');
});

test('variacoes invalidas PAUSAM em vez de mandar texto com token nao resolvido', async () => {
  limpar();
  const jobId = criarVaga();
  const id = criarCampanha({ jobId, lote: 5 });
  materializar(id, 3, { jobId });
  // Alguem editou as variacoes DEPOIS de ativar e tirou os tokens obrigatorios.
  db.salvarVariacoesMassaWa(id, ['Oi, sem token nenhum. SAIR']);

  const envio = envioDuble();
  await rodar({ enviarTexto: envio.fn });

  assert.equal(envio.chamadas.length, 0);
  const c = campanhaDe(id);
  assert.equal(c.status, 'pausada');
  assert.match(c.pausada_motivo, /variacoes/);
});

// ══════════════════ IDEMPOTENCIA E TRAVA ══════════════════

test('ninguem recebe duas vezes na mesma campanha, mesmo com varios ciclos', async () => {
  limpar();
  const jobId = criarVaga();
  const id = criarCampanha({ jobId, lote: 3, teto: 100 });
  materializar(id, 6, { jobId });

  const envio = envioDuble();
  for (let k = 0; k < 5; k += 1) {
    // eslint-disable-next-line no-await-in-loop
    await rodar({ enviarTexto: envio.fn, agora: new Date(AGORA.getTime() + k * 60 * 60 * 1000) });
  }

  assert.equal(envio.chamadas.length, 6, 'seis pessoas, seis mensagens');
  assert.equal(new Set(envio.chamadas.map((c) => c.telefone)).size, 6);
  assert.deepEqual(porStatus(id), { enviado: 6 });
});

test('varrerSeOcioso ignora ciclo sobreposto', async () => {
  limpar();
  const jobId = criarVaga();
  const id = criarCampanha({ jobId, lote: 2 });
  materializar(id, 4, { jobId });

  let liberar;
  const travado = new Promise((r) => { liberar = r; });
  const deps = {
    db,
    agora: AGORA,
    mock: true,
    baileysLigado: true,
    socketConectado: true,
    aleatorio: () => 0,
    espacamentoGlobalMs: 0,
    dormir: () => travado, // segura o primeiro ciclo dentro do lote
  };

  const primeiro = semLogs(() => worker.varrerSeOcioso(deps));
  const segundo = await semLogs(() => worker.varrerSeOcioso(deps));
  assert.equal(segundo, null, 'o segundo ciclo tem que ser ignorado');

  liberar();
  await primeiro;
});

test('erro inesperado no ciclo nao derruba o processo', async () => {
  limpar();
  const dbQuebrado = Object.create(db);
  dbQuebrado.listarCampanhasMassaWaAtivas = () => { throw new Error('banco fora'); };

  const r = await semLogs(() =>
    worker.processarCicloMassaWa({ db: dbQuebrado, agora: AGORA, mock: true, baileysLigado: true }),
  );
  assert.deepEqual(r, { enviados: 0, falhas: 0, pulados: 0, campanhas: 0 });
});

// ══════════════════ jobDaLinha (o defeito silencioso) ══════════════════

test('jobDaLinha leva TODOS os campos da entrevista em grupo', () => {
  // Campo esquecido aqui nao da erro: chega undefined, proximaEntrevistaGrupo devolve null e TODO
  // destinatario vira 'sem_reuniao' — sem uma linha de log.
  const linha = {
    job_titulo: 'Closer', job_empresa: 'Acme', job_slug: 'closer', job_link_meet: LINK_MEET,
    job_entrevista_grupo_1_data: '2026-10-01', job_entrevista_grupo_1_hora: '19:30',
    job_entrevista_grupo_2_data: '2026-10-08', job_entrevista_grupo_2_hora: '20:00',
    job_entrevista_grupo_3_data: '2026-10-15', job_entrevista_grupo_3_hora: '09:15',
  };
  const job = worker.jobDaLinha(linha);

  assert.equal(job.link_meet, LINK_MEET);
  for (const i of [1, 2, 3]) {
    assert.ok(job[`entrevista_grupo_${i}_data`], `faltou a data ${i}`);
    assert.ok(job[`entrevista_grupo_${i}_hora`], `faltou a hora ${i}`);
  }
  assert.equal(job.empresa, 'Acme');
});
