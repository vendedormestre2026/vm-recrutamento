'use strict';

// As 7 variacoes do disparo em massa: tokens, seed, validacao, sorteio e resolucao.
//
// Funcoes PURAS — sem banco, sem rede, sem relogio, sem Math.random escondido (quem sorteia
// recebe a fonte de aleatoriedade por parametro). E o que torna o worker testavel de verdade.
//
// ══════════════════════════════════════════════════════════════
// POR QUE EXISTEM 7 TEXTOS PARA A MESMA MENSAGEM
// ══════════════════════════════════════════════════════════════
//
// Enviar a MESMA string para centenas de pessoas e um dos padroes que o WhatsApp usa para
// identificar automacao. Sete redacoes diferentes, sorteadas por destinatario, quebram esse
// padrao sem mudar o CONTEUDO: todas dizem a mesma coisa, com os mesmos dados (vaga, empresa,
// data, horario, link) e o mesmo link de descadastro.
//
// ⚠️ ISSO NAO E A PRINCIPAL PROTECAO ANTI-BLOQUEIO, e nao deve ser tratado como se fosse. O que
// mais pesa e (1) o volume e a rampa, (2) mandar so para quem deu o numero esperando contato —
// candidato de vaga ABERTA (ver lib/publicoMassaWhatsapp) — e (3) a taxa de resposta/denuncia.
// As variacoes ajudam na margem; o recorte do publico e o que evita o bloqueio.
//
// ══════════════════════════════════════════════════════════════
// OS TOKENS
// ══════════════════════════════════════════════════════════════
//
// Chave UNICA entre chaves simples: {saudacao}, {vaga}, {empresa}, {data}, {horario},
// {link_meet}, {link_descadastro}, {recrutador}. NAO usamos {{duplo}} — o duplo e a convencao dos templates da Meta
// (lib/templatesWhatsapp), e reaproveitar a mesma sintaxe em dois subsistemas que nao se falam
// convidaria alguem a colar um texto de um no outro.
//
// Cada token resolve a partir de UMA fonte, e nenhuma delas e inventada aqui:
//   {saudacao}    lib/whatsappSequencia.saudacao(nome) — "Olá, Maria!" ou "Olá!". Frase INTEIRA
//                 nas duas formas, nunca um placeholder que fica vazio ("Olá , tudo bem?" e o
//                 detalhe que denuncia automacao mal-feita).
//   {vaga}        jobs.titulo
//   {empresa}     lib/whatsapp.textoEmpresa(jobs.empresa)
//   {data}        proximaEntrevistaGrupo(vaga, agora).dataTexto   ("quinta-feira, 01/10/2026")
//   {horario}     proximaEntrevistaGrupo(vaga, agora).horaTexto   ("19:30")
//   {link_meet}   proximaEntrevistaGrupo(vaga, agora).linkMeet
//   {recrutador}  primeiro nome do "Nome do recrutador" de /admin/config (chave recrutador_nome,
//                 fallback lib/whatsapp.RECRUTADOR_PADRAO) — ver recrutadorDe. E quem assina a
//                 mensagem: "aqui é o Jean, da Vendedor Mestre".
//   {link_descadastro}  lib/descadastroWhatsapp.montarUrlDescadastroWhatsapp(telefone) — o MESMO
//                 link /descadastro-whatsapp/<token> que vai no botao das campanhas via API. Um
//                 por destinatario (o token e funcao do telefone), montado por quem envia.
//
// Os tres ultimos vem da MESMA chamada, no MOMENTO DO ENVIO: congelar data e link na
// materializacao faria uma campanha de tres dias anunciar, no segundo dia, uma reuniao que
// passou. Ver lib/entrevistaGrupo.

const { saudacao } = require('./whatsappSequencia');
const { textoEmpresa, primeiroNomeDe, RECRUTADOR_PADRAO } = require('./whatsapp');
const { normalizarTextoBase, hashTextoBase } = require('./hashTextoBase');
const { MARCA_INICIO, MARCA_FIM } = require('./formatoWhatsapp');

// Tokens reconhecidos. Ordem estavel (usada em mensagem de erro e na tela de ajuda).
const TOKENS = Object.freeze([
  'saudacao', 'recrutador', 'vaga', 'empresa', 'data', 'horario', 'link_meet', 'link_descadastro',
]);

// Tokens que nao podem ficar VAZIOS no envio (resolverTexto: usado e sem valor -> `faltando`, e o
// item nao sai). Ate 2026-10-14 esta era tambem a lista que TODA variacao do convite de entrevista
// precisava conter; desde a decisao D2 (ver "O TEXTO-BASE E A FONTE DA VERDADE", abaixo) o que a
// variacao do tipo entrevista precisa conter e o que o TEXTO-BASE da campanha contem. A lista
// continua valendo inteira para o segmento (OBRIGATORIOS_POR_TIPO) e para o envio.
//
// {saudacao} fica de fora de proposito: uma variacao pode legitimamente comecar sem cumprimentar.
// Os demais, nao — sem eles a mensagem deixa de ser um convite (some a data, o horario ou a sala),
// deixa de dizer do que se trata (some a vaga ou a empresa) ou deixa de dizer QUEM escreve (some o
// {recrutador}: mensagem de numero desconhecido sem se apresentar e o que vira denuncia).
//
// {link_descadastro} tambem e obrigatorio, e por isso esta aqui: resolverTexto recusa (e o worker
// NAO envia) quando o link nao pode ser montado. Mensagem de massa sem caminho de saida nao sai.
// No validador ele ganha problema proprio (PROBLEMA_SEM_DESCADASTRO), para a tela dizer isso
// com todas as letras em vez de listar mais um token.
//
// ── POR QUE LINK, E NAO "RESPONDA SAIR" ──
// A primeira versao pedia a palavra SAIR na mensagem. Nao foi pedido automacao por palavra-chave:
// o descadastro das campanhas e o link /descadastro-whatsapp, igual ao das campanhas via API.
const TOKEN_DESCADASTRO = 'link_descadastro';
const TOKENS_OBRIGATORIOS = Object.freeze([
  'recrutador', 'vaga', 'empresa', 'data', 'horario', 'link_meet', TOKEN_DESCADASTRO,
]);

// ══════════════════════════════════════════════════════════════
// TIPOS DE CAMPANHA (2026-10-09)
// ══════════════════════════════════════════════════════════════
//
// Ate o segmento da base, havia UM tipo de mensagem: o convite para a entrevista em grupo de quem
// JA se candidatou a vaga (TOKENS / TOKENS_OBRIGATORIOS acima, que continuam sendo o padrao e nao
// mudam). O segmento convida quem NUNCA se candidatou a vaga-alvo: nao ha reuniao marcada para
// essa pessoa, e o que a mensagem leva e o LINK DA VAGA, para ela se candidatar.
//
// O tipo NAO e coluna: ele DERIVA da fonte do publico (criterios_json.fonte, ver tipoPorFonte).
// Uma campanha nao pode ter publico de segmento e texto de entrevista, nem o contrario — e isso
// so e garantido se as duas coisas forem a mesma escolha.
//
// {cidade} entra no convite para a mensagem dizer de ONDE a pessoa nos conhece ("voce se
// candidatou a uma vaga nossa em Joinville"). E obrigatorio: e a frase que separa este convite de
// um disparo frio, e a decisao 5 pede que toda variacao a tenha.
const TIPO_ENTREVISTA_GRUPO = 'entrevista_grupo';
const TIPO_CONVITE_CANDIDATURA = 'convite_candidatura';
const TOKENS_POR_TIPO = Object.freeze({
  [TIPO_ENTREVISTA_GRUPO]: TOKENS,
  [TIPO_CONVITE_CANDIDATURA]: Object.freeze([
    'saudacao', 'recrutador', 'vaga', 'empresa', 'cidade', 'link_vaga', TOKEN_DESCADASTRO,
  ]),
});
const OBRIGATORIOS_POR_TIPO = Object.freeze({
  [TIPO_ENTREVISTA_GRUPO]: TOKENS_OBRIGATORIOS,
  [TIPO_CONVITE_CANDIDATURA]: Object.freeze([
    'recrutador', 'vaga', 'empresa', 'cidade', 'link_vaga', TOKEN_DESCADASTRO,
  ]),
});

// Tipo desconhecido LANCA: validar contra "o padrao" um texto de um tipo que ninguem conhece
// aprovaria tokens que o envio nao sabe preencher.
function tokensDoTipo(tipo = TIPO_ENTREVISTA_GRUPO) {
  const t = TOKENS_POR_TIPO[tipo];
  if (!t) throw new Error(`Tipo de variacao desconhecido: "${tipo}".`);
  return { tokens: t, obrigatorios: OBRIGATORIOS_POR_TIPO[tipo] };
}

// criterios_json.fonte -> tipo. Sem fonte (todas as campanhas anteriores) = entrevista em grupo.
function tipoPorFonte(fonte) {
  return fonte === 'segmento' ? TIPO_CONVITE_CANDIDATURA : TIPO_ENTREVISTA_GRUPO;
}

// Teto de caracteres. O limite do WhatsApp e ~4096; 1200 e uma regra NOSSA, de negocio: uma
// mensagem de divulgacao que passa disso vira parede de texto e nao e lida. As seeds abaixo tem
// ~530 a ~650.
const MAX_CARACTERES = 1200;

// Quantas variacoes a campanha precisa ter para poder disparar.
const TOTAL_VARIACOES = 7;

// ══════════════════════════════════════════════════════════════
// SEED — texto base e as 7 variacoes iniciais
// ══════════════════════════════════════════════════════════════
//
// Fornecidos pelo Rafael e usados como PONTO DE PARTIDA: ficam editaveis no admin, e o que vale
// no envio e sempre o que esta gravado em campanhas_massa_wa_variacoes.
//
// ── FORMATACAO DO WHATSAPP ──
// Paragrafos curtos (linha em branco entre eles) e *negrito* do WhatsApp no que o candidato
// precisa achar de relance: vaga, empresa, data e horario. O link fica FORA do negrito — asterisco
// colado numa URL pode quebrar a deteccao do link no aparelho. Sem _italico_: o token do link de
// descadastro e base64url e pode conter "_".
//
// As sete mudam a ESTRUTURA, nao so as palavras (lista com emoji, rotulos "Quando/Onde", marcador,
// frase corrida): sete textos com o mesmo esqueleto e so sinonimos trocados continuam parecendo o
// mesmo texto. Todas abrem com a apresentacao de quem escreve ({recrutador}, da Vendedor Mestre,
// empresa de recrutamento) e dizem o CARGO com essa palavra. Cada uma fecha o descadastro com uma formulacao propria, sempre com o
// {link_descadastro} (o fecho original era "responda SAIR" — ver TOKENS_OBRIGATORIOS).
const TEXTO_BASE_PADRAO = [
  '{saudacao} Aqui é o {recrutador}, da *Vendedor Mestre*, empresa de recrutamento. 😊',
  '',
  'Você se candidatou ao cargo de *{vaga}* na *{empresa}* e queremos te conhecer melhor!',
  '',
  // Dois-pontos: a frase INTRODUZ as tres linhas de dado logo abaixo.
  'Vamos fazer uma *entrevista em grupo online*:',
  '',
  '📅 *{data}*',
  '⏰ *{horario}* (horário de Brasília)',
  '🔗 Link para confirmar presença na entrevista: {link_meet}',
  '',
  'A entrevista acontece pelo Google Meet. Confirme sua presença no link e cadastre seu email na agenda: o convite com o acesso chega por email.',
  '',
  'Entre alguns minutos antes, em um lugar tranquilo e com boa internet.',
  '',
  'Se tiver dúvida, é só responder aqui.',
  '',
  'Para não receber mais mensagens nossas, acesse: {link_descadastro}',
].join('\n');

const VARIACOES_SEED = Object.freeze([
  [
    '{saudacao} 👋 Aqui é o {recrutador}, da *Vendedor Mestre*, empresa de recrutamento.',
    '',
    'Sua candidatura para o cargo de *{vaga}* na *{empresa}* avançou, e queremos conversar com você! 🎉',
    '',
    'Te convidamos para uma *entrevista em grupo online*:',
    '',
    '📅 *{data}*',
    '⏰ *{horario}* (horário de Brasília)',
    '🔗 Link para confirmar presença: {link_meet}',
    '',
    'A entrevista é pelo Google Meet. Ao confirmar no link e cadastrar seu email na agenda, você recebe o convite de acesso por email.',
    '',
    'Entre uns minutos antes, de um lugar silencioso e com internet estável.',
    '',
    'Qualquer dúvida, responda por aqui.',
    '',
    'Se preferir não receber mais mensagens, acesse: {link_descadastro}',
  ].join('\n'),

  [
    '{saudacao} Tudo bem? Quem fala é o {recrutador}, da *Vendedor Mestre* (recrutamento e seleção).',
    '',
    'Sobre a sua candidatura ao cargo de *{vaga}* na *{empresa}*: chegou a hora da próxima etapa! 🚀',
    '',
    'É uma *entrevista em grupo pelo Google Meet*:',
    '🗓️ *{data}*',
    '🕐 *{horario}* (horário de Brasília)',
    '💻 Confirme sua presença aqui: {link_meet}',
    '',
    'Depois de confirmar, cadastre seu email na agenda: o convite para entrar no Meet chega por lá.',
    '',
    'Recomendo entrar um pouco antes e estar em um lugar tranquilo.',
    '',
    'Dúvidas? É só responder.',
    '',
    'Para deixar de receber nossas mensagens: {link_descadastro}',
  ].join('\n'),

  [
    '{saudacao}',
    '',
    'Aqui é o {recrutador}, da *Vendedor Mestre*, empresa de recrutamento. Você se inscreveu para o cargo de *{vaga}* na *{empresa}*, e o próximo passo é uma *entrevista em grupo online*. Anote aí:',
    '',
    '*Data:* {data}',
    '*Horário:* {horario} (Brasília)',
    '*Link para confirmar presença:* {link_meet}',
    '',
    'A entrevista é feita pelo Google Meet: cadastrando seu email na agenda, o convite chega na sua caixa de entrada.',
    '',
    '💡 Vale entrar alguns minutos antes, com boa conexão e sem barulho.',
    '',
    'Se tiver qualquer pergunta, me chame aqui.',
    '',
    'Não quer mais receber mensagens? {link_descadastro}',
  ].join('\n'),

  [
    '{saudacao} Aqui é o {recrutador}, da *Vendedor Mestre*, empresa de recrutamento. Temos novidade! ✨',
    '',
    'Queremos te ver na *entrevista em grupo* para o cargo de *{vaga}* na *{empresa}*.',
    '',
    '📌 *{data}, às {horario}* (horário de Brasília)',
    '📌 Confirme presença pelo link: {link_meet}',
    '📌 A entrevista é no Google Meet; o convite chega por email depois do cadastro na agenda.',
    '',
    'Procure um lugar calmo e uma internet estável, e entre um pouco antes do horário.',
    '',
    'Ficou com dúvida? Responda esta mensagem.',
    '',
    'Se não quiser receber mais avisos, clique aqui: {link_descadastro}',
  ].join('\n'),

  [
    '{saudacao} Sou o {recrutador}, da *Vendedor Mestre*, empresa de recrutamento que conduz a seleção da *{empresa}*.',
    '',
    '*Convite:* etapa seguinte do processo seletivo para o cargo de *{vaga}* — uma entrevista em grupo online.',
    '',
    '➡️ *Quando:* {data}, {horario} (Brasília)',
    '➡️ *Onde:* Google Meet (o convite chega por email depois do cadastro na agenda)',
    '➡️ *Confirme presença:* {link_meet}',
    '',
    '*Sugestão:* entre alguns minutos antes e escolha um ambiente silencioso.',
    '',
    'Se precisar tirar alguma dúvida, responda por aqui.',
    '',
    'Para parar de receber nossas mensagens, acesse {link_descadastro}',
  ].join('\n'),

  [
    '{saudacao} Aqui é o {recrutador}, da *Vendedor Mestre* (empresa de recrutamento).',
    '',
    'Estamos avançando com quem se candidatou ao cargo de *{vaga}* na *{empresa}*, e *você está na lista* para a entrevista em grupo! 🙌',
    '',
    '📅 *{data}*, às *{horario}* (horário de Brasília)',
    '🔗 Confirme sua presença neste link: {link_meet}',
    '',
    'É por lá que você cadastra seu email na agenda e recebe o convite para entrar no Google Meet.',
    '',
    'Entre um pouco antes, com internet boa e em um lugar sem ruído.',
    '',
    'Alguma dúvida? Pode responder aqui.',
    '',
    'Caso não queira mais receber mensagens, é só tocar aqui: {link_descadastro}',
  ].join('\n'),

  [
    '{saudacao}',
    '',
    'Quem escreve é o {recrutador}, da *Vendedor Mestre*, empresa de recrutamento. Sobre o cargo de *{vaga}* na *{empresa}*, para o qual você se candidatou: agora é a *entrevista em grupo, online*. Fica assim:',
    '',
    '• *{data}*',
    '• *{horario}* (Brasília)',
    '• Confirmação de presença: {link_meet}',
    '• Pelo Google Meet (convite por email após o cadastro na agenda)',
    '',
    'Chegue uns minutos antes e busque um lugar tranquilo com conexão estável.',
    '',
    'Se ficar com alguma dúvida, me responda.',
    '',
    'Para sair da nossa lista de mensagens: {link_descadastro}',
  ].join('\n'),
]);

// ══════════════════════════════════════════════════════════════
// SEED do CONVITE PARA CANDIDATURA (segmento da base)
// ══════════════════════════════════════════════════════════════
//
// Aprovadas pelo Rafael na Parada 2 do segmento (2026-10-09), com ajustes nas sementes 2 e 7. So
// entram numa campanha de segmento criada no painel, e o interruptor massa_wa_segmento_ativo
// nasce desligado.
//
// A mensagem sai de um numero que a pessoa nunca viu, para alguem que se candidatou a OUTRA vaga
// ha semanas. Por isso cada uma das sete: (a) diz quem escreve, (b) lembra de onde a pessoa nos
// conhece ({cidade}), (c) convida com {link_vaga}, (d) fecha com {link_descadastro}. Curtas,
// sem promessa de resultado e sem artigo de genero antes de {recrutador} (o nome vem da config).
// Mesmas regras de formatacao das sementes acima: link fora do negrito, sem _italico_.
const VARIACOES_SEED_CONVITE = Object.freeze([
  [
    '{saudacao} Aqui é {recrutador}, da *Vendedor Mestre*, empresa de recrutamento.',
    '',
    'Estou te escrevendo porque você já se candidatou a uma vaga nossa em {cidade}. Abrimos uma nova que pode combinar com você: *{vaga}*, na *{empresa}*.',
    '',
    'Se quiser conhecer e se candidatar, os detalhes estão aqui:',
    '{link_vaga}',
    '',
    'Se não quiser mais receber mensagens como esta, é só tocar aqui: {link_descadastro}',
  ].join('\n'),
  [
    '{saudacao} Tudo bem? {recrutador} aqui, do recrutamento da *Vendedor Mestre*.',
    '',
    'Seu contato está com a gente desde que você se candidatou a uma vaga nossa em {cidade}. Surgiu uma vaga nova e lembrei de você:',
    '',
    '📌 *{vaga}* — *{empresa}*',
    '🔗 {link_vaga}',
    '',
    'Não tem interesse? Sem problema, você pode sair da lista por aqui: {link_descadastro}',
  ].join('\n'),
  [
    'Oi! Quem fala é {recrutador}, da *Vendedor Mestre* (recrutamento).',
    '',
    'Você já se candidatou com a gente em {cidade}, então quis te avisar: estamos selecionando para *{vaga}* na *{empresa}*.',
    '',
    'Vaga e inscrição: {link_vaga}',
    '',
    'Para não receber mais avisos de vagas: {link_descadastro}',
  ].join('\n'),
  [
    '{saudacao} Aqui é {recrutador}, da *Vendedor Mestre*.',
    '',
    'Como você se candidatou a uma vaga nossa em {cidade}, estou te enviando esta:',
    '',
    '*Vaga:* {vaga}',
    '*Empresa:* {empresa}',
    '*Para ver e se candidatar:* {link_vaga}',
    '',
    'Prefere não receber mais? Toque aqui: {link_descadastro}',
  ].join('\n'),
  [
    '{saudacao} Meu nome é {recrutador} e trabalho no recrutamento da *Vendedor Mestre*. Falo com você porque já se candidatou a uma de nossas vagas em {cidade}, e agora temos uma vaga de *{vaga}* na *{empresa}* que pode te interessar.',
    '',
    'Se fizer sentido para você, a descrição e a inscrição estão neste link: {link_vaga}',
    '',
    'Caso não queira receber novas mensagens, use este link: {link_descadastro}',
  ].join('\n'),
  [
    '{saudacao} É {recrutador}, da *Vendedor Mestre* 🙂',
    '',
    'Você se candidatou a uma vaga com a gente em {cidade}, e abrimos outra que achei que valia te contar:',
    '',
    '• *{vaga}*',
    '• na *{empresa}*',
    '• detalhes e inscrição: {link_vaga}',
    '',
    'Se não quiser mais receber, é só clicar: {link_descadastro}',
  ].join('\n'),
  [
    '{saudacao} Aqui é {recrutador}, da equipe de recrutamento da *Vendedor Mestre*.',
    '',
    'Você já se candidatou a uma vaga nossa em {cidade} e estamos com uma nova: *{vaga}*, na *{empresa}*. Ainda está buscando uma oportunidade?',
    '',
    '➡️ {link_vaga}',
    '',
    'Para sair da lista e não receber mais mensagens: {link_descadastro}',
  ].join('\n'),
]);

// Semente do campo "texto base" de uma campanha de segmento: a primeira variacao.
const TEXTO_BASE_CONVITE = VARIACOES_SEED_CONVITE[0];

function sementesDoTipo(tipo = TIPO_ENTREVISTA_GRUPO) {
  tokensDoTipo(tipo);
  return tipo === TIPO_CONVITE_CANDIDATURA ? VARIACOES_SEED_CONVITE : VARIACOES_SEED;
}

function textoBaseDoTipo(tipo = TIPO_ENTREVISTA_GRUPO) {
  tokensDoTipo(tipo);
  return tipo === TIPO_CONVITE_CANDIDATURA ? TEXTO_BASE_CONVITE : TEXTO_BASE_PADRAO;
}

// ══════════════════════════════════════════════════════════════
// VALIDACAO
// ══════════════════════════════════════════════════════════════

// Todos os tokens {assim} que aparecem no texto, na ordem em que aparecem.
//
// ── A REGEX ACEITA QUALQUER CONTEUDO ENTRE CHAVES, E ISSO E DE PROPOSITO ──
// A primeira versao era /\{([a-z0-9_]+)\}/ — so letras sem acento. Com ela, `{horário}` NAO era
// reconhecido como token: ficava invisivel para o validador (que nao acusava nada) e para o
// resolvedor (que nao substituia), e a chave ia LITERAL para o aparelho da pessoa. Um teste
// pegou.
//
// Agora qualquer `{...}` e reconhecido; a classificacao em conhecido/desconhecido acontece
// depois, contra TOKENS. Efeito colateral aceito: uma chave solta no texto por outro motivo
// tambem e acusada — e o lado certo do erro, porque chave solta nao deve sair numa mensagem.
const RE_TOKEN = /\{([^{}]+)\}/g;

function tokensDe(texto) {
  const achados = [];
  for (const m of String(texto == null ? '' : texto).matchAll(RE_TOKEN)) {
    achados.push(m[1].trim().toLowerCase());
  }
  return achados;
}

// Normaliza para comparar duplicatas: minusculo, sem acento, espacos colapsados, sem pontuacao.
// Duas variacoes que diferem so por uma virgula NAO sao duas variacoes — e o LLM devolve
// quase-duplicatas com facilidade.
function assinatura(texto) {
  return String(texto == null ? '' : texto)
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9{}_]+/g, ' ')
    .trim();
}

const PROBLEMA_VAZIA = 'vazia';
const PROBLEMA_TOKEN_FALTANDO = 'token_faltando';
const PROBLEMA_TOKEN_DESCONHECIDO = 'token_desconhecido';
const PROBLEMA_CHAVE_DUPLA = 'chave_dupla';
const PROBLEMA_SEM_DESCADASTRO = 'sem_descadastro';
const PROBLEMA_LONGA = 'longa';
const PROBLEMA_DUPLICADA = 'duplicada';
const PROBLEMA_QUANTIDADE = 'quantidade';
// Contra o texto-base (so tipo entrevista — ver abaixo).
const PROBLEMA_TOKEN_INVENTADO = 'token_inventado';
const PROBLEMA_URL = 'url_alterada';
const PROBLEMA_PARECIDA = 'parecida';
const PROBLEMA_PARECIDA_BASE = 'parecida_com_base';
const PROBLEMA_TAMANHO_BASE = 'tamanho_fora_do_base';
const PROBLEMA_SEM_QUEBRAS = 'sem_quebras';

// ══════════════════════════════════════════════════════════════
// O TEXTO-BASE E A FONTE DA VERDADE (2026-10-14)
// ══════════════════════════════════════════════════════════════
//
// ── O BUG QUE ISTO CORRIGE ──
// A campanha 9 ("Lembrete Entrevista em Grupo Deandhela") tinha um texto-base de LEMBRETE ("e daqui
// a pouco as 14h", com o link da sala escrito por extenso), mas as 7 variacoes que sairam eram as
// sementes do CONVITE (VARIACOES_SEED): a criacao gravava as sementes sem olhar o texto-base, e o
// "Sugerir com IA" fazia o mesmo. 46 pessoas receberam um convite com o Calendly no lugar do
// lembrete com a sala.
//
// ── A REGRA, PARA O TIPO ENTREVISTA ──
// Cada variacao e uma REDACAO do texto-base: os mesmos tokens (nem um a menos, nem um inventado),
// as mesmas URLs escritas por extenso, tamanho parecido, e diferente o bastante do texto-base e
// das outras variacoes para cumprir a funcao de variacao (ver o topo do arquivo). {data},
// {horario} e {link_meet} so sao exigidos se o texto-base os usa: um lembrete com a hora escrita a
// mao e legitimo (a tela avisa do risco — ver avisosDoTextoBase).
//
// O SEGMENTO NAO PASSA POR AQUI: o texto-base dele e fixo (TEXTO_BASE_CONVITE, sem campo na
// tela) e as sementes do convite sao as derivacoes aprovadas dele. Ele segue com as regras de
// sempre (OBRIGATORIOS_POR_TIPO, inclusive o {link_descadastro} na propria variacao).
//
// ── O DESCADASTRO E DO SISTEMA, NAO DO TEXTO (decisao D2) ──
// No tipo entrevista, nem o texto-base nem a variacao precisam ter {link_descadastro}: no ENVIO (e
// na previa, que usa a mesma funcao) resolverTexto acrescenta LINHA_DESCADASTRO ao fim, com o link
// do destinatario. Se a variacao ja tiver o token (as sementes tem), nada e acrescentado — a
// mensagem nunca leva dois links de saida. A linha nunca passa pelo LLM: o gerador e instruido a
// nao escrever descadastro, e a linha so existe aqui. A redacao e a do TEXTO_BASE_PADRAO.
const LINHA_DESCADASTRO = 'Para não receber mais mensagens nossas, acesse: {link_descadastro}';

// Limiares (decisao D3). Jaccard sobre o CONJUNTO de palavras (depois da `assinatura`: sem acento,
// sem pontuacao, minusculo). 0,85 = 85% das palavras distintas em comum — nesse ponto a variacao so
// trocou uma ou outra palavra e, para o WhatsApp, e o mesmo texto. Referencia: as sementes atuais
// ficam entre 0,45 e 0,68 contra o TEXTO_BASE_PADRAO e no maximo 0,58 entre si.
const SIMILARIDADE_MAXIMA = 0.85;
// Tamanho da variacao relativo ao texto-base, em caracteres. Fora de 0,6x a 1,6x a variacao
// cortou informacao ou inventou conteudo. As sementes ficam entre 0,83x e 0,99x do padrao.
const FATOR_TAMANHO_MIN = 0.6;
const FATOR_TAMANHO_MAX = 1.6;

// O texto-base que vale para validar uma campanha do tipo entrevista. Campanha antiga sem texto-base
// gravado foi criada a partir do padrao (o formulario sempre veio com ele preenchido).
function textoBaseEfetivo(campanha) {
  return normalizarTextoBase(campanha && campanha.texto_base) || TEXTO_BASE_PADRAO;
}

// O texto-base E o padrao? So nesse caso as sementes sao derivacoes legitimas dele.
function ehTextoBasePadrao(texto) {
  return normalizarTextoBase(texto) === normalizarTextoBase(TEXTO_BASE_PADRAO);
}

// As variacoes gravadas foram feitas a partir do texto-base ATUAL? O carimbo e gravado junto com
// as variacoes (db.salvarVariacoesMassaWa). Sem carimbo (campanha anterior a esta regra) conta como
// desatualizada: nao ha como saber de que texto elas vieram.
function variacoesDesatualizadas(campanha) {
  if (!campanha) return false;
  return campanha.variacoes_base_hash !== hashTextoBase(campanha.texto_base);
}

// A trava das variacoes ALEM da validacao (tipo entrevista; o segmento nao passa por aqui). A tela
// (materializar, ativar, teste) e o worker usam esta mesma funcao — a regra nao pode divergir.
//   'com_erro'       a ultima geracao falhou, ou a IA estava desligada (variacoes_erro)
//   'desatualizadas' ha variacoes, mas de um texto-base que ja mudou (decisao D4)
//   null             liberado (a validacao ainda decide)
// Sem variacoes nao ha o que estar desatualizado: quem barra e a validacao (faltam as 7).
function bloqueioDasVariacoes(campanha, { temVariacoes = true } = {}) {
  if (!campanha) return null;
  if (String(campanha.variacoes_erro || '').trim()) return 'com_erro';
  if (temVariacoes && variacoesDesatualizadas(campanha)) return 'desatualizadas';
  return null;
}

// URLs escritas por extenso, na ordem. Pontuacao colada no fim ("...txh." ou "(link)") nao e parte
// do link.
function urlsDe(texto) {
  const achadas = String(texto == null ? '' : texto).match(/https?:\/\/[^\s<>"]+/gi) || [];
  return achadas.map((u) => u.replace(/[.,;:!?)\]]+$/, ''));
}

function palavrasDe(texto) {
  return new Set(assinatura(texto).split(' ').filter(Boolean));
}

// Jaccard de palavras, 0..1.
function similaridade(a, b) {
  const pa = palavrasDe(a);
  const pb = palavrasDe(b);
  let comum = 0;
  for (const p of pa) if (pb.has(p)) comum += 1;
  const uniao = pa.size + pb.size - comum;
  return uniao ? comum / uniao : 0;
}

function contarQuebras(texto) {
  return (String(texto == null ? '' : texto).replace(/\r\n?/g, '\n').match(/\n/g) || []).length;
}

// Quebras de linha que uma variacao precisa ter: metade das do texto-base, arredondada para
// cima, minimo 1. Texto-base de uma linha so nao exige nada (0).
function minimoDeQuebras(textoBase) {
  const n = contarQuebras(textoBase);
  return n ? Math.max(1, Math.ceil(n / 2)) : 0;
}

// Tokens que a variacao TEM que manter: os conhecidos que o texto-base usa, menos o descadastro
// (que e do sistema).
function obrigatoriosDoTextoBase(textoBase, tipo = TIPO_ENTREVISTA_GRUPO) {
  const { tokens: conhecidos } = tokensDoTipo(tipo);
  return [...new Set(tokensDe(textoBase))].filter((t) => conhecidos.includes(t) && t !== TOKEN_DESCADASTRO);
}

// Confere UMA variacao contra o texto-base. Lista de problemas (vazia = ok). Nao repete o que
// validarVariacao ja cobre (vazia, longa, {{dupla}}, token desconhecido).
function validarContraTextoBase(texto, textoBase, indice) {
  const t = String(texto == null ? '' : texto).trim();
  const base = normalizarTextoBase(textoBase);
  const problemas = [];
  if (!t || !base) return problemas;

  const presentes = new Set(tokensDe(t));
  const doBase = new Set(tokensDe(base));
  const faltando = obrigatoriosDoTextoBase(base).filter((tok) => !presentes.has(tok));
  if (faltando.length) problemas.push({ indice, codigo: PROBLEMA_TOKEN_FALTANDO, tokens: faltando });

  // Token conhecido que o texto-base nao usa: a variacao acrescentou informacao (uma {data} num
  // lembrete que diz "daqui a pouco"). O descadastro e a excecao — e do sistema.
  const inventados = [...presentes].filter(
    (tok) => TOKENS.includes(tok) && tok !== TOKEN_DESCADASTRO && !doBase.has(tok),
  );
  if (inventados.length) problemas.push({ indice, codigo: PROBLEMA_TOKEN_INVENTADO, tokens: inventados });

  // URL literal: comparacao EXATA. Um caractere a menos no link da sala e uma sala que nao abre.
  const urlsDaVariacao = new Set(urlsDe(t));
  const perdidas = [...new Set(urlsDe(base))].filter((u) => !urlsDaVariacao.has(u));
  if (perdidas.length) problemas.push({ indice, codigo: PROBLEMA_URL, urls: perdidas });

  const fator = t.length / base.length;
  if (fator < FATOR_TAMANHO_MIN || fator > FATOR_TAMANHO_MAX) {
    problemas.push({
      indice, codigo: PROBLEMA_TAMANHO_BASE, tamanho: t.length, base: base.length,
      min: FATOR_TAMANHO_MIN, max: FATOR_TAMANHO_MAX,
    });
  }

  // Paragrafos (2026-10-19): o LLM devolveu as 7 da campanha 11 (e da 10, que ENVIOU 13) numa
  // linha so — a mensagem chegou como um bloco corrido. A variacao precisa de pelo menos metade
  // das quebras do texto-base (minimo 1): junta duas linhas curtas, tudo bem; achata tudo, nao.
  const minimo = minimoDeQuebras(base);
  const quebras = contarQuebras(t);
  if (minimo && quebras < minimo) {
    problemas.push({ indice, codigo: PROBLEMA_SEM_QUEBRAS, quebras, minimo, base: contarQuebras(base) });
  }

  const s = similaridade(t, base);
  if (s >= SIMILARIDADE_MAXIMA) {
    problemas.push({ indice, codigo: PROBLEMA_PARECIDA_BASE, similaridade: s, limite: SIMILARIDADE_MAXIMA });
  }
  return problemas;
}

// Acrescenta a linha de descadastro do sistema, uma vez. Texto vazio fica vazio: a linha sozinha
// nao e mensagem.
function comLinhaDescadastro(texto) {
  const t = String(texto == null ? '' : texto);
  if (!t.trim() || tokensDe(t).includes(TOKEN_DESCADASTRO)) return t;
  return `${t.replace(/\s+$/, '')}\n\n${LINHA_DESCADASTRO}`;
}

// Avisos (nao bloqueiam) sobre o texto-base: link ou horario escritos a mao SEM {data}. Funciona no
// dia; numa campanha de varios dias a mensagem anuncia um horario que ja passou. Com {data} o
// texto acompanha a proxima reuniao e o literal e, no maximo, redundante.
function avisosDoTextoBase(textoBase) {
  const base = normalizarTextoBase(textoBase);
  if (!base || tokensDe(base).includes('data')) return { urls: [], horas: [] };
  const semUrls = base.replace(/https?:\/\/[^\s<>"]+/gi, ' ');
  const horas = semUrls.match(/\b(?:[01]?\d|2[0-3])(?::[0-5]\d|h(?:[0-5]\d)?)(?![\p{L}\d])/giu) || [];
  return { urls: urlsDe(base), horas: [...new Set(horas)] };
}

// Valida UMA variacao. Devolve lista de problemas (vazia = ok).
//
// Cada problema traz `indice` (1-based, o mesmo da tabela) e o que for necessario para a tela
// escrever a frase — nunca a frase em si: o texto de erro mora na camada de apresentacao.
//
// `textoBase` so vale para o tipo entrevista (ver "O TEXTO-BASE E A FONTE DA VERDADE"). Ausente,
// vale o TEXTO_BASE_PADRAO — o mesmo de textoBaseEfetivo para campanha sem texto gravado.
function validarVariacao(texto, indice, { tipo = TIPO_ENTREVISTA_GRUPO, textoBase } = {}) {
  const { tokens: conhecidos, obrigatorios } = tokensDoTipo(tipo);
  const contraBase = tipo === TIPO_ENTREVISTA_GRUPO;
  const problemas = [];
  const t = String(texto == null ? '' : texto).trim();

  if (!t) {
    problemas.push({ indice, codigo: PROBLEMA_VAZIA });
    return problemas; // sem texto, os demais testes nao dizem nada
  }

  if (t.length > MAX_CARACTERES) {
    problemas.push({ indice, codigo: PROBLEMA_LONGA, tamanho: t.length, teto: MAX_CARACTERES });
  }

  // {{duplo}}: sintaxe dos templates da Meta. Se apareceu aqui, alguem colou texto do outro
  // subsistema — e o token NAO seria resolvido, indo literal para o aparelho de alguem.
  if (/\{\{|\}\}/.test(t)) problemas.push({ indice, codigo: PROBLEMA_CHAVE_DUPLA });

  const presentes = new Set(tokensDe(t));
  if (!contraBase) {
    const faltando = obrigatorios.filter((tok) => tok !== TOKEN_DESCADASTRO && !presentes.has(tok));
    if (faltando.length) problemas.push({ indice, codigo: PROBLEMA_TOKEN_FALTANDO, tokens: faltando });
  }

  // Token escrito errado ({horário}, {linkmeet}) nao resolve e sai literal na mensagem.
  const desconhecidos = [...presentes].filter((tok) => !conhecidos.includes(tok));
  if (desconhecidos.length) {
    problemas.push({ indice, codigo: PROBLEMA_TOKEN_DESCONHECIDO, tokens: desconhecidos });
  }

  if (contraBase) {
    problemas.push(...validarContraTextoBase(t, normalizarTextoBase(textoBase) || TEXTO_BASE_PADRAO, indice));
  } else if (!presentes.has(TOKEN_DESCADASTRO)) {
    problemas.push({ indice, codigo: PROBLEMA_SEM_DESCADASTRO });
  }

  return problemas;
}

// Valida o CONJUNTO. `exigirTotal` (default true) cobra as 7 — a tela de edicao pode passar
// false para nao gritar enquanto o operador ainda esta escrevendo.
function validarVariacoes(textos, { exigirTotal = true, tipo = TIPO_ENTREVISTA_GRUPO, textoBase } = {}) {
  const lista = Array.isArray(textos) ? textos : [];
  const problemas = [];

  if (exigirTotal && lista.filter((t) => String(t || '').trim()).length !== TOTAL_VARIACOES) {
    problemas.push({
      codigo: PROBLEMA_QUANTIDADE,
      total: lista.filter((t) => String(t || '').trim()).length,
      esperado: TOTAL_VARIACOES,
    });
  }

  lista.forEach((texto, i) => {
    problemas.push(...validarVariacao(texto, i + 1, { tipo, textoBase }));
  });

  // Duplicatas: compara por assinatura, e reporta no indice da SEGUNDA ocorrencia (a primeira
  // e a legitima).
  const vistas = new Map();
  lista.forEach((texto, i) => {
    const a = assinatura(texto);
    if (!a) return;
    if (vistas.has(a)) {
      problemas.push({ indice: i + 1, codigo: PROBLEMA_DUPLICADA, igualA: vistas.get(a) });
    } else {
      vistas.set(a, i + 1);
    }
  });

  // Quase-duplicatas (tipo entrevista): Jaccard >= SIMILARIDADE_MAXIMA com uma variacao ANTERIOR.
  // A duplicata exata ja foi reportada acima e nao e reportada de novo.
  if (tipo === TIPO_ENTREVISTA_GRUPO) {
    lista.forEach((texto, i) => {
      const a = assinatura(texto);
      if (!a || vistas.get(a) !== i + 1) return;
      for (let j = 0; j < i; j += 1) {
        const b = assinatura(lista[j]);
        if (!b || vistas.get(b) !== j + 1) continue;
        const s = similaridade(texto, lista[j]);
        if (s >= SIMILARIDADE_MAXIMA) {
          problemas.push({ indice: i + 1, codigo: PROBLEMA_PARECIDA, igualA: j + 1, similaridade: s, limite: SIMILARIDADE_MAXIMA });
          break;
        }
      }
    });
  }

  return { ok: problemas.length === 0, problemas };
}

// ══════════════════════════════════════════════════════════════
// SORTEIO
// ══════════════════════════════════════════════════════════════

// Escolhe a variacao do proximo envio, EVITANDO repetir a ultima usada.
//
// `aleatorio` e injetavel (default Math.random) — e o que permite um teste provar a distribuicao
// e a regra de nao-repeticao sem depender de sorte.
//
// Quando ha uma variacao so, ela e devolvida mesmo sendo a ultima: a alternativa seria nao
// enviar, e uma campanha com um texto so ainda e uma campanha (o validador e quem cobra as 7
// antes de ativar; aqui a funcao nao inventa uma segunda politica).
function sortearVariacao(variacoes, ultimaIndice = null, aleatorio = Math.random) {
  const lista = (Array.isArray(variacoes) ? variacoes : []).filter(
    (v) => v && String(v.texto || '').trim(),
  );
  if (!lista.length) return null;

  const candidatas = lista.length > 1 ? lista.filter((v) => v.indice !== ultimaIndice) : lista;
  const universo = candidatas.length ? candidatas : lista;
  const n = Math.floor(aleatorio() * universo.length);
  // Math.random() pode devolver algo muito proximo de 1 e, com arredondamento, estourar o
  // indice. O clamp custa nada e evita um `undefined` no lugar de uma mensagem.
  const escolhida = universo[Math.min(Math.max(n, 0), universo.length - 1)];
  return { indice: escolhida.indice, texto: escolhida.texto };
}

// ══════════════════════════════════════════════════════════════
// RESOLUCAO DOS TOKENS (no momento do envio)
// ══════════════════════════════════════════════════════════════

// Monta o contexto de UM destinatario.
//
// `proxima` e o retorno de proximaEntrevistaGrupo (ou null). Quando e null, os tres tokens da
// reuniao ficam vazios — e resolverTexto devolve `faltando`, o que faz o worker NAO enviar. E o
// mesmo criterio do convite do WA2: nunca sai mensagem com data/link em branco.
//
// `linkDescadastro` vem pronto de quem chama (ver linkDescadastroPara): esta funcao continua pura.
// Ausente, o token fica vazio e o envio e recusado pelo mesmo `faltando`.
function montarContexto({ nome, job, proxima, linkDescadastro, recrutador } = {}) {
  return {
    saudacao: saudacao(nome),
    recrutador: recrutadorDe(recrutador),
    vaga: String((job && job.titulo) || '').trim(),
    empresa: textoEmpresa(job && job.empresa),
    data: (proxima && proxima.dataTexto) || '',
    horario: (proxima && proxima.horaTexto) || '',
    link_meet: (proxima && proxima.linkMeet) || '',
    link_descadastro: String(linkDescadastro || '').trim(),
  };
}

// Primeiro nome de quem assina a mensagem, a partir do valor CRU da config recrutador_nome
// ("Jean Dentz" -> "Jean"). Vazio ou ausente cai no RECRUTADOR_PADRAO — o mesmo fallback do
// botao de WhatsApp da ficha — e nunca devolve '': a mensagem sempre diz quem fala.
function recrutadorDe(valorConfig) {
  return primeiroNomeDe(valorConfig) || primeiroNomeDe(RECRUTADOR_PADRAO);
}

// Os titulos das vagas costumam vir como "Cargo | Empresa" ("Consultor Comercial | DUO Oral
// Care"). No convite o texto ja diz "*{vaga}*, na *{empresa}*", e a empresa sairia duas vezes. Se
// o titulo TERMINA em "| {empresa}" (sem maiusculas, sem acentos, espacos em volta do "|"
// tolerados), esse final sai. Se sobrar titulo vazio, nao corta. So o convite usa: o tipo
// entrevista continua com o titulo inteiro.
const semAcentoMinusculo = (v) => String(v || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '')
  .toLowerCase().replace(/\s+/g, ' ').trim();

function tituloSemEmpresa(titulo, empresa) {
  const t = String(titulo || '').trim();
  const e = semAcentoMinusculo(empresa);
  const i = t.lastIndexOf('|');
  if (!e || i < 0) return t;
  const antes = t.slice(0, i).trim();
  if (!antes || semAcentoMinusculo(t.slice(i + 1)) !== e) return t;
  return antes;
}

// Contexto do CONVITE PARA CANDIDATURA (segmento). A vaga e a VAGA-ALVO da campanha — nunca a
// vaga de origem do candidato, que e a que esta gravada no item da fila. `cidade` e a do recorte
// (criterios.cidade), ja no nome canonico do vocabulario.
function montarContextoConvite({ nome, job, cidade, linkVaga, linkDescadastro, recrutador } = {}) {
  return {
    saudacao: saudacao(nome),
    recrutador: recrutadorDe(recrutador),
    vaga: tituloSemEmpresa(job && job.titulo, job && job.empresa),
    empresa: textoEmpresa(job && job.empresa),
    cidade: String(cidade || '').trim(),
    link_vaga: String(linkVaga || '').trim(),
    link_descadastro: String(linkDescadastro || '').trim(),
  };
}

// UTM do convite: utm_source fixo e utm_campaign com o id da campanha. E o que /vaga/:slug grava
// no cookie de primeiro toque e applications.utm_* guarda na candidatura (ver
// db.contarCandidaturasPorUtmMassaWa). Primeiro toque: quem ja visitou ESTA vaga por outro link
// antes fica com a origem antiga — a metrica e um piso, nao a conta exata.
const UTM_SOURCE_MASSA = 'massa-wa';
const utmCampaignMassa = (campanhaId) => `massa-${Number(campanhaId)}`;

// '' quando nao ha slug ou id (vira `faltando` e o item nao sai). `baseUrl` injetavel para teste.
function linkVagaPara(slug, campanhaId, { baseUrl } = {}) {
  const id = Number(campanhaId);
  if (!String(slug || '').trim() || !Number.isInteger(id) || id <= 0) return '';
  // eslint-disable-next-line global-require
  const { montarUrlVaga } = require('./ctaCampanha');
  const url = new URL(montarUrlVaga(slug, { utmSource: UTM_SOURCE_MASSA, ...(baseUrl ? { baseUrl } : {}) }));
  url.searchParams.set('utm_campaign', utmCampaignMassa(id));
  return url.toString();
}

// Link de descadastro de UM telefone, ou '' se nao der para montar (OPTOUT_TOKEN_SECRET ausente,
// telefone sem chave canonica). NUNCA lanca: o chamador e o laco de envio, e o '' vira `faltando`
// em resolverTexto — o destinatario nao recebe, o ciclo segue. Diferente das campanhas via API,
// aqui NAO ha fallback textual: o link e o unico caminho de saida da mensagem.
//
// `montarUrl` e injetavel so para teste.
function linkDescadastroPara(telefone, montarUrl) {
  try {
    const fn = montarUrl || require('./descadastroWhatsapp').montarUrlDescadastroWhatsapp;
    return String(fn(telefone) || '');
  } catch (err) {
    console.warn(`[massa-wa] falha ao montar o link de descadastro (${err.message}); destinatario pulado.`);
    return '';
  }
}

// Substitui os tokens. Devolve { texto, faltando } — `faltando` sao os tokens OBRIGATORIOS que o
// texto usa mas o contexto nao soube preencher.
//
// ── POR QUE NAO LANCA, E POR QUE NAO ENVIA COM BURACO ──
// Vaga sem empresa cadastrada e um caso real desta base. Se resolvessemos para '' a mensagem
// sairia "na ." — e o candidato receberia uma frase quebrada. Devolver `faltando` deixa a decisao
// com o worker, que marca o item e segue para o proximo destinatario, sem derrubar o ciclo nem
// mandar texto defeituoso.
//
// `marcar` (so a PREVIA do painel usa): cerca cada valor substituido com as marcas de
// lib/formatoWhatsapp, que viram destaque na tela. O envio nunca passa `marcar` — o texto que sai
// e o mesmo de sempre; a previa e o envio passam pela MESMA funcao e so diferem nesse cercado.
function resolverTexto(texto, contexto = {}, { tipo = TIPO_ENTREVISTA_GRUPO, marcar = false } = {}) {
  const { tokens: conhecidos, obrigatorios } = tokensDoTipo(tipo);
  // `contexto || {}` e nao so o default do parametro: o default nao cobre quem passa `null`
  // explicitamente, e esta funcao roda dentro do laco de envio — uma excecao aqui derrubaria o
  // ciclo inteiro por causa de UM destinatario. Um teste pegou.
  const ctx = contexto || {};
  // Tipo entrevista: a linha de descadastro do sistema entra AQUI, e so aqui — envio, teste e
  // previa passam por esta funcao, entao nenhum deles mostra uma mensagem diferente da que sai.
  // Como ela traz {link_descadastro}, um link que nao pode ser montado vira `faltando` e o item
  // nao sai, igual a antes.
  if (marcar) texto = String(texto == null ? '' : texto).replace(/[\uE000\uE001]/g, '');
  if (tipo === TIPO_ENTREVISTA_GRUPO) texto = comLinhaDescadastro(texto);
  const usados = new Set(tokensDe(texto));
  const faltando = [...usados].filter(
    (tok) => obrigatorios.includes(tok) && !String(ctx[tok] || '').trim(),
  );

  const resolvido = String(texto == null ? '' : texto).replace(RE_TOKEN, (inteiro, nome) => {
    const chave = String(nome).trim().toLowerCase();
    // Token desconhecido fica LITERAL de proposito: apagar esconderia o erro, e o validador ja
    // recusa isso antes de a campanha poder disparar.
    if (!conhecidos.includes(chave)) return inteiro;
    const valor = String(ctx[chave] == null ? '' : ctx[chave]);
    return marcar && valor ? `${MARCA_INICIO}${valor}${MARCA_FIM}` : valor;
  });

  return { texto: resolvido, faltando };
}

module.exports = {
  TOKENS,
  TOKENS_OBRIGATORIOS,
  TIPO_ENTREVISTA_GRUPO,
  TIPO_CONVITE_CANDIDATURA,
  TOKENS_POR_TIPO,
  OBRIGATORIOS_POR_TIPO,
  tokensDoTipo,
  tipoPorFonte,
  montarContextoConvite,
  tituloSemEmpresa,
  linkVagaPara,
  UTM_SOURCE_MASSA,
  utmCampaignMassa,
  TEXTO_BASE_CONVITE,
  VARIACOES_SEED_CONVITE,
  sementesDoTipo,
  textoBaseDoTipo,
  TOTAL_VARIACOES,
  MAX_CARACTERES,
  TOKEN_DESCADASTRO,
  TEXTO_BASE_PADRAO,
  VARIACOES_SEED,
  tokensDe,
  assinatura,
  validarVariacao,
  validarVariacoes,
  sortearVariacao,
  montarContexto,
  linkDescadastroPara,
  recrutadorDe,
  resolverTexto,
  PROBLEMA_VAZIA,
  PROBLEMA_TOKEN_FALTANDO,
  PROBLEMA_TOKEN_DESCONHECIDO,
  PROBLEMA_CHAVE_DUPLA,
  PROBLEMA_SEM_DESCADASTRO,
  PROBLEMA_LONGA,
  PROBLEMA_DUPLICADA,
  PROBLEMA_QUANTIDADE,
  PROBLEMA_TOKEN_INVENTADO,
  PROBLEMA_URL,
  PROBLEMA_PARECIDA,
  PROBLEMA_PARECIDA_BASE,
  PROBLEMA_TAMANHO_BASE,
  PROBLEMA_SEM_QUEBRAS,
  contarQuebras,
  minimoDeQuebras,
  LINHA_DESCADASTRO,
  SIMILARIDADE_MAXIMA,
  FATOR_TAMANHO_MIN,
  FATOR_TAMANHO_MAX,
  textoBaseEfetivo,
  ehTextoBasePadrao,
  variacoesDesatualizadas,
  bloqueioDasVariacoes,
  urlsDe,
  similaridade,
  obrigatoriosDoTextoBase,
  validarContraTextoBase,
  comLinhaDescadastro,
  avisosDoTextoBase,
};
