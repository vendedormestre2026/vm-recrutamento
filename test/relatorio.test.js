'use strict';

// ETAPA G — testes com mocks (sem NENHUMA chamada real a DeepSeek/Resend/Groq/Google).
//
// Cobre:
//   1. geracao de relatorio em modo mock (incluindo o campo `coberta`);
//   2. idempotencia de gerarRelatorio;
//   3. a rota GET /relatorio/:token nos quatro cenarios validados manualmente
//      (completo, pendente, erro, token invalido).
//
// Isolamento: usa um banco SQLite TEMPORARIO proprio (nunca data/app.db). As envs
// abaixo DEVEM ser definidas antes de qualquer require que carregue ../src/config,
// pois o config le DATABASE_PATH/INTERVIEW_MOCK/RECRUITER_EMAIL no momento do load.

const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');

const TMP_DB = path.join(os.tmpdir(), `vm-test-relatorio-${process.pid}-${Date.now()}.db`);
process.env.DATABASE_PATH = TMP_DB;
process.env.INTERVIEW_MOCK = 'true';
process.env.RECRUITER_EMAIL = 'recrutador@teste.local';
process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert/strict');

const db = require('../src/db');
const { semear, ROTEIRO_SDR } = require('../src/db/seed');
const { gerarRelatorio } = require('../src/lib/relatorio');
const { normalizarEstrutura } = require('../src/lib/entrevista');
const { criarApp } = require('../src/server');

// Estado compartilhado, montado no before().
let interviewId;
let reportCompleto; // resultado do gerarRelatorio (status 'enviado')
let vagaId;
let roteiroId;

// Cria uma aplicacao + entrevista + turnos NOVAS (sem report previo), para os
// testes de caminho de falha que precisam de uma interview "virgem" (a idempotencia
// retornaria cedo se a interview ja tivesse um report 'enviado').
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

// Deps que FALHAM se chamadas: em modo mock, LLM e e-mail nunca devem ser tocados.
function depsSemRede() {
  return {
    usarMockDeterministico: true,
    llm: {
      completar() {
        throw new Error('LLM NAO deveria ser chamado em modo mock');
      },
    },
    email: {
      enviar() {
        throw new Error('Email NAO deveria ser enviado em modo mock');
      },
    },
  };
}

test.before(() => {
  // schema + roteiro/vaga (semear roda migrar() internamente)
  const seeded = semear();
  roteiroId = seeded.roteiroId;
  vagaId = seeded.vagaId;

  const appId = db.criarAplicacao({
    job_id: vagaId,
    nome: 'Fulano',
    sobrenome: 'de Teste',
    email: 'candidato@teste.local',
    token: 'tok-app-teste',
    status: 'concluido',
  });
  interviewId = db.criarInterview({
    application_id: appId,
    perfil: 'SDR',
    roteiro_id: roteiroId,
    status: 'concluido',
  });
  db.criarTurno({ interview_id: interviewId, ordem: 1, autor: 'agente', texto: 'Pergunta (teste).' });
  db.criarTurno({
    interview_id: interviewId,
    ordem: 2,
    autor: 'candidato',
    texto: 'Resposta (teste).',
  });
});

test.after(() => {
  // remove o banco temporario e seus arquivos auxiliares (-wal/-shm)
  for (const sufixo of ['', '-wal', '-shm']) {
    try {
      fs.rmSync(TMP_DB + sufixo, { force: true });
    } catch {
      /* ignore */
    }
  }
});

test('gerarRelatorio (mock): avaliacao deterministica, campo coberta, sem tocar em rede', async () => {
  reportCompleto = await gerarRelatorio(interviewId, depsSemRede());

  // RECRUITER_EMAIL definido + mock apenas loga o e-mail -> status final 'enviado'.
  assert.equal(reportCompleto.status, 'enviado');

  // Redesenho comportamental: as competencias voltaram para dentro de `blocos` e a do
  // roleplay e derivada. A fonte de verdade passa a ser normalizarEstrutura (a mesma que
  // relatorio.js consome), em vez de ler a estrutura crua.
  const comps = normalizarEstrutura(ROTEIRO_SDR).competencias;
  assert.equal(reportCompleto.pontuacoes.length, comps.length);

  // Nomes preservam a acentuacao do roteiro (regressao da correcao de acentos).
  assert.deepEqual(
    reportCompleto.pontuacoes.map((p) => p.competencia),
    comps.map((c) => c.nome),
  );

  // coberta: todas true menos a ULTIMA (exercita o caminho coberta=false).
  assert.deepEqual(
    reportCompleto.pontuacoes.map((p) => p.coberta),
    comps.map((_, i) => i < comps.length - 1),
  );
  assert.equal(reportCompleto.pontuacoes.at(-1).coberta, false);
  // Item 7.6 (formato Victoria): mock usa NIVEL (alta/baixa) no lugar de nota numerica —
  // 'alta' para as cobertas, 'baixa' para a ultima (nao coberta).
  assert.equal(reportCompleto.pontuacoes.at(-1).nivel, 'baixa');
  assert.equal(reportCompleto.pontuacoes[0].nivel, 'alta');
});

test('gerarRelatorio: idempotente — segunda chamada nao gera novo report', async () => {
  const segundo = await gerarRelatorio(interviewId, depsSemRede());
  // Mesmo report (mesmo id e token): nada novo foi gerado.
  assert.equal(segundo.id, reportCompleto.id);
  assert.equal(segundo.token, reportCompleto.token);
});

test('gerarRelatorio: falha no envio de e-mail -> report gravado com status "erro" (sem propagar)', async () => {
  const iid = novaInterview('email-erro');

  // LLM mock devolve um JSON de avaliacao valido; o e-mail (injetado) rejeita.
  const avaliacaoValida = JSON.stringify({
    resumo: 'Avaliacao de teste.',
    pontuacoes: [
      { competencia: 'Resiliência/volume', nota: 4, justificativa: 'boa', coberta: true },
    ],
    pontos_fortes: ['comunicacao'],
    pontos_atencao: ['metricas'],
  });

  let emailTentado = false;
  const deps = {
    // override LOCAL da chamada (nao e a env INTERVIEW_MOCK): false = caminho real
    // (parse + criarReport + envio), exercitado aqui com fakes injetados.
    usarMockDeterministico: false,
    llm: {
      async completar() {
        return { texto: avaliacaoValida };
      },
    },
    email: {
      async enviar() {
        emailTentado = true;
        throw new Error('Resend indisponivel (simulado)');
      },
    },
  };

  // NAO deve propagar: a funcao engole a falha de envio e marca o report.
  const report = await gerarRelatorio(iid, deps);

  assert.equal(emailTentado, true);
  assert.equal(report.status, 'erro');

  // Gravado de fato no banco com status 'erro' (re-consulta pela camada de dados).
  const naBase = db.obterReportPorToken(report.token);
  assert.ok(naBase, 'report deveria existir no banco');
  assert.equal(naBase.status, 'erro');
  // O conteudo da avaliacao foi preservado mesmo com a falha de envio.
  assert.equal(naBase.resumo, 'Avaliacao de teste.');
});

test('gerarRelatorio: JSON de avaliacao invalido -> lanca erro e NAO grava report', async () => {
  const iid = novaInterview('json-invalido');

  const deps = {
    usarMockDeterministico: false,
    llm: {
      async completar() {
        return { texto: 'desculpe, nao consegui avaliar agora.' }; // nao-parseavel
      },
    },
    email: {
      async enviar() {
        throw new Error('e-mail NAO deveria ser tentado quando o parse falha');
      },
    },
  };

  await assert.rejects(() => gerarRelatorio(iid, deps), /JSON|pontuacoes/i);

  // Nenhum report deve ter sido gravado para esta interview (consulta direta).
  const n = db
    .getDb()
    .prepare('SELECT COUNT(*) AS n FROM reports WHERE interview_id = ?')
    .get(iid).n;
  assert.equal(n, 0);
});

test('GET /relatorio/:token — quatro cenarios', async (t) => {
  const app = criarApp();
  const server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;

  // Cenarios pendente e erro: criados direto na camada de dados, com tokens proprios.
  db.criarReport({ interview_id: interviewId, token: 'tok-pendente', status: 'pendente' });
  db.criarReport({
    interview_id: interviewId,
    token: 'tok-erro',
    status: 'erro',
    resumo: 'Avaliacao gerada com sucesso; o envio do e-mail falhou.',
    pontuacoes: [{ competencia: 'Qualificação', nota: 3, justificativa: 'ok', coberta: true }],
  });

  try {
    await t.test('completo (enviado) -> 200 com conteudo acentuado e badge de nao coberta', async () => {
      const res = await fetch(`${base}/relatorio/${reportCompleto.token}`);
      assert.equal(res.status, 200);
      const html = await res.text();
      assert.match(html, /Fulano de Teste/);
      assert.match(html, /Ambição\/Fome/); // acentuacao na tela
      assert.match(html, /Não abordada nesta entrevista/); // badge da competencia coberta=false
      // Score ponderado (Fase 5): mock usa nivel, mapeado no calculo (alta=5, baixa=1).
      // Redesenho comportamental: SDR tem 4 competencias (Resiliencia 3, Ambicao/Fome 3,
      // Fit cultural 2, Simulacao 2); a ULTIMA (Simulacao, peso 2) e 'baixa'.
      // (5*3 + 5*3 + 5*2 + 1*2)/10 = 4.2.
      assert.match(html, /Pontuação geral/);
      assert.match(html, /4\.2/);
    });

    await t.test('pendente -> 200 "sendo processado"', async () => {
      const res = await fetch(`${base}/relatorio/tok-pendente`);
      assert.equal(res.status, 200);
      assert.match(await res.text(), /sendo processado/i);
    });

    await t.test('erro -> 200 exibindo o conteudo da avaliacao', async () => {
      const res = await fetch(`${base}/relatorio/tok-erro`);
      assert.equal(res.status, 200);
      const html = await res.text();
      assert.match(html, /envio do e-mail falhou|Qualificação/);
    });

    await t.test('token invalido -> 404 generico', async () => {
      const res = await fetch(`${base}/relatorio/token-que-nao-existe`);
      assert.equal(res.status, 404);
      assert.match(await res.text(), /não encontrado/i);
    });
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
