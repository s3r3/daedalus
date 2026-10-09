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
  /** Structured stage provider for the engine: outline/fill JSON by prompt marker; records every call's offered tools. */
  function stageProvider(capture: { toolsPerCall: unknown[]; systems: string[]; users: string[] }): LLMProvider {
    return {
      name: 'slide-v2-stage',
      async chat(messages: Message[], tools?: unknown) {
        capture.toolsPerCall.push(tools);
        const system = messages.find((message) => message.role === 'system');
        const systemText = typeof system?.content === 'string' ? system.content : '';
        capture.systems.push(systemText);
        const user = messages[1];
        const userText = typeof user?.content === 'string' ? user.content : '';
        capture.users.push(userText);
        if (systemText.includes('OUTLINE stage')) {
          const count = Number(/slide_count: (\d+)/.exec(userText)?.[1] ?? 2);
          return {
            message: {
              role: 'assistant' as const,
              content: JSON.stringify(Array.from({ length: count }, (_, index) => ({
                title: `Slide ${index + 1}`,
                layoutId: index === 0 ? 'title' : index === count - 1 && count > 2 ? 'closing' : 'bullets',
                keyMessage: `poin ${index + 1}`,
              }))),
            },
          };
        }
        if (systemText.includes('FILL stage')) {
          if (userText.includes('layout: closing')) return { message: { role: 'assistant' as const, content: JSON.stringify({ title: 'Terima Kasih', cta: 'Mulai' }) } };
          if (userText.includes('layout: title')) return { message: { role: 'assistant' as const, content: JSON.stringify({ title: 'Judul', subtitle: 'Sub' }) } };
          return { message: { role: 'assistant' as const, content: JSON.stringify({ title: 'Isi', points: ['satu', 'dua'] }) } };
        }
        return { message: { role: 'assistant' as const, content: '{}' } };
      },
      async *stream() {
        yield { type: 'delta', content: '' };
      },
    };
  }

  test('slide tasks run on the engine: the provider is offered no tools and tool calls never execute', async () => {
    const root = temp('daedalus-slidev2-lock-');
    const capture = { toolsPerCall: [] as unknown[], systems: [] as string[], users: [] as string[] };
    const base = stageProvider(capture);
    // Even if the model asks for write_file, the engine has no tool
    // surface: the call is ignored, the stage retries on content alone.
    let first = true;
    const provider: LLMProvider = {
      ...base,
      async chat(messages: Message[], tools?: unknown, options?: unknown) {
        if (first) {
          first = false;
          capture.toolsPerCall.push(tools);
          capture.systems.push('');
          capture.users.push('');
          return {
            message: {
              role: 'assistant' as const,
              content: '',
              tool_calls: [{ id: 'call-x', type: 'function' as const, function: { name: 'write_file', arguments: JSON.stringify({ path: 'notes.md', content: '# draft\n' }) } }],
            },
          };
        }
        return base.chat(messages, tools as never, options as never);
      },
    };
    const { runner, store } = makeRunner(root, provider);

    const { state } = await runner.run({
      goal: 'buatkan deck tentang keamanan anak\ndeck dibuat dan terisi\ndeck ter-export ke pptx',
      taskId: 'slidev2-lock',
      domain: 'slide',
      slide: { generation: 'smart', slideCount: 3 },
    });

    expect(state.status).toBe('done');
    expect(existsSync(join(root, 'notes.md'))).toBe(false);
    expect(capture.toolsPerCall.length).toBeGreaterThan(0);
    for (const tools of capture.toolsPerCall) expect(tools).toBeUndefined();
    expect(store.replay('slidev2-lock').filter((event) => event.type === 'TOOL_CALL_STARTED')).toEqual([]);
    expect(readdirSync(join(root, 'deck')).some((name) => name.endsWith('.pptx'))).toBe(true);
  });

  test('standard flow stops at the checkpoint; composer params reach the outline stage', async () => {
    const root = temp('daedalus-slidev2-std-');
    const capture = { toolsPerCall: [] as unknown[], systems: [] as string[], users: [] as string[] };
    const provider = stageProvider(capture);
    const { runner, store } = makeRunner(root, provider);

    const pending = runner.run({
      goal: 'buatkan deck tentang keamanan anak\ndone: deck selesai',
      taskId: 'slidev2-std',
      domain: 'slide',
      slide: { generation: 'standard', slideCount: 4, language: 'Bahasa Indonesia' },
    });

    let questionId: string | undefined;
    let optionLabels: string[] = [];
    for (let attempt = 0; attempt < 200 && !questionId; attempt++) {
      const requested = store.replay('slidev2-std').find((event) => event.type === 'QUESTION_REQUESTED');
      const question = (requested?.payload as { question?: { id: string; options: Array<{ label: string }> } } | undefined)?.question;
      if (question) {
        questionId = question.id;
        optionLabels = question.options.map((option) => option.label);
      } else {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
    }

    expect(questionId).toBeTruthy();
    expect(optionLabels.length).toBeGreaterThanOrEqual(4);
    // Composer parameters reached the outline stage prompt.
    const outlineUser = capture.users.find((userText) => userText.includes('slide_count:'));
    expect(outlineUser).toContain('slide_count: 4');
    expect(outlineUser).toContain('Bahasa Indonesia');
    expect(capture.systems[0]).toContain('OUTLINE stage');

    expect(runner.questions.answer(questionId!, 'midnight-scholar')).toBe(true);
    const { state } = await pending;
    expect(state.status).toBe('done');
    const deck = JSON.parse(readFileSync(join(root, 'deck', 'deck.json'), 'utf8')) as { theme: { templateId?: string }; slides: Array<{ status: string }> };
    expect(deck.theme.templateId).toBe('midnight-scholar');
    expect(deck.slides).toHaveLength(4);
    expect(deck.slides.every((slide) => slide.status === 'filled')).toBe(true);
  });

  test('empty provider responses retry inside the engine stage instead of failing the task', async () => {
    const root = temp('daedalus-slidev2-retry-');
    const capture = { toolsPerCall: [] as unknown[], systems: [] as string[], users: [] as string[] };
    const inner = stageProvider(capture);
    let calls = 0;
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
      slide: { generation: 'smart', slideCount: 2 },
    });

    expect(state.status).toBe('done');
    const failures = store.replay('slidev2-retry').filter((event) => event.type === 'MODEL_REQUEST_FAILED');
    expect(failures.length).toBe(2);
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
