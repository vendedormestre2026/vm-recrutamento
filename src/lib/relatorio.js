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

// Item 7.6 (formato Victoria) — enums validados no app (nao no banco). nivel substitui a
// nota 1-5 numerica por Alta/Media/Baixa; veredito e o resultado por requisito obrigatorio.
const NIVEIS_VALIDOS = ['alta', 'media', 'baixa'];
const VEREDITOS_VALIDOS = ['atende', 'parcial', 'nao_atende'];
// Mapeamento nivel -> numero, usado SO por calcularPontuacaoGeral para manter uma
// "pontuacao geral" ponderada derivada dos niveis (alta=5, media=3, baixa=1).
const NIVEL_PARA_NOTA = { alta: 5, media: 3, baixa: 1 };

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

// ── Item 7.6 (formato Victoria) — helpers de apresentacao compartilhados ──
// UM unico ponto de mapeamento (nivel / veredito / gap) reusado pelos 3 renderizadores
// (e-mail, pagina publica /relatorio/:token, painel /admin/relatorio/:id) para que nunca
// divirjam — inclusive na regra de cor da marca: laranja=positivo, tom sobrio=negativo,
// cinza=neutro; NUNCA verde/vermelho. Retrocompat com relatorios antigos em cada helper.

// Rotulo do nivel de aderencia. Novo: nivel 'alta'|'media'|'baixa' -> Alta/Média/Baixa.
// Legado: relatorio antigo nao tem nivel, so nota numerica -> "N/5". Nada disso -> "—".
const ROTULO_NIVEL = { alta: 'Alta', media: 'Média', baixa: 'Baixa' };
function rotuloNivel(item) {
  const nivel = item && typeof item.nivel === 'string' ? item.nivel.trim().toLowerCase() : '';
  if (ROTULO_NIVEL[nivel]) return ROTULO_NIVEL[nivel];
  if (item && item.nota != null) return `${item.nota}/5`; // legado (nota numerica)
  return '—';
}

// Rotulo textual do veredito de um requisito obrigatorio.
const ROTULO_VEREDITO = {
  atende: 'Atende',
  parcial: 'Atende parcialmente',
  nao_atende: 'Não atende',
};
function rotuloVeredito(veredito) {
  return ROTULO_VEREDITO[veredito] || '—';
}

// Glifo MONOCROMATICO do veredito — herda a cor do chip, nunca emoji colorido (a regra da
// marca proibe verde/vermelho). O tom (laranja/preto/cinza) vem do estilo do chip, abaixo.
const ICONE_VEREDITO = { atende: '✓', parcial: '~', nao_atende: '✕' };
function iconeVeredito(veredito) {
  return ICONE_VEREDITO[veredito] || '';
}

// Normaliza um gap (ponto de atencao) para { risco, mitigacao }. Retrocompat: no formato
// antigo o item era apenas uma string (o risco); no novo e um objeto { risco, mitigacao }.
function textoGap(item) {
  if (typeof item === 'string') return { risco: item, mitigacao: '' };
  if (item && typeof item === 'object') {
    return { risco: item.risco || '', mitigacao: item.mitigacao || '' };
  }
  return { risco: '', mitigacao: '' };
}

// Cores inline do chip de veredito — MESMA paleta de ESTILO_RECOMENDACAO: laranja para o
// caso positivo (atende), neutro para o intermediario (parcial) e um tom SOBRIO (escuro)
// para o negativo (nao_atende). NUNCA vermelho/verde. Desconhecido cai no chip neutro.
const ESTILO_VEREDITO = {
  atende: { fundo: '#FF5500', texto: '#FFFFFF', borda: '#FF5500' },
  parcial: { fundo: '#F4F3F1', texto: '#0D0B0A', borda: '#D8D5D0' },
  nao_atende: { fundo: '#0D0B0A', texto: '#F4F3F1', borda: '#0D0B0A' },
};
function estiloVeredito(veredito) {
  return ESTILO_VEREDITO[veredito] || ESTILO_VEREDITO.parcial;
}

// Chip (pill) inline-styled do veredito, autossuficiente e identico nos 3 renderizadores —
// mesma construcao de badgeRecomendacaoHtml. Nunca imprime undefined/[object Object]:
// veredito nulo/invalido cai no rotulo "—" com o tom neutro.
function badgeVereditoHtml(veredito) {
  const e = estiloVeredito(veredito);
  const icone = iconeVeredito(veredito);
  const rotulo = rotuloVeredito(veredito);
  return (
    `<span style="display:inline-block;padding:2px 10px;border-radius:999px;` +
    `background:${e.fundo};color:${e.texto};border:1px solid ${e.borda};` +
    `font-weight:700;font-size:12px;line-height:1.35;white-space:nowrap">` +
    `${icone ? escapeHtml(icone) + ' ' : ''}${escapeHtml(rotulo)}</span>`
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

  // Item 7.6 — requisitos obrigatorios declarados na vaga (must-have). So entram no prompt
  // quando existirem; caso contrario a secao inteira e omitida.
  const requisitosDeclarados = Array.isArray(vaga && vaga.requisitos_obrigatorios)
    ? vaga.requisitos_obrigatorios.filter((r) => String(r || '').trim())
    : [];
  const temRequisitos = requisitosDeclarados.length > 0;

  // Teto de seguranca contra resposta anomala do STT (nao e budget de tokens: esta
  // e uma chamada unica pos-entrevista, sem o reenvio de historico do motor ao vivo).
  // Item 7.6 — cada turno e prefixado com [T<indice>] para a IA poder citar a evidencia.
  const transcricao = (turns || [])
    .map(
      (t, i) =>
        `[T${i}] ${t.autor === 'agente' ? agente || 'Vera' : 'Candidato'}: ${truncar(t.texto, 4000)}`,
    )
    .join('\n');

  const system = [
    'Voce e um avaliador senior de recrutamento de vendedores, em portugues do Brasil.',
    'Avalie a entrevista com OBJETIVIDADE, baseando-se SOMENTE no que o candidato disse.',
    'Nao invente fatos; se algo nao foi abordado, avalie com cautela e diga isso na justificativa.',
    '',
    `VAGA: ${tituloVaga} (perfil ${perfil}).`,
    `CANDIDATO: ${nomeCandidato}.`,
    '',
    'COMPETENCIAS A AVALIAR (com peso e o que caracteriza uma boa resposta):',
    competencias || '- (roteiro sem competencias definidas)',
    '',
    'NIVEL por competencia: classifique cada uma como "alta", "media" ou "baixa" aderencia ' +
      'a "boa resposta" de referencia (alta = forte evidencia; baixa = fraca/ausente).',
    temRequisitos
      ? 'REQUISITOS OBRIGATORIOS DA VAGA (must-have; distintos das competencias comportamentais):\n' +
        requisitosDeclarados.map((r) => `- ${r}`).join('\n') +
        '\nPara cada requisito, retorne um veredito: "atende" (evidencia clara na transcricao), ' +
        '"parcial" (evidencia parcial/ambigua) ou "nao_atende" (sem evidencia ou evidencia ' +
        'contraria). Cite o numero do turno como evidencia (ex.: "T5") APENAS se a informacao ' +
        'realmente aparecer la; NUNCA invente uma citacao. Se nao houver evidencia, deixe ' +
        'evidencia_turno como null.'
      : null,
    '',
    'FORMATO DE SAIDA — responda SOMENTE com um JSON valido, sem markdown, sem cercas ``` e sem',
    'texto antes ou depois. Use EXATAMENTE este formato:',
    '{',
    '  "resumo": "2 a 4 frases com a avaliacao geral do candidato",',
    '  "pontuacoes": [',
    '    { "competencia": "<nome exato da competencia>", "nivel": "alta"|"media"|"baixa", "justificativa": "1 a 2 frases", "coberta": <true|false> }',
    '  ],',
    temRequisitos
      ? '  "requisitos": [\n' +
        '    { "requisito": "<texto exato do requisito>", "veredito": "atende"|"parcial"|"nao_atende", "evidencia_turno": "<T5>"|null }\n' +
        '  ],'
      : null,
    '  "pontos_fortes": ["item curto", "..."],',
    '  "pontos_atencao": [',
    '    { "risco": "descricao curta do risco", "mitigacao": "sugestao curta de como mitigar ou o que investigar na proxima etapa" }',
    '  ],',
    '  "recomendacao": "avancar" | "talvez" | "descartar"',
    '}',
    'Use EXATAMENTE uma dessas tres strings para "nivel", em minusculas e sem acento: alta, media, baixa.',
    'No campo "coberta": use false quando a competencia NAO foi efetivamente abordada na ' +
      'transcricao (a pergunta nao chegou a ser feita, ou a resposta nao tocou no tema); ' +
      'use true nos demais casos. Mesmo com coberta=false, atribua um nivel cauteloso e ' +
      'explique na justificativa que o tema nao foi coberto.',
    'No campo "recomendacao": emita UMA decisao geral de encaminhamento do candidato para a ' +
      'vaga, com base na aderencia GERAL as competencias-chave (nao e a media dos niveis):',
    '  - "avancar": forte aderencia as competencias-chave; candidato claramente alinhado ao perfil.',
    '  - "talvez": aderencia parcial, sinais mistos ou duvidas relevantes que pedem uma segunda olhada.',
    '  - "descartar": baixa aderencia ou sinais claros de desalinhamento com o perfil da vaga.',
    'Use EXATAMENTE uma dessas tres strings, em minusculas e sem acento.',
    'Inclua TODAS as competencias listadas em "pontuacoes", usando o nome EXATO. Nao adicione campos extras.',
  ]
    .filter((l) => l !== null)
    .join('\n');

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
  // Item 7.6 — formato Victoria: nivel (alta/baixa) no lugar de nota numerica.
  const pontuacoes = competencias.length
    ? competencias.map((c, i) => {
        // Deterministico: a ULTIMA competencia simula uma NAO coberta (coberta=false),
        // exercitando esse caminho no mock/testes; as demais ficam coberta=true.
        const coberta = i < competencias.length - 1;
        return {
          competencia: c.nome,
          nivel: coberta ? 'alta' : 'baixa',
          justificativa: coberta
            ? '(mock) resposta consistente com o esperado para a competencia.'
            : '(mock) competencia nao abordada na entrevista; nivel cauteloso.',
          coberta,
        };
      })
    : [{ competencia: 'Geral', nivel: 'alta', justificativa: '(mock) avaliacao simulada.', coberta: true }];
  return {
    resumo: '(mock) Candidato com bom alinhamento ao perfil; avaliacao simulada sem chamada ao LLM.',
    pontuacoes,
    // Sem vaga/requisitos no mock deterministico: requisitos vazio (a chave existe sempre).
    requisitos: [],
    pontos_fortes: ['(mock) comunicacao clara', '(mock) postura resiliente'],
    // Item 7.6 — gaps com mitigacao (objeto { risco, mitigacao }).
    pontos_atencao: [
      {
        risco: '(mock) aprofundar metricas de resultado',
        mitigacao: '(mock) pedir numeros concretos de meta e atingimento na proxima etapa.',
      },
    ],
    recomendacao: 'avancar', // deterministico: coerente com o resumo "bom alinhamento"
  };
}

// Extrai o indice numerico de uma citacao de turno ("T5" -> 5). null se nao casar.
function indiceDoTurnoCitado(evidenciaTurno) {
  const m = String(evidenciaTurno == null ? '' : evidenciaTurno).match(/T\s*(\d+)/i);
  return m ? Number(m[1]) : null;
}

// Parsing seguro do JSON do LLM. Remove cercas de markdown se vierem e valida o shape minimo.
// opts.turns: os turns REAIS da entrevista, usados para VALIDAR a evidencia citada nos
// requisitos (nunca exibir citacao inventada — se o turno nao existir, evidencia vira null).
function parseAvaliacao(texto, opts = {}) {
  const turns = Array.isArray(opts.turns) ? opts.turns : [];
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

  // Requisitos obrigatorios (item 7.6): valida a evidencia citada contra os turns REAIS.
  // Citacao de turno inexistente -> evidencia null (nunca exibe citacao inventada).
  const requisitos = Array.isArray(obj.requisitos)
    ? obj.requisitos
        .filter((r) => r && r.requisito)
        .map((r) => {
          const vRaw = typeof r.veredito === 'string' ? r.veredito.trim().toLowerCase() : '';
          const veredito = VEREDITOS_VALIDOS.includes(vRaw) ? vRaw : null;
          const idx = indiceDoTurnoCitado(r.evidencia_turno);
          let evidencia = null;
          if (idx != null && idx >= 0 && idx < turns.length && turns[idx]) {
            // Evidencia = o trecho REAL do turno citado (truncado), nao a string "T5".
            evidencia = truncar(String(turns[idx].texto || ''), 240);
          } else if (r.evidencia_turno != null) {
            console.warn(
              `[relatorio] evidencia de requisito cita turno inexistente/invalido (${JSON.stringify(r.evidencia_turno)}); descartada.`,
            );
          }
          return { requisito: String(r.requisito), veredito, evidencia };
        })
    : [];

  return {
    resumo: typeof obj.resumo === 'string' ? obj.resumo : '',
    recomendacao,
    requisitos,
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
        // Item 7.6: nivel (alta/media/baixa). Mantem nota (numerica) quando vier — legado/
        // retrocompat: relatorios/entradas antigas com nota continuam sendo lidos.
        const nivelRaw = typeof p.nivel === 'string' ? p.nivel.trim().toLowerCase() : '';
        const nivel = NIVEIS_VALIDOS.includes(nivelRaw) ? nivelRaw : null;
        const nota = Number.isFinite(Number(p.nota)) ? Number(p.nota) : null;
        return {
          competencia: String(p.competencia),
          nivel,
          nota,
          justificativa: typeof p.justificativa === 'string' ? p.justificativa : '',
          coberta,
        };
      }),
    pontos_fortes: Array.isArray(obj.pontos_fortes) ? obj.pontos_fortes.map(String) : [],
    // Item 7.6: gaps como { risco, mitigacao }. Retrocompat: string vira { risco, mitigacao:'' }.
    pontos_atencao: Array.isArray(obj.pontos_atencao)
      ? obj.pontos_atencao
          .filter((g) => g != null)
          .map((g) => {
            if (typeof g === 'string') return { risco: g, mitigacao: '' };
            return {
              risco: typeof g.risco === 'string' ? g.risco : '',
              mitigacao: typeof g.mitigacao === 'string' ? g.mitigacao : '',
            };
          })
      : [],
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
    // Item 7.6: prioriza o nivel (alta/media/baixa -> 5/3/1); se ausente, usa a nota
    // numerica legada. Assim relatorios antigos (nota) e novos (nivel) somam na mesma media.
    const nivel = item && typeof item.nivel === 'string' ? item.nivel.trim().toLowerCase() : '';
    const nota = NIVEL_PARA_NOTA[nivel] != null ? NIVEL_PARA_NOTA[nivel] : Number(item && item.nota);
    if (!Number.isFinite(nota)) continue; // sem nivel valido nem nota numerica: nao entra
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
           <td style="padding:6px 10px;border-bottom:1px solid #eee;text-align:center"><b>${escapeHtml(rotuloNivel(p))}</b></td>
           <td style="padding:6px 10px;border-bottom:1px solid #eee">${escapeHtml(p.justificativa)}</td>
         </tr>`,
    )
    .join('');

  // Item 7.6 — Requisitos obrigatorios (gate must-have). Omitido inteiro quando vazio.
  const requisitos = Array.isArray(avaliacao.requisitos) ? avaliacao.requisitos : [];
  const requisitosHtml = requisitos.length
    ? `<div style="margin:16px 0">
         <h3 style="margin:0 0 8px;font-size:16px">Requisitos obrigatórios</h3>
         ${requisitos
           .map(
             (r) =>
               `<div style="padding:8px 0;border-bottom:1px solid #eee">
                  <div>${badgeVereditoHtml(r.veredito)} <span style="font-weight:600">${escapeHtml(r.requisito || '')}</span></div>
                  ${
                    r.evidencia
                      ? `<p style="margin:4px 0 0;color:#555;font-style:italic;font-size:13px">&ldquo;${escapeHtml(r.evidencia)}&rdquo;</p>`
                      : ''
                  }
                </div>`,
           )
           .join('')}
       </div>`
    : '';

  // Item 7.6 — Gaps (pontos de atencao) com mitigacao. textoGap normaliza string/objeto.
  const gaps = Array.isArray(avaliacao.pontos_atencao) ? avaliacao.pontos_atencao : [];
  const gapsHtml = gaps.length
    ? `<div style="margin:16px 0">
         <h3 style="margin:0 0 8px;font-size:16px">Pontos de atenção</h3>
         <ul style="margin:0;padding-left:18px">
           ${gaps
             .map((g) => {
               const { risco, mitigacao } = textoGap(g);
               if (!risco && !mitigacao) return '';
               return `<li style="margin:0 0 6px"><b>${escapeHtml(risco)}</b>${
                 mitigacao ? ` — Mitigação: ${escapeHtml(mitigacao)}` : ''
               }</li>`;
             })
             .filter(Boolean)
             .join('')}
         </ul>
       </div>`
    : '';

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
    ${requisitosHtml}
    <table style="border-collapse:collapse;width:100%;font-size:14px;margin:12px 0">
      <thead>
        <tr style="text-align:left;background:#f4f3f1">
          <th style="padding:6px 10px">Competencia</th>
          <th style="padding:6px 10px;text-align:center">Nível</th>
          <th style="padding:6px 10px">Justificativa</th>
        </tr>
      </thead>
      <tbody>${linhas}</tbody>
    </table>
    ${gapsHtml}
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

    // Passa os turns REAIS para validar a evidencia citada nos requisitos (item 7.6).
    avaliacao = parseAvaliacao(resp && resp.texto, { turns });
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
    requisitos: avaliacao.requisitos || [], // item 7.6 — veredito por requisito obrigatorio
  });

  // Status da IA terminal — derivado do MESMO valor que reports.recomendacao (ponto de
  // escrita unico p/ as duas fontes nunca divergirem). Mapa: 'avancar'|'talvez'|
  // 'descartar' -> mesmo valor; null/ausente -> 'indefinido'. applicationId vem da
  // interview ja carregada acima (entrevista.application_id).
  const statusIaTerminal = avaliacao.recomendacao || 'indefinido';
  db.definirStatusIa(entrevista.application_id, statusIaTerminal);

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
  // Item 7.6 — helpers de apresentacao compartilhados (nivel / veredito / gap).
  rotuloNivel,
  rotuloVeredito,
  iconeVeredito,
  textoGap,
  estiloVeredito,
  badgeVereditoHtml,
};
