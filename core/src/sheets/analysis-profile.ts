import { inferColumnType } from './import.ts';
import { formatCellRef, indexToCol, parseCellRef, sheetHeaders, type CellScalar, type SheetSpec, type WorkbookSpec } from './workbook.ts';

/**
 * Deterministic dataset profiler for the Analis mode — zero LLM.
 * Runs before the planner (the reginald-francis pattern: a
 * dataset-agnostic profiler grounds every choice the planner makes),
 * so the plan's formulas can only name columns the profiler saw.
 */

export type ProfiledColumnType = 'text' | 'number' | 'currency' | 'percent' | 'date' | 'boolean';

export interface ProfiledColumn {
  name: string;
  type: ProfiledColumnType;
  /** Fraction of data rows with no value in this column (0–1). */
  nullRate: number;
  /** Distinct non-null values. */
  cardinality: number;
  /** Up to 5 first-seen distinct values, as strings. */
  samples: string[];
}

export interface DatasetProfile {
  sheetName: string;
  /** Data rows (header row excluded). */
  rowCount: number;
  /** In left-to-right sheet column order. */
  columns: ProfiledColumn[];
  /**
   * Text columns whose cardinality is below 20% of the row count —
   * the natural GROUP BY / slicer dimensions.
   */
  groupCandidates: string[];
}

const MAX_SAMPLES = 5;
/** A text column is a group candidate below this share of the row count. */
const GROUP_CARDINALITY_RATIO = 0.2;

function isNullScalar(v: CellScalar | undefined): boolean {
  return v === undefined || v === '';
}

/**
 * Profile one sheet. Reads data rows via parseCellRef (row 0 = header,
 * rows 1..rowCount = data), types columns with the import stage's
 * inferColumnType. Pure and deterministic: same cells → same profile.
 */
export function profileSheet(sheet: SheetSpec): DatasetProfile {
  const headers = sheetHeaders(sheet);
  const columns = new Set<number>();
  for (const col of headers.keys()) columns.add(col);
  let lastDataRow = 0; // 0-based index; 0 = header row
  for (const key of Object.keys(sheet.cells)) {
    const ref = parseCellRef(key);
    if (!ref) continue;
    columns.add(ref.col);
    if (ref.row > 0 && ref.row > lastDataRow) lastDataRow = ref.row;
  }
  const rowCount = lastDataRow; // rows 1..lastDataRow inclusive
  const ordered = [...columns].sort((a, b) => a - b);

  const profiled: ProfiledColumn[] = ordered.map((col) => {
    const values: CellScalar[] = [];
    let nulls = 0;
    const seen = new Set<string>();
    const samples: string[] = [];
    for (let r = 1; r <= rowCount; r += 1) {
      const cell = sheet.cells[formatCellRef(col, r)];
      if (!cell || (cell.v === undefined && cell.f === undefined) || isNullScalar(cell.v)) {
        // A formula cell is non-null (it computes something) but its
        // type is unknowable without evaluation — excluded from the
        // type sample, counted as present.
        if (cell?.f !== undefined) continue;
        nulls += 1;
        continue;
      }
      if (cell.v === undefined) continue; // formula-only cell: present, untyped
      values.push(cell.v);
      const key = `${typeof cell.v}:${String(cell.v)}`;
      if (!seen.has(key)) {
        seen.add(key);
        if (samples.length < MAX_SAMPLES) samples.push(String(cell.v));
      }
    }
    const name = headers.get(col) ?? indexToCol(col);
    return {
      name,
      type: inferColumnType(values),
      nullRate: rowCount > 0 ? nulls / rowCount : 0,
      cardinality: seen.size,
      samples,
    };
  });

  return {
    sheetName: sheet.name,
    rowCount,
    columns: profiled,
    groupCandidates: profiled
      .filter((c) => c.type === 'text' && c.cardinality > 0 && c.cardinality < GROUP_CARDINALITY_RATIO * rowCount)
      .map((c) => c.name),
  };
}

/** Profile every sheet of a workbook, in sheet order. */
export function profileWorkbook(wb: WorkbookSpec): DatasetProfile[] {
  return wb.sheets.map(profileSheet);
}
