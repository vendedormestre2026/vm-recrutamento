'use strict';

// Implementacao concreta da camada de dados usando better-sqlite3.
// TODO o SQL especifico de SQLite vive aqui. As rotas NUNCA importam este arquivo
// diretamente: elas usam src/db/index.js (a interface de negocio agnostica).
//
// Para migrar a Postgres no futuro: crie src/db/postgres.js implementando o mesmo
// conjunto de funcoes exportadas aqui e troque o require em src/db/index.js.

const fs = require('node:fs');
const path = require('node:path');
const Database = require('better-sqlite3');
const { config } = require('../config');

let _db = null;

// Conexao singleton (SQLite tem um escritor por vez; mantemos uma instancia).
function getDb() {
  if (_db) return _db;

  // Garante que a pasta do arquivo exista (ex.: ./data ou /data).
  const dir = path.dirname(config.caminhoBanco);
  fs.mkdirSync(dir, { recursive: true });

  _db = new Database(config.caminhoBanco);
  _db.pragma('journal_mode = WAL');   // melhor concorrencia leitura/escrita
  _db.pragma('foreign_keys = ON');
  return _db;
}

// Executa o schema.sql (idempotente). Usado por migrate.js.
function aplicarSchema() {
  const sql = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
  getDb().exec(sql);
}

// ── Helpers de (de)serializacao de colunas JSON ──
function lerJson(valor, padrao) {
  if (valor == null || valor === '') return padrao;
  try {
    return JSON.parse(valor);
  } catch {
    return padrao;
  }
}

function jobDeLinha(linha) {
  if (!linha) return null;
  return {
    ...linha,
    // Arrays estruturados (uma string por item). Campos de texto livre
    // (potencial_ganhos, endereco, modalidade, regime, horario) ficam como vieram
    // na linha (...linha) — sem parse.
    skills: lerJson(linha.skills, []),
    beneficios: lerJson(linha.beneficios, []),
    atividades: lerJson(linha.atividades, []),
    requisitos: lerJson(linha.requisitos, []),
    requisitos_obrigatorios: lerJson(linha.requisitos_obrigatorios, []),
    secoes_extras: lerJson(linha.secoes_extras, []),
    ativo: Boolean(linha.ativo),
  };
}

function roteiroDeLinha(linha) {
  if (!linha) return null;
  return { ...linha, estrutura: lerJson(linha.estrutura, {}) };
}

function aplicacaoDeLinha(linha) {
  if (!linha) return null;
  return { ...linha, campos_extras: lerJson(linha.campos_extras, {}) };
}

// ──────────────────────────────────────────────────────────────
// Funcoes de negocio (a interface que index.js reexporta)
// ──────────────────────────────────────────────────────────────

// Vagas
function obterVaga(id) {
  const linha = getDb().prepare('SELECT * FROM jobs WHERE id = ?').get(id);
  return jobDeLinha(linha);
}

function obterVagaPorSlug(slug) {
  const linha = getDb().prepare('SELECT * FROM jobs WHERE slug = ?').get(slug);
  return jobDeLinha(linha);
}

function obterVagaAtiva() {
  const linha = getDb()
    .prepare('SELECT * FROM jobs WHERE ativo = 1 ORDER BY criado_em DESC LIMIT 1')
    .get();
  return jobDeLinha(linha);
}

function listarVagas() {
  return getDb().prepare('SELECT * FROM jobs ORDER BY criado_em DESC').all().map(jobDeLinha);
}

function criarVaga(vaga) {
  const stmt = getDb().prepare(`
    INSERT INTO jobs
      (slug, titulo, perfil, faixa_pagamento, potencial_ganhos, skills,
       beneficios, atividades, requisitos, requisitos_obrigatorios, secoes_extras,
       endereco, modalidade, regime, horario,
       descricao, sobre_empresa, cultura_empresa, roteiro_id, ativo, entrevista_ativa)
    VALUES
      (@slug, @titulo, @perfil, @faixa_pagamento, @potencial_ganhos, @skills,
       @beneficios, @atividades, @requisitos, @requisitos_obrigatorios, @secoes_extras,
       @endereco, @modalidade, @regime, @horario,
       @descricao, @sobre_empresa, @cultura_empresa, @roteiro_id, @ativo, @entrevista_ativa)
  `);
  const info = stmt.run({
    slug: vaga.slug,
    titulo: vaga.titulo,
    perfil: vaga.perfil,
    faixa_pagamento: vaga.faixa_pagamento || null,
    potencial_ganhos: vaga.potencial_ganhos || null,
    endereco: vaga.endereco || null,
    modalidade: vaga.modalidade || null,
    regime: vaga.regime || null,
    horario: vaga.horario || null,
    skills: JSON.stringify(vaga.skills || []),
    beneficios: JSON.stringify(vaga.beneficios || []),
    atividades: JSON.stringify(vaga.atividades || []),
    requisitos: JSON.stringify(vaga.requisitos || []),
    requisitos_obrigatorios: JSON.stringify(vaga.requisitos_obrigatorios || []),
    secoes_extras: JSON.stringify(vaga.secoes_extras || []),
    descricao: vaga.descricao || null,
    sobre_empresa: vaga.sobre_empresa || null,
    cultura_empresa: vaga.cultura_empresa || null,
    roteiro_id: vaga.roteiro_id || null,
    ativo: vaga.ativo === false ? 0 : 1,
    // Default 1 (Completo). So vira 0 (Simples) quando explicitamente desmarcado.
    entrevista_ativa: vaga.entrevista_ativa === false ? 0 : 1,
  });
  return Number(info.lastInsertRowid);
}

// Atualiza os campos editaveis da vaga pelo painel. Inclui os campos ricos da nova
// pagina de vaga (potencial_ganhos, skills, beneficios, atividades, requisitos,
// secoes_extras). NAO mexe em slug/perfil/roteiro_id (fora do escopo).
function atualizarVaga(id, campos) {
  getDb()
    .prepare(
      `UPDATE jobs SET
         titulo           = @titulo,
         faixa_pagamento  = @faixa_pagamento,
         potencial_ganhos = @potencial_ganhos,
         skills           = @skills,
         beneficios       = @beneficios,
         atividades       = @atividades,
         requisitos       = @requisitos,
         requisitos_obrigatorios = @requisitos_obrigatorios,
         secoes_extras    = @secoes_extras,
         endereco         = @endereco,
         modalidade       = @modalidade,
         regime           = @regime,
         horario          = @horario,
         descricao        = @descricao,
         sobre_empresa    = @sobre_empresa,
         cultura_empresa  = @cultura_empresa,
         ativo            = @ativo,
         entrevista_ativa = @entrevista_ativa
       WHERE id = @id`,
    )
    .run({
      id,
      titulo: campos.titulo,
      faixa_pagamento: campos.faixa_pagamento || null,
      potencial_ganhos: campos.potencial_ganhos || null,
      endereco: campos.endereco || null,
      modalidade: campos.modalidade || null,
      regime: campos.regime || null,
      horario: campos.horario || null,
      skills: JSON.stringify(campos.skills || []),
      beneficios: JSON.stringify(campos.beneficios || []),
      atividades: JSON.stringify(campos.atividades || []),
      requisitos: JSON.stringify(campos.requisitos || []),
      requisitos_obrigatorios: JSON.stringify(campos.requisitos_obrigatorios || []),
      secoes_extras: JSON.stringify(campos.secoes_extras || []),
      descricao: campos.descricao || null,
      sobre_empresa: campos.sobre_empresa || null,
      cultura_empresa: campos.cultura_empresa || null,
      ativo: campos.ativo === false ? 0 : 1,
      entrevista_ativa: campos.entrevista_ativa === false ? 0 : 1,
    });
}

// Encerra (ativo=0) ou reativa (ativo=1) uma vaga, sem tocar nos demais campos.
// Usado pelos botoes Encerrar/Reativar da listagem de vagas (Fase 5).
function definirVagaAtiva(id, ativo) {
  const info = getDb()
    .prepare('UPDATE jobs SET ativo = ? WHERE id = ?')
    .run(ativo ? 1 : 0, id);
  return info.changes;
}

// Roteiros
function obterRoteiro(id) {
  return roteiroDeLinha(getDb().prepare('SELECT * FROM roteiros WHERE id = ?').get(id));
}

function obterRoteiroPorNome(nome) {
  return roteiroDeLinha(getDb().prepare('SELECT * FROM roteiros WHERE nome = ?').get(nome));
}

// Roteiro de um perfil ('SDR'|'CLOSER'). Quando ha mais de um, prioriza a maior versao
// (e, empatando, o id mais recente). Usado pela tela de edicao do roteiro no painel.
function obterRoteiroPorPerfil(perfil) {
  return roteiroDeLinha(
    getDb()
      .prepare('SELECT * FROM roteiros WHERE perfil = ? ORDER BY versao DESC, id DESC LIMIT 1')
      .get(perfil),
  );
}

// Atualiza APENAS o campo estrutura (JSON) de um roteiro pelo id. Recebe a estrutura ja
// como objeto e serializa aqui (espelha o padrao de criarRoteiro). NAO mexe em
// nome/perfil/versao. Retorna o numero de linhas afetadas (0 se o id nao existir).
function atualizarEstruturaRoteiro(id, estrutura) {
  const info = getDb()
    .prepare("UPDATE roteiros SET estrutura = ?, atualizado_em = datetime('now') WHERE id = ?")
    .run(JSON.stringify(estrutura || {}), id);
  return info.changes;
}

function criarRoteiro(roteiro) {
  const info = getDb().prepare(`
    INSERT INTO roteiros (nome, perfil, versao, estrutura)
    VALUES (@nome, @perfil, @versao, @estrutura)
  `).run({
    nome: roteiro.nome,
    perfil: roteiro.perfil,
    versao: roteiro.versao || 1,
    estrutura: JSON.stringify(roteiro.estrutura || {}),
  });
  return Number(info.lastInsertRowid);
}

// Aplicacoes
// Cria a aplicacao. consent_at recebe datetime('now') direto no INSERT: a rota so
// chega aqui apos validar o checkbox de consentimento (LGPD), entao criar a linha ja
// significa que o candidato consentiu — o momento da criacao e o momento do aceite.
function criarAplicacao(aplicacao) {
  const info = getDb().prepare(`
    INSERT INTO applications
      (job_id, nome, sobrenome, email, telefone, linkedin_url,
       curriculo_path, curriculo_texto, campos_extras, token, status, consent_at)
    VALUES
      (@job_id, @nome, @sobrenome, @email, @telefone, @linkedin_url,
       @curriculo_path, @curriculo_texto, @campos_extras, @token, @status, datetime('now'))
  `).run({
    job_id: aplicacao.job_id,
    nome: aplicacao.nome || null,
    sobrenome: aplicacao.sobrenome || null,
    email: aplicacao.email || null,
    telefone: aplicacao.telefone || null,
    linkedin_url: aplicacao.linkedin_url || null,
    curriculo_path: aplicacao.curriculo_path || null,
    curriculo_texto: aplicacao.curriculo_texto || null,
    campos_extras: JSON.stringify(aplicacao.campos_extras || {}),
    token: aplicacao.token || null,
    status: aplicacao.status || 'aplicado',
  });
  return Number(info.lastInsertRowid);
}

function obterAplicacao(id) {
  return aplicacaoDeLinha(getDb().prepare('SELECT * FROM applications WHERE id = ?').get(id));
}

function obterAplicacaoPorToken(token) {
  return aplicacaoDeLinha(
    getDb().prepare('SELECT * FROM applications WHERE token = ?').get(token),
  );
}

function atualizarStatusAplicacao(id, status) {
  getDb().prepare('UPDATE applications SET status = ? WHERE id = ?').run(status, id);
}

// Status da IA (veredito automatico). Escrita incondicional: sobrescreve o valor
// atual. A guarda de transicao (nao regredir/nao pisar em terminal) fica na camada
// de negocio (entrevista.js/relatorio.js); esta funcao so faz o UPDATE.
function definirStatusIa(applicationId, novoStatus) {
  getDb()
    .prepare('UPDATE applications SET status_ia = ? WHERE id = ?')
    .run(novoStatus != null ? String(novoStatus) : null, applicationId);
}

// Escrita CONDICIONAL do status_ia: so grava se ainda estiver NULL. Usada para o
// estado inicial 'processando' — reentradas/idempotencia nao pisam num estado ja
// definido (ex.: um terminal ja gravado por uma finalizacao anterior).
function definirStatusIaSeVazio(applicationId, novoStatus) {
  getDb()
    .prepare('UPDATE applications SET status_ia = ? WHERE id = ? AND status_ia IS NULL')
    .run(novoStatus != null ? String(novoStatus) : null, applicationId);
}

// Leitura do status_ia (para os itens 4/5 consumirem depois). Devolve a string
// do status, ou null quando ausente/application inexistente.
function obterStatusIaPorApplication(applicationId) {
  const linha = getDb()
    .prepare('SELECT status_ia FROM applications WHERE id = ?')
    .get(applicationId);
  return linha ? linha.status_ia : null;
}

// Status do RECRUTADOR (decisao humana, Item 3). Enum validado no app (sem CHECK no
// banco, mesmo padrao de reports.recomendacao). Valor fora do enum -> null ("sem
// decisao"). Retorna o valor final gravado (para a rota confirmar o que persistiu).
const STATUS_RECRUTADOR_VALIDOS = ['aprovado', 'reprovado', 'em_analise'];
function definirStatusRecrutador(applicationId, valor) {
  const v = valor != null ? String(valor).trim().toLowerCase() : null;
  const final = STATUS_RECRUTADOR_VALIDOS.includes(v) ? v : null;
  getDb()
    .prepare('UPDATE applications SET status_recrutador = ? WHERE id = ?')
    .run(final, applicationId);
  return final;
}

// Edita SOMENTE os campos de contato do candidato. NUNCA toca em id/job_id/token/status/
// curriculo_path/timestamps. Vazio ('' apos trim) vira NULL. Tudo parametrizado (?).
function atualizarAplicacao(id, campos = {}) {
  const norm = (v) => {
    const s = v == null ? '' : String(v).trim();
    return s === '' ? null : s;
  };
  const info = getDb()
    .prepare(
      `UPDATE applications
          SET nome = ?, sobrenome = ?, email = ?, telefone = ?, linkedin_url = ?, cidade = ?
        WHERE id = ?`,
    )
    .run(
      norm(campos.nome),
      norm(campos.sobrenome),
      norm(campos.email),
      norm(campos.telefone),
      norm(campos.linkedin_url),
      norm(campos.cidade),
      id,
    );
  return info.changes;
}

// Soft-delete: arquiva o lead (deleted_at = agora) apenas se ainda estiver ativo.
// Retorna nº de linhas afetadas (0 se ja estava arquivado / id inexistente).
function arquivarAplicacao(id) {
  const info = getDb()
    .prepare("UPDATE applications SET deleted_at = datetime('now') WHERE id = ? AND deleted_at IS NULL")
    .run(id);
  return info.changes;
}

// Reversao do soft-delete: volta o lead para ativo (deleted_at = NULL).
function restaurarAplicacao(id) {
  const info = getDb()
    .prepare('UPDATE applications SET deleted_at = NULL WHERE id = ?')
    .run(id);
  return info.changes;
}

// Registra o consentimento de gravacao (LGPD) no momento em que o candidato avanca do
// teste de microfone. Idempotente: so grava se ainda nao houver aceite (preserva o
// 1o aceite mesmo que o candidato volte/recarregue). Retorna o nº de linhas afetadas.
function registrarConsentGravacao(id) {
  const info = getDb()
    .prepare(
      "UPDATE applications SET consent_gravacao_at = datetime('now') WHERE id = ? AND consent_gravacao_at IS NULL",
    )
    .run(id);
  return info.changes;
}

// Marca o momento do ultimo envio do e-mail de retomada ("continuar depois").
// Sobrescreve sempre (cada envio atualiza o timestamp); o controle de "nao reenviar
// em 30 min" e feito por quem chama, comparando enviado_retomada_em com agora.
function marcarRetomadaEnviada(id) {
  getDb()
    .prepare("UPDATE applications SET enviado_retomada_em = datetime('now') WHERE id = ?")
    .run(id);
}

// Entrevistas
function criarInterview(entrevista) {
  const info = getDb().prepare(`
    INSERT INTO interviews (application_id, perfil, roteiro_id, status)
    VALUES (@application_id, @perfil, @roteiro_id, @status)
  `).run({
    application_id: entrevista.application_id,
    perfil: entrevista.perfil,
    roteiro_id: entrevista.roteiro_id || null,
    status: entrevista.status || 'iniciada',
  });
  return Number(info.lastInsertRowid);
}

function obterInterview(id) {
  return getDb().prepare('SELECT * FROM interviews WHERE id = ?').get(id) || null;
}

// Entrevista ainda 'em andamento' (nao concluida) de uma application — base da
// retomada: se existir, recarregamos o estado em vez de criar uma nova.
function obterInterviewEmAndamentoPorAplicacao(applicationId) {
  return (
    getDb()
      .prepare(
        "SELECT * FROM interviews WHERE application_id = ? AND status != 'concluido' ORDER BY id DESC LIMIT 1",
      )
      .get(applicationId) || null
  );
}

// Ultima entrevista de uma application em QUALQUER status (para a tela de detalhe do
// candidato). Difere de obterInterviewEmAndamentoPorAplicacao, que exclui as concluidas.
function obterUltimaInterviewPorAplicacao(applicationId) {
  return (
    getDb()
      .prepare('SELECT * FROM interviews WHERE application_id = ? ORDER BY id DESC LIMIT 1')
      .get(applicationId) || null
  );
}

// Guarda o id da ultima resposta processada (idempotencia: retry com o mesmo id
// nao cria turnos duplicados).
function definirUltimoRespId(interviewId, respId) {
  getDb()
    .prepare('UPDATE interviews SET ultimo_resp_id = ? WHERE id = ?')
    .run(respId || null, interviewId);
}

// Item 7.5 - persiste o ponteiro de progresso (indice do bloco + trocas no bloco atual).
// Usado SO no modo real; o mock nunca escreve aqui (mantem avanco por contagem de turnos).
function atualizarProgressoInterview(interviewId, indice, trocas) {
  getDb()
    .prepare('UPDATE interviews SET progresso_indice = ?, progresso_trocas = ? WHERE id = ?')
    .run(Number(indice) || 0, Number(trocas) || 0, interviewId);
}

function finalizarInterview(id) {
  getDb()
    .prepare("UPDATE interviews SET status = 'concluido', finalizado_em = datetime('now') WHERE id = ?")
    .run(id);
}

// Grava o link da gravacao de video (Google Drive) na entrevista (Fase 5).
function definirVideoUrl(interviewId, url) {
  getDb()
    .prepare('UPDATE interviews SET video_url = ? WHERE id = ?')
    .run(url || null, interviewId);
}

// Turnos da conversa
function criarTurno(turno) {
  const info = getDb().prepare(`
    INSERT INTO interview_turns (interview_id, ordem, autor, texto, audio_path)
    VALUES (@interview_id, @ordem, @autor, @texto, @audio_path)
  `).run({
    interview_id: turno.interview_id,
    ordem: turno.ordem,
    autor: turno.autor,
    texto: turno.texto || null,
    audio_path: turno.audio_path || null,
  });
  return Number(info.lastInsertRowid);
}

// Lista os turnos da entrevista em ordem (para montar o historico do LLM).
function listarTurnos(interviewId) {
  return getDb()
    .prepare('SELECT autor, texto, ordem FROM interview_turns WHERE interview_id = ? ORDER BY ordem ASC')
    .all(interviewId);
}

// Conta turnos da entrevista (opcionalmente por autor).
function contarTurnos(interviewId, autor) {
  if (autor) {
    return getDb()
      .prepare('SELECT COUNT(*) AS n FROM interview_turns WHERE interview_id = ? AND autor = ?')
      .get(interviewId, autor).n;
  }
  return getDb()
    .prepare('SELECT COUNT(*) AS n FROM interview_turns WHERE interview_id = ?')
    .get(interviewId).n;
}

// ──────────────────────────────────────────────────────────────
// Relatorios (Fase 4)
// ──────────────────────────────────────────────────────────────
function reportDeLinha(linha) {
  if (!linha) return null;
  return {
    ...linha,
    pontuacoes: lerJson(linha.pontuacoes, []),
    destaque_pontos_fortes: lerJson(linha.destaque_pontos_fortes, []),
    destaque_atencao: lerJson(linha.destaque_atencao, []),
    requisitos: lerJson(linha.requisitos, []),
  };
}

function criarReport(report) {
  const info = getDb().prepare(`
    INSERT INTO reports
      (interview_id, token, status, resumo, pontuacoes, destaque_pontos_fortes, destaque_atencao, recomendacao, requisitos)
    VALUES
      (@interview_id, @token, @status, @resumo, @pontuacoes, @destaque_pontos_fortes, @destaque_atencao, @recomendacao, @requisitos)
  `).run({
    interview_id: report.interview_id,
    token: report.token,
    status: report.status || 'gerado',
    resumo: report.resumo || null,
    pontuacoes: report.pontuacoes != null ? JSON.stringify(report.pontuacoes) : null,
    destaque_pontos_fortes:
      report.destaque_pontos_fortes != null ? JSON.stringify(report.destaque_pontos_fortes) : null,
    destaque_atencao: report.destaque_atencao != null ? JSON.stringify(report.destaque_atencao) : null,
    recomendacao: report.recomendacao != null ? String(report.recomendacao) : null,
    requisitos: report.requisitos != null ? JSON.stringify(report.requisitos) : null,
  });
  return Number(info.lastInsertRowid);
}

// Atualiza o status do report; opcionalmente grava enviado_em/destinatario (so quando passados).
function atualizarStatusReport(id, status, extras = {}) {
  getDb()
    .prepare(
      `UPDATE reports
         SET status = ?,
             enviado_em   = COALESCE(?, enviado_em),
             destinatario = COALESCE(?, destinatario)
       WHERE id = ?`,
    )
    .run(status, extras.enviado_em || null, extras.destinatario || null, id);
}

function obterReportPorToken(token) {
  return reportDeLinha(getDb().prepare('SELECT * FROM reports WHERE token = ?').get(token));
}

// Idempotencia: report ja ENVIADO para esta entrevista (se existir, nao geramos de novo).
function obterReportEnviadoPorInterview(interviewId) {
  return reportDeLinha(
    getDb()
      .prepare(
        "SELECT * FROM reports WHERE interview_id = ? AND status = 'enviado' ORDER BY id DESC LIMIT 1",
      )
      .get(interviewId),
  );
}

// ──────────────────────────────────────────────────────────────
// Painel do recrutador (Fase 5)
// ──────────────────────────────────────────────────────────────

// Lista as aplicacoes com o contexto que o painel precisa: titulo da vaga, video_url
// da ultima entrevista, a ultima entrevista da aplicacao e, se houver, o interview_id
// do ultimo relatorio gerado (para habilitar/linkar o botao "Ver relatorio").
// Ordena por criado_em DESC. Filtros opcionais (Fase 5, inc 5):
//   status -> filtra a.status (so um dos valores validos; ignorado caso contrario)
//   statusIa -> filtra a.status_ia (veredito da IA; enum abaixo; ignorado caso contrario)
//   dataDe / dataAte -> intervalo INCLUSIVO sobre a data (YYYY-MM-DD) de a.criado_em
//   jobId -> filtra a.job_id (id da vaga; ignorado se ausente)
// Enum dos vereditos da IA (espelha a maquina de estados do item 2 e badgeStatusIa do
// painel). Interno a esta query; o handler /admin mantem a MESMA allowlist ao sanear a
// query string (mesmo padrao ja usado para o enum de status).
const STATUS_IA_VALIDOS = ['avancar', 'talvez', 'descartar', 'processando', 'indefinido', 'erro'];
function listarAplicacoesComContexto({ status, statusIa, dataDe, dataAte, jobId, incluirArquivados = false } = {}) {
  const where = [];
  const params = [];

  // Soft-delete: por padrao esconde os arquivados (deleted_at != NULL). Isto afeta SO
  // esta lista do painel; o funil (obterFunilConversao) tem query propria e mantem os
  // arquivados nas metricas historicas. O parametro permite reincluir se algum dia
  // precisarmos de uma visao "com arquivados".
  if (!incluirArquivados) {
    where.push('a.deleted_at IS NULL');
  }

  if (status === 'aplicado' || status === 'em_entrevista' || status === 'concluido') {
    where.push('a.status = ?');
    params.push(status);
  }
  if (STATUS_IA_VALIDOS.includes(statusIa)) {
    where.push('a.status_ia = ?');
    params.push(statusIa);
  }
  if (jobId) {
    where.push('a.job_id = ?');
    params.push(jobId);
  }
  if (dataDe) {
    where.push('date(a.criado_em) >= date(?)');
    params.push(dataDe);
  }
  if (dataAte) {
    where.push('date(a.criado_em) <= date(?)');
    params.push(dataAte);
  }

  const clausula = where.length ? `WHERE ${where.join(' AND ')}` : '';

  return getDb()
    .prepare(
      `SELECT
         a.id, a.nome, a.sobrenome, a.email, a.telefone, a.status, a.criado_em,
         a.status_ia, a.status_recrutador,
         j.titulo AS vaga_titulo,
         (SELECT i.id FROM interviews i
            WHERE i.application_id = a.id ORDER BY i.id DESC LIMIT 1) AS interview_id,
         (SELECT i3.video_url FROM interviews i3
            WHERE i3.application_id = a.id ORDER BY i3.id DESC LIMIT 1) AS video_url,
         (SELECT r.interview_id FROM reports r
            JOIN interviews i2 ON i2.id = r.interview_id
            WHERE i2.application_id = a.id ORDER BY r.id DESC LIMIT 1) AS report_interview_id
       FROM applications a
       LEFT JOIN jobs j ON j.id = a.job_id
       ${clausula}
       ORDER BY a.criado_em DESC`,
    )
    .all(...params);
}

// Ultimo relatorio de uma entrevista, em QUALQUER status (o painel mostra mesmo
// 'gerado'/'erro'; difere de obterReportEnviadoPorInterview, que so pega 'enviado').
function obterReportPorInterview(interviewId) {
  return reportDeLinha(
    getDb()
      .prepare('SELECT * FROM reports WHERE interview_id = ? ORDER BY id DESC LIMIT 1')
      .get(interviewId),
  );
}

// Registra UM acesso a pagina publica da vaga (topo do funil). Uma linha por acesso
// (inclui refresh) — deduplicacao por sessao/bot fica como refinamento futuro. O
// criado_em usa o default da tabela (datetime('now')).
function registrarAcessoVaga(jobId) {
  getDb().prepare('INSERT INTO vaga_acessos (job_id) VALUES (?)').run(jobId);
}

// Totais para o rodape do painel.
function contarAplicacoes() {
  return getDb().prepare('SELECT COUNT(*) AS n FROM applications').get().n;
}

function contarEntrevistasConcluidas() {
  return getDb()
    .prepare("SELECT COUNT(*) AS n FROM interviews WHERE status = 'concluido'")
    .get().n;
}

// Funil de conversao por vaga (Func. 3): Acessos -> Aplicacoes -> Entrevistas realizadas
// -> Pre-aprovados pela IA. Consolida 4 fontes (vaga_acessos, applications, interviews,
// reports.recomendacao). opcoes.desde/ate (datas 'YYYY-MM-DD') recortam o periodo por
// tabela, cada uma pelo seu timestamp mais adequado; sem opcoes, retorna o historico total.
//
// Estrategia anti-fan-out: NAO usamos um unico JOIN das 4 tabelas (o produto cartesiano
// inflaria as contagens). Rodamos 4 agregacoes independentes com GROUP BY job_id (poucas
// queries, sem N+1) e casamos os resultados em memoria pela chave job_id.
function obterFunilConversao(opcoes = {}) {
  const db = getDb();
  const { desde, ate } = opcoes;

  // Condicoes de periodo (inclusivas) para uma coluna de data; vazio quando sem filtro.
  const condsPeriodo = (coluna) => {
    const conds = [];
    const params = [];
    if (desde) {
      conds.push(`date(${coluna}) >= date(?)`);
      params.push(desde);
    }
    if (ate) {
      conds.push(`date(${coluna}) <= date(?)`);
      params.push(ate);
    }
    return { conds, params };
  };
  const montarWhere = (base, extra) => {
    const todas = [...base, ...extra.conds];
    return todas.length ? `WHERE ${todas.join(' AND ')}` : '';
  };

  // Cada agregacao -> Map job_id -> contagem.
  const paraMapa = (linhas) => {
    const m = new Map();
    for (const l of linhas) m.set(l.job_id, l.n);
    return m;
  };

  // 1) Acessos: vaga_acessos por job_id (periodo por vaga_acessos.criado_em).
  const fAcessos = condsPeriodo('criado_em');
  const acessos = paraMapa(
    db
      .prepare(
        `SELECT job_id, COUNT(*) AS n FROM vaga_acessos ${montarWhere([], fAcessos)} GROUP BY job_id`,
      )
      .all(...fAcessos.params),
  );

  // 2) Aplicacoes: applications por job_id (periodo por applications.criado_em).
  const fApp = condsPeriodo('criado_em');
  const aplicacoes = paraMapa(
    db
      .prepare(
        `SELECT job_id, COUNT(*) AS n FROM applications ${montarWhere([], fApp)} GROUP BY job_id`,
      )
      .all(...fApp.params),
  );

  // 3) Entrevistas realizadas: interviews concluidas, por job_id (via application_id).
  //    Periodo por interviews.finalizado_em (quando a entrevista de fato concluiu).
  const fEntr = condsPeriodo('i.finalizado_em');
  const entrevistas = paraMapa(
    db
      .prepare(
        `SELECT a.job_id AS job_id, COUNT(*) AS n
           FROM interviews i
           JOIN applications a ON a.id = i.application_id
           ${montarWhere(["i.status = 'concluido'"], fEntr)}
          GROUP BY a.job_id`,
      )
      .all(...fEntr.params),
  );

  // 4) Pre-aprovados pela IA: reports com recomendacao='avancar', por job_id, seguindo a
  //    cadeia report -> interview -> application -> job. COUNT(DISTINCT interview_id) evita
  //    contar 2x se uma entrevista tiver mais de um report 'avancar' (regeracao).
  //    Periodo por reports.enviado_em.
  const fPre = condsPeriodo('r.enviado_em');
  const preAprovados = paraMapa(
    db
      .prepare(
        `SELECT a.job_id AS job_id, COUNT(DISTINCT r.interview_id) AS n
           FROM reports r
           JOIN interviews i ON i.id = r.interview_id
           JOIN applications a ON a.id = i.application_id
           ${montarWhere(["r.recomendacao = 'avancar'"], fPre)}
          GROUP BY a.job_id`,
      )
      .all(...fPre.params),
  );

  // Todas as vagas (mesmo as sem nenhum acesso/aplicacao aparecem, com zeros).
  const vagas = db.prepare('SELECT id, titulo, slug FROM jobs ORDER BY criado_em DESC, id DESC').all();

  const linhas = vagas.map((v) => ({
    job_id: v.id,
    titulo: v.titulo,
    slug: v.slug,
    acessos: acessos.get(v.id) || 0,
    aplicacoes: aplicacoes.get(v.id) || 0,
    entrevistas_realizadas: entrevistas.get(v.id) || 0,
    pre_aprovados: preAprovados.get(v.id) || 0,
  }));

  const totais = linhas.reduce(
    (acc, l) => ({
      acessos: acc.acessos + l.acessos,
      aplicacoes: acc.aplicacoes + l.aplicacoes,
      entrevistas_realizadas: acc.entrevistas_realizadas + l.entrevistas_realizadas,
      pre_aprovados: acc.pre_aprovados + l.pre_aprovados,
    }),
    { acessos: 0, aplicacoes: 0, entrevistas_realizadas: 0, pre_aprovados: 0 },
  );

  return { vagas: linhas, totais };
}

// ──────────────────────────────────────────────────────────────
// Uso/custo das chamadas ao LLM (monitoramento de custos)
// ──────────────────────────────────────────────────────────────

// Helper local: inteiro >= 0 a partir de valor possivelmente string/null/undefined.
function inteiroNaoNeg(v) {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
}

// Registra UMA chamada ao LLM em api_usage. BEST-EFFORT: NUNCA lanca para o chamador
// (uma falha de log de custo jamais pode interromper a entrevista/relatorio). Le os
// contadores do objeto `uso` BRUTO da API DeepSeek; o custo ja vem calculado.
function registrarUsoApi({ provedor, modelo, origem, interview_id, uso, custo_usd } = {}) {
  try {
    const u = uso || {};
    const cacheHit = inteiroNaoNeg(u.prompt_cache_hit_tokens);
    const cacheMiss = inteiroNaoNeg(u.prompt_cache_miss_tokens);
    const promptTokens = inteiroNaoNeg(u.prompt_tokens);
    const completionTokens = inteiroNaoNeg(u.completion_tokens);
    const totalTokens = inteiroNaoNeg(u.total_tokens) || promptTokens + completionTokens;

    getDb()
      .prepare(
        `INSERT INTO api_usage
           (provedor, modelo, origem, interview_id,
            prompt_tokens, completion_tokens, cache_hit_tokens, cache_miss_tokens,
            total_tokens, custo_usd)
         VALUES
           (@provedor, @modelo, @origem, @interview_id,
            @prompt_tokens, @completion_tokens, @cache_hit_tokens, @cache_miss_tokens,
            @total_tokens, @custo_usd)`,
      )
      .run({
        provedor: provedor || 'deepseek',
        modelo: modelo || null,
        origem: origem || 'desconhecida',
        interview_id: interview_id || null,
        prompt_tokens: promptTokens,
        completion_tokens: completionTokens,
        cache_hit_tokens: cacheHit,
        cache_miss_tokens: cacheMiss,
        total_tokens: totalTokens,
        custo_usd: Number.isFinite(Number(custo_usd)) ? Number(custo_usd) : 0,
      });
  } catch (err) {
    console.error(`[custos] falha ao registrar uso de API (origem=${origem}): ${err.message}`);
  }
}

// Totais gerais para a pagina de custos (uma unica linha agregada).
function resumoUsoApi() {
  return getDb()
    .prepare(
      `SELECT
         COUNT(*)                      AS chamadas,
         COALESCE(SUM(custo_usd), 0)         AS custo_usd,
         COALESCE(SUM(cache_hit_tokens), 0)  AS cache_hit_tokens,
         COALESCE(SUM(cache_miss_tokens), 0) AS cache_miss_tokens,
         COALESCE(SUM(prompt_tokens), 0)     AS prompt_tokens,
         COALESCE(SUM(completion_tokens), 0) AS completion_tokens,
         COALESCE(SUM(total_tokens), 0)      AS total_tokens
       FROM api_usage`,
    )
    .get();
}

// Agregado por origem ('entrevista' | 'relatorio').
function usoApiPorOrigem() {
  return getDb()
    .prepare(
      `SELECT
         origem,
         COUNT(*)                            AS chamadas,
         COALESCE(SUM(prompt_tokens), 0)     AS tokens_entrada,
         COALESCE(SUM(completion_tokens), 0) AS tokens_saida,
         COALESCE(SUM(custo_usd), 0)         AS custo_usd
       FROM api_usage
       GROUP BY origem
       ORDER BY custo_usd DESC`,
    )
    .all();
}

// Ultimas N chamadas (para a tabela de detalhe).
function ultimasChamadasApi(limite = 30) {
  return getDb()
    .prepare('SELECT * FROM api_usage ORDER BY id DESC LIMIT ?')
    .all(limite);
}

// ──────────────────────────────────────────────────────────────
// Configuracoes gerais (store chave/valor generico)
// ──────────────────────────────────────────────────────────────

// Le uma config (string). Retorna `padrao` quando a chave nao existe (NAO cria linha).
function obterConfig(chave, padrao = null) {
  const linha = getDb().prepare('SELECT valor FROM configuracoes WHERE chave = ?').get(chave);
  return linha ? linha.valor : padrao;
}

// Grava/atualiza uma config (UPSERT pela PK `chave`; nunca duplica linha). Atualiza
// atualizado_em a cada gravacao subsequente.
function definirConfig(chave, valor) {
  getDb()
    .prepare(
      `INSERT INTO configuracoes (chave, valor) VALUES (?, ?)
       ON CONFLICT(chave) DO UPDATE SET valor = excluded.valor, atualizado_em = datetime('now')`,
    )
    .run(chave, String(valor));
}

// Conveniencia booleana (valor e TEXT): true se '1', false se '0', `padrao` se ausente
// (ou valor inesperado). Espelha definirConfigBool, que grava sempre '1' ou '0'.
function obterConfigBool(chave, padrao = false) {
  const v = obterConfig(chave, null);
  if (v === '1') return true;
  if (v === '0') return false;
  return padrao;
}

function definirConfigBool(chave, valor) {
  definirConfig(chave, valor ? '1' : '0');
}

module.exports = {
  getDb,
  aplicarSchema,
  // vagas
  obterVaga,
  obterVagaPorSlug,
  obterVagaAtiva,
  listarVagas,
  criarVaga,
  atualizarVaga,
  definirVagaAtiva,
  // painel (Fase 5)
  listarAplicacoesComContexto,
  obterReportPorInterview,
  registrarAcessoVaga,
  contarAplicacoes,
  contarEntrevistasConcluidas,
  obterFunilConversao,
  // uso/custo de API (monitoramento de custos)
  registrarUsoApi,
  resumoUsoApi,
  usoApiPorOrigem,
  ultimasChamadasApi,
  // configuracoes (store chave/valor)
  obterConfig,
  definirConfig,
  obterConfigBool,
  definirConfigBool,
  // roteiros
  obterRoteiro,
  obterRoteiroPorNome,
  obterRoteiroPorPerfil,
  atualizarEstruturaRoteiro,
  criarRoteiro,
  // aplicacoes
  criarAplicacao,
  obterAplicacao,
  obterAplicacaoPorToken,
  atualizarStatusAplicacao,
  definirStatusIa,
  definirStatusIaSeVazio,
  obterStatusIaPorApplication,
  definirStatusRecrutador,
  STATUS_RECRUTADOR_VALIDOS,
  atualizarAplicacao,
  arquivarAplicacao,
  restaurarAplicacao,
  registrarConsentGravacao,
  marcarRetomadaEnviada,
  // entrevistas
  criarInterview,
  obterInterview,
  obterInterviewEmAndamentoPorAplicacao,
  obterUltimaInterviewPorAplicacao,
  definirUltimoRespId,
  atualizarProgressoInterview,
  finalizarInterview,
  definirVideoUrl,
  criarTurno,
  listarTurnos,
  contarTurnos,
  // relatorios
  criarReport,
  atualizarStatusReport,
  obterReportPorToken,
  obterReportEnviadoPorInterview,
};
