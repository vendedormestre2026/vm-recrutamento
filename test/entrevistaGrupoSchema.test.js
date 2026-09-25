'use strict';

// B1 — fundacao de dados da entrevista em grupo: as 7 colunas em `jobs`, a coluna `variante`
// em `whatsapp_sequencia_envios`, e a travessia delas pela camada de dados.
//
// POR QUE ESTE TESTE EXISTE, e por que ele NAO e uma formalidade de schema: criarVaga e
// atualizarVaga escrevem por LISTA LITERAL de colunas (INSERT e UPDATE escritos a mao em
// db/sqlite.js). Uma coluna que existe no banco mas nao entra nas duas listas e o defeito
// mais silencioso possivel deste projeto — o formulario aceita o valor, a rota responde
// "salvo", e o dado simplesmente nao esta la depois. Nao ha erro em lugar nenhum.
//
// Por isso as assercoes sao de IDA E VOLTA (grava -> le -> compara), e nao "a coluna existe":
// a segunda passaria com as listas literais intactas e erradas.
//
// NENHUMA REDE, NENHUM ENVIO: so banco.

const os = require('node:os');
const path = require('node:path');

process.env.DATABASE_PATH = path.join(
  os.tmpdir(),
  `vm-test-entrevista-grupo-schema-${process.pid}-${Date.now()}.db`,
);
process.env.INTERVIEW_MOCK = 'true';
process.env.SESSION_SECRET = 'segredo-de-teste';
process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert/strict');

const db = require('../src/db');
const { migrar } = require('../src/db/migrate');

migrar(); // as colunas precisam existir antes de qualquer assercao

const COLUNAS_JOBS = [
  'link_meet',
  'entrevista_grupo_1_data',
  'entrevista_grupo_1_hora',
  'entrevista_grupo_2_data',
  'entrevista_grupo_2_hora',
  'entrevista_grupo_3_data',
  'entrevista_grupo_3_hora',
];

function colunasDe(tabela) {
  return new Set(
    db
      .getDb()
      .prepare('SELECT name FROM pragma_table_info(?)')
      .all(tabela)
      .map((l) => l.name),
  );
}

let seq = 0;
function novaVaga(campos = {}) {
  seq += 1;
  return db.criarVaga({
    slug: `vaga-grupo-${seq}`,
    titulo: 'Closer de Vendas',
    perfil: 'CLOSER',
    ...campos,
  });
}

// ══════════════════ COLUNAS ══════════════════

test('migrar() cria as 7 colunas de entrevista em grupo em jobs', () => {
  const colunas = colunasDe('jobs');
  for (const c of COLUNAS_JOBS) {
    assert.ok(colunas.has(c), `coluna ausente em jobs: ${c}`);
  }
});

test('migrar() cria whatsapp_sequencia_envios.variante', () => {
  assert.ok(colunasDe('whatsapp_sequencia_envios').has('variante'));
});

test('migrar() e idempotente: rodar de novo nao lanca nem duplica coluna', () => {
  migrar();
  migrar();
  const colunas = [...colunasDe('jobs')].filter((c) => c === 'link_meet');
  assert.equal(colunas.length, 1);
});

// ══════════════════ criarVaga ══════════════════

test('criarVaga persiste link do Meet e os 3 pares data/hora (ida e volta)', () => {
  const id = novaVaga({
    link_meet: 'https://meet.google.com/abc-defg-hij',
    entrevista_grupo_1_data: '2026-10-02',
    entrevista_grupo_1_hora: '19:30',
    entrevista_grupo_2_data: '2026-10-09',
    entrevista_grupo_2_hora: '20:00',
    entrevista_grupo_3_data: '2026-10-16',
    entrevista_grupo_3_hora: '09:15',
  });

  const vaga = db.obterVaga(id);
  assert.equal(vaga.link_meet, 'https://meet.google.com/abc-defg-hij');
  assert.equal(vaga.entrevista_grupo_1_data, '2026-10-02');
  assert.equal(vaga.entrevista_grupo_1_hora, '19:30');
  assert.equal(vaga.entrevista_grupo_2_data, '2026-10-09');
  assert.equal(vaga.entrevista_grupo_2_hora, '20:00');
  assert.equal(vaga.entrevista_grupo_3_data, '2026-10-16');
  assert.equal(vaga.entrevista_grupo_3_hora, '09:15');
});

test('criarVaga: vaga sem entrevista em grupo grava NULL (nao string vazia)', () => {
  // NULL e o que proximaEntrevistaGrupo le como "nao cadastrado". '' passaria pelas mesmas
  // checagens hoje, mas guardar dois sentinelas para a mesma ausencia e como se perde a
  // consistencia depois.
  const vaga = db.obterVaga(novaVaga());
  for (const c of COLUNAS_JOBS) {
    assert.equal(vaga[c], null, `esperava NULL em ${c}`);
  }
});

test('criarVaga: par incompleto (data sem hora) e gravado como veio — quem julga e a lib', () => {
  // A camada de dados NAO valida par: ela guarda o que o formulario mandou. A regra de "par
  // incompleto e ignorado" mora em lib/entrevistaGrupo (B2), e testa-la aqui duplicaria a
  // regra em duas camadas — a hora de consertar isso e no save, com aviso ao admin (B3).
  const vaga = db.obterVaga(
    novaVaga({ entrevista_grupo_1_data: '2026-10-02', entrevista_grupo_1_hora: '' }),
  );
  assert.equal(vaga.entrevista_grupo_1_data, '2026-10-02');
  assert.equal(vaga.entrevista_grupo_1_hora, null);
});

// ══════════════════ atualizarVaga ══════════════════

test('atualizarVaga persiste os 7 campos (a lista literal do UPDATE inclui todos)', () => {
  const id = novaVaga();

  db.atualizarVaga(id, {
    titulo: 'Closer de Vendas',
    link_meet: 'https://meet.google.com/zzz-yyyy-xxx',
    entrevista_grupo_1_data: '2026-11-03',
    entrevista_grupo_1_hora: '18:00',
    entrevista_grupo_2_data: '2026-11-10',
    entrevista_grupo_2_hora: '18:30',
    entrevista_grupo_3_data: '2026-11-17',
    entrevista_grupo_3_hora: '19:00',
  });

  const vaga = db.obterVaga(id);
  assert.equal(vaga.link_meet, 'https://meet.google.com/zzz-yyyy-xxx');
  assert.equal(vaga.entrevista_grupo_1_data, '2026-11-03');
  assert.equal(vaga.entrevista_grupo_1_hora, '18:00');
  assert.equal(vaga.entrevista_grupo_2_data, '2026-11-10');
  assert.equal(vaga.entrevista_grupo_2_hora, '18:30');
  assert.equal(vaga.entrevista_grupo_3_data, '2026-11-17');
  assert.equal(vaga.entrevista_grupo_3_hora, '19:00');
});

test('atualizarVaga limpa a entrevista em grupo quando os campos vem vazios', () => {
  // Apagar a reuniao e acao valida (reuniao cancelada). Mesmo comportamento de video_intro.
  const id = novaVaga({
    link_meet: 'https://meet.google.com/abc-defg-hij',
    entrevista_grupo_1_data: '2026-10-02',
    entrevista_grupo_1_hora: '19:30',
  });

  db.atualizarVaga(id, { titulo: 'Closer de Vendas' });

  const vaga = db.obterVaga(id);
  for (const c of COLUNAS_JOBS) {
    assert.equal(vaga[c], null, `esperava NULL em ${c} apos limpar`);
  }
});

test('atualizarVaga nao mexe nos campos vizinhos ao salvar a entrevista em grupo', () => {
  // Cinto de seguranca da lista literal: um @parametro trocado de lugar no UPDATE gravaria
  // o valor de uma coluna em outra, e isso passaria em todo teste que so olha as 7 novas.
  const id = novaVaga({
    empresa: 'Acme Ltda',
    video_intro_tipo: 'youtube',
    video_intro_ref: 'dQw4w9WgXcQ',
  });

  db.atualizarVaga(id, {
    titulo: 'Closer de Vendas',
    empresa: 'Acme Ltda',
    video_intro_tipo: 'youtube',
    video_intro_ref: 'dQw4w9WgXcQ',
    link_meet: 'https://meet.google.com/abc-defg-hij',
    entrevista_grupo_1_data: '2026-10-02',
    entrevista_grupo_1_hora: '19:30',
  });

  const vaga = db.obterVaga(id);
  assert.equal(vaga.empresa, 'Acme Ltda');
  assert.equal(vaga.video_intro_tipo, 'youtube');
  assert.equal(vaga.video_intro_ref, 'dQw4w9WgXcQ');
  assert.equal(vaga.link_meet, 'https://meet.google.com/abc-defg-hij');
});

// ══════════════════ FILA: as colunas chegam ao motor de envio ══════════════════

function criarApplication(jobId) {
  return Number(
    db
      .getDb()
      .prepare(
        `INSERT INTO applications (job_id, nome, telefone, criado_em)
         VALUES (?, 'Maria Souza', '5547999582500', datetime('now'))`,
      )
      .run(jobId).lastInsertRowid,
  );
}

test('listarPendentesSequenciaWhatsapp traz link e datas da vaga na linha da fila', () => {
  // O SELECT da fila e o gargalo real: textoDaEtapa monta o objeto `job` SO com o que vem
  // daqui. Coluna fora desta lista = mensagem sem link, sem erro nenhum.
  const jobId = novaVaga({
    link_meet: 'https://meet.google.com/fil-aaaa-bbb',
    entrevista_grupo_1_data: '2026-10-02',
    entrevista_grupo_1_hora: '19:30',
    entrevista_grupo_3_data: '2026-10-16',
    entrevista_grupo_3_hora: '09:15',
  });
  const appId = criarApplication(jobId);

  db.agendarEnvioWhatsapp({
    applicationId: appId,
    etapa: 'wa2',
    telefone: '5547999582500',
    agendadoPara: '2020-01-01 00:00:00', // ja venceu: entra na fila
    templateNome: 'wa2',
  });

  const linha = db
    .listarPendentesSequenciaWhatsapp({ limite: 10 })
    .find((l) => l.application_id === appId);

  assert.ok(linha, 'a linha agendada deveria estar na fila');
  assert.equal(linha.job_link_meet, 'https://meet.google.com/fil-aaaa-bbb');
  assert.equal(linha.job_entrevista_grupo_1_data, '2026-10-02');
  assert.equal(linha.job_entrevista_grupo_1_hora, '19:30');
  assert.equal(linha.job_entrevista_grupo_2_data, null);
  assert.equal(linha.job_entrevista_grupo_2_hora, null);
  assert.equal(linha.job_entrevista_grupo_3_data, '2026-10-16');
  assert.equal(linha.job_entrevista_grupo_3_hora, '09:15');
});

// ══════════════════ VARIANTE ══════════════════

test('marcarSequenciaWhatsappEnviada grava a variante junto do enviado', () => {
  const appId = criarApplication(novaVaga());
  db.agendarEnvioWhatsapp({
    applicationId: appId,
    etapa: 'wa2',
    telefone: '5547999582500',
    agendadoPara: '2020-01-01 00:00:00',
    templateNome: 'wa2',
  });
  const linha = db.listarPendentesSequenciaWhatsapp({ limite: 50 }).find((l) => l.application_id === appId);

  assert.equal(db.marcarSequenciaWhatsappEnviada(linha.id, null, 'sem_reuniao'), 1);

  const wa2 = db.listarSequenciaWhatsappDaApplication(appId).find((l) => l.etapa === 'wa2');
  assert.equal(wa2.status, 'enviado');
  assert.equal(wa2.variante, 'sem_reuniao');
});

test('marcarSequenciaWhatsappEnviada sem variante mantem NULL (wa1 e reprovacao)', () => {
  const appId = criarApplication(novaVaga());
  db.agendarEnvioWhatsapp({
    applicationId: appId,
    etapa: 'wa1',
    telefone: '5547999582500',
    agendadoPara: '2020-01-01 00:00:00',
    templateNome: 'wa1',
  });
  const linha = db.listarPendentesSequenciaWhatsapp({ limite: 50 }).find((l) => l.application_id === appId);

  db.marcarSequenciaWhatsappEnviada(linha.id);

  const wa1 = db.listarSequenciaWhatsappDaApplication(appId).find((l) => l.etapa === 'wa1');
  assert.equal(wa1.status, 'enviado');
  assert.equal(wa1.variante, null);
});

test('marcarSequenciaWhatsappEnviada e condicional ao pendente: a 2a chamada grava 0 linhas', () => {
  // Contrato que ja existia (dois ciclos cruzados nao enviam duas vezes); aqui garantimos que
  // a coluna nova nao afrouxou o WHERE status = 'pendente'.
  const appId = criarApplication(novaVaga());
  db.agendarEnvioWhatsapp({
    applicationId: appId,
    etapa: 'wa2',
    telefone: '5547999582500',
    agendadoPara: '2020-01-01 00:00:00',
    templateNome: 'wa2',
  });
  const linha = db.listarPendentesSequenciaWhatsapp({ limite: 50 }).find((l) => l.application_id === appId);

  assert.equal(db.marcarSequenciaWhatsappEnviada(linha.id, null, 'convite_grupo'), 1);
  assert.equal(db.marcarSequenciaWhatsappEnviada(linha.id, null, 'sem_reuniao'), 0);

  const wa2 = db.listarSequenciaWhatsappDaApplication(appId).find((l) => l.etapa === 'wa2');
  assert.equal(wa2.variante, 'convite_grupo', 'a variante do envio real nao pode ser sobrescrita');
});
