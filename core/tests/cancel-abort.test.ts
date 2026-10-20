import { describe, expect, test } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  AgentLoop,
  EventBus,
  OpenAICompatProvider,
  TaskRunner,
  TaskStore,
  type Event,
  type LLMProvider,
  type Validator,
} from '../src/index.ts';

function tmpDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

/** A provider whose calls hang until their AbortSignal fires — the way a
 *  long model call behaves over openai-compat's fetch. Captures the
 *  options it was called with so tests can assert the signal arrived. */
function hangingProvider(captured: { signals: Array<AbortSignal | undefined> }): LLMProvider {
  const hang = (options?: { signal?: AbortSignal }): Promise<void> =>
    new Promise<void>((resolve, reject) => {
      const signal = options?.signal;
      captured.signals.push(signal);
      if (signal?.aborted) {
        reject(new Error('The operation was aborted'));
        return;
      }
      const timer = setTimeout(() => resolve(), 30_000);
      timer.unref?.();
      signal?.addEventListener(
        'abort',
        () => {
          clearTimeout(timer);
          reject(new Error('The operation was aborted'));
        },
        { once: true },
      );
    });
  return {
    name: 'hanging',
    async chat(_messages, _tools, options) {
      await hang(options);
      return { message: { role: 'assistant', content: 'done: never reached' } };
    },
    async *stream(_messages, _tools, options) {
      await hang(options);
      yield { type: 'delta', content: 'done: never reached' };
    },
  };
}

/** A provider that does one stubbed tool call, then finishes — the pattern
 *  the loop needs to reach 'done' without a real workspace. */
function completingProvider(captured?: { signals: Array<AbortSignal | undefined> }): LLMProvider {
  let calls = 0;
  return {
    name: 'completing',
    async chat(_messages, _tools, options) {
      captured?.signals.push(options?.signal);
      calls++;
      if (calls === 1) {
        return {
          message: {
            role: 'assistant',
            content: '',
            tool_calls: [{ id: 'c1', type: 'function' as const, function: { name: 'read_file', arguments: JSON.stringify({ path: 'README.md' }) } }],
          },
        };
      }
      return { message: { role: 'assistant', content: 'done: all set' } };
    },
    async *stream(_messages, _tools, options) {
      captured?.signals.push(options?.signal);
      yield { type: 'delta', content: 'done: all set' };
    },
  };
}

function passingValidator(): Validator {
  return { async validate() { return { checks: [] }; } };
}

describe('cancel aborts in-flight model requests', () => {
  test('stop() during a chat call aborts the request and ends the task as cancelled, promptly', async () => {
    const dir = tmpDir('daedalus-cancel-abort-');
    try {
      const store = new TaskStore(dir);
      const bus = new EventBus();
      const captured: { signals: Array<AbortSignal | undefined> } = { signals: [] };
      const loop = new AgentLoop({ provider: hangingProvider(captured), bus, store, stopPolicy: { max_iterations: 5, max_errors: 3 } });

      let taskId = '';
      let resolveStarted!: () => void;
      const started = new Promise<void>((resolve) => { resolveStarted = resolve; });
      bus.on('MODEL_REQUEST_STARTED', (event: Event) => { taskId = event.task_id; resolveStarted(); });

      const run = loop.run('Write a poem\ndone: poem written');
      await started;
      const began = Date.now();
      loop.stop(taskId);
      const state = await run;
      const elapsed = Date.now() - began;

      // The 30s provider hang must not be waited out.
      expect(elapsed).toBeLessThan(2_000);
      // The signal actually reached the provider call…
      expect(captured.signals.length).toBeGreaterThan(0);
      expect(captured.signals[0]).toBeInstanceOf(AbortSignal);
      expect(captured.signals[0]?.aborted).toBe(true);
      // …and the task ends cancelled, not failed-with-timeout.
      expect(state.status).toBe('failed');
      expect(state.last_error).toBe('aborted');
      const completed = store.replay(taskId).filter((e) => e.type === 'TASK_COMPLETED');
      expect(completed).toHaveLength(1);
      expect(completed[0]?.payload).toMatchObject({ outcome: 'failed', reason: 'aborted' });
      // The persisted checkpoint is the complete cancelled state — no
      // half-written corruption for a later resume to trip on.
      const saved = store.loadState<{ status: string; last_error?: string }>(taskId);
      expect(saved?.status).toBe('failed');
      expect(saved?.last_error).toBe('aborted');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 15_000);

  test('stop() during a streaming call aborts the stream and ends the task as cancelled, promptly', async () => {
    const dir = tmpDir('daedalus-cancel-abort-stream-');
    try {
      const store = new TaskStore(dir);
      const bus = new EventBus();
      const captured: { signals: Array<AbortSignal | undefined> } = { signals: [] };
      const loop = new AgentLoop({
        provider: hangingProvider(captured),
        bus,
        store,
        streamText: true,
        stopPolicy: { max_iterations: 5, max_errors: 3 },
      });

      let taskId = '';
      let resolveStarted!: () => void;
      const started = new Promise<void>((resolve) => { resolveStarted = resolve; });
      bus.on('MODEL_REQUEST_STARTED', (event: Event) => { taskId = event.task_id; resolveStarted(); });

      const run = loop.run('Write a poem\ndone: poem written');
      await started;
      const began = Date.now();
      loop.stop(taskId);
      const state = await run;
      const elapsed = Date.now() - began;

      expect(elapsed).toBeLessThan(2_000);
      expect(captured.signals[0]).toBeInstanceOf(AbortSignal);
      expect(captured.signals[0]?.aborted).toBe(true);
      expect(state.status).toBe('failed');
      expect(state.last_error).toBe('aborted');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 15_000);

  test('stopping one task does not abort another task running in a different loop', async () => {
    const dir = tmpDir('daedalus-cancel-abort-isolation-');
    try {
      const store = new TaskStore(dir);
      const bus = new EventBus();
      const capturedA: { signals: Array<AbortSignal | undefined> } = { signals: [] };
      const capturedB: { signals: Array<AbortSignal | undefined> } = { signals: [] };
      // Two loops = two runners (the server/CLI create one runner per
      // task), each with its own per-task AbortController.
      const loopA = new AgentLoop({ provider: hangingProvider(capturedA), bus, store, stopPolicy: { max_iterations: 5, max_errors: 3 } });
      const loopB = new AgentLoop({ provider: completingProvider(capturedB), bus, store, stopPolicy: { max_iterations: 5, max_errors: 3 } });

      const taskIdAPromise = new Promise<string>((resolve) => {
        const off = bus.on('TASK_STARTED', (event: Event) => { off(); resolve(event.task_id); });
      });
      const runA = loopA.run('Write a poem\ndone: poem written');
      const taskIdA = await taskIdAPromise;
      const runB = loopB.run('Fix readme\ndone: docs updated');
      // A's model call is in flight (its provider hangs until aborted).
      await new Promise<void>((resolve) => {
        const off = bus.on('MODEL_REQUEST_STARTED', (event: Event) => {
          if (event.task_id === taskIdA) { off(); resolve(); }
        });
      });
      loopA.stop(taskIdA);
      const [stateA, stateB] = await Promise.all([runA, runB]);

      expect(stateA.last_error).toBe('aborted');
      expect(stateB.status).toBe('done');
      // B's provider calls were never handed an aborted signal.
      expect(capturedB.signals.length).toBeGreaterThan(0);
      expect(capturedB.signals.every((s) => s === undefined || !s.aborted)).toBe(true);
      expect(capturedA.signals[0]?.aborted).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 15_000);

  test('a task with no stop completes normally and its signal is never aborted', async () => {
    const dir = tmpDir('daedalus-cancel-abort-normal-');
    try {
      const store = new TaskStore(dir);
      const bus = new EventBus();
      const captured: { signals: Array<AbortSignal | undefined> } = { signals: [] };
      const loop = new AgentLoop({ provider: completingProvider(captured), bus, store, stopPolicy: { max_iterations: 5, max_errors: 3 } });
      const state = await loop.run('Fix readme\ndone: docs updated');
      expect(state.status).toBe('done');
      expect(captured.signals.length).toBeGreaterThan(0);
      expect(captured.signals.every((s) => s === undefined || !s.aborted)).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 15_000);

  test('an already-aborted signal never reaches the wire: the provider rejects before issuing the request', async () => {
    let hits = 0;
    const server = createServer((_req, res) => {
      hits++;
      const timer = setTimeout(() => res.end('{}'), 10_000);
      timer.unref?.();
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as { port: number }).port;
    try {
      const provider = new OpenAICompatProvider({ baseUrl: `http://127.0.0.1:${port}`, apiKey: 'test-key', model: 'test-model' });
      const controller = new AbortController();
      controller.abort();
      const began = Date.now();
      await expect(
        provider.chat([{ role: 'user', content: 'hi' }], undefined, { signal: controller.signal, timeout_ms: 5_000 }),
      ).rejects.toThrow();
      expect(Date.now() - began).toBeLessThan(2_000);
      expect(hits).toBe(0);
    } finally {
      server.close();
    }
  }, 15_000);

  test('runner-level cancel during a model call reports outcome stopped', async () => {
    const workspace = tmpDir('daedalus-cancel-abort-runner-ws-');
    const home = tmpDir('daedalus-cancel-abort-runner-home-');
    try {
      const store = new TaskStore(home);
      const bus = new EventBus();
      const runner = new TaskRunner({
        workspaceRoot: workspace,
        store,
        bus,
        provider: hangingProvider({ signals: [] }),
        validator: passingValidator(),
        approvalPolicy: 'auto',
        maxIterations: 5,
      });

      let taskId = '';
      let resolveStarted!: () => void;
      const started = new Promise<void>((resolve) => { resolveStarted = resolve; });
      const run = runner.run({
        goal: 'Write a poem\ndone: poem written',
        onEvent: (event) => {
          if (event.type === 'TASK_STARTED') taskId = event.task_id;
          if (event.type === 'MODEL_REQUEST_STARTED') resolveStarted();
        },
      });
      await started;
      const began = Date.now();
      runner.cancel(taskId);
      const result = await run;

      expect(Date.now() - began).toBeLessThan(2_000);
      expect(result.state.last_error).toBe('aborted');
      expect(result.outcome).toBe('stopped');
    } finally {
      rmSync(workspace, { recursive: true, force: true });
      rmSync(home, { recursive: true, force: true });
    }
  }, 15_000);
});
