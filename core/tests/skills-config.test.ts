import { afterEach, describe, expect, test } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  SkillRegistry,
  createReadSkillTool,
  loadSkillConfig,
  loadSkillInventory,
  loadSkills,
  parseSkillConfig,
  setSkillDisabled,
  skillsConfigPath,
  writeSkillConfig,
  type SkillDir,
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

function writeSkill(root: string, name: string, description: string, body = 'Skill body.'): void {
  const dir = join(root, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'SKILL.md'), `---\nname: ${name}\ndescription: ${description}\n---\n${body}`);
}

describe('per-workspace skill config (.daedalus/skills.json)', () => {
  test('a missing config degrades to all-enabled, and a corrupt one does too', async () => {
    const workspace = temp('daedalus-cfg-');
    await expect(loadSkillConfig(workspace)).resolves.toEqual({ disabled: [] });

    mkdirSync(join(workspace, '.daedalus'), { recursive: true });
    writeFileSync(skillsConfigPath(workspace), '{not json at all', 'utf8');
    await expect(loadSkillConfig(workspace)).resolves.toEqual({ disabled: [] });

    // Non-object / wrong-typed disabled entries are dropped, never honored.
    writeFileSync(skillsConfigPath(workspace), JSON.stringify({ disabled: [42, null, '  kept ', ''] }), 'utf8');
    await expect(loadSkillConfig(workspace)).resolves.toEqual({ disabled: ['kept'] });
    expect(parseSkillConfig('garbage')).toEqual({ disabled: [] });
    expect(parseSkillConfig(null)).toEqual({ disabled: [] });
  });

  test('setSkillDisabled round-trips through the file the loader reads', async () => {
    const workspace = temp('daedalus-cfg-');
    await setSkillDisabled(workspace, 'deploy', true);
    await setSkillDisabled(workspace, 'lint', true);
    await setSkillDisabled(workspace, 'deploy', true); // idempotent, no duplicates
    expect(JSON.parse(readFileSync(skillsConfigPath(workspace), 'utf8'))).toEqual({ disabled: ['deploy', 'lint'] });
    await expect(loadSkillConfig(workspace)).resolves.toEqual({ disabled: ['deploy', 'lint'] });

    await setSkillDisabled(workspace, 'deploy', false);
    await expect(loadSkillConfig(workspace)).resolves.toEqual({ disabled: ['lint'] });

    // Recording a name that has no skill is allowed (pre-emptive disable).
    await writeSkillConfig(workspace, { disabled: ['future-skill'] });
    await expect(loadSkillConfig(workspace)).resolves.toEqual({ disabled: ['future-skill'] });
  });

  test('the loader excludes disabled names before the cap, from every origin, and read_skill refuses them', async () => {
    const workspace = temp('daedalus-cfg-ws-');
    const global = temp('daedalus-cfg-global-');
    writeSkill(join(workspace, '.daedalus', 'skills'), 'deploy', 'Deploy the thing', 'DEPLOY BODY');
    writeSkill(global, 'deploy', 'Global deploy shadow', 'GLOBAL DEPLOY BODY');
    writeSkill(global, 'lint', 'Lint the code', 'LINT BODY');
    const search: SkillDir[] = [
      { dir: join(workspace, '.daedalus', 'skills'), origin: 'workspace' },
      { dir: global, origin: 'global' },
    ];

    await setSkillDisabled(workspace, 'deploy', true);
    const { disabled } = await loadSkillConfig(workspace);
    const registry = await loadSkills(search, { disabledNames: disabled });

    // Disabled by name: the workspace winner is gone AND the global copy
    // does not resurrect it.
    expect(registry.list().map((skill) => skill.name)).toEqual(['lint']);
    expect(registry.isDisabled('deploy')).toBe(true);
    expect(registry.isDisabled('lint')).toBe(false);

    const tool = createReadSkillTool(registry);
    const refused = await tool.execute({ name: 'deploy' });
    expect(refused.status).toBe('error');
    expect(refused.output).toContain('disabled for this workspace');
    expect(refused.meta).toMatchObject({ skill: 'deploy', disabled: true });

    // Exclusion happens before the prompt-index slice: with 1 disabled,
    // the enabled skills behind it still fill the cap (41 enabled + 1
    // disabled → 41 in the registry, prompt shows 40 + "+1 more").
    for (let i = 0; i < 41; i += 1) writeSkill(global, `s${i}`, `skill ${i}`);
    const capSearch: SkillDir[] = [{ dir: global, origin: 'global' }];
    const withDisabled = await loadSkills(capSearch, { disabledNames: ['s0'] });
    expect(withDisabled.list().filter((skill) => skill.name.startsWith('s')).length).toBe(40);
    expect(withDisabled.get('s40')?.name).toBe('s40');
  });

  test('the inventory lists winners, shadowed copies, and disabled state side by side', async () => {
    const workspace = temp('daedalus-inv-ws-');
    const global = temp('daedalus-inv-global-');
    writeSkill(join(workspace, '.daedalus', 'skills'), 'duel', 'Workspace duel', 'WS BODY');
    writeSkill(global, 'duel', 'Global duel (shadowed)', 'GLOBAL BODY');
    writeSkill(global, 'solo', 'Solo global', 'SOLO BODY');

    await setSkillDisabled(workspace, 'solo', true);
    const inventory = await loadSkillInventory(
      [
        { dir: join(workspace, '.daedalus', 'skills'), origin: 'workspace' },
        { dir: global, origin: 'global' },
      ],
      { disabledNames: ['solo'] },
    );

    const duel = inventory.filter((entry) => entry.name === 'duel');
    expect(duel).toHaveLength(2);
    const workspaceDuel = duel.find((entry) => entry.origin === 'workspace');
    expect(workspaceDuel).toMatchObject({ disabled: false });
    expect(workspaceDuel?.shadowedBy).toBeUndefined();
    expect(duel.find((entry) => entry.origin === 'global')).toMatchObject({ disabled: false, shadowedBy: 'workspace' });
    const solo = inventory.find((entry) => entry.name === 'solo');
    expect(solo).toMatchObject({ disabled: true });
    expect(solo?.shadowedBy).toBeUndefined();
  });

  test('a registry without any config loads everything (all-enabled default)', async () => {
    const global = temp('daedalus-cfg-global-');
    writeSkill(global, 'anything', 'Anything skill');
    const registry = new SkillRegistry([]);
    expect(registry.isDisabled('anything')).toBe(false);
    const loaded = await loadSkills([{ dir: global, origin: 'global' }]);
    expect(loaded.list().map((skill) => skill.name)).toEqual(['anything']);
  });
});
