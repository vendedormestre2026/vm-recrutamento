'use strict';

// Func. 3, sub-commit 1: campo `recomendacao` no relatorio ("pre-aprovado pela IA").
//
// Cobre (tudo com MOCK — NENHUMA chamada real a DeepSeek/Resend/Groq/Google):
//   1. migracao: coluna reports.recomendacao existe; registro sem valor fica NULL;
//   2. parseAvaliacao: enum guard (valido -> string; invalido/ausente -> null, sem travar);
//   3. gerarRelatorio (LLM injetado): recomendacao valida persiste e aparece no e-mail;
//   4. gerarRelatorio: recomendacao invalida -> null, resto do relatorio salvo normalmente;
//   5. gerarRelatorio: JSON sem o campo -> null, relatorio completo;
//   6. render (e-mail e pagina) com recomendacao=null nao imprime undefined/[object Object].
//
// Isolamento: banco SQLite TEMPORARIO proprio (nunca data/app.db).

const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');

const TMP_DB = path.join(os.tmpdir(), `vm-test-recomendacao-${process.pid}-${Date.now()}.db`);
process.env.DATABASE_PATH = TMP_DB;
process.env.INTERVIEW_MOCK = 'true';
process.env.RECRUITER_EMAIL = 'recrutador@teste.local';
process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert/strict');

const db = require('../src/db');
const { semear } = require('../src/db/seed');
const {
  gerarRelatorio,
  parseAvaliacao,
  montarEmailHtml,
  badgeRecomendacaoHtml,
} = require('../src/lib/relatorio');
const { criarApp } = require('../src/server');

let vagaId;
let roteiroId;

// application + interview + turnos NOVOS (interview "virgem", sem report previo).
function novaInterview(sufixo) {
  const appId = db.criarAplicacao({
    job_id: vagaId,
    nome: 'Caso',
    sobrenome: sufixo,
    email: `caso-${sufixo}@teste.local`,
    token: `tok-app-${sufixo}`,
    status: 'concluido',
  });
  const iid = db.criarInterview({
    application_id: appId,
    perfil: 'SDR',
    roteiro_id: roteiroId,
    status: 'concluido',
  });
  db.criarTurno({ interview_id: iid, ordem: 1, autor: 'agente', texto: 'Pergunta (teste).' });
  db.criarTurno({ interview_id: iid, ordem: 2, autor: 'candidato', texto: 'Resposta (teste).' });
  return iid;
}

// deps com LLM injetado devolvendo um JSON de avaliacao arbitrario (caminho real de parse).
function depsComJson(jsonAvaliacao) {
  return {
    usarMockDeterministico: false,
    llm: {
      async completar() {
        return { texto: jsonAvaliacao };
      },
    },
    email: {
      async enviar() {
        /* sucesso silencioso: leva o report a status 'enviado' */
      },
    },
  };
}

function avaliacaoBase(extra) {
  return JSON.stringify({
    resumo: 'Resumo de teste.',
    pontuacoes: [{ competencia: 'Resiliência/volume', nota: 4, justificativa: 'ok', coberta: true }],
    pontos_fortes: ['comunicacao'],
    pontos_atencao: ['metricas'],
    ...extra,
  });
}

test.before(() => {
  const seeded = semear();
  roteiroId = seeded.roteiroId;
  vagaId = seeded.vagaId;
});

test.after(() => {
  for (const sufixo of ['', '-wal', '-shm']) {
    try {
      fs.rmSync(TMP_DB + sufixo, { force: true });
    } catch {
      /* ignore */
    }
  }
});

// ───────────────────────────── 1) Migracao ─────────────────────────────
test('migracao: coluna reports.recomendacao existe e registro sem valor fica NULL', () => {
  const col = db
    .getDb()
    .prepare("SELECT 1 AS ok FROM pragma_table_info('reports') WHERE name = 'recomendacao'")
    .get();
  assert.ok(col && col.ok === 1, 'coluna recomendacao deveria existir apos a migracao');

  // Report criado sem recomendacao (simula registro antigo) -> NULL, sem quebrar.
  const iid = novaInterview('migracao');
  const rid = db.criarReport({ interview_id: iid, token: 'tok-sem-rec', status: 'gerado' });
  const linha = db.getDb().prepare('SELECT recomendacao FROM reports WHERE id = ?').get(rid);
  assert.equal(linha.recomendacao, null);
});

// ───────────────────────── 2) parseAvaliacao (enum guard) ─────────────────────────
test('parseAvaliacao: recomendacao valida (mesmo com caixa/espacos) vira string minuscula', () => {
  const r = parseAvaliacao(avaliacaoBase({ recomendacao: '  Avancar ' }));
  assert.equal(r.recomendacao, 'avancar');
  assert.equal(r.pontuacoes.length, 1); // resto intacto
});

test('parseAvaliacao: recomendacao invalida -> null, sem travar o resto', () => {
  const r = parseAvaliacao(avaliacaoBase({ recomendacao: 'talvez_um_pouco' }));
  assert.equal(r.recomendacao, null);
  assert.equal(r.resumo, 'Resumo de teste.');
  assert.equal(r.pontuacoes.length, 1);
});

test('parseAvaliacao: sem o campo recomendacao (JSON antigo) -> null', () => {
  const r = parseAvaliacao(avaliacaoBase());
  assert.equal(r.recomendacao, null);
  assert.equal(r.pontuacoes.length, 1);
});

// ──────────────────── 3-5) gerarRelatorio (LLM injetado) ────────────────────
test('gerarRelatorio: recomendacao "avancar" persiste e aparece no e-mail', async () => {
  const iid = novaInterview('avancar');
  const report = await gerarRelatorio(iid, depsComJson(avaliacaoBase({ recomendacao: 'avancar' })));

  assert.equal(report.status, 'enviado');
  assert.equal(report.recomendacao, 'avancar');

  // Persistido de fato no banco.
  const naBase = db.getDb().prepare('SELECT recomendacao FROM reports WHERE id = ?').get(report.id);
  assert.equal(naBase.recomendacao, 'avancar');

  // Aparece no e-mail (rotulo "Avançar").
  const html = montarEmailHtml({
    candidato: { nome: 'Caso', sobrenome: 'avancar' },
    vaga: { titulo: 'Closer' },
    avaliacao: { resumo: 'r', pontuacoes: [], recomendacao: 'avancar' },
    token: 'tok',
    roteiro: null,
  });
  assert.match(html, /Recomendação da IA/);
  assert.match(html, /Avançar/);
});

test('gerarRelatorio: recomendacao invalida -> null, resto do relatorio salvo', async () => {
  const iid = novaInterview('invalida');
  const report = await gerarRelatorio(
    iid,
    depsComJson(avaliacaoBase({ recomendacao: 'super_avancar' })),
  );

  assert.equal(report.status, 'enviado'); // NAO travou a geracao
  assert.equal(report.recomendacao, null);
  assert.equal(report.resumo, 'Resumo de teste.'); // resto preservado
  assert.equal(report.pontuacoes.length, 1);
});

test('gerarRelatorio: JSON sem recomendacao -> null, relatorio completo', async () => {
  const iid = novaInterview('ausente');
  const report = await gerarRelatorio(iid, depsComJson(avaliacaoBase()));

  assert.equal(report.status, 'enviado');
  assert.equal(report.recomendacao, null);
  assert.equal(report.pontuacoes.length, 1);
});

// ──────────────── 6) Render com recomendacao=null nao quebra ────────────────
test('render null: badge vazio e sem undefined/[object Object] no e-mail e na pagina', async () => {
  // badge helper: null -> string vazia (nunca undefined).
  assert.equal(badgeRecomendacaoHtml(null), '');
  assert.equal(badgeRecomendacaoHtml('valor_qualquer'), '');

  // E-mail com recomendacao null: sem badge, sem lixo.
  const htmlEmail = montarEmailHtml({
    candidato: { nome: 'Caso', sobrenome: 'null' },
    vaga: { titulo: 'Closer' },
    avaliacao: { resumo: 'r', pontuacoes: [], recomendacao: null },
    token: 'tok',
    roteiro: null,
  });
  assert.ok(!/Recomendação da IA/.test(htmlEmail), 'sem secao de recomendacao quando null');
  assert.ok(!/undefined/.test(htmlEmail));
  assert.ok(!/\[object Object\]/.test(htmlEmail));

  // Pagina publica /relatorio/:token com um report de recomendacao NULL.
  const iid = novaInterview('render-null');
  const token = 'tok-render-null';
  db.criarReport({
    interview_id: iid,
    token,
    status: 'enviado',
    resumo: 'Resumo qualquer.',
    pontuacoes: [{ competencia: 'Qualificação', nota: 3, justificativa: 'ok', coberta: true }],
  });

  const app = criarApp();
  const server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const res = await fetch(`${base}/relatorio/${token}`);
    assert.equal(res.status, 200);
    const html = await res.text();
    assert.ok(!/Recomendação da IA/.test(html), 'pagina nao mostra badge quando null');
    assert.ok(!/undefined/.test(html));
    assert.ok(!/\[object Object\]/.test(html));
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

// ──────────── Pagina publica exibe a recomendacao quando presente ────────────
test('pagina /relatorio/:token exibe o badge quando ha recomendacao', async () => {
  const iid = novaInterview('pagina-avancar');
  const token = 'tok-pagina-avancar';
  db.criarReport({
    interview_id: iid,
    token,
    status: 'enviado',
    resumo: 'Resumo qualquer.',
    pontuacoes: [{ competencia: 'Qualificação', nota: 4, justificativa: 'ok', coberta: true }],
    recomendacao: 'avancar',
  });

  const app = criarApp();
  const server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const res = await fetch(`${base}/relatorio/${token}`);
    assert.equal(res.status, 200);
    const html = await res.text();
    assert.match(html, /Recomendação da IA/);
    assert.match(html, /Avançar/);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
