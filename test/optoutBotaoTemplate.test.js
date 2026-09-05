'use strict';

// B3: o parametro do BOTAO de descadastro nos templates de marketing.
//
// O teste que mais importa aqui e o do CASAMENTO DA URL: montar o link exatamente como a Meta
// monta (padrao aprovado do template + valor do parametro) e provar que ele bate com a rota
// que o servidor registra de verdade. Um padrao errado no template nao apareceria em teste
// nenhum de unidade — so como 404 no aparelho do candidato, que e onde ninguem esta olhando.

const os = require('node:os');
const path = require('node:path');

process.env.DATABASE_PATH = path.join(os.tmpdir(), `vm-test-botao-optout-${process.pid}-${Date.now()}.db`);
process.env.INTERVIEW_MOCK = 'true';
process.env.SESSION_SECRET = 'segredo-de-teste';
process.env.OPTOUT_TOKEN_SECRET = 'segredo-hmac-de-teste';
process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert/strict');

const db = require('../src/db');
const { migrar } = require('../src/db/migrate');
const { criarApp } = require('../src/server');
const { config } = require('../src/config');
const optout = require('../src/lib/optoutWhatsapp');
const campanha = require('../src/lib/campanhaWhatsapp');
const tpl = require('../src/lib/templatesWhatsapp');
const { lerTokenDescadastroWhatsapp } = require('../src/lib/descadastroWhatsapp');

migrar();

const exec = (sql, ...p) => db.getDb().prepare(sql).run(...p);

// Padrao de URL EXATAMENTE como o documento manda cadastrar na Meta.
const URL_BOTAO_DESCADASTRO = 'https://entrevista.vendedormestre.com.br/descadastro/{{1}}';
const URL_BOTAO_GRUPO = 'https://entrevista.vendedormestre.com.br/grupo/{{1}}';

function zerar() {
  exec('DELETE FROM campanha_whatsapp_envios');
  exec('DELETE FROM campanhas_whatsapp');
  exec('DELETE FROM templates_whatsapp');
  exec('DELETE FROM regioes_grupos_whatsapp');
  exec('DELETE FROM whatsapp_optout');
  exec("DELETE FROM configuracoes WHERE chave LIKE 'optout%'");
}

// Monta uma campanha de UM destinatario com o template e os botoes dados.
function cenario({ nomeMeta, botoes, telefone = '5547999582500' }) {
  const tid = Number(
    exec(
      `INSERT INTO templates_whatsapp (nome_meta, idioma, categoria, variaveis, botoes_json)
       VALUES (?, 'pt_BR', 'marketing', ?, ?)`,
      nomeMeta,
      JSON.stringify([{ posicao: 1, campo: 'nome_primeiro' }]),
      botoes === undefined ? null : JSON.stringify(botoes),
    ).lastInsertRowid,
  );
  const cid = Number(
    exec(
      `INSERT INTO campanhas_whatsapp (nome, template_id, base_alvo, tipo_mensagem, status)
       VALUES ('C', ?, 'ambos', 'divulgacao_vaga', 'ativa')`,
      tid,
    ).lastInsertRowid,
  );
  exec(
    `INSERT INTO campanha_whatsapp_envios (campanha_id, telefone, nome, origem_tipo, cidade, status)
     VALUES (?, ?, 'Ana', 'application', 'Joinville', 'pendente')`,
    cid,
    telefone,
  );
  db.definirConfigBool(campanha.CHAVE_ATIVO, true);
  return { tid, cid };
}

async function rodar() {
  const enviados = [];
  const r = await campanha.processarCicloCampanhaWhatsapp({
    enviarTemplate: async (args) => {
      enviados.push(args);
      return { wamid: 'w1' };
    },
    intervaloMs: 0,
  });
  return { r, enviados };
}

const botaoDescadastro = { indice: 0, tipo: 'URL', texto: 'Não quero mais receber', url: URL_BOTAO_DESCADASTRO };
const botaoGrupo = { indice: 0, tipo: 'URL', texto: 'Entrar no Grupo', url: URL_BOTAO_GRUPO };

// ══════════════════════════════════════════════════════════════
// Leitura dos botoes sincronizados
// ══════════════════════════════════════════════════════════════

test('extrairBotoes le o formato REAL do Central Whats (BUTTONS no plural)', () => {
  const componentes = [
    { type: 'BODY', text: 'Olá {{1}}' },
    {
      type: 'BUTTONS',
      buttons: [
        { type: 'URL', text: 'Entrar no Grupo', url: URL_BOTAO_GRUPO },
        { type: 'URL', text: 'Não quero mais receber', url: URL_BOTAO_DESCADASTRO },
      ],
    },
  ];
  const botoes = tpl.extrairBotoes(componentes);
  assert.equal(botoes.length, 2);
  assert.equal(botoes[0].indice, 0);
  assert.equal(botoes[1].indice, 1);
  assert.equal(tpl.indiceBotaoDescadastro(botoes), 1, 'o de descadastro e o SEGUNDO aqui');
});

test('indiceBotaoDescadastro: 0 quando o template nao tem outro botao', () => {
  assert.equal(tpl.indiceBotaoDescadastro([botaoDescadastro]), 0);
});

test('indiceBotaoDescadastro: null quando nao ha botao, ou nenhum aponta para /descadastro/', () => {
  assert.equal(tpl.indiceBotaoDescadastro([]), null);
  assert.equal(tpl.indiceBotaoDescadastro([botaoGrupo]), null);
  assert.equal(tpl.indiceBotaoDescadastro(null), null);
});

test('indiceBotaoDescadastro: botao ESTATICO para /descadastro/ nao conta', () => {
  // Sem placeholder, todo mundo receberia o mesmo link — e a pagina exige o token no caminho,
  // entao esse botao nao descadastraria ninguem.
  const estatico = { indice: 0, tipo: 'URL', texto: 'Sair', url: 'https://x/descadastro/' };
  assert.equal(tpl.indiceBotaoDescadastro([estatico]), null);
});

test('botoesDoTemplate tolera JSON invalido, null e array pronto', () => {
  assert.deepEqual(tpl.botoesDoTemplate(null), []);
  assert.deepEqual(tpl.botoesDoTemplate('{nao e json'), []);
  assert.deepEqual(tpl.botoesDoTemplate('{"a":1}'), []);
  assert.equal(tpl.botoesDoTemplate([botaoDescadastro]).length, 1);
});

test('o sync grava os botoes, e um sync seguinte ATUALIZA quando o template ganha botao', () => {
  zerar();
  const semBotao = { name: 'sync_botao_vm', status: 'APPROVED', category: 'MARKETING', language: 'pt_BR', components: [{ type: 'BODY', text: 'Oi {{1}}' }] };
  db.sincronizarTemplateWhatsapp(semBotao);
  let linha = db.getDb().prepare("SELECT botoes_json FROM templates_whatsapp WHERE nome_meta='sync_botao_vm'").get();
  assert.deepEqual(JSON.parse(linha.botoes_json), []);

  const comBotao = {
    ...semBotao,
    components: [
      { type: 'BODY', text: 'Oi {{1}}' },
      { type: 'BUTTONS', buttons: [{ type: 'URL', text: 'Não quero mais receber', url: URL_BOTAO_DESCADASTRO }] },
    ],
  };
  db.sincronizarTemplateWhatsapp(comBotao);
  linha = db.getDb().prepare("SELECT botoes_json FROM templates_whatsapp WHERE nome_meta='sync_botao_vm'").get();
  assert.equal(tpl.indiceBotaoDescadastro(tpl.botoesDoTemplate(linha.botoes_json)), 0);
});

// ══════════════════════════════════════════════════════════════
// O parametro no ciclo de envio
// ══════════════════════════════════════════════════════════════

test('interruptor DESLIGADO (o default): nao manda parametro de botao nenhum', async () => {
  zerar();
  cenario({ nomeMeta: 'sem_link_vm', botoes: [botaoDescadastro] });
  const { enviados } = await rodar();
  assert.equal(enviados[0].parametrosBotao, undefined);
});

test('interruptor LIGADO: manda o token no indice do botao de descadastro', async () => {
  zerar();
  cenario({ nomeMeta: 'com_link_vm', botoes: [botaoDescadastro] });
  db.definirConfigBool(optout.CHAVE_LINK_ATIVO, true);

  const { enviados } = await rodar();
  const p = enviados[0].parametrosBotao;
  assert.ok(p, 'precisa mandar parametro');
  assert.equal(lerTokenDescadastroWhatsapp(p[0]), '554799582500');
});

test('template com DOIS botoes: o token vai no indice 1, e o indice 0 continua sendo o grupo', async () => {
  zerar();
  // Reproduz convite_grupo_vagas_vm depois da alteracao: grupo no 0, descadastro no 1.
  exec(
    'INSERT INTO regioes_grupos_whatsapp (cidade, link_convite_grupo, slug) VALUES (?, ?, ?)',
    'Joinville', 'https://chat.whatsapp.com/X', 'joinville',
  );
  cenario({
    nomeMeta: 'convite_grupo_vagas_vm',
    botoes: [botaoGrupo, { indice: 1, tipo: 'URL', texto: 'Não quero mais receber', url: URL_BOTAO_DESCADASTRO }],
  });
  db.definirConfigBool(optout.CHAVE_LINK_ATIVO, true);

  const { enviados } = await rodar();
  const p = enviados[0].parametrosBotao;
  assert.equal(p[0], 'joinville', 'o botao do grupo NAO pode ser sobrescrito');
  assert.equal(lerTokenDescadastroWhatsapp(p[1]), '554799582500', 'o token vai no indice 1');
});

test('template SEM botao de descadastro: nao manda parametro e o envio segue', async () => {
  zerar();
  cenario({ nomeMeta: 'sem_botao_vm', botoes: [] });
  db.definirConfigBool(optout.CHAVE_LINK_ATIVO, true);

  const { r, enviados } = await rodar();
  assert.equal(r.enviados, 1, 'a mensagem sai mesmo assim');
  assert.equal(enviados[0].parametrosBotao, undefined);
});

test('botoes_json ausente (template nunca ressincronizado): trata como sem botao', async () => {
  zerar();
  cenario({ nomeMeta: 'nunca_sincronizado_vm', botoes: undefined });
  db.definirConfigBool(optout.CHAVE_LINK_ATIVO, true);

  const { r, enviados } = await rodar();
  assert.equal(r.enviados, 1);
  assert.equal(enviados[0].parametrosBotao, undefined);
});

test('falha ao gerar o token: envia SEM o parametro, nunca aborta o ciclo', async () => {
  zerar();
  cenario({ nomeMeta: 'token_quebrado_vm', botoes: [botaoDescadastro] });
  db.definirConfigBool(optout.CHAVE_LINK_ATIVO, true);

  const antigo = config.optoutToken.segredo;
  config.optoutToken.segredo = '';
  try {
    const { r, enviados } = await rodar();
    assert.equal(r.abortado, undefined, 'o ciclo NAO pode abortar por causa do botao');
    assert.equal(r.enviados, 1, 'a mensagem sai mesmo assim');
    assert.equal(enviados[0].parametrosBotao, undefined);
  } finally {
    config.optoutToken.segredo = antigo;
  }
});

test('NUNCA manda parametro de botao vazio (a condicao do 131008)', async () => {
  zerar();
  cenario({ nomeMeta: 'nunca_vazio_vm', botoes: [botaoDescadastro] });
  db.definirConfigBool(optout.CHAVE_LINK_ATIVO, true);

  const { enviados } = await rodar();
  for (const [k, v] of Object.entries(enviados[0].parametrosBotao || {})) {
    assert.notEqual(String(v).trim(), '', `parametro do botao ${k} saiu vazio`);
  }
});

// ══════════════════════════════════════════════════════════════
// CASAMENTO DA URL com a rota registrada
// ══════════════════════════════════════════════════════════════

test('a URL que a META monta bate com a rota real e abre a pagina de descadastro', async () => {
  zerar();
  cenario({ nomeMeta: 'url_casa_vm', botoes: [botaoDescadastro] });
  db.definirConfigBool(optout.CHAVE_LINK_ATIVO, true);

  const { enviados } = await rodar();
  const token = enviados[0].parametrosBotao[0];

  // Monta a URL como a Meta monta: padrao aprovado do template + valor do parametro.
  const urlFinal = tpl.montarUrlDoBotao(URL_BOTAO_DESCADASTRO, token);
  assert.doesNotMatch(urlFinal, /\{\{/, 'o placeholder tem que ter sumido');

  // E agora bate essa URL contra o servidor de verdade, pelo CAMINHO extraido dela.
  const caminho = new URL(urlFinal).pathname;
  const app = criarApp();
  const server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  try {
    const base = `http://127.0.0.1:${server.address().port}`;
    const antes = db.getDb().prepare('SELECT COUNT(*) AS n FROM whatsapp_optout').get().n;
    const res = await fetch(`${base}${caminho}`);
    assert.equal(res.status, 200, `a rota nao casou com ${caminho}`);
    assert.match(await res.text(), /Deseja parar de receber/);
    // E o GET continua sem escrever nada.
    assert.equal(db.getDb().prepare('SELECT COUNT(*) AS n FROM whatsapp_optout').get().n, antes);
  } finally {
    await new Promise((r) => server.close(r));
  }
});

test('o padrao de URL do documento tem o formato que a rota espera', () => {
  // Trava o texto que o documento manda cadastrar na Meta contra a rota registrada:
  // /descadastro/<token>, um unico segmento depois de /descadastro/.
  const urlFinal = tpl.montarUrlDoBotao(URL_BOTAO_DESCADASTRO, 'abc.def');
  const caminho = new URL(urlFinal).pathname;
  assert.equal(caminho, '/descadastro/abc.def');
  assert.equal(caminho.split('/').filter(Boolean).length, 2, 'exatamente /descadastro/<token>');
});
