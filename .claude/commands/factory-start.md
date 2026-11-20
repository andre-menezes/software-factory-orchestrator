---
description: Inicia um novo projeto de cliente e conduz a triagem
argument-hint: <slug> <problema de negócio>
---

O cliente quer iniciar um projeto. Argumentos: `$ARGUMENTS`

1. A primeira palavra é o slug do projeto; o restante é o problema de negócio. Se faltar o slug ou o problema, pergunte antes de seguir.
2. Rode `./bin/factory init <slug> --problem "<problema>"`. O destino padrão é `../cliente-<slug>`; se o cliente pediu outro caminho, use `--target <caminho>` antes de `init`.
3. Confirme ao cliente onde o repositório foi criado.
4. Siga o ciclo de `CLAUDE.md` a partir de `./bin/factory next`, até o primeiro gate ou até as primeiras perguntas do Solutions Consultant.
