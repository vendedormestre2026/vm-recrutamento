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
const followupEntrevista = require('./lib/followupEntrevista');
const emailRecusa = require('./lib/emailRecusa');
const lembreteInicio = require('./lib/lembreteInicio');
const limpezaAudio = require('./lib/limpezaAudio');

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

function criarApp() {
  const app = express();

  app.disable('x-powered-by');
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

if (require.main === module) {
  iniciar();
}

module.exports = { criarApp, iniciar };
