'use strict';

// Motor de publico do disparo por WhatsApp (src/lib/publicoDisparoWhatsapp.js).
//
// ── O QUE ESTA EM JOGO ──
// Este arquivo decide quem recebe mensagem no WhatsApp — canal mais invasivo que e-mail,
// sem opt-out implementado nesta etapa, e sem despublicar. Os dois erros possiveis nao sao
// simetricos:
//
//   falso NEGATIVO  alguem fica de fora do grupo. Custa uma pessoa, e e corrigivel.
//   falso POSITIVO  alguem recebe duas vezes, ou recebe sem ser da praca. Custa confianca,
//                   e nao ha desfazer.
//
// Por isso a maioria das assercoes abaixo verifica EXCLUSAO, e nao inclusao.

const os = require('node:os');
const path = require('node:path');

process.env.DATABASE_PATH = path.join(os.tmpdir(), `vm-test-disparo-wpp-${process.pid}-${Date.now()}.db`);
process.env.INTERVIEW_MOCK = 'true';
process.env.SESSION_SECRET = 'segredo-de-teste';
process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert/strict');

const db = require('../src/db');
const { migrar } = require('../src/db/migrate');
const { listarPendentesPorCidade } = require('../src/lib/publicoDisparoWhatsapp');
const { normalizarTelefoneRecebido } = require('../src/lib/whatsapp');

// O guard de ida e volta emite console.warn por registro excluido — legitimo em producao,
// ruido aqui. Silencia so durante a chamada, e sempre restaura.
function semRuido(fn) {
  const warn = console.warn;
  console.warn = () => {};
  try { return fn(); } finally { console.warn = warn; }
}

migrar();

const run = (sql, ...p) => Number(db.getDb().prepare(sql).run(...p).lastInsertRowid);
const exec = (sql, ...p) => db.getDb().prepare(sql).run(...p);

let seq = 0;

function criarVaga(cidade, perfil = 'CLOSER') {
  seq += 1;
  return run(
    'INSERT INTO jobs (slug, titulo, perfil, cidade, ativo) VALUES (?, ?, ?, ?, 1)',
    `vaga-wpp-${seq}`,
    `Vaga ${seq}`,
    perfil,
    cidade,
  );
}

function criarCandidatura(jobId, nome, telefone) {
  seq += 1;
  return run(
    'INSERT INTO applications (job_id, nome, telefone, token) VALUES (?, ?, ?, ?)',
    jobId,
    nome,
    telefone,
    `tok-wpp-${seq}`,
  );
}

function criarLegado(nome, telefone, cidade, cargo = 'Consultor Comercial') {
  seq += 1;
  return run(
    "INSERT INTO talentos (nome, email, telefone, cidade, cargo, categoria) VALUES (?, ?, ?, ?, ?, 'legado')",
    nome,
    `legado-${seq}@exemplo.com`,
    telefone,
    cidade,
    cargo,
  );
}

function zerar() {
  exec('DELETE FROM disparos_whatsapp');
  exec('DELETE FROM applications');
  exec('DELETE FROM talentos');
  exec('DELETE FROM jobs');
}

const telefonesDe = (lista) => lista.map((p) => p.telefone).sort();

// ══════════════════ Validacao da praca ══════════════════

test('cidade invalida LANCA, em vez de devolver lista vazia', () => {
  zerar();
  // Devolver [] silenciosamente faria um disparo vazio parecer um disparo concluido — e
  // ninguem investiga um zero que parece legitimo. O erro precisa ser barulhento no unico
  // momento em que da para consertar: antes de rodar.
  for (const ruim of ['Blumenau', 'Joinvile', 'Joinville/SC', '', null, undefined, 123]) {
    assert.throws(() => listarPendentesPorCidade(ruim), /Cidade invalida/, String(ruim));
  }
});

test('cidade valida com grafia solta e aceita e normalizada', () => {
  zerar();
  const vaga = criarVaga('São Paulo');
  criarCandidatura(vaga, 'Ana Silva', '+55 (11) 99999-1111');
  // "sao paulo" chega do n8n ou de uma query string; normalizarCidade resolve.
  assert.equal(listarPendentesPorCidade('sao paulo').length, 1);
});

// ══════════════════ Origem: candidatos (cidade vem da VAGA) ══════════════════

test('candidato entra pela cidade da VAGA, com cargo = jobs.perfil', () => {
  zerar();
  const vaga = criarVaga('Joinville', 'SDR');
  criarCandidatura(vaga, 'Bruno Costa', '+55 (47) 99958-2500');

  assert.deepEqual(listarPendentesPorCidade('Joinville'), [
    { telefone: '5547999582500', nome_primeiro: 'Bruno', cargo: 'SDR' },
  ]);
});

test('vaga REMOTA (cidade NULL) nao aparece em praca nenhuma', () => {
  zerar();
  const remota = criarVaga(null);
  criarCandidatura(remota, 'Carla Dias', '+55 (47) 99958-2501');
  // NULL nao e igual a nada em SQL, e tambem nao e uma praca valida de busca. Os candidatos
  // de vaga remota ficam fora de TODO disparo regional — por definicao, nao por falta de
  // dado.
  for (const c of ['Joinville', 'São Paulo', 'Campinas']) {
    assert.deepEqual(listarPendentesPorCidade(c), [], c);
  }
});

test('candidato de outra praca nao vaza para a praca pedida', () => {
  zerar();
  criarCandidatura(criarVaga('Campinas'), 'Diego', '+55 (19) 99999-2222');
  criarCandidatura(criarVaga('Joinville'), 'Elisa', '+55 (47) 99999-3333');

  assert.deepEqual(telefonesDe(listarPendentesPorCidade('Campinas')), ['5519999992222']);
  assert.deepEqual(telefonesDe(listarPendentesPorCidade('Joinville')), ['5547999993333']);
});

test('telefone inutilizavel nao vira convite', () => {
  zerar();
  const vaga = criarVaga('Curitiba');
  criarCandidatura(vaga, 'Fabio', '123');           // curto demais
  criarCandidatura(vaga, 'Gabi', 'nao tenho');      // sem digitos
  criarCandidatura(vaga, 'Hugo', '+55 41 99999-4444'); // ok
  assert.deepEqual(telefonesDe(listarPendentesPorCidade('Curitiba')), ['5541999994444']);
});

// ══════════════════ Origem: legado (cidade e da PESSOA) ══════════════════

test('legado entra pela cidade da PESSOA, com cargo = talentos.cargo cru', () => {
  zerar();
  criarLegado('Igor Santos', '+55 47 98925-1350', 'Joinville', 'Liderança Comercial');

  assert.deepEqual(listarPendentesPorCidade('Joinville'), [
    { telefone: '5547989251350', nome_primeiro: 'Igor', cargo: 'Liderança Comercial' },
  ]);
});

test('cargo do legado NAO e mapeado para o enum SDR|CLOSER', () => {
  zerar();
  // Sao 6 valores na base antiga e so 2 mapeariam no enum. Forcar o mapeamento faria 4
  // grupos receberem um cargo que ninguem escreveu.
  const cargos = ['Consultor Comercial', 'Vendedor', 'BDR', 'Closer'];
  cargos.forEach((c, i) => criarLegado(`P${i}`, `+55 47 9000-000${i}`, 'Tijucas', c));
  const obtidos = listarPendentesPorCidade('Tijucas').map((p) => p.cargo).sort();
  assert.deepEqual(obtidos, [...cargos].sort());
});

test("o sentinela 'Todas as cidades' NUNCA entra em disparo", () => {
  zerar();
  criarLegado('Julia', '+55 47 99999-5555', 'Todas as cidades');
  criarLegado('Karla', '+55 47 99999-6666', 'Joinville');

  // No motor de E-MAIL o sentinela casa com qualquer selecao — la ele amplia o publico de
  // proposito. Aqui e o oposto: o grupo e de UMA praca, e "presente em qualquer praca" nao
  // diz em QUAL. Nos nove grupos seria a leitura literal e o pior resultado; num grupo
  // escolhido a esmo, seria adivinhacao.
  for (const c of ['Joinville', 'São Paulo', 'Campinas', 'Curitiba', 'Barueri']) {
    assert.equal(
      listarPendentesPorCidade(c).some((p) => p.telefone === '5547999995555'),
      false,
      `o sentinela vazou para ${c}`,
    );
  }
  assert.deepEqual(telefonesDe(listarPendentesPorCidade('Joinville')), ['5547999996666']);
});

test('talento de cadastro proprio (categoria NULL) nao entra', () => {
  zerar();
  run(
    "INSERT INTO talentos (nome, email, telefone, cidade, cargo) VALUES ('Livia','l@x.co','+55 47 99999-7777','Joinville','Vendedor')",
  );
  // O recorte e explicitamente categoria='legado'. Cadastro proprio tem outra finalidade
  // LGPD e nao foi importado com essa expectativa.
  assert.deepEqual(listarPendentesPorCidade('Joinville'), []);
});

// ══════════════════ Merge e precedencia ══════════════════

test('mesmo telefone nas duas origens: CANDIDATO vence', () => {
  zerar();
  const vaga = criarVaga('Joinville', 'CLOSER');
  criarCandidatura(vaga, 'Marcos Andrade', '+55 (47) 99958-2500');
  criarLegado('Marcos A. Antigo', '+55 47 999582500', 'Joinville', 'Vendedor');

  const lista = listarPendentesPorCidade('Joinville');
  assert.equal(lista.length, 1, 'a mesma pessoa nao pode aparecer duas vezes');
  // Nome e cargo vem de applications/jobs: o contexto VIVO (a vaga a que ela se candidatou)
  // vence o cadastro antigo.
  assert.deepEqual(lista[0], {
    telefone: '5547999582500',
    nome_primeiro: 'Marcos',
    cargo: 'CLOSER',
  });
});

test('dedup vale para formatos diferentes do MESMO numero', () => {
  zerar();
  const vaga = criarVaga('Joinville');
  // As duas mascaras que existem em producao (applications usa parenteses, talentos nao).
  criarCandidatura(vaga, 'Nina', '+55 (47) 99958-2500');
  criarLegado('Nina Legado', '+55 47999582500', 'Joinville');
  assert.equal(listarPendentesPorCidade('Joinville').length, 1);
});

test('duas candidaturas da mesma pessoa na praca contam uma vez', () => {
  zerar();
  const a = criarVaga('Joinville', 'SDR');
  const b = criarVaga('Joinville', 'CLOSER');
  criarCandidatura(a, 'Otavio', '+55 47 99958-2500');
  criarCandidatura(b, 'Otavio', '+55 47 99958-2500');

  const lista = listarPendentesPorCidade('Joinville');
  assert.equal(lista.length, 1);
  // A mais antiga vence — arbitrario, mas ESTAVEL: sem ordem definida, duas execucoes
  // seguidas poderiam mandar cargos diferentes para a mesma pessoa.
  assert.equal(lista[0].cargo, 'SDR');
});

// ══════════════════ Exclusao de quem ja recebeu ══════════════════

test('quem tem linha em disparos_whatsapp sai da fila', () => {
  zerar();
  const vaga = criarVaga('Joinville');
  criarCandidatura(vaga, 'Paula', '+55 47 99958-2500');
  criarCandidatura(vaga, 'Quim', '+55 47 99958-2501');

  assert.equal(listarPendentesPorCidade('Joinville').length, 2);

  db.registrarDisparoWhatsapp({
    telefone: '5547999582500',
    nome: 'Paula',
    status: 'enviado',
    origem: 'candidato',
    cidade: 'Joinville',
  });

  assert.deepEqual(telefonesDe(listarPendentesPorCidade('Joinville')), ['5547999582501']);
});

test("status 'erro' tambem segura o telefone", () => {
  zerar();
  criarCandidatura(criarVaga('Joinville'), 'Rita', '+55 47 99958-2500');
  db.registrarDisparoWhatsapp({
    telefone: '5547999582500',
    status: 'erro',
    erroMsg: 'numero invalido no provedor',
  });
  // Reprocessar erro e decisao humana, nao automatica — mesma disciplina de
  // marcarEnvioCampanhaFalha no e-mail.
  assert.deepEqual(listarPendentesPorCidade('Joinville'), []);
});

test('convite ja entregue em OUTRA praca nao vira um segundo convite', () => {
  zerar();
  criarLegado('Sonia', '+55 47 99958-2500', 'Joinville');
  db.registrarDisparoWhatsapp({
    telefone: '5547999582500',
    status: 'enviado',
    origem: 'candidato',
    cidade: 'São Paulo',
  });
  // A exclusao e por TELEFONE, sem filtro de cidade: a pessoa ja esta num grupo.
  assert.deepEqual(listarPendentesPorCidade('Joinville'), []);
});

test('a exclusao compara TELEFONE NORMALIZADO dos dois lados', () => {
  zerar();
  criarCandidatura(criarVaga('Joinville'), 'Tiago', '+55 (47) 99958-2500');
  // A coluna guarda normalizado por contrato. Se o filtro rodasse em SQL contra a coluna
  // crua de applications, nunca casaria — e falharia ABERTO, reenviando para todo mundo.
  db.registrarDisparoWhatsapp({ telefone: '5547999582500', status: 'enviado' });
  assert.deepEqual(listarPendentesPorCidade('Joinville'), []);
});

// ══════════════════ Upsert do livro-razao ══════════════════

test('upsert preserva id e criado_em, e atualiza a tentativa', () => {
  zerar();
  db.registrarDisparoWhatsapp({
    telefone: '5547999582500',
    nome: 'Ursula',
    status: 'erro',
    erroMsg: 'timeout',
    origem: 'candidato',
    cidade: 'Joinville',
  });
  const antes = db.getDb().prepare('SELECT * FROM disparos_whatsapp').get();

  db.registrarDisparoWhatsapp({ telefone: '5547999582500', status: 'enviado' });
  const depois = db.getDb().prepare('SELECT * FROM disparos_whatsapp').get();

  // ON CONFLICT DO UPDATE, e nao INSERT OR REPLACE: o REPLACE apagaria a linha e trocaria
  // id/criado_em, perdendo quando a pessoa entrou no livro-razao pela primeira vez.
  assert.equal(depois.id, antes.id);
  assert.equal(depois.criado_em, antes.criado_em);
  assert.equal(depois.status, 'enviado');
  // erro_msg e sobrescrito SEMPRE: descreve a tentativa ATUAL. Deixar "timeout" colado numa
  // linha 'enviado' faria o painel mostrar um erro que nao existe mais.
  assert.equal(depois.erro_msg, null);
  // Ja o CONTEXTO sobrevive: uma chamada que so manda {telefone, status} nao pode apagar o
  // nome e a praca que o disparo anterior gravou.
  assert.equal(depois.nome, 'Ursula');
  assert.equal(depois.cidade, 'Joinville');
  assert.equal(depois.origem, 'candidato');
});

test('uma linha por telefone, quantas vezes rodar', () => {
  zerar();
  for (let i = 0; i < 3; i += 1) {
    db.registrarDisparoWhatsapp({ telefone: '5547999582500', status: 'enviado' });
  }
  assert.equal(db.getDb().prepare('SELECT COUNT(*) n FROM disparos_whatsapp').get().n, 1);
});

// ══════════════════ Cenario completo ══════════════════

test('praca com as duas origens, sobreposicao e ja-enviados', () => {
  zerar();
  const vaga = criarVaga('Joinville', 'CLOSER');
  criarCandidatura(vaga, 'Ana Paula', '+55 47 90000-0001');
  criarCandidatura(vaga, 'Bruno', '+55 47 90000-0002');
  criarLegado('Bruno Antigo', '+55 47 900000002', 'Joinville', 'Vendedor'); // sobreposto
  criarLegado('Carlos', '+55 47 90000-0003', 'Joinville', 'BDR');
  criarLegado('Diana', '+55 47 90000-0004', 'Todas as cidades');            // sentinela
  criarLegado('Elena', '+55 47 90000-0005', 'Campinas');                    // outra praca
  criarCandidatura(criarVaga(null), 'Felipe', '+55 47 90000-0006');         // remota
  db.registrarDisparoWhatsapp({ telefone: '5547900000001', status: 'enviado' }); // ja foi

  const lista = listarPendentesPorCidade('Joinville');
  assert.deepEqual(telefonesDe(lista), ['5547900000002', '5547900000003']);
  // Bruno aparece com os dados de CANDIDATO, nao de legado.
  const bruno = lista.find((p) => p.telefone === '5547900000002');
  assert.deepEqual(bruno, { telefone: '5547900000002', nome_primeiro: 'Bruno', cargo: 'CLOSER' });
});

// ══════════════════ Contrato de ida e volta do telefone ══════════════════
//
// INCIDENTE REAL (primeiro disparo, Joinville): o item 11 saiu da API como
// "555547988301250" — DDI 55 duplicado. A Meta aceitou e enviou (corrigindo o numero por
// conta propria), mas o POST /marcar-status rejeitou o MESMO valor, e o disparo travou no
// meio: mensagem entregue, nada registrado, e a pessoa de volta na fila para receber outra
// vez no ciclo seguinte.
//
// A causa nao e o normalizador — e o dado: o banco guarda literalmente
// "+55 +5547988301250", porque o seletor de DDI do formulario prefixa "+55 " e a pessoa
// digitou o numero ja com +55. Sao 48 registros assim em producao.

test('telefone com DDI duplicado NAO entra na fila', () => {
  zerar();
  const vaga = criarVaga('Joinville');
  // Exatamente o valor bruto que quebrou o disparo (applications id 355 em producao).
  criarCandidatura(vaga, 'Silvana', '+55 +5547988301250');
  criarCandidatura(vaga, 'Sadia', '+55 (47) 99958-2500');

  const lista = semRuido(() => listarPendentesPorCidade('Joinville'));
  // Fail CLOSED: quem o proprio sistema nao consegue registrar de volta nao recebe mensagem.
  assert.deepEqual(telefonesDe(lista), ['5547999582500']);
});

test('o mesmo vale para o legado', () => {
  zerar();
  criarLegado('Cindel', '+55 +5547992551100', 'Joinville');
  criarLegado('Valida', '+55 47 99958-2500', 'Joinville');
  assert.deepEqual(telefonesDe(semRuido(() => listarPendentesPorCidade('Joinville'))), ['5547999582500']);
});

test('todo telefone devolvido sobrevive a volta pela fronteira da API', () => {
  // A invariante que fecha o ciclo: qualquer item da lista pode ser marcado de volta sem
  // 400. E o teste que, se tivesse existido antes, teria pego o incidente.
  zerar();
  const vaga = criarVaga('Joinville');
  criarCandidatura(vaga, 'A', '+55 +5547988301250');   // 15 digitos
  criarCandidatura(vaga, 'B', '+55 119972122344');     // 14 digitos
  criarCandidatura(vaga, 'C', '+55 (47) 99958-2500');  // ok
  criarLegado('D', '+55 55479925511', 'Joinville');    // 13 digitos, DDD 55 (RS) — VALIDO

  for (const p of semRuido(() => listarPendentesPorCidade('Joinville'))) {
    assert.equal(
      normalizarTelefoneRecebido(p.telefone),
      p.telefone,
      `${p.telefone} nao sobrevive a ida e volta`,
    );
  }
});

test('DDD 55 (Rio Grande do Sul) NAO e confundido com DDI duplicado', () => {
  // "5555..." com 13 digitos e DDI(55) + DDD(55) + 9 digitos — numero legitimo. Sao 37 em
  // producao. Uma regra que barrasse por prefixo "5555" cortaria todos eles do disparo.
  zerar();
  criarLegado('Gaucho', '+55 55987711950', 'Joinville');
  const lista = semRuido(() => listarPendentesPorCidade('Joinville'));
  assert.deepEqual(telefonesDe(lista), ['5555987711950']);
  assert.equal(normalizarTelefoneRecebido('5555987711950'), '5555987711950');
});
