'use strict';

// Adaptador de e-mail de CAMPANHA sobre a API do SendGrid
// (src/providers/emailCampanha/sendgrid.js) e a fachada que passou a conhece-lo.
//
// ── POR QUE O SENDGRID ──
// O ZeptoMail confirmou por e-mail que homologa apenas trafego TRANSACIONAL. Ele fica com os
// sete call sites do funil; a campanha migra. E a TERCEIRA troca de provedor deste
// subsistema, e nenhuma das tres foi decisao de arquitetura — Railway bloqueia SMTP, Emailit
// limita a 2 msg/s, ZeptoMail nao aceita marketing.
//
// ── O QUE ESTA EM JOGO ──
// A migracao mexe no ENVELOPE, nao no conteudo. O risco nao e o HTML sair errado: e o
// envelope sair num formato que a API aceita calada e entrega mal, ou perder o
// List-Unsubscribe no caminho — requisito de entregabilidade (Gmail/Yahoo, desde 2024), nao
// cortesia. Por isso os testes validam o TOKEN da URL de descadastro, e nao so a presenca do
// cabecalho: um header presente com token quebrado passa em teste de presenca e falha na mao
// do destinatario.
//
// ── ZERO REDE ──
// Todo teste injeta `opcoes.httpClient`. As excecoes sao os testes que devem LANCAR antes de
// qualquer requisicao (credencial ausente, destinatario vazio) — e provar que eles nao tocam
// a rede e justamente o ponto deles.
//
// ── A NOVIDADE DO DUBLE: `headers` ──
// Os dubles dos adaptadores anteriores devolviam so { ok, status, json, text }. O SendGrid
// responde 202 com CORPO VAZIO e entrega o id no header X-Message-Id, entao aqui o duble
// precisa expor `headers.get()`. Sem isso nao ha como testar extrairId.

const os = require('node:os');
const path = require('node:path');

process.env.DATABASE_PATH = path.join(os.tmpdir(), `vm-test-sendgrid-${process.pid}-${Date.now()}.db`);
process.env.INTERVIEW_MOCK = 'true';
process.env.SESSION_SECRET = 'segredo-de-teste';
process.env.DESCADASTRO_SECRET = 'segredo-de-descadastro-de-teste';
process.env.APP_BASE_URL = 'https://entrevista.exemplo.com.br';
process.env.SENDGRID_API_KEY = 'SG.chave-de-teste.parte-dois';
process.env.SMTP_CAMPANHA_FROM_EMAIL = 'vagas@vagas.exemplo.com.br';
process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert/strict');

const { config } = require('../src/config');
const desc = require('../src/lib/descadastro');
const sendgrid = require('../src/providers/emailCampanha/sendgrid');
const fachada = require('../src/providers/emailCampanha');

// ── HTTP dublê ──
// `headers` imita o objeto Headers do fetch: `get` case-insensitive. O adaptador tenta as
// duas grafias de X-Message-Id justamente porque um duble ingenuo poderia responder so a uma.
function httpDeTeste({ ok = true, status = 202, texto = '', cabecalhos = {} } = {}) {
  const chamadas = [];
  const mapa = new Map(
    Object.entries({ 'x-message-id': 'sg-msg-abc123', ...cabecalhos }).map(([k, v]) => [
      k.toLowerCase(),
      v,
    ]),
  );
  const client = async (url, init) => {
    chamadas.push({ url, init, corpo: JSON.parse(init.body) });
    return {
      ok,
      status,
      headers: { get: (nome) => mapa.get(String(nome).toLowerCase()) ?? null },
      // O 202 real NAO tem corpo. json() lancando aqui e fiel, e um dos testes depende
      // disso para provar que o adaptador nunca o chama depois do sucesso.
      json: async () => {
        throw new Error('Unexpected end of JSON input');
      },
      text: async () => texto,
    };
  };
  return { client, chamadas, ultima: () => chamadas[chamadas.length - 1] };
}

// Roda `fn` com um patch em config.provedores.<bloco>, restaurando sempre.
function comConfig(bloco, patch, fn) {
  const cfg = config.provedores[bloco];
  const original = { ...cfg };
  Object.assign(cfg, patch);
  try {
    return fn();
  } finally {
    Object.assign(cfg, original);
  }
}

// ══════════════════════════════════════════════════════════════
// 1. O envelope — as quatro diferencas em relacao ao ZeptoMail
// ══════════════════════════════════════════════════════════════

test('payload: personalizations, content e from no formato do SendGrid', async () => {
  const t = httpDeTeste();
  await sendgrid.enviar('candidato@exemplo.com', 'Assunto X', '<p>Corpo</p>', {
    httpClient: t.client,
  });

  const { url, init, corpo } = t.ultima();
  assert.equal(url, 'https://api.sendgrid.com/v3/mail/send');
  assert.equal(init.method, 'POST');

  // O destinatario mora DENTRO de personalizations — no ZeptoMail era `to` na raiz.
  assert.deepEqual(corpo.personalizations, [{ to: [{ email: 'candidato@exemplo.com' }] }]);
  assert.equal(corpo.to, undefined, 'nao pode sobrar `to` na raiz, herdado do formato antigo');

  // `content` e ARRAY de blocos MIME — no ZeptoMail era a string `htmlbody`.
  assert.deepEqual(corpo.content, [{ type: 'text/html', value: '<p>Corpo</p>' }]);
  assert.equal(corpo.htmlbody, undefined);

  assert.equal(corpo.subject, 'Assunto X');
  // `from` usa `email`, nao `address`.
  assert.deepEqual(corpo.from, {
    email: 'vagas@vagas.exemplo.com.br',
    name: 'Vendedor Mestre — Vagas',
  });
});

test('payload: lista de UM destinatario, mesmo o SendGrid aceitando 1.000', async () => {
  // O contrato desta funcao e um destinatario por chamada, e a varredura conta e marca linha
  // por linha. Agrupar aqui mudaria o significado de "enviar" para quem chama.
  const t = httpDeTeste();
  await sendgrid.enviar('a@b.co', 'S', '<p>x</p>', { httpClient: t.client });
  assert.equal(t.ultima().corpo.personalizations.length, 1);
  assert.equal(t.ultima().corpo.personalizations[0].to.length, 1);
});

test('payload: reply_to e OBJETO UNICO, nao lista', async () => {
  // A diferenca mais facil de errar copiando do ZeptoMail: mesmo NOME de campo,
  // cardinalidades opostas. No SendGrid a lista chama-se reply_to_list e nao pode coexistir
  // com reply_to.
  const t = httpDeTeste();
  await sendgrid.enviar('a@b.co', 'S', '<p>x</p>', {
    httpClient: t.client,
    replyTo: 'jean@exemplo.com.br',
  });

  const { corpo } = t.ultima();
  assert.deepEqual(corpo.reply_to, { email: 'jean@exemplo.com.br' });
  assert.ok(!Array.isArray(corpo.reply_to), 'array aqui e recusado pelo SendGrid');
  assert.equal(corpo.reply_to_list, undefined, 'os dois campos nao podem coexistir');
});

test('payload: sem replyTo, o campo nao aparece', async () => {
  const t = httpDeTeste();
  await sendgrid.enviar('a@b.co', 'S', '<p>x</p>', { httpClient: t.client });
  assert.equal('reply_to' in t.ultima().corpo, false);
});

// ══════════════════════════════════════════════════════════════
// 2. Opt-out — o que a migracao NAO pode perder
// ══════════════════════════════════════════════════════════════

test('opt-out: List-Unsubscribe vai em `headers`, o nome padrao', async () => {
  // Volta a ser `headers`; `mime_headers` era peculiaridade do ZeptoMail.
  const t = httpDeTeste();
  await sendgrid.enviar('candidato@exemplo.com', 'S', '<p>x</p>', { httpClient: t.client });

  const { corpo } = t.ultima();
  assert.equal(corpo.mime_headers, undefined, 'nome do campo do ZeptoMail nao pode ter vindo junto');
  assert.ok(corpo.headers['List-Unsubscribe']);
  assert.equal(corpo.headers['List-Unsubscribe-Post'], 'List-Unsubscribe=One-Click');
});

test('opt-out: o TOKEN da URL e valido para aquele destinatario', async () => {
  // A assercao que importa. Header presente com token quebrado passa num teste de presenca e
  // falha na mao do destinatario — e o sintoma nao e erro, e queda de entrega semanas depois.
  const t = httpDeTeste();
  await sendgrid.enviar('candidato@exemplo.com', 'S', '<p>x</p>', { httpClient: t.client });

  const bruto = t.ultima().corpo.headers['List-Unsubscribe'];
  assert.match(bruto, /^<https:\/\/entrevista\.exemplo\.com\.br\/descadastro\?/);

  const url = new URL(bruto.slice(1, -1));
  // `e` vai codificado — o handler o decodifica com lerEmailDaUrl. Usamos a MESMA funcao
  // aqui, e nao um decode a mao: se a codificacao mudar, o teste acompanha em vez de mentir.
  assert.equal(desc.lerEmailDaUrl(url.searchParams.get('e')), 'candidato@exemplo.com');
  assert.equal(
    desc.verificarToken('candidato@exemplo.com', url.searchParams.get('t')),
    true,
    'o token precisa validar contra o MESMO HMAC que o handler de descadastro usa',
  );
});

test('opt-out: headers do chamador somam, e a precedencia dele vence', async () => {
  const t = httpDeTeste();
  await sendgrid.enviar('a@b.co', 'S', '<p>x</p>', {
    httpClient: t.client,
    headers: { 'X-Campanha': '42', 'List-Unsubscribe': '<https://outro.exemplo/sair>' },
  });

  const h = t.ultima().corpo.headers;
  assert.equal(h['X-Campanha'], '42');
  assert.equal(h['List-Unsubscribe'], '<https://outro.exemplo/sair>');
});

test('opt-out: semDescadastro remove os cabecalhos automaticos', async () => {
  // Valvula de escape, nao caminho esperado — mas se existe, tem que funcionar igual nos
  // quatro transportes.
  const t = httpDeTeste();
  await sendgrid.enviar('a@b.co', 'S', '<p>x</p>', {
    httpClient: t.client,
    semDescadastro: true,
  });
  assert.equal(t.ultima().corpo.headers, undefined, 'sem headers, o campo nem vai no payload');
});

test('opt-out: sem DESCADASTRO_SECRET o envio LANCA antes de tocar a rede', async () => {
  const t = httpDeTeste();
  const original = config.descadastro.segredo;
  config.descadastro.segredo = '';
  try {
    await assert.rejects(
      () => sendgrid.enviar('a@b.co', 'S', '<p>x</p>', { httpClient: t.client }),
      /DESCADASTRO_SECRET/,
    );
  } finally {
    config.descadastro.segredo = original;
  }
  // Campanha sem opt-out valido nao sai. Nem uma requisicao.
  assert.equal(t.chamadas.length, 0);
});

// ══════════════════════════════════════════════════════════════
// 3. Autenticacao
// ══════════════════════════════════════════════════════════════

test('auth: Bearer, e nao o esquema proprio do ZeptoMail', async () => {
  const t = httpDeTeste();
  await sendgrid.enviar('a@b.co', 'S', '<p>x</p>', { httpClient: t.client });

  const auth = t.ultima().init.headers.Authorization;
  assert.equal(auth, `Bearer ${process.env.SENDGRID_API_KEY}`);
  assert.doesNotMatch(auth, /Zoho-enczapikey/);
});

test('auth: chave com "Bearer " colado nao vira prefixo duplicado', async () => {
  // Terceira variavel do projeto a cair nisto. A doc do SendGrid mostra o header inteiro nos
  // exemplos de curl, entao e o mesmo gesto que colou "Zoho-enczapikey " no ZEPTOMAIL_TOKEN —
  // que custou um HTTP 500 de corpo vazio e uma tarde de diagnostico.
  const t = httpDeTeste();
  await comConfig('sendgrid', { apiKey: 'Bearer SG.chave.colada' }, () =>
    sendgrid.enviar('a@b.co', 'S', '<p>x</p>', { httpClient: t.client }),
  );
  assert.equal(t.ultima().init.headers.Authorization, 'Bearer SG.chave.colada');
});

test('auth: normalizarChave aceita as duas formas e nao mexe no resto', () => {
  assert.equal(sendgrid.normalizarChave('SG.abc.def'), 'SG.abc.def');
  assert.equal(sendgrid.normalizarChave('Bearer SG.abc.def'), 'SG.abc.def');
  assert.equal(sendgrid.normalizarChave('  bearer   SG.abc.def  '), 'SG.abc.def');
  assert.equal(sendgrid.normalizarChave(''), '');
  assert.equal(sendgrid.normalizarChave(null), '');
});

test('auth: a pista de erro mostra tamanhos e o formato, nunca a chave', () => {
  // Vai para o log E para a coluna `erro` de campanha_envios. Se vazasse a credencial,
  // vazaria para o painel.
  const pista = sendgrid.pistaDeAuth('Bearer SG.abc.def');
  assert.doesNotMatch(pista, /SG\.abc\.def/, 'a chave NAO pode aparecer');
  assert.match(pista, /PREFIXO VEIO COLADO/);
  assert.match(pista, /comeca com "SG\.": sim/);

  // O modo silencioso: a "API Key ID" do painel tem cara de credencial e nao comeca com SG.
  assert.match(sendgrid.pistaDeAuth('abc123def456'), /comeca com "SG\.": NAO/);
});

// ══════════════════════════════════════════════════════════════
// 4. A resposta 202 — corpo vazio, id no header
// ══════════════════════════════════════════════════════════════

test('202: o id vem do header X-Message-Id, nao do corpo', async () => {
  const t = httpDeTeste({ status: 202, cabecalhos: { 'X-Message-Id': 'sg-id-do-header' } });
  const r = await sendgrid.enviar('a@b.co', 'S', '<p>x</p>', { httpClient: t.client });
  assert.deepEqual(r, { id: 'sg-id-do-header' });
});

test('202: NADA depois do aceite pode lancar', async () => {
  // O duble faz json() lancar, como o 202 real de corpo vazio faria. Se o adaptador o
  // chamasse, este envio viraria excecao — e, com a retentativa ligada, isso nao marcaria
  // ninguem como falha: faria a MESMA pessoa receber ate 5 vezes, porque erro de parse e
  // desconhecido para classificarErroEnvio e portanto retentavel.
  const t = httpDeTeste({ status: 202 });
  const r = await sendgrid.enviar('a@b.co', 'S', '<p>x</p>', { httpClient: t.client });
  assert.equal(typeof r.id, 'string');
});

test('202: header ausente devolve id nulo, e nao erro', async () => {
  const t = httpDeTeste({ cabecalhos: {} });
  // Sobrescreve o default do duble por um mapa sem o header.
  const client = async (url, init) => {
    t.chamadas.push({ url, init, corpo: JSON.parse(init.body) });
    return { ok: true, status: 202, headers: { get: () => null }, text: async () => '' };
  };
  const r = await sendgrid.enviar('a@b.co', 'S', '<p>x</p>', { httpClient: client });
  assert.deepEqual(r, { id: null }, 'o id serve a rastreio; falta dele nao e falha de envio');
});

test('extrairId nunca lanca, seja qual for a forma da resposta', () => {
  // Roda depois do aceite. Lancar aqui transformaria envio bem-sucedido em retentativa.
  for (const entrada of [null, undefined, {}, { headers: null }, { headers: {} }, 'texto']) {
    assert.doesNotThrow(() => sendgrid.extrairId(entrada));
    assert.equal(sendgrid.extrairId(entrada), null);
  }
});

// ══════════════════════════════════════════════════════════════
// 5. Erros
// ══════════════════════════════════════════════════════════════

test('erro: 4xx propaga status E corpo — o `field` nao pode se perder', async () => {
  // O corpo inteiro vai para a mensagem, e nao so o `message`: e o `field` que separa
  // "endereco ruim daquela pessoa" de "payload nosso quebrado" na classificacao. Extrair so
  // o texto legivel apagaria a distincao antes de ela chegar a quem decide.
  const t = httpDeTeste({
    ok: false,
    status: 400,
    texto: '{"errors":[{"message":"Does not contain a valid address","field":"personalizations.0.to.0.email"}]}',
  });
  await assert.rejects(
    () => sendgrid.enviar('ruim@', 'S', '<p>x</p>', { httpClient: t.client }),
    (err) => {
      assert.match(err.message, /HTTP 400/);
      assert.match(err.message, /"field":"personalizations\.0\.to\.0\.email"/);
      return true;
    },
  );
});

test('erro: a pista de auth acompanha o 4xx', async () => {
  const t = httpDeTeste({ ok: false, status: 401, texto: '{"errors":[{"message":"..."}]}' });
  await assert.rejects(
    () => sendgrid.enviar('a@b.co', 'S', '<p>x</p>', { httpClient: t.client }),
    /auth: chave \d+ chars/,
  );
});

test('erro: falha de transporte e distinta de recusa da API', async () => {
  const client = async () => {
    throw new Error('getaddrinfo ENOTFOUND api.sendgrid.com');
  };
  await assert.rejects(
    () => sendgrid.enviar('a@b.co', 'S', '<p>x</p>', { httpClient: client }),
    /Falha ao enviar e-mail de campanha via API do SendGrid: getaddrinfo/,
  );
});

test('erro: destinatario vazio LANCA sem tocar a rede', async () => {
  const t = httpDeTeste();
  await assert.rejects(
    () => sendgrid.enviar('', 'S', '<p>x</p>', { httpClient: t.client }),
    /Destinatario de e-mail de campanha ausente/,
  );
  assert.equal(t.chamadas.length, 0);
});

test('erro: chave ausente LANCA sem tocar a rede, nomeando a variavel', async () => {
  const t = httpDeTeste();
  await comConfig('sendgrid', { apiKey: '' }, async () => {
    await assert.rejects(
      () => sendgrid.enviar('a@b.co', 'S', '<p>x</p>', { httpClient: t.client }),
      /SENDGRID_API_KEY/,
    );
  });
  assert.equal(t.chamadas.length, 0);
});

// ══════════════════════════════════════════════════════════════
// 6. credenciaisFaltando e a fachada
// ══════════════════════════════════════════════════════════════

test('credenciaisFaltando devolve NOMES de variaveis, nao mensagens', () => {
  assert.deepEqual(sendgrid.credenciaisFaltando(), []);
  comConfig('sendgrid', { apiKey: '' }, () => {
    assert.deepEqual(sendgrid.credenciaisFaltando(), ['SENDGRID_API_KEY']);
  });
  comConfig('emailCampanha', { remetente: '' }, () => {
    assert.deepEqual(sendgrid.credenciaisFaltando(), ['SMTP_CAMPANHA_FROM_EMAIL']);
  });
});

test('a fachada roteia enviar E credenciaisFaltando para o MESMO implementador', () => {
  // O erro mais facil de cometer na fachada, e o mais caro: se `enviar` fosse para o SendGrid
  // e `credenciaisFaltando` continuasse no transporte antigo, o pre-voo aprovaria um ambiente
  // sem SENDGRID_API_KEY e a campanha inteira seria materializada para nunca sair.
  comConfig('emailCampanha', { transporte: 'sendgrid' }, () => {
    assert.equal(fachada.selecionar(), sendgrid);
    comConfig('sendgrid', { apiKey: '' }, () => {
      assert.deepEqual(fachada.credenciaisFaltando(), ['SENDGRID_API_KEY']);
    });
  });
});

test('a fachada continua roteando os outros transportes', () => {
  // A entrada do SendGrid nao pode ter deslocado ninguem, e o default NAO muda neste lote.
  comConfig('emailCampanha', { transporte: 'api' }, () => {
    assert.equal(fachada.selecionar(), require('../src/providers/emailCampanha/emailit_api'));
  });
  comConfig('emailCampanha', { transporte: 'zeptomail' }, () => {
    assert.equal(fachada.selecionar(), require('../src/providers/emailCampanha/zeptomail'));
  });
});

test('a fachada recusa transporte desconhecido nomeando os validos', () => {
  comConfig('emailCampanha', { transporte: 'sendgird' }, () => {
    assert.throws(() => fachada.selecionar(), /sendgrid/);
  });
});

// ══════════════════════════════════════════════════════════════
// 7. Avisos de boot
// ══════════════════════════════════════════════════════════════

test('boot: avisa quando o transporte aponta para sendgrid e a chave falta', () => {
  const { validar } = require('../src/config');
  const antes = { t: process.env.EMAIL_CAMPANHA_TRANSPORTE, k: process.env.SENDGRID_API_KEY };
  process.env.EMAIL_CAMPANHA_TRANSPORTE = 'sendgrid';
  try {
    const avisos = comConfig('sendgrid', { apiKey: '' }, () => validar());
    assert.ok(
      avisos.some((a) => /SENDGRID_API_KEY ausente/.test(a)),
      'o aviso precisa nomear a variavel',
    );
  } finally {
    process.env.EMAIL_CAMPANHA_TRANSPORTE = antes.t;
    process.env.SENDGRID_API_KEY = antes.k;
  }
});

test('boot: avisa sobre "Bearer " colado e sobre chave que nao comeca com SG.', () => {
  const { validar } = require('../src/config');
  const antes = process.env.SENDGRID_API_KEY;
  try {
    process.env.SENDGRID_API_KEY = 'Bearer SG.abc.def';
    assert.ok(validar().some((a) => /prefixo "Bearer " colado/.test(a)));

    // A "API Key ID" do painel: unico modo silencioso de errar a credencial.
    process.env.SENDGRID_API_KEY = 'abc123-id-do-painel';
    assert.ok(validar().some((a) => /nao comeca com "SG\."/.test(a)));

    // E a chave correta nao dispara nenhum dos dois.
    process.env.SENDGRID_API_KEY = 'SG.abc.def';
    const limpos = validar();
    assert.equal(limpos.some((a) => /SENDGRID_API_KEY/.test(a)), false);
  } finally {
    process.env.SENDGRID_API_KEY = antes;
  }
});
