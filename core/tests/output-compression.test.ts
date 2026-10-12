import { describe, expect, test } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  AgentLoop,
  EventBus,
  OUTPUT_COMPRESSION_MIN_CHARS,
  TaskRunner,
  TaskStore,
  commandLineForCall,
  compressCommandOutput,
  detectCommandOutputFamily,
  loadSettings,
  type LLMProvider,
  type ToolResult,
} from '../src/index.ts';

function tmpStore(): { store: TaskStore; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'daedalus-compression-'));
  return { store: new TaskStore(dir), cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

function tempDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

/** Provider that answers queued replies in order, then finishes with text. */
function queuedProvider(replies: Array<{ tool?: string; args?: unknown; text?: string }>): LLMProvider {
  let index = 0;
  return {
    name: 'queued',
    async chat() {
      const reply = replies[index++] ?? { text: 'done: finished' };
      if (reply.tool) {
        return {
          message: {
            role: 'assistant',
            content: '',
            tool_calls: [{ id: `c${index}`, type: 'function' as const, function: { name: reply.tool, arguments: JSON.stringify(reply.args ?? {}) } }],
          },
        };
      }
      return { message: { role: 'assistant', content: reply.text ?? 'done: finished' } };
    },
    async *stream() {
      yield { type: 'delta', content: '' };
    },
  };
}

function scriptedProvider(script: Array<{ tool: string; args: unknown }>): LLMProvider {
  let index = 0;
  return {
    name: 'scripted',
    async chat() {
      const step = script[index++];
      if (!step) return { message: { role: 'assistant', content: 'done: script exhausted' } };
      return {
        message: {
          role: 'assistant',
          content: '',
          tool_calls: [{ id: `c${index}`, type: 'function' as const, function: { name: step.tool, arguments: JSON.stringify(step.args) } }],
        },
      };
    },
    async *stream() {
      yield { type: 'delta', content: '' };
    },
  };
}

// ---------------------------------------------------------------- fixtures

function gitStatusOutput(): string {
  const modified = Array.from({ length: 60 }, (_, i) => `\tmodified:   src/module-${String(i).padStart(2, '0')}.ts`);
  const untracked = Array.from({ length: 40 }, (_, i) => `\tscratch-${i}.txt`);
  return [
    'On branch main',
    "Your branch is up to date with 'origin/main'.",
    '',
    'Changes not staged for commit:',
    '  (use "git add <file>..." to update what will be committed)',
    ...modified,
    '',
    'Untracked files:',
    '  (use "git add <file>..." to include in what will be committed)',
    ...untracked,
    '',
    'no changes added to commit (use "git add" and/or "git commit -a")',
  ].join('\n');
}

function vitestOutput(): string {
  const passing = Array.from({ length: 60 }, (_, i) => ` ✓ tests/unit/module-${String(i).padStart(2, '0')}.test.ts (3 tests) 12ms`);
  return [
    ' RUN  v2.1.0 /repo',
    '',
    ...passing,
    '',
    ' FAIL  tests/unit/broken.test.ts > parser > rejects the empty flag',
    'AssertionError: expected true to be false',
    ' Test Files  1 failed | 59 passed (60)',
    '      Tests  1 failed | 179 passed (180)',
  ].join('\n');
}

function npmInstallOutput(): string {
  const fetches = Array.from({ length: 50 }, (_, i) => `npm http fetch GET 200 https://registry.npmjs.org/pkg-${i} ${40 + i}ms (cache hit)`);
  const deprecated = Array.from({ length: 5 }, () => 'npm warn deprecated inflight@1.0.6: This module is not supported');
  return [
    ...fetches.slice(0, 25),
    ...deprecated,
    ...fetches.slice(25),
    'added 214 packages, and audited 215 packages in 12s',
    'found 0 vulnerabilities',
  ].join('\n');
}

function viteBuildOutput(): string {
  const chunks = Array.from({ length: 60 }, (_, i) => `dist/assets/chunk-${String(i).padStart(2, '0')}.js  ${(i + 1).toFixed(2)} kB │ gzip: 0.40 kB`);
  return [
    'vite v5.4.0 building for production...',
    '✓ 1842 modules transformed.',
    ...chunks,
    'dist/index.html  2.31 kB │ gzip: 1.02 kB',
    '✓ built in 3.42s',
  ].join('\n');
}

function findOutput(): string {
  return Array.from({ length: 120 }, (_, i) => `src/module-${String(i).padStart(3, '0')}/index.ts`).join('\n');
}

// ------------------------------------------------------------------- tests

describe('detectCommandOutputFamily', () => {
  test('classifies the noisy command families', () => {
    expect(detectCommandOutputFamily('git status')).toBe('git');
    expect(detectCommandOutputFamily('git log --oneline -5')).toBe('git');
    expect(detectCommandOutputFamily('git diff HEAD')).toBe('git');
    expect(detectCommandOutputFamily('npm test')).toBe('test');
    expect(detectCommandOutputFamily('npx vitest run')).toBe('test');
    expect(detectCommandOutputFamily('cargo test --release')).toBe('test');
    expect(detectCommandOutputFamily('go test ./...')).toBe('test');
    expect(detectCommandOutputFamily('npm install')).toBe('install');
    expect(detectCommandOutputFamily('pnpm add lodash')).toBe('install');
    expect(detectCommandOutputFamily('pip install requests')).toBe('install');
    expect(detectCommandOutputFamily('tsc -p .')).toBe('build');
    expect(detectCommandOutputFamily('npm run build')).toBe('build');
    expect(detectCommandOutputFamily('cargo build')).toBe('build');
    expect(detectCommandOutputFamily('ls -la src')).toBe('listing');
    expect(detectCommandOutputFamily('find . -type f')).toBe('listing');
    expect(detectCommandOutputFamily('node server.mjs')).toBe('generic');
    expect(detectCommandOutputFamily('python3 scripts/check.py')).toBe('generic');
  });

  test('commandLineForCall flattens run_command args defensively', () => {
    const call = { id: 'c', task_id: 't', turn_id: 'u', tool: 'run_command', args: { command: 'git', args: ['status', '--short'] }, started_at: '' };
    expect(commandLineForCall(call)).toBe('git status --short');
    expect(commandLineForCall({ ...call, args: {} })).toBe('');
    expect(commandLineForCall({ ...call, args: 'nope' })).toBe('');
  });
});

describe('compressCommandOutput', () => {
  test('passes small output through byte-identical', () => {
    const raw = 'short output\nthree lines only\n';
    const result = compressCommandOutput({ commandLine: 'git status', output: raw, status: 'ok', exitCode: 0 });
    expect(result.compressed).toBe(false);
    expect(result.family).toBe('none');
    expect(result.text).toBe(raw);
    expect(result.rawChars).toBe(raw.length);
    expect(result.compressedChars).toBe(raw.length);
    expect(OUTPUT_COMPRESSION_MIN_CHARS).toBe(2_000);
  });

  test('compresses on the line threshold alone (41 short lines)', () => {
    const raw = Array.from({ length: 41 }, (_, i) => `l${i}`).join('\n');
    const result = compressCommandOutput({ commandLine: 'node check.mjs', output: raw, status: 'ok', exitCode: 0 });
    expect(result.compressed).toBe(true);
    expect(result.family).toBe('generic');
    const forty = Array.from({ length: 40 }, (_, i) => `l${i}`).join('\n');
    expect(compressCommandOutput({ commandLine: 'node check.mjs', output: forty, status: 'ok', exitCode: 0 }).compressed).toBe(false);
  });

  test('git status: structure survives, file lists fold', () => {
    const raw = gitStatusOutput();
    const result = compressCommandOutput({ commandLine: 'git status', output: raw, status: 'ok', exitCode: 0 });
    expect(result.compressed).toBe(true);
    expect(result.family).toBe('git');
    expect(result.text).toContain('On branch main');
    expect(result.text).toContain('Changes not staged for commit:');
    expect(result.text).toContain('Untracked files:');
    expect(result.text).toContain('lines omitted by git output compression');
    expect(result.text.split('modified:').length - 1).toBeLessThan(60);
    expect(result.compressedChars).toBe(result.text.length);
    expect(result.compressedChars).toBeLessThan(result.rawChars);
  });

  test('vitest failures stay verbatim while passing noise folds', () => {
    const raw = vitestOutput();
    const result = compressCommandOutput({ commandLine: 'npx vitest run', output: raw, status: 'error', exitCode: 1 });
    expect(result.compressed).toBe(true);
    expect(result.family).toBe('test');
    expect(result.text).toContain(' FAIL  tests/unit/broken.test.ts > parser > rejects the empty flag');
    expect(result.text).toContain('AssertionError: expected true to be false');
    expect(result.text).toContain('Tests  1 failed | 179 passed (180)');
    expect(result.text.split('✓ tests/unit').length - 1).toBeLessThanOrEqual(16);
    expect(result.compressedChars).toBeLessThan(result.rawChars * 0.6);
  });

  test('npm install: summary kept, repeated lines dedupe with counts', () => {
    const raw = npmInstallOutput();
    const result = compressCommandOutput({ commandLine: 'npm install', output: raw, status: 'ok', exitCode: 0 });
    expect(result.compressed).toBe(true);
    expect(result.family).toBe('install');
    expect(result.text).toContain('added 214 packages, and audited 215 packages in 12s');
    expect(result.text).toContain('found 0 vulnerabilities');
    expect(result.text).toContain('npm warn deprecated inflight@1.0.6: This module is not supported (×5)');
    expect(result.text).toContain('lines omitted by install output compression');
    expect(result.compressedChars).toBeLessThan(result.rawChars);
  });

  test('vite build: verdict kept, chunk listing folds', () => {
    const raw = viteBuildOutput();
    const result = compressCommandOutput({ commandLine: 'npm run build', output: raw, status: 'ok', exitCode: 0 });
    expect(result.compressed).toBe(true);
    expect(result.family).toBe('build');
    expect(result.text).toContain('✓ built in 3.42s');
    expect(result.text.split('dist/assets/chunk-').length - 1).toBeLessThan(60);
    expect(result.compressedChars).toBeLessThan(result.rawChars);
  });

  test('listing: head and tail kept, middle omitted', () => {
    const raw = findOutput();
    const result = compressCommandOutput({ commandLine: 'find src -type f', output: raw, status: 'ok', exitCode: 0 });
    expect(result.compressed).toBe(true);
    expect(result.family).toBe('listing');
    expect(result.text).toContain('src/module-000/index.ts');
    expect(result.text).toContain('src/module-119/index.ts');
    expect(result.text).not.toContain('src/module-060/index.ts');
    expect(result.text).toContain('lines omitted by listing output compression');
  });

  test('generic dedupe: a repeated line renders once with its count', () => {
    const raw = ['starting checks', ...Array.from({ length: 80 }, () => 'tick'), 'all done'].join('\n');
    const result = compressCommandOutput({ commandLine: 'node scripts/verify.mjs', output: raw, status: 'ok', exitCode: 0 });
    expect(result.compressed).toBe(true);
    expect(result.text).toContain('tick (×80)');
    expect(result.text.split('\n').filter((line) => line.startsWith('tick'))).toHaveLength(1);
    expect(result.text).toContain('all done');
  });

  test('never inflates: signal-dense output passes through untouched', () => {
    const raw = Array.from({ length: 60 }, (_, i) => `error TS2322: src/file-${i}.ts(3,5): Type 'number' is not assignable`).join('\n');
    const result = compressCommandOutput({ commandLine: 'npm run build', output: raw, status: 'error', exitCode: 2 });
    expect(result.compressed).toBe(false);
    expect(result.text).toBe(raw);
    expect(result.compressedChars).toBe(result.rawChars);
  });

  test('ANSI escapes and carriage-return progress are normalized before filtering', () => {
    const progress = Array.from({ length: 50 }, (_, i) => `\x1b[36m- fetching pkg-${i}\x1b[39m`).join('\n');
    const raw = `${progress}\n\x1b[31merror\x1b[39m something broke badly`;
    const result = compressCommandOutput({ commandLine: 'npm install', output: raw, status: 'error', exitCode: 1 });
    expect(result.compressed).toBe(true);
    expect(result.text).toContain('error something broke badly');
    expect(result.text).not.toContain('\x1b');
  });
});

describe('settings', () => {
  test('outputCompression defaults on, parses off, rejects garbage', () => {
    expect(loadSettings({}).outputCompression).toBe(true);
    expect(loadSettings({ DAEDALUS_OUTPUT_COMPRESSION: 'off' }).outputCompression).toBe(false);
    expect(loadSettings({ DAEDALUS_OUTPUT_COMPRESSION: '0' }).outputCompression).toBe(false);
    expect(() => loadSettings({ DAEDALUS_OUTPUT_COMPRESSION: 'maybe' })).toThrow(/DAEDALUS_OUTPUT_COMPRESSION/);
  });
});

describe('AgentLoop output compression wiring', () => {
  const installResult = (output: string): ToolResult => ({
    call_id: 'c1',
    status: 'ok',
    output,
    truncated: false,
    meta: { exit_code: 0, mutating: true },
  });

  async function runWithCompression(outputCompression: boolean | undefined): Promise<{ state: Awaited<ReturnType<AgentLoop['run']>>; store: TaskStore; cleanup: () => void }> {
    const { store, cleanup } = tmpStore();
    const bus = new EventBus();
    const raw = npmInstallOutput();
    const loop = new AgentLoop({
      provider: queuedProvider([{ tool: 'run_command', args: { command: 'npm', args: ['install'] } }, { text: 'done: deps installed' }]),
      bus,
      store,
      stopPolicy: { max_iterations: 6, max_errors: 3 },
      ...(outputCompression === undefined ? {} : { outputCompression }),
      executeTool: async () => installResult(raw),
    });
    const state = await loop.run('Install deps\ndone: deps installed');
    return { state, store, cleanup };
  }

  test('on (default): model sees compressed text + spill, event log keeps the raw result, meta carries the stats', async () => {
    const { state, store, cleanup } = await runWithCompression(undefined);
    const raw = npmInstallOutput();
    const result = state.tool_result;
    expect(result?.meta?.output_compressed).toBe(true);
    expect(result?.meta?.output_compression_family).toBe('install');
    expect(result?.meta?.output_raw_chars).toBe(raw.length);
    expect(typeof result?.meta?.output_compressed_chars).toBe('number');
    expect(result?.output).toContain('added 214 packages, and audited 215 packages in 12s');
    expect(result?.output).toContain('run_command output compressed for context');
    expect(result?.output).toContain('exit code 0');

    const finished = store.replay(state.id).find((event) => event.type === 'TOOL_CALL_FINISHED');
    const payload = finished?.payload as { result?: ToolResult; output_compressed?: boolean; output_raw_chars?: number; output_compressed_chars?: number };
    expect(payload.output_compressed).toBe(true);
    expect(payload.output_raw_chars).toBe(raw.length);
    expect(payload.output_compressed_chars).toBeLessThan(raw.length);
    // The event log keeps the executor's untouched result, like shaping.
    expect(payload.result?.output).toBe(raw);

    const spillPath = result?.meta?.output_compression_spill_path;
    expect(typeof spillPath).toBe('string');
    expect(existsSync(spillPath as string)).toBe(true);
    expect(readFileSync(spillPath as string, 'utf8')).toBe(raw);
    expect(result?.output).toContain(spillPath as string);
    cleanup();
  });

  test('off: the tool result reaches the model byte-identical', async () => {
    const { state, store, cleanup } = await runWithCompression(false);
    const raw = npmInstallOutput();
    expect(state.tool_result?.output).toBe(raw);
    expect(state.tool_result?.meta?.output_compressed).toBeUndefined();
    const finished = store.replay(state.id).find((event) => event.type === 'TOOL_CALL_FINISHED');
    expect((finished?.payload as { output_compressed?: boolean }).output_compressed).toBeUndefined();
    cleanup();
  });

  test('failing commands keep their status and exit code verbatim in the model-facing text', async () => {
    const { store, cleanup } = tmpStore();
    const bus = new EventBus();
    const raw = vitestOutput();
    const loop = new AgentLoop({
      provider: queuedProvider([{ tool: 'run_command', args: { command: 'npm', args: ['test'] } }, { text: 'done: noted' }]),
      bus,
      store,
      stopPolicy: { max_iterations: 6, max_errors: 3 },
      executeTool: async (): Promise<ToolResult> => ({ call_id: 'c1', status: 'error', output: raw, truncated: false, meta: { exit_code: 1 } }),
    });
    const state = await loop.run('Run tests\ndone: tests pass');
    expect(state.tool_result?.status).toBe('error');
    expect(state.tool_result?.output).toContain('AssertionError: expected true to be false');
    expect(state.tool_result?.output).toContain('exit code 1');
    cleanup();
  });
});

describe('final report compression metrics', () => {
  test('a noisy real command lands compressed-output accounting on the report', async () => {
    const workspace = tempDir('daedalus-compression-ws-');
    const home = tempDir('daedalus-compression-home-');
    const script = [{
      tool: 'run_command',
      args: { command: 'node', args: ['-e', 'for (let i = 0; i < 120; i++) console.log("noise line " + i)'] },
    }];
    const runner = new TaskRunner({
      workspaceRoot: workspace,
      store: new TaskStore(home),
      provider: scriptedProvider(script),
      approvalPolicy: 'auto',
      maxIterations: 6,
    });
    const result = await runner.run({ goal: 'print noise' });
    expect(result.report.metrics.compressed_outputs).toBe(1);
    expect(result.report.metrics.output_chars_before_compression).toBeGreaterThan(1_000);
    expect(result.report.metrics.output_chars_after_compression).toBeLessThan(result.report.metrics.output_chars_before_compression ?? 0);
    rmSync(workspace, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  });
});
