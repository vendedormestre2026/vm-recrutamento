'use strict';

// Painel do recrutador — Promocao de Vagas (/admin/promocao).
//
// ARQUIVO SEPARADO de routes/admin.js de proposito. admin.js ja tem ~4000 linhas e
// concentra 30+ rotas; esta feature sozinha somaria umas 400. O projeto ja tem precedente
// de dividir rotas por feature (routes/banco_curriculos.js, routes/api_banco_curriculos.js),
// entao isto segue pratica existente, nao inventa uma.
//
// COMO A AUTENTICACAO CHEGA AQUI: este modulo NAO tem checagem propria. Ele exporta uma
// FABRICA que devolve um Router, e admin.js o monta DEPOIS de `router.use(adminAuth)` —
// entao todas as rotas daqui herdam o gate do painel automaticamente. Se algum dia o mount
// subir para antes daquela linha, estas telas ficam publicas: o lugar do mount e parte da
// seguranca, nao detalhe de organizacao.
//
// A fabrica recebe os helpers de apresentacao que vivem em admin.js (paginaAdmin,
// formatarDataHora, fmtInt) em vez de importa-los: admin.js exporta o router, nao os
// helpers, e extrai-los para um modulo compartilhado seria um refactor que toca as ~15
// telas existentes — fora do escopo deste incremento, pelo mesmo motivo que a navegacao
// nao virou sistema de abas.
//
// A CAMPANHA NASCE EM 'rascunho' e nenhuma linha de campanha_envios existe ate o disparo.
// A materializacao do publico acontece no clique de disparar (POST /:id/disparar, abaixo),
// e nao na criacao, porque a lista muda entre criar o rascunho e revisar/disparar.
//
// O DISPARO EXIGE DOIS PASSOS (Incremento 7). O botao da tela de detalhe leva a uma tela
// intermediaria de confirmacao, que so entao POSTa o disparo de verdade. O primeiro POST
// NAO tem efeito colateral: ele so renderiza a confirmacao com o numero de destinatarios
// recalculado na hora. Sem esse intervalo, um clique errado enfileiraria uma campanha
// inteira — e nao existe cancelamento (fora do escopo deste incremento) nem "despublicar"
// e-mail enviado.

const express = require('express');
const db = require('../db');
const { listarPublicoCampanha, PERFIS_VALIDOS, RECOMENDACOES_VALIDAS } = require('../lib/promocaoVagas');
const { gerarSugestaoConteudo } = require('../lib/gerarSugestaoPromocao');
const {
  enfileirarCampanha,
  verificarPreCondicoesDisparo,
  ENVIOS_POR_CICLO,
} = require('../lib/dispararPromocao');
// Namespace (e nao desestruturado) porque a rota usa quatro coisas do modulo — a funcao de
// envio, o endereco configurado, o prefixo do assunto e o cooldown — e as tres ultimas so
// aparecem no texto da tela. Ler PREFIXO_ASSUNTO e COOLDOWN_SEGUNDOS de la, em vez de
// repetir "[TESTE]" e "60 s" no HTML, e o que impede a tela de prometer uma coisa e a lib
// fazer outra.
const emailTeste = require('../lib/emailTestePromocao');
const { escapeHtml } = require('../views');

// Mensagem por codigo de erro da sugestao. Fonte unica para a rota, no molde de
// MENSAGENS_IMPORT_ERRO (admin.js). Cada uma diz o que o Jean pode FAZER — "falhou" sem
// proximo passo nao ajuda ninguem.
const MENSAGENS_SUGESTAO_ERRO = {
  VAGA_NAO_ENCONTRADA:
    'Vaga não encontrada. Recarregue a página e escolha a vaga de novo.',
  LLM_INDISPONIVEL:
    'Não consegui falar com o modelo de IA agora. Tente de novo em instantes — ou escreva o texto à mão, que funciona igual.',
  SUGESTAO_TRUNCADA:
    'A sugestão veio cortada (a descrição da vaga é longa demais). Encurte a descrição da vaga e tente de novo, ou escreva o texto à mão.',
  SUGESTAO_FALHOU:
    'A IA respondeu num formato que não consegui aproveitar. Tente de novo; se repetir, escreva o texto à mão.',
};

// Rotulos de exibicao dos enums. Ficam aqui (camada de apresentacao) e nao na lib: a lib
// trabalha com os valores canonicos, a tela e que precisa de portugues.
const ROTULO_PERFIL = { SDR: 'SDR', CLOSER: 'Closer' };
const ROTULO_RECOMENDACAO = {
  avancar: 'Avançar',
  talvez: 'Em dúvida',
  descartar: 'Descartar',
};
const ROTULO_STATUS_CAMPANHA = {
  rascunho: 'Rascunho',
  enfileirada: 'Enfileirada',
  enviando: 'Enviando',
  concluida: 'Concluída',
  cancelada: 'Cancelada',
};

// Nome amigavel do atributo, usado nas linhas de "sem atributo" da previa.
const ROTULO_ATRIBUTO = {
  perfil: 'perfil',
  utmSource: 'origem',
  recomendacao: 'recomendação da IA',
};

function dataIsoValida(s) {
  return /^\d{4}-\d{2}-\d{2}$/.test(String(s || ''));
}

// ── Formulario -> criterios ──
//
// FONTE UNICA da traducao form->criterios: a previa e a criacao usam ESTA funcao, entao a
// campanha nunca e criada com um recorte diferente do que foi mostrado na tela. Separa-las
// seria a porta de entrada para o numero exibido e o numero gravado divergirem.
//
// Saneamento no mesmo espirito do resto do painel: valor fora do enum vira "filtro
// inativo", nunca erro. A lib sanea de novo por conta propria — aqui e para a tela
// conseguir redesenhar os selects com o valor que de fato valeu.
function lerCriteriosDoForm(b = {}) {
  const marcado = (campo) => b[campo] === '1' || b[campo] === 'on';
  const vagaNum = Number(b.vaga);

  return {
    jobIdAlvo: Number.isInteger(vagaNum) && vagaNum > 0 ? vagaNum : undefined,
    perfil: PERFIS_VALIDOS.includes(b.perfil) ? b.perfil : undefined,
    perfilIncluirSemAtributo: marcado('perfil_incluir_sem'),
    utmSource: b.origem ? String(b.origem) : undefined,
    utmSourceIncluirSemAtributo: marcado('origem_incluir_sem'),
    // Base e Cidade sao MULTI-SELECAO (checkboxes). O express entrega um `name` repetido
    // como array quando ha 2+ marcados e como STRING quando ha 1 so — dai o `[].concat`.
    // Sem isso, marcar uma unica cidade viraria um filtro por cada LETRA dela.
    bases: [].concat(b.base || []).map(String),
    cidades: [].concat(b.cidade || []).map(String),
    cidadeIncluirSemAtributo: marcado('cidade_incluir_sem'),
    recomendacao: RECOMENDACOES_VALIDAS.includes(b.recomendacao) ? b.recomendacao : undefined,
    recomendacaoIncluirSemAtributo: marcado('recomendacao_incluir_sem'),
    dataDe: dataIsoValida(b.de) ? b.de : undefined,
    dataAte: dataIsoValida(b.ate) ? b.ate : undefined,
  };
}

function criarRouterPromocao({ paginaAdmin, formatarDataHora, fmtInt }) {
  const router = express.Router();

  // ── Blocos de HTML (funcoes puras, no molde de camposVagaHtml/blocoLinksEtapa) ──

  function opcoes(atual, pares) {
    return pares
      .map(
        ([valor, rotulo]) =>
          `<option value="${escapeHtml(valor)}"${String(atual || '') === valor ? ' selected' : ''}>${escapeHtml(rotulo)}</option>`,
      )
      .join('');
  }

  // Checkbox "incluir quem nao tem o atributo". Aparece junto do proprio filtro (e nao
  // dentro do bloco de previa) porque ele e um CAMPO DO FORMULARIO: dois controles com o
  // mesmo `name` colidiriam no POST, e o estado precisa sobreviver ao re-submit.
  function checkIncluirSem(nome, marcado, rotulo) {
    return `
      <label class="campo-check" style="margin:.35rem 0 0;font-size:.85rem;">
        <input type="checkbox" name="${nome}" value="1"${marcado ? ' checked' : ''}>
        <span style="color:var(--cinza);text-transform:none;">${escapeHtml(rotulo)}</span>
      </label>`;
  }

  // Grupo de checkboxes de multi-selecao (Base e Cidade). Diferente de `opcoes`, que monta
  // <option> de dropdown: aqui cada valor e um checkbox proprio, todos com o MESMO `name`,
  // e o express os entrega como array.
  //
  // Nenhum marcado = filtro inativo, exatamente como o "Qualquer" dos dropdowns. Nao ha
  // opcao "Qualquer" desenhada porque ela ja e o estado natural de nada marcado — um
  // checkbox "Qualquer" competiria com os outros e criaria um estado ambiguo (marcado
  // junto com uma cidade, o que significaria?).
  function checkboxes(nome, pares, marcados) {
    const marcadosSet = new Set((marcados || []).map(String));
    return pares
      .map(
        ([valor, rotulo]) => `
        <label class="campo-check" style="margin:.2rem 0 0;font-size:.85rem;">
          <input type="checkbox" name="${nome}" value="${escapeHtml(valor)}"${marcadosSet.has(valor) ? ' checked' : ''}>
          <span style="color:var(--cinza);text-transform:none;">${escapeHtml(rotulo)}</span>
        </label>`,
      )
      .join('');
  }

  // Formulario de criacao. `criterios` e `valores` vem preenchidos no re-submit da previa,
  // para o Jean nunca perder o que digitou ao recalcular.
  function formularioCampanha({ vagas, origens, cidades = [], criterios = {}, valores = {}, erro = '', ok = '' } = {}) {
    const alerta = erro ? `<p class="aviso-alerta">${escapeHtml(erro)}</p>` : '';
    const confirmacao = ok ? `<p class="aviso-ok">${escapeHtml(ok)}</p>` : '';

    const opcoesVaga = vagas
      .map(
        (v) =>
          `<option value="${v.id}"${String(criterios.jobIdAlvo || '') === String(v.id) ? ' selected' : ''}>${escapeHtml(v.titulo || `Vaga ${v.id}`)} · ${escapeHtml(v.perfil)}</option>`,
      )
      .join('');

    const opcoesOrigem = origens
      .map(
        (o) =>
          `<option value="${escapeHtml(o.valor_canonico)}"${criterios.utmSource === o.valor_canonico ? ' selected' : ''}>${escapeHtml(o.label)}</option>`,
      )
      .join('');

    // Marca que o conteudo veio da IA. Nao e enfeite: quem revisa precisa saber que
    // aquele texto nao foi escrito por uma pessoa, e que revisar e obrigatorio, nao
    // opcional.
    //
    // MUDANCA vs. Incremento 6: a nota agora SOBREVIVE aos re-submits (ela viaja no campo
    // oculto `sugestao_gerada`), em vez de sumir no primeiro recalculo de previa. Duas
    // razoes: o texto continua sendo de origem IA depois de recalcular o publico — some-lo
    // era subdeclarar —, e ela compartilha o MESMO estado da trava da vaga abaixo. Se a
    // nota morresse no recalculo, a trava morreria junto e o furo que ela fecha voltaria a
    // existir depois de um clique em "Calcular previa".
    const notaSugestao = valores.sugestaoGerada
      ? `<p class="aviso-alerta" style="margin:0 0 1rem;">
           <b>Assunto e corpo abaixo foram gerados por IA</b> a partir dos dados da vaga.
           É um ponto de partida: leia, corrija e ajuste o tom antes de criar a campanha.
           Nada é enviado sem você criar a campanha e disparar.
         </p>`
      : '';

    // ── A vaga trava depois que o conteudo e gerado PARA ela ──
    //
    // O QUE ISTO IMPEDE: gerar a sugestao para a vaga A (o titulo dela entra no prompt e
    // sai no assunto e no corpo), trocar o select para B e criar a campanha. O resultado
    // seria uma campanha internamente consistente nos DADOS — job_id e criterios.jobIdAlvo
    // apontam para B, e a exclusao de "ja inscrito" protege B — mas com um e-mail que
    // divulga A. Ninguem percebe: nao ha erro, nao ha divergencia no banco, e o candidato
    // de B recebe uma mensagem sobre outra vaga.
    //
    // COMO: `disabled` sozinho NAO serve — campo desabilitado nao e enviado no submit, e a
    // vaga sumiria do POST seguinte. Entao o select desabilitado fica SEM `name` (e so
    // enfeite: mostra ao Jean qual vaga esta valendo) e quem carrega o valor e o hidden ao
    // lado. Um unico campo chamado `vaga` chega ao servidor, nos dois estados.
    const vagaTravada = Boolean(valores.sugestaoGerada);

    const campoVaga = vagaTravada
      ? `
          <label class="campo" style="max-width:520px;">
            <span>Vaga a divulgar</span>
            <select disabled aria-describedby="aviso-vaga-travada">
              ${opcoesVaga}
            </select>
          </label>
          <input type="hidden" name="vaga" value="${escapeHtml(String(criterios.jobIdAlvo || ''))}">
          <p id="aviso-vaga-travada" class="aviso-alerta" style="margin:-.6rem 0 1rem;">
            <b>Vaga travada</b> porque o conteúdo foi gerado para ela — o assunto e o corpo
            acima falam desta vaga. Trocar a vaga agora criaria uma campanha que divulga uma
            vaga para o público de outra.
            <button type="submit" class="btn btn--ghost" formaction="/admin/promocao/trocar-vaga"
                    style="margin-left:.4rem;">Trocar vaga</button>
            <span style="color:var(--cinza);font-size:.85rem;">
              (limpa o assunto e o corpo; os filtros de público são mantidos)
            </span>
          </p>`
      : `
          <label class="campo" style="max-width:520px;">
            <span>Vaga a divulgar</span>
            <select name="vaga" required>
              <option value="">Selecione…</option>
              ${opcoesVaga}
            </select>
          </label>
          <p style="margin:-.6rem 0 1rem;color:var(--cinza);font-size:.8rem;">
            Só vagas <b>ativas</b> aparecem aqui. Quem já se candidatou a esta vaga
            (mesmo com a candidatura arquivada) é excluído do público automaticamente.
          </p>`;

    // ── Botao de e-mail de teste ──
    //
    // BOTAO SEMPRE VIVO, inclusive sem endereco configurado. `disabled` de verdade era
    // permitido aqui (ao contrario da trava da vaga, nao ha nada a materializar por
    // engano), mas o projeto ja decidiu contra botao morto uma vez — ver blocoDisparo:
    // "um botao morto so ensinaria o Jean a ignorar o botao". A nota abaixo diz o que
    // fazer ANTES do clique, e o clique sem configuracao devolve a mesma instrucao com
    // mais detalhe. As duas mensagens levam ao mesmo lugar; nenhuma delas e um beco.
    const enderecoDeTeste = emailTeste.enderecoTeste();
    const notaTeste = enderecoDeTeste
      ? `Envia o assunto e o corpo <b>que estão aí em cima agora</b> para
         <b>${escapeHtml(enderecoDeTeste)}</b>, com o prefixo
         <b>${escapeHtml(emailTeste.PREFIXO_ASSUNTO.trim())}</b> no assunto. Não cria
         campanha, não gasta destinatário e pode ser repetido (a cada
         ${emailTeste.COOLDOWN_SEGUNDOS} s).`
      : `<b>Configure o e-mail de teste em <a href="/admin/config">Configurações</a></b>
         para usar este botão — ele sempre envia para aquele endereço fixo, nunca para um
         endereço digitado aqui.`;

    return `
      ${confirmacao}
      ${alerta}
      <form method="POST" action="/admin/promocao/previa">
        ${
          // Carrega o estado "ja calculei a previa" atraves dos submits que NAO recalculam
          // (o de sugestao). Sem isto, pedir uma sugestao de texto esconderia o botao de
          // criar e obrigaria a recalcular sem motivo.
          valores.previaCalculada ? '<input type="hidden" name="previa_calculada" value="1">' : ''
        }
        ${
          // Carrega a trava da vaga atraves de TODOS os submits do formulario (previa,
          // nova sugestao, criar). Sem este campo, "Calcular previa" devolveria a tela com
          // o select liberado e o texto da vaga antiga ainda no corpo — reabrindo o furo.
          valores.sugestaoGerada ? '<input type="hidden" name="sugestao_gerada" value="1">' : ''
        }
        <section class="rel-sec">
          <h2>Vaga e mensagem</h2>
          ${campoVaga}
          <p style="margin:0 0 1rem;">
            <button type="submit" class="btn btn--ghost" formaction="/admin/promocao/sugestao">
              ${vagaTravada ? 'Gerar outra sugestão para esta vaga' : 'Gerar sugestão de conteúdo'}
            </button>
            <span style="color:var(--cinza);font-size:.8rem;margin-left:.5rem;">
              Escreve assunto e corpo a partir dos dados da vaga. Você revisa depois.
            </span>
          </p>
          ${notaSugestao}
          <label class="campo" style="max-width:520px;">
            <span>Assunto do e-mail</span>
            <input type="text" name="assunto" value="${escapeHtml(valores.assunto || '')}"
              maxlength="200" placeholder="Ex.: Vaga aberta: Closer de Vendas">
          </label>
          <label class="campo">
            <span>Corpo do e-mail (HTML)</span>
            <textarea name="corpo_html" rows="10"
              placeholder="&lt;p&gt;Olá! Estamos com uma vaga aberta…&lt;/p&gt;">${escapeHtml(valores.corpo_html || '')}</textarea>
          </label>
          <p style="margin:.2rem 0 0;">
            <button type="submit" class="btn btn--ghost" formaction="/admin/promocao/teste">
              Enviar e-mail de teste para mim
            </button>
          </p>
          <p style="margin:.35rem 0 0;color:var(--cinza);font-size:.8rem;">
            ${notaTeste}
          </p>
        </section>

        <section class="rel-sec">
          <h2>Quem vai receber</h2>
          <p style="margin:.2rem 0 1rem;color:var(--cinza);font-size:.9rem;">
            Sem nenhum filtro, o público é <b>toda a base de contatos</b> (candidatos +
            banco de talentos), menos as exclusões automáticas. Cada filtro <b>estreita</b>
            o público: quem não tem o atributo filtrado fica de fora, a não ser que você
            marque a caixa correspondente.
          </p>
          <div class="admin-filtros" style="align-items:flex-start;">
            <div class="filtro">
              <span>Perfil</span>
              <select name="perfil">
                ${opcoes(criterios.perfil, [['', 'Qualquer'], ['CLOSER', 'Closer'], ['SDR', 'SDR']])}
              </select>
              ${checkIncluirSem('perfil_incluir_sem', criterios.perfilIncluirSemAtributo, 'incluir sem perfil')}
            </div>
            <div class="filtro">
              <span>Base</span>
              ${
                // Rotulos = os tres nomes que o Rafael usa para as bases. Os VALORES
                // ('candidatura', 'legado', 'proprio') sao os do motor e nao mudam: eles
                // viajam na query string, entram em `criterios` e ficam gravados no JSON de
                // campanhas.criterios como rastro historico. Trocar valor por causa de
                // rotulo reescreveria o significado de campanhas ja disparadas.
                checkboxes(
                  'base',
                  [
                    ['candidatura', 'Candidatos'],
                    ['legado', 'Base legada'],
                    ['proprio', 'Talentos'],
                  ],
                  criterios.bases,
                )
              }
              <span style="display:block;color:var(--cinza);font-size:.78rem;margin-top:.35rem;text-transform:none;">
                Nenhuma marcada = todas. Quem é candidato <b>e</b> talento casa com as duas.
              </span>
            </div>
            <div class="filtro">
              <span>Origem</span>
              <select name="origem">
                <option value=""${criterios.utmSource ? '' : ' selected'}>Qualquer</option>
                ${opcoesOrigem}
              </select>
              ${checkIncluirSem('origem_incluir_sem', criterios.utmSourceIncluirSemAtributo, 'incluir sem origem')}
              <span style="display:block;color:var(--cinza);font-size:.78rem;margin-top:.35rem;text-transform:none;">
                ⚠️ Origem só existe para <b>candidaturas</b> (vem da UTM do link). Todo
                talento — legado e cadastro próprio — conta como <b>sem origem</b>, então
                com este filtro ativo eles ficam de fora a menos que você marque
                "incluir sem origem".
              </span>
            </div>
            <div class="filtro">
              <span>Recomendação da IA</span>
              <select name="recomendacao">
                ${opcoes(criterios.recomendacao, [
                  ['', 'Qualquer'],
                  ['avancar', 'Avançar'],
                  ['talvez', 'Em dúvida'],
                  ['descartar', 'Descartar'],
                ])}
              </select>
              ${checkIncluirSem('recomendacao_incluir_sem', criterios.recomendacaoIncluirSemAtributo, 'incluir sem avaliação')}
            </div>
            <div class="filtro">
              <span>Cidade</span>
              ${
                cidades.length
                  ? checkboxes('cidade', cidades.map((c) => [c, c]), criterios.cidades) +
                    checkIncluirSem('cidade_incluir_sem', criterios.cidadeIncluirSemAtributo, 'incluir sem cidade') +
                    `<span style="display:block;color:var(--cinza);font-size:.78rem;margin-top:.35rem;text-transform:none;">
                       Nenhuma marcada = todas. Quem atende <b>todas as cidades</b> entra em
                       qualquer recorte automaticamente.
                     </span>`
                  : `<span style="color:var(--cinza);font-size:.8rem;text-transform:none;">
                       Nenhuma cidade cadastrada na base ainda.
                     </span>`
              }
            </div>
            <label class="filtro">
              <span>Candidatura de</span>
              <input type="date" name="de" value="${escapeHtml(criterios.dataDe || '')}">
            </label>
            <label class="filtro">
              <span>até</span>
              <input type="date" name="ate" value="${escapeHtml(criterios.dataAte || '')}">
            </label>
          </div>
        </section>

        <div style="display:flex;gap:.6rem;flex-wrap:wrap;align-items:center;">
          <button type="submit" class="btn">Calcular prévia</button>
          ${
            // O botao de CRIAR so aparece depois de uma previa. Nao e enfeite: criar
            // campanha sem ter visto o tamanho do publico e como assinar sem ler.
            valores.previaCalculada
              ? `<button type="submit" class="btn" formaction="/admin/promocao">Criar campanha (rascunho)</button>`
              : `<span style="color:var(--cinza);font-size:.85rem;">Calcule a prévia para poder criar a campanha.</span>`
          }
          <a class="btn btn--ghost" href="/admin/promocao">Cancelar</a>
        </div>
      </form>`;
  }

  // Bloco da previa. `resultado` vem de lib/promocaoVagas.listarPublicoCampanha.
  //
  // As linhas de "sem atributo" so aparecem para filtro ATIVO — excluidosPorFiltro.X vem
  // `null` quando o filtro nem foi ligado, e null e diferente de zero: "essa pergunta nao
  // foi feita" nao e a mesma informacao que "ninguem ficou de fora".
  function blocoPrevia(resultado) {
    const semAtributo = Object.entries(resultado.excluidosPorFiltro)
      .filter(([, n]) => n !== null && n > 0)
      .map(
        ([chave, n]) => `
          <li>
            <b>${fmtInt(n)}</b> ${n === 1 ? 'registro' : 'registros'} sem
            ${escapeHtml(ROTULO_ATRIBUTO[chave] || chave)} definido —
            marque <i>“incluir sem ${escapeHtml(ROTULO_ATRIBUTO[chave] || chave)}”</i>
            no filtro acima e recalcule para incluí-los.
          </li>`,
      )
      .join('');

    const vazio =
      resultado.total === 0
        ? `<p class="aviso-alerta">Nenhum destinatário com estes critérios. Afrouxe os
             filtros ou marque as caixas de “incluir sem …”.</p>`
        : '';

    return `
      <section class="rel-sec" style="border:1px solid var(--linha);border-radius:8px;padding:1rem 1.2rem;">
        <h2>Prévia do público</h2>
        ${vazio}
        <p style="margin:.2rem 0 .6rem;">
          <span class="funil-num">${fmtInt(resultado.total)}</span>
          <b>destinatário${resultado.total === 1 ? '' : 's'}</b>
        </p>
        <ul class="lista">
          <li><b>${fmtInt(resultado.porOrigem.applications)}</b> de candidaturas</li>
          <li><b>${fmtInt(resultado.porOrigem.talentos)}</b> do banco de talentos</li>
        </ul>
        ${semAtributo ? `<p style="margin:1rem 0 .3rem;color:var(--cinza);font-size:.85rem;text-transform:uppercase;">Ficaram de fora</p><ul class="lista">${semAtributo}</ul>` : ''}
        <p style="margin:1rem 0 0;color:var(--cinza);font-size:.8rem;">
          Já descontados: quem se descadastrou, quem já se candidatou a esta vaga e
          talentos descartados. Cada pessoa aparece uma vez só.
        </p>
      </section>`;
  }

  // Descricao legivel dos criterios salvos, para a tela de detalhe. Le do JSON gravado,
  // que e o registro historico do recorte — nao dos filtros da tela.
  function descricaoCriterios(criterios = {}) {
    const itens = [];
    if (criterios.perfil) {
      itens.push(
        `Perfil: <b>${escapeHtml(ROTULO_PERFIL[criterios.perfil] || criterios.perfil)}</b>${criterios.perfilIncluirSemAtributo ? ' (incluindo sem perfil)' : ''}`,
      );
    }
    if (criterios.utmSource) {
      itens.push(
        `Origem: <b>${escapeHtml(criterios.utmSource)}</b>${criterios.utmSourceIncluirSemAtributo ? ' (incluindo sem origem)' : ''}`,
      );
    }
    if (criterios.recomendacao) {
      itens.push(
        `Recomendação: <b>${escapeHtml(ROTULO_RECOMENDACAO[criterios.recomendacao] || criterios.recomendacao)}</b>${criterios.recomendacaoIncluirSemAtributo ? ' (incluindo sem avaliação)' : ''}`,
      );
    }
    if (criterios.dataDe || criterios.dataAte) {
      itens.push(
        `Candidatura entre <b>${escapeHtml(criterios.dataDe || '—')}</b> e <b>${escapeHtml(criterios.dataAte || '—')}</b>`,
      );
    }
    if (!itens.length) return '<li>Sem filtros — toda a base de contatos.</li>';
    return itens.map((i) => `<li>${i}</li>`).join('');
  }

  // ── Bloco "Disparo" da tela de detalhe ──
  //
  // Tres estados, e nenhum deles e um botao desabilitado permanente: agora que a
  // funcionalidade existe, um botao morto so ensinaria o Jean a ignorar o botao.
  //   rascunho              -> botao vivo (leva a confirmacao)
  //   enfileirada/enviando/
  //   concluida             -> progresso agregado, sem botao
  //   cancelada             -> so o status
  //
  // O progresso mostra NUMEROS AGREGADOS, nunca a lista de quem falhou. Detalhe por
  // destinatario e outra tela (e outra decisao): aqui a pergunta e "a campanha andou?".
  function blocoDisparo(campanha, erro = '') {
    const alerta = erro ? `<p class="aviso-alerta">${escapeHtml(erro)}</p>` : '';

    if (campanha.status === 'rascunho') {
      return `
        <section class="rel-sec">
          <h2>Disparo</h2>
          ${alerta}
          <p style="color:var(--cinza);font-size:.9rem;margin:.2rem 0 1rem;">
            Disparar <b>congela</b> a lista de destinatários deste momento e entrega a
            campanha à rotina de envio. Você ainda confirma numa próxima tela, e
            <b>não há cancelamento depois de confirmado</b>.
          </p>
          <form method="POST" action="/admin/promocao/${campanha.id}/disparar">
            <button type="submit" class="btn">Disparar campanha</button>
          </form>
        </section>`;
    }

    if (campanha.status === 'cancelada') {
      return `
        <section class="rel-sec">
          <h2>Disparo</h2>
          ${alerta}
          <p style="margin:.2rem 0 0;">Campanha <b>cancelada</b>. Nada mais será enviado.</p>
        </section>`;
    }

    const c = db.contarEnviosCampanha(campanha.id);
    const falhas = c.falha
      ? `<li><b>${fmtInt(c.falha)}</b> ${c.falha === 1 ? 'falha' : 'falhas'} de envio</li>`
      : '';
    const rotulo = ROTULO_STATUS_CAMPANHA[campanha.status] || campanha.status;

    // ── Desempenho: recebidos e cliques ──
    //
    // "Recebidos" e `c.enviado` — o mesmo numero que ja aparecia como "enviados", so que
    // rotulado pelo que ele significa para quem le. Nao ha consulta nova: `enviado`
    // significa ACEITO PELO PROVEDOR, e nao "entregue na caixa" (bounce posterior nao volta
    // para ca). E o limite honesto do que o dado sabe, e por isso o rotulo diz "receberam"
    // e nao "leram".
    //
    // A taxa so aparece com recebidos > 0. Com uma campanha recem-enfileirada (0 enviados)
    // nao ha divisao a fazer, e um "0%" ali sugeriria fracasso onde ainda nao houve envio.
    const cliques = db.contarCliquesCampanha(campanha.id);
    const taxa = c.enviado > 0 ? Math.round((cliques.total / c.enviado) * 100) : null;

    const blocoDesempenho = `
      <section class="rel-sec">
        <h2>Desempenho</h2>
        <ul class="lista">
          <li><b>${fmtInt(c.enviado)}</b> receberam o e-mail</li>
          <li><b>${fmtInt(cliques.total)}</b> clique${cliques.total === 1 ? '' : 's'} no link da vaga${
            taxa === null ? '' : ` — <b>${taxa}%</b> de quem recebeu`
          }</li>
        </ul>
        <p style="margin:.8rem 0 0;color:var(--cinza);font-size:.8rem;">
          Cliques conta <b>acessos</b> à página da vaga vindos do link deste e-mail, não
          pessoas: a página é anônima e a mesma pessoa abrindo duas vezes conta duas vezes.
          Quem chegou à vaga por outro caminho não entra aqui.
        </p>
      </section>`;

    return `
      <section class="rel-sec">
        <h2>Disparo</h2>
        ${alerta}
        <p style="margin:.2rem 0 .6rem;">
          Status: <b>${escapeHtml(rotulo)}</b>
          ${campanha.enfileirada_em ? ` · enfileirada em ${escapeHtml(formatarDataHora(campanha.enfileirada_em))}` : ''}
          ${campanha.finalizada_em ? ` · finalizada em ${escapeHtml(formatarDataHora(campanha.finalizada_em))}` : ''}
        </p>
        <ul class="lista">
          <li><b>${fmtInt(c.total)}</b> destinatários congelados no disparo</li>
          <li><b>${fmtInt(c.enviado)}</b> enviados</li>
          <li><b>${fmtInt(c.pendente)}</b> na fila</li>
          ${falhas}
        </ul>
        <p style="margin:1rem 0 0;color:var(--cinza);font-size:.8rem;">
          A rotina envia até ${fmtInt(ENVIOS_POR_CICLO)} e-mails a cada 15 minutos, e só
          roda com <b>Promoção de vagas</b> ligada em
          <a href="/admin/config">Configurações</a>.
        </p>
      </section>
      ${blocoDesempenho}`;
  }

  // ── Bloco "Excluir" da tela de detalhe ──
  //
  // Existe SO em rascunho, e some por completo nos demais status — mesma regra de
  // blocoDisparo, e pela mesma razao registrada la: um botao desabilitado permanente
  // ensinaria a ignorar o botao. Nos outros status nao ha o que explicar; a propria
  // ausencia e a mensagem, e o bloco de Disparo acima ja diz em que pe a campanha esta.
  //
  // Vem DEPOIS do bloco de disparo na tela: a acao principal de um rascunho e dispara-lo.
  // Excluir e a saida, e saida fica no fim.
  function blocoExclusao(campanha) {
    if (campanha.status !== 'rascunho') return '';

    return `
      <section class="rel-sec">
        <h2>Excluir</h2>
        <p style="color:var(--cinza);font-size:.9rem;margin:.2rem 0 1rem;">
          Apaga esta campanha definitivamente. Vale só para <b>rascunho</b>: nenhum e-mail
          foi enviado e nenhum destinatário foi congelado, então não há nada a preservar.
          Você ainda confirma numa próxima tela.
        </p>
        <form method="POST" action="/admin/promocao/${campanha.id}/excluir">
          <button type="submit" class="btn btn--ghost">Excluir campanha</button>
        </form>
      </section>`;
  }

  // Vagas oferecidas na criacao: SO as ativas. Nao existe listarVagasAtivas na camada de
  // dados (listarVagas devolve todas, e obterVagaAtiva devolve UMA so), entao o recorte
  // acontece aqui — e recorte de APRESENTACAO, nao regra de negocio: nao faz sentido
  // divulgar vaga encerrada.
  function vagasAtivas() {
    return db.listarVagas().filter((v) => v.ativo);
  }

  function paginaFormulario({ criterios, valores = {}, resultado, erro, ok }) {
    const conteudo = `
      <p><a class="btn btn--ghost" href="/admin/promocao">← Voltar às campanhas</a></p>
      <h1>Nova campanha</h1>
      ${resultado ? blocoPrevia(resultado) : ''}
      ${formularioCampanha({
        vagas: vagasAtivas(),
        origens: db.listarOrigensDistintas(),
        // Opcoes montadas a partir do que EXISTE no banco (uniao de talentos.cidade e
        // applications.cidade), e nao de uma lista fixa: o backfill derivou 9 cidades das
        // empresas legadas, e uma lista chumbada no codigo divergiria no primeiro dado
        // novo. O sentinela 'Todas as cidades' fica de fora — ele casa sozinho.
        cidades: db.listarCidadesDistintas(),
        criterios,
        valores,
        erro,
        ok,
      })}`;
    return paginaAdmin({ titulo: 'Nova campanha', conteudo });
  }

  // ── GET /admin/promocao ── listagem ──
  router.get('/', (req, res) => {
    const campanhas = db.listarCampanhas();

    const linhas = campanhas
      .map((c) => {
        const rotulo = ROTULO_STATUS_CAMPANHA[c.status] || c.status;
        const badge =
          c.status === 'rascunho'
            ? `<span class="badge badge--aplicado">${escapeHtml(rotulo)}</span>`
            : `<span class="badge badge--ativa">${escapeHtml(rotulo)}</span>`;
        return `
          <tr>
            <td><a href="/admin/promocao/${c.id}">${escapeHtml(c.assunto || '(sem assunto)')}</a></td>
            <td>${escapeHtml(c.vaga_titulo || '(vaga removida)')}</td>
            <td>${badge}</td>
            <td class="col-num">${fmtInt(c.total_destinatarios)}</td>
            <td>${formatarDataHora(c.criado_em)}</td>
            <td style="display:flex;gap:.4rem;flex-wrap:wrap;">
              <a class="btn btn--ghost" href="/admin/promocao/${c.id}">Ver</a>
              ${
                // SO em rascunho, e sem versao desabilitada nos demais status — mesmo
                // principio ja documentado em blocoDisparo: "um botao morto so ensinaria o
                // Jean a ignorar o botao". Aqui ele leva a tela de confirmacao, nunca apaga
                // direto (o form nao carrega `confirmado`).
                c.status === 'rascunho'
                  ? `<form method="POST" action="/admin/promocao/${c.id}/excluir" style="margin:0;">
                       <button type="submit" class="btn btn--ghost">Excluir</button>
                     </form>`
                  : ''
              }
            </td>
          </tr>`;
      })
      .join('');

    const conteudo = `
      <p><a class="btn btn--ghost" href="/admin">← Voltar ao painel</a></p>
      <div style="display:flex;justify-content:space-between;align-items:center;gap:1rem;flex-wrap:wrap;margin-bottom:1rem;">
        <h1 style="margin:0;">Promoção de Vagas</h1>
        <a class="btn" href="/admin/promocao/nova">+ Nova campanha</a>
      </div>
      <p style="color:var(--cinza);font-size:.9rem;margin:0 0 1rem;">
        Divulgação de uma vaga por e-mail para a base de contatos. Toda campanha nasce
        como <b>rascunho</b> e não envia nada sozinha.
      </p>
      <div class="admin-tab-scroll">
        <table class="admin-tab">
          <thead>
            <tr><th>Assunto</th><th>Vaga</th><th>Status</th><th class="col-num">Destinatários</th><th>Criada em</th><th>Ações</th></tr>
          </thead>
          <tbody>
            ${linhas || '<tr><td colspan="6">Nenhuma campanha criada ainda.</td></tr>'}
          </tbody>
        </table>
      </div>`;

    res.send(paginaAdmin({ titulo: 'Promoção de Vagas', conteudo }));
  });

  // ── GET /admin/promocao/nova ── formulario vazio ──
  // Declarada ANTES de '/:id': '/nova' casaria com o parametro e cairia no detalhe.
  router.get('/nova', (req, res) => {
    res.send(paginaFormulario({ criterios: {}, valores: {}, resultado: null }));
  });

  // ── POST /admin/promocao/previa ── recalcula e re-renderiza (SEM efeito colateral) ──
  //
  // Nao grava nada e pode ser chamada quantas vezes o Jean quiser. Re-renderiza a tela
  // inteira com a previa acima do formulario, em vez de atualizar um pedaco via fetch.
  // Isso mantem a tela sem JavaScript: o unico ponto do painel que hoje faz fetch e o
  // select inline de Status Recrutador (admin.js), e um formulario de varios campos que
  // re-submete e' o padrao dominante do projeto (vagas, roteiro, config, perfis).
  router.post('/previa', (req, res) => {
    const b = req.body || {};
    const criterios = lerCriteriosDoForm(b);
    // A trava atravessa o recalculo: recalcular publico nao "desgera" o texto.
    const valores = {
      assunto: b.assunto,
      corpo_html: b.corpo_html,
      previaCalculada: true,
      sugestaoGerada: b.sugestao_gerada === '1',
    };

    if (!criterios.jobIdAlvo) {
      return res.status(400).send(
        paginaFormulario({
          criterios,
          valores: { ...valores, previaCalculada: false },
          resultado: null,
          erro: 'Escolha a vaga que será divulgada — o público depende dela (quem já se candidatou a essa vaga é excluído).',
        }),
      );
    }

    let resultado;
    try {
      resultado = listarPublicoCampanha(criterios);
    } catch (err) {
      console.error(`[promocao] falha ao calcular previa: ${err.message}`);
      return res.status(500).send(
        paginaFormulario({
          criterios,
          valores: { ...valores, previaCalculada: false },
          resultado: null,
          erro: 'Não foi possível calcular a prévia agora. Tente novamente.',
        }),
      );
    }

    res.send(paginaFormulario({ criterios, valores, resultado }));
  });

  // ── POST /admin/promocao/sugestao ── preenche assunto e corpo com ajuda de LLM ──
  //
  // NAO cria campanha, NAO envia e-mail e NAO recalcula publico: mexe SO no conteudo do
  // e-mail. Os criterios de segmentacao que o Jean ja tinha montado atravessam intactos
  // (via lerCriteriosDoForm, a mesma funcao das outras duas rotas), e o estado
  // "previa calculada" tambem — pedir um rascunho de texto nao pode custar o recorte de
  // publico que a pessoa levou minutos ajustando.
  //
  // Em QUALQUER falha, o que o Jean digitou volta para a tela. Uma sugestao que nao veio
  // nao justifica apagar o texto que a pessoa ja tinha escrito.
  router.post('/sugestao', async (req, res) => {
    const b = req.body || {};
    const criterios = lerCriteriosDoForm(b);
    const previaCalculada = b.previa_calculada === '1';
    const digitado = {
      assunto: b.assunto,
      corpo_html: b.corpo_html,
      previaCalculada,
      // A trava sobrevive ao ERRO tambem: se a vaga ja estava travada e a nova sugestao
      // falhou, o texto ANTIGO (gerado para esta vaga) continua na tela. Destravar aqui
      // deixaria o Jean trocar a vaga com aquele texto ainda no corpo.
      sugestaoGerada: b.sugestao_gerada === '1',
    };

    const renderErro = (mensagem, status = 400) =>
      res.status(status).send(
        paginaFormulario({ criterios, valores: digitado, resultado: null, erro: mensagem }),
      );

    // Validacao no BACKEND, e nao so pelo `required` do <select>: o navegador pode ser
    // contornado, e chamar o LLM sem vaga gastaria token para produzir nada.
    if (!criterios.jobIdAlvo) {
      return renderErro('Escolha a vaga antes de gerar a sugestão — o texto sai dos dados dela.');
    }

    const r = await gerarSugestaoConteudo(criterios.jobIdAlvo);
    if (!r.ok) {
      return renderErro(
        MENSAGENS_SUGESTAO_ERRO[r.erroCodigo] || MENSAGENS_SUGESTAO_ERRO.SUGESTAO_FALHOU,
        r.erroCodigo === 'VAGA_NAO_ENCONTRADA' ? 400 : 502,
      );
    }

    // Sugestao pronta: recalcula o publico com os MESMOS criterios que ja estavam na tela,
    // pela mesma chamada que POST /previa faz. E leitura pura e barata, e sem ela a tela
    // voltaria com o botao de criar liberado e NENHUM numero a vista — furando a garantia
    // do Incremento 5, que e justamente "ninguem cria campanha sem ver o tamanho dela".
    //
    // Se o recalculo falhar, a sugestao NAO se perde: a tela volta com o texto gerado e
    // sem o bloco de numeros. Perder o conteudo ja pago por causa de uma consulta seria
    // trocar um problema pequeno por um maior.
    let resultado = null;
    try {
      resultado = listarPublicoCampanha(criterios);
    } catch (err) {
      console.error(`[promocao] sugestao gerada, mas falhou o recalculo da previa: ${err.message}`);
    }

    res.send(
      paginaFormulario({
        criterios,
        valores: {
          assunto: r.assunto,
          corpo_html: r.corpoHtml,
          // Com o recalculo, o estado normalmente vem do proprio resultado. O campo oculto
          // so ainda importa quando o recalculo falha — e no caminho de ERRO da sugestao,
          // que continua sem recalcular.
          previaCalculada: Boolean(resultado) || previaCalculada,
          sugestaoGerada: true,
        },
        resultado,
      }),
    );
  });

  // ── POST /admin/promocao/teste ── envia UM e-mail de teste para o proprio recrutador ──
  //
  // O QUE ESTA ROTA NAO TOCA: campanha_envios (nenhuma linha, em nenhum caminho), a tabela
  // de campanhas (nao cria nem altera rascunho) e o interruptor `promocao_ativa`. Ela existe
  // exatamente para dar um caminho de verificacao que NAO passa pelo fluxo de campanha — ver
  // o cabecalho de lib/emailTestePromocao.js para o porque de cada uma dessas ausencias.
  //
  // Funciona A PARTIR DO FORMULARIO AINDA NAO SUBMETIDO: o assunto e o corpo saem dos
  // MESMOS campos `assunto`/`corpo_html` que /previa, /sugestao e a criacao leem, entao o
  // Jean pode iterar no texto e ver o resultado na caixa de entrada antes de existir
  // qualquer rascunho. Nao ha `:id` na rota porque nao ha campanha envolvida.
  //
  // Re-renderiza a MESMA tela (nunca redireciona), com os criterios lidos pela mesma
  // lerCriteriosDoForm das outras rotas e o conteudo devolvido intacto — no sucesso E no
  // erro. Um teste de e-mail que apagasse o texto em teste seria autossabotagem.
  router.post('/teste', async (req, res) => {
    const b = req.body || {};
    const criterios = lerCriteriosDoForm(b);
    const previaCalculada = b.previa_calculada === '1';
    const valores = {
      assunto: b.assunto,
      corpo_html: b.corpo_html,
      previaCalculada,
      sugestaoGerada: b.sugestao_gerada === '1',
    };

    // `jobId` vem dos MESMOS criterios do formulario: o e-mail de teste monta o link de
    // candidatura da vaga selecionada, igual ao disparo real.
    const r = await emailTeste.enviarEmailTeste({
      assunto: b.assunto,
      corpoHtml: b.corpo_html,
      jobId: criterios.jobIdAlvo,
    });

    // Recalculo do publico no mesmo molde de /sugestao e /trocar-vaga: os criterios nao
    // mudaram, mas a tela nao pode voltar sem numero a vista so porque o Jean pediu um
    // e-mail de teste. Falha aqui nao e fatal — o estado cai no campo oculto.
    let resultado = null;
    if (criterios.jobIdAlvo) {
      try {
        resultado = listarPublicoCampanha(criterios);
      } catch (err) {
        console.error(`[promocao] falha ao recalcular previa apos e-mail de teste: ${err.message}`);
      }
    }

    const valoresFinais = { ...valores, previaCalculada: Boolean(resultado) || previaCalculada };

    if (r.ok) {
      return res.send(
        paginaFormulario({
          criterios,
          valores: valoresFinais,
          resultado,
          ok: `E-mail de teste enviado para ${r.destinatario}. Assunto: "${r.assunto}".`,
        }),
      );
    }

    // Status por CODIGO, e nao um 400 para tudo: "falta configurar o endereco" (o Jean
    // resolve), "o servidor nao pode enviar" (503, mesma familia do pre-voo no disparo),
    // "espere o cooldown" (429) e "o provedor recusou" (502) sao situacoes diferentes, e
    // o codigo HTTP e a unica parte da resposta que um log ou um proxy consegue ler.
    const STATUS = {
      SEM_DESTINATARIO: 400,
      DESTINATARIO_INVALIDO: 400,
      SEM_CONTEUDO: 400,
      SEM_VAGA: 400,
      PRE_VOO: 503,
      COOLDOWN: 429,
      ENVIO_FALHOU: 502,
    };

    return res.status(STATUS[r.erroCodigo] || 400).send(
      paginaFormulario({ criterios, valores: valoresFinais, resultado, erro: r.mensagem }),
    );
  });

  // ── POST /admin/promocao/trocar-vaga ── destrava a vaga, limpando o conteudo gerado ──
  //
  // POST e nao um link para GET /nova: o GET voltaria com o formulario em branco e o Jean
  // perderia os filtros de segmentacao que levou minutos ajustando. Como o botao vive
  // DENTRO do formulario, o submit ja carrega perfil, origem, recomendacao, datas e as
  // caixas de "incluir sem" — `lerCriteriosDoForm` os le com a MESMA funcao das outras
  // rotas, sem estado novo nenhum: o formulario ja era o transporte.
  //
  // O QUE ELE LIMPA, e por que: assunto e corpo saem porque foram escritos PARA a vaga
  // antiga. Deixa-los seria recriar exatamente o problema que a trava fecha — o Jean
  // trocaria a vaga e manteria o texto da outra. Perder texto e o ponto, nao efeito
  // colateral, e o aviso ao lado do botao diz isso antes do clique.
  //
  // A VAGA CONTINUA SELECIONADA (so que editavel de novo). Zera-la obrigaria a reescolher
  // sempre, inclusive quem clicou por engano.
  router.post('/trocar-vaga', (req, res) => {
    const b = req.body || {};
    const criterios = lerCriteriosDoForm(b);
    const previaCalculada = b.previa_calculada === '1';

    // Sem `sugestaoGerada`: e exatamente o efeito do botao. Sem assunto e sem corpo_html:
    // a tela volta com os campos de texto vazios.
    const valores = { assunto: '', corpo_html: '', previaCalculada };

    // Recalculo do publico no mesmo molde do fim de POST /sugestao: os criterios nao
    // mudaram, mas a tela nao pode voltar com o botao de criar liberado e sem numero a
    // vista. Falha aqui nao e fatal — cai no estado do campo oculto.
    let resultado = null;
    if (criterios.jobIdAlvo) {
      try {
        resultado = listarPublicoCampanha(criterios);
      } catch (err) {
        console.error(`[promocao] falha ao recalcular previa ao trocar de vaga: ${err.message}`);
      }
    }

    res.send(
      paginaFormulario({
        criterios,
        valores: { ...valores, previaCalculada: Boolean(resultado) || previaCalculada },
        resultado,
      }),
    );
  });

  // ── POST /admin/promocao ── cria o rascunho ──
  //
  // ── DECISAO CONSCIENTE: a trava de vaga e SO de UI; o backend NAO valida ──
  //
  // Um POST forjado com `vaga=B` e o texto gerado para A e ACEITO aqui, de proposito.
  // Registrado por escrito para nao parecer omissao:
  //
  //   1. NAO HA COMO VALIDAR DE VERDADE. `corpo_html` e texto livre — o Jean pode escrever
  //      a campanha inteira a mao (o fluxo do Incremento 5, e o principal), e pode editar
  //      legitimamente o texto da IA a ponto de nao sobrar frase reconhecivel. Nao existe
  //      regra que separe "editou o texto gerado" de "gerou para outra vaga", e qualquer
  //      tentativa quebraria o fluxo manual, que e o mais usado.
  //   2. UM CAMPO OCULTO NAO E VALIDACAO. Guardar "a ultima sugestao foi para a vaga A"
  //      num hidden e compara-lo aqui nao segura ninguem: quem forja `vaga` forja o hidden
  //      no mesmo POST. Daria aparencia de garantia sem garantia nenhuma — pior que a
  //      ausencia dela. Uma versao com assinatura HMAC ou estado em sessao ate funcionaria,
  //      mas seria mecanismo novo para um risco que o item 3 dissolve.
  //   3. NAO HA ADVERSARIO. Toda esta arvore esta atras do adminAuth (ver o cabecalho do
  //      arquivo) e o unico usuario e o proprio recrutador. "Forjar" o POST aqui e enganar
  //      a si mesmo com a propria base de contatos — nao ha escalonamento de privilegio,
  //      nao ha dado de terceiro exposto, nao ha nada que o usuario ja nao pudesse fazer
  //      escrevendo o texto errado a mao.
  //
  // O risco real e ERRO HONESTO — clicar no select sem lembrar que o texto ja fala de
  // outra vaga —, e e exatamente isso que a trava da UI impede. Se um dia o painel ganhar
  // mais de um operador, ou perfis com permissoes diferentes, esta decisao muda: ai passa
  // a existir "o outro", e a validacao de backend deixa de ser teatro.
  router.post('/', (req, res) => {
    const b = req.body || {};
    const criterios = lerCriteriosDoForm(b);
    const assunto = String(b.assunto || '').trim();
    const corpoHtml = String(b.corpo_html || '').trim();
    const valores = {
      assunto,
      corpo_html: corpoHtml,
      previaCalculada: true,
      // So importa nos caminhos de ERRO abaixo (o sucesso redireciona): a tela que volta
      // com a mensagem precisa voltar com a vaga ainda travada.
      sugestaoGerada: b.sugestao_gerada === '1',
    };

    const erro = !criterios.jobIdAlvo
      ? 'Escolha a vaga que será divulgada.'
      : !assunto
        ? 'O assunto do e-mail é obrigatório.'
        : !corpoHtml
          ? 'O corpo do e-mail é obrigatório.'
          : '';
    if (erro) {
      return res.status(400).send(paginaFormulario({ criterios, valores, resultado: null, erro }));
    }

    let resultado;
    try {
      // Recalcula em vez de confiar em qualquer numero que tenha vindo do formulario: o
      // total gravado precisa ser o que o motor diz AGORA, nao o que um campo escondido
      // afirma. `criterios` gravado e o mesmo objeto usado neste calculo — o registro
      // historico e do recorte que de fato produziu o numero.
      resultado = listarPublicoCampanha(criterios);
    } catch (err) {
      console.error(`[promocao] falha ao calcular publico na criacao: ${err.message}`);
      return res.status(500).send(
        paginaFormulario({
          criterios,
          valores,
          resultado: null,
          erro: 'Não foi possível calcular o público agora. A campanha não foi criada.',
        }),
      );
    }

    // NENHUMA linha de campanha_envios aqui — a materializacao do publico e do disparo
    // (Incremento 7). Entre criar o rascunho e disparar, a lista pode mudar, e congelar os
    // destinatarios agora significaria enviar para um recorte velho.
    const id = db.criarCampanha({
      job_id: criterios.jobIdAlvo,
      assunto,
      corpo_html: corpoHtml,
      criterios,
      total_destinatarios: resultado.total,
    });

    res.redirect(`/admin/promocao/${id}`);
  });

  // 404 no tema do painel. Fonte unica para o GET do detalhe e para o POST do disparo —
  // as duas rotas respondem a mesma coisa para um id que nao existe.
  function pagina404() {
    return paginaAdmin({
      titulo: 'Campanha não encontrada',
      conteudo: `
        <p><a class="btn btn--ghost" href="/admin/promocao">← Voltar às campanhas</a></p>
        <h1>Campanha não encontrada</h1>
        <p>Esta campanha não existe ou foi removida.</p>`,
    });
  }

  // Tela de detalhe inteira, como funcao. Extraida do handler para o POST do disparo
  // poder re-renderizar a MESMA tela com uma mensagem de erro, em vez de inventar uma
  // segunda pagina que diria a mesma coisa com outra cara.
  function paginaDetalhe(campanha, { erroDisparo = '' } = {}) {
    // Publico ATUAL, recalculado dos criterios salvos. O total gravado e o numero
    // CONGELADO na criacao; os dois divergem quando a base se mexeu no meio do caminho
    // (alguem se descadastrou, alguem se candidatou a vaga alvo). Mostrar so um dos dois
    // esconderia essa decadencia justamente de quem esta prestes a disparar.
    let atual = null;
    let erroAtual = '';
    try {
      atual = listarPublicoCampanha(campanha.criterios);
    } catch (err) {
      console.error(`[promocao] falha ao recalcular publico da campanha ${campanha.id}: ${err.message}`);
      erroAtual = 'Não foi possível recalcular o público agora.';
    }

    const divergencia =
      atual && atual.total !== campanha.total_destinatarios
        ? `<p class="aviso-alerta">
             O público mudou desde a criação: eram <b>${fmtInt(campanha.total_destinatarios)}</b>
             em ${escapeHtml(formatarDataHora(campanha.criado_em))} e são
             <b>${fmtInt(atual.total)}</b> agora. Descadastros e novas candidaturas à vaga
             divulgada mexem nesse número.
           </p>`
        : '';

    const conteudo = `
      <p><a class="btn btn--ghost" href="/admin/promocao">← Voltar às campanhas</a></p>
      <div style="display:flex;justify-content:space-between;align-items:center;gap:1rem;flex-wrap:wrap;margin-bottom:.5rem;">
        <h1 style="margin:0;">${escapeHtml(campanha.assunto || '(sem assunto)')}</h1>
        <span class="badge badge--aplicado">${escapeHtml(ROTULO_STATUS_CAMPANHA[campanha.status] || campanha.status)}</span>
      </div>

      <section class="rel-sec">
        <dl class="rel-id">
          <div><dt>Vaga</dt><dd>${escapeHtml(campanha.vaga_titulo || '(vaga removida)')}</dd></div>
          <div><dt>Perfil da vaga</dt><dd>${escapeHtml(campanha.vaga_perfil || '—')}</dd></div>
          <div><dt>Criada em</dt><dd>${escapeHtml(formatarDataHora(campanha.criado_em))}</dd></div>
          <div><dt>Destinatários (na criação)</dt><dd>${fmtInt(campanha.total_destinatarios)}</dd></div>
        </dl>
      </section>

      ${erroAtual ? `<p class="aviso-alerta">${escapeHtml(erroAtual)}</p>` : divergencia}
      ${atual ? blocoPrevia(atual) : ''}

      <section class="rel-sec">
        <h2>Critérios usados</h2>
        <ul class="lista">${descricaoCriterios(campanha.criterios)}</ul>
      </section>

      <section class="rel-sec">
        <h2>Mensagem</h2>
        <div class="comp">
          <p style="color:var(--cinza);font-size:.8rem;text-transform:uppercase;margin:0 0 .3rem;">Assunto</p>
          <p style="margin:0 0 1rem;"><b>${escapeHtml(campanha.assunto || '')}</b></p>
          <p style="color:var(--cinza);font-size:.8rem;text-transform:uppercase;margin:0 0 .3rem;">Corpo (HTML)</p>
          <pre style="white-space:pre-wrap;word-break:break-word;margin:0;font-size:.85rem;">${escapeHtml(campanha.corpo_html || '')}</pre>
        </div>
      </section>

      ${blocoDisparo(campanha, erroDisparo)}
      ${blocoExclusao(campanha)}`;

    return paginaAdmin({ titulo: `Campanha — ${campanha.assunto || campanha.id}`, conteudo });
  }

  // ── GET /admin/promocao/:id ── detalhe / revisao ──
  router.get('/:id', (req, res) => {
    const id = Number(req.params.id);
    const campanha = Number.isInteger(id) && id > 0 ? db.obterCampanha(id) : null;
    if (!campanha) return res.status(404).send(pagina404());
    res.send(paginaDetalhe(campanha));
  });

  // ── POST /admin/promocao/:id/disparar ── enfileira o disparo, em DOIS passos ──
  //
  // A confirmacao e uma TELA, e nao um `confirm()` de navegador: o painel nao tem
  // JavaScript proprio (o unico fetch do projeto e o select de Status Recrutador em
  // admin.js), e uma tela intermediaria e o padrao dominante aqui — formularios que
  // re-submetem. Tambem e melhor UX para o que esta em jogo: um `confirm()` mostra uma
  // frase; a tela mostra o NUMERO de pessoas, o assunto e o aviso de que nao ha volta.
  //
  // PRIMEIRO POST (sem `confirmado`): renderiza a confirmacao. ZERO efeito colateral —
  // pode ser repetido a vontade, exatamente como POST /previa.
  // SEGUNDO POST (`confirmado=1`): enfileira de verdade.
  //
  // O guard de status e checado NAS DUAS passagens, e de novo dentro de
  // enfileirarCampanha (que por sua vez depende de um UPDATE condicional no banco). Sao
  // tres camadas para a mesma pergunta porque o custo de errar e um e-mail em massa
  // duplicado, e nao existe desfazer.
  router.post('/:id/disparar', (req, res) => {
    const id = Number(req.params.id);
    const campanha = Number.isInteger(id) && id > 0 ? db.obterCampanha(id) : null;
    if (!campanha) return res.status(404).send(pagina404());

    if (campanha.status !== 'rascunho') {
      return res.status(409).send(
        paginaDetalhe(campanha, {
          erroDisparo:
            `Esta campanha está em "${ROTULO_STATUS_CAMPANHA[campanha.status] || campanha.status}" ` +
            'e só é possível disparar uma campanha em rascunho. Uma campanha já disparada ' +
            'não pode ser disparada de novo.',
        }),
      );
    }

    // PRE-VOO, antes dos dois caminhos. Se o ambiente nao consegue enviar campanha, a tela
    // de confirmacao NAO aparece: nao se pede a alguem que confirme um disparo que ficaria
    // parado, com todos os ciclos abortando no primeiro destinatario e nada saindo ate
    // alguem ler o log do servidor. Barrar aqui (e nao no clique final) tambem evita o
    // pior desenho possivel — a pessoa ler "vou enviar para 412 pessoas", clicar em sim, e
    // so entao descobrir que nada podia sair.
    const preVoo = verificarPreCondicoesDisparo();
    if (!preVoo.ok) {
      console.error(
        `[promocao] disparo da campanha ${campanha.id} bloqueado no pre-voo: ` +
          preVoo.pendencias.map((p) => p.chave).join(', '),
      );
      return res.status(503).send(paginaDetalhe(campanha, { erroDisparo: preVoo.mensagem }));
    }

    const confirmado = (req.body || {}).confirmado === '1';

    if (!confirmado) {
      // Numero recalculado AGORA, pela mesma chamada que a tela de detalhe ja faz. Nao se
      // usa `total_destinatarios` (congelado na criacao): o que a pessoa precisa aprovar e
      // quantos e-mails vao sair, nao quantos sairiam se o botao tivesse sido apertado
      // semanas atras.
      let atual = null;
      try {
        atual = listarPublicoCampanha(campanha.criterios);
      } catch (err) {
        console.error(`[promocao] falha ao calcular publico para confirmacao (${id}): ${err.message}`);
        return res.status(500).send(
          paginaDetalhe(campanha, {
            erroDisparo:
              'Não foi possível calcular o público agora, então não dá para confirmar o ' +
              'disparo com segurança. A campanha continua em rascunho.',
          }),
        );
      }

      const conteudo = `
        <p><a class="btn btn--ghost" href="/admin/promocao/${campanha.id}">← Voltar à campanha</a></p>
        <h1>Confirmar disparo</h1>
        <p class="aviso-alerta">
          Você está prestes a enviar <b>${fmtInt(atual.total)}</b>
          e-mail${atual.total === 1 ? '' : 's'} de verdade. Depois de confirmado
          <b>não há cancelamento</b>, e não existe desfazer e-mail enviado.
        </p>
        <section class="rel-sec">
          <dl class="rel-id">
            <div><dt>Assunto</dt><dd>${escapeHtml(campanha.assunto || '(sem assunto)')}</dd></div>
            <div><dt>Vaga divulgada</dt><dd>${escapeHtml(campanha.vaga_titulo || '(vaga removida)')}</dd></div>
            <div><dt>Destinatários agora</dt><dd>${fmtInt(atual.total)}</dd></div>
          </dl>
          <ul class="lista">
            <li><b>${fmtInt(atual.porOrigem.applications)}</b> de candidaturas</li>
            <li><b>${fmtInt(atual.porOrigem.talentos)}</b> do banco de talentos</li>
          </ul>
          <p style="margin:1rem 0 0;color:var(--cinza);font-size:.85rem;">
            Ao confirmar, a lista é <b>congelada</b> e a campanha entra na fila. O envio sai
            em levas de até ${fmtInt(ENVIOS_POR_CICLO)} a cada 15 minutos, e só começa se
            <b>Promoção de vagas</b> estiver ligada em
            <a href="/admin/config">Configurações</a> — enquanto estiver desligada, nada sai.
          </p>
        </section>
        <form method="POST" action="/admin/promocao/${campanha.id}/disparar"
              style="display:flex;gap:.6rem;flex-wrap:wrap;align-items:center;">
          <input type="hidden" name="confirmado" value="1">
          <button type="submit" class="btn">Sim, disparar para ${fmtInt(atual.total)} destinatários</button>
          <a class="btn btn--ghost" href="/admin/promocao/${campanha.id}">Cancelar</a>
        </form>`;

      return res.send(paginaAdmin({ titulo: 'Confirmar disparo', conteudo }));
    }

    // enfileirarCampanha refaz o pre-voo por conta propria e LANCA se ele falhar. Na
    // pratica isso so acontece se a configuracao cair entre os dois cliques — mas sem este
    // try/catch a excecao viraria o 500 JSON do tratador global, que numa tela de painel
    // nao diz nada a quem esta olhando.
    let r;
    try {
      r = enfileirarCampanha(campanha.id);
    } catch (err) {
      console.error(`[promocao] enfileiramento da campanha ${campanha.id} recusado: ${err.message}`);
      return res.status(503).send(paginaDetalhe(campanha, { erroDisparo: err.message }));
    }

    if (!r.ok) {
      // A campanha continua em rascunho (enfileirarCampanha e tudo-ou-nada), entao a tela
      // de detalhe volta com o botao ainda disponivel e a mensagem do que deu errado.
      const atualizada = db.obterCampanha(campanha.id) || campanha;
      return res.status(r.erroCodigo === 'STATUS_INVALIDO' ? 409 : 500).send(
        paginaDetalhe(atualizada, { erroDisparo: r.mensagem }),
      );
    }

    res.redirect(`/admin/promocao/${campanha.id}`);
  });

  // ── POST /admin/promocao/:id/excluir ── apaga uma campanha em rascunho ──
  //
  // MESMA anatomia de /:id/disparar, e nao uma inventada: uma rota so, que renderiza a
  // confirmacao quando falta `confirmado=1` e executa quando ele vem. O motivo de copiar e
  // que as duas acoes tem a mesma forma de risco — irreversiveis, disparadas por um clique
  // — e duas telas de confirmacao com desenhos diferentes ensinariam o Jean que
  // confirmacao e um detalhe de cada tela, e nao um sinal de que algo serio vai acontecer.
  //
  // POST e nao DELETE: o painel e HTML puro, sem JavaScript, e formulario nao emite DELETE.
  // Mesma razao pela qual /:id/disparar e POST.
  //
  // A ordem das checagens espelha a do disparo: existe? -> estado permite? -> confirmou?
  // O guard de status vem ANTES da tela de confirmacao de proposito — nao se pede a
  // ninguem que confirme uma acao que ja se sabe que vai ser recusada.
  router.post('/:id/excluir', (req, res) => {
    const id = Number(req.params.id);
    const campanha = Number.isInteger(id) && id > 0 ? db.obterCampanha(id) : null;
    if (!campanha) return res.status(404).send(pagina404());

    if (campanha.status !== 'rascunho') {
      return res.status(409).send(
        paginaDetalhe(campanha, {
          erroDisparo:
            `Esta campanha está em "${ROTULO_STATUS_CAMPANHA[campanha.status] || campanha.status}" ` +
            'e só é possível excluir uma campanha em rascunho. Uma campanha que já foi ' +
            'disparada é registro do que saiu, e não pode ser apagada.',
        }),
      );
    }

    const confirmado = (req.body || {}).confirmado === '1';

    if (!confirmado) {
      // A tela de confirmacao mostra o que sera perdido — assunto, vaga e a data de
      // criacao —, e nao so "tem certeza?". O que se apaga aqui e texto que alguem
      // escreveu ou revisou; ver o conteudo antes de perde-lo e o minimo.
      const conteudo = `
        <p><a class="btn btn--ghost" href="/admin/promocao/${campanha.id}">← Voltar à campanha</a></p>
        <h1>Excluir campanha</h1>
        <p class="aviso-alerta">
          Esta campanha será <b>apagada definitivamente</b>. Não há desfazer, e o assunto e
          o corpo do e-mail escritos aqui serão perdidos.
        </p>
        <section class="rel-sec">
          <dl class="rel-id">
            <div><dt>Assunto</dt><dd>${escapeHtml(campanha.assunto || '(sem assunto)')}</dd></div>
            <div><dt>Vaga divulgada</dt><dd>${escapeHtml(campanha.vaga_titulo || '(vaga removida)')}</dd></div>
            <div><dt>Criada em</dt><dd>${escapeHtml(formatarDataHora(campanha.criado_em))}</dd></div>
          </dl>
          <p style="margin:1rem 0 0;color:var(--cinza);font-size:.85rem;">
            Nenhum e-mail foi enviado por esta campanha — ela está em <b>rascunho</b>, e
            rascunho nunca chegou a congelar destinatários. Excluir aqui não afeta ninguém
            da base nem nenhuma campanha já disparada.
          </p>
        </section>
        <form method="POST" action="/admin/promocao/${campanha.id}/excluir"
              style="display:flex;gap:.6rem;flex-wrap:wrap;align-items:center;">
          <input type="hidden" name="confirmado" value="1">
          <button type="submit" class="btn">Sim, excluir esta campanha</button>
          <a class="btn btn--ghost" href="/admin/promocao/${campanha.id}">Cancelar</a>
        </form>`;

      return res.send(paginaAdmin({ titulo: 'Excluir campanha', conteudo }));
    }

    // excluirCampanha refaz as DUAS travas por conta propria (status e envios), dentro de
    // uma transacao. A checagem de status la em cima e a que da a mensagem boa na tela; a
    // de dentro e a que fecha a janela entre os dois cliques.
    const r = db.excluirCampanha(campanha.id);
    if (!r.ok) {
      const atualizada = db.obterCampanha(campanha.id);
      // CAMPANHA_NAO_ENCONTRADA aqui significa que ela sumiu entre os dois cliques (outra
      // aba, provavelmente). O destino ja e o desejado, entao a listagem e a resposta certa
      // — repetir um 404 seria assustar por um resultado que a pessoa queria.
      if (!atualizada) return res.redirect('/admin/promocao');
      return res
        .status(r.erroCodigo === 'STATUS_INVALIDO' ? 409 : 500)
        .send(paginaDetalhe(atualizada, { erroDisparo: r.mensagem }));
    }

    // Listagem, e nao a tela de detalhe: a campanha nao existe mais, e um redirect para
    // /:id cairia direto no 404.
    res.redirect('/admin/promocao');
  });

  return router;
}

module.exports = { criarRouterPromocao, lerCriteriosDoForm };
