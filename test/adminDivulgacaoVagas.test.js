'use strict';

// Redesenho de /admin/divulgacao-vagas (2026-08-27): deixa de embutir os fragmentos
// INTEIROS de /admin/promocao e /admin/campanhas-whatsapp (as antigas "abas") e vira uma
// tela-resumo fixa e somente leitura — as 5 campanhas mais recentes de cada canal, com
// links diretos pras telas completas (que continuam existindo, inalteradas).
//
// Cobre:
//   1. exige sessao (herda o adminAuth, como as demais rotas do painel);
//   2. GET 200, <h1>Promoção de Vagas</h1> uma UNICA vez, menu com os 2 links diretos
//      (rotulos "Campanha por Email"/"Campanha por WhatsApp") pras rotas standalone;
//   3. os 2 botões "Ir para Campanhas de Email"/"Ir para Campanhas de Whatsapp" (texto
//      EXATO) apontando pras mesmas rotas;
//   4. campanhas de e-mail e de WhatsApp cadastradas aparecem na coluna certa, e o corte
//      em 5 e respeitado (a 6a mais antiga NAO aparece);
//   5. as rotas standalone /admin/promocao e /admin/campanhas-whatsapp continuam
//      respondendo 200 com seu proprio <h1>, sem alteracao de comportamento.
//
// Nao ha mais `?aba=` nesta pagina — os testes antigos que dependiam dela foram
// substituidos, nao adaptados (o comportamento em si deixou de existir).

const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');

const TMP_DB = path.join(os.tmpdir(), `vm-test-divulgacao-vagas-${process.pid}-${Date.now()}.db`);
process.env.DATABASE_PATH = TMP_DB;
process.env.INTERVIEW_MOCK = 'true';
process.env.SESSION_SECRET = 'segredo-de-teste';
process.env.ADMIN_PASSWORD = 'senha-teste';
process.env.ADMIN_USER = 'admin';
process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert/strict');

const db = require('../src/db');
const { migrar } = require('../src/db/migrate');
const { criarApp } = require('../src/server');

const SECRET = process.env.SESSION_SECRET;
const SENHA = process.env.ADMIN_PASSWORD;

function cookieAdmin() {
  const sig = crypto.createHmac('sha256', SECRET).update(SENHA).digest('base64').replace(/=+$/, '');
  return `vm_admin=${encodeURIComponent(`s:${SENHA}.${sig}`)}`;
}

async function getHtml(caminho, comAuth = true) {
  const app = criarApp();
  const server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const opts = comAuth ? { headers: { Cookie: cookieAdmin() } } : { redirect: 'manual' };
    const res = await fetch(`${base}${caminho}`, opts);
    return { status: res.status, location: res.headers.get('location'), html: res.status < 300 ? await res.text() : '' };
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

// Conta ocorrencias de uma substring — usado pra afirmar "uma UNICA vez", nao so "existe".
function contarOcorrencias(html, trecho) {
  return html.split(trecho).length - 1;
}

const exec = (sql, ...p) => db.getDb().prepare(sql).run(...p);
const run = (sql, ...p) => Number(db.getDb().prepare(sql).run(...p).lastInsertRowid);

test.before(() => {
  migrar();
});

test('GET /admin/divulgacao-vagas sem auth -> redireciona para o login', async () => {
  const r = await getHtml('/admin/divulgacao-vagas', false);
  assert.equal(r.status, 302);
  assert.match(r.location || '', /\/admin\/login/);
});

test('GET /admin/divulgacao-vagas: 200, <h1>Promoção de Vagas</h1> uma única vez', async () => {
  const { status, html } = await getHtml('/admin/divulgacao-vagas');
  assert.equal(status, 200);
  assert.equal(contarOcorrencias(html, '<h1>Promoção de Vagas</h1>'), 1);
});

test('menu do topo: links diretos pras 2 telas completas, com os rótulos certos', async () => {
  const { html } = await getHtml('/admin/divulgacao-vagas');
  assert.match(html, /<a class="btn btn--ghost" href="\/admin\/promocao">Campanha por Email<\/a>/);
  assert.match(html, /<a class="btn btn--ghost" href="\/admin\/campanhas-whatsapp">Campanha por WhatsApp<\/a>/);
  assert.match(html, /<a class="btn btn--ghost" href="\/admin">← Voltar ao painel<\/a>/);
});

test('os 2 botões "Ir para Campanhas de..." usam o texto EXATO e apontam pras rotas certas', async () => {
  const { html } = await getHtml('/admin/divulgacao-vagas');
  assert.match(html, /<a class="btn" href="\/admin\/promocao">Ir para Campanhas de Email<\/a>/);
  assert.match(html, /<a class="btn" href="\/admin\/campanhas-whatsapp">Ir para Campanhas de Whatsapp<\/a>/);
});

test('sem nenhuma campanha cadastrada: mostra "Nenhuma campanha criada ainda." nas 2 colunas, sem quebrar', async () => {
  const { status, html } = await getHtml('/admin/divulgacao-vagas');
  assert.equal(status, 200);
  assert.equal(contarOcorrencias(html, 'Nenhuma campanha criada ainda.'), 2);
  assert.match(html, /Últimas campanhas por e-mail \(0\)/);
  assert.match(html, /Últimas campanhas por WhatsApp \(0\)/);
});

test('campanhas de e-mail aparecem na coluna certa, respeitando o corte em 5', async () => {
  exec("DELETE FROM campanhas");
  exec("DELETE FROM jobs WHERE slug = 'vaga-resumo-email'");
  const jobId = run(
    "INSERT INTO jobs (slug, titulo, perfil, ativo) VALUES ('vaga-resumo-email', 'Vaga Resumo Email', 'CLOSER', 1)",
  );
  // 7 campanhas: so as 5 mais recentes (maior id) podem aparecer.
  const ids = [];
  for (let i = 1; i <= 7; i += 1) {
    ids.push(
      run(
        `INSERT INTO campanhas (job_id, assunto, corpo_html, criterios, status)
         VALUES (?, ?, '<p>x</p>', '{}', 'rascunho')`,
        jobId,
        `Assunto Email ${i}`,
      ),
    );
  }

  const { html } = await getHtml('/admin/divulgacao-vagas');
  assert.match(html, /Últimas campanhas por e-mail \(5\)/);
  // As 5 mais recentes (3 a 7) aparecem.
  for (let i = 3; i <= 7; i += 1) {
    assert.match(html, new RegExp(`Assunto Email ${i}`), `Assunto Email ${i} deveria aparecer`);
  }
  // As 2 mais antigas (1 e 2) NAO aparecem.
  assert.doesNotMatch(html, /Assunto Email 1</, 'a campanha mais antiga nao pode aparecer (corte em 5)');
  assert.doesNotMatch(html, /Assunto Email 2</, 'a 2a mais antiga nao pode aparecer (corte em 5)');
  assert.match(html, /Vaga Resumo Email/, 'a coluna Vaga precisa mostrar o titulo da vaga');

  exec('DELETE FROM campanhas WHERE id IN (' + ids.map(() => '?').join(',') + ')', ...ids);
});

test('campanhas de WhatsApp aparecem na coluna certa, com o título da vaga (LEFT JOIN novo)', async () => {
  exec("DELETE FROM campanhas_whatsapp");
  exec("DELETE FROM templates_whatsapp WHERE nome_meta = 'tpl_resumo_teste'");
  exec("DELETE FROM jobs WHERE slug = 'vaga-resumo-wa'");
  const jobId = run(
    "INSERT INTO jobs (slug, titulo, perfil, ativo) VALUES ('vaga-resumo-wa', 'Vaga Resumo WhatsApp', 'CLOSER', 1)",
  );
  const templateId = run(
    "INSERT INTO templates_whatsapp (nome_meta, idioma, categoria, variaveis) VALUES ('tpl_resumo_teste', 'pt_BR', 'marketing', '[]')",
  );
  const cid = run(
    `INSERT INTO campanhas_whatsapp (nome, template_id, base_alvo, tipo_mensagem, job_id, status)
     VALUES ('Campanha WA Resumo', ?, 'ambos', 'divulgacao_vaga', ?, 'ativa')`,
    templateId,
    jobId,
  );

  const { html } = await getHtml('/admin/divulgacao-vagas');
  assert.match(html, /Campanha WA Resumo/);
  assert.match(html, /Vaga Resumo WhatsApp/, 'coluna Vaga da tabela de WhatsApp precisa vir preenchida');
  assert.match(html, /Últimas campanhas por WhatsApp \(1\)/);

  exec('DELETE FROM campanhas_whatsapp WHERE id = ?', cid);
});

test('campanha de WhatsApp SEM job_id (ex.: convite_grupo, que não tem vaga): listarCampanhasWhatsapp devolve vaga_titulo null, sem quebrar', () => {
  // Cobre o LEFT JOIN jobs novo em listarCampanhasWhatsapp (sqlite.js) direto na camada de
  // dados — job_id NULL e um caso REAL do schema (campanhas_whatsapp.job_id e nullable de
  // proposito: convite_grupo nao tem vaga associada, ver o comentario da coluna em
  // schema.sql), nao um estado hipotetico.
  exec("DELETE FROM campanhas_whatsapp WHERE nome = 'Campanha WA Sem Vaga'");
  exec("DELETE FROM templates_whatsapp WHERE nome_meta = 'tpl_resumo_sem_vaga'");
  const templateId = run(
    "INSERT INTO templates_whatsapp (nome_meta, idioma, categoria, variaveis) VALUES ('tpl_resumo_sem_vaga', 'pt_BR', 'marketing', '[]')",
  );
  const cid = run(
    `INSERT INTO campanhas_whatsapp (nome, template_id, base_alvo, tipo_mensagem, job_id, status)
     VALUES ('Campanha WA Sem Vaga', ?, 'ambos', 'convite_grupo', NULL, 'ativa')`,
    templateId,
  );

  const linha = db.listarCampanhasWhatsapp().find((c) => c.id === cid);
  assert.ok(linha, 'a query precisa achar a linha (nao pode quebrar com job_id NULL)');
  assert.equal(linha.job_id, null);
  assert.equal(linha.vaga_titulo, null, 'LEFT JOIN sem match -> vaga_titulo null (comportamento padrao de LEFT JOIN)');

  exec('DELETE FROM campanhas_whatsapp WHERE id = ?', cid);
});

test('resumo /admin/divulgacao-vagas: campanha de WhatsApp sem vaga mostra o fallback "(sem vaga)", nunca vazio/undefined/null', async () => {
  exec("DELETE FROM campanhas_whatsapp WHERE nome = 'Campanha WA Sem Vaga Tela'");
  exec("DELETE FROM templates_whatsapp WHERE nome_meta = 'tpl_resumo_sem_vaga_tela'");
  const templateId = run(
    "INSERT INTO templates_whatsapp (nome_meta, idioma, categoria, variaveis) VALUES ('tpl_resumo_sem_vaga_tela', 'pt_BR', 'marketing', '[]')",
  );
  const cid = run(
    `INSERT INTO campanhas_whatsapp (nome, template_id, base_alvo, tipo_mensagem, job_id, status)
     VALUES ('Campanha WA Sem Vaga Tela', ?, 'ambos', 'convite_grupo', NULL, 'ativa')`,
    templateId,
  );

  const { status, html } = await getHtml('/admin/divulgacao-vagas');
  assert.equal(status, 200, 'a tela nao pode quebrar com uma campanha sem vaga');
  assert.match(html, /Campanha WA Sem Vaga Tela/);

  // A linha da tabela: <td>Campanha WA Sem Vaga Tela</td> ... <td>(sem vaga)</td> — mesmo
  // padrao ja usado pelo lado do e-mail (ver ROTULO 'vaga_titulo' em admin_promocao.js/
  // admin.js:5601). Nunca "undefined", "null" (string) ou uma celula vazia.
  const idxLinha = html.indexOf('Campanha WA Sem Vaga Tela');
  const trechoLinha = html.slice(idxLinha, html.indexOf('</tr>', idxLinha));
  assert.match(trechoLinha, /\(sem vaga\)/);
  assert.doesNotMatch(trechoLinha, />undefined</);
  assert.doesNotMatch(trechoLinha, />null</);
  assert.doesNotMatch(trechoLinha, /<td><\/td>/, 'nenhuma celula vazia na linha');

  exec('DELETE FROM campanhas_whatsapp WHERE id = ?', cid);
});

test('rotas standalone /admin/promocao e /admin/campanhas-whatsapp continuam respondendo 200, com o próprio <h1>', async () => {
  const promocao = await getHtml('/admin/promocao');
  assert.equal(promocao.status, 200);
  // montarConteudoListagemPromocao usa <h1 style="margin:0;"> (nao mexemos nesse arquivo).
  assert.match(promocao.html, /<h1[^>]*>Promoção de Vagas<\/h1>/);

  const campanha = await getHtml('/admin/campanhas-whatsapp');
  assert.equal(campanha.status, 200);
  assert.match(campanha.html, /<h1>Campanha por WhatsApp<\/h1>/);
});
