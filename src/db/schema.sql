-- Esquema do banco (secao 3 do PLANEJAMENTO_IMPLEMENTACAO.md).
-- Escrito em SQL portavel; o que e especifico de SQLite fica isolado em sqlite.js.
-- migrate.js executa este arquivo de forma idempotente (CREATE TABLE IF NOT EXISTS).

-- Vagas (multi-vaga no banco, uma ativa na v1)
CREATE TABLE IF NOT EXISTS jobs (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  slug            TEXT NOT NULL UNIQUE,
  titulo          TEXT NOT NULL,
  perfil          TEXT NOT NULL CHECK (perfil IN ('SDR', 'CLOSER')),
  faixa_pagamento TEXT,
  skills          TEXT,            -- JSON (array de strings)
  descricao       TEXT,
  sobre_empresa   TEXT,
  empresa         TEXT,            -- nome da empresa cliente dona da vaga (usado na msg de WhatsApp); NULL = omite
  roteiro_id      INTEGER REFERENCES roteiros(id),
  ativo           INTEGER NOT NULL DEFAULT 1,  -- 0/1 (boolean)
  criado_em       TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Roteiros de entrevista (orientados a dados, editaveis sem mexer no codigo)
CREATE TABLE IF NOT EXISTS roteiros (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  nome         TEXT NOT NULL,
  perfil       TEXT NOT NULL CHECK (perfil IN ('SDR', 'CLOSER')),
  versao       INTEGER NOT NULL DEFAULT 1,
  estrutura    TEXT NOT NULL,     -- JSON: blocos + competencias + perguntas-semente + rubrica
  criado_em    TEXT NOT NULL DEFAULT (datetime('now')),
  atualizado_em TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Aplicacoes (candidatos)
CREATE TABLE IF NOT EXISTS applications (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id         INTEGER NOT NULL REFERENCES jobs(id),
  nome           TEXT,
  sobrenome      TEXT,
  email          TEXT,
  telefone       TEXT,
  cidade         TEXT,           -- (legado) nao mais gravado; coluna orfa mantida p/ nao recriar tabela
  linkedin_url   TEXT,
  curriculo_path TEXT,            -- caminho do PDF
  curriculo_texto TEXT,           -- texto extraido p/ contexto do agente
  campos_extras  TEXT,            -- (legado) nao mais coletado; novas linhas gravam '{}'. Coluna orfa mantida.
  token          TEXT UNIQUE,     -- acesso retomavel
  utm_source     TEXT,            -- origem do lead (first-touch, cookie vm_utm); 'direto' quando sem UTM
  utm_medium     TEXT,            -- demais UTM (first-touch, cookie vm_utm); NULL quando ausente (sem 'direto')
  utm_campaign   TEXT,
  utm_content    TEXT,
  utm_term       TEXT,
  status         TEXT NOT NULL DEFAULT 'aplicado'
                   CHECK (status IN ('aplicado', 'em_entrevista', 'concluido')),
  consent_at          TEXT,        -- (Fase 5/LGPD) quando aceitou a coleta/uso dos dados (checkbox da aplicacao)
  consent_gravacao_at TEXT,        -- (Fase 5/LGPD) quando aceitou a gravacao da entrevista (checkbox do teste de microfone)
  criado_em      TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Entrevistas
CREATE TABLE IF NOT EXISTS interviews (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  application_id INTEGER NOT NULL REFERENCES applications(id),
  perfil         TEXT NOT NULL CHECK (perfil IN ('SDR', 'CLOSER')),
  roteiro_id     INTEGER REFERENCES roteiros(id),
  status         TEXT NOT NULL DEFAULT 'iniciada',
  iniciado_em    TEXT NOT NULL DEFAULT (datetime('now')),
  finalizado_em  TEXT,
  ultimo_resp_id TEXT,  -- id da ultima resposta processada (idempotencia: evita turnos duplicados em retry)
  video_url      TEXT   -- (Fase 5) link compartilhavel da gravacao de video no Google Drive
);

-- Turnos da conversa (turno a turno)
CREATE TABLE IF NOT EXISTS interview_turns (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  interview_id INTEGER NOT NULL REFERENCES interviews(id),
  ordem        INTEGER NOT NULL,
  autor        TEXT NOT NULL CHECK (autor IN ('agente', 'candidato')),
  texto        TEXT,
  audio_path   TEXT,             -- opcional
  criado_em    TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Relatorios
CREATE TABLE IF NOT EXISTS reports (
  id                     INTEGER PRIMARY KEY AUTOINCREMENT,
  interview_id           INTEGER NOT NULL REFERENCES interviews(id),
  token                  TEXT,   -- link nao-adivinhavel p/ a pagina do relatorio (unico via indice em migrate.js)
  status                 TEXT NOT NULL DEFAULT 'pendente'
                           CHECK (status IN ('pendente', 'gerado', 'enviado', 'erro')),
  resumo                 TEXT,
  pontuacoes             TEXT,   -- JSON por competencia
  destaque_pontos_fortes TEXT,
  destaque_atencao       TEXT,
  recomendacao           TEXT,   -- 'avancar' | 'talvez' | 'descartar' (pre-aprovacao pela IA); enum validado no app
  enviado_em             TEXT,
  destinatario           TEXT
);

-- Log de uso/custo das chamadas ao LLM (DeepSeek). custo_usd ja calculado na gravacao
-- (a partir do objeto usage bruto da API) para a pagina de custos ser rapida e auditavel.
CREATE TABLE IF NOT EXISTS api_usage (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  criado_em         TEXT NOT NULL DEFAULT (datetime('now')),
  provedor          TEXT NOT NULL DEFAULT 'deepseek',
  modelo            TEXT,
  origem            TEXT NOT NULL,              -- 'entrevista' | 'relatorio'
  interview_id      INTEGER REFERENCES interviews(id),
  prompt_tokens     INTEGER NOT NULL DEFAULT 0,
  completion_tokens INTEGER NOT NULL DEFAULT 0,
  cache_hit_tokens  INTEGER NOT NULL DEFAULT 0,
  cache_miss_tokens INTEGER NOT NULL DEFAULT 0,
  total_tokens      INTEGER NOT NULL DEFAULT 0,
  custo_usd         REAL NOT NULL DEFAULT 0
);

-- Acessos a pagina publica da vaga (topo do funil: Acessos -> Aplicacoes ->
-- Entrevistas -> Pre-aprovados). Um registro por acesso (preserva timestamp p/
-- recorte por periodo depois); a agregacao/visualizacao vem em increments futuros.
CREATE TABLE IF NOT EXISTS vaga_acessos (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id    INTEGER NOT NULL REFERENCES jobs(id),
  utm_source   TEXT,   -- origem do lead no topo do funil (first-touch, cookie vm_utm); NULL quando sem UTM
  utm_medium   TEXT,   -- demais UTM (first-touch, cookie vm_utm); NULL quando ausente (sem 'direto')
  utm_campaign TEXT,
  utm_content  TEXT,
  utm_term     TEXT,
  criado_em TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_vaga_acessos_job ON vaga_acessos(job_id);
CREATE INDEX IF NOT EXISTS idx_vaga_acessos_utm ON vaga_acessos(utm_source);

-- Configuracoes gerais (store chave/valor generico). Usado por ora para uma unica
-- chave: entrevista_automatica_geral. Sem seed: a ausencia de linha significa "usar o
-- default" (definido em quem le, ex.: obterConfigBool(..., true)).
CREATE TABLE IF NOT EXISTS configuracoes (
  chave         TEXT PRIMARY KEY,
  valor         TEXT NOT NULL,
  atualizado_em TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Perfis ideais de curriculo (Banco de Curriculos - T1). Mesma anatomia de `roteiros`:
-- a coluna `estrutura` guarda o JSON inteiro, editavel pelo painel sem mexer no codigo.
-- Formato: { criterios: [{ id, nome, peso, descricao_ideal }], instrucoes: '' } —
-- criterios de CURRICULO (experiencia, trajetoria, ferramentas), nao comportamentais.
CREATE TABLE IF NOT EXISTS perfis_curriculo (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  nome          TEXT NOT NULL,
  perfil        TEXT NOT NULL CHECK (perfil IN ('SDR', 'CLOSER')),
  versao        INTEGER NOT NULL DEFAULT 1,
  estrutura     TEXT NOT NULL,     -- JSON: criterios do curriculo ideal + instrucoes p/ o motor de analise
  criado_em     TEXT NOT NULL DEFAULT (datetime('now')),
  atualizado_em TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Cadastros do Banco de Curriculos (/bancodecurriculos) — fluxo INDEPENDENTE do funil
-- de vagas (`applications` segue exclusivo do funil). `analise` recebe o JSON do motor
-- de analise (incremento futuro); NULL = ainda nao analisado. `consent_at` segue o
-- padrao LGPD de applications (datetime('now') no INSERT, apos a rota validar o
-- checkbox), com finalidade distinta: "banco de talentos". `aplicacao_id` e referencia
-- LOGICA a applications(id), sem constraint rigida — preenchida se o talento um dia
-- virar candidatura formal.
CREATE TABLE IF NOT EXISTS talentos (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  nome             TEXT,
  email            TEXT,
  telefone         TEXT,
  perfil_interesse TEXT CHECK (perfil_interesse IN ('SDR', 'CLOSER')),
  linkedin_url     TEXT,
  curriculo_path   TEXT,            -- caminho do PDF (volume persistente, pasta separada do funil)
  curriculo_texto  TEXT,            -- texto extraido p/ o motor de analise
  analise          TEXT,            -- JSON: score + pontos fortes + pontos de atencao (NULL = sem analise)
  consent_at       TEXT,            -- (LGPD) quando aceitou a finalidade "banco de talentos"
  status           TEXT NOT NULL DEFAULT 'novo'
                     CHECK (status IN ('novo', 'contatado', 'descartado', 'convertido')),
  aplicacao_id     INTEGER,         -- referencia logica a applications(id), sem FK rigida
  criado_em        TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Indices uteis
CREATE INDEX IF NOT EXISTS idx_jobs_ativo            ON jobs(ativo);
CREATE INDEX IF NOT EXISTS idx_applications_token    ON applications(token);
CREATE INDEX IF NOT EXISTS idx_applications_job      ON applications(job_id);
CREATE INDEX IF NOT EXISTS idx_turns_interview       ON interview_turns(interview_id, ordem);
CREATE INDEX IF NOT EXISTS idx_api_usage_interview   ON api_usage(interview_id);
CREATE INDEX IF NOT EXISTS idx_api_usage_criado      ON api_usage(criado_em);
