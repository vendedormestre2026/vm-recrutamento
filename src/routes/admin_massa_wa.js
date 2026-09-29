'use strict';

// Telas do DISPARO EM MASSA por WhatsApp (/admin/massa-wa).
//
// Montada por admin.js DEPOIS do `router.use(adminAuth)`, herdando a protecao do painel — mesmo
// padrao de admin_promocao.js, admin_whatsapp.js, admin_campanha_whatsapp.js e admin_optout.js.
// Mover o mount para antes daquela linha deixaria estas telas publicas.
//
// ══════════════════════════════════════════════════════════════
// ESTAS TELAS SAO DESENHADAS PARA NAO DEIXAR NINGUEM DISPARAR SEM QUERER
// ══════════════════════════════════════════════════════════════
//
// O caminho tem quatro passos, e cada um exige um gesto: criar (rascunho) -> escrever as 7
// variacoes -> conferir o publico (previa) -> materializar -> ativar (com confirmacao). Nenhum
// deles acontece por efeito colateral de outro.
//
// O estado que mais importa aparece no TOPO de toda tela: interruptor ligado/desligado, modo mock,
// e se o socket esta conectado. Um operador que nao sabe em qual desses estados esta e um operador
// que vai concluir a coisa errada sobre o que aconteceu.
//
// ── O QUE ESTAS TELAS NAO FAZEM ──
// Nao chamam o LLM de verdade (ver POST /:id/sugerir). Nao retomam campanha pausada
// automaticamente. Nao remarcam item terminal. Nao reenviam nada.

const express = require('express');

const db = require('../db');
const conexao = require('../whatsapp/connection');
const worker = require('../whatsapp/massaOutbox');
const cadencia = require('../lib/cadenciaMassaWa');
const variacoesLib = require('../lib/variacoesMassaWa');
const publico = require('../lib/publicoMassaWhatsapp');
const { normalizarTelefoneWhatsapp } = require('../lib/whatsapp');
const { proximaEntrevistaGrupo, temEntrevistaGrupoFutura } = require('../lib/entrevistaGrupo');
const { config } = require('../config');

// Rotulos dos status da campanha. Aqui (apresentacao), nao na lib.
const ROTULO_STATUS = {
  rascunho: 'Rascunho',
  ativa: 'Ativa',
  pausada: 'Pausada',
  concluida: 'Concluída',
  cancelada: 'Cancelada',
};

// Rotulos dos status de cada ENVIO. Os quatro terminais tem nomes distintos de proposito: e a
// unica forma de a tela dizer se a campanha esta incomodando (opt_out), se ha numero morto na base
// (sem_whatsapp), se falta dado nosso (sem_reuniao) ou se houve problema tecnico (falha).
const ROTULO_ENVIO = {
  pendente: 'Na fila',
  enviado: 'Enviada',
  falha: 'Falha',
  opt_out: 'Pediu para sair',
  sem_whatsapp: 'Sem WhatsApp',
  sem_reuniao: 'Vaga sem data',
};

// Rotulos dos status do recrutador, para os checkboxes do publico.
const ROTULO_STATUS_RECRUTADOR = {
  sem_decisao: 'Sem decisão',
  em_analise: 'Em análise',
  aprovado: 'Aprovado',
  reprovado: 'Reprovado',
};

// Frases dos problemas do validador de variacoes. Os CODIGOS vem da lib; a redacao mora aqui.
function frasesDosProblemas(problemas, escapeHtml) {
  return (problemas || []).map((p) => {
    const onde = p.indice ? `Variação ${p.indice}: ` : '';
    switch (p.codigo) {
      case variacoesLib.PROBLEMA_QUANTIDADE:
        return `São necessárias ${p.esperado} variações preenchidas — há ${p.total}.`;
      case variacoesLib.PROBLEMA_VAZIA:
        return `${onde}está vazia.`;
      case variacoesLib.PROBLEMA_TOKEN_FALTANDO:
        return `${onde}falta ${p.tokens.map((t) => `{${escapeHtml(t)}}`).join(', ')}.`;
      case variacoesLib.PROBLEMA_TOKEN_DESCONHECIDO:
        return `${onde}token não reconhecido: ${p.tokens.map((t) => `{${escapeHtml(t)}}`).join(', ')} — sairia literal na mensagem.`;
      case variacoesLib.PROBLEMA_CHAVE_DUPLA:
        return `${onde}usa {{chave dupla}}, que é a sintaxe dos templates da Meta — aqui é {chave simples}.`;
      case variacoesLib.PROBLEMA_SEM_DESCADASTRO:
        return `${onde}falta o link de descadastro <code>{link_descadastro}</code>.`;
      case variacoesLib.PROBLEMA_LONGA:
        return `${onde}tem ${p.tamanho} caracteres (o teto é ${p.teto}).`;
      case variacoesLib.PROBLEMA_DUPLICADA:
        return `${onde}é igual à variação ${p.igualA} (ignorando pontuação e acentos).`;
      default:
        return `${onde}${escapeHtml(p.codigo)}`;
    }
  });
}

// *negrito* do WhatsApp como <b> na previa, para o operador ver a mensagem como ela chega. Recebe
// texto JA escapado. So o negrito: e o unico marcador que as seeds usam (ver TEXTO_BASE_PADRAO).
function negritoWhatsapp(html) {
  return String(html).replace(/\*([^*\n]+)\*/g, '<b>$1</b>');
}

function criarRouterMassaWa({ paginaAdmin, escapeHtml, fmtInt, formatarDataHora }) {
  const router = express.Router();

  const FLASHES = {
    criada: ['ok', 'Campanha criada como rascunho. Agora escreva as variações e confira o público.'],
    salva: ['ok', 'Configuração salva.'],
    variacoes: ['ok', 'Variações salvas.'],
    sugerido: ['alerta', 'Campos preenchidos com os textos-semente. A sugestão por IA está desligada (ver a nota abaixo).'],
    materializada: ['ok', 'Público congelado na fila. Revise e ative quando quiser começar.'],
    ativada: ['ok', 'Campanha ATIVA. O envio respeita a cadência, a janela de horário e o teto diário.'],
    pausada: ['ok', 'Campanha pausada. Ela não volta sozinha.'],
    cancelada: ['ok', 'Campanha cancelada. Este status é definitivo.'],
    teste_enviado: ['ok', 'Mensagem de teste enviada para o número informado.'],
    teste_mock: ['alerta', 'MODO MOCK: a mensagem NÃO saiu. O texto que sairia está no log do servidor.'],
  };

  const ERROS = {
    nome: 'O nome da campanha não pode ficar vazio.',
    status: 'Selecione ao menos um status do recrutador para o público.',
    variacoes_invalidas: 'As variações não passaram na validação — corrija os pontos listados.',
    sem_variacoes: 'Escreva e salve as 7 variações antes de materializar o público.',
    sem_publico: 'O público está vazio com estes filtros — nada a materializar.',
    ja_materializada: 'Esta campanha já tem fila materializada.',
    nao_materializada: 'Materialize o público antes de ativar.',
    telefone: 'Número de teste inválido. Use o formato +55 47 99999-9999.',
    sem_reuniao_teste: 'Nenhuma vaga ativa tem entrevista em grupo futura — o teste não teria data nem link para enviar.',
    envio_teste: 'Falha ao enviar o teste (o motivo está no log do servidor).',
  };

  function flash(req) {
    const [tipo, texto] = FLASHES[req.query.ok] || [];
    const erro = ERROS[req.query.erro];
    return [
      texto ? `<p class="aviso-${tipo === 'ok' ? 'ok' : 'alerta'}">${texto}</p>` : '',
      erro ? `<p class="aviso-alerta">${escapeHtml(erro)}</p>` : '',
    ].join('');
  }

  // ── Estado do canal, no topo de toda tela ──
  //
  // Tres perguntas que o operador precisa responder antes de interpretar qualquer numero: o
  // interruptor esta ligado? estamos em mock? o socket esta de pe?
  function blocoEstado() {
    const ligado = worker.ativo({ db });
    const mock = worker.modoMock();
    const s = conexao.status();
    const selo = (ok, texto) =>
      `<span class="badge ${ok ? 'badge--ativa' : 'badge--encerrada'}">${escapeHtml(texto)}</span>`;

    const avisoMock = mock
      ? `<p class="aviso-alerta" style="margin:.6rem 0 0;"><b>MODO MOCK ligado</b> (MASSA_WA_MOCK).
         Nada é enviado de verdade: a fila avança e o texto que sairia vai para o log. É o padrão —
         desligar exige mudar a variável de ambiente no servidor.</p>`
      : `<p class="aviso-alerta" style="margin:.6rem 0 0;"><b>MODO REAL</b>: as mensagens saem de
         verdade pelo WhatsApp conectado.</p>`;

    return `
      <section class="rel-sec">
        <h2>Estado do canal</h2>
        <div style="display:flex;gap:.6rem;flex-wrap:wrap;align-items:center;">
          ${selo(ligado, ligado ? 'Disparo em massa LIGADO' : 'Disparo em massa DESLIGADO')}
          ${selo(!mock, mock ? 'MOCK (não envia)' : 'Envio real')}
          ${selo(s.status === 'conectado', `WhatsApp: ${s.status}`)}
        </div>
        <p style="color:var(--cinza);font-size:.82rem;margin:.6rem 0 0;">
          O interruptor (<code>${escapeHtml(worker.CHAVE_ATIVO)}</code>) fica em
          <a href="/admin/config">Configurações</a>. Com ele desligado, nenhuma campanha envia —
          nem as que estão ativas. A sessão do WhatsApp é a mesma do WA1/WA2, em
          <a href="/admin/whatsapp">Conexão</a>.</p>
        <p style="color:var(--cinza);font-size:.82rem;margin:.4rem 0 0;">
          Toda mensagem leva o <b>link de descadastro</b> do destinatário, o mesmo das campanhas
          via API. Quem clica entra em <a href="/admin/optouts">Opt-outs</a> e sai das próximas
          campanhas.</p>
        ${avisoMock}
      </section>`;
  }

  // Cadencia em uma linha, para a tela dizer o que esta valendo sem o operador abrir o codigo.
  function textoCadencia(campanha) {
    const c = cadencia.resolverCadencia(campanha);
    const dias = [...c.dias].sort().map((d) => ['', 'seg', 'ter', 'qua', 'qui', 'sex', 'sáb', 'dom'][d]).join(', ');
    return `lotes de ${c.loteMin}–${c.loteMax} · ${c.gapMinS}–${c.gapMaxS}s entre mensagens · `
      + `${Math.round(c.pausaLoteMinS / 60)}–${Math.round(c.pausaLoteMaxS / 60)}min entre lotes · `
      + `teto ${c.tetoDiario}/dia · ${c.horaInicio}–${c.horaFim} (${dias})`;
  }

  const opcoesVaga = (atual) => {
    const vagas = db.listarVagas().filter((v) => v.ativo);
    return [
      `<option value=""${!atual ? ' selected' : ''}>Todas as vagas abertas</option>`,
      ...vagas.map(
        (v) => `<option value="${v.id}"${Number(atual) === v.id ? ' selected' : ''}>${escapeHtml(v.titulo)}${temEntrevistaGrupoFutura(v) ? '' : ' — ⚠ sem data'}</option>`,
      ),
    ].join('');
  };

  function checkboxesStatus(marcados) {
    const set = new Set(marcados);
    return publico.STATUS_SELECIONAVEIS.map(
      (s) => `
        <label class="campo-check" style="margin:0 1rem .3rem 0;">
          <input type="checkbox" name="status" value="${s}"${set.has(s) ? ' checked' : ''}>
          <span style="color:var(--preto);text-transform:none;">${escapeHtml(ROTULO_STATUS_RECRUTADOR[s])}</span>
        </label>`,
    ).join('');
  }

  const statusDaCampanha = (campanha) => {
    let lista = [];
    try {
      lista = JSON.parse(campanha.criterios_json || '{}').statusList || [];
    } catch {
      lista = [];
    }
    return lista.length ? lista : [...publico.STATUS_PADRAO];
  };

  // Le nome/vaga/status/texto base/cadencia do corpo do POST. Compartilhado por criar e salvar.
  function lerCampanhaDoCorpo(b) {
    // Campo AUSENTE ou vazio -> null, que significa "usar o default do codigo". Um `Number('')`
    // devolve 0, e 0 aqui e um valor legitimo com significado devastador: `teto_diario = 0` faz a
    // campanha nunca enviar nada, em silencio, e `lote_max = 0` idem. Um POST sem os campos de
    // cadencia (formulario antigo, requisicao a mao) zeraria a campanha inteira. Um teste pegou.
    const num = (v) => {
      const texto = String(v == null ? '' : v).trim();
      if (!texto) return null;
      const n = Number(texto);
      return Number.isFinite(n) && n >= 0 ? Math.trunc(n) : null;
    };
    return {
      nome: String(b.nome || '').trim(),
      jobId: b.job_id ? Number(b.job_id) : null,
      textoBase: String(b.texto_base || '').trim() || null,
      statusList: publico.sanearStatusList([].concat(b.status || [])),
      cadencia: {
        loteMin: num(b.lote_min),
        loteMax: num(b.lote_max),
        gapMinS: num(b.gap_min_s),
        gapMaxS: num(b.gap_max_s),
        pausaLoteMinS: num(b.pausa_lote_min_s),
        pausaLoteMaxS: num(b.pausa_lote_max_s),
        tetoDiario: num(b.teto_diario),
        horaInicio: String(b.hora_inicio || '').trim() || null,
        horaFim: String(b.hora_fim || '').trim() || null,
        diasSemana: String(b.dias_semana || '').trim() || null,
      },
    };
  }

  // ══════════════════ LISTA ══════════════════

  router.get('/', (req, res) => {
    const campanhas = db.listarCampanhasMassaWa();
    const linhas = campanhas
      .map((c) => {
        const r = Object.fromEntries(db.resumoCampanhaMassaWa(c.id).map((l) => [l.status, l.n]));
        const total = Object.values(r).reduce((a, b) => a + b, 0);
        return `
          <tr>
            <td><a href="/admin/massa-wa/${c.id}">${escapeHtml(c.nome)}</a></td>
            <td>${escapeHtml(c.vaga_titulo || 'Todas as abertas')}</td>
            <td>${escapeHtml(ROTULO_STATUS[c.status] || c.status)}
              ${c.pausada_motivo ? `<br><small style="color:var(--cinza)">${escapeHtml(c.pausada_motivo)}</small>` : ''}</td>
            <td>${fmtInt(r.enviado || 0)} / ${fmtInt(total)}</td>
            <td>${formatarDataHora(c.criado_em)}</td>
          </tr>`;
      })
      .join('');

    const conteudo = `
      <div style="display:flex;gap:.5rem;flex-wrap:wrap;margin-bottom:1rem;">
        <a class="btn btn--ghost" href="/admin">← Voltar ao painel</a>
        <a class="btn btn--ghost" href="/admin/divulgacao-vagas">Divulgação de Vagas</a>
        <a class="btn btn--ghost" href="/admin/config">Configurações</a>
      </div>
      <div style="display:flex;justify-content:space-between;align-items:center;gap:1rem;flex-wrap:wrap;margin-bottom:1rem;">
        <h1 style="margin:0;">Disparo em massa (WhatsApp)</h1>
        <a class="btn" href="/admin/massa-wa/nova">+ Nova campanha</a>
      </div>
      ${flash(req)}
      ${blocoEstado()}
      <section class="rel-sec">
        <h2>Campanhas</h2>
        <div class="admin-tab-scroll">
          <table class="admin-tab">
            <thead><tr><th>Nome</th><th>Vaga</th><th>Status</th><th>Enviadas</th><th>Criada em</th></tr></thead>
            <tbody>${linhas || '<tr><td colspan="5">Nenhuma campanha ainda.</td></tr>'}</tbody>
          </table>
        </div>
      </section>`;

    res.send(paginaAdmin({ titulo: 'Disparo em massa', conteudo }));
  });

  // ══════════════════ NOVA ══════════════════

  function formCampanha(dados, { acao, rotuloBotao }) {
    const c = cadencia.resolverCadencia(dados);
    const n = (v) => escapeHtml(String(v));
    return `
      <form method="POST" action="${acao}">
        <label class="campo"><span>Nome da campanha</span>
          <input type="text" name="nome" value="${escapeHtml(dados.nome || '')}" required></label>

        <label class="campo"><span>Vaga</span>
          <select name="job_id">${opcoesVaga(dados.job_id)}</select></label>
        <p style="color:var(--cinza);font-size:.8rem;margin:-.5rem 0 1.2rem;">
          O público é sempre <b>candidatos de vagas ABERTAS</b>. Escolher uma vaga estreita para ela.
          A base legada (Banco de Currículos) nunca entra neste disparo.</p>

        <fieldset style="border:1px solid var(--linha);border-radius:8px;padding:.8rem 1rem;margin:0 0 1.2rem;">
          <legend style="font-size:.85rem;color:var(--cinza);">Status do recrutador no público</legend>
          ${checkboxesStatus(statusDaCampanha(dados))}
          <p style="color:var(--cinza);font-size:.8rem;margin:.4rem 0 0;">
            “Sem decisão” cobre quem ainda não foi avaliado. <b>Aprovado</b> e <b>reprovado</b> vêm
            desmarcados de propósito — marque só se tiver certeza.</p>
        </fieldset>

        <label class="campo"><span>Texto base (semente das variações)</span>
          <textarea name="texto_base" rows="10">${escapeHtml(dados.texto_base || variacoesLib.TEXTO_BASE_PADRAO)}</textarea></label>
        <p style="color:var(--cinza);font-size:.8rem;margin:-.5rem 0 1.2rem;">
          Não é o que sai no envio — o que sai é sempre uma das 7 variações. Tokens disponíveis:
          ${variacoesLib.TOKENS.map((t) => `<code>{${t}}</code>`).join(' ')}.</p>

        <details style="margin:0 0 1.2rem;">
          <summary style="cursor:pointer;color:var(--cinza);font-size:.85rem;">Cadência (anti-bloqueio) — mexer só com motivo</summary>
          <div style="display:flex;gap:.6rem;flex-wrap:wrap;margin-top:.7rem;">
            <label class="campo" style="margin:0;max-width:9rem;"><span>Lote mín.</span>
              <input type="number" min="1" name="lote_min" value="${n(c.loteMin)}"></label>
            <label class="campo" style="margin:0;max-width:9rem;"><span>Lote máx.</span>
              <input type="number" min="1" name="lote_max" value="${n(c.loteMax)}"></label>
            <label class="campo" style="margin:0;max-width:10rem;"><span>Gap mín. (s)</span>
              <input type="number" min="0" name="gap_min_s" value="${n(c.gapMinS)}"></label>
            <label class="campo" style="margin:0;max-width:10rem;"><span>Gap máx. (s)</span>
              <input type="number" min="0" name="gap_max_s" value="${n(c.gapMaxS)}"></label>
            <label class="campo" style="margin:0;max-width:11rem;"><span>Pausa mín. (s)</span>
              <input type="number" min="0" name="pausa_lote_min_s" value="${n(c.pausaLoteMinS)}"></label>
            <label class="campo" style="margin:0;max-width:11rem;"><span>Pausa máx. (s)</span>
              <input type="number" min="0" name="pausa_lote_max_s" value="${n(c.pausaLoteMaxS)}"></label>
            <label class="campo" style="margin:0;max-width:10rem;"><span>Teto/dia</span>
              <input type="number" min="1" name="teto_diario" value="${n(c.tetoDiario)}"></label>
            <label class="campo" style="margin:0;max-width:9rem;"><span>Início</span>
              <input type="time" name="hora_inicio" value="${n(c.horaInicio)}"></label>
            <label class="campo" style="margin:0;max-width:9rem;"><span>Fim</span>
              <input type="time" name="hora_fim" value="${n(c.horaFim)}"></label>
            <label class="campo" style="margin:0;max-width:12rem;"><span>Dias (1=seg … 7=dom)</span>
              <input type="text" name="dias_semana" value="${n(c.diasSemana)}"></label>
          </div>
          <p style="color:var(--cinza);font-size:.8rem;margin:.5rem 0 0;">
            Rampa recomendada do teto diário: ${cadencia.RAMPA_TETO_DIARIO.join(' → ')}. Subir é
            decisão sua, depois de dias sem incidente — o sistema nunca sobe sozinho.</p>
        </details>

        <button type="submit" class="btn">${escapeHtml(rotuloBotao)}</button>
      </form>`;
  }

  router.get('/nova', (req, res) => {
    const conteudo = `
      <p><a class="btn btn--ghost" href="/admin/massa-wa">← Voltar</a></p>
      <h1>Nova campanha de disparo em massa</h1>
      ${flash(req)}
      ${formCampanha({}, { acao: '/admin/massa-wa', rotuloBotao: 'Criar rascunho' })}`;
    res.send(paginaAdmin({ titulo: 'Nova campanha', conteudo }));
  });

  router.post('/', (req, res) => {
    const d = lerCampanhaDoCorpo(req.body || {});
    if (!d.nome) return res.redirect('/admin/massa-wa/nova?erro=nome');
    if (!d.statusList.length) return res.redirect('/admin/massa-wa/nova?erro=status');

    const id = db.criarCampanhaMassaWa({
      nome: d.nome,
      jobId: d.jobId,
      textoBase: d.textoBase,
      criterios: { statusList: d.statusList },
      cadencia: d.cadencia,
    });
    // As 7 sementes ja entram: a campanha nasce pronta para revisao, e nao com sete campos vazios.
    db.salvarVariacoesMassaWa(id, [...variacoesLib.VARIACOES_SEED]);
    return res.redirect(`/admin/massa-wa/${id}?ok=criada`);
  });

  // ══════════════════ DETALHE ══════════════════

  function blocoPrevia(campanha) {
    // A previa RECALCULA o publico a cada abertura da tela. E o certo: a base muda (candidatura
    // nova, opt-out, vaga encerrada), e um numero congelado daria a impressao de um publico que
    // nao existe mais. O que congela e a materializacao, que e um gesto separado.
    let r;
    try {
      r = publico.montarPublicoMassaWa({ jobId: campanha.job_id, statusList: statusDaCampanha(campanha) });
    } catch (err) {
      return `<section class="rel-sec"><h2>Público</h2>
        <p class="aviso-alerta">${escapeHtml(err.message)}</p></section>`;
    }
    const f = r.funil;
    const linha = (rotulo, valor, nota) => `
      <div><dt>${escapeHtml(rotulo)}</dt><dd>${fmtInt(valor)}
        ${nota ? `<br><small style="color:var(--cinza)">${escapeHtml(nota)}</small>` : ''}</dd></div>`;

    return `
      <section class="rel-sec">
        <h2>Público (prévia)</h2>
        <p style="color:var(--cinza);font-size:.85rem;margin:0 0 .8rem;">
          Recalculado agora. As duas primeiras linhas contam <b>candidaturas</b>; as demais contam
          <b>pessoas</b> — por isso os números não se subtraem em sequência.</p>
        <dl class="rel-id">
          ${linha('Candidaturas em vagas abertas', f.candidaturas)}
          ${linha('— fora por status do recrutador', f.candidaturasExcluidasStatus,
            Object.entries(f.porStatusExcluido).filter(([, n]) => n).map(([k, n]) => `${ROTULO_STATUS_RECRUTADOR[k] || k}: ${n}`).join(' · '))}
          ${linha('— fora por telefone inutilizável', f.candidaturasSemTelefoneUtil, 'não sobrevive à normalização (DDI duplicado, dado corrompido)')}
          ${linha('— duplicadas (mesma pessoa)', f.candidaturasDuplicadas, 'colapsadas pela chave canônica: mesmo número com e sem o 9')}
          ${linha('Pessoas', f.pessoas)}
          ${linha('— fora por opt-out', f.pessoasOptoutCampanha + f.pessoasOptoutAntigo)}
          ${linha('PÚBLICO FINAL', f.total)}
        </dl>
        <p style="color:var(--cinza);font-size:.8rem;margin:.6rem 0 0;">
          Quem não tem WhatsApp ativo <b>não é descontado aqui</b>: essa checagem acontece no envio,
          no lote que está saindo — consultar milhares de números de uma vez é, por si, um sinal de
          conta suspeita. Esses casos aparecem na fila como “Sem WhatsApp”.</p>
      </section>`;
  }

  function blocoVariacoes(campanha, req) {
    const lista = db.listarVariacoesMassaWa(campanha.id);
    const textos = Array.from({ length: variacoesLib.TOTAL_VARIACOES }, (_, i) => {
      const v = lista.find((x) => x.indice === i + 1);
      return v ? v.texto : '';
    });
    const valid = variacoesLib.validarVariacoes(textos);
    const problemas = frasesDosProblemas(valid.problemas, escapeHtml);

    const campos = textos
      .map(
        (t, i) => `
        <label class="campo"><span>Variação ${i + 1}</span>
          <textarea name="variacao_${i + 1}" rows="14">${escapeHtml(t)}</textarea></label>`,
      )
      .join('');

    const preview = (() => {
      // Preview com dados REAIS da vaga da campanha (ou a primeira aberta com data), para o
      // operador ver a mensagem como ela vai chegar — inclusive a data e o link de verdade.
      const vaga = campanha.job_id
        ? db.obterVaga(campanha.job_id)
        : db.listarVagas().filter((v) => v.ativo).find((v) => temEntrevistaGrupoFutura(v));
      const proxima = vaga ? proximaEntrevistaGrupo(vaga) : null;
      if (!proxima) {
        return `<p class="aviso-alerta">Sem prévia da mensagem: ${vaga ? 'esta vaga' : 'nenhuma vaga aberta'}
          não tem entrevista em grupo futura com link. Cadastre o link do Meet e as datas na vaga —
          sem isso, <b>nenhum destinatário</b> recebe mensagem (cada item vira “Vaga sem data”).</p>`;
      }
      // O link de descadastro e por destinatario; na previa vai um exemplo, nao um token valido.
      const ctx = variacoesLib.montarContexto({
        nome: 'Maria Souza',
        job: vaga,
        proxima,
        linkDescadastro: `${config.baseUrl}/descadastro-whatsapp/(link-de-cada-destinatario)`,
        recrutador: db.obterConfig('recrutador_nome', ''),
      });
      const { texto } = variacoesLib.resolverTexto(textos[0] || '', ctx);
      return `<pre style="white-space:pre-wrap;background:var(--campo);border:1px solid var(--linha);border-radius:8px;padding:.8rem;font:inherit;">${negritoWhatsapp(escapeHtml(texto))}</pre>`;
    })();

    return `
      <section class="rel-sec">
        <h2>As 7 variações</h2>
        ${problemas.length
          ? `<div class="aviso-alerta"><b>Pendências:</b><ul style="margin:.4rem 0 0 1rem;">${problemas.map((p) => `<li>${p}</li>`).join('')}</ul></div>`
          : '<p class="aviso-ok">As 7 variações passam na validação.</p>'}
        <p style="color:var(--cinza);font-size:.85rem;">
          Toda variação precisa ter ${variacoesLib.TOKENS_OBRIGATORIOS.map((t) => `<code>{${t}}</code>`).join(' ')}
          (o link de descadastro de cada destinatário). Tokens: ${variacoesLib.TOKENS.map((t) => `<code>{${t}}</code>`).join(' ')}.</p>

        <h3 style="font-size:.95rem;margin:1rem 0 .3rem;">Prévia da variação 1, com dados reais</h3>
        ${preview}

        <form method="POST" action="/admin/massa-wa/${campanha.id}/variacoes">
          ${campos}
          <div class="acoes-linha">
            <button type="submit" class="btn">Salvar variações</button>
          </div>
        </form>

        <form method="POST" action="/admin/massa-wa/${campanha.id}/sugerir" style="margin-top:.6rem;">
          <button type="submit" class="btn btn--ghost">Sugerir com IA</button>
        </form>
        <p style="color:var(--cinza);font-size:.8rem;margin:.4rem 0 0;">
          A geração por IA está <b>desligada</b>: o botão preenche os campos com os textos-semente
          para você editar. Ligar a chamada real ao modelo depende de autorização explícita
          (<code>MASSA_WA_LLM_ATIVO</code>) — nenhuma chamada paga acontece sem isso.</p>
      </section>`;
  }

  function blocoFila(campanha) {
    const resumo = Object.fromEntries(db.resumoCampanhaMassaWa(campanha.id).map((l) => [l.status, l.n]));
    const total = Object.values(resumo).reduce((a, b) => a + b, 0);
    if (!total) {
      return `
        <section class="rel-sec">
          <h2>Fila</h2>
          <p style="color:var(--cinza);font-size:.85rem;">Público ainda não materializado.</p>
          <form method="POST" action="/admin/massa-wa/${campanha.id}/materializar">
            <button type="submit" class="btn">Materializar público</button>
          </form>
          <p style="color:var(--cinza);font-size:.8rem;margin:.4rem 0 0;">
            Congela quem vai receber. Depois disso, mudar os filtros não muda mais a fila.</p>
        </section>`;
    }

    const dist = db.distribuicaoVariacoesMassaWa(campanha.id);
    const enviadas = resumo.enviado || 0;
    const linhas = Object.entries(resumo)
      .map(([s, n]) => `<div><dt>${escapeHtml(ROTULO_ENVIO[s] || s)}</dt><dd>${fmtInt(n)}</dd></div>`)
      .join('');

    const distHtml = dist.length
      ? `<p style="color:var(--cinza);font-size:.85rem;margin:.6rem 0 0;">Distribuição por variação:
          ${dist.map((d) => `#${d.variacao_indice ?? '—'}: ${fmtInt(d.n)}`).join(' · ')}</p>`
      : '';

    return `
      <section class="rel-sec">
        <h2>Fila e acompanhamento</h2>
        <dl class="rel-id">
          ${linhas}
          <div><dt>Total na fila</dt><dd>${fmtInt(total)}</dd></div>
          ${campanha.proximo_envio_em ? `<div><dt>Próximo lote a partir de</dt><dd>${escapeHtml(formatarDataHora(campanha.proximo_envio_em))} (UTC)</dd></div>` : ''}
        </dl>
        ${distHtml}
        ${enviadas && !dist.length ? '<p class="aviso-alerta">Há mensagens enviadas sem variação registrada — verifique o log.</p>' : ''}
      </section>`;
  }

  function blocoAcoes(campanha) {
    const temFila = db.resumoCampanhaMassaWa(campanha.id).reduce((a, l) => a + l.n, 0) > 0;
    const botoes = [];

    if (campanha.status === 'rascunho' || campanha.status === 'pausada') {
      const textoConfirma = `Ativar "${campanha.nome}"? As mensagens passam a sair pela cadência configurada `
        + `(${textoCadencia(campanha)}).`;
      botoes.push(`
        <form method="POST" action="/admin/massa-wa/${campanha.id}/status"
              data-confirm="${escapeHtml(textoConfirma)}"
              data-confirm-titulo="Ativar a campanha?" data-confirm-texto="Ativar" data-confirm-destrutivo="1"
              style="display:inline;">
          <input type="hidden" name="status" value="ativa">
          <button type="submit" class="btn"${temFila ? '' : ' disabled title="Materialize o público primeiro."'}>
            ${campanha.status === 'pausada' ? 'Retomar' : 'Ativar'}</button>
        </form>`);
    }

    if (campanha.status === 'ativa') {
      botoes.push(`
        <form method="POST" action="/admin/massa-wa/${campanha.id}/status" style="display:inline;">
          <input type="hidden" name="status" value="pausada">
          <button type="submit" class="btn btn--ghost">Pausar</button>
        </form>`);
    }

    if (!['cancelada', 'concluida'].includes(campanha.status)) {
      botoes.push(`
        <form method="POST" action="/admin/massa-wa/${campanha.id}/status"
              data-confirm="Cancelar esta campanha? Este status é DEFINITIVO: ela não volta a enviar nunca mais, e o caminho seria criar outra campanha."
              data-confirm-titulo="Cancelar a campanha?" data-confirm-texto="Cancelar campanha" data-confirm-destrutivo="1"
              style="display:inline;">
          <input type="hidden" name="status" value="cancelada">
          <button type="submit" class="btn btn--ghost">Cancelar</button>
        </form>`);
    }

    return `
      <section class="rel-sec">
        <h2>Ações</h2>
        <div class="acoes-linha">${botoes.join('') || '<span style="color:var(--cinza)">Nenhuma ação disponível neste status.</span>'}</div>
        ${campanha.pausada_motivo ? `<p class="aviso-alerta" style="margin:.7rem 0 0;"><b>Pausada automaticamente:</b> ${escapeHtml(campanha.pausada_motivo)}.
          Uma pausa do disjuntor <b>não se desfaz sozinha</b> — retomar é decisão sua, depois de entender o motivo.</p>` : ''}
      </section>`;
  }

  function blocoTeste(campanha) {
    return `
      <section class="rel-sec">
        <h2>Teste para 1 número</h2>
        <p style="color:var(--cinza);font-size:.85rem;">
          Manda UMA mensagem (variação sorteada, com dados reais da vaga) para o número que você
          digitar. Não usa a fila, não marca ninguém e não conta no teto diário. É o caminho para o
          primeiro envio real.</p>
        <form method="POST" action="/admin/massa-wa/${campanha.id}/teste"
              data-confirm="Enviar uma mensagem de teste para este número agora?"
              data-confirm-titulo="Enviar teste?" data-confirm-texto="Enviar"
              style="display:flex;gap:.6rem;align-items:flex-end;flex-wrap:wrap;">
          <label class="campo" style="margin:0;min-width:16rem;"><span>Número (com DDI)</span>
            <input type="text" name="telefone" placeholder="+55 47 99999-9999" required></label>
          <button type="submit" class="btn btn--ghost">Enviar teste</button>
        </form>
      </section>`;
  }

  router.get('/:id', (req, res) => {
    const campanha = db.obterCampanhaMassaWa(Number(req.params.id));
    if (!campanha) return res.status(404).send(paginaAdmin({ titulo: 'Campanha', conteudo: '<h1>Campanha não encontrada.</h1>' }));

    const conteudo = `
      <p><a class="btn btn--ghost" href="/admin/massa-wa">← Voltar às campanhas</a></p>
      <div style="display:flex;justify-content:space-between;align-items:center;gap:1rem;flex-wrap:wrap;margin-bottom:.4rem;">
        <h1 style="margin:0;">${escapeHtml(campanha.nome)}</h1>
        <span class="badge ${campanha.status === 'ativa' ? 'badge--ativa' : 'badge--encerrada'}">${escapeHtml(ROTULO_STATUS[campanha.status] || campanha.status)}</span>
      </div>
      <p style="color:var(--cinza);font-size:.82rem;margin:0 0 1rem;">${escapeHtml(textoCadencia(campanha))}</p>
      ${flash(req)}
      ${blocoEstado()}
      ${blocoAcoes(campanha)}
      ${blocoFila(campanha)}
      ${blocoPrevia(campanha)}
      ${blocoVariacoes(campanha, req)}
      ${blocoTeste(campanha)}
      <section class="rel-sec">
        <h2>Configuração</h2>
        ${formCampanha(campanha, { acao: `/admin/massa-wa/${campanha.id}`, rotuloBotao: 'Salvar configuração' })}
      </section>`;

    return res.send(paginaAdmin({ titulo: campanha.nome, conteudo }));
  });

  router.post('/:id', (req, res) => {
    const id = Number(req.params.id);
    const campanha = db.obterCampanhaMassaWa(id);
    if (!campanha) return res.status(404).send(paginaAdmin({ titulo: 'Campanha', conteudo: '<h1>Campanha não encontrada.</h1>' }));

    const d = lerCampanhaDoCorpo(req.body || {});
    if (!d.nome) return res.redirect(`/admin/massa-wa/${id}?erro=nome`);
    if (!d.statusList.length) return res.redirect(`/admin/massa-wa/${id}?erro=status`);

    db.atualizarCampanhaMassaWa(id, {
      nome: d.nome,
      jobId: d.jobId,
      textoBase: d.textoBase,
      criterios: { statusList: d.statusList },
      totalEstimado: campanha.total_estimado,
      cadencia: d.cadencia,
    });
    return res.redirect(`/admin/massa-wa/${id}?ok=salva`);
  });

  // ══════════════════ VARIACOES ══════════════════

  router.post('/:id/variacoes', (req, res) => {
    const id = Number(req.params.id);
    if (!db.obterCampanhaMassaWa(id)) return res.status(404).send(paginaAdmin({ titulo: 'Campanha', conteudo: '<h1>Campanha não encontrada.</h1>' }));

    const b = req.body || {};
    const textos = Array.from({ length: variacoesLib.TOTAL_VARIACOES }, (_, i) => String(b[`variacao_${i + 1}`] || ''));
    // Salva SEMPRE, valido ou nao: o operador esta no meio da escrita, e perder o texto digitado
    // porque falta um token e pior que salvar algo que a tela ja acusa. Quem impede o disparo e a
    // validacao no ativar/materializar e no proprio worker.
    db.salvarVariacoesMassaWa(id, textos);
    return res.redirect(`/admin/massa-wa/${id}?ok=variacoes`);
  });

  // "Sugerir com IA".
  //
  // ⚠️ NAO CHAMA O LLM. A chamada real depende de autorizacao explicita (MASSA_WA_LLM_ATIVO), e
  // enquanto ela nao existe o botao preenche os campos com as sementes — que e o mesmo ponto de
  // partida, sem custo e sem chamada externa. O aviso na tela diz isso ao operador; deixar o botao
  // "funcionando" sem avisar seria pior que nao ter botao.
  router.post('/:id/sugerir', (req, res) => {
    const id = Number(req.params.id);
    if (!db.obterCampanhaMassaWa(id)) return res.status(404).send(paginaAdmin({ titulo: 'Campanha', conteudo: '<h1>Campanha não encontrada.</h1>' }));

    if (String(process.env.MASSA_WA_LLM_ATIVO || '').toLowerCase() === 'true') {
      // Mesmo com a chave ligada, este caminho ainda nao existe: a integracao sera escrita quando
      // autorizada. Falhar dizendo isso e melhor que fingir.
      console.warn('[massa-wa] MASSA_WA_LLM_ATIVO ligado, mas a geracao por IA ainda nao foi implementada.');
    }
    db.salvarVariacoesMassaWa(id, [...variacoesLib.VARIACOES_SEED]);
    return res.redirect(`/admin/massa-wa/${id}?ok=sugerido`);
  });

  // ══════════════════ MATERIALIZAR ══════════════════

  router.post('/:id/materializar', (req, res) => {
    const id = Number(req.params.id);
    const campanha = db.obterCampanhaMassaWa(id);
    if (!campanha) return res.status(404).send(paginaAdmin({ titulo: 'Campanha', conteudo: '<h1>Campanha não encontrada.</h1>' }));

    const ja = db.resumoCampanhaMassaWa(id).reduce((a, l) => a + l.n, 0);
    if (ja > 0) return res.redirect(`/admin/massa-wa/${id}?erro=ja_materializada`);

    const lista = db.listarVariacoesMassaWa(id);
    if (!variacoesLib.validarVariacoes(lista.map((v) => v.texto)).ok) {
      return res.redirect(`/admin/massa-wa/${id}?erro=variacoes_invalidas`);
    }

    let r;
    try {
      r = publico.montarPublicoMassaWa({ jobId: campanha.job_id, statusList: statusDaCampanha(campanha) });
    } catch {
      return res.redirect(`/admin/massa-wa/${id}?erro=status`);
    }
    if (!r.itens.length) return res.redirect(`/admin/massa-wa/${id}?erro=sem_publico`);

    const n = db.materializarCampanhaMassaWa(id, r.itens);
    db.atualizarCampanhaMassaWa(id, {
      nome: campanha.nome,
      jobId: campanha.job_id,
      textoBase: campanha.texto_base,
      criterios: { statusList: statusDaCampanha(campanha) },
      totalEstimado: n,
      cadencia: cadencia.resolverCadencia(campanha),
    });
    console.log(`[massa-wa] campanha ${id} materializada com ${n} destinatario(s).`);
    return res.redirect(`/admin/massa-wa/${id}?ok=materializada`);
  });

  // ══════════════════ STATUS ══════════════════

  router.post('/:id/status', (req, res) => {
    const id = Number(req.params.id);
    const campanha = db.obterCampanhaMassaWa(id);
    if (!campanha) return res.status(404).send(paginaAdmin({ titulo: 'Campanha', conteudo: '<h1>Campanha não encontrada.</h1>' }));

    const destino = String((req.body && req.body.status) || '');
    if (!['ativa', 'pausada', 'cancelada'].includes(destino)) {
      return res.redirect(`/admin/massa-wa/${id}`);
    }

    if (destino === 'ativa') {
      // Duas travas antes de ativar. A validacao se repete aqui (ja houve no materializar) porque o
      // operador pode ter editado as variacoes no meio — e o worker checa de novo no envio. Tres
      // checagens da mesma regra, nos tres momentos em que ela pode ter mudado.
      const ja = db.resumoCampanhaMassaWa(id).reduce((a, l) => a + l.n, 0);
      if (!ja) return res.redirect(`/admin/massa-wa/${id}?erro=nao_materializada`);
      const lista = db.listarVariacoesMassaWa(id);
      if (!variacoesLib.validarVariacoes(lista.map((v) => v.texto)).ok) {
        return res.redirect(`/admin/massa-wa/${id}?erro=variacoes_invalidas`);
      }
    }

    db.definirStatusCampanhaMassaWa(id, destino, { motivo: destino === 'pausada' ? 'pausada no painel' : null });
    console.log(`[massa-wa] campanha ${id}: status -> ${destino} (painel).`);
    const okPor = { ativa: 'ativada', pausada: 'pausada', cancelada: 'cancelada' };
    return res.redirect(`/admin/massa-wa/${id}?ok=${okPor[destino]}`);
  });

  // ══════════════════ TESTE PARA 1 NUMERO ══════════════════

  // O primeiro envio real do subsistema acontece por aqui.
  //
  // NAO toca a fila: nenhuma linha e criada ou marcada, nada conta no teto diario. E uma sonda —
  // "o texto sai certo neste aparelho?" — e nao um envio de campanha. Respeita o MOCK: com ele
  // ligado, o texto vai para o log e nada sai.
  router.post('/:id/teste', async (req, res) => {
    const id = Number(req.params.id);
    const campanha = db.obterCampanhaMassaWa(id);
    if (!campanha) return res.status(404).send(paginaAdmin({ titulo: 'Campanha', conteudo: '<h1>Campanha não encontrada.</h1>' }));

    const telefone = normalizarTelefoneWhatsapp(String((req.body && req.body.telefone) || ''));
    if (!telefone) return res.redirect(`/admin/massa-wa/${id}?erro=telefone`);

    const lista = db.listarVariacoesMassaWa(id);
    if (!variacoesLib.validarVariacoes(lista.map((v) => v.texto)).ok) {
      return res.redirect(`/admin/massa-wa/${id}?erro=variacoes_invalidas`);
    }

    const vaga = campanha.job_id
      ? db.obterVaga(campanha.job_id)
      : db.listarVagas().filter((v) => v.ativo).find((v) => temEntrevistaGrupoFutura(v));
    const proxima = vaga ? proximaEntrevistaGrupo(vaga) : null;
    if (!proxima) return res.redirect(`/admin/massa-wa/${id}?erro=sem_reuniao_teste`);

    const escolhida = variacoesLib.sortearVariacao(lista, campanha.ultima_variacao);
    // Link REAL do telefone de teste: clicar nele registra o opt-out desse numero.
    const ctx = variacoesLib.montarContexto({
      nome: 'teste',
      job: vaga,
      proxima,
      linkDescadastro: variacoesLib.linkDescadastroPara(telefone),
      recrutador: db.obterConfig('recrutador_nome', ''),
    });
    const { texto, faltando } = variacoesLib.resolverTexto(escolhida.texto, ctx);
    if (faltando.length) return res.redirect(`/admin/massa-wa/${id}?erro=variacoes_invalidas`);

    if (worker.modoMock()) {
      console.log(`[massa-wa] (mock) TESTE para ${telefone} — variacao ${escolhida.indice}:\n${texto}`);
      return res.redirect(`/admin/massa-wa/${id}?ok=teste_mock`);
    }

    try {
      await conexao.enviarTexto(telefone, texto);
      console.log(`[massa-wa] TESTE enviado para ${telefone} (variacao ${escolhida.indice}).`);
      return res.redirect(`/admin/massa-wa/${id}?ok=teste_enviado`);
    } catch (err) {
      console.error(`[massa-wa] falha no envio de teste: ${err.message}`);
      return res.redirect(`/admin/massa-wa/${id}?erro=envio_teste`);
    }
  });

  return router;
}

module.exports = { criarRouterMassaWa, ROTULO_STATUS, ROTULO_ENVIO, frasesDosProblemas, negritoWhatsapp };
