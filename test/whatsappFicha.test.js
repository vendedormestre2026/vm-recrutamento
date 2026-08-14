'use strict';

// Ficha do candidato: estado da sequencia WA1/WA2, confirmacao manual do video, e o
// checkbox de whatsapp_sequencia_ativa no /admin/config.
//
// ── ZERO WHATSAPP REAL ──
// Nenhum socket, nenhum envio. As linhas da fila sao inseridas direto no banco.
//
// ── O QUE ESTA EM JOGO ──
// A confirmacao do video decide se um candidato e considerado dentro ou fora do prazo, e
// isso decide se ele segue no processo. Os dois erros:
//   marcar sem base       grava prazo que nunca comecou a correr (WA2 nunca saiu)
//   automatizar demais    marca "fora do prazo" quem cumpriu, porque a confirmacao acontece
//                         sempre DEPOIS do fato real

const os = require('node:os');
const path = require('node:path');

process.env.DATABASE_PATH = path.join(os.tmpdir(), `vm-test-wa-ficha-${process.pid}-${Date.now()}.db`);
process.env.INTERVIEW_MOCK = 'true';
process.env.SESSION_SECRET = 'segredo-de-teste';
process.env.ADMIN_USER = 'admin-teste';
process.env.ADMIN_PASSWORD = 'senha-teste';
process.env.WHATSAPP_SECRETS_KEY = 'a'.repeat(64);
process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert/strict');

const db = require('../src/db');
const { migrar } = require('../src/db/migrate');
const { criarApp } = require('../src/server');
const ficha = require('../src/lib/whatsappFicha');
const outbox = require('../src/whatsapp/sequenciaOutbox');

migrar();

const run = (sql, ...p) => Number(db.getDb().prepare(sql).run(...p).lastInsertRowid);
const exec = (sql, ...p) => db.getDb().prepare(sql).run(...p);

let cookieAdmin = '';
let seq = 0;

async function comServidor(fn) {
  const app = criarApp();
  const server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  try {
    return await fn(`http://127.0.0.1:${server.address().port}`);
  } finally {
    await new Promise((r) => server.close(r));
  }
}

async function autenticar(base) {
  const res = await fetch(`${base}/admin/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ usuario: 'admin-teste', senha: 'senha-teste' }),
    redirect: 'manual',
  });
  const bruto = res.headers.getSetCookie ? res.headers.getSetCookie() : [res.headers.get('set-cookie')];
  cookieAdmin = bruto.filter(Boolean).map((c) => c.split(';')[0]).join('; ');
  assert.ok(cookieAdmin.includes('vm_admin'));
}

const comAuth = (extra = {}) => ({ Cookie: cookieAdmin, ...extra });

function criarCandidato() {
  seq += 1;
  const jobId = run(
    "INSERT INTO jobs (slug, titulo, perfil, empresa, ativo) VALUES (?, 'Vendedor Externo', 'CLOSER', 'Labor Seg', 1)",
    `vaga-ficha-${seq}`,
  );
  return run(
    "INSERT INTO applications (job_id, nome, sobrenome, email, telefone, token) VALUES (?, 'Ana', 'Silva', ?, '+55 47 99958-2500', ?)",
    jobId,
    `ana${seq}@x.co`,
    `tok-ficha-${seq}`,
  );
}

function inserirEtapa(appId, etapa, status, enviadoEm = null) {
  exec(
    `INSERT INTO whatsapp_sequencia_envios
       (application_id, etapa, telefone_e164, status, agendado_para, enviado_em)
     VALUES (?, ?, '5547999582500', ?, '2026-08-14 10:00:00', ?)`,
    appId,
    etapa,
    status,
    enviadoEm,
  );
}

function zerar() {
  exec('DELETE FROM whatsapp_sequencia_envios');
  exec('DELETE FROM applications');
  exec('DELETE FROM jobs');
  db.definirConfigBool(outbox.CHAVE_ATIVO, false);
}

// ══════════════════ Logica pura (lib/whatsappFicha) ══════════════════

test('etapa ausente NAO quebra — e o caso das candidaturas antigas', () => {
  // Candidatura anterior a esta feature nao tem linha nenhuma. Ausencia e o caso NORMAL.
  const e = ficha.estadoEtapa([], 'wa1');
  assert.equal(e.existe, false);
  assert.equal(e.rotulo, 'não se aplica');
  assert.equal(e.enviadoEm, null);
});

test('limiteDoVideo = wa2.enviado_em + prazo, e null sem envio', () => {
  const linhas = [{ etapa: 'wa2', status: 'enviado', enviado_em: '2026-08-14 10:00:00' }];
  const limite = ficha.limiteDoVideo(linhas, 24);
  assert.equal(limite.toISOString(), '2026-08-15T10:00:00.000Z');

  // Sem envio nao ha prazo: inventar um a partir do agendamento seria cobrar de um relogio
  // que nunca comecou a correr.
  assert.equal(ficha.limiteDoVideo([{ etapa: 'wa2', status: 'pendente', enviado_em: null }], 24), null);
  assert.equal(ficha.limiteDoVideo([], 24), null);
});

test('limiteDoVideo le a data do banco como UTC', () => {
  // Mesma armadilha do outbox: datetime('now') e UTC sem sufixo, e new Date() interpretaria
  // como local — o prazo sairia deslocado pelo offset da maquina.
  const limite = ficha.limiteDoVideo([{ etapa: 'wa2', status: 'enviado', enviado_em: '2026-08-14 10:00:00' }], 1);
  assert.equal(limite.toISOString(), '2026-08-14T11:00:00.000Z');
});

test('podeConfirmarVideo so com WA2 ENVIADO', () => {
  for (const status of ['pendente', 'falha', 'entregue']) {
    assert.equal(ficha.podeConfirmarVideo([{ etapa: 'wa2', status }]), false, status);
  }
  assert.equal(ficha.podeConfirmarVideo([{ etapa: 'wa2', status: 'enviado' }]), true);
  assert.equal(ficha.podeConfirmarVideo([]), false);
});

test('sugestaoDentroPrazo compara agora com o limite', () => {
  const limite = new Date('2026-08-15T10:00:00Z');
  assert.equal(ficha.sugestaoDentroPrazo(limite, new Date('2026-08-15T09:59:00Z')), 'sim');
  assert.equal(ficha.sugestaoDentroPrazo(limite, new Date('2026-08-15T10:00:01Z')), 'nao');
  assert.equal(ficha.sugestaoDentroPrazo(null), 'na');
});

test('situacaoVideo cobre os tres estados', () => {
  const enviado = [{ etapa: 'wa2', status: 'enviado', enviado_em: '2026-08-14 10:00:00' }];
  assert.equal(ficha.situacaoVideo({}, []).rotulo, 'não se aplica');
  assert.equal(ficha.situacaoVideo({}, enviado).rotulo, 'aguardando confirmação');
  assert.match(
    ficha.situacaoVideo({ wa2_video_recebido_em: 'x', wa2_video_dentro_prazo: 'sim' }, enviado).rotulo,
    /dentro do prazo/,
  );
  assert.match(
    ficha.situacaoVideo({ wa2_video_recebido_em: 'x', wa2_video_dentro_prazo: 'nao' }, enviado).rotulo,
    /FORA do prazo/,
  );
});

// ══════════════════ 7A — checkbox no /admin/config ══════════════════

test('checkbox de whatsapp_sequencia_ativa aparece, liga e persiste', async () => {
  zerar();
  await comServidor(async (base) => {
    await autenticar(base);

    const html = await (await fetch(`${base}/admin/config`, { headers: comAuth() })).text();
    assert.match(html, /name="whatsapp_sequencia_ativa"/);
    // Default desligado: o kill-switch nao pode nascer ligado.
    assert.doesNotMatch(html, /name="whatsapp_sequencia_ativa" value="1" checked/);

    // Liga.
    await fetch(`${base}/admin/config/notificacoes`, {
      method: 'POST',
      headers: comAuth({ 'Content-Type': 'application/x-www-form-urlencoded' }),
      body: new URLSearchParams({ whatsapp_sequencia_ativa: '1' }),
      redirect: 'manual',
    });
    assert.equal(db.obterConfigBool(outbox.CHAVE_ATIVO, false), true);

    const ligado = await (await fetch(`${base}/admin/config`, { headers: comAuth() })).text();
    assert.match(ligado, /name="whatsapp_sequencia_ativa" value="1" checked/);

    // Desliga: checkbox ausente do POST = desmarcado (comportamento de form HTML).
    await fetch(`${base}/admin/config/notificacoes`, {
      method: 'POST',
      headers: comAuth({ 'Content-Type': 'application/x-www-form-urlencoded' }),
      body: new URLSearchParams({}),
      redirect: 'manual',
    });
    assert.equal(db.obterConfigBool(outbox.CHAVE_ATIVO, false), false);
  });
});

// ══════════════════ 7B — botao de confirmacao do video ══════════════════

test('sem WA2 enviado: botao DESABILITADO e a rota recusa', async () => {
  zerar();
  const id = criarCandidato();
  inserirEtapa(id, 'wa1', 'enviado', '2026-08-14 10:00:00');
  inserirEtapa(id, 'wa2', 'pendente');

  await comServidor(async (base) => {
    await autenticar(base);
    const html = await (await fetch(`${base}/admin/candidato/${id}`, { headers: comAuth() })).text();
    assert.match(html, /btn--off[^>]*disabled|disabled[^>]*btn--off/);
    assert.doesNotMatch(html, new RegExp(`href="/admin/candidato/${id}/video-wa2"`));

    // E a rota tambem barra — o botao desabilitado nao e a unica defesa.
    const res = await fetch(`${base}/admin/candidato/${id}/video-wa2`, { headers: comAuth() });
    assert.equal(res.status, 400);
  });
});

test('candidatura ANTIGA (sem nenhuma linha) renderiza sem quebrar', async () => {
  zerar();
  const id = criarCandidato(); // nenhuma etapa inserida
  await comServidor(async (base) => {
    await autenticar(base);
    const res = await fetch(`${base}/admin/candidato/${id}`, { headers: comAuth() });
    assert.equal(res.status, 200);
    const html = await res.text();
    assert.match(html, /Sequência de WhatsApp/);
    assert.match(html, /não se aplica/);
  });
});

test('a tela de confirmacao MOSTRA o prazo antes de pedir a decisao', async () => {
  zerar();
  const id = criarCandidato();
  inserirEtapa(id, 'wa2', 'enviado', '2026-08-14 10:00:00');

  await comServidor(async (base) => {
    await autenticar(base);
    const html = await (await fetch(`${base}/admin/candidato/${id}/video-wa2`, { headers: comAuth() })).text();
    // Um clique que grava "dentro/fora do prazo" sem mostrar contra o que compara e um
    // clique cego, e o resultado decide o destino de um candidato.
    assert.match(html, /WA2 enviado em/);
    assert.match(html, /Prazo \(\d+h\)/);
    assert.match(html, /name="dentro_prazo"/);
    assert.match(html, /name="confirmado_por"/);
    // E o recrutador pode corrigir a sugestao. `\s+` porque o template quebra a frase em
    // duas linhas no HTML — a mesma armadilha de sempre em assercao sobre texto renderizado.
    assert.match(html, /Corrija se souber que o vídeo\s+chegou antes/);
  });
});

test('confirmar grava os TRES campos', async () => {
  zerar();
  const id = criarCandidato();
  inserirEtapa(id, 'wa2', 'enviado', '2026-08-14 10:00:00');

  await comServidor(async (base) => {
    await autenticar(base);
    await fetch(`${base}/admin/candidato/${id}/video-wa2`, {
      method: 'POST',
      headers: comAuth({ 'Content-Type': 'application/x-www-form-urlencoded' }),
      body: new URLSearchParams({ dentro_prazo: 'sim', confirmado_por: 'Jean' }),
      redirect: 'manual',
    });

    const c = db.obterAplicacao(id);
    assert.ok(c.wa2_video_recebido_em, 'recebido_em precisa ser gravado');
    assert.equal(c.wa2_video_dentro_prazo, 'sim');
    assert.equal(c.wa2_video_confirmado_por, 'Jean');
  });
});

test('reconfirmar ATUALIZA, nao duplica', async () => {
  zerar();
  const id = criarCandidato();
  inserirEtapa(id, 'wa2', 'enviado', '2026-08-14 10:00:00');

  await comServidor(async (base) => {
    await autenticar(base);
    const enviar = (dados) =>
      fetch(`${base}/admin/candidato/${id}/video-wa2`, {
        method: 'POST',
        headers: comAuth({ 'Content-Type': 'application/x-www-form-urlencoded' }),
        body: new URLSearchParams(dados),
        redirect: 'manual',
      });

    await enviar({ dentro_prazo: 'nao', confirmado_por: 'Jean' });
    await enviar({ dentro_prazo: 'sim', confirmado_por: 'Rafael' });

    // Sao colunas em applications, nao tabela a parte: a ultima palavra do recrutador vale,
    // inclusive para corrigir marcacao errada.
    const c = db.obterAplicacao(id);
    assert.equal(c.wa2_video_dentro_prazo, 'sim');
    assert.equal(c.wa2_video_confirmado_por, 'Rafael');
    assert.equal(db.getDb().prepare('SELECT COUNT(*) n FROM applications WHERE id = ?').get(id).n, 1);
  });
});

test('valor forjado de dentro_prazo vira "na" em vez de perder o registro', async () => {
  zerar();
  const id = criarCandidato();
  inserirEtapa(id, 'wa2', 'enviado', '2026-08-14 10:00:00');

  await comServidor(async (base) => {
    await autenticar(base);
    await fetch(`${base}/admin/candidato/${id}/video-wa2`, {
      method: 'POST',
      headers: comAuth({ 'Content-Type': 'application/x-www-form-urlencoded' }),
      body: new URLSearchParams({ dentro_prazo: 'talvez', confirmado_por: 'X' }),
      redirect: 'manual',
    });
    const c = db.obterAplicacao(id);
    // O fato (video recebido) e mais importante que o rotulo — perder o registro por causa
    // de um select adulterado seria proteger a etiqueta as custas do dado.
    assert.equal(c.wa2_video_dentro_prazo, 'na');
    assert.ok(c.wa2_video_recebido_em);
  });
});

// ══════════════════ 7C — visibilidade na ficha ══════════════════

test('a ficha mostra os tres status', async () => {
  zerar();
  const id = criarCandidato();
  inserirEtapa(id, 'wa1', 'enviado', '2026-08-14 10:00:00');
  inserirEtapa(id, 'wa2', 'falha');
  exec("UPDATE whatsapp_sequencia_envios SET erro = 'socket caiu' WHERE etapa = 'wa2'");

  await comServidor(async (base) => {
    await autenticar(base);
    const html = await (await fetch(`${base}/admin/candidato/${id}`, { headers: comAuth() })).text();
    assert.match(html, /WA1 \(imediato\)/);
    assert.match(html, /WA2 \(\+\d+h, pede vídeo\)/);
    assert.match(html, /Vídeo de apresentação/);
    assert.match(html, /socket caiu/, 'o erro do WA2 precisa aparecer na ficha');
  });
});

test('ficha com video confirmado mostra quem e quando', async () => {
  zerar();
  const id = criarCandidato();
  inserirEtapa(id, 'wa2', 'enviado', '2026-08-14 10:00:00');
  db.confirmarVideoWa2(id, { recebidoEm: '2026-08-14T12:00:00.000Z', dentroPrazo: 'sim', confirmadoPor: 'Jean' });

  await comServidor(async (base) => {
    await autenticar(base);
    const html = await (await fetch(`${base}/admin/candidato/${id}`, { headers: comAuth() })).text();
    assert.match(html, /recebido, dentro do prazo/);
    assert.match(html, /por Jean/);
    assert.match(html, /Revisar confirmação do vídeo/);
  });
});

test('a ficha faz UMA consulta a fila, nao uma por etapa', () => {
  // N+1 e divida tecnica ja conhecida neste painel (LinkedIn/Origem). Nao pioramos:
  // listarSequenciaWhatsappDaApplication devolve as DUAS etapas numa consulta so.
  zerar();
  const id = criarCandidato();
  inserirEtapa(id, 'wa1', 'enviado', '2026-08-14 10:00:00');
  inserirEtapa(id, 'wa2', 'enviado', '2026-08-14 10:00:00');

  const linhas = db.listarSequenciaWhatsappDaApplication(id);
  assert.equal(linhas.length, 2);
  assert.deepEqual(linhas.map((l) => l.etapa), ['wa1', 'wa2']);
});
