'use strict';

// O texto-base e a fonte da verdade das variacoes do tipo entrevista (2026-10-14).
//
// Regressao da campanha 9: o texto-base era um LEMBRETE ("daqui a pouco as 14h", sala do Meet por
// extenso) e as variacoes que sairam eram as sementes do CONVITE. Aqui ficam as regras puras que
// impedem isso de passar de novo: variacao conferida CONTRA o texto-base (tokens, URLs, tamanho,
// semelhanca), a linha de descadastro do sistema (D2) e o carimbo de desatualizacao (D4).

const test = require('node:test');
const assert = require('node:assert/strict');

const v = require('../src/lib/variacoesMassaWa');
const { hashTextoBase, normalizarTextoBase } = require('../src/lib/hashTextoBase');

// O texto-base REAL da campanha 9 e uma redacao legitima dele (mesmos fatos, tokens e link).
const { BASE_LEMBRETE, REDACOES_LEMBRETE, URL_SALA } = require('./fixtures/variacoesLembreteMassaWa');
const VARIACAO_BOA = REDACOES_LEMBRETE[0];

const codigos = (problemas) => problemas.map((p) => p.codigo);
const contra = (texto, base = BASE_LEMBRETE) => v.validarContraTextoBase(texto, base, 1);

// ══════════════════ REGRESSAO DO BUG ══════════════════

test('regressao campanha 9: NENHUMA semente do convite passa como variacao do lembrete', () => {
  // Era exatamente o que acontecia: sete textos com {data}, {horario}, {link_meet},
  // "confirmar presenca" — nenhum com a sala que o texto-base dava.
  for (const [i, semente] of v.VARIACOES_SEED.entries()) {
    const p = contra(semente);
    assert.ok(codigos(p).includes(v.PROBLEMA_TOKEN_INVENTADO), `semente ${i + 1} deveria acusar token inventado`);
    assert.ok(codigos(p).includes(v.PROBLEMA_URL), `semente ${i + 1} deveria acusar a sala perdida`);
  }
  const r = v.validarVariacoes([...v.VARIACOES_SEED], { textoBase: BASE_LEMBRETE });
  assert.equal(r.ok, false);
});

test('regressao campanha 9: uma redacao fiel do lembrete passa', () => {
  assert.deepEqual(contra(VARIACAO_BOA), []);
  assert.deepEqual(v.validarVariacao(VARIACAO_BOA, 1, { textoBase: BASE_LEMBRETE }), []);
});

test('o lembrete nao exige {data}, {horario}, {link_meet} nem {link_descadastro} (D2)', () => {
  assert.deepEqual(v.obrigatoriosDoTextoBase(BASE_LEMBRETE).sort(), ['empresa', 'recrutador', 'saudacao', 'vaga']);
});

// ══════════════════ VALIDADOR CONTRA O TEXTO-BASE ══════════════════

test('placeholder PERDIDO: a variacao sem {empresa} e recusada', () => {
  const p = contra(VARIACAO_BOA.replace('*{empresa}*', '*empresa parceira*'));
  const f = p.find((x) => x.codigo === v.PROBLEMA_TOKEN_FALTANDO);
  assert.deepEqual(f && f.tokens, ['empresa']);
});

test('placeholder INVENTADO: {data} num lembrete que nao tem data e recusado', () => {
  const p = contra(VARIACAO_BOA.replace('hoje, às 14h', 'em {data}, às 14h'));
  const f = p.find((x) => x.codigo === v.PROBLEMA_TOKEN_INVENTADO);
  assert.deepEqual(f && f.tokens, ['data']);
});

test('{link_descadastro} na variacao NAO conta como inventado (e do sistema)', () => {
  assert.deepEqual(contra(`${VARIACAO_BOA}\n\nPara sair: {link_descadastro}`), []);
});

test('URL ALTERADA: um caractere a menos no link da sala e recusado', () => {
  const p = contra(VARIACAO_BOA.replace(URL_SALA, 'https://meet.google.com/qeu-emje-txh'));
  const f = p.find((x) => x.codigo === v.PROBLEMA_URL);
  assert.deepEqual(f && f.urls, [URL_SALA]);
});

test('URL PERDIDA: a variacao sem o link da sala e recusada', () => {
  const p = contra(VARIACAO_BOA.replace(`: ${URL_SALA}`, ' no link que te mandei'));
  assert.ok(codigos(p).includes(v.PROBLEMA_URL));
});

test('URL com pontuacao colada no fim conta como a mesma URL', () => {
  assert.deepEqual(v.urlsDe(`veja ${URL_SALA}. ou (${URL_SALA})`), [URL_SALA, URL_SALA]);
  assert.deepEqual(contra(VARIACAO_BOA.replace(URL_SALA, `${URL_SALA}.`)), []);
});

test('MUITO PARECIDA com o texto-base: copiar o base trocando uma palavra e recusado', () => {
  const p = contra(BASE_LEMBRETE.replace('Te espero lá.', 'Te aguardo lá.'));
  const f = p.find((x) => x.codigo === v.PROBLEMA_PARECIDA_BASE);
  assert.ok(f, 'deveria acusar semelhanca com o texto-base');
  assert.ok(f.similaridade >= v.SIMILARIDADE_MAXIMA);
});

test('MUITO PARECIDA com outra variacao: a segunda e recusada e aponta a primeira', () => {
  const quase = VARIACAO_BOA.replace('Até daqui a pouco!', 'Até já!');
  const r = v.validarVariacoes([VARIACAO_BOA, quase], { exigirTotal: false, textoBase: BASE_LEMBRETE });
  const f = r.problemas.find((x) => x.codigo === v.PROBLEMA_PARECIDA);
  assert.ok(f);
  assert.equal(f.indice, 2);
  assert.equal(f.igualA, 1);
});

test('duplicata EXATA continua com o codigo proprio, sem acusar "parecida" de novo', () => {
  const r = v.validarVariacoes([VARIACAO_BOA, VARIACAO_BOA], { exigirTotal: false, textoBase: BASE_LEMBRETE });
  assert.deepEqual(codigos(r.problemas), [v.PROBLEMA_DUPLICADA]);
});

test('TAMANHO fora de 0,6x a 1,6x do texto-base e recusado (curta e longa)', () => {
  const curta = `{saudacao} {recrutador}: entrevista *{vaga}* *{empresa}* 14h ${URL_SALA}`;
  const pc = contra(curta).find((x) => x.codigo === v.PROBLEMA_TAMANHO_BASE);
  assert.ok(pc && pc.tamanho / pc.base < v.FATOR_TAMANHO_MIN);

  const longa = `${VARIACAO_BOA}\n\n${'Lembre de deixar o microfone e a câmera funcionando. '.repeat(8)}`;
  const pl = contra(longa).find((x) => x.codigo === v.PROBLEMA_TAMANHO_BASE);
  assert.ok(pl && pl.tamanho / pl.base > v.FATOR_TAMANHO_MAX);
});

test('limiares sao os aprovados (D3)', () => {
  assert.equal(v.SIMILARIDADE_MAXIMA, 0.85);
  assert.equal(v.FATOR_TAMANHO_MIN, 0.6);
  assert.equal(v.FATOR_TAMANHO_MAX, 1.6);
});

test('as sementes continuam validas contra o TEXTO_BASE_PADRAO (campanhas criadas pelo padrao)', () => {
  assert.equal(v.validarVariacoes([...v.VARIACOES_SEED], { textoBase: v.TEXTO_BASE_PADRAO }).ok, true);
  // Sem texto-base informado vale o padrao — campanha antiga sem texto gravado.
  assert.equal(v.validarVariacoes([...v.VARIACOES_SEED]).ok, true);
});

test('segmento NAO passa pela regra do texto-base: segue exigindo o descadastro na variacao', () => {
  const tipo = v.TIPO_CONVITE_CANDIDATURA;
  assert.equal(v.validarVariacoes([...v.VARIACOES_SEED_CONVITE], { tipo, textoBase: v.TEXTO_BASE_CONVITE }).ok, true);
  const sem = v.VARIACOES_SEED_CONVITE[0].replace(/\n\nSe não quiser[^\n]*$/, '');
  assert.ok(codigos(v.validarVariacao(sem, 1, { tipo })).includes(v.PROBLEMA_SEM_DESCADASTRO));
});

// ══════════════════ LINHA DE DESCADASTRO DO SISTEMA (D2) ══════════════════

const LINK = 'https://entrevista.vendedormestre.com.br/descadastro-whatsapp/tok';
const ctx = () => v.montarContexto({
  nome: 'Maria Souza', job: { titulo: 'Closer', empresa: 'Acme' }, linkDescadastro: LINK, recrutador: 'Jean',
});

test('a linha de descadastro e a redacao do texto padrao', () => {
  assert.equal(v.LINHA_DESCADASTRO, 'Para não receber mais mensagens nossas, acesse: {link_descadastro}');
  assert.ok(v.TEXTO_BASE_PADRAO.endsWith(v.LINHA_DESCADASTRO));
});

test('a linha entra UMA vez no fim da mensagem resolvida', () => {
  const { texto, faltando } = v.resolverTexto(VARIACAO_BOA, ctx());
  assert.deepEqual(faltando, []);
  assert.ok(texto.endsWith(`\n\nPara não receber mais mensagens nossas, acesse: ${LINK}`));
  assert.equal(texto.split(LINK).length - 1, 1);
});

test('variacao que JA tem {link_descadastro} nao ganha uma segunda linha', () => {
  const { texto } = v.resolverTexto(v.VARIACOES_SEED[0], ctx());
  assert.equal(texto.split(LINK).length - 1, 1);
  assert.ok(!texto.includes(v.LINHA_DESCADASTRO.replace('{link_descadastro}', '')), 'a frase do sistema nao entra');
});

test('sem link montavel a linha acrescentada vira `faltando` e a mensagem nao sai', () => {
  const semLink = { ...ctx(), link_descadastro: '' };
  assert.deepEqual(v.resolverTexto(VARIACAO_BOA, semLink).faltando, ['link_descadastro']);
});

test('comLinhaDescadastro: texto vazio continua vazio; idempotente', () => {
  assert.equal(v.comLinhaDescadastro('   '), '   ');
  const uma = v.comLinhaDescadastro('Oi');
  assert.equal(v.comLinhaDescadastro(uma), uma);
});

test('o segmento NAO ganha a linha (a variacao dele ja traz o proprio link)', () => {
  const c = v.montarContextoConvite({ nome: 'Ana', job: { titulo: 'Closer', empresa: 'Acme' }, cidade: 'Joinville', linkVaga: 'https://x/v', linkDescadastro: LINK });
  const { texto } = v.resolverTexto('Oi {vaga} {cidade} {link_vaga} {recrutador} {empresa}', c, { tipo: v.TIPO_CONVITE_CANDIDATURA });
  assert.ok(!texto.includes(LINK));
});

// ══════════════════ AVISOS E CARIMBO ══════════════════

test('aviso: o lembrete tem link e horario escritos a mao e nao usa {data}', () => {
  const a = v.avisosDoTextoBase(BASE_LEMBRETE);
  assert.deepEqual(a.urls, [URL_SALA]);
  assert.deepEqual(a.horas, ['14h']);
});

test('aviso: com {data} no texto-base nao ha aviso', () => {
  assert.deepEqual(v.avisosDoTextoBase(v.TEXTO_BASE_PADRAO), { urls: [], horas: [] });
  assert.deepEqual(v.avisosDoTextoBase(`${BASE_LEMBRETE} {data}`), { urls: [], horas: [] });
});

test('aviso: reconhece 19:30 e 9h30, sem confundir numero de URL', () => {
  assert.deepEqual(v.avisosDoTextoBase('às 19:30 ou 9h30 em https://x.com/12h').horas, ['19:30', '9h30']);
});

test('hash do texto-base ignora \\r\\n e espacos nas pontas', () => {
  assert.equal(hashTextoBase('a\r\nb  '), hashTextoBase('a\nb'));
  assert.notEqual(hashTextoBase('a\nb'), hashTextoBase('a\nc'));
  assert.equal(normalizarTextoBase(null), '');
});

test('variacoesDesatualizadas: bate com o texto atual; muda o texto, fica desatualizada; sem carimbo, desatualizada', () => {
  const c = { texto_base: BASE_LEMBRETE, variacoes_base_hash: hashTextoBase(BASE_LEMBRETE) };
  assert.equal(v.variacoesDesatualizadas(c), false);
  assert.equal(v.variacoesDesatualizadas({ ...c, texto_base: `${BASE_LEMBRETE} editado` }), true);
  assert.equal(v.variacoesDesatualizadas({ ...c, variacoes_base_hash: null }), true);
});

test('textoBaseEfetivo e ehTextoBasePadrao', () => {
  assert.equal(v.textoBaseEfetivo({ texto_base: null }), v.TEXTO_BASE_PADRAO);
  assert.equal(v.textoBaseEfetivo({ texto_base: ` ${BASE_LEMBRETE}\r\n` }), BASE_LEMBRETE);
  assert.equal(v.ehTextoBasePadrao(v.TEXTO_BASE_PADRAO.replace(/\n/g, '\r\n')), true);
  assert.equal(v.ehTextoBasePadrao(BASE_LEMBRETE), false);
});

test('bloqueioDasVariacoes: erro de geracao > desatualizadas > liberado; sem variacoes nao ha desatualizacao', () => {
  const ok = { texto_base: BASE_LEMBRETE, variacoes_base_hash: hashTextoBase(BASE_LEMBRETE), variacoes_erro: null };
  assert.equal(v.bloqueioDasVariacoes(ok), null);
  assert.equal(v.bloqueioDasVariacoes({ ...ok, variacoes_erro: 'IA desligada' }), 'com_erro');
  assert.equal(v.bloqueioDasVariacoes({ ...ok, variacoes_erro: 'x', variacoes_base_hash: null }), 'com_erro');
  assert.equal(v.bloqueioDasVariacoes({ ...ok, texto_base: 'outro' }), 'desatualizadas');
  assert.equal(v.bloqueioDasVariacoes({ ...ok, texto_base: 'outro' }, { temVariacoes: false }), null);
});

// ══════════════════ PARAGRAFOS (2026-10-19) ══════════════════
//
// Regressao das campanhas 10 e 11: o LLM devolveu as 7 numa linha so e o validador aceitou — a
// campanha 10 enviou 13 mensagens como um bloco corrido.

const achatar = (t) => t.replace(/\s*\n+\s*/g, ' ');

test('regressao campanha 11: variacao achatada numa linha so acusa sem_quebras', () => {
  const p = contra(achatar(VARIACAO_BOA)).find((x) => x.codigo === v.PROBLEMA_SEM_QUEBRAS);
  assert.ok(p, 'achatada deveria acusar sem_quebras');
  assert.equal(p.quebras, 0);
  assert.equal(p.base, v.contarQuebras(BASE_LEMBRETE));
  assert.equal(p.minimo, Math.ceil(v.contarQuebras(BASE_LEMBRETE) / 2));
});

test('sem_quebras: metade das quebras do texto-base (para cima) basta; uma a menos nao', () => {
  const base = 'A {vaga}\nB\nC\nD\nE';
  assert.equal(v.minimoDeQuebras(base), 2);
  assert.ok(!codigos(contra('X {vaga} aa\nY bb cc\nZ dd', base)).includes(v.PROBLEMA_SEM_QUEBRAS));
  assert.ok(codigos(contra('X {vaga} aa Y\nbb cc Z dd', base)).includes(v.PROBLEMA_SEM_QUEBRAS));
});

test('sem_quebras: minimo 1 com uma quebra so; texto-base de uma linha nao exige nada', () => {
  assert.equal(v.minimoDeQuebras('Oi {vaga}\ntchau'), 1);
  assert.equal(v.minimoDeQuebras('Oi {vaga}, tchau'), 0);
  assert.ok(!codigos(contra('Ola {vaga}, ate logo', 'Oi {vaga}, tchau')).includes(v.PROBLEMA_SEM_QUEBRAS));
});

test('sem_quebras: \\r\\n conta como uma quebra (texto vindo do <textarea>)', () => {
  assert.equal(v.contarQuebras('a\r\nb\r\n\r\nc'), 3);
  assert.equal(v.contarQuebras(BASE_LEMBRETE.replace(/\n/g, '\r\n')), v.contarQuebras(BASE_LEMBRETE));
});

test('as sementes passam em sem_quebras contra o texto-base padrao', () => {
  for (const [i, s] of v.VARIACOES_SEED.entries()) {
    assert.ok(!codigos(v.validarContraTextoBase(s, v.TEXTO_BASE_PADRAO, i + 1)).includes(v.PROBLEMA_SEM_QUEBRAS), `semente ${i + 1}`);
  }
});
