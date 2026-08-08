'use strict';

// Contadores do rodape do painel (/admin): "Total de candidatos" e "Entrevistas
// concluidas" passaram a refletir o recorte filtrado da tela, em vez do banco inteiro.
//
// Cobre (DB isolado, dados inseridos direto; sem LLM/STT/TTS/Drive/e-mail):
//   1. contarEntrevistasConcluidasComContexto sem filtro = todas as entrevistas
//      concluidas (mesmo numero do contador global, que segue existindo);
//   2. os filtros da tela (vaga, origem, data, status do candidato, busca, arquivados)
//      restringem a contagem — o JOIN com applications e o que permite isso;
//   3. entrevista NAO concluida nao entra, mesmo com a application batendo no filtro;
//   4. `pagina` nao e filtro: nao altera nenhum dos dois contadores;
//   5. os dois contadores concordam entre si e com a listagem (rodape x tabela).

const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');

const TMP_DB = path.join(os.tmpdir(), `vm-test-rodape-${process.pid}-${Date.now()}.db`);
process.env.DATABASE_PATH = TMP_DB;
process.env.INTERVIEW_MOCK = 'true';
process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert/strict');

const db = require('../src/db');
const { migrar } = require('../src/db/migrate');

let vagaA;
let vagaB;
let idArquivado;
let seqTok = 0;

function run(sql, ...params) {
  return Number(db.getDb().prepare(sql).run(...params).lastInsertRowid);
}

function aplicacao({ vaga, nome, utmSource = null, status = 'aplicado', criadoEm }) {
  seqTok += 1;
  return run(
    `INSERT INTO applications (job_id, nome, sobrenome, email, status, token, utm_source, criado_em)
     VALUES (?, ?, 'Teste', ?, ?, ?, ?, ?)`,
    vaga,
    nome,
    `${nome.toLowerCase()}@teste.com`,
    status,
    `tok-rodape-${seqTok}`,
    utmSource,
    criadoEm,
  );
}

function entrevista(applicationId, status) {
  return run(
    `INSERT INTO interviews (application_id, perfil, status) VALUES (?, 'CLOSER', ?)`,
    applicationId,
    status,
  );
}

test.before(() => {
  migrar();
  vagaA = run("INSERT INTO jobs (slug, titulo, perfil) VALUES ('vaga-a', 'Closer A', 'CLOSER')");
  vagaB = run("INSERT INTO jobs (slug, titulo, perfil) VALUES ('vaga-b', 'Closer B', 'CLOSER')");

  // Vaga A · origem meta · concluida.
  const a1 = aplicacao({
    vaga: vagaA,
    nome: 'AnaMeta',
    utmSource: 'meta',
    status: 'concluido',
    criadoEm: '2026-07-01 10:00:00',
  });
  entrevista(a1, 'concluido');

  // Vaga A · origem recrutasimples · concluida.
  const a2 = aplicacao({
    vaga: vagaA,
    nome: 'BrunoRecruta',
    utmSource: 'recrutasimples',
    status: 'concluido',
    criadoEm: '2026-07-02 10:00:00',
  });
  entrevista(a2, 'concluido');

  // Vaga B · origem meta · concluida, em data posterior (para o filtro de periodo).
  const b1 = aplicacao({
    vaga: vagaB,
    nome: 'CarlaMeta',
    utmSource: 'meta',
    status: 'concluido',
    criadoEm: '2026-07-20 10:00:00',
  });
  entrevista(b1, 'concluido');

  // Vaga A · entrevista COMECADA e nao concluida: a application bate em qualquer filtro
  // amplo, mas a entrevista nao pode entrar na contagem.
  const a3 = aplicacao({
    vaga: vagaA,
    nome: 'DaniloEmCurso',
    utmSource: 'meta',
    status: 'em_entrevista',
    criadoEm: '2026-07-03 10:00:00',
  });
  entrevista(a3, 'iniciada');

  // Vaga A · sem entrevista nenhuma (so engorda o total de candidatos).
  aplicacao({ vaga: vagaA, nome: 'ElisaSemEntrevista', criadoEm: '2026-07-04 10:00:00' });

  // Vaga B · concluida, mas ARQUIVADA: sai do recorte padrao da tela ('ativos').
  idArquivado = aplicacao({
    vaga: vagaB,
    nome: 'FabioArquivado',
    utmSource: 'meta',
    status: 'concluido',
    criadoEm: '2026-07-05 10:00:00',
  });
  entrevista(idArquivado, 'concluido');
  db.arquivarAplicacao(idArquivado);
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

// ── 1. Sem filtro ─────────────────────────────────────────────────────────────────────

test('sem filtro explicito, o recorte padrao ja exclui arquivados', () => {
  // Ha 4 entrevistas concluidas no banco, mas uma pertence a um candidato ARQUIVADO.
  // condicoesFiltroCandidatos defaulta para arquivados='ativos' (mesma regra que a
  // listagem sempre teve), entao o rodape mostra 3 — e nao os 4 do contador global.
  assert.equal(db.contarEntrevistasConcluidasComContexto({}), 3);
  assert.equal(db.contarAplicacoesComContexto({}), 5);

  // A diferenca em relacao ao contador global e DELIBERADA: ele conta a tabela inteira,
  // sem nocao de recorte. Era exatamente o bug do rodape antigo.
  assert.equal(db.contarEntrevistasConcluidas(), 4);
  assert.equal(db.contarAplicacoes(), 6);

  // Pedindo 'todos' explicitamente, os dois voltam a concordar com os globais.
  assert.equal(db.contarEntrevistasConcluidasComContexto({ arquivados: 'todos' }), 4);
  assert.equal(db.contarAplicacoesComContexto({ arquivados: 'todos' }), 6);
});

// ── 2. Filtros restringem ─────────────────────────────────────────────────────────────

test('filtro de vaga restringe a contagem de entrevistas', () => {
  // Vaga A: AnaMeta + BrunoRecruta concluidas (DaniloEmCurso nao conta).
  assert.equal(db.contarEntrevistasConcluidasComContexto({ jobId: vagaA }), 2);
  // Vaga B: so CarlaMeta no recorte padrao — FabioArquivado esta arquivado.
  assert.equal(db.contarEntrevistasConcluidasComContexto({ jobId: vagaB }), 1);
  assert.equal(
    db.contarEntrevistasConcluidasComContexto({ jobId: vagaB, arquivados: 'todos' }),
    2,
  );
});

test('filtro de origem restringe a contagem de entrevistas', () => {
  // meta: AnaMeta + CarlaMeta (DaniloEmCurso e meta mas nao concluiu; Fabio esta arquivado).
  assert.equal(db.contarEntrevistasConcluidasComContexto({ origem: 'meta' }), 2);
  assert.equal(db.contarEntrevistasConcluidasComContexto({ origem: 'meta', arquivados: 'todos' }), 3);
  assert.equal(db.contarEntrevistasConcluidasComContexto({ origem: 'recrutasimples' }), 1);
  assert.equal(db.contarEntrevistasConcluidasComContexto({ origem: 'direto' }), 0);
});

test('filtro de periodo restringe a contagem de entrevistas', () => {
  // A data e a da CANDIDATURA (a.criado_em), igual ao resto da tela.
  assert.equal(db.contarEntrevistasConcluidasComContexto({ dataDe: '2026-07-10' }), 1);
  assert.equal(db.contarEntrevistasConcluidasComContexto({ dataAte: '2026-07-02' }), 2);
  assert.equal(
    db.contarEntrevistasConcluidasComContexto({ dataDe: '2026-07-01', dataAte: '2026-07-02' }),
    2,
  );
});

test('visibilidade de arquivados vale para os dois contadores', () => {
  // O recorte PADRAO da tela e 'ativos' — o arquivado sai dos dois numeros.
  assert.equal(db.contarEntrevistasConcluidasComContexto({ arquivados: 'ativos' }), 3);
  assert.equal(db.contarAplicacoesComContexto({ arquivados: 'ativos' }), 5);

  assert.equal(db.contarEntrevistasConcluidasComContexto({ arquivados: 'arquivados' }), 1);
  assert.equal(db.contarAplicacoesComContexto({ arquivados: 'arquivados' }), 1);
});

test('busca textual tambem recorta a contagem de entrevistas', () => {
  assert.equal(db.contarEntrevistasConcluidasComContexto({ busca: 'bruno' }), 1);
  assert.equal(db.contarEntrevistasConcluidasComContexto({ busca: 'elisa' }), 0);
});

test('filtros combinados sao AND, como na listagem', () => {
  assert.equal(db.contarEntrevistasConcluidasComContexto({ jobId: vagaA, origem: 'meta' }), 1);
  assert.equal(
    db.contarEntrevistasConcluidasComContexto({ jobId: vagaB, origem: 'recrutasimples' }),
    0,
  );
});

// ── 3. Status da entrevista ───────────────────────────────────────────────────────────

test('entrevista nao concluida nao conta, mesmo com a application batendo no filtro', () => {
  // DaniloEmCurso: vaga A, origem meta, entrevista 'iniciada'. Aparece na listagem...
  const nomes = db
    .listarAplicacoesComContexto({ jobId: vagaA, origem: 'meta' })
    .map((c) => c.nome);
  assert.ok(nomes.includes('DaniloEmCurso'));

  // ...mas nao no contador de concluidas (so AnaMeta).
  assert.equal(db.contarEntrevistasConcluidasComContexto({ jobId: vagaA, origem: 'meta' }), 1);

  // Filtrando por status do CANDIDATO 'em_entrevista', nenhuma concluida sobra.
  assert.equal(db.contarEntrevistasConcluidasComContexto({ status: 'em_entrevista' }), 0);
  assert.equal(db.contarAplicacoesComContexto({ status: 'em_entrevista' }), 1);
});

// ── 4. Pagina nao e filtro ────────────────────────────────────────────────────────────

test('pagina nao altera os contadores (e recorte de exibicao, nao filtro)', () => {
  const semPagina = {
    totais: db.contarAplicacoesComContexto({}),
    concluidas: db.contarEntrevistasConcluidasComContexto({}),
  };
  for (const pagina of [1, 2, 99]) {
    assert.equal(db.contarAplicacoesComContexto({ pagina }), semPagina.totais);
    assert.equal(db.contarEntrevistasConcluidasComContexto({ pagina }), semPagina.concluidas);
  }
});

// ── 5. Coerencia rodape x tabela ──────────────────────────────────────────────────────

test('o total do rodape bate com o que a listagem devolve no mesmo recorte', () => {
  for (const filtros of [
    {},
    { jobId: vagaA },
    { origem: 'meta' },
    { arquivados: 'ativos' },
    { status: 'concluido', origem: 'meta' },
  ]) {
    const linhas = db.listarAplicacoesComContexto(filtros).length;
    const total = db.contarAplicacoesComContexto(filtros);
    // Poucos dados: cabe tudo na 1a pagina, entao total == linhas exibidas.
    assert.equal(total, linhas, `divergencia em ${JSON.stringify(filtros)}`);
    // Concluidas nunca podem passar do total de candidatos do recorte.
    assert.ok(db.contarEntrevistasConcluidasComContexto(filtros) <= total);
  }
});
