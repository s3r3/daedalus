// Conversational editing (M4): turn a natural-language edit into a concrete plan
// (which slides to change + the instruction). Execution reuses the validated
// per-slide regenerate route, so chat itself only classifies — it stays fast.

import { codexJson, parseLooseJson, type CodexInputAttachment } from "./codex-text";
import { runCliAgentText } from "./agents";
import type { AgentToolCall } from "./agentActivity";
import { buildDeckDesignSystemContext } from "./designSystem";
import { materialRolePrompt, scenarioPromptContext } from "./scenarios";
import type { DesignFileReference, Project } from "./types";

export interface ChatPlan {
  /**
   * answer — converse / analyze / summarize / explain; NO deck change. `reply`
   *          carries the full markdown answer.
   * edit   — change existing slides in `targets`.
   * add    — insert exactly one new slide.
   * `reply` (legacy) is accepted on input and folded into `answer`.
   */
  action: "answer" | "edit" | "add";
  reply: string;
  targets: number[]; // 1-based slide indices to regenerate
  afterIndex?: number; // add a new slide after this 1-based index; 0 = before slide 1
  title?: string; // exact resulting title when adding or explicitly retitling one slide
  instruction: string; // self-contained imperative change
  /** true when action=answer read at least one @-referenced file to answer. */
  readFiles?: boolean;
  /** Real tool events captured from local CLI agents (Codex JSONL today). */
  activities?: AgentToolCall[];
}

export interface ChatSlideContext {
  slideIndex: number;
  title?: string;
}

export function buildChatPrompt(
  project: Project,
  message: string,
  context?: ChatSlideContext,
  attachments: CodexInputAttachment[] = [],
  designFiles: DesignFileReference[] = [],
): string {
  const slides = project.pages
    .map((p) => `${p.index}. ${p.title}${p.points?.length ? ` — ${p.points.join("; ")}` : ""}`)
    .join("\n");
  const selected = context
    ? project.pages.find((page) => page.index === context.slideIndex)
    : undefined;
  return [
    "You are the collaborator for one presentation project. You do TWO different kinds of work, and you must pick the right one for each message:",
    "  1. CONVERSE — answer questions, summarize or analyze content, explain, compare, brainstorm, give opinions, or just chat. This changes NOTHING in the deck.",
    "  2. EDIT THE DECK — only when the user actually asks you to change the slides (rewrite, restyle, redraw, add, remove, reorder, translate, fix a slide).",
    "Default to CONVERSE. Never turn a question or a request to summarize/analyze into a new or edited slide. A user saying \"总结一下\" / \"summarize this\" / \"what do you think\" / \"解释一下\" wants an ANSWER in chat, not a new slide.",
    "",
    "Here are the current slides:",
    slides,
    "",
    `The deck's overall topic: ${project.title}.`,
    scenarioPromptContext(project.config.scenarioId),
    materialRolePrompt(project.config.materialContexts),
    buildDeckDesignSystemContext(project.config.designSystem),
    selected
      ? `The user attached slide ${selected.index} as the active context: "${selected.title}"${selected.points?.length ? `. Its content includes: ${selected.points.join("; ")}` : ""}. References such as "this slide", "after this", "before it", "这页", "它后面" refer to this slide.`
      : "No slide is attached to this turn.",
    attachments.length
      ? `The user attached ${attachments.length} new context item(s) to this turn: ${attachments.map((item) => item.name).join(", ")}. Read and use the actual attached content.`
      : "No new file or image is attached to this turn.",
    designFiles.length
      ? [
          "<design_file_references>",
          "The user explicitly referenced these local project files with @. Read the ones relevant to the request and use their real contents as source material for your answer or change:",
          ...designFiles.map((file) => `- ${file.name}: ${file.path}`),
          "</design_file_references>",
        ].join("\n")
      : "No Design Files path was referenced with @ in this turn.",
    "",
    `The user says: "${message}"`,
    "",
    "Return ONLY this JSON:",
    '{"action": "answer|edit|add", "reply": "the reply to the user", "readFiles": false, "targets": [slide numbers], "afterIndex": 0, "title": "short exact slide title when applicable", "instruction": "a self-contained imperative instruction"}',
    "",
    "How to choose the action:",
    "- action=answer — the user is asking, discussing, summarizing, analyzing, comparing, or chatting. Make NO deck change: targets=[], omit afterIndex, instruction=\"\". Set readFiles=true if you used any @-referenced file or attachment to answer.",
    "- action=edit — the user asked to change EXISTING slides. Put their 1-based indices in targets and omit afterIndex.",
    "- action=add — the user EXPLICITLY asked to insert a new slide/page/section. targets=[] and afterIndex is the slide number it follows (0 means before slide 1). title is the short exact new title. instruction fully describes the new slide's role, content, and visual direction.",
    "",
    "Writing `reply`:",
    "- For action=answer, `reply` IS your full answer — write it as clean GitHub-flavored Markdown (headings, short paragraphs, bullet or numbered lists, **bold**, `code`). Be genuinely useful and specific; when summarizing a file, summarize its ACTUAL contents, not a placeholder. It can be as long as the question needs. Do not claim you edited the deck.",
    "- For action=edit or add, `reply` is one short confirmation sentence of what you are changing.",
    "- Always write `reply` in the user's language.",
    "",
    "Rules for edits:",
    "- For action=edit, include title only when the user explicitly asks to rename/retitle exactly one target slide; otherwise omit it.",
    "- When an attached slide exists, resolve contextual wording against it. If the user asks to edit it, target that slide. If the user asks to add after it, afterIndex is that slide number. If they ask to add before it, afterIndex is one less.",
    "- If the user means the whole deck (all / 整体 / 全部 / every slide / restyle), targets = ALL slide numbers.",
    "- If they name a slide, a number, or a topic to change, resolve it to the matching slide number(s).",
    "- instruction must be concrete and standalone (include the style/tone/content change explicitly). Keep on-slide text meaning unless the user asks to change it.",
    "- Treat <brand_design_system> as always-on project context. Preserve it for every deck change unless the user's latest message explicitly overrides a rule for the requested slide(s).",
    "- If a request to change the deck is genuinely ambiguous (you cannot tell which slides or what change), use action=answer and ask ONE brief clarifying question instead of guessing.",
  ].join("\n");
}

export function parseChatPlan(raw: any, pageCount: number): ChatPlan {
  const targetsRaw = Array.isArray(raw?.targets) ? raw.targets : [];
  const targets = Array.from(
    new Set(
      targetsRaw
        .map((n: any) => Math.trunc(Number(n)))
        .filter((n: number) => Number.isInteger(n) && n >= 1 && n <= pageCount),
    ),
  ) as number[];
  const requestedAfter = Math.trunc(Number(raw?.afterIndex));
  const afterIndex = Number.isInteger(requestedAfter)
    ? Math.max(0, Math.min(pageCount, requestedAfter))
    : undefined;
  const rawAction = String(raw?.action ?? "").toLowerCase();
  // Only treat a turn as an edit when the model explicitly says so. A bare list
  // of `targets` no longer forces an edit — that used to turn "summarize slides
  // 1-3" into a redraw. Legacy "reply" folds into "answer".
  const action: ChatPlan["action"] =
    rawAction === "add"
      ? "add"
      : rawAction === "edit"
        ? "edit"
        : rawAction === "answer" || rawAction === "reply"
          ? "answer"
          : targets.length
            ? "edit"
            : "answer";
  const title = String(raw?.title ?? "").trim().slice(0, 80);
  return {
    action,
    reply: String(raw?.reply ?? "Done."),
    targets: action === "edit" ? targets : [],
    afterIndex: action === "add" ? (afterIndex ?? pageCount) : undefined,
    title: action !== "answer" && title ? title : undefined,
    instruction: String(raw?.instruction ?? "").trim(),
    readFiles: action === "answer" ? Boolean(raw?.readFiles) : undefined,
  };
}

export async function planChatEdit(
  project: Project,
  message: string,
  context?: ChatSlideContext,
  attachments: CodexInputAttachment[] = [],
  designFiles: DesignFileReference[] = [],
  signal?: AbortSignal,
): Promise<ChatPlan> {
  const prompt = buildChatPrompt(project, message, context, attachments, designFiles);
  const localAttachments = attachments.filter((attachment) => attachment.path);
  const localPrompt = localAttachments.length
    ? [
        prompt,
        "",
        "Local context paths available for this turn:",
        ...localAttachments.map((attachment) => `- ${attachment.name}: ${attachment.path}`),
      ].join("\n")
    : prompt;
  if (project.config.engine === "codex") {
    const raw = await codexJson<any>(prompt, { signal, attachments });
    return parseChatPlan(raw, project.pages.length);
  }
  const result = await runCliAgentText(project.config.engine, localPrompt, { signal });
  return {
    ...parseChatPlan(parseLooseJson<any>(result.text), project.pages.length),
    activities: result.activities,
  };
}
