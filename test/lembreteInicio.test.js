'use strict';

// Lembrete de INICIO de entrevista (src/lib/lembreteInicio.js + a query em sqlite.js).
//
// O publico deste e-mail sao ~173 pessoas que se candidataram e nunca abriram a
// entrevista. Errar o filtro aqui significa escrever para quem NAO deveria receber — quem
// ja esta no meio da entrevista, quem ja terminou, quem foi arquivado — e nao existe
// "despublicar" um e-mail enviado. Cada assercao abaixo guarda uma dessas fronteiras.
//
// NENHUMA REDE: o provider de e-mail e dublado trocando o metodo `enviar` do modulo em
// cache (lib/lembreteInicio chama `email.enviar(...)` como propriedade, entao a troca
// vale). Nos casos em modo mock, o provider nem chega a ser chamado.
//
// migrar() roda ANTES de qualquer assercao: a coluna lembrete_inicio_enviado_em precisa
// existir de verdade, senao os testes de idempotencia falhariam por "no such column" —
// um falso vermelho que esconderia o que esta sendo verificado.

const os = require('node:os');
const path = require('node:path');

process.env.DATABASE_PATH = path.join(os.tmpdir(), `vm-test-lembrete-${process.pid}-${Date.now()}.db`);
process.env.INTERVIEW_MOCK = 'true';
process.env.SESSION_SECRET = 'segredo-de-teste';
process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert/strict');

const db = require('../src/db');
const { migrar } = require('../src/db/migrate');
const { config } = require('../src/config');
const providerEmail = require('../src/providers/email');
const lembrete = require('../src/lib/lembreteInicio');

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

const vagaAtiva = run(
  "INSERT INTO jobs (slug, titulo, perfil, entrevista_ativa) VALUES ('vaga-lembrete', 'Closer de Vendas', 'CLOSER', 1)",
);
const vagaSimples = run(
  "INSERT INTO jobs (slug, titulo, perfil, entrevista_ativa) VALUES ('vaga-simples', 'Vaga Simples', 'CLOSER', 0)",
);

let seq = 0;

// Cria um candidato nos estados pedidos. Por padrao monta o caso ELEGIVEL (aplicado, sem
// entrevista, criado ha 10 h, vaga com entrevista ativa); cada teste muda so o que precisa.
function criarCaso({
  status = 'aplicado',
  horasAtras = 10, // criado ha 10 h => fora da espera de 3 h
  jaEnviado = null,
  email = undefined,
  deletedAt = null,
  job = vagaAtiva,
  comEntrevista = false,
} = {}) {
  seq += 1;
  const appId = run(
    `INSERT INTO applications (job_id, nome, sobrenome, email, status, token, criado_em, deleted_at, lembrete_inicio_enviado_em)
     VALUES (?, ?, ?, ?, ?, ?, datetime('now', ?), ?, ?)`,
    job,
    `Candidato${seq}`,
    'Teste',
    email === undefined ? `candidato${seq}@exemplo.com` : email,
    status,
    `tok-lembrete-${seq}`,
    `-${horasAtras} hours`,
    deletedAt,
    jaEnviado,
  );
  if (comEntrevista) {
    run("INSERT INTO interviews (application_id, perfil, status) VALUES (?, 'CLOSER', 'iniciada')", appId);
  }
  return appId;
}

function elegiveis() {
  return db
    .listarPendentesLembreteInicio({ horasEspera: lembrete.HORAS_ESPERA_LEMBRETE, limite: 100000 })
    .map((l) => l.id);
}

function marcadoEm(appId) {
  return db.getDb()
    .prepare('SELECT lembrete_inicio_enviado_em FROM applications WHERE id = ?')
    .get(appId).lembrete_inicio_enviado_em;
}

// Tira todo mundo da fila menos os ids pedidos, para um varrer() so processar o cenario
// do teste. Escrita local do teste, nao do codigo sob teste.
function isolarSomente(ids) {
  const lista = Array.isArray(ids) ? ids : [ids];
  exec(
    `UPDATE applications SET lembrete_inicio_enviado_em = datetime('now')
      WHERE lembrete_inicio_enviado_em IS NULL AND id NOT IN (${lista.map(() => '?').join(',')})`,
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

test('elegivel: aplicado, sem entrevista, fora da janela de espera', () => {
  const appId = criarCaso();
  assert.ok(elegiveis().includes(appId), 'deveria estar na fila do lembrete');
});

test('NAO elegivel: candidatura recente, ainda dentro da janela de espera', () => {
  const appId = criarCaso({ horasAtras: 1 }); // espera e 3 h
  assert.ok(!elegiveis().includes(appId), 'quem acabou de se candidatar ainda pode entrar sozinho');
});

test('NAO elegivel: ja tem entrevista criada (o publico do follow-up, nao deste)', () => {
  const appId = criarCaso({ comEntrevista: true });
  assert.ok(!elegiveis().includes(appId), 'quem comecou a entrevista nao recebe lembrete de inicio');
});

test('NAO elegivel: status em_entrevista ou concluido', () => {
  const emEntrevista = criarCaso({ status: 'em_entrevista' });
  const concluido = criarCaso({ status: 'concluido' });
  const lista = elegiveis();
  assert.ok(!lista.includes(emEntrevista));
  assert.ok(!lista.includes(concluido));
});

test('NAO elegivel: lembrete ja enviado (idempotencia)', () => {
  const appId = criarCaso({ jaEnviado: '2026-07-30 10:00:00' });
  assert.ok(!elegiveis().includes(appId), 'ninguem recebe o lembrete duas vezes');
});

test('NAO elegivel: candidatura arquivada', () => {
  const appId = criarCaso({ deletedAt: '2026-07-30 10:00:00' });
  assert.ok(!elegiveis().includes(appId));
});

test('NAO elegivel: sem e-mail ou e-mail em branco', () => {
  const semEmail = criarCaso({ email: null });
  const emailVazio = criarCaso({ email: '   ' });
  const lista = elegiveis();
  assert.ok(!lista.includes(semEmail));
  assert.ok(!lista.includes(emailVazio));
});

test('NAO elegivel: vaga em modo Simples (entrevista_ativa = 0)', () => {
  const appId = criarCaso({ job: vagaSimples });
  assert.ok(!elegiveis().includes(appId), 'vaga sem entrevista nao manda ninguem para a entrevista');
});

// ──────────────────── dedupe por e-mail ────────────────────
// A idempotencia e por application, mas o e-mail chega numa PESSOA: a mesma pessoa se
// candidatando duas vezes receberia dois lembretes iguais sem este dedupe.

test('dedupe: duas candidaturas do mesmo e-mail -> so a mais recente e elegivel', () => {
  const email = 'duplicada@exemplo.com';
  const antiga = criarCaso({ email, horasAtras: 20 });
  const recente = criarCaso({ email, horasAtras: 10 });

  const lista = elegiveis();
  assert.ok(lista.includes(recente), 'a mais recente (MAX id) e a que recebe');
  assert.ok(!lista.includes(antiga), 'a antiga nao pode gerar um segundo lembrete');
});

test('dedupe: ignora diferenca de caixa e espaco no e-mail', () => {
  const antiga = criarCaso({ email: 'MesmaPessoa@Exemplo.com ', horasAtras: 20 });
  const recente = criarCaso({ email: '  mesmapessoa@exemplo.COM', horasAtras: 10 });

  const lista = elegiveis();
  assert.ok(lista.includes(recente));
  assert.ok(!lista.includes(antiga), 'caixa/espaco nao pode furar o dedupe');
});

test('dedupe (borda): se a MAIS RECENTE ja comecou a entrevista, a antiga NAO recebe', () => {
  const email = 'ja-comecou@exemplo.com';
  const antiga = criarCaso({ email, horasAtras: 20 });
  // A mais recente entrou na entrevista: status muda e existe linha em interviews.
  criarCaso({ email, horasAtras: 10, status: 'em_entrevista', comEntrevista: true });

  assert.ok(
    !elegiveis().includes(antiga),
    'a pessoa ja entrou por outra candidatura; lembrar pela antiga seria errado',
  );
});

test('dedupe (borda): candidatura arquivada nao bloqueia o lembrete de uma ativa', () => {
  const email = 'com-arquivada@exemplo.com';
  const ativa = criarCaso({ email, horasAtras: 20 });
  criarCaso({ email, horasAtras: 10, deletedAt: '2026-07-30 10:00:00' });

  assert.ok(
    elegiveis().includes(ativa),
    'arquivar uma candidatura nao pode silenciar a outra do mesmo e-mail',
  );
});

test('dedupe: e-mails diferentes seguem independentes', () => {
  const a = criarCaso({ email: 'pessoa-a@exemplo.com' });
  const b = criarCaso({ email: 'pessoa-b@exemplo.com' });
  const lista = elegiveis();
  assert.ok(lista.includes(a) && lista.includes(b), 'dedupe nao pode agrupar pessoas distintas');
});

test('horasEspera invalida devolve lista vazia (degradacao segura)', () => {
  criarCaso();
  assert.equal(db.listarPendentesLembreteInicio({ horasEspera: 0, limite: 100 }).length, 0);
  assert.equal(db.listarPendentesLembreteInicio({ horasEspera: -5, limite: 100 }).length, 0);
  assert.equal(db.listarPendentesLembreteInicio({ horasEspera: 'abc', limite: 100 }).length, 0);
  // Sanidade: com valor valido a lista NAO e vazia — senao o teste acima passaria a toa.
  assert.ok(db.listarPendentesLembreteInicio({ horasEspera: 3, limite: 100 }).length > 0);
});

// ──────────────────── varredura ────────────────────

test('toggle desligado: varrer() nao envia nada e devolve desativado', async () => {
  db.definirConfigBool(lembrete.CHAVE_ATIVO, false);
  const appId = criarCaso();
  const antes = enviosFeitos.length;

  const r = await semRuido(() => lembrete.varrer());

  assert.equal(r.desativado, true);
  assert.equal(r.enviados, 0);
  assert.equal(enviosFeitos.length, antes, 'nenhum e-mail com o interruptor desligado');
  assert.equal(marcadoEm(appId), null, 'nao pode marcar quem nao recebeu');
});

test('modo mock: marca sem tocar o provider', async () => {
  db.definirConfigBool(lembrete.CHAVE_ATIVO, true);
  config.entrevista.mock = true;

  const appId = criarCaso();
  isolarSomente(appId);
  const antes = enviosFeitos.length;

  const r = await semRuido(() => lembrete.varrer());

  assert.equal(r.enviados, 1);
  assert.equal(enviosFeitos.length, antes, 'mock NAO pode chamar o Resend');
  assert.ok(marcadoEm(appId), 'em mock tambem marca, senao a varredura relogaria sempre');
});

test('falha no envio: NAO marca a coluna e o candidato continua elegivel', async () => {
  db.definirConfigBool(lembrete.CHAVE_ATIVO, true);
  config.entrevista.mock = false; // faz a varredura chamar o provider (dublado)
  falharEnvio = true;

  const appId = criarCaso();
  isolarSomente(appId);

  const r = await semRuido(() => lembrete.varrer());

  assert.equal(r.enviados, 0);
  assert.equal(r.falhas, 1);
  assert.equal(marcadoEm(appId), null, 'falha de envio nao pode marcar a coluna');
  assert.ok(elegiveis().includes(appId), 'deve voltar a aparecer no proximo ciclo');

  falharEnvio = false;
  config.entrevista.mock = true;
});

test('envio bem-sucedido: marca a coluna, sai da fila e usa o link de retomada', async () => {
  db.definirConfigBool(lembrete.CHAVE_ATIVO, true);
  config.entrevista.mock = false;

  const appId = criarCaso();
  isolarSomente(appId);
  const antes = enviosFeitos.length;

  const r = await semRuido(() => lembrete.varrer());

  assert.equal(r.enviados, 1);
  assert.equal(r.falhas, 0);
  assert.equal(enviosFeitos.length, antes + 1);
  assert.ok(marcadoEm(appId), 'sucesso marca a coluna');
  assert.ok(!elegiveis().includes(appId), 'sai da fila para sempre');

  const enviado = enviosFeitos[enviosFeitos.length - 1];
  assert.match(enviado.html, /\/retomar\?token=/, 'o e-mail precisa levar o link de retomada');
  assert.match(enviado.html, new RegExp(`tok-lembrete-`), 'com o token do proprio candidato');
  assert.match(enviado.assunto, /ainda está em aberto$/);

  config.entrevista.mock = true;
});

test('teto por ciclo: varrer() processa no maximo ENVIOS_POR_CICLO numa passada', async () => {
  db.definirConfigBool(lembrete.CHAVE_ATIVO, true);
  config.entrevista.mock = true;

  const excedente = 3;
  const criados = [];
  for (let i = 0; i < lembrete.ENVIOS_POR_CICLO + excedente; i++) criados.push(criarCaso());
  isolarSomente(criados);

  const primeira = await semRuido(() => lembrete.varrer());
  assert.equal(primeira.enviados, lembrete.ENVIOS_POR_CICLO, 'o teto tem que ser respeitado');

  // O backlog nao se perde: o ciclo seguinte pega o resto.
  const segunda = await semRuido(() => lembrete.varrer());
  assert.equal(segunda.enviados, excedente, 'o excedente drena no ciclo seguinte');

  const terceira = await semRuido(() => lembrete.varrer());
  assert.equal(terceira.enviados, 0, 'nada sobra depois de drenar');
});

test('trava de concorrencia: ciclos sobrepostos nao processam duas vezes', async () => {
  db.definirConfigBool(lembrete.CHAVE_ATIVO, true);
  config.entrevista.mock = true;

  const criados = [criarCaso(), criarCaso(), criarCaso()];
  isolarSomente(criados);

  const [r1, r2] = await semRuido(() =>
    Promise.all([lembrete.varrerSeOcioso(), lembrete.varrerSeOcioso()]),
  );

  assert.equal(r1.enviados, 3, 'a primeira varredura processa tudo');
  assert.equal(r2, null, 'a segunda, sobreposta, e descartada (nao enfileirada)');
});

// ──────────────────── conteudo do e-mail ────────────────────

test('o e-mail nao menciona avaliacao, nota nem IA', () => {
  const html = lembrete.montarEmailLembrete({
    nome: 'Larissa Oliveira',
    tituloVaga: 'Closer de Vendas',
    link: 'https://exemplo.com/retomar?token=abc',
  });

  // \bIA\b e nao /IA/i: a busca ingenua casaria com "Arial" da pilha de fontes.
  assert.ok(!/\bIA\b/.test(html), 'nao pode mencionar IA');
  for (const proibido of [
    'inteligência', 'inteligencia',
    'pontuação', 'pontuacao',
    'competência', 'competencia',
    'avaliação', 'avaliacao', 'avaliad',
    'nota',
    'descartar', 'descarte', 'recusa',
  ]) {
    assert.ok(
      !new RegExp(proibido, 'i').test(html),
      `o lembrete nao pode conter "${proibido}" — o candidato ainda nem foi avaliado`,
    );
  }
});

test('o e-mail NAO chama a entrevista de etapa final', () => {
  const html = lembrete.montarEmailLembrete({ nome: 'X', tituloVaga: 'V', link: 'https://e/r?token=t' });
  const assunto = lembrete.assuntoLembrete('V');

  assert.ok(!/etapa final|última etapa|ultima etapa/i.test(html), 'a entrevista e a SEGUNDA etapa');
  assert.ok(!/falta só uma etapa|falta so uma etapa/i.test(html));
  assert.ok(!/concluir sua candidatura|conclus/i.test(assunto), 'o assunto nao promete conclusao');
  assert.match(html, /segunda etapa/i, 'precisa dizer explicitamente que e a segunda etapa');
});

test('o e-mail nao promete duracao em minutos especifica', () => {
  const html = lembrete.montarEmailLembrete({ nome: 'X', tituloVaga: 'V', link: 'https://e/r?token=t' });
  assert.ok(!/\d+\s*minutos/i.test(html), 'sem numero de minutos — o roteiro pode mudar');
  assert.match(html, /poucos minutos/i);
});

test('o e-mail escapa os dados do candidato e da vaga', () => {
  const html = lembrete.montarEmailLembrete({
    nome: '<script>alerta()</script>',
    tituloVaga: 'Closer <b>X</b> & Cia',
    link: 'https://e/r?token=t',
  });
  assert.ok(!html.includes('<script>'), 'nome nao pode injetar HTML');
  assert.ok(html.includes('&amp;'), 'a vaga precisa estar escapada');
});

test('o e-mail usa so o primeiro nome e sobrevive a nome ausente', () => {
  const comNome = lembrete.montarEmailLembrete({
    nome: 'Larissa Oliveira Rodrigues', tituloVaga: 'V', link: 'https://e/r?token=t',
  });
  assert.ok(comNome.includes('Olá, Larissa!'), 'so o primeiro nome');

  const semNome = lembrete.montarEmailLembrete({ nome: null, tituloVaga: 'V', link: 'https://e/r?token=t' });
  assert.ok(semNome.includes('Olá!'), 'sem nome ainda cumprimenta');
  assert.ok(!semNome.includes('undefined') && !semNome.includes('null'));
});
