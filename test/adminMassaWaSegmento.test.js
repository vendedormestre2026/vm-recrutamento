'use strict';

// Telas do SEGMENTO DA BASE no disparo em massa (/admin/massa-wa), por HTTP de verdade — o mesmo
// arranjo de test/adminMassaWa.test.js: app real, banco em tmp, login no painel. Nada sai: o
// interruptor do disparo fica desligado e nenhum teste chama /teste ou ativa campanha.

const os = require('node:os');
const path = require('node:path');

process.env.DATABASE_PATH = path.join(
  os.tmpdir(),
  `vm-test-admin-massa-wa-segmento-${process.pid}-${Date.now()}.db`,
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
const publico = require('../src/lib/publicoMassaWhatsapp');
const variacoes = require('../src/lib/variacoesMassaWa');
const worker = require('../src/whatsapp/massaOutbox');

migrar();

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

async function post(base, url, campos) {
  const body = new URLSearchParams();
  for (const [k, v] of Object.entries(campos || {})) {
    if (Array.isArray(v)) v.forEach((x) => body.append(k, x));
    else if (v !== undefined) body.append(k, v);
  }
  return fetch(`${base}${url}`, {
    method: 'POST',
    headers: { Cookie: cookieAdmin, 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
    redirect: 'manual',
  });
}

function vaga({ ativo = true, cidade = 'Joinville', titulo } = {}) {
  seq += 1;
  return db.criarVaga({ slug: `vaga-adm-seg-${seq}`, titulo: titulo || `Vaga ${seq}`, perfil: 'CLOSER', empresa: 'Acme Ltda', cidade, ativo });
}

let tel = 0;
function candidatura(jobId, { status = null, nome } = {}) {
  tel += 1;
  return Number(db.getDb().prepare(
    `INSERT INTO applications (job_id, nome, telefone, status_recrutador, criado_em, consent_at)
     VALUES (?, ?, ?, ?, datetime('now', ?), datetime('now'))`,
  ).run(jobId, nome || `Pessoa ${tel}`, `47999${String(600000 + tel).padStart(6, '0')}`, status, `-${tel} minutes`).lastInsertRowid);
}

function limpar() {
  const conn = db.getDb();
  for (const t of ['campanhas_massa_wa_envios', 'campanhas_massa_wa_variacoes', 'campanhas_massa_wa',
    'applications', 'whatsapp_optout', 'whatsapp_opt_out', 'jobs']) conn.exec(`DELETE FROM ${t}`);
  db.definirConfigBool(worker.CHAVE_ATIVO, false);
}

// Cenario: alvo aberta + origem encerrada com 4 pessoas + vaga parada aberta com 1 pessoa.
function cenario() {
  limpar();
  const alvo = vaga({ titulo: 'Vendedor Alvo' });
  const origem = vaga({ ativo: false, titulo: 'Vaga Antiga' });
  const parada = vaga({ titulo: 'Vaga Parada' });
  for (let i = 0; i < 4; i += 1) candidatura(origem);
  const presa = candidatura(origem, { nome: 'Pessoa Presa' });
  const telPresa = db.getDb().prepare('SELECT telefone FROM applications WHERE id = ?').get(presa).telefone;
  db.getDb().prepare("INSERT INTO applications (job_id, nome, telefone, consent_at) VALUES (?, 'x', ?, datetime('now'))").run(parada, telPresa);
  return { alvo, origem, parada };
}

const camposSegmento = (alvo, extra = {}) => ({
  fonte: 'segmento', vaga_alvo_id: String(alvo), nome: 'Convite Joinville', cidade: '', teto: '30', dias_outros_canais: '14', ...extra,
});
const ultimaCampanha = () => db.listarCampanhasMassaWa()[0];

test.after(() => {
  for (const suf of ['', '-wal', '-shm']) fs.rmSync(`${process.env.DATABASE_PATH}${suf}`, { force: true });
});

test('/nova tem o seletor de fonte; o padrao continua o formulario de vagas abertas', async () => {
  cenario();
  await comServidor(async (base) => {
    const html = await get(base, '/admin/massa-wa/nova');
    assert.match(html, /Inscritos em vagas abertas/);
    assert.match(html, /Segmento da base/);
    assert.match(html, /name="status"/);
  });
});

test('segmento, passo 1: so vagas ABERTAS como alvo; passo 2: listas da cidade com estatistica, sem a vaga-alvo', async () => {
  const { alvo, origem, parada } = cenario();
  await comServidor(async (base) => {
    const p1 = await get(base, '/admin/massa-wa/nova?fonte=segmento');
    assert.match(p1, new RegExp(`value="${alvo}"`));
    assert.doesNotMatch(p1, new RegExp(`<option value="${origem}"`));

    const p2 = await get(base, `/admin/massa-wa/nova?fonte=segmento&vaga_alvo=${alvo}`);
    assert.match(p2, new RegExp(`name="vagas_origem" value="${origem}"`));
    assert.match(p2, new RegExp(`name="vagas_ignoradas" value="${parada}"`));
    assert.doesNotMatch(p2, new RegExp(`name="vagas_ignoradas" value="${alvo}"`));
    assert.doesNotMatch(p2, new RegExp(`name="vagas_ignoradas" value="${origem}"`)); // encerrada
    assert.match(p2, /candidatura\(s\) viva\(s\) · última/);
    assert.match(p2, /<option value="Joinville" selected>/);
    assert.match(p2, /name="teto"[^>]*required/);
  });
});

test('cria a campanha de segmento: fonte, cidade da vaga-alvo, job_id = alvo, 7 sementes do convite validas', async () => {
  const { alvo } = cenario();
  await comServidor(async (base) => {
    const r = await post(base, '/admin/massa-wa', camposSegmento(alvo));
    assert.equal(r.status, 302);
  });
  const c = ultimaCampanha();
  const crit = JSON.parse(c.criterios_json);
  assert.equal(crit.fonte, 'segmento');
  assert.equal(crit.cidade, 'Joinville');
  assert.equal(crit.teto, 30);
  assert.equal(crit.diasOutrosCanais, 14);
  assert.equal(c.job_id, alvo);
  const textos = db.listarVariacoesMassaWa(c.id).map((v) => v.texto);
  assert.ok(variacoes.validarVariacoes(textos, { tipo: variacoes.TIPO_CONVITE_CANDIDATURA }).ok);
});

test('teto obrigatorio, teto maximo 100 e vaga-alvo nao ignoravel: recusa sem criar nada', async () => {
  const { alvo } = cenario();
  await comServidor(async (base) => {
    for (const [extra, erro] of [
      [{ teto: '' }, 'seg_teto'],
      [{ teto: '101' }, 'seg_teto_maximo'],
      [{ vagas_ignoradas: [String(alvo)] }, 'seg_vaga_alvo_ignorada'],
      [{ dias_outros_canais: '-1' }, 'seg_dias_outros_canais'],
    ]) {
      const r = await post(base, '/admin/massa-wa', camposSegmento(alvo, extra));
      assert.match(r.headers.get('location'), new RegExp(`erro=${erro}`));
    }
  });
  assert.equal(db.listarCampanhasMassaWa().length, 0);
});

test('vaga-alvo fechada e recusada', async () => {
  const { origem } = cenario();
  await comServidor(async (base) => {
    const r = await post(base, '/admin/massa-wa', camposSegmento(origem));
    assert.match(r.headers.get('location'), /erro=seg_vaga_fechada/);
  });
});

test('detalhe: funil do segmento, aviso do interruptor e vaga parada liberando a pessoa', async () => {
  const { alvo, parada } = cenario();
  await comServidor(async (base) => {
    await post(base, '/admin/massa-wa', camposSegmento(alvo));
    const id = ultimaCampanha().id;
    let html = await get(base, `/admin/massa-wa/${id}`);
    assert.match(html, /Público do segmento/);
    assert.match(html, /sem consentimento/);
    assert.match(html, /Segmento DESLIGADO/);
    assert.match(html, /PÚBLICO FINAL<\/dt><dd>4/);

    await post(base, `/admin/massa-wa/${id}`, { ...camposSegmento(alvo), vagas_ignoradas: [String(parada)] });
    html = await get(base, `/admin/massa-wa/${id}`);
    assert.match(html, new RegExp(`ignoradas: vaga ${parada}`));
    assert.match(html, /liberadas por vagas ignoradas \(informativo\)<\/dt><dd>1/);
    assert.match(html, /PÚBLICO FINAL<\/dt><dd>5/);
  });
});

test('conferencia nominal: lista nome, origem e telefone MASCARADO; desmarcar vira linha do funil', async () => {
  const { alvo } = cenario();
  await comServidor(async (base) => {
    await post(base, '/admin/massa-wa', camposSegmento(alvo));
    const c = ultimaCampanha();
    const html = await get(base, `/admin/massa-wa/${c.id}/conferencia`);
    assert.match(html, /Vaga Antiga/);
    assert.match(html, /<code>5547\*\*\*\*\d{4}<\/code>/);
    assert.doesNotMatch(html, /5547999600\d{3}/);

    const r = publico.montarPublicoDaCampanha(c);
    const [primeiro, ...resto] = r.itens.map((i) => i.telefoneCanonico);
    await post(base, `/admin/massa-wa/${c.id}/conferencia?pagina=1`, { na_pagina: [primeiro, ...resto], manter: resto });
    const crit = JSON.parse(db.obterCampanhaMassaWa(c.id).criterios_json);
    assert.deepEqual(crit.desmarcadas, [primeiro]);
    const det = await get(base, `/admin/massa-wa/${c.id}`);
    assert.match(det, /desmarcadas na conferência<\/dt><dd>1/);

    // Remarcar volta
    await post(base, `/admin/massa-wa/${c.id}/conferencia?pagina=1`, { na_pagina: [primeiro], manter: [primeiro] });
    assert.deepEqual(JSON.parse(db.obterCampanhaMassaWa(c.id).criterios_json).desmarcadas, []);
  });
});

test('PREVIA, CONFERENCIA E FILA DIZEM O MESMO: a fila e exatamente o publico final da previa', async () => {
  const { alvo } = cenario();
  await comServidor(async (base) => {
    await post(base, '/admin/massa-wa', camposSegmento(alvo, { teto: '3' }));
    const c = ultimaCampanha();
    const previa = publico.montarPublicoDaCampanha(c);
    const conferencia = await get(base, `/admin/massa-wa/${c.id}/conferencia`);
    assert.match(conferencia, new RegExp(`<b>${previa.itens.length}</b> pessoa\\(s\\) vão receber`));

    const r = await post(base, `/admin/massa-wa/${c.id}/materializar`, {});
    assert.match(r.headers.get('location'), /ok=materializada/);
    const fila = db.getDb().prepare('SELECT telefone_canonico t FROM campanhas_massa_wa_envios WHERE campanha_id = ? ORDER BY id').all(c.id).map((x) => x.t);
    assert.deepEqual(fila, previa.itens.map((i) => i.telefoneCanonico));
    assert.equal(fila.length, 3);

    const det = await get(base, `/admin/massa-wa/${c.id}`);
    assert.match(det, /Criada em [^:]+:\d\d: <b>5<\/b> pessoas do segmento − <b>1<\/b> em processo − <b>1<\/b> pelo teto = <b>3<\/b> na fila\./);
    const crit = JSON.parse(db.obterCampanhaMassaWa(c.id).criterios_json);
    assert.equal(crit.materializacao.fonte, 'segmento');

    // Materializacao unica.
    const de2 = await post(base, `/admin/massa-wa/${c.id}/materializar`, {});
    assert.match(de2.headers.get('location'), /erro=ja_materializada/);
    // Conferencia depois de materializar e so consulta.
    const r2 = await post(base, `/admin/massa-wa/${c.id}/conferencia?pagina=1`, { na_pagina: ['x'] });
    assert.match(r2.headers.get('location'), /erro=ja_materializada/);
  });
});

test('previa da variacao usa a vaga-alvo, a cidade e o link da vaga com a UTM da campanha', async () => {
  const { alvo } = cenario();
  await comServidor(async (base) => {
    await post(base, '/admin/massa-wa', camposSegmento(alvo));
    const c = ultimaCampanha();
    const html = await get(base, `/admin/massa-wa/${c.id}`);
    assert.match(html, /Vendedor Alvo/);
    assert.match(html, new RegExp(`utm_source=massa-wa&amp;utm_campaign=massa-${c.id}`));
    assert.match(html, /As 7 variações passam na validação/);
    assert.match(html, /<code>\{link_vaga\}<\/code>/);
  });
});

test('"Sugerir" no segmento preenche com as sementes do CONVITE', async () => {
  const { alvo } = cenario();
  await comServidor(async (base) => {
    await post(base, '/admin/massa-wa', camposSegmento(alvo));
    const c = ultimaCampanha();
    db.salvarVariacoesMassaWa(c.id, ['x']);
    await post(base, `/admin/massa-wa/${c.id}/sugerir`, {});
    assert.deepEqual(db.listarVariacoesMassaWa(c.id).map((v) => v.texto), [...variacoes.VARIACOES_SEED_CONVITE]);
  });
});

test('Configuracoes: o interruptor do segmento aparece, nasce desligado, e salvar sem marcar grava 0', async () => {
  cenario();
  await comServidor(async (base) => {
    const html = await get(base, '/admin/config');
    assert.match(html, /name="massa_wa_segmento_ativo" value="1">/);
    await post(base, '/admin/config/notificacoes', {});
    assert.equal(db.obterConfig(worker.CHAVE_SEGMENTO_ATIVO, null), '0');
  });
});

test('ATRIBUICAO: o link da mensagem leva a UTM que a captura grava, e o painel conta as candidaturas', async () => {
  const { alvo } = cenario();
  const { extrairUtmDaQuery } = require('../src/lib/utm');
  await comServidor(async (base) => {
    await post(base, '/admin/massa-wa', camposSegmento(alvo));
    const c = ultimaCampanha();
    // O link que a mensagem leva, lido pelo MESMO extrator que /vaga/:slug usa.
    const link = new URL(variacoes.linkVagaPara(db.obterVaga(alvo).slug, c.id));
    const utm = extrairUtmDaQuery(Object.fromEntries(link.searchParams));
    assert.equal(utm.source, 'massa-wa');
    assert.equal(utm.campaign, `massa-${c.id}`);

    let html = await get(base, `/admin/massa-wa/${c.id}`);
    assert.match(html, /Candidaturas geradas por esta campanha<\/h2>\s*<p[^>]*><b>0<\/b>/);
    const ins = db.getDb().prepare(
      "INSERT INTO applications (job_id, nome, telefone, utm_source, utm_campaign) VALUES (?, 'n', '47999000111', ?, ?)",
    );
    ins.run(alvo, utm.source, utm.campaign);
    ins.run(alvo, 'massa-wa', `massa-${c.id + 1}`); // outra campanha nao conta
    html = await get(base, `/admin/massa-wa/${c.id}`);
    assert.match(html, /Candidaturas geradas por esta campanha<\/h2>\s*<p[^>]*><b>1<\/b>/);
    assert.equal(db.contarCandidaturasPorUtmMassaWa(c.id), 1);
  });
});

test('REGRESSAO: campanha de vagas abertas continua com a previa e o formulario de sempre', async () => {
  cenario();
  const aberta = vaga();
  candidatura(aberta);
  await comServidor(async (base) => {
    await post(base, '/admin/massa-wa', { nome: 'Normal', job_id: String(aberta), status: ['sem_decisao', 'em_analise'] });
    const c = ultimaCampanha();
    assert.equal(publico.fonteDaCampanhaMassaWa(c), 'vagas_abertas');
    const html = await get(base, `/admin/massa-wa/${c.id}`);
    assert.match(html, /Candidaturas em vagas abertas/);
    assert.doesNotMatch(html, /Público do segmento/);
    assert.doesNotMatch(html, /Segmento (LIGADO|DESLIGADO)/);
    assert.doesNotMatch(html, /Candidaturas geradas por esta campanha/);
    const conf = await fetch(`${base}/admin/massa-wa/${c.id}/conferencia`, { headers: { Cookie: cookieAdmin } });
    assert.equal(conf.status, 404);
  });
});
