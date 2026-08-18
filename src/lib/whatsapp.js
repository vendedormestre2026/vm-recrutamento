'use strict';

// Helper de WhatsApp (link wa.me + mensagem ao candidato). Funcoes puras e testaveis,
// sem dependencia de banco/req/res. Usado pelo painel do recrutador (admin) para o botao
// "Chamar no WhatsApp" na lista e no detalhe do candidato.

// DDI assumido quando o telefone nao traz codigo de pais explicito (sem '+'). O app e
// BR-focado e o seletor de DDI ja grava '+55 ...'; este default cobre numeros editados
// a mao sem DDI.
const DDI_PADRAO = '55';

// Limites de sanidade para um numero discavel (E.164 vai ate 15 digitos; abaixo de 10 e
// curto demais para um telefone com DDI+DDD+numero).
const MIN_DIGITOS = 10;
const MAX_DIGITOS = 15;

// Normaliza um telefone para o formato que o wa.me espera: SO digitos, com codigo de pais.
//   - nao-string / vazio -> null
//   - se comeca com '+', trata os digitos como numero internacional COMPLETO (nao prefixa)
//   - senao, prefixa o DDI padrao (decisao B3: assumir +55 quando nao ha codigo de pais)
//   - fora da faixa [MIN, MAX] digitos -> null (curto/comprido demais = invalido)
function normalizarTelefoneWhatsapp(telefone, { ddiPadrao = DDI_PADRAO } = {}) {
  if (typeof telefone !== 'string') return null;
  const bruto = telefone.trim();
  if (!bruto) return null;

  const temCodigoPais = bruto.startsWith('+');
  let digitos = bruto.replace(/\D/g, '');
  if (!digitos) return null;

  if (!temCodigoPais) digitos = `${ddiPadrao}${digitos}`;

  if (digitos.length < MIN_DIGITOS || digitos.length > MAX_DIGITOS) return null;
  return digitos;
}

// DDDs validos segundo a ANATEL (67 codigos). Fora desta lista, um numero pode ate ter o
// tamanho certo e ainda nao corresponder a nenhuma area real do Brasil — ex.: "20", "23",
// "36", "60" nunca foram atribuidos.
const DDDS_VALIDOS = new Set([
  11, 12, 13, 14, 15, 16, 17, 18, 19,
  21, 22, 24,
  27, 28,
  31, 32, 33, 34, 35, 37, 38,
  41, 42, 43, 44, 45, 46, 47, 48, 49,
  51, 53, 54, 55,
  61, 62, 63, 64, 65, 66, 67, 68, 69,
  71, 73, 74, 75, 77, 79,
  81, 82, 83, 84, 85, 86, 87, 88, 89,
  91, 92, 93, 94, 95, 96, 97, 98, 99,
]);

// Validacao ESTRITA de telefone BR: DDI 55 + DDD real (tabela ANATEL) + numero local no
// formato certo (fixo: 8 digitos comecando em 2-5; celular: 9 digitos comecando em 9 — o
// "nono digito" e obrigatorio desde 2016, entao um celular sem ele nao existe). Mais
// rigorosa que normalizarTelefoneWhatsapp, que so checa o teto [10,15] de digitos sem saber
// nada sobre DDD real ou o formato do numero local.
//
// Devolve os digitos normalizados (com DDI, sem '+') se valido; null caso contrario.
//
// DECISAO DE PRODUTO: SO aceita BR. Um numero internacional correto (ex.: Portugal +351,
// caso real ja documentado em applications id 741) e REJEITADO aqui de proposito — nao e
// bug desta funcao, e o contrato deste formulario.
function validarTelefoneBrEstrito(telefone) {
  const normalizado = normalizarTelefoneWhatsapp(telefone);
  if (!normalizado) return null;

  const m = normalizado.match(/^55(\d{2})(\d{8,9})$/);
  if (!m) return null;

  const ddd = Number(m[1]);
  if (!DDDS_VALIDOS.has(ddd)) return null;

  const local = m[2];
  const ehFixoValido = local.length === 8 && /^[2-5]/.test(local);
  const ehCelularValido = local.length === 9 && local.startsWith('9');
  if (!ehFixoValido && !ehCelularValido) return null;

  return normalizado;
}

// Normaliza um telefone que pode JA VIR NORMALIZADO (so digitos, com DDI, sem '+').
//
// ── O BUG QUE ESTA FUNCAO EXISTE PARA IMPEDIR ──
// normalizarTelefoneWhatsapp so reconhece codigo de pais quando a string comeca com '+'.
// Isso esta certo para a origem dela — telefone digitado em formulario, com seletor de DDI
// que grava "+55 ...". Mas quebra para dado que vem de VOLTA do nosso proprio sistema:
//
//   GET /api/disparos/pendentes  devolve  "5547999582500"
//   o n8n manda esse mesmo valor de volta no POST
//   normalizarTelefoneWhatsapp   grava    "555547999582500"   <- 55 prefixado duas vezes
//
// E o pior tipo de erro: 15 digitos ainda cabe no teto de sanidade, entao NAO ha recusa. A
// linha entra no livro-razao com um numero que nao existe, ninguem sai da fila de pendentes,
// e o ciclo seguinte reenvia para TODA a base. Um teste de fluxo completo entrou em laco
// infinito por causa disso — em producao, seria reenvio infinito.
//
// A deteccao e por TAMANHO, inequivoco para o Brasil:
//   55 + DDD(2) + numero(8 ou 9)  =  12 ou 13 digitos  -> JA tem DDI
//        DDD(2) + numero(8 ou 9)  =  10 ou 11 digitos  -> falta DDI
// Fora dessas faixas, entrega o valor cru para normalizarTelefoneWhatsapp decidir (e recusar).
//
// Funcao SEPARADA, e nao um ajuste na outra: as duas tem contratos diferentes por
// PROCEDENCIA do dado, e mudar a original alteraria o comportamento do formulario publico,
// que hoje esta correto. Use esta em toda fronteira que recebe telefone de fora (API, CSV,
// webhook); use a outra para telefone digitado por gente.
//
// ── DEBITO CONHECIDO E ACEITO: ESTA FUNCAO E BR-ONLY ──
//
// A deteccao reconhece SO o padrao brasileiro (^55 + 10 ou 11 digitos). Um numero
// internacional legitimo, ja normalizado, NAO casa — e cai na regra "sem '+' e nacional",
// que prefixa 55 e produz lixo:
//
//     "351912437103"  (celular de Portugal, valido)  ->  "55351912437103"
//
// A consequencia e SILENCIOSA, que e o que a torna digna de comentario: todo candidato
// estrangeiro reprova no teste de ida e volta de lib/publicoDisparoWhatsapp e fica de fora
// do disparo — com um log dizendo "DDI duplicado no cadastro", diagnostico que no caso dele
// e FALSO. Ninguem investiga porque nada parece errado.
//
// EXEMPLO CONHECIDO EM PRODUCAO: applications id 741 (Xavier), "+351 912437103". Numero
// portugues correto, excluido da fila por limitacao DAQUI, nao por defeito do dado. Ficou
// deliberadamente de fora da correcao em massa de DDI duplicado (2026-08-13, 44 registros)
// por nao ser o mesmo problema.
//
// QUEM FOR GENERALIZAR: o conserto nao e alargar a regex para outros DDIs um a um — e
// separar as duas perguntas que hoje estao coladas. "Ja tem codigo de pais?" nao se responde
// por TAMANHO; se responde por tabela de DDIs, ou por uma lib de telefonia
// (libphonenumber). Enquanto a base for ~100% brasileira, essa dependencia nao se paga —
// mas no dia em que se pagar, o teto [10,15] de normalizarTelefoneWhatsapp precisa ser
// revisto junto, porque ele tambem assume numero BR.
function normalizarTelefoneRecebido(telefone) {
  const digitos = String(telefone || '').replace(/\D/g, '');
  const jaTemDdiBr = /^55\d{10,11}$/.test(digitos);
  return normalizarTelefoneWhatsapp(jaTemDdiBr ? `+${digitos}` : String(telefone || ''));
}

// Monta o link wa.me a partir do telefone (normalizado) e uma mensagem opcional.
// Telefone invalido -> null (o chamador desabilita o botao). Mensagem vazia -> link sem
// ?text=. A mensagem vai URL-encoded (neutraliza espacos/acentos/quebras de linha).
function montarLinkWhatsapp(telefone, mensagem = '', opts = {}) {
  const numero = normalizarTelefoneWhatsapp(telefone, opts);
  if (!numero) return null;
  const texto = String(mensagem || '').trim();
  const query = texto ? `?text=${encodeURIComponent(texto)}` : '';
  return `https://wa.me/${numero}${query}`;
}

// Nome do recrutador e template padrao da mensagem de WhatsApp. Ambos sao configuraveis
// em /admin/config (chaves recrutador_nome / whatsapp_template); estes sao apenas os
// FALLBACKS quando a config esta ausente/vazia. "Vendedor Mestre" fica fixo no texto (a
// plataforma nao muda); o nome do recrutador entra via placeholder {recrutador}.
const RECRUTADOR_PADRAO = 'Jean Dentz';
const TEMPLATE_PADRAO =
  'Olá {primeiro_nome}, aqui é o {recrutador} da Vendedor Mestre. ' +
  'Recebi sua candidatura para a vaga de {vaga} da empresa {empresa}. Você tem alguma dúvida?';

function primeiroNomeDe(nome) {
  return String(nome || '').trim().split(/\s+/)[0] || '';
}

// ── Helpers internos de montagem de mensagem ────────────────────────────────────
// Extraidos de dentro de mensagemWhatsappCandidato para que as mensagens do sentido
// CANDIDATO -> recrutador reusem EXATAMENTE a mesma regra de omissao de empresa e a
// mesma limpeza final, em vez de reimplementar. O comportamento de
// mensagemWhatsappCandidato nao muda: ela passou a chamar os helpers.

// Texto saneado da empresa: '' quando ausente/nula/em branco. E o UNICO teste de
// "tem empresa?" em todo o arquivo — as tres mensagens perguntam por aqui.
function textoEmpresa(empresa) {
  return String(empresa || '').trim();
}

// Remove o trecho " da empresa {empresa}" do template. Usado quando nao ha empresa,
// para nao sobrar "da empresa" pendurado nem espaco duplo no lugar.
function removerTrechoEmpresa(texto) {
  return texto.replace(/\s*da empresa \{empresa\}/gi, '');
}

// Remove o trecho " para a vaga de {vaga}" (mesma ideia do de empresa). Usado quando a
// vaga nao pode ser resolvida — a frase continua valida sem ela.
function removerTrechoVaga(texto) {
  return texto.replace(/\s*para a vaga de \{vaga\}/gi, '');
}

// Troca os placeholders {chave} pelos valores. Placeholder DESCONHECIDO fica intacto
// de proposito (nao quebra a mensagem).
function aplicarPlaceholders(texto, valores) {
  let saida = texto;
  for (const [ph, val] of Object.entries(valores)) {
    saida = saida.split(ph).join(val);
  }
  return saida;
}

// Limpeza final de mensagem de UMA LINHA: " ," / " ." colados, espacos repetidos e
// bordas. Mesma semantica de antes (\s inclui \n) — por isso NAO serve para as
// mensagens estruturadas em varias linhas, que sao montadas linha a linha.
function limparEspacos(texto) {
  return texto
    .replace(/\s+([,.])/g, '$1')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

// Monta a mensagem ao candidato aplicando um TEMPLATE (configuravel) com placeholders:
//   {primeiro_nome}, {vaga}, {empresa}, {recrutador}.
// Regras:
//   - template vazio/ausente     -> usa TEMPLATE_PADRAO.
//   - recrutador vazio/ausente   -> usa RECRUTADOR_PADRAO.
//   - empresa vazia              -> remove o trecho " da empresa {empresa}" do template
//                                    (se houver); qualquer {empresa} restante vira ''.
//   - placeholders DESCONHECIDOS ({foo}) ficam intactos (nao quebra).
// Pura e testavel. Ao final, limpa espacos duplos e " ," / " ." residuais (ex.: quando o
// primeiro nome vem vazio, "Olá , " -> "Olá, ").
function mensagemWhatsappCandidato({ nome, vaga, empresa, recrutador, template } = {}) {
  const tpl = typeof template === 'string' && template.trim() ? template : TEMPLATE_PADRAO;
  const empresaTxt = textoEmpresa(empresa);

  let texto = tpl;
  if (!empresaTxt) {
    texto = removerTrechoEmpresa(texto);
  }

  texto = aplicarPlaceholders(texto, {
    '{primeiro_nome}': primeiroNomeDe(nome),
    '{vaga}': String(vaga || '').trim(),
    '{empresa}': empresaTxt,
    '{recrutador}': String(recrutador || '').trim() || RECRUTADOR_PADRAO,
  });

  return limparEspacos(texto);
}

// ── Mensagens do sentido CANDIDATO -> recrutador ────────────────────────────────
// Duas funcoes separadas (e nao uma com parametro "tipo") porque os dois textos tem
// FORMATOS diferentes — uma frase corrida e um resumo em linhas —, sem nada em comum
// alem dos helpers acima; um switch interno so esconderia dois templates distintos.
//
// Nenhuma das duas monta URL nem chama encodeURIComponent: a montagem do link wa.me
// continua no handler que renderiza a tela, preservando a separacao atual.

// Ponto A — tela de finalizacao (pos-entrevista). Duas variantes de abertura porque,
// sem nome, "Sou , acabei" ficaria quebrado; a frase sem nome e uma frase inteira.
const TEMPLATE_POS_ENTREVISTA =
  'Olá! Sou {nome}, acabei de concluir a entrevista para a vaga de {vaga} ' +
  'da empresa {empresa} e gostaria de falar com o recrutador.';
const TEMPLATE_POS_ENTREVISTA_SEM_NOME =
  'Olá! Acabei de concluir a entrevista para a vaga de {vaga} ' +
  'da empresa {empresa} e gostaria de falar com o recrutador.';

// Mensagem que o CANDIDATO envia ao recrutador ao final da entrevista.
// Regras de degradacao (a frase precisa continuar valida em qualquer combinacao):
//   - empresa vazia -> some " da empresa {empresa}".
//   - vaga vazia    -> some " para a vaga de {vaga}" E TAMBEM a empresa (empresa sozinha,
//                      sem a vaga que ela qualifica, viraria "a entrevista da empresa X").
//   - nome vazio    -> usa a abertura sem nome.
function mensagemPosEntrevista({ nome, vaga, empresa } = {}) {
  const nomeTxt = String(nome || '').trim();
  const vagaTxt = String(vaga || '').trim();
  const empresaTxt = textoEmpresa(empresa);

  let texto = nomeTxt ? TEMPLATE_POS_ENTREVISTA : TEMPLATE_POS_ENTREVISTA_SEM_NOME;
  if (!vagaTxt || !empresaTxt) {
    texto = removerTrechoEmpresa(texto);
  }
  if (!vagaTxt) {
    texto = removerTrechoVaga(texto);
  }

  texto = aplicarPlaceholders(texto, {
    '{nome}': nomeTxt,
    '{vaga}': vagaTxt,
    '{empresa}': empresaTxt,
  });

  return limparEspacos(texto);
}

// Ponto B — tela de confirmacao (modo Simples), logo apos a candidatura. Resumo
// estruturado: o recrutador recebe os dados de contato ja prontos. Montada linha a
// linha (e nao por template + limpeza) justamente para as quebras de linha
// sobreviverem — limparEspacos colapsaria \n em espaco.
// Empresa ausente -> a LINHA INTEIRA "🏢 Empresa:" nao e emitida (sem rotulo vazio).
function mensagemNovaCandidatura({ nome, email, telefone, vaga, empresa } = {}) {
  const ou = (valor, padrao) => String(valor || '').trim() || padrao;
  const empresaTxt = textoEmpresa(empresa);

  const linhas = [
    `📋 Candidatura de ${ou(nome, 'Candidato')}`,
    '',
    `📧 E-mail: ${ou(email, 'não informado')}`,
    `📱 WhatsApp: ${ou(telefone, 'não informado')}`,
    `💼 Vaga: ${ou(vaga, 'não informada')}`,
  ];
  if (empresaTxt) {
    linhas.push(`🏢 Empresa: ${empresaTxt}`);
  }

  return linhas.join('\n');
}

module.exports = {
  normalizarTelefoneWhatsapp,
  normalizarTelefoneRecebido,
  validarTelefoneBrEstrito,
  montarLinkWhatsapp,
  mensagemWhatsappCandidato,
  // candidato -> recrutador
  mensagemPosEntrevista,
  mensagemNovaCandidatura,
  RECRUTADOR_PADRAO,
  TEMPLATE_PADRAO,
  // ── Helpers de borda, expostos para lib/whatsappSequencia ──
  // Eram internos enquanto este arquivo era o unico a montar mensagem. A sequencia WA1/WA2
  // precisa das MESMAS regras (primeiro nome, omissao de empresa vazia, limpeza de espacos
  // residuais), e importa-las e o unico jeito de as duas nao divergirem no dia em que uma
  // for ajustada. Recopiar seria a garantia da divergencia.
  primeiroNomeDe,
  textoEmpresa,
  limparEspacos,
};
