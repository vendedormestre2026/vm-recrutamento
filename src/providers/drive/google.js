'use strict';

// Adaptador de armazenamento: Google Drive (gravacao de video da entrevista).
// REAPROVEITA a Service Account do TTS. Chamado apenas quando INTERVIEW_MOCK=false.
//
// Contrato: enviarVideo({ caminho, nomeArquivo, mimeType }) -> { id, link }
//
// Credencial (mesma ordem do TTS):
//   1) GOOGLE_TTS_CREDENTIALS_JSON   -> JSON inteiro da SA numa env (ideal p/ EasyPanel)
//   2) GOOGLE_APPLICATION_CREDENTIALS -> caminho do .json (ADC padrao do Google)
//
// O require do SDK (googleapis) e LAZY: so acontece quando este adaptador e usado,
// para o app subir em modo mock sem o pacote carregado.
//
// ⚠️  PASTA-DESTINO — gotcha operacional do Drive com Service Account:
//   Uma Service Account NAO tem um "My Drive" humano com cota utilizavel. Se este
//   adaptador CRIAR a pasta, ela nasce dentro da SA e o arquivo pode falhar por cota
//   ("storage quota exceeded") e/ou ficar invisivel para o Rafael. Caminho ROBUSTO:
//   pre-criar a pasta numa conta humana (ou Shared Drive), compartilha-la como Editor
//   com o e-mail da SA e definir GOOGLE_DRIVE_FOLDER_ID. Com o id setado, este modulo
//   nao cria nada — so envia para dentro dela (com suporte a Shared Drives).

const fs = require('node:fs');
const { config } = require('../../config');

let _drive = null;
let _pastaIdCache = null;

// Le a credencial da SA (JSON inline ou arquivo). Lanca erro claro se ausente.
function lerCredencial() {
  const cfg = config.provedores.drive;
  if (cfg.credentialsJson) {
    try {
      return JSON.parse(cfg.credentialsJson);
    } catch (err) {
      throw new Error('GOOGLE_TTS_CREDENTIALS_JSON invalido: nao e um JSON valido.');
    }
  }
  if (cfg.credentialsPath) {
    try {
      return JSON.parse(fs.readFileSync(cfg.credentialsPath, 'utf8'));
    } catch (err) {
      throw new Error(
        `Nao foi possivel ler a credencial do Google em ${cfg.credentialsPath}: ${err.message}`,
      );
    }
  }
  throw new Error(
    'Credencial do Google ausente para o Drive. Defina GOOGLE_TTS_CREDENTIALS_JSON (JSON inteiro) ' +
      'ou GOOGLE_APPLICATION_CREDENTIALS (caminho do .json).',
  );
}

// Cliente Drive autenticado (singleton). require lazy do googleapis.
function getDrive() {
  if (_drive) return _drive;
  const { google } = require('googleapis');
  const cred = lerCredencial();
  const auth = new google.auth.JWT({
    email: cred.client_email,
    key: cred.private_key,
    scopes: [
      // file: escrita/leitura dos arquivos criados/abertos pelo app (upload de video).
      'https://www.googleapis.com/auth/drive.file',
      // readonly: leitura de arquivos apenas COMPARTILHADOS com a SA (export de Google
      // Doc como texto). E ADITIVO — o token carrega a UNIAO dos escopos, entao NAO
      // remove a escrita do drive.file usada por enviarVideo (upload continua igual).
      'https://www.googleapis.com/auth/drive.readonly',
    ],
  });
  _drive = google.drive({ version: 'v3', auth });
  return _drive;
}

// Resolve o id da pasta-destino. Se GOOGLE_DRIVE_FOLDER_ID estiver setado, usa direto.
// Caso contrario, procura uma pasta com o nome configurado; se nao achar, cria.
async function resolverPastaId(drive) {
  const cfg = config.provedores.drive;
  if (cfg.pastaId) return cfg.pastaId;
  if (_pastaIdCache) return _pastaIdCache;

  const nome = cfg.pastaNome.replace(/'/g, "\\'");
  const busca = await drive.files.list({
    q: `mimeType = 'application/vnd.google-apps.folder' and name = '${nome}' and trashed = false`,
    fields: 'files(id, name)',
    spaces: 'drive',
    supportsAllDrives: true,
    includeItemsFromAllDrives: true,
  });

  const achada = busca.data.files && busca.data.files[0];
  if (achada) {
    _pastaIdCache = achada.id;
    return _pastaIdCache;
  }

  const criada = await drive.files.create({
    requestBody: {
      name: cfg.pastaNome,
      mimeType: 'application/vnd.google-apps.folder',
    },
    fields: 'id',
    supportsAllDrives: true,
  });
  _pastaIdCache = criada.data.id;
  return _pastaIdCache;
}

// Sobe o arquivo e devolve { id, link } com link compartilhavel (leitura por qualquer
// pessoa com o link). deps injetavel ({ drive }) para teste sem rede.
async function enviarVideo({ caminho, nomeArquivo, mimeType } = {}, deps = {}) {
  if (!caminho || !fs.existsSync(caminho)) {
    throw new Error(`Arquivo de video nao encontrado para upload: ${caminho}`);
  }
  const drive = deps.drive || getDrive();
  const pastaId = await resolverPastaId(drive);

  const criado = await drive.files.create({
    requestBody: {
      name: nomeArquivo || 'entrevista.webm',
      parents: [pastaId],
    },
    media: {
      mimeType: mimeType || 'video/webm',
      body: fs.createReadStream(caminho),
    },
    fields: 'id, webViewLink',
    supportsAllDrives: true,
  });

  const fileId = criado.data.id;

  // Link compartilhavel: leitura por qualquer pessoa com o link (o painel exibe o link
  // ao recrutador). Best-effort: se a permissao falhar, ainda devolvemos o link interno.
  try {
    await drive.permissions.create({
      fileId,
      requestBody: { role: 'reader', type: 'anyone' },
      supportsAllDrives: true,
    });
  } catch (err) {
    console.error(`[drive] falha ao tornar o video ${fileId} compartilhavel: ${err.message}`);
  }

  const link = criado.data.webViewLink || `https://drive.google.com/file/d/${fileId}/view`;
  return { id: fileId, link };
}

// Extrai o fileId de uma URL de Google Doc colada pelo admin. Exige o host do Google
// Docs (docs.google.com) para NAO aceitar um "/document/d/" de outro dominio; aceita a
// variante com "/u/<n>/" e o esquema http(s) opcional. Retorna o id (string) ou null
// se a URL for vazia/malformada/de outro site. Downstream usa SO o id extraido, nunca
// a URL inteira.
function extrairFileIdDeUrl(url) {
  const s = String(url || '').trim();
  const m = s.match(/^(?:https?:\/\/)?docs\.google\.com\/document\/(?:u\/\d+\/)?d\/([A-Za-z0-9_-]+)/i);
  return m ? m[1] : null;
}

// Junta as pistas de erro do googleapis (message + errors[] + response.error) num unico
// texto, para classificar a falha sem depender do formato exato do SDK.
function textoErroDrive(err) {
  const partes = [err && err.message];
  try {
    if (err && Array.isArray(err.errors)) partes.push(JSON.stringify(err.errors));
    const respErr = err && err.response && err.response.data && err.response.data.error;
    if (respErr) partes.push(JSON.stringify(respErr));
  } catch {
    /* ignore: classificacao e best-effort */
  }
  return partes.filter(Boolean).join(' ');
}

// Exporta um Google Doc NATIVO como texto puro (text/plain) e devolve a string. Usa o
// escopo drive.readonly (arquivo compartilhado com a SA). `responseType: 'text'` faz o
// gaxios entregar res.data ja como string (sem stream/arraybuffer). deps.drive
// injetavel para teste sem rede (mesmo padrao de enviarVideo).
//
// Erros identificaveis para a camada de cima diferenciar (via err.code):
//   DOC_NAO_EXPORTAVEL -> arquivo nao e Google Doc nativo (ex.: PDF nao exporta text/plain);
//   DOC_SEM_ACESSO     -> nao encontrado / sem acesso (SA nao compartilhada, ou id errado);
//   DOC_ERRO           -> demais falhas.
async function exportarTextoDoc(fileId, deps = {}) {
  if (!fileId) {
    const e = new Error('exportarTextoDoc: fileId ausente.');
    e.code = 'DOC_ERRO';
    throw e;
  }
  const drive = deps.drive || getDrive();
  try {
    const res = await drive.files.export(
      { fileId, mimeType: 'text/plain' },
      { responseType: 'text' },
    );
    return String(res && res.data != null ? res.data : '');
  } catch (err) {
    const status = (err && err.code) || (err && err.response && err.response.status) || null;
    const hay = textoErroDrive(err);

    // (b) arquivo nao e Google Doc nativo -> Drive responde 403 "fileNotExportable".
    if (status === 403 && /export|notExportable|fileNotExportable/i.test(hay)) {
      const e = new Error('O arquivo não é um Google Doc nativo (não pode ser exportado como texto).');
      e.code = 'DOC_NAO_EXPORTAVEL';
      throw e;
    }
    // (a) nao encontrado / sem acesso (Drive usa 404 p/ nao vazar existencia, ou 403).
    if (status === 404 || status === 403 || /not ?found|permission|acesso|forbidden/i.test(hay)) {
      const e = new Error(
        'Documento não encontrado ou sem acesso. Compartilhe o Google Doc como Leitor com a conta de serviço.',
      );
      e.code = 'DOC_SEM_ACESSO';
      throw e;
    }
    const e = new Error(`Falha ao exportar o Google Doc: ${err && err.message}`);
    e.code = 'DOC_ERRO';
    throw e;
  }
}

module.exports = { enviarVideo, exportarTextoDoc, extrairFileIdDeUrl };
