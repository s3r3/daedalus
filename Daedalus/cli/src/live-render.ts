import type { Event } from "@daedalus/core";

/**
 * Live-render helpers shared by the CLI's two human surfaces (the
 * fullscreen chat and one-shot `run`). The Web grew these first —
 * streamed model text and a per-task token line — while the CLI
 * stayed on per-turn blocks; this module is the CLI's half of that
 * parity, kept pure so both surfaces render identical numbers.
 */

/** Thousands-separated integer, matching the Web's token lines. */
export function formatCount(value: number): string {
  return Math.round(value).toLocaleString("en-US");
}

/**
 * "tokens 91,065 in · 2,263 out · 93,328 total · 6 requests" — the
 * Web transcript's footer format. Undefined when nothing was
 * reported (never invent numbers).
 */
export function tokenSummary(metrics: {
  tokens_input?: number;
  tokens_output?: number;
  tokens_total?: number;
  model_requests?: number;
}): string | undefined {
  const total = metrics.tokens_total ?? 0;
  if (!total) return undefined;
  const requests = metrics.model_requests ?? 0;
  return `tokens ${formatCount(metrics.tokens_input ?? 0)} in · ${formatCount(metrics.tokens_output ?? 0)} out · ${formatCount(total)} total${requests ? ` · ${requests} request${requests === 1 ? "" : "s"}` : ""}`;
}

/**
 * MODEL_TEXT_DELTA payloads carry the turn's CUMULATIVE text. A
 * terminal that prints raw increments needs the suffix since the
 * previous delta of the same turn; this tracker computes it and
 * stays safe when a provider's cumulative text is not a prefix
 * extension of the last one (then the whole text is re-emitted and
 * the caller decides how to present it).
 */
export class DeltaSuffixTracker {
  #turnId: string | undefined;
  #printed = "";

  /** Returns the new text to print for this delta ("" when none). */
  push(event: Event): string {
    if (event.type !== "MODEL_TEXT_DELTA") return "";
    const payload = event.payload as { text?: unknown };
    const text = typeof payload.text === "string" ? payload.text : "";
    const turnId = event.turn_id ?? event.task_id;
    if (turnId !== this.#turnId) {
      this.#turnId = turnId;
      this.#printed = "";
    }
    const suffix = text.startsWith(this.#printed) ? text.slice(this.#printed.length) : text;
    this.#printed = text;
    return suffix;
  }

  /** The current turn's full text (for surfaces that re-render). */
  get currentText(): string {
    return this.#printed;
  }

  reset(): void {
    this.#turnId = undefined;
    this.#printed = "";
  }
}

/**
 * Sidebar rows for the language servers a workspace will ACTUALLY
 * use: configured servers plus core's automatic defaults. An entry
 * present in `effective` but not `configured` is automatic — saying
 * so beats the old configured-only list, which claimed "none" on
 * TypeScript workspaces while the auto server served diagnostics.
 */
export function lspSidebarEntries(
  configured: Array<{ name: string; extensions: string[] }>,
  effective: Array<{ name: string; extensions: string[] }>,
): Array<{ name: string; detail: string }> {
  const configuredNames = new Set(configured.map((server) => server.name));
  return effective.map((server) => {
    const extensions = server.extensions.join(" ") || "no extensions";
    return configuredNames.has(server.name)
      ? { name: server.name, detail: `${extensions} · configured` }
      : { name: server.name, detail: `${extensions} · auto (starts on first use)` };
  });
}
