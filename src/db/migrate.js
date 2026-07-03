'use strict';

// Cria as tabelas a partir de schema.sql. Idempotente: pode rodar quantas
// vezes quiser (usa CREATE TABLE IF NOT EXISTS). Roda no boot do servidor e
// tambem via `npm run migrate`.

const { config } = require('../config');
const { aplicarSchema, getDb } = require('./sqlite');

// Adiciona uma coluna se ela ainda nao existir (idempotente, p/ bancos antigos).
// CREATE TABLE IF NOT EXISTS nao altera tabelas ja criadas, entao migracoes
// incrementais de coluna vivem aqui.
function adicionarColunaSeFaltar(tabela, coluna, definicao) {
  const db = getDb();
  const existe = db
    .prepare(`SELECT 1 FROM pragma_table_info(?) WHERE name = ?`)
    .get(tabela, coluna);
  if (!existe) {
    db.exec(`ALTER TABLE ${tabela} ADD COLUMN ${coluna} ${definicao}`);
  }
}

function migrar() {
  aplicarSchema();
  // Migracoes incrementais (idempotentes) para bancos criados antes desta coluna.
  adicionarColunaSeFaltar('interviews', 'ultimo_resp_id', 'TEXT');

  // Fase 4 - relatorios: token (link nao-adivinhavel) + status do ciclo de geracao/envio.
  adicionarColunaSeFaltar('reports', 'token', 'TEXT');
  adicionarColunaSeFaltar(
    'reports',
    'status',
    "TEXT NOT NULL DEFAULT 'pendente' CHECK (status IN ('pendente', 'gerado', 'enviado', 'erro'))",
  );
  // Func. 3 - "pre-aprovado pela IA": recomendacao explicita emitida pelo relatorio.
  // Enum 'avancar'|'talvez'|'descartar' validado no app (parseAvaliacao); coluna TEXT
  // sem CHECK para nao travar bancos antigos. Reports antigos ficam com NULL (= sem
  // recomendacao) e nao quebram nada.
  adicionarColunaSeFaltar('reports', 'recomendacao', 'TEXT');
  // Fase 5 - edicao da vaga pelo painel: garante que os campos editaveis existam em
  // bancos antigos (no-op se ja existem; nunca faz DROP/recriacao). 'titulo' nao entra
  // aqui porque ja faz parte do schema original (NOT NULL) e sempre existe.
  adicionarColunaSeFaltar('jobs', 'faixa_pagamento', 'TEXT');
  adicionarColunaSeFaltar('jobs', 'descricao', 'TEXT');
  adicionarColunaSeFaltar('jobs', 'sobre_empresa', 'TEXT');
  adicionarColunaSeFaltar('jobs', 'ativo', 'INTEGER NOT NULL DEFAULT 1');

  // Pagina de vaga rica: campos estruturados adicionais para a nova /vaga/:slug.
  // potencial_ganhos e texto livre; os demais sao arrays serializados em JSON
  // (uma string por item). Idempotente: bancos antigos ganham as colunas sem
  // recriar a tabela (nunca fazemos DROP).
  adicionarColunaSeFaltar('jobs', 'potencial_ganhos', 'TEXT');
  adicionarColunaSeFaltar('jobs', 'beneficios', 'TEXT'); // JSON (array de strings)
  adicionarColunaSeFaltar('jobs', 'atividades', 'TEXT'); // JSON (array de strings)
  adicionarColunaSeFaltar('jobs', 'requisitos', 'TEXT'); // JSON (array de strings)
  adicionarColunaSeFaltar('jobs', 'secoes_extras', 'TEXT'); // JSON (array de {titulo, itens})

  // Detalhes da vaga (texto simples, opcionais; exibidos como selos na /vaga/:slug).
  // modalidade: 'presencial'|'hibrido'|'remoto'; regime: 'CLT'|'PJ'. Idempotente.
  adicionarColunaSeFaltar('jobs', 'endereco', 'TEXT');
  adicionarColunaSeFaltar('jobs', 'modalidade', 'TEXT'); // 'presencial'|'híbrido'|'remoto'
  adicionarColunaSeFaltar('jobs', 'regime', 'TEXT'); // 'CLT'|'PJ'
  adicionarColunaSeFaltar('jobs', 'horario', 'TEXT');

  // Fase 5 - gravacao de video: link compartilhavel do Google Drive por entrevista.
  adicionarColunaSeFaltar('interviews', 'video_url', 'TEXT');

  // Func. 2 - toggle por-vaga do modo do funil: 1 = Completo (entrevista automatica,
  // comportamento atual), 0 = Simples (so confirmacao + WhatsApp). Default 1 preserva
  // o comportamento de todas as vagas existentes. So vale quando o toggle GERAL esta ON.
  adicionarColunaSeFaltar('jobs', 'entrevista_ativa', 'INTEGER NOT NULL DEFAULT 1');

  // Fase 5 - consentimento LGPD: momento em que o candidato aceitou a coleta/uso dos
  // dados (checkbox da aplicacao) e a gravacao da entrevista (checkbox do teste de
  // microfone). Texto ISO/UTC, igual aos demais timestamps (datetime('now')).
  adicionarColunaSeFaltar('applications', 'consent_at', 'TEXT');
  adicionarColunaSeFaltar('applications', 'consent_gravacao_at', 'TEXT');

  // Camera obrigatoria - e-mail de "continuar depois": momento do ultimo envio do
  // link de retomada (ISO/UTC). Usado para nao reenviar dentro de 30 min. Idempotente.
  adicionarColunaSeFaltar('applications', 'enviado_retomada_em', 'TEXT');

  // Painel do recrutador - soft-delete de lead: momento do arquivamento (ISO/UTC).
  // NULL = ativo. Aditiva (sem default/CHECK/DROP). Arquivados saem da listagem do
  // painel, mas o historico e preservado; reversivel via restaurarAplicacao.
  adicionarColunaSeFaltar('applications', 'deleted_at', 'TEXT');

  // Indices de reports ficam aqui (e nao no schema.sql) porque dependem das
  // colunas acima, que em bancos antigos so passam a existir depois do ADD COLUMN.
  const db = getDb();
  db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_reports_token ON reports(token)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_reports_interview ON reports(interview_id)');

  return config.caminhoBanco;
}

// Execucao direta: `node src/db/migrate.js` ou `npm run migrate`
if (require.main === module) {
  try {
    const caminho = migrar();
    console.log(`[migrate] schema aplicado em ${caminho}`);
  } catch (err) {
    console.error('[migrate] falha ao aplicar schema:', err.message);
    process.exit(1);
  }
}

module.exports = { migrar };
