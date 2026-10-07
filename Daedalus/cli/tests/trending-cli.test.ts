import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';import { createServer as createHttpServer, type Server as HttpServer } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { SLASH_COMMANDS, loadSkills, workspaceSkillsDir } from '@daedalus/core';
import { buildProgram, formatEvent, parseIsolation } from '../src/index.ts';
import { InteractiveSession } from '../src/interactive.ts';
import { formatSkillsListing, installBundledSkills, listSkills } from '../src/skills-bundled.ts';

const cleanups: Array<() => void> = [];
afterEach(() => {
  while (cleanups.length) cleanups.pop()?.();
  process.exitCode = undefined;
});

function temp(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

// The bundled catalog gains `ponytail` (docs/THIRD_PARTY.md): a starter
// skill like the other five — listed and installable, never loaded by
// default. The list grows with the catalog; that is the point of pinning it.
const EXPECTED_BUNDLED = ['code-review', 'git-workflow', 'ponytail', 'spec-driven-development', 'systematic-debugging', 'test-driven-development'];

describe('bundled starter skills', () => {
  test('lists the six bundled skills with provenance', async () => {
    const workspace = temp('daedalus-skills-list-');
    const listing = await listSkills({ workspaceRoot: workspace });
    expect(listing.bundled.map((skill) => skill.name)).toEqual(EXPECTED_BUNDLED);
    expect(listing.installed).toEqual([]);
    expect(listing.workspaceDir).toBe(workspaceSkillsDir(workspace));
  });

  test('install copies skills, refuses overwrites without --force, and the core loader loads them', async () => {
    const workspace = temp('daedalus-skills-install-');
    const first = await installBundledSkills({ workspaceRoot: workspace, all: true });
    expect(first.installed).toEqual(EXPECTED_BUNDLED);
    expect(existsSync(join(workspace, '.daedalus/skills/spec-driven-development/SKILL.md'))).toBe(true);

    const registry = await loadSkills([workspaceSkillsDir(workspace)]);
    expect(registry.list().map((skill) => skill.name).sort()).toEqual(EXPECTED_BUNDLED);

    const second = await installBundledSkills({ workspaceRoot: workspace, all: true });
    expect(second.installed).toEqual([]);
    expect(second.skipped.map((entry) => entry.name)).toEqual(EXPECTED_BUNDLED);
    expect(second.skipped[0]?.reason).toContain('--force');

    const forced = await installBundledSkills({ workspaceRoot: workspace, names: ['code-review'], force: true });
    expect(forced.installed).toEqual(['code-review']);

    const unknown = await installBundledSkills({ workspaceRoot: workspace, names: ['nope'] });
    expect(unknown.skipped).toEqual([{ name: 'nope', reason: 'not a bundled skill' }]);
  });
});

describe('global skills (CLI surface)', () => {
  function writeSkill(root: string, name: string, description: string, body = 'Body.'): void {
    const dir = join(root, name);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'SKILL.md'), `---\nname: ${name}\ndescription: ${description}\n---\n${body}`);
  }

  test('list shows detected skills with origins and every directory searched', async () => {
    const home = temp('daedalus-cli-home-');
    const workspace = temp('daedalus-cli-ws-');
    writeSkill(join(workspace, '.daedalus', 'skills'), 'local-skill', 'Only in this workspace');
    writeSkill(join(home, '.daedalus', 'skills'), 'global-skill', 'In every workspace');
    writeSkill(join(home, '.claude', 'skills'), 'claude-skill', 'Borrowed from Claude Code');

    const listing = await listSkills({ workspaceRoot: workspace, env: {}, homeDir: home });
    expect(listing.detected).toEqual([
      { name: 'claude-skill', description: 'Borrowed from Claude Code', origin: 'claude', dir: join(home, '.claude', 'skills'), disabled: false },
      { name: 'global-skill', description: 'In every workspace', origin: 'global', dir: join(home, '.daedalus', 'skills'), disabled: false },
      { name: 'local-skill', description: 'Only in this workspace', origin: 'workspace', dir: join(workspace, '.daedalus', 'skills'), disabled: false },
    ]);
    expect(listing.installed.map((skill) => skill.name)).toEqual(['local-skill']);
    expect(listing.globalDir).toBe(join(home, '.daedalus', 'skills'));
    expect(listing.searchedDirs.map((entry) => entry.dir)).toEqual([
      join(workspace, '.daedalus', 'skills'),
      join(home, '.daedalus', 'skills'),
      join(home, '.claude', 'skills'),
      join(home, '.codex', 'skills'),
      join(home, '.config', 'opencode', 'skills'),
      join(home, '.opencode', 'skills'),
      join(home, '.kilocode', 'skills'),
    ]);
    const kilo = listing.searchedDirs.find((entry) => entry.origin === 'kilo');
    expect(kilo?.exists).toBe(false);

    const text = formatSkillsListing(listing);
    expect(text).toContain('local-skill (workspace)');
    expect(text).toContain('global-skill (global)');
    expect(text).toContain('claude-skill (global · claude)');
    expect(text).toContain(join(home, '.kilocode', 'skills'));
    expect(text).toContain('not present');
  });

  test('install --global writes to the global dir, dedupes, and is detected from other workspaces', async () => {
    const home = temp('daedalus-cli-home-');
    const workspace = temp('daedalus-cli-ws-');
    const globalDir = join(home, '.daedalus', 'skills');

    const first = await installBundledSkills({ workspaceRoot: workspace, names: ['code-review'], global: true, env: {}, homeDir: home });
    expect(first.installed).toEqual(['code-review']);
    expect(first.targetDir).toBe(globalDir);
    expect(existsSync(join(globalDir, 'code-review', 'SKILL.md'))).toBe(true);
    // Nothing leaked into the workspace itself.
    expect(existsSync(join(workspace, '.daedalus', 'skills', 'code-review', 'SKILL.md'))).toBe(false);

    const second = await installBundledSkills({ workspaceRoot: workspace, names: ['code-review'], global: true, env: {}, homeDir: home });
    expect(second.installed).toEqual([]);
    expect(second.skipped).toHaveLength(1);
    expect(second.skipped[0]?.reason).toContain('--force');

    const forced = await installBundledSkills({ workspaceRoot: workspace, names: ['code-review'], global: true, force: true, env: {}, homeDir: home });
    expect(forced.installed).toEqual(['code-review']);

    // A different workspace now detects the globally installed skill.
    const otherWorkspace = temp('daedalus-cli-ws-other-');
    const listing = await listSkills({ workspaceRoot: otherWorkspace, env: {}, homeDir: home });
    expect(listing.detected).toContainEqual(expect.objectContaining({ name: 'code-review', origin: 'global' }));
    expect(listing.installed).toEqual([]);
  });
});

describe('slash commands for agents and review', () => {
  test('the shared registry lists /agents and /review', () => {
    const names = SLASH_COMMANDS.map((command) => command.name);
    expect(names).toContain('agents');
    expect(names).toContain('review');
  });

  test('/agents dispatches to the session callback', async () => {
    const session = new InteractiveSession({
      workspaceRoot: temp('daedalus-session-agents-'),
      callbacks: { listAgents: () => 'only-reader — Read-only child · tools: read_file' },
    });
    const result = await session.handleInput('/agents');
    expect(result.kind).toBe('slash');
    expect(result.text).toContain('only-reader');
  });

  test('/review dispatches to the session callback', async () => {
    const session = new InteractiveSession({
      workspaceRoot: temp('daedalus-session-review-'),
      callbacks: { review: () => ({ text: '- **[high] a.ts:1** — boom', action: 'review' }) },
    });
    const result = await session.handleInput('/review');
    expect(result.kind).toBe('slash');
    expect(result.text).toContain('**[high] a.ts:1**');
  });
});

describe('hook events render for humans', () => {
  test('a blocked hook names the tool and the reason', () => {
    const line = formatEvent({ type: 'HOOK_EXECUTED', task_id: 't', payload: { phase: 'pre_tool', tool: 'write_file', command: 'guard', outcome: 'blocked', reason: 'frozen' } });
    expect(line).toContain('write_file');
    expect(line).toContain('frozen');
  });
});

describe('apply command', () => {
  function git(cwd: string, args: string[]): string {
    return execFileSync('git', args, { cwd, encoding: 'utf8' });
  }

  test('applies a recorded worktree and removes it; refuses unknown tasks', async () => {
    const repo = temp('daedalus-apply-repo-');
    git(repo, ['init', '-q']);
    git(repo, ['config', 'user.email', 'test@example.com']);
    git(repo, ['config', 'user.name', 'Daedalus Test']);
    writeFileSync(join(repo, 'README.md'), '# fixture\n');
    git(repo, ['add', '-A']);
    git(repo, ['commit', '-qm', 'initial']);

    const { createTaskWorktree, TaskStore, resolveDaedalusHome, loadSettings } = await import('@daedalus/core');
    const store = new TaskStore(resolveDaedalusHome(loadSettings().daedalusHome, repo));
    const record = await createTaskWorktree({ workspaceRoot: repo, daedalusHome: store.root, taskId: 'apply-task-1' });
    writeFileSync(join(record.path, 'applied.txt'), 'merged back\n');
    store.saveWorktreeRecord('apply-task-1', record);

    const program = buildProgram();
    program.exitOverride();
    await program.parseAsync(['node', 'daedalus', 'apply', 'apply-task-1', '--cwd', repo]);
    expect(readFileSync(join(repo, 'applied.txt'), 'utf8')).toBe('merged back\n');
    expect(existsSync(record.path)).toBe(false);

    process.exitCode = undefined;
    await program.parseAsync(['node', 'daedalus', 'apply', 'missing-task', '--cwd', repo]);
    expect(process.exitCode).toBe(1);
  });
});

describe('packaging', () => {
  test('root and CLI package.json both expose the daedalus bin', () => {
    const rootPkg = JSON.parse(readFileSync(fileURLToPath(new URL('../../package.json', import.meta.url)), 'utf8')) as { bin?: Record<string, string>; files?: string[] };
    const cliPkg = JSON.parse(readFileSync(fileURLToPath(new URL('../package.json', import.meta.url)), 'utf8')) as { bin?: Record<string, string> };
    expect(rootPkg.bin?.daedalus).toBe('./cli/src/index.ts');
    expect(cliPkg.bin?.daedalus).toBe('./src/index.ts');
    expect(rootPkg.files).toContain('skills');
    expect(rootPkg.files?.some((entry) => entry.includes('node_modules'))).toBe(false);
  });

  test('parseIsolation accepts worktree only', () => {
    expect(parseIsolation(undefined)).toBeUndefined();
    expect(parseIsolation('worktree')).toBe('worktree');
    expect(() => parseIsolation('bogus')).toThrow(/--isolation expects/);
  });
});

describe('headless / CI runs', () => {
  let modelServer: HttpServer | undefined;
  const envBackup = { ...process.env };
  afterEach(async () => {
    if (modelServer) await new Promise<void>((resolve) => modelServer?.close(() => resolve()));
    modelServer = undefined;
    for (const key of Object.keys(process.env)) if (!(key in envBackup)) delete process.env[key];
    Object.assign(process.env, envBackup);
  });

  async function startFakeModel(): Promise<string> {
    let calls = 0;
    modelServer = createHttpServer((req, res) => {
      if (req.url === '/v1/chat/completions') {
        req.resume();
        req.on('end', () => {
          calls++;
          const message = calls === 1
            ? { role: 'assistant', content: '', tool_calls: [{ id: 'ci-call-1', type: 'function', function: { name: 'write_file', arguments: JSON.stringify({ path: 'note.txt', content: 'ci\n' }) } }] }
            : { role: 'assistant', content: 'done: finished' };
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ choices: [{ message, finish_reason: calls === 1 ? 'tool_calls' : 'stop' }] }));
        });
        return;
      }
      res.writeHead(404).end();
    });
    await new Promise<void>((resolve) => modelServer?.listen(0, '127.0.0.1', resolve));
    const address = modelServer.address() as { port: number };
    return `http://127.0.0.1:${address.port}/v1`;
  }

  async function runProgram(args: string[]): Promise<{ stdout: string }> {
    const chunks: string[] = [];
    const spy = vi.spyOn(process.stdout, 'write').mockImplementation((chunk: unknown) => { chunks.push(String(chunk)); return true; });
    const errSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    try {
      const program = buildProgram();
      program.exitOverride();
      await program.parseAsync(['node', 'daedalus', ...args]);
    } finally {
      spy.mockRestore();
      errSpy.mockRestore();
    }
    return { stdout: chunks.join('') };
  }

  function lastJsonLine(stdout: string): Record<string, unknown> {
    const lines = stdout.trim().split('\n').filter((line) => line.trim().startsWith('{'));
    return JSON.parse(lines.at(-1) ?? '{}') as Record<string, unknown>;
  }

  function seedPassingValidation(workspace: string): void {
    mkdirSync(join(workspace, '.daedalus'), { recursive: true });
    writeFileSync(join(workspace, '.daedalus', 'validate.json'), JSON.stringify({ checks: [{ name: 'sanity', command: 'echo ok' }] }), 'utf8');
  }

  test('--ci never prompts: mutating calls auto-deny without --yolo and the summary maps the exit code', async () => {
    const workspace = temp('daedalus-ci-');
    seedPassingValidation(workspace);
    const base = await startFakeModel();
    process.env.LLM_BASE_URL = base;
    process.env.LLM_API_KEY = 'test-key';
    process.env.LLM_MODEL = 'fake-model';

    const { stdout } = await runProgram(['run', '--ci', 'Create note.txt\ndone: note.txt exists', '--cwd', workspace]);
    expect(existsSync(join(workspace, 'note.txt'))).toBe(false);
    const summary = lastJsonLine(stdout);
    expect(summary).toHaveProperty('outcome');
    expect(summary).toHaveProperty('exit_code');
    expect(typeof summary.exit_code).toBe('number');
    expect(process.exitCode).toBe(summary.exit_code);
  });

  test('--ci --yolo lets the task write and exits 0', async () => {
    const workspace = temp('daedalus-ci-yolo-');
    seedPassingValidation(workspace);
    const base = await startFakeModel();
    process.env.LLM_BASE_URL = base;
    process.env.LLM_API_KEY = 'test-key';
    process.env.LLM_MODEL = 'fake-model';

    const { stdout } = await runProgram(['run', '--ci', '--yolo', 'Create note.txt\ndone: note.txt exists', '--cwd', workspace]);
    expect(readFileSync(join(workspace, 'note.txt'), 'utf8')).toBe('ci\n');
    expect(lastJsonLine(stdout)).toMatchObject({ outcome: 'success', exit_code: 0 });
    expect((lastJsonLine(stdout).report as { validation_source?: string }).validation_source).toBe('profile');
    expect(process.exitCode).toBe(0);
  });
});
