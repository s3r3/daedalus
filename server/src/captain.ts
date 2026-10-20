/**
 * Dae Captain v2 Fase 7 — report exports for the chat's research-report
 * card ([DOCX] button). Builds a .docx from a ResearchReport with the
 * `docx` library (already a core dependency, hoisted to the workspace
 * root). Pure rendering: no filesystem, no server state.
 */
import {
  AlignmentType,
  Document,
  HeadingLevel,
  Packer,
  Paragraph,
  TextRun,
} from "docx";
import type { ResearchReport } from "@s3r3/core/research/types.ts";

function p(text: string, opts?: { bold?: boolean; size?: number; italic?: boolean }): Paragraph {
  return new Paragraph({
    children: [
      new TextRun({
        text,
        bold: opts?.bold,
        italics: opts?.italic,
        size: opts?.size,
      }),
    ],
  });
}

function heading(text: string, level: (typeof HeadingLevel)[keyof typeof HeadingLevel]): Paragraph {
  return new Paragraph({ text, heading: level });
}

/** Render a research report as .docx bytes. */
export async function buildResearchReportDocx(report: ResearchReport): Promise<Buffer> {
  const children: Paragraph[] = [];
  children.push(heading(report.question, HeadingLevel.TITLE));
  children.push(p(`Laporan riset · ${report.reportId}`, { italic: true, size: 20 }));
  children.push(p(""));

  children.push(heading("Ringkasan", HeadingLevel.HEADING_1));
  children.push(p(report.summary));
  children.push(p(""));

  for (const section of report.sections) {
    children.push(heading(section.title, HeadingLevel.HEADING_1));
    const claims = report.claims.filter((c) => section.claimIds.includes(c.id));
    for (const claim of claims) {
      children.push(
        new Paragraph({
          children: [
            new TextRun({ text: "• ", bold: true }),
            new TextRun({ text: claim.text }),
            new TextRun({
              text: `  [${claim.confidence} · ${claim.status}]`,
              italics: true,
              size: 18,
            }),
          ],
        }),
      );
      for (const excerpt of claim.excerpts.slice(0, 3)) {
        children.push(
          new Paragraph({
            children: [new TextRun({ text: `“${excerpt}”`, italics: true, size: 20 })],
            indent: { left: 720 },
          }),
        );
      }
    }
    children.push(p(""));
  }

  if (report.conflicts.length > 0) {
    children.push(heading("Konflik sumber", HeadingLevel.HEADING_1));
    for (const conflict of report.conflicts) {
      children.push(p(conflict.topic, { bold: true }));
      for (const pos of conflict.positions) {
        const src = report.sources.find((s) => s.id === pos.sourceId);
        children.push(p(`– ${src?.title ?? pos.sourceId}: ${pos.stance}`));
      }
      children.push(p(""));
    }
  }

  children.push(heading("Sumber", HeadingLevel.HEADING_1));
  for (const source of report.sources) {
    const authors = source.authors?.join(", ") ?? "";
    const year = source.year ? ` (${source.year})` : "";
    children.push(
      p(
        `[${source.id}] ${authors}${year} ${source.title} — ${source.url}`.replace(/^ /, ""),
      ),
    );
  }
  children.push(p(""));

  children.push(heading("Daftar pustaka (APA)", HeadingLevel.HEADING_1));
  for (const entry of report.bibliography.apa) {
    children.push(p(entry));
  }
  children.push(p(""));

  if (report.limitations.length > 0) {
    children.push(heading("Keterbatasan", HeadingLevel.HEADING_1));
    for (const limitation of report.limitations) {
      children.push(p(`• ${limitation}`));
    }
  }

  children.push(p(""));
  children.push(
    new Paragraph({
      children: [
        new TextRun({
          text: `Terverifikasi: ${report.verification.claimsVerified} klaim · Dibuang: ${report.verification.claimsDropped} klaim`,
          italics: true,
          size: 18,
        }),
      ],
      alignment: AlignmentType.CENTER,
    }),
  );

  const doc = new Document({
    sections: [{ properties: {}, children }],
  });
  return Buffer.from(await Packer.toBuffer(doc));
}
