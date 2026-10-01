'use strict';

// Status 'sem_destino' na fila do disparo em massa (2026-10-01).
//
// 47 envios da campanha 3 sairam do nosso lado sem aparelho do outro (nono digito, antes do commit
// 91196f4) e sao reclassificados de 'enviado' para 'sem_destino'. Este arquivo guarda o que a
// varredura de todo leitor de status da fila exigiu: 'sem_destino' nao conta como enviado em
// nenhuma metrica, nao volta para o worker, tem rotulo legivel e devolve a pessoa ao publico.

const os = require('node:os');
const path = require('node:path');

process.env.DATABASE_PATH = path.join(os.tmpdir(), `vm-test-massa-sem-destino-${process.pid}-${Date.now()}.db`);
process.env.INTERVIEW_MOCK = 'true';
process.env.SESSION_SECRET = 'segredo-de-teste';
process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert/strict');

const db = require('../src/db');
const { migrar } = require('../src/db/migrate');
const { ROTULO_ENVIO } = require('../src/routes/admin_massa_wa');

migrar();

let seq = 0;
function item(n) {
  return { telefone: `55479995826${String(n).padStart(2, '0')}`, telefoneCanonico: `55479995826${String(n).padStart(2, '0')}`, nome: `P${n}` };
}

// Campanha com dois envios: um fica 'enviado', o outro vira 'sem_destino' (por SQL direto, como
// a reclassificacao faria — o worker nunca produz este status).
function campanhaComSemDestino() {
  seq += 1;
  const id = db.criarCampanhaMassaWa({ nome: `C${seq}` });
  db.definirStatusCampanhaMassaWa(id, 'ativa');
  db.materializarCampanhaMassaWa(id, [item(seq * 2), item(seq * 2 + 1)]);
  const [a, b] = db.listarPendentesCampanhaMassaWa(id, { limite: 10 });
  db.marcarEnvioMassaWaEnviado(a.id, { variacaoIndice: 1, quando: '2026-09-29 16:54:36' });
  db.marcarEnvioMassaWaEnviado(b.id, { variacaoIndice: 2, quando: '2026-09-29 16:54:36' });
  db.getDb().prepare("UPDATE campanhas_massa_wa_envios SET status = 'sem_destino' WHERE id = ?").run(b.id);
  return { id, enviado: a, semDestino: b };
}

test('sem_destino nao volta para o worker e nenhum marcar* o toca', () => {
  const { id, semDestino } = campanhaComSemDestino();
  assert.equal(db.listarPendentesCampanhaMassaWa(id, { limite: 50 }).length, 0);
  assert.equal(db.marcarEnvioMassaWaEnviado(semDestino.id, {}), 0);
  assert.equal(db.marcarEnvioMassaWaTerminal(semDestino.id, 'falha', 'x'), 0);
  assert.equal(db.registrarTentativaEnvioMassaWa(semDestino.id, 'x'), 0);
  assert.equal(db.excluirCampanhaMassaWa(id), 0, 'excluir cancela so pendente');
});

test('sem_destino nao conta como enviado: teto diario, distribuicao e "ja recebeu"', () => {
  const { id, enviado, semDestino } = campanhaComSemDestino();
  assert.equal(db.contarEnviosMassaWaDesde(id, '2026-09-29 00:00:00'), 1);
  assert.deepEqual(db.distribuicaoVariacoesMassaWa(id).map((d) => d.variacao_indice), [1]);

  const recebedores = db.recebedoresDisparoMassaWa();
  assert.equal(recebedores.get(enviado.telefone_canonico), id);
  assert.ok(!recebedores.has(semDestino.telefone_canonico), 'quem nao recebeu volta ao publico');
  assert.ok(!db.telefonesComDisparoMassaWaEnviado().has(semDestino.telefone_canonico));
});

test('resumo da campanha mostra sem_destino separado, e o painel tem rotulo legivel', () => {
  const { id } = campanhaComSemDestino();
  const resumo = Object.fromEntries(db.resumoCampanhaMassaWa(id).map((l) => [l.status, l.n]));
  assert.deepEqual(resumo, { enviado: 1, sem_destino: 1 });
  assert.equal(ROTULO_ENVIO.sem_destino, 'Sem destino');
});

test('recebedoresDisparoMassaWa guarda a PRIMEIRA campanha em que a pessoa recebeu', () => {
  seq += 1;
  const a = db.criarCampanhaMassaWa({ nome: `A${seq}` });
  const b = db.criarCampanhaMassaWa({ nome: `B${seq}` });
  const mesmo = item(90);
  for (const c of [a, b]) {
    db.materializarCampanhaMassaWa(c, [mesmo]);
    const linha = db.getDb().prepare('SELECT id FROM campanhas_massa_wa_envios WHERE campanha_id = ?').get(c);
    db.marcarEnvioMassaWaEnviado(linha.id, {});
  }
  assert.equal(db.recebedoresDisparoMassaWa().get(mesmo.telefoneCanonico), a);
});
