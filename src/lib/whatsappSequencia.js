'use strict';

// Textos da sequencia WA1/WA2. Funcoes PURAS: sem banco, sem rede, sem relogio.
//
// Irmao de lib/whatsapp.js, e de proposito no mesmo estilo — os helpers de borda dali
// (primeiro nome, omissao de empresa, limpeza de espacos) sao reusados por IMPORTACAO e nao
// recopiados. Uma segunda regra de "como omitir empresa" seria a garantia de que as duas
// divergiriam no dia em que uma fosse ajustada.
//
// ── AS DUAS MENSAGENS TEM NATUREZAS DIFERENTES ──
//   WA1  T+0. Resume a vaga (remuneracao, localidade, link) e termina com uma pergunta de
//        engajamento — a resposta e a prova de que a pessoa leu. Ainda NAO pede o video: uma
//        mensagem automatica que chega junto com o cadastro e ja cobra algo soa como robo de
//        cobranca, e o custo disso e a pessoa sair do processo antes de comecar.
//   WA2  T+15min, pede o video. Aqui a acao E o ponto, e o prazo tem que estar no texto: pedir
//        "o quanto antes" produz resposta em prazo indefinido e ninguem tem base para cobrar
//        depois.
//
// ── O PRAZO E FRASE FIXA, e nao mais parametro ──
// Decisao de negocio: o prazo do video no texto e sempre "amanhã, ao meio-dia" (horario de
// Brasilia). Isso so e seguro porque o WA2 sai 15 MINUTOS depois da candidatura (ver
// WA2_ATRASO_MINUTOS em whatsapp/sequenciaOutbox.js) — "amanha" bate com a realidade em
// qualquer candidatura, sempre. A data exata para o painel comparar "chegou dentro do prazo?"
// e calculada em lib/whatsappFicha.js (calcularPrazoAmanhaMeioDia), separado deste texto.

const { config } = require('../config');
const { primeiroNomeDe, textoEmpresa, limparEspacos } = require('./whatsapp');

// Saudacao com ou sem nome. Duas variantes de FRASE INTEIRA, e nao um placeholder que fica
// vazio: "Olá , tudo bem?" e o tipo de detalhe que denuncia automacao mal-feita, e a
// primeira mensagem do processo e onde isso custa mais caro.
function saudacao(nome) {
  const primeiro = primeiroNomeDe(nome);
  return primeiro ? `Olá, ${primeiro}!` : 'Olá!';
}

// Trecho " para a vaga de X" / " para a vaga de X na EMPRESA", montado conforme o que existe.
//
// A regra de omissao segue lib/whatsapp: sem empresa, o trecho dela some inteiro (nao vira
// "na "); sem vaga, TUDO some — empresa sozinha, sem a vaga que ela qualifica, produziria
// "sua candidatura na Acme", que é vago o suficiente para a pessoa nao saber do que se trata.
function trechoVaga(job) {
  const vaga = String((job && job.titulo) || '').trim();
  if (!vaga) return '';
  const empresa = textoEmpresa(job && job.empresa);
  return empresa ? ` para a vaga de ${vaga} na ${empresa}` : ` para a vaga de ${vaga}`;
}

// Primeira letra maiuscula. Mesmo padrao de lib/ctaCampanha.js.
function capitalizar(s) {
  const t = String(s == null ? '' : s).trim();
  return t ? t.charAt(0).toUpperCase() + t.slice(1) : '';
}

// 💰 linha de remuneracao: potencial_ganhos tem prioridade sobre faixa_pagamento (mesma
// ordem que a pagina publica da vaga usa). Omite a linha inteira se nenhum dos dois existir.
//
// Multi-linha (mesmo padrao de linhaLocalidade): o Jean cadastra potencial_ganhos como
// varias linhas ("R$ 6.500+/mês" / "Vendedores experientes:" / "R$ 8.000 a R$ 13.000+/mês"),
// separadas por \r\n no banco. Amassar isso numa frase corrida (o que limparEspacos faria
// se a string chegasse com '\n' embutido, sem passar por split antes) lê como uma frase so,
// nao como duas informacoes. So a PRIMEIRA linha leva o rotulo "Média de ganhos..." — as
// demais sao continuacao do mesmo dado, nao precisam repetir o emoji/rotulo.
function linhaRemuneracao(job) {
  const bruto =
    String((job && job.potencial_ganhos) || '').trim() ||
    String((job && job.faixa_pagamento) || '').trim();
  if (!bruto) return null;
  const linhasValor = bruto
    .split(/\r\n|\r|\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  if (!linhasValor.length) return null;
  const [primeira, ...resto] = linhasValor;
  return [`💰 Média de ganhos dos melhores vendedores: ${primeira}`, ...resto].join('\n');
}

// 📍 localidade, 🏢 modalidade e 📄 regime — uma linha por dado, cada uma omite
// independente se faltar. Local: endereco tem prioridade sobre cidade (mais especifico).
//
// Multi-linha (junta com '\n', e nao mais ' · '): devolve varias linhas de uma vez, e quem
// chama (montarTextoWA1) precisa espalhar cada uma no array `linhas` ANTES de limparEspacos —
// senao o '\n' embutido colide com o `\s{2,}` que a funcao colapsa para espaco unico.
function linhaLocalidade(job) {
  const localidade = String((job && job.endereco) || (job && job.cidade) || '').trim();
  const modalidade = String((job && job.modalidade) || '').trim();
  const regime = String((job && job.regime) || '').trim();
  const partes = [];
  if (localidade) partes.push(`📍 ${localidade}`);
  if (modalidade) partes.push(`🏢 ${capitalizar(modalidade)}`);
  if (regime) partes.push(`📄 ${regime}`);
  return partes.length ? partes.join('\n') : null;
}

// Link de volta pra pagina de CONFIRMACAO da vaga (/vaga/:slug/confirmacao), a partir do
// slug. '' se nao houver slug.
//
// NAO e a pagina publica /vaga/:slug (essa tem o CTA "Aplicar"): quem recebe o WA1 JA se
// candidatou, e mandar de volta pra tela de aplicar seria confuso e reabriria um formulario
// que nao faz mais sentido pra essa pessoa. A rota /confirmacao mostra o mesmo conteudo da
// vaga, mas termina em "Voltar para o WhatsApp" (routes/pages.js).
//
// SEM utm: decisao de negocio. Quem recebe o WA1 JA se candidatou — nao ha cadastro a
// atribuir, diferente do link da campanha em massa (lib/ctaCampanha.js#montarUrlVaga), que
// existe justamente para atribuir clique a campanha.
function linkVaga(job) {
  const slug = String((job && job.slug) || '').trim();
  return slug ? `${config.baseUrl}/vaga/${encodeURIComponent(slug)}/confirmacao` : '';
}

// "Recebemos sua candidatura para *TITULO* na *EMPRESA*." — o negrito e a marcacao de
// enfase do WhatsApp (asterisco). Mesma regra de omissao de trechoVaga (sem vaga, a frase
// vira generica; sem empresa, so ela some), so que embutida aqui porque o texto e outro
// (negrito, pontuacao propria) e nao reaproveita aquele helper.
function linhaCandidatura(job) {
  const vaga = String((job && job.titulo) || '').trim();
  if (!vaga) return 'Recebemos sua candidatura. Ela já está com o nosso time.';
  const empresa = textoEmpresa(job && job.empresa);
  const alvo = empresa ? `*${vaga}* na *${empresa}*` : `*${vaga}*`;
  return `Recebemos sua candidatura para ${alvo}. Ela já está com o nosso time.`;
}

// ── WA1 — T+0, resumo dinamico da vaga + pergunta de engajamento ──
//
// Cada linha dinamica (remuneracao, localidade, link) some por inteiro quando o dado nao
// existe, e o espaco em branco que ela deixaria some junto — nunca um bloco em branco duplo
// no lugar de uma linha que faltou.
function montarTextoWA1(application, job) {
  const linhas = [
    `${saudacao(application && application.nome)} Aqui é da Vendedor Mestre.`,
    '',
    linhaCandidatura(job),
  ];

  const remuneracao = linhaRemuneracao(job);
  const localidade = linhaLocalidade(job);
  if (remuneracao || localidade) {
    linhas.push('');
    // Ambas podem devolver varias linhas juntas por '\n' — espalha cada uma no array ANTES
    // de limparEspacos rodar por cima (senao o '\n' embutido seria tratado como espaco e
    // colapsado).
    if (remuneracao) linhas.push(...remuneracao.split('\n'));
    if (localidade) linhas.push(...localidade.split('\n'));
  }

  const link = linkVaga(job);
  if (link) {
    linhas.push('');
    linhas.push(`Para ver mais detalhes da vaga, acesse a página oficial dela aqui: ${link}`);
  }

  linhas.push('');
  linhas.push('A oportunidade faz sentido pra você? Se sim, te mando o próximo passo. 🙂');

  return linhas.map((l) => limparEspacos(l)).join('\n');
}

// ── WA2 — T+15min, pede o video de apresentacao ──
//
// Abertura e as duas primeiras perguntas sao FIXAS: genericas o bastante pra servir qualquer
// perfil de vendas. So a 3a pergunta muda, e reaproveita trechoVaga — a mesma regra de
// omissao de sempre, e nao uma segunda copia dela.
//
// A confirmacao e 100% humana (o recrutador marca no painel), entao o texto NAO promete
// nenhuma automacao — nada de "responda com o video e o sistema registra". Prometer o que o
// sistema nao faz e como se perde confianca na primeira vez que nao acontece.
function montarTextoWA2(application, job) {
  const linhas = [
    `${saudacao(application && application.nome)} Aqui é da Vendedor Mestre de novo.`,
    '',
    '👇 *COMO PARTICIPAR DO PROCESSO SELETIVO* 👇',
    'Se você tem o perfil que buscamos, seu primeiro desafio começa agora. Quero avaliar sua ' +
      'comunicação, energia e capacidade de gerar conexão.',
    '',
    'Grave um vídeo simples pelo celular, de 1 a 2 minutos, respondendo a 3 perguntas:',
    '1️⃣ Quem é você?',
    '2️⃣ Qual é a sua maior ambição e meta de vida?',
    `3️⃣ Por que você é a pessoa certa${trechoVaga(job)}?`,
    '',
    '⏰ *PRAZO*: envie o vídeo aqui mesmo no WhatsApp até amanhã, ao meio-dia.',
    '',
    'Se tiver alguma dúvida pontual sobre a vaga, pode me perguntar. Aguardo seu vídeo e boa ' +
      'sorte! 🚀',
  ];
  return linhas.map((l) => limparEspacos(l)).join('\n');
}

module.exports = {
  montarTextoWA1,
  montarTextoWA2,
  // Exportados para teste e para quem precisar do mesmo formato em outro lugar.
  saudacao,
  trechoVaga,
  linhaRemuneracao,
  linhaLocalidade,
  linkVaga,
};
