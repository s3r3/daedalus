import { describe, expect, test } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  AgentLoop,
  createPlan,
  DefaultContextManager,
  EventBus,
  LLMAuthError,
  LLMTimeoutError,
  TaskStore,
  evaluateStopConditions,
  handleObservation,
  interpretTask,
  parseAction,
  replan,
  truncate,
  type LLMProvider,
  type TaskState,
  type ToolResult,
} from '../src/index.ts';

function tmpStore(): { store: TaskStore; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'daedalus-agent-'));
  return { store: new TaskStore(dir), cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

function fakeProvider(responder: (messages: unknown[]) => { content?: string; toolCalls?: Array<{ id: string; name: string; args: unknown }> }): LLMProvider {
  return {
    name: 'fake',
    async chat(messages) {
      const reply = responder(messages);
      if (reply.toolCalls?.length) {
        return {
          message: {
            role: 'assistant',
            content: '',
            tool_calls: reply.toolCalls.map((t) => ({
              id: t.id,
              type: 'function' as const,
              function: { name: t.name, arguments: JSON.stringify(t.args) },
            })),
          },
        };
      }
      return { message: { role: 'assistant', content: reply.content ?? 'done: all set' } };
    },
    async *stream() {
      yield { type: 'delta', content: 'done' };
    },
  };
}

describe('TaskInterpreter', () => {
  test('parses goal, constraints, and done criteria', async () => {
    const spec = await interpretTask('Add login\nconstraint: no new deps\ndone: tests pass\ndone: lint passes');
    expect(spec.goal).toBe('Add login');
    expect(spec.constraints).toEqual(['no new deps']);
    expect(spec.done_criteria).toEqual(['tests pass', 'lint passes']);
    expect(spec.repo_path.length).toBeGreaterThan(0);
  });

  test('keeps prose-only input as goal', async () => {
    const spec = await interpretTask('Refactor auth module');
    expect(spec.goal).toBe('Refactor auth module');
    expect(spec.done_criteria).toEqual([]);
  });
});

describe('Planner', () => {
  test('creates one plan step per done-criterion', async () => {
    const spec = await interpretTask('Fix bug\ndone: reproduce\ndone: fix and verify', { id: 't-plan' });
    const plan = await createPlan(spec);
    expect(plan.task_id).toBe('t-plan');
    expect(plan.steps.map((s) => s.intent)).toEqual(['Satisfy: reproduce', 'Satisfy: fix and verify']);
    expect(plan.steps[0]?.status).toBe('active');
  });

  test('replan appends a recovery step and bumps version', async () => {
    const spec = await interpretTask('Fix bug', { id: 't-replan' });
    const plan = await createPlan(spec);
    const next = await replan(spec, plan, { kind: 'tool_result', result: { call_id: 'c1', status: 'error', output: 'boom', truncated: false, meta: {} } });
    expect(next.version).toBe(plan.version + 1);
    expect(next.steps).toHaveLength(plan.steps.length + 1);
  });
});

describe('ContextManager', () => {
  test('assembles ordered sections and stays under budget', async () => {
    const spec = await interpretTask('Add auth\ndone: tests pass', { id: 't-ctx' });
    const plan = await createPlan(spec);
    const state: TaskState = { ...spec, plan, steps: plan.steps, status: 'active' };
    const ctx = new DefaultContextManager(400);
    const messages = await ctx.buildMessages(state, []);
    const joined = messages.map((m) => (typeof m.content === 'string' ? m.content : '')).join('\n');
    expect(joined.indexOf('## role')).toBeLessThan(joined.indexOf('## task'));
    expect(joined.indexOf('## task')).toBeLessThan(joined.indexOf('## plan'));
    expect(ctx.estimate(messages)).toBeLessThanOrEqual(400);
  });

  test('truncate marks oversized observations explicitly', () => {
    const out = truncate('x'.repeat(100), 10);
    expect(out).toContain('[truncated 90 chars of 100]');
  });
});

describe('parseAction', () => {
  test('tool_call message becomes a tool action', async () => {
    const spec = await interpretTask('x', { id: 't-act' });
    const state: TaskState = { ...spec, plan: { id: 'p', task_id: 't-act', steps: [], version: 1, status: 'active' }, steps: [], status: 'active' };
    const action = parseAction(state, {
      role: 'assistant',
      content: '',
      tool_calls: [{ id: 'c1', type: 'function', function: { name: 'read_file', arguments: '{"path":"a"}' } }],
    });
    expect(action.kind).toBe('tool');
    if (action.kind === 'tool') expect(action.call.tool).toBe('read_file');
  });

  test('malformed arguments stop with invalid_action', async () => {
    const spec = await interpretTask('x', { id: 't-bad' });
    const state: TaskState = { ...spec, plan: { id: 'p', task_id: 't-bad', steps: [], version: 1, status: 'active' }, steps: [], status: 'active' };
    const action = parseAction(state, {
      role: 'assistant',
      content: '',
      tool_calls: [{ id: 'c1', type: 'function', function: { name: 'read_file', arguments: '{not json' } }],
    });
    expect(action).toEqual({ kind: 'stop', reason: 'invalid_action' });
  });
});

describe('ObservationHandler', () => {
  test('marks the active step done on ok and advances', async () => {
    const spec = await interpretTask('x\ndone: one\ndone: two', { id: 't-obs' });
    const plan = await createPlan(spec);
    const state: TaskState = { ...spec, plan, steps: plan.steps, status: 'active' };
    const result: ToolResult = { call_id: 'c1', status: 'ok', output: 'read ok', truncated: false, meta: {} };
    const next = handleObservation({ kind: 'tool_result', result }, state);
    expect(next.steps[0]?.status).toBe('done');
    expect(next.steps[1]?.status).toBe('active');
    expect(next.last_error).toBeUndefined();
  });

  test('records the error and keeps the step active on failure', async () => {
    const spec = await interpretTask('x\ndone: one', { id: 't-obs-fail' });
    const plan = await createPlan(spec);
    const state: TaskState = { ...spec, plan, steps: plan.steps, status: 'active' };
    const result: ToolResult = { call_id: 'c1', status: 'error', output: 'boom', truncated: false, meta: {} };
    const next = handleObservation({ kind: 'tool_result', result }, state);
    expect(next.steps[0]?.status).toBe('active');
    expect(next.last_error).toContain('error');
  });
});

describe('StopConditions', () => {
  test('max-iterations fires at the limit', async () => {
    const spec = await interpretTask('x', { id: 't-stop' });
    const state: TaskState = { ...spec, plan: { id: 'p', task_id: 't-stop', steps: [], version: 1, status: 'draft' }, steps: [], status: 'active' };
    expect(evaluateStopConditions(state, 5, { max_iterations: 5, max_errors: 3 })).toBe('max_iterations');
    expect(evaluateStopConditions(state, 4, { max_iterations: 5, max_errors: 3 })).toBeUndefined();
  });
});

describe('AgentLoop (fake provider + fake tool)', () => {
  test('runs a plan to completion and emits the full event sequence', async () => {
    const { store, cleanup } = tmpStore();
    const bus = new EventBus();
    const seen: string[] = [];
    bus.on('*', (e) => void seen.push(e.type));
    const provider = fakeProvider(() => ({
      toolCalls: [{ id: `call-${seen.length}`, name: 'read_file', args: { path: 'README.md' } }],
    }));
    const loop = new AgentLoop({
      provider,
      bus,
      store,
      stopPolicy: { max_iterations: 10, max_errors: 3 },
    });
    const state = await loop.run('Fix readme\ndone: docs updated\ndone: lint passes');
    expect(state.status).toBe('done');
    expect(seen).toEqual([
      'TASK_STARTED',
      'PLAN_CREATED',
      'MODEL_REQUEST_STARTED',
      'MODEL_REQUEST_FINISHED',
      'TOOL_CALL_STARTED',
      'TOOL_CALL_FINISHED',
      'MODEL_REQUEST_STARTED',
      'MODEL_REQUEST_FINISHED',
      'TOOL_CALL_STARTED',
      'TOOL_CALL_FINISHED',
      'TASK_COMPLETED',
    ]);
    const events = store.replay(state.id);
    expect(events.map((e) => e.type)).toEqual(seen);
    expect(events.every((e, i) => e.seq === i + 1)).toBe(true);
    cleanup();
  });

  test('resets the consecutive model-error budget after a successful model request', async () => {
    const { store, cleanup } = tmpStore();
    const bus = new EventBus();
    let calls = 0;
    const provider: LLMProvider = {
      name: 'flaky',
      async chat() {
        calls++;
        if ([1, 2, 4, 5].includes(calls)) throw new LLMTimeoutError('LLM request timed out after 180000ms');
        return {
          message: {
            role: 'assistant',
            content: '',
            tool_calls: [{ id: `call-${calls}`, type: 'function' as const, function: { name: 'read_file', arguments: '{"path":"README.md"}' } }],
          },
        };
      },
      async *stream() {},
    };
    const loop = new AgentLoop({
      provider,
      bus,
      store,
      stopPolicy: { max_iterations: 10, max_errors: 3 },
    });
    const state = await loop.run('Fix readme\ndone: docs updated\ndone: lint passes');
    cleanup();
    expect(calls).toBe(6);
    expect(state.status).toBe('done');
  });

  test('summarizes exhausted transient model errors instead of only saying max_errors', async () => {
    const { store, cleanup } = tmpStore();
    const bus = new EventBus();
    const provider = {
      name: 'single',
      model: 'slow-model',
      async chat() { throw new LLMTimeoutError('LLM request timed out after 180000ms'); },
      async *stream() {},
    } as LLMProvider & { model: string };
    const loop = new AgentLoop({
      provider,
      bus,
      store,
      stopPolicy: { max_iterations: 10, max_errors: 2 },
    });
    const state = await loop.run('Never reaches the model');
    const completed = store.replay(state.id).at(-1);
    const failed = store.replay(state.id).find((event) => event.type === 'MODEL_REQUEST_FAILED');
    cleanup();
    expect(state.status).toBe('failed');
    expect(state.last_error).toBe('max_errors');
    expect(failed?.payload).toMatchObject({ error_kind: 'transient', error_reason: 'timeout', model: 'slow-model' });
    expect(completed?.payload).toMatchObject({ outcome: 'failed', reason: 'max_errors' });
    expect((completed?.payload as { error_summary?: string }).error_summary).toContain('Model slow-model timed out after 180s');
    expect((completed?.payload as { error_summary?: string }).error_summary).toContain('Tried 1 model');
    expect((completed?.payload as { error_summary?: string }).error_summary).toContain('2 consecutive model request failures');
  });

  test('fails fast on fatal provider auth errors', async () => {
    const { store, cleanup } = tmpStore();
    const bus = new EventBus();
    let calls = 0;
    const provider: LLMProvider = {
      name: 'auth-broken',
      async chat() { calls++; throw new LLMAuthError('invalid API key'); },
      async *stream() {},
    };
    const loop = new AgentLoop({
      provider,
      bus,
      store,
      stopPolicy: { max_iterations: 10, max_errors: 5 },
    });
    const state = await loop.run('Never reaches the model');
    cleanup();
    expect(calls).toBe(1);
    expect(state.status).toBe('failed');
    expect(state.last_error).toContain('auth:');
    expect(state.last_error).toContain('authentication failed');
  });

  test('recovers from malformed actions and stops on invalid_action policy', async () => {
    const { store, cleanup } = tmpStore();
    const bus = new EventBus();
    const provider: LLMProvider = {
      name: 'garbage',
      async chat() {
        return { message: { role: 'assistant', content: 'hmm, unclear prose with no protocol' } };
      },
      async *stream() {},
    };
    const loop = new AgentLoop({
      provider,
      bus,
      store,
      stopPolicy: { max_iterations: 5, max_errors: 2 },
    });
    const state = await loop.run('Vague task');
    cleanup();
    expect(state.status).toBe('failed');
    expect(state.last_error).toContain('invalid_action');
  });

  test('stops with no_progress when the same observation repeats', async () => {
    const { store, cleanup } = tmpStore();
    const bus = new EventBus();
    const provider = fakeProvider(() => ({
      toolCalls: [{ id: `call-${Math.random()}`, name: 'read_file', args: { path: 'same' } }],
    }));
    const loop = new AgentLoop({
      provider,
      bus,
      store,
      stopPolicy: { max_iterations: 20, max_errors: 10 },
      executeTool: async (call) => ({ call_id: call.id, status: 'error', output: 'always the same failure', truncated: false, meta: {} }),
    });
    const state = await loop.run('Loop forever task with one step\ndone: never really satisfied');
    cleanup();
    expect(state.status).toBe('failed');
    expect(state.last_error).toBe('no_progress');
  });

  test('replays deterministically from the persisted event log', async () => {
    const { store, cleanup } = tmpStore();
    const bus = new EventBus();
    const provider = fakeProvider(() => ({ content: 'done: finished' }));
    const loop = new AgentLoop({ provider, bus, store });
    const first = await loop.run('Replay me');
    const replayed = store.replay(first.id);
    expect(replayed.length).toBeGreaterThan(0);
    expect(replayed[replayed.length - 1]?.type).toBe('TASK_COMPLETED');
    cleanup();
  });
});
