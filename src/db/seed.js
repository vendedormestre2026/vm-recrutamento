'use strict';

// Popula o banco com dados de exemplo: 1 roteiro (SDR) + 1 vaga ativa (SDR).
// Espelha a secao 8 do PLANEJAMENTO_IMPLEMENTACAO.md (roteiro orientado a dados).
// Idempotente: se a vaga/roteiro ja existirem (por slug/nome), nao duplica.

const { migrar } = require('./migrate');
const db = require('./index');

// Roteiro SDR — formato COMPORTAMENTAL (blocos como objeto nomeado: abertura,
// competencias, roleplay, fechamento). Redesenho: o roteiro deixa de medir tecnica de
// vendas (abordagem, qualificacao, CRM, postura) e passa a medir COMPORTAMENTO em 3
// competencias de peso alto, mais um roleplay avaliado. Cada bloco tem UMA pergunta
// unica e direta — perguntas compostas ("X? E Y? E Z?") foram eliminadas, porque o LLM
// copia a semente literalmente e o candidato recebia 3-4 perguntas numa fala so.
// O bloco de fechamento e operacional (nao avaliado) e sai em 3 turnos separados.
const ROTEIRO_SDR = {
  nome: 'SDR - Padrão v1',
  perfil: 'SDR',
  versao: 3,
  estrutura: {
    perfil: 'SDR',
    instrucoes_gerais: [
      'Foque em COMPORTAMENTO: o que o candidato fez, por que fez e o que aprendeu. Nao avalie conhecimento tecnico de vendas nem metodologia nomeada.',
      'Se a resposta vier totalmente abstrata, peca UM exemplo concreto — no maximo uma vez por bloco. Depois disso, siga em frente com o que foi dito.',
      'Nunca verbalize julgamento, nota ou opiniao sobre a resposta: a avaliacao acontece depois, fora da conversa.',
    ],
    blocos: {
      abertura: {
        nome: 'Abertura',
        avaliado: false,
        pergunta_semente: 'Me conta sua trajetória em vendas até aqui.',
        observacao: 'Bloco de contexto, não gera nota de competência.',
      },
      competencias: [
        {
          id: 'resiliencia',
          nome: 'Resiliência',
          peso: 3,
          pergunta_semente:
            'Descreva um dia de prospecção que foi particularmente difícil pra você.',
          boa_resposta:
            'Demonstra constância e método pra manter ritmo, sem terceirizar frustração.',
        },
        {
          id: 'ambicao_fome',
          nome: 'Ambição/Fome',
          peso: 3,
          pergunta_semente:
            'O que te faz continuar buscando mais, mesmo num dia em que você já bateu o mínimo esperado?',
          boa_resposta: 'Motivação intrínseca clara, não só meta imposta de fora.',
        },
        {
          id: 'fit_cultural',
          nome: 'Fit cultural',
          peso: 2,
          pergunta_semente: 'O que é inegociável pra você num ambiente de trabalho?',
          boa_resposta: 'Valores concretos e específicos, com exemplo real.',
        },
      ],
      roleplay: {
        id: 'simulacao_qualificacao',
        nome: 'Simulação de qualificação',
        avaliado: true,
        peso: 2,
        contexto_abertura:
          'Agora vou simular ser um lead que você está prospectando. Vou te colocar uma objeção real. Pode começar a ligação.',
        objecao_padrao:
          'Olha, agora não é um bom momento, e eu já uso outro fornecedor pra isso.',
        instrucao_vera:
          'Use essa objeção uma única vez. Se o candidato responder com qualquer argumento razoável — mesmo simples, mesmo sem técnica nomeada — reconheça brevemente e avance para a pergunta de fechamento da simulação. Nunca repita a mesma objeção duas vezes.',
        pergunta_fechamento_simulacao: 'Saindo do papel: como você avalia essa ligação?',
        max_trocas: 3,
        // boa_resposta NAO veio na especificacao do redesenho; redigida aqui para que a
        // competencia do roleplay tenha referencia de avaliacao no relatorio (relatorio.js
        // deriva a lista de competencias do roteiro). Revisar com o Jean.
        boa_resposta:
          'Reage a objecao sem travar nem insistir no mesmo argumento; devolve com pergunta ou reenquadra a conversa. Na autoavaliacao, e honesto sobre o proprio desempenho, sem se supervalorizar nem se demolir.',
      },
      fechamento: {
        nome: 'Fechamento',
        avaliado: false,
        perguntas: [
          'Qual é sua disponibilidade para início?',
          'Qual é sua expectativa de remuneração?',
          'Por que deveríamos te escolher entre os candidatos?',
        ],
        observacao: '3 perguntas, 3 turnos separados — nunca despejar juntas.',
      },
    },
    rubrica: {
      escala: '1-5',
      saida: 'nota + justificativa curta por competencia, mais resumo e pontos de atencao',
    },
  },
};

const VAGA_SDR = {
  slug: 'sdr-prevendas',
  titulo: 'SDR / Pré-vendas',
  perfil: 'SDR',
  faixa_pagamento: 'R$ 2.000 fixo + comissões (até R$ 4.500)',
  skills: ['Prospecção ativa', 'Qualificação de leads', 'CRM', 'Resiliência', 'Cadência de follow-up'],
  descricao:
    'Buscamos um SDR para prospecção e qualificação de leads, com ritmo, organização e ' +
    'resiliência. Você será a primeira voz do cliente e a porta de entrada do nosso funil.',
  sobre_empresa:
    'Somos uma operação comercial orientada a método e performance. Aqui vendas é' +
    ' levado a sério: processo claro, ferramentas boas e cultura de alta exigência.',
  ativo: true,
};

function semear() {
  migrar(); // garante que as tabelas existam

  // Roteiro (idempotente por nome)
  let roteiro = db.obterRoteiroPorNome(ROTEIRO_SDR.nome);
  let roteiroId;
  if (roteiro) {
    roteiroId = roteiro.id;
    console.log(`[seed] roteiro "${ROTEIRO_SDR.nome}" ja existe (id=${roteiroId}).`);
  } else {
    roteiroId = db.criarRoteiro(ROTEIRO_SDR);
    console.log(`[seed] roteiro criado (id=${roteiroId}).`);
  }

  // Vaga (idempotente por slug)
  const existente = db.obterVagaPorSlug(VAGA_SDR.slug);
  if (existente) {
    console.log(`[seed] vaga "${VAGA_SDR.slug}" ja existe (id=${existente.id}).`);
    return { roteiroId, vagaId: existente.id };
  }

  const vagaId = db.criarVaga({ ...VAGA_SDR, roteiro_id: roteiroId });
  console.log(`[seed] vaga criada (id=${vagaId}, slug=${VAGA_SDR.slug}).`);
  return { roteiroId, vagaId };
}

if (require.main === module) {
  try {
    const { roteiroId, vagaId } = semear();
    console.log(`[seed] concluido. roteiro_id=${roteiroId}, vaga_id=${vagaId}`);
  } catch (err) {
    console.error('[seed] falha:', err.message);
    process.exit(1);
  }
}

module.exports = { semear, ROTEIRO_SDR, VAGA_SDR };
