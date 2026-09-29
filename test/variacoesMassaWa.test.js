'use strict';

// B3 — as 7 variacoes do disparo em massa: validacao, sorteio e resolucao de tokens.
//
// Funcoes PURAS: nenhum banco, nenhuma rede, nenhum relogio. O sorteio recebe a fonte de
// aleatoriedade por parametro, entao TODO teste aqui e deterministico — um teste de sorteio que
// depende de Math.random real e um teste que falha uma vez a cada tantas execucoes, e ninguem
// confia num teste assim depois da segunda vez.

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  TOKENS,
  TOKENS_OBRIGATORIOS,
  TOTAL_VARIACOES,
  MAX_CARACTERES,
  TEXTO_BASE_PADRAO,
  VARIACOES_SEED,
  tokensDe,
  validarVariacao,
  validarVariacoes,
  sortearVariacao,
  montarContexto,
  linkDescadastroPara,
  recrutadorDe,
  resolverTexto,
  PROBLEMA_VAZIA,
  PROBLEMA_TOKEN_FALTANDO,
  PROBLEMA_TOKEN_DESCONHECIDO,
  PROBLEMA_CHAVE_DUPLA,
  PROBLEMA_SEM_DESCADASTRO,
  PROBLEMA_LONGA,
  PROBLEMA_DUPLICADA,
  PROBLEMA_QUANTIDADE,
} = require('../src/lib/variacoesMassaWa');

const PROXIMA = {
  dataTexto: 'quinta-feira, 01/10/2026',
  horaTexto: '19:30',
  linkMeet: 'https://meet.google.com/abc-defg-hij',
};
const JOB = { titulo: 'Closer de Vendas', empresa: 'Acme Ltda' };

const codigos = (r) => r.problemas.map((p) => p.codigo);
const problema = (r, codigo) => r.problemas.find((p) => p.codigo === codigo);

// Variacao minima valida, para os testes falarem de UMA regra por vez.
const OK = 'Oi! Aqui é o {recrutador}. Vaga de {vaga} na {empresa}, entrevista em {data} às {horario}: {link_meet}. Para sair: {link_descadastro}';
const LINK = 'https://entrevista.vendedormestre.com.br/descadastro-whatsapp/abc.123';

// ══════════════════ SEED ══════════════════

test('as 7 variacoes do seed passam o validador', () => {
  // Se este teste falhar, a campanha nasce impossivel de ativar — e o operador descobriria isso
  // so na tela, sem saber que o problema veio de fabrica.
  const r = validarVariacoes(VARIACOES_SEED);
  assert.deepEqual(r.problemas, []);
  assert.equal(r.ok, true);
});

test('o seed tem exatamente 7 variacoes, todas distintas', () => {
  assert.equal(VARIACOES_SEED.length, TOTAL_VARIACOES);
  assert.equal(new Set(VARIACOES_SEED).size, TOTAL_VARIACOES);
});

test('texto base: introduz as linhas de data/hora/link com dois-pontos', () => {
  assert.ok(TEXTO_BASE_PADRAO.includes('Vamos fazer uma *entrevista em grupo online*:'));
});

test('formatacao das seeds: paragrafos, negrito na vaga/empresa, link FORA do negrito', () => {
  // Pedido do Rafael: leitura fluida, com paragrafos e negrito no que importa. O link do Meet e o
  // de descadastro nunca ficam entre asteriscos — asterisco colado na URL pode quebrar o link.
  for (const [i, texto] of [TEXTO_BASE_PADRAO, ...VARIACOES_SEED].entries()) {
    assert.ok(texto.includes('\n\n'), `texto ${i} sem paragrafos`);
    assert.ok(texto.includes('*{vaga}*'), `texto ${i} sem a vaga em negrito`);
    assert.ok(texto.includes('*{empresa}*'), `texto ${i} sem a empresa em negrito`);
    assert.doesNotMatch(texto, /\*[^*\n]*\{link_(meet|descadastro)\}[^*\n]*\*/, `texto ${i} com link em negrito`);
    assert.doesNotMatch(texto, /(^|\s)_\S/, `texto ${i} usa _italico_ (o token do link pode ter "_")`);
  }
});

test('as 7 variacoes fecham o descadastro com formulacoes DIFERENTES', () => {
  // Sete textos que terminam com a mesma frase exata sao sete textos com a mesma assinatura no
  // fim — justamente o padrao que as variacoes existem para quebrar.
  const fechos = VARIACOES_SEED.map((t) => t.slice(t.lastIndexOf('.', t.length - 2) + 1).trim());
  assert.ok(new Set(fechos).size >= 5, `poucos fechos distintos: ${new Set(fechos).size}`);
});

test('o texto base tambem e valido como mensagem', () => {
  // Ele e semente da tela, mas tambem e o que o operador ve primeiro: se nao passasse as proprias
  // regras, a primeira coisa que a tela faria era acusar erro no texto que ela mesma sugeriu.
  const r = validarVariacoes([TEXTO_BASE_PADRAO], { exigirTotal: false });
  assert.deepEqual(r.problemas, []);
});

test('toda variacao do seed tem os tokens obrigatorios, inclusive o link de descadastro', () => {
  for (const [i, texto] of VARIACOES_SEED.entries()) {
    const presentes = new Set(tokensDe(texto));
    for (const tok of TOKENS_OBRIGATORIOS) {
      assert.ok(presentes.has(tok), `variacao ${i + 1} sem {${tok}}`);
    }
    assert.doesNotMatch(texto, /\bSAIR\b/, `variacao ${i + 1} ainda pede "SAIR"`);
  }
});

test('nenhuma variacao do seed usa a sintaxe {{dupla}} da Meta', () => {
  for (const [i, texto] of VARIACOES_SEED.entries()) {
    assert.doesNotMatch(texto, /\{\{|\}\}/, `variacao ${i + 1} usa chave dupla`);
  }
});

// ══════════════════ VALIDACAO ══════════════════

test('recusa variacao sem cada um dos tokens obrigatorios, um por vez', () => {
  // {link_descadastro} tem problema proprio (PROBLEMA_SEM_DESCADASTRO), testado abaixo.
  for (const tok of TOKENS_OBRIGATORIOS.filter((t) => t !== 'link_descadastro')) {
    const texto = OK.replace(`{${tok}}`, 'X');
    const p = problema(validarVariacoes([texto], { exigirTotal: false }), PROBLEMA_TOKEN_FALTANDO);
    assert.ok(p, `deveria acusar falta de {${tok}}`);
    assert.deepEqual(p.tokens, [tok]);
    assert.equal(p.indice, 1, 'o problema precisa dizer QUAL variacao');
  }
});

test('{saudacao} NAO e obrigatorio (variacao pode comecar sem cumprimentar)', () => {
  const r = validarVariacoes([OK], { exigirTotal: false });
  assert.ok(!tokensDe(OK).includes('saudacao'));
  assert.deepEqual(r.problemas, []);
});

test('recusa token escrito errado, que sairia literal na mensagem', () => {
  // {horário} com acento e {linkmeet} sem underscore nao resolvem: iriam para o aparelho da
  // pessoa como texto.
  const r = validarVariacoes([`${OK} {horário} {linkmeet}`], { exigirTotal: false });
  const p = problema(r, PROBLEMA_TOKEN_DESCONHECIDO);
  assert.ok(p);
  assert.deepEqual(p.tokens.sort(), ['horário', 'linkmeet'].sort());
});

test('recusa a sintaxe {{dupla}} dos templates da Meta', () => {
  const r = validarVariacoes([OK.replace('{vaga}', '{{vaga}}')], { exigirTotal: false });
  assert.ok(codigos(r).includes(PROBLEMA_CHAVE_DUPLA));
});

test('recusa variacao sem o link de descadastro', () => {
  const r = validarVariacoes([OK.replace('Para sair: {link_descadastro}', 'Abraço!')], { exigirTotal: false });
  assert.ok(codigos(r).includes(PROBLEMA_SEM_DESCADASTRO));
  assert.ok(!codigos(r).includes(PROBLEMA_TOKEN_FALTANDO), 'o link nao deve ser acusado duas vezes');
});

test('"responda SAIR" NAO substitui o link: sem {link_descadastro} a variacao e recusada', () => {
  const r = validarVariacoes([OK.replace('Para sair: {link_descadastro}', 'Responda SAIR para sair.')], { exigirTotal: false });
  assert.ok(codigos(r).includes(PROBLEMA_SEM_DESCADASTRO));
});

test('aceita a frase de descadastro reescrita de varias formas', () => {
  const formas = [
    'Para não receber mais: {link_descadastro}',
    'Se preferir não receber mais mensagens, acesse {link_descadastro}',
    'Não quer mais receber? {link_descadastro}',
  ];
  for (const frase of formas) {
    const texto = OK.replace('Para sair: {link_descadastro}', frase);
    const r = validarVariacoes([texto], { exigirTotal: false });
    assert.deepEqual(r.problemas, [], `recusou a frase: ${frase}`);
  }
});

test('recusa variacao vazia, e nao acumula outros problemas em cima dela', () => {
  const r = validarVariacoes(['   '], { exigirTotal: false });
  assert.deepEqual(codigos(r), [PROBLEMA_VAZIA], 'texto vazio nao deve gerar 5 problemas');
});

test('recusa variacao acima do teto de caracteres', () => {
  const longa = `${OK} ${'palavra '.repeat(200)}`;
  const p = problema(validarVariacoes([longa], { exigirTotal: false }), PROBLEMA_LONGA);
  assert.ok(p);
  assert.equal(p.teto, MAX_CARACTERES);
  assert.ok(p.tamanho > MAX_CARACTERES);
});

test('recusa duas variacoes iguais, e aponta a SEGUNDA', () => {
  const r = validarVariacoes([OK, OK], { exigirTotal: false });
  const p = problema(r, PROBLEMA_DUPLICADA);
  assert.ok(p);
  assert.equal(p.indice, 2, 'a primeira e a legitima');
  assert.equal(p.igualA, 1);
});

test('duas variacoes que diferem so por pontuacao/acento/caixa contam como DUPLICADAS', () => {
  // O LLM devolve quase-duplicatas com facilidade, e duas redacoes "diferentes" que o WhatsApp le
  // como o mesmo texto nao cumprem a funcao de existirem sete.
  const a = 'Olá! Vaga de {vaga} na {empresa} — entrevista em {data}, {horario}: {link_meet}. Sair: {link_descadastro}';
  const b = 'OLA  Vaga de {vaga} na {empresa}, entrevista em {data} {horario}: {link_meet}! sair {link_descadastro}';
  const r = validarVariacoes([a, b], { exigirTotal: false });
  assert.ok(codigos(r).includes(PROBLEMA_DUPLICADA));
});

test('exigirTotal cobra as 7 (e a tela de edicao pode desligar isso)', () => {
  const tres = [OK, `${OK} um`, `${OK} dois`];
  const comTotal = validarVariacoes(tres);
  const p = problema(comTotal, PROBLEMA_QUANTIDADE);
  assert.ok(p);
  assert.equal(p.total, 3);
  assert.equal(p.esperado, TOTAL_VARIACOES);

  assert.ok(!codigos(validarVariacoes(tres, { exigirTotal: false })).includes(PROBLEMA_QUANTIDADE));
});

test('variacao em branco no meio nao conta para o total de 7', () => {
  const lista = [...VARIACOES_SEED];
  lista[3] = '   ';
  const p = problema(validarVariacoes(lista), PROBLEMA_QUANTIDADE);
  assert.ok(p);
  assert.equal(p.total, 6);
});

test('validarVariacao nao lanca com entrada nao-string', () => {
  for (const entrada of [null, undefined, 0, {}, []]) {
    assert.doesNotThrow(() => validarVariacao(entrada, 1));
  }
  assert.doesNotThrow(() => validarVariacoes(null));
});

// ══════════════════ SORTEIO ══════════════════

const VARIACOES = VARIACOES_SEED.map((texto, i) => ({ indice: i + 1, texto }));

test('sorteio NUNCA repete a ultima variacao usada', () => {
  // A regra existe para nao mandar duas mensagens identicas seguidas — o padrao que o sorteio
  // existe para quebrar. Varremos as 7 como "ultima" e todas as posicoes do aleatorio.
  for (let ultima = 1; ultima <= 7; ultima += 1) {
    for (let k = 0; k < 6; k += 1) {
      const escolhida = sortearVariacao(VARIACOES, ultima, () => k / 6);
      assert.notEqual(escolhida.indice, ultima, `repetiu a variacao ${ultima}`);
    }
  }
});

test('sorteio alcanca TODAS as outras 6 variacoes', () => {
  // Sem isso, um sorteio que sempre devolve a mesma "outra" passaria no teste anterior e anularia
  // a razao de existirem sete — e nada mais no sistema denunciaria.
  const vistos = new Set();
  for (let k = 0; k < 6; k += 1) vistos.add(sortearVariacao(VARIACOES, 1, () => k / 6).indice);
  assert.deepEqual([...vistos].sort((a, b) => a - b), [2, 3, 4, 5, 6, 7]);
});

test('sem ultima variacao (primeiro envio) qualquer uma pode sair', () => {
  const vistos = new Set();
  for (let k = 0; k < 7; k += 1) vistos.add(sortearVariacao(VARIACOES, null, () => k / 7).indice);
  assert.equal(vistos.size, 7);
});

test('sorteio devolve o texto junto do indice (quem envia nao precisa buscar de novo)', () => {
  const r = sortearVariacao(VARIACOES, null, () => 0);
  assert.equal(r.indice, 1);
  assert.equal(r.texto, VARIACOES_SEED[0]);
});

test('com UMA variacao so, ela sai mesmo sendo a ultima usada', () => {
  // A alternativa seria nao enviar. O validador e quem cobra as 7 antes de ativar; esta funcao
  // nao inventa uma segunda politica.
  const uma = [{ indice: 3, texto: OK }];
  assert.equal(sortearVariacao(uma, 3, () => 0.5).indice, 3);
});

test('aleatorio no limite (0 e quase 1) nao estoura o indice', () => {
  assert.equal(sortearVariacao(VARIACOES, null, () => 0).indice, 1);
  const ultimo = sortearVariacao(VARIACOES, null, () => 0.9999999999);
  assert.equal(ultimo.indice, 7);
  assert.ok(ultimo.texto);
});

test('lista vazia ou so com textos em branco devolve null (nunca uma mensagem vazia)', () => {
  assert.equal(sortearVariacao([], null, () => 0), null);
  assert.equal(sortearVariacao([{ indice: 1, texto: '  ' }], null, () => 0), null);
  assert.equal(sortearVariacao(null, null, () => 0), null);
});

// ══════════════════ RESOLUCAO DOS TOKENS ══════════════════

test('resolve os 6 tokens a partir da vaga e da proxima reuniao', () => {
  const ctx = montarContexto({ nome: 'Maria Souza', job: JOB, proxima: PROXIMA });
  const { texto, faltando } = resolverTexto(
    '{saudacao} {vaga} / {empresa} / {data} / {horario} / {link_meet}',
    ctx,
  );

  assert.deepEqual(faltando, []);
  assert.equal(
    texto,
    'Olá, Maria! Closer de Vendas / Acme Ltda / quinta-feira, 01/10/2026 / 19:30 / https://meet.google.com/abc-defg-hij',
  );
});

test('{saudacao} sem nome vira "Olá!" — nunca "Olá , "', () => {
  // Reusa saudacao() de lib/whatsappSequencia: duas frases INTEIRAS, e nao um placeholder que
  // fica vazio. "Olá , tudo bem?" e o detalhe que denuncia automacao mal-feita.
  const comNome = montarContexto({ nome: 'Maria Souza', job: JOB, proxima: PROXIMA });
  const semNome = montarContexto({ nome: '   ', job: JOB, proxima: PROXIMA });

  assert.equal(resolverTexto('{saudacao} texto', comNome).texto, 'Olá, Maria! texto');
  assert.equal(resolverTexto('{saudacao} texto', semNome).texto, 'Olá! texto');
});

test('o mesmo token repetido no texto e resolvido em todas as ocorrencias', () => {
  const ctx = montarContexto({ nome: 'Ana', job: JOB, proxima: PROXIMA });
  const { texto } = resolverTexto('{vaga} e de novo {vaga}', ctx);
  assert.equal(texto, 'Closer de Vendas e de novo Closer de Vendas');
});

test('sem reuniao futura: data, horario e link ficam FALTANDO (o worker nao envia)', () => {
  // E o mesmo criterio do convite do WA2: nunca sai mensagem com data ou link em branco.
  const ctx = montarContexto({ nome: 'Ana', job: JOB, proxima: null, linkDescadastro: LINK });
  const { faltando } = resolverTexto(OK, ctx);
  assert.deepEqual(faltando.sort(), ['data', 'horario', 'link_meet']);
});

test('vaga SEM empresa cadastrada: {empresa} entra em faltando (nao sai "na .")', () => {
  // Caso real desta base. Resolver para '' produziria uma frase quebrada no aparelho da pessoa.
  const ctx = montarContexto({ nome: 'Ana', job: { titulo: 'Closer' }, proxima: PROXIMA, linkDescadastro: LINK });
  const { faltando } = resolverTexto(OK, ctx);
  assert.deepEqual(faltando, ['empresa']);
});

test('token obrigatorio que o texto NAO usa nao entra em faltando', () => {
  // `faltando` e sobre o que a mensagem precisa, nao sobre a lista teorica de tokens.
  const ctx = montarContexto({ nome: 'Ana', job: { titulo: 'Closer' }, proxima: PROXIMA });
  const { faltando } = resolverTexto('Vaga de {vaga} em {data}, {horario}: {link_meet}.', ctx);
  assert.deepEqual(faltando, [], 'o texto nao usa {empresa}, entao a falta dela e irrelevante');
});

test('token desconhecido fica LITERAL em vez de virar vazio', () => {
  // Apagar esconderia o erro. O validador ja recusa isso antes de a campanha poder disparar, e se
  // um chegasse aqui, ele aparece — e aparecer e o que faz alguem consertar.
  const ctx = montarContexto({ nome: 'Ana', job: JOB, proxima: PROXIMA });
  const { texto } = resolverTexto('{vaga} {horário}', ctx);
  assert.equal(texto, 'Closer de Vendas {horário}');
});

test('resolverTexto nao lanca com entrada nula', () => {
  assert.doesNotThrow(() => resolverTexto(null, {}));
  assert.doesNotThrow(() => resolverTexto('{vaga}', null));
  assert.equal(resolverTexto(null, {}).texto, '');
});

test('as 7 seeds resolvidas nao deixam NENHUM token para tras', () => {
  // A assercao de ponta: depois da resolucao, nada entre chaves pode sobrar no que vai para o
  // aparelho de alguem.
  const ctx = montarContexto({ nome: 'Maria Souza', job: JOB, proxima: PROXIMA, linkDescadastro: LINK });
  for (const [i, seed] of VARIACOES_SEED.entries()) {
    const { texto, faltando } = resolverTexto(seed, ctx);
    assert.deepEqual(faltando, [], `variacao ${i + 1} ficou com token sem valor`);
    assert.doesNotMatch(texto, /[{}]/, `variacao ${i + 1} deixou chave no texto final`);
    assert.doesNotMatch(texto, /undefined|null|NaN/, `variacao ${i + 1} vazou valor nao resolvido`);
    assert.ok(texto.includes(LINK), `variacao ${i + 1} perdeu o link de descadastro`);
    assert.match(texto, /meet\.google\.com/, `variacao ${i + 1} perdeu o link`);
  }
});

test('sem link de descadastro, a mensagem NAO pode sair (link_descadastro em faltando)', () => {
  const ctx = montarContexto({ nome: 'Ana', job: JOB, proxima: PROXIMA });
  assert.deepEqual(resolverTexto(OK, ctx).faltando, ['link_descadastro']);
});

test('linkDescadastroPara: devolve a URL, e vira vazio (sem lancar) quando a montagem falha', () => {
  assert.equal(linkDescadastroPara('5531999990000', () => LINK), LINK);
  const falha = () => { throw new Error('OPTOUT_TOKEN_SECRET ausente'); };
  assert.equal(linkDescadastroPara('5531999990000', falha), '');
});

test('toda seed se apresenta (recrutador + Vendedor Mestre) e diz o CARGO', () => {
  // Pedido do Rafael: a pessoa precisa saber quem escreve e para qual cargo se candidatou.
  for (const [i, texto] of [TEXTO_BASE_PADRAO, ...VARIACOES_SEED].entries()) {
    assert.ok(texto.includes('{recrutador}'), `texto ${i} nao diz quem escreve`);
    assert.ok(texto.includes('*Vendedor Mestre*'), `texto ${i} nao diz de onde`);
    assert.match(texto, /cargo de \*\{vaga\}\*/, `texto ${i} nao cita o cargo`);
  }
});

test('recrutadorDe: primeiro nome da config, com fallback para o padrao', () => {
  assert.equal(recrutadorDe('Jean Dentz'), 'Jean');
  assert.equal(recrutadorDe('  Ana  Paula '), 'Ana');
  assert.equal(recrutadorDe(''), 'Jean', 'config vazia nao pode deixar a mensagem sem assinatura');
  assert.equal(recrutadorDe(undefined), 'Jean');
  const ctx = montarContexto({ nome: 'Maria Souza', job: JOB, proxima: PROXIMA, linkDescadastro: LINK, recrutador: 'Carlos Lima' });
  assert.match(resolverTexto(VARIACOES_SEED[0], ctx).texto, /Aqui é o Carlos, da \*Vendedor Mestre\*/);
});

test('TOKENS e TOKENS_OBRIGATORIOS sao consistentes entre si', () => {
  for (const tok of TOKENS_OBRIGATORIOS) {
    assert.ok(TOKENS.includes(tok), `${tok} obrigatorio mas nao reconhecido`);
  }
  assert.ok(!TOKENS_OBRIGATORIOS.includes('saudacao'));
});
