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

// O formulario de EDICAO de uma campanha de segmento nao muda com a previa ao vivo, a recarga de
// cidade e o periodo padrao (todos so na CRIACAO). Fixture gravada com o codigo de antes (cc1533d),
// com GERAR_FIXTURE_FORM=1; datas e horas da estatistica das vagas e ids sao neutralizados.
const FIXTURE_FORM_EDICAO = path.join(__dirname, 'fixtures', 'massaWaSegmentoFormEdicao.html');
test('REGRESSAO: o formulario de edicao da campanha de segmento e o de antes', async () => {
  const { alvo, parada, origem } = cenarioCompleto();
  await comServidor(async (base) => {
    await post(base, '/admin/massa-wa', camposSegmento(alvo, {
      teto: '7', vagas_ignoradas: [String(parada)], vagas_origem: [String(origem)], data_de: '2026-09-01', data_ate: '2026-09-30',
    }));
    const html = await get(base, `/admin/massa-wa/${ultimaCampanha().id}`);
    const ini = html.indexOf('<h2>Configuração</h2>');
    const form = html.slice(ini, html.indexOf('</form>', ini) + '</form>'.length)
      .replace(/\d\d\/\d\d \d\d:\d\d/g, 'DATA')
      .replace(/(value="|#|massa-wa\/)\d+/g, '$1ID');
    if (process.env.GERAR_FIXTURE_FORM === '1') fs.writeFileSync(FIXTURE_FORM_EDICAO, form);
    assert.equal(form, fs.readFileSync(FIXTURE_FORM_EDICAO, 'utf8'));
    assert.match(html, /name="data_de" value="2026-09-01"/);
  });
});

// ══════════════════ I2: ENDPOINT DA PREVIA (so leitura) ══════════════════

const URL_PREVIA = '/admin/massa-wa/segmento/previa';
const nomesDaTabela = (html) => [...html.matchAll(/<tr>\s*<td>([^<]*)<\/td>/g)].map((m) => m[1]);

// Cenario simples: N pessoas so na vaga de origem, a de indice 0 e a candidatura mais recente.
function cenarioSimples(n) {
  limpar();
  const alvo = vaga({ titulo: 'Vendedor Alvo' });
  const origem = vaga({ ativo: false, titulo: 'Vaga Antiga' });
  const pessoas = [];
  for (let i = 0; i < n; i += 1) pessoas.push(candidatura(origem, { nome: `P${String(i).padStart(3, '0')}`, minutos: i + 1 }));
  return { alvo, origem, pessoas };
}

const linhasGravaveis = () => Object.fromEntries(['campanhas_massa_wa', 'campanhas_massa_wa_variacoes', 'campanhas_massa_wa_envios', 'configuracoes']
  .map((t) => [t, db.getDb().prepare(`SELECT count(*) n FROM ${t}`).get().n]));

test('PREVIA == CAMPANHA CRIADA == FILA: mesma lista, mesma ordem, com os mesmos filtros', async () => {
  const { alvo, parada } = cenarioCompleto();
  const filtros = camposSegmento(alvo, { teto: '3', vagas_ignoradas: [String(parada)] });
  await comServidor(async (base) => {
    const r = await post(base, URL_PREVIA, filtros);
    assert.equal(r.status, 200);
    const nomesPrevia = nomesDaTabela(await r.text());
    assert.equal(nomesPrevia.length, 3);

    await post(base, '/admin/massa-wa', filtros);
    const c = ultimaCampanha();
    const daCampanha = require('../src/lib/publicoMassaWhatsapp').montarPublicoDaCampanha(c).itens.map((i) => i.nome);
    assert.deepEqual(nomesPrevia, daCampanha);

    const m = await post(base, `/admin/massa-wa/${c.id}/materializar`, {});
    assert.match(m.headers.get('location'), /ok=materializada/);
    const fila = db.getDb().prepare('SELECT nome FROM campanhas_massa_wa_envios WHERE campanha_id = ? ORDER BY id').all(c.id).map((x) => x.nome);
    assert.deepEqual(nomesPrevia, fila);
  });
});

test('a previa NAO grava nada: nenhuma mudanca no banco (total_changes) nem nas contagens', async () => {
  const { alvo, parada } = cenarioCompleto();
  await comServidor(async (base) => {
    const antes = linhasGravaveis();
    const mudancasAntes = db.getDb().prepare('SELECT total_changes() n').get().n;
    for (const extra of [{}, { teto: '1' }, { pagina: '2' }, { vagas_ignoradas: [String(parada)] }, { teto: '0' }]) {
      await post(base, URL_PREVIA, camposSegmento(alvo, extra));
    }
    assert.equal(db.getDb().prepare('SELECT total_changes() n').get().n, mudancasAntes);
    assert.deepEqual(linhasGravaveis(), antes);
    assert.equal(db.listarCampanhasMassaWa().length, 0);
  });
});

test('telefone NUNCA aparece completo no HTML da previa (so mascarado)', async () => {
  const { alvo, pessoas } = cenarioSimples(4);
  await comServidor(async (base) => {
    const html = await (await post(base, URL_PREVIA, camposSegmento(alvo))).text();
    assert.equal((html.match(/<code>5547\*\*\*\*\d{4}<\/code>/g) || []).length, 4);
    for (const p of pessoas) {
      assert.ok(!html.includes(p.telefone), `telefone completo vazou: ${p.telefone}`);
      assert.ok(!html.includes(p.telefone.slice(2)), 'numero sem DDD vazou');
    }
  });
});

test('teto e ordem: candidatura mais recente primeiro; o teto corta as mais antigas e so conta', async () => {
  const { alvo } = cenarioSimples(5);
  await comServidor(async (base) => {
    const html = await (await post(base, URL_PREVIA, camposSegmento(alvo, { teto: '3' }))).text();
    assert.deepEqual(nomesDaTabela(html), ['P000', 'P001', 'P002']);
    assert.match(html, /<b>3<\/b> pessoa\(s\) entrariam\s*· 2 fora pelo teto \(não listadas\)/);
    assert.match(html, /fora pelo teto \(3\)<\/dt><dd>2/);
  });
});

test('paginacao de 25: a pagina 2 continua a ordem; links de pagina levam os filtros para GET /nova', async () => {
  const { alvo } = cenarioSimples(30);
  await comServidor(async (base) => {
    const p1 = await (await post(base, URL_PREVIA, camposSegmento(alvo, { teto: '100' }))).text();
    assert.equal(nomesDaTabela(p1).length, 25);
    assert.match(p1, /Página 1 de 2/);
    assert.match(p1, /href="\/admin\/massa-wa\/nova\?fonte=segmento&amp;[^"]*teto=100[^"]*&amp;previa=1&amp;pagina=2#previa-segmento" data-pagina="2"/);
    const p2 = await (await post(base, URL_PREVIA, camposSegmento(alvo, { teto: '100', pagina: '2' }))).text();
    assert.deepEqual(nomesDaTabela(p2), ['P025', 'P026', 'P027', 'P028', 'P029']);
  });
});

test('periodo vazio = toda a base, e a previa escreve o periodo usado', async () => {
  const { alvo } = cenarioSimples(2);
  await comServidor(async (base) => {
    const html = await (await post(base, URL_PREVIA, camposSegmento(alvo))).text();
    assert.match(html, /<b>Período usado:<\/b> toda a base \(sem datas\)/);
    const com = await (await post(base, URL_PREVIA, camposSegmento(alvo, { data_de: '2026-09-01', data_ate: '2026-09-30' }))).text();
    assert.match(com, /<b>Período usado:<\/b> de 01\/09\/2026 até 30\/09\/2026 \(dias de Brasília\)/);
  });
});

test('publico vazio: mensagem clara e o funil continua aparecendo', async () => {
  const { alvo } = cenarioSimples(0);
  await comServidor(async (base) => {
    const r = await post(base, URL_PREVIA, camposSegmento(alvo));
    assert.equal(r.status, 200);
    const html = await r.text();
    assert.match(html, /Ninguém entraria com estes filtros/);
    assert.match(html, /PÚBLICO FINAL<\/dt><dd>0/);
  });
});

test('validacao igual a do "Criar rascunho" (sem exigir nome): 422 com a mensagem, sem calcular', async () => {
  const { alvo, origem } = cenarioSimples(1);
  await comServidor(async (base) => {
    for (const [extra, msg] of [
      [{ teto: '' }, /teto de destinatários é obrigatório/],
      [{ teto: '0' }, /teto de destinatários é obrigatório/],
      [{ teto: '101' }, /no máximo 100/],
      [{ data_de: '2026-10-05', data_ate: '2026-10-01' }, /Período inválido/],
      [{ cidade: 'Atlantida Perdida' }, /Cidade fora do vocabulário/],
      [{ vagas_ignoradas: [String(alvo)] }, /vaga-alvo não pode ser marcada/],
    ]) {
      const r = await post(base, URL_PREVIA, camposSegmento(alvo, extra));
      assert.equal(r.status, 422, JSON.stringify(extra));
      const html = await r.text();
      assert.match(html, msg);
      assert.doesNotMatch(html, /PÚBLICO FINAL/);
    }
    const semNome = await post(base, URL_PREVIA, camposSegmento(alvo, { nome: '' }));
    assert.equal(semNome.status, 200);
    const fechada = await post(base, URL_PREVIA, camposSegmento(origem));
    assert.equal(fechada.status, 422);
    assert.match(await fechada.text(), /não está aberta/);
  });
});

test('rota /segmento/previa nao colide com /:id; sem sessao vai para o login (sem o fragmento)', async () => {
  const { alvo } = cenarioSimples(1);
  await comServidor(async (base) => {
    const ok = await post(base, URL_PREVIA, camposSegmento(alvo));
    assert.match(await ok.text(), /data-previa-segmento="1"/);
    // /:id com "segmento" continua sendo "campanha nao encontrada", como antes.
    const det = await fetch(`${base}/admin/massa-wa/segmento`, { headers: { Cookie: cookieAdmin } });
    assert.equal(det.status, 404);
    const semSessao = await post(base, URL_PREVIA, camposSegmento(alvo), { cookie: '' });
    assert.equal(semSessao.status, 302);
    assert.match(semSessao.headers.get('location'), /^\/admin\/login/);
  });
  assert.equal(db.listarCampanhasMassaWa().length, 0);
});

// ══════════════════ I3: PAINEL DE PREVIA NA TELA DE CRIACAO ══════════════════

test('criacao: painel de previa, botao "Atualizar previa" (GET sem JS) e script; nada e criado', async () => {
  const { alvo } = cenarioSimples(2);
  await comServidor(async (base) => {
    const html = await get(base, `/admin/massa-wa/nova?fonte=segmento&vaga_alvo=${alvo}`);
    assert.match(html, /<form method="POST" action="\/admin\/massa-wa" id="form-segmento">/);
    assert.match(html, /id="previa-segmento-conteudo"/);
    assert.match(html, /name="previa" value="1"\s+formaction="\/admin\/massa-wa\/nova#previa-segmento" formmethod="get" formnovalidate>Atualizar prévia/);
    assert.match(html, /setTimeout\(atualizar, 800\)/);
    assert.match(html, /\/admin\/massa-wa\/segmento\/previa/);
  });
  assert.equal(db.listarCampanhasMassaWa().length, 0);
});

test('sem JavaScript: GET /nova com os campos e previa=1 mostra a previa e preserva o que foi digitado', async () => {
  const { alvo } = cenarioSimples(4);
  await comServidor(async (base) => {
    const q = new URLSearchParams({
      fonte: 'segmento', vaga_alvo_id: String(alvo), nome: 'Teste Sem JS', cidade: 'Joinville', teto: '3',
      dias_outros_canais: '7', lote_min: '4', previa: '1',
    });
    const html = await get(base, `/admin/massa-wa/nova?${q}`);
    assert.match(html, /name="nome" value="Teste Sem JS"/);
    assert.match(html, /name="teto" required value="3"/);
    assert.match(html, /name="dias_outros_canais" value="7"/);
    assert.match(html, /name="lote_min" value="4"/);
    assert.match(html, /data-previa-segmento="1"/);
    assert.deepEqual(nomesDaTabela(html), ['P000', 'P001', 'P002']);
  });
  assert.equal(db.listarCampanhasMassaWa().length, 0);
});

test('edicao de campanha existente NAO ganha painel nem script de previa ao vivo', async () => {
  const { alvo } = cenarioSimples(2);
  await comServidor(async (base) => {
    await post(base, '/admin/massa-wa', camposSegmento(alvo));
    const html = await get(base, `/admin/massa-wa/${ultimaCampanha().id}`);
    assert.doesNotMatch(html, /previa-segmento-conteudo|id="form-segmento"|setTimeout\(atualizar/);
  });
});

// O script da tela, executado com DOM, fetch e relogio FALSOS: prova o atraso de 800 ms, o
// cancelamento do pedido anterior, o filtro invalido e a sessao expirada sem navegador.
async function scriptDaCriacao() {
  const { alvo } = cenarioSimples(1);
  return comServidor(async (base) => {
    const html = await get(base, `/admin/massa-wa/nova?fonte=segmento&vaga_alvo=${alvo}`);
    const ini = html.indexOf('<script>\n      (function () {\n        var form = document.getElementById(\'form-segmento\')');
    assert.ok(ini >= 0);
    return html.slice(ini + '<script>'.length, html.indexOf('</script>', ini));
  });
}

function rodarScript(codigo, { respostas = [] } = {}) {
  const vm = require('node:vm');
  const ouvintes = {};
  const timers = new Map();
  let proximoTimer = 1;
  let agora = 0;
  const pedidos = [];
  const campo = (name, extra = {}) => ({ name, value: '', checkValidity: () => true, ...extra });
  const elementos = { teto: campo('teto'), data_de: campo('data_de'), data_ate: campo('data_ate'), nome: campo('nome') };
  const form = { elements: elementos, addEventListener: (t, fn) => { (ouvintes[t] = ouvintes[t] || []).push(fn); } };
  const el = () => ({ textContent: '', innerHTML: '', style: {}, addEventListener: (t, fn) => { (ouvintes[`el:${t}`] = ouvintes[`el:${t}`] || []).push(fn); } });
  const nos = { 'form-segmento': form, 'previa-segmento-conteudo': el(), 'previa-segmento-estado': el(), 'btn-atualizar-previa': el() };
  const sandbox = {
    document: { getElementById: (id) => nos[id] },
    URLSearchParams,
    AbortController,
    FormData: function FormData() { return [['teto', elementos.teto.value || '30']]; },
    setTimeout: (fn, ms) => { const id = proximoTimer++; timers.set(id, { fn, quando: agora + ms }); return id; },
    clearTimeout: (id) => timers.delete(id),
    fetch: (url, opcoes) => {
      const p = { url, opcoes };
      pedidos.push(p);
      const html = respostas.length ? respostas.shift() : '<div data-previa-segmento="1">ok</div>';
      return Promise.resolve({ text: () => Promise.resolve(html) });
    },
  };
  sandbox.location = { href: '' };
  sandbox.window = sandbox;
  vm.runInNewContext(codigo, sandbox);
  const avancar = (ms) => {
    agora += ms;
    for (const [id, t] of [...timers]) if (t.quando <= agora) { timers.delete(id); t.fn(); }
  };
  const disparar = (tipo, name) => (ouvintes[tipo] || []).forEach((fn) => fn({ type: tipo, target: { name } }));
  return { pedidos, avancar, disparar, nos, elementos, sandbox, esperar: () => new Promise((r) => setImmediate(r)) };
}

test('script: previa no carregamento; 800 ms depois da ULTIMA mudanca; nome nao dispara', async () => {
  const s = rodarScript(await scriptDaCriacao());
  assert.equal(s.pedidos.length, 1); // carregamento
  s.disparar('input', 'teto');
  s.avancar(500);
  s.disparar('input', 'teto');
  s.avancar(799);
  assert.equal(s.pedidos.length, 1);
  s.avancar(1);
  assert.equal(s.pedidos.length, 2);
  assert.equal(s.pedidos[1].url, '/admin/massa-wa/segmento/previa');
  assert.match(s.pedidos[1].opcoes.body, /pagina=1/);
  s.disparar('input', 'nome');
  s.disparar('input', 'lote_min');
  s.avancar(5000);
  assert.equal(s.pedidos.length, 2);
});

test('script: um pedido novo CANCELA o anterior', async () => {
  const s = rodarScript(await scriptDaCriacao());
  const primeiro = s.pedidos[0].opcoes.signal;
  s.disparar('change', 'teto');
  s.avancar(800);
  assert.equal(primeiro.aborted, true);
  assert.equal(s.pedidos[1].opcoes.signal.aborted, false);
});

test('script: filtro invalido nao dispara pedido e avisa', async () => {
  const s = rodarScript(await scriptDaCriacao());
  s.elementos.teto.checkValidity = () => false;
  s.disparar('input', 'teto');
  s.avancar(800);
  assert.equal(s.pedidos.length, 1);
  assert.match(s.nos['previa-segmento-estado'].textContent, /Filtros inválidos/);
  s.elementos.teto.checkValidity = () => true;
  s.elementos.data_de.value = '2026-10-05';
  s.elementos.data_ate.value = '2026-10-01';
  s.disparar('input', 'data_de');
  s.avancar(800);
  assert.equal(s.pedidos.length, 1);
});

test('script: resposta sem a marca do fragmento (login) = sessao expirada, painel nao e trocado', async () => {
  const s = rodarScript(await scriptDaCriacao(), { respostas: ['<html>login</html>'] });
  await s.esperar();
  await s.esperar();
  assert.match(s.nos['previa-segmento-estado'].textContent, /Sessão expirada/);
  assert.equal(s.nos['previa-segmento-conteudo'].innerHTML, '');
});

// ══════════════════ I4: TROCA DE CIDADE NA CRIACAO ══════════════════

function cenarioDuasCidades() {
  const { alvo, origem } = cenarioSimples(2);
  const parada = vaga({ titulo: 'Parada Joinville' });
  const deCuritiba = vaga({ ativo: false, cidade: 'Curitiba', titulo: 'Antiga Curitiba' });
  const abertaCuritiba = vaga({ cidade: 'Curitiba', titulo: 'Aberta Curitiba' });
  candidatura(deCuritiba, { nome: 'Curitibano' });
  return { alvo, origem, parada, deCuritiba, abertaCuritiba };
}

test('criacao: texto novo e botao "Recarregar vagas da cidade" (GET, sem JS)', async () => {
  const { alvo } = cenarioDuasCidades();
  await comServidor(async (base) => {
    const html = await get(base, `/admin/massa-wa/nova?fonte=segmento&vaga_alvo=${alvo}`);
    assert.match(html, /a tela recarrega com as vagas da nova cidade/);
    assert.match(html, /name="recarregar" value="1"\s+formaction="\/admin\/massa-wa\/nova" formmethod="get" formnovalidate>Recarregar vagas da cidade/);
    assert.doesNotMatch(html, /salve e reabra/);
  });
});

test('recarga com OUTRA cidade: listas da cidade nova, digitado preservado, vagas da anterior desmarcadas com aviso', async () => {
  const { alvo, origem, parada, deCuritiba, abertaCuritiba } = cenarioDuasCidades();
  await comServidor(async (base) => {
    const q = new URLSearchParams({ fonte: 'segmento', vaga_alvo_id: String(alvo), nome: 'Troca', cidade: 'Curitiba', teto: '9', recarregar: '1' });
    q.append('vagas_origem', String(origem));
    q.append('vagas_ignoradas', String(parada));
    const html = await get(base, `/admin/massa-wa/nova?${q}`);
    assert.match(html, /<option value="Curitiba" selected>/);
    assert.match(html, /name="nome" value="Troca"/);
    assert.match(html, /name="teto" required value="9"/);
    assert.match(html, new RegExp(`name="vagas_origem" value="${deCuritiba}">`));
    assert.match(html, new RegExp(`name="vagas_ignoradas" value="${abertaCuritiba}">`));
    assert.doesNotMatch(html, new RegExp(`name="vagas_origem" value="${origem}"`));
    assert.match(html, /2 vaga\(s\) marcada\(s\) da cidade anterior foram desmarcadas: as listas agora são de Curitiba\./);
  });
  assert.equal(db.listarCampanhasMassaWa().length, 0);
});

test('recarga na MESMA cidade mantem as marcacoes e nao avisa nada', async () => {
  const { alvo, origem, parada } = cenarioDuasCidades();
  await comServidor(async (base) => {
    const q = new URLSearchParams({ fonte: 'segmento', vaga_alvo_id: String(alvo), nome: 'Mesma', cidade: 'Joinville', teto: '9', recarregar: '1' });
    q.append('vagas_origem', String(origem));
    q.append('vagas_ignoradas', String(parada));
    const html = await get(base, `/admin/massa-wa/nova?${q}`);
    assert.match(html, new RegExp(`name="vagas_origem" value="${origem}" checked>`));
    assert.match(html, new RegExp(`name="vagas_ignoradas" value="${parada}" checked>`));
    assert.doesNotMatch(html, /da cidade anterior foram desmarcadas/);
  });
});

test('script: trocar a cidade recarrega a tela (GET com recarregar=1), sem pedir previa da cidade velha', async () => {
  const s = rodarScript(await scriptDaCriacao());
  s.disparar('input', 'cidade');
  s.avancar(800);
  assert.equal(s.sandbox.location.href, '');
  assert.equal(s.pedidos.length, 1);
  s.disparar('change', 'cidade');
  assert.match(s.sandbox.location.href, /^\/admin\/massa-wa\/nova\?.*recarregar=1/);
  s.avancar(5000);
  assert.equal(s.pedidos.length, 1);
});

test('sem JS, cidade trocada e "Atualizar previa": a previa usa as marcacoes que a tela mostra', async () => {
  const { alvo, origem } = cenarioDuasCidades();
  await comServidor(async (base) => {
    const q = new URLSearchParams({ fonte: 'segmento', vaga_alvo_id: String(alvo), nome: 'X', cidade: 'Curitiba', teto: '9', previa: '1' });
    q.append('vagas_origem', String(origem)); // de Joinville: descartada
    const html = await get(base, `/admin/massa-wa/nova?${q}`);
    assert.match(html, /1 vaga\(s\) marcada\(s\) da cidade anterior foram desmarcadas/);
    assert.deepEqual(nomesDaTabela(html), ['Curitibano']);
  });
});
