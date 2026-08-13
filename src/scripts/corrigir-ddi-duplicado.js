'use strict';

// Corrige `applications.telefone` com DDI 55 DUPLICADO ("+55 +5547988301250").
//
// SOMENTE DRY-RUN NESTA VERSAO. Nao existe `--commit` de proposito: a escrita e em telefone
// de candidato real, e a revisao linha a linha vem antes. O caminho de gravacao entra depois
// da aprovacao, e nao antes — um `--commit` "so por precaucao" e um `--commit` que alguem
// roda por engano.
//
// Uso:
//   node src/scripts/corrigir-ddi-duplicado.js
//
// ── DE ONDE VEM O PROBLEMA ──
// O seletor de DDI do formulario publico prefixa "+55 " e a pessoa digita o numero ja com
// +55. O resultado fica no banco como "+55 +5547988301250" — 15 digitos.
//
// Isso passou despercebido ate o primeiro disparo real por WhatsApp: normalizarTelefoneWhatsapp
// aceita (15 cabe no teto [10,15]) mas normalizarTelefoneRecebido rejeita na volta (nao
// reconhece o padrao, re-prefixa, chega a 17). A API entregava o numero e depois recusava
// registra-lo, travando o disparo.
//
// ── O CRITERIO E O MESMO DO RELATORIO, NAO UMA HEURISTICA NOVA ──
// Padrao BRUTO "+55 +55" seguido de digitos, cruzado com a invariante de ida e volta. Os dois
// tem que concordar: se o padrao pegasse alguem que ja esta saudavel, ou se a invariante
// reprovasse uma correcao, e sinal de que a regra esta errada — e o relatorio mostra isso em
// vez de esconder.

const db = require('../db');
const { normalizarTelefoneWhatsapp, normalizarTelefoneRecebido } = require('../lib/whatsapp');

// ── IDS EXCLUIDOS POR DECISAO HUMANA ──
//
// Quatro registros tem um digito a mais alem do DDI duplicado, e nao ha correcao mecanica:
//   165  "+55 119972122344"      12 digitos apos o DDI (um a mais)
//   210  "+55 119836100077"      idem
//   513  "+55 (19) 9999354073"   10 apos o DDD (um a mais)
//   336  "+55 +551998115119"     DDI duplicado E curto
//
// O 336 e o mais perigoso da lista, e a razao de esta exclusao ser por ID e nao por regra:
// ele CASA com o padrao "+55 +55" e, depois de corrigido mecanicamente, PASSARIA na
// invariante de ida e volta — viraria "+55 1998115119", um numero de 10 digitos apos o DDI,
// bem-formado e de outra pessoa. A validacao automatica nao tem como perceber; so quem olha
// percebe. Por isso a lista e explicita.
//
// Chutar qual digito sobra produz o telefone de um terceiro. Nao se adivinha.
const IDS_EXCLUIDOS = new Set([165, 210, 513, 336]);

// Remove UMA ocorrencia do 55 duplicado e devolve no formato do formulario ("+55 NNNNNNNNNNN").
//
// Trabalha sobre os DIGITOS, e nao sobre a string bruta: os brutos variam em mascara
// ("+55 +5547988301250", "+55 +55 (13) 99701-9786", "+55 ‪+55 19 97124‑4233‬" com caracteres
// invisiveis de direcao de texto). Qualquer regex sobre a forma escrita erraria alguns.
//
// Devolve null quando o valor nao tem a cara esperada — o chamador reporta em vez de aplicar.
function corrigir(bruto) {
  const digitos = String(bruto || '').replace(/\D/g, '');
  if (!/^5555\d+$/.test(digitos)) return null;
  const semDuplicata = digitos.slice(2); // derruba UM "55"
  return `+55 ${semDuplicata.slice(2)}`; // "+55 " + (DDD + numero)
}

function main() {
  console.log('Correcao de DDI duplicado em applications.telefone — DRY-RUN');
  console.log('(este script NAO grava; nao existe --commit nesta versao)');
  console.log('');

  // Padrao BRUTO, o mesmo do relatorio. LIKE com o literal '+55 +55' — sem regex, para o
  // criterio ser legivel direto no SQL.
  const candidatos = db
    .getDb()
    .prepare(
      `SELECT id, nome, telefone FROM applications
        WHERE telefone LIKE '+55 +55%'
        ORDER BY id`,
    )
    .all();

  const aplicaveis = [];
  const excluidosPorDecisao = [];
  const reprovados = [];

  for (const r of candidatos) {
    if (IDS_EXCLUIDOS.has(r.id)) {
      excluidosPorDecisao.push(r);
      continue;
    }
    const corrigido = corrigir(r.telefone);
    // A INVARIANTE: o valor corrigido, normalizado, tem que sobreviver a volta pela fronteira
    // da API — que e exatamente o que o motor de publico passou a exigir.
    const normalizado = corrigido ? normalizarTelefoneWhatsapp(corrigido) : null;
    const idaEVolta = Boolean(normalizado) && normalizarTelefoneRecebido(normalizado) === normalizado;
    (idaEVolta ? aplicaveis : reprovados).push({ ...r, corrigido, normalizado, idaEVolta });
  }

  const larguraNome = Math.max(4, ...aplicaveis.map((r) => String(r.nome || '').length));
  console.log('═'.repeat(118));
  console.log(
    '  id'.padEnd(6) +
      '| ' + 'nome'.padEnd(larguraNome) +
      ' | ' + 'telefone atual'.padEnd(24) +
      ' | ' + 'corrigido proposto'.padEnd(20) +
      ' | ida-e-volta',
  );
  console.log('═'.repeat(118));
  for (const r of aplicaveis) {
    console.log(
      `  ${String(r.id).padStart(3)} ` +
        `| ${String(r.nome || '').padEnd(larguraNome)} ` +
        `| ${String(r.telefone).padEnd(24)} ` +
        `| ${String(r.corrigido).padEnd(20)} ` +
        `| ${r.idaEVolta ? 'OK' : 'FALHOU'}`,
    );
  }
  console.log('═'.repeat(118));
  console.log('');
  console.log(`  casaram com o padrao "+55 +55" : ${candidatos.length}`);
  console.log(`  excluidos por decisao humana   : ${excluidosPorDecisao.length} ${excluidosPorDecisao.length ? `(ids ${excluidosPorDecisao.map((r) => r.id).join(', ')})` : ''}`);
  console.log(`  APLICAVEIS (passam ida-e-volta): ${aplicaveis.length}`);
  console.log(`  reprovados na validacao        : ${reprovados.length}`);

  if (reprovados.length) {
    console.log('');
    console.log('  ── REPROVADOS: nao aplicar, revisar a mao ──');
    for (const r of reprovados) {
      console.log(`    id ${r.id} | ${r.nome} | ${r.telefone} -> ${r.corrigido || '(sem correcao mecanica)'}`);
    }
  }

  // Verificacao cruzada: os aplicaveis precisam ser exatamente os que HOJE estao quebrados.
  // Se o padrao bruto e a invariante discordarem, a regra esta errada — e melhor descobrir
  // aqui do que depois de gravar.
  const quebradosHoje = db
    .getDb()
    .prepare('SELECT id, telefone FROM applications WHERE telefone IS NOT NULL')
    .all()
    .filter((r) => {
      const n = normalizarTelefoneWhatsapp(r.telefone);
      return n && normalizarTelefoneRecebido(n) !== n;
    });
  const idsAplicaveis = new Set(aplicaveis.map((r) => r.id));
  const quebradosForaDaCorrecao = quebradosHoje.filter((r) => !idsAplicaveis.has(r.id));

  console.log('');
  console.log('  ── conferencia cruzada ──');
  console.log(`  registros HOJE quebrados (falham ida-e-volta) : ${quebradosHoje.length}`);
  console.log(`  destes, cobertos por esta correcao            : ${quebradosHoje.length - quebradosForaDaCorrecao.length}`);
  console.log(`  destes, que CONTINUARAO quebrados            : ${quebradosForaDaCorrecao.length} ${quebradosForaDaCorrecao.length ? `(ids ${quebradosForaDaCorrecao.map((r) => r.id).join(', ')})` : ''}`);

  console.log('');
  console.log('DRY-RUN: nada foi gravado. O caminho de escrita nao existe neste script.');
}

main();
