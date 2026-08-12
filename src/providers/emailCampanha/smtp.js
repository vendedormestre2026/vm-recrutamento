'use strict';

// Adaptador de e-mail de CAMPANHA (Promocao de Vagas), sobre SMTP generico.
//
// ── POR QUE ESTE MODULO EXISTE, SEPARADO DE providers/email ──
// O adaptador transacional (providers/email, Resend) serve 6 call sites do funil:
// relatorio ao recrutador, recusa, follow-up, lembrete de inicio, retomada e notificacao
// de nova candidatura. Nenhum deles e tocado por este arquivo, e essa e a intencao: o
// envio em massa tem provedor, remetente, reputacao e cabecalhos proprios, e mudar o
// adaptador transacional para acomodar campanha colocaria em risco e-mails que hoje
// funcionam. Sao dois sistemas com o mesmo verbo, nao um sistema com duas opcoes.
//
// ── POR QUE SMTP GENERICO E NAO A API REST DO EMAILIT ──
// Para a migracao ser de CONFIGURACAO, nao de codigo: quando o Amazon SES for aprovado,
// trocam-se host/porta/usuario/senha por credenciais SES (o SES tambem fala SMTP) e
// nenhuma linha daqui muda. Uma integracao com a API proprietaria do Emailit amarraria o
// projeto a ele e transformaria a troca de provedor num reescrever de adaptador.
//
// ── CONTRATO (deliberadamente DIFERENTE do transacional) ──
//   enviar(destinatario, assunto, html, opcoes = {}) -> Promise<{ id }>
//     opcoes.replyTo         (string, opcional)
//     opcoes.headers         (objeto plano de headers EXTRA; somam-se aos automaticos)
//     opcoes.semDescadastro  (bool; valvula de escape — ver montarCabecalhos)
//     opcoes.transporter     (opcional; ponto de injecao — ver abaixo)
//
// Os cabecalhos List-Unsubscribe / List-Unsubscribe-Post (RFC 8058) sao incluidos
// AUTOMATICAMENTE em todo envio. Nao ha caminho de esquecimento: campanha sem opt-out
// valido e problema de entregabilidade, nao de cortesia.
//
// Mesmo ESPIRITO do resto do projeto: async, lanca em erro com mensagem clara, nunca
// engole excecao. Quem chama (a rotina do Incremento 7) decide o que fazer com a falha.

const nodemailer = require('nodemailer');
const { config } = require('../../config');
// Os cabecalhos de opt-out sairam daqui para ./cabecalhos.js: a regra e do DOMINIO
// "e-mail de campanha", nao deste transporte, e agora ha tres transportes consumindo-a.
const { cabecalhosDescadastro, montarCabecalhos } = require('./cabecalhos');

// Transporter em cache. LAZY (criado no primeiro envio, nao no load do modulo) por dois
// motivos: o modulo pode ser carregado num processo que nunca envia campanha (o app
// inteiro carrega este arquivo se alguma rota o importar), e criar no load congelaria a
// config no momento do require — o que atrapalha teste e recarga de configuracao.
let _transporter = null;

// Recorte de mensagem de erro de provedor, para o log nao virar um despejo de SMTP.
const MAX_DETALHE_ERRO = 300;

// FONTE UNICA de "o que falta para uma campanha poder sair": devolve os NOMES das
// variaveis de ambiente ausentes, na ordem em que aparecem no .env.example.
//
// Existe como funcao propria, e nao inline no criarTransporter, porque a mesma pergunta e
// feita em DOIS momentos muito distantes: aqui, no instante do envio, e no PRE-VOO do
// disparo (lib/dispararPromocao), que precisa saber a resposta ANTES de materializar
// centenas de linhas que sairiam todas com falha. Duas listas mantidas em paralelo
// divergiriam no primeiro campo novo — e a divergencia so apareceria como uma campanha
// inteira queimada.
//
// Le a config a CADA chamada (nao captura no load): o pre-voo precisa refletir o estado
// atual do processo, e o teste precisa conseguir esvaziar a config em runtime.
//
// `remetente` entra na lista mesmo tendo default em config.js (ou seja, na pratica nunca
// falta): a lista descreve o que um envio EXIGE, e nao o que costuma estar vazio.
function credenciaisFaltando() {
  const cfg = config.provedores.emailCampanha;

  const faltando = [];
  if (!cfg.host) faltando.push('SMTP_CAMPANHA_HOST');
  if (!cfg.usuario) faltando.push('SMTP_CAMPANHA_USUARIO');
  if (!cfg.senha) faltando.push('SMTP_CAMPANHA_SENHA');
  if (!cfg.remetente) faltando.push('SMTP_CAMPANHA_FROM_EMAIL');
  return faltando;
}

// Cria o transporter a partir da config. Exportada para quem quiser um transporter
// proprio (e para deixar explicito que a fabrica e separada do cache).
// LANCA quando falta credencial: e melhor falhar aqui, alto e claro, do que abrir uma
// conexao que o provedor vai recusar com um erro generico de autenticacao.
//
// Passou a cobrir tambem o REMETENTE (antes so host/usuario/senha), por consequencia de
// usar a lista unica acima. E um aperto deliberado: um transporter de campanha so e
// construido para enviar campanha, e campanha sem remetente nao sai de qualquer forma —
// falhar na construcao e mais cedo e mais claro do que falhar na montagem da mensagem.
function criarTransporter() {
  const cfg = config.provedores.emailCampanha;

  const faltando = credenciaisFaltando();
  if (faltando.length) {
    throw new Error(
      `Credenciais de SMTP de campanha ausentes: ${faltando.join(', ')}. ` +
        'Defina no .env antes de disparar campanhas (o adaptador nao tem fallback para ' +
        'o provedor transacional, de proposito).',
    );
  }

  return nodemailer.createTransport({
    host: cfg.host,
    port: cfg.porta,
    // Ver o comentario extenso em config.js: false + porta 587 = STARTTLS (a conexao
    // sobe para TLS depois do handshake). true e so para a porta 465 (TLS implicito).
    secure: cfg.seguro,
    auth: { user: cfg.usuario, pass: cfg.senha },
  });
}

function obterTransporter() {
  if (!_transporter) _transporter = criarTransporter();
  return _transporter;
}

async function enviar(destinatario, assunto, html, opcoes = {}) {
  // Antes de qualquer coisa que custe conexao: sem destinatario nao ha o que enviar.
  if (!destinatario) {
    throw new Error('Destinatario de e-mail de campanha ausente.');
  }

  const cfg = config.provedores.emailCampanha;
  if (!cfg.remetente) {
    throw new Error(
      'SMTP_CAMPANHA_FROM_EMAIL ausente. Defina o remetente de campanha no .env ' +
        '(subdominio dedicado, verificado no provedor).',
    );
  }

  // Ponto de INJECAO, no mesmo espirito das deps injetaveis de lib/importar_vaga.js:
  // com um transporter fornecido, nada de config de credencial e exigido e nenhuma
  // conexao e aberta. E o que permite ao teste usar o jsonTransport do proprio
  // nodemailer, sem rede e sem dependencia nova.
  const transporter = opcoes.transporter || obterTransporter();

  const mensagem = {
    from: cfg.remetente,
    to: destinatario,
    subject: assunto,
    html,
  };
  if (opcoes.replyTo) mensagem.replyTo = opcoes.replyTo;

  // Depois do transporter de proposito: com credencial faltando, o erro que interessa e
  // o da credencial, nao o do descadastro. So entra na mensagem se houver algo (com
  // semDescadastro e sem headers proprios, o campo nem aparece).
  const headers = montarCabecalhos(destinatario, opcoes);
  if (Object.keys(headers).length) mensagem.headers = headers;

  let info;
  try {
    info = await transporter.sendMail(mensagem);
  } catch (err) {
    throw new Error(
      `Falha ao enviar e-mail de campanha via SMTP: ${String(err && err.message).slice(0, MAX_DETALHE_ERRO)}`,
    );
  }

  return { id: (info && info.messageId) || null };
}

module.exports = {
  enviar,
  criarTransporter,
  credenciaisFaltando,
  // REEXPORTADAS, e nao definidas aqui: as duas mudaram-se para ./cabecalhos.js quando o
  // terceiro transporte chegou (era exatamente o gatilho previsto no comentario que este
  // substitui). Continuam saindo daqui para nao quebrar quem ja as importava deste modulo
  // — hoje so test/emailCampanha.test.js. A reexportacao sai junto com este arquivo,
  // quando o transporte SMTP for removido.
  cabecalhosDescadastro,
  montarCabecalhos,
};
