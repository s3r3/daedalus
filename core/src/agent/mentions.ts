import { open, readdir, stat, type FileHandle } from 'node:fs/promises';
import { resolve, sep } from 'node:path';
import { IGNORED_DIRECTORY_NAMES } from '../tools/filesystem/index.ts';

/**
 * @-mentions in task goals (Claude Code / OpenCode pattern): the user types
 * `@path` in the composer or CLI and the harness — not the model — resolves
 * the reference, inlining the file's contents (or a directory's shallow
 * listing) into the system prompt. Resolution lives in core so the CLI and
 * the Web behave identically; surfaces only complete the path text.
 *
 * Caps mirror the pinned-files discipline in context.ts: a per-file excerpt
 * cap, a mention-count cap, and one total budget, each with an honest
 * truncation note. Unresolvable mentions degrade to a one-line note — they
 * never fail the task.
 */
export const MAX_MENTION_PATHS = 8;
export const MAX_MENTION_FILE_CHARS = 6_000;
export const MAX_MENTION_TOTAL_CHARS = 24_000;
export const MAX_MENTION_DIR_ENTRIES = 40;
/** Raw bytes read per file before decoding: comfortably above the char cap even for 4-byte UTF-8. */
const MENTION_READ_BYTES = 64 * 1024;

/**
 * A mention token: `@` at the start of the goal or right after whitespace,
 * followed by path characters. `foo@bar` (e-mail style) does not match.
 * Trailing sentence punctuation (`@file.ts.` at the end of a sentence) is
 * stripped; the path character class already excludes `,` and `)`.
 */
const MENTION_PATTERN = /(?:^|\s)@([A-Za-z0-9._/-]+)/g;
const TRAILING_PUNCTUATION = /[.,)]+$/;

/** Extract the deduplicated, order-preserving @-paths mentioned in a goal. */
export function extractMentionPaths(goal: string): string[] {
  const seen = new Set<string>();
  const paths: string[] = [];
  for (const match of goal.matchAll(MENTION_PATTERN)) {
    const path = match[1]!.replace(TRAILING_PUNCTUATION, '');
    if (!path || path === '.' || path === '..') continue;
    if (seen.has(path)) continue;
    seen.add(path);
    paths.push(path);
  }
  return paths;
}

/**
 * Resolve every @-mention in `goal` against `workspaceRoot` and render the
 * prompt section. Returns `undefined` when the goal mentions nothing, so a
 * mention-free goal produces a byte-identical prompt. Never throws.
 */
export async function resolveMentionSection(workspaceRoot: string, goal: string): Promise<string | undefined> {
  const paths = extractMentionPaths(goal);
  if (paths.length === 0 || !workspaceRoot) return undefined;
  const root = resolve(workspaceRoot);
  const shown = paths.slice(0, MAX_MENTION_PATHS);
  const lines: string[] = ['Referenced with @ in the prompt (contents resolved from the workspace):'];
  let used = 0;
  let budgetCapped = false;
  for (const path of shown) {
    const block = await mentionBlock(root, path);
    if (used + block.length > MAX_MENTION_TOTAL_CHARS) {
      const room = MAX_MENTION_TOTAL_CHARS - used;
      if (room > 200) lines.push(block.slice(0, room));
      budgetCapped = true;
      break;
    }
    used += block.length;
    lines.push(block);
  }
  if (paths.length > shown.length) {
    lines.push(`… (${paths.length - shown.length} more @ reference(s) omitted — only the first ${MAX_MENTION_PATHS} are included)`);
  }
  if (budgetCapped) {
    lines.push(`… (@-referenced contents truncated at ${MAX_MENTION_TOTAL_CHARS} chars total)`);
  }
  return lines.join('\n');
}

async function mentionBlock(root: string, mention: string): Promise<string> {
  const header = `@${mention}`;
  const absolute = resolve(root, mention);
  if (absolute !== root && !absolute.startsWith(root + sep)) {
    return `${header}: (outside the workspace — not included)`;
  }
  let info;
  try {
    info = await stat(absolute);
  } catch {
    return `${header}: (not found in the workspace)`;
  }
  if (info.isDirectory()) return directoryBlock(header, absolute);
  const excerpt = await readExcerpt(absolute);
  if (!excerpt) return `${header}: (could not be read)`;
  if (excerpt.binary) return `${header}: (binary file — contents not included)`;
  const tail = excerpt.truncated ? `\n… (file truncated: showing the first ${MAX_MENTION_FILE_CHARS} chars)` : '';
  return `${header}:\n\`\`\`\n${excerpt.text}\n\`\`\`${tail}`;
}

async function directoryBlock(header: string, absolute: string): Promise<string> {
  try {
    const entries = (await readdir(absolute, { withFileTypes: true }))
      .filter((entry) => !(entry.isDirectory() && IGNORED_DIRECTORY_NAMES.has(entry.name)))
      .sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name));
    const shown = entries.slice(0, MAX_MENTION_DIR_ENTRIES);
    const body = shown.map((entry) => `- ${entry.name}${entry.isDirectory() ? '/' : ''}`).join('\n') || '(empty directory)';
    const tail = entries.length > shown.length ? `\n… (${entries.length - shown.length} more entries)` : '';
    return `${header} (directory listing, shallow):\n${body}${tail}`;
  } catch {
    return `${header}: (directory could not be read)`;
  }
}

async function readExcerpt(absolute: string): Promise<{ binary: boolean; text: string; truncated: boolean } | undefined> {
  let handle: FileHandle | undefined;
  try {
    handle = await open(absolute, 'r');
    const info = await handle.stat();
    const wanted = Math.min(info.size, MENTION_READ_BYTES);
    const buffer = Buffer.alloc(wanted);
    const { bytesRead } = await handle.read(buffer, 0, wanted, 0);
    const slice = buffer.subarray(0, bytesRead);
    if (slice.includes(0)) return { binary: true, text: '', truncated: false };
    const text = slice.toString('utf8');
    return {
      binary: false,
      text: text.slice(0, MAX_MENTION_FILE_CHARS),
      truncated: text.length > MAX_MENTION_FILE_CHARS || info.size > bytesRead,
    };
  } catch {
    return undefined;
  } finally {
    await handle?.close().catch(() => undefined);
  }
}
