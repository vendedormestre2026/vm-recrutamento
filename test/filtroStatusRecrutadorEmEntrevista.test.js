'use strict';

// Filtro "Status Recrutador" ganha a opcao 'em_entrevista' (ETAPA B): consulta
// applications.status = 'em_entrevista' (estagio automatico do funil), NAO uma coluna
// nova nem um valor gravavel em status_recrutador. E o sentinela 'sem_decisao' passa a
// EXCLUIR quem esta em entrevista — antes misturava "ainda nem terminou" com "terminou e
// ninguem avaliou" no mesmo balde.
//
// Testado na camada de dados (listarAplicacoesComContexto -> condicoesFiltroCandidatos),
// mesmo padrao de test/busca-candidatos.test.js: mais rapido que HTTP e e exatamente onde
// a logica do filtro vive.

const os = require('node:os');
const path = require('node:path');

process.env.DATABASE_PATH = path.join(os.tmpdir(), `vm-test-filtro-em-entrevista-${process.pid}-${Date.now()}.db`);
process.env.INTERVIEW_MOCK = 'true';
process.env.SESSION_SECRET = 'segredo-de-teste';
process.env.ADMIN_USER = 'admin-teste';
process.env.ADMIN_PASSWORD = 'senha-teste';
process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert/strict');

const db = require('../src/db');
const { migrar } = require('../src/db/migrate');

migrar();

function run(sql, ...params) {
  return Number(db.getDb().prepare(sql).run(...params).lastInsertRowid);
}

const jobId = run(
  "INSERT INTO jobs (slug, titulo, perfil, ativo) VALUES ('vaga-filtro-status-rec', 'Closer', 'CLOSER', 1)",
);

let seq = 0;
function aplicacao({ nome, status, statusRecrutador = null }) {
  seq += 1;
  return run(
    `INSERT INTO applications (job_id, nome, sobrenome, status, status_recrutador, token)
     VALUES (?, ?, 'Teste', ?, ?, ?)`,
    jobId,
    nome,
    status,
    statusRecrutador,
    `tok-filtro-status-rec-${seq}`,
  );
}

// aplicado, sem decisao: nem comecou a entrevista.
aplicacao({ nome: 'Ainda Nao Comecou', status: 'aplicado' });
// em_entrevista, sem decisao: o caso que o filtro novo precisa achar.
aplicacao({ nome: 'Em Andamento', status: 'em_entrevista' });
// concluido, sem decisao: terminou, esperando avaliacao.
aplicacao({ nome: 'Terminou Sem Decisao', status: 'concluido' });
// concluido, aprovado.
aplicacao({ nome: 'Aprovada', status: 'concluido', statusRecrutador: 'aprovado' });
// concluido, reprovado.
aplicacao({ nome: 'Reprovado', status: 'concluido', statusRecrutador: 'reprovado' });
// em_entrevista, MAS ja com uma decisao registrada (caso raro/edge: reentrevista com
// decisao antiga ainda gravada) — tem que aparecer em 'em_entrevista' do mesmo jeito,
// porque o filtro olha status, nao status_recrutador.
aplicacao({ nome: 'Reentrevista Com Decisao Antiga', status: 'em_entrevista', statusRecrutador: 'em_analise' });

function nomesDoFiltro(statusRecrutador) {
  return db
    .listarAplicacoesComContexto({ statusRecrutador })
    .map((c) => c.nome)
    .sort();
}

test("filtro 'em_entrevista': so quem tem applications.status = 'em_entrevista', independente de status_recrutador", () => {
  assert.deepEqual(nomesDoFiltro('em_entrevista'), ['Em Andamento', 'Reentrevista Com Decisao Antiga']);
});

test("filtro 'sem_decisao': ja NAO inclui quem esta em entrevista (so quem pode ser avaliado e ainda nao foi)", () => {
  const nomes = nomesDoFiltro('sem_decisao');
  assert.deepEqual(nomes, ['Ainda Nao Comecou', 'Terminou Sem Decisao']);
  assert.ok(!nomes.includes('Em Andamento'), "'Em Andamento' (em_entrevista) nao pode aparecer em Sem decisao");
});

test("os tres filtros de decisao (aprovado/reprovado/em_analise) continuam intocados", () => {
  assert.deepEqual(nomesDoFiltro('aprovado'), ['Aprovada']);
  assert.deepEqual(nomesDoFiltro('reprovado'), ['Reprovado']);
  assert.deepEqual(nomesDoFiltro('em_analise'), ['Reentrevista Com Decisao Antiga']);
});

test('sem filtro de status_recrutador: todo mundo aparece, filtro inativo como sempre', () => {
  assert.equal(nomesDoFiltro(undefined).length, 6);
  assert.equal(nomesDoFiltro('').length, 6);
});
