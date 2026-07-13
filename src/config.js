'use strict';

// Le e valida as variaveis de ambiente. E a UNICA fonte de configuracao do app.
// Nada de process.env espalhado pelo codigo: tudo passa por aqui.

const path = require('node:path');
require('dotenv').config();

function bool(valor, padrao = false) {
  if (valor === undefined || valor === '') return padrao;
  return ['1', 'true', 'sim', 'yes'].includes(String(valor).toLowerCase());
}

function num(valor, padrao) {
  const n = Number.parseInt(valor, 10);
  return Number.isFinite(n) ? n : padrao;
}

const ambiente = process.env.NODE_ENV || 'development';
const ehProducao = ambiente === 'production';

const config = {
  ambiente,
  ehProducao,

  porta: num(process.env.PORT, 3000),

  // URL publica base para montar links em e-mails (ex.: link do relatorio ao recrutador).
  baseUrl: (process.env.APP_BASE_URL || 'https://entrevista.vendedormestre.com.br').replace(/\/+$/, ''),

  // Caminho do arquivo SQLite. Em producao aponta para o volume (/data/app.db).
  caminhoBanco: path.resolve(process.env.DATABASE_PATH || './data/app.db'),

  // Pasta de curriculos (PDFs), no mesmo volume persistente do banco (ex.: /data/curriculos).
  caminhoCurriculos: path.resolve(
    path.dirname(process.env.DATABASE_PATH || './data/app.db'),
    'curriculos',
  ),

  // Pasta dos audios de resposta das entrevistas (ex.: /data/entrevistas).
  caminhoEntrevistas: path.resolve(
    path.dirname(process.env.DATABASE_PATH || './data/app.db'),
    'entrevistas',
  ),

  // Pasta dos curriculos do Banco de Talentos (/bancodecurriculos), SEPARADA de
  // caminhoCurriculos: as finalidades LGPD sao distintas (banco de talentos vs.
  // candidatura a vaga) e os PDFs nao devem se misturar. Sobrescrevivel por env;
  // default segue o padrao das demais pastas (mesmo volume persistente do banco).
  caminhoCurriculosTalentos: path.resolve(
    process.env.CAMINHO_CURRICULOS_TALENTOS ||
      path.join(
        path.dirname(process.env.DATABASE_PATH || './data/app.db'),
        'curriculos_talentos',
      ),
  ),

  sessao: {
    segredo: process.env.SESSION_SECRET || 'troque-isto',
  },

  agente: {
    nome: process.env.AGENT_NAME || 'Vera',
  },

  // Rastreio (GTM / Meta Pixel) — injetados no layout do candidato (views.js)
  // SOMENTE quando definidos. Vazio = nada e injetado. Nunca vao para o painel admin.
  rastreio: {
    gtmId: process.env.GTM_ID || '',
    metaPixelId: process.env.META_PIXEL_ID || '',
  },

  recrutador: {
    email: process.env.RECRUITER_EMAIL || '',
    // WhatsApp do recrutador (modo Simples): usado SOMENTE aqui, a partir do env —
    // nunca de query string, tela ou conteudo do candidato. Vazio = botao desabilitado.
    whatsapp: process.env.RECRUITER_WHATSAPP || '',
  },

  // Painel do recrutador: credenciais fixas (usuario + senha) da tela de login do
  // /admin, lidas do ambiente. Sem usuario OU sem senha = painel BLOQUEADO (o
  // middleware nega o login). O cookie de admin e assinado com o SESSION_SECRET
  // (mesmo mecanismo do cookie do candidato).
  admin: {
    user: process.env.ADMIN_USER || '',
    password: process.env.ADMIN_PASSWORD || '',
  },

  entrevista: {
    // Mock = sem chamadas externas (custo zero). Enquanto os providers reais
    // (STT/LLM/TTS) nao estao ligados, o mock e o unico caminho funcional.
    // Em producao real, defina INTERVIEW_MOCK=false (exige chaves de API).
    mock: bool(process.env.INTERVIEW_MOCK, true),
    maxDuracaoMin: num(process.env.MAX_DURACAO_MIN, 40),
    // Modo real (INTERVIEW_MOCK=false):
    maxPerguntas: num(process.env.MAX_PERGUNTAS, 24), // teto de perguntas da Vera
    historicoRecentes: num(process.env.HISTORICO_TURNS_RECENTES, 6), // turns completos enviados ao LLM
    timeoutMs: num(process.env.PROVIDER_TIMEOUT_MS, 30000), // timeout por chamada externa
    relatorioTimeoutMs: num(process.env.RELATORIO_TIMEOUT_MS, 120000), // timeout dedicado p/ a geração do relatório (maior que o teto global)
  },

  // Selecao de provedores (trocaveis por env). Cada adaptador le o seu bloco.
  // Os adaptadores reais so sao chamados quando INTERVIEW_MOCK=false.
  provedores: {
    llm: {
      nome: process.env.LLM_PROVIDER || 'openrouter',
      // Dois modelos por tipo de tarefa (lidos do .env; fallback nos slugs padrao):
      //   - complexo: geracao de perguntas da entrevista e relatorio (default das chamadas)
      //   - simples:  tarefas leves (classificacao, validacao curta) — uso futuro
      modeloComplexo: process.env.LLM_MODEL_COMPLEXO || 'deepseek/deepseek-v4-flash',
      modeloSimples: process.env.LLM_MODEL_SIMPLES || 'deepseek/deepseek-chat-v3.1',
      openrouter: {
        apiKey: process.env.OPENROUTER_API_KEY || '',
        baseUrl: process.env.OPENROUTER_BASE_URL || 'https://openrouter.ai/api/v1',
      },
      anthropic: { apiKey: process.env.ANTHROPIC_API_KEY || '' },
    },
    stt: {
      nome: process.env.STT_PROVIDER || 'groq',
      groq: {
        apiKey: process.env.GROQ_API_KEY || '',
        modelo: process.env.GROQ_STT_MODEL || 'whisper-large-v3',
      },
      openai: { apiKey: process.env.OPENAI_API_KEY || '' },
    },
    tts: {
      nome: process.env.TTS_PROVIDER || 'google',
      google: {
        voz: process.env.GOOGLE_TTS_VOICE || 'pt-BR-Wavenet-A',
        idioma: process.env.GOOGLE_TTS_LANGUAGE || 'pt-BR',
        // Credencial em duas formas (o adaptador tenta nesta ordem):
        credentialsJson: process.env.GOOGLE_TTS_CREDENTIALS_JSON || '', // JSON inteiro numa env
        credentialsPath: process.env.GOOGLE_APPLICATION_CREDENTIALS || '', // caminho do .json
      },
      openai: { apiKey: process.env.OPENAI_API_KEY || '' },
    },
    // Google Drive (Fase 5): destino das gravacoes de video das entrevistas.
    // REAPROVEITA a credencial do TTS (mesma Service Account); o adaptador tenta o
    // JSON inline primeiro e cai para o caminho do arquivo (ADC), igual ao TTS.
    drive: {
      credentialsJson: process.env.GOOGLE_TTS_CREDENTIALS_JSON || '',
      credentialsPath: process.env.GOOGLE_APPLICATION_CREDENTIALS || '',
      // Pasta-destino. Se GOOGLE_DRIVE_FOLDER_ID estiver definido, o adaptador usa esse
      // id direto (caminho robusto: pasta pre-criada/compartilhada com a SA ou Shared
      // Drive). Caso contrario, procura/cria uma pasta com este nome na 1a execucao.
      pastaId: process.env.GOOGLE_DRIVE_FOLDER_ID || '',
      pastaNome: process.env.GOOGLE_DRIVE_FOLDER_NAME || 'Entrevistas VM',
    },
    email: {
      nome: 'resend',
      // Remetente de TODOS os e-mails (relatorio + retomada). Dominio verificado no Resend.
      remetente: process.env.RESEND_FROM_EMAIL || 'jean@vendedormestre.com.br',
      resend: { apiKey: process.env.RESEND_API_KEY || '' },
    },
  },
};

// Validacao leve: avisa (sem derrubar) sobre configuracoes fracas em producao.
// Nesta fase nao exigimos chaves de API (os provedores ainda sao stubs).
function validar() {
  const avisos = [];
  if (config.ehProducao && config.sessao.segredo === 'troque-isto') {
    avisos.push('SESSION_SECRET esta no valor padrao em producao. Defina um segredo forte.');
  }
  if (!config.recrutador.email) {
    avisos.push('RECRUITER_EMAIL nao definido (necessario na Fase 4 para envio do relatorio).');
  }
  for (const aviso of avisos) {
    console.warn(`[config] aviso: ${aviso}`);
  }
  return avisos;
}

module.exports = { config, validar };
