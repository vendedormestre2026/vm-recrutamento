'use strict';

// Item 8 - normalizacao do video introdutorio da vaga (YouTube nao listado).
//
// O painel aceita que o recrutador cole tanto a URL completa quanto so o ID do video.
// Guardamos SEMPRE o ID canonico (11 chars) em jobs.video_intro_ref — o front monta o
// embed a partir dele (youtube-nocookie.com/embed/<id>). Assim a persistencia nao depende
// do formato exato que o usuario colou, e a pagina nunca precisa reparsear a URL.
//
// Aceita: URL de watch (?v=ID), youtu.be/ID, /embed/ID, /shorts/ID, /live/ID, ou o ID puro.
// Retorna o ID (string de 11 chars [A-Za-z0-9_-]) ou null quando nao consegue extrair.

function extrairYoutubeId(entrada) {
  const s = String(entrada == null ? '' : entrada).trim();
  if (!s) return null;
  // ID puro (ja normalizado): exatamente 11 chars do alfabeto de IDs do YouTube.
  if (/^[A-Za-z0-9_-]{11}$/.test(s)) return s;
  // Qualquer forma de URL: pega os 11 chars logo apos o marcador conhecido.
  const m = s.match(/(?:youtu\.be\/|[?&]v=|\/embed\/|\/shorts\/|\/live\/)([A-Za-z0-9_-]{11})/);
  return m ? m[1] : null;
}

module.exports = { extrairYoutubeId };
