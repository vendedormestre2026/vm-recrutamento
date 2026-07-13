'use strict';

// API do Banco de Curriculos (T2). Router proprio montado em /api pelo server.js,
// SEPARADO de api.js para nao misturar com o funil de vaga (mesma decisao das paginas).
// T2: persiste o cadastro e devolve o redirect para a tela provisoria de confirmacao.
// T3 estende esta rota para chamar o motor de analise (LLM) e gravar `talentos.analise`.

const express = require('express');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const multer = require('multer');

const { config } = require('../config');
const db = require('../db');
const { extrairTextoPdf } = require('../lib/curriculo');

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

      // Salva o PDF na pasta do banco de talentos (SEPARADA da do funil; cria se faltar).
      fs.mkdirSync(config.caminhoCurriculosTalentos, { recursive: true });
      const caminhoPdf = path.join(config.caminhoCurriculosTalentos, `${uuid}.pdf`);
      fs.writeFileSync(caminhoPdf, req.file.buffer);

      // Extrai o texto do PDF (truncado em ~20.000 caracteres no helper; PDF ilegivel
      // devolve '' sem quebrar o cadastro).
      const curriculoTexto = await extrairTextoPdf(req.file.buffer);

      db.criarTalento({
        nome,
        email,
        telefone: `${ddi} ${telefoneNum}`.trim(),
        perfil_interesse: perfilInteresse,
        linkedin_url: linkedin,
        curriculo_path: caminhoPdf,
        curriculo_texto: curriculoTexto,
      });

      // T2: tela provisoria de confirmacao. T3 troca este destino pelo resultado da analise.
      return res.json({ ok: true, redirect: '/bancodecurriculos/recebido' });
    } catch (erro) {
      console.error('[api/banco-curriculos] erro:', erro.message);
      return res
        .status(500)
        .json({ ok: false, erro: 'Erro interno ao registrar seu cadastro. Tente novamente.' });
    }
  });
});

module.exports = router;
