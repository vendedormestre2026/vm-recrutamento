'use strict';

// Ciclo de vida do socket unico do WhatsApp (instancia 'jean').
//
// ── AS TRES SITUACOES QUE PARECEM IGUAIS E NAO SAO ──
// `connection.update` com `connection: 'close'` chega em tres casos que exigem respostas
// opostas. Confundi-los e o erro classico de integracao com Baileys:
//
//   401 loggedOut        o numero foi DESPAREADO (alguem saiu pelo celular). A sessao
//                        gravada nao vale mais. Reconectar com ela e inutil e fica em laco.
//                        -> apaga baileys_auth e PARA. So um QR novo resolve.
//   515 restartRequired  parte NORMAL do pareamento: o WhatsApp manda reiniciar o socket
//                        logo apos o QR ser lido. Nao e erro.
//                        -> reconecta IMEDIATO, sem backoff (o backoff aqui atrasaria o
//                           pareamento que esta dando certo).
//   qualquer outro       queda real (rede, servidor, timeout).
//                        -> reconecta com backoff exponencial.
//
// ── O Set `fechando` ──
// Um `close` gerado por NOS (parada do processo, logout deliberado) e indistinguivel de uma
// queda pelo evento. Sem essa marca, desligar o sistema dispararia uma reconexao contra o
// que acabamos de fechar.
//
// ⚠️ NOTA DE FIDELIDADE: o enunciado pede para replicar o Central Whats. Nao tenho acesso a
// esse repositorio; isto foi escrito a partir do contrato publico do Baileys e das regras
// descritas no proprio enunciado (401/515/Set closing/backoff). A equivalencia linha a linha
// com o original NAO pode ser verificada por mim.
//
// ⚠️ NADA AQUI FOI EXERCITADO CONTRA O WHATSAPP REAL. Os testes usam socket falso; o
// pareamento e acao manual, fora deste codigo.

const { DisconnectReason } = require('@whiskeysockets/baileys');

const { criarAuthState, limparAuthState, INSTANCIA_PADRAO } = require('./authState');
const { resolverVersaoWa } = require('./waVersion');

const BACKOFF_BASE_MS = 1000;
const BACKOFF_TETO_MS = 60000;

// Estado do modulo. Socket unico por processo — nao ha caso de dois numeros hoje.
const estado = {
  socket: null,
  status: 'desconectado', // 'desconectado' | 'pareando' | 'conectado'
  qr: null, // string crua do QR, viva SO durante a janela de pareamento
  ultimoErro: null,
  tentativas: 0,
  timerReconexao: null,
  // Quando o status mudou pela ultima vez. O painel mostra isso: "conectado" sem saber
  // desde quando nao diz se a sessao esta viva ou parada ha dois dias.
  atualizadoEm: new Date().toISOString(),
};

// Toda troca de status passa por aqui, para o carimbo nunca ficar para tras. Um campo de
// tempo atualizado em alguns caminhos e nao em outros e pior que campo nenhum.
function definirStatus(novo) {
  if (estado.status === novo) return;
  estado.status = novo;
  estado.atualizadoEm = new Date().toISOString();
}

// Fechamentos iniciados por nos. Ver a nota do cabecalho.
const fechando = new Set();

// statusCode do lastDisconnect, se houver. O Baileys embrulha num Boom.
function statusDeSaida(lastDisconnect) {
  const erro = lastDisconnect && lastDisconnect.error;
  return (erro && erro.output && erro.output.statusCode) || null;
}

// Reconectar? NAO apenas quando o numero foi despareado (401). Em todo o resto, sim —
// inclusive erro desconhecido: ficar offline por um codigo que ninguem previu e pior que
// tentar de novo.
function shouldReconnect(lastDisconnect) {
  return statusDeSaida(lastDisconnect) !== DisconnectReason.loggedOut;
}

// 515 e reinicio pedido pelo proprio protocolo, nao falha.
function isRestartRequired(lastDisconnect) {
  return statusDeSaida(lastDisconnect) === DisconnectReason.restartRequired;
}

// Exponencial com teto. Zerado no `open` e no 515 — os dois significam "o caminho esta
// funcionando", e manter o contador ali faria a proxima queda legitima comecar ja atrasada.
function atrasoBackoff(tentativas) {
  return Math.min(BACKOFF_BASE_MS * 2 ** Math.max(0, tentativas - 1), BACKOFF_TETO_MS);
}

function ligado() {
  return String(process.env.WHATSAPP_BAILEYS_ATIVO || '').toLowerCase() === 'true';
}

function status() {
  return {
    status: estado.status,
    atualizadoEm: estado.atualizadoEm,
    temQr: Boolean(estado.qr),
    tentativas: estado.tentativas,
    ultimoErro: estado.ultimoErro,
    ligado: ligado(),
    instancia: INSTANCIA_PADRAO,
  };
}

// O QR so existe entre "pareando" e o desfecho. Apagado em QUALQUER fechamento — conectado,
// deslogado ou caido. Um QR velho na tela e pior que nenhum: quem escaneia espera funcionar.
function limparQr() {
  estado.qr = null;
}

function qrAtual() {
  return estado.qr;
}

// Trata um evento connection.update. Extraida do listener para ser testavel sem socket real.
//
// `deps.reconectar` e injetado pelo teste para observar a decisao sem de fato reabrir nada.
function tratarUpdate(update, deps = {}) {
  const reconectar = deps.reconectar || agendarReconexao;
  const limpar = deps.limparAuth || limparAuthState;

  if (update.qr) {
    estado.qr = update.qr;
    definirStatus('pareando');
    console.log('[wa-conn] QR disponivel para pareamento (janela aberta).');
  }

  if (update.connection === 'open') {
    definirStatus('conectado');
    estado.tentativas = 0; // caminho funcionando: zera
    estado.ultimoErro = null;
    limparQr();
    console.log('[wa-conn] conectado.');
    return { acao: 'conectado' };
  }

  if (update.connection !== 'close') return { acao: 'nenhuma' };

  limparQr();
  const code = statusDeSaida(update.lastDisconnect);
  estado.ultimoErro = code === null ? 'close sem statusCode' : `statusCode ${code}`;

  // Fechamento nosso: nao e queda.
  if (fechando.has(INSTANCIA_PADRAO)) {
    fechando.delete(INSTANCIA_PADRAO);
    definirStatus('desconectado');
    console.log('[wa-conn] fechado por nos; sem reconexao.');
    return { acao: 'fechado_por_nos' };
  }

  // 401: despareado de verdade. Insistir com a credencial morta e laco infinito.
  if (!shouldReconnect(update.lastDisconnect)) {
    definirStatus('desconectado');
    const apagadas = limpar();
    console.error(
      `[wa-conn] ================ NUMERO DESPAREADO (401) ================\n` +
        `[wa-conn] A sessao foi encerrada pelo celular. ${apagadas} chave(s) apagadas de ` +
        'baileys_auth. Nenhuma mensagem sai ate alguem parear de novo pelo QR em ' +
        '/admin/whatsapp.',
    );
    return { acao: 'logout' };
  }

  // 515: parte normal do pareamento. Reconecta ja, sem penalidade.
  if (isRestartRequired(update.lastDisconnect)) {
    estado.tentativas = 0;
    definirStatus('pareando');
    console.log('[wa-conn] restart pedido pelo protocolo (515); reconectando imediatamente.');
    reconectar(0);
    return { acao: 'restart', atraso: 0 };
  }

  // Queda real.
  definirStatus('desconectado');
  estado.tentativas += 1;
  const atraso = atrasoBackoff(estado.tentativas);
  console.warn(`[wa-conn] queda (${estado.ultimoErro}); reconectando em ${atraso} ms (tentativa ${estado.tentativas}).`);
  reconectar(atraso);
  return { acao: 'reconectar', atraso };
}

function agendarReconexao(atrasoMs) {
  if (estado.timerReconexao) clearTimeout(estado.timerReconexao);
  estado.timerReconexao = setTimeout(() => {
    estado.timerReconexao = null;
    void conectar();
  }, atrasoMs);
  // unref: um timer pendente nao pode segurar o processo vivo no shutdown.
  if (estado.timerReconexao.unref) estado.timerReconexao.unref();
}

// Abre o socket. NAO faz nada se WHATSAPP_BAILEYS_ATIVO nao for 'true' — e o primeiro dos
// dois kill-switches, e o default e desligado: todo o resto do sistema funciona sem isto.
//
// `deps.criarSocket` injetavel: os testes passam um socket falso e NUNCA tocam o WhatsApp.
async function conectar(deps = {}) {
  if (!ligado()) {
    console.log('[wa-conn] WHATSAPP_BAILEYS_ATIVO != true; conexao nao iniciada.');
    return null;
  }
  if (estado.socket) return estado.socket;

  const { version, origem } = await resolverVersaoWa();
  console.log(`[wa-conn] abrindo socket com versao ${version.join('.')} (${origem}).`);

  const { state, saveCreds } = criarAuthState();
  const criarSocket = deps.criarSocket || require('@whiskeysockets/baileys').default;

  const socket = criarSocket({ version, auth: state, printQRInTerminal: false });
  estado.socket = socket;

  socket.ev.on('creds.update', saveCreds);
  socket.ev.on('connection.update', (u) => {
    const r = tratarUpdate(u);
    // Socket morto depois de close: a proxima conexao cria outro.
    if (r.acao !== 'nenhuma' && u.connection === 'close') estado.socket = null;
  });

  return socket;
}

// Fechamento deliberado. Marca no Set ANTES de fechar, para o listener nao reconectar.
async function desconectar() {
  fechando.add(INSTANCIA_PADRAO);
  limparQr();
  if (estado.timerReconexao) {
    clearTimeout(estado.timerReconexao);
    estado.timerReconexao = null;
  }
  const s = estado.socket;
  estado.socket = null;
  definirStatus('desconectado');
  try {
    if (s && typeof s.end === 'function') s.end();
  } catch (err) {
    console.warn(`[wa-conn] erro ao fechar socket (ignorado): ${err.message}`);
  }
}

// So para teste.
function _resetar() {
  estado.socket = null;
  estado.status = 'desconectado';
  estado.atualizadoEm = new Date().toISOString();
  estado.qr = null;
  estado.ultimoErro = null;
  estado.tentativas = 0;
  if (estado.timerReconexao) clearTimeout(estado.timerReconexao);
  estado.timerReconexao = null;
  fechando.clear();
}

module.exports = {
  conectar,
  desconectar,
  status,
  qrAtual,
  limparQr,
  tratarUpdate,
  shouldReconnect,
  isRestartRequired,
  atrasoBackoff,
  ligado,
  fechando,
  _resetar,
  BACKOFF_BASE_MS,
  BACKOFF_TETO_MS,
};
