'use strict';

// Agendamento e ciclo de disparo da sequencia WA1/WA2 (src/whatsapp/sequenciaOutbox.js).
//
// ── ZERO WHATSAPP REAL ──
// Nenhum socket e aberto e `enviarTexto` e SEMPRE injetado. Os testes de modo real usam um
// dublê que conta chamadas; os de mock provam que nem o dublê e tocado.
//
// ── O QUE ESTA EM JOGO ──
// Duas mensagens automaticas por candidatura, num canal sem desfazer. Os erros nao sao
// simetricos:
//   nao enviar    o candidato fica sem o aviso. Ruim, corrigivel.
//   enviar duas   a pessoa recebe o mesmo texto duas vezes de um numero de empresa. Ou pior:
//   vezes / errado sai depois de alguem ter desligado o interruptor justamente para parar.
// Por isso a maioria das assercoes verifica que NAO saiu.

const os = require('node:os');
const path = require('node:path');

process.env.DATABASE_PATH = path.join(os.tmpdir(), `vm-test-wa-outbox-${process.pid}-${Date.now()}.db`);
process.env.INTERVIEW_MOCK = 'true';
process.env.SESSION_SECRET = 'segredo-de-teste';
process.env.WHATSAPP_SECRETS_KEY = 'f'.repeat(64);
process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert/strict');

const db = require('../src/db');
const { migrar } = require('../src/db/migrate');
const outbox = require('../src/whatsapp/sequenciaOutbox');

migrar();

const run = (sql, ...p) => Number(db.getDb().prepare(sql).run(...p).lastInsertRowid);
const exec = (sql, ...p) => db.getDb().prepare(sql).run(...p);
const todas = (sql, ...p) => db.getDb().prepare(sql).all(...p);

let seq = 0;

function criarApplication(telefone = '+55 (47) 99958-2500', criadoEm = null) {
  seq += 1;
  const jobId = run(
    "INSERT INTO jobs (slug, titulo, perfil, empresa, ativo) VALUES (?, 'Vendedor Externo', 'CLOSER', 'Labor Seg', 1)",
    `vaga-outbox-${seq}`,
  );
  const id = run(
    'INSERT INTO applications (job_id, nome, sobrenome, telefone, token, criado_em) VALUES (?, ?, ?, ?, ?, ?)',
    jobId,
    'Ana Paula',
    'Silva',
    telefone,
    `tok-outbox-${seq}`,
    criadoEm || new Date().toISOString().replace('T', ' ').slice(0, 19),
  );
  return { id, telefone, criado_em: criadoEm, nome: 'Ana Paula' };
}

function zerar() {
  exec('DELETE FROM whatsapp_sequencia_envios');
  exec('DELETE FROM applications');
  exec('DELETE FROM jobs');
  db.definirConfigBool(outbox.CHAVE_ATIVO, false);
  delete process.env.WHATSAPP_BAILEYS_ATIVO;
}

// Liga os dois interruptores.
function ligarTudo() {
  db.definirConfigBool(outbox.CHAVE_ATIVO, true);
  process.env.WHATSAPP_BAILEYS_ATIVO = 'true';
}

const fila = (appId) =>
  todas('SELECT * FROM whatsapp_sequencia_envios WHERE application_id = ? ORDER BY etapa', appId);

// Captura os logs para as assercoes de mascaramento.
function comLogs(fn) {
  const { log, warn, error } = console;
  const linhas = [];
  const captura = (...a) => linhas.push(a.join(' '));
  console.log = console.warn = console.error = captura;
  try {
    const r = fn();
    return r && typeof r.then === 'function' ? r.then((v) => ({ r: v, linhas })) : { r, linhas };
  } finally {
    Object.assign(console, { log, warn, error });
  }
}

// Dublê de envio. Conta chamadas e pode falhar sob demanda.
function envioDuble({ falhar = false, mensagem = 'socket caiu' } = {}) {
  const chamadas = [];
  return {
    chamadas,
    fn: async (telefone, texto) => {
      chamadas.push({ telefone, texto });
      if (falhar) throw new Error(mensagem);
      return { key: { id: 'fake' } };
    },
  };
}

// Deps padrao do ciclo: sem throttle real, envio injetado.
const deps = (extra = {}) => ({ intervaloMs: 0, dormir: async () => {}, ...extra });

// ══════════════════ agendarSequencia ══════════════════

test('agenda as duas etapas: WA1 agora, WA2 em +4h', async () => {
  zerar();
  ligarTudo();
  const criadoEm = '2026-08-14 10:00:00';
  const app = criarApplication('+55 (47) 99958-2500', criadoEm);

  await comLogs(() => outbox.agendarSequencia({ ...app, criado_em: criadoEm }));
  const linhas = fila(app.id);

  assert.equal(linhas.length, 2);
  assert.deepEqual(linhas.map((l) => l.etapa), ['wa1', 'wa2']);
  assert.equal(linhas[0].status, 'pendente');
  // Telefone normalizado JA no agendamento: gravar cru faria a fila carregar um numero que
  // o envio nao usa, e o problema so apareceria 4h depois.
  assert.equal(linhas[0].telefone_e164, '5547999582500');

  // WA2 = criado_em + 4h, exato.
  const wa2 = linhas.find((l) => l.etapa === 'wa2');
  assert.match(wa2.agendado_para, /^2026-08-14 14:00:00$/);
});

test('config desligada: NAO cria linha (nao e "cria e ignora")', async () => {
  zerar(); // switch de banco fica false
  const app = criarApplication();
  const { r } = await comLogs(() => outbox.agendarSequencia(app));
  assert.equal(r.agendados, 0);
  assert.match(r.motivo, /desligado/);
  // A diferenca importa: linha criada com o switch desligado sairia sozinha no minuto em
  // que alguem ligasse, para quem se candidatou semanas antes.
  assert.deepEqual(fila(app.id), []);
});

test('idempotente: chamar duas vezes nao duplica', async () => {
  zerar();
  ligarTudo();
  const app = criarApplication();

  await comLogs(() => outbox.agendarSequencia(app));
  const { r } = await comLogs(() => outbox.agendarSequencia(app));

  assert.equal(r.agendados, 0, 'a segunda chamada nao cria nada');
  assert.equal(fila(app.id).length, 2, 'e nao duplica o que ja existia');
});

test('falha ao agendar NAO propaga — a candidatura nao pode cair por isso', async () => {
  zerar();
  ligarTudo();
  const app = criarApplication();
  const dbQuebrado = {
    ...db,
    agendarEnvioWhatsapp() {
      throw new Error('database is locked');
    },
  };

  // O ponto do teste: nao lanca. Mesmo principio do middleware de funil.
  const { r } = await comLogs(() => outbox.agendarSequencia(app, { db: dbQuebrado }));
  assert.equal(r.agendados, 0);
  assert.match(r.motivo, /database is locked/);
});

test('telefone invalido nao vira agendamento', async () => {
  zerar();
  ligarTudo();
  const app = criarApplication('123');
  const { r } = await comLogs(() => outbox.agendarSequencia({ ...app, telefone: '123' }));
  assert.equal(r.agendados, 0);
  assert.match(r.motivo, /telefone/);
  assert.deepEqual(fila(app.id), []);
});

// ══════════════════ Kill-switches ══════════════════

test('os DOIS interruptores, nas quatro combinacoes', async () => {
  const casos = [
    ['ambos ligados', true, true, false],
    ['so o banco', true, false, true],
    ['so o env', false, true, true],
    ['ambos desligados', false, false, true],
  ];
  for (const [rotulo, banco, env, esperaPulado] of casos) {
    zerar();
    ligarTudo();
    const app = criarApplication();
    await comLogs(() => outbox.agendarSequencia(app));

    db.definirConfigBool(outbox.CHAVE_ATIVO, banco);
    if (env) process.env.WHATSAPP_BAILEYS_ATIVO = 'true';
    else delete process.env.WHATSAPP_BAILEYS_ATIVO;

    const envio = envioDuble();
    const { r } = await comLogs(() =>
      outbox.processarCicloSequencia(deps({ mock: false, enviarTexto: envio.fn })),
    );

    if (esperaPulado) {
      assert.equal(r.desativado, true, rotulo);
      assert.equal(envio.chamadas.length, 0, `${rotulo}: nao pode enviar nada`);
      // Uma linha agendada ontem nao pode sair hoje se alguem desligou no meio.
      assert.equal(fila(app.id).every((l) => l.status === 'pendente'), true, rotulo);
    } else {
      assert.equal(r.desativado, undefined, rotulo);
      assert.ok(envio.chamadas.length > 0, `${rotulo}: deveria ter enviado`);
    }
  }
});

// ══════════════════ Modo mock ══════════════════

test('mock: marca enviado SEM tocar o socket', async () => {
  zerar();
  ligarTudo();
  const app = criarApplication();
  await comLogs(() => outbox.agendarSequencia({ ...app, criado_em: '2020-01-01 00:00:00' }));

  const envio = envioDuble();
  const { r } = await comLogs(() => outbox.processarCicloSequencia(deps({ mock: true, enviarTexto: envio.fn })));

  assert.equal(r.enviados, 2);
  // O default e mock justamente para que a ausencia de config NAO signifique "pode enviar".
  assert.equal(envio.chamadas.length, 0, 'o socket nao pode ser chamado em mock');
  assert.equal(fila(app.id).every((l) => l.status === 'enviado'), true);
});

test('o log NAO expoe o telefone completo', async () => {
  zerar();
  ligarTudo();
  const app = criarApplication('+55 (47) 99958-2500');
  await comLogs(() => outbox.agendarSequencia({ ...app, criado_em: '2020-01-01 00:00:00' }));

  const { linhas } = await comLogs(() => outbox.processarCicloSequencia(deps({ mock: true })));
  const tudo = linhas.join('\n');

  // O stdout do Railway e lido por mais gente que o banco.
  assert.doesNotMatch(tudo, /5547999582500/, 'numero completo vazou para o log');
  assert.match(tudo, /5547\*+2500/, 'e o mascarado precisa aparecer');
});

test('mascarar nao vaza o miolo, e aguenta entrada curta', () => {
  assert.equal(outbox.mascarar('5547999582500'), '5547*****2500');
  assert.equal(outbox.mascarar('123'), '***');
  assert.equal(outbox.mascarar(''), '***');
  assert.equal(outbox.mascarar(null), '***');
});

// ══════════════════ Retry ══════════════════

test('falha: conta tentativa, fica pendente ate o teto, depois vira falha', async () => {
  zerar();
  ligarTudo();
  const app = criarApplication();
  await comLogs(() => outbox.agendarSequencia({ ...app, criado_em: '2020-01-01 00:00:00' }));

  const envio = envioDuble({ falhar: true });
  const rodar = () =>
    comLogs(() => outbox.processarCicloSequencia(deps({ mock: false, enviarTexto: envio.fn, maxTentativas: 3 })));

  // Ciclos 1 e 2: continua pendente, contador sobe.
  for (const esperado of [1, 2]) {
    const { r } = await rodar();
    assert.equal(r.retentar, 2, `ciclo ${esperado}`);
    const linhas = fila(app.id);
    assert.equal(linhas.every((l) => l.status === 'pendente'), true, `ciclo ${esperado}`);
    assert.equal(linhas[0].tentativas, esperado);
    assert.match(linhas[0].erro, /socket caiu/);
  }

  // Ciclo 3: estoura o teto.
  const { r } = await rodar();
  assert.equal(r.falhas, 2);
  const linhas = fila(app.id);
  assert.equal(linhas.every((l) => l.status === 'falha'), true);
  assert.equal(linhas[0].tentativas, 3);

  // E nao volta mais: linha em 'falha' sai da fila.
  const { r: r4 } = await rodar();
  assert.equal(r4.enviados + r4.falhas + r4.retentar, 0);
});

test('telefone invalido na fila vai DIRETO para falha, sem retry', async () => {
  zerar();
  ligarTudo();
  const app = criarApplication();
  await comLogs(() => outbox.agendarSequencia({ ...app, criado_em: '2020-01-01 00:00:00' }));
  // Corrompe a fila como um dado ruim faria.
  exec("UPDATE whatsapp_sequencia_envios SET telefone_e164 = '123' WHERE application_id = ?", app.id);
  exec("UPDATE applications SET telefone = '123' WHERE id = ?", app.id);

  const envio = envioDuble();
  const { r } = await comLogs(() => outbox.processarCicloSequencia(deps({ mock: false, enviarTexto: envio.fn })));

  // Tentar de novo nao conserta o numero — a linha ficaria 'pendente' para sempre,
  // reaparecendo em todo ciclo.
  assert.equal(r.falhas, 2);
  assert.equal(envio.chamadas.length, 0);
  const linhas = fila(app.id);
  assert.equal(linhas.every((l) => l.status === 'falha' && /telefone invalido/.test(l.erro)), true);
});

// ══════════════════ Relogio, teto e throttle ══════════════════

test('so processa o que JA VENCEU', async () => {
  zerar();
  ligarTudo();

  // ── RELOGIO RELATIVO, e nao datas fixas ──
  // A primeira versao deste teste cravava '2026-08-14 10:00:00' como criado_em e
  // '2026-08-14 11:00:00' como "agora". Funcionou ate o dia virar para 14/08/2026: o WA1 e
  // agendado com o relogio REAL (agendarSequencia usa `new Date()`), entao passou a nascer
  // depois das 11:00 do fake e deixou de vencer. Teste que quebra por causa da data do
  // calendario e teste que mente sobre o produto.
  //
  // Agora tudo e relativo ao instante da execucao: criado_em = agora real, logo WA1 vence
  // imediatamente e WA2 (criado_em + 4h) esta no futuro por construcao, em qualquer dia.
  const agoraReal = new Date().toISOString().replace('T', ' ').slice(0, 19);
  const app = criarApplication('+55 (47) 99958-2500', agoraReal);
  await comLogs(() => outbox.agendarSequencia({ ...app, criado_em: agoraReal }));

  const envio = envioDuble();
  const { r } = await comLogs(() =>
    outbox.processarCicloSequencia(deps({ mock: false, enviarTexto: envio.fn })),
  );

  assert.equal(r.enviados, 1);
  const linhas = fila(app.id);
  assert.equal(linhas.find((l) => l.etapa === 'wa1').status, 'enviado');
  assert.equal(linhas.find((l) => l.etapa === 'wa2').status, 'pendente');
});

test('teto por ciclo: o resto fica para o proximo', async () => {
  zerar();
  ligarTudo();
  for (let i = 0; i < 5; i += 1) {
    const app = criarApplication(`+55 47 90000-000${i}`, '2020-01-01 00:00:00');
    await comLogs(() => outbox.agendarSequencia({ ...app, telefone: `+55 47 90000-000${i}`, criado_em: '2020-01-01 00:00:00' }));
  }
  const total = todas("SELECT id FROM whatsapp_sequencia_envios WHERE status='pendente'").length;
  assert.equal(total, 10);

  const { r } = await comLogs(() => outbox.processarCicloSequencia(deps({ mock: true, porCiclo: 3 })));
  assert.equal(r.enviados, 3);
  // Uma fila represada (instancia fora do ar por um dia) nao pode despejar tudo de uma vez —
  // rajada e o padrao que derruba numero de WhatsApp.
  assert.equal(todas("SELECT id FROM whatsapp_sequencia_envios WHERE status='pendente'").length, 7);
});

test('a fila sai por ordem de agendamento, nao por id', async () => {
  zerar();
  ligarTudo();
  const antigo = criarApplication('+55 47 90000-1111', '2020-01-01 00:00:00');
  await comLogs(() => outbox.agendarSequencia({ ...antigo, telefone: '+55 47 90000-1111', criado_em: '2020-01-01 00:00:00' }));
  const novo = criarApplication('+55 47 90000-2222', '2026-01-01 00:00:00');
  await comLogs(() => outbox.agendarSequencia({ ...novo, telefone: '+55 47 90000-2222', criado_em: '2026-01-01 00:00:00' }));

  const envio = envioDuble();
  await comLogs(() => outbox.processarCicloSequencia(deps({ mock: false, enviarTexto: envio.fn, porCiclo: 1 })));

  // Quem esperou mais sai primeiro — senao um WA2 atrasado ficaria para tras
  // indefinidamente enquanto WA1 novos passam na frente.
  assert.equal(envio.chamadas[0].telefone, '5547900001111');
});

test('throttle: intervalo aplicado ENTRE envios, nunca depois do ultimo', async () => {
  zerar();
  ligarTudo();
  const app = criarApplication('+55 47 90000-3333', '2020-01-01 00:00:00');
  await comLogs(() => outbox.agendarSequencia({ ...app, telefone: '+55 47 90000-3333', criado_em: '2020-01-01 00:00:00' }));

  // Espiao no lugar do sleep: mede sem esperar tempo real.
  const pausas = [];
  const envio = envioDuble();
  await comLogs(() =>
    outbox.processarCicloSequencia({
      mock: false,
      enviarTexto: envio.fn,
      intervaloMs: 3000,
      dormir: async (ms) => pausas.push(ms),
    }),
  );

  assert.equal(envio.chamadas.length, 2);
  // 2 envios = 1 pausa. Dormir depois do ultimo so atrasaria o fim do ciclo.
  assert.deepEqual(pausas, [3000]);
});

test('o texto enviado e o da ETAPA certa', async () => {
  zerar();
  ligarTudo();
  const app = criarApplication('+55 47 90000-4444', '2020-01-01 00:00:00');
  await comLogs(() => outbox.agendarSequencia({ ...app, telefone: '+55 47 90000-4444', criado_em: '2020-01-01 00:00:00' }));

  const envio = envioDuble();
  await comLogs(() => outbox.processarCicloSequencia(deps({ mock: false, enviarTexto: envio.fn })));

  // Localiza por CONTEUDO, e nao por indice: a fila sai por `agendado_para`, e com um
  // criado_em antigo o WA2 (criado_em+4h, em 2020) vence o WA1 (agora, 2026). A ordem esta
  // certa; supor que chamadas[0] e o WA1 e que estava errado.
  assert.equal(envio.chamadas.length, 2);
  const wa1 = envio.chamadas.find((c) => /Não precisa fazer nada agora/i.test(c.texto));
  const wa2 = envio.chamadas.find((c) => /vídeo curto de apresentação/i.test(c.texto));

  assert.ok(wa1, 'o texto do WA1 precisa ter saido');
  assert.ok(wa2, 'o texto do WA2 precisa ter saido');
  assert.doesNotMatch(wa1.texto, /vídeo/i, 'WA1 nao pede video');
  // O texto usa os dados da vaga vindos do JOIN da fila.
  assert.match(wa2.texto, /Vendedor Externo na Labor Seg/);
});

test('fila vazia nao faz barulho nem escreve nada', async () => {
  zerar();
  ligarTudo();
  const { r } = await comLogs(() => outbox.processarCicloSequencia(deps({ mock: true })));
  assert.deepEqual(r, { enviados: 0, falhas: 0, retentar: 0, pulados: 0 });
});
