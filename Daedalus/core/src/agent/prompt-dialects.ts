import type { PromptFamily, PromptFamilySetting } from "../contracts.ts";

/**
 * Prompt dialects per model family (tailor suite). Different model families
 * were trained on different framing conventions — Claude models read
 * XML-style section tags, GPT models read terse markdown imperatives, and
 * open router models (Qwen/Llama/Gemini) follow plain numbered steps most
 * reliably (Cline/Aider practice). The fragment below adjusts ONLY that
 * framing; task semantics, tool protocol, and safety wording live in the
 * base prompt and never change per family.
 *
 * Regression guard: `generic` (and unset) yields NO fragment, so the
 * assembled system prompt is byte-identical to the pre-dialect prompt.
 */

export const PROMPT_FAMILIES: readonly PromptFamily[] = ["claude", "gpt", "qwen", "llama", "gemini", "generic"];

const FAMILY_FRAGMENTS: Record<Exclude<PromptFamily, "generic">, string> = {
  claude: [
    "Framing conventions for this model family:",
    "- Structure any outline before a tool call with XML-style section tags (e.g. <plan>, <notes>); keep prose outside tool calls minimal.",
    "- State the target file path exactly once, then act.",
  ].join("\n"),
  gpt: [
    "Framing conventions for this model family:",
    "- Use short markdown headings and terse imperative bullets for any outline before a tool call.",
    "- One instruction per line; no filler, no restating the task.",
  ].join("\n"),
  qwen: [
    "Framing conventions for this model family:",
    "- Use a short numbered list for multi-step work (1. 2. 3.), one action per line, then emit the tool call.",
    "- State file paths exactly as given; do not abbreviate or rename them.",
  ].join("\n"),
  llama: [
    "Framing conventions for this model family:",
    "- Use a short numbered list for multi-step work (1. 2. 3.), one action per line, then emit the tool call.",
    "- Keep every reply short; act first, summarize in one line at the end.",
  ].join("\n"),
  gemini: [
    "Framing conventions for this model family:",
    "- Use plain numbered imperatives for multi-step work, one action per line, then emit the tool call.",
    "- Quote exact file paths and exact anchor text when editing; never paraphrase code.",
  ].join("\n"),
};

/** Detect the prompt family from a model id (case-insensitive substring match). */
export function detectPromptFamily(modelId: string | undefined): PromptFamily {
  const id = (modelId ?? "").toLowerCase();
  if (id.includes("claude")) return "claude";
  if (id.includes("gpt") || id.includes("chatgpt")) return "gpt";
  if (id.includes("qwen")) return "qwen";
  if (id.includes("llama")) return "llama";
  if (id.includes("gemini")) return "gemini";
  return "generic";
}

/** Resolve the effective family: an explicit provider setting wins; `auto`/unset detects from the model id. */
export function resolvePromptFamily(setting: PromptFamilySetting | undefined, modelId: string | undefined): PromptFamily {
  if (setting && setting !== "auto") return setting;
  return detectPromptFamily(modelId);
}

/** The framing fragment for a family; `generic` has none (byte-identical default prompt). */
export function promptFamilyFragment(family: PromptFamily): string | undefined {
  return family === "generic" ? undefined : FAMILY_FRAGMENTS[family];
}

/** Lenient variant for stored provider configs: garbage means "unset". */
export function normalizePromptFamilySetting(value: unknown): PromptFamilySetting | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim().toLowerCase();
  if (normalized === "auto") return "auto";
  return (PROMPT_FAMILIES as readonly string[]).includes(normalized) ? (normalized as PromptFamily) : undefined;
}

/** Strict variant for env/settings: garbage fails fast like the other enum settings. */
export function parsePromptFamilySetting(value: string | undefined, source = "LLM_PROMPT_FAMILY"): PromptFamilySetting {
  if (value === undefined || value.trim() === "") return "auto";
  const normalized = normalizePromptFamilySetting(value);
  if (!normalized) {
    throw new Error(`Invalid ${source}: ${value} (expected auto, claude, gpt, qwen, llama, gemini, or generic)`);
  }
  return normalized;
}
