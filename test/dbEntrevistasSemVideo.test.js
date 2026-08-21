'use strict';

// db.listarEntrevistasConcluidasSemVideo + db.marcarAudioRemovido — backlog de audio de
// entrevistas CONCLUIDAS que nunca tiveram video confirmado no Drive (exclusao manual,
// GET/POST /admin/audio-entrevistas/apagar). Cobertura HTTP das rotas em
// test/adminAudioEntrevistasApagar.test.js; aqui e so a query + a marcacao.

const os = require('node:os');
const path = require('node:path');

process.env.DATABASE_PATH = path.join(os.tmpdir(), `vm-test-db-entrevistas-sem-video-${process.pid}-${Date.now()}.db`);
process.env.INTERVIEW_MOCK = 'true';
process.env.SESSION_SECRET = 'segredo-de-teste';
process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert/strict');

const db = require('../src/db');
const { migrar } = require('../src/db/migrate');

migrar();

const run = (sql, ...p) => Number(db.getDb().prepare(sql).run(...p).lastInsertRowid);

const jobId = run(
  "INSERT INTO jobs (slug, titulo, perfil, empresa, ativo) VALUES ('vaga-entrevistas-sem-video', 'Vaga Teste', 'CLOSER', 'Empresa Teste', 1)",
);

let seq = 0;
function criarInterview({ status, videoUrl = null, finalizadoEm = '2025-01-01 10:00:00', nome = 'Fulano' }) {
  seq += 1;
  const appId = run(
    "INSERT INTO applications (job_id, nome, sobrenome, email, telefone, token, status, criado_em) VALUES (?, ?, 'Teste', 'x@x.com', '+5511999998888', ?, 'aplicado', '2025-01-01 09:00:00')",
    jobId,
    nome,
    `tok-sv-${seq}`,
  );
  return run(
    "INSERT INTO interviews (application_id, perfil, status, video_url, finalizado_em) VALUES (?, 'CLOSER', ?, ?, ?)",
    appId,
    status,
    videoUrl,
    finalizadoEm,
  );
}

test('entrevista CONCLUIDA sem video: aparece na lista', () => {
  const id = criarInterview({ status: 'concluido', nome: 'ConcluidaSemVideo' });
  const lista = db.listarEntrevistasConcluidasSemVideo();
  assert.ok(lista.some((l) => l.interview_id === id));
});

test('entrevista CONCLUIDA COM video: nao aparece', () => {
  const id = criarInterview({ status: 'concluido', videoUrl: 'https://drive/x', nome: 'ConcluidaComVideo' });
  const lista = db.listarEntrevistasConcluidasSemVideo();
  assert.ok(!lista.some((l) => l.interview_id === id));
});

test('entrevista INICIADA (em andamento) sem video: nao aparece, mesmo sem video', () => {
  const id = criarInterview({ status: 'iniciada', finalizadoEm: null, nome: 'EmAndamento' });
  const lista = db.listarEntrevistasConcluidasSemVideo();
  assert.ok(!lista.some((l) => l.interview_id === id), 'entrevista em andamento nunca pode ser elegivel');
});

test('marcarAudioRemovido grava audio_removido_em com timestamp nao-nulo', () => {
  const id = criarInterview({ status: 'concluido', nome: 'ParaMarcar' });
  const antes = db.getDb().prepare('SELECT audio_removido_em FROM interviews WHERE id = ?').get(id);
  assert.equal(antes.audio_removido_em, null);

  db.marcarAudioRemovido(id);

  const depois = db.getDb().prepare('SELECT audio_removido_em FROM interviews WHERE id = ?').get(id);
  assert.ok(depois.audio_removido_em);
  assert.match(depois.audio_removido_em, /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
});

test('entrevista com audio_removido_em preenchido NAO reaparece na lista', () => {
  const id = criarInterview({ status: 'concluido', nome: 'JaProcessada' });
  db.marcarAudioRemovido(id);

  const lista = db.listarEntrevistasConcluidasSemVideo();
  assert.ok(!lista.some((l) => l.interview_id === id), 'ja processada nao pode aparecer de novo (senao a pre-visualizacao nunca esvazia)');
});

test('traz nome do candidato e titulo da vaga via JOIN', () => {
  const id = criarInterview({ status: 'concluido', nome: 'ComContexto' });
  const linha = db.listarEntrevistasConcluidasSemVideo().find((l) => l.interview_id === id);
  assert.ok(linha);
  assert.equal(linha.nome, 'ComContexto');
  assert.equal(linha.vaga_titulo, 'Vaga Teste');
});
