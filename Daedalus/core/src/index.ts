/**
 * Daedalus Core — public API.
 *
 * Phase 1 exposes foundation primitives only: shared contracts, the in-process
 * event bus, structured logging, typed settings, and per-task persistence.
 * Agent/tool/LLM logic is intentionally absent (PLAN.md Phase 1 scope).
 *
 * Contracts:  TaskSpec, Plan, PlanStep, ToolCall, ToolResult, Event,
 *             ValidationResult, RecoveryAction, FinalReport, EVENT_TYPES
 * Runtime:    EventBus, TaskStore, createLogger, loadSettings, redactSettings
 */
export {
  EVENT_TYPES,
  type Event,
  type EventType,
  type FinalReport,
  type Plan,
  type PlanStep,
  type PlanStepStatus,
  type RecoveryAction,
  type TaskSpec,
  type ToolCall,
  type ToolResult,
  type ToolResultStatus,
  type ValidationCheck,
  type ValidationResult,
} from "./contracts.ts";

export { EventBus, emitEvent, type EventHandler, type EventTarget } from "./events.ts";

export {
  createLogger,
  type LogLevel,
  type Logger,
} from "./logger.ts";

export {
  loadSettings,
  redactSettings,
  type Env,
  type Settings,
} from "./settings.ts";

export { TaskStore } from "./persistence.ts";

export {
  ansiPalette,
  bold,
  dim,
  fg,
  getPalette,
  palette,
  paletteLight,
  rgb,
  supportsColor,
  type PaletteName,
} from "./theme.ts";

export {
  EXIT_CODES,
  TaskRunner,
  exitCodeFor,
  type RunOptions,
  type RunOutcome,
  type RunResult,
  type TaskRunnerOptions,
} from "./runtime.ts";

export {
  CommandValidator,
  aggregateValidation,
  completionGate,
  decideRecovery,
  discoverChecks,
  normalizeError,
  type NormalizedError,
  type RecoveryContext,
  type RecoveryPolicy,
  type ValidationCommand,
  type Validator,
  type ValidatorOptions,
  validationFailed,
  validationPassed,
} from "./validation/index.ts";

export {
  ApprovalBroker,
  ExecutionHarness,
  DEFAULT_HARNESS_CONFIG,
  type ApprovalCallback,
  type ApprovalDecision,
  type ApprovalPolicy,
  type ApprovalResult,
  type HarnessConfig,
  type HarnessContext,
  type HarnessEvent,
  type PermissionKey,
  type ResourceUsage,
} from "./execution/index.ts";

export {
  DEFAULT_TOOLS,
  ToolRegistry,
  createDefaultRegistry,
  changedLineCounts,
  diffLines,
  editFileTool,
  globTool,
  grepTool,
  listDirTool,
  pathInWorkspace,
  readFileTool,
  renderPatch,
  runCommandTool,
  writeFileTool,
  type DiffLine,
  type ModelToolSchema,
  type ToolDefinition,
  type ToolExecutionContext,
} from "./tools/index.ts";

export {
  AgentLoop,
  DefaultContextManager,
  createPlan,
  evaluateStopConditions,
  handleObservation,
  interpretTask,
  noProgressCondition,
  parseAction,
  replan,
  truncate,
  type Action,
  type AgentLoopOptions,
  type CompleteAction,
  type ContextManager,
  type Observation,
  type ObservationHandler,
  type Planner,
  type ReplanAction,
  type StopAction,
  type StopCondition,
  type StopPolicy,
  type StopReason,
  type TaskInterpreter,
  type ToolAction,
  type ToolExecutor,
} from "./agent/index.ts";

export {
  DEFAULT_RETRY_POLICY,
  LLMAuthError,
  LLMContentPolicyError,
  LLMError,
  LLMFormatError,
  LLMRateLimitError,
  LLMTimeoutError,
  OpenAICompatProvider,
  buildPrompt,
  classifyProviderError,
  clearProviders,
  createProviderFromSettings,
  defaultTemplate,
  estimateTokens,
  getProvider,
  instrumentProvider,
  isRetryable,
  registerProvider,
  systemMessage,
  userMessage,
  withRetry,
  type ChatOptions,
  type ChatResponse,
  type ContentBlock,
  type ImageContent,
  type LLMProvider,
  type Message,
  type OpenAICompatOptions,
  type PromptSection,
  type PromptTemplate,
  type RetryPolicy,
  type Role,
  type StreamChunk,
  type TextContent,
  type ToolDefinition as LLMToolDefinition,
} from "./providers/index.ts";

export { VERSION } from "./version.ts";
