'use strict';

// Importacao da base legada (Supabase, tabela `aplicacao`) para o Banco de Talentos.
//
// DRY-RUN POR PADRAO. Sem `--commit`, o script so LE: abre o CSV, normaliza, deduplica,
// consulta os e-mails ja existentes e imprime o relatorio. Nao grava uma linha sequer.
// Isso e proposital e nao e cerimonia: a importacao roda UMA vez, sobre um arquivo que nao
// volta, e a unica forma de conferir as regras e ver os numeros antes.
//
// Uso:
//   node src/scripts/importar-legado.js                 # dry-run (nao grava nada)
//   node src/scripts/importar-legado.js --commit        # grava, em transacao unica
//   node src/scripts/importar-legado.js --csv <caminho> # outro arquivo de origem
//
// ONDE RODAR: no container (railway ssh) para importar em producao — a gravacao vai para o
// banco apontado por DATABASE_PATH, e local isso e o ./data/app.db de desenvolvimento.
//
// ── IDEMPOTENCIA, em duas camadas ──
// O script exclui do lote quem ja existe em `talentos` (eixo 2 do relatorio), e
// db.criarTalentosLegado repete a verificacao DENTRO da transacao. Rodar `--commit` duas
// vezes insere zero na segunda. As duas camadas existem porque `talentos.email` NAO tem
// UNIQUE: se as duas falharem, nada no banco impede 7 mil linhas duplicadas.

const fs = require('node:fs');
const path = require('node:path');

const { config } = require('../config');
const db = require('../db');
const {
  linhasComoObjetos,
  prepararImportacao,
  CATEGORIA_LEGADO,
} = require('../lib/importarLegado');

const CSV_PADRAO = path.join(__dirname, '..', '..', 'dados-legado', 'aplicacao_rows.csv');

function lerArgumentos(argv) {
  const args = argv.slice(2);
  const iCsv = args.indexOf('--csv');
  return {
    commit: args.includes('--commit'),
    csv: iCsv !== -1 && args[iCsv + 1] ? args[iCsv + 1] : CSV_PADRAO,
  };
}

// E-mails ja existentes nas duas bases. Devolvidos CRUS: quem normaliza e compara e o
// modulo de importacao, com a mesma lib/normalizarEmail que o resto do projeto usa —
// nenhuma das duas tabelas guarda o e-mail normalizado (ver criarTalento/criarAplicacao).
function emailsExistentes() {
  const banco = db.getDb();
  const talentos = banco
    .prepare("SELECT email FROM talentos WHERE email IS NOT NULL AND TRIM(email) <> ''")
    .all()
    .map((l) => l.email);
  // Sem filtro por deleted_at: uma candidatura arquivada continua sendo uma pessoa que ja
  // esta na base, e o que este numero descreve e sobreposicao de bases, nao elegibilidade.
  const applications = banco
    .prepare("SELECT email FROM applications WHERE email IS NOT NULL AND TRIM(email) <> ''")
    .all()
    .map((l) => l.email);
  return { talentos, applications };
}

// Tabela simples ordenada por quantidade, para as contagens por cargo/valor bruto.
function imprimirContagem(mapa, { indent = '  ' } = {}) {
  const linhas = [...mapa].sort((a, b) => b[1] - a[1]);
  const largura = Math.max(0, ...linhas.map(([chave]) => String(chave).length));
  for (const [chave, qtd] of linhas) {
    console.log(`${indent}${String(chave).padEnd(largura)}  ${String(qtd).padStart(6)}`);
  }
}

function main() {
  const { commit, csv } = lerArgumentos(process.argv);

  if (!fs.existsSync(csv)) {
    console.error(`[importar-legado] CSV nao encontrado: ${csv}`);
    process.exit(1);
  }

  const { cabecalho, registros: linhas } = linhasComoObjetos(fs.readFileSync(csv, 'utf8'));

  // O modulo procura as colunas por NOME. Um export com cabecalho diferente produziria
  // silenciosamente 10 mil linhas sem e-mail e sem cargo — melhor falhar aqui, dizendo qual
  // coluna falta, do que entregar um relatorio de zeros que parece um arquivo vazio.
  const OBRIGATORIAS = ['created_at', 'fullname', 'email', 'whatsapp', 'cargo'];
  const faltando = OBRIGATORIAS.filter((c) => !cabecalho.includes(c));
  if (faltando.length) {
    console.error(`[importar-legado] colunas ausentes no CSV: ${faltando.join(', ')}`);
    console.error(`[importar-legado] cabecalho lido: ${cabecalho.join(', ')}`);
    process.exit(1);
  }

  const { talentos, applications } = emailsExistentes();
  const { registros, relatorio } = prepararImportacao({
    linhas,
    emailsTalentos: talentos,
    emailsApplications: applications,
  });

  const modo = commit ? 'COMMIT (vai gravar)' : 'DRY-RUN (nao grava nada)';
  console.log('════════ importacao da base legada — ' + modo + ' ════════');
  console.log(`csv         : ${csv}`);
  console.log(`banco       : ${config.caminhoBanco}`);
  console.log(`categoria   : ${CATEGORIA_LEGADO}`);
  console.log(`base atual  : ${talentos.length} talento(s), ${applications.length} candidatura(s)`);
  console.log('');

  console.log('── Leitura ──');
  console.log(`linhas no CSV                      ${String(relatorio.linhasLidas).padStart(6)}`);
  console.log('');

  console.log('── Descartes antes do dedupe ──');
  const totalExcluidos = [...relatorio.excluidosPorCargo.values()].reduce((a, b) => a + b, 0);
  console.log(`cargo excluido por decisao         ${String(totalExcluidos).padStart(6)}`);
  imprimirContagem(relatorio.excluidosPorCargo, { indent: '    ' });
  console.log(`sem e-mail                         ${String(relatorio.semEmail).padStart(6)}`);
  console.log(`data de criacao ilegivel           ${String(relatorio.semData).padStart(6)}`);
  console.log('');

  console.log('── Colisoes (os tres eixos) ──');
  console.log(`1. duplicata interna ao export     ${String(relatorio.duplicataInterna).padStart(6)}   (descartada: fica a mais recente)`);
  console.log(`2. ja existe em talentos           ${String(relatorio.colisaoTalentos).padStart(6)}   (DESCARTADA: seria linha duplicada)`);
  console.log(`3. ja existe em applications       ${String(relatorio.colisaoApplications).padStart(6)}   (mantida: tabelas e finalidades distintas)`);
  console.log('');

  console.log('── A importar, por cargo ──');
  imprimirContagem(relatorio.porCargo);
  console.log('');
  console.log(`com perfil_interesse (SDR/CLOSER)  ${String(relatorio.comPerfil).padStart(6)}`);
  console.log(`sem perfil_interesse (NULL)        ${String(relatorio.semPerfil).padStart(6)}`);
  console.log('');

  console.log('── Telefone ──');
  console.log(`sem telefone aproveitavel (NULL)   ${String(relatorio.telefoneAnomalo).padStart(6)}`);
  console.log('');

  // ── O alerta que pode parar tudo ──
  // Cargo nao mapeado nao e excluido nem importado: e uma pergunta em aberto. Importar com
  // um mapeamento inventado seria pior que nao importar, e descartar em silencio esconderia
  // gente que deveria entrar.
  if (relatorio.naoMapeados.size) {
    const total = [...relatorio.naoMapeados.values()].reduce((a, b) => a + b, 0);
    console.log('⚠️  CARGOS NAO MAPEADOS — precisam de decisao humana ──');
    console.log(`${total} registro(s) NAO foram importados nem excluidos:`);
    imprimirContagem(relatorio.naoMapeados, { indent: '    ' });
    console.log('');
    console.log('Adicione cada um ao DICIONARIO_CARGO em src/lib/importarLegado.js');
    console.log('(ou marque como CARGO_EXCLUIR) e rode de novo.');
    console.log('');
  } else {
    console.log('cargos nao mapeados                     0   (todos os valores do CSV sao conhecidos)');
    console.log('');
  }

  console.log('─────────────────────────────────────────────────────────');
  console.log(`SERIAM INSERIDAS: ${relatorio.aInserir} linha(s) em talentos.`);

  if (!commit) {
    console.log('');
    console.log('Nada foi gravado (dry-run). Para gravar de verdade:');
    console.log('  node src/scripts/importar-legado.js --commit');
    console.log('═════════════════════════════════════════════════════════');
    return;
  }

  // Barreira final: com cargo nao mapeado em aberto, `--commit` nao passa. O operador
  // decide o mapeamento e roda de novo — a importacao roda uma vez e nao ha desfazer barato.
  if (relatorio.naoMapeados.size) {
    console.error('');
    console.error('[importar-legado] ABORTADO: ha cargos nao mapeados (acima).');
    console.error('[importar-legado] Resolva o dicionario antes de gravar. Nada foi gravado.');
    process.exit(1);
  }

  const resultado = db.criarTalentosLegado(registros);
  console.log('');
  console.log(`GRAVADO: ${resultado.inseridos} inserida(s), ${resultado.ignorados} ignorada(s).`);
  if (resultado.ignorados) {
    console.log('(ignoradas = ja existiam em talentos; o script e idempotente por e-mail.)');
  }
  console.log('═════════════════════════════════════════════════════════');
}

main();
