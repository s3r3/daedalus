import type { ModelTier } from "../../contracts.ts";
import { LLMContentPolicyError, LLMFormatError, LLMRateLimitError, LLMTimeoutError, isToolSchemaInvalidError } from "./errors.ts";
import type { ChatOptions, ChatResponse, LLMProvider, Message, ModelPhase, StreamChunk, ToolDefinition } from "./types.ts";

export type ModelStrategy = "failover" | "round-robin";
export type { ModelTier };

export type ModelPoolSwitch = {
  from?: string;
  to: string;
  reason: string;
  error: string;
  attempt: number;
  strategy: ModelStrategy;
};

export const DEFAULT_MODEL_COOLDOWN_MS = 60_000;

export type ModelPoolOptions = {
  name?: string;
  models: string[];
  strategy?: ModelStrategy;
  createProvider: (model: string) => LLMProvider;
  onSwitch?: (event: ModelPoolSwitch) => void | Promise<void>;
  /** How long a model is skipped after a retryable failure. Set 0 to disable. */
  cooldownMs?: number;
  /** Clock override for tests. */
  now?: () => number;
  /**
   * Capability tier per model (tailor suite). When at least two distinct
   * tiers are assigned and `routing` is not false, the per-call phase hint
   * (`ChatOptions.phase`) reorders attempts: editing/repair turns try
   * `strong` models first, exploration tries `balanced` (then `fast`), and
   * Q&A tries `fast` (then `balanced`). Unset models count as balanced.
   */
  tiers?: Record<string, ModelTier>;
  /** Tier routing on/off; default on when tiers are configured (DAEDALUS_MODEL_ROUTING=off turns it off). */
  routing?: boolean;
};

/**
 * The control surface the agent loop / runtime use on a pool (tailor suite):
 * which model is strongest, which one served last, and pinning the rest of a
 * task to one model (quality escalation). Single providers do not implement
 * it, and every caller must treat its absence as "feature unavailable".
 */
export interface ModelController {
  readonly poolModels: string[];
  /** Model that served the most recent request (or the pool's active model). */
  currentModel(): string | undefined;
  /** The pool's strongest model per the tier config (first model when unset). */
  strongestModel(): string | undefined;
  /** Pin subsequent requests to `model`; false when it is not in the pool. */
  pinModel(model: string): boolean;
}

/** Structural check for the ModelController surface (duck-typed, fail-open). */
export function asModelController(provider: unknown): ModelController | undefined {
  const candidate = provider as Partial<ModelController> | null | undefined;
  if (!candidate || typeof candidate !== "object") return undefined;
  if (!Array.isArray(candidate.poolModels)) return undefined;
  if (typeof candidate.currentModel !== "function" || typeof candidate.strongestModel !== "function" || typeof candidate.pinModel !== "function") return undefined;
  return candidate as ModelController;
}

const MODEL_TIERS: readonly ModelTier[] = ["strong", "balanced", "fast"];

/** Parse `LLM_MODEL_TIERS` (`model-a:strong,model-b:fast`); invalid entries fail fast. */
export function parseModelTiers(value: string | undefined, source = "LLM_MODEL_TIERS"): Record<string, ModelTier> {
  const tiers: Record<string, ModelTier> = {};
  if (value === undefined || value.trim() === "") return tiers;
  for (const entry of value.split(",")) {
    const trimmed = entry.trim();
    if (!trimmed) continue;
    const separator = trimmed.lastIndexOf(":");
    const model = separator > 0 ? trimmed.slice(0, separator).trim() : "";
    const tier = separator > 0 ? trimmed.slice(separator + 1).trim().toLowerCase() : "";
    if (!model || !(MODEL_TIERS as readonly string[]).includes(tier)) {
      throw new Error(`Invalid ${source} entry: ${trimmed} (expected model:strong|balanced|fast)`);
    }
    tiers[model] = tier as ModelTier;
  }
  return tiers;
}

/** Lenient variant for stored provider configs: garbage entries are dropped. */
export function normalizeModelTiers(value: unknown): Record<string, ModelTier> | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const tiers: Record<string, ModelTier> = {};
  for (const [model, tier] of Object.entries(value as Record<string, unknown>)) {
    const name = model.trim();
    if (!name || typeof tier !== "string") continue;
    const normalized = tier.trim().toLowerCase();
    if ((MODEL_TIERS as readonly string[]).includes(normalized)) tiers[name] = normalized as ModelTier;
  }
  return Object.keys(tiers).length > 0 ? tiers : undefined;
}

/**
 * The pool's strongest model: the first `strong`-tier model in config order,
 * falling back to the first configured model (the failover primary) when no
 * tiers are assigned.
 */
export function strongestModelFor(models: readonly string[], tiers?: Record<string, ModelTier>): string | undefined {
  for (const model of models) if (tiers?.[model] === "strong") return model;
  return models[0];
}

/** Attempt-order rank of a tier for a phase (lower = tried earlier). Unset tiers count as balanced. */
export function tierRankForPhase(phase: ModelPhase, tier: ModelTier | undefined): number {
  const effective = tier ?? "balanced";
  switch (phase) {
    case "edit":
    case "repair":
      return effective === "strong" ? 0 : effective === "balanced" ? 1 : 2;
    case "question":
      return effective === "fast" ? 0 : effective === "balanced" ? 1 : 2;
    case "explore":
    default:
      return effective === "balanced" ? 0 : effective === "fast" ? 1 : 2;
  }
}

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
export class ModelPoolProvider implements LLMProvider, ModelController {
  readonly name: string;
  readonly #models: string[];
  readonly #strategy: ModelStrategy;
  readonly #createProvider: (model: string) => LLMProvider;
  readonly #onSwitch?: ModelPoolOptions["onSwitch"];
  readonly #providers = new Map<string, LLMProvider>();
  readonly #cooldownUntil = new Map<string, number>();
  readonly #cooldownMs: number;
  readonly #now: () => number;
  readonly #tiers: Record<string, ModelTier>;
  readonly #routing: boolean;
  #pinnedModel: string | undefined;
  #activeIndex = 0;
  #roundRobinCursor = 0;
  #lastAttemptedModels: string[] = [];

  constructor(options: ModelPoolOptions) {
    this.#models = normalizeModelList(options.models);
    if (this.#models.length === 0) throw new Error("ModelPoolProvider requires at least one model");
    this.#strategy = options.strategy ?? "failover";
    this.#createProvider = options.createProvider;
    this.#onSwitch = options.onSwitch;
    this.#cooldownMs = options.cooldownMs ?? DEFAULT_MODEL_COOLDOWN_MS;
    this.#now = options.now ?? Date.now;
    this.#tiers = options.tiers ?? {};
    this.#routing = options.routing !== false;
    this.name = options.name ?? "model-pool";
  }

  get models(): string[] {
    return [...this.#models];
  }

  get poolModels(): string[] {
    return [...this.#models];
  }

  get tiers(): Record<string, ModelTier> {
    return { ...this.#tiers };
  }

  /** Tier routing actually in effect (needs 2+ models with 2+ distinct tiers). */
  get routingActive(): boolean {
    if (!this.#routing || this.#models.length < 2) return false;
    const assigned = new Set(this.#models.map((model) => this.#tiers[model] ?? "balanced"));
    return assigned.size >= 2;
  }

  currentModel(): string | undefined {
    return this.lastAttemptedModel ?? this.activeModel;
  }

  strongestModel(): string | undefined {
    return strongestModelFor(this.#models, this.#tiers);
  }

  /** Pin the rest of the task to one model (quality escalation). A pin beats phase routing and never flaps back. */
  pinModel(model: string): boolean {
    if (!this.#models.includes(model)) return false;
    this.#pinnedModel = model;
    return true;
  }

  get pinnedModel(): string | undefined {
    return this.#pinnedModel;
  }

  get strategy(): ModelStrategy {
    return this.#strategy;
  }

  get activeModel(): string {
    return this.#models[this.#activeIndex] ?? this.#models[0]!;
  }

  get cooldownMs(): number {
    return this.#cooldownMs;
  }

  /** Models actually attempted by the most recent chat/stream call, in order. */
  get lastAttemptedModels(): string[] {
    return [...this.#lastAttemptedModels];
  }

  get lastAttemptedModel(): string | undefined {
    return this.#lastAttemptedModels[this.#lastAttemptedModels.length - 1];
  }

  async chat(messages: Message[], tools?: ToolDefinition[], options: ChatOptions = {}): Promise<ChatResponse> {
    const order = this.#attemptOrder(options.phase);
    this.#lastAttemptedModels = [];
    let lastError: unknown;
    for (let attempt = 0; attempt < order.length; attempt++) {
      const model = order[attempt]!;
      this.#lastAttemptedModels.push(model);
      const provider = this.#providerFor(model);
      try {
        const response = await provider.chat(messages, tools, options);
        assertUsableResponse(response);
        this.#cooldownUntil.delete(model);
        this.#activeIndex = this.#models.indexOf(model);
        return response;
      } catch (error) {
        lastError = error;
        if (!isModelPoolRetryableError(error)) throw error;
        this.#startCooldown(model);
        const next = order[attempt + 1];
        if (next) await this.#emitSwitch(model, next, error, attempt + 1);
      }
    }
    throw lastError ?? new LLMFormatError("model pool returned no response");
  }

  async *stream(messages: Message[], tools?: ToolDefinition[], options: ChatOptions = {}): AsyncIterable<StreamChunk> {
    const order = this.#attemptOrder(options.phase);
    this.#lastAttemptedModels = [];
    let lastError: unknown;
    for (let attempt = 0; attempt < order.length; attempt++) {
      const model = order[attempt]!;
      this.#lastAttemptedModels.push(model);
      const provider = this.#providerFor(model);
      let yielded = false;
      try {
        for await (const chunk of provider.stream(messages, tools, options)) {
          yielded = true;
          yield chunk;
        }
        this.#cooldownUntil.delete(model);
        this.#activeIndex = this.#models.indexOf(model);
        return;
      } catch (error) {
        lastError = error;
        // Once bytes have been yielded, restarting on another model could
        // duplicate output/tool fragments. Only pre-output failures fail over.
        if (yielded || !isModelPoolRetryableError(error)) throw error;
        this.#startCooldown(model);
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

  #attemptOrder(phase?: ModelPhase): string[] {
    let base: string[];
    if (this.#models.length === 1) base = [...this.#models];
    else if (this.#strategy === "round-robin") {
      const start = this.#roundRobinCursor % this.#models.length;
      this.#roundRobinCursor = (start + 1) % this.#models.length;
      base = rotate(this.#models, start);
    } else base = rotate(this.#models, this.#activeIndex);

    let order: string[];
    if (this.#cooldownMs <= 0) order = base;
    else {
      const now = this.#now();
      const available = base.filter((model) => (this.#cooldownUntil.get(model) ?? 0) <= now);
      if (available.length > 0) order = available;
      else {
        // Every model is cooling down. A single earliest-expiring probe is a
        // better failure than fabricating a local "all models down" error or
        // hammering the whole pool again in the same request.
        const earliest = [...base].sort((a, b) => (this.#cooldownUntil.get(a) ?? 0) - (this.#cooldownUntil.get(b) ?? 0))[0];
        order = earliest ? [earliest] : base;
      }
    }

    // Tailor-suite ordering, applied on top of cooldown filtering: a pinned
    // model (quality escalation) always leads; otherwise the phase hint
    // stable-sorts by tier rank so intra-tier config order is preserved.
    if (this.#pinnedModel && order.includes(this.#pinnedModel)) {
      return [this.#pinnedModel, ...order.filter((model) => model !== this.#pinnedModel)];
    }
    if (this.#pinnedModel) return [this.#pinnedModel, ...order];
    if (phase && this.routingActive) {
      return order
        .map((model, index) => ({ model, index, rank: tierRankForPhase(phase, this.#tiers[model]) }))
        .sort((a, b) => a.rank - b.rank || a.index - b.index)
        .map((entry) => entry.model);
    }
    return order;
  }

  #startCooldown(model: string): void {
    if (this.#cooldownMs <= 0) return;
    this.#cooldownUntil.set(model, this.#now() + this.#cooldownMs);
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
  // A tool schema the provider rejects fails identically on every model
  // behind the same contract — no failover can fix it.
  if (isToolSchemaInvalidError(error)) return false;
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
    // Router-wrapped upstream failures (HTTP 400 from a router whose own
    // upstream call failed): another model may well answer the same request.
    "upstream request failed",
    "upstream error",
    "error from provider",
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
  if (isToolSchemaInvalidError(error)) return "tool_schema_invalid";
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
