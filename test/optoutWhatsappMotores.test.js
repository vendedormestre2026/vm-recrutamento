'use strict';

// Incremento 2: o guard de opt-out nos TRES motores de envio.
//
//   lib/publicoCampanhaWhatsapp   selecao de publico da campanha (objetivos 1, 2 e 3)
//   lib/publicoDisparoWhatsapp    selecao de publico do disparo por praca (n8n)
//   lib/campanhaWhatsapp          envio da campanha, guard por registro
//   whatsapp/sequenciaOutbox      envio da sequencia WA1/WA2/reprovacao, guard por registro
//
// O teste central deste arquivo e o de RECANDIDATURA (P2): um numero com opt-out `campanha`
// ativo que se candidata a uma vaga nova precisa receber WA1/WA2 e continuar fora das
// campanhas, AO MESMO TEMPO. Se algum dia os dois motores passarem a consultar o mesmo
// escopo, esse teste e o que quebra.

const os = require('node:os');
const path = require('node:path');

process.env.DATABASE_PATH = path.join(os.tmpdir(), `vm-test-optout-motores-${process.pid}-${Date.now()}.db`);
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
const campanha = require('../src/lib/campanhaWhatsapp');
const sequencia = require('../src/whatsapp/sequenciaOutbox');

migrar();

const exec = (sql, ...p) => db.getDb().prepare(sql).run(...p);

let seq = 0;
function vagaCom(cidade) {
  seq += 1;
  return Number(
    exec(
      'INSERT INTO jobs (slug, titulo, perfil, cidade, ativo) VALUES (?, ?, ?, ?, 1)',
      `vaga-optout-${seq}`,
      `Vaga ${seq}`,
      'CLOSER',
      cidade,
    ).lastInsertRowid,
  );
}

function candidatura(jobId, nome, telefone) {
  seq += 1;
  return Number(
    exec(
      `INSERT INTO applications (job_id, nome, telefone, token, criado_em)
       VALUES (?, ?, ?, ?, ?)`,
      jobId,
      nome,
      telefone,
      `tok-optout-${seq}`,
      '2026-08-01 10:00:00',
    ).lastInsertRowid,
  );
}

function zerar() {
  exec('DELETE FROM applications');
  exec('DELETE FROM talentos');
  exec('DELETE FROM jobs');
  exec('DELETE FROM whatsapp_opt_out');
  exec('DELETE FROM whatsapp_optout');
  exec('DELETE FROM disparos_whatsapp');
  exec('DELETE FROM whatsapp_sequencia_envios');
  exec('DELETE FROM campanha_whatsapp_envios');
  exec('DELETE FROM campanhas_whatsapp');
  exec("DELETE FROM configuracoes WHERE chave = 'optout_whatsapp_ativo'");
}

const tels = (r) => r.itens.map((i) => i.telefone).sort();

// Baileys nunca e tocado nestes testes: onWhatsAppLote injetado responde "nao verificado"
// para tudo, que e o caso que NAO exclui ninguem (best-effort, ver publicoDisparoWhatsapp).
const semChecagemDeExistencia = { onWhatsAppLote: async () => new Map() };

// ══════════════════════════════════════════════════════════════
// Selecao de publico — campanha (objetivos 1 e 2)
// ══════════════════════════════════════════════════════════════

test('convite de grupo: opt-out campanha remove a pessoa do publico', async () => {
  zerar();
  candidatura(vagaCom('Joinville'), 'Ana', '+55 47 90000-2001');
  candidatura(vagaCom('Joinville'), 'Bruno', '+55 47 90000-2002');
  assert.equal(publicoCampanha.listarPublicoConviteGrupo({}).total, 2);

  optout.registrarOptout({ telefone: '5547900002001', escopo: 'campanha', origem: 'link' });
  assert.deepEqual(tels(publicoCampanha.listarPublicoConviteGrupo({})), ['5547900002002']);
});

test('divulgacao de vaga: opt-out campanha remove a pessoa do publico', () => {
  zerar();
  const vagaAlvo = vagaCom('Joinville');
  candidatura(vagaCom('Joinville'), 'Ana', '+55 47 90000-2011');
  candidatura(vagaCom('Joinville'), 'Bruno', '+55 47 90000-2012');
  assert.equal(publicoCampanha.listarPublicoDivulgacaoVaga(vagaAlvo, {}).total, 2);

  optout.registrarOptout({ telefone: '5547900002011', escopo: 'campanha', origem: 'resposta' });
  assert.deepEqual(tels(publicoCampanha.listarPublicoDivulgacaoVaga(vagaAlvo, {})), ['5547900002012']);
});

test('publico de campanha: o numero gravado SEM o 9 tambem sai quando o opt-out veio COM o 9', () => {
  zerar();
  // A candidatura esta gravada sem o nono digito; o opt-out chegou com ele.
  candidatura(vagaCom('Joinville'), 'Ana', '+55 31 96820-290');
  optout.registrarOptout({ telefone: '5531996820290', escopo: 'campanha', origem: 'link' });
  assert.equal(publicoCampanha.listarPublicoConviteGrupo({}).total, 0);
});

// ══════════════════════════════════════════════════════════════
// Selecao de publico — status da candidatura (objetivo 3, transacional)
// ══════════════════════════════════════════════════════════════

test('status da candidatura: opt-out CAMPANHA NAO suprime (a pessoa precisa saber o resultado)', () => {
  zerar();
  const vaga = vagaCom('Joinville');
  const id = candidatura(vaga, 'Ana', '+55 47 90000-2021');
  db.definirStatusRecrutador(id, 'aprovado');

  optout.registrarOptout({ telefone: '5547900002021', escopo: 'campanha', origem: 'link' });
  const r = publicoCampanha.listarPublicoStatusCandidatura(vaga, ['aprovado']);
  assert.equal(r.total, 1, 'opt-out de campanha nao pode esconder o resultado da candidatura');
});

test('status da candidatura: opt-out TOTAL suprime', () => {
  zerar();
  const vaga = vagaCom('Joinville');
  const id = candidatura(vaga, 'Ana', '+55 47 90000-2022');
  db.definirStatusRecrutador(id, 'aprovado');

  optout.registrarOptout({ telefone: '5547900002022', escopo: 'total', origem: 'manual' });
  assert.equal(publicoCampanha.listarPublicoStatusCandidatura(vaga, ['aprovado']).total, 0);
});

// ══════════════════════════════════════════════════════════════
// Selecao de publico — disparo por praca (n8n)
// ══════════════════════════════════════════════════════════════

test('disparo por praca: opt-out campanha remove a pessoa da fila', async () => {
  zerar();
  candidatura(vagaCom('Joinville'), 'Ana', '+55 47 90000-2031');
  candidatura(vagaCom('Joinville'), 'Bruno', '+55 47 90000-2032');
  const antes = await publicoDisparo.listarPendentesPorCidade('Joinville', semChecagemDeExistencia);
  assert.equal(antes.length, 2);

  optout.registrarOptout({ telefone: '5547900002031', escopo: 'campanha', origem: 'link' });
  const depois = await publicoDisparo.listarPendentesPorCidade('Joinville', semChecagemDeExistencia);
  assert.deepEqual(
    depois.map((p) => p.telefone),
    ['5547900002032'],
  );
});

test('disparo por praca: suprimido NAO vira linha em disparos_whatsapp', async () => {
  zerar();
  candidatura(vagaCom('Joinville'), 'Ana', '+55 47 90000-2033');
  optout.registrarOptout({ telefone: '5547900002033', escopo: 'campanha', origem: 'link' });
  await publicoDisparo.listarPendentesPorCidade('Joinville', semChecagemDeExistencia);
  assert.equal(db.getDb().prepare('SELECT COUNT(*) AS n FROM disparos_whatsapp').get().n, 0);
});

test('disparo por praca: le TAMBEM a tabela antiga whatsapp_opt_out (ajuste A3)', async () => {
  zerar();
  candidatura(vagaCom('Joinville'), 'Ana', '+55 47 90000-2035');
  candidatura(vagaCom('Joinville'), 'Bruno', '+55 47 90000-2036');

  // So na tabela ANTIGA, sem escopo. Antes do A3 este motor a ignorava — e era o unico dos
  // tres de campanha que ignorava.
  db.registrarOptOutWhatsapp('5547900002035', 'resposta_webhook');

  const fila = await publicoDisparo.listarPendentesPorCidade('Joinville', semChecagemDeExistencia);
  assert.deepEqual(
    fila.map((p) => p.telefone),
    ['5547900002036'],
  );
});

test('paridade da tabela ANTIGA: os tres motores de campanha suprimem igual', async () => {
  zerar();
  const vagaAlvo = vagaCom('Joinville');
  candidatura(vagaCom('Joinville'), 'Ana', '+55 47 90000-2037');
  db.registrarOptOutWhatsapp('5547900002037', 'resposta_webhook');

  assert.equal(publicoCampanha.listarPublicoConviteGrupo({}).total, 0, 'convite de grupo');
  assert.equal(publicoCampanha.listarPublicoDivulgacaoVaga(vagaAlvo, {}).total, 0, 'divulgacao');
  assert.equal(
    (await publicoDisparo.listarPendentesPorCidade('Joinville', semChecagemDeExistencia)).length,
    0,
    'disparo por praca',
  );
});

test('a SEQUENCIA continua NAO lendo a tabela antiga: WA1/WA2 saem (P1)', async () => {
  zerar();
  db.definirConfigBool(sequencia.CHAVE_ATIVO, true);
  const id = candidatura(vagaCom('Joinville'), 'Ana', '+55 47 90000-2038');
  agendar(id, '5547900002038', 'wa1');
  // Linha na tabela ANTIGA, que nao tem escopo. Le-la aqui valeria como bloqueio TOTAL e
  // travaria o processo seletivo de quem so pediu para sair das ofertas.
  db.registrarOptOutWhatsapp('5547900002038', 'resposta_webhook');

  const r = await rodarSequencia();
  assert.equal(r.enviados, 1, 'a tabela antiga nao pode suprimir transacional');
  assert.equal(r.pulados, 0);
});

// ══════════════════════════════════════════════════════════════
// PARIDADE entre os motores
// ══════════════════════════════════════════════════════════════

test('paridade: os tres motores de selecao concordam sobre o MESMO numero suprimido', async () => {
  zerar();
  const vagaAlvo = vagaCom('Joinville');
  candidatura(vagaCom('Joinville'), 'Ana', '+55 47 90000-2041');
  optout.registrarOptout({ telefone: '5547900002041', escopo: 'campanha', origem: 'link' });

  assert.equal(publicoCampanha.listarPublicoConviteGrupo({}).total, 0, 'convite de grupo');
  assert.equal(publicoCampanha.listarPublicoDivulgacaoVaga(vagaAlvo, {}).total, 0, 'divulgacao de vaga');
  assert.equal(
    (await publicoDisparo.listarPendentesPorCidade('Joinville', semChecagemDeExistencia)).length,
    0,
    'disparo por praca',
  );
});

// ══════════════════════════════════════════════════════════════
// Guard por registro — envio da campanha
// ══════════════════════════════════════════════════════════════

function campanhaCom(tipoMensagem, telefone) {
  // OR IGNORE: nome_meta e UNIQUE e zerar() nao apaga templates (eles nao sao dado de
  // pessoa). O fixture roda uma vez por teste e nao pode falhar na segunda.
  exec(
    `INSERT OR IGNORE INTO templates_whatsapp (nome_meta, idioma, categoria, variaveis)
     VALUES ('t_optout_vm', 'pt_BR', 'marketing', '[]')`,
  );
  const campanhaId = Number(
    exec(
      `INSERT INTO campanhas_whatsapp (nome, template_id, base_alvo, tipo_mensagem, status)
       VALUES (?, (SELECT id FROM templates_whatsapp WHERE nome_meta = 't_optout_vm'), 'ambos', ?, 'ativa')`,
      `Campanha ${tipoMensagem}`,
      tipoMensagem,
    ).lastInsertRowid,
  );
  exec(
    `INSERT INTO campanha_whatsapp_envios (campanha_id, telefone, nome, origem_tipo, cidade, status)
     VALUES (?, ?, 'Ana', 'application', 'Joinville', 'pendente')`,
    campanhaId,
    telefone,
  );
  db.definirConfigBool(campanha.CHAVE_ATIVO, true);
  exec(
    "INSERT OR IGNORE INTO regioes_grupos_whatsapp (cidade, link_convite_grupo, slug) " +
      "VALUES ('Joinville', 'https://chat.whatsapp.com/x', 'joinville')",
  );
  return campanhaId;
}

const filaCampanha = (id) =>
  db.getDb().prepare('SELECT status FROM campanha_whatsapp_envios WHERE campanha_id = ?').all(id);

test('envio de campanha: convite_grupo com opt-out campanha vira status opt_out, sem enviar', async () => {
  zerar();
  const id = campanhaCom('convite_grupo', '5547900002051');
  optout.registrarOptout({ telefone: '5547900002051', escopo: 'campanha', origem: 'link' });

  let enviou = false;
  const r = await campanha.processarCicloCampanhaWhatsapp({
    enviarTemplate: async () => {
      enviou = true;
      return { wamid: 'x' };
    },
    intervaloMs: 0,
  });

  assert.equal(enviou, false, 'nao chamou o transporte');
  assert.equal(r.optOut, 1);
  assert.equal(filaCampanha(id)[0].status, 'opt_out');
});

test('envio de campanha: status_candidatura com opt-out CAMPANHA e enviado normalmente', async () => {
  zerar();
  const id = campanhaCom('status_candidatura', '5547900002052');
  optout.registrarOptout({ telefone: '5547900002052', escopo: 'campanha', origem: 'link' });

  const r = await campanha.processarCicloCampanhaWhatsapp({
    enviarTemplate: async () => ({ wamid: 'wamid-1' }),
    intervaloMs: 0,
  });

  assert.equal(r.optOut, 0);
  assert.equal(r.enviados, 1);
  assert.equal(filaCampanha(id)[0].status, 'enviado');
});

test('envio de campanha: status_candidatura com opt-out TOTAL e suprimido', async () => {
  zerar();
  const id = campanhaCom('status_candidatura', '5547900002053');
  optout.registrarOptout({ telefone: '5547900002053', escopo: 'total', origem: 'manual' });

  const r = await campanha.processarCicloCampanhaWhatsapp({
    enviarTemplate: async () => ({ wamid: 'wamid-1' }),
    intervaloMs: 0,
  });

  assert.equal(r.optOut, 1);
  assert.equal(filaCampanha(id)[0].status, 'opt_out');
});

// ══════════════════════════════════════════════════════════════
// Guard por registro — sequencia WA1/WA2 (transacional)
// ══════════════════════════════════════════════════════════════

function agendar(applicationId, telefone, etapa) {
  db.agendarEnvioWhatsapp({
    applicationId,
    etapa,
    telefone,
    agendadoPara: '2020-01-01 00:00:00',
    templateNome: etapa,
  });
}

const filaSequencia = () =>
  db.getDb().prepare('SELECT etapa, status FROM whatsapp_sequencia_envios ORDER BY etapa').all();

async function rodarSequencia() {
  return sequencia.processarCicloSequencia({ mock: true, intervaloMs: 0, agora: '2026-08-20 10:00:00' });
}

test('sequencia: opt-out CAMPANHA nao bloqueia WA1/WA2', async () => {
  zerar();
  db.definirConfigBool(sequencia.CHAVE_ATIVO, true);
  const id = candidatura(vagaCom('Joinville'), 'Ana', '+55 47 90000-2061');
  agendar(id, '5547900002061', 'wa1');
  agendar(id, '5547900002061', 'wa2');
  optout.registrarOptout({ telefone: '5547900002061', escopo: 'campanha', origem: 'link' });

  const r = await rodarSequencia();
  assert.equal(r.enviados, 2);
  assert.deepEqual(
    filaSequencia().map((l) => l.status),
    ['enviado', 'enviado'],
  );
});

test('sequencia: opt-out TOTAL bloqueia, com status terminal optout (nao retentavel)', async () => {
  zerar();
  db.definirConfigBool(sequencia.CHAVE_ATIVO, true);
  const id = candidatura(vagaCom('Joinville'), 'Ana', '+55 47 90000-2062');
  agendar(id, '5547900002062', 'wa1');
  optout.registrarOptout({ telefone: '5547900002062', escopo: 'total', origem: 'manual' });

  const r = await rodarSequencia();
  assert.equal(r.enviados, 0);
  assert.equal(r.pulados, 1);
  assert.equal(filaSequencia()[0].status, 'optout');

  // Terminal de verdade: um segundo ciclo nao a devolve para a fila.
  const r2 = await rodarSequencia();
  assert.equal(r2.pulados, 0, 'nao volta na fila no ciclo seguinte');
});

// ══════════════════════════════════════════════════════════════
// P2 — RECANDIDATURA: o cenario canonico
// ══════════════════════════════════════════════════════════════

test('P2 recandidatura: opt-out campanha + candidatura NOVA -> WA1/WA2 saem, campanha continua suprimida', async () => {
  zerar();
  db.definirConfigBool(sequencia.CHAVE_ATIVO, true);
  const telefone = '5547900002071';

  // 1. Ela pede descadastro (escopo campanha, o default de todo pedido automatico).
  optout.registrarOptout({ telefone, escopo: 'campanha', origem: 'link' });

  // 2. Um mes depois, se candidata a uma vaga nova com o MESMO numero.
  const id = candidatura(vagaCom('Joinville'), 'Ana', '+55 47 90000-2071');
  agendar(id, telefone, 'wa1');
  agendar(id, telefone, 'wa2');

  // 3. Recebe WA1 e WA2 — ato explicito e recente dela.
  const r = await rodarSequencia();
  assert.equal(r.enviados, 2, 'a candidatura nova precisa ser atendida');

  // 4. E continua fora das campanhas.
  assert.equal(publicoCampanha.listarPublicoConviteGrupo({}).total, 0, 'segue fora do convite de grupo');
  assert.equal(
    (await publicoDisparo.listarPendentesPorCidade('Joinville', semChecagemDeExistencia)).length,
    0,
    'segue fora do disparo por praca',
  );

  // 5. O opt-out NAO foi revogado por nada disso.
  assert.equal(optout.estaOptout(telefone, 'campanha'), true);
  const linha = db.obterWhatsappOptout(telefone);
  assert.ok(linha, 'o opt-out continua ativo');
  assert.equal(linha.escopo, 'campanha');
});

// ══════════════════════════════════════════════════════════════
// Kill-switch
// ══════════════════════════════════════════════════════════════

test('kill-switch desligado: a supressao some dos motores de selecao e de envio', async () => {
  zerar();
  candidatura(vagaCom('Joinville'), 'Ana', '+55 47 90000-2081');
  optout.registrarOptout({ telefone: '5547900002081', escopo: 'campanha', origem: 'link' });
  assert.equal(publicoCampanha.listarPublicoConviteGrupo({}).total, 0);

  db.definirConfigBool(optout.CHAVE_ATIVO, false);
  assert.equal(publicoCampanha.listarPublicoConviteGrupo({}).total, 1, 'volta ao publico');
  assert.equal(
    (await publicoDisparo.listarPendentesPorCidade('Joinville', semChecagemDeExistencia)).length,
    1,
  );
  db.definirConfigBool(optout.CHAVE_ATIVO, true);
});

// ══════════════════════════════════════════════════════════════
// A tabela de escopo por tipo de mensagem
// ══════════════════════════════════════════════════════════════

test('escopoDoTipoMensagem: a fronteira campanha x transacional esta escrita uma vez so', () => {
  assert.equal(optout.escopoDoTipoMensagem('convite_grupo'), 'campanha');
  assert.equal(optout.escopoDoTipoMensagem('divulgacao_vaga'), 'campanha');
  assert.equal(optout.escopoDoTipoMensagem('status_candidatura'), 'transacional');
  assert.equal(optout.escopoDoTipoMensagem('wa1'), 'transacional');
  assert.equal(optout.escopoDoTipoMensagem('wa2'), 'transacional');
  assert.equal(optout.escopoDoTipoMensagem('reprovacao'), 'transacional');
});

test('escopoDoTipoMensagem: tipo DESCONHECIDO cai no escopo mais restritivo', () => {
  // Um tipo novo que ninguem classificou nasce suprimido para quem pediu silencio, em vez
  // de escapar da supressao por omissao.
  assert.equal(optout.escopoDoTipoMensagem('tipo_que_ainda_nao_existe'), 'campanha');
  assert.equal(optout.escopoDoTipoMensagem(''), 'campanha');
  assert.equal(optout.escopoDoTipoMensagem(null), 'campanha');
});
