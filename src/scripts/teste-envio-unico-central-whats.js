'use strict';

// Envio ÚNICO e MANUAL de template pelo transporte do Central Whats.
//
// NAO faz parte de nenhum fluxo do produto, e nao deve ser chamado por nada.
//
// ── ELE NASCEU PARA O APP REVIEW, QUE ACABOU ──
// A versao original existia para satisfazer o "verifique se voce fez as ligacoes de teste de
// API exigidas" do App Review da Meta, que foi abandonado junto com a ideia de ter App
// proprio. O script sobreviveu porque a funcao mudou, nao sumiu: agora ele e o jeito de
// provar que o caminho novo — Recrutador -> Central Whats -> Meta -> aparelho — funciona de
// ponta a ponta, sem envolver campanha nenhuma.
//
// ── POR QUE ELE E MELHOR QUE "rodar uma campanha de teste com 1 destinatario" ──
// Aquele caminho exige tres coisas perigosas ao mesmo tempo: materializar um publico, ligar o
// interruptor da campanha e por META_CAMPANHA_MOCK=false NO SERVICO. A terceira e a pior — o
// processo do site reinicia com o mock desligado, e a partir dali a campanha inteira fica a
// UM clique de sair de verdade. Aqui o mock e desligado dentro de um processo efemero, que
// morre em seguida, e para um unico numero.
//
// ── POR QUE UM SCRIPT ISOLADO, E NAO "rodar a campanha com 1 destinatario" ──
// Porque a campanha tem um motor de publico (publicoCampanhaWhatsapp) que resolve QUEM
// recebe a partir do banco. Qualquer erro de parametro ali — uma cidade, um tipo de
// mensagem, um filtro invertido — nao produz "0 destinatarios", produz MILHARES. Este
// script nao consulta o banco, nao materializa nada em campanha_whatsapp_envios e nao
// conhece o conceito de campanha: o unico destinatario possivel e o numero que a pessoa
// digitou na variavel de ambiente, e nao ha caminho de codigo que transforme isso em lista.
//
// ── ELE NAO ABRE O BANCO ──
// Nenhum require daqui chama db.getDb(), que e lazy (db/sqlite.js:24): a conexao so nasce
// na primeira funcao de dados chamada, e nao chamamos nenhuma. Rodar isto nao cria arquivo,
// nao migra e nao le uma linha sequer.
//
// ── DUAS TRAVAS ──
//   TESTE_TELEFONE_DESTINO   obrigatoria. Sem ela o script recusa e sai.
//   CONFIRMAR_ENVIO_REAL     ausente = DRY-RUN: imprime o payload e encerra sem tocar a rede.
//                            =true    = envia de verdade. UMA mensagem, UM numero.
//
// Uso:
//   TESTE_TELEFONE_DESTINO='+5547999999999' node src/scripts/teste-envio-unico-central-whats.js
//   TESTE_TELEFONE_DESTINO='+5547999999999' CONFIRMAR_ENVIO_REAL=true \
//     node src/scripts/teste-envio-unico-central-whats.js

const transporte = require('../providers/centralWhats/centralWhats');
const { mascarar } = require('../whatsapp/sequenciaOutbox');
const { normalizarTelefoneRecebido } = require('../lib/whatsapp');

// Espelha o template semeado por seed-campanha-whatsapp.js (registro id=1 em producao).
// Os nomes tem que bater EXATAMENTE com o aprovado no painel da Meta.
//
// ⚠️ ESPELHO A MAO, E NAO LEITURA DO BANCO. O valor de `botao_parametro_fixo` esta repetido
// aqui, e nao lido de templates_whatsapp, porque este script nao abre o banco de proposito
// (ver o cabecalho). A LOGICA do botao nao esta duplicada — quem monta o payload e
// centralWhats.montarPayload, o mesmo caminho da campanha; o que se repete e so o valor.
// Se o valor mudar no banco, mude aqui tambem.
const TEMPLATE = {
  nome_meta: 'confirmacao_cadastro_vaga_vm',
  // Botao estrutural exigido pela Meta (erro 131008 sem ele) — a exigencia continua valendo
  // com o Central Whats no meio, so mudou a forma: agora sai como a chave "button0" de vars.
  // Nao tem funcao: a URL base cadastrada na Meta esta errada e nao pode mais ser editada. O
  // link real vai na variavel 3.
  botao_parametro_fixo: 'indisponivel',
};
// `idioma` NAO entra aqui: o Central Whats resolve o idioma pelo template sincronizado do
// lado dele, e montarPayload nem le esse campo.

// Variaveis POSICIONAIS, na ordem {{1}} {{2}} {{3}} do template semeado:
//   1 nome_primeiro   2 cargo_vaga   3 link_grupo_regiao
//
// ⚠️ O LINK ABAIXO E FICTICIO. Ele NAO leva a grupo nenhum e nao deve ser usado em
// mensagem real. Existe so para o template ter o formato que a Meta espera na posicao 3 —
// os links de verdade sao os de regioes_grupos_whatsapp, preenchidos no painel, e cravar um
// deles aqui faria um teste tecnico convidar alguem para um grupo de verdade.
const VARIAVEIS = [
  'Teste',
  'SDR (mensagem de teste técnico)',
  'https://chat.whatsapp.com/LINK-DE-TESTE-FICTICIO',
];

function abortar(mensagem) {
  console.error('');
  console.error(`  ❌ ${mensagem}`);
  console.error('');
  process.exit(1);
}

async function main() {
  console.log('');
  console.log('Envio único de teste — transporte Central Whats');
  console.log('─'.repeat(60));

  // ── TRAVA 1: destinatario ──
  // Sem default e sem fallback para numero nenhum do banco. Um default aqui seria um numero
  // real de alguem recebendo mensagem de teste.
  const bruto = String(process.env.TESTE_TELEFONE_DESTINO || '').trim();
  if (!bruto) {
    abortar(
      'TESTE_TELEFONE_DESTINO ausente. Informe o número de destino, com DDI:\n' +
        "     TESTE_TELEFONE_DESTINO='+5547999999999' node src/scripts/teste-envio-unico-central-whats.js",
    );
  }

  // Mesma normalizacao de fronteira do resto do sistema: aceita com ou sem '+', com ou sem
  // DDI. E a funcao que evita o bug de DDI duplicado que ja custou um disparo travado.
  const telefone = normalizarTelefoneRecebido(bruto);
  if (!telefone) {
    abortar(`TESTE_TELEFONE_DESTINO='${bruto}' não sobreviveu à normalização. Use o formato +55DDNNNNNNNNN.`);
  }

  const payload = transporte.montarPayload({ telefone, template: TEMPLATE, variaveis: VARIAVEIS });

  // Copia com o destinatario mascarado para impressao. O payload REAL, com o numero
  // completo, e o que vai para o Central Whats — nunca para o stdout, que no Railway e lido por mais
  // gente que o banco.
  const paraMostrar = { ...payload, to: mascarar(telefone) };

  console.log('');
  console.log('  destino (mascarado): ', mascarar(telefone));
  console.log('  entrada original:    ', bruto);
  console.log('  normalizado para:    ', `${telefone.length} dígitos`);
  console.log('  template:            ', `${TEMPLATE.nome_meta} (idioma resolvido no Central Whats)`);
  console.log('  variáveis posicionais:');
  VARIAVEIS.forEach((v, i) => console.log(`    {{${i + 1}}} = ${v}`));
  console.log('');
  console.log('  payload que seria enviado:');
  console.log(
    JSON.stringify(paraMostrar, null, 2)
      .split('\n')
      .map((l) => `    ${l}`)
      .join('\n'),
  );

  const faltando = transporte.credenciaisFaltando();
  console.log('');
  console.log(
    '  credenciais: ',
    faltando.length ? `❌ AUSENTES — ${faltando.join(', ')}` : '✅ CENTRALWHATS_BASE_URL, CENTRALWHATS_INSTANCE_ID e CENTRALWHATS_API_KEY presentes',
  );

  // ── TRAVA 2: confirmacao explicita ──
  if (String(process.env.CONFIRMAR_ENVIO_REAL || '').toLowerCase() !== 'true') {
    console.log('');
    console.log('─'.repeat(60));
    console.log('  DRY-RUN. Nada foi enviado e nenhuma chamada de rede foi feita.');
    console.log('');
    console.log('  Para enviar DE VERDADE, repita o comando acrescentando:');
    console.log('     CONFIRMAR_ENVIO_REAL=true');
    console.log('');
    return;
  }

  if (faltando.length) {
    abortar(`Credenciais ausentes (${faltando.join(', ')}). Nada foi enviado.`);
  }

  // ── MOCK DESLIGADO APENAS NESTE PROCESSO ──
  // enviarTemplate consulta META_CAMPANHA_MOCK a cada chamada (centralWhats.js), e o
  // default e mock ligado. Sobrescrever aqui vale so para este processo, que morre em
  // seguida: NAO altera a variavel no Railway nem no .env, e NAO reinicia o serviço.
  //
  // E deliberadamente melhor que desligar o mock no painel: la, o processo do site
  // reiniciaria com o mock off, e o job de campanha passaria a estar a UM kill-switch de
  // enviar de verdade. Aqui o alcance e um processo efemero e um unico destinatario.
  process.env.META_CAMPANHA_MOCK = 'false';

  console.log('');
  console.log('─'.repeat(60));
  console.log('  ENVIO REAL confirmado. Chamando o Central Whats...');

  const inicio = Date.now();
  try {
    const { wamid, mock } = await transporte.enviarTemplate({ telefone, template: TEMPLATE, variaveis: VARIAVEIS });
    const ms = Date.now() - inicio;

    if (mock) {
      // Nao deveria acontecer — mas se acontecer, dizer em voz alta e melhor que reportar
      // sucesso de um envio que nao saiu e ficar esperando uma mensagem que nunca chega.
      abortar(`Retornou em MODO MOCK (wamid=${wamid}). NADA foi enviado.`);
    }

    console.log('');
    console.log(`  ✅ ACEITO pelo Central Whats em ${ms} ms`);
    console.log(`     wamid: ${wamid || '(não veio no corpo da resposta)'}`);
    console.log('');
    console.log('  Aceito NAO é entregue: o Central Whats aceitou e repassou à Meta. Confira o');
    console.log('  WhatsApp do número de destino — e, se não chegar, o Live Chat do Central Whats,');
    console.log('  que é onde o status de entrega existe (aqui não há webhook).');
    console.log('');
  } catch (err) {
    const classe = transporte.classificarErroCentralWhats(err);
    console.error('');
    console.error(`  ❌ FALHOU após ${Date.now() - inicio} ms`);
    console.error(`     erro:      ${err.message}`);
    console.error(`     categoria: ${classe.categoria} — ${classe.motivo}`);
    console.error('');
    if (classe.categoria === 'terminal') {
      console.error("     Prováveis causas: o template 'confirmacao_cadastro_vaga_vm' não está");
      console.error('     sincronizado no Central Whats, ou o formato de `vars` não bate com o');
      console.error('     que ele espera. Aprovação na Meta é pré-requisito, mas não basta:');
      console.error('     o template precisa existir do lado do Central Whats também.');
      console.error('');
    }
    if (classe.categoria === 'configuracao') {
      console.error('     Prováveis causas: CENTRALWHATS_API_KEY inválida/revogada, ou');
      console.error('     CENTRALWHATS_INSTANCE_ID apontando para instância que não existe.');
      console.error('');
    }
    process.exit(1);
  }
}

main();
