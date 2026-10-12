import type { DokumenSchema, ExtractRecord, FieldValue, RecordCheck } from './document.ts';

/**
 * Deterministic validation — the model never validates (design
 * decision 4: "The LLM reads. Deterministic code does the math").
 * Everything here is pure: normalize raw reads into typed values,
 * reconcile arithmetic (subtotal + tax − discount = total), check
 * formats and required completeness, derive a missing total-family
 * field BY CODE when the equation determines it (flagged, never
 * guessed), and route each record to AUTO-CLEAR / FLAG / ESCALATE from
 * confidence × check outcomes. The model is never asked to recompute.
 */

export const AUTO_CLEAR_MIN = 0.8;
export const ESCALATE_BELOW = 0.45;

const TOTAL_FAMILY: Record<string, 'subtotal' | 'tax' | 'discount' | 'total'> = {
  subtotal: 'subtotal',
  sub_total: 'subtotal',
  tax: 'tax',
  ppn: 'tax',
  vat: 'tax',
  pajak: 'tax',
  discount: 'discount',
  diskon: 'discount',
  total: 'total',
  grand_total: 'total',
  jumlah: 'total',
};

export function parseNumber(raw: string): number | null {
  const cleaned = raw.replace(/[^0-9.,-]/g, '').trim();
  if (!cleaned || cleaned === '-' || cleaned === '.') return null;
  let normalized = cleaned;
  const lastComma = cleaned.lastIndexOf(',');
  const lastDot = cleaned.lastIndexOf('.');
  if (lastComma === -1 && /^\d{1,3}(\.\d{3})+$/.test(cleaned)) {
    // Dots only, in 3-digit groups: Indonesian thousands (1.234.567).
    normalized = cleaned.replace(/\./g, '');
  } else if (lastComma > lastDot && cleaned.indexOf(',') === lastComma) {
    // One comma, after any dots: Indonesian/European decimal comma (1.234.567,89).
    normalized = cleaned.replace(/\./g, '').replace(',', '.');
  } else if (lastComma > lastDot) {
    // Several commas, no dot: US thousands (1,234,567).
    normalized = cleaned.replace(/,/g, '');
  } else if (lastComma >= 0 && lastDot >= 0) {
    // US: 1,234,567.89
    normalized = cleaned.replace(/,/g, '');
  } else if (lastComma >= 0) {
    // Only a comma: decimal comma when 1-2 digits follow, else thousands.
    const digitsAfter = cleaned.length - lastComma - 1;
    normalized = digitsAfter <= 2 ? cleaned.replace(',', '.') : cleaned.replace(/,/g, '');
  }
  const value = Number(normalized);
  return Number.isFinite(value) ? value : null;
}

const MONTHS: Record<string, number> = {
  januari: 1, februari: 2, maret: 3, april: 4, mei: 5, juni: 6, juli: 7, agustus: 8, september: 9, oktober: 10, november: 11, desember: 12,
  january: 1, february: 2, march: 3, may: 5, june: 6, july: 7, august: 8,
};

export function parseDate(raw: string): string | null {
  const text = raw.trim();
  const iso = text.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (iso) return `${iso[1]}-${iso[2]}-${iso[3]}`;
  const dmy = text.match(/^(\d{1,2})[/.\-](\d{1,2})[/.\-](\d{2,4})$/);
  if (dmy) {
    const year = dmy[3]!.length === 2 ? `20${dmy[3]}` : dmy[3]!;
    return `${year}-${dmy[2]!.padStart(2, '0')}-${dmy[1]!.padStart(2, '0')}`;
  }
  const long = text.toLowerCase().match(/^(\d{1,2})\s+([a-z]+)\s+(\d{4})$/);
  if (long && MONTHS[long[2]!]) {
    return `${long[3]}-${String(MONTHS[long[2]!]).padStart(2, '0')}-${long[1]!.padStart(2, '0')}`;
  }
  return null;
}

export function normalizeValue(field: { type: string }, fv: FieldValue): FieldValue {
  if (fv.value === null || fv.value === undefined) return fv;
  const raw = typeof fv.value === 'string' ? fv.value : String(fv.value);
  switch (field.type) {
    case 'number':
    case 'money': {
      if (typeof fv.value === 'number') return fv;
      const parsed = parseNumber(raw);
      if (parsed === null) return { ...fv, value: null, raw, status: fv.status === 'corrected' ? 'corrected' : 'escalated', note: `nilai "${raw}" tidak terbaca sebagai angka` };
      return { ...fv, value: parsed, raw };
    }
    case 'date': {
      const parsed = parseDate(raw);
      if (parsed === null) return { ...fv, value: null, raw, status: fv.status === 'corrected' ? 'corrected' : 'escalated', note: `tanggal "${raw}" tidak dikenal formatnya` };
      return { ...fv, value: parsed, raw };
    }
    case 'email': {
      const ok = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(raw.trim());
      return ok ? { ...fv, value: raw.trim().toLowerCase(), raw } : { ...fv, value: null, raw, status: fv.status === 'corrected' ? 'corrected' : 'escalated', note: `"${raw}" bukan alamat email yang sah` };
    }
    case 'boolean': {
      const lower = raw.trim().toLowerCase();
      if (['true', 'ya', 'yes', '1'].includes(lower)) return { ...fv, value: true, raw };
      if (['false', 'tidak', 'no', '0'].includes(lower)) return { ...fv, value: false, raw };
      return { ...fv, value: null, raw, status: fv.status === 'corrected' ? 'corrected' : 'escalated', note: `"${raw}" tidak terbaca sebagai ya/tidak` };
    }
    default:
      return { ...fv, value: raw.trim(), raw };
  }
}

/**
 * Validate + route one record against the schema. Pure; the record is
 * mutated in place (freshly built by the extract stage) and returned.
 */
export function validateRecord(record: ExtractRecord, schema: DokumenSchema): ExtractRecord {
  const autoClearMin = schema.autoClearMin ?? AUTO_CLEAR_MIN;
  const escalateBelow = schema.escalateBelow ?? ESCALATE_BELOW;
  const checks: RecordCheck[] = [];

  for (const field of schema.fields) {
    const fv = record.fields[field.name];
    if (!fv) {
      record.fields[field.name] = {
        value: null,
        confidence: 0,
        status: 'escalated',
        note: 'field tidak ditemukan di dokumen',
      };
      continue;
    }
    const normalized = normalizeValue(field, fv);
    record.fields[field.name] = normalized;
    if (normalized.value !== null && normalized.confidence < escalateBelow && normalized.status !== 'corrected') {
      normalized.status = 'escalated';
      normalized.note = normalized.note ?? `keyakinan bacaan rendah (${normalized.confidence.toFixed(2)})`;
    }
  }

  // Arithmetic reconciliation over the total family. When exactly one
  // member is missing and the rest determine it, CODE derives it and
  // flags it (design: "yang hilang diturunkan oleh kode dan ditandai").
  const family = new Map<string, string>();
  for (const field of schema.fields) {
    const role = TOTAL_FAMILY[field.name.toLowerCase()];
    if (role) family.set(role, field.name);
  }
  if (family.has('total') && (family.has('subtotal') || family.has('tax') || family.has('discount'))) {
    const get = (role: string): number | null => {
      const name = family.get(role);
      if (!name) return null;
      const v = record.fields[name]?.value;
      return typeof v === 'number' ? v : null;
    };
    const subtotal = get('subtotal');
    const tax = get('tax') ?? (family.has('tax') ? null : 0);
    const discount = get('discount') ?? (family.has('discount') ? null : 0);
    const total = get('total');
    const expected = subtotal !== null && tax !== null && discount !== null ? subtotal + tax - discount : null;
    const totalFv = record.fields[family.get('total')!];
    // Derive only for a genuinely ABSENT read (no raw text) — never over
    // an escalated unreadable value, which must stay escalated (honesty).
    if (expected !== null && total === null && totalFv && !totalFv.raw && totalFv.status !== 'corrected') {
      const fv = record.fields[family.get('total')!]!;
      record.fields[family.get('total')!] = {
        ...fv,
        value: Math.round(expected * 100) / 100,
        status: 'flagged',
        note: 'diturunkan oleh kode dari subtotal + pajak − diskon (bukan dibaca dari dokumen)',
      };
      checks.push({ rule: 'arithmetic-total', passed: false, detail: `total tidak terbaca; diturunkan oleh kode = ${Math.round(expected * 100) / 100}` });
    } else if (expected !== null && total !== null) {
      const tolerance = Math.max(1, Math.abs(expected) * 0.005);
      const passed = Math.abs(total - expected) <= tolerance;
      checks.push({
        rule: 'arithmetic-total',
        passed,
        detail: passed
          ? `subtotal + pajak − diskon = ${Math.round(expected * 100) / 100} cocok dengan total ${total}`
          : `total terbaca ${total}, hasil hitung kode ${Math.round(expected * 100) / 100} — selisih ${Math.round((total - expected) * 100) / 100}`,
      });
      if (!passed) {
        const totalField = record.fields[family.get('total')!]!;
        if (totalField.status === 'auto') totalField.status = 'flagged';
        totalField.note = totalField.note ?? 'total tidak cocok dengan hitungan kode';
      }
    }
  }

  // Required completeness.
  for (const field of schema.fields) {
    if (!field.required) continue;
    const fv = record.fields[field.name]!;
    const missing = fv.value === null || fv.value === undefined || fv.value === '';
    checks.push({ rule: `required:${field.name}`, passed: !missing, detail: missing ? `field wajib "${field.name}" kosong` : `field wajib "${field.name}" terisi` });
  }

  record.checks = checks;
  const fields = Object.values(record.fields);
  const anyEscalated = fields.some((f) => f.status === 'escalated');
  const anyCheckFailed = checks.some((c) => !c.passed);
  const anyFlagged = fields.some((f) => f.status === 'flagged');
  const allConfident = fields.every((f) => f.status === 'corrected' || f.confidence >= autoClearMin || f.value === null);
  if (anyEscalated) record.decision = 'escalate';
  else if (anyCheckFailed || anyFlagged || !allConfident) record.decision = 'flag';
  else record.decision = 'auto-clear';
  return record;
}

/** Verified = auto-clear, or a human corrected every non-auto field. */
export function isVerified(record: ExtractRecord): boolean {
  if (record.decision === 'auto-clear') return true;
  return Object.values(record.fields).every((f) => f.status === 'auto' || f.status === 'corrected');
}

export function decisionCounts(records: ExtractRecord[]): { autoClear: number; flag: number; escalate: number; verified: number; heldBack: number } {
  let autoClear = 0;
  let flag = 0;
  let escalate = 0;
  let verified = 0;
  for (const record of records) {
    if (record.decision === 'auto-clear') autoClear++;
    else if (record.decision === 'flag') flag++;
    else escalate++;
    if (isVerified(record)) verified++;
  }
  return { autoClear, flag, escalate, verified, heldBack: records.length - verified };
}
