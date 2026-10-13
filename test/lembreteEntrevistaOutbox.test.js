'use strict';

// WA3 (incremento 6) — o worker dos lembretes, ponta a ponta sobre banco temporario real.
//
// Tudo que fala com o mundo entra por deps (enviarTexto, onWhatsAppLote, verificarExiste, dormir,
// relogio, aleatorio). Nenhuma rede, nenhum socket, nenhum relogio real.
//
// Os testes de IDEMPOTENCIA e TROCA DE DATA sao os que o desenho existe para acertar: ticks
// repetidos, ciclos concorrentes e reserva sem marcacao nunca podem produzir segundo envio, e
// mudar a data tem que gerar lembretes novos sem ressuscitar os da data antiga.

const os = require('node:os');
const path = require('node:path');

process.env.DATABASE_PATH = path.join(os.tmpdir(), `vm-test-wa3-outbox-${process.pid}-${Date.now()}.db`);
process.env.INTERVIEW_MOCK = 'true';
process.env.SESSION_SECRET = 'segredo-de-teste';
process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert/strict');

const db = require('../src/db');
const { migrar } = require('../src/db/migrate');
const optout = require('../src/lib/optoutWhatsapp');
const wa3 = require('../src/whatsapp/lembreteEntrevistaOutbox');

migrar();
db.definirConfigBool(optout.CHAVE_ATIVO, true);

const sql = (q, ...p) => db.getDb().prepare(q).run(...p);
const linhas = (jobId) => db.getDb().prepare('SELECT * FROM lembretes_entrevista_enviados WHERE job_id = ? ORDER BY id').all(jobId);

// Reuniao: quinta 15/10/2026 15:00 Brasilia = 18:00Z. wa3b devido 16:00Z (13:00 Brasilia).
const INICIO_UTC = '2026-10-15 18:00:00';
const T_WA3B = new Date('2026-10-15T16:05:00Z');
const T_WA3C = new Date('2026-10-15T17:46:00Z');

let seq = 0;
let fone = 0;
const novoFone = () => {
  fone += 1;
  return `479995${String(10000 + fone).padStart(5, '0')}`;
};

// Cria a vaga, desativa todas as outras (o worker varre TODAS as vagas ativas) e envelhece a
// reuniao no registro para a carencia ja estar cumprida — salvo `carencia: false`.
function cenario({ data = '2026-10-15', hora = '15:00', convidados = 1, conviteEm = '2026-10-10 12:00:00', carencia = true, status = null } = {}) {
  seq += 1;
  sql('UPDATE jobs SET ativo = 0');
  const jobId = db.criarVaga({
    slug: `wa3-outbox-${seq}`, titulo: 'Closer de Vendas', perfil: 'CLOSER',
    link_meet: 'https://calendly.com/vm/x', link_meet_reuniao: 'https://meet.google.com/abc-defg-hij',
    entrevista_grupo_1_data: data, entrevista_grupo_1_hora: hora,
  });
  const telefones = [];
  for (let i = 0; i < convidados; i += 1) {
    const telefone = novoFone();
    const app = Number(sql('INSERT INTO applications (job_id, nome, telefone, status_recrutador) VALUES (?, ?, ?, ?)', jobId, 'Maria Souza', telefone, status).lastInsertRowid);
    sql(
      `INSERT INTO whatsapp_sequencia_envios (application_id, etapa, telefone_e164, status, agendado_para, enviado_em, variante)
       VALUES (?, 'wa2', ?, 'enviado', ?, ?, 'convite_grupo')`,
      app, `55${telefone}`, conviteEm, conviteEm,
    );
    telefones.push(`55${telefone}`);
  }
  if (carencia) {
    const vaga = db.obterVaga(jobId);
    const { reunioesDaVaga } = require('../src/lib/lembreteEntrevista');
    const { paraTextoSqlUtc } = require('../src/lib/fusoBrasilia');
    for (const r of reunioesDaVaga(vaga)) db.registrarReuniaoVistaLembrete(jobId, paraTextoSqlUtc(r.instante), '2026-10-01 00:00:00');
  }
  return { jobId, telefones };
}

function deps(extra = {}) {
  const enviados = [];
  const d = {
    db,
    mock: false,
    baileysLigado: true,
    socketConectado: true,
    agora: T_WA3B,
    aleatorio: () => 0,
    dormir: async () => {},
    onWhatsAppLote: async (lista) => new Map(lista.map((t, i) => [t, i === 0 ? true : null])),
    verificarExiste: async () => ({ existe: true }),
    enviarTexto: async (tel, texto) => { enviados.push({ tel, texto }); },
    ...extra,
  };
  return { d, enviados };
}

test.beforeEach(() => db.definirConfigBool(wa3.CHAVE_ATIVO, true));

// ══════════════════ INTERRUPTORES ══════════════════

test('wa3_ativo nasce DESLIGADO: chave ausente = nada enviado e nada gravado', async () => {
  sql("DELETE FROM configuracoes WHERE chave = 'wa3_ativo'");
  assert.equal(wa3.ativo(), false);
  const { jobId } = cenario({ carencia: false });
  const { d, enviados } = deps();
  const r = await wa3.processarCicloLembretes(d);
  assert.equal(r.desativado, true);
  assert.equal(enviados.length, 0);
  assert.equal(db.listarReunioesVistasLembrete(jobId).length, 0, 'desligado nao toca o banco');
});

test('WA3_MOCK default true', () => {
  const antes = process.env.WA3_MOCK;
  delete process.env.WA3_MOCK;
  try {
    assert.equal(wa3.modoMock(), true);
    process.env.WA3_MOCK = 'false';
    assert.equal(wa3.modoMock(), false);
  } finally {
    if (antes === undefined) delete process.env.WA3_MOCK;
    else process.env.WA3_MOCK = antes;
  }
});

test('Baileys desligado ou socket caido: desativado, nada enviado', async () => {
  cenario();
  const a = deps({ baileysLigado: false });
  assert.equal((await wa3.processarCicloLembretes(a.d)).desativado, true);
  const b = deps({ socketConectado: false });
  assert.equal((await wa3.processarCicloLembretes(b.d)).desativado, true);
  assert.equal(a.enviados.length + b.enviados.length, 0);
});

// ══════════════════ ENVIO BASICO ══════════════════

test('wa3b vencido sai uma vez, com o link da sala, e fica gravado como enviado', async () => {
  const { jobId, telefones } = cenario();
  const { d, enviados } = deps();
  const r = await wa3.processarCicloLembretes(d);
  assert.equal(r.enviados, 1);
  assert.equal(enviados[0].tel, telefones[0]);
  assert.match(enviados[0].texto, /meet\.google\.com\/abc-defg-hij/);
  const [l] = linhas(jobId).filter((x) => x.tipo === 'wa3b');
  assert.equal(l.status, 'enviado');
  assert.equal(l.mock, 0);
  assert.equal(l.inicio_reuniao_utc, INICIO_UTC);
  assert.equal(l.variacao_indice, 1);
  // wa3a da vespera (18h-21h de 14/10) ja passou: registrado como pulado/atrasado.
  const a = linhas(jobId).find((x) => x.tipo === 'wa3a');
  assert.equal(a.status, 'pulado');
  assert.equal(a.motivo, 'atrasado');
});

// ══════════════════ IDEMPOTENCIA (bug-to-confirm) ══════════════════

test('IDEMPOTENCIA: dois ticks seguidos -> um envio so', async () => {
  const { jobId } = cenario();
  const { d, enviados } = deps();
  await wa3.processarCicloLembretes(d);
  await wa3.processarCicloLembretes({ ...d, agora: new Date(T_WA3B.getTime() + 60 * 1000) });
  assert.equal(enviados.length, 1);
  assert.equal(linhas(jobId).filter((x) => x.tipo === 'wa3b').length, 1);
});

test('IDEMPOTENCIA: dois ciclos CONCORRENTES (sem a trava em memoria) -> um envio por chave', async () => {
  cenario({ convidados: 3 });
  const enviados = [];
  const lento = async (tel, texto) => {
    await new Promise((r) => setImmediate(r));
    enviados.push({ tel, texto });
  };
  const a = deps({ enviarTexto: lento });
  const b = deps({ enviarTexto: lento });
  await Promise.all([wa3.processarCicloLembretes(a.d), wa3.processarCicloLembretes(b.d)]);
  assert.equal(enviados.length, 3);
  assert.equal(new Set(enviados.map((e) => e.tel)).size, 3);
});

test('IDEMPOTENCIA: reserva em enviando sem marcacao (queda apos o envio) NAO reenvia', async () => {
  const { jobId, telefones } = cenario();
  const { chaveCanonicaTelefone } = require('../src/lib/chaveTelefone');
  db.reservarLembreteEntrevista({ jobId, telefoneCanonico: chaveCanonicaTelefone(telefones[0]), tipo: 'wa3b', inicioUtc: INICIO_UTC });
  const { d, enviados } = deps();
  await wa3.processarCicloLembretes(d);
  assert.equal(enviados.length, 0);
});

// ══════════════════ TROCA DE DATA (bug-to-confirm) ══════════════════

test('TROCA DE DATA: chave nova gera lembrete novo; o da data antiga nunca volta', async () => {
  const { jobId } = cenario();
  const { d, enviados } = deps();
  await wa3.processarCicloLembretes(d);
  assert.equal(enviados.length, 1);

  // Admin adia a reuniao para 16:00 Brasilia (19:00Z).
  sql("UPDATE jobs SET entrevista_grupo_1_hora = '16:00' WHERE id = ?", jobId);
  // Primeiro tick depois da troca: a reuniao nova esta em CARENCIA.
  const r1 = await wa3.processarCicloLembretes({ ...d, agora: new Date('2026-10-15T17:01:00Z') });
  assert.equal(r1.emCarencia, 1);
  assert.equal(enviados.length, 1);
  // 10 min depois: sai o wa3b da reuniao nova (devido 17:00Z, tolerancia ate 17:30Z).
  await wa3.processarCicloLembretes({ ...d, agora: new Date('2026-10-15T17:11:00Z') });
  assert.equal(enviados.length, 2);
  assert.match(enviados[1].texto, /16:00/);
  // E nada mais sai para a data antiga, nem no horario do wa3c dela.
  await wa3.processarCicloLembretes({ ...d, agora: T_WA3C });
  const antigas = linhas(jobId).filter((x) => x.inicio_reuniao_utc === INICIO_UTC && x.status === 'enviado');
  assert.equal(antigas.length, 1);
  const novas = linhas(jobId).filter((x) => x.inicio_reuniao_utc === '2026-10-15 19:00:00' && x.status === 'enviado');
  assert.deepEqual(novas.map((x) => x.tipo), ['wa3b']);
});

// ══════════════════ CARENCIA ══════════════════

test('CARENCIA: reuniao vista pela primeira vez agora nao envia; 10 min depois envia', async () => {
  const { jobId } = cenario({ carencia: false });
  const { d, enviados } = deps();
  const r1 = await wa3.processarCicloLembretes(d);
  assert.equal(r1.emCarencia, 1);
  assert.equal(enviados.length, 0);
  assert.equal(linhas(jobId).length, 0, 'em carencia nem o pulado e registrado');
  await wa3.processarCicloLembretes({ ...d, agora: new Date(T_WA3B.getTime() + 9 * 60 * 1000) });
  assert.equal(enviados.length, 0);
  await wa3.processarCicloLembretes({ ...d, agora: new Date(T_WA3B.getTime() + 10 * 60 * 1000) });
  assert.equal(enviados.length, 1);
});

// ══════════════════ REGRAS DO CRONOGRAMA NO WORKER ══════════════════

test('convite enviado depois do horario do lembrete: pulado com motivo convite_depois', async () => {
  const { jobId } = cenario({ conviteEm: '2026-10-15 16:02:00' });
  const { d, enviados } = deps();
  await wa3.processarCicloLembretes(d);
  assert.equal(enviados.length, 0);
  const b = linhas(jobId).find((x) => x.tipo === 'wa3b');
  assert.equal(b.status, 'pulado');
  assert.equal(b.motivo, 'convite_depois');
});

test('fora da janela 07-21: pulado com motivo fora_janela', async () => {
  // Reuniao 22:00 Brasilia (16/10 01:00Z): wa3c devido 21:45.
  const { jobId } = cenario({ data: '2026-10-15', hora: '22:00' });
  const { d, enviados } = deps({ agora: new Date('2026-10-16T00:46:00Z') });
  await wa3.processarCicloLembretes(d);
  assert.equal(enviados.length, 0);
  assert.equal(linhas(jobId).find((x) => x.tipo === 'wa3c').motivo, 'fora_janela');
});

test('tolerancia conferida de novo antes de cada envio: ciclo lento pula o atrasado', async () => {
  const { jobId } = cenario({ convidados: 2 });
  // wa3c: devido 17:45Z, limite 17:55Z. O primeiro sai 17:46; o relogio salta para 17:56.
  let t = T_WA3C.getTime();
  const { d, enviados } = deps({
    agora: T_WA3C,
    relogio: () => new Date(t),
    enviarTexto: async (tel, texto) => { enviados.push({ tel, texto }); t = Date.parse('2026-10-15T17:56:00Z'); },
  });
  await wa3.processarCicloLembretes(d);
  assert.equal(enviados.length, 1);
  const c = linhas(jobId).filter((x) => x.tipo === 'wa3c');
  assert.deepEqual(c.map((x) => x.status).sort(), ['enviado', 'pulado']);
});

test('reprovado nao recebe nem gera linha', async () => {
  const { jobId } = cenario({ status: 'reprovado' });
  const { d, enviados } = deps();
  await wa3.processarCicloLembretes(d);
  assert.equal(enviados.length, 0);
  assert.equal(linhas(jobId).length, 0);
});

test('opt-out total: linha opt_out, nada enviado', async () => {
  const { jobId, telefones } = cenario();
  optout.registrarOptout({ telefone: telefones[0], escopo: 'total' });
  const { d, enviados } = deps();
  const r = await wa3.processarCicloLembretes(d);
  assert.equal(enviados.length, 0);
  assert.equal(r.suprimidos, 1);
  assert.equal(linhas(jobId).find((x) => x.tipo === 'wa3b').status, 'opt_out');
});

// ══════════════════ 9o DIGITO (regra do transacional) ══════════════════

test('9o digito: so a variante sem o 9 confirmada -> envia sem o 9', async () => {
  const { jobId, telefones } = cenario();
  const semNove = telefones[0].replace(/^5547(9)/, '5547');
  const { d, enviados } = deps({ onWhatsAppLote: async () => new Map([[telefones[0], null], [semNove, true]]) });
  await wa3.processarCicloLembretes(d);
  assert.equal(enviados[0].tel, semNove);
  assert.equal(linhas(jobId).find((x) => x.tipo === 'wa3b').telefone, semNove);
});

test('9o digito: nada verificado -> tenta com o 9 (nao adia, nao bloqueia)', async () => {
  const { telefones } = cenario();
  const { d, enviados } = deps({ onWhatsAppLote: async (l) => new Map(l.map((t) => [t, null])) });
  await wa3.processarCicloLembretes(d);
  assert.equal(enviados[0].tel, telefones[0]);
});

test('9o digito: com o 9 explicitamente inexistente -> sem_whatsapp, nada enviado', async () => {
  const { jobId } = cenario();
  const { d, enviados } = deps({ onWhatsAppLote: async (l) => new Map(l.map((t) => [t, false])) });
  await wa3.processarCicloLembretes(d);
  assert.equal(enviados.length, 0);
  assert.equal(linhas(jobId).find((x) => x.tipo === 'wa3b').status, 'sem_whatsapp');
});

// ══════════════════ MOCK E FALHAS ══════════════════

test('mock: nao toca o socket, grava mock=1, e NAO bloqueia o envio real depois', async () => {
  const { jobId } = cenario();
  const m = deps({ mock: true, enviarTexto: async () => { throw new Error('nao deveria enviar'); } });
  const r = await wa3.processarCicloLembretes(m.d);
  assert.equal(r.enviados, 1);
  assert.equal(linhas(jobId).find((x) => x.tipo === 'wa3b').mock, 1);
  const real = deps();
  await wa3.processarCicloLembretes(real.d);
  assert.equal(real.enviados.length, 1);
});

test('sessao caiu no meio: falha naquele, ciclo interrompido, o resto NAO e reservado', async () => {
  const { jobId } = cenario({ convidados: 3 });
  const { d } = deps({ enviarTexto: async () => { throw new Error('WhatsApp sem socket ativo: mensagem nao enviada.'); } });
  const r = await wa3.processarCicloLembretes(d);
  assert.equal(r.falhas, 1);
  assert.equal(linhas(jobId).filter((x) => x.tipo === 'wa3b').length, 1);
  // No proximo tick, com a sessao de volta, os outros dois saem.
  const ok = deps({ agora: new Date(T_WA3B.getTime() + 60 * 1000) });
  await wa3.processarCicloLembretes(ok.d);
  assert.equal(ok.enviados.length, 2);
});

test('erro comum de envio: falha so naquele destinatario, o ciclo segue', async () => {
  cenario({ convidados: 2 });
  let n = 0;
  const { d } = deps({ enviarTexto: async () => { n += 1; if (n === 1) throw new Error('timeout'); } });
  const r = await wa3.processarCicloLembretes(d);
  assert.equal(r.falhas, 1);
  assert.equal(r.enviados, 1);
});

test('gap aleatorio entre envios (nao antes do primeiro)', async () => {
  cenario({ convidados: 3 });
  const esperas = [];
  const { d } = deps({ dormir: async (ms) => { esperas.push(ms); }, aleatorio: () => 0.5 });
  await wa3.processarCicloLembretes(d);
  assert.deepEqual(esperas, [7000, 7000]);
});

test('varrerSeOcioso: um segundo tick no meio do primeiro e descartado', async () => {
  cenario();
  let soltar;
  const preso = new Promise((r) => { soltar = r; });
  const { d } = deps({ enviarTexto: async () => preso });
  const primeiro = wa3.varrerSeOcioso(d);
  await new Promise((r) => setImmediate(r));
  assert.equal(await wa3.varrerSeOcioso(d), null);
  soltar();
  await primeiro;
});
