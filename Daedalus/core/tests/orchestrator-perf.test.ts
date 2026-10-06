import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import {
  MAX_CHILD_SUMMARY_CHARS,
  OrchestratorRunner,
  TaskRunner,
  TaskStore,
  decomposeTask,
  distillChildSummary,
  shouldRunDirect,
  type ChildTaskExecution,
  type Event,
  type LLMProvider,
  type TaskSpec,
} from '../src/index.ts';
import { EventBus } from '../src/events.ts';

const cleanups: Array<() => void> = [];
afterEach(() => {
  while (cleanups.length) cleanups.pop()?.();
});

function temp(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

type ScriptStep = { tool: string; args: unknown } | { text: string };

function scriptedProvider(script: ScriptStep[]): LLMProvider {
  let index = 0;
  return {
    name: 'scripted',
    async chat() {
      const step = script[index++];
      if (!step) return { message: { role: 'assistant', content: 'done: work complete' } };
      if ('text' in step) return { message: { role: 'assistant', content: step.text } };
      return {
        message: {
          role: 'assistant',
          content: '',
          tool_calls: [{ id: `call-${index}`, type: 'function' as const, function: { name: step.tool, arguments: JSON.stringify(step.args) } }],
        },
      };
    },
    async *stream() {
      yield { type: 'delta', content: '' };
    },
  };
}

const passingValidator = {
  async validate() {
    return { checks: [{ name: 'test', cmd: 'true', status: 'pass' as const, exit_code: 0, summary: 'passed', diagnostics: [] }] };
  },
};

function runnerFor(root: string, home: string, script: ScriptStep[], maxIterations = 25): TaskRunner {
  return new TaskRunner({
    workspaceRoot: root,
    store: new TaskStore(home),
    bus: new EventBus(),
    provider: scriptedProvider(script),
    validator: passingValidator,
    approvalPolicy: 'auto',
    maxIterations,
  });
}

describe('small-task bypass (orchestrator single-path)', () => {
  test('the canned inspect→implement→validate pipeline runs as ONE loop (the incident shape)', async () => {
    const root = temp('daedalus-bypass-ws-');
    const home = temp('daedalus-bypass-home-');
    writeFileSync(join(root, 'index.html'), '<html><body>PT Contoh</body></html>');
    const runner = runnerFor(root, home, [
      { tool: 'read_file', args: { path: 'index.html' } },
      { tool: 'write_file', args: { path: 'index.html', content: '<html><body>PT Contoh <img src="hero.jpg"></body></html>' } },
      { tool: 'read_file', args: { path: 'index.html' } },
    ]);
    const result = await runner.run({ goal: 'Add images and CSS to the page', mode: 'orchestrator' });

    expect(result.state.mode).toBe('orchestrator');
    expect(result.state.status).toBe('done');
    expect(result.events.filter((event) => event.type === 'CHILD_TASK_STARTED')).toHaveLength(0);
    const skipped = result.events.find((event) => event.type === 'ORCHESTRATION_SKIPPED');
    expect(skipped).toBeTruthy();
    expect((skipped?.payload as { reason?: string }).reason).toBe('single_path');
    expect(readFileSync(join(root, 'index.html'), 'utf8')).toContain('hero.jpg');
  });

  test('a single done-criterion also runs directly (fewer than two children)', async () => {
    const root = temp('daedalus-bypass1-ws-');
    const home = temp('daedalus-bypass1-home-');
    const runner = runnerFor(root, home, [
      { tool: 'write_file', args: { path: 'one.txt', content: 'done' } },
    ]);
    const result = await runner.run({ goal: 'Write one file\ndone: file written', mode: 'orchestrator' });
    expect(result.state.status).toBe('done');
    expect(result.events.some((event) => event.type === 'ORCHESTRATION_SKIPPED')).toBe(true);
    expect(result.events.filter((event) => event.type === 'CHILD_TASK_STARTED')).toHaveLength(0);
    expect(existsSync(join(root, 'one.txt'))).toBe(true);
  });

  test('genuine fan-out (two done-criteria) still decomposes into children', async () => {
    const root = temp('daedalus-fanout-ws-');
    const home = temp('daedalus-fanout-home-');
    writeFileSync(join(root, 'a.txt'), 'hello');
    const read = { tool: 'read_file', args: { path: 'a.txt' } };
    const runner = runnerFor(root, home, [read, { tool: 'write_file', args: { path: 'c1.txt', content: '1' } }, read, read, { tool: 'write_file', args: { path: 'c2.txt', content: '2' } }, read], 12);
    const result = await runner.run({ goal: 'Coordinate\ndone: first\ndone: second', mode: 'orchestrator' });
    expect(result.state.status).toBe('done');
    expect(result.events.some((event) => event.type === 'ORCHESTRATION_SKIPPED')).toBe(false);
    expect(result.events.filter((event) => event.type === 'CHILD_TASK_STARTED')).toHaveLength(2);
    expect(result.report.metrics.child_tasks).toBe(2);
  });

  test('caller-provided children always fan out, even a single one', async () => {
    const root = temp('daedalus-explicit-ws-');
    const home = temp('daedalus-explicit-home-');
    const runner = runnerFor(root, home, [{ tool: 'write_file', args: { path: 'kid.txt', content: 'x' } }]);
    const result = await runner.run({
      goal: 'Coordinate',
      mode: 'orchestrator',
      children: [{ goal: 'Write the child file\ndone: child file written' }],
    });
    expect(result.events.some((event) => event.type === 'ORCHESTRATION_SKIPPED')).toBe(false);
    expect(result.events.filter((event) => event.type === 'CHILD_TASK_STARTED')).toHaveLength(1);
    expect(existsSync(join(root, 'kid.txt'))).toBe(true);
  });

  test('shouldRunDirect: multi-criteria never collapses, custom steps never collapse', async () => {
    const spec = (overrides: Partial<TaskSpec>): TaskSpec => ({
      id: 'spec-1',
      goal: 'Goal',
      repo_path: '/tmp',
      constraints: [],
      done_criteria: [],
      created_at: new Date().toISOString(),
      ...overrides,
    });
    const twoCriteria = spec({ done_criteria: ['a', 'b'] });
    expect(shouldRunDirect(twoCriteria, await decomposeTask(twoCriteria), [])).toBe(false);
    const noCriteria = spec({});
    const canned = await decomposeTask(noCriteria);
    expect(shouldRunDirect(noCriteria, canned, canned.map((child) => child.goal.split('Child task: ')[1]?.split('\n')[0] ?? ''))).toBe(true);
    expect(shouldRunDirect(noCriteria, canned, ['Design the schema', 'Build the API', 'Ship it'])).toBe(false);
  });
});

describe('distilled child returns', () => {
  test('a child whose tools dumped 40KB yields a ≤cap summary with no file-body dump', async () => {
    const dump = `ok: ${'FILEBODY-DUMP-LINE\n'.repeat(2200)}`; // ~42KB raw observation
    const orchestrator = new OrchestratorRunner({
      executeChild: async (): Promise<ChildTaskExecution> => ({
        status: 'done',
        summary: dump,
        files_changed: [{ path: 'src/a.ts', added: 12, removed: 3 }],
        evidence: ['validation passed: test (true)', 'created src/a.ts (+12/-3)'],
        iterations: 4,
      }),
    });
    const result = await orchestrator.run('parent-distill', [{ goal: 'change a.ts' }]);
    const summary = result.children[0]?.result_summary ?? '';
    expect(summary.length).toBeLessThanOrEqual(MAX_CHILD_SUMMARY_CHARS);
    expect(summary).not.toContain('FILEBODY-DUMP-LINE');
    expect(summary).toContain('done');
    expect(summary).toContain('changed: src/a.ts (+12/-3)');
    expect(result.summary).not.toContain('FILEBODY-DUMP-LINE');
    expect(result.summary.length).toBeLessThan(MAX_CHILD_SUMMARY_CHARS + 200);
  });

  test('distillChildSummary hard-caps even with many files and long evidence', () => {
    const files = Array.from({ length: 60 }, (_, i) => ({ path: `src/module-${i}.ts`, added: 100, removed: 50 }));
    const summary = distillChildSummary({
      status: 'done',
      summary: 'all done here',
      filesChanged: files,
      evidence: ['e'.repeat(900), 'f'.repeat(900), 'g'.repeat(900)],
    });
    expect(summary.length).toBeLessThanOrEqual(MAX_CHILD_SUMMARY_CHARS);
    expect(summary).toContain('[summary truncated]');
    expect(summary).toContain('changed: src/module-0.ts (+100/-50)');
  });

  test('distillChildSummary keeps a genuine short closing line but drops observation dumps', () => {
    const clean = distillChildSummary({ status: 'done', summary: 'Added the hero image and stylesheet.' });
    expect(clean).toContain('Added the hero image and stylesheet.');
    const dumped = distillChildSummary({ status: 'failed', errorReason: 'budget_exceeded', summary: 'ok: 1: const x = 1;\n2: const y = 2;' });
    expect(dumped).toBe('failed (budget_exceeded)');
  });

  test('TaskRunner: a child ending on a huge read returns a distilled summary to the parent', async () => {
    const root = temp('daedalus-distill-ws-');
    const home = temp('daedalus-distill-home-');
    writeFileSync(join(root, 'a.txt'), 'hello');
    const bigLines = Array.from({ length: 1600 }, (_, i) => `line ${i} of the big file`);
    bigLines.push('SECRET-TAIL-MARKER-AT-END');
    writeFileSync(join(root, 'big.txt'), bigLines.join('\n'));
    const read = { tool: 'read_file', args: { path: 'a.txt' } };
    const runner = runnerFor(root, home, [
      // child 1: inspect, implement, then "validate" by reading the huge file —
      // its last observation is the raw dump; the parent must never see it.
      read,
      { tool: 'write_file', args: { path: 'child-1.txt', content: 'first' } },
      { tool: 'read_file', args: { path: 'big.txt' } },
      // child 2
      read,
      { tool: 'write_file', args: { path: 'child-2.txt', content: 'second' } },
      read,
    ], 12);
    const result = await runner.run({ goal: 'Coordinate\ndone: first\ndone: second', mode: 'orchestrator' });
    expect(result.state.status).toBe('done');
    const finished = result.events.filter((event) => event.type === 'CHILD_TASK_FINISHED');
    expect(finished).toHaveLength(2);
    for (const event of finished) {
      const child = (event.payload as { child: { result_summary?: string } }).child;
      expect((child.result_summary ?? '').length).toBeLessThanOrEqual(MAX_CHILD_SUMMARY_CHARS);
      expect(child.result_summary ?? '').not.toContain('SECRET-TAIL-MARKER-AT-END');
    }
    const firstChild = (finished[0]?.payload as { child: { result_summary?: string } }).child;
    expect(firstChild.result_summary).toContain('changed: child-1.txt');
    // The parent evidence carries the same distilled shape, not the dump.
    expect(result.report.evidence.join('\n')).not.toContain('SECRET-TAIL-MARKER-AT-END');
    expect(result.report.evidence[0]).toMatch(/^child budgets: /);
  });
});

describe('per-child budget slices + continue', () => {
  test('a child burning its slice fails typed; siblings continue; outcome is partial', async () => {
    const executed: string[] = [];
    const orchestrator = new OrchestratorRunner({
      totalBudget: { max_iterations: 25, max_errors: 5 },
      executeChild: async (child): Promise<ChildTaskExecution> => {
        executed.push(child.goal);
        if (child.goal === 'burner') return { status: 'failed', error_reason: 'budget_exceeded', summary: 'ran in circles', iterations: 8, errors: 1 };
        return { status: 'done', summary: `finished ${child.goal}`, iterations: 5 };
      },
    });
    const result = await orchestrator.run('parent-slices', [{ goal: 'burner' }, { goal: 'two' }, { goal: 'three' }]);
    expect(executed).toEqual(['burner', 'two', 'three']);
    expect(result.children.map((child) => child.status)).toEqual(['failed', 'done', 'done']);
    expect(result.children[0]?.error_reason).toBe('budget_exceeded');
    expect(result.status).toBe('partial');
    expect(result.budget_exceeded).toBe(false);
    expect(result.budget_summary).toContain('child budgets: 8/8, 5/');
    expect(result.budget_summary).toContain('pool 18/25');
    expect(result.children[1]?.iterations_used).toBe(5);
  });

  test('slices never let the run exceed the total pool; unstarted children cancel typed', async () => {
    const executed: string[] = [];
    const orchestrator = new OrchestratorRunner({
      totalBudget: { max_iterations: 12, max_errors: 9 },
      executeChild: async (child): Promise<ChildTaskExecution> => {
        executed.push(child.goal);
        // A greedy child consumes its whole slice.
        return { status: 'done', summary: 'greedy', iterations: child.budget?.max_iterations ?? 1 };
      },
    });
    const result = await orchestrator.run('parent-pool', [{ goal: 'a' }, { goal: 'b' }, { goal: 'c' }, { goal: 'd' }, { goal: 'e' }]);
    expect(executed).toEqual(['a', 'b']);
    expect(result.children.map((child) => child.status)).toEqual(['done', 'done', 'cancelled', 'cancelled', 'cancelled']);
    expect(result.children[2]?.error_reason).toBe('budget_exceeded');
    expect(result.budget_exceeded).toBe(true);
    const totalUsed = result.children.reduce((sum, child) => sum + (child.iterations_used ?? 0), 0);
    expect(totalUsed).toBeLessThanOrEqual(12);
    // First slice: even share of 12 over 5 children = 2, but the floor is 8 (capped by the pool).
    expect(result.budget_summary).toContain('8/8');
  });

  test('slices: even share wins over the floor when the pool is generous', async () => {
    const slices: number[] = [];
    const orchestrator = new OrchestratorRunner({
      totalBudget: { max_iterations: 100, max_errors: 9 },
      executeChild: async (child): Promise<ChildTaskExecution> => {
        slices.push(child.budget?.max_iterations ?? -1);
        return { status: 'done', summary: 'ok', iterations: 1 };
      },
    });
    await orchestrator.run('parent-share', [{ goal: 'a' }, { goal: 'b' }, { goal: 'c' }, { goal: 'd' }]);
    expect(slices[0]).toBe(25);
  });

  test('TaskRunner partial: one child fails its slice, the other completes, files remain', async () => {
    const root = temp('daedalus-partial-ws-');
    const home = temp('daedalus-partial-home-');
    // Distinct files/contents: child 1 reads ten different files and never
    // mutates, so it dies on its iteration slice mid-implementation-step.
    for (let i = 1; i <= 10; i++) writeFileSync(join(root, `f${i}.txt`), `content ${i}`);
    const reads = Array.from({ length: 10 }, (_, i) => ({ tool: 'read_file', args: { path: `f${i + 1}.txt` } }));
    const runner = runnerFor(root, home, [
      ...reads,
      { tool: 'read_file', args: { path: 'f1.txt' } },
      { tool: 'write_file', args: { path: 'survivor.txt', content: 'kept' } },
      { tool: 'read_file', args: { path: 'f2.txt' } },
    ], 20);
    const result = await runner.run({ goal: 'Coordinate\ndone: first\ndone: second', mode: 'orchestrator' });
    expect(result.outcome).toBe('partial');
    expect(existsSync(join(root, 'survivor.txt'))).toBe(true);
    const finished = result.events.filter((event) => event.type === 'CHILD_TASK_FINISHED');
    const children = finished.map((event) => (event.payload as { child: { status: string; error_reason?: string } }).child);
    expect(children.map((child) => child.status)).toEqual(['failed', 'done']);
    expect(children[0]?.error_reason).toBe('budget_exceeded');
    expect(result.report.evidence[0]).toMatch(/^child budgets: /);
    expect(result.report.evidence[0]).toContain('10/10');
  });
});

describe('findings handoff', () => {
  test('later children receive earlier distilled summaries under the findings heading', async () => {
    const contexts: Array<string | undefined> = [];
    const orchestrator = new OrchestratorRunner({
      executeChild: async (_child, context): Promise<ChildTaskExecution> => {
        contexts.push(context.priorFindings);
        return contexts.length === 1
          ? { status: 'done', summary: 'found the config', files_changed: [{ path: 'src/a.ts', added: 3, removed: 1 }], iterations: 2 }
          : { status: 'done', summary: 'built on it', iterations: 2 };
      },
    });
    await orchestrator.run('parent-findings', [{ goal: 'inspect a.ts' }, { goal: 'use the findings' }]);
    expect(contexts[0]).toBeUndefined();
    expect(contexts[1]).toContain('## findings from previous steps');
    expect(contexts[1]).toContain('changed: src/a.ts (+3/-1)');
  });

  test('TaskRunner: the second child prompt context carries the first child findings', async () => {
    const root = temp('daedalus-handoff-ws-');
    const home = temp('daedalus-handoff-home-');
    writeFileSync(join(root, 'a.txt'), 'hello');
    const read = { tool: 'read_file', args: { path: 'a.txt' } };
    const store = new TaskStore(home);
    const runner = new TaskRunner({
      workspaceRoot: root,
      store,
      bus: new EventBus(),
      provider: scriptedProvider([
        read,
        { tool: 'write_file', args: { path: 'first.txt', content: 'one' } },
        read,
        read,
        { tool: 'write_file', args: { path: 'second.txt', content: 'two' } },
        read,
      ]),
      validator: passingValidator,
      approvalPolicy: 'auto',
      maxIterations: 12,
    });
    const result = await runner.run({ goal: 'Coordinate\ndone: first\ndone: second', mode: 'orchestrator' });
    expect(result.state.status).toBe('done');
    const started = result.events.filter((event) => event.type === 'CHILD_TASK_STARTED');
    const secondChildId = (started[1]?.payload as { child: { id: string } }).child.id;
    const secondState = store.loadState<{ constraints: string[] }>(secondChildId);
    const constraints = (secondState?.constraints ?? []).join('\n');
    expect(constraints).toContain('## findings from previous steps');
    expect(constraints).toContain('changed: first.txt');
  });
});

describe('child FILE_CHANGED mirroring (diff panel)', () => {
  test('child writes land once in the parent log, tagged; the child log keeps its originals', async () => {
    const root = temp('daedalus-mirror-ws-');
    const home = temp('daedalus-mirror-home-');
    writeFileSync(join(root, 'a.txt'), 'hello');
    const read = { tool: 'read_file', args: { path: 'a.txt' } };
    const store = new TaskStore(home);
    const runner = new TaskRunner({
      workspaceRoot: root,
      store,
      bus: new EventBus(),
      provider: scriptedProvider([
        read,
        { tool: 'write_file', args: { path: 'mirror-1.txt', content: 'one' } },
        read,
        read,
        { tool: 'write_file', args: { path: 'mirror-2.txt', content: 'two' } },
        read,
      ]),
      validator: passingValidator,
      approvalPolicy: 'auto',
      maxIterations: 12,
    });
    const result = await runner.run({ goal: 'Coordinate\ndone: first\ndone: second', mode: 'orchestrator' });
    const parentId = result.state.id;
    expect(result.state.status).toBe('done');

    const parentLog = store.replay(parentId);
    const mirrored = parentLog.filter(
      (event) => event.type === 'FILE_CHANGED' && (event.payload as { mirrored?: boolean }).mirrored === true,
    );
    expect(mirrored.map((event) => (event.payload as { path: string }).path).sort()).toEqual(['mirror-1.txt', 'mirror-2.txt']);
    for (const event of mirrored) {
      const payload = event.payload as { parent_task_id?: string; child_task_id?: string };
      expect(payload.parent_task_id).toBe(parentId);
      expect(payload.child_task_id).toBeTruthy();
      expect(payload.child_task_id).not.toBe(parentId);
    }
    // The parent log holds ONLY the mirrors (child originals live in child logs).
    const parentFileEvents = parentLog.filter((event) => event.type === 'FILE_CHANGED');
    expect(parentFileEvents).toHaveLength(2);

    // Child logs hold the originals, untagged — a child view shows each path once.
    const childIds = [...new Set(mirrored.map((event) => (event.payload as { child_task_id: string }).child_task_id))];
    expect(childIds).toHaveLength(2);
    for (const childId of childIds) {
      const childChanges = store.replay(childId).filter((event) => event.type === 'FILE_CHANGED');
      expect(childChanges).toHaveLength(1);
      expect((childChanges[0]?.payload as { mirrored?: boolean }).mirrored).toBeUndefined();
    }

    // Core accounting counts each change once (mirrors excluded).
    expect(result.report.metrics.files_changed).toBe(2);
    expect(result.events.filter((event) => event.type === 'FILE_CHANGED')).toHaveLength(2);
  });
});

describe('child goal contracts', () => {
  test('decomposed implementation children demand change evidence and a short summary', async () => {
    const spec: TaskSpec = {
      id: 'spec-contract',
      goal: 'Build the thing',
      repo_path: '/tmp',
      constraints: [],
      done_criteria: ['the widget exists'],
      created_at: new Date().toISOString(),
      mode: 'orchestrator',
    };
    const [child] = await decomposeTask({ ...spec, done_criteria: ['one', 'two'] });
    expect(child?.goal).toContain('Child task: satisfy this done criterion: one');
    expect(child?.goal).toContain('read-only inspection alone does not complete it');
    expect(child?.goal).toContain('never paste file contents into the summary');
  });
});
