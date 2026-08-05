'use strict';

// Limpeza automatica dos audios de entrevista no volume persistente.
//
// POR QUE EXISTE: cada entrevista deixa ~4,4 MB de audio em /data/entrevistas/<id>
// (o mp3 de cada fala da Vera + o .webm de cada resposta). Hoje esse material so e
// apagado no caminho feliz do upload de video (routes/api.js, apos o Drive confirmar).
// Quando o upload nao acontece, o audio fica para sempre — e o volume enche ate travar
// a ESCRITA do SQLite, que mora no mesmo disco. Ja aconteceu: com /data em 100%, toda
// candidatura passou a falhar com ENOSPC. Esta varredura e a rede de seguranca.
//
// GATILHO POR ESPACO, NAO POR TEMPO. As outras tres varreduras deste projeto disparam
// uma ACAO a cada ciclo; esta so age quando o disco passa de um limiar. O setInterval
// e fixo (padrao do projeto), mas a passada normal e um no-op barato: le o interruptor,
// mede o disco e sai. Idade nao serve de criterio aqui — o problema nao e "audio velho",
// e "disco cheio"; e uma entrevista de ontem ocupa o mesmo tanto que uma do mes passado.
//
// O QUE ESTE MODULO NAO FAZ: nao decide se um audio pode ser apagado por conta propria
// (a query em db.listarElegiveisLimpezaAudio e a dona desse criterio) e nao implementa
// a exclusao (reusa lib/audioEntrevista.removerAudioDaEntrevista, a MESMA funcao usada
// pelo caminho do video-upload — duas copias divergiriam com o tempo).
//
// SALVAGUARDAS, em camadas — apagar arquivo e irreversivel:
//   1. interruptor no painel, default DESLIGADO (kill switch sem redeploy);
//   2. so age acima do limiar de uso do disco (default 80%);
//   3. criterio triplo na query, sendo video_url IS NOT NULL o mais forte: nunca apaga
//      audio de entrevista sem backup em video no Drive;
//   4. teto de pastas por ciclo (nao vira exclusao em massa por defeito);
//   5. para assim que o uso cai abaixo do limiar (nao gasta o cap se ja resolveu);
//   6. fail-safe: se a medicao do disco falhar, NAO limpa.

const fs = require('node:fs');
const { config } = require('../config');
const db = require('../db');
const { removerAudioDaEntrevista } = require('./audioEntrevista');

// Interruptor GERAL do subsistema (painel: /admin/config). Default FALSE: nasce desligado
// e nao apaga nada ate alguem ligar conscientemente. Mesma chave lida por routes/admin.js.
const CHAVE_ATIVO = 'limpeza_audio_ativo';

function ativo() {
  return db.obterConfigBool(CHAVE_ATIVO, false);
}

// Limiar de uso do volume (%) a partir do qual a limpeza age. Em env (nao no painel) de
// proposito: e um parametro de capacidade, nao uma decisao operacional do recrutador —
// o kill switch dele e o checkbox. Valor invalido cai no padrao.
const LIMIAR_PCT_PADRAO = 80;

function limiarPct() {
  const bruto = Number(process.env.LIMPEZA_AUDIO_LIMIAR_PCT);
  if (!Number.isFinite(bruto) || bruto <= 0 || bruto > 100) return LIMIAR_PCT_PADRAO;
  return bruto;
}

// Teto de pastas por ciclo. Mesma razao do ENVIOS_POR_CICLO das varreduras de e-mail:
// se um defeito (ou uma mudanca de criterio) tornar dezenas de entrevistas elegiveis de
// uma vez, some no maximo esse tanto por passada e da tempo de ver e desligar. O backlog
// nao se perde: drena nos ciclos seguintes.
//
// Conta REMOCOES REAIS, nao candidatos lidos. A distincao importa: a maioria das
// entrevistas elegiveis ja teve o audio apagado pelo caminho do video-upload (a query
// olha o banco, que nao sabe o que existe no disco). Se o teto fosse o LIMIT do SQL, um
// ciclo gastaria a cota inteira em pastas que nem existem mais e nao liberaria 1 byte —
// em producao, hoje, as 20 primeiras elegiveis estao TODAS nesse caso.
const REMOCOES_POR_CICLO_PADRAO = 20;

// Teto de linhas LIDAS do banco por ciclo. Nao e a salvaguarda (essa e a de cima): e so
// um limite de sanidade para a consulta nao crescer sem fim. Verificar um candidato que
// ja foi limpo custa um existsSync, entao da para varrer bem mais do que se apaga.
const MAX_CANDIDATOS_CONSULTA = 500;

function remocoesPorCiclo() {
  const bruto = Number(process.env.LIMPEZA_AUDIO_POR_CICLO);
  if (!Number.isFinite(bruto) || bruto <= 0) return REMOCOES_POR_CICLO_PADRAO;
  return Math.floor(bruto);
}

// Uso do volume onde vivem os audios, em %.
//
// bavail (e nao bfree) de proposito: bfree conta os blocos reservados ao root, que o
// processo nao pode usar — a conta com bfree fica otimista e nao bate com o `df`. Com
// bavail o numero confere com o `df -h` do container.
//
// Lanca se a medicao falhar; quem chama trata como "nao limpar" (fail-safe).
function usoDiscoPct(caminho = config.caminhoEntrevistas) {
  const s = fs.statfsSync(caminho);
  const total = s.blocks * s.bsize;
  const livre = s.bavail * s.bsize;
  if (!Number.isFinite(total) || total <= 0) {
    throw new Error(`statfs devolveu total invalido para ${caminho}`);
  }
  return ((total - livre) / total) * 100;
}

// Uma passada. Devolve um resumo; nunca lanca por falha esperada.
function varrer() {
  const resumo = { removidas: 0, bytes: 0, usoAntes: null, usoDepois: null };

  // Interruptor checado ANTES de qualquer acesso ao banco ou ao disco: enquanto
  // desligado, o ciclo custa praticamente nada.
  if (!ativo()) {
    console.log('[limpeza-audio] desativado em /admin/config; ciclo pulado.');
    return { ...resumo, desativado: true };
  }

  const limiar = limiarPct();

  // Fail-safe: sem medicao confiavel do disco, NAO apaga. Na duvida o custo de nao
  // limpar e o disco encher (visivel, recuperavel); o de limpar a toa e perder audio
  // para sempre.
  let usoAntes;
  try {
    usoAntes = usoDiscoPct();
  } catch (err) {
    console.error(
      `[limpeza-audio] falha ao medir o uso do disco; nada sera apagado: ${err.message}`,
    );
    return resumo;
  }
  resumo.usoAntes = usoAntes;
  resumo.usoDepois = usoAntes;

  if (usoAntes < limiar) {
    // Caminho normal e silencioso: nao polui o log a cada 15 min.
    return { ...resumo, abaixoDoLimiar: true };
  }

  let elegiveis = [];
  try {
    elegiveis = db.listarElegiveisLimpezaAudio({ limite: MAX_CANDIDATOS_CONSULTA });
  } catch (err) {
    console.error(`[limpeza-audio] falha ao consultar elegiveis: ${err.message}`);
    return resumo;
  }

  if (!elegiveis.length) {
    console.warn(
      `[limpeza-audio] uso do volume em ${usoAntes.toFixed(1)}% (limiar ${limiar}%), mas ` +
        'nenhuma entrevista elegivel: so apagamos audio de entrevista concluida, com ' +
        'relatorio gerado E video ja confirmado no Drive. Verifique o espaco manualmente.',
    );
    return resumo;
  }

  const cap = remocoesPorCiclo();
  let uso = usoAntes;
  for (const id of elegiveis) {
    if (resumo.removidas >= cap) break;

    const bytes = removerAudioDaEntrevista(id);
    // 0 bytes = pasta ja nao existia (audio limpo pelo video-upload no seu momento).
    // Nao conta para o teto nem dispara nova medicao: nada mudou no disco.
    if (bytes === 0) continue;

    resumo.removidas += 1;
    resumo.bytes += bytes;

    // Reavalia a cada exclusao e para assim que o disco volta ao normal: o cap e um
    // teto de seguranca, nao uma meta a cumprir.
    try {
      uso = usoDiscoPct();
    } catch (err) {
      console.error(
        `[limpeza-audio] falha ao remedir o disco apos a interview ${id}; interrompendo: ${err.message}`,
      );
      break;
    }
    if (uso < limiar) break;
  }
  resumo.usoDepois = uso;

  // Elegivel no banco mas nada no disco: nao ha o que liberar por este caminho. Vale um
  // aviso — o disco esta cheio por outra coisa (audio de entrevista SEM video no Drive,
  // curriculos, o proprio banco) e a limpeza automatica nao vai resolver sozinha.
  if (resumo.removidas === 0) {
    console.warn(
      `[limpeza-audio] uso do volume em ${usoAntes.toFixed(1)}% (limiar ${limiar}%), ` +
        `${elegiveis.length} entrevista(s) elegivel(is), mas nenhuma tinha audio no disco. ` +
        'Nada foi liberado; verifique o espaco manualmente.',
    );
    return resumo;
  }

  console.log(
    `[limpeza-audio] varredura concluida — ${resumo.removidas} pasta(s) removida(s), ` +
      `${(resumo.bytes / 1048576).toFixed(1)} MB liberados; uso do volume ` +
      `${usoAntes.toFixed(1)}% -> ${uso.toFixed(1)}% (limiar ${limiar}%).`,
  );
  return resumo;
}

// ── Trava em memoria contra execucoes sobrepostas ──
// Mesma razao dos outros tres modulos: a passada do boot e as do setInterval compartilham
// a MESMA trava. Se um ciclo demorar mais que o intervalo, o proximo tick e descartado
// (nao enfileirado) — a varredura e idempotente e o ciclo seguinte pega o que sobrou.
let varrendo = false;

function varrerSeOcioso() {
  if (varrendo) {
    console.warn('[limpeza-audio] varredura anterior ainda em andamento; ciclo ignorado.');
    return null;
  }
  varrendo = true;
  try {
    return varrer();
  } catch (err) {
    // Defensivo: varrer() ja captura os erros esperados. Se algo escapar, o agendador
    // NAO pode morrer nem deixar a trava presa.
    console.error(`[limpeza-audio] erro inesperado na varredura: ${err.message}`);
    return null;
  } finally {
    varrendo = false;
  }
}

module.exports = {
  varrer,
  varrerSeOcioso,
  usoDiscoPct,
  limiarPct,
  remocoesPorCiclo,
  CHAVE_ATIVO,
  LIMIAR_PCT_PADRAO,
  REMOCOES_POR_CICLO_PADRAO,
};
