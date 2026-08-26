'use strict';

// Kill-switch dedicado da automacao de reprovacao (ETAPA B, Incremento B3):
// automacao_reprovacao_whatsapp_ativa, em `configuracoes` (mesmo padrao de TODAS as outras
// varreduras — limpeza_audio_ativo, whatsapp_sequencia_ativa etc.), default DESLIGADO.
//
// PROPOSITALMENTE NAO reutiliza WHATSAPP_BAILEYS_ATIVO nem whatsapp_sequencia_ativa — os
// dois ja estao ligados em producao para WA1/WA2, e nao podem virar gate acidental para
// esta automacao nova, ainda sem copy aprovada.

const os = require('node:os');
const path = require('node:path');

process.env.DATABASE_PATH = path.join(os.tmpdir(), `vm-test-decisao-killswitch-${process.pid}-${Date.now()}.db`);
process.env.INTERVIEW_MOCK = 'true';
process.env.SESSION_SECRET = 'segredo-de-teste';
process.env.ADMIN_USER = 'admin-teste';
process.env.ADMIN_PASSWORD = 'senha-teste';
process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert/strict');

const db = require('../src/db');
const { migrar } = require('../src/db/migrate');
const decisaoRecrutador = require('../src/lib/decisaoRecrutador');

migrar();

test("CHAVE_ATIVO e propria (nao coincide com whatsapp_sequencia_ativa nem outro toggle existente)", () => {
  assert.equal(decisaoRecrutador.CHAVE_ATIVO, 'automacao_reprovacao_whatsapp_ativa');
});

test('ativo() comeca FALSE (nasce desligado, mesma coluna ausente do padrao do projeto)', () => {
  assert.equal(decisaoRecrutador.ativo(), false);
});

test('db.definirConfigBool liga e desliga a chave, e ativo() reflete o valor gravado', () => {
  db.definirConfigBool(decisaoRecrutador.CHAVE_ATIVO, true);
  assert.equal(decisaoRecrutador.ativo(), true);

  db.definirConfigBool(decisaoRecrutador.CHAVE_ATIVO, false);
  assert.equal(decisaoRecrutador.ativo(), false);
});

test('ligar esta chave NAO liga whatsapp_sequencia_ativa (as duas sao independentes)', () => {
  db.definirConfigBool(decisaoRecrutador.CHAVE_ATIVO, true);
  assert.equal(db.obterConfigBool('whatsapp_sequencia_ativa', false), false);
  db.definirConfigBool(decisaoRecrutador.CHAVE_ATIVO, false);
});
