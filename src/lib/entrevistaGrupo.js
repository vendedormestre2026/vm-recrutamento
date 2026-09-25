'use strict';

// Qual entrevista em grupo a mensagem automatica deve anunciar.
//
// Funcoes PURAS: recebem a vaga (linha de `jobs`, ou o objeto `job` que a fila monta) e o
// instante "agora", e devolvem o que o texto precisa. Sem banco, sem rede, sem relogio — o
// `agora` e sempre parametro, e e isso que torna "a reuniao 1 venceu" testavel sem esperar.
//
// ══════════════════════════════════════════════════════════════
// A REGRA DE NEGOCIO, E POR QUE ELA NAO PRECISA DE INTERVENCAO MANUAL
// ══════════════════════════════════════════════════════════════
//
// Cada vaga tem 1 link do Meet e ate 3 reunioes (data + horario). A mensagem usa SEMPRE a
// PROXIMA reuniao futura: passada a data/hora da reuniao 1, o texto passa a usar a 2, depois a
// 3, sozinho. Ninguem edita a vaga entre uma reuniao e a seguinte — era esse trabalho manual
// (e o risco de esquecer dele, mandando link vencido) que esta funcao existe para eliminar.
//
// ── NAO CONFIA NA ORDEM DOS SLOTS ──
// Os pares sao ORDENADOS por instante antes da escolha, e nao lidos na ordem 1, 2, 3. Um
// cadastro fora de ordem (a reuniao 2 antes da 1) e erro de digitacao provavel, e a leitura
// literal por slot mandaria a data errada. Ordenar custa uma linha e transforma o erro em
// nada. O formulario ainda avisa sobre a ordem (B3), mas o aviso e para o admin corrigir o
// cadastro — nao e o que protege a mensagem.
//
// ── SEM LINK, NAO HA CONVITE (decisao de negocio) ──
// `link_meet` vazio devolve null MESMO com datas futuras cadastradas. Uma mensagem que anuncia
// data e hora sem sala nao e um convite: e um compromisso que o candidato nao tem como cumprir,
// e ele nao tem a quem perguntar. Melhor cair no fallback ("estamos definindo as datas"), que e
// verdadeiro, do que mandar meia informacao.
//
// ── "AGORA" CONTA COMO FUTURA (>=) ──
// Uma sala que abre neste minuto ainda serve. A comparacao e inclusiva de proposito: o erro do
// outro lado (excluir a reuniao que esta comecando e cair no fallback) seria pior, porque
// manda "datas em breve" para alguem cuja reuniao esta acontecendo.

const { instanteDeBrasilia, formatarDataBrasilia, formatarHoraBrasilia } = require('./fusoBrasilia');

// Os tres slots. Lista explicita (e nao um laco de 1 a 3 montando nomes de coluna por
// template string) porque estes SAO os nomes das colunas: escrevê-los inteiros e o que faz um
// grep por 'entrevista_grupo_2_data' encontrar este arquivo.
const SLOTS = [
  { indice: 1, campoData: 'entrevista_grupo_1_data', campoHora: 'entrevista_grupo_1_hora' },
  { indice: 2, campoData: 'entrevista_grupo_2_data', campoHora: 'entrevista_grupo_2_hora' },
  { indice: 3, campoData: 'entrevista_grupo_3_data', campoHora: 'entrevista_grupo_3_hora' },
];

// Estados de UM slot, para o formulario poder explicar o problema por campo (B3) sem
// reimplementar a leitura:
//   'vazio'      nada cadastrado (o caso normal dos slots 2 e 3)
//   'incompleto' so a data, ou so a hora — o par nao forma um instante
//   'invalido'   os dois preenchidos, mas nao formam data/hora real (31/02, 25:00)
//   'ok'         forma um instante
const VAZIO = 'vazio';
const INCOMPLETO = 'incompleto';
const INVALIDO = 'invalido';
const OK = 'ok';

function texto(v) {
  return String(v == null ? '' : v).trim();
}

// O link do Meet da vaga, ou '' quando nao ha. Nao valida o formato da URL: quem faz isso e o
// formulario, no save (B3), onde ha um humano para corrigir. Aqui um link estranho e melhor que
// nenhum — ele ainda pode ser o link certo de uma sala que nao segue o padrao meet.google.com.
function linkMeetDe(vaga) {
  return texto(vaga && vaga.link_meet);
}

// Le os TRES slots com o estado de cada um. Ordem dos slots preservada (1, 2, 3): esta funcao
// serve a tela, que mostra os campos na ordem em que eles aparecem no formulario.
//
// `instante` e null em tudo que nao seja 'ok'.
function lerEntrevistasGrupo(vaga) {
  return SLOTS.map(({ indice, campoData, campoHora }) => {
    const data = texto(vaga && vaga[campoData]);
    const hora = texto(vaga && vaga[campoHora]);
    if (!data && !hora) return { indice, data, hora, instante: null, estado: VAZIO };
    if (!data || !hora) return { indice, data, hora, instante: null, estado: INCOMPLETO };
    const instante = instanteDeBrasilia(data, hora);
    if (!instante) return { indice, data, hora, instante: null, estado: INVALIDO };
    return { indice, data, hora, instante, estado: OK };
  });
}

// A proxima reuniao futura, ou null.
//
// Devolve o texto JA FORMATADO (dataTexto/horaTexto) junto do dado cru: quem monta a mensagem
// nao deveria precisar saber de Intl nem de fuso para escrever uma linha de texto, e duas
// formatacoes diferentes da mesma reuniao em dois canais e o tipo de divergencia que ninguem
// percebe até um candidato aparecer no horario errado.
function proximaEntrevistaGrupo(vaga, agora = new Date()) {
  const linkMeet = linkMeetDe(vaga);
  if (!linkMeet) return null;

  const referencia = agora instanceof Date ? agora : new Date(agora);
  if (Number.isNaN(referencia.getTime())) return null;
  const limite = referencia.getTime();

  const futuras = lerEntrevistasGrupo(vaga)
    .filter((e) => e.estado === OK && e.instante.getTime() >= limite)
    .sort((a, b) => a.instante.getTime() - b.instante.getTime());

  const proxima = futuras[0];
  if (!proxima) return null;

  return {
    indice: proxima.indice,
    data: proxima.data,
    hora: proxima.hora,
    instante: proxima.instante,
    dataTexto: formatarDataBrasilia(proxima.instante),
    horaTexto: formatarHoraBrasilia(proxima.instante),
    linkMeet,
  };
}

// A vaga tem reuniao futura utilizavel? Atalho de leitura para o admin sinalizar a vaga que
// cairia no fallback (B5) sem precisar do objeto inteiro.
function temEntrevistaGrupoFutura(vaga, agora = new Date()) {
  return proximaEntrevistaGrupo(vaga, agora) !== null;
}

module.exports = {
  proximaEntrevistaGrupo,
  temEntrevistaGrupoFutura,
  lerEntrevistasGrupo,
  linkMeetDe,
  SLOTS,
  VAZIO,
  INCOMPLETO,
  INVALIDO,
  OK,
};
