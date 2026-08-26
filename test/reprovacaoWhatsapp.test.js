'use strict';

// Etapa 'reprovacao' na fila Baileys (ETAPA B, Incremento B4): agendamento
// (lib/decisaoRecrutador.agendarMensagemReprovacao) + texto no momento do envio
// (whatsapp/sequenciaOutbox.textoDaEtapa -> lib/whatsappSequencia.montarTextoReprovacao).
//
// ── ZERO WHATSAPP REAL ── mesmo padrao de whatsappSequenciaOutbox.test.js: enviarTexto e
// sempre injetado, nenhum socket abre.

const os = require('node:os');
const path = require('node:path');

process.env.DATABASE_PATH = path.join(os.tmpdir(), `vm-test-reprovacao-wa-${process.pid}-${Date.now()}.db`);
process.env.INTERVIEW_MOCK = 'true';
process.env.SESSION_SECRET = 'segredo-de-teste';
process.env.WHATSAPP_SECRETS_KEY = 'f'.repeat(64);
process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert/strict');

const db = require('../src/db');
const { migrar } = require('../src/db/migrate');
const outbox = require('../src/whatsapp/sequenciaOutbox');
const decisaoRecrutador = require('../src/lib/decisaoRecrutador');
const { TEXTO_REPROVACAO_BASE_PLACEHOLDER, TEXTO_REPROVACAO_CONVITE_PLACEHOLDER } = require('../src/lib/whatsappSequencia');

migrar();

const run = (sql, ...p) => Number(db.getDb().prepare(sql).run(...p).lastInsertRowid);
const exec = (sql, ...p) => db.getDb().prepare(sql).run(...p);
const todas = (sql, ...p) => db.getDb().prepare(sql).all(...p);

let seq = 0;
function criarApplication({ cidade = null, telefone = '+55 (47) 99958-2500' } = {}) {
  seq += 1;
  const jobId = run(
    "INSERT INTO jobs (slug, titulo, perfil, cidade, ativo) VALUES (?, 'Vendedor Externo', 'CLOSER', ?, 1)",
    `vaga-reprovacao-${seq}`,
    cidade,
  );
  const id = run(
    'INSERT INTO applications (job_id, nome, telefone, token) VALUES (?, ?, ?, ?)',
    jobId,
    'Candidato Reprovacao',
    telefone,
    `tok-reprovacao-${seq}`,
  );
  return { id, jobId, telefone };
}

function zerar() {
  exec('DELETE FROM whatsapp_sequencia_envios');
  exec('DELETE FROM applications');
  exec('DELETE FROM jobs');
  exec('DELETE FROM regioes_grupos_whatsapp');
  db.definirConfigBool(outbox.CHAVE_ATIVO, false);
  db.definirConfigBool(decisaoRecrutador.CHAVE_ATIVO, false);
  delete process.env.WHATSAPP_BAILEYS_ATIVO;
}

function ligarTudo() {
  db.definirConfigBool(outbox.CHAVE_ATIVO, true);
  db.definirConfigBool(decisaoRecrutador.CHAVE_ATIVO, true);
  process.env.WHATSAPP_BAILEYS_ATIVO = 'true';
}

const fila = (appId) =>
  todas('SELECT * FROM whatsapp_sequencia_envios WHERE application_id = ? ORDER BY etapa', appId);

function comLogs(fn) {
  const { log, warn, error } = console;
  const linhas = [];
  const captura = (...a) => linhas.push(a.join(' '));
  console.log = console.warn = console.error = captura;
  try {
    const r = fn();
    return r && typeof r.then === 'function' ? r.then((v) => ({ r: v, linhas })) : { r, linhas };
  } finally {
    Object.assign(console, { log, warn, error });
  }
}

function envioDuble() {
  const chamadas = [];
  return { chamadas, fn: async (telefone, texto) => { chamadas.push({ telefone, texto }); return { key: { id: 'fake' } }; } };
}

const deps = (extra = {}) => ({ intervaloMs: 0, dormir: async () => {}, ...extra });

// ══════════════════ agendarMensagemReprovacao — kill-switch e idempotencia ══════════════════

test('kill-switch (automacao_reprovacao_whatsapp_ativa) desligado: nada agendado', () => {
  zerar(); // decisaoRecrutador.CHAVE_ATIVO fica false
  const app = criarApplication({ cidade: 'Joinville' });

  const r = decisaoRecrutador.agendarMensagemReprovacao(app.id);

  assert.equal(r.agendado, false);
  assert.match(r.motivo, /automacao_reprovacao_whatsapp_ativa desligado/);
  assert.deepEqual(fila(app.id), []);
});

test('kill-switch ligado: agenda etapa reprovacao, pendente, telefone normalizado', () => {
  zerar();
  db.definirConfigBool(decisaoRecrutador.CHAVE_ATIVO, true);
  const app = criarApplication({ cidade: 'Joinville' });

  const r = decisaoRecrutador.agendarMensagemReprovacao(app.id);

  assert.equal(r.agendado, true);
  const linhas = fila(app.id);
  assert.equal(linhas.length, 1);
  assert.equal(linhas[0].etapa, 'reprovacao');
  assert.equal(linhas[0].status, 'pendente');
  assert.equal(linhas[0].telefone_e164, '5547999582500');
});

test('idempotente: chamar duas vezes para a MESMA application nao duplica', () => {
  zerar();
  db.definirConfigBool(decisaoRecrutador.CHAVE_ATIVO, true);
  const app = criarApplication({ cidade: 'Joinville' });

  decisaoRecrutador.agendarMensagemReprovacao(app.id);
  const segunda = decisaoRecrutador.agendarMensagemReprovacao(app.id);

  assert.equal(segunda.agendado, false);
  assert.equal(fila(app.id).length, 1);
});

test('aplicarDecisaoRecrutador(id, "reprovado") aciona o agendamento de ponta a ponta', () => {
  zerar();
  db.definirConfigBool(decisaoRecrutador.CHAVE_ATIVO, true);
  const app = criarApplication({ cidade: 'Joinville' });

  decisaoRecrutador.aplicarDecisaoRecrutador(app.id, 'reprovado');

  assert.equal(fila(app.id).length, 1);
  assert.equal(fila(app.id)[0].etapa, 'reprovacao');
});

test("aplicarDecisaoRecrutador(id, 'aprovado') NAO agenda reprovacao nenhuma", () => {
  zerar();
  db.definirConfigBool(decisaoRecrutador.CHAVE_ATIVO, true);
  const app = criarApplication({ cidade: 'Joinville' });

  decisaoRecrutador.aplicarDecisaoRecrutador(app.id, 'aprovado');

  assert.deepEqual(fila(app.id), []);
});

// ══════════════════ textoDaEtapa('reprovacao') — corpo base + convite condicional ══════════════════

// Monta a `linha` no mesmo formato que listarPendentesSequenciaWhatsapp devolveria (so os
// campos que textoDaEtapa realmente le).
function linhaReprovacao({ jobCidade }) {
  return { etapa: 'reprovacao', app_nome: 'Candidato', job_cidade: jobCidade };
}

test('cidade COM link cadastrado: texto inclui corpo base + paragrafo de convite com o link', () => {
  zerar();
  db.criarRegiaoGrupo('Joinville', 'https://chat.whatsapp.com/exemplo-joinville');

  const texto = outbox.textoDaEtapa(linhaReprovacao({ jobCidade: 'Joinville' }), db);

  assert.match(texto, new RegExp(TEXTO_REPROVACAO_BASE_PLACEHOLDER.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.match(texto, /https:\/\/chat\.whatsapp\.com\/exemplo-joinville/);
  assert.doesNotMatch(texto, /\{\{link_grupo\}\}/, 'o placeholder {{link_grupo}} nao pode sobrar literal no texto');
});

test('cidade SEM link cadastrado (praca existe, link ainda NULL): so o corpo base, sem convite', () => {
  zerar();
  db.criarRegiaoGrupo('Curitiba', null); // praca cadastrada, sem link ainda — estado normal de toda praca nova

  const texto = outbox.textoDaEtapa(linhaReprovacao({ jobCidade: 'Curitiba' }), db);

  assert.match(texto, new RegExp(TEXTO_REPROVACAO_BASE_PLACEHOLDER.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.doesNotMatch(texto, /grupo de alertas/i, 'sem link, o paragrafo de convite nao pode aparecer');
});

test('vaga remota (job_cidade NULL): mesmo comportamento — so o corpo base', () => {
  zerar();

  const texto = outbox.textoDaEtapa(linhaReprovacao({ jobCidade: null }), db);

  assert.match(texto, new RegExp(TEXTO_REPROVACAO_BASE_PLACEHOLDER.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.doesNotMatch(texto, /grupo de alertas/i);
});

test('cidade sem NENHUMA linha em regioes_grupos_whatsapp: mesmo comportamento — so o corpo base (nao lanca)', () => {
  zerar();
  // Nenhum db.criarRegiaoGrupo pra 'Tijucas' — simula um estado de dados inconsistente
  // (cidade em jobs sem praca cadastrada). obterLinkGrupo devolve null pra praca inexistente
  // (mesmo contrato de praca inativa/sem link), entao o comportamento e IDENTICO aos dois
  // casos acima — nunca lanca, nunca inclui o convite.
  assert.doesNotThrow(() => outbox.textoDaEtapa(linhaReprovacao({ jobCidade: 'Tijucas' }), db));
  const texto = outbox.textoDaEtapa(linhaReprovacao({ jobCidade: 'Tijucas' }), db);
  assert.doesNotMatch(texto, /grupo de alertas/i);
});

// ══════════════════ Ponta a ponta: agendar -> ciclo -> texto realmente enviado ══════════════════

test('ciclo completo: agenda reprovacao pra vaga com link cadastrado e o texto enviado tem o convite', async () => {
  zerar();
  ligarTudo();
  db.criarRegiaoGrupo('Joinville', 'https://chat.whatsapp.com/exemplo-e2e');
  const app = criarApplication({ cidade: 'Joinville' });

  decisaoRecrutador.aplicarDecisaoRecrutador(app.id, 'reprovado');
  assert.equal(fila(app.id)[0].status, 'pendente');

  const envio = envioDuble();
  const { r } = await comLogs(() => outbox.processarCicloSequencia(deps({ mock: false, enviarTexto: envio.fn })));

  assert.equal(r.enviados, 1);
  assert.equal(envio.chamadas.length, 1);
  assert.match(envio.chamadas[0].texto, /https:\/\/chat\.whatsapp\.com\/exemplo-e2e/);
  assert.equal(fila(app.id)[0].status, 'enviado');
});

test('ciclo completo: link cadastrado DEPOIS do agendamento (entre a decisao e o envio) ja aparece na mensagem — resolvido no MOMENTO DO ENVIO', async () => {
  zerar();
  ligarTudo();
  db.criarRegiaoGrupo('Barueri', null); // sem link no momento em que o recrutador reprova
  const app = criarApplication({ cidade: 'Barueri' });

  decisaoRecrutador.aplicarDecisaoRecrutador(app.id, 'reprovado'); // agenda SEM link

  // Operador cadastra o link DEPOIS do agendamento, antes do proximo ciclo rodar.
  db.definirLinkGrupo('Barueri', 'https://chat.whatsapp.com/cadastrado-depois');

  const envio = envioDuble();
  await comLogs(() => outbox.processarCicloSequencia(deps({ mock: false, enviarTexto: envio.fn })));

  assert.match(envio.chamadas[0].texto, /https:\/\/chat\.whatsapp\.com\/cadastrado-depois/);
});
