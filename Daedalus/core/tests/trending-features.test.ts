import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import {
  TaskRunner,
  TaskStore,
  applyTaskWorktree,
  buildReviewMessages,
  hookMatches,
  loadAgents,
  loadHooksConfig,
  loadProjectRules,
  parseAgentMarkdown,
  parseReviewFindings,
  removeTaskWorktree,
  reviewDiff,
  REVIEW_READ_ONLY_TOOLS,
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

const passingValidator: Validator = {
  async validate(): Promise<ValidationResult> {
    return { checks: [{ name: 'fixture', cmd: 'true', status: 'pass', exit_code: 0, summary: 'passed', diagnostics: [] }] };
  },
};

function scriptedProvider(script: Array<{ tool: string; args: unknown }>): LLMProvider {
  let index = 0;
  return {
    name: 'trending-scripted',
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

function writeFileEnsured(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content, 'utf8');
}

describe('AGENTS.md standard (global + workspace rules)', () => {
  test('global AGENTS.md from the daedalus home loads after workspace files', async () => {
    const workspace = temp('daedalus-rules-ws-');
    const home = temp('daedalus-rules-home-');
    writeFileEnsured(join(workspace, '.daedalus/RULES.md'), 'workspace rule first\n');
    writeFileEnsured(join(workspace, 'AGENTS.md'), 'workspace standard file\n');
    writeFileEnsured(join(home, 'AGENTS.md'), 'global user rule\n');

    const rules = await loadProjectRules(workspace, { globalHome: home });
    expect(rules.files).toEqual(['.daedalus/RULES.md', 'AGENTS.md', 'AGENTS.md (global)']);
    expect(rules.text.indexOf('workspace rule first')).toBeLessThan(rules.text.indexOf('workspace standard file'));
    expect(rules.text.indexOf('workspace standard file')).toBeLessThan(rules.text.indexOf('global user rule'));
  });

  test('without a global home the behaviour is workspace-only', async () => {
    const workspace = temp('daedalus-rules-ws2-');
    writeFileEnsured(join(workspace, 'AGENTS.md'), 'only workspace\n');
    const rules = await loadProjectRules(workspace);
    expect(rules.files).toEqual(['AGENTS.md']);
    expect(rules.text).toContain('only workspace');
  });
});

describe('hooks', () => {
  test('hookMatches supports names, alternates, and wildcards', () => {
    expect(hookMatches('write_file', 'write_file')).toBe(true);
    expect(hookMatches('write_file', 'read_file')).toBe(false);
    expect(hookMatches('*', 'anything')).toBe(true);
    expect(hookMatches('write_file|edit_file', 'edit_file')).toBe(true);
    expect(hookMatches('mcp__*', 'mcp__demo__echo')).toBe(true);
    expect(hookMatches('mcp__*', 'read_file')).toBe(false);
  });

  test('loadHooksConfig fails open on missing and invalid config', async () => {
    const workspace = temp('daedalus-hooks-ws-');
    await expect(loadHooksConfig(workspace)).resolves.toEqual({ hooks: { pre_tool: [], post_tool: [] } });
    writeFileEnsured(join(workspace, '.daedalus/hooks.json'), 'not json {');
    const invalid = await loadHooksConfig(workspace);
    expect(invalid.hooks).toEqual({ pre_tool: [], post_tool: [] });
    expect(invalid.warning).toContain('not valid JSON');
    writeFileEnsured(join(workspace, '.daedalus/hooks.json'), JSON.stringify({ pre_tool: [{ match: 'write_file' }, { command: 'echo ok' }] }));
    const partial = await loadHooksConfig(workspace);
    expect(partial.hooks.pre_tool).toEqual([{ match: '*', command: 'echo ok' }]);
    expect(partial.warning).toContain('has no shell');
  });

  test('a pre-tool hook blocks write_file and the reason reaches the model', async () => {
    const workspace = temp('daedalus-hooks-block-');
    const home = temp('daedalus-hooks-block-home-');
    writeFileEnsured(join(workspace, '.daedalus/hooks.json'), JSON.stringify({
      pre_tool: [{ match: 'write_file', command: "echo 'writes are frozen today'; exit 2" }],
    }));
    const runner = new TaskRunner({
      workspaceRoot: workspace,
      store: new TaskStore(home),
      provider: scriptedProvider([{ tool: 'write_file', args: { path: 'frozen.txt', content: 'x' } }]),
      validator: passingValidator,
      approvalPolicy: 'auto',
      maxIterations: 6,
    });
    const result = await runner.run({ goal: 'Write the file\ndone: file exists' });
    expect(existsSync(join(workspace, 'frozen.txt'))).toBe(false);
    const hookEvents = result.events.filter((event) => event.type === 'HOOK_EXECUTED');
    expect(hookEvents.some((event) => (event.payload as { outcome?: string }).outcome === 'blocked')).toBe(true);
    const finished = result.events.find((event) => event.type === 'TOOL_CALL_FINISHED');
    const output = (finished?.payload as { result?: { output?: string } }).result?.output ?? '';
    expect(output).toContain('blocked by project hook');
    expect(output).toContain('writes are frozen today');
  });

  test('a post-tool hook appends its stdout to the tool result', async () => {
    const workspace = temp('daedalus-hooks-post-');
    const home = temp('daedalus-hooks-post-home-');
    writeFileEnsured(join(workspace, '.daedalus/hooks.json'), JSON.stringify({
      post_tool: [{ match: '*', command: 'echo lint clean on $DAEDALUS_HOOK_TOOL' }],
    }));
    const runner = new TaskRunner({
      workspaceRoot: workspace,
      store: new TaskStore(home),
      provider: scriptedProvider([{ tool: 'write_file', args: { path: 'ok.txt', content: 'x' } }]),
      validator: passingValidator,
      approvalPolicy: 'auto',
      maxIterations: 6,
    });
    const result = await runner.run({ goal: 'Write the file\ndone: file exists' });
    expect(existsSync(join(workspace, 'ok.txt'))).toBe(true);
    const finished = result.events.find((event) => event.type === 'TOOL_CALL_FINISHED');
    const output = (finished?.payload as { result?: { output?: string } }).result?.output ?? '';
    expect(output).toContain('hook: lint clean on write_file');
    expect(result.events.some((event) => event.type === 'HOOK_EXECUTED' && (event.payload as { phase?: string }).phase === 'post_tool')).toBe(true);
  });

  test('hooks off (DAEDALUS_HOOKS=off equivalent) skips hooks entirely', async () => {
    const workspace = temp('daedalus-hooks-off-');
    const home = temp('daedalus-hooks-off-home-');
    writeFileEnsured(join(workspace, '.daedalus/hooks.json'), JSON.stringify({
      pre_tool: [{ match: '*', command: 'exit 2' }],
    }));
    const runner = new TaskRunner({
      workspaceRoot: workspace,
      store: new TaskStore(home),
      provider: scriptedProvider([{ tool: 'write_file', args: { path: 'free.txt', content: 'x' } }]),
      validator: passingValidator,
      approvalPolicy: 'auto',
      maxIterations: 6,
      hooks: false,
    });
    const result = await runner.run({ goal: 'Write the file\ndone: file exists' });
    expect(existsSync(join(workspace, 'free.txt'))).toBe(true);
    expect(result.events.some((event) => event.type === 'HOOK_EXECUTED')).toBe(false);
  });
});

describe('file-defined subagents', () => {
  test('parseAgentMarkdown reads frontmatter, tool lists, and body', () => {
    const inline = parseAgentMarkdown('---\nname: rev\ndescription: Reviews code\nmodel: m-1\nmode: code\ntools: [read_file, grep]\n---\nBe strict.', 'rev');
    expect(inline).toMatchObject({ name: 'rev', description: 'Reviews code', model: 'm-1', mode: 'auto', tools: ['read_file', 'grep'], instructions: 'Be strict.' });
    const listed = parseAgentMarkdown('---\ndescription: Listed\ntools:\n  - read_file\n  - edit_file\n---\nBody', 'fallback');
    expect(listed.tools).toEqual(['read_file', 'edit_file']);
    expect(listed.name).toBe('fallback');
  });

  test('loadAgents scans .daedalus/agents directories', async () => {
    const workspace = temp('daedalus-agents-ws-');
    writeFileEnsured(join(workspace, '.daedalus/agents/reader.md'), '---\nname: reader\ndescription: Reads only\ntools: [read_file]\n---\nRead things.');
    writeFileEnsured(join(workspace, '.daedalus/agents/notes.txt'), 'not an agent');
    const registry = await loadAgents([join(workspace, '.daedalus/agents')]);
    expect(registry.list().map((agent) => agent.name)).toEqual(['reader']);
    expect(registry.get('reader')?.tools).toEqual(['read_file']);
    expect(registry.get('ghost')).toBeUndefined();
  });

  test('an orchestrator child runs its named agent (allowlist enforced, name recorded)', async () => {
    const workspace = temp('daedalus-orch-agent-');
    const home = temp('daedalus-orch-agent-home-');
    writeFileEnsured(join(workspace, '.daedalus/agents/only-reader.md'), '---\nname: only-reader\ndescription: Read-only child\ntools: [read_file]\n---\nOnly read.');
    const runner = new TaskRunner({
      workspaceRoot: workspace,
      store: new TaskStore(home),
      provider: scriptedProvider([{ tool: 'write_file', args: { path: 'nope.txt', content: 'x' } }]),
      validator: passingValidator,
      approvalPolicy: 'auto',
      maxIterations: 6,
    });
    const result = await runner.run({
      goal: 'Coordinate the children',
      mode: 'orchestrator',
      children: [{ goal: 'Inspect the workspace', agent: 'only-reader' }],
    });
    const started = result.events.find((event) => event.type === 'CHILD_TASK_STARTED');
    expect((started?.payload as { child?: { agent?: string } }).child?.agent).toBe('only-reader');
    const childId = (started?.payload as { child?: { id?: string } }).child?.id;
    const childState = runner.store.loadState<{ agent?: string }>(childId ?? '');
    expect(childState?.agent).toBe('only-reader');
    expect(existsSync(join(workspace, 'nope.txt'))).toBe(false);
    const denied = result.events.find((event) => event.type === 'TOOL_CALL_FINISHED' && (event.payload as { result?: { status?: string } }).result?.status === 'denied');
    expect((denied?.payload as { result?: { output?: string } }).result?.output).toContain('not allowed');
  });

  test('an unknown agent name fails the orchestrated run up front', async () => {
    const workspace = temp('daedalus-orch-ghost-');
    const home = temp('daedalus-orch-ghost-home-');
    const runner = new TaskRunner({
      workspaceRoot: workspace,
      store: new TaskStore(home),
      provider: scriptedProvider([]),
      validator: passingValidator,
      approvalPolicy: 'auto',
    });
    await expect(runner.run({
      goal: 'Coordinate',
      mode: 'orchestrator',
      children: [{ goal: 'Boo', agent: 'ghost' }],
    })).rejects.toThrow(/unknown agent "ghost"/);
  });
});

describe('code review', () => {
  test('parseReviewFindings extracts structured findings', () => {
    const raw = [
      'Findings:',
      '- **[high] src/pay.ts:42** — amount is not validated before the transfer',
      '- **[low] src/util.ts** — unused variable',
      'some prose that is not a finding',
    ].join('\n');
    expect(parseReviewFindings(raw)).toEqual([
      { severity: 'high', file: 'src/pay.ts', line: 42, message: 'amount is not validated before the transfer' },
      { severity: 'low', file: 'src/util.ts', message: 'unused variable' },
    ]);
    expect(parseReviewFindings('No findings.')).toEqual([]);
  });

  test('reviewDiff runs one read-only provider call and caps the diff', async () => {
    const provider: LLMProvider = {
      name: 'review-fake',
      async chat(messages) {
        const prompt = messages.map((message) => String(message.content)).join('\n');
        expect(prompt).toContain('```diff');
        return { message: { role: 'assistant', content: '- **[medium] a.ts:3** — check this null path' } };
      },
      async *stream() { yield { type: 'delta', content: '' }; },
    };
    const result = await reviewDiff({ provider, diff: 'diff --git a/a.ts b/a.ts\n+const x = null;', rulesText: 'Be kind.', source: 'unstaged' });
    expect(result.findings).toEqual([{ severity: 'medium', file: 'a.ts', line: 3, message: 'check this null path' }]);
    expect(REVIEW_READ_ONLY_TOOLS).toEqual(['read_file', 'read_skill', 'lsp_diagnostics']);
    const messages = buildReviewMessages({ diff: 'x'.repeat(50_000), truncated: true });
    expect(String(messages[1]?.content)).toContain('truncated at 40000 characters');
  });
});

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' });
}

function makeGitRepo(): string {
  const repo = temp('daedalus-wt-repo-');
  git(repo, ['init', '-q']);
  git(repo, ['config', 'user.email', 'test@example.com']);
  git(repo, ['config', 'user.name', 'Daedalus Test']);
  writeFileEnsured(join(repo, 'README.md'), '# fixture\n');
  git(repo, ['add', '-A']);
  git(repo, ['commit', '-qm', 'initial']);
  return repo;
}

describe('git worktree-per-task', () => {
  test('an isolated run changes only the worktree; apply merges and cleans up', async () => {
    const repo = makeGitRepo();
    const home = temp('daedalus-wt-home-');
    const runner = new TaskRunner({
      workspaceRoot: repo,
      store: new TaskStore(home),
      provider: scriptedProvider([{ tool: 'write_file', args: { path: 'hello.txt', content: 'from the worktree\n' } }]),
      validator: passingValidator,
      approvalPolicy: 'auto',
      maxIterations: 6,
      isolation: 'worktree',
    });
    const result = await runner.run({ goal: 'Create hello.txt\ndone: hello.txt exists' });
    expect(result.report.worktree).toBeDefined();
    const worktree = result.report.worktree!;
    expect(worktree.branch).toMatch(/^daedalus\//);
    expect(worktree.files_changed).toContain('hello.txt');
    // The main workspace is untouched until apply.
    expect(existsSync(join(repo, 'hello.txt'))).toBe(false);
    expect(readFileSync(join(worktree.path, 'hello.txt'), 'utf8')).toBe('from the worktree\n');
    const record = runner.store.loadWorktreeRecord(result.state.id);
    expect(record).toMatchObject({ path: worktree.path, branch: worktree.branch });

    const applied = await applyTaskWorktree({ workspaceRoot: repo, record: record! });
    expect(applied.applied).toContain('hello.txt');
    expect(readFileSync(join(repo, 'hello.txt'), 'utf8')).toBe('from the worktree\n');
    await removeTaskWorktree({ workspaceRoot: repo, record: record! });
    expect(existsSync(worktree.path)).toBe(false);
    expect(git(repo, ['branch', '--list', 'daedalus/*']).trim()).toBe('');
  });

  test('a non-git workspace fails clearly before running', async () => {
    const workspace = temp('daedalus-wt-plain-');
    const home = temp('daedalus-wt-plain-home-');
    const runner = new TaskRunner({
      workspaceRoot: workspace,
      store: new TaskStore(home),
      provider: scriptedProvider([]),
      validator: passingValidator,
      approvalPolicy: 'auto',
      isolation: 'worktree',
    });
    await expect(runner.run({ goal: 'Do work\ndone: done' })).rejects.toThrow(/worktree isolation requires/);
  });
});
