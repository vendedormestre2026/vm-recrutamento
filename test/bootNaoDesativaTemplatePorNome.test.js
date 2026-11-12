'use strict';

// (2026-11-11) db/migrate.js desativava no boot todo template ativo cujo nome nao terminasse
// em "_vm" (fora de uma lista de excecoes). A trava de nome foi removida: a instancia Jean API
// e so da Vendedor Mestre. Este arquivo garante que o boot nao desativa mais NADA por nome —
// e que nao reativa o que um humano desligou.
//
// Linhas inseridas por SQL direto, simulando o estado de producao antes do boot.

const os = require('node:os');
const path = require('node:path');

process.env.DATABASE_PATH = path.join(os.tmpdir(), `vm-test-boot-templates-${process.pid}-${Date.now()}.db`);
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

test('boot nao desativa template ativo por nome (com ou sem "_vm")', () => {
  zerar();
  for (const nome of ['confirmacao_cadastro_vaga_vm', 'nova_vaga_v1', 'convite_grupo_entrevista_vox', 'convite_bni_workshop_ady', 'outro_nome']) {
    inserirTemplate(nome, 1);
  }

  migrar();

  for (const nome of ['confirmacao_cadastro_vaga_vm', 'nova_vaga_v1', 'convite_grupo_entrevista_vox', 'convite_bni_workshop_ady', 'outro_nome']) {
    assert.equal(linha(nome).ativo, 1, `${nome} nao pode ser desativado pelo boot`);
  }
});

test('boot nao reativa template desligado a mao (ativo=0 continua 0)', () => {
  zerar();
  inserirTemplate('convite_bni_workshop_ady', 0);

  migrar();

  assert.equal(linha('convite_bni_workshop_ady').ativo, 0);
});
