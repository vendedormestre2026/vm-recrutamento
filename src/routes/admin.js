'use strict';

// Painel do recrutador (Fase 5). Area protegida por login (usuario + senha), separada
// do funil do candidato. Server-rendered, identidade visual Vendedor Mestre (tema
// escuro: preto #0D0B0A, laranja #FF5500, off-white #F4F3F1; Barlow Condensed nos titulos).
//
// Seguranca: o middleware adminAuth abaixo protege TODAS as rotas deste router, EXCETO
// as publicas de login/logout (registradas antes dele). O cookie de admin (vm_admin) e
// ASSINADO com o SESSION_SECRET (mesmo cookie-parser do candidato) e guarda o valor de
// ADMIN_PASSWORD. Sem ADMIN_USER/ADMIN_PASSWORD definidos, o login nunca autentica.

const express = require('express');
const fs = require('node:fs');
const { config } = require('../config');
const db = require('../db');
const drive = require('../providers/drive');
const llm = require('../providers/llm');
const { importarVagaDeBriefing } = require('../lib/importar_vaga');
const { calcularPontuacaoGeral, badgeRecomendacaoHtml } = require('../lib/relatorio');
const { escapeHtml } = require('../views');

const router = express.Router();

const COOKIE_ADMIN = 'vm_admin';
const MAX_IDADE_ADMIN_MS = 15 * 24 * 60 * 60 * 1000; // 15 dias

// Sessao de admin valida: cookie assinado vm_admin igual a senha configurada.
// Sem ADMIN_PASSWORD definido, nunca autentica (painel bloqueado).
function adminAutenticado(req) {
  const senha = config.admin.password;
  return Boolean(senha) && req.signedCookies && req.signedCookies[COOKIE_ADMIN] === senha;
}

// Saneia o destino de redirecionamento pos-login: aceita apenas caminhos internos
// do painel (evita open redirect via ?redirect=//site-externo). Default: /admin.
function destinoSeguro(redirect) {
  const r = String(redirect || '');
  return /^\/admin(\/|\?|$)/.test(r) ? r : '/admin';
}

// Valida uma data no formato estrito YYYY-MM-DD E que seja um dia real (rejeita
// 2026-02-31, mes 13 etc.). Usado pelo filtro de periodo do endpoint do funil.
function dataIsoValida(s) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

// ── Middleware de acesso ao painel ──
// Sem sessao valida (cookie vm_admin assinado == ADMIN_PASSWORD) -> manda para a
// tela de login, preservando em ?redirect o destino que o usuario tentou abrir.
// Com sessao valida -> segue.
function adminAuth(req, res, next) {
  if (adminAutenticado(req)) {
    return next();
  }
  const destino = encodeURIComponent(req.originalUrl);
  return res.redirect(`/admin/login?redirect=${destino}`);
}

// ── Rotas PUBLICAS de login (ficam ANTES do router.use(adminAuth) para nao serem
//    barradas pelo proprio gate de acesso) ──

// GET /admin/login: formulario. Se ja autenticado, vai direto ao destino.
router.get('/login', (req, res) => {
  const destino = destinoSeguro(req.query.redirect);
  if (adminAutenticado(req)) {
    return res.redirect(destino);
  }
  res.send(paginaLogin({ redirect: destino }));
});

// POST /admin/login: valida ADMIN_USER + ADMIN_PASSWORD (comparacao direta; sao
// credenciais fixas de ambiente, nao armazenadas). Sucesso grava o cookie de 15
// dias; falha re-renderiza o formulario sem revelar qual campo errou.
router.post('/login', (req, res) => {
  const b = req.body || {};
  const usuario = String(b.usuario || '');
  const senha = String(b.senha || '');
  const destino = destinoSeguro(b.redirect);

  const { user, password } = config.admin;
  const ok = Boolean(user) && Boolean(password) && usuario === user && senha === password;
  if (!ok) {
    return res
      .status(401)
      .send(paginaLogin({ erro: 'Usuário ou senha inválidos.', redirect: destino }));
  }

  res.cookie(COOKIE_ADMIN, password, {
    httpOnly: true,
    signed: true,
    sameSite: 'lax',
    secure: config.ehProducao,
    maxAge: MAX_IDADE_ADMIN_MS,
    path: '/',
  });
  res.redirect(destino);
});

// GET /admin/logout: encerra a sessao (limpa o cookie) e volta ao login. Publica
// para funcionar mesmo com cookie ja invalido.
router.get('/logout', (req, res) => {
  res.clearCookie(COOKIE_ADMIN, { path: '/' });
  res.redirect('/admin/login');
});

router.use(adminAuth);

// ── Helpers de apresentacao ──

// CSS do painel (tema escuro), embutido para nao tocar no pipeline de CSS do candidato.
const ESTILO_ADMIN = `
  :root { --preto:#0D0B0A; --laranja:#FF5500; --offwhite:#F4F3F1; --campo:#1a1816; --linha:#2a2724; --cinza:#b8b2ac; }
  * { box-sizing: border-box; }
  body { margin:0; background:var(--preto); color:var(--offwhite); font-family:'Barlow',system-ui,sans-serif; }
  .admin-wrap { max-width:1100px; margin:0 auto; padding:2rem 1.25rem 4rem; }
  .admin-cab { border-bottom:1px solid var(--linha); padding-bottom:1rem; margin-bottom:1.5rem; }
  .admin-logo { font-family:'Barlow Condensed',sans-serif; font-weight:900; text-transform:uppercase; color:var(--laranja); font-size:2rem; letter-spacing:.04em; margin:0; }
  .admin-sub { color:var(--offwhite); margin:.15rem 0 0; font-size:1.05rem; }
  .admin-sair { color:var(--cinza); font-size:.85rem; text-decoration:none; white-space:nowrap; }
  .admin-sair:hover { color:var(--laranja); }
  h1,h2,h3 { font-family:'Barlow Condensed',sans-serif; text-transform:uppercase; letter-spacing:.03em; }
  a { color:var(--laranja); }
  .admin-tab-scroll { overflow-x:auto; -webkit-overflow-scrolling:touch; }
  table.admin-tab { width:100%; border-collapse:collapse; font-size:.95rem; min-width:760px; }
  table.admin-tab th, table.admin-tab td { text-align:left; padding:.6rem .7rem; border-bottom:1px solid var(--linha); white-space:nowrap; }
  table.admin-tab th { font-family:'Barlow Condensed',sans-serif; text-transform:uppercase; color:var(--cinza); font-weight:700; }
  .badge { display:inline-block; padding:.15rem .55rem; border-radius:999px; font-size:.8rem; font-weight:600; }
  .badge--aplicado { background:var(--linha); color:var(--cinza); }
  .badge--entrevista { background:var(--laranja); color:var(--preto); }
  .badge--concluido { background:transparent; color:var(--offwhite); border:1px solid var(--offwhite); }
  .btn { display:inline-block; padding:.4rem .8rem; border-radius:6px; text-decoration:none; font-weight:600; font-size:.85rem; background:var(--laranja); color:var(--preto); border:none; cursor:pointer; }
  .btn--off { background:var(--linha); color:var(--cinza); pointer-events:none; }
  .btn--ghost { background:transparent; color:var(--offwhite); border:1px solid var(--linha); }
  .admin-rodape { margin-top:1.5rem; padding-top:1rem; border-top:1px solid var(--linha); color:var(--cinza); font-size:.9rem; }
  .admin-filtros { display:flex; gap:.75rem; align-items:flex-end; flex-wrap:wrap; margin-bottom:1.25rem; }
  .admin-filtros .filtro { display:flex; flex-direction:column; gap:.25rem; }
  .admin-filtros .filtro > span { color:var(--cinza); font-size:.8rem; text-transform:uppercase; }
  .admin-filtros select, .admin-filtros input[type=date] { background:var(--campo); color:var(--offwhite); border:1px solid var(--linha); border-radius:6px; padding:.5rem .6rem; font:inherit; }
  .admin-filtros select:focus, .admin-filtros input[type=date]:focus { outline:none; border-color:var(--laranja); }
  .rel-sec { margin:1.5rem 0; }
  .rel-id { display:grid; grid-template-columns:repeat(auto-fit,minmax(200px,1fr)); gap:.5rem 1.5rem; }
  .rel-id dt { color:var(--cinza); font-size:.8rem; text-transform:uppercase; }
  .rel-id dd { margin:0 0 .5rem; }
  .comp { border:1px solid var(--linha); border-radius:8px; padding:.8rem 1rem; margin-bottom:.7rem; }
  .comp--off { opacity:.7; }
  .comp-cab { display:flex; justify-content:space-between; align-items:center; gap:1rem; }
  .comp-nota { font-family:'Barlow Condensed',sans-serif; font-weight:900; font-size:1.6rem; color:var(--laranja); }
  .comp-nota small { color:var(--cinza); font-size:.9rem; }
  .tag-off { display:inline-block; font-size:.75rem; color:var(--preto); background:var(--cinza); padding:.1rem .45rem; border-radius:4px; margin-left:.5rem; }
  .lista { margin:.3rem 0 0; padding-left:1.2rem; }
  .transc { font-size:.85rem; }
  .turno { padding:.5rem .8rem; border-radius:6px; margin-bottom:.4rem; background:var(--campo); }
  .turno-autor { font-family:'Barlow Condensed',sans-serif; text-transform:uppercase; color:var(--laranja); font-weight:700; font-size:.8rem; }
  .turno--cand .turno-autor { color:var(--offwhite); }
  .campo { display:block; margin-bottom:1rem; }
  .campo > span { display:block; color:var(--cinza); font-size:.85rem; text-transform:uppercase; margin-bottom:.3rem; }
  .campo input[type=text], .campo input[type=password], .campo select, .campo textarea { width:100%; background:var(--campo); color:var(--offwhite); border:1px solid var(--linha); border-radius:6px; padding:.6rem .7rem; font:inherit; }
  .campo input[type=text]:focus, .campo input[type=password]:focus, .campo select:focus, .campo textarea:focus { outline:none; border-color:var(--laranja); }
  .campo-check { display:flex; align-items:center; gap:.5rem; margin-bottom:1.2rem; }
  .aviso-ok { background:var(--linha); border-left:3px solid var(--laranja); padding:.6rem .9rem; border-radius:4px; margin-bottom:1rem; }
  .aviso-alerta { background:var(--campo); border:1px solid var(--laranja); border-left:4px solid var(--laranja); color:var(--offwhite); padding:.6rem .9rem; border-radius:4px; margin-bottom:1rem; font-size:.92rem; }
  .badge--ativa { background:var(--laranja); color:var(--preto); }
  .badge--encerrada { background:var(--linha); color:var(--cinza); }
  .tag-aviso { display:inline-block; font-size:.72rem; font-weight:700; color:var(--laranja); border:1px solid var(--laranja); padding:.05rem .4rem; border-radius:4px; margin-left:.4rem; white-space:nowrap; }
  .acoes-linha { display:flex; gap:.4rem; align-items:center; }
  .acoes-linha form { margin:0; display:inline; }
  .campo input[type=number] { width:6rem; background:var(--campo); color:var(--offwhite); border:1px solid var(--linha); border-radius:6px; padding:.6rem .7rem; font:inherit; }
  .campo input[type=number]:focus { outline:none; border-color:var(--laranja); }
  .bloco-card { border:1px solid var(--linha); border-radius:8px; padding:.2rem 1rem; margin-bottom:.7rem; }
  .bloco-card > summary { font-family:'Barlow Condensed',sans-serif; text-transform:uppercase; letter-spacing:.03em; cursor:pointer; padding:.7rem 0; color:var(--offwhite); font-weight:700; }
  .bloco-card[open] > summary { border-bottom:1px solid var(--linha); margin-bottom:.8rem; }
  /* Funil de conversao (dashboard) — barras em CSS puro, sem lib de grafico. */
  .funil { margin:.4rem 0 0; }
  .funil-etapa { margin-bottom:1.1rem; }
  .funil-topo { display:flex; justify-content:space-between; align-items:baseline; gap:1rem; margin-bottom:.3rem; }
  .funil-rotulo { font-family:'Barlow Condensed',sans-serif; text-transform:uppercase; letter-spacing:.03em; color:var(--offwhite); font-weight:700; font-size:1.05rem; }
  .funil-num { font-family:'Barlow Condensed',sans-serif; font-weight:900; font-size:1.9rem; color:var(--laranja); line-height:1; }
  .funil-trilho { background:var(--campo); border:1px solid var(--linha); border-radius:6px; height:1.4rem; overflow:hidden; }
  .funil-barra { height:100%; background:var(--laranja); border-radius:5px 0 0 5px; min-width:0; }
  .funil-taxa { color:var(--cinza); font-size:.78rem; margin-top:.28rem; text-transform:uppercase; letter-spacing:.02em; }
  .funil-taxa b { color:var(--offwhite); font-weight:700; }
  tr.linha-zero { opacity:.5; }
  td.col-num, th.col-num { text-align:right; font-variant-numeric:tabular-nums; }
`;

// Shell HTML do painel (sem o header/funil/app.js do candidato).
function paginaAdmin({ titulo, conteudo, subtitulo = 'Painel do Recrutador', mostrarSair = true }) {
  const sair = mostrarSair ? '<a class="admin-sair" href="/admin/logout">Sair</a>' : '';
  return `<!doctype html>
<html lang="pt-BR">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="robots" content="noindex, nofollow">
  <title>${escapeHtml(titulo)} · Vendedor Mestre</title>
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Barlow:wght@400;500;600&family=Barlow+Condensed:wght@700;900&display=swap" rel="stylesheet">
  <style>${ESTILO_ADMIN}</style>
</head>
<body>
  <div class="admin-wrap">
    <header class="admin-cab" style="display:flex;justify-content:space-between;align-items:flex-start;gap:1rem;">
      <div>
        <p class="admin-logo">Vendedor Mestre</p>
        <p class="admin-sub">${escapeHtml(subtitulo)}</p>
      </div>
      ${sair}
    </header>
    ${conteudo}
  </div>
</body>
</html>`;
}

// Pagina de erro/403 simples (nao expoe estrutura interna).
function paginaErroAdmin(mensagem) {
  return paginaAdmin({
    titulo: 'Acesso negado',
    subtitulo: 'Painel do Recrutador',
    conteudo: `
      <section class="rel-sec">
        <h1>Acesso negado</h1>
        <p>${escapeHtml(mensagem)}</p>
      </section>`,
  });
}

// Tela de login do painel. Reusa o shell paginaAdmin (mesma identidade visual);
// conteudo minimalista: titulo, campos usuario/senha e botao Entrar. O campo
// oculto "redirect" preserva o destino pretendido atraves do POST.
function paginaLogin({ erro = '', redirect = '/admin' } = {}) {
  return paginaAdmin({
    titulo: 'Entrar',
    subtitulo: 'Painel Administrativo',
    mostrarSair: false,
    conteudo: `
      <section class="rel-sec" style="max-width:380px;margin:2rem auto 0;">
        <h1 style="margin:0 0 1.2rem;">Painel administrativo</h1>
        ${erro ? `<p class="aviso-alerta">${escapeHtml(erro)}</p>` : ''}
        <form method="POST" action="/admin/login">
          <input type="hidden" name="redirect" value="${escapeHtml(redirect)}">
          <label class="campo">
            <span>Usuário</span>
            <input type="text" name="usuario" autocomplete="username" autofocus required>
          </label>
          <label class="campo">
            <span>Senha</span>
            <input type="password" name="senha" autocomplete="current-password" required>
          </label>
          <button type="submit" class="btn" style="width:100%;">Entrar</button>
        </form>
      </section>`,
  });
}

// Formata 'YYYY-MM-DD HH:MM:SS' (UTC do SQLite) como 'dd/mm/aaaa hh:mm'.
function formatarDataHora(sqliteDt) {
  if (!sqliteDt) return '—';
  const m = String(sqliteDt).match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})/);
  if (!m) return String(sqliteDt);
  const [, ano, mes, dia, hh, mm] = m;
  return `${dia}/${mes}/${ano} ${hh}:${mm}`;
}

// Rotulo + classe de badge por status.
function badgeStatus(status) {
  const mapa = {
    aplicado: ['Aplicado', 'badge--aplicado'],
    em_entrevista: ['Em entrevista', 'badge--entrevista'],
    concluido: ['Concluído', 'badge--concluido'],
  };
  const [rotulo, classe] = mapa[status] || [status || '—', 'badge--aplicado'];
  return `<span class="badge ${classe}">${escapeHtml(rotulo)}</span>`;
}

function nomeCompleto(linha) {
  const nome = [linha.nome, linha.sobrenome].filter(Boolean).join(' ').trim();
  return nome || linha.email || '—';
}

// Inteiro com separador de milhar (pt-BR).
function fmtInt(n) {
  return Number(n || 0).toLocaleString('pt-BR');
}

// Taxa de conversao numerador/denominador como percentual inteiro. Divisao por zero
// (ou denominador ausente) -> '—' (nunca NaN/Infinity). Usado no funil do dashboard.
function taxaConversao(numerador, denominador) {
  const den = Number(denominador);
  if (!Number.isFinite(den) || den <= 0) return '—';
  return `${Math.round((Number(numerador) / den) * 100)}%`;
}

// Largura percentual (0–100) de uma barra proporcional ao maior valor do funil.
// max<=0 (tudo zero) -> 0, sem divisao por zero.
function larguraBarra(valor, max) {
  const m = Number(max);
  if (!Number.isFinite(m) || m <= 0) return 0;
  return Math.max(0, Math.min(100, (Number(valor) / m) * 100));
}
// Custo em USD: 6 casas nos totais, 8 nas linhas (custos por chamada sao minusculos).
function fmtUsd6(n) {
  return `$${Number(n || 0).toFixed(6)}`;
}
function fmtUsd8(n) {
  return `$${Number(n || 0).toFixed(8)}`;
}

// ── GET /admin ── lista de candidatos (com filtros por status e data, via query string) ──
router.get('/', (req, res) => {
  const q = req.query || {};
  // Saneamento: status so vale se for um dos valores conhecidos; datas no formato YYYY-MM-DD.
  const STATUS_VALIDOS = ['aplicado', 'em_entrevista', 'concluido'];
  const status = STATUS_VALIDOS.includes(q.status) ? q.status : '';
  const ehData = (v) => /^\d{4}-\d{2}-\d{2}$/.test(String(v || ''));
  const dataDe = ehData(q.de) ? q.de : '';
  const dataAte = ehData(q.ate) ? q.ate : '';

  const candidatos = db.listarAplicacoesComContexto({ status, dataDe, dataAte });

  const linhas = candidatos
    .map((c) => {
      const podeVerRelatorio = c.status === 'concluido' && c.report_interview_id != null;
      const acao = podeVerRelatorio
        ? `<a class="btn" href="/admin/relatorio/${c.report_interview_id}">Ver relatório</a>`
        : `<span class="btn btn--off">Ver relatório</span>`;
      const video = c.video_url
        ? `<a href="${escapeHtml(c.video_url)}" target="_blank" rel="noopener noreferrer">Abrir</a>`
        : '—';
      return `
        <tr>
          <td><a href="/admin/candidato/${c.id}">${escapeHtml(nomeCompleto(c))}</a></td>
          <td>${escapeHtml(c.email || '—')}</td>
          <td>${escapeHtml(c.telefone || '—')}</td>
          <td>${escapeHtml(c.vaga_titulo || '—')}</td>
          <td>${badgeStatus(c.status)}</td>
          <td>${escapeHtml(formatarDataHora(c.criado_em))}</td>
          <td>${video}</td>
          <td>${acao}</td>
        </tr>`;
    })
    .join('');

  const totalCandidatos = db.contarAplicacoes();
  const totalConcluidas = db.contarEntrevistasConcluidas();

  const sel = (v) => (status === v ? ' selected' : '');
  const temFiltro = status || dataDe || dataAte;
  const filtros = `
    <form method="GET" action="/admin" class="admin-filtros">
      <label class="filtro">
        <span>Status</span>
        <select name="status">
          <option value=""${status ? '' : ' selected'}>Todos</option>
          <option value="aplicado"${sel('aplicado')}>Aplicado</option>
          <option value="em_entrevista"${sel('em_entrevista')}>Em entrevista</option>
          <option value="concluido"${sel('concluido')}>Concluído</option>
        </select>
      </label>
      <label class="filtro">
        <span>De</span>
        <input type="date" name="de" value="${escapeHtml(dataDe)}">
      </label>
      <label class="filtro">
        <span>Até</span>
        <input type="date" name="ate" value="${escapeHtml(dataAte)}">
      </label>
      <button type="submit" class="btn">Filtrar</button>
      ${temFiltro ? '<a class="btn btn--ghost" href="/admin">Limpar</a>' : ''}
    </form>`;

  // Aviso pos-acao (arquivar/restaurar), sinalizado por query string apos o redirect.
  const flashLista =
    req.query.arquivado === '1'
      ? '<div class="aviso-ok">Lead arquivado. Ele saiu da listagem, mas o histórico foi preservado.</div>'
      : req.query.restaurado === '1'
        ? '<div class="aviso-ok">Lead restaurado.</div>'
        : '';

  const conteudo = `
    ${flashLista}
    <div style="display:flex;justify-content:space-between;align-items:center;gap:1rem;flex-wrap:wrap;margin-bottom:1rem;">
      <h1 style="margin:0;">Candidatos</h1>
      <div style="display:flex;gap:.5rem;flex-wrap:wrap;">
        <a class="btn btn--ghost" href="/admin/dashboard">Funil de Conversão</a>
        <a class="btn btn--ghost" href="/admin/vagas">Vagas</a>
        <a class="btn btn--ghost" href="/admin/roteiro">Editar roteiro</a>
        <a class="btn btn--ghost" href="/admin/config">Configurações</a>
        <a class="btn btn--ghost" href="/admin/uso">Custos / Uso API</a>
      </div>
    </div>
    ${filtros}
    <div class="admin-tab-scroll">
      <table class="admin-tab">
        <thead>
          <tr>
            <th>Nome</th><th>E-mail</th><th>Telefone</th><th>Vaga</th>
            <th>Status</th><th>Criado em</th><th>Vídeo</th><th>Ação</th>
          </tr>
        </thead>
        <tbody>
          ${linhas || `<tr><td colspan="8">${temFiltro ? 'Nenhum candidato para os filtros aplicados.' : 'Nenhum candidato ainda.'}</td></tr>`}
        </tbody>
      </table>
    </div>
    <p class="admin-rodape">
      Total de candidatos: <b>${totalCandidatos}</b> ·
      Entrevistas concluídas: <b>${totalConcluidas}</b>
    </p>`;

  res.send(paginaAdmin({ titulo: 'Candidatos', conteudo }));
});

// Renderiza campos_extras (legado): objeto -> lista chave/valor; string -> tenta JSON,
// senao texto cru; vazio/nulo -> travessao. Nunca imprime [object Object]/undefined.
function camposExtrasHtml(valor) {
  let obj = valor;
  if (typeof valor === 'string') {
    const cru = valor.trim();
    if (!cru) return '<p>—</p>';
    try {
      obj = JSON.parse(cru);
    } catch {
      return `<p>${escapeHtml(cru)}</p>`; // nao era JSON: mostra o texto cru
    }
  }
  if (obj && typeof obj === 'object' && !Array.isArray(obj)) {
    const chaves = Object.keys(obj);
    if (!chaves.length) return '<p>—</p>';
    const itens = chaves
      .map((k) => `<div><dt>${escapeHtml(k)}</dt><dd>${escapeHtml(String(obj[k]))}</dd></div>`)
      .join('');
    return `<dl class="rel-id">${itens}</dl>`;
  }
  if (obj == null || obj === '') return '<p>—</p>';
  return `<p>${escapeHtml(String(obj))}</p>`;
}

// Nome de arquivo seguro para o download do curriculo (sem acentos, so [a-zA-Z0-9._-]).
function sanitizarNomeArquivo(base) {
  const limpo = String(base || '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '') // remove acentos (diacriticos)
    .replace(/[^a-zA-Z0-9._-]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 80);
  return limpo || 'curriculo';
}

// Card de aviso padrao (reusa o shell admin) para os 404 amigaveis desta area.
function avisoAdmin(res, codigo, { titulo, descricao }) {
  return res.status(codigo).send(
    paginaAdmin({
      titulo,
      conteudo: `
        <section class="rel-sec">
          <h1>${escapeHtml(titulo)}</h1>
          <p>${escapeHtml(descricao)}</p>
          <p><a class="btn btn--ghost" href="/admin">← Voltar ao painel</a></p>
        </section>`,
    }),
  );
}

// ── GET /admin/candidato/:id ── tela de detalhe do candidato (por application_id) ──
router.get('/candidato/:id', (req, res) => {
  const id = Number(req.params.id);
  const cand = Number.isInteger(id) && id > 0 ? db.obterAplicacao(id) : null;
  if (!cand) {
    return avisoAdmin(res, 404, {
      titulo: 'Candidato não encontrado',
      descricao: 'Não há candidatura com este identificador.',
    });
  }

  const vaga = cand.job_id ? db.obterVaga(cand.job_id) : null;
  const ultimaInterview = db.obterUltimaInterviewPorAplicacao(cand.id);
  const interviewId = ultimaInterview ? ultimaInterview.id : null;
  const report = interviewId ? db.obterReportPorInterview(interviewId) : null;
  const videoUrl = ultimaInterview ? ultimaInterview.video_url : null;

  // Mesmo criterio da lista: relatorio so quando a entrevista concluiu e ha report.
  const podeVerRelatorio = cand.status === 'concluido' && interviewId != null && report != null;
  const botaoRelatorio = podeVerRelatorio
    ? `<a class="btn" href="/admin/relatorio/${interviewId}">Ver relatório</a>`
    : `<span class="btn btn--off">Ver relatório</span>`;

  const temCurriculo = Boolean(cand.curriculo_path);
  const botaoCurriculo = temCurriculo
    ? `<a class="btn" href="/admin/candidato/${cand.id}/curriculo">Baixar currículo (PDF)</a>`
    : `<span class="btn btn--off">Baixar currículo (PDF)</span>`;

  const botaoVideo = videoUrl
    ? `<a class="btn btn--ghost" href="${escapeHtml(videoUrl)}" target="_blank" rel="noopener noreferrer">Abrir vídeo</a>`
    : `<span class="btn btn--off">Abrir vídeo</span>`;

  const linkedin = cand.linkedin_url
    ? `<a href="${escapeHtml(cand.linkedin_url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(cand.linkedin_url)}</a>`
    : '—';

  const arquivado = Boolean(cand.deleted_at);

  // Aviso pos-acao (edicao/restauracao), sinalizado por query string apos o redirect.
  const flash =
    req.query.ok === 'editado'
      ? '<div class="aviso-ok">Dados do candidato atualizados.</div>'
      : req.query.ok === 'restaurado'
        ? '<div class="aviso-ok">Lead restaurado.</div>'
        : '';

  const avisoArquivado = arquivado
    ? `<div class="aviso-alerta">Lead arquivado em ${escapeHtml(formatarDataHora(cand.deleted_at))}. Ele não aparece na listagem, mas o histórico foi preservado.</div>`
    : '';

  const botaoEditar = `<a class="btn" href="/admin/candidato/${cand.id}/editar">Editar</a>`;

  // Arquivar (com confirm) ou Restaurar, conforme o estado. Ambos via POST (nunca GET,
  // para nao disparar por link acidental / prefetch).
  const botaoArquivarRestaurar = arquivado
    ? `<form method="POST" action="/admin/candidato/${cand.id}/restaurar" style="margin:0;display:inline;">
         <button type="submit" class="btn btn--ghost">Restaurar lead</button>
       </form>`
    : `<form method="POST" action="/admin/candidato/${cand.id}/arquivar" style="margin:0;display:inline;"
             onsubmit="return confirm('Arquivar este lead? Ele sai da listagem, mas o histórico é preservado.')">
         <button type="submit" class="btn btn--ghost">Arquivar lead</button>
       </form>`;

  const conteudo = `
    <div style="display:flex;justify-content:space-between;align-items:center;gap:1rem;flex-wrap:wrap;margin-bottom:1rem;">
      <h1 style="margin:0;">${escapeHtml(nomeCompleto(cand))}</h1>
      <a class="btn btn--ghost" href="/admin">← Voltar ao painel</a>
    </div>
    ${flash}
    ${avisoArquivado}

    <section class="rel-sec">
      <h2>Dados pessoais</h2>
      <dl class="rel-id">
        <div><dt>Nome</dt><dd>${escapeHtml(cand.nome || '—')}</dd></div>
        <div><dt>Sobrenome</dt><dd>${escapeHtml(cand.sobrenome || '—')}</dd></div>
        <div><dt>E-mail</dt><dd>${escapeHtml(cand.email || '—')}</dd></div>
        <div><dt>Telefone</dt><dd>${escapeHtml(cand.telefone || '—')}</dd></div>
        <div><dt>LinkedIn</dt><dd>${linkedin}</dd></div>
        ${cand.cidade ? `<div><dt>Cidade</dt><dd>${escapeHtml(cand.cidade)}</dd></div>` : ''}
        <div><dt>Vaga</dt><dd>${escapeHtml((vaga && vaga.titulo) || cand.vaga_titulo || '—')}</dd></div>
        <div><dt>Status</dt><dd>${badgeStatus(cand.status)}</dd></div>
        <div><dt>Aplicou em</dt><dd>${escapeHtml(formatarDataHora(cand.criado_em))}</dd></div>
      </dl>
    </section>

    <section class="rel-sec">
      <h2>Consentimentos (LGPD)</h2>
      <dl class="rel-id">
        <div><dt>Aceite de coleta/uso</dt><dd>${escapeHtml(formatarDataHora(cand.consent_at))}</dd></div>
        <div><dt>Aceite de gravação</dt><dd>${escapeHtml(formatarDataHora(cand.consent_gravacao_at))}</dd></div>
      </dl>
    </section>

    <section class="rel-sec">
      <h2>Campos extras</h2>
      ${camposExtrasHtml(cand.campos_extras)}
    </section>

    <section class="rel-sec">
      <h2>Ações</h2>
      <div class="acoes-linha" style="flex-wrap:wrap;gap:.6rem;">
        ${botaoEditar}
        ${botaoCurriculo}
        ${botaoRelatorio}
        ${botaoVideo}
        ${botaoArquivarRestaurar}
      </div>
    </section>`;

  res.send(paginaAdmin({ titulo: `Candidato — ${nomeCompleto(cand)}`, conteudo }));
});

// ── GET /admin/candidato/:id/curriculo ── download do PDF do curriculo ──
// Seguranca: o caminho vem do DB (curriculo_path absoluto), NUNCA de req.params —
// evita path traversal. 404 amigavel se a app/coluna/arquivo nao existir.
router.get('/candidato/:id/curriculo', (req, res) => {
  const id = Number(req.params.id);
  const cand = Number.isInteger(id) && id > 0 ? db.obterAplicacao(id) : null;
  if (!cand || !cand.curriculo_path) {
    return avisoAdmin(res, 404, {
      titulo: 'Currículo não disponível',
      descricao: 'Este candidato não possui currículo anexado.',
    });
  }

  const caminho = cand.curriculo_path; // caminho absoluto do banco (nao montado de req)
  if (!fs.existsSync(caminho)) {
    return avisoAdmin(res, 404, {
      titulo: 'Arquivo não encontrado',
      descricao: 'O arquivo do currículo não foi localizado no armazenamento.',
    });
  }

  const nomeArquivo = `${sanitizarNomeArquivo(`curriculo_${cand.nome || ''}_${cand.sobrenome || ''}`)}.pdf`;
  res.type('application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename="${nomeArquivo}"`);
  return res.sendFile(caminho);
});

// Validacao simples de e-mail (formato basico local@dominio.tld). Vazio e tratado
// como "sem e-mail" por quem chama (nao passa por aqui).
function emailValido(s) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(s || ''));
}

// Formulario de edicao do candidato (campos de contato). `valores` permite re-render
// preservando o que o recrutador digitou quando a validacao falha.
function formEditar(cand, { erro = '', valores = null } = {}) {
  const v = valores || cand;
  const val = (x) => escapeHtml(x == null ? '' : String(x));
  return `
    <div style="display:flex;justify-content:space-between;align-items:center;gap:1rem;flex-wrap:wrap;margin-bottom:1rem;">
      <h1 style="margin:0;">Editar candidato</h1>
      <a class="btn btn--ghost" href="/admin/candidato/${cand.id}">← Cancelar</a>
    </div>
    ${erro ? `<div class="aviso-alerta">${escapeHtml(erro)}</div>` : ''}
    <form method="POST" action="/admin/candidato/${cand.id}/editar">
      <label class="campo"><span>Nome</span><input type="text" name="nome" value="${val(v.nome)}"></label>
      <label class="campo"><span>Sobrenome</span><input type="text" name="sobrenome" value="${val(v.sobrenome)}"></label>
      <label class="campo"><span>E-mail</span><input type="text" name="email" value="${val(v.email)}"></label>
      <label class="campo"><span>Telefone</span><input type="text" name="telefone" value="${val(v.telefone)}"></label>
      <label class="campo"><span>LinkedIn (URL)</span><input type="text" name="linkedin_url" value="${val(v.linkedin_url)}"></label>
      <label class="campo"><span>Cidade</span><input type="text" name="cidade" value="${val(v.cidade)}"></label>
      <div class="acoes-linha" style="gap:.6rem;">
        <button type="submit" class="btn">Salvar</button>
        <a class="btn btn--ghost" href="/admin/candidato/${cand.id}">Cancelar</a>
      </div>
    </form>`;
}

// ── GET /admin/candidato/:id/editar ── formulario de edicao dos dados de contato ──
router.get('/candidato/:id/editar', (req, res) => {
  const id = Number(req.params.id);
  const cand = Number.isInteger(id) && id > 0 ? db.obterAplicacao(id) : null;
  if (!cand) {
    return avisoAdmin(res, 404, {
      titulo: 'Candidato não encontrado',
      descricao: 'Não há candidatura com este identificador.',
    });
  }
  return res.send(
    paginaAdmin({ titulo: `Editar — ${nomeCompleto(cand)}`, conteudo: formEditar(cand) }),
  );
});

// ── POST /admin/candidato/:id/editar ── salva os dados de contato ──
router.post('/candidato/:id/editar', (req, res) => {
  const id = Number(req.params.id);
  const cand = Number.isInteger(id) && id > 0 ? db.obterAplicacao(id) : null;
  if (!cand) {
    return avisoAdmin(res, 404, {
      titulo: 'Candidato não encontrado',
      descricao: 'Não há candidatura com este identificador.',
    });
  }

  const b = req.body || {};
  const trim = (x) => String(x == null ? '' : x).trim();
  const valores = {
    nome: trim(b.nome),
    sobrenome: trim(b.sobrenome),
    email: trim(b.email),
    telefone: trim(b.telefone),
    linkedin_url: trim(b.linkedin_url),
    cidade: trim(b.cidade),
  };

  // E-mail e opcional, mas se informado precisa ter formato valido. LinkedIn e livre.
  if (valores.email && !emailValido(valores.email)) {
    return res.status(400).send(
      paginaAdmin({
        titulo: `Editar — ${nomeCompleto(cand)}`,
        conteudo: formEditar(cand, {
          erro: 'E-mail inválido. Verifique o formato (ex.: nome@dominio.com).',
          valores,
        }),
      }),
    );
  }

  db.atualizarAplicacao(id, valores);
  return res.redirect(`/admin/candidato/${id}?ok=editado`);
});

// ── POST /admin/candidato/:id/arquivar ── soft-delete (sai da listagem) ──
router.post('/candidato/:id/arquivar', (req, res) => {
  const id = Number(req.params.id);
  const cand = Number.isInteger(id) && id > 0 ? db.obterAplicacao(id) : null;
  if (!cand) {
    return avisoAdmin(res, 404, {
      titulo: 'Candidato não encontrado',
      descricao: 'Não há candidatura com este identificador.',
    });
  }
  db.arquivarAplicacao(id);
  return res.redirect('/admin?arquivado=1');
});

// ── POST /admin/candidato/:id/restaurar ── reverte o soft-delete ──
router.post('/candidato/:id/restaurar', (req, res) => {
  const id = Number(req.params.id);
  const cand = Number.isInteger(id) && id > 0 ? db.obterAplicacao(id) : null;
  if (!cand) {
    return avisoAdmin(res, 404, {
      titulo: 'Candidato não encontrado',
      descricao: 'Não há candidatura com este identificador.',
    });
  }
  db.restaurarAplicacao(id);
  return res.redirect(`/admin/candidato/${id}?ok=restaurado`);
});

// ── GET /admin/relatorio/:interviewId ── relatorio individual ──
router.get('/relatorio/:interviewId', (req, res) => {
  const interviewId = Number(req.params.interviewId);
  const interview = Number.isFinite(interviewId) ? db.obterInterview(interviewId) : null;
  const report = interview ? db.obterReportPorInterview(interviewId) : null;

  if (!interview || !report) {
    return res.status(404).send(
      paginaAdmin({
        titulo: 'Relatório não disponível',
        conteudo: `
          <section class="rel-sec">
            <h1>Relatório não disponível</h1>
            <p>Não há relatório gerado para esta entrevista.</p>
            <p><a class="btn btn--ghost" href="/admin">← Voltar ao painel</a></p>
          </section>`,
      }),
    );
  }

  const candidato = db.obterAplicacao(interview.application_id);
  const vaga = candidato ? db.obterVaga(candidato.job_id) : null;
  const perfil = (vaga && vaga.perfil) || interview.perfil || '—';
  const turns = db.listarTurnos(interviewId);
  const roteiro = interview.roteiro_id ? db.obterRoteiro(interview.roteiro_id) : null;

  // Score ponderado calculado on-the-fly (sem coluna no banco).
  const geral = calcularPontuacaoGeral(report.pontuacoes, roteiro);

  // Pontuacoes (array de { competencia, nota, justificativa, coberta }) — coberta vem
  // de dentro do JSON, nao de coluna.
  const comps = (report.pontuacoes || [])
    .map((p) => {
      const off = p.coberta === false;
      const nota = p.nota != null ? `${escapeHtml(String(p.nota))}<small>/5</small>` : '—';
      return `
        <div class="comp${off ? ' comp--off' : ''}">
          <div class="comp-cab">
            <h3 style="margin:0;">${escapeHtml(p.competencia || '')}${off ? '<span class="tag-off">Não abordada</span>' : ''}</h3>
            <span class="comp-nota">${nota}</span>
          </div>
          ${p.justificativa ? `<p style="margin:.4rem 0 0;">${escapeHtml(p.justificativa)}</p>` : ''}
        </div>`;
    })
    .join('');

  const itens = (lista) => (lista || []).map((i) => `<li>${escapeHtml(i)}</li>`).join('');
  const fortes = itens(report.destaque_pontos_fortes);
  const atencao = itens(report.destaque_atencao);

  const nomeCand = nomeCompleto(candidato || {});
  const transcricao = turns
    .map((t) => {
      const ehAgente = t.autor === 'agente';
      const autor = ehAgente ? 'VERA' : nomeCand;
      return `
        <div class="turno${ehAgente ? '' : ' turno--cand'}">
          <span class="turno-autor">${escapeHtml(autor)}</span>
          <p style="margin:.2rem 0 0;">${escapeHtml(t.texto || '')}</p>
        </div>`;
    })
    .join('');

  const conteudo = `
    <p><a class="btn btn--ghost" href="/admin">← Voltar ao painel</a></p>

    <section class="rel-sec">
      <h1 style="margin:0 0 .8rem;">${escapeHtml(nomeCand)}</h1>
      <dl class="rel-id">
        <div><dt>E-mail</dt><dd>${escapeHtml((candidato && candidato.email) || '—')}</dd></div>
        <div><dt>Telefone</dt><dd>${escapeHtml((candidato && candidato.telefone) || '—')}</dd></div>
        <div><dt>Vaga</dt><dd>${escapeHtml((vaga && vaga.titulo) || '—')}</dd></div>
        <div><dt>Perfil</dt><dd>${escapeHtml(perfil)}</dd></div>
        <div><dt>Início</dt><dd>${escapeHtml(formatarDataHora(interview.iniciado_em))}</dd></div>
        <div><dt>Fim</dt><dd>${escapeHtml(formatarDataHora(interview.finalizado_em))}</dd></div>
      </dl>
    </section>

    ${report.resumo ? `<section class="rel-sec"><h2>Resumo</h2><p>${escapeHtml(report.resumo)}</p></section>` : ''}

    ${
      badgeRecomendacaoHtml(report.recomendacao)
        ? `<section class="rel-sec"><h2>Recomendação da IA</h2><p>${badgeRecomendacaoHtml(report.recomendacao)}</p></section>`
        : ''
    }

    ${
      geral
        ? `<section class="rel-sec">
            <h2>Pontuação geral</h2>
            <div class="comp">
              <div class="comp-cab">
                <span style="color:var(--cinza);text-transform:uppercase;font-size:.8rem;">Média ponderada pelo peso das competências</span>
                <span class="comp-nota">${escapeHtml(String(geral.media))}<small>/${escapeHtml(String(geral.escalaMax))}</small></span>
              </div>
            </div>
          </section>`
        : ''
    }

    <section class="rel-sec">
      <h2>Pontuação por competência</h2>
      ${comps || '<p>Sem competências pontuadas.</p>'}
    </section>

    <section class="rel-sec">
      <h2>Pontos fortes</h2>
      ${fortes ? `<ul class="lista">${fortes}</ul>` : '<p>—</p>'}
    </section>

    <section class="rel-sec">
      <h2>Pontos de atenção</h2>
      ${atencao ? `<ul class="lista">${atencao}</ul>` : '<p>—</p>'}
    </section>

    <section class="rel-sec transc">
      <h2>Transcrição</h2>
      ${transcricao || '<p>Sem turnos registrados.</p>'}
    </section>

    <p><a class="btn btn--ghost" href="/admin">← Voltar ao painel</a></p>`;

  res.send(paginaAdmin({ titulo: `Relatório — ${nomeCand}`, conteudo }));
});

// ── GET /admin/api/funil ── endpoint JSON do funil de conversao (Func. 3, sub-commit 2) ──
// Retorna, por vaga e no total, os 4 numeros do funil (acessos, aplicacoes, entrevistas
// realizadas, pre-aprovados). Consumido pela futura pagina /admin/dashboard (sub-commit 3).
// Querystring opcional ?desde=YYYY-MM-DD&ate=YYYY-MM-DD; datas malformadas -> 400 (nao crash).
router.get('/api/funil', (req, res) => {
  const desde = req.query.desde != null ? String(req.query.desde).trim() : '';
  const ate = req.query.ate != null ? String(req.query.ate).trim() : '';

  if (desde && !dataIsoValida(desde)) {
    return res
      .status(400)
      .json({ ok: false, erro: 'Parâmetro "desde" inválido. Use o formato YYYY-MM-DD.' });
  }
  if (ate && !dataIsoValida(ate)) {
    return res
      .status(400)
      .json({ ok: false, erro: 'Parâmetro "ate" inválido. Use o formato YYYY-MM-DD.' });
  }

  const funil = db.obterFunilConversao({ desde: desde || undefined, ate: ate || undefined });
  return res.json({ ok: true, filtro: { desde: desde || null, ate: ate || null }, ...funil });
});

// ── GET /admin/dashboard ── pagina visual do funil de conversao (Func. 3, sub-commit 3) ──
// Server-side: chama db.obterFunilConversao direto (mesma fonte do endpoint JSON; NAO faz
// fetch HTTP de si mesma). Filtro de periodo por querystring (?desde=&ate=), validado com
// dataIsoValida — data malformada mostra aviso amigavel e NAO quebra a pagina.
router.get('/dashboard', (req, res) => {
  const desde = req.query.desde != null ? String(req.query.desde).trim() : '';
  const ate = req.query.ate != null ? String(req.query.ate).trim() : '';

  const erros = [];
  if (desde && !dataIsoValida(desde)) erros.push('Data inicial inválida. Use o formato AAAA-MM-DD.');
  if (ate && !dataIsoValida(ate)) erros.push('Data final inválida. Use o formato AAAA-MM-DD.');
  const temErro = erros.length > 0;

  // So consulta com datas validas; com erro, mantem a pagina de pe (form + aviso).
  const funil = temErro
    ? { vagas: [], totais: { acessos: 0, aplicacoes: 0, entrevistas_realizadas: 0, pre_aprovados: 0 } }
    : db.obterFunilConversao({ desde: desde || undefined, ate: ate || undefined });

  const t = funil.totais;

  // Etapas do funil (na ordem). taxa = conversao a partir da etapa anterior ('—' se n/d).
  const etapas = [
    { rotulo: 'Acessos', valor: t.acessos, taxa: null },
    { rotulo: 'Aplicações', valor: t.aplicacoes, taxa: taxaConversao(t.aplicacoes, t.acessos) },
    {
      rotulo: 'Entrevistas Realizadas',
      valor: t.entrevistas_realizadas,
      taxa: taxaConversao(t.entrevistas_realizadas, t.aplicacoes),
    },
    {
      rotulo: 'Pré-aprovados pela IA',
      valor: t.pre_aprovados,
      taxa: taxaConversao(t.pre_aprovados, t.entrevistas_realizadas),
    },
  ];
  const maxTotais = Math.max(...etapas.map((e) => e.valor), 0);

  const barras = etapas
    .map((e) => {
      const largura = larguraBarra(e.valor, maxTotais).toFixed(1);
      const taxaLinha = e.taxa
        ? `Conversão da etapa anterior: <b>${e.taxa}</b>`
        : 'Topo do funil';
      return `
        <div class="funil-etapa">
          <div class="funil-topo">
            <span class="funil-rotulo">${escapeHtml(e.rotulo)}</span>
            <span class="funil-num">${fmtInt(e.valor)}</span>
          </div>
          <div class="funil-trilho">
            <div class="funil-barra" style="width:${largura}%"></div>
          </div>
          <div class="funil-taxa">${taxaLinha}</div>
        </div>`;
    })
    .join('');

  const linhas = funil.vagas
    .map((v) => {
      const zero =
        !v.acessos && !v.aplicacoes && !v.entrevistas_realizadas && !v.pre_aprovados;
      return `
        <tr class="${zero ? 'linha-zero' : ''}">
          <td>${escapeHtml(v.titulo || '—')}</td>
          <td class="col-num">${fmtInt(v.acessos)}</td>
          <td class="col-num">${fmtInt(v.aplicacoes)}</td>
          <td class="col-num">${taxaConversao(v.aplicacoes, v.acessos)}</td>
          <td class="col-num">${fmtInt(v.entrevistas_realizadas)}</td>
          <td class="col-num">${taxaConversao(v.entrevistas_realizadas, v.aplicacoes)}</td>
          <td class="col-num">${fmtInt(v.pre_aprovados)}</td>
          <td class="col-num">${taxaConversao(v.pre_aprovados, v.entrevistas_realizadas)}</td>
        </tr>`;
    })
    .join('');

  const temFiltro = desde || ate;
  const resumoPeriodo = temErro
    ? ''
    : temFiltro
      ? `Período: ${escapeHtml(desde || '…')} até ${escapeHtml(ate || '…')}`
      : 'Período: todo o histórico';

  const conteudo = `
    <div style="display:flex;justify-content:space-between;align-items:center;gap:1rem;flex-wrap:wrap;margin-bottom:1rem;">
      <h1 style="margin:0;">Funil de Conversão</h1>
      <a class="btn btn--ghost" href="/admin">← Voltar ao painel</a>
    </div>

    ${erros.length ? `<div class="aviso-alerta">${erros.map((e) => escapeHtml(e)).join('<br>')}</div>` : ''}

    <form method="GET" action="/admin/dashboard" class="admin-filtros">
      <label class="filtro">
        <span>De</span>
        <input type="date" name="desde" value="${escapeHtml(desde)}">
      </label>
      <label class="filtro">
        <span>Até</span>
        <input type="date" name="ate" value="${escapeHtml(ate)}">
      </label>
      <button type="submit" class="btn">Filtrar</button>
      ${temFiltro ? '<a class="btn btn--ghost" href="/admin/dashboard">Limpar</a>' : ''}
    </form>

    ${resumoPeriodo ? `<p class="admin-sub" style="color:var(--cinza);font-size:.85rem;margin:.2rem 0 1.2rem;">${resumoPeriodo}</p>` : ''}

    <section class="rel-sec">
      <h2>Totais consolidados</h2>
      <div class="funil">
        ${temErro ? '<p style="color:var(--cinza);">Corrija as datas acima para ver o funil.</p>' : barras}
      </div>
    </section>

    <section class="rel-sec">
      <h2>Por vaga</h2>
      <div class="admin-tab-scroll">
        <table class="admin-tab">
          <thead>
            <tr>
              <th>Vaga</th>
              <th class="col-num">Acessos</th>
              <th class="col-num">Aplicações</th>
              <th class="col-num">Apl/Ace</th>
              <th class="col-num">Entrevistas</th>
              <th class="col-num">Ent/Apl</th>
              <th class="col-num">Pré-aprovados</th>
              <th class="col-num">Pré/Ent</th>
            </tr>
          </thead>
          <tbody>
            ${linhas || `<tr><td colspan="8">${temErro ? 'Corrija as datas para ver os dados.' : 'Nenhuma vaga cadastrada ainda.'}</td></tr>`}
          </tbody>
        </table>
      </div>
    </section>`;

  res.send(paginaAdmin({ titulo: 'Funil de Conversão', conteudo }));
});

// ── Gestao de multiplas vagas (Fase 5) ──

const PERFIS_VALIDOS = ['SDR', 'CLOSER'];

// Opcoes dos selects de detalhe da vaga (fonte unica: formulario + validacao do POST).
// Pares [value, rotulo]. O value e o que vai para o banco e para os selos da /vaga.
const MODALIDADES = [
  ['presencial', 'Presencial'],
  ['híbrido', 'Híbrido'],
  ['remoto', 'Remoto'],
];
const REGIMES = [
  ['CLT', 'CLT'],
  ['PJ', 'PJ'],
];

// Gera um slug-base a partir do titulo: sem acentos, minusculo, so [a-z0-9-].
function gerarSlugBase(titulo) {
  const base = String(titulo || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '') // remove diacriticos (acentos)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
  return base || 'vaga';
}

// Garante unicidade do slug (coluna UNIQUE): se ja existir, anexa -2, -3, ...
function gerarSlugUnico(titulo) {
  const base = gerarSlugBase(titulo);
  let slug = base;
  let n = 2;
  while (db.obterVagaPorSlug(slug)) {
    slug = `${base}-${n}`;
    n += 1;
  }
  return slug;
}

// Aviso (decisao: roteiro_id NULL e permitido) exibido na listagem/edicao de vagas
// cujo perfil ainda nao tem roteiro vinculado — a entrevista nao roda sem ele.
function avisoRoteiroFaltando(vaga) {
  if (vaga.roteiro_id) return '';
  return `<p class="aviso-alerta">Esta vaga não tem roteiro cadastrado — a entrevista
    não funcionará até que um roteiro ${escapeHtml(vaga.perfil)} seja criado e vinculado.</p>`;
}

// ── Campos ricos da vaga (pagina de vaga rica) ──

// secoes_extras e gravado como array de { titulo, itens[] }. No formulario, cada
// secao e digitada num unico textarea com a convencao:
//   uma linha "## Titulo" abre a secao; as linhas seguintes (sem prefixo) sao os
//   itens (um por linha). Trim em tudo; linhas vazias descartadas; itens antes do
//   1o titulo sao ignorados; secoes sem titulo nao entram.
function parseSecoesExtras(texto) {
  const secoes = [];
  let atual = null;
  for (const bruta of String(texto || '').split('\n')) {
    const linha = bruta.trim();
    if (!linha) continue;
    const m = linha.match(/^#{1,3}\s+(.*)$/);
    if (m) {
      atual = { titulo: m[1].trim(), itens: [] };
      secoes.push(atual);
    } else if (atual) {
      atual.itens.push(linha);
    }
  }
  return secoes.filter((s) => s.titulo);
}

// Caminho inverso: monta o texto do textarea a partir do array salvo (pre-popular
// a edicao). Espelha a convencao de parseSecoesExtras ("## Titulo" + itens).
function secoesExtrasParaTexto(secoes) {
  if (!Array.isArray(secoes)) return '';
  return secoes
    .map((s) => [`## ${s.titulo || ''}`.trim(), ...(Array.isArray(s.itens) ? s.itens : [])].join('\n'))
    .join('\n\n');
}

// Le do corpo do POST os campos ricos (compartilhado entre criar e editar). Arrays
// "um item por linha" via arrayDeLinhas (declarado adiante; hoisted); potencial_ganhos
// e texto livre; secoes_extras usa o parser proprio acima.
function lerCamposRicos(b) {
  // modalidade/regime so valem se baterem com as opcoes conhecidas; senao ficam vazios.
  const modalidade = MODALIDADES.some(([v]) => v === b.modalidade) ? b.modalidade : '';
  const regime = REGIMES.some(([v]) => v === b.regime) ? b.regime : '';
  return {
    potencial_ganhos: String(b.potencial_ganhos || '').trim(),
    endereco: String(b.endereco || '').trim(),
    modalidade,
    regime,
    horario: String(b.horario || '').trim(),
    skills: arrayDeLinhas(b.skills),
    beneficios: arrayDeLinhas(b.beneficios),
    atividades: arrayDeLinhas(b.atividades),
    requisitos: arrayDeLinhas(b.requisitos),
    secoes_extras: parseSecoesExtras(b.secoes_extras),
  };
}

// Monta as <option> de um select com placeholder "— selecione —" (value vazio) e
// marca como selecionada a opcao cujo value bate com o valor atual da vaga.
function opcoesSelect(atual, pares) {
  const placeholder = '<option value="">— selecione —</option>';
  const opcoes = pares
    .map(
      ([v, rotulo]) =>
        `<option value="${escapeHtml(v)}"${(atual || '') === v ? ' selected' : ''}>${escapeHtml(rotulo)}</option>`,
    )
    .join('');
  return placeholder + opcoes;
}

// Campos do formulario de vaga (compartilhados entre criar e editar). No modo "novo"
// o perfil e um <select> (define o roteiro vinculado); no modo "editar" o perfil e
// apenas exibido (atualizarVaga nao mexe em perfil/roteiro_id/slug).
function camposVagaHtml(vaga, { perfilEditavel }) {
  const perfilCampo = perfilEditavel
    ? `<label class="campo">
        <span>Perfil</span>
        <select name="perfil">
          ${PERFIS_VALIDOS.map(
            (p) => `<option value="${p}"${vaga.perfil === p ? ' selected' : ''}>${p}</option>`,
          ).join('')}
        </select>
      </label>`
    : `<label class="campo">
        <span>Perfil</span>
        <input type="text" value="${escapeHtml(vaga.perfil || '')}" disabled>
      </label>`;

  return `
    <label class="campo">
      <span>Título da vaga</span>
      <input type="text" name="titulo" value="${escapeHtml(vaga.titulo || '')}" required>
    </label>

    ${perfilCampo}

    <label class="campo">
      <span>Faixa de pagamento</span>
      <input type="text" name="faixa_pagamento" value="${escapeHtml(vaga.faixa_pagamento || '')}" placeholder="R$ 3.000 – R$ 6.000 + comissão">
    </label>

    <label class="campo">
      <span>Potencial de ganhos</span>
      <textarea name="potencial_ganhos" rows="2" placeholder="Ex.: comissões sem teto — top performers faturam R$ 15.000+/mês">${escapeHtml(vaga.potencial_ganhos || '')}</textarea>
    </label>

    <label class="campo">
      <span>Endereço / Localização</span>
      <input type="text" name="endereco" value="${escapeHtml(vaga.endereco || '')}" placeholder="Ex.: Av. Paulista, 1000 — São Paulo/SP">
    </label>

    <label class="campo">
      <span>Modalidade</span>
      <select name="modalidade">${opcoesSelect(vaga.modalidade, MODALIDADES)}</select>
    </label>

    <label class="campo">
      <span>Regime</span>
      <select name="regime">${opcoesSelect(vaga.regime, REGIMES)}</select>
    </label>

    <label class="campo">
      <span>Horário de trabalho</span>
      <input type="text" name="horario" value="${escapeHtml(vaga.horario || '')}" placeholder="ex.: Segunda a Sexta, 8h às 18h">
    </label>

    <label class="campo">
      <span>Descrição da vaga</span>
      <textarea name="descricao" rows="6">${escapeHtml(vaga.descricao || '')}</textarea>
    </label>

    <label class="campo">
      <span>Atividades (um item por linha)</span>
      <textarea name="atividades" rows="6">${escapeHtml(linhasDeArray(vaga.atividades))}</textarea>
    </label>

    <label class="campo">
      <span>Requisitos (um item por linha)</span>
      <textarea name="requisitos" rows="6">${escapeHtml(linhasDeArray(vaga.requisitos))}</textarea>
    </label>

    <label class="campo">
      <span>Benefícios (um item por linha)</span>
      <textarea name="beneficios" rows="6">${escapeHtml(linhasDeArray(vaga.beneficios))}</textarea>
    </label>

    <label class="campo">
      <span>Competências / skills (um item por linha)</span>
      <textarea name="skills" rows="5">${escapeHtml(linhasDeArray(vaga.skills))}</textarea>
    </label>

    <label class="campo">
      <span>Seções extras (opcional)</span>
      <textarea name="secoes_extras" rows="7" placeholder="## Título da seção&#10;Primeiro item&#10;Segundo item&#10;&#10;## Outra seção&#10;Item">${escapeHtml(secoesExtrasParaTexto(vaga.secoes_extras))}</textarea>
    </label>
    <p style="color:var(--cinza);font-size:.8rem;margin:-.5rem 0 1.2rem;">
      Cada seção começa com uma linha <b>## Título</b>; as linhas seguintes são os itens
      (um por linha). Deixe vazio se não precisar.</p>

    <label class="campo">
      <span>Sobre a empresa</span>
      <textarea name="sobre_empresa" rows="4">${escapeHtml(vaga.sobre_empresa || '')}</textarea>
    </label>

    <label class="campo-check">
      <input type="checkbox" name="ativo" value="1"${vaga.ativo ? ' checked' : ''}>
      <span style="color:var(--offwhite);text-transform:none;">Vaga ativa</span>
    </label>

    <label class="campo-check">
      <input type="checkbox" name="entrevista_ativa" value="1"${vaga.entrevista_ativa !== 0 ? ' checked' : ''}>
      <span style="color:var(--offwhite);text-transform:none;">Entrevista automática (modo Completo)</span>
    </label>
    <p style="color:var(--cinza);font-size:.8rem;margin:-.5rem 0 1.2rem;">
      Marcada: o candidato passa pela entrevista com a Vera (fluxo completo). Desmarcada:
      modo Simples — só confirmação + botão de WhatsApp, sem entrevista. Só tem efeito
      quando a <b>Entrevista automática (geral)</b> está ligada em Configurações.</p>`;
}

// Bloco "Links por etapa": URLs ABSOLUTAS (config.baseUrl + caminho) de cada etapa
// do funil desta vaga, para parametrizar no GTM. Cada uma com botao "Copiar". A de
// Confirmacao (/preparacao/:slug) e a que marca o LEAD no GTM. O <script> de copia
// vai junto (o shell do admin nao carrega app.js).
function blocoLinksEtapa(vaga) {
  const base = config.baseUrl;
  const linhas = [
    ['Vaga', `${base}/vaga/${vaga.slug}`, 'Página pública da vaga — destino do tráfego pago.'],
    ['Formulário', `${base}/aplicar/${vaga.slug}`, 'Formulário de candidatura.'],
    [
      'Confirmação (Lead)',
      `${base}/preparacao/${vaga.slug}`,
      'É esta que marca o LEAD no GTM (pageview por vaga). Use no acompanhamento de conversão.',
    ],
  ];

  const itens = linhas
    .map(
      ([rotulo, url, desc]) => `
      <div style="margin-bottom:.9rem;">
        <div style="color:var(--cinza);font-size:.78rem;text-transform:uppercase;margin-bottom:.25rem;">${escapeHtml(rotulo)}</div>
        <div style="display:flex;gap:.5rem;align-items:center;flex-wrap:wrap;">
          <input type="text" readonly value="${escapeHtml(url)}" onfocus="this.select()"
            style="flex:1;min-width:18rem;background:var(--campo);color:var(--offwhite);border:1px solid var(--linha);border-radius:6px;padding:.5rem .6rem;font:inherit;">
          <button type="button" class="btn" data-copiar="${escapeHtml(url)}">Copiar</button>
        </div>
        <p style="color:var(--cinza);font-size:.78rem;margin:.25rem 0 0;">${escapeHtml(desc)}</p>
      </div>`,
    )
    .join('');

  return `
    <section class="rel-sec">
      <h2>Links por etapa</h2>
      <p style="color:var(--cinza);font-size:.85rem;margin:0 0 .8rem;">
        URLs completas para parametrizar no GTM. A <b>Confirmação (Lead)</b> é a que marca o lead.</p>
      ${itens}
    </section>
    <script>
      document.addEventListener('click', function (e) {
        var b = e.target.closest('[data-copiar]');
        if (!b) return;
        var url = b.getAttribute('data-copiar');
        navigator.clipboard.writeText(url).then(function () {
          var antes = b.textContent;
          b.textContent = 'Copiado!';
          setTimeout(function () { b.textContent = antes; }, 1500);
        });
      });
    </script>`;
}

// ── GET /admin/vagas ── listagem de todas as vagas ──
router.get('/vagas', (req, res) => {
  const vagas = db.listarVagas();
  const salvo = req.query.salvo === '1' ? '<p class="aviso-ok">Vaga salva.</p>' : '';

  const linhas = vagas
    .map((v) => {
      const badge = v.ativo
        ? '<span class="badge badge--ativa">Ativa</span>'
        : '<span class="badge badge--encerrada">Encerrada</span>';
      const semRoteiro = v.roteiro_id ? '' : '<span class="tag-aviso">⚠ sem roteiro</span>';
      const toggle = v.ativo
        ? `<form method="POST" action="/admin/vagas/${v.id}/encerrar"><button type="submit" class="btn btn--ghost">Encerrar</button></form>`
        : `<form method="POST" action="/admin/vagas/${v.id}/reativar"><button type="submit" class="btn">Reativar</button></form>`;
      return `
        <tr>
          <td>${escapeHtml(v.titulo)}${semRoteiro}</td>
          <td>${escapeHtml(v.perfil)}</td>
          <td>${badge}</td>
          <td>${formatarDataHora(v.criado_em)}</td>
          <td>
            <div class="acoes-linha">
              <a class="btn btn--ghost" href="/admin/vagas/${v.id}">Editar</a>
              ${toggle}
            </div>
          </td>
        </tr>`;
    })
    .join('');

  const conteudo = `
    <p><a class="btn btn--ghost" href="/admin">← Voltar ao painel</a></p>
    <div style="display:flex;justify-content:space-between;align-items:center;gap:1rem;flex-wrap:wrap;margin-bottom:1rem;">
      <h1 style="margin:0;">Vagas</h1>
      <a class="btn" href="/admin/vagas/nova">+ Nova vaga</a>
    </div>
    ${salvo}
    <div class="admin-tab-scroll">
      <table class="admin-tab">
        <thead>
          <tr><th>Título</th><th>Perfil</th><th>Status</th><th>Criada em</th><th>Ações</th></tr>
        </thead>
        <tbody>
          ${linhas || '<tr><td colspan="5">Nenhuma vaga cadastrada.</td></tr>'}
        </tbody>
      </table>
    </div>`;

  res.send(paginaAdmin({ titulo: 'Vagas', conteudo }));
});

// Mensagens de erro do import de briefing, por codigo (fonte unica p/ a rota).
const MENSAGENS_IMPORT_ERRO = {
  LINK_INVALIDO:
    'Link de Google Doc inválido. Cole o link no formato https://docs.google.com/document/d/.../edit',
  DOC_ERRO:
    'Link de Google Doc inválido. Cole o link no formato https://docs.google.com/document/d/.../edit',
  DOC_SEM_ACESSO:
    'Não consegui acessar o documento. Confirme que ele foi compartilhado como Leitor com o e-mail da conta de serviço e que o link está correto.',
  DOC_NAO_EXPORTAVEL:
    'Esse link não é um Google Doc nativo (ex.: PDF não é suportado por ora). Cole o link de um Google Documento.',
  EXTRACAO_TRUNCADA:
    'O briefing é muito extenso para a extração automática. Tente novamente ou resuma o documento.',
  EXTRACAO_FALHOU:
    'Não consegui extrair os dados do briefing; preencha manualmente ou tente outro documento.',
};

// Bloco "Importar de um briefing (Google Doc)" — mini-form independente (nunca aninhado
// no form de criacao), acima do form de nova vaga. Posta para POST /admin/vagas/importar.
function blocoImportBriefing(erroImport) {
  const alerta = erroImport ? `<p class="aviso-alerta">${escapeHtml(erroImport)}</p>` : '';
  return `
    <section class="rel-sec" style="border:1px solid var(--linha);border-radius:8px;padding:1rem 1.2rem;margin-bottom:1.5rem;">
      <h2>Importar de um briefing (Google Doc)</h2>
      <p style="color:var(--cinza);font-size:.85rem;margin:.2rem 0 1rem;">
        Cole o link de um Google Documento com o briefing da vaga. A IA lê e pré-preenche
        os campos abaixo para você revisar. Compartilhe o documento como <b>Leitor</b> com
        o e-mail da conta de serviço antes de importar.</p>
      ${alerta}
      <form method="POST" action="/admin/vagas/importar" data-form-import>
        <div style="display:flex;gap:.5rem;align-items:center;flex-wrap:wrap;">
          <input type="url" name="briefing_url" required placeholder="https://docs.google.com/document/d/.../edit"
            style="flex:1;min-width:18rem;background:var(--campo);color:var(--offwhite);border:1px solid var(--linha);border-radius:6px;padding:.6rem .7rem;font:inherit;">
          <button type="submit" class="btn" data-btn-import>Importar</button>
        </div>
        <p style="color:var(--cinza);font-size:.8rem;margin:.5rem 0 0;">
          Isso pode levar alguns segundos (a IA está lendo o documento).</p>
      </form>
      <script>
        (function () {
          var f = document.querySelector('[data-form-import]');
          if (!f) return;
          // POST tradicional (recarrega a pagina): ao enviar, desabilita o botao, troca o
          // texto e evita duplo clique/reenvio ate a resposta do servidor chegar.
          f.addEventListener('submit', function () {
            var b = f.querySelector('[data-btn-import]');
            if (b) {
              b.disabled = true;
              b.textContent = 'Importando... aguarde';
              b.classList.add('btn--off');
            }
          });
        })();
      </script>
    </section>`;
}

// Aviso (topo do form) listando os campos que a IA NAO conseguiu preencher, para o admin
// completar na revisao. Nao impede o salvamento. Lista as chaves cruas dos campos.
function avisoCamposAusentes(ausentes) {
  if (!Array.isArray(ausentes) || !ausentes.length) return '';
  return `<p class="aviso-alerta">A IA não encontrou estes campos no briefing — revise e
    preencha antes de salvar: <b>${escapeHtml(ausentes.join(', '))}</b>.</p>`;
}

// Conteudo da tela de nova vaga (compartilhado entre GET /vagas/nova e o re-render do
// POST /vagas/importar). `vaga` pre-preenche o form (default = vaga em branco); `erroImport`
// e a mensagem do bloco de import; `ausentes` alimenta o aviso de campos nao preenchidos.
function htmlNovaVaga({ vaga, erroTituloVazio = false, erroImport = '', ausentes = [] } = {}) {
  const vagaBase = vaga || { ativo: true, perfil: 'CLOSER' };
  const erroTitulo = erroTituloVazio
    ? '<p class="aviso-alerta">O título da vaga não pode ficar vazio.</p>'
    : '';
  return `
    <p><a class="btn btn--ghost" href="/admin/vagas">← Voltar às vagas</a></p>
    <h1>Nova vaga</h1>
    ${blocoImportBriefing(erroImport)}
    ${avisoCamposAusentes(ausentes)}
    ${erroTitulo}
    <form method="POST" action="/admin/vagas">
      ${camposVagaHtml(vagaBase, { perfilEditavel: true })}
      <p style="color:var(--cinza);font-size:.85rem;margin-top:-.5rem;">
        O roteiro de entrevista é vinculado automaticamente pelo perfil escolhido.</p>
      <button type="submit" class="btn">Criar vaga</button>
    </form>`;
}

// ── GET /admin/vagas/nova ── formulario de criacao (antes de /:id p/ nao casar como id) ──
router.get('/vagas/nova', (req, res) => {
  res.send(
    paginaAdmin({
      titulo: 'Nova vaga',
      conteudo: htmlNovaVaga({ erroTituloVazio: req.query.erro === 'titulo' }),
    }),
  );
});

// ── POST /admin/vagas/importar ── lê um Google Doc, extrai os campos por IA e re-renderiza
// a MESMA tela de nova vaga pré-preenchida (revisão humana). NUNCA salva: o salvamento
// segue no POST /vagas. Registrada ANTES de /vagas/:id para não casar como :id. ──
router.post('/vagas/importar', async (req, res) => {
  const url = String((req.body && req.body.briefing_url) || '');
  let resultado;
  try {
    resultado = await importarVagaDeBriefing({ url, drive, llm });
  } catch (e) {
    // Rede de seguranca: importarVagaDeBriefing ja e best-effort, mas nunca deixamos uma
    // excecao inesperada derrubar a rota.
    console.error('[admin/importar] erro inesperado:', e && e.message);
    resultado = { ok: false, erroCodigo: 'EXTRACAO_FALHOU' };
  }

  if (!resultado.ok) {
    const msg = MENSAGENS_IMPORT_ERRO[resultado.erroCodigo] || MENSAGENS_IMPORT_ERRO.EXTRACAO_FALHOU;
    return res.send(paginaAdmin({ titulo: 'Nova vaga', conteudo: htmlNovaVaga({ erroImport: msg }) }));
  }
  return res.send(
    paginaAdmin({
      titulo: 'Nova vaga',
      conteudo: htmlNovaVaga({ vaga: resultado.vaga, ausentes: resultado.ausentes }),
    }),
  );
});

// ── POST /admin/vagas ── cria nova vaga ──
router.post('/vagas', (req, res) => {
  const b = req.body || {};
  const titulo = String(b.titulo || '').trim();
  if (!titulo) {
    return res.redirect('/admin/vagas/nova?erro=titulo');
  }

  const perfil = PERFIS_VALIDOS.includes(b.perfil) ? b.perfil : 'CLOSER';
  // Decisao: roteiro_id pode ficar NULL (perfil sem roteiro cadastrado).
  const roteiro = db.obterRoteiroPorPerfil(perfil);

  const id = db.criarVaga({
    slug: gerarSlugUnico(titulo),
    titulo,
    perfil,
    faixa_pagamento: String(b.faixa_pagamento || '').trim(),
    descricao: String(b.descricao || '').trim(),
    sobre_empresa: String(b.sobre_empresa || '').trim(),
    roteiro_id: roteiro ? roteiro.id : null,
    ativo: b.ativo === '1' || b.ativo === 'on',
    entrevista_ativa: b.entrevista_ativa === '1' || b.entrevista_ativa === 'on',
    ...lerCamposRicos(b),
  });

  res.redirect(`/admin/vagas/${id}?salvo=1`);
});

// ── GET /admin/vagas/:id ── formulario de edicao de uma vaga ──
router.get('/vagas/:id', (req, res) => {
  const id = Number(req.params.id);
  const vaga = Number.isInteger(id) ? db.obterVaga(id) : null;
  if (!vaga) {
    return res.status(404).send(paginaErroAdmin('Vaga não encontrada.'));
  }

  const salvo = req.query.salvo === '1' ? '<p class="aviso-ok">Alterações salvas.</p>' : '';

  const conteudo = `
    <p><a class="btn btn--ghost" href="/admin/vagas">← Voltar às vagas</a></p>
    <h1>Editar vaga</h1>
    ${salvo}
    ${avisoRoteiroFaltando(vaga)}
    ${blocoLinksEtapa(vaga)}
    <form method="POST" action="/admin/vagas/${vaga.id}">
      ${camposVagaHtml(vaga, { perfilEditavel: false })}
      <button type="submit" class="btn">Salvar alterações</button>
    </form>`;

  res.send(paginaAdmin({ titulo: 'Editar vaga', conteudo }));
});

// ── POST /admin/vagas/:id ── salva alteracoes (titulo/faixa/descricao/sobre/ativo) ──
router.post('/vagas/:id', (req, res) => {
  const id = Number(req.params.id);
  const vaga = Number.isInteger(id) ? db.obterVaga(id) : null;
  if (!vaga) {
    return res.status(404).send(paginaErroAdmin('Vaga não encontrada.'));
  }

  const b = req.body || {};
  const titulo = String(b.titulo || '').trim();
  if (!titulo) {
    return res.status(400).send(
      paginaAdmin({
        titulo: 'Editar vaga',
        conteudo: `
          <p><a class="btn btn--ghost" href="/admin/vagas/${vaga.id}">← Voltar</a></p>
          <section class="rel-sec"><h1>Editar vaga</h1>
            <p>O título da vaga não pode ficar vazio.</p></section>`,
      }),
    );
  }

  db.atualizarVaga(id, {
    titulo,
    faixa_pagamento: String(b.faixa_pagamento || '').trim(),
    descricao: String(b.descricao || '').trim(),
    sobre_empresa: String(b.sobre_empresa || '').trim(),
    ativo: b.ativo === '1' || b.ativo === 'on',
    entrevista_ativa: b.entrevista_ativa === '1' || b.entrevista_ativa === 'on',
    ...lerCamposRicos(b),
  });

  res.redirect(`/admin/vagas/${id}?salvo=1`);
});

// ── POST /admin/vagas/:id/encerrar e /reativar ── alterna o campo ativo ──
router.post('/vagas/:id/encerrar', (req, res) => {
  const id = Number(req.params.id);
  if (Number.isInteger(id)) db.definirVagaAtiva(id, false);
  res.redirect('/admin/vagas');
});

router.post('/vagas/:id/reativar', (req, res) => {
  const id = Number(req.params.id);
  if (Number.isInteger(id)) db.definirVagaAtiva(id, true);
  res.redirect('/admin/vagas');
});

// ── GET /admin/vaga ── compatibilidade: redireciona p/ a edicao da vaga ativa ──
router.get('/vaga', (req, res) => {
  const vaga = db.obterVagaAtiva() || db.obterVaga(1);
  return res.redirect(vaga ? `/admin/vagas/${vaga.id}` : '/admin/vagas');
});

// ── Edicao do roteiro de entrevista (B.2) ──

// Resolve o roteiro a editar: SEMPRE o roteiro da vaga ativa (id=1 por padrao).
function roteiroParaEditar() {
  const vaga = db.obterVagaAtiva() || db.obterVaga(1);
  if (vaga && vaga.roteiro_id) {
    const r = db.obterRoteiro(vaga.roteiro_id);
    if (r) return r;
  }
  return db.obterRoteiro(1) || null;
}

// Textarea <-> array de strings (uma por linha).
function linhasDeArray(arr) {
  return Array.isArray(arr) ? arr.join('\n') : '';
}
function arrayDeLinhas(texto) {
  return String(texto || '')
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
}

// ── GET /admin/roteiro ── formulario de edicao do roteiro ──
router.get('/roteiro', (req, res) => {
  const roteiro = roteiroParaEditar();

  if (!roteiro) {
    return res.send(
      paginaAdmin({
        titulo: 'Editar roteiro',
        conteudo: `
          <p><a class="btn btn--ghost" href="/admin">← Voltar ao painel</a></p>
          <section class="rel-sec"><h1>Roteiro de entrevista</h1><p>Nenhum roteiro cadastrado.</p></section>`,
      }),
    );
  }

  const est = roteiro.estrutura || {};
  const instrucoes = Array.isArray(est.instrucoes_gerais) ? est.instrucoes_gerais : [];
  const competencias = Array.isArray(est.competencias) ? est.competencias : [];
  const blocos = Array.isArray(est.blocos) ? est.blocos : [];

  const salvo = req.query.salvo === '1' ? '<p class="aviso-ok">Roteiro salvo.</p>' : '';

  const compsHtml = competencias
    .map(
      (c, i) => `
      <div class="comp">
        <label class="campo">
          <span>Competência</span>
          <input type="text" name="comp_${i}_nome" value="${escapeHtml(c.nome || '')}">
        </label>
        <label class="campo">
          <span>Peso (1–2)</span>
          <input type="number" name="comp_${i}_peso" min="1" max="2" value="${escapeHtml(String(c.peso || 1))}">
        </label>
        <label class="campo">
          <span>Boa resposta</span>
          <textarea name="comp_${i}_boa_resposta" rows="3">${escapeHtml(c.boa_resposta || '')}</textarea>
        </label>
      </div>`,
    )
    .join('');

  const blocosHtml = blocos
    .map((b, i) => {
      const temSemente = Object.prototype.hasOwnProperty.call(b, 'pergunta_semente');
      const temInstrucao = Object.prototype.hasOwnProperty.call(b, 'instrucao_vera');
      const temSondas = Array.isArray(b.sondas_bei);
      const semente = temSemente
        ? `
        <label class="campo">
          <span>Pergunta-semente</span>
          <textarea name="bloco_${i}_pergunta_semente" rows="3">${escapeHtml(b.pergunta_semente || '')}</textarea>
        </label>`
        : '';
      const instrucao = temInstrucao
        ? `
        <label class="campo">
          <span>Instrução para a Vera</span>
          <textarea name="bloco_${i}_instrucao_vera" rows="3">${escapeHtml(b.instrucao_vera || '')}</textarea>
        </label>`
        : '';
      const sondas = temSondas
        ? `
        <label class="campo">
          <span>Sondas BEI (uma por linha)</span>
          <textarea name="bloco_${i}_sondas_bei" rows="4">${escapeHtml(linhasDeArray(b.sondas_bei))}</textarea>
        </label>`
        : '';
      const aberto = b.obrigatorio !== false ? ' open' : '';
      return `
      <details class="bloco-card"${aberto}>
        <summary>${escapeHtml(b.nome || b.id || `Bloco ${i + 1}`)}</summary>
        <label class="campo-check">
          <input type="checkbox" name="bloco_${i}_obrigatorio" value="1"${b.obrigatorio !== false ? ' checked' : ''}>
          <span style="color:var(--offwhite);text-transform:none;">Bloco obrigatório</span>
        </label>
        ${semente}${instrucao}${sondas}
      </details>`;
    })
    .join('');

  const conteudo = `
    <p><a class="btn btn--ghost" href="/admin">← Voltar ao painel</a></p>
    <h1>Roteiro de entrevista</h1>
    ${salvo}
    <form method="POST" action="/admin/roteiro">
      <input type="hidden" name="id" value="${escapeHtml(String(roteiro.id))}">

      <label class="campo">
        <span>Instruções gerais da Vera (uma por linha)</span>
        <textarea name="instrucoes_gerais" rows="6">${escapeHtml(linhasDeArray(instrucoes))}</textarea>
      </label>

      <h2>Competências</h2>
      ${compsHtml || '<p>Nenhuma competência cadastrada.</p>'}

      <h2>Blocos</h2>
      ${blocosHtml || '<p>Nenhum bloco cadastrado.</p>'}

      <button type="submit" class="btn">Salvar roteiro</button>
    </form>`;

  res.send(paginaAdmin({ titulo: 'Editar roteiro', conteudo }));
});

// ── POST /admin/roteiro ── salva as alteracoes do roteiro ──
router.post('/roteiro', (req, res) => {
  const b = req.body || {};
  const id = Number(b.id);
  const roteiro = Number.isFinite(id) ? db.obterRoteiro(id) : null;
  if (!roteiro) {
    return res.status(404).send(paginaErroAdmin('Roteiro não encontrado.'));
  }

  // Parte da estrutura ATUAL (fonte da verdade) e sobrescreve SO os campos editaveis.
  // Assim preservamos campos fora do formulario: id/competencias_alvo/pergunta_secundaria/
  // objecao_padrao/o_que_observar/perguntas (fechamento)/metodo/rubrica.
  const est = JSON.parse(JSON.stringify(roteiro.estrutura || {}));

  est.instrucoes_gerais = arrayDeLinhas(b.instrucoes_gerais);

  const competencias = Array.isArray(est.competencias) ? est.competencias : [];
  competencias.forEach((c, i) => {
    if (b[`comp_${i}_nome`] != null) c.nome = String(b[`comp_${i}_nome`]).trim();
    if (b[`comp_${i}_boa_resposta`] != null) c.boa_resposta = String(b[`comp_${i}_boa_resposta`]).trim();
    const peso = parseInt(b[`comp_${i}_peso`], 10);
    if (Number.isFinite(peso)) c.peso = Math.min(2, Math.max(1, peso));
  });

  const blocos = Array.isArray(est.blocos) ? est.blocos : [];
  const faltando = [];
  blocos.forEach((bl, i) => {
    const obrigatorio =
      b[`bloco_${i}_obrigatorio`] === '1' || b[`bloco_${i}_obrigatorio`] === 'on';
    bl.obrigatorio = obrigatorio;

    if (Object.prototype.hasOwnProperty.call(bl, 'pergunta_semente')) {
      bl.pergunta_semente = String(b[`bloco_${i}_pergunta_semente`] || '').trim();
      // Validacao: pergunta-semente de bloco obrigatorio nao pode ficar vazia.
      if (obrigatorio && !bl.pergunta_semente) {
        faltando.push(bl.nome || bl.id || `Bloco ${i + 1}`);
      }
    }
    if (Object.prototype.hasOwnProperty.call(bl, 'instrucao_vera')) {
      bl.instrucao_vera = String(b[`bloco_${i}_instrucao_vera`] || '').trim();
    }
    if (Array.isArray(bl.sondas_bei)) {
      bl.sondas_bei = arrayDeLinhas(b[`bloco_${i}_sondas_bei`]);
    }
  });

  if (faltando.length) {
    return res.status(400).send(
      paginaAdmin({
        titulo: 'Editar roteiro',
        conteudo: `
          <p><a class="btn btn--ghost" href="/admin/roteiro">← Voltar</a></p>
          <section class="rel-sec"><h1>Roteiro de entrevista</h1>
            <p>A pergunta-semente não pode ficar vazia em blocos obrigatórios: <b>${escapeHtml(faltando.join(', '))}</b>.</p>
          </section>`,
      }),
    );
  }

  db.atualizarEstruturaRoteiro(id, est);
  res.redirect('/admin/roteiro?salvo=1');
});

// ── GET /admin/uso ── monitoramento de custos das chamadas ao LLM ──
router.get('/uso', (req, res) => {
  const total = db.resumoUsoApi();
  const porOrigem = db.usoApiPorOrigem();
  const ultimas = db.ultimasChamadasApi(30);

  // Bloco 2 — por origem.
  const linhasOrigem = porOrigem
    .map(
      (o) => `
        <tr>
          <td>${escapeHtml(o.origem)}</td>
          <td>${fmtInt(o.chamadas)}</td>
          <td>${fmtInt(o.tokens_entrada)}</td>
          <td>${fmtInt(o.tokens_saida)}</td>
          <td>${escapeHtml(fmtUsd6(o.custo_usd))}</td>
        </tr>`,
    )
    .join('');

  // Bloco 3 — ultimas 30 chamadas.
  const linhasUltimas = ultimas
    .map(
      (u) => `
        <tr>
          <td>${escapeHtml(formatarDataHora(u.criado_em))}</td>
          <td>${escapeHtml(u.origem)}</td>
          <td>${u.interview_id != null ? escapeHtml(String(u.interview_id)) : '—'}</td>
          <td>${fmtInt(u.cache_hit_tokens)}</td>
          <td>${fmtInt(u.cache_miss_tokens)}</td>
          <td>${fmtInt(u.completion_tokens)}</td>
          <td>${escapeHtml(fmtUsd8(u.custo_usd))}</td>
        </tr>`,
    )
    .join('');

  const conteudo = `
    <p><a class="btn btn--ghost" href="/admin">← Voltar ao painel</a></p>
    <h1>Custos / Uso da API</h1>

    <section class="rel-sec">
      <h2>Totais gerais</h2>
      <dl class="rel-id">
        <div><dt>Total gasto (USD)</dt><dd><b>${escapeHtml(fmtUsd6(total.custo_usd))}</b></dd></div>
        <div><dt>Total de chamadas</dt><dd>${fmtInt(total.chamadas)}</dd></div>
        <div><dt>Tokens de entrada</dt><dd>${fmtInt(total.cache_hit_tokens)} cache hit · ${fmtInt(total.cache_miss_tokens)} cache miss</dd></div>
        <div><dt>Tokens de saída</dt><dd>${fmtInt(total.completion_tokens)}</dd></div>
      </dl>
    </section>

    <section class="rel-sec">
      <h2>Por origem</h2>
      <div class="admin-tab-scroll">
        <table class="admin-tab">
          <thead>
            <tr><th>Origem</th><th>Chamadas</th><th>Tokens entrada</th><th>Tokens saída</th><th>Custo USD</th></tr>
          </thead>
          <tbody>
            ${linhasOrigem || '<tr><td colspan="5">Nenhuma chamada registrada.</td></tr>'}
          </tbody>
        </table>
      </div>
    </section>

    <section class="rel-sec">
      <h2>Últimas 30 chamadas</h2>
      <div class="admin-tab-scroll">
        <table class="admin-tab">
          <thead>
            <tr><th>Data/hora</th><th>Origem</th><th>Interview ID</th><th>Cache hit</th><th>Cache miss</th><th>Output</th><th>Custo USD</th></tr>
          </thead>
          <tbody>
            ${linhasUltimas || '<tr><td colspan="7">Nenhuma chamada registrada.</td></tr>'}
          </tbody>
        </table>
      </div>
    </section>

    <p class="admin-rodape">
      Os custos só são registrados em modo real (INTERVIEW_MOCK=false). Preços do modelo
      deepseek-v4-flash (via OpenRouter, jun/2026): cache hit $0,0028 / cache miss $0,14 /
      output $0,28 por 1M tokens.
    </p>`;

  res.send(paginaAdmin({ titulo: 'Custos / Uso da API', conteudo }));
});

// ── Configuracoes gerais (Func. 2 — increment 1) ──
//
// PRECEDENCIA (decidida; o ROTEAMENTO ainda NAO e implementado aqui — vem no proximo
// increment): o toggle GERAL e mestre. Geral OFF -> todo o sistema opera em modo
// Simples (sem entrevista). Geral ON -> cada vaga decide pelo seu proprio toggle
// (coluna por-vaga que sera criada depois). Default do geral: LIGADO (preserva o
// comportamento atual em producao — entrevista automatica ativa).
//
// ATENCAO: nesta etapa o valor e apenas ARMAZENADO e EXIBIDO. Desligar NAO altera o
// fluxo do candidato ainda (a UI deixa isso explicito para nao enganar o operador).
const CHAVE_ENTREVISTA_AUTO = 'entrevista_automatica_geral';

// ── GET /admin/config ── tela de configuracoes gerais ──
router.get('/config', (req, res) => {
  const ativo = db.obterConfigBool(CHAVE_ENTREVISTA_AUTO, true);
  const salvo = req.query.salvo === '1' ? '<p class="aviso-ok">Configuração salva.</p>' : '';

  const estado = ativo
    ? '<span class="badge badge--ativa">Ligada</span>'
    : '<span class="badge badge--encerrada">Desligada</span>';

  const conteudo = `
    <p><a class="btn btn--ghost" href="/admin">← Voltar ao painel</a></p>
    <h1>Configurações gerais</h1>
    ${salvo}

    <section class="rel-sec">
      <h2>Entrevista automática (geral)</h2>
      <p style="margin:.2rem 0 1rem;">
        Estado atual: ${estado}
      </p>
      <p class="aviso-alerta">
        <b>Este ajuste vale de fato.</b> É o interruptor <b>mestre</b>:
        <b>Desligada</b> → todas as vagas operam em modo Simples (sem entrevista; só
        confirmação + WhatsApp), independentemente do ajuste de cada vaga.
        <b>Ligada</b> → cada vaga decide pelo próprio campo
        <b>Entrevista automática (modo Completo)</b> no formulário da vaga.
      </p>
      <form method="POST" action="/admin/config/entrevista-automatica">
        <label class="campo" style="max-width:320px;">
          <span>Entrevista automática (geral)</span>
          <select name="ativo">
            <option value="1"${ativo ? ' selected' : ''}>Ligada</option>
            <option value="0"${ativo ? '' : ' selected'}>Desligada</option>
          </select>
        </label>
        <button type="submit" class="btn">Salvar</button>
      </form>
    </section>`;

  res.send(paginaAdmin({ titulo: 'Configurações gerais', conteudo }));
});

// ── POST /admin/config/entrevista-automatica ── alterna o toggle geral ──
router.post('/config/entrevista-automatica', (req, res) => {
  const b = req.body || {};
  const ativo = b.ativo === '1' || b.ativo === 'on';
  db.definirConfigBool(CHAVE_ENTREVISTA_AUTO, ativo);
  res.redirect('/admin/config?salvo=1');
});

module.exports = router;
