'use strict';

// Seed da campanha por WhatsApp: o template inicial e as 9 pracas.
//
// IDEMPOTENTE por construcao (INSERT OR IGNORE sobre colunas UNIQUE), e nao por dry-run:
// diferente de importar-legado.js ou corrigir-ddi-duplicado.js, aqui nao ha dado de pessoa
// nenhuma e nada a perder — rodar duas vezes tem que ser inofensivo, nao "perigoso mas
// avisado". Por isso este script nao tem `--commit`.
//
// Uso:
//   node src/scripts/seed-campanha-whatsapp.js
//
// O que ele NAO faz: nao preenche os links dos grupos. Eles nascem NULL e sao preenchidos
// pela tela /admin/campanhas-whatsapp — sao 9 URLs que so o operador conhece, e cravar
// qualquer coisa aqui seria inventar dado.

const db = require('../db');
const { CIDADES_VALIDAS } = require('../lib/cidades');

// Template inicial. O nome e a categoria tem que bater EXATAMENTE com o que estiver aprovado
// no painel da Meta — esta tabela e espelho, nao fonte da verdade.
//
// 'utility' e nao 'marketing': a mensagem confirma um cadastro que a propria pessoa fez e
// entrega o proximo passo do processo. A categoria errada aqui e motivo de rejeicao no
// review da Meta, e 'marketing' ainda cobra mais caro por conversa.
const TEMPLATE = {
  nome_meta: 'confirmacao_cadastro_vaga_vm',
  idioma: 'pt_BR',
  categoria: 'utility',
  // Variaveis POSICIONAIS ({{1}}, {{2}}, {{3}}) — a Meta nao tem variavel nomeada. Este mapa
  // e o que liga cada posicao a um campo nosso na hora de montar a chamada.
  variaveis: [
    { posicao: 1, campo: 'nome_primeiro' },
    { posicao: 2, campo: 'cargo_vaga' },
    { posicao: 3, campo: 'link_grupo_regiao' },
  ],
};

function main() {
  console.log('Seed da campanha por WhatsApp (Meta Cloud API)');
  console.log('');

  const conn = db.getDb();

  const infoTemplate = conn
    .prepare(
      `INSERT OR IGNORE INTO templates_whatsapp (nome_meta, idioma, categoria, variaveis)
       VALUES (?, ?, ?, ?)`,
    )
    .run(TEMPLATE.nome_meta, TEMPLATE.idioma, TEMPLATE.categoria, JSON.stringify(TEMPLATE.variaveis));

  console.log(
    `  template '${TEMPLATE.nome_meta}': ${infoTemplate.changes ? 'criado' : 'ja existia (nada mudou)'}`,
  );

  // Uma linha por praca do enum. A lista vem de lib/cidades para nao existir uma segunda
  // fonte de verdade sobre quais pracas existem — acrescentar uma praca la faz esta tabela
  // ganhar a linha na proxima execucao.
  const stmt = conn.prepare(
    'INSERT OR IGNORE INTO regioes_grupos_whatsapp (cidade, link_convite_grupo, ativo) VALUES (?, NULL, 1)',
  );
  const inserir = conn.transaction(() => {
    let novas = 0;
    for (const cidade of CIDADES_VALIDAS) novas += stmt.run(cidade).changes;
    return novas;
  });
  const novas = inserir();

  console.log(`  pracas: ${novas} criada(s), ${CIDADES_VALIDAS.length - novas} ja existia(m)`);
  console.log('');
  console.log('  cidade                    link do grupo');
  console.log('  ' + '-'.repeat(52));
  for (const r of conn.prepare('SELECT cidade, link_convite_grupo FROM regioes_grupos_whatsapp ORDER BY cidade').all()) {
    console.log(`  ${r.cidade.padEnd(24)}  ${r.link_convite_grupo || '(vazio — preencher no painel)'}`);
  }

  console.log('');
  console.log('PROXIMO PASSO MANUAL: preencher os links em /admin/campanhas-whatsapp.');
  console.log('Praca sem link nao recebe campanha — o job marca aquele envio como falha de');
  console.log('configuracao e segue para o proximo, sem abortar o ciclo.');
}

main();
