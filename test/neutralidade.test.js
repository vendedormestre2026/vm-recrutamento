'use strict';

// Correcao do vazamento de avaliacao ao candidato durante a entrevista.
//
// Cobre as duas frentes com efeito observavel em codigo (as demais — texto do prompt e
// dados do roteiro — sao validadas por leitura/assert de string aqui tambem):
//   1. montarSystemPrompt: contem a REGRA CRITICA DE NEUTRALIDADE (proibicoes a/b/c/d) e
//      NAO contem material avaliativo na conducao (boa_resposta, RUBRICA/escala,
//      o_que_observar). A Regra 4 so manda EMITIR o marcador [ENCERRAR], sem autorar fala.
//   2. /answer no MODO REAL: ao encerrar (marcador [ENCERRAR] do LLM), a fala devolvida ao
//      candidato e SEMPRE a fala fixa (falaDespedida), NUNCA o texto do LLM — mesmo que
//      esse texto contenha avaliacao. Regressao: corte por TETO e por TEMPO seguem usando
//      fala fixa (falaDespedida / FALA_FECHAMENTO) como antes.
//
// Isolamento e seguranca: banco SQLite TEMPORARIO proprio + os tres providers (STT/LLM/TTS)
// sao SUBSTITUIDOS por fakes no cache de modulo. INTERVIEW_MOCK=false apenas leva o codigo
// pelo ramo real — NENHUMA chave de API e lida e NENHUMA chamada de rede acontece (os fakes
// interceptam tudo). O comportamento real do modelo e validado manualmente depois.

const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');
const crypto = require('node:crypto');

const TMP_DB = path.join(os.tmpdir(), `vm-test-neutralidade-${process.pid}-${Date.now()}.db`);
process.env.DATABASE_PATH = TMP_DB;
process.env.INTERVIEW_MOCK = 'false'; // ramo real (STT/LLM/TTS) — todos fakados abaixo
process.env.RECRUITER_EMAIL = 'recrutador@teste.local';
process.env.MAX_PERGUNTAS = '1'; // abertura ja conta como 1 -> corte por teto no proximo /answer
process.env.MAX_DURACAO_MIN = '20';
process.env.SESSION_SECRET = 'segredo-de-teste';
process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert/strict');

const db = require('../src/db');
const { semear } = require('../src/db/seed');
const entrevista = require('../src/lib/entrevista');
const { criarApp } = require('../src/server');

// ── Fakes dos providers (mesmo objeto que api.js require-ou no topo, via cache de modulo).
// Substituir os metodos aqui faz a rota real usar estes fakes — sem rede, sem chaves.
const stt = require('../src/providers/stt');
const llm = require('../src/providers/llm');
const tts = require('../src/providers/tts');

let respostaLlm = { texto: 'Certo. [ENCERRAR]', uso: {}, modelo: 'fake' };
stt.transcrever = async () => ({ texto: 'Fiz a simulacao de vendas assim...' });
llm.completar = async () => respostaLlm;
tts.sintetizar = async () => ({ audio: Buffer.from('fake-audio') });

const SECRET = process.env.SESSION_SECRET;

let vagaId;
let roteiroId;

function cookieAssinado(token) {
  const sig = crypto.createHmac('sha256', SECRET).update(token).digest('base64').replace(/=+$/, '');
  return `vm_token=${encodeURIComponent(`s:${token}.${sig}`)}`;
}

// Cria application + interview EM ANDAMENTO (abertura ja gravada = 1 turno do agente).
function novaEntrevistaEmAndamento(sufixo) {
  const appId = db.criarAplicacao({
    job_id: vagaId,
    nome: 'Caso',
    sobrenome: sufixo,
    email: `caso-${sufixo}@teste.local`,
    token: `tok-${sufixo}`,
    status: 'em_entrevista',
  });
  const iid = db.criarInterview({
    application_id: appId,
    perfil: 'SDR',
    roteiro_id: roteiroId,
    status: 'iniciada',
  });
  db.criarTurno({ interview_id: iid, ordem: 1, autor: 'agente', texto: 'Pergunta de abertura.' });
  return { appId, iid, token: `tok-${sufixo}` };
}

async function postAnswer(base, token, iid) {
  const res = await fetch(`${base}/api/interview/answer`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Cookie: cookieAssinado(token),
    },
    body: new URLSearchParams({ interview_id: String(iid) }),
  });
  assert.equal(res.status, 200);
  return res.json();
}

test.before(() => {
  const seeded = semear(); // roda migrar() + cria roteiro/vaga
  roteiroId = seeded.roteiroId;
  vagaId = seeded.vagaId;
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

// ─────────────────────────── A/B) montarSystemPrompt ───────────────────────────
test('montarSystemPrompt: tem a regra de neutralidade e NAO tem material avaliativo', () => {
  const roteiro = {
    estrutura: {
      metodo: 'BEI',
      instrucoes_gerais: ['Peca exemplos concretos.'],
      competencias: [
        { nome: 'Resiliencia', peso: 2, boa_resposta: 'SEGREDO_BOA_RESPOSTA aguenta pressao' },
      ],
      blocos: [
        {
          id: 'simulacao',
          nome: 'Simulacao',
          pergunta_semente: 'Venda para mim.',
          o_que_observar: ['SEGREDO_OBSERVAR sinal de alerta'],
          instrucao_vera: 'Entre no papel de cliente.',
        },
      ],
      rubrica: { escala: '1-5', saida: 'nota + justificativa' },
    },
  };

  const prompt = entrevista.montarSystemPrompt({
    roteiro,
    curriculoTexto: 'CV do candidato',
    agente: 'Vera',
    maxPerguntas: 12,
  });

  // (A) Regra critica de neutralidade presente, com as quatro proibicoes.
  assert.match(prompt, /REGRA CRITICA DE NEUTRALIDADE/);
  assert.match(prompt, /\(a\) comentar/);
  assert.match(prompt, /\(b\) dizer que o candidato tem/);
  assert.match(prompt, /\(c\) qualquer elogio ou critica/);
  assert.match(prompt, /\(d\) verbalizar nota, pontuacao, rubrica/);

  // (B) Nada de material avaliativo na conducao.
  assert.ok(!prompt.includes('SEGREDO_BOA_RESPOSTA'), 'boa_resposta NAO deve entrar na conducao');
  assert.ok(!prompt.includes('SEGREDO_OBSERVAR'), 'o_que_observar NAO deve entrar na conducao');
  // "rubrica" (minusculo) aparece de proposito na proibicao (d) da regra de neutralidade;
  // o que NAO pode existir e a SECAO de rubrica da conducao (cabecalho "RUBRICA:" + escala).
  assert.ok(!prompt.includes('RUBRICA:'), 'o cabecalho da secao RUBRICA nao deve existir');
  assert.ok(!/escala 1-5/i.test(prompt), 'a escala da rubrica nao deve aparecer na conducao');
  assert.ok(!/por competencia/i.test(prompt), 'a instrucao de pontuar por competencia nao deve existir');

  // Cobertura (nome + peso) permanece, sob rotulo de uso interno.
  assert.match(prompt, /TEMAS A EXPLORAR/);
  assert.match(prompt, /Resiliencia \(peso 2\)/);

  // (D) Regra 4: so EMITIR o marcador, sem autorar fala de encerramento.
  assert.match(prompt, /responda apenas com o marcador \[ENCERRAR\]/);
  assert.ok(
    !/faca uma fala de encerramento/i.test(prompt),
    'a Regra 4 nao deve mais mandar autorar a fala de encerramento',
  );
});

// ──────────────── D) /answer real: encerramento nunca vaza avaliacao ────────────────
test('/answer (real): [ENCERRAR] com texto avaliativo -> devolve fala fixa, nao o texto do LLM', async () => {
  const { iid, token } = novaEntrevistaEmAndamento('encerrar-llm');
  // LLM decide encerrar E tenta vazar avaliacao na fala (o bug de producao).
  respostaLlm = {
    texto: 'Voce foi excelente e tem exatamente o perfil que buscamos aqui! [ENCERRAR]',
    uso: { prompt_tokens: 10, completion_tokens: 5 },
    modelo: 'fake',
  };

  const app = criarApp();
  const server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;

  try {
    const dados = await postAnswer(base, token, iid);
    assert.equal(dados.encerrar, true);
    // A fala ao candidato e a despedida fixa e neutra — nao o texto do LLM.
    assert.equal(dados.pergunta, entrevista.falaDespedida('Caso'));
    assert.ok(!/excelente/i.test(dados.pergunta), 'nao pode vazar elogio de desempenho');
    assert.ok(!/perfil que buscamos/i.test(dados.pergunta), 'nao pode vazar juizo de adequacao');
    assert.ok(!dados.pergunta.includes('[ENCERRAR]'), 'o marcador nao pode aparecer na fala');

    // O turno gravado do agente tambem e a fala fixa (nao o texto do LLM).
    const turnos = db.listarTurnos(iid);
    const ultimoAgente = turnos.filter((t) => t.autor === 'agente').at(-1);
    assert.equal(ultimoAgente.texto, entrevista.falaDespedida('Caso'));

    assert.equal(db.obterInterview(iid).status, 'concluido');
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('/answer (real): corte por TETO de perguntas segue usando fala fixa (regressao)', async () => {
  const { iid, token } = novaEntrevistaEmAndamento('teto');
  // LLM NAO encerra (texto normal, sem marcador). Com MAX_PERGUNTAS=1 + abertura feita,
  // o corte por teto assume e troca por falaDespedida.
  respostaLlm = { texto: 'Otimo, e como voce lidou com isso?', uso: {}, modelo: 'fake' };

  const app = criarApp();
  const server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;

  try {
    const dados = await postAnswer(base, token, iid);
    assert.equal(dados.encerrar, true);
    assert.equal(dados.pergunta, entrevista.falaDespedida('Caso'));
    // A pergunta orfa gerada pelo LLM nao vai ao candidato.
    assert.ok(!/como voce lidou/i.test(dados.pergunta));
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('/answer (real): teto de TEMPO segue usando FALA_FECHAMENTO fixa (regressao)', async () => {
  const { iid, token } = novaEntrevistaEmAndamento('tempo');
  // Empurra iniciado_em 30 min para tras (> MAX_DURACAO_MIN=20) -> encerra por tempo,
  // antes mesmo de chamar o LLM.
  db.getDb()
    .prepare("UPDATE interviews SET iniciado_em = datetime('now','-30 minutes') WHERE id = ?")
    .run(iid);
  // Se o LLM fosse chamado neste caminho, o teste falharia (nao deve ser).
  respostaLlm = { texto: 'NAO DEVERIA SER USADO [ENCERRAR]', uso: {}, modelo: 'fake' };

  const app = criarApp();
  const server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;

  try {
    const dados = await postAnswer(base, token, iid);
    assert.equal(dados.encerrar, true);
    assert.equal(dados.pergunta, entrevista.FALA_FECHAMENTO);
    assert.ok(!/NAO DEVERIA/i.test(dados.pergunta));
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
