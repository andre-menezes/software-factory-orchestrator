import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { Command } from 'commander';
import { buildBriefing, buildStatus } from './briefing.js';
import * as git from './git.js';
import { artifactProblem, ensureArtifact, scaffoldProject } from './scaffold.js';
import { FactoryError, loadState, nextId, now, record, saveState } from './state.js';
import type { ProjectState } from './state.js';
import * as t from './transitions.js';
import { ROOT, loadWorkflow, validateWorkflow } from './workflow.js';

const POINTER = join(ROOT, '.factory', 'current');
const program = new Command();

program
  .name('factory')
  .description('Motor de orquestração da fábrica de software: única autoridade sobre o PROJECT_STATE.json.')
  .option('-t, --target <path>', 'repositório de destino (padrão: FACTORY_TARGET ou o último usado)');

function setPointer(target: string): void {
  mkdirSync(join(ROOT, '.factory'), { recursive: true });
  writeFileSync(POINTER, `${target}\n`);
}

function targetDir(): string {
  const opt = program.opts<{ target?: string }>().target ?? process.env.FACTORY_TARGET;
  if (opt) return resolve(opt);
  if (existsSync(POINTER)) return readFileSync(POINTER, 'utf8').trim();
  throw new FactoryError('Nenhum repositório de destino definido. Use --target <path>, FACTORY_TARGET, ou rode "./bin/factory init".');
}

/** Loads workflow + state, runs `fn`, and persists the state afterwards. */
function mutate(fn: (ctx: { state: ProjectState; wf: ReturnType<typeof loadWorkflow>; target: string }) => void): void {
  const target = targetDir();
  const wf = loadWorkflow();
  const state = loadState(target);
  fn({ state, wf, target });
  saveState(target, state);
}

// Output is buffered and flushed only after the state is saved, so a closed
// pipe (e.g. `| head`) can never interrupt a command halfway through.
const buffered: string[] = [];
const out = (text: string) => void buffered.push(text);
process.stdout.on('error', (err: NodeJS.ErrnoException) => {
  if (err.code !== 'EPIPE') throw err;
});

program
  .command('init <slug>')
  .description('Cria o repositório de destino (../cliente-<slug> por padrão) e o estado inicial')
  .requiredOption('-p, --problem <texto>', 'o problema de negócio, nas palavras do cliente')
  .option('-n, --name <nome>', 'nome de exibição do projeto')
  .action((slug: string, opts: { problem: string; name?: string }) => {
    const clean = t.slugify(slug);
    if (!clean) throw new FactoryError('Slug inválido. Use letras, números e hífens.');
    const explicit = program.opts<{ target?: string }>().target;
    const target = resolve(explicit ?? join(ROOT, '..', `cliente-${clean}`));
    const wf = loadWorkflow();
    const problems = validateWorkflow(wf);
    if (problems.length) throw new FactoryError(`workflow.yaml com problemas:\n- ${problems.join('\n- ')}`);
    scaffoldProject(wf, { target, name: opts.name ?? clean, slug: clean, problem: opts.problem });
    setPointer(target);
    out(`Projeto criado em ${target}\nPróximo passo: ./bin/factory next`);
  });

program
  .command('use <path>')
  .description('Aponta o orquestrador para um repositório de destino já existente')
  .action((path: string) => {
    const target = resolve(path);
    loadState(target);
    setPointer(target);
    out(`Destino atual: ${target}`);
  });

program
  .command('status')
  .description('Mostra a posição do projeto, etapas, stories e registros em aberto')
  .option('--json', 'imprime o estado bruto')
  .action((opts: { json?: boolean }) => {
    const target = targetDir();
    const state = loadState(target);
    out(opts.json ? JSON.stringify(state, null, 2) : buildStatus(state, loadWorkflow(), target));
  });

program
  .command('next')
  .description('Inicia (se preciso) a unidade atual e imprime o briefing para o agente responsável')
  .action(() =>
    mutate(({ state, wf, target }) => {
      const cur = state.current;
      if (cur.status === 'PENDENTE') {
        // Every unit starts from the main branch; a story then gets its own branch.
        git.requireBranch(target, state.git.mainBranch);
        t.begin(state, wf);
        if (cur.kind === 'story') git.createBranch(target, t.currentStory(state).branch!);
      }
      if (cur.kind === 'step') ensureArtifact(target, t.currentStep(state, wf), state);
      out(buildBriefing(state, wf, target));
    }),
  );

program
  .command('submit')
  .description('Fecha o trabalho da unidade atual e abre o gate de aprovação')
  .requiredOption('-s, --summary <texto>', 'resumo executivo apresentado ao cliente')
  .action((opts: { summary: string }) =>
    mutate(({ state, wf, target }) => {
      if (state.current.kind === 'step') {
        const problem = artifactProblem(target, t.currentStep(state, wf));
        if (problem) throw new FactoryError(problem);
      }
      t.submit(state, wf, opts.summary);
      out(buildBriefing(state, wf, target));
    }),
  );

program
  .command('approve')
  .description('APROVADO: registra a aprovação do cliente, faz o commit e avança')
  .option('--note <texto>', 'observação do cliente')
  .action((opts: { note?: string }) =>
    mutate(({ state, wf, target }) => {
      const { kind, ref } = state.current;
      if (kind === 'step') {
        const step = t.currentStep(state, wf);
        const revision = state.steps[step.id]!.revision;
        git.requireBranch(target, state.git.mainBranch);
        t.approve(state, wf, opts.note ?? null);
        saveState(target, state);
        const sha = git.commitAll(target, `${step.commitType}(${step.id}): approve ${step.output} (rev ${revision})`);
        out(`${step.id} APROVADO. Commit ${sha} em ${state.git.mainBranch}.`);
      } else {
        const story = t.currentStory(state);
        git.requireBranch(target, story.branch!);
        t.approve(state, wf, opts.note ?? null);
        saveState(target, state);
        git.commitAll(target, `chore(${story.id}): approve story (rev ${story.revision})`);
        const sha = git.mergeInto(target, story.branch!, state.git.mainBranch, `merge: ${story.id} ${story.title}`);
        out(`${ref} APROVADA. Branch ${story.branch} integrada em ${state.git.mainBranch} (${sha}).`);
      }
      out(`Próxima unidade: ${state.current.kind} ${state.current.ref ?? ''} (${state.current.status}). Rode: ./bin/factory next`);
    }),
  );

program
  .command('adjust <detalhes>')
  .description('AJUSTAR: devolve a unidade ao agente com os ajustes pedidos pelo cliente')
  .action((details: string) =>
    mutate(({ state, wf }) => {
      t.adjust(state, wf, details);
      out(`Ajuste registrado em ${state.current.ref}. Rode: ./bin/factory next`);
    }),
  );

program
  .command('ask <pergunta>')
  .description('PERGUNTAR: registra uma pergunta do cliente (e a resposta) sem mudar o estado')
  .option('-a, --answer <texto>', 'resposta dada')
  .action((question: string, opts: { answer?: string }) =>
    mutate(({ state }) => {
      const id = nextId('Q', state.questions);
      state.questions.push({ id, question, answer: opts.answer ?? null, ref: state.current.ref, at: now() });
      record(state, 'PERGUNTA', state.current.ref, question);
      out(`${id} registrada. O estado continua ${state.current.status}.`);
    }),
  );

program
  .command('sync-done')
  .description('Conclui a passada do Technical Writer, faz o commit e avança')
  .requiredOption('-s, --summary <texto>', 'o que foi atualizado na documentação')
  .action((opts: { summary: string }) =>
    mutate(({ state, wf, target }) => {
      const ref = state.current.ref;
      git.requireBranch(target, state.git.mainBranch);
      t.completeSync(state, wf, opts.summary);
      saveState(target, state);
      const sha = git.commitAll(target, `docs(sync): technical writer pass after ${ref}`);
      out(`Documentação sincronizada (${sha}). Próxima unidade: ${state.current.kind} ${state.current.ref ?? ''}. Rode: ./bin/factory next`);
    }),
  );

const story = program.command('story').description('Gerencia as User Stories do backlog');

story
  .command('add')
  .description('Registra uma User Story (durante a etapa de backlog, ou depois com --scope-change)')
  .requiredOption('--id <US-000>', 'identificador')
  .requiredOption('--title <texto>', 'título curto')
  .option('--priority <n>', 'ordem de execução (menor primeiro)', Number)
  .option('--scope-change', 'story nova após o backlog aprovado, confirmada pelo cliente')
  .action((opts: { id: string; title: string; priority?: number; scopeChange?: boolean }) =>
    mutate(({ state, wf }) => {
      const s = t.addStory(state, wf, opts);
      out(`${s.id} registrada com prioridade ${s.priority}.`);
    }),
  );

story
  .command('remove <id>')
  .description('Remove uma story enquanto o backlog ainda está em elaboração')
  .action((id: string) =>
    mutate(({ state, wf }) => {
      t.removeStory(state, wf, id);
      out(`${id} removida.`);
    }),
  );

story
  .command('stage-done <stage>')
  .description('Conclui um estágio da story atual (backend, frontend, security, qa) e faz o commit na branch')
  .requiredOption('-s, --summary <texto>', 'o que foi criado ou alterado')
  .option('--tests <texto>', 'comando de validação executado e resultado')
  .option('--skip', 'o estágio não se aplica a esta story')
  .action((stage: string, opts: { summary: string; tests?: string; skip?: boolean }) =>
    mutate(({ state, wf, target }) => {
      const s = t.currentStory(state);
      git.requireBranch(target, s.branch!);
      t.stageDone(state, wf, stage, opts);
      saveState(target, state);
      const sha = git.commitAll(target, `feat(${s.id}): ${opts.skip ? 'skip' : 'complete'} ${stage} stage`);
      const next = t.nextStage(state, wf);
      out(`${s.id}/${stage} ${opts.skip ? 'PULADO' : 'CONCLUÍDO'} (${sha}). ${next ? `Próximo estágio: ${next.id}. Rode: ./bin/factory next` : 'Todos os estágios fechados. Rode: ./bin/factory submit --summary "..."'}`);
    }),
  );

program
  .command('log <tipo> <texto>')
  .description('Registra uma decisão, risco ou pendência (tipo: decision | risk | pendency)')
  .option('--ref <id>', 'etapa ou story relacionada (padrão: unidade atual)')
  .action((type: string, text: string, opts: { ref?: string }) =>
    mutate(({ state }) => {
      const ref = opts.ref ?? state.current.ref;
      let id: string;
      if (type === 'decision') {
        id = nextId('D', state.decisions);
        state.decisions.push({ id, text, ref, at: now(), adr: null });
      } else if (type === 'risk' || type === 'pendency') {
        const bucket = type === 'risk' ? state.risks : state.pendencies;
        id = nextId(type === 'risk' ? 'R' : 'P', bucket);
        bucket.push({ id, text, ref, status: 'ABERTO', at: now(), resolvedAt: null, note: null });
      } else {
        throw new FactoryError('Tipo inválido. Use decision, risk ou pendency.');
      }
      record(state, `REGISTRO_${type.toUpperCase()}`, ref, text);
      out(`${id} registrado.`);
    }),
  );

program
  .command('resolve <id>')
  .description('Fecha um risco (R-000) ou pendência (P-000), ou vincula um ADR a uma decisão (D-000 --adr)')
  .option('--note <texto>', 'como foi resolvido')
  .option('--adr <path>', 'caminho do ADR que documenta a decisão')
  .action((id: string, opts: { note?: string; adr?: string }) =>
    mutate(({ state }) => {
      if (id.startsWith('D-')) {
        const d = state.decisions.find((x) => x.id === id);
        if (!d) throw new FactoryError(`Decisão ${id} não encontrada.`);
        if (!opts.adr) throw new FactoryError('Para decisões, informe --adr <caminho do ADR>.');
        d.adr = opts.adr;
      } else {
        const r = [...state.risks, ...state.pendencies].find((x) => x.id === id);
        if (!r) throw new FactoryError(`Registro ${id} não encontrado.`);
        Object.assign(r, { status: 'RESOLVIDO', resolvedAt: now(), note: opts.note ?? null });
      }
      record(state, 'REGISTRO_RESOLVIDO', id, opts.note ?? opts.adr ?? null);
      out(`${id} atualizado.`);
    }),
  );

program
  .command('validate')
  .description('Valida o workflow.yaml (e o estado do destino atual, se houver)')
  .action(() => {
    const problems = validateWorkflow(loadWorkflow());
    if (problems.length) throw new FactoryError(`workflow.yaml com problemas:\n- ${problems.join('\n- ')}`);
    out('workflow.yaml válido.');
    try {
      const target = targetDir();
      loadState(target);
      out(`PROJECT_STATE.json válido em ${target}.`);
    } catch (err) {
      if (err instanceof FactoryError && err.message.startsWith('Nenhum repositório')) return;
      throw err;
    }
  });

try {
  await program.parseAsync();
  if (buffered.length) process.stdout.write(`${buffered.join('\n')}\n`);
} catch (err) {
  if (buffered.length) process.stdout.write(`${buffered.join('\n')}\n`);
  if (err instanceof FactoryError) {
    process.stderr.write(`ERRO: ${err.message}\n`);
    process.exit(1);
  }
  throw err;
}
