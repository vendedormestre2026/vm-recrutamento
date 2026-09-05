# Botão de descadastro nos templates de marketing — o que submeter à Meta

**Status: NADA foi submetido.** Este documento é a instrução de trabalho. A submissão é uma
ação humana e deliberada — o código não a faz.

---

## A decisão

O botão será do tipo **URL ("Acessar o site")**, com a URL marcada como dinâmica e o parâmetro
recebendo o token de descadastro. O clique abre a página `/descadastro/<token>`, que já existe
e está no ar.

O botão de **resposta rápida ("Personalizado") está descartado**: o clique volta como mensagem
recebida, e a Central Whats não tem canal de entrada (ver `docs/webhook-entrada-centralwhats.md`),
então o clique se perderia em silêncio. Não existe botão nativo de opt-out nesta conta.

**O corpo das mensagens não muda.** Nenhuma variável muda. A única alteração em cada template é
acrescentar um botão.

---

## Situação atual dos templates

Lido direto da Central Whats em 2026-09-05. Os textos abaixo são os aprovados hoje.

### `nova_vaga_v1` — MARKETING — pt_BR — APPROVED

Corpo atual, **sem nenhuma alteração**:

```
Olá {{1}}! 
Surgiu uma nova oportunidade que combina com seu perfil: {{2}}. 

Veja os detalhes e candidate-se: {{3}}. 

Boa sorte
```

| variável | conteúdo | permanece |
| --- | --- | --- |
| `{{1}}` | nome | idêntica |
| `{{2}}` | cargo | idêntica |
| `{{3}}` | link | idêntica |

Não tem rodapé nem botão hoje. O botão de descadastro será o **primeiro**, portanto **índice 0**.

### `nova_vaga_v2` — MARKETING — pt_BR — APPROVED

Corpo atual, **sem nenhuma alteração**:

```
Olá {{1}}, tudo bem? 
Aqui é o time Vendedor Mestre. 

Temos uma vaga aberta que pode te interessar: {{2}}. 

Confira: {{3}}

Boa sorte.
```

Rodapé atual, **sem alteração**: `Vendedor Mestre - Recrutamento de Vendedores`

| variável | conteúdo | permanece |
| --- | --- | --- |
| `{{1}}` | nome | idêntica |
| `{{2}}` | cargo | idêntica |
| `{{3}}` | link | idêntica |

Não tem botão hoje. O botão de descadastro será o **primeiro**, portanto **índice 0**.

### `convite_grupo_vagas_vm` — MARKETING — pt_BR — APPROVED

Corpo atual, **sem nenhuma alteração**:

```
Oi {{1}}! Aqui é do time da Vendedor Mestre 👋

Você já passou pelo nosso processo seletivo pra vaga {{2}} e queremos te avisar em primeira mão quando surgirem novas vagas de vendas em {{3}}.

Criamos um grupo no WhatsApp só pra avisar de novas vagas na sua cidade — apenas alertas de vaga, sem spam e conversas desnecessárias.

Quer entrar? É 100% gratuito. Clique no botão "ENTRAR NO GRUPO" aqui embaixo agora.

E se não quiser participar é só ignorar esta mensagem.
```

Rodapé atual, **sem alteração**: `Vendedor Mestre - Recrutamento de Vendedores`

| variável | conteúdo | permanece |
| --- | --- | --- |
| `{{1}}` | nome | idêntica |
| `{{2}}` | vaga | idêntica |
| `{{3}}` | cidade | idêntica |

> ⚠️ **Este já tem um botão.** O botão "Entrar no Grupo" (URL dinâmica
> `https://entrevista.vendedormestre.com.br/grupo/{{1}}`, com o slug da praça) **não pode ser
> alterado nem reordenado** — ele é o índice 0 e o código depende disso. O botão de descadastro
> entra **depois dele**, como **índice 1**.

---

## O botão a acrescentar

Idêntico nos três templates, exceto pelo índice que ele ocupa.

| campo | valor |
| --- | --- |
| tipo | **URL** ("Acessar o site") |
| rótulo | `Não quero mais receber` |
| tipo de URL | **Dinâmica** |
| URL base | `https://entrevista.vendedormestre.com.br/descadastro/` |
| variável | `{{1}}` no fim da URL |

O rótulo tem **22 caracteres**, dentro do limite de 25 da Meta.

A URL completa que a Meta monta fica assim:

```
https://entrevista.vendedormestre.com.br/descadastro/{{1}}
```

### Amostra a preencher no formulário

A Meta exige um exemplo de valor para a variável. Use este — é um token de **amostra**, com a
estrutura correta e uma assinatura de brinquedo, que **não** abre a página de ninguém:

```
djE6NTU0Nzk5OTk5OTk5.b9c2f85da7a4f6e759cd955f8fe56bbd
```

Se o formulário pedir a URL completa de exemplo em vez de só o valor:

```
https://entrevista.vendedormestre.com.br/descadastro/djE6NTU0Nzk5OTk5OTk5.b9c2f85da7a4f6e759cd955f8fe56bbd
```

> O token real é diferente para cada destinatário e é gerado no momento do envio. O ponto e os
> caracteres do exemplo fazem parte do formato — não os remova.

---

## ⚠️ Submeta UM POR VEZ, começando por `nova_vaga_v2`

Alterar um template aprovado **cria uma nova versão**, e ele fica **em revisão** até a Meta
aprovar. Enquanto isso ele pode ficar indisponível para envio.

Submeter os três de uma vez pode **parar toda a divulgação ao mesmo tempo**. A ordem sugerida:

1. **`nova_vaga_v2`** — comece por ele. É o mais simples (sem botão hoje) e o `nova_vaga_v1`
   continua disponível como alternativa enquanto ele estiver em revisão.
2. **`nova_vaga_v1`** — só depois que o v2 for aprovado.
3. **`convite_grupo_vagas_vm`** — por último, porque é o que já tem botão e o único onde há
   risco de mexer no que funciona.

Entre um e outro, confirme que o anterior voltou a **APPROVED**.

---

## Passo a passo

### Na Meta (pelo painel da Central Whats)

1. Abra o template e escolha editar. Confirme que vai criar uma versão nova.
2. **Não toque no corpo, nas variáveis nem no rodapé.** A única alteração é o botão.
3. Role até a seção de botões e clique em **"Adicionar botão"**.
4. Escolha **"Acessar o site"** (é o tipo URL). Não escolha "Personalizado" — esse é o de
   resposta rápida, e o clique dele se perde.
5. Em **Texto do botão**, escreva: `Não quero mais receber`
6. Em **Tipo de URL**, selecione **Dinâmica**. Se aparecer "Estática" selecionado, troque —
   com URL estática todo mundo receberia o mesmo link e ninguém conseguiria se descadastrar.
7. Em **URL do site**, cole: `https://entrevista.vendedormestre.com.br/descadastro/`
   O campo da variável aparece logo em seguida e completa a URL com `{{1}}`.
8. Em **amostra / exemplo**, cole o token de amostra da seção anterior.
9. No `convite_grupo_vagas_vm`, confira que o botão "Entrar no Grupo" continua **em primeiro
   lugar** e o novo em segundo.
10. Envie para revisão e aguarde o status voltar a **APPROVED**.

### Na Central Whats, depois da aprovação

11. O envio lê o template a partir do espelho local, então **é preciso ressincronizar**. No
    painel: **Campanha por WhatsApp → Sincronizar templates**. Isso chama
    `GET /api/instances/{id}/templates` e atualiza o registro local, inclusive a lista de
    botões do template.
12. Confira na tela que o template aparece com o botão de descadastro.

### No nosso painel, por último

13. **Configurações → WhatsApp → Opt-out → "Link nas mensagens"**. Marque.

    Enquanto esse interruptor estiver desmarcado, o parâmetro do botão **não é enviado** e o
    botão não funcionaria. Marque só depois que pelo menos um template estiver aprovado e
    ressincronizado.

---

## O que o código faz sozinho

- Gera o token por destinatário no momento do envio e preenche o parâmetro do botão no índice
  correto — lido dos botões sincronizados, não fixo no código.
- Se a geração do token falhar, **envia sem o parâmetro do botão** e registra no log. O envio
  nunca é abortado por causa disso.
- Se o template sincronizado não tiver botão, não manda parâmetro nenhum.
- Nunca envia parâmetro vazio (o erro 131008 da Meta trata vazio como ausente e recusa o envio
  inteiro).

---

## Possibilidade futura, não implementada

Um fallback em que a pessoa digita o próprio número na página de descadastro exigiria
verificação por código via WhatsApp — o que significa mais um template e custo por mensagem.
Com o botão funcionando, deixa de ser prioridade; fica registrado como opção caso o botão se
mostre insuficiente.
