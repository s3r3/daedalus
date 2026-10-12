import { mkdtempSync, writeFileSync, readFileSync, existsSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import {
  bundledSkillsDir,
  daedalusGlobalSkillsDir,
  ensureBundledSkillsInstalled,
  loadSkills,
  parseSkillMarkdown,
} from '../src/skills/index.ts';
import { readdirSync, statSync } from 'node:fs';

/** Every file under the bundled skills dir must be Markdown (data, not code). */
function allBundledFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...allBundledFiles(full));
    else out.push(full);
  }
  return out;
}

describe('bundled permanent skills', () => {
  test('bundledSkillsDir resolves to the repo Daedalus/skills with SKILL.md files', () => {
    const dir = bundledSkillsDir();
    expect(existsSync(join(dir, 'ponytail', 'SKILL.md'))).toBe(true);
    expect(existsSync(join(dir, 'anti-slop', 'SKILL.md'))).toBe(true);
    for (const name of ['test-driven-development', 'systematic-debugging', 'code-review']) {
      expect(existsSync(join(dir, name, 'SKILL.md'))).toBe(true);
    }
  });

  test('every bundled file is Markdown (zero dependencies, zero code)', () => {
    for (const file of allBundledFiles(bundledSkillsDir())) {
      expect(file.endsWith('.md')).toBe(true);
    }
  });

  test('bundled skill bodies carry no external-fetch instructions', () => {
    const fetchy = /(^|\s)(curl\s+-[a-zA-Z]+|wget\s|npx\s+\S+\s+install|npm\s+install\s+-g|git\s+clone\s+https?)/m;
    for (const file of allBundledFiles(bundledSkillsDir())) {
      const body = readFileSync(file, 'utf8');
      expect(fetchy.test(body), file).toBe(false);
    }
  });

  test('every bundled SKILL.md parses with a name and description', () => {
    for (const file of allBundledFiles(bundledSkillsDir())) {
      if (!file.endsWith('SKILL.md')) continue;
      const parsed = parseSkillMarkdown(readFileSync(file, 'utf8'), 'fallback');
      expect(parsed.name.length).toBeGreaterThan(0);
      expect(parsed.description.length).toBeGreaterThan(0);
      expect(parsed.body.length).toBeGreaterThan(100);
    }
  });
});

describe('ensureBundledSkillsInstalled', () => {
  function fakeHome(): string {
    return mkdtempSync(join(tmpdir(), 'daedalus-skills-test-'));
  }

  test('installs missing bundled skills into the global dir with origin global', async () => {
    const home = fakeHome();
    const result = await ensureBundledSkillsInstalled({ homeDir: home });
    expect(result.installed.length).toBeGreaterThan(0);
    expect(result.installed).toContain('anti-slop');
    expect(result.installed).toContain('ponytail');
    const globalDir = daedalusGlobalSkillsDir({ homeDir: home });
    expect(result.targetDir).toBe(globalDir);
    const registry = await loadSkills([{ dir: globalDir, origin: 'global' }]);
    for (const name of ['anti-slop', 'ponytail', 'test-driven-development', 'systematic-debugging', 'code-review']) {
      expect(registry.get(name)?.origin).toBe('global');
    }
  });

  test('is idempotent: second run installs nothing', async () => {
    const home = fakeHome();
    const first = await ensureBundledSkillsInstalled({ homeDir: home });
    expect(first.installed.length).toBeGreaterThan(0);
    const second = await ensureBundledSkillsInstalled({ homeDir: home });
    expect(second.installed).toEqual([]);
    expect(second.skipped.length).toBe(first.installed.length);
  });

  test('never overwrites an existing same-name skill', async () => {
    const home = fakeHome();
    const globalDir = daedalusGlobalSkillsDir({ homeDir: home });
    mkdirSync(join(globalDir, 'ponytail'), { recursive: true });
    writeFileSync(join(globalDir, 'ponytail', 'SKILL.md'), '---\nname: ponytail\ndescription: user copy\n---\nuser content');
    const result = await ensureBundledSkillsInstalled({ homeDir: home });
    expect(result.installed).not.toContain('ponytail');
    expect(result.skipped).toContain('ponytail');
    expect(readFileSync(join(globalDir, 'ponytail', 'SKILL.md'), 'utf8')).toContain('user content');
  });

  test('autoInstall:false is a no-op', async () => {
    const home = fakeHome();
    const result = await ensureBundledSkillsInstalled({ homeDir: home, autoInstall: false });
    expect(result.installed).toEqual([]);
    expect(existsSync(daedalusGlobalSkillsDir({ homeDir: home }))).toBe(false);
  });

  test('disabled names still exclude skills from the registry', async () => {
    const home = fakeHome();
    await ensureBundledSkillsInstalled({ homeDir: home });
    const registry = await loadSkills([{ dir: daedalusGlobalSkillsDir({ homeDir: home }), origin: 'global' }], {
      disabledNames: ['anti-slop'],
    });
    expect(registry.get('anti-slop')).toBeUndefined();
    expect(registry.isDisabled('anti-slop')).toBe(true);
    expect(registry.get('ponytail')).toBeDefined();
  });
});
