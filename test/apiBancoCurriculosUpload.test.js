'use strict';

// POST /api/banco-curriculos — upload de curriculo, espelhando a cobertura de
// apiAplicacaoUploadCurriculo.test.js (Incremento 3 do prompt de upload em JPG/PNG/DOCX).
// Este router (api_banco_curriculos.js) tem seu PROPRIO multer, independente do de
// routes/api.js — por decisao explicita, os dois ficam como implementacoes espelhadas
// (nao deduplicadas) nesta tarefa. Por isso a MESMA bateria de casos precisa ser provada
// aqui de novo: nao ha garantia estrutural de que os dois fileFilter concordem, so a
// disciplina de manter os testes em paridade.
//
// Nao havia nenhum teste HTTP para esta rota antes deste arquivo.

const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');

process.env.DATABASE_PATH = path.join(os.tmpdir(), `vm-test-upload-banco-curriculos-${process.pid}-${Date.now()}.db`);
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
  fd.set('nome', 'Candidata Banco');
  fd.set('email', email);
  fd.set('ddi', '+55');
  fd.set('telefone', '11940670469');
  fd.set('perfil_interesse', 'SDR');
  fd.set('consentimento', '1');
  fd.set('curriculo', new Blob([conteudo], { type: tipo }), nomeArquivo);
  return fd;
}

const buscarPorEmail = (email) => db.getDb().prepare('SELECT * FROM talentos WHERE email = ?').get(email);

test('PDF, JPG, PNG e DOCX sao aceitos: 200, curriculo_path com a extensao certa', async () => {
  await comServidor(async (base) => {
    const casos = [
      ['pdf', 'curriculo.pdf', 'application/pdf'],
      ['jpg', 'foto.jpg', 'image/jpeg'],
      ['png', 'foto.png', 'image/png'],
      ['docx', 'curriculo.docx', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'],
    ];
    for (const [ext, nomeArquivo, tipo] of casos) {
      const email = `banco.${ext}@teste.com`;
      const res = await fetch(`${base}/api/banco-curriculos`, {
        method: 'POST',
        body: formulario({ email, nomeArquivo, tipo, conteudo: `conteudo fake de ${ext}` }),
      });
      const corpo = await res.json();
      assert.equal(res.status, 200, `${ext}: ${JSON.stringify(corpo)}`);

      const talento = buscarPorEmail(email);
      assert.ok(talento, `${ext}: cadastro precisa ter sido criado`);
      assert.match(talento.curriculo_path, new RegExp(`\\.${ext}$`), `${ext}: extensao errada em curriculo_path`);
      assert.equal(fs.existsSync(talento.curriculo_path), true, `${ext}: arquivo precisa existir no disco`);
    }
  });
});

test('.jpeg (variante de JPEG) e aceito e salvo com extensao canonica .jpg', async () => {
  await comServidor(async (base) => {
    const email = 'banco.jpeg-variante@teste.com';
    const res = await fetch(`${base}/api/banco-curriculos`, {
      method: 'POST',
      body: formulario({ email, nomeArquivo: 'foto.jpeg', tipo: 'image/jpeg', conteudo: 'conteudo fake de jpeg' }),
    });
    assert.equal(res.status, 200);
    const talento = buscarPorEmail(email);
    assert.match(talento.curriculo_path, /\.jpg$/);
  });
});

test('tipo nao aceito (.txt, .doc binario antigo) e rejeitado com 400, mensagem lista os formatos aceitos', async () => {
  await comServidor(async (base) => {
    const casos = [
      ['txt', 'curriculo.txt', 'text/plain'],
      ['doc', 'curriculo.doc', 'application/msword'],
    ];
    for (const [ext, nomeArquivo, tipo] of casos) {
      const email = `banco.rejeitado.${ext}@teste.com`;
      const res = await fetch(`${base}/api/banco-curriculos`, {
        method: 'POST',
        body: formulario({ email, nomeArquivo, tipo, conteudo: `conteudo fake de ${ext}` }),
      });
      const corpo = await res.json();
      assert.equal(res.status, 400, `${ext} deveria ser rejeitado`);
      assert.match(corpo.erro, /PDF, JPG, PNG ou DOCX/i);
      assert.equal(buscarPorEmail(email), undefined);
    }
  });
});
