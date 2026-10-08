import { translate, type UiLocale } from "@/i18n/messages";

export type AgentToolState = "pending" | "running" | "complete" | "error";
export type AgentToolKind = "tool" | "read" | "write" | "edit" | "bash" | "todo" | "files" | "search";

export interface AgentTodoItem {
  id: string;
  content: string;
  status: "pending" | "in_progress" | "complete" | "error";
}

export interface AgentToolCall {
  id: string;
  name: string;
  label: string;
  detail?: string;
  kind?: AgentToolKind;
  path?: string;
  relativePath?: string;
  command?: string;
  output?: string;
  todos?: AgentTodoItem[];
  files?: Array<{ path: string; relativePath: string; name: string; kind?: "document" | "image" | "data" | "code" | "other" }>;
  state: AgentToolState;
}

export interface AgentProcess {
  state: "running" | "complete" | "error";
  title: string;
  notes?: string[];
  tools: AgentToolCall[];
}

/**
 * An assistant turn can be an ordered mix of Markdown prose and tool calls so
 * the chat reads like a real agent transcript (text → tool → text → tool)
 * instead of one monolithic activity card.
 */
export interface MessageTextBlock {
  id: string;
  type: "text";
  /** GitHub-flavored Markdown. */
  text: string;
}
export interface MessageToolBlock {
  id: string;
  type: "tool";
  tool: AgentToolCall;
}
export type MessageBlock = MessageTextBlock | MessageToolBlock;

/** A task in the project-wide (cross-turn) checklist shown pinned above the chat. */
export type GlobalTodoStatus = "pending" | "in_progress" | "complete" | "error";
export interface GlobalTodoItem {
  id: string;
  content: string;
  status: GlobalTodoStatus;
  /** Label of the request that spawned this task, so the panel can group tasks. */
  group?: string;
  /** Id of the assistant turn that owns this task. */
  turnId?: string;
  ts?: number;
}

export function createAgentRunId(prefix = "run") {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

export function elapsedRunLabel(startedAt: number, locale: UiLocale = "en") {
  const seconds = Math.max(1, Math.round((Date.now() - startedAt) / 1000));
  if (seconds < 60) return translate(locale, "agent.ranSeconds", { seconds });
  const minutes = Math.floor(seconds / 60);
  return translate(locale, "agent.ranMinutes", { minutes, seconds: seconds % 60 });
}

export function patchAgentTool(
  process: AgentProcess,
  id: string,
  patch: Partial<Omit<AgentToolCall, "id">>,
): AgentProcess {
  return {
    ...process,
    tools: process.tools.map((tool) => (tool.id === id ? { ...tool, ...patch } : tool)),
  };
}

export function patchAgentTools(
  process: AgentProcess,
  predicate: (tool: AgentToolCall) => boolean,
  patch: Partial<Omit<AgentToolCall, "id">>,
): AgentProcess {
  return {
    ...process,
    tools: process.tools.map((tool) => (predicate(tool) ? { ...tool, ...patch } : tool)),
  };
}

export function stopRunningTools(process: AgentProcess, detail?: string): AgentProcess {
  return {
    ...process,
    tools: process.tools.map((tool) =>
      tool.state === "running" || tool.state === "pending"
        ? { ...tool, state: "error", detail: detail ?? tool.detail }
        : tool,
    ),
  };
}

// ---- interleaved message blocks --------------------------------------------

/** Append a block, or replace an existing block with the same id (idempotent). */
export function upsertBlock(blocks: MessageBlock[] | undefined, block: MessageBlock): MessageBlock[] {
  const list = blocks ?? [];
  return list.some((item) => item.id === block.id)
    ? list.map((item) => (item.id === block.id ? block : item))
    : [...list, block];
}

/** Patch the tool carried by a tool block. */
export function patchBlockTool(
  blocks: MessageBlock[] | undefined,
  id: string,
  patch: Partial<Omit<AgentToolCall, "id">>,
): MessageBlock[] {
  return (blocks ?? []).map((block) =>
    block.type === "tool" && block.id === id
      ? { ...block, tool: { ...block.tool, ...patch } }
      : block,
  );
}

/** Settle any still-running tool block (used when a turn errors out). */
export function stopRunningBlocks(blocks: MessageBlock[] | undefined, detail?: string): MessageBlock[] {
  return (blocks ?? []).map((block) =>
    block.type === "tool" && (block.tool.state === "running" || block.tool.state === "pending")
      ? { ...block, tool: { ...block.tool, state: "error" as const, detail: detail ?? block.tool.detail } }
      : block,
  );
}
