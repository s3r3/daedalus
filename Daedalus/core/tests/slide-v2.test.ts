import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import {
  EventBus,
  LLMFormatError,
  TaskRunner,
  TaskStore,
  newDeck,
  validateDeck,
  type LLMProvider,
  type Message,
} from '../src/index.ts';
import { createDeckTool, setDeckThemeTool } from '../src/tools/slides.ts';

const cleanups: Array<() => void> = [];
afterEach(() => {
  while (cleanups.length) cleanups.pop()?.();
});

function temp(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

type ToolAction = { tool: string; args?: Record<string, unknown> } | 'done';

function scriptedProvider(script: ToolAction[], capture?: { tools: string[]; systems: string[] }): LLMProvider {
  let step = 0;
  return {
    name: 'slide-v2-scripted',
    async chat(messages: Message[], tools?: unknown) {
      if (capture) {
        const names = (tools as Array<{ function?: { name?: string }; name?: string }> | undefined ?? [])
          .map((tool) => tool.function?.name ?? tool.name ?? '')
          .filter(Boolean);
        capture.tools.push(...names);
        const system = messages.find((message) => message.role === 'system');
        capture.systems.push(typeof system?.content === 'string' ? system.content : '');
      }
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

function makeRunner(root: string, provider: LLMProvider): { runner: TaskRunner; store: TaskStore } {
  const store = new TaskStore(temp('daedalus-slidev2-store-'));
  const runner = new TaskRunner({
    workspaceRoot: root,
    store,
    bus: new EventBus(),
    provider,
    approvalPolicy: 'auto',
  });
  return { runner, store };
}

describe('Agentic Slide v2 (Farid design 2026-10-09)', () => {
  test('the slide toolset is locked: coding tools are neither offered nor executable', async () => {
    const root = temp('daedalus-slidev2-lock-');
    const capture = { tools: [] as string[], systems: [] as string[] };
    const provider = scriptedProvider([
      { tool: 'write_file', args: { path: 'notes.md', content: '# draft\n' } },
      { tool: 'run_command', args: { command: 'echo', args: ['hi'] } },
      { tool: 'create_deck', args: { title: 'Keamanan Anak' } },
      { tool: 'add_slide', args: { layout: 'bullets', content: { title: 'Poin', points: ['satu'] } } },
      { tool: 'export_deck', args: {} },
    ], capture);
    const { runner } = makeRunner(root, provider);

    const { state } = await runner.run({
      goal: 'buatkan deck tentang keamanan anak\ndeck dibuat dan terisi\ndeck ter-export ke pptx',
      taskId: 'slidev2-lock',
      domain: 'slide',
      slide: { generation: 'smart' },
    });

    expect(state.status).toBe('done');
    expect(existsSync(join(root, 'notes.md'))).toBe(false);
    const offered = new Set(capture.tools);
    expect(offered.has('create_deck')).toBe(true);
    expect(offered.has('ask_user')).toBe(true);
    expect(offered.has('write_file')).toBe(false);
    expect(offered.has('run_command')).toBe(false);
    expect(offered.has('read_skill')).toBe(false);
    expect(offered.has('spawn_subagent')).toBe(false);
  });

  test('standard flow pins the outline checkpoint; composer params reach the prompt', async () => {
    const root = temp('daedalus-slidev2-std-');
    const capture = { tools: [] as string[], systems: [] as string[] };
    const provider = scriptedProvider(['done'], capture);
    const { runner } = makeRunner(root, provider);

    await runner.run({
      goal: 'buatkan deck tentang keamanan anak\ndone: deck selesai',
      taskId: 'slidev2-std',
      domain: 'slide',
      slide: { generation: 'standard', slideCount: 10, language: 'Bahasa Indonesia' },
    });

    const system = capture.systems[0] ?? '';
    expect(system).toContain('STANDARD flow');
    expect(system).toContain('CHECKPOINT');
    expect(system).toContain('Target exactly 10 slides');
    expect(system).toContain('Bahasa Indonesia');
    expect(system).toContain('midnight-scholar');
  });

  test('empty provider responses retry inside the turn instead of burning the error budget', async () => {
    const root = temp('daedalus-slidev2-retry-');
    let calls = 0;
    const inner = scriptedProvider([
      { tool: 'create_deck', args: { title: 'Ketahanan' } },
      { tool: 'add_slide', args: { layout: 'bullets', content: { title: 'Poin', points: ['satu'] } } },
      { tool: 'validate_deck', args: {} },
      { tool: 'export_deck', args: {} },
    ]);
    const flaky: LLMProvider = {
      name: 'flaky-empty',
      async chat(messages: Message[], tools?: unknown, options?: unknown) {
        calls++;
        if (calls <= 2) throw new LLMFormatError('provider response has no choice message');
        return inner.chat(messages, tools as never, options as never);
      },
      async *stream() {
        yield { type: 'delta', content: '' };
      },
    };
    const { runner, store } = makeRunner(root, flaky);

    const { state } = await runner.run({
      goal: 'buatkan deck tentang ketahanan\ndeck selesai\npptx ter-export',
      taskId: 'slidev2-retry',
      domain: 'slide',
      slide: { generation: 'smart' },
    });

    expect(state.status).toBe('done');
    const retries = store.replay('slidev2-retry').filter((event) => event.type === 'LOOP_WARNING' && (event.payload as { kind?: string })?.kind === 'empty_response_retry');
    expect(retries.length).toBe(2);
  });

  test('deck density: an over-full bullets slide fails validation with the split remedy', () => {
    const deck = newDeck('Padat');
    deck.slides.push({ id: 's1', layout: 'bullets', content: { title: 'Poin', points: ['1', '2', '3', '4', '5', '6', '7'] } });
    const issues = validateDeck(deck);
    expect(issues.some((issue) => issue.code === 'too-dense' && issue.severity === 'error')).toBe(true);
    deck.slides[0]!.content = { title: 'Poin', points: ['1', '2', '3', '4', '5', '6'] };
    expect(validateDeck(deck).some((issue) => issue.code === 'too-dense')).toBe(false);
  });

  test('templates apply deterministically via create_deck and set_deck_theme', async () => {
    const root = temp('daedalus-slidev2-tpl-');
    const created = await createDeckTool.execute({ title: 'Templated', templateId: 'midnight-scholar' }, { workspaceRoot: root });
    expect(created.status).toBe('ok');
    const deck = JSON.parse(readFileSync(join(root, 'deck', 'deck.json'), 'utf8')) as { theme: { templateId?: string; accent?: string; headingFont?: string } };
    expect(deck.theme.templateId).toBe('midnight-scholar');
    expect(deck.theme.accent).toBe('#c59a46');
    expect(deck.theme.headingFont).toBe('Georgia');

    const bad = await createDeckTool.execute({ title: 'Lagi' }, { workspaceRoot: root });
    expect(bad.status).toBe('error');
    const themed = await setDeckThemeTool.execute({ templateId: 'ocean' }, { workspaceRoot: root });
    expect(themed.status).toBe('ok');
    const deck2 = JSON.parse(readFileSync(join(root, 'deck', 'deck.json'), 'utf8')) as { theme: { templateId?: string } };
    expect(deck2.theme.templateId).toBe('ocean');

    const unknown = await setDeckThemeTool.execute({ templateId: 'nope' }, { workspaceRoot: root });
    expect(unknown.status).toBe('error');
    expect(readdirSync(join(root, 'deck')).length).toBeGreaterThan(0);
  });
});
