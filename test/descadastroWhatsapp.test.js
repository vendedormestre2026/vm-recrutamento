'use strict';

// Incremento 4: token HMAC (lib/descadastroWhatsapp.js) e a pagina publica de descadastro
// por WhatsApp (GET /descadastro-whatsapp/:token, POST /descadastro-whatsapp).
//
// O teste mais importante deste arquivo e o de que o GET NAO ESCREVE. O WhatsApp pre-carrega
// os links de uma mensagem para montar a previa, e antivirus abrem URLs sozinhos — se o GET
// efetivasse, a base encolheria sozinha e o sintoma seria quase impossivel de rastrear.

const os = require('node:os');
const path = require('node:path');

process.env.DATABASE_PATH = path.join(os.tmpdir(), `vm-test-desc-wa-${process.pid}-${Date.now()}.db`);
process.env.INTERVIEW_MOCK = 'true';
process.env.SESSION_SECRET = 'segredo-de-teste';
process.env.DESCADASTRO_SECRET = 'segredo-do-email-de-teste';
process.env.OPTOUT_TOKEN_SECRET = 'segredo-do-whatsapp-de-teste';
process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert/strict');

const db = require('../src/db');
const { migrar } = require('../src/db/migrate');
const { criarApp } = require('../src/server');
const { config } = require('../src/config');
const optout = require('../src/lib/optoutWhatsapp');
const {
  gerarTokenDescadastroWhatsapp,
  lerTokenDescadastroWhatsapp,
  montarUrlDescadastroWhatsapp,
} = require('../src/lib/descadastroWhatsapp');
const descadastroEmail = require('../src/lib/descadastro');

migrar();

const exec = (sql, ...p) => db.getDb().prepare(sql).run(...p);
const zerar = () => exec('DELETE FROM whatsapp_optout');
const contarOptouts = () => db.getDb().prepare('SELECT COUNT(*) AS n FROM whatsapp_optout').get().n;

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

const postForm = (base, caminho, campos) =>
  fetch(`${base}${caminho}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(campos),
  });

// ══════════════════════════════════════════════════════════════
// Token
// ══════════════════════════════════════════════════════════════

test('token: ida e volta devolve a chave canonica', () => {
  const token = gerarTokenDescadastroWhatsapp('+55 47 99958-2500');
  assert.equal(lerTokenDescadastroWhatsapp(token), '554799582500');
});

test('token: telefone com e sem o 9 gera o MESMO token', () => {
  assert.equal(
    gerarTokenDescadastroWhatsapp('5531996820290'),
    gerarTokenDescadastroWhatsapp('553196820290'),
  );
});

test('token: nao carrega o telefone legivel na URL', () => {
  const url = montarUrlDescadastroWhatsapp('5547999582500', 'https://exemplo.test');
  assert.doesNotMatch(url, /5547999582500/);
  assert.doesNotMatch(url, /99958/);
  assert.match(url, /^https:\/\/exemplo\.test\/descadastro-whatsapp\/[A-Za-z0-9_-]+\.[0-9a-f]+$/);
});

test('token: adulterado e recusado', () => {
  const token = gerarTokenDescadastroWhatsapp('5547999582500');
  const [corpo, hmac] = token.split('.');

  assert.equal(lerTokenDescadastroWhatsapp(`${corpo}.${'0'.repeat(hmac.length)}`), null, 'hmac trocado');
  // Corpo trocado pelo de OUTRO telefone, mantendo o hmac original.
  const outro = gerarTokenDescadastroWhatsapp('5547999582501').split('.')[0];
  assert.equal(lerTokenDescadastroWhatsapp(`${outro}.${hmac}`), null, 'corpo trocado');
});

test('token: lixo de qualquer forma devolve null, sem lancar', () => {
  for (const t of [null, undefined, '', 'abc', 'a.b', '...', 42, {}, 'YWJj.zzz', `${'x'.repeat(500)}.${'a'.repeat(32)}`]) {
    assert.equal(lerTokenDescadastroWhatsapp(t), null, `entrada: ${JSON.stringify(t)}`);
  }
});

test('token: versao desconhecida e recusada, nunca interpretada', () => {
  const corpo = Buffer.from('v9:554799582500', 'utf8').toString('base64url');
  // Mesmo com um hmac de formato valido, a versao errada barra antes de qualquer comparacao.
  assert.equal(lerTokenDescadastroWhatsapp(`${corpo}.${'a'.repeat(32)}`), null);
});

test('token de E-MAIL nao vale como token de WhatsApp', () => {
  // Duas barreiras independentes: chaves diferentes E prefixo de dominio no HMAC.
  const tokenEmail = descadastroEmail.gerarToken('pessoa@exemplo.com');
  const corpo = Buffer.from('v1:554799582500', 'utf8').toString('base64url');
  assert.equal(lerTokenDescadastroWhatsapp(`${corpo}.${tokenEmail}`), null);
});

test('token de WHATSAPP nao vale como token de e-mail', () => {
  // O caminho inverso, que o teste acima nao cobria. verificarToken do e-mail recebe o
  // hmac do WhatsApp e precisa recusar.
  const tokenWa = gerarTokenDescadastroWhatsapp('5547999582500').split('.')[1];
  assert.equal(descadastroEmail.verificarToken('pessoa@exemplo.com', tokenWa), false);
});

test('as duas chaves sao INDEPENDENTES: trocar a do e-mail nao invalida token de WhatsApp', () => {
  const token = gerarTokenDescadastroWhatsapp('5547999582500');
  const antigoEmail = config.descadastro.segredo;
  config.descadastro.segredo = 'outro-segredo-de-email';
  try {
    assert.equal(
      lerTokenDescadastroWhatsapp(token),
      '554799582500',
      'rotacionar o segredo do e-mail nao pode tocar nos links de WhatsApp',
    );
  } finally {
    config.descadastro.segredo = antigoEmail;
  }
});

test('e o inverso: trocar a chave do WhatsApp nao invalida token de e-mail', () => {
  const email = 'pessoa@exemplo.com';
  const tokenEmail = descadastroEmail.gerarToken(email);
  const antigoWa = config.optoutToken.segredo;
  config.optoutToken.segredo = 'outro-segredo-de-whatsapp';
  try {
    assert.equal(descadastroEmail.verificarToken(email, tokenEmail), true);
  } finally {
    config.optoutToken.segredo = antigoWa;
  }
});

test('mesmo com as duas variaveis apontando para o MESMO valor, os esquemas nao se cruzam', () => {
  // Cenario de copia-e-cola: o prefixo de dominio do HMAC e o que sobra como defesa.
  const antigoWa = config.optoutToken.segredo;
  config.optoutToken.segredo = config.descadastro.segredo;
  try {
    const tokenEmail = descadastroEmail.gerarToken('pessoa@exemplo.com');
    const corpo = Buffer.from('v1:554799582500', 'utf8').toString('base64url');
    assert.equal(lerTokenDescadastroWhatsapp(`${corpo}.${tokenEmail}`), null);

    const tokenWa = gerarTokenDescadastroWhatsapp('5547999582500').split('.')[1];
    assert.equal(descadastroEmail.verificarToken('pessoa@exemplo.com', tokenWa), false);
  } finally {
    config.optoutToken.segredo = antigoWa;
  }
});

test('token: rotacao de segredo mantem os links ja enviados validos', () => {
  const antigo = config.optoutToken.segredo;
  const token = gerarTokenDescadastroWhatsapp('5547999582500');

  config.optoutToken.segredoAnterior = antigo;
  config.optoutToken.segredo = 'segredo-novo-de-teste';
  try {
    assert.equal(lerTokenDescadastroWhatsapp(token), '554799582500', 'link antigo continua valendo');
    // E o link NOVO usa a chave nova.
    const novo = gerarTokenDescadastroWhatsapp('5547999582500');
    assert.notEqual(novo, token);
    assert.equal(lerTokenDescadastroWhatsapp(novo), '554799582500');
  } finally {
    config.optoutToken.segredo = antigo;
    config.optoutToken.segredoAnterior = '';
  }
});

test('token: sem segredo, gerar LANCA e ler devolve null — e nada mais quebra', () => {
  const antigo = config.optoutToken.segredo;
  config.optoutToken.segredo = '';
  try {
    assert.throws(() => gerarTokenDescadastroWhatsapp('5547999582500'), /OPTOUT_TOKEN_SECRET/);
    assert.equal(lerTokenDescadastroWhatsapp('YWJj.aaaa'), null);
    // O descadastro por E-MAIL continua funcionando: as chaves sao independentes.
    const email = 'pessoa@exemplo.com';
    assert.equal(descadastroEmail.verificarToken(email, descadastroEmail.gerarToken(email)), true);
  } finally {
    config.optoutToken.segredo = antigo;
  }
});

test('sem segredo: o servidor sobe e as rotas publicas respondem 404, sem 500', async () => {
  const antigo = config.optoutToken.segredo;
  config.optoutToken.segredo = '';
  try {
    await comServidor(async (base) => {
      zerar();
      const res = await fetch(`${base}/descadastro-whatsapp/qualquer.coisa`);
      assert.equal(res.status, 404, 'nunca 500');
      const post = await postForm(base, '/descadastro-whatsapp', { token: 'x.y', escopo: 'campanha' });
      assert.equal(post.status, 404);
      assert.equal(contarOptouts(), 0);
    });
  } finally {
    config.optoutToken.segredo = antigo;
  }
});

test('token: telefone irreconhecivel LANCA na geracao (falha cedo, antes do envio)', () => {
  assert.throws(() => gerarTokenDescadastroWhatsapp('   '), /chave canonica/);
});

// ══════════════════════════════════════════════════════════════
// Pagina publica
// ══════════════════════════════════════════════════════════════

test('GET /descadastro-whatsapp/:token mostra a confirmacao e NAO escreve nada', async () => {
  await comServidor(async (base) => {
    zerar();
    const token = gerarTokenDescadastroWhatsapp('5547999582500');
    const res = await fetch(`${base}/descadastro-whatsapp/${token}`);
    assert.equal(res.status, 200);
    const html = await res.text();

    assert.match(html, /Deseja parar de receber/);
    assert.match(html, /Parar de receber vagas/, 'CTA principal, escopo campanha');
    assert.match(html, /Bloquear tudo/, 'opcao de bloqueio total, secundaria');
    assert.match(html, /continua recebendo/, 'explica que a candidatura futura segue atendida');

    assert.equal(contarOptouts(), 0, 'o GET nao pode efetivar NADA');
  });
});

test('GET: o telefone nao aparece na pagina', async () => {
  await comServidor(async (base) => {
    zerar();
    const token = gerarTokenDescadastroWhatsapp('5547999582500');
    const html = await (await fetch(`${base}/descadastro-whatsapp/${token}`)).text();
    assert.doesNotMatch(html, /5547999582500/);
  });
});

test('GET com token adulterado: 404 generico, sem revelar nada', async () => {
  await comServidor(async (base) => {
    zerar();
    const token = gerarTokenDescadastroWhatsapp('5547999582500');
    const [corpo] = token.split('.');
    const res = await fetch(`${base}/descadastro-whatsapp/${corpo}.${'0'.repeat(32)}`);
    assert.equal(res.status, 404);
    const html = await res.text();
    assert.match(html, /Link inválido/);
    assert.equal(contarOptouts(), 0);
  });
});

test('POST efetiva com escopo campanha (o CTA principal)', async () => {
  await comServidor(async (base) => {
    zerar();
    const token = gerarTokenDescadastroWhatsapp('5547999582500');
    const res = await postForm(base, '/descadastro-whatsapp', { token, escopo: 'campanha' });
    assert.equal(res.status, 200);
    assert.match(await res.text(), /registramos seu pedido/);

    assert.equal(optout.estaOptout('5547999582500', 'campanha'), true);
    assert.equal(optout.estaOptout('5547999582500', 'transacional'), false);
    assert.equal(db.obterWhatsappOptout('5547999582500').origem, 'link');
  });
});

test('POST com escopo total bloqueia tudo, e a tela diz isso', async () => {
  await comServidor(async (base) => {
    zerar();
    const token = gerarTokenDescadastroWhatsapp('5511988887777');
    const html = await (await postForm(base, '/descadastro-whatsapp', { token, escopo: 'total' })).text();
    assert.match(html, /nenhuma mensagem nossa/);
    assert.equal(optout.estaOptout('5511988887777', 'transacional'), true);
  });
});

test('POST duplicado e idempotente: mesma tela, uma linha so, data original preservada', async () => {
  await comServidor(async (base) => {
    zerar();
    const token = gerarTokenDescadastroWhatsapp('5547999582500');
    await postForm(base, '/descadastro-whatsapp', { token, escopo: 'campanha' });
    exec("UPDATE whatsapp_optout SET criado_em = '2026-01-01 10:00:00'");

    const res = await postForm(base, '/descadastro-whatsapp', { token, escopo: 'campanha' });
    assert.equal(res.status, 200);
    assert.match(await res.text(), /registramos seu pedido/);

    assert.equal(contarOptouts(), 1);
    assert.equal(db.obterWhatsappOptout('5547999582500').criado_em, '2026-01-01 10:00:00');
  });
});

test('POST: telefone com e sem o 9 resolvem para o MESMO registro', async () => {
  await comServidor(async (base) => {
    zerar();
    await postForm(base, '/descadastro-whatsapp', {
      token: gerarTokenDescadastroWhatsapp('5531996820290'),
      escopo: 'campanha',
    });
    await postForm(base, '/descadastro-whatsapp', {
      token: gerarTokenDescadastroWhatsapp('553196820290'),
      escopo: 'campanha',
    });
    assert.equal(contarOptouts(), 1);
  });
});

test('POST com token adulterado: 404 e nada gravado', async () => {
  await comServidor(async (base) => {
    zerar();
    const res = await postForm(base, '/descadastro-whatsapp', { token: 'lixo.deadbeef', escopo: 'campanha' });
    assert.equal(res.status, 404);
    assert.equal(contarOptouts(), 0);
  });
});

test('POST com escopo forjado cai no padrao campanha, em vez de recusar o pedido', async () => {
  await comServidor(async (base) => {
    zerar();
    const token = gerarTokenDescadastroWhatsapp('5547999582502');
    const res = await postForm(base, '/descadastro-whatsapp', { token, escopo: 'apagar-tudo' });
    assert.equal(res.status, 200);
    assert.equal(db.obterWhatsappOptout('5547999582502').escopo, 'campanha');
  });
});

test('desfazer na mesma sessao revoga pelo mesmo token', async () => {
  await comServidor(async (base) => {
    zerar();
    const token = gerarTokenDescadastroWhatsapp('5547999582503');
    await postForm(base, '/descadastro-whatsapp', { token, escopo: 'campanha' });
    assert.equal(optout.estaOptout('5547999582503', 'campanha'), true);

    const res = await postForm(base, '/descadastro-whatsapp/desfazer', { token });
    assert.equal(res.status, 200);
    assert.match(await res.text(), /Desfeito/);
    assert.equal(optout.estaOptout('5547999582503', 'campanha'), false);
  });
});

test('desfazer com token invalido: 404, sem tocar em nada', async () => {
  await comServidor(async (base) => {
    zerar();
    optout.registrarOptout({ telefone: '5547999582504', origem: 'link' });
    const res = await postForm(base, '/descadastro-whatsapp/desfazer', { token: 'x.y' });
    assert.equal(res.status, 404);
    assert.equal(optout.estaOptout('5547999582504', 'campanha'), true);
  });
});

test('as paginas nao carregam rastreio (GTM/Pixel)', async () => {
  await comServidor(async (base) => {
    zerar();
    const token = gerarTokenDescadastroWhatsapp('5547999582500');
    const html = await (await fetch(`${base}/descadastro-whatsapp/${token}`)).text();
    assert.doesNotMatch(html, /googletagmanager|fbevents/);
  });
});

test('o fluxo de descadastro por E-MAIL continua intacto', async () => {
  await comServidor(async (base) => {
    // A rota de WhatsApp mora em /descadastro-whatsapp/:token; a de e-mail em
    // /descadastro?e=..&t=.. — sao IRMAS, e nenhuma alcanca a outra.
    const email = 'pessoa@exemplo.com';
    const t = descadastroEmail.gerarToken(email);
    const e = Buffer.from(email, 'utf8').toString('base64url');
    const res = await fetch(`${base}/descadastro?e=${e}&t=${t}`);
    assert.equal(res.status, 200);
    assert.match(await res.text(), /Deseja parar de receber nossas vagas/);
  });
});
