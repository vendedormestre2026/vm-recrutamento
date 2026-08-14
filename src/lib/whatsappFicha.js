'use strict';

// Leitura, para a ficha do candidato, do estado da sequencia WA1/WA2 e da confirmacao
// manual do video. Funcoes PURAS — recebem as linhas ja lidas do banco e devolvem o que a
// tela precisa mostrar.
//
// Separado de routes/admin.js porque e a parte que tem REGRA (o que e "dentro do prazo",
// quando o botao pode aparecer) e portanto merece teste proprio, sem subir servidor.

const { PRAZO_HORAS_PADRAO } = require('./whatsappSequencia');

// Mesma leitura de fuso do outbox: datetime('now') do SQLite e UTC sem sufixo, e new Date()
// interpretaria como local. Ver a nota extensa em whatsapp/sequenciaOutbox.
function paraDataUtc(valor) {
  if (valor instanceof Date) return valor;
  const s = String(valor || '').trim();
  if (!s) return null;
  const temFuso = /[zZ]$|[+-]\d{2}:?\d{2}$/.test(s);
  const d = new Date(temFuso ? s : `${s.replace(' ', 'T')}Z`);
  return Number.isNaN(d.getTime()) ? null : d;
}

const ROTULO_STATUS = {
  pendente: 'pendente',
  enviado: 'enviado',
  falha: 'falha',
  entregue: 'entregue',
};

// Estado de UMA etapa. `null` quando nao ha linha — e o caso NORMAL das candidaturas
// anteriores a esta feature, e a tela precisa dizer "não se aplica" em vez de quebrar.
function estadoEtapa(linhas, etapa) {
  const l = (linhas || []).find((x) => x.etapa === etapa);
  if (!l) return { existe: false, status: null, rotulo: 'não se aplica', enviadoEm: null, erro: null };
  return {
    existe: true,
    status: l.status,
    rotulo: ROTULO_STATUS[l.status] || l.status,
    enviadoEm: l.enviado_em || null,
    agendadoPara: l.agendado_para || null,
    erro: l.erro || null,
    tentativas: l.tentativas || 0,
  };
}

// Horario-limite do video: wa2.enviado_em + prazo.
//
// Devolve null quando o WA2 nao foi enviado — sem envio nao ha prazo, e inventar um a partir
// do agendamento seria cobrar de um relogio que nunca comecou a correr.
function limiteDoVideo(linhas, prazoHoras = PRAZO_HORAS_PADRAO) {
  const wa2 = estadoEtapa(linhas, 'wa2');
  if (!wa2.existe || wa2.status !== 'enviado' || !wa2.enviadoEm) return null;
  const base = paraDataUtc(wa2.enviadoEm);
  if (!base) return null;
  const horas = Number(prazoHoras) > 0 ? Number(prazoHoras) : PRAZO_HORAS_PADRAO;
  return new Date(base.getTime() + horas * 3600 * 1000);
}

// O botao de confirmacao so faz sentido depois de o WA2 ter SAIDO.
//
// Confirmar recebimento de algo que o sistema nao registra ter enviado seria gravar um dado
// que nao se sustenta — e o painel passaria a afirmar que houve prazo onde nao houve pedido.
function podeConfirmarVideo(linhas) {
  return estadoEtapa(linhas, 'wa2').status === 'enviado';
}

// Situacao do video para exibicao. Le das colunas de `applications`.
//
// Tres estados possiveis, e o terceiro e o que a maioria das fichas vai mostrar:
//   confirmado dentro / fora do prazo   o recrutador ja marcou
//   aguardando                          WA2 saiu, ninguem confirmou ainda
//   não se aplica                       WA2 nunca saiu (ou candidatura antiga)
function situacaoVideo(application, linhas) {
  const recebidoEm = application && application.wa2_video_recebido_em;
  if (recebidoEm) {
    const dentro = application.wa2_video_dentro_prazo;
    const rotulo =
      dentro === 'sim' ? 'recebido, dentro do prazo'
        : dentro === 'nao' ? 'recebido, FORA do prazo'
          : 'recebido (prazo não se aplica)';
    return {
      confirmado: true,
      rotulo,
      dentroPrazo: dentro || 'na',
      em: recebidoEm,
      por: application.wa2_video_confirmado_por || null,
    };
  }
  if (podeConfirmarVideo(linhas)) {
    return { confirmado: false, rotulo: 'aguardando confirmação', dentroPrazo: null, em: null, por: null };
  }
  return { confirmado: false, rotulo: 'não se aplica', dentroPrazo: null, em: null, por: null };
}

// Sugestao de "dentro do prazo" para PRE-MARCAR o formulario.
//
// SUGESTAO, e nao decisao: a confirmacao acontece sempre DEPOIS do fato real — o recrutador
// pode estar marcando as 9h um video que chegou as 23h de ontem, dentro do prazo. Por isso a
// tela deixa ele corrigir. Automatizar isso como verdade produziria "fora do prazo" para
// gente que cumpriu, e o candidato nunca saberia por que foi descartado.
function sugestaoDentroPrazo(limite, agora = new Date()) {
  if (!limite) return 'na';
  return agora.getTime() <= limite.getTime() ? 'sim' : 'nao';
}

const DENTRO_PRAZO_VALIDOS = ['sim', 'nao', 'na'];

module.exports = {
  estadoEtapa,
  limiteDoVideo,
  podeConfirmarVideo,
  situacaoVideo,
  sugestaoDentroPrazo,
  paraDataUtc,
  DENTRO_PRAZO_VALIDOS,
};
