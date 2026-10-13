'use strict';

// WA3 (incremento 2) — cronograma dos lembretes: reuniao anunciada pelo convite (D1, com teto e
// historico de slots), prazos por tipo, tolerancia, janela 07–21 e carencia.
//
// PURO: nenhum banco, nenhuma rede, nenhum relogio real. Instantes esperados escritos em UTC a mao
// (Brasilia = UTC-3 desde 2019): comparar a funcao com ela mesma passaria com o fuso errado.

const test = require('node:test');
const assert = require('node:assert/strict');

const L = require('../src/lib/lembreteEntrevista');

const utc = (s) => new Date(s);
// Reuniao de referencia: quinta 15/10/2026 15:00 Brasilia = 18:00Z.
const INICIO = utc('2026-10-15T18:00:00Z');

// ══════════════════ REUNIOES DA VAGA ══════════════════

test('reunioesDaVaga: so pares validos, em ordem cronologica (nao a dos slots)', () => {
  const r = L.reunioesDaVaga({
    entrevista_grupo_1_data: '2026-10-20', entrevista_grupo_1_hora: '10:00',
    entrevista_grupo_2_data: '2026-10-15', entrevista_grupo_2_hora: '15:00',
    entrevista_grupo_3_data: '2026-10-31', entrevista_grupo_3_hora: '',
  });
  assert.deepEqual(r.map((x) => x.indice), [2, 1]);
  assert.equal(r[0].instante.toISOString(), '2026-10-15T18:00:00.000Z');
});

test('linkSalaDe le link_meet_reuniao, nunca link_meet (que e o Calendly)', () => {
  assert.equal(L.linkSalaDe({ link_meet: 'https://calendly.com/x' }), '');
  assert.equal(L.linkSalaDe({ link_meet_reuniao: ' https://meet.google.com/a ' }), 'https://meet.google.com/a');
});

// ══════════════════ D1: REUNIAO ANUNCIADA ══════════════════

test('D1: o convite anunciou a primeira reuniao >= enviado_em', () => {
  const t = [utc('2026-10-08T18:00:00Z'), INICIO];
  assert.equal(L.reuniaoAnunciada('2026-10-05 12:00:00', t).toISOString(), '2026-10-08T18:00:00.000Z');
  // Convidado depois da reuniao 1: anunciou a 2.
  assert.equal(L.reuniaoAnunciada('2026-10-09 12:00:00', t).toISOString(), INICIO.toISOString());
});

test('D1: quem foi convidado para a reuniao 1 NAO e lembrado da 2', () => {
  const t = [utc('2026-10-08T18:00:00Z'), INICIO];
  const anunciada = L.reuniaoAnunciada('2026-10-05 12:00:00', t);
  assert.notEqual(anunciada.getTime(), INICIO.getTime());
});

test('D1: texto do SQLite sem fuso e lido como UTC (nao hora local)', () => {
  // 17:59Z e antes de 18:00Z; lido como hora local de UTC-3 viraria 20:59Z e perderia a reuniao.
  const t = [INICIO];
  assert.equal(L.reuniaoAnunciada('2026-10-15 17:59:00', t).getTime(), INICIO.getTime());
});

test('D1: teto de 10 dias — convite mais antigo que isso fica de fora', () => {
  const t = [INICIO];
  assert.equal(L.reuniaoAnunciada('2026-10-05 18:00:00', t).getTime(), INICIO.getTime(), '10 dias exatos ainda vale');
  assert.equal(L.reuniaoAnunciada('2026-10-05 17:59:00', t), null);
});

test('D1: sem reuniao futura ao convite -> null', () => {
  assert.equal(L.reuniaoAnunciada('2026-10-16 12:00:00', [INICIO]), null);
  assert.equal(L.reuniaoAnunciada(null, [INICIO]), null);
});

test('troca de slot: reuniao passada SOBRESCRITA por uma futura nao traz quem foi convidado para a antiga', () => {
  // Slot 1 era 08/10 15h; convite em 06/10. A reuniao aconteceu (o worker a viu ate depois do
  // inicio) e o admin trocou o slot 1 por 15/10. So os slots atuais: o convite "anunciaria" 15/10.
  const atuais = [{ instante: INICIO }];
  const historico = [{ inicio: '2026-10-08 18:00:00', ultima_vez_vista: '2026-10-09 10:00:00' }];
  const semHistorico = L.reuniaoAnunciada('2026-10-06 12:00:00', L.linhaDoTempo(atuais));
  assert.equal(semHistorico.getTime(), INICIO.getTime(), 'premissa: sem historico a regra erra');

  const comHistorico = L.reuniaoAnunciada('2026-10-06 12:00:00', L.linhaDoTempo(atuais, historico));
  assert.equal(comHistorico.toISOString(), '2026-10-08T18:00:00.000Z');
  assert.notEqual(comHistorico.getTime(), INICIO.getTime());
});

test('troca de slot: data digitada errado e corrigida ANTES da hora nao rouba os convidados', () => {
  // Digitaram 12/10 por engano e corrigiram para 15/10 no mesmo minuto: a reuniao de 12/10 nunca
  // "aconteceu" (ultima vez vista < inicio), entao nao entra na linha do tempo.
  const atuais = [{ instante: INICIO }];
  const historico = [{ inicio: '2026-10-12 18:00:00', ultima_vez_vista: '2026-10-06 12:01:00' }];
  const r = L.reuniaoAnunciada('2026-10-06 12:00:00', L.linhaDoTempo(atuais, historico));
  assert.equal(r.getTime(), INICIO.getTime());
});

// ══════════════════ PRAZOS ══════════════════

test('prazos: wa3a vespera 18h-21h; wa3b 2h antes +30min; wa3c 15min antes +10min', () => {
  const a = L.prazoDoLembrete(L.WA3A, INICIO);
  assert.equal(a.devido.toISOString(), '2026-10-14T21:00:00.000Z');
  assert.equal(a.limite.toISOString(), '2026-10-15T00:00:00.000Z');
  const b = L.prazoDoLembrete(L.WA3B, INICIO);
  assert.equal(b.devido.toISOString(), '2026-10-15T16:00:00.000Z');
  assert.equal(b.limite.toISOString(), '2026-10-15T16:30:00.000Z');
  const c = L.prazoDoLembrete(L.WA3C, INICIO);
  assert.equal(c.devido.toISOString(), '2026-10-15T17:45:00.000Z');
  assert.equal(c.limite.toISOString(), '2026-10-15T17:55:00.000Z');
});

test('vespera e o dia civil anterior em Brasilia, inclusive na virada do mes', () => {
  // 01/11 08:00 Brasilia = 11:00Z: vespera 31/10.
  assert.equal(L.vesperaDe(utc('2026-11-01T11:00:00Z')), '2026-10-31');
  // 15/10 00:30 Brasilia = 03:30Z (em UTC ainda seria 15/10, em Brasilia tambem): vespera 14/10.
  assert.equal(L.vesperaDe(utc('2026-10-15T03:30:00Z')), '2026-10-14');
  // 14/10 22:30 Brasilia = 15/10 01:30Z: o dia civil e 14, vespera 13 (nao 14).
  assert.equal(L.vesperaDe(utc('2026-10-15T01:30:00Z')), '2026-10-13');
});

test('nenhum limite passa do inicio da reuniao', () => {
  // Reuniao 00:30 Brasilia: limite do wa3a (21:00 da vespera) < inicio, ok; wa3c limite <= inicio.
  const ini = utc('2026-10-15T03:30:00Z');
  for (const tipo of L.TIPOS) {
    assert.ok(L.prazoDoLembrete(tipo, ini).limite.getTime() <= ini.getTime(), tipo);
  }
});

// ══════════════════ SITUACAO ══════════════════

const sit = (tipo, agora, conviteEm = '2026-10-10 12:00:00', inicio = INICIO) =>
  L.situacaoLembrete({ tipo, inicio, conviteEm, agora: utc(agora) });

test('antes do horario: aguardar', () => {
  assert.equal(sit(L.WA3B, '2026-10-15T15:59:00Z').acao, L.ACAO_AGUARDAR);
});

test('no horario e na janela: enviar', () => {
  assert.equal(sit(L.WA3A, '2026-10-14T21:00:00Z').acao, L.ACAO_ENVIAR);
  assert.equal(sit(L.WA3B, '2026-10-15T16:10:00Z').acao, L.ACAO_ENVIAR);
  assert.equal(sit(L.WA3C, '2026-10-15T17:50:00Z').acao, L.ACAO_ENVIAR);
});

test('alem da tolerancia: pular como atrasado', () => {
  const r = sit(L.WA3C, '2026-10-15T17:56:00Z');
  assert.equal(r.acao, L.ACAO_PULAR);
  assert.equal(r.motivo, L.MOTIVO_ATRASADO);
  assert.equal(sit(L.WA3A, '2026-10-15T00:01:00Z').motivo, L.MOTIVO_ATRASADO);
});

test('convite enviado depois do horario do lembrete: pular (convite_depois)', () => {
  // Convite as 19:00 da vespera (22:00Z), depois das 18h: wa3a pulado; wa3b segue normal.
  const a = sit(L.WA3A, '2026-10-14T22:05:00Z', '2026-10-14 22:00:00');
  assert.equal(a.acao, L.ACAO_PULAR);
  assert.equal(a.motivo, L.MOTIVO_CONVITE_DEPOIS);
  assert.equal(sit(L.WA3B, '2026-10-15T16:00:00Z', '2026-10-14 22:00:00').acao, L.ACAO_ENVIAR);
});

test('janela 07-21: lembrete devido fora da janela e sem tempo de esperar e pulado', () => {
  // Reuniao 08:00 Brasilia (11:00Z): wa3b devido 06:00, limite 06:30 — a janela so abre 07:00.
  const ini = utc('2026-10-15T11:00:00Z');
  const r = sit(L.WA3B, '2026-10-15T09:05:00Z', '2026-10-10 12:00:00', ini);
  assert.equal(r.acao, L.ACAO_PULAR);
  assert.equal(r.motivo, L.MOTIVO_FORA_JANELA);
  // Reuniao 22:00 Brasilia: wa3c devido 21:45, fora da janela.
  const noite = utc('2026-10-16T01:00:00Z');
  assert.equal(sit(L.WA3C, '2026-10-16T00:46:00Z', '2026-10-10 12:00:00', noite).motivo, L.MOTIVO_FORA_JANELA);
});

test('janela 07-21: se a janela abre antes do limite, espera em vez de pular', () => {
  // Reuniao 08:50 Brasilia (11:50Z): wa3b devido 06:50, limite 07:20 — aguarda ate 07:00 e envia.
  const ini = utc('2026-10-15T11:50:00Z');
  assert.equal(sit(L.WA3B, '2026-10-15T09:55:00Z', '2026-10-10 12:00:00', ini).acao, L.ACAO_AGUARDAR);
  assert.equal(sit(L.WA3B, '2026-10-15T10:00:00Z', '2026-10-10 12:00:00', ini).acao, L.ACAO_ENVIAR);
});

test('janela: 21:00 em ponto ja esta fora (fim exclusivo), 07:00 em ponto dentro', () => {
  assert.equal(L.dentroDaJanela(utc('2026-10-15T00:00:00Z')), false); // 21:00 Brasilia
  assert.equal(L.dentroDaJanela(utc('2026-10-14T23:59:00Z')), true); // 20:59
  assert.equal(L.dentroDaJanela(utc('2026-10-15T10:00:00Z')), true); // 07:00
  assert.equal(L.dentroDaJanela(utc('2026-10-15T09:59:00Z')), false); // 06:59
});

// ══════════════════ CARENCIA ══════════════════

test('carencia: so depois de 10 min da primeira vez que a reuniao foi vista', () => {
  assert.equal(L.carenciaCumprida('2026-10-15 12:00:00', utc('2026-10-15T12:09:59Z')), false);
  assert.equal(L.carenciaCumprida('2026-10-15 12:00:00', utc('2026-10-15T12:10:00Z')), true);
  assert.equal(L.carenciaCumprida(null, utc('2026-10-15T12:10:00Z')), false);
});
