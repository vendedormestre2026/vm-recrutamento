'use strict';

// Filtro por STATUS DO RECRUTADOR no publico de divulgacao de vaga por WhatsApp
// (lib/publicoCampanhaWhatsapp.js:listarPublicoDivulgacaoVaga) — ETAPA B, Incremento B2.
//
// Prova tres coisas: (1) a regra nova age na divulgacao, com a contagem por motivo; (2) ela
// NAO vaza para convite_grupo nem status_candidatura; (3) os filtros que ja existiam (opt-out,
// "aprovado na mais recente") continuam agindo, antes dela.

const os = require('node:os');
const path = require('node:path');

process.env.DATABASE_PATH = path.join(os.tmpdir(), `vm-test-divulgacao-status-${process.pid}-${Date.now()}.db`);
process.env.INTERVIEW_MOCK = 'true';
process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert/strict');

const db = require('../src/db');
const { migrar } = require('../src/db/migrate');
const publico = require('../src/lib/publicoCampanhaWhatsapp');
const optout = require('../src/lib/optoutWhatsapp');

migrar();

const exec = (sql, ...p) => db.getDb().prepare(sql).run(...p);

let seq = 0;
function vaga(cidade = 'Joinville') {
  seq += 1;
  return Number(
    exec(
      'INSERT INTO jobs (slug, titulo, perfil, cidade, ativo) VALUES (?, ?, ?, ?, 1)',
      `vaga-div-status-${seq}`,
      `Vaga ${seq}`,
      'CLOSER',
      cidade,
    ).lastInsertRowid,
  );
}
function candidatura(jobId, telefone, { status = null, arquivada = false, criadoEm = '2026-08-01 10:00:00', etapa = 'concluido' } = {}) {
  seq += 1;
  return Number(
    exec(
      `INSERT INTO applications (job_id, nome, telefone, status_recrutador, status, token, criado_em, deleted_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      jobId,
      `Pessoa ${seq}`,
      comoFormulario(telefone),
      status,
      etapa,
      `tok-div-status-${seq}`,
      criadoEm,
      arquivada ? '2026-08-10 10:00:00' : null,
    ).lastInsertRowid,
  );
}
function legado(telefone, cidade = 'Joinville') {
  seq += 1;
  exec(
    "INSERT INTO talentos (nome, email, telefone, cidade, categoria) VALUES (?, ?, ?, ?, 'legado')",
    `Legado ${seq}`,
    `legado${seq}@x.co`,
    comoFormulario(telefone),
    cidade,
  );
}
function zerar() {
  for (const t of ['applications', 'talentos', 'jobs', 'whatsapp_opt_out', 'whatsapp_optout']) exec(`DELETE FROM ${t}`);
}
const tels = (r) => r.itens.map((i) => i.telefone).sort();
// Os telefones do teste sao escritos ja normalizados ('5547...'), mas o banco guarda o formato
// do formulario ('+55 47...'): normalizarTelefoneWhatsapp prefixa 55 em digitos crus, e
// '5547...' cru viraria DDI duplicado — descartado pela guarda de ida e volta.
const comoFormulario = (t) => `+55 ${String(t).slice(2)}`;
// Os motores logam (telefone recusado, contagens); o teste nao precisa do ruido.
function calado(fn) {
  const { log, warn } = console;
  console.log = console.warn = () => {};
  try {
    return fn();
  } finally {
    Object.assign(console, { log, warn });
  }
}

// Cenario do B0 em miniatura: publico com legado, sem decisao, reprovado, em entrevista,
// aprovado, em analise, e uma candidatura arquivada em analise.
function cenarioB0() {
  zerar();
  const antiga = vaga();
  const outra = vaga();
  const alvo = vaga();
  legado('5547900003001'); // D1: entra
  candidatura(antiga, '5547900003002'); // sem decisao: entra
  candidatura(antiga, '5547900003003', { status: 'reprovado' }); // entra
  candidatura(antiga, '5547900003004', { etapa: 'em_entrevista' }); // D2: entra
  // Aprovado numa candidatura ANTIGA, sem decisao na mais recente: a supressao atual ("mais
  // recente aprovada") NAO pega; a regra nova (TODAS) pega.
  candidatura(antiga, '5547900003005', { status: 'aprovado', criadoEm: '2026-07-01 10:00:00' });
  candidatura(outra, '5547900003005', { criadoEm: '2026-08-05 10:00:00' });
  candidatura(antiga, '5547900003006', { status: 'em_analise' }); // sai
  // Reprovado ativo + em analise ARQUIVADA: sai, contado como "so por arquivada" (D3).
  candidatura(antiga, '5547900003007', { status: 'reprovado' });
  candidatura(outra, '5547900003007', { status: 'em_analise', arquivada: true });
  return alvo;
}

test('divulgacao: so sem decisao / reprovado / legado / em entrevista entram, com contagem por motivo', () => {
  const alvo = cenarioB0();
  const r = calado(() => publico.listarPublicoDivulgacaoVaga(alvo, {}));
  assert.deepEqual(tels(r), ['5547900003001', '5547900003002', '5547900003003', '5547900003004']);
  assert.equal(r.total, 4);
  assert.deepEqual(r.excluidosPorStatus, {
    total: 3,
    porMotivo: { aprovado: 1, em_analise: 2, desconhecido: 0 },
    apenasArquivada: 1,
  });
});

test('divulgacao: valor desconhecido e fail-closed; maiuscula de aprovado tambem sai', () => {
  zerar();
  const antiga = vaga();
  const alvo = vaga();
  candidatura(antiga, '5547900003101', { status: 'lixo' });
  candidatura(antiga, '5547900003102', { status: 'Aprovado' });
  candidatura(antiga, '5547900003103', { status: '' }); // '' = sem decisao: entra
  const r = calado(() => publico.listarPublicoDivulgacaoVaga(alvo, {}));
  assert.deepEqual(tels(r), ['5547900003103']);
  assert.deepEqual(r.excluidosPorStatus.porMotivo, { aprovado: 1, em_analise: 0, desconhecido: 1 });
});

test('divulgacao: candidatura aprovada gravada SEM o nono digito barra o numero com o nono', () => {
  zerar();
  const antiga = vaga();
  const alvo = vaga();
  candidatura(antiga, '553196820290', { status: 'aprovado' }); // sem o 9 (fixo-like, 12 digitos)
  candidatura(antiga, '5531996820290'); // mesma pessoa, com o 9, sem decisao
  // Contraponto: sem a regra nova (convite_grupo), o numero COM o 9 entra — a supressao antiga
  // compara o numero normalizado exato e nao liga as duas grafias.
  const convite = calado(() => publico.listarPublicoConviteGrupo({}));
  assert.ok(convite.itens.some((i) => i.telefone === '5531996820290'));
  const r = calado(() => publico.listarPublicoDivulgacaoVaga(alvo, {}));
  assert.equal(r.itens.some((i) => i.telefone.endsWith('96820290')), false);
  assert.equal(r.excluidosPorStatus.porMotivo.aprovado, 1);
});

test('divulgacao: todos elegiveis -> excluidosPorStatus zerado e ninguem sai', () => {
  zerar();
  const antiga = vaga();
  const alvo = vaga();
  candidatura(antiga, '5547900003201', { status: 'reprovado' });
  legado('5547900003202');
  const r = calado(() => publico.listarPublicoDivulgacaoVaga(alvo, {}));
  assert.equal(r.total, 2);
  assert.deepEqual(r.excluidosPorStatus, {
    total: 0,
    porMotivo: { aprovado: 0, em_analise: 0, desconhecido: 0 },
    apenasArquivada: 0,
  });
});

// ── Escopo: convite_grupo e status_candidatura intactos ──

test('convite_grupo NAO aplica a regra nova: mesmo cenario, aprovado-antigo e em analise continuam', () => {
  cenarioB0();
  const r = calado(() => publico.listarPublicoConviteGrupo({}));
  // Todos os 7 telefones: a supressao "mais recente aprovada" nao pega o 3005 (a mais recente
  // dele e sem decisao), e ninguem mais tem aprovado na mais recente.
  assert.deepEqual(tels(r), [
    '5547900003001',
    '5547900003002',
    '5547900003003',
    '5547900003004',
    '5547900003005',
    '5547900003006',
    '5547900003007',
  ]);
  assert.equal(r.excluidosPorStatus, undefined);
});

test('status_candidatura NAO aplica a regra nova: aprovados e em analise continuam avisaveis', () => {
  zerar();
  const v = vaga();
  candidatura(v, '5547900003301', { status: 'aprovado' });
  candidatura(v, '5547900003302', { status: 'em_analise' });
  const r = calado(() => publico.listarPublicoStatusCandidatura(v, ['aprovado', 'em_analise']));
  assert.deepEqual(tels(r), ['5547900003301', '5547900003302']);
});

// ── Regressao: filtros existentes continuam agindo, antes da regra nova ──

test('opt-out de campanha continua excluindo na divulgacao (e nao conta como status)', () => {
  zerar();
  const antiga = vaga();
  const alvo = vaga();
  candidatura(antiga, '5547900003401', { status: 'reprovado' });
  candidatura(antiga, '5547900003402');
  optout.registrarOptout({ telefone: '5547900003401', escopo: 'campanha', origem: 'manual' });
  const r = calado(() => publico.listarPublicoDivulgacaoVaga(alvo, {}));
  assert.deepEqual(tels(r), ['5547900003402']);
  assert.equal(r.excluidosPorStatus.total, 0);
});

test('"aprovado na mais recente" continua agindo em aplicarInvariantes, antes da regra nova', () => {
  zerar();
  const antiga = vaga();
  const alvo = vaga();
  candidatura(antiga, '5547900003501', { status: 'aprovado' });
  const r = calado(() => publico.listarPublicoDivulgacaoVaga(alvo, {}));
  assert.deepEqual(tels(r), []);
  // Saiu pela supressao antiga — a regra nova nem chegou a ve-lo.
  assert.equal(r.excluidosPorStatus.total, 0);
});

test('ja inscrito na vaga alvo continua excluido', () => {
  zerar();
  const alvo = vaga();
  candidatura(alvo, '5547900003601', { status: 'reprovado' });
  const r = calado(() => publico.listarPublicoDivulgacaoVaga(alvo, {}));
  assert.deepEqual(tels(r), []);
});
