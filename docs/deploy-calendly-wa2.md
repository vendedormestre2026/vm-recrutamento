# Deploy: link do Calendly na WA2 e na campanha em massa

Roteiro para o Rafael executar. **Cada passo marcado com 🔒 só acontece com autorização
explícita e separada.** Nada aqui envia mensagem.

**Prazo:** o deploy precisa estar no ar **antes da entrevista da vaga 18 (GV Uniformes),
09/10/2026 às 16:00**.

## O que entra

| Commit | O que muda |
|---|---|
| `a0c8f11` | Texto novo da WA2 (convite da entrevista em grupo) |
| `38510f8` | Campo da vaga no admin: "Link para confirmar presença (Calendly)" |
| `6739767` | Avisos do admin falam em "link de confirmação (Calendly)" |
| `42cf99a` | Texto base e 7 sementes da campanha em massa apresentam o link como confirmação |

Sem mudança de schema: a coluna continua `jobs.link_meet`, agora com o link do Calendly.

**Hoje, antes do deploy**, a WA2 e a campanha em massa já mandam o Calendly com o rótulo
"Google Meet" (o código antigo). Por isso o deploy é urgente e **não** exige pausar a
sequência por causa do link.

## 1. Antes do deploy, no admin

- [ ] **Vaga 17 (OT Consórcios):** trocar `link_meet` de `https://meet.google.com/ssi-faue-qcj`
      para o link do Calendly. Com o texto novo, um link do Meet nesse campo sairia rotulado
      como "Link para confirmar presença".
- [ ] **Vaga 19 (DUO Oral Care):** confirmar o link — hoje é
      `https://calendly.com/jean-vendedormestre/teste-clone`, que parece de teste.
- [ ] Conferir que **toda vaga ativa com data futura** tem link do Calendly. Na leitura de
      06/10/2026: 18 e 19 com Calendly; 17 com Meet (data 05/10 já passou); 1, 2, 8, 11, 12 e 16
      sem link e sem data (caem no aviso "datas em breve").

## 2. 🔒 Push + deploy

- [ ] `git push` da branch.
- [ ] `railway up` (o deploy é manual, não sai por push ou merge).

O texto da WA2 é montado **na hora do envio**: as WA2 pendentes na fila (1 em 06/10/2026)
saem com o texto novo assim que o container novo subir.

**Campanha em massa:** nenhuma campanha está ativa ou agendada (1–5 excluídas, 6 concluída sem
pendentes), então nada sai com as variações antigas gravadas no banco. Campanha **nova** nasce
das sementes novas. **Se a campanha 6 for reaproveitada**, abrir a campanha no admin e clicar
em **"Sugerir"** antes de ativar: ele regrava as 7 variações a partir das sementes novas (as
dela hoje são idênticas às sementes antigas, então nada editado à mão se perde).

## 3. Purgar o cache do Cloudflare

- [ ] Cloudflare → domínio → Caching → Configuration → **Purge Everything**.

## 4. Verificar a WA2 e a campanha renderizadas com dados reais, SEM enviar

Script somente leitura (abre o SQLite com `DATABASE_READONLY=1`, não toca o socket, não grava).
Salve localmente como `previa-calendly.js`:

```js
'use strict';
// Previa SOMENTE LEITURA da WA2 e das sementes da campanha em massa, com dados reais das vagas.
// Nao envia nada, nao toca socket, nao grava: o banco abre com readonly:true.
process.env.DATABASE_READONLY = '1';
const APP = process.env.APP_DIR || '/app';
const db = require(`${APP}/src/db`);
const { montarTextoWA2 } = require(`${APP}/src/lib/whatsappSequencia`);
const { proximaEntrevistaGrupo } = require(`${APP}/src/lib/entrevistaGrupo`);
const v = require(`${APP}/src/lib/variacoesMassaWa`);

console.log('DATABASE_PATH =', process.env.DATABASE_PATH, '| vagas =', db.listarVagas().length);
const ativas = db.listarVagas().filter((j) => j.ativo);
for (const vaga of ativas) {
  const link = vaga.link_meet || '(vazio)';
  const tipo = /calendly\.com/i.test(link) ? 'calendly' : /meet\.google/i.test(link) ? 'MEET' : link === '(vazio)' ? 'vazio' : 'OUTRO';
  const { texto, variante } = montarTextoWA2({ nome: 'Maria Teste' }, vaga);
  console.log(`\n════ vaga ${vaga.id} · ${vaga.titulo} · link ${tipo} · WA2 variante=${variante}`);
  if (variante === 'convite_grupo') console.log(texto);
}

const vaga = ativas.find((j) => proximaEntrevistaGrupo(j));
if (!vaga) {
  console.log('\nNenhuma vaga ativa com entrevista futura: sem previa da campanha.');
} else {
  const ctx = v.montarContexto({
    nome: 'Maria Teste', job: vaga, proxima: proximaEntrevistaGrupo(vaga),
    linkDescadastro: 'https://exemplo/descadastro-whatsapp/EXEMPLO', recrutador: 'Jean',
  });
  [v.TEXTO_BASE_PADRAO, ...v.VARIACOES_SEED].forEach((t, i) => {
    const r = v.resolverTexto(t, ctx);
    console.log(`\n════ campanha · ${i === 0 ? 'texto base' : `semente ${i}`} · vaga ${vaga.id} · faltando=${JSON.stringify(r.faltando)}`);
    console.log(r.texto);
  });
}
```

Rodar **dentro do container** (`railway ssh`, nunca `railway run`, que usaria o banco local):

```sh
B64=$(base64 < previa-calendly.js | tr -d '\n')
railway ssh "echo $B64 | base64 -d > /tmp/previa-calendly.js && node /tmp/previa-calendly.js; rm -f /tmp/previa-calendly.js"
```

Conferir:

- [ ] `DATABASE_PATH = /data/app.db` e `vagas = 17` (ou o total atual): prova de que leu produção.
- [ ] Toda vaga com `variante=convite_grupo` tem `link calendly`, e o texto traz
      "Link para confirmar presença na entrevista", o parágrafo do Google Meet e o horário
      **duas vezes, igual** (linha "Horário" e aviso de pontualidade).
- [ ] As 8 redações da campanha têm `faltando=[]`, o link rotulado como confirmação, a menção
      ao Google Meet e ao email/agenda.

## Rollback

```sh
git revert 42cf99a 6739767 38510f8 a0c8f11
```

Depois, 🔒 push + `railway up`. Não há dado a restaurar: nenhum registro do banco foi alterado
por este deploy (as variações de campanha gravadas ficaram como estavam, e o `link_meet` das
vagas foi trocado à mão no admin — reverter o código não mexe nele).
