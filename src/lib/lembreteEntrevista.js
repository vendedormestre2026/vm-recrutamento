'use strict';

// WA3 — o CRONOGRAMA dos lembretes da entrevista em grupo: que reuniao lembrar a quem, e se
// cada lembrete esta para sair, para esperar ou para ser pulado.
//
// Funcoes PURAS: sem banco, sem rede, sem relogio. `agora` e sempre parametro — e o que permite
// testar "faltam 2 horas" sem esperar 2 horas. Mesmo desenho de lib/entrevistaGrupo.
//
// ══════════════════════════════════════════════════════════════
// QUAL REUNIAO LEMBRAR (D1)
// ══════════════════════════════════════════════════════════════
//
// A vaga tem ate 3 reunioes e nao ha controle de presenca. Lembrar todo convidado da proxima
// reuniao faria quem ja participou da reuniao 1 receber os lembretes da 2. A regra aprovada:
//
//   reuniao ANUNCIADA pelo convite = a primeira reuniao com instante >= enviado_em do convite
//
// que e, por construcao, a que o WA2/massa escreveu no texto (os dois usam a proxima reuniao
// futura no momento do envio). Cada pessoa recebe lembretes so da reuniao que lhe foi anunciada.
// Efeito aceito: quem foi convidado para a 1 e faltou nao e lembrado da 2.
//
// ── TETO DE 10 DIAS ──
// Convite enviado mais de 10 dias antes da reuniao fica de fora: e convite velho demais para a
// pessoa ainda contar com ele, e o caso tipico de "a data mudou desde o convite".
//
// ── O SLOT TROCADO (o caso que a regra literal erra) ──
// Reuniao 1 em 01/10, convite em 28/09. A reuniao acontece. O admin SOBRESCREVE o slot 1 com
// 05/10. Lendo so os slots atuais, a primeira reuniao >= 28/09 passa a ser 05/10, e quem foi
// convidado para 01/10 seria lembrado de uma reuniao que ninguem lhe anunciou.
//
// Os slots atuais nao guardam o passado, entao o worker guarda: cada reuniao que ele ve fica
// registrada (lembretes_entrevista_reunioes, com primeira e ultima vez vista). Uma reuniao do
// historico que deixou de existir na vaga ainda conta para decidir "o que o convite anunciou"
// SE ela de fato aconteceu — isto e, ainda estava cadastrada quando o horario dela chegou
// (ultima_vez_vista >= inicio). Uma data digitada errado e corrigida antes da hora nao passa
// nesse criterio, e por isso nao rouba os convidados da data certa.
//
// Limite conhecido: reuniao trocada ANTES de o WA3 ser ligado nao esta no historico. Para esse
// caso sobra o teto de 10 dias.
//
// ══════════════════════════════════════════════════════════════
// QUANDO CADA LEMBRETE SAI
// ══════════════════════════════════════════════════════════════
//
//   wa3a  vespera, 18:00 de Brasilia      tolerancia ate 21:00 da vespera
//   wa3b  2 h antes                        tolerancia de 30 min
//   wa3c  15 min antes                     tolerancia de 10 min
//
// Nenhum sai depois do inicio da reuniao. Janela de envio 07:00–21:00 (Brasilia): fora dela o
// lembrete espera a janela abrir SE ainda couber na tolerancia; senao e pulado. Lembrete pulado
// e registrado com o motivo (a tela mostra), e nunca e adiado para alem da tolerancia — "faltam
// 15 minutos" enviado meia hora depois e informacao errada.
//
// Convite enviado DEPOIS do horario de um lembrete: esse lembrete e pulado. A pessoa acabou de
// receber o convite com data e link; o lembrete atrasado repetiria o convite.

const { instanteDeBrasilia, partesBrasilia } = require('./fusoBrasilia');
const { lerEntrevistasGrupo, OK } = require('./entrevistaGrupo');

const WA3A = 'wa3a';
const WA3B = 'wa3b';
const WA3C = 'wa3c';
const TIPOS = Object.freeze([WA3A, WA3B, WA3C]);

const MINUTO_MS = 60 * 1000;
const DIA_MS = 24 * 60 * MINUTO_MS;

const TETO_CONVITE_DIAS = 10;

// Carencia apos a PRIMEIRA vez que o worker ve uma reuniao (ajuste aprovado): protege contra uma
// data digitada errado que caia dentro de uma janela de envio — o admin tem 10 min para notar e
// corrigir antes de qualquer mensagem sair.
const CARENCIA_MIN = 10;

// Janela de envio, em minutos desde a meia-noite de Brasilia. Fim EXCLUSIVO: 21:00 ja nao envia.
const JANELA_INICIO_MIN = 7 * 60;
const JANELA_FIM_MIN = 21 * 60;

const ACAO_ENVIAR = 'enviar';
const ACAO_AGUARDAR = 'aguardar';
const ACAO_PULAR = 'pular';

const MOTIVO_ATRASADO = 'atrasado';
const MOTIVO_CONVITE_DEPOIS = 'convite_depois';
const MOTIVO_FORA_JANELA = 'fora_janela';

function comoData(v) {
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? null : v;
  if (v == null || v === '') return null;
  const s = String(v).trim();
  // Texto do SQLite ('YYYY-MM-DD HH:MM:SS') e UTC sem sufixo — ver paraDataUtc em
  // whatsapp/sequenciaOutbox.js. Sem o 'Z', o JS leria como hora local da maquina.
  const temFuso = /[zZ]$|[+-]\d{2}:?\d{2}$/.test(s);
  const d = new Date(temFuso ? s : `${s.replace(' ', 'T')}Z`);
  return Number.isNaN(d.getTime()) ? null : d;
}

// Link da sala (Google Meet) da vaga, ou ''. Nao confundir com link_meet, que e o Calendly.
function linkSalaDe(vaga) {
  return String((vaga && vaga.link_meet_reuniao) || '').trim();
}

// As reunioes VALIDAS cadastradas hoje na vaga, em ordem cronologica: [{ indice, instante }].
function reunioesDaVaga(vaga) {
  return lerEntrevistasGrupo(vaga)
    .filter((s) => s.estado === OK)
    .map((s) => ({ indice: s.indice, instante: s.instante }))
    .sort((a, b) => a.instante.getTime() - b.instante.getTime());
}

// Linha do tempo das reunioes da vaga para decidir o que um convite anunciou: as atuais mais as
// do historico que ACONTECERAM (ver o cabecalho). `historico`: [{ inicio, ultima_vez_vista }],
// com instantes em Date ou no texto UTC do SQLite. Devolve instantes (Date) unicos, ordenados.
function linhaDoTempo(atuais, historico = []) {
  const vistos = new Map();
  for (const r of atuais || []) {
    const d = comoData(r && (r.instante || r.inicio));
    if (d) vistos.set(d.getTime(), d);
  }
  for (const h of historico || []) {
    const inicio = comoData(h && h.inicio);
    const ultima = comoData(h && h.ultima_vez_vista);
    if (!inicio || !ultima) continue;
    if (ultima.getTime() >= inicio.getTime()) vistos.set(inicio.getTime(), inicio);
  }
  return [...vistos.values()].sort((a, b) => a.getTime() - b.getTime());
}

// A reuniao que o convite enviado em `conviteEm` anunciou (Date), ou null. Aplica o teto.
function reuniaoAnunciada(conviteEm, instantes, { tetoDias = TETO_CONVITE_DIAS } = {}) {
  const convite = comoData(conviteEm);
  if (!convite) return null;
  const primeira = (instantes || []).find((d) => d.getTime() >= convite.getTime());
  if (!primeira) return null;
  if (primeira.getTime() - convite.getTime() > tetoDias * DIA_MS) return null;
  return primeira;
}

// Dia civil anterior em Brasilia, 'YYYY-MM-DD'. Feito pelo calendario (Date.UTC com dia - 1), e
// nao subtraindo 24 h do instante: a vespera e um DIA, nao um intervalo.
function vesperaDe(inicio) {
  const p = partesBrasilia(inicio);
  const d = new Date(Date.UTC(p.ano, p.mes - 1, p.dia - 1));
  const dois = (n) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}-${dois(d.getUTCMonth() + 1)}-${dois(d.getUTCDate())}`;
}

// { devido, limite } (Date) de um tipo de lembrete para a reuniao que comeca em `inicio`.
// `limite` e o ultimo instante em que o lembrete ainda pode sair, NUNCA depois do inicio.
function prazoDoLembrete(tipo, inicio) {
  const ini = comoData(inicio);
  if (!ini) return null;
  let devido;
  let limite;
  if (tipo === WA3A) {
    const vespera = vesperaDe(ini);
    devido = instanteDeBrasilia(vespera, '18:00');
    limite = instanteDeBrasilia(vespera, '21:00');
  } else if (tipo === WA3B) {
    devido = new Date(ini.getTime() - 120 * MINUTO_MS);
    limite = new Date(devido.getTime() + 30 * MINUTO_MS);
  } else if (tipo === WA3C) {
    devido = new Date(ini.getTime() - 15 * MINUTO_MS);
    limite = new Date(devido.getTime() + 10 * MINUTO_MS);
  } else {
    return null;
  }
  if (limite.getTime() > ini.getTime()) limite = ini;
  return { devido, limite };
}

function dentroDaJanela(agora) {
  const p = partesBrasilia(agora);
  return Boolean(p) && p.minutosDoDia >= JANELA_INICIO_MIN && p.minutosDoDia < JANELA_FIM_MIN;
}

// Proximo instante >= agora em que a janela esta aberta.
function proximaAberturaDaJanela(agora) {
  if (dentroDaJanela(agora)) return agora;
  const p = partesBrasilia(agora);
  const dois = (n) => String(n).padStart(2, '0');
  const hoje = `${p.ano}-${dois(p.mes)}-${dois(p.dia)}`;
  if (p.minutosDoDia < JANELA_INICIO_MIN) return instanteDeBrasilia(hoje, '07:00');
  const amanha = new Date(Date.UTC(p.ano, p.mes - 1, p.dia + 1));
  return instanteDeBrasilia(
    `${amanha.getUTCFullYear()}-${dois(amanha.getUTCMonth() + 1)}-${dois(amanha.getUTCDate())}`,
    '07:00',
  );
}

// O que fazer com UM lembrete agora: { acao, motivo, devido, limite }.
//
// Ordem das regras, e por que: "ainda nao chegou a hora" vem primeiro (nada a decidir); depois
// o convite atrasado (pular e definitivo, independe do relogio); depois a tolerancia; por fim a
// janela, que pode so pedir para esperar.
function situacaoLembrete({ tipo, inicio, conviteEm, agora }) {
  const prazo = prazoDoLembrete(tipo, inicio);
  const ref = comoData(agora);
  if (!prazo || !ref) return { acao: ACAO_AGUARDAR, motivo: null, devido: null, limite: null };
  const { devido, limite } = prazo;
  const base = { devido, limite };

  if (ref.getTime() < devido.getTime()) return { ...base, acao: ACAO_AGUARDAR, motivo: null };

  const convite = comoData(conviteEm);
  if (convite && convite.getTime() > devido.getTime()) {
    return { ...base, acao: ACAO_PULAR, motivo: MOTIVO_CONVITE_DEPOIS };
  }

  if (ref.getTime() > limite.getTime()) return { ...base, acao: ACAO_PULAR, motivo: MOTIVO_ATRASADO };

  if (dentroDaJanela(ref)) return { ...base, acao: ACAO_ENVIAR, motivo: null };

  const abre = proximaAberturaDaJanela(ref);
  if (abre && abre.getTime() <= limite.getTime()) return { ...base, acao: ACAO_AGUARDAR, motivo: null };
  return { ...base, acao: ACAO_PULAR, motivo: MOTIVO_FORA_JANELA };
}

// A reuniao ja foi vista ha pelo menos CARENCIA_MIN minutos?
function carenciaCumprida(primeiraVezVista, agora, minutos = CARENCIA_MIN) {
  const primeira = comoData(primeiraVezVista);
  const ref = comoData(agora);
  if (!primeira || !ref) return false;
  return ref.getTime() - primeira.getTime() >= minutos * MINUTO_MS;
}

module.exports = {
  WA3A,
  WA3B,
  WA3C,
  TIPOS,
  TETO_CONVITE_DIAS,
  CARENCIA_MIN,
  JANELA_INICIO_MIN,
  JANELA_FIM_MIN,
  ACAO_ENVIAR,
  ACAO_AGUARDAR,
  ACAO_PULAR,
  MOTIVO_ATRASADO,
  MOTIVO_CONVITE_DEPOIS,
  MOTIVO_FORA_JANELA,
  comoData,
  linkSalaDe,
  reunioesDaVaga,
  linhaDoTempo,
  reuniaoAnunciada,
  vesperaDe,
  prazoDoLembrete,
  dentroDaJanela,
  proximaAberturaDaJanela,
  situacaoLembrete,
  carenciaCumprida,
};
