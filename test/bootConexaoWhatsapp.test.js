'use strict';

// Ligacao BOOT -> conectar() (src/server.js, conectarWhatsappNoBoot).
//
// ── POR QUE ESTE ARQUIVO EXISTE ──
// Este e exatamente o buraco que custou uma etapa de diagnostico: conectar() existia,
// estava correta e TESTADA (test/whatsappConnection.test.js), a tela dizia que o boot a
// chamava, e nenhuma linha de codigo fazia isso. A suite ficava 100% verde porque todo
// teste cobria a FUNCAO e nenhum cobria a LIGACAO.
//
// A assercao que importa aqui nao e "conectar funciona" — e "o boot a chama, e so quando
// deve". Se alguem remover a chamada de iniciar(), este arquivo tem que ficar vermelho.
//
// ── ZERO WHATSAPP REAL ──
// `conectar` e injetado como dublê, no mesmo molde de conn.conectar({criarSocket}) usado
// no teste do ciclo de vida. Nenhum socket e aberto, nenhum QR e lido.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

process.env.DATABASE_PATH = path.join(os.tmpdir(), `vm-test-boot-wa-${process.pid}-${Date.now()}.db`);
process.env.INTERVIEW_MOCK = 'true';
process.env.SESSION_SECRET = 'segredo-de-teste';
process.env.WHATSAPP_SECRETS_KEY = 'b'.repeat(64);
process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert/strict');

const { migrar } = require('../src/db/migrate');
const { conectarWhatsappNoBoot } = require('../src/server');

migrar();

// Silencia as linhas de boot, que sao propositalmente barulhentas em producao.
function semRuido(fn) {
  const { log, warn, error } = console;
  console.log = console.warn = console.error = () => {};
  try {
    return fn();
  } finally {
    Object.assign(console, { log, warn, error });
  }
}

// Restaura a variavel ao valor original, inclusive quando ela nao existia: um `delete` que
// vira string 'undefined' contaminaria os testes seguintes deste mesmo processo.
function comFlag(valor, fn) {
  const original = process.env.WHATSAPP_BAILEYS_CONECTAR_NO_BOOT;
  if (valor === null) delete process.env.WHATSAPP_BAILEYS_CONECTAR_NO_BOOT;
  else process.env.WHATSAPP_BAILEYS_CONECTAR_NO_BOOT = valor;
  try {
    return fn();
  } finally {
    if (original === undefined) delete process.env.WHATSAPP_BAILEYS_CONECTAR_NO_BOOT;
    else process.env.WHATSAPP_BAILEYS_CONECTAR_NO_BOOT = original;
  }
}

// Espiao: conta chamadas sem abrir nada. Devolve uma promessa resolvida porque conectar()
// e async e o codigo de producao encadeia .then/.catch em cima do retorno.
function espiao() {
  const chamadas = [];
  const fn = () => {
    chamadas.push(true);
    return Promise.resolve(null);
  };
  return { fn, get n() { return chamadas.length; } };
}

// ── A ASSERCAO QUE REALMENTE FECHA O BURACO ──
//
// Todos os testes abaixo chamam conectarWhatsappNoBoot() diretamente. Eles provam que a
// FUNCAO se comporta — e nao que iniciar() a chama. Apagar a linha de iniciar() os
// deixaria todos verdes, que e precisamente o defeito original: conectar() era correta e
// testada, e ninguem a invocava.
//
// iniciar() nao e chamavel num teste (faz app.listen, migra e agenda sete setInterval), e
// injetar dependencia nela so para isto seria mexer no boot inteiro por causa de uma linha.
// Entao a verificacao e ESTATICA: le o proprio fonte e exige a chamada dentro do corpo de
// iniciar(). Grosseiro de proposito — e a unica forma barata de esta suite ficar VERMELHA
// se a ligacao sumir de novo.
test('iniciar() chama conectarWhatsappNoBoot — a ligacao em si', () => {
  const fonte = fs.readFileSync(path.join(__dirname, '..', 'src', 'server.js'), 'utf8');

  const inicio = fonte.indexOf('function iniciar()');
  assert.notEqual(inicio, -1, 'function iniciar() deveria existir em src/server.js');

  // Corpo de iniciar(): do cabecalho ate a primeira linha que fecha a funcao na coluna 0.
  const fim = fonte.indexOf('\n}', inicio);
  assert.notEqual(fim, -1, 'nao foi possivel delimitar o corpo de iniciar()');
  const corpo = fonte.slice(inicio, fim);

  assert.match(
    corpo,
    /conectarWhatsappNoBoot\(\)/,
    'iniciar() precisa chamar conectarWhatsappNoBoot(): sem essa linha o socket nunca abre, ' +
      'e foi exatamente esse o defeito que este arquivo existe para impedir de voltar',
  );
});

test('com a flag em true, o boot CHAMA conectar()', () => {
  const spy = espiao();
  const tentou = comFlag('true', () => semRuido(() => conectarWhatsappNoBoot({ conectar: spy.fn })));

  assert.equal(tentou, true, 'deveria reportar que tentou conectar');
  assert.equal(spy.n, 1, 'conectar() deveria ter sido chamada exatamente uma vez');
});

test('com a flag AUSENTE, o boot NAO chama conectar()', () => {
  const spy = espiao();
  const tentou = comFlag(null, () => semRuido(() => conectarWhatsappNoBoot({ conectar: spy.fn })));

  assert.equal(tentou, false);
  assert.equal(spy.n, 0, 'ausencia de variavel nao pode significar "pode conectar"');
});

test('com a flag em false, o boot NAO chama conectar()', () => {
  const spy = espiao();
  const tentou = comFlag('false', () => semRuido(() => conectarWhatsappNoBoot({ conectar: spy.fn })));

  assert.equal(tentou, false);
  assert.equal(spy.n, 0);
});

// Qualquer coisa que nao seja exatamente 'true' e tratada como desligado. O risco aqui e
// assimetrico: um valor ambiguo lido como "ligado" abre socket na hora errada, enquanto
// lido como "desligado" apenas adia algo que uma pessoa ia fazer manualmente de qualquer
// jeito.
test("so a string 'true' liga; lixo e variacao nao ligam", () => {
  for (const valor of ['1', 'sim', 'yes', 'TRUE ', '', 'true.', 'verdadeiro']) {
    const spy = espiao();
    const tentou = comFlag(valor, () => semRuido(() => conectarWhatsappNoBoot({ conectar: spy.fn })));
    assert.equal(tentou, false, `'${valor}' nao deveria ligar a conexao`);
    assert.equal(spy.n, 0, `'${valor}' nao deveria chamar conectar()`);
  }
});

// Case-insensitive de proposito: 'TRUE' e 'True' sao erros de digitacao previsiveis em
// painel de env, e recusar por causa da caixa seria hostil sem ganhar seguranca nenhuma.
// Mesma leitura de connection.ligado() (connection.js:89).
test("'TRUE' e 'True' ligam, como em connection.ligado()", () => {
  for (const valor of ['TRUE', 'True']) {
    const spy = espiao();
    const tentou = comFlag(valor, () => semRuido(() => conectarWhatsappNoBoot({ conectar: spy.fn })));
    assert.equal(tentou, true, `'${valor}' deveria ligar a conexao`);
    assert.equal(spy.n, 1);
  }
});

// A rejeicao TEM que ser tratada: conectar() e async, e uma promessa rejeitada sem .catch
// derruba o processo no Node 22. Falhar em conectar nao pode derrubar o site inteiro.
test('rejeicao de conectar() NAO derruba o boot', async () => {
  const conectar = () => Promise.reject(new Error('socket recusado'));
  const tentou = comFlag('true', () => semRuido(() => conectarWhatsappNoBoot({ conectar })));

  assert.equal(tentou, true);
  // Deixa o microtask do .catch drenar; se nao houvesse .catch, isto viraria
  // unhandledRejection e o processo de teste morreria aqui.
  await new Promise((r) => setImmediate(r));
});

// O outro modo de falha, que o .catch sozinho nao pega: erro lancado ANTES do primeiro
// await de conectar() chega SINCRONO e escaparia para iniciar(), derrubando o boot inteiro
// em vez de so o WhatsApp.
test('erro SINCRONO em conectar() NAO derruba o boot', () => {
  const conectar = () => { throw new Error('modulo do baileys ausente'); };
  const tentou = comFlag('true', () => semRuido(() => conectarWhatsappNoBoot({ conectar })));

  assert.equal(tentou, true, 'deveria ter tentado, registrado o erro e seguido');
});

// O boot nao pode esperar o socket: a resolucao de versao do Baileys faz chamada de rede, e
// um await aqui atrasaria o /health por algo que nao e requisito para servir HTTP.
test('o boot NAO espera a conexao terminar', () => {
  let resolver;
  const conectar = () => new Promise((r) => { resolver = r; });

  const tentou = comFlag('true', () => semRuido(() => conectarWhatsappNoBoot({ conectar })));

  // Retornou de forma SINCRONA, com a promessa de conectar() ainda pendente: se houvesse
  // await, esta linha so rodaria depois de resolver(), que ninguem ainda chamou.
  assert.equal(tentou, true);
  assert.equal(typeof resolver, 'function', 'conectar() deveria ter sido chamada, e ficado pendente');
  resolver(null);
});
