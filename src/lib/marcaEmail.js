'use strict';

// Identidade visual do e-mail de CAMPANHA (Promocao de Vagas), em CSS inline.
//
// ── POR QUE ESTE MODULO EXISTE ──
// Os quatro e-mails do funil (followupEntrevista, lembreteInicio, emailRecusa e o de
// retomada em routes/api.js) carregam a MESMA paleta hardcoded, cada um na sua copia:
// '#0D0B0A', '#FF5500', '#F4F3F1' e a lista de fontes aparecem literalmente nos quatro.
// Funciona, mas cada e-mail novo e uma quinta copia, e um ajuste de marca vira uma
// caca ao hex em quatro arquivos. Este modulo e a fonte unica — para o e-mail de
// campanha, que e o primeiro consumidor.
//
// ── ESCOPO DELIBERADAMENTE ESTREITO: SO E-MAIL ──
// Nao serve ao site (public/css/tokens.css e a fonte de verdade la, com custom properties
// que so existem no browser) nem ao PDF (lib/relatorioPdf.js tem as suas constantes, com
// nomes de fonte do pdfkit, que nao sao CSS). Os tres alvos falam linguagens diferentes:
// o browser tem `var(--vm-orange)`, o pdfkit tem `'Helvetica-Bold'`, e e-mail tem string
// de atributo `style`. Unificar os tres exigiria uma camada de traducao maior que a
// duplicacao que ela removeria.
//
// ── MODULO FOLHA, SEM NENHUM require ──
// Nao importa config, nem db, nem views. E o que permite que o template de e-mail o use
// sem arrastar dependencia, e que o teste o exercite sem montar ambiente. Se algum dia
// ele precisar de `config`, isso e sinal de que a coisa nova pertence a outro lugar.
//
// ── OS QUATRO E-MAILS EXISTENTES NAO IMPORTAM DAQUI, por ora ──
// Migra-los seria mexer em quatro caminhos que hoje funcionam, no mesmo commit em que a
// campanha muda de cara — misturando "formatacao nova" com "refactor". Eles ficam como
// estao; a migracao, se vier, e um commit proprio e sem risco de arrastar a campanha
// junto. Ate la a duplicacao continua, agora com um lugar obvio para onde convergir.

// ══════════════════════════════════════════════════════════════
// Cores
// ══════════════════════════════════════════════════════════════
//
// As MESMAS quatro de public/css/tokens.css, e so estas quatro. A regra da marca
// ("maximo 3 cores por tela; laranja e destaque, COM PARCIMONIA") vale aqui igual: o
// laranja aparece no titulo, no botao e no link do rodape — nada alem disso.
//
// NAO ha cinza de texto secundario de proposito, ainda que tokens.css tenha um
// (--vm-gray-mid). Num fundo preto, cinza medio cai perto do limite de contraste legivel
// em tela pequena, e o rodape ja se distingue do corpo pelo TAMANHO da fonte. Uma quinta
// cor so para "apagar" texto seria pagar contraste por hierarquia que o tamanho ja da.
const PRETO = '#0D0B0A'; // Preto Autoridade — fundo de todo o e-mail
const LARANJA = '#FF5500'; // Laranja Fogo — titulo, botao e link. Com parcimonia.
const OFFWHITE = '#F4F3F1'; // Off-White Limpo — texto corrido sobre o preto
const BRANCO = '#FFFFFF'; // auxiliar: fundo da area de leitura, quando houver

// ══════════════════════════════════════════════════════════════
// Fontes
// ══════════════════════════════════════════════════════════════
//
// ── POR QUE NAO CARREGAMOS BARLOW ──
// O site puxa Barlow e Barlow Condensed do Google Fonts (src/views.js:151-153), e isso
// NAO se traduz para e-mail: Gmail, Outlook e a maioria dos clientes descartam <link> e
// @import de fonte externa, quando nao removem a tag <style> inteira. Um e-mail que
// dependesse de fonte carregada renderizaria com a fonte default do cliente — Times New
// Roman no Outlook —, que e pior que o fallback escolhido.
//
// A lista abaixo e a MESMA dos quatro e-mails ja em producao, e a semantica e:
// se a pessoa tiver Barlow instalada localmente, usa; senao, Arial. Na pratica cai em
// Arial quase sempre, e e por isso que o desenho nao pode DEPENDER do Barlow.
const FONTE_CORPO = "'Barlow',Arial,Helvetica,sans-serif";

// ── O TITULO E UMA SIMULACAO, nao a fonte de verdade ──
// 'Barlow Condensed' abre a lista pelo mesmo motivo acima (se estiver instalada, otimo),
// mas o efeito visual nao pode contar com ela. Nao existe fonte condensada web-safe
// universal: Arial Narrow existe em Windows e macOS, mas falha em Android e Linux e
// degrada mal quando falha.
//
// A saida e a MESMA que lib/relatorioPdf.js ja usa no relatorio impresso, onde o pdfkit
// tambem so tem as fontes AFM basicas (relatorioPdf.js:29-30 e :110): negrito + CAIXA
// ALTA + espacamento entre letras. Nao e Barlow Condensed, mas carrega a mesma intencao
// — peso, autoridade, titulo que se le como bloco — com o que existe em todo lugar.
const FONTE_TITULO = "'Barlow Condensed','Barlow',Arial,Helvetica,sans-serif";

// Espacamento entre letras dos titulos. tokens.css usa .04em no logotipo e .03em nos
// h1-h3; ficamos no meio. Em caixa alta o letter-spacing nao e enfeite: sem ele, maiuscula
// sem serifa "fecha" e perde legibilidade em tamanho grande.
const ESPACAMENTO_TITULO = '0.04em';

// Largura util da moldura, em pixels.
//
// 600 e o numero convencional de e-mail (cabe no painel de leitura do Outlook desktop sem
// barra horizontal, e em tela de celular a tabela encolhe pelo max-width). Os outros
// quatro e-mails do sistema usam 520, mas eles sao <div> com max-width e conteudo curto;
// aqui a moldura e <table> e o corpo vem do LLM, com paragrafos de tamanho imprevisivel.
const LARGURA_MAX = 600;

// ══════════════════════════════════════════════════════════════
// Helpers de estilo
// ══════════════════════════════════════════════════════════════
//
// Cada um devolve a STRING que vai dentro de um atributo `style="..."`. Sao funcoes, e
// nao constantes, pelos poucos pontos em que o template precisa variar um valor (tamanho
// de fonte, margem final) sem reescrever a declaracao inteira — e porque uma funcao deixa
// o default no lugar onde ele e lido.
//
// Os valores sao SEMPRE absolutos (px), nunca relativos (em/rem) fora do letter-spacing:
// cliente de e-mail nao garante herança de font-size, entao `1.2em` pode significar coisas
// diferentes em dois clientes a partir do MESMO HTML.
//
// NENHUM helper emite `class`, `id` ou seletor: CSS em <style> e removido por parte dos
// clientes (Gmail no webmail o mantem, mas o app do Gmail para Android historicamente nao),
// e o unico estilo que sobrevive em todo lugar e o inline.

// Fundo de toda a mensagem — o <td> mais externo da tabela externa.
// O `background` vai TAMBEM como atributo `bgcolor` no template: Outlook desktop honra
// bgcolor com mais consistencia que background em alguns modos de renderizacao, e os dois
// juntos nao conflitam (bgcolor e o fallback, style vence quando ambos sao lidos).
function estiloFundo() {
  return `margin:0;padding:24px 12px;background:${PRETO};`;
}

// A moldura de largura fixa, centralizada. `width` tambem vai como atributo no <table>,
// pela mesma razao de bgcolor acima.
function estiloMoldura() {
  return `width:${LARGURA_MAX}px;max-width:100%;margin:0 auto;`;
}

// Titulo em caixa alta — o cabecalho da marca e, se um dia houver, subtitulos.
//
// `text-transform:uppercase` esta aqui por correcao, mas NAO se deve confiar nele: o
// motor do Word que renderiza o Outlook desktop tem suporte irregular a essa propriedade.
// Quem usar este helper deve escrever o texto JA em maiusculas na string — a propriedade
// vira redundancia barata, e nao a unica linha de defesa.
function estiloTitulo({ tamanho = 26, cor = LARANJA, margemBaixo = 16 } = {}) {
  return (
    `font-family:${FONTE_TITULO};font-weight:700;font-size:${tamanho}px;` +
    `line-height:1.2;letter-spacing:${ESPACAMENTO_TITULO};text-transform:uppercase;` +
    `color:${cor};margin:0 0 ${margemBaixo}px;`
  );
}

// "Eyebrow": a marca, agora em papel de apoio.
//
// ── POR QUE ELA ENCOLHEU ──
// Ate aqui o cabecalho era 'VENDEDOR MESTRE' em 26px laranja, o elemento de maior peso
// visual do e-mail inteiro. Isso invertia a prioridade: quem abre um e-mail de divulgacao
// precisa saber em dois segundos QUAL VAGA e — o nome de quem manda e contexto, nao
// manchete. Agora a marca e a menor coisa do bloco (11px) e o titulo da vaga e a maior.
//
// Mantem caixa alta e letter-spacing para continuar lendo como marca, nao como texto solto.
function estiloEyebrow() {
  return (
    `font-family:${FONTE_TITULO};font-weight:700;font-size:11px;line-height:1.2;` +
    `letter-spacing:0.12em;text-transform:uppercase;color:${LARANJA};margin:0 0 10px;`
  );
}

// Kicker: a linha de contexto acima do titulo ("Vaga aberta · Perfil Closer"). Copiado do
// `vm-kicker` da landing /vaga/:slug, que resolve o mesmo problema — dizer o que a pagina
// e antes de dizer o nome dela.
function estiloKicker() {
  return (
    `font-family:${FONTE_CORPO};font-size:12px;line-height:1.4;letter-spacing:0.06em;` +
    `text-transform:uppercase;color:${OFFWHITE};margin:0 0 6px;`
  );
}

// O titulo da VAGA — o elemento de maior peso do e-mail, e a razao de o eyebrow ter
// encolhido. Off-white e nao laranja: o laranja fica para o botao e para a marca, e um
// titulo laranja de 28px competiria com o CTA (a regra da marca e "laranja com parcimonia").
function estiloTituloVaga() {
  return (
    `font-family:${FONTE_TITULO};font-weight:700;font-size:28px;line-height:1.15;` +
    `letter-spacing:${ESPACAMENTO_TITULO};color:${OFFWHITE};margin:0 0 10px;`
  );
}

// Selo compacto (📍 local, 🏢 modalidade, 📄 regime, 🕐 horario, 🏙 empresa).
//
// Copiado do `vm-selo` da landing, com uma diferenca forcada pelo meio: la os selos sao
// flex numa div; aqui sao <span> inline-block dentro de um <td>, porque cliente de e-mail
// nao tem flexbox confiavel. O efeito visual e o mesmo — chips que quebram linha sozinhos.
//
// Borda em vez de fundo: um bloco preenchido a cada selo brigaria com o botao laranja. O
// contorno da a leitura de "etiqueta" sem pedir atencao.
function estiloSelo() {
  return (
    `display:inline-block;border:1px solid ${LARANJA};border-radius:4px;` +
    `font-family:${FONTE_CORPO};font-size:12px;line-height:1.4;color:${OFFWHITE};` +
    `padding:4px 9px;margin:0 6px 6px 0;`
  );
}

// O <td> que HOSPEDA o HTML vindo do LLM.
//
// ── ISTO E O QUE FAZ O CORPO GERADO HERDAR A IDENTIDADE ──
// O LLM entrega <p>, <strong>, <ul>/<li> e <br> SEM nenhum atributo style (o prompt em
// lib/gerarSugestaoPromocao.js proibe explicitamente), e nao ha como injetar estilo neles
// sem varrer HTML livre com regex — que e frágil e quebra no primeiro caso torto. A saida
// e declarar tipografia e cor AQUI, no container, e deixar a cascata trabalhar.
//
// LIMITACAO CONHECIDA: Outlook desktop nao herda font-family de forma confiavel para <p>
// aninhado, e pode cair em Times New Roman nos paragrafos do corpo (o titulo e o botao,
// que tem style proprio, nao sao afetados). O preco disso e um e-mail com serifa no
// Outlook desktop — feio, nunca quebrado. As alternativas eram reescrever o HTML do LLM
// com regex ou proibir o LLM de usar <p>, e as duas custam mais do que resolvem.
function estiloConteudo({ tamanho = 16 } = {}) {
  return (
    `font-family:${FONTE_CORPO};font-size:${tamanho}px;line-height:1.5;` +
    `color:${OFFWHITE};`
  );
}

// O botao de candidatura. Molde herdado do e-mail de follow-up
// (lib/followupEntrevista.js:83), que ja roda em producao: inline-block com padding,
// laranja de fundo e PRETO no texto — e nao branco, porque preto sobre laranja e o
// contraste que a marca usa no site, e o unico que passa em leitura direta.
//
// `text-decoration:none` e obrigatorio: sem ele, o sublinhado default do <a> risca o
// botao inteiro em varios clientes.
//
// O padding do <a> e ignorado pelo Outlook desktop. Por isso o template envolve este
// botao num <td bgcolor> com o mesmo laranja: quem ignorar o padding ainda ve um bloco
// laranja com o texto dentro, em vez de um link laranja solto sobre o fundo preto.
function estiloBotaoCta() {
  return (
    `display:inline-block;background:${LARANJA};color:${PRETO};text-decoration:none;` +
    `font-family:${FONTE_TITULO};font-weight:700;font-size:18px;letter-spacing:${ESPACAMENTO_TITULO};` +
    `text-transform:uppercase;padding:14px 28px;border-radius:8px;`
  );
}

// Fio horizontal que separa o rodape do resto.
//
// <hr> nao e usado de proposito: sua renderizacao varia demais entre clientes (cor,
// espessura e margens proprias, quase todas nao-estilaveis no Outlook). Uma borda no topo
// de um <td> e previsivel em todo lugar.
function estiloSeparador() {
  return `border-top:1px solid ${LARANJA};font-size:0;line-height:0;height:0;`;
}

// Rodape: por que a pessoa recebeu e como sair. Menor que o corpo, MESMA cor — a
// hierarquia vem do tamanho, nao de um cinza (ver a nota no bloco de cores).
function estiloRodape({ tamanho = 13 } = {}) {
  return (
    `font-family:${FONTE_CORPO};font-size:${tamanho}px;line-height:1.5;` +
    `color:${OFFWHITE};margin:0;`
  );
}

// O link de descadastro no rodape.
//
// SUBLINHADO de proposito, ao contrario do botao: um link de opt-out precisa parecer um
// link. Cliente de e-mail que remova cor de link ainda deixa o sublinhado, e quem quer
// sair da lista precisa achar isto sem procurar.
function estiloLinkRodape() {
  return `color:${LARANJA};text-decoration:underline;`;
}

module.exports = {
  // cores
  PRETO,
  LARANJA,
  OFFWHITE,
  BRANCO,
  // tipografia
  FONTE_CORPO,
  FONTE_TITULO,
  ESPACAMENTO_TITULO,
  // layout
  LARGURA_MAX,
  // helpers de estilo inline
  estiloFundo,
  estiloMoldura,
  estiloTitulo,
  estiloEyebrow,
  estiloKicker,
  estiloTituloVaga,
  estiloSelo,
  estiloConteudo,
  estiloBotaoCta,
  estiloSeparador,
  estiloRodape,
  estiloLinkRodape,
};
