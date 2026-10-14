'use strict';

// Fixture: o texto-base REAL da campanha 9 (um lembrete, nao um convite) e sete redacoes
// legitimas dele — o que um LLM bem comportado devolveria. Usado como resposta dos dubles de LLM
// nos testes da geracao e das rotas. Cada redacao mantem os quatro tokens, o link da sala por
// extenso, o horario e a chamada para acao, e passa o validador contra o texto-base.

const URL_SALA = 'https://meet.google.com/qeu-emje-txh?pli=1';

const BASE_LEMBRETE = [
  '{saudacao} Aqui é o {recrutador}, da *Vendedor Mestre*.',
  '',
  'Estou passando aqui só pra lembrar que a entrevista ONLINE em grupo para a vaga *{vaga}* na *{empresa}* é daqui a pouco às 14h. Já tem o link da entrevista? Se não, então salva o meu contato e salva o link abaixo:',
  '',
  `🔗 Link direto para entrevista às 14h: ${URL_SALA}`,
  '',
  'A entrevista acontece pelo Google Meet. Te espero lá.',
].join('\n');

const REDACOES_LEMBRETE = Object.freeze([
  [
    '{saudacao} Quem fala é o {recrutador}, da *Vendedor Mestre*. 😊',
    '',
    'Só um lembrete rápido: hoje, às 14h, tem a nossa entrevista ONLINE em grupo da vaga *{vaga}* na *{empresa}*, e já está chegando a hora. Ainda não tem o link? Guarde meu número e anote o endereço da sala:',
    '',
    `👉 Sala da entrevista das 14h: ${URL_SALA}`,
    '',
    'Vai ser pelo Google Meet. Até daqui a pouco!',
  ].join('\n'),
  [
    '{saudacao} {recrutador} aqui, da *Vendedor Mestre*!',
    '',
    'Passando para avisar: falta pouco para a entrevista em grupo ONLINE de *{vaga}*, na *{empresa}*. Começa às 14h. Se você ainda não pegou o link, salve este contato e deixe o endereço guardado:',
    '',
    `📌 Entrada da entrevista (14h): ${URL_SALA}`,
    '',
    'É tudo pelo Google Meet. Conto com você!',
  ].join('\n'),
  [
    '{saudacao} Tudo certo? Sou o {recrutador}, da *Vendedor Mestre*.',
    '',
    'Daqui a pouquinho, às 14h, acontece a entrevista ONLINE em grupo para *{vaga}* na *{empresa}*. Caso esteja sem o link, grave meu número na agenda e guarde o acesso que mando aqui embaixo:',
    '',
    `➡️ Acesso direto às 14h: ${URL_SALA}`,
    '',
    'Usaremos o Google Meet. Nos vemos lá!',
  ].join('\n'),
  [
    '{saudacao} É o {recrutador}, da *Vendedor Mestre*, de novo por aqui.',
    '',
    'Lembrete importante: a entrevista em grupo (ONLINE) da vaga *{vaga}* na *{empresa}* está marcada para as 14h, ou seja, já já. Não recebeu o link? Então adicione este número e mantenha este endereço à mão:',
    '',
    `🔗 Entrevista das 14h, link direto: ${URL_SALA}`,
    '',
    'A conversa será no Google Meet. Espero você!',
  ].join('\n'),
  [
    '{saudacao} Aqui quem escreve é o {recrutador} (*Vendedor Mestre*).',
    '',
    'Faltam poucos minutos para as 14h, horário da entrevista ONLINE em grupo de *{vaga}* na *{empresa}*. Se o link ainda não chegou para você, vale salvar meu contato e copiar o endereço que segue:',
    '',
    `🕑 Link para entrar às 14h: ${URL_SALA}`,
    '',
    'Acontece no Google Meet, combinado? Te encontro lá.',
  ].join('\n'),
  [
    '{saudacao} Oi de novo! {recrutador}, da *Vendedor Mestre*.',
    '',
    'A entrevista em grupo online da vaga *{vaga}* (*{empresa}*) começa logo mais, às 14h. Ficou sem o link? Sem problema: registre este número nos seus contatos e guarde o caminho da sala:',
    '',
    `💻 Sala das 14h: ${URL_SALA}`,
    '',
    'O encontro é no Google Meet. Aguardo você por lá!',
  ].join('\n'),
  [
    '{saudacao} Escrevo rapidinho: sou o {recrutador}, da *Vendedor Mestre*.',
    '',
    'Hoje às 14h é a entrevista ONLINE em grupo para a vaga *{vaga}* na *{empresa}*, e o horário está bem próximo. Você já tem o acesso? Se não tiver, salva meu número e fica com o link logo abaixo:',
    '',
    `✅ Link da entrevista, 14h em ponto: ${URL_SALA}`,
    '',
    'Vamos nos falar pelo Google Meet. Até já!',
  ].join('\n'),
]);

module.exports = { BASE_LEMBRETE, REDACOES_LEMBRETE, URL_SALA };
