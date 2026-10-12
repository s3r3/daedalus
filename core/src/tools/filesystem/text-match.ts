/**
 * Whitespace-tolerant block matching for the edit tools (the Crush /
 * Aider lenient-apply pattern). Byte-exact matching stays the first
 * choice — it is unambiguous — but when a model's anchor differs only
 * in indentation (the classic weak-model slip: it re-indents the block
 * it copied), the exact search reports "not found" and the step is
 * wasted re-reading. Here the same lines are matched modulo surrounding
 * whitespace; the replacement is re-indented onto the file's own
 * indentation, and the caller tells the model the tolerance fired so it
 * can re-check its mental copy of the file.
 *
 * Deliberately conservative: the candidate window must match on EVERY
 * line (trimmed) and must be UNIQUE. Anything else is a miss, and the
 * strict error path runs.
 */

export type TolerantMatch = {
  /** 0-based index of the first matched line in the file. */
  startLine: number;
  /** Number of file lines the matched window spans. */
  lineCount: number;
  /** The file window, exactly as it appears on disk. */
  matchedText: string;
};

function splitLines(text: string): string[] {
  const lines = text.split('\n');
  // A trailing newline produces a phantom empty final element; it is not
  // a line the author "wrote", so drop it for window purposes.
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  return lines;
}

/**
 * Find `search` inside `content` allowing per-line surrounding-whitespace
 * differences. Returns the unique match or undefined (zero or several).
 */
export function findWhitespaceTolerantMatch(content: string, search: string): TolerantMatch | undefined {
  if (!search) return undefined;
  const fileLines = splitLines(content);
  const searchLines = splitLines(search);
  if (searchLines.length === 0 || searchLines.length > fileLines.length) return undefined;
  const wanted = searchLines.map((line) => line.trim());
  // A search made only of blank lines can "match" anywhere; refuse.
  if (wanted.every((line) => line === '')) return undefined;
  let found: TolerantMatch | undefined;
  for (let start = 0; start + searchLines.length <= fileLines.length; start++) {
    let matches = true;
    for (let offset = 0; offset < searchLines.length; offset++) {
      if ((fileLines[start + offset] ?? '').trim() !== wanted[offset]) { matches = false; break; }
    }
    if (!matches) continue;
    if (found) return undefined; // second candidate: not unique
    found = {
      startLine: start,
      lineCount: searchLines.length,
      matchedText: fileLines.slice(start, start + searchLines.length).join('\n'),
    };
  }
  return found;
}

/**
 * Re-indent replacement lines authored against `search`'s indentation
 * onto the file's actual indentation (from the matched window). Only
 * the common prefix shift is applied; mixed tab/space shifts leave the
 * replacement exactly as authored.
 */
export function reindentReplacement(replacement: string, search: string, matchedText: string): string {
  const searchLines = splitLines(search);
  const matchedLines = splitLines(matchedText);
  const firstContent = searchLines.findIndex((line) => line.trim() !== '');
  if (firstContent < 0) return replacement;
  const searchIndent = /^\s*/.exec(searchLines[firstContent] ?? '')?.[0] ?? '';
  const fileIndent = /^\s*/.exec(matchedLines[firstContent] ?? '')?.[0] ?? '';
  if (searchIndent === fileIndent) return replacement;
  const lines = replacement.split('\n');
  if (fileIndent.startsWith(searchIndent)) {
    const prefix = fileIndent.slice(searchIndent.length);
    return lines.map((line) => (line.trim() === '' ? line : prefix + line)).join('\n');
  }
  if (searchIndent.startsWith(fileIndent)) {
    const strip = searchIndent.slice(fileIndent.length);
    return lines.map((line) => (line.startsWith(strip) ? line.slice(strip.length) : line)).join('\n');
  }
  return replacement;
}

export type TolerantApplied = {
  content: string;
  /** 1-based line where the applied window starts in the new content. */
  startLine: number;
  matchedText: string;
};

/** Apply a whitespace-tolerant replacement; undefined when there is no unique tolerant match. */
export function applyWhitespaceTolerant(content: string, search: string, replacement: string): TolerantApplied | undefined {
  const match = findWhitespaceTolerantMatch(content, search);
  if (!match) return undefined;
  const lines = content.split('\n');
  const adjusted = reindentReplacement(replacement, search, match.matchedText);
  lines.splice(match.startLine, match.lineCount, ...adjusted.split('\n'));
  return { content: lines.join('\n'), startLine: match.startLine + 1, matchedText: match.matchedText };
}
