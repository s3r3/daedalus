import { createHash } from "node:crypto";
import type { LLMProvider, Message, ToolDefinition } from "./types.ts";

/**
 * Prompt caching for the stable request prefix (system prompt + tool schemas).
 *
 * Provider support, measured 2026-10-11 against the 9Router codebases
 * (Farid's relay speaks OpenAI Chat Completions to them):
 * - `prompt_cache_key` (top-level OpenAI chat-body field) is honoured by
 *   9Router: its chat->chat translation retains the key, and the
 *   Responses->Chat path preserves it for upstreams that declare
 *   `preservePromptCacheKey` (e.g. upstream OpenAI) while stripping it for
 *   upstreams that don't (groq, github-copilot). Fail-open for unknown
 *   providers on the chat->chat hop.
 * - Anthropic-style `cache_control` breakpoints sent by the *client* over the
 *   OpenAI wire are USELESS: 9Router's openai->claude translator strips
 *   client-supplied `cache_control` and injects its own
 *   `{ type: "ephemeral", ttl: "1h" }` breakpoints on system/tools itself.
 * - Farid's actual chain (9Router -> Kiro/AWS CodeWhisperer, model `kr/auto`)
 *   has NO prompt-cache handling in the openai->kiro translator and no
 *   cache API upstream: nothing is provably honoured there today.
 *
 * Consequence: the ONLY mechanism with positive evidence on this wire is
 * `prompt_cache_key`, and it only pays off when the relay's upstream is an
 * OpenAI(-compatible) endpoint that does prefix caching. Everything here is
 * therefore gated: the caller marks intent (`ChatOptions.cachePrefix`), each
 * adapter translates ONLY when its dialect positively supports a mechanism,
 * and the default is "none" — no cache parameter may ever reach a
 * provider/dialect that would 400 on it.
 */

/**
 * Cache mechanisms a provider dialect can translate `cachePrefix` into.
 * `"none"` (default) means the adapter emits nothing cache-related.
 */
export type PromptCacheMechanism = "none" | "prompt_cache_key";

/** Structural capability a provider adapter may declare. */
export interface PromptCacheCapable {
  readonly promptCacheMechanism: PromptCacheMechanism;
}

/** `LLM_PROMPT_CACHE`: `none` (default) or `prompt_cache_key`; anything else fails fast. */
export function parsePromptCacheMechanism(value: string | undefined, source = "LLM_PROMPT_CACHE"): PromptCacheMechanism {
  if (value === undefined || value.trim() === "") return "none";
  const normalized = value.trim().toLowerCase();
  if (normalized === "none" || normalized === "off" || normalized === "false") return "none";
  if (normalized === "prompt_cache_key") return "prompt_cache_key";
  throw new Error(`Invalid ${source}: ${value} (expected none or prompt_cache_key)`);
}

/**
 * Capability detection. Returns a mechanism ONLY when the provider
 * explicitly declares one (structural `promptCacheMechanism`). Unknown
 * providers, wrappers that don't declare, and anything else -> "none".
 * Never guess from base URLs, model names, or headers.
 */
export function detectPromptCacheMechanism(provider: LLMProvider): PromptCacheMechanism {
  const candidate = provider as Partial<PromptCacheCapable>;
  return candidate.promptCacheMechanism === "prompt_cache_key" ? "prompt_cache_key" : "none";
}

/**
 * Deterministic cache identity for a stable prefix: the model plus the
 * system prompt plus the tool schemas. Conversation history (user/assistant/
 * tool messages) is deliberately EXCLUDED: the key must identify the shared
 * prefix so every turn of a task hits the same cache entry.
 */
export function stablePrefixCacheKey(model: string, messages: Message[], tools?: ToolDefinition[], seed?: string): string {
  // Dengan benih stabil (id task) kunci tidak ikut berubah saat bagian volatil system prompt (rencana, ikhtisar
  // workspace) berubah — tujuan awal dokumen ini: "every turn of a task hits the same cache entry".
  if (seed) return createHash("sha256").update(JSON.stringify({ model, seed, tools: tools ?? [] })).digest("hex");
  const systemText = messages
    .filter((message) => message.role === "system")
    .map((message) => (typeof message.content === "string" ? message.content : JSON.stringify(message.content)))
    .join("\n");
  return createHash("sha256")
    .update(JSON.stringify({ model, system: systemText, tools: tools ?? [] }))
    .digest("hex");
}
