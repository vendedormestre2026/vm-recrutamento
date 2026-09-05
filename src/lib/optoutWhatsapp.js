'use strict';

// Opt-out de WhatsApp — a camada que os MOTORES e as ROTAS usam.
//
// A tabela e o SQL vivem em db/sqlite.js (secao "Opt-out de WhatsApp COM ESCOPO"); a chave
// canonica vive em lib/chaveTelefone.js. Este modulo e o que da nome as regras de NEGOCIO
// que nenhum dos dois deveria conhecer: o que e campanha, o que e transacional, e qual
// escopo cada tipo de mensagem consulta.
//
// ══════════════════════════════════════════════════════════════
// P1 — OPT-OUT TEM ESCOPO. CAMPANHA NAO E TRANSACIONAL.
// ══════════════════════════════════════════════════════════════
//
// Existem duas naturezas de mensagem neste projeto, e tratar as duas igual quebra uma das
// duas:
//
//   CAMPANHA      convite de grupo, divulgacao de vaga. NOS iniciamos, a pessoa nao pediu.
//                 E aqui que mora o incomodo, e e daqui que as pessoas querem sair.
//   TRANSACIONAL  WA1/WA2, resultado de candidatura. Consequencia direta e RECENTE de um
//                 ato da propria pessoa (candidatar-se). Ela espera essa mensagem, e
//                 suprimi-la trava o processo seletivo dela.
//
// Quem escreve "nao me mandem mais" quase sempre quer dizer "parem de me oferecer vagas",
// nao "me ignorem se eu me candidatar no futuro". Por isso o escopo padrao de TODO opt-out
// automatico (link, resposta, botao) e `campanha`. O escopo `total` existe, suprime tudo, e
// so nasce de escolha explicita — a pessoa marcando a opcao na pagina de descadastro, ou o
// recrutador registrando a mao.
//
// ══════════════════════════════════════════════════════════════
// P2 — CANDIDATURA NOVA NUNCA REVOGA OPT-OUT
// ══════════════════════════════════════════════════════════════
//
// Cenario canonico: a pessoa pede descadastro em marco; em abril se candidata a uma vaga
// nova com o mesmo numero. O resultado correto e:
//
//   recebe WA1 e WA2          (ato explicito e recente DELA)
//   continua fora de campanha (o pedido de marco nao caducou)
//   o opt-out segue ATIVO     (so revogacao explicita o desfaz)
//
// Nao ha, em lugar nenhum deste projeto, codigo que revogue opt-out por candidatura. Se
// alguem for acrescentar "reengajamento automatico" um dia, e AQUI que a decisao precisa
// ser reaberta — nao num `if` escondido no agendamento da sequencia.
//
// ══════════════════════════════════════════════════════════════
// P5 — ESTADO SEGURO E SUPRIMIR
// ══════════════════════════════════════════════════════════════
//
// O kill-switch `optout_whatsapp_ativo` nasce LIGADO (default true em `ativo()`), ao
// contrario de todos os outros interruptores do projeto, que nascem desligados. A assimetria
// e proposital: os outros ligam um ENVIO, e o default seguro deles e nao enviar; este liga
// uma SUPRESSAO, e o default seguro dele e suprimir. Uma variavel esquecida nao pode
// significar "volte a mandar mensagem para quem pediu para parar".

const dbPadrao = require('../db');
const { chaveCanonicaTelefone } = require('./chaveTelefone');

// ── Escopos GRAVADOS na coluna `escopo` ──
const ESCOPO_CAMPANHA = 'campanha';
const ESCOPO_TOTAL = 'total';

// ── Escopos de CONSULTA ──
// 'campanha' e gravavel e consultavel; 'transacional' e SO de consulta — nao existe opt-out
// "de escopo transacional", existe a pergunta "esta pessoa esta bloqueada ate para o
// transacional?", que so `total` responde sim.
const CONSULTA_CAMPANHA = 'campanha';
const CONSULTA_TRANSACIONAL = 'transacional';

// ── Origens ──
const ORIGEM_LINK = 'link'; // clicou no link de descadastro da mensagem
const ORIGEM_RESPOSTA = 'resposta'; // respondeu "SAIR"/"PARAR" no WhatsApp
const ORIGEM_BOTAO = 'botao'; // apertou o botao de opt-out do template
const ORIGEM_MANUAL = 'manual'; // o recrutador registrou pelo painel
const ORIGEM_IMPORTACAO = 'importacao'; // veio de carga de dados

// ══════════════════════════════════════════════════════════════
// A FRONTEIRA CAMPANHA x TRANSACIONAL, POR TIPO DE MENSAGEM
// ══════════════════════════════════════════════════════════════
//
// ── POR QUE POR TIPO, E NAO POR MOTOR ──
// A leitura obvia seria "o motor de campanha e campanha, o motor da sequencia e
// transacional". Ela esta ERRADA em um caso, e o caso importa: `status_candidatura` roda no
// MOTOR DE CAMPANHA (lib/campanhaWhatsapp.js + publicoCampanhaWhatsapp.js) mas e
// transacional por natureza — a mensagem informa a pessoa o resultado da candidatura DELA.
// Suprimi-la por um opt-out de campanha faria alguem que pediu para nao receber ofertas
// nunca mais saber se foi aprovado.
//
// O mesmo arquivo ja documenta a assimetria para a supressao por aprovacao
// (listarPublicoStatusCandidatura "DELIBERADAMENTE nao chama aplicarInvariantes"). Esta
// tabela e a mesma linha divisoria, escrita uma vez so.
//
// A chave e o valor que CADA MOTOR ja carrega por linha, sem consulta nova:
//   campanhas_whatsapp.tipo_mensagem  -> 'convite_grupo' | 'divulgacao_vaga' | 'status_candidatura'
//   whatsapp_sequencia_envios.etapa   -> 'wa1' | 'wa2' | 'reprovacao'
//
// Nao ha refatoracao envolvida: os dois campos ja existem e ja chegam na linha da fila.
//
// ── 'reprovacao' E TRANSACIONAL, apesar do convite de grupo no fim ──
// O texto tem um paragrafo opcional convidando para o grupo da regiao, o que o faz PARECER
// campanha. Nao e: a mensagem existe porque o recrutador tomou uma decisao sobre a
// candidatura DAQUELA pessoa, e nao mandar o resultado de um processo seletivo por causa de
// um opt-out de campanha e pior para ela do que o convite extra. Quem quer silencio total
// tem `total`, que suprime esta tambem.
const ESCOPO_POR_TIPO_MENSAGEM = {
  convite_grupo: CONSULTA_CAMPANHA,
  divulgacao_vaga: CONSULTA_CAMPANHA,
  status_candidatura: CONSULTA_TRANSACIONAL,
  wa1: CONSULTA_TRANSACIONAL,
  wa2: CONSULTA_TRANSACIONAL,
  reprovacao: CONSULTA_TRANSACIONAL,
};

// Escopo de consulta de um tipo de mensagem.
//
// DESCONHECIDO -> 'campanha', que e o escopo MAIS restritivo (bloqueia com qualquer opt-out
// ativo). Um tipo de mensagem novo que ninguem lembrou de classificar aqui nasce suprimido
// para quem pediu silencio, em vez de escapar da supressao por omissao. Esse e o lado
// seguro do erro: no maximo alguem deixa de receber algo, nunca o contrario.
function escopoDoTipoMensagem(tipo) {
  return ESCOPO_POR_TIPO_MENSAGEM[String(tipo || '').trim()] || CONSULTA_CAMPANHA;
}

// ── KILL-SWITCH ──
// Chave em `configuracoes`, mesmo store de promocao_ativa/campanha_whatsapp_ativa. Config de
// BANCO e nao env: precisa ser desligavel pelo painel sem deploy.
const CHAVE_ATIVO = 'optout_whatsapp_ativo';

// Default TRUE — ver P5 no cabecalho. Desligar isto volta a mandar campanha para quem pediu
// para sair, e por isso a tela precisa dizer exatamente isso ao lado do checkbox.
function ativo(deps = {}) {
  const db = deps.db || dbPadrao;
  return db.obterConfigBool(CHAVE_ATIVO, true);
}

// ══════════════════════════════════════════════════════════════
// API que os motores e as rotas usam
// ══════════════════════════════════════════════════════════════

// Registra (ou escala) um opt-out. Delega a idempotencia ao repositorio — ver
// registrarWhatsappOptout em db/sqlite.js para as tres regras.
function registrarOptout({ telefone, escopo = ESCOPO_CAMPANHA, origem = ORIGEM_MANUAL, motivo = null } = {}, deps = {}) {
  const db = deps.db || dbPadrao;
  return db.registrarWhatsappOptout({ telefone, escopo, origem, motivo });
}

// A pessoa esta suprimida para este escopo de consulta?
//
// ── O KILL-SWITCH E CHECADO AQUI, E NAO EM CADA MOTOR ──
// Sao quatro pontos de chamada (dois motores de publico, dois motores de envio). Repetir a
// checagem em cada um seria quatro lugares para alguem esquecer de atualizar; centralizar
// aqui torna "desligar a supressao" um fato unico, verificavel por um teste so.
function estaOptout(telefone, escopo = CONSULTA_CAMPANHA, deps = {}) {
  const db = deps.db || dbPadrao;
  if (!ativo({ db })) return false;
  return db.estaWhatsappOptout(telefone, escopo);
}

// A mesma decisao de estaOptout, mas sobre um mapa ja carregado (ver
// mapaWhatsappOptoutAtivo em db/sqlite.js). Existe para os motores de PUBLICO, que avaliam
// milhares de pessoas por materializacao e nao podem fazer uma consulta por linha.
//
// A regra de escopo mora AQUI e em estaWhatsappOptout, e so nesses dois lugares. Se um dia
// elas divergirem, o sintoma sera o pior possivel — o publico exclui uma pessoa que o envio
// deixa passar, ou o contrario — entao os testes de paridade entre as duas formas de
// consulta existem justamente para travar isso.
function optoutAtivoNoMapa(mapa, telefone, escopo = CONSULTA_CAMPANHA) {
  if (!mapa || !mapa.size) return false;
  const canonico = chaveCanonicaTelefone(telefone);
  if (!canonico) return false;
  const escopoAtivo = mapa.get(canonico);
  if (!escopoAtivo) return false;
  if (escopoAtivo === ESCOPO_TOTAL) return true;
  return escopo === CONSULTA_CAMPANHA;
}

// Mapa de opt-outs ativos, respeitando o kill-switch: desligado devolve mapa VAZIO, e todo
// `optoutAtivoNoMapa` sobre ele responde false sem cada motor precisar saber do interruptor.
function mapaOptoutAtivo(deps = {}) {
  const db = deps.db || dbPadrao;
  if (!ativo({ db })) return new Map();
  return db.mapaWhatsappOptoutAtivo();
}

function revogarOptout(telefone, deps = {}) {
  const db = deps.db || dbPadrao;
  return db.revogarWhatsappOptout(telefone);
}

function listarOptouts(filtros = {}, deps = {}) {
  const db = deps.db || dbPadrao;
  return db.listarWhatsappOptouts(filtros);
}

module.exports = {
  ESCOPO_CAMPANHA,
  ESCOPO_TOTAL,
  CONSULTA_CAMPANHA,
  CONSULTA_TRANSACIONAL,
  ORIGEM_LINK,
  ORIGEM_RESPOSTA,
  ORIGEM_BOTAO,
  ORIGEM_MANUAL,
  ORIGEM_IMPORTACAO,
  ESCOPO_POR_TIPO_MENSAGEM,
  escopoDoTipoMensagem,
  CHAVE_ATIVO,
  ativo,
  registrarOptout,
  estaOptout,
  optoutAtivoNoMapa,
  mapaOptoutAtivo,
  revogarOptout,
  listarOptouts,
  chaveCanonicaTelefone,
};
