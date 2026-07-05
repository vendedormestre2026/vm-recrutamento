'use strict';

// Item 7.5 — motor de progresso com orcamento de trocas por bloco (roleplay).
// Testa avancarProgresso como FUNCAO PURA: sem banco, sem LLM, sem rede. Cada chamada
// representa UMA troca concluida (resposta do candidato + fala da Vera). Enquanto o
// orcamento (maxTrocas) do bloco atual nao se esgota, o indice NAO avanca (a Vera segue
// no mesmo bloco, ex.: um roleplay multi-turno); ao esgotar, avanca 1 e zera as trocas.
// O indice nunca ultrapassa o fim do array (clamp). Default maxTrocas=1 = comportamento
// anterior a este item (avanca imediatamente).

const test = require('node:test');
const assert = require('node:assert/strict');

const { avancarProgresso } = require('../src/lib/entrevista');

// Array de referencia: uma pergunta comum, um roleplay (maxTrocas=3) e outra comum.
const PERGUNTAS = [
  { texto: 'q0', maxTrocas: 1 },
  { texto: 'roleplay', maxTrocas: 3 },
  { texto: 'q2', maxTrocas: 1 },
];

test('avancarProgresso — pergunta comum (maxTrocas=1): avanca 1 e zera trocas', () => {
  assert.deepEqual(
    avancarProgresso({ indiceAtual: 0, trocasAtual: 0, perguntas: PERGUNTAS }),
    { indice: 1, trocas: 0 },
  );
});

test('avancarProgresso — roleplay (maxTrocas=3): segura o indice pelas 2 primeiras trocas e avanca na 3a', () => {
  // 1a troca: nao avanca, trocas=1
  assert.deepEqual(
    avancarProgresso({ indiceAtual: 1, trocasAtual: 0, perguntas: PERGUNTAS }),
    { indice: 1, trocas: 1 },
  );
  // 2a troca: nao avanca, trocas=2
  assert.deepEqual(
    avancarProgresso({ indiceAtual: 1, trocasAtual: 1, perguntas: PERGUNTAS }),
    { indice: 1, trocas: 2 },
  );
  // 3a troca: AVANCA (indice+1) e zera trocas
  assert.deepEqual(
    avancarProgresso({ indiceAtual: 1, trocasAtual: 2, perguntas: PERGUNTAS }),
    { indice: 2, trocas: 0 },
  );
});

test('avancarProgresso — ultima pergunta: indice nunca ultrapassa perguntas.length-1 (clamp)', () => {
  // idx=2 e o ultimo (len=3). Mesmo "avancando", permanece em 2.
  assert.deepEqual(
    avancarProgresso({ indiceAtual: 2, trocasAtual: 0, perguntas: PERGUNTAS }),
    { indice: 2, trocas: 0 },
  );
});

test('avancarProgresso — pergunta sem maxTrocas definido: default 1 (comportamento anterior)', () => {
  const semMax = [{ texto: 'a' }, { texto: 'b' }]; // nenhum maxTrocas
  assert.deepEqual(
    avancarProgresso({ indiceAtual: 0, trocasAtual: 0, perguntas: semMax }),
    { indice: 1, trocas: 0 },
  );
});
