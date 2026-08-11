'use strict';

// Adaptador de e-mail de CAMPANHA sobre a API REST do Emailit
// (src/providers/emailCampanha/emailit_api.js) e a fachada que escolhe o transporte
// (src/providers/emailCampanha/index.js).
//
// ── POR QUE ESTE ARQUIVO EXISTE AO LADO DE emailCampanha.test.js ──
// Aquele continua valendo: testa src/providers/emailCampanha/smtp.js, que continua no
// repositorio e volta a ser o default se o Railway liberar egress SMTP. Este cobre o
// transporte que roda HOJE em producao. Sao dois implementadores do MESMO contrato, e cada
// um precisa do seu teste — um contrato so vale se as duas pontas forem verificadas.
//
// ── ZERO REDE ──
// O `fetch` nunca e chamado: todo teste injeta `opcoes.httpClient`, o ponto de injecao que
// substituiu o `opcoes.transporter` do nodemailer. A unica excecao sao os testes que devem
// LANCAR antes de qualquer requisicao (credencial ausente, destinatario vazio) — e provar
// que eles nao tocam a rede e justamente o ponto deles.
//
// ── O QUE ESTA EM JOGO ──
// O mesmo do adaptador SMTP: os cabecalhos List-Unsubscribe nao sao cortesia, sao requisito
// de entregabilidade (Gmail/Yahoo, desde 2024). Trocar o transporte NAO pode ter perdido o
// opt-out pelo caminho — por isso o teste valida o TOKEN da URL, e nao so a presenca do
// header. Um cabecalho presente com token quebrado passaria num teste de presenca e
// falharia na mao do destinatario.

const os = require('node:os');
const path = require('node:path');

process.env.DATABASE_PATH = path.join(os.tmpdir(), `vm-test-email-campanha-api-${process.pid}-${Date.now()}.db`);
process.env.INTERVIEW_MOCK = 'true';
process.env.SESSION_SECRET = 'segredo-de-teste';
process.env.DESCADASTRO_SECRET = 'segredo-de-descadastro-de-teste';
process.env.APP_BASE_URL = 'https://entrevista.exemplo.com.br';
process.env.EMAILIT_API_KEY = 'em_chave-de-teste';
process.env.SMTP_CAMPANHA_FROM_EMAIL = 'vagas@vagas.exemplo.com.br';
// Credenciais de SMTP tambem presentes: um dos testes troca o transporte para 'smtp' e
// precisa que o outro implementador esteja utilizavel.
process.env.SMTP_CAMPANHA_HOST = 'smtp.exemplo-provedor.com';
process.env.SMTP_CAMPANHA_USUARIO = 'usuario-de-teste';
process.env.SMTP_CAMPANHA_SENHA = 'senha-de-teste';
process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert/strict');

const { config } = require('../src/config');
const desc = require('../src/lib/descadastro');
const api = require('../src/providers/emailCampanha/emailit_api');
const fachada = require('../src/providers/emailCampanha');
const smtp = require('../src/providers/emailCampanha/smtp');

// ── HTTP client dublê ──
// Captura url + init de cada chamada e devolve uma resposta compativel com fetch. `resposta`
// permite simular 4xx/5xx sem mudar o resto do arranjo.
function httpDeTeste(resposta = {}) {
  const chamadas = [];
  const client = async (url, init) => {
    chamadas.push({ url, init, corpo: JSON.parse(init.body) });
    return {
      ok: resposta.ok !== undefined ? resposta.ok : true,
      status: resposta.status || 200,
      async json() {
        if (resposta.jsonLanca) throw new Error('corpo nao e JSON');
        return resposta.json !== undefined
          ? resposta.json
          : { id: 'em_abc123', message_id: '<abc123@vagas.exemplo.com.br>', status: 'pending' };
      },
      async text() {
        return resposta.text !== undefined ? resposta.text : '';
      },
    };
  };
  return { client, chamadas, ultima: () => chamadas[chamadas.length - 1] };
}

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

// ══════════════════════════════════════════════════════════════
// 1. A requisicao HTTP montada
// ══════════════════════════════════════════════════════════════

test('enviar(): POST no endpoint certo, com Bearer e Content-Type JSON', async () => {
  const h = httpDeTeste();
  await api.enviar('pessoa@exemplo.com', 'Assunto', '<p>oi</p>', { httpClient: h.client });

  const { url, init } = h.ultima();
  assert.equal(url, 'https://api.emailit.com/v2/emails');
  assert.equal(init.method, 'POST');
  assert.equal(init.headers.Authorization, 'Bearer em_chave-de-teste');
  assert.equal(init.headers['Content-Type'], 'application/json');
});

test('enviar(): o corpo leva from/to/subject/html nos nomes do provedor', async () => {
  const h = httpDeTeste();
  await api.enviar('pessoa@exemplo.com', 'Vaga aberta: Closer', '<p>Temos uma vaga.</p>', {
    httpClient: h.client,
  });

  const c = h.ultima().corpo;
  assert.equal(c.from, 'vagas@vagas.exemplo.com.br');
  assert.equal(c.to, 'pessoa@exemplo.com');
  assert.equal(c.subject, 'Vaga aberta: Closer');
  assert.equal(c.html, '<p>Temos uma vaga.</p>');
});

test('enviar(): remetente sai da config, e NAO e o transacional', async () => {
  const h = httpDeTeste();
  await api.enviar('pessoa@exemplo.com', 'A', '<p>a</p>', { httpClient: h.client });
  assert.equal(h.ultima().corpo.from, config.provedores.emailCampanha.remetente);
  assert.notEqual(h.ultima().corpo.from, config.provedores.email.remetente);
});

test('enviar(): devolve { id } — o message_id, equivalente ao que o SMTP devolvia', async () => {
  const h = httpDeTeste();
  const r = await api.enviar('pessoa@exemplo.com', 'A', '<p>a</p>', { httpClient: h.client });
  assert.equal(r.id, '<abc123@vagas.exemplo.com.br>');
});

test('enviar(): sem message_id na resposta, cai para o id interno do provedor', async () => {
  const h = httpDeTeste({ json: { id: 'em_somente' } });
  const r = await api.enviar('pessoa@exemplo.com', 'A', '<p>a</p>', { httpClient: h.client });
  assert.equal(r.id, 'em_somente');
});

test('enviar(): resposta 2xx ilegivel NAO vira erro (o e-mail ja foi aceito)', async () => {
  // Transformar isto em excecao faria a varredura marcar como 'falha' TERMINAL alguem que
  // de fato vai receber — e o UNIQUE impede reenviar. Degradar o id e o mal menor.
  const h = httpDeTeste({ jsonLanca: true });
  const r = await api.enviar('pessoa@exemplo.com', 'A', '<p>a</p>', { httpClient: h.client });
  assert.equal(r.id, null);
});

// ── replyTo ──

test('enviar(): opcoes.replyTo vira reply_to no corpo', async () => {
  const h = httpDeTeste();
  await api.enviar('pessoa@exemplo.com', 'A', '<p>a</p>', {
    httpClient: h.client,
    replyTo: 'recrutamento@exemplo.com.br',
  });
  assert.equal(h.ultima().corpo.reply_to, 'recrutamento@exemplo.com.br');
});

test('enviar(): sem replyTo, o campo nem entra no corpo', async () => {
  const h = httpDeTeste();
  await api.enviar('pessoa@exemplo.com', 'A', '<p>a</p>', { httpClient: h.client });
  assert.equal('reply_to' in h.ultima().corpo, false);
});

// ══════════════════════════════════════════════════════════════
// 2. List-Unsubscribe automatico (a garantia do Incremento 3, no novo transporte)
// ══════════════════════════════════════════════════════════════

test('enviar() SEM headers ainda inclui os dois List-Unsubscribe, VALIDOS', async () => {
  const email = 'sem-pedir@exemplo.com';
  const h = httpDeTeste();

  await api.enviar(email, 'Assunto', '<p>oi</p>', { httpClient: h.client });

  const headers = h.ultima().corpo.headers;
  assert.ok(headers, 'o corpo precisa ter headers mesmo sem o chamador pedir');
  assert.equal(headers['List-Unsubscribe-Post'], 'List-Unsubscribe=One-Click');

  const bruto = headers['List-Unsubscribe'];
  assert.match(bruto, /^<https?:\/\/.+>$/, `formato inesperado: ${bruto}`);

  // A prova que importa: o link nao so existe, ele VALIDA — com o verificador de producao.
  const url = new URL(bruto.slice(1, -1));
  assert.equal(url.origin + url.pathname, `${config.baseUrl}/descadastro`);
  assert.equal(desc.lerEmailDaUrl(url.searchParams.get('e')), email);
  assert.equal(desc.verificarToken(email, url.searchParams.get('t')), true);
});

test('enviar(): o link automatico e do DESTINATARIO daquele envio, nao de outro', async () => {
  const h = httpDeTeste();
  await api.enviar('primeiro@exemplo.com', 'A', '<p>a</p>', { httpClient: h.client });
  await api.enviar('segundo@exemplo.com', 'B', '<p>b</p>', { httpClient: h.client });

  const alvo = (c) =>
    desc.lerEmailDaUrl(new URL(c.corpo.headers['List-Unsubscribe'].slice(1, -1)).searchParams.get('e'));
  assert.equal(alvo(h.chamadas[0]), 'primeiro@exemplo.com');
  assert.equal(alvo(h.chamadas[1]), 'segundo@exemplo.com');
});

test('opcoes.headers: header extra do chamador convive com o descadastro automatico', async () => {
  const h = httpDeTeste();
  await api.enviar('merge@exemplo.com', 'A', '<p>a</p>', {
    httpClient: h.client,
    headers: { 'X-Campanha-Id': '42' },
  });

  const headers = h.ultima().corpo.headers;
  assert.equal(headers['X-Campanha-Id'], '42', 'o header do chamador nao pode sumir');
  assert.equal(headers['List-Unsubscribe-Post'], 'List-Unsubscribe=One-Click');
});

test('opcoes.headers: List-Unsubscribe do chamador PREVALECE sobre o automatico', async () => {
  const h = httpDeTeste();
  const proprio = '<https://outro.exemplo.com/sair?x=1>';
  await api.enviar('manual@exemplo.com', 'A', '<p>a</p>', {
    httpClient: h.client,
    headers: { 'List-Unsubscribe': proprio },
  });
  assert.equal(h.ultima().corpo.headers['List-Unsubscribe'], proprio);
});

test('opcoes.semDescadastro: true omite os cabecalhos (e o campo some do corpo)', async () => {
  const h = httpDeTeste();
  await api.enviar('sem-optout@exemplo.com', 'A', '<p>a</p>', {
    httpClient: h.client,
    semDescadastro: true,
  });
  // Diferente do jsonTransport (que normalizava para {}), aqui o campo simplesmente nao e
  // adicionado quando nao ha header nenhum.
  assert.equal('headers' in h.ultima().corpo, false);
});

test('opcoes.semDescadastro: so vale com true literal', async () => {
  const h = httpDeTeste();
  for (const quaseVerdadeiro of [1, 'true', {}, 'sim']) {
    await api.enviar('coercao@exemplo.com', 'A', '<p>a</p>', {
      httpClient: h.client,
      semDescadastro: quaseVerdadeiro,
    });
    assert.ok(
      h.ultima().corpo.headers['List-Unsubscribe'],
      `semDescadastro=${JSON.stringify(quaseVerdadeiro)} nao pode omitir o cabecalho`,
    );
  }
});

test('sem DESCADASTRO_SECRET lanca, mesmo sem o chamador pedir descadastro', async () => {
  const h = httpDeTeste();
  const original = config.descadastro.segredo;
  config.descadastro.segredo = '';
  try {
    await assert.rejects(
      () => api.enviar('qualquer@exemplo.com', 'A', '<p>a</p>', { httpClient: h.client }),
      /DESCADASTRO_SECRET/,
    );
    assert.equal(h.chamadas.length, 0, 'nada pode ter ido para a rede');

    // A valvula de escape continua sendo o unico caminho possivel nesse estado.
    await api.enviar('qualquer@exemplo.com', 'A', '<p>a</p>', {
      httpClient: h.client,
      semDescadastro: true,
    });
    assert.equal(h.chamadas.length, 1);
  } finally {
    config.descadastro.segredo = original;
  }
});

// ══════════════════════════════════════════════════════════════
// 3. Credencial e destinatario ausentes — antes de qualquer requisicao
// ══════════════════════════════════════════════════════════════

test('enviar(): lanca claro quando falta a chave de API, sem tocar a rede', async () => {
  const h = httpDeTeste();
  await comConfigCampanha({ apiKey: '' }, async () => {
    await assert.rejects(
      () => api.enviar('pessoa@exemplo.com', 'A', '<p>a</p>', { httpClient: h.client }),
      (err) => {
        assert.match(err.message, /EMAILIT_API_KEY/);
        // A mensagem precisa dizer que NAO e a credencial de SMTP — e o erro obvio de
        // quem esta migrando de transporte.
        assert.match(err.message, /DIFERENTE do usuario\/senha de SMTP/);
        return true;
      },
    );
  });
  assert.equal(h.chamadas.length, 0, 'nenhuma requisicao pode ter sido feita');
});

test('enviar(): lanca claro quando o destinatario esta vazio', async () => {
  const h = httpDeTeste();
  for (const vazio of ['', null, undefined]) {
    await assert.rejects(
      () => api.enviar(vazio, 'A', '<p>a</p>', { httpClient: h.client }),
      /[Dd]estinatario/,
    );
  }
  assert.equal(h.chamadas.length, 0, 'nada pode ter sido montado');
});

test('enviar(): lanca claro quando o remetente de campanha esta ausente', async () => {
  const h = httpDeTeste();
  await comConfigCampanha({ remetente: '' }, async () => {
    await assert.rejects(
      () => api.enviar('pessoa@exemplo.com', 'A', '<p>a</p>', { httpClient: h.client }),
      /SMTP_CAMPANHA_FROM_EMAIL/,
    );
  });
  assert.equal(h.chamadas.length, 0);
});

test('credenciaisFaltando(): lista os nomes das variaveis ausentes', () => {
  assert.deepEqual(api.credenciaisFaltando(), []);
  comConfigCampanha({ apiKey: '', remetente: '' }, () => {
    assert.deepEqual(api.credenciaisFaltando(), ['EMAILIT_API_KEY', 'SMTP_CAMPANHA_FROM_EMAIL']);
  });
});

// ══════════════════════════════════════════════════════════════
// 4. Erro da API — nao pode ser engolido
// ══════════════════════════════════════════════════════════════

test('enviar(): resposta 4xx vira excecao com status e corpo do provedor', async () => {
  const h = httpDeTeste({ ok: false, status: 422, text: '{"error":"domain not verified"}' });
  await assert.rejects(
    () => api.enviar('pessoa@exemplo.com', 'A', '<p>a</p>', { httpClient: h.client }),
    (err) => {
      assert.match(err.message, /HTTP 422/);
      assert.match(err.message, /domain not verified/, 'a pista do provedor tem que sobreviver');
      return true;
    },
  );
});

test('enviar(): resposta 5xx tambem lanca (nada de sucesso silencioso)', async () => {
  const h = httpDeTeste({ ok: false, status: 503, text: 'upstream unavailable' });
  await assert.rejects(
    () => api.enviar('pessoa@exemplo.com', 'A', '<p>a</p>', { httpClient: h.client }),
    /HTTP 503/,
  );
});

test('enviar(): falha de rede do http client vira excecao com a mensagem original', async () => {
  const quebrado = async () => {
    throw new Error('ECONNREFUSED 77.78.86.180:443');
  };
  await assert.rejects(
    () => api.enviar('pessoa@exemplo.com', 'A', '<p>a</p>', { httpClient: quebrado }),
    /ECONNREFUSED/,
  );
});

test('enviar(): corpo de erro ilegivel nao mascara o status', async () => {
  const clientSemTexto = async () => ({
    ok: false,
    status: 500,
    async text() {
      throw new Error('stream quebrado');
    },
  });
  await assert.rejects(
    () => api.enviar('pessoa@exemplo.com', 'A', '<p>a</p>', { httpClient: clientSemTexto }),
    (err) => {
      assert.match(err.message, /HTTP 500/);
      assert.match(err.message, /ilegivel/);
      return true;
    },
  );
});

// ══════════════════════════════════════════════════════════════
// 5. A fachada — selecao de transporte
// ══════════════════════════════════════════════════════════════

test('fachada: o default e a API REST (o SMTP esta bloqueado no Railway)', () => {
  assert.equal(config.provedores.emailCampanha.transporte, 'api', 'sanidade do ambiente');
  assert.equal(fachada.selecionar(), api);
});

test('fachada: EMAIL_CAMPANHA_TRANSPORTE=smtp volta ao adaptador antigo', () => {
  comConfigCampanha({ transporte: 'smtp' }, () => {
    assert.equal(fachada.selecionar(), smtp);
  });
});

test('fachada: credenciaisFaltando acompanha o transporte — e ESSA e a trava do pre-voo', () => {
  // O erro mais perigoso possivel nesta fachada: rotear `enviar` para a API e
  // `credenciaisFaltando` para o SMTP. O pre-voo aprovaria um ambiente com as
  // SMTP_CAMPANHA_* preenchidas e a chave de API VAZIA, materializaria a campanha inteira
  // e cada destinatario viraria 'falha' terminal, sem caminho de volta.
  comConfigCampanha({ apiKey: '', host: 'smtp.exemplo.com', usuario: 'u', senha: 's' }, () => {
    assert.deepEqual(fachada.credenciaisFaltando(), ['EMAILIT_API_KEY']);
  });
  comConfigCampanha({ transporte: 'smtp', apiKey: '', host: '', usuario: 'u', senha: 's' }, () => {
    assert.deepEqual(fachada.credenciaisFaltando(), ['SMTP_CAMPANHA_HOST']);
  });
});

test('fachada: transporte desconhecido LANCA, nao cai em default silencioso', async () => {
  // Um typo em EMAIL_CAMPANHA_TRANSPORTE que virasse "manda por SMTP mesmo" reproduziria
  // exatamente o bug que este incremento conserta, e o sintoma (502 depois de 120 s) nao
  // aponta para a variavel.
  comConfigCampanha({ transporte: 'sm7p' }, () => {
    assert.throws(() => fachada.selecionar(), /Transporte de e-mail de campanha desconhecido/);
  });
});

test('fachada: repassa opcoes intactas ao adaptador escolhido', async () => {
  const h = httpDeTeste();
  await fachada.enviar('pessoa@exemplo.com', 'A', '<p>a</p>', { httpClient: h.client });
  assert.equal(h.chamadas.length, 1, 'o httpClient tem que ter chegado ao adaptador');
  assert.equal(h.ultima().corpo.to, 'pessoa@exemplo.com');
});
