'use strict';

// Campanha em massa por WhatsApp via Meta Cloud API: schema, adaptador, job e webhook.
//
// ── ZERO REDE, ZERO CREDENCIAL ──
// O adaptador roda em MOCK (default) ou com httpClient injetado. Nenhum teste chama a Meta,
// nenhum usa token real.
//
// ── O QUE ESTA EM JOGO ──
// Mensagem em massa num canal onde a punicao por erro nao e reputacao gradual, e sim perda do
// numero. Os erros nao sao simetricos:
//   nao enviar     alguem fica sem o convite. Corrigivel.
//   enviar demais  duplicata, ou envio a quem pediu para sair -> denuncia -> tier rebaixado.
// Por isso a maioria das assercoes verifica que NAO saiu.

const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');

process.env.DATABASE_PATH = path.join(os.tmpdir(), `vm-test-campanha-meta-${process.pid}-${Date.now()}.db`);
process.env.INTERVIEW_MOCK = 'true';
process.env.SESSION_SECRET = 'segredo-de-teste';
process.env.ADMIN_USER = 'admin-teste';
process.env.ADMIN_PASSWORD = 'senha-teste';
process.env.META_APP_SECRET = 'segredo-do-app-de-teste';
process.env.META_WEBHOOK_VERIFY_TOKEN = 'token-de-verificacao-de-teste';
process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert/strict');

const db = require('../src/db');
const { migrar } = require('../src/db/migrate');
const { criarApp } = require('../src/server');
const meta = require('../src/providers/whatsappMeta/metaWhatsapp');
const job = require('../src/lib/campanhaWhatsapp');
const webhook = require('../src/routes/webhook_meta');
const { CIDADES_VALIDAS } = require('../src/lib/cidades');

migrar();

const conn = () => db.getDb();
const exec = (sql, ...p) => conn().prepare(sql).run(...p);
const uma = (sql, ...p) => conn().prepare(sql).get(...p);
const todas = (sql, ...p) => conn().prepare(sql).all(...p);

function semRuido(fn) {
  const { log, warn, error } = console;
  const linhas = [];
  const cap = (...a) => linhas.push(a.join(' '));
  console.log = console.warn = console.error = cap;
  try {
    const r = fn();
    return r && typeof r.then === 'function' ? r.then((v) => ({ r: v, linhas })) : { r, linhas };
  } finally {
    Object.assign(console, { log, warn, error });
  }
}

const TEMPLATE = {
  nome_meta: 'confirmacao_cadastro_vaga_vm',
  idioma: 'pt_BR',
  variaveis: [
    { posicao: 1, campo: 'nome_primeiro' },
    { posicao: 2, campo: 'cargo_vaga' },
    { posicao: 3, campo: 'link_grupo_regiao' },
  ],
};

function zerar() {
  exec('DELETE FROM campanha_whatsapp_envios');
  exec('DELETE FROM campanhas_whatsapp');
  exec('DELETE FROM templates_whatsapp');
  exec('DELETE FROM regioes_grupos_whatsapp');
  exec('DELETE FROM whatsapp_opt_out');
  db.definirConfigBool(job.CHAVE_ATIVO, false);
}

function montarCenario({ link = 'https://chat.whatsapp.com/ABC123', cidade = 'Joinville' } = {}) {
  const tid = Number(
    exec(
      'INSERT INTO templates_whatsapp (nome_meta, idioma, categoria, variaveis) VALUES (?, ?, ?, ?)',
      TEMPLATE.nome_meta,
      TEMPLATE.idioma,
      'utility',
      JSON.stringify(TEMPLATE.variaveis),
    ).lastInsertRowid,
  );
  exec('INSERT INTO regioes_grupos_whatsapp (cidade, link_convite_grupo) VALUES (?, ?)', cidade, link);
  const cid = db.criarCampanhaWhatsapp({ nome: 'Convite grupo', templateId: tid, baseAlvo: 'ambos' });
  db.definirStatusCampanhaWhatsapp(cid, 'ativa');
  return { tid, cid, cidade };
}

const adicionar = (cid, telefone, nome, cidade) =>
  db.materializarEnvioCampanhaWhatsapp({
    campanhaId: cid,
    telefone,
    nome,
    origemTipo: 'talento',
    origemId: 1,
    cidade,
  });

const fila = (cid) => todas('SELECT * FROM campanha_whatsapp_envios WHERE campanha_id = ? ORDER BY id', cid);
const deps = (extra = {}) => ({ intervaloMs: 0, dormir: async () => {}, ...extra });

// ══════════════════ Schema ══════════════════

test('as cinco tabelas existem com as colunas esperadas', () => {
  const esperado = {
    templates_whatsapp: ['id', 'nome_meta', 'idioma', 'categoria', 'variaveis', 'ativo', 'criado_em', 'atualizado_em'],
    regioes_grupos_whatsapp: ['id', 'cidade', 'link_convite_grupo', 'ativo', 'criado_em', 'atualizado_em'],
    // tipo_mensagem/job_id/total_estimado entraram na extensao de dois tipos de campanha.
    campanhas_whatsapp: ['id', 'nome', 'template_id', 'base_alvo', 'tipo_mensagem', 'job_id', 'total_estimado', 'criterios_json', 'status', 'criado_em', 'iniciada_em', 'concluida_em'],
    campanha_whatsapp_envios: ['id', 'campanha_id', 'telefone', 'nome', 'origem_tipo', 'origem_id', 'cidade', 'status', 'wamid', 'enviado_em', 'erro', 'tentativas', 'criado_em'],
    whatsapp_opt_out: ['telefone', 'origem', 'criado_em'],
  };
  for (const [tabela, colunas] of Object.entries(esperado)) {
    const reais = todas('SELECT * FROM pragma_table_info(?)', tabela).map((c) => c.name);
    assert.deepEqual(reais, colunas, tabela);
  }
});

test('os CHECK barram valores invalidos', () => {
  zerar();
  // Categoria fora das tres que a Meta reconhece: escolher errado e motivo de rejeicao la.
  assert.throws(() =>
    exec("INSERT INTO templates_whatsapp (nome_meta, categoria, variaveis) VALUES ('t','promocional','[]')"));
  // Status fora do enum da fila.
  const { cid } = montarCenario();
  assert.throws(() =>
    exec("INSERT INTO campanha_whatsapp_envios (campanha_id,telefone,origem_tipo,status) VALUES (?, '5547999582500','talento','pendurado')", cid));
});

test('UNIQUE(campanha_id, telefone): a mesma pessoa entra UMA vez', () => {
  zerar();
  const { cid } = montarCenario();
  assert.equal(adicionar(cid, '5547999582500', 'Ana', 'Joinville'), 1);
  // No WhatsApp, duplicata e denuncia, e denuncia custa o numero.
  assert.equal(adicionar(cid, '5547999582500', 'Ana', 'Joinville'), 0);
  assert.equal(fila(cid).length, 1);
});

// ══════════════════ Adaptador em mock ══════════════════

test('mock e o DEFAULT quando a variavel esta ausente', () => {
  const original = process.env.META_CAMPANHA_MOCK;
  delete process.env.META_CAMPANHA_MOCK;
  try {
    // A ausencia nao pode significar "pode enviar": cada mensagem real custa dinheiro e conta
    // para a qualidade do numero.
    assert.equal(meta.modoMock(), true);
    process.env.META_CAMPANHA_MOCK = 'true';
    assert.equal(meta.modoMock(), true);
    process.env.META_CAMPANHA_MOCK = 'false';
    assert.equal(meta.modoMock(), false);
  } finally {
    if (original === undefined) delete process.env.META_CAMPANHA_MOCK;
    else process.env.META_CAMPANHA_MOCK = original;
  }
});

test('mock NAO faz chamada de rede e devolve wamid deterministico', async () => {
  let chamou = 0;
  const httpClient = async () => {
    chamou += 1;
    throw new Error('a rede nao pode ser tocada em mock');
  };
  const { r: a } = await semRuido(() =>
    meta.enviarTemplate({ telefone: '5547999582500', template: TEMPLATE, variaveis: ['Ana', 'SDR', 'x'], httpClient }));
  const { r: b } = await semRuido(() =>
    meta.enviarTemplate({ telefone: '5547999582500', template: TEMPLATE, variaveis: ['Ana', 'SDR', 'x'], httpClient }));

  assert.equal(chamou, 0, 'nenhuma chamada de rede em mock');
  assert.equal(a.mock, true);
  assert.match(a.wamid, /^mock-/, 'o prefixo evita casar com evento de webhook real');
  // Deterministico: rodar o ciclo duas vezes nao inventa duas mensagens diferentes.
  assert.equal(a.wamid, b.wamid);
});

test('o log do mock mascara o telefone', async () => {
  const { linhas } = await semRuido(() =>
    meta.enviarTemplate({ telefone: '5547999582500', template: TEMPLATE, variaveis: [] }));
  const tudo = linhas.join('\n');
  assert.doesNotMatch(tudo, /5547999582500/, 'numero completo vazou para o log');
  assert.match(tudo, /5547\*+2500/);
});

test('o payload segue o formato da Cloud API, com variaveis POSICIONAIS', () => {
  const p = meta.montarPayload({
    telefone: '5547999582500',
    template: TEMPLATE,
    variaveis: ['Ana', 'Vendedor', 'https://chat.whatsapp.com/X'],
  });
  assert.equal(p.messaging_product, 'whatsapp');
  assert.equal(p.type, 'template');
  assert.equal(p.to, '5547999582500');
  assert.equal(p.template.name, TEMPLATE.nome_meta);
  assert.equal(p.template.language.code, 'pt_BR');
  // A ordem no array E o {{n}} do template — a Meta nao tem variavel nomeada.
  assert.deepEqual(p.template.components[0].parameters, [
    { type: 'text', text: 'Ana' },
    { type: 'text', text: 'Vendedor' },
    { type: 'text', text: 'https://chat.whatsapp.com/X' },
  ]);
});

test('classificacao: codigo da Meta vence o status HTTP', () => {
  // Mesma licao ja aprendida no ZeptoMail e no SendGrid: o status nao separa as causas.
  const c = (m) => meta.classificarErroMeta(new Error(m)).categoria;
  assert.equal(c('HTTP 400 — {"error":{"code":190,"message":"token"}}'), 'configuracao');
  assert.equal(c('HTTP 400 — {"error":{"code":131026,"message":"undeliverable"}}'), 'terminal');
  assert.equal(c('HTTP 400 — {"error":{"code":130429,"message":"rate limit"}}'), 'retentavel');
  assert.equal(c('HTTP 401 — sem codigo'), 'configuracao');
  assert.equal(c('HTTP 429 — sem codigo'), 'retentavel');
  assert.equal(c('HTTP 503 — sem codigo'), 'retentavel');
  assert.equal(c('Meta retornou: template does not exist'), 'terminal');
  // Desconhecido -> retentavel, pela assimetria de custo (perder a pessoa e definitivo).
  assert.equal(c('coisa nunca vista'), 'retentavel');
});

// ══════════════════ Job ══════════════════

test('kill-switch OFF: nao processa nada', async () => {
  zerar();
  const { cid } = montarCenario();
  adicionar(cid, '5547999582500', 'Ana', 'Joinville');

  let enviou = 0;
  const { r } = await semRuido(() =>
    job.processarCicloCampanhaWhatsapp(deps({ enviarTemplate: async () => { enviou += 1; return { wamid: 'x' }; } })));

  assert.equal(r.desativado, true);
  assert.equal(enviou, 0);
  assert.equal(fila(cid)[0].status, 'pendente');
});

test('fluxo feliz: envia, grava wamid e marca enviado', async () => {
  zerar();
  db.definirConfigBool(job.CHAVE_ATIVO, true);
  const { cid } = montarCenario();
  adicionar(cid, '5547999582500', 'Ana Paula', 'Joinville');

  const recebido = [];
  const { r } = await semRuido(() =>
    job.processarCicloCampanhaWhatsapp(deps({
      enviarTemplate: async (a) => { recebido.push(a); return { wamid: 'wamid-real-123' }; },
    })));

  assert.equal(r.enviados, 1);
  const linha = fila(cid)[0];
  assert.equal(linha.status, 'enviado');
  assert.equal(linha.wamid, 'wamid-real-123');
  // As tres variaveis, na ordem, com o link da praca resolvido.
  assert.deepEqual(recebido[0].variaveis, ['Ana', '', 'https://chat.whatsapp.com/ABC123']);
});

test('praca SEM link: falha SO daquele envio, o ciclo continua', async () => {
  zerar();
  db.definirConfigBool(job.CHAVE_ATIVO, true);
  const { cid } = montarCenario({ cidade: 'Joinville' });
  // Curitiba existe no enum mas nao tem link cadastrado neste cenario.
  adicionar(cid, '5541900000001', 'Sem Link', 'Curitiba');
  adicionar(cid, '5547999582500', 'Com Link', 'Joinville');

  const { r } = await semRuido(() =>
    job.processarCicloCampanhaWhatsapp(deps({ enviarTemplate: async () => ({ wamid: 'w' }) })));

  // Uma praca mal configurada nao pode impedir as outras.
  assert.equal(r.falhas, 1);
  assert.equal(r.enviados, 1);
  const linhas = fila(cid);
  const semLink = linhas.find((l) => l.cidade === 'Curitiba');
  assert.equal(semLink.status, 'falha');
  assert.match(semLink.erro, /sem link de grupo/);
  // E nao fica pendente para sempre reaparecendo em todo ciclo.
  assert.notEqual(semLink.status, 'pendente');
});

test('opt-out: marca opt_out e NAO envia', async () => {
  zerar();
  db.definirConfigBool(job.CHAVE_ATIVO, true);
  const { cid } = montarCenario();
  adicionar(cid, '5547999582500', 'Ana', 'Joinville');
  db.registrarOptOutWhatsapp('5547999582500', 'resposta_webhook');

  let enviou = 0;
  const { r } = await semRuido(() =>
    job.processarCicloCampanhaWhatsapp(deps({ enviarTemplate: async () => { enviou += 1; return { wamid: 'x' }; } })));

  assert.equal(enviou, 0, 'quem pediu para sair nao pode receber');
  assert.equal(r.optOut, 1);
  // 'opt_out' e nao 'falha': falha e problema tecnico, opt_out e vontade da pessoa.
  assert.equal(fila(cid)[0].status, 'opt_out');
});

test('erro de CONFIGURACAO aborta o ciclo sem marcar ninguem', async () => {
  zerar();
  db.definirConfigBool(job.CHAVE_ATIVO, true);
  const { cid } = montarCenario();
  for (let i = 0; i < 3; i += 1) adicionar(cid, `554790000000${i}`, `P${i}`, 'Joinville');

  let chamadas = 0;
  const { r } = await semRuido(() =>
    job.processarCicloCampanhaWhatsapp(deps({
      enviarTemplate: async () => { chamadas += 1; throw new Error('HTTP 401 — {"error":{"code":190}}'); },
    })));

  assert.equal(r.abortado, true);
  // Token invalido nao e falha deste destinatario: insistir nos outros so repete o erro.
  assert.equal(chamadas, 1);
  assert.equal(fila(cid).every((l) => l.status === 'pendente' && l.tentativas === 0), true);
});

test('retry: conta tentativa, fica pendente ate o teto, depois falha', async () => {
  zerar();
  db.definirConfigBool(job.CHAVE_ATIVO, true);
  const { cid } = montarCenario();
  adicionar(cid, '5547999582500', 'Ana', 'Joinville');

  const rodar = () =>
    semRuido(() => job.processarCicloCampanhaWhatsapp(deps({
      enviarTemplate: async () => { throw new Error('HTTP 429 — rate limit'); },
    })));

  for (let i = 1; i < meta.TETO_RETENTAVEL; i += 1) {
    const { r } = await rodar();
    assert.equal(r.retentar, 1, `ciclo ${i}`);
    assert.equal(fila(cid)[0].status, 'pendente');
    assert.equal(fila(cid)[0].tentativas, i);
  }
  const { r } = await rodar();
  assert.equal(r.falhas, 1);
  assert.equal(fila(cid)[0].status, 'falha');
});

test('erro TERMINAL nao retenta', async () => {
  zerar();
  db.definirConfigBool(job.CHAVE_ATIVO, true);
  const { cid } = montarCenario();
  adicionar(cid, '5547999582500', 'Ana', 'Joinville');

  const { r } = await semRuido(() => job.processarCicloCampanhaWhatsapp(deps({
    enviarTemplate: async () => { throw new Error('HTTP 400 — {"error":{"code":131026}}'); },
  })));
  assert.equal(r.falhas, 1);
  assert.equal(fila(cid)[0].status, 'falha');
});

test('campanha PAUSADA nao sai da fila', async () => {
  zerar();
  db.definirConfigBool(job.CHAVE_ATIVO, true);
  const { cid } = montarCenario();
  adicionar(cid, '5547999582500', 'Ana', 'Joinville');
  db.definirStatusCampanhaWhatsapp(cid, 'pausada');

  let enviou = 0;
  await semRuido(() => job.processarCicloCampanhaWhatsapp(deps({
    enviarTemplate: async () => { enviou += 1; return { wamid: 'x' }; },
  })));
  assert.equal(enviou, 0, 'pausar precisa parar de verdade');
});

test('teto por ciclo e throttle ENTRE envios', async () => {
  zerar();
  db.definirConfigBool(job.CHAVE_ATIVO, true);
  const { cid } = montarCenario();
  for (let i = 0; i < 5; i += 1) adicionar(cid, `554790000${String(i).padStart(4, '0')}`, `P${i}`, 'Joinville');

  const pausas = [];
  const { r } = await semRuido(() => job.processarCicloCampanhaWhatsapp({
    porCiclo: 3,
    intervaloMs: 2000,
    dormir: async (ms) => pausas.push(ms),
    enviarTemplate: async () => ({ wamid: 'w' }),
  }));

  assert.equal(r.enviados, 3);
  // 3 envios = 2 pausas. Dormir depois do ultimo so atrasaria o fim do ciclo.
  assert.deepEqual(pausas, [2000, 2000]);
  assert.equal(todas("SELECT id FROM campanha_whatsapp_envios WHERE status='pendente'").length, 2);
});

test('atualizarStatusPorWamid NAO regride', () => {
  zerar();
  const { cid } = montarCenario();
  adicionar(cid, '5547999582500', 'Ana', 'Joinville');
  const id = fila(cid)[0].id;
  db.marcarEnvioWhatsappEnviado(id, 'wamid-x');

  assert.equal(db.atualizarStatusPorWamid('wamid-x', 'entregue'), 1);
  assert.equal(db.atualizarStatusPorWamid('wamid-x', 'lido'), 1);
  // A ordem dos eventos da Meta nao e garantida: um 'entregue' atrasado nao pode rebaixar um
  // 'lido' que ja chegou.
  assert.equal(db.atualizarStatusPorWamid('wamid-x', 'entregue'), 0);
  assert.equal(uma('SELECT status FROM campanha_whatsapp_envios WHERE id = ?', id).status, 'lido');
});

// ══════════════════ Webhook ══════════════════

const assinar = (corpo) =>
  `sha256=${crypto.createHmac('sha256', process.env.META_APP_SECRET).update(corpo).digest('hex')}`;

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

const postar = (base, obj, assinatura) =>
  fetch(`${base}/webhook/whatsapp-meta`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(assinatura === null ? {} : { 'X-Hub-Signature-256': assinatura || assinar(JSON.stringify(obj)) }),
    },
    body: JSON.stringify(obj),
  });

test('handshake GET responde o challenge em texto puro', async () => {
  await comServidor(async (base) => {
    const url = `${base}/webhook/whatsapp-meta?hub.mode=subscribe&hub.verify_token=${process.env.META_WEBHOOK_VERIFY_TOKEN}&hub.challenge=DESAFIO123`;
    const res = await semRuido(() => fetch(url)).then((x) => x.r);
    assert.equal(res.status, 200);
    // JSON aqui faz o cadastro na Meta falhar com uma mensagem que nao explica nada.
    assert.match(res.headers.get('content-type') || '', /text\/plain/);
    assert.equal(await res.text(), 'DESAFIO123');
  });
});

test('handshake com token errado: 403', async () => {
  await comServidor(async (base) => {
    const res = await semRuido(() =>
      fetch(`${base}/webhook/whatsapp-meta?hub.mode=subscribe&hub.verify_token=errado&hub.challenge=X`)).then((x) => x.r);
    assert.equal(res.status, 403);
  });
});

test('POST sem assinatura ou com assinatura invalida: 401', async () => {
  const corpo = { entry: [] };
  await comServidor(async (base) => {
    const semAss = await semRuido(() => postar(base, corpo, null)).then((x) => x.r);
    assert.equal(semAss.status, 401);
    const ruim = await semRuido(() => postar(base, corpo, 'sha256=deadbeef')).then((x) => x.r);
    assert.equal(ruim.status, 401);
  });
});

test('POST com assinatura valida: 200', async () => {
  await comServidor(async (base) => {
    const res = await semRuido(() => postar(base, { entry: [] })).then((x) => x.r);
    assert.equal(res.status, 200);
  });
});

test('status de entrega atualiza a linha pelo wamid', async () => {
  zerar();
  const { cid } = montarCenario();
  adicionar(cid, '5547999582500', 'Ana', 'Joinville');
  db.marcarEnvioWhatsappEnviado(fila(cid)[0].id, 'wamid-entrega');

  const corpo = {
    entry: [{ changes: [{ value: { statuses: [{ id: 'wamid-entrega', status: 'delivered' }] } }] }],
  };
  await comServidor(async (base) => {
    const res = await semRuido(() => postar(base, corpo)).then((x) => x.r);
    assert.equal(res.status, 200);
  });
  assert.equal(fila(cid)[0].status, 'entregue');
});

test('opt-out por PALAVRA-CHAVE grava; resposta comum NAO grava', async () => {
  zerar();
  const msg = (texto, de) => ({
    entry: [{ changes: [{ value: { messages: [{ from: de, text: { body: texto } }] } }] }],
  });

  await comServidor(async (base) => {
    // Resposta comum: NAO e opt-out. Tratar como tal removeria da base exatamente as pessoas
    // mais interessadas.
    for (const texto of ['obrigado!', 'qual o horario?', 'ainda tem vaga', 'nao posso parar de agradecer']) {
      await semRuido(() => postar(base, msg(texto, '5547900000001')));
      assert.equal(db.estaOptOutWhatsapp('5547900000001'), false, texto);
    }
    // Palavra-chave: grava.
    for (const [texto, tel] of [['PARAR', '5547900000002'], ['sair', '5547900000003'], ['Cancelar!', '5547900000004']]) {
      await semRuido(() => postar(base, msg(texto, tel)));
      assert.equal(db.estaOptOutWhatsapp(tel), true, texto);
    }
  });
});

test('pedeOptOut: casa a mensagem inteira, nao "contem a palavra"', () => {
  for (const sim of ['parar', 'PARAR', 'Sair', 'stop', 'cancelar!', 'parar por favor', 'nao quero']) {
    assert.equal(webhook.pedeOptOut(sim), true, sim);
  }
  for (const nao of ['obrigado', 'quero saber mais', 'nao posso parar de agradecer', '', null]) {
    assert.equal(webhook.pedeOptOut(nao), false, String(nao));
  }
});

// ══════════════════ Seed ══════════════════

test('o seed cobre exatamente as 9 pracas do enum', () => {
  zerar();
  for (const cidade of CIDADES_VALIDAS) {
    exec('INSERT OR IGNORE INTO regioes_grupos_whatsapp (cidade) VALUES (?)', cidade);
  }
  const cidades = db.listarRegioesGrupos().map((r) => r.cidade);
  // A lista vem de lib/cidades para nao existir segunda fonte de verdade sobre quais pracas
  // existem.
  assert.deepEqual(cidades, [...CIDADES_VALIDAS].sort((a, b) => a.localeCompare(b, 'pt-BR')));
  assert.equal(db.obterLinkGrupo('Joinville'), null, 'links nascem vazios');
});

// ══════════════════ Admin ══════════════════

async function comAdmin(fn) {
  return comServidor(async (base) => {
    const res = await fetch(`${base}/admin/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ usuario: 'admin-teste', senha: 'senha-teste' }),
      redirect: 'manual',
    });
    const bruto = res.headers.getSetCookie ? res.headers.getSetCookie() : [res.headers.get('set-cookie')];
    const cookie = bruto.filter(Boolean).map((c) => c.split(';')[0]).join('; ');
    return fn(base, { Cookie: cookie });
  });
}

test('admin: a tela exige sessao', async () => {
  await comServidor(async (base) => {
    const res = await fetch(`${base}/admin/campanhas-whatsapp`, { redirect: 'manual' });
    assert.equal(res.status, 302);
    assert.match(res.headers.get('location') || '', /\/admin\/login/);
  });
});

test('admin: a tela lista pracas, templates e diz o que falta', async () => {
  zerar();
  montarCenario();
  await comAdmin(async (base, h) => {
    const html = await (await fetch(`${base}/admin/campanhas-whatsapp`, { headers: h })).text();
    assert.match(html, /Campanha por WhatsApp/);
    assert.match(html, /Links dos grupos por praça/);
    assert.match(html, /confirmacao_cadastro_vaga_vm/);
    // O diagnostico e o ponto da tela: dizer POR QUE nada sai.
    assert.match(html, /interruptor <b>Campanha por WhatsApp<\/b> está desligado/);
    assert.match(html, /META_CAMPANHA_MOCK/);
  });
});

test('admin: salvar link da praca persiste; cidade forjada e recusada', async () => {
  zerar();
  for (const c of CIDADES_VALIDAS) exec('INSERT OR IGNORE INTO regioes_grupos_whatsapp (cidade) VALUES (?)', c);

  await comAdmin(async (base, h) => {
    const salvar = (cidade, link) =>
      fetch(`${base}/admin/campanhas-whatsapp/regiao`, {
        method: 'POST',
        headers: { ...h, 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ cidade, link }),
        redirect: 'manual',
      });

    await salvar('Joinville', 'https://chat.whatsapp.com/JOI');
    assert.equal(db.obterLinkGrupo('Joinville'), 'https://chat.whatsapp.com/JOI');

    // Praca fora do vocabulario criaria uma linha que nenhum envio jamais consulta.
    await salvar('Blumenau', 'https://chat.whatsapp.com/X');
    assert.equal(uma('SELECT COUNT(*) n FROM regioes_grupos_whatsapp WHERE cidade = ?', 'Blumenau').n, 0);
  });
});

test('admin: criar campanha nasce em RASCUNHO e ativar e um segundo clique', async () => {
  zerar();
  const { tid } = montarCenario();
  await comAdmin(async (base, h) => {
    await fetch(`${base}/admin/campanhas-whatsapp`, {
      method: 'POST',
      headers: { ...h, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ nome: 'Convite agosto', template_id: String(tid), base_alvo: 'ambos' }),
      redirect: 'manual',
    });

    const nova = uma("SELECT * FROM campanhas_whatsapp WHERE nome = 'Convite agosto'");
    assert.ok(nova);
    // Criar nao dispara: nasce em rascunho pelo default da coluna.
    assert.equal(nova.status, 'rascunho');

    await fetch(`${base}/admin/campanhas-whatsapp/${nova.id}/status`, {
      method: 'POST',
      headers: { ...h, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ status: 'ativa' }),
      redirect: 'manual',
    });
    const depois = uma('SELECT * FROM campanhas_whatsapp WHERE id = ?', nova.id);
    assert.equal(depois.status, 'ativa');
    assert.ok(depois.iniciada_em, 'ativar carimba iniciada_em');
  });
});

test('admin: o checkbox do kill-switch liga e persiste', async () => {
  zerar();
  await comAdmin(async (base, h) => {
    const html = await (await fetch(`${base}/admin/config`, { headers: h })).text();
    assert.match(html, /name="campanha_whatsapp_ativa"/);
    // Default desligado: o kill-switch nao pode nascer ligado.
    assert.doesNotMatch(html, /name="campanha_whatsapp_ativa" value="1" checked/);

    await fetch(`${base}/admin/config/notificacoes`, {
      method: 'POST',
      headers: { ...h, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ campanha_whatsapp_ativa: '1' }),
      redirect: 'manual',
    });
    assert.equal(db.obterConfigBool(job.CHAVE_ATIVO, false), true);
  });
});

// ══════════════════ Motor de segmentacao (dois tipos) ══════════════════

const publico = require('../src/lib/publicoCampanhaWhatsapp');
const { normalizarTelefoneWhatsapp } = require('../src/lib/whatsapp');
const { montarUrlVaga, UTM_SOURCE_CAMPANHA, UTM_SOURCE_WHATSAPP } = require('../src/lib/ctaCampanha');

let seqSeg = 0;
function vagaCom(cidade, perfil = 'CLOSER') {
  seqSeg += 1;
  return Number(exec(
    'INSERT INTO jobs (slug, titulo, perfil, cidade, ativo) VALUES (?, ?, ?, ?, 1)',
    `vaga-seg-${seqSeg}`, `Vaga ${seqSeg}`, perfil, cidade,
  ).lastInsertRowid);
}
function candidatura(jobId, nome, telefone) {
  seqSeg += 1;
  return Number(exec(
    'INSERT INTO applications (job_id, nome, telefone, token) VALUES (?, ?, ?, ?)',
    jobId, nome, telefone, `tok-seg-${seqSeg}`,
  ).lastInsertRowid);
}
function legado(nome, telefone, cidade, perfil = null) {
  seqSeg += 1;
  return Number(exec(
    "INSERT INTO talentos (nome, email, telefone, cidade, perfil_interesse, categoria) VALUES (?, ?, ?, ?, ?, 'legado')",
    nome, `seg${seqSeg}@x.co`, telefone, cidade, perfil,
  ).lastInsertRowid);
}
function zerarSeg() {
  zerar();
  exec('DELETE FROM applications');
  exec('DELETE FROM talentos');
  exec('DELETE FROM jobs');
}
const tels = (r) => r.itens.map((i) => i.telefone).sort();

test('segmentacao: cidade do CANDIDATO vem da vaga (jobs.cidade)', () => {
  zerarSeg();
  candidatura(vagaCom('Joinville'), 'Ana Silva', '+55 47 99958-2500');
  const r = publico.listarPublicoConviteGrupo({});
  assert.equal(r.total, 1);
  // applications.cidade e coluna orfa: a praca so pode vir da vaga.
  assert.equal(r.itens[0].cidade, 'Joinville');
  assert.equal(r.itens[0].nome_primeiro, 'Ana');
});

test('segmentacao: sem cidade resolvivel fica FORA, sem checkbox', () => {
  zerarSeg();
  candidatura(vagaCom(null), 'Remoto', '+55 47 90000-0001');   // vaga remota
  legado('Sem Cidade', '+55 47 90000-0002', null);
  legado('Com Cidade', '+55 47 90000-0003', 'Joinville');
  // Sem praca nao ha link nem recorte: e invariante, nao preferencia.
  assert.deepEqual(tels(publico.listarPublicoConviteGrupo({})), ['5547900000003']);
});

test("segmentacao: sentinela 'Todas as cidades' NAO entra", () => {
  zerarSeg();
  legado('Coringa', '+55 47 90000-0004', 'Todas as cidades');
  legado('Normal', '+55 47 90000-0005', 'Joinville');
  // No e-mail o coringa amplia o publico; aqui ele nao diz em QUAL praca a pessoa esta.
  assert.deepEqual(tels(publico.listarPublicoConviteGrupo({})), ['5547900000005']);
});

test('segmentacao: opt-out e dedup por TELEFONE', () => {
  zerarSeg();
  const j = vagaCom('Joinville');
  candidatura(j, 'Ana', '+55 (47) 99958-2500');
  legado('Ana Legado', '+55 47999582500', 'Joinville'); // MESMO numero, outro cadastro
  legado('Fora', '+55 47 90000-0006', 'Joinville');
  db.registrarOptOutWhatsapp('5547900000006', 'resposta_webhook');

  const r = publico.listarPublicoConviteGrupo({});
  assert.deepEqual(tels(r), ['5547999582500'], 'dedup por telefone + opt-out');
  // applications vence talentos na exibicao: contexto vivo sobre cadastro antigo.
  assert.equal(r.itens[0].origemTipo, 'application');
});

test('segmentacao: filtro de cidade recorta', () => {
  zerarSeg();
  legado('J', '+55 47 90000-0007', 'Joinville');
  legado('C', '+55 41 90000-0008', 'Curitiba');
  assert.deepEqual(tels(publico.listarPublicoConviteGrupo({ cidades: ['Joinville'] })), ['5547900000007']);
  // Nada marcado = filtro inativo, como nos dropdowns do e-mail.
  assert.equal(publico.listarPublicoConviteGrupo({ cidades: [] }).total, 2);
});

test('divulgacao: exclui quem JA se candidatou aquela vaga (invariante)', () => {
  zerarSeg();
  const alvo = vagaCom('Joinville');
  const outra = vagaCom('Joinville');
  candidatura(alvo, 'Ja Esta', '+55 47 90000-0009');
  candidatura(outra, 'Outra Vaga', '+55 47 90000-0010');
  legado('So Legado', '+55 47 90000-0011', 'Joinville');

  const r = publico.listarPublicoDivulgacaoVaga(alvo, {});
  // Divulgar para quem ja esta na vaga e ruido que custa credibilidade — e no WhatsApp isso
  // e mais visivel que num e-mail.
  assert.deepEqual(tels(r), ['5547900000010', '5547900000011']);
});

test('divulgacao: filtro de perfil, e job_id invalido LANCA', () => {
  zerarSeg();
  const alvo = vagaCom('Joinville');
  legado('SDR', '+55 47 90000-0012', 'Joinville', 'SDR');
  legado('Closer', '+55 47 90000-0013', 'Joinville', 'CLOSER');
  assert.deepEqual(tels(publico.listarPublicoDivulgacaoVaga(alvo, { perfil: 'SDR' })), ['5547900000012']);
  // Divulgacao sem vaga nao existe: a mensagem inteira e sobre ela.
  for (const ruim of [null, 0, -1, 'abc']) {
    assert.throws(() => publico.listarPublicoDivulgacaoVaga(ruim, {}), /job_id valido/);
  }
});

test('divulgacao: vaga REMOTA nao implica "qualquer cidade"', () => {
  zerarSeg();
  const remota = vagaCom(null);
  legado('Joi', '+55 47 90000-0014', 'Joinville');
  legado('Cwb', '+55 41 90000-0015', 'Curitiba');
  // A cidade e da PESSOA; quem escolhe as pracas do publico-alvo e o operador, mesmo para
  // vaga remota.
  assert.deepEqual(tels(publico.listarPublicoDivulgacaoVaga(remota, { cidades: ['Joinville'] })), ['5547900000014']);
});

test('materializacao grava telefone normalizado e cidade resolvida', () => {
  zerarSeg();
  const { cid } = montarCenario();
  candidatura(vagaCom('Joinville'), 'Ana Silva', '+55 (47) 99958-2500');
  const r = publico.listarPublicoConviteGrupo({});

  assert.equal(db.materializarCampanhaWhatsapp(cid, r.itens), 1);
  const linha = fila(cid)[0];
  assert.equal(linha.telefone, '5547999582500');
  assert.equal(linha.cidade, 'Joinville');
  assert.equal(linha.origem_tipo, 'application');
  // Idempotente pelo UNIQUE: rematerializar nao duplica.
  assert.equal(db.materializarCampanhaWhatsapp(cid, r.itens), 0);
});

// ══════════════════ montarUrlVaga parametrizado ══════════════════

test('montarUrlVaga: o comportamento do E-MAIL nao mudou', () => {
  // Nao-regressao: o default de utmSource e a constante de sempre.
  const u = new URL(montarUrlVaga('vaga-x', { campanhaId: 7 }));
  assert.equal(u.searchParams.get('utm_source'), UTM_SOURCE_CAMPANHA);
  assert.equal(u.searchParams.get('utm_source'), 'email');
  assert.equal(u.searchParams.get('campanha_id'), '7');
  assert.equal(u.searchParams.get('campanha_whatsapp_id'), null);
});

test('montarUrlVaga: whatsapp usa a coluna IRMA, nao a do e-mail', () => {
  const u = new URL(montarUrlVaga('vaga-x', { utmSource: UTM_SOURCE_WHATSAPP, campanhaWhatsappId: 7 }));
  assert.equal(u.searchParams.get('utm_source'), 'whatsapp');
  // Passar o id de uma campanha de WhatsApp como campanha_id atribuiria o clique a campanha
  // de E-MAIL de mesmo id, sem erro nenhum.
  assert.equal(u.searchParams.get('campanha_whatsapp_id'), '7');
  assert.equal(u.searchParams.get('campanha_id'), null);
});

test('montarUrlVaga: id invalido nao vira parametro', () => {
  for (const ruim of [0, -1, 'abc', null, undefined]) {
    const u = new URL(montarUrlVaga('vaga-x', { campanhaWhatsappId: ruim }));
    assert.equal(u.searchParams.get('campanha_whatsapp_id'), null, String(ruim));
  }
});

// ══════════════════ Paridade entre os dois motores por telefone ══════════════════
//
// A auditoria encontrou os dois motores de publico POR TELEFONE discordando: o do disparo
// pontual (publicoDisparoWhatsapp, consumido pelo n8n) aplicava a guarda de ida-e-volta antes
// de incluir alguem; o da campanha Meta nao. Seis registros REAIS de producao (applications
// ids 165, 210, 336, 513, 684, 741) eram excluidos por um e incluidos pelo outro.
//
// O estrago do lado do motor novo nao era "alguem fica de fora": era materializar um numero
// que NAO EXISTE — que a Meta ou recusa (gastando tier) ou entrega a OUTRA pessoa.
//
// Os testes abaixo existem em duas camadas: um reproduz o caso exato encontrado, e o outro e
// de PARIDADE — feito para pegar a PROXIMA divergencia, nao esta.

const disparoPontual = require('../src/lib/publicoDisparoWhatsapp');

// Os brutos REAIS dos 6 registros que a auditoria apontou, mais os padroes vizinhos.
const TELEFONES_DA_AUDITORIA = [
  // ── quebrados: normalizam, mas o resultado nao sobrevive a ida e volta ──
  ['+55 +551998115119', false, 'id 336 — DDI duplicado E curto'],
  ['+55 119972122344', false, 'id 165 — 12 digitos apos o DDI'],
  ['+55 119836100077', false, 'id 210 — idem'],
  ['+55 (19) 9999354073', false, 'id 513 — 10 apos o DDD'],
  ['+351 912437103', false, 'id 741 — Portugal; limitacao BR-only, nao dado ruim'],
  ['+55 +5547988301250', false, 'padrao dos 44 ja corrigidos'],
  // ── validos ──
  ['+55 (47) 99958-2500', true, 'formulario com mascara'],
  ['+55 47989251350', true, 'legado sem mascara'],
  ['+55 55987711950', true, 'DDD 55 (RS) — 13 digitos, NAO e DDI duplicado'],
  ['+55 4733334444', true, 'fixo, 12 digitos'],
  // ── nem normalizam ──
  ['123', false, 'curto demais'],
  ['nao tenho', false, 'sem digitos'],
  ['+55 199831863', false, 'id 684 — 11 digitos, curto'],
];

test('o caso EXATO da auditoria: DDI duplicado fica fora dos DOIS tipos de campanha', () => {
  zerarSeg();
  const j = vagaCom('Joinville');
  // applications id 336 de producao, bruto identico.
  candidatura(j, 'Ana Corrompida', '+55 +551998115119');
  candidatura(j, 'Ana Valida', '+55 47 99958-2500');
  legado('Legado Corrompido', '+55 +5547988301250', 'Joinville');

  const convite = semRuido(() => publico.listarPublicoConviteGrupo({})).r;
  const divulgacao = semRuido(() => publico.listarPublicoDivulgacaoVaga(vagaCom('Joinville'), {})).r;

  // So o valido entra, nas duas funcoes.
  assert.deepEqual(tels(convite), ['5547999582500']);
  assert.deepEqual(tels(divulgacao), ['5547999582500']);
  // E o numero corrompido nao aparece em lugar nenhum da saida — nem como chave de dedup.
  for (const r of [convite, divulgacao]) {
    assert.equal(r.itens.some((i) => i.telefone.startsWith('5555')), false);
    assert.equal(r.itens.some((i) => i.telefone.length > 13), false);
  }
});

test('PARIDADE: os dois motores concordam sobre o que e utilizavel', () => {
  // Este teste nao existe para a divergencia que ja foi corrigida — existe para a PROXIMA.
  // Se alguem mexer na guarda de um motor e nao do outro, ele quebra aqui.
  zerarSeg();
  const j = vagaCom('Joinville');
  const esperados = [];

  for (const [bruto, deveEntrar, rotulo] of TELEFONES_DA_AUDITORIA) {
    legado(`P ${rotulo}`, bruto, 'Joinville');
    if (deveEntrar) esperados.push(normalizarTelefoneWhatsapp(bruto));
  }

  // Motor NOVO (campanha Meta).
  const doNovo = new Set(semRuido(() => publico.listarPublicoConviteGrupo({})).r.itens.map((i) => i.telefone));
  // Motor ANTIGO (disparo pontual, consumido pelo n8n).
  const doAntigo = new Set(
    semRuido(() => disparoPontual.listarPendentesPorCidade('Joinville')).r.map((i) => i.telefone),
  );

  // Concordam entre si...
  assert.deepEqual([...doNovo].sort(), [...doAntigo].sort(), 'os dois motores divergiram');
  // ...e concordam com o esperado, para o teste nao passar por os dois estarem igualmente
  // errados.
  assert.deepEqual([...doNovo].sort(), esperados.sort());
});

test('PARIDADE: a guarda e a MESMA funcao, nao uma copia', () => {
  // Recopiar a regra seria garantir que os dois divergissem no primeiro ajuste. O import
  // compartilhado e o que torna a paridade estrutural, e nao coincidencia.
  assert.equal(typeof disparoPontual.telefoneUtilizavel, 'function');
  for (const [bruto, deveEntrar] of TELEFONES_DA_AUDITORIA) {
    const n = normalizarTelefoneWhatsapp(bruto);
    if (!n) continue; // nem normaliza: os dois descartam antes da guarda
    assert.equal(
      semRuido(() => disparoPontual.telefoneUtilizavel(n, 'teste')).r,
      deveEntrar,
      `${bruto} -> ${n}`,
    );
  }
});
