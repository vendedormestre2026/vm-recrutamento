'use strict';

// Tela /admin/promocao (routes/admin_promocao.js + o CRUD de campanhas em sqlite.js).
//
// O QUE ESTA EM JOGO AQUI: esta e a tela onde o recrutador escolhe QUEM vai receber um
// e-mail em massa. Duas propriedades importam mais que o visual:
//   1. a previa NAO pode ter efeito colateral — o Jean vai recalcular varias vezes;
//   2. o numero mostrado e o numero gravado tem que sair do MESMO recorte, senao a
//      campanha nasce com um publico diferente do que foi aprovado na tela.
//
// E, como todas as rotas do painel, estas precisam estar atras do login — ha teste
// explicito para isso, porque a protecao vem do LUGAR onde o router e montado em
// admin.js, nao de codigo dentro do modulo. Um mount movido de lugar abriria as telas.
//
// NENHUMA REDE EXTERNA: sobe o proprio app em porta efemera, padrao de funil.test.js.

const os = require('node:os');
const path = require('node:path');

process.env.DATABASE_PATH = path.join(os.tmpdir(), `vm-test-promocao-tela-${process.pid}-${Date.now()}.db`);
process.env.INTERVIEW_MOCK = 'true';
process.env.SESSION_SECRET = 'segredo-de-teste';
process.env.ADMIN_USER = 'admin-teste';
process.env.ADMIN_PASSWORD = 'senha-teste';
process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert/strict');

const db = require('../src/db');
const { migrar } = require('../src/db/migrate');
const { criarApp } = require('../src/server');
const { lerCriteriosDoForm, montarConteudoListagemPromocao } = require('../src/routes/admin_promocao');

migrar();

// ── Sessao de admin ──
// O cookie vm_admin e assinado com o SESSION_SECRET e guarda a propria ADMIN_PASSWORD
// (admin.js). Fazemos o login de verdade para obter o cookie, em vez de forjar um.
let cookieAdmin = '';

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
  assert.ok(cookieAdmin.includes('vm_admin'), 'o login precisa devolver o cookie de admin');
  return cookieAdmin;
}

const comAuth = (extra = {}) => ({ Cookie: cookieAdmin, ...extra });

const form = (dados) => ({
  method: 'POST',
  headers: comAuth({ 'Content-Type': 'application/x-www-form-urlencoded' }),
  body: new URLSearchParams(dados),
  redirect: 'manual',
});

// ── Cenario ──
let seq = 0;
function criarVaga(perfil, titulo, ativo = 1) {
  seq += 1;
  return Number(
    db
      .getDb()
      .prepare('INSERT INTO jobs (slug, titulo, perfil, ativo) VALUES (?, ?, ?, ?)')
      .run(`vaga-tela-${seq}`, titulo, perfil, ativo).lastInsertRowid,
  );
}
function criarCandidatura(jobId, email) {
  seq += 1;
  return Number(
    db
      .getDb()
      .prepare(
        "INSERT INTO applications (job_id, nome, sobrenome, email, token) VALUES (?, 'Fulano', 'Teste', ?, ?)",
      )
      .run(jobId, email, `tok-tela-${seq}`).lastInsertRowid,
  );
}

const vagaAlvo = criarVaga('CLOSER', 'Vaga Alvo da Campanha');
const vagaOutra = criarVaga('CLOSER', 'Outra Vaga Closer');
const vagaEncerrada = criarVaga('SDR', 'Vaga Ja Encerrada', 0);
criarCandidatura(vagaOutra, 'publico1@exemplo.com');
criarCandidatura(vagaOutra, 'publico2@exemplo.com');
criarCandidatura(vagaAlvo, 'ja-inscrito@exemplo.com');

// ── Autenticacao ──

test('as rotas de promocao exigem login (herdam o adminAuth do mount)', async () => {
  await comServidor(async (base) => {
    for (const caminho of ['/admin/promocao', '/admin/promocao/nova', '/admin/promocao/1']) {
      const res = await fetch(`${base}${caminho}`, { redirect: 'manual' });
      assert.equal(res.status, 302, `${caminho} deveria redirecionar sem sessao`);
      assert.match(res.headers.get('location') || '', /\/admin\/login/);
    }
    // POST tambem: a protecao nao pode valer so para GET.
    const post = await fetch(`${base}/admin/promocao/previa`, { method: 'POST', redirect: 'manual' });
    assert.equal(post.status, 302);
  });
});

// ── Listagem e formulario ──

test('GET /admin/promocao lista campanhas (vazio no comeco) e oferece criar', async () => {
  await comServidor(async (base) => {
    await autenticar(base);
    const html = await (await fetch(`${base}/admin/promocao`, { headers: comAuth() })).text();
    assert.match(html, /Promoção de Vagas/);
    assert.match(html, /Nenhuma campanha criada ainda/);
    assert.match(html, /\/admin\/promocao\/nova/);
  });
});

test('montarConteudoListagemPromocao: fragmento puro (Item 3 do ETAPA B, Commit 5) sem o paginaAdmin em volta', () => {
  // Extraida para ser reaproveitada pela futura pagina /admin/divulgacao-vagas (Commit 7)
  // sem duplicar a logica desta tela. Aqui so confirma que e uma funcao pura chamavel
  // fora da rota, devolvendo o MESMO fragmento que a rota standalone envia hoje (ja
  // coberto ponta-a-ponta pelo teste 'GET /admin/promocao lista campanhas...' acima).
  const conteudo = montarConteudoListagemPromocao({
    formatarDataHora: (v) => String(v),
    fmtInt: (v) => String(v),
  });
  assert.match(conteudo, /Promoção de Vagas/);
  assert.match(conteudo, /\/admin\/promocao\/nova/);
  // E so o fragmento — nao a pagina inteira (isso e responsabilidade do paginaAdmin).
  assert.ok(!conteudo.includes('<html'));
  assert.ok(!conteudo.includes('<title>'));
});

test('GET /admin/promocao/nova so oferece vagas ATIVAS', async () => {
  await comServidor(async (base) => {
    await autenticar(base);
    const html = await (await fetch(`${base}/admin/promocao/nova`, { headers: comAuth() })).text();
    assert.match(html, /Vaga Alvo da Campanha/);
    assert.match(html, /Outra Vaga Closer/);
    assert.doesNotMatch(html, /Vaga Ja Encerrada/, 'vaga encerrada nao pode ser promovida');
  });
});

test('GET /admin/promocao/nova nao mostra o botao de criar antes da previa', async () => {
  await comServidor(async (base) => {
    await autenticar(base);
    const html = await (await fetch(`${base}/admin/promocao/nova`, { headers: comAuth() })).text();
    assert.match(html, /Calcular prévia/);
    assert.doesNotMatch(html, /Criar campanha \(rascunho\)/);
    assert.match(html, /Calcule a prévia para poder criar/);
  });
});

// ── Previa ──

test('POST /previa calcula, mostra a decomposicao e NAO cria nada', async () => {
  await comServidor(async (base) => {
    await autenticar(base);
    const antes = db.listarCampanhas().length;

    const res = await fetch(`${base}/admin/promocao/previa`, form({ vaga: String(vagaAlvo) }));
    assert.equal(res.status, 200);
    const html = await res.text();

    assert.match(html, /Prévia do público/);
    assert.match(html, /de candidaturas/);
    assert.match(html, /do banco de talentos/);
    // Depois da previa o botao de criar aparece.
    assert.match(html, /Criar campanha \(rascunho\)/);

    assert.equal(db.listarCampanhas().length, antes, 'a previa NAO pode criar campanha');
  });
});

test('POST /previa pode ser repetida sem efeito colateral', async () => {
  await comServidor(async (base) => {
    await autenticar(base);
    const antes = db.listarCampanhas().length;
    for (let i = 0; i < 3; i += 1) {
      const res = await fetch(`${base}/admin/promocao/previa`, form({ vaga: String(vagaAlvo) }));
      assert.equal(res.status, 200);
    }
    assert.equal(db.listarCampanhas().length, antes);
  });
});

test('POST /previa preserva assunto, corpo e filtros no re-submit', async () => {
  await comServidor(async (base) => {
    await autenticar(base);
    const html = await (
      await fetch(
        `${base}/admin/promocao/previa`,
        form({
          vaga: String(vagaAlvo),
          assunto: 'Assunto Preservado',
          corpo_html: '<p>Corpo preservado</p>',
          perfil: 'CLOSER',
          perfil_incluir_sem: '1',
        }),
      )
    ).text();

    assert.match(html, /Assunto Preservado/, 'o assunto digitado nao pode se perder');
    assert.match(html, /Corpo preservado/, 'o corpo digitado nao pode se perder');
    assert.match(html, /value="CLOSER" selected/, 'o filtro escolhido continua marcado');
    assert.match(html, /name="perfil_incluir_sem" value="1" checked/);
  });
});

test('POST /previa sem vaga -> 400 com mensagem clara, sem criar nada', async () => {
  await comServidor(async (base) => {
    await autenticar(base);
    const antes = db.listarCampanhas().length;
    const res = await fetch(`${base}/admin/promocao/previa`, form({ assunto: 'x' }));
    assert.equal(res.status, 400);
    assert.match(await res.text(), /Escolha a vaga/);
    assert.equal(db.listarCampanhas().length, antes);
  });
});

test('a previa exclui quem ja se candidatou a vaga alvo', async () => {
  await comServidor(async (base) => {
    await autenticar(base);
    // A vaga alvo tem 1 inscrito; o publico deve trazer so os outros dois.
    const html = await (
      await fetch(`${base}/admin/promocao/previa`, form({ vaga: String(vagaAlvo) }))
    ).text();
    // O numero aparece no bloco da previa; conferimos pelo motor, que e a fonte.
    const { listarPublicoCampanha } = require('../src/lib/promocaoVagas');
    const r = listarPublicoCampanha({ jobIdAlvo: vagaAlvo });
    assert.ok(!r.itens.some((i) => i.email === 'ja-inscrito@exemplo.com'));
    assert.match(html, new RegExp(String(r.total)));
  });
});

// ── Criacao ──

test('POST /admin/promocao cria rascunho, congela o total e redireciona ao detalhe', async () => {
  await comServidor(async (base) => {
    await autenticar(base);
    const res = await fetch(
      `${base}/admin/promocao`,
      form({
        vaga: String(vagaAlvo),
        assunto: 'Vaga aberta: Closer',
        corpo_html: '<p>Temos uma vaga.</p>',
      }),
    );
    assert.equal(res.status, 302);
    const destino = res.headers.get('location') || '';
    assert.match(destino, /^\/admin\/promocao\/\d+$/);

    const id = Number(destino.split('/').pop());
    const campanha = db.obterCampanha(id);
    assert.equal(campanha.status, 'rascunho', 'toda campanha nasce em rascunho');
    assert.equal(campanha.job_id, vagaAlvo);
    assert.equal(campanha.assunto, 'Vaga aberta: Closer');

    // O total gravado tem que ser o do motor, nao um numero vindo do formulario.
    const { listarPublicoCampanha } = require('../src/lib/promocaoVagas');
    assert.equal(
      campanha.total_destinatarios,
      listarPublicoCampanha({ jobIdAlvo: vagaAlvo }).total,
    );

    // E NENHUM destinatario materializado: isso e do disparo (Incremento 7).
    const envios = db.getDb().prepare('SELECT COUNT(*) AS n FROM campanha_envios WHERE campanha_id = ?').get(id).n;
    assert.equal(envios, 0, 'campanha_envios so e preenchida no disparo');
  });
});

test('POST /admin/promocao grava os criterios usados como JSON', async () => {
  await comServidor(async (base) => {
    await autenticar(base);
    const res = await fetch(
      `${base}/admin/promocao`,
      form({
        vaga: String(vagaAlvo),
        assunto: 'Com filtros',
        corpo_html: '<p>x</p>',
        perfil: 'CLOSER',
        perfil_incluir_sem: '1',
        de: '2020-01-01',
      }),
    );
    const id = Number((res.headers.get('location') || '').split('/').pop());
    const c = db.obterCampanha(id);

    assert.equal(c.criterios.jobIdAlvo, vagaAlvo);
    assert.equal(c.criterios.perfil, 'CLOSER');
    assert.equal(c.criterios.perfilIncluirSemAtributo, true);
    assert.equal(c.criterios.dataDe, '2020-01-01');
  });
});

test('POST /admin/promocao exige assunto e corpo', async () => {
  await comServidor(async (base) => {
    await autenticar(base);
    const antes = db.listarCampanhas().length;

    const semAssunto = await fetch(
      `${base}/admin/promocao`,
      form({ vaga: String(vagaAlvo), corpo_html: '<p>x</p>' }),
    );
    assert.equal(semAssunto.status, 400);
    assert.match(await semAssunto.text(), /assunto do e-mail é obrigatório/i);

    const semCorpo = await fetch(
      `${base}/admin/promocao`,
      form({ vaga: String(vagaAlvo), assunto: 'x' }),
    );
    assert.equal(semCorpo.status, 400);
    assert.match(await semCorpo.text(), /corpo do e-mail é obrigatório/i);

    assert.equal(db.listarCampanhas().length, antes, 'nada pode ter sido criado');
  });
});

// ── Detalhe ──

// A versao anterior deste teste afirmava `assert.match(html, /disabled/)` — e passava pelo
// motivo errado: a string "disabled" aparece no CSS da propria pagina (`.btn:disabled`),
// nao porque houvesse um botao desabilitado. A asserção estava vazia mesmo antes do
// Incremento 7, e continuaria verde com o botao vivo. Agora conferimos o comportamento
// REAL: rascunho mostra o FORMULARIO de disparo apontando para a rota certa.
test('GET /admin/promocao/:id mostra a campanha e o formulario de disparo (rascunho)', async () => {
  await comServidor(async (base) => {
    await autenticar(base);
    const id = db.criarCampanha({
      job_id: vagaAlvo,
      assunto: 'Campanha de Detalhe',
      corpo_html: '<p>corpo</p>',
      criterios: { jobIdAlvo: vagaAlvo },
      total_destinatarios: 2,
    });

    const html = await (await fetch(`${base}/admin/promocao/${id}`, { headers: comAuth() })).text();
    assert.match(html, /Campanha de Detalhe/);
    assert.match(html, /Rascunho/);
    assert.match(html, /Critérios usados/);
    assert.match(
      html,
      new RegExp(`action="/admin/promocao/${id}/disparar"`),
      'o formulario de disparo precisa apontar para a rota da propria campanha',
    );
    assert.match(html, /<button type="submit" class="btn">Disparar campanha<\/button>/);
  });
});

test('detalhe avisa quando o publico mudou desde a criacao', async () => {
  await comServidor(async (base) => {
    await autenticar(base);
    // Total congelado propositalmente diferente do publico real de agora.
    const id = db.criarCampanha({
      job_id: vagaAlvo,
      assunto: 'Campanha Defasada',
      corpo_html: '<p>x</p>',
      criterios: { jobIdAlvo: vagaAlvo },
      total_destinatarios: 999,
    });

    const html = await (await fetch(`${base}/admin/promocao/${id}`, { headers: comAuth() })).text();
    assert.match(html, /O público mudou desde a criação/);
    assert.match(html, /999/, 'mostra o numero congelado');
  });
});

test('detalhe NAO avisa quando o publico continua igual', async () => {
  await comServidor(async (base) => {
    await autenticar(base);
    const { listarPublicoCampanha } = require('../src/lib/promocaoVagas');
    const total = listarPublicoCampanha({ jobIdAlvo: vagaAlvo }).total;
    const id = db.criarCampanha({
      job_id: vagaAlvo,
      assunto: 'Campanha Em Dia',
      corpo_html: '<p>x</p>',
      criterios: { jobIdAlvo: vagaAlvo },
      total_destinatarios: total,
    });

    const html = await (await fetch(`${base}/admin/promocao/${id}`, { headers: comAuth() })).text();
    assert.doesNotMatch(html, /O público mudou desde a criação/);
  });
});

test('GET /admin/promocao/:id inexistente -> 404 no tema do painel', async () => {
  await comServidor(async (base) => {
    await autenticar(base);
    const res = await fetch(`${base}/admin/promocao/999999`, { headers: comAuth() });
    assert.equal(res.status, 404);
    assert.match(await res.text(), /Campanha não encontrada/);
  });
});

test('a listagem passa a mostrar as campanhas criadas', async () => {
  await comServidor(async (base) => {
    await autenticar(base);
    const html = await (await fetch(`${base}/admin/promocao`, { headers: comAuth() })).text();
    assert.match(html, /Campanha de Detalhe/);
    assert.doesNotMatch(html, /Nenhuma campanha criada ainda/);
  });
});

// ── Navegacao ──

test('o painel principal tem o link para a Promocao de Vagas', async () => {
  await comServidor(async (base) => {
    await autenticar(base);
    const html = await (await fetch(`${base}/admin`, { headers: comAuth() })).text();
    assert.match(html, /href="\/admin\/promocao"/);
  });
});

// ── lerCriteriosDoForm (unidade) ──

test('lerCriteriosDoForm: enum invalido vira filtro inativo, nao erro', () => {
  const c = lerCriteriosDoForm({ vaga: '3', perfil: 'GERENTE', recomendacao: 'talvez-nao' });
  assert.equal(c.jobIdAlvo, 3);
  assert.equal(c.perfil, undefined);
  assert.equal(c.recomendacao, undefined);
});

test('lerCriteriosDoForm: checkbox ausente = false, presente = true', () => {
  const semNada = lerCriteriosDoForm({ vaga: '1' });
  assert.equal(semNada.perfilIncluirSemAtributo, false);
  assert.equal(semNada.utmSourceIncluirSemAtributo, false);
  assert.equal(semNada.recomendacaoIncluirSemAtributo, false);

  const marcado = lerCriteriosDoForm({ vaga: '1', perfil_incluir_sem: '1', origem_incluir_sem: 'on' });
  assert.equal(marcado.perfilIncluirSemAtributo, true);
  assert.equal(marcado.utmSourceIncluirSemAtributo, true);
});

test('lerCriteriosDoForm: data em formato invalido e ignorada', () => {
  const c = lerCriteriosDoForm({ vaga: '1', de: '01/02/2026', ate: '2026-03-15' });
  assert.equal(c.dataDe, undefined);
  assert.equal(c.dataAte, '2026-03-15');
});

test('lerCriteriosDoForm: vaga ausente ou lixo vira undefined (a rota e que barra)', () => {
  for (const ruim of [undefined, '', '0', '-2', 'abc']) {
    assert.equal(lerCriteriosDoForm({ vaga: ruim }).jobIdAlvo, undefined);
  }
});
