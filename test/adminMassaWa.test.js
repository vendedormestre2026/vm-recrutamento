'use strict';

// B5 — telas do disparo em massa (/admin/massa-wa), ponta a ponta por HTTP.
//
// ══════════════════════════════════════════════════════════════
// O QUE ESTE ARQUIVO GUARDA
// ══════════════════════════════════════════════════════════════
// Nao e a aparencia das telas: sao as TRAVAS. Cada passo do caminho (criar -> variacoes -> previa
// -> materializar -> ativar) so pode acontecer depois do anterior, e nenhum deles pode acontecer
// por efeito colateral de outro. Um botao que ativa uma campanha sem fila, ou uma tela que
// materializa duas vezes, e um disparo errado — e disparo errado nao se desfaz.
//
// MASSA_WA_MOCK fica no default (ligado): nenhuma mensagem sai destes testes, nem pelo botao de
// teste para 1 numero.

const os = require('node:os');
const path = require('node:path');

process.env.DATABASE_PATH = path.join(
  os.tmpdir(),
  `vm-test-admin-massa-wa-${process.pid}-${Date.now()}.db`,
);
process.env.INTERVIEW_MOCK = 'true';
process.env.SESSION_SECRET = 'segredo-de-teste';
process.env.OPTOUT_TOKEN_SECRET = 'segredo-hmac-de-teste';
process.env.ADMIN_USER = 'admin-teste';
process.env.ADMIN_PASSWORD = 'senha-teste';
process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert/strict');

const db = require('../src/db');
const { migrar } = require('../src/db/migrate');
const { criarApp } = require('../src/server');
const { VARIACOES_SEED, TOTAL_VARIACOES } = require('../src/lib/variacoesMassaWa');

migrar();

const LINK_MEET = 'https://meet.google.com/abc-defg-hij';

// Datas relativas a hoje: uma data fixa no futuro vira passado e o teste passa a falhar sozinho.
function diaRelativo(dias) {
  const d = new Date(Date.now() + dias * 24 * 60 * 60 * 1000);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
}
const DAQUI_10 = diaRelativo(10);

let cookieAdmin = '';
let seq = 0;

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
const get = async (base, url) => (await fetch(`${base}${url}`, { headers: comAuth() })).text();

async function post(base, url, campos) {
  const body = new URLSearchParams();
  for (const [k, v] of Object.entries(campos || {})) {
    if (Array.isArray(v)) v.forEach((x) => body.append(k, x));
    else body.append(k, v);
  }
  return fetch(`${base}${url}`, {
    method: 'POST',
    headers: comAuth({ 'Content-Type': 'application/x-www-form-urlencoded' }),
    body,
    redirect: 'manual',
  });
}

function criarVaga({ comReuniao = true } = {}) {
  seq += 1;
  return db.criarVaga({
    slug: `vaga-admin-massa-${seq}`,
    titulo: `Closer ${seq}`,
    perfil: 'CLOSER',
    empresa: 'Acme Ltda',
    ativo: true,
    link_meet: comReuniao ? LINK_MEET : null,
    entrevista_grupo_1_data: comReuniao ? DAQUI_10 : null,
    entrevista_grupo_1_hora: comReuniao ? '19:30' : null,
  });
}

function criarCandidatura(jobId, { status = null } = {}) {
  seq += 1;
  const telefone = `+55 47 9${String(90000000 + seq).slice(0, 8)}`;
  return Number(
    db.getDb()
      .prepare(`INSERT INTO applications (job_id, nome, telefone, status_recrutador) VALUES (?, ?, ?, ?)`)
      .run(jobId, `Pessoa ${seq}`, telefone, status).lastInsertRowid,
  );
}

const variacoesDoCorpo = (textos) =>
  Object.fromEntries(textos.map((t, i) => [`variacao_${i + 1}`, t]));

function limpar() {
  const conn = db.getDb();
  conn.exec('DELETE FROM campanhas_massa_wa_envios');
  conn.exec('DELETE FROM campanhas_massa_wa_variacoes');
  conn.exec('DELETE FROM campanhas_massa_wa');
  conn.exec('DELETE FROM applications');
  conn.exec('DELETE FROM whatsapp_optout');
  conn.exec('DELETE FROM whatsapp_opt_out');
  conn.exec('DELETE FROM jobs');
}

const ultimaCampanha = () => db.getDb().prepare('SELECT * FROM campanhas_massa_wa ORDER BY id DESC LIMIT 1').get();
const totalNaFila = (id) => db.resumoCampanhaMassaWa(id).reduce((a, l) => a + l.n, 0);

// ══════════════════ ESTADO DO CANAL ══════════════════

test('a tela diz, no topo, se o disparo esta ligado, se e mock e se o socket esta de pe', async () => {
  // Um operador que nao sabe em qual desses estados esta e um operador que vai concluir a coisa
  // errada sobre o que aconteceu.
  limpar();
  await comServidor(async (base) => {
    await autenticar(base);
    const html = await get(base, '/admin/massa-wa');
    assert.match(html, /Disparo em massa DESLIGADO/, 'o interruptor nasce desligado');
    assert.match(html, /MOCK \(não envia\)/);
    assert.match(html, /WhatsApp: desconectado/);
    assert.match(html, /MODO MOCK ligado/);
  });
});

// ══════════════════ CRIAR ══════════════════

test('cria a campanha como RASCUNHO, com as 7 sementes ja salvas', async () => {
  limpar();
  const jobId = criarVaga();
  await comServidor(async (base) => {
    await autenticar(base);
    const res = await post(base, '/admin/massa-wa', {
      nome: 'Convite outubro',
      job_id: String(jobId),
      status: ['sem_decisao', 'em_analise'],
      texto_base: 'base',
    });
    assert.ok(res.status < 400);

    const c = ultimaCampanha();
    assert.equal(c.nome, 'Convite outubro');
    assert.equal(c.status, 'rascunho', 'nunca nasce ativa');
    assert.equal(c.job_id, jobId);
    assert.deepEqual(JSON.parse(c.criterios_json).statusList.sort(), ['em_analise', 'sem_decisao']);
    assert.equal(db.listarVariacoesMassaWa(c.id).length, TOTAL_VARIACOES);
  });
});

test('o formulario vem com aprovado e reprovado DESMARCADOS', async () => {
  limpar();
  await comServidor(async (base) => {
    await autenticar(base);
    const html = await get(base, '/admin/massa-wa/nova');
    assert.match(html, /value="sem_decisao" checked/);
    assert.match(html, /value="em_analise" checked/);
    assert.match(html, /value="aprovado"(?! checked)/);
    assert.match(html, /value="reprovado"(?! checked)/);
  });
});

test('recusa campanha sem nome e sem nenhum status marcado', async () => {
  limpar();
  await comServidor(async (base) => {
    await autenticar(base);
    const semNome = await post(base, '/admin/massa-wa', { nome: '  ', status: ['sem_decisao'] });
    assert.match(semNome.headers.get('location') || '', /erro=nome/);

    const semStatus = await post(base, '/admin/massa-wa', { nome: 'X' });
    assert.match(semStatus.headers.get('location') || '', /erro=status/);
    assert.equal(ultimaCampanha(), undefined, 'nada foi criado');
  });
});

test('a cadencia aprovada aparece na tela em texto legivel', async () => {
  limpar();
  const jobId = criarVaga();
  await comServidor(async (base) => {
    await autenticar(base);
    await post(base, '/admin/massa-wa', { nome: 'C', job_id: String(jobId), status: ['sem_decisao'] });
    const html = await get(base, `/admin/massa-wa/${ultimaCampanha().id}`);
    assert.match(html, /lotes de 5–8/);
    assert.match(html, /20–60s entre mensagens/);
    assert.match(html, /teto 30\/dia/);
    assert.match(html, /09:00–18:00/);
    // A lista TERMINA em sab: e isso que prova que domingo ficou fora. Sondar por "dom" na pagina
    // inteira nao serve — a palavra aparece no rotulo do campo de dias ("1=seg … 7=dom").
    assert.match(html, /seg, ter, qua, qui, sex, sáb\)/);
  });
});

// ══════════════════ PREVIA COM FUNIL ABERTO ══════════════════

test('a previa mostra o funil aberto, com as unidades explicadas', async () => {
  limpar();
  const jobId = criarVaga();
  criarCandidatura(jobId);
  criarCandidatura(jobId, { status: 'aprovado' });
  await comServidor(async (base) => {
    await autenticar(base);
    await post(base, '/admin/massa-wa', { nome: 'C', job_id: String(jobId), status: ['sem_decisao'] });
    const html = await get(base, `/admin/massa-wa/${ultimaCampanha().id}`);

    assert.match(html, /Candidaturas em vagas abertas/);
    assert.match(html, /fora por status do recrutador/);
    assert.match(html, /fora por telefone inutilizável/);
    assert.match(html, /duplicadas \(mesma pessoa\)/);
    assert.match(html, /fora por opt-out/);
    assert.match(html, /PÚBLICO FINAL/);
    assert.match(html, /contam <b>candidaturas<\/b>/);
    // A tela precisa dizer que "sem WhatsApp" NAO e descontado aqui, senao o numero final parece
    // prometer mais do que entrega.
    assert.match(html, /não é descontado aqui/);
  });
});

test('a previa e recalculada a cada abertura (nao um numero congelado)', async () => {
  limpar();
  const jobId = criarVaga();
  criarCandidatura(jobId);
  await comServidor(async (base) => {
    await autenticar(base);
    await post(base, '/admin/massa-wa', { nome: 'C', job_id: String(jobId), status: ['sem_decisao'] });
    const id = ultimaCampanha().id;

    const antes = await get(base, `/admin/massa-wa/${id}`);
    assert.match(antes, /PÚBLICO FINAL<\/dt><dd>1/);

    criarCandidatura(jobId);
    const depois = await get(base, `/admin/massa-wa/${id}`);
    assert.match(depois, /PÚBLICO FINAL<\/dt><dd>2/);
  });
});

// ══════════════════ VARIACOES ══════════════════

test('salva as 7 variacoes e diz que passaram na validacao', async () => {
  limpar();
  const jobId = criarVaga();
  await comServidor(async (base) => {
    await autenticar(base);
    await post(base, '/admin/massa-wa', { nome: 'C', job_id: String(jobId), status: ['sem_decisao'] });
    const id = ultimaCampanha().id;

    await post(base, `/admin/massa-wa/${id}/variacoes`, variacoesDoCorpo([...VARIACOES_SEED]));
    const html = await get(base, `/admin/massa-wa/${id}`);
    assert.match(html, /As 7 variações passam na validação/);
  });
});

test('variacao invalida e SALVA, mas a tela lista o problema em portugues', async () => {
  // Perder o texto digitado porque falta um token e pior que salvar algo que a tela ja acusa.
  limpar();
  const jobId = criarVaga();
  await comServidor(async (base) => {
    await autenticar(base);
    await post(base, '/admin/massa-wa', { nome: 'C', job_id: String(jobId), status: ['sem_decisao'] });
    const id = ultimaCampanha().id;

    const ruins = [...VARIACOES_SEED];
    ruins[2] = 'Oi {vaga}, sem mais nada.';
    await post(base, `/admin/massa-wa/${id}/variacoes`, variacoesDoCorpo(ruins));

    const html = await get(base, `/admin/massa-wa/${id}`);
    assert.match(html, /Pendências/);
    assert.match(html, /Variação 3: falta/);
    assert.match(html, /falta o link de descadastro/);
    // O texto ruim continua no campo, para o operador corrigir.
    assert.ok(html.includes('Oi {vaga}, sem mais nada.'));
  });
});

test('a tela mostra a previa da mensagem com dados REAIS da vaga', async () => {
  limpar();
  const jobId = criarVaga();
  await comServidor(async (base) => {
    await autenticar(base);
    await post(base, '/admin/massa-wa', { nome: 'C', job_id: String(jobId), status: ['sem_decisao'] });
    const html = await get(base, `/admin/massa-wa/${ultimaCampanha().id}`);

    assert.match(html, /Prévia da variação 1, com dados reais/);
    assert.ok(html.includes(LINK_MEET), 'a previa tem que mostrar o link de verdade');
    assert.match(html, /Acme Ltda/);
    assert.match(html, /19:30/);
    assert.match(html, /Olá, Maria!/);
    // O *negrito* do WhatsApp aparece como negrito na previa, e nao com asteriscos.
    assert.match(html, /<b>Acme Ltda<\/b>/);
    assert.match(html, /\/descadastro-whatsapp\//, 'a previa mostra onde vai o link de descadastro');
  });
});

test('vaga SEM data: a tela avisa que ninguem receberia mensagem', async () => {
  limpar();
  const jobId = criarVaga({ comReuniao: false });
  await comServidor(async (base) => {
    await autenticar(base);
    await post(base, '/admin/massa-wa', { nome: 'C', job_id: String(jobId), status: ['sem_decisao'] });
    const html = await get(base, `/admin/massa-wa/${ultimaCampanha().id}`);
    assert.match(html, /não tem entrevista em grupo futura com link/);
    assert.match(html, /nenhum destinatário/i);
  });
});

test('"Sugerir com IA" preenche com as sementes e AVISA que a IA esta desligada', async () => {
  // Nenhuma chamada ao LLM acontece. Deixar o botao "funcionando" sem avisar seria pior que nao ter
  // botao — o operador acreditaria que os textos vieram de um modelo.
  limpar();
  const jobId = criarVaga();
  await comServidor(async (base) => {
    await autenticar(base);
    await post(base, '/admin/massa-wa', { nome: 'C', job_id: String(jobId), status: ['sem_decisao'] });
    const id = ultimaCampanha().id;
    await post(base, `/admin/massa-wa/${id}/variacoes`, variacoesDoCorpo(['so uma', '', '', '', '', '', '']));
    assert.equal(db.listarVariacoesMassaWa(id).length, 1);

    const res = await post(base, `/admin/massa-wa/${id}/sugerir`, {});
    assert.match(res.headers.get('location') || '', /ok=sugerido/);
    assert.equal(db.listarVariacoesMassaWa(id).length, TOTAL_VARIACOES);

    const html = await get(base, `/admin/massa-wa/${id}?ok=sugerido`);
    assert.match(html, /sugestão por IA está desligada|A geração por IA está <b>desligada<\/b>/);
  });
});

// ══════════════════ MATERIALIZAR ══════════════════

test('materializa o publico e congela a fila', async () => {
  limpar();
  const jobId = criarVaga();
  criarCandidatura(jobId);
  criarCandidatura(jobId);
  await comServidor(async (base) => {
    await autenticar(base);
    await post(base, '/admin/massa-wa', { nome: 'C', job_id: String(jobId), status: ['sem_decisao'] });
    const id = ultimaCampanha().id;

    await post(base, `/admin/massa-wa/${id}/materializar`, {});
    assert.equal(totalNaFila(id), 2);

    // Congelado: candidatura nova depois disso NAO entra.
    criarCandidatura(jobId);
    const html = await get(base, `/admin/massa-wa/${id}`);
    assert.equal(totalNaFila(id), 2);
    assert.match(html, /Na fila<\/dt><dd>2/);
  });
});

test('nao materializa duas vezes', async () => {
  limpar();
  const jobId = criarVaga();
  criarCandidatura(jobId);
  await comServidor(async (base) => {
    await autenticar(base);
    await post(base, '/admin/massa-wa', { nome: 'C', job_id: String(jobId), status: ['sem_decisao'] });
    const id = ultimaCampanha().id;

    await post(base, `/admin/massa-wa/${id}/materializar`, {});
    const segunda = await post(base, `/admin/massa-wa/${id}/materializar`, {});
    assert.match(segunda.headers.get('location') || '', /erro=ja_materializada/);
    assert.equal(totalNaFila(id), 1);
  });
});

test('nao materializa com variacoes invalidas', async () => {
  limpar();
  const jobId = criarVaga();
  criarCandidatura(jobId);
  await comServidor(async (base) => {
    await autenticar(base);
    await post(base, '/admin/massa-wa', { nome: 'C', job_id: String(jobId), status: ['sem_decisao'] });
    const id = ultimaCampanha().id;
    await post(base, `/admin/massa-wa/${id}/variacoes`, variacoesDoCorpo(['sem token', '', '', '', '', '', '']));

    const res = await post(base, `/admin/massa-wa/${id}/materializar`, {});
    assert.match(res.headers.get('location') || '', /erro=variacoes_invalidas/);
    assert.equal(totalNaFila(id), 0);
  });
});

test('nao materializa publico vazio', async () => {
  limpar();
  const jobId = criarVaga();
  await comServidor(async (base) => {
    await autenticar(base);
    await post(base, '/admin/massa-wa', { nome: 'C', job_id: String(jobId), status: ['sem_decisao'] });
    const res = await post(base, `/admin/massa-wa/${ultimaCampanha().id}/materializar`, {});
    assert.match(res.headers.get('location') || '', /erro=sem_publico/);
  });
});

// ══════════════════ ATIVAR / PAUSAR / CANCELAR ══════════════════

test('NAO ativa sem fila materializada', async () => {
  limpar();
  const jobId = criarVaga();
  criarCandidatura(jobId);
  await comServidor(async (base) => {
    await autenticar(base);
    await post(base, '/admin/massa-wa', { nome: 'C', job_id: String(jobId), status: ['sem_decisao'] });
    const id = ultimaCampanha().id;

    const res = await post(base, `/admin/massa-wa/${id}/status`, { status: 'ativa' });
    assert.match(res.headers.get('location') || '', /erro=nao_materializada/);
    assert.equal(db.obterCampanhaMassaWa(id).status, 'rascunho');
  });
});

test('ativar exige confirmacao explicita na tela (data-confirm no botao)', async () => {
  limpar();
  const jobId = criarVaga();
  criarCandidatura(jobId);
  await comServidor(async (base) => {
    await autenticar(base);
    await post(base, '/admin/massa-wa', { nome: 'C', job_id: String(jobId), status: ['sem_decisao'] });
    const id = ultimaCampanha().id;
    await post(base, `/admin/massa-wa/${id}/materializar`, {});

    const html = await get(base, `/admin/massa-wa/${id}`);
    assert.match(html, /data-confirm-titulo="Ativar a campanha\?"/);
    assert.match(html, /data-confirm-destrutivo="1"/);
    // A confirmacao diz a cadencia: o operador precisa saber o ritmo que esta autorizando.
    assert.match(html, /lotes de 5–8/);
  });
});

test('ativa, pausa e retoma', async () => {
  limpar();
  const jobId = criarVaga();
  criarCandidatura(jobId);
  await comServidor(async (base) => {
    await autenticar(base);
    await post(base, '/admin/massa-wa', { nome: 'C', job_id: String(jobId), status: ['sem_decisao'] });
    const id = ultimaCampanha().id;
    await post(base, `/admin/massa-wa/${id}/materializar`, {});

    await post(base, `/admin/massa-wa/${id}/status`, { status: 'ativa' });
    assert.equal(db.obterCampanhaMassaWa(id).status, 'ativa');

    await post(base, `/admin/massa-wa/${id}/status`, { status: 'pausada' });
    assert.equal(db.obterCampanhaMassaWa(id).status, 'pausada');

    await post(base, `/admin/massa-wa/${id}/status`, { status: 'ativa' });
    assert.equal(db.obterCampanhaMassaWa(id).status, 'ativa');
  });
});

test('cancelar e DEFINITIVO: nao volta a ativa', async () => {
  limpar();
  const jobId = criarVaga();
  criarCandidatura(jobId);
  await comServidor(async (base) => {
    await autenticar(base);
    await post(base, '/admin/massa-wa', { nome: 'C', job_id: String(jobId), status: ['sem_decisao'] });
    const id = ultimaCampanha().id;
    await post(base, `/admin/massa-wa/${id}/materializar`, {});
    await post(base, `/admin/massa-wa/${id}/status`, { status: 'cancelada' });
    assert.equal(db.obterCampanhaMassaWa(id).status, 'cancelada');

    await post(base, `/admin/massa-wa/${id}/status`, { status: 'ativa' });
    assert.equal(db.obterCampanhaMassaWa(id).status, 'cancelada', 'cancelamento nao se desfaz');
  });
});

test('status desconhecido no corpo nao muda nada', async () => {
  limpar();
  const jobId = criarVaga();
  criarCandidatura(jobId);
  await comServidor(async (base) => {
    await autenticar(base);
    await post(base, '/admin/massa-wa', { nome: 'C', job_id: String(jobId), status: ['sem_decisao'] });
    const id = ultimaCampanha().id;
    await post(base, `/admin/massa-wa/${id}/status`, { status: 'concluida' });
    assert.equal(db.obterCampanhaMassaWa(id).status, 'rascunho');
  });
});

test('a pausa AUTOMATICA do disjuntor aparece na tela, dizendo que nao se desfaz sozinha', async () => {
  limpar();
  const jobId = criarVaga();
  criarCandidatura(jobId);
  await comServidor(async (base) => {
    await autenticar(base);
    await post(base, '/admin/massa-wa', { nome: 'C', job_id: String(jobId), status: ['sem_decisao'] });
    const id = ultimaCampanha().id;
    await post(base, `/admin/massa-wa/${id}/materializar`, {});
    await post(base, `/admin/massa-wa/${id}/status`, { status: 'ativa' });
    db.definirStatusCampanhaMassaWa(id, 'pausada', { motivo: 'sinal de limitacao do WhatsApp: rate-overlimit' });

    const html = await get(base, `/admin/massa-wa/${id}`);
    assert.match(html, /Pausada automaticamente/);
    assert.match(html, /rate-overlimit/);
    assert.match(html, /não se desfaz sozinha/);
  });
});

// ══════════════════ ACOMPANHAMENTO ══════════════════

test('a tela mostra a contagem por status e a distribuicao por variacao', async () => {
  limpar();
  const jobId = criarVaga();
  criarCandidatura(jobId);
  criarCandidatura(jobId);
  criarCandidatura(jobId);
  await comServidor(async (base) => {
    await autenticar(base);
    await post(base, '/admin/massa-wa', { nome: 'C', job_id: String(jobId), status: ['sem_decisao'] });
    const id = ultimaCampanha().id;
    await post(base, `/admin/massa-wa/${id}/materializar`, {});

    const fila = db.listarPendentesCampanhaMassaWa(id, { limite: 10 });
    db.definirStatusCampanhaMassaWa(id, 'ativa');
    const ativos = db.listarPendentesCampanhaMassaWa(id, { limite: 10 });
    db.marcarEnvioMassaWaEnviado(ativos[0].id, { variacaoIndice: 2 });
    db.marcarEnvioMassaWaTerminal(ativos[1].id, 'opt_out', 'pediu');
    db.marcarEnvioMassaWaTerminal(ativos[2].id, 'sem_reuniao', 'vaga sem data');
    assert.equal(fila.length, 0, 'rascunho nao lista pendentes');

    const html = await get(base, `/admin/massa-wa/${id}`);
    assert.match(html, /Enviada<\/dt><dd>1/);
    assert.match(html, /Pediu para sair<\/dt><dd>1/);
    assert.match(html, /Vaga sem data<\/dt><dd>1/);
    assert.match(html, /Distribuição por variação:\s*#2: 1/);
  });
});

test('a lista de campanhas mostra status, vaga e enviadas/total', async () => {
  limpar();
  const jobId = criarVaga();
  criarCandidatura(jobId);
  await comServidor(async (base) => {
    await autenticar(base);
    await post(base, '/admin/massa-wa', { nome: 'Campanha Alfa', job_id: String(jobId), status: ['sem_decisao'] });
    const id = ultimaCampanha().id;
    await post(base, `/admin/massa-wa/${id}/materializar`, {});

    const html = await get(base, '/admin/massa-wa');
    assert.match(html, /Campanha Alfa/);
    assert.match(html, /Rascunho/);
    assert.match(html, /0 \/ 1/);
  });
});

// ══════════════════ TESTE PARA 1 NUMERO ══════════════════

test('teste para 1 numero em MOCK nao envia nada e avisa', async () => {
  limpar();
  const jobId = criarVaga();
  await comServidor(async (base) => {
    await autenticar(base);
    await post(base, '/admin/massa-wa', { nome: 'C', job_id: String(jobId), status: ['sem_decisao'] });
    const id = ultimaCampanha().id;

    const res = await post(base, `/admin/massa-wa/${id}/teste`, { telefone: '+55 47 99958-2500' });
    assert.match(res.headers.get('location') || '', /ok=teste_mock/);

    const html = await get(base, `/admin/massa-wa/${id}?ok=teste_mock`);
    assert.match(html, /MODO MOCK: a mensagem NÃO saiu/);
    // O teste NAO toca a fila: nenhuma linha criada.
    assert.equal(totalNaFila(id), 0);
  });
});

test('teste recusa numero invalido', async () => {
  limpar();
  const jobId = criarVaga();
  await comServidor(async (base) => {
    await autenticar(base);
    await post(base, '/admin/massa-wa', { nome: 'C', job_id: String(jobId), status: ['sem_decisao'] });
    const res = await post(base, `/admin/massa-wa/${ultimaCampanha().id}/teste`, { telefone: '123' });
    assert.match(res.headers.get('location') || '', /erro=telefone/);
  });
});

test('teste recusa quando a vaga nao tem reuniao futura', async () => {
  limpar();
  const jobId = criarVaga({ comReuniao: false });
  await comServidor(async (base) => {
    await autenticar(base);
    await post(base, '/admin/massa-wa', { nome: 'C', job_id: String(jobId), status: ['sem_decisao'] });
    const res = await post(base, `/admin/massa-wa/${ultimaCampanha().id}/teste`, { telefone: '+55 47 99958-2500' });
    assert.match(res.headers.get('location') || '', /erro=sem_reuniao_teste/);
  });
});

// ══════════════════ AUTENTICACAO ══════════════════

test('as telas exigem login (herdam o adminAuth do painel)', async () => {
  limpar();
  await comServidor(async (base) => {
    for (const url of ['/admin/massa-wa', '/admin/massa-wa/nova', '/admin/massa-wa/1']) {
      const res = await fetch(`${base}${url}`, { redirect: 'manual' });
      assert.ok(
        res.status === 302 || res.status === 401 || res.status === 403,
        `${url} respondeu ${res.status} sem login`,
      );
    }
  });
});

test('campanha inexistente devolve 404', async () => {
  limpar();
  await comServidor(async (base) => {
    await autenticar(base);
    const res = await fetch(`${base}/admin/massa-wa/999999`, { headers: comAuth() });
    assert.equal(res.status, 404);
  });
});

// ══════════════════ PISOS DE CADENCIA NA TELA ══════════════════
// Primeira campanha real (2026-09-29): a tela pedia a pausa em SEGUNDOS, o operador digitou
// pensando em minutos, e 50 mensagens sairam em 8 minutos.

test('cadencia abaixo do piso e RECUSADA, com mensagem, e nada e salvo', async () => {
  limpar();
  const jobId = criarVaga();
  await comServidor(async (base) => {
    await autenticar(base);
    const antes = ultimaCampanha();
    const r = await post(base, '/admin/massa-wa', {
      nome: 'Rapida demais', job_id: String(jobId), status: ['sem_decisao'],
      lote_min: '5', lote_max: '9', gap_min_s: '1', gap_max_s: '3',
      pausa_lote_min_min: '1', pausa_lote_max_min: '2',
    });
    assert.equal(r.status, 302);
    assert.match(r.headers.get('location'), /erro=cadencia_piso/);
    const depois = ultimaCampanha();
    assert.equal(depois && depois.id, antes && antes.id, 'nenhuma campanha criada');

    const html = await get(base, '/admin/massa-wa/nova?erro=cadencia_piso');
    assert.match(html, /Cadência abaixo do mínimo seguro/);
  });
});

test('a pausa entre lotes e digitada em MINUTOS e gravada em segundos', async () => {
  limpar();
  const jobId = criarVaga();
  await comServidor(async (base) => {
    await autenticar(base);
    await post(base, '/admin/massa-wa', {
      nome: 'Ok', job_id: String(jobId), status: ['sem_decisao'],
      gap_min_s: '30', gap_max_s: '60', pausa_lote_min_min: '7', pausa_lote_max_min: '12',
    });
    const c = ultimaCampanha();
    assert.equal(c.pausa_lote_min_s, 420);
    assert.equal(c.pausa_lote_max_s, 720);

    const html = await get(base, `/admin/massa-wa/${c.id}`);
    assert.match(html, /Entre lotes, mín\. \(MINUTOS\)/);
    assert.match(html, /name="pausa_lote_min_min" value="7"/);
    assert.match(html, /mensagens por hora/);
  });
});

// ══════════════════ RECORTES AO MATERIALIZAR (2026-10-01) ══════════════════
// Teste de cadencia com 12 pessoas de uma vaga existente, sem repetir quem ja recebeu.

test('materializar com maximo de destinatarios corta a fila', async () => {
  limpar();
  const jobId = criarVaga();
  for (let i = 0; i < 5; i += 1) criarCandidatura(jobId);
  await comServidor(async (base) => {
    await autenticar(base);
    await post(base, '/admin/massa-wa', { nome: 'C', job_id: String(jobId), status: ['sem_decisao'] });
    const id = ultimaCampanha().id;
    await post(base, `/admin/massa-wa/${id}/materializar`, { max_destinatarios: '3' });
    assert.equal(totalNaFila(id), 3);
  });
});

test('materializar exclui quem ja tem envio "enviado" em outra campanha de massa', async () => {
  limpar();
  const jobId = criarVaga();
  for (let i = 0; i < 4; i += 1) criarCandidatura(jobId);
  await comServidor(async (base) => {
    await autenticar(base);
    // Campanha anterior: todos na fila, e 2 marcados como enviados.
    await post(base, '/admin/massa-wa', { nome: 'Anterior', job_id: String(jobId), status: ['sem_decisao'] });
    const anterior = ultimaCampanha().id;
    await post(base, `/admin/massa-wa/${anterior}/materializar`, { excluir_ja_receberam: '1' });
    const linhas = db.getDb().prepare('SELECT id FROM campanhas_massa_wa_envios WHERE campanha_id = ? ORDER BY id').all(anterior);
    db.marcarEnvioMassaWaEnviado(linhas[0].id, {});
    db.marcarEnvioMassaWaEnviado(linhas[1].id, {});

    await post(base, '/admin/massa-wa', { nome: 'Teste', job_id: String(jobId), status: ['sem_decisao'] });
    const nova = ultimaCampanha().id;
    await post(base, `/admin/massa-wa/${nova}/materializar`, { excluir_ja_receberam: '1' });
    assert.equal(totalNaFila(nova), 2, 'os 2 que ja receberam ficam de fora');

    const jaRecebidos = db.getDb()
      .prepare(`SELECT telefone_canonico t FROM campanhas_massa_wa_envios WHERE campanha_id = ? AND status = 'enviado'`)
      .all(anterior).map((r) => r.t);
    const naNova = db.getDb()
      .prepare('SELECT telefone_canonico t FROM campanhas_massa_wa_envios WHERE campanha_id = ?')
      .all(nova).map((r) => r.t);
    for (const t of jaRecebidos) assert.ok(!naNova.includes(t));
  });
});

test('a tela de fila oferece os dois recortes, com "excluir" marcado por padrao', async () => {
  limpar();
  const jobId = criarVaga();
  criarCandidatura(jobId);
  await comServidor(async (base) => {
    await autenticar(base);
    await post(base, '/admin/massa-wa', { nome: 'C', job_id: String(jobId), status: ['sem_decisao'] });
    const html = await get(base, `/admin/massa-wa/${ultimaCampanha().id}`);
    assert.match(html, /name="max_destinatarios"/);
    assert.match(html, /name="excluir_ja_receberam" value="1" checked/);
  });
});

// ══════════════════ EXCLUIR CAMPANHA (2026-10-01) ══════════════════

test('excluir: some da lista, cancela a fila pendente e GUARDA quem ja recebeu', async () => {
  limpar();
  const jobId = criarVaga();
  for (let i = 0; i < 3; i += 1) criarCandidatura(jobId);
  await comServidor(async (base) => {
    await autenticar(base);
    await post(base, '/admin/massa-wa', { nome: 'Teste velho', job_id: String(jobId), status: ['sem_decisao'] });
    const id = ultimaCampanha().id;
    await post(base, `/admin/massa-wa/${id}/materializar`, {});
    const linhas = db.getDb().prepare('SELECT id FROM campanhas_massa_wa_envios WHERE campanha_id = ? ORDER BY id').all(id);
    db.marcarEnvioMassaWaEnviado(linhas[0].id, {});

    let html = await get(base, '/admin/massa-wa');
    assert.match(html, new RegExp(`action="/admin/massa-wa/${id}/excluir"`));
    assert.match(html, /data-confirm-titulo="Excluir campanha\?"/);

    const r = await post(base, `/admin/massa-wa/${id}/excluir`, {});
    assert.equal(r.status, 302);
    assert.match(r.headers.get('location'), /ok=excluida/);

    html = await get(base, '/admin/massa-wa');
    assert.doesNotMatch(html, /Teste velho/, 'a campanha sai da lista');
    const porStatus = Object.fromEntries(db.resumoCampanhaMassaWa(id).map((l) => [l.status, l.n]));
    assert.deepEqual(porStatus, { enviado: 1, cancelado: 2 }, 'pendentes cancelados, enviado preservado');
    assert.equal(db.obterCampanhaMassaWa(id).status, 'excluida');
    assert.ok(!db.listarCampanhasMassaWaAtivas().some((c) => c.id === id), 'o worker nunca a ve');

    // Quem ja recebeu continua fora do publico de uma campanha nova.
    const quemRecebeu = db.getDb().prepare('SELECT telefone_canonico t FROM campanhas_massa_wa_envios WHERE id = ?').get(linhas[0].id).t;
    assert.ok(db.telefonesComDisparoMassaWaEnviado().has(quemRecebeu));
  });
});

test('excluir campanha ATIVA para o envio na hora', async () => {
  limpar();
  const jobId = criarVaga();
  criarCandidatura(jobId);
  await comServidor(async (base) => {
    await autenticar(base);
    await post(base, '/admin/massa-wa', { nome: 'Ativa', job_id: String(jobId), status: ['sem_decisao'] });
    const id = ultimaCampanha().id;
    await post(base, `/admin/massa-wa/${id}/materializar`, {});
    await post(base, `/admin/massa-wa/${id}/status`, { status: 'ativa' });
    assert.ok(db.listarCampanhasMassaWaAtivas().some((c) => c.id === id));
    await post(base, `/admin/massa-wa/${id}/excluir`, {});
    assert.ok(!db.listarCampanhasMassaWaAtivas().some((c) => c.id === id));
    assert.equal(db.listarPendentesCampanhaMassaWa(id, { limite: 10 }).length, 0);
  });
});

// ══════════════════ PREVIA HONESTA (2026-10-01) ══════════════════
//
// Campanha 6: a previa dizia 74 e a fila nasceu com 12, porque so a materializacao aplicava o
// "ja recebeu". Os testes abaixo quebram se as duas voltarem a divergir.

// Cenario: 6 candidaturas. Uma reprovada, uma com opt-out, e de uma campanha anterior uma pessoa
// 'enviado' (recebeu) e outra 'sem_destino' (nunca recebeu). Publico esperado: 6 - 1 reprovado = 5
// pessoas; - 1 opt-out = 4; - 1 ja recebeu = 3.
async function cenarioJaReceberam(base) {
  const jobId = criarVaga();
  const apps = [];
  for (let i = 0; i < 5; i += 1) apps.push(criarCandidatura(jobId));
  criarCandidatura(jobId, { status: 'reprovado' });
  const tel = (appId) => db.getDb().prepare('SELECT telefone FROM applications WHERE id = ?').get(appId).telefone;
  db.registrarWhatsappOptout({ telefone: tel(apps[4]), escopo: 'campanha', origem: 'manual' });

  await post(base, '/admin/massa-wa', { nome: 'Anterior', job_id: String(jobId), status: ['sem_decisao'] });
  const anterior = ultimaCampanha().id;
  await post(base, `/admin/massa-wa/${anterior}/materializar`, {});
  const linha = (appId) => db.getDb()
    .prepare('SELECT id, telefone_canonico FROM campanhas_massa_wa_envios WHERE campanha_id = ? AND application_id = ?')
    .get(anterior, appId);
  db.marcarEnvioMassaWaEnviado(linha(apps[0]).id, {});
  db.marcarEnvioMassaWaEnviado(linha(apps[1]).id, {});
  db.getDb().prepare("UPDATE campanhas_massa_wa_envios SET status = 'sem_destino' WHERE id = ?").run(linha(apps[1]).id);

  await post(base, '/admin/massa-wa', { nome: 'Nova', job_id: String(jobId), status: ['sem_decisao'] });
  return { jobId, anterior, nova: ultimaCampanha().id, recebeu: linha(apps[0]).telefone_canonico, semDestino: linha(apps[1]).telefone_canonico };
}

test('previa mostra "ja receberam" por campanha, e a conta fecha', async () => {
  limpar();
  await comServidor(async (base) => {
    await autenticar(base);
    const { anterior, nova } = await cenarioJaReceberam(base);
    const html = await get(base, `/admin/massa-wa/${nova}`);
    const valor = (rotulo) => {
      const m = new RegExp(`<dt>${rotulo}</dt><dd>(\\d+)`).exec(html.replace(/\s+</g, '<'));
      assert.ok(m, `linha "${rotulo}" na previa`);
      return Number(m[1]);
    };
    const pessoas = valor('Pessoas');
    const optout = valor('— fora por opt-out');
    const ja = valor('— já receberam disparo em massa');
    const final = valor('PÚBLICO FINAL');
    assert.deepEqual([pessoas, optout, ja, final], [5, 1, 1, 3]);
    assert.equal(pessoas - optout - ja, final, 'a aritmetica exibida fecha');
    assert.match(html, new RegExp(`camp\\. ${anterior}: 1`));
    assert.equal(valor('— fora por status do recrutador'), 1, 'reprovado fora');
  });
});

test('previa e fila usam o MESMO "ja recebeu": o tamanho da fila e o PUBLICO FINAL da previa', async () => {
  limpar();
  await comServidor(async (base) => {
    await autenticar(base);
    const { nova, recebeu, semDestino } = await cenarioJaReceberam(base);
    const html = (await get(base, `/admin/massa-wa/${nova}`)).replace(/\s+</g, '<');
    const final = Number(/<dt>PÚBLICO FINAL<\/dt><dd>(\d+)/.exec(html)[1]);

    await post(base, `/admin/massa-wa/${nova}/materializar`, { excluir_ja_receberam: '1' });
    assert.equal(totalNaFila(nova), final);
    const naFila = new Set(db.getDb()
      .prepare('SELECT telefone_canonico t FROM campanhas_massa_wa_envios WHERE campanha_id = ?').all(nova).map((r) => r.t));
    assert.ok(!naFila.has(recebeu), 'quem recebeu de verdade fica fora');
    assert.ok(naFila.has(semDestino), "quem ficou 'sem_destino' volta");
  });
});

// ══════════════════ FILA EXPLICADA (2026-10-01) ══════════════════

test('materializar registra o porque do tamanho da fila, e o painel mostra a conta', async () => {
  limpar();
  await comServidor(async (base) => {
    await autenticar(base);
    const { anterior, nova } = await cenarioJaReceberam(base);
    // Publico 4 (depois do opt-out) - 1 ja recebeu = 3; limite 2 corta mais 1.
    await post(base, `/admin/massa-wa/${nova}/materializar`, { excluir_ja_receberam: '1', max_destinatarios: '2' });
    const m = JSON.parse(db.obterCampanhaMassaWa(nova).criterios_json).materializacao;
    assert.equal(m.publico, 4);
    assert.equal(m.jaReceberam, 1);
    assert.deepEqual(m.jaReceberamPorCampanha, { [anterior]: 1 });
    assert.equal(m.limite, 2);
    assert.equal(m.foraPorLimite, 1);
    assert.equal(m.naFila, 2);
    assert.equal(m.publico - m.jaReceberam - m.foraPorLimite, m.naFila);
    assert.match(m.em, /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);

    const html = (await get(base, `/admin/massa-wa/${nova}`)).replace(/\s+/g, ' ');
    assert.match(html, new RegExp(
      `Criada em \\d{2}/\\d{2} \\d{2}:\\d{2}: <b>4</b> do público − <b>1</b> já receberam \\(camp\\. ${anterior}: 1\\) − <b>1</b> pelo limite = <b>2</b> na fila\\.`,
    ));
  });
});

test('salvar a configuracao depois de materializar NAO apaga o registro da materializacao', async () => {
  limpar();
  const jobId = criarVaga();
  criarCandidatura(jobId);
  await comServidor(async (base) => {
    await autenticar(base);
    await post(base, '/admin/massa-wa', { nome: 'C', job_id: String(jobId), status: ['sem_decisao'] });
    const id = ultimaCampanha().id;
    await post(base, `/admin/massa-wa/${id}/materializar`, { excluir_ja_receberam: '1' });
    await post(base, `/admin/massa-wa/${id}`, { nome: 'C renomeada', job_id: String(jobId), status: ['sem_decisao', 'em_analise'] });
    const c = JSON.parse(db.obterCampanhaMassaWa(id).criterios_json);
    assert.deepEqual(c.statusList.sort(), ['em_analise', 'sem_decisao']);
    assert.equal(c.materializacao.naFila, 1, 'o registro sobrevive a edicao');
  });
});

test('campanha antiga, sem registro de materializacao, mostra a fila sem a linha de origem', async () => {
  limpar();
  const jobId = criarVaga();
  criarCandidatura(jobId);
  await comServidor(async (base) => {
    await autenticar(base);
    await post(base, '/admin/massa-wa', { nome: 'Velha', job_id: String(jobId), status: ['sem_decisao'] });
    const id = ultimaCampanha().id;
    await post(base, `/admin/massa-wa/${id}/materializar`, {});
    // Como uma campanha materializada antes de 2026-10-01: so statusList no JSON.
    db.getDb().prepare('UPDATE campanhas_massa_wa SET criterios_json = ? WHERE id = ?')
      .run(JSON.stringify({ statusList: ['sem_decisao'] }), id);
    const res = await fetch(`${base}/admin/massa-wa/${id}`, { headers: comAuth() });
    assert.equal(res.status, 200);
    const html = await res.text();
    assert.match(html, /Fila e acompanhamento/);
    assert.doesNotMatch(html, /Criada em/);
  });
});

// ══════════════════ CRONOGRAMA NO PAINEL (2026-10-01) ══════════════════

test('o painel mostra o cronograma previsto, e a soma dos dias e o total pendente', async () => {
  limpar();
  const jobId = criarVaga();
  for (let i = 0; i < 7; i += 1) criarCandidatura(jobId);
  await comServidor(async (base) => {
    await autenticar(base);
    // Todos os dias, teto 3: 7 pendentes viram 3 + 3 + 1 (ou comecam hoje, se a janela deixar).
    await post(base, '/admin/massa-wa', {
      nome: 'C', job_id: String(jobId), status: ['sem_decisao'], teto_diario: '3', dias_semana: '1,2,3,4,5,6,7',
    });
    const id = ultimaCampanha().id;
    await post(base, `/admin/massa-wa/${id}/materializar`, {});
    const html = (await get(base, `/admin/massa-wa/${id}`)).replace(/\s+/g, ' ');
    const m = /Hoje na fila: <b>(\d+)<\/b> · Restante agendado para os próximos dias: <b>(\d+)<\/b>/.exec(html);
    assert.ok(m, 'linha de hoje/restante');
    assert.equal(Number(m[1]) + Number(m[2]), 7);
    const porDia = [...html.matchAll(/→ <b>(\d+)<\/b>/g)].map((x) => Number(x[1]));
    assert.equal(porDia.reduce((a, b) => a + b, 0), 7);
    assert.ok(porDia.every((n) => n <= 3), 'nenhum dia passa do teto');
  });
});
