import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';
import { z } from 'zod';
import { FactoryError } from './state.js';

/** Absolute path of the orchestrator repository. */
export const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

const SyncSchema = z.object({
  agent: z.string().default('technical-writer'),
  milestone: z.string(),
  scope: z.array(z.string()).min(1),
});

const StepSchema = z.object({
  id: z.string().regex(/^S\d{2}$/),
  name: z.string(),
  agent: z.string(),
  reads: z.array(z.string()).default([]),
  output: z.string(),
  template: z.string(),
  commitType: z.enum(['docs', 'chore', 'feat']).default('docs'),
  requiresStories: z.boolean().default(false),
});

const StageSchema = z.object({
  id: z.string(),
  name: z.string(),
  agent: z.string(),
  recheckOnAdjust: z.boolean().default(false),
});

const StepsPhaseSchema = z.object({
  id: z.string(),
  type: z.literal('steps'),
  name: z.string(),
  steps: z.array(StepSchema).min(1),
  sync: SyncSchema.optional(),
});

const StoryLoopPhaseSchema = z.object({
  id: z.string(),
  type: z.literal('story_loop'),
  name: z.string(),
  reads: z.array(z.string()).default([]),
  stages: z.array(StageSchema).min(1),
  sync: SyncSchema.optional(),
});

const WorkflowSchema = z.object({
  version: z.literal(1),
  phases: z.array(z.discriminatedUnion('type', [StepsPhaseSchema, StoryLoopPhaseSchema])).min(1),
});

export type Workflow = z.infer<typeof WorkflowSchema>;
export type Phase = Workflow['phases'][number];
export type StepsPhase = z.infer<typeof StepsPhaseSchema>;
export type StoryLoopPhase = z.infer<typeof StoryLoopPhaseSchema>;
export type StepDef = z.infer<typeof StepSchema>;
export type StageDef = z.infer<typeof StageSchema>;
export type SyncDef = z.infer<typeof SyncSchema>;

export function parseWorkflow(source: string): Workflow {
  const result = WorkflowSchema.safeParse(parse(source));
  if (!result.success) {
    throw new FactoryError(`workflow.yaml inválido:\n${z.prettifyError(result.error)}`);
  }
  return result.data;
}

export function loadWorkflow(root = ROOT): Workflow {
  return parseWorkflow(readFileSync(join(root, 'workflow.yaml'), 'utf8'));
}

/** Path of the agent definition file for an agent name, or null when missing. */
export function agentFile(agent: string, root = ROOT): string | null {
  const dir = join(root, '.claude', 'agents');
  for (let n = 1; n <= 99; n++) {
    const file = join(dir, `${String(n).padStart(2, '0')}-${agent}.md`);
    if (existsSync(file)) return file;
  }
  return null;
}

/**
 * Semantic checks beyond the schema: unique ids, agents and templates exist,
 * and every step only reads artifacts produced by an earlier step.
 */
export function validateWorkflow(wf: Workflow, root = ROOT): string[] {
  const problems: string[] = [];
  const seenIds = new Set<string>();
  const produced = new Set<string>();
  let storyLoops = 0;
  let stepsRequiringStories = 0;

  const checkAgent = (agent: string, where: string) => {
    if (!agentFile(agent, root)) problems.push(`${where}: agente "${agent}" não existe em .claude/agents/`);
  };
  const checkReads = (reads: string[], where: string) => {
    for (const r of reads) {
      if (!produced.has(r)) problems.push(`${where}: lê "${r}", que nenhuma etapa anterior produz`);
    }
  };

  for (const phase of wf.phases) {
    if (seenIds.has(phase.id)) problems.push(`id de fase duplicado: ${phase.id}`);
    seenIds.add(phase.id);

    if (phase.type === 'steps') {
      for (const step of phase.steps) {
        if (seenIds.has(step.id)) problems.push(`id de etapa duplicado: ${step.id}`);
        seenIds.add(step.id);
        checkAgent(step.agent, step.id);
        checkReads(step.reads, step.id);
        if (!existsSync(join(root, 'templates', 'artifacts', step.template))) {
          problems.push(`${step.id}: template "${step.template}" não existe em templates/artifacts/`);
        }
        if (step.requiresStories) {
          stepsRequiringStories++;
          if (storyLoops > 0) problems.push(`${step.id}: requiresStories precisa vir antes da fase story_loop`);
        }
        produced.add(step.output);
      }
    } else {
      storyLoops++;
      checkReads(phase.reads, phase.id);
      for (const stage of phase.stages) checkAgent(stage.agent, `${phase.id}/${stage.id}`);
      if (stepsRequiringStories === 0) {
        problems.push(`${phase.id}: nenhuma etapa anterior tem requiresStories, o backlog chegaria vazio`);
      }
    }
    if (phase.sync) checkAgent(phase.sync.agent, `${phase.id}/sync`);
  }

  if (storyLoops > 1) problems.push('apenas uma fase story_loop é suportada');
  return problems;
}
