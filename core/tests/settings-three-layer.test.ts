import { afterEach, describe, expect, test, vi } from 'vitest';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  AgentLoop,
  EventBus,
  OpenAICompatProvider,
  QuestionBroker,
  SlideEngine,
  TaskRunner,
  TaskStore,
  createTokenBudget,
  loadSettings,
  parseThinkingLevel,
  parseToolRules,
  resolveThinkingLevel,
  type ChatResponse,
  type Event,
  type LLMProvider,
  type Message,
  type TaskSpec,
  type ToolRules,
  type Validator,
} from '../src/index.ts';
import { parseModelStrategy } from '../src/providers/llm/model-pool.ts';
import { isToolCallDenied, toolCallPolicy, toolModePolicy, toolRulesDecision } from '../src/interaction/modes.ts';

const dirs: string[] = [];

function temp(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  vi.unstubAllGlobals();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const passingValidator: Validator = {
  async validate() {
    return { checks: [{ name: 'fixture', cmd: 'true', status: 'pass' as const, exit_code: 0, summary: 'passed', diagnostics: [] }] };
  },
};

function taskSpec(goal: string, root: string): TaskSpec {
  return { id: `spec-${Math.random().toString(36).slice(2, 8)}`, goal, repo_path: root, constraints: [], done_criteria: [], created_at: new Date().toISOString() };
}

describe('thinking level', () => {
  test('parseThinkingLevel: default medium, case-insensitive, invalid throws', () => {
    expect(parseThinkingLevel(undefined)).toBe('medium');
    expect(parseThinkingLevel('')).toBe('medium');
    expect(parseThinkingLevel('off')).toBe('off');
    expect(parseThinkingLevel('LOW')).toBe('low');
    expect(parseThinkingLevel('Medium')).toBe('medium');
    expect(parseThinkingLevel('high')).toBe('high');
    expect(() => parseThinkingLevel('extreme')).toThrow(/Invalid DAEDALUS_THINKING_LEVEL/);
    expect(() => parseThinkingLevel('bogus', '--thinking-level')).toThrow(/--thinking-level/);
  });

  test('resolveThinkingLevel: explicit level wins, thinking=false means off, else fallback', () => {
    expect(resolveThinkingLevel({ thinkingLevel: 'low' }, 'medium')).toBe('low');
    expect(resolveThinkingLevel({ thinkingLevel: 'high', thinking: false }, 'medium')).toBe('high');
    expect(resolveThinkingLevel({ thinking: false }, 'medium')).toBe('off');
    expect(resolveThinkingLevel({ thinking: false }, 'high')).toBe('off');
    expect(resolveThinkingLevel({ thinking: true }, 'low')).toBe('low');
    expect(resolveThinkingLevel({}, 'high')).toBe('high');
  });

  test('loadSettings reads DAEDALUS_THINKING_LEVEL, keeps the deprecated thinking boolean', () => {
    const defaults = loadSettings({ DAEDALUS_HOME: temp('s3l-home-') });
    expect(defaults.session.thinkingLevel).toBe('medium');
    expect(defaults.session.thinking).toBe(true);
    const low = loadSettings({ DAEDALUS_HOME: temp('s3l-home-'), DAEDALUS_THINKING_LEVEL: 'low' });
    expect(low.session.thinkingLevel).toBe('low');
    // The deprecated boolean still parses and means what it always meant.
    const off = loadSettings({ DAEDALUS_HOME: temp('s3l-home-'), DAEDALUS_THINKING: 'off' });
    expect(off.session.thinking).toBe(false);
    expect(off.session.thinkingLevel).toBe('medium');
    expect(() => loadSettings({ DAEDALUS_THINKING_LEVEL: 'ultra' })).toThrow(/Invalid DAEDALUS_THINKING_LEVEL/);
  });

  test('AgentLoop: thinkingLevel off disables THOUGHT events; legacy thinking=false still works', async () => {
    const chatWithReasoning = (): LLMProvider => ({
      name: 'reasoning-fake',
      async chat(): Promise<ChatResponse> {
        return { message: { role: 'assistant', content: 'done', reasoning_content: 'private reasoning' } };
      },
      async *stream() {
        yield { type: 'delta', content: '' };
      },
    });
    const run = async (options: { thinkingLevel?: 'off' | 'low'; thinking?: boolean }): Promise<Event[]> => {
      const workspace = temp('daedalus-thinklvl-ws-');
      const store = new TaskStore(join(workspace, 'store'));
      const loop = new AgentLoop({
        provider: chatWithReasoning(),
        bus: new EventBus(),
        store,
        stopPolicy: { max_iterations: 3, max_errors: 3 },
        executeTool: async (call) => ({ call_id: call.id, status: 'ok', output: 'ok', truncated: false, meta: {} }),
        ...options,
      });
      const state = await loop.run('do it\ndone: finished');
      return store.replay(state.id);
    };
    expect((await run({ thinkingLevel: 'low' })).some((e) => e.type === 'THOUGHT')).toBe(true);
    expect((await run({ thinkingLevel: 'off' })).some((e) => e.type === 'THOUGHT')).toBe(false);
    expect((await run({ thinking: false })).some((e) => e.type === 'THOUGHT')).toBe(false);
    expect((await run({})).some((e) => e.type === 'THOUGHT')).toBe(true);
  });

  test('AgentLoop stamps reasoningEffort from the level on every chat call (merge, never clobber)', async () => {
    const seen: Array<Record<string, unknown>> = [];
    const provider: LLMProvider = {
      name: 'capture',
      async chat(_messages: Message[], _tools?: unknown, options?: Record<string, unknown>): Promise<ChatResponse> {
        seen.push({ ...(options ?? {}) });
        return { message: { role: 'assistant', content: 'done' } };
      },
      async *stream() {
        yield { type: 'delta', content: '' };
      },
    };
    const workspace = temp('daedalus-effort-ws-');
    const loop = new AgentLoop({
      provider,
      bus: new EventBus(),
      store: new TaskStore(join(workspace, 'store')),
      thinkingLevel: 'high',
      chatOptions: { temperature: 0.2 },
      stopPolicy: { max_iterations: 2, max_errors: 2 },
      executeTool: async (call) => ({ call_id: call.id, status: 'ok', output: 'ok', truncated: false, meta: {} }),
    });
    await loop.run('do it\ndone: finished');
    expect(seen.length).toBeGreaterThan(0);
    for (const options of seen) {
      expect(options.reasoningEffort).toBe('high');
      expect(options.temperature).toBe(0.2);
    }
    // 'off' omits reasoningEffort entirely.
    seen.length = 0;
    const loopOff = new AgentLoop({
      provider,
      bus: new EventBus(),
      store: new TaskStore(join(workspace, 'store2')),
      thinkingLevel: 'off',
      stopPolicy: { max_iterations: 2, max_errors: 2 },
      executeTool: async (call) => ({ call_id: call.id, status: 'ok', output: 'ok', truncated: false, meta: {} }),
    });
    await loopOff.run('do it\ndone: finished');
    for (const options of seen) expect('reasoningEffort' in options).toBe(false);
  });
});

describe('llm settings: temperature, prompt caching, domains', () => {
  test('loadSettings defaults and parsing', () => {
    const defaults = loadSettings({ DAEDALUS_HOME: temp('s3l-home-') });
    expect(defaults.llm.temperature).toBe(0.7);
    expect(defaults.llm.promptCaching).toBe(false);
    expect(defaults.domains).toEqual({ coding: {}, slide: {}, spreadsheet: {}, dokumen: {} });
    const custom = loadSettings({
      DAEDALUS_HOME: temp('s3l-home-'),
      LLM_TEMPERATURE: '0.2',
      DAEDALUS_PROMPT_CACHING: 'on',
      DAEDALUS_DOMAIN_SLIDE_MODEL: 'slide-model',
      DAEDALUS_DOMAIN_SLIDE_TEMPERATURE: '0.1',
      DAEDALUS_DOMAIN_CODING_MAX_ITERATIONS: '10',
      DAEDALUS_DOMAIN_DOKUMEN_MODEL: '  ',
    });
    expect(custom.llm.temperature).toBe(0.2);
    expect(custom.llm.promptCaching).toBe(true);
    expect(custom.domains.slide).toEqual({ model: 'slide-model', temperature: 0.1 });
    expect(custom.domains.coding).toEqual({ maxIterations: 10 });
    expect(custom.domains.dokumen).toEqual({});
    expect(custom.domains.spreadsheet).toEqual({});
  });

  test('invalid temperature / domain numbers fail fast', () => {
    expect(() => loadSettings({ LLM_TEMPERATURE: '5' })).toThrow(/Invalid LLM_TEMPERATURE/);
    expect(() => loadSettings({ LLM_TEMPERATURE: 'abc' })).toThrow(/Invalid LLM_TEMPERATURE/);
    expect(() => loadSettings({ LLM_TEMPERATURE: '-0.5' })).toThrow(/Invalid LLM_TEMPERATURE/);
    expect(() => loadSettings({ DAEDALUS_DOMAIN_SLIDE_TEMPERATURE: '3' })).toThrow(/Invalid DAEDALUS_DOMAIN_SLIDE_TEMPERATURE/);
    expect(() => loadSettings({ DAEDALUS_DOMAIN_CODING_MAX_ITERATIONS: '0' })).toThrow(/Invalid DAEDALUS_DOMAIN_CODING_MAX_ITERATIONS/);
    expect(() => loadSettings({ DAEDALUS_DOMAIN_DOKUMEN_MAX_ITERATIONS: 'x' })).toThrow(/Invalid DAEDALUS_DOMAIN_DOKUMEN_MAX_ITERATIONS/);
  });
});

describe('parseToolRules', () => {
  test('parses, trims, dedupes, keeps the wildcard', () => {
    expect(parseToolRules({ allow: ['run_command', ' run_command ', ''], ask: ['*'], deny: ['write_file', 'write_file'] })).toEqual({
      allow: ['run_command'],
      ask: ['*'],
      deny: ['write_file'],
    });
  });

  test('missing lists default to empty; all-empty means undefined', () => {
    expect(parseToolRules({ deny: ['x'] })).toEqual({ allow: [], ask: [], deny: ['x'] });
    expect(parseToolRules({})).toBeUndefined();
    expect(parseToolRules({ allow: [], ask: ['  '], deny: [] })).toBeUndefined();
  });

  test('invalid shapes fail soft to undefined', () => {
    expect(parseToolRules(undefined)).toBeUndefined();
    expect(parseToolRules(null)).toBeUndefined();
    expect(parseToolRules('deny:*')).toBeUndefined();
    expect(parseToolRules(['write_file'])).toBeUndefined();
    expect(parseToolRules({ deny: 'write_file' })).toBeUndefined();
    expect(parseToolRules({ deny: [42] })).toBeUndefined();
  });
});

describe('createTokenBudget', () => {
  test('meters provider-reported totals; exhausted at used >= limit', () => {
    const budget = createTokenBudget(100);
    expect(budget.limit).toBe(100);
    expect(budget.used).toBe(0);
    expect(budget.exhausted).toBe(false);
    budget.add({ total_tokens: 60 });
    expect(budget.used).toBe(60);
    expect(budget.exhausted).toBe(false);
    budget.add(undefined);
    budget.add({});
    expect(budget.used).toBe(60);
    budget.add({ total_tokens: 40 });
    expect(budget.used).toBe(100);
    expect(budget.exhausted).toBe(true);
  });

  test('invalid limits throw', () => {
    expect(() => createTokenBudget(0)).toThrow(/Invalid token budget/);
    expect(() => createTokenBudget(-5)).toThrow(/Invalid token budget/);
    expect(() => createTokenBudget(1.5)).toThrow(/Invalid token budget/);
  });
});

describe('tool rules in the mode policy', () => {
  const rules = (overrides: Partial<ToolRules>): ToolRules => ({ allow: [], ask: [], deny: [], ...overrides });

  test('deny wins over everything, including the wildcard', () => {
    expect(toolModePolicy('auto', 'write_file', false, rules({ deny: ['write_file'] }))).toEqual({ visible: true, approval: 'deny' });
    expect(isToolCallDenied('auto', 'write_file', undefined, false, rules({ deny: ['write_file'] }))).toBe(true);
    // Wildcard denies every tool, even reads.
    expect(isToolCallDenied('auto', 'read_file', undefined, false, rules({ deny: ['*'] }))).toBe(true);
    // deny beats ask and allow on the same tool.
    expect(toolRulesDecision(rules({ deny: ['x'], ask: ['x'], allow: ['x'] }), 'x')).toBe('deny');
  });

  test('ask forces the approval question even where auto-approve would allow', () => {
    // Auto + autoApprove: write_file (mutating) would be 'auto' without rules.
    expect(toolModePolicy('auto', 'write_file', true)).toEqual({ visible: true, approval: 'auto' });
    expect(toolModePolicy('auto', 'write_file', true, rules({ ask: ['write_file'] }))).toEqual({ visible: true, approval: 'ask' });
    expect(toolCallPolicy('auto', 'write_file', undefined, true, rules({ ask: ['write_file'] })).approval).toBe('ask');
    expect(toolModePolicy('auto', 'run_command', true, rules({ ask: ['*'] }))).toEqual({ visible: true, approval: 'ask' });
  });

  test('allow skips the question', () => {
    // Auto without autoApprove: run_command (executing) would be 'ask' without rules.
    expect(toolModePolicy('auto', 'run_command', false)).toEqual({ visible: true, approval: 'ask' });
    expect(toolModePolicy('auto', 'run_command', false, rules({ allow: ['run_command'] }))).toEqual({ visible: true, approval: 'auto' });
    expect(toolCallPolicy('manual', 'run_command', undefined, false, rules({ allow: ['*'] })).approval).toBe('auto');
  });

  test('no rules means the existing logic, untouched', () => {
    expect(toolModePolicy('auto', 'read_file', false)).toEqual({ visible: true, approval: 'auto' });
    expect(toolModePolicy('manual', 'write_file', false)).toEqual({ visible: true, approval: 'ask' });
    expect(isToolCallDenied('ask', 'write_file')).toBe(true);
    expect(isToolCallDenied('auto', 'write_file')).toBe(false);
  });

  test('a mode that hides the tool keeps it denied — rules grant approval, never visibility', () => {
    expect(toolModePolicy('ask', 'write_file', false, rules({ allow: ['write_file'] }))).toEqual({ visible: false, approval: 'deny' });
    expect(isToolCallDenied('ask', 'write_file', undefined, false, rules({ allow: ['*'] }))).toBe(true);
  });
});

describe('openai-compat: reasoning_effort', () => {
  const okResponse = (content = 'hi'): Response =>
    new Response(
      JSON.stringify({ choices: [{ message: { role: 'assistant', content }, finish_reason: 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    );

  function providerWith(fetchImpl: typeof fetch): { provider: OpenAICompatProvider; bodies: Array<Record<string, unknown>> } {
    const bodies: Array<Record<string, unknown>> = [];
    const provider = new OpenAICompatProvider({
      baseUrl: 'https://example.test/v1',
      apiKey: 'test',
      model: 'm',
      fetch: (async (input: unknown, init?: { body?: unknown }) => {
        bodies.push(JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>);
        return fetchImpl(input, init);
      }) as typeof fetch,
    });
    return { provider, bodies };
  }

  test('reasoning_effort is sent when set, omitted when not', async () => {
    const { provider, bodies } = providerWith(async () => okResponse());
    await provider.chat([{ role: 'user', content: 'hi' }], undefined, { reasoningEffort: 'high' });
    expect(bodies[0]).toMatchObject({ reasoning_effort: 'high' });
    await provider.chat([{ role: 'user', content: 'hi' }]);
    expect('reasoning_effort' in (bodies[1] ?? {})).toBe(false);
  });

  test('a 400 blaming reasoning_effort retries once without it', async () => {
    let calls = 0;
    const { provider, bodies } = providerWith(async () => {
      calls += 1;
      if (calls === 1) {
        return new Response(JSON.stringify({ error: { message: "Unknown parameter: 'reasoning_effort'", type: 'invalid_request_error' } }), {
          status: 400,
          headers: { 'content-type': 'application/json' },
        });
      }
      return okResponse('recovered');
    });
    const response = await provider.chat([{ role: 'user', content: 'hi' }], undefined, { reasoningEffort: 'medium' });
    expect(response.message.content).toBe('recovered');
    expect(calls).toBe(2);
    expect(bodies[0]).toMatchObject({ reasoning_effort: 'medium' });
    expect('reasoning_effort' in (bodies[1] ?? {})).toBe(false);
  });

  test('a 400 about something else does not retry and keeps its error', async () => {
    let calls = 0;
    const { provider } = providerWith(async () => {
      calls += 1;
      return new Response(JSON.stringify({ error: { message: 'bad request: malformed messages', type: 'invalid_request_error' } }), {
        status: 400,
        headers: { 'content-type': 'application/json' },
      });
    });
    await expect(provider.chat([{ role: 'user', content: 'hi' }], undefined, { reasoningEffort: 'low' })).rejects.toThrow('malformed messages');
    expect(calls).toBe(1);
  });

  test('the stream path gets the same fallback', async () => {
    let calls = 0;
    const { provider, bodies } = providerWith(async () => {
      calls += 1;
      if (calls === 1) {
        return new Response(JSON.stringify({ error: { message: 'unrecognized reasoning_effort field', type: 'invalid_request_error' } }), {
          status: 400,
          headers: { 'content-type': 'application/json' },
        });
      }
      return new Response('data: {"choices":[{"delta":{"content":"hi"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n', {
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
      });
    });
    const chunks = [];
    for await (const chunk of provider.stream([{ role: 'user', content: 'hi' }], undefined, { reasoningEffort: 'low' })) chunks.push(chunk);
    expect(calls).toBe(2);
    expect(bodies[0]).toMatchObject({ reasoning_effort: 'low' });
    expect('reasoning_effort' in (bodies[1] ?? {})).toBe(false);
    expect(chunks.some((c) => c.type === 'delta' && (c as { content?: string }).content === 'hi')).toBe(true);
  });
});

describe('runtime: domain model / temperature / maxIterations precedence', () => {
  /** Stub fetch that records OpenAI request bodies and answers per the system prompt. */
  function stubFetch(onBody: (body: Record<string, unknown>) => unknown): Array<Record<string, unknown>> {
    const seen: Array<Record<string, unknown>> = [];
    vi.stubGlobal(
      'fetch',
      async (_input: unknown, init?: { body?: unknown }) => {
        const body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
        seen.push(body);
        return new Response(JSON.stringify(onBody(body)), { status: 200, headers: { 'content-type': 'application/json' } });
      },
    );
    return seen;
  }

  const textAnswer = (content: string) => ({ choices: [{ message: { role: 'assistant', content }, finish_reason: 'stop' }] });
  const toolCallAnswer = (tool: string, args: Record<string, unknown>) => ({
    choices: [
      {
        message: {
          role: 'assistant',
          content: '',
          tool_calls: [{ id: 'call-1', type: 'function', function: { name: tool, arguments: JSON.stringify(args) } }],
        },
        finish_reason: 'tool_calls',
      },
    ],
  });

  /**
   * Stateful coding stub: the helper-title call gets plain text, the
   * first loop turn writes a file (delivered work, so the run can
   * complete), later turns close with done text.
   */
  function codingStub(seen: Array<Record<string, unknown>>, doneText: string): (body: Record<string, unknown>) => unknown {
    return (body) => {
      seen.push(body);
      const text = (body.messages as Array<{ content: string }>).map((m) => m.content).join('\n');
      if (text.includes('Write a short title')) return textAnswer('Test title');
      if (seen.length === 2) return toolCallAnswer('write_file', { path: 'result.txt', content: 'hi\n' });
      return textAnswer(doneText);
    };
  }

  test('coding run: global temperature 0.7 + reasoning_effort from the session level', async () => {
    const workspace = temp('daedalus-domtemp-ws-');
    const home = temp('daedalus-domtemp-home-');
    const seen: Array<Record<string, unknown>> = [];
    stubFetch(codingStub(seen, 'done: said hi'));
    const runner = new TaskRunner({
      settings: loadSettings({ LLM_BASE_URL: 'https://example.test/v1', LLM_API_KEY: 'x', DAEDALUS_HOME: home }),
      workspaceRoot: workspace,
      store: new TaskStore(home),
      approvalPolicy: 'auto',
      maxIterations: 4,
    });
    const result = await runner.run({ goal: 'Say hi\ndone: said hi' });
    expect(result.outcome).toBe('success');
    const turns = seen.filter((b) => b.temperature !== undefined && !(b.messages as Array<{ content: string }>).map((m) => m.content).join('\n').includes('Write a short title'));
    expect(turns.length).toBeGreaterThan(0);
    for (const body of turns) expect(body).toMatchObject({ temperature: 0.7, reasoning_effort: 'medium' });
  });

  test('DAEDALUS_THINKING_LEVEL=off omits reasoning_effort', async () => {
    const workspace = temp('daedalus-domtemp-off-ws-');
    const home = temp('daedalus-domtemp-off-home-');
    const seen: Array<Record<string, unknown>> = [];
    stubFetch(codingStub(seen, 'done: said hi'));
    const runner = new TaskRunner({
      settings: loadSettings({ LLM_BASE_URL: 'https://example.test/v1', LLM_API_KEY: 'x', DAEDALUS_HOME: home, DAEDALUS_THINKING_LEVEL: 'off' }),
      workspaceRoot: workspace,
      store: new TaskStore(home),
      approvalPolicy: 'auto',
      maxIterations: 4,
    });
    const result = await runner.run({ goal: 'Say hi\ndone: said hi' });
    expect(result.outcome).toBe('success');
    const turns = seen.filter((b) => b.temperature !== undefined);
    expect(turns.length).toBeGreaterThan(0);
    for (const body of turns) {
      expect(body.temperature).toBe(0.7);
      expect('reasoning_effort' in body).toBe(false);
    }
  });

  test('slide domain: domain model + domain temperature reach the engine calls', async () => {
    const workspace = temp('daedalus-domslide-ws-');
    const home = temp('daedalus-domslide-home-');
    const seen = stubFetch((body) => {
      const messages = body.messages as Array<{ content: string }>;
      const system = messages[0]?.content ?? '';
      const user = messages[1]?.content ?? '';
      let content: unknown = {};
      if (system.includes('OUTLINE stage')) {
        const count = Number(/slide_count: (\d+)/.exec(user)?.[1] ?? 2);
        content = Array.from({ length: count }, (_, i) => ({
          title: `Slide ${i + 1}`,
          layoutId: i === 0 ? 'title' : 'bullets',
          keyMessage: `point ${i + 1}`,
        }));
      } else if (system.includes('FILL stage')) {
        const layout = /layout: (\S+)/.exec(user)?.[1] ?? 'bullets';
        content = layout === 'title' ? { title: 'Judul Deck', subtitle: 'Ringkasan' } : { title: 'Judul Slide', points: ['satu', 'dua'] };
      }
      return { choices: [{ message: { role: 'assistant', content: JSON.stringify(content) }, finish_reason: 'stop' }] };
    });
    const runner = new TaskRunner({
      settings: loadSettings({
        LLM_BASE_URL: 'https://example.test/v1',
        LLM_API_KEY: 'x',
        DAEDALUS_HOME: home,
        DAEDALUS_DOMAIN_SLIDE_MODEL: 'slide-model',
        DAEDALUS_DOMAIN_SLIDE_TEMPERATURE: '0.1',
      }),
      workspaceRoot: workspace,
      store: new TaskStore(home),
      approvalPolicy: 'auto',
    });
    const result = await runner.run({ goal: 'buatkan deck tentang kucing', domain: 'slide', slide: { generation: 'smart', slideCount: 2 } });
    expect(result.outcome).toBe('success');
    const turns = seen.filter((b) => b.model === 'slide-model');
    expect(turns.length).toBeGreaterThan(0);
    for (const body of turns) {
      expect(body.temperature).toBe(0.1);
      expect(body.reasoning_effort).toBe('medium');
    }
  });

  test('per-task model beats the domain model; domain maxIterations beats the default', async () => {
    const workspace = temp('daedalus-domprec-ws-');
    const home = temp('daedalus-domprec-home-');
    writeFileSync(join(workspace, 'README.md'), '# fixture\n');
    const seen = stubFetch(() => ({
      choices: [
        {
          message: {
            role: 'assistant',
            content: '',
            tool_calls: [{ id: 'call-1', type: 'function', function: { name: 'read_file', arguments: JSON.stringify({ path: 'README.md' }) } }],
          },
          finish_reason: 'tool_calls',
        },
      ],
    }));
    const runner = new TaskRunner({
      settings: loadSettings({
        LLM_BASE_URL: 'https://example.test/v1',
        LLM_API_KEY: 'x',
        DAEDALUS_HOME: home,
        DAEDALUS_DOMAIN_CODING_MODEL: 'domain-model',
        DAEDALUS_DOMAIN_CODING_MAX_ITERATIONS: '2',
      }),
      workspaceRoot: workspace,
      store: new TaskStore(home),
      approvalPolicy: 'auto',
    });
    // Per-task model wins over the domain model.
    await runner.run({ goal: 'inspect\n', domain: 'coding', model: 'task-model', maxIterations: 1 });
    expect(seen.some((b) => b.model === 'task-model')).toBe(true);
    expect(seen.some((b) => b.model === 'domain-model')).toBe(false);
    seen.length = 0;
    // Domain model wins over the global default; domain maxIterations (2) stops the run.
    const result = await runner.run({ goal: 'inspect\n', domain: 'coding' });
    expect(seen.length).toBeGreaterThan(0);
    for (const body of seen) expect(body.model).toBe('domain-model');
    const requests = result.events.filter((e) => e.type === 'MODEL_REQUEST_FINISHED');
    expect(requests.length).toBe(2);
    const completed = result.events.find((e) => e.type === 'TASK_COMPLETED');
    expect((completed?.payload as { reason?: string }).reason).toBe('max_iterations');
  });
});

describe('token budget in the coding loop', () => {
  function budgetProvider(totalTokens: number): LLMProvider {
    let calls = 0;
    return {
      name: 'budget-fake',
      async chat(): Promise<ChatResponse> {
        calls += 1;
        return {
          message: {
            role: 'assistant',
            content: '',
            tool_calls: [{ id: `call-${calls}`, type: 'function' as const, function: { name: 'read_file', arguments: '{"path":"README.md"}' } }],
          },
          usage: { prompt_tokens: totalTokens - 20, completion_tokens: 20, total_tokens: totalTokens },
        };
      },
      async *stream() {
        yield { type: 'delta', content: '' };
      },
    };
  }

  test('exhaustion stops the loop cleanly with outcome budget_exhausted', async () => {
    const workspace = temp('daedalus-budget-ws-');
    writeFileSync(join(workspace, 'README.md'), '# fixture\n');
    const store = new TaskStore(join(workspace, 'store'));
    const loop = new AgentLoop({
      provider: budgetProvider(120),
      bus: new EventBus(),
      store,
      thinkingLevel: 'low',
      tokenBudget: createTokenBudget(100),
      stopPolicy: { max_iterations: 10, max_errors: 5 },
      executeTool: async (call) => ({ call_id: call.id, status: 'ok', output: 'read ok', truncated: false, meta: {} }),
    });
    const state = await loop.run('inspect\n');
    const completed = store.replay(state.id).find((e) => e.type === 'TASK_COMPLETED');
    expect((completed?.payload as { outcome?: string }).outcome).toBe('budget_exhausted');
    expect(state.last_error).toBe('budget_exhausted');
    expect(state.last_observation).toBe('Budget token habis: 120/100 token.');
  });

  test('no budget configured means no budget stop', async () => {
    const workspace = temp('daedalus-nobudget-ws-');
    const store = new TaskStore(join(workspace, 'store'));
    const loop = new AgentLoop({
      provider: budgetProvider(120),
      bus: new EventBus(),
      store,
      stopPolicy: { max_iterations: 2, max_errors: 5 },
      executeTool: async (call) => ({ call_id: call.id, status: 'ok', output: 'read ok', truncated: false, meta: {} }),
    });
    const state = await loop.run('inspect\n');
    expect(state.last_error).toBe('max_iterations');
  });

  test('TaskRunner reports budget_exhausted with the evidence line', async () => {
    const workspace = temp('daedalus-budgetrun-ws-');
    const home = temp('daedalus-budgetrun-home-');
    writeFileSync(join(workspace, 'README.md'), '# fixture\n');
    const runner = new TaskRunner({
      workspaceRoot: workspace,
      store: new TaskStore(home),
      bus: new EventBus(),
      provider: budgetProvider(120),
      approvalPolicy: 'auto',
      maxIterations: 10,
    });
    const result = await runner.run({ goal: 'inspect the project\n', tokenBudget: 100 });
    expect(result.report.outcome).toBe('budget_exhausted');
    expect(result.outcome).toBe('partial');
    expect(result.report.evidence).toContain('Budget token habis: 120/100 token.');
  });

  test('a non-positive tokenBudget is ignored (no budget)', async () => {
    const workspace = temp('daedalus-budgetzero-ws-');
    const home = temp('daedalus-budgetzero-home-');
    writeFileSync(join(workspace, 'README.md'), '# fixture\n');
    const runner = new TaskRunner({
      workspaceRoot: workspace,
      store: new TaskStore(home),
      bus: new EventBus(),
      provider: budgetProvider(120),
      approvalPolicy: 'auto',
      maxIterations: 2,
    });
    const result = await runner.run({ goal: 'inspect the project\n', tokenBudget: 0 });
    expect(result.report.outcome).not.toBe('budget_exhausted');
  });
});

describe('token budget in the SlideEngine', () => {
  /** Scripted provider with provider-reported usage on every response. */
  function scriptedWithUsage(handler: (system: string, user: string) => unknown): { provider: LLMProvider; calls: Array<Record<string, unknown>> } {
    const calls: Array<Record<string, unknown>> = [];
    const provider: LLMProvider = {
      name: 'engine-scripted-usage',
      async chat(messages: Message[], _tools?: unknown, options?: Record<string, unknown>) {
        const text = (m: Message): string => (typeof m.content === 'string' ? m.content : m.content.map((b) => (b.type === 'text' ? b.text : '')).join(''));
        calls.push({ ...(options ?? {}) });
        const out = handler(text(messages[0]!), text(messages[1]!));
        if (out instanceof Error) throw out;
        return {
          message: { role: 'assistant' as const, content: typeof out === 'string' ? out : JSON.stringify(out) },
          usage: { prompt_tokens: 12, completion_tokens: 6, total_tokens: 18 },
          finish_reason: 'stop',
        };
      },
      async *stream() {
        yield { type: 'delta', content: '' };
      },
    };
    return { provider, calls };
  }

  test('exhaustion ends the run partial with honest evidence (deck kept)', async () => {
    const root = temp('daedalus-slidebudget-ws-');
    const store = new TaskStore(temp('daedalus-slidebudget-store-'));
    const { provider, calls } = scriptedWithUsage((system, user) => {
      if (system.includes('OUTLINE stage')) {
        const count = Number(/slide_count: (\d+)/.exec(user)?.[1] ?? 2);
        return Array.from({ length: count }, (_, i) => ({ title: `Slide ${i + 1}`, layoutId: i === 0 ? 'title' : 'bullets', keyMessage: `p${i + 1}` }));
      }
      if (system.includes('FILL stage')) {
        const layout = /layout: (\S+)/.exec(user)?.[1] ?? 'bullets';
        return layout === 'title' ? { title: 'Judul Deck', subtitle: 'Ringkasan' } : { title: 'Judul Slide', points: ['satu', 'dua'] };
      }
      return {};
    });
    // Budget 10 < one response's 18 tokens: the outline call succeeds,
    // the first fill call throws, the run ends partial — never a crash.
    const engine = new SlideEngine({
      provider,
      bus: new EventBus(),
      store,
      questions: new QuestionBroker(),
      workspaceRoot: root,
      tokenBudget: createTokenBudget(10),
    });
    const result = await engine.run(taskSpec('buatkan deck tentang kucing', root), { generation: 'smart', slideCount: 2 });
    expect(result.outcome).toBe('partial');
    expect(result.summary).toContain('Budget token habis (18/10 token).');
    // The outline call went through (budget still had room); the first
    // fill call hit the exhausted budget and never reached the provider.
    expect(calls.length).toBeGreaterThanOrEqual(1);
  });

  test('engine chatOptions carry the domain temperature into every call', async () => {
    const root = temp('daedalus-slidetemp-ws-');
    const store = new TaskStore(temp('daedalus-slidetemp-store-'));
    const { provider, calls } = scriptedWithUsage((system, user) => {
      if (system.includes('OUTLINE stage')) {
        const count = Number(/slide_count: (\d+)/.exec(user)?.[1] ?? 2);
        return Array.from({ length: count }, (_, i) => ({ title: `Slide ${i + 1}`, layoutId: i === 0 ? 'title' : 'bullets', keyMessage: `p${i + 1}` }));
      }
      if (system.includes('FILL stage')) return { title: 'Judul Slide', points: ['satu', 'dua'] };
      return {};
    });
    const engine = new SlideEngine({
      provider,
      bus: new EventBus(),
      store,
      questions: new QuestionBroker(),
      workspaceRoot: root,
      chatOptions: { temperature: 0.1, reasoningEffort: 'low' },
    });
    const result = await engine.run(taskSpec('buatkan deck tentang kucing', root), { generation: 'smart', slideCount: 2 });
    expect(result.outcome).toBe('success');
    expect(calls.length).toBeGreaterThan(0);
    for (const options of calls) {
      expect(options.temperature).toBe(0.1);
      expect(options.reasoningEffort).toBe('low');
    }
  });
});

describe('tool rules end to end', () => {
  type ScriptStep = { tool: string; args: Record<string, unknown> } | { text: string };

  function scriptedProvider(script: ScriptStep[]): LLMProvider {
    let index = 0;
    return {
      name: 'scripted',
      async chat(): Promise<ChatResponse> {
        const step = script[index++];
        if (!step) return { message: { role: 'assistant', content: 'done: work complete' } };
        if ('text' in step) return { message: { role: 'assistant', content: step.text } };
        return {
          message: {
            role: 'assistant',
            content: '',
            tool_calls: [{ id: `call-${index}`, type: 'function' as const, function: { name: step.tool, arguments: JSON.stringify(step.args) } }],
          },
        };
      },
      async *stream() {
        yield { type: 'delta', content: '' };
      },
    };
  }

  function makeRunner(root: string, provider: LLMProvider, extra: Record<string, unknown> = {}): TaskRunner {
    return new TaskRunner({
      workspaceRoot: root,
      store: new TaskStore(temp('daedalus-rules-store-')),
      bus: new EventBus(),
      provider,
      validator: passingValidator,
      approvalPolicy: 'auto',
      maxIterations: 4,
      ...extra,
    });
  }

  test('deny: the loop hard-denies before any approval layer', async () => {
    const root = temp('daedalus-rulesdeny-ws-');
    const runner = makeRunner(root, scriptedProvider([{ tool: 'write_file', args: { path: 'x.txt', content: 'x' } }, { text: 'done' }]));
    const result = await runner.run({ goal: 'Write a file\ndone: file written', toolRules: { allow: [], ask: [], deny: ['write_file'] } });
    expect(existsSync(join(root, 'x.txt'))).toBe(false);
    const finished = result.events.find((e) => e.type === 'TOOL_CALL_FINISHED');
    expect((finished?.payload as { result?: { status?: string; meta?: { reason?: string } } }).result?.status).toBe('denied');
    expect((finished?.payload as { result?: { meta?: { reason?: string } } }).result?.meta?.reason).toBe('mode_policy');
    expect(result.events.some((e) => e.type === 'APPROVAL_REQUESTED')).toBe(false);
  });

  test('ask: the approval question is forced even where auto mode would auto-allow', async () => {
    const root = temp('daedalus-rulesask-ws-');
    const runner = makeRunner(root, scriptedProvider([{ tool: 'write_file', args: { path: 'y.txt', content: 'y' } }, { text: 'done' }]));
    const asked: string[] = [];
    const result = await runner.run({
      goal: 'Write a file\ndone: file written',
      toolRules: { allow: [], ask: ['write_file'], deny: [] },
      onEvent: (event: Event) => {
        if (event.type !== 'APPROVAL_REQUESTED') return;
        const info = (event.payload as { approval?: { id: string; tool: string } }).approval;
        if (info) {
          asked.push(info.tool);
          setTimeout(() => runner.approvals.decideById(info.id, { decision: 'deny' }), 5);
        }
      },
    });
    // Auto mode + mutating write_file is normally auto-allowed; the rule forced a question.
    expect(asked).toContain('write_file');
    expect(existsSync(join(root, 'y.txt'))).toBe(false);
  });

  test('allow: the approval question is skipped', async () => {
    const root = temp('daedalus-rulesallow-ws-');
    const runner = makeRunner(
      root,
      scriptedProvider([{ tool: 'run_command', args: { command: 'echo', args: ['hi'] } }, { text: 'done' }]),
      { approvalPolicy: 'ask' },
    );
    const asked: string[] = [];
    const result = await runner.run({
      goal: 'Run a command\ndone: command ran',
      toolRules: { allow: ['run_command'], ask: [], deny: [] },
      onEvent: (event: Event) => {
        if (event.type !== 'APPROVAL_REQUESTED') return;
        const info = (event.payload as { approval?: { id: string; tool: string } }).approval;
        if (info) asked.push(info.tool);
      },
    });
    // Auto mode without auto-approve would ask for run_command; the rule skipped it.
    expect(asked).not.toContain('run_command');
    const finished = result.events.filter((e) => e.type === 'TOOL_CALL_FINISHED');
    expect(finished.length).toBeGreaterThan(0);
    expect((finished[0]?.payload as { result?: { status?: string } }).result?.status).toBe('ok');
  });
});
