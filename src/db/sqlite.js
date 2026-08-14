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
       endereco, cidade, modalidade, regime, horario,
       descricao, sobre_empresa, cultura_empresa, empresa, video_intro_tipo, video_intro_ref,
       roteiro_id, ativo, entrevista_ativa)
    VALUES
      (@slug, @titulo, @perfil, @faixa_pagamento, @potencial_ganhos, @skills,
       @beneficios, @atividades, @requisitos, @requisitos_obrigatorios, @secoes_extras,
       @endereco, @cidade, @modalidade, @regime, @horario,
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
    // `|| null` uniforme com os vizinhos. Aqui ele nunca converte nada de fato:
    // normalizarCidade ja devolve null ou um canonico da lista, nunca ''. Fica pela
    // simetria e para o dia em que outro chamador passar '' sem saber disso.
    cidade: vaga.cidade || null,
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
         cidade           = @cidade,
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
      cidade: campos.cidade || null,
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

// ── Allowlists SEM contraparte no banco ──
//
// Ao contrario das duas de cima, estas NAO espelham CHECK nenhum: `categoria` e `cargo`
// nasceram sem constraint de proposito (SQLite nao remove CHECK depois — mudar a lista
// exigiria recriar a tabela). Isto aqui e a unica validacao que existe, entao ela nao pode
// ser "melhor esforco": criarTalentosLegado LANCA diante de valor fora da lista, em vez de
// ignorar como fazem listarTalentos/atualizarStatusTalento com filtro invalido.
//
// A diferenca de tratamento e deliberada e segue a natureza do dado: la a entrada vem de
// querystring de tela (valor invalido = filtro nao aplicado, dano zero); aqui vem de um
// arquivo de importacao em lote, e uma categoria escrita errada gravaria 7 mil linhas que
// nenhum filtro do painel encontraria depois.
const CATEGORIAS_TALENTO_VALIDAS = ['legado'];

// Os seis cargos canonicos da base legada. Texto completo e acentuado, exatamente como vai
// para a coluna e como o painel vai exibir — nao ha slug nem codigo intermediario, porque
// nao ha nada que dependa de comparar estes valores alem da propria validacao.
const CARGOS_TALENTO_VALIDOS = [
  'Consultor Comercial',
  'Vendedor',
  'SDR',
  'BDR',
  'Closer',
  'Liderança Comercial',
];

// ── Insercao em LOTE de talentos da base legada ──
//
// POR QUE NAO REUSA criarTalento() ──
// Aquela funcao crava `consent_at = datetime('now')` direto no SQL, sem parametro, e o
// comentario dela explica o porque: a rota so chega la depois de validar o checkbox, entao
// criar a linha E o registro do aceite. Essa premissa nao vale para a base legada — nao ha
// dado de consentimento na origem, e carimbar a data da importacao registraria como fato
// um aceite que nunca aconteceu. `criado_em` tem o mesmo problema pelo lado oposto: o
// default `datetime('now')` faria 7 mil pessoas parecerem cadastradas no dia da importacao,
// e e justamente `criado_em` que o filtro de data da campanha usa (listarTalentosParaCampanha).
//
// Entao as duas colunas viram PARAMETROS EXPLICITOS aqui. Nao foi um parametro novo em
// criarTalento porque os dois caminhos tem invariantes opostas: la, consent_at nunca pode
// ser nulo; aqui, nunca pode ser inventado.
//
// ── TRANSACAO ──
// db.transaction() do better-sqlite3, e nao 7.215 INSERTs soltos: fora de transacao cada
// INSERT vira seu proprio commit em disco, e a importacao inteira levaria ordens de
// grandeza mais tempo. O ganho secundario e o que importa mais — ou entra tudo, ou nao
// entra nada. Uma importacao interrompida pela metade deixaria o operador sem saber onde
// parou, e o UNIQUE que resolveria isso nao existe (talentos.email nao e unico).
//
// ── IDEMPOTENCIA, em duas camadas ──
// Quem chama (o script de importacao) ja filtra quem colidiu com a base. Este filtro AQUI e
// a segunda camada, dentro da mesma transacao: le os e-mails ja existentes em `talentos` e
// ignora os repetidos. Nao e redundancia gratuita — sem UNIQUE na tabela, um `--commit`
// rodado duas vezes por engano duplicaria 7 mil pessoas, e nao ha desfazer barato. A
// comparacao usa normalizarEmail dos DOIS lados (o valor gravado historicamente nao passou
// por normalizacao nenhuma; ver criarTalento).
//
// LANCA diante de categoria/cargo fora da allowlist — e a transacao inteira reverte. Ver o
// comentario das constantes sobre por que aqui e excecao, e nao "ignora o valor invalido".
//
// Devolve { inseridos, ignorados }: os dois numeros importam ao operador, e um total unico
// esconderia a diferenca entre "importou tudo" e "nao fez nada porque ja estava la".
function criarTalentosLegado(registros) {
  const lista = Array.isArray(registros) ? registros : [];
  if (!lista.length) return { inseridos: 0, ignorados: 0 };

  for (const [i, r] of lista.entries()) {
    if (!CATEGORIAS_TALENTO_VALIDAS.includes(r.categoria)) {
      throw new Error(
        `Registro ${i}: categoria invalida (${JSON.stringify(r.categoria)}). ` +
          `Validas: ${CATEGORIAS_TALENTO_VALIDAS.join(', ')}.`,
      );
    }
    if (!CARGOS_TALENTO_VALIDOS.includes(r.cargo)) {
      throw new Error(
        `Registro ${i}: cargo invalido (${JSON.stringify(r.cargo)}). ` +
          `Validos: ${CARGOS_TALENTO_VALIDOS.join(', ')}.`,
      );
    }
    // perfil_interesse continua sob o CHECK do schema, entao um valor torto viraria erro de
    // constraint no meio da transacao. Checar antes da um erro que diz qual registro e qual
    // campo, em vez de "CHECK constraint failed: talentos".
    if (r.perfil_interesse != null && !PERFIS_VALIDOS.includes(r.perfil_interesse)) {
      throw new Error(
        `Registro ${i}: perfil_interesse invalido (${JSON.stringify(r.perfil_interesse)}). ` +
          `Validos: ${PERFIS_VALIDOS.join(', ')} ou null.`,
      );
    }
    // `criado_em` e NOT NULL no schema e NAO tem default aplicavel aqui (o default so vale
    // para INSERT que omite a coluna; este a informa sempre). Sem esta checagem, o sintoma
    // seria "NOT NULL constraint failed" no meio da transacao, sem dizer qual registro.
    if (typeof r.criado_em !== 'string' || !r.criado_em.trim()) {
      throw new Error(
        `Registro ${i}: criado_em ausente. A data da candidatura de origem e obrigatoria — ` +
          'sem ela o talento entraria como cadastrado no dia da importacao, e e essa coluna ' +
          'que o filtro de data da campanha usa.',
      );
    }
  }

  const db = getDb();
  const inserir = db.prepare(`
    INSERT INTO talentos
      (nome, email, telefone, perfil_interesse, categoria, cargo,
       campos_extras, consent_at, criado_em)
    VALUES
      (@nome, @email, @telefone, @perfil_interesse, @categoria, @cargo,
       @campos_extras, @consent_at, @criado_em)
  `);

  const emLote = db.transaction((itens) => {
    const jaExistem = new Set(
      db
        .prepare("SELECT email FROM talentos WHERE email IS NOT NULL AND TRIM(email) <> ''")
        .all()
        .map((l) => normalizarEmail(l.email))
        .filter(Boolean),
    );

    let inseridos = 0;
    let ignorados = 0;
    for (const r of itens) {
      const email = normalizarEmail(r.email);
      // Sem e-mail nao ha como deduplicar nem como enviar campanha; e linha que so
      // engordaria a base. O script ja descarta antes, isto e a rede embaixo.
      if (!email || jaExistem.has(email)) {
        ignorados += 1;
        continue;
      }
      inserir.run({
        nome: r.nome || null,
        email,
        telefone: r.telefone || null,
        perfil_interesse: r.perfil_interesse || null,
        categoria: r.categoria,
        cargo: r.cargo,
        campos_extras: r.campos_extras || null,
        // `?? null` e nao `|| null`: consent_at e SEMPRE null nesta importacao, e o `||`
        // trataria uma string vazia futura do mesmo jeito — aqui a diferenca entre "ausente"
        // e "vazio" e justamente o que se quer preservar.
        consent_at: r.consent_at ?? null,
        criado_em: r.criado_em,
      });
      // O e-mail entra no conjunto para duplicata DENTRO do proprio lote ser ignorada
      // tambem, e nao so a que ja estava no banco.
      jaExistem.add(email);
      inseridos += 1;
    }
    return { inseridos, ignorados };
  });

  return emLote(lista);
}

// Converte a linha crua em objeto do app, parseando `analise` (JSON) — mesmo padrao de
// perfilCurriculoDeLinha. `analise` NULL/invalido vira null (nunca quebra a leitura).
function talentoDeLinha(linha) {
  if (!linha) return null;
  return { ...linha, analise: linha.analise ? lerJson(linha.analise, null) : null };
}

// ── Paginacao da lista de talentos ──
// Mesmo numero e mesma razao de CANDIDATOS_POR_PAGINA: tamanho FIXO, nao configuravel
// pela query string, morando num lugar so porque tres pontos precisam do mesmo valor (o
// LIMIT, o calculo de totalPaginas e os controles de navegacao).
//
// A tela de talentos nasceu sem paginacao, quando a tabela tinha zero linha. A importacao
// da base legada a levou de 0 para 7.215 de uma vez — 434 bytes por linha renderizada, ou
// ~3 MB de HTML numa requisicao. E exatamente o problema que o painel de candidatos ja
// tinha tido com 550 leads, e a solucao aqui e a mesma, de proposito.
const TALENTOS_POR_PAGINA = 25;

// ── Sentinela do filtro de categoria ──
//
// `categoria` tem TRES estados na tela, e um deles e NULL — que nao sai de uma comparacao
// de igualdade. 'legado' e valor real (esta em CATEGORIAS_TALENTO_VALIDAS); "cadastro
// proprio" e a AUSENCIA de valor, e precisa de um nome para viajar na query string.
//
// Este sentinela e de APRESENTACAO, nunca de armazenamento: nenhuma linha do banco tem
// categoria = 'proprio'. Ele existe so para o formulario poder dizer "quero os que nao tem
// categoria" — por isso vive aqui, ao lado do filtro que o consome, e nao em
// CATEGORIAS_TALENTO_VALIDAS, que descreve o que pode ser GRAVADO.
const CATEGORIA_FILTRO_PROPRIO = 'proprio';

// Monta a clausula WHERE compartilhada por listarTalentos e contarTalentos.
//
// UMA funcao para os dois, e nao a condicao repetida em cada query: o denominador da
// paginacao TEM que ser contado sobre o mesmo recorte que a tabela exibe. Duas copias
// divergiriam no primeiro filtro novo, e o sintoma seria "Pagina 3 de 7" numa tela vazia.
// Mesmo espirito de condicoesFiltroCandidatos.
//
// Filtro invalido = filtro INATIVO, nunca erro. E a convencao do projeto para entrada
// vinda de tela/querystring (ver o comentario de enumSaneado em lib/promocaoVagas): o
// efeito de um valor torto e "nao filtra", jamais "filtra por algo que ninguem pediu".
function condicoesFiltroTalentos({ perfil, status, categoria } = {}) {
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

  if (categoria === CATEGORIA_FILTRO_PROPRIO) {
    // Cadastro proprio = o que entrou por /bancodecurriculos. `IS NULL` e nao `= ''`:
    // criarTalento nunca escreve string vazia nesta coluna, ela simplesmente nao e
    // informada no INSERT.
    where.push('categoria IS NULL');
  } else if (CATEGORIAS_TALENTO_VALIDAS.includes(categoria)) {
    where.push('categoria = ?');
    params.push(categoria);
  }

  return { where, params };
}

// Lista talentos com filtro OPCIONAL por perfil_interesse, status e/ou categoria,
// ORDER BY criado_em DESC, uma PAGINA por vez.
//
// `pagina` e 1-indexed e saneada aqui tambem (a rota ja saneia): lixo vira 1. Uma pagina
// alem da ultima nao e erro — o OFFSET devolve vazio e a tela mostra a mensagem de lista
// vazia que ja existia. Mesmo contrato de listarAplicacoesComContexto.
function listarTalentos({ perfil, status, categoria, pagina } = {}) {
  const { where, params } = condicoesFiltroTalentos({ perfil, status, categoria });

  const n = Number(pagina);
  const p = Number.isInteger(n) && n > 0 ? n : 1;

  const sql =
    'SELECT * FROM talentos' +
    (where.length ? ` WHERE ${where.join(' AND ')}` : '') +
    ' ORDER BY criado_em DESC LIMIT ? OFFSET ?';

  return getDb()
    .prepare(sql)
    .all(...params, TALENTOS_POR_PAGINA, (p - 1) * TALENTOS_POR_PAGINA)
    .map(talentoDeLinha);
}

// Total de talentos do recorte, SEM LIMIT/OFFSET — e o denominador da paginacao e o
// "X de Y" do topo da tela. Ignora `pagina` de proposito: paginacao e recorte de
// EXIBICAO, nao filtro, entao passar o mesmo objeto de filtros aqui e em listarTalentos
// e o comportamento correto (e o que garante que os dois nao divirjam).
function contarTalentos({ perfil, status, categoria } = {}) {
  const { where, params } = condicoesFiltroTalentos({ perfil, status, categoria });
  const sql =
    'SELECT COUNT(*) AS total FROM talentos' +
    (where.length ? ` WHERE ${where.join(' AND ')}` : '');
  return getDb().prepare(sql).get(...params).total;
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
// `campanhaId` (3o parametro) e a atribuicao EXATA do clique a uma campanha. Diferente das
// UTM acima em dois pontos, os dois deliberados:
//   - vem da QUERY desta visita, nunca do cookie vm_utm. As UTM sao first-touch e duram 30
//     dias; um retorno organico de quem clicou na campanha semanas atras carrega
//     utm_source='email' pelo cookie, e precisa contar como acesso organico — nao como um
//     segundo clique no e-mail.
//   - e VALIDADO contra `campanhas` antes de gravar. Um `?campanha_id=999999` na URL (link
//     velho, id de campanha excluida, alguem mexendo na barra de endereco) vira NULL, e o
//     acesso e registrado normalmente.
//
// Essa validacao e o que garante a promessa mais importante desta funcao: a METRICA nunca
// derruba o REGISTRO. O acesso a vaga e dado de funil; a atribuicao a campanha e um rotulo
// em cima dele. Sem a checagem, um id inexistente estouraria a FK, a excecao subiria para o
// try/catch de fire-and-forget do handler, e o acesso — que aconteceu de verdade —
// simplesmente nao existiria no funil.
function registrarAcessoVaga(jobId, utm = null, campanhaId = null) {
  const u = utm || {};

  const id = Number(campanhaId);
  let campanhaValida = null;
  if (Number.isInteger(id) && id > 0) {
    const existe = getDb().prepare('SELECT 1 FROM campanhas WHERE id = ?').get(id);
    if (existe) campanhaValida = id;
  }

  getDb()
    .prepare(
      `INSERT INTO vaga_acessos
         (job_id, utm_source, utm_medium, utm_campaign, utm_content, utm_term, campanha_id)
       VALUES
         (@job_id, @utm_source, @utm_medium, @utm_campaign, @utm_content, @utm_term, @campanha_id)`,
    )
    .run({
      job_id: jobId,
      utm_source: u.source || null,
      utm_medium: u.medium || null,
      utm_campaign: u.campaign || null,
      utm_content: u.content || null,
      utm_term: u.term || null,
      campanha_id: campanhaValida,
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
// Promocao de Vagas — campanhas (CRUD do rascunho)
// ──────────────────────────────────────────────────────────────

// `criterios` e JSON no banco (registro historico do recorte usado); vira objeto aqui,
// no mesmo padrao de jobDeLinha/reportDeLinha para as demais colunas JSON do projeto.
function campanhaDeLinha(linha) {
  if (!linha) return null;
  return { ...linha, criterios: lerJson(linha.criterios, {}) };
}

// Cria a campanha em rascunho. `total_destinatarios` e CONGELADO aqui de proposito: e o
// tamanho do publico no momento em que o recorte foi aprovado, e serve depois para
// comparar com o publico recalculado e revelar decadencia (gente que se descadastrou ou
// se candidatou a vaga alvo no meio do caminho).
function criarCampanha({ job_id, assunto, corpo_html, criterios, total_destinatarios } = {}) {
  const info = getDb()
    .prepare(
      `INSERT INTO campanhas (job_id, assunto, corpo_html, criterios, total_destinatarios)
       VALUES (?, ?, ?, ?, ?)`,
    )
    .run(
      job_id,
      assunto,
      corpo_html,
      JSON.stringify(criterios || {}),
      Number.isFinite(Number(total_destinatarios)) ? Number(total_destinatarios) : 0,
    );
  return Number(info.lastInsertRowid);
}

// Todas as campanhas, mais recentes primeiro, ja com o titulo da vaga (a listagem sempre
// precisa dele; evita N+1 na tela).
function listarCampanhas() {
  return getDb()
    .prepare(
      `SELECT c.*, j.titulo AS vaga_titulo, j.perfil AS vaga_perfil
         FROM campanhas c
         LEFT JOIN jobs j ON j.id = c.job_id
        ORDER BY c.id DESC`,
    )
    .all()
    .map(campanhaDeLinha);
}

function obterCampanha(id) {
  return campanhaDeLinha(
    getDb()
      .prepare(
        `SELECT c.*, j.titulo AS vaga_titulo, j.perfil AS vaga_perfil, j.slug AS vaga_slug
           FROM campanhas c
           LEFT JOIN jobs j ON j.id = c.job_id
          WHERE c.id = ?`,
      )
      .get(id),
  );
}

// ──────────────────────────────────────────────────────────────
// Promocao de Vagas — disparo (materializacao + fila de envio)
// ──────────────────────────────────────────────────────────────

// Materializa o publico de uma campanha e a passa para 'enfileirada', TUDO OU NADA.
//
// UNICA transacao explicita do projeto, e nao por desempenho (o volume nao chega a doer):
// e por ATOMICIDADE. Sem ela, uma queda no meio do laco deixaria a campanha em 'rascunho'
// com N linhas ja materializadas — o estado anormal que enfileirarCampanha depois recusa a
// tocar, exigindo intervencao manual no banco. Com a transacao esse estado nao nasce: ou o
// publico inteiro existe e a campanha esta enfileirada, ou nada aconteceu.
//
// better-sqlite3 e SINCRONO, entao db.transaction() e seguro aqui: nao ha await dentro do
// laco que pudesse intercalar outra escrita no meio da transacao. Nao use este padrao com
// callback async — a transacao fecharia antes do trabalho terminar.
//
// `email` entra JA NORMALIZADO (a exigencia do schema); quem chama (lib/dispararPromocao)
// recebe do motor de publico, que ja normaliza. Normalizamos DE NOVO aqui por defesa: o
// UNIQUE(campanha_id, email) so vale como idempotencia se a grafia for canonica.
function materializarEnviosCampanha(campanhaId, destinatarios = []) {
  const bd = getDb();

  const inserir = bd.prepare(
    `INSERT INTO campanha_envios (campanha_id, email, nome, origem_tipo, origem_id)
     VALUES (?, ?, ?, ?, ?)`,
  );
  const enfileirar = bd.prepare(
    `UPDATE campanhas SET status = 'enfileirada', enfileirada_em = datetime('now'),
            total_destinatarios = ?
      WHERE id = ? AND status = 'rascunho'`,
  );

  const executar = bd.transaction((lista) => {
    let gravados = 0;
    for (const d of lista) {
      const email = normalizarEmail(d.email);
      // Sem e-mail nao ha destinatario. Pular em silencio seria esconder um furo do motor
      // de publico; mas ABORTAR a campanha inteira por causa de uma linha suja seria pior.
      // Contamos so o que de fato virou linha, e o total gravado reflete isso.
      if (!email) continue;
      inserir.run(campanhaId, email, d.nome || null, d.origemTipo, d.origemId ?? null);
      gravados += 1;
    }
    // O total gravado passa a ser o do publico CONGELADO agora — o numero contra o qual o
    // painel mede progresso. O da criacao do rascunho ja cumpriu o papel dele (revelar
    // decadencia na tela de revisao) e nao serve mais como denominador.
    const info = enfileirar.run(gravados, campanhaId);
    if (info.changes !== 1) {
      // Guarda de ULTIMA linha: se a campanha saiu de 'rascunho' entre a leitura da lib e
      // este UPDATE, a transacao inteira volta atras e nenhuma linha fica orfa.
      throw new Error(
        `campanha ${campanhaId} nao estava mais em 'rascunho' no momento da materializacao`,
      );
    }
    return gravados;
  });

  return executar(destinatarios);
}

// Quantas linhas de envio esta campanha ja tem. Serve de guarda contra materializacao
// duplicada (ver lib/dispararPromocao) e de base para o progresso na tela.
function contarEnviosCampanha(campanhaId) {
  const linhas = getDb()
    .prepare('SELECT status, COUNT(*) AS n FROM campanha_envios WHERE campanha_id = ? GROUP BY status')
    .all(campanhaId);

  const contagem = { pendente: 0, enviado: 0, falha: 0, cancelado: 0, total: 0 };
  for (const l of linhas) {
    if (l.status in contagem) contagem[l.status] = l.n;
    contagem.total += l.n;
  }
  return contagem;
}

// Cliques de uma campanha: acessos a pagina da vaga vindos do link daquele e-mail.
//
// ── CONTA ACESSOS, NAO PESSOAS — e a limitacao e do dado, nao da consulta ──
// `vaga_acessos` e uma tabela ANONIMA: a pagina da vaga e publica e o acesso e registrado
// antes de qualquer identificacao (nao ha login, nao ha token, e o cookie vm_utm guarda a
// origem, nunca um identificador de pessoa). Nao existe coluna que diga "quem" — nem
// e-mail, nem sessao, nem fingerprint.
//
// Entao o numero e ACESSOS: recarregar a pagina conta de novo, e a mesma pessoa que abre o
// e-mail no celular e depois no computador conta duas vezes. Consequencia pratica: cliques
// PODE passar recebidos, e a taxa pode dar mais de 100%.
//
// Deduplicar por IP+user-agent, ou por janela de tempo, seria inventar uma identidade que
// o dado nao tem — e daria um numero mais bonito e menos verdadeiro. A tela rotula
// "cliques" (nao "pessoas") e essa e a informacao honesta disponivel.
function contarCliquesCampanha(campanhaId) {
  const id = Number(campanhaId);
  if (!Number.isInteger(id) || id <= 0) return { total: 0 };

  const linha = getDb()
    .prepare('SELECT COUNT(*) AS total FROM vaga_acessos WHERE campanha_id = ?')
    .get(id);

  return { total: linha.total };
}

// Apaga uma campanha em RASCUNHO. O unico DELETE do projeto inteiro.
//
// ── POR QUE APAGAR DE VERDADE, num codigo que nunca apagou nada ──
// Todo o resto do sistema usa soft-delete (applications.deleted_at) ou transicao de
// status, e por bons motivos: candidatura arquivada e historico, campanha enviada e
// auditoria, e-mail que saiu nao se desfaz. Nada disso vale para um rascunho: ele nunca
// produziu efeito no mundo. Nenhum e-mail saiu, nenhum destinatario foi congelado, e o
// "historico" de um rascunho abandonado e ruido na tela, nao registro.
//
// ── AS DUAS TRAVAS, e por que sao duas ──
// 1. status === 'rascunho'. E o unico estado que nunca tocou ninguem. Uma campanha
//    'enfileirada' ja congelou o publico; 'enviando' e 'concluida' ja mandaram e-mail;
//    'cancelada' e registro de uma decisao. Nenhum deles pode sumir do banco.
// 2. contarEnviosCampanha(id).total === 0. Redundante COM a primeira em teoria — rascunho
//    nao tem envios, porque a materializacao so acontece no enfileiramento — e proposital
//    mesmo assim: `enfileirarCampanha` ja trata "rascunho COM envios" como anomalia real
//    (guard ENVIOS_PREEXISTENTES), sinal de banco editado a mao ou restore parcial. Diante
//    de estado que "nao deveria existir", a resposta do projeto e recusar e pedir olho
//    humano — nunca apagar por cima. Apagar seria a pior reacao possivel: destruiria
//    justamente a evidencia de que algo esta errado.
//
// A FK campanha_envios.campanha_id -> campanhas(id) e a terceira linha de defesa, essa no
// banco: com `foreign_keys = ON` (ver getDb), um DELETE que escapasse das duas travas
// acima ainda falharia se houvesse envios. NAO existe ON DELETE CASCADE, e nao deve
// existir — cascata aqui apagaria o registro de quem recebeu e-mail.
//
// Resultado DISCRIMINADO, nunca lanca (mesmo contrato de enfileirarCampanha): quem chama e
// uma rota de painel, que precisa virar mensagem na tela e nao 500.
//   { ok: true }
//   { ok: false, erroCodigo: 'CAMPANHA_NAO_ENCONTRADA' | 'STATUS_INVALIDO' | 'TEM_ENVIOS', mensagem }
//
// Transacao: a leitura do status, a contagem de envios e o DELETE precisam ver o MESMO
// estado. Sem ela, uma campanha disparada entre a checagem e o DELETE seria apagada depois
// de ja ter congelado o publico.
function excluirCampanha(id) {
  const campanhaId = Number(id);
  if (!Number.isInteger(campanhaId) || campanhaId <= 0) {
    return {
      ok: false,
      erroCodigo: 'CAMPANHA_NAO_ENCONTRADA',
      mensagem: 'Campanha não encontrada.',
    };
  }

  const db = getDb();

  const executar = db.transaction(() => {
    const campanha = db.prepare('SELECT id, status FROM campanhas WHERE id = ?').get(campanhaId);
    if (!campanha) {
      return {
        ok: false,
        erroCodigo: 'CAMPANHA_NAO_ENCONTRADA',
        mensagem: 'Campanha não encontrada.',
      };
    }

    if (campanha.status !== 'rascunho') {
      return {
        ok: false,
        erroCodigo: 'STATUS_INVALIDO',
        status: campanha.status,
        mensagem:
          `Esta campanha está em "${campanha.status}" e só é possível excluir uma campanha ` +
          'em rascunho. Uma campanha que já foi disparada é registro do que saiu, e não ' +
          'pode ser apagada.',
      };
    }

    const envios = contarEnviosCampanha(campanhaId);
    if (envios.total > 0) {
      console.error(
        `[promocao] ANOMALIA: campanha ${campanhaId} esta em 'rascunho' mas ja tem ` +
          `${envios.total} linha(s) em campanha_envios. Exclusao recusada.`,
      );
      return {
        ok: false,
        erroCodigo: 'TEM_ENVIOS',
        mensagem:
          `Esta campanha está em rascunho mas já tem ${envios.total} destinatário(s) ` +
          'materializados — um estado que não deveria existir. A exclusão foi recusada por ' +
          'segurança. Verifique o banco antes de tentar de novo.',
      };
    }

    db.prepare('DELETE FROM campanhas WHERE id = ?').run(campanhaId);
    return { ok: true };
  });

  const r = executar();
  if (r.ok) console.log(`[promocao] campanha ${campanhaId} (rascunho, sem envios) excluida.`);
  return r;
}

// A fila de trabalho da varredura: os envios pendentes de campanhas que AINDA DEVEM sair.
//
// O JOIN com `campanhas` nao e conveniencia para trazer assunto e corpo — e um FILTRO DE
// SEGURANCA. Linha 'pendente' de uma campanha cancelada (ou que voltou a rascunho por
// qualquer caminho) NAO pode ser enviada; a rotina nunca deve assumir que todo pendente
// merece um e-mail. Hoje nao ha cancelamento na tela, e e exatamente por isso que a
// condicao precisa existir agora: quando ele chegar, a fila ja o respeita.
//
// ORDEM por id: a fila drena na ordem em que foi materializada, e o `LIMIT` recorta
// sempre do mesmo comeco — sem isso, o cap por ciclo poderia revisitar os mesmos.
function listarEnviosPendentesCampanha({ limite = 125 } = {}) {
  const teto = Number.isInteger(limite) && limite > 0 ? limite : 125;
  return getDb()
    .prepare(
      // `vaga_slug` alimenta o link de candidatura do e-mail (lib/ctaCampanha).
      //
      // LEFT JOIN, e nao JOIN: com INNER, uma vaga removida faria estas linhas SUMIREM da
      // fila — e some-las nao as resolve. Elas ficariam 'pendente' para sempre, a campanha
      // nunca perderia o ultimo pendente e nunca seria concluida (concluirCampanhasEsgotadas
      // so fecha quando pendente = 0). Um link faltando e um problema; uma campanha
      // eternamente 'enviando' e um vazamento de estado. Com LEFT JOIN o slug vem null e o
      // e-mail sai sem o bloco de CTA — degradacao visivel, nao travamento.
      // Os campos j.* alem do slug alimentam o CABECALHO do e-mail (titulo, empresa,
      // endereco, modalidade, regime, horario). Vem daqui, do MESMO LEFT JOIN, e nao de um
      // db.obterVaga por destinatario: seriam 125 consultas por ciclo para um dado que a
      // query ja tem em maos. Todos sao nullable — o cabecalho omite o que faltar.
      // `e.tentativas` decide, no momento da falha, entre devolver a linha a fila ou
      // encerra-la: quem compara com o teto e a varredura, e ela so tem em maos o que esta
      // consulta trouxer. Sem esta coluna aqui, a retentativa seria infinita.
      `SELECT e.id, e.campanha_id, e.email, e.nome, e.tentativas,
              c.assunto AS assunto, c.corpo_html AS corpo_html,
              j.slug AS vaga_slug,
              j.titulo AS vaga_titulo, j.perfil AS vaga_perfil, j.empresa AS vaga_empresa,
              j.endereco AS vaga_endereco, j.modalidade AS vaga_modalidade,
              j.regime AS vaga_regime, j.horario AS vaga_horario
         FROM campanha_envios e
         JOIN campanhas c ON c.id = e.campanha_id
         LEFT JOIN jobs j ON j.id = c.job_id
        WHERE e.status = 'pendente'
          AND c.status IN ('enfileirada', 'enviando')
        ORDER BY e.id
        LIMIT ?`,
    )
    .all(teto);
}

// Marca UM envio como entregue. Condicional (`WHERE status = 'pendente'`), mesmo padrao de
// marcarLembreteInicioEnviado: se dois ciclos se cruzarem, o segundo grava 0 linhas.
// Devolve o nº de linhas afetadas (0 = ja processado por outro caminho).
function marcarEnvioCampanhaEnviado(id) {
  const info = getDb()
    .prepare(
      `UPDATE campanha_envios SET status = 'enviado', enviado_em = datetime('now'), erro = NULL
        WHERE id = ? AND status = 'pendente'`,
    )
    .run(id);
  return info.changes;
}

// Marca UM envio como falho, com a mensagem truncada. Tambem condicional, pela mesma razao.
// A linha SAI da fila, definitivamente.
//
// ── CORRECAO DE UM COMENTARIO QUE ESTAVA AQUI E ESTAVA ERRADO ──
// Ate agora este bloco afirmava que "uma falha de envio em massa raramente e transitoria
// (endereco morto, recusa do provedor)" e que por isso toda falha era terminal. A afirmacao
// nao tinha dado por tras, e quando o dado chegou ele disse o OPOSTO: das 2.945 linhas
// perdidas, 2.945 eram transitorias — 2.793 HTTP 429 por rajada e 152 HTTP 403 por cota
// diaria. Nenhum endereco morto. Nenhuma recusa de endereco. O comentario nao era so
// impreciso: ele era a justificativa escrita de um desenho que custou a base inteira de uma
// campanha.
//
// O que sobrou de verdadeiro nele: retentar SEM CRITERIO a cada 15 min queimaria reputacao
// de dominio. E por isso que quem decide chamar esta funcao e classificarErroEnvio, e nao o
// catch cru — ela so e chamada quando a falha e do ENDERECO (bounce, recusa) ou quando o
// teto de tentativas da categoria se esgotou. O caso transitorio vai para
// registrarTentativaEnvioCampanha, logo abaixo, e a linha continua na fila.
//
// Continua valendo que reprocessar uma linha ja em 'falha' e decisao humana: nada na
// aplicacao devolve uma linha de 'falha' para 'pendente'.
function marcarEnvioCampanhaFalha(id, erro) {
  const info = getDb()
    .prepare(
      // tentativas + 1 tambem aqui: a tentativa que ESGOTOU o teto foi uma tentativa como
      // as outras. Sem incrementar, o contador gravado ficaria um abaixo do numero real de
      // e-mails que sairam por esta linha — e esse contador e o que o painel e a apuracao
      // vao ler depois para saber quanto o provedor custou.
      `UPDATE campanha_envios SET status = 'falha', erro = ?, tentativas = tentativas + 1
        WHERE id = ? AND status = 'pendente'`,
    )
    .run(String(erro || '').slice(0, 300), id);
  return info.changes;
}

// Registra uma tentativa que FALHOU MAS PODE DAR CERTO DEPOIS: conta o esforco, guarda o
// erro e DEIXA A LINHA EM 'pendente'. E a contrapartida de marcarEnvioCampanhaFalha — a
// mesma escrita, menos a parte que tira a linha da fila.
//
// Nao ha agendamento nem fila de retentativa: quem reapresenta a linha e a propria varredura
// de 15 em 15 min, porque 'pendente' e exatamente o criterio de
// listarEnviosPendentesCampanha. O intervalo do ciclo JA E o backoff.
//
// Condicional ao 'pendente' pela mesma razao das duas irmas: se outro caminho ja resolveu
// esta linha, esta escrita nao pode ressuscita-la para a fila.
function registrarTentativaEnvioCampanha(id, erro) {
  const info = getDb()
    .prepare(
      `UPDATE campanha_envios SET erro = ?, tentativas = tentativas + 1
        WHERE id = ? AND status = 'pendente'`,
    )
    .run(String(erro || '').slice(0, 300), id);
  return info.changes;
}

// Campanhas que a varredura ainda precisa olhar. Curta por natureza (uma campanha sai
// daqui assim que conclui), entao percorre-la a cada ciclo custa praticamente nada.
function listarCampanhasEmAndamento() {
  return getDb()
    .prepare(
      `SELECT id, status FROM campanhas
        WHERE status IN ('enfileirada', 'enviando')
        ORDER BY id`,
    )
    .all();
}

// 'enfileirada' -> 'enviando': marca que a campanha ja comecou a sair de fato.
// Condicional, para nao reverter uma campanha que outro caminho ja concluiu ou cancelou.
function marcarCampanhaEnviando(id) {
  const info = getDb()
    .prepare(
      `UPDATE campanhas SET status = 'enviando' WHERE id = ? AND status = 'enfileirada'`,
    )
    .run(id);
  return info.changes;
}

// Fecha a campanha. Condicional ao estado em andamento: uma campanha cancelada no meio do
// caminho nao pode ser "concluida" por uma varredura que chegou depois.
function concluirCampanha(id) {
  const info = getDb()
    .prepare(
      `UPDATE campanhas SET status = 'concluida', finalizada_em = datetime('now')
        WHERE id = ? AND status IN ('enfileirada', 'enviando')`,
    )
    .run(id);
  return info.changes;
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
         -- applications.cidade e coluna ORFA (ver schema.sql): o fluxo publico nao a
         -- grava mais, e ela so tem valor quando o recrutador digitou a mao na tela de
         -- edicao do candidato. Vem assim mesmo porque o filtro de cidade da campanha
         -- precisa enxergar as duas bases pelo mesmo eixo — e "quase sempre NULL" e um
         -- resultado honesto, tratado como "sem atributo" la em cima.
         a.cidade      AS cidade,
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
         t.perfil_interesse AS perfil,
         -- categoria alimenta o filtro de BASE da campanha ('legado' vs cadastro
         -- proprio, que e NULL aqui). NAO filtra nada nesta query de proposito: quem
         -- decide o recorte e lib/promocaoVagas, e um WHERE por categoria aqui excluiria
         -- 7.215 pessoas do publico sem que nenhum criterio de tela tivesse pedido.
         t.categoria        AS categoria,
         t.cidade           AS cidade
       FROM talentos t
       ${montarClausula(where)}
       ORDER BY t.id`,
    )
    .all(...params);
}

// ──────────────────────────────────────────────────────────────
// Disparo por WhatsApp — leituras do motor de publico
// ──────────────────────────────────────────────────────────────

// Candidatos de uma praca. A cidade vem da VAGA (jobs.cidade), porque applications.cidade
// e coluna orfa e esta 0% preenchida — ver lib/publicoDisparoWhatsapp.
//
// `j.cidade = ?` ja exclui vaga REMOTA sem condicao extra: em SQL, NULL nao e igual a nada.
// Vale registrar porque parece omissao e nao e.
//
// ORDER BY a.id: a ordem decide quem vence o dedup quando a mesma pessoa tem duas
// candidaturas na praca. A primeira (mais antiga) ganha — escolha arbitraria mas ESTAVEL,
// que e o que importa: sem ORDER BY, duas execucoes seguidas poderiam mandar cargos
// diferentes para a mesma pessoa.
//
// Telefone vem CRU. Quem normaliza e o motor, com lib/whatsapp — normalizar em SQL exigiria
// reimplementar a mesma regra numa segunda linguagem.
function listarCandidatosPorCidadeVaga(cidade) {
  return getDb()
    .prepare(
      `SELECT a.id, a.nome, a.telefone, j.perfil
         FROM applications a
         JOIN jobs j ON j.id = a.job_id
        WHERE j.cidade = ?
          AND a.telefone IS NOT NULL AND TRIM(a.telefone) <> ''
        ORDER BY a.id`,
    )
    .all(cidade);
}

// Talentos da base legada de uma praca. Comparacao EXATA de cidade.
//
// O sentinela 'Todas as cidades' e barrado aqui explicitamente, alem de ser barrado de novo
// no motor. Redundante de proposito: e a unica regra deste subsistema cujo erro produz
// mensagem para quem nao deveria receber, e a checagem custa nada perto disso. Como o
// parametro `cidade` nunca e o sentinela (o chamador valida contra CIDADES_VALIDAS, que nao
// o contem), esta condicao e cinto de seguranca — nao a trava principal.
function listarLegadoPorCidade(cidade) {
  return getDb()
    .prepare(
      `SELECT id, nome, telefone, cargo, cidade
         FROM talentos
        WHERE categoria = 'legado'
          AND cidade = ?
          AND cidade <> 'Todas as cidades'
          AND telefone IS NOT NULL AND TRIM(telefone) <> ''
        ORDER BY id`,
    )
    .all(cidade);
}

// Todos os telefones que ja tem linha em disparos_whatsapp, como Set para lookup O(1).
//
// SEM filtro de status e SEM filtro de cidade, de proposito: quem tem linha, tem linha.
// 'erro' tambem segura o telefone (reprocessar e decisao humana, nao automatica), e um
// convite ja entregue para outra praca nao deve virar um segundo convite.
//
// A coluna ja esta normalizada na escrita, entao a comparacao contra o telefone normalizado
// do motor e direta. Set inteiro em memoria: sao ~1.000 linhas hoje e o alternativo seria um
// SELECT por pessoa dentro do laco.
function listarTelefonesDisparados() {
  return new Set(
    getDb()
      .prepare('SELECT telefone FROM disparos_whatsapp')
      .all()
      .map((l) => l.telefone),
  );
}

// Registra o resultado de UMA tentativa de disparo. Upsert por telefone.
//
// ON CONFLICT ... DO UPDATE, e nao INSERT OR REPLACE: o REPLACE APAGA a linha e insere
// outra, o que trocaria o `id` e zeraria `criado_em` para o default — perdendo justamente o
// registro de quando aquela pessoa entrou no livro-razao pela primeira vez. O upsert
// preserva id e criado_em e atualiza so o que a tentativa nova diz.
//
// `erro_msg` e sobrescrito SEMPRE (inclusive para NULL quando a nova tentativa deu certo):
// a coluna descreve a tentativa ATUAL, e deixar a mensagem de um erro anterior colada numa
// linha 'enviado' faria o painel mostrar um erro que nao existe mais.
function registrarDisparoWhatsapp({ telefone, nome, status, erroMsg, origem, cidade, enviadoEm }) {
  const info = getDb()
    .prepare(
      `INSERT INTO disparos_whatsapp (telefone, nome, status, erro_msg, origem, cidade, enviado_em)
       VALUES (@telefone, @nome, @status, @erro_msg, @origem, @cidade, @enviado_em)
       ON CONFLICT(telefone) DO UPDATE SET
         nome       = COALESCE(excluded.nome, disparos_whatsapp.nome),
         status     = excluded.status,
         erro_msg   = excluded.erro_msg,
         origem     = COALESCE(excluded.origem, disparos_whatsapp.origem),
         cidade     = COALESCE(excluded.cidade, disparos_whatsapp.cidade),
         enviado_em = COALESCE(excluded.enviado_em, disparos_whatsapp.enviado_em)`,
    )
    .run({
      telefone,
      // COALESCE nos campos de CONTEXTO (nome, origem, cidade, enviado_em): uma chamada que
      // nao os informa nao deve APAGAR o que ja se sabia. Um n8n que so manda
      // {telefone, status} nao pode custar o nome que o disparo anterior gravou.
      nome: nome || null,
      status,
      erro_msg: erroMsg || null,
      origem: origem || null,
      cidade: cidade || null,
      enviado_em: enviadoEm || null,
    });
  return info.changes;
}

// ──────────────────────────────────────────────────────────────
// Sequencia de WhatsApp (WA1/WA2) — fila
// ──────────────────────────────────────────────────────────────

// Agenda UMA etapa. Idempotente pelo UNIQUE(application_id, etapa): chamar duas vezes para a
// mesma candidatura nao duplica, e o DO NOTHING evita que o segundo agendamento vire
// excecao no meio da criacao de uma candidatura.
//
// Devolve true se criou, false se ja existia — o chamador usa isso so para o log.
function agendarEnvioWhatsapp({ applicationId, etapa, telefone, agendadoPara, templateNome }) {
  const info = getDb()
    .prepare(
      `INSERT INTO whatsapp_sequencia_envios
         (application_id, etapa, telefone_e164, template_nome, status, agendado_para)
       VALUES (?, ?, ?, ?, 'pendente', ?)
       ON CONFLICT(application_id, etapa) DO NOTHING`,
    )
    .run(applicationId, etapa, telefone, templateNome || null, agendadoPara);
  return info.changes > 0;
}

// A fila do ciclo: o que ja venceu e ainda nao saiu.
//
// ORDER BY agendado_para: quem esperou mais sai primeiro. Sem ordem, o teto por ciclo
// recortaria arbitrariamente e um WA2 atrasado poderia ficar para tras indefinidamente
// enquanto WA1 novos passam na frente.
//
// O JOIN traz o que o texto precisa (nome, vaga, empresa) — sao poucos por ciclo, mas uma
// consulta por linha seria N+1 por nada, e o motor ja tem tudo aqui.
function listarPendentesSequenciaWhatsapp({ limite = 50, agora = null } = {}) {
  const teto = Number.isInteger(limite) && limite > 0 ? limite : 50;
  return getDb()
    .prepare(
      `SELECT s.id, s.application_id, s.etapa, s.telefone_e164, s.tentativas, s.agendado_para,
              a.nome AS app_nome, a.telefone AS app_telefone,
              j.titulo AS job_titulo, j.empresa AS job_empresa, j.perfil AS job_perfil
         FROM whatsapp_sequencia_envios s
         JOIN applications a ON a.id = s.application_id
         LEFT JOIN jobs j ON j.id = a.job_id
        WHERE s.status = 'pendente'
          AND s.agendado_para <= COALESCE(?, datetime('now'))
        ORDER BY s.agendado_para ASC
        LIMIT ?`,
    )
    .all(agora, teto);
}

// Marca como enviada. Condicional ao 'pendente', mesmo padrao de marcarEnvioCampanhaEnviado:
// se dois ciclos se cruzarem, o segundo grava 0 linhas.
function marcarSequenciaWhatsappEnviada(id, quando = null) {
  return getDb()
    .prepare(
      `UPDATE whatsapp_sequencia_envios
          SET status = 'enviado', enviado_em = COALESCE(?, datetime('now')), erro = NULL,
              tentativas = tentativas + 1
        WHERE id = ? AND status = 'pendente'`,
    )
    .run(quando, id).changes;
}

// Conta a tentativa e DEIXA em 'pendente' — a linha volta no proximo ciclo.
function registrarTentativaSequenciaWhatsapp(id, erro) {
  return getDb()
    .prepare(
      `UPDATE whatsapp_sequencia_envios SET erro = ?, tentativas = tentativas + 1
        WHERE id = ? AND status = 'pendente'`,
    )
    .run(String(erro || '').slice(0, 300), id).changes;
}

// Encerra em falha. Usado quando o teto de tentativas estoura E quando o telefone e
// invalido — este ultimo sem passar por retry, porque tentar de novo nao conserta o numero.
function marcarSequenciaWhatsappFalha(id, erro) {
  return getDb()
    .prepare(
      `UPDATE whatsapp_sequencia_envios
          SET status = 'falha', erro = ?, tentativas = tentativas + 1
        WHERE id = ? AND status = 'pendente'`,
    )
    .run(String(erro || '').slice(0, 300), id).changes;
}

// Resumo por etapa/status, para o painel do Incremento 7 e para o log do ciclo.
function contarSequenciaWhatsapp(applicationId = null) {
  const where = applicationId ? 'WHERE application_id = ?' : '';
  const params = applicationId ? [applicationId] : [];
  return getDb()
    .prepare(`SELECT etapa, status, COUNT(*) n FROM whatsapp_sequencia_envios ${where} GROUP BY etapa, status`)
    .all(...params);
}

// Cidades distintas que existem no banco, para montar as opcoes do filtro de campanha.
//
// UNIAO de TRES fontes: `talentos.cidade` (preenchida por backfill nos importados),
// `applications.cidade` (coluna orfa, so preenchida quando o recrutador digitou a mao) e
// `jobs.cidade` (praca da vaga, enum fechado de lib/cidades).
// Ler as tres e o que impede a tela de oferecer um recorte que ignora parte do publico.
//
// ── POR QUE jobs.cidade ENTRA DIRETO, e nao por join com applications ──
// A alternativa seria unir so as pracas de vagas QUE TEM CANDIDATO, o que a primeira vista
// parece mais honesto: nao oferecer um filtro que devolve zero. Duas razoes contra:
//
//   1. `jobs.cidade` e ENUM FECHADO. Ela nao traz sujeira nem variacao de grafia — que era
//      o motivo original de esta funcao existir em vez de um SELECT DISTINCT solto. Vaga
//      sem praca (remota) tem a coluna NULL e ja e filtrada pelo WHERE, entao o join nao
//      protegeria de nada que o proprio dominio nao proteja.
//   2. O join criaria uma lista que MUDA sozinha. Uma vaga nova em Curitiba so apareceria
//      no filtro depois da primeira candidatura, e a praca sumiria de novo se a candidatura
//      fosse arquivada. Opcao de filtro que aparece e desaparece conforme o movimento da
//      base e pior que uma opcao que devolve zero: a segunda o operador entende na hora, a
//      primeira parece bug.
//
// O custo de errar para este lado e uma opcao a mais na lista, que devolve publico vazio e
// se explica sozinha. O custo do outro lado e uma praca invisivel — que ninguem procura,
// porque ninguem sabe que existe.
//
// O SENTINELA NAO ENTRA na lista. 'Todas as cidades' nao e uma cidade: e um coringa que
// casa com qualquer selecao (ver lib/promocaoVagas). Oferece-lo como opcao marcavel
// convidaria o operador a marca-lo achando que precisa — e a nao marca-lo seria o erro
// oposto, mais provavel ainda. Fora da lista, ele funciona sozinho.
//
// Ordem alfabetica com localeCompare em pt-BR: 'Balneário' antes de 'Campinas' exige
// comparacao que entenda acento, e o ORDER BY do SQLite nao entende.
function listarCidadesDistintas() {
  const db = getDb();
  const cru = db
    .prepare(
      `SELECT cidade FROM talentos WHERE cidade IS NOT NULL AND TRIM(cidade) <> ''
       UNION
       SELECT cidade FROM applications WHERE cidade IS NOT NULL AND TRIM(cidade) <> ''
       UNION
       SELECT cidade FROM jobs WHERE cidade IS NOT NULL AND TRIM(cidade) <> ''`,
    )
    .all()
    .map((l) => String(l.cidade).trim())
    .filter((c) => c && c !== 'Todas as cidades');

  return [...new Set(cru)].sort((a, b) => a.localeCompare(b, 'pt-BR'));
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
  listarCidadesDistintas,
  agendarEnvioWhatsapp,
  listarPendentesSequenciaWhatsapp,
  marcarSequenciaWhatsappEnviada,
  registrarTentativaSequenciaWhatsapp,
  marcarSequenciaWhatsappFalha,
  contarSequenciaWhatsapp,
  listarCandidatosPorCidadeVaga,
  listarLegadoPorCidade,
  listarTelefonesDisparados,
  registrarDisparoWhatsapp,
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
  // Promocao de Vagas — campanhas (CRUD do rascunho)
  criarCampanha,
  listarCampanhas,
  obterCampanha,
  excluirCampanha,
  // Promocao de Vagas — disparo (materializacao + fila de envio)
  materializarEnviosCampanha,
  contarEnviosCampanha,
  contarCliquesCampanha,
  listarEnviosPendentesCampanha,
  marcarEnvioCampanhaEnviado,
  marcarEnvioCampanhaFalha,
  registrarTentativaEnvioCampanha,
  listarCampanhasEmAndamento,
  marcarCampanhaEnviando,
  concluirCampanha,
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
  criarTalentosLegado,
  listarTalentos,
  contarTalentos,
  buscarTalento,
  atualizarStatusTalento,
  STATUS_TALENTO_VALIDOS,
  CATEGORIAS_TALENTO_VALIDAS,
  CARGOS_TALENTO_VALIDOS,
  TALENTOS_POR_PAGINA,
  CATEGORIA_FILTRO_PROPRIO,
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
