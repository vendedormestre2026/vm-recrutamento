'use strict';

// Exclusao FISICA das 2 vagas de teste identificadas na ETAPA A (diagnostico 2026-08-27):
//   id 14 — "TESTE PUSH - apagar depois" (slug teste-push-apagar-depois)
//   id 3  — "SDR / Pré-vendas"           (slug sdr-prevendas)
//
// Alvo FIXO no codigo, de proposito — nao le argumentos de linha de comando pra escolher
// QUAL vaga apagar. Isto e um script ONE-OFF, nao uma ferramenta generica de exclusao: se
// amanha aparecer uma terceira vaga de teste, o certo e editar este arquivo (ou escrever
// outro) com revisao, e nao dar a quem roda o poder de apagar qualquer id na linha de
// comando.
//
// DRY-RUN POR PADRAO, mesma disciplina de limpeza-legado.js: sem --commit, so LE as MESMAS
// 4 tabelas que db.excluirVaga checa (mesmo criterio: job_id = ?, mesma ordem) e imprime o
// que aconteceria — sem chamar db.excluirVaga. Nao chama a funcao real em dry-run de
// proposito: no caminho feliz (0 dependentes) ela FAZ o DELETE, e um "dry-run" que as
// vezes apaga de verdade nao e dry-run nenhum. db.excluirVaga(id) so e chamada com
// --commit, e e la (nao aqui) que mora a guarda de verdade — este script LE duas vezes a
// mesma coisa (aqui pra mostrar, la pra decidir), nao reimplementa a decisao.
//
// ONDE RODAR: no container (railway ssh) para agir em producao — grava no banco apontado
// por DATABASE_PATH (Dockerfile define DATABASE_PATH=/data/app.db la; `railway run` NAO
// serve para isto, ele roda local com DATABASE_PATH incorreto — ver o comentario de
// limpeza-legado.js e a nota de infra do diagnostico da ETAPA A).
//
// Uso:
//   node src/scripts/excluir-vagas-teste.js            # dry-run (nao grava nada)
//   node src/scripts/excluir-vagas-teste.js --commit    # executa, uma vaga por vez

const { config } = require('../config');
const db = require('../db');

const IDS_ALVO = [14, 3];

function lerArgumentos(argv) {
  return { commit: argv.slice(2).includes('--commit') };
}

function main() {
  const { commit } = lerArgumentos(process.argv);

  const modo = commit ? 'COMMIT (vai gravar)' : 'DRY-RUN (nao grava nada)';
  console.log('════════ exclusao das vagas de teste — ' + modo + ' ════════');
  console.log(`banco : ${config.caminhoBanco}`);
  console.log('');

  const banco = db.getDb();
  let algumBloqueado = false;

  for (const id of IDS_ALVO) {
    const vaga = banco.prepare('SELECT id, slug, titulo, ativo, criado_em FROM jobs WHERE id = ?').get(id);
    if (!vaga) {
      console.log(`id ${id}: NAO ENCONTRADA — nada a fazer (ja foi excluida antes, ou id errado).`);
      console.log('');
      continue;
    }

    console.log(`id ${vaga.id} — "${vaga.titulo}" (slug ${vaga.slug}, ativo=${vaga.ativo}, criada em ${vaga.criado_em})`);

    if (!commit) {
      // db.excluirVaga roda a checagem de verdade DENTRO de uma transacao (ver o
      // comentario dela em sqlite.js), mas o DELETE so acontece se todas as 4 tabelas
      // derem zero — chamar aqui, em dry-run, e seguro: ou nao apaga nada (recusado) ou
      // apagaria de verdade. Por isso o dry-run NAO chama excluirVaga diretamente — faria
      // o DELETE de verdade no caminho feliz. Em vez disso, reproduz SO A LEITURA das 4
      // tabelas, no MESMO criterio (ver TABELAS_DEPENDENTES_VAGA em sqlite.js), sem tocar
      // em nada.
      const tabelas = ['applications', 'vaga_acessos', 'campanhas', 'campanhas_whatsapp'];
      let bloqueadaPor = null;
      for (const tabela of tabelas) {
        const { n } = banco.prepare(`SELECT COUNT(*) AS n FROM ${tabela} WHERE job_id = ?`).get(id);
        console.log(`    ${tabela.padEnd(20)} ${n}`);
        if (n > 0 && !bloqueadaPor) bloqueadaPor = { tabela, n };
      }
      if (bloqueadaPor) {
        algumBloqueado = true;
        console.log(`    -> SERIA RECUSADA: ${bloqueadaPor.n} registro(s) em ${bloqueadaPor.tabela}.`);
      } else {
        console.log('    -> SERIA EXCLUIDA (0 dependentes nas 4 tabelas).');
      }
    } else {
      // --commit: chama a funcao de verdade, uma vaga por vez — nao para no meio se uma
      // falhar (ex.: id ja excluido por outra pessoa entre o dry-run e agora), a outra
      // ainda deve ser tentada.
      const r = db.excluirVaga(id);
      if (r.ok) {
        console.log(`    -> EXCLUIDA: "${r.titulo}".`);
      } else {
        algumBloqueado = true;
        console.log(`    -> RECUSADA [${r.erroCodigo}]: ${r.mensagem}`);
      }
    }
    console.log('');
  }

  console.log('─────────────────────────────────────────────────────────');
  if (!commit) {
    console.log('Nada foi gravado (dry-run). Para executar de verdade:');
    console.log('  node src/scripts/excluir-vagas-teste.js --commit');
  } else {
    console.log(algumBloqueado ? 'Concluido, com pelo menos uma recusa (ver acima).' : 'Concluido: as vagas listadas foram excluidas.');
  }
  console.log('═════════════════════════════════════════════════════════');
}

main();
