'use strict';

// B4 (parte pura) — cadencia e janela de envio do disparo em massa.
//
// Todo teste injeta o relogio e a fonte de aleatoriedade. Um teste de cadencia que depende de
// Math.random real falha uma vez a cada tantas execucoes, e ninguem confia num teste assim depois
// da segunda vez.

const test = require('node:test');
const assert = require('node:assert/strict');

const cad = require('../src/lib/cadenciaMassaWa');

const DEFAULT = cad.resolverCadencia({});

// Instante em UTC a partir da hora de parede de Brasilia (UTC-3), escrito a mao.
const brt = (ano, mes, dia, hh, mm = 0) => new Date(Date.UTC(ano, mes - 1, dia, hh + 3, mm));

// Outubro de 2026: dia 1 = quinta, 3 = sabado, 4 = domingo, 5 = segunda.

// ══════════════════ DEFAULTS ══════════════════

test('os defaults sao a cadencia aprovada', () => {
  assert.equal(DEFAULT.loteMin, 5);
  assert.equal(DEFAULT.loteMax, 8);
  assert.equal(DEFAULT.gapMinS, 20);
  assert.equal(DEFAULT.gapMaxS, 60);
  assert.equal(DEFAULT.pausaLoteMinS, 300);
  assert.equal(DEFAULT.pausaLoteMaxS, 600);
  assert.equal(DEFAULT.tetoDiario, 30, 'o primeiro degrau da rampa');
  assert.equal(DEFAULT.horaInicio, '09:00');
  assert.equal(DEFAULT.horaFim, '18:00');
  assert.deepEqual([...DEFAULT.dias].sort(), [1, 2, 3, 4, 5, 6], 'seg a sab, domingo de fora');
  assert.equal(cad.ESPACAMENTO_GLOBAL_MS, 15000);
  assert.equal(cad.ERROS_CONSECUTIVOS_LIMITE, 3);
  assert.deepEqual([...cad.RAMPA_TETO_DIARIO], [30, 60, 100, 150]);
});

test('a campanha sobrepoe o default campo a campo', () => {
  const c = cad.resolverCadencia({ lote_min: 2, gap_max_s: 90, teto_diario: 150, hora_fim: '20:00' });
  assert.equal(c.loteMin, 2);
  assert.equal(c.loteMax, 8, 'o que nao foi definido continua no default');
  assert.equal(c.gapMaxS, 90);
  assert.equal(c.tetoDiario, 150);
  assert.equal(c.horaFimMin, 20 * 60);
});

test('ZERO na campanha e respeitado (nao vira default)', () => {
  // O teste do worker injeta gap 0 para nao esperar. Com `|| default`, um teste de 200 ms levaria
  // 10 minutos.
  const c = cad.resolverCadencia({ gap_min_s: 0, gap_max_s: 0, pausa_lote_min_s: 0, pausa_lote_max_s: 0 });
  assert.equal(c.gapMinS, 0);
  assert.equal(c.gapMaxS, 0);
  assert.equal(cad.gapMs(c, () => 0.5), 0);
  assert.equal(cad.pausaLoteMs(c, () => 0.5), 0);
});

test('hora e dias invalidos caem no default em vez de travar a campanha', () => {
  // "nenhum dia permitido" travaria a campanha para sempre, em silencio. O default e o lado seguro.
  const c = cad.resolverCadencia({ hora_inicio: 'meio-dia', hora_fim: '99:99', dias_semana: 'x,y,0,8' });
  assert.equal(c.horaInicioMin, 9 * 60);
  assert.equal(c.horaFimMin, 18 * 60);
  assert.deepEqual([...c.dias].sort(), [1, 2, 3, 4, 5, 6]);
});

test('minutosDaHora e diasDaLista sao tolerantes a entrada suja', () => {
  assert.equal(cad.minutosDaHora(' 9:05 '), 545);
  assert.equal(cad.minutosDaHora('24:00'), null);
  assert.equal(cad.minutosDaHora(null), null);
  assert.deepEqual([...cad.diasDaLista(' 1 , 2,2, 7 ')].sort(), [1, 2, 7]);
  assert.equal(cad.diasDaLista(''), null);
});

// ══════════════════ JANELA ══════════════════

test('janela: 9h abre, 8h59 nao', () => {
  assert.equal(cad.dentroDaJanela(brt(2026, 10, 1, 9, 0), DEFAULT).ok, true);
  const fora = cad.dentroDaJanela(brt(2026, 10, 1, 8, 59), DEFAULT);
  assert.equal(fora.ok, false);
  assert.equal(fora.motivo, cad.FORA_HORARIO);
});

test('janela: 17h59 envia, 18h00 nao (fim EXCLUSIVO)', () => {
  // Um envio exatamente as 18:00 comecaria um lote que terminaria depois das 18h.
  assert.equal(cad.dentroDaJanela(brt(2026, 10, 1, 17, 59), DEFAULT).ok, true);
  assert.equal(cad.dentroDaJanela(brt(2026, 10, 1, 18, 0), DEFAULT).ok, false);
});

test('janela: sabado envia, domingo nao', () => {
  assert.equal(cad.dentroDaJanela(brt(2026, 10, 3, 12, 0), DEFAULT).ok, true);
  const domingo = cad.dentroDaJanela(brt(2026, 10, 4, 12, 0), DEFAULT);
  assert.equal(domingo.ok, false);
  assert.equal(domingo.motivo, cad.FORA_DIA);
});

test('janela: a virada de dia em UTC nao desloca a janela de Brasilia', () => {
  // 22h de Brasilia na sexta e sabado 01:00 em UTC. Se a janela fosse avaliada no relogio do
  // servidor (UTC), este instante cairia dentro de "sabado" e perto da manha — e mandaria mensagem
  // as 22h de uma sexta.
  const sextaAs22 = new Date('2026-10-03T01:00:00Z');
  const r = cad.dentroDaJanela(sextaAs22, DEFAULT);
  assert.equal(r.ok, false);
  assert.equal(r.motivo, cad.FORA_HORARIO);
});

test('janela: 6h da manha em UTC e 3h em Brasilia — nao envia', () => {
  assert.equal(cad.dentroDaJanela(new Date('2026-10-01T06:00:00Z'), DEFAULT).ok, false);
});

test('janela com dias customizados respeita a lista', () => {
  const soSegunda = cad.resolverCadencia({ dias_semana: '1' });
  assert.equal(cad.dentroDaJanela(brt(2026, 10, 5, 12, 0), soSegunda).ok, true);
  assert.equal(cad.dentroDaJanela(brt(2026, 10, 1, 12, 0), soSegunda).ok, false);
});

test('janela nao lanca com instante invalido', () => {
  const r = cad.dentroDaJanela(new Date('nao e data'), DEFAULT);
  assert.equal(r.ok, false);
});

// ══════════════════ SORTEIOS ══════════════════

test('sortearInteiro cobre a faixa inteira, inclusive as pontas', () => {
  const vistos = new Set();
  for (let k = 0; k < 4; k += 1) vistos.add(cad.sortearInteiro(5, 8, () => k / 4));
  assert.deepEqual([...vistos].sort(), [5, 6, 7, 8]);
  assert.equal(cad.sortearInteiro(5, 8, () => 0), 5);
  assert.equal(cad.sortearInteiro(5, 8, () => 0.9999999), 8);
});

test('sortearInteiro com faixa invertida devolve o minimo (envia devagar, nao quebra)', () => {
  assert.equal(cad.sortearInteiro(60, 20, () => 0.5), 60);
  assert.equal(cad.sortearInteiro(7, 7, () => 0.5), 7);
});

test('tamanhoDoLote nunca passa do que resta do teto diario', () => {
  assert.equal(cad.tamanhoDoLote(DEFAULT, 100, () => 0.99), 8);
  assert.equal(cad.tamanhoDoLote(DEFAULT, 3, () => 0.99), 3, 'o teto diario manda');
  assert.equal(cad.tamanhoDoLote(DEFAULT, 0, () => 0.5), 0);
  assert.equal(cad.tamanhoDoLote(DEFAULT, -5, () => 0.5), 0);
});

test('gap e pausa saem em milissegundos, dentro da faixa', () => {
  assert.equal(cad.gapMs(DEFAULT, () => 0), 20000);
  assert.equal(cad.gapMs(DEFAULT, () => 0.9999999), 60000);
  assert.equal(cad.pausaLoteMs(DEFAULT, () => 0), 300000);
  assert.equal(cad.pausaLoteMs(DEFAULT, () => 0.9999999), 600000);
});

// ══════════════════ DISJUNTOR (taxa de falha) ══════════════════

test('taxa de falha so conta a partir de 3 tentativas', () => {
  // 1 falha em 1 tentativa e 100% e nao diz nada. Pausar por isso transformaria um erro de rede
  // isolado em campanha parada.
  assert.equal(cad.taxaDeFalhaEstourou(1, 1), false);
  assert.equal(cad.taxaDeFalhaEstourou(2, 2), false);
  assert.equal(cad.taxaDeFalhaEstourou(3, 2), true);
});

test('taxa de falha estoura acima de 40%, nao em 40% exatos', () => {
  assert.equal(cad.taxaDeFalhaEstourou(5, 2), false, '40% exato nao estoura');
  assert.equal(cad.taxaDeFalhaEstourou(5, 3), true);
  assert.equal(cad.taxaDeFalhaEstourou(8, 3), false);
  assert.equal(cad.taxaDeFalhaEstourou(8, 4), true);
});

test('lote sem falha nenhuma nunca estoura', () => {
  assert.equal(cad.taxaDeFalhaEstourou(8, 0), false);
  assert.equal(cad.taxaDeFalhaEstourou(0, 0), false);
});
