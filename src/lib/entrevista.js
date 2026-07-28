'use strict';

// Motor de entrevista (orientado a dados pelo roteiro).
//
// Fase 3C (mock): monta a sequencia de perguntas a partir do roteiro e caminha
// por ela sem chamar STT/LLM/TTS (custo zero). O audio e um arquivo estatico.
//
// Fase 3-real (futuro): trocar o mock por:
//   - STT: transcrever o audio do candidato (providers/stt)
//   - LLM: gerar a proxima pergunta referenciando a resposta + curriculo (providers/llm)
//   - TTS: sintetizar a fala da Vera (providers/tts) e servir o audio
// O contrato de payload abaixo NAO muda — so a origem dos dados.

const db = require('../db');

// Audio mock da fala da Vera (usado quando INTERVIEW_MOCK=true).
const AUDIO_MOCK = '/assets/mock-fala.wav';

const FALA_FECHAMENTO =
  'Obrigada pelas suas respostas! Por aqui encerramos a entrevista. ' +
  'Vamos analisar tudo e a equipe de recrutamento entra em contato. Ate breve!';

// Fala de despedida personalizada com o nome do candidato. Usada nos encerramentos
// "amigaveis" (teto de perguntas e encerramento manual via /finish), onde queremos
// uma fala humana de fechamento em vez de uma pergunta inalcancavel. Quando o nome
// nao esta disponivel, cai numa saudacao sem nome (sem virgula solta).
function falaDespedida(nome) {
  const limpo = String(nome || '').trim();
  const saudacao = limpo
    ? `Foi um prazer conversar com você, ${limpo}!`
    : 'Foi um prazer conversar com você!';
  return (
    `${saudacao} Sua entrevista está concluída. ` +
    'Nossa equipe analisará suas respostas e entrará em contato em breve. ' +
    'Muito obrigada e boa sorte!'
  );
}

// Pergunta obrigatoria de abertura (Item 6): PRIMEIRA pergunta de TODA entrevista
// (SDR e Closer), injetada no codigo (nao nos dados) para valer tambem em roteiros
// futuros sem exigir que cada um a declare. Nao tem placeholder [nome].
const PERGUNTA_ABERTURA_OBRIGATORIA = 'Por que essa empresa é relevante para você?';

// Marcador que o LLM adiciona ao FINAL da fala quando decide encerrar.
const MARCADOR_ENCERRAR = '[ENCERRAR]';

// Frase fixa quando o STT nao entende o audio (TTS gerado e cacheado uma vez).
const FRASE_NAO_OUVI = 'Desculpe, nao consegui ouvir direito. Pode repetir, por favor?';

// Fala de transicao quando, apos repeticoes seguidas, a Vera segue mesmo assim
// (evita loop infinito de "nao consegui ouvir").
const FALA_TRANSICAO = 'Tudo bem, vamos seguir em frente.';

// Converte um datetime do SQLite ('YYYY-MM-DD HH:MM:SS', em UTC) para epoch ms.
function paraEpochMs(datetimeSqlite) {
  if (!datetimeSqlite) return NaN;
  // O 'Z' marca UTC; o SQLite grava datetime('now') em UTC sem timezone.
  const t = Date.parse(`${String(datetimeSqlite).replace(' ', 'T')}Z`);
  return Number.isFinite(t) ? t : NaN;
}

// Tempo decorrido (ms) desde o inicio da entrevista. 0 se a data for invalida.
function decorridoMs(iniciadoEm, agora = Date.now()) {
  const inicio = paraEpochMs(iniciadoEm);
  if (!Number.isFinite(inicio)) return 0;
  return Math.max(0, agora - inicio);
}

// Teto de duracao real: true se ja passou de maxMin minutos desde iniciado_em.
// ATENCAO: conta tempo de RELOGIO (inclui hiatos). Para o teto da entrevista use a
// variante ...Ativa abaixo; esta fica intacta para os chamadores que ja a usam.
function excedeuDuracao(iniciadoEm, maxMin, agora = Date.now()) {
  if (!maxMin || maxMin <= 0) return false;
  return decorridoMs(iniciadoEm, agora) >= maxMin * 60 * 1000;
}

// ── Duracao ATIVA (descontando pausas) ──
//
// Hiato a partir do qual consideramos que o candidato saiu (e nao apenas pensou um
// pouco antes de responder). Abaixo disso, o tempo continua contando normalmente — a
// entrevista nao vira "pausavel" por silencio curto.
const LIMIAR_PAUSA_MS = 10 * 60 * 1000; // 10 minutos

// Tempo efetivamente gasto na entrevista: relogio desde iniciado_em MENOS o tempo
// acumulado em pausas (interviews.tempo_pausado_ms). Nunca negativo. Com
// tempoPausadoMs = 0 (sessao continua, o caso normal) e identico a decorridoMs.
function decorridoAtivoMs(iniciadoEm, tempoPausadoMs, agora = Date.now()) {
  const pausado = Number(tempoPausadoMs);
  const desconto = Number.isFinite(pausado) && pausado > 0 ? pausado : 0;
  return Math.max(0, decorridoMs(iniciadoEm, agora) - desconto);
}

// Mesma regra de excedeuDuracao, porem sobre a duracao ATIVA. E esta que decide se a
// entrevista encerra por tempo: uma retomada tardia nao pode nascer estourada.
function excedeuDuracaoAtiva(iniciadoEm, tempoPausadoMs, maxMin, agora = Date.now()) {
  if (!maxMin || maxMin <= 0) return false;
  return decorridoAtivoMs(iniciadoEm, tempoPausadoMs, agora) >= maxMin * 60 * 1000;
}

// Trunca texto preservando o inicio (suficiente para contexto sem estourar tokens).
function truncar(texto, max) {
  const t = String(texto || '').trim();
  return t.length > max ? `${t.slice(0, max)}…` : t;
}

// Promise com timeout: rejeita se a chamada externa demorar demais (best-effort:
// limita a resposta HTTP; o socket subjacente pode ser descartado pelo runtime).
function comTimeout(promessa, ms, nome) {
  let timer;
  const limite = new Promise((_, rej) => {
    timer = setTimeout(() => rej(new Error(`Tempo esgotado ao chamar ${nome} (> ${ms}ms).`)), ms);
  });
  // clearTimeout ao resolver/rejeitar evita deixar o timer pendurado (segurando o
  // event loop) quando a promessa real responde antes do limite.
  return Promise.race([promessa, limite]).finally(() => clearTimeout(timer));
}

// ── Normalizacao do roteiro (entende o formato rico NOVO e o formato ANTIGO) ──
//
// Formato NOVO (Closer/BEI): estrutura = {
//   metodo, instrucoes_gerais:[...], blocos:[{ id, nome, obrigatorio, pergunta_semente,
//   sondas_bei:[...], instrucao_vera, perguntas:[...], ... }], competencias:[{ nome, peso,
//   boa_resposta }], rubrica:{ escala, saida } }.
// Formato COMPORTAMENTAL (redesenho atual, SDR e Closer): estrutura = {
//   instrucoes_gerais:[...], blocos:{ abertura:{ pergunta_semente, avaliado:false },
//   competencias:[{ id, nome, peso, pergunta_semente, boa_resposta }],
//   roleplay:{ nome, avaliado, peso, contexto_abertura, objecao_padrao, instrucao_vera,
//   pergunta_fechamento_simulacao, max_trocas, boa_resposta } (opcional, so SDR),
//   fechamento:{ avaliado:false, perguntas:[...] } }, rubrica }.
// Formato ANTIGO (seed SDR original): estrutura = {
//   blocos:{ abertura:[...], competencias:[{ nome, peso, ... }], fechamento:[...] }, rubrica }.
//
// Devolve UMA visao unica { metodo, instrucoesGerais, blocos[], competencias[], rubrica }
// usada por todo o motor. Nos formatos de OBJETO o `blocos` e convertido para um array
// equivalente (abertura -> 1 bloco; cada competencia -> 1 bloco; roleplay -> 1 bloco;
// fechamento -> 1 bloco), preservando o contrato de chips, perguntas e relatorio.
// A lista `competencias` (consumida por relatorio.js) sai das competencias declaradas
// mais, quando avaliado, a competencia derivada do roleplay.
function normalizarEstrutura(roteiro) {
  const est = (roteiro && roteiro.estrutura) || {};
  const rubrica = est.rubrica || {};
  const metodo = est.metodo || null;
  const instrucoesGerais = Array.isArray(est.instrucoes_gerais) ? est.instrucoes_gerais : [];

  // Competencias: no topo (novo) ou dentro de `blocos` (antigo).
  let competencias = [];
  if (Array.isArray(est.competencias)) {
    competencias = est.competencias;
  } else if (est.blocos && Array.isArray(est.blocos.competencias)) {
    competencias = est.blocos.competencias;
  }

  // Bloco de abertura/fechamento: aceita ARRAY de perguntas (formato antigo) ou OBJETO
  // { nome, avaliado, pergunta_semente | perguntas, observacao } (formato comportamental).
  // Devolve null quando o bloco nao existe ou nao tem pergunta alguma.
  function blocoSimples(entrada, idPadrao, nomePadrao) {
    if (Array.isArray(entrada)) {
      if (!entrada.length) return null;
      return { id: idPadrao, nome: nomePadrao, obrigatorio: true, avaliado: false, perguntas: entrada };
    }
    if (!entrada || typeof entrada !== 'object') return null;
    const perguntas = Array.isArray(entrada.perguntas) ? entrada.perguntas.filter(Boolean) : [];
    if (!perguntas.length && !entrada.pergunta_semente) return null;
    return {
      id: entrada.id || idPadrao,
      nome: entrada.nome || nomePadrao,
      obrigatorio: true,
      // avaliado default FALSE aqui: abertura e fechamento sao blocos de contexto/
      // operacionais — nao geram nota de competencia.
      avaliado: entrada.avaliado === true,
      observacao: entrada.observacao || null,
      ...(perguntas.length ? { perguntas } : { pergunta_semente: entrada.pergunta_semente }),
    };
  }

  // Bloco de ROLEPLAY (hoje so o SDR tem). A fala de entrada da simulacao vem em
  // `contexto_abertura`; a pergunta de saida do papel em `pergunta_fechamento_simulacao`
  // (renderizada no prompt como instrucao, nao como bloco separado — ela acontece DENTRO
  // do orcamento de trocas do proprio roleplay).
  function blocoRoleplay(rp) {
    if (!rp || typeof rp !== 'object') return null;
    const semente = rp.contexto_abertura || rp.pergunta_semente;
    if (!semente) return null;
    return {
      id: rp.id || 'roleplay',
      nome: rp.nome || 'Simulação',
      obrigatorio: true,
      avaliado: rp.avaliado !== false,
      pergunta_semente: semente,
      objecao_padrao: rp.objecao_padrao || null,
      instrucao_vera: rp.instrucao_vera || null,
      pergunta_fechamento_simulacao: rp.pergunta_fechamento_simulacao || null,
      max_trocas: Number(rp.max_trocas) > 0 ? Number(rp.max_trocas) : 1,
    };
  }

  // Blocos: array (formato rico do Closer/BEI e dos testes) ou objeto nomeado
  // { abertura, competencias, roleplay, fechamento } (formato comportamental e antigo).
  let blocos = [];
  let compRoleplay = null;
  if (Array.isArray(est.blocos)) {
    blocos = est.blocos;
  } else if (est.blocos && typeof est.blocos === 'object') {
    const o = est.blocos;

    const abertura = blocoSimples(o.abertura, 'abertura', 'Abertura');
    if (abertura) blocos.push(abertura);

    for (const c of o.competencias || []) {
      blocos.push({
        id: c.id ? `comp:${c.id}` : `comp:${c.nome}`,
        nome: c.nome,
        obrigatorio: true,
        avaliado: true,
        pergunta_semente: c.pergunta_semente || `Conte sobre ${c.nome}.`,
      });
    }

    const roleplay = blocoRoleplay(o.roleplay);
    if (roleplay) {
      blocos.push(roleplay);
      // Roleplay avaliado vira tambem uma COMPETENCIA (relatorio.js deriva a lista de
      // competencias daqui), com o peso declarado no proprio bloco.
      if (roleplay.avaliado) {
        compRoleplay = {
          id: roleplay.id,
          nome: roleplay.nome,
          peso: Number(o.roleplay.peso) > 0 ? Number(o.roleplay.peso) : 1,
          boa_resposta: o.roleplay.boa_resposta || null,
        };
      }
    }

    const fechamento = blocoSimples(o.fechamento, 'fechamento', 'Fechamento');
    if (fechamento) blocos.push(fechamento);
  }

  // A competencia do roleplay entra na lista avaliada se ainda nao estiver la (o roteiro
  // pode declara-la explicitamente em competencias; nesse caso a declaracao explicita manda).
  if (compRoleplay && !competencias.some((c) => c && c.nome === compRoleplay.nome)) {
    competencias = competencias.concat([compRoleplay]);
  }

  return { metodo, instrucoesGerais, competencias, blocos, rubrica };
}

// Perguntas "roteirizadas" de um bloco: a lista explicita (ex.: fechamento) ou, na
// falta dela, a pergunta-semente. Sondas/secundaria NAO entram aqui (sao guia para o
// LLM no system prompt, nao perguntas fixas do roteiro).
function perguntasDoBloco(bloco) {
  if (Array.isArray(bloco.perguntas) && bloco.perguntas.length) return bloco.perguntas;
  if (bloco.pergunta_semente) return [bloco.pergunta_semente];
  return [];
}

// Fase de um bloco a partir do id (para os chips de progresso).
function faseDoBloco(bloco) {
  if (bloco.id === 'abertura') return 'abertura';
  if (bloco.id === 'fechamento') return 'fechamento';
  return 'competencia';
}

// Nome da empresa para resolver o placeholder [nome da empresa] na pergunta de Principios
// (item 7.4). jobs NAO tem campo dedicado de nome de empresa (titulo = cargo, ex.:
// "SDR / Pré-vendas", que soaria errado na frase). Usamos fallback neutro "a empresa" —
// nunca vaza o placeholder literal e a frase fica gramaticalmente correta ("Se a empresa
// tivesse uma rotina dessas..."). Se um dia houver um campo dedicado, resolve-lo aqui.
function nomeEmpresaDaVaga(vaga) {
  const dedicado = vaga && vaga.empresa_nome ? String(vaga.empresa_nome).trim() : '';
  return dedicado || 'a empresa';
}

// Substitui [nome da empresa] (case-insensitive) pelo nome resolvido. NUNCA deixa o
// placeholder literal chegar ao candidato/LLM.
function interpolarEmpresa(texto, vaga) {
  return String(texto || '').replace(/\[nome da empresa\]/gi, nomeEmpresaDaVaga(vaga));
}

// Monta o system prompt da Vera a partir do roteiro (dados) + resumo do curriculo.
// Agora usa o roteiro RICO: instrucoes gerais, metodo, blocos (com pergunta-semente,
// sondas BEI e instrucao para a Vera) e os temas a explorar (nome + peso). Material
// avaliativo (boa_resposta, rubrica, o_que_observar) fica FORA da conducao: so o
// relatorio (relatorio.js) avalia, para nao vazar julgamento na fala ao candidato.
function montarSystemPrompt({ roteiro, curriculoTexto, agente, maxPerguntas, vaga }) {
  const { metodo, instrucoesGerais, competencias, blocos } = normalizarEstrutura(roteiro);
  // Item 7.4 — cultura/rotinas da vaga (contexto situacional p/ a pergunta de Principios).
  const culturaEmpresa = vaga && vaga.cultura_empresa ? String(vaga.cultura_empresa).trim() : '';

  // Condução usa APENAS nome + peso (cobertura/prioridade). boa_resposta e rubrica NAO
  // entram aqui: sao material de AVALIACAO e viviam no mesmo turno que gera a pergunta,
  // vazando julgamento na fala. A avaliacao acontece so depois, em relatorio.js (que tem
  // sua propria copia de boa_resposta/rubrica).
  const linhasCompetencias = competencias
    .map((c) => `- ${c.nome} (peso ${c.peso || 1})`)
    .join('\n');

  // Roteiro detalhado: por bloco, semente/perguntas + sondas BEI + instrucao da Vera.
  const linhasBlocos = blocos
    .map((b, i) => {
      const partes = [`${i + 1}. ${b.nome}${b.obrigatorio === false ? ' (opcional)' : ''}`];
      const perguntas = perguntasDoBloco(b);
      if (perguntas.length === 1) {
        partes.push(`   Pergunta-semente: ${perguntas[0]}`);
      } else if (perguntas.length > 1) {
        // Bloco com varias perguntas (ex.: Fechamento). O aviso de UM TURNO POR PERGUNTA
        // e explicito aqui porque a lista, sozinha, sugeria que as perguntas saiam juntas
        // numa unica fala — era uma das causas das perguntas combinadas.
        partes.push(
          `   Perguntas (${perguntas.length} no total) — faca UMA POR TURNO, em turnos ` +
            'SEPARADOS, aguardando a resposta do candidato antes da proxima. NUNCA junte ' +
            'duas delas na mesma fala:',
        );
        for (const q of perguntas) partes.push(`     - ${q}`);
      }
      if (b.pergunta_secundaria) partes.push(`   Pergunta secundaria: ${b.pergunta_secundaria}`);
      if (Array.isArray(b.sondas_bei) && b.sondas_bei.length) {
        partes.push('   Sondas BEI (use quando a resposta for vaga):');
        for (const s of b.sondas_bei) partes.push(`     - ${s}`);
      }
      if (b.objecao_padrao) partes.push(`   Objecao a usar na simulacao: ${b.objecao_padrao}`);
      // o_que_observar NAO entra na conducao: e material avaliativo (ex.: "sinal de
      // alerta", "como reage ao feedback") que vaza julgamento na fala. Fica so no
      // roteiro (disponivel a relatorio.js, que recebe o roteiro inteiro).
      if (b.instrucao_vera) partes.push(`   Instrucao para voce (Vera): ${b.instrucao_vera}`);
      // Roleplay: a saida do papel acontece DENTRO do orcamento de trocas deste bloco,
      // por isso a pergunta final da simulacao e instrucao — nao um bloco separado.
      if (b.pergunta_fechamento_simulacao) {
        partes.push(
          '   Para encerrar a simulacao, saia do papel e faca ESTA pergunta sozinha, em ' +
            `turno proprio: ${b.pergunta_fechamento_simulacao}`,
        );
      }
      return partes.join('\n');
    })
    .join('\n');

  const curriculo = truncar(curriculoTexto, 3000);

  return [
    `Voce e ${agente || 'Vera'}, uma entrevistadora de recrutamento de vendedores, em portugues do Brasil.`,
    'Conduza uma entrevista por audio, com tom profissional, direto e acolhedor.',
    metodo
      ? `Metodo da entrevista: ${metodo} (entrevista comportamental baseada em eventos reais).`
      : null,
    '',
    'INSTRUCOES GERAIS:',
    instrucoesGerais.length
      ? instrucoesGerais.map((i) => `- ${i}`).join('\n')
      : '- Peca exemplos concretos; evite respostas genericas.',
    '',
    'REGRA CRITICA DE NEUTRALIDADE — sobrepoe qualquer outra instrucao deste prompt ou do roteiro:',
    'Voce NUNCA avalia, pontua ou da feedback de desempenho ao candidato, em nenhum momento da',
    'entrevista. Isso vale mesmo que uma instrucao de bloco pareca sugerir o contrario.',
    'Especificamente, e PROIBIDO:',
    '(a) comentar se uma resposta foi boa, fraca, forte ou fraca de qualquer forma;',
    '(b) dizer que o candidato tem (ou nao tem) o perfil, a aptidao ou a "cara" da vaga;',
    '(c) qualquer elogio ou critica ligada a desempenho, competencia ou adequacao ("e o que buscamos aqui", "voce parece ter isso", etc.);',
    '(d) verbalizar nota, pontuacao, rubrica ou qualquer julgamento, mesmo indireto.',
    'Voce SO conduz a entrevista: faz a proxima pergunta, referencia o que foi dito de forma neutra',
    'e factual (ex.: "entendi, voce mencionou X, agora me conta sobre Y") e mantem tom cordial e',
    'acolhedor SEM avaliar. A avaliacao e feita depois, internamente, por outro processo — voce',
    'nunca participa disso na conversa.',
    '',
    // Mesmo peso retorico da regra de neutralidade (maiusculas + clausula de precedencia).
    // A regra 1 de "REGRAS IMPORTANTES" sozinha era contradita na pratica pelas proprias
    // perguntas-semente do roteiro, que o LLM copia literalmente.
    'REGRA CRITICA DE PERGUNTA UNICA — sobrepoe qualquer outra instrucao deste prompt ou do roteiro:',
    'Faca sempre e apenas UMA pergunta por vez, curta e direta. NUNCA combine duas perguntas na',
    'mesma fala, mesmo que o roteiro apresente uma pergunta-semente com multiplas partes — nesse',
    'caso, escolha a parte mais importante e faca so ela. NUNCA use "e" para conectar duas',
    'perguntas distintas numa mesma fala. Uma fala sua tem no maximo UM ponto de interrogacao.',
    '',
    'REGRA CRITICA DE NAO INSISTIR — sobrepoe qualquer outra instrucao deste prompt ou do roteiro:',
    'Depois de um follow-up, se o candidato ja respondeu — mesmo que nao seja a resposta ideal, ou',
    'fuja um pouco do ponto — reconheca brevemente e avance para o proximo bloco. NUNCA insista,',
    'repita a pergunta de outra forma, ou tente "puxar" uma resposta melhor. A qualidade da',
    'resposta e sinal de avaliacao, nao motivo para travar a conversa.',
    '',
    'REGRAS IMPORTANTES:',
    '1. Faca UMA pergunta por vez (curta e clara, falavel em voz alta).',
    '2. Referencie o que o candidato acabou de dizer antes de fazer a proxima pergunta, sempre de forma neutra (sem avaliar).',
    '3. Siga o roteiro de blocos na ordem. Quando a resposta for vaga, voce pode fazer NO MAXIMO UM follow-up por bloco (tambem uma pergunta unica); depois dele, avance — mesmo que a resposta continue imperfeita.',
    '3b. Cada bloco com uma unica pergunta-semente ocupa UM turno (mais, no maximo, o follow-up). Blocos com varias perguntas listadas ocupam UM TURNO POR PERGUNTA.',
    `4. Quando ja tiver coberto os blocos OU atingido ${maxPerguntas} perguntas, NAO faca outra pergunta nem escreva uma fala de encerramento: responda apenas com o marcador ${MARCADOR_ENCERRAR} sozinho. A despedida ao candidato e feita automaticamente pelo sistema.`,
    `5. Use o marcador ${MARCADOR_ENCERRAR} APENAS ao encerrar, nunca antes.`,
    '6. Nao invente informacoes do candidato; baseie-se no curriculo e nas respostas.',
    '7. Responda SEMPRE em texto corrido, como fala natural para ser lida em voz alta. NAO use formatacao markdown: nada de asteriscos (* ou **), sublinhados (_), crases (`), titulos (#), listas com marcadores ou emojis. Escreva apenas frases.',
    '',
    'ROTEIRO DA ENTREVISTA (blocos, na ordem):',
    interpolarEmpresa(linhasBlocos, vaga) || '- (roteiro sem blocos definidos)',
    '',
    // Contexto situacional da empresa: so entra se a vaga tiver cultura_empresa preenchida
    // (senao a secao inteira e omitida — null e filtrado abaixo).
    culturaEmpresa
      ? 'CONTEXTO DA EMPRESA (use apenas se relevante ao explorar a pergunta sobre rotinas/cultura da empresa):\n' +
        culturaEmpresa
      : null,
    culturaEmpresa ? '' : null,
    'TEMAS A EXPLORAR (uso interno — NUNCA comente isso com o candidato):',
    linhasCompetencias || '- (roteiro sem temas definidos)',
    '',
    'RESUMO DO CURRICULO DO CANDIDATO (para contexto):',
    curriculo || '(curriculo nao disponivel)',
  ]
    .filter((l) => l !== null)
    .join('\n');
}

// Monta as mensagens para o LLM: system + (resumo dos turns antigos) + ultimos N turns.
//   turns: [{ autor: 'agente'|'candidato', texto }] em ordem
function montarMensagensLLM({ systemPrompt, turns, recentes }) {
  const mensagens = [{ papel: 'system', conteudo: systemPrompt }];
  const lista = turns || [];

  if (lista.length > recentes) {
    const antigos = lista.slice(0, lista.length - recentes);
    const resumo = antigos
      .map((t) => `${t.autor === 'agente' ? 'Vera' : 'Candidato'}: ${truncar(t.texto, 240)}`)
      .join('\n');
    mensagens.push({
      papel: 'system',
      conteudo: `RESUMO DOS TURNOS ANTERIORES (mais antigos):\n${resumo}`,
    });
  }

  for (const t of lista.slice(-recentes)) {
    mensagens.push({
      papel: t.autor === 'agente' ? 'assistant' : 'user',
      conteudo: t.texto || '',
    });
  }
  return mensagens;
}

// Remove marcadores markdown da fala da Vera antes do TTS e da exibicao. Rede de
// seguranca independente do system prompt: mesmo que o LLM desobedeca e devolva
// **negrito**, `codigo`, # titulos etc., o candidato nunca ve nem ouve os simbolos.
// Preserva o TEXTO, remove so a pontuacao de marcacao.
function removerMarkdown(texto) {
  let t = String(texto || '');

  // Blocos/inline de codigo: remove crases, mantem o conteudo.
  t = t.replace(/```+/g, '').replace(/`([^`]+)`/g, '$1').replace(/`/g, '');

  // Links e imagens: [texto](url) -> texto ; ![alt](url) -> alt
  t = t.replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1');

  // Negrito/italico/sublinhado (1 a 3 marcadores ao redor do conteudo).
  t = t.replace(/(\*{1,3})(\S(?:.*?\S)?)\1/g, '$2');
  t = t.replace(/(_{1,3})(\S(?:.*?\S)?)\1/g, '$2');

  // Titulos e citacoes no inicio da linha: remove '#', '>' e marcadores de lista.
  t = t.replace(/^\s{0,3}#{1,6}\s+/gm, '');
  t = t.replace(/^\s{0,3}>\s?/gm, '');
  t = t.replace(/^\s{0,3}(?:[-*+]|\d+\.)\s+/gm, '');

  // Marcadores de enfase residuais (pares nao casados).
  t = t.replace(/[*_]{1,3}/g, '');

  // Normaliza espacos horizontais.
  return t.replace(/[ \t]{2,}/g, ' ').trim();
}

// Separa o marcador de encerramento da fala da Vera.
function extrairEncerrar(texto) {
  const t = String(texto || '');
  if (t.includes(MARCADOR_ENCERRAR)) {
    return { texto: t.split(MARCADOR_ENCERRAR).join('').trim(), encerrar: true };
  }
  return { texto: t.trim(), encerrar: false };
}

// Monta a lista linear de perguntas a partir do roteiro (blocos na ordem). Cada bloco
// contribui com sua(s) pergunta(s) roteirizada(s); o topico (chip) e o nome do bloco.
//
// Roteiro comportamental (redesenho): 1 abertura (nao avaliada) + 3 competencias
// (avaliadas) + roleplay (so SDR, avaliado, max_trocas=3) + 3 perguntas de fechamento
// (nao avaliadas). O fechamento vira 3 ENTRADAS distintas (maxTrocas=1 cada), logo 3
// turnos separados e UM unico chip "Fechamento" — o ponteiro de progresso avanca uma
// posicao por troca. Chips resultantes: 6 no SDR e 5 no Closer (antes: 12 e 9).
// A pergunta obrigatoria de abertura (injetada abaixo) entra sob o chip da abertura.
function montarPerguntas(roteiro) {
  const { blocos } = normalizarEstrutura(roteiro);
  const perguntas = [];

  for (const bloco of blocos) {
    const fase = faseDoBloco(bloco);
    // Item 7.5: orcamento de trocas do bloco (roleplay). Default 1 = avanca imediatamente
    // (comportamento anterior). Propagado por pergunta achatada para o motor de progresso.
    const maxTrocas = Number(bloco.max_trocas) > 0 ? Number(bloco.max_trocas) : 1;
    for (const texto of perguntasDoBloco(bloco)) {
      perguntas.push({ fase, topico: bloco.nome, texto, maxTrocas });
    }
  }

  // Fallback minimo caso o roteiro venha vazio.
  if (!perguntas.length) {
    perguntas.push({ fase: 'abertura', topico: 'Abertura', texto: 'Conte sobre sua experiencia em vendas.', maxTrocas: 1 });
  }

  // Item 6: pergunta obrigatoria SEMPRE como 1a pergunta, precedendo a abertura
  // original de cada perfil (que passa a ser a 2a, na mesma ordem). Ponto UNICO de
  // convergencia dos dois formatos de roteiro (novo/antigo) e dos dois perfis — sem
  // duplicar logica por branch. Reusa fase/topico da abertura ja existente
  // (perguntas[0], sempre presente apos o fallback) para cair sob o MESMO chip de
  // progresso, sem criar um topico isolado.
  const aberturaRef = perguntas[0];
  perguntas.unshift({
    fase: aberturaRef.fase,
    topico: aberturaRef.topico,
    texto: PERGUNTA_ABERTURA_OBRIGATORIA,
    maxTrocas: 1, // pergunta obrigatoria = 1 troca (nunca roleplay)
  });

  return perguntas;
}

// ── Motor de progresso com orcamento de trocas (item 7.5) — funcao PURA e testavel ──
// Avanca o ponteiro de bloco respeitando o orcamento de trocas (max_trocas) do bloco
// atual. Cada chamada representa UMA troca concluida (uma resposta do candidato + fala
// da Vera). Enquanto o orcamento nao se esgota, o indice NAO avanca (a Vera segue no
// mesmo bloco, ex.: um roleplay multi-turno) e so o contador de trocas sobe. Ao atingir
// o orcamento, avanca uma posicao e zera as trocas. O indice nunca ultrapassa o fim do
// array (clamp). Usada SO no modo real (o mock mantem o avanco linear por contagem bruta).
function avancarProgresso({ indiceAtual, trocasAtual, perguntas }) {
  const idx = Number(indiceAtual) || 0;
  const trocas = Number(trocasAtual) || 0;
  const lista = Array.isArray(perguntas) ? perguntas : [];
  const pergunta = lista[idx];
  const maxTrocas = pergunta && Number(pergunta.maxTrocas) > 0 ? Number(pergunta.maxTrocas) : 1;
  const novasTrocas = trocas + 1;
  if (novasTrocas >= maxTrocas) {
    const novoIndice = Math.min(idx + 1, Math.max(0, lista.length - 1));
    return { indice: novoIndice, trocas: 0 };
  }
  return { indice: idx, trocas: novasTrocas };
}

// Lista ordenada de topicos unicos (para os chips de progresso).
function topicosUnicos(perguntas) {
  const vistos = [];
  for (const p of perguntas) if (!vistos.includes(p.topico)) vistos.push(p.topico);
  return vistos;
}

// Estado de cada topico em relacao a pergunta atual (para os chips).
function estadoTopicos(perguntas, indice) {
  const unicos = topicosUnicos(perguntas);
  const topicoAtual = perguntas[indice] ? perguntas[indice].topico : null;
  const posAtual = unicos.indexOf(topicoAtual);
  return unicos.map((nome, i) => ({
    nome,
    estado: i < posAtual ? 'concluido' : i === posAtual ? 'atual' : 'futuro',
  }));
}

// Monta o payload de uma pergunta (contrato consumido pelo front).
// O progresso/chips e derivado pela POSICAO (indice), tanto no mock quanto no real
// — no modo real o texto vem do LLM, mas os chips avancam pela contagem de turnos.
function montarPayload({ interviewId, perguntas, indice, texto, audioUrl, encerrar = false }) {
  const idxChips = Math.min(indice, perguntas.length - 1);
  return {
    ok: true,
    interview_id: interviewId,
    indice,
    total: perguntas.length,
    topico_atual: perguntas[idxChips] ? perguntas[idxChips].topico : null,
    topicos: estadoTopicos(perguntas, idxChips),
    pergunta: texto,
    audio_url: audioUrl,
    encerrar,
  };
}

function payloadPergunta({ interviewId, perguntas, indice, audioUrl }) {
  return montarPayload({
    interviewId,
    perguntas,
    indice,
    texto: perguntas[indice].texto,
    audioUrl,
  });
}

// Encerramento de entrevista (ponto unico). Toda forma de terminar uma entrevista
// (teto de perguntas, teto de duracao, perguntas esgotadas, encerramento do LLM, ou
// a rota /finish) deve passar por aqui — antes essa logica estava duplicada em 4
// lugares e 3 deles esqueciam de gerar o relatorio (bug). Ordem:
//   1) marca a interview como concluida;
//   2) marca a application como concluida;
//   3) dispara gerarRelatorio em FIRE-AND-FORGET (nunca bloqueia nem propaga; .catch
//      so loga, igual ao padrao que existia no /finish).
// O applicationId e derivado do interviewId pela camada de dados (auto-suficiente: o
// caller nao precisa passa-lo, evitando divergencia com o dono real da entrevista).
// `deps` e repassado a gerarRelatorio (injecao de dependencia usada pelos testes para
// nao tocar em rede). Retorna a promise do relatorio (ja com .catch) para os testes
// poderem aguardar; em producao o caller ignora (fire-and-forget).
function finalizarEntrevista(interviewId, deps = {}) {
  const entrevistaRow = db.obterInterview(interviewId);
  if (!entrevistaRow) throw new Error(`Entrevista ${interviewId} nao encontrada.`);

  db.finalizarInterview(interviewId);
  db.atualizarStatusAplicacao(entrevistaRow.application_id, 'concluido');

  // Status da IA — estado inicial da maquina de estados. CONDICIONAL (so grava se
  // ainda NULL): em reentrada, nao regride um terminal ja definido para 'processando'.
  db.definirStatusIaSeVazio(entrevistaRow.application_id, 'processando');

  // require tardio: relatorio.js requer este modulo (truncar/comTimeout); o require no
  // topo criaria um ciclo. Lazy aqui quebra o ciclo sem mudar o contrato.
  const { gerarRelatorio } = require('./relatorio');
  return gerarRelatorio(interviewId, deps).catch((err) => {
    console.error(
      `[entrevista] falha ao gerar relatorio da entrevista ${interviewId}: ${err.message}`,
    );
    // Falha na geracao do relatorio -> veredito terminal 'erro' (a application ja esta
    // 'concluido'; o status_ia so sai de 'processando' aqui ou no terminal do relatorio).
    db.definirStatusIa(entrevistaRow.application_id, 'erro');
  });
}

module.exports = {
  AUDIO_MOCK,
  FALA_FECHAMENTO,
  falaDespedida,
  PERGUNTA_ABERTURA_OBRIGATORIA,
  MARCADOR_ENCERRAR,
  FRASE_NAO_OUVI,
  FALA_TRANSICAO,
  decorridoMs,
  excedeuDuracao,
  LIMIAR_PAUSA_MS,
  decorridoAtivoMs,
  excedeuDuracaoAtiva,
  normalizarEstrutura,
  montarPerguntas,
  topicosUnicos,
  estadoTopicos,
  avancarProgresso,
  payloadPergunta,
  montarPayload,
  truncar,
  comTimeout,
  montarSystemPrompt,
  nomeEmpresaDaVaga,
  interpolarEmpresa,
  montarMensagensLLM,
  removerMarkdown,
  extrairEncerrar,
  finalizarEntrevista,
};
