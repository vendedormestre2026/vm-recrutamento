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
  montarLinkWhatsapp,
  mensagemWhatsappCandidato,
  // candidato -> recrutador
  mensagemPosEntrevista,
  mensagemNovaCandidatura,
  RECRUTADOR_PADRAO,
  TEMPLATE_PADRAO,
};
