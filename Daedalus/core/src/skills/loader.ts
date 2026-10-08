import { readdir, readFile, stat } from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, isAbsolute, join, resolve } from 'node:path';
import type { ToolDefinition } from '../tools/registry.ts';
import type { TaskDomain, ToolResult } from '../contracts.ts';

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

/**
 * Payload of the SKILL_LOADED event: a skill body entered a task's
 * context. Emitted once per actual load — a `read_skill` tool call that
 * returned the body (`via: 'agent'`) or a forced user invocation resolved
 * at run start (`via: 'user'`). Repeat-suppressed `read_skill` calls do
 * not re-emit: the body never re-entered the context.
 */
export type SkillLoadedPayload = {
  /** Skill name as the loader knows it. */
  name: string;
  /** Where the winning copy lives. */
  origin: SkillOrigin;
  via: 'agent' | 'user';
  /** Skills root the winning copy was loaded from. */
  source?: string;
};

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

/**
 * One skill found on disk, for inventory surfaces (Settings, `skills list`).
 * Unlike `SkillInfo` this keeps every copy: when several roots provide the
 * same name, the first (highest precedence) copy wins and later copies are
 * marked `shadowedBy` the winner's skills root instead of vanishing.
 */
export type SkillInventoryEntry = SkillInfo & {
  /** Absolute path of this copy's SKILL.md. */
  path: string;
  /** Skills root of the winning same-name copy, when this copy is shadowed. */
  /** Set on a shadowed duplicate: the origin of the copy that won. */
  shadowedBy?: SkillOrigin;
  /** True when the workspace config disables this name (winners only matter; a disabled name never loads). */
  disabled: boolean;
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
  /**
   * Skill names the workspace config disables. They are excluded from the
   * registry itself; the names ride along so `read_skill` can answer
   * "disabled for this workspace" instead of "unknown skill".
   */
  readonly disabledNames: ReadonlySet<string>;

  constructor(skills: Skill[] = [], disabledNames: Iterable<string> = []) {
    for (const skill of skills) {
      if (!this.#skills.has(skill.name)) this.#skills.set(skill.name, skill);
    }
    this.disabledNames = new Set(disabledNames);
  }

  list(): SkillInfo[] {
    return [...this.#skills.values()].map(({ name, description, source, origin }) => ({ name, description, source, origin }));
  }

  get(name: string): Skill | undefined {
    return this.#skills.get(name);
  }

  /** True when `name` exists on disk but the workspace config disables it. */
  isDisabled(name: string): boolean {
    return this.disabledNames.has(name);
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

/**
 * Scan tagged skill directories (`<dir>/<name>/SKILL.md`) once, producing
 * both the loadable registry and the full inventory. Search order is
 * precedence order: the first copy of a name wins the registry, later
 * copies are reported in the inventory as shadowed. Names the workspace
 * config disables are excluded from the registry (and from `read_skill`)
 * outright — disabling a name disables the skill, so a shadowed same-name
 * copy elsewhere never resurrects it; the inventory still shows every copy
 * with its `disabled` flag so UIs can offer to re-enable.
 */
async function scanSkillDirs(
  searchDirs: SkillSearchDir[],
  disabledNames: Iterable<string> = [],
): Promise<{ registry: SkillRegistry; inventory: SkillInventoryEntry[] }> {
  const disabled = new Set(disabledNames);
  const skills: Skill[] = [];
  const inventory: SkillInventoryEntry[] = [];
  const seenDirs = new Set<string>();
  const winners = new Map<string, Skill>();
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
        const winner = winners.get(parsed.name);
        inventory.push({
          name: parsed.name,
          description: parsed.description,
          source: dir,
          origin,
          path: skillPath,
          disabled: disabled.has(parsed.name),
          ...(winner ? { shadowedBy: winner.origin } : {}),
        });
        if (winner) continue;
        const skill: Skill = { name: parsed.name, description: parsed.description, source: dir, origin, body: parsed.body, path: skillPath };
        winners.set(parsed.name, skill);
        if (!disabled.has(parsed.name)) skills.push(skill);
      } catch {
        continue;
      }
    }
  }
  return { registry: new SkillRegistry(skills, disabled), inventory };
}

/**
 * Load skills from directories scanned in order (first skill with a given
 * name wins). Bare string entries are plain directories tagged `workspace`;
 * pass `SkillSearchDir` entries to tag another origin. `disabledNames`
 * (the workspace config's disabled list) are excluded before anything else
 * sees the registry — the prompt index, `read_skill`, and forced
 * invocations all read the same filtered registry.
 */
export async function loadSkills(
  dirs: Array<string | SkillSearchDir>,
  options?: { disabledNames?: Iterable<string> },
): Promise<SkillRegistry> {
  const { registry } = await scanSkillDirs(
    dirs.map((entry) => (typeof entry === 'string' ? { dir: entry, origin: 'workspace' as SkillOrigin } : entry)),
    options?.disabledNames ?? [],
  );
  return registry;
}

/**
 * Every skill copy on disk (winners and shadowed duplicates), for
 * inventory surfaces that must show what exists, what is disabled, and
 * what is shadowed — none of which the loadable registry retains.
 */
export async function loadSkillInventory(
  dirs: Array<string | SkillSearchDir>,
  options?: { disabledNames?: Iterable<string> },
): Promise<SkillInventoryEntry[]> {
  const { inventory } = await scanSkillDirs(
    dirs.map((entry) => (typeof entry === 'string' ? { dir: entry, origin: 'workspace' as SkillOrigin } : entry)),
    options?.disabledNames ?? [],
  );
  return inventory;
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

/**
 * Presentation-maker skill detection, deliberately generic (never a
 * hard-coded skill name): a name/description reading as a slide,
 * presentation, PowerPoint, Keynote, ppt/pptx, or deck builder. The
 * Slide domain uses it to keep external presentation skills out of the
 * prompt index and to redirect `read_skill` at the built-in deck tools.
 */
const PRESENTATION_SKILL_PATTERN = /slide|slides|presentation|powerpoint|keynote|\bpptx?\b|\bdeck\b/;

export function isPresentationSkill(name: string, description?: string): boolean {
  return PRESENTATION_SKILL_PATTERN.test(`${name} ${description ?? ''}`.toLowerCase());
}

const MAX_SKILL_OUTPUT = 16_000;

/**
 * Render a skill's body the way `read_skill` returns it (16K cap, honest
 * truncation marker). Shared with the runtime's forced-invocation carriage
 * so a skill the user invokes reads exactly like one the agent loads.
 */
export function renderSkillBody(skill: Skill): { text: string; truncated: boolean } {
  const truncated = skill.body.length > MAX_SKILL_OUTPUT;
  const body = truncated ? `${skill.body.slice(0, MAX_SKILL_OUTPUT)}\n…[truncated]` : skill.body;
  return { text: `# Skill: ${skill.name}\n${skill.description ? `${skill.description}\n\n` : ''}${body}`, truncated };
}

/** Read-only tool letting the agent load a skill's full instructions on demand. */
export function createReadSkillTool(registry: SkillRegistry, options?: { domain?: TaskDomain }): ToolDefinition {
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
      // Slide domain: a presentation-maker skill is never loaded — the
      // built-in deck tools are the only presentation surface (see
      // SLIDE_DOMAIN_PROMPT). The redirect carries no `skill` meta, so
      // it never emits SKILL_LOADED: no skill body entered the context.
      if (options?.domain === 'slide' && isPresentationSkill(name, skill?.description)) {
        return {
          call_id: '',
          status: 'ok',
          output: `Skill "${name}" was not loaded: in the Slide domain, external presentation skills are not used — build the deck with the built-in deck tools only: create_deck → add_slide (outline first, one slide per outline item) → validate_deck → export_deck.`,
          truncated: false,
          meta: { redirected_skill: name, reason: 'slide_domain' },
        };
      }
      if (!skill) {
        // A name the workspace config disables is not in the registry at
        // all; say so plainly instead of reporting it as unknown, so the
        // model (and the user reading the log) knows it exists but is off.
        if (registry.isDisabled(name)) {
          return {
            call_id: '',
            status: 'error',
            output: `Skill "${name}" is disabled for this workspace (.daedalus/skills.json). It was not loaded. Re-enable it (Web Settings → Extensions, or \`daedalus skills enable ${name}\`) to use it.`,
            truncated: false,
            meta: { skill: name, disabled: true },
          };
        }
        const names = dedupeSkillsByName(registry.list()).map((item) => item.name);
        return {
          call_id: '',
          status: 'error',
          output: `Unknown skill: ${name}. Available skills: ${names.length ? names.join(', ') : '(none)'}.`,
          truncated: false,
          meta: {},
        };
      }
      const rendered = renderSkillBody(skill);
      return {
        call_id: '',
        status: 'ok',
        output: rendered.text,
        truncated: rendered.truncated,
        meta: { skill: skill.name, source: skill.source, origin: skill.origin },
      };
    },
  };
}

export function skillNameFromDir(path: string): string {
  return basename(path);
}
