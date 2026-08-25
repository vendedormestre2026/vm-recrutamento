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
const { montarConteudoCampanhaWhatsapp } = require('../src/routes/admin_campanha_whatsapp');
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
    regioes_grupos_whatsapp: ['id', 'cidade', 'link_convite_grupo', 'ativo', 'criado_em', 'atualizado_em'],
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

test('o payload NAO leva language — o idioma e resolvido do lado de la', () => {
  // O template sincronizado no Central Whats e quem decide o idioma. Mandar explicito daqui
  // pode produzir comportamento diferente do esperado, mesmo com o valor "certo".
  const p = transporte.montarPayload({
    telefone: '5547999582500',
    template: { ...TEMPLATE, idioma: 'pt_BR' },
    variaveis: ['Ana'],
  });
  assert.equal(p.template.language, undefined);
  assert.deepEqual(Object.keys(p.template), ['name']);
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
      template: { name: 'confirmacao_cadastro_vaga_vm' },
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

// ══════════════════ Motor de segmentacao (dois tipos) ══════════════════

const publico = require('../src/lib/publicoCampanhaWhatsapp');
const { normalizarTelefoneWhatsapp } = require('../src/lib/whatsapp');
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

// ══════════════════ ETAPA B: filtro de Vagas (candidatura) e Periodo ══════════════════

// Sobrescreve criado_em DEPOIS do insert (candidatura/legado gravam com o default now()).
// `dataIso` no formato YYYY-MM-DD; a hora fixa em meio-dia so evita ambiguidade de fuso.
function comCriadoEm(tabela, id, dataIso) {
  exec(`UPDATE ${tabela} SET criado_em = ? WHERE id = ?`, `${dataIso} 12:00:00`, id);
}

test('vagas: filtro vazio preserva o comportamento atual (sem recorte)', () => {
  zerarSeg();
  const j1 = vagaCom('Joinville');
  const j2 = vagaCom('Curitiba');
  candidatura(j1, 'Ana', '+55 47 90000-0100');
  candidatura(j2, 'Bia', '+55 41 90000-0101');
  legado('Legado', '+55 47 90000-0102', 'Joinville');

  const semFiltro = publico.listarPublicoConviteGrupo({});
  assert.deepEqual(tels(publico.listarPublicoConviteGrupo({ vagas: [] })), tels(semFiltro));
  assert.equal(semFiltro.total, 3);
});

test('vagas: recorta so quem se candidatou a uma das vagas marcadas, e EXCLUI toda a Base legada', () => {
  zerarSeg();
  const alvo = vagaCom('Joinville');
  const outra = vagaCom('Joinville');
  candidatura(alvo, 'Candidatou Alvo', '+55 47 90000-0103');
  candidatura(outra, 'Candidatou Outra', '+55 47 90000-0104');
  legado('So Legado', '+55 47 90000-0105', 'Joinville');

  const r = publico.listarPublicoConviteGrupo({ vagas: [alvo] });
  assert.deepEqual(tels(r), ['5547900000103']);

  // Mesmo recorte em divulgacao_vaga (vaga divulgada e uma TERCEIRA, sem relacao com o
  // filtro). Legado nunca tem job_id: mesmo com cidade batendo, sai sozinho — sem checkbox
  // de "incluir sem vaga".
  const rDivulgacao = publico.listarPublicoDivulgacaoVaga(vagaCom('Curitiba'), { vagas: [alvo] });
  assert.deepEqual(tels(rDivulgacao), ['5547900000103']);
});

test('vagas + divulgacao: a exclusao de "ja se candidatou ao ALVO" continua valendo mesmo quando o alvo esta FORA do filtro de vagas', () => {
  // Regressao do furo descrito em aplicarFiltroVagas: jobsInscritos usado pelo filtro tem
  // que ser o conjunto COMPLETO de vagas da pessoa, nao so as que sobrevivem ao filtro —
  // senao quem se candidatou a A (dentro do filtro) e TAMBEM ao alvo B (fora do filtro)
  // deixaria de ser excluido da divulgacao de B.
  zerarSeg();
  const vagaA = vagaCom('Joinville');
  const alvoB = vagaCom('Joinville');
  const telefone = '+55 47 90000-0106';
  candidatura(vagaA, 'Duas Vagas', telefone);
  candidatura(alvoB, 'Duas Vagas', telefone);

  const r = publico.listarPublicoDivulgacaoVaga(alvoB, { vagas: [vagaA] });
  assert.deepEqual(tels(r), []);
});

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

test('periodo + vagas juntos: periodo recorta a janela, vagas continua excluindo o legado', () => {
  zerarSeg();
  const alvo = vagaCom('Joinville');
  const dentro = candidatura(alvo, 'Dentro', '+55 47 90000-0113');
  const fora = candidatura(alvo, 'Fora da janela', '+55 47 90000-0114');
  comCriadoEm('applications', dentro, '2026-04-10');
  comCriadoEm('applications', fora, '2026-05-10');
  legado('Legado na janela', '+55 47 90000-0115', 'Joinville');

  const r = publico.listarPublicoConviteGrupo({
    vagas: [alvo],
    dataDe: '2026-04-01',
    dataAte: '2026-04-30',
  });
  assert.deepEqual(tels(r), ['5547900000113']);
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
