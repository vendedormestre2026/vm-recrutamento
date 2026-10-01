'use strict';

// Script de reclassificacao 'enviado' -> 'sem_destino' da campanha 3 (2026-10-01).
//
// Banco temporario montado como o de producao: campanha 3 com 50 envios 'enviado', os 47 da lista
// mais os 3 que receberam. Nada aqui envia mensagem nem abre socket.

const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const DB_PATH = path.join(os.tmpdir(), `vm-test-reclass-sem-destino-${process.pid}-${Date.now()}.db`);
process.env.DATABASE_PATH = DB_PATH;
process.env.INTERVIEW_MOCK = 'true';
process.env.SESSION_SECRET = 'segredo-de-teste';
process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert/strict');

const db = require('../src/db');
const { migrar } = require('../src/db/migrate');
const script = require('../src/scripts/reclassificar-sem-destino-massa-wa');

migrar();

const RECEBERAM = [2547, 2480, 2366];
const SCRIPT = path.join(__dirname, '..', 'src', 'scripts', 'reclassificar-sem-destino-massa-wa.js');
const silencio = () => {};

// Campanha 3 com os 50 'enviado'. Banco zerado a cada teste; as campanhas 1 e 2 existem so para a
// 3 ter o id que o script espera.
function montarCampanha3() {
  const conn = db.getDb();
  conn.exec('DELETE FROM campanhas_massa_wa_envios');
  conn.exec('DELETE FROM campanhas_massa_wa');
  conn.exec("DELETE FROM sqlite_sequence WHERE name IN ('campanhas_massa_wa', 'campanhas_massa_wa_envios')");
  for (let i = 1; i <= 3; i += 1) db.criarCampanhaMassaWa({ nome: `C${i}` });
  const apps = [...script.APPLICATION_IDS, ...RECEBERAM];
  db.materializarCampanhaMassaWa(3, apps.map((appId) => ({
    telefone: `5547999${String(appId).padStart(6, '0')}`,
    telefoneCanonico: `5547999${String(appId).padStart(6, '0')}`,
    applicationId: appId,
  })));
  for (const l of db.listarEnviosCampanhaMassaWa(3)) {
    db.marcarEnvioMassaWaEnviado(l.id, { variacaoIndice: 1, quando: '2026-09-29 16:54:36' });
  }
}

const porStatus = () => Object.fromEntries(db.resumoCampanhaMassaWa(3).map((l) => [l.status, l.n]));

test('a lista tem os 47 da evidencia e nenhum dos 3 que receberam', () => {
  assert.equal(script.APPLICATION_IDS.length, 47);
  assert.equal(new Set(script.APPLICATION_IDS).size, 47);
  for (const r of RECEBERAM) assert.ok(!script.APPLICATION_IDS.includes(r));
  assert.match(script.ERRO, /USync sem resultado \(log de 29\/09\).*91196f4.*7bceaa17/);
});

test('dry-run mostra o plano e nao grava nada', () => {
  montarCampanha3();
  const r = script.executar({ db, commit: false, log: silencio });
  assert.equal(r.plano.length, 47);
  assert.equal(r.alterados, 0);
  assert.deepEqual(porStatus(), { enviado: 50 });
});

test('--commit reclassifica so os 47, preserva enviado_em e grava a evidencia', () => {
  montarCampanha3();
  const r = script.executar({ db, commit: true, log: silencio });
  assert.equal(r.alterados, 47);
  assert.deepEqual(porStatus(), { enviado: 3, sem_destino: 47 });
  for (const l of db.listarEnviosCampanhaMassaWa(3)) {
    assert.equal(l.enviado_em, '2026-09-29 16:54:36', 'enviado_em preservado');
    if (RECEBERAM.includes(l.application_id)) {
      assert.equal(l.status, 'enviado');
      assert.equal(l.erro, null);
    } else {
      assert.equal(l.status, 'sem_destino');
      assert.equal(l.erro, script.ERRO);
    }
  }
  // E o efeito que importa: os 47 voltam ao publico, os 3 continuam "ja receberam".
  assert.equal(db.telefonesComDisparoMassaWaEnviado().size, 3);
});

test('segunda execucao com --commit e idempotente: 0 alteracoes', () => {
  montarCampanha3();
  script.executar({ db, commit: true, log: silencio });
  const r = script.executar({ db, commit: true, log: silencio });
  assert.equal(r.alterados, 0);
  assert.equal(r.jaReclassificados.length, 47);
  assert.deepEqual(porStatus(), { enviado: 3, sem_destino: 47 });
});

test('se UMA das 47 nao estiver em enviado, aborta sem gravar nenhuma', () => {
  montarCampanha3();
  const alvo = db.listarEnviosCampanhaMassaWa(3).find((l) => l.application_id === script.APPLICATION_IDS[10]);
  db.getDb().prepare("UPDATE campanhas_massa_wa_envios SET status = 'falha' WHERE id = ?").run(alvo.id);
  const r = script.executar({ db, commit: true, log: silencio });
  assert.equal(r.problemas.length, 1);
  assert.equal(r.problemas[0].applicationId, script.APPLICATION_IDS[10]);
  assert.equal(r.alterados, 0);
  assert.deepEqual(porStatus(), { enviado: 49, falha: 1 });
});

test('linha ausente na campanha tambem aborta', () => {
  montarCampanha3();
  const alvo = db.listarEnviosCampanhaMassaWa(3).find((l) => l.application_id === script.APPLICATION_IDS[0]);
  db.getDb().prepare('DELETE FROM campanhas_massa_wa_envios WHERE id = ?').run(alvo.id);
  const r = script.executar({ db, commit: true, log: silencio });
  assert.match(r.problemas[0].motivo, /0 linhas/);
  assert.deepEqual(porStatus(), { enviado: 49 });
});

test('sem --commit o script abre o banco SOMENTE LEITURA (processo filho)', () => {
  montarCampanha3();
  const env = { ...process.env, DATABASE_PATH: DB_PATH };
  const saida = execFileSync(process.execPath, [SCRIPT], { env, encoding: 'utf8' });
  assert.match(saida, /dry-run, banco read-only/);
  assert.match(saida, /a reclassificar \(enviado -> sem_destino\): 47/);
  assert.deepEqual(porStatus(), { enviado: 50 });

  // E o SQLite que recusa a escrita, nao a disciplina do script.
  assert.throws(
    () => execFileSync(process.execPath, ['-e', `
      process.env.DATABASE_READONLY = '1';
      require(${JSON.stringify(path.join(__dirname, '..', 'src', 'db'))}).getDb()
        .prepare("UPDATE campanhas_massa_wa_envios SET status = 'x'").run();`], { env, stdio: 'pipe' }),
    /readonly/,
  );
});
