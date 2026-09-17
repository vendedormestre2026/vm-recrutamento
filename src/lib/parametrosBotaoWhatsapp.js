'use strict';

// Parametros dos BOTOES de um template de WhatsApp, por destinatario.
//
// ══════════════════════════════════════════════════════════════
// POR QUE ESTE MODULO EXISTE
// ══════════════════════════════════════════════════════════════
//
// Havia DOIS pontos montando isso a mao, e eles divergiram — que e o bug que criou este
// arquivo. O commit que passou a preencher o botao de descadastro (8f3299f) tocou o ciclo de
// campanha (lib/campanhaWhatsapp.js) e NAO tocou o envio avulso de teste
// (routes/admin_campanha_whatsapp.js). Resultado, contra a Central Whats de verdade:
//
//   HTTP 400 — {"error":"Template \"nova_vaga_v1\": o botão de índice 0 tem URL dinâmica e
//               exige a variável \"button0\", que não foi informada."}
//   HTTP 400 — o mesmo para convite_grupo_vagas_vm, faltando \"button1\".
//
// O envio avulso so sabia preencher o botao do GRUPO, no indice 0. O de descadastro, que a
// Meta passou a exigir nos tres templates de marketing, ele nunca soube que existia.
//
// Agora a montagem e UMA, e os dois canais chamam a mesma funcao. A regra nova e simples: um
// canal de envio nao decide o que vai no botao — ele passa quem recebe, e esta funcao
// responde. Um terceiro canal (um webhook, um script) entra pela mesma porta.
//
// ══════════════════════════════════════════════════════════════
// OS INDICES VEM DOS BOTOES SINCRONIZADOS, NUNCA DO CODIGO
// ══════════════════════════════════════════════════════════════
//
// `templates_whatsapp.botoes_json` e o espelho do que a Meta aprovou (gravado por
// db.sincronizarTemplateWhatsapp). Quem casa `button<n>` com o botao certo e a POSICAO no
// array, e ela muda por template: em nova_vaga_v1/v2 o descadastro nasce no indice 0; em
// convite_grupo_vagas_vm o "Entrar no Grupo" ja ocupa o 0 e o descadastro fica no 1. Cravar
// um indice manda o token para o botao errado — o candidato clicaria em "Entrar no Grupo" e
// cairia na pagina de descadastro.
//
// ══════════════════════════════════════════════════════════════
// O INTERRUPTOR `optout_link_campanha_ativo` NAO GOVERNA MAIS ESTE PARAMETRO
// ══════════════════════════════════════════════════════════════
//
// Ele governava, e a mudanca e deliberada. O interruptor nasceu para a VARIAVEL DE CORPO
// `link_descadastro` (o link escrito dentro do texto), num tempo em que nenhum template
// aprovado tinha botao: ligar sem template pronto nao colocaria link em lugar nenhum, entao o
// default desligado era o certo. Ele continua valendo para o corpo — ver
// optout.textoDescadastroPara, que NAO foi tocado.
//
// Para o BOTAO, o mesmo default virou destrutivo no dia em que a Meta aprovou os botoes: o
// parametro deixou de ser um extra e passou a ser EXIGIDO. Com o interruptor desligado, o
// envio nao sai "sem link" — sai RECUSADO com HTTP 400, e um 400 e classificado como
// 'terminal' (providers/centralWhats), o que marca a pessoa como falha PERMANENTE (o
// UNIQUE(campanha_id, telefone) impede rematerializar depois). O ciclo automatico de 10 min
// (server.js) drena ate 30 linhas por passada, sem humano no meio: uma base inteira poderia
// ser queimada por um checkbox desmarcado.
//
// Quem decide se o parametro vai passou a ser o TEMPLATE SINCRONIZADO: se ele tem o botao, o
// parametro vai. Se nao tem, nao ha o que preencher. E a mesma fonte que ja decidia o
// indice, e ela nao pode estar em desacordo consigo mesma.
//
// ══════════════════════════════════════════════════════════════
// NUNCA LANCA, E NUNCA MANDA VALOR VAZIO
// ══════════════════════════════════════════════════════════════
//
// Falha ao gerar o token (telefone sem chave canonica, OPTOUT_TOKEN_SECRET ausente) vira
// AVISO no log e parametro ausente, nunca excecao: o chamador e um laco de envio, e derrubar
// o ciclo por um link acessorio ja custou uma campanha de 1.463 pessoas uma vez (ver
// CARGO_VAGA_PADRAO em lib/campanhaWhatsapp.js).
//
// E valor vazio nunca entra no mapa. Vazio, para a Meta, e AUSENTE — o erro 131008, que
// (diferente do 400) e classificado como 'configuracao' e aborta o ciclo inteiro.

const dbPadrao = require('../db');
const {
  precisaBotaoDinamico,
  indiceBotaoDescadastro,
  indiceBotaoGrupo,
  botoesDoTemplate,
} = require('./templatesWhatsapp');
const { gerarTokenDescadastroWhatsapp } = require('./descadastroWhatsapp');

// Categoria da Meta em que a AUSENCIA de botao de descadastro e um problema a gritar no log.
// Num template 'utility'/'authentication' a ausencia e normal e avisar seria ruido por envio,
// 30 por ciclo — ver escopoDaCategoriaTemplate em lib/optoutWhatsapp.js para a mesma
// distincao aplicada ao opt-out.
const CATEGORIA_QUE_EXIGE_SAIDA = 'marketing';

// Mapa { <indice>: <valor> } para `parametrosBotao` de centralWhats.enviarTemplate, ou
// `undefined` quando nao ha nenhum parametro a mandar.
//
// `undefined` e nao `{}` de proposito: um objeto vazio muda o payload de um template sem
// botao nenhum, que e um caminho que funciona hoje — ver montarPayload.
//
// `template` e a LINHA de templates_whatsapp (ou o recorte dela que a fila do ciclo traz):
// precisa de `nome_meta`, `botoes_json` e `categoria`. `cidade` e a praca do destinatario,
// usada so para resolver o slug do grupo.
function montarParametrosBotao({ template, telefone, cidade } = {}, deps = {}) {
  const db = deps.db || dbPadrao;
  const nomeMeta = String((template && template.nome_meta) || '').trim();
  const botoes = botoesDoTemplate(template && template.botoes_json);
  const parametros = {};

  // ── BOTAO DO GRUPO ──
  //
  // O valor e o SLUG da praca ("joinville"), NAO o link do convite: a URL aprovada na Meta e
  // "https://entrevista.vendedormestre.com.br/grupo/{{1}}", e quem resolve slug -> link no
  // clique e GET /grupo/:slug. Um primeiro envio real usou o link completo aqui e o botao
  // gerou 404 (".../grupo/https://chat.whatsapp.com/..." nao bate slug nenhum).
  //
  // `precisaBotaoDinamico` sobrevive como FALLBACK, e so isso: ele e a lista fechada por
  // nome que existia antes de `botoes_json` existir, e cobre o template ainda nao
  // ressincronizado (botoes_json NULL) — nesse estado nao ha indice a ler, e o 0 e o que
  // convite_grupo_vagas_vm tem de verdade na Meta. Com os botoes sincronizados, quem manda e
  // o indice lido deles.
  const indiceGrupo = indiceBotaoGrupo(botoes);
  if (indiceGrupo !== null || precisaBotaoDinamico(nomeMeta)) {
    const slug = cidade ? db.obterSlugGrupo(cidade) : null;
    if (slug) parametros[indiceGrupo === null ? 0 : indiceGrupo] = slug;
  }

  // ── BOTAO DE DESCADASTRO ──
  const indiceSaida = indiceBotaoDescadastro(botoes);
  if (indiceSaida === null) {
    if (String((template && template.categoria) || '').toLowerCase() === CATEGORIA_QUE_EXIGE_SAIDA) {
      console.warn(
        `[botao-wa] template '${nomeMeta}' (marketing) sem botao de descadastro nos botoes ` +
          'sincronizados; enviando sem o parametro. Se o botao ja foi aprovado na Meta, rode ' +
          'Sincronizar templates — se a Meta exigir o parametro, o envio sera recusado.',
      );
    }
  } else {
    // gerarTokenDescadastroWhatsapp LANCA por contrato. Aqui a excecao vira "envia sem o
    // botao", nunca ciclo abortado.
    try {
      const token = gerarTokenDescadastroWhatsapp(telefone);
      if (token) parametros[indiceSaida] = token;
    } catch (err) {
      console.warn(
        `[botao-wa] falha ao gerar o token de descadastro (${err.message}); enviando SEM o ` +
          'parametro do botao. O ENVIO SEGUE NORMALMENTE.',
      );
    }
  }

  return Object.keys(parametros).length ? parametros : undefined;
}

module.exports = {
  montarParametrosBotao,
  CATEGORIA_QUE_EXIGE_SAIDA,
};
