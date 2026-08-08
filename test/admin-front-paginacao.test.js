'use strict';

// Front da tela de Candidatos (/admin): select de ORIGEM, controles de PAGINACAO e a
// propagacao desses parametros pelos pontos que reconstituem o filtro.
//
// Cobre (DB isolado + servidor em porta efemera; sem LLM/STT/TTS/Drive/e-mail):
//   1. <select name="origem">: opcao "Todas", opcoes vindas do banco (grafias duplicadas
//      ja fundidas), marcacao de selected e rejeicao de valor fora da allowlist;
//   2. filtro de origem ponta a ponta (URL -> tabela) e o "(filtrado)" do rodape;
//   3. controles de paginacao: 25 por pagina, "Pagina X de Y", Anterior/Proxima
//      habilitados nos extremos certos, ausencia com uma pagina so e caminho de volta
//      quando a pagina pedida passa da ultima;
//   4. os links de pagina preservam TODOS os filtros ativos da URL;
//   5. hidden inputs de origem nos forms de acao em massa e de colunas, e o redirect
//      pos-acao preservando origem SEM carregar `pagina` de volta.

const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');
const crypto = require('node:crypto');

const TMP_DB = path.join(os.tmpdir(), `vm-test-front-${process.pid}-${Date.now()}.db`);
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

let vaga;
let seqTok = 0;
let idParaArquivar;

function cookieAdmin() {
  const sig = crypto.createHmac('sha256', SECRET).update(SENHA).digest('base64').replace(/=+$/, '');
  return `vm_admin=${encodeURIComponent(`s:${SENHA}.${sig}`)}`;
}

function run(sql, ...params) {
  return Number(db.getDb().prepare(sql).run(...params).lastInsertRowid);
}

function aplicacao({ nome, utmSource = null, criadoEm }) {
  seqTok += 1;
  return run(
    `INSERT INTO applications (job_id, nome, sobrenome, email, status, token, utm_source, criado_em)
     VALUES (?, ?, 'Teste', ?, 'aplicado', ?, ?, ?)`,
    vaga,
    nome,
    `${nome.toLowerCase()}@teste.com`,
    `tok-front-${seqTok}`,
    utmSource,
    criadoEm,
  );
}

async function comServidor(fn) {
  const app = criarApp();
  const server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    return await fn({
      async get(url) {
        const res = await fetch(`${base}${url}`, { headers: { Cookie: cookieAdmin() } });
        return { status: res.status, html: await res.text() };
      },
      async post(url, corpo) {
        const res = await fetch(`${base}${url}`, {
          method: 'POST',
          redirect: 'manual',
          headers: {
            Cookie: cookieAdmin(),
            'Content-Type': 'application/x-www-form-urlencoded',
          },
          body: new URLSearchParams(corpo).toString(),
        });
        return { status: res.status, location: res.headers.get('location') || '' };
      },
    });
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

function nomesNaTela(html) {
  return (html.match(/<a href="\/admin\/candidato\/\d+">([^<]+)<\/a>/g) || []).map((s) =>
    s.replace(/.*">|<\/a>/g, ''),
  );
}

// Bloco <nav> da paginacao (vazio quando a barra nao e renderizada).
function navPaginacao(html) {
  const m = html.match(/<nav class="admin-paginacao"[\s\S]*?<\/nav>/);
  return m ? m[0] : '';
}

test.before(() => {
  migrar();
  vaga = run("INSERT INTO jobs (slug, titulo, perfil) VALUES ('vaga-front', 'Closer', 'CLOSER')");

  // 30 de 'meta': mais de uma pagina de 25.
  for (let i = 0; i < 30; i += 1) {
    aplicacao({
      nome: `Meta${String(i).padStart(2, '0')}`,
      utmSource: 'meta',
      criadoEm: `2026-06-${String((i % 28) + 1).padStart(2, '0')} 10:00:00`,
    });
  }

  // As duas grafias do grupo (viram UMA opcao no select) e um 'direto' explicito.
  aplicacao({ nome: 'GrupoA', utmSource: 'grupo-whats', criadoEm: '2026-07-01 10:00:00' });
  aplicacao({ nome: 'GrupoB', utmSource: 'grupowhats', criadoEm: '2026-07-02 10:00:00' });
  aplicacao({ nome: 'DiretoNulo', utmSource: null, criadoEm: '2026-07-03 10:00:00' });
  idParaArquivar = aplicacao({
    nome: 'RecrutaX',
    utmSource: 'recrutasimples',
    criadoEm: '2026-07-04 10:00:00',
  });
});

test.after(() => {
  for (const sufixo of ['', '-wal', '-shm']) {
    try {
      fs.rmSync(TMP_DB + sufixo, { force: true });
    } catch {
      /* ignore */
    }
  }
});

// ── 1. Select de origem ───────────────────────────────────────────────────────────────

test('o form de filtros ganha um select de origem com as opcoes do banco', async () => {
  await comServidor(async (http) => {
    const { html } = await http.get('/admin');
    assert.match(html, /<select name="origem">/);
    // "Todas" e o default selecionado quando nao ha filtro de origem.
    assert.match(html, /<select name="origem">\s*<option value="" selected>Todas<\/option>/);
    // Uma opcao por origem canonica.
    assert.match(html, /<option value="meta">meta<\/option>/);
    assert.match(html, /<option value="recrutasimples">recrutasimples<\/option>/);
    assert.match(html, /<option value="direto">Direto<\/option>/);
    assert.match(html, /<option value="grupo-whats">Grupo WhatsApp<\/option>/);
    // A grafia duplicada NAO vira opcao propria.
    assert.ok(!/<option value="grupowhats"/.test(html));
  });
});

test('a origem da URL aparece marcada como selected', async () => {
  await comServidor(async (http) => {
    const { html } = await http.get('/admin?origem=meta');
    assert.match(html, /<option value="meta" selected>meta<\/option>/);
    // E o "Todas" perde o selected.
    assert.match(html, /<option value="">Todas<\/option>/);
  });
});

// ── 2. Filtro ponta a ponta ───────────────────────────────────────────────────────────

test('filtrar por origem recorta a tabela', async () => {
  await comServidor(async (http) => {
    const { html } = await http.get('/admin?origem=recrutasimples');
    assert.deepEqual(nomesNaTela(html), ['RecrutaX Teste']);
    // Rodape marcado como filtrado.
    assert.match(html, /\(filtrado\)/);
  });
});

test('o balde do grupo traz as duas grafias numa consulta so', async () => {
  await comServidor(async (http) => {
    const { html } = await http.get('/admin?origem=grupo-whats');
    assert.deepEqual(nomesNaTela(html).sort(), ['GrupoA Teste', 'GrupoB Teste']);
  });
});

test('origem fora da allowlist e ignorada (equivale a Todas)', async () => {
  await comServidor(async (http) => {
    const { html } = await http.get('/admin?origem=zzz-inexistente');
    // Volta a lista inteira (1a pagina) e o select mostra "Todas" selecionado.
    assert.equal(nomesNaTela(html).length, db.CANDIDATOS_POR_PAGINA);
    assert.match(html, /<option value="" selected>Todas<\/option>/);
  });
});

// ── 3. Controles de paginacao ─────────────────────────────────────────────────────────

test('pagina 1: 25 linhas, "Pagina 1 de 2", Anterior desabilitado', async () => {
  await comServidor(async (http) => {
    const { html } = await http.get('/admin');
    assert.equal(nomesNaTela(html).length, 25);

    const nav = navPaginacao(html);
    assert.match(nav, /Página <b>1<\/b> de <b>2<\/b>/);
    // Anterior e um <span> inerte; Proxima e link de verdade.
    assert.match(nav, /<span class="btn btn--off">← Anterior<\/span>/);
    assert.match(nav, /<a class="btn btn--ghost" rel="next" href="\/admin\?pagina=2">/);
  });
});

test('pagina 2: o resto das linhas, Proxima desabilitada', async () => {
  await comServidor(async (http) => {
    const { html } = await http.get('/admin?pagina=2');
    assert.equal(nomesNaTela(html).length, 34 - 25);

    const nav = navPaginacao(html);
    assert.match(nav, /Página <b>2<\/b> de <b>2<\/b>/);
    assert.match(nav, /<a class="btn btn--ghost" rel="prev" href="\/admin\?pagina=1">/);
    assert.match(nav, /<span class="btn btn--off">Próxima →<\/span>/);
  });
});

test('com uma pagina so, a barra de paginacao nao e renderizada', async () => {
  await comServidor(async (http) => {
    const { html } = await http.get('/admin?origem=recrutasimples');
    assert.equal(navPaginacao(html), '');
  });
});

test('pagina alem da ultima: tabela vazia, mas com caminho de volta', async () => {
  await comServidor(async (http) => {
    const { html } = await http.get('/admin?pagina=99');
    assert.deepEqual(nomesNaTela(html), []);

    const nav = navPaginacao(html);
    assert.match(nav, /Página <b>99<\/b> de <b>2<\/b>/);
    // "Anterior" aponta para a ULTIMA pagina real (2), nao para 98.
    assert.match(nav, /rel="prev" href="\/admin\?pagina=2"/);
  });
});

test('pagina invalida na URL cai para a primeira', async () => {
  await comServidor(async (http) => {
    for (const ruim of ['0', '-3', 'abc', '']) {
      const { html } = await http.get(`/admin?pagina=${ruim}`);
      assert.match(navPaginacao(html), /Página <b>1<\/b> de <b>2<\/b>/, `pagina=${ruim}`);
    }
  });
});

// ── 4. Links preservam o recorte ──────────────────────────────────────────────────────

test('o link de proxima pagina carrega TODOS os filtros ativos', async () => {
  await comServidor(async (http) => {
    const { html } = await http.get('/admin?origem=meta&status=aplicado&q=Meta&visibilidade=todos');
    const nav = navPaginacao(html);
    const href = (nav.match(/rel="next" href="([^"]+)"/) || [])[1];
    assert.ok(href, 'deveria haver link de proxima pagina');

    const url = new URL(href, 'http://x');
    assert.equal(url.searchParams.get('origem'), 'meta');
    assert.equal(url.searchParams.get('status'), 'aplicado');
    assert.equal(url.searchParams.get('q'), 'Meta');
    assert.equal(url.searchParams.get('visibilidade'), 'todos');
    assert.equal(url.searchParams.get('pagina'), '2');
  });
});

test('trocar de filtro pelo form principal nao carrega pagina (volta para a 1)', async () => {
  await comServidor(async (http) => {
    const { html } = await http.get('/admin?pagina=2');
    // O form de filtros e GET puro: se ele tivesse um hidden de pagina, filtrar de novo
    // manteria o recrutador numa pagina que talvez nem exista mais no novo recorte.
    const form = (html.match(/<form method="GET" action="\/admin"[\s\S]*?<\/form>/) || [''])[0];
    assert.ok(form.includes('name="origem"'), 'o select de origem tem que estar no form');
    assert.ok(!/name="pagina"/.test(form), 'o form de filtros nao pode ter campo de pagina');
  });
});

// ── 5. Propagacao nos forms POST ──────────────────────────────────────────────────────

test('origem viaja como hidden nos forms de lote e de colunas', async () => {
  await comServidor(async (http) => {
    const { html } = await http.get('/admin?origem=meta');

    const formLote = (html.match(/<form id="form-lote"[\s\S]*?<\/form>/) || [''])[0];
    assert.match(formLote, /<input type="hidden" name="origem" value="meta">/);

    const formColunas =
      (html.match(/<form method="POST" action="\/admin\/colunas-candidatos"[\s\S]*?<\/form>/) ||
        [''])[0];
    assert.match(formColunas, /<input type="hidden" name="origem" value="meta">/);
  });
});

test('redirect pos-acao preserva origem e NAO preserva pagina', async () => {
  await comServidor(async (http) => {
    const { status, location } = await http.post('/admin/candidatos/arquivar-lote', {
      ids: String(idParaArquivar),
      origem: 'recrutasimples',
      pagina: '2',
      status: 'aplicado',
    });
    assert.equal(status, 302);

    const url = new URL(location, 'http://x');
    assert.equal(url.searchParams.get('origem'), 'recrutasimples');
    assert.equal(url.searchParams.get('status'), 'aplicado');
    // Arquivar pode ter esvaziado a pagina aberta: o redirect volta para a 1a.
    assert.equal(url.searchParams.get('pagina'), null);
  });
});
