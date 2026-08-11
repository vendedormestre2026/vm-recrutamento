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
const marca = require('../src/lib/marcaEmail');

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
  // baseUrl passou a ser opcao NOMEADA quando `campanhaId` entrou: dois opcionais
  // posicionais (um numero e uma URL) seriam indistinguiveis para quem le a chamada.
  for (const base of ['https://exemplo.com', 'https://exemplo.com/', 'https://exemplo.com///']) {
    assert.match(cta.montarUrlVaga('v', { baseUrl: base }), /^https:\/\/exemplo\.com\/vaga\/v\?/);
  }
});

test('montarUrlVaga: o valor default de baseUrl e o da config', () => {
  assert.equal(cta.montarUrlVaga('v'), cta.montarUrlVaga('v', { baseUrl: config.baseUrl }));
});

// ── campanha_id: a atribuicao exata do clique ──

test('montarUrlVaga: inclui campanha_id quando ha campanha', () => {
  const url = new URL(cta.montarUrlVaga('closer', { campanhaId: 42 }));
  assert.equal(url.searchParams.get('campanha_id'), '42');
  assert.equal(url.searchParams.get('utm_source'), 'email', 'a UTM continua junto');
});

test('montarUrlVaga: SEM campanha, o link nao carrega o parametro', () => {
  // Um `campanha_id=` vazio na URL seria ruido no link e lixo no banco.
  for (const semId of [undefined, null, 0, -1, '', 'abc', 1.5]) {
    const url = new URL(cta.montarUrlVaga('closer', { campanhaId: semId }));
    assert.equal(url.searchParams.has('campanha_id'), false, `campanhaId=${JSON.stringify(semId)}`);
  }
});

test('montarCorpoFinal: repassa o campanhaId para o link do CTA', () => {
  const comId = cta.montarCorpoFinal('<p>x</p>', 'closer', URL_DESC, null, 7);
  const semId = cta.montarCorpoFinal('<p>x</p>', 'closer', URL_DESC, null, null);

  assert.match(comId, /campanha_id=7/);
  assert.doesNotMatch(semId, /campanha_id/);
  assert.notEqual(comId, semId, 'a campanha tem que mudar o HTML final');
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

const URL_VAGA = 'https://exemplo.com/vaga/x?utm_source=email';
const URL_DESC = 'https://exemplo.com/descadastro?e=YWJjQGV4ZW1wbG8uY29t&t=abc123';

// Atalho para o e-mail completo, com os defaults deste arquivo.
const email = (corpo, urlVaga = URL_VAGA, urlDescadastro = URL_DESC) =>
  cta.montarEmailCampanha({ corpoHtml: corpo, urlVaga, urlDescadastro });

test('montarEmailCampanha: o texto do LLM entra INTACTO, sem reescrita nem style injetado', () => {
  // A garantia mais importante da fronteira LLM x moldura: o corpo gerado (ou editado a mao
  // pelo Jean) e copiado byte a byte para dentro do <td> de conteudo. Se alguem um dia
  // resolver "melhorar" o HTML do LLM com regex, isto quebra.
  const corpo = '<p>Temos uma vaga de <strong>Closer</strong>.</p><ul><li>Remoto</li></ul>';
  assert.ok(email(corpo).includes(corpo), 'o corpo tem que aparecer literal no HTML final');
});

test('montarEmailCampanha: o botao leva a URL da vaga e o rotulo em caixa alta', () => {
  const html = email('<p>x</p>');
  assert.match(html, /<a href="https:\/\/exemplo\.com\/vaga\/x\?utm_source=email"/);
  assert.match(html, new RegExp(cta.TEXTO_BOTAO_CTA));
  // Caixa alta na STRING, e nao so via text-transform: o Outlook desktop e irregular com
  // essa propriedade, e o rotulo do botao nao pode depender so dela.
  assert.equal(cta.TEXTO_BOTAO_CTA, cta.TEXTO_BOTAO_CTA.toUpperCase());
});

test('montarEmailCampanha: escapa o href (o & de query vira &amp; dentro do atributo)', () => {
  const html = email('<p>x</p>', 'https://exemplo.com/vaga/x?a=1&utm_source=email');
  assert.match(html, /href="https:\/\/exemplo\.com\/vaga\/x\?a=1&amp;utm_source=email"/);
  assert.doesNotMatch(html, /a=1&utm/, 'um & cru dentro de atributo e HTML invalido');
});

test('montarEmailCampanha: sem URL da vaga, a moldura fica mas o botao SOME', () => {
  // Um <a href=""> parece funcional e leva a lugar nenhum — pior que nao ter botao.
  // MUDANCA em relacao ao comportamento anterior (que devolvia o corpo cru): agora o
  // e-mail continua com cabecalho e rodape. Vaga removida nao e motivo para a mensagem
  // perder a identidade e o link de descadastro.
  // Chamada direta, e nao pelo helper `email()`: passar `undefined` a um parametro com
  // valor default ATIVA o default, e o teste estaria exercitando a URL normal sem perceber.
  for (const vazio of ['', null, undefined]) {
    const html = cta.montarEmailCampanha({
      corpoHtml: '<p>Temos uma vaga.</p>',
      urlVaga: vazio,
      urlDescadastro: URL_DESC,
    });
    assert.doesNotMatch(html, new RegExp(cta.TEXTO_BOTAO_CTA), 'sem vaga, sem botao');
    assert.ok(html.includes(cta.TITULO_CABECALHO), 'o cabecalho continua');
    assert.ok(html.includes(cta.TEXTO_LINK_DESCADASTRO), 'o rodape continua');
    assert.doesNotMatch(html, /href=""/, 'nunca um href vazio');
  }
});

test('montarEmailCampanha: corpo vazio ou nulo nao quebra a moldura', () => {
  for (const vazio of [null, undefined, '']) {
    const html = email(vazio);
    assert.match(html, /<a href="https:\/\/exemplo\.com\/vaga\/x\?utm_source=email"/);
    assert.ok(html.includes(cta.TITULO_CABECALHO));
  }
});

// ── Link duplicado: limitacao conhecida e DOCUMENTADA ──

test('montarEmailCampanha: corpo que JA tem link para a vaga ainda recebe o botao', () => {
  // Comportamento deliberado, nao descuido. Detectar duplicata exigiria varrer ancoras e
  // normalizar URLs (com/sem UTM, com/sem barra final, relativas) — complexidade
  // desproporcional para um incomodo estetico. Dois links certos e aceitavel; zero link,
  // que era o estado anterior, nao era.
  const url = cta.montarUrlVaga('closer');
  const corpo = `<p>Veja em <a href="${url}">nossa vaga</a>.</p>`;
  const html = cta.montarEmailCampanha({ corpoHtml: corpo, urlVaga: url, urlDescadastro: URL_DESC });

  const ocorrencias = html.split(url).length - 1;
  assert.equal(ocorrencias, 2, 'o botao automatico e adicionado mesmo assim');
});

// ══════════════════════════════════════════════════════════════
// 2b. A identidade visual da marca chega ao HTML
// ══════════════════════════════════════════════════════════════

test('montarEmailCampanha: usa as quatro cores da marca e NENHUMA fora da paleta', () => {
  const html = email('<p>x</p>');

  assert.ok(html.includes(marca.PRETO), 'fundo preto');
  assert.ok(html.includes(marca.LARANJA), 'laranja no titulo, botao e link');
  assert.ok(html.includes(marca.OFFWHITE), 'off-white no texto');

  // Nenhum hex alem dos da paleta. Isto e o guarda contra alguem colar um azul de algum
  // template de internet no meio da moldura — a regra da marca proibe azul, roxo, verde,
  // amarelo e vermelho puro (public/css/tokens.css).
  const hexes = new Set((html.match(/#[0-9A-Fa-f]{3,6}\b/g) || []).map((h) => h.toUpperCase()));
  const permitidos = new Set([marca.PRETO, marca.LARANJA, marca.OFFWHITE, marca.BRANCO]);
  for (const hex of hexes) {
    assert.ok(permitidos.has(hex), `cor fora da paleta da marca no e-mail: ${hex}`);
  }
});

test('montarEmailCampanha: tipografia com fallback web-safe, sem Google Fonts', () => {
  const html = email('<p>x</p>');

  assert.ok(html.includes(marca.FONTE_CORPO), 'corpo em Barlow com fallback Arial/Helvetica');
  assert.ok(html.includes(marca.FONTE_TITULO), 'titulo em Barlow Condensed com fallback');

  // Cliente de e-mail bloqueia fonte externa. Um <link>/@import aqui daria a falsa
  // impressao de que a marca renderiza, quando na pratica cairia na fonte default.
  assert.doesNotMatch(html, /fonts\.googleapis|@import|<link/i, 'nada de fonte externa');
  assert.doesNotMatch(html, /<style/i, 'nada de CSS em <style> — parte dos clientes remove');
});

test('montarEmailCampanha: estrutura em <table>, e nao <div> (robustez no Outlook)', () => {
  const html = email('<p>x</p>');

  assert.match(html, /^<table role="presentation"/, 'a moldura comeca numa tabela');
  assert.ok(html.includes(`bgcolor="${marca.PRETO}"`), 'bgcolor como atributo, para o Outlook');
  assert.ok(html.includes(`bgcolor="${marca.LARANJA}"`), 'o botao tem <td bgcolor> por tras');
  assert.ok(html.includes(`width="${marca.LARGURA_MAX}"`), 'largura tambem como atributo');

  // Fragmento, igual aos outros quatro e-mails do sistema: o charset vem do cabecalho MIME.
  assert.doesNotMatch(html, /<!DOCTYPE|<html|<head|<body/i);
});

// ══════════════════════════════════════════════════════════════
// 2c. O rodape de descadastro
// ══════════════════════════════════════════════════════════════

test('montarEmailCampanha: o rodape leva o link de descadastro que recebeu, sem recalcular', () => {
  // A funcao NAO gera token: ela recebe a URL pronta, para que o link do rodape seja o
  // mesmo do cabecalho List-Unsubscribe. Se ela passasse a calcular o HMAC por conta
  // propria, existiriam duas fontes de link de descadastro no projeto.
  const html = email('<p>x</p>', URL_VAGA, URL_DESC);
  assert.ok(html.includes(URL_DESC.replace(/&/g, '&amp;')), 'a URL recebida vai para o rodape');
  assert.ok(html.includes(cta.TEXTO_LINK_DESCADASTRO), 'com um rotulo clicavel e explicito');
});

test('montarEmailCampanha: sem URL de descadastro, o link some mas o texto do rodape fica', () => {
  // Nao deveria acontecer (o pre-voo garante que montarUrlDescadastro funciona antes de
  // qualquer envio). A degradacao existe so para nunca emitirmos <a href="">.
  // Chamada direta pelo mesmo motivo do teste do botao: `undefined` ativaria o default.
  for (const vazio of ['', null, undefined]) {
    const html = cta.montarEmailCampanha({
      corpoHtml: '<p>x</p>',
      urlVaga: URL_VAGA,
      urlDescadastro: vazio,
    });
    assert.doesNotMatch(html, new RegExp(cta.TEXTO_LINK_DESCADASTRO));
    assert.doesNotMatch(html, /href=""/);
    assert.match(html, /banco de talentos/, 'o texto de "por que voce recebeu" continua');
  }
});

test('montarEmailCampanha: nao escreve rodape de LGPD nem segundo opt-out', () => {
  // O prompt do LLM ja o proibe de escrever rodape de descadastro justamente porque ele
  // vem daqui. Um segundo caminho de opt-out (que nao funcionasse) seria pior que nenhum.
  const html = email('<p>x</p>');
  const ocorrencias = html.split('/descadastro?').length - 1;
  assert.equal(ocorrencias, 1, 'exatamente UM link de descadastro no corpo');
});

// ══════════════════════════════════════════════════════════════
// 4. UMA implementacao so — a prova de que teste e disparo nao divergem
// ══════════════════════════════════════════════════════════════

test('montarCorpoFinal: e a composicao exata de montarUrlVaga + montarCorpoComCta', () => {
  // Se alguem um dia reimplementar a montagem num dos dois caminhos de envio, esta
  // igualdade e o que quebra primeiro.
  const corpo = '<p>Corpo qualquer.</p>';
  assert.equal(
    cta.montarCorpoFinal(corpo, 'slug-da-vaga', URL_DESC),
    cta.montarEmailCampanha({
      corpoHtml: corpo,
      urlVaga: cta.montarUrlVaga('slug-da-vaga'),
      urlDescadastro: URL_DESC,
    }),
  );
});

test('montarCorpoFinal: mesmas entradas produzem HTML identico, sempre', () => {
  const corpo = '<p>Estamos com uma vaga aberta.</p>';
  assert.equal(
    cta.montarCorpoFinal(corpo, 'vaga-a', URL_DESC),
    cta.montarCorpoFinal(corpo, 'vaga-a', URL_DESC),
  );
  assert.notEqual(
    cta.montarCorpoFinal(corpo, 'vaga-a', URL_DESC),
    cta.montarCorpoFinal(corpo, 'vaga-b', URL_DESC),
  );
});

test('montarCorpoFinal: a URL de descadastro muda o HTML (e o unico eixo por destinatario)', () => {
  // O que este teste guarda: se a URL de descadastro deixasse de chegar ao corpo, TODOS os
  // destinatarios receberiam o mesmo rodape — e o link levaria ao opt-out de outra pessoa.
  const corpo = '<p>Estamos com uma vaga aberta.</p>';
  const outraUrl = 'https://exemplo.com/descadastro?e=b3V0cm9AZXhlbXBsby5jb20&t=999zzz';
  assert.notEqual(
    cta.montarCorpoFinal(corpo, 'vaga-a', URL_DESC),
    cta.montarCorpoFinal(corpo, 'vaga-a', outraUrl),
  );
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
