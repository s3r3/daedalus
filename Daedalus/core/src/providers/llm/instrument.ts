import type { Event, EventType } from "../../contracts.ts";
import type { ChatOptions, ChatResponse, LLMProvider, Message, StreamChunk, ToolDefinition } from "./types.ts";

type Emitter = (type: EventType, payload: unknown) => void;

export type InstrumentedProvider = {
  provider: LLMProvider;
  /** Wraps a provider so every request emits MODEL_REQUEST_* events. */
};

export function instrumentProvider(
  provider: LLMProvider,
  emit: (event: { type: EventType; payload: unknown }) => void,
): LLMProvider {
  return {
    name: provider.name,
    async chat(messages, tools, options) {
      const started = Date.now();
      emit({ type: "MODEL_REQUEST_STARTED", payload: { provider: provider.name, messages: messages.length, tools: tools?.length ?? 0 } });
      try {
        const response = await provider.chat(messages, tools, options);
        emit({ type: "MODEL_REQUEST_FINISHED", payload: { provider: provider.name, duration_ms: Date.now() - started, usage: response.usage } });
        return response;
      } catch (error) {
        emit({ type: "MODEL_REQUEST_FAILED", payload: { provider: provider.name, duration_ms: Date.now() - started, error: String(error) } });
        throw error;
      }
    },
    stream(messages, tools, options) {
      return instrumentStream(provider, messages, tools, options, emit);
    },
  };
}

async function* instrumentStream(
  provider: LLMProvider,
  messages: Message[],
  tools: ToolDefinition[] | undefined,
  options: ChatOptions | undefined,
  emit: (event: { type: EventType; payload: unknown }) => void,
): AsyncIterable<StreamChunk> {
  const started = Date.now();
  emit({ type: "MODEL_REQUEST_STARTED", payload: { provider: provider.name, messages: messages.length, stream: true } });
  try {
    for await (const chunk of provider.stream(messages, tools, options)) yield chunk;
    emit({ type: "MODEL_REQUEST_FINISHED", payload: { provider: provider.name, duration_ms: Date.now() - started, stream: true } });
  } catch (error) {
    emit({ type: "MODEL_REQUEST_FAILED", payload: { provider: provider.name, duration_ms: Date.now() - started, error: String(error) } });
    throw error;
  }
}

export type { ChatResponse, Emitter, Event };
