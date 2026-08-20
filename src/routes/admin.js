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
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { config } = require('../config');
const db = require('../db');
const drive = require('../providers/drive');
const llm = require('../providers/llm');
const { importarVagaDeBriefing } = require('../lib/importar_vaga');
const { extrairYoutubeId } = require('../lib/youtube');
const { modoEntrevistaAtivo } = require('../lib/modo');
const followup = require('../lib/followupEntrevista');
const emailRecusa = require('../lib/emailRecusa');
const lembreteInicio = require('../lib/lembreteInicio');
const limpezaAudio = require('../lib/limpezaAudio');
const dispararPromocao = require('../lib/dispararPromocao');
const emailTestePromocao = require('../lib/emailTestePromocao');
const { listarCidadesValidas, normalizarCidade, chave: chaveCidade } = require('../lib/cidades');
const { mimetypePorExtensao } = require('../lib/curriculo');
const {
  normalizarTelefoneWhatsapp,
  montarLinkWhatsapp,
  mensagemWhatsappCandidato,
  RECRUTADOR_PADRAO,
  TEMPLATE_PADRAO,
} = require('../lib/whatsapp');
const {
  calcularPontuacaoGeral,
  badgeRecomendacaoHtml,
  rotuloNivel,
  textoGap,
  badgeVereditoHtml,
} = require('../lib/relatorio');
const { gerarRelatorioPdf, slugNome } = require('../lib/relatorioPdf');
const { criarRouterPromocao, montarConteudoListagemPromocao } = require('./admin_promocao');
const { criarRouterWhatsapp } = require('./admin_whatsapp');
const sequenciaWhatsapp = require('../whatsapp/sequenciaOutbox');
const campanhaWhatsapp = require('../lib/campanhaWhatsapp');
const { criarRouterCampanhaWhatsapp, montarConteudoCampanhaWhatsapp } = require('./admin_campanha_whatsapp');
const fichaWa = require('../lib/whatsappFicha');
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
  :root {
    --preto:#0D0B0A;        /* agora: cor de TEXTO principal */
    --laranja:#FF5500;      /* CTA/detalhe (inalterado) */
    --offwhite:#F4F3F1;     /* agora: cor de FUNDO do body */
    --branco:#FFFFFF;       /* novo: fundo de inputs/superfícies (incrementos 4-5) */
    --campo:#FFFFFF;        /* era #1a1816 (escuro) → agora branco p/ inputs */
    --linha:#DAD7D2;        /* era #2a2724 (escuro) → agora borda clara */
    --cinza:#4A4845;        /* era #b8b2ac → tom mais escuro, legível no claro */
    --cinza-suave:#EDEBE7;  /* novo: chips neutros, linha selecionada, botão off */
  }
  * { box-sizing: border-box; }
  body { margin:0; background:var(--offwhite); color:var(--preto); font-family:'Barlow',system-ui,sans-serif; }
  .admin-wrap { max-width:1100px; margin:0 auto; padding:2rem 1.25rem 4rem; }
  .admin-cab { border-bottom:1px solid var(--linha); padding-bottom:1rem; margin-bottom:1.5rem; }
  .admin-logo { font-family:'Barlow Condensed',sans-serif; font-weight:900; text-transform:uppercase; color:var(--laranja); font-size:2rem; letter-spacing:.04em; margin:0; }
  .admin-sub { color:var(--cinza); margin:.15rem 0 0; font-size:1.05rem; }
  .admin-sair { color:var(--cinza); font-size:.85rem; text-decoration:none; white-space:nowrap; }
  .admin-sair:hover { color:var(--laranja); }
  h1,h2,h3 { font-family:'Barlow Condensed',sans-serif; text-transform:uppercase; letter-spacing:.03em; }
  a { color:var(--laranja); }
  .admin-tab-scroll { overflow-x:auto; -webkit-overflow-scrolling:touch; }
  table.admin-tab { width:100%; border-collapse:collapse; font-size:.95rem; min-width:960px; }
  table.admin-tab th, table.admin-tab td { text-align:left; padding:.6rem .7rem; border-bottom:1px solid var(--linha); white-space:nowrap; }
  table.admin-tab th { font-family:'Barlow Condensed',sans-serif; text-transform:uppercase; color:var(--cinza); font-weight:700; }
  .badge { display:inline-block; padding:.15rem .55rem; border-radius:999px; font-size:.8rem; font-weight:600; }
  .badge--aplicado { background:var(--cinza-suave); color:var(--cinza); }
  .badge--entrevista { background:var(--laranja); color:var(--preto); }
  .badge--concluido { background:transparent; color:var(--preto); border:1px solid var(--preto); }
  .btn { display:inline-block; padding:.4rem .8rem; border-radius:6px; text-decoration:none; font-weight:600; font-size:.85rem; background:var(--laranja); color:var(--preto); border:none; cursor:pointer; }
  .btn:not(.btn--ghost):not(.btn--off):hover { filter:brightness(0.92); }
  .btn--off { background:var(--cinza-suave); color:var(--cinza); pointer-events:none; cursor:not-allowed; }
  .btn--ghost { background:transparent; color:var(--preto); border:1px solid var(--linha); }
  .btn--ghost:hover { border-color:var(--laranja); color:var(--laranja); }
  .btn:disabled, .btn[disabled] { background:var(--cinza-suave); color:var(--cinza); cursor:not-allowed; filter:none; }
  .admin-rodape { margin-top:1.5rem; padding-top:1rem; border-top:1px solid var(--linha); color:var(--cinza); font-size:.9rem; }
  /* Marca que os numeros do rodape sao do recorte filtrado, nao do banco inteiro. */
  .admin-rodape .rodape-filtrado { color:var(--laranja); font-style:italic; }
  .admin-paginacao { display:flex; gap:.75rem; align-items:center; justify-content:center; flex-wrap:wrap; margin-top:1rem; color:var(--cinza); font-size:.9rem; }
  .admin-filtros { display:flex; gap:.75rem; align-items:flex-end; flex-wrap:wrap; margin-bottom:1.25rem; }
  .admin-filtros .filtro { display:flex; flex-direction:column; gap:.25rem; }
  .admin-filtros .filtro > span { color:var(--cinza); font-size:.8rem; text-transform:uppercase; }
  .admin-filtros select, .admin-filtros input[type=date], .admin-filtros input[type=search] { background:var(--campo); color:var(--preto); border:1px solid var(--linha); border-radius:6px; padding:.5rem .6rem; font:inherit; }
  .admin-filtros select:focus, .admin-filtros input[type=date]:focus, .admin-filtros input[type=search]:focus { outline:none; border-color:var(--laranja); }
  /* appearance:none anula o desenho proprio que o WebKit da ao type=search (cantos e
     sombra interna que ignoram border/border-radius) — sem isto o campo de busca
     destoaria dos selects ao lado no Safari. */
  .admin-filtros input[type=search] { appearance:none; -webkit-appearance:none; }
  /* Cresce para ocupar a sobra da linha (os demais filtros tem largura de conteudo),
     com um piso que cabe um nome completo sem cortar. */
  .admin-filtros .filtro--busca { flex:1 1 16rem; }
  .rel-sec { margin:1.5rem 0; }
  .rel-id { display:grid; grid-template-columns:repeat(auto-fit,minmax(200px,1fr)); gap:.5rem 1.5rem; }
  .rel-id dt { color:var(--cinza); font-size:.8rem; text-transform:uppercase; }
  .rel-id dd { margin:0 0 .5rem; }
  .comp { border:1px solid var(--linha); border-radius:8px; padding:.8rem 1rem; margin-bottom:.7rem; }
  .comp--off { opacity:.7; }
  .comp-cab { display:flex; justify-content:space-between; align-items:center; gap:1rem; }
  .comp-nota { font-family:'Barlow Condensed',sans-serif; font-weight:900; font-size:1.6rem; color:var(--laranja); }
  .comp-nota small { color:var(--cinza); font-size:.9rem; }
  .tag-off { display:inline-block; font-size:.75rem; color:var(--cinza); background:var(--cinza-suave); padding:.1rem .45rem; border-radius:4px; margin-left:.5rem; }
  .lista { margin:.3rem 0 0; padding-left:1.2rem; }
  .transc { font-size:.85rem; }
  .turno { padding:.5rem .8rem; border-radius:6px; margin-bottom:.4rem; background:var(--branco); border:1px solid var(--linha); }
  .turno-autor { font-family:'Barlow Condensed',sans-serif; text-transform:uppercase; color:var(--laranja); font-weight:700; font-size:.8rem; }
  .turno--cand .turno-autor { color:var(--preto); }
  .campo { display:block; margin-bottom:1rem; }
  .campo > span { display:block; color:var(--cinza); font-size:.85rem; text-transform:uppercase; margin-bottom:.3rem; }
  .campo input[type=text], .campo input[type=password], .campo select, .campo textarea { width:100%; background:var(--campo); color:var(--preto); border:1px solid var(--linha); border-radius:6px; padding:.6rem .7rem; font:inherit; }
  .campo input[type=text]:focus, .campo input[type=password]:focus, .campo select:focus, .campo textarea:focus { outline:none; border-color:var(--laranja); }
  .campo-check { display:flex; align-items:center; gap:.5rem; margin-bottom:1.2rem; }
  .aviso-ok { background:var(--branco); border:1px solid var(--laranja); border-left:3px solid var(--laranja); color:var(--preto); padding:.6rem .9rem; border-radius:4px; margin-bottom:1rem; }
  .aviso-alerta { background:var(--branco); border:1px solid var(--laranja); border-left:4px solid var(--laranja); color:var(--preto); padding:.6rem .9rem; border-radius:4px; margin-bottom:1rem; font-size:.92rem; }
  .badge--ativa { background:var(--laranja); color:var(--preto); }
  .badge--encerrada { background:var(--cinza-suave); color:var(--cinza); }
  .tag-aviso { display:inline-block; font-size:.72rem; font-weight:700; color:var(--laranja); border:1px solid var(--laranja); padding:.05rem .4rem; border-radius:4px; margin-left:.4rem; white-space:nowrap; }
  .acoes-linha { display:flex; gap:.4rem; align-items:center; }
  .acoes-linha form { margin:0; display:inline; }
  .campo input[type=number] { width:6rem; background:var(--campo); color:var(--preto); border:1px solid var(--linha); border-radius:6px; padding:.6rem .7rem; font:inherit; }
  .campo input[type=number]:focus { outline:none; border-color:var(--laranja); }
  .bloco-card { border:1px solid var(--linha); border-radius:8px; padding:.2rem 1rem; margin-bottom:.7rem; }
  .bloco-card > summary { font-family:'Barlow Condensed',sans-serif; text-transform:uppercase; letter-spacing:.03em; cursor:pointer; padding:.7rem 0; color:var(--preto); font-weight:700; }
  .bloco-card[open] > summary { border-bottom:1px solid var(--linha); margin-bottom:.8rem; }
  /* Funil de conversao (dashboard) — barras em CSS puro, sem lib de grafico. */
  .funil { margin:.4rem 0 0; }
  .funil-etapa { margin-bottom:1.1rem; }
  .funil-topo { display:flex; justify-content:space-between; align-items:baseline; gap:1rem; margin-bottom:.3rem; }
  .funil-rotulo { font-family:'Barlow Condensed',sans-serif; text-transform:uppercase; letter-spacing:.03em; color:var(--preto); font-weight:700; font-size:1.05rem; }
  .funil-num { font-family:'Barlow Condensed',sans-serif; font-weight:900; font-size:1.9rem; color:var(--laranja); line-height:1; }
  .funil-trilho { background:var(--cinza-suave); border:1px solid var(--linha); border-radius:6px; height:1.4rem; overflow:hidden; }
  .funil-barra { height:100%; background:var(--laranja); border-radius:5px 0 0 5px; min-width:0; }
  .funil-taxa { color:var(--cinza); font-size:.78rem; margin-top:.28rem; text-transform:uppercase; letter-spacing:.02em; }
  .funil-taxa b { color:var(--preto); font-weight:700; }
  /* Botao-icone de WhatsApp (coluna Telefone da lista). Classes DEDICADAS de proposito:
     .btn/.btn--ghost/.btn--off vestem dezenas de botoes de TEXTO do painel e alterar o
     padding/display delas para acomodar um icone quebraria todos. Os tres estados viram
     tratamento do proprio icone (cheio / esmaecido / cinza travado). */
  .btn-icone-whatsapp { display:inline-flex; align-items:center; justify-content:center; padding:.15rem; border:1px solid transparent; border-radius:6px; background:transparent; line-height:0; vertical-align:middle; text-decoration:none; }
  .btn-icone-whatsapp .ico-whats { display:block; }
  .btn-icone-whatsapp:hover { border-color:var(--linha); }
  .btn-icone-whatsapp--feito { filter:grayscale(.55); opacity:.6; }
  .btn-icone-whatsapp--feito:hover { filter:none; opacity:1; }
  .btn-icone-whatsapp--off { filter:grayscale(1); opacity:.3; pointer-events:none; cursor:not-allowed; }
  /* Edicao inline do Status Recrutador na lista (select compacto + aviso efemero ao lado).
     Classes dedicadas: .campo/.admin-filtros vestem os selects das telas de formulario e
     nao devem valer dentro da tabela. O aviso usa visibility (nao display) p/ a celula
     nao mudar de largura quando aparece/some. */
  .cel-status-rec { display:inline-flex; align-items:center; gap:.4rem; }
  .sel-status-rec { background:var(--campo); color:var(--preto); border:1px solid var(--linha); border-radius:6px; padding:.25rem .4rem; font:inherit; font-size:.85rem; }
  .sel-status-rec:focus { outline:none; border-color:var(--laranja); }
  .sel-status-rec:disabled { opacity:.6; cursor:progress; }
  .aviso-inline { font-size:.8rem; font-weight:700; white-space:nowrap; visibility:hidden; min-width:4.2rem; }
  .aviso-inline--ok { color:#1FA855; visibility:visible; }
  .aviso-inline--erro { color:#C0392B; visibility:visible; }
  tr.linha-zero { opacity:.5; }
  td.col-num, th.col-num { text-align:right; font-variant-numeric:tabular-nums; }
  table.admin-tab tbody tr:hover { background:var(--cinza-suave); }
  table.admin-tab tbody tr.linha-selecionada { background:var(--cinza-suave); border-left:3px solid var(--laranja); }
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

// Allowlist dos vereditos da IA (mesma lista interna da query em sqlite.js). Usada para
// sanear o filtro ?status_ia= e para o <select> do painel. Enum do item 2.
const STATUS_IA_VALIDOS = ['avancar', 'talvez', 'descartar', 'processando', 'indefinido', 'erro'];

// Valores aceitos no FILTRO de Status Recrutador da listagem: o enum de escrita
// (db.STATUS_RECRUTADOR_VALIDOS) mais o sentinela 'sem_decisao', que nao e gravavel —
// representa "coluna NULL" e vira IS NULL na query (listarAplicacoesComContexto).
const STATUS_RECRUTADOR_FILTRAVEIS = [...db.STATUS_RECRUTADOR_VALIDOS, 'sem_decisao'];

// Modos de visibilidade de arquivados na listagem (parametro `visibilidade`). O nome do
// parametro NAO e 'arquivados' porque este ja significa outra coisa na query string: e a
// CONTAGEM devolvida pelo flash de arquivar-lote (?arquivados=3). Na camada de dados o
// argumento se chama `arquivados`, onde nao ha ambiguidade.
const VISIBILIDADES_LISTA = ['ativos', 'arquivados', 'todos'];

// Chip do Status IA (veredito automatico). Reusa a classe base .badge e os modificadores
// existentes: laranja (positivo), contorno preto (negativo/sobrio), cinza (neutro/transitorio).
// Os rotulos dizem "pela IA" para nunca confundir com a decisao humana do recrutador.
function badgeStatusIa(statusIa) {
  const mapa = {
    avancar: ['Aprovado pela IA', 'badge--entrevista'], // laranja
    descartar: ['Descartado pela IA', 'badge--concluido'], // contorno preto
    talvez: ['Em dúvida (IA)', 'badge--aplicado'], // cinza
    processando: ['Avaliando…', 'badge--aplicado'], // cinza
    indefinido: ['Sem veredito', 'badge--aplicado'], // cinza
    erro: ['Erro na avaliação', 'badge--aplicado'], // cinza
  };
  const [rotulo, classe] = mapa[statusIa] || ['—', 'badge--aplicado'];
  return `<span class="badge ${classe}">${escapeHtml(rotulo)}</span>`;
}

// Detalhe da falha de avaliacao, exibido logo abaixo do badge "Erro na avaliação" no
// detalhe do candidato. Antes essa mensagem so existia no stdout do Railway (que some a
// cada redeploy) e o recrutador via apenas o badge, sem saber se foi timeout do LLM,
// resposta fora do formato ou outra coisa. Somente leitura: nenhuma acao nesta etapa.
//
// Devolve '' quando nao ha report ou quando ele nao esta em 'erro' — inclusive para as
// falhas ANTERIORES a esta mudanca, que nao deixaram linha nenhuma em reports (o caso da
// interview 84). Nesses o painel segue exatamente como hoje: so o badge.
function falhaAvaliacaoHtml(report) {
  if (!report || report.status !== 'erro') return '';
  const mensagem = report.erro_mensagem || 'Sem detalhe registrado.';
  const quando = report.erro_em ? formatarDataHora(report.erro_em) : '—';
  return `
        <div>
          <dt>Falha na avaliação</dt>
          <dd>
            <span style="color:#555;font-size:13px">${escapeHtml(quando)}</span><br>
            <span style="font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12px;word-break:break-word">${escapeHtml(mensagem)}</span>
          </dd>
        </div>`;
}

// ── Reprocessamento manual da avaliacao ──
// Uma avaliacao leva ~18s (pode chegar aos 120s do timeout). Dois cliques no botao — ou
// dois recrutadores ao mesmo tempo — gerariam DUAS chamadas pagas e DOIS e-mails, porque
// a linha em reports so e gravada no fim. Este Map fecha essa janela: a entrada e criada
// ANTES de qualquer await, entao a segunda requisicao ja encontra o lock.
//
// Por que em memoria e nao no banco: status_ia='processando' e o estado VISIVEL (badge
// "Avaliando…"), mas nao existe coluna que registre QUANDO ele mudou — sem timestamp nao
// da para expirar um 'processando' preso. O Map guarda esse momento. Efeito colateral
// desejado: se o processo reiniciar no meio, o Map se esvazia e o 'processando' orfao
// volta a ser reprocessavel, em vez de travar o candidato para sempre.
//
// Premissa: instancia unica (o projeto roda um container no Railway). Com mais de uma
// instancia este lock deixa de valer e precisaria migrar para o banco.
const JANELA_REPROCESSAMENTO_MS = 5 * 60 * 1000;
const reprocessamentosEmCurso = new Map(); // interviewId -> inicio (ms)

function reprocessamentoEmCurso(interviewId) {
  const inicio = reprocessamentosEmCurso.get(interviewId);
  if (inicio == null) return false;
  if (Date.now() - inicio > JANELA_REPROCESSAMENTO_MS) {
    reprocessamentosEmCurso.delete(interviewId); // execucao morreu sem limpar; libera
    return false;
  }
  return true;
}

// Estado dos DOIS botoes de relatorio, derivado de uma fonte so para que nunca divirjam.
// "Ver relatorio" exige um report EXIBIVEL (existe e nao esta em 'erro'). "Reprocessar
// avaliacao" e exatamente o complemento disso dentro do universo "entrevista concluida":
// nenhum report, ou o ultimo em 'erro'.
//
// status_ia NAO entra na condicao de proposito: quem manda e o lock. Um 'processando'
// COM execucao viva bloqueia (o lock esta la); um 'processando' SEM execucao viva e
// orfao e deve liberar — checar a coluna sozinha travaria o candidato para sempre.
//
// v1 trata os dois sentidos de status='erro' igual: falha de avaliacao (sem resumo, com
// erro_mensagem) e falha so no envio do e-mail (avaliacao salva, erro_mensagem NULL).
// No segundo caso reprocessar refaz uma avaliacao que ja existia — desperdicio de alguns
// decimos de centavo, aceito para nao criar dois fluxos agora.
function estadoBotoesRelatorio(cand, interviewId, report) {
  const concluida = cand.status === 'concluido' && interviewId != null;
  const podeVerRelatorio = concluida && report != null && report.status !== 'erro';
  const emCurso = interviewId != null && reprocessamentoEmCurso(interviewId);
  return { podeVerRelatorio, podeReprocessar: concluida && !podeVerRelatorio && !emCurso };
}

// Chip do Status Recrutador (decisao humana). null/desconhecido -> "Sem decisao" (cinza).
// Rotulos dizem "pelo recrutador" para diferenciar do veredito da IA (mesmas cores).
function badgeStatusRecrutador(statusRecrutador) {
  const mapa = {
    aprovado: ['Aprovado pelo recrutador', 'badge--entrevista'], // laranja
    reprovado: ['Reprovado pelo recrutador', 'badge--concluido'], // contorno preto
    em_analise: ['Em análise', 'badge--aplicado'], // cinza
  };
  const [rotulo, classe] = mapa[statusRecrutador] || ['Sem decisão', 'badge--aplicado'];
  return `<span class="badge ${classe}">${escapeHtml(rotulo)}</span>`;
}

function nomeCompleto(linha) {
  const nome = [linha.nome, linha.sobrenome].filter(Boolean).join(' ').trim();
  return nome || linha.email || '—';
}

// Icone de mensagem para o botao de WhatsApp da lista: SVG inline desenhado aqui, com
// formas basicas (balao de conversa arredondado + silhueta generica de celular). E um
// icone de "mensagem/contato" na mesma linguagem visual, NAO uma reproducao da marca
// oficial. ~21px para caber ao lado do telefone sem alargar a coluna. aria-hidden porque
// quem anuncia o controle e o aria-label do <a>/<span> ao redor (o SVG e decorativo).
const ICONE_WHATSAPP = `<svg class="ico-whats" viewBox="0 0 24 24" width="21" height="21" aria-hidden="true" focusable="false">
  <rect x="2" y="3" width="20" height="15" rx="4.5" fill="#1FA855"/>
  <polygon points="7.2,16.4 5.6,21.6 12,16.4" fill="#1FA855"/>
  <rect x="9.6" y="6.2" width="4.8" height="8.6" rx="1.2" fill="#FFFFFF"/>
  <circle cx="12" cy="13.2" r="0.6" fill="#1FA855"/>
</svg>`;

// Botao "WhatsApp": aponta para a rota interna GET /admin/candidato/:id/whatsapp, que
// registra o 1o contato e redireciona (302) para o wa.me montado no servidor. Telefone
// invalido/ausente -> desabilitado. Ja contatado (contatadoEm) -> estado DISCRETO com
// title mostrando a data do 1o contato; o clique ainda abre o wa.me (a data original e
// preservada). `variante` ajusta o estilo do botao "novo" quando preciso.
//
// Por padrao renderiza o ICONE (lista de candidatos). `comTexto: true` mantem o rotulo
// escrito — usado na tela de detalhe, onde o botao vive numa fileira de acoes de texto
// ("Editar", "Baixar currículo", ...) e um icone solto destoaria.
//
// Sem texto visivel, o estado passa a ser comunicado por aria-label (leitores de tela) +
// title (mouse). O href, a rota e os tres estados sao os mesmos de antes.
function botaoWhatsapp({ id, telefone, contatadoEm, comTexto = false }, variante = '') {
  if (normalizarTelefoneWhatsapp(telefone) == null) {
    const aria = 'WhatsApp indisponível — telefone inválido ou ausente';
    return comTexto
      ? `<span class="btn btn--off" aria-label="${aria}">WhatsApp</span>`
      : `<span class="btn-icone-whatsapp btn-icone-whatsapp--off" role="img" aria-label="${aria}" title="${aria}">${ICONE_WHATSAPP}</span>`;
  }
  const href = `/admin/candidato/${id}/whatsapp`;
  if (contatadoEm) {
    const quando = escapeHtml(formatarDataHora(contatadoEm));
    return comTexto
      ? `<a class="btn btn--ghost" href="${href}" target="_blank" rel="noopener noreferrer" title="Já contatado em ${quando}" aria-label="Já contatado via WhatsApp em ${quando}">✓ WhatsApp</a>`
      : `<a class="btn-icone-whatsapp btn-icone-whatsapp--feito" href="${href}" target="_blank" rel="noopener noreferrer" title="Já contatado em ${quando}" aria-label="Já contatado via WhatsApp em ${quando}">${ICONE_WHATSAPP}</a>`;
  }
  if (comTexto) {
    const classe = variante ? `btn ${variante}` : 'btn';
    return `<a class="${classe}" href="${href}" target="_blank" rel="noopener noreferrer" aria-label="Abrir WhatsApp">WhatsApp</a>`;
  }
  const classe = variante ? `btn-icone-whatsapp ${variante}` : 'btn-icone-whatsapp';
  return `<a class="${classe}" href="${href}" target="_blank" rel="noopener noreferrer" title="Abrir WhatsApp" aria-label="Abrir WhatsApp">${ICONE_WHATSAPP}</a>`;
}

// Le a config da mensagem de WhatsApp (nome do recrutador + template) uma unica vez por
// request, caindo nos padroes do helper quando as chaves ainda nao foram definidas.
function configWhatsapp() {
  return {
    recrutador: db.obterConfig('recrutador_nome', RECRUTADOR_PADRAO),
    template: db.obterConfig('whatsapp_template', TEMPLATE_PADRAO),
  };
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

// Opcoes do Status Recrutador na edicao inline da lista. '' = "Sem decisao" (a camada de
// dados grava null). Enum espelha STATUS_RECRUTADOR_VALIDOS; a barra de acao em MASSA tem
// as suas proprias opcoes e nao foi tocada.
const OPCOES_STATUS_RECRUTADOR = [
  ['', 'Sem decisão'],
  ['em_analise', 'Em análise'],
  ['aprovado', 'Aprovado'],
  ['reprovado', 'Reprovado'],
];

// Celula editavel do Status Recrutador (uma linha da lista). O <select> NAO tem atributo
// `name` DE PROPOSITO: ele mora dentro do <form id="form-lote"> (a tabela inteira esta la),
// e sem `name` o navegador nunca o serializa — a acao em massa e os hidden de filtro
// seguem exatamente com os mesmos campos de antes. O salvamento e 100% via fetch.
// `data-anterior` guarda o valor vigente para poder reverter quando a gravacao falha.
function selectStatusRecrutadorLinha(c) {
  const atual = c.status_recrutador || '';
  const opcoes = OPCOES_STATUS_RECRUTADOR.map(
    ([valor, rotulo]) =>
      `<option value="${escapeHtml(valor)}"${atual === valor ? ' selected' : ''}>${escapeHtml(rotulo)}</option>`,
  ).join('');
  return `<span class="cel-status-rec">
        <select class="sel-status-rec" data-status-recrutador-linha data-id="${c.id}" data-anterior="${escapeHtml(atual)}"
          aria-label="Status do recrutador de ${escapeHtml(nomeCompleto(c))}">${opcoes}</select>
        <span class="aviso-inline" data-status-aviso aria-live="polite"></span>
      </span>`;
}

// ── Colunas configuraveis da lista de candidatos ──
//
// FONTE UNICA da verdade: o <thead>, cada <td> do corpo e o painel "Colunas" saem TODOS
// deste array — a lista de colunas nao se repete em lugar nenhum. `chave` e o que vai no
// JSON da config e no value do checkbox; `rotulo` e o <th>; `celula(c)` monta o conteudo
// da <td> a partir da linha da listagem.
//
// NAO entram aqui as colunas FIXAS (checkbox de selecao, Nome e Acao/"Ver relatorio"):
// elas sempre aparecem e nao sao togglaveis.
//
// `exigeAplicacao`: a query da listagem (listarAplicacoesComContexto) NAO devolve todas
// as colunas de applications — linkedin_url fica de fora. As colunas que dependem dela
// marcam esta flag e o handler carrega a aplicacao completa por linha (db.obterAplicacao)
// SOMENTE quando pelo menos uma dessas colunas esta ativa.
const COLUNAS_CANDIDATOS = [
  {
    chave: 'telefone',
    rotulo: 'Telefone',
    // Mesma celula de sempre: telefone + botao de WhatsApp embutido (botaoWhatsapp intacto).
    celula: (c) =>
      `<span class="cel-telefone">${escapeHtml(c.telefone || '—')}</span> ${botaoWhatsapp({
        id: c.id,
        telefone: c.telefone,
        contatadoEm: c.contatado_whatsapp_em,
      })}`,
  },
  { chave: 'email', rotulo: 'E-mail', celula: (c) => escapeHtml(c.email || '—') },
  {
    chave: 'linkedin',
    rotulo: 'LinkedIn',
    exigeAplicacao: true,
    celula: (c) =>
      c.linkedin_url
        ? `<a href="${escapeHtml(c.linkedin_url)}" target="_blank" rel="noopener noreferrer" title="${escapeHtml(c.linkedin_url)}">Abrir</a>`
        : '—',
  },
  {
    chave: 'origem',
    rotulo: 'Origem (UTM)',
    // Sem `exigeAplicacao`: a query da listagem passou a trazer a.utm_source, entao esta
    // coluna nao custa mais uma consulta por linha (eram 550+ num painel sem paginacao).
    // Mesma regra da tela de detalhe: NULL (candidaturas antigas) e o literal 'direto'
    // (acesso sem UTM) exibem "Direto"; qualquer outra origem mostra o valor cru escapado.
    celula: (c) =>
      c.utm_source && c.utm_source !== 'direto' ? escapeHtml(c.utm_source) : 'Direto',
  },
  { chave: 'vaga', rotulo: 'Vaga', celula: (c) => escapeHtml(c.vaga_titulo || '—') },
  { chave: 'status', rotulo: 'Status', celula: (c) => badgeStatus(c.status) },
  { chave: 'status_ia', rotulo: 'Status IA', celula: (c) => badgeStatusIa(c.status_ia) },
  {
    chave: 'status_recrutador',
    rotulo: 'Status Recrutador',
    celula: (c) => selectStatusRecrutadorLinha(c),
  },
  {
    chave: 'criado_em',
    rotulo: 'Aplicou em',
    celula: (c) => escapeHtml(formatarDataHora(c.criado_em)),
  },
  {
    chave: 'video',
    rotulo: 'Vídeo',
    celula: (c) =>
      c.video_url
        ? `<a href="${escapeHtml(c.video_url)}" target="_blank" rel="noopener noreferrer">Abrir</a>`
        : '—',
  },
];

// Colunas FIXAS que emolduram as togglaveis: checkbox + Nome antes, Acao depois. O
// colspan da linha vazia e 3 + <togglaveis ativas>.
const COLUNAS_FIXAS_CANDIDATOS = 3;

const CHAVE_COLUNAS_CANDIDATOS = 'admin_colunas_candidatos';

// Default = a tabela que ja existia antes desta feature. Sem linha na tabela
// configuracoes, a lista renderiza exatamente como renderizava.
const COLUNAS_CANDIDATOS_PADRAO = [
  'telefone',
  'vaga',
  'status',
  'status_ia',
  'status_recrutador',
  'criado_em',
  'video',
];

// JSON defensivo (mesma ideia do lerJson privado do sqlite.js, reimplementada aqui):
// texto invalido/corrompido NUNCA quebra a pagina, cai no padrao.
function lerJsonAdmin(texto, padrao) {
  try {
    const v = JSON.parse(texto);
    return v == null ? padrao : v;
  } catch {
    return padrao;
  }
}

// Leitura agrupada da preferencia de colunas (mesmo padrao de configWhatsapp: uma
// chamada por request). Devolve os OBJETOS de COLUNAS_CANDIDATOS ativos, na ordem
// canonica do array — a ordem salva/marcada nao altera a ordem das colunas, entao
// cabecalho e corpo nunca saem de sincronia. Chave ausente -> default; array vazio
// salvo e um estado VALIDO (so as colunas fixas).
function colunasCandidatosAtivas() {
  const cru = db.obterConfig(CHAVE_COLUNAS_CANDIDATOS, null);
  const lista = cru == null ? COLUNAS_CANDIDATOS_PADRAO : lerJsonAdmin(cru, COLUNAS_CANDIDATOS_PADRAO);
  const chaves = (Array.isArray(lista) ? lista : COLUNAS_CANDIDATOS_PADRAO).map(String);
  return COLUNAS_CANDIDATOS.filter((col) => chaves.includes(col.chave));
}

// Saneia a busca textual (?q=). Unico filtro sem allowlist possivel — o valor e texto do
// recrutador —, entao o saneamento e de FORMA, nao de conteudo:
//   1. so aceita string. O Express entrega array em ?q=a&q=b e objeto em ?q[x]=1; um
//      String() cru nesses casos viraria 'a,b' ou '[object Object]' e buscaria lixo.
//      Qualquer coisa que nao seja string vira '' = sem busca.
//   2. trim(), para " maria " e "maria" serem a mesma busca (e " " ser busca nenhuma).
//   3. teto de tamanho: acima disso o excedente so encareceria o LIKE sem mudar o
//      resultado. Um nome completo com folga cabe em 100.
// Aspas, acentos e '%' nao precisam de tratamento aqui: o valor vai como PARAMETRO
// ligado (nunca concatenado no SQL) e o escape de curinga mora na camada de dados.
//
// FUNCAO COMPARTILHADA de proposito: o handler da lista e o paramsFiltros dos redirects
// precisam do MESMO resultado. Se cada um tivesse a sua copia, um teto diferente faria a
// busca mudar sozinha ao arquivar em lote — o recrutador voltaria para outro recorte.
const MAX_BUSCA = 100;
function sanearBusca(valor) {
  return typeof valor === 'string' ? valor.trim().slice(0, MAX_BUSCA) : '';
}

// ── GET /admin ── lista de candidatos (com filtros por status, data e busca, via query string) ──
router.get('/', (req, res) => {
  const q = req.query || {};
  // Saneamento: status so vale se for um dos valores conhecidos; datas no formato YYYY-MM-DD.
  const STATUS_VALIDOS = ['aplicado', 'em_entrevista', 'concluido'];
  const status = STATUS_VALIDOS.includes(q.status) ? q.status : '';
  // Status IA: mesma allowlist da query (sqlite.js). Vazio/invalido = todos.
  const statusIa = STATUS_IA_VALIDOS.includes(q.status_ia) ? q.status_ia : '';
  // Status Recrutador: enum de escrita + o sentinela 'sem_decisao' (= IS NULL na query).
  const statusRecrutador = STATUS_RECRUTADOR_FILTRAVEIS.includes(q.status_recrutador)
    ? q.status_recrutador
    : '';
  const ehData = (v) => /^\d{4}-\d{2}-\d{2}$/.test(String(v || ''));
  const dataDe = ehData(q.de) ? q.de : '';
  const dataAte = ehData(q.ate) ? q.ate : '';
  // Vaga: id inteiro positivo; vazio = todas. O <select> so oferece ids existentes.
  const vagaIdNum = Number(q.vaga);
  const vagaId = Number.isInteger(vagaIdNum) && vagaIdNum > 0 ? vagaIdNum : '';
  // Visibilidade de arquivados. NAO se chama 'arquivados' de proposito: esse nome ja e
  // usado na query string como CONTAGEM do flash de arquivar-lote (?arquivados=3).
  const visibilidade = VISIBILIDADES_LISTA.includes(q.visibilidade) ? q.visibilidade : 'ativos';
  // Busca textual livre (?q=). Regras em sanearBusca (compartilhada com paramsFiltros).
  const busca = sanearBusca(q.q);

  const vagas = db.listarVagas();

  // Origem (utm_source). A allowlist e DINAMICA — sai do proprio banco, ja com as
  // grafias duplicadas fundidas (grupo-whats/grupowhats) e NULL+'direto' num balde so.
  // Mesmo padrao dos outros enums: valor fora da lista e ignorado, o que equivale a
  // "Todas". As origens tambem alimentam o <select> mais abaixo — uma consulta so.
  const origens = db.listarOrigensDistintas();
  const origem = origens.some((o) => o.valor_canonico === q.origem) ? q.origem : '';

  // Pagina 1-indexed. Mesmo formato de saneamento do filtro de vaga (inteiro positivo,
  // lixo cai no default). A camada de dados sanea de novo — aqui o valor tambem serve
  // para desenhar os controles, entao precisa estar limpo antes da query.
  const paginaNum = Number(q.pagina);
  const pagina = Number.isInteger(paginaNum) && paginaNum > 0 ? paginaNum : 1;

  // Recorte UNICO da tela: o mesmo objeto vai para a listagem e para os dois contadores
  // do rodape. Remontar um objeto parecido em outro ponto do handler seria a porta de
  // entrada para o rodape divergir da tabela (era o que acontecia com os contadores
  // globais). Filtro novo entra aqui e chega nos tres de graca.
  // (nome com sufixo porque `filtros` mais abaixo ja e o HTML do formulario)
  const filtrosLista = {
    status,
    statusIa,
    statusRecrutador,
    dataDe,
    dataAte,
    jobId: vagaId || undefined,
    origem,
    busca,
    arquivados: visibilidade,
    // `pagina` recorta a EXIBICAO, nao o conjunto: as duas contagens do rodape usam este
    // mesmo objeto e ignoram o campo de proposito (nenhuma delas o le).
    pagina,
  };
  const candidatos = db.listarAplicacoesComContexto(filtrosLista);

  // Colunas visiveis (preferencia salva ou default). Uma leitura de config por request.
  const colunas = colunasCandidatosAtivas();

  // LinkedIn nao vem na query da listagem: so quando essa coluna esta ativa a linha e
  // completada com a aplicacao inteira (db.obterAplicacao). Com o conjunto padrao de
  // colunas, nenhuma consulta extra acontece.
  const precisaAplicacao = colunas.some((col) => col.exigeAplicacao);

  const linhas = candidatos
    .map((c) => {
      const podeVerRelatorio = c.status === 'concluido' && c.report_interview_id != null;
      const acao = podeVerRelatorio
        ? `<a class="btn" href="/admin/relatorio/${c.report_interview_id}">Ver relatório</a>`
        : `<span class="btn btn--off">Ver relatório</span>`;
      // A linha da listagem tem precedencia (traz os campos derivados: vaga_titulo,
      // video_url, report_interview_id); a aplicacao so preenche o que falta.
      const dados = precisaAplicacao ? { ...(db.obterAplicacao(c.id) || {}), ...c } : c;
      const celulas = colunas.map((col) => `<td>${col.celula(dados)}</td>`).join('');
      // Arquivado: so aparece nos modos 'arquivados'/'todos' (no modo padrao a query ja
      // filtrou). Distingue por DOIS sinais reusando CSS existente — linha esmaecida
      // (.linha-zero) e chip cinza (.badge--encerrada) —, para nao depender so da cor.
      const arquivado = Boolean(c.deleted_at);
      const marcaArquivado = arquivado
        ? ` <span class="badge badge--encerrada" title="Arquivado em ${escapeHtml(formatarDataHora(c.deleted_at))}">Arquivado</span>`
        : '';
      return `
        <tr${arquivado ? ' class="linha-zero"' : ''}>
          <td><input type="checkbox" name="ids" value="${c.id}" aria-label="Selecionar ${escapeHtml(nomeCompleto(c))}"></td>
          <td><a href="/admin/candidato/${c.id}">${escapeHtml(nomeCompleto(c))}</a>${marcaArquivado}</td>
          ${celulas}
          <td>${acao}</td>
        </tr>`;
    })
    .join('');

  // Numeros do rodape: MESMO recorte da tabela, sem `pagina` — a paginacao e recorte de
  // exibicao, nao filtro. Nenhuma das duas funcoes le esse campo; passar `filtros`
  // inteiro seria inofensivo, mas o objeto aqui nao tem pagina mesmo.
  const totalCandidatos = db.contarAplicacoesComContexto(filtrosLista);
  const totalConcluidas = db.contarEntrevistasConcluidasComContexto(filtrosLista);

  // Numero de paginas do recorte, reaproveitando a contagem que o rodape ja fez (nenhuma
  // query a mais). Piso 1 para a tela nunca dizer "Pagina 1 de 0" quando nao ha resultado.
  // Pagina alem da ultima nao e erro nem redirect: o OFFSET simplesmente devolve vazio e
  // a mensagem de "nenhum candidato" que ja existia cobre o caso.
  const totalPaginas = Math.max(1, Math.ceil(totalCandidatos / db.CANDIDATOS_POR_PAGINA));

  const sel = (v) => (status === v ? ' selected' : '');
  const selIa = (v) => (statusIa === v ? ' selected' : '');
  const selRec = (v) => (statusRecrutador === v ? ' selected' : '');
  const selVis = (v) => (visibilidade === v ? ' selected' : '');
  // `pagina` de proposito FORA daqui: ela nao recorta nada — decide o "(filtrado)" do
  // rodape e a mensagem de tabela vazia, e estar na pagina 3 nao e um filtro.
  const temFiltro =
    busca ||
    status ||
    statusIa ||
    statusRecrutador ||
    dataDe ||
    dataAte ||
    vagaId ||
    origem ||
    visibilidade !== 'ativos';
  const opcoesVaga = vagas
    .map(
      (v) =>
        `<option value="${v.id}"${String(vagaId) === String(v.id) ? ' selected' : ''}>${escapeHtml(v.titulo || `Vaga ${v.id}`)}</option>`,
    )
    .join('');
  // O valor vai cru no value (e o valor_canonico que o filtro espera de volta) e o rotulo
  // escapado — 'meta', 'recrutasimples' etc. sao dados vindos da URL de campanha.
  const opcoesOrigem = origens
    .map(
      (o) =>
        `<option value="${escapeHtml(o.valor_canonico)}"${origem === o.valor_canonico ? ' selected' : ''}>${escapeHtml(o.label)}</option>`,
    )
    .join('');
  const filtros = `
    <form method="GET" action="/admin" class="admin-filtros">
      <!-- Primeiro item de proposito: e o filtro que o recrutador usa para achar UMA
           pessoa (o caso mais frequente), enquanto os selects abaixo recortam grupos.
           O value repete a busca saneada — sem isso o campo esvaziaria a cada submit e
           o recrutador nao veria o que esta filtrando. -->
      <label class="filtro filtro--busca">
        <span>Buscar</span>
        <input type="search" name="q" value="${escapeHtml(busca)}"
          placeholder="Nome, e-mail ou telefone">
      </label>
      <label class="filtro">
        <span>Vaga</span>
        <select name="vaga">
          <option value=""${vagaId ? '' : ' selected'}>Todas</option>
          ${opcoesVaga}
        </select>
      </label>
      <label class="filtro">
        <span>Origem</span>
        <select name="origem">
          <option value=""${origem ? '' : ' selected'}>Todas</option>
          ${opcoesOrigem}
        </select>
      </label>
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
        <span>Status IA</span>
        <select name="status_ia">
          <option value=""${statusIa ? '' : ' selected'}>Todos</option>
          <option value="avancar"${selIa('avancar')}>Aprovados pela IA</option>
          <option value="descartar"${selIa('descartar')}>Descartados pela IA</option>
          <option value="talvez"${selIa('talvez')}>Em dúvida (IA)</option>
          <option value="processando"${selIa('processando')}>Avaliando…</option>
          <option value="indefinido"${selIa('indefinido')}>Sem veredito</option>
          <option value="erro"${selIa('erro')}>Erro na avaliação</option>
        </select>
      </label>
      <label class="filtro">
        <span>Status Recrutador</span>
        <select name="status_recrutador">
          <option value=""${statusRecrutador ? '' : ' selected'}>Todos</option>
          <option value="sem_decisao"${selRec('sem_decisao')}>Sem decisão</option>
          <option value="em_analise"${selRec('em_analise')}>Em análise</option>
          <option value="aprovado"${selRec('aprovado')}>Aprovado</option>
          <option value="reprovado"${selRec('reprovado')}>Reprovado</option>
        </select>
      </label>
      <label class="filtro">
        <span>Exibir</span>
        <select name="visibilidade">
          <option value="ativos"${selVis('ativos')}>Ativos</option>
          <option value="arquivados"${selVis('arquivados')}>Arquivados</option>
          <option value="todos"${selVis('todos')}>Todos</option>
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

  // Painel "Colunas": um checkbox por coluna togglavel, gerado do MESMO array que monta
  // a tabela. Form PROPRIO (nao aninhado no form-lote, que ja e um <form> de POST) e com
  // os hidden dos filtros ativos, para o redirect da rota voltar ao mesmo recorte.
  const ativas = new Set(colunas.map((col) => col.chave));
  const opcoesColunas = COLUNAS_CANDIDATOS.map(
    (col) => `
        <label style="display:flex;align-items:center;gap:.4rem;white-space:nowrap;">
          <input type="checkbox" name="colunas" value="${escapeHtml(col.chave)}"${ativas.has(col.chave) ? ' checked' : ''}>
          <span>${escapeHtml(col.rotulo)}</span>
        </label>`,
  ).join('');
  const painelColunas = `
    <details class="bloco-card" style="margin-bottom:1rem;">
      <summary>Colunas</summary>
      <form method="POST" action="/admin/colunas-candidatos">
        <input type="hidden" name="q" value="${escapeHtml(busca)}">
        <input type="hidden" name="status" value="${escapeHtml(status)}">
        <input type="hidden" name="status_ia" value="${escapeHtml(statusIa)}">
        <input type="hidden" name="filtro_status_recrutador" value="${escapeHtml(statusRecrutador)}">
        <input type="hidden" name="de" value="${escapeHtml(dataDe)}">
        <input type="hidden" name="ate" value="${escapeHtml(dataAte)}">
        <input type="hidden" name="vaga" value="${escapeHtml(String(vagaId || ''))}">
        <input type="hidden" name="origem" value="${escapeHtml(origem)}">
        <input type="hidden" name="visibilidade" value="${escapeHtml(visibilidade)}">
        <p style="color:var(--cinza);font-size:.85rem;margin:0 0 .7rem;">
          Escolha as colunas visíveis na tabela. Seleção, <b>Nome</b> e <b>Ação</b> são fixas.
        </p>
        <div style="display:flex;gap:.6rem 1.4rem;flex-wrap:wrap;margin-bottom:.9rem;">
          ${opcoesColunas}
        </div>
        <button type="submit" class="btn">Salvar colunas</button>
      </form>
    </details>`;

  // Aviso pos-acao (arquivar individual/lote, status do recrutador em lote, restaurar,
  // selecao vazia), sinalizado por query string apos o redirect.
  const nArquivados = Number(req.query.arquivados);
  const nRestaurados = Number(req.query.restaurados);
  const nStatusRecrutador = Number(req.query.status_recrutador_aplicados);
  const flashLista =
    req.query.sem_selecao === '1'
      ? '<div class="aviso-alerta">Nenhum lead válido selecionado.</div>'
      : req.query.sem_status === '1'
        ? '<div class="aviso-alerta">Nenhum status informado. Escolha um status antes de aplicar.</div>'
        : req.query.restaurados != null && Number.isInteger(nRestaurados) && nRestaurados >= 0
          ? `<div class="aviso-ok">${nRestaurados} candidato(s) restaurado(s). Eles voltaram para a listagem de ativos.</div>`
          : req.query.status_recrutador_aplicados != null &&
              Number.isInteger(nStatusRecrutador) &&
              nStatusRecrutador >= 0
            ? `<div class="aviso-ok">Status do recrutador atualizado em ${nStatusRecrutador} candidato(s).</div>`
            : req.query.arquivados != null && Number.isInteger(nArquivados) && nArquivados >= 0
            ? `<div class="aviso-ok">${nArquivados} lead(s) arquivado(s). Eles saíram da listagem, mas o histórico foi preservado.</div>`
            : req.query.arquivado === '1'
              ? '<div class="aviso-ok">Lead arquivado. Ele saiu da listagem, mas o histórico foi preservado.</div>'
              : req.query.restaurado === '1'
                ? '<div class="aviso-ok">Lead restaurado.</div>'
                : '';

  // ── Controles de paginacao ──
  // Links de reload (GET), o mesmo padrao de navegacao do resto da tela: sem fetch, sem
  // POST. A querystring sai de paramsFiltros — a MESMA fonte usada pelos redirects
  // pos-acao —, e so `pagina` e escrita por cima. Assim a lista de filtros que viaja na
  // URL nao e redigitada aqui: filtro novo entra em paramsFiltros e a navegacao o
  // preserva de graca.
  const linkPagina = (n) => {
    const p = paramsFiltros({
      q: busca,
      status,
      status_ia: statusIa,
      filtro_status_recrutador: statusRecrutador,
      de: dataDe,
      ate: dataAte,
      vaga: vagaId,
      origem,
      visibilidade,
    });
    p.set('pagina', String(n));
    return `/admin?${p.toString()}`;
  };
  // Escondido quando ha uma pagina so — nao ha para onde navegar e a barra viraria ruido.
  // A excecao e `pagina > 1`: quem chegou a uma pagina alem da ultima (URL na mao, ou um
  // filtro que encolheu o resultado) precisa de um caminho de volta na tela.
  // "Anterior" nesse caso aponta para a ULTIMA pagina real, nao para pagina-1, que seria
  // outra tela vazia.
  const paginacao =
    totalPaginas > 1 || pagina > 1
      ? `
      <nav class="admin-paginacao" aria-label="Paginação da lista de candidatos">
        ${
          pagina > 1
            ? `<a class="btn btn--ghost" rel="prev" href="${linkPagina(Math.min(pagina - 1, totalPaginas))}">← Anterior</a>`
            : '<span class="btn btn--off">← Anterior</span>'
        }
        <span>Página <b>${pagina}</b> de <b>${totalPaginas}</b></span>
        ${
          pagina < totalPaginas
            ? `<a class="btn btn--ghost" rel="next" href="${linkPagina(pagina + 1)}">Próxima →</a>`
            : '<span class="btn btn--off">Próxima →</span>'
        }
      </nav>`
      : '';

  const conteudo = `
    ${flashLista}
    <div style="display:flex;justify-content:space-between;align-items:center;gap:1rem;flex-wrap:wrap;margin-bottom:1rem;">
      <h1 style="margin:0;">Candidatos</h1>
      <div style="display:flex;gap:.5rem;flex-wrap:wrap;">
        <a class="btn btn--ghost" href="/admin/dashboard">Funil de Conversão</a>
        <a class="btn btn--ghost" href="/admin/vagas">Vagas</a>
        <a class="btn btn--ghost" href="/admin/talentos">Banco de talentos</a>
        <a class="btn btn--ghost" href="/admin/divulgacao-vagas">Divulgação de Vagas</a>
        <a class="btn btn--ghost" href="/admin/config">Configurações</a>
      </div>
    </div>
    ${filtros}
    ${painelColunas}
    <form id="form-lote" method="POST" action="/admin/candidatos/arquivar-lote">
      <input type="hidden" name="q" value="${escapeHtml(busca)}">
      <input type="hidden" name="status" value="${escapeHtml(status)}">
      <input type="hidden" name="status_ia" value="${escapeHtml(statusIa)}">
      <!-- Nome PROPOSITALMENTE diferente do filtro na query string: dentro deste form ja
           existe um <select name="status_recrutador"> — o valor que a acao em MASSA aplica.
           Dois campos com o mesmo name colidiriam no POST. paramsFiltros sabe ler os dois. -->
      <input type="hidden" name="filtro_status_recrutador" value="${escapeHtml(statusRecrutador)}">
      <input type="hidden" name="de" value="${escapeHtml(dataDe)}">
      <input type="hidden" name="ate" value="${escapeHtml(dataAte)}">
      <input type="hidden" name="vaga" value="${escapeHtml(String(vagaId || ''))}">
      <input type="hidden" name="origem" value="${escapeHtml(origem)}">
        <input type="hidden" name="visibilidade" value="${escapeHtml(visibilidade)}">
      <div style="margin:0 0 .75rem;display:flex;gap:.5rem;align-items:center;flex-wrap:wrap;">
        <button type="submit" class="btn" data-arquivar-lote disabled>Arquivar selecionados</button>
        <button type="submit" class="btn btn--ghost" formaction="/admin/candidatos/restaurar-lote"
          data-restaurar-lote disabled>Restaurar selecionados</button>
        <select name="status_recrutador" aria-label="Status do recrutador a aplicar nos selecionados"
          style="background:var(--campo);color:var(--preto);border:1px solid var(--linha);border-radius:6px;padding:.4rem .6rem;font:inherit;">
          <option value="">Sem decisão</option>
          <option value="em_analise">Em análise</option>
          <option value="aprovado">Aprovado</option>
          <option value="reprovado">Reprovado</option>
        </select>
        <button type="submit" class="btn" formaction="/admin/candidatos/status-recrutador-lote"
          data-status-lote disabled>Aplicar status aos selecionados</button>
      </div>
      <div class="admin-tab-scroll">
        <table class="admin-tab">
          <thead>
            <tr>
              <th><input type="checkbox" data-selecionar-todos aria-label="Selecionar todos"></th>
              <th>Nome</th>
              ${colunas.map((col) => `<th>${escapeHtml(col.rotulo)}</th>`).join('')}
              <th>Ação</th>
            </tr>
          </thead>
          <tbody>
            ${linhas || `<tr><td colspan="${COLUNAS_FIXAS_CANDIDATOS + colunas.length}">${temFiltro ? 'Nenhum candidato para os filtros aplicados.' : 'Nenhum candidato ainda.'}</td></tr>`}
          </tbody>
        </table>
      </div>
    </form>
    ${paginacao}
    <p class="admin-rodape">
      Total de candidatos: <b>${totalCandidatos}</b> ·
      Entrevistas concluídas: <b>${totalConcluidas}</b>${temFiltro ? ' <span class="rodape-filtrado">(filtrado)</span>' : ''}
    </p>
    <script>
    (function () {
      var form = document.getElementById('form-lote');
      if (!form) return;
      var todos = form.querySelector('[data-selecionar-todos]');
      var botao = form.querySelector('[data-arquivar-lote]');
      var botaoStatus = form.querySelector('[data-status-lote]');
      var botaoRestaurar = form.querySelector('[data-restaurar-lote]');
      var base = 'Arquivar selecionados';
      var baseStatus = 'Aplicar status aos selecionados';
      var baseRestaurar = 'Restaurar selecionados';
      // Qual botao disparou o submit (o form tem dois: arquivar e aplicar status, este via
      // formaction). Fallback p/ navegadores sem event.submitter: guarda o ultimo clicado.
      var ultimoBotao = null;
      function itens() { return Array.prototype.slice.call(form.querySelectorAll('input[name="ids"]')); }
      function marcados() { return itens().filter(function (c) { return c.checked; }); }
      function rotular(b, texto, n) {
        if (!b) return;
        b.disabled = n === 0;
        b.textContent = n > 0 ? texto + ' (' + n + ')' : texto;
      }
      function atualizar() {
        var n = marcados().length;
        rotular(botao, base, n);
        rotular(botaoStatus, baseStatus, n);
        rotular(botaoRestaurar, baseRestaurar, n);
        if (todos) { todos.checked = n > 0 && n === itens().length; }
        itens().forEach(function (c) {
          var tr = c.closest('tr');
          if (tr) { tr.classList.toggle('linha-selecionada', c.checked); }
        });
      }
      form.addEventListener('change', function (e) {
        if (e.target === todos) { itens().forEach(function (c) { c.checked = todos.checked; }); }
        atualizar();
      });
      form.addEventListener('click', function (e) {
        var b = e.target.closest ? e.target.closest('button[type="submit"]') : null;
        if (b) { ultimoBotao = b; }
      });
      form.addEventListener('submit', function (e) {
        var n = marcados().length;
        if (n === 0) { e.preventDefault(); return; }
        var alvo = e.submitter || ultimoBotao;
        var msg;
        if (alvo && alvo.hasAttribute('data-status-lote')) {
          msg = 'Aplicar o status escolhido a ' + n + ' candidato(s)?';
        } else if (alvo && alvo.hasAttribute('data-restaurar-lote')) {
          msg = 'Restaurar ' + n + ' candidato(s)? Eles voltam para a listagem de ativos.';
        } else {
          msg = 'Arquivar ' + n + ' lead(s)? Eles saem da listagem, mas o histórico é preservado.';
        }
        if (!confirm(msg)) { e.preventDefault(); }
      });
      atualizar();
    })();

    // Edicao inline do Status Recrutador: salva por linha, sem sair da lista. Escutamos na
    // TABELA (nao no form) para nunca cruzar com o <select> da barra de acao em massa, que
    // fica fora dela. O select da linha nao tem atributo name, entao nada disso interfere
    // no que o form-lote submete.
    (function () {
      var tabela = document.querySelector('table.admin-tab');
      if (!tabela || !window.fetch) return;

      // Aviso efemero ao lado do select ("✓ Salvo" / "Erro ao salvar"), some sozinho em 2s.
      function avisar(sel, texto, modificador) {
        var alvo = sel.parentNode ? sel.parentNode.querySelector('[data-status-aviso]') : null;
        if (!alvo) return;
        alvo.textContent = texto;
        alvo.className = 'aviso-inline ' + modificador;
        if (alvo.temporizador) { clearTimeout(alvo.temporizador); }
        alvo.temporizador = setTimeout(function () {
          alvo.textContent = '';
          alvo.className = 'aviso-inline';
        }, 2000);
      }

      tabela.addEventListener('change', function (e) {
        var sel = e.target;
        if (!sel || !sel.hasAttribute || !sel.hasAttribute('data-status-recrutador-linha')) return;

        var anterior = sel.getAttribute('data-anterior') || '';
        // Desabilitar durante a chamada evita disparos concorrentes no MESMO select.
        sel.disabled = true;

        fetch('/admin/candidato/' + encodeURIComponent(sel.getAttribute('data-id')) + '/status-recrutador', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
            'X-Requested-With': 'fetch'
          },
          body: 'status_recrutador=' + encodeURIComponent(sel.value)
        })
          .then(function (r) { return r.json().catch(function () { return null; }); })
          .then(function (d) {
            if (!d || d.ok !== true) { throw new Error('falha'); }
            // Reflete o valor que o servidor REALMENTE gravou (null -> '' = Sem decisão).
            var salvo = d.status_recrutador || '';
            sel.value = salvo;
            sel.setAttribute('data-anterior', salvo);
            avisar(sel, '✓ Salvo', 'aviso-inline--ok');
          })
          .catch(function () {
            sel.value = anterior; // nunca deixa o select mostrando algo que nao foi gravado
            avisar(sel, 'Erro ao salvar', 'aviso-inline--erro');
          })
          .then(function () { sel.disabled = false; });
      });
    })();
    </script>`;

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

  // Mesmo criterio da lista: relatorio so quando a entrevista concluiu e ha report
  // EXIBIVEL. Report com status='erro' e so o rastro da falha (erro_mensagem/erro_em),
  // sem resumo/pontuacoes — abrir a pagina mostraria um relatorio vazio, entao o botao
  // fica desabilitado e a mensagem do erro aparece junto ao badge de Status IA, abaixo.
  // O botao de reprocessar e o complemento exato deste (ver estadoBotoesRelatorio).
  const { podeVerRelatorio, podeReprocessar } = estadoBotoesRelatorio(cand, interviewId, report);
  const botaoRelatorio = podeVerRelatorio
    ? `<a class="btn" href="/admin/relatorio/${interviewId}">Ver relatório</a>`
    : `<span class="btn btn--off">Ver relatório</span>`;

  // Reprocessar avaliacao: so aparece quando ha o que reprocessar. POST (nunca GET, igual
  // a arquivar/restaurar) + confirm, porque a acao gasta uma chamada paga e dispara e-mail.
  const botaoReprocessar = podeReprocessar
    ? `<form method="POST" action="/admin/candidato/${cand.id}/reprocessar" style="margin:0;display:inline;"
             onsubmit="return confirm('Gerar uma nova avaliação desta entrevista com a IA? Isso consome uma chamada paga e envia um novo e-mail ao recrutador.')">
         <button type="submit" class="btn btn--ghost">Reprocessar avaliação</button>
       </form>`
    : '';

  const temCurriculo = Boolean(cand.curriculo_path);
  const botaoCurriculo = temCurriculo
    ? `<a class="btn" href="/admin/candidato/${cand.id}/curriculo">Baixar currículo</a>`
    : `<span class="btn btn--off">Baixar currículo</span>`;

  const botaoVideo = videoUrl
    ? `<a class="btn btn--ghost" href="${escapeHtml(videoUrl)}" target="_blank" rel="noopener noreferrer">Abrir vídeo</a>`
    : `<span class="btn btn--off">Abrir vídeo</span>`;

  // Botao de WhatsApp: mensagem pre-preenchida com nome, titulo da vaga e empresa (quando
  // a vaga tem empresa preenchida). Telefone invalido -> botao desabilitado (no helper).
  const botaoWhats = botaoWhatsapp({
    id: cand.id,
    telefone: cand.telefone,
    contatadoEm: cand.contatado_whatsapp_em,
    comTexto: true, // fileira de acoes com botoes de texto: aqui o rotulo escrito fica
  });

  const linkedin = cand.linkedin_url
    ? `<a href="${escapeHtml(cand.linkedin_url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(cand.linkedin_url)}</a>`
    : '—';

  // Origem do lead (utm_source). NULL (candidaturas anteriores a esta feature) e o
  // valor literal 'direto' (acesso sem UTM) exibem como "Direto"; qualquer outra
  // origem mostra o utm_source cru (escapado). Nunca "null" nem em branco na tela.
  const origemLead =
    cand.utm_source && cand.utm_source !== 'direto' ? escapeHtml(cand.utm_source) : 'Direto';

  const arquivado = Boolean(cand.deleted_at);

  // Aviso pos-acao (edicao/restauracao), sinalizado por query string apos o redirect.
  const flash =
    req.query.ok === 'editado'
      ? '<div class="aviso-ok">Dados do candidato atualizados.</div>'
      : req.query.ok === 'restaurado'
        ? '<div class="aviso-ok">Lead restaurado.</div>'
        : req.query.ok === 'status_recrutador'
          ? '<div class="aviso-ok">Decisão do recrutador registrada.</div>'
          : req.query.ok === 'reprocessando'
            ? '<div class="aviso-ok">Reavaliação iniciada. Ela leva alguns segundos; atualize a página para ver o resultado.</div>'
            : '';

  // Erro pos-acao: telefone invalido ao tentar abrir o WhatsApp (redirect da rota), ou
  // reprocessamento recusado (pagina velha: ja ha relatorio, ou outra reavaliacao em curso).
  const flashErro =
    req.query.erro === 'whatsapp_telefone'
      ? '<div class="aviso-alerta">Não foi possível abrir o WhatsApp: o telefone do candidato é inválido ou está incompleto. Edite o contato e tente novamente.</div>'
      : req.query.erro === 'reprocessar_estado'
        ? '<div class="aviso-alerta">Não foi possível reprocessar: já existe relatório para esta entrevista ou uma reavaliação está em andamento.</div>'
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

  // ── Sequencia de WhatsApp (WA1/WA2) + confirmacao do video ──
  // UMA consulta para as duas etapas. Candidatura anterior a esta feature devolve [] e a
  // tela mostra "não se aplica" — ausencia e o caso NORMAL aqui, nao erro.
  const linhasWa = db.listarSequenciaWhatsappDaApplication(cand.id);
  const wa1 = fichaWa.estadoEtapa(linhasWa, 'wa1');
  const wa2 = fichaWa.estadoEtapa(linhasWa, 'wa2');
  const limiteVideo = fichaWa.limiteDoVideo(linhasWa);
  const situacaoVideo = fichaWa.situacaoVideo(cand, linhasWa);

  const linhaEtapa = (rotulo, e) =>
    `<div><dt>${rotulo}</dt><dd>${escapeHtml(e.rotulo)}` +
    `${e.enviadoEm ? ` <small style="color:var(--cinza)">em ${escapeHtml(formatarDataHora(e.enviadoEm))}</small>` : ''}` +
    `${e.erro ? `<br><small style="color:var(--cinza)">${escapeHtml(e.erro)}</small>` : ''}</dd></div>`;

  // O botao so aparece depois de o WA2 ter SAIDO: confirmar recebimento de algo que o
  // sistema nao registra ter enviado gravaria um dado que nao se sustenta.
  const botaoVideoWa = fichaWa.podeConfirmarVideo(linhasWa)
    ? `<a class="btn" href="/admin/candidato/${cand.id}/video-wa2">` +
      `${situacaoVideo.confirmado ? 'Revisar confirmação do vídeo' : 'Marcar vídeo recebido'}</a>`
    : `<button type="button" class="btn btn--off" disabled title="O WA2 ainda não foi enviado para este candidato.">Marcar vídeo recebido</button>`;

  const blocoSequenciaWa = `
    <section class="rel-sec">
      <h2>Sequência de WhatsApp</h2>
      <dl class="rel-id">
        ${linhaEtapa('WA1 (imediato)', wa1)}
        ${linhaEtapa('WA2 (+' + sequenciaWhatsapp.WA2_ATRASO_MINUTOS + 'min, pede vídeo)', wa2)}
        <div><dt>Vídeo de apresentação</dt><dd>${escapeHtml(situacaoVideo.rotulo)}
          ${situacaoVideo.confirmado && situacaoVideo.por ? `<br><small style="color:var(--cinza)">por ${escapeHtml(situacaoVideo.por)} em ${escapeHtml(formatarDataHora(situacaoVideo.em))}</small>` : ''}
        </dd></div>
        ${limiteVideo ? `<div><dt>Prazo do vídeo</dt><dd>${escapeHtml(formatarDataHora(limiteVideo.toISOString()))}</dd></div>` : ''}
      </dl>
      <div class="acoes-linha" style="margin-top:.8rem">${botaoVideoWa}</div>
    </section>`;

  const conteudo = `
    <div style="display:flex;justify-content:space-between;align-items:center;gap:1rem;flex-wrap:wrap;margin-bottom:1rem;">
      <h1 style="margin:0;">${escapeHtml(nomeCompleto(cand))}</h1>
      <a class="btn btn--ghost" href="/admin">← Voltar ao painel</a>
    </div>
    ${flash}
    ${flashErro}
    ${avisoArquivado}

    <section class="rel-sec">
      <h2>Dados pessoais</h2>
      <dl class="rel-id">
        <div><dt>Nome</dt><dd>${escapeHtml(cand.nome || '—')}</dd></div>
        <div><dt>Sobrenome</dt><dd>${escapeHtml(cand.sobrenome || '—')}</dd></div>
        <div><dt>E-mail</dt><dd>${escapeHtml(cand.email || '—')}</dd></div>
        <div><dt>Telefone</dt><dd>${escapeHtml(cand.telefone || '—')}</dd></div>
        <div><dt>Contato WhatsApp</dt><dd>${cand.contatado_whatsapp_em ? `✓ ${escapeHtml(formatarDataHora(cand.contatado_whatsapp_em))}` : '—'}</dd></div>
        <div><dt>LinkedIn</dt><dd>${linkedin}</dd></div>
        <div><dt>Origem (UTM)</dt><dd>${origemLead}</dd></div>
        ${cand.cidade ? `<div><dt>Cidade</dt><dd>${escapeHtml(cand.cidade)}</dd></div>` : ''}
        <div><dt>Vaga</dt><dd>${escapeHtml((vaga && vaga.titulo) || cand.vaga_titulo || '—')}</dd></div>
        <div><dt>Status</dt><dd>${badgeStatus(cand.status)}</dd></div>
        <div><dt>Status IA</dt><dd>${badgeStatusIa(cand.status_ia)}</dd></div>
        ${falhaAvaliacaoHtml(report)}
        <div><dt>Status Recrutador</dt><dd>${badgeStatusRecrutador(cand.status_recrutador)}</dd></div>
        <div><dt>Aplicou em</dt><dd>${escapeHtml(formatarDataHora(cand.criado_em))}</dd></div>
      </dl>
    </section>

    <section class="rel-sec">
      <h2>Decisão do recrutador</h2>
      <form method="POST" action="/admin/candidato/${cand.id}/status-recrutador">
        <label class="campo" style="max-width:320px;">
          <span>Status Recrutador</span>
          <select name="status_recrutador">
            <option value=""${!cand.status_recrutador ? ' selected' : ''}>Sem decisão</option>
            <option value="em_analise"${cand.status_recrutador === 'em_analise' ? ' selected' : ''}>Em análise</option>
            <option value="aprovado"${cand.status_recrutador === 'aprovado' ? ' selected' : ''}>Aprovado</option>
            <option value="reprovado"${cand.status_recrutador === 'reprovado' ? ' selected' : ''}>Reprovado</option>
          </select>
        </label>
        <button type="submit" class="btn">Salvar decisão</button>
      </form>
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

    ${blocoSequenciaWa}

    <section class="rel-sec">
      <h2>Ações</h2>
      <div class="acoes-linha" style="flex-wrap:wrap;gap:.6rem;">
        ${botaoEditar}
        ${botaoWhats}
        ${botaoCurriculo}
        ${botaoRelatorio}
        ${botaoReprocessar}
        ${botaoVideo}
        ${botaoArquivarRestaurar}
      </div>
    </section>`;

  res.send(paginaAdmin({ titulo: `Candidato — ${nomeCompleto(cand)}`, conteudo }));
});

// ── GET /admin/candidato/:id/video-wa2 ── tela de confirmacao do video ──
//
// Tela intermediaria, e nao um POST direto do botao. A razao e o item 1 da regra: o
// recrutador ve o HORARIO-LIMITE calculado ANTES de confirmar. Um clique que grava
// "dentro/fora do prazo" sem mostrar contra o que esta comparando e um clique cego, e o
// resultado dele decide o destino de um candidato.
router.get('/candidato/:id/video-wa2', (req, res) => {
  const id = Number(req.params.id);
  const cand = Number.isInteger(id) && id > 0 ? db.obterAplicacao(id) : null;
  if (!cand) {
    return avisoAdmin(res, 404, { titulo: 'Candidato não encontrado', descricao: 'Não há candidatura com este identificador.' });
  }

  const linhas = db.listarSequenciaWhatsappDaApplication(id);
  if (!fichaWa.podeConfirmarVideo(linhas)) {
    return avisoAdmin(res, 400, {
      titulo: 'WA2 ainda não foi enviado',
      descricao:
        'Não há registro de que a mensagem pedindo o vídeo tenha saído para este candidato. ' +
        'Confirmar o recebimento agora gravaria um prazo que nunca começou a correr.',
    });
  }

  const limite = fichaWa.limiteDoVideo(linhas);
  const sugestao = fichaWa.sugestaoDentroPrazo(limite);
  const atual = fichaWa.situacaoVideo(cand, linhas);
  const wa2 = fichaWa.estadoEtapa(linhas, 'wa2');

  const conteudo = `
    <h1>Vídeo de apresentação</h1>
    <p class="admin-sub">${escapeHtml(nomeCompleto(cand))}</p>

    <div class="bloco-card" style="margin-top:1rem">
      <dl class="rel-id">
        <div><dt>WA2 enviado em</dt><dd>${escapeHtml(formatarDataHora(wa2.enviadoEm))}</dd></div>
        <div><dt>Prazo (amanhã, meio-dia)</dt><dd><b>${escapeHtml(formatarDataHora(limite.toISOString()))}</b></dd></div>
        <div><dt>Agora</dt><dd>${escapeHtml(formatarDataHora(new Date().toISOString()))}</dd></div>
      </dl>
    </div>

    ${atual.confirmado ? `<div class="aviso-alerta">Já confirmado: <b>${escapeHtml(atual.rotulo)}</b>${atual.por ? ` por ${escapeHtml(atual.por)}` : ''}. Salvar de novo <b>substitui</b> o registro anterior.</div>` : ''}

    <form method="post" action="/admin/candidato/${cand.id}/video-wa2" class="vm-form">
      <label class="campo">
        <span>Chegou dentro do prazo?</span>
        <select name="dentro_prazo">
          <option value="sim"${sugestao === 'sim' ? ' selected' : ''}>Sim, dentro do prazo</option>
          <option value="nao"${sugestao === 'nao' ? ' selected' : ''}>Não, fora do prazo</option>
          <option value="na">Não se aplica</option>
        </select>
      </label>
      <p style="margin:-.6rem 0 1rem;color:var(--cinza);font-size:.8rem;">
        A sugestão acima compara <b>agora</b> com o prazo. Corrija se souber que o vídeo
        chegou antes de você estar olhando o painel — a confirmação é sempre depois do fato.
      </p>

      <label class="campo">
        <span>Confirmado por</span>
        <input type="text" name="confirmado_por" maxlength="120" placeholder="seu nome" value="${escapeHtml(atual.por || '')}">
      </label>
      <p style="margin:-.6rem 0 1rem;color:var(--cinza);font-size:.8rem;">
        Texto livre: o painel tem login único e não sabe quem está operando.
      </p>

      <div class="acoes-linha">
        <button type="submit" class="btn">Confirmar vídeo recebido</button>
        <a class="btn btn--ghost" href="/admin/candidato/${cand.id}">Cancelar</a>
      </div>
    </form>`;

  res.send(paginaAdmin({ titulo: 'Vídeo de apresentação', conteudo }));
});

// ── POST /admin/candidato/:id/video-wa2 ──
//
// UPDATE simples: sao tres colunas em `applications`, nao uma tabela a parte. Reconfirmar
// ATUALIZA em vez de duplicar — a ultima palavra do recrutador e a que vale, inclusive para
// corrigir uma marcacao errada.
router.post('/candidato/:id/video-wa2', (req, res) => {
  const id = Number(req.params.id);
  const cand = Number.isInteger(id) && id > 0 ? db.obterAplicacao(id) : null;
  if (!cand) {
    return avisoAdmin(res, 404, { titulo: 'Candidato não encontrado', descricao: 'Não há candidatura com este identificador.' });
  }

  const linhas = db.listarSequenciaWhatsappDaApplication(id);
  if (!fichaWa.podeConfirmarVideo(linhas)) {
    return avisoAdmin(res, 400, {
      titulo: 'WA2 ainda não foi enviado',
      descricao: 'Não há registro de envio do pedido de vídeo para este candidato.',
    });
  }

  const b = req.body || {};
  const bruto = String(b.dentro_prazo || '').trim().toLowerCase();
  // Valor fora do enum cai em 'na' em vez de recusar: o fato (video recebido) e mais
  // importante que o rotulo, e perder o registro por causa de um select adulterado seria
  // proteger a etiqueta as custas do dado.
  const dentroPrazo = fichaWa.DENTRO_PRAZO_VALIDOS.includes(bruto) ? bruto : 'na';

  db.confirmarVideoWa2(id, {
    recebidoEm: new Date().toISOString(),
    dentroPrazo,
    confirmadoPor: b.confirmado_por,
  });

  res.redirect(`/admin/candidato/${id}?salvo=video`);
});

// ── GET /admin/candidato/:id/whatsapp ── registra o 1o contato e abre o wa.me ──
// Fluxo: valida id -> normaliza telefone (invalido => volta ao detalhe com erro, NUNCA
// redireciona para um wa.me quebrado) -> grava contatado_whatsapp_em (so na 1a vez) ->
// 302 para o link wa.me montado no servidor (mensagem do template configurado). Herda o
// adminAuth (declarada apos router.use(adminAuth)).
router.get('/candidato/:id/whatsapp', (req, res) => {
  const id = Number(req.params.id);
  const cand = Number.isInteger(id) && id > 0 ? db.obterAplicacao(id) : null;
  if (!cand) {
    return avisoAdmin(res, 404, {
      titulo: 'Candidato não encontrado',
      descricao: 'Não há candidatura com este identificador.',
    });
  }

  // Telefone invalido/incompleto: volta ao detalhe com flag de erro (nao abre wa.me quebrado).
  if (!normalizarTelefoneWhatsapp(cand.telefone)) {
    return res.redirect(`/admin/candidato/${id}?erro=whatsapp_telefone`);
  }

  const vaga = cand.job_id ? db.obterVaga(cand.job_id) : null;
  const waCfg = configWhatsapp();
  const link = montarLinkWhatsapp(
    cand.telefone,
    mensagemWhatsappCandidato({
      nome: cand.nome,
      vaga: (vaga && vaga.titulo) || cand.vaga_titulo,
      empresa: vaga && vaga.empresa,
      recrutador: waCfg.recrutador,
      template: waCfg.template,
    }),
  );
  // Redundante (telefone ja validado acima), mas defensivo: sem link, nao redireciona quebrado.
  if (!link) {
    return res.redirect(`/admin/candidato/${id}?erro=whatsapp_telefone`);
  }

  // Registra o 1o contato (idempotente: recliques preservam a data original).
  db.marcarContatoWhatsapp(id);
  return res.redirect(link);
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

  // Extensao REAL do arquivo em disco, nao mais fixa em .pdf — o arquivo pode ser
  // JPG/PNG/DOCX desde o Incremento 1. mimetypePorExtensao devolve octet-stream pra
  // qualquer coisa fora do mapa, em vez de mentir que e PDF.
  const extensao = path.extname(caminho).slice(1);
  const nomeArquivo = `${sanitizarNomeArquivo(`curriculo_${cand.nome || ''}_${cand.sobrenome || ''}`)}.${extensao}`;
  res.type(mimetypePorExtensao(extensao));
  res.setHeader('Content-Disposition', `attachment; filename="${nomeArquivo}"`);
  return res.sendFile(caminho);
});

// Escapa um valor para uma celula CSV: aspas duplas quando o valor contem virgula, aspas
// ou quebra de linha (dobra as aspas internas, regra padrao do formato). nome/vaga vindos
// do candidato podem legitimamente ter virgula ("Sobrenome, Jr."), entao nao dá pra confiar
// em join simples.
function celulaCsv(valor) {
  const s = String(valor == null ? '' : valor);
  return /["\n,]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}
function montarCsv(linhas) {
  return linhas.map((linha) => linha.map(celulaCsv).join(',')).join('\r\n') + '\r\n';
}

// ── GET /admin/curriculos-backup ── baixa em .tar.gz os curriculos anteriores a uma data ──
//
// /data/curriculos nao tem NENHUMA rotina de limpeza (diferente de /data/entrevistas, que
// ja tem lib/limpezaAudio.js) e cresce sem teto — 342M/647M do volume, 53%, na investigacao
// de 2026-08-20. Decisao de produto: em vez de apagar automaticamente, o Rafael baixa
// periodicamente os mais antigos que uma data e arquiva no Google Drive por conta propria,
// FORA deste sistema. Esta rota so EXPORTA — nunca apaga nada do disco.
//
// Os arquivos em /data/curriculos sao salvos como <token>.<extensao> (nome opaco, ver
// POST /api/aplicacao) — um .tar.gz cheio de tokens seria inutil pra organizar no Drive
// depois. Por isso o pacote SEMPRE inclui manifesto.csv (mapa arquivo -> candidato) e cada
// PDF entra com um nome legivel (<id>_<nome>_<sobrenome>.<extensao>), nao o token original.
router.get('/curriculos-backup', (req, res) => {
  const antes = String(req.query.antes || '').trim();
  if (!antes || !dataIsoValida(antes)) {
    return avisoAdmin(res, 400, {
      titulo: 'Data inválida',
      descricao:
        'Informe uma data no formato AAAA-MM-DD (?antes=AAAA-MM-DD) para baixar os currículos anteriores a ela.',
    });
  }

  const elegiveis = db.listarAplicacoesComCurriculoAntes(antes);
  if (!elegiveis.length) {
    return avisoAdmin(res, 200, {
      titulo: 'Nenhum currículo para exportar',
      descricao: `Não há candidaturas com currículo anteriores a ${antes}.`,
    });
  }

  let pastaTemp;
  try {
    pastaTemp = fs.mkdtempSync(path.join(os.tmpdir(), 'vm-curriculos-backup-'));
  } catch (err) {
    console.error(`[curriculos-backup] falha ao criar pasta temporaria: ${err.message}`);
    return avisoAdmin(res, 500, {
      titulo: 'Falha ao preparar o backup',
      descricao: 'Não foi possível preparar os arquivos para download. Tente novamente.',
    });
  }
  // Apagada em QUALQUER desfecho (sucesso, erro de tar, ou o "sem arquivo nenhum" abaixo) —
  // nunca deixa lixo acumulando em /tmp a cada uso desta rota.
  const limparPastaTemp = () => {
    try {
      fs.rmSync(pastaTemp, { recursive: true, force: true });
    } catch (err) {
      console.warn(`[curriculos-backup] falha ao remover pasta temporaria ${pastaTemp}: ${err.message}`);
    }
  };

  // Copia (nao symlink): um symlink dentro do tar so archivaria o link em si, nao o
  // conteudo do PDF — o pacote chegaria quebrado no Drive/na outra maquina do Rafael.
  const manifesto = [
    ['id', 'nome', 'sobrenome', 'email', 'telefone', 'vaga', 'data_candidatura', 'nome_arquivo_no_pacote'],
  ];
  for (const app of elegiveis) {
    if (!fs.existsSync(app.curriculo_path)) {
      // So warning: um arquivo faltando no disco nao pode derrubar o backup inteiro dos
      // outros — mesmo espirito defensivo de removerAudioDaEntrevista.
      console.warn(`[curriculos-backup] application ${app.id}: curriculo_path ausente no disco (${app.curriculo_path}); pulado.`);
      continue;
    }
    const extensao = path.extname(app.curriculo_path).slice(1) || 'bin';
    const nomeNoPacote = `${sanitizarNomeArquivo(`${app.id}_${app.nome || ''}_${app.sobrenome || ''}`)}.${extensao}`;
    try {
      fs.copyFileSync(app.curriculo_path, path.join(pastaTemp, nomeNoPacote));
    } catch (err) {
      console.warn(`[curriculos-backup] application ${app.id}: falha ao copiar currículo (${err.message}); pulado.`);
      continue;
    }
    manifesto.push([
      app.id,
      app.nome || '',
      app.sobrenome || '',
      app.email || '',
      app.telefone || '',
      app.vaga_titulo || '',
      app.criado_em || '',
      nomeNoPacote,
    ]);
  }

  if (manifesto.length === 1) {
    // So o cabecalho: nenhum dos elegiveis tinha arquivo de verdade no disco.
    limparPastaTemp();
    return avisoAdmin(res, 200, {
      titulo: 'Nenhum currículo para exportar',
      descricao: `Nenhum dos arquivos de currículo anteriores a ${antes} foi encontrado no disco (registro no banco sem arquivo correspondente).`,
    });
  }

  fs.writeFileSync(path.join(pastaTemp, 'manifesto.csv'), montarCsv(manifesto));

  // tar do sistema (sem dependencia nova de compressao). `-C pastaTemp .` empacota o
  // CONTEUDO da pasta (PDFs com nome legivel + manifesto.csv), nao a pasta em si.
  const tar = spawn('tar', ['-czf', '-', '-C', pastaTemp, '.'], { stdio: ['ignore', 'pipe', 'pipe'] });

  let stderrTar = '';
  tar.stderr.on('data', (chunk) => {
    stderrTar += chunk.toString();
  });

  // Guarda contra responder duas vezes (ex.: 'error' e depois 'close' do mesmo processo).
  let jaRespondeuErro = false;

  tar.on('error', (err) => {
    console.error(`[curriculos-backup] falha ao iniciar o tar: ${err.message}`);
    limparPastaTemp();
    if (!res.headersSent) {
      jaRespondeuErro = true;
      avisoAdmin(res, 500, {
        titulo: 'Falha ao gerar o backup',
        descricao: 'Não foi possível gerar o pacote de currículos (compactador indisponível no servidor).',
      });
    } else {
      res.destroy();
    }
  });

  tar.on('close', (code) => {
    limparPastaTemp();
    if (code === 0 || jaRespondeuErro) return;
    console.error(`[curriculos-backup] tar terminou com código ${code}: ${stderrTar}`);
    if (!res.headersSent) {
      avisoAdmin(res, 500, {
        titulo: 'Falha ao gerar o backup',
        descricao: 'Houve um erro ao compactar os currículos. Tente novamente.',
      });
    } else {
      // Streaming ja comecou (Content-Type/parte do gzip ja foram pro cliente) — nao da
      // pra mandar uma pagina de erro depois disso. So encerra a conexao.
      res.destroy();
    }
  });

  const nomeArquivo = `curriculos-backup-ate-${antes}.tar.gz`;
  res.setHeader('Content-Type', 'application/gzip');
  res.setHeader('Content-Disposition', `attachment; filename="${nomeArquivo}"`);
  tar.stdout.pipe(res);
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

// ── POST /admin/candidato/:id/reprocessar ── nova tentativa de avaliacao ──
// Promove para o painel o que antes exigia `node -e` via shell: reinvoca gerarRelatorio
// sobre uma entrevista JA concluida (a transcricao continua salva; nada e re-entrevistado).
// Sem auth propria — herda o adminAuth do router.use, igual as demais rotas daqui.
//
// Fire-and-forget, espelhando finalizarEntrevista: a avaliacao leva ~18s (ate 120s no
// timeout) e prender a resposta HTTP tanto tempo daria uma aba travada sem retorno. O
// recrutador ve o badge "Avaliando…" (status_ia='processando', que ja existia) e atualiza
// a pagina. Nenhum estado ou tela nova.
router.post('/candidato/:id/reprocessar', (req, res) => {
  const id = Number(req.params.id);
  const cand = Number.isInteger(id) && id > 0 ? db.obterAplicacao(id) : null;
  const ehJson = String(req.get('x-requested-with') || '').toLowerCase() === 'fetch';

  if (!cand) {
    if (ehJson) {
      return res.status(404).json({ ok: false, erro: 'Candidato não encontrado.' });
    }
    return avisoAdmin(res, 404, {
      titulo: 'Candidato não encontrado',
      descricao: 'Não há candidatura com este identificador.',
    });
  }

  // Estado RECARREGADO do banco. Nada vindo do formulario e considerado: a pagina pode
  // estar velha (o relatorio ficou pronto entre o render e o clique) ou forjada.
  const ultimaInterview = db.obterUltimaInterviewPorAplicacao(cand.id);
  const interviewId = ultimaInterview ? ultimaInterview.id : null;
  const report = interviewId ? db.obterReportPorInterview(interviewId) : null;
  const { podeReprocessar } = estadoBotoesRelatorio(cand, interviewId, report);

  if (!podeReprocessar) {
    if (ehJson) {
      return res.status(409).json({
        ok: false,
        erro: 'Não há o que reprocessar: já existe relatório ou uma reavaliação está em andamento.',
      });
    }
    return res.redirect(`/admin/candidato/${id}?erro=reprocessar_estado`);
  }

  // Lock ANTES de qualquer trabalho assincrono: a partir daqui, uma segunda requisicao
  // (duplo clique, dois recrutadores) reprova em estadoBotoesRelatorio e cai no 409.
  reprocessamentosEmCurso.set(interviewId, Date.now());
  db.definirStatusIa(cand.id, 'processando');

  // require tardio: mantem o modulo substituivel nos testes (que trocam gerarRelatorio por
  // um fake) e evita carregar a cadeia do LLM no boot de quem so serve paginas.
  const { gerarRelatorio } = require('../lib/relatorio');
  gerarRelatorio(interviewId)
    .catch((err) => {
      console.error(
        `[admin] falha ao reprocessar o relatorio da entrevista ${interviewId}: ${err.message}`,
      );
      // gerarRelatorio ja persiste a linha de erro em reports, mas o status_ia so sai de
      // 'processando' aqui — sem isto o candidato ficaria preso no badge "Avaliando…".
      db.definirStatusIa(cand.id, 'erro');
    })
    .finally(() => {
      reprocessamentosEmCurso.delete(interviewId);
    });

  if (ehJson) {
    return res.json({ ok: true, status: 'processando' });
  }
  return res.redirect(`/admin/candidato/${id}?ok=reprocessando`);
});

// ── POST /admin/candidato/:id/status-recrutador ── registra a decisao humana ──
// Enum validado na camada de dados (definirStatusRecrutador): valor fora do enum
// (incluindo '' = "Sem decisao") grava null. Mesmo padrao de id/404 das rotas vizinhas.
//
// DUAS respostas para o MESMO trabalho, decididas pelo header X-Requested-With: fetch
// (escolhido por ser impossivel de um <form> classico mandar por acidente — diferente de
// Accept, que numa navegacao normal vem com */* e confundiria os dois casos):
//   com o header  -> JSON { ok: true, status_recrutador } | { ok: false, erro } (edicao
//                    inline da lista; nunca redireciona)
//   sem o header  -> redirect de sempre (form classico da tela de detalhe, intacto)
router.post('/candidato/:id/status-recrutador', (req, res) => {
  const id = Number(req.params.id);
  const cand = Number.isInteger(id) && id > 0 ? db.obterAplicacao(id) : null;
  const ehJson = String(req.get('x-requested-with') || '').toLowerCase() === 'fetch';

  if (!cand) {
    if (ehJson) {
      return res.status(404).json({ ok: false, erro: 'Candidato não encontrado.' });
    }
    return avisoAdmin(res, 404, {
      titulo: 'Candidato não encontrado',
      descricao: 'Não há candidatura com este identificador.',
    });
  }

  const valor = (req.body && req.body.status_recrutador) || null;
  // definirStatusRecrutador devolve o valor FINAL gravado (null quando fora do enum) —
  // e ele que volta no JSON, para a lista refletir o que o banco tem, nao o que pediu.
  const gravado = db.definirStatusRecrutador(id, valor);
  if (ehJson) {
    return res.json({ ok: true, status_recrutador: gravado });
  }
  return res.redirect(`/admin/candidato/${id}?ok=status_recrutador`);
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

// Reconstroi a query string dos filtros da listagem (busca/status/de/ate/vaga), saneada,
// para preservar o contexto ao redirecionar. Serve tanto para req.query quanto para
// req.body.
function paramsFiltros(src = {}) {
  const p = new URLSearchParams();
  // Busca vazia nao vai para a URL: '?q=' sujaria o endereco sem significar nada
  // (mesma logica da visibilidade 'ativos' la embaixo).
  const busca = sanearBusca(src.q);
  if (busca) p.set('q', busca);
  if (['aplicado', 'em_entrevista', 'concluido'].includes(src.status)) p.set('status', src.status);
  if (STATUS_IA_VALIDOS.includes(src.status_ia)) p.set('status_ia', src.status_ia);
  // Status Recrutador: nos FORMS o filtro viaja como filtro_status_recrutador, porque
  // 'status_recrutador' ali e o valor da acao em massa (outro significado). Na query
  // string o nome e o curto. Preferimos o explicito quando ele existe — assim aplicar
  // status em lote NUNCA e confundido com filtrar por status.
  const recrutadorBruto =
    src.filtro_status_recrutador != null ? src.filtro_status_recrutador : src.status_recrutador;
  if (STATUS_RECRUTADOR_FILTRAVEIS.includes(recrutadorBruto)) {
    p.set('status_recrutador', String(recrutadorBruto));
  }
  const ehData = (v) => /^\d{4}-\d{2}-\d{2}$/.test(String(v || ''));
  if (ehData(src.de)) p.set('de', String(src.de));
  if (ehData(src.ate)) p.set('ate', String(src.ate));
  const vn = Number(src.vaga);
  if (Number.isInteger(vn) && vn > 0) p.set('vaga', String(vn));
  // Origem: saneamento FROUXO aqui (string nao-vazia, aparada e com teto), porque a
  // allowlist verdadeira vem do banco (listarOrigensDistintas) e esta funcao roda em
  // redirects de POST, onde nao vale abrir consulta so para montar uma URL. Uma origem
  // invalida que sobreviva ate aqui e descartada na entrada do GET /admin, que revalida
  // contra a lista real — no pior caso a tela volta com "Todas".
  if (typeof src.origem === 'string' && src.origem.trim()) {
    p.set('origem', src.origem.trim().slice(0, MAX_BUSCA));
  }
  // `pagina` NAO entra: paramsFiltros existe para os redirects DEPOIS de uma acao
  // (arquivar/restaurar/status em lote, salvar colunas), e essas acoes podem esvaziar
  // justamente a pagina que estava aberta — arquivar os 25 itens da pagina 3 devolveria
  // o recrutador para uma pagina em branco. Sem o parametro, o GET cai no default 1.
  // Os links de navegacao entre paginas setam `pagina` por conta propria, depois daqui.
  // Visibilidade de arquivados: 'ativos' e o default, entao nao precisa viajar na URL.
  if (src.visibilidade === 'arquivados' || src.visibilidade === 'todos') {
    p.set('visibilidade', String(src.visibilidade));
  }
  return p;
}

// ── POST /admin/candidatos/arquivar-lote ── soft-delete em lote a partir da selecao ──
// Recebe ids (array; um checkbox por lead). Saneia para inteiros positivos unicos,
// ignorando invalidos em silencio. Reaproveita arquivarAplicacao (nao duplica a logica
// de soft-delete). Preserva os filtros de origem no redirect. Defensivo: leads ja
// arquivados retornam 0 alteracoes e nao sao recontados.
router.post('/candidatos/arquivar-lote', (req, res) => {
  const brutos = req.body && req.body.ids;
  const lista = Array.isArray(brutos) ? brutos : brutos != null ? [brutos] : [];
  const ids = [];
  for (const v of lista) {
    const n = Number(v);
    if (Number.isInteger(n) && n > 0 && !ids.includes(n)) ids.push(n);
  }

  const params = paramsFiltros(req.body);
  if (!ids.length) {
    params.set('sem_selecao', '1');
    return res.redirect(`/admin?${params.toString()}`);
  }

  let arquivados = 0;
  for (const id of ids) arquivados += db.arquivarAplicacao(id); // 0 se ja arquivado / inexistente
  params.set('arquivados', String(arquivados));
  return res.redirect(`/admin?${params.toString()}`);
});

// ── POST /admin/candidatos/restaurar-lote ── reverte o soft-delete em lote ──
// Mesma anatomia de arquivar-lote: saneia ids (inteiros positivos unicos, invalidos
// ignorados em silencio), reconstroi os filtros com paramsFiltros (inclusive a
// visibilidade, para o recrutador continuar na visao "Arquivados" de onde agiu) e volta
// por redirect com flash.
//
// Diferenca de contagem: arquivarAplicacao tem "AND deleted_at IS NULL" e devolve 0 para
// quem ja estava arquivado, entao la basta somar o retorno. restaurarAplicacao NAO tem a
// guarda simetrica — o UPDATE casa com a linha mesmo ja ativa e devolve 1. Somar direto
// contaria ativos como "restaurados". Por isso confirmamos deleted_at antes: restaurar um
// candidato ativo continua sendo inofensivo (no-op), so nao entra no numero do aviso.
router.post('/candidatos/restaurar-lote', (req, res) => {
  const brutos = req.body && req.body.ids;
  const lista = Array.isArray(brutos) ? brutos : brutos != null ? [brutos] : [];
  const ids = [];
  for (const v of lista) {
    const n = Number(v);
    if (Number.isInteger(n) && n > 0 && !ids.includes(n)) ids.push(n);
  }

  const params = paramsFiltros(req.body);
  if (!ids.length) {
    params.set('sem_selecao', '1');
    return res.redirect(`/admin?${params.toString()}`);
  }

  let restaurados = 0;
  for (const id of ids) {
    const cand = db.obterAplicacao(id);
    if (!cand || !cand.deleted_at) continue; // inexistente ou ja ativo: nada a fazer
    restaurados += db.restaurarAplicacao(id);
  }
  params.set('restaurados', String(restaurados));
  return res.redirect(`/admin?${params.toString()}`);
});

// ── POST /admin/candidatos/status-recrutador-lote ── decisao do recrutador em lote ──
// Mesma anatomia de arquivar-lote: saneia ids (inteiros positivos unicos, invalidos
// ignorados em silencio), reconstroi os filtros de origem com paramsFiltros e volta por
// redirect com flash na query string. O valor vem do <select> do MESMO form da listagem
// (submetido por formaction), entao os hidden de filtro sao reaproveitados.
//
// Enum validado na camada de dados (definirStatusRecrutador): valor fora de
// aprovado/reprovado/em_analise vira null. String vazia e uma intencao VALIDA aqui
// ("Sem decisao" = limpar a decisao) — por isso a guarda abaixo testa AUSENCIA do campo,
// nao valor vazio: sem o campo no corpo nao ha intencao explicita e nada e aplicado.
router.post('/candidatos/status-recrutador-lote', (req, res) => {
  const brutos = req.body && req.body.ids;
  const lista = Array.isArray(brutos) ? brutos : brutos != null ? [brutos] : [];
  const ids = [];
  for (const v of lista) {
    const n = Number(v);
    if (Number.isInteger(n) && n > 0 && !ids.includes(n)) ids.push(n);
  }

  const params = paramsFiltros(req.body);

  const valor = req.body ? req.body.status_recrutador : undefined;
  if (valor == null) {
    params.set('sem_status', '1');
    return res.redirect(`/admin?${params.toString()}`);
  }

  if (!ids.length) {
    params.set('sem_selecao', '1');
    return res.redirect(`/admin?${params.toString()}`);
  }

  // Conta so os ids que existem de fato (defensivo, mesmo espirito do 0-changes do
  // arquivar-lote): id forjado nao infla o numero do aviso.
  let aplicados = 0;
  for (const id of ids) {
    if (!db.obterAplicacao(id)) continue;
    db.definirStatusRecrutador(id, valor);
    aplicados += 1;
  }
  params.set('status_recrutador_aplicados', String(aplicados));
  return res.redirect(`/admin?${params.toString()}`);
});

// ── POST /admin/colunas-candidatos ── salva quais colunas da lista ficam visiveis ──
// Recebe `colunas` (um valor por checkbox marcado). Filtra contra as chaves conhecidas de
// COLUNAS_CANDIDATOS — chave desconhecida e ignorada em SILENCIO (nao 400: e preferencia
// de UI, nao dado de negocio). Nenhum checkbox marcado grava '[]', um estado valido (so
// as colunas fixas), diferente de "nunca salvou" (chave ausente -> default). Persistido
// como JSON no store generico de configuracoes; nao ha mudanca de schema.
router.post('/colunas-candidatos', (req, res) => {
  const brutos = req.body && req.body.colunas;
  const lista = Array.isArray(brutos) ? brutos : brutos != null ? [brutos] : [];
  const escolhidas = [];
  for (const v of lista) {
    const chave = String(v);
    const conhecida = COLUNAS_CANDIDATOS.some((col) => col.chave === chave);
    if (conhecida && !escolhidas.includes(chave)) escolhidas.push(chave);
  }

  db.definirConfig(CHAVE_COLUNAS_CANDIDATOS, JSON.stringify(escolhidas));

  // Filtros ativos: preferencia para os hidden do proprio form (corpo); a query string
  // entra como fallback. paramsFiltros revalida tudo dos dois jeitos.
  const params = paramsFiltros({ ...(req.query || {}), ...(req.body || {}) });
  const qs = params.toString();
  return res.redirect(qs ? `/admin?${qs}` : '/admin');
});

// ── Carga dos dados do relatorio ──
// Fonte UNICA das duas rotas de relatorio (pagina HTML e download em PDF): as mesmas
// queries, na mesma ordem, com o mesmo criterio de indisponibilidade. Extraido para que
// o PDF nunca mostre um conjunto de dados diferente do que a tela mostra.
// Devolve null quando nao ha entrevista ou nao ha report — cada rota decide como responder.
function carregarRelatorio(interviewIdBruto) {
  const interviewId = Number(interviewIdBruto);
  const interview = Number.isFinite(interviewId) ? db.obterInterview(interviewId) : null;
  const report = interview ? db.obterReportPorInterview(interviewId) : null;
  if (!interview || !report) return null;

  const candidato = db.obterAplicacao(interview.application_id);
  const vaga = candidato ? db.obterVaga(candidato.job_id) : null;
  const perfil = (vaga && vaga.perfil) || interview.perfil || '—';
  const turns = db.listarTurnos(interviewId);
  const roteiro = interview.roteiro_id ? db.obterRoteiro(interview.roteiro_id) : null;

  // Score ponderado calculado on-the-fly (sem coluna no banco).
  const geral = calcularPontuacaoGeral(report.pontuacoes, roteiro);

  return { interviewId, interview, report, candidato, vaga, perfil, turns, roteiro, geral };
}

// Pagina 404 compartilhada pelas duas rotas de relatorio.
function respostaRelatorioIndisponivel(res) {
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

// ── GET /admin/relatorio/:interviewId ── relatorio individual ──
router.get('/relatorio/:interviewId', (req, res) => {
  const dados = carregarRelatorio(req.params.interviewId);
  if (!dados) return respostaRelatorioIndisponivel(res);

  const { interviewId, interview, report, candidato, vaga, perfil, turns, geral } = dados;

  // Pontuacoes (array de { competencia, nota, justificativa, coberta }) — coberta vem
  // de dentro do JSON, nao de coluna.
  const comps = (report.pontuacoes || [])
    .map((p) => {
      const off = p.coberta === false;
      // Item 7.6: nivel Alta/Média/Baixa (retrocompat: nota legada "N/5"), via helper unico.
      const nota = escapeHtml(rotuloNivel(p));
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

  // Item 7.6 — Requisitos obrigatorios (gate must-have). Omitido inteiro quando vazio.
  const requisitos = Array.isArray(report.requisitos) ? report.requisitos : [];
  const requisitosHtml = requisitos
    .map(
      (r) => `
        <div class="comp">
          <div class="comp-cab">
            <h3 style="margin:0;">${escapeHtml(r.requisito || '')}</h3>
            ${badgeVereditoHtml(r.veredito)}
          </div>
          ${
            r.evidencia
              ? `<p style="margin:.4rem 0 0;color:var(--cinza);font-style:italic;">&ldquo;${escapeHtml(r.evidencia)}&rdquo;</p>`
              : ''
          }
        </div>`,
    )
    .join('');

  const itens = (lista) => (lista || []).map((i) => `<li>${escapeHtml(i)}</li>`).join('');
  const fortes = itens(report.destaque_pontos_fortes);
  // Item 7.6 — Gaps com mitigacao: textoGap normaliza string (legado) e { risco, mitigacao }.
  const atencao = (report.destaque_atencao || [])
    .map((g) => {
      const { risco, mitigacao } = textoGap(g);
      if (!risco && !mitigacao) return '';
      return `<li><strong>${escapeHtml(risco)}</strong>${
        mitigacao ? `<br><span style="color:var(--cinza);">Mitigação: ${escapeHtml(mitigacao)}</span>` : ''
      }</li>`;
    })
    .filter(Boolean)
    .join('');

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
    <div class="acoes-linha" style="flex-wrap:wrap;gap:.6rem;margin-bottom:1rem;">
      <a class="btn btn--ghost" href="/admin">← Voltar ao painel</a>
      <a class="btn" href="/admin/relatorio/${interviewId}/pdf">Baixar PDF</a>
    </div>

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

    ${
      requisitos.length
        ? `<section class="rel-sec">
            <h2>Requisitos obrigatórios</h2>
            ${requisitosHtml}
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

// ── GET /admin/relatorio/:interviewId/pdf ── mesmo relatorio, para download ──
// Reusa carregarRelatorio (mesmas queries da pagina HTML) e o mesmo 404. GET porque
// gerar o PDF e idempotente e sem efeito colateral — diferente das acoes de escrita do
// painel, que sao POST de proposito. Auth herdada do router.use(adminAuth).
router.get('/relatorio/:interviewId/pdf', (req, res) => {
  const dados = carregarRelatorio(req.params.interviewId);
  if (!dados) return respostaRelatorioIndisponivel(res);

  const { interviewId, interview, report, candidato, vaga, turns, roteiro, geral } = dados;
  const arquivo = `relatorio-${slugNome(nomeCompleto(candidato || {}))}-${interviewId}.pdf`;

  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename="${arquivo}"`);

  // O modulo monta o documento e devolve sem fechar; o pipe/end e responsabilidade daqui.
  const doc = gerarRelatorioPdf({ interview, report, candidato, vaga, turns, roteiro, geral });
  doc.pipe(res);
  doc.end();
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
  // Vaga (Item 2 do ETAPA B "Ajustes no Admin"): id inteiro positivo; vazio = todas.
  // Mesmo saneamento do filtro de vaga na lista de candidatos (admin.js, GET /admin).
  const vagaIdNum = Number(req.query.vaga);
  const vagaId = Number.isInteger(vagaIdNum) && vagaIdNum > 0 ? vagaIdNum : '';
  // Pagina da tabela "Origem dos leads" (5 em 5, db.ORIGENS_POR_PAGINA). Nome distinto de
  // qualquer outro parametro desta tela para nao colidir na querystring do dashboard.
  const paginaOrigemNum = Number(req.query.pagina_origem);
  const paginaOrigem = Number.isInteger(paginaOrigemNum) && paginaOrigemNum > 0 ? paginaOrigemNum : 1;

  const erros = [];
  if (desde && !dataIsoValida(desde)) erros.push('Data inicial inválida. Use o formato AAAA-MM-DD.');
  if (ate && !dataIsoValida(ate)) erros.push('Data final inválida. Use o formato AAAA-MM-DD.');
  const temErro = erros.length > 0;

  // So consulta com datas validas; com erro, mantem a pagina de pe (form + aviso).
  // O filtro de vaga (jobId) afeta as DUAS tabelas — funil "Por vaga" e "Origem dos leads".
  const funil = temErro
    ? { vagas: [], totais: { acessos: 0, aplicacoes: 0, entrevistas_realizadas: 0, pre_aprovados: 0 } }
    : db.obterFunilConversao({ desde: desde || undefined, ate: ate || undefined, jobId: vagaId || undefined });

  // Origem dos leads (B2): mesmo recorte de periodo e vaga do funil (reusa desde/ate/vagaId
  // ja validados/saneados acima).
  const origem = temErro
    ? { origens: [], totais: { acessos: 0, aplicacoes: 0, entrevistas_realizadas: 0, pre_aprovados: 0 }, totalOrigens: 0 }
    : db.obterOrigemLeads({
        desde: desde || undefined,
        ate: ate || undefined,
        jobId: vagaId || undefined,
        pagina: paginaOrigem,
      });
  const totalPaginasOrigem = Math.max(1, Math.ceil(origem.totalOrigens / db.ORIGENS_POR_PAGINA));

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

  // Linhas do quadro de origem (mesma linguagem visual da tabela "Por vaga"). O rotulo
  // da origem ja vem bucketizado da camada de dados ('Direto'/'Sem origem'/valor cru);
  // passa por escapeHtml porque origens nomeadas sao dado externo (querystring da campanha).
  const linhasOrigem = origem.origens
    .map((o) => {
      const zero =
        !o.acessos && !o.aplicacoes && !o.entrevistas_realizadas && !o.pre_aprovados;
      return `
        <tr class="${zero ? 'linha-zero' : ''}">
          <td>${escapeHtml(o.origem || '—')}</td>
          <td class="col-num">${fmtInt(o.acessos)}</td>
          <td class="col-num">${fmtInt(o.aplicacoes)}</td>
          <td class="col-num">${taxaConversao(o.aplicacoes, o.acessos)}</td>
          <td class="col-num">${fmtInt(o.entrevistas_realizadas)}</td>
          <td class="col-num">${taxaConversao(o.entrevistas_realizadas, o.aplicacoes)}</td>
          <td class="col-num">${fmtInt(o.pre_aprovados)}</td>
          <td class="col-num">${taxaConversao(o.pre_aprovados, o.entrevistas_realizadas)}</td>
        </tr>`;
    })
    .join('');

  const temFiltro = desde || ate || vagaId;
  const resumoPeriodo = temErro
    ? ''
    : temFiltro
      ? `Período: ${escapeHtml(desde || '…')} até ${escapeHtml(ate || '…')}`
      : 'Período: todo o histórico';

  // <select> de vaga: mesma fonte e mesmo padrao de opcoesVaga da lista de candidatos
  // (admin.js, GET /admin) — populado por db.listarVagas(), uma consulta so.
  const opcoesVagaDashboard = db
    .listarVagas()
    .map(
      (v) =>
        `<option value="${v.id}"${String(vagaId) === String(v.id) ? ' selected' : ''}>${escapeHtml(v.titulo || `Vaga ${v.id}`)}</option>`,
    )
    .join('');

  // ── Paginacao da tabela "Origem dos leads" ── mesmo padrao visual da lista de
  // candidatos (admin.js, linkPagina/paginacao), so trocando o parametro de pagina e
  // preservando desde/ate/vaga (os filtros desta tela).
  const linkPaginaOrigem = (n) => {
    const p = new URLSearchParams();
    if (desde) p.set('desde', desde);
    if (ate) p.set('ate', ate);
    if (vagaId) p.set('vaga', String(vagaId));
    p.set('pagina_origem', String(n));
    return `/admin/dashboard?${p.toString()}`;
  };
  const paginacaoOrigem =
    totalPaginasOrigem > 1 || paginaOrigem > 1
      ? `
      <nav class="admin-paginacao" aria-label="Paginação da tabela Origem dos leads">
        ${
          paginaOrigem > 1
            ? `<a class="btn btn--ghost" rel="prev" href="${linkPaginaOrigem(Math.min(paginaOrigem - 1, totalPaginasOrigem))}">← Anterior</a>`
            : '<span class="btn btn--off">← Anterior</span>'
        }
        <span>Página <b>${paginaOrigem}</b> de <b>${totalPaginasOrigem}</b></span>
        ${
          paginaOrigem < totalPaginasOrigem
            ? `<a class="btn btn--ghost" rel="next" href="${linkPaginaOrigem(paginaOrigem + 1)}">Próxima →</a>`
            : '<span class="btn btn--off">Próxima →</span>'
        }
      </nav>`
      : '';

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
      <label class="filtro">
        <span>Vaga</span>
        <select name="vaga">
          <option value=""${vagaId ? '' : ' selected'}>Todas</option>
          ${opcoesVagaDashboard}
        </select>
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
    </section>

    <section class="rel-sec">
      <h2>Origem dos leads</h2>
      <p class="admin-sub" style="color:var(--cinza);font-size:.85rem;margin:.2rem 0 1rem;">
        A atribuição de origem passou a ser registrada a partir da ativação do rastreio de
        UTM. Candidaturas anteriores, ou visitas sem parâmetro de campanha, aparecem como
        <b>Direto</b> (sem UTM no momento da candidatura) ou <b>Sem origem</b> (acesso sem
        UTM ou anterior ao rastreio).
      </p>
      <div class="admin-tab-scroll">
        <table class="admin-tab">
          <thead>
            <tr>
              <th>Origem</th>
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
            ${linhasOrigem || `<tr><td colspan="8">${temErro ? 'Corrija as datas para ver os dados.' : 'Nenhum lead registrado ainda.'}</td></tr>`}
          </tbody>
        </table>
      </div>
      ${paginacaoOrigem}
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
// Cidade usa o MESMO shape [value, rotulo] dos dois acima, mas a lista NAO mora aqui: ela
// vem de lib/cidades, porque o formulario e so um dos tres consumidores (os outros sao o
// normalizador e o prompt do import por briefing). Value igual ao rotulo — o que se guarda
// e o proprio nome canonico da praca, nao um codigo.
//
// FUNCAO, e nao constante de modulo (diferente de PERFIS_VALIDOS/MODALIDADES/REGIMES
// acima): desde a migracao de CIDADES_VALIDAS para tabela (ETAPA B, Incremento 4),
// listarCidadesValidas() consulta o banco a cada chamada. Calcular isto UMA vez, no
// require() do arquivo, congelaria o dropdown no estado do banco no momento do boot — uma
// cidade cadastrada pelo admin (Incremento 5) so apareceria depois de reiniciar o processo,
// que e o oposto do objetivo. Chamada de dentro de camposVagaHtml, a cada render do form.
function opcoesCidade() {
  return listarCidadesValidas().map((c) => [c, c]);
}

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

// Item 8 — normaliza o campo de video introdutorio (YouTube) do form da vaga.
//   - vazio                 -> limpa (tipo/ref = null); remover o video e uma acao valida.
//   - link/ID valido        -> tipo 'youtube' + ID CANONICO (extraido de URL ou ID puro).
//   - preenchido mas invalido-> NAO sobrescreve: mantem o valor ANTERIOR da vaga (na edicao)
//     ou fica null (na criacao, sem valor anterior).
// LIMITACAO CONHECIDA: o form de vaga nao tem hoje um padrao de erro POR-CAMPO (so o
// titulo vazio tem mensagem). Entao uma entrada invalida aqui e ignorada sem travar o
// save dos demais campos; o handler sinaliza isso de forma NAO bloqueante via ?aviso=video
// (a vaga ainda salva). Ate existir um padrao de erro por-campo no admin, este e o
// comportamento: preservar o valido anterior e avisar sem bloquear.
function lerVideoIntro(b, vagaAnterior) {
  const bruto = String((b && b.video_intro_ref) || '').trim();
  if (!bruto) return { video_intro_tipo: null, video_intro_ref: null };
  const id = extrairYoutubeId(bruto);
  if (id) return { video_intro_tipo: 'youtube', video_intro_ref: id };
  return {
    video_intro_tipo: vagaAnterior ? vagaAnterior.video_intro_tipo || null : null,
    video_intro_ref: vagaAnterior ? vagaAnterior.video_intro_ref || null : null,
  };
}

// True quando o usuario digitou algo no campo de video mas nao foi possivel extrair um ID
// (usado pelo handler para o aviso nao-bloqueante, sem duplicar a regra de extracao).
function videoIntroInvalido(b) {
  const bruto = String((b && b.video_intro_ref) || '').trim();
  return Boolean(bruto) && !extrairYoutubeId(bruto);
}

// Le do corpo do POST os campos ricos (compartilhado entre criar e editar). Arrays
// "um item por linha" via arrayDeLinhas (declarado adiante; hoisted); potencial_ganhos
// e texto livre; secoes_extras usa o parser proprio acima. vagaAnterior (opcional, so na
// edicao) permite preservar o video valido anterior quando a nova entrada e invalida.
function lerCamposRicos(b, vagaAnterior = null) {
  // modalidade/regime so valem se baterem com as opcoes conhecidas; senao ficam vazios.
  const modalidade = MODALIDADES.some(([v]) => v === b.modalidade) ? b.modalidade : '';
  const regime = REGIMES.some(([v]) => v === b.regime) ? b.regime : '';
  return {
    potencial_ganhos: String(b.potencial_ganhos || '').trim(),
    endereco: String(b.endereco || '').trim(),
    // Praca da vaga. Guarda NULL (e nao '') quando vazia ou fora da lista: aqui NULL tem
    // significado — "esta vaga nao tem praca", que e o caso legitimo da vaga remota — e um
    // filtro por cidade precisa distinguir isso de string vazia. Os dois vizinhos usam ''
    // porque nasceram assim; a coluna nova nao herda o defeito.
    //
    // A validacao vem de normalizarCidade, e nao de um `CIDADES.some(...)` como modalidade
    // e regime fazem logo acima. A diferenca importa: aquele compara byte a byte e
    // recusaria "Sao Paulo" sem acento; este mapeia ao canonico. Como o mesmo campo tambem
    // e preenchido pelo LLM do import por briefing, tolerar a grafia sem acento e o que
    // impede um til virar ausencia de dado.
    cidade: normalizarCidade(b.cidade),
    modalidade,
    regime,
    horario: String(b.horario || '').trim(),
    // Item 7.4 — cultura/rotinas da empresa (contexto da pergunta de Principios).
    cultura_empresa: String(b.cultura_empresa || '').trim(),
    // Item 7.6 — requisitos obrigatorios (must-have) da vaga, um por linha.
    requisitos_obrigatorios: arrayDeLinhas(b.requisitos_obrigatorios),
    skills: arrayDeLinhas(b.skills),
    beneficios: arrayDeLinhas(b.beneficios),
    atividades: arrayDeLinhas(b.atividades),
    requisitos: arrayDeLinhas(b.requisitos),
    secoes_extras: parseSecoesExtras(b.secoes_extras),
    // Item 8 — video introdutorio (tipo + ref canonico); ver lerVideoIntro.
    ...lerVideoIntro(b, vagaAnterior),
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
// `cidadeCadastroAction`/`cidadeCadastroHidden`: para onde o mini-form do `<details>` de
// "cadastrar cidade nova" (ETAPA B, Incremento 3) submete, e os hidden inputs que ele leva
// junto. NAO reusamos `perfilEditavel` para decidir isso (ETAPA A apontou o risco: e um
// flag que significa outra coisa — se um dia existir edicao com perfil editavel, os dois
// se descolam e um vira bug silencioso do outro). Cada CHAMADOR (htmlNovaVaga / GET
// /vagas/:id) monta esses dois valores porque so ele sabe o contexto real: criacao aponta
// para /admin/vagas/cidades com os hidden de retomar_vaga; edicao aponta para
// /admin/vagas/:id/cidades sem hidden nenhum (a vaga ja tem id estavel).
function camposVagaHtml(vaga, { perfilEditavel, cidadeCadastroAction, cidadeCadastroHidden = '' }) {
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

    <label class="campo">
      <span>Empresa (cliente)</span>
      <input type="text" name="empresa" value="${escapeHtml(vaga.empresa || '')}" placeholder="Ex.: Acme Ltda">
    </label>
    <p style="color:var(--cinza);font-size:.8rem;margin:-.5rem 0 1.2rem;">
      Nome da empresa dona da vaga. Usado na mensagem de WhatsApp ao candidato. Deixe vazio para omitir.</p>

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
      <span>Cidade (praça)</span>
      <select name="cidade">${opcoesSelect(vaga.cidade, opcoesCidade())}</select>
      <small style="color:var(--cinza);font-size:.8rem">
        Usada para recortar a base por região. Deixe em branco para vaga remota —
        o endereço acima continua sendo o texto exibido na página da vaga.
      </small>
    </label>
    <details style="margin:-.6rem 0 1.2rem;">
      <summary style="cursor:pointer;color:var(--cinza);font-size:.85rem;">+ Cadastrar cidade nova</summary>
      <form method="POST" action="${cidadeCadastroAction}" style="display:flex;gap:.5rem;flex-wrap:wrap;align-items:flex-end;margin-top:.6rem;">
        ${cidadeCadastroHidden}
        <label class="campo" style="margin:0;min-width:14rem;">
          <span>Nome da cidade</span>
          <input type="text" name="nome_cidade" placeholder="Ex.: Belo Horizonte">
        </label>
        <label class="campo" style="margin:0;flex:1;min-width:16rem;">
          <span>Link do grupo de WhatsApp desta praça (opcional)</span>
          <input type="text" name="link_grupo_whatsapp" placeholder="https://chat.whatsapp.com/...">
        </label>
        <button type="submit" class="btn btn--ghost">Cadastrar cidade</button>
      </form>
      <p style="color:var(--cinza);font-size:.78rem;margin:.35rem 0 0;">
        Sem link, campanhas de convite de grupo para essa praça vão falhar até isso ser
        cadastrado depois.</p>
    </details>

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
      <span>Requisitos obrigatórios (opcional, um por linha)</span>
      <textarea name="requisitos_obrigatorios" rows="5">${escapeHtml(linhasDeArray(vaga.requisitos_obrigatorios))}</textarea>
    </label>
    <p style="color:var(--cinza);font-size:.8rem;margin:-.5rem 0 1.2rem;">
      Requisitos que descartam o candidato se não atendidos — diferente de skills
      desejáveis. A IA avalia cada um (atende / parcial / não atende) com evidência da
      entrevista.</p>

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

    <label class="campo">
      <span>Cultura e rotinas da empresa (opcional)</span>
      <textarea name="cultura_empresa" rows="4">${escapeHtml(vaga.cultura_empresa || '')}</textarea>
    </label>
    <p style="color:var(--cinza);font-size:.8rem;margin:-.5rem 0 1.2rem;">
      Rotinas do dia a dia que a Vera usa como contexto na pergunta de Princípios (ex.:
      reunião diária às 8h com oração, dress code formal). Não aparece na página pública.</p>

    <label class="campo">
      <span>Vídeo introdutório da vaga (opcional)</span>
      <input type="text" name="video_intro_ref" value="${escapeHtml(vaga.video_intro_ref || '')}"
        placeholder="Link do YouTube (não listado) ou ID do vídeo">
    </label>
    <p style="color:var(--cinza);font-size:.8rem;margin:-.5rem 0 1.2rem;">
      Vídeo institucional de 2-3 min (empresa, salário, remuneração), exibido ao candidato
      antes das permissões de câmera/microfone. Use um vídeo do YouTube configurado como
      <b>“não listado”</b> (não use <b>“privado”</b>, que não pode ser incorporado). Aceita o
      link completo ou só o ID — guardamos o ID. Deixe vazio para pular esta etapa.</p>

    <label class="campo-check">
      <input type="checkbox" name="ativo" value="1"${vaga.ativo ? ' checked' : ''}>
      <span style="color:var(--preto);text-transform:none;">Vaga ativa</span>
    </label>

    <label class="campo-check">
      <input type="checkbox" name="entrevista_ativa" value="1"${vaga.entrevista_ativa !== 0 ? ' checked' : ''}>
      <span style="color:var(--preto);text-transform:none;">Entrevista automática (modo Completo)</span>
    </label>
    <p style="color:var(--cinza);font-size:.8rem;margin:-.5rem 0 1.2rem;">
      Marcada: o candidato passa pela entrevista com a Vera (fluxo completo). Desmarcada:
      modo Simples — só confirmação + botão de WhatsApp, sem entrevista. Só tem efeito
      quando a <b>Entrevista automática (geral)</b> está ligada em Configurações.</p>`;
}

// Mini-formulario para corrigir o slug de uma vaga ja criada (POST /vagas/:id/slug,
// Incremento 1). Separado do form geral da vaga de proposito — mesma razao de
// atualizarSlugVaga ser funcao a parte em sqlite.js: e uma acao distinta, com botao e
// confirmacao proprios, nao mais um campo do formulario grande. O confirm() usa aspas
// curvas (“ ”) em vez de aspas retas dentro da mensagem para nao colidir com as aspas
// simples que ja delimitam a string do onsubmit (mesmo padrao de confirm() do arquivo,
// ex. blocoArquivarRestaurar).
function blocoEditarSlug(vaga, { erroSlug = '' } = {}) {
  const linkAtual = `${config.baseUrl}/vaga/${vaga.slug}`;
  const erro =
    erroSlug === 'duplicado'
      ? '<p class="aviso-alerta">Esse link já está em uso por outra vaga — escolha outro.</p>'
      : erroSlug === 'vazio'
        ? '<p class="aviso-alerta">O link não pode ficar vazio.</p>'
        : '';
  return `
    <section class="rel-sec">
      <h2>Link da vaga (slug)</h2>
      <p style="color:var(--cinza);font-size:.85rem;margin:0 0 .6rem;">
        Link público atual: <b>${escapeHtml(linkAtual)}</b></p>
      ${erro}
      <form method="POST" action="/admin/vagas/${vaga.id}/slug"
            onsubmit="return confirm('Candidatos que já receberam o link atual por e-mail ou WhatsApp vão ver “página não encontrada” depois dessa mudança. Continuar?')"
            style="display:flex;gap:.5rem;align-items:flex-end;flex-wrap:wrap;">
        <label class="campo" style="flex:1;min-width:16rem;margin:0;">
          <span>Slug</span>
          <input type="text" name="slug" value="${escapeHtml(vaga.slug)}">
        </label>
        <button type="submit" class="btn btn--ghost">Salvar link</button>
      </form>
    </section>`;
}

// Bloco "Links por etapa": URLs ABSOLUTAS (config.baseUrl + caminho) de cada etapa
// do funil desta vaga, para parametrizar no GTM. Cada uma com botao "Copiar". A de
// "Confirmacao (Lead)" e a pagina que carrega logo apos o formulario e marca o LEAD
// no GTM — e ela DEPENDE DO MODO da vaga: modo Completo -> /preparacao/:slug (tela de
// preparacao da entrevista); modo Simples -> /confirmacao/:slug (tela "candidatura
// recebida"). A decisao usa modoEntrevistaAtivo (lib/modo), o MESMO galho do redirect
// pos-aplicacao em api.js, para painel e funil real ficarem sempre em sincronia. O
// <script> de copia vai junto (o shell do admin nao carrega app.js).
function blocoLinksEtapa(vaga) {
  const base = config.baseUrl;
  const destinoLead = modoEntrevistaAtivo(vaga)
    ? `${base}/preparacao/${vaga.slug}`
    : `${base}/confirmacao/${vaga.slug}`;
  const linhas = [
    ['Vaga', `${base}/vaga/${vaga.slug}`, 'Página pública da vaga — destino do tráfego pago.'],
    ['Formulário', `${base}/aplicar/${vaga.slug}`, 'Formulário de candidatura.'],
    [
      'Confirmação (Lead)',
      destinoLead,
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
            style="flex:1;min-width:18rem;background:var(--campo);color:var(--preto);border:1px solid var(--linha);border-radius:6px;padding:.5rem .6rem;font:inherit;">
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
            style="flex:1;min-width:18rem;background:var(--campo);color:var(--preto);border:1px solid var(--linha);border-radius:6px;padding:.6rem .7rem;font:inherit;">
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
//
// `cidade` sai desta lista de proposito quando ha sugestao (cidadeSugeridaBruta): ela ganha
// um bloco proprio, acionavel (blocoSugestaoCidade), em vez de so aparecer como texto cru
// numa lista — a diferenca entre "falta preencher" e "falta uma DECISAO" (cadastrar ou nao
// a praca nova).
function avisoCamposAusentes(ausentes, temSugestaoCidade) {
  const lista = Array.isArray(ausentes) ? ausentes.filter((a) => a !== 'cidade' || !temSugestaoCidade) : [];
  if (!lista.length) return '';
  return `<p class="aviso-alerta">A IA não encontrou estes campos no briefing — revise e
    preencha antes de salvar: <b>${escapeHtml(lista.join(', '))}</b>.</p>`;
}

// Hidden inputs que carregam vaga+ausentes JA EXTRAIDOS (serializados em JSON) para o POST
// de cadastro de cidade devolver a MESMA tela preenchida — sem isso, cadastrar a praca a
// partir da tela de NOVA vaga (ainda nao salva) faria o admin perder titulo/descricao/etc.
// que a IA ja tinha lido (ou que ele mesmo ja tinha digitado). So faz sentido no fluxo de
// CRIACAO: na edicao a vaga ja tem id estavel, entao a rota (POST /vagas/:id/cidades) nao
// precisa disso — ver camposVagaHtml/htmlNovaVaga logo abaixo.
function hiddenRetomarVaga(vaga, ausentes) {
  return `<input type="hidden" name="retomar_vaga" value="${escapeHtml(JSON.stringify(vaga || {}))}">
        <input type="hidden" name="retomar_ausentes" value="${escapeHtml(JSON.stringify(ausentes || []))}">`;
}

// Bloco acionavel: a IA leu uma cidade no briefing que NAO esta no vocabulario (Incremento
// 5 de ETAPA B). NUNCA cadastra sozinho — so oferece o mini-form com o nome PRE-PREENCHIDO
// (mas editavel: a sugestao da IA e so o ponto de partida, quem decide a grafia final e o
// admin) e o campo de link do grupo de WhatsApp, para as duas tabelas (`cidades` e
// `regioes_grupos_whatsapp`) nascerem sincronizadas — ver a nota de criarRegiaoGrupo em
// sqlite.js sobre por que a praca sem link ainda precisa da linha.
//
// So aparece no fluxo de CRIACAO (a partir do import de briefing). Ficou intocado no
// Incremento 3 (ETAPA B) de proposito: e o caso especifico "a IA ja leu o nome" — o
// `<details>` generico dentro de camposVagaHtml cobre o caso geral (criacao em branco OU
// edicao, sem nome pre-preenchido), e os dois convivem sem se substituir.
function blocoSugestaoCidade({ vaga, ausentes, erroCidade }) {
  const sugestao = vaga && vaga.cidadeSugeridaBruta;
  if (!sugestao) return '';
  const erro = erroCidade ? `<p class="aviso-alerta">${escapeHtml(erroCidade)}</p>` : '';
  return `
    <div class="aviso-alerta">
      <p>A IA leu “${escapeHtml(sugestao)}” no briefing, mas essa praça ainda não está
        cadastrada.</p>
      ${erro}
      <form method="POST" action="/admin/vagas/cidades" style="display:flex;gap:.5rem;flex-wrap:wrap;align-items:flex-end;margin-top:.5rem;">
        ${hiddenRetomarVaga(vaga, ausentes)}
        <label class="campo" style="margin:0;min-width:14rem;">
          <span>Nome da cidade</span>
          <input type="text" name="nome_cidade" value="${escapeHtml(sugestao)}">
        </label>
        <label class="campo" style="margin:0;flex:1;min-width:16rem;">
          <span>Link do grupo de WhatsApp desta praça (opcional)</span>
          <input type="text" name="link_grupo_whatsapp" placeholder="https://chat.whatsapp.com/...">
        </label>
        <button type="submit" class="btn btn--ghost">Cadastrar cidade</button>
      </form>
    </div>`;
}

// Confirmacao (topo do form) apos o cadastro da cidade dar certo — a cidade ja esta
// selecionada no <select> logo abaixo (vaga.cidade foi atualizado pela rota). O aviso de
// link ausente e PERMANENTE na tela (nao some sozinho): a praca sem link e um estado que
// precisa de acao, nao so informação — mesmo padrao do aviso de roteiro faltando.
function blocoCidadeCadastrada(info) {
  if (!info) return '';
  const avisoLink = info.semLink
    ? `<p class="aviso-alerta">Sem link de grupo cadastrado — campanhas de convite para
        esta praça vão falhar até isso ser preenchido. Complete em
        <a href="/admin/campanhas-whatsapp">Campanha por WhatsApp</a>.</p>`
    : '';
  return `<p class="aviso-ok">Cidade “${escapeHtml(info.nome)}” cadastrada e selecionada
    nesta vaga.</p>${avisoLink}`;
}

// Conteudo da tela de nova vaga (compartilhado entre GET /vagas/nova e o re-render do
// POST /vagas/importar e do POST /vagas/cidades). `vaga` pre-preenche o form (default =
// vaga em branco); `erroImport` e a mensagem do bloco de import; `ausentes` alimenta o
// aviso de campos nao preenchidos; `erroCidade`/`cidadeCadastrada` vem do cadastro de
// praca (Incremento 5).
function htmlNovaVaga({
  vaga,
  erroTituloVazio = false,
  erroImport = '',
  ausentes = [],
  erroCidade = '',
  cidadeCadastrada = null,
} = {}) {
  const vagaBase = vaga || { ativo: true, perfil: 'CLOSER' };
  const erroTitulo = erroTituloVazio
    ? '<p class="aviso-alerta">O título da vaga não pode ficar vazio.</p>'
    : '';
  return `
    <p><a class="btn btn--ghost" href="/admin/vagas">← Voltar às vagas</a></p>
    <h1>Nova vaga</h1>
    ${blocoImportBriefing(erroImport)}
    ${blocoCidadeCadastrada(cidadeCadastrada)}
    ${blocoSugestaoCidade({ vaga: vagaBase, ausentes, erroCidade })}
    ${avisoCamposAusentes(ausentes, Boolean(vagaBase.cidadeSugeridaBruta))}
    ${erroTitulo}
    <form method="POST" action="/admin/vagas">
      ${camposVagaHtml(vagaBase, {
        perfilEditavel: true,
        cidadeCadastroAction: '/admin/vagas/cidades',
        cidadeCadastroHidden: hiddenRetomarVaga(vagaBase, ausentes),
      })}
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

// Cadastra uma praca nova — logica PURA, sem side-effect de resposta HTTP (nem redirect,
// nem res.send): a ETAPA A identificou que POST /admin/vagas/cidades tinha essa checagem
// (duplicata + criarCidade + criarRegiaoGrupo) acoplada ao "o que fazer depois" do fluxo de
// criacao (re-renderizar htmlNovaVaga). Extraida aqui para o Incremento 2 (edicao) poder
// reusar a MESMA validacao sem herdar esse acoplamento — cada rota chamadora decide sozinha
// como responder ao admin (re-render, redirect, o que for).
//
// Cria SEMPRE as duas linhas juntas quando da certo (cidades + regioes_grupos_whatsapp,
// mesmo sem link) — ver a nota de criarRegiaoGrupo em sqlite.js sobre o porque.
//
// Retorna `{ ok: true, nome, semLink }` ou `{ ok: false, erro }`. NUNCA lanca.
function cadastrarCidadeSeNova(nomeBruto, linkGrupoBruto) {
  const nome = String(nomeBruto || '').trim();
  if (!nome) {
    return { ok: false, erro: 'O nome da cidade não pode ficar vazio.' };
  }
  // Duplicata: mesmo guard de sempre (normalizarCidade tolera caixa/acento) — erro amigavel
  // em vez do erro cru de UNIQUE(chave)/UNIQUE(nome) do SQLite (mesmo padrao do slug,
  // Incremento 1).
  if (normalizarCidade(nome)) {
    return { ok: false, erro: `“${nome}” já está cadastrada (ou é muito parecida com uma cidade existente).` };
  }

  try {
    db.criarCidade(nome, chaveCidade(nome));
  } catch (e) {
    // Cinto de seguranca contra corrida entre duas submissoes simultaneas com o mesmo nome
    // (o guard normalizarCidade acima ja cobre o caso comum, sem corrida).
    console.error('[admin/cidades] falha ao cadastrar:', e && e.message);
    return { ok: false, erro: `Não foi possível cadastrar “${nome}” — tente novamente.` };
  }

  const link = String(linkGrupoBruto || '').trim();
  db.criarRegiaoGrupo(nome, link);

  console.log(`[admin] cidade cadastrada: '${nome}'${link ? ' (com link de grupo)' : ' (sem link de grupo)'}`);

  return { ok: true, nome, semLink: !link };
}

// ── POST /admin/vagas/cidades ── cadastra uma praca nova (Incremento 5), a partir da
// sugestao do import de briefing — NUNCA automatico: e sempre esta submissao explicita do
// admin (o nome vem PRE-PREENCHIDO pela sugestao, mas o campo e editavel; quem confirma a
// grafia final e o admin, o mesmo papel que antes era "editar o codigo com revisao").
// Registrada ANTES de /vagas/:id para não casar como :id.
//
// Re-renderiza a MESMA tela de nova vaga (nunca redirect): `retomar_vaga`/`retomar_ausentes`
// carregam o que a IA ja tinha extraido (serializado pelos hidden inputs de
// blocoSugestaoCidade), para o admin nao perder titulo/descricao/etc. so por cadastrar a
// praca — esse re-render (em vez de redirect) e o que ainda diferencia esta rota da versao
// de edicao (POST /vagas/:id/cidades, Incremento 2): a vaga aqui ainda nao foi salva.
router.post('/vagas/cidades', (req, res) => {
  const b = req.body || {};
  let vaga = {};
  let ausentes = [];
  try {
    vaga = JSON.parse(b.retomar_vaga || '{}');
  } catch {
    vaga = {};
  }
  try {
    ausentes = JSON.parse(b.retomar_ausentes || '[]');
  } catch {
    ausentes = [];
  }

  const resultado = cadastrarCidadeSeNova(b.nome_cidade, b.link_grupo_whatsapp);
  if (!resultado.ok) {
    return res.send(
      paginaAdmin({ titulo: 'Nova vaga', conteudo: htmlNovaVaga({ vaga, ausentes, erroCidade: resultado.erro }) }),
    );
  }

  vaga.cidade = resultado.nome;
  delete vaga.cidadeSugeridaBruta;
  const ausentesSemCidade = Array.isArray(ausentes) ? ausentes.filter((a) => a !== 'cidade') : [];

  return res.send(
    paginaAdmin({
      titulo: 'Nova vaga',
      conteudo: htmlNovaVaga({
        vaga,
        ausentes: ausentesSemCidade,
        cidadeCadastrada: { nome: resultado.nome, semLink: resultado.semLink },
      }),
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
    empresa: String(b.empresa || '').trim(),
    roteiro_id: roteiro ? roteiro.id : null,
    ativo: b.ativo === '1' || b.ativo === 'on',
    entrevista_ativa: b.entrevista_ativa === '1' || b.entrevista_ativa === 'on',
    ...lerCamposRicos(b),
  });

  // Item 8 — aviso NAO bloqueante: video digitado mas invalido (a vaga salva mesmo assim).
  const aviso = videoIntroInvalido(b) ? '&aviso=video' : '';
  res.redirect(`/admin/vagas/${id}?salvo=1${aviso}`);
});

// ── GET /admin/vagas/:id ── formulario de edicao de uma vaga ──
router.get('/vagas/:id', (req, res) => {
  const id = Number(req.params.id);
  const vaga = Number.isInteger(id) ? db.obterVaga(id) : null;
  if (!vaga) {
    return res.status(404).send(paginaErroAdmin('Vaga não encontrada.'));
  }

  const salvo = req.query.salvo === '1' ? '<p class="aviso-ok">Alterações salvas.</p>' : '';
  // Item 8 — aviso nao bloqueante: o link de video colado nao pôde ser interpretado.
  const avisoVideo =
    req.query.aviso === 'video'
      ? `<p class="aviso-alerta">Não reconhecemos o link/ID do vídeo do YouTube — o campo
         de vídeo foi mantido como estava. Os demais campos foram salvos. Cole a URL completa
         do vídeo (não listado) ou apenas o ID.</p>`
      : '';
  // Slug (Incremento 1/2): erroSlug='vazio'|'duplicado' renderiza dentro do proprio bloco
  // (blocoEditarSlug); salvoSlug=1 usa a mesma mensagem de sucesso do form geral.
  const salvoSlug = req.query.salvoSlug === '1' ? '<p class="aviso-ok">Link salvo.</p>' : '';
  // Cidade (Incremento 2/3): mesmo padrao de mensageria do slug — salvoCidade=1 e sucesso;
  // erroCidade=<msg> (URL-encoded pela rota) e erro; semLinkCidade=1 acompanha o sucesso
  // quando a praca nasceu sem link de grupo — aviso PERMANENTE (nao some sozinho, mesmo
  // padrao de blocoCidadeCadastrada no fluxo de criacao), com atalho pra completar depois.
  const salvoCidade =
    req.query.salvoCidade === '1' ? '<p class="aviso-ok">Cidade cadastrada e aplicada a esta vaga.</p>' : '';
  const erroCidade = req.query.erroCidade
    ? `<p class="aviso-alerta">${escapeHtml(String(req.query.erroCidade))}</p>`
    : '';
  const semLinkCidade =
    req.query.semLinkCidade === '1'
      ? `<p class="aviso-alerta">Sem link de grupo cadastrado — campanhas de convite para
          essa praça vão falhar até isso ser preenchido. Complete em
          <a href="/admin/campanhas-whatsapp">Campanha por WhatsApp</a>.</p>`
      : '';

  const conteudo = `
    <p><a class="btn btn--ghost" href="/admin/vagas">← Voltar às vagas</a></p>
    <h1>Editar vaga</h1>
    ${salvo}
    ${avisoVideo}
    ${avisoRoteiroFaltando(vaga)}
    ${blocoLinksEtapa(vaga)}
    ${salvoSlug}
    ${blocoEditarSlug(vaga, { erroSlug: req.query.erroSlug })}
    ${salvoCidade}
    ${erroCidade}
    ${semLinkCidade}
    <form method="POST" action="/admin/vagas/${vaga.id}">
      ${camposVagaHtml(vaga, {
        perfilEditavel: false,
        cidadeCadastroAction: `/admin/vagas/${vaga.id}/cidades`,
      })}
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
    empresa: String(b.empresa || '').trim(),
    ativo: b.ativo === '1' || b.ativo === 'on',
    entrevista_ativa: b.entrevista_ativa === '1' || b.entrevista_ativa === 'on',
    // Item 8 — passa a vaga anterior p/ preservar o video valido se a nova entrada falhar.
    ...lerCamposRicos(b, vaga),
  });

  // Item 8 — aviso NAO bloqueante: video digitado mas invalido (o resto salva mesmo assim).
  const aviso = videoIntroInvalido(b) ? '&aviso=video' : '';
  res.redirect(`/admin/vagas/${id}?salvo=1${aviso}`);
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

// ── POST /admin/vagas/:id/slug ── corrige o link (slug) de uma vaga ja criada ──
//
// Acao separada de POST /vagas/:id de proposito (ver o comentario de atualizarVaga em
// sqlite.js): o form geral da vaga nao mexe em slug, e essa e uma correcao pontual, nao um
// campo a mais no formulario grande. Formato normalizado com a MESMA funcao usada na
// criacao (gerarSlugBase) para o admin nao precisar adivinhar o que e "valido" — qualquer
// texto digitado vira minusculo/sem-acento/hifenizado antes de checar unicidade.
router.post('/vagas/:id/slug', (req, res) => {
  const id = Number(req.params.id);
  const vaga = Number.isInteger(id) ? db.obterVaga(id) : null;
  if (!vaga) {
    return res.status(404).send(paginaErroAdmin('Vaga não encontrada.'));
  }

  const bruto = String((req.body && req.body.slug) || '').trim();
  if (!bruto) {
    return res.redirect(`/admin/vagas/${id}?erroSlug=vazio`);
  }

  const novoSlug = gerarSlugBase(bruto);
  if (novoSlug === vaga.slug) {
    // Nada mudou de fato (mesmo valor, ou so diferia por formatacao) — trata como sucesso,
    // sem UPDATE nem log de troca.
    return res.redirect(`/admin/vagas/${id}?salvoSlug=1`);
  }

  const outraVaga = db.obterVagaPorSlug(novoSlug);
  if (outraVaga && outraVaga.id !== id) {
    // Erro amigavel: a coluna e UNIQUE, mas o admin nao deve ver um erro cru de SQLite.
    return res.redirect(`/admin/vagas/${id}?erroSlug=duplicado`);
  }

  console.log(`[admin] slug da vaga #${id} alterado: '${vaga.slug}' -> '${novoSlug}'`);
  db.atualizarSlugVaga(id, novoSlug);
  res.redirect(`/admin/vagas/${id}?salvoSlug=1`);
});

// ── POST /admin/vagas/:id/cidades ── cadastra uma praca nova a partir da tela de EDICAO
// (ETAPA B, Incremento 2) e JA APLICA em jobs.cidade — diferente do fluxo de criacao
// (POST /vagas/cidades), que so pre-seleciona num rascunho ainda nao salvo. Aqui a vaga ja
// existe com id estavel, entao "cadastrar e aplicar" num UPDATE estreito
// (definirCidadeVaga) e seguro e poupa o admin de reselecionar no form grande depois —
// mesmo padrao de acao isolada + redirect com querystring do slug, logo acima.
//
// Reusa cadastrarCidadeSeNova (extraida no Incremento 1) para a MESMA validacao de
// duplicata/nome vazio do fluxo de criacao — sem duplicar a logica.
router.post('/vagas/:id/cidades', (req, res) => {
  const id = Number(req.params.id);
  const vaga = Number.isInteger(id) ? db.obterVaga(id) : null;
  if (!vaga) {
    return res.status(404).send(paginaErroAdmin('Vaga não encontrada.'));
  }

  const b = req.body || {};
  const resultado = cadastrarCidadeSeNova(b.nome_cidade, b.link_grupo_whatsapp);
  if (!resultado.ok) {
    return res.redirect(`/admin/vagas/${id}?erroCidade=${encodeURIComponent(resultado.erro)}`);
  }

  db.definirCidadeVaga(id, resultado.nome);
  const avisoSemLink = resultado.semLink ? '&semLinkCidade=1' : '';
  res.redirect(`/admin/vagas/${id}?salvoCidade=1${avisoSemLink}`);
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
          <span style="color:var(--preto);text-transform:none;">Bloco obrigatório</span>
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

// ── CRUD de perfis ideais de curriculo (Banco de Curriculos — T1) ──
// Replica o padrao de /admin/vagas (listagem + criacao + edicao com POST tradicional e
// redirect ?salvo=1) combinado com a edicao por campos amigaveis de /admin/roteiro
// (nunca JSON cru). estrutura salva: { criterios: [{ id, nome, peso, descricao_ideal }],
// instrucoes: '' } — criterios de CURRICULO (experiencia, trajetoria), nao comportamentais.

// Linhas extras EM BRANCO no form de criterios: e assim que se ADICIONA um criterio sem
// JS (linha preenchida entra; linha com nome vazio e descartada no save — e tambem e
// assim que se REMOVE um criterio existente: apagar o nome dele).
const CRITERIOS_LINHAS_NOVO = 8; // form de criacao (perfil nasce vazio)
const CRITERIOS_LINHAS_EXTRAS = 3; // form de edicao (alem dos existentes)

// id estavel de um criterio a partir do nome (snake_case sem acento), no estilo dos ids
// de competencia do roteiro (ex.: "Experiência em vendas B2B" -> "experiencia_em_vendas_b2b").
function idDeCriterio(nome) {
  const id = String(nome || '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
  return id || 'criterio';
}

// Uma linha de criterio do form (existente ou em branco). O id viaja num hidden para
// ser PRESERVADO na edicao (criterio novo ganha id derivado do nome no save).
function campoCriterioHtml(criterio, i) {
  const c = criterio || {};
  return `
      <div class="comp">
        <input type="hidden" name="crit_${i}_id" value="${escapeHtml(c.id || '')}">
        <label class="campo">
          <span>Critério</span>
          <input type="text" name="crit_${i}_nome" value="${escapeHtml(c.nome || '')}"
            placeholder="Ex.: Experiência com vendas consultivas">
        </label>
        <label class="campo">
          <span>Peso (1–2)</span>
          <input type="number" name="crit_${i}_peso" min="1" max="2" value="${escapeHtml(String(c.peso || 1))}">
        </label>
        <label class="campo">
          <span>O que um currículo ideal evidencia</span>
          <textarea name="crit_${i}_descricao_ideal" rows="3"
            placeholder="Ex.: Passagens por times de vendas B2B, com metas e números concretos de resultado.">${escapeHtml(c.descricao_ideal || '')}</textarea>
        </label>
      </div>`;
}

// Reconstroi a lista de criterios a partir das linhas do form (crit_<i>_*). Linhas com
// nome vazio sao descartadas. Peso fora de 1-2 e grampeado (mesma regra do roteiro).
function lerCriteriosDoForm(b) {
  const criterios = [];
  for (let i = 0; b[`crit_${i}_nome`] !== undefined; i += 1) {
    const nome = String(b[`crit_${i}_nome`] || '').trim();
    if (!nome) continue;
    const pesoNum = parseInt(b[`crit_${i}_peso`], 10);
    const idExistente = String(b[`crit_${i}_id`] || '').trim();
    criterios.push({
      id: idExistente || idDeCriterio(nome),
      nome,
      peso: Number.isFinite(pesoNum) ? Math.min(2, Math.max(1, pesoNum)) : 1,
      descricao_ideal: String(b[`crit_${i}_descricao_ideal`] || '').trim(),
    });
  }
  return criterios;
}

// Form compartilhado entre criacao e edicao. Na criacao o perfil e um select
// (SDR/CLOSER); na edicao ele e fixo (mesma decisao de /admin/vagas/:id).
function camposPerfilCurriculoHtml(perfilCurriculo, { perfilEditavel } = {}) {
  const p = perfilCurriculo || { perfil: 'SDR', estrutura: {} };
  const criterios = Array.isArray(p.estrutura && p.estrutura.criterios)
    ? p.estrutura.criterios
    : [];

  const campoPerfil = perfilEditavel
    ? `
      <label class="campo">
        <span>Perfil</span>
        <select name="perfil">
          ${PERFIS_VALIDOS.map(
            (v) => `<option value="${v}"${p.perfil === v ? ' selected' : ''}>${v}</option>`,
          ).join('')}
        </select>
      </label>`
    : `
      <label class="campo">
        <span>Perfil (fixo após a criação)</span>
        <input type="text" value="${escapeHtml(p.perfil || '')}" disabled>
      </label>`;

  const totalLinhas = criterios.length
    ? criterios.length + CRITERIOS_LINHAS_EXTRAS
    : CRITERIOS_LINHAS_NOVO;
  const linhasCriterios = Array.from({ length: totalLinhas }, (_, i) =>
    campoCriterioHtml(criterios[i], i),
  ).join('');

  return `
      <label class="campo">
        <span>Nome do perfil</span>
        <input type="text" name="nome" value="${escapeHtml(p.nome || '')}"
          placeholder="Ex.: SDR - Currículo ideal v1">
      </label>
      ${campoPerfil}

      <h2>Critérios do currículo ideal</h2>
      <p style="color:var(--cinza);font-size:.85rem;margin:-.3rem 0 1rem;">
        Preencha um critério por card (linhas com o nome vazio são ignoradas). Para
        remover um critério existente, apague o nome dele e salve.</p>
      ${linhasCriterios}`;
}

// ── GET /admin/perfis-curriculo ── listagem dos perfis ideais de curriculo ──
router.get('/perfis-curriculo', (req, res) => {
  const perfis = db.listarPerfisCurriculo();
  const salvo = req.query.salvo === '1' ? '<p class="aviso-ok">Perfil salvo.</p>' : '';

  const linhas = perfis
    .map((p) => {
      const criterios = Array.isArray(p.estrutura && p.estrutura.criterios)
        ? p.estrutura.criterios.length
        : 0;
      return `
        <tr>
          <td>${escapeHtml(p.nome)}</td>
          <td>${escapeHtml(p.perfil)}</td>
          <td>${criterios}</td>
          <td>${escapeHtml(formatarDataHora(p.atualizado_em))}</td>
          <td>
            <div class="acoes-linha">
              <a class="btn btn--ghost" href="/admin/perfis-curriculo/${p.id}">Editar</a>
            </div>
          </td>
        </tr>`;
    })
    .join('');

  const conteudo = `
    <p><a class="btn btn--ghost" href="/admin">← Voltar ao painel</a></p>
    <div style="display:flex;justify-content:space-between;align-items:center;gap:1rem;flex-wrap:wrap;margin-bottom:1rem;">
      <h1 style="margin:0;">Perfis de currículo</h1>
      <a class="btn" href="/admin/perfis-curriculo/novo">+ Novo perfil</a>
    </div>
    <p style="color:var(--cinza);font-size:.9rem;margin:-.5rem 0 1rem;">
      Perfis ideais de currículo do Banco de Currículos: os critérios abaixo servirão de
      referência para a análise automática dos currículos cadastrados.</p>
    ${salvo}
    <div class="admin-tab-scroll">
      <table class="admin-tab">
        <thead>
          <tr><th>Nome</th><th>Perfil</th><th>Critérios</th><th>Atualizado em</th><th>Ações</th></tr>
        </thead>
        <tbody>
          ${linhas || '<tr><td colspan="5">Nenhum perfil de currículo cadastrado.</td></tr>'}
        </tbody>
      </table>
    </div>`;

  res.send(paginaAdmin({ titulo: 'Perfis de currículo', conteudo }));
});

// ── GET /admin/perfis-curriculo/novo ── formulario de criacao (antes de /:id p/ nao casar como id) ──
router.get('/perfis-curriculo/novo', (req, res) => {
  const erroNome =
    req.query.erro === 'nome'
      ? '<p class="aviso-alerta">O nome do perfil não pode ficar vazio.</p>'
      : '';
  const conteudo = `
    <p><a class="btn btn--ghost" href="/admin/perfis-curriculo">← Voltar aos perfis</a></p>
    <h1>Novo perfil de currículo</h1>
    ${erroNome}
    <form method="POST" action="/admin/perfis-curriculo">
      ${camposPerfilCurriculoHtml(null, { perfilEditavel: true })}
      <button type="submit" class="btn">Criar perfil</button>
    </form>`;
  res.send(paginaAdmin({ titulo: 'Novo perfil de currículo', conteudo }));
});

// ── POST /admin/perfis-curriculo ── cria novo perfil ──
router.post('/perfis-curriculo', (req, res) => {
  const b = req.body || {};
  const nome = String(b.nome || '').trim();
  if (!nome) {
    return res.redirect('/admin/perfis-curriculo/novo?erro=nome');
  }

  const perfil = PERFIS_VALIDOS.includes(b.perfil) ? b.perfil : 'SDR';
  const id = db.criarPerfilCurriculo({
    nome,
    perfil,
    estrutura: { criterios: lerCriteriosDoForm(b), instrucoes: '' },
  });

  res.redirect(`/admin/perfis-curriculo/${id}?salvo=1`);
});

// ── GET /admin/perfis-curriculo/:id ── formulario de edicao ──
router.get('/perfis-curriculo/:id', (req, res) => {
  const id = Number(req.params.id);
  const perfilCurriculo = Number.isInteger(id) ? db.buscarPerfilCurriculo(id) : null;
  if (!perfilCurriculo) {
    return res.status(404).send(paginaErroAdmin('Perfil de currículo não encontrado.'));
  }

  const salvo = req.query.salvo === '1' ? '<p class="aviso-ok">Alterações salvas.</p>' : '';
  const conteudo = `
    <p><a class="btn btn--ghost" href="/admin/perfis-curriculo">← Voltar aos perfis</a></p>
    <h1>Editar perfil de currículo</h1>
    ${salvo}
    <form method="POST" action="/admin/perfis-curriculo/${perfilCurriculo.id}">
      ${camposPerfilCurriculoHtml(perfilCurriculo, { perfilEditavel: false })}
      <button type="submit" class="btn">Salvar alterações</button>
    </form>`;

  res.send(paginaAdmin({ titulo: 'Editar perfil de currículo', conteudo }));
});

// ── POST /admin/perfis-curriculo/:id ── salva alteracoes (nome + criterios) ──
router.post('/perfis-curriculo/:id', (req, res) => {
  const id = Number(req.params.id);
  const perfilCurriculo = Number.isInteger(id) ? db.buscarPerfilCurriculo(id) : null;
  if (!perfilCurriculo) {
    return res.status(404).send(paginaErroAdmin('Perfil de currículo não encontrado.'));
  }

  const b = req.body || {};
  const nome = String(b.nome || '').trim();
  if (!nome) {
    return res.status(400).send(
      paginaAdmin({
        titulo: 'Editar perfil de currículo',
        conteudo: `
          <p><a class="btn btn--ghost" href="/admin/perfis-curriculo/${perfilCurriculo.id}">← Voltar</a></p>
          <section class="rel-sec"><h1>Editar perfil de currículo</h1>
            <p>O nome do perfil não pode ficar vazio.</p></section>`,
      }),
    );
  }

  // Parte da estrutura ATUAL e sobrescreve SO os criterios (mesma tatica do POST
  // /roteiro): preserva campos fora do form — hoje `instrucoes`, e o que vier a existir.
  const est = JSON.parse(JSON.stringify(perfilCurriculo.estrutura || {}));
  est.criterios = lerCriteriosDoForm(b);
  if (typeof est.instrucoes !== 'string') est.instrucoes = '';

  db.atualizarPerfilCurriculo(id, { nome, estrutura: est });
  res.redirect(`/admin/perfis-curriculo/${id}?salvo=1`);
});

// ── Banco de talentos (Banco de Curriculos — T4) ── listagem/gestao (so leitura +
//    mudanca de status). Os dados foram persistidos pelo fluxo publico (T2/T3); aqui o
//    recrutador ve os cadastros e move o status. Nao toca no funil de vaga. ──

// Rotulos amigaveis dos status do talento (enum em db.STATUS_TALENTO_VALIDOS).
const ROTULOS_STATUS_TALENTO = {
  novo: 'Novo',
  contatado: 'Contatado',
  descartado: 'Descartado',
  convertido: 'Convertido',
};

// Rotulos amigaveis da ORIGEM do talento (coluna `categoria`).
//
// NULL nao e um estado degradado: e o cadastro proprio, que era o unico jeito de entrar
// aqui antes da importacao da base legada. Por isso a ausencia de categoria tem rotulo
// proprio ("Cadastro próprio") em vez do "—" usado nas colunas de dado faltando — o Jean
// precisa distinguir "veio pelo formulario" de "esta em branco".
const ROTULOS_CATEGORIA_TALENTO = {
  legado: 'Base legada',
};
const ROTULO_CATEGORIA_PROPRIO = 'Cadastro próprio';

function rotuloCategoriaTalento(categoria) {
  if (!categoria) return ROTULO_CATEGORIA_PROPRIO;
  return ROTULOS_CATEGORIA_TALENTO[categoria] || categoria;
}

// Chip da origem. Contorno sobrio para legado (registro histórico, sem currículo nem
// consentimento) e laranja para cadastro proprio (entrou pelo funil atual, com tudo).
// A distincao visual e o ponto: numa lista com 7 mil legados e algumas dezenas de
// cadastros proprios, os proprios sao a excecao que precisa saltar.
function badgeCategoriaTalento(categoria) {
  const classe = categoria === 'legado' ? 'badge--concluido' : 'badge--entrevista';
  return `<span class="badge ${classe}">${escapeHtml(rotuloCategoriaTalento(categoria))}</span>`;
}

// Chip do status do talento. Reusa a paleta existente: laranja (contatado/convertido =
// ativo/positivo), contorno sobrio (descartado = negativo), cinza (novo = neutro inicial).
function badgeStatusTalento(status) {
  const classe = {
    novo: 'badge--aplicado',
    contatado: 'badge--entrevista',
    convertido: 'badge--entrevista',
    descartado: 'badge--concluido',
  }[status] || 'badge--aplicado';
  const rotulo = ROTULOS_STATUS_TALENTO[status] || status || '—';
  return `<span class="badge ${classe}">${escapeHtml(rotulo)}</span>`;
}

// Score do talento para a coluna da listagem: numero /100 quando ha score; "sem analise"
// quando a analise nao existe ou nao trouxe score numerico (perfil ideal ausente/falha).
function scoreTalentoTexto(analise) {
  const s = analise && analise.score_geral;
  return Number.isFinite(s) ? `${s}/100` : 'sem análise';
}

// Render da analise completa no PAINEL (tema escuro): score + pontos fortes + pontos de
// atencao + nota/comentario por criterio. NAO reusa renderizarResultadoTalentoHtml de
// banco_curriculos.js de proposito: aquele usa as classes do site publico (vm-hero/
// vm-card), tem copy voltada ao candidato e nao renderiza por_criterio. Aqui seguimos o
// padrao de card de competencia (.comp/.comp-nota) do relatorio de entrevista.
function analiseTalentoAdminHtml(analise, { ehLegado = false } = {}) {
  if (!analise) {
    // DUAS ausencias diferentes, com causas diferentes. O texto original culpa o perfil
    // ideal ausente ou uma falha do motor — verdade para cadastro proprio, e falso para
    // legado, onde nunca houve currículo para analisar. Dizer "a análise falhou" a quem
    // olha um registro importado manda o Jean investigar um erro que nao existe.
    if (ehLegado) {
      return `<p style="color:var(--cinza);">Não há análise porque não há currículo: este
        registro veio da base legada, que trazia apenas cargo e contato. Não é falha do
        motor de análise — não havia arquivo para analisar.</p>`;
    }
    return `<p style="color:var(--cinza);">Sem análise. Não havia perfil ideal de currículo
      cadastrado para este perfil de interesse no momento do cadastro, ou a análise
      automática falhou. O cadastro do talento foi preservado normalmente.</p>`;
  }

  const temScore = Number.isFinite(analise.score_geral);
  const scoreHtml = temScore
    ? `<p style="margin:.2rem 0 1rem;font-size:1.05rem;">Score geral:
         <span class="comp-nota">${analise.score_geral}<small>/100</small></span></p>`
    : '<p style="color:var(--cinza);margin:.2rem 0 1rem;">Análise sem score geral.</p>';

  const listaItens = (itens) =>
    (Array.isArray(itens) ? itens : []).map((i) => `<li>${escapeHtml(i)}</li>`).join('');
  const fortes = listaItens(analise.pontos_fortes);
  const atencao = listaItens(analise.pontos_atencao);

  const criterios = Array.isArray(analise.por_criterio) ? analise.por_criterio : [];
  const criteriosHtml = criterios
    .map((c) => {
      const nota = Number.isFinite(c.nota) ? `${c.nota}<small>/5</small>` : '—';
      return `
        <div class="comp">
          <div class="comp-cab">
            <h3 style="margin:0;">${escapeHtml(c.nome || '')}</h3>
            <span class="comp-nota">${nota}</span>
          </div>
          ${c.comentario ? `<p style="margin:.4rem 0 0;">${escapeHtml(c.comentario)}</p>` : ''}
        </div>`;
    })
    .join('');

  return `
    ${scoreHtml}
    ${fortes ? `<h3>Pontos fortes</h3><ul class="lista">${fortes}</ul>` : ''}
    ${atencao ? `<h3 style="margin-top:1rem;">Pontos de atenção</h3><ul class="lista">${atencao}</ul>` : ''}
    ${criteriosHtml ? `<h3 style="margin-top:1.2rem;">Notas por critério</h3>${criteriosHtml}` : ''}`;
}

// ── GET /admin/talentos ── listagem do banco de talentos (filtros por perfil/status) ──
router.get('/talentos', (req, res) => {
  const q = req.query || {};
  // Saneamento: filtros so valem se pertencerem ao enum; caso contrario = "todos".
  const perfil = PERFIS_VALIDOS.includes(q.perfil) ? q.perfil : '';
  const status = db.STATUS_TALENTO_VALIDOS.includes(q.status) ? q.status : '';
  // Categoria aceita os valores gravaveis MAIS o sentinela de "cadastro proprio"
  // (categoria IS NULL), que nao existe no banco e so viaja na query string.
  const categoriasFiltraveis = [...db.CATEGORIAS_TALENTO_VALIDAS, db.CATEGORIA_FILTRO_PROPRIO];
  const categoria = categoriasFiltraveis.includes(q.categoria) ? q.categoria : '';

  // Pagina 1-indexed, mesmo saneamento do painel de candidatos: inteiro positivo, lixo cai
  // no default. A camada de dados sanea de novo — aqui o valor tambem desenha os controles.
  const paginaNum = Number(q.pagina);
  const pagina = Number.isInteger(paginaNum) && paginaNum > 0 ? paginaNum : 1;

  // Recorte UNICO: o mesmo objeto vai para a tabela e para a contagem do topo. Remontar um
  // objeto parecido nos dois pontos seria a porta de entrada para o contador divergir da
  // lista — mesma disciplina de `filtrosLista` no painel de candidatos.
  const filtrosLista = {
    perfil: perfil || undefined,
    status: status || undefined,
    categoria: categoria || undefined,
  };

  const talentos = db.listarTalentos({ ...filtrosLista, pagina });
  // Sem `pagina`: contarTalentos a ignora de qualquer forma, mas passar so o recorte deixa
  // explicito que a paginacao nao entra na conta.
  const totalTalentos = db.contarTalentos(filtrosLista);
  const totalGeral = db.contarTalentos({});
  const totalPaginas = Math.max(1, Math.ceil(totalTalentos / db.TALENTOS_POR_PAGINA));

  const linhas = talentos
    .map(
      (t) => `
        <tr>
          <td><a href="/admin/talentos/${t.id}">${escapeHtml(t.nome || '—')}</a></td>
          <td>${escapeHtml(t.email || '—')}</td>
          <td>${escapeHtml(t.telefone || '—')}</td>
          <td>${escapeHtml(t.cargo || '—')}</td>
          <td>${escapeHtml(t.perfil_interesse || '—')}</td>
          <td>${badgeCategoriaTalento(t.categoria)}</td>
          <td>${escapeHtml(scoreTalentoTexto(t.analise))}</td>
          <td>${badgeStatusTalento(t.status)}</td>
          <td>${escapeHtml(formatarDataHora(t.criado_em))}</td>
          <td><a class="btn btn--ghost" href="/admin/talentos/${t.id}">Ver detalhe</a></td>
        </tr>`,
    )
    .join('');

  const selPerfil = (v) => (perfil === v ? ' selected' : '');
  const selStatus = (v) => (status === v ? ' selected' : '');
  const selCategoria = (v) => (categoria === v ? ' selected' : '');
  const temFiltro = Boolean(perfil || status || categoria);
  const opcoesStatus = db.STATUS_TALENTO_VALIDOS.map(
    (s) => `<option value="${s}"${selStatus(s)}>${escapeHtml(ROTULOS_STATUS_TALENTO[s] || s)}</option>`,
  ).join('');
  const opcoesCategoria = db.CATEGORIAS_TALENTO_VALIDAS.map(
    (c) => `<option value="${escapeHtml(c)}"${selCategoria(c)}>${escapeHtml(ROTULOS_CATEGORIA_TALENTO[c] || c)}</option>`,
  ).join('');

  const filtros = `
    <form method="GET" action="/admin/talentos" class="admin-filtros">
      <label class="filtro">
        <span>Origem</span>
        <select name="categoria">
          <option value=""${categoria ? '' : ' selected'}>Todas</option>
          ${opcoesCategoria}
          <option value="${db.CATEGORIA_FILTRO_PROPRIO}"${selCategoria(db.CATEGORIA_FILTRO_PROPRIO)}>Cadastro próprio</option>
        </select>
      </label>
      <label class="filtro">
        <span>Perfil</span>
        <select name="perfil">
          <option value=""${perfil ? '' : ' selected'}>Todos</option>
          <option value="SDR"${selPerfil('SDR')}>SDR</option>
          <option value="CLOSER"${selPerfil('CLOSER')}>Closer</option>
        </select>
      </label>
      <label class="filtro">
        <span>Status</span>
        <select name="status">
          <option value=""${status ? '' : ' selected'}>Todos</option>
          ${opcoesStatus}
        </select>
      </label>
      <button type="submit" class="btn">Filtrar</button>
      ${temFiltro ? '<a class="btn btn--ghost" href="/admin/talentos">Limpar</a>' : ''}
    </form>`;

  // Link de pagina preservando os filtros: sem isto, navegar para a pagina 2 devolveria a
  // base inteira e o operador perderia o recorte sem perceber.
  const linkPagina = (n) => {
    const p = new URLSearchParams();
    if (categoria) p.set('categoria', categoria);
    if (perfil) p.set('perfil', perfil);
    if (status) p.set('status', status);
    if (n > 1) p.set('pagina', String(n));
    const qs = p.toString();
    return `/admin/talentos${qs ? `?${qs}` : ''}`;
  };

  // Escondida quando ha uma pagina so — nao ha para onde navegar e a barra viraria ruido.
  // A excecao e `pagina > 1`: quem chegou alem da ultima (URL na mao, ou um filtro que
  // encolheu o resultado) precisa de caminho de volta. Mesma regra do painel de candidatos.
  const paginacao =
    totalPaginas > 1 || pagina > 1
      ? `
      <nav class="admin-paginacao" aria-label="Paginação do banco de talentos">
        ${
          pagina > 1
            ? `<a class="btn btn--ghost" rel="prev" href="${linkPagina(Math.min(pagina - 1, totalPaginas))}">← Anterior</a>`
            : '<span class="btn btn--off">← Anterior</span>'
        }
        <span>Página <b>${pagina}</b> de <b>${totalPaginas}</b></span>
        ${
          pagina < totalPaginas
            ? `<a class="btn btn--ghost" rel="next" href="${linkPagina(pagina + 1)}">Próxima →</a>`
            : '<span class="btn btn--off">Próxima →</span>'
        }
      </nav>`
      : '';

  const contador = temFiltro
    ? `<b>${totalTalentos}</b> de <b>${totalGeral}</b> talento(s) — recorte filtrado`
    : `<b>${totalGeral}</b> talento(s) no banco`;

  const conteudo = `
    <p><a class="btn btn--ghost" href="/admin">← Voltar ao painel</a></p>
    <h1 style="margin:0 0 .3rem;">Banco de talentos</h1>
    <p style="color:var(--cinza);font-size:.9rem;margin:0 0 .6rem;">
      Duas origens convivem aqui: <b>cadastro próprio</b>, recebido pelo Banco de Currículos
      (/bancodecurriculos), com currículo em PDF e análise automática quando havia perfil
      ideal cadastrado; e <b>base legada</b>, importada do sistema anterior, que traz cargo
      e contato mas não tem currículo, análise nem consentimento registrado na origem.
      Use o filtro de Origem para separar os dois.</p>
    <p style="color:var(--cinza);font-size:.9rem;margin:0 0 1.25rem;">${contador}</p>
    ${filtros}
    <div class="admin-tab-scroll">
      <table class="admin-tab">
        <thead>
          <tr>
            <th>Nome</th><th>E-mail</th><th>Telefone</th><th>Cargo</th><th>Perfil</th>
            <th>Origem</th><th>Score</th><th>Status</th><th>Cadastrado em</th><th>Ação</th>
          </tr>
        </thead>
        <tbody>
          ${linhas || `<tr><td colspan="10">${temFiltro ? 'Nenhum talento para os filtros aplicados.' : 'Nenhum talento cadastrado ainda.'}</td></tr>`}
        </tbody>
      </table>
    </div>
    ${paginacao}`;

  res.send(paginaAdmin({ titulo: 'Banco de talentos', conteudo }));
});

// ── GET /admin/talentos/:id/curriculo ── download do PDF (mesmo padrao do funil) ──
// Seguranca: o caminho vem do DB (curriculo_path absoluto), NUNCA de req.params.
router.get('/talentos/:id/curriculo', (req, res) => {
  const id = Number(req.params.id);
  const talento = Number.isInteger(id) && id > 0 ? db.buscarTalento(id) : null;
  if (!talento || !talento.curriculo_path) {
    return avisoAdmin(res, 404, {
      titulo: 'Currículo não disponível',
      descricao: 'Este talento não possui currículo anexado.',
    });
  }
  const caminho = talento.curriculo_path; // caminho absoluto do banco (nao montado de req)
  if (!fs.existsSync(caminho)) {
    return avisoAdmin(res, 404, {
      titulo: 'Arquivo não encontrado',
      descricao: 'O arquivo do currículo não foi localizado no armazenamento.',
    });
  }
  // Extensao REAL do arquivo em disco — mesmo motivo do download do candidato (funil).
  const extensao = path.extname(caminho).slice(1);
  const nomeArquivo = `${sanitizarNomeArquivo(`curriculo_${talento.nome || ''}`)}.${extensao}`;
  res.type(mimetypePorExtensao(extensao));
  res.setHeader('Content-Disposition', `attachment; filename="${nomeArquivo}"`);
  return res.sendFile(caminho);
});

// ── GET /admin/talentos/:id ── detalhe do talento (contato + curriculo + analise) ──
router.get('/talentos/:id', (req, res) => {
  const id = Number(req.params.id);
  const talento = Number.isInteger(id) && id > 0 ? db.buscarTalento(id) : null;
  if (!talento) {
    return avisoAdmin(res, 404, {
      titulo: 'Talento não encontrado',
      descricao: 'Não há cadastro no banco de talentos com este identificador.',
    });
  }

  const salvo = req.query.salvo === '1' ? '<div class="aviso-ok">Status atualizado.</div>' : '';
  const linkedin = talento.linkedin_url
    ? `<a href="${escapeHtml(talento.linkedin_url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(talento.linkedin_url)}</a>`
    : '—';

  // ── Registro da base legada: tres textos desta tela mentiriam sem este flag ──
  //
  // Os 7.215 importados nao tem currículo, nao tem análise e nao tem consentimento na
  // origem. A tela foi escrita quando o unico jeito de entrar aqui era o formulario
  // publico, entao ela explica cada ausencia como se fosse falha do fluxo normal:
  // "—" no consentimento parece dado faltando por bug; o texto padrao da analise culpa
  // um perfil ideal ausente ou uma falha do motor; e o botao de currículo aparece
  // desabilitado sem dizer por que. Nenhuma das tres explicacoes e verdade para legado.
  //
  // Para cadastro proprio (categoria NULL) NADA muda — os tres caminhos abaixo caem
  // exatamente no que a tela ja fazia.
  const ehLegado = talento.categoria === 'legado';

  const botaoCurriculo = talento.curriculo_path
    ? `<a class="btn" href="/admin/talentos/${talento.id}/curriculo">Baixar currículo</a>`
    : ehLegado
      ? `<p style="color:var(--cinza);margin:0;">Registros da base legada não têm currículo:
           a importação trouxe cargo e contato, e o sistema anterior não guardava o arquivo.
           Para receber um currículo desta pessoa, envie o link do
           <a href="/bancodecurriculos">Banco de Currículos</a>.</p>`
      : `<span class="btn btn--off" title="Este cadastro não tem currículo anexado.">Baixar currículo</span>`;

  // Consentimento: data real quando existe; para legado, a explicacao do porque nao existe.
  const consentimentoHtml = talento.consent_at
    ? escapeHtml(formatarDataHora(talento.consent_at))
    : ehLegado
      ? `<span style="color:var(--cinza);">Sem consentimento documentado na origem —
           a base legada não registrava esse dado. Importado em ${escapeHtml(formatarDataHora(talento.criado_em))}
           como registro histórico.</span>`
      : '—';

  const opcoesStatus = db.STATUS_TALENTO_VALIDOS.map(
    (s) =>
      `<option value="${s}"${talento.status === s ? ' selected' : ''}>${escapeHtml(ROTULOS_STATUS_TALENTO[s] || s)}</option>`,
  ).join('');

  const nomeTalento = talento.nome || talento.email || `Talento ${talento.id}`;

  const conteudo = `
    <div style="display:flex;justify-content:space-between;align-items:center;gap:1rem;flex-wrap:wrap;margin-bottom:1rem;">
      <h1 style="margin:0;">${escapeHtml(nomeTalento)}</h1>
      <a class="btn btn--ghost" href="/admin/talentos">← Voltar ao banco de talentos</a>
    </div>
    ${salvo}

    <section class="rel-sec">
      <h2>Dados de contato</h2>
      <dl class="rel-id">
        <div><dt>Nome</dt><dd>${escapeHtml(talento.nome || '—')}</dd></div>
        <div><dt>E-mail</dt><dd>${escapeHtml(talento.email || '—')}</dd></div>
        <div><dt>Telefone</dt><dd>${escapeHtml(talento.telefone || '—')}</dd></div>
        <div><dt>LinkedIn</dt><dd>${linkedin}</dd></div>
        <div><dt>Origem</dt><dd>${badgeCategoriaTalento(talento.categoria)}</dd></div>
        <div><dt>Cargo</dt><dd>${escapeHtml(talento.cargo || '—')}</dd></div>
        <div><dt>Perfil de interesse</dt><dd>${escapeHtml(talento.perfil_interesse || '—')}</dd></div>
        <div><dt>Status</dt><dd>${badgeStatusTalento(talento.status)}</dd></div>
        <div><dt>Cadastrado em</dt><dd>${escapeHtml(formatarDataHora(talento.criado_em))}</dd></div>
        <div><dt>Consentimento (LGPD)</dt><dd>${consentimentoHtml}</dd></div>
      </dl>
    </section>

    <section class="rel-sec">
      <h2>Gerenciar status</h2>
      <form method="POST" action="/admin/talentos/${talento.id}/status">
        <label class="campo" style="max-width:320px;">
          <span>Status</span>
          <select name="status">${opcoesStatus}</select>
        </label>
        <button type="submit" class="btn">Salvar status</button>
      </form>
    </section>

    <section class="rel-sec">
      <h2>Análise do currículo</h2>
      ${analiseTalentoAdminHtml(talento.analise, { ehLegado })}
    </section>

    <section class="rel-sec">
      <h2>Currículo</h2>
      <div class="acoes-linha">${botaoCurriculo}</div>
    </section>`;

  res.send(paginaAdmin({ titulo: `Talento — ${nomeTalento}`, conteudo }));
});

// ── POST /admin/talentos/:id/status ── atualiza o status (enum validado na camada
//    de dados: valor invalido -> 0 changes, sem quebrar) ──
router.post('/talentos/:id/status', (req, res) => {
  const id = Number(req.params.id);
  const talento = Number.isInteger(id) && id > 0 ? db.buscarTalento(id) : null;
  if (!talento) {
    return avisoAdmin(res, 404, {
      titulo: 'Talento não encontrado',
      descricao: 'Não há cadastro no banco de talentos com este identificador.',
    });
  }
  db.atualizarStatusTalento(id, (req.body && req.body.status) || '');
  return res.redirect(`/admin/talentos/${id}?salvo=1`);
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

// Liga/desliga o e-mail "Nova candidatura" ao recrutador, disparado em POST /api/aplicacao
// (routes/api.js, onde a MESMA string e lida). Default FALSE: a notificacao nasce
// desligada e so volta a sair se o recrutador marcar o checkbox abaixo.
const CHAVE_NOTIFICAR_NOVA_CANDIDATURA = 'notificar_recrutador_nova_candidatura';

// Liga/desliga o e-mail automatico de RECUSA ao candidato. A chave e o default moram em
// lib/emailRecusa (dono do subsistema), igual ao follow-up — painel e varredura leem a
// MESMA constante e nao tem como divergir. E o kill switch: vive no painel (nao em env)
// para o recrutador conseguir desligar na hora, sem redeploy, se algum e-mail sair errado.
const CHAVE_EMAIL_RECUSA_ATIVO = emailRecusa.CHAVE_ATIVO;

// Liga/desliga o LEMBRETE de inicio de entrevista (quem se candidatou e nunca abriu a
// entrevista). Mesma logica de propriedade das outras: a chave mora em lib/lembreteInicio,
// dono do subsistema, e painel e varredura leem a MESMA constante. Kill switch no painel,
// nao em env, para desligar na hora sem redeploy.
const CHAVE_LEMBRETE_INICIO_ATIVO = lembreteInicio.CHAVE_ATIVO;

// Liga/desliga a LIMPEZA AUTOMATICA de audio das entrevistas no volume. Mesma logica de
// propriedade das outras: a chave mora em lib/limpezaAudio, dono do subsistema. Kill
// switch no painel (nao em env) porque apagar arquivo e irreversivel — precisa dar para
// desligar na hora, sem redeploy.
const CHAVE_LIMPEZA_AUDIO_ATIVO = limpezaAudio.CHAVE_ATIVO;

// Liga/desliga o DISPARO das campanhas de Promocao de Vagas. Mesma logica de propriedade
// das outras quatro: a chave mora em lib/dispararPromocao, dono do subsistema. E o kill
// switch com a maior consequencia do painel — e o unico que faz e-mail sair para gente que
// nao esta num processo conosco, em volume, e nao ha como despublicar e-mail enviado.
// Default FALSE, como todos os outros: nasce desligado.
const CHAVE_PROMOCAO_ATIVA = dispararPromocao.CHAVE_ATIVO;
// Interruptor de DISPARO da sequencia WA1/WA2. Ate aqui so era ligavel escrevendo direto em
// `configuracoes` — o que e exatamente o tipo de coisa que ninguem lembra de desligar as
// pressas. Ver whatsapp/sequenciaOutbox.
const CHAVE_WHATSAPP_SEQ = sequenciaWhatsapp.CHAVE_ATIVO;
// Interruptor da CAMPANHA por WhatsApp (Meta Cloud API). Frente separada da sequencia.
const CHAVE_CAMPANHA_WA = campanhaWhatsapp.CHAVE_ATIVO;

// Endereco fixo do e-mail de TESTE da Promocao de Vagas. Mesma logica de propriedade das
// chaves acima: mora em lib/emailTestePromocao, dono do subsistema. Vive no painel (e nao
// no .env) para o Jean trocar o destino sem redeploy — e trocar o destino e justamente o
// que se faz ao passar o teste para outra pessoa revisar.
const CHAVE_EMAIL_TESTE_PROMOCAO = emailTestePromocao.CHAVE_EMAIL_TESTE;

// ── GET /admin/config ── tela de configuracoes gerais ──
router.get('/config', (req, res) => {
  const ativo = db.obterConfigBool(CHAVE_ENTREVISTA_AUTO, true);
  const salvo = req.query.salvo === '1' ? '<p class="aviso-ok">Configuração salva.</p>' : '';

  // Config da mensagem de WhatsApp (B4): nome do recrutador + template editavel.
  const recrutadorNome = db.obterConfig('recrutador_nome', RECRUTADOR_PADRAO);
  const whatsappTemplate = db.obterConfig('whatsapp_template', TEMPLATE_PADRAO);

  // Notificacao de nova candidatura (default desligada).
  const notificarNovaCandidatura = db.obterConfigBool(CHAVE_NOTIFICAR_NOVA_CANDIDATURA, false);

  // E-mail automatico de recusa ao candidato (default desligado).
  const emailRecusaAtivo = db.obterConfigBool(CHAVE_EMAIL_RECUSA_ATIVO, false);

  // Lembrete de inicio de entrevista (default desligado).
  const lembreteInicioAtivo = db.obterConfigBool(CHAVE_LEMBRETE_INICIO_ATIVO, false);

  // Limpeza automatica de audio no volume (default desligada).
  const limpezaAudioAtiva = db.obterConfigBool(CHAVE_LIMPEZA_AUDIO_ATIVO, false);

  // Sugestao de data pro backup manual de curriculos (GET /admin/curriculos-backup):
  // so preenche o campo, o Rafael pode trocar antes de clicar. 90 dias e um piso
  // razoavel — nao apaga nada sozinho, entao nao ha risco em sugerir um valor.
  const sugestaoAntesCurriculos = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000)
    .toISOString()
    .slice(0, 10);

  // Disparo das campanhas de Promocao de Vagas (default desligado).
  const promocaoAtiva = db.obterConfigBool(CHAVE_PROMOCAO_ATIVA, false);
  const whatsappSeqAtiva = db.obterConfigBool(CHAVE_WHATSAPP_SEQ, false);
  const campanhaWaAtiva = db.obterConfigBool(CHAVE_CAMPANHA_WA, false);

  // Endereco do e-mail de teste de campanha. Vazio por padrao, de proposito: sem ele o
  // botao de teste na tela de campanha so sabe dizer "configure aqui primeiro".
  const emailTeste = db.obterConfig(CHAVE_EMAIL_TESTE_PROMOCAO, '');

  // Horas de espera do 1o follow-up de entrevista nao concluida. Le pelo MESMO helper do
  // agendador (lib/followupEntrevista.horasEspera), entao painel e varredura nunca
  // divergem: valor invalido salvo no banco aparece aqui ja como o padrao efetivo.
  const followupHoras = followup.horasEspera();
  const followupAtivo = followup.ativo();

  const estado = ativo
    ? '<span class="badge badge--ativa">Ligada</span>'
    : '<span class="badge badge--encerrada">Desligada</span>';

  // Abas de Configurações (Item 4 do ETAPA B "Ajustes no Admin", Commit 8) — primeira vez
  // que abas aparecem no admin. Opcao A: NENHUMA rota muda; o form de notificacoes
  // continua UM SO (/admin/config/notificacoes, os 8 campos), so o VISUAL e que espalha
  // os campos pelas abas. Isso e possivel sem aninhar <form> dentro de <form> (invalido em
  // HTML) porque os inputs desse form usam o atributo `form="form-notificacoes"` — apontam
  // para um <form> vazio declarado uma vez, mesmo estando em divs de aba diferentes. Os
  // demais formularios (whatsapp/email-teste/followup) ficam intactos, so mudam de lugar.
  // Troca de aba e so display (JS abaixo troca `hidden`), nunca re-render — o Jean nao
  // perde o que ja tinha editado em outra aba ao clicar.
  const conteudo = `
    <p><a class="btn btn--ghost" href="/admin">← Voltar ao painel</a></p>
    <h1>Configurações gerais</h1>
    ${salvo}

    <div style="display:flex;gap:.5rem;flex-wrap:wrap;margin-bottom:1.5rem;">
      <a class="btn btn--ghost" href="/admin/roteiro">Editar roteiro</a>
      <a class="btn btn--ghost" href="/admin/perfis-curriculo">Perfis de currículo</a>
      <a class="btn btn--ghost" href="/admin/uso">Custos / Uso API</a>
    </div>

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
    </section>

    <div data-admin-config-tabs>
      <div style="display:flex;gap:.5rem;flex-wrap:wrap;margin:1.5rem 0 1.25rem;">
        <button type="button" class="btn" data-tab-btn="email">E-mail</button>
        <button type="button" class="btn btn--ghost" data-tab-btn="whatsapp">WhatsApp</button>
        <button type="button" class="btn btn--ghost" data-tab-btn="campanhas">Campanhas e Divulgação</button>
        <button type="button" class="btn btn--ghost" data-tab-btn="manutencao">Manutenção</button>
      </div>

      <!-- Vazio de proposito: so existe para os inputs com form="form-notificacoes"
           (espalhados pelas 4 abas abaixo) apontarem para ele. -->
      <form id="form-notificacoes" method="POST" action="/admin/config/notificacoes"></form>

      <div data-tab-painel="email">
        <section class="rel-sec">
          <h2>E-mail</h2>
          <p style="margin:.2rem 0 1rem;color:var(--cinza);font-size:.9rem;">
            Avisos enviados para <b>${escapeHtml(config.recrutador.email || 'RECRUITER_EMAIL não configurado')}</b>.
          </p>
          <label class="campo-check">
            <input type="checkbox" form="form-notificacoes" name="notificar_nova_candidatura" value="1"${notificarNovaCandidatura ? ' checked' : ''}>
            <span style="color:var(--preto);text-transform:none;">
              Avisar por e-mail a cada <b>nova candidatura</b>
            </span>
          </label>
          <label class="campo-check">
            <input type="checkbox" form="form-notificacoes" name="lembrete_inicio_ativo" value="1"${lembreteInicioAtivo ? ' checked' : ''}>
            <span style="color:var(--preto);text-transform:none;">
              Enviar <b>lembrete de início</b> de entrevista
            </span>
          </label>
          <label class="campo-check">
            <input type="checkbox" form="form-notificacoes" name="followup_ativo" value="1"${followupAtivo ? ' checked' : ''}>
            <span style="color:var(--preto);text-transform:none;">
              Enviar <b>follow-up</b> de entrevista não concluída
            </span>
          </label>
          <label class="campo-check">
            <input type="checkbox" form="form-notificacoes" name="email_recusa_ativo" value="1"${emailRecusaAtivo ? ' checked' : ''}>
            <span style="color:var(--preto);text-transform:none;">
              Enviar <b>e-mail de recusa</b> a quem não avançou
            </span>
          </label>
          <button type="submit" form="form-notificacoes" class="btn">Salvar</button>
        </section>

        <section class="rel-sec">
          <h2>Follow-up de entrevista não concluída</h2>
          <p style="margin:.2rem 0 1rem;color:var(--cinza);font-size:.9rem;">
            E-mail automático para quem <b>começou</b> a entrevista e não terminou, com o link
            para continuar de onde parou. Quem apenas se candidatou (e nunca iniciou) não recebe.
          </p>
          <form method="POST" action="/admin/config/followup-entrevista">
            <label class="campo" style="max-width:320px;">
              <span>Horas de espera antes do 1º e-mail</span>
              <input type="number" name="followup_horas" min="1" step="1" value="${escapeHtml(String(followupHoras))}">
            </label>
            <button type="submit" class="btn">Salvar</button>
          </form>
        </section>
      </div>

      <div data-tab-painel="whatsapp" hidden>
        <section class="rel-sec">
          <h2>WhatsApp</h2>
          <p style="margin:.2rem 0 1rem;">
            <a class="btn btn--ghost" href="/admin/whatsapp">WhatsApp (pareamento)</a>
          </p>
          <label class="campo-check">
            <input type="checkbox" form="form-notificacoes" name="whatsapp_sequencia_ativa" value="1"${whatsappSeqAtiva ? ' checked' : ''}>
            <span style="color:var(--preto);text-transform:none;">
              Enviar a <b>sequência de WhatsApp</b> (WA1 e WA2) a cada nova candidatura
            </span>
          </label>
          <label class="campo-check">
            <input type="checkbox" form="form-notificacoes" name="campanha_whatsapp_ativa" value="1"${campanhaWaAtiva ? ' checked' : ''}>
            <span style="color:var(--preto);text-transform:none;">
              Enviar as <b>campanhas por WhatsApp</b> (Meta Cloud API)
            </span>
          </label>
          <button type="submit" form="form-notificacoes" class="btn">Salvar</button>
        </section>

        <section class="rel-sec">
          <h2>Mensagem de WhatsApp</h2>
          <p style="margin:.2rem 0 1rem;color:var(--cinza);font-size:.9rem;">
            Texto pré-preenchido ao clicar em <b>WhatsApp</b> na lista/detalhe do candidato.
          </p>
          <form method="POST" action="/admin/config/whatsapp">
            <label class="campo" style="max-width:420px;">
              <span>Nome do recrutador</span>
              <input type="text" name="recrutador_nome" value="${escapeHtml(recrutadorNome)}" placeholder="${escapeHtml(RECRUTADOR_PADRAO)}">
            </label>
            <label class="campo">
              <span>Template da mensagem</span>
              <textarea name="whatsapp_template" rows="4">${escapeHtml(whatsappTemplate)}</textarea>
            </label>
            <button type="submit" class="btn">Salvar</button>
          </form>
        </section>
      </div>

      <div data-tab-painel="campanhas" hidden>
        <section class="rel-sec">
          <h2>Campanhas e Divulgação</h2>
          <label class="campo-check">
            <input type="checkbox" form="form-notificacoes" name="promocao_ativa" value="1"${promocaoAtiva ? ' checked' : ''}>
            <span style="color:var(--preto);text-transform:none;">
              Enviar as <b>campanhas de Promoção de Vagas</b>
            </span>
          </label>
          <button type="submit" form="form-notificacoes" class="btn">Salvar</button>
        </section>

        <section class="rel-sec">
          <h2>E-mail de teste da Promoção de Vagas</h2>
          <p style="margin:.2rem 0 1rem;color:var(--cinza);font-size:.9rem;">
            Endereço fixo que recebe o botão <b>Enviar e-mail de teste para mim</b> da tela de
            <a href="/admin/promocao">nova campanha</a>.
          </p>
          <form method="POST" action="/admin/config/email-teste-promocao">
            <label class="campo" style="max-width:420px;">
              <span>E-mail de teste</span>
              <input type="email" name="email_teste_promocao" value="${escapeHtml(emailTeste)}"
                placeholder="voce@suaempresa.com.br">
            </label>
            <button type="submit" class="btn">Salvar</button>
          </form>
        </section>
      </div>

      <div data-tab-painel="manutencao" hidden>
        <section class="rel-sec">
          <h2>Manutenção</h2>
          <label class="campo-check">
            <input type="checkbox" form="form-notificacoes" name="limpeza_audio_ativo" value="1"${limpezaAudioAtiva ? ' checked' : ''}>
            <span style="color:var(--preto);text-transform:none;">
              Apagar <b>áudio de entrevistas</b> quando o disco encher
            </span>
          </label>
          <button type="submit" form="form-notificacoes" class="btn">Salvar</button>
        </section>

        <section class="rel-sec">
          <h2>Backup de currículos</h2>
          <p style="margin:.2rem 0 1rem;color:var(--cinza);font-size:.9rem;">
            <code>/data/curriculos</code> não tem limpeza automática (ao contrário do áudio
            de entrevista, acima) — baixe periodicamente os currículos mais antigos que uma
            data e arquive no Google Drive por conta própria. O pacote <code>.tar.gz</code>
            inclui um <code>manifesto.csv</code> com os dados de cada candidato, já que os
            arquivos em disco têm nome opaco. Nada é apagado do servidor por este botão.
          </p>
          <form method="GET" action="/admin/curriculos-backup" class="admin-filtros">
            <label class="filtro">
              <span>Currículos anteriores a</span>
              <input type="date" name="antes" value="${escapeHtml(sugestaoAntesCurriculos)}" required>
            </label>
            <button type="submit" class="btn">Baixar currículos antigos (.tar.gz)</button>
          </form>
        </section>
      </div>
    </div>

    <script>
    (function () {
      var raiz = document.querySelector('[data-admin-config-tabs]');
      if (!raiz) return;
      var botoes = Array.prototype.slice.call(raiz.querySelectorAll('[data-tab-btn]'));
      var paineis = Array.prototype.slice.call(raiz.querySelectorAll('[data-tab-painel]'));
      botoes.forEach(function (botao) {
        botao.addEventListener('click', function () {
          var chave = botao.getAttribute('data-tab-btn');
          botoes.forEach(function (b) { b.classList.toggle('btn--ghost', b !== botao); });
          paineis.forEach(function (p) { p.hidden = p.getAttribute('data-tab-painel') !== chave; });
        });
      });
    })();
    </script>`;

  res.send(paginaAdmin({ titulo: 'Configurações gerais', conteudo }));
});

// ── POST /admin/config/entrevista-automatica ── alterna o toggle geral ──
router.post('/config/entrevista-automatica', (req, res) => {
  const b = req.body || {};
  const ativo = b.ativo === '1' || b.ativo === 'on';
  db.definirConfigBool(CHAVE_ENTREVISTA_AUTO, ativo);
  res.redirect('/admin/config?salvo=1');
});

// ── POST /admin/config/whatsapp ── salva o nome do recrutador + template da mensagem ──
// Ambos TEXT livres (definirConfig). O template vazio e permitido: mensagemWhatsappCandidato
// cai no TEMPLATE_PADRAO quando a chave esta vazia. Sem validacao de placeholders (o helper
// ja ignora desconhecidos e nao quebra).
router.post('/config/whatsapp', (req, res) => {
  const b = req.body || {};
  db.definirConfig('recrutador_nome', String(b.recrutador_nome || '').trim());
  db.definirConfig('whatsapp_template', String(b.whatsapp_template || '').trim());
  res.redirect('/admin/config?salvo=1');
});

// ── POST /admin/config/notificacoes ── liga/desliga o e-mail de nova candidatura ──
// Checkbox: o navegador NAO envia o campo quando desmarcado, entao ausencia = desligar.
// definirConfigBool grava '1'/'0'; quem le (routes/api.js) usa default false.
router.post('/config/notificacoes', (req, res) => {
  const b = req.body || {};
  const marcado = (campo) => b[campo] === '1' || b[campo] === 'on';
  db.definirConfigBool(CHAVE_NOTIFICAR_NOVA_CANDIDATURA, marcado('notificar_nova_candidatura'));
  db.definirConfigBool(CHAVE_LEMBRETE_INICIO_ATIVO, marcado('lembrete_inicio_ativo'));
  db.definirConfigBool(followup.CHAVE_ATIVO, marcado('followup_ativo'));
  db.definirConfigBool(CHAVE_EMAIL_RECUSA_ATIVO, marcado('email_recusa_ativo'));
  db.definirConfigBool(CHAVE_LIMPEZA_AUDIO_ATIVO, marcado('limpeza_audio_ativo'));
  db.definirConfigBool(CHAVE_PROMOCAO_ATIVA, marcado('promocao_ativa'));
  db.definirConfigBool(CHAVE_WHATSAPP_SEQ, marcado('whatsapp_sequencia_ativa'));
  db.definirConfigBool(CHAVE_CAMPANHA_WA, marcado('campanha_whatsapp_ativa'));
  res.redirect('/admin/config?salvo=1');
});

// ── POST /admin/config/email-teste-promocao ── endereco fixo do e-mail de teste ──
//
// TEXT livre (definirConfig), no molde do /config/whatsapp: guarda o que veio, aparado.
// Vazio e valor VALIDO — e como o Jean desliga o botao de teste.
//
// SEM validacao de formato aqui, de proposito: o `type="email"` do campo ja barra o erro
// de digitacao comum no navegador, e a lib confere a forma do endereco no momento do envio
// (erroCodigo DESTINATARIO_INVALIDO) — que e onde a mensagem de fato ajuda, junto do botao
// que falhou. Recusar o save obrigaria a inventar uma tela de erro para /admin/config, que
// hoje so sabe redirecionar com ?salvo=1.
router.post('/config/email-teste-promocao', (req, res) => {
  const b = req.body || {};
  db.definirConfig(CHAVE_EMAIL_TESTE_PROMOCAO, String(b.email_teste_promocao || '').trim());
  res.redirect('/admin/config?salvo=1');
});

// ── POST /admin/config/followup-entrevista ── horas de espera do 1o follow-up ──
// Saneia aqui (inteiro positivo; qualquer outra coisa grava o padrao) E a leitura tambem
// tem fallback proprio em lib/followupEntrevista.horasEspera — um valor estranho que
// chegue ao banco por outro caminho nao vira "manda para todo mundo agora".
router.post('/config/followup-entrevista', (req, res) => {
  const bruto = Number((req.body && req.body.followup_horas) || '');
  const horas =
    Number.isFinite(bruto) && bruto > 0 ? Math.round(bruto) : followup.HORAS_ESPERA_PADRAO;
  db.definirConfig(followup.CHAVE_HORAS_ESPERA, String(horas));
  res.redirect('/admin/config?salvo=1');
});

// ── Promocao de Vagas (/admin/promocao) ──
// Rotas em arquivo proprio (routes/admin_promocao.js) para nao inflar mais este, seguindo
// o precedente de routes/banco_curriculos.js. Montado AQUI, depois do
// `router.use(adminAuth)` la em cima — e o mount que da a essas telas a protecao do
// painel. Mover esta linha para antes daquela deixaria a Promocao de Vagas PUBLICA.
// Os helpers de apresentacao vao por parametro porque este modulo exporta o router, nao
// eles; extrai-los para um modulo compartilhado seria refactor das ~15 telas existentes.
router.use('/promocao', criarRouterPromocao({ paginaAdmin, formatarDataHora, fmtInt }));
// Tela de pareamento do WhatsApp. Sem auth propria — herda o router.use(adminAuth) la em
// cima, igual as demais telas do painel.
router.use('/whatsapp', criarRouterWhatsapp({ paginaAdmin, escapeHtml }));
router.use('/campanhas-whatsapp', criarRouterCampanhaWhatsapp({ paginaAdmin, escapeHtml, fmtInt }));

// ── GET /divulgacao-vagas ── Promoção de Vagas + Campanha por WhatsApp em abas ──
// (Item 3 do ETAPA B "Ajustes no Admin", Commit 7). NAO substitui as rotas standalone
// (/admin/promocao, /admin/campanhas-whatsapp) — elas continuam existindo e sao para onde
// os formularios de cada aba fazem POST/redirect (efeito colateral aceito: uma acao dentro
// da aba tira o operador desta pagina e o leva a tela antiga isolada; ver diagnostico).
// Reaproveita os MESMOS fragmentos de HTML das telas standalone (montarConteudoListagem
// Promocao/montarConteudoCampanhaWhatsapp, extraidos nos Commits 5-6) — sem duplicar logica
// nem HTML. Cada fragmento ja traz seu proprio "Voltar ao painel" e titulo — por isso esta
// pagina nao repete um <h1> proprio, so a barra de abas.
router.get('/divulgacao-vagas', (req, res) => {
  const aba = req.query.aba === 'whatsapp' ? 'whatsapp' : 'promocao';

  const abaLink = (valor, rotulo) =>
    `<a class="btn ${aba === valor ? '' : 'btn--ghost'}" href="/admin/divulgacao-vagas?aba=${valor}">${rotulo}</a>`;

  const conteudo = `
    <div style="display:flex;gap:.5rem;flex-wrap:wrap;margin-bottom:1.25rem;">
      ${abaLink('promocao', 'Promoção de Vagas')}
      ${abaLink('whatsapp', 'Campanha por WhatsApp')}
    </div>
    ${
      aba === 'whatsapp'
        ? montarConteudoCampanhaWhatsapp({ escapeHtml, fmtInt })
        : montarConteudoListagemPromocao({ formatarDataHora, fmtInt })
    }`;

  res.send(paginaAdmin({ titulo: 'Divulgação de Vagas', conteudo }));
});

module.exports = router;
