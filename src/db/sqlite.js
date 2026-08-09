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
// Modulo-FOLHA, sem nenhuma dependencia do projeto — e o que torna seguro a camada de
// dados importa-lo (ver o cabecalho dele). NAO troque este require pelo de
// lib/descadastro, que reexporta a mesma funcao: aquele modulo depende de ../config hoje
// e pode passar a depender de ../db amanha, fechando um ciclo db -> lib -> db que, em
// CommonJS, nao falha no require e sim em runtime.
const { normalizarEmail } = require('../lib/normalizarEmail');

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
       descricao, sobre_empresa, cultura_empresa, empresa, video_intro_tipo, video_intro_ref,
       roteiro_id, ativo, entrevista_ativa)
    VALUES
      (@slug, @titulo, @perfil, @faixa_pagamento, @potencial_ganhos, @skills,
       @beneficios, @atividades, @requisitos, @requisitos_obrigatorios, @secoes_extras,
       @endereco, @modalidade, @regime, @horario,
       @descricao, @sobre_empresa, @cultura_empresa, @empresa, @video_intro_tipo, @video_intro_ref,
       @roteiro_id, @ativo, @entrevista_ativa)
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
    empresa: vaga.empresa || null,
    // Item 8 — video introdutorio (TEXT simples, sem JSON): tipo + ID canonico.
    video_intro_tipo: vaga.video_intro_tipo || null,
    video_intro_ref: vaga.video_intro_ref || null,
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
         empresa          = @empresa,
         video_intro_tipo = @video_intro_tipo,
         video_intro_ref  = @video_intro_ref,
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
      empresa: campos.empresa || null,
      // Item 8 — video introdutorio (TEXT simples, sem JSON): tipo + ID canonico.
      video_intro_tipo: campos.video_intro_tipo || null,
      video_intro_ref: campos.video_intro_ref || null,
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

// Perfis ideais de curriculo (Banco de Curriculos)
// Mesma anatomia de roteiros: `estrutura` e JSON serializado na escrita e parseado na
// leitura (perfilCurriculoDeLinha), para o app so lidar com objetos.
function perfilCurriculoDeLinha(linha) {
  if (!linha) return null;
  return { ...linha, estrutura: lerJson(linha.estrutura, {}) };
}

function criarPerfilCurriculo(perfilCurriculo) {
  const info = getDb().prepare(`
    INSERT INTO perfis_curriculo (nome, perfil, versao, estrutura)
    VALUES (@nome, @perfil, @versao, @estrutura)
  `).run({
    nome: perfilCurriculo.nome,
    perfil: perfilCurriculo.perfil,
    versao: perfilCurriculo.versao || 1,
    estrutura: JSON.stringify(perfilCurriculo.estrutura || {}),
  });
  return Number(info.lastInsertRowid);
}

function listarPerfisCurriculo() {
  return getDb()
    .prepare('SELECT * FROM perfis_curriculo ORDER BY criado_em DESC')
    .all()
    .map(perfilCurriculoDeLinha);
}

function buscarPerfilCurriculo(id) {
  return perfilCurriculoDeLinha(
    getDb().prepare('SELECT * FROM perfis_curriculo WHERE id = ?').get(id),
  );
}

// Perfil ideal de curriculo "ativo" para um perfil (SDR/CLOSER): o mais recentemente
// atualizado (ORDER BY atualizado_em DESC). null quando ainda nao ha nenhum cadastrado —
// o motor de analise trata como "sem perfil, cadastro segue sem analise".
function buscarPerfilCurriculoAtivoPara(perfil) {
  return perfilCurriculoDeLinha(
    getDb()
      .prepare(
        'SELECT * FROM perfis_curriculo WHERE perfil = ? ORDER BY atualizado_em DESC LIMIT 1',
      )
      .get(perfil),
  );
}

// Atualiza nome + estrutura (JSON, serializado aqui — espelha atualizarEstruturaRoteiro).
// O perfil (SDR/CLOSER) e fixo apos a criacao, igual a vagas (perfilEditavel: false).
// Retorna o numero de linhas afetadas (0 se o id nao existir).
function atualizarPerfilCurriculo(id, { nome, estrutura }) {
  const info = getDb()
    .prepare(
      "UPDATE perfis_curriculo SET nome = ?, estrutura = ?, atualizado_em = datetime('now') WHERE id = ?",
    )
    .run(nome, JSON.stringify(estrutura || {}), id);
  return info.changes;
}

// Talentos (Banco de Curriculos)
// Cria o cadastro do banco de talentos. consent_at recebe datetime('now') direto no
// INSERT (mesma tatica de criarAplicacao: a rota so chega aqui apos validar o checkbox
// de consentimento LGPD — finalidade "banco de talentos"). `analise` (T3) e o JSON do
// motor de analise, serializado aqui (objeto na entrada; NULL = cadastro sem analise —
// perfil ideal inexistente ou analise que falhou). `status` fica no default 'novo'.
function criarTalento(talento) {
  const info = getDb().prepare(`
    INSERT INTO talentos
      (nome, email, telefone, perfil_interesse, linkedin_url,
       curriculo_path, curriculo_texto, analise, consent_at)
    VALUES
      (@nome, @email, @telefone, @perfil_interesse, @linkedin_url,
       @curriculo_path, @curriculo_texto, @analise, datetime('now'))
  `).run({
    nome: talento.nome || null,
    email: talento.email || null,
    telefone: talento.telefone || null,
    perfil_interesse: talento.perfil_interesse || null,
    linkedin_url: talento.linkedin_url || null,
    curriculo_path: talento.curriculo_path || null,
    curriculo_texto: talento.curriculo_texto || null,
    analise: talento.analise ? JSON.stringify(talento.analise) : null,
  });
  return Number(info.lastInsertRowid);
}

// Enums de talento (espelham os CHECK do schema em talentos). Validados no app antes das
// queries (mesmo padrao de STATUS_RECRUTADOR_VALIDOS): entrada fora do enum e ignorada.
const PERFIS_VALIDOS = ['SDR', 'CLOSER'];
const STATUS_TALENTO_VALIDOS = ['novo', 'contatado', 'descartado', 'convertido'];

// Converte a linha crua em objeto do app, parseando `analise` (JSON) — mesmo padrao de
// perfilCurriculoDeLinha. `analise` NULL/invalido vira null (nunca quebra a leitura).
function talentoDeLinha(linha) {
  if (!linha) return null;
  return { ...linha, analise: linha.analise ? lerJson(linha.analise, null) : null };
}

// Lista talentos com filtro OPCIONAL por perfil_interesse e/ou status, ORDER BY
// criado_em DESC. Sem filtro, lista todos. Filtros invalidos sao IGNORADOS (tratados
// como ausentes) — a rota tambem saneia, mas a camada de dados nao confia na entrada.
function listarTalentos({ perfil, status } = {}) {
  const where = [];
  const params = [];
  if (PERFIS_VALIDOS.includes(perfil)) {
    where.push('perfil_interesse = ?');
    params.push(perfil);
  }
  if (STATUS_TALENTO_VALIDOS.includes(status)) {
    where.push('status = ?');
    params.push(status);
  }
  const sql =
    'SELECT * FROM talentos' +
    (where.length ? ` WHERE ${where.join(' AND ')}` : '') +
    ' ORDER BY criado_em DESC';
  return getDb().prepare(sql).all(...params).map(talentoDeLinha);
}

// Um talento por id, com `analise` ja parseada. null se nao existir.
function buscarTalento(id) {
  return talentoDeLinha(getDb().prepare('SELECT * FROM talentos WHERE id = ?').get(id));
}

// Atualiza o status do talento. Valida contra o enum do schema ANTES do UPDATE: status
// invalido nao gera query (retorna 0). Retorna o numero de linhas afetadas (0 se o id
// nao existir ou o status for invalido).
function atualizarStatusTalento(id, status) {
  const v = status != null ? String(status).trim().toLowerCase() : '';
  if (!STATUS_TALENTO_VALIDOS.includes(v)) return 0;
  const info = getDb().prepare('UPDATE talentos SET status = ? WHERE id = ?').run(v, id);
  return info.changes;
}

// Aplicacoes
// Cria a aplicacao. consent_at recebe datetime('now') direto no INSERT: a rota so
// chega aqui apos validar o checkbox de consentimento (LGPD), entao criar a linha ja
// significa que o candidato consentiu — o momento da criacao e o momento do aceite.
function criarAplicacao(aplicacao) {
  const info = getDb().prepare(`
    INSERT INTO applications
      (job_id, nome, sobrenome, email, telefone, linkedin_url,
       curriculo_path, curriculo_texto, campos_extras, token,
       utm_source, utm_medium, utm_campaign, utm_content, utm_term, status, consent_at)
    VALUES
      (@job_id, @nome, @sobrenome, @email, @telefone, @linkedin_url,
       @curriculo_path, @curriculo_texto, @campos_extras, @token,
       @utm_source, @utm_medium, @utm_campaign, @utm_content, @utm_term, @status, datetime('now'))
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
    // utm_source preserva o comportamento atual (o chamador passa 'direto' quando
    // ausente). Os demais UTM ficam NULL quando ausentes — sem inventar 'direto' p/ eles.
    utm_source: aplicacao.utm_source || null,
    utm_medium: aplicacao.utm_medium || null,
    utm_campaign: aplicacao.utm_campaign || null,
    utm_content: aplicacao.utm_content || null,
    utm_term: aplicacao.utm_term || null,
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

// B4 - primeiro contato via WhatsApp: grava contatado_whatsapp_em = agora SO se ainda
// estiver NULL (preserva a data do 1o contato; recliques nao sobrescrevem). Retorna o nº
// de linhas afetadas (0 se ja contatado / id inexistente). Mesmo padrao idempotente de
// registrarConsentGravacao.
function marcarContatoWhatsapp(id) {
  const info = getDb()
    .prepare(
      "UPDATE applications SET contatado_whatsapp_em = datetime('now') WHERE id = ? AND contatado_whatsapp_em IS NULL",
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

// ── Follow-up automatico de entrevista nao concluida (lib/followupEntrevista) ──
//
// Colunas de controle da etapa (1 e 2). O nome NUNCA vem do chamador: e escolhido aqui
// por um mapa fechado, entao nao ha como injetar SQL pela numeracao da etapa.
const COLUNAS_FOLLOWUP_ENTREVISTA = {
  1: 'followup_entrevista_1_enviado_em',
  2: 'followup_entrevista_2_enviado_em',
};

// Candidatos elegiveis a um dos e-mails de follow-up. Uma linha por application, ja com
// o token (link de retomada), o e-mail e a vaga — quem chama nao precisa de query extra.
//
// Regras comuns as duas etapas:
//   - a.status = 'em_entrevista' (comecou e nao concluiu; quem esta 'aplicado' NAO entra)
//   - a.deleted_at IS NULL (candidatura arquivada nao recebe nada)
//   - e-mail presente (sem destinatario nao ha o que enviar)
//   - vaga em modo COMPLETO: j.entrevista_ativa <> 0. Filtro REDUNDANTE de proposito —
//     em tese so se chega a 'em_entrevista' por esse caminho, mas dado inconsistente
//     (vaga que virou Simples depois) nao pode gerar e-mail de entrevista. O outro lado
//     da regra (o toggle GERAL) nao e coluna e fica com modoEntrevistaAtivo, no chamador.
//   - a coluna da etapa ainda NULL (idempotencia: nunca reenvia)
//
// Etapa 1: ultima atividade ha >= `horasEspera` horas. "Ultima atividade" = criado_em do
// turno mais recente da entrevista; sem nenhum turno, cai em interviews.iniciado_em.
// Etapa 2: exatamente 24h FIXAS apos o envio do 1o (regra de negocio, nao configuravel).
//
// A entrevista considerada e sempre a MAIS RECENTE da application (mesmo criterio do
// painel). Datas comparadas em UTC pelo proprio SQLite (datetime('now', ?)), sem
// aritmetica de fuso no JS.
function listarPendentesFollowupEntrevista({ etapa, horasEspera } = {}) {
  if (etapa !== 1 && etapa !== 2) return [];

  const ultimaAtividade = `COALESCE(
       (SELECT MAX(t.criado_em) FROM interview_turns t WHERE t.interview_id = i.id),
       i.iniciado_em
     )`;

  const condicaoEtapa =
    etapa === 1
      ? `a.followup_entrevista_1_enviado_em IS NULL
         AND datetime(${ultimaAtividade}) <= datetime('now', ?)`
      : `a.followup_entrevista_1_enviado_em IS NOT NULL
         AND a.followup_entrevista_2_enviado_em IS NULL
         AND datetime(a.followup_entrevista_1_enviado_em) <= datetime('now', ?)`;

  // Horas viram um modificador do SQLite ('-24 hours'), passado como PARAMETRO.
  const horas = etapa === 1 ? Number(horasEspera) : 24;
  if (!Number.isFinite(horas) || horas <= 0) return [];
  const modificador = `-${horas} hours`;

  return getDb()
    .prepare(
      `SELECT
         a.id, a.nome, a.sobrenome, a.email, a.token, a.job_id,
         i.id AS interview_id,
         i.iniciado_em,
         ${ultimaAtividade} AS ultima_atividade
       FROM applications a
       JOIN jobs j ON j.id = a.job_id
       JOIN interviews i
         ON i.id = (SELECT i2.id FROM interviews i2
                     WHERE i2.application_id = a.id ORDER BY i2.id DESC LIMIT 1)
       WHERE a.status = 'em_entrevista'
         AND a.deleted_at IS NULL
         AND a.email IS NOT NULL AND TRIM(a.email) <> ''
         AND (j.entrevista_ativa IS NULL OR j.entrevista_ativa <> 0)
         AND ${condicaoEtapa}
       ORDER BY a.id`,
    )
    .all(modificador);
}

// Marca o envio do follow-up da etapa (1 ou 2). Condicional (`IS NULL`): se duas
// varreduras se cruzarem, a segunda grava 0 linhas e o e-mail nao e contado de novo.
// Retorna o nº de linhas afetadas (0 = etapa invalida, id inexistente ou ja marcado).
function marcarFollowupEntrevistaEnviado(id, etapa) {
  const coluna = COLUNAS_FOLLOWUP_ENTREVISTA[etapa];
  if (!coluna) return 0;
  const info = getDb()
    .prepare(
      `UPDATE applications SET ${coluna} = datetime('now') WHERE id = ? AND ${coluna} IS NULL`,
    )
    .run(id);
  return info.changes;
}

// ── E-mail automatico de recusa (lib/emailRecusa) ──
// Candidatos elegiveis a receber o aviso de que nao seguimos com a candidatura.
//
// Ancora de tempo = reports.enviado_em (a tabela nao tem coluna de criacao). E tambem a
// ancora SEMANTICAMENTE certa: a carencia existe para o recrutador poder intervir, e o
// relogio dele so comeca quando ele recebe o e-mail do relatorio. Consequencia desejada:
// se o e-mail ao recrutador falhou (enviado_em NULL), ninguem e avisado — ele nunca teve
// a chance de revisar.
//
// Exige recomendacao='descartar' NO REPORT **e** status_ia='descartar' NA APPLICATION.
// As duas sao escritas do mesmo valor em relatorio.js, entao concordam sempre; exigir as
// duas faz o filtro se autocorrigir se um reprocessamento mudar o veredito, e faz o caso
// inconsistente (existe hoje 1 report 'descartar' com status_ia NULL) NAO receber e-mail.
// Para uma acao irreversivel que sai para fora, discordancia = nao envia.
//
// GROUP BY a.id: um e-mail por CANDIDATO, mesmo que existam varios reports para ele.
function listarPendentesEmailRecusa({ horasCarencia, limite } = {}) {
  const horas = Number(horasCarencia);
  if (!Number.isFinite(horas) || horas < 0) return [];
  const max = Number.isFinite(Number(limite)) && Number(limite) > 0 ? Math.floor(Number(limite)) : 20;

  return getDb()
    .prepare(
      `SELECT
         a.id, a.nome, a.sobrenome, a.email, a.job_id,
         MAX(r.enviado_em) AS relatorio_enviado_em
       FROM reports r
       JOIN interviews i ON i.id = r.interview_id
       JOIN applications a ON a.id = i.application_id
       WHERE r.recomendacao = 'descartar'
         AND a.status_ia = 'descartar'
         AND r.enviado_em IS NOT NULL
         AND datetime(r.enviado_em) <= datetime('now', ?)
         AND a.email_recusa_enviado_em IS NULL
         AND (a.status_recrutador IS NULL OR a.status_recrutador = 'reprovado')
         AND a.email IS NOT NULL AND TRIM(a.email) <> ''
         AND a.deleted_at IS NULL
       GROUP BY a.id
       ORDER BY a.id
       LIMIT ?`,
    )
    .all(`-${horas} hours`, max);
}

// ── Lembrete de INICIO de entrevista (lib/lembreteInicio) ──
// Candidatos que se candidataram e NUNCA abriram a entrevista.
//
// Publico oposto ao do follow-up: la o filtro e status='em_entrevista' + JOIN interviews
// (quem comecou e parou no meio); aqui e status='aplicado' + NOT EXISTS interviews (quem
// nunca chegou a comecar). Sao 174 de 227 candidaturas em vagas com entrevista ativa —
// o grosso do vazamento do funil, e um publico que hoje nao recebe nada.
//
// Ancora de tempo: a.criado_em. E o unico timestamp que existe para quem nunca iniciou —
// nao ha entrevista, logo nao ha "ultima atividade" como no follow-up.
//
// Mesmo tratamento de horas do follow-up: o modificador do SQLite ('-3 hours') e montado
// aqui e passado como PARAMETRO, sem aritmetica de fuso no JS. LIMIT tambem parametrizado,
// como em listarPendentesEmailRecusa — o teto vive na query, nao no laco de quem chama.
//
// ── DEDUPE POR E-MAIL ──
// A idempotencia por coluna e por APPLICATION, mas o e-mail chega numa PESSOA. E comum a
// mesma pessoa se candidatar duas vezes (a duas vagas, ou a mesma vaga em dois momentos):
// no dry-run de producao apareceram ~7 casos, alguns com minutos de diferenca. Sem dedupe,
// essa pessoa receberia dois lembretes iguais — o que parece spam e nao ajuda em nada.
//
// MAX(id) e nao MIN: entre duas candidaturas da mesma pessoa, a MAIS RECENTE e a que
// reflete o interesse atual dela (pode ser outra vaga, ou uma segunda tentativa). E o
// token dessa linha e o que leva a candidatura certa em /retomar.
//
// A subquery NAO repete o filtro de status, e isso e proposital — resolve um caso de borda
// que a versao ingenua erraria. Se a candidatura mais recente ja virou 'em_entrevista'
// (a pessoa comecou por ela) e existe uma mais antiga ainda em 'aplicado', filtrar por
// status faria o MAX "pular" a que comecou e eleger a antiga, mandando lembrete para quem
// ja esta na entrevista. Sem o filtro, o MAX aponta para a que comecou, a antiga nao casa
// com `a.id =` e NINGUEM recebe — que e o comportamento correto: a pessoa ja entrou.
// `deleted_at IS NULL` fica na subquery para que uma candidatura arquivada nao bloqueie o
// lembrete de uma ativa do mesmo e-mail.
//
// A application "perdedora" nunca e marcada como enviada (a marcacao so acontece para quem
// a varredura processou). Se a vencedora sair da elegibilidade depois — por exemplo, a
// pessoa comeca a entrevista por ela —, a perdedora volta a ser a MAX entre as vivas e
// pode reaparecer numa varredura futura. Isso e desejado: o estado de elegibilidade e
// sempre recalculado, nunca congelado.
//
// LOWER(TRIM(...)) nos dois lados: as duplicatas observadas tem e-mail identico, mas
// variacao de caixa ou espaco em branco nao pode furar o dedupe. Sem indice em email, mas
// o volume da tabela e de centenas de linhas — o custo e irrelevante.
function listarPendentesLembreteInicio({ horasEspera, limite } = {}) {
  const horas = Number(horasEspera);
  if (!Number.isFinite(horas) || horas <= 0) return [];
  const modificador = `-${horas} hours`;
  const max = Number.isFinite(Number(limite)) && Number(limite) > 0 ? Math.floor(Number(limite)) : 20;

  return getDb()
    .prepare(
      `SELECT
         a.id, a.nome, a.sobrenome, a.email, a.token, a.job_id, a.criado_em
       FROM applications a
       JOIN jobs j ON j.id = a.job_id
       WHERE a.status = 'aplicado'
         AND NOT EXISTS (SELECT 1 FROM interviews i WHERE i.application_id = a.id)
         AND a.deleted_at IS NULL
         AND a.email IS NOT NULL AND TRIM(a.email) <> ''
         AND (j.entrevista_ativa IS NULL OR j.entrevista_ativa <> 0)
         AND a.lembrete_inicio_enviado_em IS NULL
         AND datetime(a.criado_em) <= datetime('now', ?)
         AND a.id = (
               SELECT MAX(a2.id) FROM applications a2
                WHERE LOWER(TRIM(a2.email)) = LOWER(TRIM(a.email))
                  AND a2.deleted_at IS NULL
             )
       ORDER BY a.id
       LIMIT ?`,
    )
    .all(modificador, max);
}

// Marca o envio do lembrete de inicio. Condicional (`IS NULL`), igual aos outros dois:
// se duas varreduras se cruzarem, a segunda grava 0 linhas e o candidato nao recebe um
// segundo e-mail. Retorna o nº de linhas afetadas (0 = id inexistente ou ja marcado).
function marcarLembreteInicioEnviado(id) {
  const info = getDb()
    .prepare(
      `UPDATE applications SET lembrete_inicio_enviado_em = datetime('now')
        WHERE id = ? AND lembrete_inicio_enviado_em IS NULL`,
    )
    .run(id);
  return info.changes;
}

// Marca o envio da recusa. Condicional (`IS NULL`), igual ao follow-up: se duas varreduras
// se cruzarem, a segunda grava 0 linhas e o candidato nao recebe um segundo e-mail.
// Retorna o nº de linhas afetadas (0 = id inexistente ou ja marcado).
function marcarEmailRecusaEnviado(id) {
  const info = getDb()
    .prepare(
      `UPDATE applications SET email_recusa_enviado_em = datetime('now')
        WHERE id = ? AND email_recusa_enviado_em IS NULL`,
    )
    .run(id);
  return info.changes;
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

// Momento da ultima ATIVIDADE da entrevista: criado_em do turno mais recente ou, se ela
// ainda nao tem nenhum turno, iniciado_em. Mesma definicao usada pela varredura de
// follow-up (listarPendentesFollowupEntrevista) — as duas precisam concordar sobre o que
// e "parado desde quando". null se a entrevista nao existir.
function ultimaAtividadeInterview(interviewId) {
  const linha = getDb()
    .prepare(
      `SELECT COALESCE(
                (SELECT MAX(t.criado_em) FROM interview_turns t WHERE t.interview_id = i.id),
                i.iniciado_em
              ) AS ultima_atividade
         FROM interviews i
        WHERE i.id = ?`,
    )
    .get(interviewId);
  return linha ? linha.ultima_atividade : null;
}

// Soma `incrementoMs` ao tempo pausado da entrevista e devolve o TOTAL atualizado (para
// quem chama nao precisar de uma segunda consulta). Incremento <= 0 / invalido nao grava
// nada, mas o total atual continua sendo devolvido. Soma no proprio SQL (nao le-modifica-
// escreve no JS), entao chamadas concorrentes nao se perdem.
function acumularTempoPausado(interviewId, incrementoMs) {
  const inc = Math.floor(Number(incrementoMs));
  if (Number.isFinite(inc) && inc > 0) {
    getDb()
      .prepare(
        'UPDATE interviews SET tempo_pausado_ms = COALESCE(tempo_pausado_ms, 0) + ? WHERE id = ?',
      )
      .run(inc, interviewId);
  }
  const linha = getDb()
    .prepare('SELECT tempo_pausado_ms FROM interviews WHERE id = ?')
    .get(interviewId);
  return linha ? Number(linha.tempo_pausado_ms) || 0 : 0;
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

// Entrevistas cujo audio no volume ja e descartavel (lib/limpezaAudio decide QUANDO
// chamar; esta query so diz QUAIS podem). As tres condicoes sao obrigatorias e nenhuma
// e redundante:
//   status = 'concluido'      -> a entrevista acabou; ninguem mais vai tocar o mp3 da Vera.
//   video_url IS NOT NULL     -> existe backup em video no Drive. E a condicao FORTE: sem
//                                ela, apagar o audio deixa a transcricao como unico registro.
//   reports.status gerado/env -> a avaliacao ja foi extraida da transcricao; nada mais
//                                precisa ser reprocessado a partir deste material.
// GROUP BY: reprocessar um relatorio cria uma linha NOVA em reports, entao o JOIN pode
// devolver a mesma interview mais de uma vez — sem o GROUP BY o cap por ciclo seria
// consumido por duplicatas.
// ORDER BY i.id: mais antigas primeiro (drena o backlog em ordem estavel entre ciclos).
function listarElegiveisLimpezaAudio({ limite } = {}) {
  const max = Number.isFinite(Number(limite)) && Number(limite) > 0 ? Math.floor(Number(limite)) : 20;

  return getDb()
    .prepare(
      `SELECT i.id
         FROM interviews i
         JOIN reports r ON r.interview_id = i.id
        WHERE i.status = 'concluido'
          AND i.video_url IS NOT NULL
          AND TRIM(i.video_url) <> ''
          AND r.status IN ('gerado', 'enviado')
        GROUP BY i.id
        ORDER BY i.id
        LIMIT ?`,
    )
    .all(max)
    .map((linha) => linha.id);
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

// erro_mensagem/erro_em sao ADITIVOS: so o caminho de falha da avaliacao os preenche
// (status='erro', sem resumo/pontuacoes). Quem chama no caminho feliz omite os dois e
// grava NULL, exatamente como antes.
function criarReport(report) {
  const info = getDb().prepare(`
    INSERT INTO reports
      (interview_id, token, status, resumo, pontuacoes, destaque_pontos_fortes, destaque_atencao, recomendacao, requisitos, erro_mensagem, erro_em)
    VALUES
      (@interview_id, @token, @status, @resumo, @pontuacoes, @destaque_pontos_fortes, @destaque_atencao, @recomendacao, @requisitos, @erro_mensagem, @erro_em)
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
    erro_mensagem: report.erro_mensagem != null ? String(report.erro_mensagem) : null,
    erro_em: report.erro_em != null ? String(report.erro_em) : null,
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
// do ultimo relatorio EXIBIVEL (para habilitar/linkar o botao "Ver relatorio").
// "Exibivel" exclui status='erro': essa linha existe so para guardar o rastro da falha
// (erro_mensagem/erro_em) e nao tem resumo/pontuacoes para mostrar — o botao apontaria
// para uma pagina vazia. O descarte acontece ANTES do ORDER BY, entao uma reprocessagem
// bem-sucedida depois de uma falha volta a acender o botao normalmente.
// Proposital NAO mexer em obterReportPorInterview: aquele continua trazendo QUALQUER
// status (inclusive 'erro'), que e o que o detalhe do candidato usa para exibir a
// mensagem da falha. O filtro daqui vale so para este campo, que so alimenta o botao.
// Ordena por criado_em DESC. Filtros opcionais (Fase 5, inc 5):
//   status -> filtra a.status (so um dos valores validos; ignorado caso contrario)
//   statusIa -> filtra a.status_ia (veredito da IA; enum abaixo; ignorado caso contrario)
//   dataDe / dataAte -> intervalo INCLUSIVO sobre a data (YYYY-MM-DD) de a.criado_em
//   jobId -> filtra a.job_id (id da vaga; ignorado se ausente)
//   busca -> texto livre em nome/sobrenome/nome completo/e-mail/telefone (vazio = ignorado)
// Enum dos vereditos da IA (espelha a maquina de estados do item 2 e badgeStatusIa do
// painel). Interno a esta query; o handler /admin mantem a MESMA allowlist ao sanear a
// query string (mesmo padrao ja usado para o enum de status).
const STATUS_IA_VALIDOS = ['avancar', 'talvez', 'descartar', 'processando', 'indefinido', 'erro'];

// Minimo de digitos para o termo tambem ser procurado no TELEFONE. Abaixo disso a busca
// numerica devolveria meio banco (um '1' casa com quase todo mundo) sem ajudar ninguem;
// nome e e-mail continuam sendo procurados normalmente.
const MIN_DIGITOS_BUSCA_TELEFONE = 3;

// Escapa os curingas do LIKE no termo digitado pelo recrutador. Sem isto, '%' e '_'
// digitados na busca virariam curingas e o campo se comportaria de forma imprevisivel
// ('a_b' casaria com 'axb'). A contrabarra vem PRIMEIRO na regex por ser o proprio
// caractere de escape — inverter a ordem escaparia as barras que acabamos de inserir.
// Pareia com o ESCAPE '\' declarado em cada LIKE da query.
function escaparCuringasLike(termo) {
  return String(termo).replace(/[\\%_]/g, (c) => `\\${c}`);
}

// ── Paginacao da lista de candidatos ──
// Tamanho de pagina FIXO (nao configuravel pela query string): a tela nasceu sem
// paginacao e com 550+ leads numa pagina so. O numero mora aqui porque tres pontos
// precisam do MESMO valor — a query (LIMIT), o calculo de totalPaginas no handler e
// os controles de navegacao. Exportado para o painel nao redeclarar o 25.
const CANDIDATOS_POR_PAGINA = 25;

// ── Origem do lead (utm_source): valor CRU no banco x valor CANONICO no filtro ──
// O banco guarda a origem exatamente como veio da URL, e por isso tem duplicatas
// historicas ('grupo-whats' e 'grupowhats' sao a mesma campanha, digitadas diferente)
// e dois jeitos de dizer "sem origem" (NULL nas candidaturas anteriores ao rastreio, e
// o literal 'direto' gravado desde entao). A normalizacao acontece SO na apresentacao e
// no filtro — nada aqui reescreve applications.utm_source.
const ORIGEM_DIRETO = 'direto';
const ORIGEM_GRUPO_WHATS = 'grupo-whats';
// Todas as grafias que caem no balde do grupo de WhatsApp (a 1a e a canonica).
const ORIGENS_GRUPO_WHATS = ['grupo-whats', 'grupowhats'];

// Valor cru -> valor canonico do filtro. NULL/vazio/'direto' viram 'direto'; as duas
// grafias do grupo viram 'grupo-whats'; o resto passa intacto.
function origemCanonica(valor) {
  const v = valor == null ? '' : String(valor).trim();
  if (!v || v === ORIGEM_DIRETO) return ORIGEM_DIRETO;
  if (ORIGENS_GRUPO_WHATS.includes(v)) return ORIGEM_GRUPO_WHATS;
  return v;
}

// Rotulo de tela para um valor canonico. Espelha o que a coluna "Origem (UTM)" do
// painel ja mostrava ('Direto'); as demais origens aparecem cruas, como sempre.
function rotuloOrigem(canonica) {
  if (canonica === ORIGEM_DIRETO) return 'Direto';
  if (canonica === ORIGEM_GRUPO_WHATS) return 'Grupo WhatsApp';
  return canonica;
}

// Origens existentes para popular o <select> do filtro, ja deduplicadas pela
// normalizacao acima. Sempre inclui 'Direto', mesmo que nenhuma candidatura tenha
// utm_source NULL/'direto': e a opcao que o recrutador espera encontrar na lista.
// Ordenado por rotulo (pt-BR), para a ordem nao depender da ordem de insercao.
function listarOrigensDistintas() {
  const linhas = getDb().prepare('SELECT DISTINCT utm_source FROM applications').all();
  const mapa = new Map([[ORIGEM_DIRETO, rotuloOrigem(ORIGEM_DIRETO)]]);
  for (const linha of linhas) {
    const canon = origemCanonica(linha.utm_source);
    if (!mapa.has(canon)) mapa.set(canon, rotuloOrigem(canon));
  }
  return [...mapa.entries()]
    .map(([valor_canonico, label]) => ({ valor_canonico, label }))
    .sort((a, b) => a.label.localeCompare(b.label, 'pt-BR'));
}

// Monta o WHERE dinamico da lista de candidatos. Extraido para ser a UNICA fonte dos
// filtros: a query das linhas (com LIMIT/OFFSET) e a contagem total (sem) chamam esta
// funcao, entao o rodape nunca conta um conjunto diferente do que a tabela mostra.
// Retorna { where, params } — as condicoes usam SEMPRE o alias `a` de applications.
function condicoesFiltroCandidatos({
  status,
  statusIa,
  statusRecrutador,
  dataDe,
  dataAte,
  jobId,
  origem,
  busca,
  incluirArquivados = false,
  arquivados,
} = {}) {
  const where = [];
  const params = [];

  // Soft-delete, tres modos de visibilidade (parametro `arquivados`):
  //   'ativos'     (default) -> deleted_at IS NULL
  //   'arquivados'           -> deleted_at IS NOT NULL (SO os arquivados)
  //   'todos'                -> sem condicao
  // Isto afeta SO esta lista do painel; o funil (obterFunilConversao) tem query propria
  // e mantem os arquivados nas metricas historicas.
  //
  // Retrocompatibilidade: o antigo booleano incluirArquivados continua valendo quando
  // `arquivados` nao vem — true equivalia a "sem condicao", ou seja, 'todos'.
  const VISIBILIDADES = ['ativos', 'arquivados', 'todos'];
  const modo = VISIBILIDADES.includes(arquivados)
    ? arquivados
    : incluirArquivados
      ? 'todos'
      : 'ativos';
  if (modo === 'ativos') {
    where.push('a.deleted_at IS NULL');
  } else if (modo === 'arquivados') {
    where.push('a.deleted_at IS NOT NULL');
  }

  if (status === 'aplicado' || status === 'em_entrevista' || status === 'concluido') {
    where.push('a.status = ?');
    params.push(status);
  }
  if (STATUS_IA_VALIDOS.includes(statusIa)) {
    where.push('a.status_ia = ?');
    params.push(statusIa);
  }
  // Decisao do recrutador. Alem do enum (STATUS_RECRUTADOR_VALIDOS), aceita o valor
  // SENTINELA 'sem_decisao', que nao e um status gravavel: vira "IS NULL" (a coluna
  // nasce NULL e definirStatusRecrutador grava NULL para qualquer valor fora do enum).
  // O OR com '' e defensivo, para bancos que porventura tenham string vazia gravada.
  if (statusRecrutador === 'sem_decisao') {
    where.push("(a.status_recrutador IS NULL OR a.status_recrutador = '')");
  } else if (STATUS_RECRUTADOR_VALIDOS.includes(statusRecrutador)) {
    where.push('a.status_recrutador = ?');
    params.push(statusRecrutador);
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

  // Origem do lead. Dois valores canonicos sao BALDES (varias grafias no banco caem
  // neles) e por isso nao podem virar um '= ?' simples; o resto e igualdade direta.
  // Origem ausente/vazia = sem filtro (mesma convencao dos outros).
  const origemFiltro = origem ? origemCanonica(origem) : '';
  if (origemFiltro === ORIGEM_DIRETO) {
    // Inclui a string vazia por defesa: origemCanonica ja a trata como 'direto', entao
    // uma linha assim precisa aparecer no mesmo recorte da tela.
    where.push("(a.utm_source IS NULL OR TRIM(a.utm_source) = '' OR a.utm_source = ?)");
    params.push(ORIGEM_DIRETO);
  } else if (origemFiltro === ORIGEM_GRUPO_WHATS) {
    where.push(`a.utm_source IN (${ORIGENS_GRUPO_WHATS.map(() => '?').join(', ')})`);
    params.push(...ORIGENS_GRUPO_WHATS);
  } else if (origemFiltro) {
    where.push('a.utm_source = ?');
    params.push(origemFiltro);
  }

  // ── Busca textual livre (nome, sobrenome, nome completo, e-mail, telefone) ──
  //
  // Entra no MESMO array `where`, e portanto e combinada com AND aos demais filtros e
  // herda a visibilidade de arquivados de graca — buscar dentro do modo 'ativos' nao
  // pode ressuscitar um lead arquivado.
  //
  // LIMITACAO CONHECIDA (decisao deliberada, nao e bug): o LIKE padrao do SQLite so
  // ignora maiusculas/minusculas em ASCII. Portanto 'jose' NAO encontra 'José', nem
  // 'JOSÉ' encontra 'josé' — o dobramento de acentos exigiria uma coluna normalizada
  // ou a extensao ICU, e optamos por nao pagar esse custo: o recrutador digita o nome
  // como ele aparece na tela. 'jose' encontrando 'Jose'/'JOSE' continua funcionando.
  const termo = typeof busca === 'string' ? busca.trim() : '';
  if (termo) {
    const alvo = `%${escaparCuringasLike(termo)}%`;
    // nome completo concatenado: sem ele, "maria silva" nao acha ninguem, porque nenhuma
    // coluna sozinha contem os dois pedacos.
    const condicoes = [
      "a.nome LIKE ? ESCAPE '\\'",
      "a.sobrenome LIKE ? ESCAPE '\\'",
      "(a.nome || ' ' || a.sobrenome) LIKE ? ESCAPE '\\'",
      "a.email LIKE ? ESCAPE '\\'",
    ];
    params.push(alvo, alvo, alvo, alvo);

    // Telefone e gravado CRU ('+55 (11) 99999-9999', '+55 11999999999' — os dois formatos
    // convivem no banco), entao os dois lados sao reduzidos a digitos antes de comparar:
    // o termo aqui em JS, a coluna via REPLACE aninhado. Assim '11999', '(11) 99999' e
    // '+55 11999' encontram o mesmo candidato.
    const digitos = termo.replace(/\D/g, '');
    if (digitos.length >= MIN_DIGITOS_BUSCA_TELEFONE) {
      condicoes.push(
        `REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(
           a.telefone, ' ', ''), '-', ''), '(', ''), ')', ''), '+', '') LIKE ?`,
      );
      // So digitos: nao ha curinga a escapar.
      params.push(`%${digitos}%`);
    }

    where.push(`(${condicoes.join(' OR ')})`);
  }

  return { where, params };
}

// Junta as condicoes num WHERE (ou string vazia, quando nao ha filtro nenhum).
function montarClausula(where) {
  return where.length ? `WHERE ${where.join(' AND ')}` : '';
}

// Pagina 1-indexed e saneada aqui tambem (nao so no handler): qualquer lixo — 0,
// negativo, 'abc', undefined — vira 1, para o OFFSET nunca ficar negativo.
function paginaSaneada(pagina) {
  const n = Math.floor(Number(pagina));
  return Number.isFinite(n) && n > 0 ? n : 1;
}

// Lista UMA pagina de candidatos (25 por vez). Para o total de linhas do recorte,
// use contarAplicacoesComContexto com os MESMOS filtros.
function listarAplicacoesComContexto(filtros = {}) {
  const { where, params } = condicoesFiltroCandidatos(filtros);
  const clausula = montarClausula(where);
  const pagina = paginaSaneada(filtros.pagina);

  return getDb()
    .prepare(
      `SELECT
         a.id, a.nome, a.sobrenome, a.email, a.telefone, a.status, a.criado_em,
         a.status_ia, a.status_recrutador, a.contatado_whatsapp_em,
         a.deleted_at, a.utm_source,
         j.titulo AS vaga_titulo,
         j.empresa AS vaga_empresa,
         (SELECT i.id FROM interviews i
            WHERE i.application_id = a.id ORDER BY i.id DESC LIMIT 1) AS interview_id,
         (SELECT i3.video_url FROM interviews i3
            WHERE i3.application_id = a.id ORDER BY i3.id DESC LIMIT 1) AS video_url,
         (SELECT r.interview_id FROM reports r
            JOIN interviews i2 ON i2.id = r.interview_id
            WHERE i2.application_id = a.id AND r.status <> 'erro'
            ORDER BY r.id DESC LIMIT 1) AS report_interview_id
       FROM applications a
       LEFT JOIN jobs j ON j.id = a.job_id
       ${clausula}
       ORDER BY a.criado_em DESC
       LIMIT ? OFFSET ?`,
    )
    .all(...params, CANDIDATOS_POR_PAGINA, (pagina - 1) * CANDIDATOS_POR_PAGINA);
}

// Total de candidatos do recorte, SEM LIMIT/OFFSET — e o denominador da paginacao e o
// "Total de candidatos" do rodape. Nao ha JOIN com jobs porque nenhum filtro toca a
// tabela de vagas (jobId e coluna de applications); se um dia entrar um filtro por
// campo de job, o JOIN precisa vir para ca tambem.
function contarAplicacoesComContexto(filtros = {}) {
  const { where, params } = condicoesFiltroCandidatos(filtros);
  return getDb()
    .prepare(`SELECT COUNT(*) AS n FROM applications a ${montarClausula(where)}`)
    .get(...params).n;
}

// Entrevistas concluidas DENTRO do mesmo recorte da listagem — o segundo numero do
// rodape do painel. Difere de contarEntrevistasConcluidas (que conta a tabela inteira,
// sem olhar para os filtros da tela).
//
// Precisa do JOIN com applications porque todo filtro da tela mora em applications
// (status, vaga, datas, origem, busca, arquivados); `interviews` so contribui com o
// proprio status. A condicao de conclusao entra no MESMO array `where` em vez de ser
// concatenada depois: assim montarClausula resolve sozinha o caso "nenhum filtro
// ativo" (vira `WHERE i.status = 'concluido'`, sem AND solto).
//
// Como conta linhas de `interviews`, um candidato com duas entrevistas concluidas
// (reprocessamento) conta duas vezes — exatamente o que o contador global ja fazia.
function contarEntrevistasConcluidasComContexto(filtros = {}) {
  const { where, params } = condicoesFiltroCandidatos(filtros);
  const clausula = montarClausula([...where, "i.status = 'concluido'"]);
  return getDb()
    .prepare(
      `SELECT COUNT(*) AS n
         FROM interviews i
         JOIN applications a ON a.id = i.application_id
         ${clausula}`,
    )
    .get(...params).n;
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
//
// `utm` (opcional) e o objeto do helper de UTM ({ source, medium, campaign, content,
// term }) ou null. Retrocompativel: chamado so com jobId, grava NULL nas cinco colunas
// de UTM (comportamento historico preservado). Nao ha literal 'direto' aqui — o topo do
// funil registra a origem observada ou NULL.
function registrarAcessoVaga(jobId, utm = null) {
  const u = utm || {};
  getDb()
    .prepare(
      `INSERT INTO vaga_acessos
         (job_id, utm_source, utm_medium, utm_campaign, utm_content, utm_term)
       VALUES
         (@job_id, @utm_source, @utm_medium, @utm_campaign, @utm_content, @utm_term)`,
    )
    .run({
      job_id: jobId,
      utm_source: u.source || null,
      utm_medium: u.medium || null,
      utm_campaign: u.campaign || null,
      utm_content: u.content || null,
      utm_term: u.term || null,
    });
}

// Registra a PRIMEIRA passagem de um candidato por uma das telas entre a candidatura e o
// inicio da entrevista (preparacao, video, permissoes e testes de camera/microfone).
//
// A segunda passagem pela mesma tela precisa ser silenciosa: o par (application_id,
// etapa) e UNIQUE, e recarregar a pagina, voltar no navegador ou retomar a entrevista
// dias depois passa de novo pelas mesmas telas. Ali a colisao e o caso NORMAL, nao o
// excepcional. O primeiro registro (com o criado_em original) fica.
//
// ON CONFLICT ... DO NOTHING em vez de INSERT OR IGNORE, apesar de os dois "ignorarem o
// duplicado": OR IGNORE ignora QUALQUER violacao de constraint, inclusive a do CHECK das
// etapas. Com ele, um typo no chamador ('preparcao') nao gravaria nada e nao avisaria
// ninguem — a etapa apareceria zerada no relatorio e pareceria abandono total, que e o
// erro mais caro possivel numa tabela cujo unico proposito e medir abandono. O ON
// CONFLICT nomeia o conflito que queremos engolir (o do par UNIQUE) e deixa o CHECK
// continuar levantando, alto e no desenvolvimento.
//
// Diferente de registrarAcessoVaga, que grava uma linha por acesso: la a pergunta e
// "quantos acessos a vaga teve?"; aqui e "quantas PESSOAS chegaram nesta tela?".
//
// Retorna true se gravou (primeira passagem) e false se ja existia — util para teste e
// para quem quiser distinguir os dois casos. O chamador (middleware do D3) ignora o
// retorno: para ele, gravou ou ja estava gravado dao no mesmo.
function registrarEventoFunil(applicationId, etapa) {
  const info = getDb()
    .prepare(
      `INSERT INTO funil_eventos (application_id, etapa) VALUES (?, ?)
         ON CONFLICT(application_id, etapa) DO NOTHING`,
    )
    .run(applicationId, etapa);
  return info.changes > 0;
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

// ── Helpers de agregacao compartilhados (funil por vaga + origem de leads) ──
// Recorte de periodo (inclusivo) sobre uma coluna de data. { desde, ate } sao datas
// 'YYYY-MM-DD'; ausentes = sem limite daquele lado. Retorna { conds, params } para
// compor no WHERE. Usado por obterFunilConversao e obterOrigemLeads (mesma semantica).
function condsPeriodo(coluna, { desde, ate } = {}) {
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
}

// Junta condicoes fixas (base) + de periodo (extra.conds) num WHERE, ou '' se vazio.
function montarWhere(base, extra) {
  const todas = [...base, ...extra.conds];
  return todas.length ? `WHERE ${todas.join(' AND ')}` : '';
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
  const periodo = { desde, ate };

  // Cada agregacao -> Map job_id -> contagem.
  const paraMapa = (linhas) => {
    const m = new Map();
    for (const l of linhas) m.set(l.job_id, l.n);
    return m;
  };

  // 1) Acessos: vaga_acessos por job_id (periodo por vaga_acessos.criado_em).
  const fAcessos = condsPeriodo('criado_em', periodo);
  const acessos = paraMapa(
    db
      .prepare(
        `SELECT job_id, COUNT(*) AS n FROM vaga_acessos ${montarWhere([], fAcessos)} GROUP BY job_id`,
      )
      .all(...fAcessos.params),
  );

  // 2) Aplicacoes: applications por job_id (periodo por applications.criado_em).
  const fApp = condsPeriodo('criado_em', periodo);
  const aplicacoes = paraMapa(
    db
      .prepare(
        `SELECT job_id, COUNT(*) AS n FROM applications ${montarWhere([], fApp)} GROUP BY job_id`,
      )
      .all(...fApp.params),
  );

  // 3) Entrevistas realizadas: interviews concluidas, por job_id (via application_id).
  //    Periodo por interviews.finalizado_em (quando a entrevista de fato concluiu).
  const fEntr = condsPeriodo('i.finalizado_em', periodo);
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
  const fPre = condsPeriodo('r.enviado_em', periodo);
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

// Origem dos leads (B2): mesmo funil de 4 etapas (Acessos -> Aplicacoes -> Entrevistas
// realizadas -> Pre-aprovados pela IA), mas agrupado por utm_source em vez de por vaga.
// Reaproveita condsPeriodo/montarWhere e a MESMA estrategia anti-fan-out (4 agregacoes
// independentes casadas em memoria). opcoes.desde/ate recortam o periodo (cada etapa pelo
// seu timestamp); opcoes.jobId (opcional) restringe a uma vaga.
//
// Bucketizacao (feita aqui p/ as 4 etapas caírem no MESMO balde): utm_source NULL ->
// 'Sem origem' (acessos historicos/pre-B1 ou nao rastreados); literal 'direto' -> 'Direto'
// (aplicacao sem UTM); qualquer outro valor -> a propria origem. Assim, ausencia de UTM
// (NULL) fica distinta de "sem UTM no momento da aplicacao" ('direto').
function obterOrigemLeads(opcoes = {}) {
  const db = getDb();
  const { desde, ate, jobId } = opcoes;
  const periodo = { desde, ate };

  const rotuloOrigem = (valor) => {
    if (valor == null) return 'Sem origem';
    if (valor === 'direto') return 'Direto';
    return valor;
  };

  // Filtro opcional por vaga: base de condicoes + param, conforme a coluna da tabela.
  const baseJob = (coluna) => (jobId ? [`${coluna} = ?`] : []);
  const paramsJob = jobId ? [jobId] : [];

  // Acumula linhas { origem, n } de uma etapa no Map (chave = rotulo bucketizado).
  const mapa = new Map();
  const acumular = (linhas, campo) => {
    for (const l of linhas) {
      const chave = rotuloOrigem(l.origem);
      const atual =
        mapa.get(chave) ||
        { origem: chave, acessos: 0, aplicacoes: 0, entrevistas_realizadas: 0, pre_aprovados: 0 };
      atual[campo] += l.n;
      mapa.set(chave, atual);
    }
  };

  // 1) Acessos: vaga_acessos por utm_source (periodo por vaga_acessos.criado_em).
  const fAcessos = condsPeriodo('criado_em', periodo);
  acumular(
    db
      .prepare(
        `SELECT utm_source AS origem, COUNT(*) AS n FROM vaga_acessos
           ${montarWhere(baseJob('job_id'), fAcessos)} GROUP BY utm_source`,
      )
      .all(...paramsJob, ...fAcessos.params),
    'acessos',
  );

  // 2) Aplicacoes: applications por utm_source (periodo por applications.criado_em).
  const fApp = condsPeriodo('criado_em', periodo);
  acumular(
    db
      .prepare(
        `SELECT utm_source AS origem, COUNT(*) AS n FROM applications
           ${montarWhere(baseJob('job_id'), fApp)} GROUP BY utm_source`,
      )
      .all(...paramsJob, ...fApp.params),
    'aplicacoes',
  );

  // 3) Entrevistas realizadas: interviews concluidas, por utm_source (via application).
  //    Periodo por interviews.finalizado_em.
  const fEntr = condsPeriodo('i.finalizado_em', periodo);
  acumular(
    db
      .prepare(
        `SELECT a.utm_source AS origem, COUNT(*) AS n
           FROM interviews i
           JOIN applications a ON a.id = i.application_id
           ${montarWhere(["i.status = 'concluido'", ...baseJob('a.job_id')], fEntr)}
          GROUP BY a.utm_source`,
      )
      .all(...paramsJob, ...fEntr.params),
    'entrevistas_realizadas',
  );

  // 4) Pre-aprovados pela IA: reports 'avancar', por utm_source (cadeia report ->
  //    interview -> application). COUNT(DISTINCT interview_id) evita contar 2x na
  //    regeracao. Periodo por reports.enviado_em.
  const fPre = condsPeriodo('r.enviado_em', periodo);
  acumular(
    db
      .prepare(
        `SELECT a.utm_source AS origem, COUNT(DISTINCT r.interview_id) AS n
           FROM reports r
           JOIN interviews i ON i.id = r.interview_id
           JOIN applications a ON a.id = i.application_id
           ${montarWhere(["r.recomendacao = 'avancar'", ...baseJob('a.job_id')], fPre)}
          GROUP BY a.utm_source`,
      )
      .all(...paramsJob, ...fPre.params),
    'pre_aprovados',
  );

  // Ordena por relevancia: mais aplicacoes primeiro, desempate por acessos e nome (pt-BR).
  const origens = [...mapa.values()].sort(
    (a, b) =>
      b.aplicacoes - a.aplicacoes ||
      b.acessos - a.acessos ||
      a.origem.localeCompare(b.origem, 'pt-BR'),
  );

  const totais = origens.reduce(
    (acc, l) => ({
      acessos: acc.acessos + l.acessos,
      aplicacoes: acc.aplicacoes + l.aplicacoes,
      entrevistas_realizadas: acc.entrevistas_realizadas + l.entrevistas_realizadas,
      pre_aprovados: acc.pre_aprovados + l.pre_aprovados,
    }),
    { acessos: 0, aplicacoes: 0, entrevistas_realizadas: 0, pre_aprovados: 0 },
  );

  return { origens, totais };
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

// ──────────────────────────────────────────────────────────────
// Promocao de Vagas — descadastro (opt-out global por e-mail)
// ──────────────────────────────────────────────────────────────

// Registra o opt-out. INSERT OR IGNORE porque a idempotencia ja e da PK: quem clica duas
// vezes no link (ou clica depois de o recrutador ter registrado na mao) nao gera erro nem
// sobrescreve a origem do PRIMEIRO registro — a data e a origem originais do opt-out sao
// o que interessa para auditoria.
// Retorna true se INSERIU, false se ja existia. E-mail vazio devolve false sem lancar:
// vem de query string publica, e ausencia de e-mail nao e excecao, e so "nada a fazer".
function registrarDescadastro(email, origem) {
  const alvo = normalizarEmail(email);
  if (!alvo) return false;
  const info = getDb()
    .prepare('INSERT OR IGNORE INTO descadastros (email, origem) VALUES (?, ?)')
    .run(alvo, origem || null);
  return info.changes > 0;
}

// A pessoa esta fora da divulgacao? Comparacao pelo e-mail NORMALIZADO nos dois lados —
// a coluna ja guarda normalizado (quem escreve passa por aqui) e o argumento e
// normalizado antes de comparar, entao qualquer grafia do mesmo endereco responde igual.
function estaDescadastrado(email) {
  const alvo = normalizarEmail(email);
  if (!alvo) return false;
  return Boolean(getDb().prepare('SELECT 1 FROM descadastros WHERE email = ?').get(alvo));
}

// ──────────────────────────────────────────────────────────────
// Promocao de Vagas — motor de publico (leitura para campanha)
// ──────────────────────────────────────────────────────────────
//
// As quatro funcoes abaixo sao LEITURA CRUA. Elas devolvem linhas com os atributos que a
// segmentacao precisa; quem decide quem entra e quem sai e lib/promocaoVagas.js.
//
// DIVISAO DE TRABALHO, e a razao dela: as comparacoes de IDENTIDADE (mesma pessoa, ja
// inscrito na vaga alvo, descadastrado) NAO acontecem no SQL. Elas exigem o e-mail
// normalizado, e a normalizacao canonica do projeto e a de lib/normalizarEmail, que e
// Unicode-aware — o LOWER() do SQLite dobra apenas ASCII. Um `d.email = LOWER(TRIM(...))`
// aqui seria uma SEGUNDA definicao de "mesma pessoa", divergente da que gravou a linha em
// `descadastros`; o efeito de uma divergencia e alguem que pediu para sair receber e-mail
// mesmo assim. Por isso o SQL entrega os conjuntos e o JS compara. Ver o cabecalho de
// lib/normalizarEmail.js.
//
// O custo disso e carregar as linhas em memoria. Na ordem de grandeza atual (centenas de
// candidaturas, algumas centenas de opt-outs) e irrelevante, e a consulta roda sob demanda
// no painel, nunca em laco.

// Candidaturas na janela de datas, com os atributos de segmentacao.
//
// REUSO de condicoesFiltroCandidatos para os eixos que se sobrepoem (intervalo de datas e
// visibilidade de arquivados), sem toca-la: ela continua com os mesmos 3 call sites do
// painel. `arquivados: 'todos'` porque o publico de campanha e "todo mundo" — uma
// candidatura arquivada em OUTRA vaga nao torna a pessoa inelegivel para saber de uma vaga
// nova (a exclusao por arquivamento vale so na vaga ALVO, e e feita por e-mail no JS).
//
// `recomendacao` sai do relatorio MAIS RECENTE que nao falhou, mesmo criterio e mesma
// forma de subconsulta que listarAplicacoesComContexto ja usa para achar o relatorio de
// uma candidatura. Vem de `reports` (a coluna canonica); applications.status_ia e um
// espelho denormalizado e nao e a fonte usada aqui.
function listarCandidatosParaCampanha({ dataDe, dataAte } = {}) {
  const { where, params } = condicoesFiltroCandidatos({ dataDe, dataAte, arquivados: 'todos' });
  // Sem e-mail nao ha destinatario possivel — descartado ja no SQL.
  const clausula = montarClausula([...where, 'a.email IS NOT NULL', "TRIM(a.email) <> ''"]);

  return getDb()
    .prepare(
      `SELECT
         a.id          AS origem_id,
         a.email       AS email,
         a.nome        AS nome,
         a.sobrenome   AS sobrenome,
         a.utm_source  AS utm_source,
         j.perfil      AS perfil,
         (SELECT r.recomendacao
            FROM reports r
            JOIN interviews i ON i.id = r.interview_id
           WHERE i.application_id = a.id
             AND r.status <> 'erro'
           ORDER BY r.id DESC
           LIMIT 1)   AS recomendacao
       FROM applications a
       LEFT JOIN jobs j ON j.id = a.job_id
       ${clausula}
       ORDER BY a.id`,
    )
    .all(...params);
}

// Talentos (Banco de Curriculos) na mesma janela de datas.
//
// `talentos.criado_em` existe e e NOT NULL, com o mesmo sentido de applications.criado_em
// (momento do cadastro), entao a janela de datas se aplica igual as duas bases — nao ha
// "talento sem data".
//
// NAO ha exclusao por vaga alvo aqui: talentos nao tem job_id.
//
// EXCLUSAO DE `status = 'descartado'`, e por que ela fica NO SQL enquanto as outras duas
// exclusoes automaticas moram no JS: as que estao no JS ('ja inscrito na vaga alvo' e
// 'descadastrado') sao comparacoes de IDENTIDADE — casam PESSOAS entre tabelas pelo
// e-mail normalizado, e por isso dependem da normalizacao Unicode-aware de
// lib/normalizarEmail. Esta aqui e um atributo de LINHA, comparacao de enum exata, sem
// nada a normalizar; e da mesma natureza da janela de datas e do "tem e-mail", que ja
// estao no WHERE. O criterio nao e "onde as outras exclusoes ficam", e sim identidade ->
// JS, atributo de linha -> SQL. Manter no SQL tambem evita carregar linhas que serao
// descartadas em seguida.
//
// 'descartado' e o recrutador dizendo que este curriculo nao serve. Nao e opt-out (a
// pessoa nao pediu nada), mas tambem nao e alguem para quem faz sentido divulgar vaga.
// 'novo', 'contatado' e 'convertido' seguem elegiveis.
// A coluna e NOT NULL DEFAULT 'novo' desde a criacao da tabela, entao `<>` nao corre risco
// de descartar linha por comparacao com NULL.
//
// `perfil_interesse` sai apelidado como `perfil`, o MESMO nome que a Query A da a
// jobs.perfil, de proposito: e o mesmo atributo, no mesmo enum (SDR|CLOSER), e o
// agrupamento em lib/promocaoVagas trata os dois casos com o mesmo codigo. Um talento que
// declarou interesse em CLOSER casa com o filtro de perfil CLOSER; so quem tem NULL aqui
// conta como "sem atributo".
function listarTalentosParaCampanha({ dataDe, dataAte } = {}) {
  const where = ['t.email IS NOT NULL', "TRIM(t.email) <> ''", "t.status <> 'descartado'"];
  const params = [];
  if (dataDe) {
    where.push('date(t.criado_em) >= date(?)');
    params.push(dataDe);
  }
  if (dataAte) {
    where.push('date(t.criado_em) <= date(?)');
    params.push(dataAte);
  }

  return getDb()
    .prepare(
      `SELECT
         t.id               AS origem_id,
         t.email            AS email,
         t.nome             AS nome,
         t.perfil_interesse AS perfil
       FROM talentos t
       ${montarClausula(where)}
       ORDER BY t.id`,
    )
    .all(...params);
}

// E-mails com QUALQUER candidatura na vaga alvo — inclusive arquivada (deleted_at NAO
// entra na condicao, de proposito: quem ja se candidatou aquela vaga nao deve receber
// convite para ela, e arquivar a candidatura nao desfaz o fato de ter se candidatado).
// Devolve os valores CRUS; quem normaliza e compara e o JS.
function listarEmailsInscritosNaVaga(jobId) {
  return getDb()
    .prepare(
      `SELECT email FROM applications
        WHERE job_id = ? AND email IS NOT NULL AND TRIM(email) <> ''`,
    )
    .all(jobId)
    .map((linha) => linha.email);
}

// Todos os opt-outs. A coluna ja guarda o e-mail normalizado (quem escreve passa por
// lib/normalizarEmail), mas quem le normaliza de novo por defesa — custa nada e protege
// contra uma linha que porventura tenha entrado por outro caminho.
function listarEmailsDescadastrados() {
  return getDb()
    .prepare('SELECT email FROM descadastros')
    .all()
    .map((linha) => linha.email);
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
  CANDIDATOS_POR_PAGINA,
  listarAplicacoesComContexto,
  contarAplicacoesComContexto,
  contarEntrevistasConcluidasComContexto,
  listarOrigensDistintas,
  obterReportPorInterview,
  registrarAcessoVaga,
  registrarEventoFunil,
  contarAplicacoes,
  contarEntrevistasConcluidas,
  obterFunilConversao,
  obterOrigemLeads,
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
  // Promocao de Vagas — descadastro (opt-out)
  registrarDescadastro,
  estaDescadastrado,
  // Promocao de Vagas — motor de publico (leitura para campanha)
  listarCandidatosParaCampanha,
  listarTalentosParaCampanha,
  listarEmailsInscritosNaVaga,
  listarEmailsDescadastrados,
  // Canonizacao da origem (utm_source). Exportada para a segmentacao de campanha usar a
  // MESMA regra do filtro do painel — os baldes 'direto' e 'grupo-whats' precisam
  // significar a mesma coisa nos dois lugares, e duas implementacoes divergiriam.
  origemCanonica,
  // roteiros
  obterRoteiro,
  obterRoteiroPorNome,
  obterRoteiroPorPerfil,
  atualizarEstruturaRoteiro,
  criarRoteiro,
  // perfis de curriculo (Banco de Curriculos)
  criarPerfilCurriculo,
  listarPerfisCurriculo,
  buscarPerfilCurriculo,
  buscarPerfilCurriculoAtivoPara,
  atualizarPerfilCurriculo,
  // talentos (Banco de Curriculos)
  criarTalento,
  listarTalentos,
  buscarTalento,
  atualizarStatusTalento,
  STATUS_TALENTO_VALIDOS,
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
  marcarContatoWhatsapp,
  marcarRetomadaEnviada,
  listarPendentesFollowupEntrevista,
  marcarFollowupEntrevistaEnviado,
  listarPendentesEmailRecusa,
  marcarEmailRecusaEnviado,
  listarPendentesLembreteInicio,
  marcarLembreteInicioEnviado,
  // entrevistas
  criarInterview,
  obterInterview,
  obterInterviewEmAndamentoPorAplicacao,
  obterUltimaInterviewPorAplicacao,
  definirUltimoRespId,
  atualizarProgressoInterview,
  ultimaAtividadeInterview,
  acumularTempoPausado,
  finalizarInterview,
  definirVideoUrl,
  listarElegiveisLimpezaAudio,
  criarTurno,
  listarTurnos,
  contarTurnos,
  // relatorios
  criarReport,
  atualizarStatusReport,
  obterReportPorToken,
  obterReportEnviadoPorInterview,
};
