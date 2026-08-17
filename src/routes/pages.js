'use strict';

// Rotas de PAGINA (HTML). Na Fase 0 sao placeholders que ja aplicam o layout base
// (cabeçalho, fontes, cores, botao laranja) e, onde faz sentido, a barra de progresso
// e o orbe. O conteudo funcional de cada tela entra nas Fases 1-4.

const express = require('express');
const { config } = require('../config');
const db = require('../db');
const session = require('../lib/session');
const entrevista = require('../lib/entrevista');
const { modoEntrevistaAtivo } = require('../lib/modo');
const { extrairUtmDaQuery, lerUtmDoCookie, serializarUtmParaCookie } = require('../lib/utm');
const { mensagemPosEntrevista, mensagemNovaCandidatura, montarLinkWhatsapp } = require('../lib/whatsapp');
const {
  verificarToken,
  lerEmailDaUrl,
  ORIGEM_LINK_EMAIL,
} = require('../lib/descadastro');
const {
  calcularPontuacaoGeral,
  badgeRecomendacaoHtml,
  rotuloNivel,
  textoGap,
  badgeVereditoHtml,
} = require('../lib/relatorio');
const { pagina, escapeHtml } = require('../views');

const router = express.Router();

// Botao primario (laranja) que leva a proxima tela.
function botao(href, texto, variante = 'primario') {
  return `<a class="vm-btn vm-btn--${variante}" href="${href}">${escapeHtml(texto)}</a>`;
}

// Gate de sessao: o middleware vive em lib/session.js (session.exigirCandidato).
const { exigirCandidato } = session;

// Guarda de MODO: bloqueia as telas de ENTREVISTA quando a vaga do candidato esta em
// modo Simples (geral OFF, ou vaga com entrevista_ativa=0). Roda SEMPRE depois de
// exigirCandidato (usa req.candidato). Assim, telas de entrevista nunca ficam
// acessiveis por URL colada / link antigo de e-mail quando o modo e Simples — o
// candidato e mandado para a confirmacao Simples da sua vaga. A decisao de modo vem
// so de lib/modo (fail-safe Completo em caso de erro).
function bloquearSeModoSimples(req, res, next) {
  const vaga = req.candidato ? db.obterVaga(req.candidato.job_id) : null;
  if (vaga && !modoEntrevistaAtivo(vaga)) {
    return res.redirect(`/confirmacao/${vaga.slug}`);
  }
  return next();
}

// Instrumentacao do funil: marca que ESTE candidato chegou a ESTA tela. Fabrica de
// middleware — registrarEtapaFunil('preparacao') devolve o middleware daquela etapa.
//
// Fire-and-forget, mesmo padrao do registro de acesso a vaga (mais abaixo, na /vaga/:slug):
// metrica NUNCA derruba a pagina do candidato. Se o banco estiver em erro, o log guarda o
// rastro e a tela renderiza normalmente — perder um evento de funil e barato, travar um
// candidato no meio da entrevista nao e.
//
// Roda SEMPRE depois de exigirCandidato (precisa de req.candidato) e de
// bloquearSeModoSimples (quem e mandado para o modo Simples nao chegou nesta etapa de
// verdade — contar seria falso-positivo). A guarda do req.candidato e defensiva: se a
// ordem for trocada por engano um dia, o middleware pula em vez de estourar.
//
// So marca a PRIMEIRA passagem — a idempotencia mora na constraint UNIQUE da tabela e no
// ON CONFLICT de db.registrarEventoFunil, nao aqui.
function registrarEtapaFunil(etapa) {
  return function marcarEtapa(req, res, next) {
    try {
      if (req.candidato && req.candidato.id) {
        db.registrarEventoFunil(req.candidato.id, etapa);
      }
    } catch (e) {
      console.error(`[funil] falha ao registrar etapa '${etapa}' (métrica, ignorado):`, e.message);
    }
    return next();
  };
}

// Bloco de placeholder padrao para as telas ainda nao implementadas.
function placeholder({ kicker, titulo, descricao, acao, centro = false, badgeFase = null }) {
  return `
    <section class="vm-hero${centro ? ' vm-hero--centro' : ''}">
      ${kicker ? `<p class="vm-kicker">${escapeHtml(kicker)}</p>` : ''}
      <h1 class="vm-title">${escapeHtml(titulo)}</h1>
      <p class="vm-lead">${escapeHtml(descricao)}</p>
      ${badgeFase ? `<p class="vm-badge-fase">${escapeHtml(badgeFase)}</p>` : ''}
      ${acao || ''}
    </section>`;
}

// ── Home / landing ──
router.get('/', (req, res) => {
  const vaga = db.obterVagaAtiva();
  const acao = vaga
    ? botao(`/vaga/${vaga.slug}`, 'Ver vaga aberta')
    : `<p class="vm-lead">No momento não há vagas abertas. Volte em breve.</p>`;
  res.send(
    pagina({
      titulo: 'Recrutamento de vendedores',
      tema: 'claro',
      comOrbe: true,
      conteudo: placeholder({
        kicker: 'Vendedor Mestre',
        titulo: 'Recrutamento de elite para vendas',
        descricao:
          'Processo seletivo com entrevista por voz conduzida pela Vera, nossa entrevistadora de inteligência artificial.',
        acao,
        centro: true,
      }),
    }),
  );
});

// Os dois guards de /vaga/:slug (nao encontrada / encerrada), compartilhados pela rota
// publica e por /vaga/:slug/confirmacao (link do WA1). Ja responde e devolve null quando a
// vaga nao pode ser mostrada; devolve a vaga quando esta tudo certo, e quem chamou segue.
function carregarVagaOuNull(req, res, slug) {
  const vaga = db.obterVagaPorSlug(slug);
  if (!vaga) {
    res.status(404).send(
      pagina({
        titulo: 'Vaga nao encontrada',
        tema: 'claro',
        conteudo: placeholder({
          titulo: 'Vaga nao encontrada',
          descricao: 'O link da vaga pode estar incorreto.',
          acao: botao('/', 'Voltar ao inicio', 'secundario'),
        }),
      }),
    );
    return null;
  }
  // Vaga encerrada (ativo=0): nao acessivel pelo candidato.
  if (!vaga.ativo) {
    res.status(404).send(
      pagina({
        titulo: 'Vaga encerrada',
        tema: 'claro',
        conteudo: placeholder({
          titulo: 'Vaga encerrada',
          descricao: 'Esta vaga não está mais recebendo candidaturas.',
          acao: botao('/', 'Voltar ao inicio', 'secundario'),
        }),
      }),
    );
    return null;
  }
  return vaga;
}

// Conteudo da vaga (headline, ganhos, selos, descricao, listas, skills, secoes extras,
// sobre a empresa) — tudo que /vaga/:slug e /vaga/:slug/confirmacao mostram IGUAL. So o CTA
// final (Aplicar vs. Voltar para o WhatsApp) muda entre as duas rotas, e por isso fica de
// fora daqui.
function montarConteudoVaga(vaga) {
  const esc = escapeHtml;

  // Monta uma <section> "titulo (h2) + lista". Retorna '' quando nao ha itens
  // (oculta a secao vazia). O titulo ja vem com o emoji de apoio e e texto de
  // tela controlado por nos; os itens sao dados da vaga, entao passam por esc().
  const secaoLista = (titulo, itens) => {
    const lis = (itens || []).map((i) => `<li>${esc(i)}</li>`).join('');
    return lis
      ? `<section class="vm-secao">
          <h2 class="vm-h2">${titulo}</h2>
          <ul class="vm-lista">${lis}</ul>
        </section>`
      : '';
  };

  // Chips de competências (skills).
  const chips = (vaga.skills || []).map((s) => `<span class="vm-chip">${esc(s)}</span>`).join('');
  const secaoSkills = chips
    ? `<section class="vm-secao">
        <h2 class="vm-h2">🎯 Competências</h2>
        <div class="vm-chips">${chips}</div>
      </section>`
    : '';

  // Seções extras editáveis (cada uma: título do recrutador + lista). O título e o
  // texto dos itens sao dados da vaga, entao ambos passam por esc().
  const secoesExtras = (vaga.secoes_extras || [])
    .filter((s) => s && s.titulo)
    .map((s) => {
      const lis = (s.itens || []).map((i) => `<li>${esc(i)}</li>`).join('');
      return `<section class="vm-secao">
          <h2 class="vm-h2">📌 ${esc(s.titulo)}</h2>
          ${lis ? `<ul class="vm-lista">${lis}</ul>` : ''}
        </section>`;
    })
    .join('');

  // Selos compactos (chips escuros) com os detalhes preenchidos da vaga. Cada selo
  // so aparece se o campo tiver valor. modalidade vem em minusculo no banco; exibimos
  // capitalizada. Ordem: endereco, modalidade, regime, horario.
  const capitalizar = (s) => (s ? s.charAt(0).toUpperCase() + s.slice(1) : s);
  const selos = [
    vaga.endereco ? ['📍', vaga.endereco] : null,
    vaga.modalidade ? ['🏢', capitalizar(vaga.modalidade)] : null,
    vaga.regime ? ['📄', vaga.regime] : null,
    vaga.horario ? ['🕐', vaga.horario] : null,
  ]
    .filter(Boolean)
    .map(([emoji, txt]) => `<span class="vm-selo">${emoji} ${esc(txt)}</span>`)
    .join('');
  const secaoSelos = selos ? `<div class="vm-selos">${selos}</div>` : '';

  return `
    <article class="vm-vaga">
      <p class="vm-kicker">Vaga aberta · Perfil ${esc(vaga.perfil)}</p>
      <h1 class="vm-title">${esc(vaga.titulo)}</h1>
      ${vaga.faixa_pagamento ? `<p class="vm-pay-chip">${esc(vaga.faixa_pagamento)}</p>` : ''}
      ${
        vaga.potencial_ganhos
          ? `<div class="vm-ganhos">
              <p class="vm-ganhos__rotulo">💰 Potencial de ganhos</p>
              <p class="vm-ganhos__valor">${esc(vaga.potencial_ganhos)}</p>
            </div>`
          : ''
      }
      ${secaoSelos}
      ${vaga.descricao ? `<p class="vm-lead">${esc(vaga.descricao)}</p>` : ''}
      ${secaoLista('📋 Atividades', vaga.atividades)}
      ${secaoLista('✅ Requisitos', vaga.requisitos)}
      ${secaoLista('🎁 Benefícios', vaga.beneficios)}
      ${secaoSkills}
      ${secoesExtras}
      ${
        vaga.sobre_empresa
          ? `<section class="vm-secao">
              <h2 class="vm-h2">🏢 Sobre a empresa</h2>
              <div class="vm-card"><p>${esc(vaga.sobre_empresa)}</p></div>
            </section>`
          : ''
      }
    </article>`;
}

// ── Tela 1: Vaga ──
router.get('/vaga/:slug', (req, res) => {
  const vaga = carregarVagaOuNull(req, res, req.params.slug);
  if (!vaga) return;

  // Origem do lead (first-touch): captura os cinco parametros UTM da query da campanha
  // num cookie proprio (vm_utm, JSON). NAO ha sessao de servidor nesta etapa; o cookie
  // sobrevive ao hop /vaga -> /aplicar e e lido no POST /api/aplicacao.
  // First-touch: se o cookie vm_utm JA EXISTE, ele prevalece — nunca sobrescreve a
  // primeira origem, independentemente da query atual. So gravamos quando ainda nao ha
  // cookie E ha UTM na query. Sem UTM na query e sem cookie: nada a fazer (o literal
  // 'direto' e decidido so no momento da aplicacao, nao aqui).
  const cookieBruto = (req.cookies && req.cookies.vm_utm) || '';
  const utmQuery = extrairUtmDaQuery(req.query);
  // UTM efetiva desta visita: com cookie, vale o cookie (first-touch); senao, a query.
  const utmEfetiva = cookieBruto ? lerUtmDoCookie(cookieBruto) : utmQuery;

  if (!cookieBruto && utmQuery) {
    res.cookie('vm_utm', serializarUtmParaCookie(utmQuery), {
      httpOnly: true,
      sameSite: 'lax',
      maxAge: 30 * 24 * 60 * 60 * 1000,
      path: '/',
    });
  }

  // Registra o acesso (topo do funil) em fire-and-forget: nunca bloqueia nem quebra
  // o render por causa de metrica. So chega aqui apos os gates 404/inativa acima.
  // Passa a UTM efetiva para atribuir o acesso a uma origem (null quando nao ha UTM).
  // `campanha_id` sai da QUERY desta visita, e NAO do cookie: ele responde "este acesso foi
  // um clique naquele e-mail", enquanto a UTM acima responde "de onde essa pessoa veio da
  // primeira vez". Guardar a campanha no cookie faria todo retorno organico dos 30 dias
  // seguintes contar como clique de novo.
  //
  // Sem saneamento aqui de proposito: registrarAcessoVaga valida o id contra `campanhas` e
  // grava NULL se nao existir. Um link velho ou um id digitado a mao nao pode impedir o
  // registro do acesso.
  try {
    // `campanha_whatsapp_id` e parametro IRMAO de `campanha_id`, nao substituto: as duas
    // campanhas vivem em tabelas diferentes, com ids independentes.
    db.registrarAcessoVaga(
      vaga.id,
      utmEfetiva,
      req.query && req.query.campanha_id,
      req.query && req.query.campanha_whatsapp_id,
    );
  } catch (e) {
    console.error('[vaga] falha ao registrar acesso (métrica, ignorado):', e.message);
  }

  const conteudo = `${montarConteudoVaga(vaga)}
    <div class="vm-cta-fixa">
      ${botao(`/aplicar/${vaga.slug}`, 'Aplicar')}
    </div>`;

  res.send(pagina({ titulo: vaga.titulo, tema: 'claro', conteudo }));
});

// ── Tela 1B: Confirmacao (link do WA1) — mesmo conteudo da vaga, sem CTA de candidatura ──
//
// Usada SO pelo link que o WA1 envia (lib/whatsappSequencia.js#linkVaga), para quem JA se
// candidatou. Por isso NAO repete a captura de UTM/cookie nem registrarAcessoVaga da rota
// acima: essa visita nao e um acesso de topo de funil, e contar como tal inflaria a
// atribuicao de origem com retornos de gente que ja aplicou.
router.get('/vaga/:slug/confirmacao', (req, res) => {
  const vaga = carregarVagaOuNull(req, res, req.params.slug);
  if (!vaga) return;

  // Telefone invalido/ausente -> null -> sem botao, e nao um link quebrado.
  const linkWhatsapp = montarLinkWhatsapp(config.recrutador.whatsapp);
  const conteudo = `${montarConteudoVaga(vaga)}
    ${linkWhatsapp ? `<div class="vm-cta-fixa">${botao(linkWhatsapp, 'VOLTAR PARA O WHATSAPP')}</div>` : ''}`;

  res.send(pagina({ titulo: vaga.titulo, tema: 'claro', conteudo }));
});

// ── Tela 2: Aplicacao (passo unico) ──
function formularioAplicacao(vaga) {
  const opcoesDdi = [
    ['+55', 'Brasil +55'],
    ['+1', 'EUA/Canadá +1'],
    ['+351', 'Portugal +351'],
    ['+44', 'Reino Unido +44'],
    ['+34', 'Espanha +34'],
  ]
    .map(
      ([v, rotulo], i) =>
        `<option value="${v}"${i === 0 ? ' selected' : ''}>${escapeHtml(rotulo)}</option>`,
    )
    .join('');

  return `
  <form id="form-aplicacao" class="vm-form" enctype="multipart/form-data" novalidate>
    <input type="hidden" name="slug" value="${escapeHtml(vaga.slug)}">

    <p class="vm-form-erro" data-erro hidden role="alert"></p>

    <section class="vm-passo">
      <h1 class="vm-title">Candidate-se agora</h1>
      <p class="vm-lead">Vaga: ${escapeHtml(vaga.titulo)}</p>

      <div class="vm-grid2">
        <label class="vm-campo">Nome
          <input type="text" name="nome" autocomplete="given-name" required>
        </label>
        <label class="vm-campo">Sobrenome
          <input type="text" name="sobrenome" autocomplete="family-name" required>
        </label>
      </div>

      <label class="vm-campo">E-mail
        <input type="email" name="email" autocomplete="email" required>
      </label>

      <div class="vm-campo">Telefone
        <div class="vm-tel">
          <select name="ddi" aria-label="Código do país">${opcoesDdi}</select>
          <input type="tel" name="telefone" inputmode="tel" placeholder="(11) 90000-0000" required>
        </div>
      </div>

      <label class="vm-campo">URL do LinkedIn
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
        <span>Concordo com a coleta e uso dos meus dados (nome, e-mail, telefone, LinkedIn e
        currículo) para este processo seletivo e futuras oportunidades de vendas na Vendedor
        Mestre. Posso solicitar a remoção a qualquer momento.</span>
      </label>

      <button type="submit" class="vm-btn vm-btn--primario" data-enviar disabled>Candidatar-me</button>
    </section>
  </form>`;
}

router.get('/aplicar/:slug', (req, res) => {
  const vaga = db.obterVagaPorSlug(req.params.slug);
  if (!vaga) {
    return res.status(404).send(
      pagina({
        titulo: 'Vaga nao encontrada',
        tema: 'claro',
        conteudo: placeholder({
          titulo: 'Vaga nao encontrada',
          descricao: 'O link da vaga pode estar incorreto.',
          acao: botao('/', 'Voltar ao inicio', 'secundario'),
        }),
      }),
    );
  }
  // Vaga encerrada (ativo=0): nao aceita novas candidaturas.
  if (!vaga.ativo) {
    return res.status(404).send(
      pagina({
        titulo: 'Vaga encerrada',
        tema: 'claro',
        conteudo: placeholder({
          titulo: 'Vaga encerrada',
          descricao: 'Esta vaga não está mais recebendo candidaturas.',
          acao: botao('/', 'Voltar ao inicio', 'secundario'),
        }),
      }),
    );
  }

  res.send(
    pagina({
      titulo: `Candidatar-se — ${vaga.titulo}`,
      tema: 'claro',
      etapa: 1,
      conteudo: formularioAplicacao(vaga),
    }),
  );
});

// Resolve a vaga + roteiro do candidato (pela sessao) ou da vaga ativa.
function vagaERoteiroDaSessao(req) {
  const candidato = req.candidato || session.loadCandidato(req);
  const vaga = candidato ? db.obterVaga(candidato.job_id) : db.obterVagaAtiva();
  const roteiro = vaga && vaga.roteiro_id ? db.obterRoteiro(vaga.roteiro_id) : null;
  return { candidato, vaga, roteiro };
}

// Estima a duracao (faixa em minutos) a partir do roteiro (orientado a dados).
function estimarDuracao(roteiro) {
  const n = entrevista.montarPerguntas(roteiro).length;
  // Roteiro vazio cai no fallback de 1 pergunta; usa 6 como base de estimativa.
  const base = n > 1 ? n : 6;
  const min = Math.max(10, Math.round(base * 1.5));
  const max = Math.max(min, Math.round(base * 2));
  return { min, max };
}

// ── Tela 3: Preparacao (protegida) ──
// Monta a pagina de preparacao a partir da vaga/roteiro da SESSAO do candidato.
// Compartilhada entre /preparacao (back-compat) e /preparacao/:slug (URL por etapa
// p/ rastreio no GTM). A vaga vem sempre da sessao, nunca da slug da URL.
function paginaPreparacao(req) {
  const { candidato, vaga, roteiro } = vagaERoteiroDaSessao(req);
  const tituloVaga = vaga ? vaga.titulo : 'em aberto';
  const { min, max } = estimarDuracao(roteiro);

  // Item 8 — se a vaga tem video introdutorio, o "Pode começar" leva primeiro a essa
  // etapa (que depois segue para /permissao-camera); sem video, vai direto as permissoes.
  // Evita o hop de redirect no caso comum (com video).
  const destinoInicio = vaga && vaga.video_intro_ref ? `/video/${vaga.slug}` : '/permissao-camera';

  const competencias = entrevista.normalizarEstrutura(roteiro).competencias;
  const chipsTopicos = competencias.length
    ? competencias
        .map((c) => `<span class="vm-chip">${escapeHtml(c.nome)}</span>`)
        .join('')
    : '<span class="vm-chip">Experiência e fechamento em vendas</span>';

  const conteudo = `
    <section class="vm-hero">
      ${candidato ? `<p class="vm-kicker">Olá, ${escapeHtml(candidato.nome)}</p>` : ''}
      <h1 class="vm-title">Preparação para a entrevista</h1>
      <p class="vm-lead">Você está a um passo de avançar para a vaga ${escapeHtml(tituloVaga)}.</p>
    </section>

    <p class="vm-aviso">Esta entrevista é conduzida pela Vera, nossa entrevistadora de inteligência artificial. Ela pergunta por voz, ouve suas respostas e adapta a conversa ao que você diz — não é uma pessoa, é uma IA. Responda com naturalidade, como faria com qualquer recrutador.</p>

    <section class="vm-secao">
      <h2 class="vm-h2">O que esperar</h2>
      <div class="vm-card">
        <dl class="vm-info">
          <dt>Formato</dt>
          <dd>Entrevista por áudio e vídeo com a Vera, nossa agente de recrutamento com inteligência artificial. Você interage pelo botão “toque para falar”.</dd>
          <dt>Duração estimada</dt>
          <dd>~${min}–${max} minutos.</dd>
          <dt>Áreas de foco</dt>
          <dd><div class="vm-chips">${chipsTopicos}</div></dd>
        </dl>
      </div>
    </section>

    <section class="vm-secao">
      <h2 class="vm-h2">Antes de começar</h2>
      <ul class="vm-lista">
        <li>Escolha um ambiente silencioso, sem interrupções, com internet estável.</li>
        <li>É por áudio e vídeo: use o botão <b>“toque para falar”</b> — toque para começar a responder e toque de novo para terminar cada resposta.</li>
        <li>Precisa de mais clareza? Peça à Vera para repetir a pergunta.</li>
        <li>Permita o acesso ao microfone quando solicitado. A câmera é opcional, mas, se permitida, sua entrevista será gravada em vídeo (imagem e áudio).</li>
        <li>Funciona no celular ou no computador.</li>
      </ul>
    </section>

    <p class="vm-aviso">Não atualize a página durante a entrevista.</p>
    <p class="vm-rodape-nota">Um link para esta entrevista também foi enviado ao seu e-mail.</p>

    <p class="vm-consentimento">Esta entrevista é gravada em áudio e, se você permitir a câmera, também em vídeo (imagem e áudio). As gravações são analisadas pela nossa equipe de recrutamento para fins de avaliação no processo seletivo.</p>

    ${botao(destinoInicio, 'Pode começar')}`;

  return pagina({ titulo: 'Preparação para a entrevista', tema: 'claro', etapa: 2, conteudo });
}

// /preparacao (sem slug): back-compat (links antigos, redirect de /instrucoes).
router.get(
  '/preparacao',
  exigirCandidato,
  bloquearSeModoSimples,
  registrarEtapaFunil('preparacao'),
  (req, res) => {
    res.send(paginaPreparacao(req));
  },
);

// /preparacao/:slug: mesma pagina, com a slug da vaga na URL p/ diferenciar o lead
// por vaga no GTM. A vaga real e sempre a da SESSAO: se a slug da URL nao bater com
// a da sessao, redireciona para a slug correta (sem confiar na URL).
// A marcacao do funil vem como middleware (antes do handler), entao acontece tambem no
// caminho do redirect de slug divergente. Nao e falso-positivo: o destino do redirect e a
// MESMA etapa, e o candidato chegou a preparacao de um jeito ou de outro. Contrasta com
// /video/:slug, onde o redirect leva a OUTRA etapa e a marcacao precisa ficar no handler.
router.get(
  '/preparacao/:slug',
  exigirCandidato,
  bloquearSeModoSimples,
  registrarEtapaFunil('preparacao'),
  (req, res) => {
    const { vaga } = vagaERoteiroDaSessao(req);
    if (vaga && vaga.slug && req.params.slug !== vaga.slug) {
      return res.redirect(`/preparacao/${vaga.slug}`);
    }
    return res.send(paginaPreparacao(req));
  },
);

// ── Tela de vídeo introdutório (Item 8) — GET /video/:slug ──
// Etapa condicional: exibida ANTES das permissões, só quando a vaga tem um vídeo
// institucional (YouTube não listado) configurado. Sem vídeo, a etapa é PULADA
// (redirect direto p/ /permissao-camera) — nunca renderiza vazia. A vaga vem SEMPRE da
// sessão (não da slug da URL); slug divergente redireciona para a correta, igual à
// /preparacao/:slug. Gating "assistir até o fim" no client (app.js): o botão "Continuar"
// nasce disabled e só habilita quando o player emite o evento de fim (fail-open se o
// player do YouTube não puder carregar — nunca prende o candidato). Etapa 2 (Preparação):
// não adiciona segmento à barra de progresso (as 4 macro-etapas continuam fixas).
router.get('/video/:slug', exigirCandidato, bloquearSeModoSimples, (req, res) => {
  const { vaga } = vagaERoteiroDaSessao(req);
  // Sem vídeo configurado: pula a etapa inteira (não exibe tela vazia).
  if (!vaga || !vaga.video_intro_ref) {
    return res.redirect('/permissao-camera');
  }
  // A vaga real é a da sessão: se a slug da URL divergir, corrige (não confia na URL).
  if (vaga.slug && req.params.slug !== vaga.slug) {
    return res.redirect(`/video/${vaga.slug}`);
  }

  // Instrumentacao do funil: aqui NAO da para usar o middleware registrarEtapaFunil, que
  // rodaria antes do handler e portanto antes dos dois returns acima. Esta e a unica das
  // seis etapas cuja tela pode nao existir: sem video_intro_ref a rota redireciona direto
  // para /permissao-camera, e hoje NENHUMA vaga tem video configurado — marcar antes do if
  // registraria 'video' para 100% dos candidatos que nunca viram video nenhum, e a etapa
  // apareceria como a mais saudavel do funil justamente por nao existir.
  //
  // Fica depois TAMBEM do redirect de slug divergente (mais estrito que as outras cinco
  // etapas): assim a linha significa "a tela de video renderizou de verdade", nunca "a
  // rota foi chamada". Nao se perde nada — o redirect de slug reentra nesta mesma rota com
  // a slug correta e marca ali.
  //
  // try/catch pelo mesmo motivo do middleware: metrica nunca derruba a pagina.
  try {
    db.registrarEventoFunil(req.candidato.id, 'video');
  } catch (e) {
    console.error("[funil] falha ao registrar etapa 'video' (métrica, ignorado):", e.message);
  }

  const videoId = escapeHtml(vaga.video_intro_ref);
  const conteudo = `
    <section class="vm-hero vm-hero--centro" data-tela-video-intro>
      <p class="vm-kicker">Antes de começar</p>
      <h1 class="vm-title">Conheça a empresa e a oportunidade</h1>
      <p class="vm-lead">Assista ao vídeo abaixo até o final para liberar o próximo passo. Ele explica a empresa, a rotina e a remuneração da vaga.</p>

      <div style="position:relative;width:100%;max-width:720px;margin:1.25rem auto;aspect-ratio:16/9;background:#000;border-radius:12px;overflow:hidden">
        <iframe id="video-intro-player"
          style="position:absolute;inset:0;width:100%;height:100%;border:0"
          src="https://www.youtube-nocookie.com/embed/${videoId}?enablejsapi=1&rel=0&modestbranding=1"
          title="Vídeo introdutório da vaga"
          allow="autoplay; encrypted-media; picture-in-picture"
          allowfullscreen></iframe>
      </div>

      <p class="vm-rodape-nota" data-video-dica>O botão “Continuar” é liberado quando o vídeo termina.</p>

      <div class="vm-acoes">
        <button type="button" class="vm-btn vm-btn--primario" data-continuar-video disabled aria-disabled="true">Continuar</button>
      </div>
    </section>
    <script src="https://www.youtube.com/iframe_api"></script>`;

  return res.send(pagina({ titulo: 'Vídeo introdutório', tema: 'claro', etapa: 2, conteudo }));
});

// Monta a pagina de confirmacao do modo Simples. O botao de WhatsApp e um LINK <a> (o
// disparo e o CLIQUE do usuario — nunca window.open automatico, que o mobile bloqueia).
// O numero vem SO de RECRUITER_WHATSAPP (env); a mensagem e montada no SERVIDOR a partir
// dos dados da application + titulo da vaga e vai URL-encoded. Sem numero: botao
// desabilitado + aviso no log (a pagina ainda renderiza).
function paginaConfirmacaoSimples({ candidato, vaga }) {
  const nome = nomeCandidato(candidato); // ja junta nome + sobrenome (fallback: e-mail)
  const tituloVaga = (vaga && vaga.titulo) || 'a vaga'; // texto da TELA (o da mensagem vai cru)

  const numero = String(config.recrutador.whatsapp || '').replace(/\D/g, ''); // wa.me: so digitos
  // Resumo da candidatura para o recrutador, montado por mensagemNovaCandidatura
  // (lib/whatsapp). Agora COM a empresa da vaga: jobs.empresa passou a existir e o
  // recrutador precisa saber de qual processo veio a mensagem. Empresa vazia -> a linha
  // inteira nao e emitida (regra na propria funcao). \n vira quebra de linha no WhatsApp
  // apos o encodeURIComponent.
  //
  // Campos vao CRUS: os fallbacks ("não informado", "não informada") sao da funcao. Em
  // especial o titulo, que aqui NAO usa tituloVaga — "Vaga: a vaga" ficaria estranho no
  // resumo; sem vaga, a funcao escreve "não informada".
  const mensagem = mensagemNovaCandidatura({
    nome,
    email: candidato && candidato.email,
    telefone: candidato && candidato.telefone,
    vaga: vaga && vaga.titulo,
    empresa: vaga && vaga.empresa,
  });

  let botao;
  let autoAbrir = '';
  if (numero) {
    // encodeURIComponent no texto: tambem neutraliza aspas/&, entao o href e seguro no atributo.
    const href = `https://wa.me/${numero}?text=${encodeURIComponent(mensagem)}`;
    botao = `<a class="vm-btn vm-btn--primario" href="${href}" target="_blank" rel="noopener noreferrer" data-wa-auto>Avisar recrutador no WhatsApp</a>`;
    // BONUS best-effort: tenta abrir o WhatsApp automaticamente ao carregar. NAO e o
    // caminho garantido — a maioria dos navegadores (sobretudo mobile) bloqueia
    // window.open sem gesto do usuario, entao isso falha SILENCIOSAMENTE na maior parte
    // dos acessos. O link <a> visivel acima continua sendo o caminho real. Le o href do
    // proprio <a> (evita qualquer problema de escape ao reinjetar a URL no script).
    autoAbrir = `
    <script>
      (function () {
        var a = document.querySelector('[data-wa-auto]');
        if (!a) return;
        try { window.open(a.href, '_blank', 'noopener'); } catch (e) { /* ok: o botao e o fallback */ }
      })();
    </script>`;
  } else {
    console.warn('[confirmacao] RECRUITER_WHATSAPP ausente; botão de WhatsApp desabilitado.');
    botao = `<button type="button" class="vm-btn vm-btn--primario" disabled aria-disabled="true">Avisar recrutador no WhatsApp</button>
      <p class="vm-rodape-nota">O canal de WhatsApp ainda não está configurado. Nossa equipe entrará em contato pelos dados da sua candidatura.</p>`;
  }

  const conteudo = `
    <section class="vm-hero vm-hero--centro">
      <p class="vm-kicker">Candidatura recebida</p>
      <h1 class="vm-title">Tudo certo, ${escapeHtml(candidato.nome || nome)}!</h1>
      <p class="vm-lead">Recebemos sua candidatura para a vaga ${escapeHtml(tituloVaga)}. <b>Para que ela seja avaliada, é obrigatório falar com nosso recrutador no WhatsApp</b> — toque no botão abaixo para falar com ele agora.</p>
      <div class="vm-acoes">
        ${botao}
      </div>
    </section>${autoAbrir}`;

  return pagina({ titulo: 'Candidatura recebida', tema: 'claro', conteudo });
}

// ── Confirmacao (modo SIMPLES) — GET /confirmacao/:slug ──
// Destino do candidato quando a vaga opera em modo Simples: confirma o recebimento da
// candidatura e oferece um botao para avisar o recrutador no WhatsApp. Sem preparacao,
// permissoes, entrevista nem relatorio. A vaga real vem SEMPRE da sessao (nao da slug);
// se a slug da URL divergir, redireciona para a correta. Se a vaga for, na verdade,
// modo Completo, manda o candidato ao fluxo de entrevista (cada pagina serve so o seu modo).
router.get('/confirmacao/:slug', exigirCandidato, (req, res) => {
  const candidato = req.candidato;
  const vaga = db.obterVaga(candidato.job_id);

  if (vaga && modoEntrevistaAtivo(vaga)) {
    return res.redirect(`/preparacao/${vaga.slug}`);
  }
  if (vaga && vaga.slug && req.params.slug !== vaga.slug) {
    return res.redirect(`/confirmacao/${vaga.slug}`);
  }

  return res.send(paginaConfirmacaoSimples({ candidato, vaga }));
});

// ── Tela 4: Identificacao (fallback — so para quem volta sem sessao) ──
router.get('/identificacao', (req, res) => {
  const retomar = typeof req.query.retomar === 'string' ? req.query.retomar : '';
  const conteudo = `
    <form id="form-identificacao" class="vm-form" novalidate>
      <input type="hidden" name="retomar" value="${escapeHtml(retomar)}">
      <h1 class="vm-title">Informe seus dados</h1>
      <p class="vm-lead">Use o e-mail da sua candidatura e o código de acesso que enviamos para você.</p>

      <p class="vm-form-erro" data-erro hidden role="alert"></p>

      <label class="vm-campo">E-mail
        <input type="email" name="email" autocomplete="email" required>
      </label>

      <label class="vm-campo">Código de acesso
        <input type="text" name="codigo" autocomplete="one-time-code" placeholder="Código enviado por e-mail" required>
      </label>

      <button type="submit" class="vm-btn vm-btn--primario" data-enviar>Continuar</button>
    </form>`;

  res.send(pagina({ titulo: 'Identificação', tema: 'claro', etapa: 1, conteudo }));
});

// ── Retomada automatica por link (e-mail "continuar depois") ──
// Valida o token da query (mesmo token opaco da application), restaura o cookie de
// sessao e manda direto para /permissao-camera — SEM passar pela tela de
// Identificacao: o link unico e nao-adivinhavel ja autentica o candidato.
router.get('/retomar', (req, res) => {
  const token = String(req.query.token || '').trim();
  const aplicacao = token ? db.obterAplicacaoPorToken(token) : null;
  if (!aplicacao) {
    return paginaAviso(res, 404, {
      titulo: 'Link inválido ou expirado',
      descricao:
        'Este link de retomada não é válido. Confira o link enviado por e-mail ou refaça sua identificação.',
    });
  }
  session.setToken(res, aplicacao.token);
  return res.redirect('/permissao-camera');
});

// ── Tela 5: Instrucoes — FUNDIDA em /preparacao. Mantida como redirect 302 p/ nao
// quebrar links antigos (e-mail/marcador). O conteudo agora vive em /preparacao. ──
router.get('/instrucoes', exigirCandidato, (req, res) => res.redirect(302, '/preparacao'));

// ── Tela 6: Permissao de camera (OBRIGATORIA). A entrevista e GRAVADA em video; sem
// camera nao ha entrevista. Quando a permissao e negada/indisponivel, o JS troca o
// pedido pela tela de bloqueio (data-cam-bloqueio) com a opcao de receber um link por
// e-mail para retomar depois — nao existe mais "continuar sem camera". ──
router.get(
  '/permissao-camera',
  exigirCandidato,
  bloquearSeModoSimples,
  registrarEtapaFunil('permissao_camera'),
  (req, res) => {
  const conteudo = `
    <section class="vm-hero vm-hero--centro" data-tela-permissao-camera>
      <div data-cam-pedido>
        <p class="vm-kicker">Câmera</p>
        <h1 class="vm-title">Permissão de câmera</h1>
        <p class="vm-lead">Sua entrevista é gravada em vídeo (imagem e áudio) e analisada pela nossa equipe de recrutamento como parte da avaliação. A câmera é obrigatória para realizar a entrevista.</p>

        <p class="vm-form-erro" data-cam-erro hidden role="alert"></p>

        <div class="vm-acoes">
          <button type="button" class="vm-btn vm-btn--primario" data-permitir-camera>Permitir câmera e gravar</button>
        </div>

        <p class="vm-rodape-nota">
          No iPhone (Safari), a câmera exige conexão segura (HTTPS) e a permissão é solicitada ao tocar no botão.
        </p>
      </div>

      <div data-cam-bloqueio hidden>
        <p class="vm-kicker">Câmera</p>
        <h1 class="vm-title">Câmera necessária</h1>
        <p class="vm-lead">A entrevista é gravada em vídeo e áudio, então a câmera é obrigatória. Se você não pode usar a câmera agora, enviamos um link para o seu e-mail para continuar a entrevista depois, em um dispositivo com câmera.</p>

        <div class="vm-acoes">
          <button type="button" class="vm-btn vm-btn--primario" data-enviar-link>Receber link por e-mail para continuar depois</button>
        </div>

        <p class="vm-status" data-cam-bloqueio-status aria-live="polite" hidden></p>
      </div>
    </section>`;

  res.send(pagina({ titulo: 'Permissão de câmera', tema: 'claro', etapa: 3, conteudo }));
});

// ── Tela 7: Teste de camera (preview ao vivo). A gravacao em si comeca na entrevista;
// aqui so confirmamos o enquadramento e reforcamos que havera gravacao em video. ──
router.get(
  '/teste-camera',
  exigirCandidato,
  bloquearSeModoSimples,
  registrarEtapaFunil('teste_camera'),
  (req, res) => {
  const conteudo = `
    <section class="vm-hero vm-hero--centro" data-tela-teste-camera>
      <p class="vm-kicker">Câmera</p>
      <h1 class="vm-title">Confira sua câmera</h1>

      <div class="vm-video-wrap">
        <video data-preview-camera autoplay muted playsinline></video>
      </div>

      <p class="vm-lead">Está tudo certo? Você aparece na imagem? Sua entrevista será gravada em vídeo a partir da próxima etapa, para análise da nossa equipe.</p>
      <p class="vm-form-erro" data-cam-erro hidden role="alert"></p>

      <div class="vm-acoes">
        <a class="vm-btn vm-btn--primario" href="/permissao-microfone" data-continuar>Continuar</a>
      </div>
    </section>`;

  res.send(pagina({ titulo: 'Confira sua câmera', tema: 'claro', etapa: 3, conteudo }));
});

// ── Tela 8: Permissao de microfone (obrigatorio — canal principal da entrevista) ──
router.get(
  '/permissao-microfone',
  exigirCandidato,
  bloquearSeModoSimples,
  registrarEtapaFunil('permissao_microfone'),
  (req, res) => {
  const conteudo = `
    <section class="vm-hero vm-hero--centro">
      <p class="vm-kicker">Microfone</p>
      <h1 class="vm-title">Permissão de microfone</h1>
      <p class="vm-lead">A entrevista é por áudio e vídeo. Precisamos do seu microfone para ouvir as suas respostas.</p>

      <p class="vm-form-erro" data-mic-erro hidden role="alert"></p>

      <div class="vm-acoes">
        <button type="button" class="vm-btn vm-btn--primario" data-permitir-mic>Permitir microfone</button>
        <button type="button" class="vm-btn vm-btn--secundario" data-tentar-mic hidden>Tentar de novo</button>
      </div>

      <p class="vm-rodape-nota">
        No iPhone (Safari), o microfone exige conexão segura (HTTPS) e a permissão é solicitada ao tocar no botão.
      </p>
    </section>`;

  res.send(pagina({ titulo: 'Permissão de microfone', tema: 'claro', etapa: 3, conteudo }));
});

// ── Tela 9: Teste de microfone (medidor de nivel via Web Audio — sem gravar) ──
router.get(
  '/teste-microfone',
  exigirCandidato,
  bloquearSeModoSimples,
  registrarEtapaFunil('teste_microfone'),
  (req, res) => {
  const conteudo = `
    <section class="vm-hero vm-hero--centro" data-tela-teste-mic>
      <p class="vm-kicker">Microfone</p>
      <h1 class="vm-title">Teste seu microfone</h1>
      <p class="vm-lead">Toque em FALAR e leia a frase em voz alta.</p>

      <blockquote class="vm-frase-teste">"Testando, você me ouve, Vera?"</blockquote>

      <div class="vm-medidor" role="img" aria-label="Nível do microfone">
        <div class="vm-medidor__nivel" data-nivel-mic></div>
      </div>

      <p class="vm-status" data-status-mic aria-live="polite"></p>
      <p class="vm-form-erro" data-mic-erro hidden role="alert"></p>

      <label class="vm-aceite">
        <input type="checkbox" required data-consentimento-gravacao>
        <span>Estou ciente de que esta entrevista será gravada em áudio e, se eu permitir a
        câmera, também em vídeo. As gravações serão usadas exclusivamente para avaliação neste
        processo seletivo.</span>
      </label>

      <div class="vm-acoes">
        <button type="button" class="vm-btn vm-btn--secundario" data-falar>Falar</button>
        <button type="button" class="vm-btn vm-btn--primario" data-continuar-mic disabled>Continuar</button>
      </div>

      <p class="vm-nota-seguranca" data-nota-seguranca aria-live="polite" hidden></p>
      <a class="vm-link-discreto" href="/entrevista" data-continuar-assim>Continuar mesmo assim</a>
    </section>`;

  res.send(pagina({ titulo: 'Teste seu microfone', tema: 'claro', etapa: 3, conteudo }));
});

// ── Tela 10: Entrevista (push-to-talk com a Vera) ──
router.get('/entrevista', exigirCandidato, bloquearSeModoSimples, (req, res) => {
  // Guarda de reentrada: candidato que JA concluiu a entrevista nao pode reabrir a
  // interface (antes, o /start ate criava uma entrevista nova). Mostramos um card de
  // "entrevista concluida" na propria rota — sem redirect silencioso.
  const jaFinalizada = req.candidato && req.candidato.status === 'concluido';
  if (jaFinalizada) {
    const cardConcluida = `
      <section class="vm-hero vm-hero--centro" style="min-height:60vh;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:1rem;background:#0D0B0A;color:#F4F3F1;border-radius:16px;padding:3rem 2rem;">
        <h1 class="vm-title" style="color:#FF5500;margin:0;">ENTREVISTA CONCLUÍDA</h1>
        <p class="vm-lead" style="color:#F4F3F1;max-width:34rem;margin:0;">Você já completou sua entrevista. Nossa equipe analisará suas respostas e entrará em contato em breve. Obrigado pela participação!</p>
      </section>`;
    return res.send(
      pagina({ titulo: 'Entrevista concluída', tema: 'claro', etapa: 4, conteudo: cardConcluida }),
    );
  }

  const conteudo = `
    <div class="vm-entrevista" data-entrevista>
      <div class="vm-entrevista__topo">
        <div class="vm-chips vm-chips--progresso" data-chips aria-label="Progresso por tópico"></div>
        <div class="vm-timer" data-timer role="timer" aria-label="Tempo decorrido">00:00</div>
      </div>

      <div class="vm-orb vm-orb--idle" data-orbe aria-hidden="true">
        <div class="vm-orb__halo"></div>
        <img class="vm-orb__core" src="/img/vera-avatar.svg" alt="">
        <div class="vm-orb__ring"></div>
      </div>
      <p class="vm-vera-estado" data-estado-texto aria-live="polite"></p>

      <p class="vm-kicker">Vera pergunta</p>
      <p class="vm-pergunta" data-pergunta>Preparando sua entrevista…</p>

      <div class="vm-progresso" data-progresso hidden>
        <div class="vm-progresso__trilho" role="progressbar" aria-valuemin="0" aria-valuemax="100" data-progresso-barra-wrap>
          <div class="vm-progresso__barra" data-progresso-barra></div>
        </div>
        <span class="vm-progresso__rotulo" data-progresso-rotulo aria-live="polite"></span>
      </div>

      <p class="vm-form-erro" data-erro hidden role="alert"></p>

      <div class="vm-entrevista__controles">
        <button type="button" class="vm-btn vm-btn--primario vm-ptt" data-ptt hidden>Toque para falar</button>
        <button type="button" class="vm-btn vm-btn--primario" data-retry hidden>Tentar de novo</button>
        <button type="button" class="vm-btn vm-btn--secundario" data-repetir hidden>Repetir pergunta</button>
      </div>

      <div class="vm-cam-thumb" data-cam-thumb hidden>
        <video data-cam-video autoplay muted playsinline></video>
      </div>

      <!-- Overlay inicial: destrava o audio no iOS (exige gesto do usuario) -->
      <div class="vm-iniciar" data-iniciar>
        <div class="vm-orb vm-orb--idle" aria-hidden="true">
          <div class="vm-orb__halo"></div>
          <img class="vm-orb__core" src="/img/vera-avatar.svg" alt="">
          <div class="vm-orb__ring"></div>
        </div>
        <p class="vm-kicker">Agente Vera</p>
        <p class="vm-iniciar__frase">Toque para começar. A Vera vai te ouvir e conduzir a conversa.</p>
        <button type="button" class="vm-btn vm-btn--primario" data-iniciar-btn>Começar a Entrevista</button>
      </div>

      <audio data-audio playsinline></audio>
    </div>`;

  res.send(pagina({ titulo: 'Entrevista', tema: 'claro', etapa: 4, conteudo }));
});

// ── Tela 11: Finalizacao ──
// Copy CONDICIONAL ao status_ia (Item 5). Funcao pura status_ia -> apresentacao.
// Regra: SO 'descartar' oculta o WhatsApp; qualquer duvida/falha cai na copy NEUTRA
// + WhatsApp. 'processando' e transitorio (o client pola /api/interview/status ate um
// terminal). ATENCAO: estes textos sao ESPELHADOS em public/js/app.js (poll) — ao
// mudar aqui, mudar la tambem, para o in-place update ficar consistente.
function apresentacaoFinal(statusIa) {
  switch (statusIa) {
    case 'descartar':
      return {
        estado: 'descartar',
        kicker: 'Processo concluído',
        titulo: 'Processo encerrado',
        lead:
          'Agradecemos a sua participação. Desta vez não daremos andamento à sua candidatura, mas seu perfil fica registrado para futuras oportunidades.',
        mostrarWhatsapp: false,
      };
    case 'avancar':
      return {
        estado: 'avancar',
        kicker: 'Boa notícia',
        titulo: 'Você avançou!',
        lead:
          'Parabéns! Você avançou nesta etapa do processo. Nosso recrutador entrará em contato com os próximos passos.',
        mostrarWhatsapp: true,
      };
    case 'processando':
      return {
        estado: 'processando',
        kicker: 'Avaliando',
        titulo: 'Estamos avaliando suas respostas…',
        lead: 'Isso leva só alguns instantes. Por favor, não feche esta página.',
        mostrarWhatsapp: false,
      };
    // 'talvez' | 'indefinido' | 'erro' | null | qualquer outro -> NEUTRA (copy atual).
    default:
      return {
        estado: statusIa || 'indefinido',
        kicker: 'Tudo certo',
        titulo: 'Entrevista concluída',
        lead:
          'Suas respostas foram registradas. A equipe de recrutamento vai analisar sua entrevista e entrar em contato pelos próximos passos.',
        mostrarWhatsapp: true,
      };
  }
}

// Guardada tambem por modo: candidato de vaga Simples nunca chega aqui pelo fluxo, e
// se tentar por URL direta e mandado para a confirmacao Simples da sua vaga.
router.get('/finalizacao', exigirCandidato, bloquearSeModoSimples, (req, res) => {
  const statusIa = db.obterStatusIaPorApplication(req.candidato.id) || null;
  const ap = apresentacaoFinal(statusIa);

  // WhatsApp: MESMA fonte da tela Simples (config.recrutador.whatsapp, so digitos). O <a>
  // e SEMPRE renderizado quando ha numero; hidden quando o estado inicial o oculta. O
  // client so alterna 'hidden' (nunca reconstroi a URL, que depende da env). Sem numero
  // na env: o <a> nao existe.
  //
  // O texto agora carrega o CONTEXTO do processo (vaga + empresa) — antes era uma frase
  // generica e o recrutador recebia a mensagem sem saber de qual vaga o candidato veio.
  // A vaga e carregada aqui, no handler (bloquearSeModoSimples tambem a le, mas nao a
  // expoe; nao mexemos nele para nao afetar as outras rotas que o usam).
  //
  // vaga null (job_id orfao) NAO quebra: mensagemPosEntrevista degrada sozinha, omitindo
  // vaga e empresa e devolvendo uma frase valida. Por isso nao ha texto generico aqui.
  const numero = String(config.recrutador.whatsapp || '').replace(/\D/g, '');
  const vaga = db.obterVaga(req.candidato.job_id);
  // Nome proprio para a 1a pessoa da frase: nome + sobrenome, SEM o fallback de e-mail de
  // nomeCandidato ("Sou ana@exemplo.com" ficaria estranho). Vazio -> a funcao pura usa a
  // abertura sem nome.
  const nomeMensagem = [req.candidato.nome, req.candidato.sobrenome]
    .filter(Boolean)
    .join(' ')
    .trim();
  const mensagem = mensagemPosEntrevista({
    nome: nomeMensagem,
    vaga: vaga && vaga.titulo,
    empresa: vaga && vaga.empresa,
  });
  const href = numero ? `https://wa.me/${numero}?text=${encodeURIComponent(mensagem)}` : '';
  let whatsappHtml = '';
  if (numero) {
    whatsappHtml = `<a class="vm-btn vm-btn--primario" href="${href}" target="_blank" rel="noopener noreferrer" data-final-whatsapp${
      ap.mostrarWhatsapp ? '' : ' hidden'
    }>Falar com recrutador agora</a>`;
  } else {
    console.warn('[finalizacao] RECRUITER_WHATSAPP ausente; botão de WhatsApp não renderizado.');
  }

  // <noscript>: sem JS, o estado 'processando' ficaria travado no "Avaliando…". Entrega
  // a copy NEUTRA + WhatsApp (degradacao segura: nunca deixa o candidato sem saida).
  const noscriptHtml =
    ap.estado === 'processando'
      ? `<noscript><p class="vm-lead">Suas respostas foram registradas. A equipe de recrutamento vai analisar sua entrevista e entrar em contato pelos próximos passos.</p>${
          numero
            ? `<a class="vm-btn vm-btn--primario" href="${href}" target="_blank" rel="noopener noreferrer">Falar com recrutador agora</a>`
            : ''
        }</noscript>`
      : '';

  const pollAttr = ap.estado === 'processando' ? ' data-poll="1"' : '';

  const conteudo = `
    <section class="vm-hero vm-hero--centro vm-final" data-final-status="${escapeHtml(ap.estado)}"${pollAttr}>
      <div class="vm-orb vm-orb--idle" aria-hidden="true">
        <div class="vm-orb__halo"></div>
        <img class="vm-orb__core" src="/img/vera-avatar.svg" alt="">
        <div class="vm-orb__ring"></div>
      </div>
      <p class="vm-kicker" data-final-kicker>${escapeHtml(ap.kicker)}</p>
      <h1 class="vm-title" data-final-titulo>${escapeHtml(ap.titulo)}</h1>
      <p class="vm-lead" data-final-lead>${escapeHtml(ap.lead)}</p>
      ${whatsappHtml}
      ${noscriptHtml}
    </section>`;
  res.send(pagina({ titulo: 'Entrevista concluida', tema: 'claro', etapa: 4, conteudo }));
});

// Nome legivel do candidato (com fallbacks). Local — espelha o helper de relatorio.js.
function nomeCandidato(candidato) {
  if (!candidato) return 'Candidato';
  const nome = [candidato.nome, candidato.sobrenome].filter(Boolean).join(' ').trim();
  return nome || candidato.email || 'Candidato';
}

// Pagina simples (titulo + mensagem) no tema, para os casos sem relatorio renderizavel.
// `semRastreio` e opcional e default false — os call sites existentes nao mudam. So as
// telas de descadastro passam true (ver o bloco de rotas no fim do arquivo).
function paginaAviso(res, status, { titulo, descricao, semRastreio = false }) {
  return res.status(status).send(
    pagina({
      titulo,
      tema: 'claro',
      semRastreio,
      conteudo: placeholder({ titulo, descricao, centro: true }),
    }),
  );
}

// ── Tela 12: Relatorio (recrutador) — GET /relatorio/:token ──
// Enviada por e-mail ao RECRUTADOR (nunca ao candidato). Acesso so pelo token
// nao-adivinhavel, mesmo padrao do restante do fluxo. Mensagens de erro sao
// genericas e no tema: nao vazam stack/tabela/coluna e nao revelam se um token
// existe (evita enumeracao).
router.get('/relatorio/:token', (req, res) => {
  const token = String(req.params.token || '');

  let report;
  try {
    report = db.obterReportPorToken(token);
  } catch (err) {
    console.error('[relatorio/pagina] erro ao buscar report:', err.message);
    return paginaAviso(res, 500, {
      titulo: 'Relatório indisponível',
      descricao: 'Não foi possível carregar este relatório agora. Tente novamente em instantes.',
    });
  }

  // Token invalido/inexistente: resposta generica (nao revela se o token existe).
  if (!report) {
    return paginaAviso(res, 404, {
      titulo: 'Relatório não encontrado',
      descricao: 'Este link de relatório é inválido ou expirou. Confira o link enviado por e-mail.',
    });
  }

  // Ainda processando (acesso logo apos o finish, antes de a geracao concluir).
  if (report.status === 'pendente') {
    return paginaAviso(res, 200, {
      titulo: 'Relatório sendo processado',
      descricao:
        'A avaliação desta entrevista ainda está sendo gerada. Atualize a página em instantes.',
    });
  }

  // status 'gerado' | 'enviado' | 'erro' -> o conteudo da avaliacao ja existe.
  // Contexto do candidato/vaga via camada de dados (report -> interview -> aplicacao -> vaga).
  const interview = db.obterInterview(report.interview_id);
  const candidato = interview ? db.obterAplicacao(interview.application_id) : null;
  const vaga = candidato ? db.obterVaga(candidato.job_id) : null;
  const perfil = (vaga && vaga.perfil) || (interview && interview.perfil) || '';
  const roteiro = interview && interview.roteiro_id ? db.obterRoteiro(interview.roteiro_id) : null;

  // Score ponderado calculado on-the-fly (sem coluna no banco).
  const geral = calcularPontuacaoGeral(report.pontuacoes, roteiro);

  const comps = (report.pontuacoes || [])
    .map((p) => {
      const naoCoberta = p.coberta === false;
      // Item 7.6: nivel Alta/Média/Baixa (retrocompat: nota legada "N/5"), via helper unico.
      const nota = escapeHtml(rotuloNivel(p));
      return `
        <article class="vm-card vm-rel-comp${naoCoberta ? ' vm-rel-comp--off' : ''}">
          <div class="vm-rel-comp__cab">
            <h3 class="vm-rel-comp__nome">${escapeHtml(p.competencia || '')}</h3>
            <span class="vm-rel-nota">${nota}</span>
          </div>
          ${naoCoberta ? '<span class="vm-rel-badge">Não abordada nesta entrevista</span>' : ''}
          ${p.justificativa ? `<p class="vm-rel-just">${escapeHtml(p.justificativa)}</p>` : ''}
        </article>`;
    })
    .join('');

  // Item 7.6 — Requisitos obrigatorios (gate must-have). Omitido inteiro quando vazio.
  const requisitos = Array.isArray(report.requisitos) ? report.requisitos : [];
  const requisitosHtml = requisitos
    .map(
      (r) => `
        <article class="vm-card">
          <div style="display:flex;align-items:center;gap:.6rem;flex-wrap:wrap">
            ${badgeVereditoHtml(r.veredito)}
            <span style="font-family:var(--font-display);font-weight:700;text-transform:uppercase;font-size:1.05rem;letter-spacing:.02em">${escapeHtml(r.requisito || '')}</span>
          </div>
          ${
            r.evidencia
              ? `<p class="vm-rel-just" style="margin:.5rem 0 0;font-style:italic">&ldquo;${escapeHtml(r.evidencia)}&rdquo;</p>`
              : ''
          }
        </article>`,
    )
    .join('');

  const itens = (lista) =>
    (lista || []).map((i) => `<li>${escapeHtml(i)}</li>`).join('');
  const listaFortes = itens(report.destaque_pontos_fortes);
  // Item 7.6 — Gaps com mitigacao: textoGap normaliza string (legado) e { risco, mitigacao }.
  const listaAtencao = (report.destaque_atencao || [])
    .map((g) => {
      const { risco, mitigacao } = textoGap(g);
      if (!risco && !mitigacao) return '';
      return `<li><b>${escapeHtml(risco)}</b>${
        mitigacao
          ? `<br><span class="vm-rel-just">Mitigação: ${escapeHtml(mitigacao)}</span>`
          : ''
      }</li>`;
    })
    .filter(Boolean)
    .join('');

  const conteudo = `
    <section class="vm-rel">
      <header class="vm-rel__cab">
        <p class="vm-kicker">Relatório de entrevista${perfil ? ` · Perfil ${escapeHtml(perfil)}` : ''}</p>
        <h1 class="vm-title">${escapeHtml(nomeCandidato(candidato))}</h1>
        ${vaga ? `<p class="vm-rel__candidato">${escapeHtml(vaga.titulo)}</p>` : ''}
      </header>

      ${
        report.resumo
          ? `<section class="vm-secao">
              <h2 class="vm-h2">Resumo</h2>
              <div class="vm-card"><p>${escapeHtml(report.resumo)}</p></div>
            </section>`
          : ''
      }

      ${
        badgeRecomendacaoHtml(report.recomendacao)
          ? `<section class="vm-secao">
              <h2 class="vm-h2">Recomendação da IA</h2>
              <div class="vm-card">${badgeRecomendacaoHtml(report.recomendacao)}</div>
            </section>`
          : ''
      }

      ${
        geral
          ? `<section class="vm-secao">
              <h2 class="vm-h2">Pontuação geral</h2>
              <div class="vm-card">
                <p style="margin:0;font-family:'Barlow Condensed',sans-serif;font-weight:900;font-size:2.4rem;line-height:1;color:#FF5500">
                  ${escapeHtml(String(geral.media))}<span style="font-size:1.1rem;color:inherit"> / ${escapeHtml(String(geral.escalaMax))}</span>
                </p>
                <p class="vm-rel-just" style="margin:.4rem 0 0">Média ponderada pelo peso de cada competência.</p>
              </div>
            </section>`
          : ''
      }

      ${
        requisitos.length
          ? `<section class="vm-secao">
              <h2 class="vm-h2">Requisitos obrigatórios</h2>
              <div class="vm-rel-comps">${requisitosHtml}</div>
            </section>`
          : ''
      }

      <section class="vm-secao">
        <h2 class="vm-h2">Pontuação por competência</h2>
        <div class="vm-rel-comps">
          ${comps || '<div class="vm-card"><p class="vm-rel-just">Sem competências pontuadas.</p></div>'}
        </div>
      </section>

      <div class="vm-rel-destaques">
        <section class="vm-secao">
          <h2 class="vm-h2">Pontos fortes</h2>
          ${listaFortes ? `<ul class="vm-lista">${listaFortes}</ul>` : '<p class="vm-rel-just">—</p>'}
        </section>
        <section class="vm-secao">
          <h2 class="vm-h2">Pontos de atenção</h2>
          ${listaAtencao ? `<ul class="vm-lista">${listaAtencao}</ul>` : '<p class="vm-rel-just">—</p>'}
        </section>
      </div>
    </section>`;

  res.send(
    pagina({ titulo: `Relatório — ${nomeCandidato(candidato)}`, tema: 'claro', conteudo }),
  );
});

// ──────────────────────────────────────────────────────────────
// Descadastro da divulgacao de vagas (Promocao de Vagas) — GET + POST /descadastro
// ──────────────────────────────────────────────────────────────
//
// Publicas, alcancadas por link no rodape dos e-mails de divulgacao. Mesmo desenho de
// GET /relatorio/:token: sem sessao, autorizacao por token nao-adivinhavel e mensagens
// de erro GENERICAS — a pagina nunca revela se um e-mail existe na base, senao a propria
// rota viraria um oraculo de enumeracao ("este endereco esta cadastrado?").
//
// POR QUE O GET NAO DESCADASTRA (a decisao mais importante deste par de rotas):
// scanners de seguranca de e-mail corporativo (Defender, Proofpoint, Mimecast...) fazem
// GET em TODOS os links da mensagem antes de entrega-la ao destinatario. Se o GET
// mudasse estado, essas pessoas seriam descadastradas sem nunca ter aberto o e-mail — e
// o sintoma seria "a lista encolhe sozinha", quase impossivel de diagnosticar depois.
// Por isso: GET so LE e mostra a confirmacao; a mudanca de estado exige o POST do botao.
// NAO transforme isto num clique so, por mais que pareca melhor de UX.
//
// As duas passam semRastreio: true — nao se carrega GTM/Pixel na tela em que o titular
// exerce o direito de sair.

// Erro comum das duas rotas. Texto identico para token ausente, malformado ou invalido:
// distinguir os casos ajudaria mais quem esta sondando do que quem tem um link quebrado.
function avisoLinkDescadastroInvalido(res) {
  return paginaAviso(res, 400, {
    semRastreio: true,
    titulo: 'Link inválido',
    descricao:
      'Este link de descadastro é inválido ou está incompleto. Confira se ele foi ' +
      'copiado por inteiro do e-mail. Se o problema continuar, responda o e-mail que ' +
      'você recebeu e nós cuidamos disso para você.',
  });
}

// Aviso que a pessoa precisa ler ANTES de confirmar, e repetido na tela de sucesso: o
// opt-out e da DIVULGACAO, e nao tem nada a ver com uma candidatura em andamento. Sao
// dois fluxos distintos no sistema (campanhas x applications) e quem clica aqui achando
// que esta desistindo de uma vaga — ou com medo de que esteja — precisa saber a diferenca.
const NOTA_ESCOPO_DESCADASTRO = `
  <div class="vm-card">
    <p><b>Isto vale só para os e-mails de divulgação de vagas.</b></p>
    <p>Se você tem uma candidatura em andamento, ela <b>continua normalmente</b> — você
    segue recebendo os e-mails sobre o seu processo (entrevista, retomada de link e
    retorno). Descadastrar-se aqui <b>não cancela</b> nenhuma candidatura.</p>
    <p>Para desistir de uma candidatura específica, responda o e-mail do seu processo.</p>
  </div>`;

// ── GET /descadastro ── confirmacao (NAO altera nada) ──
router.get('/descadastro', (req, res) => {
  const email = lerEmailDaUrl(req.query.e);
  const token = typeof req.query.t === 'string' ? req.query.t : '';

  if (!email || !verificarToken(email, token)) {
    return avisoLinkDescadastroInvalido(res);
  }

  // Os campos ocultos repassam os MESMOS `e` e `t` que chegaram na URL: o POST revalida
  // tudo do zero e nao confia em nada que o formulario afirme.
  const conteudo = `
    <section class="vm-hero">
      <p class="vm-kicker">Vendedor Mestre</p>
      <h1 class="vm-title">Deseja parar de receber nossas vagas?</h1>
      <p class="vm-lead">Você está prestes a descadastrar o e-mail
        <b>${escapeHtml(email)}</b> da divulgação de vagas.</p>
      ${NOTA_ESCOPO_DESCADASTRO}
      <form method="POST" action="/descadastro" class="vm-acoes" style="width:100%">
        <input type="hidden" name="e" value="${escapeHtml(String(req.query.e || ''))}">
        <input type="hidden" name="t" value="${escapeHtml(token)}">
        <button type="submit" class="vm-btn vm-btn--primario">Confirmar descadastro</button>
      </form>
      <p class="vm-lead" style="font-size:.95rem">Se você chegou aqui sem querer, é só
        fechar esta página — nada foi alterado.</p>
    </section>`;

  res.send(
    pagina({ titulo: 'Descadastro', tema: 'claro', semRastreio: true, conteudo }),
  );
});

// ── POST /descadastro ── grava o opt-out ──
router.post('/descadastro', (req, res) => {
  const b = req.body || {};
  const q = req.query || {};
  // DUAS origens para os mesmos dois parametros, porque sao DOIS caminhos legitimos:
  //
  //   1. humano  -> GET /descadastro?e=..&t=.. mostra a confirmacao, e o formulario faz
  //                 POST com `e`/`t` no CORPO (application/x-www-form-urlencoded).
  //   2. One-Click (RFC 8058) -> o CLIENTE DE E-MAIL, ao ver o cabecalho
  //                 `List-Unsubscribe-Post: List-Unsubscribe=One-Click`, faz um POST
  //                 direto na URL do `List-Unsubscribe`, SEM abrir pagina e SEM corpo de
  //                 formulario. Os parametros so existem na QUERY STRING.
  //
  // Ler apenas do corpo (como era ate aqui) faria o One-Click falhar em silencio: o
  // provedor mostraria "cancelar inscricao" ao usuario, o clique responderia erro, e a
  // pessoa concluiria que nao consegue sair — o gatilho classico de denuncia de spam.
  //
  // A query tem PRIORIDADE quando presente: e o unico canal do One-Click, enquanto o
  // fluxo humano sempre tem o corpo. Nao ha ambiguidade real (os dois nunca chegam
  // juntos), e a precedencia so torna o comportamento deterministico se chegarem.
  const eBruto = typeof q.e === 'string' && q.e ? q.e : b.e;
  const tBruto = typeof q.t === 'string' && q.t ? q.t : b.t;

  // Revalidacao COMPLETA, do zero, venha de onde vier. O formulario (e a query) sao dado
  // externo como qualquer outro: o fato de o GET ter validado antes nao prova nada sobre
  // este POST.
  const email = lerEmailDaUrl(eBruto);
  const token = typeof tBruto === 'string' ? tBruto : '';

  if (!email || !verificarToken(email, token)) {
    return avisoLinkDescadastroInvalido(res);
  }

  try {
    // Retorno ignorado DE PROPOSITO: false significa "ja estava descadastrado", que para
    // o titular e o mesmo desfecho de "acabou de sair". A tela abaixo e a mesma nos dois
    // casos — a pessoa quer saber que esta fora, nao o estado do nosso banco.
    db.registrarDescadastro(email, ORIGEM_LINK_EMAIL);
  } catch (err) {
    console.error(`[descadastro] falha ao registrar opt-out: ${err.message}`);
    return paginaAviso(res, 500, {
      semRastreio: true,
      titulo: 'Não foi possível concluir',
      descricao:
        'Não conseguimos registrar seu descadastro agora. Tente novamente em alguns ' +
        'instantes ou responda o e-mail que você recebeu — nós registramos manualmente.',
    });
  }

  const conteudo = `
    <section class="vm-hero">
      <p class="vm-kicker">Vendedor Mestre</p>
      <h1 class="vm-title">Pronto, você foi descadastrado</h1>
      <p class="vm-lead">O e-mail <b>${escapeHtml(email)}</b> não vai mais receber
        divulgação de vagas nossas.</p>
      ${NOTA_ESCOPO_DESCADASTRO}
      <p class="vm-lead" style="font-size:.95rem">Mudou de ideia? Responda o último
        e-mail que recebeu de nós e pedimos para voltar.</p>
    </section>`;

  res.send(
    pagina({ titulo: 'Descadastro concluído', tema: 'claro', semRastreio: true, conteudo }),
  );
});

module.exports = router;
