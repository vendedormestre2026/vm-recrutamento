'use strict';

// Busca textual da lista de candidatos (?q= em /admin): o campo que o recrutador usa para
// achar UMA pessoa por nome, e-mail ou telefone, entre os 400+ leads da tela.
//
// Cobre (DB isolado, dados inseridos direto; sem LLM/STT/TTS/Drive/e-mail):
//   1. camada de dados (listarAplicacoesComContexto com `busca`): nome, sobrenome, nome
//      completo combinado, e-mail parcial, telefone com e sem formatacao nos dois
//      sentidos, busca vazia, sem resultado, curingas do LIKE como literais e o piso de
//      digitos que impede um termo curto de vazar para o telefone;
//   2. a LIMITACAO ACEITA dos acentos (LIKE do SQLite so dobra caixa em ASCII) — testada
//      para nao "consertar" sozinha sem alguem decidir;
//   3. interacao com a visibilidade de arquivados (ativos/arquivados/todos) e com os
//      filtros que ja existiam (status, vaga);
//   4. handler GET /admin: saneamento de ?q= (ausente, vazio, so espacos, array, objeto,
//      termo longo), reflexo no campo do formulario e escape do value;
//   5. persistencia do recorte nas acoes em lote (paramsFiltros): arquivar/restaurar/
//      status em massa e painel de colunas voltam para a MESMA busca;
//   6. botao Limpar: aparece quando so a busca esta preenchida e devolve a lista inteira.

const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');
const crypto = require('node:crypto');

const TMP_DB = path.join(os.tmpdir(), `vm-test-busca-${process.pid}-${Date.now()}.db`);
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

// Cookie de admin assinado (cookie-parser/cookie-signature): 's:' + valor + '.' + HMAC.
function cookieAdmin() {
  const sig = crypto.createHmac('sha256', SECRET).update(SENHA).digest('base64').replace(/=+$/, '');
  return `vm_admin=${encodeURIComponent(`s:${SENHA}.${sig}`)}`;
}

function run(sql, ...params) {
  return Number(db.getDb().prepare(sql).run(...params).lastInsertRowid);
}

let seqTok = 0;
function aplicacao({ jobId, nome, sobrenome, email, telefone, status = 'aplicado', criadoEm }) {
  seqTok += 1;
  return run(
    `INSERT INTO applications (job_id, nome, sobrenome, email, telefone, status, token, criado_em)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    jobId,
    nome,
    sobrenome,
    email,
    telefone,
    status,
    `tok-busca-${seqTok}`,
    criadoEm,
  );
}

// Atalho: so os nomes, na ordem que a query devolveu (criado_em DESC).
function buscar(busca, extra = {}) {
  return db
    .listarAplicacoesComContexto({ busca, ...extra })
    .map((c) => `${c.nome} ${c.sobrenome}`);
}

// Sobe o app numa porta efemera e garante o close, mesmo se a asercao falhar.
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

// Nomes da tabela renderizada: cada linha linka o detalhe do candidato.
function nomesNaTela(html) {
  return (html.match(/<a href="\/admin\/candidato\/\d+">([^<]+)<\/a>/g) || []).map((s) =>
    s.replace(/.*">|<\/a>/g, ''),
  );
}

let vagaA;
let vagaB;
let idMariaSilva;
let idMariaSouza;
let idAna;

test.before(() => {
  migrar();

  vagaA = run("INSERT INTO jobs (slug, titulo, perfil) VALUES ('vaga-a', 'Closer A', 'CLOSER')");
  vagaB = run("INSERT INTO jobs (slug, titulo, perfil) VALUES ('vaga-b', 'SDR B', 'SDR')");

  // Telefone SEM formatacao (o formato dominante em producao).
  idMariaSilva = aplicacao({
    jobId: vagaA,
    nome: 'Maria',
    sobrenome: 'Silva',
    email: 'maria.silva@gmail.com',
    telefone: '+55 11999998888',
    criadoEm: '2026-07-01 10:00:00',
  });

  // Telefone COM formatacao (parenteses + hifen), para a busca ter que normalizar os dois
  // lados. Status diferente, para cruzar com o filtro de status.
  idMariaSouza = aplicacao({
    jobId: vagaA,
    nome: 'Maria',
    sobrenome: 'Souza',
    email: 'msouza@outlook.com',
    telefone: '+55 (11) 97777-6666',
    status: 'concluido',
    criadoEm: '2026-07-02 10:00:00',
  });

  // Hifen no banco: o termo vem limpo e tem que achar assim mesmo.
  aplicacao({
    jobId: vagaB,
    nome: 'Joao',
    sobrenome: 'Pereira',
    email: 'joao@empresa.com.br',
    telefone: '+55 4798872-9415',
    criadoEm: '2026-07-03 10:00:00',
  });

  // Acento no NOME e e-mail sem a forma sem-acento: isola a limitacao do LIKE, sem o
  // e-mail servir de atalho.
  aplicacao({
    jobId: vagaB,
    nome: 'Luís',
    sobrenome: 'Gonçalves',
    email: 'lg@x.com',
    telefone: '+55 85911112222',
    criadoEm: '2026-07-04 10:00:00',
  });

  // '_' no e-mail: curinga do LIKE que precisa ser tratado como literal.
  idAna = aplicacao({
    jobId: vagaB,
    nome: 'Ana',
    sobrenome: 'Lima',
    email: 'ana_lima@teste.com',
    telefone: '+55 31955554444',
    criadoEm: '2026-07-05 10:00:00',
  });

  // Ana arquivada: a busca nao pode ressuscita-la no modo padrao.
  db.arquivarAplicacao(idAna);
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

// ── 1. Camada de dados ────────────────────────────────────────────────────────────────

test('busca por nome encontra os homonimos, em criado_em DESC', () => {
  assert.deepEqual(buscar('maria'), ['Maria Souza', 'Maria Silva']);
});

test('busca por sobrenome', () => {
  assert.deepEqual(buscar('pereira'), ['Joao Pereira']);
});

test('busca por nome COMPLETO combina as duas colunas', () => {
  // O caso que justifica o (nome || ' ' || sobrenome): nenhuma coluna sozinha contem
  // "maria silva", entao sem a concatenacao esta busca voltaria vazia.
  assert.deepEqual(buscar('maria silva'), ['Maria Silva']);
  assert.deepEqual(buscar('joao pereira'), ['Joao Pereira']);
});

test('busca por e-mail parcial (dominio e prefixo)', () => {
  assert.deepEqual(buscar('outlook'), ['Maria Souza']);
  assert.deepEqual(buscar('maria.silva@'), ['Maria Silva']);
});

test('busca por telefone: termo cru acha numero cru', () => {
  assert.deepEqual(buscar('11999998888'), ['Maria Silva']);
  assert.deepEqual(buscar('97777'), ['Maria Souza']);
});

test('busca por telefone: termo FORMATADO acha numero sem formatacao', () => {
  assert.deepEqual(buscar('(11) 99999-8888'), ['Maria Silva']);
});

test('busca por telefone: termo limpo acha numero COM formatacao no banco', () => {
  assert.deepEqual(buscar('1197777'), ['Maria Souza']);
  assert.deepEqual(buscar('4798872'), ['Joao Pereira']);
});

test('busca por telefone com DDI digitado', () => {
  assert.deepEqual(buscar('+55 11999998888'), ['Maria Silva']);
});

test('busca vazia nao filtra nada (mesmo resultado de nao buscar)', () => {
  const semBusca = db.listarAplicacoesComContexto({}).map((c) => `${c.nome} ${c.sobrenome}`);
  assert.deepEqual(buscar(''), semBusca);
  assert.deepEqual(buscar('   '), semBusca);
  assert.deepEqual(buscar(null), semBusca);
  assert.deepEqual(buscar(undefined), semBusca);
  assert.equal(semBusca.length, 4); // os 5 cadastrados menos a Ana, arquivada
});

test('busca sem resultado devolve lista vazia (nao erro)', () => {
  assert.deepEqual(buscar('zzzzz'), []);
  assert.deepEqual(buscar('naoexiste@nenhum.com'), []);
});

test('curingas do LIKE valem como LITERAL, nao como coringa', () => {
  // Sem ESCAPE, '%' casaria com todo mundo e 'ana_lima' casaria com 'anaXlima'.
  assert.deepEqual(buscar('%'), []);
  assert.deepEqual(buscar('_'), []);
  assert.deepEqual(buscar('anaXlima', { arquivados: 'todos' }), []);
  // O '_' literal continua achando quem realmente tem '_' no e-mail.
  assert.deepEqual(buscar('ana_lima', { arquivados: 'todos' }), ['Ana Lima']);
});

test('termo com menos de 3 digitos NAO vaza para o telefone', () => {
  // '11' aparece no telefone de duas pessoas; se entrasse no OR do telefone, a busca por
  // '11' devolveria gente que nao tem '11' no nome nem no e-mail.
  assert.deepEqual(buscar('11'), []);
  // Com 3 digitos ja procura no telefone. '119' acha as DUAS Marias: uma tem
  // '+55 11999998888' e a outra '+55 (11) 97777-6666', que normalizado vira
  // '5511977776666' — as duas contem '119'. Isso e o comportamento correto de uma
  // busca por PEDACO de numero, nao um vazamento.
  assert.deepEqual(buscar('119'), ['Maria Souza', 'Maria Silva']);
  // Um trecho mais especifico separa as duas.
  assert.deepEqual(buscar('1199999'), ['Maria Silva']);
});

test('aspas simples e SQL nao viram injecao (parametro ligado)', () => {
  assert.deepEqual(buscar("' OR 1=1 --"), []);
  assert.deepEqual(buscar("'; DROP TABLE applications; --"), []);
  // A tabela continua de pe.
  assert.equal(db.listarAplicacoesComContexto({}).length, 4);
});

// ── 2. Limitacao ACEITA: acentos ──────────────────────────────────────────────────────

test('LIMITACAO CONHECIDA: LIKE so dobra caixa em ASCII (acento nao e dobrado)', () => {
  // Decisao deliberada (ver comentario em sqlite.js): NAO ha folding de acentos.
  // Este teste existe para a limitacao nao mudar sozinha sem alguem decidir.
  assert.deepEqual(buscar('goncalves'), [], "'goncalves' nao deve achar 'Gonçalves'");
  assert.deepEqual(buscar('GONÇALVES'), [], "'Ç' maiusculo nao dobra para 'ç'");
  // O que FUNCIONA: o termo escrito como o nome aparece, e caixa em ASCII.
  assert.deepEqual(buscar('Gonçalves'), ['Luís Gonçalves']);
  assert.deepEqual(buscar('gonçalves'), ['Luís Gonçalves']);
  assert.deepEqual(buscar('MARIA'), ['Maria Souza', 'Maria Silva']);
});

// ── 3. Interacao com visibilidade e demais filtros ────────────────────────────────────

test('busca respeita a visibilidade de arquivados nos tres modos', () => {
  assert.deepEqual(buscar('ana'), [], 'modo padrao (ativos) nao pode trazer arquivado');
  assert.deepEqual(buscar('ana', { arquivados: 'arquivados' }), ['Ana Lima']);
  assert.deepEqual(buscar('ana', { arquivados: 'todos' }), ['Ana Lima']);
});

test('busca combina com o filtro de status (AND, nao OR)', () => {
  assert.deepEqual(buscar('maria', { status: 'concluido' }), ['Maria Souza']);
  assert.deepEqual(buscar('maria', { status: 'aplicado' }), ['Maria Silva']);
  assert.deepEqual(buscar('maria', { status: 'em_entrevista' }), []);
});

test('busca combina com o filtro de vaga', () => {
  assert.deepEqual(buscar('maria', { jobId: vagaA }), ['Maria Souza', 'Maria Silva']);
  assert.deepEqual(buscar('maria', { jobId: vagaB }), []);
});

test('busca combina com o intervalo de datas', () => {
  assert.deepEqual(buscar('maria', { dataDe: '2026-07-02' }), ['Maria Souza']);
  assert.deepEqual(buscar('maria', { dataAte: '2026-07-01' }), ['Maria Silva']);
});

// ── 4. Handler GET /admin: saneamento e reflexo no formulario ─────────────────────────

test('GET /admin?q= filtra a tabela renderizada', async () => {
  await comServidor(async ({ get }) => {
    const r = await get('/admin?q=maria');
    assert.equal(r.status, 200);
    assert.deepEqual(nomesNaTela(r.html), ['Maria Souza', 'Maria Silva']);
  });
});

test('GET /admin sem q (ausente/vazio/espacos) rende a lista inteira, identica', async () => {
  await comServidor(async ({ get }) => {
    const base = await get('/admin');
    assert.equal(base.status, 200);
    assert.equal(nomesNaTela(base.html).length, 4);
    // Byte a byte: quem nao busca nao pode ver NADA diferente do que via antes.
    for (const url of ['/admin?q=', '/admin?q=%20%20%20', '/admin?q=%09%0A']) {
      const r = await get(url);
      assert.equal(r.status, 200);
      assert.equal(r.html, base.html, `${url} deveria render igual a /admin`);
    }
  });
});

test('GET /admin com ?q malformado (array/objeto) nao quebra e nao busca lixo', async () => {
  await comServidor(async ({ get }) => {
    const base = await get('/admin');
    for (const url of ['/admin?q=a&q=b', '/admin?q[x]=1']) {
      const r = await get(url);
      assert.equal(r.status, 200, `${url} nao pode dar 500`);
      assert.deepEqual(nomesNaTela(r.html), nomesNaTela(base.html));
    }
  });
});

test('GET /admin reflete a busca no campo do formulario (persiste apos o submit)', async () => {
  await comServidor(async ({ get }) => {
    const r = await get('/admin?q=maria');
    assert.match(r.html, /<input type="search" name="q" value="maria"/);
    const vazio = await get('/admin');
    assert.match(vazio.html, /<input type="search" name="q" value=""/);
  });
});

test('GET /admin escapa o value do campo (sem XSS refletido)', async () => {
  await comServidor(async ({ get }) => {
    const r = await get(`/admin?q=${encodeURIComponent('"><script>alert(1)</script>')}`);
    assert.equal(r.status, 200);
    assert.ok(!r.html.includes('<script>alert(1)</script>'), 'o script nao pode ser injetado');
    assert.match(r.html, /&quot;&gt;&lt;script&gt;/);
  });
});

test('GET /admin corta a busca no teto de tamanho, sem quebrar', async () => {
  await comServidor(async ({ get }) => {
    const r = await get(`/admin?q=${'a'.repeat(5000)}`);
    assert.equal(r.status, 200);
    assert.deepEqual(nomesNaTela(r.html), []);
    // O campo mostra o valor JA cortado (100), nao os 5000 digitados.
    const m = r.html.match(/<input type="search" name="q" value="(a*)"/);
    assert.ok(m, 'campo de busca deveria estar no HTML');
    assert.equal(m[1].length, 100);
  });
});

// ── 5. Persistencia do recorte nas acoes em lote ──────────────────────────────────────

test('form-lote e painel de colunas carregam a busca em hidden', async () => {
  await comServidor(async ({ get }) => {
    const r = await get('/admin?q=maria');
    const lote = r.html.match(/<form id="form-lote"[\s\S]*?<\/form>/);
    const colunas = r.html.match(
      /<form method="POST" action="\/admin\/colunas-candidatos">[\s\S]*?<\/form>/,
    );
    assert.ok(lote && colunas, 'os dois forms POST deveriam existir');
    assert.match(lote[0], /<input type="hidden" name="q" value="maria">/);
    assert.match(colunas[0], /<input type="hidden" name="q" value="maria">/);
  });
});

test('arquivar em lote volta para o MESMO recorte de busca', async () => {
  await comServidor(async ({ get, post }) => {
    const r = await post('/admin/candidatos/arquivar-lote', {
      ids: String(idMariaSilva),
      q: 'maria',
    });
    assert.equal(r.status, 302);
    assert.match(r.location, /(\?|&)q=maria(&|$)/);

    // A volta ainda esta filtrada, e a Maria Silva saiu da lista de ativos.
    const volta = await get(r.location);
    assert.deepEqual(nomesNaTela(volta.html), ['Maria Souza']);
    assert.match(volta.html, /<input type="search" name="q" value="maria"/);

    // Desfaz, para nao vazar estado para os testes seguintes.
    const restaurar = await post('/admin/candidatos/restaurar-lote', {
      ids: String(idMariaSilva),
      q: 'maria',
      visibilidade: 'arquivados',
    });
    assert.match(restaurar.location, /(\?|&)q=maria(&|$)/);
    assert.deepEqual(buscar('maria'), ['Maria Souza', 'Maria Silva']);
  });
});

test('status em lote preserva a busca sem confundi-la com o status aplicado', async () => {
  await comServidor(async ({ post }) => {
    const r = await post('/admin/candidatos/status-recrutador-lote', {
      ids: String(idMariaSouza),
      q: 'maria',
      status_recrutador: 'aprovado',
      filtro_status_recrutador: '',
    });
    assert.equal(r.status, 302);
    assert.match(r.location, /(\?|&)q=maria(&|$)/);
    assert.equal(db.obterAplicacao(idMariaSouza).status_recrutador, 'aprovado');
  });
});

test('painel de colunas preserva a busca', async () => {
  await comServidor(async ({ post }) => {
    const r = await post('/admin/colunas-candidatos', { colunas: ['email'], q: 'maria' });
    assert.equal(r.status, 302);
    assert.match(r.location, /(\?|&)q=maria(&|$)/);
  });
});

test('busca vazia ou so espacos NAO vai para a URL do redirect', async () => {
  await comServidor(async ({ post }) => {
    for (const q of ['', '   ']) {
      const r = await post('/admin/colunas-candidatos', { colunas: ['email'], q });
      assert.ok(!/[?&]q=/.test(r.location), `q=${JSON.stringify(q)} nao deveria sujar a URL`);
    }
  });
});

test('redirect corta a busca no mesmo teto do handler', async () => {
  // As duas pontas usam sanearBusca: se divergirem, o recorte muda sozinho apos a acao.
  await comServidor(async ({ post }) => {
    const r = await post('/admin/colunas-candidatos', { colunas: ['email'], q: 'a'.repeat(300) });
    const q = new URLSearchParams(r.location.split('?')[1] || '').get('q') || '';
    assert.equal(q.length, 100);
  });
});

test('caracteres especiais sobrevivem ao round-trip do redirect', async () => {
  await comServidor(async ({ post }) => {
    const r = await post('/admin/colunas-candidatos', { colunas: ['email'], q: 'maria & joão' });
    const q = new URLSearchParams(r.location.split('?')[1] || '').get('q');
    assert.equal(q, 'maria & joão');
  });
});

// ── 6. Botao Limpar ───────────────────────────────────────────────────────────────────

test('Limpar aparece quando SO a busca esta preenchida e devolve a lista inteira', async () => {
  await comServidor(async ({ get }) => {
    const semFiltro = await get('/admin');
    assert.ok(!/>Limpar<\/a>/.test(semFiltro.html), 'sem filtro nao deve haver Limpar');

    const comBusca = await get('/admin?q=maria');
    const link = comBusca.html.match(/<a class="btn btn--ghost" href="([^"]*)">Limpar<\/a>/);
    assert.ok(link, 'com busca ativa o Limpar deveria aparecer');
    assert.equal(link[1], '/admin', 'Limpar nao pode carregar o q de volta');

    const depois = await get(link[1]);
    assert.equal(nomesNaTela(depois.html).length, 4);
  });
});
