'use strict';

// Link de candidatura no e-mail de campanha (o "call to action") + a URL da vaga com UTM.
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

const { config } = require('../config');
const { escapeHtml } = require('../views');

// A UNICA UTM que a campanha carrega. Decisao explicita do Rafael: so `utm_source`, sem
// medium nem campaign. O painel ja sabe ler isso sem mudanca nenhuma — origemCanonica() e
// listarOrigensDistintas() trabalham sobre applications.utm_source, entao 'email' passa a
// aparecer no filtro de Origem sozinho, assim que a primeira candidatura chegar.
const UTM_SOURCE_CAMPANHA = 'email';

// URL publica da vaga, com a UTM anexada.
//
// `new URL` em vez de concatenar string: ele resolve o encode do path e cuida do separador
// (`?` vs `&`) sem que este modulo precise reimplementar query string. Hoje a URL nunca tem
// outro parametro, mas montar isso a mao e o tipo de coisa que quebra em silencio no dia em
// que passar a ter.
//
// Devolve '' quando nao ha slug: e o caso de vaga removida (ver o LEFT JOIN em
// listarEnviosPendentesCampanha). Sem endereco nao ha link, e montarCorpoComCta trata isso.
function montarUrlVaga(slug, baseUrl = config.baseUrl) {
  const s = String(slug || '').trim();
  if (!s) return '';

  const url = new URL(`/vaga/${encodeURIComponent(s)}`, String(baseUrl || '').replace(/\/+$/, '') + '/');
  url.searchParams.set('utm_source', UTM_SOURCE_CAMPANHA);
  return url.toString();
}

// Anexa o bloco de candidatura ao fim do corpo do e-mail.
//
// ── POR QUE BLOCO FIXO ANEXADO, e nao um placeholder tipo {{LINK_VAGA}} ──
// A alternativa do placeholder e mais flexivel (o link poderia aparecer no meio do texto),
// mas depende de alguem LEMBRAR de escreve-lo: o LLM teria que gera-lo sempre, e o Jean
// teria que nao apaga-lo ao editar nem esquece-lo ao escrever a mao. O custo desse tipo de
// "depende de lembrar" acabou de ser medido na pratica — foi exatamente assim que o link
// sumiu por tres incrementos. Aqui o link e garantido por CODIGO: nao ha caminho de
// esquecimento, porque nao ha nada a lembrar.
//
// ── SEM CSS INLINE, de proposito ──
// O proprio prompt do Incremento 6 proibe CSS inline no corpo gerado, porque cliente de
// e-mail ignora ou quebra estilo elaborado. Um bloco de CTA cheio de estilo teria o mesmo
// problema — e pior, seria a parte do e-mail que MAIS precisa renderizar em todo lugar.
// Um <p> com um <a> dentro funciona em qualquer cliente, inclusive em modo texto.
//
// ── LIMITACAO CONHECIDA E ACEITA: NAO detecta link duplicado ──
// Se o Jean escrever o proprio link para a MESMA vaga no corpo, o e-mail sai com dois
// caminhos para o mesmo lugar. Detectar isso exigiria varrer o HTML procurando ancoras,
// normalizar URLs (com e sem UTM, com e sem barra final, absolutas e relativas) e decidir
// qual remover — complexidade desproporcional a um incomodo estetico, num corpo que e HTML
// livre. Dois links para a vaga certa e um resultado aceitavel; nenhum link, que era o
// estado anterior, nao era.
function montarCorpoComCta(corpoHtml, urlVaga) {
  const corpo = String(corpoHtml == null ? '' : corpoHtml);
  const url = String(urlVaga || '').trim();

  // Sem URL (vaga removida), devolve o corpo intocado. Um e-mail sem link e ruim; um e-mail
  // com <a href=""> e pior, porque parece funcional e leva a lugar nenhum.
  if (!url) return corpo;

  // escapeHtml no href: o `&` de uma query com mais de um parametro precisa virar `&amp;`
  // dentro de atributo HTML. Hoje so ha um parametro e nao ha `&`, mas o dia em que houver
  // nao pode depender de alguem lembrar de escapar aqui.
  return `${corpo}\n<p><a href="${escapeHtml(url)}">Ver a vaga e me candidatar</a></p>`;
}

// Atalho para quem tem o slug e o corpo: monta a URL e ja anexa. E o que os DOIS caminhos
// de envio chamam (a varredura do disparo real e o botao de e-mail de teste), e existir
// como funcao unica e o que garante que os dois produzam o MESMO e-mail — se cada um
// montasse o seu, o botao de teste deixaria de testar o que sera enviado de verdade.
function montarCorpoFinal(corpoHtml, slug, baseUrl = config.baseUrl) {
  return montarCorpoComCta(corpoHtml, montarUrlVaga(slug, baseUrl));
}

module.exports = {
  montarUrlVaga,
  montarCorpoComCta,
  montarCorpoFinal,
  UTM_SOURCE_CAMPANHA,
};
