'use strict';

// Motor de PUBLICO da Promocao de Vagas: dados os criterios, quem recebe a campanha.
//
// Esta e a peca que decide para quem sai e-mail. Cada regra abaixo esta comentada com o
// que ela protege, porque um erro aqui nao aparece como excecao — aparece como uma
// mensagem entregue a quem nao devia recebe-la, e nao ha como despublicar e-mail enviado.
//
// ── A UNIDADE E A PESSOA, NAO A LINHA ──
// Uma pessoa pode ter varias candidaturas (recandidatura ja observada em producao) e
// ainda estar em `talentos`. Tudo aqui e agrupado por e-mail NORMALIZADO
// (lib/normalizarEmail), e o resultado tem no maximo uma linha por pessoa.
//
// ── A BASE E UMA PROJECAO, NAO UMA FUSAO ──
// `applications` (funil) e `talentos` (Banco de Curriculos) continuam tabelas separadas,
// com finalidades LGPD distintas. A uniao existe SO na leitura, aqui dentro, para fins de
// campanha — nada e gravado juntando as duas.
//
// ── AS EXCLUSOES AUTOMATICAS, QUE NAO SAO OPCAO DE TELA ──
//   1. ja inscrito na vaga ALVO (inclusive candidatura arquivada nela);
//   2. descadastrado (opt-out global, Incremento 2);
//   3. talento com status 'descartado' (o recrutador ja disse que este curriculo nao
//      serve; nao e opt-out, mas tambem nao e alguem para quem divulgar vaga) — aplicada
//      no SQL da Query B, ver sqlite.js;
//   4. duplicata — a mesma pessoa nunca aparece duas vezes.
// Nenhuma delas e um checkbox: sao invariantes, e transformar qualquer uma em opcao
// significaria oferecer ao operador um jeito de errar caro.

const dbPadrao = require('../db');
const { normalizarEmail } = require('./normalizarEmail');

const PERFIS_VALIDOS = ['SDR', 'CLOSER'];
const RECOMENDACOES_VALIDAS = ['avancar', 'talvez', 'descartar'];

const ORIGEM_APPLICATION = 'application';
const ORIGEM_TALENTO = 'talento';

// ── BASE: de qual cadastro a pessoa veio ──
//
// Tres valores, e nao os dois de ORIGEM_*: aquele par diz de qual TABELA a linha veio e
// resolve a exibicao por precedencia (applications vence). Este eixo e mais fino — separa
// os 7.215 importados do cadastro proprio dentro da mesma tabela `talentos` — e e
// ACUMULADO, nao resolvido: quem e candidata E legado casa com os dois filtros.
const BASE_CANDIDATURA = 'candidatura';
const BASE_LEGADO = 'legado';
const BASE_PROPRIO = 'proprio';
const BASES_VALIDAS = [BASE_CANDIDATURA, BASE_LEGADO, BASE_PROPRIO];

// Valor sentinela de `talentos.cidade`. NAO e uma cidade: marca presenca em qualquer
// praca (hoje so a Loureiro, 531 pessoas). Quem tem isto casa com QUALQUER cidade
// selecionada no filtro, sem depender do "incluir sem cidade" — que serve a outra coisa,
// a AUSENCIA de cidade. Os dois sao opostos e nao podem ser confundidos.
const CIDADE_TODAS = 'Todas as cidades';

// Categoria de talento -> valor de base. NULL/vazio = cadastro proprio, que era o unico
// jeito de entrar em `talentos` antes da importacao.
function baseDoTalento(categoria) {
  return categoria === 'legado' ? BASE_LEGADO : BASE_PROPRIO;
}

function nomeCompleto(linha) {
  return [linha.nome, linha.sobrenome].filter(Boolean).join(' ').trim() || null;
}

// Valor de enum saneado no mesmo espirito de condicoesFiltroCandidatos: valor fora da
// allowlist e tratado como FILTRO INATIVO, nao como erro. E a convencao do projeto para
// entrada vinda de tela/querystring, e o efeito de um valor invalido e "nao filtra" —
// nunca "filtra por algo que ninguem pediu".
function enumSaneado(valor, validos) {
  return validos.includes(valor) ? valor : undefined;
}

// ── Agrupamento por pessoa ──
//
// Cada pessoa acumula os ATRIBUTOS de todas as suas linhas. Isso importa: quem tem uma
// candidatura CLOSER e outra SDR conta como tendo os dois perfis, e casa com o filtro de
// qualquer um dos dois. Filtrar linha a linha e depois deduplicar daria o mesmo conjunto,
// mas a contagem de "sem atributo" ficaria errada — uma pessoa com uma linha sem perfil e
// outra com perfil nao esta "sem perfil".
//
// PRECEDENCIA DA LINHA FINAL (determinista, nao "o que a query devolver primeiro"):
//   - `applications` vence `talentos`. A candidatura carrega mais contexto (vaga, origem,
//     avaliacao) e e o vinculo mais forte com o processo; o talento e cadastro de isca.
//   - Dentro de applications, vence a candidatura MAIS RECENTE (maior id) — mesmo criterio
//     e mesma razao do dedupe de listarPendentesLembreteInicio: entre duas candidaturas da
//     mesma pessoa, a recente reflete o interesse atual dela.
//   - Dentro de talentos, idem: vence o cadastro mais recente.
// As linhas chegam ordenadas por id ASC, entao sobrescrever a cada passagem deixa a maior.
function agruparPessoas(linhasApp, linhasTal, { excluidos }) {
  const pessoas = new Map();

  const obter = (email) => {
    if (!pessoas.has(email)) {
      pessoas.set(email, {
        email,
        nome: null,
        origemTipo: null,
        origemId: null,
        perfis: new Set(),
        origensUtm: new Set(),
        recomendacoes: new Set(),
        // Mesmos Sets acumulados por PESSOA que os tres acima, e pela mesma razao: quem
        // tem candidatura E cadastro legado pertence as duas bases, e um filtro por
        // qualquer uma delas tem que alcanca-la.
        bases: new Set(),
        cidades: new Set(),
      });
    }
    return pessoas.get(email);
  };

  for (const linha of linhasApp) {
    const email = normalizarEmail(linha.email);
    if (!email || excluidos(email)) continue;
    const p = obter(email);
    // applications sempre sobrescreve (vence talentos) e a mais recente vence as antigas.
    p.origemTipo = ORIGEM_APPLICATION;
    p.origemId = linha.origem_id;
    p.nome = nomeCompleto(linha) || p.nome;
    if (linha.perfil) p.perfis.add(linha.perfil);
    if (linha.recomendacao) p.recomendacoes.add(linha.recomendacao);
    // Origem do lead: TODA candidatura tem uma, porque utm_source NULL/vazio significa
    // 'direto' (mesma convencao do filtro do painel — origemCanonica). Ou seja, nao
    // existe candidatura "sem origem"; so talentos ficam sem este atributo.
    p.origensUtm.add(linha._origemCanonica);
    p.bases.add(BASE_CANDIDATURA);
    // `applications.cidade` e coluna orfa e quase sempre NULL — quando ha valor, foi o
    // recrutador que digitou. Entra no mesmo Set das cidades de talento.
    const cidadeApp = String(linha.cidade == null ? '' : linha.cidade).trim();
    if (cidadeApp) p.cidades.add(cidadeApp);
  }

  for (const linha of linhasTal) {
    const email = normalizarEmail(linha.email);
    if (!email || excluidos(email)) continue;
    const p = obter(email);

    // ATRIBUTOS PRIMEIRO, antes da decisao de precedencia de origem — a ordem importa.
    // `talentos.perfil_interesse` (mesmo enum SDR|CLOSER de jobs.perfil) e o atributo de
    // perfil do talento, no mesmo pe do perfil da vaga para um candidato. Se esta linha
    // ficasse depois do `continue` abaixo, o perfil declarado por quem TAMBEM tem
    // candidatura seria perdido — e atributo se acumula por PESSOA, nao pela linha que
    // vence a exibicao. NULL continua significando "sem atributo".
    if (linha.perfil) p.perfis.add(linha.perfil);
    // Base e cidade tambem entram ANTES do `continue` de precedencia, pela mesma razao:
    // sao atributos da PESSOA. Alguem com candidatura E cadastro legado pertence as duas
    // bases, e a linha de applications vencer a EXIBICAO nao apaga o fato de ela estar
    // tambem no legado.
    p.bases.add(baseDoTalento(linha.categoria));
    const cidadeTal = String(linha.cidade == null ? '' : linha.cidade).trim();
    if (cidadeTal) p.cidades.add(cidadeTal);
    // Talento nao contribui origem de lead (nao ha utm_source na tabela) nem recomendacao
    // (nao passa por entrevista/relatorio) — nesses dois eixos ele segue "sem atributo".
    //
    // CONSEQUENCIA CONHECIDA, e a razao de o texto de ajuda do filtro de Origem na tela
    // avisar sobre ela: com o filtro de Origem ATIVO, todo talento cai fora por ser "sem
    // atributo", salvo o "incluir sem origem". Depois da importacao isso deixou de ser
    // detalhe — sao 7.215 pessoas.

    // Origem da linha final: applications vence, entao nao sobrescreve o que ja veio de la.
    if (p.origemTipo === ORIGEM_APPLICATION) continue;
    p.origemTipo = ORIGEM_TALENTO;
    p.origemId = linha.origem_id;
    p.nome = (linha.nome && String(linha.nome).trim()) || p.nome;
  }

  return [...pessoas.values()];
}

// ── Filtro de atributo com a regra do "sem atributo" ──
//
// Regra fechada: quando um filtro esta ativo, quem NAO TEM o atributo fica de FORA por
// padrao, e so volta com a flag `incluirSemAtributo`. O default e excluir porque o
// operador que filtra "perfil Closer" esta pedindo um recorte; devolver junto todo mundo
// sem perfil transformaria o recorte em "quase todo mundo" sem ele perceber.
//
// `semAtributo` e contado ANTES de aplicar a flag — e o numero que a tela mostra ao lado
// do filtro ("+ 350 sem perfil definido [incluir]"), entao precisa existir mesmo quando a
// flag ja esta ligada.
function aplicarFiltroAtributo(pessoas, { ativo, alvo, valores, incluirSemAtributo }) {
  if (!ativo) return { pessoas, semAtributo: null };

  let semAtributo = 0;
  const mantidos = [];
  for (const p of pessoas) {
    const conjunto = valores(p);
    if (conjunto.size === 0) {
      semAtributo += 1;
      if (incluirSemAtributo === true) mantidos.push(p);
      continue;
    }
    if (conjunto.has(alvo)) mantidos.push(p);
  }
  return { pessoas: mantidos, semAtributo };
}

// ── Filtro MULTI-SELECAO com allowlist ──
//
// Diferente de aplicarFiltroAtributo, que casa contra UM alvo (os filtros de Perfil,
// Origem e Recomendacao sao dropdowns de escolha unica). Base e Cidade sao checkboxes:
// o operador marca quantos quiser, e a semantica e OU entre os marcados.
//
// Nada marcado = filtro INATIVO, exatamente como o "Qualquer" dos dropdowns. Isso importa:
// uma lista vazia nao pode significar "ninguem casa", senao abrir a tela sem tocar em nada
// zeraria o publico.
//
// `casaExtra` e o gancho do sentinela de cidade: uma pessoa pode casar mesmo sem ter
// nenhum dos valores marcados, se tiver o coringa. Sem esse gancho, 'Todas as cidades'
// precisaria estar entre as opcoes marcaveis — e ai o operador teria que lembrar de
// marca-lo em TODA campanha, que e o tipo de "depende de lembrar" que ja custou caro
// neste projeto.
function aplicarFiltroMulti(pessoas, { selecionados, valores, incluirSemAtributo, casaExtra }) {
  const alvos = Array.isArray(selecionados) ? selecionados.filter(Boolean) : [];
  if (!alvos.length) return { pessoas, semAtributo: null };

  const conjuntoAlvo = new Set(alvos);
  let semAtributo = 0;
  const mantidos = [];

  for (const p of pessoas) {
    const conjunto = valores(p);
    if (conjunto.size === 0) {
      semAtributo += 1;
      if (incluirSemAtributo === true) mantidos.push(p);
      continue;
    }
    let casa = false;
    for (const v of conjunto) {
      if (conjuntoAlvo.has(v) || (casaExtra && casaExtra(v))) {
        casa = true;
        break;
      }
    }
    if (casa) mantidos.push(p);
  }

  return { pessoas: mantidos, semAtributo };
}

// Sanea uma lista vinda da tela contra uma allowlist. Valor invalido e DESCARTADO da
// lista (nao invalida a lista inteira), no mesmo espirito de enumSaneado: entrada torta
// nunca filtra por algo que ninguem pediu.
function listaSaneada(valor, validos) {
  const bruto = Array.isArray(valor) ? valor : valor == null ? [] : [valor];
  const vistos = new Set();
  const limpa = [];
  for (const v of bruto) {
    const s = String(v);
    if (validos && !validos.includes(s)) continue;
    if (vistos.has(s)) continue;
    vistos.add(s);
    limpa.push(s);
  }
  return limpa;
}

// Publico de uma campanha.
//
//   criterios.jobIdAlvo  (obrigatorio) vaga sendo promovida
//   criterios.perfil | utmSource | recomendacao | dataDe | dataAte  (opcionais)
//   criterios.<filtro>IncluirSemAtributo  (bool, default false)
//
//   deps.db  camada de dados injetavel (padrao de lib/importar_vaga.js), para o teste
//            rodar contra um banco temporario sem tocar no modulo real.
//
// jobIdAlvo invalido LANCA, e nao devolve lista vazia. Ver a justificativa no erro.
function listarPublicoCampanha(criterios = {}, deps = {}) {
  const db = deps.db || dbPadrao;

  const jobIdAlvo = Number(criterios.jobIdAlvo);
  if (!Number.isInteger(jobIdAlvo) || jobIdAlvo <= 0) {
    // LANCA de proposito, em vez de devolver publico vazio. Vazio seria indistinguivel de
    // "nenhum elegivel" — um resultado plausivel, que esconderia a chamada malformada. E
    // devolver o publico INTEIRO (tratando o alvo como ausente) seria pior ainda: mandaria
    // a campanha para quem ja se candidatou aquela vaga. Sem vaga alvo nao ha pergunta
    // bem-formada a responder.
    throw new Error(
      `jobIdAlvo invalido (${criterios.jobIdAlvo}): o publico de campanha depende dele ` +
        'para excluir quem ja se candidatou a vaga que esta sendo promovida.',
    );
  }

  const janela = { dataDe: criterios.dataDe, dataAte: criterios.dataAte };

  // ── Exclusoes automaticas, montadas como conjuntos de e-mail NORMALIZADO ──
  // A comparacao acontece aqui (e nao no SQL) porque a normalizacao canonica do projeto e
  // Unicode-aware e o LOWER() do SQLite nao e; ver o comentario extenso em sqlite.js.
  const jaInscritos = new Set(
    db.listarEmailsInscritosNaVaga(jobIdAlvo).map(normalizarEmail).filter(Boolean),
  );
  const descadastrados = new Set(
    db.listarEmailsDescadastrados().map(normalizarEmail).filter(Boolean),
  );
  const excluidos = (email) => jaInscritos.has(email) || descadastrados.has(email);

  const linhasApp = db.listarCandidatosParaCampanha(janela).map((linha) => ({
    ...linha,
    // Canonizada UMA vez, com a mesma funcao do filtro do painel: 'grupo-whats' e
    // 'grupowhats' sao a mesma origem, e NULL/vazio e 'direto'.
    _origemCanonica: db.origemCanonica(linha.utm_source),
  }));
  const linhasTal = db.listarTalentosParaCampanha(janela);

  let pessoas = agruparPessoas(linhasApp, linhasTal, { excluidos });

  // ── Filtros opcionais, em cadeia ──
  // Aplicados em sequencia; cada um conta o "sem atributo" entre os SOBREVIVENTES dos
  // anteriores. E a leitura natural da tela: os numeros que o operador ve ao lado de cada
  // filtro descrevem o recorte que ele ja montou ate ali, nao a base inteira.
  const perfil = enumSaneado(criterios.perfil, PERFIS_VALIDOS);
  const recomendacao = enumSaneado(criterios.recomendacao, RECOMENDACOES_VALIDAS);
  const utmSource = criterios.utmSource ? db.origemCanonica(criterios.utmSource) : undefined;

  const passoPerfil = aplicarFiltroAtributo(pessoas, {
    ativo: Boolean(perfil),
    alvo: perfil,
    valores: (p) => p.perfis,
    incluirSemAtributo: criterios.perfilIncluirSemAtributo,
  });
  pessoas = passoPerfil.pessoas;

  const passoUtm = aplicarFiltroAtributo(pessoas, {
    ativo: Boolean(utmSource),
    alvo: utmSource,
    valores: (p) => p.origensUtm,
    incluirSemAtributo: criterios.utmSourceIncluirSemAtributo,
  });
  pessoas = passoUtm.pessoas;

  const passoRecomendacao = aplicarFiltroAtributo(pessoas, {
    ativo: Boolean(recomendacao),
    alvo: recomendacao,
    valores: (p) => p.recomendacoes,
    incluirSemAtributo: criterios.recomendacaoIncluirSemAtributo,
  });
  pessoas = passoRecomendacao.pessoas;

  // ── Base ──
  // SEM "incluir sem atributo", e nao por esquecimento: toda pessoa do publico veio de
  // alguma base — ou de uma candidatura, ou de um dos dois tipos de talento. Nao existe
  // "sem base", entao um checkbox ali seria um controle que nunca muda nada.
  const passoBase = aplicarFiltroMulti(pessoas, {
    selecionados: listaSaneada(criterios.bases, BASES_VALIDAS),
    valores: (p) => p.bases,
  });
  pessoas = passoBase.pessoas;

  // ── Cidade ──
  // Allowlist `null`: cidade e texto livre vindo do banco (o backfill derivou 9 valores,
  // mas a coluna aceita qualquer coisa), entao nao ha enum a validar. O saneamento aqui e
  // so descartar vazio e duplicata.
  //
  // `casaExtra` implementa o sentinela: quem tem 'Todas as cidades' casa com QUALQUER
  // selecao. Note que ele age sobre o valor DA PESSOA, nao sobre o marcado na tela — e
  // por isso que o sentinela nem precisa aparecer como opcao marcavel.
  const passoCidade = aplicarFiltroMulti(pessoas, {
    selecionados: listaSaneada(criterios.cidades, null),
    valores: (p) => p.cidades,
    incluirSemAtributo: criterios.cidadeIncluirSemAtributo,
    casaExtra: (valorDaPessoa) => valorDaPessoa === CIDADE_TODAS,
  });
  pessoas = passoCidade.pessoas;

  const itens = pessoas.map((p) => ({
    email: p.email,
    nome: p.nome,
    origemTipo: p.origemTipo,
    origemId: p.origemId,
  }));

  return {
    total: itens.length,
    porOrigem: {
      applications: itens.filter((i) => i.origemTipo === ORIGEM_APPLICATION).length,
      talentos: itens.filter((i) => i.origemTipo === ORIGEM_TALENTO).length,
    },
    // null (e nao 0) quando o filtro nem estava ligado: a tela precisa distinguir
    // "ninguem ficou de fora" de "esta pergunta nao foi feita".
    excluidosPorFiltro: {
      perfil: passoPerfil.semAtributo,
      utmSource: passoUtm.semAtributo,
      recomendacao: passoRecomendacao.semAtributo,
      // Base nunca tem "sem atributo" (todo mundo veio de alguma), entao e sempre null —
      // mantido no objeto por simetria, para a tela nao precisar de um caso especial.
      base: passoBase.semAtributo,
      cidade: passoCidade.semAtributo,
    },
    itens,
  };
}

module.exports = {
  listarPublicoCampanha,
  PERFIS_VALIDOS,
  RECOMENDACOES_VALIDAS,
  ORIGEM_APPLICATION,
  ORIGEM_TALENTO,
  BASE_CANDIDATURA,
  BASE_LEGADO,
  BASE_PROPRIO,
  BASES_VALIDAS,
  CIDADE_TODAS,
  // ── Expostos para lib/publicoCampanhaWhatsapp ──
  // Eram internos enquanto este era o unico motor de publico. O motor de WhatsApp precisa
  // das MESMAS regras de matching (o "sem atributo" fica de fora por padrao; nada marcado =
  // filtro inativo), e importa-las e o unico jeito de as duas nao divergirem no dia em que
  // uma for ajustada. Recopiar seria a garantia da divergencia — mesma decisao ja tomada com
  // os helpers de lib/whatsapp.
  aplicarFiltroAtributo,
  aplicarFiltroMulti,
};
