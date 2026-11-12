'use strict';

// (2026-11-11) Guarda que substituiu a trava por nome: template com variavel ainda sem
// mapeamento (PLACEHOLDER_CAMPO_*, gravado pelo sync — ex.: convite_bni_workshop_ady,
// followup*_workshop) nao pode ser escolhido nem enviado em campanha. Cobre: a regra, os
// selects da tela, o POST de criacao, o envio de teste avulso, o ciclo de envio e o aviso na
// tabela de Templates. Zero rede: transporte falso que falha se for chamado.

const os = require('node:os');
const path = require('node:path');
const express = require('express');

process.env.DATABASE_PATH = path.join(os.tmpdir(), `vm-test-template-sem-mapeamento-${process.pid}-${Date.now()}.db`);
process.env.OPTOUT_TOKEN_SECRET = 'segredo-hmac-de-teste';
process.env.NODE_ENV = 'test';
process.env.META_CAMPANHA_MOCK = 'true';

const test = require('node:test');
const assert = require('node:assert/strict');

const db = require('../src/db');
const { migrar } = require('../src/db/migrate');
const job = require('../src/lib/campanhaWhatsapp');
const { temVariavelSemMapeamento } = require('../src/lib/templatesWhatsapp');
const {
  montarConteudoCampanhaWhatsapp,
  criarRouterCampanhaWhatsapp,
} = require('../src/routes/admin_campanha_whatsapp');

migrar();

const exec = (sql, ...p) => db.getDb().prepare(sql).run(...p);
const uma = (sql, ...p) => db.getDb().prepare(sql).get(...p);
const linha = (nomeMeta) => uma('SELECT * FROM templates_whatsapp WHERE nome_meta = ?', nomeMeta);

function escapeHtml(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

function zerar() {
  exec('DELETE FROM campanha_whatsapp_envios');
  exec('DELETE FROM campanhas_whatsapp');
  exec('DELETE FROM templates_whatsapp');
  exec('DELETE FROM regioes_grupos_whatsapp');
  exec('DELETE FROM whatsapp_opt_out');
  exec('DELETE FROM whatsapp_optout');
  db.definirConfigBool(job.CHAVE_ATIVO, false);
}

function semRuido(fn) {
  const { log, warn, error } = console;
  console.log = console.warn = console.error = () => {};
  return Promise.resolve()
    .then(fn)
    .finally(() => Object.assign(console, { log, warn, error }));
}

// Exatamente o que o sync grava para um BODY com {{1}}: placeholder, ativo=1.
function sincronizarComPlaceholder(nome = 'convite_bni_workshop_ady') {
  db.sincronizarTemplateWhatsapp({
    name: nome,
    category: 'MARKETING',
    language: 'pt_BR',
    status: 'APPROVED',
    components: [{ type: 'BODY', text: 'Olá {{1}}, participe do workshop.' }],
  });
  return linha(nome);
}

function sincronizarSemVariaveis(nome = 'convite_grupo_entrevista_vox') {
  db.sincronizarTemplateWhatsapp({
    name: nome,
    category: 'MARKETING',
    language: 'pt_BR',
    status: 'APPROVED',
    components: [{ type: 'BODY', text: 'Oi! Entre no grupo da entrevista.' }],
  });
  return linha(nome);
}

const transporteNuncaChamado = {
  enviarTemplate: async () => {
    throw new Error('enviarTemplate NAO deveria ter sido chamado');
  },
  listarTemplatesCentralWhats: async () => ({ ok: true, templates: [] }),
};

async function comRota(fn) {
  const app = express();
  app.use(express.json());
  app.use(express.urlencoded({ extended: true }));
  app.use(
    '/admin/campanhas-whatsapp',
    criarRouterCampanhaWhatsapp({
      paginaAdmin: () => '',
      escapeHtml,
      fmtInt: String,
      sanearBusca: (s) => String(s || '').trim(),
      transporte: transporteNuncaChamado,
    }),
  );
  const server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  try {
    return await fn(`http://127.0.0.1:${server.address().port}`);
  } finally {
    await new Promise((r) => server.close(r));
  }
}

const criarCampanhaPost = (base, templateId) =>
  fetch(`${base}/admin/campanhas-whatsapp`, {
    method: 'POST',
    redirect: 'manual',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ nome: 'Teste', template_id: String(templateId), tipo_mensagem: 'convite_grupo' }),
  });

// ══════════════════ Regra ══════════════════

test('regra: detecta PLACEHOLDER_CAMPO_* no JSON ou no array; mapeado/vazio/invalido nao bloqueia', () => {
  assert.equal(temVariavelSemMapeamento('[{"posicao":1,"campo":"PLACEHOLDER_CAMPO_1"}]'), true);
  assert.equal(
    temVariavelSemMapeamento([{ posicao: 1, campo: 'nome_primeiro' }, { posicao: 2, campo: 'PLACEHOLDER_CAMPO_2' }]),
    true,
  );
  assert.equal(temVariavelSemMapeamento('[{"posicao":1,"campo":"nome_primeiro"}]'), false);
  assert.equal(temVariavelSemMapeamento('[]'), false);
  assert.equal(temVariavelSemMapeamento(null), false);
  assert.equal(temVariavelSemMapeamento('nao e json'), false);
});

// ══════════════════ Tela ══════════════════

test('tela: template com placeholder fica fora dos selects e aparece sinalizado na tabela', () => {
  zerar();
  const bloqueado = sincronizarComPlaceholder();
  const livre = sincronizarSemVariaveis();

  const html = montarConteudoCampanhaWhatsapp({ escapeHtml, fmtInt: String, query: {} });

  assert.doesNotMatch(html, new RegExp(`<option value="${bloqueado.id}">`));
  assert.match(html, new RegExp(`<option value="${livre.id}">convite_grupo_entrevista_vox`));
  assert.match(html, /sem mapeamento — bloqueado/);
});

// ══════════════════ Criacao ══════════════════

test('criacao: POST / com template com placeholder e recusado, nenhuma campanha gravada', async () => {
  zerar();
  const t = sincronizarComPlaceholder();

  const res = await semRuido(() => comRota((base) => criarCampanhaPost(base, t.id)));

  assert.equal(res.status, 302);
  assert.match(res.headers.get('location'), /erro=template_sem_mapeamento/);
  assert.equal(uma('SELECT COUNT(*) AS n FROM campanhas_whatsapp').n, 0);
});

test('criacao: template sem variaveis continua criando campanha normalmente', async () => {
  zerar();
  const t = sincronizarSemVariaveis();

  const res = await semRuido(() => comRota((base) => criarCampanhaPost(base, t.id)));

  assert.equal(res.status, 302);
  assert.match(res.headers.get('location'), /salvo=1/);
  assert.equal(uma('SELECT COUNT(*) AS n FROM campanhas_whatsapp').n, 1);
});

// ══════════════════ Envio de teste avulso ══════════════════

test('envio de teste: template com placeholder -> 400, sem tocar a rede', async () => {
  zerar();
  const t = sincronizarComPlaceholder();

  const res = await comRota((base) =>
    fetch(`${base}/admin/campanhas-whatsapp/enviar-teste`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ applicationId: 1, templateId: t.id, telefoneDestino: '+5547999582500' }),
    }));

  assert.equal(res.status, 400);
  const corpo = await res.json();
  assert.equal(corpo.ok, false);
  assert.match(corpo.erro, /sem mapeamento/);
});

// ══════════════════ Ciclo de envio ══════════════════

test('ciclo: campanha (antiga) com template com placeholder -> envio marcado como falha, nada enviado', async () => {
  zerar();
  const t = sincronizarComPlaceholder();
  exec('INSERT INTO regioes_grupos_whatsapp (cidade, link_convite_grupo) VALUES (?, ?)', 'Joinville', 'https://chat.whatsapp.com/ABC123');
  // Gravada direto no banco: simula um rascunho criado antes da guarda existir.
  const campanhaId = db.criarCampanhaWhatsapp({
    nome: 'Antiga',
    templateId: t.id,
    baseAlvo: 'ambos',
    tipoMensagem: 'convite_grupo',
    criterios: {},
  });
  db.definirStatusCampanhaWhatsapp(campanhaId, 'ativa');
  db.materializarEnvioCampanhaWhatsapp({
    campanhaId,
    telefone: '5547999582500',
    nome: 'Ana Paula',
    origemTipo: 'talento',
    origemId: 1,
    cidade: 'Joinville',
  });
  db.definirConfigBool(job.CHAVE_ATIVO, true);

  let chamadas = 0;
  const resumo = await semRuido(() =>
    job.processarCicloCampanhaWhatsapp({
      intervaloMs: 0,
      dormir: async () => {},
      enviarTemplate: async () => {
        chamadas += 1;
        return { wamid: 'nao-deveria' };
      },
    }));

  assert.equal(chamadas, 0, 'o provedor nunca pode ser chamado');
  assert.equal(resumo.enviados, 0);
  assert.equal(resumo.falhas, 1);
  const envio = uma('SELECT * FROM campanha_whatsapp_envios WHERE campanha_id = ?', campanhaId);
  assert.equal(envio.status, 'falha');
});
