import { afterEach, describe, expect, test } from 'vitest';
import type { AddressInfo } from 'node:net';
import { createServer as createHttpServer, type Server as HttpServer } from 'node:http';
import { existsSync, mkdtempSync, readFileSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventBus, ProviderRegistryStore, TaskStore, loadSettings } from '@daedalus/core';
import { createContext, createApp, attachWebSocket, type EventChannel } from '../src/app.ts';

let server: ReturnType<typeof createApp> | undefined;
let channel: EventChannel | undefined;
let modelServer: HttpServer | undefined;
let tmp: string | undefined;
let workspace: string | undefined;
let providerHome: string | undefined;
let webRoot: string | undefined;

afterEach(async () => {
  channel?.close();
  channel = undefined;
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
  if (webRoot) rmSync(webRoot, { recursive: true, force: true });
  webRoot = undefined;
});

async function listen(options: { webDist?: string } = {}): Promise<{ base: string; ctx: ReturnType<typeof createContext> }> {
  tmp = mkdtempSync(join(tmpdir(), 'daedalus-server85-'));
  workspace = mkdtempSync(join(tmpdir(), 'daedalus-server85-ws-'));
  providerHome = mkdtempSync(join(tmpdir(), 'daedalus-provider-home-'));
  mkdirSync(join(workspace, 'src'), { recursive: true });
  writeFileSync(join(workspace, 'src', 'index.ts'), 'export const a = 1\n');
  const settings = loadSettings({
    DAEDALUS_HOME: join(tmp, 'home'),
    LLM_API_KEY: 'settings-secret-value',
    LLM_MODEL: 'settings-model',
    LLM_BASE_URL: 'https://example.invalid/v1',
  });
  const ctx = createContext({
    store: new TaskStore(join(tmp, 'state')),
    bus: new EventBus(),
    cwd: workspace,
    settings,
    providerStore: new ProviderRegistryStore(providerHome),
    webDist: options.webDist,
  });
  server = createApp(ctx);
  channel = attachWebSocket(ctx, server);
  await new Promise<void>((resolve) => server?.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return { base: `http://127.0.0.1:${port}`, ctx };
}

async function startModelServer(): Promise<string> {
  let chatCalls = 0;
  modelServer = createHttpServer((req, res) => {
    if (req.url === '/v1/models') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ data: [{ id: 'gpt-4o' }, { id: 'plain-text-model' }] }));
      return;
    }
    if (req.url === '/v1/chat/completions') {
      req.resume();
      req.on('end', () => {
        chatCalls++;
        const tool = chatCalls === 1
          ? { name: 'create_dir', arguments: JSON.stringify({ path: 'app/src' }) }
          : chatCalls === 2
            ? { name: 'write_file', arguments: JSON.stringify({ path: 'app/src/index.txt', content: 'hello from fake provider\n' }) }
            : undefined;
        const message = tool
          ? { role: 'assistant', content: '', tool_calls: [{ id: `call-${chatCalls}`, type: 'function', function: tool }] }
          : { role: 'assistant', content: 'done: work complete' };
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ choices: [{ message, finish_reason: tool ? 'tool_calls' : 'stop' }] }));
      });
      return;
    }
    res.writeHead(404).end();
  });
  await new Promise<void>((resolve) => modelServer?.listen(0, '127.0.0.1', resolve));
  const { port } = modelServer.address() as AddressInfo;
  return `http://127.0.0.1:${port}/v1`;
}

async function json<T>(res: Response): Promise<T> {
  return (await res.json()) as T;
}

function crc32(data: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of data) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function zipStored(entries: Array<{ path: string; content: string }>): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.path);
    const data = Buffer.from(entry.content);
    const crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0, 6);
    local.writeUInt16LE(0, 8);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);
    locals.push(local, name, data);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, name);
    offset += local.length + name.length + data.length;
  }
  const centralStart = offset;
  const central = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(central.length, 12);
  eocd.writeUInt32LE(centralStart, 16);
  return Buffer.concat([...locals, central, eocd]);
}

describe('settings, session, providers', () => {
  test('settings are redacted and session mode can be updated/cycled', async () => {
    const { base } = await listen();
    const settingsRes = await fetch(new URL('/settings', base));
    const settingsText = await settingsRes.text();
    expect(settingsRes.status).toBe(200);
    expect(settingsText).not.toContain('settings-secret-value');
    const settings = JSON.parse(settingsText) as { session: { mode: string }; settings: { llm: { apiKey: string } } };
    expect(settings.session.mode).toBe('auto');
    expect(settings.settings.llm.apiKey).toBe('«redacted»');

    const updated = await fetch(new URL('/session', base), {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ mode: 'plan', autoApprove: true, model: 'm1' }),
    });
    expect((await json<{ session: unknown }>(updated)).session).toMatchObject({ mode: 'plan', autoApprove: true, model: 'm1' });

    const cycled = await fetch(new URL('/session/mode', base), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ cycle: true }),
    });
    expect((await json<{ session: { mode: string } }>(cycled)).session.mode).toBe('ask');

    // The retired orchestrator mode still loads, mapped to auto.
    const legacy = await fetch(new URL('/session', base), {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ mode: 'orchestrator' }),
    });
    expect(legacy.status).toBe(200);
    expect((await json<{ session: { mode: string } }>(legacy)).session.mode).toBe('auto');

    const invalid = await fetch(new URL('/session', base), {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ mode: 'bogus' }),
    });
    expect(invalid.status).toBe(400);
  });

  test('serves the built Web UI from the server root and assets', async () => {
    webRoot = mkdtempSync(join(tmpdir(), 'daedalus-web-dist-'));
    const dist = join(webRoot, 'dist');
    mkdirSync(join(dist, 'assets'), { recursive: true });
    writeFileSync(join(dist, 'index.html'), '<!doctype html><div id="root">Daedalus Web</div>');
    writeFileSync(join(dist, 'assets', 'app.js'), 'console.log("daedalus-web");');
    writeFileSync(join(webRoot, 'outside-secret.txt'), 'outside-secret');

    const { base } = await listen({ webDist: dist });
    const root = await fetch(new URL('/', base));
    expect(root.status).toBe(200);
    expect(root.headers.get('content-type')).toContain('text/html');
    expect(await root.text()).toContain('Daedalus Web');

    const asset = await fetch(new URL('/assets/app.js', base));
    expect(asset.status).toBe(200);
    expect(asset.headers.get('content-type')).toContain('text/javascript');
    expect(await asset.text()).toContain('daedalus-web');

    const spa = await fetch(new URL('/sessions/example', base), { headers: { accept: 'text/html' } });
    expect(spa.status).toBe(200);
    expect(await spa.text()).toContain('Daedalus Web');

    const traversal = await fetch(new URL('/%2e%2e%2foutside-secret.txt', base));
    expect(await traversal.text()).not.toContain('outside-secret');
  });

  test('provider CRUD masks keys, tests a real /models endpoint, and lists vision models', async () => {
    const { base } = await listen();
    const modelBase = await startModelServer();

    const createdRes = await fetch(new URL('/providers', base), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: 'fake', name: 'Fake', baseUrl: modelBase, apiKey: 'super-secret-key', models: ['local-model'], supportsVision: true }),
    });
    const createdText = await createdRes.text();
    expect(createdRes.status).toBe(201);
    expect(createdText).not.toContain('super-secret-key');
    expect(JSON.parse(createdText).provider).toMatchObject({ id: 'fake', hasApiKey: true });

    const listedText = await (await fetch(new URL('/providers', base))).text();
    expect(listedText).not.toContain('super-secret-key');
    expect(listedText).toContain('9Router');

    const tested = await fetch(new URL('/providers/fake/test', base), { method: 'POST' });
    expect(tested.status).toBe(200);
    expect(await json<{ ok: boolean; models: string[] }>(tested)).toMatchObject({ ok: true });

    const models = await fetch(new URL('/models?provider_id=fake', base));
    const modelBody = await json<{ models: Array<{ model: string; supportsVision: boolean }> }>(models);
    expect(modelBody.models).toContainEqual({ providerId: 'fake', model: 'gpt-4o', supportsVision: true });
    expect(modelBody.models).toContainEqual({ providerId: 'fake', model: 'plain-text-model', supportsVision: false });
    expect(modelBody.models.map((model) => model.model)).toContain('local-model');

    await fetch(new URL('/providers/nine-router/enabled', base), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ enabled: false }),
    });
    const union = await fetch(new URL('/models', base));
    const unionBody = await json<{ models: Array<{ providerId: string }> }>(union);
    expect(unionBody.models.every((model) => model.providerId === 'fake')).toBe(true);

    const removed = await fetch(new URL('/providers/fake', base), { method: 'DELETE' });
    expect(removed.status).toBe(200);
    expect((await fetch(new URL('/providers/fake', base))).status).toBe(404);
  });

  test('runs a greenfield task through the Web gateway task API with a fake provider', async () => {
    const { base } = await listen();
    const modelBase = await startModelServer();
    const created = await fetch(new URL('/providers', base), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: 'fake', name: 'Fake', baseUrl: modelBase, apiKey: 'fake-key', models: ['fake-model'] }),
    });
    expect(created.status).toBe(201);
    writeFileSync(join(workspace!, 'validate.js'), 'process.exit(0);\n');
    writeFileSync(join(workspace!, 'package.json'), JSON.stringify({ scripts: { test: 'node validate.js', lint: 'node validate.js', build: 'node validate.js' } }));

    const taskRes = await fetch(new URL('/tasks', base), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        goal: 'Create the app folder and index file',
        repo_path: workspace,
        provider_id: 'fake',
        model: 'fake-model',
        mode: 'auto',
        auto_approve: true,
        done_criteria: ['app/src directory exists', 'app/src/index.txt exists'],
      }),
    });
    expect(taskRes.status).toBe(201);
    const task = await json<{ id: string }>(taskRes);

    let snapshot: { state: { status: string }; report: { outcome: string } | null } | undefined;
    for (let attempt = 0; attempt < 50; attempt++) {
      const res = await fetch(new URL(`/tasks/${task.id}`, base));
      snapshot = await json<typeof snapshot>(res) as typeof snapshot;
      if (snapshot?.state.status === 'done' || snapshot?.state.status === 'failed' || snapshot?.report) break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    expect(snapshot?.state.status).toBe('done');
    expect(snapshot?.report?.outcome).toBe('success');
    expect(readFileSync(join(workspace!, 'app/src/index.txt'), 'utf8')).toBe('hello from fake provider\n');
  }, 15_000);
});

describe('workspace creation and mutation', () => {
  test('creates workspaces, folders, files, renames, and rejects traversal', async () => {
    const { base } = await listen();
    const created = await fetch(new URL('/workspace/create', base), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'project-a' }),
    });
    expect(created.status).toBe(201);
    const createdBody = await json<{ path: string }>(created);
    expect(existsSync(createdBody.path)).toBe(true);

    const folder = await fetch(new URL('/workspace/folders', base), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ root: createdBody.path, path: 'src/components' }),
    });
    expect(folder.status).toBe(201);
    expect(existsSync(join(createdBody.path, 'src/components'))).toBe(true);

    const file = await fetch(new URL('/workspace/files', base), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ root: createdBody.path, path: 'src/index.ts', content: 'export const x = 1\n' }),
    });
    expect(file.status).toBe(201);
    const duplicate = await fetch(new URL('/workspace/files', base), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ root: createdBody.path, path: 'src/index.ts', content: 'again' }),
    });
    expect(duplicate.status).toBe(409);

    const renamed = await fetch(new URL('/workspace/rename', base), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ root: createdBody.path, from: 'src/index.ts', to: 'src/main.ts' }),
    });
    expect(renamed.status).toBe(200);
    expect(readFileSync(join(createdBody.path, 'src/main.ts'), 'utf8')).toContain('x = 1');

    const traversal = await fetch(new URL('/workspace/create', base), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ path: '../evil' }),
    });
    expect([400, 403]).toContain(traversal.status);
    expect(existsSync(join(workspace as string, '..', 'evil'))).toBe(false);

    const outsideRoot = await fetch(new URL('/workspace/tree?root=/etc&path=.&depth=1', base));
    expect(outsideRoot.status).toBe(403);
  });
});

describe('uploads and attachments', () => {
  test('stores JSON file uploads under the task attachment area and records ATTACHMENT_ADDED', async () => {
    const { base } = await listen();
    const res = await fetch(new URL('/uploads', base), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        root: workspace,
        task_id: 'task-123',
        files: [{ name: 'hello.txt', path: 'docs/hello.txt', contentBase64: Buffer.from('hello upload').toString('base64') }],
      }),
    });
    expect(res.status).toBe(201);
    const body = await json<{ attachments: Array<{ workspacePath: string; kind: string; sha256?: string }>; files: Array<{ path: string }> }>(res);
    expect(body.attachments[0]).toMatchObject({ workspacePath: '.daedalus/attachments/task-123/docs/hello.txt', kind: 'file' });
    expect(body.attachments[0]?.sha256).toHaveLength(64);
    expect(readFileSync(join(workspace as string, '.daedalus/attachments/task-123/docs/hello.txt'), 'utf8')).toBe('hello upload');

    const attachments = await fetch(new URL('/tasks/task-123/attachments', base));
    expect((await json<{ count: number }>(attachments)).count).toBe(1);
  });

  test('preserves folder structure, attaches images, and extracts ZIP archives', async () => {
    const { base } = await listen();
    const folder = await fetch(new URL('/uploads', base), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        root: workspace,
        kind: 'folder',
        destination: 'imports',
        files: [
          { name: 'a.txt', path: 'myfolder/a.txt', contentBase64: Buffer.from('A').toString('base64') },
          { name: 'b.txt', path: 'myfolder/sub/b.txt', contentBase64: Buffer.from('B').toString('base64') },
          { name: 'pic.png', path: 'myfolder/pic.png', contentBase64: Buffer.from('PNG').toString('base64'), mimeType: 'image/png' },
        ],
      }),
    });
    expect(folder.status).toBe(201);
    const folderBody = await json<{ attachments: Array<{ kind: string }>; files: Array<{ path: string }> }>(folder);
    expect(folderBody.attachments.map((attachment) => attachment.kind)).toContain('folder');
    expect(readFileSync(join(workspace as string, 'imports/myfolder/sub/b.txt'), 'utf8')).toBe('B');

    const zip = zipStored([
      { path: 'pkg/index.txt', content: 'inside zip' },
      { path: 'pkg/data.json', content: '{"ok":true}' },
    ]);
    const zipRes = await fetch(new URL('/uploads', base), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        root: workspace,
        task_id: 'task-zip',
        files: [{ name: 'bundle.zip', path: 'bundle.zip', contentBase64: zip.toString('base64') }],
      }),
    });
    expect(zipRes.status).toBe(201);
    const zipBody = await json<{ attachments: Array<{ kind: string }>; files: Array<{ path: string }> }>(zipRes);
    expect(zipBody.attachments.map((attachment) => attachment.kind)).toContain('zip');
    expect(readFileSync(join(workspace as string, '.daedalus/attachments/task-zip/bundle/pkg/index.txt'), 'utf8')).toBe('inside zip');
  });

  test('accepts multipart uploads and rejects traversal and too many files', async () => {
    const { base } = await listen();
    const form = new FormData();
    form.set('root', workspace as string);
    form.set('destination', 'multipart');
    form.append('file', new Blob(['multipart hello'], { type: 'text/plain' }), 'folder/readme.md');
    const multipart = await fetch(new URL('/uploads', base), { method: 'POST', body: form });
    expect(multipart.status).toBe(201);
    expect(readFileSync(join(workspace as string, 'multipart/folder/readme.md'), 'utf8')).toBe('multipart hello');

    const traversal = await fetch(new URL('/uploads', base), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ root: workspace, files: [{ name: 'evil.txt', path: '../evil.txt', contentBase64: Buffer.from('x').toString('base64') }] }),
    });
    expect([400, 403]).toContain(traversal.status);
    expect(existsSync(join(workspace as string, '..', 'evil.txt'))).toBe(false);

    const tooMany = await fetch(new URL('/uploads', base), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        root: workspace,
        files: Array.from({ length: 21 }, (_, index) => ({ name: `f${index}.txt`, path: `f${index}.txt`, contentBase64: Buffer.from('x').toString('base64') })),
      }),
    });
    expect(tooMany.status).toBe(413);
  });
});

describe('task request validation', () => {
  test('invalid repo_path and mode return HTTP errors instead of crashing the server', async () => {
    const { base } = await listen();
    const outside = await fetch(new URL('/tasks', base), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ goal: 'do work', repo_path: '/etc' }),
    });
    expect(outside.status).toBe(403);

    const invalidMode = await fetch(new URL('/tasks', base), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ goal: 'do work', mode: 'bogus' }),
    });
    expect(invalidMode.status).toBe(400);
    expect((await fetch(new URL('/health', base))).status).toBe(200);
  });
});
