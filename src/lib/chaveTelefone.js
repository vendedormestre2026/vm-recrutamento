'use strict';

// Chave CANONICA de telefone — a identidade de supressao do opt-out de WhatsApp.
//
// Modulo-FOLHA (nenhum require proprio), de proposito: e importado tanto por db/sqlite.js
// (que grava e consulta whatsapp_optout) quanto pelos motores de envio e pelas rotas —
// mesmo raciocinio de lib/normalizarEmail.js, lib/slug.js e lib/templatesWhatsapp.js, que
// a camada de dados importa sem abrir ciclo.
//
// ══════════════════════════════════════════════════════════════
// POR QUE A CHAVE E "DDI + DDD + ULTIMOS 8 DIGITOS"
// ══════════════════════════════════════════════════════════════
//
// Porque o telefone NAO e uma chave estavel nesta base. A mesma pessoa aparece gravada de
// duas formas — com e sem o nono digito do celular — e as duas grafias sao numeros
// diferentes para qualquer comparacao por igualdade:
//
//     5531996820290   (com o 9)
//     553196820290    (sem o 9)
//
// Levantamento read-only em producao (2026-09-05, applications + talentos +
// campanha_whatsapp_envios + disparos_whatsapp): 13.774 chaves canonicas, das quais 7
// reunem mais de um numero normalizado — 14 numeros distintos que sao, na verdade, 7
// pessoas. Sem esta funcao, uma dessas pessoas pede descadastro por um dos numeros e
// continua recebendo pelo outro, e o sintoma para ela e "eu pedi e voces ignoraram".
//
// Os ULTIMOS 8 digitos sao a parte que o nono digito nao move: ele foi acrescentado a
// ESQUERDA do numero local em 2016, entao o sufixo de 8 e o mesmo antes e depois. Comparar
// por ele e o que faz as duas grafias colapsarem numa identidade so.
//
// ── O CUSTO DESTA ESCOLHA, MEDIDO E ACEITO ──
// Dois numeros que diferem SO no digito imediatamente apos o DDD colapsam na mesma chave
// mesmo sendo numeros diferentes. Ha um caso assim em producao:
//
//     5548984198576  e  5548684198576  ->  554884198576
//
// O segundo tem 11 digitos e comeca com 6 no lugar do 9 — nao e celular valido (o nono
// digito e obrigatorio desde 2016), entao e quase certo um erro de digitacao do mesmo
// numero. Mas o cenario generico existe, e o resultado dele e sempre o mesmo: alguem que
// NAO pediu para sair deixa de receber campanha. Essa e a direcao segura do erro. A
// alternativa (chave exata) erra para o outro lado — manda mensagem para quem pediu para
// parar —, que e o erro que este projeto inteiro existe para eliminar.
//
// ══════════════════════════════════════════════════════════════
// AS TRES PROCEDENCIAS QUE ESTA FUNCAO PRECISA ACEITAR
// ══════════════════════════════════════════════════════════════
//
// Ela e chamada com valores de origens que NAO concordam entre si — e por isso nao pode
// delegar para nenhuma das duas normalizacoes existentes, que tem contratos opostos:
//
//   normalizarTelefoneWhatsapp   telefone digitado em formulario. So reconhece DDI quando a
//                                string comeca com '+'; sem '+', prefixa 55.
//   normalizarTelefoneRecebido   telefone que volta do nosso proprio sistema, ja normalizado
//                                (so digitos, com DDI, sem '+'). Detecta o DDI por TAMANHO.
//   formulario cru               "+55 (47) 99958-2500", "47 9 9958 2500", "  5547999582500 "
//
// Aqui a leitura e por ESTRUTURA, nao por procedencia: joga fora tudo que nao e digito e
// pergunta o que sobrou parece. E o unico jeito de as tres origens produzirem a mesma chave.

// Faixa de sanidade. Os mesmos limites de lib/whatsapp.js: abaixo de 10 digitos nao ha
// DDD + numero; acima de 15 sai do E.164.
const MIN_DIGITOS = 10;
const MAX_DIGITOS = 15;

// DDI assumido quando o numero vem sem codigo de pais. Mesma premissa BR-only ja assumida
// por normalizarTelefoneRecebido em lib/whatsapp.js, e registrada la como debito conhecido:
// a base e ~100% brasileira. Um numero internacional de 10-11 digitos ganharia um 55
// indevido aqui — o mesmo comportamento que o resto do projeto ja tem, nao uma regressao
// nova. Se um dia a base deixar de ser BR-only, os dois pontos mudam juntos.
const DDI_PADRAO = '55';

// Numero BR completo: 55 + DDD(2) + local(8 fixo, ou 9 celular).
const RE_BR_COM_DDI = /^55(\d{2})(\d{8,9})$/;
// Numero BR sem DDI: DDD(2) + local(8 ou 9).
const RE_BR_SEM_DDI = /^(\d{2})(\d{8,9})$/;
// DDI 55 DUPLICADO na origem. Dado real de producao (applications id 336): o seletor de DDI
// do formulario prefixa "+55 " e a pessoa digitou o numero ja com +55, gravando
// "+55 +5547988301250" -> 555547988301250. Esse valor cabe no teto [10,15] e NAO e recusado
// por normalizarTelefoneWhatsapp; quem o recusa e o contrato de ida-e-volta dos motores.
// Aqui ele precisa ser ACEITO e colapsar na mesma chave do numero correto — senao a pessoa
// cujo cadastro esta corrompido e justamente a que continua recebendo depois de pedir para
// sair. A regex exige a estrutura inteira (55 + 55 + 10 ou 11 digitos), entao nao ha como
// ela morder um numero legitimo que por acaso comece com 55.
const RE_DDI_DUPLICADO = /^5555(\d{10,11})$/;

// Devolve a chave canonica, ou null quando nao ha telefone reconhecivel.
//
// NUNCA LANCA. Todos os chamadores sao fronteiras que recebem dado de fora (rota publica,
// formulario do painel, linha de fila) — null e "nao ha nada a suprimir", nunca um erro.
// Entrada suja e o caso NORMAL: null, undefined, '', '   ', '+55 (47) 99958-2500', numero.
function chaveCanonicaTelefone(telefone) {
  if (telefone == null) return null;
  // String(...) antes do replace: um numero JS (ou qualquer outro tipo) nao pode derrubar
  // a funcao. `.replace(/\D/g, '')` ja remove '+', espaco, parenteses, hifen e ponto — nao
  // ha lista de caracteres a manter em sincronia com formato de formulario nenhum.
  let digitos = String(telefone).replace(/\D/g, '');
  if (!digitos) return null;

  // DDI duplicado ANTES de qualquer outra leitura: enquanto ele estiver ali, o numero nao
  // casa com nenhuma das duas estruturas BR. `while` e nao `if` porque um dado triplamente
  // prefixado (nunca visto, mas nada o impede) tambem precisa convergir; a condicao encolhe
  // a string a cada volta, entao o laco termina sempre.
  let m = RE_DDI_DUPLICADO.exec(digitos);
  while (m) {
    digitos = `${DDI_PADRAO}${m[1]}`;
    m = RE_DDI_DUPLICADO.exec(digitos);
  }

  if (digitos.length < MIN_DIGITOS || digitos.length > MAX_DIGITOS) return null;

  const comDdi = RE_BR_COM_DDI.exec(digitos);
  if (comDdi) return `${DDI_PADRAO}${comDdi[1]}${comDdi[2].slice(-8)}`;

  const semDdi = RE_BR_SEM_DDI.exec(digitos);
  if (semDdi) return `${DDI_PADRAO}${semDdi[1]}${semDdi[2].slice(-8)}`;

  // Nao e BR reconhecivel (numero internacional, por exemplo). A chave e o numero inteiro:
  // o problema do nono digito e brasileiro, e inventar um truncamento para outros paises
  // fundiria numeros que nao tem nada a ver um com o outro. Cai aqui tambem o BR de formato
  // estranho — que continua tendo uma chave estavel, so que sem tolerancia ao 9.
  return digitos;
}

module.exports = { chaveCanonicaTelefone, MIN_DIGITOS, MAX_DIGITOS, DDI_PADRAO };
