'use strict';

// POST /api/aplicacao — validacao ESTRITA de telefone (Incremento 2 do prompt de prevencao
// de telefone invalido). Antes deste incremento, o telefone era aceito e gravado cru,
// concatenado por string (ddi + " " + telefoneNum), sem checagem nenhuma alem de "nao
// vazio" — foi assim que os 3 casos reais (Samara, Juliana, Maria) chegaram a
// applications.telefone malformados e a sequencia WA1/WA2 nunca disparou pra eles.
//
// ── POR QUE HTTP, e nao teste de unidade de validarTelefoneBrEstrito ──
// A logica pura ja tem cobertura em test/whatsapp.test.js. O que ESTE arquivo garante e a
// LIGACAO: que a rota de fato chama a validacao ANTES de gravar, e que o valor gravado em
// applications.telefone e o normalizado, nao o cru. Isso e exatamente onde o bug anterior
// vivia — a funcao de validacao podia estar certa e o write boundary nao a chamar.

const os = require('node:os');
const path = require('node:path');

process.env.DATABASE_PATH = path.join(os.tmpdir(), `vm-test-api-aplicacao-telefone-${process.pid}-${Date.now()}.db`);
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
    "INSERT INTO jobs (slug, titulo, perfil, empresa, ativo) VALUES ('vaga-teste-telefone', 'Vaga Teste Telefone', 'CLOSER', 'Empresa Teste', 1)",
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

// Monta o FormData que a Tela 2 envia: campos obrigatorios + PDF fake (multer so confere
// mimetype/extensao declarados, nao o conteudo — pdf-parse falha em silencio e devolve
// texto vazio, sem quebrar a rota; ver lib/curriculo.js).
function formularioValido({ ddi = '+55', telefone, email }) {
  const fd = new FormData();
  fd.set('slug', 'vaga-teste-telefone');
  fd.set('nome', 'Candidata');
  fd.set('sobrenome', 'Teste');
  fd.set('email', email);
  fd.set('ddi', ddi);
  fd.set('telefone', telefone);
  fd.set('consentimento', '1');
  fd.set('curriculo', new Blob(['conteudo fake de pdf'], { type: 'application/pdf' }), 'curriculo.pdf');
  return fd;
}

const aplicar = (base, dados) => fetch(`${base}/api/aplicacao`, { method: 'POST', body: formularioValido(dados) });

const buscarPorEmail = (email) =>
  db.getDb().prepare('SELECT * FROM applications WHERE email = ?').get(email);

test('telefone valido BR (11 digitos): aceito, gravado normalizado (+DDI+DDD+numero)', async () => {
  await comServidor(async (base) => {
    const email = 'candidata.valida@teste.com';
    const res = await aplicar(base, { telefone: '11940670469', email });
    const corpo = await res.json();
    assert.equal(res.status, 200, JSON.stringify(corpo));
    assert.equal(corpo.ok, true);

    const app = buscarPorEmail(email);
    assert.ok(app, 'candidatura precisa ter sido criada');
    // Gravado normalizado — so digitos com '+', SEM o espaco/concatenacao cru de antes.
    assert.equal(app.telefone, '+5511940670469');
  });
});

test('caso Maria (DDI duplicado no campo de digitos): rejeitado com 400, nada gravado', async () => {
  await comServidor(async (base) => {
    const email = 'candidata.maria@teste.com';
    // Replica o dado real: ddi do <select> ("+55") + telefoneNum com o "+55" digitado de
    // novo pela candidata ("+5511985761491") -> concatenado vira "+55 +5511985761491".
    const res = await aplicar(base, { ddi: '+55', telefone: '+5511985761491', email });
    const corpo = await res.json();
    assert.equal(res.status, 400, JSON.stringify(corpo));
    assert.equal(corpo.ok, false);
    assert.match(corpo.erro, /telefone/i);
    assert.equal(buscarPorEmail(email), undefined, 'nao pode ter gravado candidatura com telefone invalido');
  });
});

test('caso Samara (1 digito faltando, fixo com 8 digitos comecando em 6): rejeitado com 400', async () => {
  await comServidor(async (base) => {
    const email = 'candidata.samara@teste.com';
    const res = await aplicar(base, { telefone: '2169912185', email });
    const corpo = await res.json();
    assert.equal(res.status, 400, JSON.stringify(corpo));
    assert.equal(corpo.ok, false);
    assert.equal(buscarPorEmail(email), undefined);
  });
});

test('numero internacional (+351, Portugal): rejeitado com 400 — decisao de produto, nao bug', async () => {
  // So aceita BR de proposito (contrato deste formulario). Um numero internacional CORRETO
  // (caso real ja documentado: applications id 741, "+351 912437103") e rejeitado aqui —
  // isso e o comportamento esperado apos a decisao de produto, nao uma regressao.
  await comServidor(async (base) => {
    const email = 'candidato.portugal@teste.com';
    const res = await aplicar(base, { ddi: '+351', telefone: '912437103', email });
    const corpo = await res.json();
    assert.equal(res.status, 400, JSON.stringify(corpo));
    assert.equal(buscarPorEmail(email), undefined);
  });
});
