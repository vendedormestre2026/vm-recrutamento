'use strict';

// Tela de pareamento da instancia de WhatsApp. Montada em /admin/whatsapp pelo admin.js,
// herdando o `router.use(adminAuth)` — nao ha auth propria aqui, pelo mesmo motivo das
// demais telas do painel.
//
// ── ESTA TELA NAO CONECTA NADA ──
// Ela EXIBE o estado do socket e serve o QR quando ele existe. Quem abre a conexao e o boot
// do server.js, e so quando WHATSAPP_BAILEYS_ATIVO=true. Abrir socket a partir de um GET de
// painel seria dar a um clique de navegador o poder de iniciar uma sessao de WhatsApp — e um
// refresh acidental viraria uma tentativa de conexao.
//
// ── O QR VIVE EM MEMORIA, NAO NO BANCO ──
// Divergencia REGISTRADA em relacao ao enunciado, que pedia "404 se nao houver QR pendente
// no banco". Nao existe (nem deve existir) coluna de QR: ele vale ~20 segundos, e o proprio
// Baileys emite um novo quando o anterior expira. Persistir isso criaria a pior falha
// possivel desta tela — servir um QR morto para alguem que vai escanear e esperar funcionar.
// A fonte e connection.qrAtual(), apagada em qualquer fechamento (Incremento 3).

const express = require('express');
const QRCode = require('qrcode');

const conexao = require('../whatsapp/connection');
const { contarChavesAuth } = require('../whatsapp/authState');
const { chaveConfigurada } = require('../lib/whatsappSecrets');

// Rotulos e cores por status. Fora do template porque as duas telas (HTML e polling) leem a
// mesma tabela — divergir aqui faria a tela mostrar um texto no load e outro 3s depois.
const ROTULOS = {
  desconectado: { texto: 'Desconectado', cor: 'var(--cinza)' },
  pareando: { texto: 'Aguardando leitura do QR', cor: 'var(--laranja)' },
  conectado: { texto: 'Conectado', cor: '#1F7A3D' },
};

function criarRouterWhatsapp({ paginaAdmin, escapeHtml }) {
  const router = express.Router();

  // Estado consolidado, usado pelo JSON e pelo primeiro render. `connection_status` e
  // `updated_at` sao os nomes que o enunciado pediu; o resto e contexto que a tela precisa
  // para explicar POR QUE nao esta conectado — que e a pergunta real de quem abre isto.
  function estadoAtual() {
    const s = conexao.status();
    return {
      connection_status: s.status,
      updated_at: s.atualizadoEm,
      tem_qr: s.temQr,
      // Os tres motivos de "conectado" ser impossivel agora. Sem eles, a tela diria
      // "desconectado" e deixaria o operador adivinhar qual das tres coisas falta.
      baileys_ativo: s.ligado,
      chave_cifragem_ok: chaveConfigurada(),
      sessao_gravada: contarChavesAuth() > 0,
      tentativas: s.tentativas,
      ultimo_erro: s.ultimoErro,
    };
  }

  // ── GET /admin/whatsapp/status ──
  router.get('/status', (req, res) => {
    res.json(estadoAtual());
  });

  // ── GET /admin/whatsapp/qr.svg ──
  //
  // 404 quando nao ha QR. E o comportamento certo para um recurso que so existe durante a
  // janela de pareamento — devolver 200 com um SVG vazio faria o polling do cliente achar
  // que ha algo para mostrar.
  router.get('/qr.svg', async (req, res) => {
    const qr = conexao.qrAtual();
    if (!qr) {
      return res.status(404).json({ erro: 'Nenhum QR pendente. A instância não está em pareamento.' });
    }
    try {
      const svg = await QRCode.toString(qr, {
        type: 'svg',
        margin: 1,
        // Alto nivel de correcao: a tela pode ser fotografada de um monitor, e o QR do
        // WhatsApp e denso.
        errorCorrectionLevel: 'H',
        color: { dark: '#0D0B0A', light: '#FFFFFF' },
      });
      // Sem cache: o QR troca sozinho a cada ~20 s, e um SVG cacheado seria um QR morto na
      // tela — a mesma falha que a decisao de nao persistir no banco evita.
      res.set('Cache-Control', 'no-store, max-age=0');
      res.type('image/svg+xml').send(svg);
    } catch (err) {
      console.error(`[wa-admin] falha ao renderizar QR: ${err.message}`);
      res.status(500).json({ erro: 'Não foi possível gerar o QR.' });
    }
  });

  // ── GET /admin/whatsapp ──
  router.get('/', (req, res) => {
    const e = estadoAtual();
    const rotulo = ROTULOS[e.connection_status] || ROTULOS.desconectado;

    // Diagnostico do que falta. Ordem deliberada: a chave de cifragem vem antes do switch
    // porque, sem ela, ligar o switch produz erro no boot em vez de conexao.
    const pendencias = [];
    if (!e.chave_cifragem_ok) {
      pendencias.push(
        'WHATSAPP_SECRETS_KEY ausente ou inválida. Ela cifra a sessão; sem ela nada é ' +
          'gravado. Gere com <code>openssl rand -hex 32</code>.',
      );
    }
    if (!e.baileys_ativo) {
      pendencias.push(
        'WHATSAPP_BAILEYS_ATIVO não está em <code>true</code>. A instância não tenta conectar.',
      );
    }

    const blocoPendencias = pendencias.length
      ? `<div class="aviso-alerta"><b>Para conectar, falta:</b><ul class="lista">${pendencias
          .map((p) => `<li>${p}</li>`)
          .join('')}</ul></div>`
      : '';

    const conteudo = `
    <h1>WhatsApp — pareamento</h1>
    <p class="admin-sub" style="margin-bottom:1.25rem">
      Instância <b>${escapeHtml(conexao.status().instancia)}</b>. Esta tela apenas exibe o
      estado e o QR — a conexão é iniciada no boot da aplicação.
    </p>

    ${blocoPendencias}

    <div class="bloco-card" open>
      <div class="comp-cab">
        <div>
          <span class="funil-rotulo">Status</span>
          <div id="wa-status" class="comp-nota" style="color:${rotulo.cor}">${escapeHtml(rotulo.texto)}</div>
          <small id="wa-desde" style="color:var(--cinza)">desde ${escapeHtml(e.updated_at)}</small>
        </div>
        <div style="text-align:right;color:var(--cinza);font-size:.85rem">
          <div>sessão gravada: <b id="wa-sessao">${e.sessao_gravada ? 'sim' : 'não'}</b></div>
          <div>tentativas de reconexão: <b id="wa-tent">${e.tentativas}</b></div>
        </div>
      </div>
    </div>

    <div class="bloco-card">
      <div id="wa-qr-area" style="text-align:center;padding:1rem">
        <p id="wa-qr-vazio" style="color:var(--cinza)">
          Nenhum QR pendente. Ele aparece aqui quando a instância entra em pareamento.
        </p>
        <div id="wa-qr" style="max-width:320px;margin:0 auto"></div>
      </div>
      <p class="admin-rodape" style="font-size:.85rem">
        Abra o WhatsApp no celular do número → <b>Aparelhos conectados</b> →
        <b>Conectar um aparelho</b> e aponte para o código. O QR se renova sozinho a cada
        poucos segundos; esta tela acompanha.
      </p>
    </div>

    <script>
      (function () {
        var ROTULOS = ${JSON.stringify(ROTULOS)};
        var qrArea = document.getElementById('wa-qr');
        var vazio = document.getElementById('wa-qr-vazio');

        function pintar(e) {
          var r = ROTULOS[e.connection_status] || ROTULOS.desconectado;
          var alvo = document.getElementById('wa-status');
          alvo.textContent = r.texto;
          alvo.style.color = r.cor;
          document.getElementById('wa-desde').textContent = 'desde ' + e.updated_at;
          document.getElementById('wa-sessao').textContent = e.sessao_gravada ? 'sim' : 'não';
          document.getElementById('wa-tent').textContent = e.tentativas;
        }

        // O QR vem por FETCH, e nao por <img src>. Um <img> nao manda o cookie de sessao em
        // toda configuracao de SameSite, e a rota e protegida pelo adminAuth — o src direto
        // renderizaria a tela de login dentro do <img>, ou nada, sem dizer por que.
        function buscarQr() {
          return fetch('/admin/whatsapp/qr.svg', { credentials: 'same-origin' })
            .then(function (r) {
              if (r.status === 404) return null;
              if (!r.ok) throw new Error('HTTP ' + r.status);
              return r.text();
            })
            .then(function (svg) {
              if (svg) {
                qrArea.innerHTML = svg;
                vazio.hidden = true;
              } else {
                qrArea.innerHTML = '';
                vazio.hidden = false;
              }
            })
            .catch(function () { /* transitorio: o proximo ciclo tenta de novo */ });
        }

        function ciclo() {
          fetch('/admin/whatsapp/status', { credentials: 'same-origin' })
            .then(function (r) { return r.json(); })
            .then(function (e) {
              pintar(e);
              return e.tem_qr ? buscarQr() : buscarQr();
            })
            .catch(function () {});
        }

        ciclo();
        setInterval(ciclo, 3000);
      })();
    </script>`;

    res.send(paginaAdmin({ titulo: 'WhatsApp', conteudo }));
  });

  return router;
}

module.exports = { criarRouterWhatsapp, ROTULOS };
