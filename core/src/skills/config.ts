import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

/**
 * Per-workspace skill state (`.daedalus/skills.json`): the one piece of
 * skill configuration that is the user's, not a skill author's. Today it
 * carries only the disabled list; the shape is a small JSON object so
 * future per-workspace knobs can join without a format break.
 *
 * Disabling is by NAME: a disabled name never loads for this workspace,
 * regardless of which directory provides it, and a shadowed same-name copy
 * elsewhere never resurrects it. The loader applies the list before the
 * prompt index is built, so disabled skills also free index slots.
 *
 * The file is shared state: the core runtime reads it on every run, the
 * Web gateway toggles it through the same helpers, and the CLI's
 * `skills enable|disable` writes it — one file, three readers, no drift.
 * A missing or corrupt file degrades to "everything enabled": broken
 * local state must never crash a task or hide every skill.
 */

export const SKILLS_CONFIG_RELATIVE_PATH = '.daedalus/skills.json';

export type SkillConfig = {
  /** Skill names disabled for this workspace, deduplicated, order-stable. */
  disabled: string[];
};

/** Absolute path of the workspace's skills config file. */
export function skillsConfigPath(workspaceRoot: string): string {
  return join(workspaceRoot, SKILLS_CONFIG_RELATIVE_PATH);
}

/** Parse config file text; anything unusable degrades to all-enabled. */
export function parseSkillConfig(raw: string): SkillConfig {
  try {
    const parsed = JSON.parse(raw) as { disabled?: unknown };
    if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.disabled)) return { disabled: [] };
    const seen = new Set<string>();
    const disabled: string[] = [];
    for (const entry of parsed.disabled) {
      if (typeof entry !== 'string') continue;
      const name = entry.trim();
      if (!name || seen.has(name)) continue;
      seen.add(name);
      disabled.push(name);
    }
    return { disabled };
  } catch {
    return { disabled: [] };
  }
}

/** Load the workspace's skill config; a missing/corrupt file means all-enabled. */
export async function loadSkillConfig(workspaceRoot: string): Promise<SkillConfig> {
  try {
    return parseSkillConfig(await readFile(skillsConfigPath(workspaceRoot), 'utf8'));
  } catch {
    return { disabled: [] };
  }
}

/** Persist the config (pretty JSON, `.daedalus/` created on demand). */
export async function writeSkillConfig(workspaceRoot: string, config: SkillConfig): Promise<SkillConfig> {
  const path = skillsConfigPath(workspaceRoot);
  const normalized: SkillConfig = { disabled: [...new Set(config.disabled.map((name) => name.trim()).filter(Boolean))] };
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(normalized, null, 2)}\n`, 'utf8');
  return normalized;
}

/**
 * Enable or disable one skill name for a workspace, returning the
 * resulting config. Names are matched exactly (skill names are the
 * loader's identity); unknown names are still recorded, so disabling a
 * skill before installing it keeps it off when it appears.
 */
export async function setSkillDisabled(workspaceRoot: string, name: string, disabled: boolean): Promise<SkillConfig> {
  const trimmed = name.trim();
  if (!trimmed) throw new Error('a skill name is required');
  const config = await loadSkillConfig(workspaceRoot);
  const next = disabled
    ? config.disabled.includes(trimmed)
      ? config.disabled
      : [...config.disabled, trimmed]
    : config.disabled.filter((entry) => entry !== trimmed);
  return writeSkillConfig(workspaceRoot, { disabled: next });
}
