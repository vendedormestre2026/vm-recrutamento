'use strict';

// WA3 — textos dos lembretes da entrevista em grupo. Funcoes PURAS (sem banco, rede, relogio).
//
// Tres variacoes por tipo, sorteadas por destinatario: dezenas de mensagens identicas saindo do
// mesmo numero no mesmo minuto (o wa3c sai para a vaga inteira de uma vez) e o padrao que o
// WhatsApp le como disparo automatizado.
//
// Variacoes 1 e 2 de cada tipo: redacao APROVADA pelo Rafael. A 3 foi acrescentada a pedido dele.
// Cada frase vai numa linha, e nenhuma URL leva ponto final colado: o aplicativo as vezes engole
// a pontuacao no link e ele deixa de abrir.
//
// ── A LINHA DO CALENDLY E OPCIONAL ──
// Toda linha que contem {calendly_url} SOME inteira quando a vaga nao tem Calendly (link_meet
// vazio) — nunca "Inscreva-se: " sem link. {meet_url} e obrigatorio: sem sala nao ha lembrete, e
// quem monta devolve `faltando` para o worker nao enviar.
//
// ── SEM NOME ──
// Candidatura sem nome nao pode virar "Oi, !". A saudacao perde o trecho do nome e a frase segue.
//
// Tokens: {nome} {vaga} {data} {hora} {meet_url} {calendly_url}. Chave simples, como as
// variacoes da massa (lib/variacoesMassaWa) — o duplo {{x}} e a convencao dos templates da Meta.

const { primeiroNomeDe } = require('./whatsapp');
const { tituloSemEmpresa } = require('./variacoesMassaWa');
const { formatarDataBrasilia, formatarHoraBrasilia } = require('./fusoBrasilia');
const { WA3A, WA3B, WA3C } = require('./lembreteEntrevista');

const VARIACOES = Object.freeze({
  [WA3A]: Object.freeze([
    [
      'Oi, {nome}! Lembrete: amanhã ({data}) às {hora} tem a entrevista em grupo da vaga {vaga}, pelo Google Meet.',
      'Já se inscreveu? É só entrar por aqui na hora: {meet_url}',
      'Ainda não? Inscreva-se: {calendly_url}',
    ],
    [
      '{nome}, passando para lembrar da entrevista em grupo de {vaga} amanhã, {data}, às {hora} (horário de Brasília).',
      'Link da sala: {meet_url}',
      'Se ainda não confirmou presença: {calendly_url}',
    ],
    [
      'Olá, {nome}! Amanhã é o dia da sua entrevista em grupo para {vaga}: {data}, às {hora} (horário de Brasília).',
      'Para entrar na sala do Google Meet: {meet_url}',
      'Ainda não confirmou presença? Faça agora: {calendly_url}',
    ],
  ]),
  [WA3B]: Object.freeze([
    [
      '{nome}, sua entrevista em grupo para {vaga} começa às {hora}, daqui a 2 horas.',
      'Link do Meet: {meet_url}',
      'Ainda não se inscreveu? {calendly_url}',
    ],
    [
      'Faltam 2 horas! Entrevista em grupo de {vaga} hoje às {hora}.',
      'Separe um lugar tranquilo e entre por aqui: {meet_url}',
    ],
    [
      '{nome}, hoje às {hora} tem a entrevista em grupo de {vaga}. Faltam 2 horas!',
      'Deixe o Google Meet instalado e entre pelo link: {meet_url}',
      'Se ainda não confirmou presença: {calendly_url}',
    ],
  ]),
  [WA3C]: Object.freeze([
    ['{nome}, começa em 15 minutos! Entre agora: {meet_url}'],
    ['A entrevista de {vaga} começa às {hora}, em 15 min. Já pode entrar na sala: {meet_url}'],
    [
      '{nome}, falta pouco: a entrevista em grupo de {vaga} começa às {hora}.',
      'Entre na sala do Meet: {meet_url}',
    ],
  ]),
});

const TOKENS = Object.freeze(['nome', 'vaga', 'data', 'hora', 'meet_url', 'calendly_url']);

function capitalizar(s) {
  return s ? s.charAt(0).toUpperCase() + s.slice(1) : s;
}

// Remove o nome da linha quando nao ha nome: "Oi, {nome}!" -> "Oi!"; "{nome}, passando" -> "Passando".
function semNome(linha) {
  let l = linha.replace(/,\s*\{nome\}(?=[!?.,])/g, '');
  if (/^\{nome\},\s*/.test(l)) l = capitalizar(l.replace(/^\{nome\},\s*/, ''));
  return l;
}

// Resolve UMA variacao (array de linhas) contra o contexto. Devolve { texto, faltando }.
function resolverVariacao(linhas, ctx) {
  const faltando = [];
  if (!String(ctx.meet_url || '').trim()) faltando.push('meet_url');
  const saida = [];
  for (const bruta of linhas) {
    if (bruta.includes('{calendly_url}') && !String(ctx.calendly_url || '').trim()) continue;
    let l = ctx.nome ? bruta : semNome(bruta);
    l = l.replace(/\{([a-z_]+)\}/g, (m, chave) => {
      if (!TOKENS.includes(chave)) {
        faltando.push(chave);
        return m;
      }
      const v = String(ctx[chave] == null ? '' : ctx[chave]).trim();
      if (!v) faltando.push(chave);
      return v;
    });
    saida.push(l.replace(/[ \t]{2,}/g, ' ').trim());
  }
  return { texto: saida.join('\n'), faltando: [...new Set(faltando)] };
}

// Contexto a partir da vaga, do candidato e do inicio da reuniao.
function montarContexto({ nome, job, inicio }) {
  return {
    nome: primeiroNomeDe(nome),
    vaga: tituloSemEmpresa(job && job.titulo, job && job.empresa),
    data: formatarDataBrasilia(inicio),
    hora: formatarHoraBrasilia(inicio),
    meet_url: String((job && job.link_meet_reuniao) || '').trim(),
    calendly_url: String((job && job.link_meet) || '').trim(),
  };
}

// Sorteia a variacao e monta o texto: { texto, variacaoIndice (1..3), faltando }.
// `aleatorio` injetavel para o teste (default Math.random).
function montarTextoLembrete({ tipo, nome, job, inicio, aleatorio = Math.random }) {
  const lista = VARIACOES[tipo];
  if (!lista) return { texto: '', variacaoIndice: null, faltando: ['tipo'] };
  const i = Math.min(lista.length - 1, Math.floor(aleatorio() * lista.length));
  const { texto, faltando } = resolverVariacao(lista[i], montarContexto({ nome, job, inicio }));
  return { texto, variacaoIndice: i + 1, faltando };
}

module.exports = {
  VARIACOES,
  TOKENS,
  resolverVariacao,
  montarContexto,
  montarTextoLembrete,
};
