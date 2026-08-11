'use strict';

// Link de candidatura do e-mail de campanha (src/lib/ctaCampanha.js).
//
// ── O QUE ESTE ARQUIVO GUARDA ──
// O bug que originou este modulo nao foi um erro de codigo: foi uma PROMESSA nao cumprida.
// O Incremento 6 instruiu o LLM a nao escrever a URL da vaga "porque o link e inserido
// depois", e o "depois" nunca chegou — durante tres incrementos o e-mail convidava a pessoa
// a se candidatar sem dizer para onde ir. Passou por revisao, por testes e por um deploy.
//
// O que teria pego isso e uma assercao sobre o HTML FINAL que chega ao adaptador. E o que
// os testes 2, 3 e 4 abaixo fazem — e por isso eles inspecionam o corpo entregue, nunca
// "a funcao foi chamada".
//
// ZERO REDE: tudo aqui e funcao pura sobre string. Os testes de ponta a ponta dos dois
// caminhos de envio vivem em promocaoEmailTeste.test.js e promocaoIntegracao.test.js, com
// os dublês de sempre.

const os = require('node:os');
const path = require('node:path');

process.env.DATABASE_PATH = path.join(os.tmpdir(), `vm-test-cta-${process.pid}-${Date.now()}.db`);
process.env.INTERVIEW_MOCK = 'true';
process.env.SESSION_SECRET = 'segredo-de-teste';
process.env.APP_BASE_URL = 'https://entrevista.exemplo.com.br';
process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert/strict');

const { config } = require('../src/config');
const cta = require('../src/lib/ctaCampanha');

// ══════════════════════════════════════════════════════════════
// 1. A URL: slug certo + utm_source=email
// ══════════════════════════════════════════════════════════════

test('montarUrlVaga: aponta para /vaga/:slug com utm_source=email', () => {
  const url = new URL(cta.montarUrlVaga('closer-de-vendas'));

  assert.equal(url.origin, 'https://entrevista.exemplo.com.br');
  assert.equal(url.pathname, '/vaga/closer-de-vendas');
  assert.equal(url.searchParams.get('utm_source'), 'email');
});

test('montarUrlVaga: SO utm_source — sem medium nem campaign', () => {
  // Decisao explicita do Rafael. Um utm_medium a mais nao quebraria nada hoje, mas o painel
  // filtra por utm_source e o combinado era um parametro so.
  const url = new URL(cta.montarUrlVaga('vaga-x'));
  assert.equal([...url.searchParams.keys()].join(','), 'utm_source');
});

test('montarUrlVaga: usa config.baseUrl e tolera barra final', () => {
  assert.match(cta.montarUrlVaga('v', 'https://exemplo.com'), /^https:\/\/exemplo\.com\/vaga\/v\?/);
  assert.match(cta.montarUrlVaga('v', 'https://exemplo.com/'), /^https:\/\/exemplo\.com\/vaga\/v\?/);
  assert.match(cta.montarUrlVaga('v', 'https://exemplo.com///'), /^https:\/\/exemplo\.com\/vaga\/v\?/);
});

test('montarUrlVaga: o valor default de baseUrl e o da config', () => {
  assert.equal(cta.montarUrlVaga('v'), cta.montarUrlVaga('v', config.baseUrl));
});

test('montarUrlVaga: slug com caractere especial e encodado', () => {
  const url = cta.montarUrlVaga('vaga com espaco');
  assert.match(url, /\/vaga\/vaga%20com%20espaco\?utm_source=email$/);
});

test('montarUrlVaga: sem slug devolve string vazia (vaga removida)', () => {
  for (const vazio of ['', null, undefined, '   ']) {
    assert.equal(cta.montarUrlVaga(vazio), '');
  }
});

// ══════════════════════════════════════════════════════════════
// 2. O bloco de CTA
// ══════════════════════════════════════════════════════════════

test('montarCorpoComCta: preserva o corpo e anexa o link ao final', () => {
  const corpo = '<p>Temos uma vaga de Closer.</p>';
  const html = cta.montarCorpoComCta(corpo, 'https://exemplo.com/vaga/x?utm_source=email');

  assert.ok(html.startsWith(corpo), 'o texto do Jean nao pode ser alterado nem reordenado');
  assert.match(html, /<a href="https:\/\/exemplo\.com\/vaga\/x\?utm_source=email">/);
  assert.match(html, /Ver a vaga e me candidatar/);
});

test('montarCorpoComCta: escapa o href (o & de query vira &amp; dentro do atributo)', () => {
  const html = cta.montarCorpoComCta('<p>x</p>', 'https://exemplo.com/vaga/x?a=1&utm_source=email');
  assert.match(html, /href="https:\/\/exemplo\.com\/vaga\/x\?a=1&amp;utm_source=email"/);
  assert.doesNotMatch(html, /a=1&utm/, 'um & cru dentro de atributo e HTML invalido');
});

test('montarCorpoComCta: sem URL devolve o corpo INTOCADO (nada de href vazio)', () => {
  // Um <a href=""> parece funcional e leva a lugar nenhum — pior que nao ter link.
  const corpo = '<p>Temos uma vaga.</p>';
  assert.equal(cta.montarCorpoComCta(corpo, ''), corpo);
  assert.equal(cta.montarCorpoComCta(corpo, null), corpo);
  assert.doesNotMatch(cta.montarCorpoComCta(corpo, ''), /<a /);
});

test('montarCorpoComCta: corpo vazio ou nulo nao quebra', () => {
  const html = cta.montarCorpoComCta(null, 'https://exemplo.com/vaga/x');
  assert.match(html, /<a href="https:\/\/exemplo\.com\/vaga\/x">/);
});

test('montarCorpoComCta: sem CSS inline (cliente de e-mail quebra estilo elaborado)', () => {
  const html = cta.montarCorpoComCta('<p>x</p>', 'https://exemplo.com/vaga/x');
  const bloco = html.slice('<p>x</p>'.length);
  assert.doesNotMatch(bloco, /style=/, 'o proprio prompt do Incremento 6 proibe CSS inline');
});

// ── 5. Link duplicado: limitacao conhecida e DOCUMENTADA ──

test('montarCorpoComCta: corpo que JA tem link para a vaga ainda recebe o bloco', () => {
  // Comportamento deliberado, nao descuido. Detectar duplicata exigiria varrer ancoras e
  // normalizar URLs (com/sem UTM, com/sem barra final, relativas) — complexidade
  // desproporcional para um incomodo estetico. Dois links certos e aceitavel; zero link,
  // que era o estado anterior, nao era.
  const url = cta.montarUrlVaga('closer');
  const corpo = `<p>Veja em <a href="${url}">nossa vaga</a>.</p>`;
  const html = cta.montarCorpoComCta(corpo, url);

  const ocorrencias = html.split(url).length - 1;
  assert.equal(ocorrencias, 2, 'o bloco automatico e adicionado mesmo assim');
});

// ══════════════════════════════════════════════════════════════
// 4. UMA implementacao so — a prova de que teste e disparo nao divergem
// ══════════════════════════════════════════════════════════════

test('montarCorpoFinal: e a composicao exata de montarUrlVaga + montarCorpoComCta', () => {
  // Se alguem um dia reimplementar a montagem num dos dois caminhos de envio, esta
  // igualdade e o que quebra primeiro.
  const corpo = '<p>Corpo qualquer.</p>';
  assert.equal(
    cta.montarCorpoFinal(corpo, 'slug-da-vaga'),
    cta.montarCorpoComCta(corpo, cta.montarUrlVaga('slug-da-vaga')),
  );
});

test('montarCorpoFinal: mesma vaga e mesmo corpo produzem HTML identico, sempre', () => {
  const corpo = '<p>Estamos com uma vaga aberta.</p>';
  assert.equal(cta.montarCorpoFinal(corpo, 'vaga-a'), cta.montarCorpoFinal(corpo, 'vaga-a'));
  assert.notEqual(cta.montarCorpoFinal(corpo, 'vaga-a'), cta.montarCorpoFinal(corpo, 'vaga-b'));
});

test('UTM_SOURCE_CAMPANHA e o valor que o painel vai mostrar como origem', () => {
  assert.equal(cta.UTM_SOURCE_CAMPANHA, 'email');
});

// ── O painel reconhece a origem sem mudanca nenhuma ──

test('a origem "email" atravessa a canonizacao do painel intacta', () => {
  // origemCanonica so reescreve 'direto' e os apelidos de grupo-whats; qualquer outro valor
  // passa cru. E por isso que este incremento nao precisou tocar no painel — mas se essa
  // regra mudar, a campanha some do filtro de Origem e ninguem percebe.
  const { origemCanonica } = require('../src/db/sqlite');
  assert.equal(origemCanonica(cta.UTM_SOURCE_CAMPANHA), 'email');
});
