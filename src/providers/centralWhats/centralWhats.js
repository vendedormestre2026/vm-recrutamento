'use strict';

// Transporte de TEMPLATE via Central Whats.
//
// ── POR QUE UM MODULO NOVO, E NAO UMA EDICAO DO whatsappMeta/metaWhatsapp.js ──
// Os dois falam com servicos diferentes, com contratos que nao se parecem: la e
// `messaging_product` + array de `components` posicionais; aqui e `vars` como mapa flat. Um
// modulo so, com um `if transporte === ...`, teria que manter as duas montagens vivas para
// sempre e escolher uma em tempo de execucao — e a escolha nao existe: hoje ha UM transporte.
// O adaptador antigo fica DORMENTE no repositorio (ver o cabecalho dele), sem nenhum
// importador, porque a Graph API direta e um caminho ao qual pode ser preciso voltar, e
// reconstruir do zero custa mais do que manter um arquivo parado.
//
// ── O QUE MUDA E O QUE NAO MUDA ──
// NAO muda nada de quem decide QUEM recebe: segmentacao, materializacao da fila, throttle,
// retry, teto por ciclo e kill-switch continuam inteiros em lib/campanhaWhatsapp.js. Este
// modulo so troca o destino do POST e o formato do corpo.
//
// ── O QUE SE PERDE, POR DECISAO ──
// Nao ha webhook chegando aqui. Sem status de entrega automatico e sem opt-out automatico:
// se um candidato responder "PARAR", isso aparece no Live Chat do Central Whats e alguem
// registra o opt-out A MAO. A tabela whatsapp_opt_out continua sendo consultada a cada envio
// — o que sumiu foi a escrita automatica nela, nao a leitura.
//
//   enviarTemplate({ telefone, template, variaveis, httpClient }) -> { wamid, mock }
// LANCA em qualquer falha. O chamador (o job) classifica com classificarErroCentralWhats e
// decide entre retentar, desistir ou abortar o ciclo.

const { mascarar } = require('../../whatsapp/sequenciaOutbox');

// Recorte do corpo de erro guardado. Mesmo numero e mesma razao dos outros adaptadores: a
// coluna `erro` existe para alguem entender o que houve, nao para arquivar JSON inteiro.
const MAX_DETALHE_ERRO = 300;

function cfg() {
  return {
    // Sem barra no fim: a URL e montada com '/api/...' logo em seguida, e '//' no caminho ja
    // rendeu 404 em provedor demais para confiar que este vai perdoar.
    baseUrl: String(process.env.CENTRALWHATS_BASE_URL || '').trim().replace(/\/+$/, ''),
    instanceId: String(process.env.CENTRALWHATS_INSTANCE_ID || '').trim(),
    apiKey: String(process.env.CENTRALWHATS_API_KEY || '').trim(),
  };
}

// ── MOCK E O DEFAULT, e a ausencia da variavel NAO pode significar "pode enviar" ──
//
// A variavel continua se chamando META_CAMPANHA_MOCK mesmo agora que a chamada nao vai
// direto para a Meta. Ela sempre foi sobre a INTENCAO de simular o disparo, nao sobre o
// transporte, e renomear um kill-switch que ja esta em producao abriria uma janela em que o
// nome antigo nao vale mais e o novo ainda nao foi criado no Railway — nessa janela o default
// seria "pode enviar" para uma base inteira.
function modoMock() {
  return String(process.env.META_CAMPANHA_MOCK || 'true').toLowerCase() !== 'false';
}

// FONTE UNICA de "o que falta para a campanha poder sair". Mesmo contrato das funcoes de
// mesmo nome nos adaptadores de e-mail: devolve NOMES de variaveis ausentes.
function credenciaisFaltando() {
  const c = cfg();
  const faltando = [];
  if (!c.baseUrl) faltando.push('CENTRALWHATS_BASE_URL');
  if (!c.instanceId) faltando.push('CENTRALWHATS_INSTANCE_ID');
  if (!c.apiKey) faltando.push('CENTRALWHATS_API_KEY');
  return faltando;
}

// id deterministico para o modo mock.
//
// DETERMINISTICO e nao aleatorio: o mesmo destinatario na mesma campanha produz o mesmo id,
// entao rodar o ciclo duas vezes em mock nao inventa duas mensagens diferentes. E o prefixo
// 'mock-' e obrigatorio — um id que se pareca com o de verdade acabaria casando com um
// registro real do Central Whats um dia.
function wamidMock(telefone, nomeTemplate) {
  const base = `${telefone}|${nomeTemplate}`;
  let h = 0;
  for (let i = 0; i < base.length; i += 1) h = (h * 31 + base.charCodeAt(i)) >>> 0;
  return `mock-${h.toString(36)}`;
}

// Monta o corpo da chamada. Extraido para ser testavel sem rede e sem mock.
//
// `vars` e um mapa FLAT de strings, e nao o array de components da Graph API. As chaves "1",
// "2", "3" sao as variaveis posicionais do corpo, na MESMA ordem que o job ja resolve — o
// {{n}} do template aprovado. Quem traduz posicao -> chave e este modulo; o job continua
// entregando um array.
function montarPayload({ telefone, template, variaveis }) {
  const vars = {};
  (variaveis || []).forEach((v, i) => {
    vars[String(i + 1)] = String(v == null ? '' : v);
  });

  // ── BOTAO ESTRUTURAL ──
  // Botão estrutural do template, exigido pela Graph API mesmo sem uso funcional — o botão
  // aponta para uma URL base incorreta cadastrada na Meta (business.facebook.com em vez de
  // chat.whatsapp.com) e não pode mais ser editado. O link real do grupo vai no corpo da
  // mensagem (variável 3), não no botão. Valor fixo 'indisponivel' satisfaz a exigência de
  // formato da API sem ter função.
  //
  // A exigencia nao sumiu com a troca de transporte: quem fala com a Graph API agora e o
  // Central Whats, e a Meta cobra o parametro do mesmo jeito. O que mudou foi so a FORMA —
  // era um componente {type:'button', sub_type:'url', index:'0'}, agora e a chave "button0"
  // dentro de vars. A FONTE do dado continua templates_whatsapp.botao_parametro_fixo.
  //
  // VAZIO/NULL = template SEM botao -> a chave nem aparece. Mandar botao para um template que
  // nao tem e recusado com a mesma dureza com que a Meta cobra o que falta, entao o default
  // tem que ser "nao manda".
  const parametroBotao = String((template && template.botao_parametro_fixo) || '').trim();
  if (parametroBotao) vars.button0 = parametroBotao;

  // ── LANGUAGE (ETAPA B, Incremento 14) ──
  //
  // ATE AQUI o payload nao mandava idioma nenhum, de proposito — o comentario que morava
  // aqui dizia "o Central Whats resolve pelo template sincronizado la". Um envio real de
  // teste (nova_vaga_v2, ETAPA A) provou esse pressuposto ERRADO: o Central Whats recusou
  // com HTTP 400 — `{"error":"Template \"nova_vaga_v2\" nao sincronizado. Informe o idioma
  // ou rode o sync."}` — pedindo explicitamente por idioma. O nome do template chegou
  // correto (ecoado de volta na mensagem, sem reclamar dele), entao o problema era so isto.
  //
  // ⚠️ NOME DO CAMPO — SUPOSICAO DOCUMENTADA, NAO CONFIRMADA: nao ha documentacao do
  // contrato do Central Whats neste repositorio nem em lugar nenhum que a sessao de
  // diagnostico encontrou, e a mensagem de erro nao da o nome do campo, so pede "o idioma".
  // Usamos `language` DENTRO de `template` (e nao no nivel raiz do payload) por dois
  // motivos: (1) e a mesma posicao e o mesmo nome que a Graph API oficial da Meta usa
  // (`template.language.code` — ver providers/whatsappMeta/metaWhatsapp.js:132, o adaptador
  // dormente que fala direto com ela), e o Central Whats e um proxy na frente da Graph API;
  // (2) e o proprio local onde a IDENTIDADE do template (nome) ja mora neste payload. Se
  // isto se provar errado (nome de campo diferente, ou valor esperado como objeto
  // `{code:'pt_BR'}` em vez de string plana), o sintoma vai ser o MESMO tipo de erro 400
  // "nao sincronizado" continuando a aparecer mesmo com language presente — reabra este
  // comentario antes de tentar de novo.
  //
  // Fonte do valor: templates_whatsapp.idioma (coluna NOT NULL, ja lida pelos dois pontos
  // que chamam enviarTemplate — o job, em lib/campanhaWhatsapp.js, e a rota de envio avulso,
  // em routes/admin_campanha_whatsapp.js — nenhum dos dois precisou de uma consulta nova).
  // Ausente/vazio (ex.: um `template` montado a mao sem idioma) -> chave OMITIDA, nao string
  // vazia — mesma disciplina ja usada para `button0` acima.
  const idioma = String((template && template.idioma) || '').trim();

  return {
    type: 'template',
    to: telefone,
    template: {
      name: template.nome_meta,
      ...(idioma ? { language: idioma } : {}),
    },
    vars,
  };
}

// Le o corpo de erro sem nunca lancar pela leitura em si.
//
// PARTE 2 (ETAPA B, Incremento 14): antes deste incremento o corte em MAX_DETALHE_ERRO
// (300 chars) acontecia ANTES de qualquer log — nao existia, em lugar nenhum do projeto, um
// registro do corpo de erro completo que o Central Whats devolveu. Isso cegou o diagnostico
// da ETAPA A: so foi possivel ver a mensagem completa "Template nao sincronizado. Informe o
// idioma ou rode o sync." porque o corpo daquele caso especifico coube nos 300 chars por
// coincidencia — um corpo mais longo teria sido cortado no meio sem deixar rastro.
//
// Agora o corpo INTEIRO (sem limite) vai pro log do servidor via console.error, seguindo o
// mesmo padrao de prefixo '[modulo] ...' ja usado em lib/campanhaWhatsapp.js. O valor
// RETORNADO por esta funcao (usado no throw que vira a mensagem de erro pro chamador/UI)
// continua cortado em MAX_DETALHE_ERRO — nenhuma mudanca de comportamento externo, so
// logging a mais no servidor.
async function detalheDoErro(resposta) {
  try {
    const texto = await resposta.text();
    console.error('[central-whats] corpo de erro completo:', texto);
    return String(texto || '').slice(0, MAX_DETALHE_ERRO);
  } catch {
    return '(corpo da resposta ilegivel)';
  }
}

// Envia UM template. Devolve { wamid, mock }.
//
// `forcarEnvioReal` (ETAPA B, envio avulso de teste): default `false`, comportamento
// IDENTICO ao de sempre — nenhuma chamada existente (o job de disparo, em particular) passa
// este parametro, entao nenhuma delas muda de comportamento.
//
// ── POR QUE ISTO EXISTE, EM VEZ DE SETAR META_CAMPANHA_MOCK NO PROCESSO ──
// src/scripts/teste-envio-unico-central-whats.js:14-19 ja documenta a saida que ESTE modulo
// nao tinha: `process.env.META_CAMPANHA_MOCK = 'false'` funciona ali porque o script roda
// num processo Node EFEMERO, que morre logo em seguida. O servidor admin e um processo de
// VIDA LONGA — fazer o mesmo ali desligaria o mock para a campanha INTEIRA, ate o proximo
// deploy, deixando o ciclo periodico a UM kill-switch de enviar de verdade sem ninguem ter
// pedido isso. `forcarEnvioReal` resolve o mesmo problema (furar o mock para UM envio) sem
// tocar em estado global: o override vale so para ESTA chamada, e o processo continua em
// mock para todo o resto (inclusive o proximo ciclo do job, rodando no mesmo processo).
async function enviarTemplate({ telefone, template, variaveis, httpClient, forcarEnvioReal = false } = {}) {
  if (!telefone) throw new Error('Destinatario de WhatsApp ausente.');
  if (!template || !template.nome_meta) throw new Error('Template sem nome_meta: nada a enviar.');

  const payload = montarPayload({ telefone, template, variaveis });

  // ── MODO MOCK: nenhuma chamada de rede ──
  // Registra o que SAIRIA, com o telefone MASCARADO (o stdout do Railway e lido por mais
  // gente que o banco), e devolve um id falso para o fluxo inteiro poder ser exercitado sem
  // custo e sem gastar reputacao do numero.
  //
  // `forcarEnvioReal` ignora modoMock() de proposito: e a UNICA forma prevista de furar o
  // kill-switch para uma chamada isolada, sem depender da env var do processo.
  if (modoMock() && !forcarEnvioReal) {
    const wamid = wamidMock(telefone, template.nome_meta);
    console.log(
      `[central-whats] (mock) template '${template.nome_meta}' -> ${mascarar(telefone)} ` +
        `com ${Object.keys(payload.vars).length} variavel(is). NAO enviado. wamid=${wamid}`,
    );
    return { wamid, mock: true };
  }

  const faltando = credenciaisFaltando();
  if (faltando.length) {
    throw new Error(
      `Credenciais do Central Whats ausentes: ${faltando.join(', ')}. Defina no .env antes de ` +
        'sair do modo mock (META_CAMPANHA_MOCK=false).',
    );
  }

  const c = cfg();
  const http = httpClient || fetch;
  const url = `${c.baseUrl}/api/instances/${c.instanceId}/messages`;

  let resposta;
  try {
    resposta = await http(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${c.apiKey}`,
      },
      body: JSON.stringify(payload),
    });
  } catch (err) {
    // Falha de TRANSPORTE (DNS, TLS, socket, timeout), distinta de "a API respondeu
    // recusando". Aqui a mensagem NAO chegou nem ao Central Whats.
    throw new Error(
      `Falha de rede ao chamar o Central Whats: ${String(err && err.message).slice(0, MAX_DETALHE_ERRO)}`,
    );
  }

  if (!resposta || !resposta.ok) {
    const status = resposta ? resposta.status : 'sem resposta';
    throw new Error(`Central Whats retornou HTTP ${status} — ${await detalheDoErro(resposta)}`);
  }

  // 2xx = aceito. A partir daqui NADA que dependa de parsear o corpo pode virar excecao: a
  // mensagem ja foi aceita, e lancar aqui faria o job retentar alguem que VAI receber — e no
  // WhatsApp isso e mensagem duplicada, que e denuncia.
  let dados = null;
  try {
    dados = await resposta.json();
  } catch {
    dados = null;
  }

  return { wamid: extrairWamid(dados), mock: false };
}

// O id da mensagem na Meta, do corpo { id, wa_message_id, status, type }.
//
// E o `wa_message_id`, e NAO o `id`: o `id` e a chave do registro no Central Whats, enquanto
// campanha_whatsapp_envios.wamid guarda, desde sempre, o identificador da mensagem no
// WhatsApp. Mesmo conceito de antes, fonte diferente. Tolerante e nunca lanca — ver a nota
// acima sobre nao transformar aceite em erro.
function extrairWamid(dados) {
  if (!dados || typeof dados !== 'object') return null;
  return dados.wa_message_id || null;
}

// ── Classificacao de erro, nas MESMAS tres categorias do resto do projeto ──
//
// O job trata cada uma de um jeito, e a diferenca entre elas nao e de gravidade, e de ESCOPO:
//   configuracao  problema do AMBIENTE, igual para todo destinatario -> aborta o ciclo e NAO
//                 marca ninguem. Ninguem se perde; o proximo ciclo retoma.
//   terminal      problema DAQUELE envio -> marca falha e segue. Irreversivel na pratica: o
//                 UNIQUE(campanha_id, telefone) impede rematerializar a pessoa depois.
//   retentavel    passa sozinho -> conta tentativa ate o teto.
const TETO_RETENTAVEL = 5;

function statusHttp(mensagem) {
  const m = /\bHTTP (\d{3})\b/i.exec(String(mensagem || ''));
  return m ? Number(m[1]) : null;
}

function classificarErroCentralWhats(erro) {
  const bruta = String((erro && erro.message) || erro || '');
  const status = statusHttp(bruta);

  // 1. Nossos proprios erros de ambiente, antes de qualquer coisa.
  if (/credenciais do central whats ausentes/i.test(bruta)) {
    return { categoria: 'configuracao', teto: null, motivo: 'credenciais ausentes' };
  }

  // 2. Falha de rede contra o proprio Central Whats: a mensagem nao chegou nem la, e isso
  // costuma ser deploy/instabilidade que passa. Retentavel.
  if (/falha de rede ao chamar o central whats/i.test(bruta)) {
    return { categoria: 'retentavel', teto: TETO_RETENTAVEL, motivo: 'rede ate o Central Whats' };
  }

  if (status !== null) {
    // ⚠️ 401/403/404 sao CONFIGURACAO, e nao 'terminal' — divergencia deliberada da lista de
    // mapeamento pedida, registrada aqui porque a diferenca e destrutiva:
    //
    //   401 chave invalida ou revogada
    //   403 rota fora da lista branca da chave
    //   404 instance_id errado
    //
    // Nenhum dos tres muda de resposta conforme o destinatario — sao a mesma falha para a
    // fila inteira. Classificados como 'terminal', a primeira chave revogada marcaria ate 30
    // pessoas por ciclo como falha PERMANENTE (o UNIQUE impede rematerializar), e a base
    // seria consumida em ciclos ate alguem perceber. Como 'configuracao', o ciclo para, o log
    // grita, ninguem e marcado e o proximo ciclo retoma sozinho depois do conserto.
    //
    // O custo da escolha oposta e assimetrico: aqui, no maximo, a campanha fica parada.
    if (status === 401 || status === 403 || status === 404) {
      return { categoria: 'configuracao', teto: null, motivo: `HTTP ${status} do Central Whats (credencial/rota/instancia)` };
    }

    // 400 (payload ou template errado) e 422 (provider nao suporta o tipo): repetir produz
    // exatamente o mesmo erro. 400 e o unico que pode variar por destinatario — telefone que
    // a Meta recusa cai aqui — e e por isso que ele fica em 'terminal' e nao em
    // 'configuracao': marcar UMA pessoa e melhor que parar a fila por causa dela.
    if (status === 400 || status === 422) {
      return { categoria: 'terminal', teto: null, motivo: `HTTP ${status} do Central Whats (payload/template)` };
    }

    // 429: limite de taxa. Passa sozinho, e rapido — mesmo teto baixo de sempre.
    if (status === 429) {
      return { categoria: 'retentavel', teto: TETO_RETENTAVEL, motivo: 'HTTP 429 (rate limit)' };
    }

    // 502 = a Meta recusou por tras do Central Whats; os demais 5xx sao o Central Whats fora
    // do ar. Os dois podem aceitar na proxima tentativa.
    if (status >= 500) {
      return { categoria: 'retentavel', teto: TETO_RETENTAVEL, motivo: `HTTP ${status} (Central Whats ou Meta)` };
    }
  }

  // 3. Desconhecido -> RETENTAVEL, pela mesma assimetria de custo de classificarErroEnvio:
  // desconhecido-como-terminal perde a pessoa para sempre (o UNIQUE impede rematerializar);
  // desconhecido-como-retentavel custa 4 chamadas e acaba em falha do mesmo jeito.
  return { categoria: 'retentavel', teto: TETO_RETENTAVEL, motivo: 'erro nao classificado' };
}

module.exports = {
  enviarTemplate,
  montarPayload,
  classificarErroCentralWhats,
  credenciaisFaltando,
  modoMock,
  wamidMock,
  extrairWamid,
  TETO_RETENTAVEL,
};
