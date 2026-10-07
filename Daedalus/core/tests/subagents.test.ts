import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import {
  MAX_CHILD_SUMMARY_CHARS,
  SPAWN_SUBAGENT_TOOL_NAME,
  TaskRunner,
  TaskStore,
  backgroundFinishedNotice,
  classifyToolName,
  createSpawnSubagentTool,
  isToolCallDenied,
  isToolVisible,
  modePromptContract,
  normalizeAgentMode,
  type ApprovalRequestInfo,
  type Event,
  type LLMProvider,
  type Message,
  type ToolDefinition,
  type Usage,
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

type ScriptStep =
  | { tool: string; args: unknown }
  | { text: string }
  | { calls: Array<{ tool: string; args: unknown }> };

type Route = { match: string; steps: ScriptStep[]; usage?: Usage };
type SeenCall = { match: string; tools: string[]; messages: Message[] };

/**
 * One provider shared by parent and children (like the real runner): each
 * conversation is routed by a marker string carried only in that task's
 * goal, and consumes its own scripted steps in order.
 */
function routedProvider(routes: Route[], hooks: { before?: (match: string, callIndex: number) => Promise<void> } = {}): { provider: LLMProvider; seen: SeenCall[] } {
  const seen: SeenCall[] = [];
  const counts = new Map<string, number>();
  const provider: LLMProvider = {
    name: 'routed',
    async chat(messages: Message[], tools?: ToolDefinition[]) {
      const serialized = JSON.stringify(messages);
      const route = routes.find((candidate) => candidate.steps.length > 0 && serialized.includes(candidate.match));
      const match = route?.match ?? 'fallback';
      const callIndex = (counts.get(match) ?? 0) + 1;
      counts.set(match, callIndex);
      seen.push({ match, tools: (tools ?? []).map((tool) => tool.function.name), messages });
      await hooks.before?.(match, callIndex);
      const step = route?.steps.shift();
      const usage = route?.usage;
      if (!step) return { message: { role: 'assistant' as const, content: 'done: work complete' }, ...(usage ? { usage } : {}) };
      if ('text' in step) return { message: { role: 'assistant' as const, content: step.text }, ...(usage ? { usage } : {}) };
      const calls = 'calls' in step ? step.calls : [step];
      return {
        message: {
          role: 'assistant' as const,
          content: '',
          tool_calls: calls.map((call, i) => ({
            id: `call-${match}-${callIndex}-${i}`,
            type: 'function' as const,
            function: { name: call.tool, arguments: JSON.stringify(call.args) },
          })),
        },
        ...(usage ? { usage } : {}),
      };
    },
    async *stream() {
      yield { type: 'delta', content: '' };
    },
  };
  return { provider, seen };
}

const passingValidator = {
  async validate() {
    return { checks: [{ name: 'test', cmd: 'true', status: 'pass' as const, exit_code: 0, summary: 'passed', diagnostics: [] }] };
  },
};

function makeRunner(root: string, home: string, provider: LLMProvider, maxIterations = 25, approvalPolicy: 'auto' | 'ask' = 'auto'): { runner: TaskRunner; store: TaskStore } {
  const store = new TaskStore(home);
  const runner = new TaskRunner({
    workspaceRoot: root,
    store,
    bus: new EventBus(),
    provider,
    validator: passingValidator,
    approvalPolicy,
    maxIterations,
  });
  return { runner, store };
}

function toolResults(events: Event[], tool: string): Array<{ status: string; output: string }> {
  return events
    .filter((event) => event.type === 'TOOL_CALL_FINISHED')
    .map((event) => (event.payload as { result?: { status: string; output: string }; call?: { tool?: string }; result_meta?: unknown; tool?: string }))
    .filter((payload) => (payload as { call?: { tool?: string } }).call?.tool === tool || (payload as { result?: { meta?: { tool?: string } } }).result?.meta?.tool === tool)
    .map((payload) => payload.result!)
    .filter(Boolean);
}

function spawnResults(events: Event[]): Array<{ status: string; output: string }> {
  return toolResults(events, SPAWN_SUBAGENT_TOOL_NAME);
}

describe('spawn_subagent tool contract', () => {
  test('the tool is a mutating call: denied in ask/plan, visible in auto/manual', () => {
    expect(classifyToolName(SPAWN_SUBAGENT_TOOL_NAME)).toBe('mutating');
    expect(isToolCallDenied('ask', SPAWN_SUBAGENT_TOOL_NAME)).toBe(true);
    expect(isToolCallDenied('plan', SPAWN_SUBAGENT_TOOL_NAME)).toBe(true);
    expect(isToolCallDenied('auto', SPAWN_SUBAGENT_TOOL_NAME)).toBe(false);
    expect(isToolCallDenied('manual', SPAWN_SUBAGENT_TOOL_NAME)).toBe(false);
    expect(isToolVisible('auto', SPAWN_SUBAGENT_TOOL_NAME)).toBe(true);
    expect(isToolVisible('manual', SPAWN_SUBAGENT_TOOL_NAME)).toBe(true);
    expect(isToolVisible('ask', SPAWN_SUBAGENT_TOOL_NAME)).toBe(false);
    expect(isToolVisible('plan', SPAWN_SUBAGENT_TOOL_NAME)).toBe(false);
  });

  test('the Auto prompt carries the delegation contract and legacy modes normalize', () => {
    const contract = modePromptContract('auto');
    expect(contract).toContain('spawn_subagent');
    expect(contract).toContain('delegate hard/parallel subtasks via spawn_subagent');
    expect(normalizeAgentMode('orchestrator')).toBe('auto');
    expect(normalizeAgentMode('auto')).toBe('auto');
    expect(normalizeAgentMode('nonsense')).toBe('auto');
  });

  test('invalid arguments return an error result instead of spawning', async () => {
    const tool = createSpawnSubagentTool({
      spawn: async () => {
        throw new Error('must not be called');
      },
    });
    const missing = await tool.execute({ description: 'only a label' }, new AbortController().signal);
    expect(missing.status).toBe('error');
    expect(missing.output).toContain('description');
    const blank = await tool.execute({ description: 'x', goal: '   ' }, new AbortController().signal);
    expect(blank.status).toBe('error');
  });

  test('background notice format is a single bracketed block', () => {
    const notice = backgroundFinishedNotice({
      id: 'child-1',
      parent_task_id: 'parent-1',
      goal: 'do the chore',
      label: 'chore',
      status: 'done',
      result_summary: 'done\nchanged: chore.txt (+2/-0)',
    });
    expect(notice.startsWith('[background subagent finished]')).toBe(true);
    expect(notice).toContain('"chore"');
    expect(notice).toContain('changed: chore.txt');
  });
});

describe('foreground delegation', () => {
  test('the model spawns a child, gets the distilled result, and child events land on the parent log', async () => {
    const root = temp('daedalus-spawn-ws-');
    const home = temp('daedalus-spawn-home-');
    const { provider, seen } = routedProvider([
      {
        match: 'PARENT-GOAL',
        steps: [
          { tool: 'spawn_subagent', args: { description: 'write greeting file', goal: 'Write greeting.txt with a friendly greeting [[child-greet]]\ndone: greeting file written\ndone: greeting note written' } },
          { tool: 'write_file', args: { path: 'parent.txt', content: 'parent work' } },
        ],
      },
      {
        match: '[[child-greet]]',
        steps: [
          { tool: 'write_file', args: { path: 'greeting.txt', content: 'hello from the child' } },
          { tool: 'write_file', args: { path: 'greeting-note.txt', content: 'a note from the child' } },
        ],
      },
    ]);
    const { runner, store } = makeRunner(root, home, provider);
    const result = await runner.run({ goal: 'PARENT-GOAL: greet via a subagent\ndone: subagent result received\ndone: parent file written', mode: 'auto' });

    expect(result.state.status).toBe('done');
    expect(existsSync(join(root, 'greeting.txt'))).toBe(true);
    expect(existsSync(join(root, 'parent.txt'))).toBe(true);

    const started = result.events.find((event) => event.type === 'CHILD_TASK_STARTED');
    const finished = result.events.find((event) => event.type === 'CHILD_TASK_FINISHED');
    const startedChild = (started?.payload as { child: { id: string; label?: string } }).child;
    const finishedChild = (finished?.payload as { child: { status: string; result_summary?: string; iterations_used?: number } }).child;
    expect(startedChild.label).toBe('write greeting file');
    expect(finishedChild.status).toBe('done');
    expect(finishedChild.result_summary).toContain('changed: greeting.txt');
    expect((finishedChild.result_summary ?? '').length).toBeLessThanOrEqual(MAX_CHILD_SUMMARY_CHARS);
    expect(finishedChild.iterations_used).toBeGreaterThan(0);

    const results = spawnResults(result.events);
    expect(results).toHaveLength(1);
    expect(results[0]?.status).toBe('ok');
    expect(results[0]?.output).toContain('finished with status done');
    expect(results[0]?.output).toContain('changed: greeting.txt');

    // The child ran as a real child task of this parent.
    const childState = store.loadState<{ parent_task_id?: string }>(startedChild.id) as { parent_task_id?: string } | null;
    expect(childState?.parent_task_id).toBe(result.state.id);

    // The child was never offered the spawn tool (nesting stop), the parent was.
    const childCalls = seen.filter((call) => call.match === '[[child-greet]]');
    expect(childCalls.length).toBeGreaterThan(0);
    for (const call of childCalls) expect(call.tools).not.toContain(SPAWN_SUBAGENT_TOOL_NAME);
    const parentCalls = seen.filter((call) => call.match === 'PARENT-GOAL');
    expect(parentCalls[0]?.tools).toContain(SPAWN_SUBAGENT_TOOL_NAME);
  });

  test('a child file change is mirrored into the parent log exactly once', async () => {
    const root = temp('daedalus-spawn-mirror-ws-');
    const home = temp('daedalus-spawn-mirror-home-');
    const { provider } = routedProvider([
      {
        match: 'PARENT-MIRROR',
        steps: [
          { tool: 'spawn_subagent', args: { description: 'mirror writer', goal: 'Write mirror.txt [[child-mirror]]\ndone: mirror file written' } },
          { text: 'done: mirrored' },
        ],
      },
      {
        match: '[[child-mirror]]',
        steps: [{ tool: 'write_file', args: { path: 'mirror.txt', content: 'mirrored content' } }],
      },
    ]);
    const { runner, store } = makeRunner(root, home, provider);
    const result = await runner.run({ goal: 'PARENT-MIRROR\ndone: mirror file written', mode: 'auto' });
    expect(result.state.status).toBe('done');

    const parentLog = store.replay(result.state.id);
    const mirrored = parentLog.filter(
      (event) => event.type === 'FILE_CHANGED' && (event.payload as { mirrored?: boolean }).mirrored === true,
    );
    expect(mirrored).toHaveLength(1);
    const payload = mirrored[0]?.payload as { path: string; parent_task_id?: string; child_task_id?: string };
    expect(payload.path).toBe('mirror.txt');
    expect(payload.parent_task_id).toBe(result.state.id);
    expect(payload.child_task_id).toBeTruthy();
    // Parent accounting counts the change once (mirror excluded).
    expect(result.report.metrics.files_changed).toBe(1);
    // The child log keeps the original, untagged.
    const childChanges = store.replay(payload.child_task_id!).filter((event) => event.type === 'FILE_CHANGED');
    expect(childChanges).toHaveLength(1);
    expect((childChanges[0]?.payload as { mirrored?: boolean }).mirrored).toBeUndefined();
  });

  test('a child that burns its budget slice fails typed and the parent still finishes', async () => {
    const root = temp('daedalus-spawn-budget-ws-');
    const home = temp('daedalus-spawn-budget-home-');
    for (let i = 1; i <= 10; i++) writeFileSync(join(root, `f${i}.txt`), `content ${i}`);
    const { provider } = routedProvider([
      {
        match: 'PARENT-BUDGET',
        steps: [
          { tool: 'spawn_subagent', args: { description: 'circle reader', goal: `Read files forever [[child-burn]]\n${Array.from({ length: 10 }, (_, i) => `done: read f${i + 1}`).join('\n')}` } },
          { text: 'done: reported the failed delegation' },
        ],
      },
      {
        match: '[[child-burn]]',
        steps: Array.from({ length: 10 }, (_, i) => ({ tool: 'read_file', args: { path: `f${i + 1}.txt` } })),
      },
    ]);
    const { runner } = makeRunner(root, home, provider, 9);
    const result = await runner.run({ goal: 'PARENT-BUDGET\ndone: parent finished', mode: 'auto' });

    expect(result.state.status).toBe('done');
    const results = spawnResults(result.events);
    expect(results).toHaveLength(1);
    expect(results[0]?.output).toContain('budget_exceeded');
    const finished = result.events.find((event) => event.type === 'CHILD_TASK_FINISHED');
    const child = (finished?.payload as { child: { status: string; error_reason?: string } }).child;
    expect(child.status).toBe('failed');
    expect(child.error_reason).toBe('budget_exceeded');
    expect(result.report.metrics.child_tasks_failed).toBe(1);
  });

  test('a spawn that finds the pool spent is refused, never queued', async () => {
    const root = temp('daedalus-spawn-pool-ws-');
    const home = temp('daedalus-spawn-pool-home-');
    for (let i = 1; i <= 10; i++) writeFileSync(join(root, `f${i}.txt`), `content ${i}`);
    const { provider } = routedProvider([
      {
        match: 'PARENT-POOL',
        steps: [
          { tool: 'spawn_subagent', args: { description: 'greedy child', goal: `Read files forever [[child-greedy]]\n${Array.from({ length: 10 }, (_, i) => `done: read f${i + 1}`).join('\n')}` } },
          { tool: 'spawn_subagent', args: { description: 'late child', goal: 'Write late.txt [[child-late]]\ndone: late file written' } },
          { tool: 'write_file', args: { path: 'parent-proof.txt', content: 'parent finished itself' } },
          { tool: 'write_file', args: { path: 'parent-proof-2.txt', content: 'parent really finished' } },
        ],
      },
      {
        match: '[[child-greedy]]',
        steps: Array.from({ length: 10 }, (_, i) => ({ tool: 'read_file', args: { path: `f${i + 1}.txt` } })),
      },
    ]);
    // Pool 9: the parent's spawn turn leaves 8, the greedy child burns its
    // whole slice of 8, and nothing remains for the second delegation.
    const { runner } = makeRunner(root, home, provider, 9);
    const result = await runner.run({ goal: 'PARENT-POOL\ndone: first delegation attempted\ndone: second delegation attempted\ndone: parent finished the work itself', mode: 'auto' });

    expect(result.state.status).toBe('done');
    const results = spawnResults(result.events);
    expect(results).toHaveLength(2);
    expect(results[0]?.output).toContain('budget_exceeded');
    expect(results[1]?.status).toBe('error');
    expect(results[1]?.output).toContain('iteration budget');
    expect(result.events.filter((event) => event.type === 'CHILD_TASK_STARTED')).toHaveLength(1);
    expect(existsSync(join(root, 'late.txt'))).toBe(false);
    expect(existsSync(join(root, 'parent-proof.txt'))).toBe(true);
  });

  test('a child run (parentTaskId set) has no spawn tool and the call is denied', async () => {
    const root = temp('daedalus-nested-ws-');
    const home = temp('daedalus-nested-home-');
    const { provider, seen } = routedProvider([
      {
        match: 'CHILD-ONLY',
        steps: [
          { tool: 'spawn_subagent', args: { description: 'grandchild', goal: 'should never run' } },
          { tool: 'write_file', args: { path: 'proof.txt', content: 'child did its own work' } },
          { tool: 'write_file', args: { path: 'proof-note.txt', content: 'more of its own work' } },
        ],
      },
    ]);
    const { runner } = makeRunner(root, home, provider);
    const result = await runner.run({ goal: 'CHILD-ONLY\ndone: proof written\ndone: proof note written', mode: 'auto', parentTaskId: 'some-parent' });

    expect(result.state.status).toBe('done');
    expect(result.events.some((event) => event.type === 'CHILD_TASK_STARTED')).toBe(false);
    const results = spawnResults(result.events);
    expect(results).toHaveLength(1);
    expect(results[0]?.status).toBe('denied');
    expect(results[0]?.output).toContain('not available in this run');
    expect(existsSync(join(root, 'proof.txt'))).toBe(true);
    for (const call of seen) expect(call.tools).not.toContain(SPAWN_SUBAGENT_TOOL_NAME);
  });
});

describe('parallel delegation', () => {
  test('three spawns in one turn run concurrently and the pool is never exceeded', async () => {
    const root = temp('daedalus-parallel-ws-');
    const home = temp('daedalus-parallel-home-');
    let active = 0;
    let maxActive = 0;
    let arrived = 0;
    let release: () => void = () => undefined;
    const barrier = new Promise<void>((resolve) => { release = resolve; });
    const enter = async (): Promise<void> => {
      active++;
      arrived++;
      maxActive = Math.max(maxActive, active);
      if (arrived >= 3) release();
      // Timeout fallback: a sequential implementation proceeds alone
      // instead of hanging the test, and maxActive stays at 1.
      await Promise.race([barrier, new Promise((resolve) => setTimeout(resolve, 1500))]);
      active--;
    };
    const childRoute = (marker: string, file: string): Route => ({
      match: marker,
      steps: [{ tool: 'write_file', args: { path: file, content: `from ${marker}` } }],
    });
    const { provider } = routedProvider(
      [
        {
          match: 'PARENT-PARALLEL',
          steps: [
            {
              calls: [
                { tool: 'spawn_subagent', args: { description: 'writer a', goal: 'Write a.txt [[child-a]]\ndone: a written' } },
                { tool: 'spawn_subagent', args: { description: 'writer b', goal: 'Write b.txt [[child-b]]\ndone: b written' } },
                { tool: 'spawn_subagent', args: { description: 'writer c', goal: 'Write c.txt [[child-c]]\ndone: c written' } },
              ],
            },
          ],
        },
        childRoute('[[child-a]]', 'a.txt'),
        childRoute('[[child-b]]', 'b.txt'),
        childRoute('[[child-c]]', 'c.txt'),
      ],
      {
        before: async (match, callIndex) => {
          if (match.startsWith('[[child-') && callIndex === 1) await enter();
        },
      },
    );
    const maxIterations = 25;
    const { runner } = makeRunner(root, home, provider, maxIterations);
    const result = await runner.run({ goal: 'PARENT-PARALLEL\ndone: first subagent done\ndone: second subagent done\ndone: third subagent done', mode: 'auto' });

    expect(result.state.status).toBe('done');
    expect(maxActive).toBeGreaterThanOrEqual(2);
    for (const file of ['a.txt', 'b.txt', 'c.txt']) expect(existsSync(join(root, file))).toBe(true);

    const results = spawnResults(result.events);
    expect(results).toHaveLength(3);
    for (const toolResult of results) expect(toolResult.status).toBe('ok');

    // Exact pool accounting: parent turns + child iterations ≤ the pool.
    const parentTurns = result.events.filter((event) => event.task_id === result.state.id && event.type === 'MODEL_REQUEST_FINISHED').length;
    const childIterations = result.events
      .filter((event) => event.type === 'CHILD_TASK_FINISHED')
      .reduce((sum, event) => sum + ((event.payload as { child: { iterations_used?: number } }).child.iterations_used ?? 0), 0);
    expect(parentTurns + childIterations).toBeLessThanOrEqual(maxIterations);
    expect(result.report.metrics.child_tasks).toBe(3);
    expect(result.report.metrics.child_tasks_done).toBe(3);
  });
});

describe('background delegation', () => {
  test('background spawn returns immediately, the parent continues, and the result arrives as a turn notice', async () => {
    const root = temp('daedalus-bg-ws-');
    const home = temp('daedalus-bg-home-');
    writeFileSync(join(root, 'seed.txt'), 'seed');
    writeFileSync(join(root, 'seed2.txt'), 'seed two');
    let parentSecondTurn: () => void = () => undefined;
    const parentSecondTurnSeen = new Promise<void>((resolve) => { parentSecondTurn = resolve; });
    const { provider, seen } = routedProvider(
      [
        {
          match: 'PARENT-BG',
          steps: [
            { tool: 'spawn_subagent', args: { description: 'bg chore', goal: 'Write bg.txt slowly [[child-bg]]\ndone: bg file written\ndone: bg note written', background: true } },
            { tool: 'read_file', args: { path: 'seed.txt' } },
            { tool: 'run_command', args: { command: 'sleep', args: ['1'] } },
            { tool: 'read_file', args: { path: 'seed2.txt' } },
          ],
        },
        {
          match: '[[child-bg]]',
          steps: [
            { tool: 'write_file', args: { path: 'bg.txt', content: 'background work' } },
            { tool: 'write_file', args: { path: 'bg-note.txt', content: 'background note' } },
          ],
        },
      ],
      {
        before: async (match, callIndex) => {
          // The child only completes after the parent's second turn has
          // begun; the parent's slow third turn then gives the child time
          // to land its notice before the fourth request is built.
          if (match === '[[child-bg]]' && callIndex === 2) await parentSecondTurnSeen;
          if (match === 'PARENT-BG' && callIndex === 2) parentSecondTurn();
        },
      },
    );
    const { runner } = makeRunner(root, home, provider);
    const result = await runner.run({ goal: 'PARENT-BG\ndone: background delegated\ndone: seed read\ndone: slow command done\ndone: second seed read', mode: 'auto' });

    expect(result.state.status).toBe('done');
    // The spawn tool returned immediately with the background receipt.
    const results = spawnResults(result.events);
    expect(results).toHaveLength(1);
    expect(results[0]?.output).toContain('running in the background');
    // The parent kept working its own turns while the child ran.
    const parentCalls = seen.filter((call) => call.match === 'PARENT-BG');
    expect(parentCalls.length).toBe(4);
    // The notice cannot be in the second request (the child was still
    // blocked waiting for it) and must arrive by the fourth.
    const hasNotice = (call: SeenCall | undefined): boolean =>
      (call?.messages ?? []).some((message) => typeof message.content === 'string' && message.content.startsWith('[background subagent finished]'));
    expect(hasNotice(parentCalls[1])).toBe(false);
    expect(hasNotice(parentCalls[3])).toBe(true);
    expect(JSON.stringify(parentCalls[3]?.messages ?? [])).toContain('changed: bg.txt');
    // End of task waited for the child: file + report evidence present.
    expect(existsSync(join(root, 'bg.txt'))).toBe(true);
    expect(result.report.evidence.join('\n')).toContain('background subagent "bg chore"');
  }, 20000);

  test('stop cancels a running background child and the run resolves', async () => {
    const root = temp('daedalus-bgstop-ws-');
    const home = temp('daedalus-bgstop-home-');
    for (let i = 1; i <= 10; i++) writeFileSync(join(root, `s${i}.txt`), `seed ${i}`);
    let childCalls = 0;
    const { provider } = routedProvider(
      [
        {
          match: 'PARENT-STOP',
          steps: [
            { tool: 'spawn_subagent', args: { description: 'slow reader', goal: 'Read everything slowly [[child-slow]]', background: true } },
            { text: 'done: parent wrapped up' },
          ],
        },
        {
          match: '[[child-slow]]',
          steps: Array.from({ length: 10 }, (_, i) => ({ tool: 'read_file', args: { path: `s${i + 1}.txt` } })),
        },
      ],
      {
        before: async (match) => {
          if (match === '[[child-slow]]') {
            childCalls++;
            await new Promise((resolve) => setTimeout(resolve, 250));
          }
        },
      },
    );
    const { runner } = makeRunner(root, home, provider);
    const running = runner.run({ goal: 'PARENT-STOP\ndone: parent finished', mode: 'auto', taskId: 'stop-parent' });
    await new Promise((resolve) => setTimeout(resolve, 400));
    runner.cancel('stop-parent');
    const result = await running;

    const finished = result.events.find((event) => event.type === 'CHILD_TASK_FINISHED');
    expect(finished).toBeTruthy();
    const child = (finished?.payload as { child: { status: string } }).child;
    expect(child.status).not.toBe('done');
    expect(childCalls).toBeLessThan(10);
  }, 20000);
});

describe('mode gating', () => {
  test('spawn is denied in ask and plan modes', async () => {
    for (const mode of ['ask', 'plan'] as const) {
      const root = temp(`daedalus-deny-${mode}-ws-`);
      const home = temp(`daedalus-deny-${mode}-home-`);
      const { provider, seen } = routedProvider([
        {
          match: `PARENT-${mode.toUpperCase()}`,
          steps: [
            { tool: 'spawn_subagent', args: { description: 'nope', goal: 'should never run [[never]]' } },
            { text: 'done: finished without delegating' },
          ],
        },
      ]);
      const { runner } = makeRunner(root, home, provider);
      const result = await runner.run({ goal: `PARENT-${mode.toUpperCase()}\ndone: finished`, mode });
      expect(result.events.some((event) => event.type === 'CHILD_TASK_STARTED')).toBe(false);
      const results = spawnResults(result.events);
      expect(results).toHaveLength(1);
      expect(results[0]?.status).toBe('denied');
      // Not even offered to the model in these modes.
      for (const call of seen) expect(call.tools).not.toContain(SPAWN_SUBAGENT_TOOL_NAME);
    }
  });

  test('manual mode asks approval once for the delegation; the child write asks too', async () => {
    const root = temp('daedalus-manual-ws-');
    const home = temp('daedalus-manual-home-');
    const { provider } = routedProvider([
      {
        match: 'PARENT-MANUAL',
        steps: [
          { tool: 'spawn_subagent', args: { description: 'manual child', goal: 'Write manual.txt [[child-manual]]' } },
          { text: 'done: delegated with permission' },
        ],
      },
      {
        match: '[[child-manual]]',
        steps: [
          { tool: 'write_file', args: { path: 'manual.txt', content: 'approved work' } },
          { text: 'Wrote manual.txt.' },
        ],
      },
    ]);
    const { runner } = makeRunner(root, home, provider, 25, 'ask');
    const requestedTools: string[] = [];
    const result = await runner.run({
      goal: 'PARENT-MANUAL\ndone: file written',
      mode: 'manual',
      onEvent: (event) => {
        if (event.type !== 'APPROVAL_REQUESTED') return;
        const info = (event.payload as { approval?: ApprovalRequestInfo }).approval;
        if (!info) return;
        requestedTools.push(info.key.tool);
        setTimeout(() => runner.approvals.decideById(info.id, { decision: 'allow' }), 5);
      },
    });

    expect(result.state.status).toBe('done');
    expect(existsSync(join(root, 'manual.txt'))).toBe(true);
    expect(requestedTools.filter((tool) => tool === SPAWN_SUBAGENT_TOOL_NAME)).toHaveLength(1);
    expect(requestedTools).toContain('write_file');
  });

  test('a legacy orchestrator task loads as auto and runs directly', async () => {
    const root = temp('daedalus-legacy-ws-');
    const home = temp('daedalus-legacy-home-');
    const { provider } = routedProvider([
      {
        match: 'LEGACY-GOAL',
        steps: [
          { tool: 'write_file', args: { path: 'legacy.txt', content: 'still works' } },
          { text: 'done: legacy task complete' },
        ],
      },
    ]);
    const { runner } = makeRunner(root, home, provider);
    const result = await runner.run({ goal: 'LEGACY-GOAL\ndone: file written', mode: 'orchestrator' });
    expect(result.state.mode).toBe('auto');
    expect(result.state.status).toBe('done');
    expect(result.events.some((event) => event.type === 'CHILD_TASK_STARTED')).toBe(false);
    expect(readFileSync(join(root, 'legacy.txt'), 'utf8')).toBe('still works');
  });
});

describe('token accounting', () => {
  test('provider usage accumulates across parent and child iterations into the report', async () => {
    const root = temp('daedalus-usage-ws-');
    const home = temp('daedalus-usage-home-');
    const parentUsage: Usage = { prompt_tokens: 100, completion_tokens: 10, total_tokens: 110 };
    const childUsage: Usage = { prompt_tokens: 50, completion_tokens: 5, total_tokens: 55 };
    const { provider } = routedProvider([
      {
        match: 'PARENT-USAGE',
        usage: parentUsage,
        steps: [
          { tool: 'spawn_subagent', args: { description: 'usage child', goal: 'Write usage.txt [[child-usage]]\ndone: usage file written\ndone: usage note written' } },
        ],
      },
      {
        match: '[[child-usage]]',
        usage: childUsage,
        steps: [
          { tool: 'write_file', args: { path: 'usage.txt', content: 'counted' } },
          { tool: 'write_file', args: { path: 'usage-note.txt', content: 'also counted' } },
        ],
      },
    ]);
    const { runner } = makeRunner(root, home, provider);
    const result = await runner.run({ goal: 'PARENT-USAGE\ndone: file written', mode: 'auto' });

    expect(result.state.status).toBe('done');
    const requestEvents = result.events.filter((event) => event.type === 'MODEL_REQUEST_FINISHED');
    // 1 parent request + 2 child requests, rolled into the parent total.
    expect(result.report.metrics.model_requests).toBe(requestEvents.length);
    expect(requestEvents.length).toBe(3);
    expect(result.report.metrics.tokens_input).toBe(100 + 2 * 50);
    expect(result.report.metrics.tokens_output).toBe(10 + 2 * 5);
    expect(result.report.metrics.tokens_total).toBe(110 + 2 * 55);
    expect(result.report.metrics.token_requests_reported).toBe(3);
    // The child's record carries its own roll-up for the parent's views.
    const finished = result.events.find((event) => event.type === 'CHILD_TASK_FINISHED');
    const recordedUsage = (finished?.payload as { child: { usage?: { requests: number; reported: number; input_tokens?: number; output_tokens?: number; total_tokens?: number } } }).child.usage;
    expect(recordedUsage).toEqual({ requests: 2, reported: 2, input_tokens: 100, output_tokens: 10, total_tokens: 110 });
  });

  test('no usage reported → token fields omitted, request count still honest', async () => {
    const root = temp('daedalus-nousage-ws-');
    const home = temp('daedalus-nousage-home-');
    const { provider } = routedProvider([
      {
        match: 'PARENT-NOUSAGE',
        steps: [{ tool: 'write_file', args: { path: 'plain.txt', content: 'no usage here' } }],
      },
    ]);
    const { runner } = makeRunner(root, home, provider);
    const result = await runner.run({ goal: 'PARENT-NOUSAGE\ndone: file written', mode: 'auto' });
    expect(result.report.metrics.model_requests).toBe(1);
    expect('tokens_total' in result.report.metrics).toBe(false);
    expect('tokens_input' in result.report.metrics).toBe(false);
    expect('token_requests_reported' in result.report.metrics).toBe(false);
  });
});
