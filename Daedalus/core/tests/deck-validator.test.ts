import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import {
  EventBus,
  TaskRunner,
  TaskStore,
  newDeck,
  writeDeck,
  type LLMProvider,
  type Message,
} from '../src/index.ts';
import { DeckValidator } from '../src/slides/deck-validator.ts';
import { writeFileSync } from 'node:fs';

const cleanups: Array<() => void> = [];
afterEach(() => {
  while (cleanups.length) cleanups.pop()?.();
});

function temp(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

describe('DeckValidator (the Slide domain validator)', () => {
  test('no deck yet is a failed check that names the remedy', async () => {
    const root = temp('daedalus-deckval-none-');
    const result = await new DeckValidator().validate({ workspaceRoot: root });
    expect(result.checks).toHaveLength(1);
    expect(result.checks[0]?.status).toBe('fail');
    expect(result.checks[0]?.summary).toContain('create_deck');
  });

  test('a schema-valid deck passes', async () => {
    const root = temp('daedalus-deckval-ok-');
    await writeDeck(root, newDeck('Keamanan Anak'));
    const result = await new DeckValidator().validate({ workspaceRoot: root });
    expect(result.checks[0]?.status).toBe('pass');
  });

  test('a deck with validation errors fails with the count', async () => {
    const root = temp('daedalus-deckval-bad-');
    const deck = newDeck('Rusak');
    deck.slides.push({ id: 's-bad', layout: 'bullets', content: {} } as never);
    await writeDeck(root, deck);
    const result = await new DeckValidator().validate({ workspaceRoot: root });
    expect(result.checks[0]?.status).toBe('fail');
    expect(result.checks[0]?.summary).toContain('validation error');
  });
});

type ToolAction = { tool: string; args?: Record<string, unknown> } | 'done';

function toolProvider(script: ToolAction[]): LLMProvider {
  let step = 0;
  return {
    name: 'deckval-scripted',
    async chat(_messages: Message[]) {
      const action = script[step++] ?? 'done';
      if (action === 'done') {
        return { message: { role: 'assistant' as const, content: 'done: finished' } };
      }
      return {
        message: {
          role: 'assistant' as const,
          content: '',
          tool_calls: [{ id: `call-${step}`, type: 'function' as const, function: { name: action.tool, arguments: JSON.stringify(action.args ?? {}) } }],
        },
      };
    },
    async *stream() {
      yield { type: 'delta', content: '' };
    },
  };
}

describe('slide tasks in a code repo (owner-laptop conditions)', () => {
  test('a slide task is validated against its deck, not the repo npm checks', async () => {
    const root = temp('daedalus-deckval-repo-');
    // A repo whose own checks all fail — under the coding validator this
    // task could never complete (the owner's 2026-10-08 laptop run).
    writeFileSync(join(root, 'package.json'), JSON.stringify({
      name: 'repo-with-failing-checks',
      scripts: { test: 'false', lint: 'false', build: 'false' },
    }));
    const provider = toolProvider([
      { tool: 'create_deck', args: { title: 'Keamanan Anak' } },
      { tool: 'add_slide', args: { layout: 'bullets', content: { title: 'Poin', points: ['satu'] } } },
      { tool: 'export_deck', args: {} },
    ]);
    const store = new TaskStore(temp('daedalus-deckval-store-'));
    const runner = new TaskRunner({
      workspaceRoot: root,
      store,
      bus: new EventBus(),
      provider,
      approvalPolicy: 'auto',
    });

    const { state } = await runner.run({
      goal: 'buatkan deck presentasi tentang keamanan anak\noutline deck dibuat\nisi slide lengkap\ndeck ter-export ke pptx',
      taskId: 'deckval-repo-task',
      domain: 'slide',
    });

    expect(state.status).toBe('done');
    expect(state.last_error).toBeUndefined();
  });
});
