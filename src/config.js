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

  // Promocao de Vagas — segredo do HMAC que assina os links de descadastro.
  //
  // SEM FALLBACK para SESSION_SECRET, de proposito. Um fallback silencioso faria os
  // links funcionarem hoje e quebrarem no dia em que DESCADASTRO_SECRET fosse definido:
  // todo token JA ENVIADO passaria a ser invalido. E-mail enviado e IMUTAVEL — nao da
  // para reemitir o link de quem ja recebeu. Entao a ausencia do segredo tem que doer
  // AGORA (gerarToken lanca), e nao depois, num opt-out que o titular nao consegue
  // exercer. Vazio tambem nao vira default 'troque-isto' pela mesma razao.
  //
  // `segredoAnterior` (opcional, default vazio) e a JANELA DE ROTACAO: verificarToken
  // aceita o token do segredo atual OU do anterior, entao trocar a chave nao quebra os
  // links ja enviados. Sem ele, o segredo seria irrotacionavel na pratica — um link de
  // opt-out quebrado e gatilho de denuncia de spam, que atinge a reputacao do MESMO
  // dominio usado pelos e-mails transacionais do funil.
  // Procedimento de rotacao (documentado tambem no .env.example): mover o valor atual
  // para DESCADASTRO_SECRET_ANTERIOR, por o novo em DESCADASTRO_SECRET. Links antigos
  // seguem validos indefinidamente. Ausencia do anterior e o caso normal, nao erro.
  descadastro: {
    segredo: process.env.DESCADASTRO_SECRET || '',
    segredoAnterior: process.env.DESCADASTRO_SECRET_ANTERIOR || '',
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
    // ── ZeptoMail (Zoho): credencial COMPARTILHADA pelos dois fluxos ──
    //
    // Bloco proprio, e nao um campo dentro de `email` ou de `emailCampanha`, porque o token
    // e a URL sao a UNICA coisa que os dois fluxos compartilham. Tudo o mais — remetente,
    // nome de exibicao, tratamento de opcoes — continua morando no bloco de cada fluxo, e e
    // isso que preserva a separacao de reputacao explicada logo abaixo mesmo agora que ha
    // um provedor so.
    //
    // O token e o "Send Mail Token" emitido no painel do ZeptoMail. Ele vai no header
    // Authorization com o esquema PROPRIO `Zoho-enczapikey` — nao e Bearer, e mandar Bearer
    // devolve 401.
    zeptomail: {
      token: process.env.ZEPTOMAIL_TOKEN || '',
      // Sobrescrevivel para apontar a um sandbox sem mexer em codigo, igual ao
      // EMAILIT_API_URL que ele substitui.
      apiUrl: process.env.ZEPTOMAIL_API_URL || 'https://api.zeptomail.com/v1.1/email',
    },

    email: {
      nome: 'resend',
      // Remetente de TODOS os e-mails transacionais (relatorio, lembrete, recusa,
      // follow-up, retomada, notificacao, banco de curriculos).
      //
      // A VARIAVEL CONTINUA SENDO RESEND_FROM_EMAIL mesmo depois da migracao para o
      // ZeptoMail, e isso e decisao, nao descuido: o dominio vendedormestre.com.br esta
      // verificado no ZeptoMail sem restricao de sender address, entao o endereco nao muda
      // — e renomear a variavel exigiria mexer no Railway durante a troca de provedor,
      // somando um passo manual a uma migracao que ja tem outros. O nome fica como divida
      // registrada, para a limpeza futura que tambem remove o resend.js.
      remetente: process.env.RESEND_FROM_EMAIL || 'jean@vendedormestre.com.br',
      // Nome de exibicao do remetente. O Resend nao pedia (o `from` era string pura); o
      // ZeptoMail aceita `{ address, name }`, e um nome legivel na caixa de entrada e a
      // diferenca entre "jean@vendedormestre.com.br" e "Vendedor Mestre" no cliente.
      remetenteNome: process.env.ZEPTOMAIL_FROM_NAME || 'Vendedor Mestre',
      resend: { apiKey: process.env.RESEND_API_KEY || '' },
    },

    // ── E-mail de CAMPANHA (Promocao de Vagas) — SMTP generico ──
    //
    // Bloco SEPARADO do `email` acima, de proposito, e nao um provedor a mais dentro
    // dele. Sao dois sistemas com necessidades opostas:
    //   - `email` (Resend): transacional, 1 mensagem por evento, 6 call sites, dominio
    //     principal. Reputacao dele nao pode depender de campanha.
    //   - `emailCampanha` (SMTP): divulgacao em massa, subdominio proprio, precisa de
    //     List-Unsubscribe e de troca de provedor sem tocar em codigo.
    // Uma denuncia de spam numa campanha nao pode derrubar a entrega do e-mail de
    // entrevista de ninguem — por isso remetente, provedor e reputacao sao separados.
    //
    // ── CORRECAO DE ROTA (2026-08-10): SMTP DEIXOU DE SER O DEFAULT ──
    //
    // A decisao original registrada aqui era "SMTP generico e nao a API REST do Emailit",
    // para que trocar de provedor (Emailit -> Amazon SES) fosse mudanca de configuracao e
    // nao de codigo. O raciocinio continua valido; o que mudou foi um fato do AMBIENTE:
    // o Railway BLOQUEIA egress SMTP neste servico. Provado por probe TCP de dentro do
    // container — 587, 465 e 2525 dao timeout contra Emailit, Gmail E SendGrid, enquanto
    // api.emailit.com:443 abre em ~190 ms. Nao e o provedor, e a plataforma.
    //
    // Portanto o transporte default passou a ser a API REST (HTTPS). O SMTP continua
    // implementado e selecionavel por EMAIL_CAMPANHA_TRANSPORTE=smtp, para o dia em que o
    // Railway liberar a porta ou o SES entrar — a portabilidade que motivou a escolha
    // original virou a fachada em providers/emailCampanha/index.js.
    emailCampanha: {
      // 'api' (default, HTTPS) | 'smtp' (legado, bloqueado no Railway hoje).
      transporte: String(process.env.EMAIL_CAMPANHA_TRANSPORTE || 'api').trim().toLowerCase(),

      // Credencial da API REST. E DIFERENTE do usuario/senha de SMTP: no Emailit a chave
      // de API e emitida no painel (formato em_...) e vai no header Authorization como
      // Bearer. Mandar a senha de SMTP ali devolve 401.
      apiKey: process.env.EMAILIT_API_KEY || '',
      // Endpoint sobrescrevivel para apontar a um sandbox sem mexer em codigo.
      apiUrl: process.env.EMAILIT_API_URL || 'https://api.emailit.com/v2/emails',

      host: process.env.SMTP_CAMPANHA_HOST || '',
      porta: num(process.env.SMTP_CAMPANHA_PORTA, 587),
      // `seguro` mapeia direto para a opcao `secure` do nodemailer, e o default FALSE
      // e o correto para a porta 587 — nao e descuido:
      //   - porta 587 -> secure:false. A conexao abre em texto claro e sobe para TLS via
      //     STARTTLS (o nodemailer faz isso sozinho quando o servidor anuncia suporte).
      //   - porta 465 -> secure:true. TLS implicito, cifrado desde o primeiro byte.
      // Marcar secure:true na 587 faz o handshake TLS falhar contra um servidor que
      // espera texto claro no inicio. Emailit usa 587, entao o default serve; quem for
      // para a 465 precisa setar SMTP_CAMPANHA_SEGURO=true junto com a porta.
      seguro: bool(process.env.SMTP_CAMPANHA_SEGURO, false),
      usuario: process.env.SMTP_CAMPANHA_USUARIO || '',
      senha: process.env.SMTP_CAMPANHA_SENHA || '',
      // Remetente das campanhas: subdominio DEDICADO, separado do dominio transacional.
      // O valor abaixo e um PLACEHOLDER — a verificacao do dominio no provedor (registros
      // SPF/DKIM/DMARC) e passo MANUAL, fora do codigo e fora deste incremento.
      remetente: process.env.SMTP_CAMPANHA_FROM_EMAIL || 'vagas@vagas.vendedormestre.com.br',
      // Nome de exibicao do remetente de CAMPANHA. Separado do transacional de proposito:
      // sao os dois campos que aparecem na caixa de entrada, e uma campanha que se
      // apresentasse com o mesmo nome do e-mail de entrevista apagaria a distincao que o
      // resto deste bloco existe para manter.
      remetenteNome: process.env.ZEPTOMAIL_CAMPANHA_FROM_NAME || 'Vendedor Mestre — Vagas',
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

  // ── ZeptoMail selecionado sem token: avisa ALTO no boot ──
  //
  // O sintoma de faltar o token so apareceria no primeiro envio — e, no caminho de
  // campanha, "primeiro envio" significa a varredura marcando destinatarios como 'falha'
  // TERMINAL, sem retentativa e sem poder rematerializar (UNIQUE(campanha_id, email)). No
  // transacional e mais brando, mas ainda e um relatorio que nao chega ao recrutador.
  //
  // Este projeto ja pagou o preco de uma variavel ausente descoberta tarde, entao o aviso
  // nomeia a variavel e o transporte que a exige. NAO derruba o processo: `validar()` e
  // avisos, nao gates, e derrubar o boot por causa do e-mail deixaria o funil inteiro fora
  // do ar por um subsistema que tem kill-switch proprio. Quem BARRA de fato e o pre-voo do
  // disparo (credenciaisFaltando), que roda antes de materializar qualquer campanha.
  // Os defaults aqui espelham os das duas fachadas ('resend' e 'api'): o aviso so faz
  // sentido para quem de fato vai enviar pelo ZeptoMail, e um default diferente do real
  // faria este bloco avisar sobre um transporte que ninguem selecionou — ou, pior, calar
  // sobre o que esta selecionado.
  const transacionalZepto = (process.env.EMAIL_TRANSPORTE || 'resend') === 'zeptomail';
  const campanhaZepto = (process.env.EMAIL_CAMPANHA_TRANSPORTE || 'api') === 'zeptomail';
  if ((transacionalZepto || campanhaZepto) && !config.provedores.zeptomail.token) {
    const quem = [
      transacionalZepto ? 'EMAIL_TRANSPORTE' : null,
      campanhaZepto ? 'EMAIL_CAMPANHA_TRANSPORTE' : null,
    ]
      .filter(Boolean)
      .join(' e ');
    avisos.push(
      `ZEPTOMAIL_TOKEN ausente, mas ${quem} aponta para 'zeptomail'. ` +
        'Nenhum e-mail sai por esse transporte ate a variavel ser definida — e no caso da ' +
        'campanha, cada tentativa marca o destinatario como falha DEFINITIVA. Defina o ' +
        'Send Mail Token do painel do ZeptoMail antes de enviar.',
    );
  }

  // ── URL de API sem protocolo: o erro mais caro de diagnosticar deste subsistema ──
  //
  // `fetch('api.zeptomail.com')` nao falha dizendo "faltou https://". Ele lanca
  // "Failed to parse URL from api.zeptomail.com" — uma mensagem que nao nomeia a variavel,
  // nao diz o que esta errado nela e nao aparece no boot: so no primeiro envio, dentro do
  // catch de quem chamou. Foi assim que o primeiro teste real do ZeptoMail falhou.
  //
  // Aqui o aviso nomeia a variavel, mostra o valor e diz o formato esperado. Vale para as
  // duas URLs sobrescreviveis do projeto, porque a armadilha e a mesma nas duas.
  for (const [nome, valor] of [
    ['ZEPTOMAIL_API_URL', process.env.ZEPTOMAIL_API_URL],
    ['EMAILIT_API_URL', process.env.EMAILIT_API_URL],
  ]) {
    if (valor && !/^https?:\/\//i.test(valor)) {
      avisos.push(
        `${nome} definida sem protocolo: ${JSON.stringify(valor)}. ` +
          'O fetch() nao aceita esse formato e todo envio por esse transporte vai falhar ' +
          'com "Failed to parse URL". Use a URL COMPLETA (ex.: ' +
          'https://api.zeptomail.com/v1.1/email) ou remova a variavel para usar o padrao.',
      );
    }
  }

  // ── Credencial colada com o rotulo junto ──
  //
  // O painel do ZeptoMail exibe o token ja no formato de header ("Zoho-enczapikey wSsV..."),
  // e quem copia leva os 16 caracteres do prefixo. O adaptador prefixa de novo, o header sai
  // duplicado, e o ZeptoMail responde 500 com CORPO VAZIO — mensagem que nao aponta para
  // nada. Foi assim que o segundo teste real falhou.
  //
  // O adaptador agora NORMALIZA e funciona nos dois casos, entao isto e higiene, nao
  // bloqueio: avisa para a variavel ser limpa, em vez de deixar a bagunca invisivel porque
  // "esta funcionando". Mesmo espirito do aviso de URL sem protocolo acima — os dois nascem
  // do mesmo gesto de colar o que estava na tela.
  if (/^Zoho-enczapikey\s/i.test(process.env.ZEPTOMAIL_TOKEN || '')) {
    avisos.push(
      'ZEPTOMAIL_TOKEN veio com o prefixo "Zoho-enczapikey " colado no valor. O envio ' +
        'funciona (o adaptador normaliza), mas a variavel deve conter APENAS o token — ' +
        'o prefixo e do cabecalho HTTP, nao da credencial.',
    );
  }

  for (const aviso of avisos) {
    console.warn(`[config] aviso: ${aviso}`);
  }
  return avisos;
}

module.exports = { config, validar };
