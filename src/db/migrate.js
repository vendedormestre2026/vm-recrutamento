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

  // Rastro da falha de avaliacao. Ate aqui, quando a chamada ao LLM avaliador estourava
  // o timeout (ou o parse da resposta lancava), a excecao subia ate finalizarEntrevista,
  // que so fazia console.error + status_ia='erro': NENHUMA linha era criada em reports e
  // a mensagem do erro so existia no stdout do Railway, que some a cada redeploy.
  // Agora o caminho de erro grava uma linha com status='erro' (valor JA previsto no CHECK
  // da coluna status, criado na Fase 4 — nao ha coluna de status nova aqui) mais estas
  // duas: a mensagem truncada e o momento da falha. Ambas nullable, sem CHECK; reports
  // bem-sucedidos e os anteriores a esta migracao ficam NULL e nao mudam de comportamento.
  adicionarColunaSeFaltar('reports', 'erro_mensagem', 'TEXT');
  adicionarColunaSeFaltar('reports', 'erro_em', 'TEXT');

  // Item 7.6 - formato Victoria. jobs.requisitos_obrigatorios: JSON array de strings,
  // requisitos "must-have" da vaga (ex.: "Experiencia em vendas", "Perfil SDR"),
  // DISTINTOS de skills/requisitos (desejaveis/informativos). reports.requisitos: JSON
  // array do veredito da IA por requisito — [{ requisito, veredito:
  // 'atende'|'parcial'|'nao_atende', evidencia: <trecho da transcricao validado>|null }].
  // Ambos nullable; relatorios/vagas antigos ficam NULL e nao quebram.
  adicionarColunaSeFaltar('jobs', 'requisitos_obrigatorios', 'TEXT');
  adicionarColunaSeFaltar('reports', 'requisitos', 'TEXT');
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

  // Praca da vaga, com vocabulario FECHADO (lib/cidades.CIDADES_VALIDAS). Fica ao lado de
  // `endereco` porque as duas respondem perguntas diferentes: `endereco` e "onde
  // exatamente" (texto livre, continua como esta); esta e "qual praca" — dado categorico,
  // no mesmo pe de `modalidade` e `regime`, que ja sao enums neste mesmo bloco.
  //
  // NULL e valor legitimo e esperado: vaga remota nao tem praca. Dai TEXT simples, sem
  // NOT NULL e sem CHECK — o CHECK, alem de nao poder ser adicionado depois no SQLite sem
  // recriar a tabela, travaria a lista no schema. O precedente do projeto para enum
  // extensivel e validar no app (ver a nota de talentos.categoria em schema.sql), e e o
  // que normalizarCidade fara.
  adicionarColunaSeFaltar('jobs', 'cidade', 'TEXT');

  // Fase 5 - gravacao de video: link compartilhavel do Google Drive por entrevista.
  adicionarColunaSeFaltar('interviews', 'video_url', 'TEXT');

  // Item 7.5 - roleplay estruturado: ponteiro de progresso persistido (SO modo real),
  // com orcamento de trocas por bloco. progresso_indice = posicao no array de perguntas
  // (substitui o calculo por contagem bruta de turnos, evitando dessincronizar os chips
  // quando a Vera sustenta um roleplay por varias trocas). progresso_trocas = quantas
  // trocas ja ocorreram dentro do bloco atual, contra max_trocas do bloco (default 1 =
  // avanca imediatamente, igual ao comportamento anterior). Default 0/0.
  adicionarColunaSeFaltar('interviews', 'progresso_indice', 'INTEGER DEFAULT 0');
  adicionarColunaSeFaltar('interviews', 'progresso_trocas', 'INTEGER DEFAULT 0');

  // Tempo (ms) que a entrevista passou PARADA e que NAO deve contar como duracao.
  // O teto MAX_DURACAO_MIN sempre foi medido em tempo de relogio desde iniciado_em, entao
  // uma retomada horas/dias depois ja nascia estourada e encerrava na 1a resposta. Agora o
  // hiato detectado na retomada (acima de LIMIAR_PAUSA_MS) e acumulado aqui e descontado.
  // iniciado_em segue IMUTAVEL — continua sendo o inicio real, exibido no relatorio.
  // Sessao continua normal nunca sai de 0, preservando o comportamento historico.
  adicionarColunaSeFaltar('interviews', 'tempo_pausado_ms', 'INTEGER NOT NULL DEFAULT 0');

  // Item 7.4 - cultura/rotinas do dia a dia da empresa (ex.: "reuniao diaria as 8h com
  // oracao", "atendimento sempre formal com o cliente"). Usado para contextualizar a
  // pergunta de Principios na entrevista (system prompt da conducao). Diferente de
  // sobre_empresa (institucional, voltado ao candidato na pagina da vaga). Opcional/NULL.
  adicionarColunaSeFaltar('jobs', 'cultura_empresa', 'TEXT');

  // B3 - nome da EMPRESA cliente dona da vaga (ex.: "Acme Ltda"). DISTINTO de
  // sobre_empresa/cultura_empresa (textos livres): e o nome curto usado na mensagem de
  // WhatsApp ao candidato ("...da empresa {empresa}"). Opcional/NULL: vagas sem empresa
  // preenchida omitem o trecho. Aditiva, sem CHECK.
  adicionarColunaSeFaltar('jobs', 'empresa', 'TEXT');

  // Item 8 - video introdutorio da vaga (YouTube nao listado), exibido numa etapa do
  // funil ANTES das permissoes. Campo polimorfico (tipo + ref) para permitir upload
  // direto no futuro sem re-migrar. video_intro_tipo: 'youtube' hoje (extensivel para
  // 'upload'/'vimeo'). video_intro_ref: ID CANONICO do YouTube (normalizado no save via
  // extrairYoutubeId, nunca a URL bruta) — o significado depende de video_intro_tipo.
  // Ambos nullable: vaga sem video fica NULL e a etapa e pulada.
  adicionarColunaSeFaltar('jobs', 'video_intro_tipo', 'TEXT');
  adicionarColunaSeFaltar('jobs', 'video_intro_ref', 'TEXT');

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

  // Origem do lead (first-touch): utm_source capturado no cookie vm_utm na Pagina da
  // Vaga e persistido na criacao da application. NULL em bancos antigos; novas linhas
  // gravam a origem ou 'direto' quando nao ha UTM. Aditiva, sem CHECK.
  adicionarColunaSeFaltar('applications', 'utm_source', 'TEXT');
  // Demais parametros UTM (first-touch, mesmo cookie vm_utm). Diferente de utm_source,
  // NAO recebem o literal 'direto' quando ausentes: ficam NULL. Aditivas, sem CHECK.
  adicionarColunaSeFaltar('applications', 'utm_medium', 'TEXT');
  adicionarColunaSeFaltar('applications', 'utm_campaign', 'TEXT');
  adicionarColunaSeFaltar('applications', 'utm_content', 'TEXT');
  adicionarColunaSeFaltar('applications', 'utm_term', 'TEXT');

  // Painel do recrutador - soft-delete de lead: momento do arquivamento (ISO/UTC).
  // NULL = ativo. Aditiva (sem default/CHECK/DROP). Arquivados saem da listagem do
  // painel, mas o historico e preservado; reversivel via restaurarAplicacao.
  adicionarColunaSeFaltar('applications', 'deleted_at', 'TEXT');

  // status_ia: veredito automatico da IA. Escrito SOMENTE pelo fluxo de
  //   avaliacao (finalizarEntrevista + gerarRelatorio). Maquina de estados:
  //   NULL (nunca finalizado) -> 'processando' -> terminal:
  //   'avancar'|'talvez'|'descartar'|'indefinido'|'erro'.
  // Sem CHECK (segue o padrao de reports.recomendacao, validado no app, para
  // nao travar bancos legados).
  adicionarColunaSeFaltar('applications', 'status_ia', 'TEXT');
  // status_recrutador: decisao HUMANA do recrutador (item 3 do backlog).
  //   Criada aqui vazia; nenhuma logica a escreve/le ainda neste incremento.
  //   Nasce NULL e permanece NULL ate o item 3.
  adicionarColunaSeFaltar('applications', 'status_recrutador', 'TEXT');

  // B4 - primeiro contato via WhatsApp: momento em que o recrutador clicou no botao de
  // WhatsApp deste candidato (ISO/UTC). Gravado uma unica vez (preserva a data do 1o
  // contato); NULL = ainda nao contatado. Aditiva, sem CHECK.
  adicionarColunaSeFaltar('applications', 'contatado_whatsapp_em', 'TEXT');

  // Follow-up automatico de entrevista NAO concluida (varredura em lib/followupEntrevista).
  // Momento (ISO/UTC) em que cada um dos DOIS e-mails de follow-up foi enviado; NULL = ainda
  // nao enviado. Sao o registro de idempotencia da varredura: ela so seleciona quem tem a
  // coluna da etapa em NULL, entao um e-mail nunca sai duas vezes.
  // Proposital NAO reaproveitar enviado_retomada_em: aquele e o fluxo REATIVO (o candidato
  // pede o link quando a camera falha) e tem throttle proprio de 30 min — misturar os dois
  // faria um suprimir o outro. Aditivas, sem CHECK.
  adicionarColunaSeFaltar('applications', 'followup_entrevista_1_enviado_em', 'TEXT');
  adicionarColunaSeFaltar('applications', 'followup_entrevista_2_enviado_em', 'TEXT');

  // E-mail automatico de recusa: momento (ISO/UTC) em que o candidato foi avisado de que
  // nao seguimos com a candidatura; NULL = ainda nao avisado. E o registro de idempotencia
  // da varredura de lib/emailRecusa — ela so seleciona quem tem esta coluna em NULL, entao
  // ninguem recebe a recusa duas vezes.
  // Mora em applications (e nao em reports) de proposito: a garantia que interessa e "este
  // CANDIDATO nao recebe duas recusas". Um reprocessamento de relatorio cria uma linha nova
  // em reports; com o controle aqui, isso nao dispara um segundo e-mail. Segue o padrao das
  // demais notificacoes ao candidato (enviado_retomada_em, followup_entrevista_*). Aditiva.
  adicionarColunaSeFaltar('applications', 'email_recusa_enviado_em', 'TEXT');

  // Lembrete de INICIO de entrevista: momento (ISO/UTC) em que avisamos o candidato que
  // se candidatou mas nunca abriu a entrevista; NULL = ainda nao lembrado. E o registro de
  // idempotencia da varredura de lib/lembreteInicio — ela so seleciona quem tem esta
  // coluna em NULL, entao ninguem recebe o lembrete duas vezes.
  // Publico DISTINTO do followup_entrevista_*: aquelas colunas sao de quem COMECOU a
  // entrevista e parou no meio; esta e de quem nunca chegou a comecar (status 'aplicado',
  // sem nenhuma linha em interviews). Coluna separada de proposito — sao dois e-mails
  // diferentes, para dois momentos diferentes, e um nao pode suprimir o outro. Aditiva.
  adicionarColunaSeFaltar('applications', 'lembrete_inicio_enviado_em', 'TEXT');

  // Origem do lead no TOPO do funil (first-touch): mesma UTM do cookie vm_utm, agora
  // tambem gravada no acesso a Pagina da Vaga (antes so a application guardava). Permite
  // atribuir Acessos a uma origem no dashboard. NULL em bancos antigos e quando nao ha
  // UTM na visita (sem literal 'direto' aqui). Aditivas, sem CHECK.
  adicionarColunaSeFaltar('vaga_acessos', 'utm_source', 'TEXT');
  adicionarColunaSeFaltar('vaga_acessos', 'utm_medium', 'TEXT');
  adicionarColunaSeFaltar('vaga_acessos', 'utm_campaign', 'TEXT');
  adicionarColunaSeFaltar('vaga_acessos', 'utm_content', 'TEXT');
  adicionarColunaSeFaltar('vaga_acessos', 'utm_term', 'TEXT');

  // Atribuicao exata de clique a uma campanha. Vem do parametro `campanha_id` do link do
  // e-mail; NULL para todo acesso organico.
  //
  // SEM a clausula REFERENCES aqui, ao contrario do schema.sql: o SQLite nao aceita
  // ADD COLUMN com chave estrangeira (erro "Cannot add a REFERENCES column with non-NULL
  // default" nao se aplica, mas a FK simplesmente nao e criada em tabela ja existente).
  // Bancos novos ganham a FK pelo CREATE TABLE; o banco de producao fica sem ela. A
  // integridade real vem do app, que so grava um id depois de confirmar que a campanha
  // existe (ver registrarAcessoVaga) — mesma disciplina de campanha_envios.origem_id, que
  // tambem nao tem FK e por razao parecida.
  adicionarColunaSeFaltar('vaga_acessos', 'campanha_id', 'INTEGER');

  // Importacao da base legada para o Banco de Talentos. As TRES colunas sao aditivas,
  // nullable e sem CHECK — nenhuma linha existente e tocada, e os ~550 talentos cadastrados
  // via /bancodecurriculos ficam com as tres em NULL, que e a leitura correta: eles nao sao
  // legado, nao tem cargo declarado nesse formato e nao tem metadados de origem.
  //
  // PRIMEIRA migracao incremental que toca `talentos`: ate aqui a tabela existia so pelo
  // CREATE TABLE IF NOT EXISTS do schema.sql — que NAO altera tabela ja criada. Sem estas
  // tres linhas, as colunas novas existiriam apenas em bancos criados do zero, e producao
  // seguiria sem elas ate alguem perceber pelo erro do INSERT.
  //
  // categoria: 'legado' para os importados; NULL para cadastro proprio. Sem CHECK de
  //   proposito (SQLite nao remove constraint depois; a allowlist mora em sqlite.js, mesmo
  //   padrao de applications.status_ia).
  // cargo: cargo normalizado completo da origem. Convive com perfil_interesse em vez de
  //   substitui-lo — so SDR e Closer mapeiam no enum SDR|CLOSER daquela coluna, e os outros
  //   quatro cargos ficariam sem representacao fiel se fossem forcados la dentro.
  // campos_extras: JSON com empresa, codigo da vaga original e utm_source da origem.
  //   Mesmo nome da coluna homonima de applications, e mesma natureza (saco de metadados),
  //   mas SEM relacao com ela — aquela esta orfa e nao e mais coletada.
  adicionarColunaSeFaltar('talentos', 'categoria', 'TEXT');
  adicionarColunaSeFaltar('talentos', 'cargo', 'TEXT');
  adicionarColunaSeFaltar('talentos', 'campos_extras', 'TEXT');

  // Praca de atuacao. Nasce vazia para todo mundo e e preenchida por BACKFILL nos
  // importados (src/scripts/limpeza-legado.js), derivada de campos_extras.empresa_origem
  // por dicionario exato — cada empresa da base antiga atendia uma praca.
  //
  // Nullable e sem CHECK como as tres acima: NULL = cidade desconhecida, que e o estado
  // de todo cadastro proprio (/bancodecurriculos nao coleta cidade). E ha um valor
  // SENTINELA, 'Todas as cidades', que NAO significa ausencia — significa presenca em
  // qualquer praca. Um CHECK aqui congelaria a lista de cidades no schema, e cidade e
  // exatamente o tipo de dado que ganha valor novo sem aviso.
  adicionarColunaSeFaltar('talentos', 'cidade', 'TEXT');

  // Contador de tentativas de envio de campanha. NOT NULL DEFAULT 0 e seguro em ADD COLUMN
  // porque o default e constante — as 6.230 linhas ja existentes recebem 0, que e a leitura
  // correta: elas nunca foram retentadas, porque retentativa nao existia.
  //
  // Nasce da apuracao das 2.945 falhas: TODAS foram limite de vazao (429 do Emailit, teto
  // diario do ZeptoMail), nenhuma foi bounce ou endereco invalido. Sem contador nao ha como
  // distinguir "falhou uma vez por rajada" de "falhou cinco vezes, desista".
  adicionarColunaSeFaltar('campanha_envios', 'tentativas', 'INTEGER NOT NULL DEFAULT 0');

  // ── Sequencia de WhatsApp (WA1/WA2): confirmacao MANUAL do video do WA2 ──
  //
  // Nao ha webhook nem correlacao automatica por telefone: o recrutador assiste ao video e
  // marca no painel. As tres colunas guardam a decisao dele, e nao um estado inferido.
  //
  //   wa2_video_recebido_em     quando o recrutador CONFIRMOU (nao quando o video chegou —
  //                             isso ninguem sabe). NULL = ainda nao confirmado.
  //   wa2_video_dentro_prazo    'sim' | 'nao' | 'na'. Texto e nao INTEGER porque sao TRES
  //                             estados: um booleano precisaria de um segundo campo para
  //                             expressar "nao se aplica", e dois campos para um conceito
  //                             so e como se perde a consistencia.
  //   wa2_video_confirmado_por  quem marcou. O painel tem login unico hoje, mas registrar
  //                             quem decidiu e barato agora e impossivel de reconstruir
  //                             depois.
  adicionarColunaSeFaltar('applications', 'wa2_video_recebido_em', 'TEXT');
  adicionarColunaSeFaltar('applications', 'wa2_video_dentro_prazo', 'TEXT');
  adicionarColunaSeFaltar('applications', 'wa2_video_confirmado_por', 'TEXT');

  // Indices ficam aqui (e nao no schema.sql) porque dependem de colunas adicionadas
  // acima, que em bancos antigos so passam a existir depois do ADD COLUMN.
  const db = getDb();
  db.exec('CREATE INDEX IF NOT EXISTS idx_vaga_acessos_utm ON vaga_acessos(utm_source)');
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
