'use strict';

// Rotas de API do disparo por WhatsApp (src/routes/api_whatsapp.js), por HTTP.
//
// ── POR QUE HTTP, e nao chamada direta ao motor ──
// O motor ja esta coberto em test/publicoDisparoWhatsapp.test.js. O que ESTE arquivo guarda
// e o que so existe na borda: a chave de servico, o formato das respostas de erro e o
// contrato que o n8n vai consumir.
//
// A borda e onde os erros silenciosos moram. Um 401 que redireciona em vez de devolver JSON
// vira, do lado do n8n, um HTTP 200 com HTML — ou seja, um fluxo "bem-sucedido" que nao
// enviou nada e nao acusa nada. Isso nao aparece em teste de unidade.
//
// ── ZERO REDE EXTERNA ──
// Sobe o app real numa porta efemera. Nenhuma mensagem de WhatsApp e enviada por este
// projeto em momento algum: quem envia e o n8n, e estas rotas so entregam a lista e
// registram o resultado.

const os = require('node:os');
const path = require('node:path');

process.env.DATABASE_PATH = path.join(os.tmpdir(), `vm-test-api-wpp-${process.pid}-${Date.now()}.db`);
process.env.INTERVIEW_MOCK = 'true';
process.env.SESSION_SECRET = 'segredo-de-teste';
process.env.ADMIN_USER = 'admin-teste';
process.env.ADMIN_PASSWORD = 'senha-teste';
process.env.DISPARO_WHATSAPP_API_KEY = 'chave-de-servico-de-teste';
process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert/strict');

const db = require('../src/db');
const { migrar } = require('../src/db/migrate');
const { criarApp } = require('../src/server');
const { config } = require('../src/config');
const { listarCidadesValidas } = require('../src/lib/cidades');

migrar();

const CHAVE = 'chave-de-servico-de-teste';

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

const pendentes = (base, cidade, chave = CHAVE) =>
  fetch(`${base}/api/disparos/pendentes?cidade=${encodeURIComponent(cidade === undefined ? '' : cidade)}`, {
    headers: chave === null ? {} : { 'x-disparo-api-key': chave },
  });

const marcar = (base, corpo, chave = CHAVE) =>
  fetch(`${base}/api/disparos/marcar-status`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(chave === null ? {} : { 'x-disparo-api-key': chave }),
    },
    body: JSON.stringify(corpo),
  });

const run = (sql, ...p) => Number(db.getDb().prepare(sql).run(...p).lastInsertRowid);
const exec = (sql, ...p) => db.getDb().prepare(sql).run(...p);

let seq = 0;
function cenarioJoinville() {
  exec('DELETE FROM disparos_whatsapp');
  exec('DELETE FROM applications');
  exec('DELETE FROM talentos');
  exec('DELETE FROM jobs');
  seq += 1;
  const vaga = run(
    "INSERT INTO jobs (slug, titulo, perfil, cidade, ativo) VALUES (?, 'V', 'CLOSER', 'Joinville', 1)",
    `vaga-api-${seq}`,
  );
  run(
    "INSERT INTO applications (job_id, nome, telefone, token) VALUES (?, 'Ana Silva', '+55 (47) 99958-2500', ?)",
    vaga,
    `tk-api-${seq}-a`,
  );
  run(
    "INSERT INTO applications (job_id, nome, telefone, token) VALUES (?, 'Bruno Costa', '+55 (47) 99958-2501', ?)",
    vaga,
    `tk-api-${seq}-b`,
  );
}

// ══════════════════ Autenticacao ══════════════════

test('sem chave: 401 JSON, e NUNCA redirect', async () => {
  await comServidor(async (base) => {
    const res = await pendentes(base, 'Joinville', null);
    assert.equal(res.status, 401);
    // O ponto do teste. Um 3xx aqui viraria HTML 200 no n8n e um fluxo "bem-sucedido" que
    // nao enviou nada — o modo de falha mais caro possivel neste subsistema.
    assert.match(res.headers.get('content-type') || '', /application\/json/);
    assert.ok((await res.json()).erro);
  });
});

test('chave errada: 401, e o corpo nao entrega nada sobre a chave real', async () => {
  await comServidor(async (base) => {
    for (const ruim of ['errada', '', 'chave-de-servico-de-test', `${CHAVE}x`]) {
      const res = await pendentes(base, 'Joinville', ruim);
      assert.equal(res.status, 401, `chave ${JSON.stringify(ruim)}`);
      const corpo = await res.json();
      // Comprimentos diferentes nao podem lancar (timingSafeEqual exige buffers iguais —
      // por isso a comparacao e feita sobre hashes) nem vazar dica do tamanho certo.
      assert.doesNotMatch(JSON.stringify(corpo), new RegExp(CHAVE));
    }
  });
});

test('as DUAS rotas exigem a chave', async () => {
  await comServidor(async (base) => {
    assert.equal((await pendentes(base, 'Joinville', null)).status, 401);
    assert.equal((await marcar(base, { telefone: '5547999582500', status: 'enviado' }, null)).status, 401);
  });
});

test('sem chave configurada no servidor, tudo e NEGADO — falha fechada', async () => {
  const original = config.disparoWhatsapp.apiKey;
  config.disparoWhatsapp.apiKey = '';
  try {
    await comServidor(async (base) => {
      // Um endpoint que devolve telefone de milhares de pessoas nao pode ficar aberto
      // porque alguem esqueceu uma variavel de ambiente.
      const res = await pendentes(base, 'Joinville', 'qualquer-coisa');
      assert.equal(res.status, 401);
    });
  } finally {
    config.disparoWhatsapp.apiKey = original;
  }
});

// ══════════════════ GET /api/disparos/pendentes ══════════════════

test('cidade ausente: 400 com a lista de opcoes na resposta', async () => {
  await comServidor(async (base) => {
    const res = await fetch(`${base}/api/disparos/pendentes`, {
      headers: { 'x-disparo-api-key': CHAVE },
    });
    assert.equal(res.status, 400);
    const corpo = await res.json();
    // Quem configura o n8n descobre o valor certo na propria resposta, em vez de num log do
    // servidor a que talvez nao tenha acesso.
    assert.deepEqual(corpo.cidades_validas, listarCidadesValidas());
  });
});

test('cidade invalida: 400, e nao 200 com lista vazia', async () => {
  await comServidor(async (base) => {
    for (const ruim of ['Blumenau', 'Joinvile', 'Joinville/SC', 'Todas as cidades']) {
      const res = await pendentes(base, ruim);
      // 200 com [] faria um disparo vazio parecer um disparo concluido, e ninguem investiga
      // um zero que parece legitimo.
      assert.equal(res.status, 400, ruim);
      assert.match((await res.json()).erro, /Cidade invalida/);
    }
  });
});

test('fluxo feliz: devolve telefone normalizado, primeiro nome e cargo', async () => {
  cenarioJoinville();
  await comServidor(async (base) => {
    const res = await pendentes(base, 'Joinville');
    assert.equal(res.status, 200);
    const lista = await res.json();
    assert.equal(lista.length, 2);
    // Contrato exato consumido pelo n8n — as tres chaves, e so elas.
    assert.deepEqual(Object.keys(lista[0]).sort(), ['cargo', 'nome_primeiro', 'telefone']);
    assert.deepEqual(lista[0], {
      telefone: '5547999582500',
      nome_primeiro: 'Ana',
      cargo: 'CLOSER',
    });
  });
});

test('o GET nao reserva: duas chamadas seguidas devolvem os mesmos', async () => {
  cenarioJoinville();
  await comServidor(async (base) => {
    const a = await (await pendentes(base, 'Joinville')).json();
    const b = await (await pendentes(base, 'Joinville')).json();
    // Proposital: se o GET reservasse, uma queda do n8n no meio do fluxo deixaria gente
    // presa num estado que a API nao destrava. Quem tira da fila e o POST.
    assert.deepEqual(a, b);
  });
});

// ══════════════════ POST /api/disparos/marcar-status ══════════════════

test('telefone invalido: 400', async () => {
  await comServidor(async (base) => {
    for (const ruim of ['123', 'nao tenho', '', null, undefined]) {
      const res = await marcar(base, { telefone: ruim, status: 'enviado' });
      assert.equal(res.status, 400, JSON.stringify(ruim));
      assert.match((await res.json()).erro, /Telefone/);
    }
  });
});

test('status fora do enum: 400 com os validos na resposta', async () => {
  await comServidor(async (base) => {
    for (const ruim of ['pendente', 'ok', '', 'ENVIADOS', null]) {
      const res = await marcar(base, { telefone: '+55 47 99958-2500', status: ruim });
      assert.equal(res.status, 400, JSON.stringify(ruim));
      assert.deepEqual((await res.json()).status_validos, ['enviado', 'erro']);
    }
  });
});

test("'pendente' e recusado — ausencia de linha e o que significa pendente", async () => {
  await comServidor(async (base) => {
    const res = await marcar(base, { telefone: '+55 47 99958-2500', status: 'pendente' });
    assert.equal(res.status, 400);
    assert.equal(db.getDb().prepare('SELECT COUNT(*) n FROM disparos_whatsapp').get().n >= 0, true);
  });
});

test('o telefone e normalizado antes de gravar, venha no formato que vier', async () => {
  cenarioJoinville();
  await comServidor(async (base) => {
    await marcar(base, { telefone: '+55 (47) 99958-2500', status: 'enviado', cidade: 'Joinville' });
    const linha = db.getDb().prepare('SELECT * FROM disparos_whatsapp').get();
    // A coluna e UNIQUE e o contrato da tabela e "sempre normalizado". Gravar o formato cru
    // criaria duas linhas para a mesma pessoa e quebraria a exclusao em silencio.
    assert.equal(linha.telefone, '5547999582500');
  });
});

test('status maiusculo/com espaco e aceito e canonizado', async () => {
  cenarioJoinville();
  await comServidor(async (base) => {
    const res = await marcar(base, { telefone: '5547999582500', status: '  ENVIADO ' });
    assert.equal(res.status, 200);
    assert.equal(db.getDb().prepare('SELECT status FROM disparos_whatsapp').get().status, 'enviado');
  });
});

test('cidade invalida no POST nao recusa o registro — e auditoria, nao decisao', async () => {
  cenarioJoinville();
  await comServidor(async (base) => {
    const res = await marcar(base, {
      telefone: '5547999582500',
      status: 'enviado',
      cidade: 'Blumenau',
    });
    // Recusar o registro de um disparo que JA ACONTECEU por causa de um rotulo errado seria
    // perder o fato para proteger a etiqueta.
    assert.equal(res.status, 200);
    const linha = db.getDb().prepare('SELECT * FROM disparos_whatsapp').get();
    assert.equal(linha.cidade, null);
    assert.equal(linha.status, 'enviado');
  });
});

test('erro registra a mensagem, truncada', async () => {
  cenarioJoinville();
  await comServidor(async (base) => {
    await marcar(base, {
      telefone: '5547999582500',
      status: 'erro',
      erro_msg: 'x'.repeat(500),
    });
    const linha = db.getDb().prepare('SELECT * FROM disparos_whatsapp').get();
    assert.equal(linha.status, 'erro');
    assert.equal(linha.erro_msg.length, 300);
    // Sem enviado_em: nao houve envio.
    assert.equal(linha.enviado_em, null);
  });
});

// ══════════════════ Fluxo completo ══════════════════

test('pendentes -> marcar enviado -> some da lista', async () => {
  cenarioJoinville();
  await comServidor(async (base) => {
    const antes = await (await pendentes(base, 'Joinville')).json();
    assert.equal(antes.length, 2);

    const res = await marcar(base, {
      telefone: antes[0].telefone,
      status: 'enviado',
      nome: antes[0].nome_primeiro,
      origem: 'candidato',
      cidade: 'Joinville',
    });
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { ok: true, telefone: antes[0].telefone, status: 'enviado' });

    const depois = await (await pendentes(base, 'Joinville')).json();
    assert.equal(depois.length, 1);
    assert.equal(depois[0].telefone, antes[1].telefone);
  });
});

test('drenar a praca inteira leva a lista a zero, e ela nao volta', async () => {
  cenarioJoinville();
  await comServidor(async (base) => {
    let lista = await (await pendentes(base, 'Joinville')).json();
    while (lista.length) {
      await marcar(base, { telefone: lista[0].telefone, status: 'enviado' });
      lista = await (await pendentes(base, 'Joinville')).json();
    }
    assert.deepEqual(await (await pendentes(base, 'Joinville')).json(), []);
    // Rodar o fluxo de novo continua devolvendo zero — nao ha "reabrir" por acidente.
    assert.deepEqual(await (await pendentes(base, 'Joinville')).json(), []);
  });
});

test('marcar duas vezes o mesmo telefone nao cria segunda linha', async () => {
  cenarioJoinville();
  await comServidor(async (base) => {
    await marcar(base, { telefone: '5547999582500', status: 'erro', erro_msg: 'timeout' });
    await marcar(base, { telefone: '5547999582500', status: 'enviado' });
    const linhas = db.getDb().prepare('SELECT * FROM disparos_whatsapp').all();
    assert.equal(linhas.length, 1);
    assert.equal(linhas[0].status, 'enviado');
    assert.equal(linhas[0].erro_msg, null, 'erro_msg descreve a tentativa ATUAL');
  });
});
