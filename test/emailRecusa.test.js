'use strict';

// E-mail automatico de recusa (src/lib/emailRecusa.js + a query em src/db/sqlite.js).
//
// Este e o unico e-mail do sistema que comunica uma decisao NEGATIVA a um terceiro, e nao
// existe "despublicar" um e-mail enviado. As assercoes aqui nao sao sobre formatacao: cada
// uma guarda uma das salvaguardas que impedem alguem de receber uma recusa por engano.
//
// NENHUMA REDE: o provider de e-mail e dublado trocando o metodo `enviar` do modulo em
// cache (lib/emailRecusa chama `email.enviar(...)` como propriedade, entao a troca vale).
// Nos casos em que o modo mock esta ligado, o provider nem chega a ser chamado.
//
// migrar() roda ANTES de qualquer assercao: a coluna email_recusa_enviado_em precisa
// existir de verdade, senao os testes de idempotencia falhariam por "no such column" —
// um falso vermelho que esconderia o que realmente esta sendo verificado.

const os = require('node:os');
const path = require('node:path');

process.env.DATABASE_PATH = path.join(os.tmpdir(), `vm-test-recusa-${process.pid}-${Date.now()}.db`);
process.env.INTERVIEW_MOCK = 'true';
process.env.SESSION_SECRET = 'segredo-de-teste';
process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert/strict');

const db = require('../src/db');
const { migrar } = require('../src/db/migrate');
const { config } = require('../src/config');
const providerEmail = require('../src/providers/email');
const emailRecusa = require('../src/lib/emailRecusa');

migrar(); // a coluna precisa existir antes de qualquer coisa

// ── Provider dublado ──
const enviosFeitos = [];
let falharEnvio = false;

providerEmail.enviar = async (destinatario, assunto, html) => {
  if (falharEnvio) throw new Error('falha simulada do Resend');
  enviosFeitos.push({ destinatario, assunto, html });
  return { id: 'fake-' + enviosFeitos.length };
};

// ── Helpers de cenario ──
const run = (sql, ...p) => Number(db.getDb().prepare(sql).run(...p).lastInsertRowid);
const exec = (sql, ...p) => db.getDb().prepare(sql).run(...p);

const jobId = run(
  "INSERT INTO jobs (slug, titulo, perfil) VALUES ('vaga-recusa', 'Closer de Vendas', 'CLOSER')",
);

let seq = 0;

// Cria um candidato COM entrevista e relatorio, nos estados pedidos. Por padrao monta o
// caso elegivel; cada teste muda so o que precisa.
function criarCaso({
  recomendacao = 'descartar',
  statusIa = 'descartar',
  statusRecrutador = null,
  horasAtras = 10, // relatorio enviado ha 10 h => fora da carencia de 6 h
  jaEnviado = null,
  email = undefined,
  deletedAt = null,
} = {}) {
  seq += 1;
  const appId = run(
    `INSERT INTO applications (job_id, nome, sobrenome, email, status, token, status_ia, status_recrutador, email_recusa_enviado_em, deleted_at)
     VALUES (?, ?, ?, ?, 'concluido', ?, ?, ?, ?, ?)`,
    jobId,
    `Candidato${seq}`,
    'Teste',
    email === undefined ? `candidato${seq}@exemplo.com` : email,
    `tok-recusa-${seq}`,
    statusIa,
    statusRecrutador,
    jaEnviado,
    deletedAt,
  );
  const iid = run(
    "INSERT INTO interviews (application_id, perfil, status) VALUES (?, 'CLOSER', 'concluido')",
    appId,
  );
  run(
    `INSERT INTO reports (interview_id, token, status, recomendacao, enviado_em)
     VALUES (?, ?, 'enviado', ?, datetime('now', ?))`,
    iid,
    `tok-rep-recusa-${seq}`,
    recomendacao,
    `-${horasAtras} hours`,
  );
  return appId;
}

function elegiveis() {
  return db
    .listarPendentesEmailRecusa({ horasCarencia: emailRecusa.HORAS_CARENCIA, limite: 100000 })
    .map((l) => l.id);
}

function marcadoEm(appId) {
  return db.getDb()
    .prepare('SELECT email_recusa_enviado_em FROM applications WHERE id = ?')
    .get(appId).email_recusa_enviado_em;
}

// Tira todo mundo da fila menos os ids pedidos, para um varrer() so processar o cenario
// do teste. Escrita local do teste, nao do codigo sob teste.
function isolarSomente(ids) {
  const lista = Array.isArray(ids) ? ids : [ids];
  exec(
    `UPDATE applications SET email_recusa_enviado_em = datetime('now')
      WHERE email_recusa_enviado_em IS NULL AND id NOT IN (${lista.map(() => '?').join(',')})`,
    ...lista,
  );
}

// Silencia console.log/console.error de um trecho (a varredura loga por candidato).
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

// ──────────────────── elegibilidade ────────────────────

test('elegivel: descartar + status_ia descartar + sem decisao do recrutador + fora da carencia', () => {
  const appId = criarCaso();
  assert.ok(elegiveis().includes(appId), 'deveria estar na fila de recusa');
});

test('NAO elegivel: recrutador marcou "aprovado" (discorda da IA)', () => {
  const appId = criarCaso({ statusRecrutador: 'aprovado' });
  assert.ok(!elegiveis().includes(appId), 'aprovado pelo recrutador nunca recebe recusa');
});

test('NAO elegivel: recrutador marcou "em_analise" (ainda decidindo)', () => {
  const appId = criarCaso({ statusRecrutador: 'em_analise' });
  assert.ok(!elegiveis().includes(appId), 'em analise nunca recebe recusa');
});

test('elegivel: recrutador marcou "reprovado" (concorda com a IA)', () => {
  const appId = criarCaso({ statusRecrutador: 'reprovado' });
  assert.ok(elegiveis().includes(appId), 'reprovado concorda com o descarte; pode receber');
});

test('NAO elegivel: e-mail de recusa ja enviado (idempotencia)', () => {
  const appId = criarCaso({ jaEnviado: '2026-07-30 10:00:00' });
  assert.ok(!elegiveis().includes(appId), 'ninguem recebe a recusa duas vezes');
});

test('NAO elegivel: relatorio ainda dentro da janela de carencia', () => {
  const appId = criarCaso({ horasAtras: 1 }); // carencia e 6 h
  assert.ok(!elegiveis().includes(appId), 'o recrutador ainda tem tempo de intervir');
});

test('NAO elegivel: report diz descartar mas status_ia discorda', () => {
  const semStatus = criarCaso({ statusIa: null });
  const outroStatus = criarCaso({ statusIa: 'talvez' });
  const lista = elegiveis();
  assert.ok(!lista.includes(semStatus), 'status_ia NULL = estado inconsistente, nao envia');
  assert.ok(!lista.includes(outroStatus), 'veredito atual nao e descartar, nao envia');
});

test('NAO elegivel: recomendacao diferente de descartar', () => {
  const talvez = criarCaso({ recomendacao: 'talvez', statusIa: 'talvez' });
  const avancar = criarCaso({ recomendacao: 'avancar', statusIa: 'avancar' });
  const lista = elegiveis();
  assert.ok(!lista.includes(talvez));
  assert.ok(!lista.includes(avancar));
});

test('NAO elegivel: candidatura arquivada ou sem e-mail', () => {
  const arquivado = criarCaso({ deletedAt: '2026-07-30 10:00:00' });
  const semEmail = criarCaso({ email: null });
  const emailVazio = criarCaso({ email: '   ' });
  const lista = elegiveis();
  assert.ok(!lista.includes(arquivado));
  assert.ok(!lista.includes(semEmail));
  assert.ok(!lista.includes(emailVazio));
});

// ──────────────────── varredura ────────────────────

test('toggle desligado: varrer() nao envia nada e devolve desativado', async () => {
  db.definirConfigBool(emailRecusa.CHAVE_ATIVO, false);
  const appId = criarCaso();
  const antes = enviosFeitos.length;

  const r = await semRuido(() => emailRecusa.varrer());

  assert.equal(r.desativado, true);
  assert.equal(r.enviados, 0);
  assert.equal(enviosFeitos.length, antes, 'nenhum e-mail com o interruptor desligado');
  assert.equal(marcadoEm(appId), null, 'nao pode marcar quem nao recebeu');
});

test('falha no envio: NAO marca a coluna e o candidato continua elegivel', async () => {
  db.definirConfigBool(emailRecusa.CHAVE_ATIVO, true);
  config.entrevista.mock = false; // faz a varredura chamar o provider (dublado)
  falharEnvio = true;

  const appId = criarCaso();
  isolarSomente(appId);

  const r = await semRuido(() => emailRecusa.varrer());

  assert.equal(r.enviados, 0);
  assert.equal(r.falhas, 1);
  assert.equal(marcadoEm(appId), null, 'falha de envio nao pode marcar a coluna');
  assert.ok(elegiveis().includes(appId), 'deve voltar a aparecer no proximo ciclo');

  falharEnvio = false;
  config.entrevista.mock = true;
});

test('envio bem-sucedido: marca a coluna e sai da fila', async () => {
  db.definirConfigBool(emailRecusa.CHAVE_ATIVO, true);
  config.entrevista.mock = false;

  const appId = criarCaso();
  isolarSomente(appId);
  const antes = enviosFeitos.length;

  const r = await semRuido(() => emailRecusa.varrer());

  assert.equal(r.enviados, 1);
  assert.equal(r.falhas, 0);
  assert.equal(enviosFeitos.length, antes + 1);
  assert.ok(marcadoEm(appId), 'sucesso marca a coluna');
  assert.ok(!elegiveis().includes(appId), 'sai da fila para sempre');

  const enviado = enviosFeitos[enviosFeitos.length - 1];
  assert.match(enviado.assunto, /^Atualização sobre sua candidatura — /);
  assert.ok(!/recusa|nao selecionado|não selecionado|reprovad/i.test(enviado.assunto),
    'o assunto nao entrega o desfecho na caixa de entrada');

  config.entrevista.mock = true;
});

test('teto por ciclo: varrer() processa no maximo ENVIOS_POR_CICLO numa passada', async () => {
  db.definirConfigBool(emailRecusa.CHAVE_ATIVO, true);
  config.entrevista.mock = true; // sem provider; so contamos o processamento

  const excedente = 2;
  const criados = [];
  for (let i = 0; i < emailRecusa.ENVIOS_POR_CICLO + excedente; i++) criados.push(criarCaso());
  isolarSomente(criados);

  const primeira = await semRuido(() => emailRecusa.varrer());
  assert.equal(primeira.enviados, emailRecusa.ENVIOS_POR_CICLO, 'o teto tem que ser respeitado');

  // O backlog nao se perde: o ciclo seguinte pega o resto.
  const segunda = await semRuido(() => emailRecusa.varrer());
  assert.equal(segunda.enviados, excedente, 'o excedente drena no ciclo seguinte');

  const terceira = await semRuido(() => emailRecusa.varrer());
  assert.equal(terceira.enviados, 0, 'nada sobra depois de drenar');
});

// ──────────────────── conteudo do e-mail ────────────────────

test('o HTML nao revela avaliacao, nota nem o uso de IA', () => {
  const html = emailRecusa.montarEmailRecusa({
    nome: 'Larissa Oliveira',
    tituloVaga: 'Closer de Vendas',
  });

  // \bIA\b e nao /IA/i: a busca ingenua casaria com "Arial" da pilha de fontes.
  assert.ok(!/\bIA\b/.test(html), 'nao pode mencionar IA');
  for (const proibido of [
    'inteligência', 'inteligencia',
    'pontuação', 'pontuacao',
    'competência', 'competencia',
    'avaliação', 'avaliacao',
    'nota',
    'relatório', 'relatorio',
    'descartar', 'descarte',
  ]) {
    assert.ok(
      !new RegExp(proibido, 'i').test(html),
      `o e-mail ao candidato nao pode conter "${proibido}"`,
    );
  }
});

test('o HTML escapa os dados do candidato e da vaga', () => {
  const html = emailRecusa.montarEmailRecusa({
    nome: '<script>alerta()</script>',
    tituloVaga: 'Closer <b>X</b> & Cia',
  });
  assert.ok(!html.includes('<script>'), 'nome nao pode injetar HTML');
  assert.ok(html.includes('&amp;'), 'a vaga precisa estar escapada');
});

test('o HTML usa so o primeiro nome e sobrevive a nome ausente', () => {
  const comNome = emailRecusa.montarEmailRecusa({ nome: 'Larissa Oliveira Rodrigues', tituloVaga: 'V' });
  assert.ok(comNome.includes('Olá, Larissa,'), 'so o primeiro nome');

  const semNome = emailRecusa.montarEmailRecusa({ nome: null, tituloVaga: 'V' });
  assert.ok(semNome.includes('Olá,'), 'sem nome ainda cumprimenta');
  assert.ok(!semNome.includes('undefined') && !semNome.includes('null'));
});
