'use strict';

// As duas telas do Banco de Talentos: listagem (/admin/talentos) e detalhe
// (/admin/talentos/:id), depois da importacao da base legada.
//
// ── O QUE ESTE ARQUIVO GUARDA ──
// 1. PAGINACAO. A tela nasceu sem, com a tabela vazia; a importacao a levou a 7.215 linhas
//    de uma vez (~3 MB de HTML). O teste conta <tr> no HTML de verdade — se alguem remover
//    o LIMIT, a contagem estoura aqui antes de estourar no navegador do Jean.
// 2. HONESTIDADE DA TELA DE DETALHE. Registro legado nao tem currículo, nao tem analise e
//    nao tem consentimento. A tela foi escrita quando o unico jeito de entrar aqui era o
//    formulario publico, entao ela explicava cada ausencia como falha do fluxo normal —
//    "a analise automatica falhou" e literalmente falso para 7.215 pessoas. Os testes
//    abaixo travam as tres explicacoes novas E travam que o cadastro proprio NAO mudou.
//
// HTTP de verdade, servidor efemero, banco temporario. Mesmo molde de promocaoTela.test.js.

const os = require('node:os');
const path = require('node:path');

process.env.DATABASE_PATH = path.join(os.tmpdir(), `vm-test-talentos-tela-${process.pid}-${Date.now()}.db`);
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

let cookieAdmin = '';

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

const comAuth = () => ({ Cookie: cookieAdmin });

// GET autenticado que devolve o HTML.
const pegar = (caminho) =>
  comServidor(async (base) => {
    if (!cookieAdmin) await autenticar(base);
    const res = await fetch(`${base}${caminho}`, { headers: comAuth() });
    assert.equal(res.status, 200, `${caminho} deveria responder 200`);
    return res.text();
  });

// Conta linhas de dados da tabela (o <thead> tem um <tr> proprio, descontado aqui).
const contarLinhas = (html) => Math.max(0, (html.match(/<tr>/g) || []).length - 1);

// ── Cenario ──
// 30 legados (mais de uma pagina) + 2 cadastros proprios.
const TOTAL_LEGADO = 30;
const registros = [];
for (let i = 0; i < TOTAL_LEGADO; i++) {
  registros.push({
    nome: `Legado ${i}`,
    email: `legado${String(i).padStart(2, '0')}@exemplo.com`,
    telefone: '+55 47989251350',
    perfil_interesse: i === 0 ? 'SDR' : null,
    categoria: 'legado',
    cargo: i === 0 ? 'SDR' : 'Consultor Comercial',
    campos_extras: JSON.stringify({ empresa_origem: 'Godi Transportes' }),
    consent_at: null,
    criado_em: `2025-01-${String(31 - i).padStart(2, '0')} 10:00:00`,
  });
}
db.criarTalentosLegado(registros);

const idProprio = db.criarTalento({
  nome: 'Cadastro Proprio',
  email: 'proprio@exemplo.com',
  telefone: '+55 11999998888',
  perfil_interesse: 'CLOSER',
});
db.criarTalento({ nome: 'Outro Proprio', email: 'proprio2@exemplo.com', perfil_interesse: 'SDR' });

const idLegado = db.getDb()
  .prepare("SELECT id FROM talentos WHERE email = 'legado00@exemplo.com'")
  .get().id;

const TOTAL_GERAL = TOTAL_LEGADO + 2;

// ══════════════════════════════════════════════════════════════
// 1. Listagem — paginacao
// ══════════════════════════════════════════════════════════════

test('a listagem mostra no maximo 25 linhas, e nao a base inteira', async () => {
  const html = await pegar('/admin/talentos');
  assert.equal(contarLinhas(html), db.TALENTOS_POR_PAGINA);
  assert.ok(TOTAL_GERAL > db.TALENTOS_POR_PAGINA, 'sanidade: o cenario tem mais de uma pagina');
});

test('a nav de paginacao aparece e diz em que pagina estamos', async () => {
  const html = await pegar('/admin/talentos');
  assert.match(html, /class="admin-paginacao"/);
  assert.match(html, /Página <b>1<\/b> de <b>2<\/b>/);
  assert.match(html, /Próxima/);
});

test('a pagina 2 traz o resto e oferece o caminho de volta', async () => {
  const html = await pegar('/admin/talentos?pagina=2');
  assert.equal(contarLinhas(html), TOTAL_GERAL - db.TALENTOS_POR_PAGINA);
  assert.match(html, /Página <b>2<\/b> de <b>2<\/b>/);
  assert.match(html, /Anterior/);
});

test('a paginacao PRESERVA os filtros no link', async () => {
  // Sem isto, ir para a pagina 2 devolveria a base inteira e o operador perderia o
  // recorte sem perceber.
  const html = await pegar('/admin/talentos?categoria=legado');
  assert.match(html, /href="\/admin\/talentos\?categoria=legado&(amp;)?pagina=2"/);
});

// ══════════════════════════════════════════════════════════════
// 2. Listagem — colunas e filtro de categoria
// ══════════════════════════════════════════════════════════════

test('a tabela tem a coluna Cargo, ao lado de Perfil', async () => {
  const html = await pegar('/admin/talentos');
  assert.match(html, /<th>Cargo<\/th><th>Perfil<\/th>/);
  assert.match(html, /Consultor Comercial/, 'o cargo importado aparece na linha');
});

test('a tabela mostra a Origem de cada linha', async () => {
  const html = await pegar('/admin/talentos');
  assert.match(html, /<th>Origem<\/th>/);
  assert.match(html, /Base legada/);
});

test('o filtro de Origem existe com as tres opcoes', async () => {
  const html = await pegar('/admin/talentos');
  assert.match(html, /<select name="categoria">/);
  assert.match(html, /<option value=""[^>]*>Todas<\/option>/);
  assert.match(html, /<option value="legado"[^>]*>Base legada<\/option>/);
  assert.match(html, /<option value="proprio"[^>]*>Cadastro próprio<\/option>/);
});

test('filtrar por Base legada esconde o cadastro proprio', async () => {
  const html = await pegar('/admin/talentos?categoria=legado');
  assert.ok(!html.includes('proprio@exemplo.com'), 'cadastro proprio nao pode aparecer');
  assert.match(html, /legado0/);
});

test('filtrar por Cadastro proprio esconde os legados', async () => {
  const html = await pegar('/admin/talentos?categoria=proprio');
  assert.equal(contarLinhas(html), 2);
  assert.ok(html.includes('proprio@exemplo.com'));
  assert.ok(!html.includes('legado00@exemplo.com'));
  // Com 2 linhas nao ha o que paginar — a barra some para nao virar ruido.
  assert.doesNotMatch(html, /class="admin-paginacao"/);
});

test('o botao Limpar aparece com o filtro de categoria (temFiltro inclui ele)', async () => {
  const semFiltro = await pegar('/admin/talentos');
  assert.doesNotMatch(semFiltro, />Limpar</);

  const comFiltro = await pegar('/admin/talentos?categoria=legado');
  assert.match(comFiltro, />Limpar</, 'sem isto, o filtro de origem viraria um beco sem saida');
});

test('categoria invalida na URL e ignorada, e a tela nao quebra', async () => {
  const html = await pegar('/admin/talentos?categoria=inventada');
  assert.equal(contarLinhas(html), db.TALENTOS_POR_PAGINA);
  assert.doesNotMatch(html, />Limpar</, 'filtro invalido = filtro inativo');
});

// ══════════════════════════════════════════════════════════════
// 3. Listagem — contador e texto descritivo
// ══════════════════════════════════════════════════════════════

test('o contador mostra o total real, nao o tamanho da pagina', async () => {
  const html = await pegar('/admin/talentos');
  assert.match(html, new RegExp(`<b>${TOTAL_GERAL}</b> talento\\(s\\) no banco`));
});

test('com filtro, o contador mostra "X de Y"', async () => {
  const html = await pegar('/admin/talentos?categoria=legado');
  assert.match(html, new RegExp(`<b>${TOTAL_LEGADO}</b> de <b>${TOTAL_GERAL}</b>`));
});

test('o texto descritivo menciona as DUAS origens', async () => {
  // O texto antigo dizia que todo cadastro vinha do Banco de Curriculos — falso para
  // 7.215 de 7.215 registros depois da importacao.
  const html = await pegar('/admin/talentos');
  assert.match(html, /cadastro próprio/i);
  assert.match(html, /base legada/i);
  assert.match(html, /não tem currículo/i);
});

// ══════════════════════════════════════════════════════════════
// 4. Detalhe — registro LEGADO
// ══════════════════════════════════════════════════════════════

test('detalhe de legado mostra Origem e Cargo', async () => {
  const html = await pegar(`/admin/talentos/${idLegado}`);
  assert.match(html, /<dt>Origem<\/dt>/);
  assert.match(html, /Base legada/);
  assert.match(html, /<dt>Cargo<\/dt>/);
  assert.match(html, /SDR/);
});

test('detalhe de legado explica a AUSENCIA de consentimento, em vez de mostrar "—"', async () => {
  const html = await pegar(`/admin/talentos/${idLegado}`);
  assert.match(html, /Sem consentimento documentado na origem/i);
  assert.match(html, /base legada não registrava esse dado/i);
});

test('detalhe de legado NAO culpa o motor de analise', async () => {
  // O texto padrao diz "ou a análise automática falhou" — mandaria o Jean investigar um
  // erro que nunca existiu. Nao ha currículo para analisar, e so.
  const html = await pegar(`/admin/talentos/${idLegado}`);
  assert.match(html, /Não há análise porque não há currículo/i);
  assert.doesNotMatch(html, /análise\s+automática falhou/i);
});

test('detalhe de legado explica por que nao ha currículo, em vez de um botao morto', async () => {
  const html = await pegar(`/admin/talentos/${idLegado}`);
  assert.match(html, /Registros da base legada não têm currículo/i);
  assert.doesNotMatch(html, /btn--off">Baixar currículo/, 'nada de botao desabilitado mudo');
  assert.match(html, /\/bancodecurriculos/, 'oferece o caminho para conseguir um');
});

// ══════════════════════════════════════════════════════════════
// 5. Detalhe — cadastro PROPRIO nao mudou
// ══════════════════════════════════════════════════════════════

test('detalhe de cadastro proprio mantem os textos originais', async () => {
  const html = await pegar(`/admin/talentos/${idProprio}`);

  assert.match(html, /Cadastro próprio/, 'a origem aparece, mas como cadastro proprio');
  // Os tres textos de legado NAO podem vazar para quem se cadastrou pelo formulario.
  assert.doesNotMatch(html, /Sem consentimento documentado na origem/i);
  assert.doesNotMatch(html, /Não há análise porque não há currículo/i);
  assert.doesNotMatch(html, /Registros da base legada não têm currículo/i);
  // E o texto original da analise continua ali.
  assert.match(html, /análise\s+automática falhou/i);
});

test('cadastro proprio continua com consentimento datado', async () => {
  const html = await pegar(`/admin/talentos/${idProprio}`);
  assert.match(html, /<dt>Consentimento \(LGPD\)<\/dt>/);
  // criarTalento grava datetime('now'); a data formatada tem dd/mm/aaaa.
  assert.match(html, /\d{2}\/\d{2}\/\d{4}/);
});

test('cadastro proprio sem PDF mantem o botao desabilitado (comportamento antigo)', async () => {
  const html = await pegar(`/admin/talentos/${idProprio}`);
  assert.match(html, /btn--off[^>]*>Baixar currículo/);
});
