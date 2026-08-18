'use strict';

// Extracao de texto e mapeamento de tipo de arquivo do curriculo (src/lib/curriculo.js).
//
// ── O QUE ESTA EM JOGO (extensaoDoArquivo) ──
// Ate este incremento, o arquivo era sempre salvo como "<token>.pdf" no disco, independente
// do mimetype real — inofensivo enquanto so PDF passava pelo fileFilter, mas quebraria os
// dois pontos de download do admin (Content-Type + extensao) no dia em que outros tipos
// fossem aceitos. extensaoDoArquivo() e a fonte unica que evita essa divergencia.

const fs = require('node:fs');
const path = require('node:path');

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  extrairTextoPdf,
  extrairTextoDocx,
  extrairTextoCurriculo,
  extensaoDoArquivo,
  TIPOS_CURRICULO_ACEITOS,
} = require('../src/lib/curriculo');
const entrevista = require('../src/lib/entrevista');

// Fixture real do proprio mammoth (test/fixtures/single-paragraph.docx), conteudo
// conhecido: "Walking on imported air". Copiado pro repo em vez de referenciado dentro de
// node_modules — nao pode depender de um caminho interno de outro pacote que pode mudar.
const DOCX_REAL = fs.readFileSync(path.join(__dirname, 'fixtures', 'single-paragraph.docx'));

test('extensaoDoArquivo: cada mimetype aceito mapeia pra extensao certa', () => {
  assert.equal(extensaoDoArquivo({ mimetype: 'application/pdf', originalname: 'x.pdf' }), 'pdf');
  assert.equal(extensaoDoArquivo({ mimetype: 'image/jpeg', originalname: 'foto.jpg' }), 'jpg');
  assert.equal(extensaoDoArquivo({ mimetype: 'image/png', originalname: 'foto.png' }), 'png');
  assert.equal(
    extensaoDoArquivo({
      mimetype: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      originalname: 'currículo.docx',
    }),
    'docx',
  );
});

test('extensaoDoArquivo: mimetype fora do mapa cai pra extensao do NOME original', () => {
  assert.equal(extensaoDoArquivo({ mimetype: 'application/octet-stream', originalname: 'arquivo.png' }), 'png');
  // Maiuscula no nome vira minuscula (arquivo em disco fica previsivel).
  assert.equal(extensaoDoArquivo({ mimetype: 'x', originalname: 'FOTO.JPG' }), 'jpg');
});

test('extensaoDoArquivo: sem mimetype conhecido e sem extensao no nome -> "bin", nunca sem extensao', () => {
  assert.equal(extensaoDoArquivo({ mimetype: 'x', originalname: 'arquivo-sem-extensao' }), 'bin');
  assert.equal(extensaoDoArquivo({}), 'bin');
  assert.equal(extensaoDoArquivo(null), 'bin');
});

test('TIPOS_CURRICULO_ACEITOS: lista fechada com os 4 tipos da decisao de produto', () => {
  const mimetypes = TIPOS_CURRICULO_ACEITOS.map((t) => t.mimetype).sort();
  assert.deepEqual(mimetypes, [
    'application/pdf',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'image/jpeg',
    'image/png',
  ].sort());
});

test('extrairTextoPdf: PDF ilegivel devolve "" sem lancar (comportamento existente, nao regrediu)', async () => {
  const texto = await extrairTextoPdf(Buffer.from('nao e um pdf de verdade'));
  assert.equal(texto, '');
});

// ══════════════════ extrairTextoDocx (Incremento 5) ══════════════════

test('extrairTextoDocx: DOCX real extrai o texto correto', async () => {
  const texto = await extrairTextoDocx(DOCX_REAL);
  assert.equal(texto, 'Walking on imported air');
});

test('extrairTextoDocx: DOCX ilegivel/corrompido devolve "" sem lancar', async () => {
  const texto = await extrairTextoDocx(Buffer.from('nao e um docx de verdade'));
  assert.equal(texto, '');
});

// ══════════════════ extrairTextoCurriculo — dispatcher por tipo (Incremento 5) ══════════════════

test('extrairTextoCurriculo: PDF usa extrairTextoPdf', async () => {
  const texto = await extrairTextoCurriculo({ mimetype: 'application/pdf', buffer: Buffer.from('nao e pdf') });
  assert.equal(texto, ''); // buffer nao e PDF de verdade, so confirma que passou pelo extrator certo (nao lancou)
});

test('extrairTextoCurriculo: DOCX usa extrairTextoDocx e extrai o texto real', async () => {
  const texto = await extrairTextoCurriculo({
    mimetype: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    buffer: DOCX_REAL,
  });
  assert.equal(texto, 'Walking on imported air');
});

test('extrairTextoCurriculo: JPG e PNG NAO passam por extracao nenhuma — "" sem lancar (decisao: sem OCR)', async () => {
  assert.equal(await extrairTextoCurriculo({ mimetype: 'image/jpeg', buffer: Buffer.from('foto') }), '');
  assert.equal(await extrairTextoCurriculo({ mimetype: 'image/png', buffer: Buffer.from('foto') }), '');
});

test('extrairTextoCurriculo: sem file -> "" sem lancar', async () => {
  assert.equal(await extrairTextoCurriculo(null), '');
  assert.equal(await extrairTextoCurriculo(undefined), '');
});

// ══════════════════ Nao regride: Vera degrada sozinha com curriculo_texto vazio ══════════════════
//
// JPG/PNG (Incremento 5) produzem curriculo_texto='' pelo MESMO caminho que um PDF ilegivel
// ja produzia antes — este teste confirma que lib/entrevista.js#montarSystemPrompt (o
// consumidor) trata os dois igual, sem tratamento novo do lado da Vera.
test('montarSystemPrompt com curriculo_texto vazio/null degrada pra "(curriculo nao disponivel)", nao quebra', () => {
  const roteiro = {
    estrutura: {
      metodo: 'BEI',
      instrucoes_gerais: ['Peça exemplos concretos.'],
      competencias: [{ nome: 'Resiliência', peso: 1 }],
      blocos: [
        {
          id: 'abertura',
          nome: 'Abertura',
          pergunta_semente: 'Fale sobre você.',
          instrucao_vera: 'Deixe o candidato confortável.',
        },
      ],
    },
  };

  for (const vazio of ['', null, undefined]) {
    const prompt = entrevista.montarSystemPrompt({
      roteiro,
      curriculoTexto: vazio,
      agente: 'Vera',
      maxPerguntas: 12,
    });
    assert.match(prompt, /\(curriculo nao disponivel\)/i, JSON.stringify(vazio));
  }
});
