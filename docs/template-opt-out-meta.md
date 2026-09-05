# Template com link de descadastro — texto proposto para aprovação da Meta

**Status: NÃO submetido.** Este documento é a entrega do Incremento 5. A submissão à Meta é
uma ação humana e deliberada — o código não a faz, e ninguém deve fazê-la a partir deste
arquivo sem revisar o texto antes.

---

## Por que um template novo é necessário

Levantamento read-only na base de produção em 2026-09-05 (`templates_whatsapp`, `ativo = 1`):

| `nome_meta` | categoria | variáveis (posição → campo) |
| --- | --- | --- |
| `confirmacao_cadastro_vaga_vm` | utility | 1 `nome_primeiro` · 2 `cargo_vaga` · 3 `link_grupo_regiao` |
| `nova_vaga_v1` | marketing | 1 `nome_primeiro` · 2 `cargo_vaga` · 3 `link_vaga` |
| `nova_vaga_v2` | marketing | 1 `nome_primeiro` · 2 `cargo_vaga` · 3 `link_vaga` |
| `convite_grupo_vagas_vm` | marketing | 1 `nome_primeiro` · 2 `cargo_vaga` · 3 `cidade` |

As três posições de **todos** os templates ativos já carregam dado com significado. Não há
variável de texto livre sobrando para receber a linha de descadastro reaproveitando um
template já aprovado.

Duas alternativas foram descartadas, e vale registrar por quê:

- **Reaproveitar a posição 3 de `convite_grupo_vagas_vm`** (que hoje leva `cidade`) trocaria
  a praça pelo link. A cidade aparece no corpo aprovado; trocá-la produziria uma frase
  quebrada em toda mensagem.
- **Concatenar o link ao valor de uma variável existente** (por exemplo, mandar
  `"Joinville — para sair, acesse ..."` na posição 3) é o tipo de gambiarra que a Meta
  reprova em revisão e que, se passar, deixa o corpo da mensagem ilegível.

Portanto: **uma versão nova do template, com uma quarta variável**, submetida à Meta.

> Nota de discrepância com o enunciado: ele mencionava `divulgacao_vaga_vm` com `ativo = 0`,
> pendente de aprovação. Esse registro **não existe** em produção. O `seed` do repositório
> cria um placeholder chamado `divulgacao_vaga_vm_PENDENTE`, que também não está lá. Os
> templates de divulgação em uso hoje são `nova_vaga_v1` e `nova_vaga_v2`, ambos ativos.

---

## Texto proposto

### 1. `convite_grupo_vagas_v2_vm` — categoria `marketing`

Substitui `convite_grupo_vagas_vm`. Mantém as três variáveis atuais na mesma ordem e
acrescenta a quarta.

```
Olá, {{1}}! Aqui é da Vendedor Mestre.

Estamos com processos seletivos abertos para vagas de {{2}} em {{3}} e criamos um grupo
onde avisamos primeiro sobre cada vaga nova da região.

Toque no botão abaixo para entrar.

_{{4}}_
```

| posição | campo do sistema | exemplo |
| --- | --- | --- |
| 1 | `nome_primeiro` | `Ana` |
| 2 | `cargo_vaga` | `comercial` |
| 3 | `cidade` | `Joinville` |
| 4 | `link_descadastro` | `https://entrevista.vendedormestre.com.br/descadastro/djE6NTU0Nzk5NTgyNTAw.a1b2c3…` |

Botão de URL dinâmica: **mantido como está hoje** (`.../grupo/{{1}}`, com o slug da praça).
Não mexa nele — o valor certo é o slug, não o link completo, e trocar isso já rendeu um 404
em envio real.

### 2. `nova_vaga_v3_vm` — categoria `marketing`

Substitui `nova_vaga_v1` / `nova_vaga_v2` na divulgação de vaga.

```
Olá, {{1}}! Aqui é da Vendedor Mestre.

Abrimos uma vaga de {{2}} que combina com o seu perfil. Os detalhes, a remuneração e o
formulário de inscrição estão aqui: {{3}}

_{{4}}_
```

| posição | campo do sistema |
| --- | --- |
| 1 | `nome_primeiro` |
| 2 | `cargo_vaga` |
| 3 | `link_vaga` |
| 4 | `link_descadastro` |

### Sobre a variável 4

O valor **nunca chega vazio**. Quando o link não pode ser montado (segredo ausente, telefone
sem chave canônica), o sistema envia no lugar a frase:

```
Para não receber mais, responda SAIR
```

Isso é intencional e não é um detalhe: a Meta trata variável posicional vazia como **ausente**
e recusa o envio inteiro com o erro **131008**, que o projeto classifica como `configuracao`
— categoria que **aborta o ciclo** e não marca ninguém. Já custou uma campanha de 1.463
destinatários. Uma falha ao montar um link acessório não pode parar a campanha.

A consequência para a revisão da Meta: o exemplo de valor cadastrado para `{{4}}` deve ser
uma **URL**, porque é o caso normal.

---

## Alternativa a considerar antes de submeter: botão de opt-out nativo

A Meta oferece, para templates de marketing, um botão de resposta rápida de descadastro
(`Stop promotions` / `Parar promoções`). Se ele for adicionado ao template:

- a variável 4 deixa de ser necessária, e o corpo fica mais limpo;
- o clique chega como uma **mensagem recebida** — ou seja, depende de um canal de entrada,
  que hoje não existe (ver `docs/webhook-entrada-centralwhats.md`);
- o registro do opt-out passaria a ter origem `botao`, que o sistema já aceita.

**Recomendação:** submeter as duas coisas juntas — a variável 4 **e** o botão. A variável
funciona sozinha e imediatamente; o botão passa a funcionar quando a Central Whats entregar
o webhook de entrada. Depender só do botão significa aprovar um template cujo mecanismo de
opt-out não funciona até um terceiro entregar uma integração.

---

## Passo a passo depois da aprovação

1. Aprovar o texto acima (Rafael).
2. Submeter na Meta, pelo painel da Central Whats.
3. Aguardar a aprovação.
4. No painel: **Campanha por WhatsApp → Sincronizar templates**. O template novo entra
   sozinho em `templates_whatsapp` (a convenção de nome `_vm` já o reconhece como nosso).
5. Ajustar o mapa de variáveis do template novo para incluir
   `{ "posicao": 4, "campo": "link_descadastro" }`.
6. Criar a campanha nova apontando para o template novo.
7. **Só então**, em **Configurações → WhatsApp → Opt-out**, marcar
   **"Link nas mensagens"**. Antes disso o interruptor não tem efeito útil.
8. Desativar o template antigo (`ativo = 0`) para ninguém criar campanha nova com ele.

O interruptor `optout_link_campanha_ativo` nasce **desligado** exatamente para que os passos
1–6 possam acontecer sem pressa, com o código já no ar.
