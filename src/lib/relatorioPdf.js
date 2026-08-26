'use strict';

// Geracao do relatorio de entrevista em PDF (download pelo painel do recrutador).
//
// DESACOPLADO DA ROTA de proposito: gerarRelatorioPdf recebe os dados JA carregados e
// devolve um PDFDocument (stream) SEM tocar em `res` e SEM chamar doc.end(). Quem chama
// faz o pipe e o end. Isso mantem a funcao testavel sem HTTP e deixa a rota com uma
// responsabilidade so (buscar dados + cabecalhos de download).
//
// Os helpers de apresentacao vem de lib/relatorio.js — os MESMOS usados pelo e-mail e
// pelas duas paginas de relatorio. Nao reimplementamos rotulo de nivel/veredito/gap aqui:
// os formatos legado e novo convivem no banco (nivel vs. nota numerica, gap string vs.
// objeto) e duplicar essa normalizacao e como as telas divergiriam com o tempo.

const PDFDocument = require('pdfkit');
const { rotuloNivel, textoGap, rotuloVeredito, estiloRecomendacao, calcularPontuacaoGeral } =
  require('./relatorio');
const { normalizarSlug } = require('./slug');

// ── Paleta da marca ──
// Preto para titulo e corpo; laranja SO em acento (regra de recomendacao e fio de secao),
// nunca em blocos grandes; cinza para texto secundario. Sem verde/vermelho, igual ao resto.
const PRETO = '#0D0B0A';
const LARANJA = '#FF5500';
const CINZA = '#6B6560';
const CINZA_CLARO = '#D8D5D0';

// Fontes AFM embutidas no pdfkit. O projeto nao tem fonte customizada empacotada, e
// depender de arquivo externo quebraria no container (COPY . . nao traz .ttf de fora).
const FONTE = 'Helvetica';
const FONTE_NEGRITO = 'Helvetica-Bold';

const MARGEM = 50;

function larguraUtil(doc) {
  return doc.page.width - doc.page.margins.left - doc.page.margins.right;
}

// 'YYYY-MM-DD HH:MM:SS' (UTC do SQLite) -> 'dd/mm/aaaa hh:mm'. Mesma regra do painel;
// helper local porque o do admin.js vive numa camada de rota e nao e exportado.
function formatarDataHora(sqliteDt) {
  if (!sqliteDt) return '—';
  const m = String(sqliteDt).match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})/);
  if (!m) return String(sqliteDt);
  const [, ano, mes, dia, hh, mm] = m;
  return `${dia}/${mes}/${ano} ${hh}:${mm}`;
}

function nomeDoCandidato(candidato) {
  if (!candidato) return 'Candidato';
  const nome = [candidato.nome, candidato.sobrenome].filter(Boolean).join(' ').trim();
  return nome || candidato.email || 'Candidato';
}

// Slug para o nome do arquivo baixado: sem acento, minusculo, so [a-z0-9-].
// Exportado porque quem monta o Content-Disposition e a rota.
// normalizarSlug vem de lib/slug.js (modulo compartilhado, sem dependencia de rota \u2014
// a razao pela qual isto vivia duplicado aqui deixou de existir). Fallback 'candidato'
// (diferente do 'vaga' de gerarSlugBase) continua aqui, especifico deste consumidor.
function slugNome(texto) {
  return normalizarSlug(texto) || 'candidato';
}

// ── Blocos de desenho ──

// Rodape com numeracao, escrito DEPOIS que todo o conteudo ja existe.
//
// A versao anterior desenhava dentro de um listener de 'pageAdded' e produzia paginas em
// branco alternadas, com o rodape aparecendo no topo da pagina seguinte, colado a frase
// que tinha sido cortada. A causa: passar `width` faz o texto passar pelo LineWrapper do
// pdfkit, que testa `y + altura da linha > page.maxY()` e chama addPage() sozinho — e o y
// do rodape fica, por definicao, ABAIXO de maxY (ele mora na faixa da margem inferior).
// Ou seja, o proprio rodape paginava o documento. Salvar/restaurar doc.y nao resolveria:
// o problema nao era o cursor, era a paginacao disparada por ele.
//
// Aqui o documento e criado com bufferPages, entao as paginas ficam retidas ate o
// doc.end() do caller. Como TODO o conteudo e escrito de forma sincrona, na hora em que
// esta funcao roda todas as paginas ja existem e da para percorre-las com switchToPage —
// o que permite ate numerar "X de Y". Zerar margins.bottom durante a escrita impede o
// LineWrapper de considerar o rodape "fora da pagina" e criar outra.
function numerarPaginas(doc) {
  const faixa = doc.bufferedPageRange(); // { start, count }
  for (let i = 0; i < faixa.count; i++) {
    doc.switchToPage(faixa.start + i);
    const margemInferior = doc.page.margins.bottom;
    doc.page.margins.bottom = 0;
    doc
      .font(FONTE)
      .fontSize(8)
      .fillColor(CINZA)
      .text(
        `Vendedor Mestre · Relatório de entrevista · página ${i + 1} de ${faixa.count}`,
        doc.page.margins.left,
        doc.page.height - margemInferior + 14,
        { width: larguraUtil(doc), align: 'center', lineBreak: false },
      );
    doc.page.margins.bottom = margemInferior;
  }
}

// Titulo de secao: rotulo em caixa alta + fio laranja. O pdfkit quebra a pagina sozinho
// se nao couber — nao fazemos calculo manual de altura em lugar nenhum deste arquivo.
function secao(doc, titulo) {
  doc.moveDown(1);
  doc.font(FONTE_NEGRITO).fontSize(12).fillColor(PRETO).text(String(titulo).toUpperCase());
  const y = doc.y + 3;
  doc
    .moveTo(doc.page.margins.left, y)
    .lineTo(doc.page.margins.left + larguraUtil(doc), y)
    .lineWidth(1)
    .strokeColor(LARANJA)
    .stroke();
  doc.moveDown(0.6);
}

function paragrafo(doc, texto, { cor = PRETO, tamanho = 10, italico = false } = {}) {
  doc
    .font(italico ? 'Helvetica-Oblique' : FONTE)
    .fontSize(tamanho)
    .fillColor(cor)
    .text(String(texto || ''), { align: 'left', lineGap: 2 });
}

function listaComMarcador(doc, itens) {
  if (!itens.length) {
    paragrafo(doc, '—', { cor: CINZA });
    return;
  }
  for (const item of itens) {
    doc
      .font(FONTE)
      .fontSize(10)
      .fillColor(PRETO)
      .text(`•  ${item}`, { indent: 6, lineGap: 2 });
    doc.moveDown(0.2);
  }
}

// Linha "rotulo: valor" do bloco de identificacao do cabecalho.
function campoIdentificacao(doc, rotulo, valor) {
  doc.font(FONTE_NEGRITO).fontSize(9).fillColor(CINZA).text(`${rotulo}: `, { continued: true });
  doc.font(FONTE).fontSize(9).fillColor(PRETO).text(String(valor == null ? '—' : valor));
}

// ── Documento ──

function gerarRelatorioPdf({ interview, report, candidato, vaga, turns, roteiro, geral } = {}) {
  if (!report) throw new Error('gerarRelatorioPdf: report ausente.');

  const nomeCand = nomeDoCandidato(candidato);
  const tituloVaga = (vaga && vaga.titulo) || '—';
  const perfil = (vaga && vaga.perfil) || (interview && interview.perfil) || '—';
  const listaTurnos = Array.isArray(turns) ? turns : [];
  // `geral` normalmente vem pronto da rota (mesmo calculo da pagina HTML). Quando nao vem,
  // derivamos do roteiro aqui para a funcao continuar utilizavel isoladamente (testes).
  const pontuacaoGeral =
    geral !== undefined ? geral : calcularPontuacaoGeral(report.pontuacoes, roteiro);

  const doc = new PDFDocument({
    size: 'A4',
    margins: { top: MARGEM, bottom: MARGEM, left: MARGEM, right: MARGEM },
    // Retem as paginas ate o end() do caller, para numerarPaginas() poder percorre-las
    // com switchToPage depois que o conteudo todo estiver escrito.
    bufferPages: true,
    info: {
      Title: `Relatório de entrevista — ${nomeCand}`,
      Author: 'Vendedor Mestre',
      Subject: tituloVaga,
    },
  });

  // ── Cabecalho ──
  doc.font(FONTE).fontSize(9).fillColor(LARANJA).text('VENDEDOR MESTRE');
  doc.moveDown(0.2);
  doc.font(FONTE_NEGRITO).fontSize(20).fillColor(PRETO).text(nomeCand);
  doc.moveDown(0.5);

  campoIdentificacao(doc, 'Vaga', tituloVaga);
  campoIdentificacao(doc, 'Perfil', perfil);
  campoIdentificacao(doc, 'E-mail', (candidato && candidato.email) || '—');
  campoIdentificacao(doc, 'Telefone', (candidato && candidato.telefone) || '—');
  campoIdentificacao(doc, 'Entrevista', formatarDataHora(interview && interview.iniciado_em));
  campoIdentificacao(doc, 'Conclusão', formatarDataHora(interview && interview.finalizado_em));

  // ── Recomendacao da IA ──
  // Unico bloco onde o laranja aparece com peso: e a informacao que o recrutador procura
  // primeiro. estiloRecomendacao devolve null para valor ausente/invalido -> secao omitida.
  const estilo = estiloRecomendacao(report.recomendacao);
  if (estilo) {
    secao(doc, 'Recomendação da IA');
    doc.font(FONTE_NEGRITO).fontSize(14).fillColor(LARANJA).text(estilo.rotulo);
    paragrafo(doc, estilo.descricao, { cor: CINZA, tamanho: 9 });
  }

  // ── Resumo ──
  if (report.resumo) {
    secao(doc, 'Resumo');
    paragrafo(doc, report.resumo);
  }

  // ── Pontuacao geral ──
  if (pontuacaoGeral) {
    secao(doc, 'Pontuação geral');
    doc
      .font(FONTE_NEGRITO)
      .fontSize(16)
      .fillColor(PRETO)
      .text(`${pontuacaoGeral.media} / ${pontuacaoGeral.escalaMax}`, { continued: true });
    doc
      .font(FONTE)
      .fontSize(9)
      .fillColor(CINZA)
      .text('   média ponderada pelo peso das competências');
  }

  // ── Requisitos obrigatorios ──
  // Hoje nenhum relatorio traz requisitos (nenhuma vaga preenche requisitos_obrigatorios),
  // mas a secao existe para quando passarem a existir — some inteira quando vazia.
  const requisitos = Array.isArray(report.requisitos) ? report.requisitos : [];
  if (requisitos.length) {
    secao(doc, 'Requisitos obrigatórios');
    for (const r of requisitos) {
      doc
        .font(FONTE_NEGRITO)
        .fontSize(10)
        .fillColor(PRETO)
        .text(String(r.requisito || ''), { continued: true });
      doc.font(FONTE).fontSize(10).fillColor(CINZA).text(`  —  ${rotuloVeredito(r.veredito)}`);
      if (r.evidencia) {
        paragrafo(doc, `“${r.evidencia}”`, { cor: CINZA, tamanho: 9, italico: true });
      }
      doc.moveDown(0.4);
    }
  }

  // ── Pontuacao por competencia ──
  secao(doc, 'Pontuação por competência');
  const pontuacoes = Array.isArray(report.pontuacoes) ? report.pontuacoes : [];
  if (!pontuacoes.length) {
    paragrafo(doc, 'Sem competências pontuadas.', { cor: CINZA });
  } else {
    for (const p of pontuacoes) {
      const naoCoberta = p.coberta === false;
      // rotuloNivel resolve os dois formatos: nivel Alta/Média/Baixa (novo) e "N/5" (legado).
      doc
        .font(FONTE_NEGRITO)
        .fontSize(11)
        .fillColor(PRETO)
        .text(String(p.competencia || ''), { continued: true });
      doc
        .font(FONTE_NEGRITO)
        .fontSize(11)
        .fillColor(naoCoberta ? CINZA : LARANJA)
        .text(`   ${rotuloNivel(p)}`);
      if (naoCoberta) {
        paragrafo(doc, 'Competência não abordada na entrevista.', { cor: CINZA, tamanho: 9 });
      }
      if (p.justificativa) {
        paragrafo(doc, p.justificativa, { tamanho: 10 });
      }
      doc.moveDown(0.5);
    }
  }

  // ── Pontos fortes ──
  secao(doc, 'Pontos fortes');
  listaComMarcador(doc, (report.destaque_pontos_fortes || []).map(String).filter(Boolean));

  // ── Pontos de atencao ──
  // textoGap normaliza o formato antigo (string = so o risco) e o novo ({ risco, mitigacao }).
  secao(doc, 'Pontos de atenção');
  const gaps = (report.destaque_atencao || [])
    .map((g) => textoGap(g))
    .filter((g) => g.risco || g.mitigacao);
  if (!gaps.length) {
    paragrafo(doc, '—', { cor: CINZA });
  } else {
    for (const g of gaps) {
      doc.font(FONTE_NEGRITO).fontSize(10).fillColor(PRETO).text(`•  ${g.risco}`, { indent: 6 });
      if (g.mitigacao) {
        doc
          .font(FONTE)
          .fontSize(9)
          .fillColor(CINZA)
          .text(`Mitigação: ${g.mitigacao}`, { indent: 20, lineGap: 2 });
      }
      doc.moveDown(0.3);
    }
  }

  // ── Transcricao ──
  // Completa, sem truncar: o PDF e o registro integral da conversa. Ha turnos longos no
  // historico (o maior tem ~4,5 mil caracteres, resposta anomala do STT) — o pdfkit
  // quebra a pagina sozinho, nao ha calculo manual aqui.
  secao(doc, 'Transcrição');
  if (!listaTurnos.length) {
    paragrafo(doc, 'Sem turnos registrados.', { cor: CINZA });
  } else {
    for (const t of listaTurnos) {
      const ehAgente = t.autor === 'agente';
      doc
        .font(FONTE_NEGRITO)
        .fontSize(9)
        .fillColor(ehAgente ? CINZA : PRETO)
        .text(ehAgente ? 'VERA' : nomeCand.toUpperCase());
      doc
        .font(FONTE)
        .fontSize(10)
        .fillColor(PRETO)
        .text(String(t.texto || ''), { indent: 6, lineGap: 2 });
      doc.moveDown(0.5);
    }
  }

  // Fio de encerramento — deixa claro que o documento acabou (nao foi cortado).
  doc.moveDown(0.5);
  const yFim = doc.y;
  doc
    .moveTo(doc.page.margins.left, yFim)
    .lineTo(doc.page.margins.left + larguraUtil(doc), yFim)
    .lineWidth(0.5)
    .strokeColor(CINZA_CLARO)
    .stroke();
  doc.moveDown(0.4);
  paragrafo(
    doc,
    'Documento gerado automaticamente pelo sistema de recrutamento da Vendedor Mestre.',
    { cor: CINZA, tamanho: 8 },
  );

  // Numeracao por ultimo: todo o conteudo ja foi escrito, entao a contagem de paginas
  // esta fechada. O doc.end() do caller e quem faz o flush das paginas retidas.
  numerarPaginas(doc);

  // NAO chamamos doc.end(): quem consome faz o pipe e fecha.
  return doc;
}

module.exports = { gerarRelatorioPdf, slugNome };
