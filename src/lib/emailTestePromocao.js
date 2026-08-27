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
const { config } = require('../config');
const { verificarPreCondicoesDisparo } = require('./dispararPromocao');
const { montarCorpoFinal, montarCorpoFinalGrupo } = require('./ctaCampanha');
// A MESMA funcao que o adaptador de envio usa para montar o cabecalho List-Unsubscribe.
// Chamada aqui para que o link do rodape seja byte a byte o do cabecalho — ver a nota em
// ctaCampanha.montarCorpoFinal sobre por que a URL chega pronta na montagem.
const { montarUrlDescadastro } = require('./descadastro');

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
//                          | 'SEM_VAGA' | 'SEM_GRUPO' | 'PRE_VOO' | 'COOLDOWN' | 'ENVIO_FALHOU',
//                mensagem }
//
// ORDEM DAS CHECAGENS, que nao e arbitraria: primeiro o que o Jean resolve sozinho e de
// graca (destinatario, conteudo), depois o que depende do servidor (pre-voo), e o cooldown
// por ULTIMO entre as validacoes — recusar por cooldown um envio que ia falhar de qualquer
// jeito esconderia o problema real atras de "espere 47 s".
//
// `tipo`/`cidade`: par novo, mesmo par que a campanha de e-mail ja tem
// (lib/promocaoVagas.listarPublicoCampanha). `tipo` default 'divulgacao_vaga' — chamador
// antigo (nenhum manda `tipo`) preserva 100% o comportamento de sempre, exigindo `jobId`.
// Com `tipo: 'convite_grupo'`, `jobId` fica irrelevante e `cidade` entra no lugar.
async function enviarEmailTeste({ assunto, corpoHtml, jobId, tipo, cidade } = {}, deps = {}) {
  const db = deps.db || dbPadrao;
  const emailCampanha = deps.emailCampanha || emailCampanhaPadrao;
  const agora = deps.agora || Date.now();
  const tipoCampanha = tipo === 'convite_grupo' ? 'convite_grupo' : 'divulgacao_vaga';

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

  // ── A VAGA (ou, em convite_grupo, o GRUPO) E OBRIGATORIO no e-mail de teste ──
  //
  // MUDANCA DE COMPORTAMENTO consciente (divulgacao_vaga): antes o teste saia sem vaga
  // selecionada. Agora nao, porque o e-mail real SEMPRE tem o bloco de candidatura montado
  // a partir da vaga, e um teste sem esse bloco mostraria uma mensagem diferente da que a
  // base vai receber — exatamente o que este botao existe para impedir. Melhor um erro
  // claro pedindo para escolher a vaga do que um teste que valida o e-mail errado. MESMO
  // raciocinio se aplica a convite_grupo: o e-mail real sempre tem o botao "ENTRAR NO
  // GRUPO", e um teste sem ele nao provaria nada.
  let vaga = null;
  let slugGrupo = null;
  if (tipoCampanha === 'divulgacao_vaga') {
    const id = Number(jobId);
    vaga = Number.isInteger(id) && id > 0 ? db.obterVaga(id) : null;
    if (!vaga || !vaga.slug) {
      return {
        ok: false,
        erroCodigo: 'SEM_VAGA',
        mensagem:
          'Escolha a vaga antes de enviar o teste — o e-mail leva o link de candidatura dela, ' +
          'e sem a vaga o teste mostraria uma mensagem diferente da que sai de verdade.',
      };
    }
  } else {
    // Checa LINK (nao so slug): toda praca cadastrada ja nasce com slug (auto-gerado na
    // criacao, lib/slug.js), mas o link_convite_grupo continua NULL ate alguem preencher
    // em /admin/campanhas-whatsapp — um slug sem link clicaria em ".../grupo/<slug>" e
    // cairia no 404 de GET /grupo/:slug (routes/pages.js). obterLinkGrupo e quem valida
    // essa condicao de verdade; obterSlugGrupo so devolve o valor pra montar a URL.
    const cidadeAparada = String(cidade || '').trim();
    const linkGrupo = cidadeAparada ? db.obterLinkGrupo(cidadeAparada) : null;
    slugGrupo = linkGrupo ? db.obterSlugGrupo(cidadeAparada) : null;
    if (!slugGrupo) {
      return {
        ok: false,
        erroCodigo: 'SEM_GRUPO',
        mensagem:
          `A praça "${cidade || '(nenhuma)'}" não tem grupo configurado (falta o link em ` +
          '/admin/campanhas-whatsapp) — o e-mail leva o botão de entrar no grupo, e sem ' +
          'ele o teste mostraria uma mensagem diferente da que sai de verdade.',
      };
    }
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
    //
    // O corpo passa pela MESMA montarCorpoFinal que a varredura de disparo usa (nao ha
    // segunda implementacao da moldura, do bloco de CTA nem do rodape). E o que faz este
    // botao valer como teste: o HTML que chega na caixa de entrada aqui e byte a byte o que
    // a base receberia.
    //
    // A URL de descadastro e montada aqui e passada adiante, EXATAMENTE como a varredura de
    // disparo faz (dispararPromocao.enviarUm). O link do rodape aponta para o descadastro do
    // proprio endereco de teste: e o comportamento certo — este botao existe para mostrar o
    // e-mail REAL, e um rodape apontando para outra coisa testaria uma mensagem que nao
    // existe. Consequencia a saber: clicar nele descadastra o endereco de teste de verdade.
    // A vaga inteira vai para a montagem: o cabecalho mostra titulo, empresa, endereco,
    // modalidade, regime e horario. `vaga` aqui e a linha de db.obterVaga, e a varredura de
    // disparo monta um objeto com os MESMOS campos a partir do LEFT JOIN da fila — e isso
    // que faz os dois caminhos produzirem o mesmo cabecalho.
    // campanhaId NULL de proposito nos dois caminhos: o botao de teste funciona a partir
    // do formulario AINDA NAO SUBMETIDO — nao existe campanha, e portanto nao existe id. E
    // o comportamento certo: um clique do Jean no proprio e-mail de teste nao pode entrar
    // na contagem de desempenho (cliques de vaga OU de grupo) de campanha nenhuma.
    //
    // E a UNICA divergencia deliberada entre este caminho e o disparo real, ao lado do
    // prefixo [TESTE] no assunto. O teste de igualdade byte a byte compara os dois
    // passando o MESMO campanhaId, entao ele continua guardando tudo o mais.
    const corpoFinal =
      tipoCampanha === 'divulgacao_vaga'
        ? montarCorpoFinal(corpoLimpo, vaga.slug, montarUrlDescadastro(destinatario, config.baseUrl), vaga, null)
        : montarCorpoFinalGrupo(
            corpoLimpo,
            slugGrupo,
            montarUrlDescadastro(destinatario, config.baseUrl),
            cidade,
            null,
          );

    await emailCampanha.enviar(destinatario, PREFIXO_ASSUNTO + assuntoLimpo, corpoFinal);
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
