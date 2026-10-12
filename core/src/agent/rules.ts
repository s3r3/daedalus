import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

/**
 * Project rules (rules-file / microagent concept): standing instructions a
 * workspace ships for the agent. Loaded once per run, in priority order —
 * workspace files first, then the user-level `AGENTS.md` from the resolved
 * Daedalus home. When several exist they are concatenated in that order,
 * each under its own header, and injected into the system prompt as a
 * "Project rules" section.
 *
 * `AGENTS.md` is the cross-tool standard file (the same plain-Markdown file
 * other agents read), so a workspace `AGENTS.md` is honoured first-class at
 * the workspace level, and `<daedalusHome>/AGENTS.md` acts as the user's
 * global rules across all workspaces.
 */
export const PROJECT_RULES_FILES = ['.daedalus/RULES.md', 'AGENTS.md', '.daedalus/rules.md'] as const;

/** Label used in `files` / prompt headers for the user-level rules file. */
export const GLOBAL_RULES_LABEL = 'AGENTS.md (global)';

export const MAX_RULES_CHARS = 8_000;

export type ProjectRules = {
  /** Workspace-relative paths (plus the global label) that contributed rules, in priority order. */
  files: string[];
  /** Combined rules text (already capped); empty when no rules file exists. */
  text: string;
  truncated: boolean;
};

export type ProjectRulesOptions = {
  /**
   * Resolved Daedalus home; its `AGENTS.md` is loaded last as user-level
   * rules. Omit (or leave the file absent) for workspace-only behaviour.
   */
  globalHome?: string;
};

export async function loadProjectRules(workspaceRoot: string, options: ProjectRulesOptions = {}): Promise<ProjectRules> {
  const files: string[] = [];
  const chunks: string[] = [];
  for (const relative of PROJECT_RULES_FILES) {
    let content: string;
    try {
      content = await readFile(join(workspaceRoot, relative), 'utf8');
    } catch {
      continue;
    }
    const trimmed = content.trim();
    if (!trimmed) continue;
    files.push(relative);
    chunks.push(`## Rules from ${relative}\n${trimmed}`);
  }
  if (options.globalHome) {
    try {
      const content = await readFile(join(options.globalHome, 'AGENTS.md'), 'utf8');
      const trimmed = content.trim();
      if (trimmed) {
        files.push(GLOBAL_RULES_LABEL);
        chunks.push(`## Rules from ${GLOBAL_RULES_LABEL}\n${trimmed}`);
      }
    } catch {
      // No global rules file: workspace-only behaviour, as before.
    }
  }
  if (files.length === 0) return { files: [], text: '', truncated: false };
  const combined = chunks.join('\n\n');
  if (combined.length <= MAX_RULES_CHARS) return { files, text: combined, truncated: false };
  return {
    files,
    text: `${combined.slice(0, MAX_RULES_CHARS)}\n…[project rules truncated at ${MAX_RULES_CHARS} chars]`,
    truncated: true,
  };
}
