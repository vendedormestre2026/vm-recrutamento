'use strict';

// Geracao das 7 variacoes do disparo em massa A PARTIR DO TEXTO-BASE da campanha, por LLM.
//
// ── POR QUE EXISTE ──
// Ate 2026-10-14 nao havia geracao: o "Sugerir com IA" gravava as sementes fixas do convite
// (lib/variacoesMassaWa.VARIACOES_SEED) e a criacao fazia o mesmo, qualquer que fosse o texto-base
// digitado. A campanha 9 era um lembrete e saiu como convite. Aqui o texto-base e a FONTE DA
// VERDADE: o modelo so reescreve a redacao, e cada variacao que ele devolve passa pelo MESMO
// validador que o worker usa no envio (validarVariacoes com textoBase) antes de ser aceita.
//
// ── O QUE ESTE MODULO NUNCA FAZ ──
// Nunca devolve as sementes, nem qualquer texto padrao, quando a geracao falha: o resultado de
// falha traz `variacoes: []` e um `erro` em portugues para a tela. Quem chama registra o erro na
// campanha (db.registrarErroVariacoesMassaWa) e a campanha fica bloqueada ate alguem gerar de novo
// ou escrever as 7 a mao. Cair num texto padrao calado e exatamente o bug que isto corrige.
//
// Nao grava nada, nao envia nada. Nao escreve o descadastro: a linha e do sistema e entra no envio
// (variacoesMassaWa.resolverTexto, decisao D2) — o prompt proibe o modelo de escrever uma.
//
// ── QUANDO CHAMA O LLM ──
// So com MASSA_WA_LLM_ATIVO=true (iaLigada). Desligado, quem chama nao chama este modulo e registra
// ERRO_IA_DESLIGADA. A chave nasce desligada; ligar e decisao do Rafael (variavel do Railway).
//
// Mesmo desenho de lib/gerarSugestaoPromocao: `llm` e `db` injetaveis, chamada por PROPRIEDADE
// (llm.completar) para o teste de rota trocar o metodo do modulo em cache, resultado
// discriminado (nunca lanca), custo registrado em api_usage.

const dbPadrao = require('../db');
const llmPadrao = require('../providers/llm');
const { calcularCustoDeepSeek } = require('./custos');
const variacoes = require('./variacoesMassaWa');
const { normalizarTextoBase } = require('./hashTextoBase');

const ENV_ATIVO = 'MASSA_WA_LLM_ATIVO';
const ERRO_IA_DESLIGADA = 'Geração por IA desligada: escreva as 7 variações manualmente';

// Tentativas por geracao (decisao do pedido: "limite de tentativas"). Cada tentativa pede SO as
// que ainda faltam; as aceitas nas anteriores ficam.
const MAX_TENTATIVAS = 3;
// Escrever sete redacoes diferentes pede temperatura mais alta que extracao (0,2) ou a sugestao de
// e-mail (0,6). Os fatos nao dependem dela: quem os garante e o validador.
const TEMPERATURA = 0.9;
// 7 x ~1200 caracteres no pior caso, mais o JSON. 4000 tokens cobre com folga e ainda deixa o
// truncamento detectavel por finishReason.
const MAX_TOKENS = 4000;

function iaLigada(env = process.env) {
  return String(env[ENV_ATIVO] || '').trim().toLowerCase() === 'true';
}

// Problemas do PROPRIO texto-base, que nao vale a pena mandar ao modelo (custo sem chance de dar
// certo). Frases prontas: vao direto para a tela.
function problemasDoTextoBase(textoBase) {
  const base = normalizarTextoBase(textoBase);
  if (!base) return ['o texto-base está vazio'];
  const problemas = [];
  if (base.length > variacoes.MAX_CARACTERES) {
    problemas.push(`o texto-base tem ${base.length} caracteres (o teto de uma mensagem é ${variacoes.MAX_CARACTERES})`);
  }
  if (/\{\{|\}\}/.test(base)) problemas.push('o texto-base usa {{chave dupla}} — aqui é {chave simples}');
  const desconhecidos = [...new Set(variacoes.tokensDe(base))].filter((t) => !variacoes.TOKENS.includes(t));
  if (desconhecidos.length) {
    problemas.push(`o texto-base tem token não reconhecido: ${desconhecidos.map((t) => `{${t}}`).join(', ')}`);
  }
  return problemas;
}

// Frase curta de um problema do validador, para o feedback ao modelo na tentativa seguinte.
function descreverProblema(p) {
  switch (p.codigo) {
    case variacoes.PROBLEMA_TOKEN_FALTANDO: return `perdeu ${p.tokens.map((t) => `{${t}}`).join(', ')}`;
    case variacoes.PROBLEMA_TOKEN_INVENTADO: return `inventou ${p.tokens.map((t) => `{${t}}`).join(', ')}, que o texto-base não tem`;
    case variacoes.PROBLEMA_TOKEN_DESCONHECIDO: return `usou token inexistente ${p.tokens.map((t) => `{${t}}`).join(', ')}`;
    case variacoes.PROBLEMA_URL: return `perdeu ou alterou o link ${p.urls.join(', ')}`;
    case variacoes.PROBLEMA_TAMANHO_BASE: return `ficou com ${p.tamanho} caracteres (o texto-base tem ${p.base}; precisa ficar entre ${Math.ceil(p.base * p.min)} e ${Math.floor(p.base * p.max)})`;
    case variacoes.PROBLEMA_PARECIDA_BASE: return 'ficou parecida demais com o texto-base';
    case variacoes.PROBLEMA_SEM_QUEBRAS: return `perdeu os paragrafos: tem ${p.quebras} quebra(s) de linha, precisa de pelo menos ${p.minimo} (o texto-base tem ${p.base}; use \\n dentro da string JSON)`;
    case variacoes.PROBLEMA_PARECIDA:
    case variacoes.PROBLEMA_DUPLICADA: return 'ficou parecida demais com outra variação';
    case variacoes.PROBLEMA_CHAVE_DUPLA: return 'usou {{chave dupla}}';
    case variacoes.PROBLEMA_LONGA: return `passou de ${p.teto} caracteres`;
    case variacoes.PROBLEMA_VAZIA: return 'veio vazia';
    default: return p.codigo;
  }
}

// ── Prompt ──
//
// Exportada para o teste (e para revisao humana) inspecionar exatamente o que vai ao modelo.
// O texto-base vai DELIMITADO e como o UNICO conteudo: nao ha "exemplo" nem texto padrao no prompt
// que o modelo possa preferir ao que o operador escreveu.
function montarMensagensVariacoes(textoBase, { quantidade = variacoes.TOTAL_VARIACOES, recusadas = [] } = {}) {
  const base = normalizarTextoBase(textoBase);
  const tokens = [...new Set(variacoes.tokensDe(base))];
  const urls = [...new Set(variacoes.urlsDe(base))];
  const min = Math.ceil(base.length * variacoes.FATOR_TAMANHO_MIN);
  const max = Math.floor(base.length * variacoes.FATOR_TAMANHO_MAX);
  const minQuebras = variacoes.minimoDeQuebras(base);

  const system = [
    'Voce reescreve uma mensagem de WhatsApp de um recrutador em VARIAS redacoes diferentes, para',
    'que ela nao saia identica para centenas de pessoas. Portugues do Brasil. Devolve APENAS um JSON',
    'valido — sem cercas markdown, sem texto antes ou depois.',
    '',
    'Formato EXATO (esta chave e NENHUMA outra):',
    '{ "variacoes": ["texto 1", "texto 2", ...] }',
    '',
    'O TEXTO-BASE E A FONTE DA VERDADE. Cada variacao precisa:',
    '- manter o MESMO sentido e a MESMA ordem das informacoes do texto-base;',
    '- manter TODOS os fatos: horarios, datas, links, nome da empresa, quem escreve e a chamada para',
    '  acao. Nao acrescente informacao, promessa, beneficio ou instrucao que o texto-base nao tem, e',
    '  nao tire nenhuma que ele tem;',
    '- variar SO a redacao: saudacao, ordem das frases dentro do mesmo paragrafo, conectivos, emojis e',
    '  pontuacao, com cadencia de uma pessoa escrevendo (frases de tamanhos diferentes, nada de texto',
    '  de robo, nada de lista onde o texto-base tem frase corrida so por variar);',
    '- ser claramente diferente das outras variacoes e do proprio texto-base (nao basta trocar uma',
    '  palavra).',
    '',
    'PRESERVE LITERALMENTE:',
    '- cada token entre chaves, como {saudacao} ou {vaga}: mesma grafia, chave simples, sem traduzir,',
    '  sem acentuar, sem inventar token novo e sem remover nenhum. O sistema troca os tokens pelo dado',
    '  de cada pessoa depois;',
    '- cada link (URL) exatamente como esta, caractere por caractere, sem ponto ou asterisco colado;',
    '- o *negrito* do WhatsApp (texto entre asteriscos) nos mesmos trechos. Nao use _italico_.',
    '',
    'PARAGRAFOS E QUEBRAS DE LINHA: mantenha a MESMA divisao em paragrafos e linhas do texto-base',
    '(linha em branco entre paragrafos, uma informacao por linha onde o texto-base faz isso, como',
    'data, horario e link). NUNCA junte tudo numa linha so: a mensagem chega como bloco corrido. Dentro',
    'da string JSON, cada quebra de linha e escrita como \\n (e a linha em branco como \\n\\n).',
    '',
    'NAO ESCREVA DESCADASTRO. Nada de "para nao receber mais mensagens", "responda SAIR" ou link de',
    'saida: o sistema acrescenta a linha de descadastro ao fim de cada mensagem, sozinho.',
    '',
    'Responda so com o objeto JSON.',
  ].join('\n');

  const linhas = [
    `Escreva ${quantidade} variacao(oes) do texto-base abaixo.`,
    `Tamanho de cada uma: entre ${min} e ${max} caracteres (o texto-base tem ${base.length}).`,
    ...(minQuebras
      ? [`Quebras de linha de cada uma: pelo menos ${minQuebras} (o texto-base tem ${variacoes.contarQuebras(base)}), escritas como \\n na string JSON.`]
      : []),
    tokens.length
      ? `Tokens que TODA variacao deve conter, cada um pelo menos uma vez: ${tokens.map((t) => `{${t}}`).join(' ')}.`
      : 'O texto-base nao tem tokens entre chaves: nao use nenhum.',
    urls.length ? `Links que TODA variacao deve conter, identicos: ${urls.join(' ')}` : 'O texto-base nao tem links: nao escreva nenhum.',
    '',
    '<<<TEXTO-BASE',
    base,
    'TEXTO-BASE>>>',
  ];
  if (recusadas.length) {
    linhas.push(
      '',
      'Na tentativa anterior, estas variacoes foram RECUSADAS pela validacao automatica — nao repita os erros:',
      ...recusadas.slice(0, 7).map((r, i) => `- recusada ${i + 1}: ${r.motivos.join('; ')}`),
    );
  }

  return [
    { papel: 'system', conteudo: system },
    { papel: 'user', conteudo: linhas.join('\n') },
  ];
}

// Recorta o JSON tolerando cerca de markdown. Mesma funcao de gerarSugestaoPromocao/importar_vaga
// (duplicacao conhecida, registrada la).
function recortarJson(texto) {
  let cru = String(texto || '').trim();
  const fence = cru.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) cru = fence[1].trim();
  const ini = cru.indexOf('{');
  const fim = cru.lastIndexOf('}');
  if (ini !== -1 && fim !== -1 && fim > ini) cru = cru.slice(ini, fim + 1);
  return cru;
}

// LANCA quando a resposta nao da para aproveitar.
function parseVariacoes(textoLLM) {
  const obj = JSON.parse(recortarJson(textoLLM));
  if (!obj || typeof obj !== 'object' || !Array.isArray(obj.variacoes)) {
    throw new Error('JSON sem a lista "variacoes".');
  }
  return obj.variacoes.filter((t) => typeof t === 'string').map((t) => t.trim()).filter(Boolean);
}

function registrarUso(db, resp) {
  try {
    db.registrarUsoApi({
      provedor: 'openrouter',
      modelo: resp && resp.modelo,
      origem: 'massa-wa',
      uso: resp && resp.uso,
      custo_usd: calcularCustoDeepSeek(resp && resp.uso),
    });
  } catch (e) {
    console.error('[custos] erro ao registrar uso (massa-wa):', e);
  }
}

// Orquestra: texto-base -> prompt -> LLM -> JSON -> validacao contra o texto-base, ate 7 aceitas
// ou MAX_TENTATIVAS.
//
// Resultado discriminado, nunca lanca:
//   { ok: true,  variacoes: [7 textos], erro: null, tentativas }
//   { ok: false, variacoes: [],         erro: 'frase para a tela', tentativas }
async function gerarVariacoes(textoBase, deps = {}) {
  const db = deps.db || dbPadrao;
  const llm = deps.llm || llmPadrao;
  const total = variacoes.TOTAL_VARIACOES;
  const base = normalizarTextoBase(textoBase);

  const doBase = problemasDoTextoBase(base);
  if (doBase.length) {
    return { ok: false, variacoes: [], erro: `Corrija o texto-base antes de gerar: ${doBase.join('; ')}.`, tentativas: 0 };
  }

  const aceitas = [];
  let recusadas = [];
  let motivo = '';
  let tentativas = 0;

  while (tentativas < MAX_TENTATIVAS && aceitas.length < total) {
    tentativas += 1;
    const quantidade = total - aceitas.length;
    let resp;
    try {
      resp = await llm.completar(montarMensagensVariacoes(base, { quantidade, recusadas }), {
        temperatura: TEMPERATURA,
        maxTokens: MAX_TOKENS,
      });
    } catch (err) {
      console.error(`[massa-wa/variacoes] tentativa ${tentativas}: falha na chamada ao LLM: ${err && err.message}`);
      motivo = 'a IA não respondeu (falha na chamada ao modelo)';
      continue;
    }
    registrarUso(db, resp);

    if (resp && resp.finishReason === 'length') {
      console.error(`[massa-wa/variacoes] tentativa ${tentativas}: resposta truncada pelo limite de tokens.`);
      motivo = 'a resposta da IA veio cortada';
      continue;
    }

    let candidatas;
    try {
      candidatas = parseVariacoes(resp && resp.texto);
    } catch (err) {
      const tam = resp && typeof resp.texto === 'string' ? resp.texto.length : 0;
      console.error(`[massa-wa/variacoes] tentativa ${tentativas}: falha no parse: ${err.message} (textoLen=${tam})`);
      motivo = 'a resposta da IA não veio no formato esperado';
      continue;
    }

    // Cada candidata e validada JUNTO com as ja aceitas: assim a semelhanca com uma variacao
    // anterior (inclusive de outra tentativa) tambem reprova. So os problemas DELA contam.
    recusadas = [];
    for (const texto of candidatas) {
      if (aceitas.length >= total) break;
      const indice = aceitas.length + 1;
      const r = variacoes.validarVariacoes([...aceitas, texto], { exigirTotal: false, textoBase: base });
      const deste = r.problemas.filter((p) => p.indice === indice);
      if (deste.length) recusadas.push({ motivos: [...new Set(deste.map(descreverProblema))] });
      else aceitas.push(texto);
    }
    if (aceitas.length < total) {
      motivo = recusadas.length
        ? `${recusadas.length} variação(ões) recusada(s) pela validação — por exemplo: ${recusadas[0].motivos.join('; ')}`
        : `a IA devolveu ${candidatas.length} de ${quantidade} variação(ões) pedidas`;
    }
  }

  if (aceitas.length === total) return { ok: true, variacoes: aceitas, erro: null, tentativas };
  return {
    ok: false,
    variacoes: [],
    erro: `A IA não gerou ${total} variações válidas em ${tentativas} tentativa(s) (${motivo}). `
      + 'Nada foi gravado. Tente de novo, ajuste o texto-base ou escreva as variações manualmente.',
    tentativas,
  };
}

module.exports = {
  gerarVariacoes,
  montarMensagensVariacoes,
  parseVariacoes,
  problemasDoTextoBase,
  iaLigada,
  ENV_ATIVO,
  ERRO_IA_DESLIGADA,
  MAX_TENTATIVAS,
  TEMPERATURA,
  MAX_TOKENS,
};
