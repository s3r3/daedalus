import { cp, readdir, readFile, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  daedalusGlobalSkillsDir,
  formatSkillOrigin,
  loadSkills,
  resolveSkillSearchDirs,
  workspaceSkillsDir,
  type SkillDirOptions,
  type SkillOrigin,
} from '@daedalus/core';

/**
 * Bundled starter skills (Daedalus/skills/ in the repo — original content,
 * installed on demand with `daedalus skills install`). They ship as data,
 * not code: installing copies a skill folder into a skills directory, where
 * the core skills loader picks it up next run.
 *
 * Detection mirrors the core loader's resolution: the workspace's
 * `.daedalus/skills/` first, then the global directories (the Daedalus
 * global dir, `$DAEDALUS_SKILLS_DIR`, and the other-AI-tool skill folders),
 * first skill with a given name winning. `daedalus skills list` prints every
 * detected skill with its origin plus the exact directories searched, so a
 * skill that is not picked up can be traced to placement.
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

/** A skill the core loader would detect for this workspace, with its origin. */
export type DetectedSkill = {
  name: string;
  description: string;
  origin: SkillOrigin;
  /** Skills root the skill was loaded from. */
  dir: string;
};

/** One directory in the skill search path, in precedence order. */
export type SearchedSkillDir = {
  dir: string;
  origin: SkillOrigin;
  exists: boolean;
};

export type SkillsListing = {
  bundled: BundledSkill[];
  /** Skills installed in this workspace only (origin `workspace`). */
  installed: InstalledSkill[];
  /** Every detected skill: workspace + all global sources. */
  detected: DetectedSkill[];
  /** Directories searched for skills, highest precedence first. */
  searchedDirs: SearchedSkillDir[];
  bundledDir: string;
  workspaceDir: string;
  /** The Daedalus-global skills directory (`--global` installs land here). */
  globalDir: string;
};

export type InstallResult = {
  installed: string[];
  skipped: Array<{ name: string; reason: string }>;
  /** Directory the skills were installed into. */
  targetDir: string;
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

export async function listSkills(options: { workspaceRoot: string } & SkillDirOptions): Promise<SkillsListing> {
  const bundledDir = bundledSkillsDir();
  const workspaceDir = workspaceSkillsDir(options.workspaceRoot);
  const searchDirs = resolveSkillSearchDirs(options.workspaceRoot, options);
  const [bundled, registry] = await Promise.all([scanSkills(bundledDir), loadSkills(searchDirs)]);
  const detected: DetectedSkill[] = registry
    .list()
    .map((skill) => ({ name: skill.name, description: skill.description, origin: skill.origin, dir: skill.source }))
    .sort((a, b) => a.name.localeCompare(b.name));
  return {
    bundled,
    installed: detected
      .filter((skill) => skill.origin === 'workspace')
      .map((skill) => ({ name: skill.name, description: skill.description, dir: skill.dir })),
    detected,
    searchedDirs: searchDirs.map((entry) => ({ dir: entry.dir, origin: entry.origin, exists: existsSync(entry.dir) })),
    bundledDir,
    workspaceDir,
    globalDir: daedalusGlobalSkillsDir(options),
  };
}

/**
 * Copy bundled skills into a skills directory: `<workspace>/.daedalus/skills/`
 * by default, or the Daedalus-global skills directory with `global: true`
 * (usable from every workspace; the other tools' directories are read-only
 * detection and are never written to). A same-name skill already present in
 * the target directory is never overwritten unless `force` is set — the
 * existing copy is reported back as skipped with its provenance.
 */
export async function installBundledSkills(
  options: {
    workspaceRoot: string;
    names?: string[];
    all?: boolean;
    force?: boolean;
    /** Install into the Daedalus-global skills directory instead of the workspace. */
    global?: boolean;
  } & SkillDirOptions,
): Promise<InstallResult> {
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
  const targetDir = options.global ? daedalusGlobalSkillsDir(options) : workspaceSkillsDir(options.workspaceRoot);
  const existing = new Map((await scanSkills(targetDir)).map((skill) => [skill.name, skill]));
  // Core loader precedence is first-wins by name; a bundled install must
  // not shadow or duplicate a skill already present in the target directory.
  const installedNames = new Set((await loadSkills([targetDir])).list().map((skill) => skill.name));

  const result: InstallResult = { installed: [], skipped: [], targetDir };
  for (const name of requested) {
    const skill = byName.get(name);
    if (!skill) {
      result.skipped.push({ name, reason: 'not a bundled skill' });
      continue;
    }
    const prior = existing.get(name);
    if ((prior || installedNames.has(name)) && !options.force) {
      result.skipped.push({ name, reason: `already installed at ${prior?.dir ?? targetDir}; use --force to overwrite` });
      continue;
    }
    const target = join(targetDir, name);
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
  lines.push('Detected skills (workspace + global; available to the agent in every workspace):');
  if (listing.detected.length === 0) lines.push('  (none)');
  for (const skill of listing.detected) {
    lines.push(`  ${skill.name} (${formatSkillOrigin(skill.origin)}) — ${skill.description || '(no description)'}`);
  }
  lines.push('Skill directories searched (highest precedence first; first skill with a given name wins):');
  for (const entry of listing.searchedDirs) {
    lines.push(`  ${entry.dir} (${formatSkillOrigin(entry.origin)})${entry.exists ? '' : ' — not present'}`);
  }
  return lines.join('\n');
}
