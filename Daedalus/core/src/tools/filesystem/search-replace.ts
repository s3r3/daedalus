/**
 * Aider-style SEARCH/REPLACE edit blocks (tailor suite `edit_format:
 * search_replace`). Weak models mangle structured `{old_string, new_string}`
 * JSON arguments but can imitate a text block format from examples; Aider's
 * published results show the block dialect materially raises edit success.
 * Semantics are deliberately strict:
 *
 * - Each block is `<<<<<<< SEARCH` / anchor / `=======` / replacement /
 *   `>>>>>>> REPLACE`.
 * - The anchor must match the file content EXACTLY (byte-for-byte) and
 *   EXACTLY ONCE at its position in the block sequence. When the exact
 *   match misses, ONE fallback runs: a unique whitespace-tolerant match
 *   (same lines modulo indentation; the replacement is re-indented onto
 *   the file's indentation and the result flags that it fired). There is
 *   no other fuzzy matching: anything else fails the whole call (nothing
 *   is written) with an instructive error, because a silently mis-applied
 *   edit is worse than a loud failure.
 */

import { applyWhitespaceTolerant } from './text-match.ts';

export type SearchReplaceBlock = { search: string; replace: string };

export type ParsedSearchReplace =
  | { blocks: SearchReplaceBlock[] }
  | { error: string };

const SEARCH_MARKER = /^<{7,}\s*SEARCH\s*$/;
const DIVIDER_MARKER = /^={7,}\s*$/;
const REPLACE_MARKER = /^>{7,}\s*REPLACE\s*$/;

export function parseSearchReplaceBlocks(text: string): ParsedSearchReplace {
  const lines = text.split("\n");
  const blocks: SearchReplaceBlock[] = [];
  let index = 0;
  const skipBlank = (): void => {
    while (index < lines.length && (lines[index] ?? "").trim() === "") index++;
  };
  skipBlank();
  while (index < lines.length) {
    if (!SEARCH_MARKER.test((lines[index] ?? "").trim())) {
      return { error: `expected a "<<<<<<< SEARCH" line at block ${blocks.length + 1}, found "${(lines[index] ?? "").trim().slice(0, 80)}"` };
    }
    index++;
    const searchLines: string[] = [];
    while (index < lines.length && !DIVIDER_MARKER.test((lines[index] ?? "").trim())) {
      searchLines.push(lines[index]!);
      index++;
    }
    if (index >= lines.length) return { error: `block ${blocks.length + 1}: missing the "=======" divider line` };
    index++;
    const replaceLines: string[] = [];
    while (index < lines.length && !REPLACE_MARKER.test((lines[index] ?? "").trim())) {
      replaceLines.push(lines[index]!);
      index++;
    }
    if (index >= lines.length) return { error: `block ${blocks.length + 1}: missing the ">>>>>>> REPLACE" line` };
    index++;
    blocks.push({ search: searchLines.join("\n"), replace: replaceLines.join("\n") });
    skipBlank();
  }
  if (blocks.length === 0) {
    return { error: 'no SEARCH/REPLACE blocks found; emit at least one "<<<<<<< SEARCH … ======= … >>>>>>> REPLACE" block' };
  }
  return { blocks };
}

export type AppliedSearchReplace =
  | { content: string; applied: number; tolerant: number }
  | { error: string };

/**
 * Apply blocks sequentially to `content`. Any failure aborts before any
 * write: the caller returns the error and the file on disk is untouched.
 */
export function applySearchReplace(content: string, text: string, path: string): AppliedSearchReplace {
  const parsed = parseSearchReplaceBlocks(text);
  if ("error" in parsed) {
    return { error: `could not parse SEARCH/REPLACE blocks for ${path}: ${parsed.error}. Emit blocks exactly as:\n<<<<<<< SEARCH\n<exact lines already in the file>\n=======\n<the replacement lines>\n>>>>>>> REPLACE` };
  }
  let current = content;
  let tolerant = 0;
  for (const [position, block] of parsed.blocks.entries()) {
    const label = `SEARCH block ${position + 1} of ${parsed.blocks.length} for ${path}`;
    if (block.search.length === 0) {
      return { error: `${label}: the SEARCH anchor is empty. Copy the exact lines you want to replace from the file (use read_file to see current content); an empty anchor cannot be matched safely.` };
    }
    const occurrences = current.split(block.search).length - 1;
    if (occurrences === 0) {
      // One lenient fallback (unique, same lines modulo indentation);
      // the result reports it so the model knows tolerance fired.
      const relaxed = applyWhitespaceTolerant(current, block.search, block.replace);
      if (relaxed) {
        current = relaxed.content;
        tolerant++;
        continue;
      }
      return { error: `${label}: anchor matched 0 times — not byte-exact, and no unique whitespace-tolerant match either. Re-read ${path} with read_file and copy the anchor exactly; do not paraphrase or reformat it.` };
    }
    if (occurrences > 1) {
      return { error: `${label}: anchor matched ${occurrences} times — it must be unique. Add surrounding lines to the SEARCH anchor until it appears exactly once in ${path}.` };
    }
    // Function replacer: `$` sequences in file content (template literals)
    // must be inserted literally, not read as replacement patterns.
    current = current.replace(block.search, () => block.replace);
  }
  return { content: current, applied: parsed.blocks.length, tolerant };
}
