import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { DokumenSchema, ExtractRecord, FieldStatus } from './document.ts';

/**
 * Batch ekstrak → CSV gabungan (Fase C / desain 4.3): gabungkan record
 * hasil ekstraksi dari BANYAK dokumen menjadi satu CSV. Deterministik —
 * tanpa model: ekstraksi per dokumen tetap lewat alur normal (task),
 * di sini hanya penggabungan + penandaan review.
 *
 * Field yang gagal / confidence rendah TIDAK dibuang diam-diam:
 * barisnya ikut CSV dengan kolom _review = "perlu review", dan
 * daftarnya dikembalikan di `review` untuk kartu [⚠️ N field perlu review].
 */

export type BatchDocOk = {
  ok: true;
  docId: string;
  filename: string;
  schema: DokumenSchema;
  records: ExtractRecord[];
};

export type BatchDocFailed = {
  ok: false;
  docId: string;
  filename: string;
  error: string;
};

export type BatchDocInput = BatchDocOk | BatchDocFailed;

export type ReviewItem = {
  file: string;
  recordId: string;
  field: string;
  confidence: number;
  status: FieldStatus;
  reason: string;
};

export type BatchFailedFile = { file: string; error: string };

export type BatchMergeResult = {
  csv: string;
  /** Kolom CSV: _file, ...field, _decision, _review. */
  columns: string[];
  fileCount: number;
  recordCount: number;
  /** Sel data = recordCount × jumlah kolom field. */
  fieldCount: number;
  review: ReviewItem[];
  failed: BatchFailedFile[];
};

/** Ambang confidence di bawah ini → tandai untuk review (konsisten dengan kartu ekstraksi: < 70%). */
export const BATCH_REVIEW_CONFIDENCE = 0.7;

function csvEscape(value: unknown): string {
  if (value === null || value === undefined) return '';
  const text = String(value);
  return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function reviewReason(field: { value: unknown; confidence: number; status: FieldStatus }, required: boolean): string | null {
  if (field.status === 'flagged' || field.status === 'escalated') {
    return `status ${field.status} — perlu tinjauan manusia`;
  }
  if (required && (field.value === null || field.value === undefined || field.value === '')) {
    return 'field wajib kosong';
  }
  if (field.confidence < BATCH_REVIEW_CONFIDENCE) {
    return `confidence rendah (${Math.round(field.confidence * 100)}%)`;
  }
  return null;
}

export function mergeBatchToCsv(inputs: BatchDocInput[]): BatchMergeResult {
  const failed: BatchFailedFile[] = [];
  const okDocs = inputs.filter((d): d is BatchDocOk => d.ok);
  for (const d of inputs) {
    if (!d.ok) failed.push({ file: d.filename, error: d.error });
  }

  // Union kolom field sesuai urutan kemunculan pertama.
  const fieldNames: string[] = [];
  const requiredByField = new Map<string, boolean>();
  for (const doc of okDocs) {
    for (const f of doc.schema.fields) {
      if (!fieldNames.includes(f.name)) fieldNames.push(f.name);
      if (f.required) requiredByField.set(f.name, true);
    }
  }

  const columns = ['_file', ...fieldNames, '_decision', '_review'];
  const review: ReviewItem[] = [];
  const lines = [columns.map(csvEscape).join(',')];
  let recordCount = 0;

  for (const doc of okDocs) {
    for (const record of doc.records) {
      recordCount++;
      const rowReview: string[] = [];
      const cells: unknown[] = [doc.filename];
      for (const name of fieldNames) {
        const fv = record.fields[name];
        if (!fv) {
          cells.push('');
          if (requiredByField.get(name)) {
            rowReview.push(name);
            review.push({ file: doc.filename, recordId: record.id, field: name, confidence: 0, status: 'flagged', reason: 'field wajib tidak ada di record' });
          }
          continue;
        }
        cells.push(fv.value);
        const reason = reviewReason(fv, requiredByField.get(name) ?? false);
        if (reason) {
          rowReview.push(name);
          review.push({ file: doc.filename, recordId: record.id, field: name, confidence: fv.confidence, status: fv.status, reason });
        }
      }
      cells.push(record.decision, rowReview.length > 0 ? 'perlu review' : 'ok');
      lines.push(cells.map(csvEscape).join(','));
    }
  }

  return {
    csv: `${lines.join('\n')}\n`,
    columns,
    fileCount: okDocs.length,
    recordCount,
    fieldCount: recordCount * fieldNames.length,
    review,
    failed,
  };
}

/** Tulis CSV gabungan ke .daedalus/documents/batch/exports/. Kembalikan path relatif-workspace. */
export async function writeBatchCsv(root: string, csv: string): Promise<{ relPath: string; filename: string }> {
  const dir = join(root, '.daedalus', 'documents', 'batch', 'exports');
  await mkdir(dir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const filename = `batch-${stamp}.csv`;
  await writeFile(join(dir, filename), csv, 'utf8');
  return { relPath: `.daedalus/documents/batch/exports/${filename}`, filename };
}
