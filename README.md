# software-factory-orchestrator

Orquestração multi-agente de engenharia de software. Você informa um problema de negócio; 14 agentes especializados conduzem o ciclo completo, da triagem ao deploy em produção, criando e evoluindo o produto em um **repositório separado**, com sua aprovação em cada ponto crítico.

```
software-factory-orchestrator/          ../cliente-<projeto>/
  (o cérebro: agentes, motor, regras)      (o produto: docs, código, estado)
  ┌───────────────────────────┐            ┌──────────────────────────────┐
  │ CLAUDE.md  workflow.yaml  │  escreve   │ docs/01..12  docs/adr/       │
  │ .claude/agents (14)       │ ─────────▶ │ docs/INDEX.md  README.md     │
  │ bin/factory (CLI)         │            │ PROJECT_STATE.json  src/ ... │
  └───────────────────────────┘            └──────────────────────────────┘
```

## Pré-requisitos

- [Claude Code](https://code.claude.com)
- Node.js 20 ou superior
- git, com `user.name` e `user.email` configurados

## Instalação

```bash
git clone https://github.com/andre-menezes/software-factory-orchestrator.git
cd software-factory-orchestrator
npm install
./bin/factory validate
```

## Iniciar um projeto

Dentro da pasta do orquestrador, abra o Claude Code e use o comando:

```
/factory-start <slug> <o problema de negócio, nas suas palavras>
```

O repositório do produto é criado em `../cliente-<slug>`. A partir daí o orquestrador conduz cada etapa e para em cada gate. Você responde:

| Resposta | Efeito |
|---|---|
| `APROVADO` | Fecha o gate, faz o commit no repositório do produto e avança |
| `AJUSTAR: <detalhes>` | Devolve a etapa ao agente com o pedido, como nova revisão |
| `PERGUNTAR` | Tira dúvidas sem mudar o estado; o gate continua aberto |

Outros comandos: `/factory-next`, `/factory-status`, `/factory-approve`, `/factory-adjust`, `/factory-ask`.

## O fluxo

| Fase | Etapas (gate em cada uma) | Ao final |
|---|---|---|
| F1 Descoberta | S01 Triagem, S02 Visão e MVP, S03 Métricas, S04 Requisitos | Sync do Technical Writer |
| F2 Design e Arquitetura | S05 UX, S06 UI, S07 Arquitetura, S08 Segurança | Sync |
| F3 Planejamento | S09 Backlog, S10 Plano de testes, S11 Infra e CI | Sync |
| F4 Construção | Uma User Story por vez: backend, frontend, revisão de segurança, verificação de QA, **um gate por story** | Sync após cada story |
| F5 Release | S12 Segurança pré-deploy, S13 Homologação (UAT), S14 Deploy | Sync final |

Cada etapa segue `PENDENTE → EM_ANDAMENTO → AGUARDANDO_APROVACAO → APROVADO`; `AJUSTAR` volta para `EM_ANDAMENTO` com nova revisão.

## Os 14 agentes

| # | Agente | Atua em |
|---|---|---|
| 01 | Solutions Consultant | S01 |
| 02 | Product Manager | S02 |
| 03 | Analista de Dados | S03 |
| 04 | Analista de Requisitos | S04 |
| 05 | UX Designer | S05 |
| 06 | UI Designer | S06 |
| 07 | Tech Architect | S07 |
| 08 | Cybersecurity Engineer | S08, revisão de cada story, S12 |
| 09 | Product Owner | S09, mudanças de escopo |
| 10 | Desenvolvedor Backend | estágio backend de cada story |
| 11 | Desenvolvedor Frontend | estágio frontend de cada story |
| 12 | DevOps Engineer | S11, S14 |
| 13 | QA & Delivery Manager | S10, verificação de cada story, S13, classificação bug x escopo |
| 14 | Technical Writer | todas as sincronizações |

As definições estão em `.claude/agents/` (`agents/` aponta para lá).

## Garantias do motor

O CLI `./bin/factory` é a única autoridade sobre o `PROJECT_STATE.json` e recusa:

- aprovar o que não foi submetido, ou submeter sem resumo executivo;
- submeter um artefato ainda com o marcador de pendência do template;
- fechar o backlog sem stories registradas;
- fechar estágios de story fora de ordem ou sem evidência de testes;
- criar story depois do backlog aprovado sem marcá-la como mudança de escopo;
- operar com o repositório do produto na branch errada.

Git no repositório do produto: um commit por gate na `main`, uma branch `story/US-xxx-<slug>` por story com commit por estágio e merge `--no-ff` na aprovação. **Nada é enviado para remoto sem pedido seu.**

## Estrutura

```
CLAUDE.md                 protocolo do orquestrador
workflow.yaml             máquina de estados (fases, etapas, leituras permitidas)
config/defaults.yaml      stack, infraestrutura e idioma padrão
.claude/agents/           os 14 agentes
.claude/commands/         slash commands /factory-*
.claude/settings.json     permissões
src/                      CLI em TypeScript (estado, transições, git, briefings)
templates/                artefatos 01 a 12, ADR, INDEX, README, guias, protocolo dos agentes
tests/                    testes da máquina de estados
```

## Padrões da fábrica

Quando o cliente não especifica: Next.js no frontend; FastAPI, SQLAlchemy, Alembic e PostgreSQL no backend; Docker Compose, GitHub Actions e PaaS na infraestrutura. Documentação em português, código em inglês. Altere em `config/defaults.yaml`.

## Desenvolvimento

```bash
npm run typecheck
npm test
./bin/factory validate
```

Mudou o fluxo? Edite `workflow.yaml` e rode `./bin/factory validate`: ele confere que cada agente e template existe e que nenhuma etapa lê um artefato ainda não produzido.
