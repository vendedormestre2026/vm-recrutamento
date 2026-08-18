'use strict';

// Extracao de texto e mapeamento de tipo de arquivo do curriculo (src/lib/curriculo.js).
//
// ── O QUE ESTA EM JOGO (extensaoDoArquivo) ──
// Ate este incremento, o arquivo era sempre salvo como "<token>.pdf" no disco, independente
// do mimetype real — inofensivo enquanto so PDF passava pelo fileFilter, mas quebraria os
// dois pontos de download do admin (Content-Type + extensao) no dia em que outros tipos
// fossem aceitos. extensaoDoArquivo() e a fonte unica que evita essa divergencia.

const test = require('node:test');
const assert = require('node:assert/strict');

const { extrairTextoPdf, extensaoDoArquivo, TIPOS_CURRICULO_ACEITOS } = require('../src/lib/curriculo');

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
