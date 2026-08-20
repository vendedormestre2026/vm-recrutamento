'use strict';

// JavaScript do cliente — minimo e progressivo.
// - Utilitario do orbe da Vera (estado visual).
// - Tela de Aplicacao (Fase 1B): troca de passos, steppers, chips, upload e envio.

(function () {
  // Alterna o estado visual do orbe: window.vmOrbe('falando'|'gravando'|'idle')
  window.vmOrbe = function (estado) {
    const orbe = document.querySelector('.vm-orb');
    if (!orbe) return;
    orbe.classList.remove('vm-orb--idle', 'vm-orb--falando', 'vm-orb--gravando');
    orbe.classList.add(`vm-orb--${estado}`);
    orbe.dataset.estado = estado;
  };
})();

// ── Tipos de curriculo aceitos no upload — compartilhado pelos DOIS formularios abaixo ──
// (Tela de Aplicacao e Banco de Curriculos). Espelha TIPOS_CURRICULO_ACEITOS de
// lib/curriculo.js no servidor, mas e uma SEGUNDA copia deliberada: nao ha import entre
// browser e Node, e esta checagem e so conveniencia — quem decide de verdade e o
// fileFilter do servidor. Mimetype OU extensao (nao os dois juntos, diferente do servidor):
// o navegador as vezes nao preenche `file.type` corretamente (depende do SO/app que gerou
// o arquivo), e recusar por isso seria pior que deixar passar e o servidor revalidar.
function tipoCurriculoAceito(file) {
  const extensaoOk = /\.(pdf|jpe?g|png|docx)$/i.test(file.name);
  const mimetypeOk = [
    'application/pdf',
    'image/jpeg',
    'image/png',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  ].includes(file.type);
  return extensaoOk || mimetypeOk;
}

// ── Tela de Aplicacao ──
//
// ── QA MANUAL do campo de telefone (erroTelefoneLocal) ──
// Sem jsdom no projeto, node:test nao executa este arquivo (ele espera `document`). Cenarios
// para checar a mao no navegador ao tocar este trecho:
//   1. Campo de digitos com "+55 11985761491"       -> bloqueia, "Não inclua o código do país..."
//   2. Campo de digitos com "0055 11 985761491"     -> bloqueia, mesma mensagem
//   3. Campo de digitos com "11985761491" (11 dig.) -> passa
//   4. Campo de digitos com "2169912185" (10 dig.)  -> passa (formato de fixo, sem opiniao
//      sobre o primeiro digito — ver nota do relatorio de diagnostico sobre o caso Samara)
//   5. Campo de digitos com "998765" (poucos dig.)  -> bloqueia, "Telefone inválido..."
//   6. Campo de digitos com "5511985761491" (DDD 55 legitimo, SEM + nem 00) -> passa (nao e
//      tratado como DDI duplicado — DDD 55 e real, ver comentario de erroTelefoneLocal)
//
// ── QA MANUAL do upload de curriculo (tipoCurriculoAceito) — mesma limitacao de jsdom ──
// Repetir nos DOIS formularios (Tela de Aplicacao e Banco de Curriculos, /bancodecurriculos):
//   1. Selecionar um .pdf real                    -> aceito, preview mostra o nome
//   2. Selecionar um .jpg e um .png reais         -> aceitos
//   3. Selecionar um .docx real                   -> aceito
//   4. Selecionar um .txt ou .doc (Word 97-2003)  -> bloqueia, "Envie o currículo em PDF,
//      JPG, PNG ou DOCX."
//   5. Arrastar-e-soltar (drag&drop) um tipo aceito e um tipo rejeitado -> mesmo
//      comportamento do clique (o listener de 'drop' chama a mesma validarArquivo)
//   6. Arquivo aceito porem maior que 10MB         -> bloqueia, "O currículo deve ter no
//      máximo 10 MB." (teto NAO mudou pra nenhum tipo — decisao de produto)
(function () {
  const form = document.getElementById('form-aplicacao');
  if (!form) return;

  const MAX_PDF = 10 * 1024 * 1024;
  const areaErro = form.querySelector('[data-erro]');
  function mostrarErro(msg) {
    areaErro.textContent = msg;
    areaErro.hidden = !msg;
    if (msg) areaErro.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }

  // Upload de curriculo (PDF/JPG/PNG/DOCX): clique (label nativo) + arrastar/soltar + validacao
  const upload = form.querySelector('[data-upload]');
  const inputArquivo = form.querySelector('input[name="curriculo"]');
  const textoUpload = form.querySelector('[data-upload-texto]');

  function validarArquivo(file) {
    if (!file) return true;
    if (!tipoCurriculoAceito(file)) {
      mostrarErro('Envie o currículo em PDF, JPG, PNG ou DOCX.');
      return false;
    }
    if (file.size > MAX_PDF) {
      mostrarErro('O currículo deve ter no máximo 10 MB.');
      return false;
    }
    return true;
  }

  inputArquivo.addEventListener('change', () => {
    const file = inputArquivo.files[0];
    if (file && validarArquivo(file)) {
      mostrarErro('');
      textoUpload.textContent = file.name;
      upload.classList.add('vm-upload--ok');
    }
  });

  ['dragover', 'dragenter'].forEach((ev) =>
    upload.addEventListener(ev, (e) => {
      e.preventDefault();
      upload.classList.add('vm-upload--sobre');
    }),
  );
  ['dragleave', 'drop'].forEach((ev) =>
    upload.addEventListener(ev, (e) => {
      e.preventDefault();
      upload.classList.remove('vm-upload--sobre');
    }),
  );
  upload.addEventListener('drop', (e) => {
    const file = e.dataTransfer.files[0];
    if (file && validarArquivo(file)) {
      inputArquivo.files = e.dataTransfer.files;
      mostrarErro('');
      textoUpload.textContent = file.name;
      upload.classList.add('vm-upload--ok');
    }
  });

  // Telefone: o <select name="ddi"> ja contribui "+55" (ou outro codigo) separado — este
  // campo e SO digitos locais (DDD + numero). Um "+" no inicio so pode ser o candidato
  // digitando o codigo do pais de novo (caso real: candidata cujo cadastro chegou como
  // "+55 +5511985761491", DDI duplicado, e a sequencia de WhatsApp nunca chegou por causa
  // disso). "0055" e o mesmo problema, so que no formato de discagem internacional.
  //
  // Bare "55" no inicio (sem "+" nem "00") NAO e tratado como DDI duplicado aqui de
  // proposito: DDD 55 e real (Santa Maria/Chapeco, RS/SC), e "55" sozinho no comeco e
  // indistinguivel de um DDD legitimo so pelo texto. Um "55" que na verdade for DDI
  // duplicado ainda cai na checagem de contagem de digitos abaixo, porque o numero
  // resultante fica fora da faixa [10,11].
  function erroTelefoneLocal(valorBruto) {
    const v = String(valorBruto || '').trim();
    if (!v) return null; // campo vazio: quem cobre isso e a checagem de obrigatoriedade
    if (v.startsWith('+')) {
      return 'Não inclua o código do país aqui — ele já está selecionado acima. Digite só o DDD e o número.';
    }
    const digitos = v.replace(/\D/g, '');
    if (digitos.startsWith('0055')) {
      return 'Não inclua o código do país aqui — ele já está selecionado acima. Digite só o DDD e o número.';
    }
    // DDD (2) + numero local (8 fixo ou 9 celular) = 10 ou 11 digitos, sem o DDI.
    if (digitos.length < 10 || digitos.length > 11) {
      return 'Telefone inválido. Digite o DDD e o número (10 ou 11 dígitos), sem o código do país.';
    }
    return null;
  }

  // Validacao basica do passo 1 (conveniencia; o servidor revalida)
  function validarPasso1() {
    const obrig = [
      ['nome', 'nome'],
      ['sobrenome', 'sobrenome'],
      ['email', 'e-mail'],
      ['telefone', 'telefone'],
    ];
    for (const [name, rotulo] of obrig) {
      const campo = form.querySelector(`[name="${name}"]`);
      if (!campo.value.trim()) {
        mostrarErro(`Preencha o campo ${rotulo}.`);
        campo.focus();
        return false;
      }
    }
    const email = form.querySelector('[name="email"]').value.trim();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      mostrarErro('Informe um e-mail válido.');
      return false;
    }
    const campoTelefone = form.querySelector('[name="telefone"]');
    const erroTelefone = erroTelefoneLocal(campoTelefone.value);
    if (erroTelefone) {
      mostrarErro(erroTelefone);
      campoTelefone.focus();
      return false;
    }
    if (!inputArquivo.files[0]) {
      mostrarErro('Anexe seu currículo (PDF, JPG, PNG ou DOCX).');
      return false;
    }
    if (!validarArquivo(inputArquivo.files[0])) return false;
    return true;
  }

  // Envio
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (!validarPasso1()) return;
    const btn = form.querySelector('[data-enviar]');
    btn.disabled = true;
    btn.textContent = 'Enviando...';
    try {
      const resp = await fetch('/api/aplicacao', { method: 'POST', body: new FormData(form) });
      const dados = await resp.json();
      if (resp.ok && dados.ok) {
        window.location = dados.redirect || '/preparacao';
        return;
      }
      mostrarErro(dados.erro || 'Não foi possível enviar sua candidatura.');
    } catch (err) {
      // `fetch` so lanca TypeError quando a REQUISICAO em si falha (sem rede, DNS, CORS,
      // conexao recusada) — e o unico caso em que "problema de internet" e diagnostico
      // honesto. Qualquer outro erro aqui (ex.: resp.json() em resposta que nao e JSON)
      // nao tem nada a ver com a conexao do candidato, e dizer isso so confunde quem ja
      // esta tentando resolver um problema que nao e o dele.
      const falhaDeRede = err instanceof TypeError;
      mostrarErro(
        falhaDeRede
          ? 'Falha de conexão. Verifique sua internet e tente novamente.'
          : 'Não foi possível enviar sua candidatura. Tente novamente em instantes.',
      );
    }
    btn.disabled = false;
    btn.textContent = 'Candidatar-me';
  });
})();

// ── Banco de Curriculos: formulario de cadastro (/bancodecurriculos) ──
// Mesmo comportamento da tela de Aplicacao (upload com clique/arrastar, botao de envio
// habilitado so com o consentimento marcado, envio via fetch com erro inline), num
// bloco proprio porque o form, os campos obrigatorios e o endpoint sao do fluxo do
// banco de talentos (independente do funil de vaga).
(function () {
  const form = document.getElementById('form-banco-curriculos');
  if (!form) return;

  const MAX_PDF = 10 * 1024 * 1024;
  const areaErro = form.querySelector('[data-erro]');
  function mostrarErro(msg) {
    areaErro.textContent = msg;
    areaErro.hidden = !msg;
    if (msg) areaErro.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }

  // Upload de curriculo (PDF/JPG/PNG/DOCX): clique (label nativo) + arrastar/soltar + validacao
  const upload = form.querySelector('[data-upload]');
  const inputArquivo = form.querySelector('input[name="curriculo"]');
  const textoUpload = form.querySelector('[data-upload-texto]');

  function validarArquivo(file) {
    if (!file) return true;
    if (!tipoCurriculoAceito(file)) {
      mostrarErro('Envie o currículo em PDF, JPG, PNG ou DOCX.');
      return false;
    }
    if (file.size > MAX_PDF) {
      mostrarErro('O currículo deve ter no máximo 10 MB.');
      return false;
    }
    return true;
  }

  function aceitarArquivo(file) {
    mostrarErro('');
    textoUpload.textContent = file.name;
    upload.classList.add('vm-upload--ok');
  }

  inputArquivo.addEventListener('change', () => {
    const file = inputArquivo.files[0];
    if (file && validarArquivo(file)) aceitarArquivo(file);
  });

  ['dragover', 'dragenter'].forEach((ev) =>
    upload.addEventListener(ev, (e) => {
      e.preventDefault();
      upload.classList.add('vm-upload--sobre');
    }),
  );
  ['dragleave', 'drop'].forEach((ev) =>
    upload.addEventListener(ev, (e) => {
      e.preventDefault();
      upload.classList.remove('vm-upload--sobre');
    }),
  );
  upload.addEventListener('drop', (e) => {
    const file = e.dataTransfer.files[0];
    if (file && validarArquivo(file)) {
      inputArquivo.files = e.dataTransfer.files;
      aceitarArquivo(file);
    }
  });

  // Validacao basica (conveniencia; o servidor revalida)
  function validarFormulario() {
    const obrig = [
      ['nome', 'nome'],
      ['email', 'e-mail'],
      ['telefone', 'telefone'],
    ];
    for (const [name, rotulo] of obrig) {
      const campo = form.querySelector(`[name="${name}"]`);
      if (!campo.value.trim()) {
        mostrarErro(`Preencha o campo ${rotulo}.`);
        campo.focus();
        return false;
      }
    }
    const perfil = form.querySelector('[name="perfil_interesse"]');
    if (!perfil.value) {
      mostrarErro('Escolha o perfil de interesse (SDR ou Closer).');
      perfil.focus();
      return false;
    }
    if (!inputArquivo.files[0]) {
      mostrarErro('Anexe seu currículo (PDF, JPG, PNG ou DOCX).');
      return false;
    }
    if (!validarArquivo(inputArquivo.files[0])) return false;
    if (chkConsentimento && !chkConsentimento.checked) {
      mostrarErro('É necessário autorizar o armazenamento dos seus dados no banco de talentos para se cadastrar.');
      return false;
    }
    return true;
  }

  // Consentimento LGPD (banco de talentos): o botao so habilita com o checkbox marcado.
  const chkConsentimento = form.querySelector('[data-consentimento]');
  const btnEnviar = form.querySelector('[data-enviar]');
  function sincronizarConsentimento() {
    if (btnEnviar && chkConsentimento) btnEnviar.disabled = !chkConsentimento.checked;
  }
  if (chkConsentimento) chkConsentimento.addEventListener('change', sincronizarConsentimento);
  sincronizarConsentimento();

  // Envio
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (!validarFormulario()) return;
    btnEnviar.disabled = true;
    btnEnviar.textContent = 'Enviando...';
    try {
      const resp = await fetch('/api/banco-curriculos', { method: 'POST', body: new FormData(form) });
      const dados = await resp.json();
      if (resp.ok && dados.ok) {
        // T3: a API devolve o HTML do resultado ja renderizado no servidor; trocamos o
        // formulario por ele na propria pagina (sem navegacao). O redirect segue como
        // fallback (resposta antiga/sem resultadoHtml) para /recebido, tela generica.
        if (dados.resultadoHtml) {
          form.outerHTML = dados.resultadoHtml;
          window.scrollTo({ top: 0, behavior: 'smooth' });
          return;
        }
        window.location = dados.redirect || '/bancodecurriculos/recebido';
        return;
      }
      mostrarErro(dados.erro || 'Não foi possível enviar seu cadastro.');
    } catch (err) {
      mostrarErro('Falha de conexão. Verifique sua internet e tente novamente.');
    }
    btnEnviar.disabled = false;
    btnEnviar.textContent = 'Enviar currículo';
  });
})();

// ── Utilitarios de midia (Fase 2): mensagens de erro PT-BR + parar tracks ──
const VM_MIDIA = {
  mensagemErro(err, tipo) {
    const dispositivo = tipo === 'camera' ? 'câmera' : 'microfone';
    const nome = err && err.name ? err.name : '';
    if (nome === 'NotAllowedError' || nome === 'SecurityError') {
      return (
        `Permissão de ${dispositivo} negada. Para reativar: toque no ícone de cadeado/` +
        `${dispositivo} na barra de endereço do navegador e permita o acesso (ou ajuste nas ` +
        `configurações do navegador/sistema).`
      );
    }
    if (nome === 'NotFoundError' || nome === 'DevicesNotFoundError') {
      return `Nenhuma ${dispositivo} encontrada.`;
    }
    if (nome === 'NotReadableError' || nome === 'TrackStartError') {
      return `Não foi possível acessar a ${dispositivo} (pode estar em uso por outro app).`;
    }
    return `Não foi possível acessar a ${dispositivo}. Verifique as permissões e tente novamente.`;
  },
  pararTracks(stream) {
    if (stream) stream.getTracks().forEach((t) => t.stop());
  },
  suportado() {
    return !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia);
  },
};

// ── Tela 6: Permissao de camera (OBRIGATORIA) ──
// Camera concedida -> /teste-camera. Camera negada/indisponivel -> troca o pedido pela
// tela de bloqueio (sem "pular"), com a opcao de receber o link de retomada por e-mail.
(function () {
  const tela = document.querySelector('[data-tela-permissao-camera]');
  if (!tela) return;
  const btn = tela.querySelector('[data-permitir-camera]');
  if (!btn) return;
  const pedido = tela.querySelector('[data-cam-pedido]');
  const bloqueio = tela.querySelector('[data-cam-bloqueio]');
  const btnEnviarLink = tela.querySelector('[data-enviar-link]');
  const statusBloqueio = tela.querySelector('[data-cam-bloqueio-status]');

  // Mostra a tela de bloqueio (camera necessaria) no lugar do pedido de permissao.
  function mostrarBloqueio() {
    if (pedido) pedido.hidden = true;
    if (bloqueio) bloqueio.hidden = false;
  }

  btn.addEventListener('click', async () => {
    if (!VM_MIDIA.suportado()) {
      mostrarBloqueio();
      return;
    }
    btn.disabled = true;
    btn.textContent = 'Solicitando...';
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ video: true });
      // Nao precisamos manter o stream aqui: paramos as tracks e seguimos.
      VM_MIDIA.pararTracks(stream);
      window.location = '/teste-camera';
    } catch (err) {
      // Negada ou falhou: sem camera nao ha entrevista -> tela de bloqueio.
      btn.disabled = false;
      btn.textContent = 'Permitir câmera e gravar';
      mostrarBloqueio();
    }
  });

  // "Receber link por e-mail para continuar depois" -> POST /api/retomar-depois.
  function mostrarStatus(msg) {
    if (!statusBloqueio) return;
    statusBloqueio.textContent = msg;
    statusBloqueio.hidden = !msg;
  }
  if (btnEnviarLink) {
    btnEnviarLink.addEventListener('click', async () => {
      mostrarStatus('');
      btnEnviarLink.disabled = true;
      btnEnviarLink.textContent = 'Enviando...';
      try {
        const resp = await fetch('/api/retomar-depois', { method: 'POST' });
        const dados = await resp.json().catch(() => ({}));
        if (resp.ok && dados.ok) {
          btnEnviarLink.hidden = true;
          mostrarStatus('E-mail enviado! Verifique sua caixa de entrada.');
          return;
        }
        throw new Error('falha no envio');
      } catch (e) {
        btnEnviarLink.disabled = false;
        btnEnviarLink.textContent = 'Receber link por e-mail para continuar depois';
        mostrarStatus('Não conseguimos enviar o e-mail. Tente novamente.');
      }
    });
  }
})();

// ── Tela 7: Teste de camera (preview ao vivo) ──
(function () {
  const tela = document.querySelector('[data-tela-teste-camera]');
  if (!tela) return;
  const video = tela.querySelector('[data-preview-camera]');
  const erro = tela.querySelector('[data-cam-erro]');
  let streamAtual = null;

  function mostrarErro(msg) {
    erro.textContent = msg;
    erro.hidden = !msg;
  }
  function pararPreview() {
    VM_MIDIA.pararTracks(streamAtual);
    streamAtual = null;
  }

  async function iniciarPreview() {
    if (!VM_MIDIA.suportado()) {
      mostrarErro('Seu navegador não suporta acesso à câmera. Tente outro navegador.');
      return;
    }
    try {
      streamAtual = await navigator.mediaDevices.getUserMedia({ video: true });
      video.srcObject = streamAtual;
    } catch (err) {
      mostrarErro(VM_MIDIA.mensagemErro(err, 'camera'));
    }
  }

  // Ao sair/continuar: para as tracks (apaga a luz da webcam).
  tela.querySelectorAll('[data-continuar]').forEach((link) => {
    link.addEventListener('click', () => pararPreview());
  });
  window.addEventListener('pagehide', pararPreview);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') pararPreview();
  });

  iniciarPreview();
})();

// ── Tela 8: Permissao de microfone (obrigatorio) ──
(function () {
  const btn = document.querySelector('[data-permitir-mic]');
  if (!btn) return;
  const btnTentar = document.querySelector('[data-tentar-mic]');
  const erro = document.querySelector('[data-mic-erro]');

  function mostrarErro(msg) {
    erro.textContent = msg;
    erro.hidden = !msg;
    btnTentar.hidden = !msg; // "Tentar de novo" relanca o pedido
  }

  async function pedirMicrofone() {
    mostrarErro('');
    if (!VM_MIDIA.suportado()) {
      mostrarErro('Seu navegador não suporta acesso ao microfone. Tente outro navegador.');
      return;
    }
    btn.disabled = true;
    btn.textContent = 'Solicitando...';
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      VM_MIDIA.pararTracks(stream); // so confirmamos a permissao aqui
      window.location = '/teste-microfone';
    } catch (err) {
      mostrarErro(VM_MIDIA.mensagemErro(err, 'microfone'));
      btn.disabled = false;
      btn.textContent = 'Permitir microfone';
    }
  }

  btn.addEventListener('click', pedirMicrofone);
  btnTentar.addEventListener('click', pedirMicrofone);
})();

// ── Tela 9: Teste de microfone (medidor de nivel via Web Audio API) ──
(function () {
  const tela = document.querySelector('[data-tela-teste-mic]');
  if (!tela) return;

  // Flag de dev: ative com ?vmdev=1 na URL para ver os logs de diagnostico.
  const VM_DEV = new URLSearchParams(location.search).has('vmdev');

  const btnFalar = tela.querySelector('[data-falar]');
  const btnContinuar = tela.querySelector('[data-continuar-mic]');
  const linkAssim = tela.querySelector('[data-continuar-assim]');
  const barra = tela.querySelector('[data-nivel-mic]');
  const status = tela.querySelector('[data-status-mic]');
  const nota = tela.querySelector('[data-nota-seguranca]');
  const erro = tela.querySelector('[data-mic-erro]');
  const chkGravacao = tela.querySelector('[data-consentimento-gravacao]');

  // Deteccao tolerante: piso baixo + acumulo de ~800ms, tolerando pausas.
  const LIMIAR_RMS = 0.025;
  const TEMPO_ALVO_MS = 800;
  const SEGURANCA_MS = 8000; // rede de seguranca: habilita CONTINUAR mesmo sem cruzar o limiar

  let stream = null;
  let audioCtx = null;
  let raf = null;
  let timerSeguranca = null;
  let acumuladoMs = 0;
  let ultimoTs = 0;
  let testando = false;
  let concluido = false;
  let ultimoLogTs = 0;
  let micPronto = false; // microfone concedido/verificado

  function mostrarErro(msg) {
    erro.textContent = msg;
    erro.hidden = !msg;
  }

  // "Continuar" so habilita com o microfone pronto E o aceite de gravacao (LGPD) marcado.
  function atualizarContinuar() {
    btnContinuar.disabled = !(micPronto && chkGravacao && chkGravacao.checked);
  }
  function habilitarContinuar() {
    micPronto = true;
    atualizarContinuar();
  }
  if (chkGravacao) chkGravacao.addEventListener('change', atualizarContinuar);

  // Para a analise e libera o microfone (AudioContext fechado, tracks paradas).
  function pararAnalise() {
    if (raf) cancelAnimationFrame(raf);
    raf = null;
    if (timerSeguranca) {
      clearTimeout(timerSeguranca);
      timerSeguranca = null;
    }
    VM_MIDIA.pararTracks(stream);
    stream = null;
    if (audioCtx && audioCtx.state !== 'closed') audioCtx.close();
    audioCtx = null;
    testando = false;
    barra.style.width = '0%';
  }

  async function navegarEntrevista() {
    // Guard do aceite de gravacao (cobre tambem o "Continuar mesmo assim").
    if (chkGravacao && !chkGravacao.checked) {
      mostrarErro('É necessário aceitar os termos de gravação para continuar.');
      return;
    }
    // Registra o consentimento no servidor. Best-effort: nao trava o avanco se a rede
    // falhar (o aceite ja foi exigido na UI; o registro e a trilha de auditoria).
    try {
      await fetch('/api/consentimento-gravacao', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ consentimento: true }),
      });
    } catch (e) {
      /* segue mesmo assim */
    }
    pararAnalise();
    window.location = '/entrevista';
  }

  function concluir() {
    if (concluido) return;
    concluido = true;
    status.textContent = '✓ Verificação concluída';
    status.classList.add('vm-status--ok');
    nota.hidden = true;
    habilitarContinuar();
    pararAnalise(); // libera o microfone assim que verificamos
    btnFalar.textContent = 'Testar de novo';
    btnFalar.disabled = false;
  }

  // Estado final manual (usuario parou o teste sem concluir).
  function pararManual() {
    pararAnalise();
    if (!concluido) {
      status.textContent = '';
      status.classList.remove('vm-status--ok');
    }
    btnFalar.textContent = concluido ? 'Testar de novo' : 'Falar';
    btnFalar.disabled = false;
  }

  async function comecar() {
    mostrarErro('');
    if (!VM_MIDIA.suportado()) {
      mostrarErro('Seu navegador não suporta acesso ao microfone. Tente outro navegador.');
      return;
    }
    acumuladoMs = 0;
    concluido = false;
    testando = true;
    btnFalar.textContent = 'Parar';
    status.textContent = 'Ouvindo...';
    status.classList.remove('vm-status--ok');
    nota.hidden = true;

    try {
      const s = await navigator.mediaDevices.getUserMedia({ audio: true });
      // Se o usuario parou durante o await, libera e nao inicia a analise.
      if (!testando) {
        VM_MIDIA.pararTracks(s);
        return;
      }
      stream = s;
      // Microfone concedido e funcionando: ja libera o CONTINUAR. O que de fato
      // exigimos para avancar e ter o microfone — a deteccao automatica de fala (e
      // o timer de seguranca de 8s) viram apenas um "bonus" que sinaliza o ✓. Sem
      // isto, parar o teste manualmente antes da deteccao deixava o botao preso
      // (disabled nao recebe clique), forcando o uso do "Continuar mesmo assim".
      habilitarContinuar();
      const AudioCtx = window.AudioContext || window.webkitAudioContext; // iOS
      audioCtx = new AudioCtx();
      if (audioCtx.state === 'suspended') await audioCtx.resume(); // iOS exige gesto
      const fonte = audioCtx.createMediaStreamSource(stream);
      const analisador = audioCtx.createAnalyser();
      analisador.fftSize = 1024;
      fonte.connect(analisador);
      const dados = new Uint8Array(analisador.fftSize);
      ultimoTs = performance.now();

      // Rede de seguranca: com o microfone concedido, nunca prender o usuario.
      timerSeguranca = setTimeout(() => {
        if (!concluido && stream) {
          habilitarContinuar();
          nota.hidden = false;
          nota.textContent = 'Se você se ouviu no medidor, pode continuar.';
          if (VM_DEV) console.log('[mic] rede de seguranca: CONTINUAR habilitado apos 8s');
        }
      }, SEGURANCA_MS);

      function loop(ts) {
        const dt = ts - ultimoTs;
        ultimoTs = ts;
        analisador.getByteTimeDomainData(dados);
        let soma = 0;
        for (let i = 0; i < dados.length; i++) {
          const v = (dados[i] - 128) / 128;
          soma += v * v;
        }
        const rms = Math.sqrt(soma / dados.length);
        const nivel = Math.min(1, rms * 3.2); // amplifica p/ exibicao
        barra.style.width = `${Math.round(nivel * 100)}%`;

        if (rms > LIMIAR_RMS) acumuladoMs += dt;
        else acumuladoMs = Math.max(0, acumuladoMs - dt * 0.4); // decaimento suave, tolera pausas

        // Log de diagnostico (atras do flag de dev), throttled ~4x/s.
        if (VM_DEV && ts - ultimoLogTs > 250) {
          ultimoLogTs = ts;
          console.log(
            `[mic] rms=${rms.toFixed(4)} limiar=${LIMIAR_RMS} acumulado=${Math.round(acumuladoMs)}ms`,
          );
        }

        if (acumuladoMs >= TEMPO_ALVO_MS) {
          concluir();
          return;
        }
        raf = requestAnimationFrame(loop);
      }
      raf = requestAnimationFrame(loop);
    } catch (err) {
      mostrarErro(VM_MIDIA.mensagemErro(err, 'microfone'));
      pararAnalise();
      btnFalar.textContent = 'Falar';
      btnFalar.disabled = false;
    }
  }

  // FALAR e um toggle real: inicia / para o teste manualmente.
  btnFalar.addEventListener('click', () => {
    if (testando) pararManual();
    else comecar();
  });

  // CONTINUAR (so habilita apos concluir ou apos a rede de seguranca).
  btnContinuar.addEventListener('click', navegarEntrevista);

  // "Continuar mesmo assim": sempre disponivel (microfone foi concedido na Tela 8).
  linkAssim.addEventListener('click', (e) => {
    e.preventDefault();
    navegarEntrevista();
  });

  // Libera o microfone ao sair da tela.
  window.addEventListener('pagehide', pararAnalise);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') pararAnalise();
  });
})();

// ── Tela de Identificacao ──
(function () {
  const form = document.getElementById('form-identificacao');
  if (!form) return;
  const areaErro = form.querySelector('[data-erro]');

  function mostrarErro(msg) {
    areaErro.textContent = msg;
    areaErro.hidden = !msg;
  }

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const email = form.querySelector('[name="email"]').value.trim();
    const codigo = form.querySelector('[name="codigo"]').value.trim();
    if (!email || !codigo) {
      mostrarErro('Informe e-mail e código de acesso.');
      return;
    }
    const btn = form.querySelector('[data-enviar]');
    btn.disabled = true;
    btn.textContent = 'Verificando...';
    try {
      const resp = await fetch('/api/identificacao', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, codigo }),
      });
      const dados = await resp.json();
      if (resp.ok && dados.ok) {
        window.location = dados.redirect || '/preparacao';
        return;
      }
      mostrarErro(dados.erro || 'Não encontramos uma candidatura com esses dados.');
    } catch (err) {
      mostrarErro('Falha de conexão. Verifique sua internet e tente novamente.');
    }
    btn.disabled = false;
    btn.textContent = 'Continuar';
  });
})();

// ── Tela 10: Entrevista (loop push-to-talk com a Vera) ──
(function () {
  const tela = document.querySelector('[data-entrevista]');
  if (!tela) return;

  const orbe = tela.querySelector('[data-orbe]');
  const estadoTexto = tela.querySelector('[data-estado-texto]');
  const elPergunta = tela.querySelector('[data-pergunta]');
  const elProgresso = tela.querySelector('[data-progresso]');
  const elProgressoBarraWrap = tela.querySelector('[data-progresso-barra-wrap]');
  const elProgressoBarra = tela.querySelector('[data-progresso-barra]');
  const elProgressoRotulo = tela.querySelector('[data-progresso-rotulo]');
  const elChips = tela.querySelector('[data-chips]');
  const elTimer = tela.querySelector('[data-timer]');
  const elErro = tela.querySelector('[data-erro]');
  const btnPtt = tela.querySelector('[data-ptt]');
  const btnRetry = tela.querySelector('[data-retry]');
  const btnRepetir = tela.querySelector('[data-repetir]');
  const overlayIniciar = tela.querySelector('[data-iniciar]');
  const btnIniciar = tela.querySelector('[data-iniciar-btn]');
  const audio = tela.querySelector('[data-audio]');
  // Silêncio válido (WAV, ~46 bytes) usado só para destravar ESTE <audio> no 1º gesto.
  const SILENCIO_WAV =
    'data:audio/wav;base64,UklGRiYAAABXQVZFZm10IBAAAAABAAEARKwAAIhYAQACABAAZGF0YQIAAAAAAA==';
  const camThumb = tela.querySelector('[data-cam-thumb]');
  const camVideo = tela.querySelector('[data-cam-video]');

  let interviewId = null;
  let ultimoAudioUrl = null;
  let gravando = false;
  let recorder = null;
  let chunks = [];
  let micStream = null;
  let camStream = null;
  // Gravacao de VIDEO da entrevista inteira (continua, em paralelo ao push-to-talk).
  // Best-effort: so grava se a camera foi concedida; nunca bloqueia a entrevista.
  let videoRecorder = null;
  let videoChunks = [];
  let timerId = null;
  let inicioMs = 0;
  let maxMs = 0; // teto de duracao (MAX_DURACAO_MIN), para sinal visual do timer
  let encerrando = false;
  let repeticoesSeguidas = 0; // "nao consegui ouvir" seguidos; na 3a, segue mesmo assim
  let acaoPendente = null; // ultima acao que falhou (para o retry manual)
  let overlayProntoEm = 0; // instante em que o overlay ficou pronto (anti clique-fantasma)

  // Flags de TESTE (custo zero; so no front; o servidor so honra teste_repetir em
  // mock). Use ?vmfalha=N para simular N falhas de rede e ?vmrepetir=1 para
  // exercitar o fluxo "nao consegui ouvir".
  const QS = new URLSearchParams(location.search);
  let falhasSimuladas = parseInt(QS.get('vmfalha') || '0', 10) || 0;
  const TESTE_REPETIR = QS.get('vmrepetir') === '1';

  function gerarId() {
    if (window.crypto && crypto.randomUUID) return crypto.randomUUID();
    return `r-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  }

  // fetch com 1 retry silencioso (rede/timeout/5xx). A falha simulada faz a
  // chamada de verdade e DESCARTA a resposta — exercita a idempotencia do servidor
  // (o retry reusa o mesmo tentativa_id e nao deve duplicar turnos).
  async function fetchComRetry(url, opts, timeoutMs = 90000) {
    let ultimoErro = null;
    for (let tentativa = 0; tentativa < 2; tentativa++) {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), timeoutMs);
      try {
        const resp = await fetch(url, Object.assign({}, opts, { signal: ctrl.signal }));
        clearTimeout(t);
        if (falhasSimuladas > 0) {
          falhasSimuladas--;
          throw new Error('falha simulada (teste)');
        }
        if (resp.status >= 500) throw new Error(`HTTP ${resp.status}`);
        return resp;
      } catch (e) {
        clearTimeout(t);
        ultimoErro = e; // 1a falha: tenta de novo em silencio (sem mostrar erro)
      }
    }
    throw ultimoErro;
  }

  const ESTADOS = {
    idle: '',
    falando: 'Vera está falando…',
    gravando: 'Gravando… (toque para enviar)',
    pensando: 'Vera está pensando…',
  };

  function setOrbe(estado) {
    orbe.classList.remove('vm-orb--idle', 'vm-orb--falando', 'vm-orb--gravando', 'vm-orb--pensando');
    orbe.classList.add(`vm-orb--${estado}`);
    estadoTexto.textContent = ESTADOS[estado] || '';
  }

  function mostrarErro(msg) {
    elErro.textContent = msg || '';
    elErro.hidden = !msg;
  }

  function renderChips(topicos) {
    if (!Array.isArray(topicos)) return;
    elChips.innerHTML = topicos
      .map(
        (t) =>
          `<span class="vm-chip vm-chip--${t.estado}">${(t.nome || '').replace(/[<>&]/g, '')}</span>`,
      )
      .join('');
  }

  function tocarFala(url, aoTerminar) {
    if (!url) return;
    setOrbe('falando');
    audio.src = url;
    audio.onended = () => {
      setOrbe('idle');
      if (aoTerminar) aoTerminar();
    };
    audio.play().catch(() => {
      // Se o navegador bloquear, segue mesmo assim (texto sempre visivel).
      setOrbe('idle');
      if (aoTerminar) aoTerminar();
    });
  }

  function formatarTempo(ms) {
    const s = Math.floor(ms / 1000);
    const mm = String(Math.floor(s / 60)).padStart(2, '0');
    const ss = String(s % 60).padStart(2, '0');
    return `${mm}:${ss}`;
  }

  function atualizarTimer() {
    const decorrido = Date.now() - inicioMs;
    elTimer.textContent = formatarTempo(decorrido);
    // Atingiu o teto: sinaliza visualmente (a entrevista encerra no proximo turno).
    if (maxMs && decorrido >= maxMs) elTimer.classList.add('vm-timer--esgotado');
  }

  // Inicia (ou retoma) o cronometro. decorrido = ms ja passados (retomada).
  function iniciarTimer(decorrido) {
    if (timerId) clearInterval(timerId);
    inicioMs = Date.now() - (decorrido || 0);
    atualizarTimer();
    timerId = setInterval(atualizarTimer, 1000);
  }

  // Falha (apos o retry silencioso): mensagem amigavel + botao de retry manual.
  // Nunca trava a tela.
  function mostrarFalha(msg, acao) {
    acaoPendente = acao || null;
    mostrarErro(msg || 'Tivemos um problema de conexão. Toque para tentar de novo.');
    btnRetry.hidden = !acaoPendente;
    setOrbe('idle');
  }

  function limparFalha() {
    mostrarErro('');
    btnRetry.hidden = true;
    acaoPendente = null;
  }

  function pararTudo() {
    if (timerId) clearInterval(timerId);
    if (recorder && recorder.state !== 'inactive') {
      try { recorder.stop(); } catch (e) { /* ignore */ }
    }
    // Para a gravacao de video se ativa. O onstop SO faz upload quando encerrando=true
    // (encerramento real da entrevista); aqui (reset/load) nao dispara upload.
    if (videoRecorder && videoRecorder.state !== 'inactive') {
      try { videoRecorder.stop(); } catch (e) { /* ignore */ }
    }
    VM_MIDIA.pararTracks(micStream);
    VM_MIDIA.pararTracks(camStream);
    micStream = null;
    camStream = null;
  }

  // Reseta a tela de entrevista para o estado inicial limpo. Usada no load (estado
  // robusto, independente do markup) e ao restaurar do bfcache — onde o JS NAO
  // re-executa e o overlay pode ter ficado escondido (hidden=true) de uma visita
  // anterior em que se clicou "Iniciar". Sem isto, o overlay nunca reaparece e o
  // POST /start nunca dispara.
  function restaurarEstadoInicial() {
    pararTudo(); // encerra timer/gravacao/streams de qualquer estado anterior
    interviewId = null;
    ultimoAudioUrl = null;
    gravando = false;
    recorder = null;
    chunks = [];
    videoRecorder = null;
    videoChunks = [];
    encerrando = false;
    repeticoesSeguidas = 0;
    limparFalha(); // limpa erro + esconde botao de retry + zera acaoPendente
    setOrbe('idle');
    elPergunta.textContent = 'Preparando sua entrevista…';
    elChips.innerHTML = '';
    elTimer.textContent = '00:00';
    elTimer.classList.remove('vm-timer--esgotado');
    btnPtt.hidden = true;
    btnPtt.disabled = false;
    btnPtt.textContent = 'Toque para falar';
    btnPtt.classList.remove('vm-ptt--gravando');
    btnRepetir.hidden = true;
    camThumb.hidden = true;
    overlayIniciar.hidden = false; // overlay volta a aparecer -> permite reiniciar
    overlayProntoEm = performance.now();
  }

  // Escolhe um container de video suportado (Chrome/Firefox: webm; Safari: mp4).
  function escolherMimeVideo() {
    const tipos = ['video/webm;codecs=vp8,opus', 'video/webm', 'video/mp4'];
    for (const t of tipos) {
      if (window.MediaRecorder && MediaRecorder.isTypeSupported(t)) return t;
    }
    return '';
  }

  // Inicia a gravacao de VIDEO da entrevista (camera + microfone), em paralelo ao
  // push-to-talk. So grava se a camera ja foi concedida (NAO pede prompt aqui) — a
  // camera e opcional no funil; sem ela, a entrevista segue normalmente sem video.
  // Mostra tambem o thumbnail da webcam. Best-effort: qualquer falha e silenciosa.
  async function iniciarVideo() {
    try {
      if (!navigator.permissions || !navigator.permissions.query) return;
      let permitida = false;
      try {
        const status = await navigator.permissions.query({ name: 'camera' });
        permitida = status.state === 'granted';
      } catch (e) {
        permitida = false; // navegador sem suporte a query de permissao
      }
      if (!permitida) return;

      // Resolucao limitada a 480p (controla tamanho/banda); audio junto p/ a fala entrar
      // na gravacao. O elemento de preview e muted (sem eco).
      camStream = await navigator.mediaDevices.getUserMedia({
        video: { width: { ideal: 854 }, height: { ideal: 480 } },
        audio: true,
      });
      camVideo.srcObject = camStream;
      camThumb.hidden = false;

      if (!window.MediaRecorder) return; // sem MediaRecorder: so o thumbnail
      const mime = escolherMimeVideo();
      const opcoes = {
        videoBitsPerSecond: 500000,   // ~0,5 Mbps p/ encolher o arquivo
        audioBitsPerSecond: 64000,    // ~64 kbps de áudio
      };
      if (mime) opcoes.mimeType = mime;
      videoRecorder = new MediaRecorder(camStream, opcoes);
      videoChunks = [];
      videoRecorder.ondataavailable = (ev) => {
        if (ev.data && ev.data.size > 0) videoChunks.push(ev.data);
      };
      // Upload SO ocorre no encerramento real (encerrando=true); paradas de
      // reset/load nao disparam upload.
      videoRecorder.onstop = () => {
        if (encerrando) enviarVideoEFechar();
      };
      videoRecorder.start();
    } catch (e) {
      // Sem camera/sem suporte: video e best-effort, segue sem gravar.
      videoRecorder = null;
    }
  }

  // Redireciona para a finalizacao (ponto unico).
  function finalizarRedirect() {
    window.location = '/finalizacao';
  }

  // Encerramento da entrevista: se ha gravacao de video ativa, mostra "processando"
  // e para o recorder (o onstop chama enviarVideoEFechar). Sem video, redireciona ja.
  function encerrarComVideo() {
    if (!videoRecorder || videoRecorder.state === 'inactive') {
      finalizarRedirect();
      return;
    }
    setOrbe('pensando');
    estadoTexto.textContent = 'Salvando sua entrevista…';
    elPergunta.textContent = 'Salvando sua entrevista…';
    try {
      videoRecorder.stop();
    } catch (e) {
      finalizarRedirect();
    }
  }

  // Monta o blob de video e o envia ao servidor; redireciona ao terminar (sucesso OU
  // falha — a gravacao NUNCA bloqueia a finalizacao). Timeout generoso (~6 min) para
  // o upload + Drive; se estourar, redireciona mesmo assim.
  function mostrarProgresso() {
    if (elProgresso) elProgresso.hidden = false;
    atualizarProgresso(0);
  }

  function atualizarProgresso(pct) {
    if (elProgresso) elProgresso.classList.remove('vm-progresso--indeterminado');
    if (elProgressoBarra) elProgressoBarra.style.width = pct + '%';
    if (elProgressoBarraWrap) elProgressoBarraWrap.setAttribute('aria-valuenow', String(pct));
    if (elProgressoRotulo) elProgressoRotulo.textContent = 'Enviando vídeo… ' + pct + '%';
  }

  function progressoIndeterminado() {
    if (elProgresso) elProgresso.classList.add('vm-progresso--indeterminado');
    if (elProgressoBarra) elProgressoBarra.style.width = '';
    if (elProgressoBarraWrap) elProgressoBarraWrap.removeAttribute('aria-valuenow');
    if (elProgressoRotulo) elProgressoRotulo.textContent = 'Finalizando…';
  }

  function enviarVideoEFechar() {
    VM_MIDIA.pararTracks(camStream);
    camStream = null;

    const tipo = videoRecorder && videoRecorder.mimeType ? videoRecorder.mimeType : 'video/webm';
    const blob = new Blob(videoChunks, { type: tipo });
    videoChunks = [];

    if (!interviewId || !blob.size) {
      finalizarRedirect();
      return;
    }

    // Best-effort: qualquer desfecho (sucesso, erro, timeout ou abort) redireciona
    // uma unica vez para /finalizacao. NUNCA bloqueia/erra para o candidato.
    let concluido = false;
    function concluir() {
      if (concluido) return;
      concluido = true;
      finalizarRedirect();
    }

    mostrarProgresso();
    let indeterminado = false;

    const xhr = new XMLHttpRequest();
    xhr.upload.onprogress = function (e) {
      if (!e.lengthComputable) return;
      const pct = Math.round((e.loaded / e.total) * 100);
      if (pct >= 100) {
        if (!indeterminado) {
          indeterminado = true;
          progressoIndeterminado();
        }
      } else {
        atualizarProgresso(pct);
      }
    };
    xhr.onload = concluir;
    xhr.onerror = concluir;
    xhr.ontimeout = concluir;
    xhr.onabort = concluir;
    xhr.open('POST', `/api/interview/video-upload?interview_id=${encodeURIComponent(interviewId)}`);
    xhr.setRequestHeader('Content-Type', tipo); // 'video/webm...' no header da requisicao (nao multipart)
    xhr.timeout = 6 * 60 * 1000;
    xhr.send(blob);
  }

  function aplicarResposta(dados) {
    // "Nao consegui ouvir": toca o aviso, reabre o push-to-talk e NAO avanca
    // topico/competencia. Apos 2 repeticoes seguidas, o proximo envio leva
    // forcar_avancar (o servidor segue com uma fala de transicao).
    if (dados.repetir) {
      repeticoesSeguidas++;
      elPergunta.textContent = dados.pergunta || '';
      tocarFala(dados.audio_url, () => {
        btnPtt.disabled = false;
        btnPtt.textContent = 'Toque para falar';
      });
      return;
    }

    // Resposta normal (ou encerramento): zera o contador de repeticoes.
    repeticoesSeguidas = 0;

    if (dados.encerrar) {
      encerrando = true;
      if (timerId) clearInterval(timerId);
      btnPtt.hidden = true;
      btnRepetir.hidden = true;
      // Mostra a despedida da Vera e toca o audio; so encerra (para a gravacao, sobe o
      // video e redireciona) DEPOIS que o audio termina, para o candidato ouvir o
      // fechamento. Sem audio (TTS falhou/nulo): encerra direto, sem travar — mesmo
      // fallback usado no restante do codigo para audio ausente.
      elPergunta.textContent = dados.pergunta || '';
      if (dados.audio_url) {
        tocarFala(dados.audio_url, encerrarComVideo);
      } else {
        encerrarComVideo();
      }
      return;
    }
    elPergunta.textContent = dados.pergunta || '';
    ultimoAudioUrl = dados.audio_url;
    if (Array.isArray(dados.topicos)) renderChips(dados.topicos);
    tocarFala(dados.audio_url);
    btnPtt.disabled = false;
    btnPtt.textContent = 'Toque para falar';
  }

  async function iniciarEntrevista() {
    console.log('[DIAG-START] iniciarEntrevista: ENTROU');
    limparFalha();
    setOrbe('pensando'); // segue em "pensando" durante o retry silencioso
    try {
      console.log('[DIAG-START] antes do fetch /start');
      const resp = await fetchComRetry('/api/interview/start', { method: 'POST' });
      console.log('[DIAG-START] /start status=', resp.status);
      const dados = await resp.json();
      console.log('[DIAG-START] /start body=', dados);
      if (!resp.ok || !dados.ok) {
        mostrarFalha(dados.erro || 'Não foi possível iniciar a entrevista.', iniciarEntrevista);
        return;
      }
      interviewId = dados.interview_id;
      if (typeof dados.max_duracao_min === 'number') maxMs = dados.max_duracao_min * 60000;

      // Retomada: se a entrevista ja estava concluida, vai direto pro encerramento.
      if (dados.encerrar) {
        aplicarResposta(dados);
        return;
      }

      ultimoAudioUrl = dados.audio_url;
      elPergunta.textContent = dados.pergunta || '';
      renderChips(dados.topicos);
      btnPtt.hidden = false;
      btnRepetir.hidden = false;
      // Retomada: o timer continua de onde estava (decorrido_ms do servidor).
      iniciarTimer(dados.decorrido_ms || 0);
      tocarFala(dados.audio_url);
      iniciarVideo();
    } catch (e) {
      console.log('[DIAG-START] /start CATCH:', e && e.message);
      mostrarFalha('Tivemos um problema de conexão. Toque para tentar de novo.', iniciarEntrevista);
    }
  }

  function escolherMime() {
    const tipos = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/ogg'];
    for (const t of tipos) {
      if (window.MediaRecorder && MediaRecorder.isTypeSupported(t)) return t;
    }
    return '';
  }

  async function comecarGravacao() {
    mostrarErro('');
    try {
      micStream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch (e) {
      mostrarErro(VM_MIDIA.mensagemErro(e, 'microfone'));
      return;
    }
    const mime = escolherMime();
    recorder = mime ? new MediaRecorder(micStream, { mimeType: mime }) : new MediaRecorder(micStream);
    chunks = [];
    recorder.ondataavailable = (ev) => {
      if (ev.data && ev.data.size > 0) chunks.push(ev.data);
    };
    recorder.onstop = enviarResposta;
    recorder.start();
    gravando = true;
    setOrbe('gravando');
    btnPtt.textContent = 'Gravando… (toque para enviar)';
    btnPtt.classList.add('vm-ptt--gravando');
  }

  function enviarResposta() {
    gravando = false;
    btnPtt.classList.remove('vm-ptt--gravando');
    VM_MIDIA.pararTracks(micStream);
    micStream = null;
    limparFalha();

    const tipo = recorder && recorder.mimeType ? recorder.mimeType : 'audio/webm';
    const blob = new Blob(chunks, { type: tipo });
    // Um tentativa_id estavel por resposta: reusado no retry para o servidor nao
    // processar a mesma resposta duas vezes (turnos duplicados).
    const tentativaId = gerarId();
    enviarForm(blob, tentativaId);
  }

  // Envia (ou reenvia) a resposta. Reusa blob + tentativaId no retry manual.
  async function enviarForm(blob, tentativaId) {
    setOrbe('pensando');
    btnPtt.disabled = true;
    const form = new FormData();
    form.append('interview_id', interviewId);
    form.append('audio', blob, 'resposta.webm');
    form.append('tentativa_id', tentativaId);
    // Apos 2 repeticoes seguidas, pede ao servidor para seguir mesmo assim.
    if (repeticoesSeguidas >= 2) form.append('forcar_avancar', '1');
    // Flag de teste (custo zero; o servidor so honra em mock).
    if (TESTE_REPETIR) form.append('teste_repetir', '1');

    try {
      const resp = await fetchComRetry('/api/interview/answer', { method: 'POST', body: form });
      const dados = await resp.json();
      if (!resp.ok || !dados.ok) {
        btnPtt.disabled = false;
        btnPtt.textContent = 'Toque para falar';
        mostrarFalha(dados.erro || 'Não foi possível enviar sua resposta.', () =>
          enviarForm(blob, tentativaId),
        );
        return;
      }
      aplicarResposta(dados);
    } catch (e) {
      btnPtt.disabled = false;
      btnPtt.textContent = 'Toque para falar';
      mostrarFalha('Tivemos um problema de conexão. Toque para tentar de novo.', () =>
        enviarForm(blob, tentativaId),
      );
    }
  }

  // Push-to-talk: 1o toque grava; 2o toque envia.
  btnPtt.addEventListener('click', () => {
    if (encerrando) return;
    if (gravando) {
      if (recorder && recorder.state !== 'inactive') recorder.stop();
    } else {
      comecarGravacao();
    }
  });

  // Retry manual: reexecuta a ultima acao que falhou (start ou envio de resposta).
  btnRetry.addEventListener('click', () => {
    const acao = acaoPendente;
    if (!acao) return;
    limparFalha();
    acao();
  });

  // Repetir pergunta: retoca o ultimo audio (sem nova chamada ao servidor).
  btnRepetir.addEventListener('click', () => {
    if (!gravando && ultimoAudioUrl) tocarFala(ultimoAudioUrl);
  });

  // Inicio (gesto do usuario destrava o audio no iOS).
  btnIniciar.addEventListener('click', async () => {
    // Ignora "clique fantasma": ao vir do teste de microfone, o clique do "Continuar"
    // chega como um click no botao Iniciar logo apos o load e reesconde o overlay
    // antes do usuario ver. Nenhum humano clica em <400ms do overlay ficar pronto.
    if (performance.now() - overlayProntoEm < 400) { console.log('[DIAG-START] guarda barrou clique (<400ms)'); return; }
    console.log('[DIAG-START] clique aceito, escondendo overlay');
    overlayIniciar.hidden = true;
    // Destrava ESTE MESMO <audio> (`audio`, data-audio) dentro do gesto tocando um
    // silêncio VÁLIDO e curto. Um play() bem-sucedido com fonte válida "abençoa" o nó,
    // e o desbloqueio vale para o audio.play() da 1ª fala (que roda após o await /start).
    // O MESMO `audio` será reusado por tocarFala. Fire-and-forget: nunca travar o início.
    try {
      audio.muted = true;
      audio.src = SILENCIO_WAV;
      audio.play()
        .then(() => {
          audio.pause();
          audio.currentTime = 0;
          audio.removeAttribute('src');
          audio.load();
          audio.muted = false;
        })
        .catch((err) => {
          console.log('[DIAG-START] prime rejeitou:', err && err.name);
          audio.muted = false;
        });
    } catch (e) { console.log('[DIAG-START] erro no prime:', e && e.message); }
    console.log('[DIAG-START] vai chamar iniciarEntrevista()');
    iniciarEntrevista();
  });

  window.addEventListener('pagehide', pararTudo);
  window.addEventListener('pageshow', (e) => {
    // Restauracao via bfcache (voltar/avancar): o JS nao re-executa, entao o DOM
    // pode ter ficado com o overlay escondido de uma visita anterior. Reseta.
    if (e.persisted) restaurarEstadoInicial();
  });
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden' && gravando && recorder && recorder.state !== 'inactive') {
      recorder.stop();
    }
  });

  // Estado inicial robusto: nao depende so do markup. Garante overlay visivel e
  // controles escondidos em qualquer carregamento (inclusive restauracoes inconsistentes).
  restaurarEstadoInicial();
})();

// ── Tela 11: Finalizacao — poll do status_ia ──
// Quando o server entrega a tela em 'processando' (data-poll="1"), polamos
// GET /api/interview/status ate um estado terminal e atualizamos a copy in-place.
// A tabela de apresentacao ESPELHA apresentacaoFinal() em src/routes/pages.js —
// manter sincronizada. Regra: SO 'descartar' oculta o WhatsApp; qualquer duvida/
// falha/timeout cai na NEUTRA (= 'indefinido') + WhatsApp (degradacao segura).
(function () {
  const secao = document.querySelector('[data-final-status]');
  if (!secao) return;
  // Server ja entregou um estado final (nao-'processando' ou sem data-poll): nada a fazer.
  if (secao.getAttribute('data-final-status') !== 'processando' || secao.getAttribute('data-poll') !== '1') {
    return;
  }

  const APRESENTACAO = {
    descartar: {
      kicker: 'Processo concluído',
      titulo: 'Processo encerrado',
      lead:
        'Agradecemos a sua participação. Desta vez não daremos andamento à sua candidatura, mas seu perfil fica registrado para futuras oportunidades.',
      mostrarWhatsapp: false,
    },
    avancar: {
      kicker: 'Boa notícia',
      titulo: 'Você avançou!',
      lead:
        'Parabéns! Você avançou nesta etapa do processo. Nosso recrutador entrará em contato com os próximos passos.',
      mostrarWhatsapp: true,
    },
    // NEUTRA: 'talvez' | 'indefinido' | 'erro' | timeout/falha caem aqui.
    indefinido: {
      kicker: 'Tudo certo',
      titulo: 'Entrevista concluída',
      lead:
        'Suas respostas foram registradas. A equipe de recrutamento vai analisar sua entrevista e entrar em contato pelos próximos passos.',
      mostrarWhatsapp: true,
    },
  };

  function apresentacaoDe(status) {
    if (status === 'descartar') return { estado: 'descartar', ...APRESENTACAO.descartar };
    if (status === 'avancar') return { estado: 'avancar', ...APRESENTACAO.avancar };
    // 'talvez'|'indefinido'|'erro'|qualquer outro terminal -> NEUTRA.
    return { estado: status || 'indefinido', ...APRESENTACAO.indefinido };
  }

  const elKicker = secao.querySelector('[data-final-kicker]');
  const elTitulo = secao.querySelector('[data-final-titulo]');
  const elLead = secao.querySelector('[data-final-lead]');
  const elWhatsapp = secao.querySelector('[data-final-whatsapp]'); // pode nao existir (sem env)

  const INTERVALO_MS = 2000;
  const MAX_TENTATIVAS = 17; // ~34s

  function aplicarTerminal(status) {
    const ap = apresentacaoDe(status);
    if (elKicker) elKicker.textContent = ap.kicker;
    if (elTitulo) elTitulo.textContent = ap.titulo;
    if (elLead) elLead.textContent = ap.lead;
    // WhatsApp: o server ja renderizou o <a> com nº/texto da env; so alternamos hidden.
    if (elWhatsapp) elWhatsapp.hidden = !ap.mostrarWhatsapp;
    secao.setAttribute('data-final-status', ap.estado);
    secao.removeAttribute('data-poll');
  }

  let tentativas = 0;
  let timer = null;

  async function checar() {
    tentativas += 1;
    try {
      const resp = await fetch('/api/interview/status', { headers: { Accept: 'application/json' } });
      if (!resp.ok) {
        // Erro de rede/401: degradacao segura -> NEUTRA + WhatsApp.
        aplicarTerminal('indefinido');
        return;
      }
      const dados = await resp.json();
      const s = dados && dados.status_ia;
      if (s && s !== 'processando') {
        aplicarTerminal(s); // terminal: para o poll e atualiza a tela.
        return;
      }
      // Ainda 'processando' ou null: continua polando ate o teto.
      if (tentativas >= MAX_TENTATIVAS) {
        aplicarTerminal('indefinido'); // timeout: NUNCA deixa preso em "Avaliando…".
        return;
      }
      timer = setTimeout(checar, INTERVALO_MS);
    } catch (e) {
      aplicarTerminal('indefinido'); // falha de rede: degradacao segura.
    }
  }

  timer = setTimeout(checar, INTERVALO_MS);
})();

// ── Tela de video introdutorio (Item 8): gating "assistir ate o fim" ──
// Espelha o padrao do consentimento LGPD (botao nasce disabled, habilita por condicao).
// Aqui a condicao e o fim do video: a IFrame Player API do YouTube chama o callback global
// onYouTubeIframeAPIReady ao carregar (o <script> do iframe_api so existe nesta tela) e
// emitimos o "Continuar" quando o player entra no estado ENDED (0). FAIL-OPEN: se a API do
// YouTube nao puder inicializar (rede/adblock corporativo) ou o video for inembutivel,
// liberamos o botao — melhor o candidato seguir do que ficar preso por uma falha de infra.
(function () {
  const tela = document.querySelector('[data-tela-video-intro]');
  if (!tela) return;
  const btnContinuar = tela.querySelector('[data-continuar-video]');
  if (!btnContinuar) return;
  const dica = tela.querySelector('[data-video-dica]');

  let liberado = false;
  function liberar(msg) {
    if (liberado) return;
    liberado = true;
    btnContinuar.disabled = false;
    btnContinuar.removeAttribute('aria-disabled');
    if (dica && msg) dica.textContent = msg;
  }

  btnContinuar.addEventListener('click', () => {
    if (btnContinuar.disabled) return;
    window.location = '/permissao-camera';
  });

  // Fail-open: se a API nunca inicializar (script bloqueado), libera apos 12s. Cancelado
  // assim que a API fica pronta — dai o gating real (ENDED) assume o controle.
  const failOpenApi = setTimeout(() => {
    liberar('Não foi possível verificar o vídeo automaticamente — você pode continuar.');
  }, 12000);

  window.onYouTubeIframeAPIReady = function () {
    clearTimeout(failOpenApi);
    if (!window.YT || !window.YT.Player) {
      liberar('Não foi possível carregar o vídeo — você pode continuar.');
      return;
    }
    // Vincula ao <iframe> ja existente (id="video-intro-player", com enablejsapi=1).
    new window.YT.Player('video-intro-player', {
      events: {
        onStateChange: (e) => {
          // 0 = YT.PlayerState.ENDED: fim do video -> libera o "Continuar".
          if (e && e.data === 0) liberar('Vídeo concluído — pode continuar.');
        },
        onError: () => {
          // Video indisponivel/nao incorporavel: fail-open p/ nao prender o candidato.
          liberar('O vídeo não pôde ser carregado — você pode continuar.');
        },
      },
    });
  };
})();
