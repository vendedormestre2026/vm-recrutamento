'use strict';

// Classificacao das mensagens RECEBIDAS pelo Baileys: o que fazer com cada uma.
//
// Funcao PURA. Recebe o evento `messages.upsert` como o Baileys entrega e devolve uma decisao por
// mensagem. Nao grava nada, nao fala com o socket, nao le o relogio (o instante do boot entra por
// parametro) — quem age sobre as decisoes e whatsapp/connection.
//
// ══════════════════════════════════════════════════════════════
// ATE AQUI O PROJETO NAO LIA MENSAGEM DE ENTRADA NENHUMA
// ══════════════════════════════════════════════════════════════
//
// O socket registrava so `creds.update` e `connection.update`. Quem respondia "PARAR" a uma
// campanha aparecia no aparelho do Jean e alguem tinha que registrar o opt-out A MAO — o que,
// na pratica, quase nunca acontece. Isto fecha esse buraco para o disparo em massa, cuja mensagem
// TERMINA pedindo "responda SAIR": prometer um canal de saida e nao ler as respostas e a forma mais
// rapida de acumular denuncia, e denuncia e o que bloqueia o numero.
//
// ══════════════════════════════════════════════════════════════
// ⚠️ A ARMADILHA QUE DECIDE SE ISTO E SEGURO: O HISTORICO
// ══════════════════════════════════════════════════════════════
//
// Ao parear (ou reconectar), o Baileys despeja conversas ANTIGAS no MESMO evento `messages.upsert`.
// Agir sobre esse despejo registraria opt-out em massa a partir de mensagens de meses atras —
// gente que escreveu "cancelar" sobre outra coisa, ou que resolveu o assunto e voltou ao processo.
// Seria um apagao silencioso da base, feito por nos.
//
// Duas travas, e as duas sao necessarias:
//   1. `type` tem que ser 'notify'. O despejo de historico vem como 'append'.
//   2. o timestamp da mensagem tem que ser >= o instante do BOOT do processo. Historico pode vir
//      marcado como 'notify' em algumas versoes, e o timestamp e o que nao mente.
//
// O custo dessas travas e perder um "SAIR" que chegou enquanto o processo estava fora do ar. E o
// lado certo do erro: a pessoa continua recebendo (e pode responder de novo), em vez de centenas de
// pessoas sairem sem ter pedido.
//
// ══════════════════════════════════════════════════════════════
// O ESCOPO E SEMPRE `campanha`, NUNCA `total`
// ══════════════════════════════════════════════════════════════
//
// Quem responde "SAIR" a uma divulgacao esta dizendo "parem de me oferecer vagas". Presumir que
// tambem quer perder o resultado de uma candidatura futura (WA1/WA2) seria interpretar demais —
// e travaria o processo seletivo de quem so queria menos propaganda. Ver P1 no cabecalho de
// lib/optoutWhatsapp.

const { pedeSaida } = require('./pedidoSaidaWhatsapp');
const { normalizarTelefoneRecebido } = require('./whatsapp');

// ══════════════════════════════════════════════════════════════
// A CAPTURA TEM INTERRUPTOR PROPRIO, E ELE NASCE DESLIGADO
// ══════════════════════════════════════════════════════════════
//
// Chave no store `configuracoes`, no mesmo padrao de whatsapp_sequencia_ativa e massa_wa_ativa.
// A CONSTANTE mora aqui (junto das regras da feature, modulo folha); a LEITURA do banco mora em
// whatsapp/connection, que e quem tem o socket e o db.
//
// ── POR QUE NAO BASTAVA O INTERRUPTOR DA CAMPANHA ──
// O listener e registrado no `conectar()`, guardado SO por WHATSAPP_BAILEYS_ATIVO — que em producao
// ja esta ligado. Sem uma chave propria, o simples deploy deste codigo faria o sistema comecar a
// gravar opt-out a partir de respostas de WhatsApp, sem ninguem ter ligado nada. Um comportamento
// novo que escreve na base nao pode chegar como efeito colateral de um deploy.
//
// Default FALSE, e a leitura acontece ANTES de qualquer classificacao ou gravacao: com a chave
// desligada, uma mensagem recebida nao e nem olhada.
const CHAVE_CAPTURA_ATIVA = 'wa_captura_saida_ativa';

// ══════════════════════════════════════════════════════════════
// O "SAIR" SO VALE PARA QUEM RECEBEU DISPARO EM MASSA RECENTE
// ══════════════════════════════════════════════════════════════
//
// O listener le TODA mensagem que chega ao numero — inclusive de quem esta apenas no fluxo
// transacional (WA1/WA2) e nunca recebeu campanha. Um "sair" dessa pessoa quase sempre significa
// "quero sair do processo seletivo", nao "parem de me oferecer vagas". Registrar opt-out de campanha
// ali responde a pergunta errada: ela continua recebendo as mensagens do processo (que e o que a
// incomodava) e perde as divulgacoes (que ela nem citou).
//
// Entao a captura so age quando existe, para aquele telefone canonico, um envio em massa NOSSO nos
// ultimos JANELA_MASSA_DIAS dias — ou seja, quando ha uma mensagem a que o "sair" plausivelmente
// responde. Quem nao tem: apenas um log mascarado, e o pedido segue como antes (alguem registra a
// mao em /admin/optouts, que e o caminho que sempre existiu).
//
// 7 dias e uma constante de negocio, facil de ajustar: cobre com folga o intervalo entre receber a
// mensagem e responder (a maioria responde em minutos ou horas), sem transformar um "sair" de
// semanas depois — provavelmente sobre outra coisa — num opt-out.
const JANELA_MASSA_DIAS = 7;

// Decisoes possiveis.
const ACAO_OPTOUT = 'optout';
const DESCARTE_TIPO = 'tipo_nao_notify';
const DESCARTE_HISTORICO = 'anterior_ao_boot';
const DESCARTE_FROM_ME = 'enviada_por_nos';
const DESCARTE_GRUPO = 'grupo';
const DESCARTE_LID = 'jid_lid';
const DESCARTE_JID = 'jid_desconhecido';
const DESCARTE_SEM_TEXTO = 'sem_texto';
const DESCARTE_TELEFONE = 'telefone_invalido';
const DESCARTE_NAO_PEDE_SAIDA = 'nao_pede_saida';

// Sufixos de JID que o WhatsApp usa.
const SUFIXO_INDIVIDUAL = '@s.whatsapp.net';
const SUFIXO_GRUPO = '@g.us';
// ── @lid: TRATADO EXPLICITAMENTE, E DESCARTADO ──
// Versoes recentes do Baileys entregam, em alguns casos, um "linked id" (@lid) em vez do numero.
// Ele e um identificador de privacidade: NAO e o telefone, e nao ha como derivar o telefone dele
// sem uma consulta extra. Registrar opt-out a partir de um @lid gravaria uma chave canonica que nao
// corresponde a pessoa nenhuma — um opt-out que nao suprime ninguem e pior que nenhum, porque
// parece ter funcionado. Descartado com motivo proprio para APARECER no log.
const SUFIXO_LID = '@lid';

// Texto de uma mensagem, nas duas formas que interessam aqui.
//
// So mensagem de TEXTO. Audio, imagem, sticker e localizacao nao tem como pedir saida, e tentar
// interpretar legenda de imagem abriria a porta para falso positivo sem ganho nenhum.
function textoDaMensagem(mensagem) {
  const m = (mensagem && mensagem.message) || {};
  if (typeof m.conversation === 'string' && m.conversation.trim()) return m.conversation;
  const estendida = m.extendedTextMessage;
  if (estendida && typeof estendida.text === 'string' && estendida.text.trim()) return estendida.text;
  return '';
}

// `messageTimestamp` chega como number (segundos) ou como Long do protobuf. As duas formas em
// producao, dependendo da versao — e um `Number(objeto)` viraria NaN, que compararia falso com
// tudo e deixaria TODO historico passar pela trava do boot.
function timestampMs(mensagem) {
  const ts = mensagem && mensagem.messageTimestamp;
  if (ts == null) return null;
  if (typeof ts === 'number') return ts * 1000;
  if (typeof ts === 'string' && ts.trim() && Number.isFinite(Number(ts))) return Number(ts) * 1000;
  if (typeof ts.toNumber === 'function') {
    const n = ts.toNumber();
    return Number.isFinite(n) ? n * 1000 : null;
  }
  if (typeof ts.low === 'number') return ts.low * 1000;
  return null;
}

// Classifica UMA mensagem.
function classificarMensagem(mensagem, { bootEm } = {}) {
  const chave = (mensagem && mensagem.key) || {};
  const jid = String(chave.remoteJid || '');
  const base = { jid, telefone: null, texto: '' };

  // Nossa propria mensagem volta no evento. Se ela fosse avaliada, o "responda SAIR" que NOS
  // escrevemos na campanha seria lido como um pedido de saida — e a campanha descadastraria a base
  // inteira, um destinatario por vez.
  if (chave.fromMe) return { ...base, decisao: DESCARTE_FROM_ME };

  if (jid.endsWith(SUFIXO_GRUPO)) return { ...base, decisao: DESCARTE_GRUPO };
  if (jid.endsWith(SUFIXO_LID)) return { ...base, decisao: DESCARTE_LID };
  if (!jid.endsWith(SUFIXO_INDIVIDUAL)) return { ...base, decisao: DESCARTE_JID };

  // A trava do historico. `null` (timestamp ausente ou ilegivel) tambem e DESCARTADO: sem saber
  // quando a mensagem chegou, nao ha como afirmar que ela e nova.
  const quando = timestampMs(mensagem);
  if (bootEm != null && (quando == null || quando < bootEm)) {
    return { ...base, decisao: DESCARTE_HISTORICO, quando };
  }

  const texto = textoDaMensagem(mensagem);
  if (!texto) return { ...base, decisao: DESCARTE_SEM_TEXTO };

  const telefone = normalizarTelefoneRecebido(jid.split('@')[0].replace(/\D/g, ''));
  if (!telefone) return { ...base, texto, decisao: DESCARTE_TELEFONE };

  // A heuristica das 4 regras (curta, palavra exata, negacao derruba, contexto alheio derruba)
  // mora em lib/pedidoSaidaWhatsapp e e a MESMA que o webhook da Meta usaria. Nao ha copia aqui.
  if (!pedeSaida(texto)) return { ...base, telefone, texto, decisao: DESCARTE_NAO_PEDE_SAIDA };

  return { ...base, telefone, texto, decisao: ACAO_OPTOUT };
}

// Classifica o evento inteiro. Devolve uma decisao por mensagem, na ordem recebida.
//
// NUNCA LANCA: a entrada vem de uma biblioteca externa sobre um socket, e um formato inesperado nao
// pode derrubar o listener (que derrubaria a conexao inteira).
function classificarUpsert(evento, { bootEm = null } = {}) {
  const tipo = String((evento && evento.type) || '');
  const mensagens = Array.isArray(evento && evento.messages) ? evento.messages : [];

  // Trava 1: so 'notify'. 'append' e o despejo de historico do pareamento.
  if (tipo !== 'notify') {
    return mensagens.map(() => ({ decisao: DESCARTE_TIPO, jid: '', telefone: null, texto: '' }));
  }

  return mensagens.map((m) => {
    try {
      return classificarMensagem(m, { bootEm });
    } catch {
      return { decisao: DESCARTE_JID, jid: '', telefone: null, texto: '' };
    }
  });
}

module.exports = {
  CHAVE_CAPTURA_ATIVA,
  JANELA_MASSA_DIAS,
  classificarUpsert,
  classificarMensagem,
  textoDaMensagem,
  timestampMs,
  ACAO_OPTOUT,
  DESCARTE_TIPO,
  DESCARTE_HISTORICO,
  DESCARTE_FROM_ME,
  DESCARTE_GRUPO,
  DESCARTE_LID,
  DESCARTE_JID,
  DESCARTE_SEM_TEXTO,
  DESCARTE_TELEFONE,
  DESCARTE_NAO_PEDE_SAIDA,
  SUFIXO_INDIVIDUAL,
  SUFIXO_GRUPO,
  SUFIXO_LID,
};
