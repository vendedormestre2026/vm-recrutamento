'use strict';

// Incremento 1: tabela whatsapp_optout + camada de repositorio.
//
// Cobre a chave canonica (lib/chaveTelefone.js), a idempotencia de registrarOptout e a
// assimetria de escopo de estaOptout — que e a regra de negocio inteira do projeto.

const os = require('node:os');
const path = require('node:path');

process.env.DATABASE_PATH = path.join(os.tmpdir(), `vm-test-optout-repo-${process.pid}-${Date.now()}.db`);
process.env.INTERVIEW_MOCK = 'true';
process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert/strict');

const db = require('../src/db');
const { migrar } = require('../src/db/migrate');
const { chaveCanonicaTelefone } = require('../src/lib/chaveTelefone');
const optout = require('../src/lib/optoutWhatsapp');

migrar();

const exec = (sql, ...p) => db.getDb().prepare(sql).run(...p);

function zerar() {
  exec('DELETE FROM whatsapp_optout');
  exec("DELETE FROM configuracoes WHERE chave = 'optout_whatsapp_ativo'");
}

// ══════════════════════════════════════════════════════════════
// chaveCanonicaTelefone — P3
// ══════════════════════════════════════════════════════════════

test('chave canonica: com e sem o nono digito produzem a MESMA chave', () => {
  assert.equal(chaveCanonicaTelefone('5531996820290'), chaveCanonicaTelefone('553196820290'));
  assert.equal(chaveCanonicaTelefone('5531996820290'), '553196820290');
});

test('chave canonica: aceita as tres procedencias (formulario cru, normalizarTelefoneWhatsapp, normalizarTelefoneRecebido)', () => {
  // 55 + DDD 47 + os ULTIMOS 8 de "999582500" (o nono digito fica de fora, e esse e o ponto).
  const esperada = '554799582500';
  // formulario cru, com mascara e DDI explicito
  assert.equal(chaveCanonicaTelefone('+55 (47) 99958-2500'), esperada);
  // saida de normalizarTelefoneWhatsapp / normalizarTelefoneRecebido (so digitos, com DDI)
  assert.equal(chaveCanonicaTelefone('5547999582500'), esperada);
  // digitado sem DDI nenhum
  assert.equal(chaveCanonicaTelefone('47999582500'), esperada);
  // com espacos sobrando nas pontas
  assert.equal(chaveCanonicaTelefone('  5547999582500  '), esperada);
});

test('chave canonica: DDI 55 duplicado na origem colapsa na mesma chave do numero correto', () => {
  // Dado real de producao (applications id 336): "+55 +5547988301250".
  assert.equal(chaveCanonicaTelefone('+55 +5547988301250'), chaveCanonicaTelefone('5547988301250'));
  assert.equal(chaveCanonicaTelefone('555547988301250'), chaveCanonicaTelefone('5547988301250'));
});

test('chave canonica: entrada suja devolve null sem lancar', () => {
  for (const entrada of [null, undefined, '', '   ', 'abc', '+', '()', '123', 55, {}, []]) {
    assert.equal(chaveCanonicaTelefone(entrada), null, `entrada: ${JSON.stringify(entrada)}`);
  }
});

test('chave canonica: telefone fixo de 8 digitos tambem canoniza', () => {
  assert.equal(chaveCanonicaTelefone('4733334444'), '554733334444');
  assert.equal(chaveCanonicaTelefone('554733334444'), '554733334444');
});

test('chave canonica: numero internacional NAO ganha truncamento brasileiro', () => {
  // Portugal, caso real ja documentado no projeto (applications id 741).
  assert.equal(chaveCanonicaTelefone('+351912437103'), '351912437103');
});

// ══════════════════════════════════════════════════════════════
// registrarOptout — idempotencia e escalonamento
// ══════════════════════════════════════════════════════════════

test('registrar: primeira vez cria; segunda NAO duplica nem sobrescreve a data original', () => {
  zerar();
  const r1 = optout.registrarOptout({ telefone: '5547999582500', origem: 'link' });
  assert.equal(r1.criado, true);

  exec("UPDATE whatsapp_optout SET criado_em = '2026-01-01 10:00:00'");

  const r2 = optout.registrarOptout({ telefone: '5547999582500', origem: 'manual' });
  assert.equal(r2.criado, false);
  assert.equal(r2.escalado, false);

  const linhas = db.getDb().prepare('SELECT * FROM whatsapp_optout').all();
  assert.equal(linhas.length, 1, 'nao duplicou');
  assert.equal(linhas[0].criado_em, '2026-01-01 10:00:00', 'data original preservada');
  assert.equal(linhas[0].origem, 'link', 'origem do PRIMEIRO registro preservada');
});

test('registrar: o mesmo numero com e sem o 9 e UMA linha so', () => {
  zerar();
  optout.registrarOptout({ telefone: '5531996820290', origem: 'link' });
  optout.registrarOptout({ telefone: '553196820290', origem: 'resposta' });
  assert.equal(db.getDb().prepare('SELECT COUNT(*) AS n FROM whatsapp_optout').get().n, 1);
});

test('registrar: escalar campanha -> total e permitido', () => {
  zerar();
  optout.registrarOptout({ telefone: '5547999582501', escopo: 'campanha', origem: 'link' });
  const r = optout.registrarOptout({ telefone: '5547999582501', escopo: 'total', origem: 'link' });
  assert.equal(r.escalado, true);
  assert.equal(r.escopo, 'total');
  assert.equal(optout.estaOptout('5547999582501', 'transacional'), true);
});

test('registrar: rebaixar total -> campanha e IGNORADO (exige revogacao explicita)', () => {
  zerar();
  optout.registrarOptout({ telefone: '5547999582502', escopo: 'total', origem: 'manual' });
  const r = optout.registrarOptout({ telefone: '5547999582502', escopo: 'campanha', origem: 'link' });
  assert.equal(r.escalado, false);
  assert.equal(r.escopo, 'total');
  assert.equal(optout.estaOptout('5547999582502', 'transacional'), true, 'continua bloqueando transacional');
});

test('registrar: telefone irreconhecivel devolve ok:false e nao grava nada', () => {
  zerar();
  const r = optout.registrarOptout({ telefone: '   ', origem: 'link' });
  assert.equal(r.ok, false);
  assert.equal(db.getDb().prepare('SELECT COUNT(*) AS n FROM whatsapp_optout').get().n, 0);
});

test('registrar: origem invalida cai em manual em vez de estourar o CHECK', () => {
  zerar();
  const r = optout.registrarOptout({ telefone: '5547999582503', origem: 'inventada' });
  assert.equal(r.ok, true);
  assert.equal(db.getDb().prepare('SELECT origem FROM whatsapp_optout').get().origem, 'manual');
});

// ══════════════════════════════════════════════════════════════
// estaOptout — a assimetria de escopo (P1)
// ══════════════════════════════════════════════════════════════

test('escopo campanha NAO bloqueia transacional', () => {
  zerar();
  optout.registrarOptout({ telefone: '5547999582504', escopo: 'campanha', origem: 'link' });
  assert.equal(optout.estaOptout('5547999582504', 'campanha'), true);
  assert.equal(optout.estaOptout('5547999582504', 'transacional'), false);
});

test('escopo total bloqueia AMBOS', () => {
  zerar();
  optout.registrarOptout({ telefone: '5547999582505', escopo: 'total', origem: 'manual' });
  assert.equal(optout.estaOptout('5547999582505', 'campanha'), true);
  assert.equal(optout.estaOptout('5547999582505', 'transacional'), true);
});

test('estaOptout resolve o mesmo numero gravado com e sem o 9', () => {
  zerar();
  optout.registrarOptout({ telefone: '553196820290', escopo: 'campanha', origem: 'link' });
  assert.equal(optout.estaOptout('5531996820290', 'campanha'), true, 'consulta COM o 9 acha o registro SEM');
});

test('estaOptout: telefone irreconhecivel e sempre false', () => {
  zerar();
  assert.equal(optout.estaOptout('', 'campanha'), false);
  assert.equal(optout.estaOptout(null, 'campanha'), false);
});

// ══════════════════════════════════════════════════════════════
// Revogacao
// ══════════════════════════════════════════════════════════════

test('revogar: desativa sem apagar a linha, e o historico fica datado', () => {
  zerar();
  optout.registrarOptout({ telefone: '5547999582506', origem: 'link' });
  assert.equal(optout.revogarOptout('5547999582506'), true);
  assert.equal(optout.estaOptout('5547999582506', 'campanha'), false);

  const linha = db.getDb().prepare('SELECT * FROM whatsapp_optout').get();
  assert.ok(linha, 'a linha continua existindo');
  assert.ok(linha.revogado_em, 'revogado_em preenchido');
});

test('revogar duas vezes: a segunda devolve false (nao havia o que revogar)', () => {
  zerar();
  optout.registrarOptout({ telefone: '5547999582507', origem: 'link' });
  assert.equal(optout.revogarOptout('5547999582507'), true);
  assert.equal(optout.revogarOptout('5547999582507'), false);
});

test('reregistrar depois de revogado cria opt-out NOVO, com data nova', () => {
  zerar();
  optout.registrarOptout({ telefone: '5547999582508', origem: 'link' });
  exec("UPDATE whatsapp_optout SET criado_em = '2026-01-01 10:00:00'");
  optout.revogarOptout('5547999582508');

  const r = optout.registrarOptout({ telefone: '5547999582508', origem: 'resposta' });
  assert.equal(r.criado, true);

  const linha = db.getDb().prepare('SELECT * FROM whatsapp_optout').get();
  assert.equal(linha.revogado_em, null);
  assert.equal(linha.origem, 'resposta');
  assert.notEqual(linha.criado_em, '2026-01-01 10:00:00', 'opt-out novo, data nova');
  assert.equal(db.getDb().prepare('SELECT COUNT(*) AS n FROM whatsapp_optout').get().n, 1);
});

// ══════════════════════════════════════════════════════════════
// Kill-switch (P5) e listagem
// ══════════════════════════════════════════════════════════════

test('kill-switch nasce LIGADO: sem nenhuma configuracao gravada, a supressao ja vale', () => {
  zerar();
  assert.equal(optout.ativo(), true, 'default e suprimir');
  optout.registrarOptout({ telefone: '5547999582509', origem: 'link' });
  assert.equal(optout.estaOptout('5547999582509', 'campanha'), true);
});

test('kill-switch desligado explicitamente para de suprimir', () => {
  zerar();
  optout.registrarOptout({ telefone: '5547999582510', origem: 'link' });
  db.definirConfigBool(optout.CHAVE_ATIVO, false);
  assert.equal(optout.estaOptout('5547999582510', 'campanha'), false);
  assert.equal(optout.mapaOptoutAtivo().size, 0, 'o mapa tambem respeita o interruptor');
  db.definirConfigBool(optout.CHAVE_ATIVO, true);
  assert.equal(optout.estaOptout('5547999582510', 'campanha'), true);
});

test('paridade: optoutAtivoNoMapa decide igual a estaOptout, nos quatro cruzamentos', () => {
  zerar();
  optout.registrarOptout({ telefone: '5547999582511', escopo: 'campanha', origem: 'link' });
  optout.registrarOptout({ telefone: '5547999582512', escopo: 'total', origem: 'manual' });
  const mapa = optout.mapaOptoutAtivo();

  for (const tel of ['5547999582511', '5547999582512', '5547999582513']) {
    for (const escopo of ['campanha', 'transacional']) {
      assert.equal(
        optout.optoutAtivoNoMapa(mapa, tel, escopo),
        optout.estaOptout(tel, escopo),
        `divergencia em ${tel}/${escopo}`,
      );
    }
  }
});

test('listar: filtra por escopo e pagina', () => {
  zerar();
  optout.registrarOptout({ telefone: '5547999582521', escopo: 'campanha', origem: 'link' });
  optout.registrarOptout({ telefone: '5547999582522', escopo: 'total', origem: 'manual' });
  optout.registrarOptout({ telefone: '5547999582523', escopo: 'campanha', origem: 'resposta' });

  assert.equal(optout.listarOptouts({}).total, 3);
  assert.equal(optout.listarOptouts({ escopo: 'total' }).total, 1);
  assert.equal(optout.listarOptouts({ escopo: 'campanha' }).total, 2);

  // Revogado sai da listagem padrao e volta com incluirRevogados.
  optout.revogarOptout('5547999582521');
  assert.equal(optout.listarOptouts({}).total, 2);
  assert.equal(optout.listarOptouts({ incluirRevogados: true }).total, 3);
});

test('listar: busca por telefone com mascara acha a linha gravada normalizada', () => {
  zerar();
  optout.registrarOptout({ telefone: '5547999582530', origem: 'link' });
  const r = optout.listarOptouts({ busca: '+55 (47) 99958-2530' });
  assert.equal(r.total, 1);
});

test('resumo: total, 7 dias, por origem e por escopo', () => {
  zerar();
  optout.registrarOptout({ telefone: '5547999582541', escopo: 'campanha', origem: 'link' });
  optout.registrarOptout({ telefone: '5547999582542', escopo: 'total', origem: 'manual' });
  optout.registrarOptout({ telefone: '5547999582543', escopo: 'campanha', origem: 'link' });
  // Um antigo, fora da janela de 7 dias.
  exec("UPDATE whatsapp_optout SET criado_em = '2020-01-01 10:00:00' WHERE telefone_canonico = ?", '554799958254');

  const r = db.resumoWhatsappOptouts();
  assert.equal(r.total, 3);
  assert.equal(r.ultimos7, 3, 'os tres foram criados agora (o UPDATE acima nao casa nenhum)');
  assert.deepEqual(
    r.porOrigem.map((o) => o.origem).sort(),
    ['link', 'manual'],
  );
  assert.deepEqual(
    r.porEscopo.map((e) => e.escopo).sort(),
    ['campanha', 'total'],
  );
});
