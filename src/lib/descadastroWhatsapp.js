'use strict';

// Token do link de descadastro por WhatsApp — a autorizacao da pagina publica /descadastro/:token.
//
// Irmao de lib/descadastro.js (que faz o mesmo para E-MAIL) e deliberadamente separado dele:
// a unidade la e o e-mail normalizado, aqui e a CHAVE CANONICA do telefone (DDI + DDD +
// ultimos 8 digitos, ver lib/chaveTelefone.js). Sao identidades diferentes, com regras de
// normalizacao que nao se parecem.
//
// ══════════════════════════════════════════════════════════════
// CHAVE DEDICADA: OPTOUT_TOKEN_SECRET
// ══════════════════════════════════════════════════════════════
//
// A primeira versao deste modulo assinava com DESCADASTRO_SECRET, o segredo do descadastro
// por e-mail, separando os dois esquemas por um prefixo de dominio no HMAC. O argumento era
// que a variavel ja existia em producao e ja trazia a janela de rotacao pronta.
//
// ── POR QUE MUDOU ──
// Aquele desenho ACOPLAVA A ROTACAO dos dois canais. Rotacionar por causa de um incidente no
// e-mail derrubaria junto todos os links de WhatsApp ja enviados, e vice-versa; e como so
// existe UM slot de segredo anterior, duas rotacoes seguidas invalidam os links mais antigos
// dos dois canais de uma vez. Sao canais com volumes e ciclos de vida diferentes, e nao ha
// razao de dominio para compartilharem destino.
//
// ── POR QUE A TROCA SAIU DE GRACA ──
// Foi feita ANTES do primeiro envio. Nenhum token de WhatsApp jamais circulou: o link esta
// atras de `optout_link_campanha_ativo`, que nasce desligado e depende de um template ainda
// nao aprovado pela Meta (docs/template-opt-out-meta.md). Nao havia nada a preservar.
// Depois da primeira campanha com link, a mesma migracao exigiria aceitar as duas chaves por
// tempo indeterminado — a complexidade que a decisao original queria evitar.
//
// ── O PREFIXO DE DOMINIO CONTINUA ──
// Com chaves separadas ele deixou de ser a unica barreira, mas continua sendo barato e
// correto: um token so vale no esquema para o qual foi emitido, mesmo que alguem um dia
// aponte as duas variaveis para o mesmo valor por engano de copia-e-cola.
//
// ══════════════════════════════════════════════════════════════
// FORMATO DO TOKEN
// ══════════════════════════════════════════════════════════════
//
//   <base64url(payload)>.<hmac hex truncado>       payload = "v1:<chave canonica>"
//
// UM segmento de caminho so, com alfabeto ja seguro para URL. O telefone viaja em base64url
// e NAO percent-encoded — mesma decisao (e mesma razao) do link de e-mail: ISSO NAO E
// CRIPTOGRAFIA, e reversivel de proposito. A finalidade e nao deixar o numero em texto claro
// em log de servidor, historico de navegador e Referer. Quem autoriza o descadastro e o
// HMAC, nunca a codificacao.
//
// ── POR QUE O PAYLOAD VIAJA JUNTO, EM VEZ DE SO O HMAC ──
// HMAC e mao unica: com so o hash, o servidor nao teria como saber DE QUEM e o token sem uma
// tabela de tokens — que e exatamente a terceira tabela de identidades que lib/descadastro.js
// documenta ter evitado. O par (payload, hmac) dispensa armazenamento: o token e uma FUNCAO
// do telefone, sempre reproduzivel, e continua valido meses depois mesmo que a pessoa apareca
// numa base nova.
//
// ── VERSAO NO PAYLOAD ──
// "v1:" existe para um formato futuro poder coexistir com os links ja enviados. Um token com
// versao desconhecida e recusado como qualquer outro token invalido — nunca interpretado
// "na melhor das hipoteses".
//
// ── SEM EXPIRACAO, DE PROPOSITO ──
// O direito de sair de uma lista nao caduca, e um link vencido numa mensagem antiga seria
// exatamente o pior momento para exigir outro caminho. Mesma decisao do link de e-mail.

const crypto = require('node:crypto');
const { config } = require('../config');
const { chaveCanonicaTelefone } = require('./chaveTelefone');

// ══════════════════════════════════════════════════════════════
// O CAMINHO DA PAGINA — /descadastro-whatsapp/<token>
// ══════════════════════════════════════════════════════════════
//
// IRMAO de /descadastro (o descadastro por E-MAIL), e nao FILHO dele. A primeira versao
// morava em /descadastro/<token>, aninhado sob o caminho do e-mail, e isso era ambiguo de
// tres formas — todas confirmadas por sondagem das rotas de verdade:
//
//   1. GET /descadastro/whatsapp devolvia 404 (caia no :token com o valor "whatsapp"),
//      enquanto POST /descadastro/whatsapp EFETIVAVA o opt-out. A mesma URL significava
//      coisas diferentes conforme o metodo.
//   2. `/descadastro/:token` e um curinga que engole QUALQUER sub-caminho novo sob
//      /descadastro/. Uma rota literal acrescentada depois dele ao fluxo de e-mail nasceria
//      morta, e o sintoma seria um 404 que ninguem associa a este arquivo.
//   3. Dois subsistemas de opt-out, com esquemas de token diferentes e chaves diferentes,
//      compartilhando prefixo — a leitura de "de quem e esta URL?" dependia de contar
//      segmentos.
//
// Agora os dois sao irmaos e nao ha sobreposicao nenhuma: /descadastro e do e-mail,
// /descadastro-whatsapp e do WhatsApp, e o Express casa segmento literal, entao um nunca
// alcanca o outro.
//
// ── ESTE VALOR VAI PARA DENTRO DE UM TEMPLATE APROVADO PELA META ──
// A URL base e cadastrada no botao do template, e a Meta so aprova o PADRAO. Mudar este
// caminho depois de um template aprovado exige RESUBMISSAO e nova revisao — e, se ja houver
// mensagem enviada, quebra os links que estao no aparelho das pessoas. Foi por isso que a
// mudanca aconteceu ANTES do primeiro cadastro na Meta, quando ela ainda custava zero.
// NAO altere sem reler docs/template-opt-out-meta.md.
const CAMINHO_DESCADASTRO_WHATSAPP = '/descadastro-whatsapp';

// Prefixo de dominio do HMAC — ver "O PREFIXO DE DOMINIO CONTINUA" no cabecalho. Com chaves
// separadas ele deixou de ser a unica barreira contra um token de e-mail valer aqui, mas
// continua sendo a defesa que sobrevive a alguem apontar as duas variaveis para o mesmo
// valor. NAO mude sem invalidar todos os links ja enviados.
const DOMINIO_HMAC = 'optout-wa';

// Versao do payload. Sobe quando o FORMATO mudar, nunca por mudanca de texto de pagina.
const VERSAO = 'v1';

// 32 hex = 128 bits do HMAC-SHA256. Folgado contra adivinhacao e curto o bastante para o
// link nao virar uma parede de texto dentro de uma mensagem de WhatsApp — onde o link
// aparece inteiro na tela, diferente do e-mail. Truncar HMAC e pratica padrao.
const TAMANHO_HMAC = 32;

// Lidos a CADA chamada (nao capturados no load do modulo) para o teste conseguir simular
// rotacao e ausencia de segredo sem recarregar o cache de modulos. Mesma disciplina de
// lib/descadastro.js.
//
// `config.optoutToken`, e NUNCA `config.descadastro`: sao chaves separadas desde a migracao
// descrita no cabecalho. Nao ha fallback de uma para a outra de proposito — um fallback
// silencioso faria os links funcionarem hoje com a chave do e-mail e quebrarem no dia em que
// OPTOUT_TOKEN_SECRET fosse definida, invalidando todo token ja enviado.
function segredos() {
  return {
    atual: config.optoutToken.segredo || '',
    anterior: config.optoutToken.segredoAnterior || '',
  };
}

function base64url(texto) {
  return Buffer.from(texto, 'utf8').toString('base64url');
}

function calcularHmac(payload, chave) {
  return crypto
    .createHmac('sha256', chave)
    .update(`${DOMINIO_HMAC}:${payload}`)
    .digest('hex')
    .slice(0, TAMANHO_HMAC);
}

// Comparacao em tempo constante que NUNCA lanca. timingSafeEqual LANCA com buffers de
// tamanhos diferentes — o teste de comprimento vem ANTES por isso, e nao por otimizacao. O
// comprimento do token e fixo e publico, entao compara-lo de forma nao-constante nao vaza
// nada. (Mesmo raciocinio, palavra por palavra, de lib/descadastro.js.)
function iguais(esperado, recebido) {
  const a = Buffer.from(esperado, 'utf8');
  const b = Buffer.from(recebido, 'utf8');
  if (a.length !== b.length) return false;
  try {
    return crypto.timingSafeEqual(a, b);
  } catch {
    return false;
  }
}

// Token de um telefone. SEMPRE com o segredo ATUAL — links novos nascem com a chave nova; o
// anterior so existe para VALIDAR links ja enviados.
//
// LANCA quando o telefone nao canoniza ou quando o segredo falta. Falhar aqui e barulhento e
// corrigivel; um token gerado com segredo improvisado iria para dentro de uma mensagem que
// nao da para reemitir.
//
// ── LANCAR AQUI NAO DERRUBA NADA, E ESSA E A PARTE QUE IMPORTA ──
// O UNICO chamador no caminho de envio e lib/optoutWhatsapp.textoDescadastroPara, que
// captura, LOGA e devolve a linha de texto de fallback — a mensagem sai sem link em vez de
// nao sair. O servidor tambem nunca cai por isto: `validar()` (config.js) so AVISA no boot,
// e as rotas publicas chamam lerTokenDescadastroWhatsapp, que nunca lanca. Ver P6 no
// cabecalho de lib/optoutWhatsapp.js.
function gerarTokenDescadastroWhatsapp(telefone) {
  const canonico = chaveCanonicaTelefone(telefone);
  if (!canonico) {
    throw new Error(`Telefone sem chave canonica: ${JSON.stringify(telefone)}. Nao ha token a gerar.`);
  }
  const { atual } = segredos();
  if (!atual) {
    throw new Error(
      'OPTOUT_TOKEN_SECRET ausente. Defina a variavel no .env antes de gerar links de ' +
        'descadastro por WhatsApp — sem ela, os links enviados nao poderiam ser validados ' +
        'depois. Gere com `openssl rand -hex 32`.',
    );
  }
  const payload = `${VERSAO}:${canonico}`;
  return `${base64url(payload)}.${calcularHmac(payload, atual)}`;
}

// Le um token e devolve a CHAVE CANONICA, ou null.
//
// NUNCA LANCA: token ausente, de tipo errado, malformado, fora do alfabeto, com versao
// desconhecida, adulterado ou assinado com chave que nao conhecemos — tudo vira null. Quem
// chama e uma rota publica, e uma excecao ali viraria 500 numa pagina que deveria
// simplesmente dizer "link invalido".
//
// Aceita OPTOUT_TOKEN_SECRET ou OPTOUT_TOKEN_SECRET_ANTERIOR, pela mesma razao do link de
// e-mail: sem a janela de dois segredos, trocar a chave invalidaria de uma vez TODOS os
// links de descadastro ja enviados, e quem nao consegue sair de uma lista denuncia a
// mensagem — que no WhatsApp custa o numero, nao a reputacao de um dominio.
//
// Procedimento de rotacao (documentado tambem no .env.example): mover o valor atual para
// OPTOUT_TOKEN_SECRET_ANTERIOR, por o novo em OPTOUT_TOKEN_SECRET, reiniciar.
function lerTokenDescadastroWhatsapp(token) {
  if (typeof token !== 'string' || !token) return null;

  const partes = token.split('.');
  if (partes.length !== 2) return null;
  const [corpo, hmacRecebido] = partes;
  // Alfabeto validado ANTES de decodificar: Buffer.from(..., 'base64url') e TOLERANTE — ele
  // ignora caracteres invalidos em vez de reclamar, e sem esta checagem um lixo qualquer
  // viraria uma string decodificada silenciosamente.
  if (!/^[A-Za-z0-9_-]+$/.test(corpo)) return null;
  if (!/^[0-9a-f]+$/.test(hmacRecebido)) return null;

  let payload;
  try {
    payload = Buffer.from(corpo, 'base64url').toString('utf8');
  } catch {
    return null;
  }

  const m = /^v(\d+):(\d{10,15})$/.exec(payload);
  if (!m) return null;
  // Versao desconhecida e RECUSA, nao "tenta interpretar como a atual".
  if (`v${m[1]}` !== VERSAO) return null;
  const canonico = m[2];

  const { atual, anterior } = segredos();
  // Sem segredo ATUAL o sistema nao esta configurado — e nao ha "meio configurado". Aceitar
  // so pelo anterior deixaria o app validando links num estado em que ele nem consegue gerar
  // links novos, escondendo a falta de configuracao em vez de expo-la.
  if (!atual) return null;

  const chaves = [atual];
  // Anterior IGUAL ao atual (typo de rotacao) nao vira segunda comparacao inutil.
  if (anterior && anterior !== atual) chaves.push(anterior);

  for (const chave of chaves) {
    if (iguais(calcularHmac(payload, chave), hmacRecebido)) return canonico;
  }
  return null;
}

// URL completa do link que vai na mensagem.
//
// LANCA pelas mesmas razoes de gerarTokenDescadastroWhatsapp (falha cedo, antes do envio).
function montarUrlDescadastroWhatsapp(telefone, baseUrl) {
  const base = String(baseUrl || config.baseUrl || '').replace(/\/+$/, '');
  return `${base}${CAMINHO_DESCADASTRO_WHATSAPP}/${gerarTokenDescadastroWhatsapp(telefone)}`;
}

module.exports = {
  CAMINHO_DESCADASTRO_WHATSAPP,
  DOMINIO_HMAC,
  VERSAO,
  TAMANHO_HMAC,
  gerarTokenDescadastroWhatsapp,
  lerTokenDescadastroWhatsapp,
  montarUrlDescadastroWhatsapp,
};
