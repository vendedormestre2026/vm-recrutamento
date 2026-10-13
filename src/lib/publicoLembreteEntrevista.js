'use strict';

// WA3 — QUEM recebe os lembretes de cada reuniao futura de UMA vaga.
//
// O coracao (montarPublicoLembrete) e PURO: recebe a vaga, os convites ja lidos do banco, o
// historico de reunioes vistas e o `agora`. carregarPublicoLembrete e o atalho que le do banco.
//
// ══════════════════════════════════════════════════════════════
// AS REGRAS, NA ORDEM EM QUE SAO APLICADAS
// ══════════════════════════════════════════════════════════════
//
//   1. CONVITE. Recebeu o convite da entrevista em grupo desta vaga: WA2 'convite_grupo' ou item
//      de massa enviado. Massa de SEGMENTO fica fora — e convite para se candidatar, nao para a
//      entrevista (e o item grava a vaga de ORIGEM, nao a vaga-alvo).
//   2. TELEFONE com ida e volta da normalizacao (mesmo contrato de telefoneUtilizavel, sem o log
//      por exclusao: o tick e de 1 min, e um aviso por minuto por telefone ruim afogaria o log).
//   3. PESSOA = chave canonica do telefone. Duas candidaturas, ou o mesmo celular com e sem o 9,
//      sao UMA pessoa e recebem UM lembrete.
//   4. STATUS DO RECRUTADOR (D2): so sem_decisao e em_analise. Se QUALQUER candidatura convidada
//      da pessoa nesta vaga ja foi decidida (aprovado, reprovado) ou tem status desconhecido, a
//      pessoa sai — decisao tomada nao se lembra de entrevista.
//   5. REUNIAO ANUNCIADA (D1): cada convite vale so para a reuniao que ele anunciou (primeira
//      >= enviado_em, teto de 10 dias, historico de slots — ver lib/lembreteEntrevista). A pessoa
//      entra na lista de uma reuniao futura se algum convite dela anunciou aquela reuniao.
//
// ── OPT-OUT (D3) FICA FORA DE montarPublicoLembrete, DE PROPOSITO ──
// O publico e montado a cada tick e tambem pela previa da tela; o opt-out tem que ser consultado
// NO ENVIO (alguem pode pedir para sair entre um tick e outro). Por isso ele e uma funcao a parte,
// suprimidoPorOptout, que o worker chama por destinatario e a previa chama para contar.
//   houve WA2  -> escopo transacional: so `total` suprime; tabela antiga NAO e lida (a mesma
//                 decisao do transacional WA1/WA2, ver sequenciaOutbox.js:346-354)
//   so massa   -> escopo campanha: qualquer opt-out da tabela nova, e tambem a tabela antiga
//                 sem escopo — exatamente o que a massa respeitou ao mandar o convite.

const dbPadrao = require('../db');
const { normalizarTelefoneWhatsapp, normalizarTelefoneRecebido } = require('./whatsapp');
const { chaveCanonicaTelefone } = require('./chaveTelefone');
const { normalizarStatusRecrutador } = require('./elegibilidadeStatusPromocao');
const { fonteDaCampanhaMassaWa, FONTE_VAGAS_ABERTAS } = require('./publicoMassaWhatsapp');
const { reunioesDaVaga, linhaDoTempo, reuniaoAnunciada, comoData } = require('./lembreteEntrevista');
const { paraTextoSqlUtc } = require('./fusoBrasilia');
const optout = require('./optoutWhatsapp');

const STATUS_QUE_RECEBEM = Object.freeze(['sem_decisao', 'em_analise']);

// Telefone discavel ou null. O cadastro (applications.telefone) primeiro; se ele nao sobreviver,
// o da fila (ja normalizado), pelo caminho "ja recebido" — nunca normalizarTelefoneWhatsapp sobre
// um numero ja com DDI, que prefixaria 55 de novo (ver sequenciaOutbox.js:296-301).
function telefoneDe(convite) {
  const doCadastro = normalizarTelefoneWhatsapp(convite.telefone);
  if (doCadastro && normalizarTelefoneRecebido(doCadastro) === doCadastro) return doCadastro;
  const daFila = normalizarTelefoneRecebido(convite.telefone_fila);
  return daFila || null;
}

function funilVazio() {
  return {
    convites: 0,
    convitesSegmento: 0,
    convitesSemTelefone: 0,
    convitesSemReuniaoAnunciada: 0,
    pessoas: 0,
    pessoasStatusExcluido: 0,
  };
}

// Devolve { reunioes: [{ inicio: Date, inicioUtc, indice, destinatarios: [...] }], funil }.
//
// Destinatario: { applicationId, nome, telefone, telefoneCanonico, conviteEm (Date, o convite
// MAIS ANTIGO que anunciou esta reuniao), houveWa2 }.
function montarPublicoLembrete(job, { convites = [], historico = [], agora = new Date() } = {}) {
  const funil = funilVazio();
  const ref = comoData(agora) || new Date();
  const atuais = reunioesDaVaga(job);
  const tempo = linhaDoTempo(atuais, historico);
  const futuras = atuais.filter((r) => r.instante.getTime() > ref.getTime());

  const pessoas = new Map();
  for (const c of convites) {
    funil.convites += 1;
    if (c.origem === 'massa' && fonteDaCampanhaMassaWa(c) !== FONTE_VAGAS_ABERTAS) {
      funil.convitesSegmento += 1;
      continue;
    }
    const telefone = telefoneDe(c);
    const canonico = telefone && chaveCanonicaTelefone(telefone);
    if (!canonico) {
      funil.convitesSemTelefone += 1;
      continue;
    }

    let p = pessoas.get(canonico);
    if (!p) {
      p = { canonico, telefone, nome: '', applicationId: null, houveWa2: false, bloqueada: false, porReuniao: new Map() };
      pessoas.set(canonico, p);
    }
    if (!STATUS_QUE_RECEBEM.includes(normalizarStatusRecrutador(c.status_recrutador))) p.bloqueada = true;
    if (c.origem === 'wa2') p.houveWa2 = true;

    const anunciada = reuniaoAnunciada(c.convite_em, tempo);
    if (!anunciada) {
      funil.convitesSemReuniaoAnunciada += 1;
      continue;
    }
    const conviteEm = comoData(c.convite_em);
    const atual = p.porReuniao.get(anunciada.getTime());
    if (!atual || conviteEm.getTime() < atual.conviteEm.getTime()) {
      p.porReuniao.set(anunciada.getTime(), { conviteEm, applicationId: c.application_id, nome: c.nome });
    }
  }

  funil.pessoas = pessoas.size;
  const elegiveis = [];
  for (const p of pessoas.values()) {
    if (p.bloqueada) funil.pessoasStatusExcluido += 1;
    else elegiveis.push(p);
  }

  const reunioes = futuras.map((r) => {
    const destinatarios = [];
    for (const p of elegiveis) {
      const conv = p.porReuniao.get(r.instante.getTime());
      if (!conv) continue;
      destinatarios.push({
        applicationId: conv.applicationId,
        nome: String(conv.nome || '').trim(),
        telefone: p.telefone,
        telefoneCanonico: p.canonico,
        conviteEm: conv.conviteEm,
        houveWa2: p.houveWa2,
      });
    }
    return { inicio: r.instante, inicioUtc: paraTextoSqlUtc(r.instante), indice: r.indice, destinatarios };
  });

  return { reunioes, funil };
}

// Le do banco e monta. `deps.db` injetavel.
function carregarPublicoLembrete(job, { agora = new Date() } = {}, deps = {}) {
  const db = deps.db || dbPadrao;
  return montarPublicoLembrete(job, {
    convites: db.listarConvitesEntrevistaGrupo(job.id),
    historico: db.listarReunioesVistasLembrete(job.id),
    agora,
  });
}

// Carrega o estado de opt-out UMA vez por ciclo: { mapa (tabela nova, ja respeitando o
// kill-switch), antigo (Set da tabela sem escopo) }.
function carregarOptout(deps = {}) {
  const db = deps.db || dbPadrao;
  return { mapa: optout.mapaOptoutAtivo({ db }), antigo: db.listarTelefonesOptOutWhatsapp() };
}

// O destinatario esta suprimido para ESTE lembrete?
function suprimidoPorOptout(dest, tipo, { mapa, antigo } = {}) {
  const escopo = optout.escopoDoLembreteEntrevista(tipo, { houveWa2: dest.houveWa2 });
  if (optout.optoutAtivoNoMapa(mapa, dest.telefone, escopo)) return true;
  if (escopo !== optout.CONSULTA_CAMPANHA || !antigo || !antigo.size) return false;
  return antigo.has(dest.telefone) || antigo.has(dest.telefoneCanonico);
}

module.exports = {
  STATUS_QUE_RECEBEM,
  carregarOptout,
  suprimidoPorOptout,
  montarPublicoLembrete,
  carregarPublicoLembrete,
  telefoneDe,
};
