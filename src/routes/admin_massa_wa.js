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
const { varianteSemNono } = require('../whatsapp/sequenciaOutbox');
const cadencia = require('../lib/cadenciaMassaWa');
const variacoesLib = require('../lib/variacoesMassaWa');
const publico = require('../lib/publicoMassaWhatsapp');
const segLib = require('../lib/publicoSegmentoMassaWa');
const cidadesLib = require('../lib/cidades');
const { normalizarTelefoneWhatsapp } = require('../lib/whatsapp');
const { proximaEntrevistaGrupo, temEntrevistaGrupoFutura } = require('../lib/entrevistaGrupo');
const { config } = require('../config');
const { partesBrasilia, paraTextoSqlUtc, inicioDoDiaBrasiliaUtc } = require('../lib/fusoBrasilia');

// Rotulos dos status da campanha. Aqui (apresentacao), nao na lib.
const ROTULO_STATUS = {
  rascunho: 'Rascunho',
  ativa: 'Ativa',
  pausada: 'Pausada',
  concluida: 'Concluída',
  cancelada: 'Cancelada',
  excluida: 'Excluída',
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
  cancelado: 'Cancelado (campanha excluída)',
  // Saiu do nosso lado e nao tinha aparelho do outro (campanha 3, antes da correcao do nono
  // digito). NAO conta como enviada em lugar nenhum, e a pessoa volta ao publico.
  sem_destino: 'Sem destino',
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
    excluida: ['ok', 'Campanha excluída. A fila que ainda não tinha saído foi cancelada.'],
    teste_enviado: ['ok', 'Mensagem de teste enviada para o número informado.'],
    teste_mock: ['alerta', 'MODO MOCK: a mensagem NÃO saiu. O texto que sairia está no log do servidor.'],
    conferencia: ['ok', 'Marcações desta página salvas. O funil da campanha já reflete a mudança.'],
  };

  const ERROS = {
    nome: 'O nome da campanha não pode ficar vazio.',
    cadencia_piso: `Cadência abaixo do mínimo seguro: no mínimo ${cadencia.PISO.gapMinS} segundos entre mensagens, `
      + `${cadencia.PISO.pausaLoteMinS / 60} minutos entre lotes e no máximo ${cadencia.PISO.loteMax} mensagens por lote. Nada foi salvo.`,
    status: 'Selecione ao menos um status do recrutador para o público.',
    variacoes_invalidas: 'As variações não passaram na validação — corrija os pontos listados.',
    sem_variacoes: 'Escreva e salve as 7 variações antes de materializar o público.',
    sem_publico: 'O público está vazio com estes filtros — nada a materializar.',
    ja_materializada: 'Esta campanha já tem fila materializada.',
    nao_materializada: 'Materialize o público antes de ativar.',
    telefone: 'Número de teste inválido. Use o formato +55 47 99999-9999.',
    sem_reuniao_teste: 'Nenhuma vaga ativa tem entrevista em grupo futura — o teste não teria data nem link para enviar.',
    envio_teste: 'Falha ao enviar o teste (o motivo está no log do servidor).',
    teste_nao_confirmado: 'O WhatsApp não confirmou esse número (testado com e sem o 9). Confira o DDD e o número, com o 55 na frente.',
    // Segmento da base
    seg_vaga_alvo: 'Escolha a vaga-alvo (uma vaga aberta).',
    seg_vaga_fechada: 'A vaga-alvo não está aberta: só dá para convidar para vaga aberta.',
    seg_cidade: 'Cidade fora do vocabulário de cidades.',
    seg_periodo: 'Período inválido: confira as datas (a inicial não pode ser depois da final).',
    seg_dias_outros_canais: 'Dias de outros canais inválido: use um número inteiro, 0 ou mais.',
    seg_teto: 'O teto de destinatários é obrigatório no segmento.',
    seg_teto_maximo: `O teto de destinatários do segmento é no máximo ${segLib.TETO_MAXIMO}.`,
    seg_vaga_alvo_ignorada: 'A vaga-alvo não pode ser marcada como vaga parada.',
    seg_publico: 'Não foi possível montar o público do segmento (vaga-alvo fechada ou critérios inválidos). Nada foi gravado.',
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
  function blocoEstado(campanha = null) {
    const ligado = worker.ativo({ db });
    const seg = campanha && ehSegmento(campanha);
    const segLigado = worker.segmentoAtivo({ db });
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
          ${seg ? selo(segLigado, segLigado ? 'Segmento LIGADO' : 'Segmento DESLIGADO') : ''}
        </div>
        ${seg ? `<p style="color:var(--cinza);font-size:.82rem;margin:.6rem 0 0;">
          Campanha de <b>segmento da base</b>: além do interruptor geral, só envia com
          <code>${escapeHtml(worker.CHAVE_SEGMENTO_ATIVO)}</code> ligado (em <a href="/admin/config">Configurações</a>).
          Desligado, os itens ficam na fila sem sair.</p>` : ''}
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

  // criterios_json inteiro, tolerante a JSON quebrado. Alem de statusList, guarda o registro da
  // materializacao e das reconciliacoes (ver blocoFila) — por isso quem grava criterios tem que
  // partir DAQUI e trocar so a sua chave, e nunca reescrever o objeto do zero.
  const criteriosDaCampanha = (campanha) => {
    try {
      const c = JSON.parse(campanha.criterios_json || '{}');
      return c && typeof c === 'object' ? c : {};
    } catch {
      return {};
    }
  };

  const statusDaCampanha = (campanha) => {
    const lista = criteriosDaCampanha(campanha).statusList || [];
    return lista.length ? lista : [...publico.STATUS_PADRAO];
  };

  // Texto SQL UTC ('2026-10-01 14:20:49') -> '01/10 11:20' no relogio de Brasilia.
  const diaHoraBrasilia = (textoUtc) => {
    const p = textoUtc ? partesBrasilia(new Date(`${String(textoUtc).replace(' ', 'T')}Z`)) : null;
    if (!p) return '';
    const dd = (n) => String(n).padStart(2, '0');
    return `${dd(p.dia)}/${dd(p.mes)} ${dd(p.hora)}:${dd(p.minuto)}`;
  };

  const minutosEmSegundos = (m) => (m == null ? null : m * 60);

  // Algum valor DIGITADO abaixo do piso? Campo vazio (null) nao conta: e "usar o default", que ja
  // respeita o piso. Recusar (e nao subir em silencio) e o que faz o operador ver o limite.
  function cadenciaAbaixoDoPiso(c) {
    const abaixo = (v, piso) => v != null && v < piso;
    return abaixo(c.gapMinS, cadencia.PISO.gapMinS)
      || abaixo(c.gapMaxS, cadencia.PISO.gapMinS)
      || abaixo(c.pausaLoteMinS, cadencia.PISO.pausaLoteMinS)
      || abaixo(c.pausaLoteMaxS, cadencia.PISO.pausaLoteMinS)
      || (c.loteMax != null && c.loteMax > cadencia.PISO.loteMax)
      || (c.loteMin != null && c.loteMin > cadencia.PISO.loteMax);
  }

  // O ritmo em portugues, para o operador ver o efeito dos numeros antes de ativar.
  function textoRitmo(c) {
    const lote = (c.loteMin + c.loteMax) / 2;
    const gap = (c.gapMinS + c.gapMaxS) / 2;
    const pausa = (c.pausaLoteMinS + c.pausaLoteMaxS) / 2;
    const porHora = Math.round((lote * 3600) / ((lote - 1) * gap + pausa));
    const horasTeto = porHora ? (c.tetoDiario / porHora) : 0;
    return `Nesse ritmo: cerca de <b>${porHora} mensagens por hora</b>; o teto de ${c.tetoDiario}/dia `
      + `é atingido em cerca de <b>${horasTeto.toFixed(1).replace('.', ',')} h</b>.`;
  }

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
        // A tela pede a pausa entre lotes em MINUTOS (pedir em segundos foi o que levou a
        // pausa de "5 a 10" virar 5 a 10 segundos na primeira campanha real). Os campos em
        // segundos continuam aceitos para POST antigo.
        pausaLoteMinS: minutosEmSegundos(num(b.pausa_lote_min_min)) ?? num(b.pausa_lote_min_s),
        pausaLoteMaxS: minutosEmSegundos(num(b.pausa_lote_max_min)) ?? num(b.pausa_lote_max_s),
        tetoDiario: num(b.teto_diario),
        horaInicio: String(b.hora_inicio || '').trim() || null,
        horaFim: String(b.hora_fim || '').trim() || null,
        diasSemana: String(b.dias_semana || '').trim() || null,
      },
    };
  }

  // ══════════════════ SEGMENTO DA BASE (criterios.fonte = 'segmento') ══════════════════
  //
  // Tudo o que e PROPRIO do segmento mora nesta secao. As rotas so perguntam ehSegmento(campanha)
  // e desviam para ca; campanha sem `fonte` nunca passa por nenhuma destas funcoes.
  //
  // A criacao tem DOIS passos sem JavaScript: primeiro a vaga-alvo (GET), depois o formulario com
  // as listas da cidade dela (vagas de origem, vagas paradas). A cidade vem da vaga-alvo e so pode
  // ser trocada por outra do vocabulario.

  const ehSegmento = (campanha) => publico.fonteDaCampanhaMassaWa(campanha) === segLib.FONTE_SEGMENTO;
  const tipoDaCampanha = (campanha) => variacoesLib.tipoPorFonte(publico.fonteDaCampanhaMassaWa(campanha));

  const ROTULO_CANAL = { meta: 'Meta/Central Whats', email: 'e-mail', massa: 'massa (Baileys)', n8n: 'n8n por praça' };
  const textoPorCanal = (porCanal) => Object.entries(porCanal || {})
    .map(([k, n]) => `${ROTULO_CANAL[k] || k}: ${n}`).join(' · ');

  // '2026-10-05' -> '05/10/2026'
  const dataBr = (iso) => (iso ? iso.split('-').reverse().join('/') : '');

  const vagaRotulo = (v) => `${v.titulo}${v.cidade ? ` — ${v.cidade}` : ' — remota'}`;

  // As colunas de cadencia COMO ESTAO (NULL = default do codigo). Regravar a campanha com
  // resolverCadencia congelaria os defaults de hoje nas colunas.
  const cadenciaCrua = (campanha) => ({
    loteMin: campanha.lote_min,
    loteMax: campanha.lote_max,
    gapMinS: campanha.gap_min_s,
    gapMaxS: campanha.gap_max_s,
    pausaLoteMinS: campanha.pausa_lote_min_s,
    pausaLoteMaxS: campanha.pausa_lote_max_s,
    tetoDiario: campanha.teto_diario,
    horaInicio: campanha.hora_inicio,
    horaFim: campanha.hora_fim,
    diasSemana: campanha.dias_semana,
  });

  function estatisticaPorVaga() {
    return new Map(db.estatisticaCandidaturasPorVagaMassaWa().map((e) => [e.job_id, e]));
  }

  // Le os campos do segmento. A vaga-alvo NAO vem do corpo na edicao: ela e o job_id da campanha,
  // fixada na criacao (trocar o alvo de uma campanha ja conferida mudaria tudo o que foi conferido).
  function lerSegmentoDoCorpo(b, { vagaAlvoId }) {
    const lista = (v) => [].concat(v || []).map((x) => String(x).trim()).filter(Boolean);
    const alvo = vagaAlvoId ? db.obterVaga(Number(vagaAlvoId)) : null;
    const cidadeDigitada = String(b.cidade || '').trim();
    return {
      nome: String(b.nome || '').trim(),
      alvo,
      bruto: {
        vagaAlvoId,
        // Vazio = a cidade da vaga-alvo. Nome sempre canonico (o do vocabulario).
        cidade: cidadesLib.normalizarCidade(cidadeDigitada || (alvo && alvo.cidade) || '') || cidadeDigitada,
        dataDe: String(b.data_de || '').trim() || null,
        dataAte: String(b.data_ate || '').trim() || null,
        vagasOrigem: lista(b.vagas_origem),
        vagasIgnoradasProcesso: lista(b.vagas_ignoradas),
        diasOutrosCanais: String(b.dias_outros_canais == null ? '' : b.dias_outros_canais).trim(),
        teto: String(b.teto || '').trim(),
      },
      cadencia: lerCampanhaDoCorpo(b).cadencia,
    };
  }

  // Valida e devolve { criterios } ou { erro } (codigo de ERROS). Alem do saneamento da lib, confere
  // o que a lib so descobriria na montagem: vaga-alvo aberta e cidade do vocabulario.
  function validarSegmento(lido) {
    if (!lido.nome) return { erro: 'nome' };
    if (!lido.alvo) return { erro: 'seg_vaga_alvo' };
    if (!lido.alvo.ativo) return { erro: 'seg_vaga_fechada' };
    if (!cidadesLib.normalizarCidade(lido.bruto.cidade)) return { erro: 'seg_cidade' };
    const { criterios, erros } = segLib.sanearCriteriosSegmento(lido.bruto);
    if (erros.length) return { erro: `seg_${erros[0]}` };
    if (cadenciaAbaixoDoPiso(lido.cadencia)) return { erro: 'cadencia_piso' };
    return { criterios };
  }

  function formSegmento({ campanha = null, alvo, criterios = {} }, { acao, rotuloBotao }) {
    const c = criterios;
    const cad = cadencia.resolverCadencia(campanha || {});
    const est = estatisticaPorVaga();
    const cidadeAtual = c.cidade || alvo.cidade || '';
    const chaveCidade = cidadesLib.chave(cidadeAtual);
    const daCidade = db.listarVagas().filter((v) => v.id !== alvo.id && cidadesLib.chave(v.cidade) === chaveCidade);
    const origem = new Set((c.vagasOrigem || []).map(Number));
    const ignoradas = new Set((c.vagasIgnoradasProcesso || []).map(Number));
    const infoVaga = (v) => {
      const e = est.get(v.id) || { vivas: 0, ultima: null };
      return `${fmtInt(e.vivas || 0)} candidatura(s) viva(s) · última ${e.ultima ? escapeHtml(diaHoraBrasilia(e.ultima)) : '—'}`;
    };
    const check = (nome, v, marcado, extra) => `
          <label class="campo-check" style="margin:0 0 .3rem;">
            <input type="checkbox" name="${nome}" value="${v.id}"${marcado ? ' checked' : ''}>
            <span style="color:var(--preto);text-transform:none;">#${v.id} ${escapeHtml(v.titulo)}
              ${extra} <small style="color:var(--cinza)">(${infoVaga(v)})</small></span>
          </label>`;
    const abertas = daCidade.filter((v) => v.ativo);
    const opcoesCidade = cidadesLib.listarCidadesValidas()
      .map((nome) => `<option value="${escapeHtml(nome)}"${nome === cidadeAtual ? ' selected' : ''}>${escapeHtml(nome)}</option>`)
      .join('');

    return `
      <form method="POST" action="${acao}">
        <input type="hidden" name="fonte" value="segmento">
        ${campanha ? '' : `<input type="hidden" name="vaga_alvo_id" value="${alvo.id}">`}
        <label class="campo"><span>Nome da campanha</span>
          <input type="text" name="nome" value="${escapeHtml((campanha && campanha.nome) || '')}" required></label>

        <p style="font-size:.9rem;margin:0 0 1rem;"><b>Vaga-alvo:</b> #${alvo.id} ${escapeHtml(vagaRotulo(alvo))}
          ${campanha ? '' : ' · <a href="/admin/massa-wa/nova?fonte=segmento">trocar</a>'}</p>

        <label class="campo" style="max-width:20rem;"><span>Cidade (das vagas de origem)</span>
          <select name="cidade">${opcoesCidade}</select></label>
        <p style="color:var(--cinza);font-size:.8rem;margin:-.5rem 0 1.2rem;">
          Preenchida pela vaga-alvo. As listas abaixo são de <b>${escapeHtml(cidadeAtual || '—')}</b>; ao trocar a
          cidade, salve e reabra para ver as vagas da nova cidade.</p>

        <div style="display:flex;gap:.6rem;flex-wrap:wrap;">
          <label class="campo" style="max-width:12rem;"><span>Candidatura de (dia)</span>
            <input type="date" name="data_de" value="${escapeHtml(c.dataDe || '')}"></label>
          <label class="campo" style="max-width:12rem;"><span>até (dia)</span>
            <input type="date" name="data_ate" value="${escapeHtml(c.dataAte || '')}"></label>
        </div>
        <p style="color:var(--cinza);font-size:.8rem;margin:-.5rem 0 1.2rem;">
          Dias de Brasília. Vazio = toda a base. A pessoa entra se <b>alguma</b> candidatura dela a vaga da cidade cair no período.</p>

        <fieldset style="border:1px solid var(--linha);border-radius:8px;padding:.8rem 1rem;margin:0 0 1.2rem;">
          <legend style="font-size:.85rem;color:var(--cinza);">Vagas de origem (opcional — nenhuma marcada = todas da cidade)</legend>
          ${daCidade.map((v) => check('vagas_origem', v, origem.has(v.id), v.ativo ? '' : '<small>(encerrada)</small>')).join('') || '<p style="color:var(--cinza);font-size:.85rem;">Nenhuma outra vaga nesta cidade.</p>'}
        </fieldset>

        <fieldset style="border:1px solid var(--linha);border-radius:8px;padding:.8rem 1rem;margin:0 0 1.2rem;">
          <legend style="font-size:.85rem;color:var(--cinza);">Vagas abertas que NÃO contam como processo em andamento</legend>
          ${abertas.map((v) => check('vagas_ignoradas', v, ignoradas.has(v.id), '')).join('') || '<p style="color:var(--cinza);font-size:.85rem;">Nenhuma outra vaga aberta nesta cidade.</p>'}
          <p style="color:var(--cinza);font-size:.8rem;margin:.4rem 0 0;">
            Marque as vagas <b>paradas</b>: quem só está em processo nelas pode ser convidado. Nenhuma vaga é
            encerrada ou alterada. A vaga-alvo não aparece aqui: ela nunca pode ser ignorada.</p>
        </fieldset>

        <div style="display:flex;gap:.6rem;flex-wrap:wrap;">
          <label class="campo" style="max-width:16rem;"><span>Excluir quem recebeu divulgação nos últimos (dias)</span>
            <input type="number" min="0" name="dias_outros_canais" value="${escapeHtml(String(c.diasOutrosCanais ?? segLib.DIAS_OUTROS_CANAIS_PADRAO))}"></label>
          <label class="campo" style="max-width:14rem;"><span>Teto de destinatários (obrigatório)</span>
            <input type="number" min="1" max="${segLib.TETO_MAXIMO}" name="teto" required value="${escapeHtml(String(c.teto || segLib.TETO_PADRAO))}"></label>
        </div>
        <p style="color:var(--cinza);font-size:.8rem;margin:-.5rem 0 1.2rem;">
          Dias: qualquer canal (Meta/Central Whats, e-mail, massa, n8n); 0 desliga. Quem já foi convidado
          <b>para a vaga-alvo</b> sai sempre. Teto: no máximo ${segLib.TETO_MAXIMO}; passando dele, ficam as
          candidaturas mais recentes.</p>

        ${camposCadencia(cad)}

        <button type="submit" class="btn">${escapeHtml(rotuloBotao)}</button>
      </form>`;
  }

  // Passo 1 da criacao: escolher a vaga-alvo (so vagas ABERTAS).
  function formEscolherAlvo() {
    const vagas = db.listarVagas().filter((v) => v.ativo);
    return `
      <form method="GET" action="/admin/massa-wa/nova">
        <input type="hidden" name="fonte" value="segmento">
        <label class="campo"><span>Vaga-alvo (a vaga para a qual vamos convidar)</span>
          <select name="vaga_alvo" required>
            ${vagas.map((v) => `<option value="${v.id}">#${v.id} ${escapeHtml(vagaRotulo(v))}</option>`).join('')}
          </select></label>
        <button type="submit" class="btn">Continuar</button>
      </form>`;
  }

  function seletorFonte(fonte) {
    const aba = (f, rotulo, href) => (f === fonte
      ? `<span class="btn" aria-current="page">${rotulo}</span>`
      : `<a class="btn btn--ghost" href="${href}">${rotulo}</a>`);
    return `
      <div style="display:flex;gap:.5rem;flex-wrap:wrap;margin:0 0 1rem;">
        ${aba('vagas_abertas', 'Inscritos em vagas abertas', '/admin/massa-wa/nova')}
        ${aba('segmento', 'Segmento da base', '/admin/massa-wa/nova?fonte=segmento')}
      </div>`;
  }

  function blocoPreviaSegmento(campanha) {
    let r;
    try {
      r = publico.montarPublicoDaCampanha(campanha);
    } catch (err) {
      return `<section class="rel-sec"><h2>Público</h2>
        <p class="aviso-alerta">${escapeHtml(err.message)}</p></section>`;
    }
    const f = r.funil;
    const c = r.criterios;
    const linha = (rotulo, valor, nota) => `
      <div><dt>${rotulo}</dt><dd>${fmtInt(valor)}
        ${nota ? `<br><small style="color:var(--cinza)">${nota}</small>` : ''}</dd></div>`;
    const periodo = c.dataDe || c.dataAte
      ? `de ${escapeHtml(dataBr(c.dataDe) || 'início')} até ${escapeHtml(dataBr(c.dataAte) || 'hoje')}`
      : 'toda a base';
    const ignoradas = f.vagasIgnoradasProcesso.length
      ? `ignoradas: ${f.vagasIgnoradasProcesso.map((id) => `vaga ${id}`).join(', ')}` : '';
    const materializada = db.resumoCampanhaMassaWa(campanha.id).reduce((a, l) => a + l.n, 0) > 0;

    return `
      <section class="rel-sec">
        <h2>Público do segmento (prévia)</h2>
        <p style="color:var(--cinza);font-size:.85rem;margin:0 0 .8rem;">
          Recalculado agora. As quatro primeiras linhas contam <b>candidaturas</b> a vagas de
          ${escapeHtml(c.cidade)} (${periodo}, sem a vaga-alvo) e chegam em <b>Pessoas</b>; dali para baixo
          são pessoas, e cada uma sai na primeira linha que a pega.</p>
        ${segLib.conferirAritmetica(f) ? '' : '<p class="aviso-alerta">A conta do funil não fecha — não materialize e avise o suporte.</p>'}
        <dl class="rel-id">
          ${linha('Candidaturas', f.candidaturas)}
          ${linha('— arquivadas', f.candidaturasArquivadas)}
          ${linha('— telefone inutilizável', f.candidaturasSemTelefoneUtil)}
          ${linha('— duplicadas (mesma pessoa)', f.candidaturasDuplicadas)}
          ${linha('Pessoas', f.pessoas)}
          ${linha('— sem consentimento (consent_at)', f.pessoasSemConsentimento, 'nenhuma candidatura da pessoa marcou o consentimento')}
          ${linha('— já se candidataram à vaga-alvo', f.pessoasJaCandidatasAlvo)}
          ${linha('— em processo em andamento', f.pessoasEmProcesso,
            [`Sem decisão ou Em análise em vaga aberta de ${escapeHtml(c.cidade)}`, ignoradas].filter(Boolean).join(' · '))}
          ${f.vagasIgnoradasProcesso.length ? linha('&nbsp;&nbsp;liberadas por vagas ignoradas (informativo)', f.liberadasPorVagasIgnoradas) : ''}
          ${linha('— status do recrutador', f.pessoasStatus,
            `regra da promoção de vagas: ${Object.entries(f.porStatusExcluido).filter(([, n]) => n).map(([k, n]) => `${escapeHtml(ROTULO_STATUS_RECRUTADOR[k] || k)}: ${n}`).join(' · ') || 'nenhum'}`)}
          ${linha('— opt-out', f.pessoasOptout)}
          ${linha('— já receberam disparo em massa', f.pessoasJaReceberam, escapeHtml(textoPorCampanha(f.jaReceberamPorCampanha)))}
          ${linha('— já convidados para a vaga-alvo', f.pessoasConvidadasAlvo, escapeHtml(textoPorCanal(f.convidadasAlvoPorCanal)))}
          ${linha(`— divulgados nos últimos ${fmtInt(c.diasOutrosCanais)} dias`, f.pessoasDivulgadasRecentes,
            c.diasOutrosCanais ? escapeHtml(textoPorCanal(f.divulgadasRecentesPorCanal)) : 'regra desligada (0 dias)')}
          ${linha('— desmarcadas na conferência', f.pessoasDesmarcadas)}
          ${linha(`— fora pelo teto (${fmtInt(c.teto)})`, f.pessoasForaPorTeto, 'ficam as candidaturas mais recentes')}
          ${linha('PÚBLICO FINAL', f.total)}
        </dl>
        ${f.finalComContatoAnterior ? `<p class="aviso-alerta" style="margin:.8rem 0 0;"><b>Contato frio:</b>
          ${fmtInt(f.finalComContatoAnterior)} de ${fmtInt(f.total)} pessoa(s) do público final já receberam divulgação ou
          convite por outro canal antes do período acima${f.finalComContatoSemData ? ` (${fmtInt(f.finalComContatoSemData)} com contato sem data, histórico do n8n)` : ''}.
          A mensagem sai de um número que elas não conhecem: comece com teto pequeno.</p>` : ''}
        <p style="margin:.8rem 0 0;"><a class="btn btn--ghost" href="/admin/massa-wa/${campanha.id}/conferencia">
          ${materializada ? 'Ver a conferência nominal' : 'Conferência nominal (revisar e desmarcar antes de materializar)'}</a></p>
      </section>`;
  }

  // "Criada em …: X pessoas − cortes = N na fila", com cada corte que tirou alguem.
  function linhaOrigemSegmento(m) {
    const f = m.funil || {};
    const cortes = [
      ['sem consentimento', f.pessoasSemConsentimento],
      ['já candidatos da vaga-alvo', f.pessoasJaCandidatasAlvo],
      ['em processo', f.pessoasEmProcesso],
      ['status', f.pessoasStatus],
      ['opt-out', f.pessoasOptout],
      ['já receberam disparo em massa', f.pessoasJaReceberam],
      ['já convidados para a vaga-alvo', f.pessoasConvidadasAlvo],
      ['divulgados recentemente', f.pessoasDivulgadasRecentes],
      ['desmarcadas na conferência', f.pessoasDesmarcadas],
      ['pelo teto', f.pessoasForaPorTeto],
    ].filter(([, n]) => n);
    return `Criada em ${escapeHtml(diaHoraBrasilia(m.em))}: <b>${fmtInt(f.pessoas || 0)}</b> pessoas do segmento`
      + cortes.map(([r, n]) => ` − <b>${fmtInt(n)}</b> ${escapeHtml(r)}`).join('')
      + ` = <b>${fmtInt(m.naFila)}</b> na fila.`;
  }

  function blocoAtribuicao(campanha) {
    const n = db.contarCandidaturasPorUtmMassaWa(campanha.id);
    return `
      <section class="rel-sec">
        <h2>Candidaturas geradas por esta campanha</h2>
        <p style="font-size:1.4rem;margin:0;"><b>${fmtInt(n)}</b></p>
        <p style="color:var(--cinza);font-size:.8rem;margin:.4rem 0 0;">
          Candidaturas com <code>utm_source=${escapeHtml(variacoesLib.UTM_SOURCE_MASSA)}</code> e
          <code>utm_campaign=${escapeHtml(variacoesLib.utmCampaignMassa(campanha.id))}</code> (o link da vaga na mensagem).
          É um piso: quem já tinha aberto esta vaga por outro link antes fica com a origem antiga (primeiro toque).</p>
      </section>`;
  }

  // ── CONFERENCIA NOMINAL ──
  const POR_PAGINA = 25;

  function textoContatos(contatos) {
    const ultimo = new Map();
    for (const x of contatos || []) {
      const atual = ultimo.get(x.canal);
      if (atual === undefined || (x.em && (!atual || x.em > atual))) ultimo.set(x.canal, x.em || atual || null);
    }
    return [...ultimo].map(([canal, em]) => `${ROTULO_CANAL[canal] || canal} ${em ? diaHoraBrasilia(em).slice(0, 5) : '(sem data)'}`).join(', ');
  }

  router.get('/:id/conferencia', (req, res) => {
    const campanha = db.obterCampanhaMassaWa(Number(req.params.id));
    if (!campanha || !ehSegmento(campanha)) {
      return res.status(404).send(paginaAdmin({ titulo: 'Campanha', conteudo: '<h1>Campanha de segmento não encontrada.</h1>' }));
    }
    let r;
    try {
      r = publico.montarPublicoDaCampanha(campanha);
    } catch (err) {
      return res.send(paginaAdmin({ titulo: 'Conferência', conteudo: `<p class="aviso-alerta">${escapeHtml(err.message)}</p>` }));
    }
    const materializada = db.resumoCampanhaMassaWa(campanha.id).reduce((a, l) => a + l.n, 0) > 0;
    const todos = [...r.itens.map((i) => ({ ...i, marcado: true })), ...r.desmarcadas.map((i) => ({ ...i, marcado: false }))];
    const paginas = Math.max(1, Math.ceil(todos.length / POR_PAGINA));
    const pagina = Math.min(Math.max(1, Number(req.query.pagina) || 1), paginas);
    const fatia = todos.slice((pagina - 1) * POR_PAGINA, pagina * POR_PAGINA);

    const linhas = fatia.map((p) => `
      <tr>
        <td>${materializada ? (p.marcado ? '✔' : '—') : `<input type="hidden" name="na_pagina" value="${escapeHtml(p.telefoneCanonico)}">
          <input type="checkbox" name="manter" value="${escapeHtml(p.telefoneCanonico)}"${p.marcado ? ' checked' : ''} aria-label="Manter ${escapeHtml(p.nome)}">`}</td>
        <td>${escapeHtml(p.nome || '—')}</td>
        <td>${escapeHtml(p.jobTitulo || '—')}</td>
        <td>${escapeHtml(diaHoraBrasilia(p.candidaturaEm))}</td>
        <td>${escapeHtml(ROTULO_STATUS_RECRUTADOR[p.statusRecrutador] || p.statusRecrutador || '—')}</td>
        <td>${escapeHtml(textoContatos(p.contatos)) || '—'}</td>
        <td><code>${escapeHtml(segLib.mascararTelefone(p.telefone))}</code></td>
      </tr>`).join('');

    const nav = paginas > 1
      ? `<p style="font-size:.85rem;">Página ${pagina} de ${paginas} ·
          ${pagina > 1 ? `<a href="?pagina=${pagina - 1}">← anterior</a>` : ''}
          ${pagina < paginas ? `<a href="?pagina=${pagina + 1}">próxima →</a>` : ''}</p>` : '';

    const tabela = `
      <div class="admin-tab-scroll">
        <table class="admin-tab">
          <thead><tr><th>Recebe</th><th>Nome</th><th>Vaga de origem</th><th>Candidatura</th><th>Status</th><th>Canais já contatados</th><th>Telefone</th></tr></thead>
          <tbody>${linhas || '<tr><td colspan="7">Ninguém no público com estes critérios.</td></tr>'}</tbody>
        </table>
      </div>`;

    const conteudo = `
      <p><a class="btn btn--ghost" href="/admin/massa-wa/${campanha.id}">← Voltar à campanha</a></p>
      <h1>Conferência nominal — ${escapeHtml(campanha.nome)}</h1>
      ${flash(req)}
      <p style="font-size:.9rem;"><b>${fmtInt(r.itens.length)}</b> pessoa(s) vão receber ·
        <b>${fmtInt(r.desmarcadas.length)}</b> desmarcada(s) · ${fmtInt(r.funil.pessoasForaPorTeto)} fora pelo teto
        (não listadas). Desmarcar alguém abre a vaga no teto para a próxima candidatura mais recente.</p>
      ${materializada
        ? `<p class="aviso-alerta">A fila já foi materializada: esta lista é só consulta e não muda mais nada.</p>${tabela}`
        : `<form method="POST" action="/admin/massa-wa/${campanha.id}/conferencia?pagina=${pagina}">
            ${tabela}
            <button type="submit" class="btn" style="margin-top:.8rem;">Salvar marcações desta página</button>
          </form>`}
      ${nav}`;
    return res.send(paginaAdmin({ titulo: 'Conferência nominal', conteudo }));
  });

  // Salva as marcacoes DA PAGINA: quem estava na pagina e nao veio em `manter` vira desmarcado; quem
  // veio volta. As outras paginas ficam como estavam.
  router.post('/:id/conferencia', (req, res) => {
    const id = Number(req.params.id);
    const campanha = db.obterCampanhaMassaWa(id);
    if (!campanha || !ehSegmento(campanha)) {
      return res.status(404).send(paginaAdmin({ titulo: 'Campanha', conteudo: '<h1>Campanha de segmento não encontrada.</h1>' }));
    }
    if (db.resumoCampanhaMassaWa(id).reduce((a, l) => a + l.n, 0) > 0) {
      return res.redirect(`/admin/massa-wa/${id}/conferencia?erro=ja_materializada`);
    }
    const b = req.body || {};
    const lista = (v) => [].concat(v || []).map((x) => String(x).trim()).filter(Boolean);
    const naPagina = new Set(lista(b.na_pagina));
    const manter = new Set(lista(b.manter));
    const criterios = criteriosDaCampanha(campanha);
    const desmarcadas = new Set(criterios.desmarcadas || []);
    for (const k of naPagina) {
      if (manter.has(k)) desmarcadas.delete(k);
      else desmarcadas.add(k);
    }
    db.atualizarCampanhaMassaWa(id, {
      nome: campanha.nome,
      jobId: campanha.job_id,
      textoBase: campanha.texto_base,
      criterios: { ...criterios, desmarcadas: [...desmarcadas] },
      totalEstimado: campanha.total_estimado,
      cadencia: cadenciaCrua(campanha),
    });
    const pagina = Number(req.query.pagina) || 1;
    return res.redirect(`/admin/massa-wa/${id}/conferencia?pagina=${pagina}&ok=conferencia`);
  });

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
            <td>${ehSegmento(c) ? '<small>Segmento →</small> ' : ''}${escapeHtml(c.vaga_titulo || 'Todas as abertas')}</td>
            <td>${escapeHtml(ROTULO_STATUS[c.status] || c.status)}
              ${c.pausada_motivo ? `<br><small style="color:var(--cinza)">${escapeHtml(c.pausada_motivo)}</small>` : ''}</td>
            <td>${fmtInt(r.enviado || 0)} / ${fmtInt(total)}</td>
            <td>${formatarDataHora(c.criado_em)}</td>
            <td>
              <form method="POST" action="/admin/massa-wa/${c.id}/excluir"
                data-confirm="A campanha “${escapeHtml(c.nome)}” sai da lista e ${fmtInt(r.pendente || 0)} mensagem(ns) ainda na fila são canceladas. Quem já recebeu continua registrado (não volta para o público de campanhas futuras)."
                data-confirm-titulo="Excluir campanha?" data-confirm-texto="Excluir" data-confirm-destrutivo="1">
                <button type="submit" class="btn btn--ghost" style="color:var(--vermelho, #b3261e);">Excluir</button>
              </form>
            </td>
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
            <thead><tr><th>Nome</th><th>Vaga</th><th>Status</th><th>Enviadas</th><th>Criada em</th><th></th></tr></thead>
            <tbody>${linhas || '<tr><td colspan="6">Nenhuma campanha ainda.</td></tr>'}</tbody>
          </table>
        </div>
      </section>`;

    res.send(paginaAdmin({ titulo: 'Disparo em massa', conteudo }));
  });

  // ══════════════════ NOVA ══════════════════

  // Os campos de cadencia, compartilhados pelo formulario de vagas abertas e pelo do segmento.
  // HTML identico ao que morava dentro de formCampanha.
  function camposCadencia(c) {
    const n = (v) => escapeHtml(String(v));
    return `
        <details style="margin:0 0 1.2rem;">
          <summary style="cursor:pointer;color:var(--cinza);font-size:.85rem;">Cadência (anti-bloqueio) — mexer só com motivo</summary>
          <div style="display:flex;gap:.6rem;flex-wrap:wrap;margin-top:.7rem;">
            <label class="campo" style="margin:0;max-width:11rem;"><span>Mensagens por lote (mín.)</span>
              <input type="number" min="1" max="${cadencia.PISO.loteMax}" name="lote_min" value="${n(c.loteMin)}"></label>
            <label class="campo" style="margin:0;max-width:11rem;"><span>Mensagens por lote (máx.)</span>
              <input type="number" min="1" max="${cadencia.PISO.loteMax}" name="lote_max" value="${n(c.loteMax)}"></label>
            <label class="campo" style="margin:0;max-width:12rem;"><span>Entre mensagens, mín. (segundos)</span>
              <input type="number" min="${cadencia.PISO.gapMinS}" name="gap_min_s" value="${n(c.gapMinS)}"></label>
            <label class="campo" style="margin:0;max-width:12rem;"><span>Entre mensagens, máx. (segundos)</span>
              <input type="number" min="${cadencia.PISO.gapMinS}" name="gap_max_s" value="${n(c.gapMaxS)}"></label>
            <label class="campo" style="margin:0;max-width:12rem;"><span>Entre lotes, mín. (MINUTOS)</span>
              <input type="number" min="${cadencia.PISO.pausaLoteMinS / 60}" name="pausa_lote_min_min" value="${n(Math.round(c.pausaLoteMinS / 60))}"></label>
            <label class="campo" style="margin:0;max-width:12rem;"><span>Entre lotes, máx. (MINUTOS)</span>
              <input type="number" min="${cadencia.PISO.pausaLoteMinS / 60}" name="pausa_lote_max_min" value="${n(Math.round(c.pausaLoteMaxS / 60))}"></label>
            <label class="campo" style="margin:0;max-width:10rem;"><span>Teto/dia</span>
              <input type="number" min="1" name="teto_diario" value="${n(c.tetoDiario)}"></label>
            <label class="campo" style="margin:0;max-width:9rem;"><span>Início</span>
              <input type="time" name="hora_inicio" value="${n(c.horaInicio)}"></label>
            <label class="campo" style="margin:0;max-width:9rem;"><span>Fim</span>
              <input type="time" name="hora_fim" value="${n(c.horaFim)}"></label>
            <label class="campo" style="margin:0;max-width:12rem;"><span>Dias (1=seg … 7=dom)</span>
              <input type="text" name="dias_semana" value="${n(c.diasSemana)}"></label>
          </div>
          <p style="font-size:.85rem;margin:.6rem 0 0;">${textoRitmo(c)}</p>
          <p style="color:var(--cinza);font-size:.8rem;margin:.4rem 0 0;">
            Mínimos que o sistema não deixa furar: ${cadencia.PISO.gapMinS} s entre mensagens,
            ${cadencia.PISO.pausaLoteMinS / 60} min entre lotes, ${cadencia.PISO.loteMax} por lote.
            Rampa recomendada do teto diário: ${cadencia.RAMPA_TETO_DIARIO.join(' → ')}. Subir é
            decisão sua, depois de dias sem incidente — o sistema nunca sobe sozinho.</p>
        </details>`;
  }

  function formCampanha(dados, { acao, rotuloBotao }) {
    const c = cadencia.resolverCadencia(dados);
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

${camposCadencia(c)}

        <button type="submit" class="btn">${escapeHtml(rotuloBotao)}</button>
      </form>`;
  }

  router.get('/nova', (req, res) => {
    if (req.query.fonte === 'segmento') {
      const alvo = req.query.vaga_alvo ? db.obterVaga(Number(req.query.vaga_alvo)) : null;
      const corpo = alvo && alvo.ativo
        ? formSegmento({ alvo }, { acao: '/admin/massa-wa', rotuloBotao: 'Criar rascunho' })
        : formEscolherAlvo();
      const conteudoSeg = `
        <p><a class="btn btn--ghost" href="/admin/massa-wa">← Voltar</a></p>
        <h1>Nova campanha de disparo em massa</h1>
        ${seletorFonte('segmento')}
        ${flash(req)}
        <p style="color:var(--cinza);font-size:.85rem;">Convida para a vaga-alvo quem se candidatou a <b>outras</b>
          vagas da mesma cidade e não está em processo em andamento. A base legada nunca entra.</p>
        ${corpo}`;
      return res.send(paginaAdmin({ titulo: 'Nova campanha', conteudo: conteudoSeg }));
    }
    const conteudo = `
      <p><a class="btn btn--ghost" href="/admin/massa-wa">← Voltar</a></p>
      <h1>Nova campanha de disparo em massa</h1>
      ${seletorFonte('vagas_abertas')}
      ${flash(req)}
      ${formCampanha({}, { acao: '/admin/massa-wa', rotuloBotao: 'Criar rascunho' })}`;
    res.send(paginaAdmin({ titulo: 'Nova campanha', conteudo }));
  });

  router.post('/', (req, res) => {
    if ((req.body || {}).fonte === 'segmento') {
      const lido = lerSegmentoDoCorpo(req.body, { vagaAlvoId: Number(req.body.vaga_alvo_id) || null });
      const v = validarSegmento(lido);
      if (v.erro) {
        return res.redirect(`/admin/massa-wa/nova?fonte=segmento${lido.alvo ? `&vaga_alvo=${lido.alvo.id}` : ''}&erro=${v.erro}`);
      }
      const idSeg = db.criarCampanhaMassaWa({
        nome: lido.nome,
        // job_id = a vaga-alvo: e a vaga que a mensagem divulga, a que a lista mostra e a que o
        // FK protege de ser apagada.
        jobId: lido.alvo.id,
        textoBase: variacoesLib.TEXTO_BASE_CONVITE,
        criterios: v.criterios,
        cadencia: lido.cadencia,
      });
      db.salvarVariacoesMassaWa(idSeg, [...variacoesLib.VARIACOES_SEED_CONVITE]);
      return res.redirect(`/admin/massa-wa/${idSeg}?ok=criada`);
    }
    const d = lerCampanhaDoCorpo(req.body || {});
    if (!d.nome) return res.redirect('/admin/massa-wa/nova?erro=nome');
    if (!d.statusList.length) return res.redirect('/admin/massa-wa/nova?erro=status');
    if (cadenciaAbaixoDoPiso(d.cadencia)) return res.redirect('/admin/massa-wa/nova?erro=cadencia_piso');

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
      r = publico.montarPublicoDaCampanha(campanha);
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
          Recalculado agora. As quatro primeiras linhas contam <b>candidaturas</b> e chegam em
          <b>Pessoas</b>; dali para baixo os números são pessoas e se subtraem em sequência.</p>
        <dl class="rel-id">
          ${linha('Candidaturas em vagas abertas', f.candidaturas)}
          ${linha('— fora por status do recrutador', f.candidaturasExcluidasStatus,
            Object.entries(f.porStatusExcluido).filter(([, n]) => n).map(([k, n]) => `${ROTULO_STATUS_RECRUTADOR[k] || k}: ${n}`).join(' · '))}
          ${linha('— fora por telefone inutilizável', f.candidaturasSemTelefoneUtil, 'não sobrevive à normalização (DDI duplicado, dado corrompido)')}
          ${linha('— duplicadas (mesma pessoa)', f.candidaturasDuplicadas, 'colapsadas pela chave canônica: mesmo número com e sem o 9')}
          ${linha('Pessoas', f.pessoas)}
          ${linha('— fora por opt-out', f.pessoasOptoutCampanha + f.pessoasOptoutAntigo)}
          ${linha('— já receberam disparo em massa', f.pessoasJaReceberam, textoPorCampanha(f.jaReceberamPorCampanha))}
          ${linha('PÚBLICO FINAL', f.total)}
        </dl>
        <p style="color:var(--cinza);font-size:.8rem;margin:.6rem 0 0;">
          “Já receberam” é quem tem mensagem <b>enviada</b> em qualquer campanha de disparo em massa
          (“Sem destino” não conta: a mensagem nunca chegou). É o mesmo corte da opção
          “Excluir quem já recebeu”, marcada por padrão ao materializar; desmarcada, essas
          ${fmtInt(f.pessoasJaReceberam)} pessoa(s) entram na fila.</p>
        <p style="color:var(--cinza);font-size:.8rem;margin:.6rem 0 0;">
          Quem não tem WhatsApp ativo <b>não é descontado aqui</b>: essa checagem acontece no envio,
          no lote que está saindo — consultar milhares de números de uma vez é, por si, um sinal de
          conta suspeita. Esses casos aparecem na fila como “Sem WhatsApp”.</p>
      </section>`;
  }

  // { 3: 50, 4: 12 } -> "camp. 3: 50 · camp. 4: 12"
  function textoPorCampanha(porCampanha) {
    return Object.entries(porCampanha || {})
      .sort(([a], [b]) => Number(a) - Number(b))
      .map(([c, n]) => `camp. ${c}: ${n}`)
      .join(' · ');
  }

  // Previa do CONVITE (segmento): vaga-alvo, cidade e link da vaga com a UTM desta campanha.
  function previaConvite(campanha, texto) {
    const alvo = campanha.job_id ? db.obterVaga(campanha.job_id) : null;
    if (!alvo || !alvo.ativo) {
      return '<p class="aviso-alerta">Sem prévia: a vaga-alvo não está aberta. Nenhum destinatário recebe convite para vaga fechada.</p>';
    }
    const ctx = variacoesLib.montarContextoConvite({
      nome: 'Maria Souza',
      job: alvo,
      cidade: criteriosDaCampanha(campanha).cidade,
      linkVaga: variacoesLib.linkVagaPara(alvo.slug, campanha.id),
      linkDescadastro: `${config.baseUrl}/descadastro-whatsapp/(link-de-cada-destinatario)`,
      recrutador: db.obterConfig('recrutador_nome', ''),
    });
    const r = variacoesLib.resolverTexto(texto, ctx, { tipo: variacoesLib.TIPO_CONVITE_CANDIDATURA });
    return `<pre style="white-space:pre-wrap;background:var(--campo);border:1px solid var(--linha);border-radius:8px;padding:.8rem;font:inherit;">${negritoWhatsapp(escapeHtml(r.texto))}</pre>`;
  }

  function blocoVariacoes(campanha, req) {
    const lista = db.listarVariacoesMassaWa(campanha.id);
    const textos = Array.from({ length: variacoesLib.TOTAL_VARIACOES }, (_, i) => {
      const v = lista.find((x) => x.indice === i + 1);
      return v ? v.texto : '';
    });
    const tipo = tipoDaCampanha(campanha);
    const { tokens: tokensTipo, obrigatorios: obrigatoriosTipo } = variacoesLib.tokensDoTipo(tipo);
    const valid = variacoesLib.validarVariacoes(textos, { tipo });
    const problemas = frasesDosProblemas(valid.problemas, escapeHtml);

    const campos = textos
      .map(
        (t, i) => `
        <label class="campo"><span>Variação ${i + 1}</span>
          <textarea name="variacao_${i + 1}" rows="14">${escapeHtml(t)}</textarea></label>`,
      )
      .join('');

    const preview = ehSegmento(campanha) ? previaConvite(campanha, textos[0] || '') : (() => {
      // Preview com dados REAIS da vaga da campanha (ou a primeira aberta com data), para o
      // operador ver a mensagem como ela vai chegar — inclusive a data e o link de verdade.
      const vaga = campanha.job_id
        ? db.obterVaga(campanha.job_id)
        : db.listarVagas().filter((v) => v.ativo).find((v) => temEntrevistaGrupoFutura(v));
      const proxima = vaga ? proximaEntrevistaGrupo(vaga) : null;
      if (!proxima) {
        return `<p class="aviso-alerta">Sem prévia da mensagem: ${vaga ? 'esta vaga' : 'nenhuma vaga aberta'}
          não tem entrevista em grupo futura com link. Cadastre o link de confirmação (Calendly) e as datas na vaga —
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
          Toda variação precisa ter ${obrigatoriosTipo.map((t) => `<code>{${t}}</code>`).join(' ')}
          (o link de descadastro de cada destinatário). Tokens: ${tokensTipo.map((t) => `<code>{${t}}</code>`).join(' ')}.</p>

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
          ${ehSegmento(campanha) ? `<form method="POST" action="/admin/massa-wa/${campanha.id}/materializar"
              data-confirm="Congelar o público do segmento na fila? Vale o funil e a conferência nominal de agora."
              data-confirm-titulo="Materializar?" data-confirm-texto="Materializar">
            <p style="font-size:.85rem;margin:0 0 .6rem;">O teto, quem já recebeu e as desmarcadas vêm do segmento
              (prévia abaixo). Confira a <a href="/admin/massa-wa/${campanha.id}/conferencia">lista nominal</a> antes.</p>
            <button type="submit" class="btn">Materializar público</button>
          </form>` : `<form method="POST" action="/admin/massa-wa/${campanha.id}/materializar">
            <label class="campo" style="max-width:16rem;"><span>Máximo de destinatários (opcional)</span>
              <input type="number" min="1" name="max_destinatarios" placeholder="todos"></label>
            <label class="campo-check">
              <input type="checkbox" name="excluir_ja_receberam" value="1" checked>
              <span style="color:var(--preto);text-transform:none;">
                Excluir quem já recebeu disparo em massa (qualquer campanha)</span>
            </label>
            <button type="submit" class="btn">Materializar público</button>
          </form>`}
          <p style="color:var(--cinza);font-size:.8rem;margin:.4rem 0 0;">
            Congela quem vai receber. Depois disso, mudar os filtros não muda mais a fila.</p>
        </section>`;
    }

    const dist = db.distribuicaoVariacoesMassaWa(campanha.id);
    const enviadas = resumo.enviado || 0;
    const linhas = Object.entries(resumo)
      .map(([s, n]) => `<div><dt>${escapeHtml(s === 'cancelado' && ehSegmento(campanha)
        ? 'Cancelado (campanha excluída, vaga-alvo fechada ou já candidato)'
        : ROTULO_ENVIO[s] || s)}</dt><dd>${fmtInt(n)}</dd></div>`)
      .join('');

    const distHtml = dist.length
      ? `<p style="color:var(--cinza);font-size:.85rem;margin:.6rem 0 0;">Distribuição por variação:
          ${dist.map((d) => `#${d.variacao_indice ?? '—'}: ${fmtInt(d.n)}`).join(' · ')}</p>`
      : '';

    return `
      <section class="rel-sec">
        <h2>Fila e acompanhamento</h2>
        ${linhaOrigemDaFila(campanha)}
        <dl class="rel-id">
          ${linhas}
          <div><dt>Total na fila</dt><dd>${fmtInt(total)}</dd></div>
          ${campanha.proximo_envio_em ? `<div><dt>Próximo lote a partir de</dt><dd>${escapeHtml(formatarDataHora(campanha.proximo_envio_em))} (UTC)</dd></div>` : ''}
        </dl>
        ${blocoCronograma(campanha, resumo.pendente || 0)}
        ${distHtml}
        ${enviadas && !dist.length ? '<p class="aviso-alerta">Há mensagens enviadas sem variação registrada — verifique o log.</p>' : ''}
      </section>`;
  }

  const NOME_DIA = { 1: 'segunda', 2: 'terça', 3: 'quarta', 4: 'quinta', 5: 'sexta', 6: 'sábado', 7: 'domingo' };

  // Cronograma PREVISTO dos pendentes: quantos saem hoje e em cada dia seguinte, pela mesma regra do
  // worker (teto diario, fim da janela, dias da semana, dia civil de Brasilia). So leitura — ver
  // projetarCronograma em lib/cadenciaMassaWa.
  function blocoCronograma(campanha, pendentes) {
    if (!pendentes || ['concluida', 'cancelada', 'excluida'].includes(campanha.status)) return '';
    const agora = new Date();
    const enviadosHoje = db.contarEnviosMassaWaDesde(campanha.id, paraTextoSqlUtc(inicioDoDiaBrasiliaUtc(agora)));
    const prev = cadencia.projetarCronograma({ pendentes, enviadosHoje, agora, cadencia: cadencia.resolverCadencia(campanha) });
    const dd = (n) => String(n).padStart(2, '0');
    const itens = prev.dias.map((d) => {
      const [, m, dia] = d.data.split('-');
      return `<li>${NOME_DIA[d.diaSemanaIso]}, ${dd(dia)}/${dd(m)} → <b>${fmtInt(d.quantidade)}</b></li>`;
    }).join('');
    return `
        <p style="font-size:.88rem;margin:.8rem 0 .3rem;">
          Hoje na fila: <b>${fmtInt(prev.hoje)}</b> · Restante agendado para os próximos dias: <b>${fmtInt(prev.restante)}</b></p>
        <ul style="font-size:.85rem;margin:0 0 .3rem;padding-left:1.2rem;">${itens}</ul>
        ${prev.completo ? '' : '<p class="aviso-alerta">Com este teto e estes dias, a fila não termina — revise a cadência.</p>'}
        <p style="color:var(--cinza);font-size:.8rem;margin:0;">
          Previsão pelo teto de ${fmtInt(cadencia.resolverCadencia(campanha).tetoDiario)}/dia, a janela e os dias
          da campanha (horário de Brasília). Não muda o envio${campanha.status === 'ativa' ? '' : ', e só vale com a campanha ativa'};
          pausas, falhas e números sem WhatsApp mudam a conta.</p>`;
  }

  // "Criada em 01/10 11:20: 74 do público − 62 já receberam − 0 pelo limite = 12 na fila", mais uma
  // linha por reconciliacao. Campanha materializada antes deste registro existir nao tem o dado, e
  // a linha simplesmente nao aparece — inventar a conta a partir do publico de HOJE seria pior.
  function linhaOrigemDaFila(campanha) {
    const c = criteriosDaCampanha(campanha);
    const m = c.materializacao;
    const partes = [];
    if (m && m.fonte === segLib.FONTE_SEGMENTO && Number.isFinite(m.naFila)) {
      partes.push(linhaOrigemSegmento(m));
    } else if (m && Number.isFinite(m.publico) && Number.isFinite(m.naFila)) {
      const porCampanha = textoPorCampanha(m.jaReceberamPorCampanha);
      partes.push(`Criada em ${escapeHtml(diaHoraBrasilia(m.em))}: <b>${fmtInt(m.publico)}</b> do público`
        + ` − <b>${fmtInt(m.jaReceberam || 0)}</b> já receberam${porCampanha ? ` (${escapeHtml(porCampanha)})` : ''}`
        + ` − <b>${fmtInt(m.foraPorLimite || 0)}</b> pelo limite`
        + ` = <b>${fmtInt(m.naFila)}</b> na fila.`
        + (m.duplicadas ? ` <small>(${fmtInt(m.duplicadas)} candidatura(s) duplicada(s) já contadas como uma pessoa só.)</small>` : '')
        + (m.excluirJaReceberam === false ? ' <small>(“Excluir quem já recebeu” estava desmarcado.)</small>' : ''));
    }
    for (const rc of Array.isArray(c.reconciliacoes) ? c.reconciliacoes : []) {
      partes.push(`+ <b>${fmtInt(rc.adicionados || 0)}</b> adicionado(s) em ${escapeHtml(diaHoraBrasilia(rc.em))}`
        + ` por reconciliação${rc.motivo ? `: ${escapeHtml(rc.motivo)}` : ''}.`);
    }
    if (!partes.length) return '';
    return `<p style="font-size:.88rem;margin:0 0 .8rem;">${partes.join('<br>')}</p>`;
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

  function formSegmentoDaCampanha(campanha) {
    const alvo = campanha.job_id ? db.obterVaga(campanha.job_id) : null;
    if (!alvo) return '<p class="aviso-alerta">A vaga-alvo desta campanha não existe mais.</p>';
    return formSegmento(
      { campanha, alvo, criterios: criteriosDaCampanha(campanha) },
      { acao: `/admin/massa-wa/${campanha.id}`, rotuloBotao: 'Salvar configuração' },
    );
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
      ${blocoEstado(campanha)}
      ${blocoAcoes(campanha)}
      ${blocoFila(campanha)}
      ${ehSegmento(campanha) ? blocoPreviaSegmento(campanha) : blocoPrevia(campanha)}
      ${blocoVariacoes(campanha, req)}
      ${blocoTeste(campanha)}
      <section class="rel-sec">
        <h2>Configuração</h2>
        ${ehSegmento(campanha)
          ? formSegmentoDaCampanha(campanha)
          : formCampanha(campanha, { acao: `/admin/massa-wa/${campanha.id}`, rotuloBotao: 'Salvar configuração' })}
      </section>`;

    return res.send(paginaAdmin({ titulo: campanha.nome, conteudo }));
  });

  router.post('/:id', (req, res) => {
    const id = Number(req.params.id);
    const campanha = db.obterCampanhaMassaWa(id);
    if (!campanha) return res.status(404).send(paginaAdmin({ titulo: 'Campanha', conteudo: '<h1>Campanha não encontrada.</h1>' }));

    if (ehSegmento(campanha)) {
      const lido = lerSegmentoDoCorpo(req.body || {}, { vagaAlvoId: campanha.job_id });
      const v = validarSegmento(lido);
      if (v.erro) return res.redirect(`/admin/massa-wa/${id}?erro=${v.erro}`);
      const atual = criteriosDaCampanha(campanha);
      db.atualizarCampanhaMassaWa(id, {
        nome: lido.nome,
        jobId: campanha.job_id,
        textoBase: campanha.texto_base,
        // Mescla: o registro da materializacao e as desmarcadas da conferencia moram no mesmo JSON.
        criterios: { ...atual, ...v.criterios, desmarcadas: atual.desmarcadas || [] },
        totalEstimado: campanha.total_estimado,
        cadencia: lido.cadencia,
      });
      return res.redirect(`/admin/massa-wa/${id}?ok=salva`);
    }
    const d = lerCampanhaDoCorpo(req.body || {});
    if (!d.nome) return res.redirect(`/admin/massa-wa/${id}?erro=nome`);
    if (!d.statusList.length) return res.redirect(`/admin/massa-wa/${id}?erro=status`);
    if (cadenciaAbaixoDoPiso(d.cadencia)) return res.redirect(`/admin/massa-wa/${id}?erro=cadencia_piso`);

    db.atualizarCampanhaMassaWa(id, {
      nome: d.nome,
      jobId: d.jobId,
      textoBase: d.textoBase,
      // Mescla, e nao substitui: o registro da materializacao mora no mesmo JSON.
      criterios: { ...criteriosDaCampanha(campanha), statusList: d.statusList },
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
    const campanhaSug = db.obterCampanhaMassaWa(id);
    if (!campanhaSug) return res.status(404).send(paginaAdmin({ titulo: 'Campanha', conteudo: '<h1>Campanha não encontrada.</h1>' }));

    if (String(process.env.MASSA_WA_LLM_ATIVO || '').toLowerCase() === 'true') {
      // Mesmo com a chave ligada, este caminho ainda nao existe: a integracao sera escrita quando
      // autorizada. Falhar dizendo isso e melhor que fingir.
      console.warn('[massa-wa] MASSA_WA_LLM_ATIVO ligado, mas a geracao por IA ainda nao foi implementada.');
    }
    db.salvarVariacoesMassaWa(id, [...variacoesLib.sementesDoTipo(tipoDaCampanha(campanhaSug))]);
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
    if (!variacoesLib.validarVariacoes(lista.map((v) => v.texto), { tipo: tipoDaCampanha(campanha) }).ok) {
      return res.redirect(`/admin/massa-wa/${id}?erro=variacoes_invalidas`);
    }

    // ── SEGMENTO: teto e "ja recebeu" vem dos criterios; o registro guarda o funil inteiro ──
    if (ehSegmento(campanha)) {
      let rs;
      try {
        rs = publico.montarPublicoDaCampanha(campanha);
      } catch (err) {
        console.warn(`[massa-wa] campanha ${id}: publico do segmento recusado: ${err.message}`);
        return res.redirect(`/admin/massa-wa/${id}?erro=seg_publico`);
      }
      if (!rs.itens.length) return res.redirect(`/admin/massa-wa/${id}?erro=sem_publico`);
      const nSeg = db.materializarCampanhaMassaWa(id, rs.itens);
      db.atualizarCampanhaMassaWa(id, {
        nome: campanha.nome,
        jobId: campanha.job_id,
        textoBase: campanha.texto_base,
        criterios: {
          ...criteriosDaCampanha(campanha),
          materializacao: { em: paraTextoSqlUtc(new Date()), fonte: segLib.FONTE_SEGMENTO, funil: rs.funil, naFila: nSeg },
        },
        totalEstimado: nSeg,
        cadencia: cadenciaCrua(campanha),
      });
      console.log(`[massa-wa] campanha ${id} (segmento) materializada com ${nSeg} destinatario(s).`);
      return res.redirect(`/admin/massa-wa/${id}?ok=materializada`);
    }

    // ── RECORTES OPCIONAIS (teste de cadencia com poucas pessoas, 2026-10-01) ──
    // Excluir quem ja recebeu e limite de destinatarios sao aplicados pelo MESMO motor de publico
    // que a previa usa (e nao aqui) — ver "JA RECEBEU E LIMITE MORAM AQUI" em
    // lib/publicoMassaWhatsapp. Os dois antes de gravar: a fila nasce do tamanho certo.
    const b = req.body || {};
    const excluirJaReceberam = b.excluir_ja_receberam === '1' || b.excluir_ja_receberam === 'on';
    const max = Number(String(b.max_destinatarios || '').trim());
    const maxDestinatarios = Number.isInteger(max) && max > 0 ? max : null;
    let r;
    try {
      r = publico.montarPublicoDaCampanha(campanha, { excluirJaReceberam, maxDestinatarios });
    } catch {
      return res.redirect(`/admin/massa-wa/${id}?erro=status`);
    }
    const itens = r.itens;
    if (!itens.length) return res.redirect(`/admin/massa-wa/${id}?erro=sem_publico`);

    const n = db.materializarCampanhaMassaWa(id, itens);
    db.atualizarCampanhaMassaWa(id, {
      nome: campanha.nome,
      jobId: campanha.job_id,
      textoBase: campanha.texto_base,
      criterios: {
        ...criteriosDaCampanha(campanha),
        statusList: statusDaCampanha(campanha),
        // O porque do tamanho da fila, congelado junto com ela. Sem isto, "por que a fila tem 12
        // se a previa diz 74?" so se responde abrindo o banco (campanha 6, 2026-10-01).
        materializacao: {
          em: paraTextoSqlUtc(new Date()),
          publico: r.funil.pessoas - r.funil.pessoasOptoutCampanha - r.funil.pessoasOptoutAntigo,
          excluirJaReceberam,
          jaReceberam: excluirJaReceberam ? r.funil.pessoasJaReceberam : 0,
          jaReceberamPorCampanha: excluirJaReceberam ? r.funil.jaReceberamPorCampanha : {},
          limite: maxDestinatarios,
          foraPorLimite: r.funil.pessoasForaPorLimite,
          duplicadas: r.funil.candidaturasDuplicadas,
          naFila: n,
        },
      },
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
      if (!variacoesLib.validarVariacoes(lista.map((v) => v.texto), { tipo: tipoDaCampanha(campanha) }).ok) {
        return res.redirect(`/admin/massa-wa/${id}?erro=variacoes_invalidas`);
      }
    }

    db.definirStatusCampanhaMassaWa(id, destino, { motivo: destino === 'pausada' ? 'pausada no painel' : null });
    console.log(`[massa-wa] campanha ${id}: status -> ${destino} (painel).`);
    const okPor = { ativa: 'ativada', pausada: 'pausada', cancelada: 'cancelada' };
    return res.redirect(`/admin/massa-wa/${id}?ok=${okPor[destino]}`);
  });

  // ══════════════════ EXCLUIR ══════════════════
  //
  // Soft delete: ver excluirCampanhaMassaWa em db/sqlite.js para por que nada e apagado.
  router.post('/:id/excluir', (req, res) => {
    const id = Number(req.params.id);
    const campanha = db.obterCampanhaMassaWa(id);
    if (!campanha) return res.status(404).send(paginaAdmin({ titulo: 'Campanha', conteudo: '<h1>Campanha não encontrada.</h1>' }));
    const canceladas = db.excluirCampanhaMassaWa(id);
    console.log(`[massa-wa] campanha ${id} excluida no painel (era ${campanha.status}); ${canceladas} envio(s) pendente(s) cancelado(s).`);
    return res.redirect('/admin/massa-wa?ok=excluida');
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
    if (!variacoesLib.validarVariacoes(lista.map((v) => v.texto), { tipo: tipoDaCampanha(campanha) }).ok) {
      return res.redirect(`/admin/massa-wa/${id}?erro=variacoes_invalidas`);
    }

    // Segmento: a mensagem e o CONVITE para a vaga-alvo (sem reuniao a exigir), como no worker.
    const seg = ehSegmento(campanha);
    const vaga = campanha.job_id
      ? db.obterVaga(campanha.job_id)
      : db.listarVagas().filter((v) => v.ativo).find((v) => temEntrevistaGrupoFutura(v));
    if (seg && !(vaga && vaga.ativo)) return res.redirect(`/admin/massa-wa/${id}?erro=seg_vaga_fechada`);
    const proxima = !seg && vaga ? proximaEntrevistaGrupo(vaga) : null;
    if (!seg && !proxima) return res.redirect(`/admin/massa-wa/${id}?erro=sem_reuniao_teste`);

    const escolhida = variacoesLib.sortearVariacao(lista, campanha.ultima_variacao);
    // Link REAL do telefone de teste: clicar nele registra o opt-out desse numero.
    const ctx = seg
      ? variacoesLib.montarContextoConvite({
        nome: 'teste',
        job: vaga,
        cidade: criteriosDaCampanha(campanha).cidade,
        linkVaga: variacoesLib.linkVagaPara(vaga.slug, campanha.id),
        linkDescadastro: variacoesLib.linkDescadastroPara(telefone),
        recrutador: db.obterConfig('recrutador_nome', ''),
      })
      : variacoesLib.montarContexto({
        nome: 'teste',
        job: vaga,
        proxima,
        linkDescadastro: variacoesLib.linkDescadastroPara(telefone),
        recrutador: db.obterConfig('recrutador_nome', ''),
      });
    const { texto, faltando } = variacoesLib.resolverTexto(escolhida.texto, ctx, { tipo: tipoDaCampanha(campanha) });
    if (faltando.length) return res.redirect(`/admin/massa-wa/${id}?erro=variacoes_invalidas`);

    if (worker.modoMock()) {
      console.log(`[massa-wa] (mock) TESTE para ${telefone} — variacao ${escolhida.indice}:\n${texto}`);
      return res.redirect(`/admin/massa-wa/${id}?ok=teste_mock`);
    }

    try {
      // Mesma regra do worker: so sai para numero CONFIRMADO, com o 9 ou sem ele (ver a decisao 1
      // em whatsapp/massaOutbox). Sem isto o teste "da certo" e a mensagem nao chega.
      const semNono = varianteSemNono(telefone);
      const mapa = await conexao.onWhatsAppLote(semNono ? [telefone, semNono] : [telefone]);
      const destino = mapa.get(telefone) === true
        ? telefone
        : semNono && mapa.get(semNono) === true ? semNono : null;
      if (!destino) return res.redirect(`/admin/massa-wa/${id}?erro=teste_nao_confirmado`);
      await conexao.enviarTexto(destino, texto);
      console.log(`[massa-wa] TESTE enviado para ${destino} (variacao ${escolhida.indice}).`);
      return res.redirect(`/admin/massa-wa/${id}?ok=teste_enviado`);
    } catch (err) {
      console.error(`[massa-wa] falha no envio de teste: ${err.message}`);
      return res.redirect(`/admin/massa-wa/${id}?erro=envio_teste`);
    }
  });

  return router;
}

module.exports = { criarRouterMassaWa, ROTULO_STATUS, ROTULO_ENVIO, frasesDosProblemas, negritoWhatsapp };
