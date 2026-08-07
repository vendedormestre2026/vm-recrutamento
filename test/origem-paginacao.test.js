'use strict';

// Filtro de ORIGEM (utm_source) + PAGINACAO da lista de candidatos (/admin).
//
// Cobre (DB isolado, dados inseridos direto; sem LLM/STT/TTS/Drive/e-mail):
//   1. listarOrigensDistintas: baldes de apresentacao (NULL+'direto' -> uma opcao;
//      'grupo-whats'+'grupowhats' -> uma opcao), sem duplicatas e ordenado;
//   2. filtro por origem em listarAplicacoesComContexto: o balde 'direto' pega NULL e o
//      literal; o balde do grupo pega as DUAS grafias; origem comum e igualdade exata;
//   3. paginacao: 25 por pagina, segunda pagina com o resto, combinacao filtro+pagina e
//      saneamento de pagina invalida;
//   4. contarAplicacoesComContexto: conta o recorte INTEIRO (ignora LIMIT/OFFSET) e bate
//      com o total das paginas — e o que o rodape e o calculo de totalPaginas usam.

const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');

const TMP_DB = path.join(os.tmpdir(), `vm-test-origem-${process.pid}-${Date.now()}.db`);
process.env.DATABASE_PATH = TMP_DB;
process.env.INTERVIEW_MOCK = 'true';
process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert/strict');

const db = require('../src/db');
const { migrar } = require('../src/db/migrate');

const POR_PAGINA = db.CANDIDATOS_POR_PAGINA;

let vaga;
let seqTok = 0;

function run(sql, ...params) {
  return Number(db.getDb().prepare(sql).run(...params).lastInsertRowid);
}

// utm_source e passado CRU (inclusive null) — o ponto do teste e justamente a
// convivencia das grafias historicas no banco.
function aplicacao({ nome, utmSource, criadoEm }) {
  seqTok += 1;
  return run(
    `INSERT INTO applications (job_id, nome, sobrenome, email, status, token, utm_source, criado_em)
     VALUES (?, ?, 'Teste', ?, 'aplicado', ?, ?, ?)`,
    vaga,
    nome,
    `${nome.toLowerCase()}@teste.com`,
    `tok-origem-${seqTok}`,
    utmSource,
    criadoEm,
  );
}

// Datas decrescentes distintas: a query ordena por criado_em DESC, entao um criado_em
// unico por linha deixa a ordem (e o corte entre paginas) deterministico.
function dataSeq(i) {
  const dia = String(i + 1).padStart(2, '0');
  return `2026-07-${dia} 10:00:00`;
}

test.before(() => {
  migrar();
  vaga = run("INSERT INTO jobs (slug, titulo, perfil) VALUES ('vaga-origem', 'Closer', 'CLOSER')");

  // Balde 'direto': as duas formas de "sem origem" que convivem no banco.
  aplicacao({ nome: 'DiretoNulo', utmSource: null, criadoEm: '2026-06-01 10:00:00' });
  aplicacao({ nome: 'DiretoLiteral', utmSource: 'direto', criadoEm: '2026-06-02 10:00:00' });

  // Balde do grupo de WhatsApp: mesma campanha, duas grafias.
  aplicacao({ nome: 'GrupoComHifen', utmSource: 'grupo-whats', criadoEm: '2026-06-03 10:00:00' });
  aplicacao({ nome: 'GrupoSemHifen', utmSource: 'grupowhats', criadoEm: '2026-06-04 10:00:00' });

  // Origem comum, sem tratamento especial.
  aplicacao({ nome: 'Teste1', utmSource: 'teste', criadoEm: '2026-06-05 10:00:00' });

  // 30 leads de 'meta' (> 1 pagina de 25) para exercitar a paginacao.
  for (let i = 0; i < 30; i += 1) {
    aplicacao({ nome: `Meta${String(i).padStart(2, '0')}`, utmSource: 'meta', criadoEm: dataSeq(i) });
  }
});

test.after(() => {
  for (const sufixo of ['', '-wal', '-shm']) {
    try {
      fs.rmSync(TMP_DB + sufixo, { force: true });
    } catch {
      /* ignore */
    }
  }
});

// ── 1. Origens do dropdown ────────────────────────────────────────────────────────────

test('listarOrigensDistintas funde NULL+direto e as duas grafias do grupo', () => {
  const origens = db.listarOrigensDistintas();
  const valores = origens.map((o) => o.valor_canonico);

  // Uma entrada por balde: 5 grafias distintas no banco viram 4 opcoes.
  assert.deepEqual([...valores].sort(), ['direto', 'grupo-whats', 'meta', 'teste']);
  assert.equal(valores.length, new Set(valores).size, 'nao pode repetir valor canonico');
  assert.ok(!valores.includes('grupowhats'), 'a grafia sem hifen nao vira opcao propria');

  // Rotulos apresentaveis para os dois baldes; o resto aparece cru.
  const porValor = new Map(origens.map((o) => [o.valor_canonico, o.label]));
  assert.equal(porValor.get('direto'), 'Direto');
  assert.equal(porValor.get('grupo-whats'), 'Grupo WhatsApp');
  assert.equal(porValor.get('meta'), 'meta');
});

test('listarOrigensDistintas vem ordenado por rotulo', () => {
  const labels = db.listarOrigensDistintas().map((o) => o.label);
  assert.deepEqual(labels, [...labels].sort((a, b) => a.localeCompare(b, 'pt-BR')));
});

// ── 2. Filtro por origem ──────────────────────────────────────────────────────────────

test("filtro 'direto' pega utm_source NULL e o literal 'direto'", () => {
  const nomes = db.listarAplicacoesComContexto({ origem: 'direto' }).map((c) => c.nome);
  assert.deepEqual([...nomes].sort(), ['DiretoLiteral', 'DiretoNulo']);
  assert.equal(db.contarAplicacoesComContexto({ origem: 'direto' }), 2);
});

test('filtro do grupo pega as duas grafias, entrando por qualquer uma delas', () => {
  const esperado = ['GrupoComHifen', 'GrupoSemHifen'];

  const porCanonica = db.listarAplicacoesComContexto({ origem: 'grupo-whats' }).map((c) => c.nome);
  assert.deepEqual([...porCanonica].sort(), esperado);

  // A grafia sem hifen e normalizada para a canonica antes de virar WHERE — o mesmo
  // recorte, para um link antigo nao devolver meia lista.
  const porVariante = db.listarAplicacoesComContexto({ origem: 'grupowhats' }).map((c) => c.nome);
  assert.deepEqual([...porVariante].sort(), esperado);

  assert.equal(db.contarAplicacoesComContexto({ origem: 'grupo-whats' }), 2);
});

test('origem comum e igualdade exata e nao vaza para outros baldes', () => {
  const nomes = db.listarAplicacoesComContexto({ origem: 'teste' }).map((c) => c.nome);
  assert.deepEqual(nomes, ['Teste1']);
  assert.equal(db.contarAplicacoesComContexto({ origem: 'inexistente' }), 0);
});

test('sem origem informada, nenhum recorte por origem acontece', () => {
  const total = db.contarAplicacoesComContexto({});
  assert.equal(total, 35, 'as 35 candidaturas inseridas no before');
  assert.equal(db.contarAplicacoesComContexto({ origem: '' }), total);
  assert.equal(db.contarAplicacoesComContexto({ origem: null }), total);
});

test('a listagem devolve utm_source (fim do fetch por linha da coluna Origem)', () => {
  const [linha] = db.listarAplicacoesComContexto({ origem: 'teste' });
  assert.equal(linha.utm_source, 'teste');
});

// ── 3. Paginacao ──────────────────────────────────────────────────────────────────────

test('a pagina 1 traz no maximo 25 linhas', () => {
  assert.equal(POR_PAGINA, 25);
  assert.equal(db.listarAplicacoesComContexto({}).length, POR_PAGINA);
  assert.equal(db.listarAplicacoesComContexto({ pagina: 1 }).length, POR_PAGINA);
});

test('a pagina 2 traz o resto, sem repetir nem pular ninguem', () => {
  const total = db.contarAplicacoesComContexto({});
  const p1 = db.listarAplicacoesComContexto({ pagina: 1 }).map((c) => c.id);
  const p2 = db.listarAplicacoesComContexto({ pagina: 2 }).map((c) => c.id);

  assert.equal(p2.length, total - POR_PAGINA, '35 - 25 = 10 na segunda pagina');
  assert.equal(new Set([...p1, ...p2]).size, total, 'sem sobreposicao entre as paginas');

  // Pagina depois da ultima: vazia, nao erro.
  assert.deepEqual(db.listarAplicacoesComContexto({ pagina: 99 }), []);
});

test('paginacao respeita o filtro de origem (30 de meta = 25 + 5)', () => {
  const filtro = { origem: 'meta' };
  assert.equal(db.contarAplicacoesComContexto(filtro), 30);
  assert.equal(db.listarAplicacoesComContexto({ ...filtro, pagina: 1 }).length, 25);
  assert.equal(db.listarAplicacoesComContexto({ ...filtro, pagina: 2 }).length, 5);

  // Toda linha da pagina 2 continua sendo 'meta': o filtro nao se perde no OFFSET.
  const origens = db.listarAplicacoesComContexto({ ...filtro, pagina: 2 }).map((c) => c.utm_source);
  assert.deepEqual([...new Set(origens)], ['meta']);
});

test('pagina invalida cai para a primeira (OFFSET nunca negativo)', () => {
  const p1 = db.listarAplicacoesComContexto({ pagina: 1 }).map((c) => c.id);
  for (const ruim of [0, -3, 'abc', null, undefined, {}]) {
    assert.deepEqual(
      db.listarAplicacoesComContexto({ pagina: ruim }).map((c) => c.id),
      p1,
      `pagina ${JSON.stringify(ruim)} deveria cair para a 1`,
    );
  }
});

// ── 4. Contagem x listagem ────────────────────────────────────────────────────────────

test('contarAplicacoesComContexto ignora LIMIT/OFFSET e usa o MESMO where da listagem', () => {
  // Conta o recorte inteiro, nao a pagina: o rodape nao pode dizer "25" quando ha 35.
  assert.equal(db.contarAplicacoesComContexto({ pagina: 2 }), 35);

  // Os filtros antigos continuam valendo na contagem (arquivados aqui, que e o filtro
  // implicito de toda a tela).
  const ativos = db.contarAplicacoesComContexto({ arquivados: 'ativos' });
  assert.equal(ativos, 35);
  assert.equal(db.contarAplicacoesComContexto({ arquivados: 'arquivados' }), 0);

  // Somar as paginas do recorte tem que dar exatamente o total contado.
  const total = db.contarAplicacoesComContexto({ origem: 'meta' });
  let somadas = 0;
  for (let p = 1; p <= Math.ceil(total / POR_PAGINA); p += 1) {
    somadas += db.listarAplicacoesComContexto({ origem: 'meta', pagina: p }).length;
  }
  assert.equal(somadas, total);
});
