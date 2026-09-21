'use strict';

// Filtro por STATUS DO RECRUTADOR no publico da campanha de e-mail
// (lib/promocaoVagas.js:listarPublicoCampanha) — ETAPA B, Incremento B3.
//
// Prova: (1) a regra nova age em 'divulgacao_vaga', cruzando e-mail E telefone, com contagem
// por motivo; (2) 'convite_grupo' segue intacto; (3) descadastro, "ja inscrito" e "talento
// descartado" continuam agindo.

const os = require('node:os');
const path = require('node:path');

process.env.DATABASE_PATH = path.join(os.tmpdir(), `vm-test-promocao-status-${process.pid}-${Date.now()}.db`);
process.env.INTERVIEW_MOCK = 'true';
process.env.SESSION_SECRET = 'segredo-de-teste';
process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert/strict');

const db = require('../src/db');
const { migrar } = require('../src/db/migrate');
const { listarPublicoCampanha } = require('../src/lib/promocaoVagas');

migrar();

const run = (sql, ...p) => Number(db.getDb().prepare(sql).run(...p).lastInsertRowid);

let seq = 0;
function vaga() {
  seq += 1;
  return run('INSERT INTO jobs (slug, titulo, perfil) VALUES (?, ?, ?)', `vaga-promo-status-${seq}`, `Vaga ${seq}`, 'CLOSER');
}
function candidatura(jobId, email, { telefone = null, status = null, arquivada = false, etapa = 'concluido' } = {}) {
  seq += 1;
  return run(
    `INSERT INTO applications (job_id, nome, email, telefone, status_recrutador, status, token, deleted_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    jobId,
    `Pessoa ${seq}`,
    email,
    telefone,
    status,
    etapa,
    `tok-promo-status-${seq}`,
    arquivada ? '2026-08-10 10:00:00' : null,
  );
}
function talento(email, { telefone = null, status = 'novo' } = {}) {
  seq += 1;
  return run(
    "INSERT INTO talentos (nome, email, telefone, status, categoria) VALUES (?, ?, ?, ?, 'legado')",
    `Talento ${seq}`,
    email,
    telefone,
    status,
  );
}
function zerar() {
  for (const t of ['applications', 'talentos', 'descadastros', 'jobs']) run(`DELETE FROM ${t}`);
}
const emails = (r) => r.itens.map((i) => i.email).sort();
function calado(fn) {
  const { log } = console;
  console.log = () => {};
  try {
    return fn();
  } finally {
    console.log = log;
  }
}
const divulgar = (jobIdAlvo) => calado(() => listarPublicoCampanha({ tipo: 'divulgacao_vaga', jobIdAlvo }));

// Cenario do B0 em miniatura.
function cenarioB0() {
  zerar();
  const antiga = vaga();
  const outra = vaga();
  const alvo = vaga();
  talento('legado@x.com'); // D1: entra
  candidatura(antiga, 'semdecisao@x.com'); // entra
  candidatura(antiga, 'reprovado@x.com', { status: 'reprovado' }); // entra
  candidatura(antiga, 'entrevista@x.com', { etapa: 'em_entrevista' }); // D2: entra
  candidatura(antiga, 'aprovado@x.com', { status: 'aprovado' }); // sai
  candidatura(antiga, 'analise@x.com', { status: 'em_analise' }); // sai
  // Reprovado ativo + em analise ARQUIVADA: sai, contado como "so por arquivada" (D3).
  candidatura(antiga, 'arquivada@x.com', { status: 'reprovado' });
  candidatura(outra, 'arquivada@x.com', { status: 'em_analise', arquivada: true });
  return alvo;
}

test('divulgacao: so legado / sem decisao / reprovado / em entrevista entram, com contagem', () => {
  const alvo = cenarioB0();
  const r = divulgar(alvo);
  assert.deepEqual(emails(r), ['entrevista@x.com', 'legado@x.com', 'reprovado@x.com', 'semdecisao@x.com']);
  assert.equal(r.total, 4);
  assert.deepEqual(r.excluidosPorStatus, {
    total: 3,
    porMotivo: { aprovado: 1, em_analise: 2, desconhecido: 0 },
    apenasArquivada: 1,
  });
  // O campo novo NAO entra em excluidosPorFiltro (a tela percorre aquele objeto inteiro).
  assert.equal('status' in r.excluidosPorFiltro, false);
});

test('divulgacao: valor desconhecido e fail-closed; maiuscula de aprovado sai; vazio entra', () => {
  zerar();
  const antiga = vaga();
  const alvo = vaga();
  candidatura(antiga, 'lixo@x.com', { status: 'lixo' });
  candidatura(antiga, 'maiuscula@x.com', { status: 'Aprovado' });
  candidatura(antiga, 'vazio@x.com', { status: '' });
  const r = divulgar(alvo);
  assert.deepEqual(emails(r), ['vazio@x.com']);
  assert.deepEqual(r.excluidosPorStatus.porMotivo, { aprovado: 1, em_analise: 0, desconhecido: 1 });
});

// ── Cruzamento e-mail + telefone ──

test('cruzamento: casa SO por e-mail (candidatura aprovada com o mesmo e-mail, em outra caixa)', () => {
  zerar();
  const antiga = vaga();
  const alvo = vaga();
  candidatura(antiga, 'Ana@X.com', { status: 'aprovado' });
  talento('ana@x.com'); // mesma pessoa pelo e-mail, sem telefone
  const r = divulgar(alvo);
  assert.deepEqual(emails(r), []);
});

test('cruzamento: casa SO por telefone (e-mails diferentes, mesmo numero de candidatura aprovada)', () => {
  zerar();
  const antiga = vaga();
  const alvo = vaga();
  candidatura(antiga, 'aprovada@x.com', { telefone: '+55 47 99958-2500', status: 'aprovado' });
  // Talento com OUTRO e-mail e o mesmo telefone, gravado sem o nono digito e sem formatacao.
  talento('outro-email@x.com', { telefone: '4799582500' });
  // Candidatura sem decisao com OUTRO e-mail e o mesmo telefone.
  candidatura(antiga, 'terceiro@x.com', { telefone: '5547999582500' });
  // Controle: telefone diferente, entra.
  talento('limpo@x.com', { telefone: '+55 47 98888-0000' });
  const r = divulgar(alvo);
  assert.deepEqual(emails(r), ['limpo@x.com']);
  // A propria aprovada + as duas que so casam pelo telefone.
  assert.equal(r.excluidosPorStatus.total, 3);
  assert.equal(r.excluidosPorStatus.porMotivo.aprovado, 3);
});

test('cruzamento: telefone de candidatura REPROVADA nao exclui ninguem', () => {
  zerar();
  const antiga = vaga();
  const alvo = vaga();
  candidatura(antiga, 'rep@x.com', { telefone: '+55 47 97777-0000', status: 'reprovado' });
  talento('mesmo-tel@x.com', { telefone: '+55 47 97777-0000' });
  const r = divulgar(alvo);
  assert.deepEqual(emails(r), ['mesmo-tel@x.com', 'rep@x.com']);
  assert.equal(r.excluidosPorStatus.total, 0);
});

// ── Escopo: convite_grupo intacto ──

test('convite_grupo NAO aplica a regra: mesmo cenario, todos os 7 continuam', () => {
  cenarioB0();
  const r = calado(() => listarPublicoCampanha({ tipo: 'convite_grupo' }));
  assert.deepEqual(emails(r), [
    'analise@x.com',
    'aprovado@x.com',
    'arquivada@x.com',
    'entrevista@x.com',
    'legado@x.com',
    'reprovado@x.com',
    'semdecisao@x.com',
  ]);
  assert.equal(r.excluidosPorStatus, null);
});

// ── Regressao: exclusoes existentes ──

test('descadastro continua excluindo (e nao conta como status)', () => {
  zerar();
  const antiga = vaga();
  const alvo = vaga();
  candidatura(antiga, 'saiu@x.com', { status: 'reprovado' });
  candidatura(antiga, 'fica@x.com');
  db.registrarDescadastro('saiu@x.com', 'link');
  const r = divulgar(alvo);
  assert.deepEqual(emails(r), ['fica@x.com']);
  assert.equal(r.excluidosPorStatus.total, 0);
});

test('ja inscrito na vaga alvo continua excluido', () => {
  zerar();
  const alvo = vaga();
  candidatura(alvo, 'inscrito@x.com', { status: 'reprovado' });
  const r = divulgar(alvo);
  assert.deepEqual(emails(r), []);
  assert.equal(r.excluidosPorStatus.total, 0);
});

test('talento descartado continua excluido', () => {
  zerar();
  const alvo = vaga();
  talento('descartado@x.com', { status: 'descartado' });
  talento('novo@x.com');
  const r = divulgar(alvo);
  assert.deepEqual(emails(r), ['novo@x.com']);
});

test('dedupe: pessoa com candidatura e talento aparece uma vez e e avaliada uma vez', () => {
  zerar();
  const antiga = vaga();
  const alvo = vaga();
  candidatura(antiga, 'dup@x.com', { status: 'em_analise' });
  talento('dup@x.com');
  const r = divulgar(alvo);
  assert.deepEqual(emails(r), []);
  assert.equal(r.excluidosPorStatus.total, 1);
});

test('a conta fecha: total + excluidosPorStatus.total = publico sem o filtro de status', () => {
  const alvo = cenarioB0();
  const com = divulgar(alvo);
  // Mesmo banco, mas sem nenhuma candidatura no indice: todo mundo elegivel. E o publico que
  // existiria sem a regra — e o filtro nao pode tirar ninguem a mais nem a menos que o contado.
  const dbSemStatus = { ...db, listarStatusRecrutadorParaElegibilidade: () => [] };
  const sem = calado(() => listarPublicoCampanha({ tipo: 'divulgacao_vaga', jobIdAlvo: alvo }, { db: dbSemStatus }));
  assert.equal(sem.excluidosPorStatus.total, 0);
  assert.equal(com.total + com.excluidosPorStatus.total, sem.total);
  assert.equal(sem.total, 7);
});
