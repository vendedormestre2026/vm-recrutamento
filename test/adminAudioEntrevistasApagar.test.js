'use strict';

// GET/POST /admin/audio-entrevistas/apagar — exclusao manual do audio de entrevistas
// CONCLUIDAS sem video confirmado no Drive (decisao consciente do Rafael, 2026-08-21: sem
// video em lugar nenhum, esse audio deixou de ser util). Mesmo espirito de seguranca do
// backup de curriculos: GET e dry-run real; POST exige confirmacao checada no SERVIDOR;
// a lista elegivel e sempre consultada de novo no servidor, nunca aceita do corpo do POST.
//
// O LIMITE MAIS IMPORTANTE: entrevista 'iniciada' (em andamento) NUNCA pode ser afetada —
// o audio da Vera ainda esta sendo servido ativamente pro candidato nesse estado.

const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');

// Pasta PROPRIA (nao so um arquivo direto em os.tmpdir()): config.caminhoEntrevistas nao
// tem override por env (diferente de caminhoCurriculosTalentos) — e sempre
// path.dirname(DATABASE_PATH) + '/entrevistas'. Se DATABASE_PATH morasse direto em
// os.tmpdir(), TODO arquivo de teste que seguisse esse padrao resolveria pro MESMO
// os.tmpdir()/entrevistas — e node:test roda arquivos em paralelo, entao o test.after
// deste arquivo (que apaga a pasta inteira) poderia arrancar o tapete de outro teste
// rodando ao mesmo tempo. Uma pasta mkdtemp exclusiva isola completamente.
const pastaTeste = fs.mkdtempSync(path.join(os.tmpdir(), 'vm-test-audio-entrevistas-apagar-'));
process.env.DATABASE_PATH = path.join(pastaTeste, 'app.db');
process.env.INTERVIEW_MOCK = 'true';
process.env.SESSION_SECRET = 'segredo-de-teste';
process.env.ADMIN_USER = 'admin-teste';
process.env.ADMIN_PASSWORD = 'senha-teste';
process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert/strict');

const { config } = require('../src/config');
const db = require('../src/db');
const { migrar } = require('../src/db/migrate');
const { criarApp } = require('../src/server');

migrar();

const run = (sql, ...p) => Number(db.getDb().prepare(sql).run(...p).lastInsertRowid);

const jobId = run(
  "INSERT INTO jobs (slug, titulo, perfil, empresa, ativo) VALUES ('vaga-audio-apagar', 'Vaga Audio Apagar', 'CLOSER', 'Empresa Teste', 1)",
);

let seq = 0;
function criarInterview({ status, videoUrl = null, finalizadoEm = '2025-01-01 10:00:00', nome = 'Fulano' }) {
  seq += 1;
  const appId = run(
    "INSERT INTO applications (job_id, nome, sobrenome, email, telefone, token, status, criado_em) VALUES (?, ?, 'Teste', 'x@x.com', '+5511999998888', ?, 'aplicado', '2025-01-01 09:00:00')",
    jobId,
    nome,
    `tok-audio-apagar-${seq}`,
  );
  return run(
    "INSERT INTO interviews (application_id, perfil, status, video_url, finalizado_em) VALUES (?, 'CLOSER', ?, ?, ?)",
    appId,
    status,
    videoUrl,
    finalizadoEm,
  );
}

function criarAudioFake(interviewId) {
  const dir = path.join(config.caminhoEntrevistas, String(interviewId));
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'vera-1.mp3'), 'x'.repeat(1024));
  fs.writeFileSync(path.join(dir, 'resposta-1.webm'), 'y'.repeat(1024));
  return dir;
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

const audioRemovidoEm = (interviewId) =>
  db.getDb().prepare('SELECT audio_removido_em FROM interviews WHERE id = ?').get(interviewId).audio_removido_em;

// ══════════════════ GET (pre-visualizacao) — dry-run de verdade ══════════════════

test('GET /audio-entrevistas/apagar: dry-run real — nada e apagado nem marcado so de acessar', async () => {
  const id = criarInterview({ status: 'concluido', nome: 'Preview' });
  const dir = criarAudioFake(id);

  await comServidor(async (base) => {
    if (!cookieAdmin) await autenticar(base);
    const res = await fetch(`${base}/admin/audio-entrevistas/apagar`, { headers: { Cookie: cookieAdmin } });
    assert.equal(res.status, 200);
    const html = await res.text();
    assert.match(html, /confirmo_exclusao/);
    assert.match(html, /IRREVERS/);
  });

  assert.ok(fs.existsSync(dir), 'a pasta de audio tem que continuar existindo apos so pre-visualizar');
  assert.equal(audioRemovidoEm(id), null);
});

// ══════════════════ POST sem confirmacao ══════════════════

test('POST /audio-entrevistas/apagar SEM confirmo_exclusao: rejeita, nada e apagado nem marcado', async () => {
  const id = criarInterview({ status: 'concluido', nome: 'SemConfirmacao' });
  const dir = criarAudioFake(id);

  await comServidor(async (base) => {
    if (!cookieAdmin) await autenticar(base);
    const res = await fetch(`${base}/admin/audio-entrevistas/apagar`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Cookie: cookieAdmin },
      body: '',
    });
    assert.equal(res.status, 400);
  });

  assert.ok(fs.existsSync(dir));
  assert.equal(audioRemovidoEm(id), null);
});

// ══════════════════ POST com confirmacao — caso feliz + limites de seguranca ══════════════════

test('POST com confirmo_exclusao=1: apaga so o audio elegivel — "iniciada" e "com video" ficam intocados', async () => {
  const elegivel = criarInterview({ status: 'concluido', nome: 'Elegivel2' });
  const dirElegivel = criarAudioFake(elegivel);

  const emAndamento = criarInterview({ status: 'iniciada', finalizadoEm: null, nome: 'EmAndamento2' });
  const dirEmAndamento = criarAudioFake(emAndamento);

  const comVideo = criarInterview({ status: 'concluido', videoUrl: 'https://drive/y', nome: 'ComVideo2' });
  const dirComVideo = criarAudioFake(comVideo);

  await comServidor(async (base) => {
    if (!cookieAdmin) await autenticar(base);
    const res = await fetch(`${base}/admin/audio-entrevistas/apagar`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Cookie: cookieAdmin },
      body: 'confirmo_exclusao=1',
      redirect: 'manual',
    });
    assert.equal(res.status, 302);
    assert.match(res.headers.get('location'), /\/admin\/config\?audio_apagado=\d+&audio_mb=/);
  });

  assert.ok(!fs.existsSync(dirElegivel), 'a pasta de audio elegivel tem que ter sido apagada');
  assert.ok(audioRemovidoEm(elegivel), 'audio_removido_em tem que estar preenchido');

  assert.ok(fs.existsSync(dirEmAndamento), 'entrevista em ANDAMENTO nunca pode ter o audio apagado');
  assert.equal(audioRemovidoEm(emAndamento), null);

  assert.ok(fs.existsSync(dirComVideo), 'entrevista COM video (ja coberta pela limpeza automatica) nao entra aqui');
  assert.equal(audioRemovidoEm(comVideo), null);
});

test('GET apos a exclusao: nao lista mais a entrevista ja processada', async () => {
  const id = criarInterview({ status: 'concluido', nome: 'ProcessarEChecar' });
  criarAudioFake(id);

  await comServidor(async (base) => {
    if (!cookieAdmin) await autenticar(base);
    await fetch(`${base}/admin/audio-entrevistas/apagar`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Cookie: cookieAdmin },
      body: 'confirmo_exclusao=1',
    });

    // So essa entrevista (mais qualquer sobra de outros testes) deve ter sido tratada;
    // o que importa aqui e que ELA especificamente nao aparece mais.
    const preview = await fetch(`${base}/admin/audio-entrevistas/apagar`, { headers: { Cookie: cookieAdmin } });
    const html = await preview.text();
    assert.doesNotMatch(html, /ProcessarEChecar/);
  });
});

test.after(() => {
  fs.rmSync(pastaTeste, { recursive: true, force: true });
});
