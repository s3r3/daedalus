import { LLMAuthError, LLMContentPolicyError, LLMError, LLMFormatError, LLMRateLimitError, LLMTimeoutError } from "./errors.ts";
import { detectPromptCacheMechanism, stablePrefixCacheKey, type PromptCacheMechanism } from "./prompt-cache.ts";
import { normalizeToolSchemas } from "./schema-normalize.ts";
import type { ChatOptions, ChatResponse, LLMProvider, Message, StreamChunk, ToolDefinition, ToolCall, Usage } from "./types.ts";

export const DEFAULT_LLM_TIMEOUT_MS = 180_000;

export type OpenAICompatOptions = {
  baseUrl: string;
  apiKey: string;
  model: string;
  fetch?: typeof fetch;
  defaultTimeoutMs?: number;
  /**
   * Prompt-cache mechanism this endpoint's dialect positively supports.
   * Default "none": no cache parameter is ever emitted. Set to
   * "prompt_cache_key" only for OpenAI(-compatible) upstreams/relays known
   * to honour it (9Router forwards it to upstreams declaring support).
   */
  promptCache?: PromptCacheMechanism;
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
  readonly #promptCache: PromptCacheMechanism;

  constructor(options: OpenAICompatOptions) {
    this.#baseUrl = options.baseUrl.replace(/\/$/, "");
    this.#apiKey = options.apiKey;
    this.#model = options.model;
    this.#fetch = options.fetch ?? fetch;
    this.#defaultTimeoutMs = options.defaultTimeoutMs ?? DEFAULT_LLM_TIMEOUT_MS;
    this.#promptCache = options.promptCache ?? "none";
  }

  get model(): string {
    return this.#model;
  }

  get defaultTimeoutMs(): number {
    return this.#defaultTimeoutMs;
  }

  /** Declared prompt-cache capability, read by detectPromptCacheMechanism(). */
  get promptCacheMechanism(): PromptCacheMechanism {
    return this.#promptCache;
  }

  async chat(messages: Message[], tools?: ToolDefinition[], options: ChatOptions = {}): Promise<ChatResponse> {
    const response = await this.#requestWithReasoningEffortFallback(messages, tools, options, false);
    if (!response.ok) {
      const json = (await response.json().catch(() => ({}))) as OpenAIResponse;
      throw providerHttpError(response.status, json, response.headers.get("retry-after"));
    }
    const json = (await response.json().catch(() => {
      throw new LLMFormatError("provider response is not valid JSON");
    })) as OpenAIResponse;
    // BUG-1 fix: some gateways (incl. 9Router) return HTTP 200 with {error} body
    // on upstream failure. Surface the real error instead of a confusing
    // "provider response has no choice message".
    if (json.error) {
      const msg = typeof json.error === 'string' ? json.error : json.error.message ?? JSON.stringify(json.error);
      throw new LLMError(`provider error: ${msg}`, { code: typeof json.error === 'object' ? json.error.code : undefined });
    }
    return chatResponseFromJson(json);
  }

  async *stream(messages: Message[], tools?: ToolDefinition[], options: ChatOptions = {}): AsyncIterable<StreamChunk> {
    const response = await this.#requestWithReasoningEffortFallback(messages, tools, options, true);
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
      const wholeReasoning = whole.message.reasoning_content ?? whole.message.reasoning ?? whole.message.thinking;
      // BUG-2 fix: include reasoning in the guard — a reasoning-only response
      // (no content/tool_calls) is still a valid response, not an empty one.
      if (wholeText || whole.message.tool_calls?.length || wholeReasoning) {
        yield {
          type: "delta",
          content: wholeText,
          tool_calls: whole.message.tool_calls,
          reasoning: wholeReasoning,
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
    // Some reasoning models (e.g. reflection/beam-free) require `reasoning_content`
    // on EVERY assistant message in the history. Only inject the field when the
    // model has actually returned reasoning before (i.e. at least one message
    // already has it) — otherwise we'd add a non-standard field to models that
    // don't expect it and break strict schema validators. (BUG-5 fix)
    const needsReasoning = messages.some((m) => m.role === 'assistant' && m.reasoning_content !== undefined);
    const messagesWithReasoning = needsReasoning
      ? messages.map((m) =>
          m.role === 'assistant' && (m.reasoning_content === undefined || m.reasoning_content === null)
            ? { ...m, reasoning_content: '' }
            : m
        )
      : messages;
    // Prompt caching: the stable prefix (system prompt + tool schemas) is
    // marked cacheable ONLY when the caller asked for it (options.cachePrefix)
    // AND this adapter positively supports a mechanism (this.#promptCache,
    // default "none"). Both keys must turn: an unsupported dialect never
    // sees a cache parameter.
    const promptCacheKey = cacheKeyForRequest(this, messages, tools, options);
    try {
      return await this.#fetch(`${this.#baseUrl}/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${this.#apiKey}` },
        // Tool schemas go out Bedrock/Anthropic-safe: top-level oneOf/
        // allOf/anyOf combinators are flattened (Bedrock rejects the whole
        // request over one); the declared schemas and the runtime
        // validator keep the original semantics. See schema-normalize.ts.
        body: JSON.stringify({ model: this.#model, messages: messagesWithReasoning, ...(tools?.length ? { tools: normalizeToolSchemas(tools) } : {}), ...(promptCacheKey ? { prompt_cache_key: promptCacheKey } : {}), stream, stream_options: stream ? { include_usage: true } : undefined, temperature: options.temperature, max_tokens: options.max_tokens, top_p: options.top_p, stop: options.stop, reasoning_effort: options.reasoningEffort }),
        signal,
      });
    } catch (error) {
      // Bedakan timeout vs user-cancel: jika parent signal aborted, itu user yang cancel,
      // bukan timeout. Cek parent dulu sebelum lempar LLMTimeoutError.
      if (signal.aborted) {
        if (options.signal?.aborted) {
          throw new LLMError("Permintaan dibatalkan pengguna", { cause: error, code: "cancelled" });
        }
        throw new LLMTimeoutError(`LLM request timed out after ${timeoutMs}ms`, { cause: error });
      }
      throw new LLMError("LLM request failed", { cause: error, code: "network" });
    }
  }

  /**
   * Defensive fallback for endpoints that reject `reasoning_effort`:
   * on a 400 whose error body names the parameter (or calls it an
   * unknown/unrecognized parameter), retry ONCE without it. Any other
   * failure — or a second failure — returns the response untouched so
   * the normal error path reports it.
   */
  async #requestWithReasoningEffortFallback(
    messages: Message[],
    tools: ToolDefinition[] | undefined,
    options: ChatOptions,
    stream: boolean,
  ): Promise<Response> {
    const response = await this.#request(messages, tools, options, stream);
    if (response.ok || response.status !== 400 || options.reasoningEffort === undefined) return response;
    const probe = (await response.json().catch(() => ({}))) as OpenAIResponse;
    if (!reasoningEffortRejected(probe)) {
      // Not a reasoning_effort complaint: the body is consumed, so
      // rebuild the rejection from the parsed error instead of losing it.
      throw providerHttpError(response.status, probe, response.headers.get("retry-after"));
    }
    return this.#request(messages, tools, { ...options, reasoningEffort: undefined }, stream);
  }
}

/** True when an error body blames the reasoning_effort parameter. */
function reasoningEffortRejected(body: OpenAIResponse): boolean {
  const marker = `${body.error?.code ?? ""} ${body.error?.type ?? ""} ${body.error?.message ?? ""}`.toLowerCase();
  // Harus sebut reasoning_effort secara spesifik. Jangan retry untuk "unknown parameter"
  // yang menyebut parameter lain (mis. "unknown parameter: foo" bukan reasoning_effort).
  if (marker.includes("reasoning_effort")) return true;
  // Generic "unknown/unrecognized parameter" tanpa nama parameter spesifik:
  // asumsikan reasoning_effort (konteks pemanggil selalu set reasoningEffort).
  // Tapi jika menyebut parameter lain secara eksplisit, jangan retry.
  const generic = marker.includes("unknown parameter") || marker.includes("unrecognized");
  if (!generic) return false;
  // Ekstrak nama parameter dari pesan, mis. "unknown parameter: 'foo'"
  const paramMatch = marker.match(/(?:unknown parameter|unrecognized)[\s:]+['"]?([a-z_]+)['"]?/);
  if (paramMatch && paramMatch[1] !== "reasoning_effort") return false;
  return true;
}

/**
 * The prompt-cache key for this request, or undefined when the gate is
 * closed: caller didn't mark the prefix (`cachePrefix`), or the provider's
 * detected mechanism can't express it on this dialect.
 */
function cacheKeyForRequest(
  provider: OpenAICompatProvider,
  messages: Message[],
  tools: ToolDefinition[] | undefined,
  options: ChatOptions,
): string | undefined {
  if (options.cachePrefix !== true) return undefined;
  if (detectPromptCacheMechanism(provider) !== "prompt_cache_key") return undefined;
  return stablePrefixCacheKey(provider.model, messages, tools);
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
  if (parent?.aborted) {
    // The caller already cancelled before the request was built (a Stop
    // press landing between the task's model-call setup and the fetch):
    // abort immediately instead of issuing a request nobody wants. An
    // addEventListener on an already-aborted signal never fires, so this
    // check cannot be folded into the listener below.
    controller.abort();
    return controller.signal;
  }
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
  // BUG-6 fix: don't discard usage when only total_tokens is missing —
  // compute it from prompt + completion. Only discard when we have nothing.
  if (usage?.prompt_tokens === undefined && usage?.completion_tokens === undefined) return undefined;
  const prompt_tokens = usage.prompt_tokens ?? 0;
  const completion_tokens = usage.completion_tokens ?? 0;
  return {
    prompt_tokens,
    completion_tokens,
    total_tokens: usage.total_tokens ?? (prompt_tokens + completion_tokens),
  };
}

function parseRetryAfterMs(retryAfter: string | null): number | undefined {
  // BUG-3 fix: Retry-After can be seconds OR an HTTP date. Handle both;
  // return undefined (not NaN) when unparseable so callers fall back to backoff.
  if (!retryAfter) return undefined;
  const seconds = Number(retryAfter);
  if (!Number.isNaN(seconds)) return seconds * 1000;
  const dateMs = Date.parse(retryAfter);
  if (!Number.isNaN(dateMs)) return Math.max(0, dateMs - Date.now());
  return undefined;
}

function providerHttpError(status: number, body: OpenAIResponse, retryAfter: string | null): LLMError {
  const message = body.error?.message ?? `provider returned HTTP ${status}`;
  const marker = `${body.error?.code ?? ""} ${body.error?.type ?? ""} ${message}`.toLowerCase();
  if (marker.includes("content_policy") || marker.includes("content policy") || marker.includes("content_filter") || marker.includes("refusal")) {
    return new LLMContentPolicyError(message);
  }
  if (status === 401 || status === 403) return new LLMAuthError(message);
  if (status === 429) return new LLMRateLimitError(message, { retryAfterMs: parseRetryAfterMs(retryAfter) });
  // Router-wrapped upstream failures arrive as 4xx (often 400) yet mean the
  // request never reached a healthy model — transient, so a pool fails over
  // and the loop retries instead of hard-failing the turn. A genuinely
  // malformed local request has no upstream marker and stays non-transient.
  if (marker.includes("upstream request failed") || marker.includes("upstream error") || marker.includes("error from provider")) {
    return new LLMError(message, { code: "transient" });
  }
  return new LLMError(message, { code: status >= 500 ? "transient" : "provider" });
}
