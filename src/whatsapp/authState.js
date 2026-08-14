'use strict';

// Auth state do Baileys sobre SQLite (tabela baileys_auth), cifrado.
//
// Substitui o `useMultiFileAuthState` da biblioteca, que grava um arquivo por chave em
// disco. Aqui isso nao serve por dois motivos: o disco do container e efemero (um deploy
// apagaria a sessao e exigiria parear de novo) e o volume persistente ja e o banco.
//
// ── O CONTRATO QUE O BAILEYS ESPERA ──
//   { state: { creds, keys: { get(tipo, ids) -> {id: valor}, set(dados) } }, saveCreds() }
// `keys.get` recebe um TIPO ('pre-key', 'session', 'app-state-sync-key', ...) e uma lista de
// ids, e devolve um objeto id -> valor. `keys.set` recebe { tipo: { id: valor|null } }, onde
// null significa APAGAR.
//
// ── BufferJSON E O DETALHE QUE DECIDE SE FUNCIONA ──
// As credenciais sao cheias de Buffer (chaves Curve25519, etc.). JSON.stringify puro
// transforma Buffer em `{"type":"Buffer","data":[...]}` e JSON.parse devolve um objeto comum
// — nao um Buffer. O Baileys entao tenta usar aquilo como chave criptografica e a sessao
// corrompe de um jeito que so aparece depois, como falha de decriptacao de mensagem.
// BufferJSON.replacer/reviver e o par que a propria biblioteca expoe para isso, e usar os
// dois e obrigatorio — nao e detalhe de estilo.

const { initAuthCreds, BufferJSON } = require('@whiskeysockets/baileys');

const dbPadrao = require('../db');
const { sealSecret, openSecret } = require('../lib/whatsappSecrets');

// Instancia unica hoje. A coluna existe para o dia em que houver mais de um numero; deixar
// o valor fixo aqui evita espalhar a string pelo codigo.
const INSTANCIA_PADRAO = 'jean';

// Serializa com BufferJSON.replacer e sela. As duas coisas juntas, sempre — cifrar sem o
// replacer gravaria Buffer quebrado, e usar o replacer sem cifrar gravaria credencial em
// claro. Nao ha caminho que faca so uma.
function paraColuna(valor) {
  return sealSecret(JSON.stringify(valor, BufferJSON.replacer));
}

function daColuna(texto) {
  return JSON.parse(openSecret(texto), BufferJSON.reviver);
}

// Monta o auth state. Sincrono no acesso ao banco (better-sqlite3 e sincrono), mas com a
// interface async que o Baileys espera.
//
// `deps.db` injetavel pelo mesmo motivo do resto do projeto: teste sem tocar o banco real.
function criarAuthState(deps = {}) {
  const db = deps.db || dbPadrao;
  const instancia = deps.instancia || INSTANCIA_PADRAO;
  const conn = db.getDb();

  const stmtLer = conn.prepare('SELECT value FROM baileys_auth WHERE instance_id = ? AND key = ?');
  const stmtGravar = conn.prepare(
    `INSERT INTO baileys_auth (instance_id, key, value, updated_at)
     VALUES (?, ?, ?, datetime('now'))
     ON CONFLICT(instance_id, key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
  );
  const stmtApagar = conn.prepare('DELETE FROM baileys_auth WHERE instance_id = ? AND key = ?');

  const ler = (chave) => {
    const linha = stmtLer.get(instancia, chave);
    if (!linha) return null;
    try {
      return daColuna(linha.value);
    } catch (err) {
      // Chave trocada ou blob adulterado. NAO devolvemos null silenciosamente para 'creds':
      // isso faria o Baileys tratar como sessao nova e pedir pareamento sem explicar por
      // que. Para as demais chaves, ausencia e um estado normal (o Baileys regenera), entao
      // logamos e seguimos.
      console.error(`[wa-auth] falha ao abrir '${chave}' (chave de cifragem trocada?): ${err.message}`);
      if (chave === 'creds') throw err;
      return null;
    }
  };

  // `creds` ausente = sessao nova. initAuthCreds gera o par de chaves inicial; o pareamento
  // por QR acontece em cima disso.
  const creds = ler('creds') || initAuthCreds();

  const keys = {
    async get(tipo, ids) {
      const saida = {};
      for (const id of ids) {
        const valor = ler(`${tipo}-${id}`);
        if (valor !== null && valor !== undefined) saida[id] = valor;
      }
      return saida;
    },
    async set(dados) {
      // Uma transacao por lote: o Baileys chama isto com dezenas de chaves de uma vez
      // (rotacao de pre-keys), e gravar uma a uma fora de transacao seria um fsync por
      // chave. Tambem torna o lote atomico — meia rotacao gravada e sessao inconsistente.
      const gravarLote = conn.transaction(() => {
        for (const [tipo, porId] of Object.entries(dados || {})) {
          for (const [id, valor] of Object.entries(porId || {})) {
            const chave = `${tipo}-${id}`;
            // null/undefined = APAGAR. E parte do contrato do Baileys, nao um caso de borda:
            // e assim que ele descarta pre-keys ja consumidas.
            if (valor === null || valor === undefined) stmtApagar.run(instancia, chave);
            else stmtGravar.run(instancia, chave, paraColuna(valor));
          }
        }
      });
      gravarLote();
    },
  };

  // Ligado ao evento `creds.update` por quem cria o socket. Grava o objeto `creds` VIVO —
  // o Baileys muta o mesmo objeto em vez de emitir uma copia, entao ler a referencia aqui e
  // o comportamento certo.
  async function saveCreds() {
    stmtGravar.run(instancia, 'creds', paraColuna(creds));
  }

  return { state: { creds, keys }, saveCreds };
}

// Apaga a sessao inteira. Chamado no logout confirmado (401) — ver whatsapp/connection.
// Devolve quantas chaves sairam, para o log dizer se havia sessao de fato.
function limparAuthState(deps = {}) {
  const db = deps.db || dbPadrao;
  const instancia = deps.instancia || INSTANCIA_PADRAO;
  return db.getDb().prepare('DELETE FROM baileys_auth WHERE instance_id = ?').run(instancia).changes;
}

function contarChavesAuth(deps = {}) {
  const db = deps.db || dbPadrao;
  const instancia = deps.instancia || INSTANCIA_PADRAO;
  return db.getDb().prepare('SELECT COUNT(*) n FROM baileys_auth WHERE instance_id = ?').get(instancia).n;
}

module.exports = { criarAuthState, limparAuthState, contarChavesAuth, INSTANCIA_PADRAO };
