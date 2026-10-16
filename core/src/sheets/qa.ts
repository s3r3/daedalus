import { profileSheet, type DatasetProfile, type ProfiledColumn } from './analysis-profile.ts';
import { evaluateWorkbook } from './evaluator.ts';
import {
  formatCellRef,
  sheetBounds,
  sheetHeaders,
  type CellScalar,
  type SheetSpec,
  type WorkbookSpec,
} from './workbook.ts';

/**
 * Deterministic Q&A over a dataset sheet — the "Tanya jawab data"
 * surface of Dae Captain v2 Fase D. Zero LLM: the question is parsed
 * with plain regexes/token matching and every number is computed in
 * code from the sheet's cells (literal values, or evaluator-computed
 * values for formula cells). When a question cannot be answered from
 * the data the answer says so honestly — never guessed.
 *
 * Supported intents (Indonesian + English): sum/total, rata-rata/
 * average, max, min, count (rows or distinct values of a column),
 * top-N per kategori. Filters: "bulan X" (month name, against a date
 * or text column), "tahun NNNN", "…"-quoted values, and named
 * category values (e.g. a product name from the data itself).
 */

/* -------------------------------------------------- dataset plumbing */

export type QaIntent = 'sum' | 'avg' | 'max' | 'min' | 'count' | 'topn';

export type DatasetTable = {
  sheet: SheetSpec;
  profile: DatasetProfile;
  /** Header labels in column order (empty string when no header cell). */
  headers: string[];
  /** 0-based column index per headers position. */
  colIndexes: number[];
  /** Resolved cell values (literal, or evaluator-computed for formulas). */
  rows: Array<Array<CellScalar | undefined>>;
};

const HELPER_SHEET_NAMES = new Set(['asumsi', 'ringkasan']);

function isDatasetCandidate(sheet: SheetSpec): boolean {
  if (sheet.kind === 'dashboard') return false;
  if (sheet.hidden) return false;
  return !HELPER_SHEET_NAMES.has(sheet.name.trim().toLowerCase());
}

/**
 * The dataset is the non-helper sheet with the most data rows.
 * Exported so quick-dashboard.ts reuses the same rule.
 */
export function pickDatasetSheet(wb: WorkbookSpec): SheetSpec | null {
  let best: SheetSpec | null = null;
  let bestRows = 0;
  for (const sheet of wb.sheets) {
    if (!isDatasetCandidate(sheet)) continue;
    const profile = profileSheet(sheet);
    if (profile.rowCount > bestRows) {
      best = sheet;
      bestRows = profile.rowCount;
    }
  }
  return best;
}

/** Resolve every data cell: literal value, or the evaluator's result for formula cells. */
export function datasetTable(sheet: SheetSpec, wb: WorkbookSpec): DatasetTable {
  const profile = profileSheet(sheet);
  const headers = sheetHeaders(sheet);
  const colIndexes = [...headers.keys()].sort((a, b) => a - b);
  const headerNames = colIndexes.map((c) => headers.get(c) ?? '');
  const bounds = sheetBounds(sheet);
  const maxRow = bounds ? bounds.maxRow : 0;
  const evaluation = evaluateWorkbook(wb);
  const evalResults = evaluation.results.get(sheet.name);
  const rows: Array<Array<CellScalar | undefined>> = [];
  for (let r = 1; r <= maxRow; r += 1) {
    const row = colIndexes.map((c) => {
      const ref = formatCellRef(c, r);
      const cell = sheet.cells[ref];
      if (!cell) return undefined;
      if (cell.v !== undefined) return cell.v;
      if (cell.f) {
        const result = evalResults?.get(ref);
        if (result && result.kind === 'value' && result.value !== null) {
          return result.value as CellScalar;
        }
        return undefined;
      }
      return undefined;
    });
    // Skip entirely empty rows (common below sparse tables).
    if (row.some((v) => v !== undefined && v !== '')) rows.push(row);
  }
  return { sheet, profile, headers: headerNames, colIndexes, rows };
}

const NUM_CLEAN_RE = /[^\d.,\-+]/g;

export function toNumber(v: CellScalar | undefined): number | null {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v !== 'string') return null;
  let s = v.trim().replace(NUM_CLEAN_RE, '');
  if (!s) return null;
  const dots = (s.match(/\./g) ?? []).length;
  const commas = (s.match(/,/g) ?? []).length;
  if (dots > 0 && commas > 0) {
    // Both present: the LAST separator is the decimal one (id-ID:
    // "1.240,50" → 1240.5; en: "1,240.50" → 1240.5).
    if (s.lastIndexOf('.') > s.lastIndexOf(',')) s = s.replace(/,/g, '');
    else s = s.replace(/\./g, '').replace(/,/g, '.');
  } else if (dots > 0) {
    const parts = s.split('.');
    const tail = parts.slice(1);
    if (tail.every((p) => p.length === 3)) s = parts.join(''); // "25.000" → 25000
    else if (tail.length === 1 && tail[0]!.length <= 2) { /* "3.14" stays decimal */ }
    else s = parts.join('');
  } else if (commas > 0) {
    const parts = s.split(',');
    const tail = parts.slice(1);
    if (tail.every((p) => p.length === 3)) s = parts.join(''); // "25,000" → 25000
    else if (tail.length === 1 && tail[0]!.length <= 2) s = `${parts[0]}.${tail[0]}`; // "1,5" → 1.5
    else s = parts.join('');
  }
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

/** Columns whose type is numeric-like. */
export function numericColumns(profile: DatasetProfile): ProfiledColumn[] {
  return profile.columns.filter((c) => c.type === 'number' || c.type === 'currency' || c.type === 'percent');
}

/** The "kolom numerik utama": currency first, then fullest; ties break
 *  toward the RIGHTMOST column (amount/total columns usually sit last). */
export function mainNumericColumn(profile: DatasetProfile): ProfiledColumn | null {
  const numeric = numericColumns(profile);
  if (numeric.length === 0) return null;
  const order = new Map(profile.columns.map((c, i) => [c, i]));
  const ranked = [...numeric].sort((a, b) => {
    const typeRank = (t: ProfiledColumn['type']) => (t === 'currency' ? 0 : t === 'number' ? 1 : 2);
    return typeRank(a.type) - typeRank(b.type) || a.nullRate - b.nullRate || (order.get(b) ?? 0) - (order.get(a) ?? 0);
  });
  return ranked[0] ?? null;
}

/**
 * Semantic aliases: question words that name a *kind* of measure
 * without matching any header (e.g. "penjualan" when the column is
 * called "Total"/"Omzet").
 */
const MEASURE_ALIASES: Array<{ words: string[]; columnHints: string[] }> = [
  { words: ['penjualan', 'omzet', 'revenue', 'pendapatan', 'pemasukan', 'omset'], columnHints: ['total', 'omzet', 'omset', 'revenue', 'pendapatan', 'nilai', 'nominal', 'jumlah'] },
  { words: ['qty', 'kuantitas', 'unit', 'terjual', 'laris', 'terjual'], columnHints: ['qty', 'kuantitas', 'unit', 'jumlah', 'terjual', 'pcs'] },
  { words: ['harga', 'price'], columnHints: ['harga', 'price', 'satuan'] },
  { words: ['biaya', 'cost', 'pengeluaran'], columnHints: ['biaya', 'cost', 'pengeluaran', 'beban'] },
  { words: ['profit', 'laba', 'keuntungan', 'margin'], columnHints: ['profit', 'laba', 'keuntungan', 'margin'] },
];

function aliasScore(col: ProfiledColumn, tokens: string[]): number {
  const name = col.name.toLowerCase();
  let score = 0;
  for (const alias of MEASURE_ALIASES) {
    if (!alias.words.some((w) => tokens.includes(w))) continue;
    if (alias.columnHints.some((hint) => name.includes(hint))) score += 3;
  }
  return score;
}

/* --------------------------------------------------------- question parsing */

const STOP_WORDS = new Set([
  'yang', 'dan', 'dari', 'untuk', 'ini', 'itu', 'pada', 'dengan', 'berapa', 'apakah',
  'adalah', 'ada', 'dalam', 'saya', 'kamu', 'tolong', 'mohon', 'data', 'nya',
  'the', 'a', 'an', 'of', 'in', 'on', 'for', 'is', 'are', 'what', 'how', 'many', 'much',
]);

function tokensOf(question: string): string[] {
  return question
    .toLowerCase()
    .split(/[^a-z0-9]+/i)
    .filter((t) => t.length >= 3 && !STOP_WORDS.has(t));
}

const INTENT_PATTERNS: Array<{ intent: QaIntent; re: RegExp }> = [
  { intent: 'avg', re: /rata[-\s]?rata|rerata|average|mean/i },
  { intent: 'sum', re: /total|jumlahkan|sum\b|penjualan bersih/i },
  { intent: 'max', re: /maksimum|max\b|tertinggi|terbesar|paling (tinggi|besar|mahal|laku)/i },
  { intent: 'min', re: /minimum|min\b|terendah|terkecil|paling (rendah|kecil|murah)/i },
  { intent: 'topn', re: /top\s?\d+|(\d+)\s*(teratas|terlaris|terbesar)|paling laris|paling populer|laris/i },
  { intent: 'count', re: /berapa|jumlah|banyak|count\b/i },
];

const MONTHS_ID: Record<string, number> = {
  januari: 1, februari: 2, maret: 3, april: 4, mei: 5, juni: 6,
  juli: 7, agustus: 8, september: 9, oktober: 10, november: 11, desember: 12,
};
const MONTHS_EN: Record<string, number> = {
  january: 1, february: 2, march: 3, april: 4, may: 5, june: 6,
  july: 7, august: 8, september: 9, october: 10, november: 11, december: 12,
};

export type QaFilter = { kind: 'month' | 'year' | 'value'; column: string; value: string; colIndex: number };

type ParsedQuestion = {
  intent: QaIntent;
  topN: number;
  measure: ProfiledColumn | null;
  group: ProfiledColumn | null;
  filters: QaFilter[];
  unknownable: string | null;
};

function parseMonth(question: string): { month: number; name: string } | null {
  const lower = question.toLowerCase();
  for (const [name, m] of Object.entries({ ...MONTHS_ID, ...MONTHS_EN })) {
    if (new RegExp(`\\b${name}\\b`).test(lower)) return { month: m, name };
  }
  // "bulan 3" / "bulan ke-3"
  const m = /\bbulan(?:\s*ke)?\s*(\d{1,2})\b/i.exec(question);
  if (m) {
    const n = Number(m[1]);
    if (n >= 1 && n <= 12) {
      const idName = Object.keys(MONTHS_ID).find((k) => MONTHS_ID[k] === n) ?? String(n);
      return { month: n, name: idName };
    }
  }
  return null;
}

function colIndexOf(table: DatasetTable, name: string): number {
  const i = table.profile.columns.findIndex((c) => c.name === name);
  return i >= 0 ? (table.colIndexes[i] ?? -1) : -1;
}

function parseDateParts(v: CellScalar | undefined): { year: number; month: number; day: number } | null {
  if (typeof v !== 'string') return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(v.trim());
  if (m) return { year: Number(m[1]), month: Number(m[2]), day: Number(m[3]) };
  const m2 = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})/.exec(v.trim());
  if (m2) return { year: Number(m2[3]), month: Number(m2[2]), day: Number(m2[1]) };
  return null;
}

function valueMatchesFilter(v: CellScalar | undefined, filter: QaFilter): boolean {
  if (filter.kind === 'month') {
    const parts = parseDateParts(v);
    if (parts) return parts.month === Number(filter.value);
    return typeof v === 'string' && v.toLowerCase().includes(filter.value.toLowerCase());
  }
  if (filter.kind === 'year') {
    const parts = parseDateParts(v);
    if (parts) return parts.year === Number(filter.value);
    return typeof v === 'string' && v.includes(filter.value);
  }
  return v !== undefined && String(v).toLowerCase() === filter.value.toLowerCase();
}

function scoreColumnMention(col: ProfiledColumn, tokens: string[]): number {
  const name = col.name.toLowerCase();
  let score = 0;
  for (const token of tokens) {
    if (name.includes(token)) score += 2;
    else if (token.length >= 4 && name.split(/[^a-z0-9]+/).some((w) => w.startsWith(token.slice(0, 4)))) score += 1;
  }
  return score;
}

/**
 * Pick the measure column: best token match wins; ties break toward
 * numeric columns. Null when the question names nothing and no
 * numeric column exists.
 */
function resolveMeasure(table: DatasetTable, tokens: string[], intent: QaIntent): ProfiledColumn | null {
  if (intent === 'count') return null; // count resolves its own column/rows
  let best: ProfiledColumn | null = null;
  let bestScore = 0;
  for (const col of table.profile.columns) {
    if (col.type !== 'number' && col.type !== 'currency' && col.type !== 'percent') continue;
    const score = scoreColumnMention(col, tokens) + aliasScore(col, tokens);
    if (score > bestScore) { best = col; bestScore = score; }
  }
  if (best) return best;
  return mainNumericColumn(table.profile);
}

/** Parse filters: quoted values, "bulan X", "tahun NNNN", named category values. */
function parseFilters(question: string, table: DatasetTable): QaFilter[] {
  const filters: QaFilter[] = [];
  const lowered = question.toLowerCase();

  // 1) "bulan X" month filter — prefer a date column, else a text column mentioning the month.
  const month = parseMonth(question);
  if (month && /\bbulan\b/i.test(question)) {
    const dateCol = table.profile.columns.find((c) => c.type === 'date');
    if (dateCol) {
      filters.push({ kind: 'month', column: dateCol.name, value: String(month.month), colIndex: colIndexOf(table, dateCol.name) });
    } else {
      const textCol = table.profile.columns.find((c) => c.type === 'text' && c.samples.some((s) => s.toLowerCase().includes(month.name)));
      if (textCol) {
        filters.push({ kind: 'month', column: textCol.name, value: month.name, colIndex: colIndexOf(table, textCol.name) });
      }
    }
  }

  // 2) "tahun NNNN".
  const yearExplicit = /\btahun\s*(\d{4})\b/i.exec(question);
  const yearBare = yearExplicit ? null : /\b((?:19|20)\d{2})\b/.exec(question);
  const yearStr = yearExplicit?.[1] ?? yearBare?.[1] ?? null;
  if (yearStr) {
    const dateCol = table.profile.columns.find((c) => c.type === 'date');
    if (dateCol) {
      filters.push({ kind: 'year', column: dateCol.name, value: yearStr, colIndex: colIndexOf(table, dateCol.name) });
    }
  }

  // 3) Quoted literal: "..." or '...'.
  const quoted = /["'“”]([^"'“”]+)["'“”]/.exec(question);
  if (quoted) {
    const needle = (quoted[1] ?? '').trim().toLowerCase();
    const textCol = table.profile.columns.find((c) =>
      c.type === 'text' && c.samples.some((s) => s.toLowerCase() === needle),
    ) ?? table.profile.columns.find((c) => c.type === 'text');
    if (textCol) {
      filters.push({ kind: 'value', column: textCol.name, value: needle, colIndex: colIndexOf(table, textCol.name) });
    }
  }

  // 4) Named category values from the data (e.g. a product name).
  if (!quoted) {
    outer: for (const col of table.profile.columns) {
      if (col.type !== 'text' || col.cardinality === 0 || col.cardinality > 500) continue;
      const idx = colIndexOf(table, col.name);
      const distinct = new Set<string>();
      for (const row of table.rows) {
        const v = row[idx];
        if (typeof v === 'string' && v.trim().length >= 3) distinct.add(v.trim().toLowerCase());
      }
      const candidates = [...distinct]
        .filter((v) => !STOP_WORDS.has(v))
        .sort((a, b) => b.length - a.length);
      for (const value of candidates) {
        if (value.length < 3) continue;
        if (new RegExp(`\\b${value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i').test(question)) {
          filters.push({ kind: 'value', column: col.name, value, colIndex: idx });
          break outer;
        }
      }
    }
  }

  return filters;
}

/* -------------------------------------------------------------- answer */

export type QaAnswer = {
  ok: boolean;
  /** Human sentence (the chat bubble). */
  answer: string;
  /** Honest provenance: row count, column, filters. */
  method: string;
  sheet: string | null;
  intent: QaIntent | null;
  column: string | null;
  value: number | null;
  topRows: Array<{ label: string; value: number }> | null;
};

function fmtNumber(n: number, currency: boolean): string {
  const text = n.toLocaleString('id-ID', { maximumFractionDigits: 2 });
  return currency ? `Rp ${text}` : text;
}

function filterLabel(f: QaFilter): string {
  if (f.kind === 'month') {
    const idName = Object.keys(MONTHS_ID).find((k) => MONTHS_ID[k] === Number(f.value));
    return `bulan ${idName ?? f.value}`;
  }
  if (f.kind === 'year') return `tahun ${f.value}`;
  return `${f.column} = "${f.value}"`;
}

export function answerDataQuestion(workbook: WorkbookSpec, question: string): QaAnswer {
  const fail = (answer: string): QaAnswer => ({
    ok: false, answer, method: '', sheet: null, intent: null, column: null, value: null, topRows: null,
  });
  const q = question.trim();
  if (!q) return fail('Pertanyaannya kosong — tulis dulu pertanyaannya, misalnya "Berapa total penjualan bulan Januari?"');

  const sheet = pickDatasetSheet(workbook);
  if (!sheet) return fail('Tidak ada sheet dataset di workbook ini — tidak bisa dihitung dari dataset ini.');
  const table = datasetTable(sheet, workbook);
  if (table.rows.length === 0) return fail(`Sheet "${sheet.name}" tidak punya baris data — tidak bisa dihitung dari dataset ini.`);

  const parsed = parseQuestion(q, table);
  if (parsed.unknownable) return fail(parsed.unknownable);

  // Apply filters.
  const rows = parsed.filters.length === 0
    ? table.rows
    : table.rows.filter((row) => parsed.filters.every((f) => valueMatchesFilter(row[f.colIndex], f)));
  const filterText = parsed.filters.map(filterLabel).join(', ');

  const methodBase = (col: string | null): string =>
    `Dihitung dari ${rows.length.toLocaleString('id-ID')} baris${filterText ? ` (filter: ${filterText})` : ''}` +
    `${col ? `, kolom "${col}"` : ''} di sheet "${sheet.name}".`;

  switch (parsed.intent) {
    case 'sum':
    case 'avg':
    case 'max':
    case 'min': {
      const col = parsed.measure;
      if (!col) return fail('Tidak ada kolom numerik di dataset ini — tidak bisa dihitung dari dataset ini.');
      const idx = colIndexOf(table, col.name);
      const nums = rows.map((r) => toNumber(r[idx])).filter((n): n is number => n !== null);
      if (nums.length === 0) {
        return fail(`Kolom "${col.name}" tidak punya nilai angka pada baris yang cocok — tidak bisa dihitung dari dataset ini.`);
      }
      const currency = col.type === 'currency';
      let value: number;
      let verb: string;
      if (parsed.intent === 'sum') { value = nums.reduce((a, b) => a + b, 0); verb = 'Total'; }
      else if (parsed.intent === 'avg') { value = nums.reduce((a, b) => a + b, 0) / nums.length; verb = 'Rata-rata'; }
      else if (parsed.intent === 'max') { value = Math.max(...nums); verb = 'Nilai tertinggi'; }
      else { value = Math.min(...nums); verb = 'Nilai terendah'; }
      const opWord = parsed.intent === 'sum' ? 'SUM' : parsed.intent === 'avg' ? 'AVERAGE' : parsed.intent === 'max' ? 'MAX' : 'MIN';
      return {
        ok: true,
        answer: `${verb} "${col.name}"${filterText ? ` (${filterText})` : ''}: ${fmtNumber(value, currency)}.`,
        method: `${methodBase(col.name)} (${opWord} atas ${nums.length.toLocaleString('id-ID')} nilai angka).`,
        sheet: sheet.name, intent: parsed.intent, column: col.name, value, topRows: null,
      };
    }
    case 'count': {
      const col = parsed.countColumn;
      if (col) {
        const idx = colIndexOf(table, col.name);
        const distinct = new Set(rows.map((r) => { const v = r[idx]; return v === undefined || v === '' ? null : String(v); }).filter((v): v is string => v !== null));
        return {
          ok: true,
          answer: `Ada ${distinct.size.toLocaleString('id-ID')} nilai unik di kolom "${col.name}"${filterText ? ` (${filterText})` : ''}.`,
          method: methodBase(col.name),
          sheet: sheet.name, intent: 'count', column: col.name, value: distinct.size, topRows: null,
        };
      }
      return {
        ok: true,
        answer: `Ada ${rows.length.toLocaleString('id-ID')} baris data${filterText ? ` (${filterText})` : ''}.`,
        method: methodBase(null),
        sheet: sheet.name, intent: 'count', column: null, value: rows.length, topRows: null,
      };
    }
    case 'topn': {
      const group = parsed.group;
      const measure = parsed.measure;
      if (!group) return fail('Tidak ada kolom kategori di dataset ini — tidak bisa dihitung dari dataset ini.');
      if (!measure) return fail('Tidak ada kolom numerik di dataset ini — tidak bisa dihitung dari dataset ini.');
      const gIdx = colIndexOf(table, group.name);
      const mIdx = colIndexOf(table, measure.name);
      const totals = new Map<string, number>();
      for (const row of rows) {
        const label = row[gIdx];
        if (label === undefined || label === '') continue;
        const n = toNumber(row[mIdx]);
        if (n === null) continue;
        const key = String(label);
        totals.set(key, (totals.get(key) ?? 0) + n);
      }
      const top = [...totals.entries()].sort((a, b) => b[1] - a[1]).slice(0, parsed.topN);
      if (top.length === 0) return fail('Tidak ada pasangan kategori–angka yang valid — tidak bisa dihitung dari dataset ini.');
      const currency = measure.type === 'currency';
      const lines = top.map(([label, v], i) => `${i + 1}. ${label}: ${fmtNumber(v, currency)}`).join('\n');
      return {
        ok: true,
        answer: `Top ${top.length} "${group.name}" berdasarkan total "${measure.name}"${filterText ? ` (${filterText})` : ''}:\n${lines}`,
        method: `${methodBase(measure.name)} (SUM per "${group.name}", diurutkan menurun).`,
        sheet: sheet.name, intent: 'topn', column: measure.name, value: top[0]?.[1] ?? null,
        topRows: top.map(([label, value]) => ({ label, value })),
      };
    }
  }
}

type FullParsed = {
  intent: QaIntent;
  topN: number;
  measure: ProfiledColumn | null;
  group: ProfiledColumn | null;
  countColumn: ProfiledColumn | null;
  filters: QaFilter[];
  unknownable: string | null;
};

function parseQuestion(question: string, table: DatasetTable): FullParsed {
  const tokens = tokensOf(question);
  let intent: QaIntent | null = null;
  let topN = 5;
  for (const p of INTENT_PATTERNS) {
    if (p.re.test(question)) {
      intent = p.intent;
      if (p.intent === 'topn') {
        const m = /top\s?(\d+)|(\d+)\s*(teratas|terlaris|terbesar)/i.exec(question);
        topN = m ? Number(m[1] ?? m[2]) : 5;
        topN = Math.max(1, Math.min(50, topN));
      }
      break;
    }
  }
  if (!intent) {
    return {
      intent: 'count', topN, measure: null, group: null, countColumn: null, filters: [],
      unknownable: 'Maaf, saya tidak mengenali maksud pertanyaan ini. Yang bisa saya jawab dari dataset ini: total, rata-rata, nilai tertinggi/terendah, jumlah baris, dan top-N per kategori — misalnya "Berapa total penjualan bulan Januari?"',
    };
  }

  const filters = parseFilters(question, table);
  const measure = resolveMeasure(table, tokens, intent);

  // top-N needs a group column: named text column first, else first group candidate.
  let group: ProfiledColumn | null = null;
  if (intent === 'topn') {
    let best: ProfiledColumn | null = null;
    let bestScore = 0;
    for (const col of table.profile.columns) {
      if (col.type !== 'text') continue;
      const score = scoreColumnMention(col, tokens);
      if (score > bestScore) { best = col; bestScore = score; }
    }
    group = best
      ?? table.profile.columns.find((c) => table.profile.groupCandidates.includes(c.name))
      ?? table.profile.columns.find((c) => c.type === 'text')
      ?? null;
  }

  // count: a named non-numeric column → distinct count; "baris/rows" → row count.
  let countColumn: ProfiledColumn | null = null;
  if (intent === 'count') {
    let best: ProfiledColumn | null = null;
    let bestScore = 0;
    for (const col of table.profile.columns) {
      const score = scoreColumnMention(col, tokens);
      if (score > bestScore) { best = col; bestScore = score; }
    }
    countColumn = best;
  }

  return { intent, topN, measure, group, countColumn, filters, unknownable: null };
}

/** Human one-liner listing what a workbook's dataset can answer (for UI hints). */
export function qaCapabilities(workbook: WorkbookSpec): string[] {
  const sheet = pickDatasetSheet(workbook);
  if (!sheet) return [];
  const profile = profileSheet(sheet);
  const caps: string[] = [];
  const main = mainNumericColumn(profile);
  if (main) {
    caps.push(`Total / rata-rata / tertinggi / terendah kolom "${main.name}"`);
    const group = profile.groupCandidates[0] ?? profile.columns.find((c) => c.type === 'text')?.name;
    if (group) caps.push(`Top-N "${group}" berdasarkan "${main.name}"`);
  }
  caps.push('Jumlah baris data');
  if (profile.columns.some((c) => c.type === 'date')) caps.push('Filter bulan & tahun');
  return caps;
}
