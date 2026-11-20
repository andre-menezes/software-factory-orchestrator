---
description: APROVADO, fecha o gate atual e avança
argument-hint: [observação opcional]
---

O cliente respondeu **APROVADO**. Observação: `$ARGUMENTS`

1. Rode `./bin/factory status` e confirme que há um gate `AGUARDANDO_APROVACAO`. Se não houver, avise o cliente e pare.
2. Rode `./bin/factory approve` (com `--note "<observação>"` se houver).
3. Informe o commit gerado e qual é a próxima unidade.
4. Continue com o ciclo de `/factory-next`.
