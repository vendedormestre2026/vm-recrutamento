'use strict';

// Adaptador LLM: OpenRouter (gateway unificado — uma chave, varios modelos, API
// compativel com a da OpenAI). E o provedor PADRAO do projeto.
// Chamado apenas quando INTERVIEW_MOCK=false.
//
// Contrato: completar(mensagens, opcoes) -> { texto, modelo, uso, finishReason }
//   mensagens: [{ papel: 'system'|'user'|'assistant', conteudo: string }]
//   opcoes:    { modelo?, tarefa?, temperatura?, maxTokens? }
//
// Selecao do modelo (nesta ordem):
//   1) opcoes.modelo            -> slug explicito (ganha de tudo)
//   2) opcoes.tarefa==='simples'-> LLM_MODEL_SIMPLES  (tarefas leves)
//   3) padrao                   -> LLM_MODEL_COMPLEXO (perguntas/relatorio)

const { config } = require('../../config');

function resolverModelo(opcoes) {
  const cfg = config.provedores.llm;
  if (opcoes.modelo) return opcoes.modelo;
  if (opcoes.tarefa === 'simples') return cfg.modeloSimples;
  return cfg.modeloComplexo;
}

// Normaliza o `usage` bruto do OpenRouter para o shape que lib/custos.js espera
// (split cache hit/miss). O OpenRouter expoe os tokens cacheados em
// prompt_tokens_details.cached_tokens; o restante da entrada conta como cache miss.
function normalizarUso(usage) {
  if (!usage || typeof usage !== 'object') return null;
  const prompt = Number(usage.prompt_tokens) || 0;
  const completion = Number(usage.completion_tokens) || 0;
  const cached =
    (usage.prompt_tokens_details && Number(usage.prompt_tokens_details.cached_tokens)) || 0;
  return {
    prompt_tokens: prompt,
    completion_tokens: completion,
    total_tokens: Number(usage.total_tokens) || prompt + completion,
    prompt_cache_hit_tokens: cached,
    prompt_cache_miss_tokens: Math.max(0, prompt - cached),
    // Custo informado pela propria OpenRouter (USD), quando disponivel. Hoje o calculo
    // oficial vive em lib/custos.js; este campo fica exposto para uso/auditoria futura.
    cost: usage.cost != null ? Number(usage.cost) : null,
  };
}

async function completar(mensagens, opcoes = {}) {
  const cfg = config.provedores.llm.openrouter;
  if (!cfg.apiKey) {
    throw new Error('OPENROUTER_API_KEY ausente. Defina a chave no .env para usar o LLM via OpenRouter.');
  }

  const modelo = resolverModelo(opcoes);
  const url = `${cfg.baseUrl.replace(/\/+$/, '')}/chat/completions`;
  const messages = (mensagens || []).map((m) => ({ role: m.papel, content: m.conteudo }));

  const corpo = {
    model: modelo,
    messages,
    temperature: opcoes.temperatura != null ? opcoes.temperatura : 0.7,
    max_tokens: opcoes.maxTokens != null ? opcoes.maxTokens : 1024,
    // Parametro unificado de raciocinio do OpenRouter: desligamos o "thinking" para
    // respostas diretas, mais rapidas e baratas (mesma intencao do antigo adaptador
    // DeepSeek). Modelos sem suporte simplesmente ignoram.
    reasoning: { enabled: false },
    // Pede a contabilidade de uso (inclui o custo em USD quando o provedor reporta).
    usage: { include: true },
  };

  let resp;
  try {
    resp = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${cfg.apiKey}`,
        // Headers recomendados pelo OpenRouter (rankings/atribuicao). Opcionais.
        'HTTP-Referer': config.baseUrl,
        'X-Title': 'Vendedor Mestre - Recrutamento',
      },
      body: JSON.stringify(corpo),
    });
  } catch (err) {
    throw new Error(`Falha de rede ao chamar o LLM via OpenRouter: ${err.message}`);
  }

  if (!resp.ok) {
    const detalhe = await resp.text().catch(() => '');
    throw new Error(`OpenRouter retornou erro ${resp.status}: ${detalhe.slice(0, 300)}`);
  }

  const dados = await resp.json();
  const escolha = (dados.choices && dados.choices[0]) || {};
  const mensagem = escolha.message || {};
  // finishReason: 'stop' (completo) | 'length' (cortado pelo max_tokens) | outros. Exposto
  // no retorno p/ os callers detectarem truncamento (ex.: import de vaga). Aditivo: quem
  // desestrutura so { texto, modelo, uso } continua funcionando (relatorio, entrevista).
  const finishReason = escolha.finish_reason || null;

  let texto = mensagem.content || '';

  // Rede de seguranca: com reasoning desabilitado isto nao deveria ocorrer, mas se o
  // content vier vazio e houver reasoning, usamos como fallback (evita silencio total).
  if (!texto && mensagem.reasoning) {
    console.warn(
      '[llm/openrouter] content veio vazio; usando reasoning como fallback ' +
        '(verifique se o reasoning foi mesmo desabilitado para este modelo).',
    );
    texto = typeof mensagem.reasoning === 'string' ? mensagem.reasoning : '';
  }

  return { texto, modelo, uso: normalizarUso(dados.usage), finishReason };
}

module.exports = { completar };
