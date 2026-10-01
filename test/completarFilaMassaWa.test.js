'use strict';

// Script de completar a fila de uma campanha de massa ja materializada (2026-10-01).
//
// Reproduz a campanha 6 em miniatura: a fila nasceu cortada pelo "ja recebeu" de uma campanha
// anterior cujos envios, depois, foram reclassificados como 'sem_destino'. Nada aqui envia
// mensagem nem abre socket.

const os = require('node:os');
const path = require('node:path');

process.env.DATABASE_PATH = path.join(os.tmpdir(), `vm-test-completar-fila-${process.pid}-${Date.now()}.db`);
process.env.INTERVIEW_MOCK = 'true';
process.env.SESSION_SECRET = 'segredo-de-teste';
process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert/strict');

const db = require('../src/db');
const { migrar } = require('../src/db/migrate');
const publico = require('../src/lib/publicoMassaWhatsapp');
const cadencia = require('../src/lib/cadenciaMassaWa');
const fuso = require('../src/lib/fusoBrasilia');
const { executar } = require('../src/scripts/completar-fila-massa-wa');

migrar();

const silencio = () => {};
// Quinta 01/10/2026 14h em Brasilia (fora dos dias da campanha: sexta e sabado).
const QUINTA = new Date(Date.UTC(2026, 9, 1, 17, 0));
const deps = (extra) => ({ db, publico, cadencia, fuso, agora: QUINTA, log: silencio, ...extra });

let seq = 0;
function limpar() {
  const conn = db.getDb();
  for (const t of ['campanhas_massa_wa_envios', 'campanhas_massa_wa_variacoes', 'campanhas_massa_wa',
    'applications', 'whatsapp_optout', 'whatsapp_opt_out', 'jobs']) conn.exec(`DELETE FROM ${t}`);
}

function candidatura(jobId, status = null) {
  seq += 1;
  const telefone = `4799${String(7000000 + seq).padStart(7, '0')}`;
  const id = Number(db.getDb()
    .prepare('INSERT INTO applications (job_id, nome, telefone, status_recrutador, criado_em) VALUES (?, ?, ?, ?, ?)')
    .run(jobId, `P${seq}`, telefone, status, `2026-09-${String(10 + (seq % 15)).padStart(2, '0')} 12:00:${String(seq % 60).padStart(2, '0')}`)
    .lastInsertRowid);
  return { id, telefone };
}

// c1 recebeu de verdade; c2..c4 'sem_destino'; c5, c6 nunca receberam; c7 reprovado; c8 opt-out.
function cenario() {
  limpar();
  seq += 1;
  const jobId = db.criarVaga({ slug: `vaga-completar-${seq}`, titulo: 'Closer', perfil: 'CLOSER', ativo: true });
  const c = Array.from({ length: 6 }, () => candidatura(jobId));
  const reprovado = candidatura(jobId, 'reprovado');
  const optout = candidatura(jobId);
  db.registrarWhatsappOptout({ telefone: optout.telefone, escopo: 'campanha', origem: 'manual' });

  const anterior = db.criarCampanhaMassaWa({ nome: 'Anterior' });
  db.materializarCampanhaMassaWa(anterior, publico.montarPublicoMassaWa({ jobId, excluirJaReceberam: false }).itens);
  const linhaDe = (camp, appId) => db.listarEnviosCampanhaMassaWa(camp).find((l) => l.application_id === appId);
  for (const x of c.slice(0, 4)) db.marcarEnvioMassaWaEnviado(linhaDe(anterior, x.id).id, {});

  // A campanha atual nasce como a 6: "ja recebeu" ligado, so c5 e c6 na fila.
  const atual = db.criarCampanhaMassaWa({
    nome: 'Atual', jobId, criterios: { statusList: ['sem_decisao', 'em_analise'] },
    cadencia: { tetoDiario: 42, horaInicio: '08:00', horaFim: '20:00', diasSemana: '5,6' },
  });
  db.materializarCampanhaMassaWa(atual, publico.montarPublicoMassaWa({ jobId }).itens);
  db.definirStatusCampanhaMassaWa(atual, 'ativa');
  assert.equal(db.listarEnviosCampanhaMassaWa(atual).length, 2);

  // A reclassificacao: c2..c4 nunca receberam.
  db.reclassificarEnviosMassaWaSemDestino(anterior, c.slice(1, 4).map((x) => x.id), 'teste', { commit: true });
  return { jobId, anterior, atual, c, reprovado, optout };
}

test('dry-run lista so quem falta e nao grava nada', () => {
  const { atual, c } = cenario();
  const r = executar(deps({ campanhaId: atual }));
  assert.equal(r.ok, true);
  assert.deepEqual(r.faltantes.map((f) => f.applicationId).sort(), c.slice(1, 4).map((x) => x.id).sort(),
    "so os 'sem_destino': nem quem recebeu, nem reprovado, nem opt-out");
  assert.equal(r.adicionados, 0);
  assert.equal(db.listarEnviosCampanhaMassaWa(atual).length, 2);
  assert.equal(db.obterCampanhaMassaWa(atual).criterios_json.includes('reconciliacoes'), false);
});

test('--commit grava so os faltantes, depois dos pendentes que ja estavam, e anota a origem', () => {
  const { atual, c } = cenario();
  const antes = db.listarPendentesCampanhaMassaWa(atual, { limite: 50 }).map((l) => l.id);
  const r = executar(deps({ campanhaId: atual, commit: true, motivo: 'sem destino voltam' }));
  assert.equal(r.adicionados, 3);

  const fila = db.listarPendentesCampanhaMassaWa(atual, { limite: 50 });
  assert.deepEqual(fila.slice(0, 2).map((l) => l.id), antes, 'os que ja estavam saem primeiro');
  assert.ok(fila.slice(2).every((l) => l.id > Math.max(...antes)));

  const campanha = db.obterCampanhaMassaWa(atual);
  assert.equal(campanha.status, 'ativa', 'status da campanha nao muda');
  assert.equal(campanha.total_estimado, 5);
  const rec = JSON.parse(campanha.criterios_json).reconciliacoes;
  assert.equal(rec.length, 1);
  assert.equal(rec[0].origem, 'reconciliacao');
  assert.equal(rec[0].motivo, 'sem destino voltam');
  assert.equal(rec[0].adicionados, 3);
  assert.deepEqual(rec[0].applicationIds.sort(), c.slice(1, 4).map((x) => x.id).sort());
  assert.deepEqual(rec[0].envioIds, fila.slice(2).map((l) => l.id));
  assert.equal(rec[0].em, '2026-10-01 17:00:00');
});

test('segunda execucao e idempotente: 0 adicionados, nenhuma reconciliacao nova', () => {
  const { atual } = cenario();
  executar(deps({ campanhaId: atual, commit: true }));
  const r = executar(deps({ campanhaId: atual, commit: true }));
  assert.equal(r.faltantes.length, 0);
  assert.equal(r.adicionados, 0);
  assert.equal(JSON.parse(db.obterCampanhaMassaWa(atual).criterios_json).reconciliacoes.length, 1);
  assert.equal(db.listarEnviosCampanhaMassaWa(atual).length, 5);
});

test('o cronograma do dry-run cobre os pendentes de depois (os de antes + os faltantes)', () => {
  const { atual } = cenario();
  const r = executar(deps({ campanhaId: atual }));
  assert.equal(r.pendentesDepois, 5);
  assert.deepEqual(r.cronograma.dias, [{ data: '2026-10-02', diaSemanaIso: 5, quantidade: 5 }]);
});

test('recusa campanha encerrada e campanha materializada com limite', () => {
  const { atual } = cenario();
  db.getDb().prepare('UPDATE campanhas_massa_wa SET criterios_json = ? WHERE id = ?')
    .run(JSON.stringify({ statusList: ['sem_decisao'], materializacao: { limite: 2 } }), atual);
  const comLimite = executar(deps({ campanhaId: atual, commit: true }));
  assert.equal(comLimite.ok, false);
  assert.match(comLimite.motivo, /limite/);

  db.excluirCampanhaMassaWa(atual);
  const excluida = executar(deps({ campanhaId: atual, commit: true }));
  assert.equal(excluida.ok, false);
  assert.equal(db.listarEnviosCampanhaMassaWa(atual).filter((l) => l.status !== 'cancelado').length, 0);
});
