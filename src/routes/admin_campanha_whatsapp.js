'use strict';

// Painel da campanha por WhatsApp (Meta Cloud API). Montado em /admin/campanhas-whatsapp,
// herdando o router.use(adminAuth) do admin.js — sem auth propria, igual as demais telas.
//
// ── O QUE ESTA TELA E, E O QUE ELA NAO E ──
// E o lugar de PREENCHER OS 9 LINKS de grupo e de criar/ativar campanha. Nao e um editor de
// template: templates vivem na Meta, sao aprovados la, e esta tabela e espelho — permitir
// editar aqui daria a impressao de que mudar o texto no painel muda o que a Meta envia.
// Por isso a lista de templates e SOMENTE LEITURA nesta versao.

const express = require('express');

const db = require('../db');
const campanha = require('../lib/campanhaWhatsapp');
// Nome "Padrao" de proposito: criarRouterCampanhaWhatsapp aceita um `transporte` injetavel
// (default = este), mesmo padrao de `deps.db || dbPadrao` usado no resto do projeto — e o
// que permite o teste da rota POST /enviar-teste substituir por um transporte com
// httpClient mockado, sem NUNCA deixar a suite tocar rede de verdade (a rota chama
// enviarTemplate com forcarEnvioReal: true, que fura o mock por padrao).
const transportePadrao = require('../providers/centralWhats/centralWhats');
const { listarCidadesValidas } = require('../lib/cidades');
const publico = require('../lib/publicoCampanhaWhatsapp');
const { PERFIS_VALIDOS } = require('../lib/promocaoVagas');
// Telefone DIGITADO por gente (o campo de destino do envio avulso) exige a validacao
// ESTRITA — DDI 55 + DDD real + nono digito —, a mesma ja usada no formulario publico de
// candidatura (routes/api.js). `mascarar` e so para o LOG da tentativa de envio; o numero
// completo nunca aparece no stdout, mesma disciplina do resto do projeto.
const { validarTelefoneBrEstrito } = require('../lib/whatsapp');
const { mascarar } = require('../whatsapp/sequenciaOutbox');
const optout = require('../lib/optoutWhatsapp');
const {
  precisaBotaoDinamico,
  botoesDoTemplate,
  indiceBotaoDescadastro,
} = require('../lib/templatesWhatsapp');

// Os TRES objetivos de campanha (ETAPA B, Incremento 12 — redesenho da segmentacao). O valor
// gravado em campanhas_whatsapp.tipo_mensagem continua o mesmo de sempre (a coluna perdeu o
// CHECK no Incremento 12 — ver migrate.js — mas o vocabulario de valores aceitos e este,
// validado aqui no app). Ordem = ordem de exibicao no select.
const OBJETIVOS = [
  ['divulgacao_vaga', 'Promover uma vaga'],
  ['convite_grupo', 'Promover um grupo de vagas'],
  ['status_candidatura', 'Informar situação de candidatura'],
];

// Rotulos dos checkboxes de Status (Incremento 12) — MESMOS 3 valores de
// db.STATUS_RECRUTADOR_VALIDOS (decisao humana do recrutador, sqlite.js), so com rotulo pra
// exibicao. Nao redeclara o enum, so o rotulo — a validacao usa db.STATUS_RECRUTADOR_VALIDOS
// diretamente (ver lerCriterios).
const STATUS_CANDIDATURA_OPCOES = [
  ['aprovado', 'Aprovado'],
  ['reprovado', 'Reprovado'],
  ['em_analise', 'Em análise'],
];

// Campos de body ACEITOS por objetivo — usado por primeiroCampoIncompativel abaixo pra
// recusar (nao silenciosamente ignorar) um campo que nao pertence ao objetivo escolhido.
const CAMPOS_POR_OBJETIVO = {
  convite_grupo: ['cidade', 'de', 'ate', 'base_alvo'],
  divulgacao_vaga: ['job_id', 'cidade', 'de', 'ate', 'base_alvo'],
  status_candidatura: ['job_id', 'status_recrutador'],
};

// Devolve o NOME do primeiro campo presente no body que nao pertence ao objetivo `tipo`, ou
// null se todos os campos presentes pertencem. "Presente" e sobre o BODY cru (o que o
// navegador mandou), nao sobre criterios ja saneados — um form corretamente montado pra cada
// objetivo (JS de toggle desabilita o que nao se aplica, ver o <script> abaixo) nunca manda
// isto; um POST direto/adulterado manda, e e exatamente esse caso que isto pega.
//
// ── POR QUE ISTO EXISTE (Incremento 12) ──
// Ate aqui (Incremento 7), job_id sobrando no body de um convite_grupo virava NULL
// silenciosamente — tratado como "form mal preenchido, sem problema". O redesenho em 3
// objetivos aperta essa regra: um campo que nao pertence ao objetivo agora e ERRO explicito,
// porque a partir de status_candidatura existem campos (cidade, periodo, base_alvo) cuja
// presenca indicaria uma leitura ERRADA da intencao do operador (ex.: cidade preenchida
// numa campanha que devia ir so pra quem tem tal status, nao pra uma praca) — silenciar
// isso seria mais perigoso que recusar e pedir pra tentar de novo.
function primeiroCampoIncompativel(tipo, b) {
  const presentes = {
    job_id: String(b.job_id || '').trim() !== '',
    cidade: [].concat(b.cidade || []).filter(Boolean).length > 0,
    de: dataIsoValida(b.de),
    ate: dataIsoValida(b.ate),
    base_alvo: b.base_alvo !== undefined && String(b.base_alvo).trim() !== '',
    status_recrutador: [].concat(b.status_recrutador || []).filter(Boolean).length > 0,
  };
  const permitidos = new Set(CAMPOS_POR_OBJETIVO[tipo] || []);
  for (const [campo, presente] of Object.entries(presentes)) {
    if (presente && !permitidos.has(campo)) return campo;
  }
  return null;
}

// Calcula o publico do tipo pedido. Fonte UNICA para a criacao (estimativa), a previa e a
// materializacao — se divergissem, a tela mostraria um numero e o disparo usaria outro.
//
// status_candidatura (Incremento 13) usa `criterios.statusList` — o MESMO objeto `criterios`
// que os outros dois tipos usam para cidades/perfil/periodo, so que este campo so faz
// sentido pra ele (ja garantido pelo form + primeiroCampoIncompativel: status_candidatura e
// o UNICO objetivo que chega aqui com statusList preenchido).
function calcularPublico({ tipo, jobId, criterios }) {
  if (tipo === 'divulgacao_vaga') return publico.listarPublicoDivulgacaoVaga(jobId, criterios);
  if (tipo === 'status_candidatura') return publico.listarPublicoStatusCandidatura(jobId, criterios.statusList);
  return publico.listarPublicoConviteGrupo(criterios);
}

// Mesmo formato/regex de admin_promocao.js:dataIsoValida — duplicada aqui (e nao importada)
// porque e um one-liner puro sem estado, mesmo precedente ja aceito no projeto para
// validadores deste tamanho (ex.: `ehData` em admin.js).
function dataIsoValida(s) {
  return /^\d{4}-\d{2}-\d{2}$/.test(String(s || ''));
}

function lerCriterios(b = {}) {
  return {
    // `[].concat` pelo mesmo motivo de admin_promocao: o Express entrega `name` repetido como
    // array com 2+ marcados e como STRING com 1 so — sem isso, marcar uma cidade viraria
    // filtro por cada letra dela.
    cidades: [].concat(b.cidade || []).map(String).filter((c) => listarCidadesValidas().includes(c)),
    perfil: PERFIS_VALIDOS.includes(b.perfil) ? b.perfil : undefined,
    perfilIncluirSemAtributo: b.perfil_incluir_sem === '1' || b.perfil_incluir_sem === 'on',
    dataDe: dataIsoValida(b.de) ? b.de : undefined,
    dataAte: dataIsoValida(b.ate) ? b.ate : undefined,
    // ETAPA B, Incremento 12 — status_recrutador marcados (Aprovado/Reprovado/Em analise),
    // so relevante para o objetivo status_candidatura. Mesmo saneamento dos demais: so valor
    // dentro do enum sobrevive. Validado contra db.STATUS_RECRUTADOR_VALIDOS (sqlite.js) —
    // nao redeclarado aqui, pra nunca divergir da allowlist que a decisao humana usa.
    statusList: [].concat(b.status_recrutador || [])
      .map(String)
      .filter((s) => db.STATUS_RECRUTADOR_VALIDOS.includes(s)),
  };
}

const BASES_ALVO = [
  ['ambos', 'Candidatos + Base legada'],
  ['applications', 'Somente candidatos'],
  ['talentos', 'Somente base legada'],
];

// Contagem por status, agregada de UMA vez para todas as campanhas. A tela lista varias, e
// uma consulta por linha seria N+1 no mesmo painel onde ele ja e divida conhecida.
function contagensPorCampanha() {
  const mapa = new Map();
  for (const r of db.contarEnviosCampanhaWhatsapp()) {
    if (!mapa.has(r.campanha_id)) mapa.set(r.campanha_id, {});
    mapa.get(r.campanha_id)[r.status] = r.n;
  }
  return mapa;
}

// HTML interno da tela (/admin/campanhas-whatsapp), SEM o paginaAdmin(...) em volta —
// extraida para uma funcao pura (Item 3 do ETAPA B "Ajustes no Admin", Commit 6)
// reaproveitada tanto pela rota standalone abaixo (comportamento inalterado) quanto pela
// nova pagina /admin/divulgacao-vagas (Commit 7), que a embute como uma das abas.
// Grupo de checkboxes de multi-selecao — MESMO padrao (mesmas classes, mesmo contrato de
// "nada marcado = filtro inativo") de admin_promocao.js:checkboxes. Nao importada de la
// porque e uma funcao fechada dentro de criarRouterPromocao (nao exportada) — replicar o
// PADRAO aqui e o mais perto de "reaproveitar" que da sem extrair um modulo de UI
// compartilhado so para uma funcao de ~10 linhas usada em dois lugares.
function checkboxes(escapeHtml, nome, pares, marcados) {
  const marcadosSet = new Set((marcados || []).map(String));
  return pares
    .map(
      ([valor, rotulo]) => `
        <label class="campo-check" style="margin:.2rem 0 0;font-size:.85rem;">
          <input type="checkbox" name="${nome}" value="${escapeHtml(valor)}"${marcadosSet.has(valor) ? ' checked' : ''}>
          <span style="color:var(--cinza);text-transform:none;">${escapeHtml(rotulo)}</span>
        </label>`,
    )
    .join('');
}

// ── COLUNA "BOTOES" DA TABELA DE TEMPLATES ──
//
// Existe porque, ate aqui, a unica forma de confirmar que um template ganhou botao depois de
// uma sincronizacao era consultar o banco a mao. O passo "confira que o template aparece com
// o botao de descadastro" do docs/template-opt-out-meta.md nao tinha onde ser conferido.
//
// ── OS TRES ESTADOS SAO DIFERENTES, E CONFUNDI-LOS CUSTA CARO ──
//   botoes_json NULL  -> o sync NUNCA rodou desde que a coluna existe. NAO significa "sem
//                        botao": significa que nao sabemos. Este e o estado de TODOS os
//                        templates de producao agora (a coluna nasceu no deploy de hoje).
//   botoes_json '[]'  -> o sync rodou e o template REALMENTE nao tem botao.
//   com itens         -> o sync rodou e estes sao os botoes aprovados.
//
// Mostrar "nenhum" para o primeiro caso seria mentir, e a mentira e acionavel: alguem
// concluiria que a Meta nao salvou o botao e resubmeteria um template que ja esta correto.
function celulaBotoesTemplate(t, escapeHtml) {
  if (t.botoes_json == null) {
    return (
      '<span style="color:var(--cinza);" ' +
      'title="A lista de botões só é preenchida pela sincronização. Clique em ' +
      '&quot;Sincronizar templates&quot; para saber.">não sincronizado</span>'
    );
  }

  const botoes = botoesDoTemplate(t.botoes_json);
  if (!botoes.length) return '<span style="color:var(--cinza);">nenhum</span>';

  // O RECONHECIMENTO DO BOTAO DE DESCADASTRO E PELA URL, e nao pelo rotulo — e e a MESMA
  // funcao que o motor de envio usa (indiceBotaoDescadastro). Marcar pelo texto do botao
  // faria a tela dizer "descadastro ok" para um botao com o rotulo certo e a URL errada,
  // enquanto o envio silenciosamente nao preencheria o parametro. A tela precisa refletir a
  // opiniao do MOTOR, nao a aparencia.
  const indiceSaida = indiceBotaoDescadastro(botoes);

  return botoes
    .map((b) => {
      const selo =
        b.indice === indiceSaida
          ? ' <span class="badge badge--ativa" title="É este que recebe o token de descadastro no envio.">descadastro</span>'
          : '';
      const rotulo = String(b.texto || '').trim() || '(sem rótulo)';
      return `<div style="white-space:nowrap"><code>${b.indice}</code> ${escapeHtml(rotulo)}${selo}</div>`;
    })
    .join('');
}

// ── COLUNA "SINCRONIZACAO" ──
//
// ⚠️ `atualizado_em` SOZINHO NAO RESPONDE A PERGUNTA. Ele e antigo em producao (27/08, da
// ultima sincronizacao) enquanto `botoes_json` e NULL — ou seja, houve sync, mas ANTES de a
// coluna de botoes existir. Uma coluna que mostrasse so a data diria "sincronizado em 27/08"
// para um template cujo dado de botao nunca foi capturado, que e exatamente a leitura errada.
//
// Por isso o ESTADO vem de `botoes_json` e a data e informacao complementar.
function celulaSincronizacaoTemplate(t, escapeHtml, formatarDataHora) {
  const quando = t.atualizado_em ? escapeHtml(formatarDataHora(t.atualizado_em)) : null;
  if (t.botoes_json == null) {
    return (
      '<span style="color:var(--cinza);" title="Sincronize para capturar os botões deste ' +
      'template.">pendente</span>' +
      (quando ? `<br><small style="color:var(--cinza);">última: ${quando}</small>` : '')
    );
  }
  return quando || '<span style="color:var(--cinza);">—</span>';
}

function montarConteudoCampanhaWhatsapp({ escapeHtml, fmtInt, formatarDataHora, query = {} }) {
  const inteiro = (v) => (fmtInt ? fmtInt(v) : String(v));

  // ── Aviso pos-sincronizacao de templates, sinalizado por query string apos o redirect ──
  // Mesmo padrao de admin.js (flashLista: arquivados/restaurados/status_recrutador_aplicados
  // — numero na query string, lido e formatado aqui).
  const nSyncNovos = Number(query.sync_novos);
  const nSyncAtualizados = Number(query.sync_atualizados);
  const nSyncIgnorados = Number(query.sync_ignorados);
  const nSyncForaDoPadrao = Number(query.sync_ignorados_fora_do_padrao);
  const flashSync =
    query.sync_erro != null
      ? `<div class="aviso-alerta">Não foi possível sincronizar com o Central Whats: ${escapeHtml(String(query.sync_erro))}</div>`
      : query.sync_novos != null && Number.isInteger(nSyncNovos) && Number.isInteger(nSyncAtualizados)
        ? `<div class="aviso-ok">Sincronização concluída: ${nSyncNovos} template(s) novo(s), ${nSyncAtualizados} atualizado(s)${
            Number.isInteger(nSyncIgnorados) && nSyncIgnorados > 0
              ? `, ${nSyncIgnorados} ignorado(s) (status diferente de aprovado ou dado incompleto)`
              : ''
          }${
            Number.isInteger(nSyncForaDoPadrao) && nSyncForaDoPadrao > 0
              ? `, ${nSyncForaDoPadrao} fora do padrão de nome (não é da Vendedor Mestre, ignorado(s) de propósito)`
              : ''
          }.</div>`
        : '';

  // ── Aviso pos-exclusao de campanha, sinalizado por query string apos o redirect ──
  // Mesmo padrao de flashSync (acima): numero/codigo na query string, lido e formatado
  // aqui. Parametro DEDICADO (excluida/erro_exclusao), e nao o `erro` generico que ~10
  // outros redirects deste arquivo ja usam (POST /, /regiao, /:id/disparar, /:id/status) —
  // nenhum deles e lido em lugar nenhum hoje (sao redirects silenciosos), e reusar `erro`
  // aqui faria todos eles passarem a exibir mensagem pela primeira vez, com fallback pro
  // codigo cru pros que este mapa nao cobre. Fora de escopo mudar esse comportamento agora.
  const MENSAGENS_ERRO_EXCLUSAO_WA = {
    campanha_nao_encontrada: 'Campanha não encontrada.',
    status_invalido: 'Só é possível excluir uma campanha em rascunho.',
    tem_envios: 'Esta campanha já tem destinatários materializados — exclusão recusada por segurança.',
  };
  const flashExclusao =
    query.excluida === '1'
      ? '<div class="aviso-ok">Campanha excluída.</div>'
      : query.erro_exclusao != null
        ? `<div class="aviso-alerta">Não foi possível excluir: ${escapeHtml(
            MENSAGENS_ERRO_EXCLUSAO_WA[String(query.erro_exclusao)] || String(query.erro_exclusao),
          )}</div>`
        : '';

  const templates = db.listarTemplatesWhatsapp();
  // ETAPA B, Incremento 9: os DOIS <select> de escolha (Nova campanha, Testar envio avulso)
  // so oferecem template ATIVO — `templates` (todos, inclusive placeholders com ativo=0)
  // continua alimentando so a tabela "Templates aprovados (somente leitura)", que existe
  // justamente para mostrar o espelho completo.
  const templatesAtivos = db.listarTemplatesWhatsapp({ apenasAtivos: true });
  const regioes = db.listarRegioesGrupos();
  // Vaga sendo DIVULGADA (Incremento 7): so ativas, mesmo recorte de admin_promocao.js
  // (vagasAtivas). Divulgar uma vaga inativa nao faz sentido — seria convidar gente para se
  // candidatar a algo fechado.
  const vagasAtivas = db.listarVagas().filter((v) => v.ativo);
  const campanhas = db.listarCampanhasWhatsapp();
  const contagens = contagensPorCampanha();
  const ativo = campanha.ativo();
  const emMock = transportePadrao.modoMock();
  // Agora sao as CENTRALWHATS_*: quem fala com a Meta e o Central Whats, com o token dele.
  const faltando = transportePadrao.credenciaisFaltando();
  const semLink = regioes.filter((r) => !r.link_convite_grupo).length;

  // Diagnostico do que impede um disparo real. Ordem deliberada: da barreira mais externa
  // (o interruptor) para a mais interna (link faltando), que e a que o operador resolve
  // nesta mesma tela.
  const pendencias = [];
  if (!ativo) pendencias.push('O interruptor <b>Campanha por WhatsApp</b> está desligado em <a href="/admin/config">Configurações</a>.');
  if (emMock) pendencias.push('<code>META_CAMPANHA_MOCK</code> está ligado: o ciclo registra no log e <b>não envia nada</b>.');
  if (faltando.length) pendencias.push(`Credenciais ausentes no ambiente: <code>${faltando.join('</code>, <code>')}</code>.`);
  if (semLink) pendencias.push(`<b>${semLink}</b> praça(s) ainda sem link de grupo — preencha abaixo.`);

  const linhaRegiao = (r) => `
      <tr>
        <td>${escapeHtml(r.cidade)}</td>
        <td>
          <form method="post" action="/admin/campanhas-whatsapp/regiao" class="acoes-linha" style="gap:.4rem">
            <input type="hidden" name="cidade" value="${escapeHtml(r.cidade)}">
            <input type="text" name="link" value="${escapeHtml(r.link_convite_grupo || '')}"
                   placeholder="https://chat.whatsapp.com/..." style="min-width:22rem">
            <button type="submit" class="btn">Salvar</button>
          </form>
        </td>
        <td>${r.link_convite_grupo ? '<span class="badge badge--ativa">ok</span>' : '<span class="badge badge--aplicado">vazio</span>'}</td>
      </tr>`;

  const linhaCampanha = (c) => {
    const n = contagens.get(c.id) || {};
    const total = Object.values(n).reduce((a, b) => a + b, 0);
    return `
      <tr>
        <td>${c.id}</td>
        <td>${escapeHtml(c.nome)}</td>
        <td>${escapeHtml(c.template_nome || '(template removido)')}</td>
        <td>${escapeHtml(c.base_alvo)}</td>
        <td><span class="badge badge--${c.status === 'ativa' ? 'ativa' : 'aplicado'}">${escapeHtml(c.status)}</span></td>
        <td>${inteiro(total)}</td>
        <td style="font-size:.85rem;color:var(--cinza)">
          ${['pendente', 'enviado', 'entregue', 'lido', 'falha', 'opt_out']
            .filter((s) => n[s])
            .map((s) => `${s}: <b>${inteiro(n[s])}</b>`)
            .join(' · ') || '—'}
        </td>
        <td class="acoes-linha">
          ${c.status === 'rascunho'
            // Rascunho MATERIALIZA ao ativar — precisa ir para /disparar (que grava
            // campanha_whatsapp_envios e so DEPOIS marca 'ativa'), nunca para /status. Bater
            // em /status aqui e o bug do Incremento 16: a campanha virava 'ativa' sem nunca
            // materializar (ver o comentario do guard em POST /:id/disparar).
            ? `<form method="post" action="/admin/campanhas-whatsapp/${c.id}/disparar"><button class="btn">Ativar</button></form>`
            : c.status === 'ativa'
            ? `<form method="post" action="/admin/campanhas-whatsapp/${c.id}/status"><input type="hidden" name="status" value="pausada"><button class="btn btn--ghost">Pausar</button></form>`
            : c.status === 'pausada'
            // Pausada -> ativa NAO materializa de novo: a fila ja existe de quando a
            // campanha foi disparada a primeira vez. /status e o caminho certo aqui.
            ? `<form method="post" action="/admin/campanhas-whatsapp/${c.id}/status"><input type="hidden" name="status" value="ativa"><button class="btn">Retomar</button></form>`
            : `<form method="post" action="/admin/campanhas-whatsapp/${c.id}/status"><input type="hidden" name="status" value="ativa"><button class="btn">Ativar</button></form>`}
          ${c.status === 'rascunho'
            // Excluir SO em rascunho — mesmo criterio de db.excluirCampanhaWhatsapp (a
            // funcao recusaria de qualquer forma; a condicao aqui e so pra nao oferecer um
            // botao que o servidor ja sabe que vai recusar). data-confirm e o modal
            // reutilizavel (SCRIPT_MODAL_CONFIRMACAO, admin.js) — funciona aqui sem nenhuma
            // wire-up extra porque toda pagina admin ja carrega aquele script.
            ? `<form method="post" action="/admin/campanhas-whatsapp/${c.id}/excluir"
                     data-confirm="Esta campanha em rascunho será apagada definitivamente. Não há desfazer."
                     data-confirm-titulo="Excluir campanha" data-confirm-texto="Sim, excluir"
                     data-confirm-destrutivo="1">
                 <button type="submit" class="btn btn--ghost">Excluir</button>
               </form>`
            : ''}
        </td>
      </tr>`;
  };

  return `
    <p><a class="btn btn--ghost" href="/admin">← Voltar ao painel</a></p>
    <h1>Campanha por WhatsApp</h1>
    <p class="admin-sub" style="margin-bottom:1.25rem">
      Envio em massa pela API oficial da Meta. Frente separada da sequência WA1/WA2 —
      veja <a href="/admin/whatsapp">WhatsApp (pareamento)</a>.
    </p>

    ${flashExclusao}
    ${pendencias.length
      ? `<div class="aviso-alerta"><b>Nada sai enquanto houver:</b><ul class="lista">${pendencias.map((p) => `<li>${p}</li>`).join('')}</ul></div>`
      : '<div class="aviso-ok">Tudo configurado: o ciclo vai enviar de verdade.</div>'}

    <details class="bloco-card" open>
      <summary>Links dos grupos por praça</summary>
      <p style="color:var(--cinza);font-size:.85rem">
        Praça sem link não recebe campanha: o ciclo marca aquele envio como falha de
        configuração e segue para o próximo, sem abortar.
      </p>
      <div class="admin-tab-scroll">
        <table class="admin-tab" style="min-width:auto">
          <thead><tr><th>Praça</th><th>Link do grupo</th><th>Status</th></tr></thead>
          <tbody>${regioes.map(linhaRegiao).join('') || `<tr><td colspan="3">Nenhuma praça cadastrada. Rode <code>node src/scripts/seed-campanha-whatsapp.js</code>.</td></tr>`}</tbody>
        </table>
      </div>
    </details>

    <details class="bloco-card">
      <summary>Templates aprovados (somente leitura)</summary>
      <p style="color:var(--cinza);font-size:.85rem">
        Templates vivem na Meta e são aprovados lá. Esta tabela é um espelho — editar aqui
        não mudaria o que a Meta envia, por isso é somente leitura.
      </p>
      ${flashSync}
      <form method="post" action="/admin/campanhas-whatsapp/sincronizar-templates" style="margin:0 0 .75rem;">
        <button type="submit" class="btn btn--ghost">Sincronizar templates</button>
        <span style="color:var(--cinza);font-size:.8rem;margin-left:.5rem;">
          Busca os templates aprovados na Meta (via Central Whats) e atualiza esta tabela.
        </span>
      </form>
      <div class="admin-tab-scroll">
        <table class="admin-tab" style="min-width:auto">
          <thead><tr><th>Nome na Meta</th><th>Idioma</th><th>Categoria</th><th>Variáveis</th><th>Botões</th><th>Sincronização</th></tr></thead>
          <tbody>${templates.map((t) => `
            <tr>
              <td><code>${escapeHtml(t.nome_meta)}</code></td>
              <td>${escapeHtml(t.idioma)}</td>
              <td>${escapeHtml(t.categoria)}</td>
              <td style="font-size:.85rem">${escapeHtml(t.variaveis)}</td>
              <td style="font-size:.85rem">${celulaBotoesTemplate(t, escapeHtml)}</td>
              <td style="font-size:.85rem">${celulaSincronizacaoTemplate(t, escapeHtml, formatarDataHora)}</td>
            </tr>`).join('') || '<tr><td colspan="6">Nenhum template. Rode o seed.</td></tr>'}
          </tbody>
        </table>
      </div>
    </details>

    <details class="bloco-card" ${campanhas.length ? '' : 'open'}>
      <summary>Nova campanha</summary>
      <form method="post" action="/admin/campanhas-whatsapp" class="vm-form" id="form-nova-campanha">
        <label class="campo"><span>Nome</span>
          <input type="text" name="nome" required maxlength="120" placeholder="Ex.: Convite grupo Joinville — agosto">
        </label>
        <label class="campo"><span>Template</span>
          <select name="template_id" required>
            ${templatesAtivos.map((t) => `<option value="${t.id}">${escapeHtml(t.nome_meta)} (${escapeHtml(t.categoria)})</option>`).join('')}
          </select>
        </label>
        <label class="campo"><span>Objetivo</span>
          <select name="tipo_mensagem" id="campo-objetivo">
            ${OBJETIVOS.map(([v, r]) => `<option value="${v}">${escapeHtml(r)}</option>`).join('')}
          </select>
        </label>

        <!-- Vaga (job_id): MESMO <select>, usado por dois objetivos com rotulos diferentes —
             "Vaga sendo divulgada" (divulgacao_vaga) e "Vaga em questão" (status_candidatura).
             O JS de toggle troca o texto do rotulo; a lista de opcoes e a mesma. -->
        <label class="campo" id="campo-vaga-alvo" hidden>
          <span id="rotulo-vaga-alvo">Vaga sendo divulgada (obrigatório)</span>
          <select name="job_id">
            <option value="">Selecione a vaga…</option>
            ${vagasAtivas.map((v) => `<option value="${v.id}">${escapeHtml(v.titulo || `Vaga ${v.id}`)} · ${escapeHtml(v.perfil)}</option>`).join('')}
          </select>
        </label>

        <!-- Segmentacao (Base alvo, Cidade, Periodo): so faz sentido em convite_grupo e
             divulgacao_vaga. Em status_candidatura o recorte inteiro JA e "candidatos desta
             vaga com este status" — Base/Cidade/Periodo nem sao exibidos (ver o diagnostico
             da ETAPA A, item 11: Base legada nunca tem status_recrutador). -->
        <div id="campo-segmentacao">
          <label class="campo"><span>Base alvo</span>
            <select name="base_alvo">
              ${BASES_ALVO.map(([v, r]) => `<option value="${v}">${escapeHtml(r)}</option>`).join('')}
            </select>
          </label>
          <div class="admin-filtros" style="align-items:flex-start;">
            <div class="filtro">
              <span>Cidade</span>
              ${listarCidadesValidas().length
                ? checkboxes(escapeHtml, 'cidade', listarCidadesValidas().map((c) => [c, c]), [])
                  + `<span style="display:block;color:var(--cinza);font-size:.78rem;margin-top:.35rem;text-transform:none;max-width:16rem">
                       Nenhuma marcada = todas as praças.
                     </span>`
                : `<span style="color:var(--cinza);font-size:.8rem;text-transform:none;">
                     Nenhuma cidade cadastrada.
                   </span>`}
            </div>
            <label class="filtro">
              <span>Candidatura/cadastro de</span>
              <input type="date" name="de">
            </label>
            <label class="filtro">
              <span>até</span>
              <input type="date" name="ate">
            </label>
          </div>
        </div>

        <!-- Status da candidatura: SO em status_candidatura. Pelo menos 1 marcado e
             obrigatorio (desvio deliberado do padrao "nada marcado = todos" — ver o
             comentario em lib/publicoCampanhaWhatsapp.js:listarPublicoStatusCandidatura). -->
        <div id="campo-status-candidatura" hidden>
          <div class="filtro">
            <span>Status (pelo menos um obrigatório)</span>
            ${checkboxes(escapeHtml, 'status_recrutador', STATUS_CANDIDATURA_OPCOES, [])}
          </div>
          <p id="aviso-status-candidatura" class="aviso-alerta" hidden style="margin-top:.5rem;">
            Marque pelo menos um status antes de criar a campanha.
          </p>
        </div>

        <p style="margin:-.6rem 0 1rem;color:var(--cinza);font-size:.8rem">
          A campanha nasce em <b>rascunho</b> e não envia nada até ser ativada aqui.
        </p>
        <button type="button" class="btn btn--ghost" id="btn-calcular-previa">Calcular estimativa</button>
        <p id="resultado-previa" class="aviso-ok" hidden style="margin:.6rem 0 0;"></p>
        <p id="erro-previa" class="aviso-alerta" hidden style="margin:.6rem 0 0;"></p>
        <p style="margin:.8rem 0 0;">
          <button type="submit" class="btn" id="btn-criar-campanha" disabled>Criar campanha</button>
        </p>
      </form>
    </details>

    <script>
    (function () {
      // Mostra/esconde os blocos condicionais conforme o Objetivo — mesmo mecanismo
      // (propriedade .hidden, nao style.display) ja usado para paineis condicionais em
      // admin.js (o toggle de abas). Nao ha precedente de um <select> disparando esse toggle
      // no projeto (ver Incremento 7); o addEventListener('change') e o proprio fallback
      // sugerido, agora com 3 ramos em vez de 2.
      var form = document.getElementById('form-nova-campanha');
      var selObjetivo = document.getElementById('campo-objetivo');
      if (!form || !selObjetivo) return;
      var campoVagaAlvo = document.getElementById('campo-vaga-alvo');
      var rotuloVagaAlvo = document.getElementById('rotulo-vaga-alvo');
      var selVagaAlvo = campoVagaAlvo ? campoVagaAlvo.querySelector('select') : null;
      var campoSegmentacao = document.getElementById('campo-segmentacao');
      var campoStatus = document.getElementById('campo-status-candidatura');
      var avisoStatus = document.getElementById('aviso-status-candidatura');

      // disabled junto com hidden: um campo desabilitado NAO e enviado no submit, entao
      // trocar de objetivo depois de ter preenchido algo nao deixa sobrar campo incompativel
      // no body do POST — o proprio navegador ja garante o que o servidor valida de novo
      // (defesa em profundidade — primeiroCampoIncompativel, nao substitui a validacao la).
      function alternar(container, visivel) {
        if (!container) return;
        container.hidden = !visivel;
        var campos = container.querySelectorAll('input, select');
        for (var i = 0; i < campos.length; i += 1) campos[i].disabled = !visivel;
      }

      function atualizar() {
        var objetivo = selObjetivo.value;
        var temVaga = objetivo === 'divulgacao_vaga' || objetivo === 'status_candidatura';
        alternar(campoVagaAlvo, temVaga);
        if (rotuloVagaAlvo) {
          rotuloVagaAlvo.textContent = objetivo === 'status_candidatura'
            ? 'Vaga em questão (obrigatório)'
            : 'Vaga sendo divulgada (obrigatório)';
        }
        alternar(campoSegmentacao, objetivo !== 'status_candidatura');
        alternar(campoStatus, objetivo === 'status_candidatura');
        if (avisoStatus) avisoStatus.hidden = true;
      }
      selObjetivo.addEventListener('change', atualizar);
      atualizar();

      // Pelo menos 1 status marcado — validacao CLIENT-SIDE (a de verdade e no servidor,
      // erro=status_vazio). Checkbox de grupo nao tem "required" nativo (required numa
      // checkbox exige SO ELA marcada, nao "pelo menos uma do grupo"), entao isto e feito
      // a mao no submit.
      form.addEventListener('submit', function (e) {
        if (selObjetivo.value !== 'status_candidatura') return;
        var marcado = form.querySelector('input[name="status_recrutador"]:checked');
        if (marcado) return;
        e.preventDefault();
        if (avisoStatus) avisoStatus.hidden = false;
      });

      // ── Previa de publico (ETAPA B, Incremento 2) ──
      //
      // "Criar campanha" nasce disabled no HTML (defesa em profundidade client-side; o
      // servidor continua validando tudo de novo no POST de criacao, sem confiar so
      // nisso — POST / recalcula o publico do zero antes de gravar). So habilita depois
      // de uma previa calculada com sucesso, e QUALQUER mudanca no form depois disso
      // invalida a estimativa de novo — ela nao pode ficar "validando" um recorte que ja
      // mudou.
      //
      // POST /admin/campanhas-whatsapp/previa aceita application/x-www-form-urlencoded
      // (confirmado contra o body parser real: express.urlencoded() e express.json() estao
      // os dois montados globalmente em server.js, os dois funcionam — urlencoded foi o
      // escolhido por ser o MESMO formato que o submit nativo deste form ja usa, sem
      // enctype especial).
      var btnPrevia = document.getElementById('btn-calcular-previa');
      var btnCriar = document.getElementById('btn-criar-campanha');
      var resultadoPrevia = document.getElementById('resultado-previa');
      var erroPrevia = document.getElementById('erro-previa');

      function invalidarPrevia() {
        if (resultadoPrevia) resultadoPrevia.hidden = true;
        if (erroPrevia) erroPrevia.hidden = true;
        if (btnCriar) btnCriar.disabled = true;
      }

      if (btnPrevia && btnCriar) {
        btnPrevia.addEventListener('click', function () {
          btnPrevia.disabled = true;
          var textoOriginalBtnPrevia = btnPrevia.textContent;
          btnPrevia.textContent = 'Calculando…';
          fetch('/admin/campanhas-whatsapp/previa', {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams(new FormData(form)),
          })
            .then(function (r) {
              return r.json().then(function (dados) { return { status: r.status, dados: dados }; });
            })
            .then(function (res) {
              if (res.dados && res.dados.ok) {
                if (resultadoPrevia) {
                  resultadoPrevia.textContent = 'Estimativa: ' + res.dados.total + ' destinatário(s) no recorte atual.';
                  resultadoPrevia.hidden = false;
                }
                if (erroPrevia) erroPrevia.hidden = true;
                btnCriar.disabled = false;
              } else {
                if (erroPrevia) {
                  erroPrevia.textContent = (res.dados && res.dados.erro) || 'Não foi possível calcular a estimativa.';
                  erroPrevia.hidden = false;
                }
                if (resultadoPrevia) resultadoPrevia.hidden = true;
                btnCriar.disabled = true;
              }
            })
            .catch(function () {
              if (erroPrevia) {
                erroPrevia.textContent = 'Falha ao calcular a estimativa. Verifique sua conexão e tente de novo.';
                erroPrevia.hidden = false;
              }
              if (resultadoPrevia) resultadoPrevia.hidden = true;
              btnCriar.disabled = true;
            })
            .finally(function () {
              btnPrevia.disabled = false;
              btnPrevia.textContent = textoOriginalBtnPrevia;
            });
        });

        // Delegado no form inteiro (change + input, cobre select/checkbox/date e texto):
        // objetivo, vaga, base alvo, cidade, período, status marcado — qualquer campo.
        // Exclui os dois botoes do proprio gatilho: um <button> nao dispara change/input
        // por clique mesmo, mas fica explicito aqui pra nao depender disso por acidente —
        // o clique em "Calcular estimativa" nao pode se autoinvalidar, e "Criar campanha"
        // (que so fica clicavel DEPOIS de uma previa) nao deve reagir a si mesmo.
        //
        // Cobre o toggle de Objetivo (selObjetivo, acima) de graca: 'change' num <select>
        // sempre borbulha ate o form, entao trocar de objetivo invalida a previa mesmo sem
        // nenhum codigo extra aqui — atualizar() roda primeiro (listener direto no select),
        // depois este listener roda por borbulhamento. Os campos que atualizar() desabilita
        // (ex.: campo-vaga-alvo ao sair de divulgacao_vaga) NAO disparam change sozinhos,
        // mas isso e inofensivo: a mudanca do PROPRIO select de objetivo ja invalidou tudo.
        form.addEventListener('change', function (e) {
          if (e.target === btnPrevia || e.target === btnCriar) return;
          invalidarPrevia();
        });
        form.addEventListener('input', function (e) {
          if (e.target === btnPrevia || e.target === btnCriar) return;
          invalidarPrevia();
        });
      }
    })();
    </script>

    <details class="bloco-card">
      <summary>Testar envio avulso</summary>
      <p style="color:var(--cinza);font-size:.85rem">
        Escolha um candidato real para ver as variáveis do template preenchidas com os dados
        dele, digite um telefone de destino e dispare UMA mensagem de verdade — este envio
        <b>ignora <code>META_CAMPANHA_MOCK</code></b> e não é campanha nenhuma: não grava em
        <code>campanha_whatsapp_envios</code>, não tem fila, não repete.
      </p>
      <div class="vm-form" style="max-width:32rem">
        <label class="campo"><span>Buscar candidato</span>
          <input type="text" id="teste-busca-candidato" placeholder="Nome, e-mail ou telefone" autocomplete="off">
        </label>
        <div id="teste-resultados-busca" style="margin:-.6rem 0 1rem"></div>
        <label class="campo"><span>Telefone de destino</span>
          <input type="text" id="teste-telefone" placeholder="+55 47 99999-9999">
        </label>
        <label class="campo"><span>Template</span>
          <select id="teste-template">
            ${templatesAtivos.map((t) => `<option value="${t.id}">${escapeHtml(t.nome_meta)} (${escapeHtml(t.categoria)})</option>`).join('')}
          </select>
        </label>
        <button type="button" id="teste-btn-enviar" class="btn">Enviar teste real</button>
        <div id="teste-resultado" style="margin-top:.8rem;overflow-wrap:break-word"></div>
      </div>
    </details>

    <script>
    (function () {
      // Sem framework, sem dependencia nova — mesmo espirito do resto do painel admin. Toda
      // busca escreve os resultados via DOM (createElement/textContent), NUNCA innerHTML com
      // string interpolada: nome/telefone/vaga vem do banco, e um candidato com um nome
      // "criativo" nao pode injetar HTML nesta tela.
      var buscaInput = document.getElementById('teste-busca-candidato');
      if (!buscaInput) return; // secao pode nao estar presente (defensivo)
      var resultadosDiv = document.getElementById('teste-resultados-busca');
      var telefoneInput = document.getElementById('teste-telefone');
      var templateSelect = document.getElementById('teste-template');
      var btnEnviar = document.getElementById('teste-btn-enviar');
      var resultadoDiv = document.getElementById('teste-resultado');
      var candidatoEscolhido = null;
      var debounce = null;

      function limparResultados() {
        while (resultadosDiv.firstChild) resultadosDiv.removeChild(resultadosDiv.firstChild);
      }

      function mostrarAviso(container, classe, texto) {
        while (container.firstChild) container.removeChild(container.firstChild);
        var p = document.createElement('p');
        p.className = classe;
        p.textContent = texto;
        container.appendChild(p);
      }

      buscaInput.addEventListener('input', function () {
        var termo = buscaInput.value.trim();
        candidatoEscolhido = null;
        clearTimeout(debounce);
        limparResultados();
        if (!termo) return;
        debounce = setTimeout(function () {
          fetch('/admin/campanhas-whatsapp/buscar-candidato?q=' + encodeURIComponent(termo))
            .then(function (r) { return r.json(); })
            .then(function (lista) {
              limparResultados();
              if (!lista.length) {
                mostrarAviso(resultadosDiv, 'aviso-alerta', 'Nenhum candidato encontrado.');
                return;
              }
              lista.forEach(function (c) {
                var btn = document.createElement('button');
                btn.type = 'button';
                btn.className = 'btn btn--ghost';
                btn.style.cssText = 'display:block;width:100%;text-align:left;margin-bottom:.3rem';
                var nome = [c.nome, c.sobrenome].filter(Boolean).join(' ') || '(sem nome)';
                var detalhe = (c.telefone || 's/ telefone') + (c.vaga_titulo ? ' · ' + c.vaga_titulo : '');
                btn.textContent = nome + ' — ' + detalhe;
                btn.addEventListener('click', function () {
                  candidatoEscolhido = c.id;
                  telefoneInput.value = c.telefone || '';
                  buscaInput.value = nome;
                  limparResultados();
                });
                resultadosDiv.appendChild(btn);
              });
            })
            .catch(function () {
              mostrarAviso(resultadosDiv, 'aviso-alerta', 'Falha ao buscar. Tente de novo.');
            });
        }, 300);
      });

      btnEnviar.addEventListener('click', function () {
        if (!candidatoEscolhido) {
          mostrarAviso(resultadoDiv, 'aviso-alerta', 'Escolha um candidato na busca acima.');
          return;
        }
        var telefone = telefoneInput.value.trim();
        if (!telefone) {
          mostrarAviso(resultadoDiv, 'aviso-alerta', 'Digite o telefone de destino.');
          return;
        }
        var opcaoTemplate = templateSelect.options[templateSelect.selectedIndex];
        var templateNome = opcaoTemplate ? opcaoTemplate.text : '(nenhum template)';
        // Modal (ETAPA B, Incremento 8) em vez de confirm() nativo — dinamico, nao da para
        // usar data-confirm estatico (telefone e template mudam com a escolha do operador).
        // Mostra os dois ANTES de confirmar: e um envio de verdade, para um numero de verdade.
        window.confirmarAcao({
          titulo: 'Enviar mensagem real?',
          mensagem: 'Isto envia uma mensagem de WhatsApp DE VERDADE para ' + telefone +
            ', usando o template “' + templateNome + '”.',
          textoConfirmar: 'Enviar',
          destrutivo: true,
        }).then(function (confirmado) {
          if (!confirmado) return;

          btnEnviar.disabled = true;
          mostrarAviso(resultadoDiv, 'aviso-ok', 'Enviando…');
          return fetch('/admin/campanhas-whatsapp/enviar-teste', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              applicationId: candidatoEscolhido,
              templateId: Number(templateSelect.value),
              telefoneDestino: telefone,
            }),
          })
            .then(function (r) { return r.json().then(function (corpo) { return { status: r.status, corpo: corpo }; }); })
            .then(function (res) {
              if (res.corpo && res.corpo.ok) {
                // O wamid (ID tecnico interno) NAO aparece mais na tela — e uma string longa
                // sem espaços que estourava a largura da caixa e nao tem utilidade nenhuma
                // pro operador. Continua disponivel no JSON de resposta (res.corpo.wamid) e
                // nos logs do Railway, so nao e mais exibido aqui.
                mostrarAviso(resultadoDiv, 'aviso-ok', 'Enviado com sucesso.');
              } else {
                mostrarAviso(resultadoDiv, 'aviso-alerta', 'Falhou: ' + ((res.corpo && res.corpo.erro) || ('HTTP ' + res.status)));
              }
            })
            .catch(function (err) {
              mostrarAviso(resultadoDiv, 'aviso-alerta', 'Falhou: ' + err.message);
            })
            .finally(function () {
              btnEnviar.disabled = false;
            });
        });
      });
    })();
    </script>

    <section class="rel-sec">
      <h2>Campanhas</h2>
      <div class="admin-tab-scroll">
        <table class="admin-tab">
          <thead><tr><th>#</th><th>Nome</th><th>Template</th><th>Base</th><th>Status</th><th>Total</th><th>Por status</th><th>Ações</th></tr></thead>
          <tbody>${campanhas.map(linhaCampanha).join('') || '<tr><td colspan="8">Nenhuma campanha ainda.</td></tr>'}</tbody>
        </table>
      </div>
    </section>`;
}

function criarRouterCampanhaWhatsapp({
  paginaAdmin,
  escapeHtml,
  fmtInt,
  sanearBusca,
  formatarDataHora,
  transporte = transportePadrao,
}) {
  const router = express.Router();

  // ── GET / ── a tela ──
  router.get('/', (req, res) => {
    const conteudo = montarConteudoCampanhaWhatsapp({
      escapeHtml,
      fmtInt,
      formatarDataHora,
      query: req.query || {},
    });
    res.send(paginaAdmin({ titulo: 'Campanha por WhatsApp', conteudo }));
  });

  // ── POST /sincronizar-templates ── busca os templates aprovados no Central Whats e faz
  // upsert local (templates_whatsapp) — substitui o INSERT manual via railway ssh usado ate
  // hoje toda vez que um template novo e aprovado na Meta.
  //
  // NAO reusa a materializacao de campanha nem nenhuma fila: e uma acao SINCRONA e RARA
  // (um clique manual, no maximo algumas vezes por mes), disparada pelo operador — nao ha
  // motivo para passar por um ciclo periodico so pra isto. listarTemplatesCentralWhats NAO
  // lanca por contrato (devolve { ok: false, erro }, ver centralWhats.js) — mas o try/catch
  // abaixo e defesa em profundidade, mesmo padrao de POST /enviar-teste neste arquivo: o
  // Express 4 NAO captura sozinho uma rejeicao de handler async, e se algum dia o contrato
  // de "nunca lanca" for violado (aqui ou num transporte injetado em teste), a rota
  // continua respondendo com um redirect claro em vez de derrubar a requisicao sem resposta.
  router.post('/sincronizar-templates', async (req, res) => {
    try {
      const resultado = await transporte.listarTemplatesCentralWhats();
      if (!resultado.ok) {
        return res.redirect(`/admin/campanhas-whatsapp?sync_erro=${encodeURIComponent(resultado.erro)}`);
      }

      let novos = 0;
      let atualizados = 0;
      let ignorados = 0;
      // Contado A PARTE dos demais ignorados (status/categoria/nome ausente): sao templates
      // de OUTRO uso da mesma conta Central Whats (ex.: convite_bni_workshop_ady, do
      // workshop do BNI) — nao e um problema de dado, e o filtro funcionando como esperado.
      // Ver razao: 'fora_do_padrao' em sincronizarTemplateWhatsapp (sqlite.js).
      let ignoradosForaDoPadrao = 0;
      for (const t of resultado.templates) {
        const r = db.sincronizarTemplateWhatsapp(t);
        if (r.ignorado && r.razao === 'fora_do_padrao') ignoradosForaDoPadrao += 1;
        else if (r.ignorado) ignorados += 1;
        else if (r.novo) novos += 1;
        else atualizados += 1;
      }

      return res.redirect(
        `/admin/campanhas-whatsapp?sync_novos=${novos}&sync_atualizados=${atualizados}` +
          `&sync_ignorados=${ignorados}&sync_ignorados_fora_do_padrao=${ignoradosForaDoPadrao}`,
      );
    } catch (err) {
      console.error(`[campanha-wa] sincronizacao de templates falhou inesperadamente: ${err.message}`);
      return res.redirect(`/admin/campanhas-whatsapp?sync_erro=${encodeURIComponent(err.message)}`);
    }
  });

  // ── POST /regiao ── salva o link de UMA praca ──
  router.post('/regiao', (req, res) => {
    const b = req.body || {};
    const cidade = String(b.cidade || '').trim();
    // So aceita praca do vocabulario fechado: o link e por praca, e uma cidade forjada
    // criaria uma linha que nenhum envio jamais consulta.
    if (!listarCidadesValidas().includes(cidade)) {
      return res.redirect('/admin/campanhas-whatsapp?erro=cidade');
    }
    db.definirLinkGrupo(cidade, b.link);
    res.redirect('/admin/campanhas-whatsapp?salvo=1');
  });

  // ── POST / ── cria campanha (sempre em rascunho) ──
  router.post('/', (req, res) => {
    const b = req.body || {};
    const nome = String(b.nome || '').trim();
    const templateId = Number(b.template_id);

    const templateEscolhido = Number.isInteger(templateId) ? db.obterTemplateWhatsapp(templateId) : null;
    if (!nome || !templateEscolhido) {
      return res.redirect('/admin/campanhas-whatsapp?erro=dados');
    }
    // Incremento 9: template inativo (placeholder nunca sincronizado no Central Whats/Meta —
    // ver o diagnostico da ETAPA A) nao pode virar campanha. O select do form ja so oferece
    // ativos, mas o POST nao pode confiar so nisso — mesma disciplina ja aplicada a vaga-alvo
    // no Incremento 7 (form adulterado/direto nao pode furar a checagem do servidor).
    if (!templateEscolhido.ativo) {
      return res.redirect('/admin/campanhas-whatsapp?erro=template_inativo');
    }
    const tipo = OBJETIVOS.some(([v]) => v === b.tipo_mensagem) ? b.tipo_mensagem : 'convite_grupo';

    // Incremento 12: campo que nao pertence ao objetivo escolhido e ERRO, nao mais
    // silenciosamente ignorado (ver primeiroCampoIncompativel). ANTES de qualquer outra
    // validacao de campo especifico, pra nao interpretar um body incoerente como se fizesse
    // sentido.
    const campoErrado = primeiroCampoIncompativel(tipo, b);
    if (campoErrado) {
      console.warn(`[campanha-wa] POST / recusado: campo '${campoErrado}' incompativel com objetivo '${tipo}'.`);
      return res.redirect('/admin/campanhas-whatsapp?erro=campo_incompativel');
    }

    // Vaga (job_id): obrigatoria e validada (existe + ativa) em divulgacao_vaga E
    // status_candidatura — as duas usam o MESMO select ("Vaga sendo divulgada"/"Vaga em
    // questão"). Fica NULL em convite_grupo — garantido pela checagem de campo incompativel
    // acima, que ja recusou um convite_grupo com job_id no body antes de chegar aqui.
    let jobId = null;
    if (tipo === 'divulgacao_vaga' || tipo === 'status_candidatura') {
      const jobIdBruto = Number(b.job_id);
      // Nenhum dos dois objetivos existe sem vaga: a mensagem inteira e sobre ela.
      if (!Number.isInteger(jobIdBruto) || jobIdBruto <= 0) {
        return res.redirect('/admin/campanhas-whatsapp?erro=vaga');
      }
      const vagaAlvo = db.obterVaga(jobIdBruto);
      // Vaga inexistente ou inativa: divulgar/informar sobre algo que nao existe (mais) ou
      // que fechou nao faz sentido. O select do form ja so lista vagas ativas, mas o POST
      // nao pode confiar so nisso — chega aqui tambem por form adulterado.
      if (!vagaAlvo || !vagaAlvo.ativo) {
        return res.redirect('/admin/campanhas-whatsapp?erro=vaga_invalida');
      }
      jobId = jobIdBruto;
    }

    const criterios = lerCriterios(b);
    // status_candidatura exige pelo menos 1 status marcado — mesmo tratamento de "job_id
    // ausente" acima: erro claro, nunca publico vazio nem publico total silenciosos (ver o
    // desvio de padrao documentado em listarPublicoStatusCandidatura).
    if (tipo === 'status_candidatura' && !criterios.statusList.length) {
      return res.redirect('/admin/campanhas-whatsapp?erro=status_vazio');
    }

    // Base alvo nao se aplica a status_candidatura (ja garantido: primeiroCampoIncompativel
    // recusou base_alvo presente nesse objetivo). 'ambos' aqui e so o valor inerte que a
    // coluna NOT NULL exige — listarPublicoStatusCandidatura nunca le base_alvo.
    const baseAlvo = BASES_ALVO.some(([v]) => v === b.base_alvo) ? b.base_alvo : 'ambos';

    let total = null;
    try {
      total = calcularPublico({ tipo, jobId, criterios }).total;
    } catch {
      total = null; // estimativa e informativa; nao pode impedir a criacao do rascunho
    }

    // Nasce em 'rascunho' pelo default da coluna: criar nao dispara. Materializar e um
    // segundo clique, deliberado.
    db.criarCampanhaWhatsapp({
      nome,
      templateId,
      baseAlvo,
      tipoMensagem: tipo,
      jobId,
      totalEstimado: total,
      criterios,
    });
    res.redirect('/admin/campanhas-whatsapp?salvo=1');
  });

  // ── POST /previa ── calcula o publico SEM gravar nada ──
  //
  // Existe para o operador ver o tamanho do recorte antes de criar a campanha. Nao grava
  // linha nenhuma: e a mesma disciplina da previa da campanha de e-mail.
  router.post('/previa', (req, res) => {
    const b = req.body || {};
    const tipo = OBJETIVOS.some(([v]) => v === b.tipo_mensagem) ? b.tipo_mensagem : 'convite_grupo';
    const jobId = Number(b.job_id);
    try {
      const r = calcularPublico({ tipo, jobId, criterios: lerCriterios(b) });
      res.json({ ok: true, total: r.total, tipo });
    } catch (err) {
      res.status(400).json({ ok: false, erro: err.message });
    }
  });

  // ── GET /buscar-candidato ── autocomplete p/ o envio avulso de teste ──
  //
  // Reaproveita sanearBusca (o mesmo saneamento de admin.js: trim + teto de 100 caracteres)
  // e listarAplicacoesComContexto, que ja implementa o filtro de nome/sobrenome/nome
  // completo/e-mail/telefone usado na listagem principal de /admin — fonte UNICA de "o que
  // 'buscar candidato' significa" no projeto, para nao nascer uma segunda regra de busca
  // aqui com um comportamento sutilmente diferente.
  //
  // Query vazia/so espaco NAO lista os mais recentes — devolve [] direto, sem consultar o
  // banco: este endpoint e um autocomplete, e listar os ultimos candidatos "porque nao
  // digitou nada ainda" seria surpreendente para quem chamou.
  router.get('/buscar-candidato', (req, res) => {
    const termo = sanearBusca((req.query || {}).q);
    if (!termo) return res.json([]);
    const resultados = db.listarAplicacoesComContexto({ busca: termo }).slice(0, 10);
    res.json(
      resultados.map((c) => ({
        id: c.id,
        nome: c.nome,
        sobrenome: c.sobrenome,
        telefone: c.telefone,
        vaga_titulo: c.vaga_titulo,
      })),
    );
  });

  // ── POST /enviar-teste ── envio avulso de teste, IGNORA o kill-switch de mock ──
  //
  // Existe para o operador ver, com um candidato REAL escolhido a mao, as variaveis do
  // template preenchidas com os dados dele, e confirmar de ponta a ponta (Recrutador ->
  // Central Whats -> Meta -> aparelho) ANTES de materializar uma campanha inteira. NAO cria
  // nem toca `campanha_whatsapp_envios` — nao e uma campanha, e um teste tecnico avulso;
  // so fica registro no log (nivel info, telefone MASCARADO).
  //
  // Ordem das validacoes e deliberada: tudo que NAO depende de rede primeiro (candidato,
  // template, telefone), para nenhuma chamada externa acontecer antes de o pedido estar
  // completo e valido.
  router.post('/enviar-teste', async (req, res) => {
    const b = req.body || {};
    const applicationId = Number(b.applicationId);
    const templateId = Number(b.templateId);

    if (!Number.isInteger(applicationId) || applicationId <= 0) {
      return res.status(400).json({ ok: false, erro: 'Escolha um candidato valido.' });
    }
    if (!Number.isInteger(templateId) || templateId <= 0) {
      return res.status(400).json({ ok: false, erro: 'Escolha um template valido.' });
    }
    const template = db.obterTemplateWhatsapp(templateId);
    if (!template) {
      return res.status(400).json({ ok: false, erro: 'Template nao encontrado.' });
    }
    // Incremento 9: recusa ANTES de resolver contexto ou tocar rede — e exatamente o furo
    // que produziu o erro cru do Central Whats no diagnostico da ETAPA A (template
    // 'divulgacao_vaga_vm_PENDENTE', ativo=0, nunca sincronizado do lado deles).
    if (!template.ativo) {
      return res.status(400).json({
        ok: false,
        erro: 'Este template não está ativo/sincronizado, não pode ser usado para envio.',
      });
    }

    // Telefone digitado por gente — validacao ESTRITA, ANTES de qualquer chamada externa.
    const telefone = validarTelefoneBrEstrito(String(b.telefoneDestino || ''));
    if (!telefone) {
      return res.status(400).json({
        ok: false,
        erro: 'Telefone de destino invalido. Use o formato +55DDNNNNNNNNN, com DDD real e o nono digito no celular.',
      });
    }

    // ── OPT-OUT, ANTES DE QUALQUER CHAMADA AO PROVEDOR ──
    //
    // Este e o unico ponto de envio do projeto SEM campanha por tras, e por isso escapou do
    // guard dos motores ate a verificacao pre-deploy. Ele manda template REAL, com
    // `forcarEnvioReal: true` (fura ate o mock), para um numero digitado a mao — mandar
    // marketing para quem pediu para sair aqui custa o mesmo que numa campanha de mil.
    //
    // O escopo vem da CATEGORIA do template, e nao de `tipo_mensagem`: nao ha campanha, logo
    // nao ha tipo. A categoria da Meta ('marketing' x 'utility'/'authentication') carrega
    // exatamente a mesma distincao — ver escopoDaCategoriaTemplate em lib/optoutWhatsapp.js.
    //
    // A checagem e sobre `telefone` (o destino digitado), e NAO sobre o telefone do candidato
    // escolhido: sao campos independentes nesta tela, e quem recebe a mensagem e o primeiro.
    //
    // `optout.estaOptout` ja respeita o kill-switch `optout_whatsapp_ativo` internamente, e
    // por isso ele nao e consultado de novo aqui — uma segunda leitura poderia divergir da
    // primeira no dia em que a regra mudasse.
    const escopoTeste = optout.escopoDaCategoriaTemplate(template.categoria);
    if (optout.estaOptout(telefone, escopoTeste)) {
      const registro = db.obterWhatsappOptout(telefone);
      // Se `estaOptout` disse sim, o registro existe — mas a leitura e defensiva porque as
      // duas consultas nao sao atomicas e a tela nao pode quebrar por causa disso.
      const detalhe = registro
        ? `Escopo: ${registro.escopo}. Origem: ${registro.origem}. Desde: ${registro.criado_em}.`
        : 'Não foi possível ler os detalhes do registro.';
      console.warn(
        `[campanha-wa] envio avulso BLOQUEADO por opt-out: ${mascarar(telefone)} ` +
          `(template '${template.nome_meta}', categoria ${template.categoria}, escopo ${escopoTeste}).`,
      );
      return res.status(409).json({
        ok: false,
        erro:
          'Este número pediu para não receber mensagens e o envio foi bloqueado. ' +
          `${detalhe} Para liberar, revogue o opt-out em /admin/optouts.`,
        optout: registro
          ? { escopo: registro.escopo, origem: registro.origem, criado_em: registro.criado_em }
          : null,
      });
    }

    let contexto;
    try {
      contexto = campanha.montarContextoWhatsapp(applicationId);
    } catch (err) {
      // application inexistente / sem vaga associada — erro de lib/campanhaWhatsapp, ja com
      // mensagem clara (ver o comentario da funcao).
      return res.status(400).json({ ok: false, erro: err.message });
    }

    let mapa = [];
    try {
      mapa = JSON.parse(template.variaveis || '[]');
    } catch {
      mapa = [];
    }
    const variaveis = campanha.resolverVariaveis(mapa, contexto);

    // ── BOTAO DINAMICO (Incremento 2, ajustado apos diagnostico do 404 real) ──
    // precisaBotaoDinamico(nome_meta) e a lista fechada em lib/templatesWhatsapp.js — hoje so
    // convite_grupo_vagas_vm. A URL base aprovada na Meta e
    // "https://entrevista.vendedormestre.com.br/grupo/{{1}}" (confirmado direto no Central
    // Whats), e {{1}} e o SLUG da praca (ex. "joinville") — NAO o link completo do WhatsApp.
    // Um primeiro envio real usou contexto.link_grupo_regiao aqui (o link completo, que so
    // faz sentido na variavel de CORPO — posicao 3, "cidade", continua sendo o NOME da
    // cidade, ex. "Joinville", ver resolverVariaveis acima; nao confundir os tres valores) e
    // o botao gerou 404 (".../grupo/https://chat.whatsapp.com/..." nao bate slug nenhum).
    // db.obterSlugGrupo(cidade) e o lookup certo — mesmo contrato de null de obterLinkGrupo.
    //
    // ⚠️ RISCO CONHECIDO, NAO REGRESSAO NOVA: praca sem slug cadastrado (linha inexistente,
    // ou existente sem `slug` preenchido) cai em undefined, igual a praca sem link — o envio
    // sai sem parametro de botao (o mesmo caminho de "template sem botao"), e quem clicar no
    // botao do WhatsApp (se a Central Whats aceitar sem o param — o que hoje ela NAO aceita
    // pra este template, ver o 400 do diagnostico anterior) cairia num 404 em /grupo/:slug.
    // Praticamente hoje isso vira falha ANTES de sair (Central Whats recusa parametro
    // ausente), entao o 404 e um risco teorico, nao o caminho que acontece de verdade.
    const slugGrupo = precisaBotaoDinamico(template.nome_meta) ? db.obterSlugGrupo(contexto.cidade) : null;
    const parametrosBotao = slugGrupo ? { 0: slugGrupo } : undefined;

    console.log(
      `[campanha-wa] envio avulso de teste: template '${template.nome_meta}' -> ` +
        `${mascarar(telefone)} (candidatura ${applicationId}).`,
    );

    try {
      const { wamid } = await transporte.enviarTemplate({
        telefone,
        template: {
          nome_meta: template.nome_meta,
          idioma: template.idioma,
          botao_parametro_fixo: template.botao_parametro_fixo,
        },
        variaveis,
        parametrosBotao,
        // A UNICA chamada do projeto que passa isto: um teste avulso EXISTE para furar o
        // mock — ver o comentario de forcarEnvioReal em providers/centralWhats/centralWhats.js.
        forcarEnvioReal: true,
      });
      res.json({ ok: true, wamid, contexto, variaveis });
    } catch (err) {
      const classe = transporte.classificarErroCentralWhats(err);
      console.error(
        `[campanha-wa] envio avulso de teste FALHOU [${classe.categoria}]: ${err.message}`,
      );
      res.status(502).json({ ok: false, erro: err.message, categoria: classe.categoria, motivo: classe.motivo });
    }
  });

  // ── POST /:id/disparar ── MATERIALIZA a fila ──
  //
  // Materializacao em DOIS TEMPOS, espelhando o e-mail: a campanha nasce em rascunho com o
  // total ESTIMADO, e o publico so e congelado aqui. Entre criar e disparar a base muda
  // (gente nova, opt-out, mudanca de praca), e materializar na criacao enviaria para um
  // recorte velho.
  router.post('/:id/disparar', (req, res) => {
    const id = Number(req.params.id);
    const c = Number.isInteger(id) && id > 0 ? db.obterCampanhaWhatsapp(id) : null;
    if (!c) return res.redirect('/admin/campanhas-whatsapp?erro=nao_encontrada');

    // Rascunho sempre dispara. Uma campanha ja 'ativa' so dispara se a fila ainda estiver
    // VAZIA — o caso do bug corrigido no Incremento 16: o botao "Ativar" chamava so
    // POST /:id/status (definirStatusCampanhaWhatsapp), que troca o status sem passar por
    // aqui, deixando a campanha 'ativa' e sem nenhuma linha em campanha_whatsapp_envios. O
    // botao ja foi corrigido para chamar esta rota quando parte de rascunho, mas campanhas
    // que ja ficaram presas nesse estado (ex.: id=1, "Nova Vaga - Donna Conecta") precisam
    // de uma saida sem SQL manual. Uma campanha 'ativa' com fila JA preenchida continua
    // bloqueada: reprocessar acrescentaria gente nova a um envio em andamento, sem ninguem
    // pedir — exatamente o risco que o guard original evitava.
    const filaVazia = c.status === 'ativa' && db.contarEnviosCampanhaWhatsapp(id).length === 0;
    if (c.status !== 'rascunho' && !filaVazia) {
      return res.redirect('/admin/campanhas-whatsapp?erro=status');
    }

    let r;
    try {
      r = calcularPublico({
        tipo: c.tipo_mensagem,
        jobId: c.job_id,
        criterios: JSON.parse(c.criterios_json || '{}'),
      });
    } catch (err) {
      console.error(`[campanha-wa] falha ao calcular publico da campanha ${id}: ${err.message}`);
      return res.redirect('/admin/campanhas-whatsapp?erro=publico');
    }

    const gravados = db.materializarCampanhaWhatsapp(id, r.itens);
    db.definirStatusCampanhaWhatsapp(id, 'ativa');
    console.log(`[campanha-wa] campanha ${id} materializada com ${gravados} destinatario(s).`);
    res.redirect('/admin/campanhas-whatsapp?salvo=1');
  });

  // ── POST /:id/status ── ativar / pausar ──
  router.post('/:id/status', (req, res) => {
    const id = Number(req.params.id);
    const status = String((req.body || {}).status || '');
    if (!Number.isInteger(id) || !['ativa', 'pausada', 'concluida'].includes(status)) {
      return res.redirect('/admin/campanhas-whatsapp?erro=status');
    }
    db.definirStatusCampanhaWhatsapp(id, status);
    res.redirect('/admin/campanhas-whatsapp?salvo=1');
  });

  // ── POST /:id/excluir ── apaga uma campanha em rascunho ──
  //
  // Espelha POST /admin/promocao/:id/excluir (e-mail) na regra (db.excluirCampanhaWhatsapp
  // tem o MESMO contrato de db.excluirCampanha — ver o comentario dela em sqlite.js), mas
  // NAO tem tela de confirmacao propria: a listagem aqui ja e uma tabela inline (a de
  // e-mail tem uma tela de detalhe por campanha, esta nao), entao a confirmacao e o modal
  // reutilizavel (data-confirm no <form>, ver linhaCampanha acima) em vez de uma segunda
  // pagina. `excluida`/`erro_exclusao` sao parametros DEDICADOS (ver o comentario de
  // flashExclusao acima) — nao o `erro` generico que as demais rotas deste arquivo usam.
  router.post('/:id/excluir', (req, res) => {
    const id = Number(req.params.id);
    const r = db.excluirCampanhaWhatsapp(id);
    if (r.ok) {
      return res.redirect('/admin/campanhas-whatsapp?excluida=1');
    }
    return res.redirect(
      `/admin/campanhas-whatsapp?erro_exclusao=${encodeURIComponent(String(r.erroCodigo || '').toLowerCase())}`,
    );
  });

  return router;
}

module.exports = { criarRouterCampanhaWhatsapp, BASES_ALVO, montarConteudoCampanhaWhatsapp };
