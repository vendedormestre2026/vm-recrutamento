'use strict';

// Motor de PUBLICO do disparo em massa por WhatsApp: candidatos de vaga ABERTA.
//
// TERCEIRO motor de publico por telefone do projeto, e a comparacao com os dois primeiros e a
// forma mais rapida de entender este arquivo:
//
//                      publicoDisparoWhatsapp      publicoCampanhaWhatsapp      este
//   recorte            UMA praca                   base inteira + filtros       VAGA ABERTA
//   base legada        entra (talentos)            entra (talentos)             NAO entra
//   quem tem cidade    pessoa OU vaga              pessoa OU vaga               ninguem (*)
//   identidade         telefone normalizado        telefone normalizado         chave CANONICA
//   escopo opt-out     campanha                    campanha                     campanha
//
//   (*) cidade nao participa de nada aqui. Ver "VAGA REMOTA ENTRA", abaixo.
//
// ══════════════════════════════════════════════════════════════
// AS QUATRO DECISOES QUE SEPARAM ESTE MOTOR DOS OUTROS DOIS
// ══════════════════════════════════════════════════════════════
//
// ── 1. SO CANDIDATO DE VAGA ABERTA. A BASE LEGADA NUNCA ENTRA ──
// Nao ha `talentos` em lugar nenhum deste arquivo, e isso e regra de negocio, nao omissao. As
// 13 mil pessoas do legado nunca se candidataram a nada: mandar disparo em massa para elas e
// exatamente o padrao que faz um numero de WhatsApp ser bloqueado. O publico daqui deu o
// telefone se candidatando a uma vaga que AINDA esta aberta — e a melhor protecao
// anti-bloqueio do desenho inteiro, mais do que qualquer variacao de texto.
//
// ── 2. NAO USA aplicarInvariantes, E ISSO E DELIBERADO ──
// aplicarInvariantes (lib/publicoCampanhaWhatsapp) descarta em silencio quem nao tem praca
// resolvivel. La isso e correto: a mensagem carrega o link do grupo DAQUELA praca. Aqui seria
// um bug invisivel — candidato de vaga REMOTA tem jobs.cidade NULL e desapareceria de um
// publico cuja definicao e "candidatos de vagas abertas".
// Reusamos as PECAS (opt-out, telefoneUtilizavel, chave canonica), nunca o pacote.
//
// ── 3. A IDENTIDADE E A CHAVE CANONICA, NAO O TELEFONE NORMALIZADO ──
// Os outros dois deduplicam por telefone normalizado, o que deixa a MESMA PESSOA passar duas
// vezes quando ela esta na base com e sem o nono digito (7 pessoas / 14 numeros em producao;
// ver lib/chaveTelefone.js). Num disparo em massa isso significa a mesma pessoa recebendo a
// mesma mensagem duas vezes — e mensagem repetida e o que faz alguem denunciar o numero.
//
// ── 4. NENHUMA CHAMADA AO SOCKET DO WHATSAPP AQUI ──
// A ETAPA A previa uma checagem de existencia (onWhatsApp) na montagem do publico, como faz
// publicoDisparoWhatsapp. Foi REMOVIDA de propria iniciativa, e o motivo e o proprio objetivo
// do trabalho: consultar a existencia de milhares de numeros de uma vez e, ele mesmo, um sinal
// de conta suspeita — seria pagar com risco de bloqueio por uma informacao que o envio ja
// descobre de graca. O worker (B4) checa o lote de 5 a 8 que esta prestes a sair, e quem nao
// existe vira o status terminal 'sem_whatsapp' na fila. A previa, por isso, nao tem como
// prever esse numero — e o funil abaixo nao finge que tem.

const dbPadrao = require('../db');
const { normalizarTelefoneWhatsapp } = require('./whatsapp');
const { chaveCanonicaTelefone } = require('./chaveTelefone');
// A MESMA guarda dos outros dois motores (contrato de ida e volta do telefone). Importada, e
// nao recopiada: a auditoria mostrou os dois motores discordando sobre 6 registros reais
// quando a regra existia em duplicata.
const { telefoneUtilizavel } = require('./publicoDisparoWhatsapp');
// Normalizador CANONICO do status do recrutador (NULL/'' -> 'sem_decisao', tolerante a caixa e
// acento). Ja existia para a elegibilidade da promocao por e-mail; uma segunda leitura de
// "qual e o status desta pessoa" divergiria da primeira no primeiro ajuste.
const { normalizarStatusRecrutador } = require('./elegibilidadeStatusPromocao');
const optout = require('./optoutWhatsapp');

// ══════════════════════════════════════════════════════════════
// STATUS DO RECRUTADOR
// ══════════════════════════════════════════════════════════════
//
// Os quatro valores CANONICOS que a coluna pode assumir depois de normalizada. 'sem_decisao'
// NAO existe no banco — la ele e NULL ou '' (as duas grafias convivem em producao).
const STATUS_SELECIONAVEIS = Object.freeze(['sem_decisao', 'em_analise', 'aprovado', 'reprovado']);

// O que vem marcado quando o operador cria a campanha.
//
// 'aprovado' fora por razao obvia (quem passou nao precisa de divulgacao). 'reprovado' fora
// por decisao de negocio: pode ser marcado de proposito, mas nao por esquecimento — mandar
// mensagem em massa para quem acabou de ser reprovado e o tipo de envio que gera denuncia.
const STATUS_PADRAO = Object.freeze(['sem_decisao', 'em_analise']);

// 'desconhecido' e o que normalizarStatusRecrutador devolve para um valor que nao casa com
// nenhum dos quatro (dado corrompido, status escrito a mao por um script). NAO e selecionavel,
// e quem cair nele fica FORA — mesmo criterio de escopoDoTipoMensagem em lib/optoutWhatsapp:
// diante de um valor que ninguem reconhece, o lado seguro do erro e nao enviar.
const STATUS_DESCONHECIDO = 'desconhecido';

// Sanea a lista vinda da tela. Valor fora do enum e descartado; duplicata colapsa.
//
// Lista VAZIA devolve vazia — e nao o default. A diferenca importa: "nao marquei nada" tem que
// produzir publico vazio e uma recusa visivel na tela, nunca um publico surpresa montado com
// um default que o operador nao escolheu.
function sanearStatusList(statusList) {
  const bruta = Array.isArray(statusList) ? statusList : [];
  const vistos = new Set();
  for (const s of bruta) {
    const v = String(s == null ? '' : s).trim();
    if (STATUS_SELECIONAVEIS.includes(v)) vistos.add(v);
  }
  return [...vistos];
}

// Funil da previa. Os nomes dizem a UNIDADE de cada linha, porque as duas primeiras contam
// CANDIDATURAS e as demais contam PESSOAS — sem isso, os numeros da tela nao fecham e a
// primeira pergunta de quem olha ("por que 40 - 3 nao da 35?") nao tem resposta.
function funilVazio() {
  return {
    candidaturas: 0,
    candidaturasExcluidasStatus: 0,
    porStatusExcluido: { aprovado: 0, reprovado: 0, em_analise: 0, sem_decisao: 0, desconhecido: 0 },
    candidaturasSemTelefoneUtil: 0,
    pessoas: 0,
    candidaturasDuplicadas: 0,
    pessoasOptoutCampanha: 0,
    pessoasOptoutAntigo: 0,
    // Quem ja recebeu disparo em massa (status 'enviado' em qualquer campanha), e de QUAL campanha.
    // So e descontado com excluirJaReceberam ligado; o numero vem preenchido de qualquer jeito,
    // para a tela dizer quantos voltariam se a opcao fosse desmarcada.
    pessoasJaReceberam: 0,
    jaReceberamPorCampanha: {},
    excluiuJaReceberam: false,
    // Corte pelo "maximo de destinatarios" da materializacao. A previa nao tem limite: fica 0.
    pessoasForaPorLimite: 0,
    total: 0,
  };
}

// Monta o publico.
//
// ── "JA RECEBEU" E LIMITE MORAM AQUI, E NAO NA ROTA ──
// Ate 2026-10-01 os dois cortes eram aplicados so na rota de materializar, e a previa nao sabia
// deles: a campanha 6 mostrou PUBLICO FINAL 74 e materializou 12 (62 ja tinham recebido). Agora a
// previa e a materializacao chamam esta mesma funcao com os mesmos parametros, e o "ja recebeu" vem
// de UMA consulta (db.recebedoresDisparoMassaWa) — divergir passa a exigir mudar um lugar so.
//
// `excluirJaReceberam` default TRUE: e o mesmo default do checkbox da materializacao, entao a
// previa mostra o numero que o botao vai produzir se ninguem mexer em nada.
//
// Devolve { itens, funil, statusList }. `itens` esta pronto para materializarCampanhaMassaWa:
// { telefone, telefoneCanonico, nome, applicationId, jobId } — mais jobTitulo, que so a previa
// usa (a fila busca o titulo por JOIN no envio, e nao congelado).
//
// NUNCA LANCA por dado ruim: telefone impossivel, status corrompido e candidatura sem vaga sao
// o caso NORMAL de uma base de anos, e cada um tem uma linha no funil. Lanca so por parametro
// invalido (statusList vazia), que e erro de programacao ou de rota — e la o barulho e o certo.
function montarPublicoMassaWa(
  { jobId = null, statusList = STATUS_PADRAO, excluirJaReceberam = true, maxDestinatarios = null } = {},
  deps = {},
) {
  const db = deps.db || dbPadrao;
  const status = sanearStatusList(statusList);
  if (!status.length) {
    // Barulhento de proposito, no mesmo espirito de listarPendentesPorCidade: um publico vazio
    // que PARECE legitimo nunca e investigado, e aqui ele significaria uma campanha criada
    // sem recorte nenhum.
    throw new Error(
      'statusList vazia: selecione ao menos um status do recrutador ' +
        `(${STATUS_SELECIONAVEIS.join(' | ')}).`,
    );
  }

  const funil = funilVazio();
  const selecionados = new Set(status);

  // ── 1. CANDIDATURAS DE VAGA ABERTA (o SQL ja aplicou: ativa, nao arquivada, com telefone) ──
  const linhas = db.listarCandidaturasVagasAbertas({ jobId });
  funil.candidaturas = linhas.length;

  // Ordem de insercao = ordem da consulta (candidatura mais recente primeiro), e o Map
  // PRESERVA essa ordem. E o que faz "a primeira que chega vence" significar "a mais recente
  // representa a pessoa".
  const porChave = new Map();

  for (const linha of linhas) {
    // ── 2. STATUS DO RECRUTADOR, normalizado ──
    // Filtrado em JS, e nao com IN (...) no SQL, por tres razoes que nao sao estilo:
    //   - IN (...) NUNCA casa com NULL, e NULL e "sem decisao" — a maior parte da base;
    //   - a coluna tem '' TAMBEM como "sem decisao", e as duas grafias convivem;
    //   - grafias variadas ("Em Análise", "em-analise") so colapsam via normalizador.
    // Um WHERE com IN teria excluido silenciosamente quase todo o publico.
    const canonico = normalizarStatusRecrutador(linha.status_recrutador);
    if (!selecionados.has(canonico)) {
      funil.candidaturasExcluidasStatus += 1;
      const chave = canonico === STATUS_DESCONHECIDO ? STATUS_DESCONHECIDO : canonico;
      funil.porStatusExcluido[chave] = (funil.porStatusExcluido[chave] || 0) + 1;
      continue;
    }

    // ── 3. TELEFONE: normalizar, sobreviver a ida e volta, ter chave canonica ──
    const telefone = normalizarTelefoneWhatsapp(linha.telefone);
    if (!telefone || !telefoneUtilizavel(telefone, `application ${linha.id} (massa-wa)`)) {
      funil.candidaturasSemTelefoneUtil += 1;
      continue;
    }
    const telefoneCanonico = chaveCanonicaTelefone(telefone);
    if (!telefoneCanonico) {
      // Praticamente inalcancavel depois do round-trip acima, e checado mesmo assim: sem chave
      // canonica nao ha como consultar opt-out nem garantir a idempotencia da fila, e as duas
      // coisas falhariam ABERTO (mensagem para quem pediu para sair, mensagem repetida).
      funil.candidaturasSemTelefoneUtil += 1;
      continue;
    }

    // ── 4. DEDUPE POR CHAVE CANONICA ──
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
    });
  }

  funil.pessoas = porChave.size;

  // ── 5. OPT-OUT: AS DUAS TABELAS ──
  //
  // whatsapp_optout (nova, COM escopo) consultada com escopo `campanha` — disparo em massa e
  // mensagem que NOS iniciamos, entao tanto `campanha` quanto `total` suprimem. O mapa e
  // carregado UMA vez (nao uma consulta por pessoa) e ja respeita o kill-switch.
  //
  // whatsapp_opt_out (ANTIGA, sem escopo) tambem e lida, ao contrario do que a sequencia
  // WA1/WA2 faz. Aqui e o lado certo: la ler a tabela sem escopo travaria o processo seletivo
  // de quem so pediu para parar de receber ofertas; aqui TUDO e oferta, entao uma supressao a
  // mais nunca e risco. E a assimetria entre os motores e justamente o que a coluna `escopo`
  // existe para permitir.
  const mapaOptout = optout.mapaOptoutAtivo({ db });
  const optoutAntigo = db.listarTelefonesOptOutWhatsapp();

  const recebedores = db.recebedoresDisparoMassaWa();
  funil.excluiuJaReceberam = Boolean(excluirJaReceberam);

  let itens = [];
  for (const pessoa of porChave.values()) {
    if (optout.optoutAtivoNoMapa(mapaOptout, pessoa.telefone, optout.CONSULTA_CAMPANHA)) {
      funil.pessoasOptoutCampanha += 1;
      continue;
    }
    // A tabela antiga e indexada pelo telefone NORMALIZADO (nao pela chave canonica): e um Set
    // de valores crus da coluna. Comparamos com o normalizado, que e a forma que ela guarda.
    if (optoutAntigo.has(pessoa.telefone)) {
      funil.pessoasOptoutAntigo += 1;
      continue;
    }
    // ── 6. JA RECEBEU DISPARO EM MASSA ──
    // Contado sempre (depois do opt-out, para os numeros da tela se subtrairem em sequencia);
    // descontado so com a opcao ligada.
    const campanhaOrigem = recebedores.get(pessoa.telefoneCanonico);
    if (campanhaOrigem != null) {
      funil.pessoasJaReceberam += 1;
      funil.jaReceberamPorCampanha[campanhaOrigem] = (funil.jaReceberamPorCampanha[campanhaOrigem] || 0) + 1;
      if (excluirJaReceberam) continue;
    }
    itens.push(pessoa);
  }

  // ── 7. LIMITE DE DESTINATARIOS: os primeiros N na ordem do publico (mais recente primeiro) ──
  const max = Number(maxDestinatarios);
  if (Number.isInteger(max) && max > 0 && itens.length > max) {
    funil.pessoasForaPorLimite = itens.length - max;
    itens = itens.slice(0, max);
  }

  funil.total = itens.length;

  if (funil.pessoasOptoutCampanha || funil.pessoasOptoutAntigo) {
    console.log(
      `[massa-wa] publico: ${funil.pessoasOptoutCampanha + funil.pessoasOptoutAntigo} pessoa(s) ` +
        `suprimida(s) por opt-out; ${funil.total} na fila.`,
    );
  }

  return { itens, funil, statusList: status };
}

// ══════════════════════════════════════════════════════════════
// DESPACHANTE: a UNICA porta de entrada da previa, da conferencia e da materializacao
// ══════════════════════════════════════════════════════════════
//
// A fonte do publico mora em criterios_json.fonte. AUSENTE = "inscritos em vagas abertas", e o
// caminho e montarPublicoMassaWa com exatamente os argumentos que a rota passava antes deste
// despachante existir — inclusive para as campanhas ja materializadas, que nunca tiveram `fonte`.
// 'segmento' vai para lib/publicoSegmentoMassaWa. Qualquer OUTRO valor lanca: uma fonte que
// ninguem reconhece cair no publico de vagas abertas seria um publico surpresa.
//
// `opcoes` (excluirJaReceberam, maxDestinatarios) so valem para vagas abertas: no segmento o "ja
// recebeu" e sempre excluido e o teto vem dos criterios gravados.
//
// O require do segmento e PREGUICOSO: aquele modulo nao depende deste, mas carregar o segmento
// no topo faria toda campanha antiga pagar pela importacao do motor novo.
const FONTE_VAGAS_ABERTAS = 'vagas_abertas';

function criteriosDaCampanhaMassaWa(campanha) {
  try {
    const c = JSON.parse((campanha && campanha.criterios_json) || '{}');
    return c && typeof c === 'object' ? c : {};
  } catch {
    return {};
  }
}

function fonteDaCampanhaMassaWa(campanha) {
  const f = criteriosDaCampanhaMassaWa(campanha).fonte;
  return f == null || f === '' ? FONTE_VAGAS_ABERTAS : String(f);
}

function montarPublicoDaCampanha(campanha, opcoes = {}, deps = {}) {
  const criterios = criteriosDaCampanhaMassaWa(campanha);
  const fonte = fonteDaCampanhaMassaWa(campanha);
  if (fonte === FONTE_VAGAS_ABERTAS) {
    const lista = criterios.statusList || [];
    const r = montarPublicoMassaWa(
      {
        jobId: campanha.job_id,
        statusList: lista.length ? lista : [...STATUS_PADRAO],
        ...(opcoes.excluirJaReceberam === undefined ? {} : { excluirJaReceberam: opcoes.excluirJaReceberam }),
        ...(opcoes.maxDestinatarios === undefined ? {} : { maxDestinatarios: opcoes.maxDestinatarios }),
      },
      deps,
    );
    return { fonte, ...r };
  }
  // eslint-disable-next-line global-require
  const segmento = require('./publicoSegmentoMassaWa');
  if (fonte === segmento.FONTE_SEGMENTO) {
    return { fonte, ...segmento.montarPublicoSegmentoMassaWa(criterios, deps) };
  }
  throw new Error(`Fonte de publico desconhecida na campanha ${campanha && campanha.id}: "${fonte}".`);
}

module.exports = {
  montarPublicoMassaWa,
  montarPublicoDaCampanha,
  criteriosDaCampanhaMassaWa,
  fonteDaCampanhaMassaWa,
  FONTE_VAGAS_ABERTAS,
  sanearStatusList,
  funilVazio,
  STATUS_SELECIONAVEIS,
  STATUS_PADRAO,
  STATUS_DESCONHECIDO,
};
