import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import { loadSkills, resolveSkillSearchDirs, workspaceSkillsDir } from '@daedalus/core';
import { installBundledSkills, listSkills } from '../src/skills-bundled.ts';

const cleanups: Array<() => void> = [];
afterEach(() => {
  while (cleanups.length) cleanups.pop()?.();
});

function temp(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

describe('bundled ponytail skill', () => {
  test('is in the starter catalog but neither installed nor detected on a fresh workspace', async () => {
    const workspace = temp('daedalus-ponytail-ws-');
    const home = temp('daedalus-ponytail-home-');
    const listing = await listSkills({ workspaceRoot: workspace, env: {}, homeDir: home });
    const bundled = listing.bundled.find((skill) => skill.name === 'ponytail');
    expect(bundled).toBeDefined();
    expect(bundled?.description).toContain('ladder');
    expect(listing.installed.map((skill) => skill.name)).not.toContain('ponytail');
    expect(listing.detected.map((skill) => skill.name)).not.toContain('ponytail');

    // The loader (which feeds the prompt's skill index) must not see it either.
    const registry = await loadSkills(resolveSkillSearchDirs(workspace, { env: {}, homeDir: home }));
    expect(registry.list().map((skill) => skill.name)).not.toContain('ponytail');
  });

  test('installs through the bundled path and the core loader then picks it up', async () => {
    const workspace = temp('daedalus-ponytail-install-');
    const result = await installBundledSkills({ workspaceRoot: workspace, names: ['ponytail'] });
    expect(result.installed).toEqual(['ponytail']);
    const skillFile = join(workspaceSkillsDir(workspace), 'ponytail', 'SKILL.md');
    expect(existsSync(skillFile)).toBe(true);

    const registry = await loadSkills([workspaceSkillsDir(workspace)]);
    expect(registry.list().map((skill) => skill.name)).toContain('ponytail');

    const body = readFileSync(skillFile, 'utf8');
    expect(body).toContain('name: ponytail');
    expect(body).toContain('Does this need to exist?');
    expect(body).toContain('lazy about the solution, never about reading');
    expect(body).toContain('Dietrich Gebert (MIT)');
  });
});
