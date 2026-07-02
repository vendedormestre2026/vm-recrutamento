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
const { calcularPontuacaoGeral } = require('../lib/relatorio');
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

// ── Tela 1: Vaga ──
router.get('/vaga/:slug', (req, res) => {
  const vaga = db.obterVagaPorSlug(req.params.slug);
  if (!vaga) {
    return res
      .status(404)
      .send(
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
  // Vaga encerrada (ativo=0): nao acessivel pelo candidato.
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

  // Registra o acesso (topo do funil) em fire-and-forget: nunca bloqueia nem quebra
  // o render por causa de metrica. So chega aqui apos os gates 404/inativa acima.
  try {
    db.registrarAcessoVaga(vaga.id);
  } catch (e) {
    console.error('[vaga] falha ao registrar acesso (métrica, ignorado):', e.message);
  }

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

  const conteudo = `
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
    </article>
    <div class="vm-cta-fixa">
      ${botao(`/aplicar/${vaga.slug}`, 'Aplicar')}
    </div>`;

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

    <section class="vm-secao">
      <h2 class="vm-h2">O que esperar</h2>
      <div class="vm-card">
        <dl class="vm-info">
          <dt>Formato</dt>
          <dd>Entrevista por áudio e vídeo com a Vera, nossa agente de recrutamento. Você interage pelo botão “toque para falar”.</dd>
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

    ${botao('/permissao-camera', 'Pode começar')}`;

  return pagina({ titulo: 'Preparação para a entrevista', tema: 'claro', etapa: 2, conteudo });
}

// /preparacao (sem slug): back-compat (links antigos, redirect de /instrucoes).
router.get('/preparacao', exigirCandidato, bloquearSeModoSimples, (req, res) => {
  res.send(paginaPreparacao(req));
});

// /preparacao/:slug: mesma pagina, com a slug da vaga na URL p/ diferenciar o lead
// por vaga no GTM. A vaga real e sempre a da SESSAO: se a slug da URL nao bater com
// a da sessao, redireciona para a slug correta (sem confiar na URL).
router.get('/preparacao/:slug', exigirCandidato, bloquearSeModoSimples, (req, res) => {
  const { vaga } = vagaERoteiroDaSessao(req);
  if (vaga && vaga.slug && req.params.slug !== vaga.slug) {
    return res.redirect(`/preparacao/${vaga.slug}`);
  }
  return res.send(paginaPreparacao(req));
});

// Monta a pagina de confirmacao do modo Simples. O botao de WhatsApp e um LINK <a> (o
// disparo e o CLIQUE do usuario — nunca window.open automatico, que o mobile bloqueia).
// O numero vem SO de RECRUITER_WHATSAPP (env); a mensagem e montada no SERVIDOR a partir
// dos dados da application + titulo da vaga e vai URL-encoded. Sem numero: botao
// desabilitado + aviso no log (a pagina ainda renderiza).
function paginaConfirmacaoSimples({ candidato, vaga }) {
  const nome = nomeCandidato(candidato);
  const tituloVaga = (vaga && vaga.titulo) || 'a vaga';
  const telefone = (candidato && candidato.telefone) || 'não informado';

  const numero = String(config.recrutador.whatsapp || '').replace(/\D/g, ''); // wa.me: so digitos
  const mensagem = `Olá! Nova candidatura para a vaga ${tituloVaga}. Candidato: ${nome}. Telefone: ${telefone}.`;

  let botao;
  if (numero) {
    // encodeURIComponent no texto: tambem neutraliza aspas/&, entao o href e seguro no atributo.
    const href = `https://wa.me/${numero}?text=${encodeURIComponent(mensagem)}`;
    botao = `<a class="vm-btn vm-btn--primario" href="${href}" target="_blank" rel="noopener noreferrer">Avisar recrutador no WhatsApp</a>`;
  } else {
    console.warn('[confirmacao] RECRUITER_WHATSAPP ausente; botão de WhatsApp desabilitado.');
    botao = `<button type="button" class="vm-btn vm-btn--primario" disabled aria-disabled="true">Avisar recrutador no WhatsApp</button>
      <p class="vm-rodape-nota">O canal de WhatsApp ainda não está configurado. Nossa equipe entrará em contato pelos dados da sua candidatura.</p>`;
  }

  const conteudo = `
    <section class="vm-hero vm-hero--centro">
      <p class="vm-kicker">Candidatura recebida</p>
      <h1 class="vm-title">Tudo certo, ${escapeHtml(candidato.nome || nome)}!</h1>
      <p class="vm-lead">Recebemos sua candidatura para a vaga ${escapeHtml(tituloVaga)}. Para agilizar, avise nosso recrutador no WhatsApp — é só tocar no botão abaixo.</p>
      <div class="vm-acoes">
        ${botao}
      </div>
    </section>`;

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
router.get('/permissao-camera', exigirCandidato, bloquearSeModoSimples, (req, res) => {
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
router.get('/teste-camera', exigirCandidato, bloquearSeModoSimples, (req, res) => {
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
router.get('/permissao-microfone', exigirCandidato, bloquearSeModoSimples, (req, res) => {
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
router.get('/teste-microfone', exigirCandidato, bloquearSeModoSimples, (req, res) => {
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
        <div class="vm-orb__core"></div>
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
          <div class="vm-orb__core"></div>
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
// Guardada tambem por modo: candidato de vaga Simples nunca chega aqui pelo fluxo, e
// se tentar por URL direta e mandado para a confirmacao Simples da sua vaga.
router.get('/finalizacao', exigirCandidato, bloquearSeModoSimples, (req, res) => {
  const conteudo = `
    <section class="vm-hero vm-hero--centro vm-final">
      <div class="vm-orb vm-orb--idle" aria-hidden="true">
        <div class="vm-orb__halo"></div>
        <div class="vm-orb__core"></div>
        <div class="vm-orb__ring"></div>
      </div>
      <p class="vm-kicker">Tudo certo</p>
      <h1 class="vm-title">Entrevista concluída</h1>
      <p class="vm-lead">Suas respostas foram registradas. A equipe de recrutamento vai analisar sua entrevista e entrar em contato pelos próximos passos.</p>
      <a class="vm-btn vm-btn--primario"
         href="https://wa.me/553121811220?text=Me%20candidatei%20no%20processo%20seletivo%20para%20%C3%A1rea%20comercial%20e%20quero%20falar%20com%20o%20recrutador"
         target="_blank" rel="noopener noreferrer">Falar com recrutador agora</a>
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
function paginaAviso(res, status, { titulo, descricao }) {
  return res.status(status).send(
    pagina({
      titulo,
      tema: 'claro',
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
      const nota = p.nota != null ? `${escapeHtml(String(p.nota))}<small>/5</small>` : '—';
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

  const itens = (lista) =>
    (lista || []).map((i) => `<li>${escapeHtml(i)}</li>`).join('');
  const listaFortes = itens(report.destaque_pontos_fortes);
  const listaAtencao = itens(report.destaque_atencao);

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

module.exports = router;
