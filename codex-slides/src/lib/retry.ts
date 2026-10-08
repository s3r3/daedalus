// Small, dependency-free retry utilities shared by the generation pipeline.
// Kept standalone so the self-healing logic can be unit-tested without pulling
// in the network/store layers.

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** True when an error is an abort (user cancel / signal) rather than a real failure. */
export function isAbortError(e: any, signal?: AbortSignal): boolean {
  return (
    Boolean(signal?.aborted) ||
    e?.name === "AbortError" ||
    /\baborted\b/i.test(String(e?.message ?? e))
  );
}

export interface RetryOptions {
  /** Total tries (1 initial + retries). */
  attempts: number;
  signal?: AbortSignal;
  /** Fires before each re-attempt with the try that just failed (1-based). */
  onRetry?: (attempt: number, error: unknown) => void;
  /** Backoff before the next try, in ms. Defaults to capped exponential. */
  backoffMs?: (attempt: number) => number;
}

const defaultBackoff = (attempt: number) => Math.min(15_000, 2 ** attempt * 750);

/**
 * Run `op` up to `attempts` times, backing off between tries. Aborts are never
 * retried — they propagate immediately so a cancel stays instant. `onRetry`
 * fires before each re-attempt so the caller can surface "retrying" to the UI.
 */
export async function withRetry<T>(op: () => Promise<T>, opts: RetryOptions): Promise<T> {
  const { attempts, signal, onRetry, backoffMs = defaultBackoff } = opts;
  let lastErr: unknown;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    if (signal?.aborted) throw new Error("aborted");
    try {
      return await op();
    } catch (e) {
      if (isAbortError(e, signal)) throw e;
      lastErr = e;
      if (attempt >= attempts) break;
      onRetry?.(attempt, e);
      await sleep(backoffMs(attempt));
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}
