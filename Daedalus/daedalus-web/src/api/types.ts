import type { Event, FinalReport, PermissionKey, Plan, ToolCall, ToolResult, ValidationResult } from '@daedalus/core'

/**
 * Versioned wire contract for the gateway (PLAN.md §3.6 / Phase 8 risk note).
 * The UI never touches raw `unknown` payloads: every event type is narrowed
 * here, so a change in core fails loudly instead of rendering blank panels.
 */
export const EVENT_CONTRACT_VERSION = 1

export type TaskSummary = {
  id: string
  goal?: string
  repo_path?: string
  status: string
  event_count: number
  last_seq: number
  last_event: string | null
  updated_at: string | null
  running: boolean
}

export type TaskSnapshot = {
  state?: Record<string, unknown>
  events: Event[]
  report?: FinalReport | null
  running: boolean
}

export type WorkspaceRoot = { path: string; name: string }
export type WorkspaceEntry = { name: string; path: string; isDirectory: boolean; size?: number }
export type WorkspaceTreeNode = WorkspaceEntry & { children?: WorkspaceTreeNode[] }
export type WorkspaceFile = { path: string; content: string; size: number }

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
export type ApprovalRequested = { key: PermissionKey; policy: string }
export type ApprovalDecided = { key: PermissionKey; decision: 'grant' | 'deny'; remember: boolean }
export type TaskCompleted = { state?: Record<string, unknown>; outcome: string; reason: string }
export type ModelRequestFailed = { error: string }

export type EventPayloads = {
  TASK_STARTED: { spec: { id: string; goal: string; repo_path: string; constraints: string[]; done_criteria: string[] } }
  PLAN_CREATED: { plan: Plan }
  REPLAN_CREATED: { plan: Plan; previous_plan?: Plan; reason?: string }
  TOOL_CALL_STARTED: { call: ToolCall }
  TOOL_CALL_FINISHED: { call: ToolCall; result: ToolResult }
  COMMAND_STARTED: CommandStarted
  COMMAND_OUTPUT: CommandOutput
  COMMAND_FINISHED: CommandFinished
  FILE_CHANGED: FileChange
  MODEL_REQUEST_STARTED: { provider: string; messages: number; tools: number }
  MODEL_REQUEST_FINISHED: { message?: { content?: string }; usage?: Record<string, number>; finish_reason?: string }
  MODEL_REQUEST_FAILED: ModelRequestFailed
  VALIDATION_STARTED: { task_id: string }
  VALIDATION_PASSED: { result: ValidationResult }
  VALIDATION_FAILED: { result: ValidationResult }
  RECOVERY_STARTED: RecoveryStarted
  APPROVAL_REQUESTED: ApprovalRequested
  APPROVAL_DECIDED: ApprovalDecided
  TASK_COMPLETED: TaskCompleted
}

export type EventOf<K extends keyof EventPayloads> = Event & { type: K; payload: EventPayloads[K] }

/** Narrowing read of an event payload; returns undefined for malformed records. */
export function payloadOf<K extends keyof EventPayloads>(event: Event, type: K): EventPayloads[K] | undefined {
  return event.type === type ? (event.payload as EventPayloads[K]) : undefined
}