'use strict';

// Sugestao de conteudo por LLM (src/lib/gerarSugestaoPromocao.js) e a rota
// POST /admin/promocao/sugestao.
//
// ZERO REDE: o provedor de LLM e INJETADO como dublê em todos os testes de unidade. Nos
// testes de rota, o modulo `providers/llm` em cache tem o metodo `completar` trocado —
// funciona porque a lib chama `llm.completar(...)` como PROPRIEDADE (mesma tecnica que
// lembreteInicio.test.js usa com o provider de e-mail).
//
// O QUE ESTA EM JOGO: o texto gerado aqui vira e-mail para centenas de pessoas. As
// assercoes que mais importam nao sao sobre o feliz caminho, e sim sobre a FALHA: uma
// sugestao que nao veio nao pode apagar o que o recrutador ja tinha escrito, e um erro do
// modelo nao pode virar 500 sem explicacao.

const os = require('node:os');
const path = require('node:path');

process.env.DATABASE_PATH = path.join(os.tmpdir(), `vm-test-promocao-sug-${process.pid}-${Date.now()}.db`);
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
const providerLlm = require('../src/providers/llm');
const sugestao = require('../src/lib/gerarSugestaoPromocao');

migrar();

// ── Cenario ──
let seq = 0;
function criarVaga(campos = {}) {
  seq += 1;
  return Number(
    db
      .getDb()
      .prepare(
        `INSERT INTO jobs (slug, titulo, perfil, faixa_pagamento, skills, descricao, sobre_empresa, ativo)
         VALUES (?, ?, ?, ?, ?, ?, ?, 1)`,
      )
      .run(
        `vaga-sug-${seq}`,
        campos.titulo || 'Closer de Vendas',
        campos.perfil || 'CLOSER',
        campos.faixa_pagamento || 'R$ 3.000 + comissão',
        JSON.stringify(campos.skills || ['negociação', 'CRM']),
        campos.descricao || 'Fechamento de vendas consultivas para PMEs.',
        campos.sobre_empresa || 'Empresa de educação em vendas.',
      ).lastInsertRowid,
  );
}

const vagaId = criarVaga();

// ── Dublês de LLM ──
const RESPOSTA_BOA = JSON.stringify({
  assunto: 'Vaga aberta: Closer de Vendas',
  corpoHtml: '<p>Temos uma vaga de Closer.</p><p>Se fizer sentido, candidate-se.</p>',
});

const llmQueResponde = (texto, extra = {}) => ({
  completar: async () => ({
    texto,
    modelo: 'deepseek/deepseek-v4-flash',
    uso: {
      prompt_tokens: 500,
      completion_tokens: 200,
      total_tokens: 700,
      prompt_cache_hit_tokens: 0,
      prompt_cache_miss_tokens: 500,
    },
    finishReason: 'stop',
    ...extra,
  }),
});

const llmQueFalha = {
  completar: async () => {
    throw new Error('rede fora / provedor indisponivel');
  },
};

// ── 1. Caminho feliz ──

test('gerarSugestaoConteudo: JSON valido vira assunto e corpoHtml', async () => {
  const r = await sugestao.gerarSugestaoConteudo(vagaId, { db, llm: llmQueResponde(RESPOSTA_BOA) });
  assert.equal(r.ok, true);
  assert.equal(r.assunto, 'Vaga aberta: Closer de Vendas');
  assert.match(r.corpoHtml, /<p>Temos uma vaga de Closer\.<\/p>/);
});

// ── 2. Parse tolerante ──

test('gerarSugestaoConteudo: cerca de markdown ao redor do JSON ainda funciona', async () => {
  const comCerca = '```json\n' + RESPOSTA_BOA + '\n```';
  const r = await sugestao.gerarSugestaoConteudo(vagaId, { db, llm: llmQueResponde(comCerca) });
  assert.equal(r.ok, true);
  assert.equal(r.assunto, 'Vaga aberta: Closer de Vendas');
});

test('gerarSugestaoConteudo: texto solto antes e depois do JSON e descartado', async () => {
  const sujo = `Claro! Aqui esta:\n${RESPOSTA_BOA}\nEspero ter ajudado.`;
  const r = await sugestao.gerarSugestaoConteudo(vagaId, { db, llm: llmQueResponde(sujo) });
  assert.equal(r.ok, true);
});

// ── 3. Truncamento ──

test('gerarSugestaoConteudo: finishReason "length" tem codigo PROPRIO', async () => {
  // Truncado: o JSON nem fecha. O codigo precisa dizer "truncou", nao "falhou" —
  // sao acoes diferentes para o recrutador.
  const cortado = '{"assunto":"Vaga aberta","corpoHtml":"<p>Comeco do texto que fo';
  const r = await sugestao.gerarSugestaoConteudo(vagaId, {
    db,
    llm: llmQueResponde(cortado, { finishReason: 'length' }),
  });
  assert.equal(r.ok, false);
  assert.equal(r.erroCodigo, 'SUGESTAO_TRUNCADA');
});

// ── 4. Respostas inaproveitaveis ──

test('gerarSugestaoConteudo: JSON malformado devolve erro, nao lanca', async () => {
  let r;
  await assert.doesNotReject(async () => {
    r = await sugestao.gerarSugestaoConteudo(vagaId, { db, llm: llmQueResponde('isto nao e json') });
  });
  assert.equal(r.ok, false);
  assert.equal(r.erroCodigo, 'SUGESTAO_FALHOU');
});

test('gerarSugestaoConteudo: JSON valido mas sem os campos exigidos e recusado', async () => {
  for (const ruim of [
    JSON.stringify({ assunto: 'so assunto' }),
    JSON.stringify({ corpoHtml: '<p>so corpo</p>' }),
    JSON.stringify({ assunto: '   ', corpoHtml: '<p>x</p>' }),
    JSON.stringify(['array', 'nao', 'objeto']),
  ]) {
    const r = await sugestao.gerarSugestaoConteudo(vagaId, { db, llm: llmQueResponde(ruim) });
    assert.equal(r.ok, false, `deveria recusar: ${ruim}`);
    assert.equal(r.erroCodigo, 'SUGESTAO_FALHOU');
  }
});

test('gerarSugestaoConteudo: LLM indisponivel tem codigo distinto de parse ruim', async () => {
  const r = await sugestao.gerarSugestaoConteudo(vagaId, { db, llm: llmQueFalha });
  assert.equal(r.ok, false);
  assert.equal(r.erroCodigo, 'LLM_INDISPONIVEL');
});

test('gerarSugestaoConteudo: vaga inexistente nem chama o LLM', async () => {
  let chamou = false;
  const llmEspiao = {
    completar: async () => {
      chamou = true;
      return { texto: RESPOSTA_BOA, finishReason: 'stop' };
    },
  };
  for (const ruim of [999999, 0, -1, undefined, 'abc']) {
    const r = await sugestao.gerarSugestaoConteudo(ruim, { db, llm: llmEspiao });
    assert.equal(r.ok, false);
    assert.equal(r.erroCodigo, 'VAGA_NAO_ENCONTRADA');
  }
  assert.equal(chamou, false, 'sem vaga valida nao se gasta token');
});

// ── 5. Registro de custo ──

test('custo e registrado em api_usage com origem "promocao"', async () => {
  const antes = db.getDb().prepare("SELECT COUNT(*) AS n FROM api_usage WHERE origem = 'promocao'").get().n;

  await sugestao.gerarSugestaoConteudo(vagaId, { db, llm: llmQueResponde(RESPOSTA_BOA) });

  const linha = db
    .getDb()
    .prepare("SELECT * FROM api_usage WHERE origem = 'promocao' ORDER BY id DESC LIMIT 1")
    .get();
  const depois = db.getDb().prepare("SELECT COUNT(*) AS n FROM api_usage WHERE origem = 'promocao'").get().n;

  assert.equal(depois, antes + 1);
  assert.equal(linha.origem, 'promocao');
  assert.equal(linha.modelo, 'deepseek/deepseek-v4-flash');
  assert.equal(linha.prompt_tokens, 500);
  assert.equal(linha.completion_tokens, 200);
  assert.ok(linha.custo_usd > 0, 'o custo precisa ter sido calculado, nao ficar zerado');
  // Sem entrevista associada: campanha nao passa por interviews.
  assert.equal(linha.interview_id, null);
});

test('falha no registro de custo NAO derruba a sugestao (best-effort)', async () => {
  const dbQuebrado = {
    obterVaga: db.obterVaga,
    registrarUsoApi: () => {
      throw new Error('api_usage indisponivel');
    },
  };
  const r = await sugestao.gerarSugestaoConteudo(vagaId, {
    db: dbQuebrado,
    llm: llmQueResponde(RESPOSTA_BOA),
  });
  assert.equal(r.ok, true, 'a sugestao ja foi paga; log de custo nao pode invalida-la');
});

// ── Prompt ──

test('o prompt leva os dados da vaga e proibe rodape de descadastro', async () => {
  const vaga = db.obterVaga(vagaId);
  const msgs = sugestao.montarMensagensSugestao(vaga);

  assert.equal(msgs.length, 2);
  assert.equal(msgs[0].papel, 'system');
  assert.equal(msgs[1].papel, 'user');

  // A instrucao mais importante do prompt: o link de opt-out e do adaptador de envio
  // (Incremento 3), nao do texto gerado. Dois caminhos de descadastro seria pior que um.
  assert.match(msgs[0].conteudo, /NAO ESCREVA RODAPE DE DESCADASTRO/);
  assert.match(msgs[0].conteudo, /List-Unsubscribe/);
  // E HTML simples, nao design system dentro do e-mail.
  assert.match(msgs[0].conteudo, /NAO use CSS inline/);

  assert.match(msgs[1].conteudo, /Closer de Vendas/);
  assert.match(msgs[1].conteudo, /R\$ 3\.000/);
  assert.match(msgs[1].conteudo, /negociação, CRM/);
});

test('campo vazio da vaga nao vira linha em branco no prompt', () => {
  const msgs = sugestao.montarMensagensSugestao({ titulo: 'Vaga X', perfil: 'SDR' });
  assert.doesNotMatch(msgs[1].conteudo, /Faixa de pagamento/);
  assert.doesNotMatch(msgs[1].conteudo, /Sobre a empresa/);
  assert.match(msgs[1].conteudo, /Vaga X/);
});

// ── Rota ──

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
  return cookieAdmin;
}

const postForm = (dados) => ({
  method: 'POST',
  headers: { Cookie: cookieAdmin, 'Content-Type': 'application/x-www-form-urlencoded' },
  body: new URLSearchParams(dados),
  redirect: 'manual',
});

// Troca o `completar` do modulo em cache — a lib o chama como propriedade, entao a troca
// vale. Restaurado no fim de cada teste.
const completarOriginal = providerLlm.completar;
function comLlm(fn, corpo) {
  providerLlm.completar = fn;
  return Promise.resolve(corpo()).finally(() => {
    providerLlm.completar = completarOriginal;
  });
}

test('POST /admin/promocao/sugestao exige login', async () => {
  await comServidor(async (base) => {
    const res = await fetch(`${base}/admin/promocao/sugestao`, { method: 'POST', redirect: 'manual' });
    assert.equal(res.status, 302);
    assert.match(res.headers.get('location') || '', /\/admin\/login/);
  });
});

test('POST /sugestao com sucesso: preenche assunto e corpo e PRESERVA os filtros', async () => {
  await comServidor(async (base) => {
    await autenticar(base);
    await comLlm(
      async () => ({ texto: RESPOSTA_BOA, modelo: 'm', uso: {}, finishReason: 'stop' }),
      async () => {
        const res = await fetch(
          `${base}/admin/promocao/sugestao`,
          postForm({
            vaga: String(vagaId),
            perfil: 'CLOSER',
            perfil_incluir_sem: '1',
            de: '2020-01-01',
          }),
        );
        assert.equal(res.status, 200);
        const html = await res.text();

        // Conteudo sugerido chegou aos campos.
        assert.match(html, /Vaga aberta: Closer de Vendas/);
        assert.match(html, /Temos uma vaga de Closer/);
        // Aviso de que e conteudo de IA.
        assert.match(html, /gerados por IA/);
        // Filtros preservados: pedir texto nao pode custar o recorte de publico.
        assert.match(html, /value="CLOSER" selected/);
        assert.match(html, /name="perfil_incluir_sem" value="1" checked/);
        assert.match(html, /value="2020-01-01"/);
        assert.match(html, /Criar campanha \(rascunho\)/);
      },
    );
  });
});

test('POST /sugestao com sucesso: a previa vem RECALCULADA na mesma tela', async () => {
  // A garantia do Incremento 5 e "ninguem cria campanha sem ver o tamanho dela". Sem o
  // recalculo, pedir uma sugestao de texto liberava o botao de criar e tirava os numeros
  // da tela — este teste e o que impede essa regressao.
  await comServidor(async (base) => {
    await autenticar(base);
    await comLlm(
      async () => ({ texto: RESPOSTA_BOA, modelo: 'm', uso: {}, finishReason: 'stop' }),
      async () => {
        const html = await (
          await fetch(`${base}/admin/promocao/sugestao`, postForm({ vaga: String(vagaId) }))
        ).text();

        assert.match(html, /Prévia do público/, 'o bloco de previa precisa estar na tela');
        assert.match(html, /de candidaturas/);
        assert.match(html, /do banco de talentos/);
        // E o texto sugerido continua la, junto: e a MESMA tela que /previa produziria,
        // so que com assunto e corpo ja preenchidos.
        assert.match(html, /Vaga aberta: Closer de Vendas/);
      },
    );
  });
});

test('POST /sugestao: o numero da previa bate com o motor, para os mesmos criterios', async () => {
  const { listarPublicoCampanha } = require('../src/lib/promocaoVagas');
  const esperado = listarPublicoCampanha({ jobIdAlvo: vagaId, perfil: 'CLOSER' });

  await comServidor(async (base) => {
    await autenticar(base);
    await comLlm(
      async () => ({ texto: RESPOSTA_BOA, modelo: 'm', uso: {}, finishReason: 'stop' }),
      async () => {
        const html = await (
          await fetch(
            `${base}/admin/promocao/sugestao`,
            postForm({ vaga: String(vagaId), perfil: 'CLOSER' }),
          )
        ).text();
        assert.match(html, new RegExp(String(esperado.total)));
      },
    );
  });
});

test('POST /sugestao com falha do LLM: NAO apaga o que o Jean digitou', async () => {
  await comServidor(async (base) => {
    await autenticar(base);
    await comLlm(
      async () => {
        throw new Error('provedor fora');
      },
      async () => {
        const res = await fetch(
          `${base}/admin/promocao/sugestao`,
          postForm({
            vaga: String(vagaId),
            assunto: 'Assunto que eu mesmo escrevi',
            corpo_html: '<p>Corpo que eu mesmo escrevi</p>',
            perfil: 'SDR',
          }),
        );
        assert.equal(res.status, 502);
        const html = await res.text();

        assert.match(html, /Assunto que eu mesmo escrevi/, 'o texto digitado nao pode sumir');
        assert.match(html, /Corpo que eu mesmo escrevi/);
        assert.match(html, /Não consegui falar com o modelo de IA/);
        assert.match(html, /value="SDR" selected/, 'o filtro tambem sobrevive a falha');
        // Nao pode aparecer o aviso de conteudo gerado: nada foi gerado.
        assert.doesNotMatch(html, /gerados por IA/);
      },
    );
  });
});

test('POST /sugestao com FALHA: o campo oculto ainda carrega o estado da previa', async () => {
  // O caminho de sucesso agora recalcula a previa, entao o campo oculto deixou de importar
  // la. Ele continua sendo a UNICA coisa que segura o estado no caminho de ERRO, que nao
  // recalcula — sem ele, uma falha do LLM esconderia o botao de criar de quem ja tinha
  // calculado a previa e obrigaria a recomecar.
  await comServidor(async (base) => {
    await autenticar(base);
    await comLlm(
      async () => {
        throw new Error('provedor fora');
      },
      async () => {
        const html = await (
          await fetch(
            `${base}/admin/promocao/sugestao`,
            postForm({ vaga: String(vagaId), previa_calculada: '1' }),
          )
        ).text();

        assert.match(html, /name="previa_calculada" value="1"/, 'o estado nao pode se perder');
        assert.match(html, /Criar campanha \(rascunho\)/, 'quem ja tinha previa segue podendo criar');
      },
    );
  });
});

test('POST /sugestao com resposta inaproveitavel: mensagem propria, texto preservado', async () => {
  await comServidor(async (base) => {
    await autenticar(base);
    await comLlm(
      async () => ({ texto: 'desculpe, nao posso ajudar', modelo: 'm', uso: {}, finishReason: 'stop' }),
      async () => {
        const res = await fetch(
          `${base}/admin/promocao/sugestao`,
          postForm({ vaga: String(vagaId), assunto: 'Meu assunto' }),
        );
        assert.equal(res.status, 502);
        const html = await res.text();
        assert.match(html, /formato que não consegui aproveitar/);
        assert.match(html, /Meu assunto/);
      },
    );
  });
});

test('POST /sugestao sem vaga: erro claro e NENHUMA chamada ao LLM', async () => {
  await comServidor(async (base) => {
    await autenticar(base);
    let chamou = false;
    await comLlm(
      async () => {
        chamou = true;
        return { texto: RESPOSTA_BOA, finishReason: 'stop' };
      },
      async () => {
        const res = await fetch(
          `${base}/admin/promocao/sugestao`,
          postForm({ assunto: 'Digitei isto antes de escolher a vaga' }),
        );
        assert.equal(res.status, 400);
        const html = await res.text();
        assert.match(html, /Escolha a vaga antes de gerar a sugestão/);
        assert.match(html, /Digitei isto antes de escolher a vaga/, 'o texto continua la');
      },
    );
    assert.equal(chamou, false, 'sem vaga nao se chama o LLM');
  });
});

test('a rota de sugestao NAO cria campanha nenhuma', async () => {
  await comServidor(async (base) => {
    await autenticar(base);
    const antes = db.listarCampanhas().length;
    await comLlm(
      async () => ({ texto: RESPOSTA_BOA, modelo: 'm', uso: {}, finishReason: 'stop' }),
      async () => {
        await fetch(`${base}/admin/promocao/sugestao`, postForm({ vaga: String(vagaId) }));
      },
    );
    assert.equal(db.listarCampanhas().length, antes);
  });
});

test('o formulario oferece o botao de gerar sugestao', async () => {
  await comServidor(async (base) => {
    await autenticar(base);
    const html = await (
      await fetch(`${base}/admin/promocao/nova`, { headers: { Cookie: cookieAdmin } })
    ).text();
    assert.match(html, /Gerar sugestão de conteúdo/);
    assert.match(html, /formaction="\/admin\/promocao\/sugestao"/);
  });
});
