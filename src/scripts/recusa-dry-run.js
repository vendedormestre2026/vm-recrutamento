'use strict';

// Dry-run do e-mail automatico de recusa: mostra QUEM receberia na proxima varredura.
//
// LEITURA PURA. Nao envia e-mail, nao marca email_recusa_enviado_em, nao toca em config.
// Pode rodar a qualquer momento, inclusive em producao, sem efeito nenhum.
//
// Diferenca proposital para a varredura real: aqui NAO aplicamos o teto de
// ENVIOS_POR_CICLO. A varredura manda no maximo 20 por ciclo; este script mostra o
// BACKLOG INTEIRO, que e o numero que importa para decidir se liga o interruptor.
//
// Uso:
//   npm run recusa:dry-run
//
// ONDE RODAR: no container (railway ssh), se o que se quer ver e a producao — a lista sai
// do banco apontado por DATABASE_PATH, e local isso e o ./data/app.db de desenvolvimento.

const { config } = require('../config');
const db = require('../db');
const emailRecusa = require('../lib/emailRecusa');

// Teto alto o bastante para nunca cortar a lista, mas ainda finito (a query exige um
// LIMIT). Se algum dia houver mais que isto de elegiveis, o proprio numero ja e o alerta.
const SEM_TETO = 100000;

function main() {
  const pendentes = db.listarPendentesEmailRecusa({
    horasCarencia: emailRecusa.HORAS_CARENCIA,
    limite: SEM_TETO,
  });

  console.log('──────── recusa: dry-run (nenhum e-mail enviado) ────────');
  console.log(`banco       : ${config.caminhoBanco}`);
  console.log(`interruptor : ${emailRecusa.ativo() ? 'LIGADO' : 'desligado'} (${emailRecusa.CHAVE_ATIVO})`);
  console.log(`carencia    : ${emailRecusa.HORAS_CARENCIA} h apos o relatorio ir ao recrutador`);
  console.log(`teto/ciclo  : ${emailRecusa.ENVIOS_POR_CICLO} (nao aplicado aqui; esta lista e o backlog inteiro)`);
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
      relatorio: p.relatorio_enviado_em || '—',
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
    relatorio: larg('relatorio', 'RELATORIO EM'),
  };

  const linhaFmt = (l) =>
    [
      l.app.padStart(w.app),
      l.nome.padEnd(w.nome),
      l.email.padEnd(w.email),
      l.vaga.padEnd(w.vaga),
      l.relatorio.padEnd(w.relatorio),
    ].join('  |  ');

  console.log(
    linhaFmt({ app: 'APP', nome: 'NOME', email: 'E-MAIL', vaga: 'VAGA', relatorio: 'RELATORIO EM' }),
  );
  console.log('-'.repeat(w.app + w.nome + w.email + w.vaga + w.relatorio + 16));
  for (const l of linhas) console.log(linhaFmt(l));

  console.log('');
  console.log(`TOTAL: ${linhas.length} candidato(s) receberiam o e-mail de recusa.`);
  if (linhas.length > emailRecusa.ENVIOS_POR_CICLO) {
    const ciclos = Math.ceil(linhas.length / emailRecusa.ENVIOS_POR_CICLO);
    console.log(
      `Com o teto de ${emailRecusa.ENVIOS_POR_CICLO}/ciclo, o backlog levaria ${ciclos} varreduras (~${ciclos * 15} min) para drenar.`,
    );
  }
  console.log('─────────────────────────────────────────────────────────');
}

main();
