'use strict';

// Retentativa, classificacao de erro e pacing do disparo de campanha.
// (src/lib/classificarErroEnvio.js + o laco de src/lib/dispararPromocao.js + as escritas de
// tentativa em sqlite.js)
//
// O QUE ESTA EM JOGO: 2.945 destinatarios reais foram perdidos porque falhar era uma coisa
// so. A apuracao nao achou UM bounce — foram 2.793 HTTP 429 do Emailit e 152 HTTP 403 do
// ZeptoMail, todos transitorios, todos tratados como definitivos, e o UNIQUE(campanha_id,
// email) impede materializar a campanha de novo para as mesmas pessoas. Nao ha desfazer.
//
// As assercoes daqui guardam as quatro decisoes que impedem a repeticao disso:
//   1. transitorio VOLTA para a fila em vez de virar 'falha';
//   2. o teto de tentativas existe e e MAIOR para limite de cota (que resolve sozinho) do
//      que para erro generico;
//   3. bounce continua sendo terminal — retentar bounce queima reputacao de dominio;
//   4. erro de CONFIGURACAO nao e cobrado do destinatario: aborta o ciclo, nao marca
//      ninguem, nao conta tentativa de ninguem.
// Mais o pacing, que ataca a causa das 2.793: a rajada.
//
// ZERO REDE, mesmo contrato de promocaoDisparo.test.js — o adaptador de e-mail e sempre um
// duble injetado por deps, e a suite nunca dorme de verdade (deps.dormir e espiao).

const os = require('node:os');
const path = require('node:path');

process.env.DATABASE_PATH = path.join(os.tmpdir(), `vm-test-promocao-retentativa-${process.pid}-${Date.now()}.db`);
process.env.INTERVIEW_MOCK = 'true';
process.env.SESSION_SECRET = 'segredo-de-teste';
process.env.ADMIN_USER = 'admin-teste';
process.env.ADMIN_PASSWORD = 'senha-teste';
process.env.DESCADASTRO_SECRET = 'segredo-de-descadastro-de-teste';
process.env.APP_BASE_URL = 'https://entrevista.exemplo.com.br';
process.env.SMTP_CAMPANHA_FROM_EMAIL = 'vagas@vagas.exemplo.com.br';
process.env.EMAILIT_API_KEY = 'em_chave-de-teste';
process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert/strict');

const db = require('../src/db');
const { migrar } = require('../src/db/migrate');
const { config } = require('../src/config');
const { listarPublicoCampanha } = require('../src/lib/promocaoVagas');
const disparo = require('../src/lib/dispararPromocao');
const {
  classificarErroEnvio,
  TETO_BAIXO,
  TETO_ALTO,
} = require('../src/lib/classificarErroEnvio');

migrar();

// ── Duble do adaptador ──
// `proximoErro` e uma FUNCAO por destinatario e nao um valor fixo: varios cenarios precisam
// que a mesma linha falhe em N ciclos e passe no N+1, e so uma funcao consegue mudar de
// resposta entre chamadas.
let erroPara = () => null;
const enviosFeitos = [];

const emailCampanhaDuble = {
  async enviar(...args) {
    const [destinatario] = args;
    const err = erroPara(destinatario, enviosFeitos.length);
    if (err) throw err instanceof Error ? err : new Error(String(err));
    enviosFeitos.push(args);
    return { id: `fake-${enviosFeitos.length}` };
  },
};

// Espiao de pausa: registra CADA duracao pedida e nao dorme. Sem isto, um ciclo de 3 envios
// levaria 1 s e um de 125 levaria mais de um minuto.
let pausas = [];
const dormirEspiao = async (ms) => {
  pausas.push(ms);
};

const deps = { db, emailCampanha: emailCampanhaDuble, dormir: dormirEspiao };

// ── Helpers ──
const run = (sql, ...p) => Number(db.getDb().prepare(sql).run(...p).lastInsertRowid);
const exec = (sql, ...p) => db.getDb().prepare(sql).run(...p);
const uma = (sql, ...p) => db.getDb().prepare(sql).get(...p);
const todas = (sql, ...p) => db.getDb().prepare(sql).all(...p);

let seq = 0;

function criarVaga() {
  seq += 1;
  return run(
    "INSERT INTO jobs (slug, titulo, perfil, ativo) VALUES (?, 'Vaga', 'CLOSER', 1)",
    `vaga-retentativa-${seq}`,
  );
}

function criarCandidatura(jobId, email) {
  seq += 1;
  return run(
    "INSERT INTO applications (job_id, nome, sobrenome, email, token) VALUES (?, 'Fulano', 'Teste', ?, ?)",
    jobId,
    email,
    `tok-retentativa-${seq}`,
  );
}

function criarRascunho(jobIdAlvo) {
  const criterios = { jobIdAlvo };
  return db.criarCampanha({
    job_id: jobIdAlvo,
    assunto: 'Vaga aberta',
    corpo_html: '<p>Temos uma vaga.</p>',
    criterios,
    total_destinatarios: listarPublicoCampanha(criterios).total,
  });
}

function zerarCampanhas() {
  exec('DELETE FROM campanha_envios');
  exec('DELETE FROM campanhas');
  enviosFeitos.length = 0;
  pausas = [];
  erroPara = () => null;
}

function linhaDe(email) {
  return uma('SELECT status, erro, tentativas FROM campanha_envios WHERE email = ?', email);
}

async function semRuido(fn) {
  const log = console.log;
  const err = console.error;
  const linhas = [];
  console.log = (...a) => linhas.push(a.join(' '));
  console.error = (...a) => linhas.push(a.join(' '));
  try {
    const r = await fn();
    return { r, log: linhas.join('\n') };
  } finally {
    console.log = log;
    console.error = err;
  }
}

// Vaga-alvo unica. O publico e sempre "quem NAO se candidatou a esta vaga", entao os
// candidatos abaixo (de outra vaga) formam a base.
const vagaAlvo = criarVaga();
const vagaOutra = criarVaga();
criarCandidatura(vagaOutra, 'ana@exemplo.com');
criarCandidatura(vagaOutra, 'bruno@exemplo.com');
criarCandidatura(vagaOutra, 'carla@exemplo.com');

db.definirConfigBool(disparo.CHAVE_ATIVO, true);
config.entrevista.mock = false;

// ════════════════ A. Classificacao (unitario, sem banco) ════════════════

test('classificacao: os codigos de configuracao do ZeptoMail abortam o ciclo', () => {
  // A lista veio da doc do provedor e da apuracao — todos apontam para credencial, token,
  // agente de envio ou estado da conta. Nenhum deles muda de resposta conforme a pessoa,
  // que e exatamente o criterio de "nao cobre isso do destinatario".
  for (const codigo of ['SERR_157', 'SERR_156', 'SM_111', 'SM_101', 'AE_101']) {
    const c = classificarErroEnvio(new Error(`HTTP 400 — {"code":"${codigo}","message":"x"}`));
    assert.equal(c.categoria, 'configuracao', `${codigo} precisa ser configuracao`);
    assert.equal(c.teto, null, 'configuracao nao tem teto: nao se conta tentativa de ninguem');
  }
});

test('classificacao: 401 e 403 sao configuracao, nao falha do destinatario', () => {
  // Os 152 perdidos foram HTTP 403 (limite de conta trial). Como falha por destinatario,
  // custaram 152 pessoas; como configuracao, teriam abortado o ciclo sem marcar ninguem.
  for (const status of [401, 403]) {
    const c = classificarErroEnvio(new Error(`Falha ao enviar: HTTP ${status} — negado`));
    assert.equal(c.categoria, 'configuracao');
  }
});

test('classificacao: erro NOSSO de ambiente tambem aborta o ciclo', () => {
  // A classificacao le TEXTO, entao estes casos so funcionam enquanto as mensagens
  // nomearem a variavel. Sao as mensagens reais das funcoes que as lancam.
  const casos = [
    'DESCADASTRO_SECRET ausente. Defina no .env.',
    'Credenciais de campanha ausentes: ZEPTOMAIL_TOKEN.',
    'SMTP_CAMPANHA_FROM_EMAIL ausente. Defina o remetente de campanha no .env',
    'ZEPTOMAIL_API_URL invalida: "api.zeptomail.com". Precisa ser a URL completa',
    'Failed to parse URL from api.zeptomail.com',
  ];
  for (const msg of casos) {
    assert.equal(classificarErroEnvio(new Error(msg)).categoria, 'configuracao', msg);
  }
});

test('classificacao: limite de cota do provedor tem teto ALTO', () => {
  // Teto alto porque o problema resolve sozinho com o tempo — um limite DIARIO precisa que
  // a janela de retentativa atravesse a virada do dia (100 ciclos de 15 min = ~25 h).
  for (const codigo of ['SMI_115', 'SM_133', 'SM_128']) {
    const c = classificarErroEnvio(new Error(`HTTP 400 — {"code":"${codigo}"}`));
    assert.equal(c.categoria, 'retentavel_alto', `${codigo} precisa ser retentavel_alto`);
    assert.equal(c.teto, TETO_ALTO);
  }
  assert.ok(TETO_ALTO > TETO_BAIXO, 'o teto de cota precisa ser maior que o generico');
});

test('classificacao: 429 e 5xx sao retentaveis com teto baixo', () => {
  // 2.793 das 2.945 perdidas eram exatamente este 429.
  assert.deepEqual(
    classificarErroEnvio(new Error('HTTP 429 — Too Many Requests')).categoria,
    'retentavel',
  );
  for (const status of [500, 502, 503]) {
    const c = classificarErroEnvio(new Error(`HTTP ${status} — erro`));
    assert.equal(c.categoria, 'retentavel');
    assert.equal(c.teto, TETO_BAIXO);
  }
});

test('classificacao: recusa do ENDERECO e terminal', () => {
  // O unico caso em que nao retentar e a decisao certa: bounce repetido queima reputacao.
  const casos = [
    'bounce: mailbox nao existe',
    'HTTP 400 — invalid email address',
    'Invalid Recipient',
    '550 5.1.1 no such user',
    'Destinatario de e-mail de campanha ausente.',
  ];
  for (const msg of casos) {
    const c = classificarErroEnvio(new Error(msg));
    assert.equal(c.categoria, 'terminal', msg);
    assert.equal(c.teto, null);
  }
});

test('classificacao: erro DESCONHECIDO e retentavel, e nao terminal', () => {
  // A inversao deliberada do padrao anterior. A assimetria de custo decide:
  // desconhecido-como-terminal custa uma pessoa para sempre; desconhecido-como-retentavel
  // custa 4 chamadas e a linha vira 'falha' do mesmo jeito.
  const c = classificarErroEnvio(new Error('socket hang up'));
  assert.equal(c.categoria, 'retentavel');
  assert.equal(c.teto, TETO_BAIXO);
});

test('classificacao: a ordem das checagens protege o caso caro', () => {
  // Um 429 cuja resposta por acaso contenha a palavra "bounce" e um 429. Ler ao contrario
  // marcaria como terminal alguem que so pegou rajada — o erro original, de volta.
  assert.equal(
    classificarErroEnvio(new Error('HTTP 429 — rate limited (bounce queue full)')).categoria,
    'retentavel',
  );
  // E configuracao ganha de tudo: com o token errado, o 429 e consequencia, nao causa.
  assert.equal(
    classificarErroEnvio(new Error('HTTP 429 — {"code":"SM_111"}')).categoria,
    'configuracao',
  );
});

test('classificacao: fronteira de palavra no codigo do provedor', () => {
  // Sem \b, 'SM_101' casaria dentro de 'SM_1010' e um codigo desconhecido seria tratado
  // como erro de configuracao — abortando ciclos que deveriam seguir.
  assert.notEqual(classificarErroEnvio(new Error('HTTP 400 — SM_1010')).categoria, 'configuracao');
});

test('classificacao: aceita string, Error ou nulo sem explodir', () => {
  // Ela roda DENTRO de um catch. Lancar aqui derrubaria o tratamento de erro pelo erro.
  for (const entrada of [null, undefined, '', 'texto solto', new Error('x')]) {
    assert.ok(classificarErroEnvio(entrada).categoria, `nao pode explodir com ${entrada}`);
  }
});

// ════════════════ B. Os quatro caminhos, ponta a ponta ════════════════

test('transitorio: a linha VOLTA para a fila em vez de virar falha', async () => {
  zerarCampanhas();
  const id = criarRascunho(vagaAlvo);
  disparo.enfileirarCampanha(id, deps);

  erroPara = (email) => (email === 'ana@exemplo.com' ? new Error('HTTP 429 — Too Many Requests') : null);
  const { r } = await semRuido(() => disparo.varrerDisparoPromocao(deps));

  // O numero e PROPRIO: retentativa nao e subtipo de falha, sao linhas ainda vivas.
  assert.equal(r.retentativas, 1);
  assert.equal(r.falhas, 0);
  assert.equal(r.enviados, 2, 'os demais da leva seguem normalmente');

  const linha = linhaDe('ana@exemplo.com');
  assert.equal(linha.status, 'pendente', 'a linha NAO pode sair da fila');
  assert.equal(linha.tentativas, 1);
  assert.match(linha.erro, /HTTP 429/, 'a mensagem crua fica registrada');
  assert.match(linha.erro, /\[HTTP 429 \(excesso de requisicoes\)\]/, 'e a leitura que o sistema fez, tambem');

  // A campanha NAO conclui: ainda ha pendente. Concluir aqui seria declarar terminado um
  // trabalho que vai continuar no proximo ciclo.
  assert.equal(uma('SELECT status FROM campanhas WHERE id = ?', id).status, 'enviando');

  // E o ciclo seguinte, com o provedor de volta, entrega a mesma pessoa.
  erroPara = () => null;
  const { r: r2 } = await semRuido(() => disparo.varrerDisparoPromocao(deps));
  assert.equal(r2.enviados, 1);
  assert.equal(linhaDe('ana@exemplo.com').status, 'enviado');
  assert.equal(linhaDe('ana@exemplo.com').tentativas, 1, 'a tentativa que deu certo nao conta como falha');
  assert.equal(uma('SELECT status FROM campanhas WHERE id = ?', id).status, 'concluida');
});

test('transitorio: desiste ao esgotar o teto baixo, e nao antes', async () => {
  zerarCampanhas();
  const id = criarRascunho(vagaAlvo);
  disparo.enfileirarCampanha(id, deps);
  erroPara = () => new Error('HTTP 503 — provedor fora do ar');

  // Um ciclo por vez, como em producao: e o proprio intervalo de 15 min que reapresenta a
  // linha. Contamos os ciclos ate a fila secar.
  let ciclos = 0;
  while (db.contarEnviosCampanha(id).pendente > 0 && ciclos < TETO_BAIXO + 5) {
    await semRuido(() => disparo.varrerDisparoPromocao(deps));
    ciclos += 1;
  }

  assert.equal(ciclos, TETO_BAIXO, `precisa de exatamente ${TETO_BAIXO} ciclos para desistir`);
  const linha = linhaDe('ana@exemplo.com');
  assert.equal(linha.status, 'falha');
  assert.equal(linha.tentativas, TETO_BAIXO, 'a tentativa que esgotou o teto tambem conta');
  assert.equal(db.contarEnviosCampanha(id).falha, 3);
  // "Concluida" continua significando "nao ha mais nada pendente", e nao "deu tudo certo".
  assert.equal(uma('SELECT status FROM campanhas WHERE id = ?', id).status, 'concluida');
});

test('limite de cota: aguenta muito mais ciclos que o erro generico', async () => {
  zerarCampanhas();
  const id = criarRascunho(vagaAlvo);
  disparo.enfileirarCampanha(id, deps);
  erroPara = () => new Error('HTTP 400 — {"code":"SM_133","message":"daily limit"}');

  // TETO_BAIXO + 2 ciclos: um erro generico ja teria desistido; este nao pode nem cogitar.
  for (let i = 0; i < TETO_BAIXO + 2; i += 1) {
    await semRuido(() => disparo.varrerDisparoPromocao(deps));
  }

  const linha = linhaDe('ana@exemplo.com');
  assert.equal(linha.status, 'pendente', 'limite diario nao pode virar falha em 7 ciclos');
  assert.equal(linha.tentativas, TETO_BAIXO + 2);
  assert.equal(db.contarEnviosCampanha(id).falha, 0);

  // E quando a cota vira, todo mundo sai — que e o cenario dos 152 perdidos.
  erroPara = () => null;
  const { r } = await semRuido(() => disparo.varrerDisparoPromocao(deps));
  assert.equal(r.enviados, 3);
  assert.equal(db.contarEnviosCampanha(id).enviado, 3);
});

test('terminal: bounce vira falha na PRIMEIRA tentativa', async () => {
  zerarCampanhas();
  const id = criarRascunho(vagaAlvo);
  disparo.enfileirarCampanha(id, deps);
  erroPara = (email) =>
    email === 'bruno@exemplo.com' ? new Error('HTTP 400 — invalid email address') : null;

  const { r } = await semRuido(() => disparo.varrerDisparoPromocao(deps));

  assert.equal(r.falhas, 1);
  assert.equal(r.retentativas, 0, 'endereco invalido nao entra na fila de retentativa');
  const linha = linhaDe('bruno@exemplo.com');
  assert.equal(linha.status, 'falha');
  assert.equal(linha.tentativas, 1);
  assert.match(linha.erro, /recusa definitiva/);

  // Um segundo ciclo nao pode ressuscitar a linha nem gerar um segundo bounce.
  const antes = enviosFeitos.length;
  await semRuido(() => disparo.varrerDisparoPromocao(deps));
  assert.equal(enviosFeitos.length, antes, 'nenhum envio novo — a linha saiu da fila');
});

test('configuracao: aborta o ciclo, nao marca ninguem, nao conta tentativa de ninguem', async () => {
  zerarCampanhas();
  const id = criarRascunho(vagaAlvo);
  disparo.enfileirarCampanha(id, deps);
  erroPara = () => new Error('HTTP 401 — {"code":"SERR_157","message":"invalid token"}');

  const { r, log } = await semRuido(() => disparo.varrerDisparoPromocao(deps));

  assert.equal(r.abortado, true);
  assert.equal(r.falhas, 0, 'ninguem pode ser marcado como falha por erro do servidor');
  assert.equal(r.retentativas, 0, 'nem contado como tentativa');
  assert.equal(r.enviados, 0);

  // A prova mais importante: UMA chamada ao provedor, nao tres. Insistir com o ambiente
  // quebrado so produz repeticao de erro e desgaste com o provedor.
  assert.equal(enviosFeitos.length, 0);
  const tentativas = todas('SELECT tentativas, status FROM campanha_envios WHERE campanha_id = ?', id);
  assert.equal(tentativas.length, 3);
  for (const t of tentativas) {
    assert.equal(t.status, 'pendente', 'a fila fica exatamente como estava');
    assert.equal(t.tentativas, 0, 'o destinatario nao paga pelo erro do servidor');
  }

  // O log precisa saltar aos olhos num painel do Railway com milhares de linhas.
  assert.match(log, /ERRO DE CONFIGURACAO/);
  assert.match(log, /CICLO ABORTADO/);

  // A campanha NAO e concluida: o ciclo parou no meio, por um motivo que nao tem nada a ver
  // com ela. Declarar "trabalho terminado" em cima de um ambiente quebrado seria mentira.
  assert.equal(uma('SELECT status FROM campanhas WHERE id = ?', id).status, 'enviando');

  // Corrigido o ambiente, o proximo ciclo retoma do mesmo ponto, com todo mundo intacto.
  erroPara = () => null;
  const { r: r2 } = await semRuido(() => disparo.varrerDisparoPromocao(deps));
  assert.equal(r2.enviados, 3);
  assert.equal(r2.abortado, undefined, 'sem aborto, o campo nem aparece no resumo');
});

test('configuracao no MEIO da leva preserva quem ja saiu', async () => {
  zerarCampanhas();
  const id = criarRascunho(vagaAlvo);
  disparo.enfileirarCampanha(id, deps);
  // O segundo destinatario derruba o ciclo; o primeiro ja tinha ido.
  erroPara = (_email, jaEnviados) =>
    jaEnviados >= 1 ? new Error('DESCADASTRO_SECRET ausente. Defina no .env.') : null;

  const { r } = await semRuido(() => disparo.varrerDisparoPromocao(deps));

  assert.equal(r.enviados, 1, 'quem passou antes do aborto continua enviado');
  assert.equal(r.abortado, true);
  const c = db.contarEnviosCampanha(id);
  assert.equal(c.enviado, 1);
  assert.equal(c.pendente, 2, 'os dois restantes ficam na fila, intactos');
  assert.equal(c.falha, 0);
});

// ════════════════ C. Pacing ════════════════

test('pacing: pausa ENTRE envios, nunca depois do ultimo', async () => {
  zerarCampanhas();
  const id = criarRascunho(vagaAlvo);
  disparo.enfileirarCampanha(id, deps);

  const { r } = await semRuido(() => disparo.varrerDisparoPromocao(deps));

  assert.equal(r.enviados, 3);
  // 3 envios = 2 intervalos. Dormir depois do ultimo so atrasaria o fim do ciclo.
  assert.equal(pausas.length, 2, 'N envios pedem N-1 pausas');
  assert.deepEqual(pausas, [disparo.ENVIO_INTERVALO_MS, disparo.ENVIO_INTERVALO_MS]);
});

test('pacing: o default e 500 ms — 2 envios/s, o teto documentado do provedor', () => {
  // A rajada medida em producao era de 7 a 8 envios/s contra um teto de 2/s, e foi ela que
  // produziu os 2.793 HTTP 429. Este numero e a correcao direta disso, e o teste existe
  // para que baixa-lo exija uma decisao explicita, e nao um descuido.
  assert.equal(disparo.ENVIO_INTERVALO_MS, 500);
  assert.ok(
    (disparo.ENVIOS_POR_CICLO * disparo.ENVIO_INTERVALO_MS) / 1000 < 15 * 60,
    'o ciclo inteiro com pacing precisa caber com folga no intervalo de 15 min — ' +
      'se nao couber, o pacing deixou de ser gratuito e virou reducao de vazao',
  );
});

test('pacing: a pausa e injetavel e respeita intervalo zero', async () => {
  zerarCampanhas();
  const id = criarRascunho(vagaAlvo);
  disparo.enfileirarCampanha(id, deps);

  await semRuido(() => disparo.varrerDisparoPromocao({ ...deps, intervaloMs: 0 }));
  // Zero e um valor VALIDO e diferente de "nao informado": o laco continua chamando a
  // pausa, e quem decide nao dormir e ela. Se o zero caisse no default, um teste ou um
  // script de reprocessamento nao teria como desligar o pacing.
  assert.deepEqual(pausas, [0, 0]);
});

test('pacing: um ciclo abortado nao gasta pausa', async () => {
  zerarCampanhas();
  const id = criarRascunho(vagaAlvo);
  disparo.enfileirarCampanha(id, deps);
  erroPara = () => new Error('HTTP 403 — trial limit');

  await semRuido(() => disparo.varrerDisparoPromocao(deps));
  assert.deepEqual(pausas, [], 'o break sai antes da pausa: nao ha proximo envio para espacar');
});

// ════════════════ D. Schema e escritas de banco ════════════════

test('schema: campanha_envios.tentativas existe, e NOT NULL com default 0', () => {
  const col = todas('SELECT * FROM pragma_table_info(?)', 'campanha_envios').find(
    (c) => c.name === 'tentativas',
  );
  assert.ok(col, 'a coluna precisa existir — sem ela nao ha teto e a retentativa e infinita');
  assert.equal(col.type, 'INTEGER');
  assert.equal(col.notnull, 1);
  assert.equal(col.dflt_value, '0');
});

test('schema: uma linha recem-materializada nasce com 0 tentativas', () => {
  zerarCampanhas();
  const id = criarRascunho(vagaAlvo);
  disparo.enfileirarCampanha(id, deps);
  for (const l of todas('SELECT tentativas FROM campanha_envios WHERE campanha_id = ?', id)) {
    assert.equal(l.tentativas, 0);
  }
});

test('a fila entrega tentativas junto da linha', () => {
  zerarCampanhas();
  const id = criarRascunho(vagaAlvo);
  disparo.enfileirarCampanha(id, deps);
  exec('UPDATE campanhas SET status = ? WHERE id = ?', 'enviando', id);
  exec("UPDATE campanha_envios SET tentativas = 3 WHERE email = 'ana@exemplo.com'");

  const linha = db.listarEnviosPendentesCampanha({ limite: 10 }).find((l) => l.email === 'ana@exemplo.com');
  // Quem compara com o teto e a varredura, e ela so tem em maos o que esta consulta trouxer.
  assert.equal(linha.tentativas, 3, 'sem este campo na fila, a retentativa nao teria fim');
});

test('registrarTentativaEnvioCampanha conta e guarda sem tirar da fila', () => {
  zerarCampanhas();
  const id = criarRascunho(vagaAlvo);
  disparo.enfileirarCampanha(id, deps);
  const alvo = uma("SELECT id FROM campanha_envios WHERE email = 'ana@exemplo.com'").id;

  assert.equal(db.registrarTentativaEnvioCampanha(alvo, 'primeiro erro'), 1);
  assert.equal(db.registrarTentativaEnvioCampanha(alvo, 'segundo erro'), 1);

  const linha = linhaDe('ana@exemplo.com');
  assert.equal(linha.status, 'pendente');
  assert.equal(linha.tentativas, 2, 'incrementa, nao sobrescreve');
  assert.equal(linha.erro, 'segundo erro', 'guarda o erro MAIS RECENTE');
});

test('as escritas de tentativa sao condicionais ao pendente', () => {
  zerarCampanhas();
  const id = criarRascunho(vagaAlvo);
  disparo.enfileirarCampanha(id, deps);
  const alvo = uma("SELECT id FROM campanha_envios WHERE email = 'ana@exemplo.com'").id;

  db.marcarEnvioCampanhaEnviado(alvo);
  // Uma linha ja resolvida nao pode ser devolvida para a fila por um ciclo atrasado — e o
  // mesmo contrato das outras marcacoes do projeto.
  assert.equal(db.registrarTentativaEnvioCampanha(alvo, 'erro tardio'), 0);
  assert.equal(db.marcarEnvioCampanhaFalha(alvo, 'erro tardio'), 0);
  assert.equal(linhaDe('ana@exemplo.com').status, 'enviado');
});

test('marcarEnvioCampanhaFalha tambem conta a tentativa que esgotou o teto', () => {
  zerarCampanhas();
  const id = criarRascunho(vagaAlvo);
  disparo.enfileirarCampanha(id, deps);
  const alvo = uma("SELECT id FROM campanha_envios WHERE email = 'carla@exemplo.com'").id;

  db.registrarTentativaEnvioCampanha(alvo, 'erro 1');
  db.marcarEnvioCampanhaFalha(alvo, 'erro final');

  const linha = linhaDe('carla@exemplo.com');
  assert.equal(linha.status, 'falha');
  // 2, e nao 1: o contador precisa refletir quantos e-mails a linha custou de verdade.
  assert.equal(linha.tentativas, 2);
});

test('falha ao ESCREVER a falha nao derruba a leva nem some com a linha', async () => {
  zerarCampanhas();
  const id = criarRascunho(vagaAlvo);
  disparo.enfileirarCampanha(id, deps);

  // Banco recusando a escrita de tentativa. O comportamento seguro e a linha continuar
  // pendente (volta no proximo ciclo) e a leva seguir para os demais.
  const dbQuebrado = {
    ...db,
    registrarTentativaEnvioCampanha() {
      throw new Error('database is locked');
    },
  };
  erroPara = (email) => (email === 'ana@exemplo.com' ? new Error('HTTP 429') : null);

  const { r } = await semRuido(() =>
    disparo.varrerDisparoPromocao({ ...deps, db: dbQuebrado }),
  );

  assert.equal(r.enviados, 2, 'os outros dois nao podem ser afetados');
  assert.equal(r.falhas, 1, 'contabilizado como falha do ciclo: nao houve escrita nenhuma');
  assert.equal(linhaDe('ana@exemplo.com').status, 'pendente', 'a linha sobrevive para o proximo ciclo');
  assert.equal(linhaDe('ana@exemplo.com').tentativas, 0);
});
