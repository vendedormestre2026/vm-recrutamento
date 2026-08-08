'use strict';

// Renderizacao de paginas no servidor (sem framework de view).
// Monta o HTML base na identidade Vendedor Mestre: fontes Barlow via Google Fonts,
// tokens.css + base.css, cabecalho com logo e, quando pedido, barra de progresso
// e orbe do agente. As paginas de Fase 0 sao placeholders dentro deste layout.

const fs = require('node:fs');
const path = require('node:path');
const { config } = require('./config');

const PARTIALS_DIR = path.join(__dirname, '..', 'public', 'partials');

// Carrega os parciais uma vez no boot (sao pequenos e estaticos).
function carregarParcial(nome) {
  return fs.readFileSync(path.join(PARTIALS_DIR, `${nome}.html`), 'utf8');
}
const PARCIAIS = {
  header: carregarParcial('header'),
  progress: carregarParcial('progress'),
  orb: carregarParcial('orb'),
};

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// ── Rastreio (GTM / Meta Pixel) ──
// Snippets padrao injetados APENAS quando o id existe no .env (config.rastreio).
// Mantemos so caracteres seguros do id (whitelist) para nao quebrar o <script>
// inline. So pageview automatico — sem eventos custom nesta fase.
function idRastreioSeguro(valor) {
  return String(valor || '').replace(/[^A-Za-z0-9_-]/g, '');
}

// GTM: parte do <head> (inicializa o dataLayer e carrega o gtm.js).
function snippetGtmHead(id) {
  const gid = idRastreioSeguro(id);
  if (!gid) return '';
  return `
  <!-- Google Tag Manager -->
  <script>(function(w,d,s,l,i){w[l]=w[l]||[];w[l].push({'gtm.start':
  new Date().getTime(),event:'gtm.js'});var f=d.getElementsByTagName(s)[0],
  j=d.createElement(s),dl=l!='dataLayer'?'&l='+l:'';j.async=true;j.src=
  'https://www.googletagmanager.com/gtm.js?id='+i+dl;f.parentNode.insertBefore(j,f);
  })(window,document,'script','dataLayer','${gid}');</script>
  <!-- End Google Tag Manager -->`;
}

// GTM: <noscript> logo apos abrir o <body>.
function snippetGtmBody(id) {
  const gid = idRastreioSeguro(id);
  if (!gid) return '';
  return `
  <!-- Google Tag Manager (noscript) -->
  <noscript><iframe src="https://www.googletagmanager.com/ns.html?id=${gid}"
  height="0" width="0" style="display:none;visibility:hidden"></iframe></noscript>
  <!-- End Google Tag Manager (noscript) -->`;
}

// Meta Pixel: codigo base com PageView automatico (script + noscript no <head>).
function snippetMetaPixel(id) {
  const pid = idRastreioSeguro(id);
  if (!pid) return '';
  return `
  <!-- Meta Pixel Code -->
  <script>
  !function(f,b,e,v,n,t,s)
  {if(f.fbq)return;n=f.fbq=function(){n.callMethod?
  n.callMethod.apply(n,arguments):n.queue.push(arguments)};
  if(!f._fbq)f._fbq=n;n.push=n;n.loaded=!0;n.version='2.0';
  n.queue=[];t=b.createElement(e);t.async=!0;
  t.src=v;s=b.getElementsByTagName(e)[0];
  s.parentNode.insertBefore(t,s)}(window, document,'script',
  'https://connect.facebook.net/en_US/fbevents.js');
  fbq('init', '${pid}');
  fbq('track', 'PageView');
  </script>
  <noscript><img height="1" width="1" style="display:none"
  src="https://www.facebook.com/tr?id=${pid}&ev=PageView&noscript=1"/></noscript>
  <!-- End Meta Pixel Code -->`;
}

// Substituicao simples de tokens {{CHAVE}} num template.
function preencher(template, dados) {
  return template.replace(/\{\{(\w+)\}\}/g, (_, chave) =>
    dados[chave] != null ? String(dados[chave]) : '',
  );
}

// As 4 macro-etapas do funil (nao usamos o "1/3" do micro1).
const ETAPAS_FUNIL = ['Aplicacao', 'Preparacao', 'Verificacao', 'Entrevista'];

// Renderiza a barra de progresso segmentada para a etapa atual (1..4).
function barraFunil(etapaAtual) {
  const segmentos = ETAPAS_FUNIL.map((nome, i) => {
    const numero = i + 1;
    let estado = 'futura';
    if (numero < etapaAtual) estado = 'concluida';
    else if (numero === etapaAtual) estado = 'atual';
    const aria = numero === etapaAtual ? ' aria-current="step"' : '';
    return `<li class="vm-funil__etapa vm-funil__etapa--${estado}"${aria}>
        <span class="vm-funil__barra"></span>
        <span class="vm-funil__rotulo"><b>${numero}</b> ${escapeHtml(nome)}</span>
      </li>`;
  }).join('');
  return preencher(PARCIAIS.progress, { SEGMENTOS: segmentos });
}

// Layout completo de uma pagina.
//   opcoes: { titulo, conteudo, tema: 'claro'|'escuro', etapa?:1..4, comOrbe?:bool,
//             semRastreio?:bool }
//
// semRastreio (default false, entao NENHUM call site existente muda de comportamento):
// suprime GTM e Meta Pixel nesta pagina. Existe para as telas de exercicio de direito do
// titular — hoje o descadastro (routes/pages.js) —, alcancadas por link de e-mail: seria
// incoerente carregar rastreio de terceiros exatamente na pagina em que a pessoa pede
// para parar de ser contactada. Nao e preferencia estetica; nao remova sem trocar por
// outra garantia equivalente.
function pagina({
  titulo,
  conteudo,
  tema = 'claro',
  etapa = null,
  comOrbe = false,
  semRastreio = false,
}) {
  const classeTema = tema === 'escuro' ? 'tema-escuro' : 'tema-claro';
  const tituloPagina = titulo ? `${titulo} · Vendedor Mestre` : 'Vendedor Mestre';

  // Resolvidos aqui (e nao inline no template) para que os TRES pontos de injecao —
  // head do GTM, pixel e noscript do GTM — sejam governados pela mesma decisao. Inline,
  // seria facil suprimir dois e esquecer o terceiro.
  const gtmHead = semRastreio ? '' : snippetGtmHead(config.rastreio.gtmId);
  const metaPixel = semRastreio ? '' : snippetMetaPixel(config.rastreio.metaPixelId);
  const gtmBody = semRastreio ? '' : snippetGtmBody(config.rastreio.gtmId);

  return `<!doctype html>
<html lang="pt-BR" class="${classeTema}">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="theme-color" content="#F4F3F1">${gtmHead}${metaPixel}
  <title>${escapeHtml(tituloPagina)}</title>
  <meta name="description" content="Recrutamento de vendedores - entrevista com a agente ${escapeHtml(config.agente.nome)}.">
  <link rel="icon" href="/assets/favicon.svg" type="image/svg+xml">
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Barlow:wght@400;500;600&family=Barlow+Condensed:wght@700;900&family=DM+Mono:wght@400;500&display=swap" rel="stylesheet">
  <link rel="stylesheet" href="/css/tokens.css">
  <link rel="stylesheet" href="/css/base.css">
</head>
<body>${gtmBody}
  ${PARCIAIS.header}
  ${etapa ? barraFunil(etapa) : ''}
  <main class="vm-main">
    <div class="vm-container">
      ${comOrbe ? PARCIAIS.orb : ''}
      ${conteudo}
    </div>
  </main>
  <footer class="vm-footer">
    <span>Vendedor Mestre · Recrutamento</span>
  </footer>
  <script src="/js/app.js" defer></script>
</body>
</html>`;
}

module.exports = { pagina, escapeHtml };
