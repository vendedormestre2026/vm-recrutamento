'use strict';

// db.sincronizarTemplateWhatsapp (ETAPA C, Incremento 2): upsert de UM template no formato
// devolvido por centralWhats.listarTemplatesCentralWhats em templates_whatsapp.

const os = require('node:os');
const path = require('node:path');

process.env.DATABASE_PATH = path.join(os.tmpdir(), `vm-test-sync-template-${process.pid}-${Date.now()}.db`);
process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert/strict');

const db = require('../src/db');
const { migrar } = require('../src/db/migrate');

migrar();

const exec = (sql, ...p) => db.getDb().prepare(sql).run(...p);
function zerar() {
  exec('DELETE FROM templates_whatsapp');
}

function templateApi(overrides = {}) {
  return {
    id: 'tpl_abc123',
    instance_id: 'inst_xyz',
    name: 'confirmacao_pedido',
    category: 'UTILITY',
    language: 'pt_BR',
    status: 'APPROVED',
    wa_template_id: '123456789012345',
    components: [
      { type: 'BODY', text: 'Olá {{1}}, seu pedido {{2}} foi confirmado.' },
      { type: 'FOOTER', text: 'Responda STOP para sair' },
    ],
    ...overrides,
  };
}

function linha(nomeMeta) {
  return db.getDb().prepare('SELECT * FROM templates_whatsapp WHERE nome_meta = ?').get(nomeMeta);
}

test('insert de template novo: grava categoria minuscula, ativo=1, variaveis extraidas do BODY', () => {
  zerar();
  const r = db.sincronizarTemplateWhatsapp(templateApi());

  assert.deepEqual(r, { ignorado: false, novo: true, nomeMeta: 'confirmacao_pedido' });
  const t = linha('confirmacao_pedido');
  assert.equal(t.idioma, 'pt_BR');
  assert.equal(t.categoria, 'utility'); // veio UTILITY (maiusculo) da API
  assert.equal(t.ativo, 1);
  assert.deepEqual(JSON.parse(t.variaveis), [
    { posicao: 1, campo: 'PLACEHOLDER_CAMPO_1' },
    { posicao: 2, campo: 'PLACEHOLDER_CAMPO_2' },
  ]);
});

test('template SEM componente BUTTON: nao quebra, botao_parametro_fixo fica NULL', () => {
  zerar();
  const r = db.sincronizarTemplateWhatsapp(templateApi());
  assert.equal(r.ignorado, false);
  assert.equal(linha('confirmacao_pedido').botao_parametro_fixo, null);
});

test('template COM componente BUTTON: extrai o valor pro botao_parametro_fixo', () => {
  zerar();
  db.sincronizarTemplateWhatsapp(
    templateApi({
      components: [
        { type: 'BODY', text: 'Olá {{1}}.' },
        { type: 'BUTTON', sub_type: 'URL', url: 'https://chat.whatsapp.com/exemplo' },
      ],
    }),
  );
  assert.equal(linha('confirmacao_pedido').botao_parametro_fixo, 'https://chat.whatsapp.com/exemplo');
});

test("status diferente de APPROVED e ignorado silenciosamente (sem lancar, sem gravar linha)", () => {
  zerar();
  const r = db.sincronizarTemplateWhatsapp(templateApi({ status: 'PENDING' }));
  assert.equal(r.ignorado, true);
  assert.match(r.motivo, /PENDING/);
  assert.equal(linha('confirmacao_pedido'), undefined);
});

test('update de template existente: idioma/categoria atualizam, ativo e variaveis sao PRESERVADOS', () => {
  zerar();
  // Estado local "de producao": ativo=0 (desligado manualmente) e um mapeamento REAL ja
  // configurado a mao (nao o placeholder que um sync geraria).
  exec(
    `INSERT INTO templates_whatsapp (nome_meta, idioma, categoria, variaveis, ativo, botao_parametro_fixo)
     VALUES ('confirmacao_pedido', 'en_US', 'marketing', ?, 0, 'valor-manual-antigo')`,
    JSON.stringify([{ posicao: 1, campo: 'nome_primeiro' }, { posicao: 2, campo: 'numero_pedido' }]),
  );

  const r = db.sincronizarTemplateWhatsapp(templateApi()); // pt_BR / UTILITY / sem BUTTON

  assert.deepEqual(r, { ignorado: false, novo: false, nomeMeta: 'confirmacao_pedido' });
  const t = linha('confirmacao_pedido');
  assert.equal(t.idioma, 'pt_BR', 'idioma vem da API, sempre');
  assert.equal(t.categoria, 'utility', 'categoria vem da API, sempre');
  assert.equal(t.ativo, 0, 'ativo=0 (desligado a mao) tem que sobreviver ao sync');
  assert.deepEqual(
    JSON.parse(t.variaveis),
    [{ posicao: 1, campo: 'nome_primeiro' }, { posicao: 2, campo: 'numero_pedido' }],
    'mapeamento real configurado a mao nao pode ser substituido por PLACEHOLDER_CAMPO_N',
  );
});

test('update: botao_parametro_fixo usa o valor NOVO da API quando ela traz um componente BUTTON', () => {
  zerar();
  exec(
    `INSERT INTO templates_whatsapp (nome_meta, idioma, categoria, variaveis, botao_parametro_fixo)
     VALUES ('confirmacao_pedido', 'pt_BR', 'utility', '[]', 'url-antiga')`,
  );
  db.sincronizarTemplateWhatsapp(
    templateApi({
      components: [
        { type: 'BODY', text: 'Olá {{1}}.' },
        { type: 'BUTTON', url: 'https://novo-link-da-meta' },
      ],
    }),
  );
  assert.equal(linha('confirmacao_pedido').botao_parametro_fixo, 'https://novo-link-da-meta');
});

test('update: SEM componente BUTTON na resposta, o valor local existente e PRESERVADO (ausencia != remocao)', () => {
  zerar();
  exec(
    `INSERT INTO templates_whatsapp (nome_meta, idioma, categoria, variaveis, botao_parametro_fixo)
     VALUES ('confirmacao_pedido', 'pt_BR', 'utility', '[]', 'url-que-tem-que-sobreviver')`,
  );
  db.sincronizarTemplateWhatsapp(templateApi()); // sem BUTTON nos components
  assert.equal(linha('confirmacao_pedido').botao_parametro_fixo, 'url-que-tem-que-sobreviver');
});

test('categoria fora do enum aceito (marketing/utility/authentication) e ignorado, nao lanca', () => {
  zerar();
  const r = db.sincronizarTemplateWhatsapp(templateApi({ category: 'ALGO_NOVO_DA_META' }));
  assert.equal(r.ignorado, true);
  assert.match(r.motivo, /ALGO_NOVO_DA_META/);
  assert.equal(linha('confirmacao_pedido'), undefined);
});

test('categoria AUTHENTICATION (terceiro valor do enum) sincroniza normalmente', () => {
  zerar();
  const r = db.sincronizarTemplateWhatsapp(templateApi({ category: 'AUTHENTICATION', name: 'codigo_verificacao' }));
  assert.equal(r.ignorado, false);
  assert.equal(linha('codigo_verificacao').categoria, 'authentication');
});

test('template sem "name": ignorado, nao lanca', () => {
  zerar();
  const r = db.sincronizarTemplateWhatsapp(templateApi({ name: '' }));
  assert.equal(r.ignorado, true);
});

test('body sem nenhuma variavel {{n}}: variaveis vira array vazio, nao quebra', () => {
  zerar();
  const r = db.sincronizarTemplateWhatsapp(
    templateApi({ components: [{ type: 'BODY', text: 'Mensagem sem variavel nenhuma.' }] }),
  );
  assert.equal(r.ignorado, false);
  assert.deepEqual(JSON.parse(linha('confirmacao_pedido').variaveis), []);
});
