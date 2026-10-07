import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve, sep } from 'node:path';
import type { AgentMode, EventType, ToolCall, ToolResult } from '../contracts.ts';
import type { EventBus } from '../events.ts';
import { emitEvent } from '../events.ts';
import type { TaskStore } from '../persistence.ts';
import type { ToolDefinition, ToolExecutionContext } from '../tools/registry.ts';
import { clampCallTimeoutMs } from '../tools/registry.ts';
import { diffLines, renderPatch } from '../tools/filesystem/diff.ts';
import { applySearchReplace } from '../tools/filesystem/search-replace.ts';

export type ApprovalPolicy = 'auto' | 'ask' | 'deny';
export type ApprovalDecision = 'grant' | 'deny';
export type PermissionKey = { taskId: string; tool: string; action: 'read' | 'write' | 'execute'; path?: string };

/**
 * The exact artifact a human is asked to approve, shown untruncated on the
 * approval card (a summary like "run a command" is how dangerous actions
 * slip past reviewers — Claude/Cline/Cursor all show the verbatim thing).
 */
export type ApprovalPreview =
  | { kind: 'command'; command: string; cwd?: string }
  | { kind: 'write'; path: string; content: string }
  | { kind: 'edit'; path: string; patch: string }
  | { kind: 'args'; tool: string; args: unknown };

/**
 * What "Allow & remember" would actually allow from now on. The card only
 * offers Remember when it can show this pattern verbatim (Claude's rule: a
 * prompt never silently grants more than it displays).
 */
export type ApprovalRememberPattern =
  | { kind: 'command-prefix'; tool: string; token: string; label: string }
  | { kind: 'tool-path'; tool: string; path: string; label: string }
  | { kind: 'tool'; tool: string; label: string };

/** Everything an interface needs to render one approval card. */
export type ApprovalRequestInfo = {
  id: string;
  key: PermissionKey;
  policy: ApprovalPolicy;
  tool: string;
  preview: ApprovalPreview;
  rememberPattern?: ApprovalRememberPattern;
  /** Mode the requesting task runs under, when the harness knows it. */
  mode?: AgentMode;
  /** Who asked: the (child) task, plus its orchestrator parent when any. */
  requestedBy: { taskId: string; parentTaskId?: string };
  createdAt: string;
};

export type ApprovalResult = {
  decision: ApprovalDecision;
  remember?: boolean;
  /** User text delivered verbatim to the model with a decline. */
  note?: string;
  /** Replacement arguments an "Edit & allow" decision runs instead. */
  editedArgs?: Record<string, unknown>;
  /** How the wait ended; absent means a human decided. */
  outcome?: 'decided' | 'timeout' | 'cancelled';
  /** Set when a remembered pattern answered instead of a fresh prompt. */
  viaRemember?: boolean;
};

export type ApprovalDecisionInput = {
  decision: ApprovalDecision;
  remember?: boolean;
  note?: string;
  editedArgs?: Record<string, unknown>;
};

export type ApprovalCallback = (info: ApprovalRequestInfo) => Promise<ApprovalResult>;
export type HarnessEventType = 'tool_dispatch_started' | 'tool_dispatch_completed' | 'approval_requested' | 'approval_granted' | 'approval_denied' | 'timeout_enforced' | 'cancel_requested' | 'escape_denied' | 'resource_limit_exceeded';
export type HarnessEvent = { type: HarnessEventType; taskId: string; tool?: string; path?: string; details?: Record<string, unknown>; timestamp: string };
export type ResourceUsage = { activeProcesses: number; outputBytes: number; diskWrites: number };
export type HarnessContext = ToolExecutionContext & { taskId: string; outputLimit?: number };
export type HarnessConfig = {
  defaultTimeoutMs: number;
  defaultOutputLimit: number;
  maxConcurrentProcesses: number;
  maxDiskWrites: number;
  defaultApprovalPolicy: ApprovalPolicy;
  sandboxEnabled: boolean;
  /** Pluggable policy seam: derive the approval policy per tool/action/path from config. */
  policyFor?: (key: PermissionKey, tool: ToolDefinition) => ApprovalPolicy;
  /**
   * Remembered-approval store, pattern key → decision. Inject one shared
   * Map to scope memory to a whole session across harness instances (the
   * web server does); the default is a private map on this harness.
   * In-memory only: a restart forgets every remembered grant.
   */
  approvalMemory?: Map<string, ApprovalDecision>;
  /** Mode to stamp onto approval requests (TaskRunner wires the live mode). */
  modeFor?: (key: PermissionKey) => AgentMode | undefined;
  /** Orchestrator parent of a (child) task, stamped onto its approval requests. */
  parentTaskIdFor?: (taskId: string) => string | undefined;
  /** Extra task logs approval events are mirrored to (the orchestrator parent's). */
  approvalTaskIds?: (key: PermissionKey) => string[];
};

/** Default wait for a human decision before an approval counts as declined. */
export const DEFAULT_APPROVAL_TIMEOUT_MS = 600_000;

/**
 * Approval wait budget: an explicit value wins, then
 * `DAEDALUS_APPROVAL_TIMEOUT_MS`, then the 10-minute default. A timeout is
 * always a decline, never an allow (fail closed).
 */
export function resolveApprovalTimeoutMs(explicit?: number): number {
  if (typeof explicit === 'number' && Number.isFinite(explicit) && explicit > 0) return Math.floor(explicit);
  const raw = process.env.DAEDALUS_APPROVAL_TIMEOUT_MS;
  if (raw) {
    const parsed = Number(raw);
    if (Number.isFinite(parsed) && parsed > 0) return Math.floor(parsed);
  }
  return DEFAULT_APPROVAL_TIMEOUT_MS;
}

/** Stable store key for a remembered pattern. */
export function approvalPatternKey(pattern: ApprovalRememberPattern): string {
  switch (pattern.kind) {
    case 'command-prefix': return `cmd:${pattern.tool}:${pattern.token}`;
    case 'tool-path': return `path:${pattern.tool}:${pattern.path}`;
    case 'tool': return `tool:${pattern.tool}`;
  }
}

/** `"npm run test"`-style rendering of a run_command call's arguments. */
export function commandLineOf(args: Record<string, unknown>): string | undefined {
  if (typeof args.command !== 'string' || args.command.length === 0) return undefined;
  const rest = Array.isArray(args.args) ? args.args.filter((a): a is string => typeof a === 'string') : [];
  return [args.command, ...rest].join(' ');
}

/**
 * Derive the remember pattern a card may offer for this call: commands by
 * their first token, file operations by tool + exact path, anything else
 * mutating by bare tool name. Returns undefined only when a card could not
 * honestly show what would be remembered (a malformed command call).
 */
export function rememberPatternFor(call: ToolCall, key: PermissionKey): ApprovalRememberPattern | undefined {
  const args = (call.args ?? {}) as Record<string, unknown>;
  if (call.tool === 'run_command') {
    const token = commandLineOf(args)?.split(/\s+/)[0];
    if (!token) return undefined;
    return { kind: 'command-prefix', tool: call.tool, token, label: `run_command starting with "${token}"` };
  }
  if (typeof args.path === 'string' && args.path.length > 0) {
    return { kind: 'tool-path', tool: call.tool, path: args.path, label: `${call.tool} on ${args.path}` };
  }
  if (key.action !== 'read') return { kind: 'tool', tool: call.tool, label: `${call.tool} (any target)` };
  return undefined;
}

/**
 * Build the verbatim preview for an approval card: the command line, the
 * full new file content, or a unified diff for edits. Best-effort — any
 * failure degrades to the raw arguments, never to a blocked approval.
 */
export async function buildApprovalPreview(call: ToolCall, context: { workspaceRoot: string }): Promise<ApprovalPreview> {
  const args = (call.args ?? {}) as Record<string, unknown>;
  try {
    if (call.tool === 'run_command') {
      const command = commandLineOf(args);
      if (command) return { kind: 'command', command, ...(typeof args.cwd === 'string' ? { cwd: args.cwd } : {}) };
    }
    if (call.tool === 'write_file' && typeof args.path === 'string' && typeof args.content === 'string') {
      return { kind: 'write', path: args.path, content: args.content };
    }
    if (call.tool === 'edit_file' && typeof args.path === 'string' && typeof args.old_string === 'string' && typeof args.new_string === 'string') {
      const before = await readWorkspaceFile(context.workspaceRoot, args.path);
      if (before !== undefined && before.split(args.old_string).length - 1 === 1) {
        const patch = renderPatch(args.path, diffLines(before, before.replace(args.old_string, args.new_string)));
        if (patch) return { kind: 'edit', path: args.path, patch };
      }
    }
    if (call.tool === 'edit_search_replace' && typeof args.path === 'string' && typeof args.replacements === 'string') {
      const before = await readWorkspaceFile(context.workspaceRoot, args.path);
      if (before !== undefined) {
        const applied = applySearchReplace(before, args.replacements, args.path);
        if (!('error' in applied)) {
          const patch = renderPatch(args.path, diffLines(before, applied.content));
          if (patch) return { kind: 'edit', path: args.path, patch };
        }
      }
    }
  } catch {
    /* previews are presentation only; the generic args view is the fallback */
  }
  return { kind: 'args', tool: call.tool, args: call.args };
}

async function readWorkspaceFile(root: string, target: string): Promise<string | undefined> {
  const base = resolve(root);
  const path = resolve(base, target);
  if (path !== base && !path.startsWith(base + sep)) return undefined;
  try {
    return await readFile(path, 'utf8');
  } catch {
    return undefined;
  }
}
export const DEFAULT_HARNESS_CONFIG: Omit<HarnessConfig, 'policyFor'> = { defaultTimeoutMs: 30_000, defaultOutputLimit: 64_000, maxConcurrentProcesses: 10, maxDiskWrites: 10_000, defaultApprovalPolicy: 'ask', sandboxEnabled: false };

type PendingApproval = {
  info: ApprovalRequestInfo;
  resolve: (result: ApprovalResult) => void;
  timer?: ReturnType<typeof setTimeout>;
};

/**
 * Approval broker: bridges the Approval Gate (core) and the decision flow over
 * the API/WS (server). A `request` blocks until the matching decision arrives,
 * the wait times out (a decline — approvals fail closed), or the task is
 * cancelled (also a decline). Pending requests are keyed by their approval
 * id; the composite `PermissionKey` form remains for the CLI's key-based
 * prompt and the legacy endpoint.
 */
export class ApprovalBroker {
  #pending = new Map<string, PendingApproval>();
  #listeners = new Set<() => void>();
  readonly #timeoutMs: number;

  constructor(options: { timeoutMs?: number } = {}) {
    this.#timeoutMs = resolveApprovalTimeoutMs(options.timeoutMs);
  }

  /** Key format shared with the harness' permission cache. */
  static keyFor(key: PermissionKey): string {
    return `${key.taskId}:${key.tool}:${key.action}:${key.path ?? ''}`;
  }

  onChange(listener: () => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  pending(taskId?: string): Array<{ key: PermissionKey; policy: ApprovalPolicy; info: ApprovalRequestInfo }> {
    return [...this.#pending.values()]
      .filter((p) => !taskId || p.info.key.taskId === taskId)
      .map((p) => ({ key: p.info.key, policy: p.info.policy, info: p.info }));
  }

  hasPending(approvalId: string): boolean {
    return this.#pending.has(approvalId);
  }

  request(key: PermissionKey, policy: ApprovalPolicy): Promise<ApprovalResult>;
  request(info: ApprovalRequestInfo): Promise<ApprovalResult>;
  request(keyOrInfo: PermissionKey | ApprovalRequestInfo, policy?: ApprovalPolicy): Promise<ApprovalResult> {
    const info: ApprovalRequestInfo = isApprovalRequestInfo(keyOrInfo)
      ? keyOrInfo
      : {
          id: randomUUID(),
          key: keyOrInfo,
          policy: policy ?? 'ask',
          tool: keyOrInfo.tool,
          preview: { kind: 'args', tool: keyOrInfo.tool, args: undefined },
          requestedBy: { taskId: keyOrInfo.taskId },
          createdAt: new Date().toISOString(),
        };
    return new Promise<ApprovalResult>((resolvePromise) => {
      const entry: PendingApproval = { info, resolve: resolvePromise };
      if (this.#timeoutMs > 0) {
        entry.timer = setTimeout(() => {
          if (!this.#pending.delete(info.id)) return;
          this.#notify();
          resolvePromise({ decision: 'deny', outcome: 'timeout' });
        }, this.#timeoutMs);
        entry.timer.unref?.();
      }
      this.#pending.set(info.id, entry);
      this.#notify();
    });
  }

  /** Legacy key-based decision (CLI prompt, legacy endpoint): settles the oldest matching request. */
  decide(key: PermissionKey, decision: ApprovalDecision, remember = false, extra: { note?: string; editedArgs?: Record<string, unknown> } = {}): boolean {
    const target = ApprovalBroker.keyFor(key);
    for (const entry of this.#pending.values()) {
      if (ApprovalBroker.keyFor(entry.info.key) === target) {
        return this.#settle(entry, { decision, remember, ...extra });
      }
    }
    return false;
  }

  decideById(approvalId: string, input: ApprovalDecisionInput): boolean {
    const entry = this.#pending.get(approvalId);
    if (!entry) return false;
    return this.#settle(entry, input);
  }

  /**
   * Settle every request a cancelled task is waiting on (including its
   * orchestrator children's) as a decline, so a stopped run never hangs on
   * a card nobody will answer. Returns how many were settled.
   */
  cancelTasks(taskIds: Iterable<string>): number {
    const ids = new Set(taskIds);
    let settled = 0;
    for (const entry of [...this.#pending.values()]) {
      if (!ids.has(entry.info.key.taskId) && !(entry.info.requestedBy.parentTaskId && ids.has(entry.info.requestedBy.parentTaskId))) continue;
      if (!this.#pending.delete(entry.info.id)) continue;
      if (entry.timer) clearTimeout(entry.timer);
      entry.resolve({ decision: 'deny', outcome: 'cancelled' });
      settled++;
    }
    if (settled > 0) this.#notify();
    return settled;
  }

  #settle(entry: PendingApproval, input: ApprovalDecisionInput): boolean {
    if (!this.#pending.delete(entry.info.id)) return false;
    if (entry.timer) clearTimeout(entry.timer);
    entry.resolve({ ...input, outcome: 'decided' });
    // A remembered grant immediately re-evaluates the queue: requests still
    // waiting on the same pattern are answered by it instead of prompting
    // again (the documented "queued asks ignore the rule I just granted"
    // complaint in other agents).
    if (input.decision === 'grant' && input.remember && entry.info.rememberPattern) {
      const patternKey = approvalPatternKey(entry.info.rememberPattern);
      for (const other of [...this.#pending.values()]) {
        if (!other.info.rememberPattern || approvalPatternKey(other.info.rememberPattern) !== patternKey) continue;
        if (!this.#pending.delete(other.info.id)) continue;
        if (other.timer) clearTimeout(other.timer);
        other.resolve({ decision: 'grant', remember: true, viaRemember: true, outcome: 'decided' });
      }
    }
    this.#notify();
    return true;
  }

  #notify(): void {
    for (const listener of [...this.#listeners]) listener();
  }
}

function isApprovalRequestInfo(value: PermissionKey | ApprovalRequestInfo): value is ApprovalRequestInfo {
  const candidate = value as ApprovalRequestInfo;
  return typeof candidate.id === 'string' && typeof candidate.tool === 'string' && typeof candidate.key === 'object' && candidate.key !== null;
}

/** Controlled dispatch: policy → approval → timeout/cancelled execution → caps → audit. */
export class ExecutionHarness {
  #config: HarnessConfig;
  #deps: { bus?: EventBus; store?: TaskStore };
  #approval?: ApprovalCallback;
  #controllers = new Map<string, AbortController>();
  /**
   * Tasks a cancel was requested for. Cancellation is sticky: a cancel that
   * arrives a hair before an execution registers its controller (the event
   * bus delivers COMMAND_STARTED asynchronously) must still abort the
   * in-flight tool instead of being dropped on the floor.
   */
  #cancelled = new Set<string>();
  readonly #remembered: Map<string, ApprovalDecision>;
  #audit = new Map<string, HarnessEvent[]>();
  #usage: ResourceUsage = { activeProcesses: 0, outputBytes: 0, diskWrites: 0 };

  constructor(config: Partial<HarnessConfig> = {}, deps: { bus?: EventBus; store?: TaskStore } = {}) {
    this.#config = { ...DEFAULT_HARNESS_CONFIG, ...config };
    this.#deps = deps;
    this.#remembered = config.approvalMemory ?? new Map<string, ApprovalDecision>();
  }

  setApprovalCallback(callback: ApprovalCallback): void { this.#approval = callback; }
  getResourceUsage(): ResourceUsage { return { ...this.#usage }; }
  getAuditTrail(taskId: string): HarnessEvent[] { return [...(this.#audit.get(taskId) ?? [])]; }
  cancelTask(taskId: string): void { this.#cancelled.add(taskId); this.#controllers.get(taskId)?.abort(); this.#record('cancel_requested', taskId); }

  async execute(call: ToolCall, tool: ToolDefinition, context: HarnessContext): Promise<ToolResult> {
    const action: PermissionKey['action'] = tool.mutating ? 'write' : tool.name === 'run_command' ? 'execute' : 'read';
    const key: PermissionKey = { taskId: context.taskId, tool: tool.name, action, path: pathFromArgs(call.args) };
    this.#record('tool_dispatch_started', context.taskId, tool.name, key.path);
    const policy = this.#config.policyFor ? this.#config.policyFor(key, tool) : tool.mutating || action === 'execute' ? this.#config.defaultApprovalPolicy : 'auto';
    const approval = await this.#decide(key, policy, call, tool, context);
    if (approval.decision === 'deny') { const result = denied(call.id, denialMessage(approval)); this.#record('approval_denied', context.taskId, tool.name, key.path); this.#record('tool_dispatch_completed', context.taskId, tool.name, key.path, { status: result.status }); return result; }
    // "Edit & allow": the human's edited arguments are what actually runs.
    const effectiveCall: ToolCall = approval.editedArgs
      ? { ...call, args: { ...((call.args ?? {}) as Record<string, unknown>), ...approval.editedArgs } }
      : call;
    if (this.#usage.activeProcesses >= this.#config.maxConcurrentProcesses) { const result = denied(call.id, 'process limit exceeded'); this.#record('resource_limit_exceeded', context.taskId, tool.name); return result; }
    if (this.#usage.diskWrites >= this.#config.maxDiskWrites) { const result = denied(call.id, 'disk write cap exceeded'); this.#record('resource_limit_exceeded', context.taskId, tool.name); return result; }
    const controller = new AbortController(); this.#controllers.set(context.taskId, controller); this.#usage.activeProcesses++;
    if (this.#cancelled.has(context.taskId)) controller.abort();
    // Per-call budget: an explicit host context wins, then the call's own
    // `timeout_ms` argument (clamped to the 600s tool-call cap — this is
    // how generators/installs ask for a long foreground budget), then the
    // tool default, then the harness default.
    const timeoutMs = context.timeoutMs ?? clampCallTimeoutMs((call.args as { timeout_ms?: unknown } | null | undefined)?.timeout_ms) ?? tool.timeoutMs ?? this.#config.defaultTimeoutMs;
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const result = await tool.execute(effectiveCall.args, { ...context, signal: controller.signal, sandbox: this.#config.sandboxEnabled });
      const final = capResult({ ...result, call_id: result.call_id || call.id }, context.outputLimit ?? this.#config.defaultOutputLimit);
      this.#usage.outputBytes += final.output.length;
      if (tool.mutating && final.status === 'ok') this.#usage.diskWrites++;
      if (final.status === 'timeout') this.#record('timeout_enforced', context.taskId, tool.name, key.path);
      this.#record('tool_dispatch_completed', context.taskId, tool.name, key.path, { status: final.status, truncated: final.truncated });
      return final;
    } catch (error) {
      const timedOut = controller.signal.aborted;
      const result: ToolResult = { call_id: call.id, status: timedOut ? 'timeout' : 'error', output: timedOut ? 'execution cancelled or timed out' : String(error), truncated: false, meta: {} };
      if (timedOut) this.#record('timeout_enforced', context.taskId, tool.name, key.path);
      this.#record('tool_dispatch_completed', context.taskId, tool.name, key.path, { status: result.status });
      return result;
    } finally { clearTimeout(timer); this.#controllers.delete(context.taskId); this.#usage.activeProcesses--; }
  }

  async #decide(key: PermissionKey, policy: ApprovalPolicy, call: ToolCall, tool: ToolDefinition, context: HarnessContext): Promise<ApprovalResult> {
    // A remembered pattern answers before any policy prompt — including a
    // remembered denial, which stays denied even under an 'auto' policy.
    const pattern = rememberPatternFor(call, key);
    const patternKey = pattern ? approvalPatternKey(pattern) : undefined;
    if (patternKey) {
      const remembered = this.#remembered.get(patternKey);
      if (remembered) return { decision: remembered, viaRemember: true };
    }
    if (policy === 'auto') return { decision: 'grant' };
    if (policy === 'deny') return { decision: 'deny' };
    const info: ApprovalRequestInfo = {
      id: randomUUID(),
      key,
      policy,
      tool: tool.name,
      preview: await buildApprovalPreview(call, context),
      ...(pattern ? { rememberPattern: pattern } : {}),
      ...(this.#config.modeFor?.(key) ? { mode: this.#config.modeFor(key) } : {}),
      requestedBy: {
        taskId: key.taskId,
        ...(this.#config.parentTaskIdFor?.(key.taskId) ? { parentTaskId: this.#config.parentTaskIdFor(key.taskId) } : {}),
      },
      createdAt: new Date().toISOString(),
    };
    this.#record('approval_requested', key.taskId, key.tool, key.path);
    this.#publishApproval('APPROVAL_REQUESTED', key, { key, policy, approval: info });
    const response = this.#approval ? await this.#approval(info) : { decision: 'deny' as const };
    if (response.remember && patternKey) this.#remembered.set(patternKey, response.decision);
    if (response.decision === 'grant') this.#record('approval_granted', key.taskId, key.tool, key.path); else this.#record('approval_denied', key.taskId, key.tool, key.path);
    this.#publishApproval('APPROVAL_DECIDED', key, {
      key,
      decision: response.decision,
      remember: response.remember ?? false,
      approval_id: info.id,
      ...(response.note ? { note: response.note } : {}),
      ...(response.editedArgs ? { edited: true } : {}),
      ...(response.outcome === 'timeout' ? { timed_out: true } : {}),
      ...(response.outcome === 'cancelled' ? { cancelled: true } : {}),
    });
    return response;
  }

  #record(type: HarnessEventType, taskId: string, tool?: string, path?: string, details?: Record<string, unknown>): void {
    const event: HarnessEvent = { type, taskId, tool, path, details, timestamp: new Date().toISOString() };
    const events = this.#audit.get(taskId) ?? []; events.push(event); this.#audit.set(taskId, events);
  }

  /** Emit a typed Event on the bus (and append to the store log when both are wired). */
  #publish(type: EventType, taskId: string, payload: unknown): void {
    if (!this.#deps.bus) return;
    emitEvent({ bus: this.#deps.bus, store: this.#deps.store }, taskId, undefined, type, payload);
  }

  /**
   * Approval events land on the requesting task's log and, for orchestrator
   * children, are mirrored onto the parent's log so the parent's chat shows
   * the card (with the child's identity on it) and can answer it.
   */
  #publishApproval(type: EventType, key: PermissionKey, payload: unknown): void {
    const targets = this.#config.approvalTaskIds?.(key) ?? [key.taskId];
    for (const taskId of new Set(targets)) this.#publish(type, taskId, payload);
  }
}

/** What the model is told when an approval does not grant. */
function denialMessage(result: ApprovalResult): string {
  if (result.outcome === 'timeout') {
    return 'approval timed out — treated as declined. The action was not run. Do not retry it unchanged; ask the user or propose an alternative.';
  }
  if (result.outcome === 'cancelled') {
    return 'approval cancelled — treated as declined. The action was not run.';
  }
  // The user's own words are the redirect: deliver them verbatim.
  if (result.note) return result.note;
  return 'approval denied';
}

function pathFromArgs(args: unknown): string | undefined { return typeof args === 'object' && args !== null && typeof (args as { path?: unknown }).path === 'string' ? (args as { path: string }).path : undefined; }
function denied(callId: string, output: string): ToolResult { return { call_id: callId, status: 'denied', output, truncated: false, meta: {} }; }
function capResult(result: ToolResult, limit: number): ToolResult { return result.output.length > limit ? { ...result, output: `${result.output.slice(0, limit)}\n…[truncated]`, truncated: true } : result; }
