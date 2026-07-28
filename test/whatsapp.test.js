'use strict';

// Helper de WhatsApp (src/lib/whatsapp.js). Funcoes puras, sem banco/rede/chaves.
// Cobre normalizacao do telefone (mascara, com/sem DDI, invalidos), montagem do link
// wa.me e o template da mensagem ao candidato (com/sem empresa, primeiro nome).

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  normalizarTelefoneWhatsapp,
  montarLinkWhatsapp,
  mensagemWhatsappCandidato,
  mensagemPosEntrevista,
  mensagemNovaCandidatura,
  RECRUTADOR_PADRAO,
  TEMPLATE_PADRAO,
} = require('../src/lib/whatsapp');

test('normalizarTelefoneWhatsapp: mascara com +55 -> so digitos', () => {
  assert.equal(normalizarTelefoneWhatsapp('+55 (11) 90000-0000'), '5511900000000');
});

test('normalizarTelefoneWhatsapp: sem codigo de pais -> assume 55', () => {
  assert.equal(normalizarTelefoneWhatsapp('(11) 90000-0000'), '5511900000000');
});

test('normalizarTelefoneWhatsapp: numero internacional (+1) preserva o codigo', () => {
  assert.equal(normalizarTelefoneWhatsapp('+1 (415) 555-1234'), '14155551234');
});

test('normalizarTelefoneWhatsapp: ddiPadrao customizado', () => {
  assert.equal(normalizarTelefoneWhatsapp('912345678', { ddiPadrao: '351' }), '351912345678');
});

test('normalizarTelefoneWhatsapp: nao-string / vazio -> null', () => {
  assert.equal(normalizarTelefoneWhatsapp(null), null);
  assert.equal(normalizarTelefoneWhatsapp(undefined), null);
  assert.equal(normalizarTelefoneWhatsapp(5511900000000), null);
  assert.equal(normalizarTelefoneWhatsapp(''), null);
  assert.equal(normalizarTelefoneWhatsapp('   '), null);
});

test('normalizarTelefoneWhatsapp: sem digitos (so mascara) -> null', () => {
  assert.equal(normalizarTelefoneWhatsapp('+ () -'), null);
});

test('normalizarTelefoneWhatsapp: curto demais -> null', () => {
  assert.equal(normalizarTelefoneWhatsapp('+55 999'), null); // 55999 = 5 digitos
});

test('normalizarTelefoneWhatsapp: comprido demais (>15) -> null', () => {
  assert.equal(normalizarTelefoneWhatsapp('+55 1234567890123456'), null);
});

test('montarLinkWhatsapp: com mensagem -> link com ?text= encodado', () => {
  const link = montarLinkWhatsapp('+55 (11) 90000-0000', 'Olá, tudo bem?');
  assert.equal(link, 'https://wa.me/5511900000000?text=Ol%C3%A1%2C%20tudo%20bem%3F');
});

test('montarLinkWhatsapp: sem mensagem -> link sem ?text=', () => {
  assert.equal(montarLinkWhatsapp('+55 (11) 90000-0000'), 'https://wa.me/5511900000000');
  assert.equal(montarLinkWhatsapp('+55 (11) 90000-0000', '   '), 'https://wa.me/5511900000000');
});

test('montarLinkWhatsapp: telefone invalido -> null', () => {
  assert.equal(montarLinkWhatsapp('123', 'oi'), null);
  assert.equal(montarLinkWhatsapp('', 'oi'), null);
});

test('mensagemWhatsappCandidato: com nome, vaga e empresa', () => {
  const msg = mensagemWhatsappCandidato({
    nome: 'Maria Silva',
    vaga: 'SDR Pré-vendas',
    empresa: 'Acme Ltda',
  });
  assert.equal(
    msg,
    'Olá Maria, aqui é o Jean Dentz da Vendedor Mestre. ' +
      'Recebi sua candidatura para a vaga de SDR Pré-vendas da empresa Acme Ltda. Você tem alguma dúvida?',
  );
});

test('mensagemWhatsappCandidato: sem empresa -> omite o trecho "da empresa"', () => {
  const msg = mensagemWhatsappCandidato({ nome: 'Maria Silva', vaga: 'SDR Pré-vendas' });
  assert.equal(
    msg,
    'Olá Maria, aqui é o Jean Dentz da Vendedor Mestre. ' +
      'Recebi sua candidatura para a vaga de SDR Pré-vendas. Você tem alguma dúvida?',
  );
  assert.ok(!msg.includes('da empresa'));
});

test('mensagemWhatsappCandidato: usa apenas o PRIMEIRO nome', () => {
  const msg = mensagemWhatsappCandidato({ nome: 'João Pedro de Souza', vaga: 'Closer' });
  assert.match(msg, /^Olá João, /);
});

test('mensagemWhatsappCandidato: sem nome -> "Olá," sem nome', () => {
  const msg = mensagemWhatsappCandidato({ nome: '', vaga: 'Closer', empresa: 'Acme' });
  assert.equal(
    msg,
    'Olá, aqui é o Jean Dentz da Vendedor Mestre. ' +
      'Recebi sua candidatura para a vaga de Closer da empresa Acme. Você tem alguma dúvida?',
  );
});

// ── Template configuravel (B4) ──
test('mensagemWhatsappCandidato: template customizado substitui todos os placeholders', () => {
  const msg = mensagemWhatsappCandidato({
    nome: 'Maria Silva',
    vaga: 'SDR',
    empresa: 'Acme',
    recrutador: 'Ana Souza',
    template: '{recrutador} aqui, {primeiro_nome}! Vaga {vaga} na {empresa}.',
  });
  assert.equal(msg, 'Ana Souza aqui, Maria! Vaga SDR na Acme.');
});

test('mensagemWhatsappCandidato: recrutador vazio -> RECRUTADOR_PADRAO', () => {
  const msg = mensagemWhatsappCandidato({
    nome: 'Maria',
    vaga: 'SDR',
    recrutador: '   ',
    template: '{recrutador}: olá {primeiro_nome}',
  });
  assert.equal(msg, `${RECRUTADOR_PADRAO}: olá Maria`);
});

test('mensagemWhatsappCandidato: template vazio -> usa TEMPLATE_PADRAO', () => {
  const dados = { nome: 'Maria Silva', vaga: 'SDR Pré-vendas', empresa: 'Acme Ltda' };
  const comVazio = mensagemWhatsappCandidato({ ...dados, template: '   ' });
  const semTemplate = mensagemWhatsappCandidato(dados);
  assert.equal(comVazio, semTemplate);
  assert.ok(TEMPLATE_PADRAO.includes('{primeiro_nome}')); // o padrao tem placeholders
});

test('mensagemWhatsappCandidato: placeholder desconhecido fica intacto (nao quebra)', () => {
  let msg;
  assert.doesNotThrow(() => {
    msg = mensagemWhatsappCandidato({
      nome: 'Maria',
      vaga: 'SDR',
      template: 'Oi {primeiro_nome}, {foo} {vaga}',
    });
  });
  assert.equal(msg, 'Oi Maria, {foo} SDR');
});

test('mensagemWhatsappCandidato: empresa vazia remove " da empresa {empresa}" do template', () => {
  const msg = mensagemWhatsappCandidato({
    nome: 'Maria',
    vaga: 'SDR',
    empresa: '',
    template: 'Vaga de {vaga} da empresa {empresa} aberta.',
  });
  assert.equal(msg, 'Vaga de SDR aberta.');
});

// ── Mensagens do sentido CANDIDATO -> recrutador ────────────────────────────────
// mensagemPosEntrevista (ponto A: tela de finalizacao)

test('mensagemPosEntrevista: com empresa -> cita vaga E empresa', () => {
  const msg = mensagemPosEntrevista({
    nome: 'Ana Souza',
    vaga: 'Closer',
    empresa: 'Vendedor Mestre',
  });
  assert.equal(
    msg,
    'Olá! Sou Ana Souza, acabei de concluir a entrevista para a vaga de Closer ' +
      'da empresa Vendedor Mestre e gostaria de falar com o recrutador.',
  );
});

test('mensagemPosEntrevista: empresa vazia -> omite o trecho inteiro, sem sobra', () => {
  const msg = mensagemPosEntrevista({ nome: 'Ana Souza', vaga: 'Closer', empresa: '' });
  assert.equal(
    msg,
    'Olá! Sou Ana Souza, acabei de concluir a entrevista para a vaga de Closer ' +
      'e gostaria de falar com o recrutador.',
  );
  assert.ok(!/empresa/i.test(msg), 'nao pode sobrar a palavra "empresa"');
  assert.ok(!/ {2,}/.test(msg), 'nao pode sobrar espaco duplo');
});

test('mensagemPosEntrevista: empresa null e empresa so com espacos -> mesmo resultado', () => {
  const esperado = mensagemPosEntrevista({ nome: 'Ana', vaga: 'SDR', empresa: '' });
  assert.equal(mensagemPosEntrevista({ nome: 'Ana', vaga: 'SDR', empresa: null }), esperado);
  assert.equal(mensagemPosEntrevista({ nome: 'Ana', vaga: 'SDR', empresa: '   ' }), esperado);
  assert.equal(mensagemPosEntrevista({ nome: 'Ana', vaga: 'SDR' }), esperado);
});

test('mensagemPosEntrevista: aplica trim em nome, vaga e empresa', () => {
  const msg = mensagemPosEntrevista({
    nome: '  Ana Souza  ',
    vaga: '  Closer  ',
    empresa: '  Vendedor Mestre  ',
  });
  assert.equal(
    msg,
    'Olá! Sou Ana Souza, acabei de concluir a entrevista para a vaga de Closer ' +
      'da empresa Vendedor Mestre e gostaria de falar com o recrutador.',
  );
});

test('mensagemPosEntrevista: sem nome -> abertura alternativa, sem "Sou ,"', () => {
  const msg = mensagemPosEntrevista({ nome: '', vaga: 'Closer', empresa: 'Vendedor Mestre' });
  assert.equal(
    msg,
    'Olá! Acabei de concluir a entrevista para a vaga de Closer ' +
      'da empresa Vendedor Mestre e gostaria de falar com o recrutador.',
  );
  assert.ok(!msg.includes('Sou'), 'sem nome, nao deve restar "Sou"');
});

test('mensagemPosEntrevista: sem vaga -> some vaga E empresa, frase continua valida', () => {
  const msg = mensagemPosEntrevista({ nome: 'Ana', vaga: '', empresa: 'Vendedor Mestre' });
  assert.equal(
    msg,
    'Olá! Sou Ana, acabei de concluir a entrevista e gostaria de falar com o recrutador.',
  );
});

test('mensagemPosEntrevista: sem nenhum dado -> frase minima, sem quebrar', () => {
  const msg = mensagemPosEntrevista();
  assert.equal(msg, 'Olá! Acabei de concluir a entrevista e gostaria de falar com o recrutador.');
});

// mensagemNovaCandidatura (ponto B: tela de confirmacao, modo Simples)

test('mensagemNovaCandidatura: com empresa -> inclui a linha da empresa', () => {
  const msg = mensagemNovaCandidatura({
    nome: 'Ana Souza',
    email: 'ana@exemplo.com',
    telefone: '+55 11 90000-0000',
    vaga: 'Closer',
    empresa: 'Vendedor Mestre',
  });
  assert.equal(
    msg,
    '📋 Candidatura de Ana Souza\n\n' +
      '📧 E-mail: ana@exemplo.com\n' +
      '📱 WhatsApp: +55 11 90000-0000\n' +
      '💼 Vaga: Closer\n' +
      '🏢 Empresa: Vendedor Mestre',
  );
});

test('mensagemNovaCandidatura: empresa vazia -> a LINHA inteira some', () => {
  const msg = mensagemNovaCandidatura({
    nome: 'Ana Souza',
    email: 'ana@exemplo.com',
    telefone: '+55 11 90000-0000',
    vaga: 'Closer',
    empresa: null,
  });
  assert.equal(
    msg,
    '📋 Candidatura de Ana Souza\n\n' +
      '📧 E-mail: ana@exemplo.com\n' +
      '📱 WhatsApp: +55 11 90000-0000\n' +
      '💼 Vaga: Closer',
  );
  assert.ok(!msg.includes('🏢'), 'nao pode sobrar o rotulo de empresa');
  assert.ok(!msg.endsWith('\n'), 'nao pode sobrar linha em branco no fim');
});

test('mensagemNovaCandidatura: preserva as quebras de linha (nao colapsa em espaco)', () => {
  const msg = mensagemNovaCandidatura({ nome: 'Ana', vaga: 'SDR', empresa: 'Acme' });
  assert.equal(msg.split('\n').length, 6);
});

test('mensagemNovaCandidatura: aplica trim nos campos', () => {
  const msg = mensagemNovaCandidatura({
    nome: '  Ana Souza  ',
    email: '  ana@exemplo.com  ',
    telefone: '  +55 11 90000-0000  ',
    vaga: '  Closer  ',
    empresa: '  Acme  ',
  });
  assert.ok(msg.includes('📋 Candidatura de Ana Souza\n'));
  assert.ok(msg.includes('📧 E-mail: ana@exemplo.com\n'));
  assert.ok(msg.endsWith('🏢 Empresa: Acme'));
});

test('mensagemNovaCandidatura: campos ausentes -> rotulos com "não informado"', () => {
  const msg = mensagemNovaCandidatura();
  assert.equal(
    msg,
    '📋 Candidatura de Candidato\n\n' +
      '📧 E-mail: não informado\n' +
      '📱 WhatsApp: não informado\n' +
      '💼 Vaga: não informada',
  );
});
