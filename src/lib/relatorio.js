'use strict';

// Geracao do relatorio de entrevista + envio ao recrutador (Fase 4).
//
// gerarRelatorio(interviewId) e chamada em fire-and-forget pelo /api/interview/finish:
//   - NUNCA bloqueia a resposta ao candidato (o caller faz .catch e nunca propaga).
//   - o candidato nunca ve o relatorio; so o recrutador recebe, por e-mail.
//
// Modo mock (config.entrevista.mock=true, default em dev): NAO chama DeepSeek nem
// Resend de verdade — produz uma avaliacao deterministica e apenas LOGA o e-mail.
// Modo real (INTERVIEW_MOCK=false): chama o LLM (DeepSeek) e envia via Resend.
//
// Testabilidade: gerarRelatorio aceita deps injetaveis ({ llm, email,
// usarMockDeterministico }) para o teste de ponta a ponta com fakes (ETAPA G),
// sem tocar em APIs reais. `usarMockDeterministico` e um override LOCAL da chamada
// (nao confundir com a env INTERVIEW_MOCK): se omitido, herda config.entrevista.mock.

const { config } = require('../config');
const db = require('../db');
const { gerarToken } = require('./session');
const { truncar, comTimeout, normalizarEstrutura } = require('./entrevista');
const { calcularCustoDeepSeek } = require('./custos');
const { escapeHtml } = require('../views');

// ── Recomendacao da IA (Func. 3) — "pre-aprovado pela IA" ──
// Campo explicito emitido pelo relatorio (nao e calculo sobre pontuacoes). Enum fechado;
// qualquer outro valor (ausente/invalido) vira null no parse, sem travar o relatorio.
const RECOMENDACOES_VALIDAS = ['avancar', 'talvez', 'descartar'];

// Rotulo + cores da identidade visual por recomendacao. Regra da marca: laranja para o
// caso positivo, neutro para o intermediario e um tom SOBRIO (escuro) para o negativo —
// NUNCA vermelho puro. Cores usadas inline (e-mail e paginas) para render identico.
const ESTILO_RECOMENDACAO = {
  avancar: {
    rotulo: 'Avançar',
    descricao: 'Forte aderência ao perfil da vaga',
    fundo: '#FF5500',
    texto: '#FFFFFF',
    borda: '#FF5500',
  },
  talvez: {
    rotulo: 'Talvez',
    descricao: 'Aderência parcial ou dúvidas relevantes',
    fundo: '#F4F3F1',
    texto: '#0D0B0A',
    borda: '#D8D5D0',
  },
  descartar: {
    rotulo: 'Descartar',
    descricao: 'Baixa aderência ao perfil da vaga',
    fundo: '#0D0B0A',
    texto: '#F4F3F1',
    borda: '#0D0B0A',
  },
};

function estiloRecomendacao(recomendacao) {
  return ESTILO_RECOMENDACAO[recomendacao] || null;
}

// HTML do selo (pill) da recomendacao, inline-styled e autossuficiente. Devolve '' quando
// a recomendacao e null/invalida (relatorio antigo ou parse sem o campo) — nunca imprime
// undefined/[object Object]. Reusado no e-mail e nas duas paginas de visualizacao.
function badgeRecomendacaoHtml(recomendacao) {
  const e = estiloRecomendacao(recomendacao);
  if (!e) return '';
  return (
    `<span style="display:inline-block;padding:6px 14px;border-radius:999px;` +
    `background:${e.fundo};color:${e.texto};border:1px solid ${e.borda};` +
    `font-weight:700;font-size:14px;line-height:1.2">${e.rotulo}</span>` +
    ` <span style="color:#555;font-size:13px">${e.descricao}</span>`
  );
}

// ── Prompt de avaliacao (system + user) enviado ao DeepSeek ──
// Saida exigida: SOMENTE JSON (sem markdown), com resumo, pontuacoes[], pontos_fortes[], pontos_atencao[].
function montarMensagensAvaliacao({ roteiro, vaga, candidato, turns, agente }) {
  const { competencias: listaComp, rubrica } = normalizarEstrutura(roteiro);
  const competencias = listaComp
    .map((c) => `- ${c.nome} (peso ${c.peso || 1}): boa resposta = ${c.boa_resposta || 'n/d'}`)
    .join('\n');

  const nomeCandidato = nomeDoCandidato(candidato);
  const tituloVaga = (vaga && vaga.titulo) || 'vaga';
  const perfil = (vaga && vaga.perfil) || (roteiro && roteiro.perfil) || 'vendedor';

  // Teto de seguranca contra resposta anomala do STT (nao e budget de tokens: esta
  // e uma chamada unica pos-entrevista, sem o reenvio de historico do motor ao vivo).
  const transcricao = (turns || [])
    .map((t) => `${t.autor === 'agente' ? agente || 'Vera' : 'Candidato'}: ${truncar(t.texto, 4000)}`)
    .join('\n');

  const system = [
    'Voce e um avaliador senior de recrutamento de vendedores, em portugues do Brasil.',
    'Avalie a entrevista com OBJETIVIDADE, baseando-se SOMENTE no que o candidato disse.',
    'Nao invente fatos; se algo nao foi abordado, pontue com cautela e diga isso na justificativa.',
    '',
    `VAGA: ${tituloVaga} (perfil ${perfil}).`,
    `CANDIDATO: ${nomeCandidato}.`,
    '',
    'COMPETENCIAS A PONTUAR (com peso e o que caracteriza uma boa resposta):',
    competencias || '- (roteiro sem competencias definidas)',
    '',
    `ESCALA: ${rubrica.escala || '1-5'} por competencia (1 = muito fraco, 5 = excelente). ` +
      'Use a "boa resposta" como referencia do que seria nota alta.',
    '',
    'FORMATO DE SAIDA — responda SOMENTE com um JSON valido, sem markdown, sem cercas ``` e sem',
    'texto antes ou depois. Use EXATAMENTE este formato:',
    '{',
    '  "resumo": "2 a 4 frases com a avaliacao geral do candidato",',
    '  "pontuacoes": [',
    '    { "competencia": "<nome exato da competencia>", "nota": <inteiro 1-5>, "justificativa": "1 a 2 frases", "coberta": <true|false> }',
    '  ],',
    '  "pontos_fortes": ["item curto", "..."],',
    '  "pontos_atencao": ["item curto", "..."],',
    '  "recomendacao": "avancar" | "talvez" | "descartar"',
    '}',
    'No campo "coberta": use false quando a competencia NAO foi efetivamente abordada na ' +
      'transcricao (a pergunta nao chegou a ser feita, ou a resposta nao tocou no tema); ' +
      'use true nos demais casos. Mesmo com coberta=false, atribua uma nota cautelosa e ' +
      'explique na justificativa que o tema nao foi coberto.',
    'No campo "recomendacao": emita UMA decisao geral de encaminhamento do candidato para a ' +
      'vaga, com base na aderencia GERAL as competencias-chave (nao e a media das notas):',
    '  - "avancar": forte aderencia as competencias-chave; candidato claramente alinhado ao perfil.',
    '  - "talvez": aderencia parcial, sinais mistos ou duvidas relevantes que pedem uma segunda olhada.',
    '  - "descartar": baixa aderencia ou sinais claros de desalinhamento com o perfil da vaga.',
    'Use EXATAMENTE uma dessas tres strings, em minusculas e sem acento.',
    'Inclua TODAS as competencias listadas em "pontuacoes", usando o nome EXATO. Nao adicione campos extras.',
  ].join('\n');

  const user = [
    'TRANSCRICAO DA ENTREVISTA (turno a turno, em ordem):',
    '',
    transcricao || '(sem turnos registrados)',
  ].join('\n');

  return [
    { papel: 'system', conteudo: system },
    { papel: 'user', conteudo: user },
  ];
}

function nomeDoCandidato(candidato) {
  if (!candidato) return 'Candidato';
  const nome = [candidato.nome, candidato.sobrenome].filter(Boolean).join(' ').trim();
  return nome || candidato.email || 'Candidato';
}

// Avaliacao deterministica usada no modo mock (custo zero, sem LLM).
function avaliacaoMock(roteiro) {
  const { competencias } = normalizarEstrutura(roteiro);
  const pontuacoes = competencias.length
    ? competencias.map((c, i) => {
        // Deterministico: a ULTIMA competencia simula uma NAO coberta (coberta=false),
        // exercitando esse caminho no mock/testes; as demais ficam coberta=true.
        const coberta = i < competencias.length - 1;
        return {
          competencia: c.nome,
          nota: coberta ? 4 : 2,
          justificativa: coberta
            ? '(mock) resposta consistente com o esperado para a competencia.'
            : '(mock) competencia nao abordada na entrevista; nota cautelosa.',
          coberta,
        };
      })
    : [{ competencia: 'Geral', nota: 4, justificativa: '(mock) avaliacao simulada.', coberta: true }];
  return {
    resumo: '(mock) Candidato com bom alinhamento ao perfil; avaliacao simulada sem chamada ao LLM.',
    pontuacoes,
    pontos_fortes: ['(mock) comunicacao clara', '(mock) postura resiliente'],
    pontos_atencao: ['(mock) aprofundar metricas de resultado'],
    recomendacao: 'avancar', // deterministico: coerente com o resumo "bom alinhamento"
  };
}

// Parsing seguro do JSON do LLM. Remove cercas de markdown se vierem e valida o shape minimo.
function parseAvaliacao(texto) {
  let cru = String(texto || '').trim();
  // Remove cercas ```json ... ``` caso o modelo desobedeca a instrucao de "sem markdown".
  const fence = cru.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) cru = fence[1].trim();
  // Recorta do primeiro { ao ultimo } (tolera texto residual ao redor).
  const ini = cru.indexOf('{');
  const fim = cru.lastIndexOf('}');
  if (ini !== -1 && fim !== -1 && fim > ini) cru = cru.slice(ini, fim + 1);

  let obj;
  try {
    obj = JSON.parse(cru);
  } catch (err) {
    throw new Error(`Resposta do LLM nao e JSON valido: ${err.message}. Trecho: ${cru.slice(0, 200)}`);
  }
  if (!obj || typeof obj !== 'object' || !Array.isArray(obj.pontuacoes)) {
    throw new Error('JSON do LLM sem o campo "pontuacoes" (array) esperado.');
  }

  // Enum guard da recomendacao (Func. 3): so aceita uma das 3 strings validas. Ausente,
  // invalida ou de tipo errado -> null (nao trava o relatorio; o resto ja era gerado sem
  // este campo antes, entao um valor ruim aqui NAO pode derrubar a geracao inteira).
  const recRaw =
    typeof obj.recomendacao === 'string' ? obj.recomendacao.trim().toLowerCase() : '';
  const recomendacao = RECOMENDACOES_VALIDAS.includes(recRaw) ? recRaw : null;
  if (obj.recomendacao != null && recomendacao === null) {
    console.warn(
      `[relatorio] "recomendacao" invalida no JSON do LLM (${JSON.stringify(obj.recomendacao)}); assumindo null.`,
    );
  }

  return {
    resumo: typeof obj.resumo === 'string' ? obj.resumo : '',
    recomendacao,
    pontuacoes: obj.pontuacoes
      .filter((p) => p && p.competencia)
      .map((p) => {
        // Fallback: se o LLM omitir "coberta" (ou mandar nao-booleano), assume true
        // (caso mais comum) e apenas loga — nao falha o parse so por isso.
        let coberta = true;
        if (typeof p.coberta === 'boolean') {
          coberta = p.coberta;
        } else {
          console.warn(
            `[relatorio] item de pontuacoes sem "coberta" booleano (competencia="${p.competencia}"); assumindo coberta=true.`,
          );
        }
        return {
          competencia: String(p.competencia),
          nota: Number.isFinite(Number(p.nota)) ? Number(p.nota) : null,
          justificativa: typeof p.justificativa === 'string' ? p.justificativa : '',
          coberta,
        };
      }),
    pontos_fortes: Array.isArray(obj.pontos_fortes) ? obj.pontos_fortes.map(String) : [],
    pontos_atencao: Array.isArray(obj.pontos_atencao) ? obj.pontos_atencao.map(String) : [],
  };
}

// ── Score ponderado (Fase 5) — calculado ON-THE-FLY, sem coluna no banco ──
// media = soma(nota_i * peso_i) / soma(peso_i). O peso vem do roteiro (casado por nome
// de competencia). Retrocompat: peso ausente/nulo/invalido => 1. Itens sem nota numerica
// (ex.: nota=null) nao entram na media. Retorna null quando nao ha nada pontuavel.
function escalaMaxDe(roteiro) {
  try {
    const { rubrica } = normalizarEstrutura(roteiro);
    const m = String(rubrica.escala || '').match(/(\d+)\s*$/);
    if (m) return Number(m[1]);
  } catch (e) {
    /* sem roteiro/rubrica: usa o default */
  }
  return 5;
}

function calcularPontuacaoGeral(pontuacoes, roteiro) {
  const lista = Array.isArray(pontuacoes) ? pontuacoes : [];

  // mapa nome(normalizado) -> peso. peso invalido/ausente => 1.
  const pesos = {};
  try {
    const { competencias } = normalizarEstrutura(roteiro);
    for (const c of competencias) {
      const p = Number(c.peso);
      pesos[String(c.nome || '').trim().toLowerCase()] = Number.isFinite(p) && p > 0 ? p : 1;
    }
  } catch (e) {
    /* roteiro ausente: todas as competencias caem no peso 1 (fallback abaixo) */
  }

  let somaPesoNota = 0;
  let somaPeso = 0;
  let consideradas = 0;
  for (const item of lista) {
    const nota = Number(item && item.nota);
    if (!Number.isFinite(nota)) continue; // sem nota numerica: nao entra na media
    const chave = String((item && item.competencia) || '').trim().toLowerCase();
    const peso = pesos[chave] != null ? pesos[chave] : 1; // competencia fora do roteiro => 1
    somaPesoNota += nota * peso;
    somaPeso += peso;
    consideradas++;
  }
  if (somaPeso <= 0 || consideradas === 0) return null;

  return {
    media: Number((somaPesoNota / somaPeso).toFixed(1)),
    escalaMax: escalaMaxDe(roteiro),
    consideradas,
  };
}

// Corpo do e-mail ao recrutador: resumo + pontuacao geral + tabela + link p/ pagina completa.
function montarEmailHtml({ candidato, vaga, avaliacao, token, roteiro }) {
  const link = `${config.baseUrl}/relatorio/${token}`;
  const geral = calcularPontuacaoGeral(avaliacao.pontuacoes, roteiro);
  const linhas = avaliacao.pontuacoes
    .map(
      (p) =>
        `<tr>
           <td style="padding:6px 10px;border-bottom:1px solid #eee">${escapeHtml(p.competencia)}</td>
           <td style="padding:6px 10px;border-bottom:1px solid #eee;text-align:center"><b>${p.nota != null ? p.nota : '—'}</b>/5</td>
           <td style="padding:6px 10px;border-bottom:1px solid #eee">${escapeHtml(p.justificativa)}</td>
         </tr>`,
    )
    .join('');

  return `
  <div style="font-family:Arial,Helvetica,sans-serif;color:#1a1a1a;max-width:640px">
    <h2 style="margin:0 0 4px">Relatorio de entrevista</h2>
    <p style="margin:0 0 16px;color:#555">
      <b>${escapeHtml(nomeDoCandidato(candidato))}</b> — ${escapeHtml((vaga && vaga.titulo) || 'vaga')}
    </p>
    <p>${escapeHtml(avaliacao.resumo)}</p>
    ${
      badgeRecomendacaoHtml(avaliacao.recomendacao)
        ? `<p style="margin:12px 0;font-size:15px">
             <b>Recomendação da IA:</b><br>
             ${badgeRecomendacaoHtml(avaliacao.recomendacao)}
           </p>`
        : ''
    }
    ${
      geral
        ? `<p style="margin:12px 0;font-size:15px">
             <b>Pontuação geral (ponderada):</b>
             <span style="font-size:18px;font-weight:bold;color:#FF5500">${geral.media}</span> / ${geral.escalaMax}
           </p>`
        : ''
    }
    <table style="border-collapse:collapse;width:100%;font-size:14px;margin:12px 0">
      <thead>
        <tr style="text-align:left;background:#f4f3f1">
          <th style="padding:6px 10px">Competencia</th>
          <th style="padding:6px 10px;text-align:center">Nota</th>
          <th style="padding:6px 10px">Justificativa</th>
        </tr>
      </thead>
      <tbody>${linhas}</tbody>
    </table>
    <p style="margin:18px 0">
      <a href="${link}" style="background:#0d0b0a;color:#fff;text-decoration:none;padding:10px 18px;border-radius:6px;display:inline-block">
        Ver relatorio completo
      </a>
    </p>
    <p style="color:#888;font-size:12px">${escapeHtml(link)}</p>
  </div>`;
}

// Timestamp no formato do SQLite (UTC, igual a datetime('now')).
function agoraSqlite() {
  return new Date().toISOString().slice(0, 19).replace('T', ' ');
}

async function gerarRelatorio(interviewId, deps = {}) {
  const llm = deps.llm || require('../providers/llm');
  const email = deps.email || require('../providers/email');
  const mock =
    deps.usarMockDeterministico != null ? deps.usarMockDeterministico : config.entrevista.mock;
  const timeoutMs = config.entrevista.timeoutMs;
  const relatorioTimeoutMs = config.entrevista.relatorioTimeoutMs;
  const agente = config.agente.nome;

  // ── Idempotencia: se ja existe report ENVIADO para esta entrevista, nao gera de novo. ──
  const jaEnviado = db.obterReportEnviadoPorInterview(interviewId);
  if (jaEnviado) {
    console.log(
      `[relatorio] interview ${interviewId} ja possui report enviado (id=${jaEnviado.id}); ignorando.`,
    );
    return jaEnviado;
  }

  // ── Coleta de dados ──
  const entrevista = db.obterInterview(interviewId);
  if (!entrevista) throw new Error(`Entrevista ${interviewId} nao encontrada.`);
  const candidato = db.obterAplicacao(entrevista.application_id);
  const vaga = candidato ? db.obterVaga(candidato.job_id) : null;
  const roteiro = entrevista.roteiro_id ? db.obterRoteiro(entrevista.roteiro_id) : null;
  const turns = db.listarTurnos(interviewId);

  // ── Geracao da avaliacao (mock deterministico ou LLM real) ──
  let avaliacao;
  if (mock) {
    avaliacao = avaliacaoMock(roteiro);
  } else {
    const mensagens = montarMensagensAvaliacao({ roteiro, vaga, candidato, turns, agente });
    const resp = await comTimeout(
      llm.completar(mensagens, { temperatura: 0.2, maxTokens: 1500 }),
      relatorioTimeoutMs,
      'LLM (relatorio)',
    );

    // Log de uso/custo (best-effort: NUNCA interrompe a geracao do relatorio).
    try {
      const custo = calcularCustoDeepSeek(resp && resp.uso);
      db.registrarUsoApi({
        provedor: 'openrouter',
        modelo: resp && resp.modelo,
        origem: 'relatorio',
        interview_id: interviewId,
        uso: resp && resp.uso,
        custo_usd: custo,
      });
    } catch (e) {
      console.error('[custos] erro ao registrar uso (relatorio):', e);
    }

    avaliacao = parseAvaliacao(resp && resp.texto);
  }

  // ── Persiste o report (gera token, status 'gerado') ──
  const token = gerarToken();
  const reportId = db.criarReport({
    interview_id: interviewId,
    token,
    status: 'gerado',
    resumo: avaliacao.resumo,
    pontuacoes: avaliacao.pontuacoes,
    destaque_pontos_fortes: avaliacao.pontos_fortes,
    destaque_atencao: avaliacao.pontos_atencao,
    recomendacao: avaliacao.recomendacao || null,
  });

  // ── Envio ao recrutador (status 'enviado' em sucesso, 'erro' em falha) ──
  const destinatario = config.recrutador.email;
  try {
    if (!destinatario) throw new Error('RECRUITER_EMAIL nao definido; nao ha para quem enviar.');
    const assunto = `Relatorio de entrevista — ${nomeDoCandidato(candidato)} (${(vaga && vaga.titulo) || 'vaga'})`;
    const html = montarEmailHtml({ candidato, vaga, avaliacao, token, roteiro });
    if (mock) {
      console.log(
        `[relatorio] (mock) e-mail NAO enviado. destinatario=${destinatario} assunto="${assunto}" link=${config.baseUrl}/relatorio/${token}`,
      );
    } else {
      await comTimeout(email.enviar(destinatario, assunto, html), timeoutMs, 'Resend');
    }
    db.atualizarStatusReport(reportId, 'enviado', { destinatario, enviado_em: agoraSqlite() });
  } catch (err) {
    db.atualizarStatusReport(reportId, 'erro', { destinatario });
    console.error(`[relatorio] falha ao enviar e-mail do report ${reportId}: ${err.message}`);
  }

  return db.obterReportPorToken(token);
}

module.exports = {
  gerarRelatorio,
  montarMensagensAvaliacao,
  parseAvaliacao,
  avaliacaoMock,
  montarEmailHtml,
  calcularPontuacaoGeral,
  RECOMENDACOES_VALIDAS,
  estiloRecomendacao,
  badgeRecomendacaoHtml,
};
