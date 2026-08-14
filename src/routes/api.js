'use strict';

// Rotas de API (JSON).
// Fase 1B: POST /api/aplicacao implementado (upload de PDF + extracao + persistencia).
// As demais rotas seguem como stubs (501) ate suas fases.

const express = require('express');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const multer = require('multer');

const { config } = require('../config');
const db = require('../db');
const session = require('../lib/session');
const sequenciaWhatsapp = require('../whatsapp/sequenciaOutbox');
const { extrairTextoPdf } = require('../lib/curriculo');
const entrevista = require('../lib/entrevista');
const { modoEntrevistaAtivo } = require('../lib/modo');
const { lerUtmDoCookie } = require('../lib/utm');
const { removerAudioDaEntrevista } = require('../lib/audioEntrevista');
// Adaptadores agnosticos (interface). Os SDKs/chaves so sao tocados quando
// INTERVIEW_MOCK=false; em mock estes modulos nem sao exercitados.
const llm = require('../providers/llm');
const { calcularCustoDeepSeek } = require('../lib/custos');
const stt = require('../providers/stt');
const tts = require('../providers/tts');
const drive = require('../providers/drive');
const email = require('../providers/email');
// Alias do MESMO provider (modulo cacheado): dentro do handler POST /aplicacao a var
// local "email" (e-mail do candidato) sombreia o import acima, entao o disparo ao
// recrutador precisa de um nome nao-sombreado. Mesma convencao de api_banco_curriculos.js.
const emailProvider = require('../providers/email');
const { escapeHtml } = require('../views');

const router = express.Router();

// Nao reenviar o e-mail de retomada se ja foi enviado nos ultimos 30 minutos.
const RETOMADA_THROTTLE_MS = 30 * 60 * 1000;

// Chave que liga/desliga o e-mail "Nova candidatura" ao recrutador (store de
// configuracoes; editavel em /admin/config). Default FALSE: desligado. A mesma string
// aparece em routes/admin.js, que expoe o checkbox — mesma convencao ja usada por
// entrevista_automatica_geral (lida por lib/modo.js, escrita pelo painel).
const CHAVE_NOTIFICAR_NOVA_CANDIDATURA = 'notificar_recrutador_nova_candidatura';

const MAX_PDF_BYTES = 10 * 1024 * 1024; // 10 MB
const MAX_AUDIO_BYTES = 25 * 1024 * 1024; // 25 MB (resposta de audio push-to-talk)
const MAX_VIDEO_BYTES = 300 * 1024 * 1024; // 300 MB (gravacao da entrevista inteira)
const VIDEO_UPLOAD_TIMEOUT_MS = 5 * 60 * 1000; // teto do upload ao Drive (~5 min)

// Upload em memoria: validamos tipo/tamanho e so gravamos no disco depois de
// gerar o token (o nome do arquivo e <token>.pdf).
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_PDF_BYTES },
  fileFilter(req, file, cb) {
    const ehPdf = file.mimetype === 'application/pdf' && /\.pdf$/i.test(file.originalname);
    if (!ehPdf) {
      const erro = new Error('Envie o currículo em formato PDF.');
      erro.code = 'TIPO_INVALIDO';
      return cb(erro);
    }
    cb(null, true);
  },
}).single('curriculo');

// Upload do audio de resposta (push-to-talk). Aceita audio/* (webm/ogg/mp4...).
const uploadAudio = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_AUDIO_BYTES },
  fileFilter(req, file, cb) {
    if (!/^audio\//.test(file.mimetype)) {
      const erro = new Error('Formato de áudio inválido.');
      erro.code = 'TIPO_INVALIDO';
      return cb(erro);
    }
    cb(null, true);
  },
}).single('audio');

// (O video da entrevista NAO usa multer: e recebido como corpo cru da requisicao —
// ver POST /interview/video-upload. Isso evita a corrupcao do Content-Type de partes
// multipart pelo edge do Railway, que fazia o multer receber "text/plain".)

// Remove um arquivo temporario sem nunca lancar (best-effort).
function removerTemp(caminho) {
  try {
    if (caminho && fs.existsSync(caminho)) fs.unlinkSync(caminho);
  } catch (e) {
    console.error('[video-upload] falha ao remover arquivo temporário:', e.message);
  }
}

// (removerAudioDaEntrevista vivia aqui; agora e compartilhada em lib/audioEntrevista.js
// — o POST /interview/video-upload segue sendo um dos chamadores, sem mudanca.)

// Nome legivel do arquivo no Drive: entrevista-<id>-<nome-do-candidato>.<ext>
function nomeVideoDrive(candidato, interviewId, caminho) {
  const ext = /\.mp4$/i.test(caminho) ? 'mp4' : 'webm';
  const nome =
    [candidato.nome, candidato.sobrenome]
      .filter(Boolean)
      .join('-')
      .normalize('NFD')
      .replace(/[^\w-]+/g, '') || 'candidato';
  return `entrevista-${interviewId}-${nome}.${ext}`;
}

function emailValido(valor) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(valor);
}

// Exige candidato identificado (versao API: responde 401 JSON em vez de redirecionar).
function candidatoApi(req, res) {
  const candidato = session.loadCandidato(req);
  if (!candidato) {
    res.status(401).json({ ok: false, erro: 'Sessão expirada. Faça a identificação novamente.' });
    return null;
  }
  return candidato;
}

function naoImplementado(fase) {
  return (req, res) => {
    res.status(501).json({
      ok: false,
      erro: 'nao_implementado',
      mensagem: `${req.method} ${req.baseUrl}${req.path} sera implementado na ${fase}.`,
    });
  };
}

// ── POST /api/aplicacao ──
router.post('/aplicacao', (req, res) => {
  upload(req, res, async (err) => {
    // Erros de upload (multer) -> mensagens em PT-BR
    if (err) {
      if (err.code === 'LIMIT_FILE_SIZE') {
        return res.status(400).json({ ok: false, erro: 'O currículo deve ter no máximo 10 MB.' });
      }
      if (err.code === 'TIPO_INVALIDO') {
        return res.status(400).json({ ok: false, erro: err.message });
      }
      return res
        .status(400)
        .json({ ok: false, erro: 'Não foi possível processar o upload do currículo.' });
    }

    try {
      const b = req.body || {};
      const nome = String(b.nome || '').trim();
      const sobrenome = String(b.sobrenome || '').trim();
      const email = String(b.email || '').trim();
      const ddi = String(b.ddi || '+55').trim();
      const telefoneNum = String(b.telefone || '').trim();
      const linkedin = String(b.linkedin_url || '').trim();

      // Validacao no servidor (a validacao do front e so conveniencia)
      const faltando = [];
      if (!nome) faltando.push('nome');
      if (!sobrenome) faltando.push('sobrenome');
      if (!email) faltando.push('e-mail');
      if (!telefoneNum) faltando.push('telefone');
      if (faltando.length) {
        return res
          .status(400)
          .json({ ok: false, erro: `Preencha os campos obrigatórios: ${faltando.join(', ')}.` });
      }
      if (!emailValido(email)) {
        return res.status(400).json({ ok: false, erro: 'Informe um e-mail válido.' });
      }
      if (!req.file) {
        return res.status(400).json({ ok: false, erro: 'Anexe seu currículo em PDF.' });
      }
      // Consentimento LGPD (obrigatorio): o checkbox da tela de aplicacao. A validacao
      // do front e so conveniencia; aqui e a barreira de verdade.
      const consentiu = ['on', '1', 'true'].includes(String(b.consentimento || '').toLowerCase());
      if (!consentiu) {
        return res.status(400).json({
          ok: false,
          erro: 'É necessário aceitar a coleta e uso dos seus dados para se candidatar.',
        });
      }

      // Resolve a vaga (pelo slug enviado; senao, a vaga ativa)
      const slug = String(b.slug || '').trim();
      const vaga = slug ? db.obterVagaPorSlug(slug) : db.obterVagaAtiva();
      if (!vaga) {
        return res
          .status(400)
          .json({ ok: false, erro: 'Vaga não encontrada para esta candidatura.' });
      }

      const telefone = `${ddi} ${telefoneNum}`.trim();

      // Origem do lead (first-touch): le o cookie vm_utm com o helper (JSON dos cinco
      // parametros UTM; retrocompativel com o formato legado de string simples). Ausente
      // (acesso direto, sem UTM) -> source 'direto'; os demais UTM ficam null. cookie-parser
      // ja roda no app (server.js).
      const utm = lerUtmDoCookie((req.cookies && req.cookies.vm_utm) || '');
      const utmSource = (utm && utm.source) || 'direto';

      const token = session.gerarToken();

      // Salva o PDF no volume persistente (cria a pasta se nao existir)
      fs.mkdirSync(config.caminhoCurriculos, { recursive: true });
      const caminhoPdf = path.join(config.caminhoCurriculos, `${token}.pdf`);
      fs.writeFileSync(caminhoPdf, req.file.buffer);

      // Extrai o texto do PDF (truncado em ~20.000 caracteres no helper)
      const curriculoTexto = await extrairTextoPdf(req.file.buffer);

      // Persiste a application pela camada de dados agnostica
      const applicationId = db.criarAplicacao({
        job_id: vaga.id,
        nome,
        sobrenome,
        email,
        telefone,
        linkedin_url: linkedin,
        curriculo_path: caminhoPdf,
        curriculo_texto: curriculoTexto,
        token,
        utm_source: utmSource,
        utm_medium: utm ? utm.medium : null,
        utm_campaign: utm ? utm.campaign : null,
        utm_content: utm ? utm.content : null,
        utm_term: utm ? utm.term : null,
        status: 'aplicado',
      });

      // ── Sequencia de WhatsApp (WA1 agora, WA2 em +4h) — fire-and-forget ──
      //
      // LOGO APOS a criacao, e nao dentro de uma transacao com ela: criarAplicacao e um
      // INSERT unico (better-sqlite3 auto-commit), entao nao ha transacao envolvente para
      // entrar. Conferido no diagnostico.
      //
      // agendarSequencia NUNCA lanca — o try/catch mora dentro dela. Mesmo principio do
      // middleware de funil: perder um agendamento e barato, travar um candidato no meio do
      // cadastro nao e. Se o interruptor estiver desligado, ela simplesmente nao cria linha.
      sequenciaWhatsapp.agendarSequencia({
        id: applicationId,
        nome,
        telefone,
        criado_em: new Date().toISOString(),
      });

      // DEV ONLY: loga o token para testar a tela de Identificacao depois.
      // IMPORTANTE: nao logar token de candidato em producao (dado sensivel).
      if (!config.ehProducao) {
        console.log(
          `[dev] application criada — token=${token} (use em /identificacao). Este log NAO ocorre em producao.`,
        );
      }

      // ── E-mail ao recrutador (Resend) — fire-and-forget ──────────────────────────
      // DESLIGADO POR PADRAO. O envio inteiro fica atras da chave de configuracao
      // notificar_recrutador_nova_candidatura (painel: /admin/config). Default false:
      // sem nenhuma acao manual, esta notificacao para de sair. O codigo NAO foi
      // removido — religar a chave restaura o comportamento identico ao de antes
      // (mesmo destinatario, assunto, corpo e fire-and-forget).
      //
      // Avisa o recrutador da nova candidatura com todos os campos + link do painel.
      // Falha (ou provider indisponivel) SO loga: nunca quebra nem atrasa a criacao da
      // candidatura nem a resposta ao candidato (mesmo padrao de api_banco_curriculos.js).
      // Destino SO de config.recrutador.email (env RECRUITER_EMAIL); vazio -> pula.
      if (db.obterConfigBool(CHAVE_NOTIFICAR_NOVA_CANDIDATURA, false)) {
        const destinoRecrutador = config.recrutador.email;
        if (destinoRecrutador) {
          const linkAdmin = `${config.baseUrl}/admin/candidato/${applicationId}`;
          const linha = (rotulo, valor) =>
            `<tr><td style="padding:4px 8px;font-weight:bold">${rotulo}</td><td style="padding:4px 8px">${escapeHtml(valor || '—')}</td></tr>`;
          const assuntoRecrutador = `Nova candidatura — ${vaga.titulo}: ${nome} ${sobrenome}`;
          const htmlRecrutador = `
            <h2>Nova candidatura</h2>
            <p>Vaga: <strong>${escapeHtml(vaga.titulo)}</strong></p>
            <table style="border-collapse:collapse">
              ${linha('Nome', `${nome} ${sobrenome}`.trim())}
              ${linha('E-mail', email)}
              ${linha('Telefone', telefone)}
              ${linha('LinkedIn', linkedin)}
              ${linha('Origem (utm_source)', utmSource)}
            </table>
            <p><a href="${linkAdmin}">Abrir candidatura no painel</a></p>`;
          emailProvider
            .enviar(destinoRecrutador, assuntoRecrutador, htmlRecrutador)
            .catch((erroEmail) => {
              console.error(
                `[api/aplicacao] falha ao enviar e-mail ao recrutador: ${erroEmail.message}`,
              );
            });
        } else {
          console.warn('[api/aplicacao] RECRUITER_EMAIL ausente; e-mail ao recrutador nao enviado.');
        }
      }

      // Grava a sessao do candidato e bifurca o funil (Func. 2), com a decisao
      // centralizada em lib/modo: modo COMPLETO -> /preparacao/:slug (entrevista, URL
      // por etapa p/ rastreio no GTM); modo SIMPLES -> /confirmacao/:slug (so WhatsApp).
      session.setToken(res, token);
      const destino = modoEntrevistaAtivo(vaga)
        ? `/preparacao/${vaga.slug}`
        : `/confirmacao/${vaga.slug}`;
      return res.json({ ok: true, redirect: destino });
    } catch (erro) {
      console.error('[api/aplicacao] erro:', erro.message);
      return res
        .status(500)
        .json({ ok: false, erro: 'Erro interno ao registrar a candidatura. Tente novamente.' });
    }
  });
});

// ── POST /api/consentimento-gravacao ──
// Registra o aceite dos termos de gravacao (LGPD) no avanco do teste de microfone.
// O front chama antes de navegar para /entrevista (o "Continuar" so habilita com o
// checkbox marcado). Idempotente no banco: preserva o 1o aceite.
router.post('/consentimento-gravacao', (req, res) => {
  const candidato = candidatoApi(req, res);
  if (!candidato) return undefined;

  const b = req.body || {};
  const consentiu = ['on', '1', 'true'].includes(String(b.consentimento || '').toLowerCase());
  if (!consentiu) {
    return res.status(400).json({
      ok: false,
      erro: 'É necessário aceitar os termos de gravação para continuar.',
    });
  }

  db.registrarConsentGravacao(candidato.id);
  return res.json({ ok: true });
});

// Estimativa de duracao (faixa em minutos) a partir do roteiro. Espelha a logica da
// pagina de preparacao (pages.js) para que o e-mail prometa o mesmo tempo da tela.
function estimarDuracaoMin(roteiro) {
  const n = entrevista.montarPerguntas(roteiro).length;
  const base = n > 1 ? n : 6;
  const min = Math.max(10, Math.round(base * 1.5));
  const max = Math.max(min, Math.round(base * 2));
  return { min, max };
}

// HTML do e-mail de retomada ("continuar depois"). Identidade visual: preto #0D0B0A,
// laranja #FF5500, off-white #F4F3F1, Barlow/Barlow Condensed (com fallbacks p/ e-mail).
function montarEmailRetomada({ nome, tituloVaga, min, max, link }) {
  const ola = nome ? `Olá, ${escapeHtml(nome)}!` : 'Olá!';
  const titulo = escapeHtml(tituloVaga);
  return `
  <div style="margin:0;padding:24px;background:#0D0B0A;font-family:'Barlow',Arial,Helvetica,sans-serif;color:#F4F3F1;">
    <div style="max-width:520px;margin:0 auto;">
      <h1 style="font-family:'Barlow Condensed','Barlow',Arial,sans-serif;font-weight:700;color:#FF5500;font-size:24px;margin:0 0 16px;">${ola}</h1>
      <p style="font-size:16px;line-height:1.5;margin:0 0 16px;">Você iniciou sua candidatura para a vaga de <strong>${titulo}</strong> no Vendedor Mestre, mas sua entrevista ainda não foi realizada.</p>
      <p style="font-size:16px;line-height:1.5;margin:0 0 24px;">A entrevista é conduzida pela Vera, nossa agente de recrutamento por vídeo e áudio, e leva aproximadamente ${min}–${max} minutos.</p>
      <p style="margin:0 0 24px;">
        <a href="${link}" style="display:inline-block;background:#FF5500;color:#0D0B0A;text-decoration:none;font-family:'Barlow Condensed','Barlow',Arial,sans-serif;font-weight:700;font-size:18px;padding:14px 28px;border-radius:8px;">Continuar minha entrevista</a>
      </p>
      <p style="font-size:14px;line-height:1.5;margin:0 0 24px;">Se o botão não funcionar, copie e cole este link no navegador:<br><span style="color:#FF5500;">${link}</span></p>
      <p style="font-size:16px;line-height:1.5;margin:0 0 4px;">Se tiver qualquer dúvida, responda este e-mail.</p>
      <p style="font-size:16px;line-height:1.5;margin:16px 0 0;">Até logo,<br><strong>Equipe Vendedor Mestre</strong></p>
    </div>
  </div>`;
}

// ── POST /api/retomar-depois ──
// Camera obrigatoria: se o candidato nao consegue/permite a camera, manda um link de
// retomada por e-mail (GET /retomar -> /permissao-camera). Throttle de 30 min via
// applications.enviado_retomada_em (nao reenvia em rajada). Em mock NAO toca o Resend.
router.post('/retomar-depois', async (req, res) => {
  const candidato = candidatoApi(req, res);
  if (!candidato) return undefined;

  // Throttle: enviado ha menos de 30 min -> nao reenvia (resposta idempotente p/ a UI).
  if (
    candidato.enviado_retomada_em &&
    entrevista.decorridoMs(candidato.enviado_retomada_em) < RETOMADA_THROTTLE_MS
  ) {
    return res.json({ ok: true, ja_enviado: true });
  }

  if (!candidato.email) {
    return res
      .status(400)
      .json({ ok: false, erro: 'Não há e-mail cadastrado para enviar o link de retomada.' });
  }

  const vaga = db.obterVaga(candidato.job_id);
  const tituloVaga = (vaga && vaga.titulo) || 'a vaga';
  const roteiro = roteiroDaVaga(vaga);
  const { min, max } = estimarDuracaoMin(roteiro);
  const link = `${config.baseUrl}/retomar?token=${encodeURIComponent(candidato.token)}`;
  const assunto = `Sua entrevista para ${tituloVaga} está esperando por você`;
  const html = montarEmailRetomada({ nome: candidato.nome, tituloVaga, min, max, link });

  try {
    if (config.entrevista.mock) {
      console.log(
        `[retomar-depois] (mock) e-mail NAO enviado. destinatario=${candidato.email} link=${link}`,
      );
    } else {
      await entrevista.comTimeout(
        email.enviar(candidato.email, assunto, html),
        config.entrevista.timeoutMs,
        'provedor de e-mail',
      );
    }
    db.marcarRetomadaEnviada(candidato.id);
    return res.json({ ok: true });
  } catch (err) {
    console.error(
      `[retomar-depois] falha ao enviar e-mail (application_id=${candidato.id}): ${err.message}`,
    );
    return res
      .status(502)
      .json({ ok: false, erro: 'Não foi possível enviar o e-mail agora. Tente novamente.' });
  }
});

// ── POST /api/identificacao ──
// Recupera a application por email + codigo (token). Restaura a sessao.
//
// TODO (Fase 4): o codigo/link de acesso sera enviado ao candidato por e-mail
// (Resend). Por enquanto, o codigo e o token logado em dev pelo POST /api/aplicacao.
// IMPORTANTE: nunca autenticar so por e-mail — exigimos email E token corretos
// para evitar acesso indevido a candidaturas de terceiros.
router.post('/identificacao', (req, res) => {
  const email = String((req.body && req.body.email) || '').trim().toLowerCase();
  const codigo = String((req.body && req.body.codigo) || '').trim();

  if (!email || !codigo) {
    return res.status(400).json({ ok: false, erro: 'Informe e-mail e código de acesso.' });
  }

  // Busca pela camada de dados (por token) e confere o e-mail como segundo fator.
  const aplicacao = db.obterAplicacaoPorToken(codigo);
  const emailConfere =
    aplicacao && String(aplicacao.email || '').trim().toLowerCase() === email;

  if (!aplicacao || !emailConfere) {
    return res
      .status(400)
      .json({ ok: false, erro: 'Não encontramos uma candidatura com esses dados.' });
  }

  session.setToken(res, aplicacao.token);
  // Redireciona para a /preparacao/:slug da vaga da aplicacao (URL por etapa).
  // Se a vaga nao for encontrada (caso raro), cai na /preparacao sem slug.
  const vaga = db.obterVaga(aplicacao.job_id);
  const destino = vaga && vaga.slug ? `/preparacao/${vaga.slug}` : '/preparacao';
  return res.json({ ok: true, redirect: destino });
});

// Resolve o roteiro de uma vaga (ou null).
function roteiroDaVaga(vaga) {
  return vaga && vaga.roteiro_id ? db.obterRoteiro(vaga.roteiro_id) : null;
}

// Interpola placeholders do roteiro com dados reais: [nome] (case-insensitive) -> primeiro
// nome do candidato; [nome da empresa] -> nome resolvido da empresa da vaga (item 7.4;
// fallback neutro "a empresa"). Novos placeholders entram aqui.
function interpolarTexto(texto, candidato, vaga) {
  const nome = String((candidato && candidato.nome) || '').trim();
  return entrevista.interpolarEmpresa(String(texto || ''), vaga).replace(/\[nome\]/gi, nome);
}

// Perguntas do roteiro com os placeholders ja interpolados ([nome], [nome da empresa]).
// Usado em vez de entrevista.montarPerguntas direto, para que a abertura e as demais
// perguntas roteirizadas saiam com o nome real do candidato e da empresa (gravadas,
// faladas e exibidas).
function perguntasInterpoladas(roteiro, candidato, vaga) {
  return entrevista.montarPerguntas(roteiro).map((p) => ({
    ...p,
    texto: interpolarTexto(p.texto, candidato, vaga),
  }));
}

// Sintetiza a fala da Vera (TTS real), salva o MP3 no volume e devolve a URL servida.
async function sintetizarESalvar(texto, interviewId, ordem) {
  const { audio } = await entrevista.comTimeout(
    tts.sintetizar(texto, {}),
    config.entrevista.timeoutMs,
    'TTS Google',
  );
  const dir = path.join(config.caminhoEntrevistas, String(interviewId));
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${ordem}.mp3`), audio);
  return `/api/interview/audio/${interviewId}/${ordem}.mp3`;
}

// Audio fixo "nao consegui ouvir": gera via TTS e cacheia UMA vez.
function caminhoNaoOuvi() {
  return path.join(config.caminhoEntrevistas, '_cache', 'nao-ouvi.mp3');
}
async function garantirNaoOuvi() {
  const caminho = caminhoNaoOuvi();
  if (fs.existsSync(caminho)) return;
  const { audio } = await entrevista.comTimeout(
    tts.sintetizar(entrevista.FRASE_NAO_OUVI, {}),
    config.entrevista.timeoutMs,
    'TTS Google',
  );
  fs.mkdirSync(path.dirname(caminho), { recursive: true });
  fs.writeFileSync(caminho, audio);
}

// Reconstroi o payload do ESTADO ATUAL de uma entrevista a partir dos turnos ja
// salvos — sem chamar nenhum provedor (STT/LLM/TTS) e sem criar turnos.
// Usado por: (1) retomada ao recarregar a pagina; (2) idempotencia (retry com o
// mesmo tentativa_id devolve o mesmo estado, sem duplicar turnos).
function payloadEstadoAtual(interviewRow) {
  const interviewId = interviewRow.id;
  const roteiro = interviewRow.roteiro_id ? db.obterRoteiro(interviewRow.roteiro_id) : null;
  const perguntas = entrevista.montarPerguntas(roteiro);

  const turns = db.listarTurnos(interviewId); // [{ autor, texto, ordem }]
  const agentes = turns.filter((t) => t.autor === 'agente');
  const ultimoAgente = agentes[agentes.length - 1] || null;
  // Posicao (0-based) da ultima pergunta feita pela Vera -> chips/progresso.
  // Modo REAL (item 7.5): usa o ponteiro persistido (respeita o orcamento de trocas do
  // roleplay). Modo MOCK: mantem o avanco linear por contagem bruta de turnos (inalterado).
  const indice = config.entrevista.mock
    ? Math.max(0, agentes.length - 1)
    : Number(interviewRow.progresso_indice) || 0;

  // Audio: mock = arquivo estatico; real = MP3 ja salvo na ordem do turno do agente.
  let audioUrl = entrevista.AUDIO_MOCK;
  if (!config.entrevista.mock && ultimoAgente) {
    audioUrl = `/api/interview/audio/${interviewId}/${ultimoAgente.ordem}.mp3`;
  }

  const texto = ultimoAgente ? ultimoAgente.texto : '';

  if (interviewRow.status === 'concluido') {
    return {
      ok: true,
      encerrar: true,
      interview_id: interviewId,
      pergunta: texto || entrevista.FALA_FECHAMENTO,
      audio_url: audioUrl,
      topicos: entrevista.topicosUnicos(perguntas).map((nome) => ({ nome, estado: 'concluido' })),
    };
  }

  return entrevista.montarPayload({
    interviewId,
    perguntas,
    indice,
    texto,
    audioUrl,
    encerrar: false,
  });
}

// Fecha a pausa de uma entrevista que esta sendo RETOMADA agora.
//
// Hiato = agora - ultima atividade (ultimo turno gravado; sem turnos, iniciado_em).
// Acima de LIMIAR_PAUSA_MS entendemos que o candidato saiu, e o hiato inteiro entra no
// acumulador tempo_pausado_ms; abaixo disso nada e somado (pensar meio minuto antes de
// responder NAO e pausa). Retorna o total de pausa ja acumulado — inclusive quando nada
// foi somado, que e o caso da sessao continua (segue 0, comportamento historico).
//
// So e chamada AQUI, no momento da retomada. As respostas seguintes nao recalculam hiato:
// enquanto o candidato esta em entrevista, o tempo conta normalmente.
function registrarPausaDaRetomada(interviewRow) {
  const ultima = db.ultimaAtividadeInterview(interviewRow.id) || interviewRow.iniciado_em;
  const hiato = entrevista.decorridoMs(ultima);
  const incremento = hiato > entrevista.LIMIAR_PAUSA_MS ? hiato : 0;
  if (incremento > 0) {
    console.log(
      `[interview/start] retomada da entrevista ${interviewRow.id} apos ${Math.round(incremento / 60000)} min parada; descontado da duracao.`,
    );
  }
  return db.acumularTempoPausado(interviewRow.id, incremento);
}

// ── POST /api/interview/start ── inicia a entrevista e devolve a 1a pergunta
router.post('/interview/start', async (req, res) => {
  const candidato = candidatoApi(req, res);
  if (!candidato) return undefined;

  // Guarda de re-entrada: candidato que JA concluiu a entrevista nao pode iniciar
  // outra. Sem isto, obterInterviewEmAndamentoPorAplicacao ignora a entrevista
  // concluida (filtra status != 'concluido') e o fluxo abaixo criava uma entrevista
  // NOVA, revertendo a application para 'em_entrevista' e sobrescrevendo dados.
  if (candidato.status === 'concluido') {
    return res.status(409).json({
      erro: 'entrevista_ja_concluida',
      mensagem: 'Sua entrevista já foi concluída.',
    });
  }

  try {
    // RETOMADA: so retomamos se existe uma entrevista em andamento VALIDA — isto e,
    // com pelo menos a abertura (1 turno do agente) ja gravada. Uma linha "em
    // andamento" sem nenhum turno do agente e um registro orfao (um start anterior
    // que morreu antes de gravar a abertura); nesse caso NAO devolvemos um estado
    // vazio: criamos uma entrevista nova, como no inicio normal.
    const emAndamento = db.obterInterviewEmAndamentoPorAplicacao(candidato.id);
    if (emAndamento && db.contarTurnos(emAndamento.id, 'agente') > 0) {
      // Retomada: fecha a pausa que acabou de terminar ANTES de montar a resposta, e
      // devolve o cronometro em tempo ATIVO. Sem isto, quem volta horas/dias depois
      // (ex.: pelo link do e-mail de follow-up) recebia decorrido_ms gigante, com o
      // timer ja marcado como esgotado no front.
      const tempoPausado = registrarPausaDaRetomada(emAndamento);
      return res.json({
        ...payloadEstadoAtual(emAndamento),
        agente: config.agente.nome,
        max_duracao_min: config.entrevista.maxDuracaoMin,
        decorrido_ms: entrevista.decorridoAtivoMs(emAndamento.iniciado_em, tempoPausado),
        mock: config.entrevista.mock,
        retomada: true,
      });
    }
    // Registro orfao (em andamento, porem sem abertura): encerra para nao reaparecer
    // na proxima retomada e segue para criar uma entrevista nova.
    if (emAndamento) {
      console.warn(
        `[interview/start] entrevista ${emAndamento.id} em andamento sem abertura (orfa) — criando uma nova (application_id=${candidato.id}).`,
      );
      db.finalizarInterview(emAndamento.id);
    }

    const vaga = db.obterVaga(candidato.job_id);
    const roteiro = roteiroDaVaga(vaga);
    const perguntas = perguntasInterpoladas(roteiro, candidato, vaga);

    const interviewId = db.criarInterview({
      application_id: candidato.id,
      perfil: vaga ? vaga.perfil : 'SDR',
      roteiro_id: vaga ? vaga.roteiro_id : null,
      status: 'iniciada',
    });
    db.atualizarStatusAplicacao(candidato.id, 'em_entrevista');

    // 1a pergunta da Vera = abertura do roteiro (deterministica, orientada a dados).
    const textoAbertura = perguntas[0].texto;
    db.criarTurno({ interview_id: interviewId, ordem: 1, autor: 'agente', texto: textoAbertura });

    // Audio: mock = arquivo estatico; real = TTS da abertura.
    let audioUrl = entrevista.AUDIO_MOCK;
    if (!config.entrevista.mock) {
      try {
        audioUrl = await sintetizarESalvar(textoAbertura, interviewId, 1);
      } catch (e) {
        console.error('[interview/start] falha no TTS de abertura:', e.message);
        return res
          .status(502)
          .json({ ok: false, erro: 'Não foi possível iniciar a voz da entrevista. Tente novamente.' });
      }
    }

    return res.json({
      ...entrevista.payloadPergunta({ interviewId, perguntas, indice: 0, audioUrl }),
      agente: config.agente.nome,
      max_duracao_min: config.entrevista.maxDuracaoMin,
      decorrido_ms: 0,
      mock: config.entrevista.mock,
      retomada: false,
    });
  } catch (e) {
    // Log PERMANENTE em PT-BR: antes o motivo real da falha NAO aparecia no
    // terminal (a tela mostrava um erro generico), o que dificultava o diagnostico.
    console.error(
      `[interview/start] falha ao iniciar a entrevista (application_id=${candidato.id}):`,
      e.stack || e.message,
    );
    return res
      .status(500)
      .json({ ok: false, erro: 'Não foi possível iniciar a entrevista. Tente novamente.' });
  }
});

// ── POST /api/interview/answer ── recebe o audio e devolve a proxima pergunta
router.post('/interview/answer', (req, res) => {
  uploadAudio(req, res, async (err) => {
    if (err) {
      if (err.code === 'LIMIT_FILE_SIZE') {
        return res.status(400).json({ ok: false, erro: 'O áudio enviado é muito grande.' });
      }
      return res.status(400).json({ ok: false, erro: 'Não foi possível processar o áudio.' });
    }

    const candidato = candidatoApi(req, res);
    if (!candidato) return undefined;

    const interviewId = Number(req.body.interview_id);
    const entrevistaRow = db.obterInterview(interviewId);
    if (!entrevistaRow || entrevistaRow.application_id !== candidato.id) {
      // Log PERMANENTE em PT-BR: distingue "interview_id ausente/invalido" (o front
      // nao recebeu o id no start) de "pertence a outra candidatura". Antes esse 404
      // so aparecia na tela e nao deixava rastro no terminal.
      const motivo = !req.body.interview_id
        ? 'interview_id ausente no formulario (o /start nao devolveu o id?)'
        : !Number.isFinite(interviewId)
          ? `interview_id invalido: ${JSON.stringify(req.body.interview_id)}`
          : !entrevistaRow
            ? `entrevista ${interviewId} inexistente no banco`
            : `entrevista ${interviewId} pertence a outra candidatura (app ${entrevistaRow.application_id} != ${candidato.id})`;
      console.warn(`[interview/answer] entrevista não encontrada (404): ${motivo}.`);
      return res.status(404).json({ ok: false, erro: 'Entrevista não encontrada.' });
    }

    // IDEMPOTENCIA: o front manda um tentativa_id estavel por resposta (reusado no
    // retry). Se ja processamos esse id, devolvemos o MESMO estado sem reprocessar
    // — sem novo turno, sem novo provedor. Evita turnos duplicados quando a 1a
    // tentativa chegou ao servidor mas a resposta se perdeu na rede.
    const tentativaId = String(req.body.tentativa_id || '').trim();
    if (tentativaId && entrevistaRow.ultimo_resp_id === tentativaId) {
      return res.json(payloadEstadoAtual(entrevistaRow));
    }

    // Entrevista ja encerrada: nao reprocessa; devolve o estado final.
    if (entrevistaRow.status === 'concluido') {
      return res.json(payloadEstadoAtual(entrevistaRow));
    }

    // Forca avancar mesmo sem ouvir (front pede na 3a tentativa, apos 2 repeticoes).
    const forcarAvancar = String(req.body.forcar_avancar || '') === '1';

    const roteiro = entrevistaRow.roteiro_id ? db.obterRoteiro(entrevistaRow.roteiro_id) : null;
    const vaga = db.obterVaga(candidato.job_id);
    const perguntas = perguntasInterpoladas(roteiro, candidato, vaga);

    // Quantas perguntas a Vera ja fez -> proxima e o indice seguinte (0-based).
    const proximoIndice = db.contarTurnos(interviewId, 'agente');

    // Teto de tempo: se ja estourou MAX_DURACAO_MIN, esta resposta encerra graciosamente.
    // Teto de perguntas (MAX_PERGUNTAS) e o segundo limite; o que vier primeiro encerra.
    //
    // Medido em duracao ATIVA: relogio desde iniciado_em menos tempo_pausado_ms (ja
    // persistido na retomada). Aqui NAO se recalcula hiato — quem esta respondendo esta
    // em entrevista, e o tempo conta. Entrevista sem pausa tem tempo_pausado_ms = 0 e o
    // resultado e identico ao de antes.
    const tempoEstourou = entrevista.excedeuDuracaoAtiva(
      entrevistaRow.iniciado_em,
      entrevistaRow.tempo_pausado_ms,
      config.entrevista.maxDuracaoMin,
    );

    // Salva o audio do candidato no volume persistente (em mock e real).
    let audioPath = null;
    if (req.file) {
      try {
        const dir = path.join(config.caminhoEntrevistas, String(interviewId));
        fs.mkdirSync(dir, { recursive: true });
        audioPath = path.join(dir, `resp-${proximoIndice}.webm`);
        fs.writeFileSync(audioPath, req.file.buffer);
      } catch (e) {
        console.error('[interview/answer] falha ao salvar audio:', e.message);
        audioPath = null;
      }
    }

    // ───────────────── MODO MOCK (custo zero) ─────────────────
    if (config.entrevista.mock) {
      // Teste de "nao consegui ouvir" (SO em mock; gatilho via flag de teste).
      // Sem forcar: pede repeticao, NAO cria turno, NAO avanca. Audio = mock.
      const testeRepetir = String(req.body.teste_repetir || '') === '1';
      if (testeRepetir && !forcarAvancar) {
        return res.json({
          ok: true,
          repetir: true,
          interview_id: interviewId,
          pergunta: entrevista.FRASE_NAO_OUVI,
          audio_url: entrevista.AUDIO_MOCK,
        });
      }
      // Na 3a tentativa (forcar), a Vera segue com uma fala de transicao.
      const prefixoTransicao = testeRepetir && forcarAvancar ? `${entrevista.FALA_TRANSICAO} ` : '';

      db.criarTurno({
        interview_id: interviewId,
        ordem: db.contarTurnos(interviewId) + 1,
        autor: 'candidato',
        texto: '[resposta de áudio recebida — mock]',
        audio_path: audioPath,
      });

      // Encerramento: perguntas esgotadas, OU teto de tempo, OU teto de perguntas.
      const encerrar =
        proximoIndice >= perguntas.length ||
        tempoEstourou ||
        proximoIndice >= config.entrevista.maxPerguntas;

      if (encerrar) {
        const falaFechamento = `${prefixoTransicao}${entrevista.FALA_FECHAMENTO}`;
        db.criarTurno({
          interview_id: interviewId,
          ordem: db.contarTurnos(interviewId) + 1,
          autor: 'agente',
          texto: falaFechamento,
        });
        entrevista.finalizarEntrevista(interviewId);
        if (tentativaId) db.definirUltimoRespId(interviewId, tentativaId);
        return res.json({
          ok: true,
          encerrar: true,
          interview_id: interviewId,
          pergunta: falaFechamento,
          audio_url: entrevista.AUDIO_MOCK,
          topicos: entrevista.topicosUnicos(perguntas).map((nome) => ({ nome, estado: 'concluido' })),
        });
      }

      db.criarTurno({
        interview_id: interviewId,
        ordem: db.contarTurnos(interviewId) + 1,
        autor: 'agente',
        texto: `${prefixoTransicao}${perguntas[proximoIndice].texto}`,
      });
      if (tentativaId) db.definirUltimoRespId(interviewId, tentativaId);
      return res.json(
        entrevista.montarPayload({
          interviewId,
          perguntas,
          indice: proximoIndice,
          texto: `${prefixoTransicao}${perguntas[proximoIndice].texto}`,
          audioUrl: entrevista.AUDIO_MOCK,
          encerrar: false,
        }),
      );
    }

    // ───────────────── MODO REAL (STT -> LLM -> TTS) ─────────────────
    try {
      // 1) STT — transcreve o audio recebido (idioma pt).
      const { texto: transcricao } = await entrevista.comTimeout(
        stt.transcrever(req.file ? req.file.buffer : Buffer.alloc(0), {
          idioma: 'pt',
          mimetype: req.file ? req.file.mimetype : 'audio/webm',
        }),
        config.entrevista.timeoutMs,
        'STT Groq',
      );

      // STT vazio -> NAO chama o LLM. Sem forcar: pede para repetir (audio fixo
      // cacheado). Com forcar (3a tentativa apos 2 repeticoes): segue mesmo assim
      // com uma fala de transicao, registrando a resposta como inaudivel.
      const semFala = !transcricao || !transcricao.trim();
      if (semFala && !forcarAvancar) {
        await garantirNaoOuvi();
        return res.json({
          ok: true,
          repetir: true,
          interview_id: interviewId,
          pergunta: entrevista.FRASE_NAO_OUVI,
          audio_url: '/api/interview/audio-padrao/nao-ouvi.mp3',
        });
      }
      const prefixoTransicao = semFala && forcarAvancar ? `${entrevista.FALA_TRANSICAO} ` : '';

      // Registra a resposta do candidato (ou marca como inaudivel ao forcar).
      db.criarTurno({
        interview_id: interviewId,
        ordem: db.contarTurnos(interviewId) + 1,
        autor: 'candidato',
        texto: semFala ? '[resposta inaudível]' : transcricao.trim(),
        audio_path: audioPath,
      });

      // Teto de tempo: se ja estourou MAX_DURACAO_MIN, encerra graciosamente nesta
      // resposta (fala de fechamento via TTS), sem chamar o LLM.
      if (tempoEstourou) {
        const falaFechamento = `${prefixoTransicao}${entrevista.FALA_FECHAMENTO}`;
        const ordemFech = db.contarTurnos(interviewId) + 1;
        const audioFech = await sintetizarESalvar(falaFechamento, interviewId, ordemFech);
        db.criarTurno({
          interview_id: interviewId,
          ordem: ordemFech,
          autor: 'agente',
          texto: falaFechamento,
        });
        entrevista.finalizarEntrevista(interviewId);
        if (tentativaId) db.definirUltimoRespId(interviewId, tentativaId);
        return res.json({
          ok: true,
          encerrar: true,
          interview_id: interviewId,
          pergunta: falaFechamento,
          audio_url: audioFech,
          topicos: entrevista.topicosUnicos(perguntas).map((nome) => ({ nome, estado: 'concluido' })),
        });
      }

      // 2) LLM — gera a proxima pergunta referenciando a resposta + curriculo.
      const systemPrompt = entrevista.montarSystemPrompt({
        roteiro,
        curriculoTexto: candidato.curriculo_texto,
        agente: config.agente.nome,
        maxPerguntas: config.entrevista.maxPerguntas,
        vaga,
      });
      const mensagens = entrevista.montarMensagensLLM({
        systemPrompt,
        turns: db.listarTurnos(interviewId),
        recentes: config.entrevista.historicoRecentes,
      });
      const resposta = await entrevista.comTimeout(
        llm.completar(mensagens, { maxTokens: 400 }),
        config.entrevista.timeoutMs,
        'LLM DeepSeek',
      );

      // Log de uso/custo (best-effort: NUNCA interrompe o fluxo da entrevista).
      try {
        const custo = calcularCustoDeepSeek(resposta.uso);
        db.registrarUsoApi({
          provedor: 'openrouter',
          modelo: resposta.modelo,
          origem: 'entrevista',
          interview_id: interviewId,
          uso: resposta.uso,
          custo_usd: custo,
        });
      } catch (e) {
        console.error('[custos] erro ao registrar uso (entrevista):', e);
      }

      let { texto: falaVera, encerrar } = entrevista.extrairEncerrar(resposta.texto);
      falaVera = entrevista.removerMarkdown(falaVera); // rede de seguranca: nunca deixa markdown vazar p/ TTS/tela
      if (!falaVera) falaVera = 'Pode me contar um pouco mais sobre isso?'; // fallback defensivo
      if (prefixoTransicao) falaVera = `${prefixoTransicao}${falaVera}`;

      // Teto de perguntas (rede de seguranca contra entrevista infinita).
      const agentePosNovo = db.contarTurnos(interviewId, 'agente') + 1;
      const cortePorTeto = !encerrar && agentePosNovo >= config.entrevista.maxPerguntas;
      if (cortePorTeto) encerrar = true;

      // Encerramento SEMPRE usa fala fixa e segura, nunca o texto do LLM. Dois motivos:
      //  - No corte por TETO, o LLM acabou de gerar mais UMA pergunta orfa (o front
      //    redireciona para /finalizacao ao receber encerrar:true), que nao pode ir ao ar.
      //  - No encerramento decidido pelo proprio LLM (via [ENCERRAR]), a fala autorada
      //    corria o risco de VAZAR avaliacao/feedback ao candidato (a rubrica ainda estava
      //    no contexto). Agora ignoramos esse texto e despedimos com fala neutra e fixa.
      // O resto do fluxo (TTS, turno, finalizar) segue igual para ambos os casos.
      if (encerrar) falaVera = entrevista.falaDespedida(candidato.nome);

      // 3) TTS — sintetiza a fala da Vera e salva o MP3.
      const ordemAgente = db.contarTurnos(interviewId) + 1;
      const audioUrl = await sintetizarESalvar(falaVera, interviewId, ordemAgente);
      db.criarTurno({
        interview_id: interviewId,
        ordem: ordemAgente,
        autor: 'agente',
        texto: falaVera,
      });

      if (encerrar) {
        entrevista.finalizarEntrevista(interviewId);
        if (tentativaId) db.definirUltimoRespId(interviewId, tentativaId);
        return res.json({
          ok: true,
          encerrar: true,
          interview_id: interviewId,
          pergunta: falaVera,
          audio_url: audioUrl,
          topicos: entrevista.topicosUnicos(perguntas).map((nome) => ({ nome, estado: 'concluido' })),
        });
      }

      // Progresso com ORCAMENTO DE TROCAS (item 7.5 — SO modo real): avanca o ponteiro
      // do bloco respeitando max_trocas. Os chips passam a usar ESTE indice persistido
      // (nao a contagem bruta de turnos), evitando dessincronizar quando a Vera sustenta
      // um roleplay por varias trocas. MAX_PERGUNTAS (cortePorTeto acima) continua vindo
      // da contagem bruta de turnos — rede de seguranca independente deste ponteiro.
      const prog = entrevista.avancarProgresso({
        indiceAtual: entrevistaRow.progresso_indice || 0,
        trocasAtual: entrevistaRow.progresso_trocas || 0,
        perguntas,
      });
      db.atualizarProgressoInterview(interviewId, prog.indice, prog.trocas);

      if (tentativaId) db.definirUltimoRespId(interviewId, tentativaId);
      return res.json(
        entrevista.montarPayload({
          interviewId,
          perguntas,
          indice: prog.indice,
          texto: falaVera,
          audioUrl,
          encerrar: false,
        }),
      );
    } catch (e) {
      console.error('[interview/answer] erro no modo real:', e.message);
      return res.status(502).json({
        ok: false,
        erro: 'Tivemos um problema ao processar sua resposta. Tente novamente em instantes.',
      });
    }
  });
});

// ── POST /api/interview/finish ── encerra a entrevista
router.post('/interview/finish', async (req, res) => {
  const candidato = candidatoApi(req, res);
  if (!candidato) return undefined;

  const interviewId = Number(req.body.interview_id);
  const entrevistaRow = db.obterInterview(interviewId);
  if (!entrevistaRow || entrevistaRow.application_id !== candidato.id) {
    return res.status(404).json({ ok: false, erro: 'Entrevista não encontrada.' });
  }

  // Ja encerrada: nao gera nova despedida nem turno duplicado; so confirma o destino.
  if (entrevistaRow.status === 'concluido') {
    return res.json({ ok: true, redirect: '/finalizacao' });
  }

  // Fala de despedida personalizada antes de encerrar (mesmo padrao do caminho "tempo
  // estourado"): cria o turno do agente e, no modo real, sintetiza o audio via TTS;
  // no mock usa o audio fixo. Antes esta rota encerrava sem nenhuma fala final.
  const falaFechamento = entrevista.falaDespedida(candidato.nome);
  const ordemFech = db.contarTurnos(interviewId) + 1;
  let audioUrl = entrevista.AUDIO_MOCK;
  if (!config.entrevista.mock) {
    try {
      audioUrl = await sintetizarESalvar(falaFechamento, interviewId, ordemFech);
    } catch (e) {
      console.error('[interview/finish] falha no TTS de despedida:', e.message);
      audioUrl = entrevista.AUDIO_MOCK;
    }
  }
  db.criarTurno({
    interview_id: interviewId,
    ordem: ordemFech,
    autor: 'agente',
    texto: falaFechamento,
  });

  // Encerramento via ponto unico (finaliza interview + application + gera o relatorio
  // em fire-and-forget). A rota e mantida para usos futuros (ex.: botao de encerrar
  // manual / painel da Fase 5); o caminho natural de fim de entrevista hoje encerra
  // dentro de /answer, que tambem passa por finalizarEntrevista.
  entrevista.finalizarEntrevista(interviewId);

  return res.json({
    ok: true,
    redirect: '/finalizacao',
    pergunta: falaFechamento,
    audio_url: audioUrl,
  });
});

// ── GET /api/interview/status ── veredito da IA (status_ia) do candidato logado.
// Consumido pela tela final (/finalizacao) para POLAR ate sair de 'processando' para
// um terminal. Auth padrao (candidatoApi -> 401 JSON sem sessao). O status_ia mora na
// application, entao a sessao ja basta (nao precisa de interview_id no request).
router.get('/interview/status', (req, res) => {
  const candidato = candidatoApi(req, res);
  if (!candidato) return undefined; // candidatoApi ja respondeu 401
  const status_ia = db.obterStatusIaPorApplication(candidato.id);
  return res.json({ ok: true, status_ia: status_ia || null });
});

// ── GET /api/interview/audio/:interviewId/:arquivo ── serve o MP3 da fala da Vera (modo real)
// Protegido: so o candidato dono da entrevista acessa.
router.get('/interview/audio/:interviewId/:arquivo', (req, res) => {
  const candidato = candidatoApi(req, res);
  if (!candidato) return undefined;

  const arquivo = req.params.arquivo;
  if (!/^\d+\.mp3$/.test(arquivo)) {
    return res.status(400).json({ ok: false, erro: 'Arquivo inválido.' });
  }
  const interviewId = Number(req.params.interviewId);
  const entrevistaRow = db.obterInterview(interviewId);
  if (!entrevistaRow || entrevistaRow.application_id !== candidato.id) {
    return res.status(404).json({ ok: false, erro: 'Áudio não encontrado.' });
  }
  const caminho = path.join(config.caminhoEntrevistas, String(interviewId), arquivo);
  if (!fs.existsSync(caminho)) {
    return res.status(404).json({ ok: false, erro: 'Áudio não encontrado.' });
  }
  res.type('audio/mpeg');
  return res.sendFile(caminho);
});

// ── GET /api/interview/audio-padrao/nao-ouvi.mp3 ── audio fixo "nao consegui ouvir"
router.get('/interview/audio-padrao/nao-ouvi.mp3', async (req, res) => {
  const candidato = candidatoApi(req, res);
  if (!candidato) return undefined;
  try {
    await garantirNaoOuvi();
    res.type('audio/mpeg');
    return res.sendFile(caminhoNaoOuvi());
  } catch (e) {
    console.error('[interview/audio-padrao] erro:', e.message);
    return res.status(502).json({ ok: false, erro: 'Não foi possível gerar o áudio.' });
  }
});

// ── POST /api/interview/video-upload ── recebe a gravacao de video e sobe ao Drive.
// CORPO CRU (sem multipart/FormData): o Blob do video vem como corpo da requisicao;
// mimetype no header Content-Type e tamanho no Content-Length. Isso evita a corrupcao
// do Content-Type de partes multipart pelo edge do Railway (que fazia o multer receber
// "text/plain" -> 400) e reduz a superficie do ERR_HTTP2 intermitente. O interview_id
// vem na query string (?interview_id=<n>).
// Best-effort: a feature de video NUNCA bloqueia a finalizacao. Qualquer falha (mock,
// erro de upload, timeout) responde ok:true (uploaded:false) para o front so redirecionar.
router.post('/interview/video-upload', (req, res) => {
  const ct = String(req.headers['content-type'] || '');

  // Identificacao do request nos logs ANTES de interviewId existir (itens 1-3 abaixo
  // rodam antes do parse). Vai o valor CRU da query: se ele chegar ausente/estranho, e
  // justamente isso que precisamos enxergar.
  const idCru = JSON.stringify(req.query.interview_id);

  // 1) Tipo: agora no header da requisicao inteira (nao numa sub-parte multipart).
  if (!/^video\//.test(ct)) {
    console.warn(
      `[video-upload] recusado (400): Content-Type inválido ${JSON.stringify(ct || '(ausente)')} ` +
        `— interview_id=${idCru}.`,
    );
    req.resume(); // drena o corpo p/ nao pendurar a conexao
    return res.status(400).json({ ok: false, erro: 'Formato de vídeo inválido.' });
  }

  // 2) Tamanho declarado (mesmo teto de 300 MB). O Content-Length pode faltar (chunked);
  //    por isso tambem contamos os bytes durante o stream (abaixo).
  const declarado = Number(req.headers['content-length']);
  if (Number.isFinite(declarado) && declarado > MAX_VIDEO_BYTES) {
    console.warn(
      `[video-upload] recusado (400): Content-Length ${declarado} excede o teto de ` +
        `${MAX_VIDEO_BYTES} bytes — interview_id=${idCru}.`,
    );
    req.resume();
    return res.status(400).json({ ok: false, erro: 'O vídeo da entrevista é muito grande.' });
  }

  // 3) Auth + entrevista ANTES de gravar (fail-fast: nao recebe 300 MB p/ request invalido).
  const candidato = candidatoApi(req, res);
  if (!candidato) {
    // O 401 ja foi respondido por candidatoApi; aqui so deixamos o rastro. Distingue
    // "cookie expirou no meio da entrevista" de todos os outros motivos de nao subir video.
    console.warn(`[video-upload] recusado (401): sem sessão de candidato — interview_id=${idCru}.`);
    req.resume();
    return undefined;
  }
  const interviewId = Number(req.query.interview_id);
  const entrevistaRow = db.obterInterview(interviewId);
  if (!entrevistaRow || entrevistaRow.application_id !== candidato.id) {
    // Mesmo detalhamento por motivo ja usado no 404 de /interview/answer: sem ele, os
    // quatro casos abaixo viram um 404 indistinguivel.
    const motivo = !req.query.interview_id
      ? 'interview_id ausente na query'
      : !Number.isFinite(interviewId)
        ? `interview_id invalido: ${idCru}`
        : !entrevistaRow
          ? `entrevista ${interviewId} inexistente no banco`
          : `entrevista ${interviewId} pertence a outra candidatura ` +
            `(app ${entrevistaRow.application_id} != ${candidato.id})`;
    console.warn(`[video-upload] recusado (404): ${motivo}.`);
    req.resume();
    return res.status(404).json({ ok: false, erro: 'Entrevista não encontrada.' });
  }

  // 4) Grava o corpo cru em arquivo temporario, com teto de tamanho durante o stream.
  const ext = /mp4/.test(ct) ? 'mp4' : 'webm';
  const destino = path.join(
    os.tmpdir(),
    `vm-video-${Date.now()}-${Math.random().toString(16).slice(2)}.${ext}`,
  );
  const ws = fs.createWriteStream(destino);
  let recebido = 0;
  let finalizado = false;

  const abortar = (status, mensagem) => {
    if (finalizado) return;
    finalizado = true;
    req.unpipe(ws);
    ws.destroy();
    removerTemp(destino);
    if (!res.headersSent) res.status(status).json({ ok: false, erro: mensagem });
    req.resume(); // descarta o resto do corpo
  };

  req.on('data', (chunk) => {
    recebido += chunk.length;
    if (recebido > MAX_VIDEO_BYTES) {
      // Caso DISTINTO do item 2: aqui o Content-Length nao veio (upload chunked) e o teto
      // so estourou no meio do stream.
      console.warn(
        `[video-upload] abortado (400): interview ${interviewId} excedeu ${MAX_VIDEO_BYTES} ` +
          `bytes durante o stream (recebido=${recebido}).`,
      );
      abortar(400, 'O vídeo da entrevista é muito grande.');
    }
  });
  req.on('aborted', () => {
    // Cliente abortou (ex.: fechou a aba). Best-effort: limpa e nao responde.
    if (finalizado) return;
    finalizado = true;
    // `recebido` diferencia "nem comecou" (0) de "caiu no meio de 40 MB" — sem esse numero
    // o aborto do cliente e indistinguivel de um upload que nunca saiu do navegador.
    console.warn(
      `[video-upload] abortado pelo cliente: interview ${interviewId} — ${recebido} bytes ` +
        'recebidos antes do corte (aba fechada / conexão caiu).',
    );
    ws.destroy();
    removerTemp(destino);
  });
  // Os dois handlers abaixo davam a MESMA resposta e ficavam indistinguiveis no log, mas
  // a causa e oposta: falha de rede/cliente na leitura (warn, nada a fazer do nosso lado)
  // vs. falha ao ESCREVER o temporario em os.tmpdir() (error — disco do container cheio,
  // permissao: problema NOSSO). O parametro de erro, antes descartado, agora e logado.
  req.on('error', (e) => {
    console.warn(
      `[video-upload] erro de leitura da requisição: interview ${interviewId} — ` +
        `${e && e.message} (recebido=${recebido}).`,
    );
    abortar(400, 'Não foi possível processar o vídeo.');
  });
  ws.on('error', (e) => {
    console.error(
      `[video-upload] erro ao gravar o arquivo temporário ${destino}: interview ` +
        `${interviewId} — ${e && e.message} (recebido=${recebido}).`,
    );
    abortar(400, 'Não foi possível processar o vídeo.');
  });
  req.pipe(ws);

  ws.on('finish', async () => {
    if (finalizado) return;
    finalizado = true;

    if (recebido === 0) {
      // A requisicao chegou inteira e valida, mas com corpo vazio: assinatura de
      // MediaRecorder que nao capturou nenhum chunk.
      console.warn(
        `[video-upload] recusado (400): interview ${interviewId} enviou 0 bytes ` +
          '(MediaRecorder sem chunks?).',
      );
      removerTemp(destino);
      return res.status(400).json({ ok: false, erro: 'Nenhum vídeo recebido.' });
    }

    const mimeType = ct.split(';')[0].trim(); // 'video/webm' sem parametros (codecs)

    // MODO MOCK: NAO toca o Drive (bloqueio de chamadas externas). Descarta o arquivo.
    if (config.entrevista.mock) {
      console.log(
        `[video-upload] (mock) vídeo recebido p/ interview ${interviewId} (${recebido} bytes) — Drive NÃO acionado.`,
      );
      removerTemp(destino);
      return res.json({ ok: true, mock: true, uploaded: false });
    }

    // MODO REAL: sobe ao Drive (timeout ~5 min). Sucesso grava video_url; falha apenas
    // loga (best-effort). Em todos os casos o arquivo temporario e removido no fim.
    try {
      const nomeArquivo = nomeVideoDrive(candidato, interviewId, destino);
      const { link } = await entrevista.comTimeout(
        drive.enviarVideo({ caminho: destino, nomeArquivo, mimeType }),
        VIDEO_UPLOAD_TIMEOUT_MS,
        'Upload Drive',
      );
      db.definirVideoUrl(interviewId, link);
      console.log(`[video-upload] vídeo da interview ${interviewId} salvo no Drive: ${link}`);

      // Video confirmado no Drive -> os audios no volume viraram redundancia sem leitor.
      // Sem esta limpeza o volume enche sozinho (~4,4 MB por entrevista) ate travar a
      // ESCRITA do SQLite, que mora no mesmo disco. Falha aqui nao afeta o candidato.
      const liberados = removerAudioDaEntrevista(interviewId);
      if (liberados > 0) {
        console.log(
          `[video-upload] áudios da interview ${interviewId} removidos do volume (${(liberados / 1048576).toFixed(1)} MB).`,
        );
      }

      return res.json({ ok: true, uploaded: true, video_url: link });
    } catch (e) {
      console.error(
        `[video-upload] falha ao subir o vídeo da interview ${interviewId} ao Drive: ${e.message}`,
      );
      return res.json({ ok: true, uploaded: false });
    } finally {
      removerTemp(destino);
    }
  });
});

module.exports = router;
