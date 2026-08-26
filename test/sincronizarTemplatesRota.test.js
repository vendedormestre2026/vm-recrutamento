'use strict';

// POST /admin/campanhas-whatsapp/sincronizar-templates (ETAPA C, Incremento 3): botao
// "Sincronizar templates" do admin — chama centralWhats.listarTemplatesCentralWhats e faz
// upsert de cada template via db.sincronizarTemplateWhatsapp.
//
// Mesma disciplina de zero-rede-real do resto do arquivo de campanha: monta uma instancia
// ISOLADA do router com `transporte` FALSO injetado (mesmo padrao de comRotaEnviarTeste em
// campanhaWhatsappMeta.test.js) — nunca sobe o app inteiro, nunca toca fetch de verdade.

const os = require('node:os');
const path = require('node:path');
const express = require('express');

process.env.DATABASE_PATH = path.join(os.tmpdir(), `vm-test-sync-templates-rota-${process.pid}-${Date.now()}.db`);
process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert/strict');

const db = require('../src/db');
const { migrar } = require('../src/db/migrate');
const {
  montarConteudoCampanhaWhatsapp,
  criarRouterCampanhaWhatsapp,
} = require('../src/routes/admin_campanha_whatsapp');

migrar();

function escapeHtml(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

async function comRotaSincronizar(transporte, fn) {
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

const post = (base) =>
  fetch(`${base}/admin/campanhas-whatsapp/sincronizar-templates`, { method: 'POST', redirect: 'manual' });

function zerar() {
  db.getDb().prepare('DELETE FROM templates_whatsapp').run();
}

const TEMPLATE_A = {
  name: 'confirmacao_pedido',
  category: 'UTILITY',
  language: 'pt_BR',
  status: 'APPROVED',
  components: [{ type: 'BODY', text: 'Olá {{1}}.' }],
};
const TEMPLATE_B = {
  name: 'convite_grupo_vagas_vm',
  category: 'MARKETING',
  language: 'pt_BR',
  status: 'APPROVED',
  components: [{ type: 'BODY', text: 'Confira {{1}} vagas em {{2}}.' }],
};

test('caminho feliz: persiste os templates devolvidos e reporta novos/atualizados na query de redirect', async () => {
  zerar();
  const transportePartial = { listarTemplatesCentralWhats: async () => ({ ok: true, templates: [TEMPLATE_A, TEMPLATE_B] }) };

  await comRotaSincronizar(transportePartial, async (base) => {
    const res = await post(base);
    assert.equal(res.status, 302);
    const location = res.headers.get('location');
    assert.match(location, /sync_novos=2/);
    assert.match(location, /sync_atualizados=0/);
    assert.match(location, /sync_ignorados=0/);
  });

  const linhas = db.getDb().prepare('SELECT nome_meta FROM templates_whatsapp ORDER BY nome_meta').all();
  assert.deepEqual(linhas.map((l) => l.nome_meta), ['confirmacao_pedido', 'convite_grupo_vagas_vm']);
});

test('caminho feliz, segunda chamada: os mesmos dois templates agora contam como atualizados, nao novos', async () => {
  zerar();
  const transportePartial = { listarTemplatesCentralWhats: async () => ({ ok: true, templates: [TEMPLATE_A, TEMPLATE_B] }) };

  await comRotaSincronizar(transportePartial, async (base) => {
    await post(base); // primeira: os dois sao novos
    const res = await post(base); // segunda: os dois ja existem
    const location = res.headers.get('location');
    assert.match(location, /sync_novos=0/);
    assert.match(location, /sync_atualizados=2/);
  });
});

test('template com status nao aprovado entra em sync_ignorados, sem virar erro', async () => {
  zerar();
  const transportePartial = {
    listarTemplatesCentralWhats: async () => ({
      ok: true,
      templates: [TEMPLATE_A, { ...TEMPLATE_B, status: 'PENDING' }],
    }),
  };

  await comRotaSincronizar(transportePartial, async (base) => {
    const res = await post(base);
    const location = res.headers.get('location');
    assert.match(location, /sync_novos=1/);
    assert.match(location, /sync_ignorados=1/);
  });
});

test('Central Whats indisponivel: redireciona com sync_erro, NAO lanca, NAO toca o banco', async () => {
  zerar();
  const transporteQuebrado = {
    listarTemplatesCentralWhats: async () => ({ ok: false, erro: 'Falha de rede ao chamar o Central Whats: timeout' }),
  };

  await comRotaSincronizar(transporteQuebrado, async (base) => {
    const res = await post(base);
    assert.equal(res.status, 302, 'a rota tem que responder normalmente, nunca 500');
    const location = res.headers.get('location');
    assert.match(location, /sync_erro=/);
    assert.match(decodeURIComponent(location), /timeout/);
  });

  assert.equal(db.getDb().prepare('SELECT COUNT(*) n FROM templates_whatsapp').get().n, 0);
});

test('transporte lanca uma excecao inesperada (violando o contrato de "nunca lanca"): rota continua respondendo, nao trava', async () => {
  zerar();
  const transporteInstavel = {
    listarTemplatesCentralWhats: async () => { throw new Error('erro totalmente inesperado'); },
  };

  await comRotaSincronizar(transporteInstavel, async (base) => {
    const res = await fetch(`${base}/admin/campanhas-whatsapp/sincronizar-templates`, {
      method: 'POST',
      redirect: 'manual',
    });
    // Defesa em profundidade (try/catch na rota, ver o comentario dela): mesmo que o
    // contrato de "nunca lanca" de listarTemplatesCentralWhats seja violado, a rota
    // responde com um redirect claro em vez de deixar a requisicao sem resposta.
    assert.equal(res.status, 302);
    assert.match(decodeURIComponent(res.headers.get('location')), /erro totalmente inesperado/);
  });
});

// ── View: banner + botao ──

test('view: banner de sucesso aparece quando a query tem sync_novos/sync_atualizados', () => {
  const html = montarConteudoCampanhaWhatsapp({
    escapeHtml,
    fmtInt: String,
    query: { sync_novos: '2', sync_atualizados: '1', sync_ignorados: '0' },
  });
  assert.match(html, /2 template\(s\) novo\(s\), 1 atualizado\(s\)/);
});

test('view: banner de erro aparece quando a query tem sync_erro, com o texto escapado', () => {
  const html = montarConteudoCampanhaWhatsapp({
    escapeHtml,
    fmtInt: String,
    query: { sync_erro: '<script>alert(1)</script>' },
  });
  assert.match(html, /Não foi possível sincronizar/);
  assert.doesNotMatch(html, /<script>alert\(1\)<\/script>/, 'erro vindo de fora tem que passar por escapeHtml');
});

test('view: botao "Sincronizar templates" existe na tela, com a action certa', () => {
  const html = montarConteudoCampanhaWhatsapp({ escapeHtml, fmtInt: String, query: {} });
  assert.match(html, /Sincronizar templates/);
  assert.match(html, /action="\/admin\/campanhas-whatsapp\/sincronizar-templates"/);
});
