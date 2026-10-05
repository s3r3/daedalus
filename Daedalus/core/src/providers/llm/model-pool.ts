import { LLMContentPolicyError, LLMFormatError, LLMRateLimitError, LLMTimeoutError } from "./errors.ts";
import type { ChatOptions, ChatResponse, LLMProvider, Message, StreamChunk, ToolDefinition } from "./types.ts";

export type ModelStrategy = "failover" | "round-robin";

export type ModelPoolSwitch = {
  from?: string;
  to: string;
  reason: string;
  error: string;
  attempt: number;
  strategy: ModelStrategy;
};

export type ModelPoolOptions = {
  name?: string;
  models: string[];
  strategy?: ModelStrategy;
  createProvider: (model: string) => LLMProvider;
  onSwitch?: (event: ModelPoolSwitch) => void | Promise<void>;
};

export function parseModelStrategy(value: string | undefined, source = "LLM_MODEL_STRATEGY"): ModelStrategy {
  if (value === undefined || value.trim() === "") return "failover";
  const normalized = value.trim().toLowerCase();
  if (normalized === "failover" || normalized === "round-robin") return normalized;
  throw new Error(`Invalid ${source}: ${value} (expected failover or round-robin)`);
}

export function normalizeModelList(models: readonly string[] | string | undefined): string[] {
  const raw = typeof models === "string" ? models.split(",") : models ?? [];
  return [...new Set(raw.map((model) => model.trim()).filter(Boolean))];
}

/**
 * Task-preserving model pool for OpenAI-compatible endpoints exposed through
 * routers such as 9Router. A retryable failure on one model continues the
 * *same* Daedalus request/task with the next configured model instead of
 * ending the agent turn. Content-policy refusals are never swallowed: routing
 * around a refusal would change the safety outcome, so they bubble up.
 */
export class ModelPoolProvider implements LLMProvider {
  readonly name: string;
  readonly #models: string[];
  readonly #strategy: ModelStrategy;
  readonly #createProvider: (model: string) => LLMProvider;
  readonly #onSwitch?: ModelPoolOptions["onSwitch"];
  readonly #providers = new Map<string, LLMProvider>();
  #activeIndex = 0;
  #roundRobinCursor = 0;

  constructor(options: ModelPoolOptions) {
    this.#models = normalizeModelList(options.models);
    if (this.#models.length === 0) throw new Error("ModelPoolProvider requires at least one model");
    this.#strategy = options.strategy ?? "failover";
    this.#createProvider = options.createProvider;
    this.#onSwitch = options.onSwitch;
    this.name = options.name ?? "model-pool";
  }

  get models(): string[] {
    return [...this.#models];
  }

  get strategy(): ModelStrategy {
    return this.#strategy;
  }

  get activeModel(): string {
    return this.#models[this.#activeIndex] ?? this.#models[0]!;
  }

  async chat(messages: Message[], tools?: ToolDefinition[], options: ChatOptions = {}): Promise<ChatResponse> {
    const order = this.#attemptOrder();
    let lastError: unknown;
    for (let attempt = 0; attempt < order.length; attempt++) {
      const model = order[attempt]!;
      const provider = this.#providerFor(model);
      try {
        const response = await provider.chat(messages, tools, options);
        assertUsableResponse(response);
        this.#activeIndex = this.#models.indexOf(model);
        return response;
      } catch (error) {
        lastError = error;
        if (!isModelPoolRetryableError(error)) throw error;
        const next = order[attempt + 1];
        if (next) await this.#emitSwitch(model, next, error, attempt + 1);
      }
    }
    throw lastError ?? new LLMFormatError("model pool returned no response");
  }

  async *stream(messages: Message[], tools?: ToolDefinition[], options: ChatOptions = {}): AsyncIterable<StreamChunk> {
    const order = this.#attemptOrder();
    let lastError: unknown;
    for (let attempt = 0; attempt < order.length; attempt++) {
      const model = order[attempt]!;
      const provider = this.#providerFor(model);
      let yielded = false;
      try {
        for await (const chunk of provider.stream(messages, tools, options)) {
          yielded = true;
          yield chunk;
        }
        this.#activeIndex = this.#models.indexOf(model);
        return;
      } catch (error) {
        lastError = error;
        // Once bytes have been yielded, restarting on another model could
        // duplicate output/tool fragments. Only pre-output failures fail over.
        if (yielded || !isModelPoolRetryableError(error)) throw error;
        const next = order[attempt + 1];
        if (next) await this.#emitSwitch(model, next, error, attempt + 1);
      }
    }
    throw lastError ?? new LLMFormatError("model pool returned no response");
  }

  #providerFor(model: string): LLMProvider {
    let provider = this.#providers.get(model);
    if (!provider) {
      provider = this.#createProvider(model);
      this.#providers.set(model, provider);
    }
    return provider;
  }

  #attemptOrder(): string[] {
    if (this.#models.length === 1) return [...this.#models];
    if (this.#strategy === "round-robin") {
      const start = this.#roundRobinCursor % this.#models.length;
      this.#roundRobinCursor = (start + 1) % this.#models.length;
      return rotate(this.#models, start);
    }
    return rotate(this.#models, this.#activeIndex);
  }

  async #emitSwitch(from: string, to: string, error: unknown, attempt: number): Promise<void> {
    if (!this.#onSwitch) return;
    await this.#onSwitch({
      from,
      to,
      reason: modelPoolFailureReason(error),
      error: safeErrorSummary(error),
      attempt,
      strategy: this.#strategy,
    });
  }
}

export function isModelPoolRetryableError(error: unknown): boolean {
  if (error instanceof LLMContentPolicyError) return false;
  const summary = safeErrorSummary(error).toLowerCase();
  if (summary.includes("content_policy") || summary.includes("content policy") || summary.includes("content_filter")) return false;
  if (error instanceof LLMRateLimitError || error instanceof LLMTimeoutError || error instanceof LLMFormatError) return true;

  const code = (error as { code?: unknown } | null)?.code;
  const codeText = typeof code === "string" ? code.toLowerCase() : "";
  if (["transient", "network", "rate_limit", "timeout", "format", "quota", "context_limit", "model_not_found", "empty_response"].includes(codeText)) return true;

  return [
    "rate limit",
    "too many requests",
    "429",
    "timeout",
    "timed out",
    "quota",
    "insufficient",
    "token limit",
    "context length",
    "context_length",
    "maximum context",
    "model not found",
    "model_not_found",
    "model unavailable",
    "no available model",
    "no choice",
    "empty response",
    "overloaded",
    "capacity",
    "temporarily unavailable",
    "fetch failed",
    "network",
    "econn",
    "socket",
    "http 500",
    "http 502",
    "http 503",
    "http 504",
    "provider returned http 500",
    "provider returned http 502",
    "provider returned http 503",
    "provider returned http 504",
  ].some((marker) => summary.includes(marker));
}

export function modelPoolFailureReason(error: unknown): string {
  if (error instanceof LLMTimeoutError) return "timeout";
  if (error instanceof LLMRateLimitError) return "rate_limit";
  if (error instanceof LLMFormatError) return "format_or_empty";
  const summary = safeErrorSummary(error).toLowerCase();
  if (summary.includes("quota") || summary.includes("insufficient")) return "quota";
  if (summary.includes("context") || summary.includes("token limit") || summary.includes("maximum context")) return "context_or_token_limit";
  if (summary.includes("model not found") || summary.includes("model_not_found") || summary.includes("model unavailable")) return "model_not_found";
  if (summary.includes("rate limit") || summary.includes("too many requests") || summary.includes("429")) return "rate_limit";
  if (summary.includes("timeout") || summary.includes("timed out")) return "timeout";
  if (summary.includes("empty") || summary.includes("no choice")) return "format_or_empty";
  if (summary.includes("fetch") || summary.includes("network") || summary.includes("econn") || summary.includes("socket")) return "network";
  return "transient_provider_error";
}

function assertUsableResponse(response: ChatResponse): void {
  const content = typeof response.message?.content === "string" ? response.message.content.trim() : "";
  const toolCalls = response.message?.tool_calls ?? [];
  if (!response.message || (content.length === 0 && toolCalls.length === 0)) {
    throw new LLMFormatError("provider returned an empty response with no tool calls");
  }
  if (response.finish_reason === "content_filter") {
    throw new LLMContentPolicyError("provider refused the request (content_filter)");
  }
}

function rotate(models: string[], start: number): string[] {
  return models.map((_, index) => models[(start + index) % models.length]!);
}

function safeErrorSummary(error: unknown): string {
  const text = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  // Provider errors should not carry credentials, but keep switch events
  // defensive: never propagate an Authorization-looking fragment.
  return text.replace(/authorization\s*:\s*bearer\s+\S+/gi, "authorization: Bearer «redacted»").slice(0, 300);
}
