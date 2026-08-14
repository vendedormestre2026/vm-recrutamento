'use strict';

// Textos da sequencia WA1/WA2 (src/lib/whatsappSequencia.js). Funcoes puras — sem banco,
// sem rede, sem relogio.
//
// ── O QUE ESTA EM JOGO ──
// Estas duas mensagens sao a primeira coisa que um candidato recebe da empresa por WhatsApp,
// e saem sozinhas. Um texto quebrado ("Olá , tudo bem?", "para a vaga de na ") nao gera
// erro em lugar nenhum: chega assim no aparelho da pessoa e denuncia automacao mal-feita
// justamente no momento em que se esta pedindo que ela confie no processo.
//
// Por isso a maior parte das assercoes abaixo e sobre AUSENCIA de artefato, e nao sobre a
// presenca da frase certa.

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  montarTextoWA1,
  montarTextoWA2,
  PRAZO_HORAS_PADRAO,
  saudacao,
  trechoVaga,
  horasValidas,
  textoPrazo,
} = require('../src/lib/whatsappSequencia');

const APP = { nome: 'Ana Paula Silva' };
const JOB = { titulo: 'Vendedor Externo', empresa: 'Labor Seg', perfil: 'CLOSER' };

// Artefatos que denunciam template mal preenchido. Nenhum texto pode conter nenhum deles.
function semArtefatos(texto, rotulo) {
  assert.doesNotMatch(texto, /\{[a-z_]+\}/i, `${rotulo}: placeholder nao substituido`);
  assert.doesNotMatch(texto, / ,|  |\bde na\b|\bna \./, `${rotulo}: pontuacao/espaco residual`);
  assert.doesNotMatch(texto, /undefined|null|NaN/, `${rotulo}: valor JS vazou para o texto`);
  assert.doesNotMatch(texto, /^\s|\s$/, `${rotulo}: espaco nas bordas`);
}

// ══════════════════ Helpers ══════════════════

test('saudacao usa frase INTEIRA diferente quando nao ha nome', () => {
  // E nao um placeholder que fica vazio: "Olá, !" e o detalhe que denuncia o robo.
  assert.equal(saudacao('Ana Paula Silva'), 'Olá, Ana!');
  assert.equal(saudacao('Ana'), 'Olá, Ana!');
  for (const vazio of ['', '   ', null, undefined]) {
    assert.equal(saudacao(vazio), 'Olá!', JSON.stringify(vazio));
  }
});

test('trechoVaga omite empresa vazia e some inteiro sem vaga', () => {
  assert.equal(trechoVaga(JOB), ' para a vaga de Vendedor Externo na Labor Seg');
  assert.equal(trechoVaga({ titulo: 'Vendedor Externo' }), ' para a vaga de Vendedor Externo');
  assert.equal(trechoVaga({ titulo: 'Vendedor Externo', empresa: '   ' }), ' para a vaga de Vendedor Externo');
  // Sem vaga, a empresa vai junto: "sua candidatura na Labor Seg" e vago demais para a
  // pessoa saber do que se trata.
  assert.equal(trechoVaga({ empresa: 'Labor Seg' }), '');
  for (const nada of [null, undefined, {}]) assert.equal(trechoVaga(nada), '');
});

test('horasValidas cai no default em tudo que nao e numero positivo', () => {
  assert.equal(horasValidas(48), 48);
  assert.equal(horasValidas('12'), 12);
  assert.equal(horasValidas(1.6), 2, 'arredonda: "1.6 horas" nao e texto para humano');
  // Um prazo de 0 no texto seria uma instrucao impossivel de cumprir — pior que o default.
  for (const ruim of [0, -5, NaN, Infinity, null, undefined, '', 'abc', {}]) {
    assert.equal(horasValidas(ruim), PRAZO_HORAS_PADRAO, JSON.stringify(ruim));
  }
});

test('textoPrazo faz plural', () => {
  assert.equal(textoPrazo(1), '1 hora');
  assert.equal(textoPrazo(24), '24 horas');
});

// ══════════════════ WA1 ══════════════════

test('WA1: caminho completo', () => {
  const t = montarTextoWA1(APP, JOB);
  assert.match(t, /^Olá, Ana!/);
  assert.match(t, /Recebemos sua candidatura para a vaga de Vendedor Externo na Labor Seg\./);
  semArtefatos(t, 'WA1');
});

test('WA1 NAO pede acao, nao tem prazo e nao tem link', () => {
  // A regra de negocio: quem acabou de se candidatar ja fez a acao dele. Uma mensagem
  // automatica que chega junto com o cadastro e ja cobra algo soa como robo de cobranca.
  const t = montarTextoWA1(APP, JOB);
  assert.match(t, /Não precisa fazer nada agora/i);
  assert.doesNotMatch(t, /https?:\/\//, 'WA1 nao leva link');
  assert.doesNotMatch(t, /\bhoras\b|\bprazo\b/i, 'prazo e assunto do WA2');
  assert.doesNotMatch(t, /vídeo|video/i, 'o pedido do video e do WA2');
});

test('WA1 degrada sem quebrar em toda combinacao de campo ausente', () => {
  const casos = [
    ['sem nome', {}, JOB],
    ['sem empresa', APP, { titulo: 'Vendedor Externo' }],
    ['sem vaga', APP, { empresa: 'Labor Seg' }],
    ['sem job', APP, null],
    ['sem nada', null, null],
    ['sem nada (objetos vazios)', {}, {}],
  ];
  for (const [rotulo, app, job] of casos) {
    const t = montarTextoWA1(app, job);
    assert.ok(t.length > 40, `${rotulo}: texto curto demais para ser mensagem`);
    assert.match(t, /Vendedor Mestre/, `${rotulo}: a mensagem precisa se identificar`);
    semArtefatos(t, `WA1 ${rotulo}`);
  }
});

// ══════════════════ WA2 ══════════════════

test('WA2: caminho completo, com o prazo no texto', () => {
  const t = montarTextoWA2(APP, JOB, 24);
  assert.match(t, /^Olá, Ana!/);
  assert.match(t, /vídeo curto de apresentação/i);
  assert.match(t, /Você tem 24 horas a partir desta mensagem/);
  semArtefatos(t, 'WA2');
});

test('WA2: prazo customizado vs. default', () => {
  assert.match(montarTextoWA2(APP, JOB, 48), /48 horas/);
  assert.match(montarTextoWA2(APP, JOB, 1), /\b1 hora\b/);
  // Ausente cai no default — e o default vem daqui, nao de um numero cravado no texto.
  for (const ausente of [undefined, null, 0, 'abc']) {
    assert.match(montarTextoWA2(APP, JOB, ausente), new RegExp(`${PRAZO_HORAS_PADRAO} horas`), String(ausente));
  }
});

test('WA2 NAO promete automacao que nao existe', () => {
  // A confirmacao do video e 100% humana (o recrutador marca no painel). Prometer
  // "responda que o sistema registra" e como se perde confianca na primeira vez que nao
  // acontece.
  const t = montarTextoWA2(APP, JOB, 24);
  assert.doesNotMatch(t, /automaticamente|o sistema (vai|ir[áa])|registrad[oa] automatic/i);
});

test('WA2 degrada sem quebrar em toda combinacao de campo ausente', () => {
  const casos = [
    ['sem nome', {}, JOB],
    ['sem empresa', APP, { titulo: 'Vendedor Externo' }],
    ['sem vaga', APP, { empresa: 'Labor Seg' }],
    ['sem job', APP, null],
    ['sem nada', null, null],
  ];
  for (const [rotulo, app, job] of casos) {
    const t = montarTextoWA2(app, job, 24);
    assert.ok(t.length > 60, `${rotulo}: texto curto demais`);
    // O pedido e o prazo sao o ponto do WA2: nenhuma degradacao pode fazer sumir os dois.
    assert.match(t, /vídeo/i, `${rotulo}: perdeu o pedido do video`);
    assert.match(t, /24 horas/, `${rotulo}: perdeu o prazo`);
    semArtefatos(t, `WA2 ${rotulo}`);
  }
});

// ══════════════════ As duas juntas ══════════════════

test('as duas mensagens sao diferentes e ambas se identificam', () => {
  const a = montarTextoWA1(APP, JOB);
  const b = montarTextoWA2(APP, JOB, 24);
  assert.notEqual(a, b);
  for (const [rotulo, t] of [['WA1', a], ['WA2', b]]) {
    assert.match(t, /Vendedor Mestre/, `${rotulo} precisa dizer de quem e`);
  }
});

test('o texto NAO varia por perfil (SDR vs CLOSER) — decisao pendente, ver relatorio', () => {
  // Nao ha decisao de negocio sobre isso, entao o texto e generico de proposito. Este teste
  // TRAVA o comportamento atual: no dia em que alguem quiser diferenciar, vai ter que passar
  // por aqui e tomar a decisao de forma explicita, em vez de o texto divergir por acidente.
  const sdr = { ...JOB, perfil: 'SDR' };
  const closer = { ...JOB, perfil: 'CLOSER' };
  assert.equal(montarTextoWA1(APP, sdr), montarTextoWA1(APP, closer));
  assert.equal(montarTextoWA2(APP, sdr, 24), montarTextoWA2(APP, closer, 24));
});

test('nome com espacos extras nao vaza para a saudacao', () => {
  const t = montarTextoWA1({ nome: '   Ana   Paula  ' }, JOB);
  assert.match(t, /^Olá, Ana!/);
  semArtefatos(t, 'WA1 nome sujo');
});
