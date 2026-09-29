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

// FUSO_BRASILIA e offsetMinutos moravam AQUI e agora vem de lib/fusoBrasilia (modulo-folha).
//
// Motivo da extracao: ganharam um segundo consumidor (lib/entrevistaGrupo, o convite da
// entrevista em grupo) e ha um terceiro previsto. Duas leituras de "que horas sao em Brasilia"
// que divergem produzem horarios diferentes para o mesmo dado, e o sintoma aparece na mensagem
// que chega ao candidato — nao aqui. Ver o cabecalho de lib/fusoBrasilia.
//
// Reexportados no final deste modulo para nao quebrar quem os importava daqui.
const { FUSO_BRASILIA, offsetMinutos } = require('./fusoBrasilia');

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
  if (!l) {
    return { existe: false, status: null, rotulo: 'não se aplica', enviadoEm: null, erro: null, variante: null };
  }
  return {
    existe: true,
    status: l.status,
    rotulo: ROTULO_STATUS[l.status] || l.status,
    enviadoEm: l.enviado_em || null,
    agendadoPara: l.agendado_para || null,
    erro: l.erro || null,
    tentativas: l.tentativas || 0,
    // QUAL texto saiu (so o WA2 tem duas variantes). Precisa vir para ca porque este objeto e a
    // unica leitura da linha que o resto do modulo e a ficha usam — sem esta linha, pediuVideo
    // veria `undefined` em TODA candidatura e concluiria que todas pediram video, reabrindo a
    // confirmacao de video para quem recebeu convite. Foi exatamente o que um teste pegou.
    variante: l.variante || null,
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

// O WA2 desta candidatura PEDIU um video?
//
// ══════════════════════════════════════════════════════════════
// COMO A VARIANTE RESPONDE UMA PERGUNTA SOBRE O PASSADO
// ══════════════════════════════════════════════════════════════
//
// O WA2 pedia video; hoje ele convida para uma entrevista em grupo. As duas mensagens existem
// na mesma tabela, e a ficha precisa saber qual chegou no aparelho DAQUELA pessoa — senao o
// painel oferece "confirmar video recebido" para quem nunca foi convidado a mandar video, e
// deixa de oferecer para quem mandou.
//
// O discriminador e `variante`:
//   NULL              envio ANTERIOR a coluna existir, ou seja, a era do pedido de video.
//   'convite_grupo'   convite com data e link.
//   'sem_reuniao'     aviso de que as datas estao sendo definidas.
//
// Exige status 'enviado': uma linha 'pendente' tem variante NULL tambem, mas ela ainda VAI sair
// — e vai sair como convite. Tratar pendente como "pediu video" faria o painel abrir a
// confirmacao de video para toda candidatura nova.
//
// ── POR QUE ISSO NAO E "ADIVINHAR" ──
// A coluna nasceu junto com a troca da mensagem, no mesmo deploy. Entao NULL + enviado
// significa, sem ambiguidade, "saiu antes da troca". Nao ha janela em que uma mensagem nova
// tenha sido enviada sem variante.
function pediuVideo(linhas) {
  const wa2 = estadoEtapa(linhas, 'wa2');
  return wa2.status === 'enviado' && !wa2.variante;
}

// O bloco/botao de video aparece na ficha?
//
// So para quem REALMENTE foi convidado a mandar video (pediuVideo) ou para quem ja tem
// confirmacao registrada (historico que nao se apaga). Para as candidaturas novas — que
// receberam o convite da entrevista em grupo — o assunto "video" nao existe, e um painel que
// mostra campos que nao valem mais ensina a ignorar o painel.
function mostrarVideo(application, linhas) {
  return Boolean((application && application.wa2_video_recebido_em) || pediuVideo(linhas));
}

// O botao de confirmacao so faz sentido depois de o WA2 ter SAIDO, e SO quando ele pediu video.
//
// Confirmar recebimento de algo que o sistema nao registra ter pedido seria gravar um dado que
// nao se sustenta — e o painel passaria a afirmar que houve prazo onde nao houve pedido. Antes
// da troca da mensagem bastava "o WA2 saiu"; agora sair nao basta, porque o WA2 que sai hoje
// nao pede video nenhum.
function podeConfirmarVideo(linhas) {
  return pediuVideo(linhas);
}

// A pessoa recebeu o FALLBACK (aviso de "datas em breve") em vez do convite?
//
// E a lista de quem precisa ser reconvidado A MAO: nada no sistema reenvia o convite quando a
// data nova e cadastrada, porque o WA2 daquela candidatura ja saiu (UNIQUE por etapa). Sem esta
// leitura, essas pessoas ficariam invisiveis — receberam "te aviso por aqui" e ninguem sabe
// quem sao.
function recebeuFallbackEntrevistaGrupo(linhas) {
  const wa2 = estadoEtapa(linhas, 'wa2');
  return wa2.status === 'enviado' && wa2.variante === 'sem_reuniao';
}

// Rotulo da variante para a ficha. Texto curto; a explicacao fica na tela.
const ROTULO_VARIANTE = {
  convite_grupo: 'convite da entrevista em grupo (com data e link)',
  sem_reuniao: 'aviso de que as datas estão sendo definidas',
};

function rotuloVariante(variante) {
  if (!variante) return null;
  return ROTULO_VARIANTE[variante] || variante;
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
  pediuVideo,
  mostrarVideo,
  recebeuFallbackEntrevistaGrupo,
  rotuloVariante,
  ROTULO_VARIANTE,
  situacaoVideo,
  sugestaoDentroPrazo,
  paraDataUtc,
  calcularPrazoAmanhaMeioDia,
  DENTRO_PRAZO_VALIDOS,
  // Reexportados de lib/fusoBrasilia (onde passaram a morar) para nao quebrar importacoes
  // existentes. Codigo NOVO deve importar do modulo folha, nao daqui.
  FUSO_BRASILIA,
  offsetMinutos,
};
