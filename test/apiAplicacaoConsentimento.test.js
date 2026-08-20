'use strict';

// POST /api/aplicacao — consentimento LGPD deixou de ser barreira de envio (2026-08-20).
//
// ── O BUG QUE ISTO CORRIGE ──
// O botao "Candidatar-me" ficava disabled ate o checkbox de consentimento ser marcado
// (public/js/app.js), e a rota devolvia 400 sem ele (routes/api.js). Os dois bloqueios
// caiam no mesmo catch generico do fetch no front, que sempre exibia "Falha na sua
// internet" — enganando o candidato sobre a causa real. Consentimento agora e OPCIONAL: a
// candidatura e aceita com ou sem o checkbox marcado, mas SO grava consent_at quando o
// candidato de fato marcou. Gravar a data incondicionalmente registraria um aceite que
// nunca aconteceu — exatamente a premissa que deixou de valer quando o checkbox parou de
// ser obrigatorio (ver o comentario de db.criarAplicacao em src/db/sqlite.js).

const os = require('node:os');
const path = require('node:path');

process.env.DATABASE_PATH = path.join(os.tmpdir(), `vm-test-api-aplicacao-consentimento-${process.pid}-${Date.now()}.db`);
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
    "INSERT INTO jobs (slug, titulo, perfil, empresa, ativo) VALUES ('vaga-teste-consentimento', 'Vaga Teste Consentimento', 'CLOSER', 'Empresa Teste', 1)",
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

// Mesmo padrao de formularioValido() de test/apiAplicacaoTelefone.test.js, com o
// consentimento como parametro (o unico campo relevante para este arquivo).
function formulario({ email, consentimento }) {
  const fd = new FormData();
  fd.set('slug', 'vaga-teste-consentimento');
  fd.set('nome', 'Candidata');
  fd.set('sobrenome', 'Teste');
  fd.set('email', email);
  fd.set('ddi', '+55');
  fd.set('telefone', '11940670469');
  if (consentimento !== undefined) fd.set('consentimento', consentimento);
  fd.set('curriculo', new Blob(['conteudo fake de pdf'], { type: 'application/pdf' }), 'curriculo.pdf');
  return fd;
}

const aplicar = (base, dados) => fetch(`${base}/api/aplicacao`, { method: 'POST', body: formulario(dados) });

const buscarPorEmail = (email) =>
  db.getDb().prepare('SELECT * FROM applications WHERE email = ?').get(email);

test('candidatura SEM marcar consentimento: aceita (200/ok), consent_at fica NULL', async () => {
  await comServidor(async (base) => {
    const email = 'sem.consentimento@teste.com';
    // Campo `consentimento` nem vai no FormData — replica o checkbox desmarcado (o browser
    // nao manda o campo de um checkbox nao marcado).
    const res = await aplicar(base, { email });
    const corpo = await res.json();
    assert.equal(res.status, 200, JSON.stringify(corpo));
    assert.equal(corpo.ok, true, 'consentimento nao pode mais bloquear o envio');

    const app = buscarPorEmail(email);
    assert.ok(app, 'candidatura precisa ter sido criada mesmo sem consentimento');
    assert.equal(app.consent_at, null, 'sem o checkbox marcado, nao ha aceite a registrar');
  });
});

test('candidatura COM consentimento marcado: aceita, consent_at grava um timestamp', async () => {
  await comServidor(async (base) => {
    const antes = new Date();
    const email = 'com.consentimento@teste.com';
    const res = await aplicar(base, { email, consentimento: '1' });
    const corpo = await res.json();
    assert.equal(res.status, 200, JSON.stringify(corpo));
    assert.equal(corpo.ok, true);

    const app = buscarPorEmail(email);
    assert.ok(app, 'candidatura precisa ter sido criada');
    assert.ok(app.consent_at, 'consent_at tem que estar preenchido quando o checkbox foi marcado');
    // Mesmo formato "YYYY-MM-DD HH:MM:SS" que datetime('now') grava no resto do schema —
    // formatarDataHora() (admin.js/relatorioPdf.js) depende desse formato pra exibir a data.
    assert.match(app.consent_at, /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
    // E um timestamp de AGORA, nao um valor fixo/hardcoded.
    const gravado = new Date(`${app.consent_at.replace(' ', 'T')}Z`);
    assert.ok(gravado.getTime() >= antes.getTime() - 5000, 'consent_at tem que refletir o momento do envio');
  });
});
