import { readdir, readFile, stat } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { AGENT_MODES, type AgentMode } from '../contracts.ts';

/**
 * File-defined subagents: one Markdown file per agent under
 * `<workspace>/.daedalus/agents/<name>.md`, with a small frontmatter block
 * (`name`, `description`, optional `model`, `mode`, and a `tools` allowlist)
 * followed by the instructions that become the subagent's extra system
 * prompt. Definitions are data, not code — the orchestrator simply runs a
 * child task with the named agent's model/mode/tool allowlist/instructions
 * applied — and naming an agent that does not exist is a clear error, never
 * a silent fallback to a default agent.
 */

export const WORKSPACE_AGENTS_RELATIVE_PATH = '.daedalus/agents';

export type AgentDefinition = {
  name: string;
  description: string;
  /** Model override for runs of this subagent; undefined inherits the session model. */
  model?: string;
  /** Mode override; undefined inherits the child task's mode. */
  mode?: AgentMode;
  /** Tool allowlist; undefined means every tool the child's mode makes visible. */
  tools?: string[];
  /** The Markdown body: the subagent's standing instructions. */
  instructions: string;
  /** Absolute path of the `.md` file the definition was loaded from. */
  source: string;
};

export class AgentRegistry {
  readonly #agents = new Map<string, AgentDefinition>();

  constructor(agents: AgentDefinition[] = []) {
    for (const agent of agents) {
      if (!this.#agents.has(agent.name)) this.#agents.set(agent.name, agent);
    }
  }

  list(): AgentDefinition[] {
    return [...this.#agents.values()];
  }

  get(name: string): AgentDefinition | undefined {
    return this.#agents.get(name);
  }

  get size(): number {
    return this.#agents.size;
  }
}

/** The default per-workspace subagent definitions directory. */
export function workspaceAgentsDir(workspaceRoot: string): string {
  return join(workspaceRoot, WORKSPACE_AGENTS_RELATIVE_PATH);
}

type ParsedAgent = Omit<AgentDefinition, 'source'>;

/**
 * Parse the small frontmatter subset agent files use, following the same
 * shape as the skills parser: `key: value` scalars, plus a `tools` list
 * written inline (`[a, b]` or `a, b`) or as `- item` lines under the key.
 */
export function parseAgentMarkdown(raw: string, fallbackName: string): ParsedAgent {
  const normalized = raw.replace(/^\uFEFF/, '');
  let body = normalized.trim();
  const fields = new Map<string, string>();
  const tools: string[] = [];
  if (normalized.startsWith('---')) {
    const end = normalized.indexOf('\n---', 3);
    if (end > 0) {
      const frontmatter = normalized.slice(3, end);
      body = normalized.slice(end + 4).trim();
      let collectingTools = false;
      for (const line of frontmatter.split('\n')) {
        const item = /^\s*-\s+(.+)$/.exec(line);
        if (item && collectingTools) {
          const value = item[1]!.trim().replace(/^['"]|['"]$/g, '');
          if (value) tools.push(value);
          continue;
        }
        const match = /^\s*([A-Za-z0-9_-]+)\s*:\s*(.*)$/.exec(line);
        if (!match) {
          collectingTools = false;
          continue;
        }
        const key = match[1]!;
        const value = (match[2] ?? '').trim().replace(/^['"]|['"]$/g, '');
        collectingTools = key === 'tools';
        if (key === 'tools') {
          for (const part of value.replace(/^\[/, '').replace(/\]$/, '').split(',')) {
            const name = part.trim().replace(/^['"]|['"]$/g, '');
            if (name) tools.push(name);
          }
        } else if (value) {
          fields.set(key, value);
        }
      }
    }
  }
  const name = fields.get('name') || fallbackName;
  let description = fields.get('description') ?? '';
  if (!description) {
    const firstLine = body.split('\n').map((line) => line.replace(/^#+\s*/, '').trim()).find((line) => line.length > 0);
    description = firstLine ?? '';
  }
  const modeRaw = fields.get('mode');
  const mode = modeRaw === 'code' ? 'auto' : (modeRaw as AgentMode | undefined);
  return {
    name,
    description,
    ...(fields.get('model') ? { model: fields.get('model') } : {}),
    ...(mode && AGENT_MODES.includes(mode) ? { mode } : {}),
    ...(tools.length ? { tools } : {}),
    instructions: body,
  };
}

/** Scan agent definition directories (`<dir>/<name>.md`); missing dirs are fine. */
export async function loadAgents(dirs: string[]): Promise<AgentRegistry> {
  const agents: AgentDefinition[] = [];
  for (const dir of dirs) {
    let entries: Array<{ name: string; isFile: () => boolean }> = [];
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.toLowerCase().endsWith('.md')) continue;
      const path = join(dir, entry.name);
      try {
        const info = await stat(path);
        if (!info.isFile()) continue;
        const raw = await readFile(path, 'utf8');
        const parsed = parseAgentMarkdown(raw, entry.name.replace(/\.md$/i, ''));
        agents.push({ ...parsed, source: path });
      } catch {
        continue;
      }
    }
  }
  return new AgentRegistry(agents);
}

export function agentNameFromPath(path: string): string {
  return basename(path).replace(/\.md$/i, '');
}
