import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import {
  AgentLoop,
  ApprovalBroker,
  DefaultContextManager,
  EventBus,
  ExecutionHarness,
  MODE_PERMISSION_MATRIX,
  OrchestratorRunner,
  TaskRunner,
  TaskStore,
  createDefaultRegistry,
  modePromptContract,
  restrictMode,
  runCommandTool,
  writeFileTool,
  type ApprovalRequestInfo,
  type Event,
  type LLMProvider,
  type Message,
} from '../src/index.ts';

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

function scriptedProvider(script: ScriptStep[], captured?: Message[][]): LLMProvider {
  let index = 0;
  return {
    name: 'scripted',
    async chat(messages) {
      captured?.push(messages);
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

function approvalInfo(overrides: Partial<ApprovalRequestInfo> = {}): ApprovalRequestInfo {
  return {
    id: `approval-${Math.random().toString(36).slice(2, 9)}`,
    key: { taskId: 'task-1', tool: 'run_command', action: 'execute' },
    policy: 'ask',
    tool: 'run_command',
    preview: { kind: 'command', command: 'npm test' },
    rememberPattern: { kind: 'command-prefix', tool: 'run_command', token: 'npm', label: 'run_command starting with "npm"' },
    requestedBy: { taskId: 'task-1' },
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

describe('mode matrix data', () => {
  test('restrictMode lets children tighten but never loosen the parent ceiling', () => {
    expect(restrictMode('manual', 'auto')).toBe('manual');
    expect(restrictMode('auto', 'manual')).toBe('manual');
    expect(restrictMode('orchestrator', 'auto')).toBe('auto');
    expect(restrictMode('auto', 'ask')).toBe('ask');
    expect(restrictMode('plan', 'manual')).toBe('plan');
    expect(restrictMode('auto', 'auto')).toBe('auto');
  });

  test('the matrix keeps reads free everywhere and denies mutations in read-only modes', () => {
    for (const mode of ['ask', 'manual', 'auto', 'plan', 'orchestrator'] as const) {
      expect(MODE_PERMISSION_MATRIX[mode].read).toBe('allow');
    }
    expect(MODE_PERMISSION_MATRIX.ask.mutating).toBe('deny');
    expect(MODE_PERMISSION_MATRIX.plan.executing).toBe('deny');
    expect(MODE_PERMISSION_MATRIX.manual.mutating).toBe('ask');
    expect(MODE_PERMISSION_MATRIX.auto.mutating).toBe('allow');
    expect(MODE_PERMISSION_MATRIX.auto.executing).toBe('ask');
  });

  test('each mode states a distinct behavioural contract for the prompt', () => {
    expect(modePromptContract('ask')).toContain('Ask (read-only)');
    expect(modePromptContract('plan')).toContain('numbered plan');
    expect(modePromptContract('plan')).toContain('concrete file');
    expect(modePromptContract('manual')).toContain('approval');
    expect(modePromptContract('auto')).toContain('Auto');
  });

  test('the plan contract reaches the model system prompt', async () => {
    const context = new DefaultContextManager({ workspaceRoot: temp('daedalus-ctx-ws-') });
    const messages = await context.buildMessages(
      {
        id: 't-plan', goal: 'plan it', repo_path: '/tmp', constraints: [], done_criteria: [], created_at: new Date().toISOString(),
        mode: 'plan', plan: { id: 'p', task_id: 't-plan', steps: [], version: 1, status: 'active' }, steps: [], status: 'active',
      },
      [],
      undefined,
    );
    expect(JSON.stringify(messages[0])).toContain('Plan (read-only)');
  });
});

describe('mode gates at the loop', () => {
  test('Plan mode offers no mutating tools and denies a fabricated write, naming the mode', async () => {
    const root = temp('daedalus-plan-ws-');
    const home = temp('daedalus-plan-home-');
    writeFileSync(join(root, 'a.txt'), 'hello');
    const offered: string[][] = [];
    let calls = 0;
    const provider: LLMProvider = {
      name: 'scripted',
      async chat(_messages, tools) {
        calls++;
        offered.push((tools ?? []).map((tool) => tool.function.name));
        if (calls === 1) {
          return {
            message: {
              role: 'assistant',
              content: '',
              tool_calls: [{ id: 'c1', type: 'function' as const, function: { name: 'write_file', arguments: JSON.stringify({ path: 'blocked.txt', content: 'no' }) } }],
            },
          };
        }
        return { message: { role: 'assistant', content: 'done: plan drafted' } };
      },
      async *stream() {},
    };
    const store = new TaskStore(home);
    const loop = new AgentLoop({
      provider,
      bus: new EventBus(),
      store,
      tools: createDefaultRegistry().schemas(),
      mode: 'plan',
      stopPolicy: { max_iterations: 4, max_errors: 3 },
      executeTool: async (call) => createDefaultRegistry().execute(call, { workspaceRoot: root }),
    });
    const state = await loop.run('Draft a plan\ndone: plan drafted');
    expect(offered[0]).toContain('read_file');
    expect(offered[0]).not.toContain('write_file');
    expect(offered[0]).not.toContain('run_command');
    expect(existsSync(join(root, 'blocked.txt'))).toBe(false);
    const events = store.replay(state.id);
    const finished = events.find((event) => event.type === 'TOOL_CALL_FINISHED');
    const result = (finished?.payload as { result?: { status: string; output: string } }).result;
    expect(result?.status).toBe('denied');
    expect(result?.output).toContain('plan mode');
    const planCreated = events.find((event) => event.type === 'PLAN_CREATED');
    expect((planCreated?.payload as { mode?: string }).mode).toBe('plan');
  });
});

describe('approval decisions through the runner', () => {
  test('a decline note is delivered verbatim to the model as the tool result', async () => {
    const root = temp('daedalus-decline-ws-');
    const home = temp('daedalus-decline-home-');
    const captured: Message[][] = [];
    const runner = new TaskRunner({
      workspaceRoot: root,
      store: new TaskStore(home),
      bus: new EventBus(),
      provider: scriptedProvider([{ tool: 'write_file', args: { path: 'a.txt', content: 'x' } }, { text: 'done: noted' }], captured),
      validator: passingValidator,
      approvalPolicy: 'ask',
      maxIterations: 4,
    });
    const result = await runner.run({
      goal: 'Write a file\ndone: file written',
      mode: 'manual',
      onEvent: (event) => {
        if (event.type !== 'APPROVAL_REQUESTED') return;
        const info = (event.payload as { approval?: ApprovalRequestInfo }).approval;
        if (info) setTimeout(() => runner.approvals.decideById(info.id, { decision: 'deny', note: 'declined-note-marker: use alt.txt instead' }), 5);
      },
    });
    expect(existsSync(join(root, 'a.txt'))).toBe(false);
    const secondCall = JSON.stringify(captured[1] ?? []);
    expect(secondCall).toContain('declined-note-marker: use alt.txt instead');
    const decided = result.events.find((event) => event.type === 'APPROVAL_DECIDED');
    expect((decided?.payload as { note?: string }).note).toContain('declined-note-marker');
  });

  test('an unanswered approval times out as a decline, never an allow', async () => {
    const root = temp('daedalus-timeout-ws-');
    const home = temp('daedalus-timeout-home-');
    const runner = new TaskRunner({
      workspaceRoot: root,
      store: new TaskStore(home),
      bus: new EventBus(),
      provider: scriptedProvider([{ tool: 'write_file', args: { path: 'slow.txt', content: 'x' } }]),
      validator: passingValidator,
      approvalPolicy: 'ask',
      approvalTimeoutMs: 30,
      maxIterations: 3,
    });
    const result = await runner.run({ goal: 'Write a file\ndone: file written', mode: 'manual' });
    expect(existsSync(join(root, 'slow.txt'))).toBe(false);
    const decided = result.events.find((event) => event.type === 'APPROVAL_DECIDED');
    expect((decided?.payload as { timed_out?: boolean }).timed_out).toBe(true);
    const finished = result.events.find((event) => event.type === 'TOOL_CALL_FINISHED');
    expect((finished?.payload as { result?: { output: string } }).result?.output).toContain('approval timed out');
  });

  test('remember: a second write to the same path does not prompt again', async () => {
    const root = temp('daedalus-remember-ws-');
    const home = temp('daedalus-remember-home-');
    const runner = new TaskRunner({
      workspaceRoot: root,
      store: new TaskStore(home),
      bus: new EventBus(),
      provider: scriptedProvider([
        { tool: 'write_file', args: { path: 'same.txt', content: '1' } },
        { tool: 'write_file', args: { path: 'same.txt', content: '2' } },
        { text: 'done: written twice' },
      ]),
      validator: passingValidator,
      approvalPolicy: 'ask',
      maxIterations: 5,
    });
    let requests = 0;
    const result = await runner.run({
      goal: 'Write twice\ndone: first write landed\ndone: second write landed',
      mode: 'manual',
      onEvent: (event) => {
        if (event.type !== 'APPROVAL_REQUESTED') return;
        requests++;
        const info = (event.payload as { approval?: ApprovalRequestInfo }).approval;
        if (info) setTimeout(() => runner.approvals.decideById(info.id, { decision: 'grant', remember: true }), 5);
      },
    });
    expect(requests).toBe(1);
    expect(readFileSync(join(root, 'same.txt'), 'utf8')).toBe('2');
    expect(result.state.status).toBe('done');
  });

  test('remember: a second command with the same first token does not prompt again', async () => {
    const root = temp('daedalus-remember-cmd-ws-');
    const home = temp('daedalus-remember-cmd-home-');
    const runner = new TaskRunner({
      workspaceRoot: root,
      store: new TaskStore(home),
      bus: new EventBus(),
      provider: scriptedProvider([
        { tool: 'run_command', args: { command: 'echo', args: ['first'] } },
        { tool: 'run_command', args: { command: 'echo', args: ['second'] } },
        { text: 'done: commands ran' },
      ]),
      validator: passingValidator,
      approvalPolicy: 'ask',
      maxIterations: 5,
    });
    let requests = 0;
    await runner.run({
      goal: 'Run commands\ndone: first command ran\ndone: second command ran',
      mode: 'auto',
      onEvent: (event) => {
        if (event.type !== 'APPROVAL_REQUESTED') return;
        requests++;
        const info = (event.payload as { approval?: ApprovalRequestInfo }).approval;
        expect(info?.preview).toMatchObject({ kind: 'command' });
        if (info) setTimeout(() => runner.approvals.decideById(info.id, { decision: 'grant', remember: true }), 5);
      },
    });
    expect(requests).toBe(1);
  });

  test('auto mode edits freely but still asks before a command when auto-approve is off', async () => {
    const root = temp('daedalus-auto-matrix-ws-');
    const home = temp('daedalus-auto-matrix-home-');
    const runner = new TaskRunner({
      workspaceRoot: root,
      store: new TaskStore(home),
      bus: new EventBus(),
      provider: scriptedProvider([
        { tool: 'write_file', args: { path: 'free.txt', content: 'edit' } },
        { tool: 'run_command', args: { command: 'echo', args: ['gated'] } },
        { text: 'done: all done' },
      ]),
      validator: passingValidator,
      maxIterations: 5,
    });
    const requestedTools: string[] = [];
    const result = await runner.run({
      goal: 'Edit then run\ndone: file edited\ndone: command ran',
      mode: 'auto',
      onEvent: (event) => {
        if (event.type !== 'APPROVAL_REQUESTED') return;
        const info = (event.payload as { approval?: ApprovalRequestInfo }).approval;
        if (info) {
          requestedTools.push(info.tool);
          setTimeout(() => runner.approvals.decideById(info.id, { decision: 'grant' }), 5);
        }
      },
    });
    expect(requestedTools).toEqual(['run_command']);
    expect(readFileSync(join(root, 'free.txt'), 'utf8')).toBe('edit');
    expect(result.state.status).toBe('done');
  });

  test('a plan-mode task hands its recorded steps to the executing task (plan continuity)', async () => {
    const root = temp('daedalus-continuity-ws-');
    const home = temp('daedalus-continuity-home-');
    const store = new TaskStore(home);
    store.saveState('plan-task-1', {
      id: 'plan-task-1',
      goal: 'plan the health endpoint',
      repo_path: root,
      constraints: [],
      done_criteria: [],
      created_at: new Date().toISOString(),
      mode: 'plan',
      status: 'done',
      plan: {
        id: 'p1', task_id: 'plan-task-1', version: 1, status: 'complete',
        steps: [{ id: 's1', intent: 'Create src/health.ts with a GET handler', status: 'done', evidence: [] }],
      },
      steps: [{ id: 's1', intent: 'Create src/health.ts with a GET handler', status: 'done', evidence: [] }],
    });
    const captured: Message[][] = [];
    const runner = new TaskRunner({
      workspaceRoot: root,
      store,
      bus: new EventBus(),
      provider: scriptedProvider([{ text: 'done: executed' }], captured),
      validator: passingValidator,
      maxIterations: 3,
    });
    await runner.run({ goal: 'jalankan rencananya', mode: 'auto', planTaskId: 'plan-task-1' });
    expect(JSON.stringify(captured[0] ?? [])).toContain('Create src/health.ts with a GET handler');
  });
});

describe('ApprovalBroker', () => {
  test('timeout settles a request as a decline with outcome timeout', async () => {
    const broker = new ApprovalBroker({ timeoutMs: 25 });
    const result = await broker.request(approvalInfo());
    expect(result).toMatchObject({ decision: 'deny', outcome: 'timeout' });
    expect(broker.pending()).toHaveLength(0);
  });

  test('cancelling the task settles its pending requests as declines', async () => {
    const broker = new ApprovalBroker({ timeoutMs: 60_000 });
    const pending = broker.request(approvalInfo());
    expect(broker.cancelTasks(['task-1'])).toBe(1);
    await expect(pending).resolves.toMatchObject({ decision: 'deny', outcome: 'cancelled' });
  });

  test('a remembered grant answers queued requests with the same pattern', async () => {
    const broker = new ApprovalBroker({ timeoutMs: 60_000 });
    const first = broker.request(approvalInfo({ id: 'a1' }));
    const second = broker.request(approvalInfo({ id: 'a2' }));
    expect(broker.pending()).toHaveLength(2);
    expect(broker.decideById('a1', { decision: 'grant', remember: true })).toBe(true);
    await expect(first).resolves.toMatchObject({ decision: 'grant' });
    await expect(second).resolves.toMatchObject({ decision: 'grant', viaRemember: true });
    expect(broker.pending()).toHaveLength(0);
  });

  test('decideById reports unknown approvals honestly', () => {
    const broker = new ApprovalBroker();
    expect(broker.decideById('missing', { decision: 'grant' })).toBe(false);
    expect(broker.hasPending('missing')).toBe(false);
  });
});

describe('ExecutionHarness approval details', () => {
  test('edit & allow runs the edited command, not the proposed one', async () => {
    const root = temp('daedalus-edit-allow-ws-');
    const harness = new ExecutionHarness({ defaultApprovalPolicy: 'ask' }, { bus: new EventBus(), store: new TaskStore(temp('daedalus-edit-allow-home-')) });
    harness.setApprovalCallback(async () => ({ decision: 'grant', editedArgs: { command: 'echo', args: ['edited-marker'] } }));
    const result = await harness.execute(
      { id: 'c1', task_id: 't1', turn_id: 'u1', tool: 'run_command', args: { command: 'echo', args: ['original-marker'] }, started_at: new Date().toISOString() },
      runCommandTool,
      { workspaceRoot: root, taskId: 't1' },
    );
    expect(result.status).toBe('ok');
    expect(result.output).toContain('edited-marker');
  });

  test('the request carries the verbatim command and the remember pattern label', async () => {
    const root = temp('daedalus-preview-ws-');
    let seen: ApprovalRequestInfo | undefined;
    const harness = new ExecutionHarness({ defaultApprovalPolicy: 'ask' }, { bus: new EventBus(), store: new TaskStore(temp('daedalus-preview-home-')) });
    harness.setApprovalCallback(async (info) => { seen = info; return { decision: 'deny' }; });
    await harness.execute(
      { id: 'c1', task_id: 't1', turn_id: 'u1', tool: 'run_command', args: { command: 'npm', args: ['run', 'build'] }, started_at: new Date().toISOString() },
      runCommandTool,
      { workspaceRoot: root, taskId: 't1' },
    );
    expect(seen?.preview).toEqual({ kind: 'command', command: 'npm run build' });
    expect(seen?.rememberPattern).toMatchObject({ kind: 'command-prefix', token: 'npm', label: 'run_command starting with "npm"' });
    expect(seen?.requestedBy.taskId).toBe('t1');
  });

  test('a write preview carries the full new content for the card diff view', async () => {
    const root = temp('daedalus-write-preview-ws-');
    let seen: ApprovalRequestInfo | undefined;
    const harness = new ExecutionHarness({ defaultApprovalPolicy: 'ask' }, { bus: new EventBus(), store: new TaskStore(temp('daedalus-write-preview-home-')) });
    harness.setApprovalCallback(async (info) => { seen = info; return { decision: 'deny', note: 'nope-marker' }; });
    const result = await harness.execute(
      { id: 'c1', task_id: 't1', turn_id: 'u1', tool: 'write_file', args: { path: 'draft.txt', content: 'the whole draft body' }, started_at: new Date().toISOString() },
      writeFileTool,
      { workspaceRoot: root, taskId: 't1' },
    );
    expect(seen?.preview).toEqual({ kind: 'write', path: 'draft.txt', content: 'the whole draft body' });
    expect(result.status).toBe('denied');
    expect(result.output).toBe('nope-marker');
  });
});

describe('orchestrator inheritance', () => {
  test('a manual child still asks even when the parent session auto-approves, and the parent log shows the card', async () => {
    const root = temp('daedalus-child-approval-ws-');
    const home = temp('daedalus-child-approval-home-');
    const runner = new TaskRunner({
      workspaceRoot: root,
      store: new TaskStore(home),
      bus: new EventBus(),
      provider: scriptedProvider([
        { tool: 'write_file', args: { path: 'child.txt', content: 'by child' } },
        { text: 'done: child file written' },
      ]),
      validator: passingValidator,
      approvalPolicy: 'auto',
      maxIterations: 6,
    });
    let parentTaskId = '';
    const result = await runner.run({
      goal: 'Coordinate\ndone: child file written',
      mode: 'orchestrator',
      autoApprove: true,
      children: [{ goal: 'Write the child file\ndone: child file written', mode: 'manual' }],
      onEvent: (event) => {
        if (event.type !== 'APPROVAL_REQUESTED') return;
        const info = (event.payload as { approval?: ApprovalRequestInfo }).approval;
        if (info) setTimeout(() => runner.approvals.decideById(info.id, { decision: 'grant' }), 5);
      },
    });
    parentTaskId = result.state.id;
    expect(readFileSync(join(root, 'child.txt'), 'utf8')).toBe('by child');
    const childStarted = result.events.find((event) => event.type === 'CHILD_TASK_STARTED');
    const childId = (childStarted?.payload as { child?: { id: string } }).child?.id;
    expect(childId).toBeTruthy();
    // The request is mirrored onto the parent's log, stamped with the child.
    const mirrored = result.events.find(
      (event) => event.type === 'APPROVAL_REQUESTED' && event.task_id === parentTaskId,
    );
    const info = (mirrored?.payload as { approval?: ApprovalRequestInfo }).approval;
    expect(info?.requestedBy.taskId).toBe(childId);
    expect(info?.requestedBy.parentTaskId).toBe(parentTaskId);
    expect(info?.mode).toBe('manual');
    expect(result.state.status).toBe('done');
  });

  test('a child asking for orchestrator is clamped to auto (no nesting)', async () => {
    const root = temp('daedalus-child-clamp-ws-');
    const home = temp('daedalus-child-clamp-home-');
    writeFileSync(join(root, 'a.txt'), 'hello');
    const store = new TaskStore(home);
    const runner = new TaskRunner({
      workspaceRoot: root,
      store,
      bus: new EventBus(),
      provider: scriptedProvider([{ tool: 'read_file', args: { path: 'a.txt' } }]),
      validator: passingValidator,
      approvalPolicy: 'auto',
      maxIterations: 6,
    });
    const result = await runner.run({
      goal: 'Coordinate\ndone: child read the file',
      mode: 'orchestrator',
      children: [{ goal: 'Read the file\ndone: child read the file', mode: 'orchestrator', budget: { max_iterations: 3, max_errors: 2 } }],
    });
    const childStarted = result.events.find((event) => event.type === 'CHILD_TASK_STARTED');
    const childId = (childStarted?.payload as { child?: { id: string } }).child?.id as string;
    const childState = store.loadState<{ mode?: string }>(childId);
    expect(childState?.mode).toBe('auto');
  });

  test('budget exhaustion cancels remaining children with a typed budget_exceeded reason', async () => {
    const orchestrator = new OrchestratorRunner({
      executeChild: async () => ({ status: 'done', summary: 'did some work', iterations: 5, errors: 0 }),
      totalBudget: { max_iterations: 4, max_errors: 10 },
    });
    const result = await orchestrator.run('parent-budget', [{ goal: 'one' }, { goal: 'two' }, { goal: 'three' }]);
    expect(result.budget_exceeded).toBe(true);
    expect(result.children.map((child) => child.status)).toEqual(['done', 'cancelled', 'cancelled']);
    expect(result.children[1]?.error_reason).toBe('budget_exceeded');
    expect(result.children[2]?.error_reason).toBe('budget_exceeded');
  });

  test('no-progress cancellation is typed as no_progress, not a generic cancel', async () => {
    const orchestrator = new OrchestratorRunner({
      executeChild: async () => ({ status: 'done', summary: 'same result', diff: '' }),
    });
    const result = await orchestrator.run('parent-np', [{ goal: 'same' }, { goal: 'same' }, { goal: 'same' }]);
    expect(result.no_progress).toBe(true);
    expect(result.children[2]?.error_reason).toBe('no_progress');
  });
});
