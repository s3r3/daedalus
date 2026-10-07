import { describe, expect, test } from 'vitest';
import fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  DefaultContextManager,
  ModelPoolProvider,
  TaskRunner,
  TaskStore,
  detectPromptFamily,
  editSearchReplaceTool,
  loadPins,
  loadSettings,
  normalizeModelTiers,
  parseModelTiers,
  parseSearchReplaceBlocks,
  promptFamilyFragment,
  resolvePromptFamily,
  sanitizePins,
  sanitizeProviderInput,
  savePins,
  strongestModelFor,
  tierRankForPhase,
  type LLMProvider,
  type TaskState,
  type ToolResult,
  type ValidationResult,
} from '../src/index.ts';

function response(content: string) {
  return { message: { role: 'assistant' as const, content }, finish_reason: 'stop' as const };
}

function tool(id: string, name: string, args: unknown) {
  return { type: 'tool_calls' as const, calls: [{ id, tool: name, arguments: args }] };
}

/** Fake provider answering from a script; exhausted scripts report done. */
function scriptedModel(script: Array<ReturnType<typeof response> | ReturnType<typeof tool>>, log?: Array<{ phase?: string }>): LLMProvider {
  let index = 0;
  return {
    async chat(_messages, _tools, options) {
      log?.push({ phase: options?.phase });
      const next = script[index];
      index += 1;
      if (next?.type === 'tool_calls') {
        const call = next.calls[0];
        return {
          message: { role: 'assistant' as const, content: '', tool_calls: [{ id: call.id, type: 'function' as const, function: { name: call.tool, arguments: JSON.stringify(call.arguments) } }] },
          finish_reason: 'tool_calls' as const,
        };
      }
      if (next) return next;
      return response('done: script exhausted');
    },
  };
}

function passingValidator(): { validate: () => Promise<ValidationResult> } {
  return {
    validate: async () => ({
      checks: [{ name: 'test', cmd: 'npm test', status: 'pass', exit_code: 0, summary: 'ok', diagnostics: [] }],
    }),
  };
}

function failThenPassValidator(failures: number): { validate: () => Promise<ValidationResult> } {
  let calls = 0;
  return {
    validate: async () => {
      calls += 1;
      return calls <= failures
        ? { checks: [{ name: 'test', cmd: 'npm test', status: 'fail', exit_code: 1, summary: '1 failing', diagnostics: [{ tool: 'test', file: 'src/index.ts', line: 3, message: 'boom', severity: 'error' }] }] }
        : { checks: [{ name: 'test', cmd: 'npm test', status: 'pass', exit_code: 0, summary: 'ok', diagnostics: [] }] };
    },
  };
}

async function makePoolWorkspace(): Promise<{ workspace: string; home: string }> {
  const workspace = await fs.mkdtemp(path.join(tmpdir(), 'daedalus-tailor-ws-'));
  const home = await fs.mkdtemp(path.join(tmpdir(), 'daedalus-tailor-home-'));
  await fs.mkdir(path.join(workspace, 'src'), { recursive: true });
  await fs.writeFile(path.join(workspace, 'src', 'index.ts'), 'export const x = 1\n', 'utf8');
  return { workspace, home };
}

const TIERS = { 'weak-m': 'fast', 'strong-m': 'strong' } as const;

function poolWith(
  scripts: Record<string, Array<ReturnType<typeof response> | ReturnType<typeof tool>>>,
  options: { routing?: boolean; log?: Array<{ model: string; phase?: string }> } = {},
): ModelPoolProvider {
  return new ModelPoolProvider({
    models: Object.keys(scripts),
    tiers: TIERS,
    routing: options.routing,
    createProvider: (model) => {
      const provider = scriptedModel(scripts[model] ?? []);
      return {
        async chat(messages, tools, chatOptions) {
          options.log?.push({ model, phase: chatOptions?.phase });
          return provider.chat(messages, tools, chatOptions);
        },
      };
    },
  });
}

const writeScript = (prefix: string) => [
  tool('1', 'write_file', { path: `${prefix}-a.txt`, content: 'a\n' }),
  tool('2', 'write_file', { path: `${prefix}-b.txt`, content: 'b\n' }),
  tool('3', 'write_file', { path: `${prefix}-c.txt`, content: 'c\n' }),
];

describe('feature 1: pool tier routing', () => {
  test('explore goes to balanced/fast, edit and repair to strong, question to fast', async () => {
    const log: Array<{ model: string; phase?: string }> = [];
    const pool = new ModelPoolProvider({
      models: ['fast-m', 'bal-m', 'strong-m'],
      tiers: { 'fast-m': 'fast', 'bal-m': 'balanced', 'strong-m': 'strong' },
      createProvider: (model) => ({
        async chat(_messages, _tools, options) {
          log.push({ model, phase: options?.phase });
          return response(`${model} reply`);
        },
      }),
    });
    const served = async (phase: 'explore' | 'edit' | 'repair' | 'question'): Promise<string> => {
      log.length = 0;
      const result = await pool.chat([{ role: 'user', content: 'hi' }], undefined, { phase });
      return result.message.content;
    };
    expect(await served('explore')).toBe('bal-m reply');
    expect(await served('edit')).toBe('strong-m reply');
    expect(await served('repair')).toBe('strong-m reply');
    expect(await served('question')).toBe('fast-m reply');
  });

  test('routing off or unset tiers keeps failover order; single-model pool is stable', async () => {
    const plain = new ModelPoolProvider({
      models: ['a-m', 'b-m'],
      routing: true,
      createProvider: (model) => ({
        async chat() {
          return response(model);
        },
      }),
    });
    expect((await plain.chat([{ role: 'user', content: 'hi' }], undefined, { phase: 'edit' })).message.content).toBe('a-m');
    const solo = new ModelPoolProvider({
      models: ['only-m'],
      tiers: { 'only-m': 'fast' },
      createProvider: () => ({ async chat() { return response('solo'); } }),
    });
    expect((await solo.chat([{ role: 'user', content: 'hi' }], undefined, { phase: 'edit' })).message.content).toBe('solo');
  });

  test('failover still walks the routed order on retryable errors', async () => {
    const attempts: string[] = [];
    const pool = new ModelPoolProvider({
      models: ['strong-m', 'bal-m'],
      tiers: { 'strong-m': 'strong', 'bal-m': 'balanced' },
      createProvider: (model) => ({
        async chat() {
          attempts.push(model);
          if (model === 'strong-m') throw new Error('HTTP 503 unavailable');
          return response('balanced served');
        },
      }),
    });
    const result = await pool.chat([{ role: 'user', content: 'hi' }], undefined, { phase: 'edit' });
    expect(result.message.content).toBe('balanced served');
    expect(attempts).toEqual(['strong-m', 'bal-m']);
  });

  test('pinModel beats phase routing and survives successes; unknown models are rejected', async () => {
    const log: string[] = [];
    const pool = new ModelPoolProvider({
      models: ['weak-m', 'strong-m'],
      tiers: TIERS,
      createProvider: (model) => ({
        async chat() {
          log.push(model);
          return response(model);
        },
      }),
    });
    expect(pool.pinModel('nope')).toBe(false);
    expect(pool.pinModel('weak-m')).toBe(true);
    await pool.chat([{ role: 'user', content: 'hi' }], undefined, { phase: 'edit' });
    await pool.chat([{ role: 'user', content: 'hi' }], undefined, { phase: 'repair' });
    expect(log).toEqual(['weak-m', 'weak-m']);
    expect(pool.currentModel()).toBe('weak-m');
    expect(pool.strongestModel()).toBe('strong-m');
  });

  test('tier helpers: parse/normalize/strongest/rank', () => {
    expect(parseModelTiers('a:strong, b:fast')).toEqual({ a: 'strong', b: 'fast' });
    expect(() => parseModelTiers('a:huge')).toThrow(/LLM_MODEL_TIERS/);
    expect(normalizeModelTiers({ a: 'STRONG', b: 'junk', c: 'fast' })).toEqual({ a: 'strong', c: 'fast' });
    expect(strongestModelFor(['x', 'y'], { y: 'strong' })).toBe('y');
    expect(strongestModelFor(['x', 'y'], {})).toBe('x');
    expect(tierRankForPhase('repair', 'strong')).toBe(0);
    expect(tierRankForPhase('repair', 'fast')).toBe(2);
    expect(tierRankForPhase('question', 'fast')).toBe(0);
    expect(tierRankForPhase('explore', 'balanced')).toBe(0);
  });

  test('sanitizeProviderInput keeps tier/dialect/edit-format fields and drops garbage', () => {
    expect(sanitizeProviderInput({
      name: 'router',
      baseUrl: 'http://127.0.0.1:20128/v1',
      models: ['a', 'b'],
      modelTiers: { a: 'strong', b: 'junk' } as never,
      promptFamily: 'CLAUDE',
      editFormat: 'search_replace',
    })).toMatchObject({ modelTiers: { a: 'strong' }, promptFamily: 'claude', editFormat: 'search_replace' });
    const lenient = sanitizeProviderInput({
      name: 'router',
      baseUrl: 'http://127.0.0.1:20128/v1',
      models: ['a'],
      promptFamily: 'nope' as never,
      editFormat: 'nope' as never,
    });
    expect(lenient.promptFamily).toBeUndefined();
    expect(lenient.editFormat).toBeUndefined();
  });

  test('settings env parsing for tiers, tailor toggles, dialect, and edit format', () => {
    const settings = loadSettings({
      LLM_MODEL_TIERS: 'a:strong,b:fast',
      LLM_PROMPT_FAMILY: 'qwen',
      LLM_EDIT_FORMAT: 'search_replace',
      DAEDALUS_REVIEW_GATE: 'on',
      DAEDALUS_MODEL_ROUTING: 'off',
      DAEDALUS_QUALITY_ESCALATION: 'off',
    });
    expect(settings.llm.modelTiers).toEqual({ a: 'strong', b: 'fast' });
    expect(settings.llm.promptFamily).toBe('qwen');
    expect(settings.llm.editFormat).toBe('search_replace');
    // earlyEscalation joined the tailor shape (DAEDALUS_TAILOR_EARLY_ESCALATION, default on).
    expect(settings.tailor).toEqual({ modelRouting: false, qualityEscalation: false, reviewGate: true, earlyEscalation: true });
    expect(() => loadSettings({ LLM_MODEL_TIERS: 'a:huge' })).toThrow(/LLM_MODEL_TIERS/);
    expect(() => loadSettings({ LLM_EDIT_FORMAT: 'weird' })).toThrow(/LLM_EDIT_FORMAT/);
    expect(() => loadSettings({ LLM_PROMPT_FAMILY: 'weird' })).toThrow(/LLM_PROMPT_FAMILY/);
  });
});

describe('feature 1+3: agent-loop phases and quality escalation', () => {
  test('MODEL_REQUEST events carry phase/model/tier stamps', async () => {
    const { workspace, home } = await makePoolWorkspace();
    const runner = new TaskRunner({
      workspaceRoot: workspace,
      store: new TaskStore(home),
      provider: poolWith({ 'weak-m': [tool('0', 'read_file', { path: 'src/index.ts' }), ...writeScript('w')], 'strong-m': [] }, { routing: false }),
      approvalPolicy: 'auto',
      validator: passingValidator(),
      maxIterations: 10,
      modelTiers: TIERS,
    });
    const result = await runner.run({ goal: 'stamp the phases', cwd: workspace });
    expect(result.report.outcome).toBe('success');
    const started = result.events.filter((event) => event.type === 'MODEL_REQUEST_STARTED');
    expect(started[0].payload).toMatchObject({ phase: 'explore' });
    expect(started.map((event) => event.payload.phase)).toContain('edit');
    const finished = result.events.filter((event) => event.type === 'MODEL_REQUEST_FINISHED');
    expect(finished[0].payload).toMatchObject({ model: 'weak-m', tier: 'fast' });
  });

  test('validation failure escalates to the strongest model, once, and the repair succeeds', async () => {
    const { workspace, home } = await makePoolWorkspace();
    const log: Array<{ model: string; phase?: string }> = [];
    const runner = new TaskRunner({
      workspaceRoot: workspace,
      store: new TaskStore(home),
      // Routing off: this test isolates escalation pinning (pin-vs-routing
      // precedence is covered at pool level).
      provider: poolWith({ 'weak-m': writeScript('w'), 'strong-m': [tool('r1', 'write_file', { path: 'fix.txt', content: 'fixed\n' })] }, { log, routing: false }),
      approvalPolicy: 'auto',
      validator: failThenPassValidator(1),
      maxIterations: 10,
      modelTiers: TIERS,
    });
    const result = await runner.run({ goal: 'fix the thing', cwd: workspace, model: 'weak-m' });
    expect(result.report.outcome).toBe('success');
    const escalations = result.events.filter((event) => event.type === 'PROVIDER_CHANGED' && event.payload.reason === 'quality_escalation');
    expect(escalations).toHaveLength(1);
    expect(escalations[0].payload).toMatchObject({ from_model: 'weak-m', to_model: 'strong-m', attempt: 1 });
    // The repair turn ran on the strong model and the weak one was not reused.
    expect(log.filter((entry) => entry.model === 'weak-m')).toHaveLength(3);
    expect(log.filter((entry) => entry.model === 'strong-m')).toHaveLength(1);
  });

  test('a second validation failure does not escalate twice', async () => {
    const { workspace, home } = await makePoolWorkspace();
    const runner = new TaskRunner({
      workspaceRoot: workspace,
      store: new TaskStore(home),
      provider: poolWith({
        'weak-m': writeScript('w'),
        'strong-m': [tool('r1', 'write_file', { path: 'fix1.txt', content: 'f1\n' }), tool('r2', 'write_file', { path: 'fix2.txt', content: 'f2\n' })],
      }, { routing: false }),
      approvalPolicy: 'auto',
      validator: failThenPassValidator(2),
      maxIterations: 12,
      modelTiers: TIERS,
    });
    const result = await runner.run({ goal: 'fix iteratively', cwd: workspace, model: 'weak-m' });
    expect(result.report.outcome).toBe('success');
    expect(result.events.filter((event) => event.type === 'PROVIDER_CHANGED' && event.payload.reason === 'quality_escalation')).toHaveLength(1);
  });

  test('escalation is a no-op when disabled, single-model, or already strongest', async () => {
    const first = await makePoolWorkspace();
    const disabled = new TaskRunner({
      workspaceRoot: first.workspace,
      store: new TaskStore(first.home),
      // Routing off so the weak model itself does the repair turn; the
      // assertion is that no escalation happened even though it could have.
      provider: poolWith({ 'weak-m': [...writeScript('w'), tool('r1', 'write_file', { path: 'fix.txt', content: 'f\n' })], 'strong-m': [] }, { routing: false }),
      approvalPolicy: 'auto',
      validator: failThenPassValidator(1),
      maxIterations: 10,
      qualityEscalation: false,
      modelTiers: TIERS,
    });
    const disabledResult = await disabled.run({ goal: 'no escalation', cwd: first.workspace, model: 'weak-m' });
    expect(disabledResult.report.outcome).toBe('success');
    expect(disabledResult.events.filter((event) => event.type === 'PROVIDER_CHANGED')).toHaveLength(0);

    const second = await makePoolWorkspace();
    const single = new TaskRunner({
      workspaceRoot: second.workspace,
      store: new TaskStore(second.home),
      provider: scriptedModel([...writeScript('s'), tool('r1', 'write_file', { path: 'fix.txt', content: 'f\n' })]),
      approvalPolicy: 'auto',
      validator: failThenPassValidator(1),
      maxIterations: 10,
    });
    const singleResult = await single.run({ goal: 'single model', cwd: second.workspace, model: 'solo' });
    expect(singleResult.report.outcome).toBe('success');
    expect(singleResult.events.filter((event) => event.type === 'PROVIDER_CHANGED')).toHaveLength(0);

    const third = await makePoolWorkspace();
    const strongest = new TaskRunner({
      workspaceRoot: third.workspace,
      store: new TaskStore(third.home),
      provider: poolWith({ 'strong-m': [...writeScript('w'), tool('r1', 'write_file', { path: 'fix.txt', content: 'f\n' })], 'weak-m': [] }, { routing: false }),
      approvalPolicy: 'auto',
      validator: failThenPassValidator(1),
      maxIterations: 10,
      modelTiers: TIERS,
    });
    const strongestResult = await strongest.run({ goal: 'already strong', cwd: third.workspace, model: 'strong-m' });
    expect(strongestResult.report.outcome).toBe('success');
    expect(strongestResult.events.filter((event) => event.type === 'PROVIDER_CHANGED')).toHaveLength(0);
  });
});

describe('feature 2: prompt dialects', () => {
  test('family detection, explicit override, and short fragments', () => {
    expect(detectPromptFamily('kr/claude-sonnet-4-agentic')).toBe('claude');
    expect(detectPromptFamily('openai/gpt-5-codex')).toBe('gpt');
    expect(detectPromptFamily('qwen2.5-coder-32b')).toBe('qwen');
    expect(detectPromptFamily('meta-llama-3.1-70b')).toBe('llama');
    expect(detectPromptFamily('gemini-2.5-pro')).toBe('gemini');
    expect(detectPromptFamily('deepseek-v3')).toBe('generic');
    expect(resolvePromptFamily('auto', 'kr/claude-sonnet')).toBe('claude');
    expect(resolvePromptFamily('gpt', 'kr/claude-sonnet')).toBe('gpt');
    expect(resolvePromptFamily(undefined, undefined)).toBe('generic');
    for (const family of ['claude', 'gpt', 'qwen', 'llama', 'gemini'] as const) {
      const fragment = promptFamilyFragment(family);
      expect(fragment).toBeDefined();
      expect(fragment!.split('\n').length).toBeLessThanOrEqual(6);
    }
    expect(promptFamilyFragment('generic')).toBeUndefined();
  });

  function fixtureState(workspace: string): TaskState {
    return {
      id: 'task-dialect',
      goal: 'do the thing',
      repo_path: workspace,
      constraints: [],
      done_criteria: [],
      created_at: '2026-10-06T00:00:00.000Z',
      plan: { planner: 'local', steps: [], status: 'complete' },
      steps: [],
      status: 'active',
      mode: 'auto',
    };
  }

  test('generic/unset family keeps the system prompt byte-identical; a family adds one dialect section', async () => {
    const { workspace } = await makePoolWorkspace();
    const state = fixtureState(workspace);
    const plain = await new DefaultContextManager({ workspaceRoot: workspace }).buildMessages(state, []);
    const generic = await new DefaultContextManager({ workspaceRoot: workspace, promptFamily: 'generic' }).buildMessages(state, []);
    expect(JSON.stringify(generic)).toBe(JSON.stringify(plain));
    const claude = await new DefaultContextManager({ workspaceRoot: workspace, promptFamily: 'claude' }).buildMessages(state, []);
    expect(claude[0].content).not.toBe(plain[0].content);
    expect(claude[0].content).toContain('## dialect');
    expect(claude[0].content).toContain('<plan>');
  });

  test('runtime resolves auto-detect from the task model id', async () => {
    const { workspace, home } = await makePoolWorkspace();
    let systemPrompt = '';
    const capturing: LLMProvider = {
      async chat(messages) {
        if (!systemPrompt) systemPrompt = messages.find((message) => message.role === 'system')?.content ?? '';
        return response('done: nothing needed');
      },
    };
    const runner = new TaskRunner({ workspaceRoot: workspace, store: new TaskStore(home), provider: capturing, approvalPolicy: 'auto', maxIterations: 3 });
    await runner.run({ goal: 'just look around', cwd: workspace, model: 'qwen2.5-coder-32b' });
    expect(systemPrompt).toContain('## dialect');
    expect(systemPrompt).toContain('numbered list');
  });
});

describe('feature 4: SEARCH/REPLACE edit format', () => {
  const blocks = (search: string, replace: string) => `<<<<<<< SEARCH\n${search}\n=======\n${replace}\n>>>>>>> REPLACE`;

  async function execTool(workspace: string, args: unknown): Promise<ToolResult> {
    return editSearchReplaceTool.execute(args, {
      workspaceRoot: workspace,
      redact: (value) => value,
      env: { ...process.env },
      emitEvent: async () => undefined,
      readOnly: false,
    }) as Promise<ToolResult>;
  }

  test('applies one block, then multiple sequential blocks against the evolving file', async () => {
    const { workspace } = await makePoolWorkspace();
    const file = path.join(workspace, 'src', 'index.ts');
    const single = await execTool(workspace, { path: 'src/index.ts', replacements: blocks('export const x = 1', 'export const x = 2') });
    expect(single.status).toBe('ok');
    expect(await fs.readFile(file, 'utf8')).toBe('export const x = 2\n');
    const multi = await execTool(workspace, {
      path: 'src/index.ts',
      replacements: `${blocks('export const x = 2', 'export const x = 3')}\n${blocks('export const x = 3', 'export const x = 4 // $& stays literal')}`,
    });
    expect(multi.status).toBe('ok');
    expect(multi.meta).toMatchObject({ replacements: 2 });
    expect(editSearchReplaceTool.mutating).toBe(true);
    expect(await fs.readFile(file, 'utf8')).toBe('export const x = 4 // $& stays literal\n');
  });

  test('anchor mismatches fail instructively and write nothing', async () => {
    const { workspace } = await makePoolWorkspace();
    const file = path.join(workspace, 'src', 'index.ts');
    const missing = await execTool(workspace, { path: 'src/index.ts', replacements: blocks('export const y = 9', 'export const y = 10') });
    expect(missing.status).toBe('error');
    expect(missing.output).toContain('anchor matched 0 times');
    expect(missing.output).toContain('byte-exact');
    expect(await fs.readFile(file, 'utf8')).toBe('export const x = 1\n');

    await fs.writeFile(file, 'foo\nfoo\n', 'utf8');
    const ambiguous = await execTool(workspace, { path: 'src/index.ts', replacements: blocks('foo', 'bar') });
    expect(ambiguous.status).toBe('error');
    expect(ambiguous.output).toContain('2 times');
    expect(ambiguous.output).toContain('unique');
    expect(await fs.readFile(file, 'utf8')).toBe('foo\nfoo\n');

    const malformed = await execTool(workspace, { path: 'src/index.ts', replacements: 'just some prose' });
    expect(malformed.status).toBe('error');
    expect(malformed.output).toContain('SEARCH/REPLACE');
    expect(parseSearchReplaceBlocks('<<<<<<< SEARCH\na\n>>>>>>> REPLACE')).toHaveProperty('error');
  });

  test('runtime: search_replace mode emits FILE_CHANGED and the edit guard sees bad syntax; native mode denies the tool', async () => {
    const { workspace, home } = await makePoolWorkspace();
    await fs.writeFile(path.join(workspace, 'src', 'app.mjs'), 'export const a = 1\n', 'utf8');
    const runner = new TaskRunner({
      workspaceRoot: workspace,
      store: new TaskStore(home),
      provider: scriptedModel([
        tool('1', 'write_file', { path: 'src/seed.ts', content: 'export const seed = 1\n' }),
        tool('2', 'edit_search_replace', {
          path: 'src/app.mjs',
          replacements: blocks('export const a = 1', 'export const a = ('),
        }),
        tool('3', 'write_file', { path: 'src/done.ts', content: 'export const done = 1\n' }),
      ]),
      approvalPolicy: 'auto',
      maxIterations: 8,
      editFormat: 'search_replace',
    });
    const result = await runner.run({ goal: 'edit via blocks', cwd: workspace });
    expect(result.report.outcome).toBe('success');
    const changed = result.events.filter((event) => event.type === 'FILE_CHANGED').map((event) => event.payload.tool);
    expect(changed).toContain('edit_search_replace');
    const finished = result.events.find((event) => event.type === 'TOOL_CALL_FINISHED' && event.payload.call.tool === 'edit_search_replace');
    expect(finished?.payload.result.output).toContain('EDIT_GUARD: syntax error in src/app.mjs');
    expect(await fs.readFile(path.join(workspace, 'src', 'app.mjs'), 'utf8')).toBe('export const a = (\n');

    const native = await makePoolWorkspace();
    const nativeRunner = new TaskRunner({
      workspaceRoot: native.workspace,
      store: new TaskStore(native.home),
      provider: scriptedModel([tool('1', 'edit_search_replace', { path: 'src/index.ts', replacements: blocks('1', '2') })]),
      approvalPolicy: 'auto',
      maxIterations: 3,
    });
    const nativeResult = await nativeRunner.run({ goal: 'hallucinated tool', cwd: native.workspace });
    const denied = nativeResult.events.find((event) => event.type === 'TOOL_CALL_FINISHED' && event.payload.call.tool === 'edit_search_replace');
    expect(denied?.payload.result.output).toContain('not available in this run');
    expect(await fs.readFile(path.join(native.workspace, 'src', 'index.ts'), 'utf8')).toBe('export const x = 1\n');
  });
});

describe('feature 5: workspace pins', () => {
  test('sanitize keeps workspace-relative unique paths and caps the count', () => {
    expect(sanitizePins(['src/a.ts', '/abs/path', '../escape', 'src/a.ts', ' ./b.ts ', '', 42, null])).toEqual(['src/a.ts', 'b.ts']);
    expect(sanitizePins(Array.from({ length: 60 }, (_, index) => `f${index}.ts`))).toHaveLength(50);
  });

  test('save/load round-trips through <daedalus-home>/pins.json', async () => {
    const home = await fs.mkdtemp(path.join(tmpdir(), 'daedalus-pins-'));
    expect(await loadPins(home)).toEqual([]);
    await savePins(home, ['src/a.ts', '../bad']);
    expect(await loadPins(home)).toEqual(['src/a.ts']);
  });

  test('pinned files appear in the workspace overview with first-lines and caps', async () => {
    const { workspace } = await makePoolWorkspace();
    const manager = new DefaultContextManager({ workspaceRoot: workspace, pins: ['src/index.ts', 'missing.ts'] });
    const messages = await manager.buildMessages({
      id: 't', goal: 'g', repo_path: workspace, constraints: [], done_criteria: [], created_at: '2026-10-06T00:00:00.000Z',
      plan: { planner: 'local', steps: [], status: 'complete' }, steps: [], status: 'active', mode: 'auto',
    }, []);
    expect(messages[0].content).toContain('Pinned by user');
    expect(messages[0].content).toContain('src/index.ts');
    expect(messages[0].content).toContain(' | export const x = 1');
    expect(messages[0].content).toContain('missing.ts');

    const many = Array.from({ length: 12 }, (_, index) => `p${index}.ts`);
    const capped = await new DefaultContextManager({ workspaceRoot: workspace, pins: many }).buildMessages({
      id: 't', goal: 'g', repo_path: workspace, constraints: [], done_criteria: [], created_at: '2026-10-06T00:00:00.000Z',
      plan: { planner: 'local', steps: [], status: 'complete' }, steps: [], status: 'active', mode: 'auto',
    }, []);
    expect(capped[0].content).toContain('10 of 12 pins shown');
  });
});

describe('feature 6: cross-model review gate', () => {
  function gateRunner(
    workspace: string,
    home: string,
    review: { findings: string; gate?: boolean; reviewerCalls?: string[]; throwReview?: boolean },
  ): TaskRunner {
    return new TaskRunner({
      workspaceRoot: workspace,
      store: new TaskStore(home),
      provider: poolWith({ 'weak-m': writeScript('w'), 'strong-m': [] }, { routing: false }),
      approvalPolicy: 'auto',
      maxIterations: 10,
      modelTiers: TIERS,
      reviewGate: review.gate ?? true,
      reviewProviderFor: (model) => {
        review.reviewerCalls?.push(model);
        return {
          async chat() {
            if (review.throwReview) throw new Error('reviewer down');
            return response(review.findings);
          },
        };
      },
    });
  }

  test('blocking findings demote success to partial and land on the report', async () => {
    const { workspace, home } = await makePoolWorkspace();
    const reviewerCalls: string[] = [];
    const runner = gateRunner(workspace, home, {
      findings: '- **[high] w-a.txt:1** — the generated file is wrong\n',
      reviewerCalls,
    });
    const result = await runner.run({ goal: 'author with the weak model', cwd: workspace, model: 'weak-m' });
    expect(reviewerCalls).toEqual(['strong-m']);
    expect(result.report.outcome).toBe('partial');
    expect(result.report.review).toMatchObject({ model: 'strong-m', author_model: 'weak-m', blocking: true });
    expect(result.report.evidence.some((line) => line.startsWith('review [high]'))).toBe(true);
    const event = result.events.find((entry) => entry.type === 'REVIEW_COMPLETED');
    expect(event?.payload).toMatchObject({ model: 'strong-m', blocking: true });
  });

  test('clean review keeps success; gate off, strongest author, and reviewer failure all skip silently', async () => {
    const clean = await makePoolWorkspace();
    const cleanResult = await gateRunner(clean.workspace, clean.home, { findings: 'No findings.' }).run({ goal: 'clean work', cwd: clean.workspace, model: 'weak-m' });
    expect(cleanResult.report.outcome).toBe('success');
    expect(cleanResult.report.review).toMatchObject({ blocking: false });

    const off = await makePoolWorkspace();
    const calls: string[] = [];
    const offResult = await gateRunner(off.workspace, off.home, { findings: '- **[high] x:1** — bug', gate: false, reviewerCalls: calls }).run({ goal: 'gate off', cwd: off.workspace, model: 'weak-m' });
    expect(offResult.report.outcome).toBe('success');
    expect(calls).toEqual([]);
    expect(offResult.events.some((event) => event.type === 'REVIEW_COMPLETED')).toBe(false);

    const authored = await makePoolWorkspace();
    const strongCalls: string[] = [];
    const authoredRunner = new TaskRunner({
      workspaceRoot: authored.workspace,
      store: new TaskStore(authored.home),
      provider: poolWith({ 'strong-m': writeScript('s'), 'weak-m': [] }, { routing: false }),
      approvalPolicy: 'auto',
      maxIterations: 10,
      modelTiers: TIERS,
      reviewGate: true,
      reviewProviderFor: (model) => {
        strongCalls.push(model);
        return { async chat() { return response('No findings.'); } };
      },
    });
    const authoredResult = await authoredRunner.run({ goal: 'strong author', cwd: authored.workspace, model: 'strong-m' });
    expect(authoredResult.report.outcome).toBe('success');
    expect(strongCalls).toEqual([]);

    const failing = await makePoolWorkspace();
    const failingResult = await gateRunner(failing.workspace, failing.home, { findings: '', throwReview: true }).run({ goal: 'reviewer down', cwd: failing.workspace, model: 'weak-m' });
    expect(failingResult.report.outcome).toBe('success');
  });
});
