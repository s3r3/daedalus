import { readFile } from 'node:fs/promises';
import { extname } from 'node:path';
import type { ParsedBlock, ParsedSource } from './document.ts';

/**
 * Native in-process parsers (design decision 11): pdf.js for PDF,
 * mammoth for DOCX, mailparser for EML — born-digital documents need
 * no heavy pipeline. Output is provenance-carrying blocks: every block
 * knows its page, and PDF blocks carry bbox in page points (origin
 * top-left) so the Web canvas can overlay a field's provenance on the
 * rendered page. Pages are kept separate everywhere downstream — long
 * documents are chunked per page, never fed as one giant context.
 */

export const SUPPORTED_SOURCE_EXTENSIONS = ['.pdf', '.docx', '.eml', '.txt', '.md'] as const;

export function isSupportedSource(filename: string): boolean {
  return (SUPPORTED_SOURCE_EXTENSIONS as readonly string[]).includes(extname(filename).toLowerCase());
}

export async function parseSourceFile(absPath: string): Promise<ParsedSource> {
  const ext = extname(absPath).toLowerCase();
  const bytes = await readFile(absPath);
  return parseSourceBytes(bytes, ext);
}

export async function parseSourceBytes(bytes: Buffer, ext: string): Promise<ParsedSource> {
  switch (ext.toLowerCase()) {
    case '.pdf':
      return parsePdf(bytes);
    case '.docx':
      return parseDocx(bytes);
    case '.eml':
      return parseEml(bytes);
    case '.txt':
    case '.md':
      return textToParsed(bytes.toString('utf8'));
    default:
      throw new Error(`unsupported source type "${ext}" — Dokumen v1 reads PDF, DOCX, EML, TXT, MD`);
  }
}

function textToParsed(text: string): ParsedSource {
  const blocks: ParsedBlock[] = text
    .split(/\n\s*\n/)
    .map((part) => part.trim())
    .filter((part) => part.length > 0)
    .map((part) => ({ page: 1, text: part.replace(/\s+/g, ' ') }));
  return { pages: 1, pageSizes: [{ width: 0, height: 0 }], blocks, text: blocks.map((b) => b.text).join('\n') };
}

/* -------------------------------------------------------------- PDF */

type PdfTextItem = {
  str?: string;
  transform?: number[];
  width?: number;
  height?: number;
};

async function parsePdf(bytes: Buffer): Promise<ParsedSource> {
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  // Node has no DOM worker; point the worker at the bundled file. The
  // path must resolve through the pdfjs-dist package — relative to this
  // source file it would miss node_modules entirely (seen in the field:
  // "Setting up fake worker failed").
  try {
    const { createRequire } = await import('node:module');
    const { pathToFileURL } = await import('node:url');
    const workerPath = createRequire(import.meta.url).resolve('pdfjs-dist/legacy/build/pdf.worker.mjs');
    (pdfjs as { GlobalWorkerOptions: { workerSrc: string } }).GlobalWorkerOptions.workerSrc = pathToFileURL(workerPath).href;
  } catch {
    /* workerSrc stays unset; pdf.js falls back to its fake worker */
  }
  const doc = await pdfjs.getDocument({ data: new Uint8Array(bytes) }).promise;
  const blocks: ParsedBlock[] = [];
  const pageSizes: Array<{ width: number; height: number }> = [];
  for (let pageNo = 1; pageNo <= doc.numPages; pageNo++) {
    const page = await doc.getPage(pageNo);
    const viewport = page.getViewport({ scale: 1 });
    pageSizes.push({ width: viewport.width, height: viewport.height });
    const content = await page.getTextContent();
    // Group text items into lines by their y, then into blocks: pdf.js
    // items carry [a,b,c,d,x,y] with y measured from the page bottom.
    type Line = { y: number; parts: Array<{ x: number; text: string; w: number; h: number }> };
    const lines: Line[] = [];
    for (const raw of content.items as PdfTextItem[]) {
      if (typeof raw.str !== 'string' || !raw.transform) continue;
      const x = raw.transform[4] ?? 0;
      const yBottom = raw.transform[5] ?? 0;
      const y = viewport.height - yBottom;
      const h = Math.abs(raw.transform[3] ?? raw.height ?? 10) || 10;
      const w = raw.width ?? raw.str.length * h * 0.5;
      let line = lines.find((l) => Math.abs(l.y - y) < Math.max(3, h * 0.5));
      if (!line) {
        line = { y, parts: [] };
        lines.push(line);
      }
      line.parts.push({ x, text: raw.str, w, h });
    }
    lines.sort((a, b) => a.y - b.y);
    let current: { texts: string[]; x0: number; y0: number; x1: number; y1: number } | null = null;
    const flush = (): void => {
      if (!current) return;
      const text = current.texts.join(' ').replace(/\s+/g, ' ').trim();
      if (text) {
        blocks.push({
          page: pageNo,
          text,
          bbox: [current.x0, current.y0, Math.max(1, current.x1 - current.x0), Math.max(1, current.y1 - current.y0)],
        });
      }
      current = null;
    };
    for (const line of lines) {
      const parts = [...line.parts].sort((a, b) => a.x - b.x);
      const text = parts.map((p) => p.text).join(' ').trim();
      if (!text) continue;
      const x0 = Math.min(...parts.map((p) => p.x));
      const x1 = Math.max(...parts.map((p) => p.x + p.w));
      const h = Math.max(...parts.map((p) => p.h));
      if (current && line.y - current.y1 > h * 1.9) flush();
      if (!current) current = { texts: [], x0, y0: line.y - h, x1, y1: line.y };
      current.texts.push(text);
      current.x0 = Math.min(current.x0, x0);
      current.x1 = Math.max(current.x1, x1);
      current.y1 = Math.max(current.y1, line.y);
    }
    flush();
  }
  return { pages: doc.numPages, pageSizes, blocks, text: blocks.map((b) => b.text).join('\n') };
}

/* ------------------------------------------------------------- DOCX */

async function parseDocx(bytes: Buffer): Promise<ParsedSource> {
  const mammoth = (await import('mammoth')).default;
  const result = await mammoth.extractRawText({ buffer: bytes });
  // DOCX has no fixed pages: paragraphs become blocks on one logical
  // page; provenance is the paragraph quote.
  const blocks: ParsedBlock[] = result.value
    .split(/\n+/)
    .map((part) => part.trim())
    .filter((part) => part.length > 0)
    .map((part) => ({ page: 1, text: part.replace(/\s+/g, ' ') }));
  return { pages: 1, pageSizes: [{ width: 0, height: 0 }], blocks, text: blocks.map((b) => b.text).join('\n') };
}

/* -------------------------------------------------------------- EML */

async function parseEml(bytes: Buffer): Promise<ParsedSource> {
  const { simpleParser } = await import('mailparser');
  const mail = await simpleParser(bytes);
  const headerLines = [
    mail.from?.text ? `From: ${mail.from.text}` : '',
    mail.to && !Array.isArray(mail.to) ? `To: ${mail.to.text}` : '',
    mail.subject ? `Subject: ${mail.subject}` : '',
    mail.date ? `Date: ${mail.date.toISOString()}` : '',
  ].filter(Boolean);
  const body = (mail.text ?? '').trim();
  const blocks: ParsedBlock[] = [];
  if (headerLines.length > 0) blocks.push({ page: 1, text: headerLines.join(' · ') });
  for (const part of body.split(/\n\s*\n/)) {
    const text = part.trim().replace(/\s+/g, ' ');
    if (text) blocks.push({ page: 1, text });
  }
  for (const att of mail.attachments ?? []) {
    blocks.push({ page: 1, text: `[lampiran: ${att.filename ?? 'tanpa-nama'} (${att.contentType}, ${att.size} byte)]` });
  }
  return { pages: 1, pageSizes: [{ width: 0, height: 0 }], blocks, text: blocks.map((b) => b.text).join('\n') };
}

/* --------------------------------------------------------- chunking */

/**
 * Chunk a parsed source per page (design honesty rule 10b): each chunk
 * is the blocks of ONE page — the unit extraction calls receive, never
 * the whole document at once.
 */
export function pageChunks(parsed: ParsedSource): Array<{ page: number; text: string; blocks: ParsedBlock[] }> {
  const byPage = new Map<number, ParsedBlock[]>();
  for (const block of parsed.blocks) {
    const list = byPage.get(block.page) ?? [];
    list.push(block);
    byPage.set(block.page, list);
  }
  return [...byPage.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([page, blocks]) => ({ page, blocks, text: blocks.map((b) => b.text).join('\n') }));
}

/** Bind a model-quoted string back to its source block (provenance). */
export function findProvenance(parsed: ParsedSource, quote: string | undefined): { page: number; quote?: string; bbox?: [number, number, number, number] } | undefined {
  if (!quote || quote.trim().length < 3) return undefined;
  const needle = quote.trim().toLowerCase();
  const block = parsed.blocks.find((b) => b.text.toLowerCase().includes(needle) || needle.includes(b.text.toLowerCase().slice(0, 40)));
  if (!block) return undefined;
  return { page: block.page, quote: quote.trim(), ...(block.bbox ? { bbox: block.bbox } : {}) };
}
