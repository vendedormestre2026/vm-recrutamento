'use strict';

// WA3 (incremento 3) — textos dos lembretes: 3 variacoes por tipo, nenhum token sem resolver,
// linha do Calendly opcional, sala obrigatoria, sem nome nao vira "Oi, !".

const test = require('node:test');
const assert = require('node:assert/strict');

const T = require('../src/lib/textosLembreteEntrevista');
const { TIPOS, WA3A, WA3B, WA3C } = require('../src/lib/lembreteEntrevista');

const INICIO = new Date('2026-10-15T18:00:00Z'); // quinta 15/10 15:00 Brasilia
const MEET = 'https://meet.google.com/abc-defg-hij';
const CALENDLY = 'https://calendly.com/vm/entrevista';
const JOB = { titulo: 'Closer de Vendas | Acme', empresa: 'Acme', link_meet_reuniao: MEET, link_meet: CALENDLY };

// Forca a variacao `i` (0..2) pelo sorteio injetado.
const fixo = (i) => () => (i + 0.5) / 3;

const todas = () => TIPOS.flatMap((tipo) => [0, 1, 2].map((i) => ({ tipo, i })));

test('3 variacoes por tipo, e toda variacao tem a sala do Meet', () => {
  for (const tipo of TIPOS) {
    assert.equal(T.VARIACOES[tipo].length, 3, tipo);
    for (const v of T.VARIACOES[tipo]) assert.ok(v.join('\n').includes('{meet_url}'), `${tipo}: ${v[0]}`);
  }
});

test('textos aprovados (variacoes 1 e 2) preservados palavra por palavra', () => {
  const junto = (tipo, i) => T.VARIACOES[tipo][i].join(' ');
  assert.equal(
    junto(WA3A, 0),
    'Oi, {nome}! Lembrete: amanhã ({data}) às {hora} tem a entrevista em grupo da vaga {vaga}, pelo Google Meet. ' +
      'Já se inscreveu? É só entrar por aqui na hora: {meet_url} Ainda não? Inscreva-se: {calendly_url}',
  );
  assert.equal(junto(WA3C, 0), '{nome}, começa em 15 minutos! Entre agora: {meet_url}');
  assert.equal(
    junto(WA3B, 1),
    'Faltam 2 horas! Entrevista em grupo de {vaga} hoje às {hora}. Separe um lugar tranquilo e entre por aqui: {meet_url}',
  );
});

test('todas as variacoes resolvem sem token sobrando, com data/hora de Brasilia e titulo sem "| empresa"', () => {
  for (const { tipo, i } of todas()) {
    const r = T.montarTextoLembrete({ tipo, nome: 'Maria Souza', job: JOB, inicio: INICIO, aleatorio: fixo(i) });
    assert.deepEqual(r.faltando, [], `${tipo}/${i + 1}`);
    assert.equal(r.variacaoIndice, i + 1);
    assert.doesNotMatch(r.texto, /[{}]/, `${tipo}/${i + 1}: ${r.texto}`);
    assert.ok(r.texto.includes(MEET));
    assert.doesNotMatch(r.texto, /\| Acme/);
    if (r.texto.includes('{hora}') || /\d{2}:\d{2}/.test(r.texto)) assert.match(r.texto, /15:00/);
    assert.doesNotMatch(r.texto, new RegExp(`${MEET.replace(/[.]/g, '\\.')}[.,]`), 'URL com pontuacao colada');
  }
  const a = T.montarTextoLembrete({ tipo: WA3A, nome: 'Maria Souza', job: JOB, inicio: INICIO, aleatorio: fixo(0) });
  assert.match(a.texto, /^Oi, Maria! Lembrete: amanhã \(quinta-feira, 15\/10\/2026\) às 15:00/);
  assert.match(a.texto, /vaga Closer de Vendas, pelo/);
});

test('sem Calendly a linha dele some inteira, e o resto continua', () => {
  const job = { ...JOB, link_meet: '' };
  for (const { tipo, i } of todas()) {
    const r = T.montarTextoLembrete({ tipo, nome: 'Maria', job, inicio: INICIO, aleatorio: fixo(i) });
    assert.deepEqual(r.faltando, []);
    assert.doesNotMatch(r.texto, /calendly|Inscreva-se:|confirmou presença/i, `${tipo}/${i + 1}`);
    assert.ok(r.texto.includes(MEET));
  }
});

test('com Calendly, a linha dele aparece com o link', () => {
  const r = T.montarTextoLembrete({ tipo: WA3A, nome: 'Maria', job: JOB, inicio: INICIO, aleatorio: fixo(0) });
  assert.match(r.texto, new RegExp(`Inscreva-se: ${CALENDLY.replace(/[.]/g, '\\.')}$`));
});

test('sem sala do Meet: faltando=meet_url (o worker nao envia)', () => {
  const r = T.montarTextoLembrete({ tipo: WA3C, nome: 'Maria', job: { ...JOB, link_meet_reuniao: '' }, inicio: INICIO, aleatorio: fixo(0) });
  assert.ok(r.faltando.includes('meet_url'));
});

test('sem nome: saudacao sem o nome, frase comeca com maiuscula, nada de ", !"', () => {
  for (const { tipo, i } of todas()) {
    const r = T.montarTextoLembrete({ tipo, nome: '', job: JOB, inicio: INICIO, aleatorio: fixo(i) });
    assert.deepEqual(r.faltando, [], `${tipo}/${i + 1}`);
    assert.doesNotMatch(r.texto, /,\s*[!?.,]|^\s*,|\{nome\}/m, `${tipo}/${i + 1}: ${r.texto}`);
    for (const linha of r.texto.split('\n')) assert.match(linha, /^[A-ZÁÉÍÓÚÂÊÔÃÕ]/, `${tipo}/${i + 1}: ${linha}`);
  }
  const a = T.montarTextoLembrete({ tipo: WA3A, nome: null, job: JOB, inicio: INICIO, aleatorio: fixo(0) });
  assert.match(a.texto, /^Oi! Lembrete:/);
  const b = T.montarTextoLembrete({ tipo: WA3A, nome: '', job: JOB, inicio: INICIO, aleatorio: fixo(1) });
  assert.match(b.texto, /^Passando para lembrar/);
});

test('sorteio cobre as 3 variacoes e nunca sai do intervalo (aleatorio = 0 e ~1)', () => {
  assert.equal(T.montarTextoLembrete({ tipo: WA3B, nome: 'A', job: JOB, inicio: INICIO, aleatorio: () => 0 }).variacaoIndice, 1);
  assert.equal(T.montarTextoLembrete({ tipo: WA3B, nome: 'A', job: JOB, inicio: INICIO, aleatorio: () => 0.9999 }).variacaoIndice, 3);
});
