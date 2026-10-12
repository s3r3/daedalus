import { afterEach, describe, expect, test } from 'vitest';
import { execFile } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

const execFileAsync = promisify(execFile);
const dirs: string[] = [];
let providerServer: Server | undefined;

function temp(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

afterEach(async () => {
  if (providerServer) await new Promise<void>((resolve) => providerServer?.close(() => resolve()));
  providerServer = undefined;
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

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
            ? { name: 'write_file', arguments: JSON.stringify({ path: 'app/src/index.txt', content: 'hello from cli integration\n' }) }
            : undefined;
        const message = tool
          ? { role: 'assistant', content: '', tool_calls: [{ id: `cli-call-${chatCalls}`, type: 'function', function: tool }] }
          : { role: 'assistant', content: 'done: work complete' };
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ choices: [{ message, finish_reason: tool ? 'tool_calls' : 'stop' }] }));
      });
      return;
    }
    res.writeHead(404).end();
  });
  await new Promise<void>((resolve) => providerServer?.listen(0, '127.0.0.1', resolve));
  const address = providerServer.address();
  if (!address || typeof address === 'string') throw new Error('fake provider did not bind');
  return `http://127.0.0.1:${address.port}/v1`;
}

describe('Phase 9 — CLI integration', () => {
  test('daedalus run streams JSON events, exits 0, and creates the fixture change', async () => {
    const workspace = temp('daedalus-p9-cli-ws-');
    const home = temp('daedalus-p9-cli-home-');
    writeFileSync(join(workspace, 'validate.js'), 'process.exit(0);\n');
    writeFileSync(join(workspace, 'package.json'), JSON.stringify({ scripts: { test: 'node validate.js', lint: 'node validate.js', build: 'node validate.js' } }));
    const baseUrl = await startFakeProvider();
    const cliPath = fileURLToPath(new URL('../src/index.ts', import.meta.url));

    const { stdout } = await execFileAsync(process.execPath, [
      '--experimental-strip-types',
      cliPath,
      'run',
      'Create the app\ndone: app/src directory exists\ndone: app/src/index.txt exists',
      '--cwd', workspace,
      '--yolo',
      '--json',
      '--model', 'fake-model',
    ], {
      cwd: workspace,
      timeout: 30_000,
      maxBuffer: 1024 * 1024,
      env: {
        ...process.env,
        DAEDALUS_HOME: home,
        LLM_BASE_URL: baseUrl,
        LLM_MODEL: 'fake-model',
        LLM_API_KEY: 'fake-key',
        NO_COLOR: '1',
      },
    });

    const lines = stdout.trim().split('\n').map((line) => JSON.parse(line) as Record<string, unknown>);
    const eventTypes = lines.filter((line) => typeof line.type === 'string').map((line) => line.type);
    const final = lines.at(-1) as { outcome?: string; report?: { outcome?: string } };

    expect(eventTypes).toEqual(expect.arrayContaining(['TASK_STARTED', 'PLAN_CREATED', 'TOOL_CALL_STARTED', 'VALIDATION_PASSED', 'TASK_COMPLETED']));
    expect(final).toMatchObject({ outcome: 'success', report: { outcome: 'success' } });
    expect(existsSync(join(workspace, 'app/src/index.txt'))).toBe(true);
    expect(readFileSync(join(workspace, 'app/src/index.txt'), 'utf8')).toBe('hello from cli integration\n');
  }, 30_000);
});
