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
  const empresaTxt = String(empresa || '').trim();

  let texto = tpl;
  if (!empresaTxt) {
    texto = texto.replace(/\s*da empresa \{empresa\}/gi, '');
  }

  const valores = {
    '{primeiro_nome}': primeiroNomeDe(nome),
    '{vaga}': String(vaga || '').trim(),
    '{empresa}': empresaTxt,
    '{recrutador}': String(recrutador || '').trim() || RECRUTADOR_PADRAO,
  };
  for (const [ph, val] of Object.entries(valores)) {
    texto = texto.split(ph).join(val);
  }

  return texto
    .replace(/\s+([,.])/g, '$1')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

module.exports = {
  normalizarTelefoneWhatsapp,
  montarLinkWhatsapp,
  mensagemWhatsappCandidato,
  RECRUTADOR_PADRAO,
  TEMPLATE_PADRAO,
};
