'use strict';

// Adaptador de e-mail de CAMPANHA (Promocao de Vagas): ZeptoMail (Zoho).
//
// Substitui o Emailit. Contrato IDENTICO ao de ./emailit_api.js, de proposito — a
// varredura de disparo e o botao de e-mail de teste chamam os dois do mesmo jeito:
//
//   enviar(destinatario, assunto, html, opcoes = {}) -> Promise<{ id }>
//     opcoes.replyTo         (string, opcional)
//     opcoes.headers         (objeto plano de headers EXTRA; somam-se aos automaticos)
//     opcoes.semDescadastro  (bool; valvula de escape — ver ./cabecalhos)
//     opcoes.httpClient      (opcional; ponto de injecao, compativel com fetch)
//
// ── A MUDANCA ESTRUTURAL: headers -> mime_headers ──
// SMTP e a API do Emailit recebem os cabecalhos de opt-out num campo chamado `headers`. O
// ZeptoMail chama o mesmo campo de `mime_headers`. E a UNICA diferenca de forma que
// importa aqui, e por isso montarCabecalhos continua devolvendo objeto plano em
// ./cabecalhos.js: a traducao do nome do campo e responsabilidade de cada transporte, o
// CONTEUDO do opt-out e do dominio.
//
// List-Unsubscribe e List-Unsubscribe-Post continuam AUTOMATICOS e pela MESMA funcao dos
// outros dois transportes. Nao ha copia: se a regra de opt-out mudar, muda uma vez.
//
// ── POR QUE UM ADAPTADOR SEPARADO DO TRANSACIONAL ──
// Ha um zeptomail.js gemeo em providers/email/. Mesma API, remetentes e raio de explosao
// diferentes — ver a nota la e a justificativa em config.js.

const { config } = require('../../config');
const { montarCabecalhos } = require('./cabecalhos');
// A UNICA coisa importada do bloco transacional, e de proposito: as duas verificam a mesma
// armadilha (URL sem protocolo) e duplicar a mensagem faria as duas divergirem no dia em
// que uma fosse melhorada. E validacao de formato, nao regra de negocio — nao carrega
// remetente, credencial nem nada que o desenho separa entre os dois fluxos.
const { garantirUrlValida, cabecalhoAuth, pistaDeAuth } = require('../email/zeptomail');

// Mesmo recorte de erro dos outros adaptadores de campanha: a coluna `erro` de
// campanha_envios existe para o Jean entender o que houve, nao para arquivar um HTML de
// 500 inteiro.
const MAX_DETALHE_ERRO = 300;

// FONTE UNICA de "o que falta para uma campanha poder sair POR ESTE TRANSPORTE".
//
// Espelha as funcoes de mesmo nome em ./emailit_api.js e ./smtp.js — mesma assinatura,
// mesmo contrato (devolve NOMES de variaveis de ambiente ausentes) — porque o PRE-VOO do
// disparo (lib/dispararPromocao) a consome sem saber qual transporte esta ativo. E a
// fachada (./index.js) que roteia. Se as listas divergissem em formato, o pre-voo passaria
// a mentir sobre um dos caminhos.
//
// `remetente` entra na lista mesmo tendo default em config.js, pela mesma razao de la: a
// lista descreve o que um envio EXIGE, nao o que costuma estar vazio.
function credenciaisFaltando() {
  const faltando = [];
  if (!config.provedores.zeptomail.token) faltando.push('ZEPTOMAIL_TOKEN');
  if (!config.provedores.emailCampanha.remetente) faltando.push('SMTP_CAMPANHA_FROM_EMAIL');
  return faltando;
}

// Le o corpo da resposta de erro sem nunca lancar por causa da leitura em si: quando a API
// devolve 4xx/5xx, o que interessa e propagar o STATUS com alguma pista do corpo. Se ate a
// leitura falhar, um marcador e melhor que mascarar o erro original com outro.
async function detalheDoErro(resposta) {
  try {
    const texto = await resposta.text();
    return String(texto || '').slice(0, MAX_DETALHE_ERRO);
  } catch {
    return '(corpo da resposta ilegivel)';
  }
}

async function enviar(destinatario, assunto, html, opcoes = {}) {
  // Antes de qualquer coisa que custe rede: sem destinatario nao ha o que enviar. Mesma
  // ordem e mesma mensagem dos outros dois adaptadores.
  if (!destinatario) {
    throw new Error('Destinatario de e-mail de campanha ausente.');
  }

  const cfgCampanha = config.provedores.emailCampanha;
  if (!cfgCampanha.remetente) {
    throw new Error(
      'SMTP_CAMPANHA_FROM_EMAIL ausente. Defina o remetente de campanha no .env ' +
        '(dominio verificado no provedor).',
    );
  }

  // Credencial checada ANTES de montar qualquer coisa e antes de tocar a rede — o mesmo
  // "falhar alto e claro" dos outros transportes.
  const faltando = credenciaisFaltando();
  if (faltando.length) {
    throw new Error(
      `Credenciais de campanha ausentes: ${faltando.join(', ')}. ` +
        'Defina no .env antes de disparar campanhas. O token do ZeptoMail e o "Send Mail ' +
        'Token" emitido no painel, e vai no header Authorization como Zoho-enczapikey.',
    );
  }

  // Antes de montar o corpo: uma URL sem protocolo faz o fetch lancar "Failed to parse
  // URL", mensagem que nao nomeia a variavel nem diz o que falta. Na campanha isso e pior
  // que no transacional — cada tentativa marca o destinatario como 'falha' TERMINAL.
  garantirUrlValida(config.provedores.zeptomail.apiUrl);

  const http = opcoes.httpClient || fetch;

  const corpo = {
    from: { address: cfgCampanha.remetente, name: cfgCampanha.remetenteNome },
    to: [{ email_address: { address: destinatario } }],
    subject: assunto,
    htmlbody: html,
  };

  // `reply_to` e LISTA de objetos `{ address }` no ZeptoMail (diferente do `reply_to`
  // string do Emailit e do `replyTo` do nodemailer). Conferido na doc da v1.1.
  if (opcoes.replyTo) corpo.reply_to = [{ address: opcoes.replyTo }];

  // Depois da credencial, de proposito: com o token faltando, o erro que interessa e o do
  // token, nao o do descadastro. montarCabecalhos LANCA se DESCADASTRO_SECRET faltar — e e
  // essa a intencao, aqui igual aos outros: campanha sem opt-out valido nao sai.
  //
  // `mime_headers` e o nome do campo no ZeptoMail; o conteudo e o mesmo objeto plano que
  // os outros transportes recebem como `headers`.
  const mimeHeaders = montarCabecalhos(destinatario, opcoes);
  if (Object.keys(mimeHeaders).length) corpo.mime_headers = mimeHeaders;

  let resposta;
  try {
    resposta = await http(config.provedores.zeptomail.apiUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        // NAO e Bearer — o ZeptoMail usa esquema proprio. cabecalhoAuth normaliza um token
        // que ja venha com o prefixo colado (o painel exibe a credencial nesse formato).
        Authorization: cabecalhoAuth(config.provedores.zeptomail.token),
      },
      body: JSON.stringify(corpo),
    });
  } catch (err) {
    // Falha de TRANSPORTE (DNS, TLS, socket): distinta de "a API respondeu recusando".
    throw new Error(
      `Falha ao enviar e-mail de campanha via API do ZeptoMail: ${String(err && err.message).slice(0, MAX_DETALHE_ERRO)}`,
    );
  }

  if (!resposta || !resposta.ok) {
    const status = resposta ? resposta.status : 'sem resposta';
    throw new Error(
      `Falha ao enviar e-mail de campanha via API do ZeptoMail: HTTP ${status} — ` +
        `${await detalheDoErro(resposta)}` +
        // Tamanhos, nunca o valor. O 500 de corpo vazio que o prefixo duplicado produziu
        // nao apontava para nada; esta pista teria entregado a causa na 1a tentativa. Vai
        // para o log E para a coluna `erro` de campanha_envios, e por isso e curta.
        pistaDeAuth(config.provedores.zeptomail.token),
    );
  }

  // 2xx = aceito pelo provedor. A partir daqui, nada que dependa de PARSEAR o corpo pode
  // transformar um envio bem-sucedido em erro: o e-mail ja foi aceito, e devolver excecao
  // faria a varredura marcar como 'falha' (terminal) alguem que de fato vai receber.
  let dados = null;
  try {
    dados = await resposta.json();
  } catch {
    dados = null;
  }

  return { id: extrairId(dados) };
}

// Mesma extracao tolerante do adaptador transacional — ver a nota la sobre a doc nao
// listar `message_id` entre os campos de resposta documentados. Duplicada de proposito:
// unificar exigiria um modulo compartilhado entre os dois blocos de provedor, e a
// separacao entre eles e justamente o que este desenho protege.
function extrairId(dados) {
  if (!dados || typeof dados !== 'object') return null;
  const primeiro = Array.isArray(dados.data) ? dados.data[0] : null;
  return (primeiro && (primeiro.message_id || primeiro.messageId)) || dados.request_id || null;
}

module.exports = { enviar, credenciaisFaltando, extrairId };
