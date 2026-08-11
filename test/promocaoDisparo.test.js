'use strict';

// Disparo da Promocao de Vagas (src/lib/dispararPromocao.js + a fila em sqlite.js + a
// rota POST /admin/promocao/:id/disparar).
//
// O QUE ESTA EM JOGO: este e o unico caminho do projeto que faz e-mail sair em MASSA para
// gente que nao esta num processo conosco. Um erro aqui nao aparece como excecao — aparece
// como centenas de mensagens entregues a quem nao devia recebe-las, e nao existe
// despublicar e-mail enviado. As assercoes abaixo guardam, uma a uma, as travas que
// impedem isso: o interruptor, o teto por ciclo, o congelamento do publico, a idempotencia
// no banco e a confirmacao humana antes do disparo.
//
// ZERO REDE. O adaptador de e-mail de campanha e SEMPRE injetado como dublê (deps.
// emailCampanha) — nenhum teste daqui chega perto de providers/emailCampanha/smtp.js.
// Isso e mais forte que trocar o metodo do modulo em cache (o padrao de
// lembreteInicio.test.js): aqui o modulo real nem e carregado pelo caminho sob teste.
//
// migrar() roda ANTES de qualquer assercao: campanha_envios e as colunas de status
// precisam existir de verdade, senao os testes de idempotencia falhariam por "no such
// table" — um falso vermelho que esconderia o que esta sendo verificado.

const os = require('node:os');
const path = require('node:path');

process.env.DATABASE_PATH = path.join(os.tmpdir(), `vm-test-promocao-disparo-${process.pid}-${Date.now()}.db`);
process.env.INTERVIEW_MOCK = 'true';
process.env.SESSION_SECRET = 'segredo-de-teste';
process.env.ADMIN_USER = 'admin-teste';
process.env.ADMIN_PASSWORD = 'senha-teste';
// Pre-condicoes de disparo PRESENTES por padrao: o caminho feliz exige um ambiente capaz
// de enviar campanha. Os testes que exercitam a FALTA delas esvaziam a config em runtime,
// no escopo deles (mesmo padrao de comConfigCampanha em emailCampanha.test.js).
// Nada disso abre conexao: sao strings lidas da config, e o adaptador real nunca e usado.
process.env.DESCADASTRO_SECRET = 'segredo-de-descadastro-de-teste';
process.env.APP_BASE_URL = 'https://entrevista.exemplo.com.br';
process.env.SMTP_CAMPANHA_HOST = 'smtp.exemplo-provedor.com';
process.env.SMTP_CAMPANHA_USUARIO = 'usuario-de-teste';
process.env.SMTP_CAMPANHA_SENHA = 'senha-de-teste';
process.env.SMTP_CAMPANHA_FROM_EMAIL = 'vagas@vagas.exemplo.com.br';
// Credencial do transporte ATIVO (API REST — o Railway bloqueia SMTP). O pre-voo pergunta
// ao transporte selecionado o que falta, entao sem esta chave o caminho feliz seria barrado
// antes de chegar em qualquer assercao sobre a fila. As SMTP_CAMPANHA_* acima ficam porque
// continuam sendo o que o transporte legado exige, e um teste abaixo troca o transporte.
process.env.EMAILIT_API_KEY = 'em_chave-de-teste';
process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert/strict');

const db = require('../src/db');
const { migrar } = require('../src/db/migrate');
const { config } = require('../src/config');
const { criarApp } = require('../src/server');
const { listarPublicoCampanha } = require('../src/lib/promocaoVagas');
const disparo = require('../src/lib/dispararPromocao');

migrar();

// ── Dublê do adaptador de e-mail de campanha ──
// Guarda os ARGUMENTOS INTEIROS de cada chamada (e nao so o destinatario): um dos testes
// verifica justamente que a rotina NAO passa um quarto argumento de opcoes/headers.
const enviosFeitos = [];
let falharPara = new Set();

const emailCampanhaDuble = {
  async enviar(...args) {
    const [destinatario] = args;
    if (falharPara.has(destinatario)) throw new Error(`falha simulada para ${destinatario}`);
    enviosFeitos.push(args);
    return { id: `fake-${enviosFeitos.length}` };
  },
};

const deps = { db, emailCampanha: emailCampanhaDuble };

// ── Helpers de cenario ──
const run = (sql, ...p) => Number(db.getDb().prepare(sql).run(...p).lastInsertRowid);
const exec = (sql, ...p) => db.getDb().prepare(sql).run(...p);
const uma = (sql, ...p) => db.getDb().prepare(sql).get(...p);

let seq = 0;

function criarVaga(titulo, perfil = 'CLOSER') {
  seq += 1;
  return run(
    'INSERT INTO jobs (slug, titulo, perfil, ativo) VALUES (?, ?, ?, 1)',
    `vaga-disparo-${seq}`,
    titulo,
    perfil,
  );
}

function criarCandidatura(jobId, email) {
  seq += 1;
  return run(
    "INSERT INTO applications (job_id, nome, sobrenome, email, token) VALUES (?, 'Fulano', 'Teste', ?, ?)",
    jobId,
    email,
    `tok-disparo-${seq}`,
  );
}

// Cria a campanha ja em rascunho, com o total congelado do publico do momento.
function criarRascunho(jobIdAlvo, assunto = 'Vaga aberta') {
  const criterios = { jobIdAlvo };
  return db.criarCampanha({
    job_id: jobIdAlvo,
    assunto,
    corpo_html: '<p>Temos uma vaga.</p>',
    criterios,
    total_destinatarios: listarPublicoCampanha(criterios).total,
  });
}

// Estado limpo entre cenarios. O teto por ciclo e GLOBAL (soma todas as campanhas em
// andamento), entao uma fila remanescente de um teste anterior mudaria o resultado do
// seguinte. Escrita local do teste, nao do codigo sob teste.
function zerarCampanhas() {
  exec('DELETE FROM campanha_envios');
  exec('DELETE FROM campanhas');
}

function contar(campanhaId) {
  return db.contarEnviosCampanha(campanhaId);
}

function statusCampanha(id) {
  return uma('SELECT status FROM campanhas WHERE id = ?', id).status;
}

// Silencia console.log/console.error de um trecho (a varredura loga por envio).
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

// Versao SINCRONA. enfileirarCampanha nao e async, e envolve-la na versao acima devolveria
// uma Promise — o resultado viraria `undefined` em toda assercao sobre `.ok`.
function semRuidoSync(fn) {
  const log = console.log;
  const err = console.error;
  console.log = () => {};
  console.error = () => {};
  try {
    return fn();
  } finally {
    console.log = log;
    console.error = err;
  }
}

// Roda `fn` com o DESCADASTRO_SECRET ausente, restaurando no fim aconteca o que
// acontecer. A config e lida a cada chamada (lib/descadastro.segredo()), entao esvaziar o
// objeto e suficiente — nao precisa recarregar modulo.
// `await fn()` e nao `return fn()`: os testes de rota sao assincronos, e restaurar a
// config antes do fetch terminar devolveria o ambiente ao normal no meio da requisicao —
// o teste passaria sem ter exercitado nada.
async function semSegredoDescadastro(fn) {
  const original = config.descadastro.segredo;
  config.descadastro.segredo = '';
  try {
    return await fn();
  } finally {
    config.descadastro.segredo = original;
  }
}

// Idem para as credenciais de envio de campanha (molde de comConfigCampanha,
// emailCampanha.test.js).
//
// Esvazia a credencial do transporte ATIVO, e nao um conjunto fixo de campos: o pre-voo
// pergunta ao transporte selecionado o que falta (a fachada roteia credenciaisFaltando
// junto com enviar), entao zerar `host`/`usuario`/`senha` com a API ativa nao bloquearia
// nada — o teste passaria a provar o oposto do que afirma.
async function semCredenciaisEnvio(fn) {
  const cfg = config.provedores.emailCampanha;
  const original = { ...cfg };
  Object.assign(cfg, { apiKey: '', host: '', usuario: '', senha: '' });
  try {
    return await fn();
  } finally {
    Object.assign(cfg, original);
  }
}

// ── Cenario base ──
const vagaAlvo = criarVaga('Vaga Alvo do Disparo');
const vagaOutra = criarVaga('Outra Vaga');
for (let i = 1; i <= 4; i += 1) criarCandidatura(vagaOutra, `base${i}@exemplo.com`);
// Este ja se candidatou a vaga ALVO: exclusao automatica do motor de publico.
criarCandidatura(vagaAlvo, 'ja-inscrito@exemplo.com');

// ════════════════════════ A. enfileirarCampanha ════════════════════════

test('enfileirarCampanha materializa uma linha por destinatario, todas pendentes', () => {
  zerarCampanhas();
  const id = criarRascunho(vagaAlvo);
  const esperado = listarPublicoCampanha({ jobIdAlvo: vagaAlvo });

  const r = disparo.enfileirarCampanha(id, deps);

  assert.equal(r.ok, true);
  assert.equal(r.enfileirados, esperado.total);
  assert.ok(esperado.total > 0, 'sanidade: o cenario precisa ter publico');

  const c = contar(id);
  assert.equal(c.total, esperado.total);
  assert.equal(c.pendente, esperado.total, 'toda linha nasce pendente');
  assert.equal(c.enviado, 0);
  assert.equal(c.falha, 0);

  assert.equal(statusCampanha(id), 'enfileirada');
  assert.ok(uma('SELECT enfileirada_em FROM campanhas WHERE id = ?', id).enfileirada_em);

  // Os e-mails materializados sao exatamente os do motor de publico, ja normalizados.
  const gravados = db
    .getDb()
    .prepare('SELECT email FROM campanha_envios WHERE campanha_id = ? ORDER BY email')
    .all(id)
    .map((l) => l.email);
  assert.deepEqual(gravados, esperado.itens.map((i) => i.email).sort());
  assert.ok(!gravados.includes('ja-inscrito@exemplo.com'), 'exclusao automatica precisa valer aqui tambem');
});

test('enfileirarCampanha recusa campanha que NAO esta em rascunho', () => {
  zerarCampanhas();
  const id = criarRascunho(vagaAlvo);
  assert.equal(disparo.enfileirarCampanha(id, deps).ok, true);

  const segunda = semRuidoSync(() => disparo.enfileirarCampanha(id, deps));
  assert.equal(segunda.ok, false);
  assert.equal(segunda.erroCodigo, 'STATUS_INVALIDO');
  assert.match(segunda.mensagem, /rascunho/i);

  // E os demais status tambem: concluida e cancelada nao voltam para a fila.
  for (const status of ['enviando', 'concluida', 'cancelada']) {
    exec('UPDATE campanhas SET status = ? WHERE id = ?', status, id);
    const r = disparo.enfileirarCampanha(id, deps);
    assert.equal(r.ok, false, `${status} nao pode ser re-enfileirada`);
    assert.equal(r.erroCodigo, 'STATUS_INVALIDO');
  }
});

test('enfileirarCampanha usa o publico FRESCO, nao o total congelado na criacao', () => {
  zerarCampanhas();
  const id = criarRascunho(vagaAlvo);
  const congelado = uma('SELECT total_destinatarios FROM campanhas WHERE id = ?', id).total_destinatarios;

  // O publico MUDA entre criar o rascunho e disparar: entram DOIS e sai um por opt-out.
  // Dois entrando e um saindo (e nao um-por-um) para o TOTAL tambem mudar — com o total
  // igual, a assercao passaria mesmo se a rotina tivesse usado a lista velha.
  criarCandidatura(vagaOutra, 'entrou-depois@exemplo.com');
  criarCandidatura(vagaOutra, 'entrou-depois-2@exemplo.com');
  db.registrarDescadastro('base1@exemplo.com', 'manual');

  const agora = listarPublicoCampanha({ jobIdAlvo: vagaAlvo });
  assert.notEqual(agora.total, congelado, 'sanidade: o publico precisa ter mudado de verdade');

  const r = disparo.enfileirarCampanha(id, deps);
  assert.equal(r.enfileirados, agora.total, 'o materializado tem que ser o publico de AGORA');

  const emails = db
    .getDb()
    .prepare('SELECT email FROM campanha_envios WHERE campanha_id = ?')
    .all(id)
    .map((l) => l.email);
  assert.ok(emails.includes('entrou-depois@exemplo.com'), 'quem entrou depois precisa receber');
  assert.ok(!emails.includes('base1@exemplo.com'), 'quem se descadastrou NAO pode receber');

  // O total gravado passa a ser o congelado do disparo — o denominador do progresso.
  assert.equal(
    uma('SELECT total_destinatarios FROM campanhas WHERE id = ?', id).total_destinatarios,
    agora.total,
  );
});

test('UNIQUE(campanha_id, email) barra a materializacao duplicada no NIVEL DO BANCO', () => {
  zerarCampanhas();
  const id = criarRascunho(vagaAlvo);
  assert.equal(disparo.enfileirarCampanha(id, deps).ok, true);
  const antes = contar(id).total;

  // 1a camada furada de proposito: forcamos o status de volta a 'rascunho', como se o
  // guard da aplicacao tivesse falhado. A 2a camada (linhas preexistentes) segura.
  exec("UPDATE campanhas SET status = 'rascunho' WHERE id = ?", id);
  const r = semRuidoSync(() => disparo.enfileirarCampanha(id, deps));
  assert.equal(r.ok, false);
  assert.equal(r.erroCodigo, 'ENVIOS_PREEXISTENTES');
  assert.equal(contar(id).total, antes, 'a recusa nao pode ter gravado nada');

  // 2a camada furada tambem: INSERT direto, por baixo de todo o codigo da aplicacao.
  // O banco precisa barrar sozinho — e a unica garantia que sobrevive a um bug futuro.
  const emailExistente = uma('SELECT email FROM campanha_envios WHERE campanha_id = ?', id).email;
  assert.throws(
    () =>
      exec(
        "INSERT INTO campanha_envios (campanha_id, email, origem_tipo) VALUES (?, ?, 'application')",
        id,
        emailExistente,
      ),
    /UNIQUE/i,
    'a mesma pessoa nao pode ter duas linhas na mesma campanha',
  );
  assert.equal(contar(id).total, antes);
});

// ════════════════════════ B. varrerDisparoPromocao ════════════════════════

test('kill-switch desligado: a varredura nao toca no banco nem envia', async () => {
  zerarCampanhas();
  db.definirConfigBool(disparo.CHAVE_ATIVO, false);

  const id = criarRascunho(vagaAlvo);
  disparo.enfileirarCampanha(id, deps);
  const antesEnvios = enviosFeitos.length;

  // db ESPIAO: so obterConfigBool e permitido. Qualquer outro acesso a dados durante o
  // ciclo desligado quebra o teste — a promessa nao e "nao envia", e "nao toca no banco".
  const permitidas = new Set(['obterConfigBool']);
  const tocadas = [];
  const dbEspiao = new Proxy(db, {
    get(alvo, prop) {
      if (typeof alvo[prop] === 'function' && !permitidas.has(prop)) {
        tocadas.push(prop);
        return () => {
          throw new Error(`a varredura desligada nao pode chamar db.${String(prop)}`);
        };
      }
      return alvo[prop];
    },
  });

  const r = await semRuido(() =>
    disparo.varrerDisparoPromocao({ db: dbEspiao, emailCampanha: emailCampanhaDuble }),
  );

  assert.equal(r.desativado, true);
  assert.equal(r.enviados, 0);
  assert.equal(r.falhas, 0);
  assert.deepEqual(tocadas, [], 'nenhuma funcao de dados pode ter sido chamada');
  assert.equal(enviosFeitos.length, antesEnvios, 'nenhum e-mail com o interruptor desligado');

  // E o estado da campanha continua exatamente onde estava.
  assert.equal(statusCampanha(id), 'enfileirada');
  assert.equal(contar(id).pendente, contar(id).total);
});

test('modo mock: NAO chama o adaptador, mas marca os envios como processados', async () => {
  zerarCampanhas();
  db.definirConfigBool(disparo.CHAVE_ATIVO, true);
  config.entrevista.mock = true;

  const id = criarRascunho(vagaAlvo);
  const { enfileirados } = disparo.enfileirarCampanha(id, deps);
  const antes = enviosFeitos.length;

  const r = await semRuido(() => disparo.varrerDisparoPromocao(deps));

  assert.equal(r.enviados, enfileirados);
  assert.equal(enviosFeitos.length, antes, 'mock NAO pode chamar o adaptador de campanha');
  assert.equal(contar(id).pendente, 0, 'em mock tambem marca, senao a fila nunca esvazia');
  assert.equal(contar(id).enviado, enfileirados);
  assert.equal(statusCampanha(id), 'concluida', 'e a campanha fecha normalmente');

  config.entrevista.mock = false;
});

test('a rotina chama o adaptador SEM headers manuais (List-Unsubscribe vem dele)', async () => {
  zerarCampanhas();
  db.definirConfigBool(disparo.CHAVE_ATIVO, true);
  config.entrevista.mock = false;

  const id = criarRascunho(vagaAlvo, 'Assunto da Campanha');
  disparo.enfileirarCampanha(id, deps);
  enviosFeitos.length = 0;

  await semRuido(() => disparo.varrerDisparoPromocao(deps));

  assert.ok(enviosFeitos.length > 0, 'sanidade: precisa ter enviado alguma coisa');
  for (const args of enviosFeitos) {
    assert.equal(
      args.length,
      3,
      'enviar() so pode receber (destino, assunto, html) — um 4o argumento seria a rotina ' +
        'montando opcoes/headers por conta propria, furando o List-Unsubscribe automatico',
    );
    const [destino, assunto, html] = args;
    assert.match(destino, /@/);
    assert.equal(assunto, 'Assunto da Campanha');
    assert.equal(html, '<p>Temos uma vaga.</p>');
    assert.doesNotMatch(html, /List-Unsubscribe/i, 'o header nao e responsabilidade da rotina');
  }
});

test('teto por ciclo: envia ate ENVIOS_POR_CICLO e deixa o excedente para o proximo', async () => {
  zerarCampanhas();
  db.definirConfigBool(disparo.CHAVE_ATIVO, true);
  config.entrevista.mock = false;

  // Uma campanha MAIOR que o cap, para o excedente existir de verdade.
  const excedente = 5;
  const vagaGrande = criarVaga('Vaga Grande');
  const alvoGrande = criarVaga('Alvo Grande');
  const publicoAtual = listarPublicoCampanha({ jobIdAlvo: alvoGrande }).total;
  for (let i = publicoAtual; i < disparo.ENVIOS_POR_CICLO + excedente; i += 1) {
    criarCandidatura(vagaGrande, `massa${i}@exemplo.com`);
  }

  const id = criarRascunho(alvoGrande, 'Campanha Grande');
  const { enfileirados } = disparo.enfileirarCampanha(id, deps);
  assert.equal(enfileirados, disparo.ENVIOS_POR_CICLO + excedente, 'sanidade do cenario');

  const primeira = await semRuido(() => disparo.varrerDisparoPromocao(deps));
  assert.equal(primeira.enviados, disparo.ENVIOS_POR_CICLO, 'o teto tem que ser respeitado');
  assert.equal(contar(id).pendente, excedente, 'o excedente continua na fila');
  assert.equal(statusCampanha(id), 'enviando', 'ainda nao acabou: nao pode estar concluida');

  const segunda = await semRuido(() => disparo.varrerDisparoPromocao(deps));
  assert.equal(segunda.enviados, excedente, 'o excedente drena no ciclo seguinte');
  assert.equal(contar(id).pendente, 0);
  assert.equal(statusCampanha(id), 'concluida', 'so agora a campanha fecha');

  const terceira = await semRuido(() => disparo.varrerDisparoPromocao(deps));
  assert.equal(terceira.enviados, 0, 'nada sobra depois de drenar');

  // Devolve a base ao tamanho do cenario comum: os 130 contatos de massa entrariam no
  // publico de TODAS as campanhas seguintes e as empurrariam para cima do cap, mudando o
  // que os proximos testes medem.
  exec('DELETE FROM applications WHERE job_id = ?', vagaGrande);
});

test('campanha pequena resolve num ciclo so e vira concluida', async () => {
  zerarCampanhas();
  db.definirConfigBool(disparo.CHAVE_ATIVO, true);
  config.entrevista.mock = false;

  const id = criarRascunho(vagaAlvo, 'Campanha Pequena');
  const { enfileirados } = disparo.enfileirarCampanha(id, deps);
  assert.ok(enfileirados > 0 && enfileirados < disparo.ENVIOS_POR_CICLO, 'sanidade: menor que o cap');

  const r = await semRuido(() => disparo.varrerDisparoPromocao(deps));

  assert.equal(r.enviados, enfileirados);
  assert.equal(statusCampanha(id), 'concluida');
  assert.ok(uma('SELECT finalizada_em FROM campanhas WHERE id = ?', id).finalizada_em);
});

test('falha em UM destinatario marca so aquela linha e nao impede os demais da leva', async () => {
  zerarCampanhas();
  db.definirConfigBool(disparo.CHAVE_ATIVO, true);
  config.entrevista.mock = false;

  const id = criarRascunho(vagaAlvo);
  const { enfileirados } = disparo.enfileirarCampanha(id, deps);
  assert.ok(enfileirados >= 3, 'sanidade: precisa de leva com mais de um');

  const vitima = uma('SELECT email FROM campanha_envios WHERE campanha_id = ? ORDER BY id', id).email;
  falharPara = new Set([vitima]);

  const r = await semRuido(() => disparo.varrerDisparoPromocao(deps));
  falharPara = new Set();

  assert.equal(r.falhas, 1);
  assert.equal(r.enviados, enfileirados - 1, 'os demais da leva continuam normalmente');

  const c = contar(id);
  assert.equal(c.falha, 1);
  assert.equal(c.enviado, enfileirados - 1);
  assert.equal(c.pendente, 0);

  const linha = uma('SELECT status, erro FROM campanha_envios WHERE campanha_id = ? AND email = ?', id, vitima);
  assert.equal(linha.status, 'falha');
  assert.match(linha.erro, /falha simulada/, 'a mensagem do erro fica registrada na linha');

  // "Concluida" significa "nao ha mais nada pendente", e nao "deu tudo certo".
  assert.equal(statusCampanha(id), 'concluida');
});

test('a fila ignora envios pendentes de campanha que nao esta mais em andamento', async () => {
  zerarCampanhas();
  db.definirConfigBool(disparo.CHAVE_ATIVO, true);
  config.entrevista.mock = false;

  const id = criarRascunho(vagaAlvo);
  disparo.enfileirarCampanha(id, deps);
  // Cancelamento nao existe na tela (fora do escopo), mas a fila ja nao pode enviar
  // cegamente toda linha 'pendente' que encontrar.
  exec("UPDATE campanhas SET status = 'cancelada' WHERE id = ?", id);
  const antes = enviosFeitos.length;

  const r = await semRuido(() => disparo.varrerDisparoPromocao(deps));

  assert.equal(r.enviados, 0);
  assert.equal(enviosFeitos.length, antes, 'campanha fora de andamento nao envia');
  assert.equal(contar(id).pendente, contar(id).total, 'as linhas continuam intactas');
  assert.equal(statusCampanha(id), 'cancelada', 'e o cancelamento nao vira "concluida"');
});

test('trava de concorrencia: ciclos sobrepostos nao processam duas vezes', async () => {
  zerarCampanhas();
  db.definirConfigBool(disparo.CHAVE_ATIVO, true);
  config.entrevista.mock = false;

  const id = criarRascunho(vagaAlvo);
  const { enfileirados } = disparo.enfileirarCampanha(id, deps);

  const [r1, r2] = await semRuido(() =>
    Promise.all([disparo.varrerSeOcioso(deps), disparo.varrerSeOcioso(deps)]),
  );

  assert.equal(r1.enviados, enfileirados, 'a primeira varredura processa tudo');
  assert.equal(r2, null, 'a segunda, sobreposta, e descartada (nao enfileirada)');
});

// ════════════════════════ C. POST /admin/promocao/:id/disparar ════════════════════════

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

test('POST /:id/disparar exige login (herda o adminAuth do mount)', async () => {
  zerarCampanhas();
  const id = criarRascunho(vagaAlvo);

  await comServidor(async (base) => {
    const res = await fetch(`${base}/admin/promocao/${id}/disparar`, {
      method: 'POST',
      redirect: 'manual',
    });
    assert.equal(res.status, 302);
    assert.match(res.headers.get('location') || '', /\/admin\/login/);
    assert.equal(statusCampanha(id), 'rascunho', 'sem sessao, nada pode ter sido enfileirado');
    assert.equal(contar(id).total, 0);
  });
});

test('POST /:id/disparar NAO dispara num unico clique: exige a confirmacao', async () => {
  zerarCampanhas();
  const id = criarRascunho(vagaAlvo);
  const esperado = listarPublicoCampanha({ jobIdAlvo: vagaAlvo }).total;

  await comServidor(async (base) => {
    await autenticar(base);

    // 1o POST, sem `confirmado`: e so uma tela. NADA pode ter acontecido.
    const primeiro = await fetch(`${base}/admin/promocao/${id}/disparar`, form());
    assert.equal(primeiro.status, 200);
    const html = await primeiro.text();
    assert.match(html, /Confirmar disparo/);
    assert.match(html, new RegExp(String(esperado)), 'a confirmacao precisa mostrar o NUMERO');
    assert.match(html, /não há cancelamento/i);
    assert.match(html, /Sim, disparar/);

    assert.equal(statusCampanha(id), 'rascunho', 'o 1o clique nao pode enfileirar');
    assert.equal(contar(id).total, 0, 'o 1o clique nao pode materializar ninguem');

    // Repetivel sem efeito colateral, como a previa.
    await fetch(`${base}/admin/promocao/${id}/disparar`, form());
    assert.equal(contar(id).total, 0);

    // 2o POST, com `confirmado=1`: agora sim.
    const segundo = await fetch(`${base}/admin/promocao/${id}/disparar`, form({ confirmado: '1' }));
    assert.equal(segundo.status, 302);
    assert.equal(segundo.headers.get('location'), `/admin/promocao/${id}`);
    assert.equal(statusCampanha(id), 'enfileirada');
    assert.equal(contar(id).pendente, esperado);
  });
});

test('POST /:id/disparar recusa campanha que nao esta em rascunho, com mensagem clara', async () => {
  zerarCampanhas();
  const id = criarRascunho(vagaAlvo);
  disparo.enfileirarCampanha(id, deps);
  const antes = contar(id).total;

  await comServidor(async (base) => {
    await autenticar(base);
    for (const corpo of [{}, { confirmado: '1' }]) {
      const res = await fetch(`${base}/admin/promocao/${id}/disparar`, form(corpo));
      assert.equal(res.status, 409);
      const html = await res.text();
      assert.match(html, /só é possível disparar uma campanha em rascunho/i);
      assert.match(html, /não pode ser disparada de novo/i);
    }
    assert.equal(contar(id).total, antes, 'nenhuma linha a mais pode ter sido criada');
  });
});

// ── Pre-voo: o ambiente precisa conseguir enviar ANTES de qualquer materializacao ──
//
// O QUE ESTES QUATRO TESTES GUARDAM: sem DESCADASTRO_SECRET (ou sem credencial SMTP), todo
// envio falha, falha e TERMINAL por linha, e o UNIQUE(campanha_id, email) impede refazer a
// campanha para as mesmas pessoas. Ou seja: ligar as coisas na ordem errada custaria uma
// campanha inteira, sem volta pela aplicacao. A trava precisa ser codigo, nao um aviso.

test('sem DESCADASTRO_SECRET, POST /:id/disparar NAO enfileira nem com confirmado=1', async () => {
  zerarCampanhas();
  const id = criarRascunho(vagaAlvo);

  await comServidor(async (base) => {
    await autenticar(base);
    await semSegredoDescadastro(async () => {
      // Os DOIS cliques sao barrados: o 1o nem chega a mostrar a confirmacao (nao se pede
      // aprovacao de um disparo que so produziria falhas), e o 2o tambem nao passa.
      for (const corpo of [{}, { confirmado: '1' }]) {
        const res = await fetch(`${base}/admin/promocao/${id}/disparar`, form(corpo));
        assert.equal(res.status, 503);
        const html = await res.text();
        assert.match(html, /DESCADASTRO_SECRET/, 'a mensagem precisa dizer O QUE falta');
        assert.match(html, /continua em rascunho/i);
        assert.doesNotMatch(html, /Confirmar disparo/, 'a tela de confirmacao nao pode aparecer');
      }
    });

    assert.equal(statusCampanha(id), 'rascunho', 'a campanha nao pode ter saido de rascunho');
    assert.equal(contar(id).total, 0, 'nenhum destinatario pode ter sido materializado');
  });
});

test('sem credenciais de envio de campanha, POST /:id/disparar NAO enfileira', async () => {
  zerarCampanhas();
  const id = criarRascunho(vagaAlvo);

  await comServidor(async (base) => {
    await autenticar(base);
    await semCredenciaisEnvio(async () => {
      for (const corpo of [{}, { confirmado: '1' }]) {
        const res = await fetch(`${base}/admin/promocao/${id}/disparar`, form(corpo));
        assert.equal(res.status, 503);
        const html = await res.text();
        // A lista de campos vem do adaptador ATIVO (credenciaisFaltando roteado pela
        // fachada), nao de uma copia — hoje a API REST, entao a chave dela e o que falta.
        assert.match(html, /EMAILIT_API_KEY/);
        assert.doesNotMatch(html, /Confirmar disparo/);
      }
    });

    assert.equal(statusCampanha(id), 'rascunho');
    assert.equal(contar(id).total, 0);
  });
});

test('enfileirarCampanha chamada DIRETO tambem recusa sem DESCADASTRO_SECRET', async () => {
  zerarCampanhas();
  const id = criarRascunho(vagaAlvo);

  // A funcao nao confia que quem a chamou ja verificou: um script manual ou um caller
  // futuro nao pode contornar a checagem da rota. E LANCA (nao devolve { ok: false })
  // justamente para que um retorno ignorado por acidente nao vire campanha queimada.
  await semSegredoDescadastro(() => {
    assert.throws(
      () => disparo.enfileirarCampanha(id, deps),
      /DESCADASTRO_SECRET/,
    );
  });

  await semCredenciaisEnvio(() => {
    assert.throws(() => disparo.enfileirarCampanha(id, deps), /EMAILIT_API_KEY/);
  });

  assert.equal(statusCampanha(id), 'rascunho');
  assert.equal(contar(id).total, 0, 'nada pode ter sido materializado');

  // E o pre-voo vem ANTES de qualquer olhar para a campanha: id inexistente com ambiente
  // quebrado reclama do AMBIENTE, porque o problema nao e daquela campanha.
  await semSegredoDescadastro(() => {
    assert.throws(() => disparo.enfileirarCampanha(999999, deps), /DESCADASTRO_SECRET/);
  });
});

test('nao-regressao: com as duas pre-condicoes presentes, o disparo prossegue', async () => {
  zerarCampanhas();
  const id = criarRascunho(vagaAlvo);
  const esperado = listarPublicoCampanha({ jobIdAlvo: vagaAlvo }).total;

  const preVoo = disparo.verificarPreCondicoesDisparo();
  assert.equal(preVoo.ok, true, 'sanidade: o ambiente de teste tem as duas pre-condicoes');
  assert.deepEqual(preVoo.pendencias, []);

  await comServidor(async (base) => {
    await autenticar(base);

    const confirmacao = await fetch(`${base}/admin/promocao/${id}/disparar`, form());
    assert.equal(confirmacao.status, 200);
    assert.match(await confirmacao.text(), /Confirmar disparo/);

    const disparado = await fetch(`${base}/admin/promocao/${id}/disparar`, form({ confirmado: '1' }));
    assert.equal(disparado.status, 302);
    assert.equal(statusCampanha(id), 'enfileirada');
    assert.equal(contar(id).pendente, esperado);
  });
});

test('POST /:id/disparar em campanha inexistente -> 404', async () => {
  await comServidor(async (base) => {
    await autenticar(base);
    const res = await fetch(`${base}/admin/promocao/999999/disparar`, form({ confirmado: '1' }));
    assert.equal(res.status, 404);
    assert.match(await res.text(), /Campanha não encontrada/);
  });
});

// ════════════════════════ D. Tela de detalhe ════════════════════════

test('detalhe: rascunho mostra o botao VIVO de disparar (nao desabilitado)', async () => {
  zerarCampanhas();
  const id = criarRascunho(vagaAlvo);

  await comServidor(async (base) => {
    await autenticar(base);
    const html = await (await fetch(`${base}/admin/promocao/${id}`, { headers: comAuth() })).text();
    assert.match(html, new RegExp(`action="/admin/promocao/${id}/disparar"`));
    assert.match(html, /<button type="submit" class="btn">Disparar campanha<\/button>/);
  });
});

test('detalhe: campanha enfileirada mostra o progresso agregado e some com o botao', async () => {
  zerarCampanhas();
  db.definirConfigBool(disparo.CHAVE_ATIVO, true);
  config.entrevista.mock = false;

  const id = criarRascunho(vagaAlvo);
  const { enfileirados } = disparo.enfileirarCampanha(id, deps);

  // Uma falha proposital, para o bloco de falhas aparecer.
  const vitima = uma('SELECT email FROM campanha_envios WHERE campanha_id = ? ORDER BY id', id).email;
  falharPara = new Set([vitima]);
  await semRuido(() => disparo.varrerDisparoPromocao(deps));
  falharPara = new Set();

  await comServidor(async (base) => {
    await autenticar(base);
    const html = await (await fetch(`${base}/admin/promocao/${id}`, { headers: comAuth() })).text();

    assert.match(html, /destinatários congelados no disparo/);
    assert.match(html, new RegExp(`<b>${enfileirados}</b> destinatários congelados`));
    assert.match(html, new RegExp(`<b>${enfileirados - 1}</b> enviados`));
    assert.match(html, /<b>1<\/b> falha/, 'o numero de falhas precisa aparecer');
    assert.doesNotMatch(html, /Disparar campanha/, 'campanha ja disparada nao oferece o botao');
    // NUMEROS agregados apenas: nada de listar quem falhou nesta tela.
    assert.doesNotMatch(html, new RegExp(vitima), 'o detalhe por destinatario e outra tela');
  });
});

// ════════════════════════ E. Painel de configuracoes ════════════════════════

test('o kill-switch promocao_ativa nasce FALSE e aparece em /admin/config', async () => {
  // Chave nunca escrita = desligado. Apagamos a linha para provar o DEFAULT, e nao o
  // valor que os testes acima deixaram no banco.
  exec('DELETE FROM configuracoes WHERE chave = ?', disparo.CHAVE_ATIVO);
  assert.equal(db.obterConfigBool(disparo.CHAVE_ATIVO, false), false);
  assert.equal(disparo.ativo({ db }), false, 'sem a chave, a rotina esta desligada');

  await comServidor(async (base) => {
    await autenticar(base);
    const html = await (await fetch(`${base}/admin/config`, { headers: comAuth() })).text();
    assert.match(html, /name="promocao_ativa"/, 'o toggle precisa existir no painel');
    assert.doesNotMatch(
      html,
      /name="promocao_ativa" value="1" checked/,
      'e precisa nascer DESMARCADO',
    );
  });
});

test('/admin/config liga e desliga promocao_ativa sem mexer nos outros interruptores', async () => {
  await comServidor(async (base) => {
    await autenticar(base);

    const ligar = await fetch(`${base}/admin/config/notificacoes`, form({ promocao_ativa: '1' }));
    assert.equal(ligar.status, 302);
    assert.equal(db.obterConfigBool(disparo.CHAVE_ATIVO, false), true);

    // Checkbox ausente = desligar (o navegador nao envia o campo desmarcado).
    const desligar = await fetch(`${base}/admin/config/notificacoes`, form({}));
    assert.equal(desligar.status, 302);
    assert.equal(db.obterConfigBool(disparo.CHAVE_ATIVO, false), false);
  });
});
