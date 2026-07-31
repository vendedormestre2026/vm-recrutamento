'use strict';

// Lembrete de INICIO de entrevista: avisa quem se candidatou mas nunca abriu a entrevista.
//
// PROBLEMA QUE RESOLVE — 174 de 227 candidaturas em vagas com entrevista ativa nunca
// criam uma linha em interviews: 93% de todo o vazamento do funil acontece entre o envio
// do formulario e o inicio da entrevista. Dessas, 173 nunca receberam nenhum lembrete: o
// follow-up existente exige status='em_entrevista' e, por construcao, nao as alcanca
// (o proprio codigo dele diz: "Quem esta 'aplicado' (nunca comecou) NAO entra").
//
// TERCEIRA varredura do projeto, com interruptor e agendamento proprios. A anatomia e a
// mesma de followupEntrevista e emailRecusa — toggle no painel, trava em memoria contra
// ciclos sobrepostos, idempotencia por coluna, marcacao so apos sucesso, degradacao em
// mock —, mas os tres publicos sao disjuntos e cada um precisa poder ser ligado e
// desligado sem mexer nos outros:
//   followupEntrevista -> comecou a entrevista e parou no meio
//   lembreteInicio     -> nunca comecou a entrevista            (este arquivo)
//   emailRecusa        -> terminou e foi descartado
//
// TOM DO E-MAIL: lembrete simples e util. Nao menciona avaliacao, nota, IA nem qualquer
// julgamento — o candidato ainda nem foi avaliado. E so "faltou concluir, aqui esta o
// link". Um unico envio por candidato, para nao virar cobranca.

const { config } = require('../config');
const db = require('../db');
const email = require('../providers/email');
const entrevista = require('./entrevista');
const { escapeHtml } = require('../views');

// Interruptor GERAL do subsistema (painel: /admin/config). Default FALSE: nasce desligado
// e nao envia nada ate alguem ligar conscientemente. Mesma chave lida por routes/admin.js.
const CHAVE_ATIVO = 'lembrete_inicio_ativo';

function ativo() {
  return db.obterConfigBool(CHAVE_ATIVO, false);
}

// Horas entre a candidatura e o lembrete. Curto de proposito: quem se candidata e nao
// entra na entrevista costuma desistir na mesma sessao (falta de tempo, de fone, de um
// lugar silencioso). Lembrar no mesmo dia pega a pessoa com a vaga ainda fresca —
// esperar 24h como o follow-up seria tarde demais para este publico.
const HORAS_ESPERA_LEMBRETE = 3;

// Teto de envios por ciclo. Protecao contra disparo em massa: o backlog atual e de ~173
// candidatos, e sem teto o primeiro ciclo apos ligar o interruptor mandaria tudo de uma
// vez. Com 20, drena em ~9 ciclos (pouco mais de 2h) e da tempo de ver o resultado dos
// primeiros e desligar no painel se algo estiver errado.
const ENVIOS_POR_CICLO = 20;

function nomeCurto(nome) {
  const primeiro = String(nome || '').trim().split(/\s+/)[0];
  return primeiro || '';
}

// Assunto: direto ao ponto, sem alarme. Fala da ETAPA que ficou em aberto, nao de
// "concluir a candidatura" — a entrevista e a SEGUNDA etapa do processo, nao a ultima,
// e o e-mail nao pode sugerir que terminar a entrevista encerra a selecao.
function assuntoLembrete(tituloVaga) {
  return `Sua entrevista para ${tituloVaga} ainda está em aberto`;
}

// HTML do lembrete. Mesma identidade visual dos demais e-mails ao candidato (fundo
// #0D0B0A, laranja #FF5500, texto #F4F3F1, Barlow com fallbacks, max-width 520px) — o
// molde vem de followupEntrevista.montarEmailFollowup, inclusive o botao de CTA e a lista
// "o que acontece ao clicar", que aqui serve para tirar o medo da etapa em aberto.
//
// A copy NUNCA chama a entrevista de etapa final: ela e a SEGUNDA etapa do processo, e
// dizer o contrario criaria uma expectativa falsa de que terminar a entrevista encerra
// a selecao.
// escapeHtml em TODO dado que vem do candidato ou da vaga.
function montarEmailLembrete({ nome, tituloVaga, link }) {
  const ola = nome ? `Olá, ${escapeHtml(nomeCurto(nome))}!` : 'Olá!';
  const vaga = escapeHtml(tituloVaga);

  return `
  <div style="margin:0;padding:24px;background:#0D0B0A;font-family:'Barlow',Arial,Helvetica,sans-serif;color:#F4F3F1;">
    <div style="max-width:520px;margin:0 auto;">
      <h1 style="font-family:'Barlow Condensed','Barlow',Arial,sans-serif;font-weight:700;color:#FF5500;font-size:24px;margin:0 0 16px;">${ola}</h1>
      <p style="font-size:16px;line-height:1.5;margin:0 0 16px;">Recebemos sua candidatura para a vaga de <strong>${vaga}</strong>. A entrevista é a segunda etapa do seu processo, e ela ainda está em aberto.</p>
      <p style="font-size:16px;line-height:1.5;margin:0 0 24px;">São poucos minutos, direto do celular ou do computador, na hora que for melhor para você. É só clicar no botão abaixo.</p>
      <p style="margin:0 0 24px;">
        <a href="${link}" style="display:inline-block;background:#FF5500;color:#0D0B0A;text-decoration:none;font-family:'Barlow Condensed','Barlow',Arial,sans-serif;font-weight:700;font-size:18px;padding:14px 28px;border-radius:8px;">Fazer minha entrevista</a>
      </p>
      <p style="font-size:15px;line-height:1.5;margin:0 0 8px;"><strong>O que acontece ao clicar:</strong></p>
      <ul style="font-size:15px;line-height:1.6;margin:0 0 24px;padding-left:20px;">
        <li>Você entra direto na sua candidatura, sem precisar de senha nem código.</li>
        <li>A conversa é com a Vera, nossa entrevistadora virtual: ela pergunta por voz e você responde falando.</li>
        <li>Autorize a câmera e o microfone quando o navegador pedir — a entrevista é gravada em vídeo.</li>
        <li>Prefira um lugar silencioso e uma conexão estável.</li>
      </ul>
      <p style="font-size:14px;line-height:1.5;margin:0 0 24px;">Se o botão não funcionar, copie e cole este link no navegador:<br><span style="color:#FF5500;">${link}</span></p>
      <p style="font-size:16px;line-height:1.5;margin:0 0 4px;">Se tiver qualquer dúvida, responda este e-mail.</p>
      <p style="font-size:16px;line-height:1.5;margin:16px 0 0;">Até logo,<br><strong>Equipe Vendedor Mestre</strong></p>
    </div>
  </div>`;
}

// Envia o lembrete de UM candidato e, so em caso de sucesso, marca a coluna.
// Retorna true se marcou. Erro NUNCA propaga: loga e devolve false — a varredura segue
// para o proximo e este candidato e tentado de novo no proximo ciclo (a coluna continua
// NULL, entao ele volta a aparecer na query).
async function enviarParaCandidato(linha) {
  const vaga = linha.job_id ? db.obterVaga(linha.job_id) : null;
  const tituloVaga = (vaga && vaga.titulo) || 'a vaga';
  // Mesmo formato de link dos demais fluxos de retomada (api.js:411,
  // followupEntrevista.js:118): /retomar valida o token, restaura o cookie de sessao e
  // manda direto para /permissao-camera, sem passar pela tela de identificacao.
  const link = `${config.baseUrl}/retomar?token=${encodeURIComponent(linha.token)}`;
  const assunto = assuntoLembrete(tituloVaga);
  const html = montarEmailLembrete({ nome: linha.nome, tituloVaga, link });

  try {
    if (config.entrevista.mock) {
      // Mesmo padrao de relatorio.js, followupEntrevista e emailRecusa: em mock NAO toca
      // o Resend.
      console.log(`[lembrete] (mock) e-mail NAO enviado. destinatario=${linha.email} link=${link}`);
    } else {
      await entrevista.comTimeout(
        email.enviar(linha.email, assunto, html),
        config.entrevista.timeoutMs,
        'Resend',
      );
    }
    // So aqui, DEPOIS do envio (ou do log em mock). Em mock marcamos tambem, senao a
    // varredura relogaria os mesmos candidatos a cada ciclo.
    db.marcarLembreteInicioEnviado(linha.id);
    return true;
  } catch (err) {
    console.error(`[lembrete] falha ao enviar e-mail (application_id=${linha.id}): ${err.message}`);
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
    console.log('[lembrete] desativado em /admin/config; ciclo pulado.');
    return { ...resumo, desativado: true };
  }

  let pendentes = [];
  try {
    pendentes = db.listarPendentesLembreteInicio({
      horasEspera: HORAS_ESPERA_LEMBRETE,
      limite: ENVIOS_POR_CICLO,
    });
  } catch (err) {
    console.error(`[lembrete] falha ao consultar pendentes: ${err.message}`);
    return resumo;
  }

  for (const linha of pendentes) {
    const ok = await enviarParaCandidato(linha);
    if (ok) resumo.enviados += 1;
    else resumo.falhas += 1;
  }

  if (resumo.enviados || resumo.falhas) {
    console.log(`[lembrete] varredura concluida — enviados: ${resumo.enviados}, falhas: ${resumo.falhas}`);
  }
  return resumo;
}

// ── Trava em memoria contra execucoes sobrepostas ──
// Mesma razao dos outros dois modulos: a passada do boot e as do setInterval compartilham
// a MESMA trava. Se um ciclo demorar mais que o intervalo, o proximo tick e descartado
// (nao enfileirado) — a varredura e idempotente e o ciclo seguinte pega o que sobrou.
// Vale so dentro deste processo; a garantia real contra e-mail duplicado e a coluna.
let varrendo = false;

async function varrerSeOcioso() {
  if (varrendo) {
    console.warn('[lembrete] varredura anterior ainda em andamento; ciclo ignorado.');
    return null;
  }
  varrendo = true;
  try {
    return await varrer();
  } catch (err) {
    // Defensivo: varrer() ja captura os erros esperados. Se algo escapar, o agendador
    // NAO pode morrer nem deixar a trava presa.
    console.error(`[lembrete] erro inesperado na varredura: ${err.message}`);
    return null;
  } finally {
    varrendo = false;
  }
}

module.exports = {
  varrer,
  varrerSeOcioso,
  montarEmailLembrete,
  assuntoLembrete,
  ativo,
  CHAVE_ATIVO,
  HORAS_ESPERA_LEMBRETE,
  ENVIOS_POR_CICLO,
};
