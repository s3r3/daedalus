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
