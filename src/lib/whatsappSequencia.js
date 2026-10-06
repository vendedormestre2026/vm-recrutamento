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
//   WA2  T+15min, CONVITE PARA A ENTREVISTA EM GRUPO no Google Meet. Aqui a acao E o ponto, e
//        a informacao que a pessoa volta para buscar (data, hora, link) precisa estar
//        destacada.
//
// ── O WA2 DEIXOU DE PEDIR VIDEO ──
// Ate aqui o WA2 pedia um video de apresentacao com prazo fixo ("amanha, ao meio-dia"). A
// mensagem passou a convidar para uma entrevista em grupo, e com isso o prazo SAIU do texto:
// nao ha mais nada a cobrar do candidato num prazo.
//
// O fluxo do video NAO foi removido do sistema — as colunas wa2_video_* e a tela de
// confirmacao manual continuam existindo para o historico de quem ja enviou video. O que mudou
// e so o que a mensagem PEDE. Ver o painel em routes/admin.js.
//
// ── DUAS VARIANTES, E POR ISSO montarTextoWA2 NAO DEVOLVE MAIS UMA STRING ──
// O convite so existe quando a vaga tem uma reuniao FUTURA e um link do Meet. Quando nao tem,
// sai um texto alternativo ("estamos definindo as proximas datas") — nunca um link vencido.
// A funcao devolve { texto, variante } porque quem envia precisa GRAVAR qual das duas saiu
// (whatsapp_sequencia_envios.variante): inferir depois, a partir do estado atual da vaga,
// passaria a responder errado no minuto em que a data nova fosse cadastrada — e quem recebeu o
// fallback e justamente quem precisa ser reconvidado a mao.
//
// Uma funcao que devolvesse a string e uma segunda que devolvesse a variante chamariam
// proximaEntrevistaGrupo duas vezes, com dois "agora" diferentes; no limite, o texto e a
// variante gravada discordariam. Uma fonte de verdade so.

const { config } = require('../config');
const { primeiroNomeDe, textoEmpresa, limparEspacos } = require('./whatsapp');
// Qual reuniao anunciar (e se ha alguma). Modulo PURO: recebe a vaga e o "agora", nunca le o
// relogio por conta propria — e o que mantem este arquivo testavel sem esperar uma data passar.
const { proximaEntrevistaGrupo } = require('./entrevistaGrupo');

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
// nao como duas informacoes. So a PRIMEIRA linha leva o rotulo "Faixa de ganhos..." — as
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
  return [`💰 Faixa de ganhos dos melhores vendedores: ${primeira}`, ...resto].join('\n');
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

// ── WA2 — T+15min, convite para a entrevista em grupo ──
//
// SEM saudacao: decisao de negocio mantida do texto anterior (Incremento 11). A saudacao ja
// aconteceu no WA1, minutos antes. `application` fica sem uso (mantido no parametro para o call
// site nao mudar de assinatura quando a copy voltar a usar o nome).
//
// ── O QUE O TEXTO NAO PROMETE ──
// A confirmacao de presenca acontece FORA do sistema: o candidato clica no link (Calendly,
// cadastrado na coluna jobs.link_meet) e deixa o e-mail na agenda; quem manda o convite por
// e-mail e o Calendly, nao este sistema, que nao registra presenca em lugar nenhum. O texto por
// isso nao diz "o sistema registra" nem "sua vaga esta reservada" — prometer o que o sistema nao
// faz e como se perde confianca na primeira vez que nao acontece.
//
// "serao automaticamente desclassificados" e a UNICA excecao, aprovada pelo Rafael: descreve uma
// regra do PROCESSO, aplicada pela equipe a quem falta — nao uma automacao do sistema. O teste
// "WA2 NAO promete automacao que nao existe" libera so essa frase, e nenhuma outra.
const VARIANTE_CONVITE_GRUPO = 'convite_grupo';
const VARIANTE_SEM_REUNIAO = 'sem_reuniao';

// O convite. `proxima` vem de proximaEntrevistaGrupo e JA traz data e hora formatadas no fuso de
// Brasilia — este arquivo nao formata data, e nao conhece Intl.
//
// As tres linhas de dado (data, hora, link) ficam num bloco proprio, cada uma na sua linha e com
// rotulo em negrito: e a parte que a pessoa reabre a mensagem para consultar, e um paragrafo
// corrido obrigaria a garimpar o horario no meio da frase.
//
// O aviso de pontualidade repete o horario pela MESMA proxima.horaTexto da linha "Horário": uma
// segunda fonte (ou um horario escrito a mao) e como as duas linhas passariam a discordar.
function montarTextoConviteGrupo(job, proxima) {
  const linhas = [
    '👇 *CONVITE PARA A ENTREVISTA EM GRUPO* 👇',
    'Queremos convidar você para avançar no processo e participar de uma entrevista em grupo ' +
      `online${trechoVaga(job)}.`,
    '',
    `📅 *Data:* ${proxima.dataTexto}`,
    `⏰ *Horário:* ${proxima.horaTexto} (horário de Brasília)`,
    `🔗 *Link para confirmar presença na entrevista:* ${proxima.linkMeet}`,
    '',
    'A entrevista será realizada através do Google Meet. Certifique-se que você tenha o app ' +
      'instalado em seu celular para não ficar de fora.',
    '',
    'Entre alguns minutos antes, em um lugar tranquilo e com boa internet.',
    '',
    `A reunião iniciará pontualmente às ${proxima.horaTexto} e não teremos tolerância para ` +
      'atrasos. Candidatos que não comparecerem à entrevista serão automaticamente ' +
      'desclassificados do processo seletivo.',
    '',
    'Confirme sua presença clicando no link acima e cadastrando seu email na agenda para ' +
      'receber o convite por email para acessar a entrevista no dia e horário marcados. Se ' +
      'tiver alguma dúvida pontual sobre a vaga, pode me perguntar. Até lá e boa sorte! 🚀',
  ];
  return linhas.map((l) => limparEspacos(l)).join('\n');
}

// O fallback: vaga sem reuniao futura, ou sem link do Meet.
//
// ── POR QUE MANDAR ALGO, EM VEZ DE NAO MANDAR ──
// O WA1 termina com "te mando o proximo passo", minutos antes. Silencio depois disso le como
// processo abandonado. O fallback diz a verdade (as datas estao sendo definidas) sem inventar
// prazo — e SEM o cabecalho 👇 do convite, de proposito: vestir de convite uma mensagem que nao
// tem data frustra quem a abre esperando uma.
//
// ⚠️ O aviso prometido aqui e MANUAL. Nada reenvia o convite quando a data nova e cadastrada;
// quem recebeu esta variante precisa ser reconvidado a mao, e e por isso que a variante fica
// gravada na fila e aparece na ficha do candidato (routes/admin.js).
function montarTextoSemReuniao(job) {
  const linhas = [
    `Estamos definindo as próximas datas das entrevistas em grupo${trechoVaga(job)}. ` +
      'Assim que a data for confirmada, te aviso por aqui com o link da reunião. 🚀',
  ];
  return linhas.map((l) => limparEspacos(l)).join('\n');
}

// Devolve { texto, variante } — ver a nota do cabecalho sobre por que nao e mais uma string.
//
// `agora` e PARAMETRO (default no relogio so para o call site de producao): e o que permite um
// teste provar que a reuniao 1, vencida, cede a vez para a 2 sem esperar uma semana.
function montarTextoWA2(application, job, agora = new Date()) {
  const proxima = proximaEntrevistaGrupo(job, agora);
  if (!proxima) {
    return { texto: montarTextoSemReuniao(job), variante: VARIANTE_SEM_REUNIAO };
  }
  return { texto: montarTextoConviteGrupo(job, proxima), variante: VARIANTE_CONVITE_GRUPO };
}

// ── REPROVACAO — corpo base sempre presente + convite condicional (ETAPA B) ──
//
// Terceira etapa da fila Baileys (alem de wa1/wa2, ver whatsapp/sequenciaOutbox.js),
// disparada quando o recrutador marca status_recrutador='reprovado' (lib/decisaoRecrutador.js).
//
// ⚠️ COPY AINDA NAO APROVADA PELO RAFAEL — os dois textos abaixo sao PLACEHOLDER, de
// proposito faceis de achar (grep por PLACEHOLDER) e substituir quando a copy definitiva
// chegar. NAO e o texto que deve sair em producao.
//
// TODO: copy final pendente de aprovação do Rafael.
const TEXTO_REPROVACAO_BASE_PLACEHOLDER =
  '[PLACEHOLDER] Agradecemos sua candidatura e o tempo dedicado ao nosso processo seletivo. ' +
  'Neste momento optamos por seguir com outros candidatos. (copy final pendente de aprovação)';

// {{link_grupo}} e substituido pelo link real dentro de montarTextoReprovacao — nunca
// aparece literal na mensagem que sai. So entra na mensagem quando ha link cadastrado para
// a cidade da vaga (ver textoDaEtapa em sequenciaOutbox.js, que resolve o link NO MOMENTO
// DO ENVIO e so passa linkGrupo truthy quando ha um).
const TEXTO_REPROVACAO_CONVITE_PLACEHOLDER =
  '[PLACEHOLDER] Enquanto isso, convidamos você a entrar no nosso grupo de alertas de vagas ' +
  'da sua região: {{link_grupo}} (copy final pendente de aprovação)';

// Monta o texto da reprovacao: corpo base SEMPRE presente + paragrafo de convite SOMENTE
// quando `linkGrupo` e truthy (vaga remota sem cidade, ou cidade sem link cadastrado, caem
// no MESMO caso — corpo base sozinho, sem distincao entre os dois motivos).
//
// `job` fica sem uso real por enquanto — os placeholders nao interpolam nada da vaga.
// Mantido no parametro (mesma razao de montarTextoWA2, acima): a copy final deve usar
// dados da vaga (ex.: titulo), e o call site nao precisa mudar quando ela chegar.
function montarTextoReprovacao(job, linkGrupo) {
  const linhas = [TEXTO_REPROVACAO_BASE_PLACEHOLDER];
  if (linkGrupo) {
    linhas.push('');
    linhas.push(TEXTO_REPROVACAO_CONVITE_PLACEHOLDER.replace('{{link_grupo}}', linkGrupo));
  }
  return linhas.map((l) => limparEspacos(l)).join('\n');
}

module.exports = {
  montarTextoWA1,
  montarTextoWA2,
  montarTextoConviteGrupo,
  montarTextoSemReuniao,
  VARIANTE_CONVITE_GRUPO,
  VARIANTE_SEM_REUNIAO,
  montarTextoReprovacao,
  TEXTO_REPROVACAO_BASE_PLACEHOLDER,
  TEXTO_REPROVACAO_CONVITE_PLACEHOLDER,
  // Exportados para teste e para quem precisar do mesmo formato em outro lugar.
  saudacao,
  trechoVaga,
  linhaRemuneracao,
  linhaLocalidade,
  linkVaga,
};
