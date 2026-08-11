'use strict';

// Exclusao de campanha em rascunho — db.excluirCampanha + POST /admin/promocao/:id/excluir.
//
// ── POR QUE ESTE ARQUIVO PESA MAIS QUE O TAMANHO DA FEATURE ──
// Este e o UNICO DELETE do projeto inteiro. Todo o resto usa soft-delete ou transicao de
// status, entao nao ha nenhuma outra rede de seguranca em volta: nao existe `deleted_at`
// para restaurar, nao existe lixeira, e o banco de producao nao tem backup automatico por
// linha. Se as travas falharem, o dado sumiu.
//
// As travas sao duas, e os testes cobrem as duas separadamente porque elas protegem coisas
// diferentes: `status !== 'rascunho'` protege campanha que JA MANDOU e-mail (o registro do
// que saiu), e `total > 0` protege contra um estado anomalo — rascunho com envios
// materializados, sinal de banco mexido a mao. A segunda parece redundante e nao e: se um
// dia a primeira for afrouxada por engano, e ela que segura.
//
// HTTP de verdade para a rota, mesmo molde de promocaoTela.test.js.

const os = require('node:os');
const path = require('node:path');

process.env.DATABASE_PATH = path.join(os.tmpdir(), `vm-test-promocao-excluir-${process.pid}-${Date.now()}.db`);
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

const vagaId = run(
  "INSERT INTO jobs (slug, titulo, perfil, ativo) VALUES ('vaga-excluir', 'Closer de Vendas', 'CLOSER', 1)",
);

let seq = 0;

function criarCampanha(status = 'rascunho') {
  seq += 1;
  return run(
    `INSERT INTO campanhas (job_id, assunto, corpo_html, criterios, status)
     VALUES (?, ?, '<p>Corpo</p>', ?, ?)`,
    vagaId,
    `Campanha ${seq}`,
    JSON.stringify({ jobIdAlvo: vagaId }),
    status,
  );
}

const existe = (id) =>
  Boolean(db.getDb().prepare('SELECT 1 FROM campanhas WHERE id = ?').get(id));

const contarCampanhas = () =>
  db.getDb().prepare('SELECT COUNT(*) AS n FROM campanhas').get().n;

// ── Sessao de admin ──
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

// POST autenticado, sem seguir redirect (queremos ver o 302 e o destino).
const postar = (caminho, dados = {}) =>
  comServidor(async (base) => {
    if (!cookieAdmin) await autenticar(base);
    const res = await fetch(`${base}${caminho}`, {
      method: 'POST',
      headers: { Cookie: cookieAdmin, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(dados),
      redirect: 'manual',
    });
    return { status: res.status, location: res.headers.get('location'), html: await res.text() };
  });

const pegar = (caminho) =>
  comServidor(async (base) => {
    if (!cookieAdmin) await autenticar(base);
    const res = await fetch(`${base}${caminho}`, { headers: { Cookie: cookieAdmin } });
    return { status: res.status, html: await res.text() };
  });

// ══════════════════════════════════════════════════════════════
// 1. Camada de dados — o caminho feliz
// ══════════════════════════════════════════════════════════════

test('excluirCampanha apaga um rascunho sem envios', () => {
  const id = criarCampanha('rascunho');
  assert.ok(existe(id), 'sanidade');

  assert.deepEqual(db.excluirCampanha(id), { ok: true });
  assert.ok(!existe(id), 'a linha tem que sumir de verdade — nao ha soft-delete aqui');
});

test('excluirCampanha nao encosta em outras campanhas', () => {
  const alvo = criarCampanha('rascunho');
  const vizinha = criarCampanha('rascunho');

  db.excluirCampanha(alvo);
  assert.ok(!existe(alvo));
  assert.ok(existe(vizinha), 'so a campanha pedida pode sumir');
});

// ══════════════════════════════════════════════════════════════
// 2. Trava 1 — status
// ══════════════════════════════════════════════════════════════

test('excluirCampanha RECUSA todo status que nao seja rascunho', () => {
  // Cada um destes ja produziu efeito no mundo (publico congelado ou e-mail enviado) ou
  // registra uma decisao. Nenhum pode sumir do banco.
  for (const status of ['enfileirada', 'enviando', 'concluida', 'cancelada']) {
    const id = criarCampanha(status);
    const r = db.excluirCampanha(id);

    assert.equal(r.ok, false, `${status} nao pode ser excluida`);
    assert.equal(r.erroCodigo, 'STATUS_INVALIDO');
    assert.equal(r.status, status);
    assert.match(r.mensagem, /rascunho/i);
    assert.ok(existe(id), `${status} tem que continuar no banco`);
  }
});

// ══════════════════════════════════════════════════════════════
// 3. Trava 2 — envios materializados (o estado anomalo)
// ══════════════════════════════════════════════════════════════

test('excluirCampanha RECUSA rascunho que anomalamente tenha envios', () => {
  // Nao deveria existir: a materializacao so acontece no enfileiramento, que tira a
  // campanha de rascunho. Se existir, e banco editado a mao ou restore parcial — e a
  // resposta do projeto diante de "estado que nao deveria existir" e recusar e pedir olho
  // humano, nunca apagar por cima. Apagar destruiria a evidencia do problema.
  const id = criarCampanha('rascunho');
  run(
    `INSERT INTO campanha_envios (campanha_id, email, nome, origem_tipo, origem_id)
     VALUES (?, 'orfa@exemplo.com', 'Orfa', 'talento', 1)`,
    id,
  );

  const r = db.excluirCampanha(id);
  assert.equal(r.ok, false);
  assert.equal(r.erroCodigo, 'TEM_ENVIOS');
  assert.match(r.mensagem, /não deveria existir/i);
  assert.ok(existe(id));
});

test('a FK e a terceira linha de defesa: sem ON DELETE CASCADE', () => {
  // Se as duas travas do app fossem contornadas, o banco ainda barraria. Cascata aqui
  // apagaria o registro de quem recebeu e-mail — por isso ela NAO existe.
  const id = criarCampanha('rascunho');
  run(
    `INSERT INTO campanha_envios (campanha_id, email, nome, origem_tipo, origem_id)
     VALUES (?, 'protegida@exemplo.com', 'P', 'talento', 1)`,
    id,
  );

  assert.throws(
    () => db.getDb().prepare('DELETE FROM campanhas WHERE id = ?').run(id),
    /FOREIGN KEY constraint failed/i,
  );
});

// ══════════════════════════════════════════════════════════════
// 4. Entradas invalidas
// ══════════════════════════════════════════════════════════════

test('excluirCampanha devolve erro discriminado para id inexistente ou invalido', () => {
  for (const id of [999999, 0, -1, null, undefined, 'abc', 1.5]) {
    const r = db.excluirCampanha(id);
    assert.equal(r.ok, false, `id=${JSON.stringify(id)}`);
    assert.equal(r.erroCodigo, 'CAMPANHA_NAO_ENCONTRADA');
  }
});

test('excluirCampanha NUNCA lanca (contrato de enfileirarCampanha)', () => {
  // Quem chama e uma rota de painel: excecao viraria 500 numa tela que deveria dizer o
  // que houve.
  assert.doesNotThrow(() => db.excluirCampanha(999999));
  assert.doesNotThrow(() => db.excluirCampanha('lixo'));
});

// ══════════════════════════════════════════════════════════════
// 5. A rota — confirmacao em duas etapas
// ══════════════════════════════════════════════════════════════

test('POST sem `confirmado` NAO apaga: mostra a tela de confirmacao', async () => {
  const id = criarCampanha('rascunho');
  const r = await postar(`/admin/promocao/${id}/excluir`);

  assert.equal(r.status, 200);
  assert.match(r.html, /Excluir campanha/);
  assert.match(r.html, /apagada definitivamente/i);
  assert.match(r.html, /Sim, excluir esta campanha/);
  assert.match(r.html, /name="confirmado" value="1"/, 'o botao final carrega o campo');
  assert.match(r.html, /Cancelar/);
  assert.ok(existe(id), 'a primeira etapa NAO pode apagar nada');
});

test('a tela de confirmacao mostra o que sera perdido', async () => {
  const id = criarCampanha('rascunho');
  const r = await postar(`/admin/promocao/${id}/excluir`);

  assert.match(r.html, /<dt>Assunto<\/dt>/);
  assert.match(r.html, /Closer de Vendas/, 'a vaga divulgada');
  assert.match(r.html, /<dt>Criada em<\/dt>/);
  assert.match(r.html, /Nenhum e-mail foi enviado/i, 'diz por que e seguro');
});

test('POST com `confirmado=1` apaga e redireciona para a LISTAGEM', async () => {
  const id = criarCampanha('rascunho');
  const r = await postar(`/admin/promocao/${id}/excluir`, { confirmado: '1' });

  assert.equal(r.status, 302);
  assert.equal(r.location, '/admin/promocao', 'detalhe cairia em 404 — a campanha nao existe mais');
  assert.ok(!existe(id));
});

test('a rota recusa status invalido com 409 e a tela de detalhe', async () => {
  const id = criarCampanha('concluida');
  const r = await postar(`/admin/promocao/${id}/excluir`, { confirmado: '1' });

  assert.equal(r.status, 409);
  assert.match(r.html, /só é possível excluir uma campanha em rascunho/i);
  assert.match(r.html, /registro do que saiu/i);
  assert.ok(existe(id));
});

test('o guard de status vem ANTES da confirmacao', async () => {
  // Nao se pede a ninguem que confirme uma acao que ja se sabe que sera recusada.
  const id = criarCampanha('enviando');
  const r = await postar(`/admin/promocao/${id}/excluir`); // sem confirmado

  assert.equal(r.status, 409);
  assert.doesNotMatch(r.html, /Sim, excluir esta campanha/);
  assert.ok(existe(id));
});

test('id inexistente devolve 404', async () => {
  const r = await postar('/admin/promocao/999999/excluir', { confirmado: '1' });
  assert.equal(r.status, 404);
  assert.match(r.html, /Campanha não encontrada/i);
});

test('excluir duas vezes nao explode: a segunda cai na listagem', async () => {
  // Duas abas abertas, dois cliques. O destino ja e o desejado — 404 assustaria por um
  // resultado que a pessoa queria.
  const id = criarCampanha('rascunho');
  const antes = contarCampanhas();

  const primeira = await postar(`/admin/promocao/${id}/excluir`, { confirmado: '1' });
  assert.equal(primeira.status, 302);

  const segunda = await postar(`/admin/promocao/${id}/excluir`, { confirmado: '1' });
  assert.equal(segunda.status, 404, 'a campanha ja nao existe: 404 no guard de entrada');
  assert.equal(contarCampanhas(), antes - 1, 'so uma linha saiu');
});

// ══════════════════════════════════════════════════════════════
// 6. As telas — botao so em rascunho
// ══════════════════════════════════════════════════════════════

test('listagem: rascunho tem botao Excluir; os demais status NAO', async () => {
  const rascunho = criarCampanha('rascunho');
  const concluida = criarCampanha('concluida');

  const { html } = await pegar('/admin/promocao');

  assert.match(html, new RegExp(`action="/admin/promocao/${rascunho}/excluir"`));
  assert.doesNotMatch(
    html,
    new RegExp(`action="/admin/promocao/${concluida}/excluir"`),
    'sem botao morto: nos outros status ele simplesmente nao existe',
  );
  // O "Ver" continua valendo para os dois.
  assert.match(html, new RegExp(`href="/admin/promocao/${concluida}"`));
});

test('detalhe de rascunho tem o bloco Excluir', async () => {
  const id = criarCampanha('rascunho');
  const { html } = await pegar(`/admin/promocao/${id}`);

  assert.match(html, /<h2>Excluir<\/h2>/);
  assert.match(html, new RegExp(`action="/admin/promocao/${id}/excluir"`));
  assert.match(html, /Excluir campanha/);
  // E o bloco de disparo continua ali — excluir nao substituiu a acao principal.
  assert.match(html, /<h2>Disparo<\/h2>/);
});

test('detalhe dos demais status NAO tem o bloco Excluir', async () => {
  for (const status of ['enfileirada', 'enviando', 'concluida', 'cancelada']) {
    const id = criarCampanha(status);
    const { html } = await pegar(`/admin/promocao/${id}`);
    assert.doesNotMatch(html, /<h2>Excluir<\/h2>/, `${status} nao pode oferecer exclusao`);
    assert.doesNotMatch(html, new RegExp(`action="/admin/promocao/${id}/excluir"`));
  }
});

test('o botao da listagem leva a CONFIRMACAO, nunca apaga direto', async () => {
  // O form da listagem nao carrega `confirmado`, entao o primeiro clique so pode abrir a
  // tela de confirmacao. Se alguem adicionar o campo oculto la, este teste quebra.
  const id = criarCampanha('rascunho');
  const { html } = await pegar('/admin/promocao');

  const trecho = html.slice(html.indexOf(`/admin/promocao/${id}/excluir`));
  const fimDoForm = trecho.indexOf('</form>');
  assert.doesNotMatch(
    trecho.slice(0, fimDoForm),
    /name="confirmado"/,
    'o botao da listagem tem que passar pela confirmacao',
  );
  assert.ok(existe(id));
});
