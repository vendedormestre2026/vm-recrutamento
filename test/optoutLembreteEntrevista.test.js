'use strict';

// WA3 (incremento 5) — opt-out dos lembretes pela ORIGEM do convite (D3).
//
//   houve WA2  -> transacional: so `total` suprime; tabela antiga (sem escopo) nao e lida
//   so massa   -> campanha: qualquer opt-out suprime, inclusive a tabela antiga

const os = require('node:os');
const path = require('node:path');

process.env.DATABASE_PATH = path.join(os.tmpdir(), `vm-test-optout-lembrete-${process.pid}-${Date.now()}.db`);
process.env.INTERVIEW_MOCK = 'true';
process.env.SESSION_SECRET = 'segredo-de-teste';
process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert/strict');

const db = require('../src/db');
const { migrar } = require('../src/db/migrate');
const optout = require('../src/lib/optoutWhatsapp');
const { carregarOptout, suprimidoPorOptout } = require('../src/lib/publicoLembreteEntrevista');
const { chaveCanonicaTelefone } = require('../src/lib/chaveTelefone');
const { TIPOS } = require('../src/lib/lembreteEntrevista');

migrar();
db.definirConfigBool(optout.CHAVE_ATIVO, true);

let n = 0;
function pessoa(houveWa2) {
  n += 1;
  const telefone = `55479995${String(80000 + n).padStart(5, '0')}`;
  return { telefone, telefoneCanonico: chaveCanonicaTelefone(telefone), houveWa2 };
}

const suprimido = (dest, tipo = 'wa3b') => suprimidoPorOptout(dest, tipo, carregarOptout());

test('tabela de escopo: wa3a/wa3b/wa3c classificados como transacionais', () => {
  for (const t of TIPOS) assert.equal(optout.escopoDoTipoMensagem(t), 'transacional');
});

test('escopoDoLembreteEntrevista: WA2 -> transacional; so massa -> campanha', () => {
  assert.equal(optout.escopoDoLembreteEntrevista('wa3c', { houveWa2: true }), 'transacional');
  assert.equal(optout.escopoDoLembreteEntrevista('wa3c', { houveWa2: false }), 'campanha');
  assert.equal(optout.escopoDoLembreteEntrevista('wa3c'), 'campanha', 'sem informacao: o lado restritivo');
});

test('sem opt-out ninguem e suprimido', () => {
  assert.equal(suprimido(pessoa(true)), false);
  assert.equal(suprimido(pessoa(false)), false);
});

test('opt-out de CAMPANHA: suprime quem so recebeu a massa, NAO quem recebeu WA2', () => {
  const comWa2 = pessoa(true);
  const soMassa = pessoa(false);
  optout.registrarOptout({ telefone: comWa2.telefone, escopo: 'campanha' });
  optout.registrarOptout({ telefone: soMassa.telefone, escopo: 'campanha' });
  for (const t of TIPOS) {
    assert.equal(suprimido(comWa2, t), false, t);
    assert.equal(suprimido(soMassa, t), true, t);
  }
});

test('opt-out TOTAL suprime nos dois casos', () => {
  const comWa2 = pessoa(true);
  const soMassa = pessoa(false);
  optout.registrarOptout({ telefone: comWa2.telefone, escopo: 'total' });
  optout.registrarOptout({ telefone: soMassa.telefone, escopo: 'total' });
  assert.equal(suprimido(comWa2), true);
  assert.equal(suprimido(soMassa), true);
});

test('tabela ANTIGA (sem escopo): suprime so quem veio da massa', () => {
  const comWa2 = pessoa(true);
  const soMassa = pessoa(false);
  db.registrarOptOutWhatsapp(comWa2.telefone, 'teste');
  db.registrarOptOutWhatsapp(soMassa.telefone, 'teste');
  assert.equal(suprimido(comWa2), false);
  assert.equal(suprimido(soMassa), true);
});

test('opt-out pela outra grafia do celular (sem o 9) tambem suprime', () => {
  const p = pessoa(false);
  const semNove = p.telefone.replace(/^5547(9)/, '5547');
  optout.registrarOptout({ telefone: semNove, escopo: 'campanha' });
  assert.equal(suprimido(p), true);
});

test('kill-switch do opt-out desligado: tabela nova ignorada (mesma regra dos outros motores)', () => {
  const p = pessoa(true);
  optout.registrarOptout({ telefone: p.telefone, escopo: 'total' });
  db.definirConfigBool(optout.CHAVE_ATIVO, false);
  try {
    assert.equal(suprimido(p), false);
  } finally {
    db.definirConfigBool(optout.CHAVE_ATIVO, true);
  }
});
