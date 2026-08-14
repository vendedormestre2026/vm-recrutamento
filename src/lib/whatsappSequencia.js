'use strict';

// Textos da sequencia WA1/WA2. Funcoes PURAS: sem banco, sem rede, sem relogio.
//
// Irmao de lib/whatsapp.js, e de proposito no mesmo estilo — os helpers de borda dali
// (primeiro nome, omissao de empresa, limpeza de espacos) sao reusados por IMPORTACAO e nao
// recopiados. Uma segunda regra de "como omitir empresa" seria a garantia de que as duas
// divergiriam no dia em que uma fosse ajustada.
//
// ── AS DUAS MENSAGENS TEM NATUREZAS DIFERENTES ──
//   WA1  T+0, informativo. NAO pede nada — quem acabou de se candidatar ja fez a acao dele.
//        Uma mensagem automatica que chega junto com o cadastro e ja cobra algo soa como
//        robo de cobranca, e o custo disso e a pessoa sair do processo antes de comecar.
//   WA2  T+4h, pede o video. Aqui a acao E o ponto, e o prazo tem que estar no texto: pedir
//        "o quanto antes" produz resposta em prazo indefinido e ninguem tem base para
//        cobrar depois.
//
// ── O PRAZO VEM DE FORA ──
// `prazoHoras` e parametro, com default 24. Nao ha numero cravado no texto: o valor mora na
// config (WHATSAPP_WA2_PRAZO_HORAS) e quem chama repassa. Hardcodar aqui faria a mudanca do
// prazo exigir deploy de codigo em vez de troca de variavel.

const { primeiroNomeDe, textoEmpresa, limparEspacos } = require('./whatsapp');

// Default do prazo do WA2, em horas. Espelha o default documentado no .env.example; quem
// chama passa o valor da config, e este numero e a rede embaixo.
const PRAZO_HORAS_PADRAO = 24;

// Saudacao com ou sem nome. Duas variantes de FRASE INTEIRA, e nao um placeholder que fica
// vazio: "Olá , tudo bem?" e o tipo de detalhe que denuncia automacao mal-feita, e a
// primeira mensagem do processo e onde isso custa mais caro.
function saudacao(nome) {
  const primeiro = primeiroNomeDe(nome);
  return primeiro ? `Olá, ${primeiro}!` : 'Olá!';
}

// Trecho " para a vaga de X" / " para a vaga de X na EMPRESA", montado conforme o que existe.
//
// A regra de omissao segue lib/whatsapp: sem empresa, o trecho dela some inteiro (nao vira
// "na "); sem vaga, TUDO some — empresa sozinha, sem a vaga que ela qualifica, produziria
// "sua candidatura na Acme", que é vago o suficiente para a pessoa nao saber do que se trata.
function trechoVaga(job) {
  const vaga = String((job && job.titulo) || '').trim();
  if (!vaga) return '';
  const empresa = textoEmpresa(job && job.empresa);
  return empresa ? ` para a vaga de ${vaga} na ${empresa}` : ` para a vaga de ${vaga}`;
}

// Normaliza o prazo. Valor ausente, zero, negativo ou nao-numerico cai no default — um prazo
// de "0 horas" no texto seria pior que o default silencioso, porque a pessoa leria uma
// instrucao impossivel de cumprir.
function horasValidas(prazoHoras) {
  const n = Number(prazoHoras);
  return Number.isFinite(n) && n > 0 ? Math.round(n) : PRAZO_HORAS_PADRAO;
}

// "24 horas" / "1 hora". Plural correto porque o texto vai para uma pessoa, nao para um log.
function textoPrazo(horas) {
  return horas === 1 ? '1 hora' : `${horas} horas`;
}

// ── WA1 — T+0, informativo ──
//
// Confirma o recebimento e diz o que vem a seguir. Sem pedido de acao, sem link, sem prazo.
// Se um dia alguem quiser incluir uma chamada aqui, o comentario do topo explica por que a
// ausencia e deliberada.
function montarTextoWA1(application, job) {
  const linhas = [
    `${saudacao(application && application.nome)} Aqui é da Vendedor Mestre.`,
    '',
    `Recebemos sua candidatura${trechoVaga(job)}. Ela já está com o nosso time.`,
    '',
    'Nos próximos dias você vai receber por aqui os próximos passos do processo. ' +
      'Não precisa fazer nada agora — é só ficar de olho nesta conversa.',
  ];
  return linhas.map((l) => limparEspacos(l)).join('\n');
}

// ── WA2 — T+4h, pede o video de apresentacao ──
//
// O prazo entra no texto por decisao de negocio: sem ele, "assim que puder" vira prazo
// indefinido e nao ha base para a confirmacao manual dizer se veio dentro ou fora do tempo.
//
// A confirmacao e 100% humana (o recrutador marca no painel), entao o texto NAO promete
// nenhuma automacao — nada de "responda com o video e o sistema registra". Prometer o que o
// sistema nao faz e como se perde confianca na primeira vez que nao acontece.
function montarTextoWA2(application, job, prazoHoras) {
  const horas = horasValidas(prazoHoras);
  const linhas = [
    `${saudacao(application && application.nome)} Aqui é da Vendedor Mestre de novo.`,
    '',
    `Para seguir com sua candidatura${trechoVaga(job)}, precisamos de um vídeo curto ` +
      'de apresentação — pode ser gravado aqui mesmo pelo WhatsApp.',
    '',
    'Fale seu nome, sua experiência com vendas e por que quer essa vaga. ' +
      'Até 2 minutos é suficiente.',
    '',
    `Você tem ${textoPrazo(horas)} a partir desta mensagem para enviar. ` +
      'É só responder aqui nesta conversa.',
  ];
  return linhas.map((l) => limparEspacos(l)).join('\n');
}

module.exports = {
  montarTextoWA1,
  montarTextoWA2,
  PRAZO_HORAS_PADRAO,
  // Exportados para teste e para quem precisar do mesmo formato em outro lugar.
  saudacao,
  trechoVaga,
  horasValidas,
  textoPrazo,
};
