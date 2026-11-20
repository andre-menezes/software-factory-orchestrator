---
description: PERGUNTAR, responde a uma dúvida do cliente sem mudar o estado
argument-hint: <pergunta>
---

O cliente perguntou: `$ARGUMENTS`

1. Responda com base nos artefatos do repositório de destino. Se a pergunta for de alçada técnica de um especialista, consulte o agente responsável.
2. Registre: `./bin/factory ask "<pergunta>" --answer "<resposta resumida>"`.
3. Lembre que o gate continua aberto e repita as opções: APROVADO | AJUSTAR: <detalhes> | PERGUNTAR.
