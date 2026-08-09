'use strict';

// Motor de publico da Promocao de Vagas (src/lib/promocaoVagas.js + as quatro consultas
// de leitura em sqlite.js).
//
// ESTE E O ARQUIVO QUE GUARDA QUEM RECEBE E-MAIL. Um erro no motor de publico nao aparece
// como excecao: aparece como uma campanha entregue a quem pediu para sair, ou a quem ja se
// candidatou a vaga que esta sendo promovida. Cada assercao abaixo trava uma dessas
// fronteiras, e nenhuma delas tem "despublicar" como conserto.
//
// NENHUMA REDE. Banco temporario em tmpdir, criado antes de qualquer require do app.

const os = require('node:os');
const path = require('node:path');

process.env.DATABASE_PATH = path.join(os.tmpdir(), `vm-test-promocao-${process.pid}-${Date.now()}.db`);
process.env.INTERVIEW_MOCK = 'true';
process.env.SESSION_SECRET = 'segredo-de-teste';
process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert/strict');

const db = require('../src/db');
const { migrar } = require('../src/db/migrate');
const promocao = require('../src/lib/promocaoVagas');

migrar();

// ── Helpers de cenario ──
const run = (sql, ...p) => Number(db.getDb().prepare(sql).run(...p).lastInsertRowid);

let seq = 0;

function criarVaga(perfil, titulo) {
  seq += 1;
  return run(
    'INSERT INTO jobs (slug, titulo, perfil) VALUES (?, ?, ?)',
    `vaga-${seq}`,
    titulo || `Vaga ${seq}`,
    perfil,
  );
}

function criarCandidatura({ jobId, email, nome = 'Fulano', utm, deletedAt = null, criadoEm = null }) {
  seq += 1;
  return run(
    `INSERT INTO applications (job_id, nome, sobrenome, email, token, utm_source, deleted_at, criado_em)
     VALUES (?, ?, 'Teste', ?, ?, ?, ?, COALESCE(?, datetime('now')))`,
    jobId,
    nome,
    email,
    `tok-promo-${seq}`,
    utm === undefined ? null : utm,
    deletedAt,
    criadoEm,
  );
}

function criarTalento({
  email,
  nome = 'Talento',
  criadoEm = null,
  perfilInteresse = null,
  status = 'novo',
}) {
  seq += 1;
  return run(
    `INSERT INTO talentos (nome, email, perfil_interesse, status, criado_em)
     VALUES (?, ?, ?, ?, COALESCE(?, datetime('now')))`,
    nome,
    email,
    perfilInteresse,
    status,
    criadoEm,
  );
}

// Cria entrevista + relatorio para dar `recomendacao` a uma candidatura. O motor le do
// relatorio MAIS RECENTE que nao falhou, entao o cenario precisa ser realista: passa por
// interviews, como em producao.
function darRecomendacao(applicationId, recomendacao, { status = 'gerado' } = {}) {
  seq += 1;
  const interviewId = run(
    "INSERT INTO interviews (application_id, perfil, status) VALUES (?, 'CLOSER', 'concluido')",
    applicationId,
  );
  return run(
    'INSERT INTO reports (interview_id, token, status, recomendacao) VALUES (?, ?, ?, ?)',
    interviewId,
    `tok-rep-${seq}`,
    status,
    recomendacao,
  );
}

const emails = (r) => r.itens.map((i) => i.email).sort();

// ── Cenario base ──
// Duas vagas: a ALVO (que sera promovida) e uma OUTRA (de onde vem o publico).
const vagaAlvo = criarVaga('CLOSER', 'Vaga Alvo');
const vagaOutraCloser = criarVaga('CLOSER', 'Outra Closer');
const vagaOutraSdr = criarVaga('SDR', 'Outra SDR');

// ── 1. Caso feliz ──

test('candidatura ativa em OUTRA vaga entra no publico da campanha', () => {
  criarCandidatura({ jobId: vagaOutraCloser, email: 'entra@exemplo.com' });

  const r = promocao.listarPublicoCampanha({ jobIdAlvo: vagaAlvo }, { db });
  assert.ok(emails(r).includes('entra@exemplo.com'));
  assert.equal(r.total, r.itens.length);
});

// ── 2. Exclusao 4a: ja inscrito na vaga ALVO ──

test('quem ja se candidatou a vaga ALVO NAO entra (candidatura ativa)', () => {
  criarCandidatura({ jobId: vagaAlvo, email: 'ja-inscrito@exemplo.com' });

  const r = promocao.listarPublicoCampanha({ jobIdAlvo: vagaAlvo }, { db });
  assert.ok(!emails(r).includes('ja-inscrito@exemplo.com'));
});

test('candidatura ARQUIVADA na vaga alvo tambem exclui (deleted_at nao livra)', () => {
  const email = 'arquivado-no-alvo@exemplo.com';
  criarCandidatura({ jobId: vagaAlvo, email, deletedAt: '2026-01-01 10:00:00' });
  // E tem uma candidatura ativa em outra vaga — mesmo assim nao pode receber.
  criarCandidatura({ jobId: vagaOutraCloser, email });

  const r = promocao.listarPublicoCampanha({ jobIdAlvo: vagaAlvo }, { db });
  assert.ok(!emails(r).includes(email), 'arquivada na vaga ALVO ainda conta como inscrito');
});

test('candidatura arquivada em OUTRA vaga NAO exclui (o publico e todo mundo)', () => {
  const email = 'arquivado-em-outra@exemplo.com';
  criarCandidatura({ jobId: vagaOutraCloser, email, deletedAt: '2026-01-01 10:00:00' });

  const r = promocao.listarPublicoCampanha({ jobIdAlvo: vagaAlvo }, { db });
  assert.ok(emails(r).includes(email));
});

// ── 3. Exclusao por descadastro ──

test('quem se descadastrou NAO entra, mesmo com candidatura valida em outra vaga', () => {
  const email = 'saiu@exemplo.com';
  criarCandidatura({ jobId: vagaOutraCloser, email });
  db.registrarDescadastro(email, 'link_email');

  const r = promocao.listarPublicoCampanha({ jobIdAlvo: vagaAlvo }, { db });
  assert.ok(!emails(r).includes(email));
});

test('descadastro vale para qualquer grafia do e-mail (normalizacao)', () => {
  criarCandidatura({ jobId: vagaOutraCloser, email: '  Saiu.Maiusculo@Exemplo.COM ' });
  db.registrarDescadastro('saiu.maiusculo@exemplo.com', 'manual');

  const r = promocao.listarPublicoCampanha({ jobIdAlvo: vagaAlvo }, { db });
  assert.ok(!emails(r).includes('saiu.maiusculo@exemplo.com'));
});

// ── 4 e 5. Deduplicacao ──

test('duas candidaturas da mesma pessoa (vagas diferentes) viram UMA linha', () => {
  const email = 'duplicada@exemplo.com';
  criarCandidatura({ jobId: vagaOutraCloser, email });
  const maisRecente = criarCandidatura({ jobId: vagaOutraSdr, email });

  const r = promocao.listarPublicoCampanha({ jobIdAlvo: vagaAlvo }, { db });
  const linhas = r.itens.filter((i) => i.email === email);
  assert.equal(linhas.length, 1, 'a mesma pessoa nao pode aparecer duas vezes');
  // Determinismo: entre candidaturas da mesma pessoa, vence a MAIS RECENTE (maior id).
  assert.equal(linhas[0].origemId, maisRecente);
});

test('pessoa em applications E em talentos: UMA linha, com applications prevalecendo', () => {
  const email = 'nos-dois@exemplo.com';
  const appId = criarCandidatura({ jobId: vagaOutraCloser, email, nome: 'DoFunil' });
  criarTalento({ email, nome: 'DoBancoDeTalentos' });

  const r = promocao.listarPublicoCampanha({ jobIdAlvo: vagaAlvo }, { db });
  const linhas = r.itens.filter((i) => i.email === email);
  assert.equal(linhas.length, 1);
  // COMPORTAMENTO ESPERADO, nao efeito colateral: a candidatura carrega mais contexto
  // (vaga, origem, avaliacao) que o cadastro de talento, entao ela vence a linha final.
  assert.equal(linhas[0].origemTipo, 'application');
  assert.equal(linhas[0].origemId, appId);
});

test('talento SEM candidatura entra normalmente, marcado como talento', () => {
  const email = 'so-talento@exemplo.com';
  const talentoId = criarTalento({ email });

  const r = promocao.listarPublicoCampanha({ jobIdAlvo: vagaAlvo }, { db });
  const linha = r.itens.find((i) => i.email === email);
  assert.ok(linha, 'talento tem que fazer parte do publico padrao');
  assert.equal(linha.origemTipo, 'talento');
  assert.equal(linha.origemId, talentoId);
});

// ── 10. Dedupe por e-mail NORMALIZADO ──

test('dedupe casa grafias diferentes entre as duas bases', () => {
  criarCandidatura({ jobId: vagaOutraCloser, email: 'Maria@X.com' });
  criarTalento({ email: '  maria@x.com ' });

  const r = promocao.listarPublicoCampanha({ jobIdAlvo: vagaAlvo }, { db });
  const linhas = r.itens.filter((i) => i.email === 'maria@x.com');
  assert.equal(linhas.length, 1, "'Maria@X.com' e ' maria@x.com ' sao a MESMA pessoa");
  assert.equal(linhas[0].origemTipo, 'application');
});

// ── 6 e 7. Filtro de perfil e a contagem de "sem atributo" ──

test('filtro de perfil: CLOSER entra, SDR nao, talento SEM perfil declarado nao', () => {
  const closer = 'perfil-closer@exemplo.com';
  const sdr = 'perfil-sdr@exemplo.com';
  const talento = 'perfil-talento@exemplo.com';
  criarCandidatura({ jobId: vagaOutraCloser, email: closer });
  criarCandidatura({ jobId: vagaOutraSdr, email: sdr });
  criarTalento({ email: talento }); // perfil_interesse NULL

  const r = promocao.listarPublicoCampanha({ jobIdAlvo: vagaAlvo, perfil: 'CLOSER' }, { db });
  const lista = emails(r);
  assert.ok(lista.includes(closer));
  assert.ok(!lista.includes(sdr));
  assert.ok(!lista.includes(talento), 'talento sem perfil_interesse = sem atributo = fora');
});

test('perfilIncluirSemAtributo: true traz de volta quem nao tem perfil', () => {
  const talento = 'perfil-talento@exemplo.com'; // criado no teste anterior, perfil NULL
  const r = promocao.listarPublicoCampanha(
    { jobIdAlvo: vagaAlvo, perfil: 'CLOSER', perfilIncluirSemAtributo: true },
    { db },
  );
  const lista = emails(r);
  assert.ok(lista.includes(talento));
  assert.ok(!lista.includes('perfil-sdr@exemplo.com'), 'SDR continua fora: ele TEM perfil');
});

// ── talentos.perfil_interesse conta como perfil (Correcao 1) ──

test('talento com perfil_interesse CLOSER entra no filtro CLOSER, sem flag nenhuma', () => {
  const email = 'talento-closer@exemplo.com';
  criarTalento({ email, perfilInteresse: 'CLOSER' });

  const r = promocao.listarPublicoCampanha({ jobIdAlvo: vagaAlvo, perfil: 'CLOSER' }, { db });
  assert.ok(
    emails(r).includes(email),
    'perfil_interesse e o atributo de perfil do talento, no mesmo pe de jobs.perfil',
  );
});

test('talento com perfil_interesse SDR NAO entra no filtro CLOSER, nem com a flag', () => {
  const email = 'talento-sdr@exemplo.com';
  criarTalento({ email, perfilInteresse: 'SDR' });

  const semFlag = promocao.listarPublicoCampanha(
    { jobIdAlvo: vagaAlvo, perfil: 'CLOSER' },
    { db },
  );
  const comFlag = promocao.listarPublicoCampanha(
    { jobIdAlvo: vagaAlvo, perfil: 'CLOSER', perfilIncluirSemAtributo: true },
    { db },
  );

  assert.ok(!emails(semFlag).includes(email));
  // A flag traz de volta quem NAO TEM o atributo. Este talento TEM perfil declarado,
  // ele so nao bate — entao continua fora.
  assert.ok(!emails(comFlag).includes(email), 'tem atributo, so nao casa: a flag nao o alcanca');
});

test('talento com perfil_interesse NULL segue exigindo incluirSemAtributo', () => {
  const email = 'talento-sem-perfil@exemplo.com';
  criarTalento({ email, perfilInteresse: null });

  const semFlag = promocao.listarPublicoCampanha(
    { jobIdAlvo: vagaAlvo, perfil: 'CLOSER' },
    { db },
  );
  const comFlag = promocao.listarPublicoCampanha(
    { jobIdAlvo: vagaAlvo, perfil: 'CLOSER', perfilIncluirSemAtributo: true },
    { db },
  );

  assert.ok(!emails(semFlag).includes(email));
  assert.ok(emails(comFlag).includes(email));
});

test('perfil_interesse conta mesmo quando applications vence a linha final', () => {
  // Pessoa nas duas bases: a candidatura (SDR) vence a ORIGEM da linha, mas o perfil
  // declarado no talento (CLOSER) tem que continuar contando como atributo da PESSOA.
  // Se a agregacao lesse os atributos depois de decidir a precedencia, este perfil
  // sumiria — foi exatamente o bug que a Correcao 1 exigiu corrigir na ordem do laco.
  const email = 'perfil-nas-duas-bases@exemplo.com';
  criarCandidatura({ jobId: vagaOutraSdr, email });
  criarTalento({ email, perfilInteresse: 'CLOSER' });

  const rCloser = promocao.listarPublicoCampanha(
    { jobIdAlvo: vagaAlvo, perfil: 'CLOSER' },
    { db },
  );
  const linha = rCloser.itens.find((i) => i.email === email);
  assert.ok(linha, 'o perfil declarado no talento tem que casar com o filtro');
  assert.equal(linha.origemTipo, 'application', 'mas a origem exibida segue sendo a candidatura');

  // E o perfil da candidatura tambem continua valendo: a pessoa tem os DOIS.
  const rSdr = promocao.listarPublicoCampanha({ jobIdAlvo: vagaAlvo, perfil: 'SDR' }, { db });
  assert.ok(emails(rSdr).includes(email));
});

test('excluidosPorFiltro.perfil conta os sem-atributo, com ou sem a flag ligada', () => {
  const semFlag = promocao.listarPublicoCampanha(
    { jobIdAlvo: vagaAlvo, perfil: 'CLOSER' },
    { db },
  );
  const comFlag = promocao.listarPublicoCampanha(
    { jobIdAlvo: vagaAlvo, perfil: 'CLOSER', perfilIncluirSemAtributo: true },
    { db },
  );

  // Quem a flag acrescenta e, por definicao, exatamente quem nao tem o atributo. Contar
  // assim (em vez de assumir "todo talento e sem perfil", como este teste fazia antes da
  // Correcao 1) mantem a assercao exata mesmo com o cenario crescendo.
  const jaEstavam = new Set(semFlag.itens.map((i) => i.email));
  const acrescentados = comFlag.itens.filter((i) => !jaEstavam.has(i.email));

  assert.ok(acrescentados.length > 0, 'o cenario precisa ter gente sem perfil');
  assert.equal(semFlag.excluidosPorFiltro.perfil, acrescentados.length);
  // O numero e o MESMO com a flag ligada: ele descreve quem nao tem o atributo, nao
  // quem acabou ficando de fora.
  assert.equal(comFlag.excluidosPorFiltro.perfil, acrescentados.length);
  assert.equal(comFlag.total, semFlag.total + acrescentados.length);
});

// ── 8. Nenhum filtro ativo ──

test('sem filtro opcional, excluidosPorFiltro e null em todos os campos (nao zero)', () => {
  const r = promocao.listarPublicoCampanha({ jobIdAlvo: vagaAlvo }, { db });
  assert.equal(r.excluidosPorFiltro.perfil, null);
  assert.equal(r.excluidosPorFiltro.utmSource, null);
  assert.equal(r.excluidosPorFiltro.recomendacao, null);
});

test('valor de enum invalido = filtro INATIVO (nao filtra, nao lanca)', () => {
  const semFiltro = promocao.listarPublicoCampanha({ jobIdAlvo: vagaAlvo }, { db });
  const comLixo = promocao.listarPublicoCampanha(
    { jobIdAlvo: vagaAlvo, perfil: 'GERENTE', recomendacao: 'quem-sabe' },
    { db },
  );
  assert.equal(comLixo.total, semFiltro.total);
  assert.equal(comLixo.excluidosPorFiltro.perfil, null);
  assert.equal(comLixo.excluidosPorFiltro.recomendacao, null);
});

// ── 9. Filtro de recomendacao (JOIN com reports via interviews) ──

test('filtro de recomendacao: le do relatorio; sem relatorio = sem atributo', () => {
  const comAvancar = 'rec-avancar@exemplo.com';
  const comDescartar = 'rec-descartar@exemplo.com';
  const semRelatorio = 'rec-nenhum@exemplo.com';
  const idA = criarCandidatura({ jobId: vagaOutraCloser, email: comAvancar });
  const idD = criarCandidatura({ jobId: vagaOutraCloser, email: comDescartar });
  criarCandidatura({ jobId: vagaOutraCloser, email: semRelatorio });
  darRecomendacao(idA, 'avancar');
  darRecomendacao(idD, 'descartar');

  const r = promocao.listarPublicoCampanha(
    { jobIdAlvo: vagaAlvo, recomendacao: 'avancar' },
    { db },
  );
  const lista = emails(r);
  assert.ok(lista.includes(comAvancar));
  assert.ok(!lista.includes(comDescartar));
  assert.ok(!lista.includes(semRelatorio), 'candidatura sem relatorio = sem atributo');

  const comFlag = promocao.listarPublicoCampanha(
    { jobIdAlvo: vagaAlvo, recomendacao: 'avancar', recomendacaoIncluirSemAtributo: true },
    { db },
  );
  assert.ok(emails(comFlag).includes(semRelatorio));
  assert.ok(!emails(comFlag).includes(comDescartar), 'quem TEM outro veredito segue fora');
});

test('recomendacao ignora relatorio com status erro e usa o mais recente', () => {
  const email = 'rec-reprocessado@exemplo.com';
  const appId = criarCandidatura({ jobId: vagaOutraCloser, email });
  darRecomendacao(appId, 'descartar'); // primeiro veredito
  darRecomendacao(appId, 'avancar'); // reprocessamento posterior
  darRecomendacao(appId, 'talvez', { status: 'erro' }); // falhou: nao pode contar

  const r = promocao.listarPublicoCampanha(
    { jobIdAlvo: vagaAlvo, recomendacao: 'avancar' },
    { db },
  );
  assert.ok(emails(r).includes(email), 'vale o relatorio mais recente que nao falhou');
});

// ── Filtro de origem (utm_source) ──

test('filtro de utmSource usa os mesmos baldes do painel; talento fica sem atributo', () => {
  const meta = 'utm-meta@exemplo.com';
  const grupoA = 'utm-grupo-a@exemplo.com';
  const grupoB = 'utm-grupo-b@exemplo.com';
  criarCandidatura({ jobId: vagaOutraCloser, email: meta, utm: 'meta' });
  // As duas grafias historicas caem no MESMO balde (origemCanonica).
  criarCandidatura({ jobId: vagaOutraCloser, email: grupoA, utm: 'grupo-whats' });
  criarCandidatura({ jobId: vagaOutraCloser, email: grupoB, utm: 'grupowhats' });

  const rMeta = promocao.listarPublicoCampanha(
    { jobIdAlvo: vagaAlvo, utmSource: 'meta' },
    { db },
  );
  assert.deepEqual(emails(rMeta), [meta]);

  const rGrupo = promocao.listarPublicoCampanha(
    { jobIdAlvo: vagaAlvo, utmSource: 'grupo-whats' },
    { db },
  );
  assert.deepEqual(emails(rGrupo).sort(), [grupoA, grupoB].sort());
});

test('candidatura sem utm_source cai no balde "direto", nao em "sem atributo"', () => {
  const direto = 'utm-direto@exemplo.com';
  criarCandidatura({ jobId: vagaOutraCloser, email: direto, utm: null });

  const r = promocao.listarPublicoCampanha(
    { jobIdAlvo: vagaAlvo, utmSource: 'direto' },
    { db },
  );
  assert.ok(emails(r).includes(direto), 'utm_source NULL significa direto, nao ausente');
  // Os "sem atributo" de utm sao so os talentos, que nao tem a coluna.
  assert.ok(r.excluidosPorFiltro.utmSource > 0);
});

// ── Janela de datas ──

test('dataDe/dataAte recortam as DUAS bases pelo criado_em', () => {
  const antigo = 'data-antiga@exemplo.com';
  const novo = 'data-nova@exemplo.com';
  const talentoAntigo = 'data-talento-antigo@exemplo.com';
  criarCandidatura({ jobId: vagaOutraCloser, email: antigo, criadoEm: '2020-01-15 10:00:00' });
  criarCandidatura({ jobId: vagaOutraCloser, email: novo, criadoEm: '2020-06-15 10:00:00' });
  criarTalento({ email: talentoAntigo, criadoEm: '2020-01-20 10:00:00' });

  const r = promocao.listarPublicoCampanha(
    { jobIdAlvo: vagaAlvo, dataDe: '2020-01-01', dataAte: '2020-01-31' },
    { db },
  );
  const lista = emails(r);
  assert.ok(lista.includes(antigo));
  assert.ok(lista.includes(talentoAntigo), 'talentos tambem tem criado_em e entram na janela');
  assert.ok(!lista.includes(novo));
});

// ── Decomposicao por origem ──

test('porOrigem soma exatamente o total', () => {
  const r = promocao.listarPublicoCampanha({ jobIdAlvo: vagaAlvo }, { db });
  assert.equal(r.porOrigem.applications + r.porOrigem.talentos, r.total);
  assert.equal(r.total, r.itens.length);
});

test('nenhum item do publico vem sem e-mail ou sem origem', () => {
  const r = promocao.listarPublicoCampanha({ jobIdAlvo: vagaAlvo }, { db });
  for (const item of r.itens) {
    assert.ok(item.email && item.email.trim(), 'item sem e-mail no publico');
    assert.ok(['application', 'talento'].includes(item.origemTipo));
    assert.ok(Number.isInteger(item.origemId));
  }
});

// ── Exclusao automatica: talento descartado (Correcao 2) ──

test('talento com status descartado NAO entra, sem nenhum filtro ativo', () => {
  const email = 'talento-descartado@exemplo.com';
  criarTalento({ email, status: 'descartado' });

  const r = promocao.listarPublicoCampanha({ jobIdAlvo: vagaAlvo }, { db });
  assert.ok(!emails(r).includes(email), 'descartado e exclusao automatica, nao filtro');
});

test('talento com status convertido entra normalmente', () => {
  const email = 'talento-convertido@exemplo.com';
  criarTalento({ email, status: 'convertido' });

  const r = promocao.listarPublicoCampanha({ jobIdAlvo: vagaAlvo }, { db });
  assert.ok(emails(r).includes(email));
});

test('talento descartado nao entra nem quando o perfil dele casa com o filtro', () => {
  // A exclusao de status e AUTOMATICA: ela nao esta condicionada a nenhum filtro, e
  // nenhum filtro a contorna. Casar no perfil nao ressuscita quem foi descartado.
  const email = 'talento-descartado-closer@exemplo.com';
  criarTalento({ email, perfilInteresse: 'CLOSER', status: 'descartado' });

  const semFiltro = promocao.listarPublicoCampanha({ jobIdAlvo: vagaAlvo }, { db });
  const comPerfil = promocao.listarPublicoCampanha(
    { jobIdAlvo: vagaAlvo, perfil: 'CLOSER' },
    { db },
  );
  const comFlag = promocao.listarPublicoCampanha(
    { jobIdAlvo: vagaAlvo, perfil: 'CLOSER', perfilIncluirSemAtributo: true },
    { db },
  );

  assert.ok(!emails(semFiltro).includes(email));
  assert.ok(!emails(comPerfil).includes(email));
  assert.ok(!emails(comFlag).includes(email));
});

test('os outros tres status de talento seguem elegiveis', () => {
  for (const status of ['novo', 'contatado', 'convertido']) {
    const email = `talento-status-${status}@exemplo.com`;
    criarTalento({ email, status });
    const r = promocao.listarPublicoCampanha({ jobIdAlvo: vagaAlvo }, { db });
    assert.ok(emails(r).includes(email), `status '${status}' deveria ser elegivel`);
  }
});

// ── 11. jobIdAlvo invalido ──

test('jobIdAlvo ausente ou invalido LANCA (nao devolve publico vazio nem completo)', () => {
  for (const ruim of [undefined, null, 0, -1, 'abc', {}, NaN]) {
    assert.throws(
      () => promocao.listarPublicoCampanha({ jobIdAlvo: ruim }, { db }),
      /jobIdAlvo invalido/,
      `deveria lancar para ${JSON.stringify(ruim)}`,
    );
  }
});

test('jobIdAlvo de vaga inexistente devolve publico (nao lanca): ninguem se inscreveu nela', () => {
  // Id bem-formado, vaga inexistente: nao ha candidatura com aquele job_id, entao a
  // exclusao 4a simplesmente nao remove ninguem. Isso e diferente de id malformado.
  const r = promocao.listarPublicoCampanha({ jobIdAlvo: 999999 }, { db });
  assert.ok(r.total > 0);
});
