'use strict';

// Reverificacao do STATUS DO RECRUTADOR no momento do envio da campanha de e-mail
// (lib/dispararPromocao.js) — ETAPA B, Incremento B4.
//
// A fila e congelada no disparo; se a pessoa virar Aprovado/Em analise depois disso, a linha
// sai da fila como 'cancelado' + 'status_nao_elegivel', sem tocar o provedor e sem contar
// como falha. Tudo com transporte DUBLE (nenhuma rede) e credenciais ficticias no env — as
// mesmas do resto da suite de promocao, so para o pre-voo do enfileiramento passar.

const os = require('node:os');
const path = require('node:path');

process.env.DATABASE_PATH = path.join(os.tmpdir(), `vm-test-promocao-reverif-${process.pid}-${Date.now()}.db`);
process.env.INTERVIEW_MOCK = 'true';
process.env.SESSION_SECRET = 'segredo-de-teste';
process.env.ADMIN_USER = 'admin-teste';
process.env.ADMIN_PASSWORD = 'senha-teste';
process.env.DESCADASTRO_SECRET = 'segredo-de-descadastro-de-teste';
process.env.APP_BASE_URL = 'https://entrevista.exemplo.com.br';
process.env.SMTP_CAMPANHA_HOST = 'smtp.exemplo-provedor.com';
process.env.SMTP_CAMPANHA_USUARIO = 'usuario-de-teste';
process.env.SMTP_CAMPANHA_SENHA = 'senha-de-teste';
process.env.SMTP_CAMPANHA_FROM_EMAIL = 'vagas@vagas.exemplo.com.br';
process.env.EMAILIT_API_KEY = 'em_chave-de-teste';
process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert/strict');

const db = require('../src/db');
const { migrar } = require('../src/db/migrate');
const { config } = require('../src/config');
const { criarApp } = require('../src/server');
const disparo = require('../src/lib/dispararPromocao');

migrar();

// Transporte duble: registra o destinatario de cada chamada. Nada sai do processo.
let enviados = [];
const emailCampanhaDuble = {
  async enviar(destinatario) {
    enviados.push(destinatario);
    return { id: `fake-${enviados.length}` };
  },
};

const run = (sql, ...p) => Number(db.getDb().prepare(sql).run(...p).lastInsertRowid);
const exec = (sql, ...p) => db.getDb().prepare(sql).run(...p);
const linhaDe = (campanhaId, email) =>
  db.getDb().prepare('SELECT * FROM campanha_envios WHERE campanha_id = ? AND email = ?').get(campanhaId, email);

let seq = 0;
function vaga() {
  seq += 1;
  return run('INSERT INTO jobs (slug, titulo, perfil, ativo) VALUES (?, ?, ?, 1)', `vaga-reverif-${seq}`, `Vaga ${seq}`, 'CLOSER');
}
function candidatura(jobId, email, { telefone = null, status = null } = {}) {
  seq += 1;
  return run(
    `INSERT INTO applications (job_id, nome, email, telefone, status_recrutador, token)
     VALUES (?, ?, ?, ?, ?, ?)`,
    jobId,
    `Pessoa ${seq}`,
    email,
    telefone,
    status,
    `tok-reverif-${seq}`,
  );
}
function talento(email, { telefone = null } = {}) {
  seq += 1;
  return run(
    "INSERT INTO talentos (nome, email, telefone, categoria) VALUES (?, ?, ?, 'legado')",
    `Talento ${seq}`,
    email,
    telefone,
  );
}
function zerar() {
  for (const t of ['campanha_envios', 'campanhas', 'applications', 'talentos', 'descadastros', 'jobs']) exec(`DELETE FROM ${t}`);
  enviados = [];
}

async function calado(fn) {
  const { log, warn, error } = console;
  console.log = console.warn = console.error = () => {};
  try {
    return await fn();
  } finally {
    Object.assign(console, { log, warn, error });
  }
}

// Cria o rascunho e ENFILEIRA (materializa) pelo caminho real, com o publico calculado agora.
async function enfileirar(criterios, jobId) {
  const id = db.criarCampanha({
    job_id: jobId,
    tipo: criterios.tipo || 'divulgacao_vaga',
    assunto: 'Vaga aberta',
    corpo_html: '<p>Temos uma vaga.</p>',
    criterios,
    total_destinatarios: 0,
  });
  const r = await calado(() => disparo.enfileirarCampanha(id, { db }));
  assert.equal(r.ok, true, JSON.stringify(r));
  return id;
}
const divulgacao = (alvo) => enfileirar({ tipo: 'divulgacao_vaga', jobIdAlvo: alvo }, alvo);

async function ciclo(deps = {}) {
  return calado(() =>
    disparo.varrerDisparoPromocao({ db, emailCampanha: emailCampanhaDuble, dormir: async () => {}, ...deps }),
  );
}

test.before(() => {
  db.definirConfigBool(disparo.CHAVE_ATIVO, true);
  // Mock desligado EM PROCESSO para o duble ser chamado de verdade (mesmo padrao de
  // promocaoDisparo.test.js). O duble e o unico "transporte" existente aqui.
  config.entrevista.mock = false;
});
test.after(() => {
  config.entrevista.mock = true;
});

test('virou APROVADO depois do disparo: cancelado com o motivo, sem chamar o transporte', async () => {
  zerar();
  const antiga = vaga();
  const alvo = vaga();
  const idAna = candidatura(antiga, 'ana@x.com');
  candidatura(antiga, 'bia@x.com', { status: 'reprovado' });
  const id = await divulgacao(alvo);
  assert.equal(db.contarEnviosCampanha(id).pendente, 2);

  db.definirStatusRecrutador(idAna, 'aprovado');
  const r = await ciclo();

  assert.deepEqual(enviados, ['bia@x.com'], 'o transporte NAO pode ser chamado para ana');
  const ana = linhaDe(id, 'ana@x.com');
  assert.equal(ana.status, 'cancelado');
  assert.equal(ana.erro, db.ERRO_STATUS_NAO_ELEGIVEL);
  assert.equal(ana.erro, 'status_nao_elegivel');
  assert.equal(ana.tentativas, 0, 'nao houve tentativa de canal');
  assert.equal(r.canceladosPorStatus, 1);
  assert.equal(r.falhas, 0);
  assert.equal(r.enviados, 1);

  const c = db.contarEnviosCampanha(id);
  assert.equal(c.canceladoPorStatus, 1);
  assert.equal(c.cancelado, 1);
  assert.equal(c.falha, 0);
  assert.equal(c.pendente, 0);
  assert.equal(db.obterCampanha(id).status, 'concluida', 'a campanha conclui normalmente');
});

test('virou EM ANALISE: idem; quem continua elegivel envia normalmente', async () => {
  zerar();
  const antiga = vaga();
  const alvo = vaga();
  const idCaio = candidatura(antiga, 'caio@x.com');
  candidatura(antiga, 'dani@x.com');
  talento('legado@x.com');
  const id = await divulgacao(alvo);

  db.definirStatusRecrutador(idCaio, 'em_analise');
  const r = await ciclo();

  assert.deepEqual(enviados.sort(), ['dani@x.com', 'legado@x.com']);
  assert.equal(linhaDe(id, 'caio@x.com').status, 'cancelado');
  assert.equal(r.canceladosPorStatus, 1);
});

test('cruzamento por telefone tambem vale no envio (mesmas chaves da montagem)', async () => {
  zerar();
  const antiga = vaga();
  const alvo = vaga();
  // Talento e candidatura com e-mails diferentes e o MESMO numero (grafias diferentes).
  talento('talento@x.com', { telefone: '4799582500' });
  const idOutra = candidatura(antiga, 'outra@x.com', { telefone: '+55 47 99958-2500' });
  const id = await divulgacao(alvo);

  db.definirStatusRecrutador(idOutra, 'aprovado');
  await ciclo();

  assert.deepEqual(enviados, []);
  assert.equal(linhaDe(id, 'talento@x.com').status, 'cancelado');
  assert.equal(linhaDe(id, 'outra@x.com').status, 'cancelado');
});

test('indice montado UMA vez por ciclo, nao por item', async () => {
  zerar();
  const antiga = vaga();
  const alvo = vaga();
  for (let i = 0; i < 5; i++) candidatura(antiga, `p${i}@x.com`);
  await divulgacao(alvo);

  const leituras = { status: 0, telefones: 0 };
  const dbEspiao = {
    ...db,
    listarStatusRecrutadorParaElegibilidade: () => {
      leituras.status += 1;
      return db.listarStatusRecrutadorParaElegibilidade();
    },
    listarTelefonesPorEmailParaElegibilidade: () => {
      leituras.telefones += 1;
      return db.listarTelefonesPorEmailParaElegibilidade();
    },
  };
  const r = await ciclo({ db: dbEspiao });
  assert.equal(r.enviados, 5);
  assert.deepEqual(leituras, { status: 1, telefones: 1 });
});

test('falha ao montar o indice: itens ficam PENDENTES, nada enviado, nada cancelado; proximo ciclo retoma', async () => {
  zerar();
  const antiga = vaga();
  const alvo = vaga();
  candidatura(antiga, 'e1@x.com');
  candidatura(antiga, 'e2@x.com');
  const id = await divulgacao(alvo);

  const dbQuebrado = {
    ...db,
    listarStatusRecrutadorParaElegibilidade: () => {
      throw new Error('database is locked');
    },
  };
  const r = await ciclo({ db: dbQuebrado });
  assert.deepEqual(enviados, []);
  assert.equal(r.adiadosPorStatus, 2);
  assert.equal(r.falhas, 0);
  const c = db.contarEnviosCampanha(id);
  assert.equal(c.pendente, 2);
  assert.equal(c.cancelado, 0);
  assert.equal(linhaDe(id, 'e1@x.com').tentativas, 0);
  assert.notEqual(db.obterCampanha(id).status, 'concluida', 'com pendentes, nao conclui');

  const r2 = await ciclo();
  assert.equal(r2.enviados, 2);
  assert.equal(db.obterCampanha(id).status, 'concluida');
});

test('convite_grupo: sem reverificacao, aprovado continua recebendo, indice nem e lido', async () => {
  zerar();
  const antiga = vaga();
  const idAprov = candidatura(antiga, 'aprov@x.com', { status: 'aprovado' });
  candidatura(antiga, 'emanal@x.com', { status: 'em_analise' });
  const id = await enfileirar({ tipo: 'convite_grupo', cidadeGrupo: 'Joinville' }, null);
  db.definirStatusRecrutador(idAprov, 'aprovado');

  let leituras = 0;
  const dbEspiao = {
    ...db,
    listarStatusRecrutadorParaElegibilidade: () => {
      leituras += 1;
      return [];
    },
  };
  const r = await ciclo({ db: dbEspiao });
  assert.deepEqual(enviados.sort(), ['aprov@x.com', 'emanal@x.com']);
  assert.equal(r.canceladosPorStatus, 0);
  assert.equal(leituras, 0);
  assert.equal(db.contarEnviosCampanha(id).cancelado, 0);
});

test('fila com varios cancelados seguidos de elegiveis: todos os elegiveis saem no MESMO ciclo', async () => {
  zerar();
  const antiga = vaga();
  const alvo = vaga();
  const viram = [];
  for (let i = 0; i < 4; i++) viram.push(candidatura(antiga, `vira${i}@x.com`));
  for (let i = 0; i < 3; i++) candidatura(antiga, `fica${i}@x.com`);
  const id = await divulgacao(alvo);
  for (const a of viram) db.definirStatusRecrutador(a, 'aprovado');

  const r = await ciclo();
  assert.deepEqual(enviados.sort(), ['fica0@x.com', 'fica1@x.com', 'fica2@x.com']);
  assert.equal(r.canceladosPorStatus, 4);
  // Nenhum cancelado volta a fila: nao ha o que travar o ORDER BY id LIMIT.
  assert.equal(db.listarEnviosPendentesCampanha({ limite: 125 }).length, 0);
  assert.equal(db.obterCampanha(id).status, 'concluida');
});

test('retentativa NAO reprocessa cancelado por status (linha terminal)', async () => {
  zerar();
  const antiga = vaga();
  const alvo = vaga();
  const idX = candidatura(antiga, 'x@x.com');
  const id = await divulgacao(alvo);
  db.definirStatusRecrutador(idX, 'aprovado');
  await ciclo();
  const linha = linhaDe(id, 'x@x.com');
  assert.equal(linha.status, 'cancelado');

  // Volta a ser elegivel: a linha NAO ressuscita — cancelar e terminal.
  db.definirStatusRecrutador(idX, 'reprovado');
  enviados = [];
  await ciclo();
  assert.deepEqual(enviados, []);
  // E as escritas de retentativa/falha nao a tocam (condicionais ao 'pendente').
  assert.equal(db.registrarTentativaEnvioCampanha(linha.id, 'x'), 0);
  assert.equal(db.marcarEnvioCampanhaFalha(linha.id, 'x'), 0);
  const depois = linhaDe(id, 'x@x.com');
  assert.equal(depois.status, 'cancelado');
  assert.equal(depois.tentativas, 0);
  assert.equal(depois.erro, 'status_nao_elegivel');
});

test('tela de andamento mostra o cancelado por status SEPARADO de falha', async () => {
  zerar();
  const antiga = vaga();
  const alvo = vaga();
  const idY = candidatura(antiga, 'y@x.com');
  candidatura(antiga, 'z@x.com');
  const id = await divulgacao(alvo);
  db.definirStatusRecrutador(idY, 'aprovado');
  await ciclo();

  const app = criarApp();
  const server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  try {
    const base = `http://127.0.0.1:${server.address().port}`;
    const login = await fetch(`${base}/admin/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ usuario: 'admin-teste', senha: 'senha-teste' }),
      redirect: 'manual',
    });
    const cookie = login.headers.getSetCookie().map((c) => c.split(';')[0]).join('; ');
    const html = await (await fetch(`${base}/admin/promocao/${id}`, { headers: { Cookie: cookie } })).text();
    // Campanha CONCLUIDA: o motivo continua na tela (e no banco) depois do fim.
    assert.equal(db.obterCampanha(id).status, 'concluida');
    assert.match(html, /<b>1<\/b> fora da fila por status do recrutador/);
    assert.match(html, /<b>1<\/b> enviados de <b>1<\/b>\s*elegíveis no envio/);
    assert.doesNotMatch(html, /falhas? de envio/);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('e-mail em CAIXA diferente: candidatura gravada em maiuscula e linha da fila fora do padrao', async () => {
  zerar();
  const antiga = vaga();
  const alvo = vaga();
  const idAna = candidatura(antiga, 'Ana.Souza@Exemplo.COM');
  candidatura(antiga, 'bia@x.com');
  const id = await divulgacao(alvo);
  // A materializacao grava normalizado; simula uma linha legada fora do padrao para provar
  // que a checagem normaliza a chave da FILA tambem, e nao so a do indice.
  exec("UPDATE campanha_envios SET email = '  ANA.SOUZA@exemplo.com ' WHERE campanha_id = ? AND email = 'ana.souza@exemplo.com'", id);
  db.definirStatusRecrutador(idAna, 'aprovado');

  const r = await ciclo();
  assert.equal(r.canceladosPorStatus, 1);
  assert.deepEqual(enviados, ['bia@x.com']);
});

test('adiamento SEGUIDO: a partir do limite, log agregado por campanha, sem cancelar; zera ao voltar', async () => {
  zerar();
  const antiga = vaga();
  const alvo = vaga();
  candidatura(antiga, 'segredo-pessoal@x.com', { telefone: '+55 47 91234-5678' });
  const id = await divulgacao(alvo);
  const dbQuebrado = {
    ...db,
    listarStatusRecrutadorParaElegibilidade: () => {
      throw new Error('database is locked');
    },
  };

  const capturar = async (deps) => {
    const linhas = [];
    const { log, warn, error } = console;
    console.log = console.warn = console.error = (...a) => linhas.push(a.join(' '));
    try {
      await disparo.varrerDisparoPromocao({ db, emailCampanha: emailCampanhaDuble, dormir: async () => {}, ...deps });
    } finally {
      Object.assign(console, { log, warn, error });
    }
    return linhas.filter((l) => l.includes('ciclos seguidos adiados'));
  };

  const avisos = [];
  for (let i = 1; i <= disparo.LIMITE_CICLOS_ADIADOS + 1; i++) avisos.push(await capturar({ db: dbQuebrado }));
  // Nada antes do limite; do limite em diante, um aviso por ciclo.
  for (let i = 0; i < disparo.LIMITE_CICLOS_ADIADOS - 1; i++) assert.equal(avisos[i].length, 0, `ciclo ${i + 1}`);
  assert.equal(avisos[disparo.LIMITE_CICLOS_ADIADOS - 1].length, 1);
  assert.match(avisos[disparo.LIMITE_CICLOS_ADIADOS - 1][0], new RegExp(`campanha ${id}: ${disparo.LIMITE_CICLOS_ADIADOS} ciclos seguidos`));
  assert.match(avisos[disparo.LIMITE_CICLOS_ADIADOS][0], new RegExp(`${disparo.LIMITE_CICLOS_ADIADOS + 1} ciclos seguidos`));
  // Sem dado pessoal no aviso.
  for (const a of avisos.flat()) {
    assert.doesNotMatch(a, /segredo-pessoal|@|91234|5678/);
  }
  // Nada cancelado, nada enviado, linha intacta.
  assert.equal(db.contarEnviosCampanha(id).pendente, 1);
  assert.deepEqual(enviados, []);

  // Checagem volta: envia, e o contador zera — um novo adiamento isolado nao avisa.
  assert.deepEqual(await capturar({}), []);
  assert.deepEqual(enviados, ['segredo-pessoal@x.com']);
  const antiga2 = vaga();
  const alvo2 = vaga();
  candidatura(antiga2, 'outra@x.com');
  await divulgacao(alvo2);
  assert.deepEqual(await capturar({ db: dbQuebrado }), []);
});
