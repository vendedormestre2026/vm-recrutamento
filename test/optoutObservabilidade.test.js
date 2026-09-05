'use strict';

// Incremento 7: observabilidade minima do opt-out.
//
// Contador de suprimidos por ciclo no log dos tres motores, e os numeros do painel (total,
// ultimos 7 dias, por origem, por escopo). Sem metrica de funil.
//
// O que estes testes protegem: um ciclo em que ninguem recebeu nada NAO pode ser silencioso.
// "A campanha saiu menor do que a previa" e a primeira coisa que alguem nota e a ultima que
// consegue justificar — o log e o unico lugar onde a diferenca aparece, porque registro
// suprimido nao entra em tela nenhuma.

const os = require('node:os');
const path = require('node:path');

process.env.DATABASE_PATH = path.join(os.tmpdir(), `vm-test-optout-obs-${process.pid}-${Date.now()}.db`);
process.env.INTERVIEW_MOCK = 'true';
process.env.NODE_ENV = 'test';
process.env.WHATSAPP_BAILEYS_ATIVO = 'true';

const test = require('node:test');
const assert = require('node:assert/strict');

const db = require('../src/db');
const { migrar } = require('../src/db/migrate');
const optout = require('../src/lib/optoutWhatsapp');
const publicoCampanha = require('../src/lib/publicoCampanhaWhatsapp');
const publicoDisparo = require('../src/lib/publicoDisparoWhatsapp');
const sequencia = require('../src/whatsapp/sequenciaOutbox');

migrar();

const exec = (sql, ...p) => db.getDb().prepare(sql).run(...p);

let seq = 0;
function candidatura(nome, telefone) {
  seq += 1;
  const jobId = Number(
    exec(
      'INSERT INTO jobs (slug, titulo, perfil, cidade, ativo) VALUES (?, ?, ?, ?, 1)',
      `vaga-obs-${seq}`,
      `Vaga ${seq}`,
      'CLOSER',
      'Joinville',
    ).lastInsertRowid,
  );
  return Number(
    exec(
      'INSERT INTO applications (job_id, nome, telefone, token) VALUES (?, ?, ?, ?)',
      jobId,
      nome,
      telefone,
      `tok-obs-${seq}`,
    ).lastInsertRowid,
  );
}

function zerar() {
  exec('DELETE FROM applications');
  exec('DELETE FROM jobs');
  exec('DELETE FROM whatsapp_optout');
  exec('DELETE FROM whatsapp_sequencia_envios');
  exec('DELETE FROM disparos_whatsapp');
  exec("DELETE FROM configuracoes WHERE chave = 'optout_whatsapp_ativo'");
}

// Captura console.log sem deixar o teste barulhento.
async function capturandoLog(fn) {
  const linhas = [];
  const original = console.log;
  console.log = (...args) => linhas.push(args.join(' '));
  try {
    await fn();
  } finally {
    console.log = original;
  }
  return linhas.join('\n');
}

const semChecagemDeExistencia = { onWhatsAppLote: async () => new Map() };

test('publico da campanha: loga quantos foram suprimidos e quantos restaram', async () => {
  zerar();
  candidatura('Ana', '+55 47 90000-4001');
  candidatura('Bruno', '+55 47 90000-4002');
  candidatura('Carla', '+55 47 90000-4003');
  optout.registrarOptout({ telefone: '5547900004001', origem: 'link' });
  optout.registrarOptout({ telefone: '5547900004002', origem: 'resposta' });

  const log = await capturandoLog(async () => {
    const r = publicoCampanha.listarPublicoConviteGrupo({});
    assert.equal(r.total, 1);
  });
  assert.match(log, /2 pessoa\(s\) suprimida\(s\) por opt-out/);
  assert.match(log, /1 restante/);
});

test('publico da campanha: sem supressao, nao ha ruido no log', async () => {
  zerar();
  candidatura('Ana', '+55 47 90000-4011');
  const log = await capturandoLog(async () => {
    publicoCampanha.listarPublicoConviteGrupo({});
  });
  assert.doesNotMatch(log, /suprimida/);
});

test('disparo por praca: loga o contador, separado de "ja recebeu"', async () => {
  zerar();
  candidatura('Ana', '+55 47 90000-4021');
  candidatura('Bruno', '+55 47 90000-4022');
  optout.registrarOptout({ telefone: '5547900004021', origem: 'link' });

  const log = await capturandoLog(async () => {
    const fila = await publicoDisparo.listarPendentesPorCidade('Joinville', semChecagemDeExistencia);
    assert.equal(fila.length, 1);
  });
  assert.match(log, /1 pessoa\(s\) suprimida\(s\) por opt-out de campanha/);
  assert.match(log, /1 na fila/);
});

test('sequencia: o ciclo NAO fica silencioso quando tudo foi suprimido', async () => {
  zerar();
  db.definirConfigBool(sequencia.CHAVE_ATIVO, true);
  const id = candidatura('Ana', '+55 47 90000-4031');
  db.agendarEnvioWhatsapp({
    applicationId: id,
    etapa: 'wa1',
    telefone: '5547900004031',
    agendadoPara: '2020-01-01 00:00:00',
    templateNome: 'wa1',
  });
  optout.registrarOptout({ telefone: '5547900004031', escopo: 'total', origem: 'manual' });

  const log = await capturandoLog(async () => {
    const r = await sequencia.processarCicloSequencia({ mock: true, intervaloMs: 0 });
    assert.equal(r.enviados, 0);
    assert.equal(r.pulados, 1);
  });
  // Antes do Incremento 7 a linha de resumo so saia com enviados/falhas/retentar: um ciclo
  // 100% suprimido nao produzia log NENHUM.
  assert.match(log, /ciclo concluido/);
  assert.match(log, /suprimidos por opt-out: 1/);
});

test('resumo do painel: total, 7 dias, por origem e por escopo', () => {
  zerar();
  optout.registrarOptout({ telefone: '5547900004041', escopo: 'campanha', origem: 'link' });
  optout.registrarOptout({ telefone: '5547900004042', escopo: 'campanha', origem: 'manual' });
  optout.registrarOptout({ telefone: '5547900004043', escopo: 'total', origem: 'link' });
  optout.registrarOptout({ telefone: '5547900004044', escopo: 'campanha', origem: 'link' });
  optout.revogarOptout('5547900004044');

  const r = db.resumoWhatsappOptouts();
  assert.equal(r.total, 3, 'revogado nao conta no total ativo');
  assert.equal(r.revogados, 1);
  assert.equal(r.ultimos7, 3);

  const porOrigem = Object.fromEntries(r.porOrigem.map((o) => [o.origem, o.n]));
  assert.deepEqual(porOrigem, { link: 2, manual: 1 });

  const porEscopo = Object.fromEntries(r.porEscopo.map((e) => [e.escopo, e.n]));
  assert.deepEqual(porEscopo, { campanha: 2, total: 1 });
});

test('resumo: opt-out antigo sai da janela de 7 dias mas continua no total', () => {
  zerar();
  optout.registrarOptout({ telefone: '5547900004051', origem: 'link' });
  exec("UPDATE whatsapp_optout SET criado_em = datetime('now', '-30 days')");
  optout.registrarOptout({ telefone: '5547900004052', origem: 'link' });

  const r = db.resumoWhatsappOptouts();
  assert.equal(r.total, 2);
  assert.equal(r.ultimos7, 1);
});
