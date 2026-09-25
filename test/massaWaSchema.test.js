'use strict';

// B1 — fundacao de dados do disparo em massa por WhatsApp (Baileys): as tres tabelas novas e
// a camada de dados agnostica.
//
// ── POR QUE TESTAR SCHEMA AQUI ──
// As constraints deste subsistema nao sao higiene: sao as salvaguardas de um sistema que manda
// mensagem para fora por um canal que pode ser BLOQUEADO. Duas delas em especial:
//
//   UNIQUE(campanha_id, telefone_canonico)  a ultima linha de defesa contra a mesma PESSOA
//                                           receber a mesma campanha duas vezes — e mensagem
//                                           repetida e o que faz alguem denunciar o numero.
//   'cancelada'/'concluida' terminais       campanha cancelada nao volta a enviar por um
//                                           clique errado.
//
// Nada disso e exercitado por teste de logica de negocio, e o dano so apareceria em producao,
// em mensagem JA ENVIADA, sem desfazer.
//
// NENHUMA REDE, NENHUM ENVIO, NENHUM SOCKET: so banco.

const os = require('node:os');
const path = require('node:path');

process.env.DATABASE_PATH = path.join(
  os.tmpdir(),
  `vm-test-massa-wa-schema-${process.pid}-${Date.now()}.db`,
);
process.env.INTERVIEW_MOCK = 'true';
process.env.SESSION_SECRET = 'segredo-de-teste';
process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert/strict');

const db = require('../src/db');
const { migrar } = require('../src/db/migrate');

migrar();

const run = (sql, ...p) => Number(db.getDb().prepare(sql).run(...p).lastInsertRowid);

let seq = 0;
function novaVaga(campos = {}) {
  seq += 1;
  return db.criarVaga({
    slug: `vaga-massa-${seq}`,
    titulo: 'Closer de Vendas',
    perfil: 'CLOSER',
    ...campos,
  });
}

function novaCampanha(extra = {}) {
  seq += 1;
  return db.criarCampanhaMassaWa({ nome: `Campanha ${seq}`, ...extra });
}

// Item de fila valido. `telefoneCanonico` e a IDENTIDADE; `telefone` e o que se disca.
function item(n, extra = {}) {
  return {
    telefone: `55479995825${String(n).padStart(2, '0')}`,
    telefoneCanonico: `554799958 25${String(n).padStart(2, '0')}`.replace(/\s/g, ''),
    nome: `Pessoa ${n}`,
    ...extra,
  };
}

const porStatus = (campanhaId) =>
  Object.fromEntries(db.resumoCampanhaMassaWa(campanhaId).map((l) => [l.status, l.n]));

const pendente = (campanhaId) => db.listarPendentesCampanhaMassaWa(campanhaId, { limite: 50 })[0];

// ══════════════════ TABELAS E INDICES ══════════════════

test('as tres tabelas e os dois indices existem', () => {
  const existe = (tipo, nome) =>
    Boolean(
      db.getDb().prepare('SELECT name FROM sqlite_master WHERE type = ? AND name = ?').get(tipo, nome),
    );

  assert.ok(existe('table', 'campanhas_massa_wa'));
  assert.ok(existe('table', 'campanhas_massa_wa_variacoes'));
  assert.ok(existe('table', 'campanhas_massa_wa_envios'));
  assert.ok(existe('index', 'idx_massa_wa_envios_pendentes'));
  assert.ok(existe('index', 'idx_massa_wa_envios_enviado'));
});

test('o subsistema NAO referencia templates_whatsapp (Baileys e Central Whats separados)', () => {
  // Trava arquitetural: o dia em que alguem puser template_id aqui, os dois canais comecaram a
  // se misturar — e o contrato deles divergem exatamente no que pode ser dito.
  const colunas = (t) =>
    db.getDb().prepare('SELECT name FROM pragma_table_info(?)').all(t).map((l) => l.name);
  for (const t of ['campanhas_massa_wa', 'campanhas_massa_wa_envios']) {
    assert.ok(!colunas(t).includes('template_id'), `${t} nao pode ter template_id`);
    assert.ok(!colunas(t).includes('wamid'), `${t} nao pode ter wamid (nao ha webhook aqui)`);
  }
});

// ══════════════════ CAMPANHA ══════════════════

test('criarCampanhaMassaWa nasce em rascunho, sem cadencia propria e sem estado de worker', () => {
  const id = novaCampanha({ jobId: novaVaga(), textoBase: 'Texto base' });
  const c = db.obterCampanhaMassaWa(id);

  assert.equal(c.status, 'rascunho');
  assert.equal(c.texto_base, 'Texto base');
  assert.equal(c.vaga_titulo, 'Closer de Vendas');
  // Cadencia NULL = "usar o default do codigo". O default vive num lugar so (o worker).
  for (const col of ['lote_min', 'lote_max', 'gap_min_s', 'gap_max_s', 'teto_diario', 'hora_inicio', 'dias_semana']) {
    assert.equal(c[col], null, `${col} deveria nascer NULL`);
  }
  assert.equal(c.proximo_envio_em, null);
  assert.equal(c.ultima_variacao, null);
  assert.equal(c.erros_consecutivos, 0);
  assert.equal(c.iniciada_em, null);
});

test('job_id NULL significa "todas as vagas abertas", e e um estado valido', () => {
  const c = db.obterCampanhaMassaWa(novaCampanha());
  assert.equal(c.job_id, null);
  assert.equal(c.vaga_titulo, null, 'o LEFT JOIN tem que tolerar campanha sem vaga');
});

test('cadencia com 0 e preservada (0 nao pode virar "usar o default")', () => {
  // O teste do worker injeta gap 0 para nao esperar. `|| null` transformaria 0 em NULL e o
  // worker passaria a dormir o default — teste que leva minutos em vez de milissegundos.
  const id = novaCampanha({ cadencia: { gapMinS: 0, gapMaxS: 0, pausaLoteMinS: 0, loteMin: 5, loteMax: 8 } });
  const c = db.obterCampanhaMassaWa(id);
  assert.equal(c.gap_min_s, 0);
  assert.equal(c.gap_max_s, 0);
  assert.equal(c.pausa_lote_min_s, 0);
  assert.equal(c.lote_min, 5);
  assert.equal(c.lote_max, 8);
});

test('criterios_json guarda o recorte escolhido e volta parseavel', () => {
  const id = novaCampanha({ criterios: { statusList: ['sem_decisao', 'em_analise'] } });
  const c = db.obterCampanhaMassaWa(id);
  assert.deepEqual(JSON.parse(c.criterios_json), { statusList: ['sem_decisao', 'em_analise'] });
});

test('atualizarCampanhaMassaWa muda o rascunho sem tocar status nem estado do worker', () => {
  const id = novaCampanha({ textoBase: 'Antes' });
  db.definirStatusCampanhaMassaWa(id, 'ativa');
  db.definirProximoEnvioMassaWa(id, '2026-10-01 12:00:00');
  db.definirUltimaVariacaoMassaWa(id, 4);

  db.atualizarCampanhaMassaWa(id, { nome: 'Nome novo', textoBase: 'Depois', cadencia: { tetoDiario: 30 } });

  const c = db.obterCampanhaMassaWa(id);
  assert.equal(c.nome, 'Nome novo');
  assert.equal(c.texto_base, 'Depois');
  assert.equal(c.teto_diario, 30);
  assert.equal(c.status, 'ativa', 'edicao nao pode mexer no status');
  assert.equal(c.proximo_envio_em, '2026-10-01 12:00:00', 'edicao nao pode zerar a cadencia em curso');
  assert.equal(c.ultima_variacao, 4);
});

// ── TRANSICOES DE STATUS ──

test('ativar carimba iniciada_em uma vez, limpa motivo de pausa e zera o disjuntor', () => {
  const id = novaCampanha();
  db.definirStatusCampanhaMassaWa(id, 'ativa');
  const primeira = db.obterCampanhaMassaWa(id).iniciada_em;
  assert.ok(primeira);

  db.definirStatusCampanhaMassaWa(id, 'pausada', { motivo: '3 falhas consecutivas' });
  assert.equal(db.obterCampanhaMassaWa(id).pausada_motivo, '3 falhas consecutivas');
  db.incrementarErrosConsecutivosMassaWa(id);

  db.definirStatusCampanhaMassaWa(id, 'ativa');
  const c = db.obterCampanhaMassaWa(id);
  assert.equal(c.iniciada_em, primeira, 'iniciada_em nao pode ser reescrita a cada retomada');
  assert.equal(c.pausada_motivo, null, 'retomada humana tem que limpar o motivo do disjuntor');
  assert.equal(c.erros_consecutivos, 0);
});

test('pausar guarda o motivo do disjuntor (truncado)', () => {
  const id = novaCampanha();
  db.definirStatusCampanhaMassaWa(id, 'ativa');
  db.definirStatusCampanhaMassaWa(id, 'pausada', { motivo: 'x'.repeat(500) });
  assert.equal(db.obterCampanhaMassaWa(id).pausada_motivo.length, 300);
});

test('cancelada e TERMINAL: nao volta para ativa nem para pausada', () => {
  // Reabrir por engano mandaria mensagem para um publico que alguem ja decidiu poupar.
  const id = novaCampanha();
  db.definirStatusCampanhaMassaWa(id, 'ativa');
  db.definirStatusCampanhaMassaWa(id, 'cancelada');

  assert.equal(db.definirStatusCampanhaMassaWa(id, 'ativa'), 0, 'nao pode reativar');
  assert.equal(db.definirStatusCampanhaMassaWa(id, 'pausada'), 0);
  assert.equal(db.obterCampanhaMassaWa(id).status, 'cancelada');
});

test('concluida tambem e terminal: o caminho e criar campanha nova', () => {
  const id = novaCampanha();
  db.definirStatusCampanhaMassaWa(id, 'ativa');
  db.definirStatusCampanhaMassaWa(id, 'concluida');
  assert.ok(db.obterCampanhaMassaWa(id).concluida_em);
  assert.equal(db.definirStatusCampanhaMassaWa(id, 'ativa'), 0);
});

test('listarCampanhasMassaWaAtivas traz so as ativas', () => {
  const ativa = novaCampanha();
  const pausada = novaCampanha();
  const rascunho = novaCampanha();
  db.definirStatusCampanhaMassaWa(ativa, 'ativa');
  db.definirStatusCampanhaMassaWa(pausada, 'ativa');
  db.definirStatusCampanhaMassaWa(pausada, 'pausada');

  const ids = db.listarCampanhasMassaWaAtivas().map((c) => c.id);
  assert.ok(ids.includes(ativa));
  assert.ok(!ids.includes(pausada));
  assert.ok(!ids.includes(rascunho));
});

test('incrementar/zerar erros consecutivos devolve o valor corrente', () => {
  const id = novaCampanha();
  assert.equal(db.incrementarErrosConsecutivosMassaWa(id), 1);
  assert.equal(db.incrementarErrosConsecutivosMassaWa(id), 2);
  assert.equal(db.incrementarErrosConsecutivosMassaWa(id), 3);
  db.zerarErrosConsecutivosMassaWa(id);
  assert.equal(db.obterCampanhaMassaWa(id).erros_consecutivos, 0);
});

// ══════════════════ VARIACOES ══════════════════

test('salvarVariacoesMassaWa grava as 7 com indice 1..7', () => {
  const id = novaCampanha();
  const textos = Array.from({ length: 7 }, (_, i) => `Variacao ${i + 1}`);
  assert.equal(db.salvarVariacoesMassaWa(id, textos), 7);

  const lidas = db.listarVariacoesMassaWa(id);
  assert.deepEqual(lidas.map((v) => v.indice), [1, 2, 3, 4, 5, 6, 7]);
  assert.equal(lidas[0].texto, 'Variacao 1');
  assert.equal(lidas[6].texto, 'Variacao 7');
});

test('salvar de novo SUBSTITUI o conjunto inteiro (7 -> 5 deixa 5)', () => {
  // UPSERT por indice deixaria as duas ultimas orfas, e o sorteio continuaria entregando um
  // texto que o operador acredita ter apagado.
  const id = novaCampanha();
  db.salvarVariacoesMassaWa(id, Array.from({ length: 7 }, (_, i) => `V${i + 1}`));
  db.salvarVariacoesMassaWa(id, ['A', 'B', 'C', 'D', 'E']);

  const lidas = db.listarVariacoesMassaWa(id);
  assert.equal(lidas.length, 5);
  assert.deepEqual(lidas.map((v) => v.texto), ['A', 'B', 'C', 'D', 'E']);
});

test('variacao vazia ou so espacos nao entra (o sorteio nunca pode devolver string vazia)', () => {
  const id = novaCampanha();
  assert.equal(db.salvarVariacoesMassaWa(id, ['Um', '', '   ', 'Dois', null]), 2);
  assert.deepEqual(db.listarVariacoesMassaWa(id).map((v) => v.texto), ['Um', 'Dois']);
});

test('variacoes sao por campanha: uma nao ve as da outra', () => {
  const a = novaCampanha();
  const b = novaCampanha();
  db.salvarVariacoesMassaWa(a, ['A1', 'A2']);
  db.salvarVariacoesMassaWa(b, ['B1']);
  assert.equal(db.listarVariacoesMassaWa(a).length, 2);
  assert.deepEqual(db.listarVariacoesMassaWa(b).map((v) => v.texto), ['B1']);
});

// ══════════════════ FILA: IDEMPOTENCIA ══════════════════

test('materializar grava a fila numa transacao e devolve quantos entraram', () => {
  const id = novaCampanha();
  const jobId = novaVaga();
  const itens = [1, 2, 3].map((n) => item(n, { jobId }));
  assert.equal(db.materializarCampanhaMassaWa(id, itens), 3);
  assert.deepEqual(porStatus(id), { pendente: 3 });
});

test('a mesma PESSOA em duas grafias (com e sem o 9) entra UMA vez', () => {
  // E a garantia mais importante do subsistema. UNIQUE(campanha_id, telefone) — o que a
  // campanha da Central Whats usa — deixaria as duas passarem, porque normalizam para numeros
  // diferentes. A chave canonica (DDI + DDD + ultimos 8) colapsa as duas na mesma identidade.
  const id = novaCampanha();
  const comNove = { telefone: '5531996820290', telefoneCanonico: '553196820290', nome: 'Ana' };
  const semNove = { telefone: '553196820290', telefoneCanonico: '553196820290', nome: 'Ana' };

  assert.equal(db.materializarCampanhaMassaWa(id, [comNove, semNove]), 1);
  assert.deepEqual(porStatus(id), { pendente: 1 });
});

test('materializar duas vezes nao duplica ninguem (idempotente)', () => {
  const id = novaCampanha();
  const itens = [1, 2].map((n) => item(n));
  db.materializarCampanhaMassaWa(id, itens);
  assert.equal(db.materializarCampanhaMassaWa(id, itens), 0, 'a segunda passada nao insere nada');
  assert.deepEqual(porStatus(id), { pendente: 2 });
});

test('a MESMA pessoa pode entrar em campanhas DIFERENTES', () => {
  // O UNIQUE e por campanha: quem recebeu a campanha de setembro pode receber a de outubro.
  const a = novaCampanha();
  const b = novaCampanha();
  assert.equal(db.materializarCampanhaMassaWa(a, [item(9)]), 1);
  assert.equal(db.materializarCampanhaMassaWa(b, [item(9)]), 1);
});

// ══════════════════ FILA: O QUE CHEGA AO TEXTO ══════════════════

test('a fila traz a vaga DO CANDIDATO com os campos da entrevista em grupo', () => {
  // A vaga vem de e.job_id (do candidato), e nao da campanha: o publico pode ser de TODAS as
  // vagas abertas. E link/data vem para serem resolvidos NO ENVIO — congelados na
  // materializacao, uma campanha de tres dias anunciaria no segundo dia uma reuniao que passou.
  const jobId = novaVaga({
    link_meet: 'https://meet.google.com/abc-defg-hij',
    entrevista_grupo_1_data: '2026-10-01',
    entrevista_grupo_1_hora: '19:30',
    entrevista_grupo_3_data: '2026-10-15',
    entrevista_grupo_3_hora: '09:15',
  });
  const id = novaCampanha();
  db.definirStatusCampanhaMassaWa(id, 'ativa');
  db.materializarCampanhaMassaWa(id, [item(4, { jobId, applicationId: 77 })]);

  const linha = pendente(id);
  assert.equal(linha.job_id, jobId);
  assert.equal(linha.application_id, 77);
  assert.equal(linha.job_titulo, 'Closer de Vendas');
  assert.equal(linha.job_link_meet, 'https://meet.google.com/abc-defg-hij');
  assert.equal(linha.job_entrevista_grupo_1_data, '2026-10-01');
  assert.equal(linha.job_entrevista_grupo_1_hora, '19:30');
  assert.equal(linha.job_entrevista_grupo_2_data, null);
  assert.equal(linha.job_entrevista_grupo_3_hora, '09:15');
});

test('a fila SO devolve pendentes de campanha ATIVA', () => {
  // Filtro de seguranca, nao conveniencia: linha pendente de campanha pausada nao pode sair.
  const id = novaCampanha();
  db.materializarCampanhaMassaWa(id, [item(5)]);
  assert.equal(db.listarPendentesCampanhaMassaWa(id).length, 0, 'rascunho nao envia');

  db.definirStatusCampanhaMassaWa(id, 'ativa');
  assert.equal(db.listarPendentesCampanhaMassaWa(id).length, 1);

  db.definirStatusCampanhaMassaWa(id, 'pausada');
  assert.equal(db.listarPendentesCampanhaMassaWa(id).length, 0, 'pausada nao envia');

  db.definirStatusCampanhaMassaWa(id, 'cancelada');
  assert.equal(db.listarPendentesCampanhaMassaWa(id).length, 0, 'cancelada nao envia');
});

test('a fila respeita o limite e a ordem de id', () => {
  const id = novaCampanha();
  db.definirStatusCampanhaMassaWa(id, 'ativa');
  db.materializarCampanhaMassaWa(id, [11, 12, 13, 14].map((n) => item(n)));

  const lote = db.listarPendentesCampanhaMassaWa(id, { limite: 2 });
  assert.equal(lote.length, 2);
  assert.ok(lote[0].id < lote[1].id);
});

// ══════════════════ FILA: TRANSICOES ══════════════════

function campanhaComUmPendente() {
  const id = novaCampanha();
  db.definirStatusCampanhaMassaWa(id, 'ativa');
  seq += 1;
  db.materializarCampanhaMassaWa(id, [item(20 + (seq % 70))]);
  return { id, envio: pendente(id) };
}

test('marcar enviado grava a variacao usada na mesma instrucao', () => {
  const { id, envio } = campanhaComUmPendente();
  assert.equal(db.marcarEnvioMassaWaEnviado(envio.id, { variacaoIndice: 3 }), 1);

  const linha = db.getDb().prepare('SELECT * FROM campanhas_massa_wa_envios WHERE id = ?').get(envio.id);
  assert.equal(linha.status, 'enviado');
  assert.equal(linha.variacao_indice, 3);
  assert.equal(linha.tentativas, 1);
  assert.ok(linha.enviado_em);
  assert.deepEqual(porStatus(id), { enviado: 1 });
});

test('marcar enviado e condicional ao pendente: a 2a chamada grava 0 linhas', () => {
  const { envio } = campanhaComUmPendente();
  assert.equal(db.marcarEnvioMassaWaEnviado(envio.id, { variacaoIndice: 1 }), 1);
  assert.equal(db.marcarEnvioMassaWaEnviado(envio.id, { variacaoIndice: 2 }), 0);

  const linha = db.getDb().prepare('SELECT variacao_indice FROM campanhas_massa_wa_envios WHERE id = ?').get(envio.id);
  assert.equal(linha.variacao_indice, 1, 'a variacao do envio real nao pode ser sobrescrita');
});

test('registrarTentativa conta e DEIXA pendente (a linha volta no proximo ciclo)', () => {
  const { id, envio } = campanhaComUmPendente();
  db.registrarTentativaEnvioMassaWa(envio.id, 'timeout');

  const linha = db.getDb().prepare('SELECT * FROM campanhas_massa_wa_envios WHERE id = ?').get(envio.id);
  assert.equal(linha.status, 'pendente');
  assert.equal(linha.tentativas, 1);
  assert.equal(linha.erro, 'timeout');
  assert.equal(db.listarPendentesCampanhaMassaWa(id).length, 1);
});

test('os quatro estados terminais nao voltam a fila e sao distinguiveis', () => {
  // Distinguir e o ponto: 'falha' e tecnico, 'opt_out' e vontade da pessoa, 'sem_whatsapp' e
  // numero inexistente, 'sem_reuniao' e falta de dado NOSSO. Misturar em 'falha' apagaria a
  // metrica que diz se a campanha esta incomodando.
  for (const status of ['falha', 'opt_out', 'sem_whatsapp', 'sem_reuniao']) {
    const { id, envio } = campanhaComUmPendente();
    assert.equal(db.marcarEnvioMassaWaTerminal(envio.id, status, `motivo ${status}`), 1);
    assert.deepEqual(porStatus(id), { [status]: 1 });
    assert.equal(db.listarPendentesCampanhaMassaWa(id).length, 0, `${status} nao pode voltar a fila`);
    // Segunda marcacao nao muda nada: terminal e terminal.
    assert.equal(db.marcarEnvioMassaWaTerminal(envio.id, 'falha', 'outro'), 0);
  }
});

test('erro longo e truncado em 300 caracteres', () => {
  const { envio } = campanhaComUmPendente();
  db.marcarEnvioMassaWaTerminal(envio.id, 'falha', 'e'.repeat(1000));
  const linha = db.getDb().prepare('SELECT erro FROM campanhas_massa_wa_envios WHERE id = ?').get(envio.id);
  assert.equal(linha.erro.length, 300);
});

// ══════════════════ TETO DIARIO E RESUMOS ══════════════════

test('contarEnviosMassaWaDesde conta so enviados dentro da janela', () => {
  // O instante vem do CHAMADOR: "hoje" e o dia civil de Brasilia, que so lib/fusoBrasilia sabe
  // calcular. Fazer essa conta em SQL divergiria da outra todos os dias entre 21h e meia-noite.
  const id = novaCampanha();
  db.definirStatusCampanhaMassaWa(id, 'ativa');
  db.materializarCampanhaMassaWa(id, [90, 91, 92].map((n) => item(n)));
  const fila = db.listarPendentesCampanhaMassaWa(id, { limite: 10 });

  db.marcarEnvioMassaWaEnviado(fila[0].id, { quando: '2026-10-01 10:00:00', variacaoIndice: 1 });
  db.marcarEnvioMassaWaEnviado(fila[1].id, { quando: '2026-10-02 14:00:00', variacaoIndice: 2 });
  db.marcarEnvioMassaWaTerminal(fila[2].id, 'falha', 'x');

  assert.equal(db.contarEnviosMassaWaDesde(id, '2026-10-02 03:00:00'), 1, 'so o do dia 2');
  assert.equal(db.contarEnviosMassaWaDesde(id, '2026-10-01 00:00:00'), 2);
  assert.equal(db.contarEnviosMassaWaDesde(id, '2026-10-03 00:00:00'), 0);
});

test('o teto diario e por campanha: o envio de uma nao conta para a outra', () => {
  const a = novaCampanha();
  const b = novaCampanha();
  db.definirStatusCampanhaMassaWa(a, 'ativa');
  db.materializarCampanhaMassaWa(a, [item(95)]);
  db.marcarEnvioMassaWaEnviado(pendente(a).id, { quando: '2026-10-01 10:00:00' });

  assert.equal(db.contarEnviosMassaWaDesde(a, '2026-10-01 00:00:00'), 1);
  assert.equal(db.contarEnviosMassaWaDesde(b, '2026-10-01 00:00:00'), 0);
});

test('distribuicaoVariacoesMassaWa mostra se o sorteio esta distribuindo', () => {
  // Um sorteio quebrado que entrega sempre a mesma variacao anula a razao de existirem sete, e
  // nada mais no sistema denunciaria isso.
  const id = novaCampanha();
  db.definirStatusCampanhaMassaWa(id, 'ativa');
  db.materializarCampanhaMassaWa(id, [70, 71, 72].map((n) => item(n)));
  const fila = db.listarPendentesCampanhaMassaWa(id, { limite: 10 });
  db.marcarEnvioMassaWaEnviado(fila[0].id, { variacaoIndice: 2 });
  db.marcarEnvioMassaWaEnviado(fila[1].id, { variacaoIndice: 2 });
  db.marcarEnvioMassaWaEnviado(fila[2].id, { variacaoIndice: 5 });

  assert.deepEqual(
    db.distribuicaoVariacoesMassaWa(id).map((l) => [l.variacao_indice, l.n]),
    [[2, 2], [5, 1]],
  );
});

// ══════════════════ PRIORIDADE DO TRANSACIONAL ══════════════════

test('existePendenciaSequenciaWhatsapp: false com a fila transacional vazia', () => {
  db.getDb().exec('DELETE FROM whatsapp_sequencia_envios');
  assert.equal(db.existePendenciaSequenciaWhatsapp(), false);
});

test('existePendenciaSequenciaWhatsapp: true quando ha WA1/WA2 VENCIDO esperando', () => {
  // E o que faz o disparo em massa ceder a vez. WA1 e a primeira mensagem que um candidato
  // recebe; atrasa-la porque uma campanha esta no meio de um lote inverte a importancia das
  // duas coisas.
  db.getDb().exec('DELETE FROM whatsapp_sequencia_envios');
  const jobId = novaVaga();
  const appId = run(
    `INSERT INTO applications (job_id, nome, telefone) VALUES (?, 'Maria', '5547999582500')`,
    jobId,
  );
  db.agendarEnvioWhatsapp({
    applicationId: appId,
    etapa: 'wa1',
    telefone: '5547999582500',
    agendadoPara: '2020-01-01 00:00:00',
    templateNome: 'wa1',
  });

  assert.equal(db.existePendenciaSequenciaWhatsapp(), true);
});

test('agendamento FUTURO nao segura a fila de massa', () => {
  // Pendencia que ainda nao venceu nao e pendencia: se qualquer WA2 agendado para daqui a 15
  // min bloqueasse a massa, ela nunca enviaria nada num dia de candidaturas.
  db.getDb().exec('DELETE FROM whatsapp_sequencia_envios');
  const jobId = novaVaga();
  const appId = run(
    `INSERT INTO applications (job_id, nome, telefone) VALUES (?, 'Joao', '5547999582501')`,
    jobId,
  );
  db.agendarEnvioWhatsapp({
    applicationId: appId,
    etapa: 'wa2',
    telefone: '5547999582501',
    agendadoPara: '2099-01-01 00:00:00',
    templateNome: 'wa2',
  });

  assert.equal(db.existePendenciaSequenciaWhatsapp(), false);
});

test('existePendenciaSequenciaWhatsapp aceita "agora" injetado (testavel sem relogio real)', () => {
  db.getDb().exec('DELETE FROM whatsapp_sequencia_envios');
  const jobId = novaVaga();
  const appId = run(
    `INSERT INTO applications (job_id, nome, telefone) VALUES (?, 'Ana', '5547999582502')`,
    jobId,
  );
  db.agendarEnvioWhatsapp({
    applicationId: appId,
    etapa: 'wa1',
    telefone: '5547999582502',
    agendadoPara: '2026-10-01 12:00:00',
    templateNome: 'wa1',
  });

  assert.equal(db.existePendenciaSequenciaWhatsapp('2026-10-01 11:59:59'), false);
  assert.equal(db.existePendenciaSequenciaWhatsapp('2026-10-01 12:00:00'), true);
});

// ══════════════════ CAMADA AGNOSTICA ══════════════════

test('db/index.js reexporta todas as funcoes do subsistema (nada de SQL fora de src/db)', () => {
  const esperadas = [
    'criarCampanhaMassaWa', 'listarCampanhasMassaWa', 'obterCampanhaMassaWa',
    'listarCampanhasMassaWaAtivas', 'atualizarCampanhaMassaWa', 'definirStatusCampanhaMassaWa',
    'definirProximoEnvioMassaWa', 'definirUltimaVariacaoMassaWa',
    'incrementarErrosConsecutivosMassaWa', 'zerarErrosConsecutivosMassaWa',
    'salvarVariacoesMassaWa', 'listarVariacoesMassaWa', 'materializarCampanhaMassaWa',
    'listarPendentesCampanhaMassaWa', 'marcarEnvioMassaWaEnviado',
    'registrarTentativaEnvioMassaWa', 'marcarEnvioMassaWaTerminal', 'contarEnviosMassaWaDesde',
    'resumoCampanhaMassaWa', 'distribuicaoVariacoesMassaWa', 'existePendenciaSequenciaWhatsapp',
  ];
  for (const nome of esperadas) {
    assert.equal(typeof db[nome], 'function', `db.${nome} deveria estar exportada`);
  }
});
