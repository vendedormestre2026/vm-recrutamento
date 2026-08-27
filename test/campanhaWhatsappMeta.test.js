'use strict';

// Campanha em massa por WhatsApp via Meta Cloud API: schema, adaptador, job e webhook.
//
// ── ZERO REDE, ZERO CREDENCIAL ──
// O adaptador roda em MOCK (default) ou com httpClient injetado. Nenhum teste chama a Meta,
// nenhum usa token real.
//
// ── O QUE ESTA EM JOGO ──
// Mensagem em massa num canal onde a punicao por erro nao e reputacao gradual, e sim perda do
// numero. Os erros nao sao simetricos:
//   nao enviar     alguem fica sem o convite. Corrigivel.
//   enviar demais  duplicata, ou envio a quem pediu para sair -> denuncia -> tier rebaixado.
// Por isso a maioria das assercoes verifica que NAO saiu.

const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const express = require('express');

process.env.DATABASE_PATH = path.join(os.tmpdir(), `vm-test-campanha-meta-${process.pid}-${Date.now()}.db`);
process.env.INTERVIEW_MOCK = 'true';
process.env.SESSION_SECRET = 'segredo-de-teste';
process.env.ADMIN_USER = 'admin-teste';
process.env.ADMIN_PASSWORD = 'senha-teste';
process.env.META_APP_SECRET = 'segredo-do-app-de-teste';
process.env.META_WEBHOOK_VERIFY_TOKEN = 'token-de-verificacao-de-teste';
process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert/strict');

const db = require('../src/db');
const { migrar } = require('../src/db/migrate');
const { criarApp } = require('../src/server');
// O transporte e o Central Whats. O adaptador direto da Graph API
// (providers/whatsappMeta/metaWhatsapp.js) esta DORMENTE, sem importador — e por isso nao e
// exercitado aqui. Se um dia voltar a ser o caminho de envio, os testes dele voltam do
// historico, do commit que fez esta troca.
const transporte = require('../src/providers/centralWhats/centralWhats');
const job = require('../src/lib/campanhaWhatsapp');
const webhook = require('../src/routes/webhook_meta');
const { listarCidadesValidas } = require('../src/lib/cidades');
const { montarConteudoCampanhaWhatsapp, criarRouterCampanhaWhatsapp } = require('../src/routes/admin_campanha_whatsapp');
const { escapeHtml } = require('../src/views');

migrar();

const conn = () => db.getDb();
const exec = (sql, ...p) => conn().prepare(sql).run(...p);
const uma = (sql, ...p) => conn().prepare(sql).get(...p);
const todas = (sql, ...p) => conn().prepare(sql).all(...p);

function semRuido(fn) {
  const { log, warn, error } = console;
  const linhas = [];
  const cap = (...a) => linhas.push(a.join(' '));
  console.log = console.warn = console.error = cap;
  try {
    const r = fn();
    return r && typeof r.then === 'function' ? r.then((v) => ({ r: v, linhas })) : { r, linhas };
  } finally {
    Object.assign(console, { log, warn, error });
  }
}

const TEMPLATE = {
  nome_meta: 'confirmacao_cadastro_vaga_vm',
  idioma: 'pt_BR',
  variaveis: [
    { posicao: 1, campo: 'nome_primeiro' },
    { posicao: 2, campo: 'cargo_vaga' },
    { posicao: 3, campo: 'link_grupo_regiao' },
  ],
};

function zerar() {
  exec('DELETE FROM campanha_whatsapp_envios');
  exec('DELETE FROM campanhas_whatsapp');
  exec('DELETE FROM templates_whatsapp');
  exec('DELETE FROM regioes_grupos_whatsapp');
  exec('DELETE FROM whatsapp_opt_out');
  db.definirConfigBool(job.CHAVE_ATIVO, false);
}

function montarCenario({
  link = 'https://chat.whatsapp.com/ABC123',
  cidade = 'Joinville',
  botaoParametroFixo = null,
} = {}) {
  const tid = Number(
    exec(
      'INSERT INTO templates_whatsapp (nome_meta, idioma, categoria, variaveis, botao_parametro_fixo) VALUES (?, ?, ?, ?, ?)',
      TEMPLATE.nome_meta,
      TEMPLATE.idioma,
      'utility',
      JSON.stringify(TEMPLATE.variaveis),
      botaoParametroFixo,
    ).lastInsertRowid,
  );
  exec('INSERT INTO regioes_grupos_whatsapp (cidade, link_convite_grupo) VALUES (?, ?)', cidade, link);
  const cid = db.criarCampanhaWhatsapp({ nome: 'Convite grupo', templateId: tid, baseAlvo: 'ambos' });
  db.definirStatusCampanhaWhatsapp(cid, 'ativa');
  return { tid, cid, cidade };
}

const adicionar = (cid, telefone, nome, cidade) =>
  db.materializarEnvioCampanhaWhatsapp({
    campanhaId: cid,
    telefone,
    nome,
    origemTipo: 'talento',
    origemId: 1,
    cidade,
  });

const fila = (cid) => todas('SELECT * FROM campanha_whatsapp_envios WHERE campanha_id = ? ORDER BY id', cid);
const deps = (extra = {}) => ({ intervaloMs: 0, dormir: async () => {}, ...extra });

// ══════════════════ Schema ══════════════════

test('as cinco tabelas existem com as colunas esperadas', () => {
  const esperado = {
    // botao_parametro_fixo entrou com o botao estrutural exigido pela Graph API.
    templates_whatsapp: ['id', 'nome_meta', 'idioma', 'categoria', 'variaveis', 'botao_parametro_fixo', 'ativo', 'criado_em', 'atualizado_em'],
    // slug entrou com o link curto de convite (GET /grupo/:slug).
    regioes_grupos_whatsapp: ['id', 'cidade', 'link_convite_grupo', 'slug', 'ativo', 'criado_em', 'atualizado_em'],
    // tipo_mensagem/job_id/total_estimado entraram na extensao de dois tipos de campanha.
    campanhas_whatsapp: ['id', 'nome', 'template_id', 'base_alvo', 'tipo_mensagem', 'job_id', 'total_estimado', 'criterios_json', 'status', 'criado_em', 'iniciada_em', 'concluida_em'],
    campanha_whatsapp_envios: ['id', 'campanha_id', 'telefone', 'nome', 'origem_tipo', 'origem_id', 'cidade', 'status', 'wamid', 'enviado_em', 'erro', 'tentativas', 'criado_em'],
    whatsapp_opt_out: ['telefone', 'origem', 'criado_em'],
  };
  for (const [tabela, colunas] of Object.entries(esperado)) {
    const reais = todas('SELECT * FROM pragma_table_info(?)', tabela).map((c) => c.name);
    assert.deepEqual(reais, colunas, tabela);
  }
});

test('os CHECK barram valores invalidos', () => {
  zerar();
  // Categoria fora das tres que a Meta reconhece: escolher errado e motivo de rejeicao la.
  assert.throws(() =>
    exec("INSERT INTO templates_whatsapp (nome_meta, categoria, variaveis) VALUES ('t','promocional','[]')"));
  // Status fora do enum da fila.
  const { cid } = montarCenario();
  assert.throws(() =>
    exec("INSERT INTO campanha_whatsapp_envios (campanha_id,telefone,origem_tipo,status) VALUES (?, '5547999582500','talento','pendurado')", cid));
});

test('UNIQUE(campanha_id, telefone): a mesma pessoa entra UMA vez', () => {
  zerar();
  const { cid } = montarCenario();
  assert.equal(adicionar(cid, '5547999582500', 'Ana', 'Joinville'), 1);
  // No WhatsApp, duplicata e denuncia, e denuncia custa o numero.
  assert.equal(adicionar(cid, '5547999582500', 'Ana', 'Joinville'), 0);
  assert.equal(fila(cid).length, 1);
});

test('migrate (Incremento 12): campanhas_whatsapp com CHECK antigo em tipo_mensagem e recriada sem CHECK, preservando linhas', () => {
  zerar();
  // Simula o estado de um banco criado ANTES do Incremento 12 (CHECK restrito a
  // convite_grupo/divulgacao_vaga). aplicarSchema() (CREATE TABLE IF NOT EXISTS) nunca toca
  // uma tabela ja existente, entao o unico jeito de exercitar a migracao e recriar essa
  // tabela a mao com o schema ANTIGO antes de chamar migrar() de novo.
  exec('PRAGMA foreign_keys = OFF');
  exec('DROP TABLE campanhas_whatsapp');
  exec(`
    CREATE TABLE campanhas_whatsapp (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      nome         TEXT NOT NULL,
      template_id  INTEGER NOT NULL REFERENCES templates_whatsapp(id),
      base_alvo    TEXT NOT NULL CHECK (base_alvo IN ('applications', 'talentos', 'ambos')),
      tipo_mensagem TEXT NOT NULL DEFAULT 'convite_grupo'
                     CHECK (tipo_mensagem IN ('convite_grupo', 'divulgacao_vaga')),
      job_id       INTEGER REFERENCES jobs(id),
      total_estimado INTEGER,
      criterios_json TEXT,
      status       TEXT NOT NULL DEFAULT 'rascunho'
                     CHECK (status IN ('rascunho', 'ativa', 'pausada', 'concluida')),
      criado_em    TEXT NOT NULL DEFAULT (datetime('now')),
      iniciada_em  TEXT,
      concluida_em TEXT
    );
  `);
  exec('PRAGMA foreign_keys = ON');

  const { tid } = montarCenario();
  // Confirma que o estado simulado E o antigo: 'status_candidatura' tem que ser recusado
  // AGORA, antes da migracao rodar — senao o teste provaria uma migracao que nao fez nada.
  assert.throws(() =>
    exec("INSERT INTO campanhas_whatsapp (nome, template_id, base_alvo, tipo_mensagem) VALUES ('x', ?, 'ambos', 'status_candidatura')", tid));

  const existente = exec(
    "INSERT INTO campanhas_whatsapp (nome, template_id, base_alvo, tipo_mensagem) VALUES ('Campanha pre-existente', ?, 'ambos', 'convite_grupo')",
    tid,
  ).lastInsertRowid;

  migrar(); // idempotente — chamada de novo aqui simula o proximo boot apos o deploy

  // A linha pre-existente sobreviveu a recriacao da tabela.
  const linha = uma('SELECT * FROM campanhas_whatsapp WHERE id = ?', existente);
  assert.equal(linha.nome, 'Campanha pre-existente');
  assert.equal(linha.tipo_mensagem, 'convite_grupo');

  // E agora 'status_candidatura' e aceito — o CHECK antigo sumiu.
  assert.doesNotThrow(() =>
    exec("INSERT INTO campanhas_whatsapp (nome, template_id, base_alvo, tipo_mensagem) VALUES ('y', ?, 'ambos', 'status_candidatura')", tid));

  // base_alvo e status continuam protegidos — so tipo_mensagem perdeu o CHECK.
  assert.throws(() =>
    exec("INSERT INTO campanhas_whatsapp (nome, template_id, base_alvo, tipo_mensagem) VALUES ('z', ?, 'base_invalida', 'convite_grupo')", tid));
});

test('migrate: campanhas_whatsapp ja sem CHECK (schema aplicado do zero) nao dispara a recriacao de novo', () => {
  zerar();
  const { linhas } = semRuido(() => migrar());
  assert.equal(linhas.some((l) => l.includes('recriada sem CHECK')), false);
});

// ══════════════════ Transporte em mock ══════════════════

test('mock e o DEFAULT quando a variavel esta ausente', () => {
  const original = process.env.META_CAMPANHA_MOCK;
  delete process.env.META_CAMPANHA_MOCK;
  try {
    // A ausencia nao pode significar "pode enviar": cada mensagem real custa dinheiro e conta
    // para a qualidade do numero. O nome da variavel continua citando META de proposito — ela
    // e sobre a intencao de simular o disparo, nao sobre o transporte.
    assert.equal(transporte.modoMock(), true);
    process.env.META_CAMPANHA_MOCK = 'true';
    assert.equal(transporte.modoMock(), true);
    process.env.META_CAMPANHA_MOCK = 'false';
    assert.equal(transporte.modoMock(), false);
  } finally {
    if (original === undefined) delete process.env.META_CAMPANHA_MOCK;
    else process.env.META_CAMPANHA_MOCK = original;
  }
});

test('mock NAO faz chamada de rede e devolve wamid deterministico', async () => {
  let chamou = 0;
  const httpClient = async () => {
    chamou += 1;
    throw new Error('a rede nao pode ser tocada em mock');
  };
  const { r: a } = await semRuido(() =>
    transporte.enviarTemplate({ telefone: '5547999582500', template: TEMPLATE, variaveis: ['Ana', 'SDR', 'x'], httpClient }));
  const { r: b } = await semRuido(() =>
    transporte.enviarTemplate({ telefone: '5547999582500', template: TEMPLATE, variaveis: ['Ana', 'SDR', 'x'], httpClient }));

  assert.equal(chamou, 0, 'nenhuma chamada de rede em mock');
  assert.equal(a.mock, true);
  assert.match(a.wamid, /^mock-/, 'o prefixo evita casar com id real do Central Whats');
  // Deterministico: rodar o ciclo duas vezes nao inventa duas mensagens diferentes.
  assert.equal(a.wamid, b.wamid);
});

test('mock nao envia mesmo com credenciais do Central Whats presentes', async () => {
  // O kill-switch tem que vencer a configuracao completa: ter as tres variaveis certas nao
  // pode, sozinho, virar permissao de disparo.
  const antes = {
    base: process.env.CENTRALWHATS_BASE_URL,
    inst: process.env.CENTRALWHATS_INSTANCE_ID,
    key: process.env.CENTRALWHATS_API_KEY,
  };
  process.env.CENTRALWHATS_BASE_URL = 'https://exemplo-invalido.local';
  process.env.CENTRALWHATS_INSTANCE_ID = 'instancia-de-teste';
  process.env.CENTRALWHATS_API_KEY = 'chave-de-teste';
  try {
    assert.deepEqual(transporte.credenciaisFaltando(), []);
    let chamou = 0;
    const { r } = await semRuido(() =>
      transporte.enviarTemplate({
        telefone: '5547999582500',
        template: TEMPLATE,
        variaveis: ['Ana'],
        httpClient: async () => { chamou += 1; throw new Error('a rede nao pode ser tocada em mock'); },
      }));
    assert.equal(chamou, 0);
    assert.equal(r.mock, true);
  } finally {
    for (const [k, v] of [['CENTRALWHATS_BASE_URL', antes.base], ['CENTRALWHATS_INSTANCE_ID', antes.inst], ['CENTRALWHATS_API_KEY', antes.key]]) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
});

test('credenciaisFaltando cobra as CENTRALWHATS_*, nao as META_*', () => {
  // O painel imprime esta lista como pendencia. Cobrar a variavel errada manda o operador
  // configurar o que nao e mais usado.
  //
  // As tres sao apagadas e restauradas aqui de proposito: o teste nao pode depender de o .env
  // da maquina ter (ou nao ter) as variaveis preenchidas.
  const chaves = ['CENTRALWHATS_BASE_URL', 'CENTRALWHATS_INSTANCE_ID', 'CENTRALWHATS_API_KEY'];
  const antes = chaves.map((k) => [k, process.env[k]]);
  for (const k of chaves) delete process.env[k];
  try {
    assert.deepEqual(transporte.credenciaisFaltando(), chaves);
    // Uma so preenchida: as outras duas continuam sendo cobradas.
    process.env.CENTRALWHATS_BASE_URL = 'https://exemplo-invalido.local';
    assert.deepEqual(transporte.credenciaisFaltando(), ['CENTRALWHATS_INSTANCE_ID', 'CENTRALWHATS_API_KEY']);
  } finally {
    for (const [k, v] of antes) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
});

test('o log do mock mascara o telefone', async () => {
  const { linhas } = await semRuido(() =>
    transporte.enviarTemplate({ telefone: '5547999582500', template: TEMPLATE, variaveis: [] }));
  const tudo = linhas.join('\n');
  assert.doesNotMatch(tudo, /5547999582500/, 'numero completo vazou para o log');
  assert.match(tudo, /5547\*+2500/);
});

test('o payload segue o formato do Central Whats, com vars POSICIONAIS', () => {
  const p = transporte.montarPayload({
    telefone: '5547999582500',
    template: TEMPLATE,
    variaveis: ['Ana', 'Vendedor', 'https://chat.whatsapp.com/X'],
  });
  assert.equal(p.type, 'template');
  assert.equal(p.to, '5547999582500');
  assert.equal(p.template.name, TEMPLATE.nome_meta);
  // `vars` e mapa FLAT, e a chave E o {{n}} do template — a Meta nao tem variavel nomeada, e
  // a ordem que o job resolve vira "1","2","3" aqui.
  assert.deepEqual(p.vars, {
    1: 'Ana',
    2: 'Vendedor',
    3: 'https://chat.whatsapp.com/X',
  });
  // Nada do formato da Graph API sobreviveu.
  assert.equal(p.messaging_product, undefined);
  assert.equal(p.recipient_type, undefined);
  assert.equal(p.template.components, undefined);
});

test('o payload leva language, lido de template.idioma (Incremento 14)', () => {
  // Ate o Incremento 14, o payload NAO levava language de proposito — um envio real de teste
  // (nova_vaga_v2, ETAPA A) provou que o Central Whats recusa template nao sincronizado
  // pedindo EXPLICITAMENTE por idioma. Ver o comentario extenso em
  // centralWhats.js:montarPayload sobre a suposicao do nome do campo (nao confirmada).
  const p = transporte.montarPayload({
    telefone: '5547999582500',
    template: { ...TEMPLATE, idioma: 'pt_BR' },
    variaveis: ['Ana'],
  });
  assert.equal(p.template.language, 'pt_BR');
  assert.deepEqual(Object.keys(p.template).sort(), ['language', 'name']);
});

test('o payload NAO leva language quando template.idioma esta ausente/vazio — chave omitida, nao string vazia', () => {
  for (const idioma of [undefined, null, '', '   ']) {
    const p = transporte.montarPayload({
      telefone: '5547999582500',
      template: { ...TEMPLATE, idioma },
      variaveis: ['Ana'],
    });
    assert.equal('language' in p.template, false, `idioma ${JSON.stringify(idioma)} nao podia gerar language`);
    assert.deepEqual(Object.keys(p.template), ['name']);
  }
});

// ══════════════════ forcarEnvioReal (ETAPA B, envio avulso de teste) ══════════════════

test('forcarEnvioReal=true: chama a rede mesmo com META_CAMPANHA_MOCK=true', async () => {
  const original = process.env.META_CAMPANHA_MOCK;
  const antesCred = {
    base: process.env.CENTRALWHATS_BASE_URL,
    inst: process.env.CENTRALWHATS_INSTANCE_ID,
    key: process.env.CENTRALWHATS_API_KEY,
  };
  process.env.META_CAMPANHA_MOCK = 'true';
  process.env.CENTRALWHATS_BASE_URL = 'https://exemplo-invalido.local';
  process.env.CENTRALWHATS_INSTANCE_ID = 'instancia-de-teste';
  process.env.CENTRALWHATS_API_KEY = 'chave-de-teste';
  try {
    let chamadas = 0;
    let urlChamada = null;
    const httpClient = async (url) => {
      chamadas += 1;
      urlChamada = url;
      return { ok: true, json: async () => ({ wa_message_id: 'wamid-real-forcado' }) };
    };
    const { wamid, mock } = await transporte.enviarTemplate({
      telefone: '5547999582500',
      template: TEMPLATE,
      variaveis: ['Ana'],
      httpClient,
      forcarEnvioReal: true,
    });
    // O KILL-SWITCH esta ligado (META_CAMPANHA_MOCK=true) e mesmo assim a rede foi chamada:
    // e exatamente o furo que este parametro existe para abrir, so para ESTA chamada.
    assert.equal(chamadas, 1, 'a rede TEM que ser chamada com forcarEnvioReal');
    assert.match(urlChamada, /\/api\/instances\//);
    assert.equal(mock, false);
    assert.equal(wamid, 'wamid-real-forcado');
  } finally {
    if (original === undefined) delete process.env.META_CAMPANHA_MOCK;
    else process.env.META_CAMPANHA_MOCK = original;
    for (const [k, v] of [
      ['CENTRALWHATS_BASE_URL', antesCred.base],
      ['CENTRALWHATS_INSTANCE_ID', antesCred.inst],
      ['CENTRALWHATS_API_KEY', antesCred.key],
    ]) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
});

test('forcarEnvioReal ausente/false: comportamento mock de sempre, SEM chamar a rede (regressao)', async () => {
  const original = process.env.META_CAMPANHA_MOCK;
  process.env.META_CAMPANHA_MOCK = 'true';
  try {
    let chamadas = 0;
    const httpClient = async () => {
      chamadas += 1;
      throw new Error('a rede nao pode ser tocada em mock');
    };

    const { r: semParametro } = await semRuido(() =>
      transporte.enviarTemplate({ telefone: '5547999582500', template: TEMPLATE, variaveis: ['Ana'], httpClient }));
    const { r: comFalseExplicito } = await semRuido(() =>
      transporte.enviarTemplate({
        telefone: '5547999582500', template: TEMPLATE, variaveis: ['Ana'], httpClient, forcarEnvioReal: false,
      }));

    // Nenhuma chamada existente no projeto passa forcarEnvioReal — este teste prova que a
    // ausencia do parametro (job de disparo real) se comporta EXATAMENTE como antes.
    assert.equal(chamadas, 0, 'nenhuma chamada de rede sem forcarEnvioReal');
    assert.equal(semParametro.mock, true);
    assert.equal(comFalseExplicito.mock, true);
    assert.equal(semParametro.wamid, comFalseExplicito.wamid, 'mesmo wamid deterministico dos dois jeitos de "nao forcar"');
  } finally {
    if (original === undefined) delete process.env.META_CAMPANHA_MOCK;
    else process.env.META_CAMPANHA_MOCK = original;
  }
});

test('forcarEnvioReal=true SEM credenciais: lanca, nao finge sucesso nem cai no mock', async () => {
  const original = process.env.META_CAMPANHA_MOCK;
  const chaves = ['CENTRALWHATS_BASE_URL', 'CENTRALWHATS_INSTANCE_ID', 'CENTRALWHATS_API_KEY'];
  const antes = chaves.map((k) => [k, process.env[k]]);
  process.env.META_CAMPANHA_MOCK = 'true';
  for (const k of chaves) delete process.env[k];
  try {
    let chamadas = 0;
    await assert.rejects(
      () => transporte.enviarTemplate({
        telefone: '5547999582500',
        template: TEMPLATE,
        variaveis: ['Ana'],
        httpClient: async () => {
          chamadas += 1;
          return { ok: true, json: async () => ({}) };
        },
        forcarEnvioReal: true,
      }),
      /Credenciais do Central Whats ausentes/,
    );
    assert.equal(chamadas, 0, 'sem credenciais, nem tenta chamar a rede');
  } finally {
    if (original === undefined) delete process.env.META_CAMPANHA_MOCK;
    else process.env.META_CAMPANHA_MOCK = original;
    for (const [k, v] of antes) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
});

// ══════════════════ Botao estrutural do template ══════════════════
//
// O template aprovado tem um botao de URL DINAMICA, e a Graph API recusa com 131008
// ("Button at index 0 of type Url requires a parameter") todo envio que nao mande o parametro
// dele. Nao e caso de borda: sem isso, 100% dos envios da campanha falham. Ja falhou de
// verdade contra a API, com este erro.

test('botao: com botao_parametro_fixo preenchido, vars ganha a chave button0', () => {
  const p = transporte.montarPayload({
    telefone: '5547999582500',
    template: { ...TEMPLATE, botao_parametro_fixo: 'indisponivel' },
    variaveis: ['Ana', 'Vendedor', 'https://chat.whatsapp.com/X'],
  });

  // A exigencia da Meta nao mudou com o transporte; mudou a FORMA. Era um componente
  // {type:'button', sub_type:'url', index:'0'}; agora e uma chave a mais no mesmo mapa flat.
  assert.equal(p.vars.button0, 'indisponivel');
  assert.deepEqual(p.vars, {
    1: 'Ana',
    2: 'Vendedor',
    3: 'https://chat.whatsapp.com/X',
    button0: 'indisponivel',
  });
});

test('botao: sem botao_parametro_fixo, a chave button0 nem aparece', () => {
  // O erro simetrico do 131008: mandar botao para um template que nao tem tambem e rejeitado.
  // O default tem que ser "nao manda" — um template futuro sem botao nao pode ganhar um por
  // heranca do vizinho. E precisa ser AUSENCIA da chave, nao string vazia: "button0":"" ainda
  // e um botao declarado.
  for (const valor of [undefined, null, '', '   ']) {
    const p = transporte.montarPayload({
      telefone: '5547999582500',
      template: { ...TEMPLATE, botao_parametro_fixo: valor },
      variaveis: ['Ana', 'Vendedor', 'x'],
    });
    assert.equal('button0' in p.vars, false, `valor ${JSON.stringify(valor)} nao podia gerar botao`);
    assert.deepEqual(Object.keys(p.vars), ['1', '2', '3']);
  }
});

test('botao: o valor do banco chega ate o adaptador no envio real', async () => {
  zerar();
  db.definirConfigBool(job.CHAVE_ATIVO, true);
  // O job le a coluna junto com a linha da fila; se o SELECT nao a trouxesse, o parametro
  // chegaria undefined aqui e a campanha inteira falharia com 131008 em producao.
  const { cid } = montarCenario({ botaoParametroFixo: 'indisponivel' });
  adicionar(cid, '5547999582500', 'Ana Paula', 'Joinville');

  const recebido = [];
  await semRuido(() =>
    job.processarCicloCampanhaWhatsapp(deps({
      enviarTemplate: async (a) => { recebido.push(a); return { wamid: 'w' }; },
    })));

  assert.equal(recebido[0].template.botao_parametro_fixo, 'indisponivel');
});

test('botao: template com a coluna NULL nao recebe botao no envio real', async () => {
  zerar();
  db.definirConfigBool(job.CHAVE_ATIVO, true);
  const { cid } = montarCenario();
  adicionar(cid, '5547999582500', 'Ana Paula', 'Joinville');

  const recebido = [];
  await semRuido(() =>
    job.processarCicloCampanhaWhatsapp(deps({
      enviarTemplate: async (a) => { recebido.push(a); return { wamid: 'w' }; },
    })));

  assert.equal(recebido[0].template.botao_parametro_fixo, null);
  const p = transporte.montarPayload({ telefone: '5547999582500', template: recebido[0].template, variaveis: [] });
  assert.equal('button0' in p.vars, false);
});

// ══════════════════ parametrosBotao: botao dinamico POR ENVIO (capacidade) ══════════════════
//
// Estes testes cobrem a CAPACIDADE de montarPayload/enviarTemplate isolada (sem tocar rota
// nem ciclo real). A integracao com os dois chamadores de verdade — convite_grupo_vagas_vm,
// o primeiro template aprovado com botao de URL dinamica — tem os proprios testes mais
// abaixo: "POST /enviar-teste: convite_grupo_vagas_vm..." (envio avulso) e "ciclo: convite_grupo
// com botao dinamico..." (campanha real).

test('parametrosBotao: omitido -> comportamento identico ao de antes (regressao)', () => {
  // Nenhum chamador existente passa parametrosBotao. O payload tem que sair BYTE a BYTE
  // igual ao que os testes de "botao estrutural" acima ja verificam.
  const semParametro = transporte.montarPayload({
    telefone: '5547999582500',
    template: { ...TEMPLATE, botao_parametro_fixo: 'indisponivel' },
    variaveis: ['Ana'],
  });
  const comUndefined = transporte.montarPayload({
    telefone: '5547999582500',
    template: { ...TEMPLATE, botao_parametro_fixo: 'indisponivel' },
    variaveis: ['Ana'],
    parametrosBotao: undefined,
  });
  assert.deepEqual(semParametro, comUndefined);
  assert.equal(semParametro.vars.button0, 'indisponivel');
});

test('parametrosBotao: preenchido sobrescreve o button0 que botao_parametro_fixo teria posto', () => {
  const p = transporte.montarPayload({
    telefone: '5547999582500',
    // botao_parametro_fixo continua 'indisponivel' (o botao estrutural morto) — o valor de
    // VERDADE (por destinatario) chega por parametrosBotao e tem que ganhar.
    template: { ...TEMPLATE, botao_parametro_fixo: 'indisponivel' },
    variaveis: ['Ana'],
    parametrosBotao: { 0: 'sao-paulo' },
  });
  assert.equal(p.vars.button0, 'sao-paulo');
});

test('parametrosBotao: funciona tambem quando o template NAO tem botao_parametro_fixo', () => {
  const p = transporte.montarPayload({
    telefone: '5547999582500',
    template: { ...TEMPLATE, botao_parametro_fixo: null },
    variaveis: ['Ana'],
    parametrosBotao: { 0: 'joinville' },
  });
  assert.equal(p.vars.button0, 'joinville');
});

test('parametrosBotao: indice vazio/null nao sobrescreve (nao apaga um botao_parametro_fixo valido)', () => {
  const p = transporte.montarPayload({
    telefone: '5547999582500',
    template: { ...TEMPLATE, botao_parametro_fixo: 'indisponivel' },
    variaveis: ['Ana'],
    parametrosBotao: { 0: '' },
  });
  assert.equal(p.vars.button0, 'indisponivel');
});

test('parametrosBotao: enviarTemplate aceita o parametro sem lancar (mock, sem rede)', async () => {
  const { r } = await semRuido(() =>
    transporte.enviarTemplate({
      telefone: '5547999582500',
      template: { ...TEMPLATE, botao_parametro_fixo: null },
      variaveis: ['Ana'],
      parametrosBotao: { 0: 'joinville' },
    }));
  // Em mock nao ha payload observavel de fora (nao ha chamada de rede) — a garantia aqui e
  // so que passar parametrosBotao nao lanca nem muda o contrato de retorno.
  assert.equal(r.mock, true);
  assert.ok(r.wamid);
});

// ══════════════════ Language explicito no payload (ETAPA B, Incremento 14) ══════════════════
//
// Ate aqui o payload nao levava idioma nenhum, por decisao deliberada — um envio real de
// teste (nova_vaga_v2, ETAPA A) provou o pressuposto errado: o Central Whats recusou com
// HTTP 400 pedindo "informe o idioma". Ver o comentario extenso em
// centralWhats.js:montarPayload sobre a suposicao do NOME do campo (nao confirmada).

test('language: o job (confirmacao_cadastro_vaga_vm, template que ja funciona hoje) monta payload com language incluido, sem quebrar', async () => {
  // Regressao: prova que o template QUE JA FUNCIONA em producao continua montando um
  // payload valido depois desta mudanca — a coluna templates_whatsapp.idioma ja e lida pelo
  // JOIN da fila (sqlite.js:listarPendentesCampanhaWhatsapp), entao nao precisou de consulta
  // nova nenhuma.
  zerar();
  db.definirConfigBool(job.CHAVE_ATIVO, true);
  const { cid } = montarCenario(); // TEMPLATE.idioma = 'pt_BR' (fixture no topo do arquivo)
  adicionar(cid, '5547999582500', 'Ana Paula', 'Joinville');

  const recebido = [];
  await semRuido(() =>
    job.processarCicloCampanhaWhatsapp(deps({
      enviarTemplate: async (a) => { recebido.push(a); return { wamid: 'w' }; },
    })));

  assert.equal(recebido[0].template.idioma, 'pt_BR');
  const p = transporte.montarPayload({ telefone: '5547999582500', template: recebido[0].template, variaveis: ['Ana', '', 'https://chat.whatsapp.com/ABC123'] });
  assert.equal(p.template.name, TEMPLATE.nome_meta);
  assert.equal(p.template.language, 'pt_BR');
});

// ══════════════════ Erros do Central Whats ══════════════════

test('classificacao: cada status do Central Whats cai na categoria certa', () => {
  const c = (m) => transporte.classificarErroCentralWhats(new Error(m)).categoria;

  // ── configuracao: aborta o ciclo e NAO marca ninguem ──
  // 401 chave invalida/revogada, 403 rota fora da lista branca, 404 instancia errada.
  // Nenhum muda conforme o destinatario. Como 'terminal', uma chave revogada marcaria a fila
  // inteira como falha PERMANENTE (o UNIQUE impede rematerializar) — e essa e a razao de a
  // classificacao divergir da lista original, que punha os tres em terminal.
  assert.equal(c('Central Whats retornou HTTP 401 — {"error":"unauthorized"}'), 'configuracao');
  assert.equal(c('Central Whats retornou HTTP 403 — {"error":"forbidden"}'), 'configuracao');
  assert.equal(c('Central Whats retornou HTTP 404 — {"error":"instance not found"}'), 'configuracao');
  assert.equal(c('Credenciais do Central Whats ausentes: CENTRALWHATS_API_KEY.'), 'configuracao');

  // ── terminal: marca AQUELE envio e segue ──
  // 400 payload/template errado (inclui telefone que a Meta recusa, o unico que varia por
  // pessoa); 422 provider nao suporta o tipo.
  assert.equal(c('Central Whats retornou HTTP 400 — {"error":"invalid template"}'), 'terminal');
  assert.equal(c('Central Whats retornou HTTP 422 — {"error":"unsupported"}'), 'terminal');

  // ── retentavel: conta tentativa ate o teto ──
  // 502 e a Meta recusando por tras do Central Whats; 5xx e o Central Whats fora do ar.
  assert.equal(c('Central Whats retornou HTTP 502 — {"error":"meta refused"}'), 'retentavel');
  assert.equal(c('Central Whats retornou HTTP 500 — erro interno'), 'retentavel');
  assert.equal(c('Central Whats retornou HTTP 429 — rate limit'), 'retentavel');
  assert.equal(c('Falha de rede ao chamar o Central Whats: ETIMEDOUT'), 'retentavel');
  // Desconhecido -> retentavel, pela assimetria de custo (perder a pessoa e definitivo).
  assert.equal(c('coisa nunca vista'), 'retentavel');
});

test('classificacao: o teto so existe para retentavel', () => {
  const t = (m) => transporte.classificarErroCentralWhats(new Error(m));
  // 'configuracao' e 'terminal' com teto null: o job usa isso para nao contar tentativa.
  assert.equal(t('Central Whats retornou HTTP 401 — x').teto, null);
  assert.equal(t('Central Whats retornou HTTP 400 — x').teto, null);
  assert.equal(t('Central Whats retornou HTTP 502 — x').teto, transporte.TETO_RETENTAVEL);
});

test('wamid vem de wa_message_id, e nao do id do Central Whats', () => {
  // O `id` e a chave do registro LA; a coluna wamid sempre guardou o identificador da
  // mensagem no WhatsApp. Trocar um pelo outro so apareceria muito depois, ao cruzar com
  // qualquer coisa do lado da Meta.
  assert.equal(
    transporte.extrairWamid({ id: 'uuid-central-whats', wa_message_id: 'wamid.ABC', status: 'sent', type: 'template' }),
    'wamid.ABC',
  );
  // Corpo sem o campo, ou ilegivel, NAO pode virar excecao: a mensagem ja foi aceita, e
  // lancar aqui faria o job retentar alguem que VAI receber — duplicata e denuncia.
  assert.equal(transporte.extrairWamid({ id: 'so-o-id' }), null);
  assert.equal(transporte.extrairWamid(null), null);
  assert.equal(transporte.extrairWamid('nao e objeto'), null);
});

test('envio real (httpClient injetado): URL, header e corpo do Central Whats', async () => {
  const antes = {
    mock: process.env.META_CAMPANHA_MOCK,
    base: process.env.CENTRALWHATS_BASE_URL,
    inst: process.env.CENTRALWHATS_INSTANCE_ID,
    key: process.env.CENTRALWHATS_API_KEY,
  };
  process.env.META_CAMPANHA_MOCK = 'false';
  // Com barra no fim de proposito: '//' no caminho ja rendeu 404 em provedor demais.
  process.env.CENTRALWHATS_BASE_URL = 'https://exemplo-invalido.local/';
  process.env.CENTRALWHATS_INSTANCE_ID = 'ea46ca72-0000-0000-0000-000000000000';
  process.env.CENTRALWHATS_API_KEY = 'chave-de-teste';
  try {
    const chamadas = [];
    const httpClient = async (url, opcoes) => {
      chamadas.push({ url, opcoes });
      return {
        ok: true,
        status: 201,
        json: async () => ({ id: 'uuid-cw', wa_message_id: 'wamid.XYZ', status: 'sent', type: 'template' }),
      };
    };

    const { r } = await semRuido(() =>
      transporte.enviarTemplate({
        telefone: '5547999582500',
        template: { ...TEMPLATE, botao_parametro_fixo: 'indisponivel' },
        variaveis: ['Ana', 'SDR', 'https://chat.whatsapp.com/X'],
        httpClient,
      }));

    assert.equal(chamadas.length, 1);
    assert.equal(
      chamadas[0].url,
      'https://exemplo-invalido.local/api/instances/ea46ca72-0000-0000-0000-000000000000/messages',
    );
    assert.equal(chamadas[0].opcoes.method, 'POST');
    assert.equal(chamadas[0].opcoes.headers.Authorization, 'Bearer chave-de-teste');
    assert.deepEqual(JSON.parse(chamadas[0].opcoes.body), {
      type: 'template',
      to: '5547999582500',
      template: { name: 'confirmacao_cadastro_vaga_vm', language: 'pt_BR' },
      vars: { 1: 'Ana', 2: 'SDR', 3: 'https://chat.whatsapp.com/X', button0: 'indisponivel' },
    });
    assert.equal(r.mock, false);
    assert.equal(r.wamid, 'wamid.XYZ');
  } finally {
    for (const [k, v] of [['META_CAMPANHA_MOCK', antes.mock], ['CENTRALWHATS_BASE_URL', antes.base], ['CENTRALWHATS_INSTANCE_ID', antes.inst], ['CENTRALWHATS_API_KEY', antes.key]]) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
});

test('envio real: HTTP de erro vira excecao com o status legivel na mensagem', async () => {
  // A classificacao le o status DA MENSAGEM do erro. Se o formato mudar sem o regex mudar
  // junto, tudo vira 'erro nao classificado' e nada mais aborta ciclo nenhum.
  const antes = { mock: process.env.META_CAMPANHA_MOCK, base: process.env.CENTRALWHATS_BASE_URL, inst: process.env.CENTRALWHATS_INSTANCE_ID, key: process.env.CENTRALWHATS_API_KEY };
  process.env.META_CAMPANHA_MOCK = 'false';
  process.env.CENTRALWHATS_BASE_URL = 'https://exemplo-invalido.local';
  process.env.CENTRALWHATS_INSTANCE_ID = 'instancia-de-teste';
  process.env.CENTRALWHATS_API_KEY = 'chave-de-teste';
  try {
    const httpClient = async () => ({ ok: false, status: 401, text: async () => '{"error":"invalid api key"}' });
    await assert.rejects(
      () => transporte.enviarTemplate({ telefone: '5547999582500', template: TEMPLATE, variaveis: ['Ana'], httpClient }),
      (err) => {
        assert.match(err.message, /HTTP 401/);
        assert.equal(transporte.classificarErroCentralWhats(err).categoria, 'configuracao');
        return true;
      },
    );
  } finally {
    for (const [k, v] of [['META_CAMPANHA_MOCK', antes.mock], ['CENTRALWHATS_BASE_URL', antes.base], ['CENTRALWHATS_INSTANCE_ID', antes.inst], ['CENTRALWHATS_API_KEY', antes.key]]) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
});

// ══════════════════ Observabilidade do corpo de erro (ETAPA B, Incremento 14 - Parte 2) ══════════════════
//
// Ate aqui detalheDoErro() cortava o corpo em MAX_DETALHE_ERRO (300 chars) ANTES de
// qualquer log — nao existia, em lugar nenhum, um registro do corpo completo que o Central
// Whats devolveu. Isso cegou o diagnostico da ETAPA A. O corte pro chamador/UI continua
// existindo (nao pode virar uma mensagem de erro gigante na tela) — so o log do servidor
// passou a receber o texto inteiro.

test('detalheDoErro: loga o corpo INTEIRO no servidor, mas o erro que sobe pro chamador continua truncado em 300 chars', async () => {
  const antes = { mock: process.env.META_CAMPANHA_MOCK, base: process.env.CENTRALWHATS_BASE_URL, inst: process.env.CENTRALWHATS_INSTANCE_ID, key: process.env.CENTRALWHATS_API_KEY };
  process.env.META_CAMPANHA_MOCK = 'false';
  process.env.CENTRALWHATS_BASE_URL = 'https://exemplo-invalido.local';
  process.env.CENTRALWHATS_INSTANCE_ID = 'instancia-de-teste';
  process.env.CENTRALWHATS_API_KEY = 'chave-de-teste';

  // NAO usa semRuido() aqui: aquele helper restaura o console no `finally` LOGO apos chamar
  // fn(), de forma sincrona — o que so captura console.* chamado ANTES do primeiro `await`
  // interno de fn. O console.error de detalheDoErro() acontece DEPOIS do `await http(...)`
  // dentro de enviarTemplate, entao precisa de uma captura que so restaura o console depois
  // do await terminar de verdade.
  const { log, warn, error } = console;
  const linhas = [];
  console.log = console.warn = console.error = (...a) => linhas.push(a.join(' '));
  try {
    // Corpo fabricado bem maior que os 300 chars do corte (MAX_DETALHE_ERRO).
    const corpoCompleto = `{"error":"falha detalhada do Central Whats: ${'x'.repeat(400)}"}`;
    assert.ok(corpoCompleto.length > 300);
    const httpClient = async () => ({ ok: false, status: 400, text: async () => corpoCompleto });

    let erro = null;
    try {
      await transporte.enviarTemplate({ telefone: '5547999582500', template: TEMPLATE, variaveis: ['Ana'], httpClient });
    } catch (e) {
      erro = e;
    }

    // O log do servidor recebe o corpo INTEIRO, sem corte.
    const logComCorpo = linhas.find((l) => l.includes('[central-whats] corpo de erro completo:'));
    assert.ok(logComCorpo, 'esperava um log com o prefixo [central-whats] corpo de erro completo:');
    assert.ok(logComCorpo.includes(corpoCompleto), 'o log precisa conter o corpo INTEIRO, sem truncar');

    // O erro que sobe pro chamador/UI continua truncado em MAX_DETALHE_ERRO — sem mudanca de
    // comportamento externo.
    assert.ok(erro, 'esperava que o envio lancasse um erro');
    assert.ok(!erro.message.includes(corpoCompleto), 'a mensagem do erro NAO pode conter o corpo inteiro');
    assert.ok(erro.message.includes(corpoCompleto.slice(0, 300)), 'a mensagem do erro precisa conter o corpo truncado em 300 chars');
  } finally {
    Object.assign(console, { log, warn, error });
    for (const [k, v] of [['META_CAMPANHA_MOCK', antes.mock], ['CENTRALWHATS_BASE_URL', antes.base], ['CENTRALWHATS_INSTANCE_ID', antes.inst], ['CENTRALWHATS_API_KEY', antes.key]]) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
});

// ══════════════════ Job ══════════════════

test('kill-switch OFF: nao processa nada', async () => {
  zerar();
  const { cid } = montarCenario();
  adicionar(cid, '5547999582500', 'Ana', 'Joinville');

  let enviou = 0;
  const { r } = await semRuido(() =>
    job.processarCicloCampanhaWhatsapp(deps({ enviarTemplate: async () => { enviou += 1; return { wamid: 'x' }; } })));

  assert.equal(r.desativado, true);
  assert.equal(enviou, 0);
  assert.equal(fila(cid)[0].status, 'pendente');
});

test('fluxo feliz: envia, grava wamid e marca enviado', async () => {
  zerar();
  db.definirConfigBool(job.CHAVE_ATIVO, true);
  const { cid } = montarCenario();
  adicionar(cid, '5547999582500', 'Ana Paula', 'Joinville');

  const recebido = [];
  const { r } = await semRuido(() =>
    job.processarCicloCampanhaWhatsapp(deps({
      enviarTemplate: async (a) => { recebido.push(a); return { wamid: 'wamid-real-123' }; },
    })));

  assert.equal(r.enviados, 1);
  const linha = fila(cid)[0];
  assert.equal(linha.status, 'enviado');
  assert.equal(linha.wamid, 'wamid-real-123');
  // As tres variaveis, na ordem, com o link da praca resolvido.
  assert.deepEqual(recebido[0].variaveis, ['Ana', '', 'https://chat.whatsapp.com/ABC123']);
});

test('praca SEM link: falha SO daquele envio, o ciclo continua', async () => {
  zerar();
  db.definirConfigBool(job.CHAVE_ATIVO, true);
  const { cid } = montarCenario({ cidade: 'Joinville' });
  // Curitiba existe no enum mas nao tem link cadastrado neste cenario.
  adicionar(cid, '5541900000001', 'Sem Link', 'Curitiba');
  adicionar(cid, '5547999582500', 'Com Link', 'Joinville');

  const { r } = await semRuido(() =>
    job.processarCicloCampanhaWhatsapp(deps({ enviarTemplate: async () => ({ wamid: 'w' }) })));

  // Uma praca mal configurada nao pode impedir as outras.
  assert.equal(r.falhas, 1);
  assert.equal(r.enviados, 1);
  const linhas = fila(cid);
  const semLink = linhas.find((l) => l.cidade === 'Curitiba');
  assert.equal(semLink.status, 'falha');
  assert.match(semLink.erro, /sem link de grupo/);
  // E nao fica pendente para sempre reaparecendo em todo ciclo.
  assert.notEqual(semLink.status, 'pendente');
});

test('opt-out: marca opt_out e NAO envia', async () => {
  zerar();
  db.definirConfigBool(job.CHAVE_ATIVO, true);
  const { cid } = montarCenario();
  adicionar(cid, '5547999582500', 'Ana', 'Joinville');
  db.registrarOptOutWhatsapp('5547999582500', 'resposta_webhook');

  let enviou = 0;
  const { r } = await semRuido(() =>
    job.processarCicloCampanhaWhatsapp(deps({ enviarTemplate: async () => { enviou += 1; return { wamid: 'x' }; } })));

  assert.equal(enviou, 0, 'quem pediu para sair nao pode receber');
  assert.equal(r.optOut, 1);
  // 'opt_out' e nao 'falha': falha e problema tecnico, opt_out e vontade da pessoa.
  assert.equal(fila(cid)[0].status, 'opt_out');
});

test('erro de CONFIGURACAO aborta o ciclo sem marcar ninguem', async () => {
  zerar();
  db.definirConfigBool(job.CHAVE_ATIVO, true);
  const { cid } = montarCenario();
  for (let i = 0; i < 3; i += 1) adicionar(cid, `554790000000${i}`, `P${i}`, 'Joinville');

  let chamadas = 0;
  const { r } = await semRuido(() =>
    job.processarCicloCampanhaWhatsapp(deps({
      enviarTemplate: async () => { chamadas += 1; throw new Error('HTTP 401 — {"error":{"code":190}}'); },
    })));

  assert.equal(r.abortado, true);
  // Token invalido nao e falha deste destinatario: insistir nos outros so repete o erro.
  assert.equal(chamadas, 1);
  assert.equal(fila(cid).every((l) => l.status === 'pendente' && l.tentativas === 0), true);
});

test('retry: conta tentativa, fica pendente ate o teto, depois falha', async () => {
  zerar();
  db.definirConfigBool(job.CHAVE_ATIVO, true);
  const { cid } = montarCenario();
  adicionar(cid, '5547999582500', 'Ana', 'Joinville');

  const rodar = () =>
    semRuido(() => job.processarCicloCampanhaWhatsapp(deps({
      enviarTemplate: async () => { throw new Error('HTTP 429 — rate limit'); },
    })));

  for (let i = 1; i < transporte.TETO_RETENTAVEL; i += 1) {
    const { r } = await rodar();
    assert.equal(r.retentar, 1, `ciclo ${i}`);
    assert.equal(fila(cid)[0].status, 'pendente');
    assert.equal(fila(cid)[0].tentativas, i);
  }
  const { r } = await rodar();
  assert.equal(r.falhas, 1);
  assert.equal(fila(cid)[0].status, 'falha');
});

test('erro TERMINAL nao retenta', async () => {
  zerar();
  db.definirConfigBool(job.CHAVE_ATIVO, true);
  const { cid } = montarCenario();
  adicionar(cid, '5547999582500', 'Ana', 'Joinville');

  const { r } = await semRuido(() => job.processarCicloCampanhaWhatsapp(deps({
    enviarTemplate: async () => { throw new Error('HTTP 400 — {"error":{"code":131026}}'); },
  })));
  assert.equal(r.falhas, 1);
  assert.equal(fila(cid)[0].status, 'falha');
});

test('campanha PAUSADA nao sai da fila', async () => {
  zerar();
  db.definirConfigBool(job.CHAVE_ATIVO, true);
  const { cid } = montarCenario();
  adicionar(cid, '5547999582500', 'Ana', 'Joinville');
  db.definirStatusCampanhaWhatsapp(cid, 'pausada');

  let enviou = 0;
  await semRuido(() => job.processarCicloCampanhaWhatsapp(deps({
    enviarTemplate: async () => { enviou += 1; return { wamid: 'x' }; },
  })));
  assert.equal(enviou, 0, 'pausar precisa parar de verdade');
});

test('teto por ciclo e throttle ENTRE envios', async () => {
  zerar();
  db.definirConfigBool(job.CHAVE_ATIVO, true);
  const { cid } = montarCenario();
  for (let i = 0; i < 5; i += 1) adicionar(cid, `554790000${String(i).padStart(4, '0')}`, `P${i}`, 'Joinville');

  const pausas = [];
  const { r } = await semRuido(() => job.processarCicloCampanhaWhatsapp({
    porCiclo: 3,
    intervaloMs: 2000,
    dormir: async (ms) => pausas.push(ms),
    enviarTemplate: async () => ({ wamid: 'w' }),
  }));

  assert.equal(r.enviados, 3);
  // 3 envios = 2 pausas. Dormir depois do ultimo so atrasaria o fim do ciclo.
  assert.deepEqual(pausas, [2000, 2000]);
  assert.equal(todas("SELECT id FROM campanha_whatsapp_envios WHERE status='pendente'").length, 2);
});

test('atualizarStatusPorWamid NAO regride', () => {
  zerar();
  const { cid } = montarCenario();
  adicionar(cid, '5547999582500', 'Ana', 'Joinville');
  const id = fila(cid)[0].id;
  db.marcarEnvioWhatsappEnviado(id, 'wamid-x');

  assert.equal(db.atualizarStatusPorWamid('wamid-x', 'entregue'), 1);
  assert.equal(db.atualizarStatusPorWamid('wamid-x', 'lido'), 1);
  // A ordem dos eventos da Meta nao e garantida: um 'entregue' atrasado nao pode rebaixar um
  // 'lido' que ja chegou.
  assert.equal(db.atualizarStatusPorWamid('wamid-x', 'entregue'), 0);
  assert.equal(uma('SELECT status FROM campanha_whatsapp_envios WHERE id = ?', id).status, 'lido');
});

// ══════════════════ ETAPA B, Incremento 13: previa/disparo/job roteiam os 3 tipos ══════════════════

test('POST /previa: status_candidatura calcula publico via listarPublicoStatusCandidatura', async () => {
  zerarSeg();
  const j = vagaCom('Joinville');
  const aprovadoId = candidatura(j, 'Aprovado', '+55 47 90000-0700');
  const reprovadoId = candidatura(j, 'Reprovado', '+55 47 90000-0701');
  db.definirStatusRecrutador(aprovadoId, 'aprovado');
  db.definirStatusRecrutador(reprovadoId, 'reprovado');

  await comAdmin(async (base, h) => {
    const res = await fetch(`${base}/admin/campanhas-whatsapp/previa`, {
      method: 'POST',
      headers: { ...h, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams([
        ['tipo_mensagem', 'status_candidatura'],
        ['job_id', String(j)],
        ['status_recrutador', 'aprovado'],
      ]),
    });
    assert.equal(res.status, 200);
    const corpo = await res.json();
    assert.equal(corpo.ok, true);
    assert.equal(corpo.tipo, 'status_candidatura');
    assert.equal(corpo.total, 1);
  });
});

test('POST /previa: status_candidatura sem status marcado devolve erro JSON claro (nao 500)', async () => {
  zerarSeg();
  const j = vagaCom('Joinville');
  await comAdmin(async (base, h) => {
    const res = await fetch(`${base}/admin/campanhas-whatsapp/previa`, {
      method: 'POST',
      headers: { ...h, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams([['tipo_mensagem', 'status_candidatura'], ['job_id', String(j)]]),
    });
    assert.equal(res.status, 400);
    const corpo = await res.json();
    assert.equal(corpo.ok, false);
    assert.match(corpo.erro, /pelo menos um status/);
  });
});

test('POST /:id/disparar: materializa status_candidatura corretamente, SEM exigir link de grupo cadastrado', async () => {
  zerarSeg();
  const j = vagaCom('Joinville');
  const { tid } = montarCenario();
  // Nenhum link de grupo cadastrado pra Joinville nesta rodada — prova de que
  // status_candidatura nao depende disso (diferente de convite_grupo).
  exec('DELETE FROM regioes_grupos_whatsapp');
  const aprovadoId = candidatura(j, 'Aprovado', '+55 47 90000-0702');
  const reprovadoId = candidatura(j, 'Reprovado', '+55 47 90000-0703'); // fora do recorte pedido
  db.definirStatusRecrutador(aprovadoId, 'aprovado');
  db.definirStatusRecrutador(reprovadoId, 'reprovado');

  await comAdmin(async (base, h) => {
    await fetch(`${base}/admin/campanhas-whatsapp`, {
      method: 'POST',
      headers: { ...h, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams([
        ['nome', 'Situacao disparo'],
        ['template_id', String(tid)],
        ['tipo_mensagem', 'status_candidatura'],
        ['job_id', String(j)],
        ['status_recrutador', 'aprovado'],
      ]),
      redirect: 'manual',
    });
    const nova = uma("SELECT * FROM campanhas_whatsapp WHERE nome = 'Situacao disparo'");
    assert.ok(nova);
    assert.equal(nova.tipo_mensagem, 'status_candidatura');

    const res = await fetch(`${base}/admin/campanhas-whatsapp/${nova.id}/disparar`, {
      method: 'POST',
      headers: h,
      redirect: 'manual',
    });
    assert.equal(res.status, 302);
    assert.doesNotMatch(res.headers.get('location') || '', /erro=/);

    const filaLinhas = todas('SELECT * FROM campanha_whatsapp_envios WHERE campanha_id = ?', nova.id);
    assert.equal(filaLinhas.length, 1);
    assert.equal(filaLinhas[0].telefone, '5547900000702');
  });
});

test('job: processa uma campanha status_candidatura de ponta a ponta (transporte mockado), SEM exigir link de grupo', async () => {
  zerarSeg();
  db.definirConfigBool(job.CHAVE_ATIVO, true);
  const j = vagaCom('Joinville');
  const tid = Number(
    exec(
      "INSERT INTO templates_whatsapp (nome_meta, idioma, categoria, variaveis, ativo) VALUES (?, ?, 'utility', ?, 1)",
      TEMPLATE.nome_meta, TEMPLATE.idioma, JSON.stringify(TEMPLATE.variaveis),
    ).lastInsertRowid,
  );
  exec('DELETE FROM regioes_grupos_whatsapp'); // nenhum link cadastrado — nao pode bloquear

  const aprovadoId = candidatura(j, 'Aprovado', '+55 47 90000-0704');
  db.definirStatusRecrutador(aprovadoId, 'aprovado');

  const cid = db.criarCampanhaWhatsapp({
    nome: 'Job status_candidatura',
    templateId: tid,
    baseAlvo: 'ambos',
    tipoMensagem: 'status_candidatura',
    jobId: j,
    totalEstimado: 1,
    criterios: { statusList: ['aprovado'] },
  });
  const publicoCalc = publico.listarPublicoStatusCandidatura(j, ['aprovado']);
  assert.equal(publicoCalc.total, 1);
  db.materializarCampanhaWhatsapp(cid, publicoCalc.itens);
  db.definirStatusCampanhaWhatsapp(cid, 'ativa');

  const recebido = [];
  const { r } = await semRuido(() =>
    job.processarCicloCampanhaWhatsapp(deps({
      enviarTemplate: async (a) => { recebido.push(a); return { wamid: 'wamid-status' }; },
    })));

  assert.equal(r.enviados, 1);
  assert.equal(r.falhas, 0, 'sem link de grupo NAO pode virar falha para status_candidatura');
  assert.equal(recebido.length, 1);
  assert.equal(recebido[0].telefone, '5547900000704');
  const linha = fila(cid)[0];
  assert.equal(linha.status, 'enviado');
  assert.equal(linha.wamid, 'wamid-status');
});

// ══════════════════ Webhook ══════════════════

const assinar = (corpo) =>
  `sha256=${crypto.createHmac('sha256', process.env.META_APP_SECRET).update(corpo).digest('hex')}`;

async function comServidor(fn) {
  const app = criarApp();
  const server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  try {
    return await fn(`http://127.0.0.1:${server.address().port}`);
  } finally {
    await new Promise((r) => server.close(r));
  }
}

const postar = (base, obj, assinatura) =>
  fetch(`${base}/webhook/whatsapp-meta`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(assinatura === null ? {} : { 'X-Hub-Signature-256': assinatura || assinar(JSON.stringify(obj)) }),
    },
    body: JSON.stringify(obj),
  });

test('handshake GET responde o challenge em texto puro', async () => {
  await comServidor(async (base) => {
    const url = `${base}/webhook/whatsapp-meta?hub.mode=subscribe&hub.verify_token=${process.env.META_WEBHOOK_VERIFY_TOKEN}&hub.challenge=DESAFIO123`;
    const res = await semRuido(() => fetch(url)).then((x) => x.r);
    assert.equal(res.status, 200);
    // JSON aqui faz o cadastro na Meta falhar com uma mensagem que nao explica nada.
    assert.match(res.headers.get('content-type') || '', /text\/plain/);
    assert.equal(await res.text(), 'DESAFIO123');
  });
});

test('handshake com token errado: 403', async () => {
  await comServidor(async (base) => {
    const res = await semRuido(() =>
      fetch(`${base}/webhook/whatsapp-meta?hub.mode=subscribe&hub.verify_token=errado&hub.challenge=X`)).then((x) => x.r);
    assert.equal(res.status, 403);
  });
});

test('POST sem assinatura ou com assinatura invalida: 401', async () => {
  const corpo = { entry: [] };
  await comServidor(async (base) => {
    const semAss = await semRuido(() => postar(base, corpo, null)).then((x) => x.r);
    assert.equal(semAss.status, 401);
    const ruim = await semRuido(() => postar(base, corpo, 'sha256=deadbeef')).then((x) => x.r);
    assert.equal(ruim.status, 401);
  });
});

test('POST com assinatura valida: 200', async () => {
  await comServidor(async (base) => {
    const res = await semRuido(() => postar(base, { entry: [] })).then((x) => x.r);
    assert.equal(res.status, 200);
  });
});

test('status de entrega atualiza a linha pelo wamid', async () => {
  zerar();
  const { cid } = montarCenario();
  adicionar(cid, '5547999582500', 'Ana', 'Joinville');
  db.marcarEnvioWhatsappEnviado(fila(cid)[0].id, 'wamid-entrega');

  const corpo = {
    entry: [{ changes: [{ value: { statuses: [{ id: 'wamid-entrega', status: 'delivered' }] } }] }],
  };
  await comServidor(async (base) => {
    const res = await semRuido(() => postar(base, corpo)).then((x) => x.r);
    assert.equal(res.status, 200);
  });
  assert.equal(fila(cid)[0].status, 'entregue');
});

test('opt-out por PALAVRA-CHAVE grava; resposta comum NAO grava', async () => {
  zerar();
  const msg = (texto, de) => ({
    entry: [{ changes: [{ value: { messages: [{ from: de, text: { body: texto } }] } }] }],
  });

  await comServidor(async (base) => {
    // Resposta comum: NAO e opt-out. Tratar como tal removeria da base exatamente as pessoas
    // mais interessadas.
    for (const texto of ['obrigado!', 'qual o horario?', 'ainda tem vaga', 'nao posso parar de agradecer']) {
      await semRuido(() => postar(base, msg(texto, '5547900000001')));
      assert.equal(db.estaOptOutWhatsapp('5547900000001'), false, texto);
    }
    // Palavra-chave: grava.
    for (const [texto, tel] of [['PARAR', '5547900000002'], ['sair', '5547900000003'], ['Cancelar!', '5547900000004']]) {
      await semRuido(() => postar(base, msg(texto, tel)));
      assert.equal(db.estaOptOutWhatsapp(tel), true, texto);
    }
  });
});

test('pedeOptOut: casa a mensagem inteira, nao "contem a palavra"', () => {
  for (const sim of ['parar', 'PARAR', 'Sair', 'stop', 'cancelar!', 'parar por favor', 'nao quero']) {
    assert.equal(webhook.pedeOptOut(sim), true, sim);
  }
  for (const nao of ['obrigado', 'quero saber mais', 'nao posso parar de agradecer', '', null]) {
    assert.equal(webhook.pedeOptOut(nao), false, String(nao));
  }
});

// ══════════════════ Seed ══════════════════

test('o seed cobre exatamente as 9 pracas do enum', () => {
  zerar();
  for (const cidade of listarCidadesValidas()) {
    exec('INSERT OR IGNORE INTO regioes_grupos_whatsapp (cidade) VALUES (?)', cidade);
  }
  const cidades = db.listarRegioesGrupos().map((r) => r.cidade);
  // A lista vem de lib/cidades para nao existir segunda fonte de verdade sobre quais pracas
  // existem.
  assert.deepEqual(cidades, [...listarCidadesValidas()].sort((a, b) => a.localeCompare(b, 'pt-BR')));
  assert.equal(db.obterLinkGrupo('Joinville'), null, 'links nascem vazios');
});

// ══════════════════ Admin ══════════════════

async function comAdmin(fn) {
  return comServidor(async (base) => {
    const res = await fetch(`${base}/admin/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ usuario: 'admin-teste', senha: 'senha-teste' }),
      redirect: 'manual',
    });
    const bruto = res.headers.getSetCookie ? res.headers.getSetCookie() : [res.headers.get('set-cookie')];
    const cookie = bruto.filter(Boolean).map((c) => c.split(';')[0]).join('; ');
    return fn(base, { Cookie: cookie });
  });
}

test('admin: a tela exige sessao', async () => {
  await comServidor(async (base) => {
    const res = await fetch(`${base}/admin/campanhas-whatsapp`, { redirect: 'manual' });
    assert.equal(res.status, 302);
    assert.match(res.headers.get('location') || '', /\/admin\/login/);
  });
});

test('admin: a tela lista pracas, templates e diz o que falta', async () => {
  zerar();
  montarCenario();
  await comAdmin(async (base, h) => {
    const html = await (await fetch(`${base}/admin/campanhas-whatsapp`, { headers: h })).text();
    assert.match(html, /Campanha por WhatsApp/);
    assert.match(html, /Links dos grupos por praça/);
    assert.match(html, /confirmacao_cadastro_vaga_vm/);
    // O diagnostico e o ponto da tela: dizer POR QUE nada sai.
    assert.match(html, /interruptor <b>Campanha por WhatsApp<\/b> está desligado/);
    assert.match(html, /META_CAMPANHA_MOCK/);
  });
});

test('admin: botao "Voltar ao painel" (Item 5 do ETAPA B "Ajustes no Admin", Commit 11)', async () => {
  zerar();
  montarCenario();
  await comAdmin(async (base, h) => {
    const html = await (await fetch(`${base}/admin/campanhas-whatsapp`, { headers: h })).text();
    // Mesmo padrao usado em ~15 outras telas do admin, logo antes do <h1>.
    assert.match(html, /<p><a class="btn btn--ghost" href="\/admin">← Voltar ao painel<\/a><\/p>\s*<h1>Campanha por WhatsApp<\/h1>/);
  });
});

test('montarConteudoCampanhaWhatsapp: fragmento puro (Item 3 do ETAPA B, Commit 6) sem o paginaAdmin em volta', () => {
  // Extraida para ser reaproveitada pela futura pagina /admin/divulgacao-vagas (Commit 7)
  // sem duplicar a logica desta tela. Aqui so confirma que e uma funcao pura chamavel
  // fora da rota, devolvendo o MESMO fragmento que a rota standalone envia hoje (ja
  // coberto ponta-a-ponta pelo teste 'admin: a tela lista pracas...' acima).
  zerar();
  montarCenario();
  const conteudo = montarConteudoCampanhaWhatsapp({ escapeHtml, fmtInt: (v) => String(v) });
  assert.match(conteudo, /Campanha por WhatsApp/);
  assert.match(conteudo, /Links dos grupos por praça/);
  // E so o fragmento — nao a pagina inteira (isso e responsabilidade do paginaAdmin).
  assert.ok(!conteudo.includes('<html'));
  assert.ok(!conteudo.includes('<title>'));
});

test('admin: salvar link da praca persiste; cidade forjada e recusada', async () => {
  zerar();
  for (const c of listarCidadesValidas()) exec('INSERT OR IGNORE INTO regioes_grupos_whatsapp (cidade) VALUES (?)', c);

  await comAdmin(async (base, h) => {
    const salvar = (cidade, link) =>
      fetch(`${base}/admin/campanhas-whatsapp/regiao`, {
        method: 'POST',
        headers: { ...h, 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ cidade, link }),
        redirect: 'manual',
      });

    await salvar('Joinville', 'https://chat.whatsapp.com/JOI');
    assert.equal(db.obterLinkGrupo('Joinville'), 'https://chat.whatsapp.com/JOI');

    // Praca fora do vocabulario criaria uma linha que nenhum envio jamais consulta.
    await salvar('Blumenau', 'https://chat.whatsapp.com/X');
    assert.equal(uma('SELECT COUNT(*) n FROM regioes_grupos_whatsapp WHERE cidade = ?', 'Blumenau').n, 0);
  });
});

test('admin: criar campanha nasce em RASCUNHO e ativar e um segundo clique', async () => {
  zerar();
  const { tid } = montarCenario();
  await comAdmin(async (base, h) => {
    await fetch(`${base}/admin/campanhas-whatsapp`, {
      method: 'POST',
      headers: { ...h, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ nome: 'Convite agosto', template_id: String(tid), base_alvo: 'ambos' }),
      redirect: 'manual',
    });

    const nova = uma("SELECT * FROM campanhas_whatsapp WHERE nome = 'Convite agosto'");
    assert.ok(nova);
    // Criar nao dispara: nasce em rascunho pelo default da coluna.
    assert.equal(nova.status, 'rascunho');

    await fetch(`${base}/admin/campanhas-whatsapp/${nova.id}/status`, {
      method: 'POST',
      headers: { ...h, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ status: 'ativa' }),
      redirect: 'manual',
    });
    const depois = uma('SELECT * FROM campanhas_whatsapp WHERE id = ?', nova.id);
    assert.equal(depois.status, 'ativa');
    assert.ok(depois.iniciada_em, 'ativar carimba iniciada_em');
  });
});

test('admin: o checkbox do kill-switch liga e persiste', async () => {
  zerar();
  await comAdmin(async (base, h) => {
    const html = await (await fetch(`${base}/admin/config`, { headers: h })).text();
    assert.match(html, /name="campanha_whatsapp_ativa"/);
    // Default desligado: o kill-switch nao pode nascer ligado.
    assert.doesNotMatch(html, /name="campanha_whatsapp_ativa" value="1" checked/);

    await fetch(`${base}/admin/config/notificacoes`, {
      method: 'POST',
      headers: { ...h, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ campanha_whatsapp_ativa: '1' }),
      redirect: 'manual',
    });
    assert.equal(db.obterConfigBool(job.CHAVE_ATIVO, false), true);
  });
});

// ══════════════════ ETAPA B, Incremento 6: UI (filtros + envio avulso) ══════════════════

test('admin: form "Nova campanha" renderiza os inputs de periodo', async () => {
  // O checkbox "Ja se candidataram a" (filtro de vagas, multi-selecao) que vivia junto
  // deste teste foi REMOVIDO no Incremento 10 — ver a nota na secao "filtro de Periodo"
  // mais abaixo no arquivo.
  zerar();
  montarCenario();
  await comAdmin(async (base, h) => {
    const html = await (await fetch(`${base}/admin/campanhas-whatsapp`, { headers: h })).text();
    assert.match(html, /<input type="date" name="de">/);
    assert.match(html, /<input type="date" name="ate">/);
    // O checkbox de segmentacao por vaga nao existe mais em lugar nenhum da tela.
    assert.doesNotMatch(html, /<input type="checkbox" name="vaga"/);
  });
});

test('admin: POST / grava periodo em criterios_json (sem vagas[] — removido no Incremento 10)', async () => {
  zerar();
  const { tid } = montarCenario();

  await comAdmin(async (base, h) => {
    const res = await fetch(`${base}/admin/campanhas-whatsapp`, {
      method: 'POST',
      headers: { ...h, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams([
        ['nome', 'Campanha com periodo'],
        ['template_id', String(tid)],
        ['base_alvo', 'ambos'],
        ['de', '2026-01-01'],
        ['ate', '2026-12-31'],
      ]),
      redirect: 'manual',
    });
    assert.equal(res.status, 302);
  });

  const linha = uma("SELECT * FROM campanhas_whatsapp WHERE nome = 'Campanha com periodo'");
  const criterios = JSON.parse(linha.criterios_json);
  assert.equal(criterios.vagas, undefined);
  assert.equal(criterios.dataDe, '2026-01-01');
  assert.equal(criterios.dataAte, '2026-12-31');
});

test('admin: a tela tem a secao "Testar envio avulso" com busca, telefone, template e botao', async () => {
  zerar();
  montarCenario();
  await comAdmin(async (base, h) => {
    const html = await (await fetch(`${base}/admin/campanhas-whatsapp`, { headers: h })).text();
    assert.match(html, /Testar envio avulso/);
    assert.match(html, /id="teste-busca-candidato"/);
    assert.match(html, /id="teste-telefone"/);
    assert.match(html, /id="teste-template"/);
    assert.match(html, /id="teste-btn-enviar"/);
    // O select de template usa a MESMA fonte (templates_whatsapp) do form de campanha —
    // aparece nos dois lugares da tela.
    assert.match(html, new RegExp(`id="teste-template"[\\s\\S]*?${TEMPLATE.nome_meta}`));
    // Avisa que fura o mock, e nao grava campanha.
    assert.match(html, /ignora <code>META_CAMPANHA_MOCK<\/code>/);
    assert.match(html, /não grava em[\s\S]*campanha_whatsapp_envios/);
  });
});

// ══════════════════ ETAPA B, Incremento 7: tipo_mensagem + vaga-alvo na UI ══════════════════

test('admin: form "Nova campanha" renderiza o select de Objetivo (3 opcoes) e o campo de vaga-alvo (escondido por padrao)', async () => {
  zerarSeg();
  const j = vagaCom('Joinville', 'CLOSER');
  montarCenario();
  const tituloVaga = uma('SELECT titulo FROM jobs WHERE id = ?', j).titulo;

  await comAdmin(async (base, h) => {
    const html = await (await fetch(`${base}/admin/campanhas-whatsapp`, { headers: h })).text();
    assert.match(html, /<select name="tipo_mensagem" id="campo-objetivo">/);
    assert.match(html, /<option value="divulgacao_vaga">Promover uma vaga<\/option>/);
    assert.match(html, /<option value="convite_grupo">Promover um grupo de vagas<\/option>/);
    assert.match(html, /<option value="status_candidatura">Informar situação de candidatura<\/option>/);
    // Campo da vaga-alvo: rotulo inconfundivel do de segmentacao, e escondido por padrao
    // (nasce com `hidden`, so o JS de toggle mostra quando divulgacao_vaga/status_candidatura
    // for escolhido).
    assert.match(html, /<label class="campo" id="campo-vaga-alvo" hidden>/);
    assert.match(html, /id="rotulo-vaga-alvo">Vaga sendo divulgada \(obrigatório\)/);
    // So vaga ATIVA aparece no select-alvo (mesmo rotulo "titulo · perfil" de admin_promocao).
    assert.match(html, new RegExp(`<option value="${j}">${escapeHtml(`${tituloVaga} · CLOSER`)}</option>`));
    // O toggle e feito por JS (sem precedente de <select> disparando isso no projeto).
    assert.match(html, /getElementById\('campo-objetivo'\)/);
    assert.match(html, /addEventListener\('change', atualizar\)/);
  });
});

test('admin: vaga INATIVA nao aparece no select da vaga-alvo', async () => {
  zerarSeg();
  const jInativa = vagaCom('Curitiba');
  exec('UPDATE jobs SET ativo = 0 WHERE id = ?', jInativa);
  montarCenario();
  const tituloInativa = uma('SELECT titulo FROM jobs WHERE id = ?', jInativa).titulo;

  await comAdmin(async (base, h) => {
    const html = await (await fetch(`${base}/admin/campanhas-whatsapp`, { headers: h })).text();
    // Nao esta entre as <option> do select de vaga-alvo.
    assert.doesNotMatch(html, new RegExp(`<option value="${jInativa}">${escapeHtml(tituloInativa)}`));
  });
});

test('admin: POST / cria convite_grupo SEM vaga-alvo (sucesso, job_id NULL)', async () => {
  zerar();
  const { tid } = montarCenario();
  await comAdmin(async (base, h) => {
    const res = await fetch(`${base}/admin/campanhas-whatsapp`, {
      method: 'POST',
      headers: { ...h, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        nome: 'Convite sem vaga',
        template_id: String(tid),
        base_alvo: 'ambos',
        tipo_mensagem: 'convite_grupo',
      }),
      redirect: 'manual',
    });
    assert.equal(res.status, 302);
    assert.doesNotMatch(res.headers.get('location') || '', /erro=/);
  });
  const linha = uma("SELECT * FROM campanhas_whatsapp WHERE nome = 'Convite sem vaga'");
  assert.ok(linha);
  assert.equal(linha.tipo_mensagem, 'convite_grupo');
  assert.equal(linha.job_id, null);
});

test('admin: POST / cria divulgacao_vaga COM vaga-alvo valida e ativa (sucesso)', async () => {
  zerarSeg();
  const j = vagaCom('Joinville');
  const { tid } = montarCenario();
  await comAdmin(async (base, h) => {
    const res = await fetch(`${base}/admin/campanhas-whatsapp`, {
      method: 'POST',
      headers: { ...h, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        nome: 'Divulgacao valida',
        template_id: String(tid),
        base_alvo: 'ambos',
        tipo_mensagem: 'divulgacao_vaga',
        job_id: String(j),
      }),
      redirect: 'manual',
    });
    assert.equal(res.status, 302);
    assert.doesNotMatch(res.headers.get('location') || '', /erro=/);
  });
  const linha = uma("SELECT * FROM campanhas_whatsapp WHERE nome = 'Divulgacao valida'");
  assert.ok(linha);
  assert.equal(linha.tipo_mensagem, 'divulgacao_vaga');
  assert.equal(linha.job_id, j);
});

test('admin: POST / divulgacao_vaga SEM job_id -> erro claro, nada gravado', async () => {
  zerar();
  const { tid } = montarCenario();
  await comAdmin(async (base, h) => {
    const antes = uma('SELECT COUNT(*) n FROM campanhas_whatsapp').n;
    const res = await fetch(`${base}/admin/campanhas-whatsapp`, {
      method: 'POST',
      headers: { ...h, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        nome: 'Divulgacao sem vaga',
        template_id: String(tid),
        base_alvo: 'ambos',
        tipo_mensagem: 'divulgacao_vaga',
        // job_id ausente de proposito
      }),
      redirect: 'manual',
    });
    assert.equal(res.status, 302);
    assert.match(res.headers.get('location') || '', /erro=vaga(?!_invalida)/);
    assert.equal(uma('SELECT COUNT(*) n FROM campanhas_whatsapp').n, antes);
  });
});

test('admin: POST / divulgacao_vaga com job_id de vaga INEXISTENTE -> erro claro, nada gravado', async () => {
  zerar();
  const { tid } = montarCenario();
  await comAdmin(async (base, h) => {
    const antes = uma('SELECT COUNT(*) n FROM campanhas_whatsapp').n;
    const res = await fetch(`${base}/admin/campanhas-whatsapp`, {
      method: 'POST',
      headers: { ...h, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        nome: 'Divulgacao vaga fantasma',
        template_id: String(tid),
        base_alvo: 'ambos',
        tipo_mensagem: 'divulgacao_vaga',
        job_id: '999999',
      }),
      redirect: 'manual',
    });
    assert.equal(res.status, 302);
    assert.match(res.headers.get('location') || '', /erro=vaga_invalida/);
    assert.equal(uma('SELECT COUNT(*) n FROM campanhas_whatsapp').n, antes);
  });
});

test('admin: POST / divulgacao_vaga com job_id de vaga INATIVA -> erro claro, nada gravado', async () => {
  zerarSeg();
  const jInativa = vagaCom('Joinville');
  exec('UPDATE jobs SET ativo = 0 WHERE id = ?', jInativa);
  const { tid } = montarCenario();

  await comAdmin(async (base, h) => {
    const antes = uma('SELECT COUNT(*) n FROM campanhas_whatsapp').n;
    const res = await fetch(`${base}/admin/campanhas-whatsapp`, {
      method: 'POST',
      headers: { ...h, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        nome: 'Divulgacao vaga inativa',
        template_id: String(tid),
        base_alvo: 'ambos',
        tipo_mensagem: 'divulgacao_vaga',
        job_id: String(jInativa),
      }),
      redirect: 'manual',
    });
    assert.equal(res.status, 302);
    assert.match(res.headers.get('location') || '', /erro=vaga_invalida/);
    assert.equal(uma('SELECT COUNT(*) n FROM campanhas_whatsapp').n, antes);
  });
});

test('admin: POST / convite_grupo com job_id no body -> ERRO (Incremento 12 endureceu de silenciosamente ignorar pra recusar)', async () => {
  // Ate o Incremento 7, job_id sobrando no body de um convite_grupo virava NULL sem avisar.
  // O redesenho em 3 objetivos aperta essa regra: campo que nao pertence ao objetivo agora
  // e ERRO explicito (primeiroCampoIncompativel), nao mais silenciado.
  zerarSeg();
  const j = vagaCom('Joinville');
  const { tid } = montarCenario();
  await comAdmin(async (base, h) => {
    const antes = uma('SELECT COUNT(*) n FROM campanhas_whatsapp').n;
    const res = await fetch(`${base}/admin/campanhas-whatsapp`, {
      method: 'POST',
      headers: { ...h, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        nome: 'Convite com job_id perdido',
        template_id: String(tid),
        base_alvo: 'ambos',
        tipo_mensagem: 'convite_grupo',
        job_id: String(j),
      }),
      redirect: 'manual',
    });
    assert.equal(res.status, 302);
    assert.match(res.headers.get('location') || '', /erro=campo_incompativel/);
    assert.equal(uma('SELECT COUNT(*) n FROM campanhas_whatsapp').n, antes);
  });
  assert.equal(uma("SELECT COUNT(*) n FROM campanhas_whatsapp WHERE nome = 'Convite com job_id perdido'").n, 0);
});

// ══════════════════ ETAPA B, Incremento 12: 3 objetivos de campanha ══════════════════

test('admin: form renderiza checkboxes de Cidade (segmentacao) e o bloco de Status (escondido por padrao)', async () => {
  zerar();
  montarCenario();
  await comAdmin(async (base, h) => {
    const html = await (await fetch(`${base}/admin/campanhas-whatsapp`, { headers: h })).text();
    assert.match(html, /<div id="campo-segmentacao">/);
    // Checkbox de Cidade, novo neste incremento — nunca existiu nesta tela antes.
    assert.match(html, /<input type="checkbox" name="cidade" value="Joinville">/);
    // Bloco de status: escondido por padrao, so 3 opcoes.
    assert.match(html, /<div id="campo-status-candidatura" hidden>/);
    assert.match(html, /<input type="checkbox" name="status_recrutador" value="aprovado">/);
    assert.match(html, /<input type="checkbox" name="status_recrutador" value="reprovado">/);
    assert.match(html, /<input type="checkbox" name="status_recrutador" value="em_analise">/);
    // Aviso de validacao client-side (pelo menos 1 status), escondido por padrao.
    assert.match(html, /id="aviso-status-candidatura" class="aviso-alerta" hidden/);
  });
});

test('admin: POST / cria status_candidatura com job_id e statusList corretos', async () => {
  zerarSeg();
  const j = vagaCom('Joinville');
  const { tid } = montarCenario();
  await comAdmin(async (base, h) => {
    const res = await fetch(`${base}/admin/campanhas-whatsapp`, {
      method: 'POST',
      headers: { ...h, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams([
        ['nome', 'Situacao da candidatura'],
        ['template_id', String(tid)],
        ['tipo_mensagem', 'status_candidatura'],
        ['job_id', String(j)],
        ['status_recrutador', 'aprovado'],
        ['status_recrutador', 'reprovado'],
      ]),
      redirect: 'manual',
    });
    assert.equal(res.status, 302);
    assert.doesNotMatch(res.headers.get('location') || '', /erro=/);
  });
  const linha = uma("SELECT * FROM campanhas_whatsapp WHERE nome = 'Situacao da candidatura'");
  assert.ok(linha);
  assert.equal(linha.tipo_mensagem, 'status_candidatura');
  assert.equal(linha.job_id, j);
  const criterios = JSON.parse(linha.criterios_json);
  assert.deepEqual(criterios.statusList.sort(), ['aprovado', 'reprovado']);
});

test('admin: POST / status_candidatura SEM job_id -> erro=vaga, nada gravado', async () => {
  zerar();
  const { tid } = montarCenario();
  await comAdmin(async (base, h) => {
    const antes = uma('SELECT COUNT(*) n FROM campanhas_whatsapp').n;
    const res = await fetch(`${base}/admin/campanhas-whatsapp`, {
      method: 'POST',
      headers: { ...h, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        nome: 'Situacao sem vaga',
        template_id: String(tid),
        tipo_mensagem: 'status_candidatura',
        status_recrutador: 'aprovado',
      }),
      redirect: 'manual',
    });
    assert.equal(res.status, 302);
    assert.match(res.headers.get('location') || '', /erro=vaga(?!_invalida)/);
    assert.equal(uma('SELECT COUNT(*) n FROM campanhas_whatsapp').n, antes);
  });
});

test('admin: POST / status_candidatura com job_id de vaga INATIVA -> erro=vaga_invalida', async () => {
  zerarSeg();
  const jInativa = vagaCom('Joinville');
  exec('UPDATE jobs SET ativo = 0 WHERE id = ?', jInativa);
  const { tid } = montarCenario();
  await comAdmin(async (base, h) => {
    const res = await fetch(`${base}/admin/campanhas-whatsapp`, {
      method: 'POST',
      headers: { ...h, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        nome: 'Situacao vaga inativa',
        template_id: String(tid),
        tipo_mensagem: 'status_candidatura',
        job_id: String(jInativa),
        status_recrutador: 'aprovado',
      }),
      redirect: 'manual',
    });
    assert.equal(res.status, 302);
    assert.match(res.headers.get('location') || '', /erro=vaga_invalida/);
  });
});

test('admin: POST / status_candidatura SEM status marcado -> erro=status_vazio, nada gravado', async () => {
  zerarSeg();
  const j = vagaCom('Joinville');
  const { tid } = montarCenario();
  await comAdmin(async (base, h) => {
    const antes = uma('SELECT COUNT(*) n FROM campanhas_whatsapp').n;
    const res = await fetch(`${base}/admin/campanhas-whatsapp`, {
      method: 'POST',
      headers: { ...h, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        nome: 'Situacao sem status',
        template_id: String(tid),
        tipo_mensagem: 'status_candidatura',
        job_id: String(j),
        // status_recrutador ausente de proposito
      }),
      redirect: 'manual',
    });
    assert.equal(res.status, 302);
    assert.match(res.headers.get('location') || '', /erro=status_vazio/);
    assert.equal(uma('SELECT COUNT(*) n FROM campanhas_whatsapp').n, antes);
  });
});

test('admin: POST / status_candidatura com CIDADE no body -> erro=campo_incompativel (reforco server-side, mesmo enviado direto)', async () => {
  zerarSeg();
  const j = vagaCom('Joinville');
  const { tid } = montarCenario();
  await comAdmin(async (base, h) => {
    const antes = uma('SELECT COUNT(*) n FROM campanhas_whatsapp').n;
    const res = await fetch(`${base}/admin/campanhas-whatsapp`, {
      method: 'POST',
      headers: { ...h, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        nome: 'Situacao com cidade forjada',
        template_id: String(tid),
        tipo_mensagem: 'status_candidatura',
        job_id: String(j),
        status_recrutador: 'aprovado',
        cidade: 'Joinville', // campo que NAO pertence a status_candidatura
      }),
      redirect: 'manual',
    });
    assert.equal(res.status, 302);
    assert.match(res.headers.get('location') || '', /erro=campo_incompativel/);
    assert.equal(uma('SELECT COUNT(*) n FROM campanhas_whatsapp').n, antes);
  });
});

test('admin: POST / status_candidatura com BASE_ALVO no body -> erro=campo_incompativel (reforco server-side, mesmo enviado direto)', async () => {
  zerarSeg();
  const j = vagaCom('Joinville');
  const { tid } = montarCenario();
  await comAdmin(async (base, h) => {
    const antes = uma('SELECT COUNT(*) n FROM campanhas_whatsapp').n;
    const res = await fetch(`${base}/admin/campanhas-whatsapp`, {
      method: 'POST',
      headers: { ...h, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        nome: 'Situacao com base_alvo forjada',
        template_id: String(tid),
        tipo_mensagem: 'status_candidatura',
        job_id: String(j),
        status_recrutador: 'aprovado',
        base_alvo: 'ambos', // campo que NAO pertence a status_candidatura
      }),
      redirect: 'manual',
    });
    assert.equal(res.status, 302);
    assert.match(res.headers.get('location') || '', /erro=campo_incompativel/);
    assert.equal(uma('SELECT COUNT(*) n FROM campanhas_whatsapp').n, antes);
  });
});

test('admin: POST / status_candidatura com PERIODO (de/ate) no body -> erro=campo_incompativel', async () => {
  zerarSeg();
  const j = vagaCom('Joinville');
  const { tid } = montarCenario();
  await comAdmin(async (base, h) => {
    const res = await fetch(`${base}/admin/campanhas-whatsapp`, {
      method: 'POST',
      headers: { ...h, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        nome: 'Situacao com periodo forjado',
        template_id: String(tid),
        tipo_mensagem: 'status_candidatura',
        job_id: String(j),
        status_recrutador: 'aprovado',
        de: '2026-01-01',
      }),
      redirect: 'manual',
    });
    assert.equal(res.status, 302);
    assert.match(res.headers.get('location') || '', /erro=campo_incompativel/);
  });
});

test('admin: POST / divulgacao_vaga com STATUS_RECRUTADOR no body -> erro=campo_incompativel (simetrico)', async () => {
  zerarSeg();
  const j = vagaCom('Joinville');
  const { tid } = montarCenario();
  await comAdmin(async (base, h) => {
    const res = await fetch(`${base}/admin/campanhas-whatsapp`, {
      method: 'POST',
      headers: { ...h, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        nome: 'Divulgacao com status forjado',
        template_id: String(tid),
        tipo_mensagem: 'divulgacao_vaga',
        job_id: String(j),
        status_recrutador: 'aprovado',
      }),
      redirect: 'manual',
    });
    assert.equal(res.status, 302);
    assert.match(res.headers.get('location') || '', /erro=campo_incompativel/);
  });
});

test('admin: POST / convite_grupo cria normalmente COM cidade/periodo/base_alvo (campos compativeis)', async () => {
  zerar();
  const { tid } = montarCenario();
  await comAdmin(async (base, h) => {
    const res = await fetch(`${base}/admin/campanhas-whatsapp`, {
      method: 'POST',
      headers: { ...h, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams([
        ['nome', 'Convite com segmentacao'],
        ['template_id', String(tid)],
        ['tipo_mensagem', 'convite_grupo'],
        ['base_alvo', 'ambos'],
        ['cidade', 'Joinville'],
        ['de', '2026-01-01'],
        ['ate', '2026-12-31'],
      ]),
      redirect: 'manual',
    });
    assert.equal(res.status, 302);
    assert.doesNotMatch(res.headers.get('location') || '', /erro=/);
  });
  const linha = uma("SELECT * FROM campanhas_whatsapp WHERE nome = 'Convite com segmentacao'");
  assert.ok(linha);
  const criterios = JSON.parse(linha.criterios_json);
  assert.deepEqual(criterios.cidades, ['Joinville']);
  assert.equal(criterios.dataDe, '2026-01-01');
});

test('POST /previa: divulgacao_vaga sem job_id devolve erro JSON claro (nao 500)', async () => {
  zerar();
  await comAdmin(async (base, h) => {
    const res = await fetch(`${base}/admin/campanhas-whatsapp/previa`, {
      method: 'POST',
      headers: { ...h, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ tipo_mensagem: 'divulgacao_vaga' }),
    });
    assert.equal(res.status, 400);
    const corpo = await res.json();
    assert.equal(corpo.ok, false);
    assert.match(corpo.erro, /job_id valido/);
  });
});

test('POST /previa: divulgacao_vaga com job_id valido devolve total (mesmo caminho do motor)', async () => {
  zerarSeg();
  const j = vagaCom('Joinville');
  candidatura(vagaCom('Joinville'), 'Fora da vaga alvo', '+55 47 90000-0500');
  await comAdmin(async (base, h) => {
    const res = await fetch(`${base}/admin/campanhas-whatsapp/previa`, {
      method: 'POST',
      headers: { ...h, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ tipo_mensagem: 'divulgacao_vaga', job_id: String(j) }),
    });
    assert.equal(res.status, 200);
    const corpo = await res.json();
    assert.equal(corpo.ok, true);
    assert.equal(corpo.tipo, 'divulgacao_vaga');
    assert.equal(corpo.total, 1);
  });
});

test('POST /:id/disparar: materializa divulgacao_vaga corretamente a partir do que foi persistido na criacao', async () => {
  zerarSeg();
  const alvo = vagaCom('Joinville');
  candidatura(alvo, 'Ja Candidatou', '+55 47 90000-0501'); // excluido pela invariante
  candidatura(vagaCom('Joinville'), 'Candidato Valido', '+55 47 90000-0502');
  const { tid } = montarCenario();

  await comAdmin(async (base, h) => {
    await fetch(`${base}/admin/campanhas-whatsapp`, {
      method: 'POST',
      headers: { ...h, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        nome: 'Divulgacao para disparar',
        template_id: String(tid),
        base_alvo: 'ambos',
        tipo_mensagem: 'divulgacao_vaga',
        job_id: String(alvo),
      }),
      redirect: 'manual',
    });
    const nova = uma("SELECT * FROM campanhas_whatsapp WHERE nome = 'Divulgacao para disparar'");
    assert.equal(nova.tipo_mensagem, 'divulgacao_vaga');
    assert.equal(nova.job_id, alvo);

    const res = await fetch(`${base}/admin/campanhas-whatsapp/${nova.id}/disparar`, {
      method: 'POST',
      headers: h,
      redirect: 'manual',
    });
    assert.equal(res.status, 302);
    assert.doesNotMatch(res.headers.get('location') || '', /erro=/);

    const fila = todas('SELECT * FROM campanha_whatsapp_envios WHERE campanha_id = ?', nova.id);
    assert.equal(fila.length, 1);
    assert.equal(fila[0].telefone, '5547900000502');
  });
});

// ══════════════════ ETAPA B, Incremento 16: guard de /disparar relaxado + botao "Ativar" corrigido ══════════════════
//
// Bug original: o botao "Ativar" da lista chamava POST /:id/status para QUALQUER status
// != 'ativa' (inclusive rascunho), e /status so troca a coluna — nunca materializa. Uma
// campanha em rascunho "ativada" pelo botao antigo ficava com status='ativa' e
// campanha_whatsapp_envios vazia PARA SEMPRE, porque /disparar (a unica rota que
// materializa) recusava qualquer status != 'rascunho'. Caso real: campanha id=1
// ("Nova Vaga - Donna Conecta").

test('POST /:id/disparar (Incremento 16): campanha \'ativa\' com fila VAZIA materializa — destrava o caso do bug do botao antigo', async () => {
  zerarSeg();
  const alvo = vagaCom('Joinville');
  candidatura(vagaCom('Joinville'), 'Candidato Valido', '+55 47 90000-0503'); // vaga DIFERENTE da alvo, mesma cidade
  const { tid } = montarCenario();

  await comAdmin(async (base, h) => {
    await fetch(`${base}/admin/campanhas-whatsapp`, {
      method: 'POST',
      headers: { ...h, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        nome: 'Presa em ativa sem fila',
        template_id: String(tid),
        base_alvo: 'ambos',
        tipo_mensagem: 'divulgacao_vaga',
        job_id: String(alvo),
      }),
      redirect: 'manual',
    });
    const nova = uma("SELECT * FROM campanhas_whatsapp WHERE nome = 'Presa em ativa sem fila'");
    assert.equal(nova.status, 'rascunho');

    // Simula o bug do botao antigo: vira 'ativa' via /status, SEM passar por /disparar.
    db.definirStatusCampanhaWhatsapp(nova.id, 'ativa');
    assert.equal(uma('SELECT status FROM campanhas_whatsapp WHERE id = ?', nova.id).status, 'ativa');
    assert.equal(todas('SELECT * FROM campanha_whatsapp_envios WHERE campanha_id = ?', nova.id).length, 0);

    const res = await fetch(`${base}/admin/campanhas-whatsapp/${nova.id}/disparar`, {
      method: 'POST',
      headers: h,
      redirect: 'manual',
    });
    assert.equal(res.status, 302);
    assert.doesNotMatch(res.headers.get('location') || '', /erro=/);

    const filaGravada = todas('SELECT * FROM campanha_whatsapp_envios WHERE campanha_id = ?', nova.id);
    assert.equal(filaGravada.length, 1);
    assert.equal(filaGravada[0].telefone, '5547900000503');
    // iniciada_em, ja setado pelo /status simulado acima, nao e trocado (COALESCE).
    assert.equal(uma('SELECT status FROM campanhas_whatsapp WHERE id = ?', nova.id).status, 'ativa');
  });
});

test('POST /:id/disparar (Incremento 16): campanha \'ativa\' com fila JA preenchida continua bloqueada — nao reprocessa', async () => {
  zerarSeg();
  const { cid } = montarCenario(); // nasce 'ativa' (helper simplificado), sem materializar
  adicionar(cid, '5547900000900', 'Ja Na Fila', 'Joinville');
  assert.equal(fila(cid).length, 1);

  await comAdmin(async (base, h) => {
    const res = await fetch(`${base}/admin/campanhas-whatsapp/${cid}/disparar`, {
      method: 'POST',
      headers: h,
      redirect: 'manual',
    });
    assert.equal(res.status, 302);
    assert.match(res.headers.get('location') || '', /erro=status/);
    assert.equal(fila(cid).length, 1); // sem duplicar, sem reprocessar
  });
});

test('POST /:id/disparar: campanha \'rascunho\' continua funcionando como sempre (regressao)', async () => {
  zerarSeg();
  const alvo = vagaCom('Joinville');
  candidatura(vagaCom('Joinville'), 'Candidato Rascunho', '+55 47 90000-0505'); // vaga DIFERENTE da alvo, mesma cidade
  const { tid } = montarCenario();

  await comAdmin(async (base, h) => {
    await fetch(`${base}/admin/campanhas-whatsapp`, {
      method: 'POST',
      headers: { ...h, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        nome: 'Rascunho normal',
        template_id: String(tid),
        base_alvo: 'ambos',
        tipo_mensagem: 'divulgacao_vaga',
        job_id: String(alvo),
      }),
      redirect: 'manual',
    });
    const nova = uma("SELECT * FROM campanhas_whatsapp WHERE nome = 'Rascunho normal'");
    assert.equal(nova.status, 'rascunho');

    const res = await fetch(`${base}/admin/campanhas-whatsapp/${nova.id}/disparar`, {
      method: 'POST',
      headers: h,
      redirect: 'manual',
    });
    assert.equal(res.status, 302);
    assert.doesNotMatch(res.headers.get('location') || '', /erro=/);
    assert.equal(uma('SELECT status FROM campanhas_whatsapp WHERE id = ?', nova.id).status, 'ativa');
    assert.equal(todas('SELECT * FROM campanha_whatsapp_envios WHERE campanha_id = ?', nova.id).length, 1);
  });
});

test('admin: botao da lista roteia por status (Incremento 16) — rascunho -> /disparar, ativa -> /status pausada, pausada -> /status ativa', () => {
  zerar();
  const { tid, cid: cidAtiva } = montarCenario(); // nasce 'ativa'
  const idRascunho = db.criarCampanhaWhatsapp({ nome: 'Rascunho X', templateId: tid, baseAlvo: 'ambos' });
  const idPausada = db.criarCampanhaWhatsapp({ nome: 'Pausada X', templateId: tid, baseAlvo: 'ambos' });
  db.definirStatusCampanhaWhatsapp(idPausada, 'pausada');

  const html = montarConteudoCampanhaWhatsapp({ escapeHtml, fmtInt: (v) => String(v) });

  assert.ok(html.includes(
    `<form method="post" action="/admin/campanhas-whatsapp/${idRascunho}/disparar"><button class="btn">Ativar</button></form>`,
  ));
  assert.ok(html.includes(
    `<form method="post" action="/admin/campanhas-whatsapp/${cidAtiva}/status"><input type="hidden" name="status" value="pausada"><button class="btn btn--ghost">Pausar</button></form>`,
  ));
  assert.ok(html.includes(
    `<form method="post" action="/admin/campanhas-whatsapp/${idPausada}/status"><input type="hidden" name="status" value="ativa"><button class="btn">Retomar</button></form>`,
  ));
  // Nenhuma campanha rascunho/pausada aponta para /status com o proposito de ativar —
  // so a 'ativa' de verdade posta para /status (e so para pausar).
  assert.ok(!html.includes(`campanhas-whatsapp/${idRascunho}/status`));
});

test('admin: fluxo do botao "Ativar" em rascunho materializa E ativa numa chamada so (Incremento 16)', async () => {
  zerarSeg();
  const alvo = vagaCom('Joinville');
  candidatura(vagaCom('Joinville'), 'Candidato Do Botao', '+55 47 90000-0504'); // vaga DIFERENTE da alvo, mesma cidade
  const { tid } = montarCenario();

  await comAdmin(async (base, h) => {
    await fetch(`${base}/admin/campanhas-whatsapp`, {
      method: 'POST',
      headers: { ...h, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        nome: 'Campanha do botao',
        template_id: String(tid),
        base_alvo: 'ambos',
        tipo_mensagem: 'divulgacao_vaga',
        job_id: String(alvo),
      }),
      redirect: 'manual',
    });
    const nova = uma("SELECT * FROM campanhas_whatsapp WHERE nome = 'Campanha do botao'");
    assert.equal(nova.status, 'rascunho');

    // A lista precisa renderizar o botao "Ativar" apontando para /disparar (nao /status).
    const html = await (await fetch(`${base}/admin/campanhas-whatsapp`, { headers: h })).text();
    assert.ok(html.includes(`action="/admin/campanhas-whatsapp/${nova.id}/disparar"`));

    // "Clica" no botao: POST direto na action renderizada.
    const res = await fetch(`${base}/admin/campanhas-whatsapp/${nova.id}/disparar`, {
      method: 'POST', headers: h, redirect: 'manual',
    });
    assert.equal(res.status, 302);
    assert.doesNotMatch(res.headers.get('location') || '', /erro=/);

    assert.equal(uma('SELECT status FROM campanhas_whatsapp WHERE id = ?', nova.id).status, 'ativa');
    const filaGravada = todas('SELECT * FROM campanha_whatsapp_envios WHERE campanha_id = ?', nova.id);
    assert.equal(filaGravada.length, 1);
    assert.equal(filaGravada[0].telefone, '5547900000504');
  });
});

test('admin: fluxo do botao "Retomar" em pausada NAO materializa de novo — sem duplicar envios (Incremento 16)', async () => {
  zerarSeg();
  const { cid } = montarCenario(); // nasce 'ativa' (helper simplificado)
  adicionar(cid, '5547900000905', 'Ja Enviado Antes', 'Joinville');
  db.definirStatusCampanhaWhatsapp(cid, 'pausada');
  assert.equal(fila(cid).length, 1);

  await comAdmin(async (base, h) => {
    const html = await (await fetch(`${base}/admin/campanhas-whatsapp`, { headers: h })).text();
    assert.ok(html.includes(`action="/admin/campanhas-whatsapp/${cid}/status"`));
    assert.match(html, /Retomar/);

    const res = await fetch(`${base}/admin/campanhas-whatsapp/${cid}/status`, {
      method: 'POST',
      headers: { ...h, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ status: 'ativa' }),
      redirect: 'manual',
    });
    assert.equal(res.status, 302);
    assert.equal(uma('SELECT status FROM campanhas_whatsapp WHERE id = ?', cid).status, 'ativa');
    assert.equal(fila(cid).length, 1); // sem duplicar
  });
});

// ══════════════════ ETAPA B, Incremento 9: template inativo nao pode ser usado ══════════════════

function criarTemplateAtivo(nomeMeta) {
  return Number(
    exec(
      "INSERT INTO templates_whatsapp (nome_meta, idioma, categoria, variaveis, ativo) VALUES (?, 'pt_BR', 'utility', ?, 1)",
      nomeMeta, JSON.stringify(TEMPLATE.variaveis),
    ).lastInsertRowid,
  );
}
function criarTemplateInativo(nomeMeta) {
  return Number(
    exec(
      "INSERT INTO templates_whatsapp (nome_meta, idioma, categoria, variaveis, ativo) VALUES (?, 'pt_BR', 'marketing', ?, 0)",
      nomeMeta, JSON.stringify(TEMPLATE.variaveis),
    ).lastInsertRowid,
  );
}

test('db.listarTemplatesWhatsapp({apenasAtivos:true}) so devolve ativo=1; sem parametro devolve todos (regressao)', () => {
  zerar();
  const ativoId = criarTemplateAtivo('tpl_ativo_9');
  const inativoId = criarTemplateInativo('tpl_inativo_9');

  const todosOs = db.listarTemplatesWhatsapp();
  assert.deepEqual(todosOs.map((t) => t.id).sort((a, b) => a - b), [ativoId, inativoId].sort((a, b) => a - b));

  const soAtivos = db.listarTemplatesWhatsapp({ apenasAtivos: true });
  assert.deepEqual(soAtivos.map((t) => t.id), [ativoId]);
});

test('admin: os DOIS selects de escolha (Nova campanha, Testar envio avulso) so oferecem template ATIVO; a tabela somente-leitura continua mostrando todos', async () => {
  zerar();
  criarTemplateAtivo('tpl_visivel_select_9');
  criarTemplateInativo('tpl_oculto_select_9');

  await comAdmin(async (base, h) => {
    const html = await (await fetch(`${base}/admin/campanhas-whatsapp`, { headers: h })).text();
    // Aparece na tabela "Templates aprovados" (le TODOS, sem filtro) — confirma que a
    // leitura completa nao regrediu.
    assert.match(html, /tpl_oculto_select_9/);
    // Mas NENHUM dos dois <select> (name="template_id" e id="teste-template") pode conter
    // uma <option> para o template inativo — verificado contando quantas vezes o nome dele
    // aparece: 1 (so na linha da tabela), nunca dentro de <option>.
    assert.doesNotMatch(html, /<option value="\d+">tpl_oculto_select_9/);
    assert.match(html, /<option value="\d+">tpl_visivel_select_9/);
  });
});

test('admin: POST / com template INATIVO -> erro claro, nenhuma campanha criada', async () => {
  zerar();
  const inativoId = criarTemplateInativo('tpl_post_inativo_9');
  await comAdmin(async (base, h) => {
    const antes = uma('SELECT COUNT(*) n FROM campanhas_whatsapp').n;
    const res = await fetch(`${base}/admin/campanhas-whatsapp`, {
      method: 'POST',
      headers: { ...h, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        nome: 'Campanha com template inativo',
        template_id: String(inativoId),
        base_alvo: 'ambos',
        tipo_mensagem: 'convite_grupo',
      }),
      redirect: 'manual',
    });
    assert.equal(res.status, 302);
    assert.match(res.headers.get('location') || '', /erro=template_inativo/);
    assert.equal(uma('SELECT COUNT(*) n FROM campanhas_whatsapp').n, antes);
  });
});

test('POST /enviar-teste com template INATIVO -> erro claro, SEM chamar a rede', async () => {
  zerarSeg();
  const j = vagaCom('Joinville');
  const appId = candidatura(j, 'Alvo', '+55 47 99958-2500');
  const inativoId = criarTemplateInativo('tpl_teste_inativo_9');

  await comRotaEnviarTeste(transporteNuncaChamado, async (base) => {
    const res = await enviarTestePost(base, {
      applicationId: appId,
      templateId: inativoId,
      telefoneDestino: '+55 47 98888-7777',
    });
    assert.equal(res.status, 400);
    const corpo = await res.json();
    assert.equal(corpo.ok, false);
    assert.match(corpo.erro, /não está ativo/);
  });
});

// ══════════════════ Motor de segmentacao (dois tipos) ══════════════════

const publico = require('../src/lib/publicoCampanhaWhatsapp');
const { normalizarTelefoneWhatsapp, normalizarTelefoneRecebido } = require('../src/lib/whatsapp');
const { montarUrlVaga, UTM_SOURCE_CAMPANHA, UTM_SOURCE_WHATSAPP } = require('../src/lib/ctaCampanha');

let seqSeg = 0;
function vagaCom(cidade, perfil = 'CLOSER') {
  seqSeg += 1;
  return Number(exec(
    'INSERT INTO jobs (slug, titulo, perfil, cidade, ativo) VALUES (?, ?, ?, ?, 1)',
    `vaga-seg-${seqSeg}`, `Vaga ${seqSeg}`, perfil, cidade,
  ).lastInsertRowid);
}
function candidatura(jobId, nome, telefone) {
  seqSeg += 1;
  return Number(exec(
    'INSERT INTO applications (job_id, nome, telefone, token) VALUES (?, ?, ?, ?)',
    jobId, nome, telefone, `tok-seg-${seqSeg}`,
  ).lastInsertRowid);
}
function legado(nome, telefone, cidade, perfil = null) {
  seqSeg += 1;
  return Number(exec(
    "INSERT INTO talentos (nome, email, telefone, cidade, perfil_interesse, categoria) VALUES (?, ?, ?, ?, ?, 'legado')",
    nome, `seg${seqSeg}@x.co`, telefone, cidade, perfil,
  ).lastInsertRowid);
}
function zerarSeg() {
  zerar();
  exec('DELETE FROM applications');
  exec('DELETE FROM talentos');
  exec('DELETE FROM jobs');
}
const tels = (r) => r.itens.map((i) => i.telefone).sort();

test('segmentacao: cidade do CANDIDATO vem da vaga (jobs.cidade)', () => {
  zerarSeg();
  candidatura(vagaCom('Joinville'), 'Ana Silva', '+55 47 99958-2500');
  const r = publico.listarPublicoConviteGrupo({});
  assert.equal(r.total, 1);
  // applications.cidade e coluna orfa: a praca so pode vir da vaga.
  assert.equal(r.itens[0].cidade, 'Joinville');
  assert.equal(r.itens[0].nome_primeiro, 'Ana');
});

test('segmentacao: sem cidade resolvivel fica FORA, sem checkbox', () => {
  zerarSeg();
  candidatura(vagaCom(null), 'Remoto', '+55 47 90000-0001');   // vaga remota
  legado('Sem Cidade', '+55 47 90000-0002', null);
  legado('Com Cidade', '+55 47 90000-0003', 'Joinville');
  // Sem praca nao ha link nem recorte: e invariante, nao preferencia.
  assert.deepEqual(tels(publico.listarPublicoConviteGrupo({})), ['5547900000003']);
});

test("segmentacao: sentinela 'Todas as cidades' NAO entra", () => {
  zerarSeg();
  legado('Coringa', '+55 47 90000-0004', 'Todas as cidades');
  legado('Normal', '+55 47 90000-0005', 'Joinville');
  // No e-mail o coringa amplia o publico; aqui ele nao diz em QUAL praca a pessoa esta.
  assert.deepEqual(tels(publico.listarPublicoConviteGrupo({})), ['5547900000005']);
});

test('segmentacao: opt-out e dedup por TELEFONE', () => {
  zerarSeg();
  const j = vagaCom('Joinville');
  candidatura(j, 'Ana', '+55 (47) 99958-2500');
  legado('Ana Legado', '+55 47999582500', 'Joinville'); // MESMO numero, outro cadastro
  legado('Fora', '+55 47 90000-0006', 'Joinville');
  db.registrarOptOutWhatsapp('5547900000006', 'resposta_webhook');

  const r = publico.listarPublicoConviteGrupo({});
  assert.deepEqual(tels(r), ['5547999582500'], 'dedup por telefone + opt-out');
  // applications vence talentos na exibicao: contexto vivo sobre cadastro antigo.
  assert.equal(r.itens[0].origemTipo, 'application');
});

test('segmentacao: filtro de cidade recorta', () => {
  zerarSeg();
  legado('J', '+55 47 90000-0007', 'Joinville');
  legado('C', '+55 41 90000-0008', 'Curitiba');
  assert.deepEqual(tels(publico.listarPublicoConviteGrupo({ cidades: ['Joinville'] })), ['5547900000007']);
  // Nada marcado = filtro inativo, como nos dropdowns do e-mail.
  assert.equal(publico.listarPublicoConviteGrupo({ cidades: [] }).total, 2);
});

test('divulgacao: exclui quem JA se candidatou aquela vaga (invariante)', () => {
  zerarSeg();
  const alvo = vagaCom('Joinville');
  const outra = vagaCom('Joinville');
  candidatura(alvo, 'Ja Esta', '+55 47 90000-0009');
  candidatura(outra, 'Outra Vaga', '+55 47 90000-0010');
  legado('So Legado', '+55 47 90000-0011', 'Joinville');

  const r = publico.listarPublicoDivulgacaoVaga(alvo, {});
  // Divulgar para quem ja esta na vaga e ruido que custa credibilidade — e no WhatsApp isso
  // e mais visivel que num e-mail.
  assert.deepEqual(tels(r), ['5547900000010', '5547900000011']);
});

test('divulgacao: filtro de perfil, e job_id invalido LANCA', () => {
  zerarSeg();
  const alvo = vagaCom('Joinville');
  legado('SDR', '+55 47 90000-0012', 'Joinville', 'SDR');
  legado('Closer', '+55 47 90000-0013', 'Joinville', 'CLOSER');
  assert.deepEqual(tels(publico.listarPublicoDivulgacaoVaga(alvo, { perfil: 'SDR' })), ['5547900000012']);
  // Divulgacao sem vaga nao existe: a mensagem inteira e sobre ela.
  for (const ruim of [null, 0, -1, 'abc']) {
    assert.throws(() => publico.listarPublicoDivulgacaoVaga(ruim, {}), /job_id valido/);
  }
});

test('divulgacao: vaga REMOTA nao implica "qualquer cidade"', () => {
  zerarSeg();
  const remota = vagaCom(null);
  legado('Joi', '+55 47 90000-0014', 'Joinville');
  legado('Cwb', '+55 41 90000-0015', 'Curitiba');
  // A cidade e da PESSOA; quem escolhe as pracas do publico-alvo e o operador, mesmo para
  // vaga remota.
  assert.deepEqual(tels(publico.listarPublicoDivulgacaoVaga(remota, { cidades: ['Joinville'] })), ['5547900000014']);
});

test('materializacao grava telefone normalizado e cidade resolvida', () => {
  zerarSeg();
  const { cid } = montarCenario();
  candidatura(vagaCom('Joinville'), 'Ana Silva', '+55 (47) 99958-2500');
  const r = publico.listarPublicoConviteGrupo({});

  assert.equal(db.materializarCampanhaWhatsapp(cid, r.itens), 1);
  const linha = fila(cid)[0];
  assert.equal(linha.telefone, '5547999582500');
  assert.equal(linha.cidade, 'Joinville');
  assert.equal(linha.origem_tipo, 'application');
  // Idempotente pelo UNIQUE: rematerializar nao duplica.
  assert.equal(db.materializarCampanhaWhatsapp(cid, r.itens), 0);
});

// ══════════════════ ETAPA B: filtro de Periodo ══════════════════
//
// O filtro "vagas" (candidatou-se a esta vaga especifica, multi-selecao) que vivia aqui foi
// REMOVIDO no Incremento 10 — superado pelo redesenho de segmentacao em 3 objetivos de
// campanha (ver Incremento 11/12: o novo tipo status_candidatura substitui essa necessidade
// com um recorte mais preciso, por vaga + status_recrutador). Periodo continua valendo para
// os dois tipos que restaram (convite_grupo/divulgacao_vaga).

// Sobrescreve criado_em DEPOIS do insert (candidatura/legado gravam com o default now()).
// `dataIso` no formato YYYY-MM-DD; a hora fixa em meio-dia so evita ambiguidade de fuso.
function comCriadoEm(tabela, id, dataIso) {
  exec(`UPDATE ${tabela} SET criado_em = ? WHERE id = ?`, `${dataIso} 12:00:00`, id);
}

test('periodo: filtra applications.criado_em, INCLUSIVO nos dois extremos', () => {
  zerarSeg();
  const j = vagaCom('Joinville');
  const dentroDe = candidatura(j, 'No limite De', '+55 47 90000-0107');
  const dentroAte = candidatura(j, 'No limite Ate', '+55 47 90000-0108');
  const foraAntes = candidatura(j, 'Antes da janela', '+55 47 90000-0109');
  const foraDepois = candidatura(j, 'Depois da janela', '+55 47 90000-0110');
  comCriadoEm('applications', dentroDe, '2026-01-10');
  comCriadoEm('applications', dentroAte, '2026-01-20');
  comCriadoEm('applications', foraAntes, '2026-01-09');
  comCriadoEm('applications', foraDepois, '2026-01-21');

  const r = publico.listarPublicoConviteGrupo({ dataDe: '2026-01-10', dataAte: '2026-01-20' });
  assert.deepEqual(tels(r), ['5547900000107', '5547900000108']);
});

test('periodo: talento usa o proprio criado_em (cadastro), e nao fica fora so por ser legado', () => {
  zerarSeg();
  const dentro = legado('Cadastrado na janela', '+55 47 90000-0111', 'Joinville');
  const fora = legado('Cadastrado fora', '+55 47 90000-0112', 'Joinville');
  comCriadoEm('talentos', dentro, '2026-02-15');
  comCriadoEm('talentos', fora, '2026-03-01');

  const r = publico.listarPublicoConviteGrupo({ dataDe: '2026-02-01', dataAte: '2026-02-28' });
  assert.deepEqual(tels(r), ['5547900000111']);
});

test('periodo + divulgacao (Incremento 2): a exclusao de "ja se candidatou ao ALVO" continua valendo mesmo quando essa candidatura cai FORA da janela de periodo', () => {
  // Regressao simetrica a de vagas (Incremento 1): jobsInscritos usado pelo invariante
  // "ja se candidatou a esta vaga" tem que vir do historico COMPLETO da pessoa, nao so das
  // candidaturas que sobrevivem ao filtro de periodo — senao quem se candidatou ao ALVO
  // muito antes da janela (mas a outra vaga DENTRO dela) deixaria de ser barrado.
  zerarSeg();
  const vagaRecente = vagaCom('Joinville');
  const alvoAntigo = vagaCom('Joinville');
  const telefone = '+55 47 90000-0116';
  const idAntigo = candidatura(alvoAntigo, 'Candidatura Antiga', telefone);
  const idRecente = candidatura(vagaRecente, 'Candidatura Antiga', telefone);
  comCriadoEm('applications', idAntigo, '2025-01-01');   // MUITO antes da janela
  comCriadoEm('applications', idRecente, '2026-06-15');  // dentro da janela

  const r = publico.listarPublicoDivulgacaoVaga(alvoAntigo, { dataDe: '2026-06-01', dataAte: '2026-06-30' });
  // Sem a candidatura antiga sumir de jobsInscritos por causa do filtro de periodo, a pessoa
  // continua excluida da divulgacao do alvo que ja se candidatou — mesmo a candidatura em si
  // estando fora da janela.
  assert.deepEqual(tels(r), []);
});

// ══════════════════ ETAPA B, Incremento 11: status_candidatura (3o tipo) ══════════════════

test('status_candidatura: publico correto para UM status', () => {
  zerarSeg();
  const j = vagaCom('Joinville');
  const aprovadoId = candidatura(j, 'Aprovado', '+55 47 90000-0600');
  const reprovadoId = candidatura(j, 'Reprovado', '+55 47 90000-0601');
  db.definirStatusRecrutador(aprovadoId, 'aprovado');
  db.definirStatusRecrutador(reprovadoId, 'reprovado');

  const r = publico.listarPublicoStatusCandidatura(j, ['aprovado']);
  assert.deepEqual(tels(r), ['5547900000600']);
});

test('status_candidatura: publico correto para MULTIPLOS status combinados', () => {
  zerarSeg();
  const j = vagaCom('Joinville');
  const aprovadoId = candidatura(j, 'Aprovado', '+55 47 90000-0602');
  const reprovadoId = candidatura(j, 'Reprovado', '+55 47 90000-0603');
  const analiseId = candidatura(j, 'Em Analise', '+55 47 90000-0604');
  db.definirStatusRecrutador(aprovadoId, 'aprovado');
  db.definirStatusRecrutador(reprovadoId, 'reprovado');
  db.definirStatusRecrutador(analiseId, 'em_analise');

  const r = publico.listarPublicoStatusCandidatura(j, ['aprovado', 'reprovado']);
  assert.deepEqual(tels(r), ['5547900000602', '5547900000603'].sort());
});

test('status_candidatura: statusList vazio/ausente LANCA (nao devolve "todos", desvio de padrao deliberado)', () => {
  zerarSeg();
  const j = vagaCom('Joinville');
  const aprovadoId = candidatura(j, 'Aprovado', '+55 47 90000-0605');
  db.definirStatusRecrutador(aprovadoId, 'aprovado');

  assert.throws(() => publico.listarPublicoStatusCandidatura(j, []), /pelo menos um status/);
  assert.throws(() => publico.listarPublicoStatusCandidatura(j, undefined), /pelo menos um status/);
  assert.throws(() => publico.listarPublicoStatusCandidatura(j, ['status_inventado']), /pelo menos um status/);
});

test('status_candidatura: job_id invalido LANCA', () => {
  zerarSeg();
  for (const ruim of [null, 0, -1, 'abc', undefined]) {
    assert.throws(() => publico.listarPublicoStatusCandidatura(ruim, ['aprovado']), /job_id valido/);
  }
});

test('status_candidatura: exclui quem tem status_recrutador NULL ("sem decisao"), mesmo que a vaga bata', () => {
  zerarSeg();
  const j = vagaCom('Joinville');
  const semDecisaoId = candidatura(j, 'Sem Decisao', '+55 47 90000-0606');
  const aprovadoId = candidatura(j, 'Aprovado', '+55 47 90000-0607');
  db.definirStatusRecrutador(aprovadoId, 'aprovado');
  // semDecisaoId fica sem tocar status_recrutador — nasce NULL.

  const r = publico.listarPublicoStatusCandidatura(j, ['aprovado', 'reprovado', 'em_analise']);
  assert.deepEqual(tels(r), ['5547900000607']);
});

test('status_candidatura: exclusao ESTRUTURAL de talentos (nem aparecem na consulta)', () => {
  zerarSeg();
  const j = vagaCom('Joinville');
  const aprovadoId = candidatura(j, 'Aprovado', '+55 47 90000-0608');
  db.definirStatusRecrutador(aprovadoId, 'aprovado');
  // Talento na MESMA cidade, sem relacao nenhuma com a vaga — nao tem job_id nem
  // status_recrutador possivel (a tabela nao tem essa coluna).
  legado('So Legado', '+55 47 90000-0609', 'Joinville');

  const r = publico.listarPublicoStatusCandidatura(j, ['aprovado']);
  assert.deepEqual(tels(r), ['5547900000608']);
  assert.ok(r.itens.every((i) => i.origemTipo === 'application'));
});

test('status_candidatura: candidatura de OUTRA vaga com o mesmo status fica de fora', () => {
  zerarSeg();
  const alvo = vagaCom('Joinville');
  const outra = vagaCom('Curitiba');
  const daVagaAlvo = candidatura(alvo, 'Da Vaga Alvo', '+55 47 90000-0610');
  const deOutraVaga = candidatura(outra, 'De Outra Vaga', '+55 41 90000-0611');
  db.definirStatusRecrutador(daVagaAlvo, 'aprovado');
  db.definirStatusRecrutador(deOutraVaga, 'aprovado');

  const r = publico.listarPublicoStatusCandidatura(alvo, ['aprovado']);
  assert.deepEqual(tels(r), ['5547900000610']);
});

test('status_candidatura: opt-out e telefoneUtilizavel valem aqui tambem (mesmo padrao dos outros dois tipos)', () => {
  zerarSeg();
  const j = vagaCom('Joinville');
  const optOutId = candidatura(j, 'Opt Out', '+55 47 90000-0612');
  const corrompidoId = candidatura(j, 'Corrompido', '+55 +5547900000613'); // DDI duplicado
  const validoId = candidatura(j, 'Valido', '+55 47 90000-0614');
  db.definirStatusRecrutador(optOutId, 'aprovado');
  db.definirStatusRecrutador(corrompidoId, 'aprovado');
  db.definirStatusRecrutador(validoId, 'aprovado');
  db.registrarOptOutWhatsapp('5547900000612', 'resposta_webhook');

  const r = semRuido(() => publico.listarPublicoStatusCandidatura(j, ['aprovado'])).r;
  assert.deepEqual(tels(r), ['5547900000614']);
});

// ══════════════════ montarContextoWhatsapp (envio avulso de teste) ══════════════════
//
// ETAPA B, Incremento 3. Contexto a partir de UM application_id, sem fila materializada e
// sem campanha — usado pelo envio avulso de teste. NAO e chamado pelo loop do ciclo acima
// (ver o comentario extenso ao lado da funcao, em src/lib/campanhaWhatsapp.js): cargo_vaga
// e link_vaga do ciclo vem da vaga que a CAMPANHA divulga, aqui vem da vaga a que O PROPRIO
// CANDIDATO se candidatou — sao perguntas diferentes, e so coincidem por acaso.

test('montarContextoWhatsapp: contexto correto a partir de UM candidato, com vaga e cidade resolviveis', () => {
  zerarSeg();
  const j = vagaCom('Joinville', 'SDR');
  exec('INSERT INTO regioes_grupos_whatsapp (cidade, link_convite_grupo) VALUES (?, ?)', 'Joinville', 'https://chat.whatsapp.com/TESTE123');
  const appId = candidatura(j, 'Ana Paula Silva', '+55 47 90000-0201');
  const tituloEsperado = uma('SELECT titulo FROM jobs WHERE id = ?', j).titulo;

  const ctx = job.montarContextoWhatsapp(appId);
  assert.equal(ctx.nome_primeiro, 'Ana');
  assert.equal(ctx.cargo_vaga, tituloEsperado);
  assert.equal(ctx.cidade, 'Joinville');
  assert.equal(ctx.link_grupo_regiao, 'https://chat.whatsapp.com/TESTE123');
  assert.match(ctx.link_vaga, /\/vaga\//);
  assert.match(ctx.link_vaga, /utm_source=whatsapp/);
  // Sem campanha por tras: nao ha campanha_whatsapp_id nenhum para carimbar no link.
  assert.doesNotMatch(ctx.link_vaga, /campanha_whatsapp_id=/);
});

test('montarContextoWhatsapp: cidade sem link de grupo cadastrado NAO lanca, so devolve link vazio', () => {
  zerarSeg();
  const j = vagaCom('Curitiba'); // sem INSERT em regioes_grupos_whatsapp
  const appId = candidatura(j, 'Sem Link', '+55 41 90000-0202');

  const ctx = job.montarContextoWhatsapp(appId);
  assert.equal(ctx.cidade, 'Curitiba');
  assert.equal(ctx.link_grupo_regiao, '');
});

test('montarContextoWhatsapp: application_id inexistente lanca erro claro', () => {
  zerarSeg();
  assert.throws(() => job.montarContextoWhatsapp(999999), /nao encontrada/);
});

test('montarContextoWhatsapp: application sem vaga associada (job_id nao resolve) lanca erro claro', () => {
  zerarSeg();
  const j = vagaCom('Joinville');
  const appId = candidatura(j, 'Vaga Sumiu', '+55 47 90000-0203');
  // Nao ha fluxo real de produto para isto — applications.job_id e FK NOT NULL —, mas a
  // funcao precisa recusar mesmo assim, defensivamente, em vez de devolver contexto parcial.
  exec('PRAGMA foreign_keys = OFF');
  try {
    exec('DELETE FROM jobs WHERE id = ?', j);
  } finally {
    exec('PRAGMA foreign_keys = ON');
  }
  assert.throws(() => job.montarContextoWhatsapp(appId), /vaga associada/);
});

test('montarContextoWhatsapp: NAO e a mesma resolucao do ciclo (job continua usando a vaga da CAMPANHA, nao a do candidato)', async () => {
  // Prova de nao-regressao: o ciclo (processarCicloCampanhaWhatsapp) continua resolvendo
  // cargo_vaga/link_vaga a partir da linha materializada (vaga da CAMPANHA), mesmo depois de
  // montarContextoWhatsapp existir. Um destinatario de divulgacao_vaga nunca tem job_id igual
  // ao alvo (e invariante — ver publicoCampanhaWhatsapp), entao se o ciclo passasse a chamar
  // montarContextoWhatsapp(origem_id) por engano, o cargo_vaga do envio mudaria de "a vaga
  // divulgada" para "a vaga do candidato" — regressao silenciosa de conteudo de mensagem.
  zerar();
  db.definirConfigBool(job.CHAVE_ATIVO, true);
  const { cid } = montarCenario();
  adicionar(cid, '5547999582500', 'Ana Paula', 'Joinville');

  const recebido = [];
  await semRuido(() =>
    job.processarCicloCampanhaWhatsapp(deps({
      enviarTemplate: async (a) => { recebido.push(a); return { wamid: 'w' }; },
    })));

  // montarCenario() e uma campanha convite_grupo (sem job_id) — cargo_vaga fica vazio, como
  // sempre foi. Se o ciclo tivesse passado a usar montarContextoWhatsapp(origem_id=1, que
  // aqui e um id de TALENTO, nao de application), a chamada teria estourado (application 1
  // pode nem existir) ou resolvido o campo errado.
  assert.deepEqual(recebido[0].variaveis, ['Ana', '', 'https://chat.whatsapp.com/ABC123']);
});

// ══════════════════ montarUrlVaga parametrizado ══════════════════

test('montarUrlVaga: o comportamento do E-MAIL nao mudou', () => {
  // Nao-regressao: o default de utmSource e a constante de sempre.
  const u = new URL(montarUrlVaga('vaga-x', { campanhaId: 7 }));
  assert.equal(u.searchParams.get('utm_source'), UTM_SOURCE_CAMPANHA);
  assert.equal(u.searchParams.get('utm_source'), 'email');
  assert.equal(u.searchParams.get('campanha_id'), '7');
  assert.equal(u.searchParams.get('campanha_whatsapp_id'), null);
});

test('montarUrlVaga: whatsapp usa a coluna IRMA, nao a do e-mail', () => {
  const u = new URL(montarUrlVaga('vaga-x', { utmSource: UTM_SOURCE_WHATSAPP, campanhaWhatsappId: 7 }));
  assert.equal(u.searchParams.get('utm_source'), 'whatsapp');
  // Passar o id de uma campanha de WhatsApp como campanha_id atribuiria o clique a campanha
  // de E-MAIL de mesmo id, sem erro nenhum.
  assert.equal(u.searchParams.get('campanha_whatsapp_id'), '7');
  assert.equal(u.searchParams.get('campanha_id'), null);
});

test('montarUrlVaga: id invalido nao vira parametro', () => {
  for (const ruim of [0, -1, 'abc', null, undefined]) {
    const u = new URL(montarUrlVaga('vaga-x', { campanhaWhatsappId: ruim }));
    assert.equal(u.searchParams.get('campanha_whatsapp_id'), null, String(ruim));
  }
});

// ══════════════════ Paridade entre os dois motores por telefone ══════════════════
//
// A auditoria encontrou os dois motores de publico POR TELEFONE discordando: o do disparo
// pontual (publicoDisparoWhatsapp, consumido pelo n8n) aplicava a guarda de ida-e-volta antes
// de incluir alguem; o da campanha Meta nao. Seis registros REAIS de producao (applications
// ids 165, 210, 336, 513, 684, 741) eram excluidos por um e incluidos pelo outro.
//
// O estrago do lado do motor novo nao era "alguem fica de fora": era materializar um numero
// que NAO EXISTE — que a Meta ou recusa (gastando tier) ou entrega a OUTRA pessoa.
//
// Os testes abaixo existem em duas camadas: um reproduz o caso exato encontrado, e o outro e
// de PARIDADE — feito para pegar a PROXIMA divergencia, nao esta.

const disparoPontual = require('../src/lib/publicoDisparoWhatsapp');

// Os brutos REAIS dos 6 registros que a auditoria apontou, mais os padroes vizinhos.
const TELEFONES_DA_AUDITORIA = [
  // ── quebrados: normalizam, mas o resultado nao sobrevive a ida e volta ──
  ['+55 +551998115119', false, 'id 336 — DDI duplicado E curto'],
  ['+55 119972122344', false, 'id 165 — 12 digitos apos o DDI'],
  ['+55 119836100077', false, 'id 210 — idem'],
  ['+55 (19) 9999354073', false, 'id 513 — 10 apos o DDD'],
  ['+351 912437103', false, 'id 741 — Portugal; limitacao BR-only, nao dado ruim'],
  ['+55 +5547988301250', false, 'padrao dos 44 ja corrigidos'],
  // ── validos ──
  ['+55 (47) 99958-2500', true, 'formulario com mascara'],
  ['+55 47989251350', true, 'legado sem mascara'],
  ['+55 55987711950', true, 'DDD 55 (RS) — 13 digitos, NAO e DDI duplicado'],
  ['+55 4733334444', true, 'fixo, 12 digitos'],
  // ── nem normalizam ──
  ['123', false, 'curto demais'],
  ['nao tenho', false, 'sem digitos'],
  ['+55 199831863', false, 'id 684 — 11 digitos, curto'],
];

test('o caso EXATO da auditoria: DDI duplicado fica fora dos DOIS tipos de campanha', () => {
  zerarSeg();
  const j = vagaCom('Joinville');
  // applications id 336 de producao, bruto identico.
  candidatura(j, 'Ana Corrompida', '+55 +551998115119');
  candidatura(j, 'Ana Valida', '+55 47 99958-2500');
  legado('Legado Corrompido', '+55 +5547988301250', 'Joinville');

  const convite = semRuido(() => publico.listarPublicoConviteGrupo({})).r;
  const divulgacao = semRuido(() => publico.listarPublicoDivulgacaoVaga(vagaCom('Joinville'), {})).r;

  // So o valido entra, nas duas funcoes.
  assert.deepEqual(tels(convite), ['5547999582500']);
  assert.deepEqual(tels(divulgacao), ['5547999582500']);
  // E o numero corrompido nao aparece em lugar nenhum da saida — nem como chave de dedup.
  for (const r of [convite, divulgacao]) {
    assert.equal(r.itens.some((i) => i.telefone.startsWith('5555')), false);
    assert.equal(r.itens.some((i) => i.telefone.length > 13), false);
  }
});

test('PARIDADE: os dois motores concordam sobre o que e utilizavel', async () => {
  // Este teste nao existe para a divergencia que ja foi corrigida — existe para a PROXIMA.
  // Se alguem mexer na guarda de um motor e nao do outro, ele quebra aqui.
  zerarSeg();
  const j = vagaCom('Joinville');
  const esperados = [];

  for (const [bruto, deveEntrar, rotulo] of TELEFONES_DA_AUDITORIA) {
    legado(`P ${rotulo}`, bruto, 'Joinville');
    if (deveEntrar) esperados.push(normalizarTelefoneWhatsapp(bruto));
  }

  // Motor NOVO (campanha Meta).
  const doNovo = new Set((await semRuido(() => publico.listarPublicoConviteGrupo({}))).r.itens.map((i) => i.telefone));
  // Motor ANTIGO (disparo pontual, consumido pelo n8n). Assincrono desde o Incremento 4
  // (checagem de existencia real via onWhatsAppLote) — sem socket em teste, tudo "nao
  // verificado" (null), que NAO exclui; o resultado observado e o mesmo de antes.
  const doAntigo = new Set(
    (await semRuido(() => disparoPontual.listarPendentesPorCidade('Joinville'))).r.map((i) => i.telefone),
  );

  // Concordam entre si...
  assert.deepEqual([...doNovo].sort(), [...doAntigo].sort(), 'os dois motores divergiram');
  // ...e concordam com o esperado, para o teste nao passar por os dois estarem igualmente
  // errados.
  assert.deepEqual([...doNovo].sort(), esperados.sort());
});

test('PARIDADE: a guarda e a MESMA funcao, nao uma copia', () => {
  // Recopiar a regra seria garantir que os dois divergissem no primeiro ajuste. O import
  // compartilhado e o que torna a paridade estrutural, e nao coincidencia.
  assert.equal(typeof disparoPontual.telefoneUtilizavel, 'function');
  for (const [bruto, deveEntrar] of TELEFONES_DA_AUDITORIA) {
    const n = normalizarTelefoneWhatsapp(bruto);
    if (!n) continue; // nem normaliza: os dois descartam antes da guarda
    assert.equal(
      semRuido(() => disparoPontual.telefoneUtilizavel(n, 'teste')).r,
      deveEntrar,
      `${bruto} -> ${n}`,
    );
  }
});

// ══════════════════ ETAPA B, Incremento 5: rotas de envio avulso de teste ══════════════════
//
// GET /buscar-candidato NAO toca transporte nenhum (so banco) — testada contra o app REAL
// via comAdmin, mesma disciplina do resto do arquivo, inclusive a exigencia de sessao.
//
// POST /enviar-teste chama enviarTemplate com forcarEnvioReal:true — que FURA o mock por
// definicao (Incremento 4). Contra o app real isso chamaria fetch() de verdade. Por isso
// esta suite NUNCA testa /enviar-teste via comAdmin/criarApp(): monta uma instancia isolada
// do router com um `transporte` FALSO injetado (o mesmo parametro que existe em
// admin_campanha_whatsapp.js exatamente para isto), presa a uma porta efemera propria. Zero
// rede real acontece em qualquer teste deste arquivo — aqui e o ponto do projeto onde isso
// seria mais facil de escorregar, entao a garantia fica estrutural (o fetch global nem e
// alcancavel a partir do transporte falso), nao so "nao esqueci de mockar".
async function comRotaEnviarTeste(transporte, fn) {
  const app = express();
  app.use(express.json());
  app.use(express.urlencoded({ extended: true }));
  app.use(
    '/admin/campanhas-whatsapp',
    criarRouterCampanhaWhatsapp({
      paginaAdmin: () => '',
      escapeHtml,
      fmtInt: String,
      sanearBusca: (s) => String(s || '').trim(),
      transporte,
    }),
  );
  const server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  try {
    return await fn(`http://127.0.0.1:${server.address().port}`);
  } finally {
    await new Promise((r) => server.close(r));
  }
}

// Transporte que FALHA se enviarTemplate for chamado — para os testes de rejeicao, onde a
// prova que importa e "a rede nunca foi tocada", nao so o codigo de status HTTP devolvido.
const transporteNuncaChamado = {
  enviarTemplate: async () => {
    throw new Error('enviarTemplate NAO deveria ter sido chamado para este cenario');
  },
  classificarErroCentralWhats: transporte.classificarErroCentralWhats,
};

const enviarTestePost = (base, body) =>
  fetch(`${base}/admin/campanhas-whatsapp/enviar-teste`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

test('GET /buscar-candidato: exige sessao, igual as demais rotas', async () => {
  await comServidor(async (base) => {
    const res = await fetch(`${base}/admin/campanhas-whatsapp/buscar-candidato?q=ana`, { redirect: 'manual' });
    assert.equal(res.status, 302);
    assert.match(res.headers.get('location') || '', /\/admin\/login/);
  });
});

test('GET /buscar-candidato: acha por sobrenome, devolve id/nome/sobrenome/telefone/vaga_titulo, ate 10', async () => {
  zerarSeg();
  const j = vagaCom('Joinville');
  // candidatura() (helper de segmentacao) so preenche `nome` — para exercitar `sobrenome`
  // de verdade (coluna propria em applications) este teste insere direto.
  seqSeg += 1;
  const idAlvo = Number(
    exec(
      'INSERT INTO applications (job_id, nome, sobrenome, telefone, token) VALUES (?, ?, ?, ?, ?)',
      j, 'Fernanda', 'Buscavel Oliveira', '+55 47 90000-0300', `tok-busca-${seqSeg}`,
    ).lastInsertRowid,
  );
  candidatura(j, 'Outra Pessoa', '+55 47 90000-0301');

  await comAdmin(async (base, h) => {
    const res = await fetch(`${base}/admin/campanhas-whatsapp/buscar-candidato?q=Buscavel`, { headers: h });
    assert.equal(res.status, 200);
    const corpo = await res.json();
    assert.equal(Array.isArray(corpo), true);
    assert.equal(corpo.length, 1);
    assert.equal(corpo[0].id, idAlvo);
    assert.equal(corpo[0].nome, 'Fernanda');
    assert.equal(corpo[0].sobrenome, 'Buscavel Oliveira');
    assert.equal(corpo[0].telefone, '+55 47 90000-0300');
    assert.ok(corpo[0].vaga_titulo);
  });
});

test('GET /buscar-candidato: sem match nenhum devolve array vazio, HTTP 200', async () => {
  zerarSeg();
  await comAdmin(async (base, h) => {
    const res = await fetch(`${base}/admin/campanhas-whatsapp/buscar-candidato?q=NomeQueNaoExisteEmLugarNenhum`, { headers: h });
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), []);
  });
});

test('GET /buscar-candidato: query vazia devolve [] sem consultar (nao lista os mais recentes)', async () => {
  zerarSeg();
  const j = vagaCom('Joinville');
  candidatura(j, 'Alguem', '+55 47 90000-0302');
  await comAdmin(async (base, h) => {
    const res = await fetch(`${base}/admin/campanhas-whatsapp/buscar-candidato?q=`, { headers: h });
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), []);
  });
});

test('POST /enviar-teste: fluxo feliz — contexto do candidato, forcarEnvioReal:true, wamid devolvido', async () => {
  zerarSeg();
  const j = vagaCom('Joinville', 'SDR');
  exec('INSERT INTO regioes_grupos_whatsapp (cidade, link_convite_grupo) VALUES (?, ?)', 'Joinville', 'https://chat.whatsapp.com/FELIZ');
  const appId = candidatura(j, 'Carla Feliz', '+55 47 99958-2500');
  const tid = Number(
    exec(
      'INSERT INTO templates_whatsapp (nome_meta, idioma, categoria, variaveis) VALUES (?, ?, ?, ?)',
      TEMPLATE.nome_meta, TEMPLATE.idioma, 'utility', JSON.stringify(TEMPLATE.variaveis),
    ).lastInsertRowid,
  );

  const chamadas = [];
  const transporteFalso = {
    enviarTemplate: async (args) => {
      chamadas.push(args);
      return { wamid: 'wamid-teste-avulso-123', mock: false };
    },
    classificarErroCentralWhats: transporte.classificarErroCentralWhats,
  };

  await comRotaEnviarTeste(transporteFalso, async (base) => {
    const res = await enviarTestePost(base, {
      applicationId: appId,
      templateId: tid,
      telefoneDestino: '+55 47 98888-7777',
    });
    assert.equal(res.status, 200);
    const corpo = await res.json();
    assert.equal(corpo.ok, true);
    assert.equal(corpo.wamid, 'wamid-teste-avulso-123');
    // Variaveis resolvidas com os dados do CANDIDATO escolhido, na ordem do template
    // (nome_primeiro, cargo_vaga, link_grupo_regiao).
    assert.equal(corpo.variaveis.length, 3);
    assert.equal(corpo.variaveis[0], 'Carla');
    assert.match(corpo.variaveis[1], /^Vaga \d+$/); // cargo_vaga = titulo real da vaga do candidato
    assert.equal(corpo.variaveis[2], 'https://chat.whatsapp.com/FELIZ');
  });

  assert.equal(chamadas.length, 1);
  // O UNICO ponto do projeto que chama enviarTemplate com forcarEnvioReal:true a partir de
  // uma rota HTTP.
  assert.equal(chamadas[0].forcarEnvioReal, true);
  assert.equal(chamadas[0].telefone, '5547988887777'); // normalizado, digitado pelo operador
  assert.equal(chamadas[0].template.nome_meta, TEMPLATE.nome_meta);
});

test('POST /enviar-teste: o telefone digitado sobrevive a ida e volta (round-trip) antes de chegar ao transporte', async () => {
  // Ponto cego recorrente do projeto (ver o cabecalho de lib/publicoDisparoWhatsapp): um
  // telefone que normaliza mas nao sobrevive a ida e volta materializa um numero que a Meta
  // ou recusa ou entrega a OUTRA pessoa. validarTelefoneBrEstrito ja e estrito o bastante
  // para nao deixar isso passar, mas esta rota e um destino NOVO para telefone digitado por
  // gente — a prova fica aqui, e nao so no teste generico da funcao.
  zerarSeg();
  const j = vagaCom('Joinville');
  const appId = candidatura(j, 'Round Trip', '+55 47 99958-2500');
  const tid = Number(
    exec(
      'INSERT INTO templates_whatsapp (nome_meta, idioma, categoria, variaveis) VALUES (?, ?, ?, ?)',
      TEMPLATE.nome_meta, TEMPLATE.idioma, 'utility', JSON.stringify(TEMPLATE.variaveis),
    ).lastInsertRowid,
  );

  const chamadas = [];
  const transporteFalso = {
    enviarTemplate: async (args) => {
      chamadas.push(args);
      return { wamid: 'w', mock: false };
    },
    classificarErroCentralWhats: transporte.classificarErroCentralWhats,
  };

  await comRotaEnviarTeste(transporteFalso, async (base) => {
    for (const digitado of ['+55 47 98888-7777', '+5547988887777', '47988887777']) {
      const res = await enviarTestePost(base, { applicationId: appId, templateId: tid, telefoneDestino: digitado });
      assert.equal(res.status, 200, digitado);
    }
  });

  assert.equal(chamadas.length, 3);
  for (const c of chamadas) {
    // O MESMO contrato de ida-e-volta usado no resto do projeto: normalizarTelefoneRecebido
    // aplicado ao valor ja normalizado tem que devolver ele mesmo, sem alteracao.
    assert.equal(normalizarTelefoneRecebido(c.telefone), c.telefone, c.telefone);
    assert.equal(c.telefone, '5547988887777');
  }
});

test('POST /enviar-teste: NAO grava em campanha_whatsapp_envios (e teste avulso, nao campanha)', async () => {
  zerarSeg();
  const j = vagaCom('Joinville');
  const appId = candidatura(j, 'Nao Materializa', '+55 47 99958-2500');
  const tid = Number(
    exec(
      'INSERT INTO templates_whatsapp (nome_meta, idioma, categoria, variaveis) VALUES (?, ?, ?, ?)',
      TEMPLATE.nome_meta, TEMPLATE.idioma, 'utility', JSON.stringify(TEMPLATE.variaveis),
    ).lastInsertRowid,
  );
  const transporteFalso = {
    enviarTemplate: async () => ({ wamid: 'w', mock: false }),
    classificarErroCentralWhats: transporte.classificarErroCentralWhats,
  };

  await comRotaEnviarTeste(transporteFalso, async (base) => {
    const res = await enviarTestePost(base, { applicationId: appId, templateId: tid, telefoneDestino: '+55 47 98888-7777' });
    assert.equal(res.status, 200);
  });

  assert.equal(todas('SELECT * FROM campanha_whatsapp_envios').length, 0);
});

test('POST /enviar-teste: telefone invalido e rejeitado ANTES de qualquer chamada externa', async () => {
  zerarSeg();
  const j = vagaCom('Joinville');
  const appId = candidatura(j, 'Alvo', '+55 47 99958-2500');
  const tid = Number(
    exec(
      'INSERT INTO templates_whatsapp (nome_meta, idioma, categoria, variaveis) VALUES (?, ?, ?, ?)',
      TEMPLATE.nome_meta, TEMPLATE.idioma, 'utility', JSON.stringify(TEMPLATE.variaveis),
    ).lastInsertRowid,
  );

  await comRotaEnviarTeste(transporteNuncaChamado, async (base) => {
    for (const ruim of ['123', 'nao e telefone', '+55 199831863', '+55 47 3333']) {
      const res = await enviarTestePost(base, { applicationId: appId, templateId: tid, telefoneDestino: ruim });
      assert.equal(res.status, 400, ruim);
      const corpo = await res.json();
      assert.equal(corpo.ok, false);
      assert.match(corpo.erro, /[Tt]elefone/);
    }
  });
});

test('POST /enviar-teste: application_id inexistente retorna erro claro, sem chamar a rede', async () => {
  zerarSeg();
  const tid = Number(
    exec(
      'INSERT INTO templates_whatsapp (nome_meta, idioma, categoria, variaveis) VALUES (?, ?, ?, ?)',
      TEMPLATE.nome_meta, TEMPLATE.idioma, 'utility', JSON.stringify(TEMPLATE.variaveis),
    ).lastInsertRowid,
  );

  await comRotaEnviarTeste(transporteNuncaChamado, async (base) => {
    const res = await enviarTestePost(base, { applicationId: 999999, templateId: tid, telefoneDestino: '+55 47 98888-7777' });
    assert.equal(res.status, 400);
    const corpo = await res.json();
    assert.equal(corpo.ok, false);
    assert.match(corpo.erro, /nao encontrada/);
  });
});

test('POST /enviar-teste: template inexistente retorna erro claro, sem chamar a rede', async () => {
  zerarSeg();
  const j = vagaCom('Joinville');
  const appId = candidatura(j, 'Alvo', '+55 47 99958-2500');

  await comRotaEnviarTeste(transporteNuncaChamado, async (base) => {
    const res = await enviarTestePost(base, { applicationId: appId, templateId: 999999, telefoneDestino: '+55 47 98888-7777' });
    assert.equal(res.status, 400);
    const corpo = await res.json();
    assert.equal(corpo.ok, false);
    assert.match(corpo.erro, /[Tt]emplate/);
  });
});

test('POST /enviar-teste: erro do transporte volta classificado, sem derrubar a rota', async () => {
  zerarSeg();
  const j = vagaCom('Joinville');
  const appId = candidatura(j, 'Alvo', '+55 47 99958-2500');
  const tid = Number(
    exec(
      'INSERT INTO templates_whatsapp (nome_meta, idioma, categoria, variaveis) VALUES (?, ?, ?, ?)',
      TEMPLATE.nome_meta, TEMPLATE.idioma, 'utility', JSON.stringify(TEMPLATE.variaveis),
    ).lastInsertRowid,
  );
  const transporteFalso = {
    enviarTemplate: async () => { throw new Error('HTTP 400 — template nao sincronizado no Central Whats'); },
    classificarErroCentralWhats: transporte.classificarErroCentralWhats,
  };

  await comRotaEnviarTeste(transporteFalso, async (base) => {
    const res = await enviarTestePost(base, { applicationId: appId, templateId: tid, telefoneDestino: '+55 47 98888-7777' });
    assert.equal(res.status, 502);
    const corpo = await res.json();
    assert.equal(corpo.ok, false);
    assert.equal(corpo.categoria, 'terminal');
    assert.match(corpo.erro, /template nao sincronizado/);
  });
});

// ══════════════════ button0 dinamico (Incremento 2, diagnostico 2026-08-26/27) ══════════════════
//
// convite_grupo_vagas_vm tem um botao de URL DINAMICA na Meta: cada envio precisa do
// PARAMETRO do botao (button0), nao so das variaveis de corpo — confirmado contra o Central
// Whats de verdade (HTTP 400 real, ver o diagnostico da sessao anterior). O teste abaixo
// reproduz essa validacao num FAKE do transporte construido em cima do `montarPayload` REAL
// (nao reimplementado a parte, pra nao divergir do contrato de verdade): se o payload
// montado nao tiver vars.button0 para este template, o fake lanca o MESMO erro 400 que a
// Central Whats devolveu em producao.
//
// BUG-PRA-CONFIRMAR: com `parametrosBotao` removido da rota (POST /enviar-teste em
// admin_campanha_whatsapp.js), este teste FALHA com HTTP 502 e a mensagem de button0 — testado
// manualmente comentando a linha antes de reaplicar o fix. Com o fix, passa.
const transporteBotaoDinamico = {
  enviarTemplate: async (args) => {
    const payload = transporte.montarPayload(args);
    if (args.template.nome_meta === 'convite_grupo_vagas_vm' && !payload.vars.button0) {
      throw new Error(
        'Central Whats retornou HTTP 400 — {"error":"Template \\"convite_grupo_vagas_vm\\": o ' +
          'botão de índice 0 tem URL dinâmica e exige a variável \\"button0\\", que não foi ' +
          'informada."}',
      );
    }
    return { wamid: 'wamid-botao-dinamico-ok', mock: false };
  },
  classificarErroCentralWhats: transporte.classificarErroCentralWhats,
};

test('POST /enviar-teste: convite_grupo_vagas_vm manda o link do grupo como button0 (botao de URL dinamica)', async () => {
  zerarSeg();
  const j = vagaCom('Joinville');
  exec(
    'INSERT INTO regioes_grupos_whatsapp (cidade, link_convite_grupo) VALUES (?, ?)',
    'Joinville', 'https://chat.whatsapp.com/BOTAODINAMICO',
  );
  const appId = candidatura(j, 'Botao Dinamico', '+55 47 99958-2500');
  const tid = Number(
    exec(
      'INSERT INTO templates_whatsapp (nome_meta, idioma, categoria, variaveis, botao_parametro_fixo) VALUES (?, ?, ?, ?, NULL)',
      'convite_grupo_vagas_vm', 'pt_BR', 'marketing',
      JSON.stringify([
        { posicao: 1, campo: 'nome_primeiro' },
        { posicao: 2, campo: 'cargo_vaga' },
        { posicao: 3, campo: 'cidade' },
      ]),
    ).lastInsertRowid,
  );

  await comRotaEnviarTeste(transporteBotaoDinamico, async (base) => {
    const res = await enviarTestePost(base, {
      applicationId: appId,
      templateId: tid,
      telefoneDestino: '+55 47 98888-7777',
    });
    const corpo = await res.json();
    assert.equal(res.status, 200, JSON.stringify(corpo));
    assert.equal(corpo.ok, true);
    assert.equal(corpo.wamid, 'wamid-botao-dinamico-ok');
  });
});

test('POST /enviar-teste: template fora da lista de botao dinamico NAO recebe parametrosBotao, mesmo com botao_parametro_fixo NULL', async () => {
  // nova_vaga_v1/v2 tambem tem botao_parametro_fixo NULL hoje (o mesmo estado de "sem botao"
  // documentado em schema.sql) — sem evidencia de botao dinamico. Prova que o gatilho e a
  // lista fechada (precisaBotaoDinamico, lib/templatesWhatsapp.js), nao "botao_parametro_fixo
  // === null" generico — generalizar mandaria button0 indevido pra este template.
  zerarSeg();
  const j = vagaCom('Joinville');
  exec(
    'INSERT INTO regioes_grupos_whatsapp (cidade, link_convite_grupo) VALUES (?, ?)',
    'Joinville', 'https://chat.whatsapp.com/NAODINAMICO',
  );
  const appId = candidatura(j, 'Sem Botao Dinamico', '+55 47 99958-2500');
  const tid = Number(
    exec(
      'INSERT INTO templates_whatsapp (nome_meta, idioma, categoria, variaveis, botao_parametro_fixo) VALUES (?, ?, ?, ?, NULL)',
      'nova_vaga_v1', 'pt_BR', 'marketing',
      JSON.stringify([
        { posicao: 1, campo: 'nome_primeiro' },
        { posicao: 2, campo: 'cargo_vaga' },
        { posicao: 3, campo: 'link_vaga' },
      ]),
    ).lastInsertRowid,
  );

  const chamadas = [];
  const transporteFalso = {
    enviarTemplate: async (args) => {
      chamadas.push(args);
      return { wamid: 'w', mock: false };
    },
    classificarErroCentralWhats: transporte.classificarErroCentralWhats,
  };

  await comRotaEnviarTeste(transporteFalso, async (base) => {
    const res = await enviarTestePost(base, { applicationId: appId, templateId: tid, telefoneDestino: '+55 47 98888-7777' });
    assert.equal(res.status, 200);
  });

  assert.equal(chamadas.length, 1);
  assert.equal(chamadas[0].parametrosBotao, undefined);
});

// ══════════════════ button0 dinamico no CICLO REAL (Incremento 3) ══════════════════
//
// Mesmo caso do Incremento 2, agora no caminho de campanha materializada
// (processarCicloCampanhaWhatsapp) — nao no envio avulso. Mesmo fake construido sobre
// montarPayload de verdade, reproduzindo a validacao real da Central Whats.
//
// BUG-PRA-CONFIRMAR: com `parametrosBotao` removido de lib/campanhaWhatsapp.js, este teste
// FALHA (resumo.enviados fica 0, resumo.falhas vira 1, e a linha da fila registra o erro
// 400 real) — testado manualmente comentando a linha antes de reaplicar o fix. Com o fix,
// passa.
test('ciclo: convite_grupo com botao dinamico manda o link do grupo como button0', async () => {
  zerar();
  db.definirConfigBool(job.CHAVE_ATIVO, true);
  const tid = Number(
    exec(
      'INSERT INTO templates_whatsapp (nome_meta, idioma, categoria, variaveis, botao_parametro_fixo) VALUES (?, ?, ?, ?, NULL)',
      'convite_grupo_vagas_vm', 'pt_BR', 'marketing',
      JSON.stringify([
        { posicao: 1, campo: 'nome_primeiro' },
        { posicao: 2, campo: 'cargo_vaga' },
        { posicao: 3, campo: 'cidade' },
      ]),
    ).lastInsertRowid,
  );
  exec(
    'INSERT INTO regioes_grupos_whatsapp (cidade, link_convite_grupo) VALUES (?, ?)',
    'Joinville', 'https://chat.whatsapp.com/CICLOBOTAODINAMICO',
  );
  const cid = db.criarCampanhaWhatsapp({ nome: 'Convite grupo botao dinamico', templateId: tid, baseAlvo: 'ambos' });
  db.definirStatusCampanhaWhatsapp(cid, 'ativa');
  adicionar(cid, '5547999582500', 'Ana Paula', 'Joinville');

  const recebido = [];
  const enviarTemplateFalso = async (args) => {
    recebido.push(args);
    const payload = transporte.montarPayload(args);
    if (args.template.nome_meta === 'convite_grupo_vagas_vm' && !payload.vars.button0) {
      throw new Error(
        'Central Whats retornou HTTP 400 — {"error":"Template \\"convite_grupo_vagas_vm\\": o ' +
          'botão de índice 0 tem URL dinâmica e exige a variável \\"button0\\", que não foi ' +
          'informada."}',
      );
    }
    return { wamid: 'wamid-ciclo-botao-ok' };
  };

  const { r: resumo } = await semRuido(() =>
    job.processarCicloCampanhaWhatsapp(deps({ enviarTemplate: enviarTemplateFalso })));

  assert.equal(recebido.length, 1);
  assert.equal(resumo.enviados, 1, JSON.stringify(resumo));
  assert.equal(resumo.falhas, 0, JSON.stringify(resumo));
  assert.equal(fila(cid)[0].status, 'enviado');
  assert.equal(fila(cid)[0].wamid, 'wamid-ciclo-botao-ok');
});
