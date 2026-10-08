import { describe, expect, test } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AgentLoop, EventBus, TaskStore } from '../src/index.ts';
import { StreamMessageAssembler } from '../src/providers/llm/stream-assembly.ts';
import type { LLMProvider, StreamChunk } from '../src/providers/llm/types.ts';

/**
 * Token streaming (gap: Web froze between turns). The assembler must
 * rebuild the exact message chat() would return — fragmented tool
 * calls included — and the loop must emit cumulative MODEL_TEXT_DELTA
 * events only when streamText is on, falling back to chat() when a
 * provider refuses to stream at all.
 */

describe('StreamMessageAssembler', () => {
  test('concatenates content and reassembles fragmented tool calls by index', () => {
    const assembler = new StreamMessageAssembler();
    const chunks: StreamChunk[] = [
      { type: 'delta', content: 'Let me ' },
      { type: 'delta', content: 'check.', tool_calls: [{ index: 0, id: 'c1', type: 'function', function: { name: 'read_', arguments: '' } } as never] },
      { type: 'delta', content: '', tool_calls: [{ index: 0, function: { name: 'file', arguments: '{"pa' } } as never] },
      { type: 'delta', content: '', tool_calls: [{ index: 0, function: { arguments: 'th":"a.ts"}' } } as never, { index: 1, id: 'c2', type: 'function', function: { name: 'grep', arguments: '{"q":"x"}' } } as never] },
      { type: 'usage', usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } },
      { type: 'finish', finish_reason: 'tool_calls' },
    ];
    for (const chunk of chunks) assembler.push(chunk);
    const response = assembler.toResponse();
    expect(response.message.content).toBe('Let me check.');
    expect(response.message.tool_calls).toEqual([
      { id: 'c1', type: 'function', function: { name: 'read_file', arguments: '{"path":"a.ts"}' } },
      { id: 'c2', type: 'function', function: { name: 'grep', arguments: '{"q":"x"}' } },
    ]);
    expect(response.usage?.total_tokens).toBe(15);
    expect(response.finish_reason).toBe('tool_calls');
    expect(assembler.text).toBe('Let me check.');
    expect(assembler.empty).toBe(false);
  });

  test('a text-only stream yields no tool_calls key', () => {
    const assembler = new StreamMessageAssembler();
    assembler.push({ type: 'delta', content: 'done: all set' });
    expect(assembler.toResponse().message).toEqual({ role: 'assistant', content: 'done: all set' });
  });
});

function workspace(): string {
  return mkdtempSync(join(tmpdir(), 'daedalus-stream-'));
}

const readFileTool = {
  type: 'function',
  function: {
    name: 'read_file',
    description: 'read',
    parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
  },
} as const;

describe('agent loop streaming', () => {
  test('deltas stream live, the assembled tool call executes, chat() is never called', async () => {
    const store = new TaskStore(workspace());
    let turns = 0;
    const provider: LLMProvider = {
      name: 'streamer',
      async chat() {
        throw new Error('chat() must not be called on the stream path');
      },
      async *stream(): AsyncIterable<StreamChunk> {
        turns += 1;
        if (turns === 1) {
          yield { type: 'delta', content: 'Reading ' };
          yield { type: 'delta', content: 'the file.', tool_calls: [{ index: 0, id: 's1', type: 'function', function: { name: 'read_file', arguments: '{"path":"a.ts"}' } } as never] };
          yield { type: 'finish', finish_reason: 'tool_calls' };
          return;
        }
        yield { type: 'delta', content: 'Now the second one.', tool_calls: [{ index: 0, id: 's2', type: 'function', function: { name: 'read_file', arguments: '{"path":"b.ts"}' } } as never] };
        yield { type: 'finish', finish_reason: 'tool_calls' };
      },
    };
    const executed: string[] = [];
    const loop = new AgentLoop({
      provider,
      bus: new EventBus(),
      store,
      tools: [readFileTool as never],
      executeTool: async (call) => {
        executed.push(call.tool);
        return { call_id: call.id, status: 'ok', output: 'file body', truncated: false, meta: {} };
      },
      stopPolicy: { max_iterations: 10, max_errors: 3 },
      streamText: true,
    });
    const state = await loop.run({ id: 'stream-task', goal: 'read a.ts', constraints: [], done_criteria: ['examine the first file', 'examine the second file'], repo_path: workspace(), status: 'draft' });
    expect(executed).toEqual(['read_file', 'read_file']);
    expect(state.status).toBe('done');
    const events = store.replay('stream-task');
    const deltas = events.filter((event) => event.type === 'MODEL_TEXT_DELTA');
    expect(deltas.length).toBeGreaterThan(0);
    expect(deltas.some((event) => (event.payload as { text: string }).text === 'Reading the file.')).toBe(true);
    const finished = events.find((event) => event.type === 'MODEL_REQUEST_FINISHED');
    expect((finished?.payload as { message: { content: string } }).message.content).toBe('Reading the file.');
  });

  test('a provider that refuses streaming falls back to chat()', async () => {
    const store = new TaskStore(workspace());
    let chatTurns = 0;
    const provider: LLMProvider = {
      name: 'no-stream',
      async chat() {
        chatTurns += 1;
        if (chatTurns === 1) {
          return {
            message: {
              role: 'assistant' as const,
              content: '',
              tool_calls: [{ id: 'f1', type: 'function' as const, function: { name: 'read_file', arguments: '{"path":"a.ts"}' } }],
            },
          };
        }
        return { message: { role: 'assistant' as const, content: 'done: read it' } };
      },
      async *stream(): AsyncIterable<StreamChunk> {
        throw new Error('stream_options unsupported');
      },
    };
    const loop = new AgentLoop({
      provider,
      bus: new EventBus(),
      store,
      tools: [readFileTool as never],
      executeTool: async (call) => ({ call_id: call.id, status: 'ok', output: 'x', truncated: false, meta: {} }),
      stopPolicy: { max_iterations: 10, max_errors: 3 },
      streamText: true,
    });
    const state = await loop.run({ id: 'fallback-task', goal: 'just answer', constraints: [], done_criteria: ['examine the file'], repo_path: workspace(), status: 'draft' });
    expect(state.status).toBe('done');
    expect(store.replay('fallback-task').some((event) => event.type === 'MODEL_TEXT_DELTA')).toBe(false);
  });

  test('streamText off keeps the per-turn rhythm (no deltas)', async () => {
    const store = new TaskStore(workspace());
    let chatTurns = 0;
    const provider: LLMProvider = {
      name: 'plain',
      async chat() {
        chatTurns += 1;
        if (chatTurns === 1) {
          return {
            message: {
              role: 'assistant' as const,
              content: '',
              tool_calls: [{ id: 'p1', type: 'function' as const, function: { name: 'read_file', arguments: '{"path":"a.ts"}' } }],
            },
          };
        }
        return { message: { role: 'assistant' as const, content: 'done: read it' } };
      },
      async *stream(): AsyncIterable<StreamChunk> {
        yield { type: 'delta', content: 'should not be used' };
      },
    };
    const loop = new AgentLoop({
      provider,
      bus: new EventBus(),
      store,
      tools: [readFileTool as never],
      executeTool: async (call) => ({ call_id: call.id, status: 'ok', output: 'x', truncated: false, meta: {} }),
      stopPolicy: { max_iterations: 10, max_errors: 3 },
    });
    const state = await loop.run({ id: 'plain-task', goal: 'just answer', constraints: [], done_criteria: ['examine the file'], repo_path: workspace(), status: 'draft' });
    expect(state.status).toBe('done');
    expect(store.replay('plain-task').some((event) => event.type === 'MODEL_TEXT_DELTA')).toBe(false);
  });
});
