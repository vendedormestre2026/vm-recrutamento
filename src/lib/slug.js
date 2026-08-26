'use strict';

// Normalizacao de texto -> slug URL-safe: sem acento, minusculo, so [a-z0-9-].
//
// Extraido de routes/admin.js (gerarSlugBase), onde vivia so para slug de VAGA. Passa a
// morar aqui porque um segundo consumidor apareceu (slug de CIDADE, em
// regioes_grupos_whatsapp) e duplicar a mesma regra de normalizacao em dois arquivos e o
// mesmo erro que ja tinha acontecido com normalizacao de telefone — mora num lugar so, os
// dois lados importam daqui.
//
// Contrato IDENTICO ao gerarSlugBase original: mesmo corte de acento (NFD + remove faixa
// de diacriticos), mesma troca de qualquer sequencia fora de [a-z0-9] por um hifen, mesmo
// aparo de hifens nas bordas, mesmo limite de 60 caracteres. O fallback ('vaga' no
// original) fica a cargo de quem chama — ver `gerarSlugBase` abaixo.
function normalizarSlug(texto) {
  return String(texto || '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '') // remove diacriticos (acentos)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
}

// Mesma assinatura/comportamento do gerarSlugBase original de routes/admin.js: aplica
// normalizarSlug e cai para 'vaga' quando o resultado fica vazio (titulo so com
// pontuacao/emoji, por exemplo). Fallback especifico de VAGA — quem precisar de outro
// fallback (ex.: cidade) usa normalizarSlug diretamente e decide o proprio default.
function gerarSlugBase(titulo) {
  return normalizarSlug(titulo) || 'vaga';
}

module.exports = { normalizarSlug, gerarSlugBase };
