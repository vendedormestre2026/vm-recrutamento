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
