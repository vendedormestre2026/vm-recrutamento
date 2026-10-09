'use strict';

// PREVIA AO VIVO do segmento da base na tela de criacao (/admin/massa-wa/nova?fonte=segmento) e o
// que ela reaproveita da pagina da campanha. Mesmo arranjo de test/adminMassaWaSegmento.test.js:
// app real, banco em tmp, login no painel. Nada sai: o interruptor do disparo fica desligado e
// nenhum teste ativa campanha ou chama /teste.

const os = require('node:os');
const path = require('node:path');

process.env.DATABASE_PATH = path.join(
  os.tmpdir(),
  `vm-test-admin-massa-wa-seg-previa-${process.pid}-${Date.now()}.db`,
);
process.env.INTERVIEW_MOCK = 'true';
process.env.SESSION_SECRET = 'segredo-de-teste';
process.env.OPTOUT_TOKEN_SECRET = 'segredo-hmac-de-teste';
process.env.ADMIN_USER = 'admin-teste';
process.env.ADMIN_PASSWORD = 'senha-teste';
process.env.NODE_ENV = 'test';

const fs = require('node:fs');
const test = require('node:test');
const assert = require('node:assert/strict');

const db = require('../src/db');
const { migrar } = require('../src/db/migrate');
const { criarApp } = require('../src/server');
const worker = require('../src/whatsapp/massaOutbox');
const optout = require('../src/lib/optoutWhatsapp');

migrar();

const FIXTURE_FUNIL = path.join(__dirname, 'fixtures', 'massaWaSegmentoFunil.html');

let cookieAdmin = '';
let seq = 0;

async function comServidor(fn) {
  const app = criarApp();
  const server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  try {
    const base = `http://127.0.0.1:${server.address().port}`;
    if (!cookieAdmin) await autenticar(base);
    return await fn(base);
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
}

const get = async (base, url) => (await fetch(`${base}${url}`, { headers: { Cookie: cookieAdmin } })).text();

async function post(base, url, campos, { cookie = cookieAdmin } = {}) {
  const body = new URLSearchParams();
  for (const [k, v] of Object.entries(campos || {})) {
    if (Array.isArray(v)) v.forEach((x) => body.append(k, x));
    else if (v !== undefined) body.append(k, v);
  }
  return fetch(`${base}${url}`, {
    method: 'POST',
    headers: { Cookie: cookie, 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
    redirect: 'manual',
  });
}

function vaga({ ativo = true, cidade = 'Joinville', titulo } = {}) {
  seq += 1;
  return db.criarVaga({ slug: `vaga-seg-previa-${seq}`, titulo: titulo || `Vaga ${seq}`, perfil: 'CLOSER', empresa: 'Acme Ltda', cidade, ativo });
}

let tel = 0;
// `minutos` = ha quantos minutos foi a candidatura (maior = mais antiga).
function candidatura(jobId, { status = null, nome, minutos, telefone } = {}) {
  tel += 1;
  const t = telefone || `47999${String(700000 + tel).padStart(6, '0')}`;
  const id = Number(db.getDb().prepare(
    `INSERT INTO applications (job_id, nome, telefone, status_recrutador, criado_em, consent_at)
     VALUES (?, ?, ?, ?, datetime('now', ?), datetime('now'))`,
  ).run(jobId, nome || `Pessoa ${tel}`, t, status, `-${minutos ?? tel} minutes`).lastInsertRowid);
  return { id, telefone: t };
}

function limpar() {
  const conn = db.getDb();
  for (const t of ['campanhas_massa_wa_envios', 'campanhas_massa_wa_variacoes', 'campanhas_massa_wa',
    'disparos_whatsapp', 'applications', 'whatsapp_optout', 'whatsapp_opt_out', 'jobs']) conn.exec(`DELETE FROM ${t}`);
  db.definirConfigBool(worker.CHAVE_ATIVO, false);
}

// Cenario com TODAS as linhas do funil que tem texto proprio: em processo liberado por vaga
// ignorada, status, opt-out, divulgado recente, contato frio com e sem data, e corte pelo teto.
function cenarioCompleto() {
  limpar();
  const alvo = vaga({ titulo: 'Vendedor Alvo' });
  const origem = vaga({ ativo: false, titulo: 'Vaga Antiga' });
  const parada = vaga({ titulo: 'Vaga Parada' });
  const pessoas = [];
  for (let i = 0; i < 4; i += 1) pessoas.push(candidatura(origem, { nome: `Livre ${i + 1}` }));
  const presa = candidatura(origem, { nome: 'Pessoa Presa' });
  db.getDb().prepare("INSERT INTO applications (job_id, nome, telefone, consent_at) VALUES (?, 'x', ?, datetime('now'))").run(parada, presa.telefone);
  candidatura(origem, { nome: 'Aprovada', status: 'aprovado' });
  const opt = candidatura(origem, { nome: 'Saiu' });
  optout.registrarOptout({ telefone: `55${opt.telefone}` });
  const recente = candidatura(origem, { nome: 'Recente' });
  const dw = db.getDb().prepare("INSERT INTO disparos_whatsapp (telefone, status, enviado_em) VALUES (?, 'enviado', ?)");
  dw.run(`55${recente.telefone}`, new Date(Date.now() - 2 * 86400000).toISOString());
  dw.run(`55${pessoas[0].telefone}`, '2026-01-01T10:00:00.000-03:00');
  dw.run(`55${pessoas[1].telefone}`, null);
  return { alvo, origem, parada, pessoas };
}

const camposSegmento = (alvo, extra = {}) => ({
  fonte: 'segmento', vaga_alvo_id: String(alvo), nome: 'Convite Joinville', cidade: '', teto: '30', dias_outros_canais: '14', ...extra,
});
const ultimaCampanha = () => db.listarCampanhasMassaWa()[0];

// A <section> do funil na pagina da campanha.
function secaoFunil(html) {
  const ini = html.indexOf('<section class="rel-sec">\n        <h2>Público do segmento (prévia)</h2>');
  assert.ok(ini >= 0, 'secao do funil nao encontrada');
  return html.slice(ini, html.indexOf('</section>', ini) + '</section>'.length);
}

test.after(() => {
  for (const suf of ['', '-wal', '-shm']) fs.rmSync(`${process.env.DATABASE_PATH}${suf}`, { force: true });
});

// ══════════════════ I1: O FUNIL DA PAGINA DA CAMPANHA NAO MUDA ══════════════════
//
// A fixture foi gravada com o codigo de ANTES da extracao do funil (b21c945), com
// GERAR_FIXTURE_FUNIL=1. Este teste roda primeiro no arquivo: banco novo, ids previsiveis.
test('REGRESSAO: a secao do funil na pagina da campanha e byte a byte a de antes da extracao', async () => {
  const { alvo, parada } = cenarioCompleto();
  await comServidor(async (base) => {
    await post(base, '/admin/massa-wa', camposSegmento(alvo, { teto: '3', vagas_ignoradas: [String(parada)] }));
    const html = secaoFunil(await get(base, `/admin/massa-wa/${ultimaCampanha().id}`));
    if (process.env.GERAR_FIXTURE_FUNIL === '1') fs.writeFileSync(FIXTURE_FUNIL, html);
    assert.equal(html, fs.readFileSync(FIXTURE_FUNIL, 'utf8'));
    // A fixture cobre as linhas de texto proprio (senao o teste nao provaria nada).
    for (const re of [/ignoradas: vaga \d+/, /liberadas por vagas ignoradas/, /Aprovado: 1/, /n8n por praça: 1/,
      /fora pelo teto \(3\)<\/dt><dd>2/, /Contato frio:/, /com contato sem data/]) assert.match(html, re);
  });
});
