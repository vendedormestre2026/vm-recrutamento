'use strict';

// Campo `cidade` da vaga, ponta a ponta pelo formulario do painel
// (routes/admin.js: <select>, lerCamposRicos, POST /admin/vagas e POST /admin/vagas/:id)
// mais a persistencia em db/sqlite.js (criarVaga / atualizarVaga).
//
// ── POR QUE HTTP, e nao teste de unidade ──
// A logica pura ja esta coberta em test/cidades.test.js. O que ESTE arquivo guarda e a
// LIGACAO, que e onde o campo novo realmente quebra: criarVaga e atualizarVaga escrevem
// por lista EXPLICITA de colunas, entao um campo pode existir no formulario, ser
// normalizado corretamente e mesmo assim nunca chegar ao banco — sem erro nenhum, porque
// o objeto extra e simplesmente ignorado pelo prepared statement. Foi exatamente o que
// aconteceu na primeira versao deste incremento.
//
// Testar so `lerCamposRicos` deixaria esse buraco de pe.

const os = require('node:os');
const path = require('node:path');

process.env.DATABASE_PATH = path.join(os.tmpdir(), `vm-test-vaga-cidade-${process.pid}-${Date.now()}.db`);
process.env.INTERVIEW_MOCK = 'true';
process.env.SESSION_SECRET = 'segredo-de-teste';
process.env.ADMIN_USER = 'admin-teste';
process.env.ADMIN_PASSWORD = 'senha-teste';
process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert/strict');

const db = require('../src/db');
const { migrar } = require('../src/db/migrate');
const { criarApp } = require('../src/server');
const { CIDADES_VALIDAS } = require('../src/lib/cidades');

migrar();

let cookieAdmin = '';

async function comServidor(fn) {
  const app = criarApp();
  const server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  try {
    return await fn(`http://127.0.0.1:${server.address().port}`);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

async function autenticar(base) {
  const res = await fetch(`${base}/admin/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ usuario: 'admin-teste', senha: 'senha-teste' }),
    redirect: 'manual',
  });
  const bruto = res.headers.getSetCookie ? res.headers.getSetCookie() : [res.headers.get('set-cookie')];
  cookieAdmin = bruto.filter(Boolean).map((c) => c.split(';')[0]).join('; ');
  assert.ok(cookieAdmin.includes('vm_admin'));
}

const comAuth = (extra = {}) => ({ Cookie: cookieAdmin, ...extra });

// Campos minimos que o POST de vaga exige, para os testes falarem so de `cidade`.
function corpoVaga(extra = {}) {
  return new URLSearchParams({
    titulo: 'Vaga de Teste',
    perfil: 'CLOSER',
    descricao: 'Descricao',
    ativo: 'on',
    ...extra,
  });
}

async function criarPeloForm(base, extra) {
  const res = await fetch(`${base}/admin/vagas`, {
    method: 'POST',
    headers: comAuth({ 'Content-Type': 'application/x-www-form-urlencoded' }),
    body: corpoVaga(extra),
    redirect: 'manual',
  });
  assert.ok(res.status < 400, `POST /admin/vagas devolveu ${res.status}`);
  return db.getDb().prepare('SELECT * FROM jobs ORDER BY id DESC LIMIT 1').get();
}

test('o formulario oferece as 9 pracas e a opcao vazia', async () => {
  await comServidor(async (base) => {
    await autenticar(base);
    const html = await (await fetch(`${base}/admin/vagas/nova`, { headers: comAuth() })).text();

    assert.match(html, /<select name="cidade">/, 'o select precisa existir');
    for (const c of CIDADES_VALIDAS) {
      assert.ok(html.includes(`<option value="${c}"`), `falta a opcao ${c}`);
    }
    // A opcao vazia e o que permite vaga remota. Sem ela, o operador seria obrigado a
    // escolher uma praca para uma vaga que nao tem nenhuma.
    assert.match(html, /<option value="">— selecione —<\/option>/);
    // O sentinela de talento nao pode aparecer como praca de vaga.
    assert.doesNotMatch(html, /<option value="Todas as cidades"/);
  });
});

test('cidade valida e gravada no banco pelo formulario', async () => {
  await comServidor(async (base) => {
    await autenticar(base);
    const vaga = await criarPeloForm(base, { cidade: 'Joinville', endereco: 'Rua X, 100' });
    assert.equal(vaga.cidade, 'Joinville');
    // `endereco` continua intocado e independente: as duas colunas convivem.
    assert.equal(vaga.endereco, 'Rua X, 100');
  });
});

test('grafia sem acento chega ao banco no canonico ACENTUADO', async () => {
  await comServidor(async (base) => {
    await autenticar(base);
    const vaga = await criarPeloForm(base, { cidade: 'sao paulo' });
    assert.equal(vaga.cidade, 'São Paulo');
  });
});

test('cidade vazia grava NULL — o caso da vaga remota', async () => {
  await comServidor(async (base) => {
    await autenticar(base);
    const vaga = await criarPeloForm(base, { cidade: '', modalidade: 'remoto' });
    // NULL, e nao '': a diferenca importa para um filtro por cidade, que precisa
    // distinguir "sem praca" de string vazia.
    assert.equal(vaga.cidade, null);
  });
});

test('cidade fora da lista e recusada e vira NULL, sem derrubar o cadastro', async () => {
  await comServidor(async (base) => {
    await autenticar(base);
    // POST forjado (o <select> nao oferece isto, mas um cliente qualquer pode mandar).
    const vaga = await criarPeloForm(base, { cidade: 'Blumenau' });
    assert.equal(vaga.cidade, null, 'valor fora do vocabulario nao pode ser aceito');
    assert.equal(vaga.titulo, 'Vaga de Teste', 'e a vaga e criada normalmente');
  });
});

test('o endereco NAO vira cidade por adivinhacao', async () => {
  await comServidor(async (base) => {
    await autenticar(base);
    // O endereco real da vaga 7 de producao. Contem "Joinville", e isso nao pode bastar.
    const vaga = await criarPeloForm(base, {
      cidade: '',
      endereco: 'Anita Garibaldi - Joinville-SC',
    });
    assert.equal(vaga.cidade, null);
    assert.equal(vaga.endereco, 'Anita Garibaldi - Joinville-SC');
  });
});

test('edicao troca e limpa a cidade, e o select reflete o valor salvo', async () => {
  await comServidor(async (base) => {
    await autenticar(base);
    const vaga = await criarPeloForm(base, { cidade: 'Joinville' });

    const editar = (extra) =>
      fetch(`${base}/admin/vagas/${vaga.id}`, {
        method: 'POST',
        headers: comAuth({ 'Content-Type': 'application/x-www-form-urlencoded' }),
        body: corpoVaga(extra),
        redirect: 'manual',
      });
    const lido = () => db.getDb().prepare('SELECT cidade FROM jobs WHERE id = ?').get(vaga.id).cidade;

    await editar({ cidade: 'Campinas' });
    assert.equal(lido(), 'Campinas');

    // A tela de edicao precisa mostrar a praca salva como selecionada — senao um salvamento
    // seguinte, sem tocar no campo, a apagaria em silencio.
    const html = await (await fetch(`${base}/admin/vagas/${vaga.id}`, { headers: comAuth() })).text();
    assert.match(html, /<option value="Campinas" selected>/);

    // E limpar volta a NULL: uma vaga pode deixar de ter praca (virou remota).
    await editar({ cidade: '' });
    assert.equal(lido(), null);
  });
});

// ══════════════════ Import por briefing (LLM) ══════════════════
//
// O mesmo campo tem uma segunda porta de entrada: lib/importar_vaga extrai os campos da
// vaga de um Google Doc via LLM, para PRE-PREENCHER o formulario. Sem guard aqui, o campo
// fechado no <select> voltaria a ser livre por esta porta — o LLM devolveria qualquer
// string e ela chegaria ao form como se fosse valida.
//
// O contrato e o mesmo de modalidade/regime: valor fora da lista nao chega ao form, entra
// em `ausentes`, e o operador preenche na revisao. Nenhuma vaga e salva por este caminho.

const { parseExtracaoVaga, montarMensagensExtracao } = require('../src/lib/importar_vaga');

// Extracao valida minima, para os testes falarem so de `cidade`.
const EXTRACAO = {
  titulo: 'T', faixa_pagamento: 'x', potencial_ganhos: 'x', horario: 'x',
  descricao: 'x', sobre_empresa: 'x',
  atividades: ['a'], requisitos: ['a'], beneficios: ['a'], skills: ['a'],
  perfil: 'CLOSER', modalidade: 'presencial', regime: 'CLT',
  endereco: 'Anita Garibaldi - Joinville-SC',
};
const extrair = (cidade) => parseExtracaoVaga(JSON.stringify({ ...EXTRACAO, cidade }));

test('import: o prompt lista as pracas validas, geradas da constante', () => {
  const system = montarMensagensExtracao('briefing qualquer')[0].conteudo;
  for (const c of CIDADES_VALIDAS) {
    assert.ok(system.includes(`"${c}"`), `o prompt precisa oferecer ${c}`);
  }
  // Interpolada, e nao escrita a mao: uma praca nova em lib/cidades tem que aparecer aqui
  // sozinha. Senao o sintoma seria "a IA nunca acerta essa cidade", difícil de rastrear.
  assert.match(system, /"cidade":.*\| "",\s*\/\/ so essas/);
  // E `endereco` continua sendo pedido como texto livre, ao lado — os dois convivem.
  assert.match(system, /"endereco": "string"/);
});

test('import: cidade valida passa; sem acento vira o canonico', () => {
  assert.equal(extrair('Joinville').vaga.cidade, 'Joinville');
  assert.equal(extrair('sao paulo').vaga.cidade, 'São Paulo');
  assert.equal(extrair('Joinville').ausentes.includes('cidade'), false);
});

test('import: valor fora da lista vai para `ausentes`, nao para o form', () => {
  // Guard identico ao de modalidade. Sem ele, o campo fechado voltaria a ser livre.
  for (const ruim of ['Blumenau', 'Anita Garibaldi - Joinville-SC', 'Joinville/SC', '', undefined]) {
    const r = extrair(ruim);
    assert.equal(r.vaga.cidade, '', `${ruim} nao pode chegar ao form`);
    assert.ok(r.ausentes.includes('cidade'), `${ruim} tem que ser sinalizado ao operador`);
  }
});

test('import: cidade recusada NAO afeta endereco nem os demais campos', () => {
  // Degradacao isolada: uma cidade que o LLM nao soube dizer nao pode custar o resto da
  // extracao. O endereco livre continua chegando inteiro.
  const r = extrair('Blumenau');
  assert.equal(r.vaga.endereco, 'Anita Garibaldi - Joinville-SC');
  assert.equal(r.vaga.modalidade, 'presencial');
  assert.equal(r.vaga.titulo, 'T');
});

// ══════════════════ listarCidadesDistintas ══════════════════

test('as pracas de VAGA entram na lista do filtro', () => {
  // A funcao alimenta as opcoes do filtro de cidade da campanha. Antes lia so `talentos` e
  // `applications`; uma vaga em Curitiba sem nenhum talento de la seria uma praca invisivel
  // — ninguem a procura, porque ninguem sabe que existe.
  db.getDb().prepare('DELETE FROM jobs').run();
  db.criarVaga({
    slug: 'praca-1', titulo: 'V', perfil: 'CLOSER', cidade: 'Curitiba',
    skills: [], beneficios: [], atividades: [], requisitos: [],
    requisitos_obrigatorios: [], secoes_extras: [], ativo: 1, entrevista_ativa: 1,
  });
  assert.ok(db.listarCidadesDistintas().includes('Curitiba'));
});

test('vaga remota (cidade NULL) nao polui a lista', () => {
  db.getDb().prepare('DELETE FROM jobs').run();
  db.criarVaga({
    slug: 'praca-2', titulo: 'V', perfil: 'CLOSER', cidade: null, modalidade: 'remoto',
    skills: [], beneficios: [], atividades: [], requisitos: [],
    requisitos_obrigatorios: [], secoes_extras: [], ativo: 1, entrevista_ativa: 1,
  });
  assert.deepEqual(db.listarCidadesDistintas(), []);
});

test('a lista nao repete praca que ja veio de talentos, e segue ordenada em pt-BR', () => {
  db.getDb().prepare('DELETE FROM jobs').run();
  db.getDb().prepare('DELETE FROM talentos').run();
  db.getDb()
    .prepare("INSERT INTO talentos (nome, email, cidade) VALUES ('T', 't@x.co', 'Joinville')")
    .run();
  for (const [slug, cidade] of [['p3', 'Joinville'], ['p4', 'Balneário Camboriú']]) {
    db.criarVaga({
      slug, titulo: 'V', perfil: 'CLOSER', cidade,
      skills: [], beneficios: [], atividades: [], requisitos: [],
      requisitos_obrigatorios: [], secoes_extras: [], ativo: 1, entrevista_ativa: 1,
    });
  }
  // UNION (nao UNION ALL) + Set: 'Joinville' vem das duas fontes e aparece uma vez so.
  assert.deepEqual(db.listarCidadesDistintas(), ['Balneário Camboriú', 'Joinville']);
});

test('a praca de vaga tambem respeita a exclusao do sentinela', () => {
  // 'Todas as cidades' nao esta em CIDADES_VALIDAS, entao nao deveria chegar aqui por
  // caminho normal — mas o filtro da funcao e a ultima linha de defesa, e vale para as tres
  // fontes igualmente.
  db.getDb().prepare('DELETE FROM jobs').run();
  db.getDb().prepare('DELETE FROM talentos').run();
  db.getDb()
    .prepare("INSERT INTO jobs (slug, titulo, perfil, cidade) VALUES ('p5', 'V', 'CLOSER', 'Todas as cidades')")
    .run();
  assert.deepEqual(db.listarCidadesDistintas(), []);
});
