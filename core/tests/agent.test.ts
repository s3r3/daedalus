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
  LLMRateLimitError,
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
    // Budget covers the fixed sections plus the bounded workspace overview
    // the prompt now ships (production default is 16000). Raised from 700
    // when the skills test files lengthened the tree listing, and again
    // when the question-lifecycle / plan-followup test files did.
    const ctx = new DefaultContextManager(820);
    const messages = await ctx.buildMessages(state, []);
    const joined = messages.map((m) => (typeof m.content === 'string' ? m.content : '')).join('\n');
    expect(joined.indexOf('## role')).toBeLessThan(joined.indexOf('## task'));
    expect(joined.indexOf('## task')).toBeLessThan(joined.indexOf('## plan'));
    expect(ctx.estimate(messages)).toBeLessThanOrEqual(820);
  });

  test('truncate marks oversized observations explicitly', () => {
    const out = truncate('x'.repeat(100), 10);
    expect(out).toContain('[truncated 90 chars of 100]');
  });

  test('direct-URL save goals carry the fetch-first contract; other goals stay prompt-identical', async () => {
    // Auto-speed Fix 5: a pasted direct file URL + save intent must not
    // detour through search. Prompt-level only — the guidance section is
    // conditional on the goal shape, like the slide-goal contract.
    const urlSpec = await interpretTask('Download https://example.org/cat.jpg and save it here', { id: 't-url' });
    const urlPlan = await createPlan(urlSpec);
    const urlState: TaskState = { ...urlSpec, plan: urlPlan, steps: urlPlan.steps, status: 'active' };
    const urlMessages = await new DefaultContextManager(820).buildMessages(urlState, []);
    const urlJoined = urlMessages.map((m) => (typeof m.content === 'string' ? m.content : '')).join('\n');
    expect(urlJoined).toContain('## direct-url');
    expect(urlJoined).toContain('Call download_file on that URL FIRST');
    expect(urlJoined).toContain('Do not run search_images or web_search before it');

    // No URL in the goal → no section, prompt unchanged in shape.
    const plainSpec = await interpretTask('Download a cat image and save it as cat.jpg', { id: 't-plain' });
    const plainPlan = await createPlan(plainSpec);
    const plainState: TaskState = { ...plainSpec, plan: plainPlan, steps: plainPlan.steps, status: 'active' };
    const plainMessages = await new DefaultContextManager(820).buildMessages(plainState, []);
    const plainJoined = plainMessages.map((m) => (typeof m.content === 'string' ? m.content : '')).join('\n');
    expect(plainJoined).not.toContain('## direct-url');

    // URL without a save intent (e.g. discuss this PDF) → no fast-path.
    const discussSpec = await interpretTask('Summarize the argument in https://example.org/paper.pdf for me', { id: 't-discuss' });
    const discussPlan = await createPlan(discussSpec);
    const discussState: TaskState = { ...discussSpec, plan: discussPlan, steps: discussPlan.steps, status: 'active' };
    const discussMessages = await new DefaultContextManager(820).buildMessages(discussState, []);
    const discussJoined = discussMessages.map((m) => (typeof m.content === 'string' ? m.content : '')).join('\n');
    expect(discussJoined).not.toContain('## direct-url');
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
        // Rate limits stand in for generic transient failures here:
        // timeouts specifically are capped harder (2 consecutive →
        // provider_timeout, see scaffold/timeout tests), while the
        // generic budget this test specifies still tolerates them.
        if ([1, 2, 4, 5].includes(calls)) throw new LLMRateLimitError('provider rate limited');
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
    // Breaker supersedes the old identical-observation stop for this
    // shape: five identical calls hard-pause (default: stop) before the
    // 6-observation backstop could fire; 'no_progress' now covers
    // alternating stalls (see read-loop-stalls.test.ts).
    expect(state.last_error).toBe('loop_hard_pause');
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

describe('AgentLoop ask/plan prose repair', () => {
  // The incident shape: a weak model answers in plain prose (no tool call,
  // no "done:" prefix). Mutating modes always got a bounded repair turn;
  // ask/plan used to fail invalid_action on that first reply, so a correct
  // answer visible in chat still ended with status failed.
  test('ask mode repairs a prose reply instead of failing, then completes', async () => {
    const { store, cleanup } = tmpStore();
    const bus = new EventBus();
    const requests: string[] = [];
    let calls = 0;
    const provider: LLMProvider = {
      name: 'ask-prose-then-done',
      async chat(messages) {
        calls++;
        requests.push(messages.map((m) => (typeof m.content === 'string' ? m.content : '')).join('\n'));
        if (calls === 1) return { message: { role: 'assistant', content: 'The answer is 42, stated plainly.' } };
        if (calls === 2) return { message: { role: 'assistant', content: 'done: The answer is 42.' } };
        return { message: { role: 'assistant', content: '', tool_calls: [{ id: `c${calls}`, type: 'function' as const, function: { name: 'list_dir', arguments: '{}' } }] } };
      },
      async *stream() {},
    };
    const loop = new AgentLoop({
      provider,
      bus,
      store,
      mode: 'ask',
      stopPolicy: { max_iterations: 10, max_errors: 5 },
      executeTool: async (call) => ({ call_id: call.id, status: 'ok', output: 'notes.md', truncated: false, meta: {} }),
    });
    const state = await loop.run('What is the answer?\ndone: answer given');
    cleanup();
    expect(state.status).toBe('done');
    expect(calls).toBe(3);
    // The turn after the prose reply carried the Ask-mode repair directive.
    expect(requests[1]).toContain('In Ask mode, either call a read tool next');
  });

  test('ask mode still fails invalid_action once the repair budget is spent', async () => {
    const { store, cleanup } = tmpStore();
    const bus = new EventBus();
    let calls = 0;
    const provider: LLMProvider = {
      name: 'ask-always-prose',
      async chat() {
        calls++;
        return { message: { role: 'assistant', content: 'just prose, again' } };
      },
      async *stream() {},
    };
    const loop = new AgentLoop({
      provider,
      bus,
      store,
      mode: 'ask',
      stopPolicy: { max_iterations: 10, max_errors: 2 },
      executeTool: async (call) => ({ call_id: call.id, status: 'ok', output: 'notes.md', truncated: false, meta: {} }),
    });
    const state = await loop.run('What is the answer?\ndone: answer given');
    cleanup();
    expect(state.status).toBe('failed');
    expect(state.last_error).toContain('invalid_action');
    // First reply plus repairs bounded by the shared max_errors budget.
    expect(calls).toBe(2);
  });

  test('plan mode repairs a prose reply, then the plan write completes the task', async () => {
    const { store, cleanup } = tmpStore();
    const bus = new EventBus();
    const requests: string[] = [];
    let calls = 0;
    const provider: LLMProvider = {
      name: 'plan-prose-then-write',
      async chat(messages) {
        calls++;
        requests.push(messages.map((m) => (typeof m.content === 'string' ? m.content : '')).join('\n'));
        if (calls === 1) return { message: { role: 'assistant', content: 'Here is roughly what I would plan, in prose.' } };
        return { message: { role: 'assistant', content: '', tool_calls: [{ id: `c${calls}`, type: 'function' as const, function: { name: 'write_file', arguments: JSON.stringify({ path: '.daedalus/plans/probe/plan.md', content: '# Plan\n' }) } }] } };
      },
      async *stream() {},
    };
    const loop = new AgentLoop({
      provider,
      bus,
      store,
      mode: 'plan',
      stopPolicy: { max_iterations: 10, max_errors: 3 },
      executeTool: async (call) => ({ call_id: call.id, status: 'ok', output: 'written', truncated: false, meta: { mutating: true } }),
    });
    const state = await loop.run('Plan the probe feature\ndone: plan documented');
    cleanup();
    expect(state.status).toBe('done');
    expect(calls).toBe(2);
    // The turn after the prose reply carried the Plan-mode repair directive.
    expect(requests[1]).toContain('In Plan mode, either call a tool next');
  });
});

describe('auto-speed pack: prose closing acceptance (gate still rules)', () => {
  const mutatingStub = async (call: { id: string }): Promise<ToolResult> => ({
    call_id: call.id,
    status: 'ok',
    output: 'wrote index.html',
    truncated: false,
    meta: { mutating: true },
  });

  test('a prose closing is accepted once the creation gate passes — no done:-prefix re-prompt tax', async () => {
    const { store, cleanup } = tmpStore();
    const bus = new EventBus();
    let calls = 0;
    const provider: LLMProvider = {
      name: 'write-then-prose-close',
      async chat() {
        calls++;
        if (calls === 1) {
          return { message: { role: 'assistant', content: '', tool_calls: [{ id: 'w1', type: 'function' as const, function: { name: 'write_file', arguments: JSON.stringify({ path: 'index.html', content: '<h1>hi</h1>' }) } }] } };
        }
        // The exact failure shape of the live cat run: work done, model
        // closes with plain prose instead of a `done:`-prefixed claim.
        return { message: { role: 'assistant', content: 'Created index.html with the landing page. All set!' } };
      },
      async *stream() {},
    };
    const loop = new AgentLoop({ provider, bus, store, stopPolicy: { max_iterations: 10, max_errors: 3 }, executeTool: mutatingStub });
    // Two criteria → two plan steps: the write checks off only one, so
    // the run reaches the model's prose close with a step still open —
    // exactly the live shape this fixes.
    const state = await loop.run('Create a landing page in index.html\ndone: index.html exists\ndone: page has a heading');
    cleanup();
    expect(state.status).toBe('done');
    // Two model calls total: the write and the accepted prose close —
    // not write + up to five invalid_action re-prompts.
    expect(calls).toBe(2);
    expect(state.last_error).toBeUndefined();
    expect(state.last_observation).toContain('All set!');
  });

  test('a prose closing with nothing delivered is still re-prompted (gate fails)', async () => {
    const { store, cleanup } = tmpStore();
    const bus = new EventBus();
    let calls = 0;
    const requests: string[] = [];
    const provider: LLMProvider = {
      name: 'prose-first-then-write',
      async chat(messages) {
        calls++;
        requests.push(messages.map((m) => (typeof m.content === 'string' ? m.content : '')).join('\n'));
        if (calls === 1) return { message: { role: 'assistant', content: 'Here is your landing page, all done!' } };
        if (calls === 2) {
          return { message: { role: 'assistant', content: '', tool_calls: [{ id: 'w1', type: 'function' as const, function: { name: 'write_file', arguments: JSON.stringify({ path: 'index.html', content: '<h1>hi</h1>' }) } }] } };
        }
        if (calls === 3) {
          return { message: { role: 'assistant', content: '', tool_calls: [{ id: 'w2', type: 'function' as const, function: { name: 'write_file', arguments: JSON.stringify({ path: 'index.html', content: '<h1>Landing</h1>' }) } }] } };
        }
        return { message: { role: 'assistant', content: 'done: index.html created' } };
      },
      async *stream() {},
    };
    const loop = new AgentLoop({ provider, bus, store, stopPolicy: { max_iterations: 10, max_errors: 3 }, executeTool: mutatingStub });
    // Two writes before the close: plan steps advance one per mutating
    // result, so the second write checks off the last step and the
    // loop-top completion finishes the task — the steps gate is
    // untouched by this pack.
    const state = await loop.run('Create a landing page in index.html\ndone: index.html exists\ndone: page has a heading');
    cleanup();
    expect(state.status).toBe('done');
    expect(calls).toBe(3);
    // The empty-handed prose close bought the invalid_action re-prompt,
    // exactly as before — acceptance only comes after a delivery.
    expect(requests[1]).toContain('the previous reply was not a tool call');
  });
});

describe('auto-speed pack: done: claim completes on delivered work (steps gate must not bounce it)', () => {
  test('an explicit done: claim lands with a plan step still open once work is delivered', async () => {
    const { store, cleanup } = tmpStore();
    const bus = new EventBus();
    let calls = 0;
    const provider: LLMProvider = {
      name: 'write-then-claim',
      async chat() {
        calls++;
        if (calls === 1) {
          return { message: { role: 'assistant', content: '', tool_calls: [{ id: 'w1', type: 'function' as const, function: { name: 'write_file', arguments: JSON.stringify({ path: 'index.html', content: '<h1>hi</h1>' }) } }] } };
        }
        return { message: { role: 'assistant', content: 'done: index.html created' } };
      },
      async *stream() {},
    };
    const loop = new AgentLoop({
      provider,
      bus,
      store,
      stopPolicy: { max_iterations: 10, max_errors: 3 },
      executeTool: async (call) => ({ call_id: call.id, status: 'ok', output: 'wrote index.html', truncated: false, meta: { mutating: true } }),
    });
    // Two criteria → the write checks off only one step. The claim used
    // to bounce off the still-open step until the stall backstop killed
    // the task (live: the file was downloaded and the model said done:
    // ten times before dying no_progress).
    const state = await loop.run('Create a landing page in index.html\ndone: index.html exists\ndone: page has a heading');
    cleanup();
    expect(state.status).toBe('done');
    expect(calls).toBe(2);
    expect(state.last_observation).toContain('done: index.html created');
  });

  test('a done: claim with nothing delivered still does not complete', async () => {
    const { store, cleanup } = tmpStore();
    const bus = new EventBus();
    let calls = 0;
    const provider: LLMProvider = {
      name: 'claim-then-write',
      async chat() {
        calls++;
        if (calls === 1) return { message: { role: 'assistant', content: 'done: all set' } };
        if (calls === 2) {
          return { message: { role: 'assistant', content: '', tool_calls: [{ id: 'w1', type: 'function' as const, function: { name: 'write_file', arguments: JSON.stringify({ path: 'index.html', content: '<h1>hi</h1>' }) } }] } };
        }
        return { message: { role: 'assistant', content: 'done: index.html created' } };
      },
      async *stream() {},
    };
    const loop = new AgentLoop({
      provider,
      bus,
      store,
      stopPolicy: { max_iterations: 10, max_errors: 3 },
      executeTool: async (call) => ({ call_id: call.id, status: 'ok', output: 'wrote index.html', truncated: false, meta: { mutating: true } }),
    });
    const state = await loop.run('Create a landing page in index.html\ndone: index.html exists');
    cleanup();
    // The empty claim bought the creation-gate repair turn (call 2 was
    // the write, not an accepted finish); the write then completed the
    // single plan step at the loop top. Two calls total — the claim
    // itself never landed.
    expect(state.status).toBe('done');
    expect(calls).toBe(2);
  });
});

describe('auto-speed pack: honest input-token budget meter', () => {
  test('inflated billed prompt_tokens never fail a completing task (router surcharge is not our spend)', async () => {
    const { store, cleanup } = tmpStore();
    const bus = new EventBus();
    let calls = 0;
    const provider: LLMProvider = {
      name: 'inflated-billing',
      async chat() {
        calls++;
        // The kr/ relay bills ~17.6k prompt tokens for a ~1k local
        // context (router-injected prompt, re-stated each hop). 90k/call
        // reproduces the shape loudly: six such calls "spend" 540k
        // billed against a 100k budget while the real context stays ~1k.
        const usage = { prompt_tokens: 90_000, completion_tokens: 30, total_tokens: 90_030 };
        if (calls === 1) {
          return { usage, message: { role: 'assistant', content: '', tool_calls: [{ id: 'w1', type: 'function' as const, function: { name: 'write_file', arguments: JSON.stringify({ path: 'index.html', content: '<h1>hi</h1>' }) } }] } };
        }
        return { usage, message: { role: 'assistant', content: 'Created index.html. All set!' } };
      },
      async *stream() {},
    };
    const loop = new AgentLoop({
      provider,
      bus,
      store,
      stopPolicy: { max_iterations: 10, max_errors: 3 },
      inputTokenBudget: 100_000,
      executeTool: async (call) => ({ call_id: call.id, status: 'ok', output: 'wrote index.html', truncated: false, meta: { mutating: true } }),
    });
    const state = await loop.run('Create a landing page in index.html\ndone: index.html exists\ndone: page has a heading');
    const events = store.replay(state.id);
    cleanup();
    expect(state.status).toBe('done');
    expect(state.last_error).toBeUndefined();
    expect(calls).toBe(2);
    // The guardrail never even warned: local spend stayed ~1k of 100k.
    expect(events.filter((e) => e.type === 'LOOP_WARNING' && e.payload['kind'] === 'token_budget')).toHaveLength(0);
  });
});
