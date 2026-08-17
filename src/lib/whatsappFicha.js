'use strict';

// Leitura, para a ficha do candidato, do estado da sequencia WA1/WA2 e da confirmacao
// manual do video. Funcoes PURAS — recebem as linhas ja lidas do banco e devolvem o que a
// tela precisa mostrar.
//
// Separado de routes/admin.js porque e a parte que tem REGRA (o que e "dentro do prazo",
// quando o botao pode aparecer) e portanto merece teste proprio, sem subir servidor.

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

const FUSO_BRASILIA = 'America/Sao_Paulo';

// Offset de `timeZone` (em minutos, negativo para fusos atras de UTC) NO INSTANTE `data`.
// Consultado via Intl em vez de hardcodado: Brasil nao tem horario de verao desde 2019, mas
// hardcodar '-03:00' seria apostar que essa regra nunca muda. `longOffset` devolve algo como
// "GMT-03:00", que a regex abaixo decompoe.
function offsetMinutos(data, timeZone) {
  const partes = new Intl.DateTimeFormat('en-US', { timeZone, timeZoneName: 'longOffset' }).formatToParts(data);
  const nome = (partes.find((p) => p.type === 'timeZoneName') || {}).value || 'GMT+00:00';
  const m = nome.match(/GMT([+-])(\d{2}):(\d{2})/);
  if (!m) return 0;
  const sinal = m[1] === '-' ? -1 : 1;
  return sinal * (Number(m[2]) * 60 + Number(m[3]));
}

// Meio-dia do dia seguinte ao momento base, horario de Brasilia (America/Sao_Paulo).
//
// Pura: recebe o momento base em UTC, nunca chama o relogio — quem chama passa wa2.enviadoEm.
// O dia CIVIL em Brasilia e o que importa (nao o dia civil em UTC): um envio as 23h de um dia
// em UTC pode ja ser outro dia em Brasilia (UTC-3), e e esse segundo dia que ganha +1.
function calcularPrazoAmanhaMeioDia(momentoBaseUtc) {
  // `new Date(null)` NAO e invalida — vira epoch (1970). null/undefined precisam de guarda
  // propria, senao "sem momento base" silenciosamente produziria um prazo em 1970.
  if (momentoBaseUtc == null) return null;
  const base = momentoBaseUtc instanceof Date ? momentoBaseUtc : new Date(momentoBaseUtc);
  if (Number.isNaN(base.getTime())) return null;

  // Dia civil em Brasilia do momento base, como marcador UTC (so para fazer aritmetica de
  // dia sem depender de fuso da maquina que roda o codigo).
  const partes = new Intl.DateTimeFormat('en-CA', {
    timeZone: FUSO_BRASILIA,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(base);
  const valor = (tipo) => Number(partes.find((p) => p.type === tipo).value);
  const diaCivil = Date.UTC(valor('year'), valor('month') - 1, valor('day'));
  const amanha = new Date(diaCivil + 24 * 60 * 60 * 1000);

  // Instante PROVISORIO: meio-dia de "amanha" tratado como se fosse UTC, so para descobrir
  // o offset de Brasilia valido nesse dia (sem hardcodar o numero).
  const provisorio = new Date(
    Date.UTC(amanha.getUTCFullYear(), amanha.getUTCMonth(), amanha.getUTCDate(), 12, 0, 0),
  );
  const offset = offsetMinutos(provisorio, FUSO_BRASILIA);
  return new Date(provisorio.getTime() - offset * 60 * 1000);
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

// Horario-limite do video: meio-dia do dia seguinte ao envio do WA2, horario de Brasilia.
//
// Devolve null quando o WA2 nao foi enviado — sem envio nao ha prazo, e inventar um a partir
// do agendamento seria cobrar de um relogio que nunca comecou a correr.
function limiteDoVideo(linhas) {
  const wa2 = estadoEtapa(linhas, 'wa2');
  if (!wa2.existe || wa2.status !== 'enviado' || !wa2.enviadoEm) return null;
  const base = paraDataUtc(wa2.enviadoEm);
  if (!base) return null;
  return calcularPrazoAmanhaMeioDia(base);
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
  calcularPrazoAmanhaMeioDia,
  DENTRO_PRAZO_VALIDOS,
};
