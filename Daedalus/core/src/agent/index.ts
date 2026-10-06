export { AgentLoop, parseAction, thoughtFromMessage, type AgentLoopOptions } from './agent-loop.ts';
export { interpretTask } from './interpreter.ts';
export { createPlan, replan } from './planner.ts';
export {
  DefaultContextManager,
  CONDENSED_TOOL_OUTPUT,
  condenseToolOutputs,
  contextMeter,
  estimateMessageTokens,
  truncate,
  type ContextManagerOptions,
} from './context.ts';
export {
  LoopGuard,
  LOOP_WINDOW_SIZE,
  REPEAT_SUPPRESSED_OUTPUT,
  explorationKey,
  explorationSuppressedNote,
  loopGuidanceNote,
  normalizeExplorationPath,
  skillAlreadyLoadedNote,
  stableSerialize,
  toolCallSignature,
  type LoopGuardDecision,
  type LoopGuardObservation,
  type LoopRepeatKind,
} from './loop-guard.ts';
export { GLOBAL_RULES_LABEL, loadProjectRules, MAX_RULES_CHARS, PROJECT_RULES_FILES, type ProjectRules, type ProjectRulesOptions } from './rules.ts';
export {
  HOOKS_CONFIG_RELATIVE_PATH,
  hookMatches,
  hookNoteLine,
  loadHooksConfig,
  runPostToolHooks,
  runPreToolHooks,
  type HookExecution,
  type HookPhase,
  type HookRule,
  type HooksConfig,
  type LoadHooksResult,
  type PostToolHookOutcome,
  type PreToolHookOutcome,
} from './hooks.ts';
export {
  MAX_REVIEW_DIFF_CHARS,
  REVIEW_READ_ONLY_TOOLS,
  buildReviewMessages,
  parseReviewFindings,
  reviewDiff,
  unstagedDiff,
  type ReviewFinding,
  type ReviewResult,
} from './review.ts';
export {
  CONVERSATIONAL_SYSTEM_PROMPT,
  QUESTION_SYSTEM_PROMPT,
  answerConversational,
  answerQuestion,
  classifyChatIntent,
  conversationalFallbackReply,
  gatherWorkspaceContext,
  questionFallbackReply,
  type AnswerQuestionOptions,
  type ChatIntent,
} from './conversation.ts';
export { handleObservation } from './observation.ts';
export { evaluateStopConditions, noProgressCondition } from './stop.ts';
export type {
  Action,
  CompleteAction,
  ContextManager,
  Observation,
  ObservationHandler,
  Planner,
  ReplanAction,
  StopAction,
  StopCondition,
  StopPolicy,
  StopReason,
  TaskInterpreter,
  ToolAction,
  ToolExecutor,
} from './types.ts';
