'use strict';

// Token do link de descadastro por WhatsApp — a autorizacao da pagina publica /descadastro/:token.
//
// Irmao de lib/descadastro.js (que faz o mesmo para E-MAIL) e deliberadamente separado dele:
// a unidade la e o e-mail normalizado, aqui e a CHAVE CANONICA do telefone (DDI + DDD +
// ultimos 8 digitos, ver lib/chaveTelefone.js). Sao identidades diferentes, com regras de
// normalizacao que nao se parecem.
//
// ══════════════════════════════════════════════════════════════
// POR QUE REUSAR DESCADASTRO_SECRET, EM VEZ DE CRIAR UM ENV NOVO
// ══════════════════════════════════════════════════════════════
//
// O enunciado previa criar OPTOUT_TOKEN_SECRET "se nao houver segredo reaproveitavel". Ha:
// DESCADASTRO_SECRET ja existe, ja esta definido em producao, e ja vem com uma JANELA DE
// ROTACAO pronta (DESCADASTRO_SECRET_ANTERIOR), que e a parte dificil de acertar e a que
// mais custa caro se faltar — um link de opt-out quebrado e pior do que nao ter link.
//
// Criar um env novo significaria: mais uma variavel para definir no Railway antes de o
// deploy funcionar, e uma janela em que o codigo novo esta no ar e o segredo ainda nao, na
// qual TODO link de descadastro emitido seria invalido. O ganho seria isolamento de chave
// entre dois canais que ja pertencem ao mesmo dono e tem o mesmo nivel de sensibilidade.
//
// ── O ISOLAMENTO QUE IMPORTA VEM DA SEPARACAO DE DOMINIO, NAO DE OUTRA CHAVE ──
// O HMAC daqui e calculado sobre uma string PREFIXADA (`optout-wa:v1:<canonico>`), enquanto
// o de e-mail e calculado sobre o e-mail cru. Nao existe entrada que produza a mesma
// mensagem nos dois esquemas, entao um token de e-mail NUNCA valida como token de telefone,
// nem o contrario — que e a unica confusao que duas chaves separadas evitariam.
//
// Quem quiser separar as chaves um dia: troque `segredos()` abaixo para ler as suas
// proprias variaveis. O resto do modulo nao muda.
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

// Prefixo de dominio do HMAC. Ver o bloco sobre reuso de segredo, acima: e ELE que impede um
// token de e-mail de valer como token de telefone. NAO mude sem invalidar todos os links ja
// enviados.
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
function segredos() {
  return {
    atual: config.descadastro.segredo || '',
    anterior: config.descadastro.segredoAnterior || '',
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
// nao da para reemitir. Quem chama no caminho de ENVIO precisa tratar isso — ver P6 e o
// fallback textual em lib/campanhaWhatsapp.
function gerarTokenDescadastroWhatsapp(telefone) {
  const canonico = chaveCanonicaTelefone(telefone);
  if (!canonico) {
    throw new Error(`Telefone sem chave canonica: ${JSON.stringify(telefone)}. Nao ha token a gerar.`);
  }
  const { atual } = segredos();
  if (!atual) {
    throw new Error(
      'DESCADASTRO_SECRET ausente. Defina a variavel no .env antes de gerar links de ' +
        'descadastro — sem ela, os links enviados nao poderiam ser validados depois.',
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
// Aceita o segredo ATUAL ou o ANTERIOR, pela mesma razao do link de e-mail: sem a janela de
// dois segredos, trocar a chave invalidaria de uma vez TODOS os links de descadastro ja
// enviados, e quem nao consegue sair de uma lista denuncia a mensagem — que no WhatsApp
// custa o numero, nao a reputacao de um dominio.
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
  return `${base}/descadastro/${gerarTokenDescadastroWhatsapp(telefone)}`;
}

module.exports = {
  DOMINIO_HMAC,
  VERSAO,
  TAMANHO_HMAC,
  gerarTokenDescadastroWhatsapp,
  lerTokenDescadastroWhatsapp,
  montarUrlDescadastroWhatsapp,
};
