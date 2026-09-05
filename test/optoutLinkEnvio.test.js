'use strict';

// Incremento 5: o link de descadastro por destinatario, no momento do envio.
//
// A regra que este arquivo existe para travar e P6: O LINK NUNCA ABORTA O ENVIO. Variavel
// vazia e o erro 131008 da Meta, classificado como 'configuracao', que ABORTA o ciclo e nao
// marca ninguem — ou seja, uma falha ao montar um link acessorio pararia a campanha inteira.

const os = require('node:os');
const path = require('node:path');

process.env.DATABASE_PATH = path.join(os.tmpdir(), `vm-test-optout-link-${process.pid}-${Date.now()}.db`);
process.env.INTERVIEW_MOCK = 'true';
process.env.DESCADASTRO_SECRET = 'segredo-hmac-de-teste';
process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert/strict');

const db = require('../src/db');
const { migrar } = require('../src/db/migrate');
const { config } = require('../src/config');
const optout = require('../src/lib/optoutWhatsapp');
const campanha = require('../src/lib/campanhaWhatsapp');
const { lerTokenDescadastroWhatsapp } = require('../src/lib/descadastroWhatsapp');

migrar();

const exec = (sql, ...p) => db.getDb().prepare(sql).run(...p);

function zerar() {
  exec('DELETE FROM campanha_whatsapp_envios');
  exec('DELETE FROM campanhas_whatsapp');
  exec('DELETE FROM whatsapp_optout');
  exec("DELETE FROM configuracoes WHERE chave IN ('optout_link_campanha_ativo', 'optout_whatsapp_ativo')");
}

// ══════════════════════════════════════════════════════════════
// textoDescadastroPara — o contrato de "nunca vazio, nunca lanca"
// ══════════════════════════════════════════════════════════════

test('interruptor DESLIGADO (o default): devolve a linha de texto de fallback', () => {
  zerar();
  assert.equal(optout.linkAtivo(), false, 'nasce desligado');
  assert.equal(optout.textoDescadastroPara('5547999582500'), optout.TEXTO_FALLBACK_DESCADASTRO);
});

test('interruptor LIGADO: devolve a URL, e o token dela resolve para o telefone certo', () => {
  zerar();
  db.definirConfigBool(optout.CHAVE_LINK_ATIVO, true);
  const valor = optout.textoDescadastroPara('5547999582500');
  assert.match(valor, /\/descadastro\//);
  const token = valor.split('/descadastro/')[1];
  assert.equal(lerTokenDescadastroWhatsapp(token), '554799582500');
});

test('P6: falha ao montar o link NAO lanca e NAO devolve vazio', () => {
  zerar();
  db.definirConfigBool(optout.CHAVE_LINK_ATIVO, true);

  // Telefone irreconhecivel: montarUrlDescadastroWhatsapp LANCA (falha cedo, por contrato).
  assert.equal(optout.textoDescadastroPara('   '), optout.TEXTO_FALLBACK_DESCADASTRO);

  // Segredo ausente: tambem LANCA la dentro.
  const antigo = config.descadastro.segredo;
  config.descadastro.segredo = '';
  try {
    assert.equal(optout.textoDescadastroPara('5547999582500'), optout.TEXTO_FALLBACK_DESCADASTRO);
  } finally {
    config.descadastro.segredo = antigo;
  }
});

test('P6: o valor NUNCA e string vazia, em nenhum caminho', () => {
  zerar();
  for (const ligado of [false, true]) {
    db.definirConfigBool(optout.CHAVE_LINK_ATIVO, ligado);
    for (const tel of ['5547999582500', '', null, '   ', 'abc', '+55 47 99958-2500']) {
      const v = optout.textoDescadastroPara(tel);
      assert.equal(typeof v, 'string');
      assert.notEqual(v.trim(), '', `vazio para ${JSON.stringify(tel)} com interruptor ${ligado}`);
    }
  }
});

// ══════════════════════════════════════════════════════════════
// A variavel chegando no template, pelo ciclo real
// ══════════════════════════════════════════════════════════════

function campanhaComVariavelDeDescadastro(telefone) {
  exec(
    `INSERT OR IGNORE INTO templates_whatsapp (nome_meta, idioma, categoria, variaveis)
     VALUES ('com_descadastro_vm', 'pt_BR', 'marketing', ?)`,
    JSON.stringify([
      { posicao: 1, campo: 'nome_primeiro' },
      { posicao: 2, campo: 'cargo_vaga' },
      { posicao: 3, campo: 'cidade' },
      { posicao: 4, campo: 'link_descadastro' },
    ]),
  );
  const campanhaId = Number(
    exec(
      `INSERT INTO campanhas_whatsapp (nome, template_id, base_alvo, tipo_mensagem, status)
       VALUES ('Com descadastro',
               (SELECT id FROM templates_whatsapp WHERE nome_meta = 'com_descadastro_vm'),
               'ambos', 'divulgacao_vaga', 'ativa')`,
    ).lastInsertRowid,
  );
  exec(
    `INSERT INTO campanha_whatsapp_envios (campanha_id, telefone, nome, origem_tipo, cidade, status)
     VALUES (?, ?, 'Ana', 'application', 'Joinville', 'pendente')`,
    campanhaId,
    telefone,
  );
  db.definirConfigBool(campanha.CHAVE_ATIVO, true);
  return campanhaId;
}

async function rodarCiclo() {
  const enviados = [];
  const r = await campanha.processarCicloCampanhaWhatsapp({
    enviarTemplate: async (args) => {
      enviados.push(args);
      return { wamid: 'wamid-1' };
    },
    intervaloMs: 0,
  });
  return { r, enviados };
}

test('ciclo: com o interruptor LIGADO, a variavel 4 chega como URL', async () => {
  zerar();
  campanhaComVariavelDeDescadastro('5547999582500');
  db.definirConfigBool(optout.CHAVE_LINK_ATIVO, true);

  const { r, enviados } = await rodarCiclo();
  assert.equal(r.enviados, 1);
  assert.equal(enviados.length, 1);
  const quarta = enviados[0].variaveis[3];
  assert.match(quarta, /\/descadastro\//);
  assert.equal(lerTokenDescadastroWhatsapp(quarta.split('/descadastro/')[1]), '554799582500');
});

test('ciclo: com o interruptor DESLIGADO, a variavel 4 chega como a frase de fallback', async () => {
  zerar();
  campanhaComVariavelDeDescadastro('5547999582501');

  const { enviados } = await rodarCiclo();
  assert.equal(enviados[0].variaveis[3], optout.TEXTO_FALLBACK_DESCADASTRO);
});

test('ciclo: link quebrado NAO aborta — a mensagem sai com o fallback', async () => {
  zerar();
  campanhaComVariavelDeDescadastro('5547999582502');
  db.definirConfigBool(optout.CHAVE_LINK_ATIVO, true);

  const antigo = config.descadastro.segredo;
  config.descadastro.segredo = ''; // quebra a geracao do token
  try {
    const { r, enviados } = await rodarCiclo();
    assert.equal(r.abortado, undefined, 'o ciclo NAO pode abortar por causa do link');
    assert.equal(r.enviados, 1, 'a mensagem sai mesmo assim');
    assert.equal(enviados[0].variaveis[3], optout.TEXTO_FALLBACK_DESCADASTRO);
  } finally {
    config.descadastro.segredo = antigo;
  }
});

test('ciclo: nenhuma variavel do template sai vazia (a condicao do 131008)', async () => {
  zerar();
  campanhaComVariavelDeDescadastro('5547999582503');
  db.definirConfigBool(optout.CHAVE_LINK_ATIVO, true);

  const { enviados } = await rodarCiclo();
  for (const [i, v] of enviados[0].variaveis.entries()) {
    assert.notEqual(String(v).trim(), '', `variavel ${i + 1} saiu vazia`);
  }
});

test('template SEM a variavel de descadastro continua identico (retrocompatibilidade)', async () => {
  zerar();
  exec(
    `INSERT OR IGNORE INTO templates_whatsapp (nome_meta, idioma, categoria, variaveis)
     VALUES ('sem_descadastro_vm', 'pt_BR', 'marketing', ?)`,
    JSON.stringify([
      { posicao: 1, campo: 'nome_primeiro' },
      { posicao: 2, campo: 'cargo_vaga' },
      { posicao: 3, campo: 'cidade' },
    ]),
  );
  const campanhaId = Number(
    exec(
      `INSERT INTO campanhas_whatsapp (nome, template_id, base_alvo, tipo_mensagem, status)
       VALUES ('Sem descadastro',
               (SELECT id FROM templates_whatsapp WHERE nome_meta = 'sem_descadastro_vm'),
               'ambos', 'divulgacao_vaga', 'ativa')`,
    ).lastInsertRowid,
  );
  exec(
    `INSERT INTO campanha_whatsapp_envios (campanha_id, telefone, nome, origem_tipo, cidade, status)
     VALUES (?, '5547999582504', 'Ana', 'application', 'Joinville', 'pendente')`,
    campanhaId,
  );
  db.definirConfigBool(campanha.CHAVE_ATIVO, true);
  db.definirConfigBool(optout.CHAVE_LINK_ATIVO, true);

  const { enviados } = await rodarCiclo();
  assert.equal(enviados[0].variaveis.length, 3, 'continua com tres variaveis, na mesma ordem');
});
