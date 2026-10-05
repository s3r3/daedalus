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

export function classifyProviderError(status: number, body: unknown): LLMError {
  if (status === 401 || status === 403) return new LLMAuthError("provider auth failed");
  if (status === 429) {
    const retryAfterMs = retryAfterMsFromResponse(body);
    return new LLMRateLimitError("provider rate limited", { retryAfterMs });
  }
  if (status >= 500) return new LLMError("provider transient error", { code: "transient" });
  return new LLMError(`provider error: ${status}`, { code: "unknown" });
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