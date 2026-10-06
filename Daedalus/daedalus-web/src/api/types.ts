import type {
  AgentMode,
  ApprovalRequestInfo,
  Attachment,
  ChildTask,
  ChildTaskBudget,
  Event,
  FinalReport,
  PermissionKey,
  Plan,
  ProviderConfigPublic,
  ToolCall,
  ToolResult,
  UserQuestionInfo,
  ValidationResult,
} from '@daedalus/core'

/**
 * Versioned wire contract for the gateway (PLAN.md §3.6 / Phase 8 risk note).
 * The UI never touches raw `unknown` payloads: every event type is narrowed
 * here, so a change in core fails loudly instead of rendering blank panels.
 */
export const EVENT_CONTRACT_VERSION = 1

export type TaskSummary = {
  id: string
  goal?: string
  title?: string
  repo_path?: string
  status: string
  outcome?: string
  mode?: string
  thinking?: boolean
  created_at?: string | null
  event_count: number
  last_seq: number
  last_event: string | null
  updated_at: string | null
  running: boolean
  store_root?: string
  /** Chat conversation this task belongs to, when created from the Web chat. */
  conversation_id?: string
}

/** One recorded chat turn; tasks append a user turn on submit and an assistant summary on completion. */
export type ConversationTurn = {
  role: 'user' | 'assistant'
  text: string
  task_id?: string
  mode?: string
  ts: string
}

/** A continuing chat session for one workspace, persisted server-side. */
export type Conversation = {
  id: string
  root: string
  created_at: string
  turns: ConversationTurn[]
}

export type TaskSnapshot = {
  state?: Record<string, unknown>
  events: Event[]
  report?: FinalReport | null
  running: boolean
  task?: TaskSummary
}

export type WorkspaceRoot = { path: string; name: string }

/**
 * One terminal tab. `agent` sessions are the read-only per-workspace sink
 * the harness' commands are mirrored into; `user` sessions are the human's
 * own interactive shells. Sessions live in the server process.
 */
export type TerminalSession = {
  id: string
  kind: 'user' | 'agent'
  title: string
  cwd: string
  status: 'running' | 'exited'
  exitCode: number | null
  pid: number | null
  createdAt: string
}
export type WorkspaceEntry = { name: string; path: string; isDirectory: boolean; size?: number }
export type WorkspaceTreeNode = WorkspaceEntry & { children?: WorkspaceTreeNode[] }
export type WorkspaceFile = { path: string; content: string; size: number }

export type SessionState = {
  mode: AgentMode
  autoApprove: boolean
  thinking: boolean
  providerId?: string;
  model?: string
  workspaceRoot: string
}

export type ExtensionStatus = {
  root: string
  mcp: Array<{ name: string; connected: boolean; toolCount: number; error?: string }>
  skills: Array<{ name: string; description: string; origin?: string }>
  agents: Array<{ name: string; description: string; model?: string; mode?: string; tools?: string[] }>
  lsp: Array<{ name: string; extensions: string[]; configured: boolean; running?: boolean; error?: string }>
  problems: string[]
}

export type SettingsResponse = {
  settings: Record<string, unknown>
  session: SessionState
  providers?: ProviderConfigPublic[]
}

export type ProviderPreset = {
  id: string
  name: string
  baseUrl: string
  defaultModel?: string
  supportsVision?: boolean
}

export type ProviderModel = {
  providerId: string
  model: string
  supportsVision: boolean
}

export type ProviderInput = {
  id?: string
  name?: string
  baseUrl?: string
  apiKey?: string
  models?: string[]
  defaultModel?: string
  enabled?: boolean
  supportsVision?: boolean
  visionModels?: string[]
  toolProtocol?: 'native' | 'text' | 'auto'
  /** Tailor suite: capability tier per model id for pool phase routing. */
  modelTiers?: Record<string, 'strong' | 'balanced' | 'fast'>
  /** Tailor suite: prompt dialect family ('auto' = detect from model id). */
  promptFamily?: 'auto' | 'claude' | 'gpt' | 'qwen' | 'llama' | 'gemini' | 'generic'
  /** Tailor suite: edit dialect for this provider's models. */
  editFormat?: 'native' | 'search_replace'
}

export type WorkspacePins = { root: string; pins: string[] }

export type WorkspaceFileEntry = { path: string; type: 'file' | 'dir' }
export type WorkspaceFiles = { root: string; files: WorkspaceFileEntry[]; truncated: boolean }

export type ProviderTestResult = {
  ok: boolean
  providerId: string
  models: string[]
  message: string
}

export type ChildTaskInput = {
  goal: string
  mode?: AgentMode
  budget?: ChildTaskBudget
  agent?: string
  isolation?: 'worktree'
}

export type ReviewResponse = {
  findings: Array<{ severity: 'high' | 'medium' | 'low'; file: string; line?: number; message: string }>
  raw: string
  source: 'task-diff' | 'unstaged' | 'provided'
  truncated: boolean
}

export type UploadLimits = {
  maxFiles: number
  maxFileBytes: number
  maxTotalBytes: number
  maxZipEntries: number
  maxZipUncompressedBytes: number
}

export type UploadResponse = {
  attachments: Attachment[]
  files: Array<{ path: string; size: number }>
  limits: UploadLimits
  destination: string
}

export type TaskAttachmentsResponse = {
  attachments: Attachment[]
  count: number
}

export type { Attachment, ChildTask, ProviderConfigPublic }

export type DiffLine = { kind: 'context' | 'add' | 'remove'; text: string }
export type FileChange = {
  call_id: string
  path: string
  tool: string
  operation: 'created' | 'modified' | string
  added: number
  removed: number
  lines: DiffLine[]
  patch: string
}

export type CommandStarted = { call_id: string; command: string; tool: string; cwd: string }
export type CommandOutput = { call_id: string; chunk: string }
export type CommandFinished = { call_id: string; status: string; exit_code: number | null; killed: boolean; truncated: boolean }
export type RecoveryStarted = { reason: string; strategy: 'retry' | 'fix' | 'replan' | 'abort' | string; attempt: number }
export type ApprovalRequested = { key: PermissionKey; policy: string; approval?: ApprovalRequestInfo }
export type ApprovalDecided = {
  key: PermissionKey
  decision: 'grant' | 'deny'
  remember: boolean
  approval_id?: string
  note?: string
  edited?: boolean
  timed_out?: boolean
  cancelled?: boolean
}
export type TaskCompleted = { state?: Record<string, unknown>; outcome: string; reason: string; error_summary?: string; summary?: string; model_error?: Record<string, unknown> }
export type ModelRequestFailed = { error: string; error_kind?: string; error_reason?: string; model?: string; models_tried?: string[]; timeout_ms?: number }
export type ModeChanged = { from: AgentMode; to: AgentMode; turn_boundary: boolean; replan_required: boolean }
export type ProviderChanged = {
  providerId?: string
  provider_id?: string
  model?: string
  from_model?: string
  to_model?: string
  /** Set when the change is an automatic tool-protocol switch (native → text). */
  protocol_switched?: boolean
  tool_protocol?: string
  from_protocol?: string
  /** 'quality_escalation' when the task was pinned to the strongest model after a validation failure. */
  reason?: string
}
export type ReviewCompleted = {
  model: string
  author_model?: string
  blocking: boolean
  findings: Array<{ severity: 'high' | 'medium' | 'low'; file: string; line?: number; message: string }>
  truncated?: boolean
}
export type AttachmentAdded = { attachment: Attachment }
export type ChildTaskEvent = { child: ChildTask }
export type SlashCommandExecuted = { command: string; text?: string; action?: string }
export type PlanCreated = { plan: Plan; mode?: AgentMode; documents?: string[] }
export type QuestionRequested = { question: UserQuestionInfo }
export type QuestionAnswered = {
  question_id: string
  question: string
  answer?: string
  outcome: 'answered' | 'timeout' | 'cancelled'
  option_index?: number
  timed_out?: boolean
  cancelled?: boolean
}

export type EventPayloads = {
  TASK_STARTED: { spec: { id: string; goal: string; repo_path: string; constraints: string[]; done_criteria: string[] } }
  PLAN_CREATED: PlanCreated
  THOUGHT: { text: string; source?: string; truncated?: boolean; original_length?: number }
  LOOP_WARNING: { tool: string; repeats: number; suppressed: boolean }
  REPLAN_CREATED: { plan: Plan; previous_plan?: Plan; reason?: string }
  TOOL_CALL_STARTED: { call: ToolCall }
  TOOL_CALL_FINISHED: { call: ToolCall; result: ToolResult; output_truncated?: boolean; spill_path?: string }
  COMMAND_STARTED: CommandStarted
  COMMAND_OUTPUT: CommandOutput
  COMMAND_FINISHED: CommandFinished
  FILE_CHANGED: FileChange
  MODEL_REQUEST_STARTED: { provider: string; messages: number; tools: number; phase?: string; context_estimate_tokens?: number; context_limit_tokens?: number; context_percent?: number }
  MODEL_REQUEST_FINISHED: { message?: { content?: string }; usage?: Record<string, number>; finish_reason?: string; model?: string; tier?: string; phase?: string; context_estimate_tokens?: number; context_limit_tokens?: number; context_percent?: number }
  MODEL_REQUEST_FAILED: ModelRequestFailed
  VALIDATION_STARTED: { task_id: string }
  VALIDATION_PASSED: { result: ValidationResult }
  VALIDATION_FAILED: { result: ValidationResult }
  RECOVERY_STARTED: RecoveryStarted
  APPROVAL_REQUESTED: ApprovalRequested
  APPROVAL_DECIDED: ApprovalDecided
  QUESTION_REQUESTED: QuestionRequested
  QUESTION_ANSWERED: QuestionAnswered
  TASK_COMPLETED: TaskCompleted
  MODE_CHANGED: ModeChanged
  PROVIDER_CHANGED: ProviderChanged
  REVIEW_COMPLETED: ReviewCompleted
  ATTACHMENT_ADDED: AttachmentAdded
  CHILD_TASK_STARTED: ChildTaskEvent
  CHILD_TASK_FINISHED: ChildTaskEvent
  SLASH_COMMAND_EXECUTED: SlashCommandExecuted
}

export type EventOf<K extends keyof EventPayloads> = Event & { type: K; payload: EventPayloads[K] }

/** Narrowing read of an event payload; returns undefined for malformed records. */
export function payloadOf<K extends keyof EventPayloads>(event: Event, type: K): EventPayloads[K] | undefined {
  return event.type === type ? (event.payload as EventPayloads[K]) : undefined
}