import { readdir, readFile, stat } from 'node:fs/promises';
import { basename, join } from 'node:path';
import type { ToolDefinition } from '../tools/registry.ts';
import type { ToolResult } from '../contracts.ts';

export type SkillInfo = {
  name: string;
  description: string;
  /** Directory the skill was loaded from (the SKILL.md parent). */
  source: string;
};

export type Skill = SkillInfo & { body: string; path: string };

/**
 * Skills are playbook folders: `<dir>/<name>/SKILL.md` with a minimal YAML
 * frontmatter block (`name`, `description`) followed by Markdown instructions.
 * The registry only stores what was actually found on disk — the CLI sidebar
 * and the agent context both read from it, so a skill is only ever advertised
 * when it really exists.
 */
export class SkillRegistry {
  readonly #skills = new Map<string, Skill>();

  constructor(skills: Skill[] = []) {
    for (const skill of skills) {
      if (!this.#skills.has(skill.name)) this.#skills.set(skill.name, skill);
    }
  }

  list(): SkillInfo[] {
    return [...this.#skills.values()].map(({ name, description, source }) => ({ name, description, source }));
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

/** Scan skill directories (`<dir>/<name>/SKILL.md`); missing dirs are fine. */
export async function loadSkills(dirs: string[]): Promise<SkillRegistry> {
  const skills: Skill[] = [];
  for (const dir of dirs) {
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
        skills.push({ name: parsed.name, description: parsed.description, source: dir, body: parsed.body, path: skillPath });
      } catch {
        continue;
      }
    }
  }
  return new SkillRegistry(skills);
}

/** The default per-workspace skills directory for a workspace root. */
export function workspaceSkillsDir(workspaceRoot: string): string {
  return join(workspaceRoot, WORKSPACE_SKILLS_RELATIVE_PATH);
}

const MAX_SKILL_OUTPUT = 16_000;

/** Read-only tool letting the agent load a skill's full instructions on demand. */
export function createReadSkillTool(registry: SkillRegistry): ToolDefinition {
  const available = registry.list().map((skill) => skill.name).join(', ');
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
        const names = registry.list().map((item) => item.name);
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
        meta: { skill: skill.name, source: skill.source },
      };
    },
  };
}

export function skillNameFromDir(path: string): string {
  return basename(path);
}
