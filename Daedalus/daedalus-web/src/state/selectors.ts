import type { Attachment, ChildTask, Event, FinalReport, Plan, PlanStep, ToolCall, ToolResult, ValidationResult } from '@daedalus/core'
import { payloadOf, type ApprovalRequested, type CommandFinished, type CommandStarted, type FileChange, type RecoveryStarted } from '../api/types'

/**
 * Pure derivations over the append-only event log. Every panel renders from
 * these, so the UI is a function of recorded events only (§3.4 rule 6).
 */

export type TaskStatus = 'idle' | 'running' | 'awaiting-approval' | 'done' | 'failed' | 'partial' | 'stopped'

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
  kind: 'thought' | 'action' | 'observation' | 'plan' | 'validation' | 'recovery' | 'approval' | 'file' | 'completion' | 'error' | 'system' | 'attachment' | 'orchestration'
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
  /** Full card data (id, untruncated preview, remember pattern) when core sent it. */
  approval?: ApprovalRequested['approval']
}

export type ErrorEntry = {
  seq: number
  ts: string
  type: 'model' | 'tool' | 'validation' | 'recovery' | 'task'
  message: string
  context?: string
}

function completionDetail(completed: { reason: string; error_summary?: string; summary?: string } | undefined): string {
  return completed?.error_summary ?? completed?.summary ?? completed?.reason ?? '';
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

export function attachmentsFromEvents(events: Event[]): Attachment[] {
  const merged = new Map<string, Attachment>()
  for (const event of events) {
    const payload = payloadOf(event, 'ATTACHMENT_ADDED')
    if (payload?.attachment) merged.set(payload.attachment.id, payload.attachment)
  }
  return [...merged.values()]
}

export function childTasks(events: Event[]): ChildTask[] {
  const merged = new Map<string, ChildTask>()
  for (const event of events) {
    const started = payloadOf(event, 'CHILD_TASK_STARTED')
    const finished = payloadOf(event, 'CHILD_TASK_FINISHED')
    const child = finished?.child ?? started?.child
    if (child) merged.set(child.id, child)
  }
  return [...merged.values()]
}

export function modeChanges(events: Event[]): Array<{ from: string; to: string; replanRequired: boolean }> {
  return events.flatMap((event) => {
    const payload = payloadOf(event, 'MODE_CHANGED')
    return payload ? [{ from: payload.from, to: payload.to, replanRequired: payload.replan_required }] : []
  })
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
  // A decision retires its request by approval id when core sent one, and by
  // the legacy composite key otherwise — both are recorded so old and new
  // event logs alike stop showing the card.
  const decided = new Set<string>()
  for (const event of events) {
    const payload = payloadOf(event, 'APPROVAL_DECIDED')
    if (!payload) continue
    decided.add(approvalId(payload.key))
    if (payload.approval_id) decided.add(payload.approval_id)
  }
  return events.flatMap((event) => {
    const payload = payloadOf(event, 'APPROVAL_REQUESTED')
    if (!payload) return []
    const settled = decided.has(approvalId(payload.key)) || (payload.approval?.id ? decided.has(payload.approval.id) : false)
    return settled ? [] : [{ seq: event.seq, key: payload.key, policy: payload.policy, ...(payload.approval ? { approval: payload.approval } : {}) }]
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
      entries.push({ seq: event.seq, ts: event.ts, type: 'task', message: `task ${completed.outcome}: ${completionDetail(completed)}` })
    }
  }
  return entries
}

export function activity(events: Event[], thinking = true): ActivityEntry[] {
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
      case 'MODEL_REQUEST_STARTED': {
        const started = payloadOf(event, 'MODEL_REQUEST_STARTED')
        push({
          kind: 'thought',
          title: 'Thinking',
          detail: `${started?.provider ?? 'model'} · ${started?.messages ?? 0} messages${typeof started?.context_percent === 'number' ? ` · ctx ${started.context_percent}%` : ''}`,
        })
        break
      }
      case 'LOOP_WARNING': {
        const warning = payloadOf(event, 'LOOP_WARNING')
        push({
          kind: 'recovery',
          title: `loop warning${warning?.suppressed ? ' · repeat suppressed' : ''}`,
          detail: `${warning?.tool ?? 'tool'} repeated ${warning?.repeats ?? 0}× with the same arguments`,
          status: 'warning',
        })
        break
      }
      case 'THOUGHT': {
        if (!thinking) break
        const thought = payloadOf(event, 'THOUGHT')
        if (thought?.text) push({ kind: 'thought', title: 'thinking', detail: thought.text.slice(0, 500), status: 'info' })
        break
      }
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
          detail: [
            (finished?.result.output ?? '').trim().slice(0, 240) || undefined,
            finished?.output_truncated ? '(output truncated for the model — head+tail kept, full text in the task spill file)' : undefined,
          ].filter(Boolean).join(' ') || undefined,
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
        push({
          kind: 'approval',
          title: decided?.timed_out ? 'approval timed out' : `approval ${decided?.decision ?? 'decided'}`,
          detail: [
            approvalLabel(decided?.key),
            decided?.timed_out ? 'timed out — treated as declined' : undefined,
            decided?.cancelled ? 'cancelled — treated as declined' : undefined,
            decided?.edited ? 'edited before running' : undefined,
            decided?.note ? `note: ${decided.note}` : undefined,
          ].filter(Boolean).join(' · '),
          status: decided?.decision === 'grant' ? 'ok' : 'error',
        })
        break
      }
      case 'TASK_COMPLETED': {
        const completed = payloadOf(event, 'TASK_COMPLETED')
        push({ kind: 'completion', title: `task ${completed?.outcome ?? 'done'}`, detail: completionDetail(completed), status: completed?.outcome === 'success' ? 'ok' : 'error' })
        break
      }
      case 'MODEL_REQUEST_FAILED':
        push({ kind: 'error', title: 'model request failed', detail: payloadOf(event, 'MODEL_REQUEST_FAILED')?.error, status: 'error' })
        break
      case 'MODE_CHANGED': {
        const changed = payloadOf(event, 'MODE_CHANGED')
        push({
          kind: 'system',
          title: `mode ${changed?.from ?? '?'} → ${changed?.to ?? '?'}`,
          detail: changed?.replan_required ? 'applies at the next turn boundary · re-plan required' : 'applies at the next turn boundary',
          status: 'info',
        })
        break
      }
      case 'PROVIDER_CHANGED': {
        const changed = payloadOf(event, 'PROVIDER_CHANGED')
        if (changed?.protocol_switched) {
          push({
            kind: 'system',
            title: 'switched to text tool protocol',
            detail: `${changed.model ?? 'model'} answered native tool calls unusably, so this task now uses XML-style text tool calls${changed.reason ? ` · ${changed.reason}` : ''}`,
            status: 'info',
          })
          break
        }
        if (changed?.reason === 'quality_escalation') {
          push({
            kind: 'system',
            title: 'escalated to stronger model',
            detail: `validation failed under ${changed.from_model ?? 'a weaker model'}, so the rest of this task runs on ${changed.to_model ?? 'the strongest model'}`,
            status: 'info',
          })
          break
        }
        push({ kind: 'system', title: 'provider changed', detail: `${changed?.providerId ?? changed?.provider_id ?? 'default'}${changed?.model ? `/${changed.model}` : ''}`, status: 'info' })
        break
      }
      case 'REVIEW_COMPLETED': {
        const review = payloadOf(event, 'REVIEW_COMPLETED')
        push({
          kind: 'validation',
          title: review?.blocking ? 'strong-model review: blocking issues' : 'strong-model review: no blocking issues',
          detail: review
            ? `${review.model} reviewed ${review.author_model ?? 'the task model'}'s changes · ${review.findings.length} finding${review.findings.length === 1 ? '' : 's'}${review.blocking ? ' · outcome demoted to partial' : ''}`
            : undefined,
          status: review?.blocking ? 'warning' : 'ok',
        })
        break
      }
      case 'ATTACHMENT_ADDED': {
        const attachment = payloadOf(event, 'ATTACHMENT_ADDED')?.attachment
        push({ kind: 'attachment', title: `attached ${attachment?.kind ?? 'file'}`, detail: attachment ? `${attachment.name} · ${attachment.workspacePath}` : undefined, status: 'info' })
        break
      }
      case 'CHILD_TASK_STARTED': {
        const child = payloadOf(event, 'CHILD_TASK_STARTED')?.child
        push({ kind: 'orchestration', title: 'child task started', detail: child?.goal, status: 'running' })
        break
      }
      case 'CHILD_TASK_FINISHED': {
        const child = payloadOf(event, 'CHILD_TASK_FINISHED')?.child
        push({ kind: 'orchestration', title: `child task ${child?.status ?? 'finished'}`, detail: child?.result_summary ?? child?.goal, status: child?.status === 'done' ? 'ok' : 'warning' })
        break
      }
      case 'SLASH_COMMAND_EXECUTED': {
        const executed = payloadOf(event, 'SLASH_COMMAND_EXECUTED')
        push({ kind: 'system', title: `/${executed?.command ?? 'command'}`, detail: executed?.text, status: 'info' })
        break
      }
      default:
        break
    }
  }
  return entries
}

/** Context-meter reading from the newest MODEL_REQUEST_* event that carries one. */
export function latestContextPercent(events: Event[]): number | undefined {
  for (let index = events.length - 1; index >= 0; index--) {
    const event = events[index]
    if (!event || (event.type !== 'MODEL_REQUEST_STARTED' && event.type !== 'MODEL_REQUEST_FINISHED')) continue
    const payload = event.payload as { context_percent?: unknown }
    if (typeof payload.context_percent === 'number') return payload.context_percent
  }
  return undefined
}

export function taskStatus(events: Event[], pendingApprovalsCount: number): TaskStatus {
  const completed = [...events].reverse().find((event) => event.type === 'TASK_COMPLETED')
  const hasStarted = events.some((event) => event.type === 'TASK_STARTED')
  if (completed) {
    const payload = payloadOf(completed, 'TASK_COMPLETED')
    if (payload?.outcome === 'success') return 'done'
    if (payload?.outcome === 'partial') return 'partial'
    // A user-stopped run is not a failure: the loop records outcome
    // 'failed' with reason 'aborted', and the UI owes the user the truth.
    if (payload?.reason === 'aborted' || payload?.reason === 'cancelled') return 'stopped'
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
  return { outcome: payload?.outcome ?? 'unknown', reason: completionDetail(payload) }
}

export function reportFromEvents(taskId: string, events: Event[], report: FinalReport | null | undefined): FinalReport | null {
  if (report) return report
  const completion = outcomeOf(events)
  if (!completion) return null
  const completed = [...events].reverse().find((event) => event.type === 'TASK_COMPLETED')
  const modelSummary = completed ? payloadOf(completed, 'TASK_COMPLETED')?.error_summary : undefined
  const { result } = validation(events)
  const changes = fileChanges(events)
  const calls = toolCalls(events)
  return {
    task_id: taskId,
    outcome: completion.outcome === 'success' ? 'success' : completion.outcome === 'partial' ? 'partial' : 'failed',
    diff: changes.map((change) => change.patch).join(''),
    evidence: [
      ...(modelSummary ? [`model failure: ${modelSummary}`] : []),
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

export type ChatEntry = {
  seq: number
  ts: string
  role: 'user' | 'assistant' | 'thought' | 'tool' | 'status' | 'approval'
  text: string
  detail?: string
  status?: ActivityEntry['status']
  tool?: string
}

/**
 * The conversation view over the same event log: the user's prompt, provider
 * thoughts, assistant replies, tool calls with short results, and the status
 * lines a chat reader needs (approvals, validation, completion). Derived only
 * from recorded events, exactly like `activity()`; tool calls reuse the
 * `toolCalls()` pairing so a started/finished pair renders as one entry whose
 * status/output come from the recorded result.
 */
export function chatTranscript(events: Event[], thinking = true): ChatEntry[] {
  const views = new Map(toolCalls(events).map((view) => [view.call.id, view]))
  const entries: ChatEntry[] = []
  for (const event of events) {
    const base = { seq: event.seq, ts: event.ts }
    switch (event.type) {
      case 'TASK_STARTED': {
        const goal = payloadOf(event, 'TASK_STARTED')?.spec.goal?.trim()
        if (goal) entries.push({ ...base, role: 'user', text: goal })
        break
      }
      case 'SLASH_COMMAND_EXECUTED': {
        const executed = payloadOf(event, 'SLASH_COMMAND_EXECUTED')
        if (executed?.command) {
          entries.push({ ...base, role: 'user', text: `/${executed.command}${executed.text ? ` — ${executed.text}` : ''}` })
        }
        break
      }
      case 'THOUGHT': {
        if (!thinking) break
        const text = payloadOf(event, 'THOUGHT')?.text?.trim()
        if (text) entries.push({ ...base, role: 'thought', text: truncateChat(text, 4000) })
        break
      }
      case 'MODEL_REQUEST_FINISHED': {
        const content = payloadOf(event, 'MODEL_REQUEST_FINISHED')?.message?.content?.trim()
        if (content) entries.push({ ...base, role: 'assistant', text: truncateChat(content, 8000) })
        break
      }
      case 'TOOL_CALL_STARTED': {
        const call = payloadOf(event, 'TOOL_CALL_STARTED')?.call
        if (!call) break
        const result = views.get(call.id)?.result
        entries.push({
          ...base,
          role: 'tool',
          tool: call.tool,
          text: summarizeArgs(call.args) ?? '',
          detail: result?.output ? truncateChat(result.output.trim(), 400) : undefined,
          status: result ? toolStatus(result.status) : 'running',
        })
        break
      }
      case 'APPROVAL_REQUESTED': {
        const requested = payloadOf(event, 'APPROVAL_REQUESTED')
        entries.push({
          ...base,
          role: 'approval',
          text: `approval requested — ${approvalLabel(requested?.key)}`,
          detail: requested?.policy ? `policy: ${requested.policy}` : undefined,
          status: 'warning',
        })
        break
      }
      case 'APPROVAL_DECIDED': {
        const decided = payloadOf(event, 'APPROVAL_DECIDED')
        entries.push({
          ...base,
          role: 'approval',
          text: decided?.timed_out
            ? `approval timed out — treated as declined — ${approvalLabel(decided?.key)}`
            : `approval ${decided?.decision ?? 'decided'} — ${approvalLabel(decided?.key)}`,
          detail: [
            decided?.cancelled ? 'cancelled — treated as declined' : undefined,
            decided?.edited ? 'edited before running' : undefined,
            decided?.note ? `note: ${decided.note}` : undefined,
          ].filter(Boolean).join(' · ') || undefined,
          status: decided?.decision === 'grant' ? 'ok' : 'error',
        })
        break
      }
      case 'PLAN_CREATED': {
        const plan = payloadOf(event, 'PLAN_CREATED')?.plan
        entries.push({ ...base, role: 'status', text: `plan created · ${plan?.steps.length ?? 0} steps`, status: 'info' })
        break
      }
      case 'REPLAN_CREATED':
        entries.push({ ...base, role: 'status', text: 'plan revised', detail: payloadOf(event, 'REPLAN_CREATED')?.reason, status: 'info' })
        break
      case 'LOOP_WARNING': {
        const warning = payloadOf(event, 'LOOP_WARNING')
        entries.push({
          ...base,
          role: 'status',
          text: `loop warning — ${warning?.tool ?? 'tool'} repeated ${warning?.repeats ?? 0}×${warning?.suppressed ? ' · repeat suppressed' : ''}`,
          status: 'warning',
        })
        break
      }
      case 'VALIDATION_PASSED':
        entries.push({ ...base, role: 'status', text: 'validation passed', status: 'ok' })
        break
      case 'VALIDATION_FAILED':
        entries.push({ ...base, role: 'status', text: 'validation failed', detail: failingChecks(event), status: 'error' })
        break
      case 'RECOVERY_STARTED': {
        const recovery = payloadOf(event, 'RECOVERY_STARTED')
        entries.push({ ...base, role: 'status', text: `recovery ${recovery?.strategy ?? ''} — ${recovery?.reason ?? ''}`, detail: `attempt ${recovery?.attempt ?? 0}`, status: 'warning' })
        break
      }
      case 'MODEL_REQUEST_FAILED':
        entries.push({ ...base, role: 'status', text: 'model request failed', detail: payloadOf(event, 'MODEL_REQUEST_FAILED')?.error, status: 'error' })
        break
      case 'MODE_CHANGED': {
        const changed = payloadOf(event, 'MODE_CHANGED')
        entries.push({ ...base, role: 'status', text: `mode ${changed?.from ?? '?'} → ${changed?.to ?? '?'}`, status: 'info' })
        break
      }
      case 'CHILD_TASK_STARTED': {
        const child = payloadOf(event, 'CHILD_TASK_STARTED')?.child
        entries.push({ ...base, role: 'status', text: 'child task started', detail: child?.goal, status: 'running' })
        break
      }
      case 'CHILD_TASK_FINISHED': {
        const child = payloadOf(event, 'CHILD_TASK_FINISHED')?.child
        entries.push({ ...base, role: 'status', text: `child task ${child?.status ?? 'finished'}`, detail: child?.result_summary ?? child?.goal, status: child?.status === 'done' ? 'ok' : 'warning' })
        break
      }
      case 'TASK_COMPLETED': {
        const completed = payloadOf(event, 'TASK_COMPLETED')
        const stopped = completed?.reason === 'aborted' || completed?.reason === 'cancelled'
        entries.push({
          ...base,
          role: 'status',
          text: stopped ? 'task stopped' : `task ${completed?.outcome ?? 'done'}`,
          detail: stopped ? undefined : completionDetail(completed),
          status: stopped ? 'warning' : completed?.outcome === 'success' ? 'ok' : completed?.outcome === 'partial' ? 'warning' : 'error',
        })
        break
      }
      default:
        break
    }
  }
  return entries
}

function toolStatus(status: string): ActivityEntry['status'] {
  if (status === 'ok') return 'ok'
  if (status === 'denied') return 'denied'
  if (status === 'timeout') return 'timeout'
  return 'error'
}

function truncateChat(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…` : text
}

/** Parse the comma/newline-separated model-pool setting into a clean list. */
export function parseModelPool(text: string): string[] {
  const seen = new Set<string>()
  for (const part of text.split(/[,\n]/)) {
    const model = part.trim()
    if (model) seen.add(model)
  }
  return [...seen]
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