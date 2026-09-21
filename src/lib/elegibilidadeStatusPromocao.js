'use strict';

// Elegibilidade por STATUS DO RECRUTADOR para campanhas de PROMOCAO DE NOVAS VAGAS.
//
// Ponto UNICO da regra, reutilizado pelos dois canais (WhatsApp e e-mail), na montagem do
// publico E na reverificacao no momento do envio. Se cada canal tivesse a sua copia, a
// primeira divergencia seria alguem aprovado recebendo divulgacao por um canal e nao pelo
// outro — e ninguem perceberia ate a pessoa reclamar.
//
// ── A REGRA ──
// So recebe divulgacao de vaga nova quem esta em "Sem decisao" ou "Reprovado". Qualquer
// outra coisa — Aprovado, Em analise, ou um valor que nao reconhecemos — fica de fora.
// FAIL-CLOSED: valor ilegivel NAO entra.
//
// ── AS DECISOES QUE MOLDAM A REGRA (ETAPA A, aprovadas) ──
//   D1. Pessoa SEM candidatura nenhuma (legado de `talentos`) = "Sem decisao" -> elegivel.
//       Ninguem nunca decidiu nada sobre ela; excluir seria zerar a maior parte da base.
//   D2. NULL/'' com applications.status='em_entrevista' = "Sem decisao" -> elegivel. Segue o
//       selo do painel (admin.js, badgeStatusRecrutador), que mostra "Sem decisao" para NULL.
//   D3. Candidaturas multiplas: regra "TODAS". Basta UMA candidatura inelegivel — inclusive
//       ARQUIVADA (deleted_at) — para excluir a pessoa. E mais estrita que a supressao atual
//       por aprovacao ("candidatura MAIS RECENTE aprovada", db.mapaStatusRecrutadorPorTelefone),
//       que continua valendo intacta para WA1/WA2 e para a campanha: esta regra SOMA, nao
//       substitui.
//
// ── IDENTIDADE DA PESSOA ──
// Telefone pela CHAVE CANONICA (lib/chaveTelefone: DDI + DDD + ultimos 8 digitos), a mesma
// do opt-out — senao "5531996820290" e "553196820290" seriam duas pessoas, e a candidatura
// aprovada gravada numa grafia nao barraria a divulgacao enviada para a outra. E-mail pelo
// normalizador canonico (lib/normalizarEmail). Uma pessoa avaliada por varias chaves (e-mail
// E telefone) e excluida se QUALQUER uma delas casar com candidatura inelegivel.

const dbPadrao = require('../db');
const { chaveCanonicaTelefone } = require('./chaveTelefone');
const { normalizarEmail } = require('./normalizarEmail');

// Valores CANONICOS elegiveis. 'sem_decisao' nao e gravado no banco (la ele e NULL) — e o
// nome canonico que normalizarStatusRecrutador da ao NULL/''.
const STATUS_ELEGIVEIS_PROMOCAO_VAGA = Object.freeze(['sem_decisao', 'reprovado']);

// Tipos de campanha em que a regra vale (decisao D4). O filtro depende SEMPRE do tipo
// (campanhas.tipo / campanhas_whatsapp.tipo_mensagem), nunca do nome do template: o mesmo
// template pode servir a mais de um objetivo, e o nome e decisao de quem cadastra na Meta.
// Ampliar o escopo (ex.: convite_grupo) e acrescentar aqui — e rever os testes de escopo.
const TIPOS_CAMPANHA_COM_FILTRO_STATUS = Object.freeze(['divulgacao_vaga']);

// Ordem de precedencia do MOTIVO quando a pessoa tem mais de um status inelegivel. So afeta o
// rotulo agregado (nunca a decisao): o mais "forte" primeiro.
const MOTIVOS = Object.freeze(['aprovado', 'em_analise', 'desconhecido']);

function tipoComFiltroStatus(tipo) {
  return TIPOS_CAMPANHA_COM_FILTRO_STATUS.includes(String(tipo || '').trim());
}

// Valor gravado -> valor canonico. Normaliza caixa, acentos e espacos/hifens antes de
// comparar, entao "Em Análise", "em-analise" e "EM_ANALISE" sao o mesmo status. O que nao
// casar com nenhum dos quatro vira 'desconhecido' — inelegivel.
function normalizarStatusRecrutador(valor) {
  if (valor == null) return 'sem_decisao';
  const s = String(valor)
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, '_');
  if (s === '' || s === 'sem_decisao') return 'sem_decisao';
  if (s === 'reprovado' || s === 'aprovado' || s === 'em_analise') return s;
  return 'desconhecido';
}

function statusElegivelPromocaoVaga(valor) {
  return STATUS_ELEGIVEIS_PROMOCAO_VAGA.includes(normalizarStatusRecrutador(valor));
}

function resumoVazio() {
  return {
    avaliadas: 0,
    elegiveis: 0,
    excluidas: 0,
    porMotivo: { aprovado: 0, em_analise: 0, desconhecido: 0 },
    // Excluidas SO por candidatura arquivada (nenhuma candidatura ativa inelegivel). Mostra
    // o efeito da D3 ao longo do tempo sem expor quem.
    apenasArquivada: 0,
  };
}

// Monta o indice UMA vez (uma leitura de applications) e devolve as funcoes de consulta.
//
//   avaliar({ telefones, emails }) -> { elegivel, motivo, apenasArquivada, semCandidatura }
//   porTelefone(tel) / porEmail(email) -> atalhos de avaliar com uma chave so
//   resumo -> contagem AGREGADA das avaliacoes feitas (sem dado pessoal)
//
// Cada chamada de avaliacao conta UMA pessoa no resumo: o chamador avalia cada pessoa uma
// vez so (os dois motores ja deduplicam antes).
function construirIndiceElegibilidade(deps = {}) {
  const db = deps.db || dbPadrao;
  const porChaveTelefone = new Map();
  const porChaveEmail = new Map();

  const registrar = (mapa, chave, status, arquivada) => {
    if (!chave) return;
    if (!mapa.has(chave)) mapa.set(chave, { ativas: new Set(), arquivadas: new Set() });
    mapa.get(chave)[arquivada ? 'arquivadas' : 'ativas'].add(status);
  };

  for (const linha of db.listarStatusRecrutadorParaElegibilidade()) {
    const status = normalizarStatusRecrutador(linha.status_recrutador);
    const arquivada = linha.deleted_at != null && String(linha.deleted_at).trim() !== '';
    registrar(porChaveTelefone, chaveCanonicaTelefone(linha.telefone), status, arquivada);
    registrar(porChaveEmail, linha.email ? normalizarEmail(linha.email) : null, status, arquivada);
  }

  const resumo = resumoVazio();

  function avaliar({ telefones = [], emails = [] } = {}) {
    const registros = [];
    for (const t of [].concat(telefones)) {
      const r = porChaveTelefone.get(chaveCanonicaTelefone(t));
      if (r) registros.push(r);
    }
    for (const e of [].concat(emails)) {
      const chave = e ? normalizarEmail(e) : null;
      const r = chave ? porChaveEmail.get(chave) : null;
      if (r) registros.push(r);
    }

    const inelegiveisAtivas = new Set();
    const inelegiveisArquivadas = new Set();
    for (const r of registros) {
      for (const s of r.ativas) if (!STATUS_ELEGIVEIS_PROMOCAO_VAGA.includes(s)) inelegiveisAtivas.add(s);
      for (const s of r.arquivadas) if (!STATUS_ELEGIVEIS_PROMOCAO_VAGA.includes(s)) inelegiveisArquivadas.add(s);
    }

    const todos = new Set([...inelegiveisAtivas, ...inelegiveisArquivadas]);
    const elegivel = todos.size === 0;
    const motivo = elegivel ? null : MOTIVOS.find((m) => todos.has(m));
    const apenasArquivada = !elegivel && inelegiveisAtivas.size === 0;

    resumo.avaliadas += 1;
    if (elegivel) {
      resumo.elegiveis += 1;
    } else {
      resumo.excluidas += 1;
      resumo.porMotivo[motivo] += 1;
      if (apenasArquivada) resumo.apenasArquivada += 1;
    }

    return { elegivel, motivo, apenasArquivada, semCandidatura: registros.length === 0 };
  }

  return {
    avaliar,
    porTelefone: (telefone) => avaliar({ telefones: [telefone] }),
    porEmail: (email) => avaliar({ emails: [email] }),
    resumo,
  };
}

module.exports = {
  STATUS_ELEGIVEIS_PROMOCAO_VAGA,
  TIPOS_CAMPANHA_COM_FILTRO_STATUS,
  tipoComFiltroStatus,
  normalizarStatusRecrutador,
  statusElegivelPromocaoVaga,
  construirIndiceElegibilidade,
};
