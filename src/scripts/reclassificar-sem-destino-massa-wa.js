'use strict';

// Reclassifica como 'sem_destino' os 47 envios da campanha 3 de disparo em massa que nunca chegaram.
//
// ── A EVIDENCIA ──
// A campanha 3 saiu em 2026-09-29, 13:54–14:02 de Brasilia, ANTES da correcao do nono digito
// (commit 91196f4, em producao no deploy 7bceaa17 as 17:32). Os 50 envios ficaram 'enviado', mas
// no log do deploy 216661af 47 deles tem, colado ao "enviado para 55DD*****NNNN" (0 a 19 ms), um
// "USync fetch yielded no results for pending PNs": o WhatsApp nao achou aparelho para o numero, e
// a mensagem nao teve destino. Os 3 restantes (applications 2547, 2480, 2366) nao tem USync e
// receberam. O pareamento log -> linha da fila foi por 4 primeiros + 4 ultimos digitos dentro da
// janela do lote: 50 de 50 casaram com uma linha so, sem sobra (analise de 2026-10-01).
//
// ── POR QUE RECLASSIFICAR ──
// "Ja recebeu" (db.recebedoresDisparoMassaWa) conta status 'enviado'. Com os 47 la, a opcao
// "Excluir quem ja recebeu" tira do publico gente que nunca recebeu a mensagem. 'sem_destino' nao
// conta, e eles voltam (ver o PASSO 4: completar-fila-massa-wa.js).
//
// ── O QUE ESTE SCRIPT FAZ, E O QUE NAO FAZ ──
// Muda status e erro de exatamente estas 47 linhas, preservando enviado_em. Nao envia nada, nao
// toca o socket, nao muda status de campanha nem interruptor. Tudo-ou-nada: se qualquer uma das 47
// nao estiver em 'enviado' (ou ja em 'sem_destino') na campanha 3, nada e gravado.
//
// Uso (no container, via railway ssh):
//   node src/scripts/reclassificar-sem-destino-massa-wa.js            # dry-run (banco read-only)
//   node src/scripts/reclassificar-sem-destino-massa-wa.js --backup   # JSON das linhas da campanha 3
//   node src/scripts/reclassificar-sem-destino-massa-wa.js --commit   # grava
//
// Segunda execucao com --commit: 0 alteracoes (as 47 ja estao em 'sem_destino').

const CAMPANHA = 3;

// As 47 applications com USync sem resultado. 2547, 2480 e 2366 (receberam) NAO estao aqui.
const APPLICATION_IDS = Object.freeze([
  2607, 2605, 2574, 2564, 2534, 2531, 2524, 2512, 2497, 2470, 2466, 2452, 2446, 2444, 2438, 2422,
  2391, 2379, 2374, 2373, 2372, 2371, 2370, 2369, 2367, 2365, 2361, 2360, 2359, 2358, 2357, 2356,
  2355, 2354, 2353, 2352, 2351, 2350, 2349, 2348, 2347, 2346, 2345, 2344, 2343, 2342, 2341,
]);

const ERRO =
  'USync sem resultado (log de 29/09), envio anterior à correção do nono dígito (commit 91196f4, deploy 7bceaa17)';

function resumoPorStatus(db) {
  return Object.fromEntries(db.resumoCampanhaMassaWa(CAMPANHA).map((l) => [l.status, l.n]));
}

// `db` injetado para o teste. Devolve o resultado de reclassificarEnviosMassaWaSemDestino mais o
// resumo antes/depois.
function executar({ db, commit = false, log = console.log } = {}) {
  const antes = resumoPorStatus(db);
  const r = db.reclassificarEnviosMassaWaSemDestino(CAMPANHA, APPLICATION_IDS, ERRO, { commit });
  const depois = resumoPorStatus(db);

  log(`──────── reclassificar sem_destino: campanha ${CAMPANHA} (${commit ? 'COMMIT' : 'dry-run, banco read-only'}) ────────`);
  log(`status antes : ${JSON.stringify(antes)}`);
  log(`a reclassificar (enviado -> sem_destino): ${r.plano.length}`);
  for (const l of r.plano) log(`  envio ${l.id} · application ${l.application_id} · enviado_em ${l.enviado_em}`);
  log(`ja em sem_destino (rodada anterior): ${r.jaReclassificados.length}`);
  if (r.problemas.length) {
    log(`PROBLEMAS (${r.problemas.length}) — NADA foi gravado:`);
    for (const p of r.problemas) log(`  application ${p.applicationId}: ${p.motivo}`);
  }
  log(`alterados    : ${r.alterados}`);
  log(`status depois: ${JSON.stringify(depois)}`);
  return { ...r, antes, depois };
}

if (require.main === module) {
  const commit = process.argv.includes('--commit');
  const backup = process.argv.includes('--backup');
  // Antes do require do db: sem --commit, a conexao abre SOMENTE LEITURA (ver getDb).
  if (!commit) process.env.DATABASE_READONLY = '1';
  const db = require('../db');
  if (backup) {
    process.stdout.write(`${JSON.stringify(db.listarEnviosCampanhaMassaWa(CAMPANHA), null, 1)}\n`);
  } else {
    const r = executar({ db, commit });
    if (r.problemas.length) process.exitCode = 1;
  }
}

module.exports = { executar, CAMPANHA, APPLICATION_IDS, ERRO };
