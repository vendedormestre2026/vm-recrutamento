'use strict';

// Descadastro (opt-out) da divulgacao de vagas — Promocao de Vagas.
//
// Este modulo e a fonte do token que autoriza um descadastro sem login, e REEXPORTA a
// normalizacao de e-mail (que mora em lib/normalizarEmail — modulo-folha, importavel
// tambem pela camada de dados sem risco de ciclo). A reexportacao mantem a API publica
// daqui estavel: quem ja usa `descadastro.normalizarEmail` continua valendo.
//
// POR QUE HMAC E NAO UMA COLUNA DE TOKEN NO BANCO: o link de descadastro precisa existir
// para QUALQUER e-mail da base de contatos — que nao e uma tabela, e sim a uniao de
// `applications` e `talentos` (ver o cabecalho de campanhas em schema.sql). Guardar um
// token por pessoa exigiria uma terceira tabela de identidades, mantida em sincronia com
// as outras duas. O HMAC dispensa armazenamento: o token e uma FUNCAO do e-mail, sempre
// reproduzivel, e continua valido mesmo que a pessoa apareca numa base nova depois.
//
// O QUE O TOKEN PROTEGE: impede que alguem descadastre terceiros varrendo e-mails
// (`/descadastro?e=<vitima>`). Sem ele, a rota publica seria uma ferramenta de sabotagem.
// O token NAO expira de proposito — o direito de sair de uma lista nao caduca, e um link
// vencido num e-mail antigo seria exatamente o pior momento para exigir outro caminho.

const crypto = require('node:crypto');
const { config } = require('../config');
const { normalizarEmail } = require('./normalizarEmail');

// Valores de `descadastros.origem`. A coluna ficou SEM CHECK no schema (Incremento 1);
// estas duas constantes sao a protecao contra typo no lugar dele — quem grava usa daqui,
// nunca a string literal.
const ORIGEM_LINK_EMAIL = 'link_email'; // auto-servico: a pessoa clicou no link do e-mail
const ORIGEM_MANUAL = 'manual'; // o recrutador registrou pelo painel

// Tamanho do token em caracteres hex. 32 hex = 128 bits do HMAC-SHA256 — folgado para
// impedir adivinhacao e curto o bastante para o link nao virar uma parede de texto no
// corpo do e-mail. Truncar HMAC e pratica padrao; os 128 bits restantes nao adicionam
// seguranca pratica aqui.
const TAMANHO_TOKEN = 32;

// Lidos a CADA chamada (nao capturados no load do modulo) para o teste conseguir simular
// rotacao e ausencia de segredo sem recarregar o cache de modulos.
function segredo() {
  return config.descadastro.segredo || '';
}
function segredoAnterior() {
  return config.descadastro.segredoAnterior || '';
}

// HMAC truncado de um e-mail com UMA chave especifica. Isolado porque a verificacao
// precisa calcular o mesmo valor com chaves diferentes (rotacao, abaixo).
function calcularHmac(email, chave) {
  return crypto
    .createHmac('sha256', chave)
    .update(normalizarEmail(email))
    .digest('hex')
    .slice(0, TAMANHO_TOKEN);
}

// Comparacao de tempo constante entre o token esperado e o recebido. NUNCA lanca.
// timingSafeEqual LANCA quando os buffers tem tamanhos diferentes — o teste de
// comprimento vem ANTES por isso, nao por otimizacao. O comprimento do token nao e
// segredo (e fixo e publico), entao compara-lo de forma nao-constante nao vaza nada.
function tokensIguais(esperado, recebido) {
  const a = Buffer.from(esperado, 'utf8');
  const b = Buffer.from(recebido, 'utf8');
  if (a.length !== b.length) return false;
  try {
    return crypto.timingSafeEqual(a, b);
  } catch {
    return false;
  }
}

// Token de descadastro de um e-mail. SEMPRE com o segredo ATUAL — links novos nascem com
// a chave nova; o segredo anterior so existe para VALIDAR links ja enviados.
// LANCA quando o segredo atual esta ausente — ver a razao completa no bloco `descadastro`
// de config.js. Resumo: falhar aqui e barulhento e corrigivel; um token gerado com
// segredo improvisado vai para dentro de um e-mail que nao da para reemitir.
function gerarToken(email) {
  const chave = segredo();
  if (!chave) {
    throw new Error(
      'DESCADASTRO_SECRET ausente. Defina a variavel no .env antes de gerar links de ' +
        'descadastro — sem ela, os links enviados nao poderiam ser validados depois.',
    );
  }
  return calcularHmac(email, chave);
}

// Confere o token de um e-mail, aceitando o segredo ATUAL ou o ANTERIOR.
//
// ── POR QUE ACEITAR DOIS SEGREDOS ──
// Sem isso, trocar DESCADASTRO_SECRET invalidaria de uma vez TODOS os links de
// descadastro ja enviados. Um link de opt-out quebrado e pior do que nao ter link: quem
// nao consegue sair da lista marca a mensagem como spam, e isso atinge a reputacao do
// dominio — que e o MESMO usado pelos e-mails transacionais do funil. Na pratica o
// segredo ficaria irrotacionavel para sempre a partir do primeiro disparo.
// Com a janela de dois segredos, rotacionar vira uma operacao segura e sem prazo: os
// links antigos seguem valendo indefinidamente (ver o procedimento no .env.example).
//
// A ausencia do anterior e o caso NORMAL (rotacao nunca feita), nao um erro.
//
// NUNCA lanca: qualquer problema (segredo ausente, token vazio, tamanho diferente, tipo
// errado) e `false`. Quem chama e uma rota publica, e uma excecao ali viraria 500 numa
// pagina que deveria simplesmente dizer "link invalido".
function verificarToken(email, token) {
  const alvo = normalizarEmail(email);
  const recebido = typeof token === 'string' ? token : '';
  // E-mail vazio nunca autentica: sem esta guarda, um link com ?e= vazio e o HMAC da
  // string vazia (que e calculavel por qualquer um que conheca o segredo) passaria.
  if (!alvo || !recebido) return false;

  const atual = segredo();
  // Sem segredo ATUAL o sistema nao esta configurado — e nao ha "meio configurado".
  // Aceitar so pelo anterior deixaria o app validando links num estado em que ele nem
  // consegue gerar links novos, escondendo a falta de configuracao em vez de expo-la.
  if (!atual) return false;

  const chaves = [atual];
  const anterior = segredoAnterior();
  // Segredo anterior IGUAL ao atual (typo de rotacao) nao vira segunda comparacao inutil.
  if (anterior && anterior !== atual) chaves.push(anterior);

  for (const chave of chaves) {
    if (tokensIguais(calcularHmac(alvo, chave), recebido)) return true;
  }
  return false;
}

// URL completa do link que vai no rodape dos e-mails de divulgacao.
//
// O e-mail viaja em base64url, e nao percent-encoded. ISSO NAO E CRIPTOGRAFIA NEM
// SEGURANCA — e reversivel de proposito (lerEmailDaUrl desfaz), e quem autoriza o
// descadastro e o HMAC, nunca a codificacao. A unica finalidade e nao deixar o endereco
// em texto claro em log de servidor, historico de navegador e Referer. Quem mexer aqui
// depois: trocar por percent-encoding nao enfraquece a seguranca, so a discricao.
//
// Bonus da escolha: o alfabeto base64url (A-Za-z0-9_-) ja e URL-safe, entao o valor nao
// precisa de escaping adicional na query string.
function montarUrlDescadastro(email, baseUrl) {
  const alvo = normalizarEmail(email);
  const base = String(baseUrl || '').replace(/\/+$/, '');
  const e = Buffer.from(alvo, 'utf8').toString('base64url');
  const t = gerarToken(alvo); // lanca se o segredo faltar (falha cedo, antes do envio)
  return `${base}/descadastro?e=${e}&t=${t}`;
}

// Desfaz montarUrlDescadastro. NUNCA lanca: parametro ausente, tipo errado ou fora do
// alfabeto base64url devolve ''. A validacao de alfabeto e necessaria porque
// Buffer.from(..., 'base64url') e TOLERANTE — ele ignora caracteres invalidos em vez de
// reclamar, e sem esta checagem um lixo qualquer viraria uma string decodificada
// silenciosamente.
function lerEmailDaUrl(param) {
  if (typeof param !== 'string' || !param) return '';
  if (!/^[A-Za-z0-9_-]+$/.test(param)) return '';
  try {
    return normalizarEmail(Buffer.from(param, 'base64url').toString('utf8'));
  } catch {
    return '';
  }
}

module.exports = {
  ORIGEM_LINK_EMAIL,
  ORIGEM_MANUAL,
  TAMANHO_TOKEN,
  normalizarEmail,
  gerarToken,
  verificarToken,
  montarUrlDescadastro,
  lerEmailDaUrl,
};
