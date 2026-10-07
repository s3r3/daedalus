import { afterEach, describe, expect, test } from 'vitest';
import type { AddressInfo } from 'node:net';
import { createServer as createHttpServer, type Server as HttpServer } from 'node:http';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  EventBus,
  ProviderRegistryStore,
  TaskRunner,
  TaskStore,
  loadSettings,
  type LLMProvider,
  type ValidationResult,
  type Validator,
} from '@daedalus/core';
import { createContext, createApp } from '../src/app.ts';

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'core', 'tests', 'fixtures');
const FAKE_MCP = join(FIXTURES, 'fake-mcp-server.mjs');
const FAKE_LSP = join(FIXTURES, 'fake-lsp-server.mjs');

let server: ReturnType<typeof createApp> | undefined;
let modelServer: HttpServer | undefined;
let tmp: string | undefined;
let workspace: string | undefined;
let providerHome: string | undefined;

afterEach(async () => {
  if (server) await new Promise<void>((resolve) => server?.close(() => resolve()));
  server = undefined;
  if (modelServer) await new Promise<void>((resolve) => modelServer?.close(() => resolve()));
  modelServer = undefined;
  if (tmp) rmSync(tmp, { recursive: true, force: true });
  tmp = undefined;
  if (workspace) rmSync(workspace, { recursive: true, force: true });
  workspace = undefined;
  if (providerHome) rmSync(providerHome, { recursive: true, force: true });
  providerHome = undefined;
});

async function listen(): Promise<{ base: string; ctx: ReturnType<typeof createContext> }> {
  tmp = mkdtempSync(join(tmpdir(), 'daedalus-shared-server-'));
  workspace = mkdtempSync(join(tmpdir(), 'daedalus-shared-ws-'));
  providerHome = mkdtempSync(join(tmpdir(), 'daedalus-shared-provider-home-'));
  mkdirSync(join(workspace, 'src'), { recursive: true });
  writeFileSync(join(workspace, 'src', 'index.ts'), 'export const a = 1\n');
  const settings = loadSettings({
    DAEDALUS_HOME: '.daedalus',
    LLM_BASE_URL: 'https://example.invalid/v1',
    LLM_MODEL: 'unused',
  });
  const ctx = createContext({
    // Deliberately not the workspace store: CLI tasks in
    // <workspace>/.daedalus must still be discoverable for monitoring.
    store: new TaskStore(join(tmp, 'server-state')),
    bus: new EventBus(),
    cwd: workspace,
    settings,
    providerStore: new ProviderRegistryStore(providerHome),
  });
  server = createApp(ctx);
  await new Promise<void>((resolve) => server?.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return { base: `http://127.0.0.1:${port}`, ctx };
}

async function json<T>(res: Response): Promise<T> {
  return (await res.json()) as T;
}

const passValidator: Validator = {
  async validate(): Promise<ValidationResult> {
    return { checks: [{ name: 'fixture', cmd: 'true', status: 'pass', exit_code: 0, summary: 'passed', diagnostics: [] }] };
  },
};

function cliScriptedProvider(): LLMProvider {
  let calls = 0;
  return {
    name: 'cli-scripted',
    async chat() {
      calls += 1;
      if (calls === 1) {
        return {
          message: {
            role: 'assistant',
            content: '',
            reasoning_content: 'Create the shared workspace file first.',
            tool_calls: [
              {
                id: 'cli-call-1',
                type: 'function' as const,
                function: { name: 'write_file', arguments: JSON.stringify({ path: 'from-cli.txt', content: 'created by CLI run\n' }) },
              },
            ],
          },
        };
      }
      return { message: { role: 'assistant', content: 'done: file created' } };
    },
    async *stream() {
      yield { type: 'delta', content: 'done' };
    },
  };
}

function writeExtensionFixtures(root: string): void {
  mkdirSync(join(root, '.daedalus', 'skills', 'greeter'), { recursive: true });
  writeFileSync(join(root, 'main.ts'), 'const unused = 1;\n');
  writeFileSync(
    join(root, '.daedalus', 'mcp.json'),
    JSON.stringify({ servers: [{ name: 'demo', command: process.execPath, args: [FAKE_MCP] }] }),
  );
  writeFileSync(
    join(root, '.daedalus', 'lsp.json'),
    JSON.stringify({ servers: [{ name: 'fake-lsp', command: process.execPath, args: [FAKE_LSP], extensions: ['.ts'] }] }),
  );
  writeFileSync(join(root, '.daedalus', 'skills', 'greeter', 'SKILL.md'), '---\nname: greeter\ndescription: Greets users warmly\n---\nAlways greet with "Halo" first.');
}

async function startModelServer(): Promise<string> {
  let chatCalls = 0;
  const script: Array<{ name: string; args: unknown } | undefined> = [
    { name: 'read_skill', args: { name: 'greeter' } },
    { name: 'mcp__demo__echo', args: { text: 'halo dari web prompt' } },
    { name: 'write_file', args: { path: 'from-web.txt', content: 'created by Web prompt\n' } },
    { name: 'lsp_diagnostics', args: { path: 'main.ts' } },
    undefined,
  ];
  modelServer = createHttpServer((req, res) => {
    if (req.url === '/v1/models') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ data: [{ id: 'fake-model' }] }));
      return;
    }
    if (req.url === '/v1/chat/completions') {
      req.resume();
      req.on('end', () => {
        const step = script[chatCalls++];
        const message = step
          ? {
              role: 'assistant',
              content: '',
              ...(chatCalls === 1 ? { reasoning_content: 'Read the greeter skill before using the workspace extensions.' } : {}),
              tool_calls: [{ id: `web-call-${chatCalls}`, type: 'function', function: { name: step.name, arguments: JSON.stringify(step.args) } }],
            }
          : { role: 'assistant', content: 'done: web work complete' };
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ choices: [{ message, finish_reason: step ? 'tool_calls' : 'stop' }] }));
      });
      return;
    }
    res.writeHead(404).end();
  });
  await new Promise<void>((resolve) => modelServer?.listen(0, '127.0.0.1', resolve));
  const { port } = modelServer.address() as AddressInfo;
  return `http://127.0.0.1:${port}/v1`;
}

async function waitForTask(base: string, taskId: string): Promise<{ state?: Record<string, unknown>; events: Array<{ type: string; payload: unknown }>; report: { outcome?: string } | null; running: boolean }> {
  let last: Awaited<ReturnType<typeof waitForTask>> | undefined;
  for (let attempt = 0; attempt < 60; attempt++) {
    const res = await fetch(new URL(`/tasks/${taskId}`, base));
    last = await json<typeof last>(res);
    if (last?.report) return last;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`task ${taskId} did not finish: ${JSON.stringify(last)}`);
}

describe('shared local core, Web prompts, extensions, and shared workspace', () => {
  test('a CLI-origin task and file are monitorable/editable through the Web gateway for the same workspace', async () => {
    const { base } = await listen();
    const runner = new TaskRunner({
      workspaceRoot: workspace!,
      provider: cliScriptedProvider(),
      validator: passValidator,
      approvalPolicy: 'auto',
      questionGate: false, // this test pins CLI/Web shared state, not the creation question gate
      settings: loadSettings({ DAEDALUS_HOME: '.daedalus' }),
      thinking: true,
    });
    const result = await runner.run({ goal: 'Create a CLI file\ndone: file created', thinking: true });
    expect(result.outcome).toBe('success');
    const taskId = result.state.id;
    expect(runner.store.root).toBe(join(workspace!, '.daedalus'));

    // An in-progress CLI task has state/events on disk before its report:
    // the gateway must surface it as running, not wait for completion.
    const cliStore = new TaskStore(join(workspace!, '.daedalus'));
    cliStore.saveState('cli-running-task', {
      id: 'cli-running-task',
      goal: 'Long CLI task still running',
      repo_path: workspace,
      constraints: [],
      done_criteria: [],
      created_at: new Date().toISOString(),
      mode: 'plan',
      thinking: true,
      status: 'active',
      steps: [],
    });
    cliStore.append('cli-running-task', { seq: 1, task_id: 'cli-running-task', type: 'TASK_STARTED', payload: {}, ts: new Date().toISOString() });

    const list = await json<{ tasks: Array<{ id: string; status: string; outcome?: string; mode?: string; thinking?: boolean; running: boolean; updated_at: string | null }> }>(
      await fetch(new URL('/tasks', base)),
    );
    expect(list.tasks).toContainEqual(expect.objectContaining({ id: taskId, outcome: 'success', mode: 'auto', thinking: true, running: false }));
    expect(list.tasks).toContainEqual(expect.objectContaining({ id: 'cli-running-task', status: 'active', mode: 'plan', thinking: true, running: true }));

    const events = await json<{ events: Array<{ type: string }>; count: number }>(await fetch(new URL(`/tasks/${taskId}/events`, base)));
    expect(events.count).toBeGreaterThan(0);
    expect(events.events.map((event) => event.type)).toContain('THOUGHT');

    const snapshot = await json<{ state: { goal?: string }; report: { outcome?: string } | null; running: boolean }>(await fetch(new URL(`/tasks/${taskId}`, base)));
    expect(snapshot.state.goal).toBe('Create a CLI file');
    expect(snapshot.report?.outcome).toBe('success');
    expect(snapshot.running).toBe(false);

    const tree = await json<{ children: Array<{ name: string }> }>(
      await fetch(new URL(`/workspace/tree?root=${encodeURIComponent(workspace!)}&path=.&depth=1`, base)),
    );
    expect(tree.children.map((child) => child.name)).toContain('from-cli.txt');
    const file = await json<{ content: string }>(await fetch(new URL(`/workspace/file?root=${encodeURIComponent(workspace!)}&path=from-cli.txt`, base)));
    expect(file.content).toBe('created by CLI run\n');

    const saved = await fetch(new URL('/workspace/file', base), {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ root: workspace, path: 'from-cli.txt', content: 'edited through Web IDE\n' }),
    });
    expect(saved.status).toBe(200);
    expect(readFileSync(join(workspace!, 'from-cli.txt'), 'utf8')).toBe('edited through Web IDE\n');
  });

  test('GET /extensions/status returns real MCP, skill, and LSP entries and honest MCP failures', async () => {
    const { base } = await listen();
    writeExtensionFixtures(workspace!);

    const status = await json<{
      root: string;
      mcp: Array<{ name: string; connected: boolean; toolCount: number; error?: string }>;
      skills: Array<{ name: string; description: string }>;
      lsp: Array<{ name: string; extensions: string[]; configured: boolean }>;
      problems: string[];
    }>(await fetch(new URL(`/extensions/status?root=${encodeURIComponent(workspace!)}`, base)));
    expect(status.root).toBe(workspace);
    expect(status.mcp).toEqual([{ name: 'demo', connected: true, toolCount: 3 }]);
    expect(status.skills).toEqual([{ name: 'greeter', description: 'Greets users warmly', origin: 'workspace', disabled: false }]);
    expect(status.lsp).toEqual([{ name: 'fake-lsp', extensions: ['.ts'], configured: true, running: false }]);
    expect(status.problems).toEqual([]);

    const brokenRoot = join(workspace!, 'broken-extensions');
    mkdirSync(join(brokenRoot, '.daedalus'), { recursive: true });
    writeFileSync(join(brokenRoot, '.daedalus', 'mcp.json'), JSON.stringify({ servers: [{ name: 'broken', command: 'daedalus-nonexistent-mcp-binary', args: [] }] }));
    const broken = await json<{ mcp: Array<{ name: string; connected: boolean; toolCount: number; error?: string }> }>(
      await fetch(new URL(`/extensions/status?root=${encodeURIComponent(brokenRoot)}`, base)),
    );
    expect(broken.mcp[0]).toMatchObject({ name: 'broken', connected: false, toolCount: 0 });
    expect(broken.mcp[0]?.error).toBeTruthy();
  });

  test('GET /extensions/status also surfaces global skills with their origin', async () => {
    const { base } = await listen();
    writeExtensionFixtures(workspace!);
    const globalSkills = mkdtempSync(join(tmpdir(), 'daedalus-global-skills-'));
    mkdirSync(join(globalSkills, 'oracle'), { recursive: true });
    writeFileSync(join(globalSkills, 'oracle', 'SKILL.md'), '---\nname: oracle\ndescription: Answers from the global dir\n---\nBe oracular.');

    const previous = process.env.DAEDALUS_SKILLS_DIR;
    process.env.DAEDALUS_SKILLS_DIR = globalSkills;
    try {
      const status = await json<{ skills: Array<{ name: string; description: string; origin?: string }> }>(
        await fetch(new URL(`/extensions/status?root=${encodeURIComponent(workspace!)}`, base)),
      );
      expect(status.skills).toContainEqual({ name: 'greeter', description: 'Greets users warmly', origin: 'workspace', disabled: false });
      expect(status.skills).toContainEqual({ name: 'oracle', description: 'Answers from the global dir', origin: 'global', disabled: false });
    } finally {
      if (previous === undefined) delete process.env.DAEDALUS_SKILLS_DIR;
      else process.env.DAEDALUS_SKILLS_DIR = previous;
      rmSync(globalSkills, { recursive: true, force: true });
    }
  });

  test('a Web prompt creates a shared-store task through the same core with thinking and extension tools', async () => {
    const { base } = await listen();
    writeExtensionFixtures(workspace!);
    writeFileSync(join(workspace!, 'validate.js'), 'process.exit(0);\n');
    writeFileSync(join(workspace!, 'package.json'), JSON.stringify({ scripts: { test: 'node validate.js', lint: 'node validate.js', build: 'node validate.js' } }));
    const modelBase = await startModelServer();
    const provider = await fetch(new URL('/providers', base), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: 'fake', name: 'Fake', baseUrl: modelBase, apiKey: 'fake-key', models: ['fake-model'] }),
    });
    expect(provider.status).toBe(201);

    const createdRes = await fetch(new URL('/tasks', base), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        goal: 'Use the workspace extensions\ndone: skill read\ndone: mcp echo called\ndone: web file created\ndone: inspect diagnostics',
        repo_path: workspace,
        mode: 'auto',
        auto_approve: true,
        thinking: true,
        provider_id: 'fake',
        model: 'fake-model',
      }),
    });
    expect(createdRes.status).toBe(201);
    const created = await json<{ id: string; thinking?: boolean }>(createdRes);
    expect(created.thinking).toBe(true);

    const snapshot = await waitForTask(base, created.id);
    expect(snapshot.report?.outcome).toBe('success');
    const types = snapshot.events.map((event) => event.type);
    expect(types).toContain('THOUGHT');
    const startedTools = snapshot.events
      .filter((event) => event.type === 'TOOL_CALL_STARTED')
      .map((event) => (event.payload as { call?: { tool?: string } }).call?.tool);
    expect(startedTools).toEqual(expect.arrayContaining(['read_skill', 'mcp__demo__echo', 'lsp_diagnostics', 'write_file']));
    expect(existsSync(join(workspace!, 'from-web.txt'))).toBe(true);

    const eventsRes = await fetch(new URL(`/tasks/${created.id}/events`, base));
    expect(eventsRes.status).toBe(200);
    const list = await json<{ tasks: Array<{ id: string; outcome?: string; mode?: string; thinking?: boolean }> }>(await fetch(new URL('/tasks', base)));
    expect(list.tasks).toContainEqual(expect.objectContaining({ id: created.id, outcome: 'success', mode: 'auto', thinking: true }));
  });

  test('session thinking can be updated like auto-approve', async () => {
    const { base } = await listen();
    const initial = await json<{ session: { thinking: boolean } }>(await fetch(new URL('/session', base)));
    expect(initial.session.thinking).toBe(true);
    const updated = await fetch(new URL('/session', base), {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ thinking: false }),
    });
    expect((await json<{ session: { thinking: boolean } }>(updated)).session.thinking).toBe(false);
  });
});
