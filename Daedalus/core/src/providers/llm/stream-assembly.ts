import type { ChatResponse, Message, StreamChunk, ToolCall, Usage } from "./types.ts";

type ToolCallBuffer = { id?: string; name: string; arguments: string };

/**
 * Rebuilds the turn's ChatResponse from streamed chunks. Providers
 * fragment tool calls across deltas (an index, an id, then name and
 * argument string pieces); the loop's turn machine needs the same
 * whole message `chat()` would have returned, so the fragments are
 * concatenated per index and the argument string is parsed later by
 * the usual action parser — never here. Content, reasoning text, and
 * usage ride along, so THOUGHT derivation sees the same message the
 * non-streaming path would have produced.
 */
export class StreamMessageAssembler {
  #content = "";
  #reasoning = "";
  #byIndex = new Map<number, ToolCallBuffer>();
  #anonymous: ToolCallBuffer[] = [];
  #usage: Usage | undefined;
  #finishReason: string | undefined;

  /**
   * True while nothing the turn can act on has arrived — no text, no
   * tool-call fragments (drives the loop's chat() fallback for
   * providers whose stream yields nothing usable at all).
   */
  get empty(): boolean {
    return !this.#content && this.#byIndex.size === 0 && this.#anonymous.length === 0;
  }

  /** Content text so far (what the live delta events carry). */
  get text(): string {
    return this.#content;
  }

  push(chunk: StreamChunk): void {
    if (chunk.type === "usage") {
      this.#usage = chunk.usage;
      return;
    }
    if (chunk.type === "finish") {
      this.#finishReason = chunk.finish_reason;
      return;
    }
    this.#content += chunk.content;
    if (chunk.reasoning) this.#reasoning += chunk.reasoning;
    for (const partial of chunk.tool_calls ?? []) this.#pushToolCall(partial);
  }

  #pushToolCall(partial: Partial<ToolCall>): void {
    const loose = partial as { index?: number; name?: string; arguments?: string; function?: { name?: string; arguments?: string } };
    let buffer: ToolCallBuffer;
    if (typeof loose.index === "number") {
      buffer = this.#byIndex.get(loose.index) ?? { name: "", arguments: "" };
      this.#byIndex.set(loose.index, buffer);
    } else {
      // No index: the provider sends one whole call per chunk.
      buffer = { name: "", arguments: "" };
      this.#anonymous.push(buffer);
    }
    if (partial.id) buffer.id = partial.id;
    if (loose.function?.name) buffer.name += loose.function.name;
    if (loose.function?.arguments) buffer.arguments += loose.function.arguments;
    if (!loose.function && loose.name) buffer.name += loose.name;
    if (!loose.function && loose.arguments) buffer.arguments += loose.arguments;
  }

  toResponse(): ChatResponse {
    const ordered = [...this.#byIndex.entries()].sort((a, b) => a[0] - b[0]).map(([, buffer]) => buffer);
    const buffers = [...ordered, ...this.#anonymous].filter((buffer) => buffer.name || buffer.arguments || buffer.id);
    const toolCalls: ToolCall[] | undefined = buffers.length
      ? buffers.map((buffer, i) => ({
          id: buffer.id ?? `stream-call-${i + 1}`,
          type: "function" as const,
          function: { name: buffer.name, arguments: buffer.arguments || "{}" },
        }))
      : undefined;
    const message: Message = {
      role: "assistant",
      content: this.#content,
      ...(toolCalls ? { tool_calls: toolCalls } : {}),
      ...(this.#reasoning ? { reasoning_content: this.#reasoning } : {}),
    };
    return {
      message,
      ...(this.#usage ? { usage: this.#usage } : {}),
      ...(this.#finishReason ? { finish_reason: this.#finishReason } : {}),
    };
  }
}
