'use strict';

// E-mail automatico de RECUSA: avisa o candidato de que nao seguiremos com a candidatura
// quando o relatorio recomendou 'descartar'.
//
// Varredura SEPARADA da de followupEntrevista, de proposito. As duas compartilham a
// arquitetura (trava em memoria, idempotencia por coluna, marcacao so apos sucesso,
// degradacao em mock), mas o publico e oposto — la e quem NAO terminou, aqui e quem
// terminou e foi descartado — e cada uma tem seu proprio interruptor. Junta-las tornaria
// o "desativado" ambiguo: desligar o follow-up nao pode desligar a recusa, e vice-versa.
//
// O QUE O E-MAIL NAO DIZ (requisito, nao detalhe): nada de IA, nota, pontuacao,
// competencia, resumo ou qualquer conteudo da avaliacao. E um aviso de nao-avanco, seco e
// respeitoso. O assunto tambem nao entrega o desfecho na caixa de entrada.
//
// SALVAGUARDAS, em camadas — este e o unico e-mail do sistema que comunica uma decisao
// negativa a um terceiro, e nao da para "despublicar" um e-mail enviado:
//   1. interruptor no painel, default DESLIGADO (kill switch sem redeploy);
//   2. carencia de HORAS_CARENCIA antes do disparo (janela de intervencao do recrutador);
//   3. supressao por status_recrutador ('aprovado'/'em_analise' cancelam);
//   4. teto de ENVIOS_POR_CICLO (nao vira disparo em massa por defeito);
//   5. idempotencia por coluna (um e-mail por candidato, para sempre).

const { config } = require('../config');
const db = require('../db');
const email = require('../providers/email');
const entrevista = require('./entrevista');
const { escapeHtml } = require('../views');

// Interruptor GERAL do subsistema (painel: /admin/config). Default FALSE: nasce desligado
// e nao envia nada ate alguem ligar conscientemente. Mesma chave lida por routes/admin.js.
const CHAVE_ATIVO = 'email_recusa_ativo';

function ativo() {
  return db.obterConfigBool(CHAVE_ATIVO, false);
}

// Janela entre o relatorio chegar ao recrutador e a recusa sair para o candidato. Existe
// para o recrutador PODER INTERVIR: se ele discordar do veredito da IA, tem esse tempo
// para marcar o candidato como Aprovado ou Em analise e cancelar o envio. Contada a partir
// de reports.enviado_em — o relogio so comeca quando ele foi de fato notificado.
const HORAS_CARENCIA = 6;

// Teto de envios por ciclo. Protecao contra disparo em massa: se um defeito (ou uma
// mudanca de criterio) tornar dezenas de candidatos elegiveis de uma vez, saem no maximo
// 20 por varredura e o estrago fica contido — da tempo de ver no painel e desligar. O
// backlog nao se perde: drena nos ciclos seguintes, 20 a cada 15 min.
const ENVIOS_POR_CICLO = 20;

function nomeCurto(nome) {
  const primeiro = String(nome || '').trim().split(/\s+/)[0];
  return primeiro || '';
}

// Assunto neutro: nao entrega o desfecho na caixa de entrada. Nada de "recusa",
// "nao selecionado" ou "processo encerrado" — o candidato abre o e-mail para saber.
function assuntoRecusa(tituloVaga) {
  return `Atualização sobre sua candidatura — ${tituloVaga}`;
}

// HTML do e-mail. Mesma identidade visual dos demais e-mails ao candidato (fundo
// #0D0B0A, laranja #FF5500, off-white #F4F3F1, Barlow com fallbacks) — o molde vem de
// followupEntrevista.montarEmailFollowup. Sem botao/CTA: nao ha acao a tomar.
// escapeHtml em TODO dado que vem do candidato ou da vaga.
function montarEmailRecusa({ nome, tituloVaga }) {
  const ola = nome ? `Olá, ${escapeHtml(nomeCurto(nome))},` : 'Olá,';
  const vaga = escapeHtml(tituloVaga);

  return `
  <div style="margin:0;padding:24px;background:#0D0B0A;font-family:'Barlow',Arial,Helvetica,sans-serif;color:#F4F3F1;">
    <div style="max-width:520px;margin:0 auto;">
      <h1 style="font-family:'Barlow Condensed','Barlow',Arial,sans-serif;font-weight:700;color:#FF5500;font-size:24px;margin:0 0 16px;">${ola}</h1>
      <p style="font-size:16px;line-height:1.5;margin:0 0 16px;">Obrigado pelo interesse na vaga de <strong>${vaga}</strong> e pelo tempo dedicado ao nosso processo seletivo.</p>
      <p style="font-size:16px;line-height:1.5;margin:0 0 16px;">Após a análise das etapas concluídas, seguiremos com outros candidatos cujo perfil está mais alinhado ao que buscamos neste momento.</p>
      <p style="font-size:16px;line-height:1.5;margin:0 0 16px;">Sua candidatura permanece em nosso banco de talentos e podemos entrar em contato caso surja uma oportunidade compatível.</p>
      <p style="font-size:16px;line-height:1.5;margin:0 0 24px;">Desejamos sucesso na sua trajetória.</p>
      <p style="font-size:16px;line-height:1.5;margin:0;"><strong>Equipe Vendedor Mestre</strong></p>
    </div>
  </div>`;
}

// Envia a recusa de UM candidato e, so em caso de sucesso, marca a coluna.
// Retorna true se marcou. Erro NUNCA propaga: loga e devolve false — a varredura segue
// para o proximo e este candidato e tentado de novo no proximo ciclo (a coluna continua
// NULL, entao ele volta a aparecer na query).
async function enviarParaCandidato(linha) {
  const vaga = linha.job_id ? db.obterVaga(linha.job_id) : null;
  const tituloVaga = (vaga && vaga.titulo) || 'a vaga';
  const assunto = assuntoRecusa(tituloVaga);
  const html = montarEmailRecusa({ nome: linha.nome, tituloVaga });

  try {
    if (config.entrevista.mock) {
      // Mesmo padrao de relatorio.js e followupEntrevista: em mock NAO toca o Resend.
      console.log(`[recusa] (mock) e-mail NAO enviado. destinatario=${linha.email} vaga="${tituloVaga}"`);
    } else {
      await entrevista.comTimeout(
        email.enviar(linha.email, assunto, html),
        config.entrevista.timeoutMs,
        'Resend',
      );
    }
    // So aqui, DEPOIS do envio (ou do log em mock). Em mock marcamos tambem, senao a
    // varredura relogaria os mesmos candidatos a cada ciclo.
    db.marcarEmailRecusaEnviado(linha.id);
    return true;
  } catch (err) {
    console.error(`[recusa] falha ao enviar e-mail (application_id=${linha.id}): ${err.message}`);
    return false;
  }
}

// Uma passada completa. Sequencial de proposito: o volume e baixo e assim nao abrimos
// dezenas de conexoes simultaneas com o Resend.
// Retorna { enviados, falhas } (numeros), util para log e para teste.
async function varrer() {
  const resumo = { enviados: 0, falhas: 0 };

  // Interruptor geral checado ANTES de qualquer acesso ao banco de candidatos: enquanto
  // desligado, o ciclo custa praticamente nada.
  if (!ativo()) {
    console.log('[recusa] desativado em /admin/config; ciclo pulado.');
    return { ...resumo, desativado: true };
  }

  let pendentes = [];
  try {
    pendentes = db.listarPendentesEmailRecusa({
      horasCarencia: HORAS_CARENCIA,
      limite: ENVIOS_POR_CICLO,
    });
  } catch (err) {
    console.error(`[recusa] falha ao consultar pendentes: ${err.message}`);
    return resumo;
  }

  for (const linha of pendentes) {
    const ok = await enviarParaCandidato(linha);
    if (ok) resumo.enviados += 1;
    else resumo.falhas += 1;
  }

  if (resumo.enviados || resumo.falhas) {
    console.log(`[recusa] varredura concluida — enviados: ${resumo.enviados}, falhas: ${resumo.falhas}`);
  }
  return resumo;
}

// ── Trava em memoria contra execucoes sobrepostas ──
// Mesma razao do follow-up: a passada do boot e as do setInterval compartilham a MESMA
// trava. Se um ciclo demorar mais que o intervalo, o proximo tick e descartado (nao
// enfileirado) — a varredura e idempotente e o ciclo seguinte pega o que sobrou. Vale so
// dentro deste processo; a garantia real contra e-mail duplicado e a coluna no banco.
let varrendo = false;

async function varrerSeOcioso() {
  if (varrendo) {
    console.warn('[recusa] varredura anterior ainda em andamento; ciclo ignorado.');
    return null;
  }
  varrendo = true;
  try {
    return await varrer();
  } catch (err) {
    // Defensivo: varrer() ja captura os erros esperados. Se algo escapar, o agendador
    // NAO pode morrer nem deixar a trava presa.
    console.error(`[recusa] erro inesperado na varredura: ${err.message}`);
    return null;
  } finally {
    varrendo = false;
  }
}

module.exports = {
  varrer,
  varrerSeOcioso,
  montarEmailRecusa,
  assuntoRecusa,
  ativo,
  CHAVE_ATIVO,
  HORAS_CARENCIA,
  ENVIOS_POR_CICLO,
};
