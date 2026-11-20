/**
 * Builds the briefing the orchestrator hands, verbatim, to the agent that owns
 * the current unit of work. It is the only context an agent should need.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ProjectState } from './state.js';
import { currentPhase, currentStep, currentStory, currentSync, nextStage } from './transitions.js';
import { ROOT, agentFile } from './workflow.js';
import type { StoryLoopPhase, Workflow } from './workflow.js';

const list = (items: string[], empty = '(nenhum)') => (items.length ? items.map((i) => `  - ${i}`).join('\n') : `  ${empty}`);

function protocol(): string {
  return readFileSync(join(ROOT, 'templates', 'agent-protocol.md'), 'utf8').trim();
}

function openRegisters(state: ProjectState): string {
  const risks = state.risks.filter((r) => r.status === 'ABERTO').map((r) => `${r.id} (risco): ${r.text}`);
  const pend = state.pendencies.filter((p) => p.status === 'ABERTO').map((p) => `${p.id} (pendência): ${p.text}`);
  return list([...risks, ...pend]);
}

function header(state: ProjectState, target: string): string {
  return [
    `Projeto: ${state.project.name}`,
    `Problema informado pelo cliente: ${state.project.problem}`,
    `Repositório de destino (escreva SOMENTE aqui): ${target}`,
    `Repositório do orquestrador (somente leitura): ${ROOT}`,
    `Padrões do projeto: ${JSON.stringify(state.defaults)}`,
  ].join('\n');
}

export function gateMessage(state: ProjectState): string {
  const cur = state.current;
  const summary =
    cur.kind === 'step' ? state.steps[cur.ref!]?.summary : state.stories.find((s) => s.id === cur.ref)?.summary;
  return [
    `GATE ABERTO: ${cur.ref} está AGUARDANDO_APROVACAO.`,
    `Resumo submetido: ${summary ?? '(sem resumo)'}`,
    '',
    'Apresente o resumo executivo ao cliente e aguarde um dos comandos:',
    '  APROVADO            -> ./bin/factory approve',
    '  AJUSTAR: <detalhes> -> ./bin/factory adjust "<detalhes>"',
    '  PERGUNTAR           -> responda, registre com ./bin/factory ask, e continue aguardando',
    'Não avance sem um comando explícito do cliente.',
  ].join('\n');
}

export function buildBriefing(state: ProjectState, wf: Workflow, target: string): string {
  const cur = state.current;
  if (cur.kind === 'done') return 'PROJETO CONCLUÍDO. Todas as fases foram aprovadas e a documentação final está sincronizada.';
  if (cur.status === 'AGUARDANDO_APROVACAO') return gateMessage(state);

  const phase = currentPhase(state, wf);
  const lines: string[] = [];

  if (cur.kind === 'step') {
    const step = currentStep(state, wf);
    const rec = state.steps[step.id]!;
    lines.push(
      `=== ETAPA ${step.id}: ${step.name} (fase ${phase.id} ${phase.name}) ===`,
      `Agente responsável: ${step.agent}  [${agentFile(step.agent) ?? 'arquivo não encontrado'}]`,
      `Revisão: ${rec.revision}`,
      header(state, target),
      '',
      'Artefatos que você PODE ler (e nenhum outro documento de etapa):',
      list(step.reads.map((r) => join(target, r)), '(nenhum: esta é a primeira etapa)'),
      '',
      `Artefato que você DEVE produzir: ${join(target, step.output)}`,
      `  O arquivo já existe, criado a partir do template. Preencha a sua parte e remova o marcador <!-- factory:pending:${step.id} -->.`,
    );
    if (rec.adjustments.length) {
      lines.push('', 'AJUSTES PEDIDOS PELO CLIENTE (atenda a todos, do mais recente ao mais antigo):', list(rec.adjustments.map((a) => `rev ${a.revision}: ${a.details}`).reverse()));
    }
    if (step.requiresStories) {
      lines.push('', 'Esta etapa exige que cada User Story seja devolvida na seção STORIES do retorno, para o orquestrador registrá-las com "./bin/factory story add".');
    }
    lines.push('', 'Riscos e pendências em aberto no projeto:', openRegisters(state));
    lines.push('', `Quando o agente terminar, o orquestrador roda: ./bin/factory submit --summary "<resumo executivo>"`);
  } else if (cur.kind === 'story') {
    const story = currentStory(state);
    const loop = phase as StoryLoopPhase;
    const stage = nextStage(state, wf);
    lines.push(
      `=== USER STORY ${story.id}: ${story.title} (fase ${phase.id} ${phase.name}) ===`,
      `Branch de trabalho: ${story.branch} (já criada; não troque de branch)`,
      `Revisão: ${story.revision}${story.scopeChange ? '  [MUDANÇA DE ESCOPO aprovada pelo cliente]' : ''}`,
      header(state, target),
      '',
      'Estágios da fatia:',
      list(loop.stages.map((s) => `${s.id} (${s.agent}): ${story.stages[s.id]?.status ?? 'PENDENTE'}${story.stages[s.id]?.summary ? ` | ${story.stages[s.id]!.summary}` : ''}`)),
      '',
      'Artefatos de referência (leia apenas as seções ligadas a esta story):',
      list(loop.reads.map((r) => join(target, r))),
    );
    if (story.adjustments.length) {
      lines.push('', 'AJUSTES PEDIDOS PELO CLIENTE:', list(story.adjustments.map((a) => `rev ${a.revision}: ${a.details}`).reverse()));
    }
    if (stage) {
      lines.push(
        '',
        `PRÓXIMO ESTÁGIO: ${stage.id} (${stage.name})`,
        `Agente responsável: ${stage.agent}  [${agentFile(stage.agent) ?? 'arquivo não encontrado'}]`,
        `Ao terminar, o orquestrador roda: ./bin/factory story stage-done ${stage.id} --summary "<o que mudou>" --tests "<comando e resultado>"`,
        `Se o estágio não se aplica a esta story: ./bin/factory story stage-done ${stage.id} --skip --summary "<motivo>"`,
      );
    } else {
      lines.push('', 'Todos os estágios concluídos. O orquestrador roda: ./bin/factory submit --summary "<resumo executivo da story>"');
    }
  } else {
    const sync = currentSync(state, wf);
    const story = state.stories.find((s) => s.id === cur.ref);
    lines.push(
      `=== SINCRONIZAÇÃO DE DOCUMENTAÇÃO: marco "${sync.milestone}"${story ? ` (${story.id}: ${story.title})` : ''} ===`,
      `Agente responsável: ${sync.agent}  [${agentFile(sync.agent) ?? 'arquivo não encontrado'}]`,
      header(state, target),
      '',
      'Escopo desta passada:',
      list(sync.scope),
      '',
      `Templates disponíveis: ${join(ROOT, 'templates')} (adr.md, INDEX.md, README.md, docs-extra/)`,
      'Decisões registradas ainda sem ADR:',
      list(state.decisions.filter((d) => !d.adr).map((d) => `${d.id}${d.ref ? ` [${d.ref}]` : ''}: ${d.text}`)),
      '',
      'Esta passada não tem gate. Ao terminar, o orquestrador roda: ./bin/factory sync-done --summary "<o que foi atualizado>"',
    );
  }

  lines.push('', '--- PROTOCOLO DO AGENTE ---', protocol());
  return lines.join('\n');
}

export function buildStatus(state: ProjectState, wf: Workflow, target: string): string {
  const cur = state.current;
  const lines = [
    `Projeto: ${state.project.name}  (${target})`,
    `Posição: fase ${cur.phase} | ${cur.kind}${cur.ref ? ` ${cur.ref}` : ''} | ${cur.status}`,
    '',
  ];
  for (const phase of wf.phases) {
    lines.push(`${phase.id} ${phase.name}`);
    if (phase.type === 'steps') {
      for (const step of phase.steps) {
        const rec = state.steps[step.id];
        lines.push(`  ${step.id} ${step.name.padEnd(44)} ${rec?.status ?? 'PENDENTE'}${rec && rec.revision > 1 ? ` (rev ${rec.revision})` : ''}`);
      }
    } else if (state.stories.length === 0) {
      lines.push('  (backlog ainda não definido)');
    } else {
      for (const s of [...state.stories].sort((a, b) => a.priority - b.priority)) {
        const stages = phase.stages.map((st) => `${st.id}:${(s.stages[st.id]?.status ?? 'PENDENTE').slice(0, 4)}`).join(' ');
        lines.push(`  ${s.id} ${s.title.slice(0, 40).padEnd(40)} ${s.status.padEnd(20)} ${stages}${s.scopeChange ? ' [escopo]' : ''}`);
      }
    }
    if (phase.sync) {
      const done = state.syncs.filter((y) => y.milestone === phase.sync!.milestone).length;
      lines.push(`  sync Technical Writer (${phase.sync.milestone}): ${done} realizada(s)`);
    }
  }
  const open = (arr: { status: string }[]) => arr.filter((r) => r.status === 'ABERTO').length;
  lines.push(
    '',
    `Decisões: ${state.decisions.length} (${state.decisions.filter((d) => !d.adr).length} sem ADR) | Riscos abertos: ${open(state.risks)} | Pendências abertas: ${open(state.pendencies)} | Perguntas registradas: ${state.questions.length}`,
  );
  return lines.join('\n');
}
