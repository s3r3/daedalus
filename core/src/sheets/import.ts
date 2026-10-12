import ExcelJS from 'exceljs';
import { formatCellRef, parseCellRef, type CellScalar, type SheetSpec, type WorkbookSpec } from './workbook.ts';
import { newSheet, newWorkbook } from './store.ts';

/**
 * Intake: flat files become workbook.json. CSV is parsed by hand (no
 * dependency beyond exceljs, which reads XLSX). Values are typed by
 * inference — numbers become numbers, 'true'/'false' booleans,
 * percent strings numbers with a pct note left to the format; formulas
 * from XLSX are preserved verbatim so the Verify gate can judge them.
 */

export function parseCsvText(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let inQuotes = false;
  const pushField = (): void => { row.push(field); field = ''; };
  const pushRow = (): void => { pushField(); rows.push(row); row = []; };
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i] as string;
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') { field += '"'; i += 1; }
        else inQuotes = false;
      } else field += ch;
      continue;
    }
    if (ch === '"') { inQuotes = true; continue; }
    if (ch === ',') { pushField(); continue; }
    if (ch === '\n') { pushRow(); continue; }
    if (ch === '\r') continue;
    field += ch;
  }
  if (field.length > 0 || row.length > 0) pushRow();
  return rows.filter((r) => r.some((c) => c.trim().length > 0));
}

export function inferScalar(raw: string): CellScalar {
  const text = raw.trim();
  if (text === '') return '';
  if (/^(true|false)$/i.test(text)) return text.toLowerCase() === 'true';
  // Numbers: plain, grouped (1,234.5 / 1.234,5), currency-prefixed, percent.
  const cleaned = text.replace(/^rp\.?\s*/i, '').replace(/\s/g, '');
  const pct = /^(-?[\d.,]+)%$/.exec(cleaned);
  if (pct) {
    const n = parseLooseNumber(pct[1] as string);
    if (n !== null) return n / 100;
  }
  const n = parseLooseNumber(cleaned);
  if (n !== null) return n;
  return text;
}

function parseLooseNumber(text: string): number | null {
  if (!/^-?[\d.,]+$/.test(text)) return null;
  let normalized = text;
  const dots = (text.match(/\./g) ?? []).length;
  const commas = (text.match(/,/g) ?? []).length;
  if (commas > 0 && dots > 0) {
    // Last separator wins as decimal mark (id-ID and en-US both covered).
    normalized = text.lastIndexOf(',') > text.lastIndexOf('.')
      ? text.replace(/\./g, '').replace(',', '.')
      : text.replace(/,/g, '');
  } else if (commas === 1 && /^-?\d{1,3},\d{3}$/.test(text)) {
    normalized = text.replace(',', '');
  } else if (commas > 0) {
    normalized = text.replace(/,/g, '.');
  } else if (dots > 1) {
    normalized = text.replace(/\./g, '');
  }
  const n = Number(normalized);
  return Number.isFinite(n) ? n : null;
}

export function rowsToSheet(name: string, rows: string[][]): SheetSpec {
  const sheet = newSheet(name);
  rows.forEach((rowValues, r) => {
    rowValues.forEach((raw, c) => {
      if (r === 0) {
        // Header row stays text.
        if (raw.trim()) sheet.cells[formatCellRef(c, r)] = { v: raw.trim(), bold: true };
        return;
      }
      const value = inferScalar(raw);
      if (value === '') return;
      sheet.cells[formatCellRef(c, r)] = { v: value };
    });
  });
  return sheet;
}

export function importCsvToWorkbook(title: string, csvText: string, opts: { createdBy: string; model?: string; sheetName?: string }): WorkbookSpec {
  const wb = newWorkbook(title, opts);
  wb.sheets.push(rowsToSheet(opts.sheetName ?? 'Data', parseCsvText(csvText)));
  return wb;
}

export async function importXlsxToWorkbook(title: string, buffer: Buffer, opts: { createdBy: string; model?: string }): Promise<WorkbookSpec> {
  const source = new ExcelJS.Workbook();
  await source.xlsx.load(buffer as unknown as ExcelJS.Buffer);
  const wb = newWorkbook(title, opts);
  source.eachSheet((ws) => {
    const sheet = newSheet(ws.name);
    if (ws.properties.tabColor?.argb) sheet.tabColor = `#${ws.properties.tabColor.argb.slice(-6)}`;
    ws.eachRow({ includeEmpty: false }, (row) => {
      row.eachCell({ includeEmpty: false }, (cell) => {
        const value = cell.value as unknown;
        const ref = parseCellRef(cell.address);
        if (!ref) return;
        const key = formatCellRef(ref.col, ref.row);
        if (value && typeof value === 'object' && 'formula' in (value as Record<string, unknown>)) {
          const formula = String((value as { formula: unknown }).formula);
          sheet.cells[key] = { f: formula.startsWith('=') ? formula : `=${formula}` };
        } else if (value instanceof Date) {
          sheet.cells[key] = { v: value.toISOString().slice(0, 10) };
        } else if (typeof value === 'number' || typeof value === 'boolean') {
          sheet.cells[key] = { v: value };
        } else if (typeof value === 'string' && value.length > 0) {
          sheet.cells[key] = { v: value };
        } else if (value && typeof value === 'object' && 'text' in (value as Record<string, unknown>)) {
          const text = String((value as { text: unknown }).text);
          if (text) sheet.cells[key] = { v: text };
        }
        if (cell.numFmt && cell.numFmt !== 'General') (sheet.cells[key] as { fmt?: string }).fmt = cell.numFmt;
      });
    });
    (ws.columns ?? []).forEach((col, i) => {
      if (col.width) {
        const letter = formatCellRef(i, 0).replace(/[0-9]/g, '');
        sheet.colWidths = { ...(sheet.colWidths ?? {}), [letter]: Math.round(col.width) };
      }
    });
    const views = (ws.views ?? []) as Array<{ state?: string; xSplit?: number; ySplit?: number }>;
    const frozen = views.find((v) => v.state === 'frozen');
    if (frozen) sheet.frozen = { row: frozen.ySplit ?? 0, col: frozen.xSplit ?? 0 };
    for (const merge of Object.keys(ws.model.merges ?? {})) sheet.merges = [...(sheet.merges ?? []), String(merge)];
    wb.sheets.push(sheet);
  });
  if (wb.sheets.length === 0) wb.sheets.push(newSheet('Sheet1'));
  return wb;
}

/** Column type inference for blueprint review of imported data. */
export function inferColumnType(values: CellScalar[]): 'text' | 'number' | 'currency' | 'percent' | 'date' | 'boolean' {
  const sample = values.filter((v) => v !== '' && v !== null && v !== undefined);
  if (sample.length === 0) return 'text';
  if (sample.every((v) => typeof v === 'boolean')) return 'boolean';
  if (sample.every((v) => typeof v === 'number')) {
    if (sample.every((v) => typeof v === 'number' && v > 0 && v <= 1)) return 'percent';
    return 'number';
  }
  if (sample.every((v) => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}/.test(v))) return 'date';
  const numericRatio = sample.filter((v) => typeof v === 'number').length / sample.length;
  return numericRatio >= 0.8 ? 'number' : 'text';
}
