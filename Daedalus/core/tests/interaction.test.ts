import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import {
  AgentLoop,
  DefaultContextManager,
  EventBus,
  LLMError,
  LLMFormatError,
  ModeController,
  OpenAICompatProvider,
  OrchestratorRunner,
  ProviderRegistry,
  ProviderRegistryStore,
  SlashCommandRegistry,
  TaskRunner,
  TaskStore,
  createDirTool,
  createDefaultRegistry,
  cycleAgentMode,
  isToolVisible,
  maskApiKey,
  parseSlashCommand,
  slashCommandSuggestions,
  toolModePolicy,
  writeFileTool,
  type LLMProvider,
  type Message,
  type PermissionKey,
  type TaskState,
} from '../src/index.ts';

const cleanups: Array<() => void> = [];
afterEach(() => {
  while (cleanups.length) cleanups.pop()?.();
});

function temp(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function scriptedProvider(script: Array<{ tool: string; args: unknown }>, onCall?: (index: number, tools: string[]) => void): LLMProvider {
  let index = 0;
  return {
    name: 'scripted',
    async chat(_messages, tools) {
      const current = index++;
      onCall?.(current, (tools ?? []).map((tool) => tool.function.name));
      const step = script[current];
      if (!step) return { message: { role: 'assistant', content: 'done: work complete' } };
      return {
        message: {
          role: 'assistant',
          content: '',
          tool_calls: [{ id: `call-${current + 1}`, type: 'function' as const, function: { name: step.tool, arguments: JSON.stringify(step.args) } }],
        },
      };
    },
    async *stream() {
      yield { type: 'delta', content: '' };
    },
  };
}

const passingValidator = {
  async validate() {
    return { checks: [{ name: 'test', cmd: 'true', status: 'pass' as const, exit_code: 0, summary: 'passed', diagnostics: [] }] };
  },
};

describe('agent modes', () => {
  test('cycles in Ask → Manual → Auto → Plan → Orchestrator order', () => {
    expect(cycleAgentMode('ask')).toBe('manual');
    expect(cycleAgentMode('manual')).toBe('auto');
    expect(cycleAgentMode('auto')).toBe('plan');
    expect(cycleAgentMode('plan')).toBe('orchestrator');
    expect(cycleAgentMode('orchestrator')).toBe('ask');

    const controller = new ModeController('ask');
    expect(controller.cycle().to).toBe('manual');
    expect(controller.set('orchestrator').replanRequired).toBe(true);
    expect(controller.set('auto').replanRequired).toBe(true);
    expect(controller.set('manual').replanRequired).toBe(false);
  });

  test('Ask exposes only read tools; Plan adds the path-gated plan-write tools; unknown tools are never visible', () => {
    for (const mode of ['ask', 'plan'] as const) {
      expect(isToolVisible(mode, 'read_file')).toBe(true);
      expect(isToolVisible(mode, 'run_command')).toBe(false);
    }
    expect(isToolVisible('ask', 'write_file')).toBe(false);
    expect(isToolVisible('ask', 'create_dir')).toBe(false);
    // Plan sees the plan-write tools so the .daedalus/plans carve-out is
    // callable; toolCallPolicy still denies every path outside it.
    expect(isToolVisible('plan', 'write_file')).toBe(true);
    expect(isToolVisible('plan', 'create_dir')).toBe(true);
    expect(isToolVisible('plan', 'mcp__demo__write')).toBe(false);
    expect(isToolVisible('auto', 'not_a_real_tool')).toBe(false);
    expect(toolModePolicy('manual', 'write_file')).toEqual({ visible: true, approval: 'ask' });
    expect(toolModePolicy('manual', 'run_command')).toEqual({ visible: true, approval: 'ask' });
    expect(toolModePolicy('auto', 'write_file', true)).toEqual({ visible: true, approval: 'auto' });
    // Auto: edits are free; only execution is gated by the auto-approve toggle.
    expect(toolModePolicy('auto', 'write_file', false)).toEqual({ visible: true, approval: 'auto' });
    expect(toolModePolicy('auto', 'run_command', false)).toEqual({ visible: true, approval: 'ask' });
    expect(toolModePolicy('auto', 'run_command', true)).toEqual({ visible: true, approval: 'auto' });
    expect(toolModePolicy('orchestrator', 'write_file', false)).toEqual({ visible: true, approval: 'auto' });
    expect(toolModePolicy('orchestrator', 'run_command', false)).toEqual({ visible: true, approval: 'ask' });
    expect(toolModePolicy('ask', 'write_file')).toEqual({ visible: false, approval: 'deny' });
    expect(toolModePolicy('plan', 'run_command')).toEqual({ visible: false, approval: 'deny' });
  });

  test('AgentLoop filters offered tools and denies a fabricated write in Ask mode', async () => {
    const root = temp('daedalus-mode-ws-');
    const home = temp('daedalus-mode-home-');
    writeFileSync(join(root, 'a.txt'), 'hello');
    const offered: string[][] = [];
    let executed = 0;
    const provider = scriptedProvider(
      [
        { tool: 'write_file', args: { path: 'blocked.txt', content: 'no' } },
        { tool: 'read_file', args: { path: 'a.txt' } },
      ],
      (_index, tools) => offered.push(tools),
    );
    const loop = new AgentLoop({
      provider,
      bus: new EventBus(),
      store: new TaskStore(home),
      tools: createDefaultRegistry().schemas(),
      mode: 'ask',
      stopPolicy: { max_iterations: 5, max_errors: 3 },
      executeTool: async (call) => {
        executed++;
        return createDefaultRegistry().execute(call, { workspaceRoot: root });
      },
    });

    const state = await loop.run('Inspect only\ndone: read a.txt');
    expect(state.status).toBe('done');
    expect(offered[0]).toContain('read_file');
    expect(offered[0]).not.toContain('write_file');
    expect(offered[0]).not.toContain('create_dir');
    expect(offered[0]).not.toContain('run_command');
    expect(executed).toBe(1);
    expect(existsSync(join(root, 'blocked.txt'))).toBe(false);
  });

  test('switching into Orchestrator at a turn boundary emits MODE_CHANGED and replans', async () => {
    const home = temp('daedalus-mode-switch-');
    const store = new TaskStore(home);
    let loop!: AgentLoop;
    let calls = 0;
    const provider: LLMProvider = {
      name: 'switching',
      async chat() {
        calls++;
        if (calls === 1) {
          loop.modeController.set('orchestrator');
          return {
            message: {
              role: 'assistant',
              content: '',
              tool_calls: [{ id: 'c1', type: 'function' as const, function: { name: 'read_file', arguments: '{"path":"a.txt"}' } }],
            },
          };
        }
        return {
          message: {
            role: 'assistant',
            content: '',
            tool_calls: [{ id: `c${calls}`, type: 'function' as const, function: { name: 'read_file', arguments: '{"path":"a.txt"}' } }],
          },
        };
      },
      async *stream() {},
    };
    loop = new AgentLoop({
      provider,
      bus: new EventBus(),
      store,
      tools: createDefaultRegistry().schemas(),
      mode: 'auto',
      stopPolicy: { max_iterations: 6, max_errors: 3 },
      executeTool: async (call) => ({ call_id: call.id, status: 'ok', output: 'ok', truncated: false, meta: {} }),
    });

    const state = await loop.run('Coordinate this\ndone: one\ndone: two');
    const events = store.replay(state.id);
    expect(events.some((event) => event.type === 'MODE_CHANGED')).toBe(true);
    expect(events.some((event) => event.type === 'REPLAN_CREATED')).toBe(true);
    expect(state.mode).toBe('orchestrator');
  });
});

describe('filesystem greenfield tools', () => {
  test('create_dir creates nested directories and write_file creates parents', async () => {
    const root = temp('daedalus-greenfield-');
    const created = await createDirTool.execute({ path: 'src/components' }, { workspaceRoot: root });
    expect(created.status).toBe('ok');
    expect(existsSync(join(root, 'src/components'))).toBe(true);

    const written = await writeFileTool.execute({ path: 'src/new/deep/file.txt', content: 'hello' }, { workspaceRoot: root });
    expect(written.status).toBe('ok');
    expect(readFileSync(join(root, 'src/new/deep/file.txt'), 'utf8')).toBe('hello');

    const escaped = await createDirTool.execute({ path: '../outside' }, { workspaceRoot: root });
    expect(escaped.status).toBe('error');
  });
});

describe('provider chat error handling', () => {
  test('non-JSON HTTP error pages keep the HTTP status instead of leaking SyntaxError', async () => {
    const provider = new OpenAICompatProvider({
      baseUrl: 'https://example.test/v1',
      apiKey: 'k',
      model: 'm',
      fetch: async () => new Response('<html>temporarily unavailable</html>', { status: 530, headers: { 'content-type': 'text/html' } }),
    });
    await expect(provider.chat([{ role: 'user', content: 'hi' }])).rejects.toMatchObject({
      name: 'LLMError',
      code: 'transient',
      message: 'provider returned HTTP 530',
    });
    await expect(provider.chat([{ role: 'user', content: 'hi' }])).rejects.toBeInstanceOf(LLMError);
  });

  test('invalid JSON on a 200 response is a typed format error', async () => {
    const provider = new OpenAICompatProvider({
      baseUrl: 'https://example.test/v1',
      apiKey: 'k',
      model: 'm',
      fetch: async () => new Response('not json', { status: 200, headers: { 'content-type': 'application/json' } }),
    });
    await expect(provider.chat([{ role: 'user', content: 'hi' }])).rejects.toBeInstanceOf(LLMFormatError);
  });
});

describe('provider registry', () => {
  test('masks API keys and discovers models through a real /models call', async () => {
    const registry = new ProviderRegistry(async (input) => {
      expect(String(input)).toBe('https://example.test/v1/models');
      return new Response(JSON.stringify({ data: [{ id: 'gpt-4o' }, { id: 'text-only' }] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    });
    const publicView = registry.upsert({
      id: 'example',
      name: 'Example',
      baseUrl: 'https://example.test/v1',
      apiKey: 'sk-secret-123456',
      models: [],
      supportsVision: true,
    });

    expect(publicView.hasApiKey).toBe(true);
    expect(publicView.apiKeyMasked).toBe(maskApiKey('sk-secret-123456'));
    expect(JSON.stringify(publicView)).not.toContain('sk-secret-123456');
    await expect(registry.testConnection('example')).resolves.toMatchObject({ ok: true, providerId: 'example' });
    await expect(registry.listModels('example')).resolves.toEqual([
      { providerId: 'example', model: 'gpt-4o', supportsVision: true },
      { providerId: 'example', model: 'text-only', supportsVision: false },
    ]);
  });

  test('persists providers to a private store without exposing keys in public views', async () => {
    const home = temp('daedalus-provider-home-');
    const store = new ProviderRegistryStore(home);
    await store.load();
    store.registry.upsert({ id: 'local', name: 'Local', baseUrl: 'https://example.test/v1', apiKey: 'persisted-secret', models: ['m1'] });
    await store.save();

    const reloaded = new ProviderRegistryStore(home);
    await reloaded.load();
    expect(reloaded.registry.get('local')?.apiKey).toBe('persisted-secret');
    expect(JSON.stringify(reloaded.registry.list())).not.toContain('persisted-secret');
    expect(reloaded.registry.list()[0]?.apiKeyMasked).toBe(maskApiKey('persisted-secret'));
  });
});

describe('slash commands', () => {
  test('parses, suggests, and executes shared commands', async () => {
    const registry = new SlashCommandRegistry();
    expect(parseSlashCommand('/MODE auto')).toEqual({ name: 'mode', args: ['auto'], raw: '/MODE auto' });
    expect(parseSlashCommand('hello')).toBeUndefined();
    expect(slashCommandSuggestions('/mo').map((command) => command.name)).toEqual(['mode', 'models']);
    expect(registry.help()).toContain('/auto-approve');

    let mode: 'ask' | 'manual' | 'auto' | 'plan' | 'orchestrator' = 'auto';
    let autoApprove = false;
    const result = await registry.execute('/mode plan', {
      getMode: () => mode,
      setMode: (next) => {
        mode = next;
        return { text: `Mode set to ${next}` };
      },
      getAutoApprove: () => autoApprove,
      setAutoApprove: (value) => {
        autoApprove = value;
        return { text: `Auto-approve ${value ? 'on' : 'off'}` };
      },
      listModels: () => [{ providerId: 'p1', model: 'm1' }],
      listProviders: () => [],
      getCurrentModel: () => ({ providerId: 'p1', model: 'm1' }),
      setModel: () => ({ text: 'model set' }),
      getSettings: () => ({ mode }),
      getPlan: () => 'plan text',
      getWorkspace: () => 'workspace text',
      listFiles: () => 'files text',
      getDiff: () => 'diff text',
      validate: () => 'validation text',
      upload: () => ({ text: 'uploaded' }),
      image: () => ({ text: 'image attached' }),
      status: () => 'status text',
    });
    expect(result.text).toContain('plan');
    expect(mode).toBe('plan');
    await expect(registry.execute('/wat', {
      getMode: () => mode,
      setMode: () => ({ text: '' }),
      getAutoApprove: () => autoApprove,
      setAutoApprove: () => ({ text: '' }),
      listModels: () => [],
      listProviders: () => [],
      getCurrentModel: () => undefined,
      setModel: () => ({ text: '' }),
      getSettings: () => ({}),
      getPlan: () => '',
      getWorkspace: () => '',
      listFiles: () => '',
      getDiff: () => '',
      validate: () => '',
      upload: () => ({ text: '' }),
      image: () => ({ text: '' }),
      status: () => '',
    })).resolves.toMatchObject({ action: 'unknown' });
  });
});

describe('attachment context', () => {
  test('image bytes are included only when the selected model supports vision', async () => {
    const root = temp('daedalus-vision-ws-');
    const imageBytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    writeFileSync(join(root, 'pic.png'), imageBytes);
    const attachment = {
      id: 'img-1',
      workspacePath: 'pic.png',
      name: 'pic.png',
      kind: 'image' as const,
      mimeType: 'image/png',
      size: imageBytes.length,
      createdAt: new Date().toISOString(),
      path: join(root, 'pic.png'),
    };
    const state = {
      id: 'task-vision',
      goal: 'Inspect the image',
      repo_path: root,
      constraints: [],
      done_criteria: ['image inspected'],
      created_at: new Date().toISOString(),
      plan: { id: 'p1', task_id: 'task-vision', steps: [], version: 1, status: 'active' as const },
      steps: [],
      status: 'active' as const,
      attachments: [attachment],
    } satisfies TaskState;

    const visionMessages = await new DefaultContextManager({ workspaceRoot: root, visionEnabled: true }).buildMessages(state, []);
    expect(JSON.stringify(visionMessages)).toContain('data:image/png;base64,');

    const textMessages = await new DefaultContextManager({ workspaceRoot: root, visionEnabled: false }).buildMessages(state, []);
    expect(JSON.stringify(textMessages)).not.toContain('data:image/png;base64,');
    expect(JSON.stringify(textMessages)).toContain('Image bytes were not sent');
  });

  test('TaskRunner resolves vision support from the provider registry and selected model', async () => {
    const root = temp('daedalus-vision-runner-ws-');
    const home = temp('daedalus-vision-runner-home-');
    const imageBytes = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
    writeFileSync(join(root, 'pic.png'), imageBytes);
    const registry = new ProviderRegistry();
    registry.upsert({ id: 'fake', name: 'Fake', baseUrl: 'https://example.test/v1', apiKey: 'k', models: ['gpt-4o', 'text-only'], supportsVision: true });

    const seen: Message[][] = [];
    let calls = 0;
    const provider: LLMProvider = {
      name: 'capture',
      async chat(messages) {
        seen.push(messages);
        calls++;
        if (calls === 1) {
          return {
            message: {
              role: 'assistant',
              content: '',
              tool_calls: [{ id: 'c1', type: 'function' as const, function: { name: 'read_file', arguments: '{"path":"pic.png"}' } }],
            },
          };
        }
        return { message: { role: 'assistant', content: 'done: complete' } };
      },
      async *stream() {},
    };

    const runner = new TaskRunner({
      workspaceRoot: root,
      store: new TaskStore(home),
      bus: new EventBus(),
      provider,
      providerRegistry: registry,
      validator: passingValidator,
      approvalPolicy: 'auto',
      maxIterations: 5,
    });
    const attachment = {
      id: 'img-1',
      workspacePath: 'pic.png',
      name: 'pic.png',
      kind: 'image' as const,
      mimeType: 'image/png',
      size: imageBytes.length,
      createdAt: new Date().toISOString(),
      path: join(root, 'pic.png'),
    };

    await runner.run({ goal: 'Inspect image\ndone: image inspected', providerId: 'fake', model: 'gpt-4o', attachments: [attachment] });
    expect(JSON.stringify(seen[0])).toContain('data:image/png;base64,');

    seen.length = 0;
    calls = 0;
    await runner.run({ goal: 'Inspect image\ndone: image inspected', providerId: 'fake', model: 'text-only', attachments: [attachment] });
    expect(JSON.stringify(seen[0])).not.toContain('data:image/png;base64,');
    expect(JSON.stringify(seen[0])).toContain('Image bytes were not sent');
  });
});

describe('TaskRunner mode enforcement', () => {
  test('Ask mode cannot write even when the runner approval policy is auto', async () => {
    const root = temp('daedalus-runner-ask-ws-');
    const home = temp('daedalus-runner-ask-home-');
    writeFileSync(join(root, 'a.txt'), 'hello');
    const runner = new TaskRunner({
      workspaceRoot: root,
      store: new TaskStore(home),
      bus: new EventBus(),
      provider: scriptedProvider([
        { tool: 'write_file', args: { path: 'blocked.txt', content: 'no' } },
        { tool: 'read_file', args: { path: 'a.txt' } },
      ]),
      validator: passingValidator,
      approvalPolicy: 'auto',
      maxIterations: 5,
    });
    const result = await runner.run({ goal: 'Inspect only\ndone: read a.txt', mode: 'ask' });
    expect(result.state.status).toBe('done');
    expect(existsSync(join(root, 'blocked.txt'))).toBe(false);
  });

  test('Manual mode asks before a mutation and then executes after grant', async () => {
    const root = temp('daedalus-runner-manual-ws-');
    const home = temp('daedalus-runner-manual-home-');
    const runner = new TaskRunner({
      workspaceRoot: root,
      store: new TaskStore(home),
      bus: new EventBus(),
      provider: scriptedProvider([{ tool: 'write_file', args: { path: 'manual.txt', content: 'approved' } }]),
      validator: passingValidator,
      approvalPolicy: 'ask',
      maxIterations: 5,
    });
    const result = await runner.run({
      goal: 'Write a file\ndone: file written',
      mode: 'manual',
      onEvent: (event) => {
        if (event.type !== 'APPROVAL_REQUESTED') return;
        const key = (event.payload as { key: PermissionKey }).key;
        setTimeout(() => runner.approvals.decide(key, 'grant'), 10);
      },
    });
    expect(result.state.status).toBe('done');
    expect(readFileSync(join(root, 'manual.txt'), 'utf8')).toBe('approved');
    expect(result.events.some((event) => event.type === 'APPROVAL_REQUESTED')).toBe(true);
  });

  test('Orchestrator mode runs recorded child tasks sequentially and aggregates the result', async () => {
    const root = temp('daedalus-runner-orch-ws-');
    const home = temp('daedalus-runner-orch-home-');
    writeFileSync(join(root, 'a.txt'), 'hello');
    const read = { tool: 'read_file', args: { path: 'a.txt' } };
    const writeFirst = { tool: 'write_file', args: { path: 'child-1.txt', content: 'first child change' } };
    const writeSecond = { tool: 'write_file', args: { path: 'child-2.txt', content: 'second child change' } };
    const runner = new TaskRunner({
      workspaceRoot: root,
      store: new TaskStore(home),
      bus: new EventBus(),
      provider: scriptedProvider([read, writeFirst, read, read, writeSecond, read]),
      validator: passingValidator,
      approvalPolicy: 'auto',
      maxIterations: 8,
    });
    const result = await runner.run({
      goal: 'Coordinate the work\ndone: first criterion\ndone: second criterion',
      mode: 'orchestrator',
    });
    expect(result.state.status).toBe('done');
    expect(result.report.metrics.child_tasks).toBe(2);
    expect(result.report.metrics.child_tasks_done).toBe(2);
    expect(result.events.filter((event) => event.type === 'CHILD_TASK_STARTED')).toHaveLength(2);
    expect(result.events.filter((event) => event.type === 'CHILD_TASK_FINISHED')).toHaveLength(2);
  });
});

describe('OrchestratorRunner', () => {
  test('stops launching later children after identical no-progress results', async () => {
    const home = temp('daedalus-orchestrator-home-');
    const store = new TaskStore(home);
    const bus = new EventBus();
    const orchestrator = new OrchestratorRunner({
      bus,
      store,
      executeChild: async () => ({ status: 'done', summary: 'same result', diff: '' }),
    });
    const result = await orchestrator.run('parent-1', [{ goal: 'same task' }, { goal: 'same task' }, { goal: 'same task' }]);
    expect(result.no_progress).toBe(true);
    expect(result.children.map((child) => child.status)).toEqual(['done', 'done', 'cancelled']);
    const events = store.replay('parent-1');
    expect(events.filter((event) => event.type === 'CHILD_TASK_STARTED')).toHaveLength(2);
    expect(events.filter((event) => event.type === 'CHILD_TASK_FINISHED')).toHaveLength(2);
  });

  test('cancels later children when the total iteration budget is exhausted', async () => {
    const orchestrator = new OrchestratorRunner({
      totalBudget: { max_iterations: 2, max_errors: 5 },
      executeChild: async (child) => ({ status: 'done', summary: `finished ${child.goal}`, iterations: 1 }),
    });
    const result = await orchestrator.run('parent-budget', [{ goal: 'one' }, { goal: 'two' }, { goal: 'three' }]);
    expect(result.budget_exceeded).toBe(true);
    expect(result.children.map((child) => child.status)).toEqual(['done', 'done', 'cancelled']);
  });
});
