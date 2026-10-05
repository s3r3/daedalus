import type { Event, FinalReport, Plan, PlanStep, ToolCall, ToolResult, ValidationResult } from '@daedalus/core'
import { payloadOf, type ApprovalRequested, type CommandFinished, type CommandStarted, type FileChange, type RecoveryStarted } from '../api/types'

/**
 * Pure derivations over the append-only event log. Every panel renders from
 * these, so the UI is a function of recorded events only (§3.4 rule 6).
 */

export type TaskStatus = 'idle' | 'running' | 'awaiting-approval' | 'done' | 'failed' | 'partial'

export type ToolCallView = {
  call: ToolCall
  startedSeq: number
  startedAt: string
  result?: ToolResult
  finishedSeq?: number
}

export type ActivityEntry = {
  seq: number
  ts: string
  turnId?: string
  kind: 'thought' | 'action' | 'observation' | 'plan' | 'validation' | 'recovery' | 'approval' | 'file' | 'completion' | 'error'
  title: string
  detail?: string
  status?: 'ok' | 'error' | 'denied' | 'timeout' | 'running' | 'info' | 'warning'
}

export type CommandView = {
  callId: string
  command: string
  cwd: string
  status: 'running' | 'ok' | 'error' | 'timeout' | 'denied'
  exitCode: number | null
  output: string
  startedAt: string
  finishedAt?: string
}

export type PendingApproval = {
  seq: number
  key: ApprovalRequested['key']
  policy: string
}

export type ErrorEntry = {
  seq: number
  ts: string
  type: 'model' | 'tool' | 'validation' | 'recovery' | 'task'
  message: string
  context?: string
}

export function filterTaskEvents(events: Event[], taskId: string | null): Event[] {
  if (!taskId) return []
  return events.filter((event) => event.task_id === taskId).sort((a, b) => a.seq - b.seq)
}

export function latestPlan(events: Event[]): Plan | null {
  for (let i = events.length - 1; i >= 0; i--) {
    const plan = payloadOf(events[i] as Event, 'PLAN_CREATED')?.plan
    if (plan) return plan
  }
  return null
}

export function planSteps(events: Event[]): PlanStep[] {
  return latestPlan(events)?.steps ?? []
}

export function currentStep(events: Event[]): PlanStep | null {
  return planSteps(events).find((step) => step.status === 'active') ?? null
}

export function toolCalls(events: Event[]): ToolCallView[] {
  const views = new Map<string, ToolCallView>()
  for (const event of events) {
    const started = payloadOf(event, 'TOOL_CALL_STARTED')
    if (started) {
      views.set(started.call.id, { call: started.call, startedSeq: event.seq, startedAt: event.ts })
      continue
    }
    const finished = payloadOf(event, 'TOOL_CALL_FINISHED')
    if (!finished) continue
    const existing = views.get(finished.call.id)
    if (existing) {
      existing.result = finished.result
      existing.finishedSeq = event.seq
    } else {
      views.set(finished.call.id, {
        call: finished.call,
        startedSeq: event.seq,
        startedAt: event.ts,
        result: finished.result,
        finishedSeq: event.seq,
      })
    }
  }
  return [...views.values()]
}

export function commands(events: Event[]): CommandView[] {
  const views = new Map<string, CommandView>()
  for (const event of events) {
    const started = payloadOf(event, 'COMMAND_STARTED')
    if (started) {
      views.set(started.call_id, {
        callId: started.call_id,
        command: started.command,
        cwd: started.cwd,
        status: 'running',
        exitCode: null,
        output: '',
        startedAt: event.ts,
      })
      continue
    }
    const chunk = payloadOf(event, 'COMMAND_OUTPUT')
    if (chunk) {
      const view = views.get(chunk.call_id)
      if (view) view.output += chunk.chunk
      continue
    }
    const finished = payloadOf(event, 'COMMAND_FINISHED')
    if (finished) {
      const view = views.get(finished.call_id)
      if (!view) continue
      view.status = commandStatus(finished)
      view.exitCode = finished.exit_code
      view.finishedAt = event.ts
      if (finished.killed && view.output.length === 0) view.output += '[process killed]'
    }
  }
  return [...views.values()]
}

function commandStatus(finished: CommandFinished): CommandView['status'] {
  if (finished.status === 'ok') return 'ok'
  if (finished.status === 'timeout') return 'timeout'
  if (finished.status === 'denied') return 'denied'
  return 'error'
}

export function fileChanges(events: Event[]): FileChange[] {
  const merged = new Map<string, FileChange>()
  for (const event of events) {
    const change = payloadOf(event, 'FILE_CHANGED')
    if (change) merged.set(change.path, change)
  }
  return [...merged.values()]
}

export function validation(events: Event[]): { result: ValidationResult | null; running: boolean; passed: boolean | null } {
  let result: ValidationResult | null = null
  let running = false
  let passed: boolean | null = null
  for (const event of events) {
    if (event.type === 'VALIDATION_STARTED') {
      running = true
      passed = null
      continue
    }
    const ok = payloadOf(event, 'VALIDATION_PASSED')
    const failed = payloadOf(event, 'VALIDATION_FAILED')
    if (ok) {
      running = false
      result = ok.result
      passed = true
    } else if (failed) {
      running = false
      result = failed.result
      passed = false
    }
  }
  return { result, running, passed }
}

export function recoveries(events: Event[]): RecoveryStarted[] {
  return events.flatMap((event) => {
    const payload = payloadOf(event, 'RECOVERY_STARTED')
    return payload ? [payload] : []
  })
}

export function replanCount(events: Event[]): number {
  return events.filter((event) => event.type === 'REPLAN_CREATED').length
}

export function pendingApprovals(events: Event[]): PendingApproval[] {
  const decided = new Set(
    events
      .flatMap((event) => {
        const payload = payloadOf(event, 'APPROVAL_DECIDED')
        return payload ? [approvalId(payload.key)] : []
      }),
  )
  return events.flatMap((event) => {
    const payload = payloadOf(event, 'APPROVAL_REQUESTED')
    if (!payload || decided.has(approvalId(payload.key))) return []
    return [{ seq: event.seq, key: payload.key, policy: payload.policy }]
  })
}

export function approvalId(key: { taskId: string; tool: string; action: string; path?: string }): string {
  return `${key.taskId}:${key.tool}:${key.action}:${key.path ?? ''}`
}

export function errors(events: Event[]): ErrorEntry[] {
  const entries: ErrorEntry[] = []
  for (const event of events) {
    const modelFailure = payloadOf(event, 'MODEL_REQUEST_FAILED')
    if (modelFailure) {
      entries.push({ seq: event.seq, ts: event.ts, type: 'model', message: modelFailure.error })
      continue
    }
    if (event.type === 'TOOL_CALL_FINISHED') {
      const finished = payloadOf(event, 'TOOL_CALL_FINISHED')
      if (finished?.result.status === 'error' || finished?.result.status === 'timeout' || finished?.result.status === 'denied') {
        entries.push({
          seq: event.seq,
          ts: event.ts,
          type: 'tool',
          message: `${finished.result.status}: ${finished.result.output}`,
          context: finished.call.tool,
        })
      }
      continue
    }
    const validationFailed = payloadOf(event, 'VALIDATION_FAILED')
    if (validationFailed) {
      const failing = validationFailed.result.checks.filter((check) => check.status !== 'pass')
      entries.push({
        seq: event.seq,
        ts: event.ts,
        type: 'validation',
        message: `validation failed: ${failing.map((check) => check.name).join(', ') || 'unknown'}`,
        context: failing.map((check) => check.summary).filter(Boolean).join(' | '),
      })
      continue
    }
    const recovery = payloadOf(event, 'RECOVERY_STARTED')
    if (recovery) {
      entries.push({ seq: event.seq, ts: event.ts, type: 'recovery', message: `${recovery.strategy} after ${recovery.reason}`, context: `attempt ${recovery.attempt}` })
      continue
    }
    const completed = payloadOf(event, 'TASK_COMPLETED')
    if (completed && completed.outcome !== 'success') {
      entries.push({ seq: event.seq, ts: event.ts, type: 'task', message: `task ${completed.outcome}: ${completed.reason}` })
    }
  }
  return entries
}

export function activity(events: Event[]): ActivityEntry[] {
  const entries: ActivityEntry[] = []
  for (const event of events) {
    const push = (entry: Omit<ActivityEntry, 'seq' | 'ts' | 'turnId'>): void => {
      entries.push({ seq: event.seq, ts: event.ts, ...(event.turn_id ? { turnId: event.turn_id } : {}), ...entry })
    }
    switch (event.type) {
      case 'TASK_STARTED':
        push({ kind: 'thought', title: 'Task accepted', detail: payloadOf(event, 'TASK_STARTED')?.spec.goal })
        break
      case 'PLAN_CREATED':
        push({ kind: 'plan', title: 'Plan created', detail: `${(event.payload as { plan?: Plan }).plan?.steps.length ?? 0} steps` })
        break
      case 'REPLAN_CREATED':
        push({ kind: 'plan', title: 'Plan revised', detail: (event.payload as { reason?: string }).reason })
        break
      case 'MODEL_REQUEST_STARTED':
        push({ kind: 'thought', title: 'Thinking', detail: `${(event.payload as { provider?: string }).provider ?? 'model'} · ${(event.payload as { messages?: number }).messages ?? 0} messages` })
        break
      case 'MODEL_REQUEST_FINISHED': {
        const message = (event.payload as { message?: { content?: string } })?.message?.content ?? ''
        push({ kind: 'thought', title: 'Model replied', detail: message.slice(0, 240) || undefined })
        break
      }
      case 'TOOL_CALL_STARTED': {
        const call = payloadOf(event, 'TOOL_CALL_STARTED')?.call
        push({ kind: 'action', title: call?.tool ?? 'tool call', detail: summarizeArgs(call?.args), status: 'running' })
        break
      }
      case 'TOOL_CALL_FINISHED': {
        const finished = payloadOf(event, 'TOOL_CALL_FINISHED')
        push({
          kind: 'observation',
          title: `${finished?.call.tool ?? 'tool'} ${finished?.result.status ?? 'result'}`,
          detail: (finished?.result.output ?? '').trim().slice(0, 240) || undefined,
          status: finished?.result.status === 'ok' ? 'ok' : 'error',
        })
        break
      }
      case 'COMMAND_STARTED':
        push({ kind: 'action', title: 'command started', detail: payloadOf(event, 'COMMAND_STARTED')?.command, status: 'running' })
        break
      case 'COMMAND_FINISHED':
        push({ kind: 'observation', title: 'command finished', detail: `exit ${payloadOf(event, 'COMMAND_FINISHED')?.exit_code ?? 'n/a'}`, status: 'ok' })
        break
      case 'FILE_CHANGED':
        push({ kind: 'file', title: `file ${payloadOf(event, 'FILE_CHANGED')?.operation ?? 'changed'}`, detail: payloadOf(event, 'FILE_CHANGED')?.path, status: 'info' })
        break
      case 'VALIDATION_STARTED':
        push({ kind: 'validation', title: 'validation running', status: 'running' })
        break
      case 'VALIDATION_PASSED':
        push({ kind: 'validation', title: 'validation passed', status: 'ok' })
        break
      case 'VALIDATION_FAILED':
        push({ kind: 'validation', title: 'validation failed', detail: failingChecks(event), status: 'error' })
        break
      case 'RECOVERY_STARTED': {
        const recovery = payloadOf(event, 'RECOVERY_STARTED')
        push({ kind: 'recovery', title: `recovery ${recovery?.strategy ?? ''}`, detail: `${recovery?.reason ?? ''} (attempt ${recovery?.attempt ?? 0})`, status: 'warning' })
        break
      }
      case 'APPROVAL_REQUESTED':
        push({ kind: 'approval', title: 'approval requested', detail: approvalLabel(payloadOf(event, 'APPROVAL_REQUESTED')?.key), status: 'warning' })
        break
      case 'APPROVAL_DECIDED': {
        const decided = payloadOf(event, 'APPROVAL_DECIDED')
        push({ kind: 'approval', title: `approval ${decided?.decision ?? 'decided'}`, detail: approvalLabel(decided?.key), status: decided?.decision === 'grant' ? 'ok' : 'error' })
        break
      }
      case 'TASK_COMPLETED': {
        const completed = payloadOf(event, 'TASK_COMPLETED')
        push({ kind: 'completion', title: `task ${completed?.outcome ?? 'done'}`, detail: completed?.reason, status: completed?.outcome === 'success' ? 'ok' : 'error' })
        break
      }
      case 'MODEL_REQUEST_FAILED':
        push({ kind: 'error', title: 'model request failed', detail: payloadOf(event, 'MODEL_REQUEST_FAILED')?.error, status: 'error' })
        break
      default:
        break
    }
  }
  return entries
}

export function taskStatus(events: Event[], pendingApprovalsCount: number): TaskStatus {
  const completed = [...events].reverse().find((event) => event.type === 'TASK_COMPLETED')
  const hasStarted = events.some((event) => event.type === 'TASK_STARTED')
  if (completed) {
    const outcome = payloadOf(completed, 'TASK_COMPLETED')?.outcome
    if (outcome === 'success') return 'done'
    if (outcome === 'partial') return 'partial'
    return 'failed'
  }
  if (pendingApprovalsCount > 0) return 'awaiting-approval'
  if (hasStarted) return 'running'
  return 'idle'
}

export function outcomeOf(events: Event[]): { outcome: string; reason: string } | null {
  const completed = [...events].reverse().find((event) => event.type === 'TASK_COMPLETED')
  if (!completed) return null
  const payload = payloadOf(completed, 'TASK_COMPLETED')
  return { outcome: payload?.outcome ?? 'unknown', reason: payload?.reason ?? '' }
}

export function reportFromEvents(taskId: string, events: Event[], report: FinalReport | null | undefined): FinalReport | null {
  if (report) return report
  const completion = outcomeOf(events)
  if (!completion) return null
  const { result } = validation(events)
  const changes = fileChanges(events)
  const calls = toolCalls(events)
  return {
    task_id: taskId,
    outcome: completion.outcome === 'success' ? 'success' : completion.outcome === 'partial' ? 'partial' : 'failed',
    diff: changes.map((change) => change.patch).join(''),
    evidence: [
      ...(result?.checks.map((check) => `${check.name}: ${check.status} (${check.cmd})`) ?? []),
      ...changes.map((change) => `${change.operation} ${change.path} (+${change.added}/-${change.removed})`),
    ],
    metrics: {
      turns: calls.length,
      tool_calls: calls.length,
      events: events.length,
      commands: commands(events).length,
      files_changed: changes.length,
      recoveries: recoveries(events).length,
      replans: replanCount(events),
      approvals: events.filter((event) => event.type === 'APPROVAL_REQUESTED').length,
      checks_passed: result?.checks.filter((check) => check.status === 'pass').length ?? 0,
      checks_failed: result?.checks.filter((check) => check.status !== 'pass').length ?? 0,
    },
  }
}

export function commandStartedPayload(event: Event): CommandStarted | undefined {
  return payloadOf(event, 'COMMAND_STARTED')
}

function failingChecks(event: Event): string {
  const payload = payloadOf(event, 'VALIDATION_FAILED')
  const failing = payload?.result.checks.filter((check) => check.status !== 'pass') ?? []
  return failing.map((check) => `${check.name}: ${check.summary}`).join(' | ')
}

function approvalLabel(key: { tool: string; action: string; path?: string } | undefined): string {
  if (!key) return ''
  return `${key.tool} [${key.action}]${key.path ? ` ${key.path}` : ''}`
}

function summarizeArgs(args: unknown): string | undefined {
  if (typeof args !== 'object' || args === null) return undefined
  const text = JSON.stringify(args)
  return text === '{}' ? undefined : text.slice(0, 200)
}