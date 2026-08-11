'use strict';

// E-mail de TESTE da Promocao de Vagas — a ferramenta de QA do proprio recrutador.
//
// ── O PROBLEMA QUE ISTO RESOLVE ──
// Ate aqui, a unica forma de ver como o e-mail de campanha fica DE VERDADE (formatacao no
// cliente real, assunto na caixa de entrada, link de descadastro clicavel) era disparar uma
// campanha. Disparar consome uma linha em campanha_envios, e o UNIQUE(campanha_id, email)
// impede reenviar para o mesmo destinatario — ou seja, "testar" custava queimar um
// destinatario real, de forma irreversivel. Este modulo abre um caminho paralelo:
//
//   NAO cria linha em campanha_envios — nao ha nada a materializar nem a "queimar";
//   NAO depende de promocao_ativa — o interruptor governa o ENVIO EM MASSA, e isto nao e
//     envio em massa: e uma mensagem para o proprio operador, disparada por ele, na hora;
//   NAO precisa de campanha criada — funciona a partir do formulario ainda nao submetido,
//     que e justamente o momento em que se quer iterar no texto;
//   PODE ser repetido — nao ha idempotencia a respeitar, so a cota do provedor (ver o
//     cooldown abaixo).
//
// ── O QUE ELE AINDA RESPEITA, e por que ──
// O PRE-VOO do disparo (verificarPreCondicoesDisparo) vale igual. O motivo nao e simetria:
// e que este envio usa o MESMO adaptador de producao, entao sem DESCADASTRO_SECRET ele
// falharia na montagem do List-Unsubscribe e sem credencial de SMTP nao sairia da maquina.
// Barrar antes, com a mensagem do pre-voo, diz o que configurar; deixar passar produziria
// uma excecao de provedor que nao ensina nada.
//
// E os CABECALHOS de descadastro entram normalmente (nada de `semDescadastro`): o link de
// opt-out e uma das coisas que o teste existe para validar. Um teste que nao carrega o
// header testaria um e-mail que nao e o que vai sair.
//
// ── DECISAO: NAO honra INTERVIEW_MOCK ──
// As varreduras (inclusive dispararPromocao) pulam o envio quando `config.entrevista.mock`
// esta ligado. Aqui NAO: o proposito unico deste caminho e produzir um e-mail de verdade
// para uma pessoa olhar. "Enviar" e nao enviar seria a pior resposta possivel — o Jean
// ficaria esperando na caixa de entrada uma mensagem que o log disse ter mandado. Quem
// protege ambiente de desenvolvimento aqui e o proprio pre-voo: sem credencial de SMTP de
// campanha configurada, nada sai e a mensagem diz exatamente isso.

const dbPadrao = require('../db');
// Fachada (./emailCampanha), nao ./emailCampanha/smtp: o transporte ativo vem de
// EMAIL_CAMPANHA_TRANSPORTE. O botao de teste precisa sair pelo MESMO caminho do disparo
// real — e o proposito dele —, entao ele nunca pode apontar para um transporte fixo.
const emailCampanhaPadrao = require('../providers/emailCampanha');
const { verificarPreCondicoesDisparo } = require('./dispararPromocao');

// Endereco fixo de destino, editavel em /admin/config. Chave NOVA no store `configuracoes`,
// e nao variavel de ambiente, pelo mesmo motivo das outras cinco chaves operacionais do
// painel: o Jean troca sem depender de redeploy. Sem default util — vazio ate ele
// configurar uma vez. Um default embutido seria pior que nenhum: qualquer endereco que
// coubesse aqui seria o endereco de outra pessoa.
const CHAVE_EMAIL_TESTE = 'email_teste_promocao';

// Marca de tempo (epoch ms) do ultimo envio de teste, para o cooldown abaixo.
//
// POR QUE NO BANCO, e nao numa variavel de modulo: uma variavel em memoria zeraria a cada
// restart do processo — e restart e barato no Railway —, o que transformaria a protecao
// numa que se contorna sem querer. No `configuracoes` ela sobrevive ao deploy, e o teste
// consegue manipula-la pelo mesmo db.definirConfig que o resto do painel usa, sem precisar
// de um export so-para-teste.
const CHAVE_ULTIMO_ENVIO = 'email_teste_promocao_ultimo_envio';

// Intervalo minimo entre dois envios de teste.
//
// NAO e protecao contra abuso (a rota esta atras do adminAuth e o unico usuario e o proprio
// recrutador): e contra o DEDO. Sem JavaScript na tela, o botao nao tem como se desabilitar
// depois do clique, e um duplo-clique — ou um F5 na pagina resultante — reenviaria. 60 s e
// tempo de sobra para o e-mail chegar e ser olhado, e curto o bastante para nao atrapalhar
// quem esta iterando no texto de verdade.
const COOLDOWN_SEGUNDOS = 60;

// Prefixo obrigatorio do assunto. Existe para o teste NUNCA ser confundido com campanha
// real na caixa de entrada — inclusive se o endereco de teste for uma caixa compartilhada,
// ou se o e-mail for encaminhado adiante meses depois.
const PREFIXO_ASSUNTO = '[TESTE] ';

// Sanidade minima de endereco. Nao e validacao de RFC (nao existe regex que valide e-mail
// de verdade) — e um filtro contra o erro de digitacao obvio, para o Jean receber "o
// endereco configurado nao parece um e-mail" em vez de um erro cru do provedor SMTP.
function enderecoParece(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(email || ''));
}

// Endereco configurado, ja aparado. String vazia quando a chave nunca foi preenchida — e o
// estado inicial esperado, nao um erro.
function enderecoTeste(deps = {}) {
  const db = deps.db || dbPadrao;
  return String(db.obterConfig(CHAVE_EMAIL_TESTE, '') || '').trim();
}

// Quantos segundos ainda faltam para o proximo envio de teste ser permitido. 0 = liberado.
// `agora` e injetavel para o teste nao precisar dormir 60 s.
function segundosRestantesCooldown(deps = {}, agora = Date.now()) {
  const db = deps.db || dbPadrao;
  const ultimo = Number(db.obterConfig(CHAVE_ULTIMO_ENVIO, '0'));
  // Valor ausente, vazio ou corrompido = "nunca enviou". Falhar para o lado do permitido e
  // seguro aqui: o pior caso e um e-mail a mais para o proprio operador.
  if (!Number.isFinite(ultimo) || ultimo <= 0) return 0;

  const decorridos = Math.floor((agora - ultimo) / 1000);
  // Relogio para tras (ajuste de NTP, restore de banco) daria `decorridos` negativo e
  // prenderia o botao por muito tempo. Nesse caso, libera.
  if (decorridos < 0) return 0;
  return decorridos >= COOLDOWN_SEGUNDOS ? 0 : COOLDOWN_SEGUNDOS - decorridos;
}

// Envia UM e-mail de teste com o conteudo que esta no formulario agora.
//
// Resultado DISCRIMINADO, nunca lanca (mesmo contrato de gerarSugestaoConteudo e
// enfileirarCampanha): quem chama e uma rota de painel, que precisa transformar isto em
// mensagem na tela e nao em 500.
//   { ok: true,  destinatario, assunto }
//   { ok: false, erroCodigo: 'SEM_DESTINATARIO' | 'DESTINATARIO_INVALIDO' | 'SEM_CONTEUDO'
//                          | 'PRE_VOO' | 'COOLDOWN' | 'ENVIO_FALHOU', mensagem }
//
// ORDEM DAS CHECAGENS, que nao e arbitraria: primeiro o que o Jean resolve sozinho e de
// graca (destinatario, conteudo), depois o que depende do servidor (pre-voo), e o cooldown
// por ULTIMO entre as validacoes — recusar por cooldown um envio que ia falhar de qualquer
// jeito esconderia o problema real atras de "espere 47 s".
async function enviarEmailTeste({ assunto, corpoHtml } = {}, deps = {}) {
  const db = deps.db || dbPadrao;
  const emailCampanha = deps.emailCampanha || emailCampanhaPadrao;
  const agora = deps.agora || Date.now();

  const destinatario = enderecoTeste(deps);
  if (!destinatario) {
    return {
      ok: false,
      erroCodigo: 'SEM_DESTINATARIO',
      mensagem:
        'Nenhum e-mail de teste configurado. Defina o endereço em Configurações gerais ' +
        '(/admin/config) — é para lá que o e-mail de teste sempre vai.',
    };
  }
  if (!enderecoParece(destinatario)) {
    return {
      ok: false,
      erroCodigo: 'DESTINATARIO_INVALIDO',
      mensagem:
        `O e-mail de teste configurado ("${destinatario}") não parece um endereço válido. ` +
        'Corrija em Configurações gerais (/admin/config).',
    };
  }

  const assuntoLimpo = String(assunto || '').trim();
  const corpoLimpo = String(corpoHtml || '').trim();
  if (!assuntoLimpo || !corpoLimpo) {
    return {
      ok: false,
      erroCodigo: 'SEM_CONTEUDO',
      mensagem:
        'Preencha o assunto e o corpo do e-mail antes de enviar o teste — é justamente ' +
        'esse conteúdo que o teste mostra na caixa de entrada.',
    };
  }

  // MESMA checagem do disparo real, pela MESMA funcao. Nao ha copia local: se um dia o
  // pre-voo ganhar um item novo, ele vale para o teste no mesmo commit.
  const preVoo = verificarPreCondicoesDisparo();
  if (!preVoo.ok) {
    return { ok: false, erroCodigo: 'PRE_VOO', mensagem: preVoo.mensagem, pendencias: preVoo.pendencias };
  }

  const restam = segundosRestantesCooldown(deps, agora);
  if (restam > 0) {
    return {
      ok: false,
      erroCodigo: 'COOLDOWN',
      segundosRestantes: restam,
      mensagem:
        `Um e-mail de teste acabou de ser enviado. Aguarde ${restam} s antes de enviar ` +
        'outro — o intervalo existe para um clique repetido não consumir a cota do provedor.',
    };
  }

  // Marca ANTES de enviar, de proposito. O cooldown protege a COTA do provedor, e a cota e
  // consumida pela tentativa, nao pelo sucesso: uma falha depois do provedor ter aceitado a
  // conexao ja custou. Marcar depois deixaria o caminho de erro sem nenhuma trava — que e
  // exatamente o caminho em que a pessoa clica de novo, e de novo.
  try {
    db.definirConfig(CHAVE_ULTIMO_ENVIO, String(agora));
  } catch (err) {
    // Nao aborta o envio: falhar em gravar a marca de tempo e problema de observabilidade
    // do cooldown, nao motivo para negar ao Jean o e-mail que ele pediu.
    console.error(`[promocao/teste] falha ao registrar o cooldown: ${err.message}`);
  }

  try {
    // TRES argumentos, como a varredura de producao: sem `opcoes`, os cabecalhos
    // List-Unsubscribe e List-Unsubscribe-Post entram sozinhos dentro do adaptador
    // (Incremento 3). Passar `semDescadastro` aqui esvaziaria o teste de sentido — o link
    // de descadastro e uma das coisas que ele existe para validar.
    await emailCampanha.enviar(destinatario, PREFIXO_ASSUNTO + assuntoLimpo, corpoLimpo);
  } catch (err) {
    console.error(`[promocao/teste] falha ao enviar e-mail de teste: ${err.message}`);
    return {
      ok: false,
      erroCodigo: 'ENVIO_FALHOU',
      mensagem:
        `Não foi possível enviar o e-mail de teste: ${err.message} ` +
        'Nada foi criado nem alterado nas campanhas.',
    };
  }

  console.log(`[promocao/teste] e-mail de teste enviado para ${destinatario}.`);
  return { ok: true, destinatario, assunto: PREFIXO_ASSUNTO + assuntoLimpo };
}

module.exports = {
  enviarEmailTeste,
  enderecoTeste,
  segundosRestantesCooldown,
  CHAVE_EMAIL_TESTE,
  CHAVE_ULTIMO_ENVIO,
  COOLDOWN_SEGUNDOS,
  PREFIXO_ASSUNTO,
};
