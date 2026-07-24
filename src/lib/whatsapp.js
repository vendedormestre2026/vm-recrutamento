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

// Mensagem padrao que o recrutador envia ao candidato pelo WhatsApp. Template fixo
// (Jean Dentz / Vendedor Mestre nunca mudam — decisao B3). Usa o PRIMEIRO nome do
// candidato e o titulo da vaga; o trecho "da empresa {empresa}" so aparece quando a vaga
// tem empresa preenchida (vagas sem empresa omitem, sem sobrar "da empresa " vazio).
function mensagemWhatsappCandidato({ nome, vaga, empresa } = {}) {
  const primeiroNome = String(nome || '').trim().split(/\s+/)[0] || '';
  const vagaTxt = String(vaga || '').trim();
  const empresaTxt = String(empresa || '').trim();

  const saudacao = primeiroNome ? `Olá ${primeiroNome}` : 'Olá';
  const vagaClause = vagaTxt ? `para a vaga de ${vagaTxt}` : 'para a vaga';
  const empresaClause = empresaTxt ? ` da empresa ${empresaTxt}` : '';

  return (
    `${saudacao}, aqui é o Jean Dentz da Vendedor Mestre. ` +
    `Recebi sua candidatura ${vagaClause}${empresaClause}. Você tem alguma dúvida?`
  );
}

module.exports = {
  normalizarTelefoneWhatsapp,
  montarLinkWhatsapp,
  mensagemWhatsappCandidato,
};
