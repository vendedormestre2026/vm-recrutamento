'use strict';

// db.sincronizarTemplateWhatsapp (ETAPA C, Incremento 2): upsert de UM template no formato
// devolvido por centralWhats.listarTemplatesCentralWhats em templates_whatsapp.
//
// Nome do fixture padrao (`templateApi()`) termina em "_vm" DE PROPOSITO — bate a convencao
// de nome da Vendedor Mestre (ver src/lib/templatesWhatsapp.js), pra nao ser pego pelo
// filtro de padrao coberto na secao dedicada mais abaixo.

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
    name: 'confirmacao_pedido_vm',
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

  assert.deepEqual(r, { ignorado: false, novo: true, nomeMeta: 'confirmacao_pedido_vm' });
  const t = linha('confirmacao_pedido_vm');
  assert.equal(t.idioma, 'pt_BR');
  assert.equal(t.categoria, 'utility'); // veio UTILITY (maiusculo) da API
  assert.equal(t.ativo, 1);
  assert.deepEqual(JSON.parse(t.variaveis), [
    { posicao: 1, campo: 'PLACEHOLDER_CAMPO_1' },
    { posicao: 2, campo: 'PLACEHOLDER_CAMPO_2' },
  ]);
});

test('insert, template SEM nenhum componente de botao: botao_parametro_fixo nasce NULL', () => {
  zerar();
  const r = db.sincronizarTemplateWhatsapp(templateApi());
  assert.equal(r.ignorado, false);
  assert.equal(linha('confirmacao_pedido_vm').botao_parametro_fixo, null);
});

// Regressao: ate a sessao anterior, esta funcao tentava extrair um valor de botao do
// payload — removido apos teste real (ver o comentario extenso de sincronizarTemplateWhatsapp
// em sqlite.js sobre os dois motivos). Este teste usa o formato REAL observado contra o
// Central Whats de producao (type: "BUTTONS", plural, com array `buttons` aninhado, url com
// o placeholder "{{1}}" literal) — nao mais o formato hipotetico "type: BUTTON" de antes.
test('insert, payload REAL com botao de URL dinamica (type: BUTTONS): botao_parametro_fixo continua NULL', () => {
  zerar();
  db.sincronizarTemplateWhatsapp(
    templateApi({
      name: 'convite_grupo_vagas_vm',
      components: [
        { type: 'BODY', text: 'Oi {{1}}! Confira vagas em {{2}}.' },
        { type: 'FOOTER', text: 'Vendedor Mestre' },
        {
          type: 'BUTTONS',
          buttons: [
            {
              type: 'URL',
              text: 'Entrar no Grupo',
              url: 'https://entrevista.vendedormestre.com.br/grupo/{{1}}',
              example: ['https://entrevista.vendedormestre.com.br/grupo/joinville'],
            },
          ],
        },
      ],
    }),
  );
  assert.equal(linha('convite_grupo_vagas_vm').botao_parametro_fixo, null);
});

test("status diferente de APPROVED e ignorado silenciosamente (sem lancar, sem gravar linha)", () => {
  zerar();
  const r = db.sincronizarTemplateWhatsapp(templateApi({ status: 'PENDING' }));
  assert.equal(r.ignorado, true);
  assert.equal(r.razao, 'status_nao_aprovado');
  assert.match(r.motivo, /PENDING/);
  assert.equal(linha('confirmacao_pedido_vm'), undefined);
});

test('update de template existente: idioma/categoria atualizam, ativo e variaveis sao PRESERVADOS', () => {
  zerar();
  // Estado local "de producao": ativo=0 (desligado manualmente) e um mapeamento REAL ja
  // configurado a mao (nao o placeholder que um sync geraria).
  exec(
    `INSERT INTO templates_whatsapp (nome_meta, idioma, categoria, variaveis, ativo, botao_parametro_fixo)
     VALUES ('confirmacao_pedido_vm', 'en_US', 'marketing', ?, 0, 'valor-manual-antigo')`,
    JSON.stringify([{ posicao: 1, campo: 'nome_primeiro' }, { posicao: 2, campo: 'numero_pedido' }]),
  );

  const r = db.sincronizarTemplateWhatsapp(templateApi()); // pt_BR / UTILITY / sem BUTTON

  assert.deepEqual(r, { ignorado: false, novo: false, nomeMeta: 'confirmacao_pedido_vm' });
  const t = linha('confirmacao_pedido_vm');
  assert.equal(t.idioma, 'pt_BR', 'idioma vem da API, sempre');
  assert.equal(t.categoria, 'utility', 'categoria vem da API, sempre');
  assert.equal(t.ativo, 0, 'ativo=0 (desligado a mao) tem que sobreviver ao sync');
  assert.deepEqual(
    JSON.parse(t.variaveis),
    [{ posicao: 1, campo: 'nome_primeiro' }, { posicao: 2, campo: 'numero_pedido' }],
    'mapeamento real configurado a mao nao pode ser substituido por PLACEHOLDER_CAMPO_N',
  );
});

test('update: botao_parametro_fixo NUNCA e escrito pelo sync, mesmo quando o payload tem um botao de URL dinamica (formato real)', () => {
  zerar();
  exec(
    `INSERT INTO templates_whatsapp (nome_meta, idioma, categoria, variaveis, botao_parametro_fixo)
     VALUES ('confirmacao_pedido_vm', 'pt_BR', 'utility', '[]', 'valor-configurado-a-mao')`,
  );
  db.sincronizarTemplateWhatsapp(
    templateApi({
      components: [
        { type: 'BODY', text: 'Olá {{1}}.' },
        { type: 'BUTTONS', buttons: [{ type: 'URL', url: 'https://outro-template.com/{{1}}' }] },
      ],
    }),
  );
  assert.equal(
    linha('confirmacao_pedido_vm').botao_parametro_fixo,
    'valor-configurado-a-mao',
    'o sync nao pode sobrescrever um valor configurado a mao, nunca — nem com botao presente no payload',
  );
});

test('update: SEM nenhum componente de botao no payload, o valor local tambem e PRESERVADO', () => {
  zerar();
  exec(
    `INSERT INTO templates_whatsapp (nome_meta, idioma, categoria, variaveis, botao_parametro_fixo)
     VALUES ('confirmacao_pedido_vm', 'pt_BR', 'utility', '[]', 'url-que-tem-que-sobreviver')`,
  );
  db.sincronizarTemplateWhatsapp(templateApi()); // sem nenhum componente de botao
  assert.equal(linha('confirmacao_pedido_vm').botao_parametro_fixo, 'url-que-tem-que-sobreviver');
});

test('categoria fora do enum aceito (marketing/utility/authentication) e ignorado, nao lanca', () => {
  zerar();
  const r = db.sincronizarTemplateWhatsapp(templateApi({ category: 'ALGO_NOVO_DA_META' }));
  assert.equal(r.ignorado, true);
  assert.equal(r.razao, 'categoria_invalida');
  assert.match(r.motivo, /ALGO_NOVO_DA_META/);
  assert.equal(linha('confirmacao_pedido_vm'), undefined);
});

test('categoria AUTHENTICATION (terceiro valor do enum) sincroniza normalmente', () => {
  zerar();
  const r = db.sincronizarTemplateWhatsapp(templateApi({ category: 'AUTHENTICATION', name: 'codigo_verificacao_vm' }));
  assert.equal(r.ignorado, false);
  assert.equal(linha('codigo_verificacao_vm').categoria, 'authentication');
});

test('template sem "name": ignorado, nao lanca', () => {
  zerar();
  const r = db.sincronizarTemplateWhatsapp(templateApi({ name: '' }));
  assert.equal(r.ignorado, true);
  assert.equal(r.razao, 'sem_nome');
});

test('body sem nenhuma variavel {{n}}: variaveis vira array vazio, nao quebra', () => {
  zerar();
  const r = db.sincronizarTemplateWhatsapp(
    templateApi({ components: [{ type: 'BODY', text: 'Mensagem sem variavel nenhuma.' }] }),
  );
  assert.equal(r.ignorado, false);
  assert.deepEqual(JSON.parse(linha('confirmacao_pedido_vm').variaveis), []);
});

// ══════════════════ Filtro por padrao de nome (ETAPA C, Incremento 2 da correcao) ══════════════════
//
// A mesma conta Central Whats serve outros usos (ex.: convite_bni_workshop_ady, do workshop
// do BNI de Joinville) — o filtro garante que a sincronizacao so toca templates da Vendedor
// Mestre. Ver src/lib/templatesWhatsapp.js para a regra completa (sufixo "_vm" + excecoes).

test('nome com sufixo "_vm": sincroniza normalmente (insert)', () => {
  zerar();
  const r = db.sincronizarTemplateWhatsapp(templateApi({ name: 'qualquer_coisa_vm' }));
  assert.equal(r.ignorado, false);
  assert.equal(r.novo, true);
  assert.ok(linha('qualquer_coisa_vm'));
});

test('nome SEM sufixo "_vm" e fora da lista de excecao: ignorado (nao aparece como novo, nao grava linha)', () => {
  zerar();
  const r = db.sincronizarTemplateWhatsapp(templateApi({ name: 'convite_bni_workshop_ady' }));
  assert.equal(r.ignorado, true);
  assert.equal(r.razao, 'fora_do_padrao');
  assert.match(r.motivo, /convite_bni_workshop_ady/);
  assert.equal(linha('convite_bni_workshop_ady'), undefined, 'nao pode gravar NENHUMA linha pra um nome fora do padrao');
});

test('nome fora do padrao, mas ja existente localmente: sync NAO atualiza (nao aparece como atualizado)', () => {
  zerar();
  exec(
    `INSERT INTO templates_whatsapp (nome_meta, idioma, categoria, variaveis, ativo)
     VALUES ('convite_bni_workshop_ady', 'pt_BR', 'marketing', '[]', 1)`,
  );
  const r = db.sincronizarTemplateWhatsapp(
    templateApi({ name: 'convite_bni_workshop_ady', category: 'MARKETING', language: 'en_US' }),
  );
  assert.equal(r.ignorado, true);
  assert.equal(r.razao, 'fora_do_padrao');
  // idioma NAO pode ter mudado pra en_US — o sync nem chegou a tocar a linha.
  assert.equal(linha('convite_bni_workshop_ady').idioma, 'pt_BR');
});

test('EXCECAO explicita: nova_vaga_v1 sincroniza mesmo sem terminar em "_vm"', () => {
  zerar();
  const r = db.sincronizarTemplateWhatsapp(templateApi({ name: 'nova_vaga_v1', category: 'MARKETING' }));
  assert.equal(r.ignorado, false);
  assert.ok(linha('nova_vaga_v1'));
});

test('EXCECAO explicita: nova_vaga_v2 sincroniza mesmo sem terminar em "_vm"', () => {
  zerar();
  const r = db.sincronizarTemplateWhatsapp(templateApi({ name: 'nova_vaga_v2', category: 'MARKETING' }));
  assert.equal(r.ignorado, false);
  assert.ok(linha('nova_vaga_v2'));
});
