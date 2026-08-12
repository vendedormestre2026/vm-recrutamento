'use strict';

// Os DOIS adaptadores ZeptoMail: o transacional (src/providers/email/zeptomail.js) e o de
// campanha (src/providers/emailCampanha/zeptomail.js), mais as duas fachadas que passaram
// a conhece-los.
//
// ── UM ARQUIVO PARA OS DOIS, e nao dois arquivos ──
// Eles falam com a MESMA API e diferem exatamente em tres pontos — remetente, opcoes e
// mime_headers. Ler os dois lado a lado e o que torna essas diferencas visiveis; separa-los
// esconderia justamente o que precisa ser comparado. (Os adaptadores em si continuam
// separados, pelo motivo de raio de explosao registrado em config.js — isto e organizacao
// de TESTE, nao de producao.)
//
// ── ZERO REDE ──
// O transacional nao tem ponto de injecao (o contrato de 3 argumentos nao o preve), entao
// aqui o `fetch` global e substituido e restaurado. O de campanha usa `opcoes.httpClient`,
// o mesmo mecanismo do adaptador Emailit.
//
// ── O QUE ESTA EM JOGO ──
// A migracao de provedor mexe no ENVELOPE, nao no conteudo. O risco nao e o HTML sair
// errado — e o envelope sair num formato que a API aceita calada e entrega mal, ou pior:
// perder o List-Unsubscribe no caminho, que e requisito de entregabilidade (Gmail/Yahoo,
// desde 2024) e nao cortesia. Por isso o teste de campanha valida o TOKEN da URL de
// descadastro, e nao so a presenca do cabecalho.

const os = require('node:os');
const path = require('node:path');

process.env.DATABASE_PATH = path.join(os.tmpdir(), `vm-test-zeptomail-${process.pid}-${Date.now()}.db`);
process.env.INTERVIEW_MOCK = 'true';
process.env.SESSION_SECRET = 'segredo-de-teste';
process.env.DESCADASTRO_SECRET = 'segredo-de-descadastro-de-teste';
process.env.APP_BASE_URL = 'https://entrevista.exemplo.com.br';
process.env.ZEPTOMAIL_TOKEN = 'token-de-teste-zepto';
process.env.RESEND_FROM_EMAIL = 'jean@exemplo.com.br';
process.env.SMTP_CAMPANHA_FROM_EMAIL = 'vagas@vagas.exemplo.com.br';
process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert/strict');

const { config } = require('../src/config');
const desc = require('../src/lib/descadastro');
const zeptoTransacional = require('../src/providers/email/zeptomail');
const zeptoCampanha = require('../src/providers/emailCampanha/zeptomail');
const fachadaTransacional = require('../src/providers/email');
const fachadaCampanha = require('../src/providers/emailCampanha');

// Resposta de sucesso no formato documentado da v1.1.
const RESPOSTA_OK = {
  data: [{ code: 'EM_104', additional_info: [], message: 'OK', message_id: 'msg-abc-123' }],
  message: 'OK',
  request_id: 'req-xyz-789',
  object: 'email',
};

// ── HTTP dublê ── captura url + init e devolve resposta compativel com fetch.
function httpDeTeste({ ok = true, status = 201, json = RESPOSTA_OK, texto = '' } = {}) {
  const chamadas = [];
  const client = async (url, init) => {
    chamadas.push({ url, init, corpo: JSON.parse(init.body) });
    return {
      ok,
      status,
      json: async () => json,
      text: async () => texto || JSON.stringify(json),
    };
  };
  return { client, chamadas, ultima: () => chamadas[chamadas.length - 1] };
}

// O transacional nao aceita httpClient (contrato de 3 argumentos), entao substituimos o
// fetch global e SEMPRE restauramos.
async function comFetchDublado(dublê, fn) {
  const original = global.fetch;
  global.fetch = dublê;
  try {
    return await fn();
  } finally {
    global.fetch = original;
  }
}

// ══════════════════════════════════════════════════════════════
// 1. Adaptador TRANSACIONAL — o envelope
// ══════════════════════════════════════════════════════════════

test('transacional: monta o payload no formato do ZeptoMail', async () => {
  const t = httpDeTeste();
  await comFetchDublado(t.client, () =>
    zeptoTransacional.enviar('candidato@exemplo.com', 'Assunto X', '<p>Corpo</p>'),
  );

  const { url, init, corpo } = t.ultima();
  assert.equal(url, 'https://api.zeptomail.com/v1.1/email');
  assert.equal(init.method, 'POST');

  // `to` e LISTA de { email_address: { address } } — nao string, como era no Resend.
  assert.deepEqual(corpo.to, [{ email_address: { address: 'candidato@exemplo.com' } }]);
  // `htmlbody`, nao `html`.
  assert.equal(corpo.htmlbody, '<p>Corpo</p>');
  assert.equal(corpo.subject, 'Assunto X');
  // `from` e objeto { address, name } — no Resend era string pura.
  assert.deepEqual(corpo.from, { address: 'jean@exemplo.com.br', name: 'Vendedor Mestre' });
});

test('transacional: autenticacao e Zoho-enczapikey, NAO Bearer', async () => {
  // Mandar Bearer aqui devolve 401. E o erro mais facil de cometer vindo do Resend.
  const t = httpDeTeste();
  await comFetchDublado(t.client, () => zeptoTransacional.enviar('a@b.co', 'S', '<p>x</p>'));

  const auth = t.ultima().init.headers.Authorization;
  assert.equal(auth, `Zoho-enczapikey ${process.env.ZEPTOMAIL_TOKEN}`);
  assert.doesNotMatch(auth, /Bearer/);
});

test('transacional: usa o remetente do bloco TRANSACIONAL, nao o de campanha', async () => {
  // A separacao de reputacao sobrevive ao provedor unico justamente aqui.
  const t = httpDeTeste();
  await comFetchDublado(t.client, () => zeptoTransacional.enviar('a@b.co', 'S', '<p>x</p>'));
  assert.equal(t.ultima().corpo.from.address, config.provedores.email.remetente);
  assert.notEqual(t.ultima().corpo.from.address, config.provedores.emailCampanha.remetente);
});

// ── Retorno e erro ──

test('transacional: mapeia data[0].message_id para { id }', async () => {
  const t = httpDeTeste();
  const r = await comFetchDublado(t.client, () =>
    zeptoTransacional.enviar('a@b.co', 'S', '<p>x</p>'),
  );
  assert.deepEqual(r, { id: 'msg-abc-123' });
});

test('transacional: sem message_id, cai para request_id; sem nada, null', () => {
  // A doc da v1.1 NAO lista message_id entre os campos de resposta, embora ele apareca nos
  // exemplos. A cascata existe para o id ser best-effort — ele serve a log, e um formato
  // inesperado nao pode virar falha de um e-mail ja aceito.
  assert.equal(zeptoTransacional.extrairId(RESPOSTA_OK), 'msg-abc-123');
  assert.equal(zeptoTransacional.extrairId({ data: [{}], request_id: 'req-1' }), 'req-1');
  assert.equal(zeptoTransacional.extrairId({ request_id: 'req-2' }), 'req-2');
  assert.equal(zeptoTransacional.extrairId({}), null);
  assert.equal(zeptoTransacional.extrairId(null), null);
});

test('transacional: corpo de resposta ilegivel num 2xx NAO vira erro', async () => {
  // O e-mail ja foi aceito. Lancar aqui faria o chamador registrar como falha alguem que
  // vai receber.
  const t = httpDeTeste();
  const client = async (u, i) => {
    const r = await t.client(u, i);
    return { ...r, json: async () => { throw new Error('json invalido'); } };
  };
  const r = await comFetchDublado(client, () => zeptoTransacional.enviar('a@b.co', 'S', '<p>x</p>'));
  assert.deepEqual(r, { id: null });
});

test('transacional: !ok LANCA com status e recorte do corpo', async () => {
  const t = httpDeTeste({ ok: false, status: 401, texto: 'invalid api token' });
  await assert.rejects(
    () => comFetchDublado(t.client, () => zeptoTransacional.enviar('a@b.co', 'S', '<p>x</p>')),
    /ZeptoMail retornou erro 401.*invalid api token/s,
  );
});

test('transacional: sem token ou sem destinatario, LANCA antes de tocar a rede', async () => {
  const t = httpDeTeste();
  await assert.rejects(
    () => comFetchDublado(t.client, () => zeptoTransacional.enviar('', 'S', '<p>x</p>')),
    /Destinatario de e-mail ausente/,
  );

  const salvo = config.provedores.zeptomail.token;
  config.provedores.zeptomail.token = '';
  try {
    await assert.rejects(
      () => comFetchDublado(t.client, () => zeptoTransacional.enviar('a@b.co', 'S', '<p>x</p>')),
      /ZEPTOMAIL_TOKEN ausente/,
    );
  } finally {
    config.provedores.zeptomail.token = salvo;
  }
  assert.equal(t.chamadas.length, 0, 'nenhuma requisicao pode ter saido');
});

// ══════════════════════════════════════════════════════════════
// 2. Adaptador de CAMPANHA — envelope + opt-out
// ══════════════════════════════════════════════════════════════

test('campanha: monta o payload e usa o remetente de CAMPANHA', async () => {
  const t = httpDeTeste();
  await zeptoCampanha.enviar('pessoa@exemplo.com', 'Vaga aberta', '<p>Corpo</p>', {
    httpClient: t.client,
  });

  const { corpo } = t.ultima();
  assert.deepEqual(corpo.to, [{ email_address: { address: 'pessoa@exemplo.com' } }]);
  assert.equal(corpo.htmlbody, '<p>Corpo</p>');
  assert.deepEqual(corpo.from, {
    address: 'vagas@vagas.exemplo.com.br',
    name: 'Vendedor Mestre — Vagas',
  });
  assert.notEqual(corpo.from.address, config.provedores.email.remetente);
});

test('campanha: List-Unsubscribe vai em mime_headers, NAO em headers', async () => {
  // A mudanca estrutural da migracao. Se isto regredir, a campanha sai sem opt-out valido
  // e o sintoma nao e um erro — e queda de entrega semanas depois, com o dominio marcado.
  const t = httpDeTeste();
  await zeptoCampanha.enviar('p@exemplo.com', 'S', '<p>x</p>', { httpClient: t.client });

  const { corpo } = t.ultima();
  assert.ok(corpo.mime_headers, 'mime_headers ausente');
  assert.equal(corpo.headers, undefined, 'o campo do Emailit nao pode sobrar');
  assert.equal(corpo.mime_headers['List-Unsubscribe-Post'], 'List-Unsubscribe=One-Click');
});

test('campanha: o token da URL de descadastro e VALIDO (nao basta o header existir)', async () => {
  // Um cabecalho presente com token quebrado passaria num teste de presenca e falharia na
  // mao do destinatario.
  const t = httpDeTeste();
  const email = 'validar@exemplo.com';
  await zeptoCampanha.enviar(email, 'S', '<p>x</p>', { httpClient: t.client });

  const bruto = t.ultima().corpo.mime_headers['List-Unsubscribe'];
  const url = new URL(bruto.replace(/^<|>$/g, ''));
  assert.equal(url.pathname, '/descadastro');
  assert.equal(desc.lerEmailDaUrl(url.searchParams.get('e')), email);
  assert.ok(desc.verificarToken(email, url.searchParams.get('t')), 'token invalido');
});

test('campanha: semDescadastro omite os cabecalhos automaticos', async () => {
  const t = httpDeTeste();
  await zeptoCampanha.enviar('p@exemplo.com', 'S', '<p>x</p>', {
    httpClient: t.client,
    semDescadastro: true,
  });
  assert.equal(t.ultima().corpo.mime_headers, undefined);
});

test('campanha: headers do chamador se somam e VENCEM os automaticos', async () => {
  const t = httpDeTeste();
  await zeptoCampanha.enviar('p@exemplo.com', 'S', '<p>x</p>', {
    httpClient: t.client,
    headers: { 'X-Proprio': 'valor', 'List-Unsubscribe': '<https://outro.com/sair>' },
  });
  const mh = t.ultima().corpo.mime_headers;
  assert.equal(mh['X-Proprio'], 'valor');
  assert.equal(mh['List-Unsubscribe'], '<https://outro.com/sair>', 'o do chamador vence');
});

test('campanha: replyTo vira LISTA de objetos (formato do ZeptoMail)', async () => {
  // Diferente do `reply_to` string do Emailit e do `replyTo` do nodemailer.
  const t = httpDeTeste();
  await zeptoCampanha.enviar('p@exemplo.com', 'S', '<p>x</p>', {
    httpClient: t.client,
    replyTo: 'responde@exemplo.com',
  });
  assert.deepEqual(t.ultima().corpo.reply_to, [{ address: 'responde@exemplo.com' }]);
});

test('campanha: sem replyTo, o campo nem aparece', async () => {
  const t = httpDeTeste();
  await zeptoCampanha.enviar('p@exemplo.com', 'S', '<p>x</p>', { httpClient: t.client });
  assert.equal('reply_to' in t.ultima().corpo, false);
});

test('campanha: mapeia o id e nao quebra com corpo ilegivel', async () => {
  const t = httpDeTeste();
  const r = await zeptoCampanha.enviar('p@exemplo.com', 'S', '<p>x</p>', { httpClient: t.client });
  assert.deepEqual(r, { id: 'msg-abc-123' });
});

test('campanha: !ok LANCA com status e recorte do corpo', async () => {
  const t = httpDeTeste({ ok: false, status: 500, texto: 'erro interno do provedor' });
  await assert.rejects(
    () => zeptoCampanha.enviar('p@exemplo.com', 'S', '<p>x</p>', { httpClient: t.client }),
    /ZeptoMail: HTTP 500.*erro interno/s,
  );
});

test('campanha: sem DESCADASTRO_SECRET a campanha NAO sai', async () => {
  // Campanha sem opt-out valido e pior do que campanha nao enviada.
  const t = httpDeTeste();
  const salvo = config.descadastro.segredo;
  config.descadastro.segredo = '';
  try {
    await assert.rejects(
      () => zeptoCampanha.enviar('p@exemplo.com', 'S', '<p>x</p>', { httpClient: t.client }),
      /DESCADASTRO_SECRET/,
    );
  } finally {
    config.descadastro.segredo = salvo;
  }
  assert.equal(t.chamadas.length, 0, 'nada pode ter saido');
});

test('campanha: credenciaisFaltando nomeia as variaveis, no formato do pre-voo', () => {
  assert.deepEqual(zeptoCampanha.credenciaisFaltando(), []);

  const salvo = config.provedores.zeptomail.token;
  config.provedores.zeptomail.token = '';
  try {
    assert.deepEqual(zeptoCampanha.credenciaisFaltando(), ['ZEPTOMAIL_TOKEN']);
  } finally {
    config.provedores.zeptomail.token = salvo;
  }
});

// ══════════════════════════════════════════════════════════════
// 2b. URL de API invalida — o erro que custou o primeiro teste real
// ══════════════════════════════════════════════════════════════

test('garantirUrlValida: aceita http e https, recusa host sem protocolo', () => {
  // O caso real: ZEPTOMAIL_API_URL foi definida no Railway como "api.zeptomail.com", e o
  // fetch lancou "Failed to parse URL from api.zeptomail.com" — mensagem que nao nomeia a
  // variavel, nao diz o que falta e so aparece no primeiro envio.
  assert.doesNotThrow(() => zeptoTransacional.garantirUrlValida('https://api.zeptomail.com/v1.1/email'));
  assert.doesNotThrow(() => zeptoTransacional.garantirUrlValida('http://localhost:3000/email'));

  for (const ruim of ['api.zeptomail.com', '', null, undefined, '//api.zeptomail.com', 'ftp://x.com']) {
    assert.throws(
      () => zeptoTransacional.garantirUrlValida(ruim),
      /ZEPTOMAIL_API_URL invalida/,
      `deveria recusar ${JSON.stringify(ruim)}`,
    );
  }
});

test('a mensagem de erro NOMEIA a variavel e mostra o formato esperado', () => {
  try {
    zeptoTransacional.garantirUrlValida('api.zeptomail.com');
    assert.fail('deveria ter lancado');
  } catch (err) {
    assert.match(err.message, /ZEPTOMAIL_API_URL/, 'precisa nomear a variavel');
    assert.match(err.message, /api\.zeptomail\.com/, 'precisa mostrar o valor recebido');
    assert.match(err.message, /https:\/\/api\.zeptomail\.com\/v1\.1\/email/, 'precisa dar o exemplo');
  }
});

test('transacional: URL invalida LANCA antes de tocar a rede', async () => {
  const t = httpDeTeste();
  const salvo = config.provedores.zeptomail.apiUrl;
  config.provedores.zeptomail.apiUrl = 'api.zeptomail.com';
  try {
    await assert.rejects(
      () => comFetchDublado(t.client, () => zeptoTransacional.enviar('a@b.co', 'S', '<p>x</p>')),
      /ZEPTOMAIL_API_URL invalida/,
    );
  } finally {
    config.provedores.zeptomail.apiUrl = salvo;
  }
  assert.equal(t.chamadas.length, 0, 'nenhuma requisicao pode ter saido');
});

test('campanha: URL invalida LANCA antes de tocar a rede', async () => {
  // Aqui e pior que no transacional: cada tentativa marca o destinatario como 'falha'
  // TERMINAL, sem retentativa e sem poder rematerializar.
  const t = httpDeTeste();
  const salvo = config.provedores.zeptomail.apiUrl;
  config.provedores.zeptomail.apiUrl = 'api.zeptomail.com';
  try {
    await assert.rejects(
      () => zeptoCampanha.enviar('p@exemplo.com', 'S', '<p>x</p>', { httpClient: t.client }),
      /ZEPTOMAIL_API_URL invalida/,
    );
  } finally {
    config.provedores.zeptomail.apiUrl = salvo;
  }
  assert.equal(t.chamadas.length, 0, 'nenhuma requisicao pode ter saido');
});

test('o default do config.js e uma URL COMPLETA (protocolo + caminho)', () => {
  // Sem a variavel de ambiente, o valor precisa funcionar sozinho — e foi justamente a
  // variavel, e nao o default, que quebrou em producao.
  assert.match(
    require('../src/config').config.provedores.zeptomail.apiUrl,
    /^https:\/\/[^/]+\/.+/,
    'o default precisa ter protocolo E caminho',
  );
});

// ══════════════════════════════════════════════════════════════
// 3. As fachadas
// ══════════════════════════════════════════════════════════════

test('fachada transacional: o default CONTINUA resend — subir codigo nao troca provedor', () => {
  // A garantia mais importante desta fachada hoje. Se este teste virar 'zeptomail', o
  // proximo deploy troca o provedor dos sete fluxos transacionais sozinho, sem ninguem ter
  // decidido isso. A troca e ato explicito: EMAIL_TRANSPORTE=zeptomail no Railway.
  const salvo = process.env.EMAIL_TRANSPORTE;
  delete process.env.EMAIL_TRANSPORTE;
  try {
    assert.equal(fachadaTransacional.selecionar(), require('../src/providers/email/resend'));
  } finally {
    if (salvo === undefined) delete process.env.EMAIL_TRANSPORTE;
    else process.env.EMAIL_TRANSPORTE = salvo;
  }
});

test('fachada transacional: EMAIL_TRANSPORTE=zeptomail liga o provedor novo', () => {
  const salvo = process.env.EMAIL_TRANSPORTE;
  process.env.EMAIL_TRANSPORTE = 'zeptomail';
  try {
    assert.equal(fachadaTransacional.selecionar(), zeptoTransacional);
  } finally {
    if (salvo === undefined) delete process.env.EMAIL_TRANSPORTE;
    else process.env.EMAIL_TRANSPORTE = salvo;
  }
});

test('fachada transacional: EMAIL_TRANSPORTE=resend e o rollback explicito', () => {
  // Redundante com o default hoje, e proposital: quando o default virar 'zeptomail' na
  // limpeza futura, este teste continua guardando o caminho de volta.
  const salvo = process.env.EMAIL_TRANSPORTE;
  process.env.EMAIL_TRANSPORTE = 'resend';
  try {
    assert.equal(fachadaTransacional.selecionar(), require('../src/providers/email/resend'));
  } finally {
    if (salvo === undefined) delete process.env.EMAIL_TRANSPORTE;
    else process.env.EMAIL_TRANSPORTE = salvo;
  }
});

test('fachada transacional: valor desconhecido LANCA, nao cai em default', () => {
  const salvo = process.env.EMAIL_TRANSPORTE;
  process.env.EMAIL_TRANSPORTE = 'provedor-inventado';
  try {
    assert.throws(() => fachadaTransacional.selecionar(), /desconhecido: "provedor-inventado"/);
  } finally {
    if (salvo === undefined) delete process.env.EMAIL_TRANSPORTE;
    else process.env.EMAIL_TRANSPORTE = salvo;
  }
});

test('fachada de campanha: zeptomail e selecionavel, mas o default CONTINUA api', () => {
  // A troca em producao e decisao de deploy (variavel), nao efeito de subir codigo.
  const salvo = config.provedores.emailCampanha.transporte;
  try {
    config.provedores.emailCampanha.transporte = 'zeptomail';
    assert.equal(fachadaCampanha.selecionar(), zeptoCampanha);

    config.provedores.emailCampanha.transporte = 'api';
    assert.equal(
      fachadaCampanha.selecionar(),
      require('../src/providers/emailCampanha/emailit_api'),
    );
  } finally {
    config.provedores.emailCampanha.transporte = salvo;
  }
});

test('fachada de campanha: credenciaisFaltando segue o transporte selecionado', () => {
  // Se `enviar` fosse por um implementador e `credenciaisFaltando` por outro, o pre-voo
  // aprovaria um ambiente sem a credencial do transporte que de fato envia.
  const salvo = config.provedores.emailCampanha.transporte;
  const tokenSalvo = config.provedores.zeptomail.token;
  try {
    config.provedores.emailCampanha.transporte = 'zeptomail';
    config.provedores.zeptomail.token = '';
    assert.deepEqual(fachadaCampanha.credenciaisFaltando(), ['ZEPTOMAIL_TOKEN']);
  } finally {
    config.provedores.emailCampanha.transporte = salvo;
    config.provedores.zeptomail.token = tokenSalvo;
  }
});
