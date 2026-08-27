'use strict';

// Exclusao de campanha de WhatsApp em rascunho — db.excluirCampanhaWhatsapp + POST
// /admin/campanhas-whatsapp/:id/excluir.
//
// Espelha test/promocaoExclusao.test.js (a campanha de E-MAIL, que ja tinha isto) — MESMO
// contrato de db.excluirCampanhaWhatsapp: nunca lanca, resultado discriminado
// { ok, erroCodigo?, mensagem? }, so um rascunho sem envios pode sumir do banco. A
// diferenca de forma em relacao ao e-mail: aqui NAO ha tela de confirmacao propria (a
// listagem ja e uma tabela inline) — a confirmacao e o modal reutilizavel (data-confirm),
// entao nao ha "tela intermediaria" pra testar via HTTP como promocaoExclusao.test.js faz;
// o POST direto (sem `confirmado`, que nem existe aqui) ja executa.

const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');

process.env.DATABASE_PATH = path.join(os.tmpdir(), `vm-test-campanha-wa-exclusao-${process.pid}-${Date.now()}.db`);
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
const exec = (sql, ...p) => db.getDb().prepare(sql).run(...p);

const existe = (id) =>
  Boolean(db.getDb().prepare('SELECT 1 FROM campanhas_whatsapp WHERE id = ?').get(id));

// Um template minimo, so pra satisfazer a FK NOT NULL de campanhas_whatsapp.template_id —
// nao e o alvo do teste.
let templateId = null;
function obterTemplateId() {
  if (templateId) return templateId;
  templateId = run(
    "INSERT INTO templates_whatsapp (nome_meta, idioma, categoria, variaveis) VALUES ('t_teste_exclusao_vm', 'pt_BR', 'utility', '[]')",
  );
  return templateId;
}

let seq = 0;
function criarCampanha(status = 'rascunho') {
  seq += 1;
  return run(
    `INSERT INTO campanhas_whatsapp (nome, template_id, base_alvo, tipo_mensagem, status)
     VALUES (?, ?, 'ambos', 'convite_grupo', ?)`,
    `Campanha WA Excluir ${seq}`,
    obterTemplateId(),
    status,
  );
}

// ══════════════════════════════════════════════════════════════
// 1. Camada de dados — o caminho feliz
// ══════════════════════════════════════════════════════════════

test('excluirCampanhaWhatsapp apaga um rascunho sem envios', () => {
  const id = criarCampanha('rascunho');
  assert.ok(existe(id), 'sanidade');

  assert.deepEqual(db.excluirCampanhaWhatsapp(id), { ok: true });
  assert.ok(!existe(id), 'a linha tem que sumir de verdade — nao ha soft-delete aqui');
});

test('excluirCampanhaWhatsapp nao encosta em outras campanhas', () => {
  const alvo = criarCampanha('rascunho');
  const vizinha = criarCampanha('rascunho');

  db.excluirCampanhaWhatsapp(alvo);
  assert.ok(!existe(alvo));
  assert.ok(existe(vizinha), 'so a campanha pedida pode sumir');
});

// ══════════════════════════════════════════════════════════════
// 2. Trava 1 — status
// ══════════════════════════════════════════════════════════════

test('excluirCampanhaWhatsapp RECUSA status "ativa" (erroCodigo STATUS_INVALIDO)', () => {
  const id = criarCampanha('ativa');
  const r = db.excluirCampanhaWhatsapp(id);

  assert.equal(r.ok, false);
  assert.equal(r.erroCodigo, 'STATUS_INVALIDO');
  assert.equal(r.status, 'ativa');
  assert.match(r.mensagem, /rascunho/i);
  assert.ok(existe(id), 'ativa tem que continuar no banco');
});

test('excluirCampanhaWhatsapp RECUSA status "pausada" (erroCodigo STATUS_INVALIDO)', () => {
  const id = criarCampanha('pausada');
  const r = db.excluirCampanhaWhatsapp(id);

  assert.equal(r.ok, false);
  assert.equal(r.erroCodigo, 'STATUS_INVALIDO');
  assert.equal(r.status, 'pausada');
  assert.ok(existe(id));
});

test('excluirCampanhaWhatsapp RECUSA status "concluida" (erroCodigo STATUS_INVALIDO)', () => {
  const id = criarCampanha('concluida');
  const r = db.excluirCampanhaWhatsapp(id);

  assert.equal(r.ok, false);
  assert.equal(r.erroCodigo, 'STATUS_INVALIDO');
  assert.ok(existe(id));
});

// ══════════════════════════════════════════════════════════════
// 3. Trava 2 — envios materializados (o estado anomalo)
// ══════════════════════════════════════════════════════════════

test('excluirCampanhaWhatsapp RECUSA rascunho que anomalamente tenha envios', () => {
  // Nao deveria existir: a materializacao so acontece no disparo (POST /:id/disparar), que
  // ja marca a campanha como 'ativa'. Se existir, e banco editado a mao ou restore parcial.
  const id = criarCampanha('rascunho');
  exec(
    `INSERT INTO campanha_whatsapp_envios (campanha_id, telefone, origem_tipo)
     VALUES (?, '5547999999999', 'talento')`,
    id,
  );

  const r = db.excluirCampanhaWhatsapp(id);
  assert.equal(r.ok, false);
  assert.equal(r.erroCodigo, 'TEM_ENVIOS');
  assert.match(r.mensagem, /não deveria existir/i);
  assert.ok(existe(id));
});

test('a FK e a terceira linha de defesa: sem ON DELETE CASCADE', () => {
  const id = criarCampanha('rascunho');
  exec(
    `INSERT INTO campanha_whatsapp_envios (campanha_id, telefone, origem_tipo)
     VALUES (?, '5547999999998', 'talento')`,
    id,
  );

  assert.throws(
    () => db.getDb().prepare('DELETE FROM campanhas_whatsapp WHERE id = ?').run(id),
    /FOREIGN KEY constraint failed/i,
  );
});

// ══════════════════════════════════════════════════════════════
// 4. Entradas invalidas
// ══════════════════════════════════════════════════════════════

test('excluirCampanhaWhatsapp devolve erro discriminado para id inexistente ou invalido', () => {
  for (const id of [999999, 0, -1, null, undefined, 'abc', 1.5]) {
    const r = db.excluirCampanhaWhatsapp(id);
    assert.equal(r.ok, false, `id=${JSON.stringify(id)}`);
    assert.equal(r.erroCodigo, 'CAMPANHA_NAO_ENCONTRADA');
  }
});

test('excluirCampanhaWhatsapp NUNCA lanca', () => {
  assert.doesNotThrow(() => db.excluirCampanhaWhatsapp(999999));
  assert.doesNotThrow(() => db.excluirCampanhaWhatsapp('lixo'));
});

// ══════════════════════════════════════════════════════════════
// 5. A rota HTTP e o botao na listagem
// ══════════════════════════════════════════════════════════════

const SECRET = process.env.SESSION_SECRET;
const SENHA = process.env.ADMIN_PASSWORD;
function cookieAdmin() {
  const sig = crypto.createHmac('sha256', SECRET).update(SENHA).digest('base64').replace(/=+$/, '');
  return `vm_admin=${encodeURIComponent(`s:${SENHA}.${sig}`)}`;
}

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

const postar = (base, caminho) =>
  fetch(`${base}${caminho}`, {
    method: 'POST',
    headers: { Cookie: cookieAdmin() },
    redirect: 'manual',
  });

test('POST /:id/excluir em rascunho: apaga e redireciona com excluida=1', async () => {
  const id = criarCampanha('rascunho');
  await comServidor(async (base) => {
    const res = await postar(base, `/admin/campanhas-whatsapp/${id}/excluir`);
    assert.equal(res.status, 302);
    assert.equal(res.headers.get('location'), '/admin/campanhas-whatsapp?excluida=1');
  });
  assert.ok(!existe(id));
});

test('POST /:id/excluir em status != rascunho: recusa e redireciona com erro_exclusao=status_invalido', async () => {
  const id = criarCampanha('ativa');
  await comServidor(async (base) => {
    const res = await postar(base, `/admin/campanhas-whatsapp/${id}/excluir`);
    assert.equal(res.status, 302);
    assert.equal(res.headers.get('location'), '/admin/campanhas-whatsapp?erro_exclusao=status_invalido');
  });
  assert.ok(existe(id));
});

test('POST /:id/excluir com id inexistente: redireciona com erro_exclusao=campanha_nao_encontrada', async () => {
  await comServidor(async (base) => {
    const res = await postar(base, '/admin/campanhas-whatsapp/999999/excluir');
    assert.equal(res.status, 302);
    assert.equal(res.headers.get('location'), '/admin/campanhas-whatsapp?erro_exclusao=campanha_nao_encontrada');
  });
});

test('GET /admin/campanhas-whatsapp: botao Excluir SO aparece em rascunho', async () => {
  const rascunho = criarCampanha('rascunho');
  const ativa = criarCampanha('ativa');

  await comServidor(async (base) => {
    const res = await fetch(`${base}/admin/campanhas-whatsapp`, { headers: { Cookie: cookieAdmin() } });
    const html = await res.text();
    assert.match(html, new RegExp(`action="/admin/campanhas-whatsapp/${rascunho}/excluir"`));
    assert.doesNotMatch(html, new RegExp(`action="/admin/campanhas-whatsapp/${ativa}/excluir"`));
    // O form de excluir carrega o modal de confirmacao, nao apaga direto.
    const trecho = html.slice(html.indexOf(`/admin/campanhas-whatsapp/${rascunho}/excluir`));
    assert.match(trecho.slice(0, trecho.indexOf('</form>')), /data-confirm=/);
  });

  exec('DELETE FROM campanhas_whatsapp WHERE id IN (?, ?)', rascunho, ativa);
});

test('?excluida=1 mostra aviso de sucesso; ?erro_exclusao=<codigo> mostra aviso de erro', async () => {
  await comServidor(async (base) => {
    const sucesso = await (await fetch(`${base}/admin/campanhas-whatsapp?excluida=1`, { headers: { Cookie: cookieAdmin() } })).text();
    assert.match(sucesso, /aviso-ok">Campanha excluída\./);

    const erro = await (await fetch(`${base}/admin/campanhas-whatsapp?erro_exclusao=status_invalido`, { headers: { Cookie: cookieAdmin() } })).text();
    assert.match(erro, /aviso-alerta">Não foi possível excluir: Só é possível excluir uma campanha em rascunho\./);
  });
});
