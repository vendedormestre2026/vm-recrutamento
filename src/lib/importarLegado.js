'use strict';

// Normalizacao e deduplicacao da base legada (Supabase, tabela `aplicacao`) para o Banco
// de Talentos.
//
// ── MODULO PURO: NAO TOCA O BANCO ──
// Recebe as linhas do CSV e os conjuntos de e-mail que ja existem, devolve os registros
// prontos para insercao mais um relatorio. Quem le arquivo, quem consulta banco e quem
// grava e o script (src/scripts/importar-legado.js). A separacao existe para que TODA regra
// de normalizacao seja testavel sem montar banco nem ler disco — e sao as regras, nao a
// gravacao, que decidem o que 7 mil pessoas viram no sistema.
//
// A unica dependencia e lib/normalizarEmail (modulo folha). Nada de config, db ou views.
//
// ── A ORDEM DAS ETAPAS NAO E ARBITRARIA ──
// Exclusao de cargo vem ANTES da deduplicacao, e isso muda o resultado: uma pessoa cuja
// linha mais recente e 'CS' mas que tambem se candidatou como 'Vendedor' entra pela linha
// de Vendedor. Deduplicar primeiro a eliminaria — a linha vencedora seria a de CS, que e
// descartada em seguida, e a pessoa sumiria em silencio. Sao 26 pessoas no export atual, e
// a leitura correta e que elas SAO aproveitaveis: o que se exclui e o cargo, nao a pessoa.

const { normalizarEmail } = require('./normalizarEmail');

// ── Dicionario de cargo: bruto (como esta no CSV) -> canonico ──
//
// Aplicado por TABELA, nunca por heuristica e nunca por LLM. Um `startsWith('Consultor')`
// resolveria varias linhas de uma vez e e exatamente o que nao se quer: 'Consultor CLT' e
// 'consultor-comercial-sp' viram Consultor Comercial por DECISAO registrada, e um valor
// novo que aparecer num export futuro tem que APARECER no relatorio, nao ser absorvido por
// um prefixo que casou por acaso.
//
// As chaves sao case-sensitive e batem exatamente com os 20 valores distintos do export.
// 'consultor' e 'Consultor' sao entradas separadas de proposito: nao normalizamos a caixa
// antes de consultar, porque isso reintroduziria o casamento acidental que a tabela evita.
const CARGO_EXCLUIR = Symbol('cargo-excluir');

const DICIONARIO_CARGO = new Map([
  ['Consultor Comercial', 'Consultor Comercial'],
  ['Consultor', 'Consultor Comercial'],
  ['consultor', 'Consultor Comercial'],
  ['consultor-comercial-sp', 'Consultor Comercial'],
  ['Consultor CLT', 'Consultor Comercial'],
  ['Consultora CLT', 'Consultor Comercial'],
  ['CLT', 'Consultor Comercial'],
  ['Vendedor', 'Vendedor'],
  ['Vendedor Interno', 'Vendedor'],
  ['Vendedor Cabotagem', 'Vendedor'],
  ['SDR', 'SDR'],
  ['SDR PJ', 'SDR'],
  ['BDR', 'BDR'],
  ['Closer PJ', 'Closer'],
  ['PJ', 'Closer'],
  ['Coordenador Comercial', 'Liderança Comercial'],
  ['Coordenador', 'Liderança Comercial'],
  ['supervisor', 'Liderança Comercial'],
  // Fora do escopo da importacao, por decisao de negocio. Marcados EXPLICITAMENTE em vez
  // de omitidos da tabela: omitir os faria cair no balde de "nao mapeado", que e um alerta
  // pedindo intervencao humana — e estes dois nao sao um problema a resolver, sao uma
  // decisao ja tomada.
  ['CS', CARGO_EXCLUIR],
  ['fullstack', CARGO_EXCLUIR],
]);

// So SDR e Closer tem contraparte no enum de `talentos.perfil_interesse` (CHECK
// SDR|CLOSER). Os outros quatro cargos ficam com NULL ali e o valor fiel em `cargo`.
//
// CONSEQUENCIA A SABER: perfil_interesse NULL significa "sem atributo" para o motor de
// campanha (lib/promocaoVagas), e a regra fechada de la e que quem nao tem o atributo fica
// de FORA quando o filtro de perfil esta ativo. Ou seja, uma campanha filtrada por "Closer"
// nao alcanca os Consultores/Vendedores/BDR/Liderança legados — a menos que o operador
// marque "incluir sem perfil". Campanha sem filtro de perfil alcanca todos normalmente.
const PERFIL_POR_CARGO = new Map([
  ['SDR', 'SDR'],
  ['Closer', 'CLOSER'],
]);

const CATEGORIA_LEGADO = 'legado';

// ── Parser de CSV ──
//
// Escrito aqui em vez de trazer dependencia: o projeto nao tem lib de CSV, e o arquivo e
// lido UMA vez por um script manual. Uma dependencia nova no package.json para isso seria
// superficie de manutencao permanente por um uso pontual.
//
// Cobre o que este arquivo tem de fato: campo entre aspas (o export tem 13), aspas
// escapadas por duplicacao (""), CRLF, e virgula dentro de campo entre aspas. Nao cobre
// dialetos exoticos (separador diferente, escape por barra invertida) — se um export futuro
// trouxer isso, o certo e trocar por uma lib, nao esticar este parser.
function parseCsv(texto) {
  const linhas = [];
  let campo = '';
  let linha = [];
  let dentroDeAspas = false;

  // BOM no inicio viraria parte do nome da primeira coluna, e o lookup por cabecalho
  // falharia com uma mensagem que nao explica nada.
  const t = String(texto || '').replace(/^﻿/, '');

  for (let i = 0; i < t.length; i++) {
    const c = t[i];
    if (dentroDeAspas) {
      if (c === '"') {
        if (t[i + 1] === '"') {
          campo += '"';
          i += 1;
        } else {
          dentroDeAspas = false;
        }
      } else {
        campo += c;
      }
      continue;
    }
    if (c === '"') dentroDeAspas = true;
    else if (c === ',') {
      linha.push(campo);
      campo = '';
    } else if (c === '\r') {
      // CRLF: o \n seguinte fecha a linha. Um \r solto (CR antigo) nao existe neste export.
    } else if (c === '\n') {
      linha.push(campo);
      linhas.push(linha);
      linha = [];
      campo = '';
    } else campo += c;
  }
  // Ultima linha sem quebra final.
  if (campo !== '' || linha.length) {
    linha.push(campo);
    linhas.push(linha);
  }
  return linhas;
}

// CSV -> array de objetos, com as colunas nomeadas pelo cabecalho.
// Linhas com contagem de colunas diferente do cabecalho sao devolvidas mesmo assim (campos
// ausentes viram undefined): quem decide o que fazer com linha torta e prepararImportacao,
// que sabe contar e reportar — aqui nao se descarta nada em silencio.
function linhasComoObjetos(texto) {
  const linhas = parseCsv(texto);
  if (!linhas.length) return { cabecalho: [], registros: [] };

  const cabecalho = linhas[0].map((c) => String(c).trim());
  const registros = linhas.slice(1)
    // Linha vazia final (o arquivo termina com quebra) vira [''] — nao e dado.
    .filter((l) => l.length > 1 || (l.length === 1 && l[0] !== ''))
    .map((l) => {
      const obj = {};
      cabecalho.forEach((nome, i) => {
        obj[nome] = l[i];
      });
      return obj;
    });

  return { cabecalho, registros };
}

// ── Cargo ──
// Devolve { tipo: 'canonico'|'excluido'|'naoMapeado', cargo? }.
// 'naoMapeado' NAO e erro nem exclusao: e um pedido de decisao humana. Quem chama conta e
// reporta; nunca inventa mapeamento e nunca descarta em silencio.
function normalizarCargo(bruto) {
  const chave = String(bruto == null ? '' : bruto).trim();
  if (!DICIONARIO_CARGO.has(chave)) return { tipo: 'naoMapeado', bruto: chave };
  const valor = DICIONARIO_CARGO.get(chave);
  if (valor === CARGO_EXCLUIR) return { tipo: 'excluido', bruto: chave };
  return { tipo: 'canonico', cargo: valor };
}

function perfilDeCargo(cargoCanonico) {
  return PERFIL_POR_CARGO.get(cargoCanonico) || null;
}

// ── Telefone ──
//
// ── A PREMISSA DA DECISAO NAO BATE COM O ARQUIVO ──
// A decisao registrada foi `"+55 " + digitos do CSV`, supondo que `whatsapp` viesse como
// digitos crus ("47989251350"). O export real e outro: 9.808 das 10.375 linhas (94,5%) ja
// trazem o DDI, no formato "+5547989186990" ou "p:+5547989186990" (o prefixo `p:` e residuo
// de formulario de lead do Meta Ads), e ha ainda "(47) 98894-5058" com pontuacao. Concatenar
// "+55 " nesses casos produziria "+55 5547989186990" — DDI duplicado em 94% da base.
//
// Entao a regra abaixo preserva a INTENCAO da decisao (o formato final de
// api_banco_curriculos.js:183, "+55 " + numero nacional) em vez da sua letra:
//   1. reduz a digitos;
//   2. tira o 55 inicial quando o comprimento indica DDI + numero nacional (13 ou 12);
//   3. aceita 11 ou 10 digitos como ja nacionais;
//   4. qualquer outro comprimento e ANOMALIA — devolve null e sinaliza.
//
// NAO adivinha nos casos torcidos. As 4 linhas de 14 digitos e as 6 de lixo de teste
// ("p:<test lead: dummy data for phone_number>") ficam com telefone NULL e aparecem no
// relatorio. A coluna e nullable e o contato da campanha e por e-mail: um telefone
// inventado seria pior que um vazio, porque alguem ligaria para ele.
function normalizarTelefone(bruto) {
  const digitos = String(bruto == null ? '' : bruto).replace(/\D/g, '');

  let nacional = null;
  if (digitos.length === 13 && digitos.startsWith('55')) nacional = digitos.slice(2);
  else if (digitos.length === 12 && digitos.startsWith('55')) nacional = digitos.slice(2);
  else if (digitos.length === 11 || digitos.length === 10) nacional = digitos;

  if (!nacional) return { telefone: null, anomalia: digitos.length };
  return { telefone: `+55 ${nacional}`, anomalia: null };
}

// ── Data de criacao ──
//
// O CSV traz "2025-09-29 03:04:27.981392+00" (Postgres timestamptz). `talentos.criado_em`
// usa o formato do datetime('now') do SQLite: "YYYY-MM-DD HH:MM:SS", em UTC, sem fracao e
// sem offset. Converter e obrigatorio, e nao cosmetico: listarTalentosParaCampanha compara
// com `date(t.criado_em)`, e o date() do SQLite nao entende o offset "+00" nem a fracao de
// microssegundos — a linha simplesmente nao casaria com nenhuma janela de datas.
//
// Passa por Date (e nao por fatiamento de string) para que um offset diferente de +00 num
// export futuro seja convertido para UTC de verdade, em vez de truncado com a hora errada.
// Todo o export atual e +00, entao hoje as duas rotas dariam o mesmo resultado.
//
// Devolve null quando a data e ilegivel — quem chama descarta a linha e conta.
function normalizarDataCriacao(bruto) {
  const s = String(bruto == null ? '' : bruto).trim();
  if (!s) return null;

  // "2025-09-29 03:04:27.981392+00" -> "2025-09-29T03:04:27.981392+00:00". O Date do Node
  // aceita o ISO com T e exige o offset com dois pontos.
  const iso = s.replace(' ', 'T').replace(/([+-]\d{2})$/, '$1:00');
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;

  return d.toISOString().replace('T', ' ').slice(0, 19);
}

// ── campos_extras ──
//
// So os tres metadados da origem que nao tem coluna propria. `codigo_vaga` e `codigo_ps`
// carregam o mesmo tipo de valor (PS000X) em colunas diferentes do export — 4.367 linhas
// tem o primeiro, 1.040 o segundo —, entao vale o que estiver preenchido, com `codigo_vaga`
// na frente por ser o mais povoado.
//
// Chave AUSENTE quando o dado nao existe, em vez de null: o JSON e para leitura humana em
// auditoria, e `{}` diz "esta pessoa nao trouxe metadado" com menos ruido que tres nulls.
function montarCamposExtras(linha) {
  const extras = {};
  const pegar = (v) => {
    const s = String(v == null ? '' : v).trim();
    return s || null;
  };

  const empresa = pegar(linha.empresa);
  const codigo = pegar(linha.codigo_vaga) || pegar(linha.codigo_ps);
  const utm = pegar(linha.utm_source);

  if (empresa) extras.empresa_origem = empresa;
  if (codigo) extras.codigo_vaga_origem = codigo;
  if (utm) extras.utm_source_origem = utm;

  return extras;
}

// ══════════════════════════════════════════════════════════════
// A pipeline
// ══════════════════════════════════════════════════════════════

// Transforma as linhas cruas nos registros prontos para db.criarTalentosLegado.
//
//   linhas              array de objetos (saida de linhasComoObjetos)
//   emailsTalentos      Set/array de e-mails ja em `talentos`
//   emailsApplications  Set/array de e-mails ja em `applications`
//
// Os dois conjuntos sao normalizados aqui dentro por defesa — nenhum dos dois vem
// normalizado do banco (ver criarTalento e criarAplicacao, que gravam o valor cru).
//
// ── OS TRES EIXOS DE COLISAO, E POR QUE SO UM DELES EXCLUI ──
//   1. duplicata interna ao export  -> EXCLUI (fica a linha de created_at mais recente)
//   2. ja existe em `talentos`      -> EXCLUI. Seria uma segunda linha da mesma pessoa na
//      MESMA tabela, e `talentos.email` nao tem UNIQUE para barrar. Alem disso, a linha
//      existente veio de /bancodecurriculos e tem consent_at de verdade — sobrescreve-la
//      trocaria um consentimento real por um vazio.
//   3. ja existe em `applications`  -> NAO EXCLUI, so REPORTA. Sao tabelas separadas, com
//      finalidades LGPD distintas, e o proprio schema diz que nada as funde. Uma pessoa
//      pode legitimamente ser candidata a uma vaga E estar no banco de talentos. E nao ha
//      risco de e-mail duplicado por isso: lib/promocaoVagas agrupa por e-mail normalizado
//      na LEITURA e manda uma mensagem por pessoa, com `applications` vencendo na origem.
//      O numero entra no relatorio porque e informacao util sobre a sobreposicao das bases,
//      nao porque haja algo a corrigir.
function prepararImportacao({ linhas, emailsTalentos = [], emailsApplications = [] } = {}) {
  const jaEmTalentos = new Set([...emailsTalentos].map(normalizarEmail).filter(Boolean));
  const jaEmApplications = new Set([...emailsApplications].map(normalizarEmail).filter(Boolean));

  const relatorio = {
    linhasLidas: 0,
    excluidosPorCargo: new Map(), // bruto -> qtd (CS, fullstack)
    naoMapeados: new Map(), // bruto -> qtd  ← exige decisao humana
    semEmail: 0,
    semData: 0,
    duplicataInterna: 0,
    colisaoTalentos: 0,
    colisaoApplications: 0,
    telefoneAnomalo: 0,
    porCargo: new Map(), // canonico -> qtd (dos que serao inseridos)
    comPerfil: 0,
    semPerfil: 0,
    aInserir: 0,
  };

  const inc = (mapa, chave) => mapa.set(chave, (mapa.get(chave) || 0) + 1);

  // ── Passo 1: normalizar linha a linha, sem deduplicar ainda ──
  const candidatos = [];
  for (const linha of linhas || []) {
    relatorio.linhasLidas += 1;

    const cargo = normalizarCargo(linha.cargo);
    if (cargo.tipo === 'excluido') {
      inc(relatorio.excluidosPorCargo, cargo.bruto);
      continue;
    }
    if (cargo.tipo === 'naoMapeado') {
      inc(relatorio.naoMapeados, cargo.bruto);
      continue;
    }

    const email = normalizarEmail(linha.email);
    if (!email) {
      relatorio.semEmail += 1;
      continue;
    }

    const criadoEm = normalizarDataCriacao(linha.created_at);
    if (!criadoEm) {
      relatorio.semData += 1;
      continue;
    }

    const { telefone, anomalia } = normalizarTelefone(linha.whatsapp);
    if (anomalia !== null) relatorio.telefoneAnomalo += 1;

    candidatos.push({
      email,
      criadoEm,
      // Date so para a comparacao do dedupe. `criadoEm` (string ja no formato do SQLite) e
      // o que vai para o banco — comparar strings funcionaria neste export por sorte
      // (formato uniforme e UTC), e e exatamente esse tipo de sorte que quebra calado.
      _quando: new Date(`${criadoEm}Z`),
      registro: {
        nome: String(linha.fullname == null ? '' : linha.fullname).trim() || null,
        email,
        telefone,
        perfil_interesse: perfilDeCargo(cargo.cargo),
        categoria: CATEGORIA_LEGADO,
        cargo: cargo.cargo,
        campos_extras: JSON.stringify(montarCamposExtras(linha)),
        consent_at: null, // sempre: a origem nao tem dado de consentimento
        criado_em: criadoEm,
      },
    });
  }

  // ── Passo 2: deduplicar por e-mail, mantendo o created_at MAIS RECENTE ──
  const porEmail = new Map();
  for (const c of candidatos) {
    const atual = porEmail.get(c.email);
    if (!atual) {
      porEmail.set(c.email, c);
      continue;
    }
    relatorio.duplicataInterna += 1;
    // `>` e nao `>=`: com datas iguais fica a PRIMEIRA, que e a de menor id no export
    // (o arquivo vem ordenado por id). Empate resolvido de forma determinista.
    if (c._quando > atual._quando) porEmail.set(c.email, c);
  }

  // ── Passo 3: colisoes com o banco ──
  const registros = [];
  for (const c of porEmail.values()) {
    if (jaEmApplications.has(c.email)) relatorio.colisaoApplications += 1; // so informa
    if (jaEmTalentos.has(c.email)) {
      relatorio.colisaoTalentos += 1;
      continue; // este exclui
    }

    inc(relatorio.porCargo, c.registro.cargo);
    if (c.registro.perfil_interesse) relatorio.comPerfil += 1;
    else relatorio.semPerfil += 1;
    registros.push(c.registro);
  }

  relatorio.aInserir = registros.length;
  return { registros, relatorio };
}

module.exports = {
  parseCsv,
  linhasComoObjetos,
  normalizarCargo,
  perfilDeCargo,
  normalizarTelefone,
  normalizarDataCriacao,
  montarCamposExtras,
  prepararImportacao,
  DICIONARIO_CARGO,
  CARGO_EXCLUIR,
  CATEGORIA_LEGADO,
};
