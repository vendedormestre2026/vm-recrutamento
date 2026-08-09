'use strict';

// Painel do recrutador — Promocao de Vagas (/admin/promocao).
//
// ARQUIVO SEPARADO de routes/admin.js de proposito. admin.js ja tem ~4000 linhas e
// concentra 30+ rotas; esta feature sozinha somaria umas 400. O projeto ja tem precedente
// de dividir rotas por feature (routes/banco_curriculos.js, routes/api_banco_curriculos.js),
// entao isto segue pratica existente, nao inventa uma.
//
// COMO A AUTENTICACAO CHEGA AQUI: este modulo NAO tem checagem propria. Ele exporta uma
// FABRICA que devolve um Router, e admin.js o monta DEPOIS de `router.use(adminAuth)` —
// entao todas as rotas daqui herdam o gate do painel automaticamente. Se algum dia o mount
// subir para antes daquela linha, estas telas ficam publicas: o lugar do mount e parte da
// seguranca, nao detalhe de organizacao.
//
// A fabrica recebe os helpers de apresentacao que vivem em admin.js (paginaAdmin,
// formatarDataHora, fmtInt) em vez de importa-los: admin.js exporta o router, nao os
// helpers, e extrai-los para um modulo compartilhado seria um refactor que toca as ~15
// telas existentes — fora do escopo deste incremento, pelo mesmo motivo que a navegacao
// nao virou sistema de abas.
//
// ESCOPO DESTE INCREMENTO: a campanha nasce em 'rascunho' e para ali. Nada e enviado,
// nada e enfileirado, e NENHUMA linha de campanha_envios e criada — a materializacao do
// publico acontece no disparo (Incremento 7), nao aqui, porque a lista muda entre criar o
// rascunho e revisar/disparar.

const express = require('express');
const db = require('../db');
const { listarPublicoCampanha, PERFIS_VALIDOS, RECOMENDACOES_VALIDAS } = require('../lib/promocaoVagas');
const { escapeHtml } = require('../views');

// Rotulos de exibicao dos enums. Ficam aqui (camada de apresentacao) e nao na lib: a lib
// trabalha com os valores canonicos, a tela e que precisa de portugues.
const ROTULO_PERFIL = { SDR: 'SDR', CLOSER: 'Closer' };
const ROTULO_RECOMENDACAO = {
  avancar: 'Avançar',
  talvez: 'Em dúvida',
  descartar: 'Descartar',
};
const ROTULO_STATUS_CAMPANHA = {
  rascunho: 'Rascunho',
  enfileirada: 'Enfileirada',
  enviando: 'Enviando',
  concluida: 'Concluída',
  cancelada: 'Cancelada',
};

// Nome amigavel do atributo, usado nas linhas de "sem atributo" da previa.
const ROTULO_ATRIBUTO = {
  perfil: 'perfil',
  utmSource: 'origem',
  recomendacao: 'recomendação da IA',
};

function dataIsoValida(s) {
  return /^\d{4}-\d{2}-\d{2}$/.test(String(s || ''));
}

// ── Formulario -> criterios ──
//
// FONTE UNICA da traducao form->criterios: a previa e a criacao usam ESTA funcao, entao a
// campanha nunca e criada com um recorte diferente do que foi mostrado na tela. Separa-las
// seria a porta de entrada para o numero exibido e o numero gravado divergirem.
//
// Saneamento no mesmo espirito do resto do painel: valor fora do enum vira "filtro
// inativo", nunca erro. A lib sanea de novo por conta propria — aqui e para a tela
// conseguir redesenhar os selects com o valor que de fato valeu.
function lerCriteriosDoForm(b = {}) {
  const marcado = (campo) => b[campo] === '1' || b[campo] === 'on';
  const vagaNum = Number(b.vaga);

  return {
    jobIdAlvo: Number.isInteger(vagaNum) && vagaNum > 0 ? vagaNum : undefined,
    perfil: PERFIS_VALIDOS.includes(b.perfil) ? b.perfil : undefined,
    perfilIncluirSemAtributo: marcado('perfil_incluir_sem'),
    utmSource: b.origem ? String(b.origem) : undefined,
    utmSourceIncluirSemAtributo: marcado('origem_incluir_sem'),
    recomendacao: RECOMENDACOES_VALIDAS.includes(b.recomendacao) ? b.recomendacao : undefined,
    recomendacaoIncluirSemAtributo: marcado('recomendacao_incluir_sem'),
    dataDe: dataIsoValida(b.de) ? b.de : undefined,
    dataAte: dataIsoValida(b.ate) ? b.ate : undefined,
  };
}

function criarRouterPromocao({ paginaAdmin, formatarDataHora, fmtInt }) {
  const router = express.Router();

  // ── Blocos de HTML (funcoes puras, no molde de camposVagaHtml/blocoLinksEtapa) ──

  function opcoes(atual, pares) {
    return pares
      .map(
        ([valor, rotulo]) =>
          `<option value="${escapeHtml(valor)}"${String(atual || '') === valor ? ' selected' : ''}>${escapeHtml(rotulo)}</option>`,
      )
      .join('');
  }

  // Checkbox "incluir quem nao tem o atributo". Aparece junto do proprio filtro (e nao
  // dentro do bloco de previa) porque ele e um CAMPO DO FORMULARIO: dois controles com o
  // mesmo `name` colidiriam no POST, e o estado precisa sobreviver ao re-submit.
  function checkIncluirSem(nome, marcado, rotulo) {
    return `
      <label class="campo-check" style="margin:.35rem 0 0;font-size:.85rem;">
        <input type="checkbox" name="${nome}" value="1"${marcado ? ' checked' : ''}>
        <span style="color:var(--cinza);text-transform:none;">${escapeHtml(rotulo)}</span>
      </label>`;
  }

  // Formulario de criacao. `criterios` e `valores` vem preenchidos no re-submit da previa,
  // para o Jean nunca perder o que digitou ao recalcular.
  function formularioCampanha({ vagas, origens, criterios = {}, valores = {}, erro = '' } = {}) {
    const alerta = erro ? `<p class="aviso-alerta">${escapeHtml(erro)}</p>` : '';

    const opcoesVaga = vagas
      .map(
        (v) =>
          `<option value="${v.id}"${String(criterios.jobIdAlvo || '') === String(v.id) ? ' selected' : ''}>${escapeHtml(v.titulo || `Vaga ${v.id}`)} · ${escapeHtml(v.perfil)}</option>`,
      )
      .join('');

    const opcoesOrigem = origens
      .map(
        (o) =>
          `<option value="${escapeHtml(o.valor_canonico)}"${criterios.utmSource === o.valor_canonico ? ' selected' : ''}>${escapeHtml(o.label)}</option>`,
      )
      .join('');

    return `
      ${alerta}
      <form method="POST" action="/admin/promocao/previa">
        <section class="rel-sec">
          <h2>Vaga e mensagem</h2>
          <label class="campo" style="max-width:520px;">
            <span>Vaga a divulgar</span>
            <select name="vaga" required>
              <option value="">Selecione…</option>
              ${opcoesVaga}
            </select>
          </label>
          <p style="margin:-.6rem 0 1rem;color:var(--cinza);font-size:.8rem;">
            Só vagas <b>ativas</b> aparecem aqui. Quem já se candidatou a esta vaga
            (mesmo com a candidatura arquivada) é excluído do público automaticamente.
          </p>
          <label class="campo" style="max-width:520px;">
            <span>Assunto do e-mail</span>
            <input type="text" name="assunto" value="${escapeHtml(valores.assunto || '')}"
              maxlength="200" placeholder="Ex.: Vaga aberta: Closer de Vendas">
          </label>
          <label class="campo">
            <span>Corpo do e-mail (HTML)</span>
            <textarea name="corpo_html" rows="10"
              placeholder="&lt;p&gt;Olá! Estamos com uma vaga aberta…&lt;/p&gt;">${escapeHtml(valores.corpo_html || '')}</textarea>
          </label>
        </section>

        <section class="rel-sec">
          <h2>Quem vai receber</h2>
          <p style="margin:.2rem 0 1rem;color:var(--cinza);font-size:.9rem;">
            Sem nenhum filtro, o público é <b>toda a base de contatos</b> (candidatos +
            banco de talentos), menos as exclusões automáticas. Cada filtro <b>estreita</b>
            o público: quem não tem o atributo filtrado fica de fora, a não ser que você
            marque a caixa correspondente.
          </p>
          <div class="admin-filtros" style="align-items:flex-start;">
            <div class="filtro">
              <span>Perfil</span>
              <select name="perfil">
                ${opcoes(criterios.perfil, [['', 'Qualquer'], ['CLOSER', 'Closer'], ['SDR', 'SDR']])}
              </select>
              ${checkIncluirSem('perfil_incluir_sem', criterios.perfilIncluirSemAtributo, 'incluir sem perfil')}
            </div>
            <div class="filtro">
              <span>Origem</span>
              <select name="origem">
                <option value=""${criterios.utmSource ? '' : ' selected'}>Qualquer</option>
                ${opcoesOrigem}
              </select>
              ${checkIncluirSem('origem_incluir_sem', criterios.utmSourceIncluirSemAtributo, 'incluir sem origem')}
            </div>
            <div class="filtro">
              <span>Recomendação da IA</span>
              <select name="recomendacao">
                ${opcoes(criterios.recomendacao, [
                  ['', 'Qualquer'],
                  ['avancar', 'Avançar'],
                  ['talvez', 'Em dúvida'],
                  ['descartar', 'Descartar'],
                ])}
              </select>
              ${checkIncluirSem('recomendacao_incluir_sem', criterios.recomendacaoIncluirSemAtributo, 'incluir sem avaliação')}
            </div>
            <label class="filtro">
              <span>Candidatura de</span>
              <input type="date" name="de" value="${escapeHtml(criterios.dataDe || '')}">
            </label>
            <label class="filtro">
              <span>até</span>
              <input type="date" name="ate" value="${escapeHtml(criterios.dataAte || '')}">
            </label>
          </div>
        </section>

        <div style="display:flex;gap:.6rem;flex-wrap:wrap;align-items:center;">
          <button type="submit" class="btn">Calcular prévia</button>
          ${
            // O botao de CRIAR so aparece depois de uma previa. Nao e enfeite: criar
            // campanha sem ter visto o tamanho do publico e como assinar sem ler.
            valores.previaCalculada
              ? `<button type="submit" class="btn" formaction="/admin/promocao">Criar campanha (rascunho)</button>`
              : `<span style="color:var(--cinza);font-size:.85rem;">Calcule a prévia para poder criar a campanha.</span>`
          }
          <a class="btn btn--ghost" href="/admin/promocao">Cancelar</a>
        </div>
      </form>`;
  }

  // Bloco da previa. `resultado` vem de lib/promocaoVagas.listarPublicoCampanha.
  //
  // As linhas de "sem atributo" so aparecem para filtro ATIVO — excluidosPorFiltro.X vem
  // `null` quando o filtro nem foi ligado, e null e diferente de zero: "essa pergunta nao
  // foi feita" nao e a mesma informacao que "ninguem ficou de fora".
  function blocoPrevia(resultado) {
    const semAtributo = Object.entries(resultado.excluidosPorFiltro)
      .filter(([, n]) => n !== null && n > 0)
      .map(
        ([chave, n]) => `
          <li>
            <b>${fmtInt(n)}</b> ${n === 1 ? 'registro' : 'registros'} sem
            ${escapeHtml(ROTULO_ATRIBUTO[chave] || chave)} definido —
            marque <i>“incluir sem ${escapeHtml(ROTULO_ATRIBUTO[chave] || chave)}”</i>
            no filtro acima e recalcule para incluí-los.
          </li>`,
      )
      .join('');

    const vazio =
      resultado.total === 0
        ? `<p class="aviso-alerta">Nenhum destinatário com estes critérios. Afrouxe os
             filtros ou marque as caixas de “incluir sem …”.</p>`
        : '';

    return `
      <section class="rel-sec" style="border:1px solid var(--linha);border-radius:8px;padding:1rem 1.2rem;">
        <h2>Prévia do público</h2>
        ${vazio}
        <p style="margin:.2rem 0 .6rem;">
          <span class="funil-num">${fmtInt(resultado.total)}</span>
          <b>destinatário${resultado.total === 1 ? '' : 's'}</b>
        </p>
        <ul class="lista">
          <li><b>${fmtInt(resultado.porOrigem.applications)}</b> de candidaturas</li>
          <li><b>${fmtInt(resultado.porOrigem.talentos)}</b> do banco de talentos</li>
        </ul>
        ${semAtributo ? `<p style="margin:1rem 0 .3rem;color:var(--cinza);font-size:.85rem;text-transform:uppercase;">Ficaram de fora</p><ul class="lista">${semAtributo}</ul>` : ''}
        <p style="margin:1rem 0 0;color:var(--cinza);font-size:.8rem;">
          Já descontados: quem se descadastrou, quem já se candidatou a esta vaga e
          talentos descartados. Cada pessoa aparece uma vez só.
        </p>
      </section>`;
  }

  // Descricao legivel dos criterios salvos, para a tela de detalhe. Le do JSON gravado,
  // que e o registro historico do recorte — nao dos filtros da tela.
  function descricaoCriterios(criterios = {}) {
    const itens = [];
    if (criterios.perfil) {
      itens.push(
        `Perfil: <b>${escapeHtml(ROTULO_PERFIL[criterios.perfil] || criterios.perfil)}</b>${criterios.perfilIncluirSemAtributo ? ' (incluindo sem perfil)' : ''}`,
      );
    }
    if (criterios.utmSource) {
      itens.push(
        `Origem: <b>${escapeHtml(criterios.utmSource)}</b>${criterios.utmSourceIncluirSemAtributo ? ' (incluindo sem origem)' : ''}`,
      );
    }
    if (criterios.recomendacao) {
      itens.push(
        `Recomendação: <b>${escapeHtml(ROTULO_RECOMENDACAO[criterios.recomendacao] || criterios.recomendacao)}</b>${criterios.recomendacaoIncluirSemAtributo ? ' (incluindo sem avaliação)' : ''}`,
      );
    }
    if (criterios.dataDe || criterios.dataAte) {
      itens.push(
        `Candidatura entre <b>${escapeHtml(criterios.dataDe || '—')}</b> e <b>${escapeHtml(criterios.dataAte || '—')}</b>`,
      );
    }
    if (!itens.length) return '<li>Sem filtros — toda a base de contatos.</li>';
    return itens.map((i) => `<li>${i}</li>`).join('');
  }

  // Vagas oferecidas na criacao: SO as ativas. Nao existe listarVagasAtivas na camada de
  // dados (listarVagas devolve todas, e obterVagaAtiva devolve UMA so), entao o recorte
  // acontece aqui — e recorte de APRESENTACAO, nao regra de negocio: nao faz sentido
  // divulgar vaga encerrada.
  function vagasAtivas() {
    return db.listarVagas().filter((v) => v.ativo);
  }

  function paginaFormulario({ criterios, valores, resultado, erro }) {
    const conteudo = `
      <p><a class="btn btn--ghost" href="/admin/promocao">← Voltar às campanhas</a></p>
      <h1>Nova campanha</h1>
      ${resultado ? blocoPrevia(resultado) : ''}
      ${formularioCampanha({
        vagas: vagasAtivas(),
        origens: db.listarOrigensDistintas(),
        criterios,
        valores,
        erro,
      })}`;
    return paginaAdmin({ titulo: 'Nova campanha', conteudo });
  }

  // ── GET /admin/promocao ── listagem ──
  router.get('/', (req, res) => {
    const campanhas = db.listarCampanhas();

    const linhas = campanhas
      .map((c) => {
        const rotulo = ROTULO_STATUS_CAMPANHA[c.status] || c.status;
        const badge =
          c.status === 'rascunho'
            ? `<span class="badge badge--aplicado">${escapeHtml(rotulo)}</span>`
            : `<span class="badge badge--ativa">${escapeHtml(rotulo)}</span>`;
        return `
          <tr>
            <td><a href="/admin/promocao/${c.id}">${escapeHtml(c.assunto || '(sem assunto)')}</a></td>
            <td>${escapeHtml(c.vaga_titulo || '(vaga removida)')}</td>
            <td>${badge}</td>
            <td class="col-num">${fmtInt(c.total_destinatarios)}</td>
            <td>${formatarDataHora(c.criado_em)}</td>
            <td><a class="btn btn--ghost" href="/admin/promocao/${c.id}">Ver</a></td>
          </tr>`;
      })
      .join('');

    const conteudo = `
      <p><a class="btn btn--ghost" href="/admin">← Voltar ao painel</a></p>
      <div style="display:flex;justify-content:space-between;align-items:center;gap:1rem;flex-wrap:wrap;margin-bottom:1rem;">
        <h1 style="margin:0;">Promoção de Vagas</h1>
        <a class="btn" href="/admin/promocao/nova">+ Nova campanha</a>
      </div>
      <p style="color:var(--cinza);font-size:.9rem;margin:0 0 1rem;">
        Divulgação de uma vaga por e-mail para a base de contatos. Toda campanha nasce
        como <b>rascunho</b> e não envia nada sozinha.
      </p>
      <div class="admin-tab-scroll">
        <table class="admin-tab">
          <thead>
            <tr><th>Assunto</th><th>Vaga</th><th>Status</th><th class="col-num">Destinatários</th><th>Criada em</th><th>Ações</th></tr>
          </thead>
          <tbody>
            ${linhas || '<tr><td colspan="6">Nenhuma campanha criada ainda.</td></tr>'}
          </tbody>
        </table>
      </div>`;

    res.send(paginaAdmin({ titulo: 'Promoção de Vagas', conteudo }));
  });

  // ── GET /admin/promocao/nova ── formulario vazio ──
  // Declarada ANTES de '/:id': '/nova' casaria com o parametro e cairia no detalhe.
  router.get('/nova', (req, res) => {
    res.send(paginaFormulario({ criterios: {}, valores: {}, resultado: null }));
  });

  // ── POST /admin/promocao/previa ── recalcula e re-renderiza (SEM efeito colateral) ──
  //
  // Nao grava nada e pode ser chamada quantas vezes o Jean quiser. Re-renderiza a tela
  // inteira com a previa acima do formulario, em vez de atualizar um pedaco via fetch.
  // Isso mantem a tela sem JavaScript: o unico ponto do painel que hoje faz fetch e o
  // select inline de Status Recrutador (admin.js), e um formulario de varios campos que
  // re-submete e' o padrao dominante do projeto (vagas, roteiro, config, perfis).
  router.post('/previa', (req, res) => {
    const b = req.body || {};
    const criterios = lerCriteriosDoForm(b);
    const valores = { assunto: b.assunto, corpo_html: b.corpo_html, previaCalculada: true };

    if (!criterios.jobIdAlvo) {
      return res.status(400).send(
        paginaFormulario({
          criterios,
          valores: { ...valores, previaCalculada: false },
          resultado: null,
          erro: 'Escolha a vaga que será divulgada — o público depende dela (quem já se candidatou a essa vaga é excluído).',
        }),
      );
    }

    let resultado;
    try {
      resultado = listarPublicoCampanha(criterios);
    } catch (err) {
      console.error(`[promocao] falha ao calcular previa: ${err.message}`);
      return res.status(500).send(
        paginaFormulario({
          criterios,
          valores: { ...valores, previaCalculada: false },
          resultado: null,
          erro: 'Não foi possível calcular a prévia agora. Tente novamente.',
        }),
      );
    }

    res.send(paginaFormulario({ criterios, valores, resultado }));
  });

  // ── POST /admin/promocao ── cria o rascunho ──
  router.post('/', (req, res) => {
    const b = req.body || {};
    const criterios = lerCriteriosDoForm(b);
    const assunto = String(b.assunto || '').trim();
    const corpoHtml = String(b.corpo_html || '').trim();
    const valores = { assunto, corpo_html: corpoHtml, previaCalculada: true };

    const erro = !criterios.jobIdAlvo
      ? 'Escolha a vaga que será divulgada.'
      : !assunto
        ? 'O assunto do e-mail é obrigatório.'
        : !corpoHtml
          ? 'O corpo do e-mail é obrigatório.'
          : '';
    if (erro) {
      return res.status(400).send(paginaFormulario({ criterios, valores, resultado: null, erro }));
    }

    let resultado;
    try {
      // Recalcula em vez de confiar em qualquer numero que tenha vindo do formulario: o
      // total gravado precisa ser o que o motor diz AGORA, nao o que um campo escondido
      // afirma. `criterios` gravado e o mesmo objeto usado neste calculo — o registro
      // historico e do recorte que de fato produziu o numero.
      resultado = listarPublicoCampanha(criterios);
    } catch (err) {
      console.error(`[promocao] falha ao calcular publico na criacao: ${err.message}`);
      return res.status(500).send(
        paginaFormulario({
          criterios,
          valores,
          resultado: null,
          erro: 'Não foi possível calcular o público agora. A campanha não foi criada.',
        }),
      );
    }

    // NENHUMA linha de campanha_envios aqui — a materializacao do publico e do disparo
    // (Incremento 7). Entre criar o rascunho e disparar, a lista pode mudar, e congelar os
    // destinatarios agora significaria enviar para um recorte velho.
    const id = db.criarCampanha({
      job_id: criterios.jobIdAlvo,
      assunto,
      corpo_html: corpoHtml,
      criterios,
      total_destinatarios: resultado.total,
    });

    res.redirect(`/admin/promocao/${id}`);
  });

  // ── GET /admin/promocao/:id ── detalhe / revisao ──
  router.get('/:id', (req, res) => {
    const id = Number(req.params.id);
    const campanha = Number.isInteger(id) && id > 0 ? db.obterCampanha(id) : null;
    if (!campanha) {
      return res.status(404).send(
        paginaAdmin({
          titulo: 'Campanha não encontrada',
          conteudo: `
            <p><a class="btn btn--ghost" href="/admin/promocao">← Voltar às campanhas</a></p>
            <h1>Campanha não encontrada</h1>
            <p>Esta campanha não existe ou foi removida.</p>`,
        }),
      );
    }

    // Publico ATUAL, recalculado dos criterios salvos. O total gravado e o numero
    // CONGELADO na criacao; os dois divergem quando a base se mexeu no meio do caminho
    // (alguem se descadastrou, alguem se candidatou a vaga alvo). Mostrar so um dos dois
    // esconderia essa decadencia justamente de quem esta prestes a disparar.
    let atual = null;
    let erroAtual = '';
    try {
      atual = listarPublicoCampanha(campanha.criterios);
    } catch (err) {
      console.error(`[promocao] falha ao recalcular publico da campanha ${id}: ${err.message}`);
      erroAtual = 'Não foi possível recalcular o público agora.';
    }

    const divergencia =
      atual && atual.total !== campanha.total_destinatarios
        ? `<p class="aviso-alerta">
             O público mudou desde a criação: eram <b>${fmtInt(campanha.total_destinatarios)}</b>
             em ${escapeHtml(formatarDataHora(campanha.criado_em))} e são
             <b>${fmtInt(atual.total)}</b> agora. Descadastros e novas candidaturas à vaga
             divulgada mexem nesse número.
           </p>`
        : '';

    const conteudo = `
      <p><a class="btn btn--ghost" href="/admin/promocao">← Voltar às campanhas</a></p>
      <div style="display:flex;justify-content:space-between;align-items:center;gap:1rem;flex-wrap:wrap;margin-bottom:.5rem;">
        <h1 style="margin:0;">${escapeHtml(campanha.assunto || '(sem assunto)')}</h1>
        <span class="badge badge--aplicado">${escapeHtml(ROTULO_STATUS_CAMPANHA[campanha.status] || campanha.status)}</span>
      </div>

      <section class="rel-sec">
        <dl class="rel-id">
          <div><dt>Vaga</dt><dd>${escapeHtml(campanha.vaga_titulo || '(vaga removida)')}</dd></div>
          <div><dt>Perfil da vaga</dt><dd>${escapeHtml(campanha.vaga_perfil || '—')}</dd></div>
          <div><dt>Criada em</dt><dd>${escapeHtml(formatarDataHora(campanha.criado_em))}</dd></div>
          <div><dt>Destinatários (na criação)</dt><dd>${fmtInt(campanha.total_destinatarios)}</dd></div>
        </dl>
      </section>

      ${erroAtual ? `<p class="aviso-alerta">${escapeHtml(erroAtual)}</p>` : divergencia}
      ${atual ? blocoPrevia(atual) : ''}

      <section class="rel-sec">
        <h2>Critérios usados</h2>
        <ul class="lista">${descricaoCriterios(campanha.criterios)}</ul>
      </section>

      <section class="rel-sec">
        <h2>Mensagem</h2>
        <div class="comp">
          <p style="color:var(--cinza);font-size:.8rem;text-transform:uppercase;margin:0 0 .3rem;">Assunto</p>
          <p style="margin:0 0 1rem;"><b>${escapeHtml(campanha.assunto || '')}</b></p>
          <p style="color:var(--cinza);font-size:.8rem;text-transform:uppercase;margin:0 0 .3rem;">Corpo (HTML)</p>
          <pre style="white-space:pre-wrap;word-break:break-word;margin:0;font-size:.85rem;">${escapeHtml(campanha.corpo_html || '')}</pre>
        </div>
      </section>

      <section class="rel-sec">
        <h2>Disparo</h2>
        <p style="color:var(--cinza);font-size:.9rem;margin:.2rem 0 1rem;">
          O envio ainda não está implementado — esta campanha fica em rascunho.
        </p>
        <!-- Incremento 7: aqui entra o botao que enfileira o disparo (status
             'enfileirada') e a rotina que materializa campanha_envios e envia. Ate la o
             botao fica DESABILITADO de proposito, e nao apenas ausente: a tela precisa
             deixar claro que o passo existe e ainda nao chegou. -->
        <button type="button" class="btn btn--off" disabled>Disparar campanha</button>
      </section>`;

    res.send(paginaAdmin({ titulo: `Campanha — ${campanha.assunto || campanha.id}`, conteudo }));
  });

  return router;
}

module.exports = { criarRouterPromocao, lerCriteriosDoForm };
