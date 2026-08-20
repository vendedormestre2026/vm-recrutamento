'use strict';

// Cookie de atribuicao UTM (first-touch), POR VAGA — routes/pages.js (GET /vaga/:slug,
// escreve) + routes/api.js (POST /api/aplicacao, le).
//
// ── O BUG QUE ISTO CORRIGE (investigacao 2026-08-20) ──
// Ate aqui havia UM cookie `vm_utm`, global para o dominio inteiro: a primeira vaga que a
// pessoa abria "vencia" por 30 dias (first-touch), e uma candidatura numa vaga B semanas
// depois herdava a origem da vaga A. Confirmado em producao: 6 candidaturas de teste com
// job_id de vagas variadas e utm_source='deandhela' herdado de uma vaga completamente
// diferente (Instituto Deandhela). A correcao chaveia o cookie por vaga
// (`vm_utm_job_{jobId}`), preservando o first-touch DENTRO da mesma vaga.
//
// ── POR QUE fetch MANUAL DE COOKIE, e nao um jar automatico ──
// O `fetch` nativo do Node nao mantem cookies entre chamadas sozinho. Os testes de
// first-touch/entre-vagas capturam o `Set-Cookie` da 1a resposta e reenviam A MAO na 2a,
// simulando o navegador — mesmo padrao ja usado em test/campanhaCliques.test.js.

const os = require('node:os');
const path = require('node:path');

process.env.DATABASE_PATH = path.join(os.tmpdir(), `vm-test-utm-cookie-${process.pid}-${Date.now()}.db`);
process.env.INTERVIEW_MOCK = 'true';
process.env.SESSION_SECRET = 'segredo-de-teste';
process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert/strict');

const db = require('../src/db');
const { migrar } = require('../src/db/migrate');
const { criarApp } = require('../src/server');

migrar();

const run = (sql, ...p) => Number(db.getDb().prepare(sql).run(...p).lastInsertRowid);

let seq = 0;
function novaVaga() {
  seq += 1;
  const slug = `vaga-utm-cookie-${seq}-${process.pid}`;
  const id = run(
    "INSERT INTO jobs (slug, titulo, perfil, ativo) VALUES (?, 'Vaga de Teste', 'CLOSER', 1)",
    slug,
  );
  return { id, slug };
}

const ultimoAcesso = (jobId) =>
  db
    .getDb()
    .prepare('SELECT * FROM vaga_acessos WHERE job_id = ? ORDER BY id DESC LIMIT 1')
    .get(jobId);

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

// Extrai o valor CRU (nome=valor) de um cookie especifico dos headers Set-Cookie da
// resposta, ou null se aquele cookie nao foi setado nesta resposta.
function extrairSetCookie(res, nome) {
  const bruto = res.headers.getSetCookie ? res.headers.getSetCookie() : [res.headers.get('set-cookie')];
  const linha = (bruto || []).filter(Boolean).find((c) => c.startsWith(`${nome}=`));
  return linha ? linha.split(';')[0] : null;
}

// ══════════════════════════════════════════════════════════════
// 1. Primeira visita a uma vaga com UTM na query -> grava o cookie DAQUELA vaga
// ══════════════════════════════════════════════════════════════

test('primeira visita com UTM na query grava vm_utm_job_{id} daquela vaga', async () => {
  const vaga = novaVaga();

  await comServidor(async (base) => {
    const res = await fetch(`${base}/vaga/${vaga.slug}?utm_source=meta`);
    assert.equal(res.status, 200);

    const cookie = extrairSetCookie(res, `vm_utm_job_${vaga.id}`);
    assert.ok(cookie, `esperava Set-Cookie vm_utm_job_${vaga.id}`);
    assert.match(decodeURIComponent(cookie), /"source":"meta"/);
  });

  const acesso = ultimoAcesso(vaga.id);
  assert.equal(acesso.utm_source, 'meta');
});

// ══════════════════════════════════════════════════════════════
// 2. Segunda visita a MESMA vaga, UTM diferente -> mantem o cookie original (first-touch)
// ══════════════════════════════════════════════════════════════

test('segunda visita a mesma vaga com UTM diferente NAO sobrescreve o cookie (first-touch preservado)', async () => {
  const vaga = novaVaga();

  await comServidor(async (base) => {
    const res1 = await fetch(`${base}/vaga/${vaga.slug}?utm_source=meta`);
    const cookie1 = extrairSetCookie(res1, `vm_utm_job_${vaga.id}`);
    assert.ok(cookie1, 'a primeira visita tem que gravar o cookie');

    // 2a visita, MESMA vaga, UTM diferente na query, reenviando o cookie da 1a (como o
    // navegador faria).
    const res2 = await fetch(`${base}/vaga/${vaga.slug}?utm_source=google`, {
      headers: { Cookie: cookie1 },
    });
    assert.equal(res2.status, 200);

    // Nao pode gravar um Set-Cookie novo (nao ha o que sobrescrever): o cookie ja existia.
    const cookie2 = extrairSetCookie(res2, `vm_utm_job_${vaga.id}`);
    assert.equal(cookie2, null, 'first-touch: a 2a visita nao pode reescrever o cookie');
  });

  // O acesso da 2a visita usa a UTM EFETIVA (a do cookie, 'meta'), nao a nova da query.
  const acesso = ultimoAcesso(vaga.id);
  assert.equal(acesso.utm_source, 'meta', 'a origem registrada continua sendo a da 1a visita');
});

// ══════════════════════════════════════════════════════════════
// 3. Vaga DIFERENTE com cookie de outra vaga ja existente -> NAO herda a origem antiga
// ══════════════════════════════════════════════════════════════

test('visita a vaga DIFERENTE com cookie de outra vaga ja existente: grava a UTM da propria vaga, sem herdar', async () => {
  const vagaA = novaVaga();
  const vagaB = novaVaga();

  await comServidor(async (base) => {
    // Visita a vaga A: grava vm_utm_job_{A} = deandhela.
    const resA = await fetch(`${base}/vaga/${vagaA.slug}?utm_source=deandhela`);
    const cookieA = extrairSetCookie(resA, `vm_utm_job_${vagaA.id}`);
    assert.ok(cookieA, 'a visita a vaga A tem que gravar o cookie dela');

    // Visita a vaga B, DIFERENTE, reenviando o cookie da vaga A (o navegador manda todo
    // cookie do dominio, independente do path) — com UTM propria na query.
    const resB = await fetch(`${base}/vaga/${vagaB.slug}?utm_source=google`, {
      headers: { Cookie: cookieA },
    });
    assert.equal(resB.status, 200);

    // A vaga B tem que gravar o PROPRIO cookie, com a UTM da PROPRIA query — nao pode
    // herdar 'deandhela' da vaga A.
    const cookieB = extrairSetCookie(resB, `vm_utm_job_${vagaB.id}`);
    assert.ok(cookieB, 'a vaga B, sem cookie proprio ainda, tem que gravar o dela');
    assert.match(decodeURIComponent(cookieB), /"source":"google"/);
  });

  const acessoA = ultimoAcesso(vagaA.id);
  const acessoB = ultimoAcesso(vagaB.id);
  assert.equal(acessoA.utm_source, 'deandhela');
  assert.equal(acessoB.utm_source, 'google', 'a vaga B NAO pode herdar a origem da vaga A');
});

// ══════════════════════════════════════════════════════════════
// 4. POST /api/aplicacao le o cookie DA VAGA CERTA (nao herda de outra)
// ══════════════════════════════════════════════════════════════

test('POST /api/aplicacao usa o cookie da vaga da candidatura, nao de outra vaga visitada antes', async () => {
  const vagaA = novaVaga();
  const vagaB = novaVaga();

  await comServidor(async (base) => {
    const resA = await fetch(`${base}/vaga/${vagaA.slug}?utm_source=deandhela`);
    const cookieA = extrairSetCookie(resA, `vm_utm_job_${vagaA.id}`);

    // Candidatura na vaga B, mas o navegador ainda carrega o cookie da vaga A (visitada
    // antes, sem UTM propria desta vez — como alguem que chega direto pelo link de busca).
    const form = new FormData();
    form.set('nome', 'Ana');
    form.set('sobrenome', 'Teste');
    form.set('email', 'ana.teste@example.com');
    form.set('ddi', '+55');
    form.set('telefone', '47999582500');
    form.set('consentimento', 'on');
    form.set('slug', vagaB.slug);
    form.set(
      'curriculo',
      new Blob(['%PDF-1.4 conteudo de teste'], { type: 'application/pdf' }),
      'curriculo.pdf',
    );

    const resPost = await fetch(`${base}/api/aplicacao`, {
      method: 'POST',
      headers: { Cookie: cookieA },
      body: form,
    });
    const json = await resPost.json();
    assert.equal(resPost.status, 200, JSON.stringify(json));
  });

  const app = db
    .getDb()
    .prepare('SELECT utm_source FROM applications WHERE job_id = ? ORDER BY id DESC LIMIT 1')
    .get(vagaB.id);
  assert.equal(app.utm_source, 'direto', 'sem cookie PROPRIO da vaga B, a candidatura e "direto" — nao herda deandhela da vaga A');
});
