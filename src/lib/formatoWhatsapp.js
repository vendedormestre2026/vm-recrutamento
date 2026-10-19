'use strict';

// Formatacao do WhatsApp em HTML, para a PREVIA do painel (2026-10-19).
//
// So apresentacao: nada daqui entra no texto enviado. O que vai ao Baileys e a string crua (com
// \n, *negrito* etc.), e o aparelho de quem recebe e que formata. Esta funcao imita essa
// formatacao para o operador ver a mensagem como ela chega.
//
// Ordem, e por que:
//   1. ESCAPA o HTML antes de tudo (anti-XSS): o texto vem do operador e do LLM. Depois disso
//      nenhum caractere do texto vira tag; as unicas tags sao as que esta funcao escreve.
//   2. Separa ```monoespacado``` e os links: o que esta dentro deles nao e formatado (um _ no
//      meio de uma URL nao pode virar italico).
//   3. *negrito*, _italico_, ~riscado~, com a regra do WhatsApp: o marcador de abertura vem no
//      inicio ou depois de algo que nao e letra/numero, e e seguido de algo que nao e espaco; o de
//      fechamento vem depois de algo que nao e espaco e antes do fim ou de algo que nao e
//      letra/numero; tudo na mesma linha. Marcador solto ou sem par fica literal.
//   4. \n fica \n: quem mostra usa white-space: pre-wrap, que preserva linhas em branco.
//
// Valores substituidos: resolverTexto({ marcar: true }) cerca cada valor com MARCA_INICIO/MARCA_FIM
// (caracteres de uso privado do Unicode). Aqui eles viram <span class="wa-sub"> — destaque
// discreto na previa do que veio do cadastro e nao do texto.

const MARCA_INICIO = '\uE000';
const MARCA_FIM = '\uE001';
// Reservados para os blocos separados no passo 2.
const RESERVA_INICIO = '\uE002';
const RESERVA_FIM = '\uE003';

function escaparHtml(texto) {
  return String(texto)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// Um marcador de estilo (*, _ ou ~). Letra/numero colado de fora impede: "2*3*4" e "nome_do_arquivo"
// ficam literais, como no WhatsApp.
function reEstilo(marcador) {
  const m = marcador === '*' ? '\\*' : marcador; // so o * precisa de escape (flag u recusa \~)
  return new RegExp(
    `(^|[^\\p{L}\\p{N}${m}])${m}(?=[^\\s${m}])([^\\n${m}]*?[^\\s${m}])${m}(?![\\p{L}\\p{N}${m}])`,
    'gmu',
  );
}
const ESTILOS = [
  [reEstilo('*'), 'b'],
  [reEstilo('_'), 'i'],
  [reEstilo('~'), 's'],
];

// URL ja escapada: para no espaco e nas marcas. Pontuacao colada no fim ("...eep." ou "(link)"),
// aspas e marcador de estilo ("*https://...*") ficam fora, como em urlsDe do validador.
const RE_URL = /https?:\/\/[^\s\uE000-\uE003]+/gi;

function separarUrl(url) {
  let fim = '';
  let u = url;
  for (;;) {
    const aspas = u.match(/(&quot;|&#39;)$/);
    if (aspas) { fim = aspas[1] + fim; u = u.slice(0, -aspas[1].length); continue; }
    const m = u.match(/[.,;:!?)\]*_~]$/);
    if (m && !/&[a-z#0-9]+;$/i.test(u)) { fim = m[0] + fim; u = u.slice(0, -1); continue; }
    break;
  }
  return [u, fim];
}

// Texto cru do WhatsApp -> HTML seguro. Para usar dentro de um elemento com white-space: pre-wrap.
function formatarWhatsappHtml(texto) {
  const reservados = [];
  const reservar = (html) => {
    reservados.push(html);
    return `${RESERVA_INICIO}${reservados.length - 1}${RESERVA_FIM}`;
  };

  let h = String(texto == null ? '' : texto)
    .replace(/\r\n?/g, '\n')
    .replace(/[\uE002\uE003]/g, '');
  h = escaparHtml(h);

  // ```monoespacado``` (pode ter varias linhas). Conteudo intacto, sem estilo nem link.
  h = h.replace(/```([\s\S]+?)```/g, (_, dentro) => reservar(`<code class="wa-mono">${dentro}</code>`));

  h = h.replace(RE_URL, (bruto) => {
    const [url, fim] = separarUrl(bruto);
    if (!/^https?:\/\/[^/]/i.test(url)) return bruto;
    return reservar(`<a href="${url}" target="_blank" rel="noopener noreferrer">${url}</a>`) + fim;
  });

  for (const [re, tag] of ESTILOS) {
    // Repete enquanto houver troca: "*a* *b*" casa os dois mesmo que o espaco entre eles ja
    // tenha sido consumido como prefixo do primeiro.
    let antes;
    do {
      antes = h;
      h = h.replace(re, (_, pre, dentro) => `${pre}<${tag}>${dentro}</${tag}>`);
    } while (h !== antes);
  }

  h = h.replace(new RegExp(`${RESERVA_INICIO}(\\d+)${RESERVA_FIM}`, 'g'), (_, i) => reservados[Number(i)]);
  return h
    .replace(new RegExp(MARCA_INICIO, 'g'), '<span class="wa-sub">')
    .replace(new RegExp(MARCA_FIM, 'g'), '</span>');
}

module.exports = {
  formatarWhatsappHtml,
  escaparHtml,
  MARCA_INICIO,
  MARCA_FIM,
};
