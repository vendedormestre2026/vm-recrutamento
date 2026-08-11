'use strict';

// Rastreamento de cliques por campanha: `campanha_id` no link, na captura do acesso e na
// contagem do painel.
//
// ── A PROMESSA MAIS IMPORTANTE DESTE ARQUIVO ──
// A METRICA nunca pode derrubar o REGISTRO. O acesso a pagina da vaga e dado de funil; a
// atribuicao a uma campanha e um rotulo em cima dele. Um `?campanha_id=999999` de um link
// velho, ou digitado a mao, nao pode fazer o acesso — que aconteceu de verdade — sumir do
// funil. Os testes de "id inexistente" e "id invalido" sao esses.
//
// ── E A OUTRA: campanha_id vem da QUERY, nunca do cookie ──
// As UTM sao first-touch e duram 30 dias; um retorno organico semanas depois carrega
// utm_source='email' pelo cookie. Se campanha_id viesse junto, cada visita organica viraria
// um clique novo. Ha teste para isso.

const os = require('node:os');
const path = require('node:path');

process.env.DATABASE_PATH = path.join(os.tmpdir(), `vm-test-cliques-${process.pid}-${Date.now()}.db`);
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
const cta = require('../src/lib/ctaCampanha');

migrar();

const run = (sql, ...p) => Number(db.getDb().prepare(sql).run(...p).lastInsertRowid);

const vagaId = run(
  "INSERT INTO jobs (slug, titulo, perfil, ativo) VALUES ('vaga-cliques', 'Closer de Vendas', 'CLOSER', 1)",
);
const SLUG = 'vaga-cliques';

let seq = 0;
function criarCampanha(status = 'rascunho') {
  seq += 1;
  return run(
    `INSERT INTO campanhas (job_id, assunto, corpo_html, criterios, status)
     VALUES (?, ?, '<p>Corpo</p>', '{}', ?)`,
    vagaId,
    `Campanha ${seq}`,
    status,
  );
}

const acessos = (campanhaId) =>
  db.getDb().prepare('SELECT COUNT(*) AS n FROM vaga_acessos WHERE campanha_id = ?').get(campanhaId).n;
const totalAcessos = () => db.getDb().prepare('SELECT COUNT(*) AS n FROM vaga_acessos').get().n;
const ultimoAcesso = () =>
  db.getDb().prepare('SELECT * FROM vaga_acessos ORDER BY id DESC LIMIT 1').get();

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

// Visita publica a pagina da vaga (sem cookie, como um clique vindo do e-mail).
const visitar = (queryString = '') =>
  comServidor(async (base) => {
    const res = await fetch(`${base}/vaga/${SLUG}${queryString}`);
    assert.equal(res.status, 200, 'a pagina da vaga tem que renderizar');
    return res;
  });

// ══════════════════════════════════════════════════════════════
// 1. Schema
// ══════════════════════════════════════════════════════════════

test('vaga_acessos tem a coluna campanha_id, nullable', () => {
  const c = db
    .getDb()
    .prepare('SELECT * FROM pragma_table_info(?)')
    .all('vaga_acessos')
    .find((x) => x.name === 'campanha_id');

  assert.ok(c, 'coluna ausente');
  assert.equal(c.type, 'INTEGER');
  assert.equal(c.notnull, 0, 'acesso organico grava NULL — nao pode ser obrigatoria');
});

// ══════════════════════════════════════════════════════════════
// 2. O link do CTA
// ══════════════════════════════════════════════════════════════

test('o link do e-mail carrega campanha_id junto do utm_source', () => {
  const id = criarCampanha();
  const html = cta.montarCorpoFinal('<p>x</p>', SLUG, 'https://x/d?e=1&t=2', null, id);

  // No HTML o & vem escapado; a URL em si tem os dois parametros.
  assert.match(html, new RegExp(`utm_source=email&amp;campanha_id=${id}`));
});

// ══════════════════════════════════════════════════════════════
// 3. Captura no acesso
// ══════════════════════════════════════════════════════════════

test('acesso pelo link da campanha grava campanha_id', async () => {
  const id = criarCampanha();
  const antes = acessos(id);

  await visitar(`?utm_source=email&campanha_id=${id}`);

  assert.equal(acessos(id), antes + 1);
  const linha = ultimoAcesso();
  assert.equal(linha.campanha_id, id);
  assert.equal(linha.utm_source, 'email', 'a UTM continua sendo capturada');
  assert.equal(linha.job_id, vagaId);
});

test('acesso ORGANICO (sem o parametro) continua gravando NULL', async () => {
  const antes = totalAcessos();
  await visitar('');

  assert.equal(totalAcessos(), antes + 1, 'o acesso continua registrado');
  assert.equal(ultimoAcesso().campanha_id, null);
});

test('acesso com utm_source=email mas SEM campanha_id nao vira clique de campanha', async () => {
  // E o caso do retorno organico de quem clicou na campanha semanas atras: o cookie
  // first-touch carrega a UTM, mas nao ha clique novo no e-mail.
  await visitar('?utm_source=email');
  const linha = ultimoAcesso();
  assert.equal(linha.utm_source, 'email');
  assert.equal(linha.campanha_id, null, 'sem o parametro na URL, nao ha atribuicao');
});

// ══════════════════════════════════════════════════════════════
// 4. A metrica nunca derruba o registro
// ══════════════════════════════════════════════════════════════

test('campanha_id INEXISTENTE: o acesso e registrado, com atribuicao NULL', async () => {
  const antes = totalAcessos();
  await visitar('?utm_source=email&campanha_id=999999');

  assert.equal(totalAcessos(), antes + 1, 'o acesso NAO pode se perder por um id ruim');
  assert.equal(ultimoAcesso().campanha_id, null);
});

test('campanha_id INVALIDO (texto, negativo, vazio) nao quebra o acesso', async () => {
  for (const lixo of ['abc', '-1', '0', '', '1.5', 'null', '1;DROP TABLE']) {
    const antes = totalAcessos();
    await visitar(`?campanha_id=${encodeURIComponent(lixo)}`);
    assert.equal(totalAcessos(), antes + 1, `acesso perdido com campanha_id=${lixo}`);
    assert.equal(ultimoAcesso().campanha_id, null);
  }
});

test('registrarAcessoVaga valida o id direto na camada de dados', () => {
  const id = criarCampanha();
  const antes = totalAcessos();

  db.registrarAcessoVaga(vagaId, { source: 'email' }, id);
  assert.equal(ultimoAcesso().campanha_id, id);

  db.registrarAcessoVaga(vagaId, { source: 'email' }, 888888);
  assert.equal(ultimoAcesso().campanha_id, null, 'id inexistente vira NULL, sem lancar');

  assert.equal(totalAcessos(), antes + 2, 'os dois acessos entraram');
});

// ══════════════════════════════════════════════════════════════
// 5. A contagem
// ══════════════════════════════════════════════════════════════

test('contarCliquesCampanha conta so os acessos DAQUELA campanha', async () => {
  const a = criarCampanha();
  const b = criarCampanha();

  await visitar(`?campanha_id=${a}`);
  await visitar(`?campanha_id=${a}`);
  await visitar(`?campanha_id=${b}`);
  await visitar(''); // organico, nao conta para ninguem

  assert.equal(db.contarCliquesCampanha(a).total, 2);
  assert.equal(db.contarCliquesCampanha(b).total, 1);
});

test('duas campanhas para a MESMA vaga nao se contaminam', () => {
  // O motivo de existir o rastreamento exato em vez da aproximacao por utm_source: com a
  // UTM, os cliques das duas cairiam num balde so e nada na tela avisaria.
  const a = criarCampanha();
  const b = criarCampanha();
  db.registrarAcessoVaga(vagaId, { source: 'email' }, a);
  db.registrarAcessoVaga(vagaId, { source: 'email' }, a);
  db.registrarAcessoVaga(vagaId, { source: 'email' }, b);

  assert.equal(db.contarCliquesCampanha(a).total, 2);
  assert.equal(db.contarCliquesCampanha(b).total, 1);
});

test('campanha sem nenhum clique conta 0, e id invalido tambem', () => {
  assert.equal(db.contarCliquesCampanha(criarCampanha()).total, 0);
  for (const lixo of [0, -1, null, undefined, 'abc']) {
    assert.equal(db.contarCliquesCampanha(lixo).total, 0);
  }
});

// ══════════════════════════════════════════════════════════════
// 6. O painel de desempenho
// ══════════════════════════════════════════════════════════════

let cookieAdmin = '';

async function autenticar(base) {
  const res = await fetch(`${base}/admin/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ usuario: 'admin-teste', senha: 'senha-teste' }),
    redirect: 'manual',
  });
  const bruto = res.headers.getSetCookie ? res.headers.getSetCookie() : [res.headers.get('set-cookie')];
  cookieAdmin = bruto.filter(Boolean).map((c) => c.split(';')[0]).join('; ');
}

const verDetalhe = (id) =>
  comServidor(async (base) => {
    if (!cookieAdmin) await autenticar(base);
    const res = await fetch(`${base}/admin/promocao/${id}`, { headers: { Cookie: cookieAdmin } });
    assert.equal(res.status, 200);
    return res.text();
  });

// Campanha "disparada" com 4 recebidos, montada direto no banco (o objetivo aqui e a TELA,
// nao a varredura, que ja tem teste proprio).
function campanhaComEnvios(qtdEnviados) {
  const id = criarCampanha('concluida');
  for (let i = 0; i < qtdEnviados; i++) {
    run(
      `INSERT INTO campanha_envios (campanha_id, email, nome, origem_tipo, origem_id, status, enviado_em)
       VALUES (?, ?, 'P', 'talento', 1, 'enviado', datetime('now'))`,
      id,
      `p${i}-c${id}@exemplo.com`,
    );
  }
  return id;
}

test('a tela mostra recebidos e cliques, com a taxa', async () => {
  const id = campanhaComEnvios(4);
  db.registrarAcessoVaga(vagaId, { source: 'email' }, id);
  db.registrarAcessoVaga(vagaId, { source: 'email' }, id);

  const html = await verDetalhe(id);
  assert.match(html, /<h2>Desempenho<\/h2>/);
  assert.match(html, /<b>4<\/b> receberam o e-mail/);
  assert.match(html, /<b>2<\/b> cliques no link da vaga/);
  assert.match(html, /<b>50%<\/b> de quem recebeu/);
});

test('zero cliques: mostra 0 e a taxa 0%, sem quebrar', async () => {
  const id = campanhaComEnvios(3);
  const html = await verDetalhe(id);
  assert.match(html, /<b>3<\/b> receberam o e-mail/);
  assert.match(html, /<b>0<\/b> cliques no link da vaga/);
  assert.match(html, /<b>0%<\/b> de quem recebeu/);
});

test('ZERO recebidos: a taxa NAO aparece (nada de divisao por zero)', async () => {
  // Campanha enfileirada e ainda sem envio. Um "0%" aqui sugeriria fracasso onde nem
  // houve tentativa.
  const id = campanhaComEnvios(0);
  const html = await verDetalhe(id);
  assert.match(html, /<b>0<\/b> receberam o e-mail/);
  assert.match(html, /<b>0<\/b> cliques no link da vaga/, 'zero usa plural');
  assert.doesNotMatch(html, /de quem recebeu/, 'sem denominador, sem taxa');
  assert.doesNotMatch(html, /NaN|Infinity/, 'nunca uma divisao por zero vazando para a tela');
});

test('singular/plural de "clique"', async () => {
  const id = campanhaComEnvios(2);
  db.registrarAcessoVaga(vagaId, { source: 'email' }, id);
  const html = await verDetalhe(id);
  assert.match(html, /<b>1<\/b> clique no link/, 'um clique, singular');
});

test('a tela explica que cliques sao ACESSOS, nao pessoas', async () => {
  // A pagina da vaga e anonima: nao ha como contar pessoas unicas, e deduplicar por
  // IP/janela seria inventar uma identidade que o dado nao tem.
  const html = await verDetalhe(campanhaComEnvios(1));
  assert.match(html, /acessos<\/b> à página da vaga/i);
  assert.match(html, /não\s+pessoas/i);
});

test('rascunho NAO mostra o bloco de desempenho', async () => {
  // Rascunho nao enviou nada; um painel de desempenho ali seria so zeros sem significado.
  const html = await verDetalhe(criarCampanha('rascunho'));
  assert.doesNotMatch(html, /<h2>Desempenho<\/h2>/);
});
