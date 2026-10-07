export type TaskSpec = { id: string; goal: string; repo_path: string; constraints: string[]; done_criteria: string[]; created_at: string; mode?: AgentMode; parent_task_id?: string; attachments?: Attachment[]; provider_id?: string; model?: string; models?: string[]; model_strategy?: ModelStrategy; thinking?: boolean; title?: string; rules_files?: string[]; agent?: string; /** Chat conversation this task belongs to (Web chat sessions); turns are recorded server-side. */ conversation_id?: string };
export type PlanStepStatus = 'pending' | 'active' | 'done' | 'skipped';
export type PlanStep = { id: string; intent: string; status: PlanStepStatus; evidence: string[] };
export type Plan = { id: string; task_id: string; steps: PlanStep[]; version: number; status: 'draft' | 'active' | 'complete' };
export type ToolCall = { id: string; task_id: string; turn_id: string; tool: string; args: unknown; approved_by?: string; started_at: string };
export type ToolResultStatus = 'ok' | 'error' | 'denied' | 'timeout';
export type ToolResult = { call_id: string; status: ToolResultStatus; output: string; truncated: boolean; meta: Record<string, unknown> };
export type ValidationCheck = { name: string; cmd: string; status: 'pass' | 'fail' | 'error' | 'skipped'; exit_code: number | null; summary: string; diagnostics: Array<{ file?: string; line?: number; message: string }>; source?: 'profile' | 'default'; required?: boolean };
export type ValidationResult = { checks: ValidationCheck[]; source?: 'profile' | 'default'; warning?: string; note?: string };
export type RecoveryAction = { reason: string; strategy: 'retry' | 'fix' | 'replan' | 'abort'; attempt: number; limits: Record<string, number> };
export type FinalReport = { task_id: string; outcome: 'success' | 'partial' | 'failed'; diff: string; evidence: string[]; metrics: Record<string, number>; title?: string; rules_files?: string[]; validation_source?: 'profile' | 'default'; worktree?: WorktreeReport; review?: ReviewGateReport };
/** Strong-model review gate verdict recorded on the final report (tailor suite). */
export type ReviewGateReport = {
  model: string;
  author_model?: string;
  blocking: boolean;
  findings: Array<{ severity: 'high' | 'medium' | 'low'; file: string; line?: number; message: string }>;
};
export type TaskState = TaskSpec & { plan: Plan; steps: PlanStep[]; status: 'pending' | 'active' | 'done' | 'failed'; current_step_id?: string; last_observation?: string; last_error?: string; last_tool_call_id?: string; tool_result?: ToolResult; mode?: AgentMode; turns?: number };
export const EVENT_TYPES = ['TASK_STARTED','PLAN_CREATED','THOUGHT','LOOP_WARNING','TOOL_CALL_STARTED','TOOL_CALL_FINISHED','FILE_CHANGED','COMMAND_STARTED','COMMAND_OUTPUT','COMMAND_FINISHED','JOB_STARTED','JOB_FINISHED','VALIDATION_STARTED','VALIDATION_FAILED','VALIDATION_PASSED','RECOVERY_STARTED','REPLAN_CREATED','TASK_COMPLETED','MODEL_REQUEST_STARTED','MODEL_REQUEST_FINISHED','MODEL_REQUEST_FAILED','APPROVAL_REQUESTED','APPROVAL_DECIDED','QUESTION_REQUESTED','QUESTION_ANSWERED','MODE_CHANGED','SLASH_COMMAND_EXECUTED','PROVIDER_CHANGED','REVIEW_COMPLETED','ATTACHMENT_ADDED','CHILD_TASK_STARTED','CHILD_TASK_FINISHED','ORCHESTRATION_SKIPPED','HOOK_EXECUTED','SKILL_LOADED'] as const;
export type EventType = (typeof EVENT_TYPES)[number];
export type Event = { seq: number; task_id: string; turn_id?: string; type: EventType; payload: unknown; ts: string };

export type AgentMode = 'ask' | 'manual' | 'auto' | 'plan' | 'orchestrator';
export type ModelStrategy = 'failover' | 'round-robin';
/**
 * Capability tier of one model in a pool (tailor suite): the harness routes
 * cheap phases to `fast`/`balanced` models and spends `strong` models on
 * editing and repair turns. Unset models behave exactly as before (the
 * router treats them as balanced for ordering).
 */
export type ModelTier = 'strong' | 'balanced' | 'fast';
/** Model families the prompt dialect layer knows framing conventions for. */
export type PromptFamily = 'claude' | 'gpt' | 'qwen' | 'llama' | 'gemini' | 'generic';
/** Provider setting: an explicit family, or `auto` = detect from the model id. */
export type PromptFamilySetting = PromptFamily | 'auto';
/**
 * Edit dialect for a provider's models (tailor suite): `native` keeps the
 * function-call edit tools; `search_replace` adds the Aider-style
 * SEARCH/REPLACE block tool (`edit_search_replace`) to the visible tools.
 */
export type EditFormat = 'native' | 'search_replace';
/**
 * How tool calls are put on the wire: `native` function calling, the XML-ish
 * `text` protocol (Cline-style fallback for models that stall on native tool
 * definitions), or `auto` (start native, switch this provider to text after
 * repeated unusable native responses).
 */
export type ToolProtocol = 'native' | 'text' | 'auto';
export const AGENT_MODES: AgentMode[] = ['ask', 'manual', 'auto', 'plan', 'orchestrator'];

export type ToolVisibility = 'read' | 'mutating' | 'executing' | 'none';
export type ToolModePolicy = { visible: boolean; approval: 'auto' | 'ask' | 'deny' };

export type SlashCommand = {
  name: string;
  description: string;
  usage: string;
  aliases?: string[];
  args?: string;
  mutating?: boolean;
};

export type ProviderConfig = {
  id: string;
  name: string;
  baseUrl: string;
  apiKey?: string;
  apiKeyMasked?: string;
  models: string[];
  defaultModel?: string;
  enabled: boolean;
  supportsVision?: boolean;
  visionModels?: string[];
  /** Tool wire protocol for this provider's models; unset = settings/env default (`auto`). */
  toolProtocol?: ToolProtocol;
  /** Capability tier per model id (tailor suite routing); unset models are treated as balanced. */
  modelTiers?: Record<string, ModelTier>;
  /** Prompt dialect family for this provider's models; unset/`auto` = detect from the model id. */
  promptFamily?: PromptFamilySetting;
  /** Edit dialect for this provider's models; unset = `native`. */
  editFormat?: EditFormat;
};

export type ProviderConfigPublic = Omit<ProviderConfig, 'apiKey'> & { hasApiKey: boolean };

export type AttachmentKind = 'file' | 'folder' | 'image' | 'zip';
export type Attachment = {
  id: string;
  taskId?: string;
  workspacePath: string;
  name: string;
  kind: AttachmentKind;
  mimeType?: string;
  size: number;
  sha256?: string;
  createdAt: string;
  path?: string;
};

export type ChildTaskBudget = { max_iterations: number; max_errors: number };
/** Why a child ended without completing: budget exhaustion is a typed partial result for the parent, never a silent success. */
export type ChildTaskErrorReason = 'budget_exceeded' | 'no_progress' | 'child_failed' | 'cancelled';
export type ChildTask = {
  id: string;
  parent_task_id: string;
  goal: string;
  /** Short human label for the delegation (the spawn call's description); UIs show it over the full brief. */
  label?: string;
  mode?: AgentMode;
  status: 'pending' | 'running' | 'done' | 'failed' | 'cancelled';
  budget?: ChildTaskBudget;
  /** Iterations the child actually consumed from the shared pool (set when it finishes). */
  iterations_used?: number;
  /** Provider-reported token usage of the child's own run, rolled up for the parent's accounting. Token fields are absent when the provider reported no usage. */
  usage?: { requests: number; reported: number; input_tokens?: number; output_tokens?: number; total_tokens?: number };
  result_summary?: string;
  error_reason?: ChildTaskErrorReason;
  created_at: string;
  /** Name of a file-defined subagent (.daedalus/agents/<name>.md) running this child. */
  agent?: string;
  /** Run this child in an isolated git worktree instead of the shared workspace. */
  isolation?: 'worktree';
};

/** Where an isolated (worktree) task ran and what it changed, kept after the run. */
export type WorktreeReport = { path: string; branch: string; files_changed: string[] };

