'use strict';

// Correcao RETROATIVA: remove a permissao publica dos videos de entrevista ja no Drive.
//
// ⚠️  ESTE SCRIPT ESCREVE NA API DO DRIVE (permissions.delete). Nao e simulacao.
//     Rode --dry-run primeiro; comece por --apenas=<fileId> antes do lote.
//
// CONTEXTO — ate o commit "fix(drive): remove compartilhamento publico de videos de
// entrevista", o upload adicionava { role: 'reader', type: 'anyone' } em CADA video: quem
// obtivesse o link (e-mail encaminhado, log, banco) assistia a entrevista de um candidato
// sem autenticar. Aquele commit estancou os videos NOVOS; este limpa os que ja subiram.
//
// A permissao removida e redundante para o acesso legitimo: a pasta-destino e um Shared
// Drive onde o recrutador ja e organizer e a Service Account e fileOrganizer ("Content
// Manager" na UI do Drive). Nenhum acesso de quem deve ver o video e perdido — some
// apenas o acesso anonimo por link. O video_url no banco continua valido e NAO e alterado.
//
// Uso:
//   node src/scripts/remover-permissao-publica.js --dry-run
//   node src/scripts/remover-permissao-publica.js --apenas=<fileId>
//   node src/scripts/remover-permissao-publica.js                 (lote completo)
//
// ONDE RODAR: no container (railway ssh), NAO na maquina local. A lista de videos sai do
// banco de PRODUCAO (/data/app.db); local o script leria o ./data/app.db de dev, acharia
// zero videos e daria um falso "concluido".

const { config } = require('../config');
const db = require('../db');

// O id da permissao publica e a string literal 'anyoneWithLink' em todo arquivo do Drive
// (nao um id numerico variavel), entao da para apagar direto, sem listar antes.
const PERMISSAO_PUBLICA = 'anyoneWithLink';

// Intervalo entre chamadas. A cota do Drive (~12 mil req/min por projeto) e folgada para
// algumas dezenas de arquivos; a pausa existe contra o limite por-usuario em rajada e
// deixa o lote inteiro em poucos segundos de qualquer forma.
const PAUSA_MS = 200;

const pausa = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// ── Argumentos ──
function lerArgs(argv) {
  const args = { dryRun: false, apenas: null };
  for (const bruto of argv.slice(2)) {
    if (bruto === '--dry-run') {
      args.dryRun = true;
      continue;
    }
    const m = bruto.match(/^--apenas=(.+)$/);
    if (m) {
      args.apenas = m[1].trim();
      continue;
    }
    console.error(`Argumento desconhecido: ${bruto}`);
    console.error('Uso: node src/scripts/remover-permissao-publica.js [--dry-run] [--apenas=<fileId>]');
    process.exit(1);
  }
  return args;
}

// Extrai o fileId de uma URL do Drive (https://drive.google.com/file/d/<ID>/view?...).
// Devolve null quando a URL nao casa — a linha e reportada e pulada, nunca adivinhada.
function fileIdDeUrl(url) {
  const m = String(url || '').match(/\/file\/d\/([\w-]+)/);
  return m ? m[1] : null;
}

// Cliente Drive com a MESMA credencial do adaptador de upload (Service Account do TTS).
// require lazy do googleapis, igual ao providers/drive/google.js.
function getDrive() {
  const fs = require('node:fs');
  const { google } = require('googleapis');
  const cfg = config.provedores.drive;

  let cred;
  if (cfg.credentialsJson) {
    cred = JSON.parse(cfg.credentialsJson);
  } else if (cfg.credentialsPath) {
    cred = JSON.parse(fs.readFileSync(cfg.credentialsPath, 'utf8'));
  } else {
    throw new Error(
      'Credencial do Google ausente. Defina GOOGLE_TTS_CREDENTIALS_JSON ou GOOGLE_APPLICATION_CREDENTIALS.',
    );
  }

  const auth = new google.auth.JWT({
    email: cred.client_email,
    key: cred.private_key,
    scopes: ['https://www.googleapis.com/auth/drive.file'],
  });
  return google.drive({ version: 'v3', auth });
}

// Reconhece o "nao existe" do Drive, que chega ora como err.code, ora aninhado na
// resposta HTTP, ora so no texto. Usado para tratar arquivo ja limpo como SUCESSO.
function ehNaoEncontrado(err) {
  const status = (err && err.code) || (err && err.response && err.response.status) || null;
  if (status === 404) return true;
  const texto = [
    err && err.message,
    err && err.response && err.response.data && JSON.stringify(err.response.data.error),
  ]
    .filter(Boolean)
    .join(' ');
  return /notFound|permissionNotFound|not ?found/i.test(texto);
}

// Monta a lista de alvos a partir do banco. Uma linha por video com URL parseavel.
function listarAlvos() {
  const linhas = db
    .getDb()
    .prepare(
      `SELECT i.id AS interview_id, i.video_url, a.id AS application_id,
              a.nome, a.sobrenome
         FROM interviews i
         LEFT JOIN applications a ON a.id = i.application_id
        WHERE i.video_url IS NOT NULL AND TRIM(i.video_url) <> ''
        ORDER BY i.id`,
    )
    .all();

  const alvos = [];
  const semId = [];
  for (const l of linhas) {
    const fileId = fileIdDeUrl(l.video_url);
    const registro = {
      interviewId: l.interview_id,
      applicationId: l.application_id,
      nome: [l.nome, l.sobrenome].filter(Boolean).join(' ').trim() || '(sem nome)',
      fileId,
    };
    if (fileId) alvos.push(registro);
    else semId.push({ ...registro, video_url: l.video_url });
  }
  return { alvos, semId };
}

async function main() {
  const args = lerArgs(process.argv);
  const drive = getDrive();

  const { alvos: todos, semId } = listarAlvos();
  const alvos = args.apenas ? todos.filter((a) => a.fileId === args.apenas) : todos;

  console.log('──────── remover-permissao-publica ────────');
  console.log(`banco    : ${config.caminhoBanco}`);
  console.log(`modo     : ${args.dryRun ? 'DRY-RUN (nenhuma escrita)' : 'EXECUCAO REAL'}`);
  console.log(`alvo     : ${args.apenas ? `apenas ${args.apenas}` : 'TODOS os videos'}`);
  console.log(`videos   : ${alvos.length}${args.apenas ? ` (de ${todos.length} no banco)` : ''}`);
  if (semId.length) {
    console.log(`\n⚠️  ${semId.length} video_url sem fileId reconhecivel (pulados):`);
    for (const s of semId) console.log(`   interview ${s.interviewId}: ${s.video_url}`);
  }
  if (args.apenas && alvos.length === 0) {
    console.error(`\nERRO: fileId ${args.apenas} nao encontrado em interviews.video_url.`);
    process.exit(1);
  }
  console.log('');

  let removidos = 0;
  let jaLimpos = 0;
  let falhas = 0;

  for (const alvo of alvos) {
    const rotulo = `interview ${String(alvo.interviewId).padStart(3)} | ${alvo.nome.slice(0, 28).padEnd(28)} | ${alvo.fileId}`;

    if (args.dryRun) {
      console.log(`[dry-run ] ${rotulo}`);
      continue;
    }

    try {
      await drive.permissions.delete({
        fileId: alvo.fileId,
        permissionId: PERMISSAO_PUBLICA,
        supportsAllDrives: true,
      });
      removidos++;
      console.log(`[removido] ${rotulo}`);
    } catch (err) {
      if (ehNaoEncontrado(err)) {
        // Ja estava sem a permissao publica. Idempotencia: rodar de novo nao e erro.
        jaLimpos++;
        console.log(`[ja limpo] ${rotulo}`);
      } else {
        falhas++;
        console.log(`[FALHOU  ] ${rotulo} -> ${err.message}`);
      }
    }

    await pausa(PAUSA_MS);
  }

  console.log('\n──────────────── RESUMO ────────────────');
  if (args.dryRun) {
    console.log(`  seriam processados : ${alvos.length}`);
    console.log('  (nenhuma escrita foi feita)');
  } else {
    console.log(`  removidos : ${removidos}`);
    console.log(`  ja limpos : ${jaLimpos}`);
    console.log(`  falhas    : ${falhas}`);
  }
  console.log('─────────────────────────────────────────');

  // Falha em qualquer arquivo devolve codigo != 0 para o shell perceber.
  if (falhas > 0) process.exit(1);
}

main().catch((err) => {
  console.error('Falha inesperada:', err);
  process.exit(1);
});
