'use strict';

// Job de disparo da campanha por WhatsApp (Meta Cloud API).
//
// SETIMA varredura periodica do projeto. Mesma anatomia das seis anteriores — interruptor
// antes de tocar o banco, trava contra ciclos sobrepostos, teto por ciclo, marcacao SO apos
// sucesso, falha isolada por destinatario.
//
// ── O QUE MUDA EM RELACAO A CAMPANHA DE E-MAIL ──
//   e-mail    teto 125 / ciclo, throttle 500 ms   esta: 30 / ciclo, throttle 2 s
//   e-mail    4 categorias de erro                esta: 3 (ver providers/whatsappMeta)
//   e-mail    nenhuma consulta de opt-out por linha  esta: SIM, por telefone
//   e-mail    conteudo montado por nos            esta: template aprovado + variaveis
//
// Os numeros sao menores de proposito. A punicao por excesso aqui nao e reputacao de dominio,
// que se recupera: e rebaixamento de tier ou perda do numero, que e binaria. Comecar
// conservador e barato; comecar agressivo pode custar o canal inteiro.

const dbPadrao = require('../db');
const meta = require('../providers/whatsappMeta/metaWhatsapp');
const { normalizarTelefoneRecebido } = require('./whatsapp');
const { mascarar } = require('../whatsapp/sequenciaOutbox');
const { montarUrlVaga, UTM_SOURCE_WHATSAPP } = require('./ctaCampanha');

// Interruptor de DISPARO, no store `configuracoes` — mesmo padrao de promocao_ativa e
// whatsapp_sequencia_ativa. Config de BANCO, com checkbox no painel; nao e env.
const CHAVE_ATIVO = 'campanha_whatsapp_ativa';

// Teto por ciclo. Bem abaixo dos 125 do e-mail: ver a nota do cabecalho sobre o custo do
// excesso.
const ENVIOS_POR_CICLO = 30;

// Pausa ENTRE envios. 2 s = 30 mensagens em ~1 min, contra um ciclo de 10 min — custo zero em
// vazao, e remove a rajada, que e o padrao que a Meta mede como qualidade ruim.
const ENVIO_INTERVALO_MS = 2000;

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

  const enviar = deps.enviarTemplate || meta.enviarTemplate;
  const classificar = deps.classificar || meta.classificarErroMeta;
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
    if (db.estaOptOutWhatsapp(telefone)) {
      db.marcarEnvioWhatsappOptOut(linha.id);
      resumo.optOut += 1;
      console.log(`[campanha-wa] ${mascarar(telefone)} em opt-out; nao enviado.`);
      continue;
    }

    // ── 2. LINK DO GRUPO da praca ──
    // Ausencia de link e falha DAQUELE envio, e NAO aborto do ciclo: uma praca sem link
    // configurado nao pode impedir as outras oito de receberem. E deixar pendente seria pior
    // — a linha reapareceria em todo ciclo, para sempre, sem ninguem entender por que.
    // O link do GRUPO so e exigido no convite. Numa divulgacao de vaga a mensagem leva o
    // link da VAGA, e cobrar link de grupo ali faria a campanha falhar por um dado que ela
    // nem usa.
    const precisaLinkGrupo = linha.tipo_mensagem !== 'divulgacao_vaga';
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
      // Em divulgacao, o cargo vem da VAGA; em convite de grupo nao ha vaga e o campo fica
      // vazio, que e o comportamento ja documentado de resolverVariaveis.
      cargo_vaga: linha.job_titulo || linha.cargo_vaga || '',
      link_grupo_regiao: link,
      link_vaga: linkVaga,
      cidade: linha.cidade || '',
    });

    try {
      const { wamid } = await enviar({
        telefone,
        template: {
          nome_meta: linha.template_nome,
          idioma: linha.template_idioma,
          // Propriedade do template aprovado na Meta, nao deste destinatario: quando
          // preenchida, o adaptador acrescenta o componente de botao que a Graph API exige.
          // Vem do banco junto com a linha da fila para nao custar uma consulta por envio.
          botao_parametro_fixo: linha.template_botao_parametro_fixo,
        },
        variaveis,
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
  ativo,
  CHAVE_ATIVO,
  ENVIOS_POR_CICLO,
  ENVIO_INTERVALO_MS,
};
