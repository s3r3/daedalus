// Assemble the rendered slide PNGs into a downloadable PDF or PPTX.
import { PDFDocument } from "pdf-lib";
import type { Project } from "./types";
import { readSlideImage } from "./store";

export type SlideImageReader = (name: string) => Buffer | null;

function orderedImages(
  project: Project,
  readImage: SlideImageReader = (name) => readSlideImage(project.id, name),
): { index: number; bytes: Buffer }[] {
  return project.pages
    .filter((p) => p.image)
    .map((p) => ({ index: p.index, bytes: readImage(p.image!) }))
    .filter((x): x is { index: number; bytes: Buffer } => Boolean(x.bytes))
    .sort((a, b) => a.index - b.index);
}

export async function buildPdf(project: Project, readImage?: SlideImageReader): Promise<Buffer> {
  const imgs = orderedImages(project, readImage);
  if (!imgs.length) throw new Error("No rendered slides to export");
  const pdf = await PDFDocument.create();
  for (const { bytes } of imgs) {
    const png = await pdf.embedPng(bytes);
    const page = pdf.addPage([png.width, png.height]);
    page.drawImage(png, { x: 0, y: 0, width: png.width, height: png.height });
  }
  const out = await pdf.save();
  return Buffer.from(out);
}

function aspectInches(aspect: string): { w: number; h: number } {
  const [aw, ah] = aspect.split(":").map(Number);
  const width = 13.333;
  if (!aw || !ah) return { w: width, h: 7.5 };
  return { w: width, h: +(width * (ah / aw)).toFixed(3) };
}

export async function buildPptx(project: Project, readImage?: SlideImageReader): Promise<Buffer> {
  const imgs = orderedImages(project, readImage);
  if (!imgs.length) throw new Error("No rendered slides to export");
  // pptxgenjs is CommonSJS; import lazily so it stays out of the edge bundle.
  const PptxGenJS = (await import("pptxgenjs")).default;
  const pptx = new PptxGenJS();
  const { w, h } = aspectInches(project.config.aspect);
  pptx.defineLayout({ name: "PPTA", width: w, height: h });
  pptx.layout = "PPTA";
  const pagesByIndex = new Map(project.pages.map((page) => [page.index, page]));

  for (const { index, bytes } of imgs) {
    const slide = pptx.addSlide();
    slide.addImage({
      data: `image/png;base64,${bytes.toString("base64")}`,
      x: 0,
      y: 0,
      w,
      h,
    });
    const notes = pagesByIndex.get(index)?.speakerNotes?.trim();
    if (notes) slide.addNotes(notes);
  }
  const out = (await pptx.write({ outputType: "nodebuffer" })) as Buffer;
  return out;
}
