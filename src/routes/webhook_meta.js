'use strict';

// Webhook da Meta Cloud API. Rota PUBLICA (a Meta chama de fora), montada em /webhook.
//
// ── DUAS RESPONSABILIDADES ──
//   GET   handshake de verificacao, uma vez, ao cadastrar a URL no painel da Meta.
//   POST  eventos: status de entrega/leitura e mensagens recebidas.
//
// ── A ASSINATURA EXIGE O CORPO CRU ──
// X-Hub-Signature-256 e HMAC-SHA256 sobre os BYTES do corpo. Depois do express.json() o
// objeto ja foi parseado, e re-serializar com JSON.stringify NAO reproduz os bytes originais
// (ordem de chaves, espacos, escapes unicode). Por isso o parser desta rota guarda o buffer
// cru no `verify` — e SO desta rota, sem tocar no express.json() global do server.js.
//
// ── PUBLICA, ENTAO A ASSINATURA E A UNICA PORTA ──
// Nao ha adminAuth nem chave de servico aqui: quem chama e a Meta. Assinatura invalida ou
// ausente = 401, sem exceção. Um webhook que aceita corpo nao assinado e um endpoint que
// qualquer um usa para marcar mensagens como entregues e cadastrar opt-out alheio.

const express = require('express');
const crypto = require('node:crypto');

const db = require('../db');
const { normalizarTelefoneRecebido } = require('../lib/whatsapp');
const { mascarar } = require('../whatsapp/sequenciaOutbox');

const router = express.Router();

// ── DECISAO: OPT-OUT POR PALAVRA-CHAVE, e nao por qualquer resposta ──
//
// Na ausencia de instrucao, esta e a escolha CONSERVADORA — e conservador aqui significa
// "nao descadastrar quem nao pediu". Uma campanha que convida para um grupo naturalmente
// gera respostas do tipo "obrigado", "qual o horario?", "ainda tem vaga?". Tratar cada uma
// dessas como opt-out removeria da base exatamente as pessoas MAIS interessadas.
//
// O risco do outro lado existe e esta registrado: alguem escreve "não quero mais receber"
// (frase que contem "quero", nao a palavra exata) e continua na base. Por isso a lista
// abaixo cobre as formas mais comuns, e a comparacao ignora acento, caixa e pontuacao.
//
// ⚠️ ESTA DECISAO PRECISA DE CONFIRMACAO HUMANA. Se a resposta for "qualquer resposta e
// opt-out", a mudanca e trocar a condicao em processarMensagemRecebida por `true`.
const PALAVRAS_OPT_OUT = ['parar', 'sair', 'pare', 'stop', 'cancelar', 'descadastrar', 'remover', 'nao quero'];

function normalizarTexto(t) {
  return String(t || '')
    .trim()
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[.!?,;]/g, '')
    .replace(/\s+/g, ' ');
}

// A mensagem PEDE para sair?
//
// Casa a mensagem INTEIRA (ou o inicio dela), e nao "contem a palavra": "não posso parar de
// agradecer" contem "parar" e nao e opt-out. Mensagem curta com a palavra e o caso real.
function pedeOptOut(texto) {
  const t = normalizarTexto(texto);
  if (!t) return false;
  return PALAVRAS_OPT_OUT.some((p) => t === p || t.startsWith(`${p} `) || t === `${p}!`);
}

// Assinatura em tempo constante. Compara HASHES para os buffers terem sempre o mesmo
// tamanho — timingSafeEqual LANCA com tamanhos diferentes, e a excecao seria canal lateral.
// Mesmo padrao ja usado em routes/api_whatsapp.
function assinaturaConfere(corpoCru, cabecalho, segredo) {
  if (!segredo || !cabecalho || !corpoCru) return false;
  const esperado = `sha256=${crypto.createHmac('sha256', segredo).update(corpoCru).digest('hex')}`;
  const a = crypto.createHash('sha256').update(String(cabecalho)).digest();
  const b = crypto.createHash('sha256').update(esperado).digest();
  return crypto.timingSafeEqual(a, b);
}

// Parser SO desta rota, guardando o corpo cru. O express.json() global do server.js nao e
// tocado.
const parserComCru = express.json({
  limit: '1mb',
  verify: (req, res, buf) => {
    req.corpoCru = buf;
  },
});

// ── GET /webhook/whatsapp-meta ── handshake ──
//
// A Meta chama uma vez, ao cadastrar a URL, com hub.mode/hub.verify_token/hub.challenge.
// Resposta tem que ser o challenge em TEXTO PURO — JSON aqui faz o cadastro falhar com uma
// mensagem que nao explica nada.
router.get('/whatsapp-meta', (req, res) => {
  const esperado = String(process.env.META_WEBHOOK_VERIFY_TOKEN || '');
  const modo = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  if (!esperado) {
    console.error('[webhook-meta] META_WEBHOOK_VERIFY_TOKEN ausente: handshake NEGADO.');
    return res.sendStatus(403);
  }
  if (modo === 'subscribe' && token === esperado) {
    console.log('[webhook-meta] handshake verificado.');
    return res.type('text/plain').send(String(challenge == null ? '' : challenge));
  }
  console.warn('[webhook-meta] handshake com token invalido; negado.');
  return res.sendStatus(403);
});

// ── POST /webhook/whatsapp-meta ── eventos ──
router.post('/whatsapp-meta', parserComCru, (req, res) => {
  const segredo = String(process.env.META_APP_SECRET || '');
  if (!segredo) {
    // Falha FECHADA: sem segredo nao ha como validar nada, e aceitar seria abrir o endpoint.
    console.error('[webhook-meta] META_APP_SECRET ausente: requisicao NEGADA.');
    return res.status(401).json({ erro: 'Webhook não configurado.' });
  }
  if (!assinaturaConfere(req.corpoCru, req.get('x-hub-signature-256'), segredo)) {
    console.warn('[webhook-meta] assinatura invalida; requisicao negada.');
    return res.status(401).json({ erro: 'Assinatura inválida.' });
  }

  // ── 200 SEMPRE, depois da assinatura ──
  // A Meta REENVIA o evento quando nao recebe 2xx, e um erro nosso de processamento viraria
  // uma tempestade de reentregas do mesmo evento. Respondemos e processamos; o que falhar
  // fica no log.
  try {
    processarEventos(req.body);
  } catch (err) {
    console.error(`[webhook-meta] falha ao processar evento (200 devolvido mesmo assim): ${err.message}`);
  }
  return res.sendStatus(200);
});

// Mapa do status da Meta para o nosso.
const MAPA_STATUS = { sent: 'enviado', delivered: 'entregue', read: 'lido', failed: 'falha' };

function processarEventos(corpo) {
  const entradas = (corpo && corpo.entry) || [];
  for (const entrada of entradas) {
    for (const mudanca of entrada.changes || []) {
      const valor = (mudanca && mudanca.value) || {};
      for (const st of valor.statuses || []) processarStatus(st);
      for (const msg of valor.messages || []) processarMensagemRecebida(msg);
    }
  }
}

// (a) Status de entrega/leitura, casado pelo wamid.
function processarStatus(st) {
  const wamid = st && st.id;
  const novo = MAPA_STATUS[st && st.status];
  if (!wamid || !novo) return;
  const erro = Array.isArray(st.errors) && st.errors.length ? JSON.stringify(st.errors[0]).slice(0, 300) : null;
  const mudou = db.atualizarStatusPorWamid(wamid, novo, erro);
  if (mudou) console.log(`[webhook-meta] ${wamid} -> ${novo}`);
}

// (b) Mensagem recebida. Ver a decisao de opt-out por palavra-chave no topo do arquivo.
function processarMensagemRecebida(msg) {
  const de = msg && msg.from;
  const texto = (msg && msg.text && msg.text.body) || '';
  if (!de) return;

  const telefone = normalizarTelefoneRecebido(de);
  if (!telefone) {
    console.warn('[webhook-meta] mensagem recebida com telefone inutilizavel; ignorada.');
    return;
  }

  if (!pedeOptOut(texto)) {
    // Resposta comum. NAO e opt-out — ver a nota do topo. Registramos so no log, porque hoje
    // nao ha caixa de entrada no painel: a conversa continua no aparelho do Jean.
    console.log(`[webhook-meta] resposta de ${mascarar(telefone)} (nao e opt-out).`);
    return;
  }

  const criou = db.registrarOptOutWhatsapp(telefone, 'resposta_webhook');
  console.log(
    `[webhook-meta] OPT-OUT de ${mascarar(telefone)} ${criou ? 'registrado' : '(ja existia)'} ` +
      `— palavra-chave reconhecida.`,
  );
}

module.exports = { router, pedeOptOut, assinaturaConfere, PALAVRAS_OPT_OUT, processarEventos };
