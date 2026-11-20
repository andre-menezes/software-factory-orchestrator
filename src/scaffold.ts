import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { parse } from 'yaml';
import * as git from './git.js';
import { FactoryError, now, record, saveState } from './state.js';
import type { ProjectState } from './state.js';
import { initialCurrent } from './transitions.js';
import { ROOT } from './workflow.js';
import type { StepDef, Workflow } from './workflow.js';

/** Marker a template carries until the owning step fills its part in. */
export const pendingMarker = (stepId: string) => `<!-- factory:pending:${stepId} -->`;

function render(template: string, vars: Record<string, string>): string {
  return template.replace(/\{\{(\w+)\}\}/g, (whole, key: string) => vars[key] ?? whole);
}

function templateVars(state: ProjectState): Record<string, string> {
  return {
    PROJECT_NAME: state.project.name,
    PROJECT_SLUG: state.project.slug,
    PROBLEM: state.project.problem,
    DATE: now().slice(0, 10),
  };
}

function writeFromTemplate(templatePath: string, dest: string, state: ProjectState): void {
  mkdirSync(dirname(dest), { recursive: true });
  writeFileSync(dest, render(readFileSync(join(ROOT, 'templates', templatePath), 'utf8'), templateVars(state)));
}

/** Creates the step's artifact from its template the first time the step starts. */
export function ensureArtifact(target: string, step: StepDef, state: ProjectState): boolean {
  const dest = join(target, step.output);
  if (existsSync(dest)) return false;
  writeFromTemplate(join('artifacts', step.template), dest, state);
  return true;
}

/** Why the artifact is not ready for a gate, or null when it is. */
export function artifactProblem(target: string, step: StepDef): string | null {
  const file = join(target, step.output);
  if (!existsSync(file)) return `O artefato ${step.output} não existe no repositório de destino.`;
  if (readFileSync(file, 'utf8').includes(pendingMarker(step.id))) {
    return `O artefato ${step.output} ainda contém o marcador ${pendingMarker(step.id)}. O agente deve preencher o conteúdo e remover o marcador.`;
  }
  return null;
}

export function loadDefaults(): Record<string, unknown> {
  return parse(readFileSync(join(ROOT, 'config', 'defaults.yaml'), 'utf8')) as Record<string, unknown>;
}

/** Creates the target repository: folders, base docs, state file and first commit. */
export function scaffoldProject(
  wf: Workflow,
  opts: { target: string; name: string; slug: string; problem: string },
): ProjectState {
  const { target } = opts;
  if (existsSync(target) && readdirSync(target).some((f) => f !== '.git')) {
    throw new FactoryError(`${target} já existe e não está vazio. Escolha outro destino ou use "./bin/factory use ${target}".`);
  }
  const defaults = loadDefaults();
  const mainBranch = (defaults.git as { mainBranch?: string } | undefined)?.mainBranch ?? 'main';
  const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as { version: string };

  const state: ProjectState = {
    schemaVersion: 1,
    project: { name: opts.name, slug: opts.slug, problem: opts.problem, createdAt: now(), orchestratorVersion: pkg.version },
    defaults,
    git: { mainBranch },
    current: { phase: wf.phases[0]!.id, kind: 'step', ref: null, status: 'PENDENTE' },
    steps: {},
    stories: [],
    syncs: [],
    decisions: [],
    risks: [],
    pendencies: [],
    questions: [],
    history: [],
  };
  state.current = initialCurrent(state, wf);
  record(state, 'PROJETO_CRIADO', null, opts.problem);

  mkdirSync(join(target, 'docs', 'adr'), { recursive: true });
  writeFromTemplate('README.md', join(target, 'README.md'), state);
  writeFromTemplate('INDEX.md', join(target, 'docs', 'INDEX.md'), state);
  writeFromTemplate('adr-README.md', join(target, 'docs', 'adr', 'README.md'), state);
  writeFileSync(join(target, '.gitignore'), 'node_modules/\n.env\n.env.*\n!.env.example\n__pycache__/\n.venv/\n.next/\ndist/\n');
  saveState(target, state);

  if (!git.isRepo(target)) git.init(target, mainBranch);
  git.requireIdentity(target);
  git.commitAll(target, 'chore: scaffold project from software-factory-orchestrator');
  return state;
}
