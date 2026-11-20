/**
 * Pure state transitions. Nothing here touches the filesystem or git, so every
 * rule of the state machine can be unit-tested in isolation.
 */
import { FactoryError, now, record } from './state.js';
import type { Current, ProjectState, StepRecord, Story } from './state.js';
import type { Phase, StageDef, StepDef, StepsPhase, StoryLoopPhase, SyncDef, Workflow } from './workflow.js';

export const MAIN_UNIT_HINT = 'Rode "./bin/factory status" para ver onde o projeto está.';

function phaseIndex(wf: Workflow, id: string): number {
  const idx = wf.phases.findIndex((p) => p.id === id);
  if (idx < 0) throw new FactoryError(`Fase "${id}" do estado não existe no workflow.yaml.`);
  return idx;
}

export function currentPhase(state: ProjectState, wf: Workflow): Phase {
  return wf.phases[phaseIndex(wf, state.current.phase)]!;
}

export function storyLoop(wf: Workflow): StoryLoopPhase | undefined {
  return wf.phases.find((p): p is StoryLoopPhase => p.type === 'story_loop');
}

export function currentStep(state: ProjectState, wf: Workflow): StepDef {
  const phase = currentPhase(state, wf);
  const step = phase.type === 'steps' ? phase.steps.find((s) => s.id === state.current.ref) : undefined;
  if (state.current.kind !== 'step' || !step) throw new FactoryError(`A unidade atual não é uma etapa. ${MAIN_UNIT_HINT}`);
  return step;
}

export function currentStory(state: ProjectState): Story {
  const story = state.stories.find((s) => s.id === state.current.ref);
  if (state.current.kind !== 'story' || !story) throw new FactoryError(`A unidade atual não é uma User Story. ${MAIN_UNIT_HINT}`);
  return story;
}

export function currentSync(state: ProjectState, wf: Workflow): SyncDef {
  const sync = currentPhase(state, wf).sync;
  if (state.current.kind !== 'sync' || !sync) throw new FactoryError(`Não há sincronização de documentação pendente. ${MAIN_UNIT_HINT}`);
  return sync;
}

function nextPendingStory(state: ProjectState): Story | undefined {
  return state.stories
    .filter((s) => s.status !== 'APROVADO')
    .sort((a, b) => a.priority - b.priority || a.id.localeCompare(b.id))[0];
}

/** First unit of the phase at `idx`, or the terminal state past the last phase. */
function enterPhase(state: ProjectState, wf: Workflow, idx: number): Current {
  const phase = wf.phases[idx];
  if (!phase) {
    return { phase: wf.phases[wf.phases.length - 1]!.id, kind: 'done', ref: null, status: 'CONCLUIDO' };
  }
  if (phase.type === 'steps') {
    return { phase: phase.id, kind: 'step', ref: phase.steps[0]!.id, status: 'PENDENTE' };
  }
  const story = nextPendingStory(state);
  return story
    ? { phase: phase.id, kind: 'story', ref: story.id, status: 'PENDENTE' }
    : enterPhase(state, wf, idx + 1);
}

export function initialCurrent(state: ProjectState, wf: Workflow): Current {
  return enterPhase(state, wf, 0);
}

function requireStatus(state: ProjectState, expected: Current['status'], action: string): void {
  if (state.current.kind === 'done') throw new FactoryError('O projeto já está concluído.');
  if (state.current.status !== expected) {
    throw new FactoryError(
      `Não é possível ${action}: a unidade ${state.current.ref} está ${state.current.status}, e precisa estar ${expected}.`,
    );
  }
}

/** PENDENTE -> EM_ANDAMENTO. Returns true when the unit was actually started now. */
export function begin(state: ProjectState, wf: Workflow): boolean {
  const cur = state.current;
  if (cur.kind === 'done' || cur.status !== 'PENDENTE') return false;
  cur.status = 'EM_ANDAMENTO';

  if (cur.kind === 'step') {
    const step = currentStep(state, wf);
    const fresh: StepRecord = {
      status: 'EM_ANDAMENTO', revision: 1, summary: null,
      startedAt: now(), submittedAt: null, approvedAt: null, adjustments: [],
    };
    state.steps[step.id] = fresh;
  } else if (cur.kind === 'story') {
    const story = currentStory(state);
    story.status = 'EM_ANDAMENTO';
    story.startedAt = now();
    story.branch = `story/${story.id}-${slugify(story.title)}`;
  }
  record(state, 'INICIADO', cur.ref);
  return true;
}

/** EM_ANDAMENTO -> AGUARDANDO_APROVACAO (opens the gate). */
export function submit(state: ProjectState, wf: Workflow, summary: string): void {
  if (state.current.kind === 'sync') throw new FactoryError('Sincronização não tem gate: use "./bin/factory sync-done".');
  requireStatus(state, 'EM_ANDAMENTO', 'submeter');
  if (!summary.trim()) throw new FactoryError('Informe o resumo executivo com --summary.');

  if (state.current.kind === 'step') {
    const step = currentStep(state, wf);
    if (step.requiresStories && state.stories.length === 0) {
      throw new FactoryError(`${step.id} exige stories registradas. Use "./bin/factory story add" para cada User Story do backlog.`);
    }
    const rec = state.steps[step.id]!;
    Object.assign(rec, { status: 'AGUARDANDO_APROVACAO', summary, submittedAt: now() });
  } else {
    const story = currentStory(state);
    const open = Object.entries(story.stages).filter(([, s]) => s.status === 'PENDENTE').map(([id]) => id);
    if (open.length > 0) {
      throw new FactoryError(`${story.id} ainda tem estágios pendentes: ${open.join(', ')}.`);
    }
    Object.assign(story, { status: 'AGUARDANDO_APROVACAO', summary, submittedAt: now() });
  }
  state.current.status = 'AGUARDANDO_APROVACAO';
  record(state, 'SUBMETIDO', state.current.ref, summary);
}

/** AGUARDANDO_APROVACAO -> APROVADO, then moves `current` to the next unit. */
export function approve(state: ProjectState, wf: Workflow, note: string | null = null): void {
  requireStatus(state, 'AGUARDANDO_APROVACAO', 'aprovar');
  const idx = phaseIndex(wf, state.current.phase);
  const phase = wf.phases[idx]!;
  const ref = state.current.ref!;
  record(state, 'APROVADO', ref, note);

  if (state.current.kind === 'step') {
    Object.assign(state.steps[ref]!, { status: 'APROVADO', approvedAt: now() });
    const steps = (phase as StepsPhase).steps;
    const next = steps[steps.findIndex((s) => s.id === ref) + 1];
    if (next) state.current = { phase: phase.id, kind: 'step', ref: next.id, status: 'PENDENTE' };
    else if (phase.sync) state.current = { phase: phase.id, kind: 'sync', ref: phase.id, status: 'PENDENTE' };
    else state.current = enterPhase(state, wf, idx + 1);
  } else {
    Object.assign(currentStory(state), { status: 'APROVADO', approvedAt: now() });
    // The sync that follows a story is tagged with the story id, not the phase id.
    state.current = phase.sync
      ? { phase: phase.id, kind: 'sync', ref, status: 'PENDENTE' }
      : enterPhase(state, wf, idx);
  }
}

/** AGUARDANDO_APROVACAO -> EM_ANDAMENTO with a new revision. */
export function adjust(state: ProjectState, wf: Workflow, details: string): void {
  requireStatus(state, 'AGUARDANDO_APROVACAO', 'ajustar');
  if (!details.trim()) throw new FactoryError('Descreva o ajuste pedido.');

  if (state.current.kind === 'step') {
    const rec = state.steps[currentStep(state, wf).id]!;
    rec.status = 'EM_ANDAMENTO';
    rec.revision += 1;
    rec.adjustments.push({ at: now(), revision: rec.revision, details });
  } else {
    const story = currentStory(state);
    story.status = 'EM_ANDAMENTO';
    story.revision += 1;
    story.adjustments.push({ at: now(), revision: story.revision, details });
    // Code is about to change, so reviews of the previous revision no longer hold.
    for (const stage of (currentPhase(state, wf) as StoryLoopPhase).stages) {
      if (stage.recheckOnAdjust) story.stages[stage.id] = { status: 'PENDENTE', summary: null, tests: null, at: null };
    }
  }
  state.current.status = 'EM_ANDAMENTO';
  record(state, 'AJUSTE_SOLICITADO', state.current.ref, details);
}

/** Completes the Technical Writer pass and moves on. */
export function completeSync(state: ProjectState, wf: Workflow, summary: string): void {
  const sync = currentSync(state, wf);
  if (!summary.trim()) throw new FactoryError('Informe o que foi atualizado com --summary.');
  const idx = phaseIndex(wf, state.current.phase);
  const ref = state.current.ref!;
  state.syncs.push({ ref, milestone: sync.milestone, summary, at: now() });
  record(state, 'DOCUMENTACAO_SINCRONIZADA', ref, summary);
  // After a story sync we stay in the loop (next story); otherwise next phase.
  state.current = enterPhase(state, wf, wf.phases[idx]!.type === 'story_loop' ? idx : idx + 1);
}

export function nextStage(state: ProjectState, wf: Workflow): StageDef | undefined {
  const story = currentStory(state);
  return (currentPhase(state, wf) as StoryLoopPhase).stages.find((s) => story.stages[s.id]?.status === 'PENDENTE');
}

/** Marks one stage of the current story as done (or skipped), strictly in order. */
export function stageDone(
  state: ProjectState,
  wf: Workflow,
  stageId: string,
  opts: { summary: string; tests?: string | null; skip?: boolean },
): void {
  requireStatus(state, 'EM_ANDAMENTO', 'concluir um estágio');
  const story = currentStory(state);
  const expected = nextStage(state, wf);
  if (!expected) throw new FactoryError(`Todos os estágios de ${story.id} já foram concluídos. Use "./bin/factory submit".`);
  if (expected.id !== stageId) {
    throw new FactoryError(`Estágio fora de ordem: o próximo de ${story.id} é "${expected.id}", não "${stageId}".`);
  }
  if (!opts.summary.trim()) throw new FactoryError('Informe --summary (o que foi feito, ou por que foi pulado).');
  if (!opts.skip && !opts.tests?.trim()) {
    throw new FactoryError('Informe --tests com o comando executado e o resultado. Sem evidência de validação o estágio não fecha.');
  }
  story.stages[stageId] = {
    status: opts.skip ? 'PULADO' : 'CONCLUIDO',
    summary: opts.summary,
    tests: opts.tests ?? null,
    at: now(),
  };
  record(state, opts.skip ? 'ESTAGIO_PULADO' : 'ESTAGIO_CONCLUIDO', `${story.id}/${stageId}`, opts.summary);
}

export function addStory(
  state: ProjectState,
  wf: Workflow,
  input: { id: string; title: string; priority?: number; scopeChange?: boolean },
): Story {
  const loop = storyLoop(wf);
  if (!loop) throw new FactoryError('O workflow não tem fase de construção (story_loop).');
  if (!/^US-\d{3}$/.test(input.id)) throw new FactoryError('O id da story deve ter o formato US-001.');
  if (state.stories.some((s) => s.id === input.id)) throw new FactoryError(`A story ${input.id} já existe.`);

  const cur = state.current;
  const curIdx = phaseIndex(wf, cur.phase);
  const loopIdx = phaseIndex(wf, loop.id);
  const inBacklogStep = isBacklogStepOpen(state, wf);
  const backlogApproved = backlogStepIds(wf).some((id) => state.steps[id]?.status === 'APROVADO');

  if (cur.kind === 'done' || curIdx > loopIdx) {
    throw new FactoryError('A fase de construção já terminou. Registre a demanda como pendência para um próximo ciclo.');
  }
  if (!inBacklogStep && !backlogApproved) {
    throw new FactoryError('Stories só podem ser registradas a partir da etapa de backlog (Product Owner).');
  }
  if (backlogApproved && !input.scopeChange) {
    throw new FactoryError('O backlog já foi aprovado. Uma story nova agora é mudança de escopo: confirme com o cliente e use --scope-change.');
  }

  const story: Story = {
    id: input.id,
    title: input.title,
    priority: input.priority ?? state.stories.length + 1,
    scopeChange: Boolean(input.scopeChange),
    status: 'PENDENTE',
    branch: null,
    revision: 1,
    summary: null,
    stages: Object.fromEntries(loop.stages.map((s) => [s.id, { status: 'PENDENTE' as const, summary: null, tests: null, at: null }])),
    startedAt: null,
    submittedAt: null,
    approvedAt: null,
    adjustments: [],
  };
  state.stories.push(story);
  record(state, story.scopeChange ? 'MUDANCA_DE_ESCOPO' : 'STORY_REGISTRADA', story.id, story.title);
  return story;
}

/** Removes a story. Only possible while the Product Owner is still shaping the backlog. */
export function removeStory(state: ProjectState, wf: Workflow, id: string): void {
  if (!isBacklogStepOpen(state, wf)) {
    throw new FactoryError('Stories só podem ser removidas enquanto a etapa de backlog está EM_ANDAMENTO.');
  }
  const idx = state.stories.findIndex((s) => s.id === id);
  if (idx < 0) throw new FactoryError(`A story ${id} não existe.`);
  state.stories.splice(idx, 1);
  record(state, 'STORY_REMOVIDA', id);
}

function backlogStepIds(wf: Workflow): string[] {
  return wf.phases.flatMap((p) => (p.type === 'steps' ? p.steps.filter((s) => s.requiresStories).map((s) => s.id) : []));
}

function isBacklogStepOpen(state: ProjectState, wf: Workflow): boolean {
  const cur = state.current;
  return cur.kind === 'step' && cur.status === 'EM_ANDAMENTO' && backlogStepIds(wf).includes(cur.ref ?? '');
}

export function slugify(text: string): string {
  return text
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
    .replace(/-+$/, '');
}
