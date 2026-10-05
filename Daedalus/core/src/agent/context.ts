import { readFile } from 'node:fs/promises';
import { resolve, sep } from 'node:path';
import type { ContentBlock, Message, ToolDefinition } from '../providers/llm/types.ts';
import type { Attachment, TaskState } from '../contracts.ts';
import { buildPrompt, estimateTokens, systemMessage, userMessage } from '../providers/index.ts';
import type { SkillInfo } from '../skills/index.ts';
import type { ContextManager, Observation } from './types.ts';

export type ContextManagerOptions = {
  budget?: number;
  workspaceRoot?: string;
  visionEnabled?: boolean;
  maxImageBytes?: number;
  maxImages?: number;
  /** Skills found on disk; advertised so the model can load one via read_skill. */
  skills?: SkillInfo[];
  /** Project rules text loaded from the workspace (see agent/rules.ts); shown verbatim to the model. */
  rules?: string;
  /** Files the rules text came from, for display in the prompt header. */
  rulesFiles?: string[];
  /** Standing instructions from a file-defined subagent (.daedalus/agents/<name>.md); appended for this run only. */
  agentInstructions?: string;
  /** Name of the subagent running this task, for the prompt header. */
  agentName?: string;
};

const DEFAULT_MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const DEFAULT_MAX_IMAGES = 4;

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
  readonly #budget: number;
  readonly #workspaceRoot?: string;
  readonly #visionEnabled: boolean;
  readonly #maxImageBytes: number;
  readonly #maxImages: number;
  readonly #skills: SkillInfo[];
  readonly #rules?: string;
  readonly #rulesFiles: string[];
  readonly #agentInstructions?: string;
  readonly #agentName?: string;

  constructor(options: number | ContextManagerOptions = 16_000) {
    const resolved = typeof options === 'number' ? { budget: options } : options;
    this.#budget = resolved.budget ?? 16_000;
    this.#workspaceRoot = resolved.workspaceRoot;
    this.#visionEnabled = resolved.visionEnabled === true;
    this.#maxImageBytes = resolved.maxImageBytes ?? DEFAULT_MAX_IMAGE_BYTES;
    this.#maxImages = resolved.maxImages ?? DEFAULT_MAX_IMAGES;
    this.#skills = resolved.skills ?? [];
    this.#rules = resolved.rules;
    this.#rulesFiles = resolved.rulesFiles ?? [];
    this.#agentInstructions = resolved.agentInstructions;
    this.#agentName = resolved.agentName;
  }

  async buildMessages(state: TaskState, observations: Observation[], tools?: ToolDefinition[]): Promise<Message[]> {
    const template = {
      version: '1.0.0',
      sections: [
        { id: 'role', content: 'You are Daedalus, an autonomous coding agent operating on a local repository.' },
        { id: 'task', content: state.goal },
        { id: 'repo', content: `Repository: ${state.repo_path}` },
        { id: 'plan', content: state.steps.map((s) => `- [${s.status}] ${s.intent}`).join('\n') || '(no plan yet)' },
        { id: 'mode', content: `Current mode: ${state.mode ?? 'auto'}. Ask/Plan are read-only; Manual requires approval for mutations; Auto follows the session approval policy; Orchestrator coordinates child tasks.` },
        { id: 'constraints', content: state.constraints.join('\n') || '(none)' },
        {
          id: 'protocol',
          content:
            'Respond with a tool call to act, or reply starting with "done: <summary>" when every plan step is satisfied, "replan: <reason>" to amend the plan, or "stop: <reason>" to abort. Read-only inspection (list/read/search) is evidence only: it can finish an inspection step, but it does not satisfy an implementation criterion. Before using "done:" for a mutating task, call a mutating tool (write_file, edit_file, create_dir) or run_command as appropriate and let the validation gate prove the result. If a previous model response was invalid prose, answer with a concrete tool call next.',
        },
        ...(this.#skills.length
          ? [{
              id: 'skills',
              content: `Available skills (playbooks stored on disk; call the read_skill tool with the skill name to load its full instructions before following it):\n${this.#skills.map((skill) => `- ${skill.name}: ${skill.description}`).join('\n')}`,
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
