'use strict';

// B2 — montagem do publico do disparo em massa (lib/publicoMassaWhatsapp) sobre banco real.
//
// Banco de verdade (tmp), e nao mocks: o que este arquivo guarda sao os RECORTES, e metade
// deles e SQL (vaga aberta, arquivada, telefone vazio). Com `db` mockado, um WHERE errado
// passaria — e o custo de um WHERE errado aqui e mensagem em massa para quem nao deveria
// receber, que nao se desfaz.
//
// NENHUMA REDE, NENHUM SOCKET: este motor nao fala com o WhatsApp de proposito (ver a decisao
// 4 no cabecalho da lib).

const os = require('node:os');
const path = require('node:path');

process.env.DATABASE_PATH = path.join(
  os.tmpdir(),
  `vm-test-publico-massa-wa-${process.pid}-${Date.now()}.db`,
);
process.env.INTERVIEW_MOCK = 'true';
process.env.SESSION_SECRET = 'segredo-de-teste';
process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert/strict');

const db = require('../src/db');
const { migrar } = require('../src/db/migrate');
const {
  montarPublicoMassaWa,
  sanearStatusList,
  STATUS_SELECIONAVEIS,
  STATUS_PADRAO,
} = require('../src/lib/publicoMassaWhatsapp');

migrar();

let seq = 0;

function novaVaga({ ativo = true, cidade = null } = {}) {
  seq += 1;
  return db.criarVaga({
    slug: `vaga-pub-massa-${seq}`,
    titulo: `Vaga ${seq}`,
    perfil: 'CLOSER',
    cidade,
    ativo,
  });
}

// Candidatura por SQL direto: `status_recrutador` precisa receber valores que a camada de
// dados recusaria (NULL, '', 'Em Análise', lixo) — e sao exatamente esses os casos sob teste.
function novaCandidatura({ jobId, telefone, nome = 'Pessoa', status = null, arquivada = false, criadoEm = null }) {
  const id = Number(
    db
      .getDb()
      .prepare(
        `INSERT INTO applications (job_id, nome, telefone, status_recrutador, deleted_at, criado_em)
         VALUES (?, ?, ?, ?, ?, COALESCE(?, datetime('now')))`,
      )
      .run(jobId, nome, telefone, status, arquivada ? '2026-01-01 00:00:00' : null, criadoEm)
      .lastInsertRowid,
  );
  return id;
}

// Telefones distintos e validos (celular BR com 9 digitos).
let telSeq = 0;
function telefone() {
  telSeq += 1;
  return `4799${String(9580000 + telSeq).padStart(7, '0')}`;
}

// Ordem OBRIGATORIA: as filas de campanha tem FK para jobs.id, e o pragma foreign_keys esta
// ON (db/sqlite.js). Apagar `jobs` antes delas estoura "FOREIGN KEY constraint failed" —
// foi assim que este arquivo descobriu que excluirVaga tambem precisava conhecer as tabelas
// novas (ver TABELAS_DEPENDENTES_VAGA).
function limpar() {
  const conn = db.getDb();
  conn.exec('DELETE FROM campanhas_massa_wa_envios');
  conn.exec('DELETE FROM campanhas_massa_wa_variacoes');
  conn.exec('DELETE FROM campanhas_massa_wa');
  conn.exec('DELETE FROM applications');
  conn.exec('DELETE FROM whatsapp_optout');
  conn.exec('DELETE FROM whatsapp_opt_out');
  conn.exec('DELETE FROM jobs');
}

const chaves = (r) => r.itens.map((i) => i.telefoneCanonico).sort();

// ══════════════════ sanearStatusList ══════════════════

test('sanearStatusList descarta valor fora do enum e colapsa duplicata', () => {
  assert.deepEqual(sanearStatusList(['aprovado', 'lixo', 'aprovado']), ['aprovado']);
  assert.deepEqual(sanearStatusList([]), []);
  assert.deepEqual(sanearStatusList(null), []);
  assert.deepEqual(sanearStatusList(['  sem_decisao  ']), ['sem_decisao']);
  // 'desconhecido' NAO e selecionavel: e o balde de dado corrompido, nao uma opcao de tela.
  assert.deepEqual(sanearStatusList(['desconhecido']), []);
});

test('o default marca sem_decisao e em_analise, e deixa aprovado/reprovado de fora', () => {
  assert.deepEqual([...STATUS_PADRAO].sort(), ['em_analise', 'sem_decisao']);
  assert.ok(!STATUS_PADRAO.includes('aprovado'));
  assert.ok(!STATUS_PADRAO.includes('reprovado'));
  assert.deepEqual([...STATUS_SELECIONAVEIS].sort(), ['aprovado', 'em_analise', 'reprovado', 'sem_decisao']);
});

test('statusList vazia LANCA em vez de cair no default', () => {
  // Um publico surpresa montado com um default que o operador nao escolheu e pior que um erro.
  assert.throws(() => montarPublicoMassaWa({ statusList: [] }), /statusList vazia/);
  assert.throws(() => montarPublicoMassaWa({ statusList: ['lixo'] }), /statusList vazia/);
});

// ══════════════════ RECORTE: VAGA ABERTA ══════════════════

test('so entra quem se candidatou a vaga ATIVA', () => {
  limpar();
  const aberta = novaVaga();
  const fechada = novaVaga({ ativo: false });
  const telAberta = telefone();
  novaCandidatura({ jobId: aberta, telefone: telAberta });
  novaCandidatura({ jobId: fechada, telefone: telefone() });

  const r = montarPublicoMassaWa({});
  assert.equal(r.funil.total, 1);
  assert.equal(r.itens[0].telefone, `55${telAberta}`);
});

test('encerrar a vaga remove o candidato do publico', () => {
  limpar();
  const vaga = novaVaga();
  novaCandidatura({ jobId: vaga, telefone: telefone() });
  assert.equal(montarPublicoMassaWa({}).funil.total, 1);

  db.definirVagaAtiva(vaga, false);
  assert.equal(montarPublicoMassaWa({}).funil.total, 0);
});

test('filtro por vaga: jobId recorta para uma vaga so; null traz todas as abertas', () => {
  limpar();
  const a = novaVaga();
  const b = novaVaga();
  novaCandidatura({ jobId: a, telefone: telefone() });
  novaCandidatura({ jobId: b, telefone: telefone() });
  novaCandidatura({ jobId: b, telefone: telefone() });

  assert.equal(montarPublicoMassaWa({ jobId: a }).funil.total, 1);
  assert.equal(montarPublicoMassaWa({ jobId: b }).funil.total, 2);
  assert.equal(montarPublicoMassaWa({}).funil.total, 3);
  assert.equal(montarPublicoMassaWa({ jobId: null }).funil.total, 3);
});

test('VAGA REMOTA (jobs.cidade NULL) ENTRA — nao passamos por aplicarInvariantes', () => {
  // E o bug latente que herdariamos se reusassemos aplicarInvariantes: la quem nao tem praca
  // resolvivel e descartado em silencio, porque a mensagem carrega o link do grupo da praca.
  // Aqui nao ha praca na mensagem, e excluir vaga remota tiraria centenas de candidatos que
  // sao exatamente o publico pedido.
  limpar();
  const remota = novaVaga({ cidade: null });
  const comPraca = novaVaga({ cidade: 'Joinville' });
  novaCandidatura({ jobId: remota, telefone: telefone() });
  novaCandidatura({ jobId: comPraca, telefone: telefone() });

  assert.equal(montarPublicoMassaWa({}).funil.total, 2);
});

test('a base legada (talentos) NUNCA entra', () => {
  limpar();
  const vaga = novaVaga();
  novaCandidatura({ jobId: vaga, telefone: telefone() });
  db.getDb()
    .prepare(
      `INSERT INTO talentos (nome, telefone, categoria, status) VALUES ('Legado', '5547988887777', 'legado', 'novo')`,
    )
    .run();

  const r = montarPublicoMassaWa({});
  assert.equal(r.funil.total, 1);
  assert.ok(!r.itens.some((i) => i.telefone.includes('88887777')));
});

test('candidatura ARQUIVADA fica fora', () => {
  limpar();
  const vaga = novaVaga();
  novaCandidatura({ jobId: vaga, telefone: telefone() });
  novaCandidatura({ jobId: vaga, telefone: telefone(), arquivada: true });

  assert.equal(montarPublicoMassaWa({}).funil.total, 1);
});

test('candidatura sem telefone (NULL ou vazio) nao entra e nao conta como candidatura lida', () => {
  // O SQL ja descarta: nao chega a ser avaliada, entao nem aparece no funil. E a leitura certa
  // — "candidaturas" no funil significa "candidaturas que este recorte considerou".
  limpar();
  const vaga = novaVaga();
  novaCandidatura({ jobId: vaga, telefone: null });
  novaCandidatura({ jobId: vaga, telefone: '   ' });
  novaCandidatura({ jobId: vaga, telefone: telefone() });

  const r = montarPublicoMassaWa({});
  assert.equal(r.funil.candidaturas, 1);
  assert.equal(r.funil.total, 1);
});

// ══════════════════ STATUS DO RECRUTADOR ══════════════════

test('sem decisao: NULL entra quando sem_decisao esta marcado', () => {
  limpar();
  const vaga = novaVaga();
  novaCandidatura({ jobId: vaga, telefone: telefone(), status: null });

  assert.equal(montarPublicoMassaWa({ statusList: ['sem_decisao'] }).funil.total, 1);
});

test('sem decisao: STRING VAZIA tambem entra (as duas grafias convivem em producao)', () => {
  limpar();
  const vaga = novaVaga();
  novaCandidatura({ jobId: vaga, telefone: telefone(), status: '' });

  const r = montarPublicoMassaWa({ statusList: ['sem_decisao'] });
  assert.equal(r.funil.total, 1, "'' precisa contar como sem_decisao, igual a NULL");
});

test('sem decisao: NULL e \'\' juntos, ambos entram e ambos saem juntos', () => {
  limpar();
  const vaga = novaVaga();
  novaCandidatura({ jobId: vaga, telefone: telefone(), status: null });
  novaCandidatura({ jobId: vaga, telefone: telefone(), status: '' });

  assert.equal(montarPublicoMassaWa({ statusList: ['sem_decisao'] }).funil.total, 2);
  // E quando sem_decisao NAO esta marcado, os dois saem — nenhum "escapa" por ser NULL.
  const semEle = montarPublicoMassaWa({ statusList: ['aprovado'] });
  assert.equal(semEle.funil.total, 0);
  assert.equal(semEle.funil.porStatusExcluido.sem_decisao, 2);
});

test('O CASO IN(...) SEM NULL: um filtro em SQL teria perdido a maior parte da base', () => {
  // Este e o teste que o filtro existe para nao errar. `status_recrutador IN ('sem_decisao')`
  // no SQL nao casaria com NENHUMA destas linhas: NULL nunca casa com IN, e '' tampouco casa
  // com a string 'sem_decisao'. O resultado seria um publico de 1 pessoa (a em_analise) num
  // universo de 5 — e ninguem investiga um numero que parece plausivel.
  limpar();
  const vaga = novaVaga();
  novaCandidatura({ jobId: vaga, telefone: telefone(), status: null });
  novaCandidatura({ jobId: vaga, telefone: telefone(), status: null });
  novaCandidatura({ jobId: vaga, telefone: telefone(), status: '' });
  novaCandidatura({ jobId: vaga, telefone: telefone(), status: 'em_analise' });
  novaCandidatura({ jobId: vaga, telefone: telefone(), status: 'aprovado' });

  const r = montarPublicoMassaWa({ statusList: ['sem_decisao', 'em_analise'] });
  assert.equal(r.funil.candidaturas, 5);
  assert.equal(r.funil.total, 4, 'as 3 sem decisao (2 NULL + 1 vazia) + a em_analise');
  assert.equal(r.funil.candidaturasExcluidasStatus, 1);
  assert.equal(r.funil.porStatusExcluido.aprovado, 1);
});

test('aprovado e reprovado ficam fora por padrao, e entram quando marcados', () => {
  limpar();
  const vaga = novaVaga();
  novaCandidatura({ jobId: vaga, telefone: telefone(), status: null });
  novaCandidatura({ jobId: vaga, telefone: telefone(), status: 'aprovado' });
  novaCandidatura({ jobId: vaga, telefone: telefone(), status: 'reprovado' });

  const padrao = montarPublicoMassaWa({});
  assert.equal(padrao.funil.total, 1);
  assert.equal(padrao.funil.porStatusExcluido.aprovado, 1);
  assert.equal(padrao.funil.porStatusExcluido.reprovado, 1);

  // Marcados de propria escolha do operador: entram.
  const comTodos = montarPublicoMassaWa({
    statusList: ['sem_decisao', 'em_analise', 'aprovado', 'reprovado'],
  });
  assert.equal(comTodos.funil.total, 3);
  assert.equal(comTodos.funil.candidaturasExcluidasStatus, 0);
});

test('grafia variada do status colapsa no canonico ("Em Análise", "em-analise", "EM_ANALISE")', () => {
  limpar();
  const vaga = novaVaga();
  for (const grafia of ['Em Análise', 'em-analise', 'EM_ANALISE', '  em_analise  ']) {
    novaCandidatura({ jobId: vaga, telefone: telefone(), status: grafia });
  }

  assert.equal(montarPublicoMassaWa({ statusList: ['em_analise'] }).funil.total, 4);
});

test('status corrompido cai em "desconhecido" e fica FORA (lado seguro do erro)', () => {
  limpar();
  const vaga = novaVaga();
  novaCandidatura({ jobId: vaga, telefone: telefone(), status: 'contratado_talvez' });
  novaCandidatura({ jobId: vaga, telefone: telefone(), status: null });

  const r = montarPublicoMassaWa({ statusList: ['sem_decisao', 'em_analise', 'aprovado', 'reprovado'] });
  assert.equal(r.funil.total, 1, 'nem marcando os quatro o desconhecido entra');
  assert.equal(r.funil.porStatusExcluido.desconhecido, 1);
});

// ══════════════════ TELEFONE E DEDUPE ══════════════════

test('telefone com DDI duplicado nao sobrevive a ida e volta e fica fora', () => {
  // O incidente real (application 336): "+55 +5547988301250" cabe no teto de digitos e
  // passaria numa checagem isolada, mas nao sobrevive ao round-trip. FAIL CLOSED.
  limpar();
  const vaga = novaVaga();
  novaCandidatura({ jobId: vaga, telefone: '+55 +5547988301250' });
  novaCandidatura({ jobId: vaga, telefone: telefone() });

  const r = montarPublicoMassaWa({});
  assert.equal(r.funil.candidaturasSemTelefoneUtil, 1);
  assert.equal(r.funil.total, 1);
});

test('DEDUPE CANONICO: a mesma pessoa com e sem o nono digito entra UMA vez', () => {
  // A garantia mais importante do subsistema, e onde este motor divergem dos outros dois: eles
  // deduplicam por telefone normalizado, e os dois numeros abaixo normalizam DIFERENTE.
  limpar();
  const vaga = novaVaga();
  // O formato e o da COLUNA: input do formulario, que prefixa '+55 '. Um valor cru de 13
  // digitos sem '+' nao sobrevive ao round-trip (normalizarTelefoneWhatsapp prefixa 55 de
  // novo) e cairia em candidaturasSemTelefoneUtil — comportamento identico nos outros dois
  // motores, porque a guarda e a mesma funcao.
  novaCandidatura({ jobId: vaga, telefone: '+55 31 99682-0290', nome: 'Ana com 9' });
  novaCandidatura({ jobId: vaga, telefone: '+55 31 9682-0290', nome: 'Ana sem 9' });

  const r = montarPublicoMassaWa({});
  assert.equal(r.funil.pessoas, 1);
  assert.equal(r.funil.candidaturasDuplicadas, 1);
  assert.equal(r.funil.total, 1);
  assert.equal(r.itens[0].telefoneCanonico, '553196820290');
});

test('duas candidaturas da MESMA pessoa a vagas abertas diferentes: uma linha', () => {
  limpar();
  const a = novaVaga();
  const b = novaVaga();
  const tel = telefone();
  novaCandidatura({ jobId: a, telefone: tel });
  novaCandidatura({ jobId: b, telefone: tel });

  const r = montarPublicoMassaWa({});
  assert.equal(r.funil.total, 1);
  assert.equal(r.funil.candidaturasDuplicadas, 1);
});

test('a candidatura MAIS RECENTE representa a pessoa (a vaga dela da contexto a mensagem)', () => {
  // A vaga escolhida aqui e a que vai fornecer a entrevista em grupo no envio. Escolher a
  // candidatura antiga anunciaria a reuniao de uma vaga que a pessoa deixou para tras.
  limpar();
  const antiga = novaVaga();
  const recente = novaVaga();
  const tel = telefone();
  novaCandidatura({ jobId: antiga, telefone: tel, criadoEm: '2026-01-01 10:00:00' });
  novaCandidatura({ jobId: recente, telefone: tel, criadoEm: '2026-09-01 10:00:00' });

  const r = montarPublicoMassaWa({});
  assert.equal(r.itens[0].jobId, recente);
});

test('o item sai no formato que materializarCampanhaMassaWa espera', () => {
  limpar();
  const vaga = novaVaga();
  const appId = novaCandidatura({ jobId: vaga, telefone: '47999582500', nome: '  Maria Souza  ' });

  const [item] = montarPublicoMassaWa({}).itens;
  assert.deepEqual(Object.keys(item).sort(), [
    'applicationId', 'jobId', 'jobTitulo', 'nome', 'telefone', 'telefoneCanonico',
  ]);
  assert.equal(item.telefone, '5547999582500', 'normalizado, com DDI, sem +');
  assert.equal(item.telefoneCanonico, '554799582500', 'DDI + DDD + ultimos 8 digitos');
  assert.equal(item.nome, 'Maria Souza');
  assert.equal(item.applicationId, appId);
  assert.equal(item.jobId, vaga);

  // Prova de contrato: o que sai daqui entra na fila sem adaptador.
  const campanhaId = db.criarCampanhaMassaWa({ nome: 'C' });
  assert.equal(db.materializarCampanhaMassaWa(campanhaId, [item]), 1);
});

// ══════════════════ OPT-OUT: AS DUAS TABELAS ══════════════════

test('opt-out de escopo campanha (tabela nova) suprime', () => {
  limpar();
  const vaga = novaVaga();
  const tel = telefone();
  novaCandidatura({ jobId: vaga, telefone: tel });
  novaCandidatura({ jobId: vaga, telefone: telefone() });
  db.registrarWhatsappOptout({ telefone: `55${tel}`, escopo: 'campanha', origem: 'manual' });

  const r = montarPublicoMassaWa({});
  assert.equal(r.funil.pessoasOptoutCampanha, 1);
  assert.equal(r.funil.total, 1);
});

test('opt-out TOTAL tambem suprime (campanha e o escopo consultado)', () => {
  limpar();
  const vaga = novaVaga();
  const tel = telefone();
  novaCandidatura({ jobId: vaga, telefone: tel });
  db.registrarWhatsappOptout({ telefone: `55${tel}`, escopo: 'total', origem: 'manual' });

  assert.equal(montarPublicoMassaWa({}).funil.total, 0);
});

test('opt-out pelo OUTRO numero da mesma pessoa suprime (a chave e canonica)', () => {
  // Pediu para sair pelo numero sem o 9 e esta na base com o 9: continuar mandando seria
  // exatamente o "eu pedi e voces ignoraram" que a chave canonica existe para impedir.
  limpar();
  const vaga = novaVaga();
  novaCandidatura({ jobId: vaga, telefone: '+55 31 99682-0290' });
  db.registrarWhatsappOptout({ telefone: '553196820290', escopo: 'campanha', origem: 'resposta' });

  assert.equal(montarPublicoMassaWa({}).funil.total, 0);
});

test('opt-out REVOGADO volta a receber', () => {
  limpar();
  const vaga = novaVaga();
  const tel = telefone();
  novaCandidatura({ jobId: vaga, telefone: tel });
  db.registrarWhatsappOptout({ telefone: `55${tel}`, escopo: 'campanha', origem: 'manual' });
  assert.equal(montarPublicoMassaWa({}).funil.total, 0);

  db.revogarWhatsappOptout(`55${tel}`);
  assert.equal(montarPublicoMassaWa({}).funil.total, 1);
});

test('a tabela ANTIGA (whatsapp_opt_out, sem escopo) tambem suprime', () => {
  // Diferente da sequencia WA1/WA2, que deliberadamente NAO le esta tabela. Aqui e o lado
  // certo: tudo o que este motor manda e oferta, entao uma supressao a mais nunca e risco.
  limpar();
  const vaga = novaVaga();
  const tel = telefone();
  novaCandidatura({ jobId: vaga, telefone: tel });
  novaCandidatura({ jobId: vaga, telefone: telefone() });
  db.registrarOptOutWhatsapp(`55${tel}`, 'manual');

  const r = montarPublicoMassaWa({});
  assert.equal(r.funil.pessoasOptoutAntigo, 1);
  assert.equal(r.funil.total, 1);
});

test('kill-switch do opt-out desligado: a tabela NOVA para de suprimir, a antiga continua', () => {
  // Contrato de mapaOptoutAtivo (mapa vazio com o switch off). A tabela antiga nao passa pelo
  // kill-switch — e o comportamento dos outros motores tambem.
  limpar();
  const vaga = novaVaga();
  const telNovo = telefone();
  const telAntigo = telefone();
  novaCandidatura({ jobId: vaga, telefone: telNovo });
  novaCandidatura({ jobId: vaga, telefone: telAntigo });
  db.registrarWhatsappOptout({ telefone: `55${telNovo}`, escopo: 'campanha', origem: 'manual' });
  db.registrarOptOutWhatsapp(`55${telAntigo}`, 'manual');

  db.definirConfigBool('optout_whatsapp_ativo', false);
  try {
    const r = montarPublicoMassaWa({});
    assert.equal(r.funil.pessoasOptoutCampanha, 0);
    assert.equal(r.funil.pessoasOptoutAntigo, 1);
    assert.equal(r.funil.total, 1);
  } finally {
    db.definirConfigBool('optout_whatsapp_ativo', true);
  }
});

// ══════════════════ FUNIL ABERTO (a previa) ══════════════════

test('o funil explica cada exclusao, e as unidades fecham', () => {
  limpar();
  const vaga = novaVaga();
  const telDup = telefone();
  const telOptout = telefone();

  novaCandidatura({ jobId: vaga, telefone: telefone(), status: null });          // entra
  novaCandidatura({ jobId: vaga, telefone: telefone(), status: 'em_analise' });  // entra
  novaCandidatura({ jobId: vaga, telefone: telDup, status: null });              // entra
  novaCandidatura({ jobId: vaga, telefone: telDup, status: null });              // duplicada
  novaCandidatura({ jobId: vaga, telefone: telefone(), status: 'aprovado' });    // status
  novaCandidatura({ jobId: vaga, telefone: '+55 +5547988301250', status: null }); // telefone
  novaCandidatura({ jobId: vaga, telefone: telOptout, status: null });           // opt-out
  db.registrarWhatsappOptout({ telefone: `55${telOptout}`, escopo: 'campanha', origem: 'manual' });

  const { funil } = montarPublicoMassaWa({});

  assert.equal(funil.candidaturas, 7);
  assert.equal(funil.candidaturasExcluidasStatus, 1);
  assert.equal(funil.candidaturasSemTelefoneUtil, 1);
  assert.equal(funil.candidaturasDuplicadas, 1);
  assert.equal(funil.pessoas, 4, 'candidaturas - status - telefone - duplicada');
  assert.equal(funil.pessoasOptoutCampanha, 1);
  assert.equal(funil.pessoasOptoutAntigo, 0);
  assert.equal(funil.total, 3);

  // As contas que a tela vai imprimir precisam fechar nas duas unidades.
  assert.equal(
    funil.candidaturas
      - funil.candidaturasExcluidasStatus
      - funil.candidaturasSemTelefoneUtil
      - funil.candidaturasDuplicadas,
    funil.pessoas,
  );
  assert.equal(funil.pessoas - funil.pessoasOptoutCampanha - funil.pessoasOptoutAntigo, funil.total);
});

test('base vazia devolve funil zerado, sem lancar', () => {
  limpar();
  const r = montarPublicoMassaWa({});
  assert.deepEqual(r.itens, []);
  assert.equal(r.funil.candidaturas, 0);
  assert.equal(r.funil.total, 0);
});

test('montarPublicoMassaWa nao fala com o WhatsApp (nenhuma dependencia de socket)', () => {
  // A checagem de existencia foi deliberadamente tirada daqui: consultar milhares de numeros
  // de uma vez e, ela mesma, um sinal de conta suspeita. Quem nao existe vira 'sem_whatsapp'
  // no envio (B4). Este teste trava a decisao — se alguem injetar o socket aqui, ele quebra.
  const fonte = require('node:fs').readFileSync(
    require.resolve('../src/lib/publicoMassaWhatsapp'),
    'utf8',
  );
  assert.doesNotMatch(fonte, /whatsapp\/connection/);
  assert.doesNotMatch(fonte, /onWhatsAppLote/);
  assert.doesNotMatch(fonte, /verificarExisteWhatsapp/);
});

test('o statusList saneado volta no resultado (a campanha grava o que foi realmente usado)', () => {
  limpar();
  novaVaga();
  const r = montarPublicoMassaWa({ statusList: ['aprovado', 'lixo', 'aprovado'] });
  assert.deepEqual(r.statusList, ['aprovado']);
});
