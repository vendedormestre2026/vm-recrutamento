'use strict';

// Montagem do e-mail de campanha (Promocao de Vagas): a moldura fixa em volta do texto
// gerado, o link de candidatura (o "call to action") e a URL da vaga com UTM.
//
// ── O BURACO QUE ISTO FECHA ──
// O Incremento 6 decidiu que o LLM NAO escreve a URL da vaga (evita alucinacao de link e
// mantem o endereco sob controle do codigo), com a promessa de que "o link e inserido
// depois, fora do texto gerado". Nenhum incremento seguinte implementou esse "depois".
// Resultado em producao: e-mails que CONVIDAM a pessoa a se candidatar e nao trazem
// endereco nenhum — descoberto no primeiro envio de teste real, inspecionando o HTML bruto.
// Este modulo e o "depois".
//
// ── POR QUE /vaga/:slug E NAO /aplicar/:slug ──
// Nao e preferencia de UX: e a unica das duas que FUNCIONA para atribuicao. A captura de
// UTM acontece SO no handler de /vaga/:slug (routes/pages.js) — ele le a query, grava o
// cookie `vm_utm` (first-touch) e registra o acesso no funil. O comentario de la diz, com
// todas as letras, que "o cookie sobrevive ao hop /vaga -> /aplicar e e lido no POST
// /api/aplicacao". O handler de /aplicar/:slug nao tem UMA LINHA de UTM.
//
// Ou seja: apontar a campanha direto para /aplicar/:slug carregaria o ?utm_source=email na
// URL e o JOGARIA FORA — o cookie nunca seria gravado e a candidatura entraria como
// 'direto'. A campanha ficaria invisivel exatamente no relatorio que ela precisa alimentar.
// Como bonus, /vaga/:slug e a escolha certa pelo funil tambem: quem recebe um e-mail nao
// solicitado precisa ler a descricao antes de decidir, e o acesso vira metrica de topo.
//
// ── MODULO PROPRIO, e nao dentro de promocaoVagas.js ──
// promocaoVagas.js e o motor de PUBLICO (quem recebe). Isto e montagem de MENSAGEM (o que
// a pessoa recebe) — outra pergunta. Mesmo criterio que ja separa lib/descadastro.js, que
// tambem monta uma URL assinada para dentro do e-mail e vive sozinho.
//
// ── A FRONTEIRA LLM x MOLDURA, que este arquivo materializa ──
// O LLM escreve TEXTO e nada mais: o prompt em lib/gerarSugestaoPromocao.js o proibe de
// escrever CSS, tabela, imagem, cor, fonte, a URL da vaga e rodape de descadastro. Tudo
// isso — estrutura, identidade visual, botao e opt-out — e responsabilidade DAQUI, e a
// divisao nao e estetica: o corpo gerado e revisavel e reescrevivel pelo Jean a qualquer
// momento, e nada que dependa de correcao (o link certo, o descadastro valido) pode morar
// num campo que uma edicao distraida apaga.

const { config } = require('../config');
const { escapeHtml } = require('../views');
const marca = require('./marcaEmail');

// A UNICA UTM que a campanha carrega. Decisao explicita do Rafael: so `utm_source`, sem
// medium nem campaign. O painel ja sabe ler isso sem mudanca nenhuma — origemCanonica() e
// listarOrigensDistintas() trabalham sobre applications.utm_source, entao 'email' passa a
// aparecer no filtro de Origem sozinho, assim que a primeira candidatura chegar.
const UTM_SOURCE_CAMPANHA = 'email';

// Texto do botao e do rodape, em constantes: sao o conteudo FIXO da moldura, e ter os tres
// juntos aqui em cima deixa obvio o que um e-mail de campanha diz alem do texto do LLM.
//
// O rotulo do botao vai JA EM MAIUSCULAS na string, e nao so via `text-transform` no CSS.
// O motivo esta documentado em marcaEmail.estiloTitulo: o motor do Word que renderiza o
// Outlook desktop tem suporte irregular a essa propriedade, entao confiar so nela deixaria
// o botao em caixa baixa justamente no cliente mais teimoso. Com o texto ja em caixa alta,
// o CSS vira redundancia barata em vez de unica linha de defesa.
const TEXTO_BOTAO_CTA = 'VER A VAGA E ME CANDIDATAR';
const TITULO_CABECALHO = 'VENDEDOR MESTRE';
const TEXTO_RODAPE =
  'Você recebeu este e-mail porque se candidatou a uma vaga do Vendedor Mestre ou faz ' +
  'parte do nosso banco de talentos.';
const TEXTO_LINK_DESCADASTRO = 'Não quero mais receber divulgação de vagas';

// URL publica da vaga, com a UTM anexada.
//
// `new URL` em vez de concatenar string: ele resolve o encode do path e cuida do separador
// (`?` vs `&`) sem que este modulo precise reimplementar query string. Hoje a URL nunca tem
// outro parametro, mas montar isso a mao e o tipo de coisa que quebra em silencio no dia em
// que passar a ter.
//
// Devolve '' quando nao ha slug: e o caso de vaga removida (ver o LEFT JOIN em
// listarEnviosPendentesCampanha). Sem endereco nao ha link, e blocoCta trata isso.
function montarUrlVaga(slug, baseUrl = config.baseUrl) {
  const s = String(slug || '').trim();
  if (!s) return '';

  const url = new URL(`/vaga/${encodeURIComponent(s)}`, String(baseUrl || '').replace(/\/+$/, '') + '/');
  url.searchParams.set('utm_source', UTM_SOURCE_CAMPANHA);
  return url.toString();
}

// ──────────────────────────────────────────────────────────────
// Pecas da moldura
// ──────────────────────────────────────────────────────────────

// O bloco do botao de candidatura.
//
// ── POR QUE BLOCO FIXO, e nao um placeholder tipo {{LINK_VAGA}} no texto do LLM ──
// A alternativa do placeholder e mais flexivel (o link poderia aparecer no meio do texto),
// mas depende de alguem LEMBRAR de escreve-lo: o LLM teria que gera-lo sempre, e o Jean
// teria que nao apaga-lo ao editar nem esquece-lo ao escrever a mao. O custo desse tipo de
// "depende de lembrar" ja foi medido na pratica — foi exatamente assim que o link sumiu por
// tres incrementos. Aqui o link e garantido por CODIGO: nao ha caminho de esquecimento,
// porque nao ha nada a lembrar.
//
// ── A TABELA DE UMA CELULA EM VOLTA DO <a> ──
// Nao e enfeite estrutural: o Outlook desktop IGNORA `padding` em elemento inline, entao o
// botao estilizado so no <a> viraria la um texto laranja solto sobre o fundo preto. Com o
// <td bgcolor> por tras, quem ignora o padding ainda ve um bloco laranja legivel. E o
// mesmo motivo de o `bgcolor` aparecer como ATRIBUTO alem do `style`.
//
// ── LIMITACAO CONHECIDA E ACEITA: NAO detecta link duplicado ──
// Se o Jean escrever o proprio link para a MESMA vaga no corpo, o e-mail sai com dois
// caminhos para o mesmo lugar. Detectar isso exigiria varrer o HTML procurando ancoras,
// normalizar URLs (com e sem UTM, com e sem barra final, absolutas e relativas) e decidir
// qual remover — complexidade desproporcional a um incomodo estetico, num corpo que e HTML
// livre. Dois links para a vaga certa e um resultado aceitavel; nenhum link, que era o
// estado anterior, nao era.
//
// Devolve '' sem URL (vaga removida). Um e-mail sem botao e ruim; um botao com
// <a href=""> e pior, porque parece funcional e leva a lugar nenhum.
function blocoCta(urlVaga) {
  const url = String(urlVaga || '').trim();
  if (!url) return '';

  // escapeHtml no href: o `&` de uma query com mais de um parametro precisa virar `&amp;`
  // dentro de atributo HTML. Hoje so ha um parametro e nao ha `&`, mas o dia em que houver
  // nao pode depender de alguem lembrar de escapar aqui.
  return [
    '<tr>',
    '<td style="padding:20px 0 24px;">',
    '<table role="presentation" cellpadding="0" cellspacing="0" border="0">',
    '<tr>',
    `<td bgcolor="${marca.LARANJA}" style="border-radius:8px;">`,
    `<a href="${escapeHtml(url)}" style="${marca.estiloBotaoCta()}">${TEXTO_BOTAO_CTA}</a>`,
    '</td>',
    '</tr>',
    '</table>',
    '</td>',
    '</tr>',
  ].join('\n');
}

// O rodape: por que a pessoa recebeu isto, e como sair.
//
// ── O LINK VISIVEL E NOVO, e o header List-Unsubscribe CONTINUA COMO ESTAVA ──
// Ate aqui o opt-out existia SO no cabecalho List-Unsubscribe (providers/emailCampanha/
// smtp.js), que e requisito de entregabilidade mas depende de o cliente de e-mail
// renderizar o botao "cancelar inscricao". Quem abre a mensagem num cliente que nao o faz
// nao tinha caminho de saida nenhum — e quem nao consegue sair de uma lista marca como
// spam, que atinge a reputacao do dominio. Os dois caminhos agora coexistem, e de
// proposito apontam para a MESMA URL: quem chama passa aqui exatamente o que
// montarUrlDescadastro devolveu, a mesma funcao que monta o cabecalho.
//
// Sem URL o link some, mas o texto explicativo FICA. Isso nao deve acontecer (o pre-voo do
// disparo garante que montarUrlDescadastro funciona antes de qualquer envio, e o adaptador
// lanca se o segredo faltar), e a degradacao existe so para nunca emitirmos <a href="">.
function blocoRodape(urlDescadastro) {
  const url = String(urlDescadastro || '').trim();

  const linkDescadastro = url
    ? `<p style="${marca.estiloRodape()}padding-top:10px;">` +
      `<a href="${escapeHtml(url)}" style="${marca.estiloLinkRodape()}">${TEXTO_LINK_DESCADASTRO}</a>` +
      '</p>'
    : '';

  return [
    '<tr>',
    '<td style="padding:18px 0 0;">',
    `<p style="${marca.estiloRodape()}">${TEXTO_RODAPE}</p>`,
    linkDescadastro,
    '</td>',
    '</tr>',
  ].join('\n');
}

// ──────────────────────────────────────────────────────────────
// A moldura completa
// ──────────────────────────────────────────────────────────────

// Monta o HTML final do e-mail: cabecalho da marca, o texto do LLM, o botao e o rodape.
//
// ── PARAMETRO NOMEADO, e nao tres strings posicionais ──
// `corpoHtml`, `urlVaga` e `urlDescadastro` sao todas string, e duas delas sao URL. Numa
// assinatura posicional, trocar urlVaga por urlDescadastro compila, roda, passa em teste de
// fumaca e manda a base inteira para a pagina de descadastro achando que e a vaga. O objeto
// nomeado torna esse erro impossivel de cometer em silencio.
//
// ── <table> AQUI, <div> NOS OUTROS QUATRO E-MAILS ──
// Divergencia deliberada e limitada a este e-mail. Os e-mails do funil (followup, lembrete,
// recusa, retomada) sao <div> com max-width, funcionam e nao serao tocados. A campanha
// ganha <table> porque e a unica que vai para uma base grande e desconhecida: os outros
// quatro chegam a quem esta no meio de um processo seletivo e vai abrir de qualquer jeito,
// enquanto aqui uma renderizacao quebrada no Outlook desktop e um e-mail nao solicitado que
// vira spam. Onde o publico e escolhido, <div> basta; onde ele e a base inteira, nao.
//
// Fragmento (comeca em <table>), sem <!DOCTYPE>/<html>/<head> — igual aos outros quatro.
// O charset vem do cabecalho MIME do proprio envio, e e por isso que os acentos ja
// funcionam hoje sem nenhuma <meta> no corpo.
function montarEmailCampanha({ corpoHtml, urlVaga, urlDescadastro } = {}) {
  // O corpo do LLM entra CRU, exatamente como esta no banco. Nao ha sanitizacao nem
  // reescrita: e HTML que o Jean pode ter escrito ou editado a mao, e mexer nele com regex
  // (para injetar style nos <p>, por exemplo) quebraria no primeiro caso torto. A
  // tipografia chega nele por HERANCA, pelo style do <td> que o hospeda — ver a nota em
  // marcaEmail.estiloConteudo.
  const corpo = String(corpoHtml == null ? '' : corpoHtml);

  return [
    `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="${marca.PRETO}" style="background:${marca.PRETO};width:100%;">`,
    '<tr>',
    `<td align="center" style="${marca.estiloFundo()}">`,
    `<table role="presentation" width="${marca.LARGURA_MAX}" cellpadding="0" cellspacing="0" border="0" align="center" style="${marca.estiloMoldura()}">`,

    // ── Cabecalho ──
    '<tr>',
    // margemBaixo:0 no titulo — o espaco ate o fio vem do padding do <td>, e somar os dois
    // daria um respiro de 30px que nao foi decidido por ninguem.
    `<td style="padding:0 0 14px;"><p style="${marca.estiloTitulo({ margemBaixo: 0 })}">${TITULO_CABECALHO}</p></td>`,
    '</tr>',
    `<tr><td style="${marca.estiloSeparador()}">&nbsp;</td></tr>`,

    // ── Conteudo gerado (a unica parte que o LLM controla) ──
    '<tr>',
    `<td style="${marca.estiloConteudo()}padding:22px 0 0;">`,
    corpo,
    '</td>',
    '</tr>',

    // ── Botao ──
    blocoCta(urlVaga),

    // ── Rodape ──
    `<tr><td style="${marca.estiloSeparador()}">&nbsp;</td></tr>`,
    blocoRodape(urlDescadastro),

    '</table>',
    '</td>',
    '</tr>',
    '</table>',
  ]
    .filter(Boolean) // blocoCta devolve '' quando a vaga foi removida
    .join('\n');
}

// Atalho para quem tem o slug, o corpo e a URL de descadastro: monta a URL da vaga e ja
// devolve o e-mail inteiro. E o que os DOIS caminhos de envio chamam (a varredura do
// disparo real e o botao de e-mail de teste), e existir como funcao unica e o que garante
// que os dois produzam o MESMO e-mail — se cada um montasse o seu, o botao de teste
// deixaria de testar o que sera enviado de verdade.
//
// ── POR QUE `urlDescadastro` PRONTA, e nao o e-mail do destinatario ──
// Este modulo nao deve saber quem recebe. Ele monta MENSAGEM; identidade do destinatario e
// assunto de quem envia. Passar o e-mail aqui obrigaria a importar lib/descadastro e a
// calcular o HMAC dentro da montagem — e entao existiriam dois lugares no projeto capazes
// de gerar link de descadastro (aqui e o adaptador de envio), que e exatamente como as duas
// URLs comecariam a divergir. Recebendo a URL pronta, o link do rodape e byte a byte o
// mesmo do cabecalho List-Unsubscribe, porque literalmente veio da mesma chamada.
function montarCorpoFinal(corpoHtml, slug, urlDescadastro, baseUrl = config.baseUrl) {
  return montarEmailCampanha({
    corpoHtml,
    urlVaga: montarUrlVaga(slug, baseUrl),
    urlDescadastro,
  });
}

module.exports = {
  montarUrlVaga,
  montarEmailCampanha,
  montarCorpoFinal,
  blocoCta,
  blocoRodape,
  UTM_SOURCE_CAMPANHA,
  TEXTO_BOTAO_CTA,
  TITULO_CABECALHO,
  TEXTO_LINK_DESCADASTRO,
};
