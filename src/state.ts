import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';

export const STATE_FILE = 'PROJECT_STATE.json';

/** Expected, user-facing failure (invalid transition, missing artifact...). */
export class FactoryError extends Error {}

export const now = () => new Date().toISOString();

const UnitStatus = z.enum(['PENDENTE', 'EM_ANDAMENTO', 'AGUARDANDO_APROVACAO', 'APROVADO']);
export type UnitStatus = z.infer<typeof UnitStatus>;

const Adjustment = z.object({ at: z.string(), revision: z.number(), details: z.string() });

const StepRecord = z.object({
  status: UnitStatus,
  revision: z.number(),
  summary: z.string().nullable(),
  startedAt: z.string().nullable(),
  submittedAt: z.string().nullable(),
  approvedAt: z.string().nullable(),
  adjustments: z.array(Adjustment),
});
export type StepRecord = z.infer<typeof StepRecord>;

const StageRecord = z.object({
  status: z.enum(['PENDENTE', 'CONCLUIDO', 'PULADO']),
  summary: z.string().nullable(),
  tests: z.string().nullable(),
  at: z.string().nullable(),
});
export type StageRecord = z.infer<typeof StageRecord>;

const Story = z.object({
  id: z.string().regex(/^US-\d{3}$/),
  title: z.string(),
  priority: z.number(),
  scopeChange: z.boolean(),
  status: UnitStatus,
  branch: z.string().nullable(),
  revision: z.number(),
  summary: z.string().nullable(),
  stages: z.record(z.string(), StageRecord),
  startedAt: z.string().nullable(),
  submittedAt: z.string().nullable(),
  approvedAt: z.string().nullable(),
  adjustments: z.array(Adjustment),
});
export type Story = z.infer<typeof Story>;

const Current = z.object({
  phase: z.string(),
  kind: z.enum(['step', 'story', 'sync', 'done']),
  /** Step id, story id, or (for a sync) the phase or story it follows. */
  ref: z.string().nullable(),
  status: z.enum(['PENDENTE', 'EM_ANDAMENTO', 'AGUARDANDO_APROVACAO', 'CONCLUIDO']),
});
export type Current = z.infer<typeof Current>;

const Register = z.object({
  id: z.string(),
  text: z.string(),
  ref: z.string().nullable(),
  status: z.enum(['ABERTO', 'RESOLVIDO']),
  at: z.string(),
  resolvedAt: z.string().nullable(),
  note: z.string().nullable(),
});
export type Register = z.infer<typeof Register>;

const Decision = z.object({
  id: z.string(),
  text: z.string(),
  ref: z.string().nullable(),
  at: z.string(),
  /** Path of the ADR that documents it, once the Technical Writer writes one. */
  adr: z.string().nullable(),
});

const Question = z.object({
  id: z.string(),
  question: z.string(),
  answer: z.string().nullable(),
  ref: z.string().nullable(),
  at: z.string(),
});

const StateSchema = z.object({
  schemaVersion: z.literal(1),
  project: z.object({
    name: z.string(),
    slug: z.string(),
    problem: z.string(),
    createdAt: z.string(),
    orchestratorVersion: z.string(),
  }),
  defaults: z.record(z.string(), z.unknown()),
  git: z.object({ mainBranch: z.string() }),
  current: Current,
  steps: z.record(z.string(), StepRecord),
  stories: z.array(Story),
  syncs: z.array(
    z.object({ ref: z.string(), milestone: z.string(), summary: z.string(), at: z.string() }),
  ),
  decisions: z.array(Decision),
  risks: z.array(Register),
  pendencies: z.array(Register),
  questions: z.array(Question),
  history: z.array(
    z.object({ at: z.string(), event: z.string(), ref: z.string().nullable(), detail: z.string().nullable() }),
  ),
});
export type ProjectState = z.infer<typeof StateSchema>;

export function loadState(target: string): ProjectState {
  const file = join(target, STATE_FILE);
  if (!existsSync(file)) {
    throw new FactoryError(`${STATE_FILE} não encontrado em ${target}. Rode "./bin/factory init" primeiro.`);
  }
  const result = StateSchema.safeParse(JSON.parse(readFileSync(file, 'utf8')));
  if (!result.success) {
    throw new FactoryError(`${STATE_FILE} inválido (foi editado à mão?):\n${z.prettifyError(result.error)}`);
  }
  return result.data;
}

export function saveState(target: string, state: ProjectState): void {
  writeFileSync(join(target, STATE_FILE), `${JSON.stringify(StateSchema.parse(state), null, 2)}\n`);
}

export function record(state: ProjectState, event: string, ref: string | null, detail: string | null = null): void {
  state.history.push({ at: now(), event, ref, detail });
}

/** Next sequential id such as D-001, R-004, Q-012. */
export function nextId(prefix: string, existing: { id: string }[]): string {
  const max = existing.reduce((m, e) => Math.max(m, Number(e.id.split('-')[1]) || 0), 0);
  return `${prefix}-${String(max + 1).padStart(3, '0')}`;
}
