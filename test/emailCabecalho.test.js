'use strict';

// Cabecalho do e-mail de campanha: a marca em papel de apoio e a VAGA em destaque.
//
// ── O QUE MUDOU, e por que os testes olham TAMANHO DE FONTE ──
// Antes o cabecalho era 'VENDEDOR MESTRE' em 26px laranja — o maior elemento do e-mail.
// Quem abre uma divulgacao precisa saber em dois segundos QUAL VAGA e; o remetente e
// contexto, nao manchete. A inversao de prioridade e o ponto da mudanca, e a unica forma
// de trava-la em teste e comparar os tamanhos declarados no style inline.
//
// ── filter(Boolean) ──
// jobs.empresa/endereco/modalidade/regime/horario sao todos NULLABLE, e a densidade real
// deles em producao e desconhecida. Selo so existe se o campo existir — uma vaga so com
// titulo tem que render um cabecalho enxuto, nunca um esburacado.
//
// ZERO REDE, ZERO BANCO: funcoes puras sobre string.

const test = require('node:test');
const assert = require('node:assert/strict');

const cta = require('../src/lib/ctaCampanha');
const marca = require('../src/lib/marcaEmail');

const VAGA_COMPLETA = {
  titulo: 'Closer de Vendas',
  perfil: 'CLOSER',
  empresa: 'Acme Ltda',
  endereco: 'Av. Paulista, 1000 — São Paulo/SP',
  modalidade: 'presencial',
  regime: 'CLT',
  horario: 'Segunda a Sexta, 8h às 18h',
};

const email = (vaga) =>
  cta.montarEmailCampanha({
    corpoHtml: '<p>Corpo do LLM.</p>',
    urlVaga: 'https://exemplo.com/vaga/closer?utm_source=email',
    urlDescadastro: 'https://exemplo.com/descadastro?e=abc&t=123',
    vaga,
  });

// Extrai o font-size de um bloco de style que contenha `marcador`.
function tamanhoFonte(html, marcador) {
  const i = html.indexOf(marcador);
  assert.ok(i > -1, `marcador nao encontrado: ${marcador}`);
  const trechoAntes = html.slice(0, i);
  const abre = trechoAntes.lastIndexOf('style="');
  const style = html.slice(abre + 7, html.indexOf('"', abre + 7));
  const m = style.match(/font-size:(\d+)px/);
  assert.ok(m, `sem font-size em: ${style}`);
  return Number(m[1]);
}

// ══════════════════════════════════════════════════════════════
// 1. A hierarquia visual — o coracao da mudanca
// ══════════════════════════════════════════════════════════════

test('o titulo da VAGA e maior que a marca', () => {
  const html = email(VAGA_COMPLETA);
  const marcaPx = tamanhoFonte(html, 'VENDEDOR MESTRE');
  const vagaPx = tamanhoFonte(html, 'Closer de Vendas');

  assert.ok(vagaPx > marcaPx, `titulo (${vagaPx}px) tem que ser maior que a marca (${marcaPx}px)`);
  assert.ok(marcaPx <= 12, `a marca virou apoio: ${marcaPx}px deveria ser discreto`);
});

test('a marca NAO e mais o maior elemento do cabecalho', () => {
  const html = email(VAGA_COMPLETA);
  const marcaPx = tamanhoFonte(html, 'VENDEDOR MESTRE');
  for (const outro of ['Vaga aberta', 'Closer de Vendas']) {
    assert.ok(tamanhoFonte(html, outro) >= marcaPx, `${outro} nao pode ser menor que a marca`);
  }
});

test('a marca continua presente, so que discreta', () => {
  // Discreta nao e ausente: o e-mail continua se identificando.
  assert.ok(email(VAGA_COMPLETA).includes(cta.TITULO_CABECALHO));
});

// ══════════════════════════════════════════════════════════════
// 2. Os campos da vaga
// ══════════════════════════════════════════════════════════════

test('o kicker traz "Vaga aberta" e o perfil', () => {
  assert.match(email(VAGA_COMPLETA), /Vaga aberta · Perfil CLOSER/);
});

test('sem perfil, o kicker degrada para so "Vaga aberta"', () => {
  const html = email({ titulo: 'Vendedor', perfil: null });
  assert.match(html, /Vaga aberta/);
  assert.doesNotMatch(html, /Perfil/);
});

test('todos os selos aparecem quando os campos existem', () => {
  const html = email(VAGA_COMPLETA);
  assert.match(html, /🏙 Acme Ltda/);
  assert.match(html, /📍 Av\. Paulista, 1000 — São Paulo\/SP/);
  assert.match(html, /🏢 Presencial/, 'modalidade capitalizada, como na landing');
  assert.match(html, /📄 CLT/);
  assert.match(html, /🕐 Segunda a Sexta, 8h às 18h/);
});

test('modalidade e capitalizada (vem minuscula do banco)', () => {
  for (const [bruta, exibida] of [['presencial', 'Presencial'], ['remoto', 'Remoto'], ['híbrido', 'Híbrido']]) {
    assert.match(email({ titulo: 'X', modalidade: bruta }), new RegExp(`🏢 ${exibida}`));
  }
});

// ══════════════════════════════════════════════════════════════
// 3. filter(Boolean): campo vazio nao deixa buraco
// ══════════════════════════════════════════════════════════════

test('vaga so com titulo: cabecalho enxuto, nenhum selo vazio', () => {
  const html = email({ titulo: 'Vendedor Interno', perfil: 'SDR' });

  assert.match(html, /Vendedor Interno/);
  for (const emoji of ['🏙', '📍', '🏢', '📄', '🕐']) {
    assert.ok(!html.includes(emoji), `nao pode haver selo ${emoji} sem o campo`);
  }
  // E nenhum selo vazio sobrou como casca.
  assert.doesNotMatch(html, new RegExp(`style="${marca.estiloSelo().replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"\\s*>\\s*<`));
});

test('empresa aparece so quando preenchida', () => {
  assert.match(email({ titulo: 'X', empresa: 'Acme Ltda' }), /🏙 Acme Ltda/);
  for (const vazio of [null, undefined, '']) {
    assert.ok(!email({ titulo: 'X', empresa: vazio }).includes('🏙'), `empresa=${JSON.stringify(vazio)}`);
  }
});

test('cada selo some sozinho, sem afetar os outros', () => {
  const html = email({ titulo: 'X', empresa: 'Acme', horario: '8h às 18h' });
  assert.match(html, /🏙 Acme/);
  assert.match(html, /🕐 8h às 18h/);
  assert.ok(!html.includes('📍'), 'sem endereco, sem selo de local');
  assert.ok(!html.includes('🏢'), 'sem modalidade, sem selo dela');
});

// ══════════════════════════════════════════════════════════════
// 4. Degradacao sem vaga
// ══════════════════════════════════════════════════════════════

test('sem vaga (removida), o cabecalho degrada para so a marca', () => {
  for (const semVaga of [null, undefined, {}, { titulo: '' }]) {
    const html = email(semVaga);
    assert.ok(html.includes(cta.TITULO_CABECALHO), 'a marca continua');
    assert.doesNotMatch(html, /Vaga aberta/, 'sem titulo nao ha kicker');
    // E o resto do e-mail sobrevive: corpo, botao e rodape.
    assert.match(html, /Corpo do LLM/);
    assert.match(html, new RegExp(cta.TEXTO_BOTAO_CTA));
    assert.ok(html.includes(cta.TEXTO_LINK_DESCADASTRO));
  }
});

// ══════════════════════════════════════════════════════════════
// 5. Escape e disciplina de e-mail
// ══════════════════════════════════════════════════════════════

test('dados da vaga sao escapados (titulo e texto do recrutador)', () => {
  const html = email({ titulo: '<script>alert(1)</script>', empresa: 'A & B' });
  assert.doesNotMatch(html, /<script>/);
  assert.match(html, /&lt;script&gt;/);
  assert.match(html, /A &amp; B/);
});

test('o cabecalho continua sem CSS externo e sem <style>', () => {
  const html = email(VAGA_COMPLETA);
  assert.doesNotMatch(html, /<style|@import|fonts\.googleapis|<link/i);
});

test('a paleta do cabecalho continua fechada nas cores da marca', () => {
  const html = email(VAGA_COMPLETA);
  const hexes = new Set((html.match(/#[0-9A-Fa-f]{3,6}\b/g) || []).map((h) => h.toUpperCase()));
  const permitidos = new Set([marca.PRETO, marca.LARANJA, marca.OFFWHITE, marca.BRANCO]);
  for (const hex of hexes) assert.ok(permitidos.has(hex), `cor fora da paleta: ${hex}`);
});

test('blocoCabecalho devolve linhas de tabela, encaixaveis na moldura', () => {
  const bloco = cta.blocoCabecalho(VAGA_COMPLETA);
  assert.match(bloco, /^<tr>/);
  assert.match(bloco, /<\/tr>$/);
});

// ══════════════════════════════════════════════════════════════
// 6. A vaga chega pela assinatura, e muda o HTML
// ══════════════════════════════════════════════════════════════

test('montarCorpoFinal repassa a vaga para o cabecalho', () => {
  const comVaga = cta.montarCorpoFinal('<p>x</p>', 'slug', 'https://x.com/descadastro?e=a&t=b', VAGA_COMPLETA);
  const semVaga = cta.montarCorpoFinal('<p>x</p>', 'slug', 'https://x.com/descadastro?e=a&t=b');

  assert.match(comVaga, /Closer de Vendas/);
  assert.doesNotMatch(semVaga, /Closer de Vendas/);
  assert.notEqual(comVaga, semVaga, 'a vaga tem que mudar o HTML final');
});

test('mesma vaga e mesmas entradas produzem HTML identico', () => {
  const a = cta.montarCorpoFinal('<p>x</p>', 's', 'https://x/d?e=1&t=2', VAGA_COMPLETA);
  const b = cta.montarCorpoFinal('<p>x</p>', 's', 'https://x/d?e=1&t=2', { ...VAGA_COMPLETA });
  assert.equal(a, b);
});
