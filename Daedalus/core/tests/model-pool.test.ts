import { afterEach, describe, expect, test, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  LLMContentPolicyError,
  LLMFormatError,
  LLMRateLimitError,
  LLMTimeoutError,
  ModelPoolProvider,
  TaskRunner,
  TaskStore,
  createPlan,
  handleObservation,
  interpretTask,
  loadSettings,
  type ChatResponse,
  type LLMProvider,
  type ModelPoolSwitch,
  type TaskState,
  type ToolResult,
  type Validator,
} from '../src/index.ts';

const dirs: string[] = [];

function temp(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  vi.unstubAllGlobals();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function response(content: string): ChatResponse {
  return { message: { role: 'assistant', content } };
}

function fakeProvider(name: string, chat: () => Promise<ChatResponse>): LLMProvider {
  return {
    name,
    chat,
    async *stream() { yield { type: 'delta', content: '' }; },
  };
}

describe('ModelPoolProvider', () => {
  test('fails over from rate limit / quota errors to the next model and records the switch', async () => {
    const switches: ModelPoolSwitch[] = [];
    const calls: string[] = [];
    const pool = new ModelPoolProvider({
      models: ['quota-model', 'good-model'],
      createProvider: (model) => fakeProvider(model, async () => {
        calls.push(model);
        if (model === 'quota-model') throw new Error('insufficient quota: token limit reached');
        return response('done: from good model');
      }),
      onSwitch: (event) => { switches.push(event); },
    });

    await expect(pool.chat([{ role: 'user', content: 'hi' }])).resolves.toMatchObject({ message: { content: 'done: from good model' } });
    expect(calls).toEqual(['quota-model', 'good-model']);
    expect(switches).toEqual([expect.objectContaining({ from: 'quota-model', to: 'good-model', reason: 'quota', strategy: 'failover' })]);
    expect(pool.activeModel).toBe('good-model');
  });

  test('fails over on a router-wrapped upstream 400 but never on a plain malformed-request 400', async () => {
    const upstreamError = new Error('Error from provider (Console): Upstream request failed: [invalid_request_error] invalid request');
    const calls: string[] = [];
    const pool = new ModelPoolProvider({
      models: ['router-model', 'good-model'],
      createProvider: (model) => fakeProvider(model, async () => {
        calls.push(model);
        if (model === 'router-model') throw upstreamError;
        return response('done: second model answered');
      }),
    });
    await expect(pool.chat([{ role: 'user', content: 'hi' }])).resolves.toMatchObject({ message: { content: 'done: second model answered' } });
    expect(calls).toEqual(['router-model', 'good-model']);

    const malformedError = new Error("Invalid request: 'max_tokens' must be a positive integer");
    const strictCalls: string[] = [];
    const strictPool = new ModelPoolProvider({
      models: ['strict-model', 'other-model'],
      createProvider: (model) => fakeProvider(model, async () => {
        strictCalls.push(model);
        throw malformedError;
      }),
    });
    await expect(strictPool.chat([{ role: 'user', content: 'hi' }])).rejects.toBe(malformedError);
    expect(strictCalls).toEqual(['strict-model']);
  });

  test('treats empty / no-choice responses as retryable format failures', async () => {
    const pool = new ModelPoolProvider({
      models: ['empty-model', 'good-model'],
      createProvider: (model) => fakeProvider(model, async () => model === 'empty-model' ? response('') : response('done: usable')),
    });
    await expect(pool.chat([{ role: 'user', content: 'hi' }])).resolves.toMatchObject({ message: { content: 'done: usable' } });
  });

  test('round-robin starts the next request on the next model', async () => {
    const calls: string[] = [];
    const pool = new ModelPoolProvider({
      models: ['m1', 'm2'],
      strategy: 'round-robin',
      createProvider: (model) => fakeProvider(model, async () => {
        calls.push(model);
        return response(`done: ${model}`);
      }),
    });

    await expect(pool.chat([{ role: 'user', content: 'one' }])).resolves.toMatchObject({ message: { content: 'done: m1' } });
    await expect(pool.chat([{ role: 'user', content: 'two' }])).resolves.toMatchObject({ message: { content: 'done: m2' } });
    expect(calls).toEqual(['m1', 'm2']);
  });

  test('cools down a timed-out model, skips it, and retries it after the cooldown', async () => {
    let now = 0;
    const calls: string[] = [];
    const pool = new ModelPoolProvider({
      models: ['slow-model', 'good-model'],
      strategy: 'round-robin',
      cooldownMs: 60_000,
      now: () => now,
      createProvider: (model) => fakeProvider(model, async () => {
        calls.push(model);
        if (model === 'slow-model') throw new LLMTimeoutError('LLM request timed out after 180000ms');
        return response('done: good model');
      }),
    });

    await expect(pool.chat([{ role: 'user', content: 'one' }])).resolves.toMatchObject({ message: { content: 'done: good model' } });
    await expect(pool.chat([{ role: 'user', content: 'two' }])).resolves.toMatchObject({ message: { content: 'done: good model' } });
    expect(calls).toEqual(['slow-model', 'good-model', 'good-model']);
    expect(pool.lastAttemptedModels).toEqual(['good-model']);

    now += 60_001;
    await expect(pool.chat([{ role: 'user', content: 'three' }])).resolves.toMatchObject({ message: { content: 'done: good model' } });
    expect(calls).toEqual(['slow-model', 'good-model', 'good-model', 'slow-model', 'good-model']);
    expect(pool.lastAttemptedModels).toEqual(['slow-model', 'good-model']);
  });

  test('when every model is cooling down, only the earliest-expiring model is probed', async () => {
    const calls: string[] = [];
    const pool = new ModelPoolProvider({
      models: ['a-model', 'b-model'],
      cooldownMs: 60_000,
      now: () => 0,
      createProvider: (model) => fakeProvider(model, async () => {
        calls.push(model);
        throw new LLMTimeoutError(`timeout from ${model}`);
      }),
    });

    await expect(pool.chat([{ role: 'user', content: 'one' }])).rejects.toThrow('timeout from b-model');
    await expect(pool.chat([{ role: 'user', content: 'two' }])).rejects.toThrow('timeout from a-model');
    expect(calls).toEqual(['a-model', 'b-model', 'a-model']);
    expect(pool.lastAttemptedModels).toEqual(['a-model']);
  });

  test('failover remembers the last successful model for the next request', async () => {
    const calls: string[] = [];
    let firstModelBroken = false;
    const pool = new ModelPoolProvider({
      models: ['m1', 'm2'],
      createProvider: (model) => fakeProvider(model, async () => {
        calls.push(model);
        if (model === 'm1' && firstModelBroken) throw new LLMRateLimitError('provider rate limited');
        return response(`done: ${model}`);
      }),
    });

    await pool.chat([{ role: 'user', content: 'one' }]);
    firstModelBroken = true;
    await pool.chat([{ role: 'user', content: 'two' }]);
    await pool.chat([{ role: 'user', content: 'three' }]);
    expect(calls).toEqual(['m1', 'm1', 'm2', 'm2']);
    expect(pool.activeModel).toBe('m2');
  });

  test('does not fail over content-policy refusals', async () => {
    const calls: string[] = [];
    const pool = new ModelPoolProvider({
      models: ['refusing-model', 'other-model'],
      createProvider: (model) => fakeProvider(model, async () => {
        calls.push(model);
        if (model === 'refusing-model') throw new LLMContentPolicyError('provider refused');
        return response('done: should not happen');
      }),
    });

    await expect(pool.chat([{ role: 'user', content: 'hi' }])).rejects.toBeInstanceOf(LLMContentPolicyError);
    expect(calls).toEqual(['refusing-model']);
  });

  test('surfaces the last format error when every model is unusable', async () => {
    const pool = new ModelPoolProvider({
      models: ['a', 'b'],
      createProvider: (model) => fakeProvider(model, async () => { throw new LLMFormatError(`bad format from ${model}`); }),
    });
    await expect(pool.chat([{ role: 'user', content: 'hi' }])).rejects.toThrow('bad format from b');
  });
});

describe('edit-progress guard', () => {
  async function stateFor(criteria: string[]): Promise<TaskState> {
    const spec = await interpretTask(`Task\n${criteria.map((criterion) => `done: ${criterion}`).join('\n')}`, { id: 'pool-guard' });
    const plan = await createPlan(spec);
    return { ...spec, plan, steps: plan.steps, status: 'active' };
  }

  function result(mutating: boolean): ToolResult {
    return { call_id: 'c1', status: 'ok', output: 'ok', truncated: false, meta: { tool: mutating ? 'write_file' : 'list_dir', mutating } };
  }

  test('read-only tools do not complete implementation steps', async () => {
    const state = await stateFor(['greet() returns the fallback for empty names', 'Inspect the greeting implementation']);
    const next = handleObservation({ kind: 'tool_result', result: result(false) }, state);
    expect(next.steps[0]?.status).toBe('active');
    expect(next.steps[1]?.status).toBe('pending');
    expect(next.last_observation).toContain('Read-only inspection does not complete');
  });

  test('read-only tools can complete inspection steps and mutating tools complete implementation steps', async () => {
    const inspectState = await stateFor(['Inspect the greeting implementation', 'greet() returns the fallback']);
    const afterInspect = handleObservation({ kind: 'tool_result', result: result(false) }, inspectState);
    expect(afterInspect.steps[0]?.status).toBe('done');
    expect(afterInspect.steps[1]?.status).toBe('active');

    const afterWrite = handleObservation({ kind: 'tool_result', result: result(true) }, afterInspect);
    expect(afterWrite.steps[1]?.status).toBe('done');
  });
});

describe('TaskRunner model pool wiring', () => {
  test('settings LLM_MODELS continues the same task on the next model and emits PROVIDER_CHANGED', async () => {
    const workspace = temp('daedalus-pool-ws-');
    const home = temp('daedalus-pool-home-');
    const seenModels: string[] = [];
    let goodCalls = 0;
    vi.stubGlobal('fetch', async (_input: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? '{}')) as { model: string };
      seenModels.push(body.model);
      if (body.model === 'bad-model') {
        return new Response(JSON.stringify({ error: { message: 'Rate limit exceeded' } }), { status: 429, headers: { 'content-type': 'application/json' } });
      }
      goodCalls++;
      const payload = goodCalls === 1
        ? { choices: [{ message: { role: 'assistant', content: '', tool_calls: [{ id: 'write-1', type: 'function', function: { name: 'write_file', arguments: JSON.stringify({ path: 'result.txt', content: 'written by second model\n' }) } }] }, finish_reason: 'tool_calls' }] }
        : { choices: [{ message: { role: 'assistant', content: 'done: file written' }, finish_reason: 'stop' }] };
      return new Response(JSON.stringify(payload), { status: 200, headers: { 'content-type': 'application/json' } });
    });

    const settings = loadSettings({
      LLM_BASE_URL: 'https://example.test/v1',
      LLM_API_KEY: 'test-key',
      LLM_MODELS: 'bad-model,good-model',
      LLM_MODEL_STRATEGY: 'failover',
      DAEDALUS_HOME: home,
    });
    const validator: Validator = { async validate() { return { checks: [{ name: 'fixture', cmd: 'true', status: 'pass', exit_code: 0, summary: 'passed', diagnostics: [] }] }; } };
    const runner = new TaskRunner({ settings, workspaceRoot: workspace, store: new TaskStore(home), validator, approvalPolicy: 'auto', maxIterations: 5 });
    const result = await runner.run({ goal: 'Write result\n\ndone: result.txt exists' });

    expect(result.outcome).toBe('success');
    expect(readFileSync(join(workspace, 'result.txt'), 'utf8')).toBe('written by second model\n');
    expect(seenModels).toEqual(['bad-model', 'good-model']);
    expect(result.events.some((event) => event.type === 'MODEL_REQUEST_FAILED')).toBe(false);
    expect(result.events.some((event) => event.type === 'PROVIDER_CHANGED' && (event.payload as { to_model?: string }).to_model === 'good-model')).toBe(true);
  });
});
