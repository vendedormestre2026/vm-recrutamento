# Deploy e ativação: WA3 (lembretes da entrevista em grupo)

Roteiro para o Rafael executar. **Cada passo marcado com 🔒 só acontece com autorização
explícita e separada.** Até o passo 6, nada é enviado a candidato nenhum.

## O que entra

| Commit | O que muda |
|---|---|
| `981c599` | Campo da vaga "Link da sala da entrevista (Google Meet)" (`jobs.link_meet_reuniao`) |
| `b5a6937` | Cronograma: véspera 18h, 2h antes, 15 min antes; tolerâncias; janela 07h–21h; carência de 10 min |
| `0ed9cd0` | Textos: 3 variações por tipo |
| `d5ab6d1` | Tabelas `lembretes_entrevista_enviados` e `lembretes_entrevista_reunioes` + público |
| `7ae8983` | Opt-out: transacional se houve WA2, campanha se o único convite veio da massa |
| `060ac52` | Worker (reserva antes de enviar, 9º dígito, carência) |
| `a9b517b` | Agendamento (tick de 1 min) e interruptor `wa3_ativo` em /admin/config |
| `f4f3acb` | Tela da vaga: alertas, prévia e histórico |
| `1f59e51` | A massa cede a vez ao WA3 real pendente e conta os envios dele no espaçamento de 15 s |

**Banco:** só migrações aditivas (1 coluna em `jobs`, 2 tabelas novas), criadas no boot.

**Estado ao subir:** `wa3_ativo` ausente = **desligado**; `WA3_MOCK` ausente = **simulação**. Nenhuma
vaga tem a sala do Meet preenchida (o campo é novo), então mesmo ligado nada sairia.

## 1. 🔒 Push + deploy

- [ ] `git push` da branch.
- [ ] `railway up` (o deploy é manual, não sai por push ou merge).
- [ ] No log do boot: `[wa3] varredura agendada a cada 1 min` e, logo depois,
      `[wa3] desativado (wa3_ativo); ciclos serao pulados em silencio.`

## 2. Purgar o cache do Cloudflare (manual)

- [ ] Cloudflare → domínio → Caching → Configuration → **Purge Everything**.

## 3. ⛔ OBRIGATÓRIO: conferir se há convites marcados em modo mock

**Sem esta conferência, não ligar `wa3_ativo`.**

O WA3 manda lembrete a quem recebeu o convite (WA2 `convite_grupo` ou item de massa de vagas
abertas). Em modo mock, os dois motores marcam a linha como `enviado` **sem enviar**, e não existe
coluna que diferencie uma coisa da outra (`entregue_em` nunca é gravado). Um convite "enviado" em
mock viraria lembrete real para alguém que nunca foi convidado.

Script **somente leitura** (o banco abre com `DATABASE_READONLY=1`; não toca o socket, não grava,
não registra "reunião vista"). Salve localmente como `conferir-mock-wa3.js`:

```js
'use strict';
// SOMENTE LEITURA. Conferencia de convites marcados em modo mock, antes de ligar o WA3.
process.env.DATABASE_READONLY = '1';
const APP = process.env.APP_DIR || '/app';
const db = require(`${APP}/src/db`);
const { previaLembretes } = require(`${APP}/src/lib/publicoLembreteEntrevista`);

console.log('DATABASE_PATH =', process.env.DATABASE_PATH);
console.log('WHATSAPP_SEQUENCIA_MOCK =', JSON.stringify(process.env.WHATSAPP_SEQUENCIA_MOCK), '(ausente = true)');
console.log('MASSA_WA_MOCK           =', JSON.stringify(process.env.MASSA_WA_MOCK), '(ausente = true)');
console.log('WA3_MOCK                =', JSON.stringify(process.env.WA3_MOCK), '(ausente = true)');

// Janela que o WA3 enxerga: convites de ate 10 dias antes de uma reuniao. 15 dias cobre com folga.
const desde = new Date(Date.now() - 15 * 24 * 3600 * 1000).toISOString().replace('T', ' ').slice(0, 19);
for (const vaga of db.listarVagas().filter((v) => v.ativo)) {
  const convites = db.listarConvitesEntrevistaGrupo(vaga.id).filter((c) => c.convite_em >= desde);
  if (!convites.length) continue;
  const porDia = {};
  for (const c of convites) {
    const k = `${c.convite_em.slice(0, 10)} ${c.origem}`;
    porDia[k] = (porDia[k] || 0) + 1;
  }
  console.log(`\n════ vaga ${vaga.id} · ${vaga.titulo} · sala Meet: ${vaga.link_meet_reuniao ? 'sim' : 'NAO'}`);
  for (const [k, n] of Object.entries(porDia).sort()) console.log(`  ${k}: ${n} convite(s)`);
  const p = previaLembretes(vaga, { mock: true });
  for (const r of p.reunioes) console.log(`  reuniao ${r.inicioUtc} UTC: ${r.pessoas} pessoa(s) receberiam lembrete`);
}
```

Rodar **dentro do container** (`railway ssh`, nunca `railway run`, que usaria o banco local):

```sh
B64=$(base64 < conferir-mock-wa3.js | tr -d '\n')
railway ssh "echo $B64 | base64 -d > /tmp/conferir-mock-wa3.js && node /tmp/conferir-mock-wa3.js; rm -f /tmp/conferir-mock-wa3.js"
```

Conferir, nesta ordem:

- [ ] `DATABASE_PATH = /data/app.db`: prova de que leu produção.
- [ ] `WHATSAPP_SEQUENCIA_MOCK` é `"false"` hoje. Se estiver `"true"` ou ausente, **todo** WA2 atual é
      simulado: **PARAR**.
- [ ] Para cada dia/origem listado (`wa2` ou `massa`), confirmar que naquele dia o motor estava em
      **envio real**: histórico de variáveis/deploys do serviço no Railway, e o log do período sem
      linhas `[wa-seq] (mock)` (WA2) ou `[massa-wa] (mock)` (massa). Na dúvida sobre um dia, **não
      ativar** até decidir o que fazer com aquela vaga (a forma segura é não preencher a sala do Meet
      nela, porque sem sala ela não entra no WA3).
- [ ] As contagens "receberiam lembrete" batem com o tamanho esperado de cada turma.

## 4. Preencher a sala do Meet e a data na vaga

Na edição da vaga (admin → Vagas → Editar):

- [ ] **Link da sala da entrevista (Google Meet)**, começando com `https://`.
- [ ] Reunião (data + horário de Brasília). O Calendly continua no campo próprio e é opcional para o
      lembrete (sem ele, a linha "inscreva-se" some do texto).
- [ ] Salvar.

## 5. Conferir alertas e prévia na tela da vaga

- [ ] Nenhum alerta vermelho de WA3 ("falta o link da sala", "não começa com https://",
      "Reunião desatualizada").
- [ ] Bloco **Lembretes de WhatsApp da entrevista (WA3)**: "Reunião N — data hora · X pessoa(s)
      convidada(s)", e uma linha por lembrete (Véspera 18h, 2h antes, 15 min antes) com o horário e a
      situação ("a enviar", "pulado (horário já passou)" etc.).
- [ ] O aviso "Carência" aparece até o worker ver a reunião pela primeira vez (com o WA3 ligado) e
      some 10 min depois.

## 6. Ligar em simulação

- [ ] Conferir que `WA3_MOCK` está ausente ou `true` no Railway.
- [ ] /admin/config → aba WhatsApp → marcar **Lembretes da entrevista em grupo (WA3)**. A tela deve
      dizer "⚠️ Modo simulação".
- [ ] No log, no horário de cada lembrete: `[wa3] (mock) wa3b vaga N -> 5547****1234 ... NAO enviado.`
- [ ] Na tela da vaga, o histórico mostra `enviado (simulação)`.

Em simulação, a massa **não** cede a vez ao WA3 (mock não usa o socket). Isso é esperado.

## 7. 🔒 Teste real com um número seu

Ver a seção abaixo. Só um número recebe, se só a vaga de teste tiver a sala do Meet preenchida.

## 8. 🔒 Ligar para todos

- [ ] Preencher a sala do Meet nas vagas reais, uma de cada vez, conferindo a prévia de cada uma.
- [ ] Acompanhar o log `[wa3] ciclo concluido — enviados: … pulados: … opt-out: … falhas: …`.

---

## Como montar o cenário de teste real com um número meu

O WA3 envia para **todas** as vagas ativas que têm a sala do Meet preenchida. O isolamento do teste
vem daí: **só a vaga de teste pode ter `link_meet_reuniao` preenchido.** Como o campo é novo, em
produção ele está vazio em todas as vagas até alguém preencher. Confirme pelo script do passo 3
("sala Meet: NAO" em todas as outras).

### Registros que precisam existir

1. **Vaga de teste aberta** (`ativo = 1`), com:
   - **Link para confirmar presença (Calendly)** preenchido, **antes** de você se candidatar. Sem
     ele, o WA2 cai na variante "datas em breve" (`sem_reuniao`) e você não conta como convidado;
   - **Reunião 1** num horário que torne os lembretes testáveis **dentro da janela 07h–21h**:
     - para ver o **2h antes** e o **15 min antes** no mesmo dia: reunião hoje, pelo menos ~2h30
       depois de ligar o WA3 (2h + carência de 10 min + folga) e até 21:14 (senão o de 15 min cai
       depois das 21h e é pulado como `fora_janela`);
     - para ver também a **véspera**: reunião amanhã; o lembrete sai hoje às 18h;
   - **Link da sala do Meet** com `https://`.
2. **Candidatura sua nessa vaga**, feita pelo formulário público com o seu celular, com o
   transacional (WA1/WA2) ligado em **envio real**. O WA2 com o convite chega no seu WhatsApp. Isso
   cria o registro que o WA3 exige (`whatsapp_sequencia_envios`: `etapa = 'wa2'`,
   `status = 'enviado'`, `variante = 'convite_grupo'`).
   - O convite precisa sair **antes** do horário de cada lembrete que você quer ver (convite depois
     do horário = `pulado (convite chegou depois do horário)`) e **no máximo 10 dias antes** da
     reunião.
3. **Status do recrutador** da sua candidatura: vazio, "sem decisão" ou "em análise". Aprovado ou
   reprovado tira você da lista.
4. **Sem opt-out total** no seu número (/admin → Opt-out). Como você recebeu WA2, um opt-out só de
   campanha não bloqueia o lembrete.
5. **Seu número com e sem o 9º dígito:** o worker consulta as duas variantes e usa a sem 9 só se só
   ela estiver confirmada no WhatsApp. Se o seu WA2 chegou, o lembrete chega pelo mesmo caminho.

### O que esperar

**Na prévia (tela da vaga), antes de ligar:**
"Reunião 1 — … · 1 pessoa(s) convidada(s)", com "1 a enviar" nos lembretes ainda por vir, e
"1 pulado(s) (horário já passou)" nos que já passaram. Aviso de carência até o primeiro tick.

**Com `WA3_MOCK=true` (passo 6):** no horário, log `[wa3] (mock) …` e histórico
`enviado (simulação)`. Nada chega no seu celular.

**Com `WA3_MOCK=false` (🔒 trocar a variável no Railway e reiniciar o serviço):** a tela de
/admin/config passa a dizer "🔴 Envio real". No horário, a mensagem chega no seu celular com o link
do Meet; o log mostra `[wa3] wa3b vaga N enviado para 5547****1234 (variacao k).`; o histórico mostra
`enviado` sem "(simulação)" e o telefone mascarado.

### O mock não bloqueia o envio real depois

A chave única é `UNIQUE(job_id, telefone_canonico, inicio_reuniao_utc, tipo, mock)`, ou seja, a linha
gravada em simulação (`mock = 1`) e a do envio real (`mock = 0`) são chaves **diferentes**. Testar
em mock primeiro e depois passar para real não impede o lembrete real: ele sai normalmente se ainda
estiver dentro da tolerância (véspera até 21h; 2h antes até 30 min de atraso; 15 min antes até 10 min
de atraso). Coberto pelo teste "mock: nao toca o socket, grava mock=1, e NAO bloqueia o envio real
depois" (`test/lembreteEntrevistaOutbox.test.js`).

Consequência prática: ao trocar de mock para real **no meio** do dia, os lembretes cujo horário já
chegou mas que ainda estão na tolerância saem **na hora da troca**.

### Depois do teste

- [ ] Para não lembrar ninguém da vaga de teste: apagar a sala do Meet dela, ou encerrá-la.
- [ ] Linhas `indeterminado` no histórico (em `enviando` há mais de 10 min) significam que o
      processo caiu entre o envio e a marcação. Não são reenviadas. Confira no celular se chegou.

## Rollback

- **Imediato, sem deploy:** desmarcar `wa3_ativo` em /admin/config. O próximo tick não envia nada,
  e a massa volta a se comportar exatamente como antes (no-op coberto por teste).
- **Código:** `git revert 1f59e51 f4f3acb a9b517b 060ac52 7ae8983 d5ab6d1 0ed9cd0 b5a6937 981c599`
  (mais o commit deste documento), depois 🔒 push + `railway up`. A coluna e as tabelas ficam no
  banco, sem uso (migração só aditiva). Nenhum dado existente é alterado.
