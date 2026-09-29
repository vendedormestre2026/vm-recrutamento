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

test('limiteDoVideo = meio-dia do dia seguinte ao wa2.enviado_em (Brasilia), e null sem envio', () => {
  // 2026-08-14 10:00 UTC = 07:00 em Brasilia (mesmo dia civil) -> +1 dia = 15/08, meio-dia
  // BRT = 15:00 UTC.
  const linhas = [{ etapa: 'wa2', status: 'enviado', enviado_em: '2026-08-14 10:00:00' }];
  const limite = ficha.limiteDoVideo(linhas);
  assert.equal(limite.toISOString(), '2026-08-15T15:00:00.000Z');

  // Sem envio nao ha prazo: inventar um a partir do agendamento seria cobrar de um relogio
  // que nunca comecou a correr.
  assert.equal(ficha.limiteDoVideo([{ etapa: 'wa2', status: 'pendente', enviado_em: null }]), null);
  assert.equal(ficha.limiteDoVideo([]), null);
});

test('limiteDoVideo le a data do banco como UTC', () => {
  // Mesma armadilha do outbox: datetime('now') e UTC sem sufixo, e new Date() interpretaria
  // como local — o dia civil em Brasilia sairia deslocado pelo offset da maquina. 23:30 UTC
  // ja e 20:30 do MESMO dia em Brasilia (UTC-3), entao o "amanha" certo e o dia seguinte a
  // esse, nao um dia extra.
  const limite = ficha.limiteDoVideo([{ etapa: 'wa2', status: 'enviado', enviado_em: '2026-08-14 23:30:00' }]);
  assert.equal(limite.toISOString(), '2026-08-15T15:00:00.000Z');
});

test('calcularPrazoAmanhaMeioDia: dia civil em Brasilia, nao em UTC', () => {
  // Meio-dia UTC: 09:00 em Brasilia, mesmo dia civil -> amanha, meio-dia BRT.
  assert.equal(
    ficha.calcularPrazoAmanhaMeioDia(new Date('2026-08-14T12:00:00Z')).toISOString(),
    '2026-08-15T15:00:00.000Z',
  );
  // Fronteira de dia civil: 01:30 UTC de 15/08 ainda e 14/08 as 22:30 em Brasilia (UTC-3) —
  // o "amanha" certo e 15/08, e nao 16/08 (o que aconteceria se o calculo usasse o dia civil
  // em UTC em vez do dia civil em Brasilia).
  assert.equal(
    ficha.calcularPrazoAmanhaMeioDia(new Date('2026-08-15T01:30:00Z')).toISOString(),
    '2026-08-15T15:00:00.000Z',
  );
  // Input invalido/nulo nao pode produzir data nenhuma (e `new Date(null)` NAO e invalida —
  // vira epoch — entao a guarda contra null precisa ser explicita, nao so Number.isNaN).
  assert.equal(ficha.calcularPrazoAmanhaMeioDia(null), null);
  assert.equal(ficha.calcularPrazoAmanhaMeioDia(undefined), null);
  assert.equal(ficha.calcularPrazoAmanhaMeioDia('lixo'), null);
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
    assert.match(html, /Prazo \(amanhã, meio-dia\)/);
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
    // O rotulo acompanhou a troca da mensagem: o WA2 nao pede mais video.
    assert.match(html, /WA2 \(\+15min, convite da entrevista em grupo\)/);
    assert.doesNotMatch(html, /pede vídeo/);
    // WA2 em FALHA nunca pediu video nenhum (nao saiu), entao o bloco de video nao aparece.
    assert.doesNotMatch(html, /Vídeo de apresentação/);
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

// ══════════════════ 7D — variante do WA2 (convite / fallback) ══════════════════
//
// O WA2 pedia video e hoje convida para a entrevista em grupo. A ficha precisa distinguir, POR
// CANDIDATURA, qual mensagem chegou — e o discriminador e a coluna `variante`:
//   NULL + enviado    era do pedido de video (a coluna nasceu junto com a troca da mensagem)
//   'convite_grupo'   convite com data e link
//   'sem_reuniao'     aviso de "datas em breve", sem link

function definirVariante(appId, variante) {
  exec("UPDATE whatsapp_sequencia_envios SET variante = ? WHERE application_id = ? AND etapa = 'wa2'", variante, appId);
}

test('pediuVideo: so quando o WA2 saiu SEM variante (era do video)', () => {
  const linhasVideo = [{ etapa: 'wa2', status: 'enviado', enviado_em: '2026-08-14 10:00:00', variante: null }];
  const linhasConvite = [{ etapa: 'wa2', status: 'enviado', enviado_em: '2026-08-14 10:00:00', variante: 'convite_grupo' }];
  const linhasPendente = [{ etapa: 'wa2', status: 'pendente', variante: null }];

  assert.equal(ficha.pediuVideo(linhasVideo), true);
  assert.equal(ficha.pediuVideo(linhasConvite), false);
  // Pendente tem variante NULL tambem, mas ainda VAI sair — e vai sair como convite. Tratar
  // como "pediu video" abriria a confirmacao de video para toda candidatura nova.
  assert.equal(ficha.pediuVideo(linhasPendente), false);
  assert.equal(ficha.pediuVideo([]), false);
});

test('podeConfirmarVideo agora exige que o WA2 tenha PEDIDO video', () => {
  assert.equal(ficha.podeConfirmarVideo([{ etapa: 'wa2', status: 'enviado', variante: null }]), true);
  assert.equal(ficha.podeConfirmarVideo([{ etapa: 'wa2', status: 'enviado', variante: 'convite_grupo' }]), false);
  assert.equal(ficha.podeConfirmarVideo([{ etapa: 'wa2', status: 'enviado', variante: 'sem_reuniao' }]), false);
});

test('mostrarVideo: confirmacao registrada mantem o historico visivel, mesmo no fluxo novo', () => {
  // Nada foi apagado: se alguem confirmou um video, a ficha continua mostrando — ainda que o
  // envio tenha sido um convite (caso de borda: video recebido fora do fluxo).
  const convite = [{ etapa: 'wa2', status: 'enviado', variante: 'convite_grupo' }];
  assert.equal(ficha.mostrarVideo({}, convite), false);
  assert.equal(ficha.mostrarVideo({ wa2_video_recebido_em: '2026-08-14 12:00:00' }, convite), true);
});

test('recebeuFallbackEntrevistaGrupo: so para quem recebeu o aviso de datas em breve', () => {
  assert.equal(ficha.recebeuFallbackEntrevistaGrupo([{ etapa: 'wa2', status: 'enviado', variante: 'sem_reuniao' }]), true);
  assert.equal(ficha.recebeuFallbackEntrevistaGrupo([{ etapa: 'wa2', status: 'enviado', variante: 'convite_grupo' }]), false);
  assert.equal(ficha.recebeuFallbackEntrevistaGrupo([{ etapa: 'wa2', status: 'pendente', variante: 'sem_reuniao' }]), false);
});

test('ficha do fluxo ANTIGO (variante NULL): bloco e botao de video continuam la', async () => {
  zerar();
  const id = criarCandidato();
  inserirEtapa(id, 'wa2', 'enviado', '2026-08-14 10:00:00'); // variante NULL = era do video

  await comServidor(async (base) => {
    await autenticar(base);
    const html = await (await fetch(`${base}/admin/candidato/${id}`, { headers: comAuth() })).text();
    assert.match(html, /Vídeo de apresentação/);
    assert.match(html, /Marcar vídeo recebido/);
    assert.match(html, /Prazo do vídeo/);
  });
});

test('ficha do CONVITE: sem bloco de video, e diz qual mensagem saiu', async () => {
  zerar();
  const id = criarCandidato();
  inserirEtapa(id, 'wa2', 'enviado', '2026-08-14 10:00:00');
  definirVariante(id, 'convite_grupo');

  await comServidor(async (base) => {
    await autenticar(base);
    const html = await (await fetch(`${base}/admin/candidato/${id}`, { headers: comAuth() })).text();
    assert.doesNotMatch(html, /Vídeo de apresentação/);
    assert.doesNotMatch(html, /Marcar vídeo recebido/);
    assert.doesNotMatch(html, /Prazo do vídeo/);
    assert.match(html, /Mensagem enviada no WA2/);
    assert.match(html, /convite da entrevista em grupo/);
  });
});

test('ficha do FALLBACK: avisa que a pessoa precisa ser reconvidada a mao', async () => {
  zerar();
  const id = criarCandidato();
  inserirEtapa(id, 'wa2', 'enviado', '2026-08-14 10:00:00');
  definirVariante(id, 'sem_reuniao');

  await comServidor(async (base) => {
    await autenticar(base);
    const html = await (await fetch(`${base}/admin/candidato/${id}`, { headers: comAuth() })).text();
    assert.match(html, /datas estão sendo definidas/);
    assert.match(html, /não recebeu link de reunião/);
    assert.match(html, /não é\s+reenviado automaticamente|não é reenviado automaticamente/);
    assert.match(html, /\/admin\/convites-sem-data/);
  });
});

test('a rota de confirmacao RECUSA quando o WA2 nao pediu video', async () => {
  // Sem isso, a URL continuaria permitindo confirmar um video que nunca foi pedido.
  zerar();
  const id = criarCandidato();
  inserirEtapa(id, 'wa2', 'enviado', '2026-08-14 10:00:00');
  definirVariante(id, 'convite_grupo');

  await comServidor(async (base) => {
    await autenticar(base);
    const get = await fetch(`${base}/admin/candidato/${id}/video-wa2`, { headers: comAuth() });
    assert.equal(get.status, 400);
    assert.match(await get.text(), /não houve pedido de vídeo|Não houve pedido de vídeo/i);

    const post = await fetch(`${base}/admin/candidato/${id}/video-wa2`, {
      method: 'POST',
      headers: comAuth({ 'Content-Type': 'application/x-www-form-urlencoded' }),
      body: new URLSearchParams({ dentro_prazo: 'sim', confirmado_por: 'Jean' }),
      redirect: 'manual',
    });
    assert.equal(post.status, 400);
    assert.equal(db.obterAplicacao(id).wa2_video_recebido_em, null, 'nada pode ter sido gravado');
  });
});

// ══════════════════ 7E — /admin/convites-sem-data ══════════════════

test('a tela lista quem recebeu o fallback, agrupado por vaga', async () => {
  zerar();
  const id = criarCandidato();
  inserirEtapa(id, 'wa2', 'enviado', '2026-08-14 10:00:00');
  definirVariante(id, 'sem_reuniao');

  await comServidor(async (base) => {
    await autenticar(base);
    const html = await (await fetch(`${base}/admin/convites-sem-data`, { headers: comAuth() })).text();
    assert.match(html, /Convites sem data/);
    assert.match(html, /Vendedor Externo/);
    assert.match(html, /Ana Silva/);
    assert.match(html, /ainda sem data/, 'a vaga nao tem reuniao futura cadastrada');
    assert.match(html, /não é reenviado/i);
  });
});

test('quando a vaga JA tem data, a tela diz que pode chamar as pessoas', async () => {
  zerar();
  const id = criarCandidato();
  inserirEtapa(id, 'wa2', 'enviado', '2026-08-14 10:00:00');
  definirVariante(id, 'sem_reuniao');
  // Cadastra a reuniao DEPOIS do envio — exatamente o cenario que a tela existe para resolver.
  const jobId = db.obterAplicacao(id).job_id;
  const daqui = new Date(Date.now() + 15 * 24 * 60 * 60 * 1000);
  const data = `${daqui.getUTCFullYear()}-${String(daqui.getUTCMonth() + 1).padStart(2, '0')}-${String(daqui.getUTCDate()).padStart(2, '0')}`;
  db.atualizarVaga(jobId, {
    titulo: 'Vendedor Externo',
    link_meet: 'https://meet.google.com/abc-defg-hij',
    entrevista_grupo_1_data: data,
    entrevista_grupo_1_hora: '19:30',
  });

  await comServidor(async (base) => {
    await autenticar(base);
    const html = await (await fetch(`${base}/admin/convites-sem-data`, { headers: comAuth() })).text();
    assert.match(html, /já tem data/);
    assert.match(html, /pode chamar estas pessoas/);
    // A pessoa CONTINUA na lista: ela nunca recebeu link, e cadastrar a data nao a avisa.
    assert.match(html, /Ana Silva/);
  });
});

test('sem ninguem no fallback, a tela diz isso em vez de mostrar tabela vazia', async () => {
  zerar();
  const id = criarCandidato();
  inserirEtapa(id, 'wa2', 'enviado', '2026-08-14 10:00:00');
  definirVariante(id, 'convite_grupo');

  await comServidor(async (base) => {
    await autenticar(base);
    const html = await (await fetch(`${base}/admin/convites-sem-data`, { headers: comAuth() })).text();
    assert.match(html, /Ninguém recebeu o aviso/);
  });
});

test('a listagem de vagas marca a vaga ATIVA sem entrevista em grupo futura', async () => {
  zerar();
  criarCandidato(); // cria a vaga ativa, sem link nem datas

  await comServidor(async (base) => {
    await autenticar(base);
    const html = await (await fetch(`${base}/admin/vagas`, { headers: comAuth() })).text();
    assert.match(html, /sem entrevista em grupo/);
    assert.match(html, /vaga\(s\) ativa\(s\) sem entrevista em grupo/);
    assert.match(html, /\/admin\/convites-sem-data/);
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
