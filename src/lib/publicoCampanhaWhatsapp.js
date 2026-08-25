'use strict';

// Motor de PUBLICO da campanha por WhatsApp (Meta Cloud API).
//
// Terceiro motor de publico do projeto, e cada um tem uma UNIDADE diferente — que e o que
// impede unifica-los:
//
//   promocaoVagas            e-mail normalizado   (campanha de e-mail)
//   publicoDisparoWhatsapp   telefone             (disparo pontual por praca, via n8n)
//   ESTE                     telefone             (campanha Meta, dois tipos de mensagem)
//
// Em relacao a promocaoVagas, tres coisas mudam e nenhuma e cosmetica:
//   1. a chave e TELEFONE, nao e-mail. Muda o dedup inteiro — quem tem dois cadastros com
//      e-mails diferentes e o mesmo numero e UMA pessoa aqui, e duas la;
//   2. o opt-out e `whatsapp_opt_out`, nao `descadastros`. Sair de um nao e sair do outro;
//   3. a CIDADE de um candidato vem da VAGA (jobs.cidade), porque applications.cidade e
//      coluna orfa e esta 0% preenchida em producao.
//
// O que NAO muda, e por isso e importado em vez de recopiado: as regras de matching
// (aplicarFiltroAtributo, aplicarFiltroMulti) de promocaoVagas.

const dbPadrao = require('../db');
const { normalizarTelefoneWhatsapp } = require('./whatsapp');
const { aplicarFiltroAtributo, aplicarFiltroMulti, CIDADE_TODAS, PERFIS_VALIDOS } = require('./promocaoVagas');
// A MESMA guarda do motor do disparo pontual, importada e nao recopiada.
//
// ── POR QUE ELA PRECISA ESTAR AQUI TAMBEM ──
// `normalizarTelefoneWhatsapp` aceita um valor de formulario e devolve digitos com DDI — mas
// ela nao RECUSA um telefone que ja veio corrompido da origem. "+55 +551998115119" (dado real
// de producao, applications id 336) normaliza para 55551998115119: 14 digitos, dentro do teto
// de sanidade, e portanto aceito. Esse numero nao existe.
//
// A auditoria encontrou os dois motores discordando sobre 6 registros assim: o do disparo
// pontual os exclui, este os incluia. Duas campanhas calculando publicos incompativeis para a
// mesma pessoa — e no caso do novo, materializando um numero que a Meta ou recusa (gastando
// tier) ou entrega a OUTRA pessoa.
const { telefoneUtilizavel } = require('./publicoDisparoWhatsapp');

// ── AS EXCLUSOES AUTOMATICAS, QUE NAO SAO OPCAO DE TELA ──
// Mesmo principio de promocaoVagas: sao invariantes, e transformar qualquer uma em checkbox
// seria oferecer ao operador um jeito de errar caro — e aqui o erro custa o numero.
//   1. sem telefone utilizavel — inclui o que NORMALIZA mas nao sobrevive a ida e volta
//      (DDI duplicado na origem), pela guarda compartilhada com o motor do disparo pontual;
//   2. sem cidade resolvivel  -> nao ha praca, logo nao ha link de grupo nem recorte;
//   3. sentinela 'Todas as cidades' -> ver a nota abaixo;
//   4. em whatsapp_opt_out;
//   5. duplicata por telefone;
//   6. (so em divulgacao_vaga) ja se candidatou AQUELA vaga.

// ── POR QUE O SENTINELA NAO ENTRA ──
// 'Todas as cidades' marca uma PESSOA presente em qualquer praca (531 no legado). No motor de
// e-mail ele casa com qualquer selecao, ampliando o publico de proposito. Aqui e o oposto:
// o convite leva o link do grupo de UMA praca, e "presente em qualquer praca" nao diz em
// QUAL. Coloca-la em todos os nove grupos seria a leitura literal; num grupo escolhido a
// esmo, seria adivinhacao. Fica de fora ate haver dado melhor — mesma decisao ja tomada em
// lib/publicoDisparoWhatsapp.

function primeiroNome(nome) {
  return String(nome || '').trim().split(/\s+/)[0] || '';
}

function cidadeLimpa(v) {
  return String(v == null ? '' : v).trim();
}

// Cria o registro vazio de uma pessoa nova no Map de agrupamento. Extraida porque os dois
// lacos abaixo (candidatos e legado) precisam do MESMO formato inicial.
function pessoaVazia(telefone) {
  return {
    telefone,
    nome: null,
    origemTipo: null,
    origemId: null,
    perfis: new Set(),
    cidades: new Set(),
    jobsInscritos: new Set(),
    // Todas as datas (YYYY-MM-DD) em que esta pessoa apareceu — candidatura(s) e/ou cadastro
    // de talento. Usado por aplicarFiltroPeriodo (mais abaixo) DEPOIS do agrupamento, nunca
    // como filtro nas consultas de origem — ver o comentario em coletarPessoas.
    datas: new Set(),
  };
}

// Trunca um `criado_em` (formato datetime do SQLite, "YYYY-MM-DD HH:MM:SS") para so a data.
// String vazia p/ valor ausente — nunca entra no Set de datas de aplicarFiltroPeriodo.
function apenasData(criadoEm) {
  return String(criadoEm || '').slice(0, 10);
}

// Monta o mapa telefone -> pessoa a partir das duas origens.
//
// `deps.db` injetavel, como no resto do projeto.
//
// ── SEM JANELA DE PERIODO NAS CONSULTAS, DE PROPOSITO (ETAPA B, Incremento 2) ──
// As duas consultas de origem (listarCandidatosParaCampanhaWhatsapp/
// listarTalentosParaCampanhaWhatsapp, em sqlite.js) ACEITAM um parametro de janela, mas esta
// funcao NUNCA o passa. Motivo: jobsInscritos (usado pela exclusao "ja se candidatou a esta
// vaga" de listarPublicoDivulgacaoVaga) e datas (usado por aplicarFiltroPeriodo) precisam do
// historico COMPLETO da pessoa para as duas checagens que dependem deles nao falharem. Uma
// janela estreita aplicada AQUI reduziria jobsInscritos junto com o publico, e uma
// candidatura a vaga alvo de uma divulgacao FORA da janela deixaria de ser barrada pela
// exclusao. O periodo e filtrado DEPOIS, em JS, sobre o conjunto inteiro — ver
// aplicarFiltroPeriodo logo abaixo das duas funcoes de agrupamento.
function coletarPessoas(deps = {}) {
  const db = deps.db || dbPadrao;
  const porTelefone = new Map();

  // ── CANDIDATOS ──
  // A cidade vem de jobs.cidade (a praca da VAGA a que a pessoa se candidatou), porque
  // applications.cidade e orfa. E uma INFERENCIA, registrada como tal: a cidade de um
  // candidato e onde fica a vaga, nao onde ele mora. Para um recorte regional de processo
  // seletivo ela e o recorte certo, mas nao e o mesmo dado.
  for (const linha of db.listarCandidatosParaCampanhaWhatsapp()) {
    const telefone = normalizarTelefoneWhatsapp(linha.telefone);
    if (!telefone) continue;
    // ANTES de agrupar: um telefone corrompido nao pode nem entrar no Map, senao ele passa a
    // ser a chave de dedup de uma pessoa que deveria estar fora.
    if (!telefoneUtilizavel(telefone, `application ${linha.id}`)) continue;
    if (!porTelefone.has(telefone)) porTelefone.set(telefone, pessoaVazia(telefone));
    const p = porTelefone.get(telefone);
    // applications vence talentos na EXIBICAO (nome/origem), mesma precedencia dos outros
    // dois motores: o contexto vivo vale mais que o cadastro antigo.
    p.origemTipo = 'application';
    p.origemId = linha.id;
    p.nome = linha.nome || p.nome;
    if (linha.perfil) p.perfis.add(linha.perfil);
    const c = cidadeLimpa(linha.cidade_vaga);
    if (c) p.cidades.add(c);
    // Guarda TODAS as vagas em que a pessoa ja entrou — inclusive por outro telefone/e-mail,
    // porque o agrupamento aqui e por numero. Usado pela exclusao de divulgacao_vaga.
    if (linha.job_id) p.jobsInscritos.add(linha.job_id);
    const data = apenasData(linha.criado_em);
    if (data) p.datas.add(data);
  }

  // ── LEGADO ──
  for (const linha of db.listarTalentosParaCampanhaWhatsapp()) {
    const telefone = normalizarTelefoneWhatsapp(linha.telefone);
    if (!telefone) continue;
    if (!telefoneUtilizavel(telefone, `talento ${linha.id}`)) continue;
    if (!porTelefone.has(telefone)) porTelefone.set(telefone, pessoaVazia(telefone));
    const p = porTelefone.get(telefone);
    // ATRIBUTOS antes da precedencia de exibicao: perfil e cidade sao da PESSOA e se
    // acumulam, mesmo quando a linha de applications vence o nome.
    if (linha.perfil_interesse) p.perfis.add(linha.perfil_interesse);
    const c = cidadeLimpa(linha.cidade);
    if (c) p.cidades.add(c);
    const data = apenasData(linha.criado_em);
    if (data) p.datas.add(data);

    if (p.origemTipo === 'application') continue;
    p.origemTipo = 'talento';
    p.origemId = linha.id;
    p.nome = linha.nome || p.nome;
  }

  return [...porTelefone.values()];
}

// Aplica as exclusoes que valem para os DOIS tipos de campanha.
function aplicarInvariantes(pessoas, deps = {}) {
  const db = deps.db || dbPadrao;
  const optOut = db.listarTelefonesOptOutWhatsapp();

  return pessoas.filter((p) => {
    if (optOut.has(p.telefone)) return false;
    // Sentinela fora, e "sem cidade" fora: os dois impedem resolver uma praca, e sem praca
    // nao ha recorte nem link. Sem checkbox de "incluir sem cidade" — aqui isso nao e uma
    // preferencia, e a diferenca entre poder e nao poder montar a mensagem.
    const cidades = [...p.cidades].filter((c) => c !== CIDADE_TODAS);
    if (!cidades.length) return false;
    p.cidadesUteis = new Set(cidades);
    return true;
  });
}

// Formata a saida. `cidade` e UMA praca — a primeira em ordem alfabetica quando a pessoa tem
// mais de uma (candidata a vagas de duas pracas). Escolha arbitraria mas ESTAVEL: sem ordem
// definida, duas materializacoes da mesma campanha mandariam links de grupos diferentes para
// a mesma pessoa.
function paraSaida(p) {
  const cidades = [...(p.cidadesUteis || p.cidades)].sort((a, b) => a.localeCompare(b, 'pt-BR'));
  return {
    telefone: p.telefone,
    nome: p.nome || '',
    nome_primeiro: primeiroNome(p.nome),
    origemTipo: p.origemTipo,
    origemId: p.origemId,
    cidade: cidades[0] || null,
  };
}

// ── FILTRO "PERIODO" (dataDe/dataAte) ──
//
// Compara contra `datas` — TODAS as datas (candidatura e/ou cadastro) em que aquele TELEFONE
// apareceu (ver coletarPessoas) — e nao contra uma consulta ja recortada por janela. Se a
// janela fosse aplicada nas consultas de origem (como o e-mail faz, e como esta funcao fazia
// ate o Incremento 1 desta ETAPA), uma candidatura a vaga alvo de uma divulgacao FORA da
// janela sumiria de jobsInscritos ANTES da exclusao "ja se candidatou a esta vaga" rodar, e
// deixaria de ser barrada. Comparar `datas` (conjunto completo) DEPOIS do agrupamento, sem
// tocar jobsInscritos, evita esse furo.
//
// Dois extremos INCLUSIVOS, mesmo contrato do e-mail (condicoesFiltroCandidatos): basta UMA
// data da pessoa cair dentro da janela para ela entrar — nao todas.
function aplicarFiltroPeriodo(pessoas, criterios) {
  const { dataDe, dataAte } = criterios;
  if (!dataDe && !dataAte) return pessoas;
  return pessoas.filter((p) =>
    [...p.datas].some((data) => (!dataDe || data >= dataDe) && (!dataAte || data <= dataAte)),
  );
}

// ══════════════════════════════════════════════════════════════
// 1. CONVITE DE GRUPO
// ══════════════════════════════════════════════════════════════

// Filtros aceitos: `cidades` (multi-selecao) e `dataDe`/`dataAte` (periodo da
// candidatura/cadastro). Nao ha "incluir sem cidade" — ver acima.
function listarPublicoConviteGrupo(criterios = {}, deps = {}) {
  let pessoas = aplicarInvariantes(coletarPessoas(deps), deps);
  pessoas = aplicarFiltroPeriodo(pessoas, criterios);

  const passo = aplicarFiltroMulti(pessoas, {
    selecionados: Array.isArray(criterios.cidades) ? criterios.cidades.filter(Boolean) : [],
    valores: (p) => p.cidadesUteis,
    // `incluirSemAtributo` NAO e exposto: quem nao tem cidade ja saiu nas invariantes, entao
    // nao ha "sem atributo" a incluir. Passar false deixa isso explicito.
    incluirSemAtributo: false,
    // Sem `casaExtra`: o sentinela nao existe mais nesta altura (foi removido nas
    // invariantes), e reintroduzi-lo aqui seria desfazer a decisao de propósito.
  });
  pessoas = passo.pessoas;

  const itens = pessoas.map(paraSaida);
  return { itens, total: itens.length };
}

// ══════════════════════════════════════════════════════════════
// 2. DIVULGACAO DE VAGA
// ══════════════════════════════════════════════════════════════

// Filtros aceitos: `cidades` (multi), `perfil` (unico) e `dataDe`/`dataAte` (periodo). Nada
// de Origem/Recomendacao/Base — os outros eixos respondem outras perguntas.
//
// ── EXCLUSAO INVARIANTE: QUEM JA SE CANDIDATOU A ESTA VAGA ──
// Mesma regra #1 de promocaoVagas, e pela mesma razao: divulgar uma vaga para quem ja esta
// nela e ruido que custa credibilidade — a pessoa recebe um convite para algo que ja fez, e
// no WhatsApp isso e mais visivel que num e-mail.
//
// A comparacao e por PESSOA (o conjunto de vagas em que aquele TELEFONE ja entrou), e nao
// pela linha que venceu a exibicao: alguem que se candidatou com outro e-mail mas o mesmo
// numero continua sendo a mesma pessoa aqui.
//
// A CIDADE continua sendo da PESSOA, e nao da vaga divulgada: vaga remota NAO implica
// "qualquer cidade" — quem escolhe as pracas do publico-alvo e o operador, inclusive para
// vaga remota. Por isso `jobId` nao entra no filtro de cidade em lugar nenhum.
function listarPublicoDivulgacaoVaga(jobId, criterios = {}, deps = {}) {
  const alvo = Number(jobId);
  if (!Number.isInteger(alvo) || alvo <= 0) {
    throw new Error('Divulgacao de vaga exige um job_id valido.');
  }

  let pessoas = aplicarInvariantes(coletarPessoas(deps), deps);

  // Invariante: fora quem ja esta na vaga. ANTES do filtro de periodo de proposito — sao
  // perguntas independentes (uma exclui, a outra recorta), e jobsInscritos aqui e o mesmo
  // conjunto COMPLETO usado pelas duas, pela razao documentada em aplicarFiltroPeriodo.
  pessoas = pessoas.filter((p) => !p.jobsInscritos.has(alvo));
  pessoas = aplicarFiltroPeriodo(pessoas, criterios);

  const passoCidade = aplicarFiltroMulti(pessoas, {
    selecionados: Array.isArray(criterios.cidades) ? criterios.cidades.filter(Boolean) : [],
    valores: (p) => p.cidadesUteis,
    incluirSemAtributo: false,
  });
  pessoas = passoCidade.pessoas;

  const passoPerfil = aplicarFiltroAtributo(pessoas, {
    ativo: PERFIS_VALIDOS.includes(criterios.perfil),
    alvo: criterios.perfil,
    valores: (p) => p.perfis,
    // Aqui SIM ha "sem atributo" legitimo: talento sem perfil_interesse declarado. Segue o
    // default de promocaoVagas (fica de fora), com a flag disponivel para a tela.
    incluirSemAtributo: criterios.perfilIncluirSemAtributo === true,
  });
  pessoas = passoPerfil.pessoas;

  const itens = pessoas.map(paraSaida);
  return { itens, total: itens.length, semPerfil: passoPerfil.semAtributo };
}

// ══════════════════════════════════════════════════════════════
// 3. STATUS DA CANDIDATURA (aprovados/reprovados/em analise, de UMA vaga)
// ══════════════════════════════════════════════════════════════
//
// Terceiro objetivo de campanha (ETAPA B, Incremento 11): "informar aos candidatos de UMA
// vaga qual foi o resultado da candidatura deles" — nao e uma pergunta de segmentacao (quem
// PODE querer isto), e uma pergunta de CONTEUDO da mensagem (o que essas pessoas ESPECIFICAS
// precisam saber sobre a candidatura delas). O formato e por isso deliberadamente diferente
// dos outros dois:
//
//   - jobId e statusList sao AMBOS obrigatorios. Nao ha "todas as vagas" nem "qualquer
//     status": mandar "sua candidatura foi X" sem saber X nem em qual vaga nao e uma
//     mensagem que faz sentido existir.
//   - SO applications, NUNCA talentos: `status_recrutador` nao existe na tabela `talentos` —
//     Base legada nunca passa por entrevista nem por decisao do recrutador (ver o diagnostico
//     da ETAPA A, item 11). Base alvo (applications/talentos/ambos) nem se aplica aqui —
//     diferente dos outros dois tipos, nao e exposta na tela para este objetivo.
//   - Sem cidade, sem periodo: o recorte inteiro JA e "candidatos desta vaga com este
//     status"; cidade/periodo perguntariam algo que jobId+statusList ja decidiu sozinho.
//
// ── ⚠️ DESVIO DE PADRAO DELIBERADO: statusList VAZIO E ERRO, NAO "TODOS" ──
// Em cidade/perfil (os outros dois tipos), nada marcado = filtro inativo = todo mundo entra
// (ver aplicarFiltroMulti/aplicarFiltroAtributo). AQUI NAO. "Nenhum status marcado" NUNCA
// pode virar silenciosamente "manda para todo mundo, aprovado ou reprovado ou em analise" —
// o erro custa dizer "voce foi aprovado" para quem foi reprovado, ou o inverso. Por isso
// statusList vazio LANCA (mesmo tratamento de jobId invalido), em vez de devolver publico
// vazio ou publico total. NAO "conserte" isto de volta ao padrao de aplicarFiltroMulti sem
// reler este comentario primeiro — a omissao aqui e intencional, nao um bug esquecido.
function listarPublicoStatusCandidatura(jobId, statusList, deps = {}) {
  const db = deps.db || dbPadrao;
  const alvo = Number(jobId);
  if (!Number.isInteger(alvo) || alvo <= 0) {
    throw new Error('Informar situacao de candidatura exige um job_id valido.');
  }
  // dbPadrao.STATUS_RECRUTADOR_VALIDOS (sqlite.js) — MESMA allowlist ['aprovado', 'reprovado',
  // 'em_analise'] que valida a decisao humana do recrutador em admin.js (STATUS_RECRUTADOR_
  // FILTRAVEIS = [...db.STATUS_RECRUTADOR_VALIDOS, 'sem_decisao']). Lida daqui, nao
  // redeclarada, para as duas fontes nunca divergirem.
  const statusValidos = Array.isArray(statusList)
    ? statusList.filter((s) => dbPadrao.STATUS_RECRUTADOR_VALIDOS.includes(s))
    : [];
  if (!statusValidos.length) {
    throw new Error('Informar situacao de candidatura exige pelo menos um status selecionado.');
  }

  // opt-out e telefoneUtilizavel: MESMAS duas invariantes dos outros dois tipos (ver o
  // cabecalho do arquivo). `status_recrutador IN (...)` no SQL ja exclui NULL ("sem decisao")
  // sozinho — IN nunca casa com NULL —, entao nao ha checagem extra a fazer aqui para isso.
  const optOut = db.listarTelefonesOptOutWhatsapp();
  const porTelefone = new Map();

  for (const linha of db.listarCandidatosPorVagaEStatusRecrutador(alvo, statusValidos)) {
    const telefone = normalizarTelefoneWhatsapp(linha.telefone);
    if (!telefone) continue;
    if (!telefoneUtilizavel(telefone, `application ${linha.id}`)) continue;
    if (optOut.has(telefone)) continue;
    if (porTelefone.has(telefone)) continue; // duplicata por telefone: a primeira (menor id) vence
    porTelefone.set(telefone, {
      telefone,
      nome: linha.nome || '',
      nome_primeiro: primeiroNome(linha.nome),
      origemTipo: 'application',
      origemId: linha.id,
      cidade: cidadeLimpa(linha.cidade_vaga) || null,
    });
  }

  const itens = [...porTelefone.values()];
  return { itens, total: itens.length };
}

module.exports = {
  listarPublicoConviteGrupo,
  listarPublicoDivulgacaoVaga,
  listarPublicoStatusCandidatura,
  coletarPessoas,
};
