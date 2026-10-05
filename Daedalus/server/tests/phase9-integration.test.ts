import { afterEach, describe, expect, test } from 'vitest';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventBus, TaskStore, TaskRunner, type Event, type LLMProvider, type Settings } from '@daedalus/core';
import { attachWebSocket, createApp, createContext, type EventChannel } from '../src/app.ts';

let app: ReturnType<typeof createApp> | undefined;
let channel: EventChannel | undefined;
let providerServer: Server | undefined;
const dirs: string[] = [];

function temp(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

function fixtureWorkspace(prefix: string): string {
  const workspace = temp(prefix);
  writeFileSync(join(workspace, 'validate.js'), 'process.exit(0);\n');
  writeFileSync(join(workspace, 'package.json'), JSON.stringify({ scripts: { test: 'node validate.js', lint: 'node validate.js', build: 'node validate.js' } }));
  return workspace;
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

function scriptedProvider(): LLMProvider {
  const script = [
    { tool: 'create_dir', args: { path: 'app/src' } },
    { tool: 'write_file', args: { path: 'app/src/index.txt', content: 'hello parity\n' } },
  ];
  let index = 0;
  return {
    name: 'phase9-direct-scripted',
    async chat() {
      const step = script[index++];
      if (!step) return { message: { role: 'assistant', content: 'done: work complete' } };
      return {
        message: {
          role: 'assistant',
          content: '',
          tool_calls: [{ id: `direct-${index}`, type: 'function' as const, function: { name: step.tool, arguments: JSON.stringify(step.args) } }],
        },
      };
    },
    async *stream() { yield { type: 'delta', content: '' }; },
  };
}

async function startFakeProvider(): Promise<string> {
  let chatCalls = 0;
  providerServer = createServer((req, res) => {
    if (req.url === '/v1/models') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ data: [{ id: 'fake-model' }] }));
      return;
    }
    if (req.url === '/v1/chat/completions') {
      req.resume();
      req.on('end', () => {
        chatCalls++;
        const tool = chatCalls === 1
          ? { name: 'create_dir', arguments: JSON.stringify({ path: 'app/src' }) }
          : chatCalls === 2
            ? { name: 'write_file', arguments: JSON.stringify({ path: 'app/src/index.txt', content: 'hello parity\n' }) }
            : undefined;
        const message = tool
          ? { role: 'assistant', content: '', tool_calls: [{ id: `web-${chatCalls}`, type: 'function', function: tool }] }
          : { role: 'assistant', content: 'done: work complete' };
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ choices: [{ message, finish_reason: tool ? 'tool_calls' : 'stop' }] }));
      });
      return;
    }
    res.writeHead(404).end();
  });
  await new Promise<void>((resolve) => providerServer?.listen(0, '127.0.0.1', resolve));
  const address = providerServer.address() as AddressInfo;
  return `http://127.0.0.1:${address.port}/v1`;
}

async function listen(workspace: string, home: string): Promise<string> {
  const settings: Settings = {
    llm: { baseUrl: 'http://127.0.0.1:1/v1', apiKey: '', model: '', models: [], modelStrategy: 'failover', timeoutMs: null },
    server: { host: '127.0.0.1', port: 3080 },
    daedalusHome: home,
  };
  const ctx = createContext({ settings, store: new TaskStore(join(home, 'state')), bus: new EventBus(), cwd: workspace });
  app = createApp(ctx);
  channel = attachWebSocket(ctx, app);
  await new Promise<void>((resolve) => app?.listen(0, '127.0.0.1', resolve));
  const { port } = app.address() as AddressInfo;
  return `http://127.0.0.1:${port}`;
}

async function json<T>(res: Response): Promise<T> {
  return (await res.json()) as T;
}

describe('Phase 9 — CLI/Web parity through the shared core', () => {
  test('the same fixture task yields the same event-type sequence via direct core and the Web gateway', async () => {
    const goal = 'Create the app\ndone: app/src directory exists\ndone: app/src/index.txt exists';

    const directWorkspace = fixtureWorkspace('daedalus-p9-parity-direct-ws-');
    const directHome = temp('daedalus-p9-parity-direct-home-');
    const directRunner = new TaskRunner({
      workspaceRoot: directWorkspace,
      store: new TaskStore(directHome),
      bus: new EventBus(),
      provider: scriptedProvider(),
      approvalPolicy: 'auto',
      maxIterations: 8,
    });
    const direct = await directRunner.run({ goal });
    expect(direct.outcome).toBe('success');

    const webWorkspace = fixtureWorkspace('daedalus-p9-parity-web-ws-');
    const webHome = temp('daedalus-p9-parity-web-home-');
    const base = await listen(webWorkspace, webHome);
    const fakeBase = await startFakeProvider();

    const providerRes = await fetch(new URL('/providers', base), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: 'fake', name: 'Fake', baseUrl: fakeBase, apiKey: 'fake-key', models: ['fake-model'] }),
    });
    expect(providerRes.status).toBe(201);

    const createdRes = await fetch(new URL('/tasks', base), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        goal: 'Create the app',
        repo_path: webWorkspace,
        provider_id: 'fake',
        model: 'fake-model',
        mode: 'auto',
        auto_approve: true,
        done_criteria: ['app/src directory exists', 'app/src/index.txt exists'],
      }),
    });
    expect(createdRes.status).toBe(201);
    const task = await json<{ id: string }>(createdRes);

    let snapshot: { state: { status: string }; report: { outcome: string } | null; events: Event[] } | undefined;
    for (let attempt = 0; attempt < 100; attempt++) {
      snapshot = await json<typeof snapshot>(await fetch(new URL(`/tasks/${task.id}`, base)));
      if (snapshot?.report || snapshot?.state.status === 'done' || snapshot?.state.status === 'failed') break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }

    expect(snapshot?.state.status).toBe('done');
    expect(snapshot?.report?.outcome).toBe('success');
    expect(readFileSync(join(webWorkspace, 'app/src/index.txt'), 'utf8')).toBe('hello parity\n');
    expect(snapshot?.events.map((event) => event.type)).toEqual(direct.events.map((event) => event.type));
  }, 30_000);
});
