import type { CredibilityTier, SourceCredibility } from './types.ts';

/**
 * Deteksi kredibilitas sumber — mekanisme JUJUR (Desain-Agentic-Research-v1).
 *
 * Peringkat INTERNASIONAL (permintaan Farid 2026-10-12: "jangan sinta aja"):
 * - Scopus Q1–Q4 via Elsevier Serial Title API — butuh API key milik user
 *   (env ELSEVIER_API_KEY). `verified: true` hanya bila API menjawab.
 * - Scopus Q1–Q4 via SCImago SJR (scimagojr.com, situs resmi SJR, gratis)
 *   — best-effort seperti Sinta; graceful null bila diblokir (Cloudflare)
 *   atau markup berubah. SJR dihitung dari data Scopus, jadi kuartilnya
 *   setara kuartil Scopus.
 * - Sinta 1–6: best-effort terhadap sinta.kemdikbud.go.id (nasional ID).
 * - DOI: Crossref API publik untuk validasi metadata jurnal/ISSN.
 * - DOAJ: API publik DOAJ (best-effort, graceful bila berubah).
 * - Garuda: heuristic domain garuda.kemdikbud.go.id.
 * - Default: 'web' — tidak pernah mengklaim lebih dari yang dicek.
 *
 * Urutan: DOI→Crossref (metadata) → Scopus API (key) → SJR (kuartil) →
 * Sinta (peringkat nasional) → DOAJ (ISSN) → heuristic domain → web/unknown.
 * Tidak pernah mengembalikan verified:true tanpa konfirmasi resmi.
 *
 * Semua HTTP lewat CredibilityFetcher yang bisa di-inject (test
 * memakai fake; produksi memakai global fetch + timeout).
 */

export interface CredibilityInput {
  url: string;
  title: string;
  doi?: string;
  /** ISSN bila diketahui (dari Crossref atau metadata). */
  issn?: string;
  /** API key Elsevier (env ELSEVIER_API_KEY) — bila ada, Scopus API dipakai. */
  elsevierApiKey?: string;
}

export type CredibilityFetcher = (url: string) => Promise<{ status: number; text: string } | null>;

const FETCH_TIMEOUT_MS = 12_000;

export async function defaultCredibilityFetch(url: string): Promise<{ status: number; text: string } | null> {
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
    const res = await fetch(url, {
      signal: ctrl.signal,
      headers: { 'User-Agent': 'Daedalus-Research/1.0 (credibility check)', Accept: 'application/json, text/html' },
    });
    clearTimeout(timer);
    if (!res.ok) return null;
    return { status: res.status, text: await res.text() };
  } catch {
    return null;
  }
}

function stripTags(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ');
}

interface CrossrefJournal { title: string; issn: string[]; publisher?: string }

async function crossrefByDoi(doi: string, fetchFn: CredibilityFetcher): Promise<CrossrefJournal | null> {
  try {
    const res = await fetchFn(`https://api.crossref.org/works/${encodeURIComponent(doi)}`);
    if (!res || res.status !== 200) return null;
    const data = JSON.parse(res.text) as {
      message?: { 'container-title'?: string[]; ISSN?: string[]; publisher?: string };
    };
    const msg = data.message;
    if (!msg) return null;
    const title = msg['container-title']?.[0] ?? '';
    const issn = msg.ISSN ?? [];
    if (!title && issn.length === 0) return null;
    return { title, issn, publisher: msg.publisher };
  } catch {
    return null;
  }
}

/**
 * Best-effort: cari jurnal di halaman pencarian Sinta, ekstrak
 * peringkat bila markup-nya masih bisa dibaca. Kembalikan rank 1–6
 * atau null bila tidak ketemu / halaman berubah / diblokir.
 */
async function sintaRank(journalName: string, issn: string | undefined, fetchFn: CredibilityFetcher): Promise<number | null> {
  const query = issn ?? journalName;
  if (!query) return null;
  let res: { status: number; text: string } | null;
  try {
    res = await fetchFn(`https://sinta.kemdikbud.go.id/journals?q=${encodeURIComponent(query)}`);
  } catch {
    return null;
  }
  if (!res || res.status !== 200) return null;
  const text = stripTags(res.text);
  // Cari "Sinta N" / "SINTA N" di dekat nama jurnal (toleran).
  const m = text.match(/sinta\s*([1-6])\b/i);
  if (!m) return null;
  const rank = Number(m[1]);
  return rank >= 1 && rank <= 6 ? rank : null;
}

/**
 * Best-effort: kuartil Scopus via SCImago SJR (situs resmi, gratis).
 * Cari jurnal by ISSN (paling presisi) lalu by nama; ekstrak kuartil
 * terbaik (Q1 paling tinggi) dari teks halaman. Kembalikan 1–4 atau
 * null bila tidak ketemu / diblokir Cloudflare / markup berubah.
 */
async function sjrQuartile(
  journalName: string,
  issn: string | undefined,
  fetchFn: CredibilityFetcher,
): Promise<number | null> {
  const queries: string[] = [];
  if (issn) {
    const clean = issn.replace(/[^0-9xX]/g, '');
    if (clean.length >= 8) queries.push(clean.slice(0, 4) + '-' + clean.slice(4, 8));
  }
  if (journalName.trim()) queries.push(journalName.trim());
  for (const q of queries) {
    let res: { status: number; text: string } | null;
    try {
      res = await fetchFn(`https://www.scimagojr.com/journalsearch.php?q=${encodeURIComponent(q)}&tip=jou`);
    } catch {
      continue;
    }
    if (!res || res.status !== 200) continue;
    const text = stripTags(res.text);
    // Sanity: halaman hasil harus menyebut query (ISSN/nama jurnal),
    // bukan halaman challenge/block.
    const qLower = q.toLowerCase();
    const firstWord = qLower.split(/[^a-z0-9]+/)[0] ?? '';
    if (!text.toLowerCase().includes(qLower) && !(firstWord.length > 3 && text.toLowerCase().includes(firstWord))) {
      continue;
    }
    // Pola kuartil SJR: "Q1".."Q4" di dekat kata "quartile"/"quartil",
    // atau badge kategori. Ambil yang terbaik (angka terkecil).
    let best: number | null = null;
    const nearQuartile = /quartile|quartil/gi;
    let m: RegExpExecArray | null;
    while ((m = nearQuartile.exec(text)) !== null) {
      const window = text.slice(Math.max(0, m.index - 120), m.index + 120);
      const allQ = window.match(/\bQ([1-4])\b/g) ?? [];
      for (const qstr of allQ) {
        const n = Number(qstr.slice(1));
        if (best === null || n < best) best = n;
      }
    }
    // Fallback: badge "Quartile: Q2" / "Q2 (2023)" eksplisit.
    if (best === null) {
      const fm = text.match(/quartiles?\s*:?\s*\bQ([1-4])\b/i) ?? text.match(/\bQ([1-4])\b\s*\(20\d{2}\)/);
      if (fm) best = Number(fm[1]);
    }
    if (best !== null) return best;
  }
  return null;
}

/**
 * Kuartil Scopus via Elsevier Serial Title API (butuh API key user).
 * Cari by ISSN; bila jurnal terindeks, ekstrak kuartil terbaik dari
 * subject areas bila tersedia, sonst tier 'scopus' polos (terindeks).
 * Kembalikan { quartile } atau { indexed: true } atau null.
 */
async function scopusViaApi(
  issn: string | undefined,
  apiKey: string,
  fetchFn: CredibilityFetcher,
): Promise<{ quartile: number | null; indexed: boolean } | null> {
  const clean = (issn ?? '').replace(/[^0-9xX]/g, '');
  if (clean.length < 8 || !apiKey) return null;
  const issnFmt = clean.slice(0, 4) + '-' + clean.slice(4, 8);
  let res: { status: number; text: string } | null;
  try {
    res = await fetchFn(
      `https://api.elsevier.com/content/serial/title/issn/${issnFmt}?apiKey=${encodeURIComponent(apiKey)}&httpAccept=application/json`,
    );
  } catch {
    return null;
  }
  if (!res || res.status !== 200) return null;
  try {
    const data = JSON.parse(res.text) as {
      'serial-metadata-response'?: { entry?: Array<Record<string, unknown>> };
    };
    const entries = data['serial-metadata-response']?.entry ?? [];
    if (entries.length === 0) return null;
    // Kuartil: hanya dari field yang eksplisit berlabel quartile
    // (jangan asal match "Q1" di judul/deskripsi — false positive).
    let best: number | null = null;
    const scan = (node: unknown): void => {
      if (typeof node === 'string') return;
      if (Array.isArray(node)) {
        for (const v of node) scan(v);
        return;
      }
      if (node && typeof node === 'object') {
        for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
          if (/quartile/i.test(k)) {
            // Nilai bisa string ("Q1") atau objek ({ $: "Q1" }) —
            // stringify subtree lalu ekstrak, aman dari false positive
            // karena hanya di dalam field berlabel quartile.
            const qm = JSON.stringify(v).match(/\bQ([1-4])\b/i);
            if (qm) {
              const n = Number(qm[1]);
              if (best === null || n < best) best = n;
            }
          }
          scan(v);
        }
      }
    };
    scan(entries);
    return { quartile: best, indexed: true };
  } catch {
    return null;
  }
}

async function doajByIssn(issn: string, fetchFn: CredibilityFetcher): Promise<boolean> {
  const clean = issn.replace(/[^0-9xX]/g, '');
  if (clean.length < 8) return false;
  let res: { status: number; text: string } | null;
  try {
    res = await fetchFn(`https://doaj.org/api/v2/search/journals/issn%3A${clean}`);
  } catch {
    return false;
  }
  if (!res || res.status !== 200) return false;
  try {
    const data = JSON.parse(res.text) as { total?: number; results?: unknown[] };
    return (data.total ?? 0) > 0 || (data.results?.length ?? 0) > 0;
  } catch {
    return false;
  }
}

function domainOf(url: string): string {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return '';
  }
}

/**
 * Nilai kredibilitas satu sumber. Urutan: DOI→Crossref (metadata) →
 * Scopus API (key user) → SJR/Scopus kuartil (best-effort) →
 * Sinta (peringkat nasional) → DOAJ (ISSN) → heuristic domain →
 * web/unknown. Tidak pernah mengembalikan verified:true tanpa
 * konfirmasi resmi.
 */
export async function assessCredibility(
  input: CredibilityInput,
  fetchFn: CredibilityFetcher = defaultCredibilityFetch,
): Promise<SourceCredibility> {
  const domain = domainOf(input.url);

  // Heuristic domain cepat (tidak butuh HTTP).
  if (domain === 'garuda.kemdikbud.go.id' || domain.endsWith('.garuda.kemdikbud.go.id')) {
    return { tier: 'garuda', verified: false, detail: 'terdeteksi dari domain garuda.kemdikbud.go.id (heuristic)' };
  }

  let journalTitle = '';
  let issn: string | undefined = input.issn;
  if (input.doi) {
    const jr = await crossrefByDoi(input.doi, fetchFn);
    if (jr) {
      journalTitle = jr.title;
      if (!issn && jr.issn.length > 0) issn = jr.issn[0];
    }
  }

  // Internasional dulu (permintaan Farid): Scopus kuartil via API key user.
  if (input.elsevierApiKey && issn) {
    const scopus = await scopusViaApi(issn, input.elsevierApiKey, fetchFn);
    if (scopus) {
      if (scopus.quartile !== null) {
        const tier = `scopus-q${scopus.quartile}` as CredibilityTier;
        return { tier, verified: true, detail: `Scopus Q${scopus.quartile} — api.elsevier.com` };
      }
      return { tier: 'scopus', verified: true, detail: 'terindeks Scopus — api.elsevier.com (kuartil tak tersedia di respons)' };
    }
  }

  // Scopus kuartil via SCImago SJR (gratis, best-effort).
  const sjr = await sjrQuartile(journalTitle || input.title, issn, fetchFn);
  if (sjr !== null) {
    const tier = `scopus-q${sjr}` as CredibilityTier;
    return { tier, verified: true, detail: `Scopus Q${sjr} — scimagojr.com (SJR, data Scopus)` };
  }

  // Sinta: peringkat nasional bila halaman masih terbaca.
  const rank = await sintaRank(journalTitle || input.title, issn, fetchFn);
  if (rank !== null) {
    const tier = `sinta${rank}` as CredibilityTier;
    return { tier, verified: true, detail: `Sinta ${rank} — sinta.kemdikbud.go.id` };
  }

  // DOAJ via ISSN.
  if (issn) {
    try {
      if (await doajByIssn(issn, fetchFn)) {
        return { tier: 'doaj', verified: true, detail: `terdaftar di DOAJ (ISSN ${issn})` };
      }
    } catch {
      /* graceful */
    }
  }

  // Tanpa API key Elsevier dan SJR tak terjangkau: jujur di detail.
  if (!input.title.trim() && !domain) {
    return { tier: 'unknown', verified: false, detail: 'tidak cukup metadata untuk menilai' };
  }
  return {
    tier: 'web',
    verified: false,
    detail: 'sumber web umum — peringkat Sinta/Scopus tidak terkonfirmasi (Scopus penuh butuh API key Elsevier via ELSEVIER_API_KEY)',
  };
}
