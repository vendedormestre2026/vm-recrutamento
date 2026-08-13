'use strict';

// Importa o historico de quem JA recebeu o convite por WhatsApp na epoca do Airtable/n8n,
// para que essas pessoas nunca mais entrem na fila de pendentes.
//
// DRY-RUN POR PADRAO. Sem `--commit`, so LE e imprime o relatorio. Mesma disciplina de
// importar-legado.js, limpeza-legado.js e backfill-cidade-vagas.js.
//
// Uso:
//   node src/scripts/importar-historico-whatsapp.js [caminho.csv]
//   node src/scripts/importar-historico-whatsapp.js [caminho.csv] --commit
//
// ── ONDE O CSV MORA, E POR QUE NAO NO GIT ──
// Default: dados-legado/historico_enviados_whatsapp.csv.
//
// A pasta `dados-legado/` INTEIRA ja esta no .gitignore (linha 43), decidida na importacao
// da base legada, e este arquivo pertence a mesma categoria: sao 1.037 telefones de pessoas
// reais. Dado pessoal nao entra em repositorio — uma vez commitado, fica no historico do
// git para sempre, em toda copia clonada, e nao ha "apagar depois" que resolva.
//
// Consequencia operacional: para rodar em producao o CSV precisa ser levado ao container
// (railway ssh + base64, como os outros scripts one-off deste projeto), e nao vem junto com
// o deploy.
//
// ── O QUE ESTE SCRIPT NAO FAZ ──
// Nao envia nada, nao calcula publico, nao decide praca. Ele so preenche o livro-razao com
// fatos passados. `cidade` fica NULL: o disparo antigo era por grupo, mas o CSV nao traz
// essa informacao e inventa-la contaminaria a auditoria de um dado que nunca existiu.

const fs = require('node:fs');
const path = require('node:path');

const db = require('../db');
const { normalizarTelefoneRecebido } = require('../lib/whatsapp');

const CSV_PADRAO = path.resolve(__dirname, '../../dados-legado/historico_enviados_whatsapp.csv');
const ORIGEM = 'historico_airtable';

// O CSV traz o telefone JA normalizado (so digitos, com DDI, sem '+'), entao a normalizacao
// usa normalizarTelefoneRecebido — a versao de FRONTEIRA. A outra prefixaria 55 de novo
// ("5547988221521" -> "555547988221521"), sem recusar, e os 1.037 registros ficariam
// impossiveis de casar com a fila. Ver a nota inteira em lib/whatsapp.
function lerArgumentos(argv) {
  const args = argv.slice(2);
  return {
    commit: args.includes('--commit'),
    caminho: path.resolve(args.find((a) => !a.startsWith('--')) || CSV_PADRAO),
  };
}

// Parser de CSV deliberadamente simples: split por linha e por virgula, com suporte a campo
// entre aspas. NAO e um parser completo de RFC 4180 — e nao precisa ser: as tres colunas
// (telefone, nome, enviado_em) sao dado curto e o arquivo foi gerado e revisado pelo proprio
// operador. Trazer uma dependencia de CSV para um script one-off seria pior negocio.
//
// O que ele TRATA, porque acontece de verdade: BOM do Excel, CRLF, aspas em nome com virgula
// ("Silva, Ana"), e linha em branco no fim do arquivo.
function parsearCsv(texto) {
  const linhas = texto
    .replace(/^﻿/, '')
    .split(/\r?\n/)
    .filter((l) => l.trim() !== '');
  if (!linhas.length) return { cabecalho: [], registros: [] };

  const partir = (linha) => {
    const campos = [];
    let atual = '';
    let entreAspas = false;
    for (let i = 0; i < linha.length; i += 1) {
      const c = linha[i];
      if (c === '"') {
        // Aspas duplas dentro de campo entre aspas representam uma aspa literal.
        if (entreAspas && linha[i + 1] === '"') { atual += '"'; i += 1; }
        else entreAspas = !entreAspas;
      } else if (c === ',' && !entreAspas) {
        campos.push(atual); atual = '';
      } else {
        atual += c;
      }
    }
    campos.push(atual);
    return campos.map((c) => c.trim());
  };

  const cabecalho = partir(linhas[0]).map((c) => c.toLowerCase());
  const registros = linhas.slice(1).map((l) => {
    const campos = partir(l);
    const obj = {};
    cabecalho.forEach((nome, i) => { obj[nome] = campos[i] === undefined ? '' : campos[i]; });
    return obj;
  });
  return { cabecalho, registros };
}

function main() {
  const { commit, caminho } = lerArgumentos(process.argv);
  console.log(`Import do historico de WhatsApp — ${commit ? 'COMMIT (vai gravar)' : 'DRY-RUN (nao grava nada)'}`);
  console.log(`Arquivo: ${caminho}`);
  console.log('');

  if (!fs.existsSync(caminho)) {
    console.error('ERRO: arquivo nao encontrado.');
    console.error('  Coloque o CSV em dados-legado/historico_enviados_whatsapp.csv');
    console.error('  (a pasta inteira esta no .gitignore — dado pessoal nao vai para o repo)');
    console.error('  ou passe o caminho como primeiro argumento.');
    process.exit(1);
  }

  const { cabecalho, registros } = parsearCsv(fs.readFileSync(caminho, 'utf8'));

  if (!cabecalho.includes('telefone')) {
    console.error(`ERRO: o CSV precisa ter a coluna "telefone". Cabecalho lido: ${cabecalho.join(', ')}`);
    process.exit(1);
  }

  // Classificacao ANTES de qualquer escrita. O relatorio do dry-run tem que ser suficiente
  // para decidir — se o operador precisar rodar o --commit para descobrir quantos telefones
  // sao invalidos, o dry-run nao serviu para nada.
  const validos = new Map(); // telefone normalizado -> { nome, enviado_em }
  const invalidos = [];
  let duplicadosNoCsv = 0;

  for (const [i, r] of registros.entries()) {
    const telefone = normalizarTelefoneRecebido(r.telefone);
    if (!telefone) {
      invalidos.push({ linha: i + 2, valor: r.telefone });
      continue;
    }
    if (validos.has(telefone)) { duplicadosNoCsv += 1; continue; }
    validos.set(telefone, {
      nome: (r.nome || '').trim() || null,
      // Sem timestamp inventado: ausente vira NULL. O CSV diz que foi enviado; nao diz
      // quando, e preencher com "agora" registraria como fato de hoje algo de meses atras.
      enviadoEm: (r.enviado_em || '').trim() || null,
    });
  }

  const jaNoBanco = db.listarTelefonesDisparados();
  const novos = [...validos.keys()].filter((t) => !jaNoBanco.has(t));
  const jaExistiam = validos.size - novos.length;

  console.log(`  linhas no CSV        : ${registros.length}`);
  console.log(`  telefones validos    : ${validos.size}`);
  console.log(`  duplicados no CSV    : ${duplicadosNoCsv} (ignorados; a chave e o telefone)`);
  console.log(`  telefones invalidos  : ${invalidos.length}`);
  console.log(`  ja no banco          : ${jaExistiam} (upsert nao duplica)`);
  console.log(`  linhas NOVAS         : ${novos.length}`);
  console.log(`  sem data de envio    : ${[...validos.values()].filter((v) => !v.enviadoEm).length} (ficam com enviado_em NULL)`);

  if (invalidos.length) {
    console.log('');
    console.log('  Telefones recusados (nao entram; corrija no CSV se algum for legitimo):');
    for (const inv of invalidos.slice(0, 15)) {
      console.log(`    linha ${String(inv.linha).padStart(5)}: ${JSON.stringify(inv.valor)}`);
    }
    if (invalidos.length > 15) console.log(`    ... e mais ${invalidos.length - 15}`);
  }

  console.log('');
  console.log('  Amostra do que sera gravado:');
  for (const [telefone, dados] of [...validos].slice(0, 5)) {
    console.log(`    ${telefone} | ${String(dados.nome || '(sem nome)').padEnd(24)} | ${dados.enviadoEm || 'NULL'}`);
  }

  if (!commit) {
    console.log('');
    console.log('DRY-RUN: nada foi gravado. Para aplicar:');
    console.log(`  node src/scripts/importar-historico-whatsapp.js ${caminho} --commit`);
    return;
  }

  // Transacao unica: 1.037 upserts ou nenhum. Um import pela metade deixaria parte do
  // historico de fora, e essas pessoas voltariam para a fila de pendentes — recebendo um
  // convite que ja receberam, que e o erro que este script existe para impedir.
  const aplicar = db.getDb().transaction(() => {
    for (const [telefone, dados] of validos) {
      db.registrarDisparoWhatsapp({
        telefone,
        nome: dados.nome,
        status: 'enviado',
        origem: ORIGEM,
        // cidade NULL de proposito: o CSV nao traz a praca, e inventa-la contaminaria a
        // auditoria de um dado que nunca existiu.
        cidade: null,
        enviadoEm: dados.enviadoEm,
      });
    }
  });
  aplicar();

  console.log('');
  console.log(`APLICADO: ${validos.size} telefone(s) no livro-razao.`);
  const total = db.getDb().prepare('SELECT COUNT(*) n FROM disparos_whatsapp').get().n;
  const porOrigem = db
    .getDb()
    .prepare("SELECT COALESCE(origem,'(sem origem)') o, status, COUNT(*) n FROM disparos_whatsapp GROUP BY 1,2 ORDER BY n DESC")
    .all();
  console.log(`  total em disparos_whatsapp: ${total}`);
  for (const r of porOrigem) console.log(`    ${String(r.o).padEnd(20)} ${String(r.status).padEnd(9)} ${r.n}`);
}

main();
