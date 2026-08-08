'use strict';

// Descadastro (opt-out) da divulgacao de vagas: src/lib/descadastro.js, as duas funcoes
// de banco e as rotas publicas GET/POST /descadastro.
//
// O QUE ESTA EM JOGO: este e o caminho pelo qual uma pessoa exerce o direito de sair da
// lista. Se o token nao validar, ela nao consegue sair; se validar demais, qualquer um
// descadastra terceiros varrendo e-mails; e se o GET mudar estado, os scanners de
// seguranca de e-mail corporativo descadastram gente que nunca abriu a mensagem. Cada
// assercao abaixo guarda uma dessas fronteiras.
//
// NENHUMA REDE EXTERNA: o unico servidor que sobe e o proprio app, em porta efemera, no
// mesmo padrao de funil.test.js.
//
// DESCADASTRO_SECRET e definido ANTES do require de config, junto das demais envs: o
// modulo de config e lido uma vez e congelado no cache.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

process.env.DATABASE_PATH = path.join(os.tmpdir(), `vm-test-descadastro-${process.pid}-${Date.now()}.db`);
process.env.INTERVIEW_MOCK = 'true';
process.env.SESSION_SECRET = 'segredo-de-teste';
process.env.DESCADASTRO_SECRET = 'segredo-de-descadastro-de-teste';
// GTM/Pixel LIGADOS de proposito neste teste. Sem eles, config.rastreio fica vazio, os
// snippets saem vazios de qualquer jeito e a assercao de "nao carrega rastreio" passaria
// SEM EXERCITAR NADA — um teste verde que nao prova coisa alguma. Com os ids definidos, o
// teste de controle (GET /) confirma que as tags realmente entram nas demais paginas, e
// so entao a ausencia delas no /descadastro significa alguma coisa.
process.env.GTM_ID = 'GTM-TESTE00';
process.env.META_PIXEL_ID = '1234567890';
process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert/strict');

const db = require('../src/db');
const { migrar } = require('../src/db/migrate');
const { config } = require('../src/config');
const { criarApp } = require('../src/server');
const desc = require('../src/lib/descadastro');
const { normalizarEmail } = require('../src/lib/normalizarEmail');

migrar(); // a tabela descadastros precisa existir antes de qualquer coisa

// Sobe o app numa porta efemera, roda `fn(base)` e fecha o servidor. Mesmo helper de
// funil.test.js, extraido porque aqui ele se repete em varios testes.
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

// ── 0. O modulo-FOLHA da normalizacao ──

test('lib/normalizarEmail nao importa NADA do projeto (senao vira ciclo com o db)', () => {
  // A camada de dados (src/db/sqlite.js) importa este modulo. Se ele passar a depender de
  // qualquer coisa do projeto — config, db, outra lib —, abre a porta para um ciclo
  // db -> lib -> db que, em CommonJS, NAO falha no require: um dos lados recebe
  // module.exports pela metade e quebra em runtime, em producao. Este teste e a unica
  // coisa que impede alguem de acrescentar esse require sem perceber.
  const fonte = fs.readFileSync(
    path.join(__dirname, '..', 'src', 'lib', 'normalizarEmail.js'),
    'utf8',
  );
  // Comentarios fora antes de varrer: o cabecalho do modulo CITA require('../db') ao
  // explicar o ciclo que ele evita, e sem isto o proprio texto explicativo reprovaria o
  // arquivo. Cobre comentario de bloco e de linha inteira, que e o formato usado la.
  const codigo = fonte.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  const imports = [...codigo.matchAll(/require\(\s*['"]([^'"]+)['"]\s*\)/g)].map((m) => m[1]);
  for (const alvo of imports) {
    assert.ok(
      alvo.startsWith('node:'),
      `lib/normalizarEmail importou "${alvo}" — so a stdlib do Node e permitida aqui`,
    );
  }
});

test('descadastro reexporta a MESMA funcao do modulo-folha (uma implementacao so)', () => {
  assert.equal(desc.normalizarEmail, normalizarEmail);
});

// ── 1. normalizarEmail ──

test('normalizarEmail: caixa alta, espacos nas pontas e entradas vazias', () => {
  assert.equal(desc.normalizarEmail('PESSOA@EXEMPLO.COM'), 'pessoa@exemplo.com');
  assert.equal(desc.normalizarEmail('  pessoa@exemplo.com  '), 'pessoa@exemplo.com');
  assert.equal(desc.normalizarEmail('  Pessoa@Exemplo.Com '), 'pessoa@exemplo.com');
  assert.equal(desc.normalizarEmail(''), '');
  assert.equal(desc.normalizarEmail(null), '');
  assert.equal(desc.normalizarEmail(undefined), '');
  assert.equal(desc.normalizarEmail('   '), '');
});

// ── 2. gerarToken ──

test('gerarToken: deterministico e do tamanho declarado', () => {
  const a = desc.gerarToken('pessoa@exemplo.com');
  const b = desc.gerarToken('pessoa@exemplo.com');
  assert.equal(a, b, 'o mesmo e-mail precisa gerar sempre o mesmo token');
  assert.equal(a.length, desc.TAMANHO_TOKEN);
  assert.match(a, /^[0-9a-f]+$/, 'token e hex');
});

test('gerarToken: e-mails diferentes geram tokens diferentes', () => {
  assert.notEqual(desc.gerarToken('a@exemplo.com'), desc.gerarToken('b@exemplo.com'));
});

test('gerarToken: normaliza ANTES do HMAC (grafias do mesmo e-mail -> mesmo token)', () => {
  // Se a normalizacao nao viesse antes do HMAC, o link gerado a partir do e-mail como
  // ele esta gravado no banco nao validaria contra o e-mail digitado de outra forma.
  assert.equal(desc.gerarToken('A@X.com'), desc.gerarToken(' a@x.com '));
});

// ── 3. verificarToken ──

test('verificarToken: aceita o token valido', () => {
  const email = 'valido@exemplo.com';
  assert.equal(desc.verificarToken(email, desc.gerarToken(email)), true);
  // E aceita qualquer grafia do mesmo e-mail, pelo mesmo motivo do teste acima.
  assert.equal(desc.verificarToken(' VALIDO@Exemplo.com ', desc.gerarToken(email)), true);
});

test('verificarToken: rejeita adulterado, vazio, de outro e-mail e de outro tamanho', () => {
  const email = 'pessoa@exemplo.com';
  const bom = desc.gerarToken(email);

  // Adulterado: mesmo tamanho, um caractere trocado.
  const adulterado = (bom[0] === 'a' ? 'b' : 'a') + bom.slice(1);
  assert.equal(desc.verificarToken(email, adulterado), false);

  // De outro e-mail.
  assert.equal(desc.verificarToken(email, desc.gerarToken('outra@exemplo.com')), false);

  // Vazio / ausente / tipo errado.
  assert.equal(desc.verificarToken(email, ''), false);
  assert.equal(desc.verificarToken(email, null), false);
  assert.equal(desc.verificarToken(email, undefined), false);
  assert.equal(desc.verificarToken(email, 12345), false);

  // Comprimento DIFERENTE: e o caso que faria crypto.timingSafeEqual lancar se a guarda
  // de tamanho nao viesse antes. Tem que devolver false, nao explodir.
  assert.equal(desc.verificarToken(email, bom.slice(0, 10)), false);
  assert.equal(desc.verificarToken(email, `${bom}extra`), false);

  // E-mail vazio nunca autentica, nem com o HMAC da string vazia.
  assert.equal(desc.verificarToken('', desc.gerarToken('')), false);
});

// ── 4. montarUrlDescadastro + lerEmailDaUrl ──

test('montarUrlDescadastro: formato do link e token que valida', () => {
  const url = desc.montarUrlDescadastro('Pessoa@Exemplo.com', 'https://exemplo.com.br/');
  // A barra final da baseUrl nao pode virar barra dupla.
  assert.ok(url.startsWith('https://exemplo.com.br/descadastro?e='), url);

  const qs = new URL(url).searchParams;
  assert.equal(desc.lerEmailDaUrl(qs.get('e')), 'pessoa@exemplo.com');
  assert.equal(desc.verificarToken('pessoa@exemplo.com', qs.get('t')), true);

  // base64url e URL-safe: o parametro nao pode conter caractere que exija escaping.
  assert.match(qs.get('e'), /^[A-Za-z0-9_-]+$/);
});

test('lerEmailDaUrl: ida e volta preserva o e-mail normalizado', () => {
  for (const original of ['a@b.co', 'nome.sobrenome+tag@empresa.com.br', 'MAIUSCULA@X.COM']) {
    const url = desc.montarUrlDescadastro(original, 'https://exemplo.com.br');
    const e = new URL(url).searchParams.get('e');
    assert.equal(desc.lerEmailDaUrl(e), desc.normalizarEmail(original));
  }
});

test('lerEmailDaUrl: entrada invalida devolve string vazia sem lancar', () => {
  for (const ruim of ['', null, undefined, 42, {}, '!!!', 'tem espaco', 'a==b==c', '@@@@']) {
    assert.doesNotThrow(() => desc.lerEmailDaUrl(ruim));
    assert.equal(desc.lerEmailDaUrl(ruim), '', `deveria ser vazio para ${JSON.stringify(ruim)}`);
  }
});

// ── 5. registrarDescadastro ──

test('registrarDescadastro: insere na primeira vez e devolve false na segunda', () => {
  assert.equal(db.registrarDescadastro('novo@exemplo.com', desc.ORIGEM_LINK_EMAIL), true);
  assert.equal(db.registrarDescadastro('novo@exemplo.com', desc.ORIGEM_LINK_EMAIL), false);
  // Nem com outra origem: o primeiro registro e o que vale (INSERT OR IGNORE).
  assert.equal(db.registrarDescadastro('novo@exemplo.com', desc.ORIGEM_MANUAL), false);
});

test('registrarDescadastro: grafias diferentes do mesmo e-mail viram UMA linha', () => {
  assert.equal(db.registrarDescadastro('Caixa@Exemplo.com', desc.ORIGEM_MANUAL), true);
  assert.equal(db.registrarDescadastro('  CAIXA@EXEMPLO.COM  ', desc.ORIGEM_LINK_EMAIL), false);
  assert.equal(db.registrarDescadastro('caixa@exemplo.com', desc.ORIGEM_LINK_EMAIL), false);

  const n = db
    .getDb()
    .prepare("SELECT COUNT(*) AS n FROM descadastros WHERE email = 'caixa@exemplo.com'")
    .get().n;
  assert.equal(n, 1);
});

test('registrarDescadastro: e-mail vazio devolve false sem lancar e sem gravar', () => {
  const antes = db.getDb().prepare('SELECT COUNT(*) AS n FROM descadastros').get().n;
  for (const vazio of ['', '   ', null, undefined]) {
    assert.doesNotThrow(() => db.registrarDescadastro(vazio, desc.ORIGEM_MANUAL));
    assert.equal(db.registrarDescadastro(vazio, desc.ORIGEM_MANUAL), false);
  }
  const depois = db.getDb().prepare('SELECT COUNT(*) AS n FROM descadastros').get().n;
  assert.equal(depois, antes, 'e-mail vazio nao pode criar linha');
});

test('registrarDescadastro: grava a origem recebida', () => {
  db.registrarDescadastro('origem@exemplo.com', desc.ORIGEM_MANUAL);
  const linha = db
    .getDb()
    .prepare("SELECT origem FROM descadastros WHERE email = 'origem@exemplo.com'")
    .get();
  assert.equal(linha.origem, 'manual');
});

// ── 6. estaDescadastrado ──

test('estaDescadastrado: false antes, true depois, para qualquer grafia', () => {
  assert.equal(db.estaDescadastrado('consulta@exemplo.com'), false);
  db.registrarDescadastro('consulta@exemplo.com', desc.ORIGEM_LINK_EMAIL);
  assert.equal(db.estaDescadastrado('consulta@exemplo.com'), true);
  assert.equal(db.estaDescadastrado('CONSULTA@EXEMPLO.COM'), true);
  assert.equal(db.estaDescadastrado('  Consulta@Exemplo.com  '), true);
});

test('estaDescadastrado: e-mail vazio devolve false sem lancar', () => {
  for (const vazio of ['', '   ', null, undefined]) {
    assert.doesNotThrow(() => db.estaDescadastrado(vazio));
    assert.equal(db.estaDescadastrado(vazio), false);
  }
});

// ── 7. Segredo ausente ──

// Gerado com o segredo AINDA presente, para o teste abaixo poder afirmar que nem um
// token legitimo passa quando o segredo some (rotacao de segredo invalida tudo).
const tokenValidoPre = desc.gerarToken('pessoa@exemplo.com');

test('sem DESCADASTRO_SECRET: gerarToken lanca e verificarToken devolve false', () => {
  const original = config.descadastro.segredo;
  config.descadastro.segredo = '';
  try {
    assert.throws(
      () => desc.gerarToken('pessoa@exemplo.com'),
      /DESCADASTRO_SECRET/,
      'a falta do segredo tem que ser barulhenta na GERACAO do link',
    );
    // Na VERIFICACAO, ao contrario, nada pode lancar: quem chama e uma rota publica.
    assert.doesNotThrow(() => desc.verificarToken('pessoa@exemplo.com', 'qualquer-coisa'));
    assert.equal(desc.verificarToken('pessoa@exemplo.com', 'qualquer-coisa'), false);
    // Nem mesmo um token que seria valido com o segredo presente.
    assert.equal(desc.verificarToken('pessoa@exemplo.com', tokenValidoPre), false);
    // E montarUrlDescadastro tambem falha cedo, antes de o link entrar num e-mail.
    assert.throws(() => desc.montarUrlDescadastro('a@b.co', 'https://x.com'), /DESCADASTRO_SECRET/);
  } finally {
    config.descadastro.segredo = original;
  }
});

// ── Rotacao de segredo ──
//
// O que estes testes protegem: sem a janela de dois segredos, trocar DESCADASTRO_SECRET
// invalidaria de uma vez todos os links de descadastro ja enviados. Quem nao consegue
// sair da lista marca como spam, e isso queima a reputacao do dominio que os e-mails
// transacionais do funil tambem usam.

// Roda `fn` com os segredos trocados e restaura tudo no fim, aconteca o que acontecer.
function comSegredos({ atual, anterior }, fn) {
  const origAtual = config.descadastro.segredo;
  const origAnterior = config.descadastro.segredoAnterior;
  config.descadastro.segredo = atual;
  config.descadastro.segredoAnterior = anterior;
  try {
    return fn();
  } finally {
    config.descadastro.segredo = origAtual;
    config.descadastro.segredoAnterior = origAnterior;
  }
}

const SEGREDO_VELHO = 'segredo-velho-de-antes-da-rotacao';
const SEGREDO_NOVO = 'segredo-novo-depois-da-rotacao';
const SEGREDO_ESTRANHO = 'segredo-que-nunca-foi-atual-nem-anterior';

test('rotacao: token emitido com o segredo ANTERIOR continua valido', () => {
  const email = 'rotacao@exemplo.com';
  // Link emitido ANTES da rotacao (o segredo velho ainda era o atual).
  const tokenAntigo = comSegredos({ atual: SEGREDO_VELHO, anterior: '' }, () =>
    desc.gerarToken(email),
  );

  // Depois da rotacao: velho virou anterior, novo virou atual.
  comSegredos({ atual: SEGREDO_NOVO, anterior: SEGREDO_VELHO }, () => {
    assert.equal(
      desc.verificarToken(email, tokenAntigo),
      true,
      'o link que ja esta na caixa de entrada de alguem PRECISA continuar funcionando',
    );
  });
});

test('rotacao: token emitido com o segredo ATUAL valida (nao regrediu)', () => {
  const email = 'rotacao@exemplo.com';
  comSegredos({ atual: SEGREDO_NOVO, anterior: SEGREDO_VELHO }, () => {
    const tokenNovo = desc.gerarToken(email);
    assert.equal(desc.verificarToken(email, tokenNovo), true);
    // gerarToken usa SEMPRE o atual: links novos nascem com a chave nova.
    const tokenVelho = comSegredos({ atual: SEGREDO_VELHO, anterior: '' }, () =>
      desc.gerarToken(email),
    );
    assert.notEqual(tokenNovo, tokenVelho, 'a rotacao precisa mudar o token emitido');
  });
});

test('rotacao: token de um terceiro segredo e rejeitado', () => {
  const email = 'rotacao@exemplo.com';
  // Emitido com uma chave que nunca foi atual nem anterior — e o caso do atacante que
  // adivinhou o formato mas nao o segredo, e o do segredo aposentado ha duas rotacoes.
  const tokenEstranho = comSegredos({ atual: SEGREDO_ESTRANHO, anterior: '' }, () =>
    desc.gerarToken(email),
  );

  comSegredos({ atual: SEGREDO_NOVO, anterior: SEGREDO_VELHO }, () => {
    assert.equal(desc.verificarToken(email, tokenEstranho), false);
  });
});

test('sem _ANTERIOR definido: comportamento identico ao de antes da rotacao', () => {
  const email = 'sem-anterior@exemplo.com';
  const tokenVelho = comSegredos({ atual: SEGREDO_VELHO, anterior: '' }, () =>
    desc.gerarToken(email),
  );

  comSegredos({ atual: SEGREDO_NOVO, anterior: '' }, () => {
    // So o atual vale; nada de janela de rotacao quando ela nunca foi configurada.
    assert.equal(desc.verificarToken(email, desc.gerarToken(email)), true);
    assert.equal(desc.verificarToken(email, tokenVelho), false);
  });
});

test('atual vazio + anterior presente -> false (sistema nao configurado)', () => {
  const email = 'sem-atual@exemplo.com';
  const tokenVelho = comSegredos({ atual: SEGREDO_VELHO, anterior: '' }, () =>
    desc.gerarToken(email),
  );

  comSegredos({ atual: '', anterior: SEGREDO_VELHO }, () => {
    // Nao existe "meio configurado": sem segredo atual o app nem consegue EMITIR link
    // novo, entao validar pelo anterior so esconderia a falta de configuracao.
    assert.equal(desc.verificarToken(email, tokenVelho), false);
    assert.doesNotThrow(() => desc.verificarToken(email, tokenVelho));
    assert.throws(() => desc.gerarToken(email), /DESCADASTRO_SECRET/);
  });
});

test('rotacao: anterior IGUAL ao atual nao quebra nada', () => {
  // Erro de digitacao plausivel numa rotacao apressada (copiar o mesmo valor nos dois).
  const email = 'igual@exemplo.com';
  comSegredos({ atual: SEGREDO_NOVO, anterior: SEGREDO_NOVO }, () => {
    assert.equal(desc.verificarToken(email, desc.gerarToken(email)), true);
    assert.equal(desc.verificarToken(email, 'a'.repeat(desc.TAMANHO_TOKEN)), false);
  });
});

// ── Rotas publicas ──

test('GET /descadastro com token valido: mostra confirmacao e NAO altera nada', async () => {
  const email = 'scanner@exemplo.com';
  const url = desc.montarUrlDescadastro(email, 'http://placeholder');
  const qs = new URL(url).search;

  await comServidor(async (base) => {
    const res = await fetch(`${base}/descadastro${qs}`);
    assert.equal(res.status, 200);
    const html = await res.text();
    assert.match(html, /Confirmar descadastro/);
    assert.match(html, /scanner@exemplo\.com/);
  });

  // A assercao que importa: o GET nao pode ter gravado. E o que protege quem nunca abriu
  // o e-mail dos scanners de seguranca corporativos, que fazem GET em todos os links.
  assert.equal(db.estaDescadastrado(email), false, 'o GET NAO pode mudar estado');
});

test('CONTROLE: uma pagina normal CARREGA o rastreio (senao o teste abaixo e vazio)', async () => {
  await comServidor(async (base) => {
    const html = await (await fetch(`${base}/`)).text();
    assert.match(html, /googletagmanager\.com/, 'o GTM deveria entrar numa pagina comum');
    assert.match(html, /connect\.facebook\.net/, 'o Pixel deveria entrar numa pagina comum');
  });
});

test('GET /descadastro NAO carrega rastreio de terceiros (GTM/Pixel)', async () => {
  const qs = new URL(desc.montarUrlDescadastro('semtag@exemplo.com', 'http://x')).search;
  await comServidor(async (base) => {
    const html = await (await fetch(`${base}/descadastro${qs}`)).text();
    assert.doesNotMatch(html, /googletagmanager\.com/, 'GTM nao pode entrar nesta pagina');
    assert.doesNotMatch(html, /connect\.facebook\.net/, 'Pixel nao pode entrar nesta pagina');
    assert.doesNotMatch(html, /GTM-TESTE00/, 'nem o id do container');
    assert.doesNotMatch(html, /1234567890/, 'nem o id do pixel');
  });
});

test('POST /descadastro e a pagina de erro tambem nao carregam rastreio', async () => {
  const qs = new URL(desc.montarUrlDescadastro('semtag2@exemplo.com', 'http://x')).searchParams;
  await comServidor(async (base) => {
    const ok = await (
      await fetch(`${base}/descadastro`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ e: qs.get('e'), t: qs.get('t') }),
      })
    ).text();
    assert.doesNotMatch(ok, /googletagmanager\.com|connect\.facebook\.net/);

    // A tela de "link invalido" e a mais provavel de ser esquecida — ela nasce de
    // paginaAviso, nao do corpo das rotas.
    const erro = await (await fetch(`${base}/descadastro?e=abc&t=xyz`)).text();
    assert.doesNotMatch(erro, /googletagmanager\.com|connect\.facebook\.net/);
  });
});

test('GET /descadastro com token invalido: aviso generico, sem vazar existencia', async () => {
  const e = Buffer.from('existe@exemplo.com', 'utf8').toString('base64url');
  await comServidor(async (base) => {
    for (const qs of [`?e=${e}&t=invalido`, `?e=${e}`, '?t=solto', '', '?e=!!!&t=!!!']) {
      const res = await fetch(`${base}/descadastro${qs}`);
      assert.equal(res.status, 400, `esperado 400 para "${qs}"`);
      const html = await res.text();
      assert.match(html, /Link inválido/);
      // A resposta e a MESMA para e-mail existente e inexistente: nada de oraculo.
      assert.doesNotMatch(html, /existe@exemplo\.com/);
    }
  });
});

test('POST /descadastro com token valido: grava o opt-out', async () => {
  const email = 'saindo@exemplo.com';
  const qs = new URL(desc.montarUrlDescadastro(email, 'http://x')).searchParams;
  assert.equal(db.estaDescadastrado(email), false);

  await comServidor(async (base) => {
    const res = await fetch(`${base}/descadastro`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ e: qs.get('e'), t: qs.get('t') }),
    });
    assert.equal(res.status, 200);
    assert.match(await res.text(), /descadastrado/i);
  });

  assert.equal(db.estaDescadastrado(email), true);
});

test('POST /descadastro e idempotente: quem ja saiu ve a mesma confirmacao', async () => {
  const email = 'duasvezes@exemplo.com';
  const qs = new URL(desc.montarUrlDescadastro(email, 'http://x')).searchParams;
  const corpo = () =>
    new URLSearchParams({ e: qs.get('e'), t: qs.get('t') });

  await comServidor(async (base) => {
    const enviar = () =>
      fetch(`${base}/descadastro`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: corpo(),
      });

    const primeira = await enviar();
    assert.equal(primeira.status, 200);
    const segunda = await enviar();
    assert.equal(segunda.status, 200, 'a segunda vez NAO pode ser erro');
    assert.match(await segunda.text(), /descadastrado/i);
  });

  const n = db
    .getDb()
    .prepare('SELECT COUNT(*) AS n FROM descadastros WHERE email = ?')
    .get(email).n;
  assert.equal(n, 1, 'dois POSTs nao podem virar duas linhas');
});

test('POST /descadastro com token invalido: nao grava', async () => {
  const email = 'naograva@exemplo.com';
  const e = Buffer.from(email, 'utf8').toString('base64url');

  await comServidor(async (base) => {
    const res = await fetch(`${base}/descadastro`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ e, t: 'token-forjado-de-tamanho-qualquer' }),
    });
    assert.equal(res.status, 400);
  });

  assert.equal(db.estaDescadastrado(email), false, 'token forjado nao pode descadastrar');
});

test('POST /descadastro: token de OUTRO e-mail nao descadastra a vitima', async () => {
  // O ataque que o HMAC existe para impedir: pegar um link legitimo proprio e trocar o
  // parametro `e` pelo endereco de outra pessoa.
  const vitima = 'vitima@exemplo.com';
  const meuToken = new URL(desc.montarUrlDescadastro('atacante@exemplo.com', 'http://x'))
    .searchParams.get('t');
  const e = Buffer.from(vitima, 'utf8').toString('base64url');

  await comServidor(async (base) => {
    const res = await fetch(`${base}/descadastro`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ e, t: meuToken }),
    });
    assert.equal(res.status, 400);
  });

  assert.equal(db.estaDescadastrado(vitima), false);
});
