/** A1 cell addressing — pure, browser-safe (the Web grid parses/formats refs with these). */

const CELL_REF_RE = /^(\$?)([A-Za-z]{1,3})(\$?)([0-9]{1,7})$/;

export function colToIndex(col: string): number {
  let n = 0;
  for (const ch of col.toUpperCase()) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}

export function indexToCol(index: number): string {
  let n = index + 1;
  let out = '';
  while (n > 0) {
    const rem = (n - 1) % 26;
    out = String.fromCharCode(65 + rem) + out;
    n = Math.floor((n - 1) / 26);
  }
  return out;
}

export type CellRef = { col: number; row: number; colAbs: boolean; rowAbs: boolean };

/** Parse an A1 ref ('B2', '$B$2'); rows are 1-based in text, 0-based here. */
export function parseCellRef(text: string): CellRef | null {
  const match = CELL_REF_RE.exec(text.trim());
  if (!match) return null;
  return {
    col: colToIndex(match[2] as string),
    row: Number(match[4]) - 1,
    colAbs: match[1] === '$',
    rowAbs: match[3] === '$',
  };
}

export function formatCellRef(col: number, row: number, colAbs = false, rowAbs = false): string {
  return `${colAbs ? '$' : ''}${indexToCol(col)}${rowAbs ? '$' : ''}${row + 1}`;
}

export type RangeRef = { start: CellRef; end: CellRef };

/** Parse 'A1' or 'A1:B9'. */
export function parseRange(text: string): RangeRef | null {
  const parts = text.trim().split(':');
  if (parts.length === 1) {
    const single = parseCellRef(parts[0] as string);
    return single ? { start: single, end: single } : null;
  }
  if (parts.length !== 2) return null;
  const start = parseCellRef(parts[0] as string);
  const end = parseCellRef(parts[1] as string);
  if (!start || !end) return null;
  return { start, end };
}


/** First-row header labels by column index. */
export function sheetHeaders(sheet: { cells: Record<string, { v?: unknown }> }): Map<number, string> {
  const headers = new Map<number, string>();
  for (const [key, cell] of Object.entries(sheet.cells)) {
    const ref = parseCellRef(key);
    if (!ref || ref.row !== 0) continue;
    if (typeof cell.v === 'string' && cell.v.trim()) headers.set(ref.col, cell.v.trim());
  }
  return headers;
}
