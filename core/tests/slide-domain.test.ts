import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import { TaskRunner, TaskStore, type Event, type LLMProvider, type Message } from '../src/index.ts';
import { EventBus } from '../src/events.ts';

const cleanups: Array<() => void> = [];
afterEach(() => {
  while (cleanups.length) cleanups.pop()?.();
});

function temp(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function writeSkill(workspace: string, name: string, description: string, body: string): void {
  const dir = join(workspace, '.daedalus', 'skills', name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'SKILL.md'), `---\nname: ${name}\ndescription: ${description}\n---\n${body}`);
}

const PPT_MARKER = 'PPT MAKER BODY MARKER: call the external slides API';
const DEPLOY_MARKER = 'DEPLOY BODY MARKER: run the release checklist';

type ScriptAction = 'done' | 'write' | { read: string };

/** Scripted provider: each chat consumes one action; 'done' finishes. Unlike the invocation-suite fake, read_skill takes any skill name. */
function fakeProvider(script: ScriptAction[] = []): { provider: LLMProvider; seen: Message[][]; seenTools: unknown[] } {
  const seen: Message[][] = [];
  const seenTools: unknown[] = [];
  let step = 0;
  const provider: LLMProvider = {
    name: 'fake',
    async chat(messages: Message[], tools?: unknown) {
      seen.push(messages);
      seenTools.push(tools);
      const action = script[step++] ?? 'done';
      if (typeof action === 'object') {
        return {
          message: {
            role: 'assistant' as const,
            content: '',
            tool_calls: [{ id: `call-read-${step}`, type: 'function' as const, function: { name: 'read_skill', arguments: JSON.stringify({ name: action.read }) } }],
          },
        };
      }
      if (action === 'write') {
        return {
          message: {
            role: 'assistant' as const,
            content: '',
            tool_calls: [{ id: `call-write-${step}`, type: 'function' as const, function: { name: 'write_file', arguments: JSON.stringify({ path: 'deployed.txt', content: 'shipped\n' }) } }],
          },
        };
      }
      return { message: { role: 'assistant' as const, content: 'done: finished' } };
    },
    async *stream() {
      yield { type: 'delta', content: '' };
    },
  };
  return { provider, seen, seenTools };
}

const passingValidator = {
  async validate() {
    return { checks: [{ name: 'test', cmd: 'true', status: 'pass' as const, exit_code: 0, summary: 'passed', diagnostics: [] }] };
  },
};

function makeRunner(workspace: string, provider: LLMProvider): { runner: TaskRunner; store: TaskStore } {
  const store = new TaskStore(temp('daedalus-slide-store-'));
  const runner = new TaskRunner({
    workspaceRoot: workspace,
    store,
    bus: new EventBus(),
    provider,
    validator: passingValidator,
    approvalPolicy: 'auto',
  });
  return { runner, store };
}

function systemOf(messages: Message[] | undefined): string {
  const content = messages?.find((message) => message.role === 'system')?.content;
  return typeof content === 'string' ? content : '';
}

function requestText(messages: Message[] | undefined): string {
  return (messages ?? []).map((message) => (typeof message.content === 'string' ? message.content : '')).join('\n');
}

function skillLoadedEvents(store: TaskStore, taskId: string): unknown[] {
  return store.replay(taskId).filter((event: Event) => event.type === 'SKILL_LOADED');
}

describe('task domain: slide', () => {
  test('slide domain runs on the SlideEngine: stage prompts carry no skill index at all', async () => {
    const workspace = temp('daedalus-slide-ws-');
    writeSkill(workspace, 'ppt-maker', 'Generate slides and presentations via external API', PPT_MARKER);
    writeSkill(workspace, 'deploy', 'Deploy the thing', DEPLOY_MARKER);
    const { provider, seen, seenTools } = fakeProvider(['done']);
    const { runner } = makeRunner(workspace, provider);

    const { state } = await runner.run({ goal: 'siapkan materi keamanan anak\ndone: deck selesai', taskId: 'slide-a', domain: 'slide' });

    // The engine's stage prompts are slide-pipeline prompts: no skills
    // section exists to hide, and the provider is offered no tools. The
    // scripted provider never answers with deck JSON, so the run fails
    // honestly instead of executing anything.
    expect(state.status).toBe('failed');
    const system = systemOf(seen[0]);
    expect(system).toContain('OUTLINE stage');
    expect(system).not.toContain('ppt-maker');
    expect(system).not.toContain('deploy');
    for (const tools of seenTools) expect(tools).toBeUndefined();
  });

  test('without a domain there is no slide block and presentation skills stay listed', async () => {
    const workspace = temp('daedalus-slide-ws-');
    writeSkill(workspace, 'ppt-maker', 'Generate slides and presentations via external API', PPT_MARKER);
    writeSkill(workspace, 'deploy', 'Deploy the thing', DEPLOY_MARKER);
    const { provider, seen } = fakeProvider(['done']);
    const { runner } = makeRunner(workspace, provider);

    await runner.run({ goal: 'siapkan materi keamanan anak\ndone: deck selesai', taskId: 'slide-b' });

    const system = systemOf(seen[0]);
    expect(system).not.toContain('Slide domain');
    expect(system).toContain('ppt-maker');
  });

  test('slide domain executes no tool calls at all: read_skill/write_file asks are ignored, nothing runs', async () => {
    const workspace = temp('daedalus-slide-ws-');
    writeSkill(workspace, 'ppt-maker', 'Generate slides and presentations via external API', PPT_MARKER);
    const { provider } = fakeProvider([{ read: 'ppt-maker' }, 'write', 'done']);
    const { runner, store } = makeRunner(workspace, provider);

    await runner.run({ goal: 'siapkan materi keamanan anak\ndone: deck selesai', taskId: 'slide-c', domain: 'slide' });

    // The model asked for read_skill and write_file; a slide run has no
    // tool surface, so neither executed: no skill body was served and no
    // file appeared.
    expect(skillLoadedEvents(store, 'slide-c')).toEqual([]);
    expect(store.replay('slide-c').filter((event) => event.type === 'TOOL_CALL_STARTED')).toEqual([]);
    expect(existsSync(join(workspace, 'deployed.txt'))).toBe(false);
  });

  test('a long skill body is served once in full, then history carries only a stub', async () => {
    const workspace = temp('daedalus-slide-ws-');
    writeSkill(workspace, 'deploy', 'Deploy the thing', `${DEPLOY_MARKER}\n${'x'.repeat(3000)}`);
    const { provider, seen } = fakeProvider([{ read: 'deploy' }, { read: 'deploy' }, 'write', 'done']);
    const { runner } = makeRunner(workspace, provider);

    const { state } = await runner.run({ goal: 'deploy please\ndone: deployed.txt exists', taskId: 'slide-d' });

    expect(state.status).toBe('done');
    expect(requestText(seen[1])).toContain(DEPLOY_MARKER);
    const afterRepeat = requestText(seen[2]);
    expect(afterRepeat).not.toContain('x'.repeat(500));
    expect(afterRepeat).toContain('already loaded');
  });
});
