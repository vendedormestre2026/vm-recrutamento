'use strict';

// Job de disparo da campanha por WhatsApp (transporte: Central Whats).
//
// ── O QUE A TROCA DE TRANSPORTE MUDOU AQUI: NADA DE LOGICA ──
// O envio saia direto para a Graph API e agora vai para o Central Whats. Este arquivo so
// troca de qual modulo importa `enviarTemplate` e `classificar`: teto por ciclo, throttle,
// opt-out, contagem de tentativas, categorias de erro e kill-switch continuam identicos,
// porque nenhum deles jamais dependeu de com quem se fala do outro lado do POST.
//
// SETIMA varredura periodica do projeto. Mesma anatomia das seis anteriores — interruptor
// antes de tocar o banco, trava contra ciclos sobrepostos, teto por ciclo, marcacao SO apos
// sucesso, falha isolada por destinatario.
//
// ── O QUE MUDA EM RELACAO A CAMPANHA DE E-MAIL ──
//   e-mail    teto 125 / ciclo, throttle 500 ms   esta: 30 / ciclo, throttle 2 s
//   e-mail    4 categorias de erro                esta: 3 (ver providers/centralWhats)
//   e-mail    nenhuma consulta de opt-out por linha  esta: SIM, por telefone
//   e-mail    conteudo montado por nos            esta: template aprovado + variaveis
//
// Os numeros sao menores de proposito. A punicao por excesso aqui nao e reputacao de dominio,
// que se recupera: e rebaixamento de tier ou perda do numero, que e binaria. Comecar
// conservador e barato; comecar agressivo pode custar o canal inteiro.

const dbPadrao = require('../db');
const transporte = require('../providers/centralWhats/centralWhats');
const { normalizarTelefoneRecebido } = require('./whatsapp');
const { mascarar } = require('../whatsapp/sequenciaOutbox');
const { montarUrlVaga, UTM_SOURCE_WHATSAPP } = require('./ctaCampanha');
const { precisaBotaoDinamico } = require('./templatesWhatsapp');
const optout = require('./optoutWhatsapp');

// Interruptor de DISPARO, no store `configuracoes` — mesmo padrao de promocao_ativa e
// whatsapp_sequencia_ativa. Config de BANCO, com checkbox no painel; nao e env.
const CHAVE_ATIVO = 'campanha_whatsapp_ativa';

// Teto por ciclo. Bem abaixo dos 125 do e-mail: ver a nota do cabecalho sobre o custo do
// excesso.
const ENVIOS_POR_CICLO = 30;

// Pausa ENTRE envios. 2 s = 30 mensagens em ~1 min, contra um ciclo de 10 min — custo zero em
// vazao, e remove a rajada, que e o padrao que a Meta mede como qualidade ruim.
const ENVIO_INTERVALO_MS = 2000;

// ── VARIAVEL DE TEMPLATE NUNCA PODE SAIR VAZIA (diagnostico da campanha 3) ──
//
// A Meta REJEITA o envio quando uma variavel posicional chega vazia: erro 131008,
// "Required parameter is missing" — o parametro vazio e tratado como ausente, nao como
// texto em branco. Confirmado em producao: a campanha 3 ('Convite Grupo Whats SP', 1.463
// destinatarios) nao entregou UMA mensagem sequer, e os dois envios avulsos do mesmo dia
// provaram os dois lados — o que tinha as tres variaveis preenchidas passou, o que tinha
// uma vazia falhou com este mesmo 131008.
//
// `cargo_vaga` e a variavel que ficava vazia: em convite de grupo NAO ha vaga
// (campanhas_whatsapp.job_id e NULL por definicao — o convite e da praca, nao de uma vaga),
// entao `job_titulo` chega null da fila e o campo caia para ''. Divulgacao de vaga nunca
// sofreu disso porque tem job_id, e por isso a campanha 1 entregou 930 mensagens.
//
// O valor e GENERICO de proposito. O corpo aprovado diz "processo seletivo pra vaga {{2}}",
// e com 1.268 dos 1.463 destinatarios vindos do legado (talentos sem candidatura), nao ha
// vaga por pessoa para citar — "comercial" e verdadeiro para a base inteira e le natural na
// frase. Resolver por destinatario a partir da candidatura de origem cobriria so a minoria
// com application e ainda precisaria deste mesmo fallback atras.
const CARGO_VAGA_PADRAO = 'comercial';

function ativo(deps = {}) {
  const db = deps.db || dbPadrao;
  return db.obterConfigBool(CHAVE_ATIVO, false);
}

function dormirPadrao(ms) {
  if (!(ms > 0)) return Promise.resolve();
  return new Promise((r) => setTimeout(r, ms));
}

// Resolve as variaveis posicionais do template para UM destinatario.
//
// O mapa `variaveis` do template diz posicao -> campo; aqui cada campo vira valor. Campo
// desconhecido resolve para string vazia em vez de lancar: um template com uma variavel a
// mais e problema de configuracao, e derrubar o ciclo inteiro por isso puniria todos os
// outros destinatarios.
function resolverVariaveis(mapa, contexto) {
  const lista = Array.isArray(mapa) ? [...mapa] : [];
  lista.sort((a, b) => (a.posicao || 0) - (b.posicao || 0));
  return lista.map((v) => {
    const valor = contexto[v.campo];
    if (valor === undefined || valor === null) {
      console.warn(`[campanha-wa] variavel '${v.campo}' (posicao ${v.posicao}) sem valor; enviando vazia.`);
      return '';
    }
    return String(valor);
  });
}

function primeiroNome(nome) {
  return String(nome || '').trim().split(/\s+/)[0] || '';
}

// Monta o contexto de variaveis { nome_primeiro, cargo_vaga, link_grupo_regiao, link_vaga,
// cidade } para UM candidato, a partir SO do application_id — sem fila materializada, sem
// campanha. Existe para o envio avulso de teste (admin_campanha_whatsapp.js, ETAPA B): o
// operador escolhe um candidato real e ve as variaveis preenchidas com os dados DELE antes
// de disparar.
//
// ⚠️ NAO E A MESMA RESOLUCAO do loop do ciclo (processarCicloCampanhaWhatsapp, abaixo) — de
// proposito, e a diferenca muda o CONTEUDO da mensagem se confundida:
//   - cargo_vaga/link_vaga do CICLO vem da vaga que a CAMPANHA esta divulgando
//     (campanhas_whatsapp.job_id, materializado na linha da fila como job_titulo/job_slug).
//     Numa divulgacao_vaga, essa vaga e SEMPRE diferente da vaga a que o destinatario se
//     candidatou — e o proprio motivo de "ja se candidatou a esta vaga" ser invariante de
//     exclusao em lib/publicoCampanhaWhatsapp (ninguem recebe divulgacao da propria vaga).
//   - cargo_vaga/link_vaga AQUI vem da vaga a que O CANDIDATO se candidatou (applications.job_id)
//     — a unica vaga que faz sentido perguntar "e a vaga dele?" quando nao ha campanha
//     nenhuma por tras, so uma pessoa escolhida a mao para um teste tecnico.
// Por isso esta funcao NAO substitui a montagem de contexto do ciclo, e o ciclo NAO a chama
// — ligar as duas faria toda divulgacao_vaga anunciar, para cada destinatario, a vaga ERRADA
// (a dele proprio, e nao a que a campanha existe para divulgar).
//
// LANCA se a application nao existir ou nao tiver vaga associada — nunca devolve contexto
// parcial: um contexto incompleto usado para preencher variaveis de um envio REAL esconderia
// o problema atras de campos vazios, e quem testa precisa saber que o dado de origem falta,
// nao receber um WhatsApp com buracos.
//
// Cidade sem link de grupo cadastrado NAO lanca — vira '' (mesma tolerancia de
// resolverVariaveis): falta de link e configuracao incompleta de UMA praca, nao motivo para
// impedir o teste de rodar com o resto do contexto correto.
function montarContextoWhatsapp(applicationId, deps = {}) {
  const db = deps.db || dbPadrao;

  const aplicacao = db.obterAplicacao(applicationId);
  if (!aplicacao) {
    throw new Error(`Candidatura ${applicationId} nao encontrada.`);
  }
  const vaga = aplicacao.job_id ? db.obterVaga(aplicacao.job_id) : null;
  if (!vaga) {
    throw new Error(
      `Candidatura ${applicationId} nao tem vaga associada (job_id ${aplicacao.job_id || '(vazio)'} nao resolve).`,
    );
  }

  const cidade = String(vaga.cidade || '').trim();
  const link = cidade ? db.obterLinkGrupo(cidade) : null;
  const linkVaga = vaga.slug ? montarUrlVaga(vaga.slug, { utmSource: UTM_SOURCE_WHATSAPP }) : '';

  return {
    nome_primeiro: primeiroNome(aplicacao.nome),
    cargo_vaga: vaga.titulo || '',
    link_grupo_regiao: link || '',
    link_vaga: linkVaga,
    cidade,
  };
}

// Uma passada. Devolve { enviados, falhas, retentar, optOut } (+ `desativado`/`abortado`).
async function processarCicloCampanhaWhatsapp(deps = {}) {
  const db = deps.db || dbPadrao;
  const resumo = { enviados: 0, falhas: 0, retentar: 0, optOut: 0 };

  // Kill-switch ANTES de qualquer acesso ao banco. Mesmo contrato das outras seis.
  if (!ativo({ db })) {
    console.log('[campanha-wa] desativado em /admin/config; ciclo pulado.');
    return { ...resumo, desativado: true };
  }

  let pendentes = [];
  try {
    pendentes = db.listarPendentesCampanhaWhatsapp({ limite: deps.porCiclo || ENVIOS_POR_CICLO });
  } catch (err) {
    console.error(`[campanha-wa] falha ao consultar a fila: ${err.message}`);
    return resumo;
  }
  if (!pendentes.length) return resumo;

  const enviar = deps.enviarTemplate || transporte.enviarTemplate;
  const classificar = deps.classificar || transporte.classificarErroCentralWhats;
  const dormir = deps.dormir || dormirPadrao;
  const intervalo = deps.intervaloMs === undefined ? ENVIO_INTERVALO_MS : deps.intervaloMs;

  let abortado = false;

  for (const [i, linha] of pendentes.entries()) {
    // ── 1. OPT-OUT, antes de tudo ──
    // A pessoa pediu para sair. Marcar como 'opt_out' e nao 'falha' e deliberado: falha e
    // problema tecnico, opt_out e vontade dela, e misturar os dois apagaria a unica metrica
    // que diz se a campanha esta incomodando.
    const telefone = normalizarTelefoneRecebido(linha.telefone);
    if (!telefone) {
      db.marcarEnvioWhatsappFalha(linha.id, 'telefone invalido');
      resumo.falhas += 1;
      continue;
    }
    //
    // ── DUAS TABELAS DE OPT-OUT, E O ESCOPO VEM DO TIPO DA MENSAGEM ──
    // A antiga (whatsapp_opt_out, sem escopo) continua sendo lida: uma supressao a mais
    // nunca e risco, e quem saiu antes desta feature nao pode voltar a receber por causa
    // dela. A nova (whatsapp_optout) responde por ESCOPO, e o escopo depende do que esta
    // sendo enviado — nao do motor.
    //
    // `linha.tipo_mensagem` ja vem na fila (campanhas_whatsapp.tipo_mensagem, materializado
    // por linha), entao nao ha consulta nova. Convite de grupo e divulgacao de vaga sao
    // `campanha`; status_candidatura e `transacional` e so o opt-out `total` a bloqueia —
    // ver a tabela ESCOPO_POR_TIPO_MENSAGEM em lib/optoutWhatsapp.js para o porque.
    const escopoMensagem = optout.escopoDoTipoMensagem(linha.tipo_mensagem);
    if (db.estaOptOutWhatsapp(telefone) || optout.estaOptout(telefone, escopoMensagem, { db })) {
      db.marcarEnvioWhatsappOptOut(linha.id);
      resumo.optOut += 1;
      console.log(
        `[campanha-wa] ${mascarar(telefone)} em opt-out (escopo consultado: ${escopoMensagem}); nao enviado.`,
      );
      continue;
    }

    // ── 2. LINK DO GRUPO da praca ──
    // Ausencia de link e falha DAQUELE envio, e NAO aborto do ciclo: uma praca sem link
    // configurado nao pode impedir as outras oito de receberem. E deixar pendente seria pior
    // — a linha reapareceria em todo ciclo, para sempre, sem ninguem entender por que.
    // O link do GRUPO so e exigido no convite. Numa divulgacao de vaga a mensagem leva o
    // link da VAGA, e numa status_candidatura a mensagem e sobre o RESULTADO da candidatura
    // (Incremento 13 da ETAPA B) — nenhum dos dois usa link de grupo, e cobrar isso ali
    // faria a campanha falhar por um dado que ela nem usa. Por isso a condicao e POSITIVA
    // (so convite_grupo precisa), nao mais "tudo exceto divulgacao_vaga" — a forma antiga
    // teria exigido link de grupo de status_candidatura tambem, por engano.
    const precisaLinkGrupo = linha.tipo_mensagem === 'convite_grupo';
    const link = precisaLinkGrupo ? db.obterLinkGrupo(linha.cidade) : '';
    if (precisaLinkGrupo && !link) {
      db.marcarEnvioWhatsappFalha(
        linha.id,
        `configuracao: praca '${linha.cidade || '(sem cidade)'}' sem link de grupo cadastrado`,
      );
      resumo.falhas += 1;
      console.error(
        `[campanha-wa] praca '${linha.cidade || '(sem cidade)'}' sem link de grupo — envio ${linha.id} ` +
          'marcado como falha. Cadastre em /admin/campanhas-whatsapp.',
      );
      continue;
    }

    // ── 3. MONTA E ENVIA ──
    let mapa = [];
    try {
      mapa = JSON.parse(linha.template_variaveis || '[]');
    } catch {
      mapa = [];
    }
    // `link_vaga` so existe em campanha de divulgacao, e e a MESMA URL para todos os
    // destinatarios da campanha — por isso e montada aqui e nao guardada por linha. A UTM
    // 'whatsapp' e o campanha_whatsapp_id sao o que permite medir o clique DESTA campanha,
    // separado da campanha de e-mail que usa a coluna irma.
    const linkVaga = linha.job_slug
      ? montarUrlVaga(linha.job_slug, {
          utmSource: UTM_SOURCE_WHATSAPP,
          campanhaWhatsappId: linha.campanha_id,
        })
      : '';

    const variaveis = resolverVariaveis(mapa, {
      nome_primeiro: primeiroNome(linha.nome),
      // Em divulgacao, o cargo vem da VAGA. Em convite de grupo nao ha vaga, e o fallback
      // NAO pode ser '' — variavel vazia e o 131008 da Meta, ver CARGO_VAGA_PADRAO no topo.
      cargo_vaga: linha.job_titulo || linha.cargo_vaga || CARGO_VAGA_PADRAO,
      link_grupo_regiao: link,
      link_vaga: linkVaga,
      cidade: linha.cidade || '',
    });

    // ── BOTAO DINAMICO (Incremento 3, ajustado apos diagnostico do 404 real) ──
    // precisaBotaoDinamico(nome_meta) e a mesma lista fechada de lib/templatesWhatsapp.js. A
    // URL base aprovada na Meta e "https://entrevista.vendedormestre.com.br/grupo/{{1}}"
    // (confirmado direto no Central Whats), e {{1}} e o SLUG da praca (ex. "joinville") — NAO
    // o link completo do WhatsApp. Um primeiro envio real usou `link` aqui (o mesmo valor que
    // alimenta a variavel de CORPO link_grupo_regiao, linha 225 acima — essa continua certa,
    // nao mexe) e o botao gerou 404. db.obterSlugGrupo(linha.cidade) e o lookup certo — mesma
    // cidade que ja resolveu `link` alguns passos acima, mesmo contrato de null.
    //
    // ⚠️ RISCO CONHECIDO, NAO REGRESSAO NOVA: o passo 2 (acima) ja recusa a linha ANTES de
    // chegar aqui quando falta LINK (`!link`) — mas uma praca com link cadastrado e SLUG
    // vazio (linha antiga nao migrada, por exemplo) passaria por ali e cairia aqui com
    // slugGrupo=null, saindo sem parametro de botao. Hoje isso vira falha visivel e imediata
    // (a Central Whats recusa o envio faltando button0 pra este template, mesmo 400 do
    // diagnostico anterior) — nao um 404 silencioso pro candidato, entao o risco pratico e
    // baixo, mas o cenario existe.
    const slugGrupo = precisaBotaoDinamico(linha.template_nome) ? db.obterSlugGrupo(linha.cidade) : null;
    const parametrosBotao = slugGrupo ? { 0: slugGrupo } : undefined;

    try {
      const { wamid } = await enviar({
        telefone,
        template: {
          nome_meta: linha.template_nome,
          idioma: linha.template_idioma,
          // Propriedade do template aprovado na Meta, nao deste destinatario: quando
          // preenchida, o transporte acrescenta o parametro de botao que a Meta exige (hoje
          // como a chave "button0" de `vars`, antes como componente da Graph API).
          // Vem do banco junto com a linha da fila para nao custar uma consulta por envio.
          botao_parametro_fixo: linha.template_botao_parametro_fixo,
        },
        variaveis,
        parametrosBotao,
        httpClient: deps.httpClient,
      });
      db.marcarEnvioWhatsappEnviado(linha.id, wamid);
      resumo.enviados += 1;
    } catch (err) {
      const classe = classificar(err);

      // 'configuracao' aborta o CICLO e nao marca ninguem — token invalido nao e falha deste
      // destinatario, e insistir nos 29 restantes so repetiria o mesmo erro contra a Meta.
      if (classe.categoria === 'configuracao') {
        console.error('[campanha-wa] ================ ERRO DE CONFIGURACAO ================');
        console.error(
          `[campanha-wa] CICLO ABORTADO. Motivo: ${classe.motivo}. Nenhum destinatario foi ` +
            `marcado. Corrija e o proximo ciclo retoma. Detalhe: ${err.message}`,
        );
        abortado = true;
        break;
      }

      const jaTentou = Number(linha.tentativas) || 0;
      const esgotou = classe.teto === null || jaTentou + 1 >= classe.teto;
      const registro = `[${classe.motivo}] ${err.message}`.slice(0, 300);

      if (esgotou) {
        db.marcarEnvioWhatsappFalha(linha.id, registro);
        resumo.falhas += 1;
      } else {
        db.registrarTentativaEnvioWhatsapp(linha.id, registro);
        resumo.retentar += 1;
      }
      console.error(
        `[campanha-wa] falha para ${mascarar(telefone)} [${classe.categoria}, ` +
          `tentativa ${jaTentou + 1}${classe.teto === null ? '' : `/${classe.teto}`}]: ${err.message}`,
      );
    }

    if (i < pendentes.length - 1) await dormir(intervalo);
  }

  if (resumo.enviados || resumo.falhas || resumo.retentar || resumo.optOut) {
    console.log(
      `[campanha-wa] ciclo concluido — enviados: ${resumo.enviados}, falhas: ${resumo.falhas}, ` +
        `a retentar: ${resumo.retentar}, opt-out: ${resumo.optOut}` +
        `${abortado ? ' (CICLO ABORTADO)' : ''}`,
    );
  }
  return abortado ? { ...resumo, abortado: true } : resumo;
}

// Trava em memoria contra ciclos sobrepostos. Aqui pesa mais que nas outras: dois ciclos
// simultaneos dobrariam a vazao contra a Meta, que e exatamente o que o throttle evita.
let rodando = false;

async function varrerSeOcioso(deps = {}) {
  if (rodando) {
    console.warn('[campanha-wa] ciclo anterior ainda em andamento; este foi ignorado.');
    return null;
  }
  rodando = true;
  try {
    return await processarCicloCampanhaWhatsapp(deps);
  } catch (err) {
    console.error(`[campanha-wa] erro inesperado no ciclo: ${err.message}`);
    return null;
  } finally {
    rodando = false;
  }
}

module.exports = {
  processarCicloCampanhaWhatsapp,
  varrerSeOcioso,
  resolverVariaveis,
  montarContextoWhatsapp,
  ativo,
  CHAVE_ATIVO,
  ENVIOS_POR_CICLO,
  ENVIO_INTERVALO_MS,
};
