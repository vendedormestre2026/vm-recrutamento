'use strict';

// convite_grupo_entrevista_vox (2026-11-10): template da Vendedor Mestre aprovado na Meta
// (marketing, pt_BR, SEM variaveis, com botao) cujo nome termina em "_vox", nao "_vm". Entrou em
// EXCECOES_PADRAO_VM (src/lib/templatesWhatsapp.js). Este arquivo cobre o caminho inteiro:
// sync -> boot (migrate) -> criacao da campanha -> envio, este ultimo em MOCK (zero rede).

const os = require('node:os');
const path = require('node:path');
const express = require('express');

process.env.DATABASE_PATH = path.join(os.tmpdir(), `vm-test-convite-entrevista-${process.pid}-${Date.now()}.db`);
process.env.OPTOUT_TOKEN_SECRET = 'segredo-hmac-de-teste';
process.env.NODE_ENV = 'test';
// Mock e o default do transporte; fixado aqui para o teste nunca depender do ambiente.
process.env.META_CAMPANHA_MOCK = 'true';

const test = require('node:test');
const assert = require('node:assert/strict');

const db = require('../src/db');
const { migrar } = require('../src/db/migrate');
const transporte = require('../src/providers/centralWhats/centralWhats');
const job = require('../src/lib/campanhaWhatsapp');
const { pertenceVendedorMestre } = require('../src/lib/templatesWhatsapp');
const { criarRouterCampanhaWhatsapp } = require('../src/routes/admin_campanha_whatsapp');

migrar();

const NOME = 'convite_grupo_entrevista_vox';

const exec = (sql, ...p) => db.getDb().prepare(sql).run(...p);
const uma = (sql, ...p) => db.getDb().prepare(sql).get(...p);
const linha = (nomeMeta) => uma('SELECT * FROM templates_whatsapp WHERE nome_meta = ?', nomeMeta);

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

// Os dois formatos de botao possiveis para este template. Nenhum dos dois aceita parametro
// por envio: URL sem placeholder e link fixo; quick reply nao leva valor.
const BOTOES = {
  url_fixa: { type: 'URL', text: 'Quero participar', url: 'https://chat.whatsapp.com/ABCDEF123' },
  quick_reply: { type: 'QUICK_REPLY', text: 'Quero participar' },
};

function templateApi({ name = NOME, botao = BOTOES.url_fixa } = {}) {
  return {
    name,
    category: 'MARKETING',
    language: 'pt_BR',
    status: 'APPROVED',
    components: [
      { type: 'BODY', text: 'Oi! Você foi selecionado para a próxima etapa. Entre no grupo da entrevista.' },
      { type: 'BUTTONS', buttons: [botao] },
    ],
  };
}

// ══════════════════ Sincronizacao ══════════════════

test('sync: convite_grupo_entrevista_vox passa no filtro e grava variaveis=[] e ativo=1', () => {
  zerar();
  assert.equal(pertenceVendedorMestre(NOME), true);

  const r = db.sincronizarTemplateWhatsapp(templateApi());

  assert.deepEqual(r, { ignorado: false, novo: true, nomeMeta: NOME });
  const t = linha(NOME);
  assert.equal(t.ativo, 1);
  assert.equal(t.categoria, 'marketing');
  assert.equal(t.idioma, 'pt_BR');
  assert.deepEqual(JSON.parse(t.variaveis), []);
  assert.equal(JSON.parse(t.botoes_json).length, 1);
});

for (const nome of ['convite_bni_workshop_ady', 'convite_grupo_entrevista', 'convite_grupo_entrevista_x']) {
  test(`sync: '${nome}' continua ignorado como fora_do_padrao`, () => {
    zerar();
    const r = db.sincronizarTemplateWhatsapp(templateApi({ name: nome }));

    assert.equal(r.ignorado, true);
    assert.equal(r.razao, 'fora_do_padrao');
    assert.equal(linha(nome), undefined);
  });
}

// ══════════════════ Boot ══════════════════

test('boot: migrar() NAO desativa convite_grupo_entrevista_vox (e segue desativando o de outro uso)', async () => {
  zerar();
  db.sincronizarTemplateWhatsapp(templateApi());
  exec(
    `INSERT INTO templates_whatsapp (nome_meta, idioma, categoria, variaveis, ativo)
     VALUES ('convite_bni_workshop_ady', 'pt_BR', 'marketing', '[]', 1)`,
  );

  await semRuido(() => migrar());

  assert.equal(linha(NOME).ativo, 1);
  assert.equal(linha('convite_bni_workshop_ady').ativo, 0);
});

// ══════════════════ Campanha: criacao + envio em mock ══════════════════

async function comRota(fn) {
  const app = express();
  app.use(express.urlencoded({ extended: true }));
  app.use(
    '/admin/campanhas-whatsapp',
    criarRouterCampanhaWhatsapp({
      paginaAdmin: () => '',
      escapeHtml: (s) => String(s == null ? '' : s),
      fmtInt: String,
      sanearBusca: (s) => String(s || '').trim(),
      transporte,
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

for (const [rotulo, botao] of Object.entries(BOTOES)) {
  test(`campanha (botao ${rotulo}): criada pela rota e enviada em mock sem erro, com vars vazio`, async () => {
    zerar();
    db.sincronizarTemplateWhatsapp(templateApi({ botao }));
    const tid = linha(NOME).id;
    exec('INSERT INTO regioes_grupos_whatsapp (cidade, link_convite_grupo) VALUES (?, ?)', 'Joinville', 'https://chat.whatsapp.com/ABC123');

    // Criacao pelo mesmo POST que a tela usa.
    const resposta = await semRuido(() =>
      comRota((base) =>
        fetch(`${base}/admin/campanhas-whatsapp`, {
          method: 'POST',
          redirect: 'manual',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({ nome: 'Convite entrevista', template_id: String(tid), tipo_mensagem: 'convite_grupo' }),
        })));
    assert.equal(resposta.status, 302);
    assert.match(resposta.headers.get('location'), /salvo=1/);

    const campanha = uma('SELECT * FROM campanhas_whatsapp WHERE template_id = ?', tid);
    assert.ok(campanha, 'a campanha deveria ter sido criada');
    db.definirStatusCampanhaWhatsapp(campanha.id, 'ativa');
    db.materializarEnvioCampanhaWhatsapp({
      campanhaId: campanha.id,
      telefone: '5547999582500',
      nome: 'Ana Paula',
      origemTipo: 'talento',
      origemId: 1,
      cidade: 'Joinville',
    });
    db.definirConfigBool(job.CHAVE_ATIVO, true);

    // Envio pelo transporte REAL em mock — so observamos o payload que ele montaria.
    const payloads = [];
    const resumo = await semRuido(() =>
      job.processarCicloCampanhaWhatsapp({
        intervaloMs: 0,
        dormir: async () => {},
        enviarTemplate: async (args) => {
          payloads.push(transporte.montarPayload(args));
          return transporte.enviarTemplate(args);
        },
      }));

    assert.equal(resumo.enviados, 1);
    assert.equal(resumo.falhas, 0);
    assert.equal(payloads.length, 1);
    assert.equal(payloads[0].template.name, NOME);
    assert.equal(payloads[0].template.language, 'pt_BR');
    assert.deepEqual(payloads[0].vars, {});

    const envio = uma('SELECT * FROM campanha_whatsapp_envios WHERE campanha_id = ?', campanha.id);
    assert.equal(envio.status, 'enviado');
    assert.match(envio.wamid, /^mock-/);
  });
}
