import type { ToolProtocol } from "../../contracts.ts";
import { LLMFormatError } from "./errors.ts";
import type { ChatOptions, ChatResponse, LLMProvider, Message, StreamChunk, ToolCall, ToolDefinition } from "./types.ts";

export type { ToolProtocol };

/**
 * Text tool-calling protocol — the Cline lesson, as a provider-layer adapter.
 *
 * Daedalus historically spoke only native function calling. Models routed
 * through aggregators (9Router and friends) vary wildly at that wire format:
 * some stall, loop, or emit garbage arguments when handed native tool
 * definitions. The agents that survive arbitrary router models (Cline's XML
 * tool tags; Aider's text edit formats) substitute a *text* protocol those
 * models can imitate. This wrapper does the same without touching the agent
 * loop: it implements the same `LLMProvider` contract around an inner
 * OpenAI-compatible provider.
 *
 * - `native`: pure passthrough.
 * - `text`: the inner provider is called WITHOUT `tools`; the system message
 *   gains a compact protocol block describing each tool as an XML-ish
 *   `<tool_call name="…"><param>…</param></tool_call>` block. Assistant text
 *   is parsed back into structured `tool_calls`; history (assistant tool
 *   calls, tool results) is rendered to the model as text.
 * - `auto` (default): start native; count consecutive *unusable* native
 *   responses (thrown LLMFormatError, empty response with no tool calls,
 *   tool calls whose arguments are not valid JSON). After `switchThreshold`
 *   (default 2) in a row, this provider instance switches to text for the
 *   rest of its life, retries the current request in text mode, and reports
 *   the switch through `onProtocolSwitch` (the runtime turns that into a
 *   PROVIDER_CHANGED event). A usable native response resets the counter.
 *
 * Malformed text emissions (unknown tool, unparseable arguments) are not
 * thrown away: one internal repair round-trip feeds the model an instructive
 * error restating the exact syntax with an example, mirroring Cline's
 * format-error feedback. If the repair still fails, the reply degrades to
 * plain assistant text and the agent loop's own invalid-action guidance is
 * the final fallback.
 */

export type ProtocolSwitchInfo = {
  from: "native";
  to: "text";
  /** Why the switch happened (the last unusable-response signal). */
  reason: string;
  /** Consecutive unusable native responses that triggered the switch. */
  failures: number;
};

export type TextProtocolOptions = {
  /** Configured protocol; default `auto`. */
  protocol?: ToolProtocol;
  /** Consecutive unusable native responses before `auto` switches. Default 2. */
  switchThreshold?: number;
  /** Called once when `auto` switches this instance to text. */
  onProtocolSwitch?: (info: ProtocolSwitchInfo) => void | Promise<void>;
};

const DEFAULT_SWITCH_THRESHOLD = 2;

export function parseToolProtocol(value: string | undefined, source = "LLM_TOOL_PROTOCOL"): ToolProtocol {
  if (value === undefined || value.trim() === "") return "auto";
  const normalized = value.trim().toLowerCase();
  if (normalized === "native" || normalized === "text" || normalized === "auto") return normalized;
  throw new Error(`Invalid ${source}: ${value} (expected native, text, or auto)`);
}

/** Lenient variant for stored provider configs: garbage means "unset". */
export function normalizeToolProtocol(value: unknown): ToolProtocol | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim().toLowerCase();
  return normalized === "native" || normalized === "text" || normalized === "auto" ? normalized : undefined;
}

export class TextProtocolProvider implements LLMProvider {
  readonly #inner: LLMProvider;
  readonly #configured: ToolProtocol;
  readonly #threshold: number;
  readonly #onSwitch?: TextProtocolOptions["onProtocolSwitch"];
  #mode: "native" | "text";
  #consecutiveBad = 0;
  #callSeq = 0;

  constructor(inner: LLMProvider, options: TextProtocolOptions = {}) {
    this.#inner = inner;
    this.#configured = options.protocol ?? "auto";
    this.#threshold = Math.max(1, options.switchThreshold ?? DEFAULT_SWITCH_THRESHOLD);
    this.#onSwitch = options.onProtocolSwitch;
    this.#mode = this.#configured === "text" ? "text" : "native";
  }

  /** Keep the inner provider's identity: events and registries key off it. */
  get name(): string {
    return this.#inner.name;
  }

  get model(): string | undefined {
    const candidate = this.#inner as { model?: unknown };
    return typeof candidate.model === "string" ? candidate.model : undefined;
  }

  /** The protocol the user configured for this provider. */
  get configuredProtocol(): ToolProtocol {
    return this.#configured;
  }

  /** The protocol currently on the wire (`auto` reports where it landed). */
  get activeProtocol(): "native" | "text" {
    return this.#mode;
  }

  /** True once `auto` has switched this instance to text. */
  get switchedToText(): boolean {
    return this.#configured === "auto" && this.#mode === "text";
  }

  async chat(messages: Message[], tools?: ToolDefinition[], options: ChatOptions = {}): Promise<ChatResponse> {
    if (this.#mode === "text") return this.#chatText(messages, tools, options);
    if (this.#configured === "native") return this.#inner.chat(messages, tools, options);

    // auto, still native
    let response: ChatResponse;
    try {
      response = await this.#inner.chat(messages, tools, options);
    } catch (error) {
      if (error instanceof LLMFormatError) return this.#onUnusable(messages, tools, options, error.message, error);
      throw error;
    }
    const bad = unusableNativeSignal(response);
    if (!bad) {
      this.#consecutiveBad = 0;
      return response;
    }
    return this.#onUnusable(messages, tools, options, bad);
  }

  async *stream(messages: Message[], tools?: ToolDefinition[], options: ChatOptions = {}): AsyncIterable<StreamChunk> {
    if (this.#mode === "text") {
      // The agent loop is non-streaming today; for completeness a text-mode
      // stream degrades to one synthesized chunk from `chat`.
      const response = await this.chat(messages, tools, options);
      const content = messageText(response.message);
      if (content) yield { type: "delta", content };
      yield { type: "finish", finish_reason: response.finish_reason ?? "stop" };
      return;
    }
    yield* this.#inner.stream(messages, tools, options);
    // A native stream that completes cleanly counts as usable.
    if (this.#configured === "auto") this.#consecutiveBad = 0;
  }

  /**
   * One unusable native response in `auto` mode. Below the threshold the
   * failure surfaces to the loop (so its error accounting sees the same
   * signal as before); at the threshold this instance switches to text and
   * the *current* request is retried in text mode instead of dying.
   */
  async #onUnusable(
    messages: Message[],
    tools: ToolDefinition[] | undefined,
    options: ChatOptions,
    reason: string,
    originalError?: unknown,
  ): Promise<ChatResponse> {
    this.#consecutiveBad += 1;
    if (this.#consecutiveBad < this.#threshold) {
      throw originalError instanceof LLMFormatError
        ? originalError
        : new LLMFormatError(`unusable native tool-calling response: ${reason}`);
    }
    this.#mode = "text";
    const failures = this.#consecutiveBad;
    this.#consecutiveBad = 0;
    if (this.#onSwitch) {
      try {
        await this.#onSwitch({ from: "native", to: "text", reason, failures });
      } catch {
        // A broken event sink must never fail the request it describes.
      }
    }
    return this.#chatText(messages, tools, options);
  }

  async #chatText(messages: Message[], tools?: ToolDefinition[], options: ChatOptions = {}): Promise<ChatResponse> {
    const converted = toTextMessages(messages, tools);
    if (!tools?.length) {
      // No tools this turn: nothing to parse, just speak the converted history.
      return this.#inner.chat(converted, undefined, options);
    }
    let attemptMessages = converted;
    for (let repair = 0; repair <= 1; repair++) {
      const response = await this.#inner.chat(attemptMessages, undefined, options);
      const parsed = parseTextToolCalls(messageText(response.message), tools);
      if (!parsed.malformed) {
        return {
          ...response,
          message: {
            ...response.message,
            role: "assistant",
            content: parsed.textBefore,
            ...(parsed.calls.length
              ? {
                  tool_calls: parsed.calls.map((call): ToolCall => ({
                    id: `text-call-${++this.#callSeq}`,
                    type: "function",
                    function: { name: call.name, arguments: JSON.stringify(call.args) },
                  })),
                }
              : {}),
          },
        };
      }
      if (repair === 1) {
        // Repair failed too: hand the loop the plain text; its
        // invalid-action directive is the final, visible fallback.
        return { ...response, message: { ...response.message, role: "assistant", tool_calls: undefined } };
      }
      attemptMessages = [
        ...converted,
        { role: "assistant", content: messageText(response.message) },
        { role: "user", content: repairInstruction(parsed.malformed, tools) },
      ];
    }
    throw new LLMFormatError("text protocol repair loop exited unexpectedly");
  }
}

/** Detect native responses the agent loop cannot use, per the auto-switch contract. */
function unusableNativeSignal(response: ChatResponse): string | undefined {
  const calls = response.message.tool_calls ?? [];
  if (calls.length === 0) {
    return messageText(response.message).trim() === "" ? "empty response (no content, no tool calls)" : undefined;
  }
  for (const call of calls) {
    try {
      JSON.parse(call.function.arguments || "{}");
    } catch {
      return `tool call ${call.function.name} has malformed JSON arguments`;
    }
  }
  return undefined;
}

export function messageText(message: Message): string {
  if (typeof message.content === "string") return message.content;
  return message.content.filter((block) => block.type === "text").map((block) => block.text).join("");
}

/* ------------------------------------------------------------------ */
/* Outbound conversion                                                 */
/* ------------------------------------------------------------------ */

export function toTextMessages(messages: Message[], tools?: ToolDefinition[]): Message[] {
  const toolNames = new Map<string, string>();
  for (const message of messages) {
    for (const call of message.tool_calls ?? []) toolNames.set(call.id, call.function.name);
  }
  const converted: Message[] = messages.map((message): Message => {
    if (message.role === "tool") {
      const name = message.name ?? toolNames.get(message.tool_call_id ?? "") ?? "tool";
      return { role: "user", content: `<tool_result name="${name}">${messageText(message)}</tool_result>` };
    }
    if (message.role === "assistant" && (message.tool_calls?.length ?? 0) > 0) {
      const parts: string[] = [];
      const text = messageText(message);
      if (text.trim()) parts.push(text);
      for (const call of message.tool_calls ?? []) parts.push(renderToolCall(call));
      return { role: "assistant", content: parts.join("\n") };
    }
    return message;
  });
  if (tools?.length) {
    const block = protocolBlock(tools);
    const systemIndex = converted.findIndex((message) => message.role === "system");
    if (systemIndex >= 0) {
      const system = converted[systemIndex]!;
      converted[systemIndex] = { ...system, content: `${messageText(system)}\n\n${block}` };
    } else {
      converted.unshift({ role: "system", content: block });
    }
  }
  return converted;
}

function renderToolCall(call: ToolCall): string {
  let args: Record<string, unknown> = {};
  try {
    const parsed = JSON.parse(call.function.arguments || "{}") as unknown;
    if (typeof parsed === "object" && parsed !== null) args = parsed as Record<string, unknown>;
  } catch {
    /* render what we have below as raw text */
  }
  const params = Object.entries(args)
    .map(([key, value]) => `<${key}>${typeof value === "string" ? value : JSON.stringify(value)}</${key}>`)
    .join("");
  return `<tool_call name="${call.function.name}">${params}</tool_call>`;
}

export function protocolBlock(tools: ToolDefinition[]): string {
  const lines: string[] = [
    "TOOL PROTOCOL — this session has no native function calling; call tools by emitting text blocks.",
    "To call a tool, reply with exactly one block in this shape and nothing after it:",
    "",
    '<tool_call name="TOOL_NAME">',
    "<param_name>value</param_name>",
    "</tool_call>",
    "",
    "Rules:",
    "- One tool call per message. Do not wrap the block in code fences or add commentary after it.",
    "- String parameters go between the tags as plain text. For long content (file bodies, HTML) wrap it in CDATA: <content><![CDATA[...]]></content>.",
    '- Parameters whose schema type is array or object must contain raw JSON, e.g. <items>["a","b"]</items>. Numbers and booleans are plain text, e.g. <depth>2</depth>.',
    "- Tool results come back inside <tool_result name=\"...\">...</tool_result>.",
    "- If you need no tool, reply with plain text only (no <tool_call> block): that text is your final answer.",
    ...(tools.some((tool) => tool.function.name === "edit_search_replace")
      ? ["- For edit_search_replace, put the complete SEARCH/REPLACE block text (<<<<<<< SEARCH … ======= … >>>>>>> REPLACE) inside <replacements><![CDATA[...]]></replacements>; keep the block markers byte-exact."]
      : []),
    "",
    "Available tools:",
  ];
  for (const tool of tools) {
    lines.push(`<tool name="${tool.function.name}">${tool.function.description ?? ""}`.trimEnd());
    const params = schemaProperties(tool);
    for (const [name, schema] of Object.entries(params)) {
      const required = schemaRequired(tool).includes(name) ? ", required" : "";
      const type = schemaType(schema);
      const description = typeof schema.description === "string" ? ` — ${truncateText(schema.description, 140)}` : "";
      lines.push(`- ${name} (${type}${required})${description}`);
    }
    lines.push("</tool>");
  }
  return lines.join("\n");
}

/* ------------------------------------------------------------------ */
/* Inbound parsing                                                     */
/* ------------------------------------------------------------------ */

export type ParsedTextCall = { name: string; args: Record<string, unknown> };
export type TextParseMalformed = { reason: string; snippet: string };
export type TextParseResult = {
  /** Assistant prose before the first tool block (the final answer when no calls). */
  textBefore: string;
  calls: ParsedTextCall[];
  malformed: TextParseMalformed | null;
};

const OPEN_TAG = /<tool_call\b[^>]*>/gi;
const CLOSE_TAG = /<\/tool_call\s*>/i;

export function parseTextToolCalls(text: string, tools: ToolDefinition[]): TextParseResult {
  const byName = new Map(tools.map((tool) => [tool.function.name.toLowerCase(), tool]));
  const calls: ParsedTextCall[] = [];
  let textBefore = text;
  let firstOpen = -1;

  for (const match of text.matchAll(OPEN_TAG)) {
    const openIndex = match.index ?? 0;
    if (firstOpen < 0) firstOpen = openIndex;
    const openTag = match[0];
    const bodyStart = openIndex + openTag.length;
    const rest = text.slice(bodyStart);
    const closeMatch = CLOSE_TAG.exec(rest);
    if (!closeMatch) {
      return { textBefore: text.slice(0, firstOpen).trim(), calls, malformed: { reason: "unterminated <tool_call> block (missing </tool_call>)", snippet: snippet(text.slice(openIndex)) } };
    }
    const body = rest.slice(0, closeMatch.index);

    const nameMatch = /\bname\s*=\s*(?:"([^"]+)"|'([^']+)')/i.exec(openTag);
    const name = (nameMatch?.[1] ?? nameMatch?.[2] ?? "").trim();
    if (!name) {
      return { textBefore: text.slice(0, firstOpen).trim(), calls, malformed: { reason: "<tool_call> without a name attribute", snippet: snippet(openTag + body) } };
    }
    const tool = byName.get(name.toLowerCase());
    if (!tool) {
      return {
        textBefore: text.slice(0, firstOpen).trim(),
        calls,
        malformed: { reason: `unknown tool "${name}" (valid tools: ${tools.map((t) => t.function.name).join(", ")})`, snippet: snippet(openTag + body) },
      };
    }
    const parsed = parseParams(body, tool);
    if (parsed.malformed) {
      return { textBefore: text.slice(0, firstOpen).trim(), calls, malformed: { reason: parsed.malformed, snippet: snippet(body) } };
    }
    calls.push({ name: tool.function.name, args: parsed.args });
  }

  if (firstOpen >= 0) textBefore = text.slice(0, firstOpen).trim();
  return { textBefore: calls.length ? textBefore : text, calls, malformed: null };
}

function parseParams(body: string, tool: ToolDefinition): { args: Record<string, unknown>; malformed?: string } {
  const properties = schemaProperties(tool);
  const names = Object.keys(properties);
  const args: Record<string, unknown> = {};
  if (names.length === 0) {
    const trimmed = body.trim();
    if (trimmed) {
      try {
        const parsed = JSON.parse(trimmed) as unknown;
        if (typeof parsed === "object" && parsed !== null) return { args: parsed as Record<string, unknown> };
      } catch { /* fall through to malformed */ }
      return { args, malformed: `tool ${tool.function.name} takes no parameters but the block was not empty JSON` };
    }
    return { args };
  }

  let cursor = 0;
  while (cursor < body.length) {
    const openMatch = /<([A-Za-z0-9_-]+)(\s[^>]*)?>/.exec(body.slice(cursor));
    if (!openMatch) break;
    const tag = openMatch[1]!;
    const valueStart = cursor + (openMatch.index ?? 0) + openMatch[0].length;
    if (!names.some((name) => name.toLowerCase() === tag.toLowerCase())) {
      // Unknown element (could be markup inside a free-text value the model
      // forgot to CDATA-wrap): skip just this tag and keep scanning.
      cursor = valueStart;
      continue;
    }
    const paramName = names.find((name) => name.toLowerCase() === tag.toLowerCase())!;
    const { value, end } = readParamValue(body, valueStart, paramName);
    cursor = end;
    const coerced = coerceValue(value, properties[paramName], paramName, tool.function.name);
    if (coerced.malformed) return { args, malformed: coerced.malformed };
    args[paramName] = coerced.value;
  }
  return { args };
}

/**
 * Read one parameter value starting after its opening tag. CDATA values run
 * to `]]>`; plain values run to the first matching close tag — which is why
 * the protocol steers file content into CDATA. Nested *other* tags (HTML in a
 * landing page, `<div>`, `</script>`) pass through untouched.
 */
function readParamValue(body: string, start: number, paramName: string): { value: string; end: number } {
  const rest = body.slice(start);
  const cdata = /^(\s*)<!\[CDATA\[([\s\S]*?)\]\]>/.exec(rest);
  if (cdata) {
    let end = start + cdata[0].length;
    const close = new RegExp(`^\\s*</${escapeRegExp(paramName)}\\s*>`, "i").exec(body.slice(end));
    if (close) end += close[0].length;
    return { value: cdata[2]!, end };
  }
  const closeRe = new RegExp(`</${escapeRegExp(paramName)}\\s*>`, "i");
  const closeMatch = closeRe.exec(rest);
  if (!closeMatch) return { value: rest, end: body.length };
  return { value: rest.slice(0, closeMatch.index), end: start + closeMatch.index + closeMatch[0].length };
}

function coerceValue(raw: string, schema: Record<string, unknown> | undefined, paramName: string, toolName: string): { value: unknown; malformed?: string } {
  const type = schema ? schemaType(schema) : "string";
  const trimmed = raw.trim();
  switch (type) {
    case "number":
    case "integer": {
      const value = Number(trimmed);
      return Number.isNaN(value) ? { value: undefined, malformed: `parameter <${paramName}> of ${toolName} must be a ${type}, got "${truncateText(trimmed, 60)}"` } : { value };
    }
    case "boolean": {
      if (/^(true|1|yes)$/i.test(trimmed)) return { value: true };
      if (/^(false|0|no)$/i.test(trimmed)) return { value: false };
      return { value: undefined, malformed: `parameter <${paramName}> of ${toolName} must be a boolean, got "${truncateText(trimmed, 60)}"` };
    }
    case "array":
    case "object": {
      try {
        return { value: JSON.parse(trimmed) as unknown };
      } catch {
        return { value: undefined, malformed: `parameter <${paramName}> of ${toolName} must be raw JSON (${type}), could not parse "${truncateText(trimmed, 60)}"` };
      }
    }
    default:
      return { value: maybeUnescape(raw) };
  }
}

/**
 * Models that escape markup emit &lt;div&gt; instead of raw tags. Only
 * unescape when the value has no raw tags of its own — a value containing a
 * real `<div>` was written raw and any `&lt;` inside it is literal content.
 */
function maybeUnescape(value: string): string {
  if (value.includes("<")) return value;
  if (!/&(lt|gt|amp|quot|apos);/.test(value)) return value;
  return value
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

function repairInstruction(malformed: TextParseMalformed, tools: ToolDefinition[]): string {
  const example = tools[0];
  const exampleBlock = example
    ? (() => {
        const params = Object.keys(schemaProperties(example));
        const first = params[0] ?? "value";
        return `<tool_call name="${example.function.name}">\n<${first}>...</${first}>\n</tool_call>`;
      })()
    : '<tool_call name="TOOL_NAME">\n<param>...</param>\n</tool_call>';
  return [
    `Your previous reply could not be parsed as a tool call: ${malformed.reason}.`,
    "Reply again with exactly one tool block in this shape and nothing after it:",
    "",
    exampleBlock,
    "",
    `Valid tool names: ${tools.map((tool) => tool.function.name).join(", ")}.`,
    "Wrap long file content in CDATA: <content><![CDATA[...]]></content>. If you need no tool, reply with plain text only.",
  ].join("\n");
}

/* ------------------------------------------------------------------ */
/* JSON-schema helpers                                                 */
/* ------------------------------------------------------------------ */

function schemaProperties(tool: ToolDefinition): Record<string, Record<string, unknown>> {
  const parameters = tool.function.parameters;
  if (!parameters || typeof parameters !== "object") return {};
  const properties = (parameters as { properties?: unknown }).properties;
  if (!properties || typeof properties !== "object") return {};
  const out: Record<string, Record<string, unknown>> = {};
  for (const [name, schema] of Object.entries(properties as Record<string, unknown>)) {
    out[name] = typeof schema === "object" && schema !== null ? (schema as Record<string, unknown>) : {};
  }
  return out;
}

function schemaRequired(tool: ToolDefinition): string[] {
  const parameters = tool.function.parameters;
  if (!parameters || typeof parameters !== "object") return [];
  const required = (parameters as { required?: unknown }).required;
  return Array.isArray(required) ? required.filter((entry): entry is string => typeof entry === "string") : [];
}

function schemaType(schema: Record<string, unknown>): string {
  return typeof schema.type === "string" ? schema.type : "string";
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function truncateText(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)}…`;
}

function snippet(text: string): string {
  return truncateText(text.replace(/\s+/g, " ").trim(), 200);
}
