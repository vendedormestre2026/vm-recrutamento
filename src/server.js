'use strict';

// Bootstrap do servidor Express.
// - Roda as migracoes (idempotentes) no boot.
// - Serve estaticos de public/.
// - Monta rotas de pagina e de API.
// - Expoe GET /health para o healthcheck do EasyPanel.

const path = require('node:path');
const express = require('express');
const cookieParser = require('cookie-parser');

const { config, validar } = require('./config');
const { migrar } = require('./db/migrate');
const db = require('./db');
const paginas = require('./routes/pages');
const api = require('./routes/api');
const admin = require('./routes/admin');
const { router: bancoCurriculos } = require('./routes/banco_curriculos');
const apiBancoCurriculos = require('./routes/api_banco_curriculos');
const apiWhatsapp = require('./routes/api_whatsapp');
const followupEntrevista = require('./lib/followupEntrevista');
const emailRecusa = require('./lib/emailRecusa');
const lembreteInicio = require('./lib/lembreteInicio');
const limpezaAudio = require('./lib/limpezaAudio');
const dispararPromocao = require('./lib/dispararPromocao');
const sequenciaWhatsapp = require('./whatsapp/sequenciaOutbox');
const conexaoWhatsapp = require('./whatsapp/connection');
const campanhaWhatsapp = require('./lib/campanhaWhatsapp');
const { router: webhookMeta } = require('./routes/webhook_meta');

// Follow-up de entrevistas nao concluidas: de quanto em quanto tempo a varredura roda.
// Nao e o atraso do e-mail (esse e configuravel no painel, em horas) — e so a resolucao
// da checagem. 15 min e granularidade suficiente para um limiar medido em horas.
const INTERVALO_FOLLOWUP_MS = 15 * 60 * 1000;

// E-mail de recusa: mesma resolucao de 15 min, pela mesma razao — a carencia real e
// medida em horas (lib/emailRecusa.HORAS_CARENCIA). Constante SEPARADA da do follow-up,
// mesmo com o valor igual hoje: os dois subsistemas sao independentes e mudar a cadencia
// de um nao pode mexer no outro por acidente.
const INTERVALO_RECUSA_MS = 15 * 60 * 1000;

// Lembrete de inicio de entrevista: mesma resolucao de 15 min. Terceira constante
// separada pela mesma razao das outras duas — as tres varreduras sao subsistemas
// independentes, e mudar a cadencia de uma nao pode mexer nas outras por acidente.
const INTERVALO_LEMBRETE_MS = 15 * 60 * 1000;

// Limpeza automatica de audio das entrevistas: quarta constante separada, pela mesma
// razao das outras tres. Aqui o intervalo e so a RESOLUCAO da checagem — o gatilho real
// e o uso do disco passar do limiar (lib/limpezaAudio), entao a passada normal nao faz
// nada alem de medir e sair.
const INTERVALO_LIMPEZA_AUDIO_MS = 15 * 60 * 1000;

// Disparo da Promocao de Vagas: QUINTA constante separada, pela mesma razao das outras
// quatro. O valor de 15 min aqui nao e so resolucao de checagem — junto com o teto de
// lib/dispararPromocao.ENVIOS_POR_CICLO (125), ele DEFINE a vazao: 125 a cada 15 min =
// 500/h, o limite contratado no provedor de campanha. Mexer em qualquer um dos dois muda
// a vazao real contra o Emailit; os dois numeros so fazem sentido juntos.
const INTERVALO_PROMOCAO_MS = 15 * 60 * 1000;

// Sequencia de WhatsApp: 5 min, e nao 15 como as demais. WA1 e "imediato" por regra de
// negocio — um candidato esperar 15 min pela primeira mensagem porque o ciclo acabou de
// passar seria transformar o T+0 em T+15 na pratica.
const INTERVALO_WHATSAPP_SEQ_MS = 5 * 60 * 1000;

// Campanha por WhatsApp (Meta): 10 min. Mais espacado que a sequencia (5 min) porque aqui
// nao ha nada "imediato" — campanha e envio em massa, e o custo de espalhar no tempo e zero
// contra o risco de rajada, que a Meta mede como qualidade.
const INTERVALO_CAMPANHA_WA_MS = 10 * 60 * 1000;

function criarApp() {
  const app = express();

  app.disable('x-powered-by');

  // ── WEBHOOK DA META, ANTES DO express.json() GLOBAL ──
  //
  // A ordem aqui NAO e estetica. A assinatura X-Hub-Signature-256 e HMAC sobre os BYTES do
  // corpo, e o router traz um parser proprio que guarda esse buffer no `verify`. Se o
  // express.json() global rodasse primeiro, ele consumiria o stream e o `verify` do parser da
  // rota NUNCA seria chamado — `req.corpoCru` ficaria undefined e TODA requisicao legitima da
  // Meta seria recusada com 401.
  //
  // Descoberto por teste: com o mount depois do parser global, "POST com assinatura valida"
  // devolvia 401. Montado aqui, o /webhook e a unica rota que ve o corpo cru, e todo o resto
  // do app continua com o express.json() de sempre — que segue logo abaixo, intocado.
  app.use('/webhook', webhookMeta);

  app.use(express.json({ limit: '1mb' }));
  app.use(express.urlencoded({ extended: true }));
  // Cookies assinados (token de sessao do candidato). Segredo vem do .env.
  app.use(cookieParser(config.sessao.segredo));

  // Estaticos (CSS, JS, assets, partials).
  app.use(
    express.static(path.join(__dirname, '..', 'public'), {
      extensions: ['html'],
      maxAge: config.ehProducao ? '1h' : 0,
    }),
  );

  // Healthcheck: confirma processo no ar e banco acessivel.
  app.get('/health', (req, res) => {
    let banco = false;
    try {
      db.getDb().prepare('SELECT 1').get();
      banco = true;
    } catch {
      banco = false;
    }
    res.json({ ok: true, banco, agente: config.agente.nome });
  });

  // Rotas
  app.use('/api', api);
  app.use('/api', apiBancoCurriculos); // Banco de Curriculos (API; fluxo independente do funil)
  // Disparo por WhatsApp. Consumidor e o n8n, nao o navegador: auth por chave de servico
  // (x-disparo-api-key), 401 JSON em vez de redirect. Ver routes/api_whatsapp.
  app.use('/api', apiWhatsapp);
  app.use('/admin', admin); // painel do recrutador (protegido por adminAuth interno)
  app.use('/bancodecurriculos', bancoCurriculos); // Banco de Curriculos (paginas publicas)
  app.use('/', paginas);

  // 404 simples
  app.use((req, res) => {
    res.status(404).json({ ok: false, erro: 'nao_encontrado', caminho: req.path });
  });

  // Tratador de erros
  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    console.error('[erro]', err.message);
    res.status(500).json({ ok: false, erro: 'erro_interno' });
  });

  return app;
}

function iniciar() {
  validar();

  // Migracoes no boot (idempotente).
  migrar();
  console.log(`[db] banco pronto em ${config.caminhoBanco}`);

  const app = criarApp();
  const servidor = app.listen(config.porta, () => {
    console.log(`[server] no ar em http://localhost:${config.porta} (${config.ambiente})`);
    console.log(`[server] healthcheck: GET /health`);
  });

  // Timeouts ampliados para uploads longos atras de proxy reverso (Traefik/EasyPanel).
  // keepAliveTimeout default do Node (5s) pode fechar a conexao durante upload de video.
  servidor.keepAliveTimeout = 120000; // 120s
  servidor.headersTimeout = 125000; // deve ser > keepAliveTimeout
  servidor.requestTimeout = 0; // sem limite de duracao total da requisicao (upload pode ser longo)

  agendarFollowupEntrevista();
  agendarEmailRecusa();
  agendarLembreteInicio();
  agendarLimpezaAudio();
  agendarDisparoPromocao();
  agendarSequenciaWhatsapp();
  agendarCampanhaWhatsapp();
  conectarWhatsappNoBoot();
}

// Gatilho da conexao do Baileys no boot.
//
// ── POR QUE UMA VARIAVEL PROPRIA, E NAO WHATSAPP_BAILEYS_ATIVO ──
// As duas parecem a mesma coisa e nao sao:
//   WHATSAPP_BAILEYS_ATIVO             o subsistema esta habilitado (guarda DENTRO de conectar)
//   WHATSAPP_BAILEYS_CONECTAR_NO_BOOT  ESTE boot deve mesmo abrir o socket agora
//
// Sem a separacao, o proprio deploy que liga o boot a conectar() ja dispararia pareamento:
// WHATSAPP_BAILEYS_ATIVO ja esta em true em producao, definida para outros fins (a guarda de
// conectar e o ciclo da sequencia). Quem escaneia o QR e uma pessoa, com o celular do numero
// em maos — ela precisa escolher a hora, e nao descobrir pelo log que o momento passou.
//
// A guarda de WHATSAPP_BAILEYS_ATIVO continua DENTRO de conectar() (connection.js:196) e nao
// foi tocada: sao duas camadas, nao uma substituindo a outra.
function conectarNoBoot() {
  return String(process.env.WHATSAPP_BAILEYS_CONECTAR_NO_BOOT || '').toLowerCase() === 'true';
}

// `deps.conectar` injetavel pelo teste, no mesmo molde de connection.conectar({criarSocket}):
// a ligacao boot -> conectar e o que se quer provar, e prova-la nao pode custar um socket real.
//
// Devolve boolean (tentou/nao tentou) em vez de void: da ao teste uma assercao direta, alem
// do espiao.
function conectarWhatsappNoBoot(deps = {}) {
  if (!conectarNoBoot()) {
    // Linha explicita, e nao silencio. A ausencia de log foi o que fez a investigacao do QR
    // ausente custar uma etapa inteira de diagnostico: nada no log dizia por que o socket
    // nunca abria, porque nao havia codigo nenhum para dize-lo.
    console.log('[wa-conn] desativado (WHATSAPP_BAILEYS_CONECTAR_NO_BOOT); conexao nao iniciada no boot.');
    return false;
  }

  const conectar = deps.conectar || conexaoWhatsapp.conectar;
  console.log('[wa-conn] WHATSAPP_BAILEYS_CONECTAR_NO_BOOT=true; iniciando conexao no boot.');

  // Fire-and-forget, igual as sete varreduras: o boot NAO espera o socket. A resolucao de
  // versao do Baileys faz uma chamada de rede, e um `await` aqui atrasaria o /health por
  // algo que nao e requisito para o app servir HTTP.
  //
  // A chamada e SINCRONA (e nao Promise.resolve().then(...)): adiar para um microtask nao
  // ganharia nada — o boot ja nao espera o resultado — e tornaria "o boot chamou conectar"
  // impossivel de afirmar sem timing no teste.
  //
  // try/catch E .catch, os dois: conectar() e async, mas um erro lancado ANTES do primeiro
  // await (ex.: require do baileys falhando) chega sincrono. Sem o try, esse caso derrubaria
  // iniciar() inteiro. Sem o .catch, a rejeicao viraria unhandledRejection, que no Node 22
  // mata o processo. Falhar em conectar nao pode derrubar o site.
  try {
    Promise.resolve(conectar()).catch((err) => {
      console.error(`[wa-conn] falha ao iniciar a conexao no boot: ${err.message}`);
    });
  } catch (err) {
    console.error(`[wa-conn] falha ao iniciar a conexao no boot: ${err.message}`);
  }

  return true;
}

// Agendador do follow-up de entrevistas nao concluidas.
//
// Timer em memoria dentro do proprio processo Express (o app roda como processo unico e
// de longa duracao no container; nao ha cron nem worker separado no projeto). Por isso a
// varredura e uma CONSULTA AO BANCO a cada ciclo, nunca um setTimeout agendado por
// candidato: um deploy/restart derruba qualquer timer em memoria, mas nao perde nada
// aqui — o proximo ciclo reencontra os pendentes pelas colunas de controle.
//
// A trava contra sobreposicao mora em lib/followupEntrevista (varrerSeOcioso), para ser
// a MESMA para a varredura do boot e para as do intervalo.
function agendarFollowupEntrevista() {
  // Primeira passada logo no boot: depois de um deploy, quem ja estava vencido nao
  // espera mais 15 min. `void` porque e fire-and-forget — varrerSeOcioso nunca rejeita.
  void followupEntrevista.varrerSeOcioso();

  setInterval(() => {
    void followupEntrevista.varrerSeOcioso();
  }, INTERVALO_FOLLOWUP_MS);

  console.log(
    `[followup] varredura agendada a cada ${INTERVALO_FOLLOWUP_MS / 60000} min (1a passada no boot).`,
  );
}

// Agendador do e-mail automatico de recusa. Mesmo desenho do follow-up (timer em memoria,
// consulta ao banco a cada ciclo, trava em lib/emailRecusa.varrerSeOcioso), mas com
// setInterval PROPRIO: os dois subsistemas sao independentes — um ciclo lento da recusa
// nao pode atrasar o follow-up, e desligar um no painel nao afeta o outro.
//
// Enquanto o interruptor do painel estiver desligado (default), cada ciclo so loga
// "[recusa] desativado" e nao toca no banco de candidatos.
function agendarEmailRecusa() {
  // Primeira passada no boot, igual ao follow-up: depois de um deploy, quem ja venceu a
  // carencia nao espera mais 15 min. `void` porque e fire-and-forget — varrerSeOcioso
  // nunca rejeita.
  void emailRecusa.varrerSeOcioso();

  setInterval(() => {
    void emailRecusa.varrerSeOcioso();
  }, INTERVALO_RECUSA_MS);

  console.log(
    `[recusa] varredura agendada a cada ${INTERVALO_RECUSA_MS / 60000} min (1a passada no boot).`,
  );
}

// Agendador do lembrete de inicio de entrevista. Mesmo desenho dos outros dois (timer em
// memoria, consulta ao banco a cada ciclo, trava em lib/lembreteInicio.varrerSeOcioso),
// com setInterval PROPRIO: as tres varreduras sao independentes — um ciclo lento de uma
// nao pode atrasar as outras, e desligar uma no painel nao afeta as demais.
//
// Enquanto o interruptor do painel estiver desligado (default), cada ciclo so loga
// "[lembrete] desativado" e nao toca no banco de candidatos.
function agendarLembreteInicio() {
  // Primeira passada no boot, igual as outras: depois de um deploy, quem ja venceu a
  // espera nao aguarda mais 15 min. `void` porque e fire-and-forget — varrerSeOcioso
  // nunca rejeita.
  void lembreteInicio.varrerSeOcioso();

  setInterval(() => {
    void lembreteInicio.varrerSeOcioso();
  }, INTERVALO_LEMBRETE_MS);

  console.log(
    `[lembrete] varredura agendada a cada ${INTERVALO_LEMBRETE_MS / 60000} min (1a passada no boot).`,
  );
}

// Agendador da limpeza automatica de audio. Mesmo desenho das outras tres (timer em
// memoria, trava em lib/limpezaAudio.varrerSeOcioso, setInterval PROPRIO), com UMA
// diferenca: as outras agem a cada ciclo, esta so age quando o uso do volume passa do
// limiar. O ciclo normal mede o disco e sai — e por isso que ela pode rodar de 15 em 15
// min sem custo. Sincrona (mexe em disco local, nao chama provedor externo), mas mantida
// com `void` para o agendador ficar igual aos outros tres.
//
// Enquanto o interruptor do painel estiver desligado (default), cada ciclo so loga
// "[limpeza-audio] desativado" e nao toca no disco nem no banco.
function agendarLimpezaAudio() {
  // Primeira passada no boot, igual as outras: depois de um deploy, um volume que ja
  // esta acima do limiar nao espera mais 15 min.
  void limpezaAudio.varrerSeOcioso();

  setInterval(() => {
    void limpezaAudio.varrerSeOcioso();
  }, INTERVALO_LIMPEZA_AUDIO_MS);

  console.log(
    `[limpeza-audio] varredura agendada a cada ${INTERVALO_LIMPEZA_AUDIO_MS / 60000} min ` +
      `(1a passada no boot; limiar ${limpezaAudio.limiarPct()}% de uso do volume).`,
  );
}

// Agendador do disparo da Promocao de Vagas. Mesmo desenho das outras quatro (timer em
// memoria, consulta ao banco a cada ciclo, trava em lib/dispararPromocao.varrerSeOcioso,
// setInterval PROPRIO), com uma diferenca de GRAU que vale registrar: as outras quatro
// escrevem para quem esta no meio de um processo com a gente; esta escreve em massa para
// a base inteira. Por isso o interruptor `promocao_ativa` nasce desligado e a vazao esta
// amarrada a dois numeros (este intervalo + ENVIOS_POR_CICLO).
//
// Enquanto o interruptor do painel estiver desligado (default), cada ciclo so loga
// "[promocao] desativado" e nao toca no banco — nem na fila de envios, nem nas campanhas.
// Uma campanha pode ficar enfileirada por tempo indeterminado sem que nada saia.
function agendarDisparoPromocao() {
  // Primeira passada no boot, igual as outras: depois de um deploy, uma campanha ja
  // enfileirada nao espera mais 15 min. `void` porque e fire-and-forget — varrerSeOcioso
  // nunca rejeita.
  void dispararPromocao.varrerSeOcioso();

  setInterval(() => {
    void dispararPromocao.varrerSeOcioso();
  }, INTERVALO_PROMOCAO_MS);

  console.log(
    `[promocao] varredura agendada a cada ${INTERVALO_PROMOCAO_MS / 60000} min ` +
      `(1a passada no boot; ate ${dispararPromocao.ENVIOS_POR_CICLO} envios por ciclo).`,
  );
}

// Sequencia WA1/WA2. DOIS interruptores, e os dois sao checados a cada ciclo:
// whatsapp_sequencia_ativa (painel) e WHATSAPP_BAILEYS_ATIVO (env). Com qualquer um
// desligado — que e o default — o ciclo so loga e nao toca no banco.
function agendarSequenciaWhatsapp() {
  // Primeira passada no boot, igual as outras cinco: depois de um deploy, um WA1 vencido
  // nao espera mais 5 min.
  void sequenciaWhatsapp.varrerSeOcioso();

  setInterval(() => {
    void sequenciaWhatsapp.varrerSeOcioso();
  }, INTERVALO_WHATSAPP_SEQ_MS);

  console.log(
    `[wa-seq] varredura agendada a cada ${INTERVALO_WHATSAPP_SEQ_MS / 60000} min ` +
      `(1a passada no boot; ate ${sequenciaWhatsapp.POR_CICLO} envios por ciclo).`,
  );
}

// Campanha por WhatsApp (Meta Cloud API). Kill-switch campanha_whatsapp_ativa (painel),
// OFF por padrao, e META_CAMPANHA_MOCK=true por padrao no adaptador — com os dois no default
// o ciclo roda, loga e nao envia nada.
function agendarCampanhaWhatsapp() {
  void campanhaWhatsapp.varrerSeOcioso();

  setInterval(() => {
    void campanhaWhatsapp.varrerSeOcioso();
  }, INTERVALO_CAMPANHA_WA_MS);

  console.log(
    `[campanha-wa] varredura agendada a cada ${INTERVALO_CAMPANHA_WA_MS / 60000} min ` +
      `(1a passada no boot; ate ${campanhaWhatsapp.ENVIOS_POR_CICLO} envios por ciclo).`,
  );
}

if (require.main === module) {
  iniciar();
}

module.exports = { criarApp, iniciar, conectarWhatsappNoBoot };
