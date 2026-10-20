import { afterEach, describe, expect, test } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  DefaultContextManager,
  SkillRegistry,
  createReadSkillTool,
  daedalusGlobalSkillsDir,
  formatSkillOrigin,
  globalSkillSearchDirs,
  loadSkills,
  resolveSkillSearchDirs,
  type TaskState,
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

function writeSkill(root: string, name: string, description: string, body: string): void {
  const dir = join(root, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'SKILL.md'), `---\nname: ${name}\ndescription: ${description}\n---\n${body}`);
}

/** A fake $HOME with the standard per-tool layout, plus an empty workspace. */
function fakeHome(): { home: string; workspace: string } {
  return { home: temp('daedalus-home-'), workspace: temp('daedalus-ws-') };
}

describe('global skill directory resolution', () => {
  test('the Daedalus global dir anchors at ~/.daedalus/skills unless DAEDALUS_HOME is an absolute override', () => {
    const { home } = fakeHome();
    expect(daedalusGlobalSkillsDir({ env: {}, homeDir: home })).toBe(join(home, '.daedalus', 'skills'));
    // A relative DAEDALUS_HOME is a per-workspace state root, not a global anchor.
    expect(daedalusGlobalSkillsDir({ env: { DAEDALUS_HOME: '.daedalus' }, homeDir: home })).toBe(join(home, '.daedalus', 'skills'));
    expect(daedalusGlobalSkillsDir({ env: { DAEDALUS_HOME: '/srv/daedalus-home' }, homeDir: home })).toBe('/srv/daedalus-home/skills');
  });

  test('the global search path is deterministic: daedalus global, env dir, then the other-tool dirs', () => {
    const { home } = fakeHome();
    const env = { DAEDALUS_SKILLS_DIR: '/opt/extra-skills', CODEX_HOME: '/opt/codex-home' };
    expect(globalSkillSearchDirs({ env, homeDir: home })).toEqual([
      { dir: join(home, '.daedalus', 'skills'), origin: 'global' },
      { dir: '/opt/extra-skills', origin: 'global' },
      { dir: join(home, '.claude', 'skills'), origin: 'claude' },
      { dir: '/opt/codex-home/skills', origin: 'codex' },
      { dir: join(home, '.config', 'opencode', 'skills'), origin: 'opencode' },
      { dir: join(home, '.opencode', 'skills'), origin: 'opencode' },
      { dir: join(home, '.kilocode', 'skills'), origin: 'kilo' },
    ]);
    // Without the env overrides, codex falls back to ~/.codex and the env dir disappears.
    expect(globalSkillSearchDirs({ env: {}, homeDir: home }).map((entry) => entry.dir)).toEqual([
      join(home, '.daedalus', 'skills'),
      join(home, '.claude', 'skills'),
      join(home, '.codex', 'skills'),
      join(home, '.config', 'opencode', 'skills'),
      join(home, '.opencode', 'skills'),
      join(home, '.kilocode', 'skills'),
    ]);
  });

  test('the workspace dir is searched first, ahead of every global dir', () => {
    const { home, workspace } = fakeHome();
    const search = resolveSkillSearchDirs(workspace, { env: {}, homeDir: home });
    expect(search[0]).toEqual({ dir: join(workspace, '.daedalus', 'skills'), origin: 'workspace' });
    expect(search.slice(1)).toEqual(globalSkillSearchDirs({ env: {}, homeDir: home }));
  });

  test('origin labels read as workspace / global / global · <tool>', () => {
    expect(formatSkillOrigin('workspace')).toBe('workspace');
    expect(formatSkillOrigin('global')).toBe('global');
    expect(formatSkillOrigin('claude')).toBe('global · claude');
    expect(formatSkillOrigin('codex')).toBe('global · codex');
    expect(formatSkillOrigin('opencode')).toBe('global · opencode');
    expect(formatSkillOrigin('kilo')).toBe('global · kilo');
  });
});

describe('global skill discovery', () => {
  test('a skill in ~/.daedalus/skills is detected from any workspace with origin global', async () => {
    const { home, workspace } = fakeHome();
    writeSkill(join(home, '.daedalus', 'skills'), 'everywhere', 'Works in every workspace', 'Global body.');

    const registry = await loadSkills(resolveSkillSearchDirs(workspace, { env: {}, homeDir: home }));
    expect(registry.list()).toEqual([
      { name: 'everywhere', description: 'Works in every workspace', source: join(home, '.daedalus', 'skills'), origin: 'global' },
    ]);
  });

  test('a skill in $DAEDALUS_SKILLS_DIR is detected with origin global', async () => {
    const { home, workspace } = fakeHome();
    const extra = temp('daedalus-extra-skills-');
    writeSkill(extra, 'extra-skill', 'From the env dir', 'Extra body.');

    const registry = await loadSkills(resolveSkillSearchDirs(workspace, { env: { DAEDALUS_SKILLS_DIR: extra }, homeDir: home }));
    expect(registry.list()).toEqual([
      { name: 'extra-skill', description: 'From the env dir', source: extra, origin: 'global' },
    ]);
  });

  test('a skill under an absolute $DAEDALUS_HOME/skills is detected with origin global', async () => {
    const { home, workspace } = fakeHome();
    const daemonHome = temp('daedalus-abs-home-');
    writeSkill(join(daemonHome, 'skills'), 'abs-skill', 'From the absolute home', 'Abs body.');

    const registry = await loadSkills(resolveSkillSearchDirs(workspace, { env: { DAEDALUS_HOME: daemonHome }, homeDir: home }));
    expect(registry.list()).toEqual([
      { name: 'abs-skill', description: 'From the absolute home', source: join(daemonHome, 'skills'), origin: 'global' },
    ]);
  });

  test('skills from other AI tools are detected read-only with their tool origin', async () => {
    const { home, workspace } = fakeHome();
    writeSkill(join(home, '.claude', 'skills'), 'claude-skill', 'Made for Claude Code', 'Claude body.');
    writeSkill(join(home, '.codex', 'skills'), 'codex-skill', 'Made for Codex', 'Codex body.');
    writeSkill(join(home, '.config', 'opencode', 'skills'), 'opencode-skill', 'Made for OpenCode', 'OpenCode body.');
    writeSkill(join(home, '.opencode', 'skills'), 'opencode-home-skill', 'Also OpenCode', 'OpenCode home body.');
    writeSkill(join(home, '.kilocode', 'skills'), 'kilo-skill', 'Made for Kilo', 'Kilo body.');

    const registry = await loadSkills(resolveSkillSearchDirs(workspace, { env: {}, homeDir: home }));
    const byName = registry.list().map((skill) => [skill.name, skill.origin]).sort((a, b) => String(a[0]).localeCompare(String(b[0])));
    expect(byName).toEqual([
      ['claude-skill', 'claude'],
      ['codex-skill', 'codex'],
      ['kilo-skill', 'kilo'],
      ['opencode-home-skill', 'opencode'],
      ['opencode-skill', 'opencode'],
    ]);
  });

  test('CODEX_HOME redirects the codex skills dir', async () => {
    const { home, workspace } = fakeHome();
    const codexHome = temp('daedalus-codex-home-');
    writeSkill(join(codexHome, 'skills'), 'codex-env-skill', 'Via CODEX_HOME', 'Body.');

    const registry = await loadSkills(resolveSkillSearchDirs(workspace, { env: { CODEX_HOME: codexHome }, homeDir: home }));
    expect(registry.list()).toEqual([
      { name: 'codex-env-skill', description: 'Via CODEX_HOME', source: join(codexHome, 'skills'), origin: 'codex' },
    ]);
  });

  test('precedence: workspace shadows global, which shadows the tool dirs', async () => {
    const { home, workspace } = fakeHome();
    writeSkill(join(workspace, '.daedalus', 'skills'), 'shared', 'Workspace copy', 'WORKSPACE_BODY');
    writeSkill(join(home, '.daedalus', 'skills'), 'shared', 'Global copy', 'GLOBAL_BODY');
    writeSkill(join(home, '.claude', 'skills'), 'shared', 'Claude copy', 'CLAUDE_BODY');

    const withWorkspace = await loadSkills(resolveSkillSearchDirs(workspace, { env: {}, homeDir: home }));
    expect(withWorkspace.get('shared')).toMatchObject({ origin: 'workspace', body: 'WORKSPACE_BODY' });

    const emptyWorkspace = temp('daedalus-ws-empty-');
    const withoutWorkspace = await loadSkills(resolveSkillSearchDirs(emptyWorkspace, { env: {}, homeDir: home }));
    expect(withoutWorkspace.get('shared')).toMatchObject({ origin: 'global', body: 'GLOBAL_BODY' });
  });

  test('missing dirs are silent and malformed skill folders are skipped', async () => {
    const { home, workspace } = fakeHome();
    const globalDir = join(home, '.daedalus', 'skills');
    // A folder whose SKILL.md is a directory, and a folder with no SKILL.md at all.
    mkdirSync(join(globalDir, 'broken', 'SKILL.md'), { recursive: true });
    mkdirSync(join(globalDir, 'no-manifest'), { recursive: true });
    writeSkill(globalDir, 'good', 'The one good skill', 'Good body.');

    const registry = await loadSkills(resolveSkillSearchDirs(workspace, { env: {}, homeDir: home }));
    expect(registry.list().map((skill) => skill.name)).toEqual(['good']);

    const nowhere = await loadSkills(resolveSkillSearchDirs(temp('daedalus-ws-none-'), { env: {}, homeDir: temp('daedalus-home-none-') }));
    expect(nowhere.size).toBe(0);
  });
});

describe('global skills in the agent surface', () => {
  test('read_skill returns a global skill body and tags its origin', async () => {
    const { home, workspace } = fakeHome();
    writeSkill(join(home, '.claude', 'skills'), 'claude-skill', 'Made for Claude Code', 'Follow the Claude playbook.');

    const registry = await loadSkills(resolveSkillSearchDirs(workspace, { env: {}, homeDir: home }));
    const tool = createReadSkillTool(registry);
    const loaded = await tool.execute({ name: 'claude-skill' }, { workspaceRoot: workspace });
    expect(loaded.status).toBe('ok');
    expect(loaded.output).toContain('Follow the Claude playbook.');
    expect(loaded.meta).toMatchObject({ skill: 'claude-skill', origin: 'claude' });
  });

  test('the agent context advertises a global skill with its origin tag', async () => {
    const { home, workspace } = fakeHome();
    writeSkill(join(home, '.claude', 'skills'), 'claude-skill', 'Made for Claude Code', 'Body.');
    writeSkill(join(workspace, '.daedalus', 'skills'), 'local-skill', 'Only here', 'Body.');

    const registry = await loadSkills(resolveSkillSearchDirs(workspace, { env: {}, homeDir: home }));
    const context = new DefaultContextManager({ skills: registry.list() });
    const state = {
      id: 'ctx-task', goal: 'Say hi', repo_path: workspace, constraints: [], done_criteria: [], created_at: new Date().toISOString(),
      plan: { id: 'p', task_id: 'ctx-task', steps: [], version: 1, status: 'active' }, steps: [], status: 'active',
    } as TaskState;
    const messages = await context.buildMessages(state, []);
    const system = messages[0];
    const text = typeof system?.content === 'string' ? system.content : JSON.stringify(system?.content);
    expect(text).toContain('Available skills');
    expect(text).toContain('- local-skill: Only here (workspace)');
    expect(text).toContain('- claude-skill: Made for Claude Code (global · claude)');
  });

  test('SkillRegistry keeps the first skill per name', () => {
    const registry = new SkillRegistry([
      { name: 'dup', description: 'first', source: '/a', origin: 'workspace', body: 'first', path: '/a/dup/SKILL.md' },
      { name: 'dup', description: 'second', source: '/b', origin: 'global', body: 'second', path: '/b/dup/SKILL.md' },
    ]);
    expect(registry.get('dup')?.body).toBe('first');
    expect(registry.list()).toEqual([{ name: 'dup', description: 'first', source: '/a', origin: 'workspace' }]);
  });
});
