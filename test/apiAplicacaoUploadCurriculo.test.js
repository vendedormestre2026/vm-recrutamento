'use strict';

// POST /api/aplicacao — o arquivo e salvo com a EXTENSAO REAL, nao mais fixa em .pdf
// (Incremento 1), desde o Incremento 3 o fileFilter aceita PDF, JPG, PNG e DOCX (nao mais
// so PDF), e desde o Incremento 5 curriculo_texto e extraido condicionalmente por tipo
// (DOCX via mammoth; JPG/PNG sem OCR, fica vazio). Este arquivo cobre os quatro.

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

// Fixture real do mammoth (mesma copiada em test/fixtures/ pro curriculo.test.js), conteudo
// conhecido: "Walking on imported air".
const DOCX_REAL = fs.readFileSync(path.join(__dirname, 'fixtures', 'single-paragraph.docx'));

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

test('JPG, PNG e DOCX sao aceitos (Incremento 3): 200, curriculo_path com a extensao certa', async () => {
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
      const corpo = await res.json();
      assert.equal(res.status, 200, `${ext}: ${JSON.stringify(corpo)}`);

      const app = buscarPorEmail(email);
      assert.ok(app, `${ext}: candidatura precisa ter sido criada`);
      assert.match(app.curriculo_path, new RegExp(`\\.${ext}$`), `${ext}: extensao errada em curriculo_path`);
      assert.equal(fs.existsSync(app.curriculo_path), true, `${ext}: arquivo precisa existir no disco`);
    }
  });
});

test('.jpeg (variante de JPEG) e aceito e salvo com extensao canonica .jpg', async () => {
  await comServidor(async (base) => {
    const email = 'upload.jpeg-variante@teste.com';
    const res = await fetch(`${base}/api/aplicacao`, {
      method: 'POST',
      body: formulario({ email, nomeArquivo: 'foto.jpeg', tipo: 'image/jpeg', conteudo: 'conteudo fake de jpeg' }),
    });
    assert.equal(res.status, 200);
    const app = buscarPorEmail(email);
    assert.match(app.curriculo_path, /\.jpg$/, '.jpeg no upload vira .jpg no disco (extensao canonica)');
  });
});

test('DOCX real (Incremento 5): curriculo_texto extraido corretamente via mammoth', async () => {
  await comServidor(async (base) => {
    const email = 'upload.docx-real@teste.com';
    const fd = new FormData();
    fd.set('slug', 'vaga-upload-curriculo');
    fd.set('nome', 'Candidata');
    fd.set('sobrenome', 'Teste');
    fd.set('email', email);
    fd.set('ddi', '+55');
    fd.set('telefone', '11940670469');
    fd.set('consentimento', '1');
    fd.set(
      'curriculo',
      new Blob([DOCX_REAL], { type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' }),
      'curriculo.docx',
    );
    const res = await fetch(`${base}/api/aplicacao`, { method: 'POST', body: fd });
    assert.equal(res.status, 200);

    const app = buscarPorEmail(email);
    assert.ok(app, 'candidatura precisa ter sido criada');
    assert.equal(app.curriculo_texto, 'Walking on imported air');
  });
});

test('JPG e PNG (Incremento 5): curriculo_texto fica vazio, sem lancar erro (decisao: sem OCR)', async () => {
  await comServidor(async (base) => {
    const casos = [
      ['jpg', 'foto.jpg', 'image/jpeg'],
      ['png', 'foto.png', 'image/png'],
    ];
    for (const [ext, nomeArquivo, tipo] of casos) {
      const email = `upload.sem-texto.${ext}@teste.com`;
      const res = await fetch(`${base}/api/aplicacao`, {
        method: 'POST',
        body: formulario({ email, nomeArquivo, tipo, conteudo: `conteudo fake de ${ext}` }),
      });
      assert.equal(res.status, 200, `${ext} deveria ser aceito`);

      const app = buscarPorEmail(email);
      assert.ok(app, `${ext}: candidatura precisa ter sido criada`);
      assert.ok(!app.curriculo_texto, `${ext}: curriculo_texto deveria ficar vazio (veio "${app.curriculo_texto}")`);
    }
  });
});

test('tipo nao aceito (.txt, .doc binario antigo) continua rejeitado com 400', async () => {
  await comServidor(async (base) => {
    const casos = [
      ['txt', 'curriculo.txt', 'text/plain'],
      ['doc', 'curriculo.doc', 'application/msword'],
    ];
    for (const [ext, nomeArquivo, tipo] of casos) {
      const email = `upload.rejeitado.${ext}@teste.com`;
      const res = await fetch(`${base}/api/aplicacao`, {
        method: 'POST',
        body: formulario({ email, nomeArquivo, tipo, conteudo: `conteudo fake de ${ext}` }),
      });
      const corpo = await res.json();
      assert.equal(res.status, 400, `${ext} deveria continuar rejeitado`);
      assert.match(corpo.erro, /PDF, JPG, PNG ou DOCX/i);
      assert.equal(buscarPorEmail(email), undefined);
    }
  });
});
