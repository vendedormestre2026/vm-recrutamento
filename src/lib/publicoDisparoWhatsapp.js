'use strict';

// Motor de PUBLICO do disparo por WhatsApp: dada uma praca, quem ainda nao foi convidado.
//
// Irmao de lib/promocaoVagas (o motor de publico do e-mail), e a comparacao entre os dois e
// a melhor forma de entender este arquivo — porque quase tudo muda:
//
//                    promocaoVagas (e-mail)          este (WhatsApp)
//   unidade          e-mail normalizado              TELEFONE normalizado
//   recorte          vaga-alvo + filtros de tela     UMA praca, e so
//   exclusoes        4 (inscrito, opt-out, ...)      1 (ja tem linha em disparos_whatsapp)
//   quem tem cidade  a PESSOA (talentos.cidade)      a pessoa OU a VAGA dela
//
// A ultima linha e a peculiaridade que exige as duas consultas separadas abaixo.
//
// ── AS DUAS ORIGENS TEM A CIDADE EM LUGARES DIFERENTES ──
//
//   CANDIDATOS  `applications` nao tem cidade (a coluna existe, e orfa, esta 0% preenchida
//               em producao). A praca vem da VAGA: applications -> jobs.cidade. Ou seja, a
//               cidade de um candidato e onde fica a vaga a que ele se candidatou, nao onde
//               ele mora. E uma INFERENCIA, e esta registrada como tal — para um grupo
//               regional de processo seletivo ela e o recorte certo, mas nao e o mesmo dado.
//               Vaga remota tem jobs.cidade NULL e por isso nunca casa com praca nenhuma:
//               os 316 candidatos de vaga remota ficam FORA de todo disparo regional, por
//               definicao, nao por falta de dado.
//
//   LEGADO      `talentos.cidade`, preenchida por backfill de dicionario. E a praca da
//               PESSOA. Comparacao exata.
//
// Por isso nao existe um SELECT unico com UNION: as duas metades respondem "qual praca?"
// por caminhos que nao se parecem, e junta-las em SQL esconderia isso atras de um COALESCE.

const dbPadrao = require('../db');
const conexaoPadrao = require('../whatsapp/connection');
const { normalizarCidade } = require('./cidades');
const { normalizarTelefoneWhatsapp, normalizarTelefoneRecebido } = require('./whatsapp');

// Sentinela de `talentos.cidade`: marca presenca em QUALQUER praca (531 pessoas no legado).
//
// ── E ELE NAO ENTRA EM DISPARO NENHUM, e essa e uma decisao contra-intuitiva ──
// No motor de e-mail, quem tem este valor casa com qualquer cidade selecionada — la o
// coringa AMPLIA o publico de proposito. Aqui e o oposto: um grupo de WhatsApp e de UMA
// praca, e "presente em qualquer praca" nao diz em qual delas a pessoa esta. Coloca-la em
// todos os nove grupos seria a leitura literal do coringa e o pior resultado possivel; em
// um grupo escolhido a esmo, seria adivinhacao. Fica de fora ate haver dado melhor.
const CIDADE_TODAS = 'Todas as cidades';

// Primeira palavra do nome, para o vocativo da mensagem. Vazio quando nao ha nome — o
// template do n8n resolve a saudacao sem ele; inventar "Candidato" seria pior.
function primeiroNome(nome) {
  return String(nome || '').trim().split(/\s+/)[0] || '';
}

// ── O TELEFONE PRECISA SOBREVIVER A IDA E A VOLTA ──
//
// Incidente do primeiro disparo real (Joinville): o item 11 saiu daqui como
// "555547988301250" — 15 digitos, DDI 55 duplicado. A Meta aceitou e enviou (corrigindo o
// numero por conta propria, devolvendo um wa_id diferente), mas o POST /marcar-status
// REJEITOU o mesmo valor, e o disparo travou no meio com a mensagem ja entregue e nada
// registrado.
//
// A causa nao e o normalizador: e o DADO. O banco guarda literalmente "+55 +5547988301250"
// — o seletor de DDI do formulario prefixa "+55 " e a pessoa digitou o numero ja com +55.
// normalizarTelefoneWhatsapp aceita porque 15 digitos cabe no teto [10,15]; ja
// normalizarTelefoneRecebido, ao ver 15 digitos, nao reconhece o padrao 55+10/11, trata
// como nacional, prefixa 55 outra vez, chega a 17 e devolve null. Dai o 400.
//
// A regra aqui e o CONTRATO DE IDA E VOLTA: um telefone so entra na lista se, ao voltar
// pela fronteira da API, produzir exatamente ele mesmo. E a mesma funcao da rota — nao uma
// segunda validacao paralela que poderia divergir dela amanha.
//
// FAIL CLOSED: quem nao passa fica de FORA do disparo. A alternativa (mandar assim mesmo)
// e o que acabou de acontecer — mensagem entregue a um numero que o proprio sistema nao
// consegue registrar, e que volta na fila no ciclo seguinte para receber de novo.
//
// O log e a unica forma de esses registros nao sumirem de vista: eles nao aparecem em tela
// nenhuma, e o unico sintoma seria a fila ser menor do que alguem esperava.
function telefoneUtilizavel(telefone, contexto) {
  if (normalizarTelefoneRecebido(telefone) === telefone) return true;
  console.warn(
    `[telefone] EXCLUIDO do publico por nao sobreviver a ida e volta: ` +
      `${telefone} (${contexto}). Origem provavel: DDI duplicado no cadastro. ` +
      'Corrija o telefone na base para que a pessoa volte a ser elegivel.',
  );
  return false;
}

// Lista quem ainda NAO recebeu o convite do grupo daquela praca.
//
// Devolve [{ telefone, nome_primeiro, cargo }], telefone JA normalizado (so digitos, com
// DDI) — que e a forma que a rota devolve e a que o n8n disca.
//
// LANCA se a cidade for invalida. Deliberado: devolver [] silenciosamente para "Joinvile"
// ou "Blumenau" faria um disparo vazio parecer um disparo concluido, e ninguem investiga um
// zero que parece legitimo. O erro tem que ser barulhento no unico momento em que da para
// consertar — antes de rodar.
async function listarPendentesPorCidade(cidade, deps = {}) {
  const db = deps.db || dbPadrao;
  const onWhatsAppLote = deps.onWhatsAppLote || conexaoPadrao.onWhatsAppLote;

  const praca = normalizarCidade(cidade);
  if (!praca) {
    throw new Error(
      `Cidade invalida para disparo: ${JSON.stringify(cidade)}. ` +
        'Use uma das pracas de lib/cidades (listarCidadesValidas()).',
    );
  }

  // Chave do merge: telefone normalizado -> registro. Map preserva ordem de insercao, e
  // candidatos entram primeiro — ver a nota de precedencia abaixo.
  const porTelefone = new Map();

  // ── 1. CANDIDATOS ──
  // A praca vem de jobs.cidade. `j.cidade = ?` ja exclui vaga remota sem precisar de
  // condicao extra: NULL nunca e igual a nada em SQL.
  //
  // `cargo` = jobs.perfil ('SDR' | 'CLOSER'), usado COMO ESTA. Nao ha traducao para nome
  // comercial: o valor vai direto para o texto da mensagem, e inventar um mapeamento aqui
  // criaria uma segunda fonte de verdade sobre como a vaga se chama.
  for (const linha of db.listarCandidatosPorCidadeVaga(praca)) {
    const telefone = normalizarTelefoneWhatsapp(linha.telefone);
    if (!telefone) continue; // numero inutilizavel nao vira convite
    if (!telefoneUtilizavel(telefone, `application ${linha.id}, ${praca}`)) continue;
    // `has` protege a precedencia DENTRO da propria origem tambem: uma pessoa com duas
    // candidaturas na mesma praca aparece duas vezes na consulta, e a primeira vence.
    if (porTelefone.has(telefone)) continue;
    porTelefone.set(telefone, {
      telefone,
      nome_primeiro: primeiroNome(linha.nome),
      cargo: String(linha.perfil || '').trim(),
    });
  }

  // ── 2. LEGADO ──
  // PRECEDENCIA: candidatos vencem. Quem tem candidatura E cadastro legado com o mesmo
  // numero recebe a mensagem com o cargo da VAGA a que se candidatou — que e o contexto
  // vivo — e nao com o cargo de um cadastro antigo. Implementado pelo `has` abaixo, e nao
  // por ordem de SQL, porque a regra e do dominio e precisa estar visivel aqui.
  //
  // O sentinela e barrado na consulta (ver sqlite.js) E aqui, de novo: e a unica regra
  // deste arquivo cujo erro produz mensagem para quem nao deveria receber, e uma checagem
  // duplicada custa nada perto disso.
  for (const linha of db.listarLegadoPorCidade(praca)) {
    if (String(linha.cidade || '').trim() === CIDADE_TODAS) continue;
    const telefone = normalizarTelefoneWhatsapp(linha.telefone);
    if (!telefone) continue;
    if (!telefoneUtilizavel(telefone, `talento ${linha.id}, ${praca}`)) continue;
    if (porTelefone.has(telefone)) continue;
    porTelefone.set(telefone, {
      telefone,
      nome_primeiro: primeiroNome(linha.nome),
      // `talentos.cargo` como esta: sao 6 valores da base antiga ('Consultor Comercial',
      // 'Vendedor', 'SDR', 'Liderança Comercial', 'Closer', 'BDR'). NAO e o enum SDR|CLOSER
      // de perfil_interesse — so 2 dos 6 mapeariam nele, e forcar o mapeamento faria 4
      // grupos receberem um cargo que ninguem escreveu.
      cargo: String(linha.cargo || '').trim(),
    });
  }

  // ── 3. QUEM JA RECEBEU SAI ──
  // Depois do merge, e nao dentro de cada consulta: o filtro e por TELEFONE, e o telefone
  // so existe depois de normalizado. Um WHERE NOT IN no SQL compararia a coluna crua
  // ("+55 (47) 99958-2500") contra a normalizada e nao acharia nada — falharia ABERTO,
  // reenviando para todo mundo.
  //
  // Sem filtro de cidade nem de status: quem tem linha, tem linha. 'erro' tambem segura o
  // telefone (reprocessar e decisao humana) e um convite de outra praca ja entregue nao
  // deve virar um segundo convite.
  const jaEnviados = db.listarTelefonesDisparados();
  const restantes = [...porTelefone.values()].filter((p) => !jaEnviados.has(p.telefone));

  // ── 4. EXISTENCIA REAL (Incremento 4) ──
  // UMA chamada de rede pra toda a leva (onWhatsAppLote monta uma USyncQuery so), no mesmo
  // espirito FAIL CLOSED de telefoneUtilizavel: quem o Baileys confirma explicitamente NAO
  // ter WhatsApp sai da lista antes de chegar no n8n. "Nao verificado" (sem socket, erro,
  // instabilidade) NAO exclui — e o mesmo criterio de tolerancia do envio individual
  // (whatsapp/sequenciaOutbox.js): checagem de existencia e best-effort, nao trava rigida.
  if (!restantes.length) return restantes;
  const existencia = await onWhatsAppLote(restantes.map((p) => p.telefone));
  return restantes.filter((p) => existencia.get(p.telefone) !== false);
}

module.exports = {
  listarPendentesPorCidade,
  primeiroNome,
  CIDADE_TODAS,
  // Exportada para lib/publicoCampanhaWhatsapp. Era privada enquanto este era o unico motor
  // de publico por telefone; com dois, a guarda precisa ser a MESMA — a auditoria mostrou os
  // dois motores discordando sobre 6 registros reais de producao, e recopiar a regra seria
  // garantir que voltassem a divergir no primeiro ajuste.
  telefoneUtilizavel,
};
