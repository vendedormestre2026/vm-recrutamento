'use strict';

// Limpeza dos arquivos de audio de uma entrevista no volume persistente.
//
// Extraido de routes/api.js (onde nascia junto do POST /interview/video-upload, seu
// unico chamador na epoca). Mora aqui porque deixou de ser detalhe de UMA rota: a
// decisao de QUANDO apagar passa a ter mais de um dono, e a exclusao em si precisa ser
// a MESMA nos dois caminhos — nao duas implementacoes que podem divergir.
//
// Este modulo so sabe APAGAR. Quem decide se pode apagar (entrevista concluida, video
// confirmado no Drive, relatorio gerado) e o chamador.

const fs = require('node:fs');
const path = require('node:path');
const { config } = require('../config');

// Apaga os audios de uma entrevista do volume: o mp3 de cada fala da Vera (TTS) e o
// .webm de cada resposta do candidato, em /data/entrevistas/<id>.
//
// POR QUE PODE APAGAR: depois que a entrevista acaba nada mais le esses arquivos. O
// .webm da resposta so e gravado (interview_turns.audio_path NUNCA e lido por nenhuma
// rota/tela) e o mp3 da Vera so e servido DURANTE a entrevista. O conteudo sonoro
// continua existindo na gravacao de video do Drive, e a transcricao esta no banco.
//
// QUANDO CHAMAR: SO apos o video ser confirmado no Drive. Nao chame em
// finalizarEntrevista: naquele momento o candidato ainda nao ouviu a fala de fechamento
// (o cliente toca o audio e SO no callback encerra e sobe o video), entao o mp3 recem
// gravado ainda vai ser buscado pelo navegador.
//
// Best-effort: qualquer falha apenas loga. Devolve os bytes liberados (0 em erro).
function removerAudioDaEntrevista(interviewId) {
  const id = Number(interviewId);
  // Guarda de caminho: so inteiro positivo vira nome de pasta (nunca '..' ou vazio).
  if (!Number.isInteger(id) || id <= 0) return 0;
  const dir = path.join(config.caminhoEntrevistas, String(id));
  try {
    if (!fs.existsSync(dir)) return 0;
    let bytes = 0;
    for (const arquivo of fs.readdirSync(dir)) {
      const alvo = path.join(dir, arquivo);
      try {
        bytes += fs.statSync(alvo).size;
        fs.unlinkSync(alvo);
      } catch {
        /* arquivo em uso/ja removido: segue para os demais */
      }
    }
    fs.rmSync(dir, { recursive: true, force: true });
    return bytes;
  } catch (e) {
    console.error(`[video-upload] falha ao limpar áudios da interview ${id}: ${e.message}`);
    return 0;
  }
}

module.exports = { removerAudioDaEntrevista };
