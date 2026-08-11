'use strict';

// Filtros de BASE e de CIDADE no motor de publico da campanha.
//
// Os dois sao MULTI-SELECAO (checkboxes), diferentes dos tres que ja existiam (Perfil,
// Origem, Recomendacao sao dropdowns de escolha unica). Isso muda duas coisas que os
// testes abaixo travam:
//   - lista VAZIA = filtro inativo, e nao "ninguem casa". Abrir a tela sem tocar em nada
//     nao pode zerar o publico.
//   - a semantica entre os marcados e OU.
//
// E ha o SENTINELA de cidade ('Todas as cidades', 531 pessoas da Loureiro em producao),
// que casa com QUALQUER selecao. Ele e o oposto de "sem cidade" e nao pode depender do
// checkbox "incluir sem cidade" — confundir os dois e o erro que este arquivo existe para
// impedir.
//
// NENHUMA REDE: banco temporario, mesmo molde de promocaoVagas.test.js.

const os = require('node:os');
const path = require('node:path');

process.env.DATABASE_PATH = path.join(os.tmpdir(), `vm-test-promo-filtros-${process.pid}-${Date.now()}.db`);
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
  return run('INSERT INTO jobs (slug, titulo, perfil) VALUES (?, ?, ?)', `vg-${seq}`, titulo, perfil);
}

function criarCandidatura({ jobId, email, cidade = null, utm = 'meta-ads' }) {
  seq += 1;
  return run(
    `INSERT INTO applications (job_id, token, nome, sobrenome, email, cidade, utm_source)
     VALUES (?, ?, 'Fulano', 'Silva', ?, ?, ?)`,
    jobId,
    `tk-${seq}`,
    email,
    cidade,
    utm,
  );
}

// Talento legado, no formato exato que a importacao grava.
function criarLegado({ email, cidade = null, perfil = null, cargo = 'Vendedor' }) {
  db.criarTalentosLegado([
    {
      nome: 'Legado',
      email,
      telefone: null,
      perfil_interesse: perfil,
      categoria: 'legado',
      cargo,
      campos_extras: '{}',
      consent_at: null,
      criado_em: '2025-09-29 03:04:27',
    },
  ]);
  const id = db.getDb().prepare('SELECT id FROM talentos WHERE email = ?').get(email).id;
  if (cidade) db.getDb().prepare('UPDATE talentos SET cidade = ? WHERE id = ?').run(cidade, id);
  return id;
}

// Cadastro proprio: categoria NULL, como criarTalento grava.
function criarProprio({ email, cidade = null, perfil = 'CLOSER' }) {
  const id = db.criarTalento({ nome: 'Proprio', email, perfil_interesse: perfil });
  if (cidade) db.getDb().prepare('UPDATE talentos SET cidade = ? WHERE id = ?').run(cidade, id);
  return id;
}

const emails = (r) => r.itens.map((i) => i.email).sort();
const publico = (criterios) =>
  promocao.listarPublicoCampanha({ jobIdAlvo: vagaAlvo, ...criterios }, { db });

const vagaAlvo = criarVaga('CLOSER', 'Vaga Alvo');
const vagaOutra = criarVaga('CLOSER', 'Outra');

// ── Cenario ──
criarCandidatura({ jobId: vagaOutra, email: 'cand-sp@x.com', cidade: 'São Paulo' });
criarCandidatura({ jobId: vagaOutra, email: 'cand-sem-cidade@x.com' });
criarLegado({ email: 'leg-joinville@x.com', cidade: 'Joinville' });
criarLegado({ email: 'leg-curitiba@x.com', cidade: 'Curitiba' });
criarLegado({ email: 'leg-todas@x.com', cidade: 'Todas as cidades' });
criarLegado({ email: 'leg-sem-cidade@x.com' });
criarProprio({ email: 'prop-joinville@x.com', cidade: 'Joinville' });
criarProprio({ email: 'prop-sem-cidade@x.com' });
// A pessoa que existe nas DUAS bases (os 90 casos reais de producao).
criarCandidatura({ jobId: vagaOutra, email: 'dupla@x.com', cidade: 'São Paulo' });
criarLegado({ email: 'dupla@x.com', cidade: 'Joinville' });

// Ordem alfabetica de string (o `-` ordena antes de qualquer letra), que e o que
// `emails()` produz.
const TODOS = [
  'cand-sem-cidade@x.com',
  'cand-sp@x.com',
  'dupla@x.com',
  'leg-curitiba@x.com',
  'leg-joinville@x.com',
  'leg-sem-cidade@x.com',
  'leg-todas@x.com',
  'prop-joinville@x.com',
  'prop-sem-cidade@x.com',
];

// ══════════════════════════════════════════════════════════════
// 0. Sanidade: sem filtro, todo mundo entra
// ══════════════════════════════════════════════════════════════

test('sem nenhum filtro novo, o publico e o de sempre', () => {
  assert.deepEqual(emails(publico({})), TODOS);
});

test('lista VAZIA de base/cidade = filtro inativo, nao "ninguem casa"', () => {
  // Se lista vazia zerasse o publico, abrir a tela sem tocar em nada mostraria 0.
  assert.deepEqual(emails(publico({ bases: [], cidades: [] })), TODOS);
  assert.deepEqual(emails(publico({ bases: undefined, cidades: null })), TODOS);
});

// ══════════════════════════════════════════════════════════════
// 1. Filtro de BASE
// ══════════════════════════════════════════════════════════════

test('base=candidatura traz so quem tem candidatura', () => {
  const lista = emails(publico({ bases: ['candidatura'] }));
  assert.deepEqual(lista, ['cand-sem-cidade@x.com', 'cand-sp@x.com', 'dupla@x.com']);
});

test('base=legado traz so os importados', () => {
  const lista = emails(publico({ bases: ['legado'] }));
  assert.deepEqual(lista, [
    'dupla@x.com',
    'leg-curitiba@x.com',
    'leg-joinville@x.com',
    'leg-sem-cidade@x.com',
    'leg-todas@x.com',
  ]);
});

test('base=proprio traz so o cadastro proprio (categoria NULL)', () => {
  assert.deepEqual(emails(publico({ bases: ['proprio'] })), [
    'prop-joinville@x.com',
    'prop-sem-cidade@x.com',
  ]);
});

test('pessoa em DUAS bases casa com o filtro de QUALQUER uma delas', () => {
  // O ponto do Set: `dupla` e candidata E legado. Nas duas listas acima ela aparece.
  assert.ok(emails(publico({ bases: ['candidatura'] })).includes('dupla@x.com'));
  assert.ok(emails(publico({ bases: ['legado'] })).includes('dupla@x.com'));
  // E aparece UMA vez quando as duas sao marcadas.
  const lista = emails(publico({ bases: ['candidatura', 'legado'] }));
  assert.equal(lista.filter((e) => e === 'dupla@x.com').length, 1);
});

test('marcar varias bases e OU entre elas', () => {
  assert.deepEqual(emails(publico({ bases: ['proprio', 'candidatura'] })), [
    'cand-sem-cidade@x.com',
    'cand-sp@x.com',
    'dupla@x.com',
    'prop-joinville@x.com',
    'prop-sem-cidade@x.com',
  ]);
  assert.deepEqual(emails(publico({ bases: promocao.BASES_VALIDAS })), TODOS, 'as tres = todos');
});

test('base invalida e DESCARTADA da lista, sem invalidar o resto', () => {
  assert.deepEqual(emails(publico({ bases: ['legado', 'inventada'] })), emails(publico({ bases: ['legado'] })));
  // So lixo = lista vazia = filtro inativo.
  assert.deepEqual(emails(publico({ bases: ['inventada', 'outra'] })), TODOS);
});

test('base NAO tem "sem atributo": todo mundo veio de alguma', () => {
  // Com o filtro ATIVO o contador e 0 (e nao null): null significa "esta pergunta nao foi
  // feita", 0 significa "foi feita e ninguem ficou de fora por falta do atributo". Aqui e
  // sempre 0 por construcao — nao existe pessoa sem base —, e e por isso que a tela nao
  // oferece checkbox "incluir sem base".
  assert.equal(publico({ bases: ['legado'] }).excluidosPorFiltro.base, 0);
  assert.equal(publico({}).excluidosPorFiltro.base, null, 'filtro desligado = pergunta nao feita');
});

// ══════════════════════════════════════════════════════════════
// 2. Filtro de CIDADE
// ══════════════════════════════════════════════════════════════

test('uma cidade marcada traz quem tem aquela cidade — mais o sentinela', () => {
  const lista = emails(publico({ cidades: ['Joinville'] }));
  assert.deepEqual(lista, ['dupla@x.com', 'leg-joinville@x.com', 'leg-todas@x.com', 'prop-joinville@x.com']);
});

test('varias cidades marcadas sao OU entre elas', () => {
  const lista = emails(publico({ cidades: ['Curitiba', 'São Paulo'] }));
  assert.deepEqual(lista, ['cand-sp@x.com', 'dupla@x.com', 'leg-curitiba@x.com', 'leg-todas@x.com']);
});

test('o SENTINELA casa com QUALQUER cidade selecionada', () => {
  // 'Todas as cidades' nao esta entre as opcoes marcaveis, e mesmo assim leg-todas entra
  // em todo recorte por cidade. E o que dispensa o operador de lembrar de marca-lo.
  for (const cidade of ['Joinville', 'Curitiba', 'São Paulo', 'Florianópolis', 'Cidade Inexistente']) {
    assert.ok(
      emails(publico({ cidades: [cidade] })).includes('leg-todas@x.com'),
      `o sentinela deveria casar com ${cidade}`,
    );
  }
});

test('o sentinela NAO depende do "incluir sem cidade"', () => {
  const semFlag = emails(publico({ cidades: ['Curitiba'] }));
  assert.ok(semFlag.includes('leg-todas@x.com'), 'ele entra mesmo com a flag desligada');
  assert.ok(!semFlag.includes('leg-sem-cidade@x.com'), 'quem NAO tem cidade continua fora');
});

test('quem NAO tem cidade fica de fora, e volta com "incluir sem cidade"', () => {
  const semFlag = emails(publico({ cidades: ['Joinville'] }));
  assert.ok(!semFlag.includes('leg-sem-cidade@x.com'));
  assert.ok(!semFlag.includes('cand-sem-cidade@x.com'));

  const comFlag = emails(publico({ cidades: ['Joinville'], cidadeIncluirSemAtributo: true }));
  assert.ok(comFlag.includes('leg-sem-cidade@x.com'));
  assert.ok(comFlag.includes('cand-sem-cidade@x.com'));
  assert.ok(comFlag.includes('prop-sem-cidade@x.com'));
});

test('a flag NAO traz quem TEM cidade que nao casa', () => {
  // Mesma regra dos filtros antigos: a flag alcanca a AUSENCIA de atributo, nao o
  // atributo que simplesmente nao bate.
  const comFlag = emails(publico({ cidades: ['Joinville'], cidadeIncluirSemAtributo: true }));
  assert.ok(!comFlag.includes('leg-curitiba@x.com'), 'tem cidade, so nao casa: continua fora');
});

test('cidade de applications tambem conta (coluna orfa, mas lida)', () => {
  assert.ok(emails(publico({ cidades: ['São Paulo'] })).includes('cand-sp@x.com'));
});

test('a contagem de "sem cidade" e reportada para a tela', () => {
  const r = publico({ cidades: ['Joinville'] });
  assert.equal(r.excluidosPorFiltro.cidade, 3, 'leg-sem-cidade, cand-sem-cidade, prop-sem-cidade');
  // null (e nao 0) quando o filtro nem foi ligado — a tela distingue as duas coisas.
  assert.equal(publico({}).excluidosPorFiltro.cidade, null);
});

test('cidade duplicada ou vazia na selecao nao muda o resultado', () => {
  assert.deepEqual(
    emails(publico({ cidades: ['Joinville', 'Joinville', ''] })),
    emails(publico({ cidades: ['Joinville'] })),
  );
});

test('cidade e string livre: valor inexistente simplesmente nao casa ninguem (menos o sentinela)', () => {
  // Nao ha allowlist de cidade — a coluna aceita qualquer texto. Selecao desconhecida
  // devolve so o coringa, que e o comportamento correto e nao um erro.
  assert.deepEqual(emails(publico({ cidades: ['Marte'] })), ['leg-todas@x.com']);
});

// ══════════════════════════════════════════════════════════════
// 3. Combinacoes e nao-regressao
// ══════════════════════════════════════════════════════════════

test('base e cidade combinam com E entre os eixos', () => {
  const lista = emails(publico({ bases: ['legado'], cidades: ['Joinville'] }));
  assert.deepEqual(lista, ['dupla@x.com', 'leg-joinville@x.com', 'leg-todas@x.com']);
  assert.ok(!lista.includes('prop-joinville@x.com'), 'proprio de Joinville nao e legado');
});

test('os filtros antigos continuam funcionando junto com os novos', () => {
  const r = publico({ bases: ['legado'], perfil: 'CLOSER', perfilIncluirSemAtributo: true });
  assert.ok(emails(r).length > 0);
  assert.equal(r.excluidosPorFiltro.perfil !== null, true, 'o contador antigo segue reportado');
});

test('NAO REGRIDE: com filtro de Origem ativo, talento continua fora (limitacao conhecida)', () => {
  // Este teste nao conserta o comportamento — ele o CONGELA. O filtro de Origem le
  // utm_source, que talento nao tem, entao todo talento e "sem atributo" nesse eixo. A
  // tela avisa sobre isso. Se algum dia alguem mudar a semantica, que seja de propósito.
  const lista = emails(publico({ utmSource: 'meta-ads' }));
  assert.ok(lista.includes('cand-sp@x.com'), 'candidatura tem origem');
  assert.ok(!lista.includes('leg-joinville@x.com'), 'talento nao tem utm_source');
  assert.ok(lista.includes('dupla@x.com'), 'quem TAMBEM e candidata tem origem pelo lado dela');

  const comFlag = emails(publico({ utmSource: 'meta-ads', utmSourceIncluirSemAtributo: true }));
  assert.ok(comFlag.includes('leg-joinville@x.com'), 'a flag e o caminho para alcanca-los');
});

test('as constantes de base exportadas sao as tres decididas', () => {
  assert.deepEqual(promocao.BASES_VALIDAS, ['candidatura', 'legado', 'proprio']);
  assert.equal(promocao.CIDADE_TODAS, 'Todas as cidades');
});

// ══════════════════════════════════════════════════════════════
// 4. As opcoes da tela
// ══════════════════════════════════════════════════════════════

test('listarCidadesDistintas une as duas bases, ordena e OMITE o sentinela', () => {
  const cidades = db.listarCidadesDistintas();
  assert.ok(cidades.includes('Joinville'));
  assert.ok(cidades.includes('Curitiba'));
  assert.ok(cidades.includes('São Paulo'), 'veio de applications');
  assert.ok(
    !cidades.includes('Todas as cidades'),
    'o sentinela nao e opcao marcavel — ele casa sozinho',
  );
  // Ordem alfabetica ciente de acento.
  assert.deepEqual(cidades, [...cidades].sort((a, b) => a.localeCompare(b, 'pt-BR')));
});
