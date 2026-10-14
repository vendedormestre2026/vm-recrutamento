'use strict';

// Lista as campanhas de disparo em massa cujas variacoes NAO sao redacoes do texto-base, e
// regenera UMA delas por vez, com --commit explicito.
//
// ── PARA QUE EXISTE ──
// Ate 2026-10-14 a criacao e o "Sugerir com IA" gravavam as sementes do convite qualquer que fosse
// o texto-base (ver "O TEXTO-BASE E A FONTE DA VERDADE" em lib/variacoesMassaWa). As campanhas
// criadas antes disso podem ter variacoes que nao correspondem ao texto digitado — a 9 enviou um
// convite no lugar de um lembrete. Este script MOSTRA quais sao e, quando ainda da para
// aproveitar a campanha (rascunho ou pausada), gera as variacoes a partir do texto-base.
//
// ── O QUE CONTA COMO AFETADA (so tipo entrevista; o segmento nao passa por aqui) ──
//   - as variacoes nao passam na validacao CONTRA o texto-base da campanha;
//   - ou ha erro de geracao registrado (variacoes_erro);
//   - ou as variacoes estao desatualizadas (texto-base mudou, ou campanha anterior ao carimbo).
// A linha diz tambem quantas variacoes sao identicas as sementes: e a assinatura do bug.
//
// ── O QUE NAO FAZ ──
// Nao muda status de campanha (uma pausada continua pausada: reativar e gesto humano), nao toca a
// fila, nao envia. Campanha concluida, cancelada ou excluida e so listada: o que saiu, saiu, e o
// caminho e criar uma campanha nova. Sem --commit, nao grava nada e abre o banco SOMENTE LEITURA.
// --commit exige --campanha (uma por vez) e MASSA_WA_LLM_ATIVO=true — e chama o LLM de verdade.
// Falha na geracao registra o erro na campanha (a tela mostra) e nao grava variacao nenhuma.
//
// Uso (no container, via railway ssh — nunca railway run, que usaria o banco local):
//   node src/scripts/regenerar-variacoes-massa-wa.js                              # dry-run
//   node src/scripts/regenerar-variacoes-massa-wa.js --campanha 12                # dry-run de uma
//   MASSA_WA_LLM_ATIVO=true node src/scripts/regenerar-variacoes-massa-wa.js --campanha 12 --commit

const REGENERAVEIS = ['rascunho', 'pausada'];

// Diagnostico de UMA campanha (puro, sobre o que veio do banco).
function diagnosticar(campanha, textos, variacoes) {
  const base = variacoes.textoBaseEfetivo(campanha);
  const sementes = new Set(variacoes.VARIACOES_SEED.map((t) => String(t).trim()));
  const valid = variacoes.validarVariacoes(textos, { textoBase: base });
  const bloqueio = variacoes.bloqueioDasVariacoes(campanha, { temVariacoes: textos.length > 0 });
  const motivos = [];
  const iguaisSemente = textos.filter((t) => sementes.has(String(t).trim())).length;
  if (iguaisSemente && !variacoes.ehTextoBasePadrao(base)) {
    motivos.push(`${iguaisSemente} variação(ões) idêntica(s) às sementes do convite, com texto-base próprio`);
  }
  if (!valid.ok) motivos.push(`não passam contra o texto-base (${[...new Set(valid.problemas.map((p) => p.codigo))].join(', ')})`);
  if (bloqueio === 'com_erro') motivos.push(`erro de geração registrado: ${campanha.variacoes_erro}`);
  if (bloqueio === 'desatualizadas') motivos.push('desatualizadas (texto-base mudou, ou campanha anterior ao carimbo)');
  return {
    id: campanha.id,
    nome: campanha.nome,
    status: campanha.status,
    variacoes: textos.length,
    iguaisSemente,
    afetada: motivos.length > 0,
    motivos,
    regeneravel: REGENERAVEIS.includes(campanha.status),
  };
}

// Dependencias injetadas para o teste. Devolve { ok, motivo?, diagnosticos, regenerada? }.
async function executar({ db, publico, variacoes, gerador, campanhaId = null, commit = false, log = console.log } = {}) {
  if (commit && !campanhaId) return { ok: false, motivo: '--commit exige --campanha <id> (uma campanha por vez)' };

  const todas = campanhaId
    ? [db.obterCampanhaMassaWa(campanhaId)].filter(Boolean)
    : db.listarCampanhasMassaWa();
  if (campanhaId && !todas.length) return { ok: false, motivo: `campanha ${campanhaId} nao existe` };

  const diagnosticos = [];
  for (const c of todas) {
    if (publico.fonteDaCampanhaMassaWa(c) !== publico.FONTE_VAGAS_ABERTAS) {
      log(`campanha ${c.id} (${c.status}): segmento — fora deste script.`);
      continue;
    }
    const textos = db.listarVariacoesMassaWa(c.id).map((v) => v.texto);
    const d = diagnosticar(c, textos, variacoes);
    diagnosticos.push(d);
    if (!d.afetada) {
      log(`campanha ${d.id} (${d.status}) "${d.nome}": ok — ${d.variacoes} variação(ões) de acordo com o texto-base.`);
      continue;
    }
    const acao = d.regeneravel
      ? 'regenerável com --commit'
      : `nada a fazer (${d.status}): o que saiu já saiu; crie uma campanha nova se precisar`;
    log(`campanha ${d.id} (${d.status}) "${d.nome}": AFETADA — ${d.motivos.join('; ')} · ${acao}`);
  }
  log(`afetadas: ${diagnosticos.filter((d) => d.afetada).length} de ${diagnosticos.length} campanha(s) do tipo entrevista.`);

  if (!commit) {
    log('DRY-RUN: nada foi gravado. Para regenerar uma campanha: --campanha <id> --commit (exige MASSA_WA_LLM_ATIVO=true).');
    return { ok: true, diagnosticos };
  }

  const alvo = todas[0];
  const d = diagnosticos.find((x) => x.id === alvo.id);
  if (!d) return { ok: false, motivo: `campanha ${alvo.id} e de segmento`, diagnosticos };
  if (!d.regeneravel) return { ok: false, motivo: `campanha ${alvo.id} esta '${alvo.status}' (so rascunho ou pausada)`, diagnosticos };
  if (!gerador.iaLigada()) return { ok: false, motivo: `${gerador.ENV_ATIVO} desligado: nenhuma chamada ao LLM foi feita`, diagnosticos };

  const r = await gerador.gerarVariacoes(variacoes.textoBaseEfetivo(alvo), { db });
  if (!r.ok) {
    db.registrarErroVariacoesMassaWa(alvo.id, r.erro);
    log(`FALHOU: ${r.erro} (erro registrado na campanha; nenhuma variação gravada).`);
    return { ok: false, motivo: 'geracao falhou', diagnosticos };
  }
  db.salvarVariacoesMassaWa(alvo.id, r.variacoes);
  log(`REGENERADA: campanha ${alvo.id}, 7 variações a partir do texto-base (${r.tentativas} tentativa(s)). Status mantido: '${alvo.status}'.`);
  return { ok: true, diagnosticos, regenerada: alvo.id };
}

function argumento(nome) {
  const i = process.argv.indexOf(nome);
  return i >= 0 ? process.argv[i + 1] : null;
}

if (require.main === module) {
  const commit = process.argv.includes('--commit');
  // Antes do require do db: sem --commit, a conexao abre SOMENTE LEITURA (ver getDb).
  if (!commit) process.env.DATABASE_READONLY = '1';
  const bruto = argumento('--campanha');
  const campanhaId = bruto == null ? null : Number(bruto);
  if (bruto != null && (!Number.isInteger(campanhaId) || campanhaId <= 0)) {
    console.error('uso: node src/scripts/regenerar-variacoes-massa-wa.js [--campanha <id>] [--commit]');
    process.exit(2);
  }
  executar({
    db: require('../db'),
    publico: require('../lib/publicoMassaWhatsapp'),
    variacoes: require('../lib/variacoesMassaWa'),
    gerador: require('../lib/gerarVariacoesMassaWa'),
    campanhaId,
    commit,
  }).then((r) => {
    if (!r.ok) {
      console.error(`RECUSADO: ${r.motivo}. Nada foi gravado.`);
      process.exitCode = 1;
    }
  }).catch((err) => {
    console.error(`ERRO: ${err.message}`);
    process.exitCode = 1;
  });
}

module.exports = { executar, diagnosticar, REGENERAVEIS };
