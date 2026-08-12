'use strict';

// Fachada do e-mail TRANSACIONAL: escolhe o provedor por configuracao.
//
// Contrato:
//   enviar(destinatario, assunto, html) -> Promise<{ id }>
//
// ── SELECAO POR VARIAVEL, e nao mais hardcoded ──
// Ate a migracao para o ZeptoMail esta fachada tinha um unico adaptador e a selecao era
// literalmente `const nome = 'resend'`. Agora ha dois, e a escolha vem de EMAIL_TRANSPORTE
// — espelhando EMAIL_CAMPANHA_TRANSPORTE, que ja fazia isso do outro lado.
//
// O ganho concreto e ROLLBACK SEM REDEPLOY: se o ZeptoMail recusar entrega, atrasar ou
// devolver erro em producao, voltar ao Resend e trocar uma variavel de ambiente e
// reiniciar — mesmo espirito dos kill-switches do painel, onde a reacao a um problema nao
// pode depender de uma build. E por isso que ./resend.js FICA no repositorio por enquanto,
// mesmo sem ser o default: um plano de rollback que exige commit nao e plano de rollback.
//
// Valor desconhecido NAO cai silenciosamente num default. Um typo em EMAIL_TRANSPORTE que
// resultasse em "manda pelo outro provedor mesmo" e o tipo de coisa cujo sintoma (e-mails
// saindo pelo remetente errado) nao aponta para a variavel. Melhor falhar alto, no
// primeiro envio. Mesma decisao, e mesma justificativa, da fachada de campanha.

const adaptadores = {
  zeptomail: () => require('./zeptomail'),
  resend: () => require('./resend'),
};

const PADRAO = 'zeptomail';

function selecionar() {
  // Lido a CADA chamada, e nao no load do modulo: o teste precisa conseguir trocar o
  // provedor em runtime, e congelar no require tornaria isso impossivel sem limpar o cache
  // de modulos. Mesma razao da fachada de campanha.
  const nome = String(process.env.EMAIL_TRANSPORTE || PADRAO).trim().toLowerCase();
  const carregar = adaptadores[nome];
  if (!carregar) {
    throw new Error(
      `Transporte de e-mail transacional desconhecido: "${nome}". ` +
        `Valores validos para EMAIL_TRANSPORTE: ${Object.keys(adaptadores).join(', ')}.`,
    );
  }
  return carregar();
}

async function enviar(destinatario, assunto, html) {
  return selecionar().enviar(destinatario, assunto, html);
}

module.exports = { enviar, selecionar };
