# Disparo em massa: variações a partir do texto-base

Desde 2026-10-14 as 7 variações de uma campanha de **entrevista em grupo** saem do texto-base
digitado na campanha. O código está em `src/lib/variacoesMassaWa.js` (regras),
`src/lib/gerarVariacoesMassaWa.js` (geração por IA), `src/routes/admin_massa_wa.js` (tela) e
`src/whatsapp/massaOutbox.js` (envio).

## O bug que motivou

A campanha 9 ("Lembrete Entrevista em Grupo Deandhela") tinha um texto-base de **lembrete**:
"é daqui a pouco às 14h", com a sala do Meet escrita por extenso. As variações que saíram eram as
sementes fixas do **convite**: "confirme presença", com `{link_meet}` (que é o Calendly). A criação
da campanha e o botão "Sugerir com IA" gravavam as sementes sem ler o texto-base, e não havia
chamada nenhuma ao LLM. 46 pessoas receberam o convite no lugar do lembrete.

## As regras (tipo entrevista)

Cada variação é uma **redação** do texto-base, conferida contra ele na tela, no materializar, no
ativar, no teste e no worker. Ela é recusada se:

| Problema | Código |
|---|---|
| perde um token que o texto-base usa | `token_faltando` |
| usa um token que o texto-base não usa (exceto `{link_descadastro}`) | `token_inventado` |
| perde ou altera uma URL escrita no texto-base (comparação exata) | `url_alterada` |
| repete ≥ 85% das palavras do texto-base (Jaccard) | `parecida_com_base` |
| repete ≥ 85% das palavras de outra variação | `parecida` |
| tem menos de 0,6× ou mais de 1,6× o tamanho do texto-base | `tamanho_fora_do_base` |

`{data}`, `{horario}` e `{link_meet}` só são exigidos se o texto-base os usa. Quando o texto-base
tem horário ou link escritos à mão e não usa `{data}`, a tela mostra um aviso, sem bloquear: numa
campanha de mais de um dia, a mensagem anunciaria um horário que já passou.

Limiares: `SIMILARIDADE_MAXIMA`, `FATOR_TAMANHO_MIN` e `FATOR_TAMANHO_MAX`. As sementes atuais
ficam entre 0,45 e 0,68 contra o texto padrão, no máximo 0,58 entre si, e entre 0,83× e 0,99× do
tamanho dele.

**As sementes** só entram sozinhas quando o texto-base é exatamente o `TEXTO_BASE_PADRAO`, porque só
nesse caso elas são redações dele.

## O descadastro é do sistema

No tipo entrevista, nem o texto-base nem a variação precisam ter `{link_descadastro}`. No envio
(e na prévia e no teste, que usam a mesma função `resolverTexto`), o sistema acrescenta ao fim de
cada mensagem esta linha, com o link de cada destinatário:

```
Para não receber mais mensagens nossas, acesse: {link_descadastro}
```

A redação é a do texto padrão. Se a variação já tiver `{link_descadastro}` (as sementes têm),
nada é acrescentado e a mensagem nunca leva dois links. A linha nunca passa pelo LLM: o prompt
proíbe o modelo de escrever descadastro. Se o link não puder ser montado, o item não sai, como antes.

## Geração por IA

Interruptor: `MASSA_WA_LLM_ATIVO` (variável de ambiente, **nasce desligada**).

- **Desligada:** "Gerar variações com IA" e a criação com texto-base próprio recusam com
  "Geração por IA desligada: escreva as 7 variações manualmente". Nada é gravado; as 7 são
  escritas a mão.
- **Ligada:** até 3 chamadas ao LLM por geração. Cada tentativa pede só as que ainda faltam e
  devolve ao modelo o motivo das recusadas. Só grava se as 7 passarem.
- **Falha** (LLM fora, JSON inválido, resposta cortada, variações recusadas): nada é gravado, o
  erro fica em `campanhas_massa_wa.variacoes_erro` e aparece na tela. A campanha não materializa,
  não ativa nem envia. Nunca cai nas sementes.

## Variações desatualizadas

Toda gravação de variações (sementes, IA ou edição manual) guarda o hash do texto-base daquele
momento em `campanhas_massa_wa.variacoes_base_hash`. Se o texto-base for editado depois, o hash
deixa de bater e as variações ficam **desatualizadas**: a tela avisa; materializar, ativar e o
teste recusam; o worker pausa a campanha ativa. Nada regenera sozinho. É preciso clicar em
"Regenerar variações com IA" ou revisar e salvar as 7. Campanhas anteriores ao carimbo contam como
desatualizadas.

Motivos de pausa novos no worker: `MOTIVO_VARIACOES_COM_ERRO` e `MOTIVO_VARIACOES_DESATUALIZADAS`.

## Segmento

Inalterado. O texto-base do convite do segmento é fixo, e as sementes do convite são as redações
aprovadas dele. Continuam valendo os tokens obrigatórios do tipo, inclusive `{link_descadastro}`
dentro da própria variação, e o "Sugerir" restaura as sementes.

## Campanhas antigas

`src/scripts/regenerar-variacoes-massa-wa.js` lista as campanhas afetadas. É dry-run por padrão,
com o banco aberto somente leitura. `--campanha <id> --commit` regenera uma campanha por vez; só
age em `rascunho` ou `pausada`, exige `MASSA_WA_LLM_ATIVO=true`, e não muda o status nem a fila.

Leitura de produção em 2026-10-14: as campanhas 6, 7, 8 e 9 aparecem como afetadas, todas
encerradas, então não há o que regenerar. Só a 9 tem variações que não passam contra o próprio
texto-base. A 7 e a 8 usaram as sementes com um texto-base de convite parecido.

## Teste manual com o LLM real (exige autorização)

1. Depois do deploy, ligar `MASSA_WA_LLM_ATIVO=true` no Railway, com `MASSA_WA_MOCK=true` mantido.
2. Criar um **rascunho** com o texto-base da campanha 9 e uma vaga com reunião futura.
3. Conferir na tela:
   - as 7 variações passam;
   - todas têm a sala `https://meet.google.com/...` idêntica e "14h";
   - nenhuma tem "confirme presença" nem `{data}`;
   - a prévia das 7 termina com a linha de descadastro, uma vez;
   - aparece o aviso de horário/link escritos à mão.
4. Ver quantas chamadas foram feitas e quanto custaram: tabela `api_usage`, `origem = 'massa-wa'`.
   Não há tela para isso; consultar somente leitura via `railway ssh`.
5. Editar uma frase do texto-base e salvar: aviso de desatualizadas; "Materializar" recusa.
   Clicar em "Regenerar" e conferir que as novas refletem a frase editada.
6. "Teste para 1 número" em mock: o texto completo sai no log do Railway.
7. Excluir o rascunho. Decidir se `MASSA_WA_LLM_ATIVO` fica ligada.
