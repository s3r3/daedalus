import type { Event, FinalReport, TaskSpec, TaskState, ToolCall, ToolResult, ValidationResult } from './contracts.ts';
import { EventBus, emitEvent } from './events.ts';
import { TaskStore } from './persistence.ts';
import { AgentLoop } from './agent/agent-loop.ts';
import { interpretTask } from './agent/interpreter.ts';
import { createDefaultRegistry } from './tools/index.ts';
import { pathInWorkspace } from './tools/filesystem/index.ts';
import type { ToolDefinition } from './tools/registry.ts';
import { readFile } from 'node:fs/promises';
import { changedLineCounts, diffLines, renderPatch } from './tools/filesystem/diff.ts';
import { ApprovalBroker, ExecutionHarness, type ApprovalPolicy, type HarnessConfig } from './execution/index.ts';
import { CommandValidator, type ValidationCommand, type Validator } from './validation/index.ts';
import { createProviderFromSettings } from './providers/index.ts';
import type { LLMProvider } from './providers/llm/types.ts';
import { loadSettings, type Settings } from './settings.ts';

/**
 * Runtime facade (PLAN.md §3.0): the single entry point both thin clients —
 * the CLI and the web backend — call to execute a task. All agent logic stays
 * in core; the interfaces only consume `Event`s and decide exit codes / views.
 */

export type RunOutcome = 'success' | 'partial' | 'failed' | 'stopped';

export type RunResult = {
  state: TaskState;
  events: Event[];
  validation?: ValidationResult;
  outcome: RunOutcome;
  report: FinalReport;
};

export type TaskRunnerOptions = {
  settings?: Settings;
  workspaceRoot: string;
  provider?: LLMProvider;
  bus?: EventBus;
  store?: TaskStore;
  harness?: Partial<HarnessConfig>;
  validator?: Validator;
  validationCommands?: ValidationCommand[];
approvalPolicy?: ApprovalPolicy;
maxIterations?: number;
modelTimeoutMs?: number;
};

export type RunOptions = {
  goal: string;
  taskId?: string;
  onEvent?: (event: Event) => void;
  onApproval?: (key: { taskId: string; tool: string; action: 'read' | 'write' | 'execute'; path?: string }) => Promise<{ decision: 'grant' | 'deny'; remember?: boolean }>;
};

export const EXIT_CODES: Record<RunOutcome, number> = { success: 0, partial: 2, stopped: 3, failed: 1 };

export function exitCodeFor(outcome: RunOutcome): number {
  return EXIT_CODES[outcome];
}

const STOP_REASONS = new Set(['aborted', 'max_iterations', 'max_errors', 'no_progress', 'invalid_action']);

/** Tools whose execution is a process → COMMAND_* events for the terminal surface. */
const COMMAND_TOOLS = new Set(['run_command', 'git_status', 'git_diff']);
/** Tools that target a workspace file → FILE_CHANGED diff evidence. */
const FILE_TOOLS = new Set(['read_file', 'write_file', 'edit_file']);

export class TaskRunner {
  readonly bus: EventBus;
  readonly store: TaskStore;
  readonly approvals: ApprovalBroker;
  readonly harness: ExecutionHarness;
  readonly validator: Validator;
  readonly #settings: Settings;
  readonly #workspaceRoot: string;
  readonly #options: TaskRunnerOptions;

  constructor(options: TaskRunnerOptions) {
    this.#options = options;
    this.#settings = options.settings ?? loadSettings();
    this.#workspaceRoot = options.workspaceRoot;
    this.bus = options.bus ?? new EventBus();
    this.store = options.store ?? new TaskStore(this.#settings.daedalusHome);
    this.approvals = new ApprovalBroker();
    this.harness = new ExecutionHarness(
      { defaultApprovalPolicy: options.approvalPolicy ?? 'ask', ...options.harness },
      { bus: this.bus, store: this.store },
    );
    this.harness.setApprovalCallback((key, policy) => this.approvals.request(key, policy));
    this.validator = options.validator ?? new CommandValidator();
  }

  get workspaceRoot(): string {
    return this.#workspaceRoot;
  }

  /**
   * Per-request model options. An explicit `modelTimeoutMs` (the CLI's
   * `--timeout`) wins over `LLM_TIMEOUT_MS`; when neither is set the provider
   * applies its own default.
   */
  #chatOptions(): { timeout_ms?: number } | undefined {
    const timeoutMs = this.#options.modelTimeoutMs ?? this.#settings.llm.timeoutMs;
    return timeoutMs === null || timeoutMs === undefined ? undefined : { timeout_ms: timeoutMs };
  }

  cancel(taskId: string): void {
    this.harness.cancelTask(taskId);
  }

  async run(options: RunOptions): Promise<RunResult> {
    const startedAt = Date.now();
    const spec: TaskSpec = await interpretTask(options.goal, {
      id: options.taskId,
      repo_path: this.#workspaceRoot,
    });
    const collected: Event[] = [];
    const listener = (event: Event): void => {
      collected.push(event);
      options.onEvent?.(event);
    };
    this.bus.on('*', listener);

    const registry = createDefaultRegistry();
    const provider = this.#options.provider ?? this.#provider();
    const loop = new AgentLoop({
      provider,
      bus: this.bus,
      store: this.store,
      validator: this.validator,
      tools: registry.schemas(),
      stopPolicy: { max_iterations: this.#options.maxIterations ?? 25, max_errors: 5 },
      chatOptions: this.#chatOptions(),
      executeTool: async (call) => {
        const tool = registry.get(call.tool);
        return this.#executeWithObservability(call, tool, spec.id, call.turn_id || undefined);
      },
    });

    let state: TaskState;
    try {
      state = await loop.run(spec);
    } finally {
      this.bus.on('*', listener); // no-op keeps handler identity stable for GC
    }

    const validation = this.#lastValidation(collected);
    const outcome = this.#outcome(state, validation);
    const report: FinalReport = {
      task_id: spec.id,
      outcome: outcome === 'success' ? 'success' : outcome === 'partial' ? 'partial' : 'failed',
      diff: this.#aggregateDiff(collected),
      evidence: [
        ...(validation?.checks.map((c) => `${c.name}: ${c.status} (${c.cmd})`) ?? []),
        ...this.#fileChangeEvidence(collected),
      ],
      metrics: {
        turns: collected.filter((e) => e.type === 'TOOL_CALL_FINISHED').length,
        tool_calls: collected.filter((e) => e.type === 'TOOL_CALL_STARTED').length,
        events: collected.length,
        commands: collected.filter((e) => e.type === 'COMMAND_FINISHED').length,
        files_changed: collected.filter((e) => e.type === 'FILE_CHANGED').length,
        recoveries: collected.filter((e) => e.type === 'RECOVERY_STARTED').length,
        replans: collected.filter((e) => e.type === 'REPLAN_CREATED').length,
        approvals: collected.filter((e) => e.type === 'APPROVAL_REQUESTED').length,
        checks_passed: validation?.checks.filter((c) => c.status === 'pass').length ?? 0,
        checks_failed: validation?.checks.filter((c) => c.status !== 'pass').length ?? 0,
        duration_ms: Date.now() - startedAt,
      },
    };
    this.store.saveReport(spec.id, report);
    return { state, events: collected, validation, outcome, report };
  }

  #aggregateDiff(events: Event[]): string {
    return events
      .filter((e) => e.type === 'FILE_CHANGED')
      .map((e) => (e.payload as { patch?: string }).patch ?? '')
      .filter((patch) => patch.length > 0)
      .join('');
  }

  #fileChangeEvidence(events: Event[]): string[] {
    return events
      .filter((e) => e.type === 'FILE_CHANGED')
      .map((e) => {
        const p = e.payload as { path?: string; operation?: string; added?: number; removed?: number };
        return `${p.operation ?? 'changed'} ${p.path ?? 'unknown'} (+${p.added ?? 0}/-${p.removed ?? 0})`;
      });
  }

  #provider(): LLMProvider {
    return createProviderFromSettings(this.#settings);
  }

  /**
   * Dispatch one tool call through the harness while recording the observable
   * facts the interfaces need: command lifecycle + streamed output for the
   * terminal surface, and per-file diff evidence for the diff viewer (§3.6).
   */
  async #executeWithObservability(
    call: ToolCall,
    tool: ToolDefinition,
    taskId: string,
    turnId: string | undefined,
  ): Promise<ToolResult> {
    const target = { bus: this.bus, store: this.store };
    const isCommand = COMMAND_TOOLS.has(tool.name);
    const args = (call.args ?? {}) as Record<string, unknown>;
    const commandLine = isCommand
      ? `${typeof args.command === 'string' ? args.command : tool.name} ${Array.isArray(args.args) ? (args.args as string[]).join(' ') : ''}`.trim()
      : undefined;
    const before = FILE_TOOLS.has(tool.name) && typeof args.path === 'string' ? await this.#readIfPresent(args.path) : null;

    if (isCommand) {
      emitEvent(target, taskId, turnId, 'COMMAND_STARTED', { call_id: call.id, command: commandLine, tool: tool.name, cwd: typeof args.cwd === 'string' ? args.cwd : this.#workspaceRoot });
    }

    const result = await this.harness.execute(call, tool, {
      workspaceRoot: this.#workspaceRoot,
      taskId,
      onOutput: (chunk: string) => {
        emitEvent(target, taskId, turnId, 'COMMAND_OUTPUT', { call_id: call.id, chunk });
      },
    });

    if (isCommand) {
      emitEvent(target, taskId, turnId, 'COMMAND_FINISHED', {
        call_id: call.id,
        status: result.status,
        exit_code: typeof result.meta.exit_code === 'number' ? result.meta.exit_code : null,
        killed: result.meta.killed === true,
        truncated: result.truncated,
      });
    }

    if (result.status === 'ok' && typeof args.path === 'string' && (tool.mutating || FILE_TOOLS.has(tool.name))) {
      const after = await this.#readIfPresent(args.path);
      if (after !== null) this.#emitFileChanged(taskId, turnId, call.id, args.path, before, after, tool.name);
    }

    return { ...result, call_id: call.id, meta: { ...result.meta, tool: tool.name, mutating: tool.mutating } };
  }

  #emitFileChanged(taskId: string, turnId: string | undefined, callId: string, path: string, before: string | null, after: string, tool: string): void {
    const lines = diffLines(before ?? '', after);
    const counts = changedLineCounts(lines);
    if (lines.length === 0) return;
    emitEvent({ bus: this.bus, store: this.store }, taskId, turnId, 'FILE_CHANGED', {
      call_id: callId,
      path,
      tool,
      operation: before === null ? 'created' : 'modified',
      added: counts.added,
      removed: counts.removed,
      lines,
      patch: renderPatch(path, lines),
    });
  }

  async #readIfPresent(path: string): Promise<string | null> {
    try {
      return await readFile(await pathInWorkspace(this.#workspaceRoot, path), 'utf8');
    } catch {
      return null;
    }
  }

  #lastValidation(events: Event[]): ValidationResult | undefined {
    for (let i = events.length - 1; i >= 0; i--) {
      const event = events[i];
      if (event?.type !== 'VALIDATION_PASSED' && event?.type !== 'VALIDATION_FAILED') continue;
      const payload = event.payload as { result?: ValidationResult };
      return payload.result;
    }
    return undefined;
  }

  #outcome(state: TaskState, validation: ValidationResult | undefined): RunOutcome {
    if (state.status === 'done') return 'success';
    if (state.status === 'failed') {
      return state.last_error !== undefined && STOP_REASONS.has(state.last_error) ? 'stopped' : 'failed';
    }
    return validation !== undefined ? 'partial' : 'stopped';
  }
}