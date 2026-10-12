/**
 * Composition regression (PR #63 follow-up): the per-domain tool split
 * removed the nine deck tools from the coding default registry, but a
 * presentation goal typed in the Coding domain still arms
 * CODING_SLIDE_GOAL_CONTRACT and the loop's slide-export gate — both of
 * which demand create_deck/…/export_deck. Without those tools in the
 * run, such a goal could never complete. The runtime now adds
 * SLIDE_TOOLS at registry composition exactly when the same predicate
 * (presentationCreationGoal) fires; these tests drive the PRODUCTION
 * composition (TaskRunner) rather than a hand-built registry.
 */
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import {
  DEFAULT_TOOLS,
  TaskRunner,
  TaskStore,
  type ChatResponse,
  type LLMProvider,
  type Message,
} from '../src/index.ts';
import { SLIDE_TOOLS } from '../src/tools/slides.ts';

const cleanups: Array<() => void> = [];
afterEach(() => {
  while (cleanups.length) cleanups.pop()?.();
});

function temp(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

type Step = { tool: string; args: unknown } | { text: string };

/**
 * Scripted provider that also records the tool surface (names) it is
 * handed on every chat call — that surface IS the production registry
 * composition the run operates with.
 */
function capturingProvider(steps: Step[], captured: string[][]): LLMProvider {
  let index = 0;
  return {
    name: 'fake',
    async chat(_messages: Message[], tools?: unknown): Promise<ChatResponse> {
      const surface = ((tools ?? []) as Array<{ name?: string; function?: { name?: string } }>)
        .map((tool) => tool.function?.name ?? tool.name ?? '?');
      captured.push(surface);
      const step: Step = steps[index++] ?? { text: 'done: script exhausted' };
      if ('text' in step) return { message: { role: 'assistant', content: step.text }, finish_reason: 'stop' };
      return {
        message: {
          role: 'assistant',
          content: '',
          tool_calls: [{ id: `call-${index}`, type: 'function' as const, function: { name: step.tool, arguments: JSON.stringify(step.args) } }],
        },
        finish_reason: 'tool_calls',
      };
    },
    async *stream() {
      yield { type: 'delta', content: '' };
    },
  };
}

const slideToolNames = SLIDE_TOOLS.map((tool) => tool.name).sort();

async function runTask(goal: string, steps: Step[], taskId: string) {
  const home = temp('daedalus-csg-home-');
  const ws = temp('daedalus-csg-ws-');
  const captured: string[][] = [];
  const runner = new TaskRunner({
    workspaceRoot: ws,
    store: new TaskStore(home),
    provider: capturingProvider(steps, captured),
    approvalPolicy: 'auto',
    maxIterations: 10,
    questionGate: false,
  });
  const result = await runner.run({ goal, taskId, cwd: ws });
  return { result, captured, ws };
}

const deckScript: Step[] = [
  { tool: 'create_deck', args: { title: 'Biologi' } },
  { tool: 'add_slide', args: { layout: 'bullets', content: { title: 'Sel', points: ['satu', 'dua'] } } },
  { tool: 'export_deck', args: {} },
  { text: 'done: deck biologi selesai' },
];

describe('coding-domain registry composition by goal', () => {
  test('a presentation goal in Coding carries the deck tools alongside the coding tools', async () => {
    const { captured } = await runTask('buatkan 8 slide tentang biologi', deckScript, 'csg-deck-surface');
    const surface = captured[0] ?? [];
    for (const name of slideToolNames) {
      expect(surface, `presentation-goal run must carry ${name}`).toContain(name);
    }
    // The coding tools ride along untouched — this is one registry, not a swap.
    for (const name of ['read_file', 'write_file', 'run_command']) {
      expect(surface).toContain(name);
    }
  });

  test('an ordinary coding goal keeps the lean coding-only surface', async () => {
    const { captured } = await runTask(
      'buatkan file catatan tentang biologi',
      [{ tool: 'write_file', args: { path: 'catatan.txt', content: 'halo\n' } }],
      'csg-plain-surface',
    );
    const surface = captured[0] ?? [];
    for (const name of slideToolNames) {
      expect(surface, `ordinary coding run must not carry ${name}`).not.toContain(name);
    }
    for (const tool of DEFAULT_TOOLS) {
      expect(surface).toContain(tool.name);
    }
  });

  test('the presentation surface is exactly the coding surface plus the nine deck tools', async () => {
    const plain = await runTask(
      'buatkan file catatan tentang biologi',
      [{ tool: 'write_file', args: { path: 'catatan.txt', content: 'halo\n' } }],
      'csg-diff-plain',
    );
    const deck = await runTask('buatkan 8 slide tentang biologi', deckScript, 'csg-diff-deck');
    const plainSet = new Set(plain.captured[0] ?? []);
    const deckSet = new Set(deck.captured[0] ?? []);
    expect([...deckSet].filter((name) => !plainSet.has(name)).sort()).toEqual(slideToolNames);
    expect([...plainSet].filter((name) => !deckSet.has(name))).toEqual([]);
  });

  test('a "buatkan slide" goal in Coding completes through the real composition (no gate deadlock)', async () => {
    const { result, ws } = await runTask('buatkan 8 slide tentang biologi', deckScript, 'csg-deck-complete');
    expect(result.state.status).toBe('done');
    expect(result.state.last_error).toBeUndefined();
    const deckDir = join(ws, 'deck');
    const pptx = existsSync(deckDir) ? readdirSync(deckDir).filter((name) => name.endsWith('.pptx')) : [];
    expect(pptx).toHaveLength(1);
  });
});
