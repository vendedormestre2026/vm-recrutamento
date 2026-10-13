'use strict';

// WA3 (incremento 4) — tabelas, consultas e publico dos lembretes.
//
// Banco temporario real: a idempotencia mora no UNIQUE do SQLite, e so um banco de verdade prova
// que a segunda reserva da mesma chave devolve null. Nenhuma rede, nenhum envio.

const os = require('node:os');
const path = require('node:path');

process.env.DATABASE_PATH = path.join(os.tmpdir(), `vm-test-publico-lembrete-${process.pid}-${Date.now()}.db`);
process.env.INTERVIEW_MOCK = 'true';
process.env.SESSION_SECRET = 'segredo-de-teste';
process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert/strict');

const db = require('../src/db');
const { migrar } = require('../src/db/migrate');
const { montarPublicoLembrete, carregarPublicoLembrete } = require('../src/lib/publicoLembreteEntrevista');

migrar();

const sql = (q, ...p) => db.getDb().prepare(q).run(...p);
const AGORA = new Date('2026-10-14T12:00:00Z');
const INICIO_UTC = '2026-10-15 18:00:00'; // 15/10 15:00 Brasilia

let seq = 0;
function novaVaga(extra = {}) {
  seq += 1;
  return db.criarVaga({
    slug: `vaga-wa3-${seq}`,
    titulo: 'Closer',
    perfil: 'CLOSER',
    link_meet: 'https://calendly.com/x',
    link_meet_reuniao: 'https://meet.google.com/abc',
    entrevista_grupo_1_data: '2026-10-15',
    entrevista_grupo_1_hora: '15:00',
    ...extra,
  });
}

function novaCandidatura(jobId, { nome = 'Maria Souza', telefone = '47999582500', status = null, arquivada = false } = {}) {
  const id = Number(
    sql(
      `INSERT INTO applications (job_id, nome, telefone, status_recrutador, deleted_at) VALUES (?, ?, ?, ?, ?)`,
      jobId, nome, telefone, status, arquivada ? '2026-10-01 00:00:00' : null,
    ).lastInsertRowid,
  );
  return id;
}

function wa2(appId, { enviadoEm = '2026-10-10 12:00:00', variante = 'convite_grupo', status = 'enviado' } = {}) {
  sql(
    `INSERT INTO whatsapp_sequencia_envios (application_id, etapa, telefone_e164, status, agendado_para, enviado_em, variante)
     VALUES (?, 'wa2', '5547999582500', ?, ?, ?, ?)`,
    appId, status, enviadoEm, enviadoEm, variante,
  );
}

function campanhaMassa(fonte = null) {
  const criterios = fonte ? JSON.stringify({ fonte }) : JSON.stringify({ statusList: ['sem_decisao'] });
  return Number(sql(`INSERT INTO campanhas_massa_wa (nome, criterios_json, status) VALUES ('c', ?, 'concluida')`, criterios).lastInsertRowid);
}

let canon = 0;
function massa(campanhaId, appId, jobId, { enviadoEm = '2026-10-11 12:00:00', status = 'enviado', telefone = '5547999582500' } = {}) {
  canon += 1;
  sql(
    `INSERT INTO campanhas_massa_wa_envios (campanha_id, telefone, telefone_canonico, application_id, job_id, status, enviado_em)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    campanhaId, telefone, `c${canon}`, appId, jobId, status, enviadoEm,
  );
}

const publico = (jobId, agora = AGORA) => carregarPublicoLembrete(db.obterVaga(jobId), { agora });
const destinos = (r) => r.reunioes[0].destinatarios;

// ══════════════════ TABELAS E RESERVA ══════════════════

test('reserva: a mesma chave so grava UMA vez; a segunda devolve null', () => {
  const jobId = novaVaga();
  const k = { jobId, telefoneCanonico: '554799582500', tipo: 'wa3b', inicioUtc: INICIO_UTC };
  const id = db.reservarLembreteEntrevista(k);
  assert.ok(id);
  assert.equal(db.reservarLembreteEntrevista(k), null);
  assert.equal(db.reservarLembreteEntrevista({ ...k, status: 'pulado', motivo: 'atrasado' }), null);
});

test('reserva: mock entra na chave (simulacao nao bloqueia o real); outra data e outra chave', () => {
  const jobId = novaVaga();
  const k = { jobId, telefoneCanonico: '554799582501', tipo: 'wa3c', inicioUtc: INICIO_UTC };
  assert.ok(db.reservarLembreteEntrevista({ ...k, mock: true }));
  assert.ok(db.reservarLembreteEntrevista({ ...k, mock: false }));
  assert.ok(db.reservarLembreteEntrevista({ ...k, inicioUtc: '2026-10-16 18:00:00' }));
  assert.deepEqual([...db.chavesLembreteEntrevista(jobId, INICIO_UTC, true)], ['554799582501|wa3c']);
});

test('marcacao so fecha linha em enviando; linha terminal nao muda', () => {
  const jobId = novaVaga();
  const id = db.reservarLembreteEntrevista({ jobId, telefoneCanonico: 'x1', tipo: 'wa3a', inicioUtc: INICIO_UTC });
  assert.equal(db.marcarLembreteEntrevistaEnviado(id, { variacaoIndice: 2 }), 1);
  assert.equal(db.marcarLembreteEntrevistaTerminal(id, 'falha', 'x'), 0);
  assert.equal(db.marcarLembreteEntrevistaEnviado(id, {}), 0);
  const linha = db.listarLembretesEntrevistaDaVaga(jobId)[0];
  assert.equal(linha.status, 'enviado');
  assert.equal(linha.variacao_indice, 2);
});

test('reuniao vista: primeira_vez fica, ultima_vez so avanca', () => {
  const jobId = novaVaga();
  const a = db.registrarReuniaoVistaLembrete(jobId, INICIO_UTC, '2026-10-14 12:00:00');
  assert.equal(a.primeira_vez_vista, '2026-10-14 12:00:00');
  const b = db.registrarReuniaoVistaLembrete(jobId, INICIO_UTC, '2026-10-14 12:05:00');
  assert.equal(b.primeira_vez_vista, '2026-10-14 12:00:00');
  assert.equal(b.ultima_vez_vista, '2026-10-14 12:05:00');
  const c = db.registrarReuniaoVistaLembrete(jobId, INICIO_UTC, '2026-10-14 11:00:00');
  assert.equal(c.ultima_vez_vista, '2026-10-14 12:05:00', 'relogio para tras nao recua');
});

test('listarVagasParaLembreteEntrevista: so vaga ativa com sala do Meet', () => {
  const com = novaVaga();
  const sem = novaVaga({ link_meet_reuniao: '' });
  const fechada = novaVaga({ ativo: false });
  const ids = db.listarVagasParaLembreteEntrevista().map((v) => v.id);
  assert.ok(ids.includes(com));
  assert.ok(!ids.includes(sem));
  assert.ok(!ids.includes(fechada));
});

// ══════════════════ CONVITES ══════════════════

test('convites: WA2 so variante convite_grupo enviada; sem_reuniao, NULL e pendente ficam fora', () => {
  const jobId = novaVaga();
  wa2(novaCandidatura(jobId, { telefone: '47999580001' }));
  wa2(novaCandidatura(jobId, { telefone: '47999580002' }), { variante: 'sem_reuniao' });
  wa2(novaCandidatura(jobId, { telefone: '47999580003' }), { variante: null });
  wa2(novaCandidatura(jobId, { telefone: '47999580004' }), { status: 'pendente' });
  wa2(novaCandidatura(jobId, { telefone: '47999580005', arquivada: true }));
  assert.equal(db.listarConvitesEntrevistaGrupo(jobId).length, 1);
  assert.equal(destinos(publico(jobId)).length, 1);
});

test('convites: massa de vagas abertas entra; massa de SEGMENTO fica fora', () => {
  const jobId = novaVaga();
  const abertas = campanhaMassa();
  const segmento = campanhaMassa('segmento');
  massa(abertas, novaCandidatura(jobId, { telefone: '47999581001' }), jobId);
  massa(segmento, novaCandidatura(jobId, { telefone: '47999581002' }), jobId);
  massa(abertas, novaCandidatura(jobId, { telefone: '47999581003' }), jobId, { status: 'falha' });
  const r = publico(jobId);
  assert.equal(r.funil.convitesSegmento, 1);
  assert.equal(destinos(r).length, 1);
  assert.equal(destinos(r)[0].houveWa2, false);
});

// ══════════════════ PUBLICO ══════════════════

test('pessoa = chave canonica: duas candidaturas, com e sem o 9, viram UM destinatario', () => {
  const jobId = novaVaga();
  wa2(novaCandidatura(jobId, { telefone: '(47) 99958-2600' }), { enviadoEm: '2026-10-10 12:00:00' });
  massa(campanhaMassa(), novaCandidatura(jobId, { telefone: '+55 47 9958-2600' }), jobId, { enviadoEm: '2026-10-09 12:00:00' });
  const d = destinos(publico(jobId));
  assert.equal(d.length, 1);
  assert.equal(d[0].houveWa2, true, 'houve WA2 -> escopo transacional (D3)');
  assert.equal(d[0].conviteEm.toISOString(), '2026-10-09T12:00:00.000Z', 'convite mais antigo que anunciou');
});

test('D2: so sem_decisao e em_analise; aprovado/reprovado/desconhecido saem', () => {
  const jobId = novaVaga();
  wa2(novaCandidatura(jobId, { telefone: '47999582701', status: null }));
  wa2(novaCandidatura(jobId, { telefone: '47999582702', status: 'Em análise' }));
  wa2(novaCandidatura(jobId, { telefone: '47999582703', status: 'reprovado' }));
  wa2(novaCandidatura(jobId, { telefone: '47999582704', status: 'aprovado' }));
  wa2(novaCandidatura(jobId, { telefone: '47999582705', status: 'xyz' }));
  const r = publico(jobId);
  assert.equal(destinos(r).length, 2);
  assert.equal(r.funil.pessoasStatusExcluido, 3);
});

test('D2: reprovada em UMA candidatura convidada sai, mesmo com outra sem decisao', () => {
  const jobId = novaVaga();
  wa2(novaCandidatura(jobId, { telefone: '47999582801', status: 'reprovado' }));
  wa2(novaCandidatura(jobId, { telefone: '47999582801', status: null }));
  assert.equal(destinos(publico(jobId)).length, 0);
});

test('telefone que nao sobrevive a ida e volta fica fora (sem derrubar o resto)', () => {
  const jobId = novaVaga();
  const app = novaCandidatura(jobId, { telefone: 'abc' });
  sql(
    `INSERT INTO whatsapp_sequencia_envios (application_id, etapa, telefone_e164, status, agendado_para, enviado_em, variante)
     VALUES (?, 'wa2', '', 'enviado', '2026-10-10 12:00:00', '2026-10-10 12:00:00', 'convite_grupo')`,
    app,
  );
  wa2(novaCandidatura(jobId, { telefone: '47999582901' }));
  const r = publico(jobId);
  assert.equal(r.funil.convitesSemTelefone, 1);
  assert.equal(destinos(r).length, 1);
});

test('D1: convidado para a reuniao 1 nao entra na lista da reuniao 2', () => {
  const jobId = novaVaga({
    entrevista_grupo_1_data: '2026-10-12', entrevista_grupo_1_hora: '15:00',
    entrevista_grupo_2_data: '2026-10-15', entrevista_grupo_2_hora: '15:00',
  });
  wa2(novaCandidatura(jobId, { telefone: '47999583001' }), { enviadoEm: '2026-10-10 12:00:00' });
  wa2(novaCandidatura(jobId, { telefone: '47999583002' }), { enviadoEm: '2026-10-13 12:00:00' });
  const r = publico(jobId);
  assert.equal(r.reunioes.length, 1, 'so a reuniao futura');
  assert.equal(destinos(r).length, 1);
  assert.equal(destinos(r)[0].telefone, '5547999583002');
});

test('D1 teto: convite com mais de 10 dias antes da reuniao fica de fora', () => {
  const jobId = novaVaga();
  wa2(novaCandidatura(jobId, { telefone: '47999583101' }), { enviadoEm: '2026-10-05 17:00:00' });
  const r = publico(jobId);
  assert.equal(destinos(r).length, 0);
  assert.equal(r.funil.convitesSemReuniaoAnunciada, 1);
});

test('troca de slot pelo banco: reuniao antiga sobrescrita, vista pelo worker, segura os convidados dela', () => {
  // Slot 1 era 08/10 15h; convite em 06/10; o worker viu a reuniao ate depois do inicio.
  const jobId = novaVaga({ entrevista_grupo_1_data: '2026-10-08', entrevista_grupo_1_hora: '15:00' });
  wa2(novaCandidatura(jobId, { telefone: '47999583201' }), { enviadoEm: '2026-10-06 12:00:00' });
  db.registrarReuniaoVistaLembrete(jobId, '2026-10-08 18:00:00', '2026-10-06 13:00:00');
  db.registrarReuniaoVistaLembrete(jobId, '2026-10-08 18:00:00', '2026-10-08 18:30:00');
  // Admin troca o slot 1 por 15/10.
  sql(`UPDATE jobs SET entrevista_grupo_1_data = '2026-10-15' WHERE id = ?`, jobId);
  wa2(novaCandidatura(jobId, { telefone: '47999583202' }), { enviadoEm: '2026-10-09 12:00:00' });
  const d = destinos(publico(jobId));
  assert.deepEqual(d.map((x) => x.telefone), ['5547999583202']);
});

test('montarPublicoLembrete e puro: sem reuniao futura, lista vazia', () => {
  const r = montarPublicoLembrete(
    { entrevista_grupo_1_data: '2026-10-01', entrevista_grupo_1_hora: '15:00' },
    { convites: [], agora: AGORA },
  );
  assert.deepEqual(r.reunioes, []);
});
