/**
 * Typed LLM errors. Every provider surfaces these so the caller can branch
 * on error *class* rather than parsing strings.
 */

export class LLMError extends Error {
  readonly _tag = "LLMError";
  constructor(message: string, options?: { cause?: unknown; code?: string }) {
    super(message);
    this.name = "LLMError";
    if (options?.cause) (this as { cause?: unknown }).cause = options.cause;
    if (options?.code) (this as { code?: string }).code = options.code;
  }
}

export class LLMTimeoutError extends LLMError {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, { cause: options?.cause, code: "timeout" });
    this.name = "LLMTimeoutError";
  }
}

export class LLMAuthError extends LLMError {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, { cause: options?.cause, code: "auth" });
    this.name = "LLMAuthError";
  }
}

export class LLMRateLimitError extends LLMError {
  constructor(message: string, options?: { cause?: unknown; retryAfterMs?: number }) {
    super(message, { cause: options?.cause, code: "rate_limit" });
    this.name = "LLMRateLimitError";
    if (options?.retryAfterMs !== undefined)
      (this as { retryAfterMs?: number }).retryAfterMs = options.retryAfterMs;
  }
}

export class LLMFormatError extends LLMError {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, { cause: options?.cause, code: "format" });
    this.name = "LLMFormatError";
  }
}

export class LLMContentPolicyError extends LLMError {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, { cause: options?.cause, code: "content_policy" });
    this.name = "LLMContentPolicyError";
  }
}

export type LLMErrorKind = "transient" | "fatal" | "other";

/**
 * Classify provider failures for agent-loop error accounting. Transient
 * failures (timeouts, rate limits, network errors, and provider 5xx errors)
 * may succeed on a later request or another model; auth and content-policy
 * failures will not be fixed by retrying the same request.
 */
export function classifyLLMError(error: unknown): LLMErrorKind {
  if (error instanceof LLMAuthError || error instanceof LLMContentPolicyError) return "fatal";
  if (error instanceof LLMTimeoutError || error instanceof LLMRateLimitError) return "transient";

  const code = (error as { code?: unknown } | null)?.code;
  const codeText = typeof code === "string" ? code.toLowerCase() : "";
  if (codeText === "auth" || codeText === "content_policy") return "fatal";
  if (["transient", "network", "rate_limit", "timeout"].includes(codeText)) return "transient";

  const summary = (error instanceof Error ? `${error.name}: ${error.message}` : String(error)).toLowerCase();
  if (summary.includes("content_policy") || summary.includes("content policy") || summary.includes("content_filter") || summary.includes("authentication failed") || summary.includes("invalid api key")) return "fatal";
  if (
    summary.includes("rate limit") ||
    summary.includes("too many requests") ||
    summary.includes("timed out") ||
    summary.includes("timeout") ||
    summary.includes("fetch failed") ||
    summary.includes("network") ||
    /http 5\d\d/.test(summary) ||
    summary.includes("temporarily unavailable") ||
    summary.includes("overloaded") ||
    // Router/provider-wrapped upstream failures (e.g. 9Router answering a
    // 400 with "Error from provider (Console): Upstream request failed…"):
    // the request never really reached a model, so another model may work.
    // A plain malformed-request 400 carries none of these markers and stays
    // non-transient.
    summary.includes("upstream request failed") ||
    summary.includes("upstream error") ||
    summary.includes("error from provider")
  ) return "transient";
  return "other";
}

export function isTransientLLMError(error: unknown): boolean {
  return classifyLLMError(error) === "transient";
}

export function isFatalLLMError(error: unknown): boolean {
  return classifyLLMError(error) === "fatal";
}

export function classifyProviderError(status: number, body: unknown): LLMError {
  if (status === 401 || status === 403) return new LLMAuthError("provider auth failed");
  if (status === 429) {
    const retryAfterMs = retryAfterMsFromResponse(body);
    return new LLMRateLimitError("provider rate limited", { retryAfterMs });
  }
  if (status >= 500) return new LLMError("provider transient error", { code: "transient" });
  if (hasUpstreamFailureMarker(body)) return new LLMError("provider upstream request failed", { code: "transient" });
  return new LLMError(`provider error: ${status}`, { code: "unknown" });
}

/**
 * A 400 whose body says the *upstream* provider failed (router-wrapped
 * errors such as "Error from provider (Console): Upstream request failed")
 * is a transient routing failure, not a malformed local request.
 */
export function hasUpstreamFailureMarker(body: unknown): boolean {
  let text: string;
  try {
    text = typeof body === "string" ? body : JSON.stringify(body) ?? "";
  } catch {
    return false;
  }
  const lower = text.toLowerCase();
  return lower.includes("upstream request failed") || lower.includes("upstream error") || lower.includes("error from provider");
}

function retryAfterMsFromResponse(body: unknown): number | undefined {
  if (body && typeof body === "object") {
    const obj = body as Record<string, unknown>;
    const seconds = obj.retry_after;
    if (typeof seconds === "number") return Math.max(0, seconds * 1000);
    const header = obj["Retry-After"];
    if (typeof header === "number") return Math.max(0, header * 1000);
  }
  return undefined;
}