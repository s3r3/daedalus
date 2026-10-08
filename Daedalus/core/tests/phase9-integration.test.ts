import { afterEach, describe, expect, test } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  DEFAULT_TOOLS,
  EventBus,
  ExecutionHarness,
  LLMContentPolicyError,
  LLMRateLimitError,
  LLMTimeoutError,
  OpenAICompatProvider,
  TaskStore,
  TaskRunner,
  createDefaultRegistry,
  runCommandTool,
  type Event,
  type LLMProvider,
  type ToolCall,
  type ValidationResult,
  type Validator,
} from '../src/index.ts';

const dirs: string[] = [];

function temp(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function passResult(): ValidationResult {
  return { checks: [{ name: 'fixture', cmd: 'node validate.js', status: 'pass', exit_code: 0, summary: 'passed', diagnostics: [] }] };
}

function failResult(summary = 'value is broken'): ValidationResult {
  return { checks: [{ name: 'fixture', cmd: 'node validate.js', status: 'fail', exit_code: 1, summary, diagnostics: [{ message: summary }] }] };
}

const passingValidator: Validator = { async validate() { return passResult(); } };

function scriptedProvider(script: Array<{ tool: string; args: unknown }>): LLMProvider {
  let index = 0;
  return {
    name: 'phase9-scripted',
    async chat() {
      const step = script[index++];
      if (!step) return { message: { role: 'assistant', content: 'done: work complete' } };
      return {
        message: {
          role: 'assistant',
          content: '',
          tool_calls: [{ id: `call-${index}`, type: 'function' as const, function: { name: step.tool, arguments: JSON.stringify(step.args) } }],
        },
      };
    },
    async *stream() { yield { type: 'delta', content: '' }; },
  };
}

function makeRunner(options: {
  workspace: string;
  home: string;
  provider: LLMProvider;
  validator?: Validator;
  maxIterations?: number;
  maxErrors?: number;
  approvalPolicy?: 'auto' | 'ask' | 'deny';
}) {
  const store = new TaskStore(options.home);
  const bus = new EventBus();
  const runner = new TaskRunner({
    workspaceRoot: options.workspace,
    store,
    bus,
    provider: options.provider,
    validator: options.validator ?? passingValidator,
    approvalPolicy: options.approvalPolicy ?? 'auto',
    maxIterations: options.maxIterations ?? 10,
  });
  return { runner, store, bus };
}

function eventTypes(events: Event[]): string[] {
  return events.map((event) => event.type);
}

describe('Phase 9 — end-to-end workflow and replay', () => {
  test('fixture workflow goes plan → tools → validation → report and replays without a provider', async () => {
    const workspace = temp('daedalus-p9-ws-');
    const home = temp('daedalus-p9-home-');
    const { runner, store } = makeRunner({
      workspace,
      home,
      provider: scriptedProvider([
        { tool: 'create_dir', args: { path: 'app/src' } },
        { tool: 'write_file', args: { path: 'app/src/index.txt', content: 'hello phase 9\n' } },
      ]),
    });

    const result = await runner.run({ goal: 'Create the app\n\ndone: app/src directory exists\ndone: app/src/index.txt exists' });
    expect(result.state.status).toBe('done');
    expect(result.outcome).toBe('success');
    expect(readFileSync(join(workspace, 'app/src/index.txt'), 'utf8')).toBe('hello phase 9\n');
    expect(eventTypes(result.events)).toEqual(expect.arrayContaining([
      'TASK_STARTED', 'PLAN_CREATED', 'MODEL_REQUEST_STARTED', 'TOOL_CALL_STARTED', 'FILE_CHANGED', 'VALIDATION_STARTED', 'VALIDATION_PASSED', 'TASK_COMPLETED',
    ]));
    expect(result.report.metrics).toMatchObject({ tool_calls: 2, checks_passed: 1, files_changed: 1 });
    expect(store.loadReport(result.state.id)).toEqual(result.report);

    // Replay is a read of the append-only log + persisted report; no provider
    // is constructed for this second pass.
    const replayStore = new TaskStore(home);
    const replayed = replayStore.replay(result.state.id);
    expect(eventTypes(replayed)).toEqual(eventTypes(result.events));
    expect(replayed.at(-1)?.payload).toMatchObject({ outcome: 'success' });
    expect(replayStore.loadReport(result.state.id)).toMatchObject({ outcome: 'success', metrics: { tool_calls: 2 } });
  });
});

describe('Phase 9 — validation failure, recovery, and limits', () => {
  test('a failing validation reopens the step, the provider fixes it, and validation passes', async () => {
    const workspace = temp('daedalus-p9-recover-ws-');
    const home = temp('daedalus-p9-recover-home-');
    writeFileSync(join(workspace, 'value.txt'), 'broken');
    const validator: Validator = {
      async validate({ workspaceRoot }) {
        return readFileSync(join(workspaceRoot, 'value.txt'), 'utf8') === 'fixed' ? passResult() : failResult();
      },
    };
    const { runner } = makeRunner({
      workspace,
      home,
      validator,
      provider: scriptedProvider([
        { tool: 'write_file', args: { path: 'value.txt', content: 'broken' } },
        { tool: 'write_file', args: { path: 'value.txt', content: 'fixed' } },
      ]),
    });

    const result = await runner.run({ goal: 'Fix the value\ndone: value.txt contains fixed' });
    const types = eventTypes(result.events);
    expect(result.state.status).toBe('done');
    expect(result.outcome).toBe('success');
    expect(types.indexOf('VALIDATION_FAILED')).toBeGreaterThan(-1);
    expect(types.indexOf('RECOVERY_STARTED')).toBeGreaterThan(types.indexOf('VALIDATION_FAILED'));
    expect(types.lastIndexOf('VALIDATION_PASSED')).toBeGreaterThan(types.indexOf('RECOVERY_STARTED'));
    expect(readFileSync(join(workspace, 'value.txt'), 'utf8')).toBe('fixed');
  });

  test('repeated validation failures stop as partial after the bounded recovery limit', async () => {
    const workspace = temp('daedalus-p9-vlimit-ws-');
    const home = temp('daedalus-p9-vlimit-home-');
    const alwaysFail: Validator = { async validate() { return failResult('still broken'); } };
    const { runner } = makeRunner({
      workspace,
      home,
      validator: alwaysFail,
      provider: scriptedProvider([
        { tool: 'write_file', args: { path: 'value.txt', content: 'try-1' } },
        { tool: 'write_file', args: { path: 'value.txt', content: 'try-2' } },
        { tool: 'write_file', args: { path: 'value.txt', content: 'try-3' } },
      ]),
    });

    const result = await runner.run({ goal: 'Fix the value\ndone: value.txt contains fixed' });
    expect(result.outcome).toBe('partial');
    expect(result.events.filter((event) => event.type === 'VALIDATION_FAILED')).toHaveLength(3);
    expect(result.events.filter((event) => event.type === 'RECOVERY_STARTED')).toHaveLength(3);
    expect(result.events.at(-1)?.payload).toMatchObject({ outcome: 'partial', reason: 'validation_failed' });
  });

  test('a provider replan is recorded and the amended plan can complete', async () => {
    const workspace = temp('daedalus-p9-replan-ws-');
    const home = temp('daedalus-p9-replan-home-');
    let calls = 0;
    const provider: LLMProvider = {
      name: 'phase9-replan',
      async chat() {
        calls++;
        if (calls === 1) return { message: { role: 'assistant', content: 'replan: use a direct write instead' } };
        if (calls === 2) return { message: { role: 'assistant', content: '', tool_calls: [{ id: 'r1', type: 'function' as const, function: { name: 'write_file', arguments: JSON.stringify({ path: 'a.txt', content: 'one' }) } }] } };
        if (calls === 3) return { message: { role: 'assistant', content: '', tool_calls: [{ id: 'r2', type: 'function' as const, function: { name: 'write_file', arguments: JSON.stringify({ path: 'b.txt', content: 'two' }) } }] } };
        return { message: { role: 'assistant', content: 'done: complete' } };
      },
      async *stream() { yield { type: 'delta', content: '' }; },
    };
    const { runner } = makeRunner({ workspace, home, provider });

    const result = await runner.run({ goal: 'Write the files\ndone: files written' });
    expect(result.state.status).toBe('done');
    expect(result.state.plan.version).toBe(2);
    expect(result.events.some((event) => event.type === 'REPLAN_CREATED')).toBe(true);
    expect(result.events.filter((event) => event.type === 'PLAN_CREATED')).toHaveLength(2);
  });
});

describe('Phase 9 — LLM fault injection', () => {
  test('timeout, rate-limit, refusal, and malformed provider behaviour fail as recorded task errors', async () => {
    const cases: Array<{ name: string; provider: LLMProvider; marker: string }> = [
      { name: 'timeout', provider: { name: 'timeout', async chat() { throw new LLMTimeoutError('LLM request timed out'); }, async *stream() {} }, marker: 'max_errors' },
      { name: 'rate-limit', provider: { name: 'rate-limit', async chat() { throw new LLMRateLimitError('provider rate limited'); }, async *stream() {} }, marker: 'max_errors' },
      { name: 'refusal', provider: { name: 'refusal', async chat() { throw new LLMContentPolicyError('provider refused'); }, async *stream() {} }, marker: 'content_policy' },
      { name: 'malformed', provider: { name: 'malformed', async chat() { return { message: { role: 'assistant', content: 'unstructured prose' } }; }, async *stream() {} }, marker: 'invalid_action' },
    ];

    for (const item of cases) {
      const workspace = temp(`daedalus-p9-llm-${item.name}-ws-`);
      const home = temp(`daedalus-p9-llm-${item.name}-home-`);
      const { runner } = makeRunner({ workspace, home, provider: item.provider, maxIterations: 3, maxErrors: 1 });
      const result = await runner.run({ goal: `Fault case ${item.name}\ndone: never reached`, maxErrors: 1 });
      expect(result.state.status, item.name).toBe('failed');
      expect(result.state.last_error, item.name).toContain(item.marker);
      if (item.name !== 'malformed') {
        expect(result.events.some((event) => event.type === 'MODEL_REQUEST_FAILED'), item.name).toBe(true);
        expect(result.report.evidence.some((line) => line.startsWith('model failure:')), item.name).toBe(true);
      }
      expect(result.report.outcome, item.name).toBe('failed');
    }
  });

  test('OpenAI-compatible refusal responses map to LLMContentPolicyError', async () => {
    const fetchFilter = (async () => new Response(JSON.stringify({
      choices: [{ message: { role: 'assistant', content: '' }, finish_reason: 'content_filter' }],
    }), { status: 200, headers: { 'content-type': 'application/json' } })) as typeof fetch;
    const filtered = new OpenAICompatProvider({ baseUrl: 'https://example.test/v1', apiKey: 'k', model: 'm', fetch: fetchFilter });
    await expect(filtered.chat([{ role: 'user', content: 'hi' }])).rejects.toBeInstanceOf(LLMContentPolicyError);

    const fetchPolicy = (async () => new Response(JSON.stringify({
      error: { message: 'request refused by content policy', code: 'content_policy_violation' },
    }), { status: 400, headers: { 'content-type': 'application/json' } })) as typeof fetch;
    const policy = new OpenAICompatProvider({ baseUrl: 'https://example.test/v1', apiKey: 'k', model: 'm', fetch: fetchPolicy });
    await expect(policy.chat([{ role: 'user', content: 'hi' }])).rejects.toBeInstanceOf(LLMContentPolicyError);
  });
});

describe('Phase 9 — tool integration and terminal failures', () => {
  test('all default tools execute against a fixture repo and path escapes are denied', async () => {
    const workspace = temp('daedalus-p9-tools-ws-');
    execFileSync('git', ['init', '-q'], { cwd: workspace });
    writeFileSync(join(workspace, 'README.md'), '# fixture\n');
    const registry = createDefaultRegistry();
    const call = (tool: string, args: unknown): Promise<Awaited<ReturnType<typeof registry.execute>>> => registry.execute(
      { id: `call-${tool}`, task_id: 'phase9-tools', turn_id: 'turn-1', tool, args, started_at: new Date().toISOString() } satisfies ToolCall,
      { workspaceRoot: workspace },
    );

    // The default set grew in batches: fetch_url (read a public docs
    // page) + view_image (look at a workspace image), then search_images
    // (read-only Openverse/Wikimedia lookup) + download_file (mutating
    // image download into the workspace, mode-gated like the write tools),
    // then the background-job pair command_status (read) + command_kill
    // (execution class) behind run_command's background start, then the
    // 2026-10-08 tool-upgrades pair web_search (discovery half of
    // fetch_url) + screenshot (verify rendered pages by looking), then
    // the Agentic Slide tools (create/read/add/update/move/delete deck
    // slides, theme, validate, export) appended at the end.
    expect(DEFAULT_TOOLS.map((tool) => tool.name)).toEqual([
      'read_file', 'write_file', 'edit_file', 'create_dir', 'list_dir', 'grep', 'glob', 'run_command', 'command_status', 'command_kill', 'git_diff', 'git_status', 'fetch_url', 'web_search', 'view_image', 'screenshot', 'search_images', 'download_file',
      'create_deck', 'read_deck', 'add_slide', 'update_slide', 'move_slide', 'delete_slide', 'set_deck_theme', 'validate_deck', 'export_deck',
    ]);
    expect((await call('create_dir', { path: 'src' })).status).toBe('ok');
    expect((await call('write_file', { path: 'src/app.ts', content: "export const value = 'broken';\n" })).status).toBe('ok');
    expect((await call('edit_file', { path: 'src/app.ts', old_string: 'broken', new_string: 'fixed' })).status).toBe('ok');
    expect((await call('read_file', { path: 'src/app.ts' })).output).toContain('fixed');
    expect((await call('list_dir', { path: '.' })).output).toContain('src/');
    expect((await call('grep', { pattern: 'fixed' })).output).toContain('src/app.ts');
    expect((await call('glob', { pattern: 'src/*.ts' })).output).toContain('src/app.ts');
    expect((await call('run_command', { command: 'echo', args: ['tool-ok'] })).output).toContain('tool-ok');
    expect((await call('git_status', { path: '.' })).status).toBe('ok');
    expect((await call('git_diff', { path: '.', stat_only: true })).status).toBe('ok');

    expect((await call('write_file', { path: '../evil.txt', content: 'no' })).status).toBe('error');
    expect(existsSync(join(workspace, '..', 'evil.txt'))).toBe(false);
    expect((await call('git_status', { path: '../' })).status).toBe('error');
    expect((await call('run_command', { command: 'echo', args: ['no'], cwd: '../' })).status).toBe('denied');
  });

  test('bad exit, timeout, huge output, and process signal are surfaced distinctly', async () => {
    const workspace = temp('daedalus-p9-terminal-ws-');
    const ctx = { workspaceRoot: workspace };

    const badExit = await runCommandTool.execute({ command: 'node', args: ['-e', 'process.exit(3)'] }, ctx);
    expect(badExit.status).toBe('error');
    expect(badExit.meta.exit_code).toBe(3);

    const timeout = await runCommandTool.execute({ command: 'node', args: ['-e', 'setTimeout(() => {}, 5000)'] }, { ...ctx, timeoutMs: 50 });
    expect(timeout.status).toBe('timeout');
    expect(timeout.meta.killed).toBe(true);

    const huge = await runCommandTool.execute({ command: 'node', args: ['-e', 'process.stdout.write("x".repeat(100000))'] }, ctx);
    expect(huge.truncated).toBe(true);
    expect(huge.output.length).toBeLessThan(25_000);

    const signal = await runCommandTool.execute({ command: 'node', args: ['-e', 'process.kill(process.pid, "SIGTERM")'] }, ctx);
    expect(signal.status).toBe('error');
    expect(signal.meta.exit_code).toBeNull();
    expect(signal.meta.signal).toBe('SIGTERM');
  });
});

describe('Phase 9 — permissions and cancellation', () => {
  test('ask denies without executing, remember grants the repeat call, and escapes stay denied', async () => {
    const workspace = temp('daedalus-p9-perm-ws-');
    const home = temp('daedalus-p9-perm-home-');
    const store = new TaskStore(home);
    const bus = new EventBus();
    const registry = createDefaultRegistry();
    const writeTool = registry.get('write_file');
    const runTool = registry.get('run_command');
    const harness = new ExecutionHarness({ defaultApprovalPolicy: 'ask' }, { bus, store });
    const decisions = [{ decision: 'deny' as const }, { decision: 'grant' as const, remember: true }];
    let callbacks = 0;
    harness.setApprovalCallback(async () => { callbacks++; return decisions.shift() ?? { decision: 'deny' as const }; });
    const call = (id: string): ToolCall => ({ id, task_id: 'phase9-perm', turn_id: 'turn-1', tool: 'write_file', args: { path: 'guarded.txt', content: 'approved' }, started_at: new Date().toISOString() });

    const denied = await harness.execute(call('p1'), writeTool, { workspaceRoot: workspace, taskId: 'phase9-perm' });
    expect(denied.status).toBe('denied');
    expect(existsSync(join(workspace, 'guarded.txt'))).toBe(false);

    const granted = await harness.execute(call('p2'), writeTool, { workspaceRoot: workspace, taskId: 'phase9-perm' });
    expect(granted.status).toBe('ok');
    const remembered = await harness.execute(call('p3'), writeTool, { workspaceRoot: workspace, taskId: 'phase9-perm' });
    expect(remembered.status).toBe('ok');
    expect(callbacks).toBe(2);
    expect(store.replay('phase9-perm').some((event) => event.type === 'APPROVAL_REQUESTED')).toBe(true);

    const autoHarness = new ExecutionHarness({ defaultApprovalPolicy: 'auto' }, { bus, store });
    const escape = await autoHarness.execute(
      { id: 'p4', task_id: 'phase9-perm', turn_id: 'turn-1', tool: 'run_command', args: { command: 'echo', args: ['no'], cwd: '../' }, started_at: new Date().toISOString() },
      runTool,
      { workspaceRoot: workspace, taskId: 'phase9-perm' },
    );
    expect(escape.status).toBe('denied');
  });

  test('cancelling a mid-task command aborts cleanly and records the stop reason', async () => {
    const workspace = temp('daedalus-p9-cancel-ws-');
    const home = temp('daedalus-p9-cancel-home-');
    const { runner } = makeRunner({
      workspace,
      home,
      provider: scriptedProvider([{ tool: 'run_command', args: { command: 'node', args: ['-e', 'setTimeout(() => {}, 5000)'] } }]),
      maxIterations: 5,
    });

    let taskId = '';
    let started!: () => void;
    const commandStarted = new Promise<void>((resolve) => { started = resolve; });
    const run = runner.run({
      goal: 'Run a long command\ndone: command finishes',
      onEvent: (event) => {
        if (event.type === 'TASK_STARTED') taskId = event.task_id;
        if (event.type === 'COMMAND_STARTED') started();
      },
    });
    await commandStarted;
    const began = Date.now();
    runner.cancel(taskId);
    const result = await run;

    expect(Date.now() - began).toBeLessThan(4_000);
    expect(result.state.last_error).toBe('aborted');
    expect(result.outcome).toBe('stopped');
    expect(result.events.some((event) => event.type === 'COMMAND_FINISHED' && (event.payload as { killed?: boolean }).killed === true)).toBe(true);
    expect(result.events.at(-1)?.payload).toMatchObject({ outcome: 'failed', reason: 'aborted' });
  }, 15_000);
});
