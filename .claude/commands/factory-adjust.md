---
description: AJUSTAR, devolve o gate atual ao agente com os ajustes pedidos
argument-hint: <detalhes do ajuste>
---

O cliente respondeu **AJUSTAR**: `$ARGUMENTS`

1. Se os detalhes estiverem vagos, pergunte o que exatamente deve mudar antes de seguir.
2. Na fase de construção, se o pedido parecer novo e não uma correção, consulte primeiro o QA & Delivery Manager para classificar como bug ou mudança de escopo (veja `CLAUDE.md`).
3. Rode `./bin/factory adjust "<detalhes>"`.
4. Continue com o ciclo de `/factory-next`: o briefing trará o ajuste para o agente.
