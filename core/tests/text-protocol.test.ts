/**
 * Text tool-calling protocol (Cline-style XML fallback) for models that fail
 * at native function calling. Covers the parser (incl. HTML inside CDATA),
 * outbound conversion, the malformed→repair exchange, the `auto` switch
 * after consecutive unusable native responses, and an end-to-end run through
 * the real agent loop with a scripted text-only model.
 */
import { afterEach, describe, expect, test, vi } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  LLMFormatError,
  ProviderRegistry,
  TaskRunner,
  TextProtocolProvider,
  createDefaultRegistry,
  loadSettings,
  parseTextToolCalls,
  parseToolProtocol,
  toTextMessages,
  type ChatResponse,
  type LLMProvider,
  type Message,
  type ToolDefinition,
  type ValidationResult,
  type Validator,
} from '../src/index.ts';

const dirs: string[] = [];
function temp(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}
afterEach(() => {
  vi.restoreAllMocks();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const writeFileTool: ToolDefinition = {
  type: 'function',
  function: {
    name: 'write_file',
    description: 'Write a file',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Path relative to workspace' },
        content: { type: 'string', description: 'Full file contents' },
      },
      required: ['path', 'content'],
    },
  },
};

const createDirTool: ToolDefinition = {
  type: 'function',
  function: {
    name: 'create_dir',
    description: 'Create a directory',
    parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
  },
};

const batchTool: ToolDefinition = {
  type: 'function',
  function: {
    name: 'batch_op',
    description: 'Tool with typed params',
    parameters: {
      type: 'object',
      properties: {
        items: { type: 'array', items: { type: 'string' } },
        count: { type: 'integer' },
        force: { type: 'boolean' },
        label: { type: 'string' },
      },
      required: ['items'],
    },
  },
};

const tools: ToolDefinition[] = [writeFileTool, createDirTool, batchTool];

type InnerCall = { messages: Message[]; tools: ToolDefinition[] | undefined };
function scriptedInner(replies: Array<string | ChatResponse | Error>): { provider: LLMProvider; calls: InnerCall[] } {
  const calls: InnerCall[] = [];
  const queue = [...replies];
  const provider: LLMProvider = {
    name: 'scripted-inner',
    model: 'scripted-model',
    async chat(messages: Message[], toolsArg?: ToolDefinition[]): Promise<ChatResponse> {
      calls.push({ messages, tools: toolsArg });
      const next = queue.shift();
      if (next === undefined) return { message: { role: 'assistant', content: 'done: nothing left scripted' }, finish_reason: 'stop' };
      if (next instanceof Error) throw next;
      if (typeof next === 'string') return { message: { role: 'assistant', content: next }, finish_reason: 'stop' };
      return next;
    },
    async *stream() {
      yield { delta: '' };
    },
  };
  return { provider, calls };
}

function nativeCall(argumentsText: string): ChatResponse {
  return {
    message: {
      role: 'assistant',
      content: '',
      tool_calls: [{ id: 'native-1', type: 'function', function: { name: 'write_file', arguments: argumentsText } }],
    },
    finish_reason: 'tool_calls',
  };
}

describe('parseTextToolCalls', () => {
  test('parses a single call with string params', () => {
    const result = parseTextToolCalls('<tool_call name="write_file"><path>a.txt</path><content>hello</content></tool_call>', tools);
    expect(result.malformed).toBeNull();
    expect(result.calls).toHaveLength(1);
    expect(result.calls[0]).toEqual({ name: 'write_file', args: { path: 'a.txt', content: 'hello' } });
    expect(result.textBefore).toBe('');
  });

  test('keeps leading prose and coerces JSON/number/boolean params by schema', () => {
    const result = parseTextToolCalls(
      'Working on it.\n<tool_call name="batch_op"><items>["a", "b"]</items><count>3</count><force>true</force><label>hi</label></tool_call>',
      tools,
    );
    expect(result.malformed).toBeNull();
    expect(result.textBefore).toBe('Working on it.');
    expect(result.calls[0]?.args).toEqual({ items: ['a', 'b'], count: 3, force: true, label: 'hi' });
  });

  test('survives nested HTML tags and JS comparisons inside CDATA content', () => {
    const html = '<div class="x"><p>Hi</p><script>if (a < b) { go("</div-ish"); }</script></div>';
    const result = parseTextToolCalls(
      `<tool_call name="write_file"><path>site/index.html</path><content><![CDATA[${html}]]></content></tool_call>`,
      tools,
    );
    expect(result.malformed).toBeNull();
    expect(result.calls[0]?.args).toEqual({ path: 'site/index.html', content: html });
  });

  test('survives raw (non-CDATA) HTML with nested tags in a content value', () => {
    const html = '<div><section><p>nested</p></section></div>';
    const result = parseTextToolCalls(
      `<tool_call name="write_file"><path>i.html</path><content>${html}</content></tool_call>`,
      tools,
    );
    expect(result.malformed).toBeNull();
    expect(result.calls[0]?.args.content).toBe(html);
  });

  test('unescapes XML entities in plain text values', () => {
    const result = parseTextToolCalls(
      '<tool_call name="write_file"><path>a.txt</path><content>Tom &amp; Jerry &lt;3</content></tool_call>',
      tools,
    );
    expect(result.calls[0]?.args.content).toBe('Tom & Jerry <3');
  });

  test('parses multiple calls in one reply', () => {
    const result = parseTextToolCalls(
      '<tool_call name="create_dir"><path>d</path></tool_call>\n<tool_call name="write_file"><path>d/f.txt</path><content>x</content></tool_call>',
      tools,
    );
    expect(result.malformed).toBeNull();
    expect(result.calls.map((call) => call.name)).toEqual(['create_dir', 'write_file']);
  });

  test('flags malformed blocks instead of guessing', () => {
    expect(parseTextToolCalls('<tool_call name="nope_tool"><path>x</path></tool_call>', tools).malformed?.reason).toContain('unknown tool');
    expect(parseTextToolCalls('<tool_call name="write_file"><path>x</path>', tools).malformed?.reason).toContain('unterminated');
    expect(parseTextToolCalls('<tool_call name="batch_op"><items>[not json</items></tool_call>', tools).malformed?.reason).toContain('could not parse');
    expect(parseTextToolCalls('<tool_call><path>x</path></tool_call>', tools).malformed?.reason).toContain('without a name');
  });
});

describe('toTextMessages conversion', () => {
  test('appends the protocol block, renders tool results as text, never sends tool-role on the wire', () => {
    const source: Message[] = [
      { role: 'system', content: 'You are Daedalus.' },
      { role: 'user', content: 'make it' },
      { role: 'assistant', content: '', tool_calls: [{ id: 'c1', type: 'function', function: { name: 'create_dir', arguments: '{"path":"d"}' } }] },
      { role: 'tool', tool_call_id: 'c1', name: 'create_dir', content: 'created d' },
    ];
    const converted = toTextMessages(source, tools);
    expect(converted[0]?.role).toBe('system');
    expect(converted[0]?.content).toContain('TOOL PROTOCOL');
    expect(converted[0]?.content).toContain('<tool name="write_file">');
    expect(converted.some((message) => (message as { role: string }).role === 'tool')).toBe(false);
    const resultMessage = converted.find((message) => message.role === 'user' && message.content.includes('<tool_result'));
    expect(resultMessage?.content).toContain('name="create_dir"');
    expect(resultMessage?.content).toContain('created d');
    const assistantTurn = converted.find((message) => message.role === 'assistant' && message.content.includes('<tool_call'));
    expect(assistantTurn?.content).toContain('<path>d</path>');
  });
});

describe('TextProtocolProvider text mode', () => {
  test('calls the inner provider without tools and parses the XML reply into tool_calls', async () => {
    const { provider: inner, calls } = scriptedInner([
      '<tool_call name="write_file"><path>index.html</path><content><![CDATA[<div><p>hi</p></div>]]></content></tool_call>',
    ]);
    const provider = new TextProtocolProvider(inner, { protocol: 'text' });
    const response = await provider.chat([{ role: 'user', content: 'go' }], tools);
    expect(calls[0]?.tools).toBeUndefined();
    expect((calls[0]?.messages[0]?.content as string)).toContain('TOOL PROTOCOL');
    expect(response.message.tool_calls).toHaveLength(1);
    expect(JSON.parse(response.message.tool_calls![0]!.function.arguments)).toEqual({ path: 'index.html', content: '<div><p>hi</p></div>' });
  });

  test('malformed emission triggers exactly one instructive repair exchange', async () => {
    const { provider: inner, calls } = scriptedInner([
      '<tool_call name="write_file"><path>oops</path>', // unterminated
      '<tool_call name="write_file"><path>ok.txt</path><content>fixed</content></tool_call>',
    ]);
    const provider = new TextProtocolProvider(inner, { protocol: 'text' });
    const response = await provider.chat([{ role: 'user', content: 'go' }], tools);
    expect(calls).toHaveLength(2);
    const repairFeedback = calls[1]!.messages.at(-1);
    expect(repairFeedback?.role).toBe('user');
    expect(repairFeedback?.content).toContain('could not be parsed');
    expect(repairFeedback?.content).toContain('<tool_call name="write_file">');
    expect(response.message.tool_calls).toHaveLength(1);
  });

  test('a still-malformed repair reply degrades to plain text for the loop to correct', async () => {
    const { provider: inner, calls } = scriptedInner([
      '<tool_call name="nope"></tool_call>',
      'I do not understand the format',
    ]);
    const provider = new TextProtocolProvider(inner, { protocol: 'text' });
    const response = await provider.chat([{ role: 'user', content: 'go' }], tools);
    expect(calls).toHaveLength(2);
    expect(response.message.tool_calls).toBeUndefined();
    expect(response.message.content).toBe('I do not understand the format');
  });
});

describe('TextProtocolProvider auto switch', () => {
  test('switches to text after 2 consecutive unusable native replies and stays there', async () => {
    const onSwitch = vi.fn();
    const { provider: inner, calls } = scriptedInner([
      nativeCall('{not json'),
      nativeCall('also {bad'),
      '<tool_call name="write_file"><path>a.txt</path><content>via text</content></tool_call>',
      'done: finished in text mode',
    ]);
    const provider = new TextProtocolProvider(inner, { protocol: 'auto', onProtocolSwitch: onSwitch });
    const messages: Message[] = [{ role: 'user', content: 'go' }];

    await expect(provider.chat(messages, tools)).rejects.toBeInstanceOf(LLMFormatError);
    const switched = await provider.chat(messages, tools);
    expect(provider.activeProtocol).toBe('text');
    expect(provider.switchedToText).toBe(true);
    expect(onSwitch).toHaveBeenCalledTimes(1);
    expect(onSwitch.mock.calls[0]![0]).toMatchObject({ from: 'native', to: 'text', failures: 2 });
    expect(switched.message.tool_calls).toHaveLength(1);
    expect(calls).toHaveLength(3);
    expect(calls[0]?.tools).toEqual(tools);
    expect(calls[2]?.tools).toBeUndefined();

    const final = await provider.chat(messages, tools);
    expect(final.message.content).toContain('done:');
    expect(calls[3]?.tools).toBeUndefined();
  });

  test('counts thrown format errors toward the same budget', async () => {
    const { provider: inner } = scriptedInner([
      new LLMFormatError('empty response body'),
      nativeCall('{oops'),
      '<tool_call name="create_dir"><path>d</path></tool_call>',
    ]);
    const provider = new TextProtocolProvider(inner, { protocol: 'auto' });
    const messages: Message[] = [{ role: 'user', content: 'go' }];
    await expect(provider.chat(messages, tools)).rejects.toBeInstanceOf(LLMFormatError);
    const switched = await provider.chat(messages, tools);
    expect(provider.activeProtocol).toBe('text');
    expect(switched.message.tool_calls?.[0]?.function.name).toBe('create_dir');
  });

  test('a usable native reply resets the consecutive-failure counter', async () => {
    const onSwitch = vi.fn();
    const { provider: inner } = scriptedInner([
      nativeCall('{bad'),
      { message: { role: 'assistant', content: 'done: all good' }, finish_reason: 'stop' },
      nativeCall('{bad again'),
      { message: { role: 'assistant', content: 'done: still fine' }, finish_reason: 'stop' },
    ]);
    const provider = new TextProtocolProvider(inner, { protocol: 'auto', onProtocolSwitch: onSwitch });
    const messages: Message[] = [{ role: 'user', content: 'go' }];
    await expect(provider.chat(messages, tools)).rejects.toBeInstanceOf(LLMFormatError);
    await provider.chat(messages, tools);
    await expect(provider.chat(messages, tools)).rejects.toBeInstanceOf(LLMFormatError);
    await provider.chat(messages, tools);
    expect(provider.activeProtocol).toBe('native');
    expect(onSwitch).not.toHaveBeenCalled();
  });

  test('protocol=native is a pure passthrough, even for malformed args', async () => {
    const { provider: inner, calls } = scriptedInner([nativeCall('{bad'), nativeCall('{worse')]);
    const provider = new TextProtocolProvider(inner, { protocol: 'native' });
    const messages: Message[] = [{ role: 'user', content: 'go' }];
    const first = await provider.chat(messages, tools);
    const second = await provider.chat(messages, tools);
    expect(first.message.tool_calls).toHaveLength(1);
    expect(second.message.tool_calls).toHaveLength(1);
    expect(calls.every((call) => call.tools === tools)).toBe(true);
    expect(provider.activeProtocol).toBe('native');
  });
});

describe('settings + stored provider config', () => {
  test('LLM_TOOL_PROTOCOL parses, defaults to auto, and rejects garbage', () => {
    expect(loadSettings({ LLM_TOOL_PROTOCOL: 'text' }).llm.toolProtocol).toBe('text');
    expect(loadSettings({ LLM_TOOL_PROTOCOL: 'native' }).llm.toolProtocol).toBe('native');
    expect(loadSettings({}).llm.toolProtocol).toBe('auto');
    expect(parseToolProtocol('TEXT')).toBe('text');
    expect(() => parseToolProtocol('yaml')).toThrow(/LLM_TOOL_PROTOCOL/);
  });

  test('stored providers persist toolProtocol through sanitize and the public view', () => {
    const registry = new ProviderRegistry(temp('daedalus-providers-'));
    const saved = registry.upsert({ id: 'weak-model', name: 'Weak', baseUrl: 'http://local/v1', apiKey: 'x', models: ['m'], toolProtocol: 'text' });
    expect(saved.toolProtocol).toBe('text');
    expect(registry.get('weak-model')?.toolProtocol).toBe('text');
    const publicView = registry.list().find((entry) => entry.id === 'weak-model');
    expect(publicView?.toolProtocol).toBe('text');
    const untouched = registry.upsert({ id: 'plain', name: 'Plain', baseUrl: 'http://local/v1', models: ['m'] });
    expect(untouched.toolProtocol).toBeUndefined();
  });
});

describe('text protocol end-to-end through the real agent loop', () => {
  test('a text-only scripted model creates a folder and an HTML file, then finishes done', async () => {
    const project = temp('daedalus-text-e2e-');
    const html = '<!doctype html><html><body><h1>Kopi Senja</h1><script>if (1 < 2) { console.log("ok"); }</script></body></html>';
    const { provider: inner } = scriptedInner([
      '<tool_call name="list_dir"><path>.</path></tool_call>',
      '<tool_call name="create_dir"><path>site</path></tool_call>',
      `<tool_call name="write_file"><path>site/index.html</path><content><![CDATA[${html}]]></content></tool_call>`,
      'done: created site/index.html landing page',
    ]);
    const provider = new TextProtocolProvider(inner, { protocol: 'text' });
    const validator: Validator = {
      async validate(): Promise<ValidationResult> {
        return { checks: [{ name: 'fixture', cmd: 'node validate.js', status: 'pass', exit_code: 0, summary: 'passed', diagnostics: [] }] };
      },
    };
    const runner = new TaskRunner({
      workspaceRoot: project,
      provider,
      validator,
      registry: createDefaultRegistry(),
      approvalPolicy: 'auto',
      questionGate: false,
      maxValidationAttempts: 1,
    });
    const result = await runner.run({ goal: 'Create a site folder with an index.html landing page' });
    expect(result.outcome).toBe('success');
    expect(existsSync(join(project, 'site', 'index.html'))).toBe(true);
    expect(readFileSync(join(project, 'site', 'index.html'), 'utf8')).toBe(html);
    expect(result.events.some((event) => event.type === 'TOOL_CALL_FINISHED' && (event.payload as { call?: { tool?: string } }).call?.tool === 'write_file')).toBe(true);
  });
});
