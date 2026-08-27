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

// Origem dos links da campanha por WhatsApp. Valor novo no painel: nao ha enum fechado de
// utm_source (a coluna e TEXT livre e listarOrigensDistintas deriva dos dados), entao ele
// aparece sozinho no filtro assim que a primeira candidatura chegar por aqui.
const UTM_SOURCE_WHATSAPP = 'whatsapp';

// Texto do botao e do rodape, em constantes: sao o conteudo FIXO da moldura, e ter os tres
// juntos aqui em cima deixa obvio o que um e-mail de campanha diz alem do texto do LLM.
//
// O rotulo do botao vai JA EM MAIUSCULAS na string, e nao so via `text-transform` no CSS.
// O motivo esta documentado em marcaEmail.estiloTitulo: o motor do Word que renderiza o
// Outlook desktop tem suporte irregular a essa propriedade, entao confiar so nela deixaria
// o botao em caixa baixa justamente no cliente mais teimoso. Com o texto ja em caixa alta,
// o CSS vira redundancia barata em vez de unica linha de defesa.
const TEXTO_BOTAO_CTA = 'VER A VAGA E ME CANDIDATAR';

// Botao da campanha tipo 'convite_grupo' (Promocao de Vagas — campanha de grupo, e-mail).
// Mesma disciplina de TEXTO_BOTAO_CTA (ja em maiusculas na string, ver o comentario dela).
const TEXTO_BOTAO_CTA_GRUPO = 'ENTRAR NO GRUPO';

// A marca, agora em papel de APOIO (11px) e nao de manchete (era 26px laranja, o maior
// elemento do e-mail). Ver a justificativa em marcaEmail.estiloEyebrow: quem abre uma
// divulgacao precisa saber em dois segundos QUAL VAGA e — o remetente e contexto.
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
// ── PARAMETROS NOMEADOS a partir do segundo ──
// A funcao ganhou `campanhaId` e ja tinha `baseUrl`, os dois opcionais. Como posicionais,
// `montarUrlVaga(slug, 7)` e `montarUrlVaga(slug, 'https://...')` seriam indistinguiveis
// para quem le, e trocar a ordem passaria em qualquer teste de fumaca.
// ── `utmSource` e `campanhaWhatsappId` foram acrescentados para a campanha por WhatsApp ──
//
// `utmSource` tem DEFAULT igual a constante de sempre: nenhum call site de e-mail muda de
// comportamento, e a unica forma de o link sair com outra origem e alguem pedir
// explicitamente. Era a alternativa a duplicar esta funcao — e duas versoes da mesma regra de
// montagem de URL divergiriam no primeiro ajuste.
//
// `campanhaWhatsappId` e parametro SEPARADO de `campanhaId`, e nao um reuso: as duas
// campanhas moram em tabelas diferentes com ids independentes. Passar o id de uma campanha de
// WhatsApp como `campanhaId` gravaria em vaga_acessos.campanha_id um numero que casa com a
// campanha de E-MAIL de mesmo id — atribuindo o clique a campanha errada, sem erro nenhum.
function montarUrlVaga(
  slug,
  { campanhaId, campanhaWhatsappId, utmSource = UTM_SOURCE_CAMPANHA, baseUrl = config.baseUrl } = {},
) {
  const s = String(slug || '').trim();
  if (!s) return '';

  const url = new URL(`/vaga/${encodeURIComponent(s)}`, String(baseUrl || '').replace(/\/+$/, '') + '/');
  url.searchParams.set('utm_source', String(utmSource || UTM_SOURCE_CAMPANHA));

  // `campanha_id` e o que permite contar cliques POR CAMPANHA, e nao "acessos com
  // utm_source=email no periodo". A diferenca aparece no dia em que duas campanhas
  // divulgarem a MESMA vaga na mesma semana: pela UTM os cliques cairiam num balde so,
  // sem nada na tela avisando que o numero e a soma das duas.
  //
  // So entra quando ha um id valido: um `campanha_id=` vazio ou `campanha_id=abc` na URL
  // seria ruido no link e lixo no banco.
  const id = Number(campanhaId);
  if (Number.isInteger(id) && id > 0) url.searchParams.set('campanha_id', String(id));

  const idWa = Number(campanhaWhatsappId);
  if (Number.isInteger(idWa) && idWa > 0) url.searchParams.set('campanha_whatsapp_id', String(idWa));

  return url.toString();
}

// URL publica do GRUPO de uma praca (campanha tipo 'convite_grupo'), com campanha_id —
// mesmo padrao de montarUrlVaga, MAS SEM utm_source: GET /grupo/:slug (routes/pages.js)
// nunca leu UTM (o botao ja serve tanto o e-mail QUANTO o WhatsApp — ver
// providers/centralWhats/centralWhats.js:montarPayload/parametrosBotao — e nao faz parte
// do funil de candidatura que a UTM/cookie vm_utm cobrem) e nao deve passar a ler agora so
// porque um segundo chamador apareceu. `campanha_id` e o UNICO parametro de atribuicao —
// e o que db.registrarAcessoGrupo valida antes de gravar em grupo_acessos.
function montarUrlGrupo(slug, { campanhaId, baseUrl = config.baseUrl } = {}) {
  const s = String(slug || '').trim();
  if (!s) return '';

  const url = new URL(`/grupo/${encodeURIComponent(s)}`, String(baseUrl || '').replace(/\/+$/, '') + '/');

  const id = Number(campanhaId);
  if (Number.isInteger(id) && id > 0) url.searchParams.set('campanha_id', String(id));

  return url.toString();
}

// ──────────────────────────────────────────────────────────────
// Pecas da moldura
// ──────────────────────────────────────────────────────────────

// Capitaliza a primeira letra. Mesma funcao (e mesmo motivo) do `capitalizar` da landing
// /vaga/:slug: `modalidade` e gravada em minusculo no banco e exibida capitalizada.
function capitalizar(s) {
  const t = String(s == null ? '' : s).trim();
  return t ? t.charAt(0).toUpperCase() + t.slice(1) : '';
}

// Cabecalho da vaga: eyebrow da marca, kicker, titulo e os selos.
//
// ── E UMA TRADUCAO DA LANDING /vaga/:slug, NAO UM DESENHO NOVO ──
// A pagina da vaga ja resolveu este problema: kicker pequeno ("Vaga aberta · Perfil X"),
// titulo grande, e uma fileira de selos com os detalhes preenchidos (📍 endereco,
// 🏢 modalidade, 📄 regime, 🕐 horario). O e-mail passa a dizer a MESMA coisa na mesma
// ordem, para quem clica no botao nao sentir que chegou noutro lugar.
//
// ── filter(Boolean): CAMPO VAZIO NAO DEIXA BURACO ──
// Copiado literalmente da landing. `jobs` tem endereco, modalidade, regime, horario e
// empresa todos NULLABLE, e a densidade real deles e desconhecida. Selo so existe se o
// campo existir; uma vaga so com titulo renderiza um cabecalho enxuto, nao um cabecalho
// esburacado.
//
// ── SEM VAGA, degrada para so a marca ──
// `vaga` chega null quando a vaga foi removida (o LEFT JOIN de
// listarEnviosPendentesCampanha ja preve isso). O e-mail perde o cabecalho da vaga e
// mantem o resto — mesma degradacao visivel do bloco de CTA, que tambem some sem slug.
function blocoCabecalho(vaga) {
  const v = vaga || {};
  const titulo = String(v.titulo == null ? '' : v.titulo).trim();

  const eyebrow = `<p style="${marca.estiloEyebrow()}">${TITULO_CABECALHO}</p>`;

  if (!titulo) {
    return `<tr><td style="padding:0 0 14px;">${eyebrow}</td></tr>`;
  }

  // Kicker: "Vaga aberta · Perfil Closer". O perfil so entra se existir (e NOT NULL no
  // schema de jobs, mas a montagem nao pode depender disso — ela recebe um objeto).
  const perfil = String(v.perfil == null ? '' : v.perfil).trim();
  const kicker = perfil ? `Vaga aberta · Perfil ${perfil}` : 'Vaga aberta';

  // A empresa entra como PRIMEIRO selo, com 🏙: e a informacao que mais muda a decisao de
  // quem le ("para quem eu trabalharia?"), e a landing nao a mostra — a campanha vai alem
  // dela nesse ponto de proposito.
  const selos = [
    v.empresa ? ['🏙', v.empresa] : null,
    v.endereco ? ['📍', v.endereco] : null,
    v.modalidade ? ['🏢', capitalizar(v.modalidade)] : null,
    v.regime ? ['📄', v.regime] : null,
    v.horario ? ['🕐', v.horario] : null,
  ]
    .filter(Boolean)
    .map(([emoji, txt]) => `<span style="${marca.estiloSelo()}">${emoji} ${escapeHtml(String(txt).trim())}</span>`)
    .join('');

  return [
    '<tr>',
    '<td style="padding:0 0 16px;">',
    eyebrow,
    `<p style="${marca.estiloKicker()}">${escapeHtml(kicker)}</p>`,
    `<p style="${marca.estiloTituloVaga()}">${escapeHtml(titulo)}</p>`,
    selos ? `<div>${selos}</div>` : '',
    '</td>',
    '</tr>',
  ]
    .filter(Boolean)
    .join('\n');
}

// Cabecalho da campanha de GRUPO: eyebrow da marca + kicker "Convite de grupo" + a CIDADE
// como titulo — nao ha vaga pra mostrar (titulo/perfil/selos de blocoCabecalho nao se
// aplicam), mas a cidade e um dado barato de exibir e resolve o mesmo problema que
// blocoCabecalho existe pra resolver: "quem abre a mensagem precisa saber em dois segundos
// do que se trata", sem inflar o escopo (sem selos, sem campos opcionais de vaga).
//
// SEM CIDADE, degrada para so a marca — mesma forma de blocoCabecalho(null) pra vaga
// removida: `cidade` pode chegar vazia se a campanha foi criada sem uma (nao deveria
// acontecer — a rota valida isso na criacao — mas a funcao nao pode presumir).
function blocoCabecalhoGrupo(cidade) {
  const c = String(cidade == null ? '' : cidade).trim();
  const eyebrow = `<p style="${marca.estiloEyebrow()}">${TITULO_CABECALHO}</p>`;

  if (!c) {
    return `<tr><td style="padding:0 0 14px;">${eyebrow}</td></tr>`;
  }

  return [
    '<tr>',
    '<td style="padding:0 0 16px;">',
    eyebrow,
    `<p style="${marca.estiloKicker()}">Convite de grupo</p>`,
    `<p style="${marca.estiloTituloVaga()}">Vagas em ${escapeHtml(c)}</p>`,
    '</td>',
    '</tr>',
  ].join('\n');
}

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

// O bloco do botao "ENTRAR NO GRUPO" — mesmo padrao de blocoCta (tabela de 1 celula em
// volta do <a>, mesmo motivo do Outlook ignorar padding em inline), so com o texto e a URL
// do grupo. Devolve '' sem URL (praca sem slug configurado — mesma degradacao de blocoCta
// sem vaga: nenhum botao e melhor que um <a href=""> que parece funcional e nao leva a
// lugar nenhum).
function blocoCtaGrupo(urlGrupo) {
  const url = String(urlGrupo || '').trim();
  if (!url) return '';

  return [
    '<tr>',
    '<td style="padding:20px 0 24px;">',
    '<table role="presentation" cellpadding="0" cellspacing="0" border="0">',
    '<tr>',
    `<td bgcolor="${marca.LARANJA}" style="border-radius:8px;">`,
    `<a href="${escapeHtml(url)}" style="${marca.estiloBotaoCta()}">${TEXTO_BOTAO_CTA_GRUPO}</a>`,
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
function montarEmailCampanha({ corpoHtml, urlVaga, urlDescadastro, vaga } = {}) {
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

    // ── Cabecalho: marca discreta + a VAGA em destaque ──
    blocoCabecalho(vaga),
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
// ── POR QUE `vaga` INTEIRA, e nao mais so o slug ──
// O cabecalho passou a mostrar titulo, empresa, endereco, modalidade, regime e horario, e
// nenhum deles cabe num slug. Quem chama passa a linha de `jobs` que JA TEM em maos.
//
// ── OS DOIS CAMINHOS PRECISAM DA MESMA FONTE ──
// Esta assinatura muda os dois call sites de envio ao mesmo tempo, de proposito. O botao
// de teste ja carregava a vaga (db.obterVaga); a varredura de disparo passou a trazer os
// campos no proprio LEFT JOIN de listarEnviosPendentesCampanha. Se um dos dois montasse o
// cabecalho com dado diferente do outro, o teste deixaria de testar o e-mail real — que e
// exatamente o bug historico do link sumido, e o que o teste de igualdade byte a byte em
// promocaoIntegracao guarda.
//
// `vaga` opcional: sem ela o cabecalho degrada para so a marca, mesma degradacao visivel
// do bloco de CTA sem slug.
// `campanhaId` vem ANTES de `baseUrl` porque e o parametro que os call sites de verdade
// passam; baseUrl so e informado em teste. Os dois caminhos de envio o obtem do mesmo
// lugar em que ja obtem o corpo e a vaga — a linha da fila no disparo, a campanha em
// edicao no botao de teste (onde ele e null, ver a nota la).
function montarCorpoFinal(
  corpoHtml,
  slug,
  urlDescadastro,
  vaga = null,
  campanhaId = null,
  baseUrl = config.baseUrl,
) {
  return montarEmailCampanha({
    corpoHtml,
    urlVaga: montarUrlVaga(slug, { campanhaId, baseUrl }),
    urlDescadastro,
    vaga,
  });
}

// ──────────────────────────────────────────────────────────────
// A moldura completa — variante GRUPO
// ──────────────────────────────────────────────────────────────
//
// FUNCOES SEPARADAS (montarEmailCampanhaGrupo/montarCorpoFinalGrupo), e nao um parametro
// `tipo` dentro de montarEmailCampanha/montarCorpoFinal: os dois caminhos recebem dados de
// NATUREZA diferente — vaga inteira + urlVaga vs. cidade (string) + urlGrupo — e um `if`
// no meio da funcao existente obrigaria os DOIS conjuntos de parametros a conviverem na
// mesma assinatura, a maioria opcional e mutuamente exclusiva (vaga faz sentido sem
// cidade, cidade faz sentido sem vaga, nunca os dois). Funcoes distintas deixam cada
// contrato simples de ler sozinho — mesmo raciocinio que ja separa montarUrlVaga de
// montarUrlGrupo, acima.
function montarEmailCampanhaGrupo({ corpoHtml, urlGrupo, urlDescadastro, cidade } = {}) {
  const corpo = String(corpoHtml == null ? '' : corpoHtml);

  return [
    `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="${marca.PRETO}" style="background:${marca.PRETO};width:100%;">`,
    '<tr>',
    `<td align="center" style="${marca.estiloFundo()}">`,
    `<table role="presentation" width="${marca.LARGURA_MAX}" cellpadding="0" cellspacing="0" border="0" align="center" style="${marca.estiloMoldura()}">`,

    // ── Cabecalho: marca discreta + a CIDADE em destaque (sem vaga nenhuma aqui) ──
    blocoCabecalhoGrupo(cidade),
    `<tr><td style="${marca.estiloSeparador()}">&nbsp;</td></tr>`,

    // ── Conteudo gerado a mao pelo Jean (SEM sugestao de IA neste tipo, ver admin_promocao.js) ──
    '<tr>',
    `<td style="${marca.estiloConteudo()}padding:22px 0 0;">`,
    corpo,
    '</td>',
    '</tr>',

    // ── Botao ──
    blocoCtaGrupo(urlGrupo),

    // ── Rodape ──
    `<tr><td style="${marca.estiloSeparador()}">&nbsp;</td></tr>`,
    blocoRodape(urlDescadastro),

    '</table>',
    '</td>',
    '</tr>',
    '</table>',
  ]
    .filter(Boolean) // blocoCtaGrupo devolve '' quando a praca nao tem slug configurado
    .join('\n');
}

// Atalho, espelhando montarCorpoFinal: quem tem o slug do grupo, o corpo e a URL de
// descadastro monta a URL do grupo e ja devolve o e-mail inteiro. MESMA razao de existir
// de montarCorpoFinal — os dois caminhos de envio (varredura de disparo real e botao de
// e-mail de teste) precisam produzir BYTE A BYTE o mesmo e-mail.
function montarCorpoFinalGrupo(
  corpoHtml,
  slug,
  urlDescadastro,
  cidade = '',
  campanhaId = null,
  baseUrl = config.baseUrl,
) {
  return montarEmailCampanhaGrupo({
    corpoHtml,
    urlGrupo: montarUrlGrupo(slug, { campanhaId, baseUrl }),
    urlDescadastro,
    cidade,
  });
}

module.exports = {
  montarUrlVaga,
  montarUrlGrupo,
  montarEmailCampanha,
  montarEmailCampanhaGrupo,
  montarCorpoFinal,
  montarCorpoFinalGrupo,
  blocoCta,
  blocoCtaGrupo,
  blocoRodape,
  blocoCabecalho,
  blocoCabecalhoGrupo,
  UTM_SOURCE_CAMPANHA,
  UTM_SOURCE_WHATSAPP,
  TEXTO_BOTAO_CTA,
  TEXTO_BOTAO_CTA_GRUPO,
  TITULO_CABECALHO,
  TEXTO_LINK_DESCADASTRO,
};
