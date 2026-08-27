'use strict';

// Fundacao de dados da Promocao de Vagas (src/db/schema.sql): as tres tabelas novas
// (campanhas, campanha_envios, descadastros) e os tres indices.
//
// POR QUE TESTAR SCHEMA: as constraints deste subsistema nao sao higiene de dados — sao
// as salvaguardas de um sistema que manda e-mail para fora. O UNIQUE(campanha_id, email)
// e a ULTIMA linha de defesa contra a mesma pessoa receber a mesma campanha duas vezes, e
// os CHECK de enum sao o que impede um status digitado errado virar um estado valido no
// banco. Nada disso e exercitado por um teste de logica de negocio; se alguem "limpar" o
// schema, o dano so apareceria em producao, num e-mail ja enviado, sem desfazer.
//
// NENHUMA REDE, NENHUM ENVIO: este incremento e so schema. Nao existe ainda funcao de
// acesso a estas tabelas — os INSERTs abaixo usam SQL direto de proposito, porque e
// exatamente a camada do banco que esta sob teste.
//
// migrar() roda ANTES de qualquer assercao, igual aos demais testes: as tabelas precisam
// existir de verdade, senao tudo falharia por "no such table" — um falso vermelho que
// esconderia o que esta sendo verificado.

const os = require('node:os');
const path = require('node:path');

process.env.DATABASE_PATH = path.join(os.tmpdir(), `vm-test-promocao-schema-${process.pid}-${Date.now()}.db`);
process.env.INTERVIEW_MOCK = 'true';
process.env.SESSION_SECRET = 'segredo-de-teste';
process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert/strict');

const db = require('../src/db');
const { migrar } = require('../src/db/migrate');

migrar(); // as tabelas precisam existir antes de qualquer coisa

// ── Helpers ──
const run = (sql, ...p) => Number(db.getDb().prepare(sql).run(...p).lastInsertRowid);

const existeNoSqliteMaster = (tipo, nome) =>
  Boolean(
    db
      .getDb()
      .prepare('SELECT name FROM sqlite_master WHERE type = ? AND name = ?')
      .get(tipo, nome),
  );

// Vaga real: campanhas.job_id tem FK para jobs(id) e o pragma foreign_keys esta ON
// (sqlite.js), entao um id inventado seria rejeitado antes de chegar na constraint que
// cada teste quer exercitar.
const vagaId = run(
  "INSERT INTO jobs (slug, titulo, perfil) VALUES ('vaga-promocao', 'Closer de Vendas', 'CLOSER')",
);

let seq = 0;

// Cria uma campanha valida (status cai no default 'rascunho'). Cada teste que precisa de
// uma campanha cria a SUA: o UNIQUE(campanha_id, email) e por campanha, e reaproveitar a
// mesma entre testes faria um teste contaminar o outro.
function criarCampanha(campos = {}) {
  seq += 1;
  return run(
    `INSERT INTO campanhas (job_id, assunto, corpo_html, criterios, status)
     VALUES (?, ?, ?, ?, COALESCE(?, 'rascunho'))`,
    campos.job_id === undefined ? vagaId : campos.job_id,
    campos.assunto === undefined ? `Vaga aberta ${seq}` : campos.assunto,
    campos.corpo_html === undefined ? '<p>Corpo</p>' : campos.corpo_html,
    campos.criterios === undefined ? '{"origem":"direto"}' : campos.criterios,
    campos.status === undefined ? null : campos.status,
  );
}

function inserirEnvio(campanhaId, campos = {}) {
  return run(
    `INSERT INTO campanha_envios (campanha_id, email, nome, origem_tipo, origem_id)
     VALUES (?, ?, ?, ?, ?)`,
    campanhaId,
    campos.email === undefined ? 'pessoa@exemplo.com' : campos.email,
    campos.nome === undefined ? 'Pessoa Teste' : campos.nome,
    campos.origem_tipo === undefined ? 'application' : campos.origem_tipo,
    campos.origem_id === undefined ? 1 : campos.origem_id,
  );
}

// ── 1. As tres tabelas existem ──

test('migrar() cria as tres tabelas da Promocao de Vagas', () => {
  for (const tabela of ['campanhas', 'campanha_envios', 'descadastros']) {
    assert.ok(existeNoSqliteMaster('table', tabela), `tabela ausente: ${tabela}`);
  }
});

// ── 2. Os tres indices existem ──

test('migrar() cria os tres indices da Promocao de Vagas', () => {
  const indices = [
    'idx_applications_email',
    'idx_talentos_email',
    'idx_campanha_envios_pendentes',
  ];
  for (const indice of indices) {
    assert.ok(existeNoSqliteMaster('index', indice), `indice ausente: ${indice}`);
  }
});

// ── 3. Idempotencia no nivel do banco ──

test('UNIQUE(campanha_id, email): a mesma pessoa nao recebe a mesma campanha duas vezes', () => {
  const campanhaId = criarCampanha();
  inserirEnvio(campanhaId, { email: 'repetida@exemplo.com' });

  assert.throws(
    () => inserirEnvio(campanhaId, { email: 'repetida@exemplo.com' }),
    /UNIQUE constraint failed/,
    'o segundo envio do mesmo e-mail na mesma campanha precisa ser rejeitado pelo banco',
  );
});

test('UNIQUE(campanha_id, email): o mesmo e-mail em campanhas DIFERENTES e permitido', () => {
  const primeira = criarCampanha();
  const segunda = criarCampanha();
  inserirEnvio(primeira, { email: 'duas-campanhas@exemplo.com' });

  // A constraint trava a repeticao DENTRO de uma campanha, nao a pessoa participar de
  // varias — travar isso impediria divulgar uma segunda vaga para a mesma base.
  assert.doesNotThrow(() => inserirEnvio(segunda, { email: 'duas-campanhas@exemplo.com' }));
});

// ── 4 e 5. CHECKs de enum ──

test('CHECK de campanhas.status rejeita valor fora do enum', () => {
  assert.throws(
    () => criarCampanha({ status: 'enviada_talvez' }),
    /CHECK constraint failed/,
    'status fora do enum precisa ser rejeitado pelo banco, nao so pelo app',
  );
});

test('campanhas.status aceita os cinco valores previstos e defaulta para rascunho', () => {
  for (const status of ['rascunho', 'enfileirada', 'enviando', 'concluida', 'cancelada']) {
    assert.doesNotThrow(() => criarCampanha({ status }), `status valido rejeitado: ${status}`);
  }
  const id = criarCampanha();
  const linha = db.getDb().prepare('SELECT status FROM campanhas WHERE id = ?').get(id);
  assert.equal(linha.status, 'rascunho');
});

test('CHECK de campanha_envios.origem_tipo rejeita valor fora do enum', () => {
  const campanhaId = criarCampanha();
  assert.throws(
    () => inserirEnvio(campanhaId, { email: 'origem-ruim@exemplo.com', origem_tipo: 'talentos' }),
    /CHECK constraint failed/,
    "origem_tipo so aceita 'application' | 'talento' (singular)",
  );
});

test('campanha_envios.origem_tipo aceita application e talento', () => {
  const campanhaId = criarCampanha();
  assert.doesNotThrow(() =>
    inserirEnvio(campanhaId, { email: 'do-funil@exemplo.com', origem_tipo: 'application' }),
  );
  assert.doesNotThrow(() =>
    inserirEnvio(campanhaId, { email: 'do-banco@exemplo.com', origem_tipo: 'talento' }),
  );
});

test('origem_id nao tem FK: aceita id inexistente e tambem NULL', () => {
  const campanhaId = criarCampanha();
  // E rastro de auditoria, nao relacao — a origem pode ter sumido, e o registro de que o
  // e-mail saiu precisa sobreviver a isso.
  assert.doesNotThrow(() =>
    inserirEnvio(campanhaId, { email: 'orfao@exemplo.com', origem_id: 999999 }),
  );
  assert.doesNotThrow(() =>
    inserirEnvio(campanhaId, { email: 'sem-origem@exemplo.com', origem_id: null }),
  );
});

test('descadastros: e-mail e chave primaria (opt-out nao duplica)', () => {
  run("INSERT INTO descadastros (email, origem) VALUES ('saiu@exemplo.com', 'link_email')");
  assert.throws(
    () => run("INSERT INTO descadastros (email, origem) VALUES ('saiu@exemplo.com', 'manual')"),
    /UNIQUE constraint failed/,
  );
});

// ── 6. Idempotencia da migracao ──

test('migrar() e idempotente: rodar de novo nao lanca nem duplica', () => {
  assert.doesNotThrow(() => {
    migrar();
    migrar();
  });

  // As tabelas continuam la (nada foi recriado nem derrubado).
  for (const tabela of ['campanhas', 'campanha_envios', 'descadastros']) {
    assert.ok(existeNoSqliteMaster('table', tabela), `tabela sumiu apos re-migrar: ${tabela}`);
  }

  // E os dados gravados antes da re-migracao sobreviveram — CREATE TABLE IF NOT EXISTS
  // nunca pode virar um DROP/recriacao silenciosa.
  const n = db.getDb().prepare('SELECT COUNT(*) AS n FROM campanha_envios').get().n;
  assert.ok(n > 0, 'a re-migracao apagou os envios gravados');
});

// ── 7. campanhas: job_id opcional + coluna tipo (campanha de grupo) ──
//
// Mesmo par de motivos do bloco de campanhas_whatsapp em campanhaWhatsappMeta.test.js
// (linhas 159-218): aplicarSchema() (CREATE TABLE IF NOT EXISTS) nunca toca uma tabela que
// ja existe, entao o unico jeito de exercitar de verdade a migracao de recriacao e simular
// a mao o schema ANTIGO (job_id NOT NULL, sem coluna tipo) antes de chamar migrar().

// Limpa campanhas E as filhas que apontam pra elas, em ORDEM DE FK (filha antes da mae),
// antes de simular o schema antigo. SEM isto, o DROP TABLE campanhas abaixo apagaria so a
// tabela — as linhas de campanha_envios/vaga_acessos gravadas por testes ANTERIORES deste
// mesmo arquivo (que compartilham o mesmo banco temporario) sobreviveriam apontando para
// ids que deixaram de existir, um artefato do ISOLAMENTO DO TESTE (nao de migrate.js) que
// contaminaria a assercao de foreign_key_check() logo abaixo com violacoes que a migracao
// de verdade nunca causou. Mesmo padrao de zerar() em campanhaWhatsappMeta.test.js.
function limparCampanhasEFilhas() {
  db.getDb().exec('DELETE FROM grupo_acessos');
  db.getDb().exec('DELETE FROM vaga_acessos');
  db.getDb().exec('DELETE FROM campanha_envios');
  db.getDb().exec('DELETE FROM campanhas');
}

function simularSchemaAntigoDeCampanhas() {
  limparCampanhasEFilhas();
  db.getDb().exec('PRAGMA foreign_keys = OFF');
  db.getDb().exec('DROP TABLE campanhas');
  db.getDb().exec(`
    CREATE TABLE campanhas (
      id                  INTEGER PRIMARY KEY AUTOINCREMENT,
      job_id              INTEGER NOT NULL REFERENCES jobs(id),
      assunto             TEXT NOT NULL,
      corpo_html          TEXT NOT NULL,
      criterios           TEXT NOT NULL,
      status              TEXT NOT NULL DEFAULT 'rascunho'
                            CHECK (status IN ('rascunho', 'enfileirada', 'enviando', 'concluida', 'cancelada')),
      total_destinatarios INTEGER NOT NULL DEFAULT 0,
      criado_em           TEXT NOT NULL DEFAULT (datetime('now')),
      enfileirada_em      TEXT,
      finalizada_em       TEXT
    );
  `);
  db.getDb().exec('PRAGMA foreign_keys = ON');
}

test('migrate: campanhas com job_id NOT NULL (schema antigo) e recriada com job_id opcional + tipo, preservando linhas', () => {
  simularSchemaAntigoDeCampanhas();

  // Confirma que o estado simulado E o antigo: job_id NULL tem que ser recusado AGORA,
  // antes da migracao rodar — senao o teste provaria uma migracao que nao fez nada.
  assert.throws(
    () =>
      run(
        "INSERT INTO campanhas (job_id, assunto, corpo_html, criterios) VALUES (NULL, 'x', '<p>x</p>', '{}')",
      ),
    /NOT NULL constraint failed/,
  );

  const existente = run(
    `INSERT INTO campanhas (job_id, assunto, corpo_html, criterios, total_destinatarios)
     VALUES (?, 'Campanha pre-existente', '<p>Corpo</p>', '{"origem":"direto"}', 7)`,
    vagaId,
  );

  // FILHAS que ja apontam pra essa campanha ANTES do rebuild — a garantia que falta sem
  // isto: campanha_envios.campanha_id e vaga_acessos.campanha_id sao FK pra campanhas(id),
  // e o rebuild faz DROP TABLE campanhas com foreign_keys OFF. Sem uma linha filha real no
  // cenario, o teste provaria so que a CAMPANHA sobrevive — nao que ela continua sendo o
  // MESMO id que as tabelas dependentes ja referenciavam, e que o RENAME nao deixa nenhuma
  // orfa por trás. campanha_envios.campanha_id e NOT NULL (o caso mais estrito: uma FK
  // pendurada ali vira erro na primeira leitura via JOIN, nao um NULL silencioso).
  const envioExistente = run(
    `INSERT INTO campanha_envios (campanha_id, email, nome, origem_tipo, origem_id)
     VALUES (?, 'ja-tinha-envio@exemplo.com', 'Fulano', 'application', 1)`,
    existente,
  );
  const acessoExistente = run(
    'INSERT INTO vaga_acessos (job_id, campanha_id) VALUES (?, ?)',
    vagaId,
    existente,
  );

  migrar(); // idempotente — chamada de novo aqui simula o proximo boot apos o deploy

  // A linha pre-existente sobreviveu a recriacao da tabela, com os mesmos valores.
  const linha = db.getDb().prepare('SELECT * FROM campanhas WHERE id = ?').get(existente);
  assert.equal(linha.assunto, 'Campanha pre-existente');
  assert.equal(linha.job_id, vagaId);
  assert.equal(linha.total_destinatarios, 7);
  // tipo nao existia na linha antiga (nao fazia parte do INSERT...SELECT de origem) — herda
  // o DEFAULT da coluna nova, e o default precisa ser o comportamento de sempre.
  assert.equal(linha.tipo, 'divulgacao_vaga');

  // As FILHAS sobreviveram com o MESMO campanha_id — nao foram apagadas pelo DROP (que
  // atinge so a tabela `campanhas`) nem ficaram orfas depois do RENAME. O JOIN e a prova
  // forte: se o id tivesse mudado (ou a linha sumido), ele viria vazio.
  const envioDepois = db
    .getDb()
    .prepare('SELECT e.*, c.assunto FROM campanha_envios e JOIN campanhas c ON c.id = e.campanha_id WHERE e.id = ?')
    .get(envioExistente);
  assert.ok(envioDepois, 'o envio pre-existente nao pode sumir nem ficar orfao apos o rebuild');
  assert.equal(envioDepois.campanha_id, existente);
  assert.equal(envioDepois.assunto, 'Campanha pre-existente');

  const acessoDepois = db
    .getDb()
    .prepare('SELECT a.*, c.assunto FROM vaga_acessos a JOIN campanhas c ON c.id = a.campanha_id WHERE a.id = ?')
    .get(acessoExistente);
  assert.ok(acessoDepois, 'o acesso pre-existente nao pode sumir nem ficar orfao apos o rebuild');
  assert.equal(acessoDepois.campanha_id, existente);
  assert.equal(acessoDepois.assunto, 'Campanha pre-existente');

  // Prova geral, no nivel do proprio SQLite: nenhuma violacao de FK sobrou no banco
  // inteiro apos o rebuild (cobre qualquer outra tabela dependente que um teste futuro
  // esqueca de citar aqui a mao).
  const violacoes = db.getDb().pragma('foreign_key_check');
  assert.deepEqual(violacoes, [], 'o rebuild de campanhas nao pode deixar nenhuma FK pendurada');

  // E agora job_id NULL e aceito — campanha de grupo nao tem vaga.
  assert.doesNotThrow(() =>
    run(
      "INSERT INTO campanhas (job_id, tipo, assunto, corpo_html, criterios) VALUES (NULL, 'convite_grupo', 'y', '<p>y</p>', '{}')",
    ),
  );

  // CHECK de tipo continua protegendo o enum.
  assert.throws(
    () =>
      run(
        "INSERT INTO campanhas (job_id, tipo, assunto, corpo_html, criterios) VALUES (NULL, 'tipo_invalido', 'z', '<p>z</p>', '{}')",
      ),
    /CHECK constraint failed/,
  );
});

test('migrate: campanhas ja com job_id opcional (schema aplicado do zero) nao dispara a recriacao de novo', () => {
  const { linhas } = semRuido(() => migrar());
  assert.equal(linhas.some((l) => l.includes('campanhas recriada')), false);
});

function semRuido(fn) {
  const { log, warn, error } = console;
  const linhas = [];
  const cap = (...a) => linhas.push(a.join(' '));
  console.log = console.warn = console.error = cap;
  try {
    return { r: fn(), linhas };
  } finally {
    Object.assign(console, { log, warn, error });
  }
}

// ── 8. grupo_acessos: tabela nova, aditiva ──

test('migrar() cria grupo_acessos com id/slug/campanha_id/criado_em e o indice por campanha', () => {
  assert.ok(existeNoSqliteMaster('table', 'grupo_acessos'));
  assert.ok(existeNoSqliteMaster('index', 'idx_grupo_acessos_campanha'));

  const colunas = db.getDb().prepare('SELECT * FROM pragma_table_info(?)').all('grupo_acessos').map((c) => c.name);
  assert.deepEqual(colunas, ['id', 'slug', 'campanha_id', 'criado_em']);
});

test('grupo_acessos.campanha_id e opcional (clique sem campanha, ex.: botao do WhatsApp)', () => {
  assert.doesNotThrow(() =>
    run("INSERT INTO grupo_acessos (slug, campanha_id) VALUES ('joinville', NULL)"),
  );
});

test('grupo_acessos.campanha_id aceita id de campanha existente', () => {
  const campanhaId = criarCampanha();
  assert.doesNotThrow(() =>
    run('INSERT INTO grupo_acessos (slug, campanha_id) VALUES (?, ?)', 'joinville', campanhaId),
  );
});
