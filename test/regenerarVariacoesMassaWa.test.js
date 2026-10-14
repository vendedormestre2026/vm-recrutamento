'use strict';

// Script de regeneracao das variacoes de massa (src/scripts/regenerar-variacoes-massa-wa.js).
//
// Dry-run por padrao (nada gravado), --commit so com --campanha, so em rascunho/pausada, so com a
// IA ligada — e o gerador e um duble: nenhum teste chama o LLM.

const os = require('node:os');
const path = require('node:path');

process.env.DATABASE_PATH = path.join(os.tmpdir(), `vm-test-regenerar-var-${process.pid}-${Date.now()}.db`);
process.env.INTERVIEW_MOCK = 'true';
process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert/strict');

const db = require('../src/db');
const { migrar } = require('../src/db/migrate');
const publico = require('../src/lib/publicoMassaWhatsapp');
const variacoes = require('../src/lib/variacoesMassaWa');
const { executar } = require('../src/scripts/regenerar-variacoes-massa-wa');
const { BASE_LEMBRETE, REDACOES_LEMBRETE } = require('./fixtures/variacoesLembreteMassaWa');

migrar();

let seq = 0;
function campanha({ textoBase, textos, status = 'rascunho', criterios = {} }) {
  seq += 1;
  const id = db.criarCampanhaMassaWa({ nome: `C${seq}`, textoBase, criterios });
  db.salvarVariacoesMassaWa(id, [...textos]);
  if (status !== 'rascunho') {
    db.getDb().prepare('UPDATE campanhas_massa_wa SET status = ? WHERE id = ?').run(status, id);
  }
  return id;
}

function geradorDuble({ ligado = true, resultado } = {}) {
  const chamadas = [];
  return {
    chamadas,
    ENV_ATIVO: 'MASSA_WA_LLM_ATIVO',
    iaLigada: () => ligado,
    gerarVariacoes: async (base) => {
      chamadas.push(base);
      return resultado || { ok: true, variacoes: [...REDACOES_LEMBRETE], erro: null, tentativas: 1 };
    },
  };
}
const rodar = (extra) => {
  const linhas = [];
  return executar({ db, publico, variacoes, log: (l) => linhas.push(l), ...extra }).then((r) => ({ ...r, linhas }));
};
const textosDe = (id) => db.listarVariacoesMassaWa(id).map((v) => v.texto);

// Cenario: o estado da producao (campanha 9 cancelada com sementes num lembrete) + casos de controle.
const comoA9 = campanha({ textoBase: BASE_LEMBRETE, textos: variacoes.VARIACOES_SEED, status: 'cancelada' });
const rascunhoAfetado = campanha({ textoBase: BASE_LEMBRETE, textos: variacoes.VARIACOES_SEED });
const padraoOk = campanha({ textoBase: variacoes.TEXTO_BASE_PADRAO, textos: variacoes.VARIACOES_SEED, status: 'concluida' });
const segmento = campanha({ textoBase: variacoes.TEXTO_BASE_CONVITE, textos: variacoes.VARIACOES_SEED_CONVITE, criterios: { fonte: 'segmento' } });

test('dry-run: lista as afetadas, diz o que da para fazer, e NAO grava nem chama o LLM', async () => {
  const gerador = geradorDuble();
  const antes = textosDe(rascunhoAfetado);
  const r = await rodar({ gerador });
  assert.equal(r.ok, true);
  const porId = Object.fromEntries(r.diagnosticos.map((d) => [d.id, d]));

  assert.equal(porId[comoA9].afetada, true);
  assert.equal(porId[comoA9].iguaisSemente, 7);
  assert.equal(porId[comoA9].regeneravel, false);
  assert.equal(porId[rascunhoAfetado].afetada, true);
  assert.equal(porId[rascunhoAfetado].regeneravel, true);
  assert.equal(porId[padraoOk].afetada, false, 'texto-base padrao com as sementes esta certo');
  assert.equal(porId[segmento], undefined, 'segmento fica fora');

  assert.ok(r.linhas.some((l) => l.includes(`campanha ${comoA9} (cancelada)`) && l.includes('nada a fazer')));
  assert.ok(r.linhas.some((l) => l.includes(`campanha ${rascunhoAfetado} (rascunho)`) && l.includes('regenerável com --commit')));
  assert.ok(r.linhas.some((l) => l.startsWith('DRY-RUN')));
  assert.equal(gerador.chamadas.length, 0);
  assert.deepEqual(textosDe(rascunhoAfetado), antes);
});

test('--commit sem --campanha e recusado', async () => {
  const r = await rodar({ gerador: geradorDuble(), commit: true });
  assert.equal(r.ok, false);
  assert.match(r.motivo, /exige --campanha/);
});

test('--commit em campanha cancelada/concluida e recusado e nao chama o LLM', async () => {
  const gerador = geradorDuble();
  const r = await rodar({ gerador, commit: true, campanhaId: comoA9 });
  assert.equal(r.ok, false);
  assert.match(r.motivo, /cancelada/);
  assert.equal(gerador.chamadas.length, 0);
});

test('--commit com a IA desligada e recusado e nao chama o LLM', async () => {
  const gerador = geradorDuble({ ligado: false });
  const r = await rodar({ gerador, commit: true, campanhaId: rascunhoAfetado });
  assert.equal(r.ok, false);
  assert.match(r.motivo, /MASSA_WA_LLM_ATIVO desligado/);
  assert.equal(gerador.chamadas.length, 0);
});

test('--commit com falha na geracao: registra o erro e nao grava variacao nenhuma', async () => {
  const antes = textosDe(rascunhoAfetado);
  const gerador = geradorDuble({ resultado: { ok: false, variacoes: [], erro: 'A IA não gerou 7 variações válidas', tentativas: 3 } });
  const r = await rodar({ gerador, commit: true, campanhaId: rascunhoAfetado });
  assert.equal(r.ok, false);
  assert.deepEqual(textosDe(rascunhoAfetado), antes);
  assert.equal(db.obterCampanhaMassaWa(rascunhoAfetado).variacoes_erro, 'A IA não gerou 7 variações válidas');
});

test('--commit em rascunho afetado: gera do TEXTO-BASE, grava carimbado e nao muda o status', async () => {
  const gerador = geradorDuble();
  const r = await rodar({ gerador, commit: true, campanhaId: rascunhoAfetado });
  assert.equal(r.ok, true);
  assert.equal(r.regenerada, rascunhoAfetado);
  assert.deepEqual(gerador.chamadas, [BASE_LEMBRETE]);
  assert.deepEqual(textosDe(rascunhoAfetado), [...REDACOES_LEMBRETE]);
  const c = db.obterCampanhaMassaWa(rascunhoAfetado);
  assert.equal(c.status, 'rascunho');
  assert.equal(c.variacoes_erro, null);
  assert.equal(variacoes.variacoesDesatualizadas(c), false);

  // Rodar de novo em dry-run: ja nao e afetada.
  const d = (await rodar({ gerador: geradorDuble(), campanhaId: rascunhoAfetado })).diagnosticos[0];
  assert.equal(d.afetada, false);
});
