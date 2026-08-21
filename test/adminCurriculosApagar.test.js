'use strict';

// GET/POST /admin/curriculos-backup/apagar — exclusao definitiva dos PDFs ja baixados no
// backup manual, e o reflexo disso em GET /admin/candidato/:id/curriculo.
//
// O RISCO CENTRAL deste par de rotas e apagar arquivo sem confirmacao de verdade — por
// isso a cobertura aqui pesa em: (1) a pre-visualizacao (GET) e um dry-run REAL, nada
// muda so de acessar; (2) o servidor NUNCA aceita a lista de ids do corpo do POST, so a
// propria query fresca; (3) confirmo_backup e checado no servidor, nao so no HTML/JS
// (bug-to-confirm-test cobre isso explicitamente, por ser o caso mais critico).

const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');

process.env.DATABASE_PATH = path.join(os.tmpdir(), `vm-test-curriculos-apagar-${process.pid}-${Date.now()}.db`);
process.env.INTERVIEW_MOCK = 'true';
process.env.SESSION_SECRET = 'segredo-de-teste';
process.env.ADMIN_USER = 'admin-teste';
process.env.ADMIN_PASSWORD = 'senha-teste';
process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert/strict');

const db = require('../src/db');
const { migrar } = require('../src/db/migrate');
const { criarApp } = require('../src/server');

migrar();

const run = (sql, ...p) => Number(db.getDb().prepare(sql).run(...p).lastInsertRowid);

const jobId = run(
  "INSERT INTO jobs (slug, titulo, perfil, empresa, ativo) VALUES ('vaga-curriculos-apagar', 'Vaga Apagar', 'CLOSER', 'Empresa Teste', 1)",
);

const pastaFonte = fs.mkdtempSync(path.join(os.tmpdir(), 'vm-test-curriculos-apagar-fonte-'));

let seq = 0;
function criarApplication({ criado_em, curriculo_path, nome = 'Fulano', sobrenome = 'Teste' }) {
  seq += 1;
  return run(
    `INSERT INTO applications (job_id, nome, sobrenome, email, telefone, curriculo_path, token, status, criado_em)
     VALUES (?, ?, ?, 'x@x.com', '+5511999998888', ?, ?, 'aplicado', ?)`,
    jobId,
    nome,
    sobrenome,
    curriculo_path,
    `tok-apagar-${seq}`,
    criado_em,
  );
}

function novoArquivo(conteudo = 'conteudo pdf de teste') {
  seq += 1;
  const caminho = path.join(pastaFonte, `token-${seq}.pdf`);
  fs.writeFileSync(caminho, conteudo);
  return caminho;
}

async function comServidor(fn) {
  const app = criarApp();
  const server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  try {
    return await fn(`http://127.0.0.1:${server.address().port}`);
  } finally {
    await new Promise((r) => server.close(r));
  }
}

let cookieAdmin = '';
async function autenticar(base) {
  const res = await fetch(`${base}/admin/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'usuario=admin-teste&senha=senha-teste',
    redirect: 'manual',
  });
  const bruto = res.headers.getSetCookie ? res.headers.getSetCookie() : [res.headers.get('set-cookie')];
  cookieAdmin = bruto.filter(Boolean).map((c) => c.split(';')[0]).join('; ');
}

const curriculoRemovidoEm = (id) =>
  db.getDb().prepare('SELECT curriculo_removido_em FROM applications WHERE id = ?').get(id).curriculo_removido_em;

// ══════════════════ GET (pre-visualizacao) — dry-run de verdade ══════════════════

test('GET /curriculos-backup/apagar: NAO apaga nenhum arquivo nem marca nada (dry-run real)', async () => {
  const arquivo = novoArquivo();
  const id = criarApplication({ criado_em: '2025-01-10 10:00:00', curriculo_path: arquivo });

  await comServidor(async (base) => {
    if (!cookieAdmin) await autenticar(base);
    const res = await fetch(`${base}/admin/curriculos-backup/apagar?antes=2025-06-01`, { headers: { Cookie: cookieAdmin } });
    assert.equal(res.status, 200);
    const html = await res.text();
    assert.match(html, /confirmo_backup/);
    assert.match(html, /IRREVERS/);
  });

  assert.ok(fs.existsSync(arquivo), 'o arquivo tem que continuar existindo apos so acessar a pre-visualizacao');
  assert.equal(curriculoRemovidoEm(id), null, 'nada pode ser marcado so de pre-visualizar');
});

test('GET /curriculos-backup/apagar sem elegiveis: aviso "Nada para apagar"', async () => {
  await comServidor(async (base) => {
    if (!cookieAdmin) await autenticar(base);
    const res = await fetch(`${base}/admin/curriculos-backup/apagar?antes=1990-01-01`, { headers: { Cookie: cookieAdmin } });
    assert.equal(res.status, 200);
    const html = await res.text();
    assert.match(html, /Nada para apagar/);
  });
});

// ══════════════════ POST sem confirmacao ══════════════════

test('POST /curriculos-backup/apagar SEM confirmo_backup: rejeita, nada e apagado nem marcado', async () => {
  const arquivo = novoArquivo();
  const id = criarApplication({ criado_em: '2025-01-11 10:00:00', curriculo_path: arquivo });

  await comServidor(async (base) => {
    if (!cookieAdmin) await autenticar(base);
    const res = await fetch(`${base}/admin/curriculos-backup/apagar`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Cookie: cookieAdmin },
      body: 'antes=2025-06-01',
    });
    assert.equal(res.status, 400);
  });

  assert.ok(fs.existsSync(arquivo));
  assert.equal(curriculoRemovidoEm(id), null);
});

// ══════════════════ POST com confirmacao — caso feliz ══════════════════

test('POST /curriculos-backup/apagar COM confirmo_backup=1: apaga de fato, marca, e respeita a data de corte', async () => {
  const arquivoAntigo = novoArquivo('conteudo antigo');
  const idAntigo = criarApplication({ criado_em: '2025-01-12 10:00:00', curriculo_path: arquivoAntigo, nome: 'Antigo' });

  const arquivoRecente = novoArquivo('conteudo recente');
  const idRecente = criarApplication({ criado_em: '2026-01-01 10:00:00', curriculo_path: arquivoRecente, nome: 'Recente' });

  await comServidor(async (base) => {
    if (!cookieAdmin) await autenticar(base);
    const res = await fetch(`${base}/admin/curriculos-backup/apagar`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Cookie: cookieAdmin },
      body: 'antes=2025-06-01&confirmo_backup=1',
      redirect: 'manual',
    });
    assert.equal(res.status, 302);
    assert.match(res.headers.get('location'), /\/admin\/config\?curriculos_apagados=\d+/);
  });

  assert.ok(!fs.existsSync(arquivoAntigo), 'o arquivo elegivel (antes do corte) tem que ter sido apagado');
  assert.ok(curriculoRemovidoEm(idAntigo), 'curriculo_removido_em tem que estar preenchido');

  assert.ok(fs.existsSync(arquivoRecente), 'candidatura POSTERIOR ao corte nao pode ser afetada');
  assert.equal(curriculoRemovidoEm(idRecente), null);
});

// ══════════════════ Protecao contra manipulacao do POST ══════════════════

test('POST com lista de ids forjada no corpo: ignorada — so antes/confirmo_backup do servidor valem', async () => {
  // Candidatura fora do recorte de data (2026, bem no futuro do "antes" usado abaixo).
  const arquivoForaDoRecorte = novoArquivo('nao pode ser apagado');
  const idForaDoRecorte = criarApplication({
    criado_em: '2026-06-01 10:00:00',
    curriculo_path: arquivoForaDoRecorte,
    nome: 'ForaDoRecorte',
  });

  await comServidor(async (base) => {
    if (!cookieAdmin) await autenticar(base);
    // O corpo forja um campo `ids` tentando incluir a candidatura fora do recorte — a
    // rota nunca le esse campo, so `antes` e `confirmo_backup`.
    const res = await fetch(`${base}/admin/curriculos-backup/apagar`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Cookie: cookieAdmin },
      body: `antes=1990-01-01&confirmo_backup=1&ids=${idForaDoRecorte}&application_id=${idForaDoRecorte}`,
      redirect: 'manual',
    });
    // antes=1990-01-01 nao elege ninguem -> "nada para apagar", 200 (nao redireciona).
    assert.equal(res.status, 200);
  });

  assert.ok(fs.existsSync(arquivoForaDoRecorte), 'ids forjados no corpo nao podem fazer a rota apagar fora do recorte real');
  assert.equal(curriculoRemovidoEm(idForaDoRecorte), null);
});

// ══════════════════ GET /candidato/:id/curriculo apos remocao ══════════════════

test('GET /candidato/:id/curriculo para candidatura ja removida: mensagem especifica, nao o 404 generico', async () => {
  const arquivo = novoArquivo();
  const id = criarApplication({ criado_em: '2025-01-13 10:00:00', curriculo_path: arquivo, nome: 'Removida' });
  db.marcarCurriculoRemovido(id);
  // Simula o arquivo ja tendo sido de fato apagado do disco (o que a rota POST faria).
  fs.unlinkSync(arquivo);

  await comServidor(async (base) => {
    if (!cookieAdmin) await autenticar(base);
    const res = await fetch(`${base}/admin/candidato/${id}/curriculo`, { headers: { Cookie: cookieAdmin } });
    assert.equal(res.status, 410);
    const html = await res.text();
    assert.match(html, /removido do servidor em/);
    assert.match(html, /backup periódico/);
    assert.doesNotMatch(html, /Arquivo não encontrado/, 'nao pode mostrar o 404 generico pra esse caso');
  });
});

test.after(() => {
  fs.rmSync(pastaFonte, { recursive: true, force: true });
});
