import type { LLMProvider } from "./types.ts";

const providers = new Map<string, LLMProvider>();

export function registerProvider(provider: LLMProvider): void {
  providers.set(provider.name, provider);
}

export function getProvider(name: string): LLMProvider {
  const provider = providers.get(name);
  if (!provider) throw new Error(`unknown LLM provider: ${name}`);
  return provider;
}

export function clearProviders(): void {
  providers.clear();
}

export { type ChatOptions, type ChatResponse, type ContentBlock, type ImageContent, type LLMProvider, type Message, type ModelPhase, type Role, type StreamChunk, type TextContent, type ToolCall, type ToolDefinition, type Usage } from "./types.ts";
export { LLMAuthError, LLMContentPolicyError, LLMError, LLMFormatError, LLMRateLimitError, LLMTimeoutError, classifyLLMError, classifyProviderError, hasUpstreamFailureMarker, isFatalLLMError, isToolSchemaInvalidError, isTransientLLMError, type LLMErrorKind } from "./errors.ts";
export { OpenAICompatProvider, DEFAULT_LLM_TIMEOUT_MS, type OpenAICompatOptions } from "./openai-compat.ts";
export { normalizeToolParameters, normalizeToolSchemas } from "./schema-normalize.ts";
export {
  ModelPoolProvider,
  DEFAULT_MODEL_COOLDOWN_MS,
  asModelController,
  isModelPoolRetryableError,
  modelPoolFailureReason,
  normalizeModelList,
  normalizeModelTiers,
  parseModelStrategy,
  parseModelTiers,
  strongestModelFor,
  tierRankForPhase,
  type ModelController,
  type ModelPoolOptions,
  type ModelPoolSwitch,
  type ModelStrategy,
} from "./model-pool.ts";
export {
  TextProtocolProvider,
  normalizeToolProtocol,
  parseTextToolCalls,
  parseToolProtocol,
  protocolBlock,
  toTextMessages,
  type ProtocolSwitchInfo,
  type TextParseResult,
  type TextProtocolOptions,
  type ToolProtocol,
} from "./text-protocol.ts";
