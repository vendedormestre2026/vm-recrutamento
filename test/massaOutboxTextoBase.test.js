'use strict';

// Worker do disparo em massa x texto-base da campanha (2026-10-14).
//
// A campanha 9 tinha um texto-base de LEMBRETE e enviou as sementes do CONVITE: 46 pessoas
// receberam "confirme presenca" com o Calendly no lugar de "a entrevista e daqui a pouco, a sala e
// esta". Aqui o worker prova, no envio, que (1) o que sai e uma redacao do texto-base, com a linha
// de descadastro do sistema uma vez, e (2) variacoes que nao sao do texto-base, com erro de geracao
// ou desatualizadas PAUSAM a campanha sem mandar nada.

const os = require('node:os');
const path = require('node:path');

process.env.DATABASE_PATH = path.join(os.tmpdir(), `vm-test-massa-outbox-texto-base-${process.pid}-${Date.now()}.db`);
process.env.INTERVIEW_MOCK = 'true';
process.env.SESSION_SECRET = 'segredo-de-teste';
process.env.OPTOUT_TOKEN_SECRET = 'segredo-hmac-de-teste';
process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert/strict');

const db = require('../src/db');
const { migrar } = require('../src/db/migrate');
const worker = require('../src/whatsapp/massaOutbox');
const v = require('../src/lib/variacoesMassaWa');
const { BASE_LEMBRETE, REDACOES_LEMBRETE, URL_SALA } = require('./fixtures/variacoesLembreteMassaWa');

migrar();

const AGORA = new Date(Date.UTC(2026, 9, 1, 13, 0)); // 10:00 em Brasilia
let seq = 0;

function criarVaga() {
  seq += 1;
  return db.criarVaga({
    slug: `vaga-outbox-texto-base-${seq}`, titulo: 'Closer de Vendas', perfil: 'CLOSER', empresa: 'Acme Ltda',
    link_meet: 'https://calendly.com/vm/x', entrevista_grupo_1_data: '2026-10-01', entrevista_grupo_1_hora: '14:00',
  });
}

function criarCampanha(jobId, { textoBase = BASE_LEMBRETE, variacoes = REDACOES_LEMBRETE } = {}) {
  seq += 1;
  const id = db.criarCampanhaMassaWa({
    nome: `Lembrete ${seq}`, jobId, textoBase,
    cadencia: { loteMin: 3, loteMax: 3, gapMinS: 0, gapMaxS: 0, pausaLoteMinS: 0, pausaLoteMaxS: 0, tetoDiario: 30 },
  });
  db.salvarVariacoesMassaWa(id, [...variacoes]);
  const itens = [1, 2, 3].map((i) => {
    seq += 1;
    const telefone = `55479995${String(70000 + seq).padStart(5, '0')}`;
    return { telefone, telefoneCanonico: `5547${telefone.slice(-8)}`, nome: `Maria ${i}`, applicationId: null, jobId };
  });
  db.materializarCampanhaMassaWa(id, itens);
  db.definirStatusCampanhaMassaWa(id, 'ativa');
  return id;
}

async function rodar() {
  const enviados = [];
  const { log, warn, error } = console;
  console.log = () => {}; console.warn = () => {}; console.error = () => {};
  try {
    await worker.processarCicloMassaWa({
      db, agora: AGORA, mock: false, baileysLigado: true, socketConectado: true,
      dormir: async () => {}, aleatorio: () => 0, espacamentoGlobalMs: 0,
      onWhatsAppLote: async (tels) => new Map(tels.map((t) => [t, true])),
      enviarTexto: async (telefone, texto) => { enviados.push({ telefone, texto }); },
    });
  } finally {
    console.log = log; console.warn = warn; console.error = error;
  }
  return enviados;
}

function limpar() {
  const conn = db.getDb();
  for (const t of ['campanhas_massa_wa_envios', 'campanhas_massa_wa_variacoes', 'campanhas_massa_wa', 'whatsapp_sequencia_envios', 'applications', 'jobs']) {
    conn.exec(`DELETE FROM ${t}`);
  }
  db.definirConfigBool(worker.CHAVE_ATIVO, true);
}

// ══════════════════ REGRESSAO DO BUG ══════════════════

test('regressao campanha 9: o que sai e o LEMBRETE do texto-base, com a sala e a linha de descadastro uma vez', async () => {
  limpar();
  const id = criarCampanha(criarVaga());
  const enviados = await rodar();
  assert.equal(enviados.length, 3);
  for (const { texto } of enviados) {
    assert.ok(texto.includes(URL_SALA), 'a sala do texto-base');
    assert.match(texto, /14h/);
    assert.match(texto, /^Olá, Maria!/);
    assert.ok(!/Confirme|confirmar presença|calendly/i.test(texto), 'nada do convite padrao');
    assert.doesNotMatch(texto, /[{}]/, 'nenhum token sobrando');
    const linhas = texto.split('Para não receber mais mensagens nossas, acesse: https://');
    assert.equal(linhas.length - 1, 1, 'a linha do sistema, uma vez');
    assert.ok(texto.trimEnd().split('\n').pop().includes('/descadastro-whatsapp/'), 'no fim da mensagem');
  }
  assert.equal(db.obterCampanhaMassaWa(id).status, 'ativa');
});

test('regressao campanha 9: variacoes que sao as SEMENTES do convite num texto-base de lembrete PAUSAM, sem enviar', async () => {
  limpar();
  const id = criarCampanha(criarVaga(), { variacoes: v.VARIACOES_SEED });
  const enviados = await rodar();
  assert.equal(enviados.length, 0);
  const c = db.obterCampanhaMassaWa(id);
  assert.equal(c.status, 'pausada');
  assert.equal(c.pausada_motivo, worker.MOTIVO_VARIACOES_INVALIDAS);
});

// ══════════════════ TRAVAS NOVAS ══════════════════

test('erro de geracao registrado: o worker pausa com motivo proprio e nada sai', async () => {
  limpar();
  const id = criarCampanha(criarVaga());
  db.registrarErroVariacoesMassaWa(id, 'A IA não gerou 7 variações válidas');
  assert.equal((await rodar()).length, 0);
  const c = db.obterCampanhaMassaWa(id);
  assert.equal(c.status, 'pausada');
  assert.equal(c.pausada_motivo, worker.MOTIVO_VARIACOES_COM_ERRO);
});

test('texto-base editado com a campanha ATIVA: o worker pausa (desatualizadas) e nada sai', async () => {
  limpar();
  const id = criarCampanha(criarVaga());
  const c0 = db.obterCampanhaMassaWa(id);
  db.atualizarCampanhaMassaWa(id, { nome: c0.nome, jobId: c0.job_id, textoBase: `${BASE_LEMBRETE}\nAté já!`, criterios: {} });
  assert.equal((await rodar()).length, 0);
  const c = db.obterCampanhaMassaWa(id);
  assert.equal(c.status, 'pausada');
  assert.equal(c.pausada_motivo, worker.MOTIVO_VARIACOES_DESATUALIZADAS);
});

test('campanha anterior ao carimbo (hash NULL) conta como desatualizada e nao envia', async () => {
  limpar();
  const id = criarCampanha(criarVaga());
  db.getDb().prepare('UPDATE campanhas_massa_wa SET variacoes_base_hash = NULL WHERE id = ?').run(id);
  assert.equal((await rodar()).length, 0);
  assert.equal(db.obterCampanhaMassaWa(id).pausada_motivo, worker.MOTIVO_VARIACOES_DESATUALIZADAS);
});

test('campanha do texto-base PADRAO com as sementes continua enviando (nada muda para ela)', async () => {
  limpar();
  const id = criarCampanha(criarVaga(), { textoBase: v.TEXTO_BASE_PADRAO, variacoes: v.VARIACOES_SEED });
  const enviados = await rodar();
  assert.equal(enviados.length, 3);
  for (const { texto } of enviados) {
    assert.equal(texto.split('/descadastro-whatsapp/').length - 1, 1, 'a semente ja tem o link: nada acrescentado');
    assert.ok(!texto.includes('Para não receber mais mensagens nossas'), 'a frase do sistema nao entra');
  }
  assert.equal(db.obterCampanhaMassaWa(id).status, 'ativa');
});

// ══════════════════ PARAGRAFOS (2026-10-19) ══════════════════

test('regressao campanha 10: variacoes achatadas numa linha so PAUSAM, sem enviar', async () => {
  limpar();
  const id = criarCampanha(criarVaga(), { variacoes: REDACOES_LEMBRETE.map((t) => t.replace(/\s*\n+\s*/g, ' ')) });
  const enviados = await rodar();
  assert.equal(enviados.length, 0);
  const c = db.obterCampanhaMassaWa(id);
  assert.equal(c.status, 'pausada');
  assert.equal(c.pausada_motivo, worker.MOTIVO_VARIACOES_INVALIDAS);
});

test('o texto que sai preserva as quebras de linha e o *negrito* da variacao', async () => {
  limpar();
  criarCampanha(criarVaga());
  const enviados = await rodar();
  assert.ok(enviados.length > 0);
  for (const { texto } of enviados) {
    assert.ok(v.contarQuebras(texto) >= v.minimoDeQuebras(BASE_LEMBRETE), 'quebras preservadas');
    assert.match(texto, /\n\n/);
    assert.match(texto, /\*[^*\n]+\*/);
  }
});
