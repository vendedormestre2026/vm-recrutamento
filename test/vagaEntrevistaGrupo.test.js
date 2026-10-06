'use strict';

// B3 — entrevista em grupo no formulario da vaga, ponta a ponta pelo painel
// (routes/admin.js: camposEntrevistaGrupoHtml, lerEntrevistaGrupo, POST /admin/vagas e
// POST /admin/vagas/:id) mais a persistencia em db/sqlite.js.
//
// ── POR QUE HTTP, e nao teste de unidade ──
// A regra pura ja esta em test/entrevistaGrupo.test.js. O que ESTE arquivo guarda e a LIGACAO,
// que e onde campo novo de vaga realmente quebra neste projeto: criarVaga e atualizarVaga
// escrevem por lista EXPLICITA de colunas, entao um campo pode existir no formulario, ser lido
// e normalizado corretamente e mesmo assim nunca chegar ao banco — sem erro nenhum, porque o
// prepared statement simplesmente ignora a chave extra. Ja aconteceu com `cidade` (ver o
// cabecalho de test/vagaCidade.test.js), e o custo aqui seria pior: a mensagem sai sem link.

const os = require('node:os');
const path = require('node:path');

process.env.DATABASE_PATH = path.join(
  os.tmpdir(),
  `vm-test-vaga-entrevista-grupo-${process.pid}-${Date.now()}.db`,
);
process.env.INTERVIEW_MOCK = 'true';
process.env.SESSION_SECRET = 'segredo-de-teste';
process.env.ADMIN_USER = 'admin-teste';
process.env.ADMIN_PASSWORD = 'senha-teste';
process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert/strict');

const db = require('../src/db');
const { migrar } = require('../src/db/migrate');
const { criarApp } = require('../src/server');

migrar();

const LINK = 'https://meet.google.com/abc-defg-hij';

// Datas sempre relativas a HOJE: uma data fixa no futuro vira passado e o teste comeca a falhar
// sozinho um dia — o pior tipo de teste vermelho, porque ninguem mudou nada.
function diaRelativo(dias) {
  const d = new Date(Date.now() + dias * 24 * 60 * 60 * 1000);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
}
const DAQUI_10 = diaRelativo(10);
const DAQUI_20 = diaRelativo(20);
const DAQUI_30 = diaRelativo(30);
const HA_10 = diaRelativo(-10);
const HA_20 = diaRelativo(-20);

let cookieAdmin = '';

async function comServidor(fn) {
  const app = criarApp();
  const server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  try {
    return await fn(`http://127.0.0.1:${server.address().port}`);
  } finally {
    await new Promise((resolve) => server.close(resolve));
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

function corpoVaga(extra = {}) {
  return new URLSearchParams({
    titulo: 'Vaga de Teste',
    perfil: 'CLOSER',
    descricao: 'Descricao',
    ativo: 'on',
    ...extra,
  });
}

async function criarPeloForm(base, extra) {
  const res = await fetch(`${base}/admin/vagas`, {
    method: 'POST',
    headers: comAuth({ 'Content-Type': 'application/x-www-form-urlencoded' }),
    body: corpoVaga(extra),
    redirect: 'manual',
  });
  assert.ok(res.status < 400, `POST /admin/vagas devolveu ${res.status}`);
  return db.getDb().prepare('SELECT * FROM jobs ORDER BY id DESC LIMIT 1').get();
}

async function editarPeloForm(base, id, extra) {
  const res = await fetch(`${base}/admin/vagas/${id}`, {
    method: 'POST',
    headers: comAuth({ 'Content-Type': 'application/x-www-form-urlencoded' }),
    body: corpoVaga(extra),
    redirect: 'manual',
  });
  assert.ok(res.status < 400, `POST /admin/vagas/${id} devolveu ${res.status}`);
  return db.getDb().prepare('SELECT * FROM jobs WHERE id = ?').get(id);
}

const htmlDaVaga = async (base, id) =>
  (await fetch(`${base}/admin/vagas/${id}`, { headers: comAuth() })).text();

// ══════════════════ O FORMULARIO OFERECE OS CAMPOS ══════════════════

test('o formulario de NOVA vaga tem o link do Meet e os 3 pares data/horario', async () => {
  await comServidor(async (base) => {
    await autenticar(base);
    const html = await (await fetch(`${base}/admin/vagas/nova`, { headers: comAuth() })).text();

    assert.match(html, /name="link_meet"/);
    // A coluna continua link_meet, mas o que o WA2 manda nela e o link de CONFIRMAR PRESENCA
    // (Calendly) — o rotulo precisa dizer isso, senao o recrutador cola a sala do Meet.
    assert.match(html, /Link para confirmar presença \(Calendly\)/);
    assert.match(html, /placeholder="https:\/\/calendly\.com\//);
    assert.doesNotMatch(html, /Link da entrevista em grupo \(Google Meet\)/);
    for (const i of [1, 2, 3]) {
      assert.match(
        html,
        new RegExp(`<input type="date" name="entrevista_grupo_${i}_data"`),
        `falta o campo de data da reuniao ${i}`,
      );
      assert.match(
        html,
        new RegExp(`<input type="time" name="entrevista_grupo_${i}_hora"`),
        `falta o campo de horario da reuniao ${i}`,
      );
    }
    // date/time, e nao texto livre: e o que garante 'YYYY-MM-DD' e 'HH:MM' nas colunas.
    assert.doesNotMatch(html, /<input type="text" name="entrevista_grupo_1_data"/);
    // Os slots 2 e 3 sao opcionais por regra de negocio — nada aqui pode ser obrigatorio.
    assert.doesNotMatch(html, /name="entrevista_grupo_\d_(data|hora)"[^>]*required/);
  });
});

test('o formulario de EDICAO reexibe o que esta salvo', async () => {
  await comServidor(async (base) => {
    await autenticar(base);
    const vaga = await criarPeloForm(base, {
      link_meet: LINK,
      entrevista_grupo_1_data: DAQUI_10,
      entrevista_grupo_1_hora: '19:30',
    });

    const html = await htmlDaVaga(base, vaga.id);
    assert.ok(html.includes(`name="link_meet" value="${LINK}"`));
    assert.ok(html.includes(`name="entrevista_grupo_1_data" value="${DAQUI_10}"`));
    assert.ok(html.includes('name="entrevista_grupo_1_hora" value="19:30"'));
  });
});

// ══════════════════ PERSISTENCIA (o buraco da lista literal) ══════════════════

test('criar vaga pelo formulario grava link e os 3 pares no banco', async () => {
  await comServidor(async (base) => {
    await autenticar(base);
    const vaga = await criarPeloForm(base, {
      link_meet: LINK,
      entrevista_grupo_1_data: DAQUI_10,
      entrevista_grupo_1_hora: '19:30',
      entrevista_grupo_2_data: DAQUI_20,
      entrevista_grupo_2_hora: '20:00',
      entrevista_grupo_3_data: DAQUI_30,
      entrevista_grupo_3_hora: '09:15',
    });

    assert.equal(vaga.link_meet, LINK);
    assert.equal(vaga.entrevista_grupo_1_data, DAQUI_10);
    assert.equal(vaga.entrevista_grupo_1_hora, '19:30');
    assert.equal(vaga.entrevista_grupo_2_data, DAQUI_20);
    assert.equal(vaga.entrevista_grupo_2_hora, '20:00');
    assert.equal(vaga.entrevista_grupo_3_data, DAQUI_30);
    assert.equal(vaga.entrevista_grupo_3_hora, '09:15');
  });
});

test('editar vaga pelo formulario grava os 7 campos', async () => {
  await comServidor(async (base) => {
    await autenticar(base);
    const criada = await criarPeloForm(base, {});
    const vaga = await editarPeloForm(base, criada.id, {
      link_meet: LINK,
      entrevista_grupo_1_data: DAQUI_10,
      entrevista_grupo_1_hora: '18:00',
      entrevista_grupo_2_data: DAQUI_20,
      entrevista_grupo_2_hora: '18:30',
    });

    assert.equal(vaga.link_meet, LINK);
    assert.equal(vaga.entrevista_grupo_1_data, DAQUI_10);
    assert.equal(vaga.entrevista_grupo_1_hora, '18:00');
    assert.equal(vaga.entrevista_grupo_2_data, DAQUI_20);
    assert.equal(vaga.entrevista_grupo_2_hora, '18:30');
  });
});

test('campos vazios gravam NULL, e limpar pelo formulario apaga a reuniao', async () => {
  await comServidor(async (base) => {
    await autenticar(base);
    const criada = await criarPeloForm(base, {
      link_meet: LINK,
      entrevista_grupo_1_data: DAQUI_10,
      entrevista_grupo_1_hora: '19:30',
    });
    assert.equal(criada.link_meet, LINK);

    // Reuniao cancelada: limpar os campos e acao valida.
    const vaga = await editarPeloForm(base, criada.id, {
      link_meet: '',
      entrevista_grupo_1_data: '',
      entrevista_grupo_1_hora: '',
    });
    assert.equal(vaga.link_meet, null);
    assert.equal(vaga.entrevista_grupo_1_data, null);
    assert.equal(vaga.entrevista_grupo_1_hora, null);
  });
});

test('salvar a entrevista em grupo nao mexe nos campos vizinhos da vaga', async () => {
  await comServidor(async (base) => {
    await autenticar(base);
    const criada = await criarPeloForm(base, {
      empresa: 'Acme Ltda',
      cidade: 'Joinville',
      horario: 'Segunda a Sexta, 8h as 18h',
      video_intro_ref: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
    });

    const vaga = await editarPeloForm(base, criada.id, {
      empresa: 'Acme Ltda',
      cidade: 'Joinville',
      horario: 'Segunda a Sexta, 8h as 18h',
      video_intro_ref: 'dQw4w9WgXcQ',
      link_meet: LINK,
      entrevista_grupo_1_data: DAQUI_10,
      entrevista_grupo_1_hora: '19:30',
    });

    assert.equal(vaga.empresa, 'Acme Ltda');
    assert.equal(vaga.cidade, 'Joinville');
    assert.equal(vaga.horario, 'Segunda a Sexta, 8h as 18h');
    assert.equal(vaga.video_intro_ref, 'dQw4w9WgXcQ');
    assert.equal(vaga.link_meet, LINK);
  });
});

test('espacos em volta do link e das datas sao removidos no save', async () => {
  await comServidor(async (base) => {
    await autenticar(base);
    const vaga = await criarPeloForm(base, {
      link_meet: `  ${LINK}  `,
      entrevista_grupo_1_data: ` ${DAQUI_10} `,
      entrevista_grupo_1_hora: ' 19:30 ',
    });
    assert.equal(vaga.link_meet, LINK);
    assert.equal(vaga.entrevista_grupo_1_data, DAQUI_10);
    assert.equal(vaga.entrevista_grupo_1_hora, '19:30');
  });
});

// ══════════════════ AVISOS NA TELA (validacao nao-bloqueante) ══════════════════

test('vaga com reuniao futura: a tela diz QUAL reuniao a mensagem esta anunciando', async () => {
  await comServidor(async (base) => {
    await autenticar(base);
    const vaga = await criarPeloForm(base, {
      link_meet: LINK,
      entrevista_grupo_1_data: DAQUI_10,
      entrevista_grupo_1_hora: '19:30',
      entrevista_grupo_2_data: DAQUI_20,
      entrevista_grupo_2_hora: '20:00',
    });

    const html = await htmlDaVaga(base, vaga.id);
    assert.match(html, /Próxima entrevista em grupo/);
    assert.match(html, /Reunião\s*1/);
    assert.match(html, /19:30/);
    // Nenhum aviso de fallback. A frase "datas estão sendo definidas" NAO serve como sonda
    // aqui: ela tambem aparece no texto de ajuda FIXO do campo de link, que esta sempre na
    // pagina. Sondar por ela daria um teste que passa sem testar nada.
    assert.doesNotMatch(html, /nenhuma reunião foi cadastrada|já passaram|falta o link de confirmação/);
  });
});

test('vaga ATIVA sem nada cadastrado: alerta de que ninguem recebe convite', async () => {
  await comServidor(async (base) => {
    await autenticar(base);
    const vaga = await criarPeloForm(base, {});
    const html = await htmlDaVaga(base, vaga.id);

    assert.match(html, /não tem link de confirmação \(Calendly\) nem datas/);
    // O link da vaga e o de CONFIRMAR PRESENCA (Calendly): nenhum aviso pode chamar de Meet.
    assert.doesNotMatch(html, /link do Meet/);
    assert.match(html, /class="aviso-alerta"/);
  });
});

test('vaga ENCERRADA sem nada cadastrado: informativo, nao alerta', async () => {
  // Painel que grita sobre o que nao importa ensina a ignorar os avisos que importam.
  await comServidor(async (base) => {
    await autenticar(base);
    const criada = await criarPeloForm(base, {});
    await fetch(`${base}/admin/vagas/${criada.id}/encerrar`, {
      method: 'POST',
      headers: comAuth(),
      redirect: 'manual',
    });

    const html = await htmlDaVaga(base, criada.id);
    const pos = html.indexOf('não tem link de confirmação (Calendly)');
    assert.ok(pos >= 0, 'aviso de vaga sem link nao apareceu');
    const trecho = html.slice(pos - 200, pos);
    assert.match(trecho, /aviso-ok/, 'em vaga encerrada o aviso nao deve ser alerta');
  });
});

test('datas futuras SEM link do Meet: avisa que sem sala nao ha convite', async () => {
  await comServidor(async (base) => {
    await autenticar(base);
    const vaga = await criarPeloForm(base, {
      entrevista_grupo_1_data: DAQUI_10,
      entrevista_grupo_1_hora: '19:30',
    });

    const html = await htmlDaVaga(base, vaga.id);
    assert.match(html, /falta o link de confirmação \(Calendly\)<\/b> — e sem ele não há convite/);
    assert.doesNotMatch(html, /link do Meet|sem sala/);
    assert.doesNotMatch(html, /Próxima entrevista em grupo/);
  });
});

test('link sem reuniao cadastrada: avisa que a mensagem cai no fallback', async () => {
  await comServidor(async (base) => {
    await autenticar(base);
    const vaga = await criarPeloForm(base, { link_meet: LINK });
    const html = await htmlDaVaga(base, vaga.id);
    assert.match(html, /O link de confirmação \(Calendly\) está preenchido, mas <b>nenhuma reunião foi cadastrada/);
  });
});

test('todas as reunioes no passado: avisa e NAO anuncia nenhuma', async () => {
  await comServidor(async (base) => {
    await autenticar(base);
    const vaga = await criarPeloForm(base, {
      link_meet: LINK,
      entrevista_grupo_1_data: HA_20,
      entrevista_grupo_1_hora: '19:30',
      entrevista_grupo_2_data: HA_10,
      entrevista_grupo_2_hora: '20:00',
    });

    const html = await htmlDaVaga(base, vaga.id);
    assert.match(html, /já passaram/);
    assert.doesNotMatch(html, /Próxima entrevista em grupo/);
  });
});

test('par incompleto: avisa citando a reuniao, e o resto continua valendo', async () => {
  await comServidor(async (base) => {
    await autenticar(base);
    const vaga = await criarPeloForm(base, {
      link_meet: LINK,
      entrevista_grupo_1_data: DAQUI_10,
      entrevista_grupo_1_hora: '19:30',
      entrevista_grupo_2_data: DAQUI_20, // sem horario
    });

    const html = await htmlDaVaga(base, vaga.id);
    assert.match(html, /data sem horário/);
    assert.match(html, /Reunião 2/);
    // O par valido continua sendo anunciado: um campo pela metade nao derruba o resto.
    assert.match(html, /Próxima entrevista em grupo/);
  });
});

test('data invalida: o valor e GRAVADO e a tela o cita (nao desaparece em silencio)', async () => {
  await comServidor(async (base) => {
    await autenticar(base);
    // 31/02 nao existe. <input type="date"> nao deixaria passar no navegador, mas um POST
    // direto (ou um navegador antigo) deixa — e descartar em silencio faria o admin olhar um
    // campo vazio sem saber por que o que ele digitou nao ficou.
    const vaga = await criarPeloForm(base, {
      link_meet: LINK,
      entrevista_grupo_1_data: '2026-02-31',
      entrevista_grupo_1_hora: '10:00',
    });
    assert.equal(vaga.entrevista_grupo_1_data, '2026-02-31');

    const html = await htmlDaVaga(base, vaga.id);
    assert.match(html, /Data ou horário inválidos/);
    assert.ok(html.includes('2026-02-31'));
  });
});

test('reunioes fora de ordem cronologica: avisa, mas nao trava nem erra a mensagem', async () => {
  await comServidor(async (base) => {
    await autenticar(base);
    const vaga = await criarPeloForm(base, {
      link_meet: LINK,
      entrevista_grupo_1_data: DAQUI_30,
      entrevista_grupo_1_hora: '09:15',
      entrevista_grupo_2_data: DAQUI_10,
      entrevista_grupo_2_hora: '19:30',
    });

    const html = await htmlDaVaga(base, vaga.id);
    assert.match(html, /não estão em ordem cronológica/);
    // Continua acertando: a mensagem usa a data mais proxima, que esta no slot 2.
    assert.match(html, /Reunião\s*2/);
  });
});

test('link sem https:// avisa que o WhatsApp nao vai torna-lo clicavel', async () => {
  await comServidor(async (base) => {
    await autenticar(base);
    const vaga = await criarPeloForm(base, {
      link_meet: 'meet.google.com/abc-defg-hij',
      entrevista_grupo_1_data: DAQUI_10,
      entrevista_grupo_1_hora: '19:30',
    });

    const html = await htmlDaVaga(base, vaga.id);
    assert.match(html, /não começa com/);
    // Nao bloqueia: o link foi salvo e a reuniao continua sendo anunciada.
    assert.equal(vaga.link_meet, 'meet.google.com/abc-defg-hij');
    assert.match(html, /Próxima entrevista em grupo/);
  });
});

test('nenhum aviso de entrevista em grupo bloqueia o save dos outros campos', async () => {
  await comServidor(async (base) => {
    await autenticar(base);
    const criada = await criarPeloForm(base, {});
    const vaga = await editarPeloForm(base, criada.id, {
      titulo: 'Titulo Novo',
      empresa: 'Acme Ltda',
      link_meet: 'nao e uma url',
      entrevista_grupo_1_data: '2026-02-31',
      entrevista_grupo_1_hora: '99:99',
    });

    assert.equal(vaga.titulo, 'Titulo Novo');
    assert.equal(vaga.empresa, 'Acme Ltda');
  });
});

// ══════════════════ IMPORTACAO DO DRIVE ══════════════════

test('a extracao por IA NAO pede link do Meet nem datas de reuniao', async () => {
  // Decisao de negocio: briefing raramente traz esses dados, e um link/data INVENTADO manda o
  // candidato para uma reuniao que nao existe — pior que campo vazio, que o admin preenche na
  // revisao. Este teste e o que impede alguem "completar" o shape do prompt depois.
  const { montarMensagensExtracao } = require('../src/lib/importar_vaga');
  const [system] = montarMensagensExtracao('Briefing qualquer');

  assert.doesNotMatch(system.conteudo, /link_meet/);
  assert.doesNotMatch(system.conteudo, /entrevista_grupo/);
  assert.doesNotMatch(system.conteudo, /meet\.google\.com/);
});
