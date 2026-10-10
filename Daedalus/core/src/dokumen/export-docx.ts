import { execFile } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  AlignmentType,
  Document,
  FootnoteReferenceRun,
  HeadingLevel,
  Packer,
  Paragraph,
  TextRun,
} from 'docx';
import { documentPaths, type DocumentState } from './document.ts';

/**
 * Compose export: DOCX is the native render (heading styles, a table
 * of contents field Word/LibreOffice fills on open, citation footnotes)
 * built from the section tree in document.json; PDF is a secondary
 * render via LibreOffice headless when available (the Pratinjau Asli
 * stance: detect, never bundle). Claims in prose are only as strong as
 * their citations — the critic gate upstream, not this renderer,
 * enforces that.
 */

export type DocumentExportResult = {
  format: 'docx' | 'pdf';
  path: string;
  bytes: number;
  heldBack: number;
};

function sectionParagraphs(doc: DocumentState): { body: Paragraph[]; footnotes: Record<number, { children: Paragraph[] }> } {
  const body: Paragraph[] = [];
  const footnotes: Record<number, { children: Paragraph[] }> = {};
  let footnoteSeq = 0;
  const idToFootnote = new Map<string, number>();

  const footnoteFor = (citationId: string): number => {
    const seen = idToFootnote.get(citationId);
    if (seen) return seen;
    footnoteSeq += 1;
    idToFootnote.set(citationId, footnoteSeq);
    const citation = doc.citations[citationId];
    const label = citation ? `${citation.title}${citation.url ? ` — ${citation.url}` : ''}` : citationId;
    footnotes[footnoteSeq] = { children: [new Paragraph({ children: [new TextRun({ text: label, size: 18 })] })] };
    return footnoteSeq;
  };

  body.push(
    new Paragraph({ alignment: AlignmentType.CENTER, children: [new TextRun({ text: doc.title, bold: true, size: 32 })] }),
    new Paragraph({ text: '' }),
  );
  // Table of contents field: Word/LibreOffice populate it on open/update.
  body.push(
    new Paragraph({ heading: HeadingLevel.HEADING_1, children: [new TextRun({ text: 'Daftar Isi', bold: true })] }),
    new Paragraph({
      children: [
        new TextRun({ text: '[Klik kanan → Update Field untuk mengisi daftar isi]', italics: true, size: 18 }),
      ],
    }),
    new Paragraph({ text: '' }),
  );

  for (const section of doc.sections) {
    body.push(new Paragraph({ heading: HeadingLevel.HEADING_1, children: [new TextRun({ text: section.title, bold: true })] }));
    const paragraphs = section.prose.split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean);
    for (const text of paragraphs) {
      // Split [SRC-n] markers into footnote references.
      const runs: Array<TextRun | FootnoteReferenceRun> = [];
      const parts = text.split(/(\[SRC-\d+\])/g);
      for (const part of parts) {
        const marker = part.match(/^\[(SRC-\d+)\]$/);
        if (marker) runs.push(new FootnoteReferenceRun(footnoteFor(marker[1]!)));
        else if (part) runs.push(new TextRun({ text: part }));
      }
      body.push(new Paragraph({ children: runs.length > 0 ? runs : [new TextRun({ text })], spacing: { after: 160, line: 276 } }));
    }
  }
  return { body, footnotes };
}

/**
 * Compose the native DOCX bytes for this document state — the exact
 * file export writes, without writing it anywhere or recording an
 * export. The Pratinjau engine renders these bytes so the user sees
 * the would-be document without polluting the export history.
 */
export async function buildDocumentDocxBytes(doc: DocumentState): Promise<Buffer> {
  const { body, footnotes } = sectionParagraphs(doc);
  const file = new Document({
    creator: 'Daedalus DokumenEngine',
    title: doc.title,
    footnotes,
    sections: [{ children: body }],
  });
  return Packer.toBuffer(file);
}

export async function exportDocumentDocx(root: string, doc: DocumentState): Promise<DocumentExportResult> {
  const paths = documentPaths(root, doc.id);
  await mkdir(paths.exportsDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const name = `dokumen-${stamp}.docx`;
  const abs = join(paths.exportsDir, name);
  const buffer = await buildDocumentDocxBytes(doc);
  await writeFile(abs, buffer);
  const flagged = doc.sections.filter((s) => s.status === 'critic-flagged').length;
  const result: DocumentExportResult = {
    format: 'docx',
    path: `.daedalus/documents/${doc.id}/exports/${name}`,
    bytes: buffer.length,
    heldBack: flagged,
  };
  doc.exports.push({ format: 'docx', path: result.path, recordCount: doc.sections.length, heldBack: flagged, at: new Date().toISOString() });
  return result;
}

function run(cmd: string, args: string[]): Promise<void> {
  return new Promise((resolvePromise, reject) => {
    execFile(cmd, args, { timeout: 120_000 }, (error) => {
      if (error) reject(error);
      else resolvePromise();
    });
  });
}

export async function exportDocumentPdf(root: string, doc: DocumentState): Promise<DocumentExportResult> {
  const docx = await exportDocumentDocx(root, doc);
  const paths = documentPaths(root, doc.id);
  const absDocx = join(root, docx.path);
  try {
    await run('soffice', ['--headless', '--convert-to', 'pdf', '--outdir', paths.exportsDir, absDocx]);
  } catch {
    throw new Error('PDF render needs LibreOffice (soffice) on this machine — DOCX exported fine; install LibreOffice for PDF');
  }
  const pdfName = absDocx.split('/').pop()!.replace(/\.docx$/, '.pdf');
  const result: DocumentExportResult = {
    format: 'pdf',
    path: `.daedalus/documents/${doc.id}/exports/${pdfName}`,
    bytes: 0,
    heldBack: docx.heldBack,
  };
  doc.exports.push({ format: 'pdf', path: result.path, recordCount: doc.sections.length, heldBack: docx.heldBack, at: new Date().toISOString() });
  return result;
}
