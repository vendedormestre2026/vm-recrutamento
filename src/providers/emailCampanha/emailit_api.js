'use strict';

// Adaptador de e-mail de CAMPANHA sobre a API REST do Emailit (HTTPS).
//
// ── POR QUE ESTE MODULO EXISTE, tendo smtp.js ao lado ──
// Nao e preferencia de estilo: o Railway BLOQUEIA egress SMTP neste servico. Probe TCP de
// dentro do container (2026-08-10) mostrou 587, 465 e 2525 em timeout contra Emailit, Gmail
// E SendGrid — ou seja, e politica de plataforma, nao problema do provedor —, enquanto
// api.emailit.com:443 abre em ~190 ms. Com SMTP bloqueado, o adaptador anterior nao falhava
// rapido e claro: ele pendurava a requisicao por 120 s (default do nodemailer) ate o proxy
// devolver 502, e so entao logava o erro. HTTPS e o unico transporte que sai daqui.
//
// smtp.js CONTINUA NO REPOSITORIO e continua correto. Ele volta a ser o default trocando
// EMAIL_CAMPANHA_TRANSPORTE=smtp, no dia em que o Railway liberar a porta ou o SES entrar.
//
// ── CONTRATO — IDENTICO ao de smtp.js, de proposito ──
//   enviar(destinatario, assunto, html, opcoes = {}) -> Promise<{ id }>
//     opcoes.replyTo         (string, opcional)
//     opcoes.headers         (objeto plano de headers EXTRA; somam-se aos automaticos)
//     opcoes.semDescadastro  (bool; valvula de escape — mesma semantica)
//     opcoes.httpClient      (opcional; ponto de injecao — ver abaixo)
//
// A unica diferenca e o ultimo campo. `opcoes.transporter` (o transporter do nodemailer)
// nao tem significado numa API REST, entao virou `opcoes.httpClient`: uma funcao
// COMPATIVEL COM fetch — httpClient(url, init) -> Promise<{ ok, status, text() }>. O
// proposito e o mesmo que o transporter servia: deixar o teste exercitar a montagem REAL da
// requisicao sem abrir socket. Escolhi a assinatura do fetch (e nao um objeto com metodo
// proprio) porque o default e o proprio fetch global do Node 20, entao o dublê do teste e
// intercambiavel com a coisa real, sem camada de adaptacao no meio.
//
// Os cabecalhos List-Unsubscribe / List-Unsubscribe-Post continuam AUTOMATICOS, e pela
// MESMA funcao que o adaptador SMTP usa (montarCabecalhos, agora em ./cabecalhos) — nao ha
// copia. Se a regra de opt-out mudar, ela muda uma vez e vale para os dois transportes.

const { config } = require('../../config');
const { montarCabecalhos } = require('./cabecalhos');

// Recorte da resposta de erro do provedor guardada na mensagem da excecao. Mesmo espirito
// do MAX_DETALHE_ERRO de smtp.js: a coluna `erro` de campanha_envios existe para o Jean
// entender o que houve, nao para arquivar um HTML de 500 inteiro.
const MAX_DETALHE_ERRO = 300;

// FONTE UNICA de "o que falta para uma campanha poder sair POR ESTE TRANSPORTE".
//
// Espelha deliberadamente a funcao de mesmo nome em smtp.js — mesma assinatura, mesmo
// contrato (devolve NOMES de variaveis de ambiente ausentes) — porque o PRE-VOO do disparo
// (lib/dispararPromocao) a consome sem saber qual transporte esta ativo. E a fachada
// (./index.js) que faz o roteamento. Se as duas listas divergissem em formato, o pre-voo
// passaria a mentir sobre um dos dois caminhos.
//
// `remetente` entra na lista mesmo tendo default em config.js, pela mesma razao de la: a
// lista descreve o que um envio EXIGE, nao o que costuma estar vazio.
function credenciaisFaltando() {
  const cfg = config.provedores.emailCampanha;

  const faltando = [];
  if (!cfg.apiKey) faltando.push('EMAILIT_API_KEY');
  if (!cfg.remetente) faltando.push('SMTP_CAMPANHA_FROM_EMAIL');
  return faltando;
}

// Le o corpo da resposta de erro sem nunca lancar por causa da leitura em si: quando a API
// devolve 4xx/5xx, o que interessa e propagar o STATUS com alguma pista do corpo. Se ate a
// leitura falhar, um marcador e melhor que mascarar o erro original com outro.
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
  // ordem e mesma mensagem de smtp.js.
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

  // Credencial checada ANTES de montar qualquer coisa e antes de tocar a rede — o mesmo
  // "falhar alto e claro" que criarTransporter faz no lado SMTP. Uma requisicao sem Bearer
  // voltaria como 401 generico, que nao diz a ninguem qual variavel preencher.
  const faltando = credenciaisFaltando();
  if (faltando.length) {
    throw new Error(
      `Credenciais da API de campanha ausentes: ${faltando.join(', ')}. ` +
        'Defina no .env antes de disparar campanhas. A chave de API do Emailit e ' +
        'DIFERENTE do usuario/senha de SMTP: ela e emitida no painel do provedor.',
    );
  }

  const http = opcoes.httpClient || fetch;

  const corpo = {
    from: cfg.remetente,
    to: destinatario,
    subject: assunto,
    html,
  };
  if (opcoes.replyTo) corpo.reply_to = opcoes.replyTo;

  // Depois da credencial, de proposito: com a chave faltando, o erro que interessa e o da
  // chave, nao o do descadastro. montarCabecalhos LANCA se DESCADASTRO_SECRET faltar — e e
  // essa a intencao, aqui igual ao SMTP: campanha sem opt-out valido nao sai.
  const headers = montarCabecalhos(destinatario, opcoes);
  if (Object.keys(headers).length) corpo.headers = headers;

  let resposta;
  try {
    resposta = await http(cfg.apiUrl, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${cfg.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(corpo),
    });
  } catch (err) {
    // Falha de TRANSPORTE (DNS, TLS, socket): distinta de "a API respondeu recusando".
    throw new Error(
      `Falha ao enviar e-mail de campanha via API do Emailit: ${String(err && err.message).slice(0, MAX_DETALHE_ERRO)}`,
    );
  }

  if (!resposta || !resposta.ok) {
    const status = resposta ? resposta.status : 'sem resposta';
    throw new Error(
      `Falha ao enviar e-mail de campanha via API do Emailit: HTTP ${status} — ` +
        `${await detalheDoErro(resposta)}`,
    );
  }

  // 2xx = aceito pelo provedor. A partir daqui, nada que dependa de PARSEAR o corpo pode
  // transformar um envio bem-sucedido em erro: o e-mail ja foi aceito, e devolver excecao
  // faria a varredura tratar como falha alguem que de fato vai receber. Com a retentativa,
  // o estrago mudou de forma e nao diminuiu — um erro de parse aqui e desconhecido para
  // classificarErroEnvio, logo retentavel, logo a MESMA pessoa receberia o e-mail ate 5
  // vezes. Trocar "nao recebe" por "recebe cinco vezes" nao e melhora nenhuma.
  let dados = null;
  try {
    dados = await resposta.json();
  } catch {
    dados = null;
  }

  // O contrato externo e `{ id }`. Preferimos `message_id` (o Message-ID SMTP que a API
  // devolve) porque e o equivalente EXATO do que smtp.js devolvia via info.messageId —
  // trocar de transporte nao deveria mudar o significado do campo. `id` (em_...) e o
  // handle interno do Emailit e serve de fallback.
  return { id: (dados && (dados.message_id || dados.id)) || null };
}

module.exports = {
  enviar,
  credenciaisFaltando,
};
