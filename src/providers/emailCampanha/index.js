'use strict';

// Fachada do e-mail de CAMPANHA: escolhe o transporte por configuracao.
//
// ── POR QUE ELA EXISTE AGORA, e nao no Incremento 3 ──
// La havia UM implementador (SMTP), e o proprio incremento registrou que criar fachada para
// um implementador so seria cerimonia. Agora ha dois, e a razao de ser dela deixou de ser
// hipotetica: o Railway bloqueia egress SMTP, entao o default virou a API REST — e quando o
// bloqueio cair (ou o SES entrar, que fala SMTP), voltar tem que ser mudanca de VARIAVEL,
// nao de codigo. E exatamente o mesmo desenho de providers/email/index.js, o adaptador
// transacional, onde esse preco ja foi pago uma vez.
//
// ── O QUE ELA ROTEIA, e por que sao DUAS coisas e nao uma ──
//
//   enviar()               o envio em si.
//   credenciaisFaltando()  o que falta para este transporte poder enviar.
//
// A segunda e tao importante quanto a primeira, e e o erro mais facil de cometer aqui. O
// PRE-VOO do disparo (lib/dispararPromocao.verificarPreCondicoesDisparo) chama
// credenciaisFaltando() para barrar uma campanha que sairia so em falha. Se a fachada
// roteasse `enviar` para a API mas `credenciaisFaltando` continuasse apontando para o SMTP,
// o pre-voo aprovaria um ambiente com SMTP_CAMPANHA_* preenchidas e EMAILIT_API_KEY VAZIA —
// e a campanha inteira seria materializada para nunca sair: a varredura reconhece credencial
// ausente como erro de configuracao e aborta o ciclo (ver lib/classificarErroEnvio), de novo
// e de novo, a cada 15 min. Ninguem e marcado como falha, e ninguem recebe. As duas funcoes
// PRECISAM sair do mesmo implementador; e por isso que as duas passam por aqui.
//
// ── SELECAO ──
// `config.provedores.emailCampanha.transporte` (env EMAIL_CAMPANHA_TRANSPORTE), lido a CADA
// chamada e nao no load do modulo: o teste precisa conseguir trocar o transporte em runtime,
// e congelar no require tornaria isso impossivel sem limpar o cache de modulos.
//
// Valor desconhecido NAO cai silenciosamente num default. Um typo em
// EMAIL_CAMPANHA_TRANSPORTE que resultasse em "manda por SMTP mesmo" reproduziria o bug que
// este incremento existe para consertar, e o sintoma (502 depois de 120 s) nao aponta para a
// variavel. Melhor falhar alto, no primeiro envio.

const { config } = require('../../config');

// `api` continua sendo o Emailit por compatibilidade: o valor ja esta em uso e trocar o
// significado de uma string existente faria um ambiente nao atualizado mudar de provedor
// sozinho. O ZeptoMail entra com nome proprio.
const adaptadores = {
  zeptomail: () => require('./zeptomail'),
  api: () => require('./emailit_api'),
  smtp: () => require('./smtp'),
};

// O DEFAULT NAO MUDA NESTE COMMIT. A troca de transporte em producao e decisao de deploy,
// feita por variavel de ambiente (EMAIL_CAMPANHA_TRANSPORTE=zeptomail) depois da validacao
// pelo botao de e-mail de teste — e nao um efeito colateral de subir codigo. Enquanto isso
// nao acontece, tudo continua saindo pelo Emailit, exatamente como antes deste commit.
const PADRAO = 'api';

function selecionar() {
  const nome = config.provedores.emailCampanha.transporte || PADRAO;
  const carregar = adaptadores[nome];
  if (!carregar) {
    throw new Error(
      `Transporte de e-mail de campanha desconhecido: "${nome}". ` +
        `Valores validos para EMAIL_CAMPANHA_TRANSPORTE: ${Object.keys(adaptadores).join(', ')}.`,
    );
  }
  return carregar();
}

// Repassa `opcoes` INTEGRAL, incluindo os campos que so um dos transportes entende
// (`transporter` no SMTP, `httpClient` na API). A fachada nao valida nem filtra: o campo
// irrelevante e ignorado pelo adaptador que o recebe, e filtrar aqui obrigaria esta camada
// a conhecer o vocabulario dos dois — que e justamente o acoplamento que ela evita.
async function enviar(destinatario, assunto, html, opcoes = {}) {
  return selecionar().enviar(destinatario, assunto, html, opcoes);
}

function credenciaisFaltando() {
  return selecionar().credenciaisFaltando();
}

module.exports = { enviar, credenciaisFaltando, selecionar };
