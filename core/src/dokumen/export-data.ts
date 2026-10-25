import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import ExcelJS from 'exceljs';
import { documentPaths, type DocumentState } from './document.ts';
import { isVerified } from './validate.ts';

/**
 * Data export with the verification gate (design honesty rule 10c):
 * only verified records leave (auto-clear, or every non-auto field
 * human-corrected). Held-back records are counted and reported — never
 * silently mixed in. XLSX from Ekstrak is a *data dump* with a status
 * column, not a SpreadsheetEngine workbook.
 */

export type DataExportResult = {
  format: 'json' | 'csv' | 'xlsx';
  path: string;
  recordCount: number;
  heldBack: number;
};

function exportRows(doc: DocumentState): { rows: Array<Record<string, unknown>>; heldBack: number } {
  const fields = doc.schema?.fields ?? [];
  const rows: Array<Record<string, unknown>> = [];
  let heldBack = 0;
  for (const record of doc.records) {
    if (!isVerified(record)) {
      heldBack++;
      continue;
    }
    const row: Record<string, unknown> = { _source: record.sourceId, _decision: record.decision };
    for (const field of fields) {
      const fv = record.fields[field.name];
      row[field.name] = fv ? fv.value : null;
    }
    row._status = fields.map((f) => `${f.name}:${record.fields[f.name]?.status ?? 'missing'}`).join(' ');
    rows.push(row);
  }
  return { rows, heldBack };
}

function csvEscape(value: unknown): string {
  if (value === null || value === undefined) return '';
  const text = String(value);
  return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

export async function exportData(root: string, doc: DocumentState, format: 'json' | 'csv' | 'xlsx'): Promise<DataExportResult> {
  if (!doc.schema) throw new Error('document has no schema — nothing to export as data');
  const paths = documentPaths(root, doc.id);
  await mkdir(paths.exportsDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const { rows, heldBack } = exportRows(doc);
  const rel = `.daedalus/documents/${doc.id}/exports/records-${stamp}.${format}`;
  const abs = join(paths.exportsDir, `records-${stamp}.${format}`);

  if (format === 'json') {
    await writeFile(abs, `${JSON.stringify(rows, null, 2)}\n`, 'utf8');
  } else if (format === 'csv') {
    const columns = ['_source', '_decision', ...doc.schema.fields.map((f) => f.name), '_status'];
    const lines = [columns.join(','), ...rows.map((row) => columns.map((col) => csvEscape(row[col])).join(','))];
    await writeFile(abs, `${lines.join('\n')}\n`, 'utf8');
  } else {
    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet('Records');
    const columns = ['_source', '_decision', ...doc.schema.fields.map((f) => f.name), '_status'];
    sheet.addRow(columns);
    for (const row of rows) {
      sheet.addRow(columns.map((col) => {
        const v = row[col];
        return v === null || v === undefined ? '' : v;
      }));
    }
    await workbook.xlsx.writeFile(abs);
  }

  const result: DataExportResult = { format, path: rel, recordCount: rows.length, heldBack };
  doc.exports.push({ format, path: rel, recordCount: rows.length, heldBack, at: new Date().toISOString() });
  return result;
}
