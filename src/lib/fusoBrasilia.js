'use strict';

// Fuso de Brasilia: o offset real de um instante, e a conversao "hora de parede -> instante".
//
// Modulo-FOLHA (nenhum require proprio), de proposito — mesmo raciocinio de lib/slug.js,
// lib/normalizarEmail.js e lib/chaveTelefone.js: e importavel por qualquer camada, inclusive
// pela de dados, sem abrir ciclo.
//
// ── DE ONDE ISTO VEIO, E POR QUE VIROU MODULO ──
// A logica de offset nasceu dentro de lib/whatsappFicha.js, que a usava para UMA coisa
// (calcular "amanha ao meio-dia", o prazo do video). Com a entrevista em grupo ela passou a
// ter um segundo consumidor (lib/entrevistaGrupo), e ha um terceiro previsto. Recopiar seria
// garantir que as copias divergissem: duas leituras diferentes de "que horas sao em Brasilia"
// produzem mensagens com horarios diferentes para o mesmo dado, e o sintoma aparece no
// aparelho do candidato, nao aqui.
//
// whatsappFicha.js passou a importar daqui e NAO tem mais copia propria.
//
// ── POR QUE Intl, E NAO '-03:00' CRAVADO ──
// O Brasil nao tem horario de verao desde 2019. Cravar o numero seria apostar que essa regra
// nunca volta — e ela ja mudou duas vezes na vida deste projeto ser escrito. `longOffset`
// devolve algo como "GMT-03:00" PARA AQUELE INSTANTE, entao a resposta acompanha a regra
// vigente na data, sem tabela nossa para manter.

const FUSO_BRASILIA = 'America/Sao_Paulo';

// Offset de `timeZone` (em minutos, NEGATIVO para fusos atras de UTC) NO INSTANTE `data`.
//
// Devolve 0 quando o ambiente nao expoe `longOffset` (Node sem ICU completo): e o unico
// desfecho seguro sem inventar um numero — e o teste de fuso deste projeto roda em ambiente
// com ICU, entao a degradacao e teorica, nao silenciosa em producao.
function offsetMinutos(data, timeZone = FUSO_BRASILIA) {
  const partes = new Intl.DateTimeFormat('en-US', { timeZone, timeZoneName: 'longOffset' })
    .formatToParts(data);
  const nome = (partes.find((p) => p.type === 'timeZoneName') || {}).value || 'GMT+00:00';
  const m = nome.match(/GMT([+-])(\d{2}):(\d{2})/);
  if (!m) return 0;
  const sinal = m[1] === '-' ? -1 : 1;
  return sinal * (Number(m[2]) * 60 + Number(m[3]));
}

// 'YYYY-MM-DD' (o que <input type="date"> produz). Nada de tolerancia a 'DD/MM/YYYY' aqui:
// esta funcao le dado NOSSO, gravado por um campo de formulario com formato fixo, e aceitar
// duas grafias abriria a porta para "02/10" virar 2 de outubro num lugar e 10 de fevereiro
// noutro.
const RE_DATA = /^(\d{4})-(\d{2})-(\d{2})$/;
// 'HH:MM' ou 'HH:MM:SS' — alguns navegadores acrescentam os segundos em <input type="time">.
const RE_HORA = /^(\d{2}):(\d{2})(?::\d{2})?$/;

// A data existe de verdade? Date.UTC aceita 31 de fevereiro e desliza para 3 de marco, em
// silencio. A comparacao de ida e volta e o que recusa isso — sem ela, uma data impossivel
// digitada no admin viraria uma reuniao num dia que ninguem escolheu.
function dataReal(ano, mes, dia) {
  const d = new Date(Date.UTC(ano, mes - 1, dia));
  return d.getUTCFullYear() === ano && d.getUTCMonth() === mes - 1 && d.getUTCDate() === dia;
}

// Hora de parede de Brasilia -> instante (Date), ou null quando a entrada nao e utilizavel.
//
// NUNCA LANCA: a entrada vem de coluna de banco preenchida por formulario. null significa
// "nao ha instante aqui", e quem chama trata isso como ausencia — nunca como erro.
//
// ── AS DUAS PASSADAS DE OFFSET ──
// O offset de um instante so pode ser consultado a partir de um instante, e o que temos e uma
// hora de parede — que ainda nao e um instante. A saida e a de sempre: trata a parede como se
// fosse UTC para descobrir um offset aproximado, corrige, e CONFERE o offset no resultado. Se
// os dois discordarem (so acontece perto de uma virada de horario de verao), a segunda leitura
// vale. Sem essa segunda passada, uma reuniao marcada na vizinhanca da virada erraria em uma
// hora — hoje impossivel no Brasil, e barato de deixar correto para o dia em que voltar a ser.
function instanteDeBrasilia(data, hora) {
  const mData = RE_DATA.exec(String(data == null ? '' : data).trim());
  const mHora = RE_HORA.exec(String(hora == null ? '' : hora).trim());
  if (!mData || !mHora) return null;

  const ano = Number(mData[1]);
  const mes = Number(mData[2]);
  const dia = Number(mData[3]);
  const hh = Number(mHora[1]);
  const mm = Number(mHora[2]);
  if (!dataReal(ano, mes, dia)) return null;
  if (hh > 23 || mm > 59) return null;

  const provisorio = new Date(Date.UTC(ano, mes - 1, dia, hh, mm, 0, 0));
  const offset1 = offsetMinutos(provisorio, FUSO_BRASILIA);
  const candidato = new Date(provisorio.getTime() - offset1 * 60 * 1000);
  const offset2 = offsetMinutos(candidato, FUSO_BRASILIA);
  if (offset2 === offset1) return candidato;
  return new Date(provisorio.getTime() - offset2 * 60 * 1000);
}

// "quinta-feira, 02/10/2026" — formatado NO FUSO DE BRASILIA a partir do instante, e nao
// remontado a partir da string original. A diferenca importa: o dia da semana tem que ser o
// do dia civil em Brasilia, que e o dia que a pessoa vai ler na mensagem.
function formatarDataBrasilia(instante) {
  if (!(instante instanceof Date) || Number.isNaN(instante.getTime())) return '';
  const partes = new Intl.DateTimeFormat('pt-BR', {
    timeZone: FUSO_BRASILIA,
    weekday: 'long',
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
  }).formatToParts(instante);
  const v = (tipo) => (partes.find((p) => p.type === tipo) || {}).value || '';
  const semana = v('weekday');
  return `${semana}, ${v('day')}/${v('month')}/${v('year')}`;
}

// "19:30" no fuso de Brasilia, pelo mesmo motivo de formatarDataBrasilia.
function formatarHoraBrasilia(instante) {
  if (!(instante instanceof Date) || Number.isNaN(instante.getTime())) return '';
  return new Intl.DateTimeFormat('pt-BR', {
    timeZone: FUSO_BRASILIA,
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(instante);
}

module.exports = {
  FUSO_BRASILIA,
  offsetMinutos,
  instanteDeBrasilia,
  formatarDataBrasilia,
  formatarHoraBrasilia,
  RE_DATA,
  RE_HORA,
};
