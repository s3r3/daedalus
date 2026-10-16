/**
 * Dae Captain workflow layer (PR1): router + run context + artifact
 * translators. Orchestration only — no engine classes are referenced here;
 * the server invokes existing boundaries (POST /tasks internals,
 * /research/plan) for dispatch.
 */
export type {
  ArtifactKind,
  ArtifactRef,
  RunContext,
  RunTurn,
  RunTurnStatus,
  WorkflowEngine,
} from "./types.ts";
export { WORKFLOW_ENGINES, isWorkflowEngine } from "./types.ts";
export type { RuleRouteResult, RouteOptions, LayerBResult } from "./router.ts";
export {
  RULE_CONFIDENCE_THRESHOLD,
  isConversationalMessage,
  routeByRules,
  resolveReferences,
  formatResolvedForGoal,
  buildLayerBPrompt,
  parseLayerBResponse,
} from "./router.ts";
export { WorkflowRunStore, createWorkflowRun, appendTurn, updateTurn, lastTurn } from "./store.ts";
export type {
  TimelineEvent,
  AnyTimelineEvent,
  TimelineEventType,
  TimelineEventPayload,
  FileAction,
  VerifyResult,
  TimelineApprovalDecision,
  ModelContext,
} from "./timeline.ts";
export {
  TIMELINE_EVENT_TYPES,
  MODEL_CONTEXT_RECENT_DEFAULT,
  isTimelineEventType,
  isTimelineEvent,
  createEvent,
  appendEvent,
  getEvents,
  getRecentEvents,
  buildModelContext,
  persist as persistTimeline,
  load as loadTimeline,
  syncTurns,
} from "./timeline.ts";
export type { EngineCompletionInput } from "./artifacts.ts";
export { translateArtifacts } from "./artifacts.ts";
// Verify gate framework (v2, Fase 2): deterministic code-checked verify per
// engine. Note: `VerifyCheckResult` is the check outcome object; timeline's
// `VerifyResult` ("ok"|"fail" event payload union) keeps its name.
export type {
  VerifyCheck,
  VerifyCheckResult,
  VerifyFailure,
  VerifyGateResult,
  VerifyContext,
  CodingVerifyData,
  SlideVerifyData,
  DokumenVerifyData,
  SpreadsheetVerifyData,
  ResearchVerifyData,
  VerifyRunOptions,
  RetryableTask,
  RetryReport,
  CompositePart,
} from "./verify.ts";
export {
  VerifyGate,
  runWithRetry,
  failureSignature,
  verifyComposite,
  emitCompositeVerify,
} from "./verify.ts";
export {
  createDefaultVerifyGate,
  codingChecks,
  slideChecks,
  dokumenChecks,
  spreadsheetChecks,
  researchChecks,
} from "./verify-checks.ts";
// Continuation (v2, Fase 3A): classify new messages vs the run timeline,
// resolve "itu"/"tadi"/"slide 3" referents. Never blocks on ambiguity.
export type {
  ContinuationKind,
  TaskEntry,
  ReferentCandidate,
  ReferentResolution,
  ResumeTarget,
} from "./continuation.ts";
export {
  INTERRUPT_RE,
  RESUME_RE,
  REFERENCE_RE,
  AMBIGUITY_MARGIN,
  getTaskEntries,
  tokenize,
  classify,
  scoreReferents,
  resolveResumeTarget,
  resolveReferents,
} from "./continuation.ts";
// Decomposition (v2, Fase 3B): multi-engine task plans + parallel execution.
export type {
  SubTask,
  TaskPlan,
  SubTaskExecution,
  SubTaskExecutor,
  SubTaskResult,
  PlanProgress,
  PlanExecutionOptions,
  PlanExecution,
} from "./decompose.ts";
export {
  MAX_PARALLEL,
  splitGoalFragments,
  planTask,
  getPlanProgress,
  executePlan,
} from "./decompose.ts";
// Unified approval (v2, Fase 3C): destructive=ask, reversible=auto+Undo,
// explicit=button. Timeline-backed request/grant/deny + bounded UndoStore.
export type {
  ActionKind,
  ApprovalTreatment,
  ApprovalPolicy,
  Action,
  ActionClassification,
  PendingApproval,
  UndoSnapshot,
  UndoEntry,
  UndoData,
  UndoStoreOptions,
} from "./approval.ts";
export {
  DEFAULT_APPROVAL_POLICY,
  STRICT_APPROVAL_POLICY,
  MAX_UNDO_SNAPSHOT_BYTES,
  classifyAction,
  requestApproval,
  grantApproval,
  denyApproval,
  getPendingApproval,
  listPendingApprovals,
  clearPendingApprovals,
  UndoStore,
  recordUndo,
} from "./approval.ts";
// Long-term memory (v2, Fase 4A): per-user preferences, facts, correction
// patterns. Privacy: sensitive keys (password/token/secret/api_key/
// credential) are rejected with a clear error — never persisted.
export type {
  CorrectionPattern,
  UserMemoryData,
  CorrectionInput,
} from "./memory.ts";
export { SENSITIVE_KEY_PATTERNS, UserMemory } from "./memory.ts";
// Reminders & scheduler (v2, Fase 4B): schedule/cancel/list/due reminders,
// deterministic Indonesian request parsing, and an in-process scheduler.
// Delivery to pill/chat UI is a later phase; this module exposes the
// `onDue` callback and timeline event helpers (`agent` events with a
// `kind` marker — the 8-type schema is unchanged).
export type {
  RepeatKind,
  Reminder,
  ReminderInput,
  ParsedReminderRequest,
  SchedulerOptions,
  ReminderScheduler,
} from "./reminder.ts";
export {
  REPEAT_INTERVAL_MS,
  isRepeatKind,
  ReminderStore,
  parseReminderRequest,
  startScheduler,
  emitReminderCreated,
  emitReminderDue,
} from "./reminder.ts";
