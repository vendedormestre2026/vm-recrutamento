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
  saudacao,
  trechoVaga,
  linhaRemuneracao,
  linhaLocalidade,
  linkVaga,
} = require('../src/lib/whatsappSequencia');

const APP = { nome: 'Ana Paula Silva' };
const JOB = { titulo: 'Vendedor Externo', empresa: 'Labor Seg', perfil: 'CLOSER' };
const JOB_COMPLETO = {
  ...JOB,
  slug: 'vendedor-externo-labor-seg',
  potencial_ganhos: 'R$ 5.000 a R$ 8.000/mês',
  faixa_pagamento: 'R$ 3.000 + comissão',
  endereco: 'Rua das Flores, 100 - Blumenau/SC',
  cidade: 'Blumenau',
  modalidade: 'presencial',
  regime: 'CLT',
};

// Artefatos que denunciam template mal preenchido. Nenhum texto pode conter nenhum deles.
function semArtefatos(texto, rotulo) {
  assert.doesNotMatch(texto, /\{[a-z_]+\}/i, `${rotulo}: placeholder nao substituido`);
  assert.doesNotMatch(texto, / ,|  |\bde na\b|\bna \./, `${rotulo}: pontuacao/espaco residual`);
  assert.doesNotMatch(texto, /undefined|null|NaN/, `${rotulo}: valor JS vazou para o texto`);
  assert.doesNotMatch(texto, /^\s|\s$/, `${rotulo}: espaco nas bordas`);
  // Bloco em branco duplo: uma linha dinamica ausente nao pode deixar o "buraco" dela, so
  // a linha sumida com o resto colado certo.
  assert.doesNotMatch(texto, /\n\n\n/, `${rotulo}: bloco em branco duplo`);
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

test('linhaRemuneracao: potencial_ganhos tem prioridade sobre faixa_pagamento', () => {
  assert.equal(
    linhaRemuneracao(JOB_COMPLETO),
    `💰 Média de ganhos dos melhores vendedores: ${JOB_COMPLETO.potencial_ganhos}`,
  );
  assert.equal(
    linhaRemuneracao({ faixa_pagamento: 'R$ 3.000' }),
    '💰 Média de ganhos dos melhores vendedores: R$ 3.000',
  );
  assert.equal(
    linhaRemuneracao({ potencial_ganhos: '  ', faixa_pagamento: 'R$ 3.000' }),
    '💰 Média de ganhos dos melhores vendedores: R$ 3.000',
  );
  for (const nada of [null, undefined, {}]) assert.equal(linhaRemuneracao(nada), null);
});

test('linhaRemuneracao: potencial_ganhos multi-linha (\\r\\n) preserva cada linha, so a 1a leva o rotulo', () => {
  // Dado real da vaga id=1 (achado na validacao mock em producao): o Jean cadastra
  // potencial_ganhos como varias linhas separadas por \r\n. Amassar isso numa frase corrida
  // lê como um unico texto confuso, nao como duas informacoes distintas.
  const bruto =
    'R$ 6.500,00+/mês\r\nVendedores experientes e com carteira consolidada:\r\nR$ 8.000 a R$ 13.000+ / mês';
  assert.equal(
    linhaRemuneracao({ potencial_ganhos: bruto }),
    '💰 Média de ganhos dos melhores vendedores: R$ 6.500,00+/mês\n' +
      'Vendedores experientes e com carteira consolidada:\n' +
      'R$ 8.000 a R$ 13.000+ / mês',
  );
  // Linha unica: comportamento identico ao de antes, nada muda.
  assert.equal(
    linhaRemuneracao({ potencial_ganhos: 'R$ 5.000/mês' }),
    '💰 Média de ganhos dos melhores vendedores: R$ 5.000/mês',
  );
  // Linhas em branco no meio do cadastro nao podem sobrar como linha vazia na mensagem.
  assert.equal(
    linhaRemuneracao({ potencial_ganhos: 'R$ 5.000/mês\r\n\r\nR$ 8.000/mês' }),
    '💰 Média de ganhos dos melhores vendedores: R$ 5.000/mês\nR$ 8.000/mês',
  );
});

test('linhaLocalidade: endereco + modalidade (capitalizada) + regime, uma linha cada', () => {
  assert.equal(
    linhaLocalidade(JOB_COMPLETO),
    `📍 ${JOB_COMPLETO.endereco}\n🏢 Presencial\n📄 ${JOB_COMPLETO.regime}`,
  );
  assert.equal(linhaLocalidade({ endereco: 'Rua X' }), '📍 Rua X');
  assert.equal(linhaLocalidade({ modalidade: 'remoto' }), '🏢 Remoto');
  // Regime sozinho: a lista de 1 item nao pode sobrar '\n' nem virar array vazando.
  assert.equal(linhaLocalidade({ regime: 'PJ' }), '📄 PJ');
  // endereco tem prioridade sobre cidade (mais especifico).
  assert.equal(linhaLocalidade({ cidade: 'Blumenau' }), '📍 Blumenau');
  assert.equal(linhaLocalidade({ endereco: 'Rua X', cidade: 'Blumenau' }), '📍 Rua X');
  for (const nada of [null, undefined, {}]) assert.equal(linhaLocalidade(nada), null);
});

test('linkVaga: baseUrl + /vaga/:slug, sem utm; "" sem slug', () => {
  const url = linkVaga(JOB_COMPLETO);
  assert.match(url, /\/vaga\/vendedor-externo-labor-seg$/);
  // Decisao de negocio: quem recebe o WA1 ja se candidatou, nao ha atribuicao de cadastro
  // a fazer aqui — diferente do link da campanha em massa.
  assert.doesNotMatch(url, /utm_source|campanha/);
  for (const nada of [null, undefined, {}, JOB]) assert.equal(linkVaga(nada), '');
});

// ══════════════════ WA1 ══════════════════

test('WA1: caminho completo, com remuneracao, localidade (multi-linha) e link', () => {
  const t = montarTextoWA1(APP, JOB_COMPLETO);
  assert.match(t, /^Olá, Ana!/);
  assert.ok(t.includes('Recebemos sua candidatura para *Vendedor Externo* na *Labor Seg*.'));
  assert.ok(t.includes(`💰 Média de ganhos dos melhores vendedores: ${JOB_COMPLETO.potencial_ganhos}`));
  // linhaLocalidade e multi-linha: cada dado (endereco/modalidade/regime) numa linha propria.
  assert.ok(t.includes(`📍 ${JOB_COMPLETO.endereco}\n🏢 Presencial\n📄 ${JOB_COMPLETO.regime}`));
  assert.ok(
    t.includes(`Para ver mais detalhes da vaga, acesse a página oficial dela aqui: ${linkVaga(JOB_COMPLETO)}`),
  );
  assert.ok(t.includes('A oportunidade faz sentido pra você? Se sim, te mando o próximo passo. 🙂'));
  semArtefatos(t, 'WA1 completo');
});

test('WA1: sem remuneracao, sem localidade e sem slug — linhas somem por inteiro', () => {
  const t = montarTextoWA1(APP, JOB);
  assert.doesNotMatch(t, /💰/, 'sem potencial_ganhos/faixa_pagamento nao pode sobrar o emoji');
  assert.doesNotMatch(t, /📍|🏢|📄/, 'sem endereco/cidade/modalidade/regime nao pode sobrar o emoji');
  assert.doesNotMatch(t, /Para ver mais detalhes/, 'sem slug nao ha link');
  assert.ok(t.includes('A oportunidade faz sentido pra você?'));
  semArtefatos(t, 'WA1 sem dados ricos');
});

test('WA1: so remuneracao (sem localidade) fica sozinha no bloco', () => {
  const job = { ...JOB, potencial_ganhos: 'R$ 5.000/mês' };
  const t = montarTextoWA1(APP, job);
  assert.ok(t.includes('💰 Média de ganhos dos melhores vendedores: R$ 5.000/mês'));
  assert.doesNotMatch(t, /📍|🏢|📄/);
  semArtefatos(t, 'WA1 so remuneracao');
});

test('WA1: remuneracao multi-linha (\\r\\n) vira multiplas linhas no texto, nao frase corrida', () => {
  const job = {
    ...JOB,
    potencial_ganhos: 'R$ 6.500,00+/mês\r\nVendedores experientes e com carteira consolidada:\r\nR$ 8.000 a R$ 13.000+ / mês',
    endereco: 'São Paulo – Cidade Monções',
    modalidade: 'presencial',
    regime: 'CLT',
  };
  const t = montarTextoWA1(APP, job);
  assert.ok(
    t.includes(
      '💰 Média de ganhos dos melhores vendedores: R$ 6.500,00+/mês\n' +
        'Vendedores experientes e com carteira consolidada:\n' +
        'R$ 8.000 a R$ 13.000+ / mês\n' +
        '📍 São Paulo – Cidade Monções\n' +
        '🏢 Presencial\n' +
        '📄 CLT',
    ),
    'as linhas da remuneracao, localidade, modalidade e regime devem ficar juntas, uma por linha, sem bloco em branco entre elas',
  );
  semArtefatos(t, 'WA1 remuneracao multi-linha');
});

test('WA1: so localidade (sem remuneracao) fica sozinha no bloco', () => {
  const job = { ...JOB, modalidade: 'remoto' };
  const t = montarTextoWA1(APP, job);
  assert.ok(t.includes('🏢 Remoto'));
  assert.doesNotMatch(t, /💰/);
  semArtefatos(t, 'WA1 so localidade');
});

test('WA1: so regime (sem localidade nem modalidade) fica sozinho, sem \\n sobrando', () => {
  const job = { ...JOB, regime: 'PJ' };
  const t = montarTextoWA1(APP, job);
  assert.ok(t.includes('📄 PJ'));
  assert.doesNotMatch(t, /📍|🏢/);
  semArtefatos(t, 'WA1 so regime');
});

test('WA1 nao pede video nem prazo — isso e assunto do WA2', () => {
  const t = montarTextoWA1(APP, JOB_COMPLETO);
  assert.doesNotMatch(t, /\bhoras\b|\bprazo\b/i, 'prazo e assunto do WA2');
  assert.doesNotMatch(t, /vídeo|video/i, 'o pedido do video e do WA2');
});

test('WA1 degrada sem quebrar em toda combinacao de campo ausente', () => {
  const casos = [
    ['sem nome', {}, JOB_COMPLETO],
    ['sem empresa', APP, { ...JOB_COMPLETO, empresa: undefined }],
    ['sem vaga', APP, { ...JOB_COMPLETO, titulo: undefined }],
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

test('WA2: caminho completo — abertura e as duas primeiras perguntas sao fixas', () => {
  const t = montarTextoWA2(APP, JOB);
  assert.match(t, /^Olá, Ana!/);
  assert.ok(t.includes('👇 *COMO PARTICIPAR DO PROCESSO SELETIVO* 👇'));
  assert.ok(t.includes('1️⃣ Quem é você?'));
  assert.ok(t.includes('2️⃣ Qual é a sua maior ambição e meta de vida?'));
  semArtefatos(t, 'WA2');
});

test('WA2: a 3a pergunta reaproveita trechoVaga', () => {
  assert.ok(montarTextoWA2(APP, JOB).includes(`3️⃣ Por que você é a pessoa certa${trechoVaga(JOB)}?`));
  assert.ok(montarTextoWA2(APP, null).includes(`3️⃣ Por que você é a pessoa certa${trechoVaga(null)}?`));
});

test('WA2: o prazo e a frase fixa "amanhã, ao meio-dia"', () => {
  const t = montarTextoWA2(APP, JOB);
  assert.ok(t.includes('⏰ *PRAZO*: envie o vídeo aqui mesmo no WhatsApp até amanhã, ao meio-dia.'));
});

test('WA2 NAO promete automacao que nao existe', () => {
  // A confirmacao do video e 100% humana (o recrutador marca no painel). Prometer
  // "responda que o sistema registra" e como se perde confianca na primeira vez que nao
  // acontece.
  const t = montarTextoWA2(APP, JOB);
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
    const t = montarTextoWA2(app, job);
    assert.ok(t.length > 60, `${rotulo}: texto curto demais`);
    // O pedido e o prazo sao o ponto do WA2: nenhuma degradacao pode fazer sumir os dois.
    assert.match(t, /vídeo/i, `${rotulo}: perdeu o pedido do video`);
    assert.ok(t.includes('amanhã, ao meio-dia'), `${rotulo}: perdeu o prazo`);
    semArtefatos(t, `WA2 ${rotulo}`);
  }
});

// ══════════════════ As duas juntas ══════════════════

test('as duas mensagens sao diferentes e ambas se identificam', () => {
  const a = montarTextoWA1(APP, JOB);
  const b = montarTextoWA2(APP, JOB);
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
  assert.equal(montarTextoWA2(APP, sdr), montarTextoWA2(APP, closer));
});

test('nome com espacos extras nao vaza para a saudacao', () => {
  const t = montarTextoWA1({ nome: '   Ana   Paula  ' }, JOB);
  assert.match(t, /^Olá, Ana!/);
  semArtefatos(t, 'WA1 nome sujo');
});
