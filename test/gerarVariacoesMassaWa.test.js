'use strict';

// Geracao das variacoes do disparo em massa a partir do texto-base (lib/gerarVariacoesMassaWa).
//
// ZERO REDE: o LLM e sempre um duble injetado. O que mais importa aqui e a FALHA: uma geracao que
// nao deu certo nunca pode devolver as sementes (nem qualquer texto padrao) — foi assim que a
// campanha 9, um lembrete, saiu como convite.

const os = require('node:os');
const path = require('node:path');

process.env.DATABASE_PATH = path.join(os.tmpdir(), `vm-test-gerar-var-massa-${process.pid}-${Date.now()}.db`);
process.env.INTERVIEW_MOCK = 'true';
process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert/strict');

const g = require('../src/lib/gerarVariacoesMassaWa');
const v = require('../src/lib/variacoesMassaWa');
const { BASE_LEMBRETE, REDACOES_LEMBRETE, URL_SALA } = require('./fixtures/variacoesLembreteMassaWa');

// db duble: so o registro de custo.
function dbDuble() {
  const usos = [];
  return { usos, registrarUsoApi: (u) => usos.push(u) };
}

// LLM duble que devolve, em ordem, uma resposta por chamada e guarda as mensagens recebidas.
function llmEmSequencia(...respostas) {
  const chamadas = [];
  return {
    chamadas,
    completar: async (mensagens, opcoes) => {
      chamadas.push({ mensagens, opcoes });
      const r = respostas[Math.min(chamadas.length - 1, respostas.length - 1)];
      if (r instanceof Error) throw r;
      return typeof r === 'string' ? { texto: r, modelo: 'duble', uso: { prompt_tokens: 10, completion_tokens: 10 }, finishReason: 'stop' } : r;
    },
  };
}
const json = (lista) => JSON.stringify({ variacoes: lista });
const usuario = (chamada) => chamada.mensagens.find((m) => m.papel === 'user').conteudo;
const sistema = (chamada) => chamada.mensagens.find((m) => m.papel === 'system').conteudo;

// ══════════════════ CAMINHO FELIZ ══════════════════

test('gera as 7 a partir do texto-base, numa tentativa, e registra o custo', async () => {
  const llm = llmEmSequencia(json([...REDACOES_LEMBRETE]));
  const db = dbDuble();
  const r = await g.gerarVariacoes(BASE_LEMBRETE, { llm, db });
  assert.equal(r.ok, true, r.erro);
  assert.deepEqual(r.variacoes, [...REDACOES_LEMBRETE]);
  assert.equal(r.tentativas, 1);
  assert.equal(db.usos.length, 1);
  assert.equal(db.usos[0].origem, 'massa-wa');
});

test('regressao campanha 9: o prompt carrega o TEXTO-BASE, e nada das sementes do convite', async () => {
  const llm = llmEmSequencia(json([...REDACOES_LEMBRETE]));
  await g.gerarVariacoes(BASE_LEMBRETE, { llm, db: dbDuble() });
  const u = usuario(llm.chamadas[0]);
  assert.ok(u.includes(BASE_LEMBRETE), 'o texto-base vai inteiro ao modelo');
  assert.ok(u.includes(URL_SALA), 'o link da sala e citado como obrigatorio');
  for (const tok of ['{saudacao}', '{recrutador}', '{vaga}', '{empresa}']) assert.ok(u.includes(tok));
  const tudo = `${sistema(llm.chamadas[0])}\n${u}`;
  for (const trecho of ['Confirme sua presença', '{link_meet}', '{data}', '{horario}', 'empresa de recrutamento']) {
    assert.ok(!tudo.includes(trecho), `o prompt nao pode trazer "${trecho}" do convite padrao`);
  }
});

test('o prompt manda manter fatos/ordem, variar so a redacao, preservar tokens e *negrito*, e NAO escrever descadastro', () => {
  const [sys] = g.montarMensagensVariacoes(BASE_LEMBRETE);
  assert.match(sys.conteudo, /FONTE DA VERDADE/);
  assert.match(sys.conteudo, /MESMA ordem das informacoes/);
  assert.match(sys.conteudo, /variar SO a redacao/);
  assert.match(sys.conteudo, /\*negrito\*/);
  assert.match(sys.conteudo, /NAO ESCREVA DESCADASTRO/);
  assert.ok(!sys.conteudo.includes(v.LINHA_DESCADASTRO), 'a linha do sistema nunca vai ao LLM');
});

test('o prompt informa a faixa de tamanho aprovada (0,6x a 1,6x)', () => {
  const u = g.montarMensagensVariacoes(BASE_LEMBRETE)[1].conteudo;
  const n = BASE_LEMBRETE.length;
  assert.ok(u.includes(`entre ${Math.ceil(n * 0.6)} e ${Math.floor(n * 1.6)} caracteres`));
});

// ══════════════════ FALHA SEM FALLBACK SILENCIOSO ══════════════════

test('LLM que devolve as SEMENTES do convite: tudo recusado, e o resultado NAO traz texto nenhum', async () => {
  const llm = llmEmSequencia(json([...v.VARIACOES_SEED]));
  const r = await g.gerarVariacoes(BASE_LEMBRETE, { llm, db: dbDuble() });
  assert.equal(r.ok, false);
  assert.deepEqual(r.variacoes, []);
  assert.equal(llm.chamadas.length, g.MAX_TENTATIVAS);
  assert.match(r.erro, /não gerou 7 variações válidas em 3 tentativa/);
  assert.match(r.erro, /inventou|perdeu/);
});

test('LLM fora do ar: 3 tentativas, erro claro, sem fallback', async () => {
  const llm = llmEmSequencia(new Error('rede fora'));
  const r = await g.gerarVariacoes(BASE_LEMBRETE, { llm, db: dbDuble() });
  assert.equal(r.ok, false);
  assert.deepEqual(r.variacoes, []);
  assert.equal(llm.chamadas.length, 3);
  assert.match(r.erro, /a IA não respondeu/);
});

test('JSON invalido: erro claro, sem fallback', async () => {
  const llm = llmEmSequencia('aqui estao as variacoes: 1) Oi');
  const r = await g.gerarVariacoes(BASE_LEMBRETE, { llm, db: dbDuble() });
  assert.equal(r.ok, false);
  assert.deepEqual(r.variacoes, []);
  assert.match(r.erro, /formato esperado/);
});

test('resposta truncada: tenta de novo; se na proxima vier certo, aceita', async () => {
  const llm = llmEmSequencia(
    { texto: '{"variacoes": ["corta', modelo: 'd', uso: {}, finishReason: 'length' },
    json([...REDACOES_LEMBRETE]),
  );
  const r = await g.gerarVariacoes(BASE_LEMBRETE, { llm, db: dbDuble() });
  assert.equal(r.ok, true);
  assert.equal(r.tentativas, 2);
});

test('falha parcial: guarda as boas, pede SO as que faltam e devolve o motivo das recusadas ao modelo', async () => {
  const ruins = [
    REDACOES_LEMBRETE[4].replace(URL_SALA, 'https://meet.google.com/outra-sala'),
    REDACOES_LEMBRETE[5].replace('*{empresa}*', 'empresa'),
    REDACOES_LEMBRETE[6].replace('às 14h', 'em {data}'),
  ];
  const llm = llmEmSequencia(
    json([...REDACOES_LEMBRETE.slice(0, 4), ...ruins]),
    json(REDACOES_LEMBRETE.slice(4)),
  );
  const r = await g.gerarVariacoes(BASE_LEMBRETE, { llm, db: dbDuble() });
  assert.equal(r.ok, true, r.erro);
  assert.equal(r.tentativas, 2);
  assert.deepEqual(r.variacoes, [...REDACOES_LEMBRETE]);
  const segunda = usuario(llm.chamadas[1]);
  assert.match(segunda, /Escreva 3 variacao/);
  assert.match(segunda, /RECUSADAS/);
  assert.match(segunda, /perdeu ou alterou o link/);
  assert.match(segunda, /perdeu \{empresa\}/);
  assert.match(segunda, /inventou \{data\}/);
});

test('variacao repetida de uma tentativa anterior e recusada (semelhanca vale entre tentativas)', async () => {
  const llm = llmEmSequencia(
    json(REDACOES_LEMBRETE.slice(0, 6)),
    json([REDACOES_LEMBRETE[0]]),
    json([REDACOES_LEMBRETE[6]]),
  );
  const r = await g.gerarVariacoes(BASE_LEMBRETE, { llm, db: dbDuble() });
  assert.equal(r.ok, true);
  assert.equal(r.tentativas, 3);
  assert.match(usuario(llm.chamadas[2]), /parecida demais com outra variação/);
});

test('texto-base com problema nao chega ao LLM (custo sem chance de dar certo)', async () => {
  for (const base of ['   ', 'Oi {horário}', 'Oi {{vaga}}']) {
    const llm = llmEmSequencia(json([...REDACOES_LEMBRETE]));
    const r = await g.gerarVariacoes(base, { llm, db: dbDuble() });
    assert.equal(r.ok, false, base);
    assert.equal(llm.chamadas.length, 0, base);
    assert.match(r.erro, /Corrija o texto-base/);
  }
});

test('parseVariacoes tolera cerca de markdown e descarta o que nao e texto', () => {
  assert.deepEqual(g.parseVariacoes('```json\n{"variacoes": [" a ", 3, "", "b"]}\n```'), ['a', 'b']);
  assert.throws(() => g.parseVariacoes('{"outra": []}'));
});

test('iaLigada: so com MASSA_WA_LLM_ATIVO=true', () => {
  assert.equal(g.iaLigada({}), false);
  assert.equal(g.iaLigada({ MASSA_WA_LLM_ATIVO: 'false' }), false);
  assert.equal(g.iaLigada({ MASSA_WA_LLM_ATIVO: ' TRUE ' }), true);
  assert.equal(g.ERRO_IA_DESLIGADA, 'Geração por IA desligada: escreva as 7 variações manualmente');
});
