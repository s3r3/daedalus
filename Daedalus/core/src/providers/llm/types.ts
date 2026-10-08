/**
 * Canonical LLM types and provider contract.
 *
 * Provider-agnostic: `AgentLoop` (Phase 3) consumes only these shapes, so a
 * second provider can be registered without touching the loop.
 */

export type Role = "system" | "user" | "assistant" | "tool";

export type TextContent = { type: "text"; text: string };

export type ImageContent = { type: "image_url"; image_url: { url: string } };

export type ContentBlock = TextContent | ImageContent;

export type ToolCall = {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
};

export type Message = {
  role: Role;
  content: string | ContentBlock[];
  name?: string;
  tool_call_id?: string;
  tool_calls?: ToolCall[];
  /** Provider-supplied reasoning text (OpenAI-compatible variants), when present. */
  reasoning_content?: string;
  reasoning?: string;
  thinking?: string;
};

export type ToolDefinition = {
  type: "function";
  function: {
    name: string;
    description?: string;
    parameters?: Record<string, unknown>;
  };
};

export type Usage = {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
};

export type ChatResponse = {
  message: Message;
  usage?: Usage;
  finish_reason?: string;
  raw?: unknown;
};

/**
 * What kind of work a chat call is doing (tailor suite phase routing). The
 * agent loop stamps each request so a model pool can spend strong models on
 * editing/repair turns and fast/balanced models on exploration and Q&A.
 * Providers that do no routing simply ignore it.
 */
export type ModelPhase = "explore" | "edit" | "repair" | "question";

export type ChatOptions = {
  temperature?: number;
  max_tokens?: number;
  top_p?: number;
  stop?: string[];
  signal?: AbortSignal;
  timeout_ms?: number;
  /** Tailor-suite phase hint for tier routing; ignored by non-pool providers. */
  phase?: ModelPhase;
};

export type StreamChunk =
  | { type: "delta"; content: string; tool_calls?: Partial<ToolCall>[]; reasoning?: string }
  | { type: "usage"; usage: Usage }
  | { type: "finish"; finish_reason?: string };

/**
 * Provider contract. `chat` is non-streaming; `stream` is streaming.
 * Both must honour `signal` and `timeout_ms`.
 */
export interface LLMProvider {
  readonly name: string;
  chat(messages: Message[], tools?: ToolDefinition[], options?: ChatOptions): Promise<ChatResponse>;
  stream(
    messages: Message[],
    tools?: ToolDefinition[],
    options?: ChatOptions,
  ): AsyncIterable<StreamChunk>;
}