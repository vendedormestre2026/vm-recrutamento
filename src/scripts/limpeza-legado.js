'use strict';

// Limpeza pos-importacao da base legada: remove as empresas descartadas e preenche a
// coluna `cidade` dos legados restantes.
//
// DRY-RUN POR PADRAO. Sem `--commit`, so LE e imprime o relatorio. Mesma disciplina de
// src/scripts/importar-legado.js, e pela mesma razao: as duas acoes aqui sao
// irreversiveis (um DELETE e um UPDATE em massa) e rodam UMA vez sobre dado real.
//
// Uso:
//   node src/scripts/limpeza-legado.js            # dry-run (nao grava nada)
//   node src/scripts/limpeza-legado.js --commit   # executa, em transacao unica
//
// ONDE RODAR: no container (railway ssh) para agir em producao — grava no banco apontado
// por DATABASE_PATH, e local isso e o ./data/app.db de desenvolvimento.
//
// ── ESCOPO: SO categoria='legado' ──
// Cadastro proprio (/bancodecurriculos) nao entra em nenhuma das duas acoes. Ele nao tem
// campos_extras de onde derivar cidade, e nao ha razao para excluir ninguem que se
// cadastrou sozinho. O WHERE e a garantia.

const { config } = require('../config');
const db = require('../db');
const { planejarLimpeza, CIDADE_TODAS } = require('../lib/limpezaLegado');

const CATEGORIA_LEGADO = 'legado';

function lerArgumentos(argv) {
  return { commit: argv.slice(2).includes('--commit') };
}

function imprimirContagem(mapa, { indent = '    ' } = {}) {
  const linhas = [...mapa].sort((a, b) => b[1] - a[1]);
  const largura = Math.max(0, ...linhas.map(([c]) => String(c).length));
  for (const [chave, qtd] of linhas) {
    console.log(`${indent}${String(chave).padEnd(largura)}  ${String(qtd).padStart(6)}`);
  }
}

function main() {
  const { commit } = lerArgumentos(process.argv);

  const linhas = db
    .getDb()
    .prepare('SELECT id, email, campos_extras, cidade FROM talentos WHERE categoria = ?')
    .all(CATEGORIA_LEGADO);

  const { excluir, atualizar, relatorio } = planejarLimpeza(linhas);

  const totalTalentos = db.getDb().prepare('SELECT COUNT(*) AS n FROM talentos').get().n;
  const totalExcluir = [...relatorio.excluirPorEmpresa.values()].reduce((a, b) => a + b, 0);

  const modo = commit ? 'COMMIT (vai gravar)' : 'DRY-RUN (nao grava nada)';
  console.log('════════ limpeza da base legada — ' + modo + ' ════════');
  console.log(`banco            : ${config.caminhoBanco}`);
  console.log(`talentos (total) : ${totalTalentos}`);
  console.log(`legados lidos    : ${relatorio.lidos}`);
  console.log('');

  console.log('── 1. Exclusao por empresa ──');
  if (totalExcluir) {
    imprimirContagem(relatorio.excluirPorEmpresa);
    console.log(`    TOTAL a excluir                ${String(totalExcluir).padStart(6)}`);
  } else {
    console.log('    nenhum registro a excluir (clickhero / Wings)');
  }
  console.log('');

  console.log('── 2. Backfill de cidade ──');
  console.log(`a receber cidade agora           ${String(relatorio.aAtualizar).padStart(6)}`);
  console.log(`ja com a cidade correta          ${String(relatorio.jaCorretos).padStart(6)}   (idempotencia)`);
  console.log(`ficam SEM cidade (empresa vazia) ${String(relatorio.semEmpresa).padStart(6)}`);
  console.log('');

  console.log('── Distribuicao final por cidade ──');
  imprimirContagem(relatorio.porCidade, { indent: '  ' });
  const somaCidades = [...relatorio.porCidade.values()].reduce((a, b) => a + b, 0);
  console.log(`  ${'TOTAL com cidade'.padEnd(22)}  ${String(somaCidades).padStart(6)}`);
  if (relatorio.porCidade.has(CIDADE_TODAS)) {
    console.log('');
    console.log(`  NOTA: "${CIDADE_TODAS}" e valor SENTINELA, nao ausencia de cidade —`);
    console.log('  marca presenca em qualquer praca e deve casar com QUALQUER cidade num');
    console.log('  filtro futuro, sem depender de "incluir sem cidade".');
  }
  console.log('');

  // ── O alerta que pode parar tudo ──
  if (relatorio.naoMapeados.size) {
    const total = [...relatorio.naoMapeados.values()].reduce((a, b) => a + b, 0);
    console.log('⚠️  EMPRESAS NAO MAPEADAS — precisam de decisao humana ──');
    console.log(`${total} registro(s) ficariam SEM cidade por falta de mapeamento:`);
    imprimirContagem(relatorio.naoMapeados);
    console.log('');
    console.log('Adicione cada uma ao DICIONARIO_CIDADE em src/lib/limpezaLegado.js');
    console.log('e rode de novo. Nenhuma cidade foi inventada.');
    console.log('');
  } else {
    console.log('empresas nao mapeadas                 0   (todas as do banco sao conhecidas)');
    console.log('');
  }

  console.log('─────────────────────────────────────────────────────────');
  console.log(`SERIAM EXCLUIDOS : ${totalExcluir} talento(s).`);
  console.log(`SERIAM ATUALIZADOS: ${relatorio.aAtualizar} talento(s) com cidade.`);

  if (!commit) {
    console.log('');
    console.log('Nada foi gravado (dry-run). Para executar de verdade:');
    console.log('  node src/scripts/limpeza-legado.js --commit');
    console.log('═════════════════════════════════════════════════════════');
    return;
  }

  // Barreira final: empresa nao mapeada em aberto significa que alguem ficaria sem cidade
  // por omissao, e nao por decisao. O operador resolve o dicionario e roda de novo.
  if (relatorio.naoMapeados.size) {
    console.error('');
    console.error('[limpeza-legado] ABORTADO: ha empresas nao mapeadas (acima).');
    console.error('[limpeza-legado] Resolva o dicionario antes de gravar. Nada foi gravado.');
    process.exit(1);
  }

  const banco = db.getDb();
  const apagar = banco.prepare('DELETE FROM talentos WHERE id = ?');
  const atualizarCidade = banco.prepare('UPDATE talentos SET cidade = ? WHERE id = ?');

  // Transacao unica para as duas acoes: ou a base fica no estado novo inteiro, ou fica
  // como estava. Uma exclusao aplicada sem o backfill deixaria o operador sem saber em que
  // ponto parou, e nao ha marca no dado que diga.
  const executar = banco.transaction(() => {
    let excluidos = 0;
    for (const id of excluir) excluidos += apagar.run(id).changes;

    let atualizados = 0;
    for (const item of atualizar) atualizados += atualizarCidade.run(item.cidade, item.id).changes;

    return { excluidos, atualizados };
  });

  const r = executar();
  console.log('');
  console.log(`GRAVADO: ${r.excluidos} excluido(s), ${r.atualizados} atualizado(s) com cidade.`);
  console.log('═════════════════════════════════════════════════════════');
}

main();
