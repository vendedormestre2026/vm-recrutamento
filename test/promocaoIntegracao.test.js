'use strict';

// Promocao de Vagas — INTEGRACAO PONTA A PONTA (Incrementos 1 a 7 rodando juntos).
//
// ── POR QUE ESTE ARQUIVO EXISTE, tendo 390 testes antes dele ──
// Os outros arquivos provam cada peca ISOLADA: o motor de publico com o banco dele, a tela
// com as campanhas dela, a rotina de disparo com a fila dela. Nenhum deles prova que as
// tres exclusoes automaticas continuam valendo quando o fluxo inteiro roda numa base so —
// e e exatamente ai que uma exclusao se perde: nao dentro de uma funcao, mas na costura
// entre elas (o publico calculado num momento e materializado noutro, a campanha lida por
// uma rota e enviada por uma varredura).
//
// O que esta em jogo nao e um numero errado numa tela: e uma pessoa que pediu para sair da
// lista recebendo e-mail. Nao existe despublicar e-mail enviado.
//
// ── COMO LER ESTE ARQUIVO ──
// O elenco abaixo e montado do ZERO (nao reusa fixture de nenhum outro teste) e cada
// INSERT diz, no comentario ao lado, QUAL REGRA aquela linha existe para provar. A lista
// de destinatarios esperados e escrita a mao, uma vez, e todas as assercoes conferem
// contra ELA — nunca contra o que o codigo devolveu.
//
// ── ZERO REDE ──
// O adaptador de e-mail e o REAL (providers/emailCampanha/emailit_api), com um httpClient
// dublê no lugar do fetch. Essa escolha e deliberada e mais forte que um dublê de funcao: o
// adaptador monta o corpo inteiro da requisicao sem abrir socket, entao os cabecalhos
// List-Unsubscribe que este teste inspeciona sao os DE VERDADE, produzidos pelo mesmo
// codigo que rodaria em producao. Um dublê que so registrasse os argumentos provaria que a
// rotina chamou o adaptador; este prova que o e-mail SAIU com opt-out valido.
//
// MUDOU O TRANSPORTE (era o `jsonTransport` do nodemailer sobre providers/emailCampanha/
// smtp): o Railway bloqueia egress SMTP, entao o transporte de producao virou a API REST.
// O teste acompanhou o default de producao de proposito — um teste de integracao que
// continuasse exercitando o SMTP estaria provando um caminho que nao roda mais.

const os = require('node:os');
const path = require('node:path');

process.env.DATABASE_PATH = path.join(os.tmpdir(), `vm-test-promocao-integra-${process.pid}-${Date.now()}.db`);
process.env.INTERVIEW_MOCK = 'true';
process.env.SESSION_SECRET = 'segredo-de-teste';
process.env.ADMIN_USER = 'admin-teste';
process.env.ADMIN_PASSWORD = 'senha-teste';
// Pre-condicoes de disparo (Incremento 7) presentes: sem elas o pre-voo barra o
// enfileiramento e o fluxo nem comeca. Nenhuma abre conexao — sao strings de config.
process.env.DESCADASTRO_SECRET = 'segredo-de-descadastro-da-integracao';
process.env.APP_BASE_URL = 'https://entrevista.exemplo.com.br';
process.env.SMTP_CAMPANHA_HOST = 'smtp.exemplo-provedor.com';
process.env.SMTP_CAMPANHA_USUARIO = 'usuario-de-teste';
process.env.SMTP_CAMPANHA_SENHA = 'senha-de-teste';
process.env.SMTP_CAMPANHA_FROM_EMAIL = 'vagas@vagas.exemplo.com.br';
// Credencial do transporte ATIVO (API REST). Sem ela o pre-voo barra o enfileiramento.
process.env.EMAILIT_API_KEY = 'em_chave-da-integracao';
process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert/strict');

const db = require('../src/db');
const { migrar } = require('../src/db/migrate');
const { config } = require('../src/config');
const { criarApp } = require('../src/server');
const desc = require('../src/lib/descadastro');
const apiCampanha = require('../src/providers/emailCampanha/emailit_api');
const disparo = require('../src/lib/dispararPromocao');
const { montarCorpoFinal } = require('../src/lib/ctaCampanha');

migrar();

// ──────────────────────────────────────────────────────────────
// Adaptador REAL + http client que nao abre socket
// ──────────────────────────────────────────────────────────────

// Cada item e o CORPO JSON da requisicao que teria ido para a API — ou seja, o e-mail como
// o provedor o receberia. As chaves sao as do payload do Emailit: to, subject, html,
// headers.
const enviadas = [];
// As requisicoes cruas (url + init), para as assercoes sobre transporte.
const requisicoes = [];

const httpCaptura = async (url, init) => {
  requisicoes.push({ url, init });
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

// O "dublê" injetado na rotina e o adaptador de verdade com o http client trocado. A rotina
// chama enviar(destino, assunto, html) com TRES argumentos (Incremento 7 nao monta
// cabecalho); o quarto entra aqui, e so para trocar o transporte.
const emailCampanhaComCaptura = {
  enviar: (destino, assunto, html) =>
    apiCampanha.enviar(destino, assunto, html, { httpClient: httpCaptura }),
};

const deps = { db, emailCampanha: emailCampanhaComCaptura };

// Todos os enderecos que receberam alguma mensagem, em ordem de envio. No payload da API
// `to` e uma string (um envio por destinatario), e nao a lista de objetos do nodemailer.
const destinatariosEnviados = () => enviadas.map((m) => m.to);

// ──────────────────────────────────────────────────────────────
// Helpers de cenario
// ──────────────────────────────────────────────────────────────

const run = (sql, ...p) => Number(db.getDb().prepare(sql).run(...p).lastInsertRowid);
const uma = (sql, ...p) => db.getDb().prepare(sql).get(...p);
const todas = (sql, ...p) => db.getDb().prepare(sql).all(...p);

let seq = 0;

function criarVaga(titulo, perfil) {
  seq += 1;
  return run(
    'INSERT INTO jobs (slug, titulo, perfil, ativo) VALUES (?, ?, ?, 1)',
    `vaga-integra-${seq}`,
    titulo,
    perfil,
  );
}

function criarCandidatura(jobId, email, utmSource) {
  seq += 1;
  return run(
    `INSERT INTO applications (job_id, nome, sobrenome, email, token, utm_source)
     VALUES (?, ?, 'Teste', ?, ?, ?)`,
    jobId,
    `Pessoa${seq}`,
    email,
    `tok-integra-${seq}`,
    utmSource,
  );
}

function criarTalento(email, perfilInteresse, status) {
  seq += 1;
  return run(
    'INSERT INTO talentos (nome, email, perfil_interesse, status) VALUES (?, ?, ?, ?)',
    `Talento${seq}`,
    email,
    perfilInteresse,
    status,
  );
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
// 1. As vagas
// ──────────────────────────────────────────────────────────────

// A vaga PROMOVIDA. Quem ja se candidatou a ela e excluido automaticamente (Incremento 4).
const vagaAlvo = criarVaga('Closer de Vendas — Vaga Alvo', 'CLOSER');
// Slug lido do banco (e nao repetido a mao): e dele que sai o link de candidatura do e-mail.
const slugVagaAlvo = uma('SELECT slug FROM jobs WHERE id = ?', vagaAlvo).slug;

// Vagas irrelevantes para a campanha, presentes so para o publico ter variedade de perfil.
// O `perfil` de um CANDIDATO sai de jobs.perfil da vaga a que ele se candidatou
// (sqlite.js:2071), entao e por elas que os candidatos ganham CLOSER ou SDR.
const vagaCloser = criarVaga('Outro Closer', 'CLOSER');
const vagaSdr = criarVaga('Pre-vendas SDR', 'SDR');

// ──────────────────────────────────────────────────────────────
// 2. O elenco — cada linha prova UMA regra
// ──────────────────────────────────────────────────────────────

// (A) ELEGIVEL. Candidatura em outra vaga CLOSER, origem instagram.
//     Prova o caso feliz: quem nao cai em nenhuma exclusao e casa o filtro, recebe.
criarCandidatura(vagaCloser, 'ana.closer@exemplo.com', 'instagram');

// (B) ELEGIVEL pelas EXCLUSOES, mas perfil SDR. Origem UTM diferente da (A).
//     Prova que o FILTRO de perfil estreita o publico — e que ser cortado por filtro e
//     coisa diferente de ser cortado por regra: sem filtro, esta pessoa entra.
criarCandidatura(vagaSdr, 'bruno.sdr@exemplo.com', 'grupo-whats');

// (C) EXCLUIDO — JA INSCRITO NA VAGA ALVO (promocaoVagas.js:183-189).
//     Perfil CLOSER (a vaga alvo e CLOSER), ou seja, passaria o filtro. So a exclusao
//     automatica o segura. Divulgar a vaga para quem ja se candidatou a ela e o erro que
//     esta regra existe para impedir.
criarCandidatura(vagaAlvo, 'carlos.jainscrito@exemplo.com', 'instagram');

// (D) EXCLUIDA — DESCADASTRADA (opt-out global, Incremento 2).
//     Candidatura em vaga CLOSER e origem valida: elegivel por TODO o resto. E o teste
//     mais importante do arquivo — se esta pessoa aparecer em qualquer assercao abaixo,
//     alguem que pediu para sair da lista recebeu e-mail.
criarCandidatura(vagaCloser, 'diana.optout@exemplo.com', 'instagram');
db.registrarDescadastro('diana.optout@exemplo.com', desc.ORIGEM_LINK_EMAIL);

// (E) ELEGIVEL — talento do Banco de Curriculos, perfil_interesse CLOSER, status 'novo'.
//     Prova que a base de contatos e a UNIAO das duas tabelas, e nao so o funil.
criarTalento('elisa.talento@exemplo.com', 'CLOSER', 'novo');

// (F) EXCLUIDO — talento com status 'descartado' (exclusao no SQL, sqlite.js:2117).
//     Perfil CLOSER: passaria o filtro. So o status o segura.
criarTalento('fabio.descartado@exemplo.com', 'CLOSER', 'descartado');

// (G) A MESMA PESSOA nas DUAS tabelas, com grafias diferentes (maiuscula + espaco).
//     Prova duas coisas de uma vez (Incremento 4): dedupe por e-mail NORMALIZADO — ela
//     recebe UMA vez, nao duas — e a precedencia `applications` vence `talentos` na origem
//     registrada. Sem o dedupe, esta pessoa receberia a mesma campanha em duplicata.
criarCandidatura(vagaCloser, '  Gabriela.Dupla@Exemplo.com ', 'site');
criarTalento('GABRIELA.DUPLA@exemplo.com  ', 'CLOSER', 'novo');

// ──────────────────────────────────────────────────────────────
// A VERDADE ESPERADA — escrita a mao, nao derivada do codigo
// ──────────────────────────────────────────────────────────────
//
// Campanha da `vagaAlvo` com UM filtro ativo: perfil = CLOSER, sem incluir quem nao tem
// perfil. Quem sobra, e por que:
//   ana.closer      — elegivel, CLOSER
//   elisa.talento   — elegivel, talento CLOSER
//   gabriela.dupla  — elegivel, CLOSER, UMA linha so (dedupe)
// Quem NAO sobra:
//   bruno.sdr             — cortado pelo FILTRO (perfil SDR)
//   carlos.jainscrito     — cortado pela REGRA "ja inscrito na vaga alvo"
//   diana.optout          — cortada pela REGRA "descadastrado"
//   fabio.descartado      — cortado pela REGRA "talento descartado"
const ESPERADOS = [
  'ana.closer@exemplo.com',
  'elisa.talento@exemplo.com',
  'gabriela.dupla@exemplo.com', // ja na forma normalizada — e assim que e gravado
].sort();

// Os quatro que NAO podem aparecer em lugar nenhum: nem no publico, nem em
// campanha_envios, nem numa mensagem montada.
const PROIBIDOS = [
  'bruno.sdr@exemplo.com',
  'carlos.jainscrito@exemplo.com',
  'diana.optout@exemplo.com',
  'fabio.descartado@exemplo.com',
];

const TOTAL_ESPERADO = ESPERADOS.length; // 3
const ESPERADOS_APPLICATIONS = 2; // ana + gabriela
const ESPERADOS_TALENTOS = 1; // elisa

// ──────────────────────────────────────────────────────────────
// Servidor + sessao de admin (mesmo padrao de promocaoTela.test.js)
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

// Os campos do formulario que definem o recorte. UM objeto, usado na previa E na criacao —
// se os dois divergissem, o teste estaria provando algo que o fluxo real nao faz.
const CAMPOS_CAMPANHA = {
  vaga: String(vagaAlvo),
  assunto: 'Vaga aberta: Closer de Vendas',
  corpo_html: '<p>Estamos com uma vaga de Closer aberta. Bora?</p>',
  perfil: 'CLOSER',
};

// Id da campanha criada no cenario principal, reusado pelo sub-cenario de idempotencia.
let campanhaId = 0;

// ══════════════════════════════════════════════════════════════
// CENARIO PRINCIPAL — do formulario ao e-mail montado
// ══════════════════════════════════════════════════════════════

test('a) GET /admin/promocao/nova oferece a vaga alvo', async () => {
  await comServidor(async (base) => {
    await autenticar(base);
    const html = await (await fetch(`${base}/admin/promocao/nova`, { headers: comAuth() })).text();
    assert.match(html, /Closer de Vendas — Vaga Alvo/);
    assert.match(html, new RegExp(`<option value="${vagaAlvo}"`));
  });
});

test('b) POST /previa com filtro de perfil mostra a contagem EXATA do elenco', async () => {
  await comServidor(async (base) => {
    await autenticar(base);
    const html = await (await fetch(`${base}/admin/promocao/previa`, form(CAMPOS_CAMPANHA))).text();

    // Contagem EXATA, casando o markup do numero — e nao um /3/ solto, que casaria com
    // qualquer 3 da pagina (inclusive de CSS) e passaria com o publico errado.
    assert.match(
      html,
      new RegExp(`<span class="funil-num">${TOTAL_ESPERADO}</span>`),
      'o total da previa precisa ser exatamente o elenco esperado',
    );
    assert.match(html, new RegExp(`<b>${ESPERADOS_APPLICATIONS}</b> de candidaturas`));
    assert.match(html, new RegExp(`<b>${ESPERADOS_TALENTOS}</b> do banco de talentos`));

    // A previa NAO cria nada (Incremento 5) — inclusive aqui, no fluxo completo.
    assert.equal(db.listarCampanhas().length, 0, 'a previa nao pode criar campanha');
    assert.equal(uma('SELECT COUNT(*) AS n FROM campanha_envios').n, 0);
  });
});

test('b2) o publico SEM filtro inclui o SDR — prova que ele foi cortado pelo FILTRO, nao por regra', () => {
  const { listarPublicoCampanha } = require('../src/lib/promocaoVagas');

  const semFiltro = listarPublicoCampanha({ jobIdAlvo: vagaAlvo });
  const emails = semFiltro.itens.map((i) => i.email).sort();

  assert.deepEqual(
    emails,
    [...ESPERADOS, 'bruno.sdr@exemplo.com'].sort(),
    'sem filtro entra o SDR — e SO ele a mais',
  );
  // As tres exclusoes automaticas nao sao filtro: valem mesmo sem nenhum filtro ligado.
  for (const proibido of ['carlos.jainscrito@exemplo.com', 'diana.optout@exemplo.com', 'fabio.descartado@exemplo.com']) {
    assert.ok(!emails.includes(proibido), `${proibido} nao pode aparecer nem sem filtro`);
  }
});

test('c) POST /admin/promocao cria o rascunho com o total congelado correto', async () => {
  await comServidor(async (base) => {
    await autenticar(base);
    const res = await fetch(`${base}/admin/promocao`, form(CAMPOS_CAMPANHA));
    assert.equal(res.status, 302);

    campanhaId = Number((res.headers.get('location') || '').split('/').pop());
    const c = db.obterCampanha(campanhaId);

    assert.equal(c.status, 'rascunho');
    assert.equal(c.job_id, vagaAlvo);
    assert.equal(c.total_destinatarios, TOTAL_ESPERADO);
    assert.equal(c.criterios.jobIdAlvo, vagaAlvo, 'o recorte gravado aponta para a vaga alvo');
    assert.equal(c.criterios.perfil, 'CLOSER');

    // Rascunho NAO materializa ninguem (Incremento 5).
    assert.equal(db.contarEnviosCampanha(campanhaId).total, 0);
  });
});

test('d) 1o clique em disparar mostra a Tela 2 com o N correto, sem efeito colateral', async () => {
  await comServidor(async (base) => {
    await autenticar(base);
    const res = await fetch(`${base}/admin/promocao/${campanhaId}/disparar`, form());
    assert.equal(res.status, 200);
    const html = await res.text();

    assert.match(html, /Confirmar disparo/);
    assert.match(
      html,
      new RegExp(`Sim, disparar para ${TOTAL_ESPERADO} destinatários`),
      'o botao de confirmar precisa dizer o numero exato',
    );
    assert.match(html, /não há cancelamento/i);

    assert.equal(db.obterCampanha(campanhaId).status, 'rascunho', 'o 1o clique nao enfileira');
    assert.equal(db.contarEnviosCampanha(campanhaId).total, 0);
  });
});

test('e) 2o clique enfileira EXATAMENTE as pessoas esperadas (lista inteira, nao contagem)', async () => {
  await comServidor(async (base) => {
    await autenticar(base);
    const res = await fetch(`${base}/admin/promocao/${campanhaId}/disparar`, form({ confirmado: '1' }));
    assert.equal(res.status, 302);
    assert.equal(res.headers.get('location'), `/admin/promocao/${campanhaId}`);
  });

  const linhas = todas(
    'SELECT email, origem_tipo, status FROM campanha_envios WHERE campanha_id = ? ORDER BY email',
    campanhaId,
  );

  // A LISTA INTEIRA. Uma assercao de contagem passaria com a pessoa errada la dentro —
  // por exemplo, a descadastrada no lugar do talento.
  assert.deepEqual(linhas.map((l) => l.email), ESPERADOS);
  assert.ok(linhas.every((l) => l.status === 'pendente'), 'toda linha nasce pendente');

  // Precedencia do Incremento 4: quem existe nas duas tabelas fica registrada como
  // 'application', nao 'talento'.
  const gabriela = linhas.find((l) => l.email === 'gabriela.dupla@exemplo.com');
  assert.equal(gabriela.origem_tipo, 'application', 'applications vence talentos na origem');

  const elisa = linhas.find((l) => l.email === 'elisa.talento@exemplo.com');
  assert.equal(elisa.origem_tipo, 'talento');

  assert.equal(db.obterCampanha(campanhaId).status, 'enfileirada');
});

test('f) a varredura envia so para os esperados, com List-Unsubscribe valido', async () => {
  db.definirConfigBool(disparo.CHAVE_ATIVO, true);
  config.entrevista.mock = false; // faz a rotina chamar o adaptador (com transporte capturado)

  const r = await semRuido(() => disparo.varrerDisparoPromocao(deps));

  assert.equal(r.enviados, TOTAL_ESPERADO);
  assert.equal(r.falhas, 0);

  // ── Quem recebeu ──
  assert.deepEqual(destinatariosEnviados().sort(), ESPERADOS, 'so os esperados podem receber');

  // ── Quem NAO recebeu ── varredura no corpo INTEIRO de cada mensagem montada, e nao so
  // no campo `to`: um endereco proibido em copia oculta, no corpo ou num cabecalho tambem
  // seria vazamento.
  const tudo = JSON.stringify(enviadas).toLowerCase();
  for (const proibido of PROIBIDOS) {
    assert.ok(
      !tudo.includes(proibido),
      `${proibido} nao pode aparecer em NENHUMA parte de NENHUMA mensagem`,
    );
  }

  // ── Cada mensagem carrega opt-out valido ──
  for (const m of enviadas) {
    const destino = m.to;

    const cabecalho = m.headers['List-Unsubscribe'];
    assert.ok(cabecalho, `List-Unsubscribe ausente para ${destino}`);
    assert.equal(m.headers['List-Unsubscribe-Post'], 'List-Unsubscribe=One-Click');

    // O link nao pode ser so "presente": ele precisa FUNCIONAR. Extraimos o token do
    // proprio cabecalho e validamos com o verificador de producao — um header com URL
    // quebrada e pior que header ausente, porque parece correto.
    const url = new URL(cabecalho.replace(/^<|>$/g, ''));
    assert.equal(url.pathname, '/descadastro');
    assert.equal(desc.lerEmailDaUrl(url.searchParams.get('e')), destino);
    assert.ok(
      desc.verificarToken(destino, url.searchParams.get('t')),
      `o token de descadastro de ${destino} precisa ser valido`,
    );

    // Conteudo: assunto e corpo sao os da campanha, iguais para todos. NAO ha personalizacao
    // por nome no e-mail de campanha — a UNICA coisa que varia por destinatario e a URL de
    // descadastro do rodape, que e assinada com o e-mail de quem recebe.
    assert.equal(m.subject, CAMPOS_CAMPANHA.assunto);
    // Corpo final = o texto do Jean dentro da moldura de campanha (cabecalho, botao,
    // rodape). Igualdade exata contra montarCorpoFinal (a mesma funcao que o botao de teste
    // usa), e nao um "contem" — o que sai tem que ser exatamente isto.
    assert.equal(
      m.html,
      montarCorpoFinal(
        CAMPOS_CAMPANHA.corpo_html,
        slugVagaAlvo,
        desc.montarUrlDescadastro(destino, config.baseUrl),
        db.obterVaga(vagaAlvo),
        campanhaId,
      ),
    );
    assert.match(m.html, new RegExp(`campanha_id=${campanhaId}`), 'clique atribuivel a ESTA campanha');
    assert.match(m.html, /utm_source=email/, 'a campanha precisa ser atribuivel na origem');

    // O link VISIVEL do rodape aponta para o MESMO endereco do cabecalho List-Unsubscribe.
    // Dois caminhos de opt-out que divergissem seriam pior que um so: o que o header
    // promete e o que o rodape entrega tem que ser a mesma coisa.
    assert.ok(
      m.html.includes(cabecalho.replace(/^<|>$/g, '').replace(/&/g, '&amp;')),
      `o link de descadastro do rodape de ${destino} tem que ser o do cabecalho`,
    );
  }

  config.entrevista.mock = true;
});

test('g) a campanha conclui e a tela de detalhe mostra os numeros agregados corretos', async () => {
  const c = db.obterCampanha(campanhaId);
  assert.equal(c.status, 'concluida');
  assert.ok(c.finalizada_em, 'campanha concluida precisa ter finalizada_em');

  const contagem = db.contarEnviosCampanha(campanhaId);
  assert.deepEqual(
    { total: contagem.total, enviado: contagem.enviado, pendente: contagem.pendente, falha: contagem.falha },
    { total: TOTAL_ESPERADO, enviado: TOTAL_ESPERADO, pendente: 0, falha: 0 },
  );

  await comServidor(async (base) => {
    await autenticar(base);
    const html = await (await fetch(`${base}/admin/promocao/${campanhaId}`, { headers: comAuth() })).text();

    assert.match(html, /Concluída/);
    assert.match(html, new RegExp(`<b>${TOTAL_ESPERADO}</b> destinatários congelados`));
    assert.match(html, new RegExp(`<b>${TOTAL_ESPERADO}</b> enviados`));
    assert.match(html, /<b>0<\/b> na fila/);
    assert.doesNotMatch(html, /falha/i, 'sem falhas, a linha de falhas nao aparece');
    assert.doesNotMatch(html, /Disparar campanha/, 'campanha concluida nao oferece o botao');

    // A tela agregada nao lista destinatario nenhum — nem os que receberam.
    for (const email of [...ESPERADOS, ...PROIBIDOS]) {
      assert.doesNotMatch(html, new RegExp(email), `${email} nao pode aparecer na tela de detalhe`);
    }
  });
});

// ══════════════════════════════════════════════════════════════
// SUB-CENARIO — idempotencia do FLUXO, nao so do UNIQUE
// ══════════════════════════════════════════════════════════════

test('h) rodar a varredura de novo NAO reenvia nada (kill-switch segue ligado)', async () => {
  // O interruptor continua LIGADO de proposito: se o teste o desligasse, provaria apenas
  // que o kill-switch funciona (ja coberto em promocaoDisparo.test.js). Aqui a pergunta e
  // outra — com tudo ligado e a campanha concluida, mais nada pode sair.
  assert.equal(disparo.ativo({ db }), true, 'sanidade: o interruptor precisa estar ligado');

  const antes = enviadas.length;
  assert.equal(antes, TOTAL_ESPERADO, 'sanidade: o cenario principal enviou o esperado');

  config.entrevista.mock = false;
  for (let ciclo = 0; ciclo < 3; ciclo += 1) {
    const r = await semRuido(() => disparo.varrerDisparoPromocao(deps));
    assert.equal(r.enviados, 0, `ciclo ${ciclo + 1} nao pode reenviar`);
    assert.equal(r.falhas, 0);
  }
  config.entrevista.mock = true;

  assert.equal(enviadas.length, antes, 'nenhuma mensagem nova pode ter sido montada');
  assert.deepEqual(destinatariosEnviados().sort(), ESPERADOS, 'ninguem recebeu duas vezes');

  // Nada mudou no banco: linhas continuam 'enviado', campanha continua 'concluida'.
  const contagem = db.contarEnviosCampanha(campanhaId);
  assert.equal(contagem.enviado, TOTAL_ESPERADO);
  assert.equal(contagem.pendente, 0);
  assert.equal(db.obterCampanha(campanhaId).status, 'concluida');
});

test('i) redisparar a MESMA campanha pela tela e recusado (nao ha segunda leva)', async () => {
  await comServidor(async (base) => {
    await autenticar(base);
    for (const corpo of [{}, { confirmado: '1' }]) {
      const res = await fetch(`${base}/admin/promocao/${campanhaId}/disparar`, form(corpo));
      assert.equal(res.status, 409);
      assert.match(await res.text(), /só é possível disparar uma campanha em rascunho/i);
    }
  });

  assert.equal(db.contarEnviosCampanha(campanhaId).total, TOTAL_ESPERADO, 'nenhuma linha nova');
  assert.equal(enviadas.length, TOTAL_ESPERADO, 'nenhuma mensagem nova');
});

// ══════════════════════════════════════════════════════════════
// FIDELIDADE DO BOTAO DE TESTE — os dois caminhos, o mesmo e-mail
// ══════════════════════════════════════════════════════════════

test('k) o e-mail de TESTE tem o corpo final IDENTICO ao do disparo real', async () => {
  // A pergunta que este teste responde e a unica que justifica o botao de teste existir:
  // "o que eu vi na minha caixa de entrada e exatamente o que a base vai receber?".
  //
  // Se um dia alguem montar o bloco de CTA num dos dois caminhos e esquecer o outro — ou
  // montar diferente —, o botao passa a validar um e-mail que nao existe, e o proximo bug
  // de link so aparece depois do disparo. Este teste e o que grita antes disso.
  const emailTeste = require('../src/lib/emailTestePromocao');
  const fachada = require('../src/providers/emailCampanha');

  // O corpo enviado no cenario principal (teste f), ja capturado.
  const htmlDoDisparo = enviadas[0].html;

  db.definirConfig(emailTeste.CHAVE_EMAIL_TESTE, 'qa@exemplo.com.br');
  db.definirConfig(emailTeste.CHAVE_ULTIMO_ENVIO, '0');

  const enviarOriginal = fachada.enviar;
  fachada.enviar = (destino, assunto, html) =>
    apiCampanha.enviar(destino, assunto, html, { httpClient: httpCaptura });
  let r;
  try {
    r = await semRuido(() =>
      emailTeste.enviarEmailTeste(
        // MESMO corpo e MESMA vaga da campanha do cenario principal.
        { assunto: CAMPOS_CAMPANHA.assunto, corpoHtml: CAMPOS_CAMPANHA.corpo_html, jobId: vagaAlvo },
        { db },
      ),
    );
  } finally {
    fachada.enviar = enviarOriginal;
  }

  assert.equal(r.ok, true, `o e-mail de teste precisa sair: ${r.mensagem || ''}`);

  const htmlDoTeste = enviadas[enviadas.length - 1].html;

  // ── A UNICA divergencia legitima entre os dois caminhos e o link de descadastro ──
  // Ele e assinado com o e-mail de QUEM RECEBE (HMAC sobre o endereco), entao o e-mail de
  // teste, que vai para o endereco de QA, nao pode carregar o link do candidato. Tudo o
  // mais — moldura, cabecalho, o texto do Jean, o botao e a URL da vaga com UTM — tem que
  // ser byte a byte igual.
  //
  // Normalizamos SO esse href e comparamos o resto por igualdade exata. E mais forte que
  // comparar campo a campo: qualquer diferenca nova que alguem introduza num dos caminhos
  // (uma cor, um espaco, um <tr> a mais) quebra aqui, porque nao esta na lista do que pode
  // variar.
  // DUAS divergencias legitimas, e so duas:
  //   1. o link de descadastro, assinado com HMAC do e-mail de quem recebe;
  //   2. o `campanha_id` do link da vaga — o botao de teste funciona a partir do formulario
  //      AINDA NAO SUBMETIDO, quando nao existe campanha e portanto nao existe id. E o
  //      comportamento certo: um clique do Jean no proprio e-mail de teste nao pode entrar
  //      na contagem de desempenho de campanha nenhuma.
  // Tudo o mais — moldura, cabecalho da vaga, selos, texto, botao, rodape — tem que ser
  // byte a byte igual, e e o que a comparacao abaixo exige.
  const semDescadastro = (h) =>
    h
      .replace(/href="[^"]*\/descadastro\?[^"]*"/, 'href="{{URL_DESCADASTRO}}"')
      .replace(/&amp;campanha_id=\d+/, '');

  assert.notEqual(
    semDescadastro(htmlDoTeste),
    htmlDoTeste,
    'sanidade: o rodape do e-mail de teste precisa ter um link de descadastro para normalizar',
  );
  assert.equal(
    semDescadastro(htmlDoTeste),
    semDescadastro(htmlDoDisparo),
    'fora o link de descadastro (que e por destinatario), os dois caminhos tem que produzir ' +
      'o MESMO HTML',
  );

  // E o link normalizado acima nao pode ser "qualquer coisa": no e-mail de teste ele tem que
  // ser o descadastro VALIDO do endereco de QA. Sem esta assercao, um rodape com link
  // quebrado passaria pela normalizacao sem ninguem notar.
  assert.ok(
    htmlDoTeste.includes(
      desc.montarUrlDescadastro('qa@exemplo.com.br', config.baseUrl).replace(/&/g, '&amp;'),
    ),
    'o rodape do e-mail de teste leva o descadastro do proprio endereco de teste',
  );

  assert.match(htmlDoTeste, /utm_source=email/);

  // O ASSUNTO, ao contrario do corpo, e propositalmente diferente: o prefixo [TESTE] existe
  // para o e-mail de QA nunca ser confundido com campanha real na caixa de entrada.
  assert.equal(enviadas[enviadas.length - 1].subject, `[TESTE] ${CAMPOS_CAMPANHA.assunto}`);

  // E o caminho do teste continua sem tocar em campanha_envios (o fecho abaixo reconfirma).
  assert.equal(db.contarEnviosCampanha(campanhaId).total, TOTAL_ESPERADO, 'nenhuma linha nova');
});

test('j) fecho: a descadastrada nunca apareceu em NENHUM lugar do fluxo', () => {
  // Assercao redundante de propósito, e a mais importante do arquivo. Se um refactor
  // futuro furar uma exclusao em qualquer ponto da costura — publico, materializacao,
  // fila, envio — este teste e o que grita.
  const optout = 'diana.optout@exemplo.com';

  assert.equal(db.estaDescadastrado(optout), true, 'sanidade: ela esta mesmo descadastrada');
  assert.equal(
    uma('SELECT COUNT(*) AS n FROM campanha_envios WHERE email = ?', optout).n,
    0,
    'nunca materializada',
  );
  assert.ok(!destinatariosEnviados().includes(optout), 'nunca destinataria');
  assert.ok(!JSON.stringify(enviadas).toLowerCase().includes(optout), 'nunca citada em mensagem');

  // E ela CONTINUA na base de candidaturas — o opt-out suprime o envio, nao apaga a
  // candidatura da pessoa (finalidades LGPD distintas).
  assert.ok(uma('SELECT id FROM applications WHERE email = ?', optout), 'a candidatura segue existindo');
});
