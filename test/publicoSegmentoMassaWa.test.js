'use strict';

// Segmento da base no disparo em massa (lib/publicoSegmentoMassaWa) e o despachante
// montarPublicoDaCampanha (lib/publicoMassaWhatsapp), sobre banco REAL em tmp — mesma razao do
// teste do motor de vagas abertas: metade dos recortes e SQL, e um WHERE errado so aparece com
// banco de verdade. Nenhuma rede, nenhum socket, nenhuma credencial.

const os = require('node:os');
const path = require('node:path');

process.env.DATABASE_PATH = path.join(
  os.tmpdir(),
  `vm-test-segmento-massa-wa-${process.pid}-${Date.now()}.db`,
);
process.env.INTERVIEW_MOCK = 'true';
process.env.SESSION_SECRET = 'segredo-de-teste';
process.env.NODE_ENV = 'test';

const fs = require('node:fs');
const test = require('node:test');
const assert = require('node:assert/strict');

const db = require('../src/db');
const { migrar } = require('../src/db/migrate');
const seg = require('../src/lib/publicoSegmentoMassaWa');
const publico = require('../src/lib/publicoMassaWhatsapp');
const optout = require('../src/lib/optoutWhatsapp');

migrar();

const AGORA = new Date('2026-10-09T15:00:00Z');
let seq = 0;

function novaVaga({ ativo = true, cidade = 'Joinville' } = {}) {
  seq += 1;
  return db.criarVaga({ slug: `vaga-seg-${seq}`, titulo: `Vaga ${seq}`, perfil: 'CLOSER', cidade, ativo });
}

// `consentiu` default TRUE: o segmento exige consent_at, e os testes que nao sao SOBRE isso nao
// devem cair nessa linha por acidente.
function novaCandidatura({ jobId, telefone, nome = 'Pessoa', status = null, arquivada = false, criadoEm = '2026-10-01 12:00:00', email = null, consentiu = true }) {
  return Number(
    db.getDb()
      .prepare(
        `INSERT INTO applications (job_id, nome, telefone, email, status_recrutador, deleted_at, criado_em, consent_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(jobId, nome, telefone, email, status, arquivada ? '2026-01-01 00:00:00' : null, criadoEm,
        consentiu ? criadoEm : null)
      .lastInsertRowid,
  );
}

let telSeq = 0;
function telefone() {
  telSeq += 1;
  return `47999${String(500000 + telSeq).padStart(6, '0')}`;
}

function limpar() {
  const conn = db.getDb();
  for (const t of [
    'campanhas_massa_wa_envios', 'campanhas_massa_wa_variacoes', 'campanhas_massa_wa',
    'campanha_whatsapp_envios', 'campanhas_whatsapp', 'templates_whatsapp',
    'campanha_envios', 'campanhas', 'disparos_whatsapp',
    'applications', 'whatsapp_optout', 'whatsapp_opt_out', 'jobs',
  ]) conn.exec(`DELETE FROM ${t}`);
}

// Cenario base: vaga-alvo aberta em Joinville + uma vaga encerrada de Joinville (a origem).
function cenario() {
  limpar();
  const alvo = novaVaga();
  const origem = novaVaga({ ativo: false });
  return { alvo, origem };
}

const montar = (crit, deps = {}) =>
  seg.montarPublicoSegmentoMassaWa({ cidade: 'Joinville', teto: 100, diasOutrosCanais: 0, ...crit }, { agora: AGORA, ...deps });
// Os itens saem NORMALIZADOS (com DDI 55); os fixtures entram sem DDI, como os do outro motor.
const semDdi = (t) => String(t).replace(/^55/, '');
const tels = (r) => r.itens.map((i) => semDdi(i.telefone)).sort();

test.after(() => {
  for (const suf of ['', '-wal', '-shm']) fs.rmSync(`${process.env.DATABASE_PATH}${suf}`, { force: true });
});

// ══════════════════ criterios ══════════════════

test('teto e OBRIGATORIO: sem teto o motor lanca, e nao cai num default', () => {
  const { alvo } = cenario();
  assert.throws(() => seg.montarPublicoSegmentoMassaWa({ vagaAlvoId: alvo, cidade: 'Joinville' }), /teto/);
});

test('teto acima de 100 e recusado', () => {
  const { alvo } = cenario();
  assert.throws(() => montar({ vagaAlvoId: alvo, teto: 101 }), /teto_maximo/);
  assert.equal(seg.sanearCriteriosSegmento({ vagaAlvoId: 1, cidade: 'X', teto: 100 }).erros.length, 0);
});

test('vaga-alvo encerrada e recusada', () => {
  const { origem } = cenario();
  assert.throws(() => montar({ vagaAlvoId: origem }), /nao esta aberta/);
});

test('cidade fora do vocabulario e recusada', () => {
  const { alvo } = cenario();
  assert.throws(() => montar({ vagaAlvoId: alvo, cidade: 'Joinvile' }), /vocabulario/);
});

test('N de outros canais: ausente = 14, "0" = 0, negativo e erro', () => {
  assert.equal(seg.sanearCriteriosSegmento({}).criterios.diasOutrosCanais, 14);
  assert.equal(seg.sanearCriteriosSegmento({ diasOutrosCanais: '0' }).criterios.diasOutrosCanais, 0);
  assert.ok(seg.sanearCriteriosSegmento({ diasOutrosCanais: '-3' }).erros.includes('dias_outros_canais'));
});

// ══════════════════ cidade e janela ══════════════════

test('so entra candidatura a vaga da cidade pedida (cidade comparada por chave, sem acento/caixa)', () => {
  const { alvo, origem } = cenario();
  const outraCidade = novaVaga({ ativo: false, cidade: 'Barueri' });
  const a = telefone();
  const b = telefone();
  novaCandidatura({ jobId: origem, telefone: a });
  novaCandidatura({ jobId: outraCidade, telefone: b });
  const r = montar({ vagaAlvoId: alvo, cidade: 'joinvílle' });
  assert.deepEqual(tels(r), [a]);
});

test('vaga REMOTA (cidade NULL) nao entra no recorte por cidade', () => {
  const { alvo } = cenario();
  const remota = novaVaga({ ativo: false, cidade: null });
  novaCandidatura({ jobId: remota, telefone: telefone() });
  assert.equal(montar({ vagaAlvoId: alvo }).funil.candidaturas, 0);
});

test('JANELA em dia de Brasilia: 22h BRT do dia 05 (01h UTC do dia 06) conta como dia 05', () => {
  const { alvo, origem } = cenario();
  const dentro = telefone();
  const fora = telefone();
  novaCandidatura({ jobId: origem, telefone: dentro, criadoEm: '2026-10-06 01:00:00' }); // 05/10 22:00 BRT
  novaCandidatura({ jobId: origem, telefone: fora, criadoEm: '2026-10-06 03:00:00' }); // 06/10 00:00 BRT
  const r = montar({ vagaAlvoId: alvo, dataDe: '2026-10-05', dataAte: '2026-10-05' });
  assert.deepEqual(tels(r), [dentro]);
});

test('JANELA: 02h BRT do dia 05 (05h UTC) entra em "de 05"; 23h BRT do dia 04 (02h UTC do 05) nao', () => {
  const { alvo, origem } = cenario();
  const dentro = telefone();
  const fora = telefone();
  novaCandidatura({ jobId: origem, telefone: dentro, criadoEm: '2026-10-05 05:00:00' });
  novaCandidatura({ jobId: origem, telefone: fora, criadoEm: '2026-10-05 02:00:00' });
  const r = montar({ vagaAlvoId: alvo, dataDe: '2026-10-05' });
  assert.deepEqual(tels(r), [dentro]);
});

test('a pessoa entra se ALGUMA candidatura dela cair na janela', () => {
  const { alvo, origem } = cenario();
  const outra = novaVaga({ ativo: false });
  const t = telefone();
  novaCandidatura({ jobId: origem, telefone: t, criadoEm: '2026-07-01 12:00:00' });
  novaCandidatura({ jobId: outra, telefone: t, criadoEm: '2026-10-02 12:00:00' });
  assert.deepEqual(tels(montar({ vagaAlvoId: alvo, dataDe: '2026-10-01' })), [t]);
});

test('vagas de origem (opcional) recortam a base', () => {
  const { alvo, origem } = cenario();
  const outra = novaVaga({ ativo: false });
  const a = telefone();
  novaCandidatura({ jobId: origem, telefone: a });
  novaCandidatura({ jobId: outra, telefone: telefone() });
  assert.deepEqual(tels(montar({ vagaAlvoId: alvo, vagasOrigem: [origem] })), [a]);
});

// ══════════════════ exclusoes ══════════════════

test('candidatura ARQUIVADA nao conta, e aparece na linha propria', () => {
  const { alvo, origem } = cenario();
  novaCandidatura({ jobId: origem, telefone: telefone(), arquivada: true });
  const r = montar({ vagaAlvoId: alvo });
  assert.equal(r.funil.candidaturasArquivadas, 1);
  assert.equal(r.funil.total, 0);
});

test('EM PROCESSO (P2): Sem decisao ou Em analise em vaga ABERTA da cidade fica fora', () => {
  const { alvo, origem } = cenario();
  const aberta = novaVaga();
  const sd = telefone();
  const ea = telefone();
  for (const [t, st] of [[sd, null], [ea, 'em_analise']]) {
    novaCandidatura({ jobId: origem, telefone: t });
    novaCandidatura({ jobId: aberta, telefone: t, status: st });
  }
  const r = montar({ vagaAlvoId: alvo });
  assert.equal(r.funil.pessoasEmProcesso, 2);
  assert.equal(r.funil.total, 0);
});

test('REPROVADO em vaga aberta NAO e "em processo" e entra', () => {
  const { alvo, origem } = cenario();
  const aberta = novaVaga();
  const t = telefone();
  novaCandidatura({ jobId: origem, telefone: t });
  novaCandidatura({ jobId: aberta, telefone: t, status: 'reprovado' });
  assert.deepEqual(tels(montar({ vagaAlvoId: alvo })), [t]);
});

test('candidatura ARQUIVADA em vaga aberta nao prende a pessoa em processo', () => {
  const { alvo, origem } = cenario();
  const aberta = novaVaga();
  const t = telefone();
  novaCandidatura({ jobId: origem, telefone: t });
  novaCandidatura({ jobId: aberta, telefone: t, arquivada: true });
  assert.equal(montar({ vagaAlvoId: alvo }).funil.pessoasEmProcesso, 0);
});

test('em processo em vaga aberta de OUTRA cidade nao exclui', () => {
  const { alvo, origem } = cenario();
  const outra = novaVaga({ cidade: 'Barueri' });
  const t = telefone();
  novaCandidatura({ jobId: origem, telefone: t });
  novaCandidatura({ jobId: outra, telefone: t });
  assert.deepEqual(tels(montar({ vagaAlvoId: alvo })), [t]);
});

test('CONSENTIMENTO: pessoa sem consent_at em nenhuma candidatura fica fora', () => {
  const { alvo, origem } = cenario();
  const sem = telefone();
  const com = telefone();
  novaCandidatura({ jobId: origem, telefone: sem, consentiu: false });
  novaCandidatura({ jobId: origem, telefone: com });
  const r = montar({ vagaAlvoId: alvo });
  assert.equal(r.funil.pessoasSemConsentimento, 1);
  assert.deepEqual(tels(r), [com]);
});

test('CONSENTIMENTO: consent_at em QUALQUER candidatura basta (outra cidade, fora da janela, arquivada)', () => {
  const { alvo, origem } = cenario();
  const outraCidade = novaVaga({ ativo: false, cidade: 'Barueri' });
  const t = telefone();
  novaCandidatura({ jobId: origem, telefone: t, consentiu: false });
  novaCandidatura({ jobId: outraCidade, telefone: t, criadoEm: '2026-07-01 12:00:00', arquivada: true });
  assert.deepEqual(tels(montar({ vagaAlvoId: alvo, dataDe: '2026-09-01' })), [t]);
});

test('VAGAS IGNORADAS: pessoa em processo SO na vaga ignorada entra, e conta como liberada', () => {
  const { alvo, origem } = cenario();
  const parada = novaVaga();
  const t = telefone();
  novaCandidatura({ jobId: origem, telefone: t });
  novaCandidatura({ jobId: parada, telefone: t });
  assert.equal(montar({ vagaAlvoId: alvo }).funil.pessoasEmProcesso, 1);
  const r = montar({ vagaAlvoId: alvo, vagasIgnoradasProcesso: [parada] });
  assert.deepEqual(tels(r), [t]);
  assert.equal(r.funil.liberadasPorVagasIgnoradas, 1);
  assert.deepEqual(r.funil.vagasIgnoradasProcesso, [parada]);
});

test('VAGAS IGNORADAS: quem tambem esta em OUTRA vaga aberta da cidade continua fora', () => {
  const { alvo, origem } = cenario();
  const parada = novaVaga();
  const viva = novaVaga();
  const t = telefone();
  novaCandidatura({ jobId: origem, telefone: t });
  novaCandidatura({ jobId: parada, telefone: t });
  novaCandidatura({ jobId: viva, telefone: t });
  const r = montar({ vagaAlvoId: alvo, vagasIgnoradasProcesso: [parada] });
  assert.equal(r.funil.pessoasEmProcesso, 1);
  assert.equal(r.funil.liberadasPorVagasIgnoradas, 0);
});

test('VAGAS IGNORADAS: a vaga-alvo nao pode ser ignorada', () => {
  const { alvo } = cenario();
  assert.throws(() => montar({ vagaAlvoId: alvo, vagasIgnoradasProcesso: [alvo] }), /vaga_alvo_ignorada/);
});

test('VAGAS IGNORADAS: lista vazia = comportamento identico a sem o criterio', () => {
  const { alvo, origem } = cenario();
  const aberta = novaVaga();
  for (let i = 0; i < 3; i += 1) {
    const t = telefone();
    novaCandidatura({ jobId: origem, telefone: t });
    if (i) novaCandidatura({ jobId: aberta, telefone: t, status: i === 1 ? null : 'reprovado' });
  }
  const sem = montar({ vagaAlvoId: alvo });
  const vazia = montar({ vagaAlvoId: alvo, vagasIgnoradasProcesso: [] });
  assert.deepEqual(vazia.itens, sem.itens);
  assert.deepEqual(vazia.funil, sem.funil);
});

test('quem ja se candidatou a VAGA-ALVO fica fora, inclusive reprovado la (bug-to-confirm)', () => {
  // Sem esta linha, o reprovado na propria vaga-alvo passa pelo P2 e pela regra A.
  const { alvo, origem } = cenario();
  const t = telefone();
  novaCandidatura({ jobId: origem, telefone: t });
  novaCandidatura({ jobId: alvo, telefone: t, status: 'reprovado' });
  const r = montar({ vagaAlvoId: alvo });
  assert.equal(r.funil.pessoasJaCandidatasAlvo, 1);
  assert.equal(r.funil.total, 0);
});

test('STATUS (regra A): Aprovado em QUALQUER candidatura, mesmo arquivada, exclui a pessoa', () => {
  const { alvo, origem } = cenario();
  const outraCidade = novaVaga({ ativo: false, cidade: 'Barueri' });
  const t = telefone();
  novaCandidatura({ jobId: origem, telefone: t });
  novaCandidatura({ jobId: outraCidade, telefone: t, status: 'aprovado', arquivada: true });
  const r = montar({ vagaAlvoId: alvo });
  assert.equal(r.funil.pessoasStatus, 1);
  assert.equal(r.funil.porStatusExcluido.aprovado, 1);
});

test('STATUS (regra A): Em analise em vaga ENCERRADA exclui; Reprovado nao', () => {
  const { alvo, origem } = cenario();
  const a = telefone();
  const b = telefone();
  novaCandidatura({ jobId: origem, telefone: a, status: 'em_analise' });
  novaCandidatura({ jobId: origem, telefone: b, status: 'reprovado' });
  const r = montar({ vagaAlvoId: alvo });
  assert.deepEqual(tels(r), [b]);
  assert.equal(r.funil.porStatusExcluido.em_analise, 1);
});

test('telefone inutilizavel e duplicata canonica tem linhas proprias', () => {
  const { alvo, origem } = cenario();
  novaCandidatura({ jobId: origem, telefone: '+55 +551998115119' });
  novaCandidatura({ jobId: origem, telefone: '47999580001' });
  novaCandidatura({ jobId: origem, telefone: '4799580001' }); // mesma pessoa sem o 9
  const r = montar({ vagaAlvoId: alvo });
  assert.equal(r.funil.candidaturasSemTelefoneUtil, 1);
  assert.equal(r.funil.candidaturasDuplicadas, 1);
  assert.equal(r.funil.pessoas, 1);
});

test('OPT-OUT (tabela nova e antiga) suprime', () => {
  const { alvo, origem } = cenario();
  const a = telefone();
  const b = telefone();
  novaCandidatura({ jobId: origem, telefone: a });
  novaCandidatura({ jobId: origem, telefone: b });
  optout.registrarOptout({ telefone: a });
  // A tabela antiga guarda o telefone NORMALIZADO (com DDI).
  db.getDb().prepare('INSERT INTO whatsapp_opt_out (telefone) VALUES (?)').run(`55${b}`);
  const r = montar({ vagaAlvoId: alvo });
  assert.equal(r.funil.pessoasOptout, 2);
  assert.equal(r.funil.total, 0);
});

function campanhaMassa({ jobId, criterios = {} }) {
  return db.criarCampanhaMassaWa({ nome: 'c', jobId, criterios });
}

test('JA RECEBEU disparo em massa sai sempre; sem_destino volta', () => {
  const { alvo, origem } = cenario();
  const a = telefone();
  const b = telefone();
  novaCandidatura({ jobId: origem, telefone: a });
  novaCandidatura({ jobId: origem, telefone: b });
  const c = campanhaMassa({ jobId: origem });
  db.getDb().prepare(
    `INSERT INTO campanhas_massa_wa_envios (campanha_id, telefone, telefone_canonico, job_id, status, enviado_em)
     VALUES (?, ?, ?, ?, 'enviado', '2026-01-01 00:00:00'), (?, ?, ?, ?, 'sem_destino', '2026-01-01 00:00:00')`,
  ).run(c, a, require('../src/lib/chaveTelefone').chaveCanonicaTelefone(a), origem,
    c, b, require('../src/lib/chaveTelefone').chaveCanonicaTelefone(b), origem);
  const r = montar({ vagaAlvoId: alvo });
  assert.equal(r.funil.pessoasJaReceberam, 1);
  assert.deepEqual(tels(r), [b]);
});

function campanhaMeta({ tipo, jobId }) {
  const conn = db.getDb();
  const tpl = conn.prepare(
    "INSERT INTO templates_whatsapp (nome_meta, categoria, variaveis) VALUES (?, 'marketing', '[]')",
  ).run(`tpl-${(seq += 1)}`).lastInsertRowid;
  return conn.prepare(
    "INSERT INTO campanhas_whatsapp (nome, template_id, base_alvo, tipo_mensagem, job_id) VALUES ('m', ?, 'ambos', ?, ?)",
  ).run(tpl, tipo, jobId).lastInsertRowid;
}

test('CONVIDADO PARA A VAGA-ALVO pela Meta sai, mesmo ha muito tempo e com N = 0', () => {
  const { alvo, origem } = cenario();
  const a = telefone();
  const b = telefone();
  novaCandidatura({ jobId: origem, telefone: a });
  novaCandidatura({ jobId: origem, telefone: b });
  const cAlvo = campanhaMeta({ tipo: 'divulgacao_vaga', jobId: alvo });
  const cOutra = campanhaMeta({ tipo: 'divulgacao_vaga', jobId: origem });
  const ins = db.getDb().prepare(
    "INSERT INTO campanha_whatsapp_envios (campanha_id, telefone, origem_tipo, status, enviado_em) VALUES (?, ?, 'application', 'lido', '2026-01-01 00:00:00')",
  );
  ins.run(cAlvo, a);
  ins.run(cOutra, b);
  const r = montar({ vagaAlvoId: alvo });
  assert.equal(r.funil.pessoasConvidadasAlvo, 1);
  assert.deepEqual(r.funil.convidadasAlvoPorCanal, { meta: 1 });
  assert.deepEqual(tels(r), [b]);
});

test('CONVIDADO PARA A VAGA-ALVO por e-mail sai (identidade pelo e-mail de qualquer candidatura)', () => {
  const { alvo, origem } = cenario();
  const t = telefone();
  novaCandidatura({ jobId: origem, telefone: t, email: 'Pessoa@X.com ' });
  const conn = db.getDb();
  const c = conn.prepare(
    "INSERT INTO campanhas (job_id, tipo, assunto, corpo_html, criterios) VALUES (?, 'divulgacao_vaga', 'a', 'b', '{}')",
  ).run(alvo).lastInsertRowid;
  conn.prepare(
    "INSERT INTO campanha_envios (campanha_id, email, origem_tipo, status, enviado_em) VALUES (?, 'pessoa@x.com', 'application', 'enviado', '2026-01-01 00:00:00')",
  ).run(c);
  assert.deepEqual(montar({ vagaAlvoId: alvo }).funil.convidadasAlvoPorCanal, { email: 1 });
});

test('CONVIDADO PARA A VAGA-ALVO por outra campanha de SEGMENTO da massa: vale a vaga da campanha, nao a do item', () => {
  const { alvo, origem } = cenario();
  const t = telefone();
  novaCandidatura({ jobId: origem, telefone: t });
  const c = campanhaMassa({ jobId: alvo, criterios: { fonte: 'segmento' } });
  db.getDb().prepare(
    `INSERT INTO campanhas_massa_wa_envios (campanha_id, telefone, telefone_canonico, job_id, status, enviado_em)
     VALUES (?, ?, ?, ?, 'falha', NULL)`,
  ).run(c, t, require('../src/lib/chaveTelefone').chaveCanonicaTelefone(t), origem);
  // 'falha' nao conta como recebido...
  assert.equal(montar({ vagaAlvoId: alvo }).funil.total, 1);
  db.getDb().exec("UPDATE campanhas_massa_wa_envios SET status = 'enviado', enviado_em = '2026-01-01 00:00:00'");
  // ...e 'enviado' cai antes em "ja recebeu disparo em massa" (a linha anterior do funil).
  const r = montar({ vagaAlvoId: alvo });
  assert.equal(r.funil.pessoasJaReceberam, 1);
  const div = db.listarDivulgacoesEnviadasPorCanal().find((d) => d.canal === 'massa');
  assert.equal(div.job_id, alvo);
});

test('DIVULGADOS NOS ULTIMOS N DIAS saem; N = 0 desliga; contato antigo so vira aviso', () => {
  const { alvo, origem } = cenario();
  const recente = telefone();
  const antigo = telefone();
  novaCandidatura({ jobId: origem, telefone: recente });
  novaCandidatura({ jobId: origem, telefone: antigo });
  const grupo = campanhaMeta({ tipo: 'convite_grupo', jobId: null });
  const ins = db.getDb().prepare(
    "INSERT INTO campanha_whatsapp_envios (campanha_id, telefone, origem_tipo, status, enviado_em) VALUES (?, ?, 'application', 'enviado', ?)",
  );
  ins.run(grupo, recente, '2026-10-01 12:00:00'); // 8 dias antes de AGORA
  ins.run(grupo, antigo, '2026-08-01 12:00:00');

  const r14 = montar({ vagaAlvoId: alvo, diasOutrosCanais: 14 });
  assert.deepEqual(tels(r14), [antigo]);
  assert.deepEqual(r14.funil.divulgadasRecentesPorCanal, { meta: 1 });
  assert.equal(r14.funil.finalComContatoAnterior, 1);

  assert.equal(montar({ vagaAlvoId: alvo, diasOutrosCanais: 7 }).funil.total, 2);
  assert.equal(montar({ vagaAlvoId: alvo, diasOutrosCanais: 0 }).funil.total, 2);
});

test('n8n SEM DATA nao e excluido pelos N dias, mas aparece no informativo', () => {
  const { alvo, origem } = cenario();
  const t = telefone();
  novaCandidatura({ jobId: origem, telefone: t });
  db.getDb().prepare("INSERT INTO disparos_whatsapp (telefone, status, enviado_em) VALUES (?, 'enviado', NULL)").run(t);
  const r = montar({ vagaAlvoId: alvo, diasOutrosCanais: 30 });
  assert.equal(r.funil.total, 1);
  assert.equal(r.funil.finalComContatoSemData, 1);
});

test('n8n com data ISO+fuso e convertida para UTC antes da regra dos N dias (bug-to-confirm)', () => {
  // Visto em producao (parada 1): disparos_whatsapp.enviado_em = "2026-07-15T11:38:17.379-04:00".
  assert.equal(seg.dataEnvioUtc('2026-07-15T11:38:17.379-04:00'), '2026-07-15 15:38:17');
  assert.equal(seg.dataEnvioUtc('2026-08-14T17:48:52.142Z'), '2026-08-14 17:48:52');
  assert.equal(seg.dataEnvioUtc('2026-08-14 17:48:52'), '2026-08-14 17:48:52');
  assert.equal(seg.dataEnvioUtc('lixo'), null);

  const { alvo, origem } = cenario();
  const t = telefone();
  novaCandidatura({ jobId: origem, telefone: t });
  // Limite de N = 7 com AGORA = 2026-10-09 15:00 UTC: 2026-10-02 15:00:00 UTC.
  // 02/10 10:00 em -04:00 = 14:00 UTC, ANTES do limite. Como string crua ('2026-10-02T...' >
  // '2026-10-02 15:...') contaria como recente e tiraria a pessoa.
  db.getDb().prepare("INSERT INTO disparos_whatsapp (telefone, status, enviado_em) VALUES (?, 'enviado', ?)")
    .run(t, '2026-10-02T10:00:00.000-04:00');
  assert.equal(montar({ vagaAlvoId: alvo, diasOutrosCanais: 7 }).funil.total, 1);
  assert.equal(montar({ vagaAlvoId: alvo, diasOutrosCanais: 8 }).funil.pessoasDivulgadasRecentes, 1);
});

test('mensagens TRANSACIONAIS (WA1/WA2) nao contam como divulgacao', () => {
  const tiposNaConsulta = db.listarDivulgacoesEnviadasPorCanal.toString();
  assert.doesNotMatch(tiposNaConsulta, /whatsapp_sequencia_envios/);
  assert.doesNotMatch(tiposNaConsulta, /status_candidatura/);
});

// ══════════════════ desmarcadas e teto ══════════════════

test('DESMARCADAS na conferencia saem, contam no funil e voltam na lista para remarcar', () => {
  const { alvo, origem } = cenario();
  const a = telefone();
  const b = telefone();
  novaCandidatura({ jobId: origem, telefone: a });
  novaCandidatura({ jobId: origem, telefone: b });
  const chave = require('../src/lib/chaveTelefone').chaveCanonicaTelefone(a);
  const r = montar({ vagaAlvoId: alvo, desmarcadas: [chave] });
  assert.equal(r.funil.pessoasDesmarcadas, 1);
  assert.deepEqual(tels(r), [b]);
  assert.deepEqual(r.desmarcadas.map((d) => semDdi(d.telefone)), [a]);
});

test('TETO: ficam as candidaturas MAIS RECENTES, em ordem estavel, e o resto vira "fora pelo teto"', () => {
  const { alvo, origem } = cenario();
  const ts = [];
  for (let i = 0; i < 5; i += 1) {
    const t = telefone();
    ts.push(t);
    novaCandidatura({ jobId: origem, telefone: t, criadoEm: `2026-10-0${i + 1} 12:00:00` });
  }
  const r = montar({ vagaAlvoId: alvo, teto: 2 });
  assert.deepEqual(r.itens.map((i) => semDdi(i.telefone)), [ts[4], ts[3]]);
  assert.equal(r.funil.pessoasForaPorTeto, 3);
  assert.deepEqual(montar({ vagaAlvoId: alvo, teto: 2 }).itens, r.itens);
});

test('a ARITMETICA do funil fecha num cenario com todas as linhas', () => {
  const { alvo, origem } = cenario();
  const aberta = novaVaga();
  novaCandidatura({ jobId: origem, telefone: telefone(), arquivada: true });
  novaCandidatura({ jobId: origem, telefone: '+55 +551998115119' });
  const dup = telefone();
  novaCandidatura({ jobId: origem, telefone: dup });
  novaCandidatura({ jobId: origem, telefone: dup });
  const proc = telefone();
  novaCandidatura({ jobId: origem, telefone: proc });
  novaCandidatura({ jobId: aberta, telefone: proc });
  const apr = telefone();
  novaCandidatura({ jobId: origem, telefone: apr, status: 'aprovado' });
  const opt = telefone();
  novaCandidatura({ jobId: origem, telefone: opt });
  optout.registrarOptout({ telefone: opt });
  novaCandidatura({ jobId: origem, telefone: telefone(), consentiu: false });
  for (let i = 0; i < 4; i += 1) novaCandidatura({ jobId: origem, telefone: telefone() });
  const r = montar({ vagaAlvoId: alvo, teto: 2 });
  assert.equal(r.funil.pessoasSemConsentimento, 1);
  assert.ok(seg.conferirAritmetica(r.funil), JSON.stringify(r.funil));
  assert.equal(r.funil.total, 2);
  assert.ok(r.funil.pessoasForaPorTeto > 0 && r.funil.pessoasEmProcesso > 0 && r.funil.pessoasStatus > 0);
});

test('mascararTelefone: 5547****2500', () => {
  assert.equal(seg.mascararTelefone('5547999582500'), '5547****2500');
});

// ══════════════════ despachante ══════════════════

test('REGRESSAO: campanha SEM fonte produz exatamente o publico de montarPublicoMassaWa', () => {
  limpar();
  const aberta = novaVaga({ cidade: null });
  for (const st of [null, '', 'em_analise', 'reprovado', 'aprovado']) {
    novaCandidatura({ jobId: aberta, telefone: telefone(), status: st });
  }
  const campanha = db.obterCampanhaMassaWa(campanhaMassa({ jobId: null, criterios: { statusList: ['sem_decisao', 'reprovado'] } }));
  const antes = publico.montarPublicoMassaWa({ jobId: null, statusList: ['sem_decisao', 'reprovado'] });
  const depois = publico.montarPublicoDaCampanha(campanha);
  assert.equal(depois.fonte, 'vagas_abertas');
  assert.deepEqual({ itens: depois.itens, funil: depois.funil, statusList: depois.statusList }, antes);

  const comOpcoes = publico.montarPublicoDaCampanha(campanha, { excluirJaReceberam: false, maxDestinatarios: 1 });
  const antesOpcoes = publico.montarPublicoMassaWa({ jobId: null, statusList: ['sem_decisao', 'reprovado'], excluirJaReceberam: false, maxDestinatarios: 1 });
  assert.deepEqual(comOpcoes.funil, antesOpcoes.funil);
});

test('REGRESSAO: campanha antiga sem statusList usa o STATUS_PADRAO, como statusDaCampanha fazia', () => {
  limpar();
  const aberta = novaVaga();
  novaCandidatura({ jobId: aberta, telefone: telefone(), status: 'reprovado' });
  novaCandidatura({ jobId: aberta, telefone: telefone(), status: null });
  const campanha = db.obterCampanhaMassaWa(campanhaMassa({ jobId: aberta }));
  assert.deepEqual(
    publico.montarPublicoDaCampanha(campanha).funil,
    publico.montarPublicoMassaWa({ jobId: aberta, statusList: publico.STATUS_PADRAO }).funil,
  );
});

test('fonte "segmento" vai para o motor do segmento; fonte desconhecida LANCA', () => {
  const { alvo, origem } = cenario();
  novaCandidatura({ jobId: origem, telefone: telefone() });
  const s = db.obterCampanhaMassaWa(campanhaMassa({ jobId: alvo, criterios: { fonte: 'segmento', vagaAlvoId: alvo, cidade: 'Joinville', teto: 30 } }));
  const r = publico.montarPublicoDaCampanha(s, {}, { agora: AGORA });
  assert.equal(r.fonte, 'segmento');
  assert.equal(r.funil.total, 1);
  const x = db.obterCampanhaMassaWa(campanhaMassa({ jobId: alvo, criterios: { fonte: 'xyz' } }));
  assert.throws(() => publico.montarPublicoDaCampanha(x), /desconhecida/);
});

test('PREVIA E FILA NA MESMA FUNCAO: a rota nunca chama um motor de publico diretamente', () => {
  const fonte = fs.readFileSync(path.join(__dirname, '../src/routes/admin_massa_wa.js'), 'utf8');
  assert.doesNotMatch(fonte, /montarPublicoMassaWa\s*\(/);
  assert.doesNotMatch(fonte, /montarPublicoSegmentoMassaWa\s*\(/);
  assert.ok((fonte.match(/montarPublicoDaCampanha\(/g) || []).length >= 2);
});
