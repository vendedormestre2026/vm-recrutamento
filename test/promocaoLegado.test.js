'use strict';

// Elegibilidade de campanha dos talentos da BASE LEGADA.
//
// ── POR QUE UM ARQUIVO PROPRIO, se promocaoVagas.test.js ja passa ──
// A cobertura que existe hoje e INCIDENTAL. O teste "talento SEM candidatura entra
// normalmente" usa o helper `criarTalento({ email })`, cujo default de perfil_interesse e
// null — entao ele de fato prova que talento sem perfil entra no publico padrao, mas o
// nome, a intencao e as assercoes daquele teste sao sobre `origemTipo`. Quem o ler nao
// descobre que essa garantia esta ali, e quem o alterar nao sabe que a esta removendo.
//
// Aqui a garantia e o ASSUNTO, e o cenario e o de producao: 7.215 talentos com
// categoria='legado' e cargo preenchido, dos quais 6.006 com perfil_interesse NULL porque
// o cargo deles (Consultor Comercial, Vendedor, BDR, Lideranca Comercial) nao cabe no
// CHECK SDR|CLOSER daquela coluna.
//
// ── O QUE ISTO PROTEGE, concretamente ──
// `categoria` e uma coluna NOVA em `talentos`, e listarTalentosParaCampanha faz
// `SELECT ... FROM talentos WHERE ...`. Um WHERE mal colocado ali — ou um filtro de
// categoria copiado da tela para o motor de campanha "por simetria" — derrubaria 7.215
// pessoas do publico sem quebrar nenhum outro teste, porque nenhum outro sabe que a coluna
// existe. O sintoma seria uma campanha que sai para 90 pessoas em vez de 7.215, e ninguem
// perceberia ate conferir o numero na tela de previa.
//
// NENHUMA REDE: banco temporario, mesmo molde de promocaoVagas.test.js.

const os = require('node:os');
const path = require('node:path');

process.env.DATABASE_PATH = path.join(os.tmpdir(), `vm-test-promocao-legado-${process.pid}-${Date.now()}.db`);
process.env.INTERVIEW_MOCK = 'true';
process.env.SESSION_SECRET = 'segredo-de-teste';
process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert/strict');

const db = require('../src/db');
const { migrar } = require('../src/db/migrate');
const promocao = require('../src/lib/promocaoVagas');

migrar();

const run = (sql, ...p) => Number(db.getDb().prepare(sql).run(...p).lastInsertRowid);

let seq = 0;

function criarVaga(perfil, titulo) {
  seq += 1;
  return run(
    'INSERT INTO jobs (slug, titulo, perfil) VALUES (?, ?, ?)',
    `vaga-legado-${seq}`,
    titulo,
    perfil,
  );
}

function criarCandidatura({ jobId, email, nome = 'Fulano' }) {
  seq += 1;
  return run(
    `INSERT INTO applications (job_id, token, nome, sobrenome, email, utm_source)
     VALUES (?, ?, ?, 'Silva', ?, 'meta-ads')`,
    jobId,
    `tok-legado-${seq}`,
    nome,
    email,
  );
}

// Talento legado EXATAMENTE como a importacao o grava: categoria 'legado', cargo
// preenchido, consent_at NULL, criado_em da origem, e perfil_interesse null quando o
// cargo nao mapeia. Usa a MESMA funcao de producao (db.criarTalentosLegado), e nao um
// INSERT cru — se a insercao mudar, este teste muda junto.
function criarTalentoLegado({ email, cargo = 'Vendedor', perfil = null, nome = 'Pessoa Legada' }) {
  db.criarTalentosLegado([
    {
      nome,
      email,
      telefone: '+55 47989251350',
      perfil_interesse: perfil,
      categoria: 'legado',
      cargo,
      campos_extras: JSON.stringify({ empresa_origem: 'Godi Transportes' }),
      consent_at: null,
      criado_em: '2025-09-29 03:04:27',
    },
  ]);
}

const emails = (r) => r.itens.map((i) => i.email).sort();

const vagaAlvo = criarVaga('CLOSER', 'Vaga Alvo');
const vagaOutra = criarVaga('CLOSER', 'Outra Vaga');

// ══════════════════════════════════════════════════════════════
// 1. O cenario dos 6.006: legado com perfil_interesse NULL
// ══════════════════════════════════════════════════════════════

test('legado com perfil NULL ENTRA no publico quando nao ha filtro de perfil', () => {
  // A garantia central desta importacao. Se ela cair, a campanha para a qual os 7.215
  // foram importados simplesmente nao os alcanca.
  const email = 'legado-sem-perfil@exemplo.com';
  criarTalentoLegado({ email, cargo: 'Consultor Comercial', perfil: null });

  const r = promocao.listarPublicoCampanha({ jobIdAlvo: vagaAlvo }, { db });
  const linha = r.itens.find((i) => i.email === email);

  assert.ok(linha, 'talento legado tem que estar no publico padrao');
  assert.equal(linha.origemTipo, 'talento');
  assert.equal(r.porOrigem.talentos >= 1, true);
});

test('a coluna `categoria` nao filtra nada no motor de campanha', () => {
  // O motor le talentos por status e janela de data; `categoria` e assunto de PAINEL. Se
  // alguem propagar o filtro da tela para ca "por simetria", este teste quebra.
  const legado = 'legado-cat@exemplo.com';
  const proprio = 'proprio-cat@exemplo.com';
  criarTalentoLegado({ email: legado });
  db.criarTalento({ nome: 'Cadastro Proprio', email: proprio, perfil_interesse: 'CLOSER' });

  const lista = emails(promocao.listarPublicoCampanha({ jobIdAlvo: vagaAlvo }, { db }));
  assert.ok(lista.includes(legado), 'legado entra');
  assert.ok(lista.includes(proprio), 'cadastro proprio entra');
});

test('os quatro cargos sem mapeamento entram todos, com perfil NULL', () => {
  // Consultor Comercial, Vendedor, BDR e Lideranca Comercial sao os 6.006 da producao.
  const casos = [
    ['consultor@exemplo.com', 'Consultor Comercial'],
    ['vendedor@exemplo.com', 'Vendedor'],
    ['bdr@exemplo.com', 'BDR'],
    ['lider@exemplo.com', 'Liderança Comercial'],
  ];
  for (const [email, cargo] of casos) criarTalentoLegado({ email, cargo, perfil: null });

  const lista = emails(promocao.listarPublicoCampanha({ jobIdAlvo: vagaAlvo }, { db }));
  for (const [email, cargo] of casos) {
    assert.ok(lista.includes(email), `${cargo} deveria estar no publico`);
  }
});

// ══════════════════════════════════════════════════════════════
// 2. Com filtro de perfil ativo, a regra do "sem atributo" continua valendo
// ══════════════════════════════════════════════════════════════

test('com filtro de perfil, legado sem perfil fica de FORA (regra do sem-atributo)', () => {
  const semPerfil = 'legado-filtro-sem@exemplo.com';
  const comPerfil = 'legado-filtro-com@exemplo.com';
  criarTalentoLegado({ email: semPerfil, cargo: 'Vendedor', perfil: null });
  criarTalentoLegado({ email: comPerfil, cargo: 'Closer', perfil: 'CLOSER' });

  const lista = emails(promocao.listarPublicoCampanha({ jobIdAlvo: vagaAlvo, perfil: 'CLOSER' }, { db }));

  assert.ok(!lista.includes(semPerfil), 'sem atributo = fora quando o filtro esta ativo');
  assert.ok(lista.includes(comPerfil), 'legado cujo cargo mapeou tem perfil e casa o filtro');
});

test('perfilIncluirSemAtributo traz o legado sem perfil de volta', () => {
  const semPerfil = 'legado-flag@exemplo.com';
  criarTalentoLegado({ email: semPerfil, cargo: 'BDR', perfil: null });

  const lista = emails(
    promocao.listarPublicoCampanha(
      { jobIdAlvo: vagaAlvo, perfil: 'CLOSER', perfilIncluirSemAtributo: true },
      { db },
    ),
  );
  assert.ok(lista.includes(semPerfil), 'e o caminho para uma campanha alcancar os 6.006');
});

test('legado SDR e Closer casam o filtro de perfil correspondente', () => {
  criarTalentoLegado({ email: 'legado-sdr@exemplo.com', cargo: 'SDR', perfil: 'SDR' });

  const listaSdr = emails(promocao.listarPublicoCampanha({ jobIdAlvo: vagaAlvo, perfil: 'SDR' }, { db }));
  assert.ok(listaSdr.includes('legado-sdr@exemplo.com'));
  assert.ok(!listaSdr.includes('legado-filtro-com@exemplo.com'), 'o Closer nao entra no recorte SDR');
});

// ══════════════════════════════════════════════════════════════
// 3. Colisao legado x application — os 90 casos reais de producao
// ══════════════════════════════════════════════════════════════

test('mesma pessoa como candidata E como legado: UMA linha, applications vence', () => {
  // Formato fiel a producao: o legado tem perfil NULL (a Gabriela de
  // promocaoIntegracao.test.js tem CLOSER e nenhuma categoria). Sem o dedupe por e-mail
  // normalizado, esta pessoa receberia a MESMA campanha duas vezes.
  const email = 'colisao.real@exemplo.com'; // a forma normalizada das duas grafias abaixo
  const appId = criarCandidatura({ jobId: vagaOutra, email: '  Colisao.Real@Exemplo.com ' });
  criarTalentoLegado({ email: 'COLISAO.REAL@exemplo.com  ', cargo: 'Vendedor', perfil: null });

  const r = promocao.listarPublicoCampanha({ jobIdAlvo: vagaAlvo }, { db });
  const linhas = r.itens.filter((i) => i.email === email);

  assert.equal(linhas.length, 1, 'uma pessoa, uma mensagem — nunca duas');
  assert.equal(linhas[0].origemTipo, 'application', 'a candidatura carrega mais contexto');
  assert.equal(linhas[0].origemId, appId);
});

test('na colisao, o perfil do LADO application continua valendo para o filtro', () => {
  // A pessoa acima tem candidatura numa vaga CLOSER e talento legado sem perfil. O
  // atributo se acumula por PESSOA, entao ela casa o filtro CLOSER mesmo com o talento
  // sem perfil — o legado nao pode "apagar" o perfil que ela ja tinha.
  const lista = emails(promocao.listarPublicoCampanha({ jobIdAlvo: vagaAlvo, perfil: 'CLOSER' }, { db }));
  assert.ok(lista.includes('colisao.real@exemplo.com'));
});

// ══════════════════════════════════════════════════════════════
// 4. As exclusoes automaticas continuam valendo para legado
// ══════════════════════════════════════════════════════════════

test('legado descadastrado NAO entra no publico', () => {
  const email = 'legado-optout@exemplo.com';
  criarTalentoLegado({ email });
  run('INSERT INTO descadastros (email, origem) VALUES (?, ?)', email, 'link_email');

  const lista = emails(promocao.listarPublicoCampanha({ jobIdAlvo: vagaAlvo }, { db }));
  assert.ok(!lista.includes(email), 'opt-out vale igual para a base legada');
});

test('legado ja inscrito na vaga ALVO NAO recebe convite para ela', () => {
  const email = 'legado-ja-inscrito@exemplo.com';
  criarTalentoLegado({ email });
  criarCandidatura({ jobId: vagaAlvo, email });

  const lista = emails(promocao.listarPublicoCampanha({ jobIdAlvo: vagaAlvo }, { db }));
  assert.ok(!lista.includes(email));
});

test('legado marcado como descartado pelo recrutador sai do publico', () => {
  const email = 'legado-descartado@exemplo.com';
  criarTalentoLegado({ email });
  db.getDb().prepare("UPDATE talentos SET status = 'descartado' WHERE email = ?").run(email);

  const lista = emails(promocao.listarPublicoCampanha({ jobIdAlvo: vagaAlvo }, { db }));
  assert.ok(!lista.includes(email));
});

// ══════════════════════════════════════════════════════════════
// 5. A data de origem alimenta o filtro de data
// ══════════════════════════════════════════════════════════════

test('a janela de datas usa o criado_em da ORIGEM, nao a data da importacao', () => {
  // criarTalentoLegado grava criado_em = '2025-09-29'. Se a importacao tivesse deixado o
  // default datetime('now'), a janela abaixo devolveria vazio — e o filtro de data da
  // campanha seria inutil para 7.215 pessoas.
  const email = 'legado-data@exemplo.com';
  criarTalentoLegado({ email });

  const dentro = emails(
    promocao.listarPublicoCampanha(
      { jobIdAlvo: vagaAlvo, dataDe: '2025-09-01', dataAte: '2025-10-31' },
      { db },
    ),
  );
  assert.ok(dentro.includes(email), 'a data de origem tem que cair na janela');

  const fora = emails(
    promocao.listarPublicoCampanha(
      { jobIdAlvo: vagaAlvo, dataDe: '2026-01-01', dataAte: '2026-12-31' },
      { db },
    ),
  );
  assert.ok(!fora.includes(email));
});
