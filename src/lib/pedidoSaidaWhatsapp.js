'use strict';

// "Esta mensagem recebida e um pedido para parar de receber?"
//
// Modulo-FOLHA (nenhum require proprio). Existe separado porque a MESMA heuristica precisa
// valer em dois lugares que nao se conhecem: o webhook da Meta (routes/webhook_meta.js,
// dormente) e o webhook de entrada da Central Whats, que ainda NAO existe — a especificacao
// dele esta em docs/webhook-entrada-centralwhats.md. Quando a Central Whats entregar o
// endpoint, a rota nova chama esta funcao e nao reescreve regra nenhuma.
//
// ══════════════════════════════════════════════════════════════
// O ERRO QUE ESTA FUNCAO EXISTE PARA NAO COMETER
// ══════════════════════════════════════════════════════════════
//
// Uma campanha que convida para um grupo gera respostas: "obrigado", "qual o horario?",
// "ainda tem vaga?". Tratar qualquer resposta como opt-out removeria da base exatamente as
// pessoas MAIS interessadas.
//
// O erro do outro lado e o oposto e igualmente concreto: casar por SUBSTRING faria
// "nao posso parar de agradecer" virar um descadastro, porque a frase contem "parar".
//
// ══════════════════════════════════════════════════════════════
// A HEURISTICA, EM QUATRO REGRAS
// ══════════════════════════════════════════════════════════════
//
//   1. A mensagem tem que ser CURTA — no maximo MAX_PALAVRAS palavras. Quem pede para sair
//      escreve "sair", "quero sair", "parar por favor". Quem escreve uma frase longa esta
//      dizendo outra coisa, mesmo que a palavra apareca nela.
//   2. Alguma palavra tem que ser EXATAMENTE uma da lista. Nao ha casamento por prefixo nem
//      por substring: "parada", "saindo" e "cancelamento" nao contam.
//   3. NEGACAO derruba tudo. "nao quero parar" tem tres palavras e contem "parar", e passaria
//      nas duas regras acima — mas significa o CONTRARIO. Qualquer negacao na mensagem a
//      desqualifica; o custo e deixar de reconhecer um pedido raro, e o beneficio e nunca
//      descadastrar quem disse que nao quer sair.
//   4. CONTEXTO DE OUTRA COISA derruba tudo. "cancelar minha candidatura" e um pedido
//      legitimo, sobre a CANDIDATURA — nao sobre a divulgacao. Registrar opt-out ali seria
//      responder a pergunta errada.
//
// ── ESCOPO DO QUE ISTO PRODUZ ──
// Um pedido reconhecido aqui vira SEMPRE opt-out de escopo `campanha`, nunca `total`. Quem
// escreve "sair" esta respondendo a uma mensagem de divulgacao e quer parar de receber
// ofertas; presumir que ele tambem quer perder o resultado de uma candidatura futura seria
// interpretar demais. Ver P1 no cabecalho de lib/optoutWhatsapp.js.

// Teto de palavras. Tres cobre as formas reais ("sair", "quero sair", "parar por favor",
// "me remover agora") sem alcancar frase. Quatro ja pegaria "nao posso parar mais".
const MAX_PALAVRAS = 3;

// A lista, exatamente como pedida. NAO inclui "nao quero": alem de ser duas palavras (o que
// exigiria casar sequencia, nao palavra), ela e o gatilho do falso positivo classico — a
// versao anterior desta regra, em routes/webhook_meta.js, descadastrava quem escrevesse
// "nao quero parar de receber", pela regra de prefixo que ela usava.
const PALAVRAS_SAIDA = ['sair', 'parar', 'pare', 'cancelar', 'descadastrar', 'remover', 'stop'];

// Regra 3. 'nao' cobre "não" depois da remocao de acentos.
const NEGACOES = ['nao', 'nunca', 'jamais'];

// Regra 4. Palavras que dizem que a mensagem e sobre OUTRA coisa — tipicamente a propria
// candidatura da pessoa, que nao se resolve por opt-out.
const CONTEXTOS_ALHEIOS = ['candidatura', 'vaga', 'inscricao', 'processo', 'entrevista'];

// Minuscula, sem acento, sem pontuacao, espacos colapsados. Devolve '' para qualquer coisa
// que nao seja texto — nunca lanca, porque a entrada vem de webhook.
function normalizarTexto(t) {
  return String(t == null ? '' : t)
    .trim()
    .toLowerCase()
    .normalize('NFD')
    // Faixa dos diacriticos combinantes (U+0300–U+036F): remove o acento e deixa a letra.
    .replace(/[̀-ͯ]/g, '')
    // Pontuacao vira ESPACO, e nao vazio: "sair,parar" sao duas palavras, nao "sairparar".
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

// A mensagem pede para parar de receber?
function pedeSaida(texto) {
  const limpo = normalizarTexto(texto);
  if (!limpo) return false;

  const palavras = limpo.split(' ');
  if (palavras.length > MAX_PALAVRAS) return false; // regra 1
  if (palavras.some((p) => NEGACOES.includes(p))) return false; // regra 3
  if (palavras.some((p) => CONTEXTOS_ALHEIOS.includes(p))) return false; // regra 4
  return palavras.some((p) => PALAVRAS_SAIDA.includes(p)); // regra 2
}

module.exports = {
  pedeSaida,
  normalizarTexto,
  PALAVRAS_SAIDA,
  NEGACOES,
  CONTEXTOS_ALHEIOS,
  MAX_PALAVRAS,
};
