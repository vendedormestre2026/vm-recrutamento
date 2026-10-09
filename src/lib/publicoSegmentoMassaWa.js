'use strict';

// Motor de PUBLICO do disparo em massa, fonte "SEGMENTO DA BASE".
//
// Convida para UMA vaga aberta (a vaga-alvo) quem se candidatou a OUTRAS vagas da mesma cidade e
// nao esta em processo em andamento la. E o irmao de lib/publicoMassaWhatsapp (fonte "inscritos
// em vagas abertas"), e os dois so se encontram no despachante montarPublicoDaCampanha, que mora
// la. Campanha sem `fonte` nunca chega aqui.
//
// ══════════════════════════════════════════════════════════════
// AS DECISOES (Etapa A do segmento, aprovadas em 2026-10-09)
// ══════════════════════════════════════════════════════════════
//
//   cidade        a da VAGA da candidatura (jobs.cidade, vocabulario fechado), comparada por
//                 cidades.chave(). applications.cidade e orfa (0% preenchida) e talentos nao
//                 entra: a base legada continua fora do disparo em massa.
//   periodo       a pessoa entra se ALGUMA candidatura dela a vaga da cidade cair na janela. Os
//                 limites sao DIAS DE BRASILIA, convertidos para UTC (criado_em e UTC).
//   arquivadas    candidatura arquivada nao conta para a base (linha propria no funil).
//   consentimento a pessoa so entra se ALGUMA candidatura dela tiver consent_at (LGPD). O
//                 checkbox e opcional desde 2026-08-20; ~5% do segmento de Joinville nao tem.
//   em processo   P2: candidatura viva em vaga ABERTA da cidade com status Sem decisao ou Em
//                 analise. Reprovado em vaga aberta NAO e "em processo". Vagas que o operador
//                 marca como PARADAS (vagasIgnoradasProcesso) nao prendem ninguem — sem encerrar
//                 a vaga e sem id fixo no codigo (a vaga 2 de Joinville, aberta desde julho, foi
//                 o caso que motivou).
//   status        regra A, a mesma da promocao de vagas (lib/elegibilidadeStatusPromocao): por
//                 PESSOA, olhando todas as candidaturas, inclusive arquivadas.
//   ja recebeu    disparo em massa: sempre excluido (sem a opcao de desmarcar da outra fonte).
//   outros canais (a) quem ja foi convidado PARA A VAGA-ALVO por qualquer canal sai sempre;
//                 (b) quem recebeu divulgacao/convite nos ultimos N dias sai (N = 0 desliga).
//   teto          obrigatorio, padrao 30, maximo 100. Passou do teto, ficam as candidaturas mais
//                 recentes, em ordem estavel.
//
// Uma linha que este arquivo ACRESCENTA ao funil pedido: "ja se candidataram a vaga-alvo". Sem
// ela, quem foi REPROVADO na propria vaga-alvo passaria pelo P2 (reprovado nao e em processo) e
// pela regra A (reprovado e elegivel) e receberia convite para se candidatar a vaga em que ja
// foi reprovado.
//
// NENHUMA CHAMADA AO WHATSAPP AQUI, pelo mesmo motivo da decisao 4 de publicoMassaWhatsapp.

const dbPadrao = require('../db');
const { normalizarTelefoneWhatsapp } = require('./whatsapp');
const { chaveCanonicaTelefone } = require('./chaveTelefone');
const { telefoneUtilizavel } = require('./publicoDisparoWhatsapp');
const elegibilidade = require('./elegibilidadeStatusPromocao');
const { normalizarEmail } = require('./normalizarEmail');
const { chave: chaveCidade } = require('./cidades');
const { instanteDeBrasilia, paraTextoSqlUtc, partesBrasilia, RE_DATA } = require('./fusoBrasilia');
const optout = require('./optoutWhatsapp');

const FONTE_SEGMENTO = 'segmento';
const TETO_PADRAO = 30;
const TETO_MAXIMO = 100;
const DIAS_OUTROS_CANAIS_PADRAO = 14;
const STATUS_EM_PROCESSO = Object.freeze(['sem_decisao', 'em_analise']);
const CANAIS = Object.freeze(['meta', 'email', 'massa', 'n8n']);

// ══════════════════════════════════════════════════════════════
// CRITERIOS
// ══════════════════════════════════════════════════════════════

const inteiro = (v) => {
  const t = String(v == null ? '' : v).trim();
  if (!/^\d+$/.test(t)) return null;
  return Number(t);
};

const dataValida = (v) => {
  const t = String(v == null ? '' : v).trim();
  return t && RE_DATA.test(t) && instanteDeBrasilia(t, '00:00') ? t : null;
};

// Sanea os criterios gravados em criterios_json (ou vindos da tela). Devolve { criterios, erros }.
//
// O TETO NAO TEM DEFAULT AQUI. TETO_PADRAO e o valor que a TELA preenche; um criterio gravado sem
// teto e erro, e nao "30 por omissao" — um publico sem teto e exatamente o que a decisao 6 proibe,
// e um default silencioso esconderia o buraco de quem gravou.
function sanearCriteriosSegmento(bruto = {}) {
  const b = bruto && typeof bruto === 'object' ? bruto : {};
  const erros = [];

  const vagaAlvoId = inteiro(b.vagaAlvoId);
  if (!vagaAlvoId) erros.push('vaga_alvo');

  const cidade = String(b.cidade == null ? '' : b.cidade).trim();
  if (!cidade) erros.push('cidade');

  const dataDe = b.dataDe ? dataValida(b.dataDe) : null;
  const dataAte = b.dataAte ? dataValida(b.dataAte) : null;
  if ((b.dataDe && !dataDe) || (b.dataAte && !dataAte)) erros.push('periodo');
  if (dataDe && dataAte && dataDe > dataAte) erros.push('periodo');

  const vagasOrigem = [...new Set([].concat(b.vagasOrigem || []).map(inteiro).filter(Boolean))];

  // Ausente = padrao; presente e invalido = erro (e nao o padrao: "-3" nao e "14").
  let diasOutrosCanais = DIAS_OUTROS_CANAIS_PADRAO;
  if (b.diasOutrosCanais != null && String(b.diasOutrosCanais).trim() !== '') {
    diasOutrosCanais = inteiro(b.diasOutrosCanais);
    if (diasOutrosCanais == null) erros.push('dias_outros_canais');
  }

  const teto = inteiro(b.teto);
  if (!teto) erros.push('teto');
  else if (teto > TETO_MAXIMO) erros.push('teto_maximo');

  const desmarcadas = [...new Set([].concat(b.desmarcadas || []).map((s) => String(s || '').trim()).filter(Boolean))];

  // A vaga-alvo nao pode ser ignorada: seria declarar parado o processo para o qual estamos
  // convidando, e quem esta nele (em processo) passaria a receber convite para ele mesmo.
  const vagasIgnoradasProcesso = [...new Set([].concat(b.vagasIgnoradasProcesso || []).map(inteiro).filter(Boolean))];
  if (vagaAlvoId && vagasIgnoradasProcesso.includes(vagaAlvoId)) erros.push('vaga_alvo_ignorada');

  return {
    criterios: {
      fonte: FONTE_SEGMENTO,
      vagaAlvoId,
      cidade,
      dataDe,
      dataAte,
      vagasOrigem,
      diasOutrosCanais: diasOutrosCanais == null ? DIAS_OUTROS_CANAIS_PADRAO : diasOutrosCanais,
      teto,
      desmarcadas,
      vagasIgnoradasProcesso,
    },
    erros,
  };
}

// 'YYYY-MM-DD' (dia de Brasilia) -> o dia seguinte, no mesmo formato. Aritmetica em UTC puro, so
// sobre a DATA: nao ha fuso aqui, so calendario.
function diaSeguinte(data) {
  const [a, m, d] = data.split('-').map(Number);
  const x = new Date(Date.UTC(a, m - 1, d + 1));
  return x.toISOString().slice(0, 10);
}

// Janela em UTC, meio-aberta [de, ate). "Ate 05/10" inclui o dia 05 inteiro de Brasilia, ou seja,
// vai ate 06/10 00:00 BRT = 06/10 03:00 UTC. Comparar so o dia de criado_em (como faz o filtro de
// periodo das campanhas da Meta) jogaria a candidatura das 22h de Brasilia no dia seguinte.
function janelaUtc({ dataDe, dataAte }) {
  return {
    deUtc: dataDe ? paraTextoSqlUtc(instanteDeBrasilia(dataDe, '00:00')) : null,
    ateUtc: dataAte ? paraTextoSqlUtc(instanteDeBrasilia(diaSeguinte(dataAte), '00:00')) : null,
  };
}

// ══════════════════════════════════════════════════════════════
// FUNIL
// ══════════════════════════════════════════════════════════════
//
// As quatro primeiras linhas contam CANDIDATURAS e chegam em `pessoas`; dali para baixo, PESSOAS,
// subtraindo em sequencia ate `total`. Cada pessoa sai na PRIMEIRA linha que a pega, entao as
// linhas nunca se sobrepoem e a conta fecha (ver conferirAritmetica).
function funilSegmentoVazio() {
  return {
    candidaturas: 0,
    candidaturasArquivadas: 0,
    candidaturasSemTelefoneUtil: 0,
    candidaturasDuplicadas: 0,
    pessoas: 0,
    pessoasSemConsentimento: 0,
    pessoasJaCandidatasAlvo: 0,
    pessoasEmProcesso: 0,
    // Informativo: quem SO estaria em processo por causa de uma vaga ignorada, e por isso seguiu.
    liberadasPorVagasIgnoradas: 0,
    vagasIgnoradasProcesso: [],
    pessoasStatus: 0,
    porStatusExcluido: { aprovado: 0, em_analise: 0, desconhecido: 0 },
    pessoasOptout: 0,
    pessoasJaReceberam: 0,
    jaReceberamPorCampanha: {},
    pessoasConvidadasAlvo: 0,
    convidadasAlvoPorCanal: {},
    pessoasDivulgadasRecentes: 0,
    divulgadasRecentesPorCanal: {},
    pessoasDesmarcadas: 0,
    pessoasForaPorTeto: 0,
    total: 0,
    // Informativos (NAO subtraem): quem fica no publico mas ja teve contato por outro canal antes
    // dos N dias (o "contato frio" da tela), e quem tem contato SEM DATA (historico do n8n), que
    // a regra dos N dias nao consegue avaliar.
    finalComContatoAnterior: 0,
    finalComContatoSemData: 0,
  };
}

// Recompoe o total a partir das linhas. Usado pelos testes e pela tela (que recusa mostrar um
// funil que nao fecha, em vez de mostrar numeros que nao se explicam).
function conferirAritmetica(f) {
  const pessoas = f.candidaturas - f.candidaturasArquivadas - f.candidaturasSemTelefoneUtil - f.candidaturasDuplicadas;
  const total = f.pessoas - f.pessoasSemConsentimento - f.pessoasJaCandidatasAlvo - f.pessoasEmProcesso - f.pessoasStatus - f.pessoasOptout
    - f.pessoasJaReceberam - f.pessoasConvidadasAlvo - f.pessoasDivulgadasRecentes - f.pessoasDesmarcadas
    - f.pessoasForaPorTeto;
  return pessoas === f.pessoas && total === f.total;
}

const somar = (obj, k) => { obj[k] = (obj[k] || 0) + 1; };

// enviado_em de qualquer canal -> 'YYYY-MM-DD HH:MM:SS' UTC, ou null.
//
// Tres canais gravam datetime('now') do SQLite. O n8n NAO: o historico de disparos_whatsapp veio
// em ISO com fuso ("2026-07-15T11:38:17.379-04:00", "...Z"), visto em producao no dry-run da
// parada 1. Comparado como string com o limite dos N dias, o 'T' (maior que ' ') faria qualquer
// hora do dia-limite contar como dentro, e o -04:00 seria ignorado. Data ilegivel vira null:
// "sem data", que a regra dos N dias nao avalia e o funil informa.
const RE_SQL_UTC = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/;
function dataEnvioUtc(v) {
  const t = String(v == null ? '' : v).trim();
  if (!t) return null;
  if (RE_SQL_UTC.test(t)) return t;
  const ms = Date.parse(t);
  return Number.isNaN(ms) ? null : paraTextoSqlUtc(new Date(ms));
}

// ══════════════════════════════════════════════════════════════
// MONTAGEM
// ══════════════════════════════════════════════════════════════
//
// Devolve { itens, desmarcadas, funil, criterios }. `itens` vai direto para
// materializarCampanhaMassaWa ({ telefone, telefoneCanonico, nome, applicationId, jobId }) e leva
// o que a conferencia nominal mostra (jobTitulo, candidaturaEm, statusRecrutador, contatos).
// `desmarcadas` sao as pessoas que a conferencia tirou, no mesmo formato, para a tela poder
// remarcar.
//
// LANCA por criterio invalido (sem teto, vaga-alvo fechada, cidade fora do vocabulario): e erro de
// quem chama, e um publico vazio que parece legitimo nunca e investigado.
function montarPublicoSegmentoMassaWa(criteriosBrutos = {}, deps = {}) {
  const db = deps.db || dbPadrao;
  const agora = deps.agora instanceof Date ? deps.agora : new Date();

  const { criterios: c, erros } = sanearCriteriosSegmento(criteriosBrutos);
  if (erros.length) throw new Error(`Criterios do segmento invalidos: ${erros.join(', ')}.`);

  const vagas = db.listarVagas();
  const alvo = vagas.find((v) => v.id === c.vagaAlvoId);
  if (!alvo) throw new Error(`Vaga-alvo ${c.vagaAlvoId} nao existe.`);
  if (!alvo.ativo) throw new Error(`Vaga-alvo ${c.vagaAlvoId} nao esta aberta.`);

  const chave = chaveCidade(c.cidade);
  if (!db.listarCidades().some((x) => x.chave === chave)) {
    throw new Error(`Cidade "${c.cidade}" fora do vocabulario de cidades.`);
  }
  const vagasDaCidade = vagas.filter((v) => chaveCidade(v.cidade) === chave);
  const origemPedida = new Set(c.vagasOrigem);
  const idsBase = vagasDaCidade
    .filter((v) => v.id !== alvo.id)
    .filter((v) => !origemPedida.size || origemPedida.has(v.id))
    .map((v) => v.id);
  const idsAbertasDaCidade = vagasDaCidade.filter((v) => v.ativo).map((v) => v.id);
  const ignoradas = new Set(c.vagasIgnoradasProcesso);
  const idsProcessoVivo = idsAbertasDaCidade.filter((id) => !ignoradas.has(id));

  const funil = funilSegmentoVazio();
  funil.vagasIgnoradasProcesso = idsAbertasDaCidade.filter((id) => ignoradas.has(id));

  // ── 1. CANDIDATURAS DA BASE (mais recente primeiro) ──
  const linhas = db.listarCandidaturasSegmentoMassaWa({ jobIds: idsBase, ...janelaUtc(c) });
  funil.candidaturas = linhas.length;

  const porChave = new Map();
  for (const linha of linhas) {
    if (linha.deleted_at != null && String(linha.deleted_at).trim() !== '') {
      funil.candidaturasArquivadas += 1;
      continue;
    }
    const telefone = normalizarTelefoneWhatsapp(linha.telefone);
    const telefoneCanonico = telefone && telefoneUtilizavel(telefone, `application ${linha.id} (segmento)`)
      ? chaveCanonicaTelefone(telefone)
      : null;
    if (!telefoneCanonico) {
      funil.candidaturasSemTelefoneUtil += 1;
      continue;
    }
    if (porChave.has(telefoneCanonico)) {
      funil.candidaturasDuplicadas += 1;
      continue;
    }
    porChave.set(telefoneCanonico, {
      telefone,
      telefoneCanonico,
      nome: String(linha.nome || '').trim(),
      applicationId: linha.id,
      jobId: linha.job_id,
      jobTitulo: linha.job_titulo || null,
      candidaturaEm: linha.criado_em,
      statusRecrutador: elegibilidade.normalizarStatusRecrutador(linha.status_recrutador),
    });
  }
  funil.pessoas = porChave.size;

  // E-mails de cada pessoa, por TODAS as candidaturas dela (inclusive fora da janela e da cidade):
  // e a identidade do canal de e-mail e um dos lados da regra A.
  const emailsPorChave = new Map();
  for (const a of db.listarStatusRecrutadorParaElegibilidade()) {
    const t = normalizarTelefoneWhatsapp(a.telefone);
    const k = t ? chaveCanonicaTelefone(t) : null;
    const e = a.email ? normalizarEmail(a.email) : '';
    if (!k || !e || !porChave.has(k)) continue;
    if (!emailsPorChave.has(k)) emailsPorChave.set(k, new Set());
    emailsPorChave.get(k).add(e);
  }
  const emailsDe = (k) => emailsPorChave.get(k) || new Set();

  // Conjuntos por pessoa (chave canonica + e-mails), para "ja esta la" e "em processo".
  const indicePorPessoa = (linhasFonte) => {
    const tels = new Set();
    const emails = new Set();
    for (const a of linhasFonte) {
      const t = normalizarTelefoneWhatsapp(a.telefone);
      const k = t ? chaveCanonicaTelefone(t) : null;
      if (k) tels.add(k);
      if (a.email) emails.add(normalizarEmail(a.email));
    }
    return (k) => tels.has(k) || [...emailsDe(k)].some((e) => emails.has(e));
  };

  const consentiu = indicePorPessoa(db.listarConsentimentosMassaWa());
  const estaNaAlvo = indicePorPessoa(db.listarCandidaturasDaVagaMassaWa(alvo.id));
  // Lidas UMA vez, com todas as abertas da cidade; o recorte das ignoradas e em JS, para a linha
  // informativa "liberadas por vagas ignoradas" sair da mesma leitura que decide o P2.
  const vivasEmCurso = db.listarCandidaturasVivasVagasAbertasMassaWa({ jobIds: idsAbertasDaCidade })
    .filter((a) => STATUS_EM_PROCESSO.includes(elegibilidade.normalizarStatusRecrutador(a.status_recrutador)));
  const emProcesso = indicePorPessoa(vivasEmCurso.filter((a) => idsProcessoVivo.includes(a.job_id)));
  const emProcessoSemIgnorar = indicePorPessoa(vivasEmCurso);
  const indiceStatus = elegibilidade.construirIndiceElegibilidade({ db });
  const mapaOptout = optout.mapaOptoutAtivo({ db });
  const optoutAntigo = db.listarTelefonesOptOutWhatsapp();
  const recebedores = db.recebedoresDisparoMassaWa();

  // Contatos por outros canais, indexados por chave canonica e por e-mail.
  const contatosPorTel = new Map();
  const contatosPorEmail = new Map();
  for (const d of db.listarDivulgacoesEnviadasPorCanal()) {
    const contato = { canal: d.canal, jobId: d.job_id == null ? null : Number(d.job_id), em: dataEnvioUtc(d.enviado_em) };
    if (d.email) {
      const e = normalizarEmail(d.email);
      if (!contatosPorEmail.has(e)) contatosPorEmail.set(e, []);
      contatosPorEmail.get(e).push(contato);
    }
    if (d.telefone) {
      const t = normalizarTelefoneWhatsapp(d.telefone);
      const k = t ? chaveCanonicaTelefone(t) : null;
      if (!k) continue;
      if (!contatosPorTel.has(k)) contatosPorTel.set(k, []);
      contatosPorTel.get(k).push(contato);
    }
  }
  const contatosDe = (k) => [
    ...(contatosPorTel.get(k) || []),
    ...[...emailsDe(k)].flatMap((e) => contatosPorEmail.get(e) || []),
  ];

  const limiteRecente = c.diasOutrosCanais > 0
    ? paraTextoSqlUtc(new Date(agora.getTime() - c.diasOutrosCanais * 86400000))
    : null;
  const desmarcadasSet = new Set(c.desmarcadas);

  let itens = [];
  const desmarcadas = [];
  for (const [k, pessoa] of porChave) {
    if (!consentiu(k)) { funil.pessoasSemConsentimento += 1; continue; }
    if (estaNaAlvo(k)) { funil.pessoasJaCandidatasAlvo += 1; continue; }
    if (emProcesso(k)) { funil.pessoasEmProcesso += 1; continue; }
    if (emProcessoSemIgnorar(k)) funil.liberadasPorVagasIgnoradas += 1;

    const aval = indiceStatus.avaliar({ telefones: [pessoa.telefone], emails: [...emailsDe(k)] });
    if (!aval.elegivel) {
      funil.pessoasStatus += 1;
      somar(funil.porStatusExcluido, aval.motivo || 'desconhecido');
      continue;
    }

    if (optout.optoutAtivoNoMapa(mapaOptout, pessoa.telefone, optout.CONSULTA_CAMPANHA)
      || optoutAntigo.has(pessoa.telefone)) {
      funil.pessoasOptout += 1;
      continue;
    }

    const campanhaOrigem = recebedores.get(k);
    if (campanhaOrigem != null) {
      funil.pessoasJaReceberam += 1;
      somar(funil.jaReceberamPorCampanha, campanhaOrigem);
      continue;
    }

    const contatos = contatosDe(k);
    const paraAlvo = contatos.filter((x) => x.jobId === alvo.id);
    if (paraAlvo.length) {
      funil.pessoasConvidadasAlvo += 1;
      somar(funil.convidadasAlvoPorCanal, paraAlvo[0].canal);
      continue;
    }

    if (limiteRecente) {
      const recente = contatos.find((x) => x.em && x.em >= limiteRecente);
      if (recente) {
        funil.pessoasDivulgadasRecentes += 1;
        somar(funil.divulgadasRecentesPorCanal, recente.canal);
        continue;
      }
    }

    const item = { ...pessoa, contatos };
    if (desmarcadasSet.has(k)) {
      funil.pessoasDesmarcadas += 1;
      desmarcadas.push(item);
      continue;
    }
    itens.push(item);
  }

  // ── TETO: a ordem de `porChave` ja e a da candidatura mais recente (SQL), entao o corte e estavel ──
  if (itens.length > c.teto) {
    funil.pessoasForaPorTeto = itens.length - c.teto;
    itens = itens.slice(0, c.teto);
  }
  funil.total = itens.length;
  for (const i of itens) {
    if (i.contatos.length) funil.finalComContatoAnterior += 1;
    if (i.contatos.some((x) => !x.em)) funil.finalComContatoSemData += 1;
  }

  return { itens, desmarcadas, funil, criterios: c };
}

// 5547999582500 -> 5547****2500. Para a conferencia nominal: o operador reconhece a pessoa sem a
// tela expor o numero inteiro.
function mascararTelefone(telefone) {
  const t = String(telefone || '');
  if (t.length < 9) return '****';
  return `${t.slice(0, 4)}****${t.slice(-4)}`;
}

// Periodo padrao da tela de CRIACAO: os ultimos 30 dias, em DIAS DE BRASILIA ('YYYY-MM-DD'), de
// (agora - 30 dias) ate hoje. As 22h de Brasilia ja e o dia seguinte em UTC: por isso o dia sai de
// partesBrasilia, e nao de toISOString.
const DIAS_PERIODO_PADRAO = 30;
const diaBrasiliaIso = (instante) => {
  const p = partesBrasilia(instante);
  return `${p.ano}-${String(p.mes).padStart(2, '0')}-${String(p.dia).padStart(2, '0')}`;
};
function periodoPadraoSegmento(agora = new Date()) {
  return {
    dataDe: diaBrasiliaIso(new Date(agora.getTime() - DIAS_PERIODO_PADRAO * 86400000)),
    dataAte: diaBrasiliaIso(agora),
  };
}

module.exports = {
  montarPublicoSegmentoMassaWa,
  periodoPadraoSegmento,
  DIAS_PERIODO_PADRAO,
  sanearCriteriosSegmento,
  funilSegmentoVazio,
  conferirAritmetica,
  janelaUtc,
  dataEnvioUtc,
  mascararTelefone,
  FONTE_SEGMENTO,
  TETO_PADRAO,
  TETO_MAXIMO,
  DIAS_OUTROS_CANAIS_PADRAO,
  STATUS_EM_PROCESSO,
  CANAIS,
};
