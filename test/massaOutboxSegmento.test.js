'use strict';

// Worker do disparo em massa (whatsapp/massaOutbox) com campanhas de SEGMENTO DA BASE.
//
// Mesmo arranjo de test/massaOutbox.test.js: banco real em tmp, envio e onWhatsApp DUBLADOS —
// nenhum socket, nenhum Baileys, nenhuma credencial. O que se prova aqui e o DESVIO: so campanha
// com criterios.fonte = 'segmento' passa por ele; o resto do worker e o de sempre (coberto pelo
// teste do worker, que continua passando sem mudanca).

const os = require('node:os');
const path = require('node:path');

process.env.DATABASE_PATH = path.join(
  os.tmpdir(),
  `vm-test-massa-outbox-segmento-${process.pid}-${Date.now()}.db`,
);
process.env.INTERVIEW_MOCK = 'true';
process.env.SESSION_SECRET = 'segredo-de-teste';
process.env.OPTOUT_TOKEN_SECRET = 'segredo-hmac-de-teste';
process.env.NODE_ENV = 'test';

const fs = require('node:fs');
const test = require('node:test');
const assert = require('node:assert/strict');

const db = require('../src/db');
const { migrar } = require('../src/db/migrate');
const worker = require('../src/whatsapp/massaOutbox');
const { VARIACOES_SEED, VARIACOES_SEED_CONVITE } = require('../src/lib/variacoesMassaWa');

migrar();

// Quinta-feira, 10h de Brasilia: dentro da janela padrao.
const AGORA = new Date(Date.UTC(2026, 9, 1, 13, 0));
let seq = 0;

function criarVaga(campos = {}) {
  seq += 1;
  return db.criarVaga({
    slug: `vaga-seg-outbox-${seq}`,
    titulo: `Vaga ${seq}`,
    perfil: 'CLOSER',
    empresa: 'Acme Ltda',
    cidade: 'Joinville',
    ...campos,
  });
}

function criarCampanha({ jobId, segmento = true, variacoes = null } = {}) {
  seq += 1;
  const id = db.criarCampanhaMassaWa({
    nome: `Campanha ${seq}`,
    jobId,
    criterios: segmento ? { fonte: 'segmento', vagaAlvoId: jobId, cidade: 'Joinville', teto: 30 } : {},
    cadencia: { loteMin: 5, loteMax: 5, gapMinS: 0, gapMaxS: 0, pausaLoteMinS: 0, pausaLoteMaxS: 0, tetoDiario: 30 },
  });
  db.salvarVariacoesMassaWa(id, variacoes || (segmento ? VARIACOES_SEED_CONVITE : VARIACOES_SEED));
  db.definirStatusCampanhaMassaWa(id, 'ativa');
  return id;
}

let tel = 0;
function materializar(campanhaId, quantos, { jobId }) {
  const itens = [];
  for (let i = 0; i < quantos; i += 1) {
    tel += 1;
    const telefone = `55479995${String(70000 + tel).padStart(5, '0')}`;
    itens.push({ telefone, telefoneCanonico: `5547${telefone.slice(-8)}`, nome: `Pessoa ${i + 1}`, applicationId: null, jobId });
  }
  db.materializarCampanhaMassaWa(campanhaId, itens);
  return itens;
}

function dubles() {
  const enviados = [];
  const consultas = [];
  return {
    enviados,
    consultas,
    enviarTexto: async (telefone, texto) => { enviados.push({ telefone, texto }); },
    onWhatsAppLote: async (telefones) => { consultas.push(telefones); return new Map(telefones.map((t) => [t, true])); },
  };
}

async function rodar(d, extra = {}) {
  const { log, warn, error } = console;
  console.log = () => {};
  console.warn = () => {};
  console.error = () => {};
  try {
    return await worker.processarCicloMassaWa({
      db, agora: AGORA, mock: false, baileysLigado: true, socketConectado: true,
      dormir: async () => {}, aleatorio: () => 0, espacamentoGlobalMs: 0,
      enviarTexto: d.enviarTexto, onWhatsAppLote: d.onWhatsAppLote, ...extra,
    });
  } finally {
    console.log = log;
    console.warn = warn;
    console.error = error;
  }
}

const porStatus = (id) => Object.fromEntries(db.resumoCampanhaMassaWa(id).map((l) => [l.status, l.n]));
const erros = (id) => db.getDb().prepare('SELECT erro FROM campanhas_massa_wa_envios WHERE campanha_id = ? ORDER BY id').all(id).map((r) => r.erro);

function limpar({ segmentoLigado = true } = {}) {
  const conn = db.getDb();
  for (const t of ['campanhas_massa_wa_envios', 'campanhas_massa_wa_variacoes', 'campanhas_massa_wa',
    'whatsapp_sequencia_envios', 'applications', 'whatsapp_optout', 'whatsapp_opt_out', 'jobs']) {
    conn.exec(`DELETE FROM ${t}`);
  }
  db.definirConfigBool(worker.CHAVE_ATIVO, true);
  db.definirConfigBool(worker.CHAVE_SEGMENTO_ATIVO, segmentoLigado);
}

test.after(() => {
  for (const suf of ['', '-wal', '-shm']) fs.rmSync(`${process.env.DATABASE_PATH}${suf}`, { force: true });
});

// ══════════════════ KILL-SWITCH DO SEGMENTO ══════════════════

test('massa_wa_segmento_ativo AUSENTE = desligado: itens ficam pendentes, nada sai, nada e consultado', async () => {
  limpar();
  db.getDb().prepare('DELETE FROM configuracoes WHERE chave = ?').run(worker.CHAVE_SEGMENTO_ATIVO);
  assert.equal(worker.segmentoAtivo({ db }), false);
  const alvo = criarVaga();
  const id = criarCampanha({ jobId: alvo });
  materializar(id, 3, { jobId: alvo });
  const d = dubles();
  await rodar(d);
  assert.deepEqual(porStatus(id), { pendente: 3 });
  assert.equal(d.enviados.length, 0);
  assert.equal(d.consultas.length, 0);
});

test('segmento DESLIGADO nao toma a vez de uma campanha de vagas abertas (1 campanha por ciclo)', async () => {
  limpar({ segmentoLigado: false });
  const alvo = criarVaga();
  const seg = criarCampanha({ jobId: alvo }); // id MENOR: viria primeiro no ciclo
  materializar(seg, 2, { jobId: alvo });
  const comReuniao = criarVaga({
    link_meet: 'https://calendly.com/x', entrevista_grupo_1_data: '2026-10-01', entrevista_grupo_1_hora: '19:30',
  });
  const normal = criarCampanha({ jobId: comReuniao, segmento: false });
  materializar(normal, 2, { jobId: comReuniao });
  const d = dubles();
  await rodar(d);
  assert.deepEqual(porStatus(seg), { pendente: 2 });
  assert.deepEqual(porStatus(normal), { enviado: 2 });
});

test('worker.processarCampanha direto tambem respeita o interruptor do segmento', async () => {
  limpar({ segmentoLigado: false });
  const alvo = criarVaga();
  const id = criarCampanha({ jobId: alvo });
  materializar(id, 1, { jobId: alvo });
  assert.equal(typeof worker.processarCampanha, 'function');
  const d = dubles();
  await worker.processarCampanha(db.obterCampanhaMassaWa(id), {
    db, mock: false, agora: AGORA, aleatorio: () => 0, dormir: async () => {},
    enviar: d.enviarTexto, onWhatsAppLote: d.onWhatsAppLote, espacamentoMs: 0,
  });
  assert.equal(d.enviados.length, 0);
  assert.deepEqual(porStatus(id), { pendente: 1 });
});

// ══════════════════ O TEXTO ══════════════════

test('segmento LIGADO: o texto fala da VAGA-ALVO (nao da vaga do item), com cidade e link com UTM, sem exigir reuniao', async () => {
  limpar();
  const origem = criarVaga({ titulo: 'Vaga Antiga Encerrada', ativo: false });
  const alvo = criarVaga({ titulo: 'Vendedor Externo' }); // sem link_meet nem datas
  const id = criarCampanha({ jobId: alvo });
  materializar(id, 2, { jobId: origem });
  const d = dubles();
  await rodar(d);
  assert.deepEqual(porStatus(id), { enviado: 2 });
  for (const { texto } of d.enviados) {
    assert.match(texto, /Vendedor Externo/);
    assert.doesNotMatch(texto, /Vaga Antiga/);
    assert.match(texto, /Joinville/);
    assert.match(texto, new RegExp(`utm_source=massa-wa&utm_campaign=massa-${id}`));
    assert.match(texto, /descadastro-whatsapp\//);
    assert.doesNotMatch(texto, /\{[^}]+\}/);
  }
});

test('segmento com variacoes do tipo ENTREVISTA e pausado (validacao pelo tipo da fonte)', async () => {
  limpar();
  const alvo = criarVaga();
  const id = criarCampanha({ jobId: alvo, variacoes: VARIACOES_SEED });
  materializar(id, 1, { jobId: alvo });
  const d = dubles();
  await rodar(d);
  assert.equal(db.obterCampanhaMassaWa(id).status, 'pausada');
  assert.equal(d.enviados.length, 0);
});

// ══════════════════ GUARDAS ══════════════════

test('vaga-alvo FECHADA: o lote e cancelado com motivo, sem consultar nem enviar', async () => {
  limpar();
  const alvo = criarVaga();
  const id = criarCampanha({ jobId: alvo });
  materializar(id, 3, { jobId: alvo });
  db.getDb().prepare('UPDATE jobs SET ativo = 0 WHERE id = ?').run(alvo);
  const d = dubles();
  await rodar(d);
  assert.deepEqual(porStatus(id), { cancelado: 3 });
  assert.ok(erros(id).every((e) => e.startsWith('[vaga_alvo_fechada]')));
  assert.equal(d.enviados.length, 0);
  assert.equal(d.consultas.length, 0);
});

test('quem se candidatou a vaga-alvo DEPOIS de materializar e cancelado; os outros saem', async () => {
  limpar();
  const alvo = criarVaga();
  const id = criarCampanha({ jobId: alvo });
  const [p1] = materializar(id, 2, { jobId: alvo });
  // Candidatou-se com o numero SEM o 9: a chave canonica e a mesma.
  const semNove = `5547${p1.telefone.slice(-8)}`;
  db.getDb().prepare("INSERT INTO applications (job_id, nome, telefone) VALUES (?, 'x', ?)").run(alvo, semNove);
  const d = dubles();
  await rodar(d);
  assert.deepEqual(porStatus(id), { cancelado: 1, enviado: 1 });
  assert.ok(erros(id)[0].startsWith('[ja_candidatou_vaga_alvo]'));
  assert.equal(d.enviados.length, 1);
  assert.ok(!d.consultas.flat().includes(p1.telefone));
});

test('opt-out continua valendo no segmento', async () => {
  limpar();
  const alvo = criarVaga();
  const id = criarCampanha({ jobId: alvo });
  const [p1] = materializar(id, 2, { jobId: alvo });
  require('../src/lib/optoutWhatsapp').registrarOptout({ telefone: p1.telefone });
  const d = dubles();
  await rodar(d);
  assert.deepEqual(porStatus(id), { opt_out: 1, enviado: 1 });
});

test('fonte DESCONHECIDA nao envia', async () => {
  limpar();
  const alvo = criarVaga();
  const id = criarCampanha({ jobId: alvo, segmento: false });
  db.getDb().prepare("UPDATE campanhas_massa_wa SET criterios_json = '{\"fonte\":\"xyz\"}' WHERE id = ?").run(id);
  materializar(id, 1, { jobId: alvo });
  const d = dubles();
  await rodar(d);
  assert.deepEqual(porStatus(id), { pendente: 1 });
  assert.equal(d.enviados.length, 0);
});
