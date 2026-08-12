'use strict';

// Adaptador de e-mail TRANSACIONAL: ZeptoMail (Zoho).
//
// Substitui o Resend nos sete call sites do funil (relatorio ao recrutador, lembrete de
// inicio, recusa, follow-up, retomada, notificacao de nova candidatura e analise do Banco
// de Curriculos). Nenhum deles muda: o contrato posicional e o mesmo de ./resend.js.
//
//   enviar(destinatario, assunto, html) -> Promise<{ id }>
//
// ── POR QUE UM ADAPTADOR SEPARADO DO DE CAMPANHA ──
// Ha um zeptomail.js gemeo em providers/emailCampanha/, e a duplicacao e deliberada. Os
// dois falam com a MESMA API, mas com remetentes, tratamento de opcoes e — principalmente
// — RAIO DE EXPLOSAO diferentes. config.js registra a razao: "uma denuncia de spam numa
// campanha nao pode derrubar a entrega do e-mail de entrevista de ninguem". Um modulo
// unico juntaria os dois num ponto de falha so, que e exatamente o que a separacao entre
// `email` e `emailCampanha` existe para impedir.
//
// ── O QUE MUDA EM RELACAO AO RESEND ──
// So o envelope. O HTML, o assunto e o destinatario chegam iguais; o que difere e a forma
// do JSON e o header de autenticacao:
//   Resend   : Authorization: Bearer <key> | { from: "a@b.c", to: "x@y.z", html }
//   ZeptoMail: Authorization: Zoho-enczapikey <token>
//              { from: { address }, to: [{ email_address: { address } }], htmlbody }

const { config } = require('../../config');

// Recorte do corpo de erro guardado na mensagem da excecao. Mesmo numero e mesma razao do
// resend.js: a mensagem existe para alguem entender o que houve, nao para arquivar um HTML
// de 500 inteiro num log.
const MAX_DETALHE_ERRO = 300;

// Checagem da URL ANTES do fetch, porque a mensagem que o fetch da nao ensina nada.
//
// `fetch('api.zeptomail.com')` lanca "Failed to parse URL from api.zeptomail.com": nao
// nomeia a variavel, nao diz o que falta e chega ao operador embrulhada no catch de quem
// chamou. Foi assim que o primeiro teste real do ZeptoMail falhou — a variavel estava no
// Railway sem o https:// e sem o path.
//
// Exportada para o adaptador de campanha reusar: as duas verificam a MESMA armadilha, e
// e a unica coisa que faz sentido compartilhar entre os dois blocos de provedor.
// O esquema de autenticacao do ZeptoMail, e o prefixo que o painel mostra COLADO no token.
const ESQUEMA_AUTH = 'Zoho-enczapikey';

// Token sem o prefixo, aceitando as duas formas.
//
// ── POR QUE ISTO EXISTE ──
// O painel do ZeptoMail exibe a credencial ja no formato de header — "Zoho-enczapikey
// wSsV..." — e quem copia leva o rotulo junto. Foi o que aconteceu aqui: ZEPTOMAIL_TOKEN
// entrou com os 16 caracteres do prefixo grudados, o adaptador prefixou de novo, e o header
// saiu "Zoho-enczapikey Zoho-enczapikey wSsV...". O ZeptoMail respondeu 500 com CORPO
// VAZIO, que nao aponta para nada.
//
// E o mesmo erro de ZEPTOMAIL_API_URL, que veio como "api.zeptomail.com" porque o valor foi
// copiado sem o protocolo: os dois sao "colei o que estava na tela". Normalizar aqui torna
// as duas formas equivalentes, e o aviso de boot (config.validar) diz qual delas esta em
// uso — tolerar em silencio esconderia a bagunca.
//
// Exportada para o adaptador de campanha reusar, pelo mesmo motivo de garantirUrlValida:
// e higiene de FORMATO de credencial, nao regra de negocio.
function normalizarToken(token) {
  return String(token || '')
    .trim()
    .replace(new RegExp(`^${ESQUEMA_AUTH}\\s+`, 'i'), '');
}

// Header de Authorization pronto, sempre com UM prefixo.
function cabecalhoAuth(token) {
  return `${ESQUEMA_AUTH} ${normalizarToken(token)}`;
}

// Pista de autenticacao anexada a erros 4xx/5xx — TAMANHOS, nunca o valor.
//
// O ZeptoMail respondeu 500 com corpo VAZIO quando o header vinha com o prefixo duplicado,
// e a mensagem resultante ("HTTP 500 — ") nao apontava para nada. Diagnosticar exigiu
// capturar o payload e comparar o header a mao.
//
// Os tres numeros abaixo teriam entregado a causa na primeira tentativa: o token de 160
// chars normalizando para 144 e a marca de que o prefixo veio colado. Sao tamanhos e um
// booleano — nada aqui reconstroi a credencial, e por isso pode ir para log e para a coluna
// `erro` de campanha_envios sem virar vazamento.
function pistaDeAuth(token) {
  const bruto = String(token || '');
  const limpo = normalizarToken(bruto);
  return (
    ` [auth: token ${bruto.length} chars, ${limpo.length} apos normalizar` +
    `${bruto.length !== limpo.length ? ', PREFIXO VEIO COLADO na variavel' : ''}]`
  );
}

function garantirUrlValida(url) {
  if (!/^https?:\/\//i.test(String(url || ''))) {
    throw new Error(
      `ZEPTOMAIL_API_URL invalida: ${JSON.stringify(url)}. ` +
        'Precisa ser a URL completa, com protocolo e caminho ' +
        '(ex.: https://api.zeptomail.com/v1.1/email). Remova a variavel para usar o padrao.',
    );
  }
}

async function enviar(destinatario, assunto, html) {
  const cfg = config.provedores.zeptomail;

  // Credencial checada ANTES de tocar a rede, igual ao resend.js. Uma requisicao sem token
  // voltaria como 401 generico, que nao diz a ninguem qual variavel preencher.
  if (!cfg.token) {
    throw new Error(
      'ZEPTOMAIL_TOKEN ausente. Defina o token no .env para enviar e-mail via ZeptoMail.',
    );
  }
  if (!destinatario) {
    throw new Error('Destinatario de e-mail ausente (verifique RECRUITER_EMAIL no .env).');
  }
  garantirUrlValida(cfg.apiUrl);

  // Remetente do fluxo TRANSACIONAL (config.provedores.email), e nao do bloco zeptomail:
  // o token e compartilhado entre os dois fluxos, mas a identidade de quem envia continua
  // pertencendo a cada um. E o que mantem a separacao de reputacao viva mesmo com um
  // provedor so.
  const remetente = config.provedores.email;

  let resp;
  try {
    resp = await fetch(cfg.apiUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        // NAO e Bearer: o ZeptoMail usa um esquema proprio, e mandar Bearer devolve 401.
        // cabecalhoAuth normaliza um token que ja venha com o prefixo colado — ver a nota
        // la sobre por que isso acontece.
        Authorization: cabecalhoAuth(cfg.token),
      },
      body: JSON.stringify({
        from: { address: remetente.remetente, name: remetente.remetenteNome },
        // Lista de UM: o contrato desta funcao e um destinatario por chamada, como sempre
        // foi. A API aceita varios, mas passar mais de um aqui mudaria o significado de
        // "enviar" para os sete call sites.
        to: [{ email_address: { address: destinatario } }],
        subject: assunto,
        htmlbody: html,
      }),
    });
  } catch (err) {
    // Falha de TRANSPORTE (DNS, TLS, socket): distinta de "a API respondeu recusando".
    throw new Error(`Falha de rede ao enviar e-mail via ZeptoMail: ${err.message}`);
  }

  if (!resp.ok) {
    const detalhe = await resp.text().catch(() => '');
    throw new Error(
      `ZeptoMail retornou erro ${resp.status}: ${detalhe.slice(0, MAX_DETALHE_ERRO)}` +
        pistaDeAuth(cfg.token),
    );
  }

  // 2xx = aceito. A partir daqui, NADA que dependa de parsear o corpo pode transformar um
  // envio bem-sucedido em erro — mesma disciplina do adaptador de campanha: o e-mail ja
  // foi aceito, e lancar aqui faria o chamador registrar como falha alguem que vai receber.
  const dados = await resp.json().catch(() => null);
  return { id: extrairId(dados) };
}

// O contrato externo e `{ id }`, e os sete call sites (mais os testes) contam com isso.
//
// A documentacao da v1.1 descreve a resposta como `{ data: [...], message, request_id,
// object }` mas NAO lista `message_id` entre os campos documentados — embora ele apareca
// nos exemplos. Por isso a extracao e tolerante e em cascata, e nunca lanca: o id serve a
// log e rastreio, e um formato de resposta diferente do esperado nao pode virar falha de
// envio de um e-mail que ja saiu.
function extrairId(dados) {
  if (!dados || typeof dados !== 'object') return null;
  const primeiro = Array.isArray(dados.data) ? dados.data[0] : null;
  return (primeiro && (primeiro.message_id || primeiro.messageId)) || dados.request_id || null;
}

module.exports = {
  enviar,
  extrairId,
  garantirUrlValida,
  normalizarToken,
  cabecalhoAuth,
  pistaDeAuth,
  ESQUEMA_AUTH,
};
