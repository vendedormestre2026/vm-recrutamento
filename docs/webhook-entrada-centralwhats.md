# Webhook de entrada — especificação para a Central Whats

Documento para enviar à Central Whats. Descreve o endpoint que precisamos que eles chamem
quando alguém **responde** a uma das nossas mensagens ou **aperta um botão** de um template.

---

## Por que estamos pedindo isso

Hoje as respostas dos candidatos aparecem **apenas no Live Chat** do painel da Central Whats.
Não há nenhuma forma de o nosso sistema saber que alguém respondeu — nem por webhook, nem por
endpoint de consulta.

O efeito prático: quando uma pessoa responde "SAIR" a uma campanha de divulgação, esse pedido
só é atendido se um humano vir a mensagem no Live Chat e registrar o descadastro à mão. Isso
não escala, e cada pedido não atendido é uma mensagem a mais para quem já pediu para parar —
que no WhatsApp é o caminho direto para denúncia e perda do número.

Levantamento feito no nosso lado (2026-09-05), para deixar claro que a pergunta já foi
investigada antes de virar pedido:

| O que procuramos | Resultado |
| --- | --- |
| Webhook de mensagens recebidas | Não existe. Nenhuma documentação, nenhum endpoint de configuração. |
| Endpoint REST para listar mensagens recebidas | Não encontrado. A API que usamos expõe `POST /api/instances/{id}/messages` (envio) e `GET /api/instances/{id}/templates` (listagem de templates). |
| Cliques em botão de template | O contrato de envio aceita `vars.button0`, mas ele é o **parâmetro de URL** do botão (o valor que completa a URL dinâmica), e não um canal de retorno. |

O único caminho de entrada que existiria do nosso lado é o webhook direto da Meta
(`X-Hub-Signature-256`), que depende de um App próprio com App Review — abandonado justamente
quando o envio passou a ser feito por vocês.

---

## O que pedimos

### Endpoint

Nós expomos:

```
POST https://entrevista.vendedormestre.com.br/webhook/central-whats
Content-Type: application/json
```

### Autenticação

Preferimos, em ordem:

1. **HMAC-SHA256 sobre o corpo cru**, num cabeçalho `X-CentralWhats-Signature`, no formato
   `sha256=<hex>`, com um segredo compartilhado que vocês nos entregam uma vez. É o mesmo
   esquema da Meta e o que já sabemos validar.
2. **Token fixo** num cabeçalho `Authorization: Bearer <token>`, se o HMAC não for viável.

Sem nenhum dos dois nós **recusamos a requisição** (HTTP 401). Um webhook aberto é um
endpoint que qualquer pessoa usa para descadastrar terceiros.

Se for HMAC: a assinatura precisa ser calculada sobre os **bytes exatos** do corpo enviado.
Reserializar o JSON antes de assinar produz uma assinatura que não confere.

### Corpo esperado

O formato abaixo é uma proposta. **Se vocês já têm um formato de webhook, usem o de vocês** e
nos digam qual é — nós nos adaptamos. O que precisamos, em qualquer formato, são os quatro
campos marcados como obrigatórios.

```json
{
  "instance_id": "abc123",
  "event": "message.received",
  "message": {
    "id": "wamid.HBgN...",
    "from": "5547999582500",
    "timestamp": "2026-09-05T14:32:10Z",
    "type": "text",
    "text": { "body": "sair" }
  }
}
```

| campo | obrigatório | observação |
| --- | --- | --- |
| `message.from` | **sim** | Número de quem enviou, só dígitos com DDI. Aceitamos com ou sem `+`, e com ou sem o nono dígito. |
| `message.text.body` | **sim** para `type: "text"` | O texto exato, sem normalização. |
| `event` | **sim** | Para distinguir mensagem recebida de outros eventos. |
| `message.id` | desejável | Usamos para descartar entrega duplicada. |
| `message.timestamp` | desejável | ISO 8601 em UTC. |
| `instance_id` | desejável | Confirma que o evento é da nossa instância. |

### Cliques em botão

Se o template tiver um botão de resposta rápida (por exemplo, o botão nativo de
*Parar promoções* da Meta), pedimos o mesmo POST com:

```json
{
  "instance_id": "abc123",
  "event": "message.received",
  "message": {
    "id": "wamid.HBgN...",
    "from": "5547999582500",
    "timestamp": "2026-09-05T14:32:10Z",
    "type": "button",
    "button": { "text": "Parar promoções", "payload": "STOP_PROMOTIONS" }
  }
}
```

O que precisamos é o `payload` (ou, na falta dele, o `text`) e o `from`.

### Resposta e retentativas

- Respondemos **HTTP 200 sempre que a assinatura conferir**, mesmo se o processamento
  interno falhar. Isso é deliberado: um erro nosso não deve virar uma tempestade de
  reentregas do mesmo evento.
- Respondemos **401** para assinatura ausente ou inválida. Nesse caso **não retentem** — o
  problema é de configuração e retentar não resolve.
- Se vocês tiverem política de retentativa para 5xx, ela é bem-vinda: retentativa com backoff,
  por até algumas horas.
- **Entrega duplicada é esperada e tolerada.** O registro do nosso lado é idempotente pelo
  número, então o mesmo evento entregue duas vezes não produz efeito duplicado.

---

## O que faremos com isso

1. Validamos a assinatura. Sem ela, 401 e nada é processado.
2. Normalizamos o número para a nossa chave de identidade (DDI + DDD + últimos 8 dígitos, o
   que faz o mesmo número com e sem o nono dígito resolver para a mesma pessoa).
3. Avaliamos o texto contra a heurística abaixo.
4. Se for um pedido de saída, registramos opt-out de escopo **`campanha`** — a pessoa para de
   receber divulgação e convites, e **continua** recebendo as mensagens dos processos
   seletivos em que ela mesma se inscrever.
5. Mensagens que não são pedido de saída **não geram nenhum registro**. Não vamos usar este
   canal para arquivar conversa.

### A heurística, para vocês saberem exatamente o que será tratado como opt-out

Já implementada e coberta por testes do nosso lado
(`src/lib/pedidoSaidaWhatsapp.js`). O texto é normalizado (minúsculas, sem acento, pontuação
vira espaço) e então:

1. a mensagem precisa ter **no máximo 3 palavras**;
2. alguma palavra precisa ser **exatamente** uma destas: `sair`, `parar`, `pare`, `cancelar`,
   `descadastrar`, `remover`, `stop`;
3. nenhuma palavra pode ser uma negação (`nao`, `nunca`, `jamais`);
4. nenhuma palavra pode ser de outro contexto (`candidatura`, `vaga`, `inscricao`,
   `processo`, `entrevista`).

| mensagem | vira opt-out? | por quê |
| --- | --- | --- |
| `sair` | sim | palavra exata, mensagem curta |
| `PARAR.` | sim | caixa e pontuação são normalizadas |
| `quero sair` | sim | 2 palavras, contém `sair` |
| `me remover` | sim | 2 palavras, contém `remover` |
| `não quero parar de receber` | **não** | 5 palavras, e contém negação |
| `não posso parar de agradecer` | **não** | 5 palavras |
| `cancelar minha candidatura` | **não** | é sobre a candidatura, não sobre a divulgação |
| `obrigado!` | **não** | nenhuma palavra da lista |
| `ainda tem vaga?` | **não** | nenhuma palavra da lista |

---

## Enquanto o webhook não existe

O sistema já funciona sem ele, por dois caminhos:

- **Link de descadastro na mensagem**, com página pública própria
  (`/descadastro/<token>`). Depende de um template novo aprovado pela Meta — ver
  `docs/template-opt-out-meta.md`.
- **Registro manual pelo painel**, em `/admin/optouts`, com ação de um clique na listagem de
  candidatos. É o caminho usado hoje, a partir do que aparece no Live Chat.

O webhook substitui o segundo caminho por um automático. É a única peça que depende de vocês.

---

## Contato

Rafael — rafael@clickhero.com.br
