'use strict';

// Helper de UTM (src/lib/utm.js). Funcoes puras, sem banco/rede/chaves — este arquivo
// nao toca DATABASE_PATH nem providers. Cobre normalizacao, extracao da query, leitura
// do cookie (incl. legado string simples e JSON corrompido) e round-trip serializa/le.

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  normalizarValorUtm,
  extrairUtmDaQuery,
  lerUtmDoCookie,
  serializarUtmParaCookie,
} = require('../src/lib/utm');

test('normalizarValorUtm: trim de espacos', () => {
  assert.equal(normalizarValorUtm('  instagram  '), 'instagram');
});

test('normalizarValorUtm: lowercase', () => {
  assert.equal(normalizarValorUtm('Google'), 'google');
  assert.equal(normalizarValorUtm('  FaceBook '), 'facebook');
});

test('normalizarValorUtm: string vazia (ou so espacos) vira null', () => {
  assert.equal(normalizarValorUtm(''), null);
  assert.equal(normalizarValorUtm('   '), null);
});

test('normalizarValorUtm: null/undefined/nao-string viram null', () => {
  assert.equal(normalizarValorUtm(null), null);
  assert.equal(normalizarValorUtm(undefined), null);
  assert.equal(normalizarValorUtm(123), null);
  assert.equal(normalizarValorUtm({}), null);
  assert.equal(normalizarValorUtm(['x']), null);
});

test('normalizarValorUtm: trunca em 100 caracteres', () => {
  const entrada = 'a'.repeat(250);
  const saida = normalizarValorUtm(entrada);
  assert.equal(saida.length, 100);
  assert.equal(saida, 'a'.repeat(100));
});

test('extrairUtmDaQuery: query vazia -> null', () => {
  assert.equal(extrairUtmDaQuery({}), null);
  assert.equal(extrairUtmDaQuery(undefined), null);
});

test('extrairUtmDaQuery: so utm_source -> objeto com os demais null', () => {
  const r = extrairUtmDaQuery({ utm_source: 'Instagram' });
  assert.deepEqual(r, {
    source: 'instagram',
    medium: null,
    campaign: null,
    content: null,
    term: null,
  });
});

test('extrairUtmDaQuery: os cinco parametros', () => {
  const r = extrairUtmDaQuery({
    utm_source: 'google',
    utm_medium: 'cpc',
    utm_campaign: 'black-friday',
    utm_content: 'anuncio-a',
    utm_term: 'vendedor',
  });
  assert.deepEqual(r, {
    source: 'google',
    medium: 'cpc',
    campaign: 'black-friday',
    content: 'anuncio-a',
    term: 'vendedor',
  });
});

test('extrairUtmDaQuery: ignora parametros nao-UTM na query', () => {
  const r = extrairUtmDaQuery({ slug: 'vaga-x', foo: 'bar', utm_source: 'linkedin' });
  assert.deepEqual(r, {
    source: 'linkedin',
    medium: null,
    campaign: null,
    content: null,
    term: null,
  });
});

test('lerUtmDoCookie: JSON valido (objeto completo)', () => {
  const bruto = JSON.stringify({
    source: 'google',
    medium: 'cpc',
    campaign: 'x',
    content: 'y',
    term: 'z',
  });
  assert.deepEqual(lerUtmDoCookie(bruto), {
    source: 'google',
    medium: 'cpc',
    campaign: 'x',
    content: 'y',
    term: 'z',
  });
});

test('lerUtmDoCookie: string legada ("instagram") -> source preenchido, demais null', () => {
  assert.deepEqual(lerUtmDoCookie('instagram'), {
    source: 'instagram',
    medium: null,
    campaign: null,
    content: null,
    term: null,
  });
});

test('lerUtmDoCookie: JSON corrompido nao lanca excecao (cai no legado)', () => {
  let r;
  assert.doesNotThrow(() => {
    r = lerUtmDoCookie('{"source":"google",'); // JSON truncado/invalido
  });
  // Tratado como string legada inteira -> source (normalizado).
  assert.equal(r.source, '{"source":"google",'.toLowerCase());
  assert.equal(r.medium, null);
});

test('lerUtmDoCookie: vazio/nao-string -> null', () => {
  assert.equal(lerUtmDoCookie(''), null);
  assert.equal(lerUtmDoCookie('   '), null);
  assert.equal(lerUtmDoCookie(null), null);
  assert.equal(lerUtmDoCookie(undefined), null);
});

test('lerUtmDoCookie: JSON valido mas nao-objeto (numero) -> tratado como legado', () => {
  // JSON.parse('123') === 123 (nao-objeto): por seguranca vira source legado.
  assert.deepEqual(lerUtmDoCookie('123'), {
    source: '123',
    medium: null,
    campaign: null,
    content: null,
    term: null,
  });
});

test('serializarUtmParaCookie: null -> null', () => {
  assert.equal(serializarUtmParaCookie(null), null);
  assert.equal(serializarUtmParaCookie(undefined), null);
});

test('round-trip: serializar -> ler devolve o mesmo objeto', () => {
  const original = {
    source: 'google',
    medium: 'cpc',
    campaign: 'black-friday',
    content: 'anuncio-a',
    term: 'vendedor',
  };
  const cookie = serializarUtmParaCookie(original);
  assert.equal(typeof cookie, 'string');
  assert.deepEqual(lerUtmDoCookie(cookie), original);
});

test('round-trip: objeto vindo de extrairUtmDaQuery sobrevive ao cookie', () => {
  const daQuery = extrairUtmDaQuery({ utm_source: 'Google', utm_medium: 'CPC' });
  const cookie = serializarUtmParaCookie(daQuery);
  assert.deepEqual(lerUtmDoCookie(cookie), daQuery);
});
