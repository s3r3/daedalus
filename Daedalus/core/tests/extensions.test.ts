import { afterEach, describe, expect, test } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  DefaultContextManager,
  EventBus,
  LspManager,
  McpManager,
  SkillRegistry,
  TaskStore,
  TaskRunner,
  classifyToolName,
  createReadSkillTool,
  loadLspConfig,
  loadMcpConfig,
  loadSkills,
  parseSkillMarkdown,
  type Event,
  type LLMProvider,
  type Skill,
  type TaskState,
  type ValidationResult,
  type Validator,
} from '../src/index.ts';

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), 'fixtures');
const FAKE_MCP = join(FIXTURES, 'fake-mcp-server.mjs');
const FAKE_LSP = join(FIXTURES, 'fake-lsp-server.mjs');

const dirs: string[] = [];
const closers: Array<() => Promise<void>> = [];

function temp(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

afterEach(async () => {
  while (closers.length) await closers.pop()?.();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function fakeMcpServer(name = 'fake') {
  return { name, command: process.execPath, args: [FAKE_MCP] };
}

describe('MCP client/manager', () => {
  test('connects, lists tools, and calls echo/add through bridged tool definitions', async () => {
    const manager = new McpManager([fakeMcpServer()]);
    closers.push(() => manager.closeAll());

    const statuses = await manager.connectAll();
    expect(statuses).toEqual([{ name: 'fake', connected: true, toolCount: 3 }]);

    const tools = manager.tools();
    expect(tools.map((tool) => tool.name).sort()).toEqual(['mcp__fake__add', 'mcp__fake__echo', 'mcp__fake__fail']);
    const echo = tools.find((tool) => tool.name === 'mcp__fake__echo');
    expect(echo?.mutating).toBe(true);
    expect(echo?.description).toContain('[MCP fake]');

    const echoed = await echo!.execute({ text: 'hello mcp' }, { workspaceRoot: process.cwd() });
    expect(echoed.status).toBe('ok');
    expect(echoed.output).toBe('hello mcp');
    expect(echoed.meta).toMatchObject({ mcp_server: 'fake', mcp_tool: 'echo' });

    const add = tools.find((tool) => tool.name === 'mcp__fake__add');
    const sum = await add!.execute({ a: 19, b: 23 }, { workspaceRoot: process.cwd() });
    expect(sum.status).toBe('ok');
    expect(sum.output).toBe('42');

    const fail = tools.find((tool) => tool.name === 'mcp__fake__fail');
    const failed = await fail!.execute({}, { workspaceRoot: process.cwd() });
    expect(failed.status).toBe('error');
    expect(failed.output).toContain('fake tool failure');
  });

  test('a broken server records an error status and never throws', async () => {
    const manager = new McpManager([
      { name: 'missing', command: 'daedalus-nonexistent-mcp-binary', args: [] },
      fakeMcpServer('good'),
    ]);
    closers.push(() => manager.closeAll());

    const statuses = await manager.connectAll();
    const missing = statuses.find((status) => status.name === 'missing');
    expect(missing?.connected).toBe(false);
    expect(missing?.toolCount).toBe(0);
    expect(missing?.error).toBeTruthy();
    expect(statuses.find((status) => status.name === 'good')?.connected).toBe(true);
    expect(manager.tools().every((tool) => tool.name.startsWith('mcp__good__'))).toBe(true);
  });

  test('loadMcpConfig parses .daedalus/mcp.json and tolerates its absence', async () => {
    const workspace = temp('daedalus-mcp-config-');
    expect(await loadMcpConfig(workspace)).toEqual({ servers: [], problems: [] });

    mkdirSync(join(workspace, '.daedalus'), { recursive: true });
    writeFileSync(join(workspace, '.daedalus', 'mcp.json'), JSON.stringify({
      servers: [
        { name: 'demo', command: 'node', args: ['server.mjs', '--flag'], env: { TOKEN: 'x' } },
        { name: 'broken' },
      ],
    }));
    const loaded = await loadMcpConfig(workspace);
    expect(loaded.servers).toEqual([{ name: 'demo', command: 'node', args: ['server.mjs', '--flag'], env: { TOKEN: 'x' }, timeoutMs: undefined }]);
    expect(loaded.problems).toHaveLength(1);

    writeFileSync(join(workspace, '.daedalus', 'mcp.json'), '{ not json');
    const malformed = await loadMcpConfig(workspace);
    expect(malformed.servers).toEqual([]);
    expect(malformed.problems[0]).toContain('invalid JSON');
  });

  test('mode classification treats MCP tools as mutating and skill/LSP tools as read-only', () => {
    expect(classifyToolName('mcp__fake__echo')).toBe('mutating');
    expect(classifyToolName('read_skill')).toBe('read');
    expect(classifyToolName('lsp_diagnostics')).toBe('read');
  });
});

describe('Skills', () => {
  test('frontmatter parsing falls back to the folder name and first body line', () => {
    const parsed = parseSkillMarkdown('---\nname: greeter\ndescription: Says hello properly\n---\n# Greeter\n\nBody text.', 'ignored');
    expect(parsed).toMatchObject({ name: 'greeter', description: 'Says hello properly' });
    expect(parsed.body).toContain('# Greeter');

    const bare = parseSkillMarkdown('# Plain Skill\n\nDo the thing.', 'plain-skill');
    expect(bare).toMatchObject({ name: 'plain-skill', description: 'Plain Skill' });
  });

  test('loader scans skill dirs and read_skill returns the body', async () => {
    const workspace = temp('daedalus-skills-');
    const skillDir = join(workspace, '.daedalus', 'skills', 'greeter');
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(join(skillDir, 'SKILL.md'), '---\nname: greeter\ndescription: Greets users warmly\n---\nAlways greet with "Halo" first.');

    const registry = await loadSkills([join(workspace, '.daedalus', 'skills'), join(workspace, 'missing-dir')]);
    expect(registry.list()).toEqual([
      { name: 'greeter', description: 'Greets users warmly', source: join(workspace, '.daedalus', 'skills'), origin: 'workspace' },
    ]);

    const tool = createReadSkillTool(registry);
    expect(tool.mutating).toBe(false);
    const loaded = await tool.execute({ name: 'greeter' }, { workspaceRoot: workspace });
    expect(loaded.status).toBe('ok');
    expect(loaded.output).toContain('Always greet with "Halo" first.');

    const unknown = await tool.execute({ name: 'nope' }, { workspaceRoot: workspace });
    expect(unknown.status).toBe('error');
    expect(unknown.output).toContain('greeter');
  });

  test('the agent context advertises available skills', async () => {
    const skill: Skill = { name: 'greeter', description: 'Greets users warmly', source: '/tmp/skills', origin: 'workspace', body: 'body', path: '/tmp/skills/greeter/SKILL.md' };
    const context = new DefaultContextManager({ skills: new SkillRegistry([skill]).list() });
    const state = {
      id: 'ctx-task', goal: 'Say hi', repo_path: '/tmp', constraints: [], done_criteria: [], created_at: new Date().toISOString(),
      plan: { id: 'p', task_id: 'ctx-task', steps: [], version: 1, status: 'active' }, steps: [], status: 'active',
    } as TaskState;
    const messages = await context.buildMessages(state, []);
    const system = messages[0];
    const text = typeof system?.content === 'string' ? system.content : JSON.stringify(system?.content);
    expect(text).toContain('Available skills');
    expect(text).toContain('greeter: Greets users warmly');
    expect(text).toContain('read_skill');
  });

  test('the agent context ships a filtered workspace overview plus exploration discipline', async () => {
    const workspace = temp('daedalus-ctx-overview-');
    mkdirSync(join(workspace, 'src'), { recursive: true });
    writeFileSync(join(workspace, 'src', 'index.ts'), 'export {};\n');
    writeFileSync(join(workspace, 'package.json'), '{"name":"demo"}\n');
    mkdirSync(join(workspace, '.daedalus', 'tasks', 't1'), { recursive: true });
    writeFileSync(join(workspace, '.daedalus', 'tasks', 't1', 'events.jsonl'), '{}\n');
    mkdirSync(join(workspace, 'node_modules', 'pkg'), { recursive: true });
    writeFileSync(join(workspace, 'node_modules', 'pkg', 'index.js'), '');

    const context = new DefaultContextManager({ workspaceRoot: workspace });
    const state = {
      id: 'ctx-overview', goal: 'Do work', repo_path: workspace, constraints: [], done_criteria: [], created_at: new Date().toISOString(),
      plan: { id: 'p', task_id: 'ctx-overview', steps: [], version: 1, status: 'active' }, steps: [], status: 'active',
    } as TaskState;
    const messages = await context.buildMessages(state, []);
    const text = typeof messages[0]?.content === 'string' ? messages[0].content : JSON.stringify(messages[0]?.content);
    expect(text).toContain('Workspace overview');
    expect(text).toContain('src/');
    expect(text).toContain('index.ts');
    expect(text).not.toContain('events.jsonl');
    expect(text).not.toContain('node_modules/');
    expect(text).toContain('do not call list_dir on the workspace root again');
    expect(text).toContain('Do not repeat list_dir/read on the same path');
  });
});

describe('LSP client/manager', () => {
  test('lsp_diagnostics returns the fake server diagnostic', async () => {
    const workspace = temp('daedalus-lsp-');
    writeFileSync(join(workspace, 'main.ts'), 'const unused = 1;\n');
    const manager = new LspManager([{ name: 'fake-lsp', command: process.execPath, args: [FAKE_LSP], extensions: ['.ts'] }]);
    closers.push(() => manager.closeAll());

    const tool = manager.createDiagnosticsTool();
    expect(tool.mutating).toBe(false);
    const result = await tool.execute({ path: 'main.ts' }, { workspaceRoot: workspace });
    expect(result.status).toBe('ok');
    expect(result.output).toContain('main.ts:1:5 warning: fake diagnostic: unused variable (fake-lsp)');
    expect(manager.status()).toEqual([{ name: 'fake-lsp', extensions: ['.ts'], running: true }]);

    const uncovered = await tool.execute({ path: 'notes.md' }, { workspaceRoot: workspace });
    expect(uncovered.status).toBe('ok');
    expect(uncovered.output).toContain('No language server configured');
  });

  test('a dead language server surfaces an honest error and loadLspConfig parses config', async () => {
    const workspace = temp('daedalus-lsp-config-');
    mkdirSync(join(workspace, '.daedalus'), { recursive: true });
    writeFileSync(join(workspace, 'main.ts'), 'export {};\n');
    writeFileSync(join(workspace, '.daedalus', 'lsp.json'), JSON.stringify({
      servers: [{ name: 'dead', command: 'daedalus-nonexistent-lsp-binary', extensions: ['ts'] }],
    }));

    const loaded = await loadLspConfig(workspace);
    expect(loaded.problems).toEqual([]);
    expect(loaded.servers[0]).toMatchObject({ name: 'dead', extensions: ['.ts'] });

    const manager = new LspManager(loaded.servers);
    closers.push(() => manager.closeAll());
    const result = await manager.createDiagnosticsTool().execute({ path: 'main.ts' }, { workspaceRoot: workspace });
    expect(result.status).toBe('error');
    expect(result.output).toContain('could not report diagnostics');
    expect(manager.status()[0]?.error).toBeTruthy();
  });
});

describe('Runtime integration with extensions', () => {
  const passValidator: Validator = {
    async validate(): Promise<ValidationResult> {
      return { checks: [{ name: 'fixture', cmd: 'true', status: 'pass', exit_code: 0, summary: 'passed', diagnostics: [] }] };
    },
  };

  function scriptedProvider(script: Array<{ tool: string; args: unknown }>): LLMProvider {
    let index = 0;
    return {
      name: 'extensions-scripted',
      async chat() {
        const step = script[index++];
        if (!step) return { message: { role: 'assistant', content: 'done: work complete' } };
        return {
          message: {
            role: 'assistant',
            content: '',
            tool_calls: [{ id: `call-${index}`, type: 'function' as const, function: { name: step.tool, arguments: JSON.stringify(step.args) } }],
          },
        };
      },
      async *stream() { yield { type: 'delta', content: '' }; },
    };
  }

  test('a run can call an MCP tool and read_skill, and reports extension status', async () => {
    const workspace = temp('daedalus-ext-run-ws-');
    const home = temp('daedalus-ext-run-home-');
    const skillDir = join(workspace, '.daedalus', 'skills', 'greeter');
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(join(skillDir, 'SKILL.md'), '---\nname: greeter\ndescription: Greets users warmly\n---\nAlways greet with "Halo" first.');
    writeFileSync(join(workspace, 'main.ts'), 'const unused = 1;\n');

    const events: Event[] = [];
    const runner = new TaskRunner({
      workspaceRoot: workspace,
      store: new TaskStore(home),
      bus: new EventBus(),
      provider: scriptedProvider([
        { tool: 'mcp__fake__echo', args: { text: 'halo dari mcp' } },
        { tool: 'read_skill', args: { name: 'greeter' } },
        { tool: 'lsp_diagnostics', args: { path: 'main.ts' } },
      ]),
      validator: passValidator,
      approvalPolicy: 'auto',
      maxIterations: 10,
      mcpServers: [fakeMcpServer()],
      lspServers: [{ name: 'fake-lsp', command: process.execPath, args: [FAKE_LSP], extensions: ['.ts'] }],
    });

    const result = await runner.run({ goal: 'Use the extensions\ndone: mcp echo called\ndone: greeter skill read\ndone: inspect diagnostics', onEvent: (event) => events.push(event) });
    expect(result.outcome).toBe('success');

    const finished = events.filter((event) => event.type === 'TOOL_CALL_FINISHED');
    const outputs = finished.map((event) => (event.payload as { result?: { output?: string } }).result?.output ?? '');
    expect(outputs.some((output) => output.includes('halo dari mcp'))).toBe(true);
    expect(outputs.some((output) => output.includes('Always greet with "Halo" first.'))).toBe(true);
    expect(outputs.some((output) => output.includes('fake diagnostic: unused variable'))).toBe(true);

    expect(runner.extensionStatus.mcp).toEqual([{ name: 'fake', connected: false, toolCount: 3 }]);
    expect(runner.extensionStatus.skills.map((skill) => skill.name)).toEqual(['greeter']);
    expect(runner.extensionStatus.lsp[0]).toMatchObject({ name: 'fake-lsp', running: false });
  });

  test('workspace .daedalus/mcp.json auto-loads when no servers are injected', async () => {
    const workspace = temp('daedalus-ext-autoload-ws-');
    const home = temp('daedalus-ext-autoload-home-');
    mkdirSync(join(workspace, '.daedalus'), { recursive: true });
    writeFileSync(join(workspace, '.daedalus', 'mcp.json'), JSON.stringify({ servers: [fakeMcpServer('filecfg')] }));

    const runner = new TaskRunner({
      workspaceRoot: workspace,
      store: new TaskStore(home),
      bus: new EventBus(),
      provider: scriptedProvider([{ tool: 'mcp__filecfg__add', args: { a: 1, b: 2 } }]),
      validator: passValidator,
      approvalPolicy: 'auto',
      maxIterations: 10,
    });

    const outputs: string[] = [];
    const result = await runner.run({
      goal: 'Add numbers\ndone: added',
      onEvent: (event) => {
        if (event.type === 'TOOL_CALL_FINISHED') outputs.push((event.payload as { result?: { output?: string } }).result?.output ?? '');
      },
    });
    expect(result.outcome).toBe('success');
    expect(outputs).toContain('3');
    expect(runner.extensionStatus.mcp[0]).toMatchObject({ name: 'filecfg', toolCount: 3 });
  });
});
