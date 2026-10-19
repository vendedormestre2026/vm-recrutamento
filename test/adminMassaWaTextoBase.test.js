'use strict';

// Disparo em massa: o texto-base e a fonte da verdade das variacoes — ponta a ponta por HTTP.
//
// Regressao da campanha 9 (lembrete com a sala do Meet que saiu como convite com o Calendly) e as
// travas novas: geracao por IA a partir do texto-base, erro sem fallback, variacoes desatualizadas
// depois de editar o texto-base, previa das 7 com a linha de descadastro do sistema.
//
// ZERO REDE: o LLM e o modulo `providers/llm` em cache com `completar` trocado (a lib chama
// `llm.completar` como PROPRIEDADE — mesma tecnica de promocaoSugestao.test.js). MASSA_WA_LLM_ATIVO
// so e ligado dentro de cada teste que precisa, e desligado no fim. MASSA_WA_MOCK fica no default
// (ligado): nada sai daqui.

const os = require('node:os');
const path = require('node:path');

process.env.DATABASE_PATH = path.join(os.tmpdir(), `vm-test-admin-massa-texto-base-${process.pid}-${Date.now()}.db`);
process.env.INTERVIEW_MOCK = 'true';
process.env.SESSION_SECRET = 'segredo-de-teste';
process.env.OPTOUT_TOKEN_SECRET = 'segredo-hmac-de-teste';
process.env.ADMIN_USER = 'admin-teste';
process.env.ADMIN_PASSWORD = 'senha-teste';
process.env.NODE_ENV = 'test';
delete process.env.MASSA_WA_LLM_ATIVO;

const test = require('node:test');
const assert = require('node:assert/strict');

const db = require('../src/db');
const { migrar } = require('../src/db/migrate');
const { criarApp } = require('../src/server');
const providerLlm = require('../src/providers/llm');
const v = require('../src/lib/variacoesMassaWa');
const { BASE_LEMBRETE, REDACOES_LEMBRETE, URL_SALA } = require('./fixtures/variacoesLembreteMassaWa');

migrar();

function diaRelativo(dias) {
  const d = new Date(Date.now() + dias * 24 * 60 * 60 * 1000);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
}

let cookie = '';
let seq = 0;

async function comServidor(fn) {
  const server = criarApp().listen(0);
  await new Promise((r) => server.once('listening', r));
  try {
    const base = `http://127.0.0.1:${server.address().port}`;
    const res = await fetch(`${base}/admin/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ usuario: 'admin-teste', senha: 'senha-teste' }),
      redirect: 'manual',
    });
    cookie = res.headers.getSetCookie().map((c) => c.split(';')[0]).join('; ');
    return await fn(base);
  } finally {
    await new Promise((r) => server.close(r));
  }
}
const get = async (base, url) => (await fetch(`${base}${url}`, { headers: { Cookie: cookie } })).text();
function post(base, url, campos) {
  const body = new URLSearchParams();
  for (const [k, val] of Object.entries(campos || {})) {
    if (Array.isArray(val)) val.forEach((x) => body.append(k, x));
    else body.append(k, val);
  }
  return fetch(`${base}${url}`, {
    method: 'POST',
    headers: { Cookie: cookie, 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
    redirect: 'manual',
  });
}
const local = (res) => res.headers.get('location') || '';

function criarVaga() {
  seq += 1;
  return db.criarVaga({
    slug: `vaga-texto-base-${seq}`, titulo: `Closer ${seq}`, perfil: 'CLOSER', empresa: 'Acme Ltda', ativo: true,
    link_meet: 'https://calendly.com/vm/x', entrevista_grupo_1_data: diaRelativo(10), entrevista_grupo_1_hora: '14:00',
  });
}
function criarCandidatura(jobId) {
  seq += 1;
  db.getDb().prepare('INSERT INTO applications (job_id, nome, telefone) VALUES (?, ?, ?)')
    .run(jobId, `Pessoa ${seq}`, `+55 47 9${String(80000000 + seq).slice(0, 8)}`);
}
const ultimaCampanha = () => db.getDb().prepare('SELECT * FROM campanhas_massa_wa ORDER BY id DESC LIMIT 1').get();
const textosDe = (id) => db.listarVariacoesMassaWa(id).map((x) => x.texto);
const variacoesDoCorpo = (textos) => Object.fromEntries(textos.map((t, i) => [`variacao_${i + 1}`, t]));

// LLM duble + interruptor, restaurados no fim de cada teste.
async function comIa(respostas, fn) {
  const original = providerLlm.completar;
  const chamadas = [];
  process.env.MASSA_WA_LLM_ATIVO = 'true';
  providerLlm.completar = async (mensagens) => {
    chamadas.push(mensagens);
    const r = respostas[Math.min(chamadas.length - 1, respostas.length - 1)];
    if (r instanceof Error) throw r;
    return { texto: r, modelo: 'duble', uso: { prompt_tokens: 1, completion_tokens: 1 }, finishReason: 'stop' };
  };
  try {
    return await fn(chamadas);
  } finally {
    providerLlm.completar = original;
    delete process.env.MASSA_WA_LLM_ATIVO;
  }
}
const json = (lista) => JSON.stringify({ variacoes: lista });

async function criarLembrete(base, jobId) {
  return post(base, '/admin/massa-wa', {
    nome: 'Lembrete Entrevista em Grupo', job_id: String(jobId), status: ['sem_decisao'], texto_base: BASE_LEMBRETE.replace(/\n/g, '\r\n'),
  });
}

// ══════════════════ REGRESSAO DO BUG ══════════════════

test('regressao campanha 9: criar com o lembrete e a IA ligada gera as 7 A PARTIR DO TEXTO-BASE', async () => {
  const jobId = criarVaga();
  await comServidor(async (base) => {
    await comIa([json([...REDACOES_LEMBRETE])], async (chamadas) => {
      const res = await criarLembrete(base, jobId);
      assert.match(local(res), /ok=criada_gerada/);
      assert.equal(chamadas.length, 1);
      assert.ok(chamadas[0].find((m) => m.papel === 'user').conteudo.includes(BASE_LEMBRETE));
    });
    const c = ultimaCampanha();
    const textos = textosDe(c.id);
    assert.deepEqual(textos, [...REDACOES_LEMBRETE]);
    for (const [i, t] of textos.entries()) {
      assert.ok(t.includes(URL_SALA), `variacao ${i + 1} sem a sala`);
      for (const trecho of ['{data}', '{horario}', '{link_meet}', 'Confirme', 'confirmar presença']) {
        assert.ok(!t.includes(trecho), `variacao ${i + 1} trouxe "${trecho}" do convite padrao`);
      }
    }
    assert.equal(c.variacoes_erro, null);
    assert.equal(v.variacoesDesatualizadas(c), false);

    const html = await get(base, `/admin/massa-wa/${c.id}`);
    assert.match(html, /As 7 variações passam na validação contra o texto-base/);
  });
});

test('regressao campanha 9: se o LLM devolver as sementes do convite, NADA e gravado e a tela mostra o erro', async () => {
  const jobId = criarVaga();
  await comServidor(async (base) => {
    await comIa([json([...v.VARIACOES_SEED])], async (chamadas) => {
      const res = await criarLembrete(base, jobId);
      assert.match(local(res), /erro=geracao_falhou/);
      assert.equal(chamadas.length, 3, 'tres tentativas');
    });
    const c = ultimaCampanha();
    assert.equal(textosDe(c.id).length, 0);
    assert.match(c.variacoes_erro, /não gerou 7 variações válidas/);
    const html = await get(base, `/admin/massa-wa/${c.id}?erro=geracao_falhou`);
    assert.match(html, /Variações com erro — a campanha não materializa, não ativa nem envia/);
    assert.match(html, /não gerou 7 variações válidas/);
  });
});

// ══════════════════ FALHA SEM FALLBACK + KILL-SWITCH ══════════════════

test('LLM fora do ar no "Regenerar": as variacoes atuais ficam, o erro bloqueia materializar e ativar', async () => {
  const jobId = criarVaga();
  criarCandidatura(jobId);
  await comServidor(async (base) => {
    await comIa([json([...REDACOES_LEMBRETE])], () => criarLembrete(base, jobId));
    const id = ultimaCampanha().id;
    await comIa([new Error('rede fora')], async () => {
      const res = await post(base, `/admin/massa-wa/${id}/sugerir`, {});
      assert.match(local(res), /erro=geracao_falhou/);
    });
    assert.deepEqual(textosDe(id), [...REDACOES_LEMBRETE], 'falha nao apaga o que havia');
    assert.match(ultimaCampanha().variacoes_erro, /a IA não respondeu/);

    assert.match(local(await post(base, `/admin/massa-wa/${id}/materializar`, {})), /erro=variacoes_com_erro/);
    assert.equal(db.resumoCampanhaMassaWa(id).length, 0, 'nada materializado');
    assert.match(local(await post(base, `/admin/massa-wa/${id}/teste`, { telefone: '+55 47 99999-0000' })), /erro=variacoes_com_erro/);
  });
});

test('salvar as 7 a mao limpa o erro (o caminho com a IA desligada)', async () => {
  const jobId = criarVaga();
  await comServidor(async (base) => {
    await criarLembrete(base, jobId);
    const id = ultimaCampanha().id;
    assert.ok(ultimaCampanha().variacoes_erro);
    await post(base, `/admin/massa-wa/${id}/variacoes`, variacoesDoCorpo([...REDACOES_LEMBRETE]));
    const c = ultimaCampanha();
    assert.equal(c.variacoes_erro, null);
    assert.equal(v.variacoesDesatualizadas(c), false);
    assert.equal(v.validarVariacoes(textosDe(id), { textoBase: v.textoBaseEfetivo(c) }).ok, true);
  });
});

// ══════════════════ TEXTO-BASE EDITADO ══════════════════

test('editar o texto-base REFAZ as 7 automaticamente a partir do texto NOVO (IA ligada)', async () => {
  const jobId = criarVaga();
  criarCandidatura(jobId);
  await comServidor(async (base) => {
    await comIa([json([...REDACOES_LEMBRETE])], () => criarLembrete(base, jobId));
    const id = ultimaCampanha().id;
    const novoBase = BASE_LEMBRETE.replace('Te espero lá.', 'Te espero lá, combinado?');
    const novas = REDACOES_LEMBRETE.map((t) => t.replace(/[.!]$/, '. Combinado?'));

    await comIa([json(novas)], async (chamadas) => {
      const res = await post(base, `/admin/massa-wa/${id}`, { nome: 'Lembrete', job_id: String(jobId), status: ['sem_decisao'], texto_base: novoBase });
      assert.match(local(res), /ok=salva_regenerada/);
      assert.equal(chamadas.length, 1, 'uma geracao, sem clique');
      assert.ok(chamadas[0].find((m) => m.papel === 'user').conteudo.includes('Te espero lá, combinado?'), 'le o texto NOVO');
    });
    assert.deepEqual(textosDe(id), novas, 'as anteriores foram substituidas');
    const c = ultimaCampanha();
    assert.equal(v.variacoesDesatualizadas(c), false);
    assert.equal(c.variacoes_erro, null);
    assert.match(local(await post(base, `/admin/massa-wa/${id}/materializar`, {})), /ok=materializada/);
  });
});

test('editar o texto-base com a IA DESLIGADA: nada e gravado, o erro fica na tela e a campanha nao avanca', async () => {
  const jobId = criarVaga();
  criarCandidatura(jobId);
  await comServidor(async (base) => {
    await comIa([json([...REDACOES_LEMBRETE])], () => criarLembrete(base, jobId));
    const id = ultimaCampanha().id;
    const res = await post(base, `/admin/massa-wa/${id}`, {
      nome: 'Lembrete', job_id: String(jobId), status: ['sem_decisao'], texto_base: `${BASE_LEMBRETE}\nAté!`,
    });
    assert.match(local(res), /erro=ia_desligada/);
    assert.deepEqual(textosDe(id), [...REDACOES_LEMBRETE], 'nenhum texto padrao no lugar');
    assert.equal(v.variacoesDesatualizadas(ultimaCampanha()), true);
    assert.match(local(await post(base, `/admin/massa-wa/${id}/materializar`, {})), /erro=variacoes_com_erro/);
  });
});

test('campanha criada com a IA desligada: depois de ligar, SALVAR a configuracao ja gera as 7 (sem mudar o texto)', async () => {
  // O caso de uso: criou com a IA desligada, ficou "Variações com erro". Ligou a IA, salvou.
  const jobId = criarVaga();
  await comServidor(async (base) => {
    await criarLembrete(base, jobId);
    const id = ultimaCampanha().id;
    assert.equal(textosDe(id).length, 0);
    await comIa([json([...REDACOES_LEMBRETE])], async (chamadas) => {
      const res = await post(base, `/admin/massa-wa/${id}`, {
        nome: 'Lembrete', job_id: String(jobId), status: ['sem_decisao'], texto_base: BASE_LEMBRETE,
      });
      assert.match(local(res), /ok=salva_regenerada/);
      assert.equal(chamadas.length, 1);
    });
    assert.deepEqual(textosDe(id), [...REDACOES_LEMBRETE]);
    assert.equal(ultimaCampanha().variacoes_erro, null);
  });
});

test('o botao "Gerar/Regenerar variações com IA" fica ANTES das caixas das variacoes', async () => {
  const jobId = criarVaga();
  await comServidor(async (base) => {
    await criarLembrete(base, jobId);
    const html = await get(base, `/admin/massa-wa/${ultimaCampanha().id}`);
    const botao = html.indexOf('Gerar variações com IA');
    assert.ok(botao > 0);
    assert.ok(botao < html.indexOf('name="variacao_1"'), 'antes da primeira caixa');
    assert.ok(botao < html.indexOf('Prévia das 7 variações'), 'antes da previa');
    assert.match(html, /MASSA_WA_LLM_ATIVO=true<\/code> nas variáveis do Railway/);
  });
});

test('salvar a configuracao SEM mudar o texto-base (mesmo com \\r\\n) nao desatualiza nada', async () => {
  const jobId = criarVaga();
  await comServidor(async (base) => {
    await comIa([json([...REDACOES_LEMBRETE])], () => criarLembrete(base, jobId));
    const id = ultimaCampanha().id;
    const res = await post(base, `/admin/massa-wa/${id}`, {
      nome: 'Lembrete', job_id: String(jobId), status: ['sem_decisao'], texto_base: BASE_LEMBRETE.replace(/\n/g, '\r\n'),
    });
    assert.match(local(res), /ok=salva$/);
    assert.equal(v.variacoesDesatualizadas(ultimaCampanha()), false);
  });
});

test('campanha pausada cujo texto-base e editado com a IA desligada nao pode ser reativada', async () => {
  const jobId = criarVaga();
  criarCandidatura(jobId);
  await comServidor(async (base) => {
    await comIa([json([...REDACOES_LEMBRETE])], () => criarLembrete(base, jobId));
    const id = ultimaCampanha().id;
    await post(base, `/admin/massa-wa/${id}/materializar`, {});
    await post(base, `/admin/massa-wa/${id}/status`, { status: 'pausada' });
    await post(base, `/admin/massa-wa/${id}`, { nome: 'Lembrete', job_id: String(jobId), status: ['sem_decisao'], texto_base: `${BASE_LEMBRETE}\nAté!` });
    assert.match(local(await post(base, `/admin/massa-wa/${id}/status`, { status: 'ativa' })), /erro=variacoes_com_erro/);
  });
});

// ══════════════════ PREVIA E AVISOS ══════════════════

test('previa das 7 com destinatario ficticio; a linha de descadastro do sistema aparece UMA vez em cada', async () => {
  const jobId = criarVaga();
  await comServidor(async (base) => {
    await comIa([json([...REDACOES_LEMBRETE])], () => criarLembrete(base, jobId));
    const html = await get(base, `/admin/massa-wa/${ultimaCampanha().id}`);
    assert.match(html, /Prévia das 7 variações \(destinatário fictício, dados reais da vaga\)/);
    for (let i = 1; i <= 7; i += 1) assert.match(html, new RegExp(`<summary>Variação ${i}</summary>`));
    assert.equal(html.split('Olá, Maria!').length - 1, 7, 'as 7 com o mesmo destinatario ficticio');
    const linha = 'Para não receber mais mensagens nossas, acesse: ';
    assert.equal(html.split(`${linha}https://`).length - 1, 7, 'uma linha resolvida por variacao, nunca duas');
    assert.ok(html.includes(URL_SALA));
  });
});

test('aviso na tela: texto-base com horario e link escritos a mao e sem {data}', async () => {
  const jobId = criarVaga();
  await comServidor(async (base) => {
    await criarLembrete(base, jobId);
    const html = await get(base, `/admin/massa-wa/${ultimaCampanha().id}`);
    assert.match(html, /o texto-base tem horário <b>14h<\/b>, link <code>https:\/\/meet\.google\.com\/qeu-emje-txh\?pli=1<\/code> escrito\(s\) à mão/);
  });
});

test('texto-base com {data}: sem aviso de horario literal', async () => {
  const jobId = criarVaga();
  await comServidor(async (base) => {
    await post(base, '/admin/massa-wa', { nome: 'C', job_id: String(jobId), status: ['sem_decisao'] });
    const html = await get(base, `/admin/massa-wa/${ultimaCampanha().id}`);
    assert.doesNotMatch(html, /escrito\(s\) à mão/);
  });
});

// ══════════════════ SEGMENTO INALTERADO ══════════════════

test('segmento: "Sugerir" continua restaurando as sementes do convite (sem LLM)', async () => {
  const jobId = criarVaga();
  const id = db.criarCampanhaMassaWa({
    nome: 'Seg', jobId, textoBase: v.TEXTO_BASE_CONVITE, criterios: { fonte: 'segmento', cidade: 'Joinville', teto: 10 },
  });
  db.salvarVariacoesMassaWa(id, ['so uma']);
  await comServidor(async (base) => {
    const original = providerLlm.completar;
    let chamou = false;
    providerLlm.completar = async () => { chamou = true; return { texto: '' }; };
    try {
      assert.match(local(await post(base, `/admin/massa-wa/${id}/sugerir`, {})), /ok=sugerido/);
    } finally {
      providerLlm.completar = original;
    }
    assert.equal(chamou, false);
    assert.deepEqual(textosDe(id), [...v.VARIACOES_SEED_CONVITE]);
  });
});

// ══════════════════ PARAGRAFOS (2026-10-19) ══════════════════

test('regressao campanha 11: LLM devolvendo uma linha so — nada e gravado e a tela explica o motivo', async () => {
  const jobId = criarVaga();
  const achatar = (t) => t.replace(/\s*\n+\s*/g, ' ');
  await comServidor(async (base) => {
    await comIa([json(REDACOES_LEMBRETE.map(achatar))], async (chamadas) => {
      const res = await criarLembrete(base, jobId);
      assert.match(local(res), /erro=geracao_falhou/);
      assert.equal(chamadas.length, 3);
    });
    const c = ultimaCampanha();
    assert.equal(textosDe(c.id).length, 0, 'nenhuma variacao achatada gravada');
    assert.match(c.variacoes_erro, /perdeu os paragrafos/);
    const html = await get(base, `/admin/massa-wa/${c.id}?erro=geracao_falhou`);
    assert.match(html, /Variações com erro/);
    assert.match(html, /perdeu os paragrafos/);
  });
});

test('variacoes salvas a mao: \\r\\n vira \\n no banco e a achatada aparece nas pendencias', async () => {
  const jobId = criarVaga();
  await comServidor(async (base) => {
    await comIa([json([...REDACOES_LEMBRETE])], async () => { await criarLembrete(base, jobId); });
    const c = ultimaCampanha();
    const textos = [...REDACOES_LEMBRETE];
    textos[1] = textos[1].replace(/\s*\n+\s*/g, ' ');
    await post(base, `/admin/massa-wa/${c.id}/variacoes`, variacoesDoCorpo(textos.map((t) => t.replace(/\n/g, '\r\n'))));
    for (const t of textosDe(c.id)) assert.ok(!t.includes('\r'), 'sem \\r gravado');
    const html = await get(base, `/admin/massa-wa/${c.id}`);
    assert.match(html, /Variação 2: perdeu os parágrafos: tem 0 quebra\(s\) de linha/);
  });
});
