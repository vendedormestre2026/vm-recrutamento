'use strict';

// Migracao de DADOS (idempotente): converte o roteiro SDR do formato ANTIGO/aninhado
// (estrutura.blocos = {abertura, competencias, fechamento}) para o formato RICO (blocos
// array + competencias top-level), MESMO shape do Closer. NAO muda o conteudo: mesmas
// perguntas, pesos, boas-respostas e nomes de bloco/competencia. Faz UPDATE na linha
// existente do roteiro SDR (in-place, mesmo padrao de migracao_roteiro_closer.js).
//
// TRAVA DE SEGURANCA: como o motor le o conteudo do roteiro FRESCO por id a cada turno,
// sobrescrever a linha no meio de uma entrevista dessincronizaria essa entrevista. Por
// isso, ABORTA se houver interview com status != 'concluido' referenciando este roteiro.
//
// Diferenca vs. o script do Closer: NAO mira "a vaga ativa" — mira o roteiro SDR
// especificamente (por nome 'SDR - Padrão v1', com fallback por perfil='SDR').
//
// Seguranca: so escreve no SQLite. NAO toca em chaves nem chama APIs externas; e
// independente de INTERVIEW_MOCK. Roda migrar() antes para garantir schema/colunas.
//
// Uso: node src/db/migracao_roteiro_sdr.js   (ou: npm run migrate:roteiro-sdr)

const { migrar } = require('./migrate');
const { getDb } = require('./sqlite');
const { ROTEIRO_SDR } = require('./seed');

const NOME_ROTEIRO = 'SDR - Padrão v1';

function migrarRoteiroSdr() {
  migrar(); // garante schema + colunas incrementais

  const db = getDb();

  // Alvo: o roteiro SDR por NOME; fallback pelo perfil='SDR' (mais recente).
  const alvo =
    db.prepare('SELECT id, versao FROM roteiros WHERE nome = ?').get(NOME_ROTEIRO) ||
    db
      .prepare("SELECT id, versao FROM roteiros WHERE perfil = 'SDR' ORDER BY id DESC LIMIT 1")
      .get();

  if (!alvo) {
    console.warn(
      '[migracao-roteiro-sdr] nenhum roteiro SDR encontrado (nome/perfil). Nada a migrar. ' +
        'Rode `npm run seed` primeiro para criar o roteiro SDR.',
    );
    return null;
  }
  const roteiroId = alvo.id;

  // TRAVA: entrevistas em andamento referenciando este roteiro nao podem ser
  // dessincronizadas por uma troca de estrutura no ar.
  const emAndamento = db
    .prepare(
      "SELECT COUNT(*) AS n FROM interviews WHERE roteiro_id = ? AND status != 'concluido'",
    )
    .get(roteiroId).n;

  if (emAndamento > 0) {
    console.error(
      `[migracao-roteiro-sdr] ABORTADO: existem ${emAndamento} entrevista(s) SDR em andamento ` +
        `referenciando o roteiro id=${roteiroId}. Sobrescrever agora dessincronizaria essas ` +
        `entrevistas (o motor le o conteudo do roteiro fresco por id a cada turno). ` +
        `Aguarde elas concluirem antes de migrar.`,
    );
    process.exit(1);
  }

  // UPDATE in-place com o shape RICO do ROTEIRO_SDR (seed.js). Idempotente: rodar de novo
  // reescreve o mesmo conteudo (nenhum erro). Bump de versao p/ marcar a migracao.
  const estruturaJson = JSON.stringify(ROTEIRO_SDR.estrutura);
  const novaVersao = Number(alvo.versao) >= 2 ? Number(alvo.versao) : 2;
  db.prepare(
    `UPDATE roteiros
        SET nome = ?, perfil = 'SDR', versao = ?, estrutura = ?, atualizado_em = datetime('now')
      WHERE id = ?`,
  ).run(NOME_ROTEIRO, novaVersao, estruturaJson, roteiroId);

  console.log(
    `[migracao-roteiro-sdr] roteiro id=${roteiroId} ATUALIZADO p/ formato rico ` +
      `(perfil SDR, versao ${novaVersao}). Conteudo preservado.`,
  );
  return roteiroId;
}

if (require.main === module) {
  try {
    const id = migrarRoteiroSdr();
    console.log(`[migracao-roteiro-sdr] concluido (roteiro id=${id}).`);
  } catch (err) {
    console.error('[migracao-roteiro-sdr] falha:', err.message);
    process.exit(1);
  }
}

module.exports = { migrarRoteiroSdr, NOME_ROTEIRO };
