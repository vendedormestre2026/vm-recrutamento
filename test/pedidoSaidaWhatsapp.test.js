'use strict';

// Incremento 6: a heuristica de "isto e um pedido para parar de receber?"
// (src/lib/pedidoSaidaWhatsapp.js).
//
// Funcao PURA — sem banco, sem rede. O peso deste arquivo esta nos FALSOS POSITIVOS: casar
// de menos custa um pedido nao atendido, que o painel resolve; casar de mais descadastra
// quem nao pediu, e essa pessoa nunca fica sabendo.

const test = require('node:test');
const assert = require('node:assert/strict');

const { pedeSaida, normalizarTexto, MAX_PALAVRAS } = require('../src/lib/pedidoSaidaWhatsapp');

test('reconhece os pedidos reais', () => {
  const sim = [
    'sair',
    'SAIR',
    'Sair!',
    'sair.',
    'parar',
    'PARAR.',
    'pare',
    'stop',
    'STOP',
    'cancelar',
    'descadastrar',
    'remover',
    'quero sair',
    'parar por favor',
    'me remover',
    'por favor parar',
  ];
  for (const t of sim) assert.equal(pedeSaida(t), true, `deveria casar: ${t}`);
});

test('FALSO POSITIVO — substring de frase longa nao casa', () => {
  const nao = [
    'nao posso parar de agradecer',
    'vou parar de trabalhar no mes que vem',
    'esse trabalho me fez sair da zona de conforto',
    'quando comeca o processo seletivo dessa vaga',
  ];
  for (const t of nao) assert.equal(pedeSaida(t), false, `NAO deveria casar: ${t}`);
});

test('FALSO POSITIVO — negacao diz o CONTRARIO e nao pode virar opt-out', () => {
  // Era o defeito da versao anterior desta regra (routes/webhook_meta.js casava por prefixo
  // e tinha 'nao quero' na lista): "nao quero parar de receber" virava descadastro.
  const nao = ['nao quero parar de receber', 'nao quero parar', 'nao quero sair', 'nunca parar', 'não quero sair'];
  for (const t of nao) assert.equal(pedeSaida(t), false, `NAO deveria casar: ${t}`);
});

test('FALSO POSITIVO — pedido sobre a CANDIDATURA nao e opt-out de divulgacao', () => {
  const nao = ['cancelar minha candidatura', 'cancelar inscricao', 'remover candidatura', 'cancelar entrevista'];
  for (const t of nao) assert.equal(pedeSaida(t), false, `NAO deveria casar: ${t}`);
});

test('FALSO POSITIVO — resposta comum de quem esta INTERESSADO', () => {
  // Tratar qualquer resposta como opt-out removeria da base exatamente as pessoas mais
  // interessadas. Estas sao as respostas reais que uma campanha de convite gera.
  const nao = ['obrigado', 'obrigada!', 'qual o horario', 'ainda tem vaga', 'tenho interesse', 'bom dia'];
  for (const t of nao) assert.equal(pedeSaida(t), false, `NAO deveria casar: ${t}`);
});

test('palavra parecida NAO conta: o casamento e exato, nunca por prefixo', () => {
  for (const t of ['parada', 'saindo', 'cancelamento', 'saida', 'removido']) {
    assert.equal(pedeSaida(t), false, `NAO deveria casar: ${t}`);
  }
});

test('entrada suja nunca lanca e nunca casa', () => {
  for (const t of ['', '   ', null, undefined, 42, {}, [], '!!!', '???']) {
    assert.equal(pedeSaida(t), false, `entrada: ${JSON.stringify(t)}`);
  }
});

test('o teto de palavras e o que separa pedido de frase', () => {
  assert.equal(pedeSaida('sair'), true);
  assert.equal(pedeSaida('quero sair agora'), true, `${MAX_PALAVRAS} palavras ainda passa`);
  assert.equal(pedeSaida('eu quero sair agora mesmo'), false, 'acima do teto, nao passa');
});

test('normalizarTexto: acento, caixa e pontuacao saem; a pontuacao vira ESPACO', () => {
  assert.equal(normalizarTexto('  SAIR!!  '), 'sair');
  assert.equal(normalizarTexto('Não'), 'nao');
  // Pontuacao virando espaco (e nao vazio) impede "sair,parar" de colar numa palavra so.
  assert.equal(normalizarTexto('sair,parar'), 'sair parar');
});
