'use strict';

// Vocabulario de CIDADES (pracas de atuacao) — lido da tabela `cidades` (ETAPA B,
// Incremento 4).
//
// ── POR QUE ISTO ERA UM ARRAY CONGELADO, E POR QUE DEIXOU DE SER ──
// `jobs.endereco` e texto livre — digitado no painel ou redigido pelo LLM a partir do
// briefing (lib/importar_vaga). Em 7 vagas preenchidas, produziu 7 formatos diferentes:
//
//   Anita Garibaldi - Joinville-SC        bairro + cidade-UF, hifen
//   Anita Garibaldi - Joinville/SC        MESMO endereco, barra
//   Joinville, SC (bairro Bom Retiro)     cidade, UF, bairro entre parenteses
//   Unidade Santo Antonio - Joinville     unidade + cidade, sem UF
//   Sao Paulo - Cidade Moncoes            cidade + bairro, travessao
//   Alphaville Empresarial Barueri-SP     bairro + cidade-UF, sem separador
//   Campinas, Sao Paulo-SP                cidade + ESTADO, e o pior caso: contem o
//                                         literal "Sao Paulo" sendo uma vaga de Campinas
//
// O ultimo e o que decidiu a favor de um campo estruturado. Nenhum parser resolve: um
// LIKE '%Sao Paulo%' classificaria aquela vaga como Sao Paulo e erraria 156 candidatos.
// Por isso a cidade nasceu como vocabulario FECHADO — um array `Object.freeze` no
// codigo-fonte — e acrescentar uma praca era uma edicao de codigo deliberada, com revisao,
// de proposito: a ausencia desse atrito e que tinha produzido as sete variacoes acima.
//
// A tabela `cidades` (schema.sql) MOVE essa barreira de "code review" para "clique no
// admin" (ver Incremento 5 de ETAPA B), mas nao a remove: o cadastro continua sendo uma
// acao HUMANA deliberada — a IA do import de briefing so pode SUGERIR (ver
// lib/importar_vaga.cidadeSugeridaBruta), nunca inserir sozinha. A funcao `chave()` abaixo
// e a mesma de sempre, e o UNIQUE(chave) da tabela (nao UNIQUE(nome)) e quem impede que
// duas grafias da mesma cidade ("São José" e "Sao Jose") virem duas linhas — o mesmo
// incidente que o array fechado original existia para evitar, agora garantido pelo banco.
//
// ── POR QUE MODULO PROPRIO, e nao db/sqlite diretamente ──
// Sao tres consumidores previstos desde o inicio (normalizador, formulario do painel,
// prompt do LLM) e nenhum deles e dono da regra de normalizacao. sqlite.js so fala SQL
// (listarCidades/obterCidadePorChave); decidir o que e "canonico" e responsabilidade de
// dominio, e mora aqui — mesmo motivo de sempre, so que a fonte de dado por tras mudou.
const db = require('../db');

// NAO entra aqui: o sentinela 'Todas as cidades' de `talentos.cidade`.
//
// Ele marca uma PESSOA presente em qualquer praca (531 no legado) e serve ao filtro de
// publico, onde casa com qualquer selecao. Uma VAGA nao tem esse estado — ela acontece em
// um lugar, ou e remota (e ai `jobs.cidade` fica NULL). Oferecer o sentinela no seletor de
// vaga convidaria o operador a marca-lo achando que significa "qualquer lugar", e o
// resultado seria uma vaga presencial entrando em todo disparo regional.
//
// O sentinela vive hoje duplicado em lib/promocaoVagas.js e lib/limpezaLegado.js. Unificar
// os dois e limpeza legitima, mas e de outro assunto: aquilo e vocabulario de PESSOA, isto
// e de VAGA, e junta-los aqui so porque as strings se parecem seria o erro de sempre.

// Chave de comparacao: sem caixa, sem acento, sem espaco nas bordas.
//
// Pura e sem dependencia de banco de proposito: migrate.js chama esta funcao sozinha (sem
// puxar normalizarCidade/listarCidadesValidas, que dependem da tabela) para semear a
// tabela `cidades` durante a migracao, antes de haver qualquer linha nela.
//
// NFD separa a letra do diacritico e a faixa U+0300-U+036F apaga so o diacritico. Sete das
// nove pracas originais tem acento, e a origem mais provavel de um valor sem acento e um
// LLM redigindo a partir de briefing — onde "Sao Paulo" e grafia corrente. Recusar por
// causa de um til seria transformar um problema de digitacao em ausencia de dado.
function chave(valor) {
  return String(valor || '')
    .trim()
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '');
}

// Lista as pracas cadastradas, em ordem alfabetica pt-BR — a MESMA ordem de
// db.listarCidadesDistintas(), porque as duas listas aparecem lado a lado em tela e
// divergir na ordem pareceria bug.
//
// Consulta o BANCO a cada chamada, sem cache: a tabela e pequena (poucas dezenas de linhas
// no maximo — um vocabulario fechado por design), e cachear reintroduziria exatamente o
// problema que motivou esta migracao — uma cidade cadastrada pelo admin (Incremento 5) so
// apareceria no dropdown depois de reiniciar o processo, que e o oposto do objetivo.
//
// Substitui o antigo array `CIDADES_VALIDAS`: um array congelado nao pode, ao mesmo tempo,
// ser um valor simples E refletir uma tabela que muda em runtime — por isso virou funcao
// (unico ponto em que a interface publica deste modulo NAO ficou identica a de antes).
function listarCidadesValidas() {
  return db
    .listarCidades()
    .map((c) => c.nome)
    .sort((a, b) => a.localeCompare(b, 'pt-BR'));
}

// Normaliza para o valor CANONICO da tabela, ou null. MESMA assinatura/contrato de sempre
// (nenhum consumidor mudou por causa desta funcao) — so a fonte de dado por tras trocou.
//
// ── ENUM FECHADO, IGUAL A MODALIDADE ──
// Espelha normalizarModalidade: variacao de caixa/acento NAO e "invalido" (mapeia-se ao
// canonico via `chave`), mas qualquer coisa fora da tabela e recusada. A diferenca de
// retorno e deliberada — modalidade devolve '' porque o parse do import trata '' como
// ausente; aqui devolvemos null, que e o que vai para a coluna `jobs.cidade`. Quem precisa
// de '' converte no ponto de uso (o import faz isso).
//
// ── O QUE ESTA FUNCAO NAO FAZ, E POR QUE ──
// Nao ha fuzzy-match, nem "contem", nem inferencia a partir de `endereco`. A tentacao e
// obvia — daria para varrer "Anita Garibaldi - Joinville-SC" e achar "Joinville" — e e
// exatamente o que nao pode existir aqui: a mesma varredura, aplicada a "Campinas, Sao
// Paulo-SP", acharia "Sao Paulo" e marcaria como Sao Paulo uma vaga de Campinas, com 156
// candidatos atras. Um acerto silencioso e um erro silencioso saem do mesmo codigo, e o
// erro so aparece quando alguem em Campinas recebe convite do grupo de Sao Paulo.
//
// Endereco livre continua livre; quem decide a praca e uma escolha explicita, no seletor,
// no guard do import (que so SUGERE, nunca insere — ver cidadeSugeridaBruta) ou no cadastro
// deliberado do admin. Nao adivinhamos.
function normalizarCidade(valor) {
  const linha = db.obterCidadePorChave(chave(valor));
  return linha ? linha.nome : null;
}

module.exports = { chave, listarCidadesValidas, normalizarCidade };
