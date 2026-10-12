import { LLMRateLimitError, type LLMError } from "./errors.ts";

export type RetryPolicy = {
  maxAttempts: number;
  baseDelayMs: number;
  maxDelayMs: number;
  signal?: AbortSignal;
  sleep?: (ms: number) => Promise<void>;
};

export const DEFAULT_RETRY_POLICY: Omit<RetryPolicy, "signal" | "sleep"> = {
  maxAttempts: 3,
  baseDelayMs: 250,
  maxDelayMs: 4_000,
};

/** Errors that are safe to retry: rate limits and transient 5xx. Auth/format are not. */
export function isRetryable(error: unknown): boolean {
  if (error instanceof LLMRateLimitError) return true;
  const code = (error as { code?: string } | null)?.code;
  return code === "transient" || code === "network";
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Bounded retry with exponential backoff + jitter; honours provider
 * `retryAfterMs` and aborts on `signal`.
 */
export async function withRetry<T>(operation: () => Promise<T>, policy: RetryPolicy): Promise<T> {
  const sleep = policy.sleep ?? defaultSleep;
  let lastError: unknown;
  for (let attempt = 1; attempt <= policy.maxAttempts; attempt++) {
    if (policy.signal?.aborted) throw lastError ?? new Error("aborted");
    try {
      return await operation();
    } catch (error) {
      lastError = error;
      if (!isRetryable(error) || attempt === policy.maxAttempts) throw error;
      const backoff = Math.min(policy.maxDelayMs, policy.baseDelayMs * 2 ** (attempt - 1));
      const retryAfter = (error as { retryAfterMs?: number }).retryAfterMs;
      const delay = Math.round((retryAfter !== undefined ? Math.max(retryAfter, backoff) : backoff) * (0.85 + Math.random() * 0.3));
      await sleep(delay);
    }
  }
  throw lastError ?? new Error("retry exhausted");
}

export type { LLMError };
