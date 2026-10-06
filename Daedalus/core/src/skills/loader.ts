import { readdir, readFile, stat } from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, isAbsolute, join, resolve } from 'node:path';
import type { ToolDefinition } from '../tools/registry.ts';
import type { ToolResult } from '../contracts.ts';

/**
 * Skills are playbook folders: `<dir>/<name>/SKILL.md` with a minimal YAML
 * frontmatter block (`name`, `description`) followed by Markdown instructions.
 * The registry only stores what was actually found on disk — the CLI sidebar
 * and the agent context both read from it, so a skill is only ever advertised
 * when it really exists.
 *
 * Skill directory resolution (highest precedence first; the first directory
 * providing a given skill name wins):
 *   1. Workspace: `<workspace>/.daedalus/skills` (origin `workspace`).
 *   2. Daedalus global (origin `global`): `$DAEDALUS_HOME/skills` when
 *      DAEDALUS_HOME is set to an absolute path (an explicit global override),
 *      otherwise `~/.daedalus/skills`. Applies to every workspace.
 *   3. `$DAEDALUS_SKILLS_DIR` when set (origin `global`): one extra
 *      Daedalus-managed directory.
 *   4. Other AI tools' global skill directories (read-only detection; the
 *      same `<name>/SKILL.md` layout): `~/.claude/skills` (`claude`),
 *      `$CODEX_HOME/skills` or `~/.codex/skills` (`codex`),
 *      `~/.config/opencode/skills` then `~/.opencode/skills` (`opencode`),
 *      `~/.kilocode/skills` (`kilo`).
 * Missing directories are skipped silently, so a machine without any of
 * these tools simply detects fewer skills.
 */

export type SkillOrigin = 'workspace' | 'global' | 'claude' | 'codex' | 'opencode' | 'kilo';

export type SkillInfo = {
  name: string;
  description: string;
  /** Directory the skill was loaded from (the skills root, parent of `<name>/`). */
  source: string;
  /** Where the skill came from: this workspace, a Daedalus global dir, or another AI tool's global dir. */
  origin: SkillOrigin;
};

export type Skill = SkillInfo & { body: string; path: string };

/** A skills root directory to scan, tagged with the origin its skills get. */
export type SkillSearchDir = {
  dir: string;
  origin: SkillOrigin;
};

/** Inputs for skill-directory resolution; injectable so tests can use a fake HOME. */
export type SkillDirOptions = {
  env?: Record<string, string | undefined>;
  homeDir?: string;
};

/** Human label for an origin, e.g. `global · claude` for a Claude Code skill. */
export function formatSkillOrigin(origin: SkillOrigin): string {
  switch (origin) {
    case 'workspace':
      return 'workspace';
    case 'global':
      return 'global';
    default:
      return `global · ${origin}`;
  }
}

export class SkillRegistry {
  readonly #skills = new Map<string, Skill>();

  constructor(skills: Skill[] = []) {
    for (const skill of skills) {
      if (!this.#skills.has(skill.name)) this.#skills.set(skill.name, skill);
    }
  }

  list(): SkillInfo[] {
    return [...this.#skills.values()].map(({ name, description, source, origin }) => ({ name, description, source, origin }));
  }

  get(name: string): Skill | undefined {
    return this.#skills.get(name);
  }

  get size(): number {
    return this.#skills.size;
  }
}

export const WORKSPACE_SKILLS_RELATIVE_PATH = '.daedalus/skills';

/** Parse the small `key: value` frontmatter subset Daedalus skills use. */
export function parseSkillMarkdown(raw: string, fallbackName: string): { name: string; description: string; body: string } {
  const normalized = raw.replace(/^\uFEFF/, '');
  let name = fallbackName;
  let description = '';
  let body = normalized.trim();
  if (normalized.startsWith('---')) {
    const end = normalized.indexOf('\n---', 3);
    if (end > 0) {
      const frontmatter = normalized.slice(3, end);
      body = normalized.slice(end + 4).trim();
      for (const line of frontmatter.split('\n')) {
        const match = /^\s*([A-Za-z0-9_-]+)\s*:\s*(.*)$/.exec(line);
        if (!match) continue;
        const value = (match[2] ?? '').trim().replace(/^['"]|['"]$/g, '');
        if (match[1] === 'name' && value) name = value;
        if (match[1] === 'description' && value) description = value;
      }
    }
  }
  if (!description) {
    const firstLine = body.split('\n').map((line) => line.replace(/^#+\s*/, '').trim()).find((line) => line.length > 0);
    description = firstLine ?? '';
  }
  return { name, description, body };
}

/** Skills advertised inline in the prompt/tool surface before the "+N more" line. */
export const MAX_SKILLS_IN_PROMPT = 40;

/**
 * Dedupe a skills list by name, first occurrence winning and order
 * preserved. The prompt surface uses this even for lists that did not pass
 * through a SkillRegistry, so a skill can never be advertised twice.
 */
export function dedupeSkillsByName(skills: SkillInfo[]): SkillInfo[] {
  const seen = new Set<string>();
  return skills.filter((skill) => {
    if (seen.has(skill.name)) return false;
    seen.add(skill.name);
    return true;
  });
}

/** Canonical directory key: symlinks resolved, so one physical skills root is only ever scanned once. */
function canonicalDirKey(dir: string): string {
  try {
    return realpathSync(dir);
  } catch {
    return resolve(dir);
  }
}

/** Scan tagged skill directories (`<dir>/<name>/SKILL.md`); first name wins, missing dirs are fine. */
async function scanSkillDirs(searchDirs: SkillSearchDir[]): Promise<SkillRegistry> {
  const skills: Skill[] = [];
  const seenDirs = new Set<string>();
  const seenNames = new Set<string>();
  for (const { dir, origin } of searchDirs) {
    const key = canonicalDirKey(dir);
    if (seenDirs.has(key)) continue;
    seenDirs.add(key);
    let entries: Array<{ name: string; isDirectory: () => boolean }> = [];
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const skillPath = join(dir, entry.name, 'SKILL.md');
      try {
        const info = await stat(skillPath);
        if (!info.isFile()) continue;
        const raw = await readFile(skillPath, 'utf8');
        const parsed = parseSkillMarkdown(raw, entry.name);
        // First occurrence of a name wins (search order is precedence
        // order); later same-name copies are never collected at all.
        if (seenNames.has(parsed.name)) continue;
        seenNames.add(parsed.name);
        skills.push({ name: parsed.name, description: parsed.description, source: dir, origin, body: parsed.body, path: skillPath });
      } catch {
        continue;
      }
    }
  }
  return new SkillRegistry(skills);
}

/**
 * Load skills from directories scanned in order (first skill with a given
 * name wins). Bare string entries are plain directories tagged `workspace`;
 * pass `SkillSearchDir` entries to tag another origin.
 */
export async function loadSkills(dirs: Array<string | SkillSearchDir>): Promise<SkillRegistry> {
  return scanSkillDirs(dirs.map((entry) => (typeof entry === 'string' ? { dir: entry, origin: 'workspace' as SkillOrigin } : entry)));
}

/** The default per-workspace skills directory for a workspace root. */
export function workspaceSkillsDir(workspaceRoot: string): string {
  return join(workspaceRoot, WORKSPACE_SKILLS_RELATIVE_PATH);
}

function resolveHomeDir(options?: SkillDirOptions): string {
  return options?.homeDir ?? homedir();
}

/**
 * The Daedalus-global skills directory: `$DAEDALUS_HOME/skills` when
 * DAEDALUS_HOME is an absolute path (an explicit global override), otherwise
 * `~/.daedalus/skills`. A relative DAEDALUS_HOME is a per-workspace state
 * root, never a global anchor.
 */
export function daedalusGlobalSkillsDir(options?: SkillDirOptions): string {
  const env = options?.env ?? process.env;
  const configured = env.DAEDALUS_HOME?.trim();
  if (configured && isAbsolute(configured)) return join(configured, 'skills');
  return join(resolveHomeDir(options), '.daedalus', 'skills');
}

/**
 * Every global skill directory in precedence order (after the workspace dir):
 * the Daedalus global dir, `$DAEDALUS_SKILLS_DIR`, then the other-AI-tool
 * directories. Only directories that exist are ever scanned, but all resolved
 * candidates are returned so callers can show exactly what was searched.
 */
export function globalSkillSearchDirs(options?: SkillDirOptions): SkillSearchDir[] {
  const env = options?.env ?? process.env;
  const home = resolveHomeDir(options);
  const dirs: SkillSearchDir[] = [{ dir: daedalusGlobalSkillsDir(options), origin: 'global' }];

  const extra = env.DAEDALUS_SKILLS_DIR?.trim();
  if (extra) dirs.push({ dir: extra, origin: 'global' });

  dirs.push({ dir: join(home, '.claude', 'skills'), origin: 'claude' });

  const codexHome = env.CODEX_HOME?.trim();
  dirs.push({ dir: codexHome ? join(codexHome, 'skills') : join(home, '.codex', 'skills'), origin: 'codex' });

  dirs.push({ dir: join(home, '.config', 'opencode', 'skills'), origin: 'opencode' });
  dirs.push({ dir: join(home, '.opencode', 'skills'), origin: 'opencode' });

  dirs.push({ dir: join(home, '.kilocode', 'skills'), origin: 'kilo' });

  const seen = new Set<string>();
  return dirs.filter(({ dir }) => {
    const key = resolve(dir);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/**
 * The full skill search path for a workspace: its own `.daedalus/skills`
 * first (workspace skills shadow same-name globals), then every global
 * directory. Feed the result to `loadSkills`.
 */
export function resolveSkillSearchDirs(workspaceRoot: string, options?: SkillDirOptions): SkillSearchDir[] {
  return [{ dir: workspaceSkillsDir(workspaceRoot), origin: 'workspace' }, ...globalSkillSearchDirs(options)];
}

const MAX_SKILL_OUTPUT = 16_000;

/** Read-only tool letting the agent load a skill's full instructions on demand. */
export function createReadSkillTool(registry: SkillRegistry): ToolDefinition {
  const listed = dedupeSkillsByName(registry.list());
  const shownNames = listed.slice(0, MAX_SKILLS_IN_PROMPT).map((skill) => skill.name);
  const available = listed.length
    ? `${shownNames.join(', ')}${listed.length > shownNames.length ? `, …and ${listed.length - shownNames.length} more (call read_skill with the skill name)` : ''}`
    : '';
  return {
    name: 'read_skill',
    description: available
      ? `Load the full instructions of an available skill by name. Available skills: ${available}.`
      : 'Load the full instructions of an available skill by name.',
    inputSchema: {
      type: 'object',
      required: ['name'],
      properties: { name: { type: 'string', description: 'Skill name from the available skills list.' } },
      additionalProperties: false,
    },
    mutating: false,
    async execute(args): Promise<ToolResult> {
      const name = (args as { name?: unknown })?.name;
      if (typeof name !== 'string' || !name) {
        return { call_id: '', status: 'error', output: 'read_skill requires a string "name".', truncated: false, meta: {} };
      }
      const skill = registry.get(name);
      if (!skill) {
        const names = dedupeSkillsByName(registry.list()).map((item) => item.name);
        return {
          call_id: '',
          status: 'error',
          output: `Unknown skill: ${name}. Available skills: ${names.length ? names.join(', ') : '(none)'}.`,
          truncated: false,
          meta: {},
        };
      }
      const body = skill.body.length > MAX_SKILL_OUTPUT ? `${skill.body.slice(0, MAX_SKILL_OUTPUT)}\n…[truncated]` : skill.body;
      return {
        call_id: '',
        status: 'ok',
        output: `# Skill: ${skill.name}\n${skill.description ? `${skill.description}\n\n` : ''}${body}`,
        truncated: skill.body.length > MAX_SKILL_OUTPUT,
        meta: { skill: skill.name, source: skill.source, origin: skill.origin },
      };
    },
  };
}

export function skillNameFromDir(path: string): string {
  return basename(path);
}
