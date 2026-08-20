'use strict';

// GET /admin/curriculos-backup — exporta em .tar.gz os curriculos de candidatura
// anteriores a uma data (backup manual, /data/curriculos nao tem limpeza automatica).
//
// Cobertura: sem ?antes -> erro amigavel; nenhuma candidatura elegivel -> aviso sem gerar
// arquivo; caso feliz -> headers e corpo corretos (tar.gz de verdade, extraido e conferido);
// pasta temporaria sempre removida, inclusive quando o unico elegivel tem o arquivo
// ausente no disco (o "erro simulado" no meio do processo).

const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');
const { execFileSync } = require('node:child_process');

process.env.DATABASE_PATH = path.join(os.tmpdir(), `vm-test-curriculos-backup-${process.pid}-${Date.now()}.db`);
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
  "INSERT INTO jobs (slug, titulo, perfil, empresa, ativo) VALUES ('vaga-backup-curriculo', 'Vaga Backup', 'CLOSER', 'Empresa Teste', 1)",
);

// Pasta REAL de curriculos de teste (arquivos de verdade em disco, fora de /data — este
// processo nao roda no container).
const pastaCurriculosTeste = fs.mkdtempSync(path.join(os.tmpdir(), 'vm-test-curriculos-fonte-'));

function criarApplication({ criado_em, curriculo_path, nome = 'Fulano', sobrenome = 'Teste' }) {
  return run(
    `INSERT INTO applications (job_id, nome, sobrenome, email, telefone, curriculo_path, token, status, criado_em)
     VALUES (?, ?, ?, 'x@x.com', '+5511999998888', ?, ?, 'aplicado', ?)`,
    jobId,
    nome,
    sobrenome,
    curriculo_path,
    `tok-${nome}-${sobrenome}-${Math.random()}`,
    criado_em,
  );
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

// Pastas temporarias de backup (vm-curriculos-backup-*) atualmente no tmpdir do SO —
// usado para confirmar que a rota nao deixa lixo pra tras.
function pastasBackupNoTmp() {
  return fs.readdirSync(os.tmpdir()).filter((n) => n.startsWith('vm-curriculos-backup-'));
}

// A limpeza da pasta temporaria roda no handler 'close' do processo `tar` (server-side),
// um evento assincrono que pode terminar um instante DEPOIS do fetch() do teste ja ter
// resolvido (o corpo da resposta acaba quando o stdout do tar termina, nao quando o
// processo fecha). Por isso o teste espera a convergencia em vez de comparar um
// antes/depois no mesmo tick — evita flakiness por corrida entre teste e cleanup.
async function esperarPastasBackupVazio(timeoutMs = 1000) {
  const fim = Date.now() + timeoutMs;
  while (Date.now() < fim) {
    if (pastasBackupNoTmp().length === 0) return true;
    await new Promise((r) => setTimeout(r, 20));
  }
  return pastasBackupNoTmp().length === 0;
}

test('sem ?antes: erro amigavel (400), nao 500/stack trace', async () => {
  await comServidor(async (base) => {
    if (!cookieAdmin) await autenticar(base);
    const res = await fetch(`${base}/admin/curriculos-backup`, { headers: { Cookie: cookieAdmin } });
    assert.equal(res.status, 400);
    const html = await res.text();
    assert.match(html, /Data inválida/);
  });
});

test('?antes= com formato invalido: mesmo erro amigavel', async () => {
  await comServidor(async (base) => {
    if (!cookieAdmin) await autenticar(base);
    const res = await fetch(`${base}/admin/curriculos-backup?antes=31-12-2025`, { headers: { Cookie: cookieAdmin } });
    assert.equal(res.status, 400);
  });
});

test('nenhuma candidatura elegivel: avisoAdmin, sem gerar arquivo (Content-Type nao e gzip)', async () => {
  await comServidor(async (base) => {
    if (!cookieAdmin) await autenticar(base);
    const res = await fetch(`${base}/admin/curriculos-backup?antes=1990-01-01`, { headers: { Cookie: cookieAdmin } });
    assert.equal(res.status, 200);
    assert.doesNotMatch(String(res.headers.get('content-type')), /gzip/);
    const html = await res.text();
    assert.match(html, /Nenhum currículo/);
  });
});

test('caso feliz: tar.gz valido com manifesto.csv e PDFs de nome legivel', async () => {
  const arquivoReal = path.join(pastaCurriculosTeste, 'token-opaco-1.pdf');
  fs.writeFileSync(arquivoReal, 'conteudo do pdf de teste');
  const idIncluido = criarApplication({
    criado_em: '2025-01-15 10:00:00',
    curriculo_path: arquivoReal,
    nome: 'Joana',
    sobrenome: 'Pereira',
  });
  // Candidatura POSTERIOR ao corte: nao pode entrar no pacote.
  criarApplication({
    criado_em: '2026-01-01 10:00:00',
    curriculo_path: arquivoReal,
    nome: 'DepoisDoCorte',
    sobrenome: 'X',
  });

  await comServidor(async (base) => {
    if (!cookieAdmin) await autenticar(base);
    const res = await fetch(`${base}/admin/curriculos-backup?antes=2025-06-01`, { headers: { Cookie: cookieAdmin } });
    assert.equal(res.status, 200);
    assert.match(String(res.headers.get('content-type')), /gzip/);
    assert.match(
      String(res.headers.get('content-disposition')),
      /attachment; filename="curriculos-backup-ate-2025-06-01\.tar\.gz"/,
    );

    const buf = Buffer.from(await res.arrayBuffer());
    assert.ok(buf.length > 0, 'o corpo da resposta nao pode estar vazio');

    // Extrai de verdade e confere o conteudo (nao so os headers).
    const pastaExtracao = fs.mkdtempSync(path.join(os.tmpdir(), 'vm-test-extracao-'));
    try {
      const tgz = path.join(pastaExtracao, 'pacote.tar.gz');
      fs.writeFileSync(tgz, buf);
      execFileSync('tar', ['-xzf', tgz, '-C', pastaExtracao]);
      const arquivos = fs.readdirSync(pastaExtracao).filter((n) => n !== 'pacote.tar.gz');
      assert.ok(arquivos.includes('manifesto.csv'), 'manifesto.csv tem que estar no pacote');
      assert.ok(
        arquivos.some((n) => n === `${idIncluido}_Joana_Pereira.pdf`),
        'PDF tem que entrar com nome legivel (id_nome_sobrenome), nao o token opaco',
      );
      assert.ok(!arquivos.some((n) => n.includes('DepoisDoCorte')), 'candidatura posterior ao corte nao pode estar no pacote');

      const manifesto = fs.readFileSync(path.join(pastaExtracao, 'manifesto.csv'), 'utf8');
      assert.match(manifesto, /id,nome,sobrenome,email,telefone,vaga,data_candidatura,nome_arquivo_no_pacote/);
      assert.match(manifesto, new RegExp(`${idIncluido},Joana,Pereira,x@x\\.com`));
      assert.match(manifesto, /Vaga Backup/);
    } finally {
      fs.rmSync(pastaExtracao, { recursive: true, force: true });
    }
  });
});

test('arquivo elegivel ausente no disco (erro simulado no meio do processo): aviso amigavel E a pasta temporaria e removida', async () => {
  // Isola do teste anterior (caso feliz), que deixou candidaturas com arquivo REAL no
  // mesmo recorte de data — sem isso, aquele arquivo real entraria no pacote e o cenario
  // "nada elegivel sobra" deixaria de acontecer.
  db.getDb().prepare('DELETE FROM applications').run();

  // Baseline limpa: espera o cleanup assincrono do teste anterior (caso feliz, que gerou
  // tar de verdade) terminar antes de comecar este cenario.
  assert.ok(await esperarPastasBackupVazio(), 'baseline: tmp deveria estar limpo antes deste teste');

  const caminhoInexistente = path.join(pastaCurriculosTeste, 'este-arquivo-nao-existe.pdf');
  criarApplication({
    criado_em: '2025-01-20 10:00:00',
    curriculo_path: caminhoInexistente,
    nome: 'SoNoBanco',
    sobrenome: 'SemArquivo',
  });

  await comServidor(async (base) => {
    if (!cookieAdmin) await autenticar(base);
    const res = await fetch(`${base}/admin/curriculos-backup?antes=2025-06-15`, { headers: { Cookie: cookieAdmin } });
    // So essa candidatura (SoNoBanco) esta no recorte de data e o arquivo dela nao existe
    // no disco -> nenhum arquivo real sobra -> mesmo aviso de "nada pra exportar".
    assert.equal(res.status, 200);
    assert.doesNotMatch(String(res.headers.get('content-type')), /gzip/);
  });

  assert.ok(await esperarPastasBackupVazio(), 'nenhuma pasta temporaria de backup pode sobrar em /tmp');
});

test.after(() => {
  fs.rmSync(pastaCurriculosTeste, { recursive: true, force: true });
});
