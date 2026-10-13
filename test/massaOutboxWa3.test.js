'use strict';

// WA3 (incremento 9) — o disparo em massa respeita os lembretes WA3.
//
//   (a) NO-OP com o WA3 desligado ou sem lembrete pendente: o mesmo ciclo da massa, com e sem dados
//       do WA3 no banco, produz EXATAMENTE o mesmo resultado (resumo, envios, esperas, status) — e,
//       desligado, a massa nem chega a ler as tabelas do WA3 (espioes nas funcoes de banco).
//   (b) PRECEDENCIA TEMPORARIA: a massa cede so quando ha lembrete vencido ou a vencer em ate 5 min;
//       lembrete gravado ou distante nao segura a campanha.
//   (c) ESPACAMENTO GLOBAL de 15 s conta o ultimo envio REAL do WA3.
//
// Envio, relogio e WhatsApp simulados, como em test/massaOutbox.test.js.

const os = require('node:os');
const path = require('node:path');

process.env.DATABASE_PATH = path.join(os.tmpdir(), `vm-test-massa-wa3-${process.pid}-${Date.now()}.db`);
process.env.INTERVIEW_MOCK = 'true';
process.env.SESSION_SECRET = 'segredo-de-teste';
process.env.OPTOUT_TOKEN_SECRET = 'segredo-hmac-de-teste';
process.env.NODE_ENV = 'test';
delete process.env.WA3_MOCK;

const test = require('node:test');
const assert = require('node:assert/strict');

const db = require('../src/db');
const { migrar } = require('../src/db/migrate');
const massa = require('../src/whatsapp/massaOutbox');
const wa3 = require('../src/whatsapp/lembreteEntrevistaOutbox');
const cadencia = require('../src/lib/cadenciaMassaWa');
const { VARIACOES_SEED } = require('../src/lib/variacoesMassaWa');

migrar();

// Quinta 01/10/2026 10:00 Brasilia (13:00Z): dentro da janela da massa e da do WA3.
const AGORA = new Date(Date.UTC(2026, 9, 1, 13, 0));
const sql = (q, ...p) => db.getDb().prepare(q).run(...p);

let seq = 0;
let tel = 0;
const proximoTelefone = () => {
  tel += 1;
  return `55479996${String(10000 + tel).padStart(5, '0')}`;
};

function limpar() {
  const c = db.getDb();
  for (const t of [
    'lembretes_entrevista_enviados', 'lembretes_entrevista_reunioes', 'campanhas_massa_wa_envios',
    'campanhas_massa_wa_variacoes', 'campanhas_massa_wa', 'whatsapp_sequencia_envios', 'applications',
    'whatsapp_optout', 'whatsapp_opt_out', 'jobs',
  ]) c.exec(`DELETE FROM ${t}`);
  db.definirConfigBool(massa.CHAVE_ATIVO, true);
  db.definirConfigBool(wa3.CHAVE_ATIVO, false);
  delete process.env.WA3_MOCK;
}

// Campanha de vagas abertas com 3 itens, cadencia de teste (gap/pausa zero).
function campanhaComItens() {
  seq += 1;
  const jobId = db.criarVaga({
    slug: `massa-wa3-${seq}`, titulo: 'Closer', perfil: 'CLOSER', empresa: 'Acme Ltda',
    link_meet: 'https://calendly.com/vm/x', entrevista_grupo_1_data: '2026-10-01', entrevista_grupo_1_hora: '19:30',
  });
  const id = db.criarCampanhaMassaWa({
    nome: `C${seq}`, jobId,
    cadencia: { loteMin: 5, loteMax: 5, gapMinS: 0, gapMaxS: 0, pausaLoteMinS: 0, pausaLoteMaxS: 0, tetoDiario: 30 },
  });
  db.salvarVariacoesMassaWa(id, VARIACOES_SEED);
  db.definirStatusCampanhaMassaWa(id, 'ativa');
  const itens = [1, 2, 3].map((i) => {
    const telefone = proximoTelefone();
    return { telefone, telefoneCanonico: `5547${telefone.slice(-8)}`, nome: `Pessoa ${i}`, applicationId: null, jobId };
  });
  db.materializarCampanhaMassaWa(id, itens);
  return id;
}

// Vaga do WA3 com 1 convidado (WA2), carencia cumprida. `horaReuniao` em Brasilia, 01/10.
// 12:00 -> wa3b devido 10:00 (= AGORA, vencido); 12:04 -> vence em 4 min; 13:00 -> vence em 1 h.
function vagaWa3(horaReuniao) {
  seq += 1;
  const jobId = db.criarVaga({
    slug: `wa3-massa-${seq}`, titulo: 'SDR', perfil: 'SDR',
    link_meet_reuniao: 'https://meet.google.com/abc-defg-hij',
    entrevista_grupo_1_data: '2026-10-01', entrevista_grupo_1_hora: horaReuniao,
  });
  const telefone = proximoTelefone();
  const app = Number(sql('INSERT INTO applications (job_id, nome, telefone) VALUES (?, ?, ?)', jobId, 'Ana', telefone.slice(2)).lastInsertRowid);
  sql(
    `INSERT INTO whatsapp_sequencia_envios (application_id, etapa, telefone_e164, status, agendado_para, enviado_em, variante)
     VALUES (?, 'wa2', ?, 'enviado', '2026-09-29 12:00:00', '2026-09-29 12:00:00', 'convite_grupo')`,
    app, telefone,
  );
  const [h, m] = horaReuniao.split(':').map(Number);
  const inicioUtc = `2026-10-01 ${String(h + 3).padStart(2, '0')}:${String(m).padStart(2, '0')}:00`;
  db.registrarReuniaoVistaLembrete(jobId, inicioUtc, '2026-09-30 00:00:00');
  return { jobId, telefone, inicioUtc };
}

function envioWa3Real(quando, { mock = false } = {}) {
  const id = db.reservarLembreteEntrevista({ jobId: db.listarVagas()[0].id, telefoneCanonico: `k${quando}${mock}`, tipo: 'wa3b', inicioUtc: '2026-10-01 15:00:00', mock });
  db.marcarLembreteEntrevistaEnviado(id, { quando });
}

async function semLogs(fn) {
  const { log, warn, error } = console;
  console.log = () => {};
  console.warn = () => {};
  console.error = () => {};
  try { return await fn(); } finally { Object.assign(console, { log, warn, error }); }
}

// Um ciclo da massa com espacamento REAL (15 s) e esperas capturadas.
async function cicloMassa(campanhaId, extra = {}) {
  const enviados = [];
  const dormidas = [];
  const resumo = await semLogs(() => massa.processarCicloMassaWa({
    db, agora: AGORA, mock: false, baileysLigado: true, socketConectado: true,
    aleatorio: () => 0, espacamentoGlobalMs: cadencia.ESPACAMENTO_GLOBAL_MS,
    dormir: async (ms) => { dormidas.push(ms); },
    onWhatsAppLote: async (l) => new Map(l.map((t) => [t, true])),
    enviarTexto: async (t) => { enviados.push(t); },
    ...extra,
  }));
  const status = Object.fromEntries(db.resumoCampanhaMassaWa(campanhaId).map((l) => [l.status, l.n]));
  return { resumo, enviados: enviados.length, dormidas, status };
}

// Espiao: conta as chamadas as funcoes de banco que so o WA3 usa.
function espiar() {
  const nomes = ['listarVagasParaLembreteEntrevista', 'ultimoEnvioLembreteEntrevista', 'listarConvitesEntrevistaGrupo'];
  const originais = Object.fromEntries(nomes.map((n) => [n, db[n]]));
  const chamadas = Object.fromEntries(nomes.map((n) => [n, 0]));
  for (const n of nomes) db[n] = (...a) => { chamadas[n] += 1; return originais[n](...a); };
  return { chamadas, restaurar: () => Object.assign(db, originais) };
}

// ══════════════════ (a) NO-OP ══════════════════

test('(a) NO-OP com WA3 DESLIGADO: mesmo resultado com e sem dados do WA3, e nenhuma leitura do WA3', async () => {
  limpar();
  const antes = await cicloMassa(campanhaComItens());

  limpar();
  const campanha = campanhaComItens();
  vagaWa3('12:00'); // lembrete vencido
  envioWa3Real('2026-10-01 12:59:55'); // envio real ha 5 s
  const espiao = espiar();
  let depois;
  try {
    depois = await cicloMassa(campanha);
  } finally {
    espiao.restaurar();
  }

  assert.deepEqual(depois, antes);
  assert.equal(antes.enviados, 3);
  assert.deepEqual(espiao.chamadas, { listarVagasParaLembreteEntrevista: 0, ultimoEnvioLembreteEntrevista: 0, listarConvitesEntrevistaGrupo: 0 });
});

test('(a) NO-OP com WA3 LIGADO mas sem lembrete pendente nem envio do WA3', async () => {
  limpar();
  const antes = await cicloMassa(campanhaComItens());

  limpar();
  const campanha = campanhaComItens();
  db.definirConfigBool(wa3.CHAVE_ATIVO, true);
  process.env.WA3_MOCK = 'false';
  vagaWa3('13:00'); // proximo lembrete daqui a 1 h
  const depois = await cicloMassa(campanha);
  assert.deepEqual(depois, antes);
});

test('(a) NO-OP com WA3 em SIMULACAO: lembrete vencido nao segura a massa (mock nao usa o socket)', async () => {
  limpar();
  const antes = await cicloMassa(campanhaComItens());
  limpar();
  const campanha = campanhaComItens();
  db.definirConfigBool(wa3.CHAVE_ATIVO, true); // WA3_MOCK ausente = simulacao
  vagaWa3('12:00');
  envioWa3Real('2026-10-01 12:59:55', { mock: true });
  assert.deepEqual(await cicloMassa(campanha), antes);
});

// ══════════════════ (b) PRECEDENCIA TEMPORARIA ══════════════════

test('(b) lembrete WA3 VENCIDO: a massa cede a vez (nada sai, itens seguem pendentes)', async () => {
  limpar();
  const campanha = campanhaComItens();
  db.definirConfigBool(wa3.CHAVE_ATIVO, true);
  process.env.WA3_MOCK = 'false';
  vagaWa3('12:00');
  const r = await cicloMassa(campanha);
  assert.equal(r.enviados, 0);
  assert.deepEqual(r.status, { pendente: 3 });
});

test('(b) lembrete a vencer em 4 min cede; a 1 h NAO cede', async () => {
  limpar();
  let campanha = campanhaComItens();
  db.definirConfigBool(wa3.CHAVE_ATIVO, true);
  process.env.WA3_MOCK = 'false';
  vagaWa3('12:04');
  assert.equal((await cicloMassa(campanha)).enviados, 0);

  limpar();
  campanha = campanhaComItens();
  db.definirConfigBool(wa3.CHAVE_ATIVO, true);
  process.env.WA3_MOCK = 'false';
  vagaWa3('13:00');
  assert.equal((await cicloMassa(campanha)).enviados, 3);
});

test('(b) NAO e permanente: gravado o lembrete, a massa volta a enviar', async () => {
  limpar();
  const campanha = campanhaComItens();
  db.definirConfigBool(wa3.CHAVE_ATIVO, true);
  process.env.WA3_MOCK = 'false';
  const { jobId, telefone, inicioUtc } = vagaWa3('12:00');
  assert.equal((await cicloMassa(campanha)).enviados, 0);
  // O worker do WA3 roda e grava o lembrete (aqui: enviado).
  const { chaveCanonicaTelefone } = require('../src/lib/chaveTelefone');
  const id = db.reservarLembreteEntrevista({ jobId, telefoneCanonico: chaveCanonicaTelefone(telefone), tipo: 'wa3b', inicioUtc, mock: false });
  db.marcarLembreteEntrevistaEnviado(id, { quando: '2026-10-01 12:00:00' });
  assert.equal((await cicloMassa(campanha)).enviados, 3);
});

test('(b) carencia nao cumprida (reuniao recem-cadastrada) nao segura a massa', async () => {
  limpar();
  const campanha = campanhaComItens();
  db.definirConfigBool(wa3.CHAVE_ATIVO, true);
  process.env.WA3_MOCK = 'false';
  const { jobId, inicioUtc } = vagaWa3('12:00');
  sql("UPDATE lembretes_entrevista_reunioes SET primeira_vez_vista = '2026-10-01 12:58:00' WHERE job_id = ? AND inicio_reuniao_utc = ?", jobId, inicioUtc);
  assert.equal((await cicloMassa(campanha)).enviados, 3);
});

test('(b) existeLembretePendente: desligado nao toca o banco de candidatos', () => {
  limpar();
  vagaWa3('12:00');
  const espiao = espiar();
  try {
    assert.equal(wa3.existeLembretePendente({ db, agora: AGORA, mock: false }), false);
  } finally {
    espiao.restaurar();
  }
  assert.equal(espiao.chamadas.listarVagasParaLembreteEntrevista, 0);
});

// ══════════════════ (c) ESPACAMENTO GLOBAL ══════════════════

test('(c) espacamento: envio REAL do WA3 ha 5 s faz a massa esperar 10 s', async () => {
  limpar();
  const campanha = campanhaComItens();
  db.definirConfigBool(wa3.CHAVE_ATIVO, true);
  process.env.WA3_MOCK = 'false';
  envioWa3Real('2026-10-01 12:59:55');
  const r = await cicloMassa(campanha);
  assert.equal(r.dormidas[0], 10000);
  assert.equal(r.enviados, 3);
});

test('(c) espacamento: vale o MAIS RECENTE entre transacional e WA3', async () => {
  limpar();
  campanhaComItens();
  db.definirConfigBool(wa3.CHAVE_ATIVO, true);
  envioWa3Real('2026-10-01 12:59:50'); // ha 10 s
  sql(`INSERT INTO whatsapp_sequencia_envios (application_id, etapa, telefone_e164, status, agendado_para, enviado_em)
       VALUES (999, 'wa1', '5547999999999', 'enviado', '2026-10-01 12:59:58', '2026-10-01 12:59:58')`);
  const dormidas = [];
  await massa.aguardarEspacamento({ db, dormir: async (ms) => dormidas.push(ms), espacamentoMs: 15000, agora: AGORA });
  assert.deepEqual(dormidas, [13000]);
});

test('(c) espacamento: envio em SIMULACAO do WA3 nao conta (esperas iguais as da base)', async () => {
  limpar();
  const base = await cicloMassa(campanhaComItens());
  limpar();
  const campanha = campanhaComItens();
  db.definirConfigBool(wa3.CHAVE_ATIVO, true);
  envioWa3Real('2026-10-01 12:59:55', { mock: true });
  // As esperas que sobram sao so o gap da cadencia entre mensagens, nunca a do espacamento.
  assert.deepEqual((await cicloMassa(campanha)).dormidas, base.dormidas);
  assert.ok(!base.dormidas.includes(10000));
});

test.after(() => {
  delete process.env.WA3_MOCK;
});
