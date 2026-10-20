import { afterEach, describe, expect, test } from 'vitest';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  AgentLoop,
  EventBus,
  OpenAICompatProvider,
  TaskRunner,
  TaskStore,
  loadSettings,
  resolveDaedalusHome,
  thoughtFromMessage,
  type Event,
  type LLMProvider,
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
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const passValidator: Validator = {
  async validate(): Promise<ValidationResult> {
    return { checks: [{ name: 'fixture', cmd: 'true', status: 'pass', exit_code: 0, summary: 'passed', diagnostics: [] }] };
  },
};

function reasoningProvider(): LLMProvider {
  let calls = 0;
  return {
    name: 'reasoning-fake',
    async chat() {
      calls += 1;
      if (calls === 1) {
        return {
          message: {
            role: 'assistant',
            content: '',
            reasoning_content: 'I should inspect the workspace before changing anything.',
            tool_calls: [{ id: 'call-1', type: 'function' as const, function: { name: 'write_file', arguments: '{"path":"result.txt","content":"inspected\\n"}' } }],
          },
        };
      }
      return { message: { role: 'assistant', content: 'done: inspected' } };
    },
    async *stream() {
      yield { type: 'delta', content: 'done' };
    },
  };
}

describe('shared local Daedalus home', () => {
  test('relative homes anchor to the workspace and absolute homes win', () => {
    const workspace = temp('daedalus-home-ws-');
    expect(resolveDaedalusHome('.daedalus', workspace)).toBe(join(workspace, '.daedalus'));
    expect(resolveDaedalusHome('custom-home', workspace)).toBe(join(workspace, 'custom-home'));
    expect(resolveDaedalusHome('/tmp/daedalus-absolute-home', workspace)).toBe('/tmp/daedalus-absolute-home');
  });

  test('TaskRunner defaults to <workspace>/.daedalus so CLI and Web share task state', async () => {
    const workspace = temp('daedalus-shared-ws-');
    writeFileSync(join(workspace, 'README.md'), '# fixture\n');
    const runner = new TaskRunner({
      workspaceRoot: workspace,
      provider: reasoningProvider(),
      validator: passValidator,
      approvalPolicy: 'auto',
      settings: loadSettings({ DAEDALUS_HOME: '.daedalus' }),
    });

    expect(runner.store.root).toBe(join(workspace, '.daedalus'));
    const result = await runner.run({ goal: 'Inspect the project\ndone: inspected', thinking: true });
    expect(result.outcome).toBe('success');
    const taskId = result.state.id;
    expect(existsSync(join(workspace, '.daedalus', 'tasks', taskId, 'state.json'))).toBe(true);
    expect(existsSync(join(workspace, '.daedalus', 'tasks', taskId, 'events.jsonl'))).toBe(true);
    expect(existsSync(join(workspace, '.daedalus', 'tasks', taskId, 'report.json'))).toBe(true);
    expect(runner.store.replay(taskId).some((event) => event.type === 'THOUGHT')).toBe(true);
  });
});

describe('thinking mode', () => {
  test('thoughtFromMessage only uses real provider reasoning or tool-call rationale', () => {
    expect(thoughtFromMessage({ role: 'assistant', content: '', reasoning_content: 'real reasoning' })).toMatchObject({
      text: 'real reasoning',
      source: 'provider_reasoning',
      truncated: false,
    });
    expect(
      thoughtFromMessage({
        role: 'assistant',
        content: 'I will read the file first.',
        tool_calls: [{ id: 'c1', type: 'function', function: { name: 'read_file', arguments: '{}' } }],
      }),
    ).toMatchObject({ source: 'assistant_tool_call_content' });
    expect(thoughtFromMessage({ role: 'assistant', content: 'final answer only' })).toBeUndefined();
  });

  test('AgentLoop emits THOUGHT when thinking is on and none when it is off', async () => {
    const run = async (thinking: boolean): Promise<Event[]> => {
      const workspace = temp('daedalus-thought-ws-');
      const store = new TaskStore(join(workspace, 'store'));
      const events: Event[] = [];
      const loop = new AgentLoop({
        provider: reasoningProvider(),
        bus: new EventBus(),
        store,
        thinking,
        stopPolicy: { max_iterations: 5, max_errors: 3 },
        executeTool: async (call) => ({ call_id: call.id, status: 'ok', output: 'read ok', truncated: false, meta: {} }),
      });
      const state = await loop.run('Inspect README\ndone: inspected');
      events.push(...store.replay(state.id));
      return events;
    };

    const on = await run(true);
    const thought = on.find((event) => event.type === 'THOUGHT');
    expect(thought?.payload).toMatchObject({ text: 'I should inspect the workspace before changing anything.', source: 'provider_reasoning' });

    const off = await run(false);
    expect(off.some((event) => event.type === 'THOUGHT')).toBe(false);
  });

  test('OpenAI-compatible provider preserves reasoning_content fields', async () => {
    const provider = new OpenAICompatProvider({
      baseUrl: 'https://example.test/v1',
      apiKey: 'test',
      model: 'reasoner',
      fetch: (async () =>
        new Response(
          JSON.stringify({
            choices: [{ message: { role: 'assistant', content: '', reasoning_content: 'provider-side reasoning' }, finish_reason: 'tool_calls' }],
            usage: { prompt_tokens: 1, completion_tokens: 1 },
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        )) as typeof fetch,
    });
    const result = await provider.chat([{ role: 'user', content: 'hi' }]);
    expect(result.message.reasoning_content).toBe('provider-side reasoning');
  });
});
