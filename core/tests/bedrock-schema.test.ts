import { describe, expect, test } from "vitest";
import {
  LLMError,
  OpenAICompatProvider,
  classifyLLMError,
  createDefaultRegistry,
  isFatalLLMError,
  isModelPoolRetryableError,
  isToolSchemaInvalidError,
  modelPoolFailureReason,
  normalizeToolParameters,
  readFileTool,
  userMessage,
  validateToolCallArguments,
} from "../src/index.ts";

type WireTool = { function: { name: string; parameters?: Record<string, unknown> } };

function fakeFetch(handler: (req: Request) => Promise<Response>): typeof fetch {
  return async (input: RequestInfo | URL, init?: RequestInit) => {
    const req = new Request(input, init);
    return handler(req);
  };
}

const COMBINATORS = ["oneOf", "allOf", "anyOf"];

function topLevelCombinators(schema: Record<string, unknown> | undefined): string[] {
  if (!schema) return [];
  return COMBINATORS.filter((key) => key in schema);
}

describe("tool-schema normalization (Bedrock/Anthropic-safe wire schemas)", () => {
  test("read_file: anyOf flattened, both path and paths stay available, nothing forced required", () => {
    const declared = readFileTool.inputSchema as Record<string, unknown>;
    expect(declared).toHaveProperty("anyOf");

    const normalized = normalizeToolParameters(declared);
    expect(normalized).toBeDefined();
    expect(topLevelCombinators(normalized)).toEqual([]);
    const properties = normalized!.properties as Record<string, unknown>;
    expect(properties).toHaveProperty("path");
    expect(properties).toHaveProperty("paths");
    // Intersection of {path} and {paths} is empty: the choice itself is
    // enforced by the runtime validator, not by the wire schema.
    expect(normalized).not.toHaveProperty("required");

    // The declared schema is never mutated.
    expect(declared).toHaveProperty("anyOf");
  });

  test("merges branch properties; required = top-level required union the intersection of branch requireds", () => {
    const schema = {
      type: "object",
      required: ["mode"],
      anyOf: [
        { required: ["mode", "path"], properties: { path: { type: "string" } } },
        { required: ["mode", "paths"], properties: { paths: { type: "array" } } },
      ],
      properties: { mode: { type: "string" } },
    };
    const normalized = normalizeToolParameters(schema)!;
    expect(topLevelCombinators(normalized)).toEqual([]);
    expect(normalized.required).toEqual(["mode"]);
    const properties = normalized.properties as Record<string, unknown>;
    expect(Object.keys(properties).sort()).toEqual(["mode", "path", "paths"]);
  });

  test("flattens combinators recursively in nested schemas (items/properties)", () => {
    const schema = {
      type: "object",
      properties: {
        entries: {
          type: "array",
          items: {
            type: "object",
            oneOf: [
              { required: ["text"], properties: { text: { type: "string" } } },
              { required: ["file"], properties: { file: { type: "string" } } },
            ],
          },
        },
      },
    };
    const normalized = normalizeToolParameters(schema)!;
    const items = (normalized.properties as Record<string, Record<string, unknown>>).entries.items as Record<string, unknown>;
    expect(topLevelCombinators(items)).toEqual([]);
    expect(Object.keys(items.properties as Record<string, unknown>).sort()).toEqual(["file", "text"]);
  });

  test("undefined and combinator-free schemas pass through with identical content", () => {
    expect(normalizeToolParameters(undefined)).toBeUndefined();
    const plain = { type: "object", required: ["a"], properties: { a: { type: "string" } } };
    expect(normalizeToolParameters(plain)).toEqual(plain);
  });

  test("every tool in the default registry is Bedrock-safe after normalization", () => {
    const schemas = createDefaultRegistry().schemas();
    expect(schemas.length).toBeGreaterThan(0);
    for (const tool of schemas) {
      const normalized = normalizeToolParameters(tool.function.parameters);
      expect(topLevelCombinators(normalized), tool.function.name).toEqual([]);
    }
  });

  test("the provider puts normalized schemas on the wire (and leaves registry schemas untouched)", async () => {
    let sentTools: WireTool[] = [];
    const fetchImpl = fakeFetch(async (req) => {
      const body = (await req.json()) as { tools: WireTool[] };
      sentTools = body.tools;
      return new Response(
        JSON.stringify({ choices: [{ message: { role: "assistant", content: "ok" }, finish_reason: "stop" }] }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    });
    const provider = new OpenAICompatProvider({ baseUrl: "https://llm.example/v1", apiKey: "<redacted>", model: "kr/claude-sonnet-4.5", fetch: fetchImpl });

    const registrySchemas = createDefaultRegistry().schemas();
    await provider.chat([userMessage("read something")], registrySchemas);

    expect(sentTools.length).toBe(registrySchemas.length);
    for (const tool of sentTools) {
      expect(topLevelCombinators(tool.function.parameters), tool.function.name).toEqual([]);
    }
    const sentReadFile = sentTools.find((tool) => tool.function.name === "read_file");
    expect(sentReadFile?.function.parameters).toHaveProperty("properties.path");
    expect(sentReadFile?.function.parameters).toHaveProperty("properties.paths");
    // The declared registry schema keeps its anyOf for the validator.
    const declaredReadFile = registrySchemas.find((tool) => tool.function.name === "read_file");
    expect(declaredReadFile?.function.parameters).toHaveProperty("anyOf");
  });
});

describe("read_file validator semantics are unchanged (declared anyOf still enforced)", () => {
  test("rejects a call with neither path nor paths; accepts either", () => {
    const schema = readFileTool.inputSchema;
    expect(validateToolCallArguments("read_file", schema, {}).ok).toBe(false);
    expect(validateToolCallArguments("read_file", schema, { path: "a.txt" }).ok).toBe(true);
    expect(validateToolCallArguments("read_file", schema, { paths: ["a.txt", "b.css"] }).ok).toBe(true);
    expect(validateToolCallArguments("read_file", schema, { path: 42 }).ok).toBe(false);
  });
});

describe("tool-schema-invalid provider rejections are fatal, not transient", () => {
  const bedrockMessage =
    "[400]: {\"message\":\"Bedrock error message: The model returned the following errors: tools.0.custom.input_schema: input_schema does not support oneOf, allOf, or anyOf at the top level\",\"reason\":\"TOOL_SCHEMA_INVALID\"}";

  test("classifies as fatal, not pool-retryable, with an honest reason label", () => {
    const error = new LLMError(bedrockMessage, { code: "provider" });
    expect(isToolSchemaInvalidError(error)).toBe(true);
    expect(classifyLLMError(error)).toBe("fatal");
    expect(isFatalLLMError(error)).toBe(true);
    expect(isModelPoolRetryableError(error)).toBe(false);
    expect(modelPoolFailureReason(error)).toBe("tool_schema_invalid");
  });

  test("an end-to-end 400 from the provider surfaces as a fatal error", async () => {
    const fetchImpl = fakeFetch(async () =>
      new Response(JSON.stringify({ error: { message: bedrockMessage } }), { status: 400 }),
    );
    const provider = new OpenAICompatProvider({ baseUrl: "https://llm.example/v1", apiKey: "<redacted>", model: "kr/claude-sonnet-4.5", fetch: fetchImpl });
    const failure = await provider.chat([userMessage("hi")]).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(LLMError);
    expect(classifyLLMError(failure)).toBe("fatal");
  });

  test("precision: a plain malformed-request 400 and unrelated input_schema mentions stay non-fatal", () => {
    expect(classifyLLMError(new LLMError("Invalid request: 'max_tokens' must be a positive integer", { code: "provider" }))).toBe("other");
    expect(isToolSchemaInvalidError(new LLMError("provider error: 400"))).toBe(false);
    expect(isToolSchemaInvalidError(new LLMError("some other validation complaint"))).toBe(false);
  });
});
