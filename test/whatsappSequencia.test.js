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
    `💰 Faixa de ganhos dos melhores vendedores: ${JOB_COMPLETO.potencial_ganhos}`,
  );
  assert.equal(
    linhaRemuneracao({ faixa_pagamento: 'R$ 3.000' }),
    '💰 Faixa de ganhos dos melhores vendedores: R$ 3.000',
  );
  assert.equal(
    linhaRemuneracao({ potencial_ganhos: '  ', faixa_pagamento: 'R$ 3.000' }),
    '💰 Faixa de ganhos dos melhores vendedores: R$ 3.000',
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
    '💰 Faixa de ganhos dos melhores vendedores: R$ 6.500,00+/mês\n' +
      'Vendedores experientes e com carteira consolidada:\n' +
      'R$ 8.000 a R$ 13.000+ / mês',
  );
  // Linha unica: comportamento identico ao de antes, nada muda.
  assert.equal(
    linhaRemuneracao({ potencial_ganhos: 'R$ 5.000/mês' }),
    '💰 Faixa de ganhos dos melhores vendedores: R$ 5.000/mês',
  );
  // Linhas em branco no meio do cadastro nao podem sobrar como linha vazia na mensagem.
  assert.equal(
    linhaRemuneracao({ potencial_ganhos: 'R$ 5.000/mês\r\n\r\nR$ 8.000/mês' }),
    '💰 Faixa de ganhos dos melhores vendedores: R$ 5.000/mês\nR$ 8.000/mês',
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

test('linkVaga: baseUrl + /vaga/:slug/confirmacao, sem utm; "" sem slug', () => {
  const url = linkVaga(JOB_COMPLETO);
  // /confirmacao, e nao a pagina publica com o CTA "Aplicar": quem recebe o WA1 ja se
  // candidatou, mandar de volta pro formulario de aplicar seria confuso.
  assert.match(url, /\/vaga\/vendedor-externo-labor-seg\/confirmacao$/);
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
  assert.ok(t.includes(`💰 Faixa de ganhos dos melhores vendedores: ${JOB_COMPLETO.potencial_ganhos}`));
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
  assert.ok(t.includes('💰 Faixa de ganhos dos melhores vendedores: R$ 5.000/mês'));
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
      '💰 Faixa de ganhos dos melhores vendedores: R$ 6.500,00+/mês\n' +
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

// ══════════════════ WA2 — convite para a entrevista em grupo ══════════════════
//
// O WA2 deixou de pedir video e passou a convidar para uma entrevista em grupo no Meet. Por ter
// DUAS variantes, montarTextoWA2 devolve { texto, variante } — ver o cabecalho da lib.
//
// `agora` e sempre explicito nos testes: e o que permite provar "a reuniao 1 venceu, usa a 2"
// sem esperar uma semana.

// Vaga com as tres reunioes cadastradas (quintas-feiras de outubro de 2026) + link do Meet.
const LINK_MEET = 'https://meet.google.com/abc-defg-hij';
const JOB_COM_REUNIOES = {
  ...JOB,
  link_meet: LINK_MEET,
  entrevista_grupo_1_data: '2026-10-01',
  entrevista_grupo_1_hora: '19:30',
  entrevista_grupo_2_data: '2026-10-08',
  entrevista_grupo_2_hora: '20:00',
  entrevista_grupo_3_data: '2026-10-15',
  entrevista_grupo_3_hora: '09:15',
};
// 25/09/2026 10:00 em Brasilia (UTC-3), antes das tres reunioes.
const ANTES_DE_TUDO = new Date('2026-09-25T13:00:00Z');

test('WA2 convite: cabecalho, bloco de data/hora/link e fechamento aprovados', () => {
  const { texto, variante } = montarTextoWA2(APP, JOB_COM_REUNIOES, ANTES_DE_TUDO);

  assert.equal(variante, 'convite_grupo');
  assert.ok(texto.includes('👇 *CONVITE PARA A ENTREVISTA EM GRUPO* 👇'));
  assert.ok(texto.includes('📅 *Data:* quinta-feira, 01/10/2026'));
  assert.ok(texto.includes('⏰ *Horário:* 19:30 (horário de Brasília)'));
  assert.ok(texto.includes(`🔗 *Link para confirmar presença na entrevista:* ${LINK_MEET}`));
  assert.ok(texto.includes('Entre alguns minutos antes, em um lugar tranquilo e com boa internet.'));
  assert.ok(texto.includes('Até lá e boa sorte! 🚀'));
  semArtefatos(texto, 'WA2 convite');
});

test('WA2 convite: frases do texto aprovado presentes, na ordem aprovada', () => {
  const { texto } = montarTextoWA2(APP, JOB_COM_REUNIOES, ANTES_DE_TUDO);
  const ordem = [
    '👇 *CONVITE PARA A ENTREVISTA EM GRUPO* 👇',
    'Queremos convidar você para avançar no processo e participar de uma entrevista em grupo ' +
      'online para a vaga de Vendedor Externo na Labor Seg.',
    '📅 *Data:* quinta-feira, 01/10/2026',
    '⏰ *Horário:* 19:30 (horário de Brasília)',
    `🔗 *Link para confirmar presença na entrevista:* ${LINK_MEET}`,
    'A entrevista será realizada através do Google Meet. Certifique-se que você tenha o app ' +
      'instalado em seu celular para não ficar de fora.',
    'Entre alguns minutos antes, em um lugar tranquilo e com boa internet.',
    'A reunião iniciará pontualmente às 19:30 e não teremos tolerância para atrasos. Candidatos ' +
      'que não comparecerem à entrevista serão automaticamente desclassificados do processo seletivo.',
    'Confirme sua presença clicando no link acima e cadastrando seu email na agenda para receber ' +
      'o convite por email para acessar a entrevista no dia e horário marcados. Se tiver alguma ' +
      'dúvida pontual sobre a vaga, pode me perguntar. Até lá e boa sorte! 🚀',
  ];
  let desde = 0;
  for (const frase of ordem) {
    const pos = texto.indexOf(frase, desde);
    assert.ok(pos >= 0, `frase ausente ou fora de ordem: ${frase}`);
    desde = pos + frase.length;
  }
});

test('WA2 convite: frases do texto ANTIGO nao saem mais', () => {
  const { texto } = montarTextoWA2(APP, JOB_COM_REUNIOES, ANTES_DE_TUDO);
  assert.doesNotMatch(texto, /Se você tem o perfil que buscamos/);
  assert.doesNotMatch(texto, /Link da reunião \(Google Meet\)/);
  assert.doesNotMatch(texto, /respondendo esta mensagem/);
});

test('WA2 convite: o horario da pontualidade e o MESMO da linha Horario (variavel, nao texto fixo)', () => {
  // Dois horarios de entrada: se o aviso de pontualidade tivesse um horario escrito a mao, um dos
  // dois casos falharia.
  const outroHorario = { ...JOB_COM_REUNIOES, entrevista_grupo_1_hora: '08:05' };
  for (const [job, hora] of [[JOB_COM_REUNIOES, '19:30'], [outroHorario, '08:05']]) {
    const { texto } = montarTextoWA2(APP, job, ANTES_DE_TUDO);
    const daLinhaHorario = texto.match(/⏰ \*Horário:\* (\d{2}:\d{2}) \(horário de Brasília\)/);
    const daPontualidade = texto.match(/iniciará pontualmente às (\d{2}:\d{2}) e não/);
    assert.ok(daLinhaHorario && daPontualidade, `${hora}: linha de horario ou de pontualidade ausente`);
    assert.equal(daLinhaHorario[1], hora);
    assert.equal(daPontualidade[1], daLinhaHorario[1], 'pontualidade diverge da linha Horário');
    assert.equal(texto.split(hora).length - 1, 2, `${hora} deveria aparecer exatamente 2x`);
  }
});

test('WA2 convite: NUNCA sai sem link, sem data e sem horario', () => {
  // Esta e a assercao que protege o defeito mais caro possivel deste incremento: um campo
  // esquecido no SELECT da fila (ou no objeto `job` de textoDaEtapa) faria o convite sair sem a
  // informacao que e o proprio ponto dele — e sem erro nenhum, porque o campo chega undefined.
  const { texto } = montarTextoWA2(APP, JOB_COM_REUNIOES, ANTES_DE_TUDO);

  // O link e o de confirmar presenca (Calendly), cadastrado na coluna jobs.link_meet; a fixture
  // ainda usa uma URL do Meet, e as duas formas precisam passar.
  assert.match(texto, /https:\/\/(meet\.google\.com|calendly\.com)\/\S+/, 'convite sem link');
  assert.match(texto, /\*Data:\*\s+\S+.*\d{2}\/\d{2}\/\d{4}/, 'convite sem data');
  assert.match(texto, /\*Horário:\*\s+\d{2}:\d{2}/, 'convite sem horario');
  assert.doesNotMatch(texto, /undefined|null|NaN|Invalid Date/, 'campo nao resolvido vazou');
});

test('WA2 convite: a vaga entra pelo MESMO trechoVaga do resto da sequencia', () => {
  const { texto } = montarTextoWA2(APP, JOB_COM_REUNIOES, ANTES_DE_TUDO);
  assert.ok(texto.includes(`entrevista em grupo online${trechoVaga(JOB_COM_REUNIOES)}.`));
});

test('WA2 convite: passada a reuniao 1, o texto anuncia a 2 — e depois a 3', () => {
  // A regra de negocio inteira em tres assercoes: ninguem edita a vaga entre uma reuniao e a
  // seguinte, e nenhum link vencido sai.
  const depoisDa1 = new Date('2026-10-02T11:00:00Z');
  const depoisDa2 = new Date('2026-10-09T11:00:00Z');

  assert.ok(montarTextoWA2(APP, JOB_COM_REUNIOES, ANTES_DE_TUDO).texto.includes('01/10/2026'));
  assert.ok(montarTextoWA2(APP, JOB_COM_REUNIOES, depoisDa1).texto.includes('08/10/2026'));
  assert.ok(montarTextoWA2(APP, JOB_COM_REUNIOES, depoisDa2).texto.includes('15/10/2026'));
});

test('WA2 SEM saudacao: comeca direto no cabecalho do convite, sem "Olá"', () => {
  // Decisao mantida do texto anterior (Incremento 11): a saudacao ja aconteceu no WA1, minutos
  // antes, no MESMO fio.
  const { texto } = montarTextoWA2(APP, JOB_COM_REUNIOES, ANTES_DE_TUDO);
  assert.match(texto, /^👇 \*CONVITE PARA A ENTREVISTA EM GRUPO\* 👇/);
  assert.doesNotMatch(texto, /\bOlá\b/);
  assert.doesNotMatch(texto, new RegExp(APP.nome.split(' ')[0]));
});

test('WA2 NAO promete automacao que nao existe', () => {
  // A confirmacao de presenca e 100% HUMANA: ninguem le a resposta automaticamente e o sistema
  // nao registra presenca em lugar nenhum. Prometer o contrario e como se perde confianca na
  // primeira vez que nao acontece.
  const { texto } = montarTextoWA2(APP, JOB_COM_REUNIOES, ANTES_DE_TUDO);
  // EXCECAO UNICA, aprovada pelo Rafael: "serão automaticamente desclassificados" descreve uma
  // regra do PROCESSO, aplicada pela equipe a quem falta — nao uma automacao do sistema. So essa
  // frase exata e removida antes da checagem; qualquer outro "automaticamente" continua barrado.
  const EXCECAO = 'serão automaticamente desclassificados do processo seletivo';
  assert.ok(texto.includes(EXCECAO), 'a excecao so existe enquanto a frase aprovada existir');
  const semExcecao = texto.replace(EXCECAO, '');
  assert.doesNotMatch(semExcecao, /automaticamente|o sistema (vai|ir[áa])|registrad[oa] automatic/i);
  assert.doesNotMatch(texto, /vaga (esta|está) (reservada|garantida)/i);
});

test('WA2 nao fala mais de video nem de prazo', () => {
  // O fluxo do video continua existindo no sistema (historico), mas a MENSAGEM nao o pede mais.
  const { texto } = montarTextoWA2(APP, JOB_COM_REUNIOES, ANTES_DE_TUDO);
  assert.doesNotMatch(texto, /v[íi]deo/i);
  assert.doesNotMatch(texto, /\bPRAZO\b|meio-dia/i);
});

// ── FALLBACK: sem reuniao futura ──

test('WA2 fallback: sem reuniao nenhuma cadastrada', () => {
  const { texto, variante } = montarTextoWA2(APP, JOB, ANTES_DE_TUDO);
  assert.equal(variante, 'sem_reuniao');
  assert.ok(texto.includes('Estamos definindo as próximas datas das entrevistas em grupo'));
  assert.ok(texto.includes('te aviso por aqui com o link da reunião'));
  semArtefatos(texto, 'WA2 fallback');
});

test('WA2 fallback: todas as reunioes vencidas — NENHUM link vencido sai', () => {
  const depoisDeTudo = new Date('2026-10-16T11:00:00Z');
  const { texto, variante } = montarTextoWA2(APP, JOB_COM_REUNIOES, depoisDeTudo);

  assert.equal(variante, 'sem_reuniao');
  assert.doesNotMatch(texto, /meet\.google\.com/, 'link vencido nao pode sair');
  assert.doesNotMatch(texto, /\d{2}\/\d{2}\/\d{4}/, 'data vencida nao pode sair');
});

test('WA2 fallback: datas futuras mas SEM link do Meet (convite sem sala nao e convite)', () => {
  const semLink = { ...JOB_COM_REUNIOES, link_meet: '' };
  const { texto, variante } = montarTextoWA2(APP, semLink, ANTES_DE_TUDO);
  assert.equal(variante, 'sem_reuniao');
  assert.doesNotMatch(texto, /01\/10\/2026/);
});

test('WA2 fallback NAO usa o cabecalho do convite', () => {
  // Vestir de convite uma mensagem que nao tem data frustra quem a abre esperando uma.
  const { texto } = montarTextoWA2(APP, JOB, ANTES_DE_TUDO);
  assert.doesNotMatch(texto, /CONVITE PARA A ENTREVISTA EM GRUPO/);
  assert.doesNotMatch(texto, /👇/);
});

test('WA2 fallback tambem traz a vaga pelo trechoVaga', () => {
  const { texto } = montarTextoWA2(APP, JOB, ANTES_DE_TUDO);
  assert.ok(texto.includes(`entrevistas em grupo${trechoVaga(JOB)}.`));
});

test('WA2 degrada sem quebrar em toda combinacao de campo ausente', () => {
  const casos = [
    ['sem nome', {}, JOB_COM_REUNIOES],
    ['sem empresa', APP, { ...JOB_COM_REUNIOES, empresa: undefined }],
    ['sem vaga', APP, { ...JOB_COM_REUNIOES, titulo: undefined }],
    ['sem job', APP, null],
    ['sem nada', null, null],
    ['data sem hora', APP, { ...JOB, link_meet: LINK_MEET, entrevista_grupo_1_data: '2026-10-01' }],
    ['data impossivel', APP, { ...JOB, link_meet: LINK_MEET, entrevista_grupo_1_data: '2026-02-31', entrevista_grupo_1_hora: '10:00' }],
  ];
  for (const [rotulo, app, job] of casos) {
    const { texto, variante } = montarTextoWA2(app, job, ANTES_DE_TUDO);
    assert.ok(texto.length > 60, `${rotulo}: texto curto demais`);
    assert.ok(['convite_grupo', 'sem_reuniao'].includes(variante), `${rotulo}: variante invalida`);
    // Nenhuma degradacao pode vazar campo nao resolvido para o aparelho de alguem.
    assert.doesNotMatch(texto, /undefined|null|NaN|Invalid Date/, `${rotulo}: vazou campo`);
    semArtefatos(texto, `WA2 ${rotulo}`);
  }
});

// ══════════════════ As duas juntas ══════════════════

test('as duas mensagens sao diferentes; so o WA1 se identifica (WA2 e o MESMO fio)', () => {
  const a = montarTextoWA1(APP, JOB);
  const b = montarTextoWA2(APP, JOB_COM_REUNIOES, ANTES_DE_TUDO).texto;
  assert.notEqual(a, b);
  assert.match(a, /Vendedor Mestre/, 'WA1 precisa dizer de quem e — e a 1a mensagem do fio');
  // WA2 (Incremento 11) NAO repete a identificacao: chega minutos depois, no MESMO fio de
  // WhatsApp do WA1 — quem esta falando ja esta estabelecido.
  assert.doesNotMatch(b, /Vendedor Mestre/);
});

test('WA1 nao fala da reuniao — isso e assunto do WA2', () => {
  // Substitui a assercao antiga ("WA1 nao pede video"): o WA1 nao mudou, mas o que o WA2 carrega
  // mudou, e a fronteira entre as duas mensagens continua sendo o que este teste guarda.
  const t = montarTextoWA1(APP, JOB_COM_REUNIOES);
  assert.doesNotMatch(t, /entrevista em grupo/i);
  assert.doesNotMatch(t, /meet\.google\.com/);
  assert.doesNotMatch(t, /\bData:\b|\bHorário:\b/);
});

test('o texto NAO varia por perfil (SDR vs CLOSER) — decisao pendente, ver relatorio', () => {
  // Nao ha decisao de negocio sobre isso, entao o texto e generico de proposito. Este teste
  // TRAVA o comportamento atual: no dia em que alguem quiser diferenciar, vai ter que passar
  // por aqui e tomar a decisao de forma explicita, em vez de o texto divergir por acidente.
  const sdr = { ...JOB_COM_REUNIOES, perfil: 'SDR' };
  const closer = { ...JOB_COM_REUNIOES, perfil: 'CLOSER' };
  assert.equal(montarTextoWA1(APP, sdr), montarTextoWA1(APP, closer));
  assert.deepEqual(
    montarTextoWA2(APP, sdr, ANTES_DE_TUDO),
    montarTextoWA2(APP, closer, ANTES_DE_TUDO),
  );
});

test('nome com espacos extras nao vaza para a saudacao', () => {
  const t = montarTextoWA1({ nome: '   Ana   Paula  ' }, JOB);
  assert.match(t, /^Olá, Ana!/);
  semArtefatos(t, 'WA1 nome sujo');
});
