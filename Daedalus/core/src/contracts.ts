export type TaskSpec = { id: string; goal: string; repo_path: string; constraints: string[]; done_criteria: string[]; created_at: string; mode?: AgentMode; parent_task_id?: string; attachments?: Attachment[]; provider_id?: string; model?: string; models?: string[]; model_strategy?: ModelStrategy; thinking?: boolean; title?: string; rules_files?: string[]; agent?: string };
export type PlanStepStatus = 'pending' | 'active' | 'done' | 'skipped';
export type PlanStep = { id: string; intent: string; status: PlanStepStatus; evidence: string[] };
export type Plan = { id: string; task_id: string; steps: PlanStep[]; version: number; status: 'draft' | 'active' | 'complete' };
export type ToolCall = { id: string; task_id: string; turn_id: string; tool: string; args: unknown; approved_by?: string; started_at: string };
export type ToolResultStatus = 'ok' | 'error' | 'denied' | 'timeout';
export type ToolResult = { call_id: string; status: ToolResultStatus; output: string; truncated: boolean; meta: Record<string, unknown> };
export type ValidationCheck = { name: string; cmd: string; status: 'pass' | 'fail' | 'error' | 'skipped'; exit_code: number | null; summary: string; diagnostics: Array<{ file?: string; line?: number; message: string }>; source?: 'profile' | 'default'; required?: boolean };
export type ValidationResult = { checks: ValidationCheck[]; source?: 'profile' | 'default'; warning?: string };
export type RecoveryAction = { reason: string; strategy: 'retry' | 'fix' | 'replan' | 'abort'; attempt: number; limits: Record<string, number> };
export type FinalReport = { task_id: string; outcome: 'success' | 'partial' | 'failed'; diff: string; evidence: string[]; metrics: Record<string, number>; title?: string; rules_files?: string[]; validation_source?: 'profile' | 'default'; worktree?: WorktreeReport };
export type TaskState = TaskSpec & { plan: Plan; steps: PlanStep[]; status: 'pending' | 'active' | 'done' | 'failed'; current_step_id?: string; last_observation?: string; last_error?: string; last_tool_call_id?: string; tool_result?: ToolResult; mode?: AgentMode; turns?: number };
export const EVENT_TYPES = ['TASK_STARTED','PLAN_CREATED','THOUGHT','LOOP_WARNING','TOOL_CALL_STARTED','TOOL_CALL_FINISHED','FILE_CHANGED','COMMAND_STARTED','COMMAND_OUTPUT','COMMAND_FINISHED','VALIDATION_STARTED','VALIDATION_FAILED','VALIDATION_PASSED','RECOVERY_STARTED','REPLAN_CREATED','TASK_COMPLETED','MODEL_REQUEST_STARTED','MODEL_REQUEST_FINISHED','MODEL_REQUEST_FAILED','APPROVAL_REQUESTED','APPROVAL_DECIDED','MODE_CHANGED','SLASH_COMMAND_EXECUTED','PROVIDER_CHANGED','ATTACHMENT_ADDED','CHILD_TASK_STARTED','CHILD_TASK_FINISHED','HOOK_EXECUTED'] as const;
export type EventType = (typeof EVENT_TYPES)[number];
export type Event = { seq: number; task_id: string; turn_id?: string; type: EventType; payload: unknown; ts: string };

export type AgentMode = 'ask' | 'manual' | 'auto' | 'plan' | 'orchestrator';
export type ModelStrategy = 'failover' | 'round-robin';
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
export type ChildTask = {
  id: string;
  parent_task_id: string;
  goal: string;
  mode?: AgentMode;
  status: 'pending' | 'running' | 'done' | 'failed' | 'cancelled';
  budget?: ChildTaskBudget;
  result_summary?: string;
  created_at: string;
  /** Name of a file-defined subagent (.daedalus/agents/<name>.md) running this child. */
  agent?: string;
  /** Run this child in an isolated git worktree instead of the shared workspace. */
  isolation?: 'worktree';
};

/** Where an isolated (worktree) task ran and what it changed, kept after the run. */
export type WorktreeReport = { path: string; branch: string; files_changed: string[] };

