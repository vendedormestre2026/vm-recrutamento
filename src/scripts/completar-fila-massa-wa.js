'use strict';

// Completa a fila de uma campanha de disparo em massa JA materializada com quem esta no publico
// atual e ainda nao esta na fila.
//
// ── PARA QUE EXISTE ──
// A campanha 6 materializou 12 de 74: o "Excluir quem ja recebeu" tirou 62, e 47 deles eram da
// campanha 3, cujos envios nunca chegaram (nono digito). Depois da reclassificacao desses 47 para
// 'sem_destino' (reclassificar-sem-destino-massa-wa.js), eles voltam ao publico — mas a fila ja
// existe, e a rota de materializar recusa uma segunda materializacao. Este script e o caminho.
//
// ── QUEM ENTRA ──
// O MESMO publico da previa e da materializacao (lib/publicoMassaWhatsapp, com o "ja recebeu"
// ligado, salvo se a materializacao original o desligou): vaga aberta, status do recrutador da
// campanha, sem opt-out, sem quem recebeu de verdade. Menos quem ja esta na fila, em QUALQUER
// status — quem ja saiu, falhou ou pediu para sair nesta campanha nao volta por aqui.
//
// ── O QUE NAO FAZ ──
// Nao envia, nao toca o socket, nao muda status de campanha nem interruptor. Campanha com limite
// de destinatarios registrado e recusada: completar furaria um limite que alguem escolheu.
//
// ── CONCORRENCIA COM O WORKER ──
// Nao precisa pausar a campanha. A escrita e uma transacao SQLite (um escritor por vez; o worker
// espera ou e esperado), os itens novos entram com id maior e o worker le por `ORDER BY e.id` —
// quem ja estava pendente continua saindo primeiro. O unico efeito colateral possivel do worker,
// "fila vazia -> concluida", nao acontece com pendentes na fila.
//
// Uso (no container, via railway ssh):
//   node src/scripts/completar-fila-massa-wa.js --campanha 6                     # dry-run (read-only)
//   node src/scripts/completar-fila-massa-wa.js --campanha 6 --commit --motivo "..."
//
// Segunda execucao com --commit: 0 adicionados.

const ENCERRADAS = ['concluida', 'cancelada', 'excluida'];

const mascarar = (t) => {
  const d = String(t || '');
  return d.length < 8 ? '***' : `${d.slice(0, 4)}${'*'.repeat(d.length - 8)}${d.slice(-4)}`;
};

function lerCriterios(campanha) {
  try {
    return JSON.parse(campanha.criterios_json || '{}') || {};
  } catch {
    return {};
  }
}

// Dependencias injetadas para o teste. Devolve { ok, motivo?, faltantes, adicionados, cronograma }.
function executar({ db, publico, cadencia, fuso, campanhaId, commit = false, motivo = null, agora = new Date(), log = console.log } = {}) {
  const campanha = db.obterCampanhaMassaWa(campanhaId);
  if (!campanha) return { ok: false, motivo: `campanha ${campanhaId} nao existe` };
  if (ENCERRADAS.includes(campanha.status)) return { ok: false, motivo: `campanha ${campanhaId} esta '${campanha.status}'` };

  const criterios = lerCriterios(campanha);
  const mat = criterios.materializacao || {};
  if (mat.limite) return { ok: false, motivo: `campanha ${campanhaId} foi materializada com limite de ${mat.limite}` };
  const excluirJaReceberam = mat.excluirJaReceberam !== false;
  const statusList = criterios.statusList && criterios.statusList.length ? criterios.statusList : publico.STATUS_PADRAO;

  const r = publico.montarPublicoMassaWa({ jobId: campanha.job_id, statusList, excluirJaReceberam });
  const naFila = db.telefonesNaFilaMassaWa(campanhaId);
  const faltantes = r.itens.filter((i) => !naFila.has(i.telefoneCanonico));

  const resumo = Object.fromEntries(db.resumoCampanhaMassaWa(campanhaId).map((l) => [l.status, l.n]));
  const pendentesDepois = (resumo.pendente || 0) + faltantes.length;
  const enviadosHoje = db.contarEnviosMassaWaDesde(campanhaId, fuso.paraTextoSqlUtc(fuso.inicioDoDiaBrasiliaUtc(agora)));
  const cronograma = cadencia.projetarCronograma({
    pendentes: pendentesDepois, enviadosHoje, agora, cadencia: cadencia.resolverCadencia(campanha),
  });

  log(`──────── completar fila: campanha ${campanhaId} "${campanha.nome}" (${commit ? 'COMMIT' : 'dry-run, banco read-only'}) ────────`);
  log(`status da campanha: ${campanha.status} (nao e alterado) · statusList ${JSON.stringify(statusList)} · excluir ja receberam: ${excluirJaReceberam}`);
  log(`publico atual: ${r.funil.total} (pessoas ${r.funil.pessoas}, opt-out ${r.funil.pessoasOptoutCampanha + r.funil.pessoasOptoutAntigo}, ja receberam ${r.funil.pessoasJaReceberam} ${JSON.stringify(r.funil.jaReceberamPorCampanha)})`);
  log(`fila hoje: ${JSON.stringify(resumo)} · no publico e fora da fila: ${faltantes.length}`);
  for (const f of faltantes) log(`  + application ${f.applicationId} · vaga ${f.jobId} · ${mascarar(f.telefone)}`);
  log(`pendentes depois: ${pendentesDepois} · cronograma previsto: ${cronograma.dias.map((d) => `${d.data} (dia ${d.diaSemanaIso}): ${d.quantidade}`).join(' · ') || '-'}`);

  let adicionados = 0;
  if (commit && faltantes.length) {
    const g = db.completarFilaCampanhaMassaWa(campanhaId, faltantes, {
      em: fuso.paraTextoSqlUtc(agora),
      origem: 'reconciliacao',
      motivo: motivo || 'publico atual que nao estava na fila',
    });
    adicionados = g.adicionados;
    log(`ADICIONADOS: ${g.adicionados} (envios ${g.ids[0]}..${g.ids[g.ids.length - 1]}) · total na fila: ${g.total}`);
  } else if (commit) {
    log('ADICIONADOS: 0 (nada faltando)');
  }
  return { ok: true, faltantes, adicionados, cronograma, pendentesDepois };
}

function argumento(nome) {
  const i = process.argv.indexOf(nome);
  return i >= 0 ? process.argv[i + 1] : null;
}

if (require.main === module) {
  const commit = process.argv.includes('--commit');
  // Antes do require do db: sem --commit, a conexao abre SOMENTE LEITURA (ver getDb).
  if (!commit) process.env.DATABASE_READONLY = '1';
  const campanhaId = Number(argumento('--campanha'));
  if (!Number.isInteger(campanhaId) || campanhaId <= 0) {
    console.error('uso: node src/scripts/completar-fila-massa-wa.js --campanha <id> [--commit] [--motivo "..."]');
    process.exit(2);
  }
  const r = executar({
    db: require('../db'),
    publico: require('../lib/publicoMassaWhatsapp'),
    cadencia: require('../lib/cadenciaMassaWa'),
    fuso: require('../lib/fusoBrasilia'),
    campanhaId,
    commit,
    motivo: argumento('--motivo'),
  });
  if (!r.ok) {
    console.error(`RECUSADO: ${r.motivo}. Nada foi gravado.`);
    process.exitCode = 1;
  }
}

module.exports = { executar };
