import { describe, expect, test, vi } from "vitest";
import {
  DEFAULT_LLM_TIMEOUT_MS,
  DEFAULT_RETRY_POLICY,
  EventBus,
  LLMAuthError,
  LLMError,
  LLMFormatError,
  LLMRateLimitError,
  LLMTimeoutError,
  OpenAICompatProvider,
  buildPrompt,
  classifyLLMError,
  classifyProviderError,
  clearProviders,
  defaultTemplate,
  estimateTokens,
  getProvider,
  hasUpstreamFailureMarker,
  instrumentProvider,
  isFatalLLMError,
  isModelPoolRetryableError,
  isTransientLLMError,
  registerProvider,
  systemMessage,
  userMessage,
  withRetry,
  type LLMProvider,
  type Message,
  type ToolDefinition,
} from "../src/index.ts";

function fakeFetch(handler: (req: Request) => Promise<Response>): typeof fetch {
  return async (input: RequestInfo | URL, init?: RequestInit) => {
    const req = new Request(input, init);
    return handler(req);
  };
}

describe("OpenAICompatProvider non-streaming", () => {
  test("sends messages and parses response + usage", async () => {
    const fetchImpl = fakeFetch(async (req) => {
      const body = (await req.json()) as { messages: Message[]; model: string };
      expect(body.model).toBe("qwen-turbo");
      expect(body.messages).toHaveLength(2);
      expect(req.headers.get("authorization")).toBe("Bearer secret-key");
      return new Response(
        JSON.stringify({
          choices: [
            {
              message: { role: "assistant", content: "Hello! I am Daedalus." },
              finish_reason: "stop",
            },
          ],
          usage: { prompt_tokens: 12, completion_tokens: 8, total_tokens: 20 },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    });

    const provider = new OpenAICompatProvider({
      baseUrl: "https://llm.ayid.cc.cd/v1",
      apiKey: "secret-key",
      model: "qwen-turbo",
      fetch: fetchImpl,
    });

    const res = await provider.chat([
      systemMessage("You are Daedalus."),
      userMessage("hi"),
    ]);

    expect(res.message.role).toBe("assistant");
    expect(res.message.content).toBe("Hello! I am Daedalus.");
    expect(res.usage).toEqual({ prompt_tokens: 12, completion_tokens: 8, total_tokens: 20 });
    expect(res.finish_reason).toBe("stop");
  });

  test("surfaces structured tool call payloads", async () => {
    const fetchImpl = fakeFetch(async (req) => {
      const body = (await req.json()) as { tools: ToolDefinition[] };
      expect(body.tools).toHaveLength(1);
      return new Response(
        JSON.stringify({
          choices: [
            {
              message: {
                role: "assistant",
                content: "",
                tool_calls: [
                  {
                    id: "call_123",
                    type: "function",
                    function: {
                      name: "read_file",
                      arguments: '{"path":"README.md"}',
                    },
                  },
                ],
              },
              finish_reason: "tool_calls",
            },
          ],
          usage: { prompt_tokens: 25, completion_tokens: 15, total_tokens: 40 },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    });

    const provider = new OpenAICompatProvider({
      baseUrl: "https://llm.ayid.cc.cd/v1",
      apiKey: "secret-key",
      model: "qwen-turbo",
      fetch: fetchImpl,
    });

    const tools: ToolDefinition[] = [
      {
        type: "function",
        function: {
          name: "read_file",
          description: "Read a file from disk",
          parameters: { type: "object", properties: { path: { type: "string" } } },
        },
      },
    ];

    const res = await provider.chat([userMessage("read README.md")], tools);
    expect(res.message.tool_calls).toHaveLength(1);
    expect(res.message.tool_calls?.[0]?.function.name).toBe("read_file");
    expect(JSON.parse(res.message.tool_calls?.[0]?.function.arguments ?? "{}")).toEqual({
      path: "README.md",
    });
    expect(res.finish_reason).toBe("tool_calls");
  });

  test("surfaces 401 as LLMAuthError", async () => {
    const fetchImpl = fakeFetch(async () =>
      new Response(JSON.stringify({ error: { message: "Invalid API key" } }), { status: 401 }),
    );
    const provider = new OpenAICompatProvider({
      baseUrl: "https://llm.ayid.cc.cd/v1",
      apiKey: "bad-key",
      model: "qwen-turbo",
      fetch: fetchImpl,
    });
    await expect(provider.chat([userMessage("hi")])).rejects.toThrow(LLMAuthError);
  });

  test("surfaces 429 as LLMRateLimitError with retryAfterMs", async () => {
    const fetchImpl = fakeFetch(async () =>
      new Response(JSON.stringify({ error: { message: "Rate limit exceeded" } }), {
        status: 429,
        headers: { "retry-after": "5" },
      }),
    );
    const provider = new OpenAICompatProvider({
      baseUrl: "https://llm.ayid.cc.cd/v1",
      apiKey: "k",
      model: "m",
      fetch: fetchImpl,
    });
    try {
      await provider.chat([userMessage("hi")]);
      expect.fail("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(LLMRateLimitError);
      expect((err as LLMRateLimitError).retryAfterMs).toBe(5000);
    }
  });

  test("times out when request exceeds timeout_ms", async () => {
    const fetchImpl = fakeFetch(
      (_req) =>
        new Promise((_resolve, reject) => {
          setTimeout(() => reject(new Error("aborted")), 100);
        }),
    );
    const provider = new OpenAICompatProvider({
      baseUrl: "https://llm.ayid.cc.cd/v1",
      apiKey: "k",
      model: "m",
      fetch: fetchImpl,
      defaultTimeoutMs: 20,
    });
    await expect(provider.chat([userMessage("hi")], undefined, { timeout_ms: 20 })).rejects.toThrow(
      LLMTimeoutError,
    );
  });

  test("uses defaultTimeoutMs when timeout_ms is omitted", async () => {
    const fetchImpl = fakeFetch(
      (_req) =>
        new Promise((_resolve, reject) => {
          setTimeout(() => reject(new Error("aborted")), 100);
        }),
    );
    const provider = new OpenAICompatProvider({
      baseUrl: "https://llm.ayid.cc.cd/v1",
      apiKey: "k",
      model: "m",
      fetch: fetchImpl,
      defaultTimeoutMs: 20,
    });
    await expect(provider.chat([userMessage("hi")])).rejects.toThrow("LLM request timed out after 20ms");
  });

  test("uses a 180s provider default and classifies provider failures", () => {
    expect(DEFAULT_LLM_TIMEOUT_MS).toBe(180_000);
    expect(classifyLLMError(new LLMTimeoutError("timed out"))).toBe("transient");
    expect(isTransientLLMError(new LLMError("provider returned HTTP 503", { code: "transient" }))).toBe(true);
    expect(isTransientLLMError(new LLMRateLimitError("slow down"))).toBe(true);
    expect(classifyLLMError(new LLMAuthError("bad key"))).toBe("fatal");
    expect(isFatalLLMError(new LLMError("refused", { code: "content_policy" }))).toBe(true);
    expect(classifyLLMError(new LLMFormatError("bad format"))).toBe("other");
  });

  test("router-wrapped upstream 400 is transient and pool-retryable; a plain malformed 400 is not", async () => {
    const upstreamBody = { error: { type: "invalid_request_error", message: "Error from provider (Console): Upstream request failed: [invalid_request_error] invalid request" } };
    expect(hasUpstreamFailureMarker(upstreamBody)).toBe(true);
    expect(classifyLLMError(new LLMError(upstreamBody.error.message))).toBe("transient");
    expect(classifyLLMError(classifyProviderError(400, upstreamBody))).toBe("transient");

    const malformedBody = { error: { type: "invalid_request_error", message: "Invalid request: 'max_tokens' must be a positive integer" } };
    expect(hasUpstreamFailureMarker(malformedBody)).toBe(false);
    expect(classifyLLMError(classifyProviderError(400, malformedBody))).toBe("other");

    const upstreamFetch = fakeFetch(async () =>
      new Response(JSON.stringify(upstreamBody), { status: 400 }),
    );
    const provider = new OpenAICompatProvider({
      baseUrl: "https://llm.ayid.cc.cd/v1",
      apiKey: "test-key",
      model: "m",
      fetch: upstreamFetch,
    });
    const upstreamError = await provider.chat([userMessage("hi")]).catch((error: unknown) => error);
    expect(upstreamError).toBeInstanceOf(LLMError);
    expect(isTransientLLMError(upstreamError)).toBe(true);
    expect(isModelPoolRetryableError(upstreamError)).toBe(true);

    const malformedFetch = fakeFetch(async () =>
      new Response(JSON.stringify(malformedBody), { status: 400 }),
    );
    const strictProvider = new OpenAICompatProvider({
      baseUrl: "https://llm.ayid.cc.cd/v1",
      apiKey: "test-key",
      model: "m",
      fetch: malformedFetch,
    });
    const malformedError = await strictProvider.chat([userMessage("hi")]).catch((error: unknown) => error);
    expect(malformedError).toBeInstanceOf(LLMError);
    expect(isTransientLLMError(malformedError)).toBe(false);
    expect(isModelPoolRetryableError(malformedError)).toBe(false);
  });

  test("throws LLMFormatError on malformed choice response", async () => {
    const fetchImpl = fakeFetch(async () =>
      new Response(JSON.stringify({ choices: [] }), { status: 200 }),
    );
    const provider = new OpenAICompatProvider({
      baseUrl: "https://llm.ayid.cc.cd/v1",
      apiKey: "k",
      model: "m",
      fetch: fetchImpl,
    });
    await expect(provider.chat([userMessage("hi")])).rejects.toThrow(LLMFormatError);
  });
});

describe("OpenAICompatProvider streaming", () => {
  test("streams incremental delta chunks + usage + finish", async () => {
    const chunks = [
      'data: {"choices":[{"delta":{"content":"Hel"}}]}\n\n',
      'data: {"choices":[{"delta":{"content":"lo "}}]}\n\n',
      'data: {"choices":[{"delta":{"content":"world!"}}],"usage":{"prompt_tokens":5,"completion_tokens":3,"total_tokens":8}}\n\n',
      'data: {"choices":[{"finish_reason":"stop"}]}\n\n',
      "data: [DONE]\n\n",
    ];

    const stream = new ReadableStream({
      start(controller) {
        for (const chunk of chunks) {
          controller.enqueue(new TextEncoder().encode(chunk));
        }
        controller.close();
      },
    });

    const fetchImpl = fakeFetch(async () =>
      new Response(stream, {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      }),
    );

    const provider = new OpenAICompatProvider({
      baseUrl: "https://llm.ayid.cc.cd/v1",
      apiKey: "k",
      model: "m",
      fetch: fetchImpl,
    });

    const deltas: string[] = [];
    let finishReason: string | undefined;
    let finalUsage: { total_tokens: number } | undefined;

    for await (const chunk of provider.stream([userMessage("hi")])) {
      if (chunk.type === "delta") deltas.push(chunk.content);
      if (chunk.type === "finish") finishReason = chunk.finish_reason;
      if (chunk.type === "usage") finalUsage = chunk.usage;
    }

    expect(deltas.join("")).toBe("Hello world!");
    expect(finishReason).toBe("stop");
    expect(finalUsage?.total_tokens).toBe(8);
  });
});

describe("Retry policy", () => {
  test("retries transient 500 error up to limit then succeeds", async () => {
    let attempts = 0;
    const op = vi.fn(async () => {
      attempts++;
      if (attempts < 3) {
        const err = new Error("server error") as { code?: string };
        err.code = "transient";
        throw err;
      }
      return "recovered";
    });

    const result = await withRetry(op, {
      ...DEFAULT_RETRY_POLICY,
      baseDelayMs: 1,
      maxDelayMs: 5,
      sleep: () => Promise.resolve(),
    });

    expect(result).toBe("recovered");
    expect(attempts).toBe(3);
  });

  test("does not retry 401 auth error", async () => {
    let attempts = 0;
    const op = vi.fn(async () => {
      attempts++;
      throw new LLMAuthError("bad token");
    });

    await expect(
      withRetry(op, {
        ...DEFAULT_RETRY_POLICY,
        baseDelayMs: 1,
        sleep: () => Promise.resolve(),
      }),
    ).rejects.toThrow(LLMAuthError);

    expect(attempts).toBe(1);
  });
});

describe("Provider Registry & Seam", () => {
  test("allows registering a second custom provider without modifying caller", async () => {
    clearProviders();
    const mockProvider: LLMProvider = {
      name: "stub-anthropic",
      async chat(messages) {
        return {
          message: {
            role: "assistant",
            content: `Echo from stub: ${(messages[messages.length - 1]?.content as string) ?? ""}`,
          },
        };
      },
      async *stream() {
        yield { type: "delta", content: "stub stream" };
      },
    };

    registerProvider(mockProvider);
    const resolved = getProvider("stub-anthropic");
    expect(resolved.name).toBe("stub-anthropic");

    const res = await resolved.chat([userMessage("hello world")]);
    expect(res.message.content).toBe("Echo from stub: hello world");
  });
});

describe("Prompt Management & Token Estimation", () => {
  test("assembles ordered prompt sections", () => {
    const template = defaultTemplate({ goal: "Add auth", repoPath: "/workspace" });
    const prompt = buildPrompt(template);
    expect(prompt).toContain("## role");
    expect(prompt).toContain("## task\nAdd auth");
    expect(prompt).toContain("## repo\nRepository: /workspace");
    expect(prompt).toContain("## constraints");
  });

  test("estimates token count from string length", () => {
    expect(estimateTokens("")).toBe(0);
    expect(estimateTokens("abcd")).toBe(1);
    expect(estimateTokens("12345678")).toBe(2);
  });
});

describe("Provider Instrumentation", () => {
  test("emits request lifecycle events on event bus", async () => {
    const bus = new EventBus();
    const events: string[] = [];
    bus.on("MODEL_REQUEST_STARTED", () => events.push("started"));
    bus.on("MODEL_REQUEST_FINISHED", () => events.push("finished"));

    const baseProvider: LLMProvider = {
      name: "mock-llm",
      async chat() {
        return { message: { role: "assistant", content: "ok" } };
      },
      async *stream() {},
    };

    const instrumented = instrumentProvider(baseProvider, (e) => {
      bus.publish({
        seq: events.length + 1,
        task_id: "t1",
        type: e.type,
        payload: e.payload,
        ts: new Date().toISOString(),
      });
    });

    await instrumented.chat([userMessage("test")]);
    await bus.drain();

    expect(events).toEqual(["started", "finished"]);
  });
});

describe("OpenAICompatProvider streaming", () => {
  test("parses SSE deltas, usage, and finish", async () => {
    const fetchImpl = fakeFetch(async () => {
      const sse = [
        'data: {"choices":[{"delta":{"content":"Hel"}}]}',
        'data: {"choices":[{"delta":{"content":"lo"}}]}',
        'data: {"choices":[{"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":3,"completion_tokens":2,"total_tokens":5}}',
        "data: [DONE]",
        "",
      ].join("\n");
      return new Response(sse, { status: 200, headers: { "content-type": "text/event-stream" } });
    });
    const provider = new OpenAICompatProvider({ baseUrl: "https://example.test/v1", apiKey: "k", model: "m", fetch: fetchImpl });
    const chunks = [];
    for await (const chunk of provider.stream([userMessage("hi")])) chunks.push(chunk);
    expect(chunks).toContainEqual({ type: "delta", content: "Hel", tool_calls: undefined });
    expect(chunks).toContainEqual({ type: "usage", usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 } });
    expect(chunks).toContainEqual({ type: "finish", finish_reason: "stop" });
  });

  test("a gateway that ignores stream:true and answers JSON yields the whole message once", async () => {
    const fetchImpl = fakeFetch(async () =>
      new Response(
        JSON.stringify({
          choices: [
            {
              message: {
                role: "assistant",
                content: "",
                tool_calls: [{ id: "c1", type: "function", function: { name: "ask_user", arguments: "{}" } }],
              },
              finish_reason: "tool_calls",
            },
          ],
          usage: { prompt_tokens: 9, completion_tokens: 4, total_tokens: 13 },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );
    const provider = new OpenAICompatProvider({ baseUrl: "https://example.test/v1", apiKey: "k", model: "m", fetch: fetchImpl });
    const chunks = [];
    for await (const chunk of provider.stream([userMessage("hi")])) chunks.push(chunk);
    const delta = chunks.find((chunk) => chunk.type === "delta");
    expect(delta?.type === "delta" ? delta.tool_calls?.[0]?.function?.name : undefined).toBe("ask_user");
    expect(chunks).toContainEqual({ type: "finish", finish_reason: "tool_calls" });
  });
});
