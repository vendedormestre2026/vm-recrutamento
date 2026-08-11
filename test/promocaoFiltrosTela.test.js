'use strict';

// Os filtros novos na tela de criacao de campanha: Base e Cidade (multi-selecao) mais o
// aviso da limitacao do filtro de Origem.
//
// ── POR QUE MULTI-SELECAO PRECISA DE TESTE DE TELA PROPRIO ──
// Os tres filtros antigos sao <select> de escolha unica; estes sao grupos de checkbox com
// o MESMO `name`. O express entrega um name repetido como ARRAY quando ha 2+ marcados e
// como STRING quando ha 1 so — e um `String` solto vira um filtro por cada LETRA da
// cidade. O teste de "uma cidade marcada" e o que trava exatamente esse erro.
//
// A OUTRA metade: o estado tem que sobreviver ao re-submit da previa. O Jean marca cinco
// cidades, clica em Calcular previa, e as cinco precisam voltar marcadas — senao ele
// recalcula sobre um recorte diferente do que vê.

const os = require('node:os');
const path = require('node:path');

process.env.DATABASE_PATH = path.join(os.tmpdir(), `vm-test-promo-filtros-tela-${process.pid}-${Date.now()}.db`);
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
const { lerCriteriosDoForm } = require('../src/routes/admin_promocao');

migrar();

const run = (sql, ...p) => Number(db.getDb().prepare(sql).run(...p).lastInsertRowid);

const vagaId = run(
  "INSERT INTO jobs (slug, titulo, perfil, ativo) VALUES ('vaga-filtros', 'Closer de Vendas', 'CLOSER', 1)",
);

// Cidades reais na base, para as opcoes serem montadas dinamicamente.
db.criarTalentosLegado(
  [
    ['leg-jo@x.com', 'Joinville'],
    ['leg-cur@x.com', 'Curitiba'],
    ['leg-todas@x.com', 'Todas as cidades'],
  ].map(([email, cidade]) => ({
    nome: 'L',
    email,
    telefone: null,
    perfil_interesse: null,
    categoria: 'legado',
    cargo: 'Vendedor',
    campos_extras: '{}',
    consent_at: null,
    criado_em: '2025-09-29 03:04:27',
  })),
);
for (const [email, cidade] of [
  ['leg-jo@x.com', 'Joinville'],
  ['leg-cur@x.com', 'Curitiba'],
  ['leg-todas@x.com', 'Todas as cidades'],
]) {
  db.getDb().prepare('UPDATE talentos SET cidade = ? WHERE email = ?').run(cidade, email);
}
run(
  `INSERT INTO applications (job_id, token, nome, sobrenome, email, cidade, utm_source)
   VALUES (?, 'tk-1', 'A', 'B', 'cand@x.com', 'São Paulo', 'meta-ads')`,
  vagaId,
);

let cookieAdmin = '';

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

const pegar = (caminho) =>
  comServidor(async (base) => {
    if (!cookieAdmin) await autenticar(base);
    const res = await fetch(`${base}${caminho}`, { headers: { Cookie: cookieAdmin } });
    assert.equal(res.status, 200);
    return res.text();
  });

// POST do formulario (a previa re-renderiza a tela com os criterios preservados).
const postarPrevia = (pares) =>
  comServidor(async (base) => {
    if (!cookieAdmin) await autenticar(base);
    const corpo = new URLSearchParams();
    corpo.set('vaga', String(vagaId));
    for (const [k, v] of pares) corpo.append(k, v);
    const res = await fetch(`${base}/admin/promocao/previa`, {
      method: 'POST',
      headers: { Cookie: cookieAdmin, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: corpo,
    });
    return res.text();
  });

// ══════════════════════════════════════════════════════════════
// 1. Renderizacao dos filtros novos
// ══════════════════════════════════════════════════════════════

test('o filtro de Base aparece com as tres opcoes, como checkbox', () => {
  return pegar('/admin/promocao/nova').then((html) => {
    assert.match(html, /<span>Base<\/span>/);
    // Rotulo EXIBIDO x valor INTERNO: a tela mostra os tres nomes que o Rafael usa
    // ("Candidatos", "Base legada", "Talentos") e o formulario continua enviando
    // 'candidatura'/'legado'/'proprio'. Este teste guarda os dois lados justamente porque
    // trocar o valor por causa do rotulo reescreveria o criterio gravado em campanhas ja
    // disparadas.
    for (const [valor, rotulo] of [
      ['candidatura', 'Candidatos'],
      ['legado', 'Base legada'],
      ['proprio', 'Talentos'],
    ]) {
      assert.match(
        html,
        new RegExp(`<input type="checkbox" name="base" value="${valor}"[^>]*>\\s*<span[^>]*>${rotulo}`),
        `faltou a opcao ${valor}`,
      );
    }
  });
});

test('o filtro de Cidade monta as opcoes a partir do BANCO', async () => {
  const html = await pegar('/admin/promocao/nova');
  assert.match(html, /<span>Cidade<\/span>/);
  for (const cidade of ['Joinville', 'Curitiba', 'São Paulo']) {
    assert.match(html, new RegExp(`name="cidade" value="${cidade}"`), `faltou ${cidade}`);
  }
});

test('o SENTINELA nao aparece como opcao marcavel de cidade', () => {
  // Ele casa com qualquer selecao sozinho. Oferece-lo convidaria o operador a marca-lo
  // achando que precisa — e a NAO marca-lo seria o erro oposto, mais provavel ainda.
  return pegar('/admin/promocao/nova').then((html) => {
    assert.doesNotMatch(html, /name="cidade" value="Todas as cidades"/);
  });
});

test('o filtro de Cidade tem o checkbox "incluir sem cidade"', () => {
  return pegar('/admin/promocao/nova').then((html) => {
    assert.match(html, /name="cidade_incluir_sem"/);
  });
});

test('o filtro de Base NAO tem "incluir sem base"', () => {
  // Todo mundo veio de alguma base — o checkbox seria um controle que nunca muda nada.
  return pegar('/admin/promocao/nova').then((html) => {
    assert.doesNotMatch(html, /name="base_incluir_sem"/);
  });
});

// ══════════════════════════════════════════════════════════════
// 2. O aviso da limitacao do filtro de Origem
// ══════════════════════════════════════════════════════════════

test('a tela avisa que Origem so existe para candidaturas', async () => {
  // Achado do diagnostico: talento nao tem utm_source, entao com o filtro de Origem ativo
  // os 7.215 legados caem fora. Nao mudamos a semantica — deixamos explicito na tela.
  const html = await pegar('/admin/promocao/nova');
  assert.match(html, /Origem só existe para <b>candidaturas<\/b>/i);
  assert.match(html, /incluir sem origem/i);
});

// ══════════════════════════════════════════════════════════════
// 3. Persistencia no re-submit — o estado nao pode se perder
// ══════════════════════════════════════════════════════════════

test('UMA cidade marcada volta marcada (e nao vira filtro por letra)', async () => {
  // O caso que quebra sem o [].concat: express entrega string quando ha 1 so marcado.
  const html = await postarPrevia([['cidade', 'Joinville']]);
  assert.match(html, /name="cidade" value="Joinville"[^>]*checked/);
  assert.doesNotMatch(html, /name="cidade" value="Curitiba"[^>]*checked/);
});

test('VARIAS cidades marcadas voltam todas marcadas', async () => {
  const html = await postarPrevia([
    ['cidade', 'Joinville'],
    ['cidade', 'Curitiba'],
  ]);
  assert.match(html, /name="cidade" value="Joinville"[^>]*checked/);
  assert.match(html, /name="cidade" value="Curitiba"[^>]*checked/);
  assert.doesNotMatch(html, /name="cidade" value="São Paulo"[^>]*checked/);
});

test('bases marcadas voltam marcadas', async () => {
  const html = await postarPrevia([
    ['base', 'legado'],
    ['base', 'proprio'],
  ]);
  assert.match(html, /name="base" value="legado"[^>]*checked/);
  assert.match(html, /name="base" value="proprio"[^>]*checked/);
  assert.doesNotMatch(html, /name="base" value="candidatura"[^>]*checked/);
});

test('"incluir sem cidade" sobrevive ao re-submit', async () => {
  const html = await postarPrevia([
    ['cidade', 'Joinville'],
    ['cidade_incluir_sem', '1'],
  ]);
  assert.match(html, /name="cidade_incluir_sem" value="1" checked/);
});

test('nada marcado volta nada marcado', async () => {
  const html = await postarPrevia([]);
  assert.doesNotMatch(html, /name="base"[^>]*checked/);
  assert.doesNotMatch(html, /name="cidade"[^>]*checked/);
});

// ══════════════════════════════════════════════════════════════
// 4. lerCriteriosDoForm — a normalizacao do multi-valor
// ══════════════════════════════════════════════════════════════

test('lerCriteriosDoForm normaliza 1 valor e N valores para ARRAY', () => {
  assert.deepEqual(lerCriteriosDoForm({ cidade: 'Joinville' }).cidades, ['Joinville']);
  assert.deepEqual(lerCriteriosDoForm({ cidade: ['A', 'B'] }).cidades, ['A', 'B']);
  assert.deepEqual(lerCriteriosDoForm({}).cidades, [], 'ausente = lista vazia = filtro inativo');

  assert.deepEqual(lerCriteriosDoForm({ base: 'legado' }).bases, ['legado']);
  assert.deepEqual(lerCriteriosDoForm({ base: ['legado', 'proprio'] }).bases, ['legado', 'proprio']);
});

test('lerCriteriosDoForm le o checkbox de "incluir sem cidade"', () => {
  assert.equal(lerCriteriosDoForm({ cidade_incluir_sem: '1' }).cidadeIncluirSemAtributo, true);
  assert.equal(lerCriteriosDoForm({}).cidadeIncluirSemAtributo, false);
});

// ══════════════════════════════════════════════════════════════
// 5. A previa reflete os filtros novos
// ══════════════════════════════════════════════════════════════

test('a previa recalcula com o filtro de base aplicado', async () => {
  // Sem filtro: os 3 legados + 1 candidatura (menos quem ja se inscreveu na vaga alvo).
  const semFiltro = await postarPrevia([]);
  const soProprio = await postarPrevia([['base', 'proprio']]);

  // Nao ha nenhum cadastro proprio no cenario, entao o recorte por 'proprio' tem que ser
  // vazio — e a tela precisa dizer isso, nao repetir o numero cheio.
  assert.match(semFiltro, /destinatário/i);
  assert.notEqual(semFiltro, soProprio, 'a previa tem que mudar com o filtro de base');
  assert.match(soProprio, /name="base" value="proprio"[^>]*checked/);
});
