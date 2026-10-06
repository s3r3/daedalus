import { afterEach, describe, expect, test } from 'vitest';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventBus, TaskStore, type Settings } from '@daedalus/core';
import { attachWebSocket, createApp, createContext, type EventChannel } from '../src/app.ts';
import type { Conversation } from '../src/conversations.ts';

let app: ReturnType<typeof createApp> | undefined;
let channel: EventChannel | undefined;
let providerServer: Server | undefined;
const dirs: string[] = [];

function temp(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

afterEach(async () => {
  channel?.close();
  channel = undefined;
  if (app) await new Promise<void>((resolve) => app?.close(() => resolve()));
  app = undefined;
  if (providerServer) await new Promise<void>((resolve) => providerServer?.close(() => resolve()));
  providerServer = undefined;
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function listen(workspace: string, home: string): Promise<{ base: string; ctx: ReturnType<typeof createContext> }> {
  const settings: Settings = {
    llm: { baseUrl: 'http://127.0.0.1:1/v1', apiKey: '', model: '', models: [], modelStrategy: 'failover', timeoutMs: null },
    server: { host: '127.0.0.1', port: 3080 },
    daedalusHome: home,
  };
  const ctx = createContext({ settings, store: new TaskStore(join(home, 'state')), bus: new EventBus(), cwd: workspace });
  app = createApp(ctx);
  channel = attachWebSocket(ctx, app);
  return new Promise((resolve) => {
    app?.listen(0, '127.0.0.1', () => {
      const { port } = (app as NonNullable<typeof app>).address() as AddressInfo;
      resolve({ base: `http://127.0.0.1:${port}`, ctx });
    });
  });
}

async function closeApp(): Promise<void> {
  channel?.close();
  channel = undefined;
  if (app) await new Promise<void>((resolve) => app?.close(() => resolve()));
  app = undefined;
}

async function json<T>(res: Response): Promise<T> {
  return (await res.json()) as T;
}

function post(base: string, path: string, body: unknown): Promise<Response> {
  return fetch(new URL(path, base), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

/** Every chat request body the fake provider received, in order. */
const chatBodies: Array<{ messages: Array<{ role: string; content: string }> }> = [];

/**
 * Fake OpenAI-compatible provider. Fast-path calls (no `tools` on the
 * request) get a canned conversational reply; task calls get one write_file
 * then a done line.
 */
async function startFakeProvider(): Promise<string> {
  chatBodies.length = 0;
  let taskCalls = 0;
  providerServer = createServer((req, res) => {
    if (req.url === '/v1/models') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ data: [{ id: 'fake-model' }] }));
      return;
    }
    if (req.url === '/v1/chat/completions') {
      const chunks: Buffer[] = [];
      req.on('data', (chunk: Buffer) => chunks.push(chunk));
      req.on('end', () => {
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as {
          messages: Array<{ role: string; content: string }>;
          tools?: unknown[];
        };
        chatBodies.push(body);
        let message: unknown;
        if (!body.tools) {
          message = { role: 'assistant', content: 'Halo balik! Senang ngobrol.' };
        } else {
          taskCalls++;
          message =
            taskCalls <= 3
              ? {
                  role: 'assistant',
                  content: '',
                  tool_calls: [
                    {
                      id: `conv-${taskCalls}`,
                      type: 'function',
                      function: { name: 'write_file', arguments: JSON.stringify({ path: `halo${taskCalls}.txt`, content: 'halo' }) },
                    },
                  ],
                }
              : { role: 'assistant', content: 'done: files written' };
        }
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ choices: [{ message, finish_reason: 'stop' }] }));
      });
      return;
    }
    res.writeHead(404).end();
  });
  await new Promise<void>((resolve) => providerServer?.listen(0, '127.0.0.1', resolve));
  const address = providerServer.address() as AddressInfo;
  return `http://127.0.0.1:${address.port}/v1`;
}

async function registerFake(base: string, fakeBase: string): Promise<void> {
  const res = await post(base, '/providers', { id: 'fake', name: 'Fake', baseUrl: fakeBase, apiKey: 'fake-key', models: ['fake-model'] });
  expect(res.status).toBe(201);
}

async function waitFor<T>(probe: () => Promise<T | undefined>, attempts = 120): Promise<T> {
  for (let attempt = 0; attempt < attempts; attempt++) {
    const value = await probe();
    if (value !== undefined) return value;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error('waitFor timed out');
}

async function waitConversationTurns(base: string, root: string, id: string, count: number): Promise<Conversation> {
  return waitFor(async () => {
    const conversation = await json<{ conversation: Conversation }>(
      await fetch(new URL(`/conversations/${id}?root=${encodeURIComponent(root)}`, base)),
    );
    return conversation.conversation.turns.length >= count ? conversation.conversation : undefined;
  });
}

describe('chat conversations', () => {
  test('create/list/get, newest first, and the records survive a server restart', async () => {
    const workspace = temp('daedalus-srv-conv-ws-');
    const home = temp('daedalus-srv-conv-home-');
    const first = await listen(workspace, home);

    const createdA = await json<{ conversation: Conversation }>(
      await post(first.base, '/conversations', { root: workspace }),
    );
    expect(createdA.conversation.root).toBe(workspace);
    expect(createdA.conversation.turns).toEqual([]);
    // A second conversation sorts first (touched later / created later).
    const createdB = await json<{ conversation: Conversation }>(
      await post(first.base, '/conversations', { root: workspace }),
    );

    const list = await json<{ conversations: Conversation[]; count: number }>(
      await fetch(new URL(`/conversations?root=${encodeURIComponent(workspace)}`, first.base)),
    );
    expect(list.count).toBe(2);
    expect(list.conversations.map((c) => c.id)).toEqual([createdB.conversation.id, createdA.conversation.id]);

    const missing = await fetch(new URL(`/conversations/nope?root=${encodeURIComponent(workspace)}`, first.base));
    expect(missing.status).toBe(404);

    await closeApp();

    // Restart: a brand-new app over the same directories still sees them.
    const second = await listen(workspace, home);
    const afterRestart = await json<{ conversations: Conversation[] }>(
      await fetch(new URL(`/conversations?root=${encodeURIComponent(workspace)}`, second.base)),
    );
    expect(afterRestart.conversations.map((c) => c.id).sort()).toEqual(
      [createdA.conversation.id, createdB.conversation.id].sort(),
    );
    const one = await json<{ conversation: Conversation }>(
      await fetch(new URL(`/conversations/${createdA.conversation.id}?root=${encodeURIComponent(workspace)}`, second.base)),
    );
    expect(one.conversation.id).toBe(createdA.conversation.id);
  });

  test('follow-up prompts carry memory: fast-path history and task prior-context in one conversation', async () => {
    const workspace = temp('daedalus-srv-conv-mem-ws-');
    const home = temp('daedalus-srv-conv-mem-home-');
    const { base } = await listen(workspace, home);
    const fakeBase = await startFakeProvider();
    await registerFake(base, fakeBase);

    const { conversation } = await json<{ conversation: Conversation }>(
      await post(base, '/conversations', { root: workspace }),
    );

    // Turn 1: casual chat down the fast path.
    const t1 = await json<{ id: string }>(
      await post(base, '/tasks', {
        goal: 'halo daedalus',
        repo_path: workspace,
        provider_id: 'fake',
        model: 'fake-model',
        conversation_id: conversation.id,
      }),
    );
    await waitFor(async () => {
      const snapshot = await json<{ events: Array<{ type: string }> }>(await fetch(new URL(`/tasks/${t1.id}/events`, base)));
      return snapshot.events.some((event) => event.type === 'TASK_COMPLETED') ? true : undefined;
    });
    const afterT1 = await waitConversationTurns(base, workspace, conversation.id, 2);
    expect(afterT1.turns.map((turn) => turn.role)).toEqual(['user', 'assistant']);
    expect(afterT1.turns[1]?.text).toContain('Halo balik');

    // Turn 2: another fast-path line — the provider must SEE turn 1.
    const t2 = await json<{ id: string }>(
      await post(base, '/tasks', {
        goal: 'tadi kita ngobrol apa?',
        repo_path: workspace,
        provider_id: 'fake',
        model: 'fake-model',
        conversation_id: conversation.id,
      }),
    );
    await waitFor(async () => {
      const snapshot = await json<{ events: Array<{ type: string }> }>(await fetch(new URL(`/tasks/${t2.id}/events`, base)));
      return snapshot.events.some((event) => event.type === 'TASK_COMPLETED') ? true : undefined;
    });
    await waitConversationTurns(base, workspace, conversation.id, 4);
    const fastPathBodies = chatBodies.filter((body) => !body.tools);
    expect(fastPathBodies).toHaveLength(2);
    const secondFast = JSON.stringify(fastPathBodies[1]?.messages ?? []);
    expect(secondFast).toContain('halo daedalus');
    expect(secondFast).toContain('Halo balik');

    // Turn 3: a real task — the provider's prompt must carry the earlier turns.
    const t3 = await json<{ id: string }>(
      await post(base, '/tasks', {
        goal: 'buatkan file halo.txt berisi halo',
        repo_path: workspace,
        provider_id: 'fake',
        model: 'fake-model',
        mode: 'auto',
        conversation_id: conversation.id,
      }),
    );
    await waitFor(async () => {
      const snapshot = await json<{ state: { status: string } }>(await fetch(new URL(`/tasks/${t3.id}`, base)));
      return snapshot.state.status === 'done' || snapshot.state.status === 'failed' ? true : undefined;
    });
    const taskBodies = chatBodies.filter((body) => body.tools);
    expect(taskBodies.length).toBeGreaterThan(0);
    const taskPrompt = JSON.stringify(taskBodies[0]?.messages ?? []);
    expect(taskPrompt).toContain('Earlier in this conversation');
    expect(taskPrompt).toContain('halo daedalus');
    // The task's completion lands as the conversation's next assistant turn.
    const afterT3 = await waitConversationTurns(base, workspace, conversation.id, 6);
    expect(afterT3.turns.map((turn) => turn.role)).toEqual(['user', 'assistant', 'user', 'assistant', 'user', 'assistant']);
    expect(afterT3.turns[5]?.text).toContain('Selesai.');
    expect(afterT3.turns[4]?.task_id).toBe(t3.id);
    // And the task summary in the list carries its conversation id.
    const tasks = await json<{ tasks: Array<{ id: string; conversation_id?: string }> }>(await fetch(new URL('/tasks', base)));
    expect(tasks.tasks.find((task) => task.id === t3.id)?.conversation_id).toBe(conversation.id);
  }, 30_000);

  test('a fresh conversation injects nothing: the task prompt is the plain one', async () => {
    const workspace = temp('daedalus-srv-conv-fresh-ws-');
    const home = temp('daedalus-srv-conv-fresh-home-');
    const { base } = await listen(workspace, home);
    const fakeBase = await startFakeProvider();
    await registerFake(base, fakeBase);

    const { conversation } = await json<{ conversation: Conversation }>(
      await post(base, '/conversations', { root: workspace }),
    );
    const task = await json<{ id: string }>(
      await post(base, '/tasks', {
        goal: 'buatkan file halo.txt berisi halo',
        repo_path: workspace,
        provider_id: 'fake',
        model: 'fake-model',
        mode: 'auto',
        conversation_id: conversation.id,
      }),
    );
    await waitFor(async () => {
      const snapshot = await json<{ state: { status: string } }>(await fetch(new URL(`/tasks/${task.id}`, base)));
      return snapshot.state.status === 'done' || snapshot.state.status === 'failed' ? true : undefined;
    });
    const taskBodies = chatBodies.filter((body) => body.tools);
    expect(taskBodies.length).toBeGreaterThan(0);
    expect(JSON.stringify(taskBodies[0]?.messages ?? [])).not.toContain('Earlier in this conversation');
  }, 30_000);

  test('tasks without a conversation_id leave no turns behind (unchanged behaviour)', async () => {
    const workspace = temp('daedalus-srv-conv-none-ws-');
    const home = temp('daedalus-srv-conv-none-home-');
    const { base } = await listen(workspace, home);
    const fakeBase = await startFakeProvider();
    await registerFake(base, fakeBase);

    const task = await json<{ id: string }>(
      await post(base, '/tasks', {
        goal: 'halo daedalus',
        repo_path: workspace,
        provider_id: 'fake',
        model: 'fake-model',
      }),
    );
    await waitFor(async () => {
      const snapshot = await json<{ events: Array<{ type: string }> }>(await fetch(new URL(`/tasks/${task.id}/events`, base)));
      return snapshot.events.some((event) => event.type === 'TASK_COMPLETED') ? true : undefined;
    });
    const list = await json<{ conversations: Conversation[]; count: number }>(
      await fetch(new URL(`/conversations?root=${encodeURIComponent(workspace)}`, base)),
    );
    expect(list.count).toBe(0);
  });
});
