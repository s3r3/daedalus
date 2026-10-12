import type { CredibilityTier, SourceCredibility } from './types.ts';

/**
 * Deteksi kredibilitas sumber — mekanisme JUJUR (Desain-Agentic-Research-v1).
 *
 * - Sinta 1–6: best-effort terhadap sinta.kemdikbud.go.id (halaman
 *   pencarian jurnal, bukan JSON API resmi — markup bisa berubah).
 *   `verified: true` HANYA bila peringkat berhasil diekstrak dari
 *   halaman; selain itu heuristic.
 * - Scopus: real-time butuh Elsevier API key (milik user, Settings —
 *   fase 2). MVP tidak pernah mengklaim tier 'scopus' tanpa itu.
 * - DOI: Crossref API publik (https://api.crossref.org) untuk
 *   validasi metadata jurnal/ISSN.
 * - DOAJ: API publik DOAJ (best-effort, graceful bila berubah).
 * - Garuda: heuristic domain garuda.kemdikbud.go.id.
 * - Default: 'web' — tidak pernah mengklaim lebih dari yang dicek.
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
 * Sinta (peringkat) → DOAJ (ISSN) → heuristic domain → web/unknown.
 * Tidak pernah mengembalikan verified:true tanpa konfirmasi resmi.
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

  // Sinta: peringkat resmi bila halaman masih terbaca.
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

  // Scopus tanpa API key: TIDAK PERNAH diklaim. Jelaskan di detail.
  if (!input.title.trim() && !domain) {
    return { tier: 'unknown', verified: false, detail: 'tidak cukup metadata untuk menilai' };
  }
  return {
    tier: 'web',
    verified: false,
    detail: 'sumber web umum — peringkat Sinta/Scopus tidak terkonfirmasi (Scopus butuh API key Elsevier di Settings)',
  };
}
