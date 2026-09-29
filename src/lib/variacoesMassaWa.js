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
// data, horario, link) e a mesma instrucao de descadastro.
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
// {link_meet}. NAO usamos {{duplo}} — o duplo e a convencao dos templates da Meta
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
//
// Os tres ultimos vem da MESMA chamada, no MOMENTO DO ENVIO: congelar data e link na
// materializacao faria uma campanha de tres dias anunciar, no segundo dia, uma reuniao que
// passou. Ver lib/entrevistaGrupo.

const { saudacao } = require('./whatsappSequencia');
const { textoEmpresa } = require('./whatsapp');

// Tokens reconhecidos. Ordem estavel (usada em mensagem de erro e na tela de ajuda).
const TOKENS = Object.freeze(['saudacao', 'vaga', 'empresa', 'data', 'horario', 'link_meet']);

// Tokens que TODA variacao precisa ter.
//
// {saudacao} fica de fora de proposito: uma variacao pode legitimamente comecar sem cumprimentar.
// Os cinco abaixo, nao — sem eles a mensagem deixa de ser um convite (some a data, o horario ou a
// sala) ou deixa de dizer do que se trata (some a vaga ou a empresa).
const TOKENS_OBRIGATORIOS = Object.freeze(['vaga', 'empresa', 'data', 'horario', 'link_meet']);

// A instrucao de descadastro. Reconhecida pela PALAVRA de comando, nao pela frase inteira: o
// operador vai reescrever a frase em cada variacao ("responda SAIR", "é só responder SAIR"), e
// exigir texto identico transformaria a validacao num decoreba.
//
// Maiuscula obrigatoria: e o que faz a palavra parecer um comando dentro da frase, e e o que a
// captura do "SAIR" (lib/pedidoSaidaWhatsapp) reconhece de volta quando a pessoa responde.
const RE_DESCADASTRO = /\bSAIR\b/;

// Teto de caracteres. O limite do WhatsApp e ~4096; 1200 e uma regra NOSSA, de negocio: uma
// mensagem de divulgacao que passa disso vira parede de texto e nao e lida. As seeds abaixo tem
// ~500.
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
// Tres trechos chegaram truncados na primeira passagem (o fim da frase do texto base e o fecho das
// variacoes 2 e 5) e foram CORRIGIDOS pelo texto exato que ele enviou depois — nao ha mais nada
// inferido aqui. Cada variacao fecha com uma formulacao propria do descadastro ("responda SAIR",
// "envie SAIR", "Responda SAIR"), e isso e de proposito: e o mesmo conteudo dito de sete formas,
// que e a razao de existirem sete.
const TEXTO_BASE_PADRAO = [
  '{saudacao} Você se candidatou à vaga de {vaga} na {empresa} e queremos te conhecer melhor.',
  '',
  // Dois-pontos: a frase INTRODUZ as tres linhas de dado logo abaixo.
  'Vamos fazer uma entrevista em grupo online:',
  '',
  '📅 {data}',
  '⏰ {horario} (horário de Brasília)',
  '🔗 {link_meet}',
  '',
  'Entre alguns minutos antes, em um lugar tranquilo e com boa internet. Se tiver dúvida, é só responder aqui.',
  '',
  'Para não receber mais mensagens nossas, responda SAIR.',
].join('\n');

const VARIACOES_SEED = Object.freeze([
  '{saudacao} Passando para te convidar: sua candidatura para {vaga} na {empresa} avançou e '
    + 'queremos conversar com você em uma entrevista em grupo online. É em {data}, às {horario} '
    + '(Brasília). Link da sala: {link_meet}. Entre uns minutos antes, de um lugar silencioso e '
    + 'com internet estável. Qualquer dúvida, responda por aqui. Se preferir não receber mais '
    + 'mensagens, responda SAIR.',

  '{saudacao} Tudo bem? Sobre a sua candidatura à vaga de {vaga} na {empresa}: chegou a hora da '
    + 'próxima etapa, uma entrevista em grupo pelo Google Meet. 📅 {data} ⏰ {horario} (horário de '
    + 'Brasília) 🔗 {link_meet} Recomendo entrar um pouco antes e estar em um lugar tranquilo. '
    + 'Dúvidas? É só responder. Para deixar de receber nossas mensagens, envie SAIR.',

  '{saudacao} Você se inscreveu para {vaga} na {empresa}, e o próximo passo é uma entrevista em '
    + 'grupo online. Anote: {data}, {horario} (Brasília). A reunião acontece neste link: '
    + '{link_meet}. Vale entrar alguns minutos antes, com boa conexão e sem barulho. Se tiver '
    + 'qualquer pergunta, me chame aqui. Não quer mais receber mensagens? Responda SAIR.',

  '{saudacao} Temos novidade sobre a sua candidatura a {vaga} na {empresa}: queremos te ver na '
    + 'entrevista em grupo. Será em {data} às {horario}, horário de Brasília, pelo Google Meet: '
    + '{link_meet}. Procure um lugar calmo e uma internet estável, e entre um pouco antes do '
    + 'horário. Ficou com dúvida? Responda esta mensagem. Se não quiser receber mais avisos, '
    + 'responda SAIR.',

  '{saudacao} Convite para a etapa seguinte do processo seletivo de {vaga} na {empresa}: '
    + 'entrevista em grupo online. Quando: {data}, {horario} (Brasília). Onde: {link_meet}. '
    + 'Sugestão: entre alguns minutos antes e escolha um ambiente silencioso. Se precisar tirar '
    + 'alguma dúvida, responda por aqui. Para parar de receber nossas mensagens, responda SAIR.',

  '{saudacao} Estamos avançando com quem se candidatou à vaga de {vaga} na {empresa}, e você está '
    + 'na lista para a entrevista em grupo. Data e hora: {data}, às {horario} (horário de '
    + 'Brasília). Acesso pelo Google Meet: {link_meet}. Entre um pouco antes, com internet boa e '
    + 'em um lugar sem ruído. Alguma dúvida? Pode responder aqui. Caso não queira mais receber '
    + 'mensagens, responda SAIR.',

  '{saudacao} Sobre a vaga de {vaga} na {empresa}, para a qual você se candidatou: agora é a '
    + 'entrevista em grupo, online. Fica assim: {data}, {horario} (Brasília), no link {link_meet}. '
    + 'Chegue uns minutos antes e busque um lugar tranquilo com conexão estável. Se ficar com '
    + 'alguma dúvida, me responda. Se preferir não receber mais mensagens, é só responder SAIR.',
]);

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

// Valida UMA variacao. Devolve lista de problemas (vazia = ok).
//
// Cada problema traz `indice` (1-based, o mesmo da tabela) e o que for necessario para a tela
// escrever a frase — nunca a frase em si: o texto de erro mora na camada de apresentacao.
function validarVariacao(texto, indice) {
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
  const faltando = TOKENS_OBRIGATORIOS.filter((tok) => !presentes.has(tok));
  if (faltando.length) problemas.push({ indice, codigo: PROBLEMA_TOKEN_FALTANDO, tokens: faltando });

  // Token escrito errado ({horário}, {linkmeet}) nao resolve e sai literal na mensagem.
  const desconhecidos = [...presentes].filter((tok) => !TOKENS.includes(tok));
  if (desconhecidos.length) {
    problemas.push({ indice, codigo: PROBLEMA_TOKEN_DESCONHECIDO, tokens: desconhecidos });
  }

  if (!RE_DESCADASTRO.test(t)) problemas.push({ indice, codigo: PROBLEMA_SEM_DESCADASTRO });

  return problemas;
}

// Valida o CONJUNTO. `exigirTotal` (default true) cobra as 7 — a tela de edicao pode passar
// false para nao gritar enquanto o operador ainda esta escrevendo.
function validarVariacoes(textos, { exigirTotal = true } = {}) {
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
    problemas.push(...validarVariacao(texto, i + 1));
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
function montarContexto({ nome, job, proxima } = {}) {
  return {
    saudacao: saudacao(nome),
    vaga: String((job && job.titulo) || '').trim(),
    empresa: textoEmpresa(job && job.empresa),
    data: (proxima && proxima.dataTexto) || '',
    horario: (proxima && proxima.horaTexto) || '',
    link_meet: (proxima && proxima.linkMeet) || '',
  };
}

// Substitui os tokens. Devolve { texto, faltando } — `faltando` sao os tokens OBRIGATORIOS que o
// texto usa mas o contexto nao soube preencher.
//
// ── POR QUE NAO LANCA, E POR QUE NAO ENVIA COM BURACO ──
// Vaga sem empresa cadastrada e um caso real desta base. Se resolvessemos para '' a mensagem
// sairia "na ." — e o candidato receberia uma frase quebrada. Devolver `faltando` deixa a decisao
// com o worker, que marca o item e segue para o proximo destinatario, sem derrubar o ciclo nem
// mandar texto defeituoso.
function resolverTexto(texto, contexto = {}) {
  // `contexto || {}` e nao so o default do parametro: o default nao cobre quem passa `null`
  // explicitamente, e esta funcao roda dentro do laco de envio — uma excecao aqui derrubaria o
  // ciclo inteiro por causa de UM destinatario. Um teste pegou.
  const ctx = contexto || {};
  const usados = new Set(tokensDe(texto));
  const faltando = [...usados].filter(
    (tok) => TOKENS_OBRIGATORIOS.includes(tok) && !String(ctx[tok] || '').trim(),
  );

  const resolvido = String(texto == null ? '' : texto).replace(RE_TOKEN, (inteiro, nome) => {
    const chave = String(nome).trim().toLowerCase();
    // Token desconhecido fica LITERAL de proposito: apagar esconderia o erro, e o validador ja
    // recusa isso antes de a campanha poder disparar.
    if (!TOKENS.includes(chave)) return inteiro;
    return String(ctx[chave] == null ? '' : ctx[chave]);
  });

  return { texto: resolvido, faltando };
}

module.exports = {
  TOKENS,
  TOKENS_OBRIGATORIOS,
  TOTAL_VARIACOES,
  MAX_CARACTERES,
  RE_DESCADASTRO,
  TEXTO_BASE_PADRAO,
  VARIACOES_SEED,
  tokensDe,
  assinatura,
  validarVariacao,
  validarVariacoes,
  sortearVariacao,
  montarContexto,
  resolverTexto,
  PROBLEMA_VAZIA,
  PROBLEMA_TOKEN_FALTANDO,
  PROBLEMA_TOKEN_DESCONHECIDO,
  PROBLEMA_CHAVE_DUPLA,
  PROBLEMA_SEM_DESCADASTRO,
  PROBLEMA_LONGA,
  PROBLEMA_DUPLICADA,
  PROBLEMA_QUANTIDADE,
};
