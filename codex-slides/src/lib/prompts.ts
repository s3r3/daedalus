// Prompt builders for the 3 text/image stages, distilled from banana-slides'
// backend/services/prompts.py. The load-bearing trick lives in buildImagePrompt:
// wrap the page copy in <page_description>, then a <design_guidelines> block that
// demands crisp 4K text at the exact aspect ratio, render every character, and
// forbid markdown symbols — that is what turns an image model into a slide.

import type { Language, OutlinePage, PptConfig, Project, SlidePage } from "./types";
import { buildDeckDesignSystemContext } from "./designSystem";
import { getTemplate, styleBlockFor } from "./templates";
import { getCommunityTemplate, communityStyleBlock } from "./community";
import { materialRolePrompt, scenarioPromptContext } from "./scenarios";

function langInstruction(language: Language): string {
  switch (language) {
    case "zh":
      return "Write ALL slide text in 简体中文.";
    case "en":
      return "Write ALL slide text in English.";
    case "ja":
      return "Write ALL slide text in 日本語.";
    default:
      return "Write ALL slide text in the same language as the user's topic.";
  }
}

// ---- Stage 1: requirement -> outline -----------------------------------

export function buildOutlinePrompt(config: PptConfig): string {
  const { requirement, pages, style, language, researchDoc } = config;
  const designSystemContext = buildDeckDesignSystemContext(config.designSystem);
  return [
    "You are a helpful assistant that generates an outline for a slide deck (PPT).",
    "",
    "Return ONLY a JSON array, no prose, no code fences, in this exact shape:",
    '[{"title": "slide title", "points": ["key point", "key point", "key point"]}]',
    "",
    `Produce about ${pages} slides (the first is a cover/title slide).`,
    "Each slide has a short title and 2-4 concise key points.",
    scenarioPromptContext(config.scenarioId),
    materialRolePrompt(config.materialContexts),
    style ? `Overall style / tone to keep in mind: ${style}.` : "",
    designSystemContext,
    researchDoc
      ? `Base the outline on this research brief; ground the slides in its facts and structure:\n<research_document>\n${researchDoc.slice(0, 8000)}\n</research_document>`
      : "",
    config.materialIds?.length
      ? "The user also attached context items. Treat their text, data, and visuals as source material for the outline; do not merely mention that files were attached."
      : "",
    langInstruction(language),
    "",
    "The user's request:",
    requirement,
    "",
    "Now output ONLY the JSON array.",
  ]
    .filter(Boolean)
    .join("\n");
}

// ---- Stage 1b: revise an existing draft outline from an instruction -----

export function buildOutlineRevisePrompt(project: Project, instruction: string): string {
  const current = project.outline
    .map((p, i) => `${i + 1}. ${p.title}${p.points?.length ? " — " + p.points.join("; ") : ""}`)
    .join("\n");
  return [
    "You are editing the OUTLINE of a slide deck before any slides are drawn.",
    `Deck topic: ${project.title}.`,
    scenarioPromptContext(project.config.scenarioId),
    materialRolePrompt(project.config.materialContexts),
    buildDeckDesignSystemContext(project.config.designSystem),
    "",
    "Current outline:",
    current,
    "",
    `The user's instruction: "${instruction}"`,
    "",
    "Apply the instruction (add / remove / reorder / retitle slides, or rewrite key points).",
    "Keep the parts the user did not ask to change. Slide 1 stays the cover/title slide.",
    project.config.researchDoc
      ? "Stay grounded in the same research facts already used for this deck."
      : "",
    langInstruction(project.config.language),
    "",
    "Return ONLY this JSON object, no prose, no code fences:",
    '{"reply": "one short sentence back to the user, in their language", "outline": [{"title": "slide title", "points": ["key point", "key point"]}]}',
  ]
    .filter(Boolean)
    .join("\n");
}

// ---- Stage 2: outline -> per-page copy ---------------------------------

function detailSpec(pages: number): string {
  return "Keep it tight: a headline plus 2-4 short bullet lines or a one-sentence lead. No paragraphs of filler.";
}

export function buildPageDescriptionPrompt(
  config: PptConfig,
  outline: OutlinePage[],
  page: SlidePage,
  index: number,
  total: number,
): string {
  const outlineText = outline
    .map((p, i) => `${i + 1}. ${p.title}${p.points?.length ? " — " + p.points.join("; ") : ""}`)
    .join("\n");

  const header = [
    "We are writing the on-slide copy for one page of a slide deck.",
    "Return the literal text that should appear ON the slide — the exact words a reader will see.",
    "Output ONLY the copy between the markers below. No commentary, no markdown symbols (*, #, -, backticks).",
    "",
    "--- SLIDE TEXT ---",
    "<the exact words on the slide, one idea per line>",
    "--- END SLIDE TEXT ---",
    "",
    `Full deck outline (for context):\n${outlineText}`,
    "",
    `This is slide ${index} of ${total}. Title: "${page.title}".`,
    page.points?.length ? `Key points: ${page.points.join("; ")}.` : "",
    scenarioPromptContext(config.scenarioId),
    materialRolePrompt(config.materialContexts),
    buildDeckDesignSystemContext(config.designSystem),
    config.researchDoc
      ? `Use this research brief to verify the page's facts and source labels. When a slide makes a substantive researched claim, keep a compact source name, year, or URL in the on-slide copy instead of dropping attribution:\n<research_document>\n${config.researchDoc.slice(0, 7000)}\n</research_document>`
      : "",
    config.materialIds?.length
      ? "Use the attached context items as source material. Preserve relevant facts, wording, brand assets, and visual evidence faithfully."
      : "",
    langInstruction(config.language),
  ];

  if (index === 1) {
    header.push(
      "This is the COVER slide: output only a punchy title and a one-line subtitle (and optionally a presenter/date line). Keep it minimal.",
    );
  } else {
    header.push(detailSpec(config.pages));
  }
  header.push("", "Now output the slide text between the two markers.");
  return header.filter(Boolean).join("\n");
}

const SLIDE_TEXT_RE = /---\s*SLIDE TEXT\s*---\s*([\s\S]*?)\s*---\s*END SLIDE TEXT\s*---/i;

/** Pull the on-slide copy out of the model's stage-2 response. */
export function extractSlideText(raw: string): string {
  const m = raw.match(SLIDE_TEXT_RE);
  const body = (m ? m[1] : raw).trim();
  // strip stray markdown bullets / heading marks the model may still emit
  return body
    .split("\n")
    .map((l) => l.replace(/^\s*[-*#>]+\s?/, "").trim())
    .filter(Boolean)
    .join("\n");
}

// ---- Stage 3: copy -> image prompt -------------------------------------

export function buildImagePrompt(
  config: PptConfig,
  page: SlidePage,
  index: number,
  total: number,
  hasMaterials = false,
  hasStyleReference = false,
): string {
  const { aspect, style, language } = config;
  const isCover = index === 1;

  const tpl = getTemplate(config.template);
  const community = tpl ? undefined : getCommunityTemplate(config.template);
  const presetStyle = tpl
    ? styleBlockFor(tpl)
    : community
      ? communityStyleBlock(community)
      : "";
  const styleText = presetStyle
    ? presetStyle + (style ? ` Additional user preference: ${style}.` : "")
    : style ||
      "Clean, modern, professional presentation design. Generous whitespace, a clear visual hierarchy, one accent color, a single consistent typeface family.";
  const styleBlock = `<page_style>\n${styleText}\n</page_style>`;
  const designSystemContext = buildDeckDesignSystemContext(config.designSystem);

  return [
    "You are an expert UI/UX presentation designer. Design and render ONE finished slide as a single image.",
    "",
    "<page_description>",
    page.description || page.title,
    "</page_description>",
    "",
    styleBlock,
    designSystemContext,
    scenarioPromptContext(config.scenarioId),
    materialRolePrompt(config.materialContexts),
    "",
    "<design_guidelines>",
    `- Canvas is a single slide at a strict ${aspect} aspect ratio, 4K resolution.`,
    "- Render EVERY line of the slide text above, exactly, with nothing missing or duplicated.",
    "- Text must be crisp, sharp, perfectly legible, correctly kerned and spelled.",
    "- Do NOT render any markdown symbols (no *, #, -, backticks) — they are formatting hints, not content.",
    "- Compose a real slide layout: clear title, supporting content, tasteful use of space, subtle iconography or shapes where helpful.",
    `- Keep the visual style consistent with <page_style> so this slide sits inside a coherent ${total}-slide deck.`,
    isCover
      ? "- This is the COVER slide: make it striking — a bold hero title and a calm, confident layout."
      : `- This is slide ${index} of ${total}: keep the header/footer treatment consistent with a deck.`,
    hasStyleReference
      ? "- The FIRST reference image is the user's selected COMMUNITY STYLE. Match its art direction, layout grammar, typography character, palette relationships, texture, and visual density across the deck, but do not copy its literal subject, words, logos, or composition verbatim."
      : "",
    hasMaterials
      ? "- Reference images are the user's brand/content MATERIALS (logo, product shot, style reference). Use them faithfully where appropriate — place the logo, match the brand look/palette — but don't force every material onto every slide, and don't distort any text inside them."
      : "",
    "</design_guidelines>",
    "",
    langInstruction(language),
  ].join("\n");
}

/** Instruction wrapper for a multi-round edit of an already-rendered slide. */
export function buildEditImagePrompt(
  config: PptConfig,
  page: SlidePage,
  instruction: string,
): string {
  return [
    "You are editing an existing slide. The reference image is the CURRENT slide.",
    "Apply ONLY the requested change; keep everything else (layout, palette, other text) identical.",
    "",
    "Requested change:",
    instruction,
    "",
    buildDeckDesignSystemContext(config.designSystem),
    "",
    "<design_guidelines>",
    `- Keep the strict ${config.aspect} aspect ratio and 4K crispness.`,
    "- All text must stay sharp and correctly spelled; render no markdown symbols.",
    "</design_guidelines>",
  ].join("\n");
}

/** Instruction wrapper for a mark/annotation-driven edit (cowart-style). */
export function buildMarkEditPrompt(config: PptConfig, note: string): string {
  return [
    "The ONE input image is the current slide with an annotation layer drawn on top.",
    "Red strokes, red boxes/lines, and red text are editing instructions, not slide content.",
    "Make a clearly visible change inside the marked region that follows the annotation and the author's note.",
    "Never satisfy this request by only erasing the red marks and returning the previous slide unchanged.",
    note
      ? `The author's required change is: ${note}`
      : "If the mark only identifies a region, improve or simplify that region while preserving its role in the slide.",
    "Return the clean edited slide without any annotation marks, selection boxes, or instruction text.",
    "Keep everything outside the marked region as visually identical to the input as possible.",
    "",
    buildDeckDesignSystemContext(config.designSystem),
    "",
    "<design_guidelines>",
    `- Keep the strict ${config.aspect} aspect ratio and 4K crispness.`,
    "- All text sharp and correctly spelled; no markdown symbols; no annotation marks in the final image.",
    "</design_guidelines>",
  ]
    .filter(Boolean)
    .join("\n");
}
