/** Yield parsed JSON objects from an SSE response and release the network body
 * immediately when its owning project run is cancelled. */
export async function* sseEvents(resp: Response, signal?: AbortSignal): AsyncGenerator<any> {
  if (!resp.body) throw new Error("Codex responses returned no body");
  const decoder = new TextDecoder();
  let buf = "";
  const reader = resp.body.getReader();
  const onAbort = () => { void reader.cancel(signal?.reason).catch(() => {}); };
  if (signal?.aborted) onAbort();
  else signal?.addEventListener("abort", onAbort, { once: true });
  try {
    while (true) {
      if (signal?.aborted) throw abortError();
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let idx: number;
      while ((idx = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, idx).trim();
        buf = buf.slice(idx + 1);
        if (!line.startsWith("data:")) continue;
        const raw = line.slice(5).trim();
        if (raw === "[DONE]") return;
        try {
          yield JSON.parse(raw);
        } catch {
          /* ignore keep-alive / partial */
        }
      }
    }
    if (signal?.aborted) throw abortError();
  } finally {
    signal?.removeEventListener("abort", onAbort);
    try {
      reader.releaseLock();
    } catch {
      /* the stream was already cancelled */
    }
  }
}

export function abortError() {
  const error = new Error("aborted");
  error.name = "AbortError";
  return error;
}
