'use strict';

// Adaptador de e-mail de CAMPANHA (src/providers/emailCampanha/smtp.js) e o caminho
// One-Click do descadastro (RFC 8058) em POST /descadastro.
//
// ZERO REDE. O transporte usado e o `jsonTransport` do proprio nodemailer: ele monta a
// mensagem inteira (envelope, cabecalhos, corpo) e devolve como JSON, sem abrir socket.
// Nenhuma dependencia de mock e necessaria — e por isso que o adaptador aceita um
// transporter injetado. Nenhum teste aqui chama enviar() sem injetar, EXCETO os dois que
// devem lancar antes de qualquer conexao (credencial ausente e destinatario vazio).
//
// O QUE ESTA EM JOGO: os cabecalhos List-Unsubscribe nao sao cortesia — Gmail e Yahoo
// exigem deles de remetentes em volume desde 2024. Um cabecalho ausente ou com URL
// invalida degrada a entrega da campanha inteira, e o sintoma (queda de entrega) aparece
// tarde e longe da causa. Por isso o teste do cabecalho valida o TOKEN da URL, e nao so
// a presenca do header.

const os = require('node:os');
const path = require('node:path');

process.env.DATABASE_PATH = path.join(os.tmpdir(), `vm-test-email-campanha-${process.pid}-${Date.now()}.db`);
process.env.INTERVIEW_MOCK = 'true';
process.env.SESSION_SECRET = 'segredo-de-teste';
process.env.DESCADASTRO_SECRET = 'segredo-de-descadastro-de-teste';
process.env.APP_BASE_URL = 'https://entrevista.exemplo.com.br';
// Credenciais de campanha presentes por padrao: os testes que exercitam a FALTA delas
// esvaziam a config em runtime, no escopo deles.
process.env.SMTP_CAMPANHA_HOST = 'smtp.exemplo-provedor.com';
process.env.SMTP_CAMPANHA_PORTA = '587';
process.env.SMTP_CAMPANHA_USUARIO = 'usuario-de-teste';
process.env.SMTP_CAMPANHA_SENHA = 'senha-de-teste';
process.env.SMTP_CAMPANHA_FROM_EMAIL = 'vagas@vagas.exemplo.com.br';
process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert/strict');
const nodemailer = require('nodemailer');

const db = require('../src/db');
const { migrar } = require('../src/db/migrate');
const { config } = require('../src/config');
const { criarApp } = require('../src/server');
const desc = require('../src/lib/descadastro');
const campanha = require('../src/providers/emailCampanha/smtp');

migrar();

// ── Transporte de teste ──
// Envolve o jsonTransport do nodemailer para CAPTURAR a mensagem montada. Quem monta
// continua sendo o nodemailer (nada e simulado aqui); o wrapper so guarda o resultado
// para as assercoes, ja que enviar() devolve apenas { id }.
function transporteDeTeste() {
  const real = nodemailer.createTransport({ jsonTransport: true });
  const enviadas = [];
  const transporter = {
    async sendMail(mensagem) {
      const info = await real.sendMail(mensagem);
      enviadas.push(JSON.parse(info.message));
      return info;
    },
  };
  return { transporter, enviadas, ultima: () => enviadas[enviadas.length - 1] };
}

// Roda `fn` com um recorte de config.provedores.emailCampanha trocado, restaurando no
// fim aconteca o que acontecer.
function comConfigCampanha(patch, fn) {
  const cfg = config.provedores.emailCampanha;
  const original = { ...cfg };
  Object.assign(cfg, patch);
  try {
    return fn();
  } finally {
    Object.assign(cfg, original);
  }
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

// ── 1. Montagem basica da mensagem ──

test('enviar(): destinatario, assunto e html chegam montados no transporte', async () => {
  const t = transporteDeTeste();
  const r = await campanha.enviar(
    'pessoa@exemplo.com',
    'Vaga aberta: Closer de Vendas',
    '<p>Temos uma vaga para voce.</p>',
    { transporter: t.transporter },
  );

  const m = t.ultima();
  assert.equal(m.to[0].address, 'pessoa@exemplo.com');
  assert.equal(m.subject, 'Vaga aberta: Closer de Vendas');
  assert.equal(m.html, '<p>Temos uma vaga para voce.</p>');
  // O contrato devolve o messageId do nodemailer.
  assert.ok(r.id, 'enviar() precisa devolver o id da mensagem');
  assert.equal(r.id, m.messageId);
});

// ── 2. Remetente ──

test('enviar(): remetente sai de config.provedores.emailCampanha.remetente', async () => {
  const t = transporteDeTeste();
  await campanha.enviar('pessoa@exemplo.com', 'Assunto', '<p>oi</p>', {
    transporter: t.transporter,
  });
  assert.equal(t.ultima().from.address, 'vagas@vagas.exemplo.com.br');
  assert.equal(t.ultima().from.address, config.provedores.emailCampanha.remetente);
});

test('enviar(): o remetente de campanha NAO e o transacional (reputacoes separadas)', async () => {
  const t = transporteDeTeste();
  await campanha.enviar('pessoa@exemplo.com', 'Assunto', '<p>oi</p>', {
    transporter: t.transporter,
  });
  assert.notEqual(t.ultima().from.address, config.provedores.email.remetente);
});

// ── 3. replyTo ──

test('enviar(): opcoes.replyTo aparece na mensagem quando passado', async () => {
  const t = transporteDeTeste();
  await campanha.enviar('pessoa@exemplo.com', 'Assunto', '<p>oi</p>', {
    transporter: t.transporter,
    replyTo: 'recrutamento@exemplo.com.br',
  });
  assert.equal(t.ultima().replyTo[0].address, 'recrutamento@exemplo.com.br');
});

test('enviar(): sem replyTo, o campo nem entra na mensagem', async () => {
  const t = transporteDeTeste();
  await campanha.enviar('pessoa@exemplo.com', 'Assunto', '<p>oi</p>', {
    transporter: t.transporter,
  });
  assert.equal(t.ultima().replyTo, undefined);
});

// ── 4. Cabecalhos List-Unsubscribe (RFC 8058) ──

test('cabecalhosDescadastro(): os dois headers, com URL de token VALIDO', async () => {
  const email = 'assinante@exemplo.com';
  const t = transporteDeTeste();

  await campanha.enviar(email, 'Assunto', '<p>oi</p>', {
    transporter: t.transporter,
    headers: campanha.cabecalhosDescadastro(email),
  });

  const headers = t.ultima().headers;
  assert.equal(headers['List-Unsubscribe-Post'], 'List-Unsubscribe=One-Click');

  // O List-Unsubscribe precisa vir entre < >, conforme a RFC.
  const bruto = headers['List-Unsubscribe'];
  assert.match(bruto, /^<https?:\/\/.+>$/, `formato inesperado: ${bruto}`);

  // A prova que importa: o link nao so existe, ele VALIDA. Um header presente com token
  // quebrado passaria num teste de presenca e falharia na mao do destinatario.
  const url = new URL(bruto.slice(1, -1));
  assert.equal(url.origin + url.pathname, `${config.baseUrl}/descadastro`);
  const e = url.searchParams.get('e');
  const tok = url.searchParams.get('t');
  assert.equal(desc.lerEmailDaUrl(e), email);
  assert.equal(desc.verificarToken(email, tok), true, 'o token do cabecalho tem que validar');
});

test('cabecalhosDescadastro(): e-mails diferentes geram links diferentes', () => {
  const a = campanha.cabecalhosDescadastro('a@exemplo.com')['List-Unsubscribe'];
  const b = campanha.cabecalhosDescadastro('b@exemplo.com')['List-Unsubscribe'];
  assert.notEqual(a, b);
});

// ── 4b. List-Unsubscribe POR PADRAO (sem o chamador pedir) ──
//
// A assercao mais importante deste arquivo. Enquanto o header dependia de quem chama
// lembrar de passa-lo, um esquecimento produzia campanha entregue sem opt-out — falha
// que nao aparece como erro, e sim como queda de entrega semanas depois.

test('enviar() SEM headers ainda inclui os dois List-Unsubscribe, validos', async () => {
  const email = 'sem-pedir@exemplo.com';
  const t = transporteDeTeste();

  await campanha.enviar(email, 'Assunto', '<p>oi</p>', { transporter: t.transporter });

  const headers = t.ultima().headers;
  assert.ok(headers, 'a mensagem precisa ter headers mesmo sem o chamador pedir');
  assert.equal(headers['List-Unsubscribe-Post'], 'List-Unsubscribe=One-Click');

  const url = new URL(headers['List-Unsubscribe'].slice(1, -1));
  assert.equal(desc.lerEmailDaUrl(url.searchParams.get('e')), email);
  assert.equal(desc.verificarToken(email, url.searchParams.get('t')), true);
});

test('enviar(): o link automatico e do DESTINATARIO daquele envio, nao de outro', async () => {
  const t = transporteDeTeste();
  await campanha.enviar('primeiro@exemplo.com', 'A', '<p>a</p>', { transporter: t.transporter });
  await campanha.enviar('segundo@exemplo.com', 'B', '<p>b</p>', { transporter: t.transporter });

  const [m1, m2] = t.enviadas;
  const alvo = (m) => desc.lerEmailDaUrl(new URL(m.headers['List-Unsubscribe'].slice(1, -1)).searchParams.get('e'));
  assert.equal(alvo(m1), 'primeiro@exemplo.com');
  assert.equal(alvo(m2), 'segundo@exemplo.com');
});

test('opcoes.semDescadastro: true omite os cabecalhos de descadastro', async () => {
  const t = transporteDeTeste();
  await campanha.enviar('sem-optout@exemplo.com', 'Assunto', '<p>oi</p>', {
    transporter: t.transporter,
    semDescadastro: true,
  });

  const headers = t.ultima().headers;
  // Nota: o jsonTransport normaliza `headers` para {} mesmo quando o campo nao e
  // passado (diferente de replyTo, que fica undefined). Entao o que se afirma aqui e a
  // ausencia das CHAVES, nao a ausencia do objeto.
  assert.deepEqual(headers, {}, 'nenhum header deveria ter sido montado');
  assert.equal(headers['List-Unsubscribe'], undefined);
  assert.equal(headers['List-Unsubscribe-Post'], undefined);
});

test('opcoes.semDescadastro: so vale com true literal (valor "verdadeiro" nao basta)', async () => {
  const t = transporteDeTeste();
  // Omitir opt-out e decisao seria demais para depender de coercao: 1, 'sim' ou {} nao
  // podem desligar o cabecalho por acidente.
  for (const quaseVerdadeiro of [1, 'true', {}, 'sim']) {
    await campanha.enviar('coercao@exemplo.com', 'Assunto', '<p>oi</p>', {
      transporter: t.transporter,
      semDescadastro: quaseVerdadeiro,
    });
    assert.ok(
      t.ultima().headers['List-Unsubscribe'],
      `semDescadastro=${JSON.stringify(quaseVerdadeiro)} nao pode omitir o cabecalho`,
    );
  }
});

test('opcoes.headers: header extra do chamador convive com o descadastro automatico', async () => {
  const email = 'merge@exemplo.com';
  const t = transporteDeTeste();

  await campanha.enviar(email, 'Assunto', '<p>oi</p>', {
    transporter: t.transporter,
    headers: { 'X-Campanha-Id': '42' },
  });

  const headers = t.ultima().headers;
  assert.equal(headers['X-Campanha-Id'], '42', 'o header do chamador nao pode sumir');
  assert.equal(headers['List-Unsubscribe-Post'], 'List-Unsubscribe=One-Click');
  const url = new URL(headers['List-Unsubscribe'].slice(1, -1));
  assert.equal(desc.verificarToken(email, url.searchParams.get('t')), true);
});

test('opcoes.headers: List-Unsubscribe do chamador PREVALECE sobre o automatico', async () => {
  const t = transporteDeTeste();
  const proprio = '<https://outro.exemplo.com/sair?x=1>';

  await campanha.enviar('manual@exemplo.com', 'Assunto', '<p>oi</p>', {
    transporter: t.transporter,
    headers: { 'List-Unsubscribe': proprio },
  });

  // Quem passou o header fez de proposito; o adaptador nao sobrescreve.
  assert.equal(t.ultima().headers['List-Unsubscribe'], proprio);
});

// ── 5 e 6. Erros ──

test('enviar(): lanca claro quando faltam credenciais de SMTP', async () => {
  // Sem transporter injetado E sem credencial: tem que falhar ANTES de qualquer conexao.
  await comConfigCampanha({ host: '', usuario: '', senha: '' }, async () => {
    await assert.rejects(
      () => campanha.enviar('pessoa@exemplo.com', 'Assunto', '<p>oi</p>'),
      (err) => {
        assert.match(err.message, /SMTP_CAMPANHA_HOST/);
        assert.match(err.message, /SMTP_CAMPANHA_USUARIO/);
        assert.match(err.message, /SMTP_CAMPANHA_SENHA/);
        return true;
      },
    );
  });
});

test('enviar(): lanca claro quando o destinatario esta vazio', async () => {
  const t = transporteDeTeste();
  for (const vazio of ['', null, undefined]) {
    await assert.rejects(
      () => campanha.enviar(vazio, 'Assunto', '<p>oi</p>', { transporter: t.transporter }),
      /[Dd]estinatario/,
    );
  }
  assert.equal(t.enviadas.length, 0, 'nada pode ter sido montado');
});

test('enviar(): lanca claro quando o remetente de campanha esta ausente', async () => {
  const t = transporteDeTeste();
  await comConfigCampanha({ remetente: '' }, async () => {
    await assert.rejects(
      () => campanha.enviar('pessoa@exemplo.com', 'Assunto', '<p>oi</p>', {
        transporter: t.transporter,
      }),
      /SMTP_CAMPANHA_FROM_EMAIL/,
    );
  });
});

test('enviar(): sem DESCADASTRO_SECRET lanca, mesmo sem o chamador pedir descadastro', async () => {
  // CASO NOVO E DISTINTO do teste de credenciais SMTP acima: aqui as credenciais SMTP
  // estao PRESENTES (o transporter ate foi injetado) e o que falta e o segredo do
  // descadastro. Antes deste ajuste, este envio passaria — sem cabecalho de opt-out.
  // Agora ele e barrado, porque o cabecalho deixou de ser opcional.
  const t = transporteDeTeste();
  const original = config.descadastro.segredo;
  config.descadastro.segredo = '';
  try {
    await assert.rejects(
      () => campanha.enviar('qualquer@exemplo.com', 'Assunto', '<p>oi</p>', {
        transporter: t.transporter,
      }),
      /DESCADASTRO_SECRET/,
    );
    assert.equal(t.enviadas.length, 0, 'nada pode ter sido enviado');

    // A valvula de escape continua funcionando sem o segredo — e o unico caminho de
    // envio possivel nesse estado, e exige pedido explicito.
    await campanha.enviar('qualquer@exemplo.com', 'Assunto', '<p>oi</p>', {
      transporter: t.transporter,
      semDescadastro: true,
    });
    assert.equal(t.enviadas.length, 1);
  } finally {
    config.descadastro.segredo = original;
  }
});

test('enviar(): erro do transporte vira excecao com a mensagem do provedor', async () => {
  const quebrado = {
    async sendMail() {
      throw new Error('550 5.7.1 rejeitado pelo provedor');
    },
  };
  await assert.rejects(
    () => campanha.enviar('pessoa@exemplo.com', 'Assunto', '<p>oi</p>', { transporter: quebrado }),
    /550 5\.7\.1 rejeitado pelo provedor/,
  );
});

// ── 7. One-Click no POST /descadastro (mudanca em routes/pages.js) ──

test('One-Click: POST /descadastro com e/t na QUERY e sem corpo descadastra', async () => {
  const email = 'oneclick@exemplo.com';
  const url = new URL(desc.montarUrlDescadastro(email, 'http://placeholder'));
  assert.equal(db.estaDescadastrado(email), false);

  await comServidor(async (base) => {
    // Exatamente o que um cliente de e-mail faz no One-Click: POST na URL do
    // List-Unsubscribe, sem corpo e sem Content-Type de formulario.
    const res = await fetch(`${base}/descadastro${url.search}`, { method: 'POST' });
    assert.equal(res.status, 200, 'o One-Click precisa responder 2xx');
  });

  assert.equal(db.estaDescadastrado(email), true);
});

test('One-Click: token invalido na query nao descadastra', async () => {
  const email = 'oneclick-ruim@exemplo.com';
  const e = Buffer.from(email, 'utf8').toString('base64url');
  await comServidor(async (base) => {
    const res = await fetch(`${base}/descadastro?e=${e}&t=forjado`, { method: 'POST' });
    assert.equal(res.status, 400);
  });
  assert.equal(db.estaDescadastrado(email), false);
});

test('One-Click: a URL do cabecalho List-Unsubscribe funciona de ponta a ponta', async () => {
  // Fecha o circuito: pega a URL do header que o adaptador monta e faz o POST nela,
  // como o Gmail faria. Se o formato do link e o handler divergirem, e aqui que aparece.
  const email = 'ponta-a-ponta@exemplo.com';
  const bruto = campanha.cabecalhosDescadastro(email)['List-Unsubscribe'];
  const url = new URL(bruto.slice(1, -1));

  await comServidor(async (base) => {
    const res = await fetch(`${base}/descadastro${url.search}`, { method: 'POST' });
    assert.equal(res.status, 200);
  });

  assert.equal(db.estaDescadastrado(email), true);
});

test('fluxo humano preservado: POST com e/t no CORPO continua funcionando', async () => {
  // A mudanca da Tarefa 3 e ADITIVA — o caminho do formulario nao pode ter regredido.
  const email = 'humano@exemplo.com';
  const qs = new URL(desc.montarUrlDescadastro(email, 'http://x')).searchParams;

  await comServidor(async (base) => {
    const res = await fetch(`${base}/descadastro`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ e: qs.get('e'), t: qs.get('t') }),
    });
    assert.equal(res.status, 200);
  });

  assert.equal(db.estaDescadastrado(email), true);
});

test('precedencia: query ganha do corpo quando os dois chegam', async () => {
  const daQuery = 'da-query@exemplo.com';
  const doCorpo = 'do-corpo@exemplo.com';
  const q = new URL(desc.montarUrlDescadastro(daQuery, 'http://x')).searchParams;
  const b = new URL(desc.montarUrlDescadastro(doCorpo, 'http://x')).searchParams;

  await comServidor(async (base) => {
    const res = await fetch(`${base}/descadastro?e=${q.get('e')}&t=${q.get('t')}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ e: b.get('e'), t: b.get('t') }),
    });
    assert.equal(res.status, 200);
  });

  assert.equal(db.estaDescadastrado(daQuery), true, 'a query e que deve valer');
  assert.equal(db.estaDescadastrado(doCorpo), false, 'o corpo nao pode ter sido usado');
});
