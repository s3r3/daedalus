import type { DocumentState, ExtractRecord, FieldValue } from './document.ts';

/**
 * Tanya jawab dokumen (Fase C): jawab pertanyaan user berdasarkan HASIL
 * EKSTRAKSI (records), bukan teks mentah dan bukan tebakan model.
 * Deterministik: cocokkan kata kunci pertanyaan ke nama field, lalu
 * baca nilainya. Kalau tidak ada di data → found:false dengan jawaban
 * jujur "tidak menemukan" — tidak pernah halusinasi.
 */

export type QaSource = {
  recordId: string;
  field: string;
  quote?: string;
};

export type QaAnswer = {
  found: boolean;
  answer: string;
  /** 0..1 — keyakinan atas jawaban (bukan keyakinan ekstraksi). */
  confidence: number;
  source?: QaSource;
};

const STOPWORDS = new Set([
  'yang', 'di', 'ini', 'itu', 'dan', 'atau', 'dari', 'ke', 'dengan', 'untuk',
  'pada', 'adalah', 'berapa', 'apakah', 'bagaimana', 'dimana', 'kapan',
  'the', 'a', 'an', 'of', 'in', 'is', 'what', 'berapa', 'sih', 'dong',
  'tolong', 'coba', 'kan', 'saja', 'aja',
]);

/** Alias pertanyaan → nama field: kata user belum tentu sama dengan nama field. */
const FIELD_ALIASES: Record<string, string[]> = {
  total: ['jumlah', 'bayar', 'tagihan', 'nominal', 'nilai'],
  vendor: ['penjual', 'toko', 'perusahaan', 'penerbit', 'pengirim', 'pemasok', 'supplier'],
  invoice_number: ['nomor', 'faktur', 'invoice', 'no'],
  date: ['tanggal', 'kapan', 'waktu', 'tgl'],
  customer: ['pembeli', 'klien', 'pelanggan', 'client'],
};

const INTERROGATIVES = new Set(['berapa', 'apa', 'siapa', 'kapan', 'dimana', 'bagaimana', 'mana']);

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((t) => t.length > 1 && !STOPWORDS.has(t));
}

/**
 * Kata fokus: token konten yang bersebelahan dengan kata tanya
 * ("berapa TOTAL di invoice ini" → total; "nomor fakturnya BERAPA" → faktur).
 * Dipakai untuk menimbang field yang benar-benar ditanyakan, bukan sekadar
 * disebut sebagai konteks ("di invoice ini").
 */
function focusTokens(question: string): string[] {
  const raw = question.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter((t) => t.length > 1);
  const focus: string[] = [];
  for (let i = 0; i < raw.length; i++) {
    if (!INTERROGATIVES.has(raw[i]!)) continue;
    for (const j of [i - 1, i + 1]) {
      const t = raw[j];
      if (t && !STOPWORDS.has(t) && !INTERROGATIVES.has(t)) focus.push(t);
    }
  }
  return [...new Set(focus)];
}

function fieldTokens(name: string): string[] {
  return name
    .toLowerCase()
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .split(/[\s_\-]+/)
    .filter((t) => t.length > 0);
}

function prettyLabel(name: string): string {
  const special: Record<string, string> = {
    invoice_number: 'Nomor invoice',
    vendor: 'Vendor',
    total: 'Total',
    date: 'Tanggal',
    subtotal: 'Subtotal',
    tax: 'Pajak',
  };
  if (special[name]) return special[name];
  const s = name.replace(/_/g, ' ');
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function valueText(value: FieldValue['value']): string | null {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value === 'number') return value.toLocaleString('id-ID');
  return String(value);
}

type ScoredField = { name: string; score: number };

/** Stemming ringan Indonesia: tanggalnya → tanggal, vendornya → vendor. */
function stemId(w: string): string {
  const s = w.replace(/(nya|lah|kah|pun)$/, '');
  if (s.length >= 4) return s;
  const s2 = w.replace(/(ku|mu)$/, '');
  return s2.length >= 4 ? s2 : w;
}

/** Skor kecocokan nama field terhadap token pertanyaan (termasuk alias). */
function scoreField(name: string, questionTokens: string[], focus: string[]): number {
  const ft = fieldTokens(name);
  const matches = (q: string) => {
    const sq = stemId(q);
    return ft.some((f) => {
      const sf = stemId(f);
      return sf === sq || (sf.length > 3 && sq.length > 3 && (sf.startsWith(sq) || sq.startsWith(sf)));
    });
  };
  let score = 0;
  for (const q of questionTokens) {
    if (matches(q)) score += 2;
  }
  const aliases = FIELD_ALIASES[name] ?? [];
  const aliasMatch = (q: string) => aliases.some((a) => stemId(a) === stemId(q));
  for (const q of questionTokens) {
    const sq = stemId(q);
    if (aliasMatch(q)) score += 2;
    // Alias generik lintas field: "siapa/nama" → field bernama *nama*,
    // "nomor" → field *nomor*/number, "tanggal" → field tanggal/date.
    if ((sq === 'siapa' || sq === 'nama') && /nama|name/.test(name)) score += 2;
    if (sq === 'nomor' && /nomor|number|^no$/.test(name)) score += 2;
    if ((sq === 'tanggal' || sq === 'kapan') && /tanggal|date/.test(name)) score += 2;
  }
  // Bonus fokus: kata di sebelah kata tanya adalah yang benar-benar ditanyakan.
  for (const q of focus) {
    if (matches(q) || aliasMatch(q)) score += 4;
  }
  return score;
}

function bestField(doc: DocumentState, questionTokens: string[], focus: string[]): ScoredField | null {
  const names = doc.schema
    ? doc.schema.fields.map((f) => f.name)
    : [...new Set(doc.records.flatMap((r) => Object.keys(r.fields)))];
  let best: ScoredField | null = null;
  for (const name of names) {
    const score = scoreField(name, questionTokens, focus);
    if (score > 0 && (!best || score > best.score)) best = { name, score };
  }
  return best;
}

function fieldType(doc: DocumentState, name: string): string | undefined {
  return doc.schema?.fields.find((f) => f.name === name)?.type;
}

type ValuedHit = { record: ExtractRecord; fv: FieldValue; text: string };

function valuedHits(records: ExtractRecord[], field: string): ValuedHit[] {
  const hits: ValuedHit[] = [];
  for (const record of records) {
    const fv = record.fields[field];
    if (!fv) continue;
    const text = valueText(fv.value);
    if (text === null) continue;
    hits.push({ record, fv, text });
  }
  return hits;
}

function answerFromField(doc: DocumentState, field: string, questionTokens: string[]): QaAnswer | null {
  const hits = valuedHits(doc.records, field);
  if (hits.length === 0) return null;
  const label = prettyLabel(field);
  const avgConf = hits.reduce((s, h) => s + h.fv.confidence, 0) / hits.length;

  // Agregasi jujur: "berapa total ..." atas BANYAK record numerik → jumlahkan,
  // sebutkan eksplisit itu penjumlahan.
  const wantsSum = questionTokens.some((t) => ['total', 'jumlah', 'berapa'].includes(t));
  const type = fieldType(doc, field);
  const numeric = hits.every((h) => typeof h.fv.value === 'number');
  if (wantsSum && hits.length > 1 && numeric && (type === 'money' || type === 'number' || type === undefined)) {
    const sum = hits.reduce((s, h) => s + (h.fv.value as number), 0);
    return {
      found: true,
      answer: `${label} dari ${hits.length} record: ${sum.toLocaleString('id-ID')}.`,
      confidence: Math.min(0.85, 0.5 + avgConf / 2),
    };
  }

  if (hits.length === 1) {
    const h = hits[0]!;
    return {
      found: true,
      answer: `${label}: ${h.text}.`,
      confidence: Math.min(0.95, 0.5 + h.fv.confidence / 2),
      source: { recordId: h.record.id, field, quote: h.fv.provenance?.quote },
    };
  }

  const distinct = [...new Set(hits.map((h) => h.text))];
  const shown = distinct.slice(0, 5).join('; ');
  const more = distinct.length > 5 ? ` (+${distinct.length - 5} lagi)` : '';
  return {
    found: true,
    answer: `${label} (${distinct.length} nilai dari ${hits.length} record): ${shown}${more}.`,
    confidence: Math.min(0.8, 0.4 + avgConf / 2),
  };
}

/** Fallback: cari token pertanyaan di nilai field & kutipan provenance. */
function answerByKeyword(doc: DocumentState, questionTokens: string[]): QaAnswer | null {
  const keywords = questionTokens.filter((t) => t.length > 2);
  if (keywords.length === 0) return null;
  let best: { record: ExtractRecord; field: string; text: string; hits: number; conf: number } | null = null;
  for (const record of doc.records) {
    for (const [field, fv] of Object.entries(record.fields)) {
      const text = valueText(fv.value);
      if (!text || text.length > 300) continue;
      const lower = text.toLowerCase();
      const hits = keywords.filter((k) => lower.includes(k)).length;
      if (hits > 0 && (!best || hits > best.hits)) {
        best = { record, field, text, hits, conf: fv.confidence };
      }
      const quote = fv.provenance?.quote;
      if (quote) {
        const ql = quote.toLowerCase();
        const qhits = keywords.filter((k) => ql.includes(k)).length;
        if (qhits > 0 && (!best || qhits > best.hits)) {
          best = { record, field, text, hits: qhits, conf: fv.confidence };
        }
      }
    }
  }
  if (!best) return null;
  return {
    found: true,
    answer: `${prettyLabel(best.field)}: ${best.text}.`,
    confidence: 0.6,
    source: { recordId: best.record.id, field: best.field },
  };
}

export function answerDocumentQuestion(doc: DocumentState, question: string): QaAnswer {
  if (doc.records.length === 0) {
    return {
      found: false,
      confidence: 0,
      answer: 'Belum ada hasil ekstraksi pada dokumen ini — jalankan ekstraksi dulu, baru saya bisa menjawab dari datanya.',
    };
  }
  const tokens = tokenize(question);
  if (tokens.length === 0) {
    return { found: false, confidence: 0, answer: 'Pertanyaannya kurang jelas — coba sebutkan field yang ingin ditanyakan, mis. "berapa totalnya?"' };
  }

  const focus = focusTokens(question);
  const field = bestField(doc, tokens, focus);
  if (field) {
    const answer = answerFromField(doc, field.name, tokens);
    if (answer) return answer;
  }
  const keyword = answerByKeyword(doc, tokens);
  if (keyword) return keyword;

  return {
    found: false,
    confidence: 0,
    answer: 'Saya tidak menemukan jawabannya di data hasil ekstraksi dokumen ini.',
  };
}
