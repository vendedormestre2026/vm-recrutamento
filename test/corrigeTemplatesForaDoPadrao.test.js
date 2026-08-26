'use strict';

// Correcao pontual em db/migrate.js (ETAPA C, Incremento 2): desativa, no boot, qualquer
// template ATIVO cujo nome_meta nao pertenca a Vendedor Mestre (nem termina em "_vm" nem
// esta na lista de excecao — ver src/lib/templatesWhatsapp.js). Cobre o dado que ja tinha
// sido sincronizado ERRADO antes do filtro existir: convite_bni_workshop_ady (o caso real,
// do workshop do BNI, outro uso da mesma conta Central Whats).
//
// As linhas aqui sao inseridas via SQL DIRETO (nao via db.sincronizarTemplateWhatsapp) DE
// PROPOSITO: simula exatamente o estado real de producao — dado que ja estava la ANTES do
// filtro de sincronizacao existir, nao dado que passaria pelo filtro hoje.

const os = require('node:os');
const path = require('node:path');

process.env.DATABASE_PATH = path.join(os.tmpdir(), `vm-test-corrige-templates-${process.pid}-${Date.now()}.db`);
process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert/strict');

const db = require('../src/db');
const { migrar } = require('../src/db/migrate');

migrar(); // primeira passada: cria o schema. A correcao ja roda aqui, mas ainda nao ha dado
// fora do padrao pra ela agir — os testes inserem o cenario DEPOIS e chamam migrar() de novo.

const exec = (sql, ...p) => db.getDb().prepare(sql).run(...p);
function zerar() {
  exec('DELETE FROM templates_whatsapp');
}
function linha(nomeMeta) {
  return db.getDb().prepare('SELECT * FROM templates_whatsapp WHERE nome_meta = ?').get(nomeMeta);
}
function inserirTemplate(nomeMeta, ativo) {
  exec(
    `INSERT INTO templates_whatsapp (nome_meta, idioma, categoria, variaveis, ativo)
     VALUES (?, 'pt_BR', 'marketing', '[]', ?)`,
    nomeMeta,
    ativo,
  );
}

test('linha pre-existente SEM sufixo "_vm" e fora da lista de excecao: desativada pela correcao pontual', () => {
  zerar();
  inserirTemplate('convite_bni_workshop_ady', 1); // caso real: ja sincronizado errado, ativo=1

  migrar(); // roda a correcao de novo

  assert.equal(linha('convite_bni_workshop_ady').ativo, 0);
});

test('linhas legitimas (sufixo "_vm" ou excecao) NAO sao tocadas pela correcao', () => {
  zerar();
  inserirTemplate('confirmacao_cadastro_vaga_vm', 1);
  inserirTemplate('nova_vaga_v1', 1); // excecao explicita, nao termina em _vm
  inserirTemplate('nova_vaga_v2', 1); // excecao explicita, nao termina em _vm
  inserirTemplate('convite_bni_workshop_ady', 1); // fora do padrao, controle

  migrar();

  assert.equal(linha('confirmacao_cadastro_vaga_vm').ativo, 1);
  assert.equal(linha('nova_vaga_v1').ativo, 1);
  assert.equal(linha('nova_vaga_v2').ativo, 1);
  assert.equal(linha('convite_bni_workshop_ady').ativo, 0);
});

test('linha fora do padrao que JA estava ativo=0 (desligada a mao antes): permanece 0, sem erro', () => {
  zerar();
  inserirTemplate('outro_uso_qualquer', 0);

  assert.doesNotThrow(() => migrar());
  assert.equal(linha('outro_uso_qualquer').ativo, 0);
});

test('idempotente: rodar migrar() duas vezes seguidas nao muda nada na segunda', () => {
  zerar();
  inserirTemplate('convite_bni_workshop_ady', 1);

  migrar(); // desativa
  const apos1 = linha('convite_bni_workshop_ady').atualizado_em;

  migrar(); // roda de novo — nao deveria achar mais nenhuma linha ativo=1 fora do padrao
  const apos2 = linha('convite_bni_workshop_ady');

  assert.equal(apos2.ativo, 0);
  assert.equal(apos2.atualizado_em, apos1, 'segunda passada nao pode tocar a linha de novo (ja estava ativo=0)');
});
