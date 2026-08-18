'use strict';

// API do Banco de Curriculos. Router proprio montado em /api pelo server.js,
// SEPARADO de api.js para nao misturar com o funil de vaga (mesma decisao das paginas).
// T3: alem de persistir o cadastro, chama o motor de analise (LLM real, sem mock),
// grava `talentos.analise`, envia o resultado por e-mail ao candidato e devolve o HTML
// do resultado ja renderizado (`resultadoHtml`) — o front troca o form por ele, sem
// navegacao. Analise e e-mail sao best-effort: NUNCA bloqueiam o cadastro.

const express = require('express');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const multer = require('multer');

const { config } = require('../config');
const db = require('../db');
const { extrairTextoPdf, extensaoDoArquivo } = require('../lib/curriculo');
const { analisarCurriculo } = require('../lib/analise_curriculo');
const emailProvider = require('../providers/email');
const { renderizarResultadoTalentoHtml } = require('./banco_curriculos');
const { escapeHtml } = require('../views');

const router = express.Router();

const MAX_PDF_BYTES = 10 * 1024 * 1024; // 10 MB (mesmo teto do /api/aplicacao)
const PERFIS_INTERESSE_VALIDOS = ['SDR', 'CLOSER'];

// Upload em memoria: validamos tipo/tamanho e so gravamos no disco depois de gerar o
// uuid (o nome do arquivo e <uuid>.pdf). Mesmo padrao do upload de curriculo do funil.
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

// Corpo do e-mail ao candidato: versao simplificada e inline-styled do resultado
// (e-mail nao carrega o CSS do site — mesma tatica do montarEmailHtml de relatorio.js).
// Sem analise, vira uma confirmacao simples de cadastro recebido.
function montarEmailAnaliseHtml({ nome, analise }) {
  const primeiroNome = String(nome || '').trim().split(/\s+/)[0];
  const saudacao = `Olá${primeiroNome ? `, <b>${escapeHtml(primeiroNome)}</b>` : ''}!`;

  const lista = (titulo, itens) =>
    Array.isArray(itens) && itens.length
      ? `<div style="margin:16px 0">
           <h3 style="margin:0 0 8px;font-size:16px">${titulo}</h3>
           <ul style="margin:0;padding-left:18px">
             ${itens.map((i) => `<li style="margin:0 0 6px">${escapeHtml(i)}</li>`).join('')}
           </ul>
         </div>`
      : '';

  const corpo = analise
    ? `
    <p>${saudacao} Recebemos seu currículo no nosso banco de talentos e analisamos o seu
    perfil de vendas com nossa inteligência artificial. Veja o resumo:</p>
    ${
      Number.isFinite(analise.score_geral)
        ? `<p style="margin:16px 0;font-size:15px">
             <b>Aderência ao perfil de vendas:</b>
             <span style="font-size:22px;font-weight:bold;color:#FF5500">${analise.score_geral}</span> / 100
           </p>`
        : ''
    }
    ${lista('Pontos fortes', analise.pontos_fortes)}
    ${lista('Pontos de atenção', analise.pontos_atencao)}
    <p>Entraremos em contato quando surgir uma oportunidade compatível com você.</p>`
    : `
    <p>${saudacao} Recebemos seu currículo no nosso banco de talentos. Entraremos em
    contato quando surgir uma oportunidade compatível com você.</p>`;

  return `
  <div style="font-family:Arial,Helvetica,sans-serif;color:#1a1a1a;max-width:640px">
    <h2 style="margin:0 0 4px">Banco de Currículos — Vendedor Mestre</h2>
    ${corpo}
    <p style="color:#888;font-size:12px;margin-top:24px">Você recebeu este e-mail porque
    se cadastrou no banco de talentos da Vendedor Mestre. Para solicitar a remoção dos
    seus dados, basta responder a esta mensagem.</p>
  </div>`;
}

// ── POST /api/banco-curriculos ── cadastro no banco de talentos ──
router.post('/banco-curriculos', (req, res) => {
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
      const email = String(b.email || '').trim();
      const ddi = String(b.ddi || '+55').trim();
      const telefoneNum = String(b.telefone || '').trim();
      const linkedin = String(b.linkedin_url || '').trim();
      const perfilInteresse = String(b.perfil_interesse || '').trim().toUpperCase();

      // Validacao no servidor (a do front e so conveniencia): campos essenciais
      // nao-vazios. Sem regex de e-mail/telefone de proposito (cadastro de banco de
      // talentos; o contato e verificado pelo recrutador antes de qualquer conversa).
      const faltando = [];
      if (!nome) faltando.push('nome');
      if (!email) faltando.push('e-mail');
      if (!telefoneNum) faltando.push('telefone');
      if (faltando.length) {
        return res
          .status(400)
          .json({ ok: false, erro: `Preencha os campos obrigatórios: ${faltando.join(', ')}.` });
      }
      // Enum antes do INSERT: valor fora de SDR/CLOSER estouraria o CHECK do schema (500).
      if (!PERFIS_INTERESSE_VALIDOS.includes(perfilInteresse)) {
        return res
          .status(400)
          .json({ ok: false, erro: 'Escolha o perfil de interesse (SDR ou Closer).' });
      }
      if (!req.file) {
        return res.status(400).json({ ok: false, erro: 'Anexe seu currículo em PDF.' });
      }
      // Consentimento LGPD (obrigatorio) — finalidade "banco de talentos", DISTINTA do
      // consentimento de candidatura a vaga. Mesmo padrao de barreira do /api/aplicacao.
      const consentiu = ['on', '1', 'true'].includes(String(b.consentimento || '').toLowerCase());
      if (!consentiu) {
        return res.status(400).json({
          ok: false,
          erro: 'É necessário autorizar o armazenamento dos seus dados no banco de talentos para se cadastrar.',
        });
      }

      // uuid gerado ANTES do insert: e o nome do arquivo do PDF (nao dependemos do id
      // do banco para salvar o arquivo — espirito do token de applications).
      const uuid = crypto.randomUUID();

      // Salva o curriculo na pasta do banco de talentos (SEPARADA da do funil; cria se
      // faltar). Extensao real do arquivo, nao mais fixa em .pdf — mesmo motivo do funil
      // (routes/api.js).
      fs.mkdirSync(config.caminhoCurriculosTalentos, { recursive: true });
      const caminhoPdf = path.join(config.caminhoCurriculosTalentos, `${uuid}.${extensaoDoArquivo(req.file)}`);
      fs.writeFileSync(caminhoPdf, req.file.buffer);

      // Extrai o texto do PDF (truncado em ~20.000 caracteres no helper; PDF ilegivel
      // devolve '' sem quebrar o cadastro).
      const curriculoTexto = await extrairTextoPdf(req.file.buffer);

      // ── Motor de analise (T3) — best-effort: NUNCA bloqueia o cadastro. ──
      // Sem perfil ideal cadastrado, ou com falha na analise (ok:false), o cadastro
      // segue com analise = null; o motivo fica so no log (nada tecnico na resposta).
      let analise = null;
      const perfilCurriculo = db.buscarPerfilCurriculoAtivoPara(perfilInteresse);
      if (!perfilCurriculo) {
        console.warn(
          `[api/banco-curriculos] sem perfil ideal de curriculo para ${perfilInteresse}; cadastro segue sem analise.`,
        );
      } else {
        const resultado = await analisarCurriculo({ perfilCurriculo, curriculoTexto });
        if (resultado.ok) {
          analise = resultado.analise;
        } else {
          console.error(
            `[api/banco-curriculos] analise falhou (${resultado.erroCodigo}); cadastro segue sem analise.`,
          );
        }
      }

      const talento = {
        nome,
        email,
        telefone: `${ddi} ${telefoneNum}`.trim(),
        perfil_interesse: perfilInteresse,
        linkedin_url: linkedin,
        curriculo_path: caminhoPdf,
        curriculo_texto: curriculoTexto,
        analise,
      };
      db.criarTalento(talento);

      // ── E-mail ao candidato (Resend) — fire-and-forget: falha so loga, nunca ──
      // quebra nem atrasa a resposta (mesmo espirito do envio em relatorio.js).
      // Assunto/corpo condicionais: sem analise NAO se afirma que ela existe — vira uma
      // confirmacao simples de cadastro (o corpo tambem ramifica em montarEmailAnaliseHtml).
      const assunto = analise
        ? 'Sua análise no Banco de Currículos da Vendedor Mestre'
        : 'Recebemos seu cadastro no Banco de Currículos da Vendedor Mestre';
      emailProvider
        .enviar(email, assunto, montarEmailAnaliseHtml({ nome, analise }))
        .catch((erroEmail) => {
          console.error(
            `[api/banco-curriculos] falha ao enviar e-mail ao candidato: ${erroEmail.message}`,
          );
        });

      // T3: devolve o HTML do resultado ja renderizado; o front troca o formulario por
      // ele via outerHTML (sem redirect; /recebido segue como fallback generico).
      return res.json({ ok: true, resultadoHtml: renderizarResultadoTalentoHtml(talento) });
    } catch (erro) {
      console.error('[api/banco-curriculos] erro:', erro.message);
      return res
        .status(500)
        .json({ ok: false, erro: 'Erro interno ao registrar seu cadastro. Tente novamente.' });
    }
  });
});

module.exports = router;
