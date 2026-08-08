'use strict';

// Adaptador de e-mail de CAMPANHA (Promocao de Vagas), sobre SMTP generico.
//
// ── POR QUE ESTE MODULO EXISTE, SEPARADO DE providers/email ──
// O adaptador transacional (providers/email, Resend) serve 6 call sites do funil:
// relatorio ao recrutador, recusa, follow-up, lembrete de inicio, retomada e notificacao
// de nova candidatura. Nenhum deles e tocado por este arquivo, e essa e a intencao: o
// envio em massa tem provedor, remetente, reputacao e cabecalhos proprios, e mudar o
// adaptador transacional para acomodar campanha colocaria em risco e-mails que hoje
// funcionam. Sao dois sistemas com o mesmo verbo, nao um sistema com duas opcoes.
//
// ── POR QUE SMTP GENERICO E NAO A API REST DO EMAILIT ──
// Para a migracao ser de CONFIGURACAO, nao de codigo: quando o Amazon SES for aprovado,
// trocam-se host/porta/usuario/senha por credenciais SES (o SES tambem fala SMTP) e
// nenhuma linha daqui muda. Uma integracao com a API proprietaria do Emailit amarraria o
// projeto a ele e transformaria a troca de provedor num reescrever de adaptador.
//
// ── CONTRATO (deliberadamente DIFERENTE do transacional) ──
//   enviar(destinatario, assunto, html, opcoes = {}) -> Promise<{ id }>
//     opcoes.replyTo         (string, opcional)
//     opcoes.headers         (objeto plano de headers EXTRA; somam-se aos automaticos)
//     opcoes.semDescadastro  (bool; valvula de escape — ver montarCabecalhos)
//     opcoes.transporter     (opcional; ponto de injecao — ver abaixo)
//
// Os cabecalhos List-Unsubscribe / List-Unsubscribe-Post (RFC 8058) sao incluidos
// AUTOMATICAMENTE em todo envio. Nao ha caminho de esquecimento: campanha sem opt-out
// valido e problema de entregabilidade, nao de cortesia.
//
// Mesmo ESPIRITO do resto do projeto: async, lanca em erro com mensagem clara, nunca
// engole excecao. Quem chama (a rotina do Incremento 7) decide o que fazer com a falha.

const nodemailer = require('nodemailer');
const { config } = require('../../config');
const { montarUrlDescadastro } = require('../../lib/descadastro');

// Transporter em cache. LAZY (criado no primeiro envio, nao no load do modulo) por dois
// motivos: o modulo pode ser carregado num processo que nunca envia campanha (o app
// inteiro carrega este arquivo se alguma rota o importar), e criar no load congelaria a
// config no momento do require — o que atrapalha teste e recarga de configuracao.
let _transporter = null;

// Recorte de mensagem de erro de provedor, para o log nao virar um despejo de SMTP.
const MAX_DETALHE_ERRO = 300;

// Cria o transporter a partir da config. Exportada para quem quiser um transporter
// proprio (e para deixar explicito que a fabrica e separada do cache).
// LANCA quando falta credencial: e melhor falhar aqui, alto e claro, do que abrir uma
// conexao que o provedor vai recusar com um erro generico de autenticacao.
function criarTransporter() {
  const cfg = config.provedores.emailCampanha;

  const faltando = [];
  if (!cfg.host) faltando.push('SMTP_CAMPANHA_HOST');
  if (!cfg.usuario) faltando.push('SMTP_CAMPANHA_USUARIO');
  if (!cfg.senha) faltando.push('SMTP_CAMPANHA_SENHA');
  if (faltando.length) {
    throw new Error(
      `Credenciais de SMTP de campanha ausentes: ${faltando.join(', ')}. ` +
        'Defina no .env antes de disparar campanhas (o adaptador nao tem fallback para ' +
        'o provedor transacional, de proposito).',
    );
  }

  return nodemailer.createTransport({
    host: cfg.host,
    port: cfg.porta,
    // Ver o comentario extenso em config.js: false + porta 587 = STARTTLS (a conexao
    // sobe para TLS depois do handshake). true e so para a porta 465 (TLS implicito).
    secure: cfg.seguro,
    auth: { user: cfg.usuario, pass: cfg.senha },
  });
}

function obterTransporter() {
  if (!_transporter) _transporter = criarTransporter();
  return _transporter;
}

// Os dois cabecalhos que a RFC 8058 exige de quem envia em volume. Sem eles, Gmail e
// Yahoo degradam ou recusam a entrega de remetentes em massa (regra em vigor desde 2024)
// — ou seja, isto nao e cortesia com o destinatario, e requisito de ENTREGABILIDADE.
//
// A URL sai de lib/descadastro.montarUrlDescadastro (Incremento 2), entao o link do
// cabecalho e exatamente o mesmo do rodape do e-mail, assinado com o mesmo HMAC. LANCA
// se DESCADASTRO_SECRET faltar — de novo, falhar ANTES do envio, porque um e-mail de
// campanha sem opt-out valido e pior do que um e-mail nao enviado.
//
// `List-Unsubscribe-Post` e o que habilita o One-Click: o CLIENTE DE E-MAIL faz um POST
// direto nessa URL, sem abrir pagina e sem corpo de formulario. Por isso o handler
// POST /descadastro le `e`/`t` tambem da query string (ver routes/pages.js).
function cabecalhosDescadastro(destinatario) {
  const url = montarUrlDescadastro(destinatario, config.baseUrl);
  return {
    'List-Unsubscribe': `<${url}>`,
    'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
  };
}

// Cabecalhos finais da mensagem: os de descadastro POR PADRAO, mais os que o chamador
// tenha passado.
//
// A inclusao e automatica de proposito. Se dependesse de quem chama lembrar de passar
// `headers: cabecalhosDescadastro(email)`, um esquecimento produziria uma campanha
// entregue SEM opt-out valido — e o sintoma disso nao e um erro, e queda de entrega
// semanas depois, com o dominio ja marcado. O caminho seguro tem que ser o default.
//
// PRECEDENCIA: o que o chamador passou SEMPRE vence (o spread dos informados vem por
// ultimo). Se alguem definiu 'List-Unsubscribe' na mao, foi de proposito e nao cabe a
// este modulo sobrescrever. Observacao consciente: nesse caso o
// 'List-Unsubscribe-Post' automatico continua valendo junto com a URL do chamador —
// quem trocar a URL por uma que NAO aceite POST precisa passar tambem o
// 'List-Unsubscribe-Post' (ou omiti-lo via semDescadastro), porque anunciar One-Click
// numa URL que nao o suporta e pior do que nao anunciar.
//
// semDescadastro: VALVULA DE ESCAPE, nao caminho esperado. Este adaptador existe para
// CAMPANHA, e campanha sem opt-out nao deveria sair — hoje nao ha no projeto um unico
// cenario legitimo para isto. Existe para o caso de um dia haver (ex.: uma mensagem
// operacional a uma lista interna que ja tem outro mecanismo de saida), e para que esse
// dia exija uma decisao EXPLICITA e visivel no call site, em vez de um header faltando
// silenciosamente.
function montarCabecalhos(destinatario, opcoes) {
  const informados = opcoes.headers || {};
  if (opcoes.semDescadastro === true) return informados;
  // cabecalhosDescadastro LANCA se DESCADASTRO_SECRET faltar. Isso agora barra TODA
  // tentativa de envio de campanha sem descadastro configurado, e nao so as que
  // lembrassem de pedir o header — que e exatamente a intencao.
  return { ...cabecalhosDescadastro(destinatario), ...informados };
}

async function enviar(destinatario, assunto, html, opcoes = {}) {
  // Antes de qualquer coisa que custe conexao: sem destinatario nao ha o que enviar.
  if (!destinatario) {
    throw new Error('Destinatario de e-mail de campanha ausente.');
  }

  const cfg = config.provedores.emailCampanha;
  if (!cfg.remetente) {
    throw new Error(
      'SMTP_CAMPANHA_FROM_EMAIL ausente. Defina o remetente de campanha no .env ' +
        '(subdominio dedicado, verificado no provedor).',
    );
  }

  // Ponto de INJECAO, no mesmo espirito das deps injetaveis de lib/importar_vaga.js:
  // com um transporter fornecido, nada de config de credencial e exigido e nenhuma
  // conexao e aberta. E o que permite ao teste usar o jsonTransport do proprio
  // nodemailer, sem rede e sem dependencia nova.
  const transporter = opcoes.transporter || obterTransporter();

  const mensagem = {
    from: cfg.remetente,
    to: destinatario,
    subject: assunto,
    html,
  };
  if (opcoes.replyTo) mensagem.replyTo = opcoes.replyTo;

  // Depois do transporter de proposito: com credencial faltando, o erro que interessa e
  // o da credencial, nao o do descadastro. So entra na mensagem se houver algo (com
  // semDescadastro e sem headers proprios, o campo nem aparece).
  const headers = montarCabecalhos(destinatario, opcoes);
  if (Object.keys(headers).length) mensagem.headers = headers;

  let info;
  try {
    info = await transporter.sendMail(mensagem);
  } catch (err) {
    throw new Error(
      `Falha ao enviar e-mail de campanha via SMTP: ${String(err && err.message).slice(0, MAX_DETALHE_ERRO)}`,
    );
  }

  return { id: (info && info.messageId) || null };
}

module.exports = {
  enviar,
  cabecalhosDescadastro,
  criarTransporter,
};
