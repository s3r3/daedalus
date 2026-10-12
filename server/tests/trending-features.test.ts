import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer as createHttpServer, type Server as HttpServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, test } from 'vitest';
import { EventBus, ProviderRegistryStore, TaskStore, loadSettings } from '@daedalus/core';
import { createApp, createContext } from '../src/app.ts';

let app: ReturnType<typeof createApp> | undefined;
let modelServer: HttpServer | undefined;
const dirs: string[] = [];

function temp(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

afterEach(async () => {
  if (app) await new Promise<void>((resolve) => app?.close(() => resolve()));
  app = undefined;
  if (modelServer) await new Promise<void>((resolve) => modelServer?.close(() => resolve()));
  modelServer = undefined;
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
  delete process.env.DAEDALUS_WORKSPACE;
});

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' });
}

function makeGitRepo(): string {
  const repo = temp('daedalus-server-wt-');
  git(repo, ['init', '-q']);
  git(repo, ['config', 'user.email', 'test@example.com']);
  git(repo, ['config', 'user.name', 'Daedalus Test']);
  writeFileSync(join(repo, 'README.md'), '# fixture\n');
  // Committed so the worktree checkout sees the passing validation profile.
  mkdirSync(join(repo, '.daedalus'), { recursive: true });
  writeFileSync(join(repo, '.daedalus', 'validate.json'), JSON.stringify({ checks: [{ name: 'sanity', command: 'echo ok' }] }), 'utf8');
  git(repo, ['add', '-A']);
  git(repo, ['commit', '-qm', 'initial']);
  return repo;
}

async function startModelServer(script: Array<{ tool: string; args: unknown } | string>): Promise<string> {
  let calls = 0;
  modelServer = createHttpServer((req, res) => {
    if (req.url === '/v1/models') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ data: [{ id: 'fake-model' }] }));
      return;
    }
    if (req.url === '/v1/chat/completions') {
      req.resume();
      req.on('end', () => {
        const step = script[calls++];
        const message = typeof step === 'string'
          ? { role: 'assistant', content: step }
          : step
            ? { role: 'assistant', content: '', tool_calls: [{ id: `call-${calls}`, type: 'function', function: { name: step.tool, arguments: JSON.stringify(step.args) } }] }
            : { role: 'assistant', content: 'done: finished' };
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ choices: [{ message, finish_reason: step && typeof step !== 'string' ? 'tool_calls' : 'stop' }] }));
      });
      return;
    }
    res.writeHead(404).end();
  });
  await new Promise<void>((resolve) => modelServer?.listen(0, '127.0.0.1', resolve));
  return `http://127.0.0.1:${(modelServer.address() as AddressInfo).port}/v1`;
}

async function startApp(workspace: string, baseUrl?: string): Promise<{ base: string; providerStore: ProviderRegistryStore }> {
  const home = temp('daedalus-server-home-');
  const settings = loadSettings({
    DAEDALUS_HOME: '.daedalus',
    LLM_BASE_URL: baseUrl ?? 'https://example.invalid/v1',
    LLM_MODEL: 'fake-model',
  });
  const providerStore = new ProviderRegistryStore(join(home, 'providers'));
  if (baseUrl) providerStore.registry.upsert({ id: 'fake', name: 'Fake', baseUrl, apiKey: 'test', models: ['fake-model'] });
  const ctx = createContext({
    store: new TaskStore(join(home, 'state')),
    bus: new EventBus(),
    cwd: workspace,
    settings,
    providerStore,
  });
  app = createApp(ctx);
  await new Promise<void>((resolve) => app?.listen(0, '127.0.0.1', resolve));
  return { base: `http://127.0.0.1:${(app.address() as AddressInfo).port}`, providerStore };
}

async function json<T>(res: Response): Promise<T> {
  return (await res.json()) as T;
}

async function waitForReport(base: string, taskId: string): Promise<{ report: { outcome?: string; worktree?: { path: string; branch: string; files_changed: string[] } } | null }> {
  // The inner worktree run saves its report first; the outer runner then
  // overwrites it with the worktree-augmented copy — poll until that lands.
  for (let attempt = 0; attempt < 100; attempt++) {
    const res = await fetch(`${base}/tasks/${taskId}`);
    const body = await json<{ report: { outcome?: string; worktree?: { path: string; branch: string; files_changed: string[] } } | null; running?: boolean }>(res);
    if (body.report?.worktree && !body.running) return body;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`task ${taskId} never produced a worktree report`);
}

describe('trending features — server', () => {
  test('extensions status includes file-defined subagents', async () => {
    const workspace = temp('daedalus-server-ext-');
    mkdirSync(join(workspace, '.daedalus', 'agents'), { recursive: true });
    writeFileSync(join(workspace, '.daedalus', 'agents', 'reader.md'), '---\nname: reader\ndescription: Reads code\ntools: [read_file]\n---\nRead only.');
    const { base } = await startApp(workspace);
    const status = await json<{ agents: Array<{ name: string; description: string; tools: string[] }> }>(await fetch(`${base}/extensions/status`));
    expect(status.agents).toEqual([expect.objectContaining({ name: 'reader', description: 'Reads code', tools: ['read_file'] })]);
  });

  test('/health reports the anchored workspace root (DAEDALUS_WORKSPACE wins over cwd)', async () => {
    const workspace = temp('daedalus-server-anchor-');
    const fallback = temp('daedalus-server-cwd-');
    process.env.DAEDALUS_WORKSPACE = workspace;
    const home = temp('daedalus-server-anchor-home-');
    const ctx = createContext({
      store: new TaskStore(join(home, 'state')),
      bus: new EventBus(),
      cwd: fallback,
      settings: loadSettings({ DAEDALUS_HOME: '.daedalus', LLM_BASE_URL: 'https://example.invalid/v1', LLM_MODEL: 'fake-model' }),
      providerStore: new ProviderRegistryStore(join(home, 'providers')),
    });
    app = createApp(ctx);
    await new Promise<void>((resolve) => app?.listen(0, '127.0.0.1', resolve));
    const base = `http://127.0.0.1:${(app.address() as AddressInfo).port}`;
    const health = await json<{ workspace_root: string }>(await fetch(`${base}/health`));
    expect(health.workspace_root).toBe(workspace);
  });

  test('POST /review returns structured findings; no diff is an honest empty result', async () => {
    const workspace = temp('daedalus-server-review-');
    const baseUrl = await startModelServer(['- **[high] src/pay.ts:42** — amount is not validated before the transfer']);
    const { base } = await startApp(workspace, baseUrl);

    const ok = await fetch(`${base}/review`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ diff: 'diff --git a/src/pay.ts b/src/pay.ts\n+transfer(amount)' }),
    });
    expect(ok.status).toBe(200);
    const review = await json<{ source: string; findings: Array<{ severity: string; file: string; line?: number; message: string }> }>(ok);
    expect(review.source).toBe('provided');
    expect(review.findings).toEqual([{ severity: 'high', file: 'src/pay.ts', line: 42, message: 'amount is not validated before the transfer' }]);

    const empty = await fetch(`${base}/review`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    expect(empty.status).toBe(200);
    const emptyReview = await json<{ findings: unknown[]; raw: string }>(empty);
    expect(emptyReview.findings).toEqual([]);
    expect(emptyReview.raw).toContain('No diff to review');
  });

  test('POST /tasks validates isolation and runs a worktree task end-to-end', async () => {
    const repo = makeGitRepo();
    const baseUrl = await startModelServer([
      { tool: 'write_file', args: { path: 'isolated.txt', content: 'in the worktree\n' } },
    ]);
    const { base } = await startApp(repo, baseUrl);

    const bad = await fetch(`${base}/tasks`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ goal: 'x', isolation: 'bogus' }),
    });
    expect(bad.status).toBe(400);
    expect((await json<{ error: string }>(bad)).error).toContain('isolation');

    const created = await fetch(`${base}/tasks`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ goal: 'Create isolated.txt\ndone: isolated.txt exists', isolation: 'worktree', auto_approve: true }),
    });
    expect(created.status).toBe(201);
    const task = await json<{ id: string }>(created);
    const finished = await waitForReport(base, task.id);
    const worktree = finished.report?.worktree;
    expect(worktree).toBeDefined();
    expect(worktree?.branch).toMatch(/^daedalus\//);
    expect(worktree?.files_changed).toContain('isolated.txt');
    expect(existsSync(join(repo, 'isolated.txt'))).toBe(false);
    expect(readFileSync(join(worktree!.path, 'isolated.txt'), 'utf8')).toBe('in the worktree\n');
  });
});
