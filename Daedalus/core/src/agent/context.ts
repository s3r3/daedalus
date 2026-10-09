import { readFile } from 'node:fs/promises';
import { resolve, sep } from 'node:path';
import type { ContentBlock, Message, ToolDefinition } from '../providers/llm/types.ts';
import type { Attachment, PromptFamily, TaskDomain, TaskState } from '../contracts.ts';
import { buildPrompt, estimateTokens, systemMessage, userMessage } from '../providers/index.ts';
import { modePromptContract } from '../interaction/modes.ts';
import { MAX_SKILLS_IN_PROMPT, dedupeSkillsByName, formatSkillOrigin, type SkillInfo, type SkillOrigin } from '../skills/index.ts';
import { walkTreeLines } from '../tools/filesystem/index.ts';
import { promptFamilyFragment } from './prompt-dialects.ts';
import { resolveMentionSection } from './mentions.ts';
import { SLIDE_TEMPLATES } from '../slides/templates.ts';
import type { ContextManager, Observation } from './types.ts';

export type ContextManagerOptions = {
  budget?: number;
  /** Product domain of this task; 'slide' pins the deck-only contract and hides presentation-maker skills. Absent = coding. */
  domain?: TaskDomain;
  /** Slide composer parameters (generation flow, target count, language, template); rendered into the slide contract. */
  slide?: SlideTaskParams;
  workspaceRoot?: string;
  visionEnabled?: boolean;
  maxImageBytes?: number;
  maxImages?: number;
  /** Skills found on disk; advertised so the model can load one via read_skill. */
  skills?: SkillInfo[];
  /**
   * Skills the user explicitly invoked for this task (`/skill <name>`):
   * bodies already rendered (the runtime renders them exactly like a
   * read_skill result) and force-loaded into the prompt, marked as
   * user-invoked. Absent/empty → no section, prompt unchanged.
   */
  invokedSkills?: Array<{ name: string; origin: SkillOrigin; text: string }>;
  /** Project rules text loaded from the workspace (see agent/rules.ts); shown verbatim to the model. */
  rules?: string;
  /** Files the rules text came from, for display in the prompt header. */
  rulesFiles?: string[];
  /** Standing instructions from a file-defined subagent (.daedalus/agents/<name>.md); appended for this run only. */
  agentInstructions?: string;
  /** Name of the subagent running this task, for the prompt header. */
  agentName?: string;
  /**
   * Prompt dialect family (tailor suite). Only non-`generic` families add a
   * framing fragment; generic/unset leaves the prompt byte-identical.
   */
  promptFamily?: PromptFamily;
  /** Workspace-relative paths the user pinned (tailor suite); shown in the workspace overview section. */
  pins?: string[];
  /**
   * Scaffold playbook for this task (agent/scaffold.ts), rendered by the
   * runtime only when the goal asks to create a new framework project.
   * Absent → no section, prompt unchanged.
   */
  scaffoldPlaybook?: string;
};

/**
 * Skill-index clamps (request-size discipline): one long description must
 * not flood every fresh prompt, and the whole index stays under a total
 * character budget. Skills past the character budget are still listed by
 * NAME (origin kept) so the model can load them via read_skill; skills
 * past the count cap keep the existing "+N more" honesty line.
 */
export const MAX_SKILL_DESCRIPTION_CHARS = 160;
export const MAX_SKILL_INDEX_CHARS = 6_000;

const DEFAULT_MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const DEFAULT_MAX_IMAGES = 4;
/** Pins shown in the prompt: count, per-file excerpt, and total budget caps. */
export const MAX_PINNED_FILES_IN_PROMPT = 10;
export const MAX_PINNED_LINES_PER_FILE = 6;
export const MAX_PINNED_TOTAL_CHARS = 2_400;

/**
 * Slide-domain contract (domain: 'slide'), pinned into every prompt of a
 * slide task: deck production runs on the built-in deck tools alone, in
 * outline-first order. Coding tasks never see this section.
 */
/** Slide task parameters chosen in the Slide composer (generation flow, target count, content language, pre-picked template). */
export type SlideTaskParams = {
  generation?: 'smart' | 'standard';
  slideCount?: number;
  language?: string;
  templateId?: string;
};

export function buildSlideDomainPrompt(params: SlideTaskParams = {}): string {
  const generation = params.generation ?? 'standard';
  return [
    'Slide domain (slide mode): this task produces a presentation deck. Slide mode is the only mode in this domain; Ask/Manual/Auto/Plan belong to the Coding domain and do not exist here.',
    'You have ONLY the built-in deck tools (create_deck, read_deck, add_slide, update_slide, move_slide, delete_slide, set_deck_theme, validate_deck, export_deck) plus ask_user for substantive clarifications. There are no coding tools in this domain, no skills to load, and no external presentation service or API — the deck tools are the whole surface.',
    generation === 'standard'
      ? 'STANDARD flow: (1) Call create_deck, then add_slide once per outline item (title + layout skeleton only) so the complete outline exists before any content is filled in. (2) CHECKPOINT: call ask_user presenting the outline (the slide titles in order) and asking the user to pick a design direction; the choices are the bundled templates listed below (offer up to four, by template id) plus continuing without a template. This is a hard pause: wait for the answer. (3) Apply the chosen template with set_deck_theme {templateId} (skip when the user chose none). (4) Fill each slide with update_slide, preferring visual layouts (diagram, chart, icon-grid, stats, timeline, comparison) over plain bullet lists. (5) Call validate_deck and fix every error it reports. (6) Call export_deck.'
      : 'SMART flow: build the deck in one pass — create_deck, add_slide with full content per slide (prefer visual layouts over plain bullets), then validate_deck, fix every error, then export_deck. Use ask_user only when the topic or audience is genuinely ambiguous, never for slide count or language (those are UI controls).',
    `Bundled templates (design directions): ${SLIDE_TEMPLATES.map((t) => `${t.id} — ${t.name}: ${t.description}`).join(' | ')}`,
    ...(params.templateId ? [`The user already picked template "${params.templateId}" in the UI: pass it as templateId to create_deck (or set_deck_theme immediately after) and do not ask about design direction again.`] : []),
    ...(params.slideCount ? [`Target exactly ${params.slideCount} slides — the user chose this count in the UI — unless their message explicitly says otherwise.`] : []),
    ...(params.language ? [`Write all deck content (titles, points, notes) in this language: ${params.language}.`] : []),
    'The deliverable is the exported .pptx file, not a document: never write slide content as .md/.txt files and never build or convert slides with scripts. If deck/deck.json already exists in this workspace, continue that deck with read_deck instead of starting over.',
    'Do not report done before export_deck succeeds.',
  ].join('\n');
}

export const SLIDE_DOMAIN_PROMPT = buildSlideDomainPrompt();

/**
 * Context Manager: ordered prompt sections (role, task, plan, constraints),
 * token budgeting, and observation truncation (PLAN.md §3.1).
 *
 * Attachments are listed as metadata for every task. Image bytes are added as
 * OpenAI-compatible `image_url` data URLs only when the caller has resolved
 * that the selected provider/model supports vision; otherwise the prompt says
 * explicitly that the image bytes were not sent.
 */
export class DefaultContextManager implements ContextManager {
  readonly #domain?: TaskDomain;
  readonly #budget: number;
  readonly #workspaceRoot?: string;
  readonly #visionEnabled: boolean;
  readonly #maxImageBytes: number;
  readonly #maxImages: number;
  readonly #skills: SkillInfo[];
  readonly #invokedSkills: Array<{ name: string; origin: SkillOrigin; text: string }>;
  readonly #rules?: string;
  readonly #rulesFiles: string[];
  readonly #agentInstructions?: string;
  readonly #agentName?: string;
  readonly #promptFamily: PromptFamily;
  readonly #pins: string[];
  readonly #scaffoldPlaybook?: string;
  readonly #slide?: SlideTaskParams;

  constructor(options: number | ContextManagerOptions = 16_000) {
    const resolved = typeof options === 'number' ? { budget: options } : options;
    this.#domain = resolved.domain;
    this.#slide = resolved.slide;
    this.#budget = resolved.budget ?? 16_000;
    this.#workspaceRoot = resolved.workspaceRoot;
    this.#visionEnabled = resolved.visionEnabled === true;
    this.#maxImageBytes = resolved.maxImageBytes ?? DEFAULT_MAX_IMAGE_BYTES;
    this.#maxImages = resolved.maxImages ?? DEFAULT_MAX_IMAGES;
    // Deduped by name at the door: whatever list a caller hands in, the
    // prompt advertises each skill once (the loader already dedupes, this
    // keeps the guarantee for direct/raw feeds too). In the Slide domain
    // no skills are advertised at all: the slide registry has no
    // read_skill, so an index would advertise a door that does not exist.
    const listedSkills = dedupeSkillsByName(resolved.skills ?? []);
    this.#skills = resolved.domain === 'slide' ? [] : listedSkills;
    this.#invokedSkills = resolved.invokedSkills ?? [];
    this.#rules = resolved.rules;
    this.#rulesFiles = resolved.rulesFiles ?? [];
    this.#agentInstructions = resolved.agentInstructions;
    this.#agentName = resolved.agentName;
    this.#promptFamily = resolved.promptFamily ?? 'generic';
    this.#pins = resolved.pins ?? [];
    this.#scaffoldPlaybook = resolved.scaffoldPlaybook;
  }

  async buildMessages(state: TaskState, observations: Observation[], tools?: ToolDefinition[]): Promise<Message[]> {
    const workspaceOverview = await this.#workspaceOverview(state);
    // @-mentions resolve in the harness (see mentions.ts), never by the
    // model: no mentions in the goal → no section, prompt byte-identical.
    const mentionSection = await resolveMentionSection(this.#workspaceRoot ?? state.repo_path, state.goal);
    const template = {
      version: '1.0.0',
      sections: [
        { id: 'role', content: 'You are Daedalus, an autonomous coding agent operating on a local repository.' },
        { id: 'task', content: state.goal },
        { id: 'repo', content: `Repository: ${state.repo_path}` },
        ...(workspaceOverview
          ? [{
              id: 'workspace',
              content: workspaceOverview,
            }]
          : []),
        ...(mentionSection
          ? [{
              id: 'mentions',
              content: mentionSection,
            }]
          : []),
        { id: 'plan', content: state.steps.map((s) => `- [${s.status}] ${s.intent}`).join('\n') || '(no plan yet)' },
        { id: 'mode', content: modePromptContract(state.mode ?? 'auto') },
        ...(this.#domain === 'slide'
          ? [{ id: 'domain', content: buildSlideDomainPrompt(this.#slide) }]
          : []),
        { id: 'constraints', content: state.constraints.join('\n') || '(none)' },
        {
          id: 'protocol',
          content: this.#domain === 'slide'
            ? 'Respond with a tool call to act, or reply starting with "done: <summary>" only after export_deck has succeeded, "replan: <reason>" to amend the plan, or "stop: <reason>" to abort. read_deck is evidence only; before "done:" the deck must exist, validate clean, and be exported. If a previous model response was invalid prose, answer with a concrete deck tool call next. Bias to action: build the deck, do not narrate it.'
            : 'Respond with a tool call to act, or reply starting with "done: <summary>" when every plan step is satisfied, "replan: <reason>" to amend the plan, or "stop: <reason>" to abort. Read-only inspection (list/read/search) is evidence only: it finishes an inspection step, never an implementation criterion. Before "done:" on a mutating task, call a mutating tool (write_file, edit_file, create_dir) or run_command and let validation prove it. If a previous model response was invalid prose, answer with a concrete tool call next. Do not repeat list_dir/read on the same path: the workspace overview below (and any listing already returned) is your structure reference — with enough structure, mutate (create_dir, write_file, edit_file) instead of exploring further. Bias to action: deliver the working result, not a plan about it; create the folder/file as soon as you know where it goes, and finish with "done: <what you made and where>".',
        },
        // Prompt dialect (tailor suite): framing conventions per model
        // family. `generic` contributes no section at all, keeping the
        // default prompt byte-identical to the pre-dialect one.
        ...(promptFamilyFragment(this.#promptFamily)
          ? [{ id: 'dialect', content: promptFamilyFragment(this.#promptFamily)! }]
          : []),
        ...(this.#scaffoldPlaybook
          ? [{
              id: 'scaffold playbook',
              content: this.#scaffoldPlaybook,
            }]
          : []),
        ...(this.#skills.length
          ? [{
              id: 'skills',
              content: `Available skills (playbooks stored on disk; call the read_skill tool with the skill name to load its full instructions before following it):\n${this.#skillIndexLines()}${this.#skills.length > MAX_SKILLS_IN_PROMPT ? `\n+${this.#skills.length - MAX_SKILLS_IN_PROMPT} more skills available — use read_skill by name` : ''}`,
            }]
          : []),
        ...(this.#invokedSkills.length
          ? [{
              id: 'invoked-skills',
              content: `Skills the user explicitly invoked for this task — their full instructions follow; apply them to this task:\n\n${this.#invokedSkills.map((skill) => skill.text).join('\n\n')}`,
            }]
          : []),
        ...(this.#rules
          ? [{
              id: 'rules',
              content: `Project rules for this workspace${this.#rulesFiles.length ? ` (loaded from ${this.#rulesFiles.join(', ')})` : ''}. Follow them unless they conflict with the task itself:\n${this.#rules}`,
            }]
          : []),
        ...(this.#agentInstructions
          ? [{
              id: 'subagent',
              content: `You are running as the subagent "${this.#agentName ?? 'unnamed'}" (.daedalus/agents). Follow these standing instructions on top of the task and the project rules:\n${this.#agentInstructions}`,
            }]
          : []),
      ],
    };
    const messages: Message[] = [systemMessage(buildPrompt(template)), userMessage(state.last_observation ?? state.goal)];
    const attachmentMessage = await this.#attachmentMessage(state);
    if (attachmentMessage) messages.push(attachmentMessage);
    for (const observation of observations) {
      if (observation.kind === 'tool_result') {
        messages.push({ role: 'tool', content: truncate(observation.result.output, 4_000), tool_call_id: observation.result.call_id });
      } else if (observation.kind === 'assistant') {
        messages.push(observation.message);
      }
    }
    if (tools?.length) {
      messages.push(userMessage(`Available tools: ${tools.map((t) => t.function.name).join(', ')}`));
    }
    return this.compact(messages, this.#budget);
  }

  /**
   * The skill index body: at most MAX_SKILLS_IN_PROMPT entries, each
   * description hard-clamped, with a TOTAL character budget for the
   * described lines. Entries past the budget keep their name + origin
   * (the model can still read_skill them); the "+N more" line is added
   * by the caller for skills past the count cap.
   */
  #skillIndexLines(): string {
    const lines: string[] = [];
    let used = 0;
    for (const skill of this.#skills.slice(0, MAX_SKILLS_IN_PROMPT)) {
      const description = skill.description.length > MAX_SKILL_DESCRIPTION_CHARS
        ? `${skill.description.slice(0, MAX_SKILL_DESCRIPTION_CHARS - 1)}…`
        : skill.description;
      const full = `- ${skill.name}: ${description} (${formatSkillOrigin(skill.origin)})`;
      if (used + full.length + 1 <= MAX_SKILL_INDEX_CHARS) {
        lines.push(full);
        used += full.length + 1;
      } else {
        lines.push(`- ${skill.name} (${formatSkillOrigin(skill.origin)})`);
      }
    }
    return lines.join('\n');
  }

  /**
   * Shallow, filtered workspace tree shipped with every prompt, so the model
   * starts with the repository structure instead of spending its first turns
   * re-listing the root (the classic exploration loop). Dependency/state
   * folders are pruned by the shared tree walker; failures are silent (the
   * section is simply omitted).
   */
  async #workspaceOverview(state: TaskState): Promise<string | undefined> {
    const root = this.#workspaceRoot ?? state.repo_path;
    if (!root) return undefined;
    const pinned = await this.#pinnedSection(root);
    try {
      const { lines, total, truncated } = await walkTreeLines(resolve(root), { maxDepth: 2, maxEntries: 60 });
      if (lines.length === 0) return pinned;
      const remainder = truncated ? `\n… (${total - lines.length} more entries, truncated)` : '';
      return [
        `Workspace overview (shallow tree of ${root}; node_modules, .git, .daedalus and dist omitted):`,
        ...lines,
        remainder.trim() ? remainder.trim() : undefined,
        'You already have this overview — do not call list_dir on the workspace root again just to see the structure. List one specific subfolder only when you need deeper detail, and never re-list a directory you have already listed.',
        pinned,
      ].filter(Boolean).join('\n');
    } catch {
      return pinned;
    }
  }

  /**
   * User-pinned paths (tailor suite), appended to the workspace overview:
   * the pin list itself plus a short first-lines excerpt per file, so the
   * model starts oriented around what the user marked important. Hard caps
   * (count, per-file lines, total chars) keep pins from flooding the prompt;
   * an over-cap or unreadable pin degrades to its path alone, silently.
   */
  async #pinnedSection(root: string): Promise<string | undefined> {
    if (this.#pins.length === 0) return undefined;
    const shown = this.#pins.slice(0, MAX_PINNED_FILES_IN_PROMPT);
    const lines: string[] = [
      `Pinned by user (treat as important; ${shown.length} of ${this.#pins.length} pin${this.#pins.length === 1 ? '' : 's'} shown):`,
    ];
    let used = 0;
    let capped = false;
    for (const pin of shown) {
      const excerpt = await this.#pinExcerpt(root, pin);
      const entry = excerpt ? `- ${pin}\n${excerpt}` : `- ${pin}`;
      if (used + entry.length > MAX_PINNED_TOTAL_CHARS) {
        lines.push(`- ${pin}`);
        capped = true;
        continue;
      }
      used += entry.length;
      lines.push(entry);
    }
    if (this.#pins.length > shown.length || capped) {
      lines.push(`… (pinned overview truncated at ${MAX_PINNED_TOTAL_CHARS} chars / ${MAX_PINNED_FILES_IN_PROMPT} entries — read_file a pinned path for its full content)`);
    }
    return lines.join('\n');
  }

  async #pinExcerpt(root: string, pin: string): Promise<string | undefined> {
    try {
      const absolute = resolve(root, pin);
      if (absolute !== root && !absolute.startsWith(root + sep)) return undefined;
      const data = await readFile(absolute, 'utf8');
      const head = data.split('\n').slice(0, MAX_PINNED_LINES_PER_FILE).join('\n').trim();
      if (!head) return undefined;
      return head.split('\n').map((line) => `  | ${line}`).join('\n');
    } catch {
      // Directories and unreadable pins still appear as paths.
      return undefined;
    }
  }

  async #attachmentMessage(state: TaskState): Promise<Message | undefined> {
    const attachments = state.attachments ?? [];
    if (attachments.length === 0) return undefined;

    const blocks: ContentBlock[] = [];
    const lines = ['Attached files for this task:'];
    let imagesIncluded = 0;

    for (const attachment of attachments) {
      const mime = attachment.mimeType ?? (attachment.kind === 'image' ? 'image/*' : 'application/octet-stream');
      lines.push(`- ${attachment.kind} ${attachment.name} (${attachment.workspacePath}, ${mime}, ${attachment.size} bytes)`);

      if (attachment.kind !== 'image') continue;
      if (!this.#visionEnabled) {
        lines.push('  Image bytes were not sent because the selected model does not support vision.');
        continue;
      }
      if (imagesIncluded >= this.#maxImages) {
        lines.push(`  Image bytes were not sent because the per-request image limit (${this.#maxImages}) was reached.`);
        continue;
      }
      const imageBlock = await this.#imageBlock(state, attachment);
      if (!imageBlock) {
        lines.push('  Image bytes were not sent because the file could not be read inside the workspace or exceeds the image size limit.');
        continue;
      }
      blocks.push(imageBlock);
      imagesIncluded++;
    }

    return {
      role: 'user',
      content: [{ type: 'text', text: lines.join('\n') }, ...blocks],
    };
  }

  async #imageBlock(state: TaskState, attachment: Attachment): Promise<ContentBlock | undefined> {
    const root = resolve(this.#workspaceRoot ?? state.repo_path);
    const candidate = attachment.path ? resolve(attachment.path) : resolve(root, attachment.workspacePath);
    if (candidate !== root && !candidate.startsWith(root + sep)) return undefined;
    try {
      const data = await readFile(candidate);
      if (data.length === 0 || data.length > this.#maxImageBytes) return undefined;
      const mime = attachment.mimeType?.startsWith('image/') ? attachment.mimeType : mimeFromName(attachment.name);
      if (!mime) return undefined;
      return { type: 'image_url', image_url: { url: `data:${mime};base64,${data.toString('base64')}` } };
    } catch {
      return undefined;
    }
  }

  async compact(messages: Message[], budget: number): Promise<Message[]> {
    const system = messages[0];
    const rest = messages.slice(1);
    const result: Message[] = [];
    let used = system ? this.estimate([system]) : 0;
    for (let i = rest.length - 1; i >= 0; i--) {
      const message = rest[i]!;
      const cost = this.estimate([message]);
      if (used + cost > budget) continue;
      used += cost;
      result.unshift(message);
    }
    return system ? [system, ...result] : result;
  }

  estimate(messages: Message[]): number {
    let total = 0;
    for (const message of messages) {
      const text = typeof message.content === 'string' ? message.content : JSON.stringify(message.content);
      total += estimateTokens(text);
      if (message.tool_calls?.length) total += estimateTokens(JSON.stringify(message.tool_calls));
    }
    return total;
  }
}

function mimeFromName(name: string): string | undefined {
  const lower = name.toLowerCase();
  if (lower.endsWith('.png')) return 'image/png';
  if (lower.endsWith('.jpg') || lower.endsWith('.jpeg')) return 'image/jpeg';
  if (lower.endsWith('.gif')) return 'image/gif';
  if (lower.endsWith('.webp')) return 'image/webp';
  if (lower.endsWith('.svg')) return 'image/svg+xml';
  return undefined;
}

/** Truncate large observations with explicit metadata (ACI principle, PLAN.md §2.4). */
export function truncate(text: string, limit: number): string {
  if (text.length <= limit) return text;
  const kept = text.slice(0, limit);
  return `${kept}\n…[truncated ${text.length - limit} chars of ${text.length}]`;
}

export const CONDENSED_TOOL_OUTPUT = '(earlier tool output condensed to save context)';
export const CONDENSE_THRESHOLD = 0.7;
export const CONDENSE_KEEP_RECENT_TOOL_MESSAGES = 6;

/** Token estimate for a message list (chars/4 heuristic, same as the context budget). */
export function estimateMessageTokens(messages: Message[]): number {
  let total = 0;
  for (const message of messages) {
    const text = typeof message.content === 'string' ? message.content : JSON.stringify(message.content);
    total += estimateTokens(text);
    if (message.tool_calls?.length) total += estimateTokens(JSON.stringify(message.tool_calls));
  }
  return total;
}

/**
 * Context condensing: when the outgoing list exceeds `threshold` of the
 * context limit, replace the *contents* of older tool results (all but the
 * most recent `keepRecentToolMessages`) with a one-line placeholder. Message
 * roles and `tool_call_id` links are preserved, so the list stays structurally
 * valid for the provider — only the bulky payloads shrink.
 */
export function condenseToolOutputs(
  messages: Message[],
  options: { limitTokens: number; threshold?: number; keepRecentToolMessages?: number },
): Message[] {
  const limit = options.limitTokens;
  if (!Number.isFinite(limit) || limit <= 0) return messages;
  if (estimateMessageTokens(messages) <= limit * (options.threshold ?? CONDENSE_THRESHOLD)) return messages;
  const keep = options.keepRecentToolMessages ?? CONDENSE_KEEP_RECENT_TOOL_MESSAGES;
  const toolIndexes = messages
    .map((message, index) => (message.role === 'tool' ? index : -1))
    .filter((index) => index >= 0);
  if (toolIndexes.length <= keep) return messages;
  const condensed = new Set(toolIndexes.slice(0, toolIndexes.length - keep));
  return messages.map((message, index) => (condensed.has(index) ? { ...message, content: CONDENSED_TOOL_OUTPUT } : message));
}

/** Context-meter snapshot attached to MODEL_REQUEST_* event payloads. */
export function contextMeter(messages: Message[], limitTokens: number): { context_estimate_tokens: number; context_limit_tokens: number; context_percent: number } {
  const estimate = estimateMessageTokens(messages);
  const limit = Number.isFinite(limitTokens) && limitTokens > 0 ? limitTokens : 128_000;
  return {
    context_estimate_tokens: estimate,
    context_limit_tokens: limit,
    context_percent: Math.min(100, Math.round((estimate / limit) * 1000) / 10),
  };
}
