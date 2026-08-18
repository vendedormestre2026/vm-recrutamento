'use strict';

// GET /admin/candidato/:id/curriculo e GET /admin/talentos/:id/curriculo — o download passa
// a usar o Content-Type e a extensao REAIS do arquivo em disco, nao mais fixos em
// application/pdf/.pdf (Incremento 2 do prompt de upload de curriculo em JPG/PNG/DOCX).
//
// ── POR QUE GRAVAR O ARQUIVO DIRETO, SEM PASSAR PELO UPLOAD ──
// O fileFilter do multer (routes/api.js) so aceita PDF ate o Incremento 3 ampliar — nao da
// pra chegar num candidato com curriculo_path=".jpg" pelo fluxo publico ainda. Este teste
// cobre o lado do DOWNLOAD isoladamente: grava o arquivo no disco e o caminho no banco
// direto, do mesmo jeito que o Incremento 1 (upload) vai deixar depois do Incremento 3.

const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');

process.env.DATABASE_PATH = path.join(os.tmpdir(), `vm-test-admin-download-curriculo-${process.pid}-${Date.now()}.db`);
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
const { config } = require('../src/config');

migrar();

const run = (sql, ...p) => Number(db.getDb().prepare(sql).run(...p).lastInsertRowid);
const exec = (sql, ...p) => db.getDb().prepare(sql).run(...p);

let cookieAdmin = '';
let seq = 0;

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

async function autenticar(base) {
  const res = await fetch(`${base}/admin/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ usuario: 'admin-teste', senha: 'senha-teste' }),
    redirect: 'manual',
  });
  const bruto = res.headers.getSetCookie ? res.headers.getSetCookie() : [res.headers.get('set-cookie')];
  cookieAdmin = bruto.filter(Boolean).map((c) => c.split(';')[0]).join('; ');
  assert.ok(cookieAdmin.includes('vm_admin'));
}

const comAuth = (extra = {}) => ({ Cookie: cookieAdmin, ...extra });

function gravarArquivoFake(pasta, nomeBase, extensao, conteudo = 'conteudo fake de curriculo') {
  fs.mkdirSync(pasta, { recursive: true });
  const caminho = path.join(pasta, `${nomeBase}.${extensao}`);
  fs.writeFileSync(caminho, conteudo);
  return caminho;
}

function criarCandidatoComCurriculo(extensao) {
  seq += 1;
  const jobId = run(
    "INSERT INTO jobs (slug, titulo, perfil, empresa, ativo) VALUES (?, 'Vaga Download', 'CLOSER', 'Empresa', 1)",
    `vaga-download-${seq}`,
  );
  const caminho = gravarArquivoFake(config.caminhoCurriculos, `curriculo-cand-${seq}`, extensao);
  const id = run(
    "INSERT INTO applications (job_id, nome, sobrenome, email, telefone, token, curriculo_path) VALUES (?, 'Ana', 'Silva', ?, '+5511999999999', ?, ?)",
    jobId,
    `ana-download-${seq}@x.co`,
    `tok-download-${seq}`,
    caminho,
  );
  return id;
}

function criarTalentoComCurriculo(extensao) {
  seq += 1;
  const caminho = gravarArquivoFake(config.caminhoCurriculosTalentos, `curriculo-tal-${seq}`, extensao);
  return run(
    "INSERT INTO talentos (nome, email, telefone, curriculo_path) VALUES (?, ?, '+5511999999999', ?)",
    `Talento ${seq}`,
    `talento-download-${seq}@x.co`,
    caminho,
  );
}

function zerar() {
  exec('DELETE FROM applications');
  exec('DELETE FROM jobs');
  exec('DELETE FROM talentos');
}

test('download de curriculo .jpg do candidato: Content-Type image/jpeg, nome de arquivo .jpg (nao .pdf)', async () => {
  zerar();
  const id = criarCandidatoComCurriculo('jpg');
  await comServidor(async (base) => {
    await autenticar(base);
    const res = await fetch(`${base}/admin/candidato/${id}/curriculo`, { headers: comAuth() });
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type'), /^image\/jpeg/);
    const disposicao = res.headers.get('content-disposition');
    assert.match(disposicao, /\.jpg"/);
    assert.doesNotMatch(disposicao, /\.pdf/);
  });
});

test('download de curriculo .docx do candidato: Content-Type correto, extensao .docx', async () => {
  zerar();
  const id = criarCandidatoComCurriculo('docx');
  await comServidor(async (base) => {
    await autenticar(base);
    const res = await fetch(`${base}/admin/candidato/${id}/curriculo`, { headers: comAuth() });
    assert.equal(res.status, 200);
    assert.match(
      res.headers.get('content-type'),
      /^application\/vnd\.openxmlformats-officedocument\.wordprocessingml\.document/,
    );
    assert.match(res.headers.get('content-disposition'), /\.docx"/);
  });
});

test('download de curriculo .pdf do candidato continua igual (nao regrediu)', async () => {
  zerar();
  const id = criarCandidatoComCurriculo('pdf');
  await comServidor(async (base) => {
    await autenticar(base);
    const res = await fetch(`${base}/admin/candidato/${id}/curriculo`, { headers: comAuth() });
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type'), /^application\/pdf/);
    assert.match(res.headers.get('content-disposition'), /\.pdf"/);
  });
});

test('extensao desconhecida cai em application/octet-stream, nao mente que e PDF', async () => {
  zerar();
  const id = criarCandidatoComCurriculo('xyz');
  await comServidor(async (base) => {
    await autenticar(base);
    const res = await fetch(`${base}/admin/candidato/${id}/curriculo`, { headers: comAuth() });
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type'), /^application\/octet-stream/);
  });
});

test('download de curriculo .png do TALENTO (banco de talentos): Content-Type image/png', async () => {
  zerar();
  const id = criarTalentoComCurriculo('png');
  await comServidor(async (base) => {
    await autenticar(base);
    const res = await fetch(`${base}/admin/talentos/${id}/curriculo`, { headers: comAuth() });
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type'), /^image\/png/);
    assert.match(res.headers.get('content-disposition'), /\.png"/);
  });
});

test('botao "Baixar currículo" nao presume mais PDF no rotulo (candidato e talento)', async () => {
  zerar();
  const idCand = criarCandidatoComCurriculo('jpg');
  const idTal = criarTalentoComCurriculo('png');
  await comServidor(async (base) => {
    await autenticar(base);
    const htmlCand = await (await fetch(`${base}/admin/candidato/${idCand}`, { headers: comAuth() })).text();
    assert.match(htmlCand, />Baixar currículo</);
    assert.doesNotMatch(htmlCand, /Baixar currículo \(PDF\)/);

    const htmlTal = await (await fetch(`${base}/admin/talentos/${idTal}`, { headers: comAuth() })).text();
    assert.match(htmlTal, />Baixar currículo</);
    assert.doesNotMatch(htmlTal, /Baixar currículo \(PDF\)/);
  });
});
