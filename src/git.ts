/**
 * Thin git wrapper for the TARGET repository. The orchestrator never pushes:
 * publishing to a remote is always an explicit decision of the client.
 */
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { FactoryError } from './state.js';

function git(cwd: string, args: string[]): string {
  try {
    return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  } catch (err) {
    const e = err as { stderr?: string; stdout?: string; message: string };
    const detail = (e.stderr || e.stdout || e.message).trim();
    throw new FactoryError(`git ${args.join(' ')} falhou em ${cwd}:\n${detail}`);
  }
}

export const isRepo = (cwd: string) => existsSync(join(cwd, '.git'));

export function init(cwd: string, mainBranch: string): void {
  git(cwd, ['init', '-b', mainBranch]);
}

export function requireIdentity(cwd: string): void {
  for (const key of ['user.name', 'user.email']) {
    try {
      git(cwd, ['config', key]);
    } catch {
      throw new FactoryError(`git ${key} não está configurado. Rode: git config --global ${key} "<valor>"`);
    }
  }
}

export const currentBranch = (cwd: string) => git(cwd, ['rev-parse', '--abbrev-ref', 'HEAD']);

export function requireBranch(cwd: string, expected: string): void {
  const actual = currentBranch(cwd);
  if (actual !== expected) {
    throw new FactoryError(`O repositório de destino está na branch "${actual}", mas esta operação exige "${expected}".`);
  }
}

/** Stages everything and commits. Returns the short sha, or null if the tree was clean. */
export function commitAll(cwd: string, message: string): string | null {
  git(cwd, ['add', '-A']);
  if (!git(cwd, ['status', '--porcelain'])) return null;
  git(cwd, ['commit', '-m', message]);
  return git(cwd, ['rev-parse', '--short', 'HEAD']);
}

export function createBranch(cwd: string, name: string): void {
  git(cwd, ['checkout', '-b', name]);
}

/** Merges `branch` into `into` with a merge commit, keeping the story visible in history. */
export function mergeInto(cwd: string, branch: string, into: string, message: string): string {
  git(cwd, ['checkout', into]);
  git(cwd, ['merge', '--no-ff', branch, '-m', message]);
  return git(cwd, ['rev-parse', '--short', 'HEAD']);
}
