/**
 * Dependency-free line diff used to emit FILE_CHANGED evidence for the UI
 * (diff viewer) and the final report. LCS-based, unified-ish ` ` / `-` / `+`
 * lines with 0 lines of context trimming: enough for an MVP change review.
 */

export type DiffLine = { kind: 'context' | 'add' | 'remove'; text: string };

const MAX_DIFF_LINES = 2000;

export function diffLines(before: string, after: string): DiffLine[] {
  const a = splitLines(before);
  const b = splitLines(after);
  if (a.length === 0 && b.length === 0) return [];

  const lcs: number[][] = Array.from({ length: a.length + 1 }, () => new Array<number>(b.length + 1).fill(0));
  for (let i = a.length - 1; i >= 0; i--) {
    const row = lcs[i];
    const next = lcs[i + 1];
    if (!row || !next) continue;
    for (let j = b.length - 1; j >= 0; j--) {
      row[j] = a[i] === b[j] ? (next[j + 1] ?? 0) + 1 : Math.max(next[j] ?? 0, row[j + 1] ?? 0);
    }
  }

  const out: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      out.push({ kind: 'context', text: a[i] ?? '' });
      i++;
      j++;
    } else if ((lcs[i + 1]?.[j] ?? 0) >= (lcs[i]?.[j + 1] ?? 0)) {
      out.push({ kind: 'remove', text: a[i] ?? '' });
      i++;
    } else {
      out.push({ kind: 'add', text: b[j] ?? '' });
      j++;
    }
    if (out.length >= MAX_DIFF_LINES) {
      out.push({ kind: 'context', text: `…[diff truncated at ${MAX_DIFF_LINES} lines]` });
      break;
    }
  }
  while (i < a.length) out.push({ kind: 'remove', text: a[i++] ?? '' });
  while (j < b.length) out.push({ kind: 'add', text: b[j++] ?? '' });

  // Identical content (or pure context) means "no change" for the UI/report.
  return out.some((line) => line.kind !== 'context') ? out : [];
}

export function changedLineCounts(lines: DiffLine[]): { added: number; removed: number } {
  let added = 0;
  let removed = 0;
  for (const line of lines) {
    if (line.kind === 'add') added++;
    else if (line.kind === 'remove') removed++;
  }
  return { added, removed };
}

/** Render a unified-diff style patch body (no `@@` hunks; MVP review view). */
export function renderPatch(path: string, lines: DiffLine[]): string {
  if (lines.length === 0) return '';
  const counts = changedLineCounts(lines);
  const body = lines.map((line) => `${line.kind === 'add' ? '+' : line.kind === 'remove' ? '-' : ' '}${line.text}`).join('\n');
  return `--- a/${path}\n+++ b/${path}\n@@ +${counts.added} -${counts.removed} @@\n${body}\n`;
}

function splitLines(text: string): string[] {
  if (text === '') return [];
  const normalized = text.replace(/\r\n/g, '\n');
  const lines = normalized.split('\n');
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  return lines;
}