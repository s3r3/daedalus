import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import { TaskRunner, TaskStore, setSkillDisabled, type Event, type LLMProvider, type Message } from '../src/index.ts';
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

const SKILL_MARKER = 'DEPLOY BODY MARKER: run the release checklist';

type ScriptAction = 'done' | 'read' | 'write' | 'list';

/** Scripted provider: each chat consumes one action; 'done' finishes. */
function fakeProvider(script: ScriptAction[] = []): { provider: LLMProvider; seen: Message[][] } {
  const seen: Message[][] = [];
  let step = 0;
  const provider: LLMProvider = {
    name: 'fake',
    async chat(messages: Message[]) {
      seen.push(messages);
      const action = script[step++] ?? 'done';
      if (action === 'list') {
        return {
          message: {
            role: 'assistant' as const,
            content: '',
            tool_calls: [{ id: 'call-list-1', type: 'function' as const, function: { name: 'list_dir', arguments: JSON.stringify({ path: '.' }) } }],
          },
        };
      }
      if (action === 'read') {
        return {
          message: {
            role: 'assistant' as const,
            content: '',
            tool_calls: [{ id: 'call-read-1', type: 'function' as const, function: { name: 'read_skill', arguments: JSON.stringify({ name: 'deploy' }) } }],
          },
        };
      }
      if (action === 'write') {
        return {
          message: {
            role: 'assistant' as const,
            content: '',
            tool_calls: [{ id: 'call-write-1', type: 'function' as const, function: { name: 'write_file', arguments: JSON.stringify({ path: 'deployed.txt', content: 'shipped\n' }) } }],
          },
        };
      }
      return { message: { role: 'assistant' as const, content: 'done: deployed' } };
    },
    async *stream() {
      yield { type: 'delta', content: '' };
    },
  };
  return { provider, seen };
}

const passingValidator = {
  async validate() {
    return { checks: [{ name: 'test', cmd: 'true', status: 'pass' as const, exit_code: 0, summary: 'passed', diagnostics: [] }] };
  },
};

function makeRunner(workspace: string, provider: LLMProvider): { runner: TaskRunner; store: TaskStore } {
  const store = new TaskStore(temp('daedalus-invoke-store-'));
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

function skillLoadedEvents(store: TaskStore, taskId: string): Array<{ name?: string; origin?: string; via?: string }> {
  return store
    .replay(taskId)
    .filter((event: Event) => event.type === 'SKILL_LOADED')
    .map((event: Event) => event.payload as { name?: string; origin?: string; via?: string });
}

describe('explicit skill invocation (skills: [...])', () => {
  test('a user-invoked skill body enters the prompt marked invoked, and SKILL_LOADED via user is recorded', async () => {
    const workspace = temp('daedalus-invoke-ws-');
    writeSkill(workspace, 'deploy', 'Deploy the thing', SKILL_MARKER);
    const { provider, seen } = fakeProvider(['list', 'write', 'done']);
    const { runner, store } = makeRunner(workspace, provider);

    const { state } = await runner.run({ goal: 'ship it\ndone: deployed.txt exists', taskId: 'invoke-1', skills: ['deploy'] });

    expect(state.status).toBe('done');
    const system = seen[0]?.find((message) => message.role === 'system')?.content ?? '';
    expect(system).toContain('Skills the user explicitly invoked for this task');
    expect(system).toContain(SKILL_MARKER);
    expect(skillLoadedEvents(store, 'invoke-1')).toEqual([{ name: 'deploy', origin: 'workspace', via: 'user', source: join(workspace, '.daedalus', 'skills') }]);
  });

  test('an unknown invoked skill refuses the run visibly instead of running un-skilled', async () => {
    const workspace = temp('daedalus-invoke-ws-');
    const { runner } = makeRunner(workspace, fakeProvider().provider);
    await expect(runner.run({ goal: 'ship it', taskId: 'invoke-2', skills: ['nope'] })).rejects.toThrow(/unknown skill "nope"/);
  });

  test('a disabled invoked skill refuses the run with the per-workspace reason', async () => {
    const workspace = temp('daedalus-invoke-ws-');
    writeSkill(workspace, 'deploy', 'Deploy the thing', SKILL_MARKER);
    await setSkillDisabled(workspace, 'deploy', true);
    const { runner } = makeRunner(workspace, fakeProvider().provider);
    await expect(runner.run({ goal: 'ship it', taskId: 'invoke-3', skills: ['deploy'] })).rejects.toThrow(/disabled for this workspace/);
  });

  test('when the agent loads a skill itself, SKILL_LOADED via agent is recorded exactly once', async () => {
    const workspace = temp('daedalus-invoke-ws-');
    writeSkill(workspace, 'deploy', 'Deploy the thing', SKILL_MARKER);
    const { provider } = fakeProvider(['list', 'read', 'read', 'write', 'done']);
    const { runner, store } = makeRunner(workspace, provider);

    const { state } = await runner.run({ goal: 'deploy please\ndone: deployed.txt exists', taskId: 'invoke-4' });

    expect(state.status).toBe('done');
    // Two read_skill calls (the repeat is suppressed by the loop guard):
    // exactly one activation event.
    expect(skillLoadedEvents(store, 'invoke-4')).toEqual([
      { name: 'deploy', origin: 'workspace', via: 'agent', source: join(workspace, '.daedalus', 'skills') },
    ]);
  });
});
