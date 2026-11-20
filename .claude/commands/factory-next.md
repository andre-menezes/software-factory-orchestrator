---
description: Executa a unidade de trabalho atual até o próximo gate
---

Execute o ciclo descrito em `CLAUDE.md`, a partir de `./bin/factory next`.

- Pare e espere o cliente quando houver perguntas de um agente ou um gate aberto.
- Etapas e estágios de story fechados sem gate (estágios intermediários, sincronizações) podem ser encadeados: continue até chegar a um gate ou a perguntas.
- Nunca chame `approve` sem um `APROVADO` explícito do cliente.

$ARGUMENTS
