import { afterEach, describe, expect, test } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  AgentLoop,
  EventBus,
  LoopGuard,
  TaskRunner,
  TaskStore,
  condenseToolOutputs,
  contextMeter,
  guardEditedFile,
  loadProjectRules,
  loadSettings,
  loadValidationProfile,
  loopGuidanceNote,
  profileCommands,
  stableSerialize,
  toolCallSignature,
  type ContextManager,
  type Event,
  type LLMProvider,
  type Message,
  type TaskState,
  type ToolResult,
} from '../src/index.ts';

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

const FAKE_LSP_SERVER = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'fake-lsp-server.mjs');

function toolReply(id: string, tool: string, args: unknown) {
  return {
    message: {
      role: 'assistant' as const,
      content: '',
      tool_calls: [{ id, type: 'function' as const, function: { name: tool, arguments: JSON.stringify(args) } }],
    },
  };
}

function textReply(text: string) {
  return { message: { role: 'assistant' as const, content: text } };
}

/** Provider that runs the given tool script on successive turns, then answers "done:". */
function scriptedProvider(script: Array<{ tool: string; args: unknown }>): LLMProvider {
  let index = 0;
  return {
    name: 'scripted',
    async chat() {
      const step = script[index++];
      return step ? toolReply(`c${index}`, step.tool, step.args) : textReply('done: script exhausted');
    },
    async *stream() { yield { type: 'delta', content: '' }; },
  };
}

/** Three mutating writes: enough to walk the three default plan steps to "done". */
function threeWrites() {
  return [1, 2, 3].map((n) => ({ tool: 'write_file', args: { path: `step-${n}.txt`, content: `step ${n}\n` } }));
}

/** A validator that always passes — for tests exercising other parts of a run. */
const passingValidator = {
  validate: async () => ({
    checks: [{ name: 'stub', cmd: 'true', status: 'pass' as const, exit_code: 0, summary: 'passed', diagnostics: [] }],
  }),
};

describe('feature 1: anti-loop guard', () => {
  test('LoopGuard warns at the third identical call, suppresses the fourth, ignores arg order', () => {
    const guard = new LoopGuard();
    const argsA = { path: 'a.txt', flag: true };
    const argsB = { flag: true, path: 'a.txt' };
    expect(toolCallSignature('read_file', argsA)).toBe(toolCallSignature('read_file', argsB));
    expect(stableSerialize({ b: [2, { d: 1, c: 0 }], a: 1 })).toBe('{"a":1,"b":[2,{"c":0,"d":1}]}');
    expect(guard.observe('read_file', argsA).decision).toBe('execute');
    expect(guard.observe('read_file', argsB).decision).toBe('execute');
    const warn = guard.observe('read_file', argsA);
    expect(warn.decision).toBe('warn');
    expect(warn.repeats).toBe(3);
    const suppressed = guard.observe('read_file', argsB);
    expect(suppressed.decision).toBe('suppress');
    expect(suppressed.repeats).toBe(4);
    expect(loopGuidanceNote('read_file', 3)).toContain('repeated read_file');
  });

  test('repeating provider gets a warning, guidance in the next request, suppression, and can still finish', async () => {
    const home = tempDir('daedalus-loop-home-');
    const workspace = tempDir('daedalus-loop-ws-');
    const store = new TaskStore(home);
    const bus = new EventBus();
    const events: Event[] = [];
    bus.on('*', (event) => events.push(event));

    const requests: Message[][] = [];
    let executions = 0;
    const loop = new AgentLoop({
      provider: {
        name: 'fake',
        async chat(messages) {
          requests.push(messages);
          return requests.length <= 4
            ? toolReply(`c${requests.length}`, 'read_file', { path: 'missing.txt' })
            : toolReply('c5', 'write_file', { path: 'result.txt', content: 'findings\n' });
        },
        async *stream() { yield { type: 'delta', content: '' }; },
      },
      bus,
      store,
      executeTool: async (call) => {
        executions++;
        return {
          call_id: call.id,
          status: 'ok' as const,
          output: call.tool === 'write_file' ? 'wrote result.txt' : 'stable file contents',
          truncated: false,
          meta: { tool: call.tool, mutating: call.tool === 'write_file' },
        };
      },
      stopPolicy: { max_iterations: 12, max_errors: 5 },
    });

    const state = await loop.run({
      id: 'loop-task',
      goal: 'Read the file and report what it says',
      constraints: [],
      done_criteria: ['result reported'],
      repo_path: workspace,
      status: 'draft',
    });

    expect(state.status).toBe('done');
    expect(executions).toBe(4); // 3 reads + 1 write; the 4th read was suppressed

    const warnings = events.filter((event) => event.type === 'LOOP_WARNING');
    expect(warnings.map((event) => event.payload as { tool: string; repeats: number; suppressed: boolean })).toEqual([
      { tool: 'read_file', repeats: 3, suppressed: false },
      { tool: 'read_file', repeats: 4, suppressed: true },
    ]);

    // The 4th request carries the injected guidance note as an extra user turn.
    const guidanceTurn = requests[3]?.find((message) => message.role === 'user' && typeof message.content === 'string' && message.content.includes('Loop warning: you have repeated read_file'));
    expect(guidanceTurn).toBeDefined();

    // The 5th request shows the suppressed result instead of a fresh read.
    const suppressedResult = requests[4]?.find((message) => typeof message.content === 'string' && message.content.includes('(repeat suppressed: same call already returned above)'));
    expect(suppressedResult).toBeDefined();
  });

  test('an unreformable looper still dies on the no_progress backstop', async () => {
    const home = tempDir('daedalus-loop2-home-');
    const workspace = tempDir('daedalus-loop2-ws-');
    const store = new TaskStore(home);
    const bus = new EventBus();

    const loop = new AgentLoop({
      provider: {
        name: 'fake',
        async chat() {
          return toolReply(`c-${Math.random()}`, 'read_file', { path: 'same.txt' });
        },
        async *stream() { yield { type: 'delta', content: '' }; },
      },
      bus,
      store,
      executeTool: async (call) => ({
        call_id: call.id,
        status: 'ok' as const,
        output: 'never changes',
        truncated: false,
        meta: { tool: call.tool, mutating: false },
      }),
      stopPolicy: { max_iterations: 40, max_errors: 10 },
    });

    const state = await loop.run({
      id: 'loop-stuck',
      goal: 'Read the file and report what it says',
      constraints: [],
      done_criteria: ['result reported'],
      repo_path: workspace,
      status: 'draft',
    });
    expect(state.status).toBe('failed');
    expect(state.last_error).toBe('no_progress');
  });

  test('LoopGuard counts same-path list_dir with different depth as repeats and suppresses with a mutation nudge', () => {
    const root = '/work/repo';
    const guard = new LoopGuard({ workspaceRoot: root });
    expect(guard.observe('list_dir', { path: '.' }).decision).toBe('execute');
    expect(guard.observe('list_dir', { path: '.', depth: 2 }).decision).toBe('execute');
    const warn = guard.observe('list_dir', { path: root });
    expect(warn.decision).toBe('warn');
    expect(warn.repeatKind).toBe('same_path');
    const suppressed = guard.observe('list_dir', { path: '.', depth: 3 });
    expect(suppressed.decision).toBe('suppress');
    expect(suppressed.repeatKind).toBe('same_path');
    expect(suppressed.suppressedOutput).toContain('Do not list it again');
    expect(suppressed.suppressedOutput).toContain('create_dir');
  });

  test('LoopGuard suppresses a repeated read_skill immediately with an already-loaded note', () => {
    const guard = new LoopGuard();
    expect(guard.observe('read_skill', { name: 'frontend-design' }).decision).toBe('execute');
    const again = guard.observe('read_skill', { name: 'frontend-design' });
    expect(again.decision).toBe('suppress');
    expect(again.repeatKind).toBe('skill');
    expect(again.suppressedOutput).toContain('already loaded');
    expect(again.suppressedOutput).toContain('frontend-design');
    expect(guard.observe('read_skill', { name: 'git-workflow' }).decision).toBe('execute');
  });

  test('LoopGuard resets same-path counters after a mutation touches that path', () => {
    const guard = new LoopGuard({ workspaceRoot: '/work/repo' });
    guard.observe('list_dir', { path: '.' });
    guard.observe('list_dir', { path: '.', depth: 2 });
    expect(guard.observe('list_dir', { path: '.' }).decision).toBe('warn');
    guard.observe('create_dir', { path: 'ayid' });
    expect(guard.observe('list_dir', { path: '.' }).decision).toBe('execute');
    // …and a different, untouched path still accumulates repeats on its own.
    guard.observe('list_dir', { path: 'src' });
    guard.observe('list_dir', { path: 'src', depth: 2 });
    expect(guard.observe('list_dir', { path: 'src' }).decision).toBe('warn');
  });

  test('agent loop suppresses same-root re-listing across arg variants and nudges toward mutation', async () => {
    const home = tempDir('daedalus-explore-home-');
    const workspace = tempDir('daedalus-explore-ws-');
    const store = new TaskStore(home);
    const bus = new EventBus();
    const events: Event[] = [];
    bus.on('*', (event) => events.push(event));

    const script: Array<{ tool: string; args: unknown }> = [
      { tool: 'list_dir', args: { path: '.' } },
      { tool: 'list_dir', args: { path: '.', depth: 2 } },
      { tool: 'list_dir', args: { path: workspace } },
      { tool: 'list_dir', args: { path: '.', depth: 3 } },
      { tool: 'create_dir', args: { path: 'ayid' } },
    ];
    const requests: Message[][] = [];
    let executions = 0;
    const loop = new AgentLoop({
      provider: {
        name: 'fake',
        async chat(messages) {
          requests.push(messages);
          const step = script[requests.length - 1];
          return step ? toolReply(`c${requests.length}`, step.tool, step.args) : textReply('done: folder created');
        },
        async *stream() { yield { type: 'delta', content: '' }; },
      },
      bus,
      store,
      executeTool: async (call) => {
        executions++;
        return {
          call_id: call.id,
          status: 'ok' as const,
          output: call.tool === 'create_dir' ? 'created directory ayid' : 'root listing',
          truncated: false,
          meta: { tool: call.tool, mutating: call.tool === 'create_dir' },
        };
      },
      stopPolicy: { max_iterations: 12, max_errors: 5 },
    });

    const state = await loop.run({
      id: 'explore-task',
      goal: 'Create the ayid folder with a landing page',
      constraints: [],
      done_criteria: ['folder created'],
      repo_path: workspace,
      status: 'draft',
    });

    expect(state.status).toBe('done');
    // Listings 1–2 execute, the 3rd warns but still executes, the 4th is
    // suppressed without executing; plus the create_dir = 4 executions.
    expect(executions).toBe(4);
    const warnings = events.filter((event) => event.type === 'LOOP_WARNING');
    expect(warnings.map((event) => (event.payload as { repeat_kind?: string }).repeat_kind)).toContain('same_path');
    // The request after suppression carries the nudge to stop listing and mutate.
    const nudged = requests[4]?.find((message) => typeof message.content === 'string' && message.content.includes('Do not list it again'));
    expect(nudged).toBeDefined();
  });
});

describe('feature 2: edit guard', () => {
  test('flags broken JS, accepts fixed JS, checks JSON, skips when disabled or unsupported', async () => {
    const workspace = tempDir('daedalus-guard-');

    writeFileSync(join(workspace, 'bad.mjs'), 'export const x = (\n', 'utf8');
    const bad = await guardEditedFile({ workspaceRoot: workspace, enabled: true }, 'bad.mjs');
    expect(bad.ok).toBe(false);
    expect(bad.note).toContain('EDIT_GUARD: syntax error in bad.mjs');

    writeFileSync(join(workspace, 'ok.mjs'), 'export const x = 1;\n', 'utf8');
    const fixed = await guardEditedFile({ workspaceRoot: workspace, enabled: true }, 'ok.mjs');
    expect(fixed.ok).toBe(true);
    expect(fixed.note).toBe('edit guard: ok');

    writeFileSync(join(workspace, 'data.json'), '{ "a": ', 'utf8');
    const badJson = await guardEditedFile({ workspaceRoot: workspace, enabled: true }, 'data.json');
    expect(badJson.ok).toBe(false);
    expect(badJson.note).toContain('EDIT_GUARD: syntax error in data.json');

    writeFileSync(join(workspace, 'notes.md'), '# anything goes (', 'utf8');
    const docOnly = await guardEditedFile({ workspaceRoot: workspace, enabled: true }, 'notes.md');
    expect(docOnly.note).toBeUndefined();

    const disabled = await guardEditedFile({ workspaceRoot: workspace, enabled: false }, 'bad.mjs');
    expect(disabled.note).toBeUndefined();
    expect(disabled.issues).toEqual([]);

    const missing = await guardEditedFile({ workspaceRoot: workspace, enabled: true }, 'gone.mjs');
    expect(missing.note).toBeUndefined();
  });

  test('a write_file with a syntax error returns EDIT_GUARD feedback to the model in the same turn', async () => {
    const workspace = tempDir('daedalus-guard-ws-');
    const home = tempDir('daedalus-guard-home-');
    const script = [{ tool: 'write_file', args: { path: 'app.mjs', content: 'export const answer = (\n' } }];

    const runner = new TaskRunner({ workspaceRoot: workspace, store: new TaskStore(home), provider: scriptedProvider(script), approvalPolicy: 'auto', maxIterations: 6 });
    const events: Event[] = [];
    const result = await runner.run({ goal: 'create app.mjs', onEvent: (event) => events.push(event) });

    const finished = events.find((event) => event.type === 'TOOL_CALL_FINISHED' && (event.payload as { call?: { tool?: string } }).call?.tool === 'write_file');
    const output = (finished?.payload as { result?: { output?: string } }).result?.output ?? '';
    expect(output).toContain('EDIT_GUARD: syntax error in app.mjs');
    expect(result.report.outcome).toBeDefined();

    // ...and with the guard disabled the same write stays silent.
    const runnerOff = new TaskRunner({ workspaceRoot: workspace, store: new TaskStore(home), provider: scriptedProvider(script), approvalPolicy: 'auto', maxIterations: 6, editGuard: false });
    const eventsOff: Event[] = [];
    await runnerOff.run({ goal: 'create app.mjs again', onEvent: (event) => eventsOff.push(event) });
    const finishedOff = eventsOff.find((event) => event.type === 'TOOL_CALL_FINISHED' && (event.payload as { call?: { tool?: string } }).call?.tool === 'write_file');
    expect((finishedOff?.payload as { result?: { output?: string } }).result?.output ?? '').not.toContain('EDIT_GUARD');
  });

  test('appends fresh LSP diagnostics to the edit result, capped at 20 lines with a +N more rollup', async () => {
    const workspace = tempDir('daedalus-guard-lsp-unit-');
    writeFileSync(join(workspace, 'main.ts'), 'const value: string = 42;\n', 'utf8');
    const lspStub = (lines: string[]) => ({
      serverFor: () => ({}),
      diagnostics: async () => ({ server: 'fake-lsp', lines }),
    });

    const few = await guardEditedFile({ workspaceRoot: workspace, enabled: true, lsp: lspStub(['main.ts:1:7 error: Type number is not assignable to type string (fake-lsp)']) }, 'main.ts');
    expect(few.ok).toBe(false);
    expect(few.note).toContain('EDIT_GUARD: fake-lsp diagnostics for main.ts:');
    expect(few.note).toContain('main.ts:1:7 error: Type number is not assignable');

    const many = Array.from({ length: 25 }, (_, i) => `main.ts:1:${i + 1} error: problem ${i + 1} (fake-lsp)`);
    const capped = await guardEditedFile({ workspaceRoot: workspace, enabled: true, lsp: lspStub(many) }, 'main.ts');
    expect(capped.note).toContain('problem 20');
    expect(capped.note).toContain('+5 more diagnostics');
    expect(capped.note).not.toContain('problem 21');

    // A clean file appends NOTHING for a .ts (no syntax check applies).
    const clean = await guardEditedFile({ workspaceRoot: workspace, enabled: true, lsp: lspStub([]) }, 'main.ts');
    expect(clean.ok).toBe(true);
    expect(clean.note).toBeUndefined();

    // No server for the file type: diagnostics are never even requested.
    let requested = false;
    const uncovered = await guardEditedFile({
      workspaceRoot: workspace,
      enabled: true,
      lsp: { serverFor: () => undefined, diagnostics: async () => { requested = true; return { server: 'x', lines: ['boom'] }; } },
    }, 'main.ts');
    expect(uncovered.note).toBeUndefined();
    expect(requested).toBe(false);

    // A directory (create_dir's target) has nothing to diagnose: silent.
    mkdirSync(join(workspace, 'src'));
    const dir = await guardEditedFile({ workspaceRoot: workspace, enabled: true, lsp: lspStub(['boom']) }, 'src');
    expect(dir.note).toBeUndefined();
  });

  test('a slow or broken language server never fails or hangs the edit guard', async () => {
    const workspace = tempDir('daedalus-guard-lsp-slow-');
    writeFileSync(join(workspace, 'main.ts'), 'export const x = 1;\n', 'utf8');

    const slow = { serverFor: () => ({}), diagnostics: () => new Promise<{ server: string; lines: string[] }>(() => { /* never settles */ }) };
    const started = Date.now();
    const hung = await guardEditedFile({ workspaceRoot: workspace, enabled: true, lsp: slow, lspTimeoutMs: 25 }, 'main.ts');
    expect(Date.now() - started).toBeLessThan(1_000);
    expect(hung.ok).toBe(true);
    expect(hung.note).toBeUndefined();

    const broken = {
      serverFor: () => ({}),
      diagnostics: async (): Promise<{ server: string; lines: string[] }> => { throw new Error('server exploded'); },
    };
    const failed = await guardEditedFile({ workspaceRoot: workspace, enabled: true, lsp: broken }, 'main.ts');
    expect(failed.ok).toBe(true);
    expect(failed.note).toBeUndefined();
  });

  test('a write_file surfaces fresh LSP diagnostics in the tool result; no servers configured stays silent', async () => {
    const workspace = tempDir('daedalus-guard-lsp-run-ws-');
    const home = tempDir('daedalus-guard-lsp-run-home-');
    const script = [
      { tool: 'create_dir', args: { path: 'src' } },
      { tool: 'write_file', args: { path: 'main.ts', content: 'const unused: number = "oops";\n' } },
    ];

    const runner = new TaskRunner({
      workspaceRoot: workspace,
      store: new TaskStore(home),
      provider: scriptedProvider(script),
      approvalPolicy: 'auto',
      maxIterations: 6,
      lspServers: [{ name: 'fake-lsp', command: process.execPath, args: [FAKE_LSP_SERVER], extensions: ['.ts'] }],
    });
    const events: Event[] = [];
    await runner.run({ goal: 'create main.ts', onEvent: (event) => events.push(event) });
    const finished = events.filter((event) => event.type === 'TOOL_CALL_FINISHED');
    const outputFor = (tool: string): string => {
      const match = finished.find((event) => (event.payload as { call?: { tool?: string } }).call?.tool === tool);
      return (match?.payload as { result?: { output?: string } }).result?.output ?? '';
    };
    expect(outputFor('write_file')).toContain('EDIT_GUARD: fake-lsp diagnostics for main.ts:');
    expect(outputFor('write_file')).toContain('fake diagnostic: unused variable');
    // create_dir joins the guard path but a directory has no diagnostics.
    expect(outputFor('create_dir')).toBe('created directory src');

    const runnerOff = new TaskRunner({ workspaceRoot: workspace, store: new TaskStore(home), provider: scriptedProvider(script), approvalPolicy: 'auto', maxIterations: 6 });
    const eventsOff: Event[] = [];
    await runnerOff.run({ goal: 'create main.ts again', onEvent: (event) => eventsOff.push(event) });
    const finishedOff = eventsOff.find((event) => event.type === 'TOOL_CALL_FINISHED' && (event.payload as { call?: { tool?: string } }).call?.tool === 'write_file');
    const silentOutput = (finishedOff?.payload as { result?: { output?: string } }).result?.output ?? '';
    expect(silentOutput).toBe('wrote main.ts');
    expect(silentOutput).not.toContain('fake diagnostic');
  });
});

describe('feature 3: validation profile', () => {
  test('loadValidationProfile parses, validates, and warns precisely', () => {
    const workspace = tempDir('daedalus-profile-');
    expect(loadValidationProfile(workspace)).toEqual({});

    mkdirSync(join(workspace, '.daedalus'), { recursive: true });
    writeFileSync(join(workspace, '.daedalus', 'validate.json'), JSON.stringify({
      checks: [{ name: 'check', command: 'node check.mjs' }, { name: 'extra', command: 'node "my tool.mjs" --fast', required: false }],
      timeoutMs: 5_000,
    }), 'utf8');
    const loaded = loadValidationProfile(workspace);
    expect(loaded.warning).toBeUndefined();
    expect(loaded.profile?.timeoutMs).toBe(5_000);
    const commands = profileCommands(loaded.profile!);
    expect(commands).toEqual([
      { name: 'check', cmd: 'node', args: ['check.mjs'], source: 'profile', required: true },
      { name: 'extra', cmd: 'node', args: ['my tool.mjs', '--fast'], source: 'profile', required: false },
    ]);

    writeFileSync(join(workspace, '.daedalus', 'validate.json'), '{ not json', 'utf8');
    const broken = loadValidationProfile(workspace);
    expect(broken.profile).toBeUndefined();
    expect(broken.warning).toContain('invalid validation profile');
  });

  test('a workspace profile replaces the default checks and is marked in the report', async () => {
    const workspace = tempDir('daedalus-profile-ws-');
    const home = tempDir('daedalus-profile-home-');
    mkdirSync(join(workspace, '.daedalus'), { recursive: true });
    writeFileSync(join(workspace, '.daedalus', 'validate.json'), JSON.stringify({ checks: [{ name: 'check', command: 'node check.mjs' }] }), 'utf8');
    writeFileSync(join(workspace, 'check.mjs'), "console.log('profile ok');\n", 'utf8');

    const runner = new TaskRunner({ workspaceRoot: workspace, store: new TaskStore(home), provider: scriptedProvider(threeWrites()), approvalPolicy: 'auto', maxIterations: 8 });
    const result = await runner.run({ goal: 'verify the workspace as-is' });

    expect(result.report.outcome).toBe('success');
    expect(result.report.validation_source).toBe('profile');
    expect(result.report.evidence).toContain('check: pass (node check.mjs) [profile]');
  });

  test('an invalid profile falls back to the defaults with a warning in the evidence', async () => {
    const workspace = tempDir('daedalus-profile-bad-ws-');
    const home = tempDir('daedalus-profile-bad-home-');
    mkdirSync(join(workspace, '.daedalus'), { recursive: true });
    writeFileSync(join(workspace, '.daedalus', 'validate.json'), 'not json at all', 'utf8');

    const runner = new TaskRunner({ workspaceRoot: workspace, store: new TaskStore(home), provider: scriptedProvider(threeWrites()), approvalPolicy: 'auto', maxIterations: 8 });
    const result = await runner.run({ goal: 'verify the workspace as-is' });
    expect(result.report.validation_source).toBe('default');
    expect(result.report.evidence.some((line) => line.startsWith('validation profile warning:'))).toBe(true);
  });
});

describe('feature 4: project rules file', () => {
  test('loads rules in priority order, concatenates, and caps at 8000 chars', async () => {
    const workspace = tempDir('daedalus-rules-');
    expect((await loadProjectRules(workspace)).files).toEqual([]);

    writeFileSync(join(workspace, 'AGENTS.md'), 'Always use pnpm.\n', 'utf8');
    const only = await loadProjectRules(workspace);
    expect(only.files).toEqual(['AGENTS.md']);
    expect(only.text).toContain('## Rules from AGENTS.md');
    expect(only.text).toContain('Always use pnpm.');

    mkdirSync(join(workspace, '.daedalus'), { recursive: true });
    writeFileSync(join(workspace, '.daedalus', 'RULES.md'), 'MARKER-RULE: never use npm.\n', 'utf8');
    writeFileSync(join(workspace, '.daedalus', 'rules.md'), 'Trailing rule.\n', 'utf8');
    const all = await loadProjectRules(workspace);
    expect(all.files).toEqual(['.daedalus/RULES.md', 'AGENTS.md', '.daedalus/rules.md']);
    expect(all.text.indexOf('MARKER-RULE')).toBeLessThan(all.text.indexOf('Always use pnpm.'));

    const big = tempDir('daedalus-rules-big-');
    writeFileSync(join(big, 'AGENTS.md'), `Rule line.\n${'x'.repeat(9_000)}`, 'utf8');
    const capped = await loadProjectRules(big);
    expect(capped.truncated).toBe(true);
    expect(capped.text.length).toBeLessThanOrEqual(8_100);
    expect(capped.text).toContain('truncated');
  });

  test('rules reach the model prompt and are recorded on the report', async () => {
    const workspace = tempDir('daedalus-rules-ws-');
    const home = tempDir('daedalus-rules-home-');
    writeFileSync(join(workspace, 'AGENTS.md'), 'MARKER-RULE: commit messages must start with "feat:".\n', 'utf8');

    const seen: Message[][] = [];
    const provider: LLMProvider = {
      name: 'scripted',
      async chat(messages) {
        seen.push(messages);
        return textReply('done: acknowledged');
      },
      async *stream() { yield { type: 'delta', content: '' }; },
    };
    const runner = new TaskRunner({ workspaceRoot: workspace, store: new TaskStore(home), provider, approvalPolicy: 'auto', maxIterations: 4 });
    const result = await runner.run({ goal: 'do a tiny task' });

    const systemText = seen[0]?.filter((message) => message.role === 'system').map((message) => String(message.content)).join('\n') ?? '';
    expect(systemText).toContain('Project rules');
    expect(systemText).toContain('MARKER-RULE');
    expect(result.report.rules_files).toEqual(['AGENTS.md']);
    expect(result.state.rules_files).toEqual(['AGENTS.md']);
  });
});

describe('feature 5: checkpoint / rewind', () => {
  test('store records first-mutation backups; restore rewinds edits and deletes creations', () => {
    const home = tempDir('daedalus-cp-home-');
    const workspace = tempDir('daedalus-cp-ws-');
    const store = new TaskStore(home);
    const taskId = 'task-cp';

    writeFileSync(join(workspace, 'a.txt'), 'original A\n', 'utf8');
    store.recordBackup(taskId, 'a.txt', 'original A\n');
    store.recordBackup(taskId, 'a.txt', 'second mutation must not win\n');
    store.recordBackup(taskId, 'b.txt', null);

    writeFileSync(join(workspace, 'a.txt'), 'edited by the task\n', 'utf8');
    writeFileSync(join(workspace, 'b.txt'), 'created by the task\n', 'utf8');
    writeFileSync(join(workspace, 'untouched.txt'), 'leave me\n', 'utf8');

    expect(store.listBackups(taskId)).toEqual([
      { path: 'a.txt', created: false },
      { path: 'b.txt', created: true },
    ]);

    const outcome = store.restoreTask(taskId, workspace);
    expect(outcome).toEqual({ restored: ['a.txt'], deleted: ['b.txt'] });
    expect(readFileSync(join(workspace, 'a.txt'), 'utf8')).toBe('original A\n');
    expect(existsSync(join(workspace, 'b.txt'))).toBe(false);
    expect(readFileSync(join(workspace, 'untouched.txt'), 'utf8')).toBe('leave me\n');
  });

  test('restore refuses a manifest path that escapes the workspace', () => {
    const home = tempDir('daedalus-cp2-home-');
    const workspace = tempDir('daedalus-cp2-ws-');
    const store = new TaskStore(home);
    const taskId = 'task-escape';
    // Hand-craft a tampered manifest: restore must validate before writing.
    mkdirSync(join(home, 'tasks', taskId, 'backups'), { recursive: true });
    writeFileSync(join(home, 'tasks', taskId, 'backups', 'index.json'), JSON.stringify([{ path: '../evil.txt', created: false }]), 'utf8');
    expect(() => store.restoreTask(taskId, workspace)).toThrow(/refusing to restore/);
  });

  test('a runner task records checkpoints and restore undoes them', async () => {
    const workspace = tempDir('daedalus-cp-ws2-');
    const home = tempDir('daedalus-cp-home2-');
    writeFileSync(join(workspace, 'a.txt'), 'original A\n', 'utf8');

    const script: Array<{ tool: string; args: unknown }> = [
      { tool: 'edit_file', args: { path: 'a.txt', old_string: 'original A', new_string: 'changed A' } },
      { tool: 'write_file', args: { path: 'b.txt', content: 'brand new\n' } },
    ];
    const store = new TaskStore(home);
    const runner = new TaskRunner({ workspaceRoot: workspace, store, provider: scriptedProvider(script), approvalPolicy: 'auto', maxIterations: 8 });
    const result = await runner.run({ goal: 'edit a.txt and create b.txt' });

    expect(readFileSync(join(workspace, 'a.txt'), 'utf8')).toBe('changed A\n');
    expect(existsSync(join(workspace, 'b.txt'))).toBe(true);
    expect(store.listBackups(result.state.id).map((entry) => entry.path).sort()).toEqual(['a.txt', 'b.txt']);

    const outcome = store.restoreTask(result.state.id, workspace);
    expect(outcome.restored).toEqual(['a.txt']);
    expect(outcome.deleted).toEqual(['b.txt']);
    expect(readFileSync(join(workspace, 'a.txt'), 'utf8')).toBe('original A\n');
    expect(existsSync(join(workspace, 'b.txt'))).toBe(false);
  });
});

describe('feature 6: context meter + condense', () => {
  const toolHistory = (count: number, filler: string): Message[] => [
    { role: 'system', content: 'system prompt' },
    { role: 'user', content: 'goal' },
    ...Array.from({ length: count }, (_, index): Message => ({ role: 'tool', content: filler.repeat(200), tool_call_id: `call-${index}` })),
  ];

  test('condenseToolOutputs replaces only older tool outputs past the threshold', () => {
    const messages = toolHistory(9, 'x');
    const under = condenseToolOutputs(messages, { limitTokens: 100_000 });
    expect(under).toBe(messages);

    const condensed = condenseToolOutputs(messages, { limitTokens: 300 });
    const toolContents = condensed.filter((message) => message.role === 'tool').map((message) => message.content);
    expect(toolContents.slice(0, 3)).toEqual([
      '(earlier tool output condensed to save context)',
      '(earlier tool output condensed to save context)',
      '(earlier tool output condensed to save context)',
    ]);
    expect(toolContents.slice(3).every((content) => typeof content === 'string' && content.startsWith('xxx'))).toBe(true);
    // tool_call_id structure survives so the provider request stays valid.
    expect(condensed.filter((message) => message.role === 'tool').every((message) => typeof message.tool_call_id === 'string')).toBe(true);

    const meter = contextMeter(messages, 1_000);
    expect(meter.context_limit_tokens).toBe(1_000);
    expect(meter.context_estimate_tokens).toBeGreaterThan(400);
    expect(meter.context_percent).toBeGreaterThan(40);
    expect(meter.context_percent).toBeLessThanOrEqual(100);
  });

  test('the loop condenses old tool outputs over 70% and reports ctx% on MODEL_REQUEST events', async () => {
    const home = tempDir('daedalus-ctx-home-');
    const workspace = tempDir('daedalus-ctx-ws-');
    const store = new TaskStore(home);
    const bus = new EventBus();
    const events: Event[] = [];
    bus.on('*', (event) => events.push(event));

    // A history-carrying context: every earlier tool result rides along as a
    // role:'tool' message, like adapters that keep the full transcript.
    const seenToolResults = new Map<string, Message>();
    const historyContext: ContextManager = {
      async buildMessages(state: TaskState): Promise<Message[]> {
        const result = (state as TaskState & { tool_result?: ToolResult }).tool_result;
        if (result && !seenToolResults.has(result.call_id)) {
          seenToolResults.set(result.call_id, { role: 'tool', content: result.output, tool_call_id: result.call_id });
        }
        return [
          { role: 'system', content: 'test system prompt' },
          { role: 'user', content: state.goal },
          ...seenToolResults.values(),
        ];
      },
    };

    const requests: Message[][] = [];
    let reads = 0;
    const loop = new AgentLoop({
      provider: {
        name: 'fake',
        async chat(messages) {
          requests.push(messages);
          reads++;
          return toolReply(`r${reads}`, 'read_file', { path: `file-${reads}.txt` });
        },
        async *stream() { yield { type: 'delta', content: '' }; },
      },
      bus,
      store,
      context: historyContext,
      executeTool: async (call) => ({
        call_id: call.id,
        status: 'ok' as const,
        // Distinct per file (identical outputs would trip the no_progress
        // backstop) but still long enough to dominate the token estimate.
        output: `${String((call.args as { path?: string }).path ?? 'file')}\n${'y'.repeat(1_500)}`,
        truncated: false,
        meta: { tool: call.tool, mutating: false },
      }),
      stopPolicy: { max_iterations: 14, max_errors: 5 },
      contextLimitTokens: 1_000,
    });

    const state = await loop.run({
      id: 'ctx-task',
      goal: 'Read many files and report',
      constraints: [],
      done_criteria: ['read one', 'read two', 'read three', 'read four', 'read five', 'read six', 'read seven', 'read eight'],
      repo_path: workspace,
      status: 'draft',
    });
    expect(state.status).toBe('done');
    expect(requests).toHaveLength(8);

    // The meter rides on every model-request event.
    const started = events.filter((event) => event.type === 'MODEL_REQUEST_STARTED');
    expect(started).toHaveLength(8);
    for (const event of started) {
      const payload = event.payload as { context_limit_tokens?: number; context_percent?: number };
      expect(payload.context_limit_tokens).toBe(1_000);
      expect(typeof payload.context_percent).toBe('number');
    }
    expect((started[started.length - 1]?.payload as { context_percent?: number }).context_percent).toBe(100);

    // The final (largest) request: 7 carried tool results, the oldest one
    // condensed, the 6 most recent intact, structure preserved.
    const finalTools = requests[requests.length - 1]?.filter((message) => message.role === 'tool') ?? [];
    expect(finalTools).toHaveLength(7);
    expect(finalTools[0]?.content).toBe('(earlier tool output condensed to save context)');
    expect(finalTools.slice(1).every((message) => typeof message.content === 'string' && message.content.length > 1_000 && message.content.includes('yyy'))).toBe(true);
    expect(finalTools.every((message) => typeof message.tool_call_id === 'string')).toBe(true);
  });
});

describe('feature 7: helper-model titles', () => {
  test('a helper model titles the task on state and report', async () => {
    const workspace = tempDir('daedalus-title-ws-');
    const home = tempDir('daedalus-title-home-');
    const helper: LLMProvider = {
      name: 'helper',
      async chat() {
        return { message: { role: 'assistant', content: '"Fix Login Crash"\n' } };
      },
      async *stream() { yield { type: 'delta', content: '' }; },
    };
    const runner = new TaskRunner({
      workspaceRoot: workspace,
      store: new TaskStore(home),
      provider: scriptedProvider(threeWrites()),
      approvalPolicy: 'auto',
      maxIterations: 8,
      validator: passingValidator,
      helperProvider: helper,
    });
    const result = await runner.run({ goal: 'fix the login crash on startup please' });
    expect(result.report.title).toBe('Fix Login Crash');
    expect(result.state.title).toBe('Fix Login Crash');
    expect(result.state.status).toBe('done');
  });

  test('no helper configured → no title, behaviour unchanged', async () => {
    const workspace = tempDir('daedalus-title2-ws-');
    const home = tempDir('daedalus-title2-home-');
    const runner = new TaskRunner({
      workspaceRoot: workspace,
      store: new TaskStore(home),
      provider: scriptedProvider(threeWrites()),
      approvalPolicy: 'auto',
      maxIterations: 8,
      validator: passingValidator,
    });
    const result = await runner.run({ goal: 'plain task with no helper' });
    expect(result.report.title).toBeUndefined();
    expect(result.state.title).toBeUndefined();
    expect(result.state.status).toBe('done');
  });

  test('a failing helper never fails the task', async () => {
    const workspace = tempDir('daedalus-title3-ws-');
    const home = tempDir('daedalus-title3-home-');
    const helper: LLMProvider = {
      name: 'helper',
      async chat() {
        throw new Error('helper exploded');
      },
      async *stream() { yield { type: 'delta', content: '' }; },
    };
    const runner = new TaskRunner({
      workspaceRoot: workspace,
      store: new TaskStore(home),
      provider: scriptedProvider(threeWrites()),
      approvalPolicy: 'auto',
      maxIterations: 8,
      validator: passingValidator,
      helperProvider: helper,
    });
    const result = await runner.run({ goal: 'task with broken helper' });
    expect(result.report.title).toBeUndefined();
    expect(result.state.status).toBe('done');
  });
});

describe('settings for the new features', () => {
  test('env-driven knobs parse with safe defaults', () => {
    const clean = loadSettings({});
    expect(clean.context.limitTokens).toBe(128_000);
    expect(clean.context.condense).toBe(true);
    expect(clean.editGuard).toBe(true);
    expect(clean.llm.helperModel).toBe('');

    expect(loadSettings({ DAEDALUS_CONTEXT_LIMIT: '42000' }).context.limitTokens).toBe(42_000);
    expect(() => loadSettings({ DAEDALUS_CONTEXT_LIMIT: 'nonsense' })).toThrow(/DAEDALUS_CONTEXT_LIMIT/);
    expect(loadSettings({ DAEDALUS_CONDENSE: 'off' }).context.condense).toBe(false);
    expect(loadSettings({ DAEDALUS_EDIT_GUARD: 'off' }).editGuard).toBe(false);
    expect(loadSettings({ DAEDALUS_HELPER_MODEL: 'mini-model' }).llm.helperModel).toBe('mini-model');
  });
});
