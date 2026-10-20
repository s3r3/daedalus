import type { ResearchSource } from './types.ts';

/**
 * Daftar pustaka sekali klik (untuk skripsi): APA 7th, IEEE, BibTeX,
 * dan RIS. BibTeX/RIS bisa di-import native ke Zotero/Mendeley —
 * nol auth (API langsung Zotero/Mendeley ditunda ke fase 2).
 * Murni format string dari metadata sumber — nol LLM.
 */

function apaAuthors(authors?: string[]): string {
  if (!authors || authors.length === 0) return '';
  const formatted = authors.map((a) => {
    const parts = a.trim().split(/\s+/);
    if (parts.length === 1) return parts[0];
    const last = parts[parts.length - 1] as string;
    const initials = parts.slice(0, -1).map((p) => `${p[0]}.`).join(' ');
    return `${last}, ${initials}`;
  });
  if (formatted.length === 1) return formatted[0] as string;
  return `${formatted.slice(0, -1).join(', ')}, & ${formatted[formatted.length - 1]}`;
}

function ieeeAuthors(authors?: string[]): string {
  if (!authors || authors.length === 0) return '';
  const formatted = authors.map((a) => {
    const parts = a.trim().split(/\s+/);
    if (parts.length === 1) return parts[0];
    const last = parts[parts.length - 1] as string;
    const initials = parts.slice(0, -1).map((p) => `${p[0]}.`).join(' ');
    return `${initials} ${last}`;
  });
  return formatted.join(' and ');
}

/** Satu entri APA 7th dari metadata sumber. */
export function formatApa(source: ResearchSource): string {
  const author = apaAuthors(source.authors);
  const year = source.year ? `(${source.year})` : '(t.t.)';
  const title = source.title.endsWith('.') ? source.title : `${source.title}.`;
  const locator = source.doi ? `https://doi.org/${source.doi}` : source.url;
  return `${author ? `${author} ` : ''}${year}. ${title} ${locator}`.replace(/\s+/g, ' ').trim();
}

/** Satu entri IEEE dari metadata sumber. */
export function formatIeee(source: ResearchSource, index: number): string {
  const author = ieeeAuthors(source.authors);
  const year = source.year ? `${source.year}` : 't.t.';
  const locator = source.doi ? `https://doi.org/${source.doi}` : source.url;
  return `[${index}] ${author ? `${author}, ` : ''}"${source.title}," ${year}. [Online]. Available: ${locator}`.replace(/\s+/g, ' ').trim();
}

function bibtexKey(source: ResearchSource, index: number): string {
  const first = source.authors?.[0]?.trim().split(/\s+/).pop() ?? 'anon';
  const year = source.year ?? 'notahun';
  const slug = source.title.toLowerCase().replace(/[^a-z0-9]+/g, '').slice(0, 20) || `s${index}`;
  return `${first}${year}${slug}`.replace(/[^a-zA-Z0-9]/g, '');
}

function escapeBibtex(s: string): string {
  return s.replace(/[{}\\]/g, (c) => `\\${c}`);
}

/** Satu entri BibTeX (@misc — aman untuk sumber web & jurnal). */
export function formatBibtex(source: ResearchSource, index: number): string {
  const key = bibtexKey(source, index);
  const lines = [`@misc{${key},`];
  if (source.authors?.length) lines.push(`  author = {${escapeBibtex(source.authors.join(' and '))}},`);
  lines.push(`  title = {${escapeBibtex(source.title)}},`);
  if (source.year) lines.push(`  year = {${source.year}},`);
  if (source.doi) lines.push(`  doi = {${escapeBibtex(source.doi)}},`);
  lines.push(`  url = {${escapeBibtex(source.url)}},`);
  lines.push(`  note = {Diakses ${source.fetchedAt.slice(0, 10)}}`);
  lines.push('}');
  return lines.join('\n');
}

/** Satu entri RIS (ELEC — di-import Zotero/Mendeley sebagai webpage). */
export function formatRis(source: ResearchSource): string {
  const lines = ['TY  - ELEC'];
  for (const a of source.authors ?? []) lines.push(`AU  - ${a}`);
  lines.push(`TI  - ${source.title}`);
  if (source.year) lines.push(`PY  - ${source.year}///`);
  if (source.doi) lines.push(`DO  - ${source.doi}`);
  lines.push(`UR  - ${source.url}`);
  lines.push(`Y2  - ${source.fetchedAt.slice(0, 10)}`);
  lines.push('ER  - ');
  return lines.join('\n');
}

/** Bangun daftar pustaka APA + IEEE untuk seluruh sumber (urutan = urutan sources). */
export function buildBibliography(sources: ResearchSource[]): { apa: string[]; ieee: string[] } {
  return {
    apa: sources.map((s) => formatApa(s)),
    ieee: sources.map((s, i) => formatIeee(s, i + 1)),
  };
}

/** Export seluruh sumber sebagai satu dokumen BibTeX. */
export function exportBibtex(sources: ResearchSource[]): string {
  return sources.map((s, i) => formatBibtex(s, i + 1)).join('\n\n') + '\n';
}

/** Export seluruh sumber sebagai satu dokumen RIS. */
export function exportRis(sources: ResearchSource[]): string {
  return sources.map((s) => formatRis(s)).join('\n') + '\n';
}
