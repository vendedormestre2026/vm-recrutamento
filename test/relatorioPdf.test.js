'use strict';

// Geracao do relatorio em PDF (src/lib/relatorioPdf.js).
//
// REGRESSAO QUE ESTE ARQUIVO GUARDA — a primeira versao do rodape desenhava dentro de um
// listener de 'pageAdded'. Como o texto era escrito com `width`, ele passava pelo
// LineWrapper do pdfkit, que testa `y + altura da linha > page.maxY()` e chama addPage()
// sozinho; e o y do rodape mora, por definicao, ABAIXO de maxY (na faixa da margem
// inferior). O proprio rodape paginava o documento: saiam paginas em branco alternadas,
// com o rodape no topo da pagina seguinte, colado a frase que tinha sido cortada.
// O PDF continuava "valido" e com o texto todo presente — por isso um teste que so
// checasse bytes ou procurasse strings NAO pegaria isto. As duas assercoes que pegam sao
// "nenhuma pagina em branco" e "o rodape fica abaixo de todo o conteudo".
//
// POR QUE NAO USAMOS pdf-parse AQUI — o projeto ja tem pdf-parse (leitura de curriculo),
// mas o pdf.js por baixo dele falha de forma INTERMITENTE ao ler um PDF recem-gerado no
// mesmo processo ("bad XRef entry" em ~4 de 5 execucoes, com o mesmo arquivo, sendo que o
// arquivo esta integro: xref no offset correto e %%EOF no lugar). Um teste flaky e pior
// que nenhum, entao lemos o PDF aqui mesmo: os content streams do pdfkit sao Flate, o
// zlib do Node descomprime, e os operadores `Tm` (posicao) + `TJ` (texto em hex) dao o
// que precisamos. Deterministico e sem dependencia nova.

const os = require('node:os');
const path = require('node:path');
const zlib = require('node:zlib');

process.env.DATABASE_PATH = path.join(os.tmpdir(), `vm-test-pdf-${process.pid}-${Date.now()}.db`);
process.env.INTERVIEW_MOCK = 'true';
process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert/strict');

const { gerarRelatorioPdf, slugNome } = require('../src/lib/relatorioPdf');

// ── Leitura do PDF sem dependencia externa ──

// Texto de um operador TJ: junta os pedacos <hex>. WinAnsi e latin1 coincidem na faixa
// acentuada que usamos (á, ó, ·), entao latin1 basta para as assercoes deste arquivo.
function textoDeTJ(bruto) {
  return (bruto.match(/<([0-9a-fA-F]*)>/g) || [])
    .map((h) => Buffer.from(h.slice(1, -1), 'hex').toString('latin1'))
    .join('');
}

// Itens de texto de UM content stream, com a coordenada y de cada um.
// O pdfkit envolve cada bloco em `q / cm / BT / Tm / TJ / ET / Q`, e o cm da abertura do
// stream e o do bloco sao ambos [1 0 0 -1 0 altura] — dois flips se cancelam, entao o y
// do Tm ja e o y do dispositivo (origem embaixo, cresce para cima).
function itensDeStream(conteudo) {
  const itens = [];
  const re = /1 0 0 1 ([\d.]+) ([\d.]+) Tm[\s\S]*?\[([\s\S]*?)\]\s*TJ/g;
  let m;
  while ((m = re.exec(conteudo)) !== null) {
    itens.push({ y: Number(m[2]), texto: textoDeTJ(m[3]) });
  }
  return itens;
}

// Quantas paginas o PDF declara (/Count da arvore de paginas). Precisa vir daqui, e nao
// da contagem de streams com texto: uma pagina EM BRANCO nao tem operador de texto e
// passaria despercebida — que e exatamente o defeito que este arquivo guarda.
function totalDePaginas(buf) {
  const m = buf.toString('latin1').match(/\/Count\s+(\d+)/);
  assert.ok(m, 'nao foi possivel ler /Count do PDF');
  return Number(m[1]);
}

// Paginas COM TEXTO, em ordem. Content stream = stream que descomprime E contem operador
// Tm (descarta fontes embutidas e demais recursos, e tambem paginas em branco).
function paginasComTexto(buf) {
  const s = buf.toString('latin1');
  const paginas = [];
  const re = /stream\r?\n/g;
  let m;
  while ((m = re.exec(s)) !== null) {
    const ini = m.index + m[0].length;
    const fim = s.indexOf('endstream', ini);
    if (fim === -1) continue;
    let conteudo;
    try {
      conteudo = zlib.inflateSync(Buffer.from(s.slice(ini, fim), 'latin1')).toString('latin1');
    } catch {
      continue; // nao e Flate (fonte embutida, etc.)
    }
    if (!conteudo.includes(' Tm')) continue;
    paginas.push(itensDeStream(conteudo));
  }
  return paginas;
}

// Reconhece o rodape SEM exigir o formato "X de Y": se a assercao dependesse do formato
// novo, uma regressao que voltasse ao rodape antigo ("pagina N") faria o rodape deixar de
// ser reconhecido, ele passaria a contar como conteudo e o teste de pagina em branco
// passaria justamente no caso que ele existe para pegar.
const ehRodape = (item) => /Vendedor Mestre . Relat.*gina \d+/.test(item.texto);

// PDFDocument e um Readable: consome ate 'end' e devolve o buffer completo.
function paraBuffer(doc) {
  return new Promise((resolve, reject) => {
    const partes = [];
    doc.on('data', (c) => partes.push(c));
    doc.on('error', reject);
    doc.on('end', () => resolve(Buffer.concat(partes)));
    doc.end(); // quem consome fecha o documento (o modulo devolve aberto, de proposito)
  });
}

// ── Cenario ──
// Transcricao longa o bastante para passar de uma pagina, incluindo um turno anomalo de
// ~4.500 caracteres (existe um assim no historico real, resposta estranha do STT).
function cenario() {
  const turns = [];
  for (let i = 0; i < 18; i++) {
    turns.push({
      autor: i % 2 === 0 ? 'agente' : 'candidato',
      texto:
        i === 7
          ? 'Resposta longa com acentuação: ação, coração, três. '.repeat(90)
          : `Turno ${i} da conversa, com texto suficiente para ocupar espaço. `.repeat(3),
      ordem: i,
    });
  }
  return {
    interview: {
      id: 84,
      perfil: 'CLOSER',
      iniciado_em: '2026-07-29 22:49:16',
      finalizado_em: '2026-07-29 22:52:46',
    },
    report: {
      resumo: 'Resumo da avaliação do candidato.',
      recomendacao: 'descartar',
      pontuacoes: [
        { competencia: 'Resiliência', nivel: 'baixa', nota: null, justificativa: 'Justificativa.', coberta: true },
        { competencia: 'Ambição', nivel: null, nota: null, justificativa: 'Não abordada.', coberta: false },
      ],
      destaque_pontos_fortes: ['Disponibilidade imediata'],
      destaque_atencao: [{ risco: 'Risco relevante', mitigacao: 'Como mitigar.' }],
      requisitos: [],
    },
    candidato: { nome: 'Larissa', sobrenome: 'Oliveira', email: 'l@exemplo.com', telefone: '+55 11999998888' },
    vaga: { titulo: 'Consultor Comercial', perfil: 'CLOSER' },
    turns,
    roteiro: null,
    geral: { media: 2.3, escalaMax: 5, consideradas: 2 },
  };
}

// ──────────────────────────── testes ────────────────────────────

test('gerarRelatorioPdf: devolve um PDF valido e nao fecha o documento', async () => {
  const doc = gerarRelatorioPdf(cenario());
  assert.equal(typeof doc.pipe, 'function', 'deveria devolver um stream para o caller');

  const buf = await paraBuffer(doc);
  assert.equal(buf.slice(0, 5).toString(), '%PDF-');
  assert.ok(buf.toString('latin1').trimEnd().endsWith('%%EOF'), 'documento deveria terminar em %%EOF');
  assert.ok(buf.length > 2000, 'PDF suspeito de estar vazio');
});

test('gerarRelatorioPdf: transcricao longa gera varias paginas, nenhuma em branco', async () => {
  const buf = await paraBuffer(gerarRelatorioPdf(cenario()));
  const total = totalDePaginas(buf);
  const comTexto = paginasComTexto(buf);

  assert.ok(total >= 2, `o cenario precisa passar de uma pagina (deu ${total})`);

  // Toda pagina declarada precisa ter conteudo. Na regressao do rodape o PDF vinha com o
  // DOBRO de paginas, metade delas vazia — /Count subia e as paginas com texto nao.
  assert.equal(
    comTexto.length,
    total,
    `o PDF declara ${total} paginas mas so ${comTexto.length} tem texto: ` +
      `${total - comTexto.length} pagina(s) em branco`,
  );

  // E nenhuma delas pode ter APENAS o rodape.
  comTexto.forEach((itens, i) => {
    const conteudo = itens.filter((it) => !ehRodape(it));
    assert.ok(conteudo.length > 0, `pagina ${i + 1} de ${total} so tem rodape, sem conteudo`);
  });
});

test('gerarRelatorioPdf: o rodape fica abaixo de todo o conteudo, em toda pagina', async () => {
  const buf = await paraBuffer(gerarRelatorioPdf(cenario()));
  const paginas = paginasComTexto(buf);

  paginas.forEach((itens, i) => {
    const rodapes = itens.filter(ehRodape);
    const conteudo = itens.filter((it) => !ehRodape(it));

    assert.equal(rodapes.length, 1, `pagina ${i + 1} deveria ter exatamente um rodape`);
    // y do dispositivo cresce para CIMA: rodape abaixo de tudo = menor y de todos.
    const menorConteudo = Math.min(...conteudo.map((it) => it.y));
    assert.ok(
      rodapes[0].y < menorConteudo,
      `pagina ${i + 1}: rodape em y=${rodapes[0].y} deveria estar abaixo do conteudo mais baixo (y=${menorConteudo})`,
    );
  });
});

test('gerarRelatorioPdf: rodape numera "pagina X de Y" na ordem certa', async () => {
  const buf = await paraBuffer(gerarRelatorioPdf(cenario()));
  const paginas = paginasComTexto(buf);
  const total = paginas.length;

  paginas.forEach((itens, i) => {
    const rodape = itens.find(ehRodape);
    assert.match(
      rodape.texto,
      new RegExp(`gina ${i + 1} de ${total}`),
      `rodape da pagina ${i + 1} deveria dizer "pagina ${i + 1} de ${total}", veio "${rodape.texto}"`,
    );
  });
});

test('gerarRelatorioPdf: conteudo esperado esta no documento', async () => {
  const buf = await paraBuffer(gerarRelatorioPdf(cenario()));
  const texto = paginasComTexto(buf)
    .flat()
    .map((it) => it.texto)
    .join(' ');

  assert.match(texto, /Larissa Oliveira/, 'nome do candidato');
  assert.match(texto, /Consultor Comercial/, 'titulo da vaga');
  assert.match(texto, /Descartar/, 'rotulo traduzido da recomendacao');
  assert.match(texto, /Resili/, 'competencia avaliada');
  assert.match(texto, /VERA/, 'rotulo do agente na transcricao');
  assert.match(texto, /LARISSA OLIVEIRA/, 'rotulo do candidato na transcricao');
});

test('gerarRelatorioPdf: sem report -> erro explicito', () => {
  assert.throws(() => gerarRelatorioPdf({}), /report ausente/i);
});

test('slugNome: acentos, vazio e caracteres soltos', () => {
  assert.equal(slugNome('Larissa Oliveira'), 'larissa-oliveira');
  assert.equal(slugNome('JOÃO Gabriel Soares'), 'joao-gabriel-soares');
  assert.equal(slugNome('  Íçá --- ??  '), 'ica');
  // nomeCompleto devolve '—' quando nao ha nome nem e-mail; o slug nao pode virar vazio.
  assert.equal(slugNome('—'), 'candidato');
  assert.equal(slugNome(''), 'candidato');
  assert.equal(slugNome(null), 'candidato');
});
