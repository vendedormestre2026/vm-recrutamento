'use strict';

// Tela de OPT-OUTS de WhatsApp (/admin/optouts). Montada por admin.js DEPOIS do
// `router.use(adminAuth)`, herdando a protecao do painel — mesmo padrao de
// admin_promocao.js, admin_whatsapp.js e admin_campanha_whatsapp.js. Mover o mount para
// antes daquela linha deixaria esta tela publica.
//
// ── PARA QUE ELA EXISTE ──
// Hoje um pedido de "nao me mandem mais" chega pelo WhatsApp e fica visivel SO no Live Chat
// do Central Whats. Nao ha canal de ingestao automatica (ver docs/webhook-entrada-
// centralwhats.md), entao o caminho real, enquanto isso, e o Jean ver o pedido e registrar
// aqui. A tela e desenhada para esse gesto: um campo, um botao, sem navegacao.
//
// ── O QUE ELA DELIBERADAMENTE NAO FAZ ──
// Nao edita escopo de um opt-out existente (escalar e um registro novo; rebaixar exige
// revogar e registrar de novo, que e o caminho explicito por decisao — ver a regra 3 de
// registrarWhatsappOptout em db/sqlite.js). Nao apaga linha nenhuma: revogar e datar
// `revogado_em`, e o historico e o que sustenta "esta pessoa pediu para sair em marco".

const express = require('express');

const db = require('../db');
const optout = require('../lib/optoutWhatsapp');

// Rotulos das duas dimensoes. Fora dos templates porque a listagem, o selo da ficha e o
// resumo leem os mesmos mapas — divergir aqui faria a mesma linha aparecer com nomes
// diferentes em duas telas.
const ROTULO_ESCOPO = {
  campanha: 'Só campanhas',
  total: 'Tudo (inclusive processo seletivo)',
};

const ROTULO_ORIGEM = {
  link: 'Clicou no link',
  resposta: 'Respondeu pedindo',
  botao: 'Apertou o botão',
  manual: 'Registrado no painel',
  importacao: 'Importação',
};

function rotuloEscopo(escopo) {
  return ROTULO_ESCOPO[escopo] || escopo || '—';
}

function rotuloOrigem(origem) {
  return ROTULO_ORIGEM[origem] || origem || '—';
}

// Telefone para EXIBICAO. Mostra o original quando existe (e o que a pessoa reconhece), com
// a chave canonica ao lado — porque e a chave que decide a supressao, e esconder isso do
// operador faria "por que este numero nao saiu da campanha?" virar um misterio.
function telefoneExibido(linha, escapeHtml) {
  const original = String(linha.telefone_original || '').trim();
  const canonico = String(linha.telefone_canonico || '');
  if (!original || original.replace(/\D/g, '') === canonico) return escapeHtml(canonico);
  return `${escapeHtml(original)}<br><small style="color:var(--cinza);">chave: ${escapeHtml(canonico)}</small>`;
}

// ── Selo do opt-out, usado na FICHA do candidato (admin.js) ──
//
// Exportado daqui, e nao redesenhado la, para o rotulo de escopo/origem ser literalmente o
// mesmo dos dois lados. Devolve '' quando nao ha opt-out ativo — o call site interpola sem
// condicional.
function seloOptout(linhaOptout, { escapeHtml, formatarDataHora }) {
  if (!linhaOptout) return '';
  const cor = linhaOptout.escopo === 'total' ? '#8A1C1C' : 'var(--laranja)';
  const motivo = String(linhaOptout.motivo || '').trim();
  return `
    <p style="margin:.6rem 0;padding:.6rem .8rem;border-left:4px solid ${cor};background:#F4F3F1;">
      <b style="text-transform:uppercase;letter-spacing:.03em;">Pediu para não receber</b><br>
      <span style="color:var(--preto);">${escapeHtml(rotuloEscopo(linhaOptout.escopo))}</span> ·
      ${escapeHtml(rotuloOrigem(linhaOptout.origem))} ·
      ${escapeHtml(formatarDataHora(linhaOptout.criado_em))}
      ${motivo ? `<br><small style="color:var(--cinza);">${escapeHtml(motivo)}</small>` : ''}
    </p>`;
}

// ── Botao de 1 clique, usado nas LISTAGENS (candidatos e talentos) ──
//
// POST e nao GET, e com confirmacao: e uma acao de escrita que muda o que a pessoa recebe.
// `redirect` volta para a tela exata de onde o clique saiu (com filtros e pagina) — sem
// isso, marcar alguem na pagina 4 da listagem jogaria o operador de volta para a pagina 1, e
// ele perderia o lugar a cada clique.
//
// O escopo do 1 clique e SEMPRE `campanha`. E o pedido que chega na pratica ("parem de me
// mandar vagas"), e o bloqueio total tem consequencia grande demais para caber num botao
// sem tela intermediaria — quem precisa dele usa o formulario de /admin/optouts.
function botaoMarcarOptout({ telefone, redirect, jaTemOptout }, { escapeHtml }) {
  if (jaTemOptout) {
    return '<span class="btn btn--off" title="Já registrado" aria-label="Já pediu para não receber">Opt-out ✓</span>';
  }
  if (!optout.chaveCanonicaTelefone(telefone)) {
    return '<span class="btn btn--off" title="Telefone inválido ou ausente" aria-label="Opt-out indisponível">Opt-out</span>';
  }
  return `
    <form method="POST" action="/admin/optouts/marcar" style="margin:0;display:inline;"
          data-confirm="Registrar que esta pessoa pediu para não receber mais campanhas? Ela continua recebendo as mensagens dos processos seletivos em que se inscrever."
          data-confirm-titulo="Marcar opt-out?" data-confirm-texto="Marcar">
      <input type="hidden" name="telefone" value="${escapeHtml(String(telefone || ''))}">
      <input type="hidden" name="escopo" value="campanha">
      <input type="hidden" name="redirect" value="${escapeHtml(String(redirect || '/admin'))}">
      <button type="submit" class="btn btn--ghost">Opt-out</button>
    </form>`;
}

// Destino seguro do redirect pos-acao: SO caminho interno do painel. Sem isto, um
// `redirect=https://exemplo.com` no corpo do POST viraria um redirecionamento aberto a
// partir de uma rota autenticada. Mesmo criterio de destinoSeguro em admin.js.
function destinoInterno(valor, padrao = '/admin/optouts') {
  const s = String(valor || '');
  return /^\/admin(\/|\?|$)/.test(s) && !s.startsWith('//') ? s : padrao;
}

function criarRouterOptout({ paginaAdmin, escapeHtml, fmtInt, formatarDataHora }) {
  const router = express.Router();

  const FLASHES = {
    criado: ['ok', 'Opt-out registrado.'],
    escalado: ['ok', 'Opt-out ampliado para bloqueio total.'],
    ja_existia: ['ok', 'Esta pessoa já estava registrada — nada mudou.'],
    revogado: ['ok', 'Opt-out revogado. Esta pessoa volta a receber campanhas.'],
    nada_revogar: ['alerta', 'Não havia opt-out ativo para este número.'],
    telefone: ['alerta', 'Telefone inválido ou ausente.'],
  };

  function flash(query) {
    const par = FLASHES[String(query.msg || '')];
    if (!par) return '';
    const [tipo, texto] = par;
    return `<p class="aviso-${tipo}">${escapeHtml(texto)}</p>`;
  }

  function linha(item) {
    const ativoAgora = !item.revogado_em;
    const badge = ativoAgora
      ? `<span class="badge badge--ativa">${escapeHtml(rotuloEscopo(item.escopo))}</span>`
      : `<span class="badge badge--encerrada">Revogado</span>`;
    const acao = ativoAgora
      ? `<form method="POST" action="/admin/optouts/revogar" style="margin:0;"
               data-confirm="Revogar o opt-out deste número? Ele volta a receber campanhas de divulgação."
               data-confirm-titulo="Revogar opt-out?" data-confirm-texto="Revogar">
           <input type="hidden" name="telefone" value="${escapeHtml(item.telefone_canonico)}">
           <button type="submit" class="btn btn--ghost">Revogar</button>
         </form>`
      : `<small style="color:var(--cinza);">em ${escapeHtml(formatarDataHora(item.revogado_em))}</small>`;

    return `
      <tr>
        <td>${telefoneExibido(item, escapeHtml)}</td>
        <td>${badge}</td>
        <td>${escapeHtml(rotuloOrigem(item.origem))}</td>
        <td>${escapeHtml(formatarDataHora(item.criado_em))}</td>
        <td>${escapeHtml(String(item.motivo || '—'))}</td>
        <td>${acao}</td>
      </tr>`;
  }

  // ── GET / ── a tela ──
  router.get('/', (req, res) => {
    const q = req.query || {};
    const escopo = db.ESCOPOS_OPTOUT.includes(q.escopo) ? q.escopo : '';
    const busca = String(q.q || '').trim().slice(0, 60);
    const incluirRevogados = q.revogados === '1';
    const paginaNum = Number(q.pagina);
    const pagina = Number.isInteger(paginaNum) && paginaNum > 0 ? paginaNum : 1;

    const lista = optout.listarOptouts({ escopo, busca, pagina, incluirRevogados });
    const resumo = db.resumoWhatsappOptouts();
    const supressaoLigada = optout.ativo();

    // Aviso que so aparece quando o interruptor esta DESLIGADO. E a unica forma de a tela
    // nao mentir: com ele desligado, a lista abaixo esta correta e completamente inerte.
    const avisoDesligado = supressaoLigada
      ? ''
      : `<p class="aviso-alerta">A supressão está <b>DESLIGADA</b> em
         <a href="/admin/config">Configurações</a>. Estas pessoas <b>estão recebendo</b>
         campanhas mesmo constando aqui.</p>`;

    const paginacao =
      lista.paginas > 1
        ? `<nav class="admin-paginacao" aria-label="Paginação dos opt-outs">
             ${
               pagina > 1
                 ? `<a class="btn btn--ghost" href="?${new URLSearchParams({ escopo, q: busca, revogados: incluirRevogados ? '1' : '', pagina: String(pagina - 1) })}">Anterior</a>`
                 : ''
             }
             <span>Página ${fmtInt(pagina)} de ${fmtInt(lista.paginas)}</span>
             ${
               pagina < lista.paginas
                 ? `<a class="btn btn--ghost" href="?${new URLSearchParams({ escopo, q: busca, revogados: incluirRevogados ? '1' : '', pagina: String(pagina + 1) })}">Próxima</a>`
                 : ''
             }
           </nav>`
        : '';

    const porOrigem =
      resumo.porOrigem.map((o) => `${escapeHtml(rotuloOrigem(o.origem))}: ${fmtInt(o.n)}`).join(' · ') || '—';
    const porEscopo =
      resumo.porEscopo.map((e) => `${escapeHtml(rotuloEscopo(e.escopo))}: ${fmtInt(e.n)}`).join(' · ') || '—';

    const conteudo = `
      <div style="display:flex;justify-content:space-between;align-items:center;gap:1rem;flex-wrap:wrap;margin-bottom:1rem;">
        <h1 style="margin:0;">Opt-outs de WhatsApp</h1>
        <div style="display:flex;gap:.5rem;flex-wrap:wrap;">
          <a class="btn btn--ghost" href="/admin">Candidatos</a>
          <a class="btn btn--ghost" href="/admin/divulgacao-vagas">Divulgação de Vagas</a>
          <a class="btn btn--ghost" href="/admin/config">Configurações</a>
        </div>
      </div>
      ${flash(q)}
      ${avisoDesligado}

      <section class="rel-sec">
        <h2>Resumo</h2>
        <p style="margin:.2rem 0;">
          <b>${fmtInt(resumo.total)}</b> pessoa(s) fora hoje ·
          <b>${fmtInt(resumo.ultimos7)}</b> nos últimos 7 dias ·
          ${fmtInt(resumo.revogados)} revogado(s)
        </p>
        <p style="margin:.2rem 0;color:var(--cinza);font-size:.9rem;">Por origem — ${porOrigem}</p>
        <p style="margin:.2rem 0;color:var(--cinza);font-size:.9rem;">Por escopo — ${porEscopo}</p>
      </section>

      <section class="rel-sec">
        <h2>Registrar um pedido</h2>
        <p style="margin:.2rem 0 1rem;color:var(--cinza);font-size:.9rem;">
          Para quando alguém pede no Live Chat. Aceita o número em qualquer formato — com ou
          sem o nono dígito, com ou sem máscara.
        </p>
        <form method="POST" action="/admin/optouts/marcar">
          <input type="hidden" name="redirect" value="/admin/optouts">
          <label class="campo" style="max-width:320px;">
            <span>Telefone</span>
            <input type="text" name="telefone" required placeholder="+55 47 99958-2500">
          </label>
          <label class="campo" style="max-width:420px;">
            <span>O que suprimir</span>
            <select name="escopo">
              <option value="campanha" selected>${escapeHtml(ROTULO_ESCOPO.campanha)} — recomendado</option>
              <option value="total">${escapeHtml(ROTULO_ESCOPO.total)}</option>
            </select>
          </label>
          <label class="campo" style="max-width:420px;">
            <span>Motivo (opcional)</span>
            <input type="text" name="motivo" maxlength="200" placeholder="pediu no Live Chat em 05/09">
          </label>
          <p style="margin:.2rem 0 .8rem;color:var(--cinza);font-size:.9rem;">
            <b>Só campanhas</b> é o padrão: a pessoa para de receber convites e divulgação,
            e continua recebendo as mensagens dos processos seletivos em que se inscrever.
            <b>Tudo</b> bloqueia também essas — inclusive o resultado de uma candidatura dela.
          </p>
          <button type="submit" class="btn">Registrar</button>
        </form>
      </section>

      <section class="rel-sec">
        <h2>Lista</h2>
        <form method="GET" action="/admin/optouts" class="admin-filtros" style="margin-bottom:1rem;">
          <label class="campo" style="max-width:260px;">
            <span>Telefone</span>
            <input type="text" name="q" value="${escapeHtml(busca)}" placeholder="busca por número">
          </label>
          <label class="campo" style="max-width:220px;">
            <span>Escopo</span>
            <select name="escopo">
              <option value=""${escopo ? '' : ' selected'}>Todos</option>
              <option value="campanha"${escopo === 'campanha' ? ' selected' : ''}>${escapeHtml(ROTULO_ESCOPO.campanha)}</option>
              <option value="total"${escopo === 'total' ? ' selected' : ''}>${escapeHtml(ROTULO_ESCOPO.total)}</option>
            </select>
          </label>
          <label class="campo-check">
            <input type="checkbox" name="revogados" value="1"${incluirRevogados ? ' checked' : ''}>
            <span style="color:var(--preto);text-transform:none;">mostrar revogados</span>
          </label>
          <button type="submit" class="btn">Filtrar</button>
          ${busca || escopo || incluirRevogados ? '<a class="btn btn--ghost" href="/admin/optouts">Limpar</a>' : ''}
        </form>
        <div class="admin-tab-scroll">
          <table class="admin-tab">
            <thead><tr><th>Telefone</th><th>Escopo</th><th>Origem</th><th>Desde</th><th>Motivo</th><th>Ação</th></tr></thead>
            <tbody>${lista.itens.map(linha).join('') || '<tr><td colspan="6">Nenhum opt-out registrado.</td></tr>'}</tbody>
          </table>
        </div>
        ${paginacao}
      </section>`;

    res.send(paginaAdmin({ titulo: 'Opt-outs de WhatsApp', conteudo }));
  });

  // ── POST /marcar ── registra (ou escala) ──
  //
  // Serve os DOIS caminhos: o formulario desta tela e o botao de 1 clique das listagens. A
  // diferenca entre eles esta so no `redirect`, nunca na regra.
  router.post('/marcar', (req, res) => {
    const b = req.body || {};
    const destino = destinoInterno(b.redirect);
    const escopo = db.ESCOPOS_OPTOUT.includes(b.escopo) ? b.escopo : 'campanha';

    const r = optout.registrarOptout({
      telefone: b.telefone,
      escopo,
      origem: optout.ORIGEM_MANUAL,
      motivo: b.motivo,
    });

    if (!r.ok) return res.redirect(`${destino}${destino.includes('?') ? '&' : '?'}msg=telefone`);
    const msg = r.criado ? 'criado' : r.escalado ? 'escalado' : 'ja_existia';
    return res.redirect(`${destino}${destino.includes('?') ? '&' : '?'}msg=${msg}`);
  });

  // ── POST /revogar ── desfaz ──
  router.post('/revogar', (req, res) => {
    const b = req.body || {};
    const destino = destinoInterno(b.redirect);
    const revogou = optout.revogarOptout(b.telefone);
    return res.redirect(
      `${destino}${destino.includes('?') ? '&' : '?'}msg=${revogou ? 'revogado' : 'nada_revogar'}`,
    );
  });

  return router;
}

module.exports = {
  criarRouterOptout,
  seloOptout,
  botaoMarcarOptout,
  rotuloEscopo,
  rotuloOrigem,
  ROTULO_ESCOPO,
  ROTULO_ORIGEM,
};
