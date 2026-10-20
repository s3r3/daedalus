import { execFile } from 'node:child_process';
import type { Message } from '../providers/llm/types.ts';
import type { LLMProvider } from '../providers/index.ts';

/**
 * Code review (the `/review` slash command): a one-shot, read-only pass
 * over a diff. No tool registry is built and no loop runs — the configured
 * provider answers a single review prompt built from the diff and the
 * project rules, and its Markdown findings are printed as-is. All review
 * prompts flow through here so every surface (CLI, Web) gets the same
 * behaviour and the same diff caps.
 */

export const MAX_REVIEW_DIFF_CHARS = 40_000;

export type ReviewFinding = {
  severity: 'high' | 'medium' | 'low';
  file: string;
  line?: number;
  message: string;
};

export type ReviewResult = {
  findings: ReviewFinding[];
  /** The model's raw Markdown, for surfaces that render it directly. */
  raw: string;
  source: 'task-diff' | 'unstaged' | 'provided';
  truncated: boolean;
};

/** Tools the reviewer may conceptually use — all read-only; exported for tests. */
export const REVIEW_READ_ONLY_TOOLS = ['read_file', 'read_skill', 'lsp_diagnostics'] as const;

/** `git diff` of the unstaged changes in a workspace ('' when clean or not a repo). */
export async function unstagedDiff(workspaceRoot: string): Promise<string> {
  return new Promise((resolvePromise) => {
    execFile('git', ['diff', '--no-color'], { cwd: workspaceRoot, maxBuffer: 32 * 1024 * 1024 }, (error, stdout) => {
      resolvePromise(error ? '' : String(stdout));
    });
  });
}

export function buildReviewMessages(options: {
  diff: string;
  rulesText?: string;
  truncated: boolean;
}): Message[] {
  const rules = options.rulesText?.trim()
    ? `\nProject rules (the review must flag violations of these):\n${options.rulesText.trim()}\n`
    : '';
  const prompt = [
    'You are a senior code reviewer. Review the following unified diff.',
    rules,
    'Report only real problems: correctness bugs, security issues, data-loss risks, and clear violations of the project rules above. Do not comment on formatting, naming taste, or speculative improvements.',
    '',
    'Reply with a Markdown list. Each finding is one list item in exactly this shape:',
    '- **[severity] path/to/file:line** — message',
    "where severity is one of high, medium, low; the line number is the diff hunk's new-side line when you can tell.",
    'If the diff has no real problems, reply with exactly: No findings.',
    options.truncated ? `\nNote: the diff was truncated at ${MAX_REVIEW_DIFF_CHARS} characters; review what is shown.` : '',
    '',
    '```diff',
    options.diff.slice(0, MAX_REVIEW_DIFF_CHARS),
    '```',
  ].join('\n');
  return [
    { role: 'system', content: 'You review code diffs read-only. You never edit files and never run commands.' },
    { role: 'user', content: prompt },
  ];
}

const FINDING_PATTERN = /^[-*]\s+\*\*\[(high|medium|low)\]\s+([^*:]+?)(?::(\d+))?\*\*\s*[—–-]\s*(.+)$/im;

/** Parse the structured finding lines out of the model's Markdown reply. */
export function parseReviewFindings(raw: string): ReviewFinding[] {
  const findings: ReviewFinding[] = [];
  for (const line of raw.split('\n')) {
    const match = FINDING_PATTERN.exec(line.trim());
    if (!match) continue;
    findings.push({
      severity: match[1]!.toLowerCase() as ReviewFinding['severity'],
      file: match[2]!.trim(),
      ...(match[3] ? { line: Number(match[3]) } : {}),
      message: match[4]!.trim(),
    });
  }
  return findings;
}

function messageText(content: Message['content']): string {
  if (typeof content === 'string') return content;
  return content.map((block) => (block.type === 'text' ? block.text : '')).join('');
}

/**
 * Run one read-only review pass: cap the diff, ask the provider once, and
 * parse the structured findings. Never mutates anything. The provider is
 * pre-bound to its model by the caller (settings or provider registry).
 */
export async function reviewDiff(options: {
  provider: LLMProvider;
  diff: string;
  rulesText?: string;
  source: ReviewResult['source'];
}): Promise<ReviewResult> {
  const truncated = options.diff.length > MAX_REVIEW_DIFF_CHARS;
  const messages = buildReviewMessages({ diff: options.diff, rulesText: options.rulesText, truncated });
  const response = await options.provider.chat(messages);
  const raw = messageText(response.message.content).trim();
  return { findings: parseReviewFindings(raw), raw, source: options.source, truncated };
}
