'use strict';

// Dry-run do lembrete de inicio de entrevista: mostra QUEM receberia na proxima varredura.
//
// LEITURA PURA. Nao envia e-mail, nao marca lembrete_inicio_enviado_em, nao toca em
// config. Pode rodar a qualquer momento, inclusive em producao, sem efeito nenhum.
//
// Diferenca proposital para a varredura real: aqui NAO aplicamos o teto de
// ENVIOS_POR_CICLO. A varredura manda no maximo 20 por ciclo; este script mostra o
// BACKLOG INTEIRO, que e o numero que importa para decidir se liga o interruptor.
//
// Uso:
//   npm run lembrete:dry-run
//
// ONDE RODAR: no container (railway ssh), se o que se quer ver e a producao — a lista sai
// do banco apontado por DATABASE_PATH, e local isso e o ./data/app.db de desenvolvimento.

const { config } = require('../config');
const db = require('../db');
const lembreteInicio = require('../lib/lembreteInicio');

// Teto alto o bastante para nunca cortar a lista, mas ainda finito (a query exige um
// LIMIT). Se algum dia houver mais que isto de elegiveis, o proprio numero ja e o alerta.
const SEM_TETO = 100000;

function main() {
  const pendentes = db.listarPendentesLembreteInicio({
    horasEspera: lembreteInicio.HORAS_ESPERA_LEMBRETE,
    limite: SEM_TETO,
  });

  console.log('──────── lembrete de inicio: dry-run (nenhum e-mail enviado) ────────');
  console.log(`banco       : ${config.caminhoBanco}`);
  console.log(`interruptor : ${lembreteInicio.ativo() ? 'LIGADO' : 'desligado'} (${lembreteInicio.CHAVE_ATIVO})`);
  console.log(`espera      : ${lembreteInicio.HORAS_ESPERA_LEMBRETE} h apos a candidatura`);
  console.log(`teto/ciclo  : ${lembreteInicio.ENVIOS_POR_CICLO} (nao aplicado aqui; esta lista e o backlog inteiro)`);
  console.log('');

  if (!pendentes.length) {
    console.log('Nenhum candidato elegivel.');
    return;
  }

  const linhas = pendentes.map((p) => {
    const vaga = p.job_id ? db.obterVaga(p.job_id) : null;
    return {
      app: String(p.id),
      nome: [p.nome, p.sobrenome].filter(Boolean).join(' ').trim() || '(sem nome)',
      email: p.email || '(sem e-mail)',
      vaga: (vaga && vaga.titulo) || '(vaga nao encontrada)',
      candidatura: p.criado_em || '—',
    };
  });

  // Larguras calculadas a partir do conteudo, para a tabela nao truncar nome/e-mail.
  const larg = (campo, rotulo) =>
    Math.max(rotulo.length, ...linhas.map((l) => l[campo].length));
  const w = {
    app: larg('app', 'APP'),
    nome: larg('nome', 'NOME'),
    email: larg('email', 'E-MAIL'),
    vaga: larg('vaga', 'VAGA'),
    candidatura: larg('candidatura', 'CANDIDATOU-SE EM'),
  };

  const linhaFmt = (l) =>
    [
      l.app.padStart(w.app),
      l.nome.padEnd(w.nome),
      l.email.padEnd(w.email),
      l.vaga.padEnd(w.vaga),
      l.candidatura.padEnd(w.candidatura),
    ].join('  |  ');

  console.log(
    linhaFmt({ app: 'APP', nome: 'NOME', email: 'E-MAIL', vaga: 'VAGA', candidatura: 'CANDIDATOU-SE EM' }),
  );
  console.log('-'.repeat(w.app + w.nome + w.email + w.vaga + w.candidatura + 16));
  for (const l of linhas) console.log(linhaFmt(l));

  // Quantos por vaga: ajuda a ver se o backlog esta concentrado em alguma delas.
  const porVaga = linhas.reduce((acc, l) => {
    acc[l.vaga] = (acc[l.vaga] || 0) + 1;
    return acc;
  }, {});

  console.log('');
  console.log('POR VAGA:');
  for (const [vaga, n] of Object.entries(porVaga).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${String(n).padStart(4)}  ${vaga}`);
  }

  console.log('');
  console.log(`TOTAL: ${linhas.length} candidato(s) receberiam o lembrete.`);
  if (linhas.length > lembreteInicio.ENVIOS_POR_CICLO) {
    const ciclos = Math.ceil(linhas.length / lembreteInicio.ENVIOS_POR_CICLO);
    console.log(
      `Com o teto de ${lembreteInicio.ENVIOS_POR_CICLO}/ciclo, o backlog levaria ${ciclos} varreduras (~${ciclos * 15} min) para drenar.`,
    );
  }
  console.log('──────────────────────────────────────────────────────────────────────');
}

main();
