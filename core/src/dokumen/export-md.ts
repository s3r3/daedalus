/**
 * Agentic Dokumen — Markdown export (Dae Captain v2, Fase 7).
 *
 * The kerangka card offers [DOCX][PDF][MD]; DOCX/PDF already existed in
 * export-docx.ts. This module adds the MD sibling: sections rendered as
 * Markdown headings + thesis points + prose, written next to the other
 * exports under .daedalus/documents/<id>/exports/. Pure rendering
 * (buildDocumentMarkdown) is exported for unit tests.
 */

import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  documentPaths,
  type DocumentState,
  type DokumenSection,
} from './document.ts';
import type { DocumentExportResult } from './export-docx.ts';

export type MarkdownExportResult = Omit<DocumentExportResult, 'format'> & {
  format: 'md';
};

function sectionMarkdown(section: DokumenSection, index: number): string {
  const lines: string[] = [];
  lines.push(`## ${index + 1}. ${section.title}`);
  lines.push('');
  if (section.thesisPoints.length > 0) {
    for (const point of section.thesisPoints) {
      lines.push(`- ${point}`);
    }
    lines.push('');
  }
  if (section.prose.trim()) {
    lines.push(section.prose.trim());
    lines.push('');
  }
  if (section.citations.length > 0) {
    lines.push(`*Sitasi: ${section.citations.join(', ')}*`);
    lines.push('');
  }
  return lines.join('\n');
}

/** Render the whole document as Markdown. Pure — no filesystem. */
export function buildDocumentMarkdown(doc: DocumentState): string {
  const lines: string[] = [];
  lines.push(`# ${doc.title}`);
  lines.push('');
  doc.sections.forEach((section, i) => {
    lines.push(sectionMarkdown(section, i));
  });
  return lines.join('\n').replace(/\n{3,}/g, '\n\n').trim() + '\n';
}

export async function exportDocumentMarkdown(
  root: string,
  doc: DocumentState,
): Promise<MarkdownExportResult> {
  const paths = documentPaths(root, doc.id);
  await mkdir(paths.exportsDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const name = `dokumen-${stamp}.md`;
  const abs = join(paths.exportsDir, name);
  const text = buildDocumentMarkdown(doc);
  await writeFile(abs, text, 'utf8');
  const flagged = doc.sections.filter((s) => s.status === 'critic-flagged').length;
  const result: MarkdownExportResult = {
    format: 'md',
    path: `.daedalus/documents/${doc.id}/exports/${name}`,
    bytes: Buffer.byteLength(text, 'utf8'),
    heldBack: flagged,
  };
  doc.exports.push({
    format: 'md',
    path: result.path,
    recordCount: doc.sections.length,
    heldBack: flagged,
    at: new Date().toISOString(),
  });
  return result;
}
