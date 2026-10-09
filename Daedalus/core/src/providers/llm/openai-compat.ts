import { LLMAuthError, LLMContentPolicyError, LLMError, LLMFormatError, LLMRateLimitError, LLMTimeoutError } from "./errors.ts";
import { normalizeToolSchemas } from "./schema-normalize.ts";
import type { ChatOptions, ChatResponse, LLMProvider, Message, StreamChunk, ToolDefinition, ToolCall, Usage } from "./types.ts";

export const DEFAULT_LLM_TIMEOUT_MS = 180_000;

export type OpenAICompatOptions = {
  baseUrl: string;
  apiKey: string;
  model: string;
  fetch?: typeof fetch;
  defaultTimeoutMs?: number;
};

type OpenAIResponse = {
  choices?: Array<{
    message?: { role?: string; content?: string | null; tool_calls?: ToolCall[]; reasoning_content?: unknown; reasoning?: unknown; thinking?: unknown };
    delta?: { content?: string | null; tool_calls?: Partial<ToolCall>[]; reasoning_content?: unknown; reasoning?: unknown; thinking?: unknown };
    finish_reason?: string | null;
  }>;
  usage?: Partial<Usage>;
  error?: { message?: string; code?: string; type?: string };
};

/** OpenAI Chat Completions-compatible provider without an SDK dependency. */
export class OpenAICompatProvider implements LLMProvider {
  readonly name = "openai-compatible";
  readonly #baseUrl: string;
  readonly #apiKey: string;
  readonly #model: string;
  readonly #fetch: typeof fetch;
  readonly #defaultTimeoutMs: number;

  constructor(options: OpenAICompatOptions) {
    this.#baseUrl = options.baseUrl.replace(/\/$/, "");
    this.#apiKey = options.apiKey;
    this.#model = options.model;
    this.#fetch = options.fetch ?? fetch;
    this.#defaultTimeoutMs = options.defaultTimeoutMs ?? DEFAULT_LLM_TIMEOUT_MS;
  }

  get model(): string {
    return this.#model;
  }

  get defaultTimeoutMs(): number {
    return this.#defaultTimeoutMs;
  }

  async chat(messages: Message[], tools?: ToolDefinition[], options: ChatOptions = {}): Promise<ChatResponse> {
    const response = await this.#request(messages, tools, options, false);
    if (!response.ok) {
      const json = (await response.json().catch(() => ({}))) as OpenAIResponse;
      throw providerHttpError(response.status, json, response.headers.get("retry-after"));
    }
    const json = (await response.json().catch(() => {
      throw new LLMFormatError("provider response is not valid JSON");
    })) as OpenAIResponse;
    return chatResponseFromJson(json);
  }

  async *stream(messages: Message[], tools?: ToolDefinition[], options: ChatOptions = {}): AsyncIterable<StreamChunk> {
    const response = await this.#request(messages, tools, options, true);
    if (!response.ok) {
      const json = (await response.json().catch(() => ({}))) as OpenAIResponse;
      throw providerHttpError(response.status, json, response.headers.get("retry-after"));
    }
    if (!response.body) throw new LLMFormatError("provider streaming response has no body");
    // Some gateways ignore stream:true and answer with the plain JSON
    // body. That response is already complete — surface it as chunks
    // instead of letting the caller retry and double-consume the turn.
    if ((response.headers.get("content-type") ?? "").includes("application/json")) {
      const json = (await response.json().catch(() => {
        throw new LLMFormatError("provider response is not valid JSON");
      })) as OpenAIResponse;
      const whole = chatResponseFromJson(json);
      const wholeText = typeof whole.message.content === "string" ? whole.message.content : "";
      if (wholeText || whole.message.tool_calls?.length) {
        yield {
          type: "delta",
          content: wholeText,
          tool_calls: whole.message.tool_calls,
          reasoning: whole.message.reasoning_content ?? whole.message.reasoning ?? whole.message.thinking,
        };
      }
      if (whole.usage) yield { type: "usage", usage: whole.usage };
      if (whole.finish_reason) yield { type: "finish", finish_reason: whole.finish_reason };
      return;
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    try {
      while (true) {
        const next = await reader.read();
        if (next.done) break;
        buffer += decoder.decode(next.value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";
        for (const line of lines) {
          if (!line.startsWith("data:")) continue;
          const data = line.slice(5).trim();
          if (data === "[DONE]") return;
          let chunk: OpenAIResponse;
          try { chunk = JSON.parse(data) as OpenAIResponse; } catch { throw new LLMFormatError("malformed streaming JSON"); }
          const choice = chunk.choices?.[0];
          const delta = choice?.delta;
          const reasoning = [delta?.reasoning_content, delta?.reasoning, delta?.thinking].find(
            (value): value is string => typeof value === "string" && value.length > 0,
          );
          // Tool-call fragments must be yielded even when the chunk
          // carries no text or reasoning: gateways that translate other
          // APIs often stream a tool call on its own (content null), and
          // dropping those chunks loses the whole call while the finish
          // chunk still reports finish_reason "tool_calls" — the turn
          // then reassembles to "..." with zero calls and the loop
          // re-prompts until the token budget kills the task (live
          // failure 2026-10-09, export_deck never landed).
          if (delta?.content || reasoning || delta?.tool_calls?.length) {
            yield { type: "delta", content: delta?.content ?? "", tool_calls: delta?.tool_calls, ...(reasoning ? { reasoning } : {}) };
          }
          if (choice?.finish_reason) yield { type: "finish", finish_reason: choice.finish_reason };
          const usage = normalizeUsage(chunk.usage);
          if (usage) yield { type: "usage", usage };
        }
      }
    } finally {
      reader.releaseLock();
    }
  }

  async #request(messages: Message[], tools: ToolDefinition[] | undefined, options: ChatOptions, stream: boolean): Promise<Response> {
    const timeoutMs = options.timeout_ms ?? this.#defaultTimeoutMs;
    const signal = timeoutSignal(options.signal, timeoutMs);
    try {
      return await this.#fetch(`${this.#baseUrl}/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${this.#apiKey}` },
        // Tool schemas go out Bedrock/Anthropic-safe: top-level oneOf/
        // allOf/anyOf combinators are flattened (Bedrock rejects the whole
        // request over one); the declared schemas and the runtime
        // validator keep the original semantics. See schema-normalize.ts.
        body: JSON.stringify({ model: this.#model, messages, ...(tools?.length ? { tools: normalizeToolSchemas(tools) } : {}), stream, stream_options: stream ? { include_usage: true } : undefined, temperature: options.temperature, max_tokens: options.max_tokens, top_p: options.top_p, stop: options.stop }),
        signal,
      });
    } catch (error) {
      if (signal.aborted) throw new LLMTimeoutError(`LLM request timed out after ${timeoutMs}ms`, { cause: error });
      throw new LLMError("LLM request failed", { cause: error, code: "network" });
    }
  }
}

/** The non-streaming JSON body → ChatResponse, shared by chat() and stream()'s JSON branch. */
function chatResponseFromJson(json: OpenAIResponse): ChatResponse {
  const choice = json.choices?.[0];
  if (!choice?.message) throw new LLMFormatError("provider response has no choice message");
  if (choice.finish_reason === "content_filter") throw new LLMContentPolicyError("provider refused the request (content_filter)");
  return {
    message: {
      role: toRole(choice.message.role),
      content: choice.message.content ?? "",
      tool_calls: choice.message.tool_calls,
      ...reasoningFields(choice.message),
    },
    usage: normalizeUsage(json.usage),
    finish_reason: choice.finish_reason ?? undefined,
    raw: json,
  };
}

function reasoningFields(message: { reasoning_content?: unknown; reasoning?: unknown; thinking?: unknown }): Pick<Message, "reasoning_content" | "reasoning" | "thinking"> {
  const fields: Pick<Message, "reasoning_content" | "reasoning" | "thinking"> = {};
  if (typeof message.reasoning_content === "string" && message.reasoning_content.trim()) fields.reasoning_content = message.reasoning_content;
  if (typeof message.reasoning === "string" && message.reasoning.trim()) fields.reasoning = message.reasoning;
  if (typeof message.thinking === "string" && message.thinking.trim()) fields.thinking = message.thinking;
  return fields;
}

function timeoutSignal(parent: AbortSignal | undefined, timeoutMs: number): AbortSignal {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  // The abort deadline must not by itself keep a short-lived CLI process
  // alive after the provider has already answered.
  timer.unref?.();
  parent?.addEventListener("abort", () => controller.abort(), { once: true });
  controller.signal.addEventListener("abort", () => clearTimeout(timer), { once: true });
  return controller.signal;
}

function toRole(role: string | undefined): Message["role"] {
  if (role === "system" || role === "user" || role === "assistant" || role === "tool") return role;
  throw new LLMFormatError(`unsupported message role: ${String(role)}`);
}

function normalizeUsage(usage: Partial<Usage> | undefined): Usage | undefined {
  if (usage?.prompt_tokens === undefined || usage.completion_tokens === undefined || usage.total_tokens === undefined) return undefined;
  return { prompt_tokens: usage.prompt_tokens, completion_tokens: usage.completion_tokens, total_tokens: usage.total_tokens };
}

function providerHttpError(status: number, body: OpenAIResponse, retryAfter: string | null): LLMError {
  const message = body.error?.message ?? `provider returned HTTP ${status}`;
  const marker = `${body.error?.code ?? ""} ${body.error?.type ?? ""} ${message}`.toLowerCase();
  if (marker.includes("content_policy") || marker.includes("content policy") || marker.includes("content_filter") || marker.includes("refusal")) {
    return new LLMContentPolicyError(message);
  }
  if (status === 401 || status === 403) return new LLMAuthError(message);
  if (status === 429) return new LLMRateLimitError(message, { retryAfterMs: retryAfter ? Number(retryAfter) * 1000 : undefined });
  // Router-wrapped upstream failures arrive as 4xx (often 400) yet mean the
  // request never reached a healthy model — transient, so a pool fails over
  // and the loop retries instead of hard-failing the turn. A genuinely
  // malformed local request has no upstream marker and stays non-transient.
  if (marker.includes("upstream request failed") || marker.includes("upstream error") || marker.includes("error from provider")) {
    return new LLMError(message, { code: "transient" });
  }
  return new LLMError(message, { code: status >= 500 ? "transient" : "provider" });
}
