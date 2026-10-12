import { randomUUID } from 'node:crypto';
import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  formatCellRef,
  parseCellRef,
  parseRange,
  sheetBounds,
  sheetHeaders,
  tileIssues,
  tileRefs,
  WORKBOOK_DIRNAME,
  WORKBOOK_FILENAME,
  MAX_CELLS_PER_SHEET,
  MAX_SHEETS,
  type SheetSpec,
  type WorkbookIssue,
  type WorkbookSpec,
} from './workbook.ts';

let idCounter = 0;
function uniqueId(prefix: string): string {
  idCounter += 1;
  try {
    return `${prefix}-${randomUUID().slice(0, 8)}`;
  } catch {
    return `${prefix}-${Date.now().toString(36)}-${idCounter}`;
  }
}

export function newWorkbookId(): string { return uniqueId('wb'); }
export function newSheetId(): string { return uniqueId('sheet'); }

export function newWorkbook(title: string, meta: { createdBy: string; model?: string }): WorkbookSpec {
  return {
    version: 1,
    id: newWorkbookId(),
    title,
    stage: 'blueprint',
    sheets: [],
    meta: { ...meta, createdAt: new Date().toISOString() },
  };
}

export function newSheet(name: string): SheetSpec {
  return { id: newSheetId(), name, cells: {} };
}

/**
 * Absolute paths of the workbook store under a workspace root.
 * Lives here (not in ./workbook.ts) because this module owns the
 * spreadsheet filesystem surface; workbook.ts stays node:-free so
 * the web bundle can import its pure helpers.
 */
export function workbookPaths(root: string): { dir: string; file: string } {
  const dir = join(root, WORKBOOK_DIRNAME);
  return { dir, file: join(dir, WORKBOOK_FILENAME) };
}

export async function ensureWorkbookDir(root: string): Promise<{ dir: string; file: string }> {
  const paths = workbookPaths(root);
  await mkdir(paths.dir, { recursive: true });
  return paths;
}

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function isWorkbookShape(v: unknown): v is WorkbookSpec {
  if (!isObj(v)) return false;
  if (v.version !== 1) return false;
  if (typeof v.id !== 'string' || typeof v.title !== 'string') return false;
  if (v.stage !== 'blueprint' && v.stage !== 'ready') return false;
  if (!Array.isArray(v.sheets)) return false;
  for (const s of v.sheets as unknown[]) {
    if (!isObj(s)) return false;
    if (typeof s.id !== 'string' || typeof s.name !== 'string') return false;
    if (!isObj(s.cells)) return false;
  }
  if (!isObj(v.meta) || typeof v.meta.createdBy !== 'string') return false;
  return true;
}

export async function readWorkbook(root: string): Promise<WorkbookSpec | null> {
  const paths = workbookPaths(root);
  let raw: string;
  try {
    raw = await readFile(paths.file, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(`workbook.json is not valid JSON (${paths.file}): ${err instanceof Error ? err.message : String(err)}`);
  }
  if (!isWorkbookShape(parsed)) {
    throw new Error(`workbook.json has an invalid shape (${paths.file}): expected {version:1, id, title, stage, sheets[], meta}`);
  }
  return parsed;
}

export async function writeWorkbook(root: string, workbook: WorkbookSpec): Promise<void> {
  const paths = await ensureWorkbookDir(root);
  const next = `${JSON.stringify(workbook, null, 2)}\n`;
  let previous: string | null = null;
  try {
    previous = await readFile(paths.file, 'utf8');
  } catch {
    previous = null;
  }
  const tmp = `${paths.file}.tmp-${process.pid}-${Date.now()}`;
  await writeFile(tmp, next, 'utf8');
  await rename(tmp, paths.file);
  // Checkpoint the previous state (never destructive): every persisted
  // change leaves its predecessor restorable under .daedalus/. History
  // is best-effort — a failed snapshot must never fail the save itself.
  if (previous !== null && previous !== next) {
    await snapshotWorkbookCheckpoint(root, previous).catch(() => {
      /* history is progressive enhancement, not the save path */
    });
  }
}

/**
 * Workbook checkpoints: previous states of workbook.json, kept under
 * `.daedalus/workbook-history/` (same hidden area as the deck and
 * workbook archives). The newest MAX_WORKBOOK_CHECKPOINTS are kept;
 * restore is never destructive because writeWorkbook snapshots the
 * current state first — the pre-restore workbook becomes a checkpoint
 * itself.
 */
export const MAX_WORKBOOK_CHECKPOINTS = 20;

export type WorkbookCheckpoint = {
  /** File basename inside .daedalus/workbook-history — the restore key. */
  name: string;
  /** ISO timestamp of the snapshot. */
  at: string;
  /** Bytes on disk. */
  size: number;
  /** Workbook title at snapshot time (best effort). */
  title: string | null;
  /** Sheet count at snapshot time. */
  sheets: number;
  /** Stage at snapshot time. */
  stage: string | null;
};

async function snapshotWorkbookCheckpoint(root: string, previousText: string): Promise<void> {
  const dir = join(root, '.daedalus', 'workbook-history');
  await mkdir(dir, { recursive: true });
  const name = `${Date.now()}-${randomUUID().slice(0, 6)}.json`;
  await writeFile(join(dir, name), previousText, 'utf8');
  const entries = (await readdir(dir)).filter((f) => f.endsWith('.json')).sort();
  for (const stale of entries.slice(0, Math.max(0, entries.length - MAX_WORKBOOK_CHECKPOINTS))) {
    await rm(join(dir, stale), { force: true });
  }
}

export async function listWorkbookCheckpoints(root: string): Promise<WorkbookCheckpoint[]> {
  const dir = join(root, '.daedalus', 'workbook-history');
  let entries: string[];
  try {
    entries = (await readdir(dir)).filter((f) => f.endsWith('.json')).sort().reverse();
  } catch {
    return [];
  }
  const out: WorkbookCheckpoint[] = [];
  for (const name of entries) {
    try {
      const full = join(dir, name);
      const fileStat = await stat(full);
      const parsed: unknown = JSON.parse(await readFile(full, 'utf8'));
      const ms = Number(name.split('-')[0]);
      out.push({
        name,
        at: Number.isFinite(ms) ? new Date(ms).toISOString() : new Date(fileStat.mtimeMs).toISOString(),
        size: fileStat.size,
        title: isObj(parsed) && typeof parsed.title === 'string' ? (parsed.title as string) : null,
        sheets: isObj(parsed) && Array.isArray(parsed.sheets) ? (parsed.sheets as unknown[]).length : 0,
        stage: isObj(parsed) && typeof parsed.stage === 'string' ? (parsed.stage as string) : null,
      });
    } catch {
      // Bad entry: tolerated and skipped, never breaks the listing.
    }
  }
  return out;
}

export async function restoreWorkbookCheckpoint(root: string, name: string): Promise<WorkbookSpec> {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*\.json$/.test(name) || name.includes('..')) {
    throw new Error('nama checkpoint tidak valid');
  }
  const full = join(root, '.daedalus', 'workbook-history', name);
  let raw: string;
  try {
    raw = await readFile(full, 'utf8');
  } catch {
    throw new Error('checkpoint tidak ditemukan');
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error('checkpoint rusak (bukan JSON valid)');
  }
  if (!isWorkbookShape(parsed)) {
    throw new Error('checkpoint bukan workbook yang valid');
  }
  // writeWorkbook snapshots the current state first — restoring is
  // never destructive: the pre-restore workbook stays in history.
  await writeWorkbook(root, parsed);
  return parsed;
}

/**
 * Structural validation of the source of truth. Errors are the ones the
 * canvas save and the edit-op seam refuse on; the evaluator separately
 * judges formula *results* (verify stage), which are not structural.
 */
export function validateWorkbook(workbook: WorkbookSpec): WorkbookIssue[] {
  const issues: WorkbookIssue[] = [];
  const err = (code: string, message: string, sheet?: string, cell?: string): void => {
    issues.push({ code, message, severity: 'error', ...(sheet ? { sheet } : {}), ...(cell ? { cell } : {}) });
  };
  if (!workbook || typeof workbook !== 'object') {
    return [{ code: 'invalid-workbook', message: 'workbook must be an object', severity: 'error' }];
  }
  if (workbook.version !== 1) err('invalid-version', `workbook version must be 1, got ${String(workbook.version)}`);
  if (typeof workbook.title !== 'string' || workbook.title.trim().length === 0) err('missing-title', 'workbook title is required');
  if (!Array.isArray(workbook.sheets)) {
    err('invalid-sheets', 'workbook sheets must be an array');
    return issues;
  }
  if (workbook.sheets.length > MAX_SHEETS) {
    issues.push({ code: 'too-many-sheets', message: `workbook has ${workbook.sheets.length} sheets (max ${MAX_SHEETS})`, severity: 'warning' });
  }
  if (workbook.sheets.length === 0) {
    issues.push({ code: 'empty-workbook', message: 'workbook has no sheets yet', severity: 'warning' });
  }

  const sheetNames = new Map<string, string>();
  for (const sheet of workbook.sheets) {
    if (typeof sheet.name !== 'string' || sheet.name.trim().length === 0) {
      err('missing-sheet-name', 'every sheet needs a non-empty name', sheet?.id);
      continue;
    }
    const key = sheet.name.toLowerCase();
    if (sheetNames.has(key)) err('duplicate-sheet-name', `sheet name "${sheet.name}" appears more than once`, sheet.name);
    else sheetNames.set(key, sheet.id);
    if (/[[\]:*?/\\]/.test(sheet.name)) err('invalid-sheet-name', `sheet name "${sheet.name}" contains characters Excel forbids ([]:*?/\\)`, sheet.name);
    if (sheet.name.length > 31) err('sheet-name-too-long', `sheet name "${sheet.name}" is ${sheet.name.length} chars (max 31)`, sheet.name);
  }

  for (const sheet of workbook.sheets) {
    const cells = sheet.cells ?? {};
    const count = Object.keys(cells).length;
    if (count > MAX_CELLS_PER_SHEET) {
      issues.push({ sheet: sheet.name, code: 'too-many-cells', message: `sheet ${sheet.name} has ${count} cells (max ${MAX_CELLS_PER_SHEET})`, severity: 'warning' });
    }
    for (const [refText, cell] of Object.entries(cells)) {
      const ref = parseCellRef(refText);
      if (!ref) {
        err('invalid-cell-ref', `cell key "${refText}" is not an A1 reference`, sheet.name, refText);
        continue;
      }
      if (!cell || typeof cell !== 'object' || Array.isArray(cell)) {
        err('invalid-cell', `cell ${refText} must be an object {v} or {f}`, sheet.name, refText);
        continue;
      }
      const hasValue = cell.v !== undefined;
      const hasFormula = typeof cell.f === 'string' && cell.f.length > 0;
      if (hasValue && hasFormula) {
        err('cell-value-and-formula', `cell ${refText} carries both a value and a formula — one cell holds a value OR a live formula, never both`, sheet.name, refText);
      }
      if (!hasValue && !hasFormula) {
        err('empty-cell', `cell ${refText} is empty (no value, no formula) — remove it from the sparse map`, sheet.name, refText);
      }
      if (hasFormula && !(cell.f as string).startsWith('=')) {
        err('formula-missing-equals', `cell ${refText} formula must start with '='`, sheet.name, refText);
      }
      if (cell.fmt !== undefined && typeof cell.fmt !== 'string') {
        err('invalid-cell-fmt', `cell ${refText} fmt must be a string`, sheet.name, refText);
      }
    }
    for (const merge of sheet.merges ?? []) {
      if (!parseRange(merge)) err('invalid-merge', `merge range "${merge}" is not a valid A1 range`, sheet.name);
    }
    for (const chart of sheet.charts ?? []) {
      if (typeof chart.id !== 'string' || typeof chart.type !== 'string' || typeof chart.range !== 'string' || typeof chart.anchor !== 'string') {
        err('invalid-chart-spec', `chart spec on ${sheet.name} needs {id, type, range, anchor}`, sheet.name);
      }
    }
    for (const pivot of sheet.pivots ?? []) {
      if (typeof pivot.id !== 'string' || typeof pivot.source !== 'string' || typeof pivot.target !== 'string') {
        err('invalid-pivot-spec', `pivot spec on ${sheet.name} needs {id, source, target}`, sheet.name);
      }
    }
    for (const tile of sheet.tiles ?? []) {
      for (const issue of tileIssues(tile)) {
        err('invalid-tile-spec', issue, sheet.name);
      }
      // The materialized value cell must carry the tile's live formula:
      // a tile whose spec and cells disagree is a forked truth.
      const refs = tileRefs(tile);
      if (refs) {
        const cell = sheet.cells[refs.valueRef];
        if (cell && cell.f !== tile.formula) {
          err('tile-formula-mismatch', `tile "${tile.id}" spec formula differs from materialized cell ${refs.valueRef} — recompose the dashboard to resync`, sheet.name, refs.valueRef);
        }
      }
    }
    const pivotIds = new Set((sheet.pivots ?? []).map((p) => p.id));
    for (const other of workbook.sheets) for (const p of other.pivots ?? []) pivotIds.add(p.id);
    for (const slicer of sheet.slicers ?? []) {
      if (typeof slicer.id !== 'string' || typeof slicer.field !== 'string' || !slicer.field || typeof slicer.source !== 'string' || !slicer.source.includes('!')) {
        err('invalid-slicer-spec', `slicer spec on ${sheet.name} needs {id, field, source: "Sheet!A1:F9"}`, sheet.name);
      }
      if (typeof slicer.anchor !== 'string' || !parseCellRef(slicer.anchor)) {
        err('invalid-slicer-spec', `slicer "${slicer.id}" anchor "${String(slicer.anchor)}" is not a cell reference`, sheet.name);
      }
      if (slicer.pivot !== undefined && !pivotIds.has(slicer.pivot)) {
        err('invalid-slicer-spec', `slicer "${slicer.id}" binds pivot "${slicer.pivot}" which does not exist`, sheet.name);
      }
      if (slicer.kind !== undefined && slicer.kind !== 'field' && slicer.kind !== 'timeline') {
        err('invalid-slicer-spec', `slicer "${slicer.id}" kind must be "field" or "timeline"`, sheet.name);
      }
    }
  }

  for (const [name, ref] of Object.entries(workbook.namedRanges ?? {})) {
    if (!/^[A-Za-z_][A-Za-z0-9_.]*$/.test(name)) err('invalid-named-range', `named range "${name}" is not a valid Excel name`);
    if (typeof ref !== 'string' || ref.length === 0) err('invalid-named-range', `named range "${name}" needs a reference string`);
  }
  return issues;
}

/* ------------------------------------------------------- perception */

export type SheetSummary = {
  name: string;
  rows: number;
  cols: number;
  headers: string[];
  formulaCells: number;
  valueCells: number;
};

export type WorkbookSummary = {
  title: string;
  stage: WorkbookSpec['stage'];
  sheets: SheetSummary[];
  namedRanges: string[];
  hasBlueprint: boolean;
  verifyOk: boolean | null;
};

/**
 * The engine's perception surface: dimensions, detected headers, and
 * formula/value counts per sheet — never a full grid dump (the research
 * is unambiguous that full-grid context collapses past ~32k tokens).
 */
export function summarizeWorkbook(workbook: WorkbookSpec): WorkbookSummary {
  const sheets: SheetSummary[] = workbook.sheets.map((sheet) => {
    const bounds = sheetBounds(sheet);
    const headers = [...sheetHeaders(sheet).entries()].sort((a, b) => a[0] - b[0]).map(([, v]) => v);
    let formulaCells = 0;
    let valueCells = 0;
    for (const cell of Object.values(sheet.cells)) {
      if (typeof cell.f === 'string' && cell.f) formulaCells += 1;
      else if (cell.v !== undefined) valueCells += 1;
    }
    return {
      name: sheet.name,
      rows: bounds ? bounds.maxRow + 1 : 0,
      cols: bounds ? bounds.maxCol + 1 : 0,
      headers,
      formulaCells,
      valueCells,
    };
  });
  return {
    title: workbook.title,
    stage: workbook.stage,
    sheets,
    namedRanges: Object.keys(workbook.namedRanges ?? {}),
    hasBlueprint: workbook.blueprint !== undefined,
    verifyOk: workbook.verify ? workbook.verify.ok : null,
  };
}

/** A windowed, addressed read of one sheet — the only grid read the engine performs. */
export function readRangeValues(
  workbook: WorkbookSpec,
  sheetName: string,
  rangeText: string,
): { ok: true; sheet: string; rows: Array<Array<{ ref: string; v?: unknown; f?: string }>> } | { ok: false; issues: string[] } {
  const sheet = workbook.sheets.find((s) => s.name === sheetName);
  if (!sheet) return { ok: false, issues: [`sheet "${sheetName}" does not exist (sheets: ${workbook.sheets.map((s) => s.name).join(', ') || 'none'})`] };
  const range = parseRange(rangeText);
  if (!range) return { ok: false, issues: [`range "${rangeText}" is not a valid A1 range`] };
  const rows: Array<Array<{ ref: string; v?: unknown; f?: string }>> = [];
  for (let r = range.start.row; r <= range.end.row; r += 1) {
    const row: Array<{ ref: string; v?: unknown; f?: string }> = [];
    for (let c = range.start.col; c <= range.end.col; c += 1) {
      const ref = formatCellRef(c, r);
      const cell = sheet.cells[ref];
      row.push(cell ? { ref, ...(cell.v !== undefined ? { v: cell.v } : {}), ...(cell.f ? { f: cell.f } : {}) } : { ref });
    }
    rows.push(row);
  }
  return { ok: true, sheet: sheet.name, rows };
}
