'use strict';

// Resolucao da versao do protocolo do WhatsApp Web.
//
// ── POR QUE ISTO EXISTE, e por que o enunciado o chamou de ponto mais importante ──
// O Baileys se apresenta ao WhatsApp como uma versao especifica do WhatsApp Web. Quando o
// WhatsApp avanca e a versao embutida na biblioteca envelhece, o servidor recusa a conexao —
// e a recusa NAO diz "versao velha": ela chega como falha de conexao generica, ou como um
// pareamento que nunca completa. E o modo de falha mais caro de diagnosticar do subsistema,
// porque tudo o mais parece certo.
//
// `fetchLatestBaileysVersion` consulta a versao corrente. Mas ela faz REDE, e rede falha:
// se a chamada travar ou der erro, cair para a versao embutida na biblioteca
// (DEFAULT_CONNECTION_CONFIG.version) e melhor que nao conectar. O fallback e o ponto todo.
//
// ── CACHE DE PROCESSO ──
// A versao nao muda dentro de um mesmo boot, e a reconexao com backoff pode chamar isto
// varias vezes por minuto. Sem cache, cada tentativa de reconexao viraria uma chamada HTTP
// externa — exatamente quando a rede ja esta ruim.
//
// ⚠️ NOTA DE FIDELIDADE: o enunciado pede para replicar "quase literalmente" a funcao do
// projeto Central Whats. Nao tenho acesso a esse repositorio, entao isto foi escrito a
// partir do contrato publico do Baileys. O comportamento pedido (cache + fallback para
// DEFAULT_CONNECTION_CONFIG.version) esta aqui, mas a equivalencia linha a linha com o
// original NAO pode ser verificada por mim.

const { fetchLatestBaileysVersion, DEFAULT_CONNECTION_CONFIG } = require('@whiskeysockets/baileys');

// Versao embutida na biblioteca instalada. E o piso: sempre existe, nunca faz rede.
const VERSAO_EMBUTIDA = (DEFAULT_CONNECTION_CONFIG && DEFAULT_CONNECTION_CONFIG.version) || [2, 3000, 1023223821];

// Teto da consulta de versao. Sem ele, uma rede pendurada seguraria o boot da conexao
// indefinidamente — e o custo de esperar e maior que o de usar a versao embutida.
const TIMEOUT_MS = 10000;

let cache = null; // { version, origem }

// Devolve { version: [x,y,z], origem: 'remota'|'embutida'|'cache' }.
//
// NUNCA lanca. Um erro aqui viraria "o WhatsApp nao conecta" sem dizer por que; devolver a
// versao embutida com log e sempre melhor que propagar.
//
// `deps.buscar` injetavel para o teste exercitar os tres caminhos sem rede.
async function resolverVersaoWa(deps = {}) {
  if (cache && !deps.ignorarCache) return { ...cache, origem: 'cache' };

  const buscar = deps.buscar || fetchLatestBaileysVersion;
  try {
    const resultado = await Promise.race([
      buscar(),
      new Promise((_, rejeitar) => setTimeout(() => rejeitar(new Error('timeout')), deps.timeoutMs || TIMEOUT_MS)),
    ]);
    const version = resultado && resultado.version;
    // Guarda contra resposta malformada: um array de 3 numeros, ou nada feito.
    if (!Array.isArray(version) || version.length !== 3 || !version.every((n) => Number.isInteger(n))) {
      throw new Error(`formato inesperado: ${JSON.stringify(version)}`);
    }
    cache = { version, origem: 'remota' };
    console.log(`[wa-version] versao remota resolvida: ${version.join('.')}`);
    return { ...cache };
  } catch (err) {
    // Fallback silencioso NAO: o log e o que permite descobrir, meses depois, que a conexao
    // vinha usando versao velha porque a consulta falha desde sempre.
    console.warn(
      `[wa-version] falha ao consultar versao (${err.message}); usando a embutida ` +
        `${VERSAO_EMBUTIDA.join('.')}. Se o WhatsApp recusar a conexao, esta e a primeira ` +
        'coisa a investigar.',
    );
    cache = { version: VERSAO_EMBUTIDA, origem: 'embutida' };
    return { ...cache };
  }
}

// So para teste: o cache e de processo e sobreviveria entre cenarios.
function limparCacheVersao() {
  cache = null;
}

module.exports = { resolverVersaoWa, limparCacheVersao, VERSAO_EMBUTIDA, TIMEOUT_MS };
