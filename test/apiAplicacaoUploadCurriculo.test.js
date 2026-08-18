'use strict';

// POST /api/aplicacao — o arquivo e salvo com a EXTENSAO REAL, nao mais fixa em .pdf
// (Incremento 1 do prompt de upload de curriculo em JPG/PNG/DOCX).
//
// ── POR QUE SO PDF AQUI ──
// O fileFilter do multer (routes/api.js) so aceita PDF at o Incremento 3 ampliar. Testar os
// outros 3 tipos (JPG/PNG/DOCX) ponta a ponta por HTTP so faz sentido depois que o filtro os
// deixar passar — a cobertura deles entra no teste do Incremento 3/4, quando a rota de fato
// aceitar. Este arquivo prova o que JA E verdade agora: PDF continua salvando com .pdf, e o
// caminho gravado em applications.curriculo_path tem a extensao certa.

const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');

process.env.DATABASE_PATH = path.join(os.tmpdir(), `vm-test-upload-curriculo-${process.pid}-${Date.now()}.db`);
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

db.getDb()
  .prepare(
    "INSERT INTO jobs (slug, titulo, perfil, empresa, ativo) VALUES ('vaga-upload-curriculo', 'Vaga Upload Curriculo', 'CLOSER', 'Empresa Teste', 1)",
  )
  .run();

async function comServidor(fn) {
  const app = criarApp();
  const server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  try {
    return await fn(`http://127.0.0.1:${server.address().port}`);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

function formulario({ email, nomeArquivo, tipo, conteudo }) {
  const fd = new FormData();
  fd.set('slug', 'vaga-upload-curriculo');
  fd.set('nome', 'Candidata');
  fd.set('sobrenome', 'Teste');
  fd.set('email', email);
  fd.set('ddi', '+55');
  fd.set('telefone', '11940670469');
  fd.set('consentimento', '1');
  fd.set('curriculo', new Blob([conteudo], { type: tipo }), nomeArquivo);
  return fd;
}

const buscarPorEmail = (email) => db.getDb().prepare('SELECT * FROM applications WHERE email = ?').get(email);

test('PDF aceito: curriculo_path grava com extensao .pdf, arquivo existe no disco', async () => {
  await comServidor(async (base) => {
    const email = 'upload.pdf@teste.com';
    const res = await fetch(`${base}/api/aplicacao`, {
      method: 'POST',
      body: formulario({ email, nomeArquivo: 'curriculo.pdf', tipo: 'application/pdf', conteudo: 'conteudo fake de pdf' }),
    });
    assert.equal(res.status, 200);

    const app = buscarPorEmail(email);
    assert.ok(app, 'candidatura precisa ter sido criada');
    assert.match(app.curriculo_path, /\.pdf$/, 'curriculo_path precisa terminar em .pdf');
    assert.equal(fs.existsSync(app.curriculo_path), true, 'o arquivo precisa existir de verdade no disco');
  });
});

test('JPG/PNG/DOCX ainda NAO passam pelo fileFilter (fica pro Incremento 3) — 400, nao 200', async () => {
  await comServidor(async (base) => {
    const casos = [
      ['jpg', 'foto.jpg', 'image/jpeg'],
      ['png', 'foto.png', 'image/png'],
      ['docx', 'curriculo.docx', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'],
    ];
    for (const [ext, nomeArquivo, tipo] of casos) {
      const email = `upload.${ext}@teste.com`;
      const res = await fetch(`${base}/api/aplicacao`, {
        method: 'POST',
        body: formulario({ email, nomeArquivo, tipo, conteudo: `conteudo fake de ${ext}` }),
      });
      assert.equal(res.status, 400, `${ext} deveria ser rejeitado ate o Incremento 3 ampliar o fileFilter`);
      assert.equal(buscarPorEmail(email), undefined);
    }
  });
});
