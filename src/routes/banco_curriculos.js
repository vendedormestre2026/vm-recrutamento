'use strict';

// Paginas publicas do Banco de Curriculos (T2). Fluxo INDEPENDENTE do funil de vagas:
// sem sessao de candidato, sem barra de etapas do funil. Montado em /bancodecurriculos
// pelo server.js. O formulario posta via fetch para POST /api/banco-curriculos
// (api_banco_curriculos.js), no mesmo padrao da tela de Aplicacao (public/js/app.js
// intercepta o submit, mostra erros inline e navega no sucesso).

const express = require('express');
const { pagina, escapeHtml } = require('../views');

const router = express.Router();

// Opcoes do select de perfil de interesse (valor canonico + rotulo amigavel).
const PERFIS_INTERESSE = [
  ['SDR', 'SDR / Pré-vendas'],
  ['CLOSER', 'Closer / Fechamento'],
];

// Mesmo seletor de DDI da tela de Aplicacao (visual consistente; a API junta ddi +
// numero num unico campo telefone, igual ao /api/aplicacao).
const OPCOES_DDI = [
  ['+55', 'Brasil +55'],
  ['+1', 'EUA/Canadá +1'],
  ['+351', 'Portugal +351'],
  ['+44', 'Reino Unido +44'],
  ['+34', 'Espanha +34'],
];

function formularioBancoCurriculos() {
  const opcoesDdi = OPCOES_DDI.map(
    ([v, rotulo], i) =>
      `<option value="${v}"${i === 0 ? ' selected' : ''}>${escapeHtml(rotulo)}</option>`,
  ).join('');

  const opcoesPerfil = PERFIS_INTERESSE.map(
    ([v, rotulo]) => `<option value="${v}">${escapeHtml(rotulo)}</option>`,
  ).join('');

  return `
  <form id="form-banco-curriculos" class="vm-form" enctype="multipart/form-data" novalidate>
    <p class="vm-form-erro" data-erro hidden role="alert"></p>

    <section class="vm-passo">
      <label class="vm-campo">Nome completo
        <input type="text" name="nome" autocomplete="name" required>
      </label>

      <label class="vm-campo">E-mail
        <input type="email" name="email" autocomplete="email" required>
      </label>

      <div class="vm-campo">Telefone
        <div class="vm-tel">
          <select name="ddi" aria-label="Código do país">${opcoesDdi}</select>
          <input type="tel" name="telefone" inputmode="tel" placeholder="(11) 90000-0000" required>
        </div>
      </div>

      <label class="vm-campo">Perfil de interesse
        <select name="perfil_interesse" required>
          <option value="" selected>Selecione...</option>
          ${opcoesPerfil}
        </select>
      </label>

      <label class="vm-campo">URL do LinkedIn (opcional)
        <input type="url" name="linkedin_url" placeholder="https://linkedin.com/in/...">
      </label>

      <div class="vm-campo">Currículo (PDF)
        <label class="vm-upload" data-upload>
          <input type="file" name="curriculo" accept="application/pdf,.pdf" hidden>
          <span class="vm-upload__icone" aria-hidden="true">⬆</span>
          <span class="vm-upload__texto" data-upload-texto>Clique para enviar ou arraste seu PDF aqui</span>
          <span class="vm-upload__dica">Somente .pdf · até 10 MB</span>
        </label>
      </div>

      <label class="vm-aceite">
        <input type="checkbox" name="consentimento" value="1" required data-consentimento>
        <span>Autorizo o armazenamento do meu currículo e dos meus dados (nome, e-mail,
        telefone e LinkedIn) no <b>banco de talentos</b> da Vendedor Mestre, para ser
        considerado(a) em futuras oportunidades de vendas. Este aceite vale apenas para o
        banco de talentos — não é uma candidatura a uma vaga (que tem consentimento
        próprio) — e posso solicitar a remoção dos meus dados a qualquer momento.</span>
      </label>

      <button type="submit" class="vm-btn vm-btn--primario" data-enviar disabled>Enviar currículo</button>
    </section>
  </form>`;
}

// ── GET /bancodecurriculos ── landing com pitch curto + formulario de cadastro ──
router.get('/', (req, res) => {
  const conteudo = `
    <section class="vm-hero">
      <p class="vm-kicker">Vendedor Mestre</p>
      <h1 class="vm-title">Banco de Currículos</h1>
      <p class="vm-lead">Não encontrou uma vaga aberta para o seu perfil? Deixe seu
      currículo no nosso banco de talentos: analisamos seu perfil de vendas e entramos
      em contato quando surgir uma oportunidade compatível.</p>
    </section>
    ${formularioBancoCurriculos()}`;

  res.send(pagina({ titulo: 'Banco de Currículos', tema: 'claro', conteudo }));
});

// ── GET /bancodecurriculos/recebido ── confirmacao provisoria (T2) ──
// No T3 o fluxo passa a exibir o resultado da analise do curriculo no lugar desta tela.
router.get('/recebido', (req, res) => {
  const conteudo = `
    <section class="vm-hero vm-hero--centro">
      <p class="vm-kicker">Banco de Currículos</p>
      <h1 class="vm-title">Recebemos seu cadastro!</h1>
      <p class="vm-lead">Seu currículo já está no nosso banco de talentos. Em breve
      mostraremos aqui a análise do seu perfil — e entraremos em contato quando surgir
      uma oportunidade compatível com você.</p>
      <a class="vm-btn vm-btn--secundario" href="/">Voltar ao início</a>
    </section>`;

  res.send(pagina({ titulo: 'Cadastro recebido', tema: 'claro', conteudo }));
});

module.exports = router;
