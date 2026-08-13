'use strict';

// Classificacao de falha de envio de campanha.
//
// ── POR QUE ISTO EXISTE ──
// Ate aqui, TODA falha de envio era terminal: a linha virava 'falha', saia da fila e nunca
// mais era tentada. A apuracao das 2.945 linhas travadas mostrou o custo dessa
// simplificacao — nenhuma delas era do destinatario:
//
//   2.793  HTTP 429 do Emailit  (teto de 2 msg/s estourado pela rajada do ciclo)
//     152  HTTP 403 do ZeptoMail (limite diario de conta trial)
//       0  bounce, endereco invalido, recusa de endereco
//
// Cem por cento transitorio, cem por cento tratado como definitivo. O pacing
// (ENVIO_INTERVALO_MS) ataca a CAUSA; isto ataca a CONSEQUENCIA — porque nenhum pacing
// impede um limite diario, uma instabilidade do provedor ou um 500 pontual.
//
// ── AS QUATRO CATEGORIAS ──
//   'configuracao'     o ambiente esta quebrado. NAO e falha deste destinatario e nao seria
//                      diferente com nenhum outro. Aborta o ciclo inteiro, sem marcar
//                      ninguem e sem contar tentativa de ninguem.
//   'retentavel_alto'  limite de vazao/cota do provedor. Teto alto: o problema resolve
//                      sozinho com o tempo (a janela vira, a cota reseta) e desistir cedo
//                      seria repetir o erro que custou as 2.945.
//   'retentavel'       transitorio generico (5xx, rede). Teto baixo: se um erro sem nome
//                      persiste por 5 ciclos, insistir nao e teimosia util.
//   'terminal'         o destinatario nao existe ou foi recusado por ser quem e. Retentar
//                      produz bounce, e bounce repetido queima reputacao de dominio — o
//                      unico caso em que NAO retentar e a decisao certa.
//
// ── O DEFAULT E RETENTAVEL, NAO TERMINAL ──
// Erro desconhecido cai em 'retentavel' (teto 5). E uma inversao deliberada do padrao
// anterior, e a assimetria de custo justifica:
//   desconhecido tratado como terminal   -> a pessoa e perdida para sempre, sem caminho de
//                                           volta pela aplicacao (UNIQUE(campanha_id,email)
//                                           impede materializar de novo). Foi isto que
//                                           aconteceu 2.945 vezes.
//   desconhecido tratado como retentavel -> no pior caso, 5 tentativas inuteis espacadas em
//                                           15 min, e a linha vira 'falha' de qualquer jeito.
// O segundo erro custa 4 chamadas; o primeiro custa um destinatario.

// Teto de tentativas por categoria retentavel.
//
// 5 ciclos = ~75 min de janela para um problema generico se resolver.
// 100 ciclos = ~25 h, o suficiente para atravessar a virada de um limite DIARIO — que e
// exatamente o caso dos 152 HTTP 403. Um teto de 5 aqui perderia a campanha por um
// problema cuja solucao e so esperar amanhecer.
const TETO_BAIXO = 5;
const TETO_ALTO = 100;

// Codigos do ZeptoMail que significam "o ambiente esta errado", nao "este envio deu erro".
// Todos apontam para credencial, token, agente de envio ou estado da conta — nenhum deles
// muda de resultado conforme o destinatario, e por isso a resposta certa e parar o ciclo em
// vez de queimar 125 pessoas uma a uma com a mesma mensagem.
const CODIGOS_CONFIGURACAO = ['SERR_157', 'SERR_156', 'SM_111', 'SM_101', 'AE_101'];

// Codigos de limite/cota do provedor: o envio nao passou AGORA, mas passa depois.
//
// ATENCAO AO LER O LOG: estes chegam como HTTP 403, o MESMO status dos codigos de
// configuracao acima. O status nao distingue nada aqui — quem distingue e o `code` do corpo,
// e e por isso que a funcao le as duas listas antes de olhar para o status.
const CODIGOS_TETO_ALTO = ['SMI_115', 'SM_133', 'SM_128'];

// ══════════════════ SENDGRID ══════════════════
//
// O SendGrid NAO tem campo `code`. O corpo de erro e { errors: [{ message, field }] }, texto
// livre — entao o discriminador aqui e a MENSAGEM, e nao um codigo estavel. E estruturalmente
// mais fragil que a lista do ZeptoMail, e a defesa contra isso e casar por trecho CURTO e
// caracteristico, nunca pela frase inteira: "maximum credits exceeded" sobrevive a uma
// reescrita de texto que "You have exceeded your maximum credits" nao sobreviveria.

// ── O 401 DO SENDGRID E AMBIGUO, E ESTA E A ARMADILHA DESTA MIGRACAO ──
//
// O mesmo HTTP 401 carrega quatro significados, um deles OPOSTO aos outros tres:
//
//   "The provided authorization grant is invalid, expired, or revoked"  chave ruim  -> config
//   "Authenticated user is not authorized"                              escopo      -> config
//   "The requestor's IP address is not whitelisted"                     IP          -> config
//   "Maximum credits exceeded"                                          COTA        -> RETENTAVEL
//
// O ultimo e o SM_133 do SendGrid: cota do plano estourada, resolve sozinha com o tempo. E
// chega com o status que este arquivo mapeava incondicionalmente para 'configuracao'.
//
// Isto e o mesmo bug do 403 do ZeptoMail, na diagonal. La era "403 e sempre config"; aqui
// seria "401 e sempre config". Mesma causa (status lido como se fosse causa), mesmo custo:
// o ciclo abortaria a cada 15 min para sempre, e a campanha nunca andaria — sem perder
// ninguem, mas sem entregar a ninguem, e com o log dizendo "erro de configuracao" para um
// problema que nao e de configuracao.
const TRECHOS_TETO_ALTO = ['maximum credits exceeded'];

// Mensagens de autenticacao/autorizacao do provedor. Redundantes com o fallback de 401/403 la
// embaixo — e de proposito: sem elas o `motivo` gravado na coluna `erro` seria "HTTP 401 sem
// codigo conhecido", que nao distingue chave revogada de escopo faltando de IP bloqueado. Sao
// tres acoes humanas diferentes, e quem le o painel precisa saber qual.
const TRECHOS_CONFIGURACAO_PROVEDOR = [
  'authorization grant is invalid',
  'authenticated user is not authorized',
  'ip address is not whitelisted',
  'access forbidden',
];

// ── O 400 SE PARTE EM DOIS, PELO CAMPO ──
//
// O SendGrid diz QUAL campo recusou. E a diferenca entre dois problemas que nao tem nada em
// comum alem do status:
//
//   field: "personalizations.to.email"  o endereco DAQUELA pessoa e invalido. Retentar
//                                       reproduz o mesmo 400 cinco vezes. -> TERMINAL
//   field: "from" / "content" / ...      o payload que NOS montamos esta quebrado. E igual
//                                       para os 125 da leva. -> CONFIGURACAO (aborta)
//
// Sem esta separacao, um `from` errado marcaria 125 pessoas como falha uma a uma — a forma
// exata do desastre que este modulo existe para impedir.
const CAMPO_400_NOSSO =
  /"field"\s*:\s*"(from|subject|content|reply_to|reply_to_list|template_id|asm|attachments|mail_settings|tracking_settings|send_at|headers)/i;
const CAMPO_400_DESTINATARIO = /"field"\s*:\s*"personalizations/i;

// Erros nossos, levantados antes de qualquer chamada de rede, que denunciam ambiente pela
// metade. Ficam junto dos codigos do provedor de proposito: para quem opera, "faltou o
// segredo de descadastro" e "o token esta errado" sao o mesmo problema — o servidor nao
// esta pronto para enviar — e merecem a mesma reacao.
//
// DESCADASTRO_SECRET e o caso mais caro da lista: sem ele montarCabecalhos LANCA em TODO
// envio. Sem esta classificacao, ligar o interruptor antes de definir a variavel marcaria a
// campanha inteira como falha definitiva, um destinatario por vez, em silencio.
const TRECHOS_CONFIGURACAO = [
  'descadastro_secret',
  'credenciais de campanha ausentes',
  'smtp_campanha_from_email ausente',
  'zeptomail_api_url',
  'failed to parse url',
];

// Recusa que e do ENDERECO, nao do momento. Escrito por trecho de texto, e nao por codigo
// de provedor, porque bounce chega em formatos diferentes conforme quem responde (API,
// dialogo SMTP, relay intermediario) e o vocabulario e mais estavel que a numeracao.
const TRECHOS_TERMINAIS = [
  'destinatario de e-mail de campanha ausente',
  'invalid email',
  'invalid recipient',
  'invalid to address',
  'invalid address',
  'address is invalid',
  'mailbox unavailable',
  'mailbox not found',
  'mailbox does not exist',
  'no such user',
  'user unknown',
  'unknown recipient',
  'recipient rejected',
  'bounce',
];

// Codigo do provedor, com fronteira de palavra: sem ela, 'SM_101' casaria dentro de
// 'SM_1010'. Underscore conta como caractere de palavra, entao \b encosta certo nas aspas
// do JSON em que o codigo chega ("code":"SM_133").
function temCodigo(mensagem, codigo) {
  return new RegExp(`\\b${codigo}\\b`).test(mensagem);
}

// Status HTTP, quando o adaptador o embutiu na mensagem ("... HTTP 429 — ...").
function statusHttp(mensagem) {
  const m = /\bhttp (\d{3})\b/i.exec(mensagem);
  return m ? Number(m[1]) : null;
}

// Devolve { categoria, teto, motivo }.
//   teto  = null para 'terminal' e 'configuracao' (nao ha o que contar).
//   motivo = frase curta, para o log e para a coluna `erro`. Nao substitui a mensagem
//            original: acompanha.
//
// ── A ORDEM DAS CHECAGENS E A REGRA, E O CRITERIO E: CODIGO ANTES DE STATUS ──
//
// O status HTTP do ZeptoMail NAO separa as categorias. O mesmo 403 carrega tanto
// "seu token e invalido" (SERR_157) quanto "voce estourou a cota diaria" (SM_133) —
// situacoes com respostas OPOSTAS: a primeira precisa parar tudo, a segunda precisa esperar
// e insistir. Quem distingue e o `code` DENTRO do corpo da resposta, e so ele.
//
// Isto ja errou uma vez, nesta funcao: a checagem de 401/403 estava ANTES da lista de
// codigos de cota, e por isso um 403 com corpo SM_133 caia em 'configuracao'. Ou seja: o
// cenario EXATO que custou os 152 destinatarios da campanha 4 continuaria mal classificado
// pela peca escrita para conserta-lo — abortando o ciclo em vez de aguardar a virada da
// cota. As duas listas de codigo passaram para a frente de qualquer heuristica de status.
//
// Dentro disso: configuracao antes de tudo, porque e a unica categoria que muda o que
// acontece com os OUTROS 124 destinatarios do ciclo; terminal por ultimo entre as
// especificas, porque um 429 numa resposta que por acaso contenha a palavra "bounce" e um
// 429, e ler ao contrario perderia a pessoa.
function classificarErroEnvio(erro) {
  const bruta = String((erro && erro.message) || erro || '');
  const msg = bruta.toLowerCase();
  const status = statusHttp(msg);

  // 1. CODIGO DO PROVEDOR — a fonte mais confiavel, e por isso a primeira. As duas listas
  // sao disjuntas e ambas vencem qualquer leitura de status HTTP.

  // 1a. Ambiente quebrado — aborta o ciclo.
  for (const codigo of CODIGOS_CONFIGURACAO) {
    if (temCodigo(bruta, codigo)) {
      return { categoria: 'configuracao', teto: null, motivo: `codigo ${codigo} do provedor` };
    }
  }

  // 1b. Limite de vazao/cota — retentavel com teto alto. Chega como 403 na maioria dos
  // casos reais; e justamente por isso que precisa ser lido ANTES do 403.
  for (const codigo of CODIGOS_TETO_ALTO) {
    if (temCodigo(bruta, codigo)) {
      return { categoria: 'retentavel_alto', teto: TETO_ALTO, motivo: `codigo ${codigo} do provedor (limite)` };
    }
  }

  // 1c. Limite de COTA por mensagem (SendGrid, que nao tem codigo). Mesma posicao logica da
  // 1b, e pela mesma razao: precede qualquer leitura de status, porque chega num 401.
  for (const trecho of TRECHOS_TETO_ALTO) {
    if (msg.includes(trecho)) {
      return { categoria: 'retentavel_alto', teto: TETO_ALTO, motivo: `limite do provedor (${trecho})` };
    }
  }

  // 2. ERROS NOSSOS DE AMBIENTE, por texto. Nao carregam codigo de provedor — sao lancados
  // antes de qualquer chamada de rede.
  for (const trecho of TRECHOS_CONFIGURACAO) {
    if (msg.includes(trecho)) {
      return { categoria: 'configuracao', teto: null, motivo: `configuracao ausente ou invalida (${trecho})` };
    }
  }

  // 2b. Autenticacao/autorizacao ditas pelo provedor, com o motivo especifico.
  for (const trecho of TRECHOS_CONFIGURACAO_PROVEDOR) {
    if (msg.includes(trecho)) {
      return { categoria: 'configuracao', teto: null, motivo: `recusa de credencial do provedor (${trecho})` };
    }
  }

  // 2c. O 400 partido pelo CAMPO. O ramo NOSSO vem primeiro: se o payload esta quebrado, ele
  // esta quebrado para os 125, e abortar protege todo mundo. Se as duas coisas aparecerem no
  // mesmo corpo, a que afeta a leva inteira e a que manda.
  if (status === 400) {
    if (CAMPO_400_NOSSO.test(bruta)) {
      return {
        categoria: 'configuracao',
        teto: null,
        motivo: 'HTTP 400 em campo do payload (erro nosso, igual para toda a leva)',
      };
    }
    if (CAMPO_400_DESTINATARIO.test(bruta)) {
      return {
        categoria: 'terminal',
        teto: null,
        motivo: 'HTTP 400 no endereco do destinatario',
      };
    }
  }

  // 2d. Payload grande demais. CONFIGURACAO, e nao terminal — o corpo da campanha e o MESMO
  // para todo mundo (so a URL de descadastro muda), entao um 413 vai acontecer com os 125
  // destinatarios sem excecao. Marcar como falha um a um seria queimar a base inteira por um
  // e-mail pesado demais; abortar deixa a campanha intacta e pede que alguem enxugue o corpo.
  //
  // (A ETAPA A previa 'terminal' aqui. Estava errado pelo mesmo criterio que o resto deste
  // arquivo aplica: a pergunta nao e "quao grave e", e sim "isto muda conforme o
  // destinatario?". Nao muda.)
  if (status === 413) {
    return {
      categoria: 'configuracao',
      teto: null,
      motivo: 'HTTP 413 (corpo do e-mail grande demais — vale para toda a leva)',
    };
  }

  // 2e. Bloqueio temporario. ANTES do fallback de 401/403, e nao junto dos transitorios la
  // embaixo: ele chega COMO um 403, e o fallback o engoliria como 'configuracao' antes de
  // qualquer leitura de texto — a mesma armadilha do 'maximum credits exceeded' num 401.
  //
  // Existe por causa de uma CONTRADICAO na propria documentacao do SendGrid: a tabela geral
  // da v3 descreve o 403 como "Too many bad requests. Temporary block" (transitorio),
  // enquanto o artigo especifico de erros 4XX descreve o mesmo 403 como "Access Forbidden"
  // (autorizacao). As duas fontes sao oficiais e se contradizem; nao da para decidir por
  // leitura, so por observacao — se acontecer.
  //
  // Teto BAIXO, e nao alto, porque as duas leituras do texto apontam para la: se e bloqueio
  // temporario, ele levanta rapido e 5 ciclos bastam; se e consequencia de requisicoes
  // malformadas nossas, insistir 100 vezes com o mesmo payload quebrado nao ajuda ninguem.
  if (msg.includes('temporary block')) {
    return { categoria: 'retentavel', teto: TETO_BAIXO, motivo: 'bloqueio temporario do provedor' };
  }

  // 3. 401/403 SEM CODIGO RECONHECIDO — fallback, e so fallback. Sem um `code` que diga
  // outra coisa, "nao autorizado" e credencial ou permissao: dominio nao verificado, token
  // revogado, agente errado. Nada disso muda conforme o destinatario, entao a resposta certa
  // continua sendo abortar o ciclo em vez de queimar 125 pessoas com a mesma mensagem.
  //
  // Se um codigo ou mensagem de cota novo aparecer aqui (nem o ZeptoMail nem o SendGrid
  // publicam lista fechada), o sintoma sera ciclo abortado em vez de retentativa — visivel no
  // log, sem perder ninguem. A direcao do erro e essa de proposito: errar para o lado de nao
  // marcar. Foi assim que o "Maximum credits exceeded" do SendGrid chegou a esta funcao antes
  // de custar alguem: ele passaria por aqui, e o log diria a coisa errada em voz alta.
  if (status === 401 || status === 403) {
    return { categoria: 'configuracao', teto: null, motivo: `HTTP ${status} sem codigo conhecido (credencial ou permissao)` };
  }

  // 4. TRANSITORIO GENERICO — teto baixo.
  if (status === 429) {
    return { categoria: 'retentavel', teto: TETO_BAIXO, motivo: 'HTTP 429 (excesso de requisicoes)' };
  }
  if (status !== null && status >= 500) {
    return { categoria: 'retentavel', teto: TETO_BAIXO, motivo: `HTTP ${status} (erro do provedor)` };
  }

  // 5. RECUSA DO ENDERECO — terminal.
  for (const trecho of TRECHOS_TERMINAIS) {
    if (msg.includes(trecho)) {
      return { categoria: 'terminal', teto: null, motivo: `recusa definitiva (${trecho})` };
    }
  }

  // 6. DESCONHECIDO — retentavel. Ver a nota do cabecalho sobre a assimetria de custo.
  return { categoria: 'retentavel', teto: TETO_BAIXO, motivo: 'erro nao classificado' };
}

module.exports = {
  classificarErroEnvio,
  TETO_BAIXO,
  TETO_ALTO,
  CODIGOS_CONFIGURACAO,
  CODIGOS_TETO_ALTO,
};
