'use strict';

// B2 — proximaEntrevistaGrupo e a conversao de hora de parede de Brasilia para instante.
//
// Funcoes PURAS: nenhum banco, nenhuma rede, nenhum relogio real. Todo teste passa o `agora`
// explicitamente — e isso que permite exercitar "a reuniao 1 venceu" sem esperar uma semana.
//
// ── POR QUE OS INSTANTES ESPERADOS ESTAO ESCRITOS EM UTC ──
// As assercoes comparam contra Date.UTC(...) montado a mao, e nao contra o resultado de uma
// segunda chamada da funcao sob teste. Comparar a funcao consigo mesma passaria mesmo se ela
// estivesse errada por 3 horas — que e exatamente o bug de fuso que este projeto ja teve
// (ver a nota de paraDataUtc em whatsapp/sequenciaOutbox.js).
//
// Brasilia esta em UTC-3 desde 2019 (sem horario de verao), entao 19:30 em Brasilia = 22:30 UTC.

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  proximaEntrevistaGrupo,
  temEntrevistaGrupoFutura,
  lerEntrevistasGrupo,
  VAZIO,
  INCOMPLETO,
  INVALIDO,
  OK,
} = require('../src/lib/entrevistaGrupo');
const { instanteDeBrasilia, formatarDataBrasilia, formatarHoraBrasilia } = require('../src/lib/fusoBrasilia');

const LINK = 'https://meet.google.com/abc-defg-hij';

// Vaga com as tres reunioes cadastradas em outubro de 2026 (quintas-feiras).
const VAGA_3_REUNIOES = {
  link_meet: LINK,
  entrevista_grupo_1_data: '2026-10-01',
  entrevista_grupo_1_hora: '19:30',
  entrevista_grupo_2_data: '2026-10-08',
  entrevista_grupo_2_hora: '20:00',
  entrevista_grupo_3_data: '2026-10-15',
  entrevista_grupo_3_hora: '09:15',
};

// Instante em UTC a partir da hora de parede de Brasilia (UTC-3), escrito a mao.
const utcDeBrasilia = (ano, mes, dia, hh, mm) => new Date(Date.UTC(ano, mes - 1, dia, hh + 3, mm));

// ══════════════════ instanteDeBrasilia ══════════════════

test('instanteDeBrasilia converte hora de parede de Brasilia para o instante correto (UTC-3)', () => {
  assert.equal(
    instanteDeBrasilia('2026-10-01', '19:30').toISOString(),
    '2026-10-01T22:30:00.000Z',
  );
});

test('instanteDeBrasilia aceita HH:MM:SS (alguns navegadores acrescentam os segundos)', () => {
  assert.equal(
    instanteDeBrasilia('2026-10-01', '19:30:00').toISOString(),
    '2026-10-01T22:30:00.000Z',
  );
});

test('instanteDeBrasilia recusa data impossivel em vez de deslizar de mes', () => {
  // Date.UTC(2026, 1, 31) viraria 3 de marco em silencio — uma reuniao num dia que ninguem
  // escolheu. A checagem de ida e volta e o que impede isso.
  assert.equal(instanteDeBrasilia('2026-02-31', '10:00'), null);
  assert.equal(instanteDeBrasilia('2026-13-01', '10:00'), null);
  assert.equal(instanteDeBrasilia('2026-10-00', '10:00'), null);
});

test('instanteDeBrasilia recusa hora impossivel', () => {
  assert.equal(instanteDeBrasilia('2026-10-01', '25:00'), null);
  assert.equal(instanteDeBrasilia('2026-10-01', '19:60'), null);
});

test('instanteDeBrasilia recusa formato fora de YYYY-MM-DD / HH:MM', () => {
  // Nao ha tolerancia a DD/MM/YYYY de proposito: aceitar duas grafias faria "02/10" significar
  // coisas diferentes em lugares diferentes.
  assert.equal(instanteDeBrasilia('01/10/2026', '19:30'), null);
  assert.equal(instanteDeBrasilia('2026-10-01', '19h30'), null);
  assert.equal(instanteDeBrasilia('2026-10-01', '7:30'), null);
  assert.equal(instanteDeBrasilia('', ''), null);
  assert.equal(instanteDeBrasilia(null, null), null);
  assert.equal(instanteDeBrasilia(undefined, undefined), null);
});

test('instanteDeBrasilia aceita ano bissexto de verdade (29/02/2028)', () => {
  assert.equal(instanteDeBrasilia('2028-02-29', '12:00').toISOString(), '2028-02-29T15:00:00.000Z');
  assert.equal(instanteDeBrasilia('2027-02-29', '12:00'), null);
});

// ── VIRADA DE FUSO / DIA CIVIL ──

test('virada de dia: 21:00 em Brasilia e ja o dia seguinte em UTC, e o dia da semana e o de Brasilia', () => {
  // 01/10/2026 as 21:00 em Brasilia = 02/10 00:00 UTC. Se o dia da semana fosse lido do
  // instante em UTC, a mensagem anunciaria sexta-feira uma reuniao de quinta.
  const instante = instanteDeBrasilia('2026-10-01', '21:00');
  assert.equal(instante.toISOString(), '2026-10-02T00:00:00.000Z');
  assert.match(formatarDataBrasilia(instante), /^quinta-feira, 01\/10\/2026$/);
  assert.equal(formatarHoraBrasilia(instante), '21:00');
});

test('virada de dia: 00:30 em Brasilia continua sendo o dia cadastrado', () => {
  const instante = instanteDeBrasilia('2026-10-02', '00:30');
  assert.equal(instante.toISOString(), '2026-10-02T03:30:00.000Z');
  assert.match(formatarDataBrasilia(instante), /02\/10\/2026$/);
  assert.equal(formatarHoraBrasilia(instante), '00:30');
});

test('janeiro (onde havia horario de verao antes de 2019) usa o offset REAL do dia, nao um cravado', () => {
  // Brasil nao tem mais horario de verao: janeiro de 2027 tambem e UTC-3. O teste existe para
  // travar que a leitura vem de Intl (que acompanha a regra) e nao de um numero escrito no
  // codigo — se o horario de verao voltar, este teste muda junto com a realidade.
  assert.equal(instanteDeBrasilia('2027-01-15', '19:30').toISOString(), '2027-01-15T22:30:00.000Z');
});

test('data ANTERIOR a 2019 usa o offset vigente naquela data (horario de verao de verdade)', () => {
  // 15/01/2018 estava em horario de verao (UTC-2). A funcao tem que devolver 21:30Z para
  // 19:30 de parede — e nao 22:30Z. E a prova de que o offset e consultado por instante.
  assert.equal(instanteDeBrasilia('2018-01-15', '19:30').toISOString(), '2018-01-15T21:30:00.000Z');
});

// ══════════════════ lerEntrevistasGrupo ══════════════════

test('lerEntrevistasGrupo devolve os 3 slots na ordem, com o estado de cada um', () => {
  const lidas = lerEntrevistasGrupo({
    entrevista_grupo_1_data: '2026-10-01',
    entrevista_grupo_1_hora: '19:30',
    entrevista_grupo_2_data: '2026-10-08', // sem hora
    entrevista_grupo_3_data: '2026-02-31', // data impossivel
    entrevista_grupo_3_hora: '10:00',
  });

  assert.equal(lidas.length, 3);
  assert.deepEqual(lidas.map((l) => l.indice), [1, 2, 3]);
  assert.equal(lidas[0].estado, OK);
  assert.equal(lidas[1].estado, INCOMPLETO);
  assert.equal(lidas[2].estado, INVALIDO);
  assert.ok(lidas[0].instante instanceof Date);
  assert.equal(lidas[1].instante, null);
  assert.equal(lidas[2].instante, null);
});

test('lerEntrevistasGrupo: slot sem nada e vazio (o caso normal dos slots 2 e 3)', () => {
  const lidas = lerEntrevistasGrupo({ entrevista_grupo_1_data: '2026-10-01', entrevista_grupo_1_hora: '19:30' });
  assert.equal(lidas[1].estado, VAZIO);
  assert.equal(lidas[2].estado, VAZIO);
});

test('lerEntrevistasGrupo nao quebra com vaga nula, vazia ou sem os campos', () => {
  for (const vaga of [null, undefined, {}, { titulo: 'Closer' }]) {
    const lidas = lerEntrevistasGrupo(vaga);
    assert.equal(lidas.length, 3);
    assert.ok(lidas.every((l) => l.estado === VAZIO));
  }
});

// ══════════════════ proximaEntrevistaGrupo — os casos pedidos ══════════════════

test('3 datas futuras: escolhe a PRIMEIRA (a mais proxima)', () => {
  const agora = utcDeBrasilia(2026, 9, 25, 10, 0); // 25/09/2026 10:00 Brasilia
  const p = proximaEntrevistaGrupo(VAGA_3_REUNIOES, agora);

  assert.ok(p);
  assert.equal(p.indice, 1);
  assert.equal(p.data, '2026-10-01');
  assert.equal(p.hora, '19:30');
  assert.equal(p.linkMeet, LINK);
  assert.equal(p.instante.toISOString(), '2026-10-01T22:30:00.000Z');
  assert.equal(p.dataTexto, 'quinta-feira, 01/10/2026');
  assert.equal(p.horaTexto, '19:30');
});

test('1a vencida: passa a usar a 2a, sem ninguem editar a vaga', () => {
  // 02/10 (um dia depois da reuniao 1): a mensagem tem que anunciar a reuniao 2.
  const agora = utcDeBrasilia(2026, 10, 2, 8, 0);
  const p = proximaEntrevistaGrupo(VAGA_3_REUNIOES, agora);

  assert.equal(p.indice, 2);
  assert.equal(p.data, '2026-10-08');
  assert.equal(p.horaTexto, '20:00');
});

test('1a e 2a vencidas: passa a usar a 3a', () => {
  const agora = utcDeBrasilia(2026, 10, 9, 8, 0);
  const p = proximaEntrevistaGrupo(VAGA_3_REUNIOES, agora);

  assert.equal(p.indice, 3);
  assert.equal(p.data, '2026-10-15');
  assert.equal(p.horaTexto, '09:15');
  assert.equal(p.dataTexto, 'quinta-feira, 15/10/2026');
});

test('todas vencidas: null — NUNCA devolve link vencido', () => {
  // E o cenario que o fallback da mensagem existe para cobrir. Devolver a ultima reuniao
  // "porque e a mais recente" mandaria o candidato para uma sala que nao abre mais.
  const agora = utcDeBrasilia(2026, 10, 16, 8, 0);
  assert.equal(proximaEntrevistaGrupo(VAGA_3_REUNIOES, agora), null);
  assert.equal(temEntrevistaGrupoFutura(VAGA_3_REUNIOES, agora), false);
});

test('reuniao exatamente "agora" conta como FUTURA (comparacao inclusiva)', () => {
  // Uma sala que abre neste minuto ainda serve. O erro do outro lado seria mandar "datas em
  // breve" para alguem cuja reuniao esta comecando.
  const exatamente = new Date('2026-10-01T22:30:00.000Z'); // 19:30 em Brasilia
  const p = proximaEntrevistaGrupo(VAGA_3_REUNIOES, exatamente);
  assert.ok(p, 'a reuniao que comeca exatamente agora deveria ser considerada futura');
  assert.equal(p.indice, 1);

  // Um milissegundo depois ela ja venceu e a vez passa para a reuniao 2.
  const umMsDepois = new Date(exatamente.getTime() + 1);
  assert.equal(proximaEntrevistaGrupo(VAGA_3_REUNIOES, umMsDepois).indice, 2);
});

test('campos vazios: sem nenhuma reuniao cadastrada devolve null', () => {
  const agora = utcDeBrasilia(2026, 9, 25, 10, 0);
  assert.equal(proximaEntrevistaGrupo({ link_meet: LINK }, agora), null);
  assert.equal(
    proximaEntrevistaGrupo(
      { link_meet: LINK, entrevista_grupo_1_data: '', entrevista_grupo_1_hora: '' },
      agora,
    ),
    null,
  );
});

test('par incompleto (data sem hora, ou hora sem data) e ignorado, e os validos seguem valendo', () => {
  const agora = utcDeBrasilia(2026, 9, 25, 10, 0);
  const p = proximaEntrevistaGrupo(
    {
      link_meet: LINK,
      entrevista_grupo_1_data: '2026-10-01', // sem hora -> ignorada
      entrevista_grupo_2_data: '2026-10-08',
      entrevista_grupo_2_hora: '20:00',
      entrevista_grupo_3_hora: '09:15', // sem data -> ignorada
    },
    agora,
  );
  assert.equal(p.indice, 2);
});

test('data invalida num slot nao contamina os outros', () => {
  const agora = utcDeBrasilia(2026, 9, 25, 10, 0);
  const p = proximaEntrevistaGrupo(
    {
      link_meet: LINK,
      entrevista_grupo_1_data: '2026-02-31',
      entrevista_grupo_1_hora: '10:00',
      entrevista_grupo_2_data: '2026-10-08',
      entrevista_grupo_2_hora: '20:00',
    },
    agora,
  );
  assert.equal(p.indice, 2);
});

test('sem link do Meet: null mesmo com datas futuras (decisao de negocio)', () => {
  const agora = utcDeBrasilia(2026, 9, 25, 10, 0);
  const semLink = { ...VAGA_3_REUNIOES, link_meet: null };
  const linkVazio = { ...VAGA_3_REUNIOES, link_meet: '   ' };

  assert.equal(proximaEntrevistaGrupo(semLink, agora), null);
  assert.equal(proximaEntrevistaGrupo(linkVazio, agora), null);
  assert.equal(temEntrevistaGrupoFutura(semLink, agora), false);
});

test('ordem cronologica vence a ordem dos slots: cadastro fora de ordem ainda acerta', () => {
  // Erro de digitacao provavel (a reuniao mais proxima cadastrada no slot 3). A leitura literal
  // por slot mandaria a data errada; ordenar por instante transforma o erro em nada.
  const agora = utcDeBrasilia(2026, 9, 25, 10, 0);
  const foraDeOrdem = {
    link_meet: LINK,
    entrevista_grupo_1_data: '2026-10-15',
    entrevista_grupo_1_hora: '09:15',
    entrevista_grupo_2_data: '2026-10-08',
    entrevista_grupo_2_hora: '20:00',
    entrevista_grupo_3_data: '2026-10-01',
    entrevista_grupo_3_hora: '19:30',
  };
  const p = proximaEntrevistaGrupo(foraDeOrdem, agora);
  assert.equal(p.indice, 3);
  assert.equal(p.data, '2026-10-01');
});

test('duas reunioes no MESMO instante: escolhe uma so, de forma estavel', () => {
  // Nao ha "certa" aqui; o que nao pode e a escolha mudar entre duas chamadas iguais, porque
  // o texto da mensagem mudaria entre uma retentativa e a seguinte.
  const agora = utcDeBrasilia(2026, 9, 25, 10, 0);
  const empate = {
    link_meet: LINK,
    entrevista_grupo_1_data: '2026-10-01',
    entrevista_grupo_1_hora: '19:30',
    entrevista_grupo_2_data: '2026-10-01',
    entrevista_grupo_2_hora: '19:30',
  };
  const a = proximaEntrevistaGrupo(empate, agora);
  const b = proximaEntrevistaGrupo(empate, agora);
  assert.equal(a.indice, b.indice);
  assert.equal(a.indice, 1);
});

test('funcao PURA: nao muta a vaga recebida', () => {
  const vaga = { ...VAGA_3_REUNIOES };
  const copia = JSON.parse(JSON.stringify(vaga));
  proximaEntrevistaGrupo(vaga, utcDeBrasilia(2026, 9, 25, 10, 0));
  assert.deepEqual(vaga, copia);
});

test('vaga nula/undefined e `agora` invalido nao lancam', () => {
  const agora = utcDeBrasilia(2026, 9, 25, 10, 0);
  assert.equal(proximaEntrevistaGrupo(null, agora), null);
  assert.equal(proximaEntrevistaGrupo(undefined, agora), null);
  assert.equal(proximaEntrevistaGrupo({}, agora), null);
  assert.equal(proximaEntrevistaGrupo(VAGA_3_REUNIOES, new Date('nao e data')), null);
});

test('aceita `agora` como string/numero (nunca lanca por tipo do parametro)', () => {
  assert.equal(proximaEntrevistaGrupo(VAGA_3_REUNIOES, '2026-09-25T13:00:00.000Z').indice, 1);
  assert.equal(
    proximaEntrevistaGrupo(VAGA_3_REUNIOES, Date.UTC(2026, 9, 2, 11, 0)).indice,
    2,
  );
});

// ══════════════════ A EXTRACAO DO FUSO NAO MUDOU whatsappFicha ══════════════════

test('whatsappFicha continua exportando FUSO_BRASILIA/offsetMinutos e usa o modulo folha', () => {
  const ficha = require('../src/lib/whatsappFicha');
  const fuso = require('../src/lib/fusoBrasilia');
  assert.equal(ficha.FUSO_BRASILIA, 'America/Sao_Paulo');
  assert.equal(ficha.FUSO_BRASILIA, fuso.FUSO_BRASILIA);
  assert.equal(ficha.offsetMinutos, fuso.offsetMinutos, 'tem que ser a MESMA funcao, nao uma copia');
  // O comportamento que dependia dela segue igual: -180 min em outubro de 2026.
  assert.equal(ficha.offsetMinutos(new Date('2026-10-01T12:00:00Z'), 'America/Sao_Paulo'), -180);
});

test('calcularPrazoAmanhaMeioDia continua correto depois da extracao', () => {
  // O consumidor original do offset. Meio-dia de Brasilia = 15:00Z.
  const { calcularPrazoAmanhaMeioDia } = require('../src/lib/whatsappFicha');
  const prazo = calcularPrazoAmanhaMeioDia(new Date('2026-10-01T13:00:00Z'));
  assert.equal(prazo.toISOString(), '2026-10-02T15:00:00.000Z');
});
