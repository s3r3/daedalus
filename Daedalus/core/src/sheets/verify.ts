import { execFile } from 'node:child_process';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import ExcelJS from 'exceljs';
import { evaluateWorkbook } from './evaluator.ts';
import { parseCellRef, sheetHeaders, type SheetSpec, type VerifyCellIssue, type VerifyReport, type WorkbookSpec } from './workbook.ts';

/**
 * The Verify gate. Two arms, per the design:
 *  1. the in-core evaluator recomputes every formula cell from
 *     workbook.json — broken refs (#REF!), error literals, and
 *     circularity surface here with cell addresses;
 *  2. when LibreOffice is present, the exported file is recalced
 *     headlessly and scanned for Excel error literals, catching what
 *     the subset evaluator cannot know (its `unsupported` cells).
 * Audit checks ride on the same pass: frozen numbers where a column's
 * pattern is formulas, inconsistent per-row formulas, duplicate rows.
 * The gate NEVER claims more than it ran: no LibreOffice → path
 * 'core'; unparseable/unsupported formulas → path 'partial'.
 */

export const ERROR_LITERALS = ['#REF!', '#DIV/0!', '#VALUE!', '#NAME?', '#NULL!', '#NUM!', '#N/A'] as const;

export type LibreOfficeRecalcResult = {
  ran: boolean;
  errors: VerifyCellIssue[];
  /** Machine-readable reason the recalc did not run (honest fallback). */
  reason?: string;
};

export type VerifyOptions = {
  /** Force the core-only path (tests, or LibreOffice known absent). */
  coreOnly?: boolean;
  /** Temp xlsx to recalc; when absent the recalc arm is skipped. */
  exportPath?: string;
  /** Injected converter for tests; defaults to the real soffice probe. */
  recalc?: (xlsxPath: string) => Promise<LibreOfficeRecalcResult>;
};

function columnFormulaProfile(sheet: SheetSpec): Map<number, { formulas: number; values: number; total: number }> {
  const profile = new Map<number, { formulas: number; values: number; total: number }>();
  for (const [refText, cell] of Object.entries(sheet.cells)) {
    const ref = parseCellRef(refText);
    if (!ref || ref.row === 0) continue; // row 1 = header
    const entry = profile.get(ref.col) ?? { formulas: 0, values: 0, total: 0 };
    entry.total += 1;
    if (cell.f) entry.formulas += 1;
    else if (cell.v !== undefined) entry.values += 1;
    profile.set(ref.col, entry);
  }
  return profile;
}

/** Normalize a formula for pattern comparison: refs → R{r}C{c} relative tokens. */
function normalizedPattern(formula: string, fromRow: number, fromCol: number): string {
  return formula.replace(/((?:'[^']+'|[A-Za-z0-9_]+)!)?(\$?)([A-Za-z]{1,3})(\$?)([0-9]{1,7})/g, (_w, q: string | undefined, cAbs: string, col: string, rAbs: string, row: string) => {
    const colIdx = colToIndexSafe(col);
    const rowIdx = Number(row) - 1;
    const c = cAbs === '$' ? `C${colIdx}` : `c${colIdx - fromCol}`;
    const r = rAbs === '$' ? `R${rowIdx}` : `r${rowIdx - fromRow}`;
    return `${q ?? ''}${r}${c}`;
  });
}

function colToIndexSafe(col: string): number {
  let n = 0;
  for (const ch of col.toUpperCase()) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}

function auditChecks(workbook: WorkbookSpec): VerifyCellIssue[] {
  const warnings: VerifyCellIssue[] = [];
  for (const sheet of workbook.sheets) {
    const profile = columnFormulaProfile(sheet);
    const headers = sheetHeaders(sheet);
    for (const [refText, cell] of Object.entries(sheet.cells)) {
      const ref = parseCellRef(refText);
      if (!ref || ref.row === 0) continue;
      const colProfile = profile.get(ref.col);
      // Frozen where a formula is expected: the column is mostly
      // formulas but this cell froze a literal number into it.
      if (!cell.f && typeof cell.v === 'number' && colProfile && colProfile.total >= 3 && colProfile.formulas / colProfile.total >= 0.6) {
        warnings.push({
          sheet: sheet.name,
          cell: refText,
          code: 'frozen-where-formula-expected',
          severity: 'warning',
          message: `kolom "${headers.get(ref.col) ?? refText}" mayoritas formula (${colProfile.formulas}/${colProfile.total}) tapi sel ini angka beku — mungkin hasil tempel-nilai; periksa apakah seharusnya formula`,
        });
      }
    }
    // Inconsistent per-row formula pattern within a column.
    const byColumn = new Map<number, Map<string, string[]>>();
    for (const [refText, cell] of Object.entries(sheet.cells)) {
      if (!cell.f) continue;
      const ref = parseCellRef(refText);
      if (!ref || ref.row === 0) continue;
      const pattern = normalizedPattern(cell.f, ref.row, ref.col);
      const colMap = byColumn.get(ref.col) ?? new Map<string, string[]>();
      const list = colMap.get(pattern) ?? [];
      list.push(refText);
      colMap.set(pattern, list);
      byColumn.set(ref.col, colMap);
    }
    for (const [col, patterns] of byColumn) {
      if (patterns.size < 2) continue;
      const total = [...patterns.values()].reduce((a, l) => a + l.length, 0);
      if (total < 3) continue;
      const majority = [...patterns.entries()].sort((a, b) => b[1].length - a[1].length)[0] as [string, string[]];
      // A KPI/label column legitimately carries a different formula per
      // row (each row is a different metric): the pattern check only
      // means something when one pattern actually repeats as a column
      // pattern (>= 3 rows sharing it).
      if (majority[1].length < 3) continue;
      for (const [pattern, cells] of patterns) {
        if (pattern === majority[0]) continue;
        for (const refText of cells) {
          warnings.push({
            sheet: sheet.name,
            cell: refText,
            code: 'inconsistent-formula-pattern',
            severity: 'warning',
            message: `formula sel ini menyimpang dari pola mayoritas kolom "${headers.get(col) ?? ''}" (${majority[1].length} dari ${total} sel) — periksa konsistensi baris`,
          });
        }
      }
    }
    // Duplicate data rows (identical across the used range).
    const seen = new Map<string, string>();
    const rows = new Map<number, Map<number, string>>();
    for (const [refText, cell] of Object.entries(sheet.cells)) {
      const ref = parseCellRef(refText);
      if (!ref || ref.row === 0) continue;
      const rowMap = rows.get(ref.row) ?? new Map<number, string>();
      // Formulas compare by relative pattern, not raw text: =C2-D2 and
      // =C5-D5 are the "same" row content for duplication purposes.
      rowMap.set(ref.col, cell.f ? normalizedPattern(cell.f, ref.row, ref.col) : (cell.v === undefined ? '' : String(cell.v)));
      rows.set(ref.row, rowMap);
    }
    for (const [rowIdx, rowMap] of [...rows.entries()].sort((a, b) => a[0] - b[0])) {
      if (rowMap.size === 0) continue;
      const signature = [...rowMap.entries()].sort((a, b) => a[0] - b[0]).map(([c, v]) => `${c}=${v}`).join('|');
      const first = seen.get(signature);
      const firstCell = `${'A'}${rowIdx + 1}`;
      if (first) {
        warnings.push({
          sheet: sheet.name,
          cell: firstCell,
          code: 'duplicate-row',
          severity: 'warning',
          message: `baris ${rowIdx + 1} identik dengan ${first} — kemungkinan data ganda`,
        });
      } else {
        seen.set(signature, `baris ${rowIdx + 1}`);
      }
    }
  }
  return warnings;
}

export function verifyWorkbookCore(workbook: WorkbookSpec): { errors: VerifyCellIssue[]; warnings: VerifyCellIssue[]; formulasChecked: number; unsupported: number } {
  const evaluation = evaluateWorkbook(workbook);
  const errors: VerifyCellIssue[] = evaluation.errors.map((e) => ({
    sheet: e.sheet,
    cell: e.cell,
    code: e.error === '#CYCLE!' ? 'circular-reference' : 'formula-error',
    severity: 'error',
    message: `formula menghasilkan ${e.error}`,
  }));
  // Broken sheet references: the evaluator reports #REF!; surface the
  // missing sheet too when the formula names one we don't have.
  const sheetNames = new Set(workbook.sheets.map((s) => s.name.toLowerCase()));
  for (const sheet of workbook.sheets) {
    for (const [refText, cell] of Object.entries(sheet.cells)) {
      if (!cell.f) continue;
      for (const match of cell.f.matchAll(/(?:'([^']+)'|([A-Za-z0-9_]+))!/g)) {
        const named = (match[1] ?? match[2] ?? '').toLowerCase();
        if (named && !sheetNames.has(named)) {
          errors.push({
            sheet: sheet.name,
            cell: refText,
            code: 'broken-reference',
            severity: 'error',
            message: `formula merujuk sheet "${match[1] ?? match[2]}" yang tidak ada`,
          });
        }
      }
    }
  }
  return {
    errors,
    warnings: auditChecks(workbook),
    formulasChecked: evaluation.formulaCells,
    unsupported: evaluation.unsupported.length,
  };
}

/* ---------------------------------------------- LibreOffice recalc */

function execFileP(cmd: string, args: string[], timeoutMs: number): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolvePromise, reject) => {
    execFile(cmd, args, { timeout: timeoutMs }, (error, stdout, stderr) => {
      if (error) reject(Object.assign(error, { stdout, stderr }));
      else resolvePromise({ stdout, stderr });
    });
  });
}

export async function detectSoffice(): Promise<string | null> {
  try {
    await execFileP('soffice', ['--version'], 15000);
    return 'soffice';
  } catch {
    return null;
  }
}

async function findRecalcSoffice(): Promise<string | null> {
  for (const candidate of ['soffice', 'libreoffice']) {
    try {
      await execFileP(candidate, ['--version'], 15000);
      return candidate;
    } catch { /* keep probing */ }
  }
  return null;
}

/**
 * Recalc an exported xlsx through LibreOffice and scan the result for
 * error literals. Mirrors the Slide preview's runner shape (fresh temp
 * profile, hard timeout, honest failure reason instead of a throw).
 */
export async function libreOfficeRecalc(xlsxPath: string, sofficeBin?: string): Promise<LibreOfficeRecalcResult> {
  const bin = sofficeBin ?? (await findRecalcSoffice());
  if (!bin) return { ran: false, errors: [], reason: 'libreoffice-not-detected' };
  const dir = await mkdtemp(join(tmpdir(), 'daedalus-sheet-verify-'));
  try {
    await execFileP(bin, [
      '--headless', '--norestore', '-env:UserInstallation=file:///tmp/daedalus-lo-profile-sheet-verify',
      '--convert-to', 'xlsx', '--outdir', dir, xlsxPath,
    ], 120000);
    const files = (await readdir(dir)).filter((f) => f.endsWith('.xlsx'));
    if (files.length === 0) return { ran: false, errors: [], reason: 'libreoffice-produced-no-output' };
    const recalced = join(dir, files[0] as string);
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.readFile(recalced);
    const errors: VerifyCellIssue[] = [];
    wb.eachSheet((ws) => {
      ws.eachRow({ includeEmpty: false }, (row) => {
        row.eachCell({ includeEmpty: false }, (cell) => {
          const value = cell.value as unknown;
          if (value && typeof value === 'object' && 'error' in (value as Record<string, unknown>)) {
            const literal = String((value as { error: unknown }).error);
            errors.push({
              sheet: ws.name,
              cell: cell.address,
              code: 'recalc-error',
              severity: 'error',
              message: `recalc LibreOffice: sel berisi ${literal} setelah file diekspor`,
            });
          } else if (typeof value === 'string' && (ERROR_LITERALS as readonly string[]).includes(value)) {
            errors.push({
              sheet: ws.name,
              cell: cell.address,
              code: 'recalc-error',
              severity: 'error',
              message: `recalc LibreOffice: sel berisi literal error ${value}`,
            });
          }
        });
      });
    });
    return { ran: true, errors };
  } catch (err) {
    return { ran: false, errors: [], reason: err instanceof Error ? err.message.slice(0, 200) : String(err) };
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
}

/** Full gate: core evaluator (+ audit) then, when possible, the recalc arm. */
export async function verifyWorkbook(workbook: WorkbookSpec, opts: VerifyOptions = {}): Promise<VerifyReport> {
  const core = verifyWorkbookCore(workbook);
  const errors = [...core.errors];
  let path: VerifyReport['path'] = core.unsupported > 0 ? 'partial' : 'core';
  let recalcRan = false;
  if (!opts.coreOnly && opts.exportPath) {
    const recalc = opts.recalc ?? libreOfficeRecalc;
    const result = await recalc(opts.exportPath).catch((): LibreOfficeRecalcResult => ({ ran: false, errors: [], reason: 'recalc-threw' }));
    if (result.ran) {
      recalcRan = true;
      path = core.unsupported > 0 ? 'partial' : 'core+libreoffice';
      for (const e of result.errors) {
        if (!errors.some((x) => x.sheet === e.sheet && x.cell === e.cell)) errors.push(e);
      }
    }
  }
  const ok = errors.length === 0;
  const parts = [
    `${core.formulasChecked} formula dievaluasi di core`,
    core.unsupported > 0 ? `${core.unsupported} di luar subset evaluator (path parsial)` : '',
    recalcRan ? '+ recalc LibreOffice' : 'tanpa recalc LibreOffice (tidak terdeteksi)',
    errors.length ? `${errors.length} error` : '0 error',
    core.warnings.length ? `${core.warnings.length} peringatan audit` : '',
  ].filter(Boolean);
  return {
    at: new Date().toISOString(),
    path,
    ok,
    formulasChecked: core.formulasChecked,
    unsupported: core.unsupported,
    errors,
    warnings: core.warnings,
    summary: `Verify (${path}): ${parts.join(' · ')}`,
  };
}
