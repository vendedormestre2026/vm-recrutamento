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
  contatado_whatsapp_em TEXT,      -- (B4) momento do 1o clique no botao de WhatsApp pelo recrutador; NULL = nao contatado
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
  destinatario           TEXT,
  erro_mensagem          TEXT,   -- mensagem da excecao que impediu a avaliacao (truncada); NULL quando deu certo
  erro_em                TEXT    -- momento (ISO/UTC) da falha; NULL quando deu certo
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
  -- campanha_id: atribuicao EXATA de clique a uma campanha de Promocao de Vagas. Vem do
  --   parametro `campanha_id` do link do e-mail, e NAO do cookie vm_utm — ao contrario
  --   das UTM acima, que sao first-touch e sobrevivem 30 dias. A diferenca e proposital:
  --   utm_source responde "de onde essa pessoa veio originalmente", enquanto isto responde
  --   "este acesso foi um clique naquele e-mail". Uma visita organica de quem um dia
  --   clicou na campanha tem utm_source='email' pelo cookie, e campanha_id NULL — que e a
  --   leitura correta para contar cliques.
  -- NULL = acesso que nao veio de campanha (organico, ou anterior ao recurso).
  campanha_id  INTEGER REFERENCES campanhas(id),
  criado_em TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_vaga_acessos_job ON vaga_acessos(job_id);
-- NOTA: o indice de utm_source NAO fica aqui de proposito. Esta coluna e adicionada por
-- migracao incremental (migrate.js, apos ADD COLUMN); em bancos ja existentes a coluna
-- so passa a existir depois do ADD COLUMN, entao criar o indice aqui (aplicarSchema roda
-- ANTES das migracoes) quebraria o boot ("no such column: utm_source"). O indice
-- idx_vaga_acessos_utm e criado em migrate.js, no lugar correto.

-- Passagem do candidato pelas telas ENTRE a candidatura e o inicio da entrevista.
--
-- POR QUE EXISTE: 93% do vazamento do funil acontece nesse trecho — a maioria das
-- candidaturas em vagas com entrevista ativa nunca cria uma linha em interviews. Hoje
-- so enxergamos as duas pontas (applications e interviews) e o meio e cego: nao da para
-- dizer se a pessoa parou na preparacao, no pedido de permissao da camera ou no teste
-- de microfone. Cada etapa aqui e uma tela desse trecho.
--
-- Mesma anatomia de vaga_acessos (id + FK + criado_em), com UMA diferenca deliberada:
-- vaga_acessos grava um registro por ACESSO (pode repetir), esta grava um registro por
-- PRIMEIRA passagem. O UNIQUE(application_id, etapa) e o que garante isso, junto com o
-- INSERT OR IGNORE de quem escreve — recarregar a tela, voltar no navegador ou retomar a
-- entrevista dias depois nao inflam a contagem. O que se quer medir e "quantas pessoas
-- CHEGARAM ate aqui", nao quantas vezes cada uma passou.
--
-- O CHECK trava as seis etapas conhecidas: uma etapa nova exige mexer no schema de
-- proposito, para a tabela nao virar um saco de strings livres com typo virando etapa.
-- Sem FK rigida para applications, seguindo talentos.aplicacao_id — a instrumentacao
-- nunca pode impedir uma escrita no funil de negocio.
CREATE TABLE IF NOT EXISTS funil_eventos (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  application_id INTEGER NOT NULL,
  etapa          TEXT NOT NULL CHECK (etapa IN (
                   'preparacao', 'video', 'permissao_camera', 'teste_camera',
                   'permissao_microfone', 'teste_microfone'
                 )),
  criado_em      TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(application_id, etapa)
);
CREATE INDEX IF NOT EXISTS idx_funil_eventos_application ON funil_eventos(application_id);

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
  criado_em        TEXT NOT NULL DEFAULT (datetime('now')),
  -- ── Importacao da base legada ──
  -- categoria: de ONDE este talento veio. 'legado' = importado da base antiga (sistema
  --   anterior, multi-cliente). NULL = cadastro proprio via /bancodecurriculos, que e o
  --   caso de todos os talentos existentes antes da importacao. SEM CHECK de proposito:
  --   o SQLite nao remove constraint depois (exigiria recriar a tabela), e o precedente do
  --   projeto para enum extensivel e validar no app — ver applications.status_ia, tambem
  --   sem CHECK "para nao travar bancos legados". A allowlist vive em sqlite.js.
  -- cargo: cargo normalizado da origem, texto completo (ex.: 'Consultor Comercial',
  --   'Lideranca Comercial'). NAO substitui perfil_interesse: aquele e o enum SDR|CLOSER
  --   que o motor de campanha usa como atributo de filtro, e so 2 dos 6 cargos mapeiam
  --   nele. Os outros 4 ficam com perfil_interesse NULL e o cargo fiel aqui.
  -- campos_extras: JSON com os metadados da origem que nao tem coluna propria (empresa
  --   onde a pessoa se candidatou, codigo da vaga original PS000X, utm_source original).
  --   Guardados para auditoria/relatorio; nada no app depende deles hoje.
  -- cidade: praca de atuacao. Preenchida por BACKFILL para os importados, derivada de
  --   campos_extras.empresa_origem por dicionario exato (cada empresa da base antiga
  --   atendia uma praca). NULL = cidade desconhecida — e o estado de todo cadastro
  --   proprio (/bancodecurriculos nao coleta cidade) e de qualquer legado cuja empresa
  --   nao esteja no dicionario.
  --   VALOR SENTINELA 'Todas as cidades': NAO e "sem cidade". Marca presenca ativa em
  --   qualquer praca (hoje so a Loureiro), e um filtro futuro de cidade deve fazer essa
  --   pessoa casar com QUALQUER cidade selecionada — sem depender de um "incluir sem
  --   cidade". Por isso e string literal e nao NULL: os dois significam coisas opostas.
  categoria        TEXT,
  cargo            TEXT,
  campos_extras    TEXT,
  cidade           TEXT
);

-- Indices uteis
CREATE INDEX IF NOT EXISTS idx_jobs_ativo            ON jobs(ativo);
CREATE INDEX IF NOT EXISTS idx_applications_token    ON applications(token);
CREATE INDEX IF NOT EXISTS idx_applications_job      ON applications(job_id);
CREATE INDEX IF NOT EXISTS idx_turns_interview       ON interview_turns(interview_id, ordem);
CREATE INDEX IF NOT EXISTS idx_api_usage_interview   ON api_usage(interview_id);
CREATE INDEX IF NOT EXISTS idx_api_usage_criado      ON api_usage(criado_em);

-- ──────────────────────────────────────────────────────────────
-- Promocao de Vagas (divulgacao de uma vaga para a base de contatos)
-- ──────────────────────────────────────────────────────────────

-- Uma campanha de divulgacao: uma VAGA enviada por e-mail para um recorte da base de
-- contatos. A base de contatos NAO e uma tabela: e uma projecao de LEITURA sobre
-- `applications` (funil) + `talentos` (Banco de Curriculos), que continuam separadas,
-- sem FK entre si e sem fusao de dados — as duas tem finalidades LGPD distintas
-- (candidatura a vaga x banco de talentos) e nada aqui as mistura no armazenamento.
--
-- `criterios` guarda o JSON dos filtros aplicados no momento do disparo (vaga, origem,
-- status, periodo...). E um registro HISTORICO, nao uma configuracao re-executavel: o
-- publico real de cada campanha esta materializado em `campanha_envios`, linha a linha.
-- Guardar os criterios permite auditar "por que esta pessoa recebeu" depois que os dados
-- de origem mudaram (o candidato avancou de status, a vaga foi encerrada etc.).
--
-- `total_destinatarios` e o tamanho do publico no momento em que a campanha foi
-- enfileirada — congelado de proposito, para o painel poder mostrar progresso
-- (enviados / total) sem recontar um conjunto que muda embaixo dele.
CREATE TABLE IF NOT EXISTS campanhas (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id              INTEGER NOT NULL REFERENCES jobs(id),
  assunto             TEXT NOT NULL,
  corpo_html          TEXT NOT NULL,
  criterios           TEXT NOT NULL,   -- JSON dos filtros aplicados (rastro historico)
  status              TEXT NOT NULL DEFAULT 'rascunho'
                        CHECK (status IN ('rascunho', 'enfileirada', 'enviando', 'concluida', 'cancelada')),
  total_destinatarios INTEGER NOT NULL DEFAULT 0,
  criado_em           TEXT NOT NULL DEFAULT (datetime('now')),
  enfileirada_em      TEXT,
  finalizada_em       TEXT
);

-- Uma linha por PESSOA por campanha: o publico materializado no momento do disparo.
--
-- UNIQUE(campanha_id, email) NAO e higiene de dados — e a garantia de IDEMPOTENCIA no
-- nivel do banco. A mesma pessoa nunca recebe a mesma campanha duas vezes, mesmo que a
-- query de publico seja executada de novo (re-enfileiramento, retry apos falha, dois
-- ciclos de varredura se cruzando). NAO REMOVER: sem esta constraint, a unica protecao
-- contra e-mail duplicado seria a logica da aplicacao, e nao existe "despublicar" um
-- e-mail enviado.
--
-- `email` e gravado JA NORMALIZADO (LOWER(TRIM())). Quem escreve normaliza; quem le NAO
-- precisa aplicar LOWER(TRIM()) de novo. E o que faz o UNIQUE acima valer para a PESSOA
-- (a unidade de destinatario deste subsistema) e nao para uma grafia especifica do
-- e-mail — 'Joao@X.com' e 'joao@x.com ' sao a mesma linha aqui.
--
-- `origem_id` NAO tem chave estrangeira DE PROPOSITO: aponta ora para applications(id),
-- ora para talentos(id), conforme `origem_tipo`. Uma FK so pode mirar UMA tabela, e as
-- duas bases sao independentes. E rastro de AUDITORIA ("de onde veio este contato"), nao
-- relacao — segue a mesma decisao de talentos.aplicacao_id (referencia logica, sem
-- constraint rigida). Nullable: um contato cuja origem sumiu continua auditavel pelo
-- e-mail, e apagar a origem nunca pode apagar o registro de que o e-mail saiu.
CREATE TABLE IF NOT EXISTS campanha_envios (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  campanha_id INTEGER NOT NULL REFERENCES campanhas(id),
  email       TEXT NOT NULL,   -- SEMPRE ja normalizado (LOWER(TRIM())) por quem escreve
  nome        TEXT,
  origem_tipo TEXT NOT NULL CHECK (origem_tipo IN ('application', 'talento')),
  origem_id   INTEGER,         -- applications(id) OU talentos(id), conforme origem_tipo; sem FK (ver acima)
  status      TEXT NOT NULL DEFAULT 'pendente'
                CHECK (status IN ('pendente', 'enviado', 'falha', 'cancelado')),
  enviado_em  TEXT,
  erro        TEXT,
  -- tentativas: quantas vezes o envio desta linha ja foi tentado e falhou de forma
  --   RETENTAVEL. Existe porque nem toda falha e do destinatario: 2.945 linhas viraram
  --   'falha' terminal por limite de vazao do provedor (HTTP 429 do Emailit, teto diario
  --   do ZeptoMail) — erros que teriam passado numa segunda tentativa.
  --   Com ela, um erro transitorio mantem a linha em 'pendente' e incrementa o contador; a
  --   linha volta sozinha no ciclo seguinte (o proprio intervalo de 15 min e o backoff). So
  --   ao estourar o teto ela vira 'falha' de verdade.
  --   O UNIQUE(campanha_id, email) e o motivo de a retentativa ser UPDATE na mesma linha e
  --   nao INSERT de outra: nao ha como ter duas linhas para a mesma pessoa na campanha.
  tentativas  INTEGER NOT NULL DEFAULT 0,
  criado_em   TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (campanha_id, email)
);

-- Opt-out de divulgacao. GLOBAL e por E-MAIL, nao por candidato, por tres razoes que
-- juntas descartam qualquer alternativa por-linha:
--   1. a mesma pessoa pode existir em `applications` E em `talentos` (bases separadas);
--   2. a mesma pessoa pode ter VARIAS linhas em `applications` (recandidatura — ja
--      observado em producao, ver o dedupe de listarPendentesLembreteInicio);
--   3. a pessoa pode se recandidatar DEPOIS de ter se descadastrado, criando uma linha
--      nova e limpa — o opt-out precisa sobreviver a isso.
-- Uma coluna em applications/talentos falharia nos tres casos. Aqui o e-mail e a
-- identidade, e a supressao vale para sempre, independente de onde a pessoa reaparecer.
--
-- `email` e a PK e e gravado JA NORMALIZADO (LOWER(TRIM())), mesma regra de
-- campanha_envios: quem escreve normaliza, quem le compara direto.
-- Sem coluna de "reinscricao": desfazer um opt-out e apagar a linha (acao deliberada e
-- rara), nao alternar um flag que um bug poderia inverter em massa.
CREATE TABLE IF NOT EXISTS descadastros (
  email     TEXT PRIMARY KEY,   -- SEMPRE ja normalizado (LOWER(TRIM())) por quem escreve
  origem    TEXT,               -- 'link_email' (auto-servico) | 'manual' (recrutador)
  criado_em TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Indices da Promocao de Vagas.
--
-- Os dois primeiros ficam AQUI (e nao em migrate.js) porque `applications.email` e
-- `talentos.email` fazem parte do CREATE TABLE original das duas tabelas, acima neste
-- mesmo arquivo — nao sao colunas adicionadas por migracao incremental. A restricao que
-- obrigou idx_vaga_acessos_utm a morar em migrate.js (aplicarSchema roda ANTES das
-- migracoes, entao a coluna ainda nao existiria) NAO se aplica a eles.
--
-- ATENCAO — indice sobre a coluna CRUA, nao sobre LOWER(TRIM(email)): consultas que
-- normalizam nos dois lados (o padrao deste subsistema e o de
-- listarPendentesLembreteInicio) NAO usam estes indices; o SQLite cai em varredura de
-- tabela. E aceito DE PROPOSITO no volume atual (~550 leads / ~227 candidaturas): um
-- indice funcional resolveria, mas so vale a pena quando a varredura doer, e ate la ele
-- seria estrutura extra para manter. Isto e decisao registrada, nao descuido. Os indices
-- seguem uteis para busca/join por e-mail exato.
CREATE INDEX IF NOT EXISTS idx_applications_email       ON applications(email);
CREATE INDEX IF NOT EXISTS idx_talentos_email           ON talentos(email);
-- Fila de trabalho da varredura de envio: "os pendentes DESTA campanha". A ordem das
-- colunas segue o uso (igualdade em campanha_id, depois filtro por status).
CREATE INDEX IF NOT EXISTS idx_campanha_envios_pendentes ON campanha_envios(campanha_id, status);

-- ──────────────────────────────────────────────────────────────
-- Disparo em massa por WhatsApp (grupos regionais)
-- ──────────────────────────────────────────────────────────────

-- LIVRO-RAZAO do que ja saiu por WhatsApp. Uma linha por TELEFONE, para sempre.
--
-- ── A UNIDADE E O TELEFONE, e nao a pessoa nem a candidatura ──
-- Diferente de campanha_envios, cuja unidade e (campanha, e-mail). Aqui nao ha campanha:
-- o disparo e "o grupo da praca X", e uma pessoa entra no grupo UMA vez. Duas
-- candidaturas, ou candidatura + cadastro legado com o mesmo numero, sao a mesma pessoa
-- do outro lado do aparelho — e mandar duas vezes o mesmo convite e o erro mais visivel
-- que este subsistema pode cometer.
--
-- `telefone` e UNIQUE e ja chega NORMALIZADO (lib/whatsapp.normalizarTelefoneWhatsapp:
-- so digitos, com DDI). Quem escreve normaliza; quem le compara direto. Mesma disciplina
-- de `descadastros.email`. Sem isso, "+55 (47) 99958-2500" e "5547999582500" seriam duas
-- pessoas.
--
-- ── NAO EXISTE status 'pendente', e isso e desenho ──
-- Pendente e a AUSENCIA de linha. Modelar 'pendente' como valor exigiria materializar a
-- base inteira aqui antes de qualquer disparo — e ai a tabela teria que ser reconciliada
-- toda vez que alguem novo se candidatasse, mudasse de praca ou fosse importado. Como
-- ausencia, o publico e sempre calculado do estado ATUAL das bases de origem, e esta
-- tabela so guarda o fato consumado.
--
-- Consequencia aceita: nao ha como saber "quem esta na fila" olhando so esta tabela. Isso
-- e trabalho do motor de publico (lib/publicoDisparoWhatsapp), que e quem sabe as regras.
--
-- ── SEM OPT-OUT NESTA ETAPA ──
-- Decisao registrada: nao ha coluna de descadastro por WhatsApp por enquanto. Quando
-- houver, ela NAO deve ser um status desta tabela — 'enviado'/'erro' descrevem o que
-- aconteceu com uma tentativa, e opt-out e um estado da PESSOA, que precede a tentativa.
CREATE TABLE IF NOT EXISTS disparos_whatsapp (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  telefone   TEXT NOT NULL UNIQUE,  -- SEMPRE ja normalizado (so digitos, com DDI)
  nome       TEXT,
  -- 'enviado' = entrou no grupo / mensagem aceita pelo n8n.
  -- 'erro'    = tentou e falhou. A linha EXISTE, entao esse telefone sai da fila de
  --             pendentes tambem — reprocessar erro e decisao humana, nao automatica.
  -- Sem CHECK, pelo precedente do projeto para enum extensivel (ver talentos.categoria):
  -- o SQLite nao remove constraint depois. A validacao vive na rota.
  status     TEXT NOT NULL,
  erro_msg   TEXT,
  -- 'candidato' | 'legado' | 'historico_airtable'. De onde a pessoa veio quando o disparo
  -- aconteceu. Serve a auditoria; nada no app decide nada a partir deste campo.
  origem     TEXT,
  cidade     TEXT,               -- praca do disparo. NULL nos importados do historico.
  enviado_em TEXT,               -- NULL quando desconhecido (historico sem timestamp)
  criado_em  TEXT NOT NULL DEFAULT (datetime('now'))
);

-- ──────────────────────────────────────────────────────────────
-- Sequencia de WhatsApp (WA1/WA2) por instancia Baileys propria
-- ──────────────────────────────────────────────────────────────

-- Estado de autenticacao da sessao Baileys. E o "arquivo de credenciais" que o
-- useMultiFileAuthState guardaria em disco, aqui em SQLite — porque o disco do container
-- e efemero e o volume persistente ja e o banco.
--
-- ── O VALOR VAI CIFRADO ──
-- `value` guarda o JSON serializado com BufferJSON.replacer, selado com AES-256-GCM
-- (lib/whatsappSecrets, chave em WHATSAPP_SECRETS_KEY). Sao credenciais que permitem
-- ENVIAR MENSAGEM COMO O JEAN: um dump do banco nao pode entregar isso em texto claro.
--
-- PK COMPOSTA (instance_id, key): o Baileys guarda dezenas de chaves por sessao
-- ('creds', 'app-state-sync-key-...', 'pre-key-...', 'session-...'). `instance_id` existe
-- para o dia em que houver mais de um numero; hoje e sempre 'jean'.
CREATE TABLE IF NOT EXISTS baileys_auth (
  instance_id TEXT NOT NULL DEFAULT 'jean',
  key         TEXT NOT NULL,
  value       TEXT NOT NULL,   -- JSON (BufferJSON) CIFRADO
  updated_at  TEXT NOT NULL,
  PRIMARY KEY (instance_id, key)
);

-- Fila da sequencia WA1/WA2. Uma linha por (candidatura, etapa).
--
-- ── POR QUE UMA FILA, e nao envio no ato da candidatura ──
-- WA2 sai 4h depois — precisa de fila por definicao. WA1 sai "imediato", mas passa pela
-- MESMA fila de proposito: se o envio fosse inline no POST /api/aplicacao, uma queda do
-- WhatsApp faria a candidatura falhar (ou exigiria try/catch que engole erro em silencio).
-- Na fila, a candidatura conclui sempre e a mensagem e problema do job.
--
-- Diferente de campanha_envios em dois pontos que importam:
--   - a unidade aqui e (application, etapa), nao (campanha, email);
--   - `agendado_para` existe: campanha_envios drena tudo o que esta pendente, esta fila
--     respeita relogio.
--
-- `status`: 'pendente' -> 'enviado' -> 'entregue' (ack do WhatsApp) | 'falha'.
-- 'entregue' e uma transicao a mais que a campanha de e-mail nao tem — o Baileys devolve
-- ack de entrega, e e a unica forma de saber que a mensagem chegou ao aparelho.
-- Sem CHECK, pelo precedente do projeto para enum extensivel (ver talentos.categoria).
CREATE TABLE IF NOT EXISTS whatsapp_sequencia_envios (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  application_id INTEGER NOT NULL,
  etapa          TEXT NOT NULL,          -- 'wa1' | 'wa2'
  telefone_e164  TEXT NOT NULL,          -- normalizado (so digitos, com DDI)
  template_nome  TEXT,
  status         TEXT NOT NULL DEFAULT 'pendente',
  agendado_para  TEXT NOT NULL,          -- ISO; o job so olha o que ja venceu
  enviado_em     TEXT,
  entregue_em    TEXT,
  erro           TEXT,
  tentativas     INTEGER NOT NULL DEFAULT 0,
  criado_em      TEXT NOT NULL DEFAULT (datetime('now')),
  -- Idempotencia: uma candidatura tem UM WA1 e UM WA2, nunca dois. E a mesma protecao do
  -- UNIQUE(campanha_id, email) da campanha — sem ela, um bug de agendamento vira mensagem
  -- duplicada no aparelho de alguem.
  UNIQUE (application_id, etapa)
);

-- A consulta do job: "o que ja venceu e ainda nao saiu". A ordem das colunas segue o uso
-- (igualdade em status, depois faixa em agendado_para).
CREATE INDEX IF NOT EXISTS idx_wa_seq_fila ON whatsapp_sequencia_envios(status, agendado_para);

-- ──────────────────────────────────────────────────────────────
-- Campanha em massa por WhatsApp — Meta Cloud API (oficial)
-- ──────────────────────────────────────────────────────────────
--
-- FRENTE SEPARADA do Baileys (whatsapp_sequencia_envios / baileys_auth), e a separacao e
-- estrutural, nao organizacional: a Cloud API e HTTP stateless com TEMPLATE APROVADO
-- PREVIAMENTE pela Meta; o Baileys e socket persistente com texto livre. Os dois contratos
-- divergem exatamente no que mais importa — o que pode ser dito — entao nao ha fachada que
-- os unifique sem mentir sobre um dos dois.
--
-- ⚠️ RESTRICAO DE PLATAFORMA: um numero registrado num WABA NAO pode ser usado via Baileys.
-- Se as duas frentes usarem o mesmo numero, elas sao mutuamente exclusivas.

-- Templates aprovados na Meta. Espelho LOCAL do que existe la — nao e a fonte da verdade.
--
-- A Meta aprova (ou rejeita, ou revoga depois) cada template, e o texto vive no painel dela.
-- Aqui guardamos so o que o codigo precisa para MONTAR a chamada: o nome exato, o idioma, e
-- quais variaveis posicionais preencher com quais campos nossos.
CREATE TABLE IF NOT EXISTS templates_whatsapp (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  -- Nome EXATO registrado na Meta. UNIQUE porque e a chave de chamada da API: dois registros
  -- com o mesmo nome significariam duas configuracoes para a mesma coisa la fora.
  nome_meta     TEXT NOT NULL UNIQUE,
  idioma        TEXT NOT NULL DEFAULT 'pt_BR',
  -- 'marketing' cobra mais e exige opt-in verificavel; 'utility' e para acompanhamento de
  -- algo que a pessoa iniciou. A escolha errada aqui e motivo de rejeicao ou de conta
  -- penalizada, entao o CHECK trava os tres valores que a Meta reconhece.
  categoria     TEXT NOT NULL CHECK (categoria IN ('marketing', 'utility', 'authentication')),
  -- JSON: [{posicao:1, campo:'nome_primeiro'}, ...]. As variaveis da Meta sao POSICIONAIS
  -- ({{1}}, {{2}}); este mapa e o que liga cada posicao a um dado nosso.
  variaveis     TEXT NOT NULL,
  ativo         INTEGER NOT NULL DEFAULT 1,
  criado_em     TEXT NOT NULL DEFAULT (datetime('now')),
  atualizado_em TEXT
);

-- Link do grupo de WhatsApp por praca.
--
-- ── POR QUE TABELA PROPRIA, e nao coluna em `jobs` ──
-- O grupo e da PRACA, nao da vaga: duas vagas em Joinville compartilham o mesmo grupo. Uma
-- coluna em `jobs` obrigaria a repetir (e manter sincronizado) o mesmo link em cada vaga da
-- cidade — e o primeiro link desatualizado seria indistinguivel do certo.
--
-- `cidade` e UNIQUE e usa o vocabulario fechado de lib/cidades (as 9 pracas). Nao ha FK
-- porque o enum vive no codigo, nao numa tabela — mesmo desenho de jobs.cidade.
--
-- `link_convite_grupo` e NULLABLE de proposito: as linhas nascem vazias e o operador
-- preenche pela tela. Praca sem link nao pode receber campanha, e o job trata isso como
-- erro DAQUELE envio (nao do ciclo) — ver lib/campanhaWhatsapp.
CREATE TABLE IF NOT EXISTS regioes_grupos_whatsapp (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  cidade             TEXT NOT NULL UNIQUE,
  link_convite_grupo TEXT,
  ativo              INTEGER NOT NULL DEFAULT 1,
  criado_em          TEXT NOT NULL DEFAULT (datetime('now')),
  atualizado_em      TEXT
);

-- Uma campanha: um template disparado para um recorte da base.
--
-- Espelha `campanhas` (e-mail) na forma, com duas diferencas: o conteudo NAO mora aqui (mora
-- na Meta, no template) e ha `pausada` — porque um disparo de WhatsApp que precisa parar no
-- meio e caso previsto, nao excecao.
CREATE TABLE IF NOT EXISTS campanhas_whatsapp (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  nome         TEXT NOT NULL,
  template_id  INTEGER NOT NULL REFERENCES templates_whatsapp(id),
  base_alvo    TEXT NOT NULL CHECK (base_alvo IN ('applications', 'talentos', 'ambos')),
  status       TEXT NOT NULL DEFAULT 'rascunho'
                 CHECK (status IN ('rascunho', 'ativa', 'pausada', 'concluida')),
  criado_em    TEXT NOT NULL DEFAULT (datetime('now')),
  iniciada_em  TEXT,
  concluida_em TEXT
);

-- Fila de envios da campanha. Uma linha por (campanha, telefone).
--
-- ── QUATRO ESTADOS A MAIS QUE campanha_envios, e cada um tem razao ──
--   'entregue'  ack de entrega da Meta (webhook). O e-mail nao tem equivalente confiavel.
--   'lido'      confirmacao de leitura (webhook), quando o usuario a permite.
--   'opt_out'   a pessoa pediu para sair ANTES de esta linha sair. Distinto de 'falha':
--               falha e problema tecnico, opt_out e vontade da pessoa, e misturar os dois
--               apagaria a unica metrica que diz se a campanha esta incomodando.
--
-- `wamid` e o id que a Meta devolve no aceite. E a UNICA forma de casar um evento de webhook
-- com a linha que o originou — sem ele, entrega e leitura chegam sem dono.
--
-- `cidade` fica NA LINHA, e nao e resolvida no envio a partir da origem: o recorte foi
-- decidido na materializacao, e recalcular depois faria uma pessoa que mudou de praca
-- receber o link de um grupo diferente do que a campanha prometeu.
CREATE TABLE IF NOT EXISTS campanha_whatsapp_envios (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  campanha_id INTEGER NOT NULL REFERENCES campanhas_whatsapp(id),
  telefone    TEXT NOT NULL,          -- SEMPRE normalizado (so digitos, com DDI)
  nome        TEXT,
  origem_tipo TEXT NOT NULL CHECK (origem_tipo IN ('application', 'talento')),
  origem_id   INTEGER,
  cidade      TEXT,
  status      TEXT NOT NULL DEFAULT 'pendente'
                CHECK (status IN ('pendente', 'enviado', 'entregue', 'lido', 'falha', 'opt_out')),
  wamid       TEXT,
  enviado_em  TEXT,
  erro        TEXT,
  tentativas  INTEGER NOT NULL DEFAULT 0,
  criado_em   TEXT NOT NULL DEFAULT (datetime('now')),
  -- Mesma protecao do UNIQUE(campanha_id, email) da campanha de e-mail: uma pessoa recebe a
  -- mesma campanha UMA vez. Sem isso, um bug de materializacao vira mensagem duplicada no
  -- aparelho de alguem — e no WhatsApp isso e denuncia, que custa o numero.
  UNIQUE (campanha_id, telefone)
);

-- A fila de trabalho do job (igualdade em campanha_id, depois filtro por status).
CREATE INDEX IF NOT EXISTS idx_campanha_wa_envios_pendentes
  ON campanha_whatsapp_envios(campanha_id, status);
-- Casamento de evento de webhook -> linha. Sem indice, cada ack seria varredura de tabela.
CREATE INDEX IF NOT EXISTS idx_campanha_wa_envios_wamid
  ON campanha_whatsapp_envios(wamid);

-- Opt-out por TELEFONE. Irmao de `descadastros` (que e por e-mail) e deliberadamente
-- separado dele: sao canais diferentes, e sair de um nao e sair do outro.
--
-- PK e o telefone JA NORMALIZADO — quem escreve normaliza, quem le compara direto, mesma
-- disciplina de descadastros.email e disparos_whatsapp.telefone.
--
-- Sem coluna de "reinscricao": desfazer um opt-out e apagar a linha, acao deliberada e rara,
-- e nao alternar um flag que um bug poderia inverter em massa.
CREATE TABLE IF NOT EXISTS whatsapp_opt_out (
  telefone  TEXT PRIMARY KEY,
  origem    TEXT,                     -- 'resposta_webhook' | 'manual'
  criado_em TEXT NOT NULL DEFAULT (datetime('now'))
);
