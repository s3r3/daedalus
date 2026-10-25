import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import {
  AgentLoop,
  BackgroundJobManager,
  EventBus,
  ExecutionHarness,
  LoopGuard,
  MAX_BACKGROUND_JOBS_PER_TASK,
  TaskRunner,
  TaskStore,
  classifyToolName,
  commandKillTool,
  commandStatusTool,
  createDefaultRegistry,
  isToolVisible,
  runCommandTool,
  toolCallPolicy,
  toolModePolicy,
  type Event,
  type LLMProvider,
  type ToolCall,
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

async function waitFor(predicate: () => boolean, timeoutMs = 8_000): Promise<void> {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) throw new Error('waitFor timed out');
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

type ScriptStep = { tool: string; args: unknown } | { text: string };

function scriptedProvider(steps: ScriptStep[]): LLMProvider {
  let index = 0;
  return {
    name: 'jobs-scripted',
    async chat() {
      const step = steps[index++];
      if (!step) return { message: { role: 'assistant' as const, content: 'done: nothing further scripted' } };
      if ('text' in step) return { message: { role: 'assistant' as const, content: step.text } };
      return {
        message: {
          role: 'assistant' as const,
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

function toolCall(tool: string, args: unknown, id = 'c1'): ToolCall {
  return { id, task_id: 't1', turn_id: 'u1', tool, args, started_at: new Date().toISOString() };
}

describe('background job lifecycle (manager + tools)', () => {
  test('start → running status → exits with code and output tail', async () => {
    const root = temp('daedalus-jobs-ws-');
    const manager = new BackgroundJobManager();
    cleanups.push(() => manager.killAll('t1'));
    const registry = createDefaultRegistry();
    const ctx = { workspaceRoot: root, jobs: manager, taskId: 't1' };

    const started = await registry.execute(toolCall('run_command', { command: 'echo', args: ['bg-hello'], background: true }), ctx);
    expect(started.status).toBe('ok');
    expect(started.meta.job_id).toBe('job-1');
    expect(started.output).toContain('started background job job-1');
    expect(started.output).toContain('command_status');

    await waitFor(() => manager.status('t1', 'job-1')?.job.state === 'exited');
    const status = await registry.execute(toolCall('command_status', { job_id: 'job-1' }), ctx);
    expect(status.status).toBe('ok');
    expect(status.meta.state).toBe('exited');
    expect(status.meta.exit_code).toBe(0);
    expect(status.output).toContain('bg-hello');
    expect(status.output).toContain('exit 0');
  });

  test('failing command lands as failed with its exit code', async () => {
    const root = temp('daedalus-jobs-fail-');
    const manager = new BackgroundJobManager();
    const registry = createDefaultRegistry();
    const ctx = { workspaceRoot: root, jobs: manager, taskId: 't1' };
    await registry.execute(toolCall('run_command', { command: 'node', args: ['-e', 'process.exit(3)'], background: true }), ctx);
    await waitFor(() => manager.status('t1', 'job-1')?.job.state === 'failed');
    const status = await registry.execute(toolCall('command_status', { job_id: 'job-1' }), ctx);
    expect(status.meta.state).toBe('failed');
    expect(status.meta.exit_code).toBe(3);
  });

  test('kill stops a mid-run job; the close settles as killed, not failed', async () => {
    const root = temp('daedalus-jobs-kill-');
    const finished: string[] = [];
    const manager = new BackgroundJobManager({ onFinish: (job) => finished.push(`${job.id}:${job.state}`) });
    cleanups.push(() => manager.killAll('t1'));
    const registry = createDefaultRegistry();
    const ctx = { workspaceRoot: root, jobs: manager, taskId: 't1' };

    await registry.execute(toolCall('run_command', { command: 'sleep', args: ['30'], background: true }), ctx);
    expect(manager.status('t1', 'job-1')?.job.state).toBe('running');
    const killed = await registry.execute(toolCall('command_kill', { job_id: 'job-1' }), ctx);
    expect(killed.status).toBe('ok');
    expect(killed.output).toContain('killed job-1');
    await waitFor(() => finished.length === 1);
    expect(finished).toEqual(['job-1:killed']);
    const status = await registry.execute(toolCall('command_status', { job_id: 'job-1' }), ctx);
    expect(status.meta.state).toBe('killed');

    // Killing the corpse is a report, not an error.
    const again = await registry.execute(toolCall('command_kill', { job_id: 'job-1' }), ctx);
    expect(again.status).toBe('ok');
    expect(again.output).toContain('already killed');
  });

  test('the per-task cap refuses a fourth concurrent job with a typed reason, and frees on kill', async () => {
    const root = temp('daedalus-jobs-cap-');
    const manager = new BackgroundJobManager();
    cleanups.push(() => manager.killAll('t1'));
    const registry = createDefaultRegistry();
    const ctx = { workspaceRoot: root, jobs: manager, taskId: 't1' };
    expect(MAX_BACKGROUND_JOBS_PER_TASK).toBe(3);
    for (let i = 0; i < 3; i++) {
      const started = await registry.execute(toolCall('run_command', { command: 'sleep', args: ['30'], background: true }, `cap-${i}`), ctx);
      expect(started.status).toBe('ok');
    }
    const fourth = await registry.execute(toolCall('run_command', { command: 'sleep', args: ['30'], background: true }, 'cap-4'), ctx);
    expect(fourth.status).toBe('error');
    expect(fourth.meta.reason).toBe('job_limit');
    expect(fourth.meta.max).toBe(3);
    manager.killAll('t1');
    const fifth = await registry.execute(toolCall('run_command', { command: 'echo', args: ['free'], background: true }, 'cap-5'), ctx);
    expect(fifth.status).toBe('ok');
    await waitFor(() => manager.status('t1', String(fifth.meta.job_id))?.job.state === 'exited');
  });

  test('jobs are scoped to their task: another task sees unknown_job', async () => {
    const root = temp('daedalus-jobs-scope-');
    const manager = new BackgroundJobManager();
    cleanups.push(() => manager.killAll('t1'));
    const registry = createDefaultRegistry();
    await registry.execute(toolCall('run_command', { command: 'sleep', args: ['30'], background: true }), { workspaceRoot: root, jobs: manager, taskId: 't1' });
    const stranger = await registry.execute(toolCall('command_status', { job_id: 'job-1' }), { workspaceRoot: root, jobs: manager, taskId: 't2' });
    expect(stranger.status).toBe('error');
    expect(stranger.meta.reason).toBe('unknown_job');
    const strangerKill = await registry.execute(toolCall('command_kill', { job_id: 'job-1' }), { workspaceRoot: root, jobs: manager, taskId: 't2' });
    expect(strangerKill.status).toBe('error');
    expect(manager.status('t1', 'job-1')?.job.state).toBe('running');
  });

  test('without a host job manager the tools refuse with jobs_unavailable', async () => {
    const root = temp('daedalus-jobs-nomanager-');
    const registry = createDefaultRegistry();
    const started = await registry.execute(toolCall('run_command', { command: 'echo', args: ['x'], background: true }), { workspaceRoot: root });
    expect(started.status).toBe('error');
    expect(started.meta.reason).toBe('jobs_unavailable');
    const status = await registry.execute(toolCall('command_status', { job_id: 'job-1' }), { workspaceRoot: root });
    expect(status.meta.reason).toBe('jobs_unavailable');
    const kill = await registry.execute(toolCall('command_kill', { job_id: 'job-1' }), { workspaceRoot: root });
    expect(kill.meta.reason).toBe('jobs_unavailable');
  });

  test('status tail is bounded and reports earlier output as dropped', async () => {
    const root = temp('daedalus-jobs-tail-');
    const manager = new BackgroundJobManager();
    cleanups.push(() => manager.killAll('t1'));
    const script = 'for (let i = 0; i < 300; i++) console.log(`line-${i}`);';
    manager.start({ taskId: 't1', command: 'node', args: ['-e', script], cwd: root });
    await waitFor(() => manager.status('t1', 'job-1')?.job.state === 'exited');
    const small = manager.status('t1', 'job-1', 100)!;
    expect(small.tail.length).toBeLessThanOrEqual(100);
    expect(small.tail).toContain('line-299');
    expect(small.outputTruncated).toBe(true);
    const status = await commandStatusTool.execute({ job_id: 'job-1', tail_chars: 100 }, { workspaceRoot: root, jobs: manager, taskId: 't1' });
    expect(status.truncated).toBe(true);
    expect(status.output).toContain('line-299');
    expect(status.output).toContain('earlier output dropped');
  });

  test('task-end drain lets a concurrently exiting job settle as exited, not killed', async () => {
    const root = temp('daedalus-jobs-drain-exit-');
    const finished: string[] = [];
    const manager = new BackgroundJobManager({ onFinish: (job) => finished.push(`${job.id}:${job.state}`) });
    const started = manager.start({ taskId: 't1', command: 'sleep', args: ['0.05'], cwd: root });
    expect(started.ok).toBe(true);
    expect(manager.status('t1', 'job-1')?.job.state).toBe('running');

    const killed = await manager.settleAndKillAll('t1', 500);

    expect(killed).toBe(0);
    expect(finished).toEqual(['job-1:exited']);
    expect(manager.status('t1', 'job-1')?.job.state).toBe('exited');
    expect(manager.status('t1', 'job-1')?.job.exitCode).toBe(0);
  });

  test('task-end drain still kills a job running after the bounded grace period', async () => {
    const root = temp('daedalus-jobs-drain-kill-');
    const finished: string[] = [];
    const manager = new BackgroundJobManager({ onFinish: (job) => finished.push(`${job.id}:${job.state}`) });
    cleanups.push(() => manager.killAll('t1'));
    const started = manager.start({ taskId: 't1', command: 'sleep', args: ['30'], cwd: root });
    expect(started.ok).toBe(true);

    const killed = await manager.settleAndKillAll('t1', 10);

    expect(killed).toBe(1);
    expect(manager.status('t1', 'job-1')?.job.state).toBe('killed');
    await waitFor(() => finished.length === 1);
    expect(finished).toEqual(['job-1:killed']);
  });

  test('the allowlist still gates background starts', async () => {
    const root = temp('daedalus-jobs-allowlist-');
    const manager = new BackgroundJobManager();
    const registry = createDefaultRegistry();
    const denied = await registry.execute(toolCall('run_command', { command: 'sudo', args: ['ls'], background: true }), { workspaceRoot: root, jobs: manager, taskId: 't1' });
    expect(denied.status).toBe('denied');
    expect(manager.list('t1')).toEqual([]);
  });
});

describe('background jobs through the harness', () => {
  test('a background start returns immediately — the harness does not wait out the process', async () => {
    const root = temp('daedalus-jobs-harness-');
    const manager = new BackgroundJobManager();
    cleanups.push(() => manager.killAll('t1'));
    const harness = new ExecutionHarness({ defaultApprovalPolicy: 'auto' }, { bus: new EventBus(), store: new TaskStore(join(root, '.daedalus')) });
    const startedAt = Date.now();
    const result = await harness.execute(toolCall('run_command', { command: 'sleep', args: ['5'], background: true }), runCommandTool, { workspaceRoot: root, taskId: 't1', jobs: manager });
    expect(Date.now() - startedAt).toBeLessThan(3_000);
    expect(result.status).toBe('ok');
    expect(result.meta.job_id).toBe('job-1');
    expect(manager.status('t1', 'job-1')?.job.state).toBe('running');
  });
});

describe('background job mode policy', () => {
  test('classification mirrors run_command: status is read, kill is execution', () => {
    expect(classifyToolName('command_status')).toBe('read');
    expect(classifyToolName('command_kill')).toBe('executing');
    // Visible where jobs can exist and in read-only modes (status only).
    expect(isToolVisible('ask', 'command_status')).toBe(true);
    expect(isToolVisible('ask', 'command_kill')).toBe(false);
    expect(isToolVisible('plan', 'command_kill')).toBe(false);
    expect(toolCallPolicy('ask', 'command_kill').approval).toBe('deny');
    expect(toolCallPolicy('plan', 'command_kill').approval).toBe('deny');
    // Manual approval-gates the kill like any execution; status is free.
    expect(toolModePolicy('manual', 'command_kill').approval).toBe('ask');
    expect(toolModePolicy('manual', 'command_status').approval).toBe('auto');
    // Auto: execution asks unless auto-approve, exactly like run_command.
    expect(toolModePolicy('auto', 'command_kill').approval).toBe('ask');
    expect(toolModePolicy('auto', 'command_kill', true).approval).toBe('auto');
    expect(toolModePolicy('auto', 'command_status').approval).toBe('auto');
  });

  test('ask mode denies background start and kill at the loop gate; status runs', async () => {
    const root = temp('daedalus-jobs-ask-');
    const manager = new BackgroundJobManager();
    cleanups.push(() => manager.killAll('t1'));
    // A live job for this task (started host-side): command_status can
    // report it even in read-only Ask mode.
    manager.start({ taskId: 't1', command: 'sleep', args: ['5'], cwd: root });
    const registry = createDefaultRegistry();
    const bus = new EventBus();
    const finishedTools: Array<{ tool: string; status: string; reason?: string }> = [];
    bus.on('*', (event) => {
      if (event.type !== 'TOOL_CALL_FINISHED') return;
      const payload = event.payload as { call?: { tool?: string }; result?: { status?: string; meta?: { reason?: string } } };
      finishedTools.push({ tool: payload.call?.tool ?? '?', status: payload.result?.status ?? '?', reason: payload.result?.meta?.reason });
    });
    const loop = new AgentLoop({
      provider: scriptedProvider([
        { tool: 'run_command', args: { command: 'echo', args: ['x'], background: true } },
        { tool: 'command_kill', args: { job_id: 'job-1' } },
        { tool: 'command_status', args: { job_id: 'job-1' } },
      ]),
      bus,
      store: new TaskStore(join(root, '.daedalus-tasks')),
      stopPolicy: { max_iterations: 12, max_errors: 5 },
      mode: 'ask',
      executeTool: (call) => registry.execute(call, { workspaceRoot: root, jobs: manager, taskId: 't1' }),
    });
    const state = await loop.run('what jobs are running?\ndone: check the running job');
    expect(state.status).toBe('done');
    expect(finishedTools).toEqual([
      { tool: 'run_command', status: 'denied', reason: 'mode_policy' },
      { tool: 'command_kill', status: 'denied', reason: 'mode_policy' },
      { tool: 'command_status', status: 'ok', reason: undefined },
    ]);
    // The denied start created nothing and the denied kill left job-1 alone.
    expect(manager.list('t1').map((job) => job.id)).toEqual(['job-1']);
  });
});

describe('loop guard polling exemption', () => {
  test('repeated command_status polls always execute; other tools still warn', () => {
    const guard = new LoopGuard();
    for (let i = 0; i < 6; i++) {
      expect(guard.observe('command_status', { job_id: 'job-1' }).decision).toBe('execute');
    }
    // The guard itself is unchanged elsewhere: identical kill calls warn.
    expect(guard.observe('command_kill', { job_id: 'job-1' }).decision).toBe('execute');
    expect(guard.observe('command_kill', { job_id: 'job-1' }).decision).toBe('execute');
    expect(guard.observe('command_kill', { job_id: 'job-1' }).decision).toBe('warn');
  });
});

describe('background jobs end to end (TaskRunner)', () => {
  test('JOB_STARTED/JOB_FINISHED events bracket streamed job output; no foreground command lifecycle', async () => {
    const root = temp('daedalus-jobs-e2e-');
    const home = temp('daedalus-jobs-e2e-home-');
    const provider = scriptedProvider([
      { tool: 'run_command', args: { command: 'echo', args: ['bg-events'], background: true } },
      { tool: 'command_status', args: { job_id: 'job-1' } },
      { text: 'done: background echo ran' },
    ]);
    const runner = new TaskRunner({
      workspaceRoot: root,
      store: new TaskStore(home),
      bus: new EventBus(),
      provider,
      validator: passingValidator,
      approvalPolicy: 'auto',
      maxIterations: 12,
    });
    const result = await runner.run({ goal: 'run an echo in the background and check it' });
    const started = result.events.find((event) => event.type === 'JOB_STARTED');
    expect(started).toBeDefined();
    expect((started!.payload as { job_id?: string }).job_id).toBe('job-1');
    expect((started!.payload as { command?: string }).command).toContain('echo bg-events');
    const output = result.events.find((event) => event.type === 'COMMAND_OUTPUT' && (event.payload as { job_id?: string }).job_id === 'job-1');
    expect(output).toBeDefined();
    expect((output!.payload as { chunk?: string }).chunk).toContain('bg-events');
    await waitFor(() => result.events.some((event) => event.type === 'JOB_FINISHED'));
    const finished = result.events.find((event) => event.type === 'JOB_FINISHED')!;
    expect((finished.payload as { state?: string }).state).toBe('exited');
    expect((finished.payload as { exit_code?: number }).exit_code).toBe(0);
    // No foreground brackets for the background start.
    expect(result.events.some((event) => event.type === 'COMMAND_STARTED')).toBe(false);
  });

  test('task end kills a still-running background job', async () => {
    const root = temp('daedalus-jobs-taskend-');
    const home = temp('daedalus-jobs-taskend-home-');
    const bus = new EventBus();
    const live: Event[] = [];
    bus.on('*', (event) => live.push(event));
    const provider = scriptedProvider([
      { tool: 'run_command', args: { command: 'sleep', args: ['30'], background: true } },
      { text: 'done: started the sleeper' },
    ]);
    const runner = new TaskRunner({
      workspaceRoot: root,
      store: new TaskStore(home),
      bus,
      provider,
      validator: passingValidator,
      approvalPolicy: 'auto',
      maxIterations: 12,
    });
    await runner.run({ goal: 'start a long sleeper in the background' });
    await waitFor(() => live.some((event) => event.type === 'JOB_FINISHED'));
    const finished = live.find((event) => event.type === 'JOB_FINISHED')!;
    expect((finished.payload as { state?: string }).state).toBe('killed');
    expect((finished.payload as { killed?: boolean }).killed).toBe(true);
  });

  test('task Stop (cancel) kills running background jobs', async () => {
    const root = temp('daedalus-jobs-cancel-');
    const home = temp('daedalus-jobs-cancel-home-');
    const bus = new EventBus();
    const live: Event[] = [];
    bus.on('*', (event) => live.push(event));
    const provider: LLMProvider = {
      name: 'jobs-cancel',
      async chat() {
        if (live.some((event) => event.type === 'JOB_STARTED')) {
          return { message: { role: 'assistant' as const, content: 'done: nothing more' } };
        }
        return {
          message: {
            role: 'assistant' as const,
            content: '',
            tool_calls: [{ id: 'call-bg', type: 'function' as const, function: { name: 'run_command', arguments: JSON.stringify({ command: 'sleep', args: ['30'], background: true }) } }],
          },
        };
      },
      async *stream() {
        yield { type: 'delta', content: '' };
      },
    };
    const runner = new TaskRunner({
      workspaceRoot: root,
      store: new TaskStore(home),
      bus,
      provider,
      validator: passingValidator,
      approvalPolicy: 'auto',
      maxIterations: 12,
    });
    const running = runner.run({ goal: 'start a long sleeper in the background' });
    await waitFor(() => live.some((event) => event.type === 'JOB_STARTED'));
    const taskId = live.find((event) => event.type === 'JOB_STARTED')!.task_id;
    runner.cancel(taskId);
    await running.catch(() => undefined);
    await waitFor(() => live.some((event) => event.type === 'JOB_FINISHED'));
    const finished = live.find((event) => event.type === 'JOB_FINISHED')!;
    expect((finished.payload as { state?: string }).state).toBe('killed');
  });
});
