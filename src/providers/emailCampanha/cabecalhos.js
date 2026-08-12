'use strict';

// Cabecalhos de opt-out do e-mail de CAMPANHA (RFC 8058), compartilhados por todos os
// transportes.
//
// ── POR QUE ESTE ARQUIVO EXISTE AGORA ──
// Estas duas funcoes nasceram dentro de ./smtp.js, quando ele era o unico transporte, e o
// adaptador de API REST passou a importa-las de la — o proprio smtp.js registrava, no
// export, que "se um terceiro transporte aparecer, o movimento certo e extrair
// montarCabecalhos + cabecalhosDescadastro para um ./cabecalhos.js compartilhado; com
// dois, isso seria cerimonia sem ganho".
//
// O terceiro transporte chegou (ZeptoMail), e com ele o motivo pratico: o SMTP vai SAIR do
// projeto, e deixar a regra de opt-out morando no modulo que sera removido faria a saida
// dele levar junto a unica implementacao de List-Unsubscribe do sistema.
//
// A regra de opt-out e do DOMINIO "e-mail de campanha", nao de nenhum transporte em
// particular. Este arquivo e o lugar onde isso fica dito por estrutura, e nao so por
// comentario: quem escrever o quarto transporte importa daqui sem precisar saber que um
// dia isso morou no SMTP.

const { config } = require('../../config');
const { montarUrlDescadastro } = require('../../lib/descadastro');

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
// semDescadastro: VALVULA DE ESCAPE, nao caminho esperado. Este subsistema existe para
// CAMPANHA, e campanha sem opt-out nao deveria sair — hoje nao ha no projeto um unico
// cenario legitimo para isto. Existe para o caso de um dia haver (ex.: uma mensagem
// operacional a uma lista interna que ja tem outro mecanismo de saida), e para que esse
// dia exija uma decisao EXPLICITA e visivel no call site, em vez de um header faltando
// silenciosamente.
//
// ── O FORMATO DE SAIDA E OBJETO PLANO, e cada transporte o acomoda ──
// SMTP e a API do Emailit consomem isto como `headers`; o ZeptoMail chama o mesmo campo de
// `mime_headers`. A diferenca e de envelope, nao de conteudo — por isso a traducao mora em
// cada adaptador, e nao aqui.
function montarCabecalhos(destinatario, opcoes) {
  const informados = (opcoes && opcoes.headers) || {};
  if (opcoes && opcoes.semDescadastro === true) return informados;
  // cabecalhosDescadastro LANCA se DESCADASTRO_SECRET faltar. Isso barra TODA tentativa de
  // envio de campanha sem descadastro configurado, e nao so as que lembrassem de pedir o
  // header — que e exatamente a intencao.
  return { ...cabecalhosDescadastro(destinatario), ...informados };
}

module.exports = { cabecalhosDescadastro, montarCabecalhos };
