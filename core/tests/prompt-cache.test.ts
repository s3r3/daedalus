import { describe, expect, test } from "vitest";
import {
  OpenAICompatProvider,
  TextProtocolProvider,
  detectPromptCacheMechanism,
  instrumentProvider,
  parsePromptCacheMechanism,
  stablePrefixCacheKey,
  systemMessage,
  userMessage,
  type ChatOptions,
  type LLMProvider,
  type Message,
  type ToolDefinition,
} from "../src/index.ts";
import { loadSettings } from "../src/settings.ts";

const TOOLS: ToolDefinition[] = [
  { type: "function", function: { name: "read_file", description: "read", parameters: { type: "object" } } },
  { type: "function", function: { name: "write_file", description: "write", parameters: { type: "object" } } },
];

function fakeFetch(capture: { body?: Record<string, unknown> }): typeof fetch {
  return (async (_input: RequestInfo | URL, init?: RequestInit) => {
    capture.body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    return new Response(
      JSON.stringify({
        choices: [{ message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
        usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 },
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  }) as typeof fetch;
}

function baseOptions(extra: Partial<OpenAICompatProviderOptions> = {}): OpenAICompatProviderOptions {
  return { baseUrl: "https://llm.example.test/v1", apiKey: "k", model: "kr/auto", ...extra };
}

type OpenAICompatProviderOptions = ConstructorParameters<typeof OpenAICompatProvider>[0];

const PREFIX_MESSAGES: Message[] = [systemMessage("You are Daedalus."), userMessage("turn 1")];

describe("parsePromptCacheMechanism", () => {
  test("defaults to none", () => {
    expect(parsePromptCacheMechanism(undefined)).toBe("none");
    expect(parsePromptCacheMechanism("")).toBe("none");
    expect(parsePromptCacheMechanism("none")).toBe("none");
    expect(parsePromptCacheMechanism("OFF")).toBe("none");
  });

  test("accepts prompt_cache_key", () => {
    expect(parsePromptCacheMechanism("prompt_cache_key")).toBe("prompt_cache_key");
    expect(parsePromptCacheMechanism(" PROMPT_CACHE_KEY ")).toBe("prompt_cache_key");
  });

  test("rejects unknown values", () => {
    expect(() => parsePromptCacheMechanism("anthropic")).toThrow(/LLM_PROMPT_CACHE/);
    expect(() => parsePromptCacheMechanism("true")).toThrow(/LLM_PROMPT_CACHE/);
  });
});

describe("detectPromptCacheMechanism", () => {
  test("unknown providers are never detected", () => {
    const plain = { name: "mystery", chat: async () => { throw new Error("x"); }, stream: async function* () {} } as unknown as LLMProvider;
    expect(detectPromptCacheMechanism(plain)).toBe("none");
    // A lying declaration is still rejected: only the known mechanism passes.
    const liar = { ...plain, promptCacheMechanism: "anthropic_breakpoints" } as unknown as LLMProvider;
    expect(detectPromptCacheMechanism(liar)).toBe("none");
  });

  test("OpenAICompatProvider defaults to none, declares when configured", () => {
    expect(detectPromptCacheMechanism(new OpenAICompatProvider(baseOptions()))).toBe("none");
    expect(detectPromptCacheMechanism(new OpenAICompatProvider(baseOptions({ promptCache: "prompt_cache_key" })))).toBe(
      "prompt_cache_key",
    );
  });

  test("TextProtocolProvider delegates to its inner provider", () => {
    const innerOff = new OpenAICompatProvider(baseOptions());
    const innerOn = new OpenAICompatProvider(baseOptions({ promptCache: "prompt_cache_key" }));
    expect(detectPromptCacheMechanism(new TextProtocolProvider(innerOff, { protocol: "native" }))).toBe("none");
    expect(detectPromptCacheMechanism(new TextProtocolProvider(innerOn, { protocol: "native" }))).toBe("prompt_cache_key");
  });
});

describe("stablePrefixCacheKey", () => {
  test("is deterministic and hex", () => {
    const a = stablePrefixCacheKey("kr/auto", PREFIX_MESSAGES, TOOLS);
    const b = stablePrefixCacheKey("kr/auto", PREFIX_MESSAGES, TOOLS);
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
  });

  test("changes when the model, system prompt, or tools change", () => {
    const base = stablePrefixCacheKey("kr/auto", PREFIX_MESSAGES, TOOLS);
    expect(stablePrefixCacheKey("other", PREFIX_MESSAGES, TOOLS)).not.toBe(base);
    expect(stablePrefixCacheKey("kr/auto", [systemMessage("different"), userMessage("turn 1")], TOOLS)).not.toBe(base);
    expect(stablePrefixCacheKey("kr/auto", PREFIX_MESSAGES, TOOLS.slice(0, 1))).not.toBe(base);
  });

  test("ignores conversation history: the key identifies the prefix, not the turn", () => {
    const base = stablePrefixCacheKey("kr/auto", PREFIX_MESSAGES, TOOLS);
    const later: Message[] = [
      ...PREFIX_MESSAGES,
      { role: "assistant", content: "reading the file" },
      { role: "tool", content: "file contents", tool_call_id: "1" },
      userMessage("turn 2"),
    ];
    expect(stablePrefixCacheKey("kr/auto", later, TOOLS)).toBe(base);
  });
});

describe("OpenAICompatProvider request shape", () => {
  test("gate closed by default: cachePrefix is ignored, wire unchanged", async () => {
    const capture: { body?: Record<string, unknown> } = {};
    const provider = new OpenAICompatProvider({ ...baseOptions(), fetch: fakeFetch(capture) });
    await provider.chat(PREFIX_MESSAGES, TOOLS, { cachePrefix: true });
    expect(capture.body).toBeDefined();
    expect("prompt_cache_key" in capture.body!).toBe(false);
    expect(capture.body!.model).toBe("kr/auto");
  });

  test("no marker, no key: an enabled provider stays silent without cachePrefix", async () => {
    const capture: { body?: Record<string, unknown> } = {};
    const provider = new OpenAICompatProvider({ ...baseOptions({ promptCache: "prompt_cache_key" }), fetch: fakeFetch(capture) });
    await provider.chat(PREFIX_MESSAGES, TOOLS, {});
    expect("prompt_cache_key" in capture.body!).toBe(false);
  });

  test("gate open: enabled provider + cachePrefix emits a stable key", async () => {
    const first: { body?: Record<string, unknown> } = {};
    const second: { body?: Record<string, unknown> } = {};
    const options = { ...baseOptions({ promptCache: "prompt_cache_key" }) };
    const p1 = new OpenAICompatProvider({ ...options, fetch: fakeFetch(first) });
    const p2 = new OpenAICompatProvider({ ...options, fetch: fakeFetch(second) });
    const chatOptions: ChatOptions = { cachePrefix: true };
    await p1.chat(PREFIX_MESSAGES, TOOLS, chatOptions);
    await p2.chat([...PREFIX_MESSAGES, userMessage("turn 2")], TOOLS, chatOptions);
    const key1 = first.body!["prompt_cache_key"];
    const key2 = second.body!["prompt_cache_key"];
    expect(typeof key1).toBe("string");
    expect(key1).toMatch(/^[0-9a-f]{64}$/);
    // Same prefix across turns -> same key, so the relay can hit one cache entry.
    expect(key2).toBe(key1);
  });

  test("streaming requests carry the key too", async () => {
    const capture: { body?: Record<string, unknown> } = {};
    const provider = new OpenAICompatProvider({ ...baseOptions({ promptCache: "prompt_cache_key" }), fetch: fakeFetch(capture) });
    for await (const _chunk of provider.stream(PREFIX_MESSAGES, TOOLS, { cachePrefix: true })) {
      // The fake fetch answers with plain JSON; the provider surfaces it as chunks.
    }
    expect(typeof capture.body!["prompt_cache_key"]).toBe("string");
  });

  test("the mark flows untouched through the wrappers the agent loop uses", async () => {
    const capture: { body?: Record<string, unknown> } = {};
    const inner = new OpenAICompatProvider({ ...baseOptions({ promptCache: "prompt_cache_key" }), fetch: fakeFetch(capture) });
    const events: Array<{ type: string }> = [];
    const provider = instrumentProvider(new TextProtocolProvider(inner, { protocol: "native" }), (e) => events.push(e));
    await provider.chat(PREFIX_MESSAGES, TOOLS, { cachePrefix: true });
    expect(typeof capture.body!["prompt_cache_key"]).toBe("string");
    expect(events.map((e) => e.type)).toContain("MODEL_REQUEST_FINISHED");
  });
});

describe("settings", () => {
  test("LLM_PROMPT_CACHE parses into settings.llm.promptCache", () => {
    expect(loadSettings({}).llm.promptCache).toBe("none");
    expect(loadSettings({ LLM_PROMPT_CACHE: "prompt_cache_key" }).llm.promptCache).toBe("prompt_cache_key");
    expect(() => loadSettings({ LLM_PROMPT_CACHE: "anthropic" })).toThrow(/LLM_PROMPT_CACHE/);
  });
});
