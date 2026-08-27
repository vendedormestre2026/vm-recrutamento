'use strict';

// E-mail de TESTE da Promocao de Vagas (lib/emailTestePromocao + POST /admin/promocao/teste
// + o campo em /admin/config).
//
// ── O QUE ESTE ARQUIVO PRECISA PROVAR, acima de tudo ──
// Este botao existe para o Jean ver o e-mail de verdade ANTES de disparar. Ele so cumpre
// esse papel se for, ao mesmo tempo:
//   1. FIEL — mesmo adaptador, mesmos cabecalhos de descadastro, mesmo corpo. Um teste que
//      enviasse uma mensagem diferente da real seria pior que nao ter teste nenhum;
//   2. INOFENSIVO — nenhuma linha em campanha_envios, nenhuma campanha criada, nenhuma
//      dependencia de promocao_ativa. E o que permite clicar a vontade;
//   3. CONTIDO — o cooldown segura o duplo-clique, que sem JavaScript na tela e o modo mais
//      facil de gastar cota do provedor por engano.
//
// ── ZERO REDE ──
// Mesma tecnica de promocaoIntegracao.test.js, e pela mesma razao: o adaptador e o REAL
// (providers/emailCampanha/emailit_api) com um httpClient dublê no lugar do fetch. Assim o
// List-Unsubscribe inspecionado aqui e o DE VERDADE, montado pelo codigo de producao — e
// nao um argumento que um dublê de funcao registrou.
//
// O dublê e instalado na FACHADA (providers/emailCampanha), que e o que a lib importa. Se
// fosse instalado em emailit_api diretamente, a fachada continuaria devolvendo o modulo
// real e o teste abriria socket de verdade.
//
// ── NENHUMA CAMPANHA E CRIADA EM NENHUM MOMENTO DESTE ARQUIVO ──
// POST /admin/promocao (a criacao do rascunho) nunca e chamado aqui, de proposito: e assim
// que se prova que o botao funciona ANTES de existir rascunho. As assercoes de
// `db.listarCampanhas().length === 0` no fim sao o fecho disso.

const os = require('node:os');
const path = require('node:path');

process.env.DATABASE_PATH = path.join(os.tmpdir(), `vm-test-promocao-teste-${process.pid}-${Date.now()}.db`);
process.env.INTERVIEW_MOCK = 'true';
process.env.SESSION_SECRET = 'segredo-de-teste';
process.env.ADMIN_USER = 'admin-teste';
process.env.ADMIN_PASSWORD = 'senha-teste';
// Pre-condicoes do disparo presentes (o e-mail de teste roda o MESMO pre-voo). Nenhuma
// abre conexao — sao strings de config.
process.env.DESCADASTRO_SECRET = 'segredo-de-descadastro-do-teste';
process.env.APP_BASE_URL = 'https://entrevista.exemplo.com.br';
process.env.SMTP_CAMPANHA_HOST = 'smtp.exemplo-provedor.com';
process.env.SMTP_CAMPANHA_USUARIO = 'usuario-de-teste';
process.env.SMTP_CAMPANHA_SENHA = 'senha-de-teste';
process.env.SMTP_CAMPANHA_FROM_EMAIL = 'vagas@vagas.exemplo.com.br';
// Credencial do transporte ATIVO (API REST). Sem ela o pre-voo barra o e-mail de teste.
process.env.EMAILIT_API_KEY = 'em_chave-do-teste';
process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert/strict');

const db = require('../src/db');
const { migrar } = require('../src/db/migrate');
const { config } = require('../src/config');
const { criarApp } = require('../src/server');
const desc = require('../src/lib/descadastro');
const fachadaCampanha = require('../src/providers/emailCampanha');
const apiCampanha = require('../src/providers/emailCampanha/emailit_api');
const emailTeste = require('../src/lib/emailTestePromocao');
const disparo = require('../src/lib/dispararPromocao');
const { montarCorpoFinal, montarUrlVaga, montarCorpoFinalGrupo } = require('../src/lib/ctaCampanha');

migrar();

const DESTINO_TESTE = 'qa.jean@exemplo.com.br';

// ──────────────────────────────────────────────────────────────
// Adaptador REAL + http client que nao abre socket
// ──────────────────────────────────────────────────────────────

// Cada item e o CORPO JSON da requisicao que teria ido para a API do Emailit.
const enviadas = [];

const httpCaptura = async (url, init) => {
  enviadas.push(JSON.parse(init.body));
  return {
    ok: true,
    status: 200,
    async json() {
      return { id: `em_${enviadas.length}`, message_id: `<${enviadas.length}@exemplo>` };
    },
    async text() {
      return '';
    },
  };
};

// A ROTA nao recebe deps — ela chama a lib, que chama a FACHADA. Trocamos o `enviar` da
// fachada em cache por uma versao que delega ao adaptador REAL com o http client injetado:
// a lib o chama como PROPRIEDADE (`emailCampanha.enviar(...)`), entao a troca vale. Mesma
// tecnica que promocaoSugestao.test.js usa com providers/llm.
const enviarOriginal = fachadaCampanha.enviar;
fachadaCampanha.enviar = (destino, assunto, html, opcoes = {}) =>
  apiCampanha.enviar(destino, assunto, html, { ...opcoes, httpClient: httpCaptura });

// ──────────────────────────────────────────────────────────────
// Cenario minimo — uma vaga ativa, so para o formulario ter o que oferecer
// ──────────────────────────────────────────────────────────────

const vagaId = Number(
  db
    .getDb()
    .prepare("INSERT INTO jobs (slug, titulo, perfil, ativo) VALUES ('vaga-email-teste', 'Closer de Vendas', 'CLOSER', 1)")
    .run().lastInsertRowid,
);

const contarEnvios = () => db.getDb().prepare('SELECT COUNT(*) AS n FROM campanha_envios').get().n;

function configurarDestino(valor) {
  db.definirConfig(emailTeste.CHAVE_EMAIL_TESTE, valor);
}

// Zera o cooldown escrevendo direto na chave que a lib le. Nao ha export so-para-teste: a
// marca de tempo mora no MESMO store `configuracoes` do resto do painel, e e por isso que
// o teste consegue manipula-la com a API normal.
function zerarCooldown() {
  db.definirConfig(emailTeste.CHAVE_ULTIMO_ENVIO, '0');
}

async function semRuido(fn) {
  const log = console.log;
  const err = console.error;
  console.log = () => {};
  console.error = () => {};
  try {
    return await fn();
  } finally {
    console.log = log;
    console.error = err;
  }
}

// ──────────────────────────────────────────────────────────────
// Servidor + sessao (mesmo padrao de promocaoTela.test.js)
// ──────────────────────────────────────────────────────────────

let cookieAdmin = '';

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

async function autenticar(base) {
  const res = await fetch(`${base}/admin/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ usuario: 'admin-teste', senha: 'senha-teste' }),
    redirect: 'manual',
  });
  const bruto = res.headers.getSetCookie ? res.headers.getSetCookie() : [res.headers.get('set-cookie')];
  cookieAdmin = bruto.filter(Boolean).map((c) => c.split(';')[0]).join('; ');
  assert.ok(cookieAdmin.includes('vm_admin'), 'o login precisa devolver o cookie de admin');
}

const comAuth = (extra = {}) => ({ Cookie: cookieAdmin, ...extra });

const form = (dados = {}) => ({
  method: 'POST',
  headers: comAuth({ 'Content-Type': 'application/x-www-form-urlencoded' }),
  body: new URLSearchParams(dados),
  redirect: 'manual',
});

// O conteudo que o Jean teria digitado no formulario — ainda NAO submetido como rascunho.
const CONTEUDO = {
  vaga: String(vagaId),
  assunto: 'Vaga aberta: Closer de Vendas',
  corpo_html: '<p>Estamos com uma vaga de Closer aberta. Bora?</p>',
};

// ══════════════════════════════════════════════════════════════
// 8. Autenticacao (herdada do mount em admin.js)
// ══════════════════════════════════════════════════════════════

test('POST /admin/promocao/teste exige login', async () => {
  await comServidor(async (base) => {
    const res = await fetch(`${base}/admin/promocao/teste`, { method: 'POST', redirect: 'manual' });
    assert.equal(res.status, 302, 'sem sessao a rota nao pode responder a tela');
    assert.match(res.headers.get('location') || '', /\/admin\/login/);
  });
  assert.equal(enviadas.length, 0, 'nenhum e-mail pode sair de uma requisicao sem sessao');
});

// ══════════════════════════════════════════════════════════════
// 3. Sem endereco configurado
// ══════════════════════════════════════════════════════════════

test('sem email_teste_promocao configurado: erro claro e NENHUM envio', async () => {
  configurarDestino('');
  zerarCooldown();

  await comServidor(async (base) => {
    await autenticar(base);
    const res = await fetch(`${base}/admin/promocao/teste`, form(CONTEUDO));

    assert.equal(res.status, 400);
    const html = await res.text();
    assert.match(html, /Nenhum e-mail de teste configurado/);
    assert.match(html, /\/admin\/config/, 'a mensagem precisa dizer ONDE configurar');
    // O texto em teste continua na tela: um erro de configuracao nao pode custar o rascunho.
    assert.match(html, /Vaga aberta: Closer de Vendas/);
  });

  assert.equal(enviadas.length, 0, 'sem destinatario configurado nada pode ser enviado');
});

test('o botao aparece com a nota de "configure primeiro" enquanto o endereco esta vazio', async () => {
  await comServidor(async (base) => {
    await autenticar(base);
    const html = await (await fetch(`${base}/admin/promocao/nova`, { headers: comAuth() })).text();

    // Botao VIVO por decisao (ver o comentario em formularioCampanha): quem clica sem
    // configurar recebe a instrucao completa, em vez de um controle morto sem explicacao.
    assert.match(html, /Enviar e-mail de teste para mim/);
    assert.match(html, /formaction="\/admin\/promocao\/teste"/);
    assert.match(html, /Configure o e-mail de teste em/);
  });
});

// ══════════════════════════════════════════════════════════════
// 1 e 2. Caminho feliz — conteudo exato e opt-out valido
// ══════════════════════════════════════════════════════════════

test('com o endereco configurado: envia o conteudo do formulario com o prefixo [TESTE]', async () => {
  configurarDestino(DESTINO_TESTE);
  zerarCooldown();
  const enviosAntes = contarEnvios();

  await comServidor(async (base) => {
    await autenticar(base);
    const res = await semRuido(() => fetch(`${base}/admin/promocao/teste`, form(CONTEUDO)));

    assert.equal(res.status, 200);
    const html = await res.text();
    assert.match(html, new RegExp(`E-mail de teste enviado para ${DESTINO_TESTE}`));
  });

  assert.equal(enviadas.length, 1, 'exatamente um e-mail');

  const m = enviadas[0];
  assert.equal(m.to, DESTINO_TESTE, 'sempre o endereco configurado, nunca outro');
  assert.equal(
    m.subject,
    `[TESTE] ${CONTEUDO.assunto}`,
    'o prefixo evita confundir o teste com campanha real na caixa de entrada',
  );
  // O corpo e o do formulario DENTRO da moldura de campanha — igualdade exata contra o que
  // montarCorpoFinal produz, que e a MESMA funcao do disparo real. A URL de descadastro do
  // rodape e a do proprio endereco de teste, montada pela mesma funcao que o adaptador usa
  // no cabecalho List-Unsubscribe.
  assert.equal(
    m.html,
    montarCorpoFinal(
      CONTEUDO.corpo_html,
      'vaga-email-teste',
      desc.montarUrlDescadastro(DESTINO_TESTE, config.baseUrl),
      // A vaga alimenta o cabecalho. O botao de teste a carrega com db.obterVaga — a mesma
      // fonte usada aqui.
      db.obterVaga(vagaId),
    ),
  );
  // `includes`, e nao `startsWith`: o texto do Jean agora vive dentro do <td> de conteudo,
  // depois do cabecalho da marca. O que importa continua sendo que ele entra INTACTO —
  // nenhuma reescrita, nenhum style injetado nos <p> dele.
  assert.ok(m.html.includes(CONTEUDO.corpo_html), 'o texto do Jean entra intacto na moldura');
  assert.match(m.html, /href="[^"]*\/vaga\/vaga-email-teste\?utm_source=email"/);

  // 6. NENHUMA linha em campanha_envios — a razao de existir deste caminho.
  assert.equal(contarEnvios(), enviosAntes, 'o e-mail de teste nao materializa destinatario');
});

test('o e-mail de teste carrega List-Unsubscribe VALIDO (o mesmo do envio real)', async () => {
  // Nao basta o cabecalho existir: e o link de descadastro que o Jean vai clicar no teste.
  // Extraimos o token do proprio cabecalho e o validamos com o verificador de producao.
  const m = enviadas[0];
  const cabecalho = m.headers['List-Unsubscribe'];
  assert.ok(cabecalho, 'sem List-Unsubscribe o teste nao testaria o que precisa testar');
  assert.equal(m.headers['List-Unsubscribe-Post'], 'List-Unsubscribe=One-Click');

  const url = new URL(cabecalho.replace(/^<|>$/g, ''));
  assert.equal(url.pathname, '/descadastro');
  assert.equal(desc.lerEmailDaUrl(url.searchParams.get('e')), DESTINO_TESTE);
  assert.ok(
    desc.verificarToken(DESTINO_TESTE, url.searchParams.get('t')),
    'o token do link de descadastro do e-mail de teste precisa ser valido',
  );
});

test('o e-mail de teste sai mesmo com promocao_ativa DESLIGADA', async () => {
  // O interruptor governa o envio EM MASSA. Este botao e ferramenta de QA do operador, e
  // exigir o interruptor ligado inverteria a ordem sensata: ninguem deveria precisar ligar
  // o disparo da base inteira para conferir a formatacao de um e-mail.
  assert.equal(disparo.ativo({ db }), false, 'sanidade: o interruptor esta desligado');

  zerarCooldown();
  const antes = enviadas.length;

  await comServidor(async (base) => {
    await autenticar(base);
    const res = await semRuido(() => fetch(`${base}/admin/promocao/teste`, form(CONTEUDO)));
    assert.equal(res.status, 200);
  });

  assert.equal(enviadas.length, antes + 1, 'o envio de teste nao depende de promocao_ativa');
});

test('a tela volta com o conteudo e os filtros PRESERVADOS, como /previa e /sugestao', async () => {
  zerarCooldown();

  await comServidor(async (base) => {
    await autenticar(base);
    const html = await semRuido(async () =>
      (
        await fetch(
          `${base}/admin/promocao/teste`,
          form({
            ...CONTEUDO,
            perfil: 'CLOSER',
            perfil_incluir_sem: '1',
            de: '2026-01-01',
            sugestao_gerada: '1',
            previa_calculada: '1',
          }),
        )
      ).text(),
    );

    assert.match(html, /Vaga aberta: Closer de Vendas/, 'o assunto digitado continua la');
    assert.match(html, /Estamos com uma vaga de Closer aberta/, 'o corpo digitado continua la');
    assert.match(html, /value="CLOSER" selected/);
    assert.match(html, /name="perfil_incluir_sem" value="1" checked/);
    assert.match(html, /name="de" value="2026-01-01"/);
    // A trava da vaga tambem atravessa este submit — senao o furo do Incremento 8
    // reabriria com um clique no botao de teste.
    assert.match(html, /<select disabled/);
    assert.match(html, /<input type="hidden" name="sugestao_gerada" value="1">/);
    // E a previa vem recalculada, como nas outras rotas que re-renderizam o formulario.
    assert.match(html, /Prévia do público/);
    assert.match(html, /Criar campanha \(rascunho\)/);
  });
});

test('assunto ou corpo vazios: erro claro e nenhum envio', async () => {
  zerarCooldown();
  const antes = enviadas.length;

  await comServidor(async (base) => {
    await autenticar(base);
    for (const parcial of [
      { vaga: String(vagaId), corpo_html: '<p>so corpo</p>' },
      { vaga: String(vagaId), assunto: 'so assunto' },
    ]) {
      const res = await fetch(`${base}/admin/promocao/teste`, form(parcial));
      assert.equal(res.status, 400);
      assert.match(await res.text(), /Preencha o assunto e o corpo/);
    }
  });

  assert.equal(enviadas.length, antes, 'e-mail de teste vazio nao seria teste de nada');
});

// ══════════════════════════════════════════════════════════════
// 5. Cooldown
// ══════════════════════════════════════════════════════════════

test('dois cliques seguidos: o segundo e recusado por cooldown e NAO envia', async () => {
  zerarCooldown();
  const antes = enviadas.length;

  await comServidor(async (base) => {
    await autenticar(base);

    const primeiro = await semRuido(() => fetch(`${base}/admin/promocao/teste`, form(CONTEUDO)));
    assert.equal(primeiro.status, 200, 'o primeiro clique passa');

    const segundo = await fetch(`${base}/admin/promocao/teste`, form(CONTEUDO));
    assert.equal(segundo.status, 429);
    const html = await segundo.text();
    assert.match(html, /Aguarde \d+ s/, 'a mensagem precisa dizer quanto falta');
    assert.match(html, /cota do provedor/i, 'e por que o intervalo existe');
    // Mesmo recusado, o texto em teste volta intacto.
    assert.match(html, /Vaga aberta: Closer de Vendas/);
  });

  assert.equal(enviadas.length, antes + 1, 'o duplo-clique produziu UM e-mail, nao dois');
});

test('segundosRestantesCooldown: conta a partir da marca gravada e libera no fim', () => {
  const agora = 1_800_000_000_000;
  db.definirConfig(emailTeste.CHAVE_ULTIMO_ENVIO, String(agora));

  assert.equal(emailTeste.segundosRestantesCooldown({ db }, agora), emailTeste.COOLDOWN_SEGUNDOS);
  assert.equal(emailTeste.segundosRestantesCooldown({ db }, agora + 30_000), emailTeste.COOLDOWN_SEGUNDOS - 30);
  assert.equal(
    emailTeste.segundosRestantesCooldown({ db }, agora + emailTeste.COOLDOWN_SEGUNDOS * 1000),
    0,
    'no limite exato ja esta liberado',
  );
  // Relogio para tras (NTP, restore) nao pode prender o botao.
  assert.equal(emailTeste.segundosRestantesCooldown({ db }, agora - 10_000_000), 0);
  // Marca ausente ou corrompida = nunca enviou.
  db.definirConfig(emailTeste.CHAVE_ULTIMO_ENVIO, 'lixo');
  assert.equal(emailTeste.segundosRestantesCooldown({ db }, agora), 0);
});

// ══════════════════════════════════════════════════════════════
// 4. Pre-voo — o mesmo do disparo real
// ══════════════════════════════════════════════════════════════

test('sem DESCADASTRO_SECRET o teste e bloqueado pelo pre-voo, sem enviar', async () => {
  zerarCooldown();
  const antes = enviadas.length;

  const segredoOriginal = config.descadastro.segredo;
  config.descadastro.segredo = '';
  try {
    await comServidor(async (base) => {
      await autenticar(base);
      const res = await semRuido(() => fetch(`${base}/admin/promocao/teste`, form(CONTEUDO)));
      assert.equal(res.status, 503);
      const html = await res.text();
      assert.match(html, /falta configuração no servidor/i);
      assert.match(html, /DESCADASTRO_SECRET/);
    });
  } finally {
    config.descadastro.segredo = segredoOriginal;
  }

  assert.equal(enviadas.length, antes, 'sem link de descadastro nao sai e-mail de campanha');
});

test('sem credencial do provedor de campanha o teste e bloqueado, sem enviar', async () => {
  // A credencial que importa e a do transporte ATIVO. Com a API REST selecionada, esvaziar
  // host/usuario/senha de SMTP nao bloquearia nada — o pre-voo pergunta ao adaptador ativo.
  zerarCooldown();
  const antes = enviadas.length;

  const chaveOriginal = config.provedores.emailCampanha.apiKey;
  config.provedores.emailCampanha.apiKey = '';
  try {
    await comServidor(async (base) => {
      await autenticar(base);
      const res = await semRuido(() => fetch(`${base}/admin/promocao/teste`, form(CONTEUDO)));
      assert.equal(res.status, 503);
      assert.match(await res.text(), /EMAILIT_API_KEY/);
    });
  } finally {
    config.provedores.emailCampanha.apiKey = chaveOriginal;
  }

  assert.equal(enviadas.length, antes);
});

test('bloqueio de pre-voo NAO consome o cooldown (a recusa nao pode punir quem corrigiu)', async () => {
  // O cooldown e checado DEPOIS do pre-voo justamente para isto: quem acabou de levar um
  // 503, corrigiu a configuracao e clicou de novo nao pode ouvir "espere 47 s".
  zerarCooldown();
  const antes = enviadas.length;

  const segredoOriginal = config.descadastro.segredo;
  config.descadastro.segredo = '';
  await comServidor(async (base) => {
    await autenticar(base);
    const bloqueado = await semRuido(() => fetch(`${base}/admin/promocao/teste`, form(CONTEUDO)));
    assert.equal(bloqueado.status, 503);

    config.descadastro.segredo = segredoOriginal;

    const depois = await semRuido(() => fetch(`${base}/admin/promocao/teste`, form(CONTEUDO)));
    assert.equal(depois.status, 200, 'corrigida a configuracao, o envio sai na hora');
  });

  assert.equal(enviadas.length, antes + 1);
});

// ══════════════════════════════════════════════════════════════
// tipo === 'convite_grupo' — mesma ferramenta, sem vaga
// ══════════════════════════════════════════════════════════════

const CIDADE_GRUPO = 'Joinville';
db.criarRegiaoGrupo(CIDADE_GRUPO, 'https://chat.whatsapp.com/teste-grupo-joinville');

const CONTEUDO_GRUPO = {
  tipo: 'convite_grupo',
  cidade_grupo: CIDADE_GRUPO,
  assunto: 'Entre no grupo de vagas de Joinville',
  corpo_html: '<p>Abrimos um grupo novo pra Joinville. Bora?</p>',
};

test('convite_grupo: envia com o botao ENTRAR NO GRUPO, sem bloco de vaga', async () => {
  configurarDestino(DESTINO_TESTE);
  zerarCooldown();
  const enviosAntes = contarEnvios();
  const antesEnviadas = enviadas.length;

  await comServidor(async (base) => {
    await autenticar(base);
    const res = await semRuido(() => fetch(`${base}/admin/promocao/teste`, form(CONTEUDO_GRUPO)));

    assert.equal(res.status, 200);
    const html = await res.text();
    assert.match(html, new RegExp(`E-mail de teste enviado para ${DESTINO_TESTE}`));
  });

  assert.equal(enviadas.length, antesEnviadas + 1, 'exatamente um e-mail a mais');

  const m = enviadas[enviadas.length - 1];
  assert.equal(m.to, DESTINO_TESTE);
  assert.equal(m.subject, `[TESTE] ${CONTEUDO_GRUPO.assunto}`);

  // Igualdade exata contra montarCorpoFinalGrupo — a MESMA funcao que o disparo real usa
  // para campanha de grupo. campanhaId NULL nos dois lados: nao ha campanha, e um clique
  // do proprio Jean no teste nao pode contar como clique de campanha nenhuma.
  assert.equal(
    m.html,
    montarCorpoFinalGrupo(
      CONTEUDO_GRUPO.corpo_html,
      db.obterSlugGrupo(CIDADE_GRUPO),
      desc.montarUrlDescadastro(DESTINO_TESTE, config.baseUrl),
      CIDADE_GRUPO,
      null,
    ),
  );

  assert.match(m.html, /ENTRAR NO GRUPO/, 'o botao do grupo precisa aparecer, nao o de vaga');
  assert.doesNotMatch(m.html, /VER A VAGA E ME CANDIDATAR/, 'e-mail de grupo nao pode ter o CTA de vaga');
  assert.match(m.html, new RegExp(`href="[^"]*/grupo/${db.obterSlugGrupo(CIDADE_GRUPO)}(\\?[^"]*)?"`));

  // NENHUMA linha em campanha_envios — mesma garantia do modo vaga.
  assert.equal(contarEnvios(), enviosAntes, 'o e-mail de teste de grupo tambem nao materializa destinatario');
});

test('convite_grupo: praca sem link de grupo cadastrado -> SEM_GRUPO, nao envia', async () => {
  configurarDestino(DESTINO_TESTE);
  zerarCooldown();
  const antes = enviadas.length;

  await comServidor(async (base) => {
    await autenticar(base);
    const res = await fetch(
      `${base}/admin/promocao/teste`,
      form({ ...CONTEUDO_GRUPO, cidade_grupo: 'Praça Sem Grupo Nenhum' }),
    );
    assert.equal(res.status, 400);
    const html = await res.text();
    assert.match(html, /não tem grupo configurado/);
  });

  assert.equal(enviadas.length, antes, 'sem link de grupo configurado nada pode ser enviado');
});

test('convite_grupo: vaga selecionada no formulario e IRRELEVANTE (jobId nao entra na validacao)', async () => {
  // Mesmo com um `vaga` no corpo do form (residuo de o Jean ter alternado de Objetivo na
  // tela), o backend so olha jobId quando tipo === 'divulgacao_vaga' — ver lerCriteriosDoForm.
  configurarDestino(DESTINO_TESTE);
  zerarCooldown();

  await comServidor(async (base) => {
    await autenticar(base);
    const res = await semRuido(() =>
      fetch(`${base}/admin/promocao/teste`, form({ ...CONTEUDO_GRUPO, vaga: String(vagaId) })),
    );
    assert.equal(res.status, 200, 'jobId presente e ignorado em convite_grupo, nao pode barrar o envio');
  });
});

// ══════════════════════════════════════════════════════════════
// Endereco invalido salvo por engano
// ══════════════════════════════════════════════════════════════

test('endereco configurado sem cara de e-mail: erro proprio, sem tentar enviar', async () => {
  configurarDestino('nao-e-um-email');
  zerarCooldown();
  const antes = enviadas.length;

  await comServidor(async (base) => {
    await autenticar(base);
    const res = await fetch(`${base}/admin/promocao/teste`, form(CONTEUDO));
    assert.equal(res.status, 400);
    assert.match(await res.text(), /não parece um endereço válido/);
  });

  assert.equal(enviadas.length, antes);
  configurarDestino(DESTINO_TESTE);
});

// ══════════════════════════════════════════════════════════════
// /admin/config — a chave nova
// ══════════════════════════════════════════════════════════════

test('/admin/config mostra e salva o e-mail de teste', async () => {
  await comServidor(async (base) => {
    await autenticar(base);

    const html = await (await fetch(`${base}/admin/config`, { headers: comAuth() })).text();
    assert.match(html, /E-mail de teste da Promoção de Vagas/);
    assert.match(html, /name="email_teste_promocao"/);
    assert.match(html, new RegExp(`value="${DESTINO_TESTE}"`), 'o valor salvo aparece no campo');

    const res = await fetch(
      `${base}/admin/config/email-teste-promocao`,
      form({ email_teste_promocao: '  outro.endereco@exemplo.com  ' }),
    );
    assert.equal(res.status, 302);
    assert.equal(res.headers.get('location'), '/admin/config?salvo=1');
    assert.equal(
      db.obterConfig(emailTeste.CHAVE_EMAIL_TESTE, ''),
      'outro.endereco@exemplo.com',
      'o endereco e gravado aparado',
    );

    // Vazio e valor valido: e como o Jean desliga o botao.
    await fetch(`${base}/admin/config/email-teste-promocao`, form({ email_teste_promocao: '' }));
    assert.equal(db.obterConfig(emailTeste.CHAVE_EMAIL_TESTE, ''), '');

    configurarDestino(DESTINO_TESTE);
  });
});

test('a chave nasce VAZIA (nao ha default embutido apontando para o endereco de alguem)', () => {
  // Conferido num banco limpo: `configuracoes` e chave/valor livre, e a ausencia da chave
  // significa "nao configurado". Um default util aqui seria o e-mail de outra pessoa.
  const zerado = { obterConfig: (chave, padrao) => (chave === emailTeste.CHAVE_EMAIL_TESTE ? padrao : padrao) };
  assert.equal(emailTeste.enderecoTeste({ db: zerado }), '');
});

// ══════════════════════════════════════════════════════════════
// 7 e 6. O fecho: nada de campanha existiu neste arquivo inteiro
// ══════════════════════════════════════════════════════════════

test('fecho: o fluxo inteiro rodou SEM campanha criada e SEM linha em campanha_envios', () => {
  // 7. Todos os envios acima sairam do formulario cru — POST /admin/promocao nunca foi
  //    chamado neste arquivo. Se um dia o botao passar a exigir rascunho, este teste quebra.
  assert.equal(db.listarCampanhas().length, 0, 'nenhuma campanha foi criada por este fluxo');

  // 6. E nenhuma linha de envio, que e o recurso finito que o UNIQUE(campanha_id, email)
  //    torna irrecuperavel.
  assert.equal(contarEnvios(), 0, 'campanha_envios continua intocada');

  // Sanidade do proprio arquivo: houve envio de verdade — as assercoes acima nao passaram
  // por vacuidade.
  assert.ok(enviadas.length >= 3, 'o cenario precisa ter enviado e-mails de teste de fato');
});

test.after(() => {
  fachadaCampanha.enviar = enviarOriginal;
});
