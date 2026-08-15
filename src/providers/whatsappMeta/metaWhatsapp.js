'use strict';

// Adaptador da Meta Cloud API (WhatsApp Business Platform) para envio de TEMPLATE.
//
// ── POR QUE NAO REAPROVEITA NADA DO BAILEYS ──
// whatsapp/connection.js mantem um socket persistente, com sessao pareada, reconexao e
// estado. Aqui e HTTP stateless com token: nao ha conexao para gerenciar, nao ha QR, nao ha
// sessao que se perca. E, principalmente, o CONTEUDO nao e nosso — a Meta so aceita template
// APROVADO PREVIAMENTE, com variaveis posicionais. Uma fachada comum entre os dois teria que
// fingir que "enviar texto" e "enviar template" sao a mesma operacao, e nao sao.
//
// ── O QUE ELE FAZ ──
//   enviarTemplate({ telefone, template, variaveis, httpClient }) -> { wamid }
// LANCA em qualquer falha. O chamador (o job) classifica com classificarErroMeta e decide
// entre retentar, desistir ou abortar o ciclo.
//
// ⚠️ NUNCA exercitado contra a API real. Todo teste roda em mock ou com httpClient injetado.

const { mascarar } = require('../../whatsapp/sequenciaOutbox');

// Versao da Graph API. Fixada de proposito: a Meta versiona e depreca, e "sempre a mais
// nova" e como um deploy futuro quebra sozinho sem ninguem ter mexido em nada.
const VERSAO_API = 'v21.0';
const BASE_URL = 'https://graph.facebook.com';

// Recorte do corpo de erro guardado. Mesmo numero e mesma razao dos adaptadores de e-mail: a
// coluna `erro` existe para alguem entender o que houve, nao para arquivar JSON inteiro.
const MAX_DETALHE_ERRO = 300;

function cfg() {
  return {
    token: String(process.env.META_WHATSAPP_TOKEN || '').trim(),
    phoneNumberId: String(process.env.META_PHONE_NUMBER_ID || '').trim(),
    wabaId: String(process.env.META_WABA_ID || '').trim(),
  };
}

// ── MOCK E O DEFAULT, e a ausencia da variavel NAO pode significar "pode enviar" ──
// Mesma disciplina de WHATSAPP_SEQUENCIA_MOCK. Aqui pesa mais: cada mensagem real custa
// dinheiro e conta para a qualidade do numero.
function modoMock() {
  return String(process.env.META_CAMPANHA_MOCK || 'true').toLowerCase() !== 'false';
}

// FONTE UNICA de "o que falta para a campanha poder sair". Mesmo contrato das funcoes de
// mesmo nome nos adaptadores de e-mail: devolve NOMES de variaveis ausentes.
function credenciaisFaltando() {
  const c = cfg();
  const faltando = [];
  if (!c.token) faltando.push('META_WHATSAPP_TOKEN');
  if (!c.phoneNumberId) faltando.push('META_PHONE_NUMBER_ID');
  return faltando;
}

// wamid deterministico para o modo mock.
//
// DETERMINISTICO e nao aleatorio: o mesmo destinatario na mesma campanha produz o mesmo id,
// entao rodar o ciclo duas vezes em mock nao inventa duas mensagens diferentes. E o prefixo
// 'mock-' e obrigatorio — um id que se pareca com o da Meta acabaria casando com evento de
// webhook de verdade um dia.
function wamidMock(telefone, nomeTemplate) {
  const base = `${telefone}|${nomeTemplate}`;
  let h = 0;
  for (let i = 0; i < base.length; i += 1) h = (h * 31 + base.charCodeAt(i)) >>> 0;
  return `mock-${h.toString(36)}`;
}

// Monta o corpo da chamada. Extraido para ser testavel sem rede e sem mock.
//
// `components` com um bloco `body` de parametros POSICIONAIS, na ordem — a Meta nao tem
// variavel nomeada, e a posicao no array E o {{n}} do template.
function montarPayload({ telefone, template, variaveis }) {
  const components = [
    {
      type: 'body',
      parameters: (variaveis || []).map((v) => ({ type: 'text', text: String(v == null ? '' : v) })),
    },
  ];

  // ── BOTAO ESTRUTURAL ──
  // Botão estrutural do template, exigido pela Graph API mesmo sem uso funcional — o botão
  // aponta para uma URL base incorreta cadastrada na Meta (business.facebook.com em vez de
  // chat.whatsapp.com) e não pode mais ser editado. O link real do grupo vai no corpo da
  // mensagem (variável 3), não no botão. Valor fixo 'indisponivel' satisfaz a exigência de
  // formato da API sem ter função.
  //
  // O valor vem de templates_whatsapp.botao_parametro_fixo, e nao de um `if nome_meta ===
  // 'confirmacao_cadastro_vaga_vm'`: ter botao (e qual parametro ele exige) e propriedade do
  // template APROVADO la fora, entao o proximo template na mesma situacao se resolve com um
  // UPDATE e nao com um deploy.
  //
  // VAZIO/NULL = template SEM botao -> nenhum componente. Mandar botao para um template que
  // nao tem e rejeitado pela Meta com a mesma dureza com que ela cobra o que falta, entao o
  // default tem que ser "nao manda".
  //
  // `index` e string de proposito: a Cloud API documenta o campo como string, e o botao e
  // sempre o de indice 0 porque um template so tem um botao de URL dinamica.
  const parametroBotao = String((template && template.botao_parametro_fixo) || '').trim();
  if (parametroBotao) {
    components.push({
      type: 'button',
      sub_type: 'url',
      index: '0',
      parameters: [{ type: 'text', text: parametroBotao }],
    });
  }

  return {
    messaging_product: 'whatsapp',
    recipient_type: 'individual',
    to: telefone,
    type: 'template',
    template: {
      name: template.nome_meta,
      language: { code: template.idioma || 'pt_BR' },
      components,
    },
  };
}

// Le o corpo de erro sem nunca lancar pela leitura em si.
async function detalheDoErro(resposta) {
  try {
    const texto = await resposta.text();
    return String(texto || '').slice(0, MAX_DETALHE_ERRO);
  } catch {
    return '(corpo da resposta ilegivel)';
  }
}

// Envia UM template. Devolve { wamid, mock }.
async function enviarTemplate({ telefone, template, variaveis, httpClient } = {}) {
  if (!telefone) throw new Error('Destinatario de WhatsApp ausente.');
  if (!template || !template.nome_meta) throw new Error('Template sem nome_meta: nada a enviar.');

  const payload = montarPayload({ telefone, template, variaveis });

  // ── MODO MOCK: nenhuma chamada de rede ──
  // Registra o que SAIRIA, com o telefone MASCARADO (reaproveitando mascarar() da sequencia:
  // o stdout do Railway e lido por mais gente que o banco), e devolve um wamid falso para o
  // fluxo inteiro poder ser exercitado sem custo e sem gastar reputacao do numero.
  if (modoMock()) {
    const wamid = wamidMock(telefone, template.nome_meta);
    console.log(
      `[meta-wa] (mock) template '${template.nome_meta}' -> ${mascarar(telefone)} ` +
        `com ${(variaveis || []).length} variavel(is). NAO enviado. wamid=${wamid}`,
    );
    return { wamid, mock: true };
  }

  const faltando = credenciaisFaltando();
  if (faltando.length) {
    throw new Error(
      `Credenciais da Meta ausentes: ${faltando.join(', ')}. Defina no .env antes de sair do ` +
        'modo mock (META_CAMPANHA_MOCK=false).',
    );
  }

  const c = cfg();
  const http = httpClient || fetch;
  const url = `${BASE_URL}/${VERSAO_API}/${c.phoneNumberId}/messages`;

  let resposta;
  try {
    resposta = await http(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${c.token}`,
      },
      body: JSON.stringify(payload),
    });
  } catch (err) {
    // Falha de TRANSPORTE (DNS, TLS, socket), distinta de "a API respondeu recusando".
    throw new Error(`Falha de rede ao chamar a Meta Cloud API: ${String(err && err.message).slice(0, MAX_DETALHE_ERRO)}`);
  }

  if (!resposta || !resposta.ok) {
    const status = resposta ? resposta.status : 'sem resposta';
    throw new Error(`Meta Cloud API retornou HTTP ${status} — ${await detalheDoErro(resposta)}`);
  }

  // 2xx = aceito. A partir daqui NADA que dependa de parsear o corpo pode virar excecao: a
  // mensagem ja foi aceita, e lancar aqui faria o job retentar alguem que VAI receber — e no
  // WhatsApp isso e mensagem duplicada, que e denuncia.
  let dados = null;
  try {
    dados = await resposta.json();
  } catch {
    dados = null;
  }

  return { wamid: extrairWamid(dados), mock: false };
}

// O id da mensagem, do formato documentado { messages: [{ id }] }. Tolerante e nunca lanca —
// ver a nota acima sobre nao transformar aceite em erro.
function extrairWamid(dados) {
  if (!dados || typeof dados !== 'object') return null;
  const primeira = Array.isArray(dados.messages) ? dados.messages[0] : null;
  return (primeira && primeira.id) || null;
}

// ── Classificacao de erro, analoga a lib/classificarErroEnvio ──
//
// Tres categorias, e nao quatro: nao ha equivalente util de 'retentavel_alto' aqui. O que a
// campanha de e-mail chamava de "cota que vira sozinha" na Meta e RATE LIMIT (que passa em
// minutos, teto baixo resolve) ou TIER REBAIXADO (que nao passa sozinho e exige acao humana,
// entao insistir 100 vezes so piora a qualidade do numero).
//
// CODIGO ANTES DE STATUS, pela mesma razao registrada em classificarErroEnvio: o status HTTP
// da Meta nao separa as causas — 400 cobre desde "numero invalido" ate "template rejeitado",
// e o que distingue e o `code` do corpo.
const TETO_RETENTAVEL = 5;

// Codigos da Meta que sao problema DO AMBIENTE: token, permissao, numero nao registrado.
// Nenhum muda de resposta conforme o destinatario -> aborta o ciclo, sem marcar ninguem.
const CODIGOS_CONFIGURACAO = [190, 200, 10, 803, 33];
// Codigos de destinatario: numero invalido/inexistente no WhatsApp. Retentar produz o mesmo
// erro e gasta tier.
const CODIGOS_TERMINAIS = [131026, 131047, 131051, 132000, 132001, 132005, 132007, 132012, 132015];
// Rate limit / throughput. Passa sozinho, mas rapido — teto baixo.
const CODIGOS_RETENTAVEIS = [4, 80007, 130429, 131048, 131056];

function extrairCodigo(mensagem) {
  const m = /"code"\s*:\s*(\d+)/.exec(String(mensagem || ''));
  return m ? Number(m[1]) : null;
}

function statusHttp(mensagem) {
  const m = /\bHTTP (\d{3})\b/i.exec(String(mensagem || ''));
  return m ? Number(m[1]) : null;
}

function classificarErroMeta(erro) {
  const bruta = String((erro && erro.message) || erro || '');
  const msg = bruta.toLowerCase();
  const codigo = extrairCodigo(bruta);
  const status = statusHttp(bruta);

  // 1. Nossos proprios erros de ambiente, antes de qualquer coisa.
  if (/credenciais da meta ausentes/i.test(bruta)) {
    return { categoria: 'configuracao', teto: null, motivo: 'credenciais ausentes' };
  }

  // 2. CODIGO da Meta — a fonte confiavel, antes do status.
  if (codigo !== null) {
    if (CODIGOS_CONFIGURACAO.includes(codigo)) {
      return { categoria: 'configuracao', teto: null, motivo: `codigo ${codigo} da Meta (credencial/permissao)` };
    }
    if (CODIGOS_TERMINAIS.includes(codigo)) {
      return { categoria: 'terminal', teto: null, motivo: `codigo ${codigo} da Meta (destinatario)` };
    }
    if (CODIGOS_RETENTAVEIS.includes(codigo)) {
      return { categoria: 'retentavel', teto: TETO_RETENTAVEL, motivo: `codigo ${codigo} da Meta (limite)` };
    }
  }

  // 3. Template rejeitado/inexistente: terminal para ESTA campanha, e o texto e mais estavel
  // que o codigo nesses casos.
  if (/template.*(not exist|does not exist|not found|rejected|paused|disabled)/i.test(msg)) {
    return { categoria: 'terminal', teto: null, motivo: 'template indisponivel na Meta' };
  }

  // 4. Status, como fallback.
  if (status === 401 || status === 403) {
    return { categoria: 'configuracao', teto: null, motivo: `HTTP ${status} sem codigo conhecido (credencial)` };
  }
  if (status === 429) {
    return { categoria: 'retentavel', teto: TETO_RETENTAVEL, motivo: 'HTTP 429 (rate limit)' };
  }
  if (status !== null && status >= 500) {
    return { categoria: 'retentavel', teto: TETO_RETENTAVEL, motivo: `HTTP ${status} (erro da Meta)` };
  }

  // 5. Desconhecido -> RETENTAVEL, pela mesma assimetria de custo de classificarErroEnvio:
  // desconhecido-como-terminal perde a pessoa para sempre (o UNIQUE impede rematerializar);
  // desconhecido-como-retentavel custa 4 chamadas e acaba em falha do mesmo jeito.
  return { categoria: 'retentavel', teto: TETO_RETENTAVEL, motivo: 'erro nao classificado' };
}

module.exports = {
  enviarTemplate,
  montarPayload,
  classificarErroMeta,
  credenciaisFaltando,
  modoMock,
  wamidMock,
  extrairWamid,
  VERSAO_API,
  TETO_RETENTAVEL,
};
