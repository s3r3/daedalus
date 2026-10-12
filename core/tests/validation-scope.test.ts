import { afterEach, describe, expect, test } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  CommandValidator,
  DefaultContextManager,
  EventBus,
  TaskRunner,
  TaskStore,
  createReadSkillTool,
  discoverScopedChecks,
  loadSkills,
  type Event,
  type LLMProvider,
  type SkillInfo,
  type TaskState,
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

function writeJson(path: string, value: unknown): void {
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, JSON.stringify(value, null, 2), 'utf8');
}

function writeScript(dir: string, name: string, exitCode: 0 | 1): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, name), exitCode === 0 ? "console.log('check ok');\n" : "console.error('check failed');\nprocess.exit(1);\n", 'utf8');
}

/**
 * Monorepo fixture (Farid's scenario, distilled): the root's aggregate
 * test/lint/build scripts FAIL when run at the root, while member packages
 * `core` and `cli` have passing checks of their own. `rootPasses` flips the
 * root/member polarity for the root-owner case.
 */
function monorepoFixture(rootPasses: boolean): string {
  const root = temp('daedalus-scope-mono-');
  writeJson(join(root, 'package.json'), {
    name: 'mono-root',
    workspaces: ['core', 'cli'],
    scripts: { test: 'node root-check.mjs', lint: 'node root-check.mjs', build: 'node root-check.mjs' },
  });
  writeScript(root, 'root-check.mjs', rootPasses ? 0 : 1);
  for (const member of ['core', 'cli']) {
    writeJson(join(root, member, 'package.json'), { name: member, scripts: { test: 'node check.mjs' } });
    writeScript(join(root, member), 'check.mjs', rootPasses ? 1 : 0);
  }
  mkdirSync(join(root, 'ayid'), { recursive: true });
  writeFileSync(join(root, 'ayid', 'index.html'), '<!doctype html>\n<title>Ayid</title>\n', 'utf8');
  return root;
}

function scriptedProvider(script: Array<{ tool: string; args: unknown }>): LLMProvider {
  let index = 0;
  return {
    name: 'scope-scripted',
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
    async *stream() {
      yield { type: 'delta', content: '' };
    },
  };
}

function eventTypes(events: Event[]): string[] {
  return events.map((event) => event.type);
}

describe('changeset-scoped validation — discovery', () => {
  test('(a) a change outside every package selects no checks, with the reason noted', async () => {
    const root = monorepoFixture(false);
    const scoped = discoverScopedChecks(root, ['ayid/index.html']);
    expect(scoped.scoped).toBe(true);
    expect(scoped.commands).toEqual([]);
    expect(scoped.outsideFiles).toEqual(['ayid/index.html']);
    expect(scoped.note).toBe("changes are outside the project's packages (ayid/index.html)");

    const result = await new CommandValidator().validate({ workspaceRoot: root, changedFiles: ['ayid/index.html'] });
    expect(result.checks).toEqual([]);
    expect(result.note).toContain("outside the project's packages");
  });

  test('(a, absolute) absolute changed paths inside the root resolve the same way', () => {
    const root = monorepoFixture(false);
    const scoped = discoverScopedChecks(root, [join(root, 'ayid', 'index.html')]);
    expect(scoped.commands).toEqual([]);
    expect(scoped.outsideFiles).toEqual(['ayid/index.html']);
  });

  test('(b) a change inside a member runs only that member’s checks, from its directory', async () => {
    const root = monorepoFixture(false);
    const scoped = discoverScopedChecks(root, ['core/src/index.ts']);
    expect(scoped.scoped).toBe(true);
    expect(scoped.packages).toEqual(['core']);
    expect(scoped.commands).toHaveLength(1);
    expect(scoped.commands[0]).toMatchObject({ name: 'test', cmd: 'npm', cwd: 'core' });
    expect(scoped.note).toBe('checks scoped to package: core');

    // The member's passing check runs; the failing root aggregate does not.
    const result = await new CommandValidator().validate({ workspaceRoot: root, changedFiles: ['core/src/index.ts'] });
    expect(result.checks).toHaveLength(1);
    expect(result.checks[0]).toMatchObject({ name: 'test', status: 'pass' });
  });

  test('(c) a root-level change runs the root package’s checks only', async () => {
    const root = monorepoFixture(true);
    const scoped = discoverScopedChecks(root, ['README.md']);
    expect(scoped.packages).toEqual(['mono-root']);
    expect(scoped.commands.map((command) => command.name)).toEqual(['test', 'lint', 'build']);
    expect(scoped.commands.every((command) => command.cwd === undefined)).toBe(true);

    // Root passes here while members fail: passing proves members were not run.
    const result = await new CommandValidator().validate({ workspaceRoot: root, changedFiles: ['README.md'] });
    expect(result.checks.every((check) => check.status === 'pass')).toBe(true);
  });

  test('several affected packages: names carry their package and the root runs last', () => {
    const root = monorepoFixture(false);
    const scoped = discoverScopedChecks(root, ['README.md', 'core/src/a.ts', 'core/src/b.ts']);
    expect(scoped.packages).toEqual(['core', 'mono-root']);
    expect(scoped.commands.map((command) => command.name)).toEqual(['test (core)', 'test (mono-root)', 'lint (mono-root)', 'build (mono-root)']);
    expect(scoped.commands[0]?.cwd).toBe('core');
    expect(scoped.commands.slice(1).every((command) => command.cwd === undefined)).toBe(true);
    expect(scoped.note).toBe('checks scoped to packages: core, mono-root');
  });

  test('(d) without a workspaces field the project is single-package and unchanged', () => {
    const root = temp('daedalus-scope-single-');
    writeJson(join(root, 'package.json'), { name: 'solo', scripts: { test: 'node ok.mjs', build: 'node ok.mjs' } });
    const scoped = discoverScopedChecks(root, ['src/x.ts']);
    expect(scoped.scoped).toBe(false);
    expect(scoped.commands.map((command) => command.name)).toEqual(['test', 'build']);
    expect(scoped.commands.every((command) => command.cwd === undefined)).toBe(true);
    expect(scoped.note).toBeUndefined();
  });

  test('simple dir/* workspace globs resolve their members (incl. dir-valued changes)', () => {
    const root = temp('daedalus-scope-glob-');
    writeJson(join(root, 'package.json'), { name: 'glob-root', workspaces: ['packages/*'], scripts: { test: 'node root-check.mjs' } });
    writeJson(join(root, 'packages', 'web', 'package.json'), { name: 'webby', scripts: { test: 'node check.mjs' } });
    writeScript(join(root, 'packages', 'web'), 'check.mjs', 0);
    mkdirSync(join(root, 'packages', 'web', 'src'), { recursive: true });

    const scoped = discoverScopedChecks(root, ['packages/web/src/x.ts']);
    expect(scoped.packages).toEqual(['webby']);
    expect(scoped.commands).toHaveLength(1);
    expect(scoped.commands[0]).toMatchObject({ name: 'test', cwd: 'packages/web' });

    // A create_dir-style change naming the directory itself hits the member too.
    const forDir = discoverScopedChecks(root, ['packages/web']);
    expect(forDir.packages).toEqual(['webby']);
  });

  test('(e) a validation profile overrides scoping entirely', async () => {
    const root = monorepoFixture(false);
    mkdirSync(join(root, '.daedalus'), { recursive: true });
    writeFileSync(join(root, '.daedalus', 'validate.json'), JSON.stringify({ checks: [{ name: 'prof', command: 'node prof.mjs' }] }), 'utf8');
    writeScript(root, 'prof.mjs', 0);

    const result = await new CommandValidator().validate({ workspaceRoot: root, changedFiles: ['ayid/index.html'] });
    expect(result.source).toBe('profile');
    expect(result.checks).toHaveLength(1);
    expect(result.checks[0]).toMatchObject({ name: 'prof', status: 'pass', source: 'profile' });
    expect(result.note).toBeUndefined();
  });
});

describe('changeset-scoped validation — end to end', () => {
  test('(a) Farid’s scenario: landing page in a loose folder succeeds; root aggregates never run', async () => {
    const workspace = monorepoFixture(false);
    const home = temp('daedalus-scope-home-');
    const runner = new TaskRunner({
      workspaceRoot: workspace,
      store: new TaskStore(home),
      bus: new EventBus(),
      provider: scriptedProvider([
        { tool: 'create_dir', args: { path: 'ayid' } },
        { tool: 'write_file', args: { path: 'ayid/index.html', content: '<!doctype html>\n<html><head><title>Ayid</title></head><body>hi</body></html>\n' } },
      ]),
      approvalPolicy: 'auto',
      maxIterations: 10,
    });

    const result = await runner.run({ goal: 'coba buat kan landing page dalam html buat di folder ayid buatkan folder juga\n\ndone: ayid/index.html exists' });
    expect(result.outcome).toBe('success');
    expect(eventTypes(result.events)).toContain('VALIDATION_PASSED');
    expect(result.report.evidence.some((line) => line.startsWith("validation skipped: changes are outside the project's packages"))).toBe(true);
    expect(result.report.metrics.checks_failed).toBe(0);
  });

  test('(f) an identical validation failure with no change in between stops recovery early', async () => {
    const workspace = temp('daedalus-scope-thrash-ws-');
    const home = temp('daedalus-scope-thrash-home-');
    const alwaysFail: Validator = {
      async validate(): Promise<ValidationResult> {
        return { checks: [{ name: 'fixture', cmd: 'node validate.js', status: 'fail', exit_code: 1, summary: 'still broken', diagnostics: [{ message: 'still broken' }] }] };
      },
    };
    const runner = new TaskRunner({
      workspaceRoot: workspace,
      store: new TaskStore(home),
      bus: new EventBus(),
      provider: scriptedProvider([
        { tool: 'write_file', args: { path: 'value.txt', content: 'try-1' } },
        { tool: 'read_file', args: { path: 'value.txt' } },
      ]),
      validator: alwaysFail,
      approvalPolicy: 'auto',
      maxIterations: 10,
    });

    const result = await runner.run({ goal: 'Fix the value\n\ndone: check that value.txt equals fixed' });
    expect(result.outcome).toBe('partial');
    expect(result.events.filter((event) => event.type === 'VALIDATION_FAILED')).toHaveLength(2);
    expect(result.events.filter((event) => event.type === 'RECOVERY_STARTED')).toHaveLength(1);
    expect(result.report.evidence.some((line) => line.includes('identical validation failure repeated'))).toBe(true);
  });

  test('(f, control) a mutation between identical failures keeps recovery going', async () => {
    const workspace = temp('daedalus-scope-thrash2-ws-');
    const home = temp('daedalus-scope-thrash2-home-');
    const alwaysFail: Validator = {
      async validate(): Promise<ValidationResult> {
        return { checks: [{ name: 'fixture', cmd: 'node validate.js', status: 'fail', exit_code: 1, summary: 'still broken', diagnostics: [{ message: 'still broken' }] }] };
      },
    };
    const runner = new TaskRunner({
      workspaceRoot: workspace,
      store: new TaskStore(home),
      bus: new EventBus(),
      provider: scriptedProvider([
        { tool: 'write_file', args: { path: 'value.txt', content: 'try-1' } },
        { tool: 'write_file', args: { path: 'value.txt', content: 'try-2' } },
        { tool: 'write_file', args: { path: 'value.txt', content: 'try-3' } },
      ]),
      validator: alwaysFail,
      approvalPolicy: 'auto',
      maxIterations: 10,
    });

    const result = await runner.run({ goal: 'Fix the value\n\ndone: value.txt equals fixed' });
    expect(result.outcome).toBe('partial');
    expect(result.events.filter((event) => event.type === 'VALIDATION_FAILED')).toHaveLength(3);
    expect(result.events.filter((event) => event.type === 'RECOVERY_STARTED')).toHaveLength(3);
  });
});

function writeSkill(root: string, name: string, description: string): void {
  mkdirSync(join(root, name), { recursive: true });
  writeFileSync(join(root, name, 'SKILL.md'), `---\nname: ${name}\ndescription: ${description}\n---\n# ${name}\nBody of ${name}.\n`, 'utf8');
}

function contextState(workspace: string): TaskState {
  return {
    id: 'scope-ctx', goal: 'Say hi', repo_path: workspace, constraints: [], done_criteria: [], created_at: new Date().toISOString(),
    plan: { id: 'p', task_id: 'scope-ctx', steps: [], version: 1, status: 'active' }, steps: [], status: 'active',
  } as TaskState;
}

async function systemText(context: DefaultContextManager, workspace: string): Promise<string> {
  const messages = await context.buildMessages(contextState(workspace), []);
  const system = messages[0];
  return typeof system?.content === 'string' ? system.content : JSON.stringify(system?.content);
}

describe('(g) skills listing dedupe and cap', () => {
  test('loader: the same skill via two roots and a symlinked root alias is listed once', async () => {
    const parent = temp('daedalus-skill-dup-');
    writeSkill(join(parent, 'rootA'), 'dup', 'First copy wins');
    writeSkill(join(parent, 'rootB'), 'dup', 'Second copy loses');
    symlinkSync(join(parent, 'rootA'), join(parent, 'rootAlias'), 'dir');

    const registry = await loadSkills([
      { dir: join(parent, 'rootA'), origin: 'workspace' },
      { dir: join(parent, 'rootB'), origin: 'claude' },
      { dir: join(parent, 'rootAlias'), origin: 'global' },
    ]);
    const listed = registry.list();
    expect(listed.filter((skill) => skill.name === 'dup')).toHaveLength(1);
    expect(listed[0]).toMatchObject({ description: 'First copy wins', origin: 'workspace' });

    const tool = createReadSkillTool(registry);
    expect(tool.description?.match(/\bdup\b/g)).toHaveLength(1);
  });

  test('context: a raw duplicated skills feed is still advertised once per name', async () => {
    const workspace = temp('daedalus-skill-ctx-');
    const info = (name: string, description: string, origin: SkillInfo['origin']): SkillInfo => ({ name, description, source: '/x', origin });
    const context = new DefaultContextManager({
      skills: [info('dup', 'one', 'workspace'), info('dup', 'two', 'claude'), info('solo', 'alone', 'global')],
    });
    const text = await systemText(context, workspace);
    expect(text.match(/^- dup:/gm)).toHaveLength(1);
    expect(text).toContain('- dup: one (workspace)');
    expect(text).toContain('- solo: alone (global)');
    expect(text).not.toContain('more skills available');
  });

  test('context: the listing caps at 40 with a "+N more" line', async () => {
    const workspace = temp('daedalus-skill-cap-');
    const skills: SkillInfo[] = Array.from({ length: 45 }, (_, index) => ({
      name: `s${String(index).padStart(2, '0')}`,
      description: `skill ${index}`,
      source: '/x',
      origin: 'global' as const,
    }));
    const text = await systemText(new DefaultContextManager({ skills }), workspace);
    expect(text.match(/^- s\d\d:/gm)).toHaveLength(40);
    expect(text).toContain('+5 more skills available — use read_skill by name');
  });
});
