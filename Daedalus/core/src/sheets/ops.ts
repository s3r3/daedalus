import {
  formatCellRef,
  indexToCol,
  parseCellRef,
  parseRange,
  colToIndex,
  type CellScalar,
  type SheetSpec,
  type WorkbookSpec,
} from './workbook.ts';
import { validateWorkbook } from './store.ts';
import { newSheet, newSheetId } from './store.ts';

/**
 * The Spreadsheet edit seam: ONE structured call, a closed op
 * vocabulary, validated as a whole against a clone — any invalid op
 * rejects the batch and the workbook stays byte-identical (the Slide
 * edit-op doctrine, transplanted). This is also the ONLY way build
 * writes cells: no free code generation, no model-chosen control flow.
 *
 * Vocabulary mirrors the design's tool table minus the engine-driven
 * ones: validate_workbook / export_workbook run as pipeline stages,
 * get_workbook_summary / read_range are perception reads — all four
 * are exposed to the edit stage as functions, not ops.
 */

export const SHEET_OP_NAMES = [
  'create_workbook',
  'get_workbook_summary',
  'read_range',
  'set_cells',
  'set_formula',
  'insert_rows',
  'insert_columns',
  'delete_range',
  'sort_range',
  'set_format',
  'add_sheet',
  'rename_sheet',
  'delete_sheet',
  'define_named_range',
  'validate_workbook',
  'export_workbook',
] as const;

export type SheetOpName = (typeof SHEET_OP_NAMES)[number];

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}
function str(v: unknown): v is string { return typeof v === 'string'; }

export type SheetOpResult = {
  opsApplied: number;
  exportRequested: 'xlsx' | 'csv' | null;
  validateRequested: boolean;
};

export type ApplySheetOpsResult =
  | { ok: true; workbook: WorkbookSpec; value: SheetOpResult }
  | { ok: false; issues: string[] };

function findSheet(wb: WorkbookSpec, name: unknown, issues: string[]): SheetSpec | null {
  if (!str(name)) { issues.push('op needs a sheet name'); return null; }
  const sheet = wb.sheets.find((s) => s.name === name);
  if (!sheet) { issues.push(`sheet "${name}" does not exist`); return null; }
  return sheet;
}

function scalarCell(input: unknown): { v?: CellScalar; f?: string } | null {
  if (input === null || input === undefined) return null;
  if (typeof input === 'string' && input.startsWith('=')) return { f: input };
  if (typeof input === 'string' || typeof input === 'number' || typeof input === 'boolean') return { v: input };
  return null;
}

const REF_TOKEN_RE = /((?:'[^']+'|[A-Za-z0-9_]+)!)?(\$?)([A-Za-z]{1,3})(\$?)([0-9]{1,7})/g;

type ShiftDelta = { rowAt?: number; rowCount?: number; colAt?: number; colCount?: number };

/**
 * Rewrite A1 refs in a formula after a shift. `$`-pinned parts never
 * move (Excel semantics). When `onlySheet` is set, only refs qualified
 * with that sheet move (used for cross-sheet adjustment after a
 * structural insert); otherwise every ref's relative parts move
 * (fill semantics / same-sheet structural shift).
 */
export function shiftFormulaRefs(formula: string, delta: ShiftDelta, onlySheet?: string): string {
  return formula.replace(REF_TOKEN_RE, (whole, qualifier: string | undefined, cAbs: string, col: string, rAbs: string, row: string) => {
    if (onlySheet !== undefined) {
      if (!qualifier) return whole;
      const name = qualifier.slice(0, -1).replace(/^'|'$/g, '');
      if (name.toLowerCase() !== onlySheet.toLowerCase()) return whole;
    }
    let colIdx = colToIndex(col);
    let rowIdx = Number(row) - 1;
    if (cAbs !== '$' && delta.colAt !== undefined && delta.colCount && colIdx >= delta.colAt) colIdx += delta.colCount;
    if (rAbs !== '$' && delta.rowAt !== undefined && delta.rowCount && rowIdx >= delta.rowAt) rowIdx += delta.rowCount;
    return `${qualifier ?? ''}${cAbs}${indexToCol(colIdx)}${rAbs}${rowIdx + 1}`;
  });
}

function shiftSheetCells(sheet: SheetSpec, delta: { rowAt?: number; rowCount?: number; colAt?: number; colCount?: number }): void {
  const next: Record<string, SheetSpec['cells'][string]> = {};
  for (const [refText, cell] of Object.entries(sheet.cells)) {
    const ref = parseCellRef(refText);
    if (!ref) { next[refText] = cell; continue; }
    let { col, row } = ref;
    if (delta.colAt !== undefined && delta.colCount && col >= delta.colAt) col += delta.colCount;
    if (delta.rowAt !== undefined && delta.rowCount && row >= delta.rowAt) row += delta.rowCount;
    const moved = { ...cell };
    if (moved.f) moved.f = shiftFormulaRefs(moved.f, delta);
    next[formatCellRef(col, row)] = moved;
  }
  sheet.cells = next;
}

export function applySheetOps(workbook: WorkbookSpec, value: unknown): ApplySheetOpsResult {
  const issues: string[] = [];
  if (!isObj(value) || value.kind !== 'sheet-ops' || !Array.isArray(value.ops)) {
    return { ok: false, issues: ['expected {"kind":"sheet-ops","ops":[...]}'] };
  }
  const wb: WorkbookSpec = JSON.parse(JSON.stringify(workbook)) as WorkbookSpec;
  let exportRequested: 'xlsx' | 'csv' | null = null;
  let validateRequested = false;
  let opsApplied = 0;

  const sheetOf = (op: Record<string, unknown>): SheetSpec | null => findSheet(wb, op.sheet, issues);

  for (const rawOp of value.ops as unknown[]) {
    if (!isObj(rawOp) || !str(rawOp.op)) { issues.push('every op needs an "op" name'); continue; }
    const op = rawOp;
    switch (op.op) {
      case 'create_workbook': {
        if (wb.sheets.length > 0) { issues.push('create_workbook is only valid on an empty workbook'); break; }
        if (str(op.title)) wb.title = op.title;
        opsApplied += 1;
        break;
      }
      case 'add_sheet': {
        if (!str(op.name) || !op.name.trim()) { issues.push('add_sheet needs a name'); break; }
        if (wb.sheets.some((s) => s.name.toLowerCase() === (op.name as string).toLowerCase())) { issues.push(`sheet "${op.name}" already exists`); break; }
        const sheet = newSheet(op.name as string);
        if (str(op.tabColor)) sheet.tabColor = op.tabColor;
        wb.sheets.push(sheet);
        opsApplied += 1;
        break;
      }
      case 'rename_sheet': {
        const sheet = sheetOf(op); if (!sheet) break;
        if (!str(op.name) || !op.name.trim()) { issues.push('rename_sheet needs a new name'); break; }
        if (wb.sheets.some((s) => s !== sheet && s.name.toLowerCase() === (op.name as string).toLowerCase())) { issues.push(`sheet name "${op.name}" is taken`); break; }
        sheet.name = op.name as string;
        opsApplied += 1;
        break;
      }
      case 'delete_sheet': {
        const sheet = sheetOf(op); if (!sheet) break;
        wb.sheets = wb.sheets.filter((s) => s !== sheet);
        opsApplied += 1;
        break;
      }
      case 'set_cells': {
        const sheet = sheetOf(op); if (!sheet) break;
        const range = str(op.range) ? parseRange(op.range) : null;
        if (!range) { issues.push(`set_cells range "${String(op.range)}" is not a valid A1 range`); break; }
        if (!Array.isArray(op.values)) { issues.push('set_cells needs values: a 2D array (string starting with = is a formula)'); break; }
        let applied = 0;
        (op.values as unknown[][]).forEach((rowValues, r) => {
          if (!Array.isArray(rowValues)) { issues.push(`set_cells row ${r + 1} is not an array`); return; }
          rowValues.forEach((input, c) => {
            const ref = formatCellRef(range.start.col + c, range.start.row + r);
            if (input === null || input === undefined || input === '') { delete sheet.cells[ref]; applied += 1; return; }
            const parsed = scalarCell(input);
            if (!parsed) { issues.push(`set_cells value at ${ref} must be a string, number, boolean, or "=formula"`); return; }
            const existing = sheet.cells[ref];
            sheet.cells[ref] = { ...(existing ? { fmt: existing.fmt, bold: existing.bold, fill: existing.fill, color: existing.color } : {}), ...parsed };
            applied += 1;
          });
        });
        if (applied > 0) opsApplied += 1;
        break;
      }
      case 'set_formula': {
        const sheet = sheetOf(op); if (!sheet) break;
        if (!str(op.formula) || !(op.formula as string).startsWith('=')) { issues.push('set_formula needs a formula starting with ='); break; }
        const rangeText = str(op.range) ? op.range : str(op.cell) ? op.cell : null;
        const range = rangeText ? parseRange(rangeText) : null;
        if (!range) { issues.push('set_formula needs a cell or range'); break; }
        for (let r = range.start.row; r <= range.end.row; r += 1) {
          for (let c = range.start.col; c <= range.end.col; c += 1) {
            const ref = formatCellRef(c, r);
            const existing = sheet.cells[ref];
            // Fill semantics: relative refs shift with the target cell.
            const shifted = shiftFormulaRefs(op.formula as string, {
              colAt: 0, colCount: c - range.start.col, rowAt: 0, rowCount: r - range.start.row,
            });
            sheet.cells[ref] = { ...(existing ? { fmt: existing.fmt, bold: existing.bold, fill: existing.fill, color: existing.color } : {}), f: shifted };
          }
        }
        opsApplied += 1;
        break;
      }
      case 'insert_rows': case 'insert_columns': {
        const sheet = sheetOf(op); if (!sheet) break;
        const at = typeof op.at === 'number' ? op.at : NaN;
        const count = typeof op.count === 'number' ? op.count : 1;
        if (!Number.isInteger(at) || at < 1) { issues.push(`${op.op} needs "at" as a 1-based index`); break; }
        if (!Number.isInteger(count) || count < 1 || count > 1000) { issues.push(`${op.op} count must be 1..1000`); break; }
        const delta = op.op === 'insert_rows' ? { rowAt: at - 1, rowCount: count } : { colAt: at - 1, colCount: count };
        shiftSheetCells(sheet, delta);
        // Cross-sheet: formulas elsewhere that point at this sheet shift too.
        for (const other of wb.sheets) {
          if (other === sheet) continue;
          for (const cell of Object.values(other.cells)) {
            if (cell.f) cell.f = shiftFormulaRefs(cell.f, delta, sheet.name);
          }
        }
        opsApplied += 1;
        break;
      }
      case 'delete_range': {
        const sheet = sheetOf(op); if (!sheet) break;
        const range = str(op.range) ? parseRange(op.range) : null;
        if (!range) { issues.push('delete_range needs a valid range'); break; }
        const shift = op.shift === 'left' ? 'left' : 'up';
        for (let r = range.start.row; r <= range.end.row; r += 1) {
          for (let c = range.start.col; c <= range.end.col; c += 1) {
            delete sheet.cells[formatCellRef(c, r)];
          }
        }
        // Compact: pull cells below (or right of) the cleared band up.
        const height = range.end.row - range.start.row + 1;
        const width = range.end.col - range.start.col + 1;
        const next: Record<string, SheetSpec['cells'][string]> = {};
        for (const [refText, cell] of Object.entries(sheet.cells)) {
          const ref = parseCellRef(refText);
          if (!ref) { next[refText] = cell; continue; }
          let { col, row } = ref;
          if (shift === 'up' && row > range.end.row && col >= range.start.col && col <= range.end.col) row -= height;
          if (shift === 'left' && col > range.end.col && row >= range.start.row && row <= range.end.row) col -= width;
          next[formatCellRef(col, row)] = cell;
        }
        sheet.cells = next;
        opsApplied += 1;
        break;
      }
      case 'sort_range': {
        const sheet = sheetOf(op); if (!sheet) break;
        const range = str(op.range) ? parseRange(op.range) : null;
        if (!range) { issues.push('sort_range needs a valid range'); break; }
        const byRaw = typeof op.by === 'number' ? op.by : 1;
        const by = Math.max(1, Math.min(byRaw, range.end.col - range.start.col + 1));
        const dir = op.dir === 'desc' ? -1 : 1;
        const rowsData: Array<Array<SheetSpec['cells'][string] | undefined>> = [];
        for (let r = range.start.row; r <= range.end.row; r += 1) {
          const rowCells: Array<SheetSpec['cells'][string] | undefined> = [];
          for (let c = range.start.col; c <= range.end.col; c += 1) rowCells.push(sheet.cells[formatCellRef(c, r)]);
          rowsData.push(rowCells);
        }
        const keyOf = (rowCells: Array<SheetSpec['cells'][string] | undefined>): string => {
          const cell = rowCells[by - 1];
          if (!cell) return '';
          if (cell.f) return cell.f;
          return cell.v === undefined ? '' : String(cell.v);
        };
        rowsData.sort((a, b) => keyOf(a).localeCompare(keyOf(b), undefined, { numeric: true }) * dir);
        rowsData.forEach((rowCells, r) => {
          rowCells.forEach((cell, c) => {
            const ref = formatCellRef(range.start.col + c, range.start.row + r);
            if (cell) sheet.cells[ref] = cell;
            else delete sheet.cells[ref];
          });
        });
        opsApplied += 1;
        break;
      }
      case 'set_format': {
        const sheet = sheetOf(op); if (!sheet) break;
        const range = str(op.range) ? parseRange(op.range) : null;
        if (!range) { issues.push('set_format needs a valid range'); break; }
        for (let r = range.start.row; r <= range.end.row; r += 1) {
          for (let c = range.start.col; c <= range.end.col; c += 1) {
            const ref = formatCellRef(c, r);
            const cell = sheet.cells[ref];
            if (!cell) continue;
            if (str(op.numFmt)) cell.fmt = op.numFmt;
            if (typeof op.bold === 'boolean') cell.bold = op.bold;
            if (str(op.fill)) cell.fill = op.fill;
            if (str(op.color)) cell.color = op.color;
          }
        }
        opsApplied += 1;
        break;
      }
      case 'define_named_range': {
        if (!str(op.name) || !/^[A-Za-z_][A-Za-z0-9_.]*$/.test(op.name)) { issues.push('define_named_range needs a valid Excel name'); break; }
        if (!str(op.ref) || !(op.ref as string).includes('!')) { issues.push('define_named_range ref must look like Sheet!A1'); break; }
        wb.namedRanges = { ...(wb.namedRanges ?? {}), [op.name as string]: op.ref as string };
        opsApplied += 1;
        break;
      }
      case 'validate_workbook': validateRequested = true; opsApplied += 1; break;
      case 'export_workbook': exportRequested = op.format === 'csv' ? 'csv' : 'xlsx'; opsApplied += 1; break;
      case 'get_workbook_summary': case 'read_range': {
        issues.push(`${op.op} is a read, not a mutation op — reads are issued as their own stage, not inside an edit batch`);
        break;
      }
      default:
        issues.push(`unknown sheet op "${op.op}" — the edit vocabulary is closed: ${SHEET_OP_NAMES.join(', ')}`);
    }
  }

  if (issues.length > 0) return { ok: false, issues };
  const structural = validateWorkbook(wb).filter((i) => i.severity === 'error');
  if (structural.length > 0) {
    return { ok: false, issues: structural.map((i) => `${i.sheet ? `${i.sheet}!` : ''}${i.cell ?? ''} ${i.message}`) };
  }
  wb.stage = 'ready';
  return { ok: true, workbook: wb, value: { opsApplied, exportRequested, validateRequested } };
}

export { newSheetId };
