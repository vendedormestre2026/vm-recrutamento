'use strict';

// db.excluirVaga(id) — hard delete de vaga, guardado pelas 4 tabelas com FK em jobs.id.
//
// ── POR QUE ISTO EXISTE (diagnostico da ETAPA A, 2026-08-27) ──
// Duas vagas de teste ("TESTE PUSH - apagar depois" e "SDR / Pré-vendas") ja estao
// ativo=0 (soft-delete de sempre) e sem NENHUM dependente nas 4 tabelas com job_id. O
// pedido e apagar a LINHA de verdade — algo que o projeto so faz num unico lugar ate hoje
// (excluirCampanha, ver test/promocaoExclusao.test.js, cujo cabecalho documenta bem o
// motivo de nao haver rede de seguranca nenhuma em volta de um DELETE). excluirVaga segue
// o MESMO contrato: nunca lanca, resultado discriminado { ok, erroCodigo, mensagem }.
//
// Diferenca de excluirCampanha: aqui NAO ha maquina de estados (campanha tem
// status==='rascunho'; vaga nao tem um "estado seguro para apagar" equivalente) — a UNICA
// trava e "tem dependente em qualquer uma das 4 tabelas?". `ativo` NAO entra na checagem:
// uma vaga ATIVA sem nenhum dependente tambem pode ser excluida por esta funcao — quem
// decide SE deve chamar (o script one-off, ETAPA B Incremento 1c) e quem escolhe o alvo.

const os = require('node:os');
const path = require('node:path');

process.env.DATABASE_PATH = path.join(os.tmpdir(), `vm-test-excluir-vaga-${process.pid}-${Date.now()}.db`);
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

const run = (sql, ...p) => Number(db.getDb().prepare(sql).run(...p).lastInsertRowid);
const existeVaga = (id) => Boolean(db.getDb().prepare('SELECT 1 FROM jobs WHERE id = ?').get(id));

let seq = 0;
function criarVagaTeste() {
  seq += 1;
  return run(
    'INSERT INTO jobs (slug, titulo, perfil, ativo) VALUES (?, ?, ?, 0)',
    `vaga-excluir-${seq}`,
    `Vaga de teste ${seq}`,
    'CLOSER',
  );
}

// Um template minimo, so pra satisfazer a FK NOT NULL de campanhas_whatsapp.template_id —
// nao e o alvo do teste, so pre-requisito de schema.
let templateWaId = null;
function obterTemplateWaId() {
  if (templateWaId) return templateWaId;
  templateWaId = run(
    "INSERT INTO templates_whatsapp (nome_meta, idioma, categoria, variaveis) VALUES ('t_teste_vm', 'pt_BR', 'utility', '[]')",
  );
  return templateWaId;
}

// ══════════════════════════════════════════════════════════════
// 1. Caminho feliz — zero dependentes
// ══════════════════════════════════════════════════════════════

test('excluirVaga apaga uma vaga sem nenhum dependente', () => {
  const id = criarVagaTeste();
  assert.ok(existeVaga(id), 'sanidade');

  const r = db.excluirVaga(id);
  assert.deepEqual(r, { ok: true, titulo: `Vaga de teste ${seq}` });
  assert.ok(!existeVaga(id), 'a linha tem que sumir de verdade — nao ha soft-delete aqui');
});

test('excluirVaga nao encosta em outras vagas', () => {
  const alvo = criarVagaTeste();
  const vizinha = criarVagaTeste();

  db.excluirVaga(alvo);
  assert.ok(!existeVaga(alvo));
  assert.ok(existeVaga(vizinha), 'so a vaga pedida pode sumir');
});

// ══════════════════════════════════════════════════════════════
// 2. Trava — dependente em CADA UMA das 4 tabelas, isoladamente
// ══════════════════════════════════════════════════════════════

test('excluirVaga RECUSA quando ha 1+ application', () => {
  const id = criarVagaTeste();
  run('INSERT INTO applications (job_id) VALUES (?)', id);

  const r = db.excluirVaga(id);
  assert.equal(r.ok, false);
  assert.equal(r.erroCodigo, 'TEM_DEPENDENTES');
  assert.equal(r.tabela, 'applications');
  assert.equal(r.total, 1);
  assert.match(r.mensagem, /applications/);
  assert.ok(existeVaga(id));
});

test('excluirVaga RECUSA quando ha 1+ vaga_acesso', () => {
  const id = criarVagaTeste();
  run('INSERT INTO vaga_acessos (job_id) VALUES (?)', id);

  const r = db.excluirVaga(id);
  assert.equal(r.ok, false);
  assert.equal(r.erroCodigo, 'TEM_DEPENDENTES');
  assert.equal(r.tabela, 'vaga_acessos');
  assert.equal(r.total, 1);
  assert.ok(existeVaga(id));
});

test('excluirVaga RECUSA quando ha 1+ campanha (e-mail)', () => {
  const id = criarVagaTeste();
  run(
    "INSERT INTO campanhas (job_id, assunto, corpo_html, criterios) VALUES (?, 'Assunto', '<p></p>', '{}')",
    id,
  );

  const r = db.excluirVaga(id);
  assert.equal(r.ok, false);
  assert.equal(r.erroCodigo, 'TEM_DEPENDENTES');
  assert.equal(r.tabela, 'campanhas');
  assert.equal(r.total, 1);
  assert.ok(existeVaga(id));
});

test('excluirVaga RECUSA quando ha 1+ campanha de WhatsApp', () => {
  const id = criarVagaTeste();
  const tid = obterTemplateWaId();
  run(
    "INSERT INTO campanhas_whatsapp (nome, template_id, base_alvo, tipo_mensagem, job_id) VALUES ('Campanha WA', ?, 'ambos', 'divulgacao_vaga', ?)",
    tid,
    id,
  );

  const r = db.excluirVaga(id);
  assert.equal(r.ok, false);
  assert.equal(r.erroCodigo, 'TEM_DEPENDENTES');
  assert.equal(r.tabela, 'campanhas_whatsapp');
  assert.equal(r.total, 1);
  assert.ok(existeVaga(id));
});

// ══════════════════════════════════════════════════════════════
// 3. Entradas invalidas
// ══════════════════════════════════════════════════════════════

test('excluirVaga devolve erro discriminado para id inexistente ou invalido', () => {
  for (const id of [999999, 0, -1, null, undefined, 'abc', 1.5]) {
    const r = db.excluirVaga(id);
    assert.equal(r.ok, false, `id=${JSON.stringify(id)}`);
    assert.equal(r.erroCodigo, 'VAGA_NAO_ENCONTRADA');
  }
});

test('excluirVaga NUNCA lanca', () => {
  assert.doesNotThrow(() => db.excluirVaga(999999));
  assert.doesNotThrow(() => db.excluirVaga('lixo'));
});
