import { afterEach, describe, expect, test } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  ApprovalBroker,
  EventBus,
  ExecutionHarness,
  TaskStore,
  readFileTool,
  runCommandTool,
  writeFileTool,
  type ApprovalRequestInfo,
  type ApprovalResult,
  type PermissionKey,
} from '../src/index.ts';

let dir: string;
afterEach(() => { if (dir) rmSync(dir, { recursive: true, force: true }); });
function workspace(): string { dir = mkdtempSync(join(tmpdir(), 'daedalus-harness-')); return dir; }

const call = (tool: string, args: unknown, id = 'c1') => ({ id, task_id: 't1', turn_id: 'u1', tool, args, started_at: new Date().toISOString() });
const ctx = (root: string, extra: Record<string, unknown> = {}) => ({ workspaceRoot: root, taskId: 't1', ...extra });

function harness(config: Parameters<typeof ExecutionHarness>[0] = {}, approval?: (key: PermissionKey, policy: string) => Promise<ApprovalResult>) {
  const bus = new EventBus();
  const root = workspace();
  const store = new TaskStore(root);
  const h = new ExecutionHarness(config, { bus, store });
  if (approval) h.setApprovalCallback(approval as never);
  return { h, bus, store, root };
}

describe('ExecutionHarness — approval gate + broker', () => {
  test('policy ask blocks until approval grants, then executes', async () => {
    const root = workspace();
    let requested: ApprovalRequestInfo | undefined;
    const { h } = harness({ defaultApprovalPolicy: 'ask' }, async (info) => { requested = info; return { decision: 'grant' }; });
    const result = await h.execute(call('write_file', { path: 'a.txt', content: 'hi' }), writeFileTool, ctx(root));
    expect(result.status).toBe('ok');
    expect(requested?.key).toMatchObject({ taskId: 't1', tool: 'write_file', action: 'write', path: 'a.txt' });
    expect(requested?.preview).toEqual({ kind: 'write', path: 'a.txt', content: 'hi' });
    expect(h.getAuditTrail('t1').map((e) => e.type)).toEqual(['tool_dispatch_started', 'approval_requested', 'approval_granted', 'tool_dispatch_completed']);
  });

  test('policy ask denies without executing and records the decision', async () => {
    const root = workspace();
    const { h } = harness({ defaultApprovalPolicy: 'ask' }, async () => ({ decision: 'deny' }));
    const result = await h.execute(call('write_file', { path: 'b.txt', content: 'no' }), writeFileTool, ctx(root));
    expect(result.status).toBe('denied');
    expect(result.output).toContain('approval denied');
    const trail = h.getAuditTrail('t1');
    expect(trail.some((e) => e.type === 'approval_denied')).toBe(true);
    expect(trail.some((e) => e.type === 'tool_dispatch_completed' && e.details?.status === 'denied')).toBe(true);
  });

  test('ApprovalBroker async decision loop unlocks pending execution', async () => {
    const root = workspace();
    const broker = new ApprovalBroker();
    const { h, bus, store } = harness({ defaultApprovalPolicy: 'ask' }, (key, policy) => broker.request(key, policy));
    const events: string[] = [];
    bus.on('*', (e) => { events.push(e.type); });
    const pendingExec = h.execute(call('write_file', { path: 'broker.txt', content: 'passed' }), writeFileTool, ctx(root));
    await new Promise((r) => setTimeout(r, 50));
    expect(broker.pending('t1')).toHaveLength(1);
    const pendingKey = broker.pending('t1')[0]!.key;
    const decided = broker.decide(pendingKey, 'grant', true);
    expect(decided).toBe(true);
    const result = await pendingExec;
    expect(result.status).toBe('ok');
    await bus.drain();
    expect(events).toContain('APPROVAL_REQUESTED');
    expect(events).toContain('APPROVAL_DECIDED');
    expect(store.replay('t1').some((e) => e.type === 'APPROVAL_REQUESTED')).toBe(true);
  });

  test('custom policy seam overrides default approval per tool/path', async () => {
    const root = workspace();
    const { h } = harness({
      defaultApprovalPolicy: 'deny',
      policyFor: (key) => (key.tool === 'write_file' && key.path === 'allowed.txt' ? 'auto' : 'deny'),
    });
    const allowed = await h.execute(call('write_file', { path: 'allowed.txt', content: 'ok' }), writeFileTool, ctx(root));
    const blocked = await h.execute(call('write_file', { path: 'other.txt', content: 'no' }), writeFileTool, ctx(root));
    expect(allowed.status).toBe('ok');
    expect(blocked.status).toBe('denied');
  });

  test('remembered grant skips the callback on the next call', async () => {
    const root = workspace();
    let calls = 0;
    const { h } = harness({ defaultApprovalPolicy: 'ask' }, async () => { calls++; return { decision: 'grant', remember: true }; });
    await h.execute(call('write_file', { path: 'c.txt', content: '1' }), writeFileTool, ctx(root));
    await h.execute(call('write_file', { path: 'c.txt', content: '2' }), writeFileTool, ctx(root));
    expect(calls).toBe(1);
  });
});

describe('ExecutionHarness — timeout and cancellation', () => {
  test('long-running command is killed at timeout and reported as timeout', async () => {
    const root = workspace();
    const { h } = harness({ defaultTimeoutMs: 200, defaultApprovalPolicy: 'auto' });
    const started = Date.now();
    const result = await h.execute(call('run_command', { command: 'sleep', args: ['5'] }), runCommandTool, ctx(root, { timeoutMs: 200 }));
    expect(Date.now() - started).toBeLessThan(4_000);
    expect(result.status).toBe('timeout');
    const trail = h.getAuditTrail('t1');
    expect(trail.some((e) => e.type === 'timeout_enforced')).toBe(true);
  });

  test('cancelTask aborts an in-flight command', async () => {
    const root = workspace();
    const { h } = harness({ defaultApprovalPolicy: 'auto' });
    const pending = h.execute(call('run_command', { command: 'sleep', args: ['10'] }, 'c-slow'), runCommandTool, ctx(root, { timeoutMs: 30_000 }));
    await new Promise((r) => setTimeout(r, 150));
    h.cancelTask('t1');
    const result = await pending;
    expect(result.status).toBe('timeout');
    expect(h.getAuditTrail('t1').some((e) => e.type === 'cancel_requested')).toBe(true);
    expect(h.getResourceUsage().activeProcesses).toBe(0);
  });

  test('output size cap is enforced and reported as truncation', async () => {
    const root = workspace();
    writeFileSync(join(root, 'big.txt'), 'x'.repeat(50_000));
    const { h } = harness({ defaultApprovalPolicy: 'auto', defaultOutputLimit: 1_000 });
    const result = await h.execute(call('read_file', { path: 'big.txt' }), readFileTool, ctx(root, { outputLimit: 1_000 }));
    expect(result.truncated).toBe(true);
    expect(result.output.length).toBeLessThan(2_000);
    expect(result.output).toContain('[truncated]');
  });

  test('process count limit denies when saturated', async () => {
    const root = workspace();
    const { h } = harness({ defaultApprovalPolicy: 'auto', maxConcurrentProcesses: 0 });
    const result = await h.execute(call('read_file', { path: 'x.txt' }), readFileTool, ctx(root));
    expect(result.status).toBe('denied');
    expect(result.output).toContain('process limit exceeded');
    expect(h.getAuditTrail('t1').some((e) => e.type === 'resource_limit_exceeded')).toBe(true);
  });

  test('disk writes limit denies when exceeded', async () => {
    const root = workspace();
    const { h } = harness({ defaultApprovalPolicy: 'auto', maxDiskWrites: 1 });
    const first = await h.execute(call('write_file', { path: '1.txt', content: 'a' }), writeFileTool, ctx(root));
    const second = await h.execute(call('write_file', { path: '2.txt', content: 'b' }), writeFileTool, ctx(root));
    expect(first.status).toBe('ok');
    expect(second.status).toBe('denied');
    expect(second.output).toContain('disk write cap exceeded');
  });
});

describe('ExecutionHarness — sandbox mode & command control', () => {
  test('sandbox execution scrubs external environment variables', async () => {
    const root = workspace();
    const { h } = harness({ defaultApprovalPolicy: 'auto', sandboxEnabled: true });
    const result = await h.execute(
      call('run_command', { command: 'node', args: ['-e', 'process.stdout.write(process.env.SECRET_KEY || "none")'] }),
      runCommandTool,
      ctx(root),
    );
    expect(result.status).toBe('ok');
    expect(result.output).toBe('none');
  });

  test('interactive and git destructive flags are denied', async () => {
    const root = workspace();
    const { h } = harness({ defaultApprovalPolicy: 'auto' });
    const commit = await h.execute(call('run_command', { command: 'git', args: ['commit', '-m', 'boom'] }), runCommandTool, ctx(root));
    const interactive = await h.execute(call('run_command', { command: 'node', args: ['-i'] }), runCommandTool, ctx(root));
    expect(commit.status).toBe('denied');
    expect(interactive.status).toBe('denied');
  });

  test('run_command cwd escapes are denied', async () => {
    const root = workspace();
    const { h } = harness({ defaultApprovalPolicy: 'auto' });
    const result = await h.execute(call('run_command', { command: 'ls', args: [], cwd: '../../' }), runCommandTool, ctx(root));
    expect(result.status).toBe('denied');
  });
});
