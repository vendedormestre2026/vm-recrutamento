'use strict';

// Sugestao de conteudo do e-mail de campanha (Promocao de Vagas), gerada por LLM.
//
// Espelha lib/importar_vaga.js de ponta a ponta: prompt e parse isolados da camada HTTP,
// deps injetaveis para testar sem rede, resultado DISCRIMINADO (nunca lanca para quem
// chama) e parse tolerante a cerca de markdown. A diferenca deliberada esta em UMA coisa:
// aqui o custo da chamada e REGISTRADO em api_usage. O import de vaga nao registra, e isso
// e uma lacuna conhecida — campanha tem volume potencialmente maior e nao faz sentido
// nascer invisivel na tela de custos.
//
// O QUE ESTE MODULO NAO FAZ: nao cria campanha, nao envia e-mail, nao calcula publico. Ele
// devolve um rascunho de texto que o recrutador SEMPRE revisa e pode reescrever antes de
// criar a campanha. A saida e ponto de partida, nunca conteudo final.

const dbPadrao = require('../db');
const llmPadrao = require('../providers/llm');
const { calcularCustoDeepSeek } = require('./custos');

// Teto de saida. O shape tem dois campos (assunto curto + corpo de alguns paragrafos),
// bem menor que os 14 campos do import de vaga (que usa 2200). 1500 da folga confortavel
// e ainda deixa o truncamento detectavel por finishReason em vez de virar JSON cortado.
const MAX_TOKENS = 1500;

// Um pouco acima do 0.2 usado em extracao (import de vaga, relatorio): la o trabalho e
// copiar dado fielmente, aqui e ESCREVER. Ainda assim baixo o bastante para nao inventar
// beneficio que a vaga nao tem.
const TEMPERATURA = 0.6;

// Teto defensivo por campo de texto livre da vaga, para uma descricao anomala nao estourar
// o contexto. Mesma ideia do MAX_BRIEFING_CHARS do import.
const MAX_CHARS_CAMPO = 2000;

function texto(valor) {
  return String(valor == null ? '' : valor).trim().slice(0, MAX_CHARS_CAMPO);
}

// Renderiza um campo da vaga para o prompt, ou omite a linha inteira quando vazio: uma
// linha "Faixa salarial: (vazio)" convida o modelo a inventar um valor.
function linhaCampo(rotulo, valor) {
  const v = texto(valor);
  return v ? `${rotulo}: ${v}` : null;
}

// ── Prompt ──
//
// Exportada para o teste (e para revisao humana do texto) poder inspecionar exatamente o
// que vai ao modelo, sem precisar de rede.
function montarMensagensSugestao(vaga) {
  const v = vaga || {};
  const skills = Array.isArray(v.skills) ? v.skills.filter(Boolean).join(', ') : '';

  const system = [
    'Voce escreve e-mails curtos de divulgacao de vaga para uma base de candidatos que ja',
    'se relacionou com a empresa (candidatos anteriores e banco de talentos). Portugues do',
    'Brasil. Devolve APENAS um JSON valido — sem cercas markdown, sem texto antes ou depois.',
    '',
    'Formato EXATO (estas duas chaves e NENHUMA outra):',
    '{',
    '  "assunto": "string",',
    '  "corpoHtml": "string"',
    '}',
    '',
    'REGRAS DO ASSUNTO:',
    '- Curto (ate ~60 caracteres), direto, descritivo.',
    '- SEM clickbait, SEM urgencia artificial, SEM emoji, SEM CAIXA ALTA.',
    '- Diz do que se trata: a vaga. Nao promete nada que o corpo nao entregue.',
    '',
    'REGRAS DO CORPO (corpoHtml):',
    '- HTML SIMPLES: use apenas <p>, <strong>, <ul>/<li> e <br>.',
    '- NAO use CSS inline, tabelas, imagens, <style>, <div> com layout, cores ou fontes.',
    '  Cliente de e-mail ignora ou quebra estilo elaborado — texto limpo chega melhor.',
    '- 3 a 5 paragrafos curtos. Comece pelo que a vaga e, nao por saudacao generica.',
    '- Tom profissional e direto, sem jargao de marketing e sem superlativo vazio.',
    '- Use SOMENTE informacao da vaga fornecida abaixo. NAO invente beneficio, salario,',
    '  cidade, tecnologia ou requisito que nao esteja ali.',
    '- Termine convidando a pessoa a se candidatar. NAO escreva a URL da vaga: o link e',
    '  inserido depois, fora do texto gerado.',
    '',
    'NAO ESCREVA RODAPE DE DESCADASTRO NEM TEXTO DE LGPD/PRIVACIDADE.',
    'O cabecalho List-Unsubscribe e o link de descadastro sao adicionados automaticamente',
    'pelo sistema de envio, fora deste conteudo. Incluir um link de descadastro proprio',
    'criaria um segundo caminho de opt-out que nao funciona.',
    '',
    'Responda so com o objeto JSON.',
  ].join('\n');

  const dados = [
    linhaCampo('Titulo da vaga', v.titulo),
    linhaCampo('Perfil', v.perfil === 'CLOSER' ? 'Closer (fechamento de vendas)' : v.perfil),
    linhaCampo('Faixa de pagamento', v.faixa_pagamento),
    linhaCampo('Habilidades desejadas', skills),
    linhaCampo('Descricao', v.descricao),
    linhaCampo('Sobre a empresa', v.sobre_empresa),
  ].filter(Boolean);

  const user = ['DADOS DA VAGA:', '', dados.join('\n') || '(sem dados)'].join('\n');

  return [
    { papel: 'system', conteudo: system },
    { papel: 'user', conteudo: user },
  ];
}

// Recorta o JSON tolerando cerca de markdown acidental.
//
// DUPLICACAO CONHECIDA: lib/importar_vaga.js tem esta mesma funcao, e lib/relatorio.js tem
// a mesma ideia dentro de parseAvaliacao. Sao tres copias. Mantida aqui de proposito neste
// incremento — extrair um helper compartilhado mexeria em dois modulos que hoje funcionam,
// e o pedido era seguir o precedente. Fica registrado como candidato obvio a limpeza.
function recortarJson(texto) {
  let cru = String(texto || '').trim();
  const fence = cru.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) cru = fence[1].trim();
  const ini = cru.indexOf('{');
  const fim = cru.lastIndexOf('}');
  if (ini !== -1 && fim !== -1 && fim > ini) cru = cru.slice(ini, fim + 1);
  return cru;
}

// Parseia + valida a resposta. LANCA quando nao da para aproveitar (o orquestrador
// converte em erroCodigo). Exigir os DOIS campos nao-vazios e proposital: meia sugestao
// (assunto sem corpo) chegaria a tela como um campo misteriosamente em branco.
function parseSugestao(textoLLM) {
  const obj = JSON.parse(recortarJson(textoLLM)); // pode lancar
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) {
    throw new Error('JSON de sugestao nao e um objeto.');
  }

  const assunto = typeof obj.assunto === 'string' ? obj.assunto.trim() : '';
  const corpoHtml = typeof obj.corpoHtml === 'string' ? obj.corpoHtml.trim() : '';
  if (!assunto) throw new Error('Sugestao sem assunto.');
  if (!corpoHtml) throw new Error('Sugestao sem corpo.');

  return { assunto, corpoHtml };
}

// Orquestra: vaga -> prompt -> LLM -> JSON -> { assunto, corpoHtml }.
//
// Resultado DISCRIMINADO, nunca lanca (precedente: importarVagaDeBriefing):
//   { ok:false, erroCodigo:'VAGA_NAO_ENCONTRADA' | 'SUGESTAO_TRUNCADA'
//                        | 'SUGESTAO_FALHOU'    | 'LLM_INDISPONIVEL' }
//   { ok:true, assunto, corpoHtml }
//
// deps = { llm, db } injetaveis: o teste passa um LLM dublê e nao toca a rede.
async function gerarSugestaoConteudo(jobId, deps = {}) {
  const db = deps.db || dbPadrao;
  const llm = deps.llm || llmPadrao;

  const id = Number(jobId);
  const vaga = Number.isInteger(id) && id > 0 ? db.obterVaga(id) : null;
  if (!vaga) return { ok: false, erroCodigo: 'VAGA_NAO_ENCONTRADA' };

  let resp;
  try {
    resp = await llm.completar(montarMensagensSugestao(vaga), {
      temperatura: TEMPERATURA,
      maxTokens: MAX_TOKENS,
    });
  } catch (err) {
    // Rede fora, chave ausente, provedor com erro: nada disso e problema do Jean resolver
    // relendo o formulario, entao vira um codigo proprio, distinto de "a resposta veio mas
    // nao deu para usar".
    console.error(`[promocao/sugestao] falha na chamada ao LLM: ${err && err.message}`);
    return { ok: false, erroCodigo: 'LLM_INDISPONIVEL' };
  }

  // Custo BEST-EFFORT: registrar e observabilidade, nunca pode derrubar a sugestao que ja
  // foi paga. Mesmo padrao (e mesmo try/catch isolado) de lib/relatorio.js.
  try {
    db.registrarUsoApi({
      provedor: 'openrouter',
      modelo: resp && resp.modelo,
      origem: 'promocao',
      uso: resp && resp.uso,
      custo_usd: calcularCustoDeepSeek(resp && resp.uso),
    });
  } catch (e) {
    console.error('[custos] erro ao registrar uso (promocao):', e);
  }

  // Truncamento tem codigo PROPRIO: a acao do Jean e diferente (encurtar a descricao da
  // vaga e tentar de novo), e um "falhou" generico nao diria isso. Checado ANTES do parse
  // porque um JSON cortado ao meio falharia no parse e mascararia a causa real.
  if (resp && resp.finishReason === 'length') {
    console.error('[promocao/sugestao] resposta truncada pelo limite de tokens.');
    return { ok: false, erroCodigo: 'SUGESTAO_TRUNCADA' };
  }

  try {
    const { assunto, corpoHtml } = parseSugestao(resp && resp.texto);
    return { ok: true, assunto, corpoHtml };
  } catch (err) {
    // Loga TAMANHO e amostra curta, nunca o texto inteiro em producao — mesma disciplina
    // de observabilidade do import de vaga.
    const tam = resp && typeof resp.texto === 'string' ? resp.texto.length : 0;
    const amostra = resp && typeof resp.texto === 'string' ? resp.texto.slice(0, 200) : '';
    console.error(
      `[promocao/sugestao] falha no parse: ${err && err.message} ` +
        `(textoLen=${tam}, amostra=${JSON.stringify(amostra)})`,
    );
    return { ok: false, erroCodigo: 'SUGESTAO_FALHOU' };
  }
}

module.exports = {
  gerarSugestaoConteudo,
  montarMensagensSugestao,
  parseSugestao,
  MAX_TOKENS,
  TEMPERATURA,
};
