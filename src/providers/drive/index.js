'use strict';

// Interface de armazenamento de video (gravacao da entrevista). Agnostica; hoje so
// existe o adaptador Google Drive. Os adaptadores reais so sao chamados quando
// INTERVIEW_MOCK=false (o caller decide; em mock nem importamos o SDK).
//
// Contrato:
//   enviarVideo({ caminho, nomeArquivo, mimeType }) -> Promise<{ id, link }>
//     caminho:     caminho do arquivo temporario no disco
//     nomeArquivo: nome final no Drive (ex.: "entrevista-12-fulano.webm")
//     mimeType:    'video/webm' | 'video/mp4'
//     retorno:     { id (fileId do Drive), link (URL compartilhavel) }
//   exportarTextoDoc(fileId) -> Promise<string>  (Google Doc nativo -> text/plain)
//   extrairFileIdDeUrl(url)  -> string | null    (util de parsing da URL do Doc)

const adaptadores = {
  google: () => require('./google'),
};

// So existe 'google' por enquanto; mantido o mesmo padrao de selecao dos demais
// provedores para facilitar troca futura.
function selecionar() {
  return adaptadores.google();
}

async function enviarVideo(opcoes) {
  return selecionar().enviarVideo(opcoes);
}

// Exporta um Google Doc nativo como texto puro (delega ao adaptador selecionado).
async function exportarTextoDoc(fileId) {
  return selecionar().exportarTextoDoc(fileId);
}

// Parsing da URL do Doc (util sincrono; delega ao adaptador para manter o formato do
// Drive concentrado no provider). Retorna o fileId ou null.
function extrairFileIdDeUrl(url) {
  return selecionar().extrairFileIdDeUrl(url);
}

module.exports = { enviarVideo, exportarTextoDoc, extrairFileIdDeUrl, selecionar };
