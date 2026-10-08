import { runCliAgentText } from "./agents";
import { codexJson, parseLooseJson } from "./codex-text";
import { normalizeGeneratedSpeakerNotes, type GeneratedSpeakerNote } from "./speakerNotesData";
import type { Project } from "./types";

function languageLabel(project: Project): string {
  if (project.config.language === "zh") return "Simplified Chinese";
  if (project.config.language === "ja") return "Japanese";
  if (project.config.language === "en") return "English";
  return "the same language used by the slide content";
}

function notesPrompt(project: Project, indexes: readonly number[], instruction?: string): string {
  const selected = new Set(indexes);
  const outline = project.pages.map((page) => [
    `Slide ${page.index}${selected.has(page.index) ? " [WRITE NOTES]" : ""}: ${page.title}`,
    page.points.length ? `Visible points: ${page.points.join(" | ")}` : "Visible points: (none)",
    page.description ? `Rendered slide copy/context: ${page.description.slice(0, 1600)}` : "",
    page.speakerNotes?.trim() ? `Existing notes: ${page.speakerNotes.slice(0, 1200)}` : "",
  ].filter(Boolean).join("\n")).join("\n\n");

  return [
    "You are an expert presentation speechwriter.",
    `Write presenter notes only for slide indexes: ${indexes.join(", ")}.`,
    `Deck title: ${project.title}`,
    `Deck brief: ${project.config.requirement}`,
    `Output language: ${languageLabel(project)}.`,
    instruction?.trim() ? `Additional direction: ${instruction.trim()}` : "",
    "",
    "Rules:",
    "- Sound natural when spoken. Expand the slide's meaning; do not merely read visible words aloud.",
    "- Preserve the deck's facts. Do not invent metrics, names, dates, sources, or claims.",
    "- Give the speaker a clear opening, explanation, and handoff to the next idea when useful.",
    "- Keep each note concise enough for roughly 45-90 seconds of speaking.",
    "- Do not include markdown headings, slide numbers, or stage directions unless genuinely useful.",
    "- Return ONLY valid JSON: {\"notes\":[{\"index\":1,\"note\":\"...\"}]}",
    "",
    "Deck plan:",
    outline,
  ].filter(Boolean).join("\n");
}

/** Generate a coherent talk track with the same text engine selected by the
 * project. The caller owns persistence so it can merge into the latest file. */
export async function generateSpeakerNotes(
  project: Project,
  indexes: readonly number[],
  options: { instruction?: string; signal?: AbortSignal } = {},
): Promise<GeneratedSpeakerNote[]> {
  const targets = Array.from(new Set(indexes))
    .filter((index) => Number.isInteger(index) && project.pages.some((page) => page.index === index))
    .sort((a, b) => a - b);
  if (!targets.length) return [];
  const prompt = notesPrompt(project, targets, options.instruction);
  const raw = project.config.engine === "codex"
    ? await codexJson<unknown>(prompt, { signal: options.signal })
    : parseLooseJson<unknown>((await runCliAgentText(project.config.engine, prompt, { signal: options.signal })).text);
  const notes = normalizeGeneratedSpeakerNotes(raw, targets);
  if (!notes.length) throw new Error("Speaker notes generation returned no usable notes");
  return notes;
}
