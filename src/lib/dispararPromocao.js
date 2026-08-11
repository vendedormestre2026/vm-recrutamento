'use strict';

// Disparo da Promocao de Vagas: a peca que de fato faz e-mail sair para a base.
//
// QUINTA varredura do projeto. A anatomia e a MESMA das outras quatro
// (followupEntrevista, emailRecusa, lembreteInicio, limpezaAudio) — interruptor no painel
// checado antes de tocar no banco, trava em memoria contra ciclos sobrepostos, teto por
// ciclo, marcacao SO apos sucesso, falha isolada por destinatario, degradacao em mock. O
// que muda e a FORMA do trabalho:
//
//   as outras quatro: 1 linha da fila -> 1 pessoa -> 1 e-mail
//   esta:             1 campanha      -> N pessoas -> N e-mails, em varios ciclos
//
// Esse fan-out obriga a duas responsabilidades separadas, com gatilhos diferentes:
//
//   enfileirarCampanha()     UMA vez, no clique do botao (POST /admin/promocao/:id/disparar).
//                            Congela o publico em campanha_envios e passa a campanha para
//                            'enfileirada'. NAO envia nada.
//   varrerDisparoPromocao()  a cada 15 min, pelo setInterval do server.js. Trabalha SOBRE
//                            campanha_envios (nunca recalcula publico) e envia ate o cap.
//
// Sao duas funcoes, e nao uma, porque juntar as duas significaria recalcular o publico a
// cada ciclo — e uma campanha grande, que leva horas para drenar, sairia para um recorte
// diferente a cada 15 minutos.
//
// ── O INTERRUPTOR ──
// `promocao_ativa`, default FALSE, no mesmo store `configuracoes` das outras quatro
// (documentadas em routes/admin.js, na secao de /admin/config: CHAVE_EMAIL_RECUSA_ATIVO,
// CHAVE_LEMBRETE_INICIO_ATIVO, CHAVE_LIMPEZA_AUDIO_ATIVO e followup.CHAVE_ATIVO). Nenhuma
// varredura deste projeto nasce ligada, e esta menos que todas: e a unica que escreve para
// gente que NAO pediu contato daquele momento. Nao ha migracao a fazer — `configuracoes` e
// chave/valor livre e a ausencia da chave ja significa desligado.
//
// IMPORTANTE: enfileirar NAO depende do interruptor. Enfileirar e um ato humano,
// deliberado e reversivel-por-omissao; enviar e o que precisa de trava. Uma campanha pode
// ficar enfileirada indefinidamente com `promocao_ativa` = false, e nenhum e-mail sai.

const { config } = require('../config');
const dbPadrao = require('../db');
// FACHADA, e nao ./smtp diretamente: o transporte ativo e escolhido por
// EMAIL_CAMPANHA_TRANSPORTE (hoje 'api', porque o Railway bloqueia SMTP). As DUAS
// importacoes abaixo tem que vir do mesmo lugar — se `enviar` viesse da fachada e
// `credenciaisFaltando` do SMTP, o pre-voo aprovaria um ambiente sem a chave de API.
const emailCampanhaPadrao = require('../providers/emailCampanha');
const { credenciaisFaltando } = require('../providers/emailCampanha');
const { montarUrlDescadastro } = require('./descadastro');
const { listarPublicoCampanha } = require('./promocaoVagas');
const { montarCorpoFinal } = require('./ctaCampanha');

// Interruptor GERAL do envio de campanha (painel: /admin/config). Default FALSE.
const CHAVE_ATIVO = 'promocao_ativa';

// Teto de envios por CICLO, somando todas as campanhas em andamento.
//
// 125 a cada 15 min = 500/h, exatamente o limite de vazao contratado no Emailit. O numero
// nao e folga arbitraria: estourar o limite do provedor nao devolve erro por mensagem, e
// sim throttling ou bloqueio do dominio inteiro — e o dominio de campanha e compartilhado
// por todas as campanhas futuras. O teto e do CICLO, nao da campanha: duas campanhas
// enfileiradas juntas dividem os mesmos 125, em vez de somarem 250.
const ENVIOS_POR_CICLO = 125;

// Tamanho maximo da mensagem de erro guardada por linha. Log de provedor SMTP e verboso
// (traz o dialogo inteiro); a coluna `erro` existe para o Jean entender o que houve, nao
// para arquivar transcricao. O mesmo recorte de MAX_DETALHE_ERRO do adaptador.
const MAX_ERRO = 300;

function ativo(deps = {}) {
  const db = deps.db || dbPadrao;
  return db.obterConfigBool(CHAVE_ATIVO, false);
}

// ──────────────────────────────────────────────────────────────
// PRE-VOO — o que precisa estar configurado ANTES de enfileirar
// ──────────────────────────────────────────────────────────────

// E-mail sentinela do pre-voo. Nunca recebe nada: serve so de entrada para o calculo do
// HMAC de descadastro. Dominio reservado (.invalid, RFC 2606) de proposito — se algum dia
// alguem errar e passar este valor adiante, ele nao pode ser um endereco de verdade.
const EMAIL_PRE_VOO = 'pre-voo@vendedormestre.invalid';

// A campanha e IRRECUPERAVEL se disparada com o ambiente pela metade, e essa e a razao de
// esta funcao existir em vez de um paragrafo no README.
//
// O CENARIO CONCRETO: sem DESCADASTRO_SECRET, o adaptador LANCA em todo envio (o
// List-Unsubscribe e obrigatorio e a URL depende do HMAC). A varredura entao marca cada
// linha como 'falha' — e falha e TERMINAL, sem retentativa. Some-se o
// UNIQUE(campanha_id, email), que impede materializar a mesma campanha de novo para as
// mesmas pessoas, e o resultado de ligar `promocao_ativa` na ordem errada e uma campanha
// inteira queimada, sem caminho de volta pela aplicacao. Um erro de SEQUENCIA de
// configuracao nao pode custar isso.
//
// O QUE NAO E CHECADO AQUI, de proposito:
//   - verificacao do dominio no provedor (SPF/DKIM/DMARC): o codigo nao tem como saber, e
//     um teste de rede no meio de um clique de painel seria pior que o problema;
//   - `promocao_ativa`: e decisao OPERACIONAL, nao pre-condicao tecnica. Enfileirar com o
//     interruptor desligado e legitimo — a campanha espera na fila, e nada sai.
//
// Devolve { ok, pendencias: [{ chave, detalhe }], mensagem }. NAO lanca: quem quer a
// versao que lanca usa garantirPreCondicoesDisparo (abaixo).
function verificarPreCondicoesDisparo() {
  const pendencias = [];

  // 1. DESCADASTRO_SECRET — exercitando o CAMINHO REAL, e nao so olhando a string da
  // config. montarUrlDescadastro e exatamente o que o adaptador chama em cada envio: se
  // ele funciona aqui, funciona la. Uma checagem por `config.descadastro.segredo` seria
  // mais barata e menos verdadeira — passaria por cima de qualquer outro motivo de o
  // token nao poder ser gerado.
  try {
    montarUrlDescadastro(EMAIL_PRE_VOO, config.baseUrl);
  } catch (err) {
    pendencias.push({
      chave: 'DESCADASTRO_SECRET',
      detalhe:
        'Sem ele, todo e-mail de campanha falha na hora de montar o link de descadastro ' +
        `(List-Unsubscribe), e a falha e definitiva por destinatário. Detalhe: ${err.message}`,
    });
  }

  // 2. Credenciais de SMTP de campanha — pela MESMA lista que o adaptador usa no envio
  // (providers/emailCampanha/smtp.credenciaisFaltando), nunca por uma copia local.
  const faltando = credenciaisFaltando();
  if (faltando.length) {
    pendencias.push({
      chave: faltando.join(', '),
      detalhe:
        'Sem as credenciais do provedor de campanha, nenhum e-mail sai — e cada tentativa ' +
        'marca o destinatário como falha definitiva.',
    });
  }

  const mensagem = pendencias.length
    ? 'O disparo está bloqueado porque falta configuração no servidor: ' +
      pendencias.map((p) => `${p.chave} — ${p.detalhe}`).join(' | ') +
      ' Configure no .env e reinicie a aplicação. A campanha continua em rascunho, intacta.'
    : '';

  return { ok: pendencias.length === 0, pendencias, mensagem };
}

// Versao que LANCA. Usada por enfileirarCampanha para que NENHUM caminho de codigo —
// inclusive um script manual ou um caller futuro que ignore o valor de retorno — consiga
// materializar uma campanha num ambiente incapaz de envia-la. Um `{ ok: false }` devolvido
// pode ser ignorado por acidente; uma excecao, nao.
function garantirPreCondicoesDisparo() {
  const r = verificarPreCondicoesDisparo();
  if (!r.ok) throw new Error(r.mensagem);
  return r;
}

// ──────────────────────────────────────────────────────────────
// A. MATERIALIZACAO — 'rascunho' -> 'enfileirada'
// ──────────────────────────────────────────────────────────────

// Congela o publico da campanha em campanha_envios e a enfileira.
//
// O publico e RECALCULADO aqui, na hora. Nao se usa `total_destinatarios` (o numero
// congelado na criacao do rascunho) nem qualquer lista guardada: entre criar o rascunho e
// clicar em disparar podem ter passado dias, e nesse meio-tempo gente se descadastrou, se
// candidatou a vaga alvo ou entrou na base. O recorte que vale e o de AGORA — o numero da
// criacao serve so para a tela de revisao mostrar a divergencia.
//
// Devolve { ok, enfileirados } ou { ok: false, erroCodigo, mensagem }. NAO lanca em erro de
// fluxo (status errado, publico impossivel de calcular): quem chama e uma rota de painel,
// que precisa transformar isso em mensagem na tela, e nao em 500.
//
// ── SE JA HOUVER LINHAS DE ENVIO PARA ESTA CAMPANHA ──
// Nao deveria acontecer: o guard de status barra a segunda chamada, e a materializacao e
// atomica (ver materializarEnviosCampanha), entao nem uma queda no meio do laco deixa
// linhas orfas. Se ainda assim houver, e SITUACAO ANORMAL — banco editado a mao, restore
// parcial, bug futuro — e a resposta e RECUSAR e pedir intervencao humana, nunca continuar.
// As duas alternativas sao piores:
//   - inserir por cima: o UNIQUE(campanha_id, email) barraria no meio, deixando um
//     resultado indeterminado entre "nada" e "parte";
//   - pular e seguir: enviaria para uma lista congelada de origem desconhecida, que e
//     exatamente o que ninguem consegue auditar depois.
function enfileirarCampanha(campanhaId, deps = {}) {
  const db = deps.db || dbPadrao;
  const publicoDe = deps.listarPublicoCampanha || listarPublicoCampanha;

  // PRE-VOO ANTES DE TUDO, e LANCANDO. Vem primeiro porque nao e um problema DESTA
  // campanha — e do ambiente: com o servidor mal configurado, nenhuma campanha pode ser
  // enfileirada, entao nem faz sentido olhar id, status ou publico antes.
  //
  // A rota ja barra o usuario bem antes daqui (ele nem chega a ver a tela de confirmacao).
  // Esta checagem e REDUNDANTE de proposito: ela existe para os OUTROS caminhos — um
  // script manual, um caller futuro, ou a janela entre os dois cliques da confirmacao, se
  // a configuracao mudar no meio. E a unica das duas que nao da para contornar.
  //
  // LANCA em vez de devolver { ok: false } porque a diferenca de natureza importa: os
  // demais erros daqui sao de FLUXO (esta campanha, neste estado) e o chamador precisa
  // transformar em mensagem de tela; este e de AMBIENTE, atinge todo mundo igual, e nao
  // pode depender de o chamador lembrar de conferir um campo do retorno.
  garantirPreCondicoesDisparo();

  const id = Number(campanhaId);
  if (!Number.isInteger(id) || id <= 0) {
    return { ok: false, erroCodigo: 'CAMPANHA_INVALIDA', mensagem: 'Campanha inválida.' };
  }

  const campanha = db.obterCampanha(id);
  if (!campanha) {
    return { ok: false, erroCodigo: 'CAMPANHA_NAO_ENCONTRADA', mensagem: 'Campanha não encontrada.' };
  }

  // Guard de status. Uma campanha ja enfileirada/enviando/concluida NAO volta para ca:
  // re-enfileirar significaria uma segunda materializacao sobre a primeira, e o unico
  // resultado possivel disso e gente recebendo o mesmo e-mail duas vezes ou uma campanha
  // pela metade. 'cancelada' tambem nao volta — cancelar e uma decisao, nao uma pausa.
  if (campanha.status !== 'rascunho') {
    return {
      ok: false,
      erroCodigo: 'STATUS_INVALIDO',
      status: campanha.status,
      mensagem:
        `Esta campanha está em "${campanha.status}" e só é possível disparar uma campanha ` +
        'em rascunho. Uma campanha já disparada não pode ser disparada de novo.',
    };
  }

  const jaExistem = db.contarEnviosCampanha(id);
  if (jaExistem.total > 0) {
    console.error(
      `[promocao] ANOMALIA: campanha ${id} esta em 'rascunho' mas ja tem ` +
        `${jaExistem.total} linha(s) em campanha_envios. Disparo recusado.`,
    );
    return {
      ok: false,
      erroCodigo: 'ENVIOS_PREEXISTENTES',
      mensagem:
        `Esta campanha está em rascunho mas já tem ${jaExistem.total} destinatário(s) ` +
        'materializados — um estado que não deveria existir. O disparo foi recusado por ' +
        'segurança. Verifique o banco antes de tentar de novo.',
    };
  }

  let publico;
  try {
    publico = publicoDe(campanha.criterios, { db });
  } catch (err) {
    console.error(`[promocao] falha ao calcular publico da campanha ${id}: ${err.message}`);
    return {
      ok: false,
      erroCodigo: 'PUBLICO_INDISPONIVEL',
      mensagem: 'Não foi possível calcular o público agora. A campanha continua em rascunho.',
    };
  }

  let enfileirados;
  try {
    enfileirados = db.materializarEnviosCampanha(id, publico.itens);
  } catch (err) {
    console.error(`[promocao] falha ao materializar campanha ${id}: ${err.message}`);
    return {
      ok: false,
      erroCodigo: 'MATERIALIZACAO_FALHOU',
      mensagem:
        'Não foi possível enfileirar os destinatários. Nada foi gravado e a campanha ' +
        'continua em rascunho.',
    };
  }

  // Publico vazio e enfileirado normalmente, e nao tratado como erro: o recorte pode ter
  // secado legitimamente (todo mundo se candidatou a vaga, todo mundo se descadastrou). A
  // campanha entra sem nenhum pendente e a varredura a conclui no ciclo seguinte — o
  // caminho de finalizacao nao depende de ter havido envio.
  console.log(`[promocao] campanha ${id} enfileirada com ${enfileirados} destinatario(s).`);
  return { ok: true, enfileirados };
}

// ──────────────────────────────────────────────────────────────
// B. VARREDURA — roda a cada ciclo do setInterval
// ──────────────────────────────────────────────────────────────

// Envia UM destinatario e marca a linha conforme o resultado.
// Devolve 'enviado' | 'falha'. Erro NUNCA propaga: quem chama precisa seguir para o
// proximo da leva, mesmo que este tenha explodido.
//
// ORDEM QUE IMPORTA: envia PRIMEIRO, marca DEPOIS. Marcar antes tornaria uma queda entre
// as duas operacoes indistinguivel de um envio bem-sucedido, e a pessoa nunca receberia.
// O inverso (enviar e cair antes de marcar) faria a linha voltar no proximo ciclo e a
// pessoa receber duas vezes — e a janela para isso e de milissegundos contra a de uma
// chamada SMTP inteira. Trocamos o risco raro pelo risco menos danoso, mesma escolha de
// enviarParaCandidato em lembreteInicio.js.
async function enviarUm(linha, deps) {
  const db = deps.db || dbPadrao;
  const emailCampanha = deps.emailCampanha || emailCampanhaPadrao;

  if (!linha.vaga_slug) {
    console.warn(
      `[promocao] envio ${linha.id} (campanha ${linha.campanha_id}) sem slug de vaga — ` +
        'o e-mail sai SEM link de candidatura. A vaga foi removida?',
    );
  }

  try {
    // Moldura e links montados AQUI, no momento do envio, e nao gravados em
    // campanhas.corpo_html: o que fica no banco continua sendo o texto que o Jean escreveu
    // ou revisou, e tudo o mais e derivado a cada envio. Se o dominio da aplicacao mudar
    // (config.baseUrl), campanhas ja enfileiradas passam a sair com o endereco novo em vez
    // de carregarem um link morto congelado na criacao.
    //
    // MESMA funcao que o botao de e-mail de teste chama (lib/emailTestePromocao) — e o que
    // garante que o teste mostre exatamente o e-mail que a base vai receber.
    //
    // A URL de descadastro sai de montarUrlDescadastro, a MESMA funcao que o adaptador usa
    // para montar o cabecalho List-Unsubscribe. Nao ha segunda geracao de token: o link do
    // rodape e o do cabecalho sao a mesma string, vinda da mesma chamada.
    //
    // DENTRO do try, e nao antes dele: montarUrlDescadastro LANCA se DESCADASTRO_SECRET
    // faltar. Fora daqui, essa excecao subiria por enviarUm — que promete nunca propagar —
    // e derrubaria a leva inteira no primeiro destinatario. Dentro, o destinatario e
    // marcado como 'falha' com a mensagem do erro, exatamente como quando o proprio
    // adaptador falha por esse mesmo motivo. O pre-voo do disparo ja barra esse cenario
    // antes de qualquer campanha ser materializada; isto e a rede embaixo.
    const corpoFinal = montarCorpoFinal(
      linha.corpo_html,
      linha.vaga_slug,
      montarUrlDescadastro(linha.email, config.baseUrl),
    );

    if (config.entrevista.mock) {
      // Mesmo padrao das outras quatro varreduras: em mock o adaptador nao e tocado, e a
      // linha e marcada MESMO ASSIM. Sem marcar, a campanha nunca sairia de 'enviando' e a
      // varredura relogaria os mesmos destinatarios a cada 15 min para sempre.
      //
      // CONSEQUENCIA ASSUMIDA, identica a de lembreteInicio: rodar uma campanha em mock
      // "queima" aqueles destinatarios — eles ficam 'enviado' sem terem recebido nada, e o
      // UNIQUE impede reenvio. E o preco de a rotina ser exercitavel sem gastar entrega, e
      // e por isso que producao roda com INTERVIEW_MOCK=false.
      console.log(`[promocao] (mock) e-mail NAO enviado. destinatario=${linha.email} campanha=${linha.campanha_id}`);
    } else {
      // SEM `opcoes`: nada de headers montados a mao. List-Unsubscribe e
      // List-Unsubscribe-Post entram sozinhos, dentro do adaptador (Incremento 3), e essa
      // e a unica forma de nao existir um caminho de esquecimento. Se esta chamada um dia
      // ganhar um quarto argumento, ele precisa de justificativa escrita: `semDescadastro`
      // aqui produziria campanha sem opt-out valido.
      await emailCampanha.enviar(linha.email, linha.assunto, corpoFinal);
    }
    db.marcarEnvioCampanhaEnviado(linha.id);
    return 'enviado';
  } catch (err) {
    console.error(
      `[promocao] falha ao enviar (envio_id=${linha.id} campanha=${linha.campanha_id}): ${err.message}`,
    );
    try {
      db.marcarEnvioCampanhaFalha(linha.id, String(err.message || err).slice(0, MAX_ERRO));
    } catch (erroAoMarcar) {
      // Falhar ao registrar a falha nao pode derrubar a leva. A linha continua 'pendente'
      // e volta no proximo ciclo — que e o comportamento seguro quando o banco reclama.
      console.error(`[promocao] falha ao marcar erro do envio ${linha.id}: ${erroAoMarcar.message}`);
    }
    return 'falha';
  }
}

// Fecha as campanhas cujo trabalho acabou.
//
// Roda a CADA ciclo, e nao uma vez so: uma campanha com mais de ENVIOS_POR_CICLO
// destinatarios leva varios ciclos para esgotar, e so o ultimo deles a deixa sem
// pendentes. Tambem cobre dois casos que um "concluir ao terminar a leva" perderia:
//   - campanha enfileirada com publico VAZIO (nenhum pendente desde o inicio);
//   - campanha cujos envios TODOS falharam (nenhum 'enviado', mas nada mais a fazer).
// "Concluida" aqui significa "nao ha mais nada pendente", e nao "deu tudo certo" — o
// painel mostra os numeros de falha ao lado.
function concluirCampanhasEsgotadas(deps) {
  const db = deps.db || dbPadrao;
  let concluidas = 0;

  for (const campanha of db.listarCampanhasEmAndamento()) {
    const contagem = db.contarEnviosCampanha(campanha.id);
    if (contagem.pendente > 0) continue;
    if (db.concluirCampanha(campanha.id) === 1) {
      concluidas += 1;
      console.log(
        `[promocao] campanha ${campanha.id} concluida — ` +
          `enviados: ${contagem.enviado}, falhas: ${contagem.falha}.`,
      );
    }
  }

  return concluidas;
}

// Uma passada completa. Sequencial de proposito, igual as outras varreduras: em massa isso
// importa ainda mais — 125 conexoes SMTP simultaneas contra o provedor parecem exatamente
// com o que um sistema comprometido faria.
// Retorna { enviados, falhas } (numeros), util para log e para teste.
async function varrerDisparoPromocao(deps = {}) {
  const db = deps.db || dbPadrao;
  const resumo = { enviados: 0, falhas: 0 };

  // Interruptor checado ANTES de qualquer acesso ao banco: com ele desligado, o ciclo nao
  // le fila, nao conclui campanha e nao escreve nada. Mesmo contrato de lembreteInicio.
  if (!ativo(deps)) {
    console.log('[promocao] desativado em /admin/config; ciclo pulado.');
    return { ...resumo, desativado: true };
  }

  let pendentes = [];
  try {
    pendentes = db.listarEnviosPendentesCampanha({ limite: ENVIOS_POR_CICLO });
  } catch (err) {
    console.error(`[promocao] falha ao consultar a fila de envios: ${err.message}`);
    return resumo;
  }

  // 'enfileirada' -> 'enviando' antes do primeiro envio da campanha, para o painel
  // distinguir "aguardando a rotina" de "saindo agora". Uma vez por campanha da leva.
  for (const campanhaId of new Set(pendentes.map((l) => l.campanha_id))) {
    try {
      db.marcarCampanhaEnviando(campanhaId);
    } catch (err) {
      // Cosmetico: se falhar, os envios seguem normalmente (a fila aceita 'enfileirada').
      console.error(`[promocao] falha ao marcar campanha ${campanhaId} como enviando: ${err.message}`);
    }
  }

  for (const linha of pendentes) {
    const r = await enviarUm(linha, deps);
    if (r === 'enviado') resumo.enviados += 1;
    else resumo.falhas += 1;
  }

  // DEPOIS do laco, e sempre — inclusive quando a leva veio vazia. E o que fecha as
  // campanhas cujo ultimo pendente saiu no ciclo anterior e as de publico vazio.
  try {
    concluirCampanhasEsgotadas(deps);
  } catch (err) {
    console.error(`[promocao] falha ao concluir campanhas esgotadas: ${err.message}`);
  }

  if (resumo.enviados || resumo.falhas) {
    console.log(
      `[promocao] varredura concluida — enviados: ${resumo.enviados}, falhas: ${resumo.falhas}`,
    );
  }
  return resumo;
}

// ── Trava em memoria contra execucoes sobrepostas ──
// Mesma razao das outras quatro varreduras: a passada do boot e as do setInterval
// compartilham a MESMA trava, e um ciclo que demore mais que o intervalo faz o tick
// seguinte ser DESCARTADO (nao enfileirado). Aqui a trava pesa mais que nas outras: com
// 125 chamadas SMTP por ciclo, dois ciclos sobrepostos dobrariam a vazao contra o provedor.
// Vale so dentro deste processo; a garantia real contra e-mail duplicado e o
// UNIQUE(campanha_id, email) somado ao UPDATE condicional.
let varrendo = false;

async function varrerSeOcioso(deps = {}) {
  if (varrendo) {
    console.warn('[promocao] varredura anterior ainda em andamento; ciclo ignorado.');
    return null;
  }
  varrendo = true;
  try {
    return await varrerDisparoPromocao(deps);
  } catch (err) {
    // Defensivo: varrerDisparoPromocao ja captura os erros esperados. Se algo escapar, o
    // agendador NAO pode morrer nem deixar a trava presa.
    console.error(`[promocao] erro inesperado na varredura: ${err.message}`);
    return null;
  } finally {
    varrendo = false;
  }
}

module.exports = {
  enfileirarCampanha,
  varrerDisparoPromocao,
  varrerSeOcioso,
  verificarPreCondicoesDisparo,
  garantirPreCondicoesDisparo,
  ativo,
  CHAVE_ATIVO,
  ENVIOS_POR_CICLO,
};
