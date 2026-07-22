'use strict';

// Migracao de DADOS (idempotente): atualiza o roteiro Closer CANONICO com o conteudo de
// src/db/roteiro_closer.json e aponta TODAS as vagas de perfil CLOSER para ele.
//
// HISTORICO — por que este script foi reescrito. A versao anterior elegia "a vaga ativa"
// com `SELECT ... FROM jobs WHERE ativo = 1 ORDER BY criado_em DESC LIMIT 1`, SEM filtrar
// por perfil, e a partir dela decidia (a) qual roteiro sobrescrever e (b) em qual vaga
// escrever `perfil='CLOSER'`. Em producao isso elegeu a vaga de SEED (sdr-prevendas), que
// era a ativa mais recente: carimbou CLOSER numa vaga SDR, deixou as duas vagas Closer
// reais apontando para um roteiro desatualizado e, por o roteiro_id da vaga eleita estar
// pendurado (FK quebrada), CRIOU um roteiro novo em vez de atualizar o existente.
// As quatro regras abaixo existem para que nada disso possa se repetir:
//   (a) o alvo sai do ROTEIRO canonico (nome/perfil), nunca de "a vaga mais recente";
//   (b) este script NUNCA escreve `jobs.perfil` — perfil e responsabilidade de quem
//       cadastra a vaga, nao de uma migracao de roteiro;
//   (c) FK pendurada ABORTA com erro explicito, nunca cria roteiro novo por conta propria;
//   (d) TODAS as vagas CLOSER sao repontadas, nao uma escolhida arbitrariamente.
//
// Seguranca: so escreve no SQLite. NAO toca em chaves nem chama APIs externas; e
// independente de INTERVIEW_MOCK. Roda migrar() antes para garantir schema/colunas.
//
// Uso: node src/db/migracao_roteiro_closer.js   (ou: npm run migrate:roteiro-closer)

const { migrar } = require('./migrate');
const { getDb } = require('./sqlite');

const NOME_ROTEIRO = 'Closer - BEI v1';
const VERSAO_ALVO = 3;

// Aborta a migracao com uma mensagem explicativa (sem stack trace ruidoso).
function abortar(mensagem) {
  console.error(`[migracao-roteiro] ABORTADO: ${mensagem}`);
  process.exit(1);
}

// Resolve o roteiro Closer CANONICO — o unico que este script pode sobrescrever.
// Ordem: (1) nome exato; (2) na falta dele, o unico roteiro de perfil CLOSER.
// Ambiguidade (nome duplicado, ou varios CLOSER sem nome canonico) ABORTA: escolher
// "o mais recente" as cegas foi exatamente o que produziu o incidente anterior.
function resolverRoteiroCanonico(db) {
  const porNome = db
    .prepare('SELECT id, versao FROM roteiros WHERE nome = ? ORDER BY id')
    .all(NOME_ROTEIRO);

  if (porNome.length === 1) return porNome[0];
  if (porNome.length > 1) {
    abortar(
      `existem ${porNome.length} roteiros com o nome "${NOME_ROTEIRO}" ` +
        `(ids: ${porNome.map((r) => r.id).join(', ')}). Nao da para saber qual e o canonico. ` +
        `Renomeie os historicos (ex.: "${NOME_ROTEIRO} (historico)") e rode de novo.`,
    );
  }

  const closers = db
    .prepare("SELECT id, versao FROM roteiros WHERE perfil = 'CLOSER' ORDER BY id")
    .all();

  if (closers.length === 1) return closers[0];
  if (closers.length > 1) {
    abortar(
      `nenhum roteiro se chama "${NOME_ROTEIRO}" e existem ${closers.length} roteiros de ` +
        `perfil CLOSER (ids: ${closers.map((r) => r.id).join(', ')}). Renomeie o canonico ` +
        `para "${NOME_ROTEIRO}" e rode de novo.`,
    );
  }

  return null; // nenhum roteiro CLOSER no banco — instalacao nova
}

function migrarRoteiroCloser() {
  migrar(); // garante schema + colunas incrementais

  const estrutura = require('./roteiro_closer.json');
  const estruturaJson = JSON.stringify(estrutura);
  const db = getDb();

  const vagasCloser = db
    .prepare("SELECT id, slug, roteiro_id FROM jobs WHERE perfil = 'CLOSER' ORDER BY id")
    .all();

  // (c) FK pendurada: vaga CLOSER apontando para roteiro inexistente. ABORTA — nao cria
  // roteiro novo. Criar por conta propria foi o que gerou um roteiro orfao em producao.
  const penduradas = vagasCloser.filter(
    (v) =>
      v.roteiro_id != null &&
      !db.prepare('SELECT 1 FROM roteiros WHERE id = ?').get(v.roteiro_id),
  );
  if (penduradas.length) {
    abortar(
      `${penduradas.length} vaga(s) CLOSER apontam para roteiro_id inexistente ` +
        `(${penduradas.map((v) => `id=${v.id} slug=${v.slug} -> roteiro_id=${v.roteiro_id}`).join('; ')}). ` +
        `Corrija o vinculo dessas vagas antes de migrar.`,
    );
  }

  let alvo = resolverRoteiroCanonico(db);

  if (!alvo) {
    // Instalacao nova: nenhum roteiro CLOSER existe. Aqui criar e seguro (nao ha nada
    // para sobrescrever nem vinculo para quebrar) — diferente do caso de FK pendurada.
    const info = db
      .prepare('INSERT INTO roteiros (nome, perfil, versao, estrutura) VALUES (?, ?, ?, ?)')
      .run(NOME_ROTEIRO, 'CLOSER', VERSAO_ALVO, estruturaJson);
    alvo = { id: Number(info.lastInsertRowid), versao: VERSAO_ALVO };
    console.log(`[migracao-roteiro] nenhum roteiro CLOSER existia; CRIADO id=${alvo.id}.`);
  } else {
    // TRAVA DE SEGURANCA: o motor le o conteudo do roteiro FRESCO por id a cada turno,
    // entao sobrescrever a linha no meio de uma entrevista dessincronizaria essa
    // entrevista. Checa so o roteiro canonico (o unico cujo CONTEUDO muda aqui).
    const emAndamento = db
      .prepare(
        "SELECT COUNT(*) AS n FROM interviews WHERE roteiro_id = ? AND status != 'concluido'",
      )
      .get(alvo.id).n;
    if (emAndamento > 0) {
      abortar(
        `existem ${emAndamento} entrevista(s) em andamento referenciando o roteiro ` +
          `id=${alvo.id}. Sobrescrever agora dessincronizaria essas entrevistas. ` +
          `Aguarde elas concluirem antes de migrar.`,
      );
    }

    // Bump de versao que nunca regride (mesmo criterio de migracao_roteiro_sdr.js).
    const novaVersao = Number(alvo.versao) >= VERSAO_ALVO ? Number(alvo.versao) : VERSAO_ALVO;
    db.prepare(
      `UPDATE roteiros
          SET nome = ?, perfil = 'CLOSER', versao = ?, estrutura = ?, atualizado_em = datetime('now')
        WHERE id = ?`,
    ).run(NOME_ROTEIRO, novaVersao, estruturaJson, alvo.id);
    console.log(
      `[migracao-roteiro] roteiro id=${alvo.id} ATUALIZADO p/ "${NOME_ROTEIRO}" (versao ${novaVersao}).`,
    );
  }

  // (d) TODAS as vagas CLOSER passam a apontar para o roteiro canonico. (b) `perfil` das
  // vagas NAO e tocado em nenhuma hipotese — o filtro ja garante que sao CLOSER.
  const desalinhadas = vagasCloser.filter((v) => v.roteiro_id !== alvo.id);
  if (desalinhadas.length) {
    const stmt = db.prepare('UPDATE jobs SET roteiro_id = ? WHERE id = ?');
    for (const v of desalinhadas) stmt.run(alvo.id, v.id);
    console.log(
      `[migracao-roteiro] ${desalinhadas.length} vaga(s) CLOSER repontada(s) p/ roteiro ` +
        `id=${alvo.id}: ${desalinhadas.map((v) => `id=${v.id} slug=${v.slug}`).join('; ')}.`,
    );
  } else if (vagasCloser.length) {
    console.log(`[migracao-roteiro] ${vagasCloser.length} vaga(s) CLOSER ja apontavam p/ o roteiro id=${alvo.id}.`);
  } else {
    console.warn('[migracao-roteiro] nenhuma vaga de perfil CLOSER encontrada; nenhum vinculo alterado.');
  }

  return alvo.id;
}

if (require.main === module) {
  try {
    const id = migrarRoteiroCloser();
    console.log(`[migracao-roteiro] concluido (roteiro id=${id}).`);
  } catch (err) {
    console.error('[migracao-roteiro] falha:', err.message);
    process.exit(1);
  }
}

module.exports = { migrarRoteiroCloser, NOME_ROTEIRO };
