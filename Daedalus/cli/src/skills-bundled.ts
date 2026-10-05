import { cp, readdir, readFile, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadSkills, workspaceSkillsDir } from '@daedalus/core';

/**
 * Bundled starter skills (Daedalus/skills/ in the repo — original content,
 * installed on demand with `daedalus skills install`). They ship as data,
 * not code: installing copies a skill folder into the workspace's
 * `.daedalus/skills/`, where the core skills loader picks it up next run.
 * The loader keeps first-wins precedence by name, so a workspace copy
 * always wins over any same-name folder added later.
 */

/** Directory holding the starter skills bundled with this build. */
export function bundledSkillsDir(): string {
  return join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'skills');
}

export type BundledSkill = {
  name: string;
  description: string;
  /** Absolute path of the bundled skill folder. */
  dir: string;
};

export type InstalledSkill = {
  name: string;
  description: string;
  /** Absolute path of the workspace skill folder. */
  dir: string;
};

export type SkillsListing = {
  bundled: BundledSkill[];
  installed: InstalledSkill[];
  bundledDir: string;
  workspaceDir: string;
};

export type InstallResult = {
  installed: string[];
  skipped: Array<{ name: string; reason: string }>;
};

function skillDescription(raw: string): string {
  const match = /^description\s*:\s*(.+)$/m.exec(raw);
  return match?.[1]?.trim().replace(/^['"]|['"]$/g, '') ?? '';
}

/** Scan a skills root (`<root>/<name>/SKILL.md`) without opening the core loader. */
async function scanSkills(root: string): Promise<Array<{ name: string; description: string; dir: string }>> {
  const found: Array<{ name: string; description: string; dir: string }> = [];
  let entries: Array<{ name: string; isDirectory: () => boolean }> = [];
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch {
    return found;
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const dir = join(root, entry.name);
    const skillFile = join(dir, 'SKILL.md');
    if (!existsSync(skillFile)) continue;
    let description = '';
    try {
      description = skillDescription(await readFile(skillFile, 'utf8'));
    } catch {
      description = '';
    }
    found.push({ name: entry.name, description, dir });
  }
  return found.sort((a, b) => a.name.localeCompare(b.name));
}

export async function listSkills(options: { workspaceRoot: string }): Promise<SkillsListing> {
  const bundledDir = bundledSkillsDir();
  const workspaceDir = workspaceSkillsDir(options.workspaceRoot);
  const [bundled, installedRegistry] = await Promise.all([
    scanSkills(bundledDir),
    loadSkills([workspaceDir]),
  ]);
  return {
    bundled,
    installed: installedRegistry.list().map((skill) => ({ name: skill.name, description: skill.description, dir: skill.source })),
    bundledDir,
    workspaceDir,
  };
}

/**
 * Copy bundled skills into `<workspace>/.daedalus/skills/`. A same-name
 * skill that is already installed is never overwritten unless `force` is
 * set — the existing copy is reported back as skipped with its provenance.
 */
export async function installBundledSkills(options: {
  workspaceRoot: string;
  names?: string[];
  all?: boolean;
  force?: boolean;
}): Promise<InstallResult> {
  const bundledDir = bundledSkillsDir();
  const bundled = await scanSkills(bundledDir);
  if (bundled.length === 0) {
    throw new Error(`no bundled skills found at ${bundledDir}; this install of Daedalus does not ship starter skills`);
  }
  const byName = new Map(bundled.map((skill) => [skill.name, skill]));
  const requested = options.all ? bundled.map((skill) => skill.name) : (options.names ?? []);
  if (requested.length === 0) {
    throw new Error('name at least one bundled skill to install, or pass --all');
  }
  const workspaceDir = workspaceSkillsDir(options.workspaceRoot);
  const existing = new Map((await scanSkills(workspaceDir)).map((skill) => [skill.name, skill]));
  // Core loader precedence is first-wins by name; a bundled install must
  // not shadow or duplicate a workspace skill the user already has.
  const installedNames = new Set((await loadSkills([workspaceDir])).list().map((skill) => skill.name));

  const result: InstallResult = { installed: [], skipped: [] };
  for (const name of requested) {
    const skill = byName.get(name);
    if (!skill) {
      result.skipped.push({ name, reason: 'not a bundled skill' });
      continue;
    }
    const prior = existing.get(name);
    if ((prior || installedNames.has(name)) && !options.force) {
      result.skipped.push({ name, reason: `already installed at ${prior?.dir ?? workspaceDir}; use --force to overwrite` });
      continue;
    }
    const target = join(workspaceDir, name);
    const info = await stat(target).catch(() => undefined);
    if (info && !options.force) {
      result.skipped.push({ name, reason: `already installed at ${target}; use --force to overwrite` });
      continue;
    }
    await cp(skill.dir, target, { recursive: true, force: options.force === true });
    result.installed.push(name);
  }
  return result;
}

export function formatSkillsListing(listing: SkillsListing): string {
  const lines: string[] = [];
  lines.push(`Bundled starter skills (${listing.bundledDir}):`);
  if (listing.bundled.length === 0) lines.push('  (none shipped with this build)');
  for (const skill of listing.bundled) lines.push(`  ${skill.name} — ${skill.description || '(no description)'}`);
  lines.push(`Installed in this workspace (${listing.workspaceDir}):`);
  if (listing.installed.length === 0) lines.push('  (none)');
  for (const skill of listing.installed) lines.push(`  ${skill.name} — ${skill.description || '(no description)'}`);
  return lines.join('\n');
}
