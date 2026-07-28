'use strict';

// Follow-up automatico de entrevistas NAO concluidas.
//
// Problema que resolve: o candidato inicia a entrevista (applications.status vira
// 'em_entrevista') e some no meio. Hoje nada acontece — ele fica parado no funil para
// sempre. Este modulo faz uma varredura periodica (agendada em server.js) e manda ate
// DOIS e-mails com o link de retomada.
//
// Regras de negocio (fixas):
//   - So 'em_entrevista'. Quem esta 'aplicado' (nunca comecou) NAO entra.
//   - So vaga em modo COMPLETO (modoEntrevistaAtivo) — checado na query (coluna) e aqui
//     (toggle geral), porque a precedencia dos dois mora em lib/modo.
//   - Candidatura arquivada (deleted_at) nao recebe nada.
//   - 1o e-mail: apos N horas sem atividade na entrevista (N configuravel no painel).
//   - 2o e-mail: 24h FIXAS depois do 1o, se ainda nao concluiu.
//   - NUNCA mais que 2 envios por candidato (garantido pelas colunas de controle:
//     a query so devolve quem tem a coluna da etapa em NULL).
//
// Idempotencia: o timestamp so e gravado APOS o envio dar certo. Falha de envio nao
// marca nada — o candidato reaparece na proxima varredura e tentamos de novo.

const { config } = require('../config');
const db = require('../db');
const email = require('../providers/email');
const entrevista = require('./entrevista');
const { modoEntrevistaAtivo } = require('./modo');
const { escapeHtml } = require('../views');

// Chave do store de configuracoes: horas de espera ANTES do 1o follow-up. Editavel em
// /admin/config. A espera do 2o e-mail (24h) e regra de negocio e NAO e configuravel.
const CHAVE_HORAS_ESPERA = 'followup_entrevista_horas_espera';
const HORAS_ESPERA_PADRAO = 24;

// Interruptor GERAL do subsistema (painel: /admin/config). Default FALSE: o follow-up
// nasce desligado e nao envia nada ate alguem ligar conscientemente. A varredura segue
// agendada — so vira no-op enquanto estiver desligado.
const CHAVE_ATIVO = 'followup_entrevista_ativo';

function ativo() {
  return db.obterConfigBool(CHAVE_ATIVO, false);
}

// Espera fixa entre o 1o e o 2o e-mail.
const HORAS_ETAPA_2 = 24;

// Le as horas de espera do painel. Valor ausente, nao numerico, <= 0 ou absurdo cai no
// padrao — uma config digitada errada nunca vira "manda para todo mundo agora".
function horasEspera() {
  const cru = db.obterConfig(CHAVE_HORAS_ESPERA, String(HORAS_ESPERA_PADRAO));
  const n = Number(cru);
  if (!Number.isFinite(n) || n <= 0) return HORAS_ESPERA_PADRAO;
  return n;
}

// HTML do e-mail de follow-up. Mesma identidade visual do e-mail de retomada
// (preto #0D0B0A, laranja #FF5500, off-white #F4F3F1, Barlow com fallbacks), porem com
// copy PROATIVA: aqui somos nos que estamos procurando o candidato, ele nao pediu nada.
// `etapa` 2 muda o tom para "ultima chance", sem pressao agressiva.
function montarEmailFollowup({ nome, tituloVaga, link, etapa = 1 }) {
  const ola = nome ? `Olá, ${escapeHtml(nome)}!` : 'Olá!';
  const titulo = escapeHtml(tituloVaga);

  const abertura =
    etapa === 2
      ? `Passando aqui uma última vez: sua entrevista para a vaga de <strong>${titulo}</strong> continua em aberto, esperando só por você.`
      : `Você começou sua entrevista para a vaga de <strong>${titulo}</strong> no Vendedor Mestre, mas ela ficou pela metade.`;

  const reforco =
    etapa === 2
      ? `<p style="font-size:16px;line-height:1.5;margin:0 0 24px;">Se você ainda tem interesse na vaga, basta clicar no botão abaixo para terminar. Caso tenha mudado de ideia, tudo bem — é só ignorar este e-mail, e não voltaremos a escrever sobre esta candidatura.</p>`
      : `<p style="font-size:16px;line-height:1.5;margin:0 0 24px;">Boa notícia: você não precisa recomeçar. É só clicar no botão abaixo e continuar de onde parou.</p>`;

  const rotuloBotao = etapa === 2 ? 'Terminar minha entrevista' : 'Continuar minha entrevista';

  return `
  <div style="margin:0;padding:24px;background:#0D0B0A;font-family:'Barlow',Arial,Helvetica,sans-serif;color:#F4F3F1;">
    <div style="max-width:520px;margin:0 auto;">
      <h1 style="font-family:'Barlow Condensed','Barlow',Arial,sans-serif;font-weight:700;color:#FF5500;font-size:24px;margin:0 0 16px;">${ola}</h1>
      <p style="font-size:16px;line-height:1.5;margin:0 0 16px;">${abertura}</p>
      ${reforco}
      <p style="margin:0 0 24px;">
        <a href="${link}" style="display:inline-block;background:#FF5500;color:#0D0B0A;text-decoration:none;font-family:'Barlow Condensed','Barlow',Arial,sans-serif;font-weight:700;font-size:18px;padding:14px 28px;border-radius:8px;">${rotuloBotao}</a>
      </p>
      <p style="font-size:15px;line-height:1.5;margin:0 0 8px;"><strong>O que acontece ao clicar:</strong></p>
      <ul style="font-size:15px;line-height:1.6;margin:0 0 24px;padding-left:20px;">
        <li>Você entra direto na sua candidatura, sem precisar de senha nem código.</li>
        <li>A entrevista continua de onde parou — suas respostas anteriores estão salvas.</li>
        <li>Se o navegador pedir, autorize a câmera e o microfone: a conversa com a Vera é gravada em vídeo.</li>
        <li>Prefira um lugar silencioso e uma conexão estável.</li>
      </ul>
      <p style="font-size:14px;line-height:1.5;margin:0 0 24px;">Se o botão não funcionar, copie e cole este link no navegador:<br><span style="color:#FF5500;">${link}</span></p>
      <p style="font-size:16px;line-height:1.5;margin:0 0 4px;">Se tiver qualquer dúvida, responda este e-mail.</p>
      <p style="font-size:16px;line-height:1.5;margin:16px 0 0;">Até logo,<br><strong>Equipe Vendedor Mestre</strong></p>
    </div>
  </div>`;
}

// Assunto por etapa.
function assuntoFollowup(tituloVaga, etapa) {
  return etapa === 2
    ? `Última chance de continuar sua entrevista — ${tituloVaga}`
    : `Sua entrevista para ${tituloVaga} ainda está esperando por você`;
}

// Envia o follow-up de UM candidato e, so em caso de sucesso, marca o timestamp.
// Retorna true se marcou. Erro NUNCA propaga: loga e devolve false (a varredura segue
// para o proximo candidato e este e tentado de novo no proximo ciclo).
async function enviarParaCandidato(linha, etapa) {
  const vaga = linha.job_id ? db.obterVaga(linha.job_id) : null;

  // 2a barreira do modo Completo: a query ja filtrou a COLUNA da vaga; aqui entra o
  // toggle GERAL (config), que nao e coluna. Geral OFF -> ninguem recebe e-mail de
  // entrevista, mesmo com a vaga marcada como Completa.
  if (!modoEntrevistaAtivo(vaga)) return false;

  const tituloVaga = (vaga && vaga.titulo) || 'a vaga';
  const link = `${config.baseUrl}/retomar?token=${encodeURIComponent(linha.token)}`;
  const assunto = assuntoFollowup(tituloVaga, etapa);
  const html = montarEmailFollowup({ nome: linha.nome, tituloVaga, link, etapa });

  try {
    if (config.entrevista.mock) {
      // Mesmo padrao de relatorio.js e do /api/retomar-depois: em mock NAO toca o Resend.
      console.log(
        `[followup] (mock) e-mail ${etapa} NAO enviado. destinatario=${linha.email} link=${link}`,
      );
    } else {
      await entrevista.comTimeout(
        email.enviar(linha.email, assunto, html),
        config.entrevista.timeoutMs,
        'Resend',
      );
    }
    // So aqui, DEPOIS do envio (ou do log em mock): marca para nao reenviar. Em mock
    // marcamos tambem — senao a varredura relogaria os mesmos candidatos a cada ciclo.
    db.marcarFollowupEntrevistaEnviado(linha.id, etapa);
    return true;
  } catch (err) {
    console.error(
      `[followup] falha ao enviar e-mail ${etapa} (application_id=${linha.id}): ${err.message}`,
    );
    return false;
  }
}

// Uma passada completa: etapa 1 e depois etapa 2. Sequencial de proposito — o volume e
// baixo e assim nao abrimos dezenas de conexoes simultaneas com o Resend.
// Retorna { etapa1, etapa2, falhas } (numeros), util para log e para teste.
async function varrer() {
  const resumo = { etapa1: 0, etapa2: 0, falhas: 0 };

  // Interruptor geral: desligado (default) -> nenhuma consulta, nenhum envio. Checado
  // ANTES de qualquer acesso ao banco de candidatos, para o ciclo custar praticamente
  // nada enquanto o subsistema estiver dormindo.
  if (!ativo()) {
    console.log('[followup] desativado em /admin/config; ciclo pulado.');
    return { ...resumo, desativado: true };
  }

  const etapas = [
    { etapa: 1, horas: horasEspera() },
    { etapa: 2, horas: HORAS_ETAPA_2 },
  ];

  for (const { etapa, horas } of etapas) {
    let pendentes = [];
    try {
      pendentes = db.listarPendentesFollowupEntrevista({ etapa, horasEspera: horas });
    } catch (err) {
      console.error(`[followup] falha ao consultar pendentes da etapa ${etapa}: ${err.message}`);
      continue;
    }

    for (const linha of pendentes) {
      const ok = await enviarParaCandidato(linha, etapa);
      if (ok) {
        resumo[etapa === 2 ? 'etapa2' : 'etapa1'] += 1;
      } else {
        resumo.falhas += 1;
      }
    }
  }

  if (resumo.etapa1 || resumo.etapa2 || resumo.falhas) {
    console.log(
      `[followup] varredura concluida — 1o e-mail: ${resumo.etapa1}, 2o e-mail: ${resumo.etapa2}, falhas: ${resumo.falhas}`,
    );
  }
  return resumo;
}

// ── Trava em memoria contra execucoes sobrepostas ──
// A flag mora AQUI (nao no server.js) para que a varredura do boot e as do setInterval
// compartilhem a MESMA trava. Se um ciclo demorar mais que o intervalo, o proximo tick
// e descartado (nao enfileirado): a varredura e idempotente, o ciclo seguinte pega o
// que sobrou. Vale so dentro deste processo — o app roda como processo unico (uma
// replica) no container; a garantia real contra e-mail duplicado sao as colunas de
// controle no banco, nao esta flag.
let varrendo = false;

async function varrerSeOcioso() {
  if (varrendo) {
    console.warn('[followup] varredura anterior ainda em andamento; ciclo ignorado.');
    return null;
  }
  varrendo = true;
  try {
    return await varrer();
  } catch (err) {
    // Defensivo: varrer() ja captura os erros esperados. Se algo escapar, o agendador
    // NAO pode morrer nem deixar a trava presa.
    console.error(`[followup] erro inesperado na varredura: ${err.message}`);
    return null;
  } finally {
    varrendo = false;
  }
}

module.exports = {
  varrer,
  varrerSeOcioso,
  montarEmailFollowup,
  assuntoFollowup,
  horasEspera,
  ativo,
  CHAVE_ATIVO,
  CHAVE_HORAS_ESPERA,
  HORAS_ESPERA_PADRAO,
  HORAS_ETAPA_2,
};
