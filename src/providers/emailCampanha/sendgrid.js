'use strict';

// Adaptador de e-mail de CAMPANHA (Promocao de Vagas): SendGrid (Twilio).
//
// Substitui o ZeptoMail NESTE fluxo, e so neste. O ZeptoMail confirmou por e-mail que
// homologa apenas trafego transacional — ele continua atendendo os sete call sites do funil,
// intocado. Contrato IDENTICO ao dos outros tres adaptadores de campanha, de proposito:
//
//   enviar(destinatario, assunto, html, opcoes = {}) -> Promise<{ id }>
//     opcoes.replyTo         (string, opcional)
//     opcoes.headers         (objeto plano de headers EXTRA; somam-se aos automaticos)
//     opcoes.semDescadastro  (bool; valvula de escape — ver ./cabecalhos)
//     opcoes.httpClient      (opcional; ponto de injecao, compativel com fetch)
//
// ── AS QUATRO DIFERENCAS DE FORMA EM RELACAO AO ZEPTOMAIL ──
//
//   destinatario  to: [{ email_address: { address } }]  ->  personalizations: [{ to: [{ email }] }]
//   corpo         htmlbody: "<div>"                     ->  content: [{ type, value }]
//   opt-out       mime_headers: {...}                   ->  headers: {...}   (nome padrao)
//   reply_to      [{ address }]  (lista)                ->  { email }        (objeto unico)
//
// A ultima e a mais facil de errar copiando: as duas APIs usam o mesmo NOME de campo com
// cardinalidades opostas. No SendGrid, a lista chama-se `reply_to_list` e nao pode coexistir
// com `reply_to`.
//
// O opt-out volta a ser o campo `headers` padrao, como no SMTP e no Emailit — o
// `mime_headers` era peculiaridade do ZeptoMail. montarCabecalhos continua devolvendo objeto
// plano em ./cabecalhos.js justamente por isto: o nome do envelope e de cada transporte, o
// CONTEUDO do opt-out e do dominio.
//
// ── POR QUE A CREDENCIAL NAO E REAPROVEITADA DO ZEPTOMAIL ──
// providers/email/zeptomail.js exporta normalizarToken/cabecalhoAuth/pistaDeAuth, e o
// adaptador de campanha do ZeptoMail as importa de la. Aqui NAO: aquelas funcoes sao
// acopladas ao esquema `Zoho-enczapikey`, e importar do bloco transacional de OUTRO provedor
// acoplaria dois fornecedores sem relacao nenhuma. O trio e reescrito local, com o esquema
// e as armadilhas deste provedor. A duplicacao aqui e a coisa certa: e o mesmo argumento que
// mantem os dois zeptomail.js separados.

const { config } = require('../../config');
const { montarCabecalhos } = require('./cabecalhos');

// Endpoint FIXO, sem variavel de ambiente. Ver a nota em config.js (bloco `sendgrid`): as
// duas URLs sobrescreviveis do projeto so serviram para ser digitadas erradas, e o ponto de
// troca que os testes realmente usam e `opcoes.httpClient`, que nao existe em producao.
const ENDPOINT = 'https://api.sendgrid.com/v3/mail/send';

// Mesmo recorte de erro dos outros adaptadores de campanha: a coluna `erro` de
// campanha_envios existe para o Jean entender o que houve, nao para arquivar um HTML de 500
// inteiro.
const MAX_DETALHE_ERRO = 300;

// Esquema de autenticacao do SendGrid. Bearer padrao, ao contrario do ZeptoMail.
const ESQUEMA_AUTH = 'Bearer';

// Chave sem o prefixo, aceitando as duas formas.
//
// Terceira variavel do projeto a precisar disto, e pelo mesmo gesto: a documentacao do
// SendGrid mostra o header inteiro nos exemplos de curl ("Authorization: Bearer SG.xxx"), e
// quem copia leva o rotulo junto — exatamente como o painel do ZeptoMail entregou o
// "Zoho-enczapikey " colado no token. Normalizar torna as duas formas equivalentes; o aviso
// de boot (config.validar) diz qual delas esta em uso, para a bagunca nao ficar invisivel
// porque "esta funcionando".
function normalizarChave(chave) {
  return String(chave || '')
    .trim()
    .replace(new RegExp(`^${ESQUEMA_AUTH}\\s+`, 'i'), '');
}

// Header de Authorization pronto, sempre com UM prefixo.
function cabecalhoAuth(chave) {
  return `${ESQUEMA_AUTH} ${normalizarChave(chave)}`;
}

// Pista de autenticacao anexada a erros 4xx/5xx — TAMANHOS e um marcador de formato, nunca
// o valor.
//
// A versao do ZeptoMail nasceu de um 500 com corpo vazio que nao apontava para nada. Aqui a
// pista carrega um dado a mais, porque este provedor tem um modo de erro que o outro nao
// tinha: a "API Key ID" exibida no painel ao lado da chave. Ela tem cara de credencial, nao
// comeca com "SG.", e produz um 401 generico. `SG.? nao` na mensagem de erro entrega isso na
// primeira leitura.
//
// Nada aqui reconstroi a credencial, e por isso pode ir para log e para a coluna `erro` de
// campanha_envios sem virar vazamento.
function pistaDeAuth(chave) {
  const bruta = String(chave || '');
  const limpa = normalizarChave(bruta);
  return (
    ` [auth: chave ${bruta.length} chars, ${limpa.length} apos normalizar` +
    `${bruta.length !== limpa.length ? ', PREFIXO VEIO COLADO na variavel' : ''}` +
    `, comeca com "SG.": ${/^SG\./i.test(limpa) ? 'sim' : 'NAO'}]`
  );
}

// FONTE UNICA de "o que falta para uma campanha poder sair POR ESTE TRANSPORTE".
//
// Espelha as funcoes de mesmo nome nos outros tres adaptadores — mesma assinatura, mesmo
// contrato (devolve NOMES de variaveis de ambiente ausentes) — porque o PRE-VOO do disparo
// (lib/dispararPromocao) a consome sem saber qual transporte esta ativo. E a fachada
// (./index.js) que roteia. Se as listas divergissem em formato, o pre-voo passaria a mentir
// sobre um dos caminhos.
//
// `remetente` entra na lista mesmo tendo default em config.js, pela mesma razao de la: a
// lista descreve o que um envio EXIGE, nao o que costuma estar vazio. No SendGrid isso pesa
// mais que nos outros: um `from` que nao seja Sender Identity verificada devolve 403.
function credenciaisFaltando() {
  const faltando = [];
  if (!config.provedores.sendgrid.apiKey) faltando.push('SENDGRID_API_KEY');
  if (!config.provedores.emailCampanha.remetente) faltando.push('SMTP_CAMPANHA_FROM_EMAIL');
  return faltando;
}

// Le o corpo da resposta de erro sem nunca lancar por causa da leitura em si: quando a API
// devolve 4xx/5xx, o que interessa e propagar o STATUS com alguma pista do corpo. Se ate a
// leitura falhar, um marcador e melhor que mascarar o erro original com outro.
//
// O corpo do SendGrid vem como { errors: [{ message, field }] }, e a classificacao de erro
// (lib/classificarErroEnvio) le esse texto — inclusive o `field`, que e o que separa
// "endereco ruim daquela pessoa" de "payload nosso quebrado". Por isso o texto vai INTEIRO
// para a mensagem, sem extrair so o `message`: perder o `field` no caminho apagaria a
// distincao antes de ela chegar a quem decide.
async function detalheDoErro(resposta) {
  try {
    const texto = await resposta.text();
    return String(texto || '').slice(0, MAX_DETALHE_ERRO);
  } catch {
    return '(corpo da resposta ilegivel)';
  }
}

async function enviar(destinatario, assunto, html, opcoes = {}) {
  // Antes de qualquer coisa que custe rede: sem destinatario nao ha o que enviar. Mesma
  // ordem e mesma mensagem dos outros adaptadores.
  if (!destinatario) {
    throw new Error('Destinatario de e-mail de campanha ausente.');
  }

  const cfgCampanha = config.provedores.emailCampanha;
  if (!cfgCampanha.remetente) {
    throw new Error(
      'SMTP_CAMPANHA_FROM_EMAIL ausente. Defina o remetente de campanha no .env ' +
        '(dominio verificado no provedor).',
    );
  }

  // Credencial checada ANTES de montar qualquer coisa e antes de tocar a rede — o mesmo
  // "falhar alto e claro" dos outros transportes.
  const faltando = credenciaisFaltando();
  if (faltando.length) {
    throw new Error(
      `Credenciais de campanha ausentes: ${faltando.join(', ')}. ` +
        'Defina no .env antes de disparar campanhas. A chave do SendGrid e a API Key emitida ' +
        'no painel (formato SG.xxxx.yyyy), com permissao de Mail Send.',
    );
  }

  const http = opcoes.httpClient || fetch;

  // Depois da credencial, de proposito: com a chave faltando, o erro que interessa e o da
  // chave, nao o do descadastro. montarCabecalhos LANCA se DESCADASTRO_SECRET faltar — e e
  // essa a intencao, aqui igual aos outros: campanha sem opt-out valido nao sai.
  //
  // No SendGrid o campo volta a chamar-se `headers`, o nome padrao. Vale a ressalva: o
  // provedor RECUSA override de To, From, Subject, Reply-To, CC, BCC, Content-Type e
  // Content-Transfer-Encoding. List-Unsubscribe e List-Unsubscribe-Post nao estao na lista e
  // passam direto. Quem um dia passar `opcoes.headers` com um dos reservados vai levar 400 —
  // nenhum call site faz isso hoje, e a precedencia de montarCabecalhos ("o do chamador
  // vence") e deliberada, entao isto fica como nota, nao como guarda.
  const headers = montarCabecalhos(destinatario, opcoes);

  const corpo = {
    // `personalizations` e o envelope do SendGrid: uma entrada por mensagem. Lista de UM,
    // porque o contrato desta funcao e um destinatario por chamada — e continua sendo. A API
    // aceita ate 1.000, e usar isso aqui mudaria o significado de "enviar" para a varredura,
    // que conta e marca linha por linha.
    personalizations: [{ to: [{ email: destinatario }] }],
    from: { email: cfgCampanha.remetente, name: cfgCampanha.remetenteNome },
    subject: assunto,
    // Array de blocos MIME, e nao uma string: o `htmlbody` do ZeptoMail e o `html` do Resend
    // viram isto.
    content: [{ type: 'text/html', value: html }],
  };

  if (Object.keys(headers).length) corpo.headers = headers;

  // OBJETO UNICO, nao lista — ao contrario do ZeptoMail, onde o campo de mesmo nome e array.
  // A lista do SendGrid chama-se `reply_to_list` e nao pode coexistir com `reply_to`.
  if (opcoes.replyTo) corpo.reply_to = { email: opcoes.replyTo };

  let resposta;
  try {
    resposta = await http(ENDPOINT, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        // Bearer padrao. cabecalhoAuth normaliza uma chave que ja venha com o prefixo colado.
        Authorization: cabecalhoAuth(config.provedores.sendgrid.apiKey),
      },
      body: JSON.stringify(corpo),
    });
  } catch (err) {
    // Falha de TRANSPORTE (DNS, TLS, socket): distinta de "a API respondeu recusando".
    throw new Error(
      `Falha ao enviar e-mail de campanha via API do SendGrid: ${String(err && err.message).slice(0, MAX_DETALHE_ERRO)}`,
    );
  }

  if (!resposta || !resposta.ok) {
    const status = resposta ? resposta.status : 'sem resposta';
    throw new Error(
      `Falha ao enviar e-mail de campanha via API do SendGrid: HTTP ${status} — ` +
        `${await detalheDoErro(resposta)}` +
        pistaDeAuth(config.provedores.sendgrid.apiKey),
    );
  }

  // 202 Accepted, CORPO VAZIO. `resposta.ok` cobre 202 sem tratamento especial (e 2xx), mas
  // o id muda de lugar: sai do corpo e vai para o header X-Message-Id.
  //
  // Nao ha `await resposta.json()` aqui, e nao e esquecimento — seria o unico caminho capaz
  // de transformar um envio ACEITO em excecao. Com a retentativa ligada, isso nao marcaria a
  // pessoa como falha: faria a MESMA pessoa receber o e-mail ate 5 vezes, porque um erro de
  // parse e desconhecido para classificarErroEnvio e portanto retentavel. Depois do 202,
  // nada pode lancar.
  return { id: extrairId(resposta) };
}

// O contrato externo e `{ id }`, e a varredura e o botao de teste contam com isso.
//
// Le do HEADER, e nao do corpo: o 202 do SendGrid nao tem corpo. Tolerante e sem lancar,
// pela mesma disciplina dos outros adaptadores — o id serve a log e rastreio, e uma resposta
// com forma inesperada nao pode virar falha de um e-mail que ja foi aceito.
//
// Aceita tanto um `Headers` de verdade (get case-insensitive, por spec) quanto um duble
// simples de teste que so responda a uma das grafias.
function extrairId(resposta) {
  try {
    const h = resposta && resposta.headers;
    if (!h || typeof h.get !== 'function') return null;
    return h.get('X-Message-Id') || h.get('x-message-id') || null;
  } catch {
    return null;
  }
}

module.exports = {
  enviar,
  credenciaisFaltando,
  extrairId,
  normalizarChave,
  cabecalhoAuth,
  pistaDeAuth,
  ENDPOINT,
  ESQUEMA_AUTH,
};
