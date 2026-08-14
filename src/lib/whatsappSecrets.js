'use strict';

// Cifragem simetrica da sessao do WhatsApp (AES-256-GCM).
//
// ── POR QUE CIFRAR ──
// `baileys_auth` guarda as credenciais da sessao pareada. Quem as tem ENVIA MENSAGEM COMO O
// JEAN — nao e "dado sensivel" no sentido usual, e capacidade de agir em nome de alguem.
// Este banco e baixado inteiro para diagnostico com alguma frequencia (o proprio historico
// deste projeto tem varios snapshots via .backup()); um deles vazando nao pode entregar a
// conta de WhatsApp junto.
//
// ── ESTE E O PRIMEIRO USO DE CIFRAGEM SIMETRICA NO PROJETO ──
// O unico crypto existente ate aqui e HMAC (lib/descadastro) e randomBytes (lib/session).
// Nenhum dos dois serve: HMAC assina, nao esconde; e o que precisamos aqui e sigilo COM
// integridade — dai GCM, que autentica o texto cifrado e falha alto se alguem editar o
// blob no banco.
//
// ── SEM JANELA DE ROTACAO, ao contrario de DESCADASTRO_SECRET ──
// La, dois segredos convivem porque os tokens JA ENVIADOS precisam continuar valendo. Aqui
// o dado cifrado e ESTADO VIVO, nao token emitido: trocar a chave nao "invalida links
// antigos", torna a sessao ilegivel. A consequencia esta no .env.example em voz alta —
// perder a chave obriga a parear o numero de novo, lendo o QR no celular.

const crypto = require('node:crypto');

const ALGORITMO = 'aes-256-gcm';
const BYTES_IV = 12; // 96 bits, o tamanho recomendado para GCM
const BYTES_TAG = 16;
const VERSAO = 'v1'; // prefixo do envelope, para um formato futuro poder conviver

// A chave vem de WHATSAPP_SECRETS_KEY, 32 bytes em hex (64 caracteres).
//
// Lida a CADA chamada, e nao no load do modulo: e o mesmo motivo das fachadas de provedor —
// o teste precisa trocar a chave em runtime, e congelar no require tornaria isso impossivel
// sem limpar o cache de modulos.
//
// LANCA quando ausente ou malformada, em vez de cair para uma chave derivada de outra coisa.
// Um fallback silencioso (ex.: derivar de SESSION_SECRET) faria a sessao ser gravada hoje e
// virar ilegivel no dia em que a variavel certa fosse definida — exatamente o desastre que o
// comentario de DESCADASTRO_SECRET em config.js descreve, e que la custou uma decisao
// explicita de nao ter fallback.
function chave() {
  const bruta = String(process.env.WHATSAPP_SECRETS_KEY || '').trim();
  if (!bruta) {
    throw new Error(
      'WHATSAPP_SECRETS_KEY ausente. Ela cifra a sessao do WhatsApp (baileys_auth) e nao ' +
        'tem default: gere com `openssl rand -hex 32` e defina no .env.',
    );
  }
  if (!/^[0-9a-f]{64}$/i.test(bruta)) {
    throw new Error(
      `WHATSAPP_SECRETS_KEY invalida: esperado 64 caracteres hex (32 bytes), recebido ` +
        `${bruta.length} caractere(s). Gere com \`openssl rand -hex 32\`.`,
    );
  }
  return Buffer.from(bruta, 'hex');
}

// Sela um texto claro. Devolve "v1.<iv>.<tag>.<cifra>", tudo em base64url.
//
// O IV e ALEATORIO por chamada e vai junto no envelope — reusar IV em GCM quebra a cifra
// inteira (dois textos com o mesmo IV vazam o XOR entre eles). Por isso ele nao e derivado
// da chave nem do conteudo.
//
// base64url e nao base64: o envelope viaja em coluna TEXT e pode acabar num log ou numa
// URL de diagnostico; evitar '+' e '/' economiza uma classe de bug de escape.
function sealSecret(textoClaro) {
  const iv = crypto.randomBytes(BYTES_IV);
  const cifra = crypto.createCipheriv(ALGORITMO, chave(), iv);
  const dados = Buffer.concat([cifra.update(String(textoClaro), 'utf8'), cifra.final()]);
  const tag = cifra.getAuthTag();
  return [VERSAO, iv.toString('base64url'), tag.toString('base64url'), dados.toString('base64url')].join('.');
}

// Abre um envelope selado por sealSecret.
//
// LANCA se a chave estiver errada, se o blob tiver sido editado, ou se o formato nao for o
// esperado. E deliberado: um `return null` silencioso faria o auth state tratar credencial
// corrompida como "sessao nova", e o sintoma seria o WhatsApp pedindo pareamento de novo
// sem ninguem entender por que — em vez de um erro dizendo que a chave nao confere.
function openSecret(envelope) {
  const partes = String(envelope || '').split('.');
  if (partes.length !== 4 || partes[0] !== VERSAO) {
    throw new Error(`Envelope de sessao em formato desconhecido (esperado ${VERSAO}.iv.tag.dados).`);
  }
  const [, ivB64, tagB64, dadosB64] = partes;
  const iv = Buffer.from(ivB64, 'base64url');
  const tag = Buffer.from(tagB64, 'base64url');
  if (iv.length !== BYTES_IV || tag.length !== BYTES_TAG) {
    throw new Error('Envelope de sessao com IV ou tag de tamanho invalido.');
  }
  const decifra = crypto.createDecipheriv(ALGORITMO, chave(), iv);
  decifra.setAuthTag(tag);
  // O final() e quem verifica a tag: se o conteudo foi adulterado ou a chave e outra, ele
  // lanca aqui. Nao ha caminho em que dado corrompido saia como se fosse bom.
  return Buffer.concat([decifra.update(Buffer.from(dadosB64, 'base64url')), decifra.final()]).toString('utf8');
}

// Diz se a chave esta utilizavel, sem lancar. Para o boot decidir se sequer tenta conectar,
// e para o painel mostrar o motivo em vez de um stack trace.
function chaveConfigurada() {
  try {
    chave();
    return true;
  } catch {
    return false;
  }
}

module.exports = { sealSecret, openSecret, chaveConfigurada, VERSAO };
