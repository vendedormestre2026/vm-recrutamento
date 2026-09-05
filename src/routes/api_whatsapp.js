'use strict';

// API do disparo em massa por WhatsApp. Router proprio montado em /api pelo server.js,
// separado de api.js pelo mesmo criterio do Banco de Curriculos: subsistema independente,
// consumidor diferente.
//
// ── QUEM CHAMA ISTO NAO E UM NAVEGADOR ──
// E o n8n. Essa e a diferenca que molda o arquivo inteiro:
//   - autenticacao por CHAVE DE SERVICO, nao por sessao;
//   - resposta sempre JSON, inclusive nos erros — um redirect para /admin/login, que e o
//     que adminAuth faz, viraria HTML 200 no n8n e um fluxo "bem-sucedido" que nao enviou
//     nada;
//   - erro de entrada e 400 com `erro` legivel, para aparecer no log do n8n em vez de
//     virar exception generica.
//
// ── ESTE E O PRIMEIRO ENDPOINT DE SERVICO DO PROJETO ──
// Nao havia precedente de API key aqui: as duas autenticacoes existentes sao adminAuth
// (cookie de sessao do painel) e o token por candidato de api.js. Nenhuma serve — a
// primeira e de humano com navegador, a segunda tem escopo de uma pessoa so.
//
// A consequencia e que o padrao abaixo VAI SER COPIADO pelo proximo endpoint de servico,
// entao ele esta escrito para ser copiavel: uma funcao, um header, um 401 JSON, e o
// cuidado de comparacao em tempo constante explicado onde acontece.

const express = require('express');
const crypto = require('node:crypto');

const { config } = require('../config');
const db = require('../db');
const { listarCidadesValidas, normalizarCidade } = require('../lib/cidades');
const { listarPendentesPorCidade } = require('../lib/publicoDisparoWhatsapp');
const { normalizarTelefoneRecebido } = require('../lib/whatsapp');
const optout = require('../lib/optoutWhatsapp');

const router = express.Router();

// Status aceitos pelo POST. Espelha o que a tabela guarda; 'pendente' NAO existe aqui, pela
// mesma razao de la — pendente e a ausencia de linha (ver schema.sql).
const STATUS_VALIDOS = ['enviado', 'erro'];

// Teto da mensagem de erro guardada. Mesmo espirito do MAX_ERRO da campanha: a coluna
// existe para alguem entender o que houve, nao para arquivar stack trace do n8n.
const MAX_ERRO_MSG = 300;

// ── Comparacao de chave em tempo constante ──
//
// crypto.timingSafeEqual EXIGE buffers do MESMO tamanho — com tamanhos diferentes ele
// LANCA, e uma excecao nao tratada aqui viraria 500. Pior: a propria excecao seria um canal
// lateral, revelando o comprimento da chave real a quem tentasse tamanhos diferentes.
//
// A saida e comparar HASHES em vez dos valores: sha256 devolve sempre 32 bytes, entao os
// buffers tem tamanho fixo por construcao e o timingSafeEqual sempre roda. O comprimento da
// chave verdadeira deixa de influenciar qualquer coisa observavel.
//
// A alternativa comum — checar `a.length !== b.length` antes e devolver false — vaza
// exatamente essa informacao, e e o erro que este comentario existe para impedir que
// alguem "simplifique" de volta.
function chaveConfere(recebida, esperada) {
  if (!esperada) return false; // sem chave configurada, nada autentica
  const a = crypto.createHash('sha256').update(String(recebida || ''), 'utf8').digest();
  const b = crypto.createHash('sha256').update(String(esperada), 'utf8').digest();
  return crypto.timingSafeEqual(a, b);
}

// Middleware de chave de servico. 401 JSON, nunca redirect.
//
// Com DISPARO_WHATSAPP_API_KEY ausente, TODA requisicao e negada — e nao liberada. Um
// endpoint que devolve a base de telefones inteira nao pode ficar aberto porque alguem
// esqueceu de definir uma variavel; o modo de falha seguro aqui e fechado.
function autenticarServico(req, res, next) {
  const esperada = config.disparoWhatsapp.apiKey;
  if (!esperada) {
    console.error(
      '[disparo-wpp] DISPARO_WHATSAPP_API_KEY ausente: requisicao NEGADA. ' +
        'Defina a variavel para habilitar a API de disparo.',
    );
    return res.status(401).json({ erro: 'API de disparo não configurada no servidor.' });
  }
  if (!chaveConfere(req.get('x-disparo-api-key'), esperada)) {
    return res.status(401).json({ erro: 'Chave de API inválida ou ausente.' });
  }
  return next();
}

router.use(autenticarServico);

// ── GET /api/disparos/pendentes?cidade=Joinville ──
//
// Quem ainda nao recebeu o convite do grupo daquela praca.
// Devolve [{ telefone, nome_primeiro, cargo }] — telefone ja normalizado (so digitos, com
// DDI), pronto para discar.
//
// A LISTA NAO E UMA RESERVA. Duas chamadas seguidas devolvem a mesma pessoa: o que a tira
// da fila e o POST de marcar-status, nao o GET. Isso e proposital — se o GET reservasse,
// uma queda do n8n no meio do fluxo deixaria gente presa num estado que ninguem consegue
// destravar pela API. O preco e que dois fluxos simultaneos sobre a mesma praca mandariam
// duas vezes; a trava contra isso e operacional (rodar um por vez), nao de codigo.
router.get('/disparos/pendentes', async (req, res) => {
  const cidade = req.query.cidade;
  if (!cidade) {
    return res.status(400).json({
      erro: 'Informe a cidade: /api/disparos/pendentes?cidade=Joinville',
      cidades_validas: listarCidadesValidas(),
    });
  }

  let pendentes;
  try {
    pendentes = await listarPendentesPorCidade(cidade);
  } catch (err) {
    // O motor LANCA em cidade invalida de proposito (ver lib/publicoDisparoWhatsapp). Aqui
    // isso vira 400 com a lista de opcoes: quem esta configurando o n8n descobre o valor
    // certo na propria resposta, em vez de num log do servidor.
    return res.status(400).json({ erro: err.message, cidades_validas: listarCidadesValidas() });
  }

  // ── LINK DE DESCADASTRO POR DESTINATARIO (Incremento 5) ──
  //
  // Campo ADITIVO: o n8n ignora chave que nao usa, entao nenhum fluxo existente muda de
  // comportamento por esta linha existir. Ele passa a valer quando o fluxo do n8n colocar
  // `link_descadastro` no texto da mensagem.
  //
  // Este e o UNICO canal de campanha em que o link pode sair hoje sem passar pela Meta: o
  // n8n compoe texto livre, nao template aprovado. Ainda assim respeita o mesmo interruptor
  // dos templates, para o Jean ligar o link em todos os canais de uma vez — e nao descobrir
  // depois que uma metade das campanhas tem link e a outra nao.
  //
  // NUNCA vazio: em qualquer falha vem a linha de texto de fallback (P6).
  const comLink = pendentes.map((p) => ({
    ...p,
    link_descadastro: optout.textoDescadastroPara(p.telefone),
  }));

  return res.json(comLink);
});

// ── POST /api/disparos/marcar-status ──
//
// body: { telefone, status: 'enviado'|'erro', erro_msg?, cidade?, nome?, origem? }
//
// Upsert por telefone. O telefone e normalizado ANTES de gravar, sempre: a coluna e UNIQUE
// e o contrato da tabela e "sempre normalizado". Aceitar o formato cru do n8n aqui criaria
// duas linhas para a mesma pessoa e quebraria a exclusao de pendentes em silencio.
router.post('/disparos/marcar-status', (req, res) => {
  const b = req.body || {};

  // normalizarTelefoneRecebido, e NAO normalizarTelefoneWhatsapp: o n8n devolve o mesmo
  // telefone que o GET entregou — ja normalizado, so digitos, sem '+'. A outra funcao
  // prefixaria 55 de novo, gravaria um numero inexistente, e ninguem sairia da fila.
  const telefone = normalizarTelefoneRecebido(b.telefone);
  if (!telefone) {
    return res.status(400).json({
      erro: 'Telefone ausente ou inválido.',
      recebido: b.telefone === undefined ? null : String(b.telefone).slice(0, 40),
    });
  }

  const status = String(b.status || '').trim().toLowerCase();
  if (!STATUS_VALIDOS.includes(status)) {
    return res.status(400).json({
      erro: `Status inválido: ${JSON.stringify(b.status)}.`,
      status_validos: STATUS_VALIDOS,
    });
  }

  // `cidade` e OPCIONAL e, quando vem, e normalizada — mas nao rejeitada se invalida. E
  // campo de auditoria, nao de decisao: nada no app filtra por ele, e recusar o registro de
  // um disparo que JA ACONTECEU por causa de um rotulo errado seria perder o fato para
  // proteger a etiqueta. Invalida vira null, e o disparo fica registrado.
  const cidade = b.cidade ? normalizarCidade(b.cidade) : null;

  try {
    db.registrarDisparoWhatsapp({
      telefone,
      nome: b.nome ? String(b.nome).trim() : null,
      status,
      erroMsg: b.erro_msg ? String(b.erro_msg).slice(0, MAX_ERRO_MSG) : null,
      origem: b.origem ? String(b.origem).trim() : null,
      cidade,
      // Sem timestamp inventado: quem sabe a hora do envio e quem enviou. Ausente = NULL,
      // igual ao historico importado sem data.
      enviadoEm: status === 'enviado' ? b.enviado_em || new Date().toISOString() : null,
    });
  } catch (err) {
    console.error(`[disparo-wpp] falha ao registrar ${telefone}: ${err.message}`);
    return res.status(500).json({ erro: 'Não foi possível registrar o disparo.' });
  }

  return res.json({ ok: true, telefone, status });
});

module.exports = router;
