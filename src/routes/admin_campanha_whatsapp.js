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

const TIPOS = [
  ['convite_grupo', 'Convite para o grupo da praça'],
  ['divulgacao_vaga', 'Divulgação de uma vaga'],
];

// Calcula o publico do tipo pedido. Fonte UNICA para a previa e para a materializacao — se
// divergissem, a tela mostraria um numero e o disparo usaria outro.
function calcularPublico({ tipo, jobId, criterios }) {
  return tipo === 'divulgacao_vaga'
    ? publico.listarPublicoDivulgacaoVaga(jobId, criterios)
    : publico.listarPublicoConviteGrupo(criterios);
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
    // ETAPA B, Incremento 6 — mesmo [].concat de cidade acima, e mesmo saneamento: so
    // numero inteiro positivo sobrevive, o resto (lixo, string vazia do "nenhuma marcada")
    // cai fora silenciosamente, exatamente como listarCidadesValidas().includes(c) faz para
    // cidade.
    vagas: [].concat(b.vaga || [])
      .map(Number)
      .filter((n) => Number.isInteger(n) && n > 0),
    dataDe: dataIsoValida(b.de) ? b.de : undefined,
    dataAte: dataIsoValida(b.ate) ? b.ate : undefined,
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

// Rotulo legivel de uma vaga para o checkbox de segmentacao por candidatura: "titulo ·
// perfil · cidade" (cidade omitida quando a vaga e remota/sem cidade cadastrada).
function rotuloVaga(v) {
  const base = `${v.titulo || `Vaga ${v.id}`} · ${v.perfil}`;
  return v.cidade ? `${base} · ${v.cidade}` : base;
}

function montarConteudoCampanhaWhatsapp({ escapeHtml, fmtInt }) {
  const inteiro = (v) => (fmtInt ? fmtInt(v) : String(v));

  const templates = db.listarTemplatesWhatsapp();
  const regioes = db.listarRegioesGrupos();
  const vagas = db.listarVagas();
  // Vaga sendo DIVULGADA (Incremento 7): so ativas, mesmo recorte de admin_promocao.js
  // (vagasAtivas). Distinto de `vagas` acima — aquele alimenta o filtro de SEGMENTACAO
  // "ja se candidataram a" (Incremento 6), que faz sentido para vaga inativa tambem (gente
  // se candidatou no passado a uma vaga que fechou depois). Divulgar uma vaga inativa,
  // porem, nao faz sentido nenhum: seria convidar gente para se candidatar a algo fechado.
  const vagasAtivas = vagas.filter((v) => v.ativo);
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
          ${c.status !== 'ativa'
            ? `<form method="post" action="/admin/campanhas-whatsapp/${c.id}/status"><input type="hidden" name="status" value="ativa"><button class="btn">Ativar</button></form>`
            : `<form method="post" action="/admin/campanhas-whatsapp/${c.id}/status"><input type="hidden" name="status" value="pausada"><button class="btn btn--ghost">Pausar</button></form>`}
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
      <div class="admin-tab-scroll">
        <table class="admin-tab" style="min-width:auto">
          <thead><tr><th>Nome na Meta</th><th>Idioma</th><th>Categoria</th><th>Variáveis</th></tr></thead>
          <tbody>${templates.map((t) => `
            <tr>
              <td><code>${escapeHtml(t.nome_meta)}</code></td>
              <td>${escapeHtml(t.idioma)}</td>
              <td>${escapeHtml(t.categoria)}</td>
              <td style="font-size:.85rem">${escapeHtml(t.variaveis)}</td>
            </tr>`).join('') || '<tr><td colspan="4">Nenhum template. Rode o seed.</td></tr>'}
          </tbody>
        </table>
      </div>
    </details>

    <details class="bloco-card" ${campanhas.length ? '' : 'open'}>
      <summary>Nova campanha</summary>
      <form method="post" action="/admin/campanhas-whatsapp" class="vm-form">
        <label class="campo"><span>Nome</span>
          <input type="text" name="nome" required maxlength="120" placeholder="Ex.: Convite grupo Joinville — agosto">
        </label>
        <label class="campo"><span>Template</span>
          <select name="template_id" required>
            ${templates.map((t) => `<option value="${t.id}">${escapeHtml(t.nome_meta)} (${escapeHtml(t.categoria)})</option>`).join('')}
          </select>
        </label>
        <label class="campo"><span>Base alvo</span>
          <select name="base_alvo">
            ${BASES_ALVO.map(([v, r]) => `<option value="${v}">${escapeHtml(r)}</option>`).join('')}
          </select>
        </label>
        <label class="campo"><span>Tipo de mensagem</span>
          <select name="tipo_mensagem" id="campo-tipo-mensagem">
            ${TIPOS.map(([v, r]) => `<option value="${v}">${escapeHtml(r)}</option>`).join('')}
          </select>
        </label>
        <label class="campo" id="campo-vaga-alvo" hidden>
          <span>Vaga sendo divulgada (obrigatório)</span>
          <select name="job_id">
            <option value="">Selecione a vaga…</option>
            ${vagasAtivas.map((v) => `<option value="${v.id}">${escapeHtml(v.titulo || `Vaga ${v.id}`)} · ${escapeHtml(v.perfil)}</option>`).join('')}
          </select>
        </label>

        <div class="admin-filtros" style="align-items:flex-start;">
          <div class="filtro">
            <span>Já se candidataram a (opcional)</span>
            ${vagas.length
              ? checkboxes(escapeHtml, 'vaga', vagas.map((v) => [String(v.id), rotuloVaga(v)]), [])
                + `<span style="display:block;color:var(--cinza);font-size:.78rem;margin-top:.35rem;text-transform:none;max-width:18rem">
                     Nenhuma marcada = todas. Marcando uma ou mais, só quem se candidatou a
                     alguma delas entra — a Base legada fica de fora (ela não tem vaga).
                   </span>`
              : `<span style="color:var(--cinza);font-size:.8rem;text-transform:none;">
                   Nenhuma vaga cadastrada.
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

        <p style="margin:-.6rem 0 1rem;color:var(--cinza);font-size:.8rem">
          A campanha nasce em <b>rascunho</b> e não envia nada até ser ativada aqui.
        </p>
        <button type="submit" class="btn">Criar campanha</button>
      </form>
    </details>

    <script>
    (function () {
      // Mostra/esconde "Vaga sendo divulgada" conforme o tipo de mensagem — mesmo mecanismo
      // (propriedade .hidden, nao style.display) ja usado para paineis condicionais em
      // admin.js (o toggle de abas). Nao ha precedente de um <select> disparando esse toggle
      // no projeto; o addEventListener('change') e o proprio fallback sugerido.
      var selTipo = document.getElementById('campo-tipo-mensagem');
      var campoVagaAlvo = document.getElementById('campo-vaga-alvo');
      if (!selTipo || !campoVagaAlvo) return;
      var selVagaAlvo = campoVagaAlvo.querySelector('select');
      function atualizar() {
        var visivel = selTipo.value === 'divulgacao_vaga';
        campoVagaAlvo.hidden = !visivel;
        // disabled junto com hidden: um campo desabilitado NAO e enviado no submit, entao
        // trocar de volta para "Convite de grupo" depois de ter escolhido uma vaga nao deixa
        // um job_id perdido no body do POST — o proprio navegador ja garante o que o
        // servidor valida de novo (defesa em profundidade, nao substitui a validacao la).
        if (selVagaAlvo) selVagaAlvo.disabled = !visivel;
      }
      selTipo.addEventListener('change', atualizar);
      atualizar();
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
            ${templates.map((t) => `<option value="${t.id}">${escapeHtml(t.nome_meta)} (${escapeHtml(t.categoria)})</option>`).join('')}
          </select>
        </label>
        <button type="button" id="teste-btn-enviar" class="btn">Enviar teste real</button>
        <div id="teste-resultado" style="margin-top:.8rem"></div>
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
        // confirm() dinamico — nao da para usar onsubmit estatico (mesmo padrao das demais
        // telas admin) porque telefone e template mudam com a escolha do operador. Mostra os
        // dois ANTES de confirmar: e um envio de verdade, para um numero de verdade.
        var pergunta = 'Isto envia uma mensagem de WhatsApp DE VERDADE para ' + telefone +
          ', usando o template “' + templateNome + '”. Confirma?';
        if (!confirm(pergunta)) return;

        btnEnviar.disabled = true;
        mostrarAviso(resultadoDiv, 'aviso-ok', 'Enviando…');
        fetch('/admin/campanhas-whatsapp/enviar-teste', {
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
              mostrarAviso(resultadoDiv, 'aviso-ok', 'Enviado. wamid: ' + (res.corpo.wamid || '(sem id)'));
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

function criarRouterCampanhaWhatsapp({ paginaAdmin, escapeHtml, fmtInt, sanearBusca, transporte = transportePadrao }) {
  const router = express.Router();

  // ── GET / ── a tela ──
  router.get('/', (req, res) => {
    const conteudo = montarConteudoCampanhaWhatsapp({ escapeHtml, fmtInt });
    res.send(paginaAdmin({ titulo: 'Campanha por WhatsApp', conteudo }));
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
    const baseAlvo = BASES_ALVO.some(([v]) => v === b.base_alvo) ? b.base_alvo : 'ambos';

    if (!nome || !Number.isInteger(templateId) || !db.obterTemplateWhatsapp(templateId)) {
      return res.redirect('/admin/campanhas-whatsapp?erro=dados');
    }
    const tipo = TIPOS.some(([v]) => v === b.tipo_mensagem) ? b.tipo_mensagem : 'convite_grupo';

    // Vaga-ALVO (a que a campanha DIVULGA — Incremento 7). Diferente do filtro de
    // segmentacao "vaga" (Incremento 6, multi, "ja se candidataram a"): este e singular,
    // obrigatorio SO em divulgacao_vaga, e vira NULL em convite_grupo mesmo que o body
    // tenha mandado um job_id — um form mal preenchido (ou adulterado) nao pode gravar uma
    // vaga-alvo numa campanha que a mensagem inteira nao menciona.
    let jobId = null;
    if (tipo === 'divulgacao_vaga') {
      const jobIdBruto = Number(b.job_id);
      // Divulgacao SEM vaga nao existe: a mensagem inteira e sobre ela.
      if (!Number.isInteger(jobIdBruto) || jobIdBruto <= 0) {
        return res.redirect('/admin/campanhas-whatsapp?erro=vaga');
      }
      const vagaAlvo = db.obterVaga(jobIdBruto);
      // Vaga inexistente ou inativa: divulgar algo que nao existe (mais) ou que fechou seria
      // convidar candidatos para uma porta fechada. O select do form ja so lista vagas
      // ativas, mas o POST nao pode confiar so nisso — chega aqui tambem por form adulterado.
      if (!vagaAlvo || !vagaAlvo.ativo) {
        return res.redirect('/admin/campanhas-whatsapp?erro=vaga_invalida');
      }
      jobId = jobIdBruto;
    }

    const criterios = lerCriterios(b);
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
    const tipo = TIPOS.some(([v]) => v === b.tipo_mensagem) ? b.tipo_mensagem : 'convite_grupo';
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

    // Telefone digitado por gente — validacao ESTRITA, ANTES de qualquer chamada externa.
    const telefone = validarTelefoneBrEstrito(String(b.telefoneDestino || ''));
    if (!telefone) {
      return res.status(400).json({
        ok: false,
        erro: 'Telefone de destino invalido. Use o formato +55DDNNNNNNNNN, com DDD real e o nono digito no celular.',
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

    // So rascunho dispara. Uma campanha ja ativa re-materializada acrescentaria gente nova a
    // uma fila em andamento, sem ninguem pedir.
    if (c.status !== 'rascunho') {
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

  return router;
}

module.exports = { criarRouterCampanhaWhatsapp, BASES_ALVO, montarConteudoCampanhaWhatsapp };
