'use strict';

// Normalizacao e deduplicacao da base legada (src/lib/importarLegado.js).
//
// ZERO BANCO, ZERO DISCO: o modulo e puro de proposito, e estes testes exercitam as regras
// que decidem o que 7 mil pessoas viram no sistema. Cada uma delas roda UMA vez, num script
// manual, sobre um arquivo que nao vai voltar — nao ha "corrige na proxima execucao".
//
// O que cada bloco guarda:
//   cargo   — o dicionario e por TABELA. Um valor novo num export futuro tem que aparecer
//             como "nao mapeado", nunca ser absorvido por heuristica de prefixo.
//   dedupe  — a ORDEM (excluir cargo antes de deduplicar) muda o resultado em 26 pessoas.
//   telefone— o export contradiz a premissa da decisao; a regra nao pode duplicar DDI.
//   data    — o date() do SQLite nao entende "+00" nem microssegundos.

const test = require('node:test');
const assert = require('node:assert/strict');

const imp = require('../src/lib/importarLegado');

// Linha crua minima, no formato que linhasComoObjetos devolve.
function linha(campos = {}) {
  return {
    id: '1',
    created_at: '2025-09-29 03:04:27.981392+00',
    fullname: 'Pessoa Legada',
    email: 'pessoa@exemplo.com',
    whatsapp: '+5547989251350',
    utm_source: 'meta-ads',
    cargo: 'Vendedor',
    empresa: 'Godi Transportes',
    codigo_vaga: 'PS0001',
    codigo_ps: '',
    ...campos,
  };
}

const prep = (linhas, extra = {}) => imp.prepararImportacao({ linhas, ...extra });

// ══════════════════════════════════════════════════════════════
// 1. Parser de CSV
// ══════════════════════════════════════════════════════════════

test('parseCsv: campos simples, CRLF e LF', () => {
  assert.deepEqual(imp.parseCsv('a,b\r\n1,2\r\n'), [['a', 'b'], ['1', '2']]);
  assert.deepEqual(imp.parseCsv('a,b\n1,2\n'), [['a', 'b'], ['1', '2']]);
});

test('parseCsv: aspas protegem virgula, e "" vira uma aspa', () => {
  assert.deepEqual(imp.parseCsv('a,b\n"Silva, Joao",2\n'), [['a', 'b'], ['Silva, Joao', '2']]);
  assert.deepEqual(imp.parseCsv('a\n"diz ""oi"""\n'), [['a'], ['diz "oi"']]);
});

test('parseCsv: quebra de linha DENTRO de campo entre aspas nao parte a linha', () => {
  const linhas = imp.parseCsv('a,b\n"linha1\nlinha2",2\n');
  assert.equal(linhas.length, 2, 'o \\n entre aspas nao pode virar nova linha do CSV');
  assert.equal(linhas[1][0], 'linha1\nlinha2');
});

test('parseCsv: BOM no inicio nao contamina o nome da primeira coluna', () => {
  const { cabecalho } = imp.linhasComoObjetos('﻿id,email\n1,a@b.co\n');
  assert.equal(cabecalho[0], 'id', 'com BOM, o lookup por nome de coluna falharia');
});

test('linhasComoObjetos: nomeia pelas colunas do cabecalho e ignora a linha vazia final', () => {
  const { registros } = imp.linhasComoObjetos('id,email\n1,a@b.co\n2,c@d.co\n');
  assert.equal(registros.length, 2);
  assert.deepEqual(registros[0], { id: '1', email: 'a@b.co' });
});

// ══════════════════════════════════════════════════════════════
// 2. Dicionario de cargo
// ══════════════════════════════════════════════════════════════

test('normalizarCargo: os 18 valores aproveitaveis viram os 6 canonicos', () => {
  const esperado = {
    'Consultor Comercial': 'Consultor Comercial',
    Consultor: 'Consultor Comercial',
    consultor: 'Consultor Comercial',
    'consultor-comercial-sp': 'Consultor Comercial',
    'Consultor CLT': 'Consultor Comercial',
    'Consultora CLT': 'Consultor Comercial',
    CLT: 'Consultor Comercial',
    Vendedor: 'Vendedor',
    'Vendedor Interno': 'Vendedor',
    'Vendedor Cabotagem': 'Vendedor',
    SDR: 'SDR',
    'SDR PJ': 'SDR',
    BDR: 'BDR',
    'Closer PJ': 'Closer',
    PJ: 'Closer',
    'Coordenador Comercial': 'Liderança Comercial',
    Coordenador: 'Liderança Comercial',
    supervisor: 'Liderança Comercial',
  };
  for (const [bruto, canonico] of Object.entries(esperado)) {
    assert.deepEqual(
      imp.normalizarCargo(bruto),
      { tipo: 'canonico', cargo: canonico },
      `${bruto} deveria virar ${canonico}`,
    );
  }
});

test('normalizarCargo: CS e fullstack sao EXCLUIDOS, nao "nao mapeados"', () => {
  // A distincao importa: excluido e decisao tomada; nao mapeado e pedido de socorro.
  assert.equal(imp.normalizarCargo('CS').tipo, 'excluido');
  assert.equal(imp.normalizarCargo('fullstack').tipo, 'excluido');
});

test('normalizarCargo: valor desconhecido vira naoMapeado, nunca um palpite', () => {
  for (const bruto of ['Gerente', 'CONSULTOR COMERCIAL', 'Consultor Comercial SP', '', 'sdr']) {
    const r = imp.normalizarCargo(bruto);
    assert.equal(r.tipo, 'naoMapeado', `${JSON.stringify(bruto)} nao pode ser mapeado por acaso`);
  }
});

test('normalizarCargo: a tabela e case-sensitive de proposito', () => {
  // 'consultor' e 'Consultor' sao entradas SEPARADAS. Normalizar a caixa antes do lookup
  // reintroduziria o casamento acidental que a tabela existe para evitar.
  assert.equal(imp.normalizarCargo('consultor').tipo, 'canonico');
  assert.equal(imp.normalizarCargo('CONSULTOR').tipo, 'naoMapeado');
});

test('perfilDeCargo: so SDR e Closer tem contraparte no enum de perfil_interesse', () => {
  assert.equal(imp.perfilDeCargo('SDR'), 'SDR');
  assert.equal(imp.perfilDeCargo('Closer'), 'CLOSER');
  for (const cargo of ['Consultor Comercial', 'Vendedor', 'BDR', 'Liderança Comercial']) {
    assert.equal(imp.perfilDeCargo(cargo), null, `${cargo} nao cabe no CHECK SDR|CLOSER`);
  }
});

// ══════════════════════════════════════════════════════════════
// 3. Telefone
// ══════════════════════════════════════════════════════════════

test('normalizarTelefone: 13 digitos com DDI nao duplicam o +55', () => {
  // 94,5% do export. "+55 5547989186990" seria o bug mais visivel da importacao.
  assert.deepEqual(imp.normalizarTelefone('+5547989186990'), {
    telefone: '+55 47989186990',
    anomalia: null,
  });
  assert.deepEqual(imp.normalizarTelefone('p:+5547989186990'), {
    telefone: '+55 47989186990',
    anomalia: null,
  });
});

test('normalizarTelefone: pontuacao e prefixo de lead do Meta somem', () => {
  assert.equal(imp.normalizarTelefone('(47) 98894-5058').telefone, '+55 47988945058');
  assert.equal(imp.normalizarTelefone('(55) 47997-8691').telefone, '+55 55479978691');
});

test('normalizarTelefone: 11 e 10 digitos ja sao nacionais e passam direto', () => {
  assert.equal(imp.normalizarTelefone('47989251350').telefone, '+55 47989251350');
  assert.equal(imp.normalizarTelefone('4792460550').telefone, '+55 4792460550');
});

test('normalizarTelefone: 12 digitos com 55 perdem so o DDI', () => {
  assert.equal(imp.normalizarTelefone('p:+553388980628').telefone, '+55 3388980628');
});

test('normalizarTelefone: comprimento fora do esperado vira NULL, nunca um palpite', () => {
  // Lixo de teste do formulario de lead e numeros de 14 digitos. Um telefone inventado e
  // pior que um vazio: alguem ligaria para ele.
  for (const bruto of ['p:<test lead: dummy data for phone_number>', '', 'p:+55519985481878']) {
    const r = imp.normalizarTelefone(bruto);
    assert.equal(r.telefone, null, `${bruto} nao deveria virar telefone`);
    assert.notEqual(r.anomalia, null, 'a anomalia precisa ser sinalizada para o relatorio');
  }
});

// ══════════════════════════════════════════════════════════════
// 4. Data
// ══════════════════════════════════════════════════════════════

test('normalizarDataCriacao: timestamptz do Postgres vira o formato do SQLite', () => {
  // Sem esta conversao, date(t.criado_em) nao casaria com nenhuma janela de datas do
  // filtro de campanha — a fracao de microssegundos e o "+00" atrapalham o date() do SQLite.
  assert.equal(imp.normalizarDataCriacao('2025-09-29 03:04:27.981392+00'), '2025-09-29 03:04:27');
  assert.equal(imp.normalizarDataCriacao('2026-07-31 19:14:14.522542+00'), '2026-07-31 19:14:14');
});

test('normalizarDataCriacao: offset diferente de +00 e convertido para UTC', () => {
  // Nenhuma linha do export atual tem, mas fatiar a string em vez de converter deixaria a
  // hora errada no dia em que tivesse.
  assert.equal(imp.normalizarDataCriacao('2025-09-29 00:04:27-03'), '2025-09-29 03:04:27');
});

test('normalizarDataCriacao: data ilegivel ou vazia devolve null', () => {
  for (const bruto of ['', null, undefined, 'ontem', '99-99-99']) {
    assert.equal(imp.normalizarDataCriacao(bruto), null);
  }
});

// ══════════════════════════════════════════════════════════════
// 5. campos_extras
// ══════════════════════════════════════════════════════════════

test('montarCamposExtras: os tres metadados da origem', () => {
  assert.deepEqual(
    imp.montarCamposExtras({ empresa: 'Godi', codigo_vaga: 'PS0001', utm_source: 'meta-ads' }),
    { empresa_origem: 'Godi', codigo_vaga_origem: 'PS0001', utm_source_origem: 'meta-ads' },
  );
});

test('montarCamposExtras: codigo_ps entra quando codigo_vaga esta vazio', () => {
  assert.equal(
    imp.montarCamposExtras({ codigo_vaga: '', codigo_ps: 'PS0006' }).codigo_vaga_origem,
    'PS0006',
  );
  // Com os dois preenchidos vence codigo_vaga (a coluna mais povoada do export).
  assert.equal(
    imp.montarCamposExtras({ codigo_vaga: 'PS0001', codigo_ps: 'PS0006' }).codigo_vaga_origem,
    'PS0001',
  );
});

test('montarCamposExtras: chave ausente em vez de null', () => {
  assert.deepEqual(imp.montarCamposExtras({ empresa: '  ', codigo_vaga: '', utm_source: '' }), {});
});

// ══════════════════════════════════════════════════════════════
// 6. A pipeline: exclusao, dedupe e colisoes
// ══════════════════════════════════════════════════════════════

test('prepararImportacao: monta o registro completo, pronto para o banco', () => {
  const { registros, relatorio } = prep([linha()]);
  assert.equal(relatorio.aInserir, 1);
  assert.deepEqual(registros[0], {
    nome: 'Pessoa Legada',
    email: 'pessoa@exemplo.com',
    telefone: '+55 47989251350',
    perfil_interesse: null, // Vendedor nao mapeia
    categoria: 'legado',
    cargo: 'Vendedor',
    campos_extras: JSON.stringify({
      empresa_origem: 'Godi Transportes',
      codigo_vaga_origem: 'PS0001',
      utm_source_origem: 'meta-ads',
    }),
    consent_at: null,
    criado_em: '2025-09-29 03:04:27',
  });
});

test('prepararImportacao: consent_at e SEMPRE null', () => {
  const { registros } = prep([linha({ cargo: 'SDR' }), linha({ email: 'b@x.com', cargo: 'Closer' })]);
  for (const r of registros) assert.equal(r.consent_at, null);
});

test('prepararImportacao: CS e fullstack sao excluidos e contados por valor bruto', () => {
  const { registros, relatorio } = prep([
    linha({ email: 'a@x.com', cargo: 'CS' }),
    linha({ email: 'b@x.com', cargo: 'fullstack' }),
    linha({ email: 'c@x.com', cargo: 'Vendedor' }),
  ]);
  assert.equal(registros.length, 1);
  assert.equal(relatorio.excluidosPorCargo.get('CS'), 1);
  assert.equal(relatorio.excluidosPorCargo.get('fullstack'), 1);
});

test('prepararImportacao: cargo nao mapeado NAO entra e NAO some — vai para o relatorio', () => {
  const { registros, relatorio } = prep([
    linha({ email: 'a@x.com', cargo: 'Gerente de Contas' }),
    linha({ email: 'b@x.com', cargo: 'Gerente de Contas' }),
  ]);
  assert.equal(registros.length, 0, 'nao pode ser importado com mapeamento inventado');
  assert.equal(relatorio.naoMapeados.get('Gerente de Contas'), 2, 'nem descartado em silencio');
});

test('prepararImportacao: linha sem e-mail ou com data ilegivel e descartada e contada', () => {
  const { registros, relatorio } = prep([
    linha({ email: '' }),
    linha({ email: '   ' }),
    linha({ email: 'ok@x.com', created_at: 'ontem' }),
  ]);
  assert.equal(registros.length, 0);
  assert.equal(relatorio.semEmail, 2);
  assert.equal(relatorio.semData, 1);
});

test('prepararImportacao: dedupe mantem a linha de created_at MAIS RECENTE', () => {
  const { registros, relatorio } = prep([
    linha({ email: 'dup@x.com', cargo: 'SDR', created_at: '2025-01-01 10:00:00+00' }),
    linha({ email: 'dup@x.com', cargo: 'BDR', created_at: '2026-05-05 10:00:00+00' }),
    linha({ email: 'dup@x.com', cargo: 'Vendedor', created_at: '2025-06-06 10:00:00+00' }),
  ]);
  assert.equal(registros.length, 1);
  assert.equal(registros[0].cargo, 'BDR', 'vence a mais recente, independente da ordem no arquivo');
  assert.equal(registros[0].criado_em, '2026-05-05 10:00:00');
  assert.equal(relatorio.duplicataInterna, 2);
});

test('prepararImportacao: dedupe compara DATA, nao string', () => {
  // Fracoes de tamanho diferente fariam a comparacao lexicografica escolher errado:
  // '...:27.9' > '...:27.10' como string, mas 27.10s e depois de 27.9s? Nao — o risco real
  // e outro: offsets diferentes. Com offset, a string maior pode ser o instante MENOR.
  const { registros } = prep([
    linha({ email: 'tz@x.com', cargo: 'SDR', created_at: '2025-03-10 23:00:00+00' }),
    linha({ email: 'tz@x.com', cargo: 'BDR', created_at: '2025-03-10 21:00:00-03' }), // = 00:00 UTC do dia 11
  ]);
  assert.equal(registros[0].cargo, 'BDR', 'o instante mais recente em UTC e o que vale');
});

test('prepararImportacao: dedupe usa e-mail NORMALIZADO', () => {
  const { registros, relatorio } = prep([
    linha({ email: 'Mesma.Pessoa@Exemplo.COM' }),
    linha({ email: '  mesma.pessoa@exemplo.com  ' }),
  ]);
  assert.equal(registros.length, 1);
  assert.equal(relatorio.duplicataInterna, 1);
  assert.equal(registros[0].email, 'mesma.pessoa@exemplo.com', 'gravado ja normalizado');
});

test('prepararImportacao: EXCLUI cargo ANTES de deduplicar (a ordem muda o resultado)', () => {
  // Pessoa cuja linha mais recente e CS, mas que tambem se candidatou como Vendedor.
  // Deduplicando primeiro, a linha vencedora seria CS e a pessoa sumiria. Sao 26 pessoas
  // no export real.
  const { registros } = prep([
    linha({ email: 'mista@x.com', cargo: 'Vendedor', created_at: '2025-01-01 10:00:00+00' }),
    linha({ email: 'mista@x.com', cargo: 'CS', created_at: '2026-01-01 10:00:00+00' }),
  ]);
  assert.equal(registros.length, 1, 'a pessoa e aproveitavel; o que se exclui e o cargo');
  assert.equal(registros[0].cargo, 'Vendedor');
});

test('prepararImportacao: colisao com talentos EXCLUI', () => {
  const { registros, relatorio } = prep([linha({ email: 'ja@talentos.com' })], {
    emailsTalentos: ['  JA@Talentos.com '], // cru e com caixa: o banco guarda assim
  });
  assert.equal(registros.length, 0, 'seria uma segunda linha da mesma pessoa na mesma tabela');
  assert.equal(relatorio.colisaoTalentos, 1);
});

test('prepararImportacao: colisao com applications REPORTA mas NAO exclui', () => {
  // Tabelas separadas, finalidades LGPD distintas, e promocaoVagas ja deduplica por e-mail
  // na leitura — nao ha risco de e-mail duplicado.
  const { registros, relatorio } = prep([linha({ email: 'ja@candidata.com' })], {
    emailsApplications: ['JA@Candidata.com'],
  });
  assert.equal(registros.length, 1, 'ser candidata nao impede estar no banco de talentos');
  assert.equal(relatorio.colisaoApplications, 1);
});

test('prepararImportacao: telefone anomalo nao bloqueia a pessoa, so e contado', () => {
  const { registros, relatorio } = prep([
    linha({ email: 'lixo@x.com', whatsapp: 'p:<test lead: dummy data for phone_number>' }),
  ]);
  assert.equal(registros.length, 1, 'o contato da campanha e por e-mail');
  assert.equal(registros[0].telefone, null);
  assert.equal(relatorio.telefoneAnomalo, 1);
});

test('prepararImportacao: contagens por cargo e por perfil fecham com o total', () => {
  const { relatorio } = prep([
    linha({ email: 'a@x.com', cargo: 'SDR' }),
    linha({ email: 'b@x.com', cargo: 'Closer PJ' }),
    linha({ email: 'c@x.com', cargo: 'Vendedor' }),
    linha({ email: 'd@x.com', cargo: 'Coordenador' }),
  ]);
  assert.equal(relatorio.aInserir, 4);
  assert.equal(relatorio.porCargo.get('SDR'), 1);
  assert.equal(relatorio.porCargo.get('Closer'), 1);
  assert.equal(relatorio.porCargo.get('Vendedor'), 1);
  assert.equal(relatorio.porCargo.get('Liderança Comercial'), 1);
  assert.equal(relatorio.comPerfil, 2, 'SDR + Closer');
  assert.equal(relatorio.semPerfil, 2);
  assert.equal(relatorio.comPerfil + relatorio.semPerfil, relatorio.aInserir);
});

test('prepararImportacao: entrada vazia devolve relatorio zerado sem quebrar', () => {
  const { registros, relatorio } = prep([]);
  assert.equal(registros.length, 0);
  assert.equal(relatorio.linhasLidas, 0);
  assert.equal(relatorio.aInserir, 0);
  assert.deepEqual(imp.prepararImportacao({}).registros, []);
});
