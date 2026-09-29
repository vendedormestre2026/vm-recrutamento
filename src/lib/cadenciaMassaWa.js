'use strict';

// Cadencia e janela de envio do disparo em massa: QUANDO pode enviar e EM QUE RITMO.
//
// Funcoes PURAS. O relogio e a fonte de aleatoriedade entram por parametro, sempre — e o que
// permite testar "e sabado as 18h01" e "o lote sorteado foi 5" sem esperar nem depender de sorte.
//
// ══════════════════════════════════════════════════════════════
// POR QUE ESTES NUMEROS, E POR QUE ELES SAO O QUE PROTEGE O NUMERO
// ══════════════════════════════════════════════════════════════
//
// A punicao por excesso no WhatsApp nao e reputacao que se recupera: e o numero bloqueado, que e
// binario. Entao a cadencia nao e "educada", e conservadora de proposito:
//
//   lote 5–8 mensagens          rajada e o padrao mais facil de detectar
//   20–60 s entre mensagens     aleatorio, porque intervalo CONSTANTE tambem e assinatura
//   5–10 min entre lotes        deixa a vazao em ~35–50 msg/h
//   teto diario em RAMPA        30 -> 60 -> 100 -> 150, subindo so depois de dias sem incidente
//   janela 9h–18h, seg a sab    domingo fora: e o dia que mais gera denuncia, e denuncia bloqueia
//   15 s de espacamento global  o transacional (WA1/WA2) divide o MESMO socket
//
// ── O ALEATORIO NAO E ENFEITE ──
// Gap fixo de 30 s produz uma serie perfeitamente regular, que e mais facil de identificar como
// robo do que o volume em si. Sortear dentro de uma faixa e o que faz a serie parecer humana.
//
// ── NULL NA COLUNA = USAR O DEFAULT DAQUI ──
// A campanha guarda cada parametro como nullable (ver db/schema.sql). Com isso, ajustar a cadencia
// de TODAS as campanhas e mudar uma constante neste arquivo — e nao um UPDATE em massa que
// esqueceria as campanhas criadas amanha. Valor preenchido na campanha e override explicito.

const { partesBrasilia } = require('./fusoBrasilia');

// ── DEFAULTS (a cadencia aprovada) ──
const PADRAO = Object.freeze({
  loteMin: 5,
  loteMax: 8,
  gapMinS: 20,
  gapMaxS: 60,
  pausaLoteMinS: 5 * 60,
  pausaLoteMaxS: 10 * 60,
  // Primeiro degrau da rampa. Subir e decisao HUMANA (editar a campanha), nunca automatica: o
  // sistema nao tem como saber se os ultimos dias foram tranquilos.
  tetoDiario: 30,
  horaInicio: '09:00',
  horaFim: '18:00',
  diasSemana: '1,2,3,4,5,6', // ISO: 1=segunda ... 7=domingo. Domingo de fora.
});

// Degraus da rampa, so para a tela sugerir o proximo. Nao ha automatismo: quem sobe e o operador.
const RAMPA_TETO_DIARIO = Object.freeze([30, 60, 100, 150]);

// Espacamento minimo entre QUALQUER envio pelo socket, contando os do motor transacional.
// Nao e por campanha: e uma propriedade da LINHA, que e uma so.
const ESPACAMENTO_GLOBAL_MS = 15 * 1000;

// ── DISJUNTOR ──
// Tres falhas seguidas, ou mais de 40% do lote falhando, pausa a campanha. Nunca auto-retoma:
// retomar depois de um sinal de bloqueio e como se perde o numero.
const ERROS_CONSECUTIVOS_LIMITE = 3;
const TAXA_FALHA_LOTE_LIMITE = 0.4;

// Teto de PAREDE de um lote dentro de um tick. Com 8 mensagens e gap de 60 s, um lote leva ate
// ~8 min; 12 min de teto cobre isso com folga e garante que um ciclo nunca fique presa para
// sempre (ex.: um envio que pendura). Passado o teto, o lote e interrompido e o restante volta na
// proxima passada — nenhuma linha e perdida, porque quem nao saiu continua 'pendente'.
const TETO_PAREDE_LOTE_MS = 12 * 60 * 1000;

const RE_HORA = /^(\d{1,2}):(\d{2})$/;

// 'HH:MM' -> minutos desde a meia-noite. null quando nao reconhece (quem chama cai no default).
function minutosDaHora(texto) {
  const m = RE_HORA.exec(String(texto == null ? '' : texto).trim());
  if (!m) return null;
  const hora = Number(m[1]);
  const minuto = Number(m[2]);
  if (hora > 23 || minuto > 59) return null;
  return hora * 60 + minuto;
}

// '1,2,3' -> Set{1,2,3}. Valor fora de 1..7 e descartado; lista vazia devolve null para quem
// chama cair no default (e nao "nenhum dia", que travaria a campanha para sempre em silencio).
function diasDaLista(texto) {
  const dias = String(texto == null ? '' : texto)
    .split(',')
    .map((d) => Number(String(d).trim()))
    .filter((d) => Number.isInteger(d) && d >= 1 && d <= 7);
  return dias.length ? new Set(dias) : null;
}

// Junta o que a campanha definiu com os defaults. Todo consumidor usa ISTO, nunca a linha crua —
// assim "qual e a cadencia desta campanha?" tem uma resposta so.
//
// `?? PADRAO.x` e nao `|| PADRAO.x`: 0 e valor legitimo em gap e pausa (os testes injetam 0 para
// nao esperar), e `||` o transformaria no default, fazendo um teste de 200 ms levar 10 minutos.
function resolverCadencia(campanha = {}) {
  const c = campanha || {};
  const inicio = minutosDaHora(c.hora_inicio);
  const fim = minutosDaHora(c.hora_fim);
  const dias = diasDaLista(c.dias_semana);
  return {
    loteMin: c.lote_min ?? PADRAO.loteMin,
    loteMax: c.lote_max ?? PADRAO.loteMax,
    gapMinS: c.gap_min_s ?? PADRAO.gapMinS,
    gapMaxS: c.gap_max_s ?? PADRAO.gapMaxS,
    pausaLoteMinS: c.pausa_lote_min_s ?? PADRAO.pausaLoteMinS,
    pausaLoteMaxS: c.pausa_lote_max_s ?? PADRAO.pausaLoteMaxS,
    tetoDiario: c.teto_diario ?? PADRAO.tetoDiario,
    horaInicioMin: inicio == null ? minutosDaHora(PADRAO.horaInicio) : inicio,
    horaFimMin: fim == null ? minutosDaHora(PADRAO.horaFim) : fim,
    dias: dias || diasDaLista(PADRAO.diasSemana),
    // Ecoados para a tela mostrar o que esta valendo sem reconverter.
    horaInicio: c.hora_inicio || PADRAO.horaInicio,
    horaFim: c.hora_fim || PADRAO.horaFim,
    diasSemana: c.dias_semana || PADRAO.diasSemana,
  };
}

// Inteiro aleatorio em [min, max], inclusivo nas duas pontas.
//
// Faixa invertida (min > max) e tratada como ponto unico em `min`, em vez de lancar: e
// configuracao errada do operador, e a resposta certa e enviar devagar, nao derrubar o ciclo.
function sortearInteiro(min, max, aleatorio = Math.random) {
  const a = Number(min);
  const b = Number(max);
  if (!Number.isFinite(a)) return 0;
  if (!Number.isFinite(b) || b <= a) return Math.max(0, Math.trunc(a));
  const n = Math.floor(aleatorio() * (b - a + 1)) + a;
  return Math.min(Math.max(Math.trunc(n), a), b);
}

const FORA_DIA = 'dia_da_semana';
const FORA_HORARIO = 'fora_do_horario';

// Pode enviar agora? Devolve { ok, motivo } — `motivo` e um CODIGO; a frase mora em quem exibe.
//
// A janela e sempre avaliada no relogio de BRASILIA, nunca no do servidor: o container roda em UTC
// e, sem essa conversao, a janela "9h–18h" comecaria as 6h da manha para o candidato.
function dentroDaJanela(agora, cadencia) {
  const p = partesBrasilia(agora);
  if (!p) return { ok: false, motivo: FORA_HORARIO };
  if (!cadencia.dias.has(p.diaSemanaIso)) return { ok: false, motivo: FORA_DIA };
  // Inclusivo no inicio, EXCLUSIVO no fim: com fim 18:00, 17:59 envia e 18:00 nao. Um envio
  // exatamente as 18:00 comeca um lote que terminaria depois das 18h.
  if (p.minutosDoDia < cadencia.horaInicioMin) return { ok: false, motivo: FORA_HORARIO };
  if (p.minutosDoDia >= cadencia.horaFimMin) return { ok: false, motivo: FORA_HORARIO };
  return { ok: true, motivo: null };
}

// Quantas mensagens este lote pode ter: o sorteio dentro da faixa, limitado pelo que resta do teto
// diario. Zero significa "nada agora" — e o chamador nao deve enviar nada.
function tamanhoDoLote(cadencia, restanteDoDia, aleatorio = Math.random) {
  const sorteado = sortearInteiro(cadencia.loteMin, cadencia.loteMax, aleatorio);
  return Math.max(0, Math.min(sorteado, Math.max(0, Number(restanteDoDia) || 0)));
}

// Milissegundos a esperar antes da PROXIMA mensagem do mesmo lote.
function gapMs(cadencia, aleatorio = Math.random) {
  return sortearInteiro(cadencia.gapMinS, cadencia.gapMaxS, aleatorio) * 1000;
}

// Milissegundos ate o proximo lote.
function pausaLoteMs(cadencia, aleatorio = Math.random) {
  return sortearInteiro(cadencia.pausaLoteMinS, cadencia.pausaLoteMaxS, aleatorio) * 1000;
}

// O disjuntor deve abrir por taxa de falha do lote?
//
// Exige um minimo de tentativas: 1 falha em 1 tentativa e 100% e nao diz nada. Com 3, a taxa
// comeca a significar algo.
const MIN_TENTATIVAS_PARA_TAXA = 3;
function taxaDeFalhaEstourou(tentativas, falhas) {
  if (!(tentativas >= MIN_TENTATIVAS_PARA_TAXA)) return false;
  return falhas / tentativas > TAXA_FALHA_LOTE_LIMITE;
}

module.exports = {
  PADRAO,
  RAMPA_TETO_DIARIO,
  ESPACAMENTO_GLOBAL_MS,
  ERROS_CONSECUTIVOS_LIMITE,
  TAXA_FALHA_LOTE_LIMITE,
  MIN_TENTATIVAS_PARA_TAXA,
  TETO_PAREDE_LOTE_MS,
  FORA_DIA,
  FORA_HORARIO,
  minutosDaHora,
  diasDaLista,
  resolverCadencia,
  sortearInteiro,
  dentroDaJanela,
  tamanhoDoLote,
  gapMs,
  pausaLoteMs,
  taxaDeFalhaEstourou,
};
