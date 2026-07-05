'use strict';

// Popula o banco com dados de exemplo: 1 roteiro (SDR) + 1 vaga ativa (SDR).
// Espelha a secao 8 do PLANEJAMENTO_IMPLEMENTACAO.md (roteiro orientado a dados).
// Idempotente: se a vaga/roteiro ja existirem (por slug/nome), nao duplica.

const { migrar } = require('./migrate');
const db = require('./index');

// Roteiro SDR — formato RICO (blocos array + competencias top-level), mesmo shape do
// Closer. Migrado do formato antigo/aninhado (item 7.2) SEM mudar o conteudo: mesmas
// perguntas, pesos, boas-respostas e nomes de bloco/competencia (chips e calculo de
// pontuacao inalterados). Sondas/instrucao_vera/metodo/pilares novos entram no item 7.3.
const ROTEIRO_SDR = {
  nome: 'SDR - Padrão v1',
  perfil: 'SDR',
  versao: 1,
  estrutura: {
    perfil: 'SDR',
    blocos: [
      {
        id: 'abertura',
        nome: 'Abertura',
        obrigatorio: true,
        perguntas: [
          'O que te atrai em trabalhar com vendas?',
          'Conte rapidamente sua experiência mais recente na área.',
        ],
      },
      {
        id: 'resiliencia_volume',
        nome: 'Resiliência/volume',
        obrigatorio: true,
        pergunta_semente:
          'Conte um dia de muitas tentativas e poucos retornos. Como manteve o ritmo?',
        competencias_alvo: ['resiliencia_volume'],
      },
      {
        id: 'abordagem_comunicacao',
        nome: 'Abordagem/comunicação',
        obrigatorio: true,
        pergunta_semente: 'Como aborda um lead frio nos primeiros 30 segundos?',
        competencias_alvo: ['abordagem_comunicacao'],
      },
      {
        id: 'qualificacao',
        nome: 'Qualificação',
        obrigatorio: true,
        pergunta_semente:
          'Quando percebeu que um lead não era qualificado? Como concluiu isso?',
        competencias_alvo: ['qualificacao'],
      },
      {
        id: 'organizacao_crm',
        nome: 'Organização/CRM',
        obrigatorio: true,
        pergunta_semente:
          'Como se organiza para não perder follow-ups? Que ferramentas usa?',
        competencias_alvo: ['organizacao_crm'],
      },
      {
        id: 'fechamento',
        nome: 'Fechamento',
        obrigatorio: true,
        perguntas: [
          'Disponibilidade de início.',
          'Expectativa de remuneração/comissão.',
          'Por que deveríamos te escolher?',
        ],
      },
    ],
    competencias: [
      {
        id: 'resiliencia_volume',
        nome: 'Resiliência/volume',
        peso: 2,
        boa_resposta:
          'Demonstra constância, método para manter ritmo e não terceiriza a culpa.',
      },
      {
        id: 'abordagem_comunicacao',
        nome: 'Abordagem/comunicação',
        peso: 1,
        boa_resposta:
          'Tem abertura clara, gera valor rápido e desperta interesse sem ser invasivo.',
      },
      {
        id: 'qualificacao',
        nome: 'Qualificação',
        peso: 2,
        boa_resposta:
          'Usa critérios (ex.: BANT/perfil), faz perguntas certas e decide com objetividade.',
      },
      {
        id: 'organizacao_crm',
        nome: 'Organização/CRM',
        peso: 1,
        boa_resposta: 'Tem rotina, cadência e usa CRM/ferramentas de forma disciplinada.',
      },
    ],
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
