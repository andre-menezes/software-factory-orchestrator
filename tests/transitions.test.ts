import { describe, expect, it } from 'vitest';
import type { ProjectState } from '../src/state.js';
import * as t from '../src/transitions.js';
import { loadWorkflow, parseWorkflow, validateWorkflow } from '../src/workflow.js';

const wf = loadWorkflow();

function freshState(): ProjectState {
  const state: ProjectState = {
    schemaVersion: 1,
    project: { name: 'demo', slug: 'demo', problem: 'p', createdAt: '', orchestratorVersion: '0' },
    defaults: {},
    git: { mainBranch: 'main' },
    current: { phase: 'F1', kind: 'step', ref: null, status: 'PENDENTE' },
    steps: {}, stories: [], syncs: [], decisions: [], risks: [], pendencies: [], questions: [], history: [],
  };
  state.current = t.initialCurrent(state, wf);
  return state;
}

/** Runs the current step through its gate. */
function passStep(state: ProjectState) {
  t.begin(state, wf);
  t.submit(state, wf, `resumo ${state.current.ref}`);
  t.approve(state, wf);
}

function passSync(state: ProjectState) {
  expect(state.current.kind).toBe('sync');
  t.completeSync(state, wf, 'docs atualizadas');
}

/** Advances to the backlog step (S09) EM_ANDAMENTO. */
function toBacklog(state: ProjectState) {
  for (let i = 0; i < 4; i++) passStep(state);
  passSync(state);
  for (let i = 0; i < 4; i++) passStep(state);
  passSync(state);
  t.begin(state, wf);
  expect(state.current.ref).toBe('S09');
}

describe('workflow.yaml', () => {
  it('is valid', () => {
    expect(validateWorkflow(wf)).toEqual([]);
  });

  it('rejects a step that reads an artifact nobody produced earlier', () => {
    const broken = parseWorkflow(`
version: 1
phases:
  - id: F1
    type: steps
    name: x
    steps:
      - { id: S01, name: a, agent: solutions-consultant, reads: [docs/99.md], output: docs/01.md, template: 01-diagnostico.md }
`);
    expect(validateWorkflow(broken).join()).toMatch(/docs\/99\.md/);
  });
});

describe('gates', () => {
  it('starts at S01 PENDENTE', () => {
    expect(freshState().current).toMatchObject({ phase: 'F1', kind: 'step', ref: 'S01', status: 'PENDENTE' });
  });

  it('cannot approve without a submitted gate', () => {
    const s = freshState();
    expect(() => t.approve(s, wf)).toThrow(/AGUARDANDO_APROVACAO/);
    t.begin(s, wf);
    expect(() => t.approve(s, wf)).toThrow(/AGUARDANDO_APROVACAO/);
  });

  it('requires a summary to submit', () => {
    const s = freshState();
    t.begin(s, wf);
    expect(() => t.submit(s, wf, '  ')).toThrow(/resumo/);
  });

  it('adjust bumps the revision and reopens the step', () => {
    const s = freshState();
    t.begin(s, wf);
    t.submit(s, wf, 'r1');
    t.adjust(s, wf, 'mais detalhe');
    expect(s.current.status).toBe('EM_ANDAMENTO');
    expect(s.steps.S01).toMatchObject({ revision: 2, status: 'EM_ANDAMENTO' });
    expect(s.steps.S01!.adjustments[0]!.details).toBe('mais detalhe');
  });

  it('runs the Technical Writer sync after the last step of a phase', () => {
    const s = freshState();
    for (let i = 0; i < 4; i++) passStep(s);
    expect(s.current).toMatchObject({ phase: 'F1', kind: 'sync', ref: 'F1' });
    passSync(s);
    expect(s.current).toMatchObject({ phase: 'F2', kind: 'step', ref: 'S05' });
    expect(s.syncs[0]!.milestone).toBe('Descoberta');
  });

  it('sync cannot be submitted as a gate', () => {
    const s = freshState();
    for (let i = 0; i < 4; i++) passStep(s);
    expect(() => t.submit(s, wf, 'x')).toThrow(/sync-done/);
  });
});

describe('backlog and stories', () => {
  it('only accepts stories during the backlog step', () => {
    const s = freshState();
    expect(() => t.addStory(s, wf, { id: 'US-001', title: 'x' })).toThrow(/backlog/);
  });

  it('backlog step cannot be submitted without stories', () => {
    const s = freshState();
    toBacklog(s);
    expect(() => t.submit(s, wf, 'backlog')).toThrow(/story add/);
  });

  it('after the backlog is approved, a new story must be a scope change', () => {
    const s = freshState();
    toBacklog(s);
    t.addStory(s, wf, { id: 'US-001', title: 'Login' });
    t.submit(s, wf, 'backlog');
    t.approve(s, wf);
    expect(() => t.addStory(s, wf, { id: 'US-002', title: 'Extra' })).toThrow(/scope-change/);
    expect(t.addStory(s, wf, { id: 'US-002', title: 'Extra', scopeChange: true }).scopeChange).toBe(true);
  });
});

describe('story loop', () => {
  function toStories(titles: string[]) {
    const s = freshState();
    toBacklog(s);
    titles.forEach((title, i) => t.addStory(s, wf, { id: `US-00${i + 1}`, title }));
    t.submit(s, wf, 'backlog');
    t.approve(s, wf);
    passStep(s); // S10
    passStep(s); // S11
    passSync(s);
    return s;
  }

  function closeStages(s: ProjectState) {
    for (const id of ['backend', 'frontend', 'security', 'qa']) t.stageDone(s, wf, id, { summary: id, tests: 'pytest: 3 passed' });
  }

  it('enters the first story with a branch', () => {
    const s = toStories(['Cadastro de clientes']);
    expect(s.current).toMatchObject({ phase: 'F4', kind: 'story', ref: 'US-001' });
    t.begin(s, wf);
    expect(s.stories[0]!.branch).toBe('story/US-001-cadastro-de-clientes');
  });

  it('enforces stage order and test evidence', () => {
    const s = toStories(['A']);
    t.begin(s, wf);
    expect(() => t.stageDone(s, wf, 'frontend', { summary: 'x', tests: 'ok' })).toThrow(/fora de ordem/);
    expect(() => t.stageDone(s, wf, 'backend', { summary: 'x' })).toThrow(/--tests/);
    t.stageDone(s, wf, 'backend', { summary: 'x', tests: 'ok' });
    t.stageDone(s, wf, 'frontend', { summary: 'sem UI', skip: true });
    expect(s.stories[0]!.stages.frontend!.status).toBe('PULADO');
    expect(() => t.submit(s, wf, 'story')).toThrow(/security, qa/);
  });

  it('adjusting a story resets the review stages only', () => {
    const s = toStories(['A']);
    t.begin(s, wf);
    closeStages(s);
    t.submit(s, wf, 'pronto');
    t.adjust(s, wf, 'corrigir mensagem');
    const st = s.stories[0]!.stages;
    expect(st.backend!.status).toBe('CONCLUIDO');
    expect(st.security!.status).toBe('PENDENTE');
    expect(st.qa!.status).toBe('PENDENTE');
    expect(s.stories[0]!.revision).toBe(2);
  });

  it('syncs after each story, then moves to the next one, then to release', () => {
    const s = toStories(['A', 'B']);
    for (const id of ['US-001', 'US-002']) {
      expect(s.current.ref).toBe(id);
      t.begin(s, wf);
      closeStages(s);
      t.submit(s, wf, 'ok');
      t.approve(s, wf);
      expect(s.current).toMatchObject({ kind: 'sync', ref: id });
      passSync(s);
    }
    expect(s.current).toMatchObject({ phase: 'F5', kind: 'step', ref: 'S12' });
    passStep(s);
    passStep(s);
    passStep(s);
    passSync(s);
    expect(s.current).toMatchObject({ kind: 'done', status: 'CONCLUIDO' });
    expect(() => t.addStory(s, wf, { id: 'US-009', title: 'x', scopeChange: true })).toThrow(/terminou/);
  });
});

describe('slugify', () => {
  it('handles accents and punctuation', () => {
    expect(t.slugify('Gestão de Pedidos & Estoque!')).toBe('gestao-de-pedidos-estoque');
  });
});
