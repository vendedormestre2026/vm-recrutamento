'use strict';

// Painel e observabilidade da regra de status do recrutador (ETAPA B, Incremento B5).
//
// O recrutador ve, ANTES de disparar, quantas pessoas a regra tirou — so agregados. Testes
// sobre o HTML/JSON que o SERVIDOR renderiza (sem executar o JS do navegador): a previa do
// WhatsApp manda o texto pronto em `excluidosPorStatusTexto`, e o JS so o exibe.

const os = require('node:os');
const path = require('node:path');

process.env.DATABASE_PATH = path.join(os.tmpdir(), `vm-test-exclusao-painel-${process.pid}-${Date.now()}.db`);
process.env.INTERVIEW_MOCK = 'true';
process.env.SESSION_SECRET = 'segredo-de-teste';
process.env.ADMIN_USER = 'admin-teste';
process.env.ADMIN_PASSWORD = 'senha-teste';
process.env.DESCADASTRO_SECRET = 'segredo-de-descadastro-de-teste';
process.env.APP_BASE_URL = 'https://entrevista.exemplo.com.br';
process.env.SMTP_CAMPANHA_HOST = 'smtp.exemplo-provedor.com';
process.env.SMTP_CAMPANHA_USUARIO = 'usuario-de-teste';
process.env.SMTP_CAMPANHA_SENHA = 'senha-de-teste';
process.env.SMTP_CAMPANHA_FROM_EMAIL = 'vagas@vagas.exemplo.com.br';
process.env.EMAILIT_API_KEY = 'em_chave-de-teste';
process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert/strict');

const db = require('../src/db');
const { migrar } = require('../src/db/migrate');
const { criarApp } = require('../src/server');
const disparo = require('../src/lib/dispararPromocao');
const { textoExcluidosPorStatus, logExcluidosPorStatus } = require('../src/lib/elegibilidadeStatusPromocao');

migrar();

const run = (sql, ...p) => Number(db.getDb().prepare(sql).run(...p).lastInsertRowid);

let seq = 0;
function vaga() {
  seq += 1;
  return run(
    "INSERT INTO jobs (slug, titulo, perfil, cidade, ativo) VALUES (?, ?, 'CLOSER', 'Joinville', 1)",
    `vaga-painel-${seq}`,
    `Vaga ${seq}`,
  );
}
// Telefone no formato do formulario ('+55 47 ...'), o que o banco guarda de verdade.
function candidatura(jobId, n, { status = null, arquivada = false, criadoEm = '2026-08-01 10:00:00', etapa = 'concluido' } = {}) {
  seq += 1;
  return run(
    `INSERT INTO applications (job_id, nome, email, telefone, status_recrutador, status, token, criado_em, deleted_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    jobId,
    `Pessoa ${n}`,
    `pessoa${n}@x.com`,
    `+55 47 90000-${String(4000 + n)}`,
    status,
    etapa,
    `tok-painel-${seq}`,
    criadoEm,
    arquivada ? '2026-08-10 10:00:00' : null,
  );
}
function legado(n) {
  run(
    "INSERT INTO talentos (nome, email, telefone, cidade, categoria) VALUES (?, ?, ?, 'Joinville', 'legado')",
    `Legado ${n}`,
    `legado${n}@x.com`,
    `+55 47 90000-${String(4000 + n)}`,
  );
}
function zerar() {
  for (const t of [
    'campanha_envios', 'campanhas', 'campanha_whatsapp_envios', 'campanhas_whatsapp', 'applications',
    'talentos', 'descadastros', 'regioes_grupos_whatsapp', 'jobs',
  ]) run(`DELETE FROM ${t}`);
}

// Cenario do B0 em miniatura, valendo para os dois canais (cada pessoa: 1 e-mail, 1 telefone).
function cenarioB0() {
  zerar();
  const antiga = vaga();
  const outra = vaga();
  const alvo = vaga();
  legado(1); // entra
  candidatura(antiga, 2); // sem decisao: entra
  candidatura(antiga, 3, { status: 'reprovado' }); // entra
  candidatura(antiga, 4, { etapa: 'em_entrevista' }); // entra
  candidatura(antiga, 5, { status: 'aprovado', criadoEm: '2026-07-01 10:00:00' }); // sai
  candidatura(outra, 5, { criadoEm: '2026-08-05 10:00:00' });
  candidatura(antiga, 6, { status: 'em_analise' }); // sai
  candidatura(antiga, 7, { status: 'reprovado' }); // sai (so por arquivada)
  candidatura(outra, 7, { status: 'em_analise', arquivada: true });
  return alvo;
}
function soElegiveis() {
  zerar();
  const antiga = vaga();
  const alvo = vaga();
  legado(1);
  candidatura(antiga, 2, { status: 'reprovado' });
  return alvo;
}

const TEXTO_B0 = '3 excluídos por status do recrutador: 1 Aprovado, 2 Em análise (1 só por candidatura arquivada).';
const TEXTO_ZERO = 'Nenhum excluído por status do recrutador.';

// Nenhum e-mail nem sequencia de 8+ digitos (telefone) no trecho.
function semDadoPessoal(trecho, rotulo) {
  assert.doesNotMatch(trecho, /@/, `${rotulo}: tem @`);
  assert.doesNotMatch(trecho, /\d{8,}/, `${rotulo}: tem 8+ digitos`);
}
const blocoStatus = (html) => (html.match(/<p class="excluidos-status"[^>]*>[^<]*<\/p>/) || [null])[0];

async function calado(fn) {
  const { log, warn, error } = console;
  console.log = console.warn = console.error = () => {};
  try {
    return await fn();
  } finally {
    Object.assign(console, { log, warn, error });
  }
}
async function capturarLogs(fn) {
  const linhas = [];
  const { log, warn, error } = console;
  console.log = console.warn = console.error = (...a) => linhas.push(a.join(' '));
  try {
    await fn();
  } finally {
    Object.assign(console, { log, warn, error });
  }
  return linhas;
}

let base;
let cookie;
let server;
test.before(async () => {
  server = criarApp().listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
  const login = await fetch(`${base}/admin/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ usuario: 'admin-teste', senha: 'senha-teste' }),
    redirect: 'manual',
  });
  cookie = login.headers.getSetCookie().map((c) => c.split(';')[0]).join('; ');
});
test.after(() => new Promise((r) => server.close(r)));

const post = (url, dados) =>
  calado(() =>
    fetch(`${base}${url}`, {
      method: 'POST',
      headers: { Cookie: cookie, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(dados),
      redirect: 'manual',
    }),
  );
const get = (url) => calado(() => fetch(`${base}${url}`, { headers: { Cookie: cookie } }));

// ── Texto compartilhado ──

test('texto: null nao se aplica; zero e linha discreta; plural e motivos so os > 0', () => {
  assert.equal(textoExcluidosPorStatus(null), null);
  assert.equal(textoExcluidosPorStatus(undefined), null);
  assert.equal(
    textoExcluidosPorStatus({ total: 0, porMotivo: { aprovado: 0, em_analise: 0, desconhecido: 0 }, apenasArquivada: 0 }),
    TEXTO_ZERO,
  );
  assert.equal(
    textoExcluidosPorStatus({ total: 1, porMotivo: { aprovado: 0, em_analise: 0, desconhecido: 1 }, apenasArquivada: 0 }),
    '1 excluído por status do recrutador: 1 status desconhecido.',
  );
  assert.equal(
    textoExcluidosPorStatus({ total: 1234, porMotivo: { aprovado: 1234, em_analise: 0, desconhecido: 0 }, apenasArquivada: 0 }),
    '1.234 excluídos por status do recrutador: 1.234 Aprovado.',
  );
  // Sem termos internos na frase.
  const t = textoExcluidosPorStatus({ total: 2, porMotivo: { aprovado: 1, em_analise: 1, desconhecido: 0 }, apenasArquivada: 1 });
  assert.doesNotMatch(t, /apenasArquivada|status_nao_elegivel|em_analise/);
  assert.equal(logExcluidosPorStatus(null), 'filtro de status nao se aplica');
});

// ── WhatsApp: previa (JSON) ──

test('WA previa divulgacao_vaga: JSON mantem ok/total/tipo e ganha excluidosPorStatus + texto', async () => {
  const alvo = cenarioB0();
  const res = await post('/admin/campanhas-whatsapp/previa', { tipo_mensagem: 'divulgacao_vaga', job_id: String(alvo) });
  const bruto = await res.text();
  const j = JSON.parse(bruto);
  assert.equal(j.ok, true);
  assert.equal(j.total, 4);
  assert.equal(j.tipo, 'divulgacao_vaga');
  assert.deepEqual(j.excluidosPorStatus, {
    total: 3,
    porMotivo: { aprovado: 1, em_analise: 2, desconhecido: 0 },
    apenasArquivada: 1,
  });
  assert.equal(j.excluidosPorStatusTexto, TEXTO_B0);
  semDadoPessoal(bruto, 'JSON previa WA');
});

test('WA previa: zero excluidos -> linha discreta', async () => {
  const alvo = soElegiveis();
  const j = await (await post('/admin/campanhas-whatsapp/previa', { tipo_mensagem: 'divulgacao_vaga', job_id: String(alvo) })).json();
  assert.equal(j.excluidosPorStatusTexto, TEXTO_ZERO);
  assert.equal(j.excluidosPorStatus.total, 0);
});

test('WA previa convite_grupo e status_candidatura: bloco nao se aplica (null)', async () => {
  const alvo = cenarioB0();
  const convite = await (await post('/admin/campanhas-whatsapp/previa', { tipo_mensagem: 'convite_grupo' })).json();
  assert.equal(convite.ok, true);
  assert.equal(convite.excluidosPorStatus, null);
  assert.equal(convite.excluidosPorStatusTexto, null);

  const situacao = await (
    await post('/admin/campanhas-whatsapp/previa', { tipo_mensagem: 'status_candidatura', job_id: String(alvo - 2), status_recrutador: 'aprovado' })
  ).json();
  assert.equal(situacao.ok, true);
  assert.equal(situacao.excluidosPorStatus, null);
  assert.equal(situacao.excluidosPorStatusTexto, null);
});

test('WA tela: elemento da linha existe, neutro e escondido ate a previa', async () => {
  const html = await (await get('/admin/campanhas-whatsapp')).text();
  const el = html.match(/<p id="exclusao-previa"[^>]*><\/p>/);
  assert.ok(el, 'elemento exclusao-previa ausente');
  assert.match(el[0], /hidden/);
  assert.match(el[0], /color:var\(--cinza\)/);
  assert.doesNotMatch(el[0], /class=/, 'sem classe de aviso colorida');
});

test('WA disparo: log agregado na materializacao, sem dado pessoal', async () => {
  const alvo = cenarioB0();
  const tid = run("INSERT INTO templates_whatsapp (nome_meta, categoria, variaveis) VALUES ('tpl_painel', 'marketing', '[]')");
  const cid = db.criarCampanhaWhatsapp({
    nome: 'Divulgacao painel',
    templateId: tid,
    baseAlvo: 'ambos',
    tipoMensagem: 'divulgacao_vaga',
    jobId: alvo,
    criterios: {},
  });
  const linhas = await capturarLogs(() =>
    fetch(`${base}/admin/campanhas-whatsapp/${cid}/disparar`, {
      method: 'POST',
      headers: { Cookie: cookie },
      redirect: 'manual',
    }),
  );
  const materializou = linhas.find((l) => l.includes(`campanha ${cid} materializada`));
  assert.ok(materializou, linhas.join('\n'));
  assert.match(
    materializou,
    /com 4 destinatario\(s\); excluidos por status do recrutador: 3 \(aprovado: 1, em_analise: 2, desconhecido: 0; so por candidatura arquivada: 1\)/,
  );
  for (const l of linhas) semDadoPessoal(l, 'log WA');
});

// ── E-mail: previa, revisao, confirmacao ──

test('EMAIL previa divulgacao_vaga: bloco com contagem por motivo e "so por candidatura arquivada"', async () => {
  const alvo = cenarioB0();
  const html = await (await post('/admin/promocao/previa', { vaga: String(alvo) })).text();
  const bloco = blocoStatus(html);
  assert.ok(bloco, 'bloco ausente na previa');
  assert.ok(bloco.includes(TEXTO_B0), bloco);
  assert.match(bloco, /color:var\(--cinza\)/);
  semDadoPessoal(bloco, 'previa e-mail');
});

test('EMAIL previa: zero excluidos -> linha discreta', async () => {
  const alvo = soElegiveis();
  const html = await (await post('/admin/promocao/previa', { vaga: String(alvo) })).text();
  assert.ok(blocoStatus(html).includes(TEXTO_ZERO));
});

test('EMAIL previa convite_grupo: bloco NAO aparece', async () => {
  cenarioB0();
  run("INSERT INTO regioes_grupos_whatsapp (cidade, link_convite_grupo) VALUES ('Joinville', 'https://chat.whatsapp.com/abc')");
  const html = await (await post('/admin/promocao/previa', { tipo: 'convite_grupo', cidade_grupo: 'Joinville' })).text();
  assert.match(html, /Prévia do público/);
  assert.equal(blocoStatus(html), null);
  assert.doesNotMatch(html, /por status do recrutador/);
});

function rascunho(alvo, total) {
  return db.criarCampanha({
    job_id: alvo,
    tipo: 'divulgacao_vaga',
    assunto: 'Vaga aberta',
    corpo_html: '<p>Temos uma vaga.</p>',
    criterios: { tipo: 'divulgacao_vaga', jobIdAlvo: alvo },
    total_destinatarios: total,
  });
}
const avisoMudou = (html) => (html.match(/<p class="aviso-alerta">\s*O público mudou[\s\S]*?<\/p>/) || [null])[0];

test('EMAIL revisao: bloco aparece; aviso de publico mudado ganha a frase de status', async () => {
  const alvo = cenarioB0();
  const id = rascunho(alvo, 7); // congelado ANTES da regra: 7; agora sao 4
  const html = await (await get(`/admin/promocao/${id}`)).text();
  assert.ok(blocoStatus(html).includes(TEXTO_B0));
  const aviso = avisoMudou(html);
  assert.ok(aviso, 'aviso de publico mudado ausente');
  assert.match(aviso, /Parte da diferença pode vir da regra de status do recrutador, que hoje\s+exclui <b>3<\/b> pessoas/);
  semDadoPessoal(aviso, 'aviso');
});

test('EMAIL revisao: aviso sem frase de status quando ninguem foi excluido; criterio do aviso nao muda', async () => {
  const alvo = soElegiveis();
  const mudou = rascunho(alvo, 99);
  const aviso = avisoMudou(await (await get(`/admin/promocao/${mudou}`)).text());
  assert.ok(aviso);
  assert.doesNotMatch(aviso, /regra de status/);

  // Total igual ao congelado, mesmo COM excluidos por status: nao ha aviso nenhum.
  const alvo2 = cenarioB0();
  const igual = rascunho(alvo2, 4);
  const html = await (await get(`/admin/promocao/${igual}`)).text();
  assert.equal(avisoMudou(html), null);
  assert.ok(blocoStatus(html).includes(TEXTO_B0));
});

test('EMAIL confirmacao do disparo: bloco aparece antes do botao de confirmar', async () => {
  const alvo = cenarioB0();
  const id = rascunho(alvo, 4);
  const html = await (await post(`/admin/promocao/${id}/disparar`, {})).text();
  assert.match(html, /Confirmar disparo/);
  const bloco = blocoStatus(html);
  assert.ok(bloco && bloco.includes(TEXTO_B0), html.slice(0, 200));
  assert.ok(html.indexOf(bloco) < html.indexOf('Sim, disparar'));
});

test('EMAIL enfileiramento: log agregado, sem dado pessoal; convite_grupo diz que nao se aplica', async () => {
  const alvo = cenarioB0();
  const id = rascunho(alvo, 4);
  const linhas = await capturarLogs(() => disparo.enfileirarCampanha(id, { db }));
  const l = linhas.find((x) => x.includes(`campanha ${id} enfileirada`));
  assert.match(
    l,
    /com 4 destinatario\(s\); excluidos por status do recrutador: 3 \(aprovado: 1, em_analise: 2, desconhecido: 0; so por candidatura arquivada: 1\)\./,
  );
  for (const x of linhas) semDadoPessoal(x, 'log e-mail');

  const idGrupo = db.criarCampanha({
    job_id: null,
    tipo: 'convite_grupo',
    assunto: 'Grupo',
    corpo_html: '<p>g</p>',
    criterios: { tipo: 'convite_grupo', cidadeGrupo: 'Joinville' },
    total_destinatarios: 0,
  });
  const linhasG = await capturarLogs(() => disparo.enfileirarCampanha(idGrupo, { db }));
  assert.ok(linhasG.some((x) => x.includes(`campanha ${idGrupo} enfileirada`) && x.includes('filtro de status nao se aplica')));
});
