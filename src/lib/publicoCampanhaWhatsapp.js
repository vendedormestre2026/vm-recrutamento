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

// ── AS EXCLUSOES AUTOMATICAS, QUE NAO SAO OPCAO DE TELA ──
// Mesmo principio de promocaoVagas: sao invariantes, e transformar qualquer uma em checkbox
// seria oferecer ao operador um jeito de errar caro — e aqui o erro custa o numero.
//   1. sem telefone utilizavel;
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

// Monta o mapa telefone -> pessoa a partir das duas origens.
//
// `deps.db` injetavel, como no resto do projeto.
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
    if (!porTelefone.has(telefone)) {
      porTelefone.set(telefone, {
        telefone,
        nome: null,
        origemTipo: null,
        origemId: null,
        perfis: new Set(),
        cidades: new Set(),
        jobsInscritos: new Set(),
      });
    }
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
  }

  // ── LEGADO ──
  for (const linha of db.listarTalentosParaCampanhaWhatsapp()) {
    const telefone = normalizarTelefoneWhatsapp(linha.telefone);
    if (!telefone) continue;
    if (!porTelefone.has(telefone)) {
      porTelefone.set(telefone, {
        telefone,
        nome: null,
        origemTipo: null,
        origemId: null,
        perfis: new Set(),
        cidades: new Set(),
        jobsInscritos: new Set(),
      });
    }
    const p = porTelefone.get(telefone);
    // ATRIBUTOS antes da precedencia de exibicao: perfil e cidade sao da PESSOA e se
    // acumulam, mesmo quando a linha de applications vence o nome.
    if (linha.perfil_interesse) p.perfis.add(linha.perfil_interesse);
    const c = cidadeLimpa(linha.cidade);
    if (c) p.cidades.add(c);

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

// ══════════════════════════════════════════════════════════════
// 1. CONVITE DE GRUPO
// ══════════════════════════════════════════════════════════════

// Filtros aceitos: `cidades` (multi-selecao). Nao ha "incluir sem cidade" — ver acima.
function listarPublicoConviteGrupo(criterios = {}, deps = {}) {
  let pessoas = aplicarInvariantes(coletarPessoas(deps), deps);

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

// Filtros aceitos: `cidades` (multi) e `perfil` (unico). Nada de Origem/Recomendacao/Base/
// Periodo — o recorte de uma divulgacao e "quem pode querer ESTA vaga", e os outros eixos
// respondem outras perguntas.
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

  // Invariante: fora quem ja esta na vaga.
  pessoas = pessoas.filter((p) => !p.jobsInscritos.has(alvo));

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

module.exports = { listarPublicoConviteGrupo, listarPublicoDivulgacaoVaga, coletarPessoas };
