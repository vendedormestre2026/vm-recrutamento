'use strict';

// Preenche `jobs.cidade` das vagas que ja existiam quando a coluna foi criada.
//
// DRY-RUN POR PADRAO. Sem `--commit`, so LE e imprime o plano. Mesma disciplina de
// src/scripts/limpeza-legado.js e importar-legado.js, e pela mesma razao: e um UPDATE
// sobre dado real que roda UMA vez.
//
// Uso:
//   node src/scripts/backfill-cidade-vagas.js            # dry-run (nao grava nada)
//   node src/scripts/backfill-cidade-vagas.js --commit   # executa, em transacao unica
//
// ONDE RODAR: no container (railway ssh) para agir em producao.
//
// ── O MAPA E FIXO, E ISSO E O PONTO ──
// Cada par abaixo foi decidido POR PESSOA, lendo o endereco de cada vaga. Nada aqui infere
// nada: nao ha parsing de `jobs.endereco`, nao ha "contem Joinville". A razao esta em
// lib/cidades e vale repetir — a vaga 6 tem endereco "Campinas, Sao Paulo-SP" e e uma vaga
// de CAMPINAS. Qualquer varredura automatica a marcaria como Sao Paulo e mandaria 156
// candidatos para o grupo errado.
//
// NULL tambem e uma decisao, nao ausencia dela:
//   3  sem endereco e sem candidatos — nada a afirmar;
//   4  e 5 sao remotas (316 candidatos somados). Vaga remota nao tem praca; forcar uma
//      as colocaria num disparo regional a que nao pertencem.
//
// Este script NAO deve virar rotina. Ele existe para as 10 vagas anteriores a coluna; toda
// vaga nova ja nasce com o <select> do painel e o guard do import por briefing.
const MAPA = new Map([
  [1, 'São Paulo'],
  [2, 'Joinville'],
  [3, null],
  [4, null],
  [5, null],
  [6, 'Campinas'],
  [7, 'Joinville'],
  [8, 'Barueri'],
  [9, 'Joinville'],
  [10, 'Joinville'],
]);

const db = require('../db');
const { normalizarCidade } = require('../lib/cidades');

function lerArgumentos(argv) {
  return { commit: argv.slice(2).includes('--commit') };
}

// A coluna so existe depois da migracao, que roda no boot da aplicacao. Rodar este script
// contra um banco que ainda nao a tem daria "no such column" no meio do UPDATE — erro que
// nao explica nada a quem esta operando. Melhor dizer o que falta.
function garantirColuna() {
  const tem = db
    .getDb()
    .prepare('SELECT * FROM pragma_table_info(?)')
    .all('jobs')
    .some((c) => c.name === 'cidade');
  if (!tem) {
    console.error('ERRO: a coluna jobs.cidade nao existe neste banco.');
    console.error('  Ela e criada pela migracao, que roda no boot da aplicacao.');
    console.error('  Suba o codigo (railway up) antes de rodar este script em producao.');
    process.exit(1);
  }
}

function main() {
  const { commit } = lerArgumentos(process.argv);
  console.log(`Backfill de jobs.cidade — ${commit ? 'COMMIT (vai gravar)' : 'DRY-RUN (nao grava nada)'}`);
  console.log('');

  garantirColuna();

  const vagas = db
    .getDb()
    .prepare('SELECT id, titulo, endereco, modalidade, cidade FROM jobs ORDER BY id')
    .all();

  // Validacao do MAPA contra o vocabulario, ANTES de qualquer escrita: um typo aqui
  // ('Joinvile') gravaria uma praca que nenhum filtro encontra, e o sintoma seria uma vaga
  // que some do recorte sem erro nenhum.
  const invalidos = [...MAPA].filter(([, c]) => c !== null && normalizarCidade(c) !== c);
  if (invalidos.length) {
    console.error('ERRO: o mapa tem cidades fora de CIDADES_VALIDAS:');
    for (const [id, c] of invalidos) console.error(`  job ${id}: ${JSON.stringify(c)}`);
    process.exit(1);
  }

  // Vagas em tela mas fora do mapa: nao sao erro (podem ter sido criadas depois, ja com o
  // seletor), mas precisam aparecer — silenciar seria deixar o operador achar que o script
  // cobriu tudo.
  const foraDoMapa = vagas.filter((v) => !MAPA.has(v.id));
  const orfaos = [...MAPA.keys()].filter((id) => !vagas.some((v) => v.id === id));

  const larguraTitulo = Math.max(...vagas.map((v) => String(v.titulo || '').slice(0, 30).length));
  let mudam = 0;
  console.log('  id | titulo'.padEnd(larguraTitulo + 8) + ' | endereco atual                     | cidade: antes -> depois');
  console.log('  ' + '-'.repeat(larguraTitulo + 78));
  for (const v of vagas) {
    if (!MAPA.has(v.id)) continue;
    const alvo = MAPA.get(v.id);
    const muda = (v.cidade || null) !== alvo;
    if (muda) mudam += 1;
    console.log(
      `  ${String(v.id).padStart(2)} | ${String(v.titulo || '').slice(0, 30).padEnd(larguraTitulo)}` +
        ` | ${String(v.endereco || '(vazio)').slice(0, 34).padEnd(34)}` +
        ` | ${String(v.cidade === null ? 'NULL' : v.cidade).padEnd(12)} -> ${alvo === null ? 'NULL' : alvo}` +
        `${muda ? '' : '   (sem mudanca)'}`,
    );
  }

  console.log('');
  console.log(`  vagas no mapa      : ${MAPA.size}`);
  console.log(`  linhas que mudam   : ${mudam}`);
  if (foraDoMapa.length) {
    console.log(`  vagas FORA do mapa : ${foraDoMapa.map((v) => v.id).join(', ')} (nao serao tocadas)`);
  }
  if (orfaos.length) {
    console.log(`  ids do mapa SEM vaga correspondente: ${orfaos.join(', ')}`);
  }

  if (!commit) {
    console.log('');
    console.log('DRY-RUN: nada foi gravado. Para aplicar:');
    console.log('  node src/scripts/backfill-cidade-vagas.js --commit');
    return;
  }

  // Transacao unica: ou as 10 linhas ficam consistentes, ou nenhuma muda. Um backfill pela
  // metade seria pior que nenhum — parte das vagas com praca, parte sem, e nada indicando
  // quais foram.
  const aplicar = db.getDb().transaction(() => {
    const stmt = db.getDb().prepare('UPDATE jobs SET cidade = ? WHERE id = ?');
    let n = 0;
    for (const [id, cidade] of MAPA) n += stmt.run(cidade, id).changes;
    return n;
  });
  const alteradas = aplicar();

  console.log('');
  console.log(`APLICADO: ${alteradas} linha(s) escritas.`);
  console.log('');
  for (const v of db.getDb().prepare('SELECT id, titulo, cidade FROM jobs ORDER BY id').all()) {
    console.log(`  ${String(v.id).padStart(2)} | ${String(v.cidade === null ? 'NULL' : v.cidade).padEnd(12)} | ${v.titulo}`);
  }
}

main();
