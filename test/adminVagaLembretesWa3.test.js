'use strict';

// WA3 (incremento 8) — a tela da vaga: alertas, previa por tipo e historico de enviados/pulados.
//
// HTTP de ponta a ponta. A tela usa o relogio REAL (GET nao recebe `agora`), entao as datas aqui
// sao relativas a hoje — data fixa no futuro vira passado e o teste quebra sozinho um dia.

const os = require('node:os');
const path = require('node:path');

process.env.DATABASE_PATH = path.join(os.tmpdir(), `vm-test-admin-vaga-wa3-${process.pid}-${Date.now()}.db`);
process.env.INTERVIEW_MOCK = 'true';
process.env.SESSION_SECRET = 'segredo-de-teste';
process.env.ADMIN_USER = 'admin-teste';
process.env.ADMIN_PASSWORD = 'senha-teste';
process.env.NODE_ENV = 'test';
delete process.env.WA3_MOCK;

const test = require('node:test');
const assert = require('node:assert/strict');

const db = require('../src/db');
const { migrar } = require('../src/db/migrate');
const { criarApp } = require('../src/server');
const { paraTextoSqlUtc } = require('../src/lib/fusoBrasilia');
const { chaveCanonicaTelefone } = require('../src/lib/chaveTelefone');
const wa3 = require('../src/whatsapp/lembreteEntrevistaOutbox');

migrar();

const sql = (q, ...p) => db.getDb().prepare(q).run(...p);
const MEET = 'https://meet.google.com/abc-defg-hij';

function dia(dias) {
  const d = new Date(Date.now() + dias * 24 * 60 * 60 * 1000);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
}
const haMin = (min) => paraTextoSqlUtc(new Date(Date.now() - min * 60 * 1000));

let seq = 0;
function vaga(extra = {}) {
  seq += 1;
  return db.criarVaga({
    slug: `vaga-tela-wa3-${seq}`, titulo: 'Closer', perfil: 'CLOSER',
    link_meet: 'https://calendly.com/vm/x', link_meet_reuniao: MEET,
    entrevista_grupo_1_data: dia(5), entrevista_grupo_1_hora: '15:00',
    ...extra,
  });
}

function convidar(jobId, telefone, { status = null } = {}) {
  const app = Number(sql('INSERT INTO applications (job_id, nome, telefone, status_recrutador) VALUES (?, ?, ?, ?)', jobId, 'Joana Lima', telefone, status).lastInsertRowid);
  sql(
    `INSERT INTO whatsapp_sequencia_envios (application_id, etapa, telefone_e164, status, agendado_para, enviado_em, variante)
     VALUES (?, 'wa2', ?, 'enviado', ?, ?, 'convite_grupo')`,
    app, `55${telefone}`, haMin(24 * 60), haMin(24 * 60),
  );
  return app;
}

let cookie = '';
async function comServidor(fn) {
  const server = criarApp().listen(0);
  await new Promise((r) => server.once('listening', r));
  try {
    const base = `http://127.0.0.1:${server.address().port}`;
    const res = await fetch(`${base}/admin/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ usuario: 'admin-teste', senha: 'senha-teste' }),
      redirect: 'manual',
    });
    cookie = res.headers.getSetCookie().map((c) => c.split(';')[0]).join('; ');
    return await fn(base);
  } finally {
    await new Promise((r) => server.close(r));
  }
}
const tela = async (base, id) => (await fetch(`${base}/admin/vagas/${id}`, { headers: { Cookie: cookie } })).text();

// ══════════════════ ALERTAS ══════════════════

test('alerta: reuniao futura sem sala do Meet', async () => {
  const id = vaga({ link_meet_reuniao: '' });
  await comServidor(async (base) => {
    assert.match(await tela(base, id), /falta o link da sala \(Google Meet\)/);
  });
});

test('alerta: sala sem https://', async () => {
  const id = vaga({ link_meet_reuniao: 'meet.google.com/abc' });
  await comServidor(async (base) => {
    assert.match(await tela(base, id), /link da sala do Meet não começa com <b>https:\/\/<\/b>/);
  });
});

test('alerta: reuniao desatualizada (sala preenchida, todas as datas passaram)', async () => {
  const id = vaga({ entrevista_grupo_1_data: dia(-3) });
  await comServidor(async (base) => {
    assert.match(await tela(base, id), /Reunião desatualizada:/);
  });
});

test('sem sala e sem reuniao futura: nenhum alerta de WA3 (vaga fora do assunto)', async () => {
  const id = vaga({ link_meet_reuniao: '', entrevista_grupo_1_data: '' , entrevista_grupo_1_hora: '' });
  await comServidor(async (base) => {
    const html = await tela(base, id);
    assert.doesNotMatch(html, /falta o link da sala|Reunião desatualizada:|não começa com <b>https:\/\/<\/b>\. Ele não seria/);
  });
});

// ══════════════════ PREVIA ══════════════════

test('previa: conta convidados por lembrete, exclui reprovado, avisa que esta desligado', async () => {
  const id = vaga();
  convidar(id, '47999590001');
  convidar(id, '47999590002');
  convidar(id, '47999590003', { status: 'reprovado' });
  await comServidor(async (base) => {
    const html = await tela(base, id);
    assert.match(html, /Lembretes de WhatsApp da entrevista \(WA3\)/);
    assert.match(html, /Reunião 1 — .* · 2 pessoa\(s\) convidada\(s\)/);
    for (const r of ['Véspera \\(18h\\)', '2h antes', '15 min antes']) {
      assert.match(html, new RegExp(`<td>${r}</td>[\\s\\S]*?<td class="col-num">2</td>[\\s\\S]*?2 a enviar`), r);
    }
    assert.match(html, /Lembretes <b>desligados<\/b>/);
    assert.match(html, /Carência:/, 'reuniao nunca vista pelo worker esta em carencia');
  });
});

test('previa: nao grava nada (nem reuniao vista, nem reserva)', async () => {
  const id = vaga();
  convidar(id, '47999590101');
  await comServidor(async (base) => { await tela(base, id); });
  assert.equal(db.listarReunioesVistasLembrete(id).length, 0);
  assert.equal(db.listarLembretesEntrevistaDaVaga(id).length, 0);
});

// ══════════════════ HISTORICO ══════════════════

test('historico: enviado, pulado com motivo, enviando recente e INDETERMINADO (>10 min), telefone mascarado', async () => {
  const id = vaga();
  const tel = '5547999590201';
  const app = convidar(id, '47999590201');
  const inicio = paraTextoSqlUtc(new Date(`${dia(5)}T18:00:00Z`));
  const base = { jobId: id, applicationId: app, telefone: tel, telefoneCanonico: chaveCanonicaTelefone(tel), inicioUtc: inicio, mock: true };
  const idA = db.reservarLembreteEntrevista({ ...base, tipo: 'wa3a', quando: haMin(30) });
  db.marcarLembreteEntrevistaEnviado(idA, { variacaoIndice: 1 });
  db.reservarLembreteEntrevista({ ...base, tipo: 'wa3b', status: 'pulado', motivo: 'convite_depois' });
  db.reservarLembreteEntrevista({ ...base, tipo: 'wa3c', quando: haMin(20) });
  db.reservarLembreteEntrevista({ ...base, tipo: 'wa3c', mock: false, quando: haMin(2) });

  await comServidor(async (b) => {
    const html = await tela(b, id);
    assert.match(html, /Enviados e pulados/);
    assert.match(html, /<td>enviado <small>\(simulação\)<\/small><\/td>/);
    assert.match(html, /convite chegou depois do horário/);
    assert.match(html, /indeterminado \(caiu no meio do envio; não será reenviado\)/);
    assert.match(html, /<td>enviando<\/td>/);
    assert.ok(!html.includes(tel), 'telefone completo nao pode aparecer no HTML');
    assert.match(html, /5547\*+0201/);
    assert.match(html, /<td>Joana<\/td>/, 'so o primeiro nome');
  });
});

// ══════════════════ WORKER RESPEITA O ALERTA ══════════════════

test('worker ignora vaga com sala sem https:// (nada enviado, nada gravado)', async () => {
  sql('UPDATE jobs SET ativo = 0');
  const id = vaga({ link_meet_reuniao: 'meet.google.com/abc', entrevista_grupo_1_data: '2026-10-15', entrevista_grupo_1_hora: '15:00' });
  convidar(id, '47999590301');
  db.definirConfigBool(wa3.CHAVE_ATIVO, true);
  const enviados = [];
  try {
    await wa3.processarCicloLembretes({
      db, mock: false, baileysLigado: true, socketConectado: true,
      agora: new Date('2026-10-15T16:05:00Z'), dormir: async () => {},
      onWhatsAppLote: async (l) => new Map(l.map((t) => [t, true])),
      enviarTexto: async (t) => { enviados.push(t); },
    });
  } finally {
    db.definirConfigBool(wa3.CHAVE_ATIVO, false);
  }
  assert.equal(enviados.length, 0);
  assert.equal(db.listarReunioesVistasLembrete(id).length, 0);
});
