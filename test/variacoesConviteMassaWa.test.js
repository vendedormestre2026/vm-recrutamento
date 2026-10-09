'use strict';

// Tipos de variacao do disparo em massa (lib/variacoesMassaWa): o tipo de sempre (entrevista em
// grupo) continua o padrao e identico; o convite para candidatura (segmento da base) tem tokens
// proprios. Funcoes puras: sem banco, sem rede.

process.env.INTERVIEW_MOCK = 'true';
process.env.SESSION_SECRET = 'segredo-de-teste';
process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert/strict');
const v = require('../src/lib/variacoesMassaWa');

const CONVITE = { tipo: v.TIPO_CONVITE_CANDIDATURA };

test('REGRESSAO: sem tipo, a validacao e a de sempre (tokens e obrigatorios inalterados)', () => {
  assert.deepEqual([...v.TOKENS], ['saudacao', 'recrutador', 'vaga', 'empresa', 'data', 'horario', 'link_meet', 'link_descadastro']);
  assert.deepEqual(v.validarVariacoes([...v.VARIACOES_SEED]), v.validarVariacoes([...v.VARIACOES_SEED], { tipo: v.TIPO_ENTREVISTA_GRUPO }));
  assert.ok(v.validarVariacoes([...v.VARIACOES_SEED]).ok);
  assert.equal(v.tokensDoTipo().obrigatorios, v.TOKENS_OBRIGATORIOS);
});

test('as 7 sementes do convite passam no tipo convite e NAO passam no tipo entrevista', () => {
  assert.equal(v.VARIACOES_SEED_CONVITE.length, v.TOTAL_VARIACOES);
  assert.deepEqual(v.validarVariacoes([...v.VARIACOES_SEED_CONVITE], CONVITE), { ok: true, problemas: [] });
  assert.equal(v.validarVariacoes([...v.VARIACOES_SEED_CONVITE]).ok, false);
});

test('toda semente do convite diz quem escreve, de onde nos conhece, o link da vaga e o descadastro', () => {
  for (const t of v.VARIACOES_SEED_CONVITE) {
    for (const tok of ['{recrutador}', '{cidade}', '{vaga}', '{empresa}', '{link_vaga}', '{link_descadastro}']) {
      assert.ok(t.includes(tok), `${tok} ausente em: ${t.slice(0, 40)}`);
    }
    assert.ok(t.length <= v.MAX_CARACTERES);
  }
});

test('convite: {data}, {horario} e {link_meet} sao DESCONHECIDOS (sairiam literais)', () => {
  const t = `${v.VARIACOES_SEED_CONVITE[0]}\n{data} {horario} {link_meet}`;
  const p = v.validarVariacao(t, 1, CONVITE);
  assert.deepEqual(p.find((x) => x.codigo === v.PROBLEMA_TOKEN_DESCONHECIDO).tokens.sort(), ['data', 'horario', 'link_meet']);
});

test('entrevista: {link_vaga} e {cidade} sao DESCONHECIDOS no tipo de sempre', () => {
  const p = v.validarVariacao(`${v.VARIACOES_SEED[0]} {link_vaga} {cidade}`, 1);
  assert.deepEqual(p.find((x) => x.codigo === v.PROBLEMA_TOKEN_DESCONHECIDO).tokens.sort(), ['cidade', 'link_vaga']);
});

test('convite: sem {link_vaga} ou sem {cidade} e token faltando; sem descadastro e problema proprio', () => {
  const sem = v.VARIACOES_SEED_CONVITE[0].replace('{link_vaga}', '').replace('{cidade}', 'Joinville');
  assert.deepEqual(v.validarVariacao(sem, 1, CONVITE).find((x) => x.codigo === v.PROBLEMA_TOKEN_FALTANDO).tokens.sort(), ['cidade', 'link_vaga']);
  const semDescadastro = v.VARIACOES_SEED_CONVITE[0].replace('{link_descadastro}', '');
  assert.ok(v.validarVariacao(semDescadastro, 1, CONVITE).some((x) => x.codigo === v.PROBLEMA_SEM_DESCADASTRO));
});

test('tipo desconhecido LANCA', () => {
  assert.throws(() => v.validarVariacoes(['x'], { tipo: 'outro' }), /desconhecido/);
  assert.throws(() => v.resolverTexto('x', {}, { tipo: 'outro' }), /desconhecido/);
});

test('tipoPorFonte: segmento -> convite; sem fonte -> entrevista', () => {
  assert.equal(v.tipoPorFonte('segmento'), v.TIPO_CONVITE_CANDIDATURA);
  assert.equal(v.tipoPorFonte(undefined), v.TIPO_ENTREVISTA_GRUPO);
  assert.equal(v.tipoPorFonte('vagas_abertas'), v.TIPO_ENTREVISTA_GRUPO);
});

test('linkVagaPara: /vaga/<slug> com utm_source=massa-wa e utm_campaign=massa-<id>', () => {
  const u = new URL(v.linkVagaPara('vendedor-jlle', 12, { baseUrl: 'https://exemplo.com.br' }));
  assert.equal(u.pathname, '/vaga/vendedor-jlle');
  assert.equal(u.searchParams.get('utm_source'), 'massa-wa');
  assert.equal(u.searchParams.get('utm_campaign'), 'massa-12');
  assert.equal(v.linkVagaPara('', 12), '');
  assert.equal(v.linkVagaPara('x', null), '');
});

test('resolverTexto do convite: preenche tudo; link de vaga ausente vira `faltando`', () => {
  const ctx = v.montarContextoConvite({
    nome: 'Maria Souza',
    job: { titulo: 'Vendedor', empresa: 'Loja X' },
    cidade: 'Joinville',
    linkVaga: 'https://e/vaga/x?utm_source=massa-wa',
    linkDescadastro: 'https://e/descadastro-whatsapp/tok',
    recrutador: 'Jean Dentz',
  });
  const ok = v.resolverTexto(v.VARIACOES_SEED_CONVITE[0], ctx, CONVITE);
  assert.deepEqual(ok.faltando, []);
  assert.doesNotMatch(ok.texto, /\{[^}]+\}/);
  assert.match(ok.texto, /Jean/);
  assert.match(ok.texto, /Joinville/);

  const semLink = v.resolverTexto(v.VARIACOES_SEED_CONVITE[0], { ...ctx, link_vaga: '' }, CONVITE);
  assert.deepEqual(semLink.faltando, ['link_vaga']);
});

test('sementesDoTipo / textoBaseDoTipo', () => {
  assert.equal(v.sementesDoTipo(), v.VARIACOES_SEED);
  assert.equal(v.sementesDoTipo(v.TIPO_CONVITE_CANDIDATURA), v.VARIACOES_SEED_CONVITE);
  assert.equal(v.textoBaseDoTipo(), v.TEXTO_BASE_PADRAO);
  assert.equal(v.textoBaseDoTipo(v.TIPO_CONVITE_CANDIDATURA), v.TEXTO_BASE_CONVITE);
});

// ══════════════════ CORTE DO "| {empresa}" NO TITULO (so convite) ══════════════════

const JOB_DUO = { titulo: 'Consultor Comercial | DUO Oral Care', empresa: 'DUO Oral Care' };

test('corte: titulo terminado em "| {empresa}" perde o final (sem maiusculas, sem acentos, espacos tolerados)', () => {
  assert.equal(v.tituloSemEmpresa(JOB_DUO.titulo, JOB_DUO.empresa), 'Consultor Comercial');
  assert.equal(v.tituloSemEmpresa('Executivo de Vendas Interno|H+ Arquitetura', 'H+ Arquitetura'), 'Executivo de Vendas Interno');
  assert.equal(v.tituloSemEmpresa('Vendedor  |   AÇÚCAR  união ', 'Acucar Uniao'), 'Vendedor');
  const ctx = v.montarContextoConvite({ nome: 'Maria', job: JOB_DUO, cidade: 'Joinville', linkVaga: 'https://e/v', linkDescadastro: 'https://e/d', recrutador: 'Jean Dentz' });
  assert.equal(ctx.vaga, 'Consultor Comercial');
  assert.equal(ctx.empresa, 'DUO Oral Care');
  const { texto } = v.resolverTexto(v.VARIACOES_SEED_CONVITE[6], ctx, CONVITE);
  assert.match(texto, /\*Consultor Comercial\*, na \*DUO Oral Care\*/);
  assert.equal(texto.split('DUO Oral Care').length - 1, 1);
});

test('corte: titulo sem a empresa fica intacto', () => {
  assert.equal(v.tituloSemEmpresa('Consultor Comercial', 'DUO Oral Care'), 'Consultor Comercial');
  assert.equal(v.tituloSemEmpresa('Consultor Comercial DUO Oral Care', 'DUO Oral Care'), 'Consultor Comercial DUO Oral Care');
});

test('corte: OUTRA empresa no final fica intacta (inclusive empresa contida no final)', () => {
  assert.equal(v.tituloSemEmpresa('Consultor | Outra Ltda', 'DUO Oral Care'), 'Consultor | Outra Ltda');
  assert.equal(v.tituloSemEmpresa('Consultor | DUO Oral Care Joinville', 'DUO Oral Care'), 'Consultor | DUO Oral Care Joinville');
  assert.equal(v.tituloSemEmpresa('Consultor | DUO Oral Care', ''), 'Consultor | DUO Oral Care');
});

test('corte: titulo que ficaria vazio NAO e cortado', () => {
  assert.equal(v.tituloSemEmpresa('| DUO Oral Care', 'DUO Oral Care'), '| DUO Oral Care');
  assert.equal(v.tituloSemEmpresa('  |  DUO Oral Care', 'DUO Oral Care'), '|  DUO Oral Care');
});

test('REGRESSAO: tipo entrevista mantem o titulo inteiro, texto identico ao de antes', () => {
  const proxima = { dataTexto: 'quinta, 01/10', horaTexto: '19h30', linkMeet: 'https://calendly.com/x' };
  const ctx = v.montarContexto({ nome: 'Maria', job: JOB_DUO, proxima, linkDescadastro: 'https://e/d', recrutador: 'Jean Dentz' });
  assert.equal(ctx.vaga, 'Consultor Comercial | DUO Oral Care');
  for (const semente of v.VARIACOES_SEED) {
    const esperado = semente.replace(/\{(\w+)\}/g, (_, k) => ctx[k]);
    assert.equal(v.resolverTexto(semente, ctx).texto, esperado);
  }
});
