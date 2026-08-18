'use strict';

// Item 4 do ETAPA B "Ajustes no Admin" — Commits 8 e 9: /admin/config em abas (E-mail /
// WhatsApp / Campanhas e Divulgação / Manutenção), Opção A (nenhuma rota de POST muda,
// so o visual), e remocao dos subtitulos explicativos abaixo de cada checkbox/opcao.
// "Entrevista automática" fica fixa, fora das abas.
//
// Cobre:
//   1. os 4 paineis de aba existem; so o de E-mail comeca visivel (sem `hidden`);
//   2. os 8 checkboxes do form de notificacoes continuam com o MESMO `name`, e todos
//      apontam para o form compartilhado via `form="form-notificacoes"` (nenhum aninhado
//      dentro de outro <form>, o que seria HTML invalido);
//   3. o link "WhatsApp (pareamento)" saiu do bloco fixo do topo e foi para a aba WhatsApp;
//   4. (Commit 9) os subtitulos explicativos abaixo de cada checkbox/campo foram removidos;
//   5. "Entrevista automática" continua fora de qualquer painel de aba.
//
// Nao testa a INTERACAO em si (clique troca de aba) — isso e comportamento de browser/JS,
// fora do alcance do node:test deste projeto (sem jsdom). O contrato de dados (hidden
// inicial, form= correto) e o que garante a base para o JS funcionar.

const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');

const TMP_DB = path.join(os.tmpdir(), `vm-test-admin-config-abas-${process.pid}-${Date.now()}.db`);
process.env.DATABASE_PATH = TMP_DB;
process.env.INTERVIEW_MOCK = 'true';
process.env.SESSION_SECRET = 'segredo-de-teste';
process.env.ADMIN_PASSWORD = 'senha-teste';
process.env.ADMIN_USER = 'admin';
process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert/strict');

const { migrar } = require('../src/db/migrate');
const { criarApp } = require('../src/server');

const SECRET = process.env.SESSION_SECRET;
const SENHA = process.env.ADMIN_PASSWORD;

function cookieAdmin() {
  const sig = crypto.createHmac('sha256', SECRET).update(SENHA).digest('base64').replace(/=+$/, '');
  return `vm_admin=${encodeURIComponent(`s:${SENHA}.${sig}`)}`;
}

async function getConfigHtml() {
  const app = criarApp();
  const server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const res = await fetch(`${base}/admin/config`, { headers: { Cookie: cookieAdmin() } });
    return { status: res.status, html: await res.text() };
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

test.before(() => {
  migrar();
});

test('os 4 paineis de aba existem; so "email" comeca visivel', async () => {
  const { status, html } = await getConfigHtml();
  assert.equal(status, 200);

  assert.match(html, /<div data-tab-painel="email">/, 'painel email precisa comecar SEM hidden');
  assert.match(html, /<div data-tab-painel="whatsapp" hidden>/);
  assert.match(html, /<div data-tab-painel="campanhas" hidden>/);
  assert.match(html, /<div data-tab-painel="manutencao" hidden>/);

  assert.match(html, /data-tab-btn="email"/);
  assert.match(html, /data-tab-btn="whatsapp"/);
  assert.match(html, /data-tab-btn="campanhas"/);
  assert.match(html, /data-tab-btn="manutencao"/);
});

test('os 8 checkboxes de notificacoes mantem o name original e apontam para form-notificacoes', async () => {
  const { html } = await getConfigHtml();

  assert.match(html, /<form id="form-notificacoes" method="POST" action="\/admin\/config\/notificacoes"><\/form>/);

  const campos = [
    'notificar_nova_candidatura',
    'lembrete_inicio_ativo',
    'followup_ativo',
    'email_recusa_ativo',
    'limpeza_audio_ativo',
    'promocao_ativa',
    'whatsapp_sequencia_ativa',
    'campanha_whatsapp_ativa',
  ];
  for (const campo of campos) {
    assert.match(
      html,
      new RegExp(`<input type="checkbox" form="form-notificacoes" name="${campo}" value="1"`),
      `${campo} precisa continuar existindo, com o MESMO name, apontando pro form compartilhado`,
    );
  }

  // Nenhum <form> aninhado: o form-notificacoes e SEMPRE vazio (self-closing logico),
  // nunca envolve os campos que apontam pra ele via atributo `form=`.
  assert.doesNotMatch(html, /<form id="form-notificacoes"[^>]*>\s*<input/);
});

test('"WhatsApp (pareamento)" saiu do bloco fixo do topo e foi para a aba WhatsApp', async () => {
  const { html } = await getConfigHtml();

  const idxWhatsappPainel = html.indexOf('data-tab-painel="whatsapp"');
  const idxLinkPareamento = html.indexOf('href="/admin/whatsapp">WhatsApp (pareamento)</a>');
  const idxPainelSeguinte = html.indexOf('data-tab-painel="campanhas"');

  assert.ok(idxWhatsappPainel !== -1 && idxLinkPareamento !== -1 && idxPainelSeguinte !== -1);
  assert.ok(
    idxLinkPareamento > idxWhatsappPainel && idxLinkPareamento < idxPainelSeguinte,
    'o link de pareamento precisa estar DENTRO do painel da aba WhatsApp',
  );

  // O bloco fixo do topo (Commit 4) so tem as OUTRAS 3 telas agora.
  const idxBlocoTopo = html.indexOf('href="/admin/roteiro">Editar roteiro</a>');
  const idxEntrevistaAuto = html.indexOf('Entrevista automática (geral)');
  assert.ok(idxBlocoTopo !== -1 && idxBlocoTopo < idxEntrevistaAuto);
  assert.ok(
    html.slice(idxBlocoTopo, idxEntrevistaAuto).indexOf('WhatsApp (pareamento)') === -1,
    'o link de pareamento nao pode mais estar no bloco fixo do topo',
  );
});

test('Commit 9: subtitulos explicativos abaixo de cada checkbox/opcao foram removidos', async () => {
  const { html } = await getConfigHtml();

  // Amostra de frases que existiam ABAIXO de checkboxes/campos antes do Commit 9 — nenhuma
  // pode sobreviver (o rotulo essencial e o proprio checkbox/label continuam existindo).
  assert.ok(!html.includes('Desmarcado (padrão), nenhum e-mail é enviado quando alguém se candidata'));
  assert.ok(!html.includes('Lembra, por e-mail, quem se candidatou'));
  assert.ok(!html.includes('Interruptor do <b>disparo</b>'));
  assert.ok(!html.includes('Placeholders disponíveis'));
  assert.ok(!html.includes('Interruptor do envio em massa de <a href="/admin/promocao">'));
  assert.ok(!html.includes('O e-mail de teste sai pelo <b>mesmo</b> provedor'));
  assert.ok(!html.includes('Libera espaço apagando os arquivos de áudio'));
  assert.ok(!html.includes('Contadas a partir da <b>última atividade</b>'));

  // Os rotulos essenciais (o texto DENTRO do <span> ao lado do checkbox) continuam.
  assert.match(html, /Avisar por e-mail a cada <b>nova candidatura<\/b>/);
  assert.match(html, /Enviar a <b>sequência de WhatsApp<\/b>/);

  // A entrevista automatica NAO faz parte deste escopo (fica fora das abas, com seu
  // aviso-alerta preservado — nao e um "subtitulo abaixo de checkbox").
  assert.match(html, /Este ajuste vale de fato/);
});

test('"Entrevista automática" fica FORA de qualquer painel de aba', async () => {
  const { html } = await getConfigHtml();

  const idxEntrevistaAuto = html.indexOf('<h2>Entrevista automática (geral)</h2>');
  const idxPrimeiroPainel = html.indexOf('<div data-tab-painel=');
  assert.ok(idxEntrevistaAuto !== -1 && idxPrimeiroPainel !== -1);
  assert.ok(idxEntrevistaAuto < idxPrimeiroPainel, 'a entrevista automatica precisa vir ANTES de qualquer painel de aba');
});
