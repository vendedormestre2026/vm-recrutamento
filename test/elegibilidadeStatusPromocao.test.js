'use strict';

// Nucleo de elegibilidade por status do recrutador para PROMOCAO DE NOVAS VAGAS
// (lib/elegibilidadeStatusPromocao.js) — ETAPA B, Incremento B1.
//
// Duas partes: a regra contra um `db` injetado (cada cenario isolado, sem banco), e a
// leitura nova da camada de dados contra um banco temporario de verdade, provando que ela
// traz inclusive as candidaturas arquivadas (D3).

const os = require('node:os');
const path = require('node:path');

process.env.DATABASE_PATH = path.join(os.tmpdir(), `vm-test-elegibilidade-${process.pid}-${Date.now()}.db`);
process.env.INTERVIEW_MOCK = 'true';
process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert/strict');

const db = require('../src/db');
const { migrar } = require('../src/db/migrate');
const {
  normalizarStatusRecrutador,
  statusElegivelPromocaoVaga,
  construirIndiceElegibilidade,
  tipoComFiltroStatus,
  STATUS_ELEGIVEIS_PROMOCAO_VAGA,
  TIPOS_CAMPANHA_COM_FILTRO_STATUS,
} = require('../src/lib/elegibilidadeStatusPromocao');

migrar();

// db falso: so a leitura que o indice consome.
function dbCom(linhas) {
  let id = 0;
  return {
    listarStatusRecrutadorParaElegibilidade: () =>
      linhas.map((l) => ({ id: ++id, telefone: null, email: null, status: 'concluido', deleted_at: null, ...l })),
  };
}

// ── normalizarStatusRecrutador ──

test('NULL, vazio e so espacos viram sem_decisao (elegivel)', () => {
  for (const v of [null, undefined, '', '   ', 'sem_decisao', 'Sem decisão']) {
    assert.equal(normalizarStatusRecrutador(v), 'sem_decisao', JSON.stringify(v));
    assert.equal(statusElegivelPromocaoVaga(v), true, JSON.stringify(v));
  }
});

test('reprovado e elegivel; aprovado e em_analise nao', () => {
  assert.equal(statusElegivelPromocaoVaga('reprovado'), true);
  assert.equal(statusElegivelPromocaoVaga('aprovado'), false);
  assert.equal(statusElegivelPromocaoVaga('em_analise'), false);
});

test('caixa, acento e espaco sao normalizados antes de comparar', () => {
  assert.equal(normalizarStatusRecrutador('Aprovado'), 'aprovado');
  assert.equal(normalizarStatusRecrutador('  EM ANÁLISE '), 'em_analise');
  assert.equal(normalizarStatusRecrutador('em-analise'), 'em_analise');
  assert.equal(normalizarStatusRecrutador('REPROVADO'), 'reprovado');
  // Maiuscula de um status inelegivel continua inelegivel.
  assert.equal(statusElegivelPromocaoVaga('Aprovado'), false);
  assert.equal(statusElegivelPromocaoVaga('EM ANÁLISE'), false);
});

test('valor desconhecido e fail-closed', () => {
  for (const v of ['lixo', 'aprovado?', 'contratado', '0', 1]) {
    assert.equal(normalizarStatusRecrutador(v), 'desconhecido', JSON.stringify(v));
    assert.equal(statusElegivelPromocaoVaga(v), false, JSON.stringify(v));
  }
});

test('constantes: elegiveis e tipos com filtro', () => {
  assert.deepEqual([...STATUS_ELEGIVEIS_PROMOCAO_VAGA], ['sem_decisao', 'reprovado']);
  assert.deepEqual([...TIPOS_CAMPANHA_COM_FILTRO_STATUS], ['divulgacao_vaga']);
  assert.equal(tipoComFiltroStatus('divulgacao_vaga'), true);
  for (const t of ['convite_grupo', 'status_candidatura', 'wa1', '', null]) {
    assert.equal(tipoComFiltroStatus(t), false, String(t));
  }
});

// ── construirIndiceElegibilidade ──

test('legado sem candidatura e elegivel (D1)', () => {
  const idx = construirIndiceElegibilidade({ db: dbCom([]) });
  const r = idx.avaliar({ telefones: ['5547999990000'], emails: ['legado@x.com'] });
  assert.deepEqual(r, { elegivel: true, motivo: null, apenasArquivada: false, semCandidatura: true });
});

test('NULL em entrevista e elegivel (D2); vazio tambem', () => {
  const idx = construirIndiceElegibilidade({
    db: dbCom([
      { telefone: '5547911110001', status_recrutador: null, status: 'em_entrevista' },
      { telefone: '5547911110002', status_recrutador: '' },
    ]),
  });
  assert.equal(idx.porTelefone('5547911110001').elegivel, true);
  assert.equal(idx.porTelefone('5547911110002').elegivel, true);
});

test('aprovado, em_analise e desconhecido excluem, com o motivo', () => {
  const idx = construirIndiceElegibilidade({
    db: dbCom([
      { telefone: '5547922220001', status_recrutador: 'aprovado' },
      { telefone: '5547922220002', status_recrutador: 'em_analise' },
      { telefone: '5547922220003', status_recrutador: 'lixo' },
      { telefone: '5547922220004', status_recrutador: 'reprovado' },
    ]),
  });
  assert.equal(idx.porTelefone('5547922220001').motivo, 'aprovado');
  assert.equal(idx.porTelefone('5547922220002').motivo, 'em_analise');
  assert.equal(idx.porTelefone('5547922220003').motivo, 'desconhecido');
  assert.equal(idx.porTelefone('5547922220004').elegivel, true);
});

test('regra TODAS: uma candidatura inelegivel entre varias exclui (D3)', () => {
  const idx = construirIndiceElegibilidade({
    db: dbCom([
      { email: 'multi@x.com', status_recrutador: 'reprovado' },
      { email: 'multi@x.com', status_recrutador: null },
      { email: 'multi@x.com', status_recrutador: 'em_analise' },
      { email: 'ok@x.com', status_recrutador: 'reprovado' },
      { email: 'ok@x.com', status_recrutador: null },
    ]),
  });
  assert.equal(idx.porEmail('multi@x.com').elegivel, false);
  assert.equal(idx.porEmail('multi@x.com').motivo, 'em_analise');
  assert.equal(idx.porEmail('ok@x.com').elegivel, true);
});

test('candidatura ARQUIVADA em analise exclui e e marcada como apenasArquivada (D3)', () => {
  const idx = construirIndiceElegibilidade({
    db: dbCom([
      { telefone: '5547933330001', status_recrutador: 'reprovado' },
      { telefone: '5547933330001', status_recrutador: 'em_analise', deleted_at: '2026-01-01 00:00:00' },
      // Ativa E arquivada inelegiveis: NAO e "apenas arquivada".
      { telefone: '5547933330002', status_recrutador: 'aprovado' },
      { telefone: '5547933330002', status_recrutador: 'em_analise', deleted_at: '2026-01-01 00:00:00' },
    ]),
  });
  const a = idx.porTelefone('5547933330001');
  assert.equal(a.elegivel, false);
  assert.equal(a.motivo, 'em_analise');
  assert.equal(a.apenasArquivada, true);
  const b = idx.porTelefone('5547933330002');
  assert.equal(b.motivo, 'aprovado');
  assert.equal(b.apenasArquivada, false);
});

test('com e sem nono digito sao a MESMA pessoa (chave canonica)', () => {
  const idx = construirIndiceElegibilidade({
    db: dbCom([{ telefone: '+55 (31) 99682-0290', status_recrutador: 'aprovado' }]),
  });
  assert.equal(idx.porTelefone('553196820290').elegivel, false);
  assert.equal(idx.porTelefone('5531996820290').elegivel, false);
  assert.equal(idx.porTelefone('31996820290').elegivel, false);
});

test('e-mail normalizado casa independente de caixa/espaco', () => {
  const idx = construirIndiceElegibilidade({
    db: dbCom([{ email: ' Fulano@Exemplo.COM ', status_recrutador: 'aprovado' }]),
  });
  assert.equal(idx.porEmail('fulano@exemplo.com').elegivel, false);
});

test('cruzamento: QUALQUER chave inelegivel exclui (e-mail limpo + telefone aprovado)', () => {
  const idx = construirIndiceElegibilidade({
    db: dbCom([
      { email: 'limpo@x.com', telefone: '5547944440000', status_recrutador: 'reprovado' },
      { email: 'outro@x.com', telefone: '5547944449999', status_recrutador: 'aprovado' },
    ]),
  });
  // So por e-mail: elegivel. Com o telefone da candidatura aprovada: excluida.
  assert.equal(idx.avaliar({ emails: ['limpo@x.com'] }).elegivel, true);
  const r = idx.avaliar({ emails: ['limpo@x.com'], telefones: ['47944449999'] });
  assert.equal(r.elegivel, false);
  assert.equal(r.motivo, 'aprovado');
  // E o inverso: telefone limpo + e-mail de candidatura aprovada.
  assert.equal(idx.avaliar({ emails: ['outro@x.com'], telefones: ['5547944440000'] }).elegivel, false);
});

test('resumo agregado conta avaliacoes, motivos e apenasArquivada', () => {
  const idx = construirIndiceElegibilidade({
    db: dbCom([
      { telefone: '5547955550001', status_recrutador: 'aprovado' },
      { telefone: '5547955550002', status_recrutador: 'em_analise', deleted_at: '2026-01-01' },
      { telefone: '5547955550003', status_recrutador: 'Xyz' },
    ]),
  });
  idx.porTelefone('5547955550001');
  idx.porTelefone('5547955550002');
  idx.porTelefone('5547955550003');
  idx.porTelefone('5547955550004'); // sem candidatura
  assert.deepEqual(idx.resumo, {
    avaliadas: 4,
    elegiveis: 1,
    excluidas: 3,
    porMotivo: { aprovado: 1, em_analise: 1, desconhecido: 1 },
    apenasArquivada: 1,
  });
});

test('chave vazia/invalida nao casa com nada (nao vira "todo mundo")', () => {
  const idx = construirIndiceElegibilidade({
    db: dbCom([
      { telefone: null, email: null, status_recrutador: 'aprovado' },
      // Telefone curto/lixo gravado numa candidatura aprovada: sem chave canonica, nao entra
      // no indice — e portanto nao pode casar com outro telefone curto igual.
      { telefone: '123', email: null, status_recrutador: 'aprovado' },
    ]),
  });
  assert.equal(idx.avaliar({ telefones: [null, ''], emails: [null, ''] }).elegivel, true);
  for (const t of ['   ', '123', '4799', 'abc', undefined, 5547]) {
    const r = idx.porTelefone(t);
    assert.equal(r.elegivel, true, String(t));
    assert.equal(r.semCandidatura, true, String(t));
  }
});

// ── Leitura real da camada de dados ──

test('listarStatusRecrutadorParaElegibilidade traz ativas E arquivadas, com os campos esperados', () => {
  const g = db.getDb();
  const jobId = Number(
    g.prepare("INSERT INTO jobs (slug, titulo, perfil, cidade, ativo) VALUES ('vaga-eleg-1', 'V', 'SDR', 'Joinville', 1)").run()
      .lastInsertRowid,
  );
  const ins = g.prepare(
    `INSERT INTO applications (job_id, nome, telefone, email, status_recrutador, status, token, deleted_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  ins.run(jobId, 'A', '5547966660001', 'a@x.com', null, 'aplicado', 'tok-eleg-1', null);
  ins.run(jobId, 'B', '5547966660001', 'a@x.com', 'em_analise', 'concluido', 'tok-eleg-2', '2026-02-02 10:00:00');

  const linhas = db.listarStatusRecrutadorParaElegibilidade();
  assert.equal(linhas.length, 2);
  assert.deepEqual(Object.keys(linhas[0]).sort(), ['deleted_at', 'email', 'id', 'status', 'status_recrutador', 'telefone']);
  assert.ok(linhas.some((l) => l.deleted_at));

  const idx = construirIndiceElegibilidade();
  const r = idx.porTelefone('5547966660001');
  assert.equal(r.elegivel, false);
  assert.equal(r.apenasArquivada, true);
});
