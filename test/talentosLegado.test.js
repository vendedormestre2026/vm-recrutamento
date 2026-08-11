'use strict';

// Insercao em lote de talentos da base legada (db.criarTalentosLegado).
//
// PRIMEIRO teste dedicado a `talentos` no projeto. Ate aqui a tabela so era exercitada de
// lado, por SQL cru dentro dos testes de campanha (promocaoVagas.test.js,
// promocaoIntegracao.test.js) — que driblam a camada de dados inteira e por isso nunca
// disseram nada sobre criarTalento nem sobre validacao.
//
// O QUE ESTE ARQUIVO GUARDA, e por que cada coisa importa:
//   consent_at NULL — a base legada nao tem dado de consentimento. Se algum dia alguem
//     "consertar" isso reusando criarTalento (que crava datetime('now')), 7 mil linhas
//     passariam a afirmar um aceite que nunca houve. E o teste mais importante daqui.
//   criado_em explicito — e a coluna que o filtro de data da campanha usa
//     (listarTalentosParaCampanha). Cair no default faria a base inteira parecer cadastrada
//     no dia da importacao.
//   idempotencia — `talentos.email` NAO e unico. Sem o filtro da funcao, um `--commit`
//     rodado duas vezes duplicaria 7 mil pessoas, sem desfazer barato.
//   validacao que LANCA — `categoria` e `cargo` nao tem CHECK no banco; esta e a unica
//     barreira que existe.
//
// SEM REDE: so banco temporario.

const os = require('node:os');
const path = require('node:path');

process.env.DATABASE_PATH = path.join(os.tmpdir(), `vm-test-talentos-legado-${process.pid}-${Date.now()}.db`);
process.env.INTERVIEW_MOCK = 'true';
process.env.SESSION_SECRET = 'segredo-de-teste';
process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert/strict');

const db = require('../src/db');
const { migrar } = require('../src/db/migrate');

migrar();

let seq = 0;

// Registro valido minimo. Cada teste sobrescreve so o que lhe interessa.
function registro(campos = {}) {
  seq += 1;
  return {
    nome: 'Pessoa Legada',
    email: `pessoa${seq}@exemplo.com`,
    telefone: '+55 47989251350',
    perfil_interesse: null,
    categoria: 'legado',
    cargo: 'Vendedor',
    campos_extras: JSON.stringify({ empresa_origem: 'Godi Transportes' }),
    consent_at: null,
    criado_em: '2025-09-29 03:04:27',
    ...campos,
  };
}

const buscarPorEmail = (email) =>
  db.getDb().prepare('SELECT * FROM talentos WHERE email = ?').get(email);

const contarTalentos = () =>
  db.getDb().prepare('SELECT COUNT(*) AS n FROM talentos').get().n;

// ══════════════════════════════════════════════════════════════
// 1. O caminho feliz
// ══════════════════════════════════════════════════════════════

test('grava as colunas da importacao exatamente como recebidas', () => {
  const r = registro({
    email: 'completo@exemplo.com',
    nome: 'Railson Campos Santos',
    telefone: '+55 47989251350',
    cargo: 'Consultor Comercial',
    campos_extras: JSON.stringify({
      empresa_origem: 'Godi Transportes',
      codigo_vaga_origem: 'PS0001',
      utm_source_origem: 'lp_formulario',
    }),
    criado_em: '2025-09-29 03:04:27',
  });

  const resultado = db.criarTalentosLegado([r]);
  assert.deepEqual(resultado, { inseridos: 1, ignorados: 0 });

  const linha = buscarPorEmail('completo@exemplo.com');
  assert.equal(linha.nome, 'Railson Campos Santos');
  assert.equal(linha.telefone, '+55 47989251350');
  assert.equal(linha.categoria, 'legado');
  assert.equal(linha.cargo, 'Consultor Comercial');
  assert.equal(linha.criado_em, '2025-09-29 03:04:27');
  assert.deepEqual(JSON.parse(linha.campos_extras), {
    empresa_origem: 'Godi Transportes',
    codigo_vaga_origem: 'PS0001',
    utm_source_origem: 'lp_formulario',
  });
});

test('consent_at fica NULL — a origem nao tem consentimento e nao se inventa um', () => {
  db.criarTalentosLegado([registro({ email: 'sem-consent@exemplo.com' })]);
  const linha = buscarPorEmail('sem-consent@exemplo.com');
  assert.equal(linha.consent_at, null, 'carimbar a data da importacao afirmaria um aceite inexistente');
});

test('criado_em vem do parametro, nao do default datetime(now)', () => {
  db.criarTalentosLegado([registro({ email: 'data-antiga@exemplo.com', criado_em: '2024-01-15 08:30:00' })]);
  const linha = buscarPorEmail('data-antiga@exemplo.com');
  assert.equal(linha.criado_em, '2024-01-15 08:30:00');
  // Sanidade: nao e a data de hoje. Se o default tivesse vencido, isto pegaria.
  assert.doesNotMatch(linha.criado_em, new RegExp(`^${new Date().getUTCFullYear()}-`));
});

test('status cai no default novo — e o que torna o talento elegivel a campanha', () => {
  // listarTalentosParaCampanha exclui `status = 'descartado'`. Nascer 'novo' e o que faz os
  // legados entrarem no publico automaticamente, sem nenhuma mudanca no motor.
  db.criarTalentosLegado([registro({ email: 'status-default@exemplo.com' })]);
  assert.equal(buscarPorEmail('status-default@exemplo.com').status, 'novo');
});

test('perfil_interesse: preenchido quando o cargo mapeia, NULL quando nao mapeia', () => {
  db.criarTalentosLegado([
    registro({ email: 'sdr@exemplo.com', cargo: 'SDR', perfil_interesse: 'SDR' }),
    registro({ email: 'closer@exemplo.com', cargo: 'Closer', perfil_interesse: 'CLOSER' }),
    registro({ email: 'bdr@exemplo.com', cargo: 'BDR', perfil_interesse: null }),
    registro({ email: 'lider@exemplo.com', cargo: 'Liderança Comercial', perfil_interesse: null }),
  ]);

  assert.equal(buscarPorEmail('sdr@exemplo.com').perfil_interesse, 'SDR');
  assert.equal(buscarPorEmail('closer@exemplo.com').perfil_interesse, 'CLOSER');
  assert.equal(buscarPorEmail('bdr@exemplo.com').perfil_interesse, null);
  assert.equal(buscarPorEmail('lider@exemplo.com').perfil_interesse, null);
  // O cargo fiel sobrevive nos quatro casos — e o ponto de ter coluna separada.
  assert.equal(buscarPorEmail('bdr@exemplo.com').cargo, 'BDR');
  assert.equal(buscarPorEmail('lider@exemplo.com').cargo, 'Liderança Comercial');
});

test('lote vazio nao quebra e nao grava', () => {
  const antes = contarTalentos();
  assert.deepEqual(db.criarTalentosLegado([]), { inseridos: 0, ignorados: 0 });
  assert.deepEqual(db.criarTalentosLegado(null), { inseridos: 0, ignorados: 0 });
  assert.equal(contarTalentos(), antes);
});

// ══════════════════════════════════════════════════════════════
// 2. Idempotencia — a garantia que substitui o UNIQUE ausente
// ══════════════════════════════════════════════════════════════

test('rodar o MESMO lote duas vezes nao duplica ninguem', () => {
  const lote = [
    registro({ email: 'repete-a@exemplo.com' }),
    registro({ email: 'repete-b@exemplo.com' }),
  ];

  assert.deepEqual(db.criarTalentosLegado(lote), { inseridos: 2, ignorados: 0 });
  assert.deepEqual(
    db.criarTalentosLegado(lote),
    { inseridos: 0, ignorados: 2 },
    'a segunda passada tem que ser inteiramente ignorada',
  );

  const n = db
    .getDb()
    .prepare("SELECT COUNT(*) AS n FROM talentos WHERE email = 'repete-a@exemplo.com'")
    .get().n;
  assert.equal(n, 1);
});

test('duplicata DENTRO do proprio lote entra uma vez so', () => {
  const resultado = db.criarTalentosLegado([
    registro({ email: 'dup-interna@exemplo.com', nome: 'Primeira' }),
    registro({ email: 'dup-interna@exemplo.com', nome: 'Segunda' }),
  ]);
  assert.deepEqual(resultado, { inseridos: 1, ignorados: 1 });
  assert.equal(buscarPorEmail('dup-interna@exemplo.com').nome, 'Primeira', 'vence a primeira do lote');
});

test('colide com talento pre-existente cadastrado pelo fluxo normal', () => {
  // O caso real: alguem da base legada ja se cadastrou sozinho em /bancodecurriculos.
  // A linha existente NAO pode ser sobrescrita — ela tem consent_at de verdade.
  db.criarTalento({ nome: 'Ja Cadastrada', email: 'jacadastrada@exemplo.com', perfil_interesse: 'CLOSER' });
  const consentOriginal = buscarPorEmail('jacadastrada@exemplo.com').consent_at;
  assert.ok(consentOriginal, 'sanidade: o cadastro normal grava consent_at');

  const resultado = db.criarTalentosLegado([registro({ email: 'jacadastrada@exemplo.com' })]);
  assert.deepEqual(resultado, { inseridos: 0, ignorados: 1 });

  const linha = buscarPorEmail('jacadastrada@exemplo.com');
  assert.equal(linha.consent_at, consentOriginal, 'o consentimento real nao pode ser apagado');
  assert.equal(linha.categoria, null, 'a linha existente continua nao sendo legado');
});

test('a colisao usa e-mail NORMALIZADO dos dois lados', () => {
  // `talentos.email` nunca passou por normalizacao na escrita (ver criarTalento), entao a
  // base tem enderecos com caixa e espaco misturados. Comparar cru deixaria a duplicata
  // passar exatamente nos casos que mais parecem iguais para um humano.
  db.getDb()
    .prepare('INSERT INTO talentos (nome, email) VALUES (?, ?)')
    .run('Caixa Alta', '  MISTURADA@Exemplo.COM  ');

  const resultado = db.criarTalentosLegado([registro({ email: 'misturada@exemplo.com' })]);
  assert.deepEqual(resultado, { inseridos: 0, ignorados: 1 });
});

test('o e-mail e gravado JA normalizado', () => {
  db.criarTalentosLegado([registro({ email: '  Nova.Pessoa@Exemplo.COM  ' })]);
  assert.ok(buscarPorEmail('nova.pessoa@exemplo.com'), 'gravado em minusculas e sem espaco');
});

test('registro sem e-mail e ignorado, nunca gravado', () => {
  // Sem e-mail nao ha como deduplicar nem como enviar campanha: seria linha morta.
  const resultado = db.criarTalentosLegado([
    registro({ email: '' }),
    registro({ email: '   ' }),
    registro({ email: null }),
  ]);
  assert.deepEqual(resultado, { inseridos: 0, ignorados: 3 });
});

// ══════════════════════════════════════════════════════════════
// 3. Validacao: LANCA e reverte a transacao inteira
// ══════════════════════════════════════════════════════════════

test('categoria fora da allowlist LANCA', () => {
  assert.throws(
    () => db.criarTalentosLegado([registro({ categoria: 'antiga' })]),
    /categoria invalida/i,
  );
  assert.throws(() => db.criarTalentosLegado([registro({ categoria: null })]), /categoria invalida/i);
});

test('cargo fora da allowlist LANCA (inclusive os excluidos da importacao)', () => {
  for (const cargo of ['CS', 'fullstack', 'Consultor', 'consultor-comercial-sp', '']) {
    assert.throws(
      () => db.criarTalentosLegado([registro({ cargo })]),
      /cargo invalido/i,
      `cargo nao canonico deveria ser recusado: ${JSON.stringify(cargo)}`,
    );
  }
});

test('perfil_interesse fora do enum LANCA antes de bater no CHECK do schema', () => {
  assert.throws(
    () => db.criarTalentosLegado([registro({ perfil_interesse: 'BDR' })]),
    /perfil_interesse invalido/i,
  );
});

test('criado_em ausente LANCA com mensagem que explica o porque', () => {
  for (const vazio of [undefined, null, '', '   ']) {
    assert.throws(() => db.criarTalentosLegado([registro({ criado_em: vazio })]), /criado_em ausente/i);
  }
});

test('UM registro invalido reverte o lote INTEIRO (nada entra pela metade)', () => {
  // A garantia da transacao. Sem ela, uma importacao abortada no meio deixaria o operador
  // sem saber onde parou — e sem UNIQUE na tabela, nao ha como retomar com seguranca.
  const antes = contarTalentos();
  assert.throws(() =>
    db.criarTalentosLegado([
      registro({ email: 'valida-1@exemplo.com' }),
      registro({ email: 'valida-2@exemplo.com' }),
      registro({ email: 'invalida@exemplo.com', cargo: 'Cargo Inventado' }),
    ]),
  );
  assert.equal(contarTalentos(), antes, 'nenhuma das validas pode ter sobrado');
  assert.equal(buscarPorEmail('valida-1@exemplo.com'), undefined);
});

// ══════════════════════════════════════════════════════════════
// 4. As allowlists exportadas
// ══════════════════════════════════════════════════════════════

test('as allowlists exportadas sao as decididas', () => {
  assert.deepEqual(db.CATEGORIAS_TALENTO_VALIDAS, ['legado']);
  assert.deepEqual(db.CARGOS_TALENTO_VALIDOS, [
    'Consultor Comercial',
    'Vendedor',
    'SDR',
    'BDR',
    'Closer',
    'Liderança Comercial',
  ]);
});
