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
// (Existe um gerarSlugBase em routes/admin.js, mas ele e local aquela camada e tem
// fallback 'vaga'; uma lib nao deve importar de uma rota.)
function slugNome(texto) {
  const base = String(texto || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '') // remove diacriticos
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
  return base || 'candidato';
}

// ── Blocos de desenho ──

// Rodape com numeracao, redesenhado a cada pagina nova. Registrado ANTES do conteudo para
// funcionar em streaming (nao da para voltar e numerar depois, ja que quem fecha o
// documento e o caller). Posicao absoluta + lineBreak:false para nao disparar paginacao;
// a trava `desenhando` protege contra recursao caso o pdfkit gere um pageAdded aqui.
function instalarRodape(doc) {
  let pagina = 0;
  let desenhando = false;

  const desenhar = () => {
    if (desenhando) return;
    desenhando = true;
    pagina += 1;
    const yAnterior = doc.y;
    doc
      .font(FONTE)
      .fontSize(8)
      .fillColor(CINZA)
      .text(
        `Vendedor Mestre · Relatório de entrevista · página ${pagina}`,
        doc.page.margins.left,
        doc.page.height - doc.page.margins.bottom + 14,
        { width: larguraUtil(doc), align: 'center', lineBreak: false },
      );
    doc.y = yAnterior;
    desenhando = false;
  };

  doc.on('pageAdded', desenhar);
  desenhar(); // a primeira pagina ja existe quando o documento e criado
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
    info: {
      Title: `Relatório de entrevista — ${nomeCand}`,
      Author: 'Vendedor Mestre',
      Subject: tituloVaga,
    },
  });

  instalarRodape(doc);

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

  // NAO chamamos doc.end(): quem consome faz o pipe e fecha.
  return doc;
}

module.exports = { gerarRelatorioPdf, slugNome };
