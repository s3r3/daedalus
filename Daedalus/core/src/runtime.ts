import type { AgentMode, Attachment, Event, FinalReport, ModelStrategy, ProviderConfig, TaskSpec, TaskState, ToolCall, ToolResult, ValidationResult } from './contracts.ts';
import { EventBus, emitEvent } from './events.ts';
import { TaskStore } from './persistence.ts';
import { AgentLoop } from './agent/agent-loop.ts';
import type { ToolOutputLimits } from './agent/tool-output.ts';
import { DefaultContextManager } from './agent/context.ts';
import { interpretTask } from './agent/interpreter.ts';
import { createPlan } from './agent/planner.ts';
import { loadProjectRules } from './agent/rules.ts';
import { guardEditedFile } from './agent/edit-guard.ts';
import { loadHooksConfig, runPostToolHooks, runPreToolHooks, type HooksConfig } from './agent/hooks.ts';
import { loadAgents, workspaceAgentsDir, type AgentDefinition } from './agents/index.ts';
import { createTaskWorktree, worktreeChangedFiles } from './worktree.ts';
import { createDefaultRegistry, editSearchReplaceTool } from './tools/index.ts';
import { pathInWorkspace } from './tools/filesystem/index.ts';
import type { ToolDefinition } from './tools/registry.ts';
import { readFile } from 'node:fs/promises';
import { isAbsolute, relative, resolve } from 'node:path';
import { changedLineCounts, diffLines, renderPatch } from './tools/filesystem/diff.ts';
import { ApprovalBroker, ExecutionHarness, type ApprovalPolicy, type HarnessConfig } from './execution/index.ts';
import { CommandValidator, validationSatisfied, type ValidationCommand, type Validator } from './validation/index.ts';
import { createProviderFromSettings } from './providers/index.ts';
import { OpenAICompatProvider } from './providers/llm/openai-compat.ts';
import { ModelPoolProvider, asModelController, normalizeModelList } from './providers/llm/model-pool.ts';
import { resolvePromptFamily } from './agent/prompt-dialects.ts';
import { reviewDiff } from './agent/review.ts';
import { loadPins } from './pins.ts';
import type { EditFormat, ModelTier, PromptFamily, PromptFamilySetting, ReviewGateReport } from './contracts.ts';
import { TextProtocolProvider, type ProtocolSwitchInfo } from './providers/llm/text-protocol.ts';
import { ModeController } from './interaction/modes.ts';
import { ProviderRegistry } from './interaction/providers.ts';
import { OrchestratorRunner, decomposeTask, type ChildTaskInput } from './interaction/orchestrator.ts';
import { McpManager, loadMcpConfig, type McpServerConfig, type McpServerStatus } from './mcp/index.ts';
import { LspManager, loadLspConfig, type LspServerConfig, type LspServerStatus } from './lsp/index.ts';
import { SkillRegistry, createReadSkillTool, loadSkills, resolveSkillSearchDirs, type SkillInfo, type SkillSearchDir } from './skills/index.ts';
import type { LLMProvider } from './providers/llm/types.ts';
import { loadSettings, resolveDaedalusHome, type Settings } from './settings.ts';

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
  providerRegistry?: ProviderRegistry;
  providerId?: string;
  model?: string;
  models?: string[];
  modelStrategy?: ModelStrategy;
  mode?: AgentMode;
  modeController?: ModeController;
  autoApprove?: boolean;
  /** Surface provider thought text as THOUGHT events. Defaults to settings.session.thinking (on). */
  thinking?: boolean;
  bus?: EventBus;
  store?: TaskStore;
  harness?: Partial<HarnessConfig>;
  validator?: Validator;
  validationCommands?: ValidationCommand[];
  approvalPolicy?: ApprovalPolicy;
  maxIterations?: number;
  modelTimeoutMs?: number;
  /** MCP servers to bridge as tools; defaults to `<workspace>/.daedalus/mcp.json`. */
  mcpServers?: McpServerConfig[];
  /** Language servers for lsp_diagnostics; defaults to `<workspace>/.daedalus/lsp.json`. */
  lspServers?: LspServerConfig[];
  /** Extra skill directories scanned between the workspace dir and the global dirs (see skills loader resolution). */
  skillDirs?: Array<string | SkillSearchDir>;
  /** Run each task in its own git worktree instead of the shared workspace (requires git). */
  isolation?: 'worktree';
  /** Run project hooks (.daedalus/hooks.json) around tool calls. Defaults to settings.hooks (on). */
  hooks?: boolean;
  /** Preloaded hooks config (worktree runs load it from the main workspace). */
  hooksConfig?: HooksConfig;
  /** Post-edit syntax/LSP guard on files the agent writes. Defaults to settings.editGuard (on). */
  editGuard?: boolean;
  /** Context-window token budget for the meter/condense. Defaults to settings.context.limitTokens (128k). */
  contextLimitTokens?: number;
  /** Condense older tool outputs past 70% of the context limit. Defaults to settings.context.condense (on). */
  condense?: boolean;
  /** Tool-output caps + spill (head+tail in model context, full text in the task store). Defaults to settings.toolOutput. */
  toolOutput?: ToolOutputLimits;
  /** Cheap helper model used only to title tasks (DAEDALUS_HELPER_MODEL). */
  helperModel?: string;
  /** Injected helper provider (tests); production builds one from settings. */
  helperProvider?: LLMProvider;
  /** Capability tiers per model (tailor suite); merged over settings tiers, under the provider config's tiers. */
  modelTiers?: Record<string, ModelTier>;
  /** Tier routing on/off (tailor suite). Defaults to settings.tailor.modelRouting (on). */
  modelRouting?: boolean;
  /** Quality escalation on/off (tailor suite). Defaults to settings.tailor.qualityEscalation (on). */
  qualityEscalation?: boolean;
  /** Strong-model review gate (tailor suite). Defaults to settings.tailor.reviewGate (off). */
  reviewGate?: boolean;
  /** Reviewer factory for the gate (tests); production binds the strongest model on the run's endpoint. */
  reviewProviderFor?: (model: string) => LLMProvider | undefined;
  /** Edit dialect (tailor suite): `search_replace` adds the SEARCH/REPLACE edit tool. Defaults to the provider config / settings. */
  editFormat?: EditFormat;
  /** Prompt dialect family override (tailor suite). Defaults to the provider config / settings (`auto`). */
  promptFamily?: PromptFamilySetting;
};

/** Live snapshot of the extension systems (MCP / LSP / skills / agents) for UIs. */
export type ExtensionStatus = {
  mcp: McpServerStatus[];
  lsp: LspServerStatus[];
  skills: SkillInfo[];
  agents: AgentDefinition[];
};

export type RunOptions = {
  goal: string;
  taskId?: string;
  mode?: AgentMode;
  thinking?: boolean;
  providerId?: string;
  model?: string;
  models?: string[];
  modelStrategy?: ModelStrategy;
  attachments?: Attachment[];
  parentTaskId?: string;
  autoApprove?: boolean;
  maxIterations?: number;
  maxErrors?: number;
  /** Name of a file-defined subagent (.daedalus/agents/<name>.md) running this task. */
  agentName?: string;
  /** Subagent definition already resolved by a parent run (worktree re-dispatch); set automatically. */
  agentDefinition?: AgentDefinition;
  /** Tool allowlist override; intersected with the mode's visible tools. Undefined = mode decides. */
  toolAllowlist?: string[];
  /** Run this task in its own git worktree (overrides TaskRunnerOptions.isolation). */
  isolation?: 'worktree';
  children?: Array<{ goal: string; mode?: AgentMode; budget?: { max_iterations: number; max_errors: number }; agent?: string; isolation?: 'worktree' }>;
  onEvent?: (event: Event) => void;
  onApproval?: (key: { taskId: string; tool: string; action: 'read' | 'write' | 'execute'; path?: string }) => Promise<{ decision: 'grant' | 'deny'; remember?: boolean }>;
};

export const EXIT_CODES: Record<RunOutcome, number> = { success: 0, partial: 2, stopped: 3, failed: 1 };

export function exitCodeFor(outcome: RunOutcome): number {
  return EXIT_CODES[outcome];
}

function settingsThinking(settings: Settings): boolean {
  // loadSettings always supplies session.thinking; hand-built Settings objects
  // in older fixtures may omit it, and thinking defaults on.
  return settings.session?.thinking !== false;
}

const STOP_REASONS = new Set(['aborted', 'max_iterations', 'max_errors', 'no_progress', 'invalid_action']);

/** Tools whose execution is a process → COMMAND_* events for the terminal surface. */
const COMMAND_TOOLS = new Set(['run_command', 'git_status', 'git_diff']);
/** Tools that target a workspace file → FILE_CHANGED diff evidence. */
const FILE_TOOLS = new Set(['read_file', 'write_file', 'edit_file', 'edit_search_replace', 'create_dir']);

export class TaskRunner {
  readonly bus: EventBus;
  readonly store: TaskStore;
  readonly approvals: ApprovalBroker;
  readonly harness: ExecutionHarness;
  readonly validator: Validator;
  readonly modeController: ModeController;
  readonly providerRegistry?: ProviderRegistry;
  readonly #settings: Settings;
  readonly #workspaceRoot: string;
  readonly #options: TaskRunnerOptions;
  readonly #activeLoops = new Map<string, AgentLoop>();
  #extensionStatus: ExtensionStatus = { mcp: [], lsp: [], skills: [], agents: [] };
  /** Language servers of the in-flight run, used by the edit guard. */
  #activeLsp: LspManager | undefined;

  constructor(options: TaskRunnerOptions) {
    this.#options = options;
    this.#settings = options.settings ?? loadSettings();
    this.#workspaceRoot = options.workspaceRoot;
    this.bus = options.bus ?? new EventBus();
    this.store = options.store ?? new TaskStore(resolveDaedalusHome(this.#settings.daedalusHome, options.workspaceRoot));
    this.approvals = new ApprovalBroker();
    this.modeController = options.modeController ?? new ModeController(options.mode ?? 'auto', options.autoApprove ?? options.approvalPolicy === 'auto');
    if (options.autoApprove !== undefined) this.modeController.setAutoApprove(options.autoApprove);
    this.providerRegistry = options.providerRegistry;
    const userPolicyFor = options.harness?.policyFor;
    this.harness = new ExecutionHarness(
      {
        defaultApprovalPolicy: options.approvalPolicy ?? 'ask',
        ...options.harness,
        policyFor: (key, tool) => {
          const modePolicy = this.modeController.approvalFor(tool.name);
          if (!modePolicy.visible) return 'deny';
          if (key.action === 'read') return 'auto';
          if (options.approvalPolicy === 'deny') return 'deny';
          if (userPolicyFor) return userPolicyFor(key, tool);
          return modePolicy.approval;
        },
      },
      { bus: this.bus, store: this.store },
    );
    this.harness.setApprovalCallback((key, policy) => this.approvals.request(key, policy));
    this.validator = options.validator ?? new CommandValidator();
  }

  get workspaceRoot(): string {
    return this.#workspaceRoot;
  }

  /** Status of MCP servers, language servers, and skills from the latest run. */
  get extensionStatus(): ExtensionStatus {
    return this.#extensionStatus;
  }

  /**
   * Connect the extension systems for one run: MCP servers become bridged
   * tools, configured language servers back `lsp_diagnostics`, and skills on
   * disk become a `read_skill` tool plus a context summary. Everything is
   * best-effort — a broken extension is recorded in `extensionStatus`, never
   * thrown — and `close()` must run when the run ends.
   */
  async #prepareExtensions(): Promise<{ tools: ToolDefinition[]; skills: SkillRegistry; lsp: LspManager; close: () => Promise<void> }> {
    const mcpServers = this.#options.mcpServers ?? (await loadMcpConfig(this.#workspaceRoot)).servers;
    const lspServers = this.#options.lspServers ?? (await loadLspConfig(this.#workspaceRoot)).servers;
    // Workspace skills first (they shadow same-name globals), then any
    // caller-provided dirs, then the global directories (~/.daedalus/skills,
    // other AI tools' skill folders) so global skills work in every workspace.
    const searchDirs = resolveSkillSearchDirs(this.#workspaceRoot);
    const skillDirs: Array<string | SkillSearchDir> = [
      ...searchDirs.slice(0, 1),
      ...(this.#options.skillDirs ?? []),
      ...searchDirs.slice(1),
    ];
    const skills = await loadSkills(skillDirs);
    const agents = await loadAgents([workspaceAgentsDir(this.#workspaceRoot)]);

    const tools: ToolDefinition[] = [];
    if (skills.size > 0) tools.push(createReadSkillTool(skills));

    const mcp = new McpManager(mcpServers);
    if (mcpServers.length > 0) {
      await mcp.connectAll();
      tools.push(...mcp.tools());
    }

    const lsp = new LspManager(lspServers);
    if (lspServers.length > 0) tools.push(lsp.createDiagnosticsTool());

    this.#extensionStatus = { mcp: mcp.status(), lsp: lsp.status(), skills: skills.list(), agents: agents.list() };

    return {
      tools,
      skills,
      lsp,
      close: async () => {
        await mcp.closeAll().catch(() => undefined);
        await lsp.closeAll().catch(() => undefined);
        this.#extensionStatus = { mcp: mcp.status(), lsp: lsp.status(), skills: skills.list(), agents: agents.list() };
      },
    };
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

  #editGuardEnabled(): boolean {
    return this.#options.editGuard ?? (this.#settings.editGuard !== false);
  }

  /** Plain-language model failure for the final report, when the run died on provider errors. */
  #modelFailureEvidence(events: Event[], state: TaskState): string | undefined {
    for (let i = events.length - 1; i >= 0; i--) {
      const event = events[i];
      if (event?.type !== 'TASK_COMPLETED') continue;
      const payload = event.payload as { error_summary?: unknown };
      if (typeof payload.error_summary === 'string' && payload.error_summary.length > 0) return payload.error_summary;
    }
    if (state.status === 'failed' && state.last_error && /^(auth|content_policy|fatal_provider_error):/.test(state.last_error)) {
      return state.last_error;
    }
    return undefined;
  }

  /** Evidence lines for a validation result: profile warning first, then one line per check. */
  #validationEvidence(validation: ValidationResult | undefined): string[] {
    if (!validation) return [];
    return [
      ...(validation.warning ? [`validation profile warning: ${validation.warning}`] : []),
      ...(validation.checks.length === 0 ? ['validation skipped: no validation commands configured for this workspace'] : []),
      ...validation.checks.map((check) => `${check.name}: ${check.status} (${check.cmd})${check.source === 'profile' ? ' [profile]' : ''}`),
    ];
  }

  /**
   * Ask the configured helper model for a short task title. Deliberately
   * fail-silent with a 15s cap (real routed providers often need more than
   * a few seconds for a first token): a title is presentation sugar, and a
   * slow or broken helper must never delay or fail the real task.
   */
  async #helperTitle(goal: string): Promise<string | undefined> {
    const model = (this.#options.helperModel ?? this.#settings.llm.helperModel ?? '').trim();
    if (!model && !this.#options.helperProvider) return undefined;
    try {
      const provider = this.#options.helperProvider ?? new OpenAICompatProvider({
        baseUrl: this.#settings.llm.baseUrl,
        apiKey: this.#settings.llm.apiKey,
        model,
      });
      const response = await provider.chat(
        [{ role: 'user', content: `Write a short title (3-6 words, no quotes, no trailing period) for this software engineering task:\n\n${goal}` }],
        undefined,
        { timeout_ms: 15_000 },
      );
      const text = typeof response.message.content === 'string' ? response.message.content : '';
      const title = text.split('\n').map((line) => line.trim()).find((line) => line.length > 0)
        ?.replace(/^["'`]+|["'`]+$/g, '').trim();
      return title ? title.slice(0, 80) : undefined;
    } catch {
      return undefined;
    }
  }

  cancel(taskId: string): void {
    this.harness.cancelTask(taskId);
    // A runner executes one user task at a time (plus its orchestrator
    // children), so cancelling it stops every loop currently active here.
    for (const [activeTaskId, loop] of this.#activeLoops) loop.stop(activeTaskId);
  }

  async run(options: RunOptions): Promise<RunResult> {
    const startedAt = Date.now();
    // File-defined subagent (.daedalus/agents/<name>.md): an unknown name is
    // a clear error, never a silent fallback to a default agent. A worktree
    // re-dispatch passes the definition it already resolved, because the
    // agents dir may only exist in the main workspace.
    let agent: AgentDefinition | undefined = options.agentDefinition;
    if (!agent && options.agentName) {
      const registry = await loadAgents([workspaceAgentsDir(this.#workspaceRoot)]);
      agent = registry.get(options.agentName);
      if (!agent) {
        const defined = registry.list().map((definition) => definition.name);
        throw new Error(
          `unknown agent "${options.agentName}": no .daedalus/agents/${options.agentName}.md exists in ${this.#workspaceRoot}` +
          (defined.length ? ` (defined: ${defined.join(', ')})` : ' (no agents are defined in this workspace)'),
        );
      }
    }
    const effectiveMode = options.mode ?? agent?.mode;
    const effectiveOptions: RunOptions = agent
      ? { ...options, model: options.model ?? agent.model, mode: effectiveMode }
      : options;
    if (effectiveMode) this.modeController.set(effectiveMode);
    if (options.autoApprove !== undefined) this.modeController.setAutoApprove(options.autoApprove);
    const modelConfig = this.#modelConfig(effectiveOptions);
    const rules = await loadProjectRules(this.#workspaceRoot, {
      globalHome: resolveDaedalusHome(this.#settings.daedalusHome, this.#workspaceRoot),
    });
    const spec: TaskSpec = await interpretTask(options.goal, {
      id: options.taskId,
      repo_path: this.#workspaceRoot,
      mode: effectiveMode ?? this.modeController.mode,
      provider_id: options.providerId ?? this.#options.providerId,
      model: effectiveOptions.model ?? this.#options.model ?? modelConfig.models[0],
      models: modelConfig.models.length > 0 ? modelConfig.models : undefined,
      model_strategy: modelConfig.models.length > 1 ? modelConfig.strategy : undefined,
      attachments: options.attachments,
      parent_task_id: options.parentTaskId,
      thinking: options.thinking ?? this.#options.thinking ?? settingsThinking(this.#settings),
      rules_files: rules.files.length > 0 ? rules.files : undefined,
      agent: options.agentName,
    });
    // Helper-model title (fail-silent, 5s cap): purely cosmetic, so any
    // failure leaves the run exactly as it was without one.
    if (!options.parentTaskId && !spec.title) {
      const title = await this.#helperTitle(spec.goal);
      if (title) spec.title = title;
    }
    const collected: Event[] = [];
    const listener = (event: Event): void => {
      collected.push(event);
      options.onEvent?.(event);
    };
    this.bus.on('*', listener);

    if (spec.mode === 'orchestrator' && !options.parentTaskId) {
      return this.#runOrchestrated(options, spec, collected, startedAt);
    }

    const isolation = options.isolation ?? this.#options.isolation;
    if (isolation === 'worktree') {
      return this.#runInWorktree(options, spec, agent);
    }

    const extensions = await this.#prepareExtensions();
    this.#activeLsp = extensions.lsp;
    const registry = createDefaultRegistry();
    for (const tool of extensions.tools) {
      try {
        registry.register(tool);
      } catch {
        // A name collision with a built-in tool is skipped, never fatal.
      }
    }
    // Tailor suite, resolved once per run from runner options < provider
    // config < settings: capability tiers (pool routing + escalation),
    // the edit dialect, the prompt-dialect family for the primary model,
    // and the user's pinned workspace paths for the prompt overview.
    const selection = this.#providerSelection(effectiveOptions);
    const tiers = this.#tiersFor(effectiveOptions);
    const qualityEscalation = this.#options.qualityEscalation ?? (this.#settings.tailor?.qualityEscalation !== false);
    const editFormat: EditFormat = this.#options.editFormat ?? selection?.config.editFormat ?? this.#settings.llm.editFormat ?? 'native';
    const promptFamily: PromptFamily = resolvePromptFamily(
      this.#options.promptFamily ?? selection?.config.promptFamily ?? this.#settings.llm.promptFamily,
      spec.model ?? modelConfig.models[0],
    );
    const pins = await loadPins(this.store.root);
    if (editFormat === 'search_replace') {
      try {
        registry.register(editSearchReplaceTool);
      } catch {
        // Already registered (e.g. a future default): keep the existing one.
      }
    }
    // Subagent tool allowlist: the model only sees allowed tools, and
    // execution denies anything else (defence in depth — a hallucinated
    // call name must not slip past the schema filter).
    const allowlist = options.toolAllowlist ?? agent?.tools;
    const toolSchemas = allowlist
      ? registry.schemas().filter((schema) => allowlist.includes(schema.function.name))
      : registry.schemas();
    // Project hooks (.daedalus/hooks.json): trusted workspace config, on
    // unless DAEDALUS_HOOKS=off; skipped for read-only ask/plan modes.
    const hooksEnabled = (this.#options.hooks ?? (this.#settings.hooks !== false)) && spec.mode !== 'ask' && spec.mode !== 'plan';
    const hooksConfig = hooksEnabled
      ? this.#options.hooksConfig ?? (await loadHooksConfig(this.#workspaceRoot)).hooks
      : undefined;
    const provider = this.#options.provider ?? this.#providerFor(effectiveOptions, spec.id);
    const loop = new AgentLoop({
      provider,
      bus: this.bus,
      store: this.store,
      context: new DefaultContextManager({
        workspaceRoot: this.#workspaceRoot,
        visionEnabled: this.#visionEnabledFor(effectiveOptions),
        skills: extensions.skills.list(),
        rules: rules.text ? rules.text : undefined,
        rulesFiles: rules.files,
        agentInstructions: agent?.instructions,
        agentName: agent?.name,
        promptFamily,
        pins,
      }),
      validator: this.validator,
      tools: toolSchemas,
      stopPolicy: { max_iterations: options.maxIterations ?? this.#options.maxIterations ?? 25, max_errors: options.maxErrors ?? 5 },
      chatOptions: this.#chatOptions(),
      modeController: this.modeController,
      thinking: spec.thinking ?? options.thinking ?? this.#options.thinking ?? settingsThinking(this.#settings),
      contextLimitTokens: this.#options.contextLimitTokens ?? this.#settings.context?.limitTokens,
      condense: this.#options.condense ?? (this.#settings.context?.condense !== false),
      toolOutput: this.#options.toolOutput ?? this.#settings.toolOutput,
      modelTiers: tiers,
      qualityEscalation,
      executeTool: async (call) => {
        if (allowlist && !allowlist.includes(call.tool)) {
          return {
            call_id: call.id,
            status: 'denied',
            output: `tool ${call.tool} is not allowed for this run${agent ? ` (subagent "${agent.name}" allowlist: ${allowlist.join(', ')})` : ''}`,
            truncated: false,
            meta: { tool: call.tool, reason: 'tool_allowlist' },
          };
        }
        // A hallucinated or dialect-gated tool name (e.g. edit_search_replace
        // while edit_format is native) gets a clean denial the model can
        // react to, not a thrown registry error that eats the error budget.
        let tool: ToolDefinition;
        try {
          tool = registry.get(call.tool);
        } catch {
          return {
            call_id: call.id,
            status: 'denied',
            output: `tool ${call.tool} is not available in this run`,
            truncated: false,
            meta: { tool: call.tool, reason: 'unknown_tool' },
          };
        }
        return this.#executeWithObservability(call, tool, spec.id, call.turn_id || undefined, hooksConfig);
      },
    });

    let state: TaskState;
    this.#activeLoops.set(spec.id, loop);
    try {
      state = await loop.run(spec);
    } finally {
      this.#activeLoops.delete(spec.id);
      this.#activeLsp = undefined;
      await extensions.close();
      this.bus.on('*', listener); // no-op keeps handler identity stable for GC
    }

    const validation = this.#lastValidation(collected);
    // Cross-model review gate (tailor suite, default off): a strong-model
    // read of the diff before completion is declared. Report-only — a
    // blocking verdict demotes success to partial; it never blocks the
    // run itself (fail-open inside the gate).
    const review = await this.#reviewGate(effectiveOptions, spec, state, provider, collected, rules.text ? rules.text : undefined);
    let outcome = this.#outcome(state, validation);
    if (review?.blocking && outcome === 'success') outcome = 'partial';
    const modelFailureEvidence = this.#modelFailureEvidence(collected, state);
    const report: FinalReport = {
      task_id: spec.id,
      outcome: outcome === 'success' ? 'success' : outcome === 'partial' ? 'partial' : 'failed',
      diff: this.#aggregateDiff(collected),
      evidence: [
        ...(modelFailureEvidence ? [`model failure: ${modelFailureEvidence}`] : []),
        ...this.#validationEvidence(validation),
        ...this.#fileChangeEvidence(collected),
        ...(review ? [
          `review by ${review.model}: ${review.blocking ? 'blocking issues found' : 'no blocking issues'} (${review.findings.length} finding${review.findings.length === 1 ? '' : 's'})`,
          ...review.findings.map((finding) => `review [${finding.severity}] ${finding.file}${finding.line ? `:${finding.line}` : ''} — ${finding.message}`),
        ] : []),
      ],
      ...(review ? { review } : {}),
      ...(spec.title ? { title: spec.title } : {}),
      ...(spec.rules_files?.length ? { rules_files: spec.rules_files } : {}),
      ...(validation?.source ? { validation_source: validation.source } : {}),
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
        review_findings: review?.findings.length ?? 0,
        review_blocking: review?.blocking ? 1 : 0,
        duration_ms: Date.now() - startedAt,
      },
    };
    this.store.saveReport(spec.id, report);
    return { state, events: collected, validation, outcome, report };
  }

  /**
   * Cross-model review gate (tailor suite, default off): when a task that
   * changed files was driven by a non-strongest pool model, the pool's
   * strongest model reviews the diff before completion is declared. The
   * verdict is recorded as a REVIEW_COMPLETED event and on the report; a
   * blocking (high-severity) verdict demotes the outcome to partial.
   * Repair loops are quality escalation's job — the gate never re-runs
   * the agent. Entirely fail-open: any problem skips the gate silently.
   */
  async #reviewGate(
    options: RunOptions,
    spec: TaskSpec,
    state: TaskState,
    provider: LLMProvider,
    events: Event[],
    rulesText: string | undefined,
  ): Promise<ReviewGateReport | undefined> {
    try {
      const enabled = this.#options.reviewGate ?? this.#settings.tailor?.reviewGate === true;
      if (!enabled || state.status !== 'done') return undefined;
      const diff = this.#aggregateDiff(events);
      if (!diff.trim()) return undefined;
      const controller = asModelController(provider);
      if (!controller || controller.poolModels.length < 2) return undefined;
      const strongest = controller.strongestModel();
      if (!strongest) return undefined;
      // The author is the task's assigned model (spec.model; the pool
      // primary in the router path). Phase routing may borrow the strong
      // model for individual turns, but the task still counts as authored
      // by the model it was assigned to.
      const author = spec.model ?? controller.currentModel();
      if (!author || author === strongest) return undefined;
      const reviewer = this.#reviewerProvider(options, strongest);
      if (!reviewer) return undefined;
      const result = await reviewDiff({ provider: reviewer, diff, rulesText, source: 'task-diff' });
      const blocking = result.findings.some((finding) => finding.severity === 'high');
      emitEvent({ bus: this.bus, store: this.store }, spec.id, undefined, 'REVIEW_COMPLETED', {
        model: strongest,
        author_model: author,
        blocking,
        findings: result.findings,
        truncated: result.truncated,
      });
      await this.bus.drain();
      return { model: strongest, author_model: author, blocking, findings: result.findings };
    } catch {
      return undefined;
    }
  }

  /** Bind a one-shot reviewer to a model on the run's endpoint (fail-open: undefined = skip the gate). */
  #reviewerProvider(options: RunOptions, model: string): LLMProvider | undefined {
    if (this.#options.reviewProviderFor) return this.#options.reviewProviderFor(model);
    const selection = this.#providerSelection(options);
    const defaultTimeoutMs = this.#settings.llm.timeoutMs ?? undefined;
    if (selection) {
      const { config } = selection;
      return new OpenAICompatProvider({
        baseUrl: config.baseUrl || this.#settings.llm.baseUrl,
        apiKey: config.apiKey ?? '',
        model,
        defaultTimeoutMs,
      });
    }
    // An injected provider with no registry/settings backing cannot be
    // re-bound to another model; guessing an endpoint would be worse.
    if (this.#options.provider) return undefined;
    return new OpenAICompatProvider({
      baseUrl: this.#settings.llm.baseUrl,
      apiKey: this.#settings.llm.apiKey,
      model,
      defaultTimeoutMs,
    });
  }

  /**
   * Run one task in its own git worktree (see worktree.ts). The task sees
   * only the worktree checkout; when it finishes, the changed files are
   * recorded on the report and the worktree + branch are kept for review —
   * nothing is merged back automatically (`daedalus apply <task-id>` does
   * that on demand). Extension configs are preloaded from the main
   * workspace so MCP/LSP/skills/agents/hooks behave as in the real
   * project even when their config files are not part of the checkout.
   * Throws a clear error before anything runs when git is unavailable or
   * the workspace is not a git repository.
   */
  async #runInWorktree(options: RunOptions, spec: TaskSpec, agent: AgentDefinition | undefined): Promise<RunResult> {
    const record = await createTaskWorktree({
      workspaceRoot: this.#workspaceRoot,
      daedalusHome: this.store.root,
      taskId: spec.id,
    });
    this.store.saveWorktreeRecord(spec.id, record);
    const inner = new TaskRunner({
      settings: this.#settings,
      workspaceRoot: record.path,
      store: this.store,
      bus: this.bus,
      modeController: this.modeController,
      providerRegistry: this.providerRegistry,
      provider: this.#options.provider,
      providerId: this.#options.providerId,
      harness: this.#options.harness,
      validator: this.validator,
      approvalPolicy: this.#options.approvalPolicy,
      autoApprove: this.#options.autoApprove,
      thinking: this.#options.thinking,
      maxIterations: this.#options.maxIterations,
      modelTimeoutMs: this.#options.modelTimeoutMs,
      editGuard: this.#options.editGuard,
      contextLimitTokens: this.#options.contextLimitTokens,
      condense: this.#options.condense,
      toolOutput: this.#options.toolOutput,
      modelTiers: this.#options.modelTiers,
      modelRouting: this.#options.modelRouting,
      qualityEscalation: this.#options.qualityEscalation,
      reviewGate: this.#options.reviewGate,
      reviewProviderFor: this.#options.reviewProviderFor,
      editFormat: this.#options.editFormat,
      promptFamily: this.#options.promptFamily,
      helperModel: this.#options.helperModel,
      helperProvider: this.#options.helperProvider,
      hooks: this.#options.hooks,
      hooksConfig: this.#options.hooksConfig ?? (await loadHooksConfig(this.#workspaceRoot)).hooks,
      mcpServers: (await loadMcpConfig(this.#workspaceRoot)).servers,
      lspServers: (await loadLspConfig(this.#workspaceRoot)).servers,
      skillDirs: resolveSkillSearchDirs(this.#workspaceRoot),
    });
    const innerResult = await inner.run({
      ...options,
      taskId: spec.id,
      isolation: undefined,
      onEvent: undefined,
      agentDefinition: agent,
    });
    const filesChanged = await worktreeChangedFiles(record.path).catch(() => [] as string[]);
    const report: FinalReport = {
      ...innerResult.report,
      worktree: { path: record.path, branch: record.branch, files_changed: filesChanged },
    };
    this.store.saveReport(spec.id, report);
    return { ...innerResult, report };
  }

  async #runOrchestrated(options: RunOptions, spec: TaskSpec, collected: Event[], startedAt: number): Promise<RunResult> {
    const target = { bus: this.bus, store: this.store };
    const plan = await createPlan(spec);
    let state: TaskState = {
      ...spec,
      mode: 'orchestrator',
      turns: 0,
      plan,
      steps: plan.steps,
      status: 'active',
    };
    emitEvent(target, spec.id, undefined, 'TASK_STARTED', { spec, orchestrated: true });
    emitEvent(target, spec.id, undefined, 'PLAN_CREATED', { plan });
    this.store.saveState(spec.id, state);

    const decomposed = options.children ?? (await decomposeTask(spec)).map((child) => ({
      goal: child.goal,
      mode: child.mode,
      budget: child.budget,
      agent: child.agent,
      isolation: child.isolation,
    }));
    // File-defined subagents are validated up front: a child naming an
    // agent that does not exist fails the whole run with a clear error
    // before any child starts, instead of half-running and degrading.
    const agentRegistry = await loadAgents([workspaceAgentsDir(this.#workspaceRoot)]);
    for (const child of decomposed) {
      if (child.agent && !agentRegistry.get(child.agent)) {
        const defined = agentRegistry.list().map((definition) => definition.name);
        throw new Error(
          `unknown agent "${child.agent}" named by an orchestrator child task: no .daedalus/agents/${child.agent}.md exists in ${this.#workspaceRoot}` +
          (defined.length ? ` (defined: ${defined.join(', ')})` : ' (no agents are defined in this workspace)'),
        );
      }
    }
    const inputs: ChildTaskInput[] = decomposed.map((child) => ({
      goal: child.goal,
      mode: child.mode,
      budget: child.budget,
      ...(child.agent ? { agent: child.agent } : {}),
      ...(child.isolation ? { isolation: child.isolation } : {}),
    }));

    const orchestrator = new OrchestratorRunner({
      bus: this.bus,
      store: this.store,
      totalBudget: { max_iterations: options.maxIterations ?? this.#options.maxIterations ?? 25, max_errors: options.maxErrors ?? 5 },
      executeChild: async (child) => {
        const definition = child.agent ? agentRegistry.get(child.agent) : undefined;
        const childResult = await this.run({
          goal: child.goal,
          taskId: child.id,
          mode: child.mode ?? definition?.mode ?? 'auto',
          parentTaskId: spec.id,
          providerId: options.providerId,
          model: options.model,
          models: options.models ?? this.#options.models,
          modelStrategy: options.modelStrategy ?? this.#options.modelStrategy,
          attachments: options.attachments,
          thinking: options.thinking ?? this.#options.thinking ?? settingsThinking(this.#settings),
          autoApprove: options.autoApprove,
          maxIterations: child.budget?.max_iterations,
          maxErrors: child.budget?.max_errors,
          agentName: child.agent,
          agentDefinition: definition,
          isolation: child.isolation,
        });
        return {
          status: childResult.state.status === 'done' ? 'done' : childResult.state.status === 'failed' ? 'failed' : 'cancelled',
          summary: childResult.state.last_observation ?? childResult.state.last_error ?? childResult.outcome,
          diff: childResult.report.diff,
          iterations: childResult.report.metrics.turns,
          errors: childResult.state.status === 'failed' ? 1 : 0,
        };
      },
    });

    const orchestration = await orchestrator.run(spec.id, inputs);
    this.modeController.set('orchestrator');

    let validation: ValidationResult | undefined;
    if (orchestration.status === 'done') {
      emitEvent(target, spec.id, undefined, 'VALIDATION_STARTED', { task_id: spec.id, orchestrated: true });
      validation = await this.validator.validate({ workspaceRoot: this.#workspaceRoot, commands: this.#options.validationCommands });
      emitEvent(target, spec.id, undefined, validationSatisfied(validation) ? 'VALIDATION_PASSED' : 'VALIDATION_FAILED', { result: validation });
    }

    const validationFailedCombined = validation !== undefined && !validationSatisfied(validation);
    state = {
      ...state,
      status: orchestration.status === 'done' && !validationFailedCombined ? 'done' : 'failed',
      last_error: orchestration.no_progress ? 'no_progress' : orchestration.budget_exceeded ? 'budget_exceeded' : orchestration.status !== 'done' ? 'child_task_failed' : validationFailedCombined ? 'validation_failed' : undefined,
      last_observation: orchestration.summary,
      turns: orchestration.children.length,
      steps: state.steps.map((step, index) => ({
        ...step,
        status: orchestration.children[index]?.status === 'done' ? 'done' : orchestration.status === 'done' && !validationFailedCombined ? 'done' : step.status,
      })),
    };
    emitEvent(target, spec.id, undefined, 'TASK_COMPLETED', {
      state,
      outcome: state.status === 'done' ? 'success' : 'failed',
      reason: state.last_error ?? 'completed',
      children: orchestration.children,
    });
    this.store.saveState(spec.id, state);

    const outcome = this.#outcome(state, validation);
    const report: FinalReport = {
      task_id: spec.id,
      outcome: outcome === 'success' ? 'success' : outcome === 'partial' ? 'partial' : 'failed',
      diff: orchestration.diff || this.#aggregateDiff(collected),
      evidence: [
        ...orchestration.children.map((child) => `child ${child.id} (${child.status}): ${child.result_summary ?? child.goal}`),
        ...this.#validationEvidence(validation),
        ...this.#fileChangeEvidence(collected),
      ],
      ...(spec.title ? { title: spec.title } : {}),
      ...(spec.rules_files?.length ? { rules_files: spec.rules_files } : {}),
      ...(validation?.source ? { validation_source: validation.source } : {}),
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
        child_tasks: orchestration.children.length,
        child_tasks_done: orchestration.children.filter((child) => child.status === 'done').length,
        child_tasks_failed: orchestration.children.filter((child) => child.status === 'failed').length,
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

  #modelConfig(options: RunOptions): { models: string[]; strategy: ModelStrategy } {
    const strategy = options.modelStrategy ?? this.#options.modelStrategy ?? this.#settings.llm.modelStrategy;
    let models = normalizeModelList(options.models ?? this.#options.models);
    if (models.length === 0 && !options.model && !this.#options.model) {
      const selection = this.#providerSelection(options);
      const explicitlyPooled = options.modelStrategy !== undefined || this.#options.modelStrategy !== undefined;
      if (selection && explicitlyPooled && selection.config.models.length > 1) {
        models = normalizeModelList(selection.config.models);
      } else if (this.#settings.llm.models.length > 1) {
        models = normalizeModelList(this.#settings.llm.models);
      }
    }
    return { models, strategy };
  }

  /**
   * Wrap a per-model provider in the text-protocol adapter. The configured
   * protocol comes from the stored provider config when present, else the
   * LLM_TOOL_PROTOCOL setting; an `auto` switch mid-task is surfaced as a
   * PROVIDER_CHANGED event so the Web Chat panel can show it.
   */
  #textProtocol(taskId: string, options: RunOptions, config: ProviderConfig | undefined, model: string, inner: LLMProvider): LLMProvider {
    return new TextProtocolProvider(inner, {
      protocol: config?.toolProtocol ?? this.#settings.llm.toolProtocol,
      onProtocolSwitch: (info: ProtocolSwitchInfo) => {
        emitEvent({ bus: this.bus, store: this.store }, taskId, undefined, 'PROVIDER_CHANGED', {
          protocol_switched: true,
          tool_protocol: info.to,
          from_protocol: info.from,
          from_model: model,
          to_model: model,
          model,
          provider_id: options.providerId ?? this.#options.providerId ?? config?.id,
          reason: `tool_protocol_${info.to}: ${info.reason}`,
          error: info.reason,
          failures: info.failures,
        });
      },
    });
  }

  /** Merged capability tiers for a run (tailor suite): settings < runner options < provider config. */
  #tiersFor(options: RunOptions): Record<string, ModelTier> {
    const config = this.#providerSelection(options)?.config;
    return {
      ...(this.#settings.llm.modelTiers ?? {}),
      ...(this.#options.modelTiers ?? {}),
      ...(config?.modelTiers ?? {}),
    };
  }

  #routingEnabled(): boolean {
    return this.#options.modelRouting ?? (this.#settings.tailor?.modelRouting !== false);
  }

  #providerFor(options: RunOptions, taskId: string): LLMProvider {
    const selection = this.#providerSelection(options);
    const modelConfig = this.#modelConfig(options);
    if (modelConfig.models.length > 1) {
      const config = selection?.config;
      const baseUrl = config?.baseUrl || this.#settings.llm.baseUrl;
      const apiKey = config ? config.apiKey ?? '' : this.#settings.llm.apiKey;
      return new ModelPoolProvider({
        models: modelConfig.models,
        strategy: modelConfig.strategy,
        tiers: this.#tiersFor(options),
        routing: this.#routingEnabled(),
        createProvider: (model) => this.#textProtocol(taskId, options, config, model, new OpenAICompatProvider({
          baseUrl,
          apiKey,
          model,
          defaultTimeoutMs: this.#settings.llm.timeoutMs ?? undefined,
        })),
        onSwitch: (switched) => {
          emitEvent({ bus: this.bus, store: this.store }, taskId, undefined, 'PROVIDER_CHANGED', {
            from_model: switched.from,
            to_model: switched.to,
            from: switched.from,
            to: switched.to,
            model: switched.to,
            provider_id: options.providerId ?? this.#options.providerId ?? config?.id,
            strategy: switched.strategy,
            reason: switched.reason,
            error: switched.error,
            attempt: switched.attempt,
          });
        },
      });
    }
    if (!selection) return this.#provider();
    const { config, model } = selection;
    return this.#textProtocol(taskId, options, config, modelConfig.models[0] ?? model, new OpenAICompatProvider({
      baseUrl: config.baseUrl || this.#settings.llm.baseUrl,
      apiKey: config.apiKey ?? '',
      model: modelConfig.models[0] ?? model,
      defaultTimeoutMs: this.#settings.llm.timeoutMs ?? undefined,
    }));
  }

  #providerSelection(options: RunOptions): { config: ProviderConfig; model: string } | undefined {
    const registry = this.providerRegistry;
    if (!registry) return undefined;
    const providerId = options.providerId ?? this.#options.providerId;
    const config = providerId ? registry.get(providerId) : registry.listInternal().find((provider) => provider.enabled);
    if (!config || !config.enabled) return undefined;
    const model = options.model ?? this.#options.model ?? config.defaultModel ?? config.models[0] ?? this.#settings.llm.model;
    return { config, model };
  }

  #visionEnabledFor(options: RunOptions): boolean {
    const selection = this.#providerSelection(options);
    if (!selection || !this.providerRegistry) return false;
    const modelConfig = this.#modelConfig(options);
    if (modelConfig.models.length > 0) {
      return modelConfig.models.some((model) => this.providerRegistry!.modelSupportsVision(selection.config, model));
    }
    return this.providerRegistry.modelSupportsVision(selection.config, selection.model);
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
    hooksConfig?: HooksConfig,
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

    // Project hooks (pre-tool): an explicit veto (exit 2, or a JSON
    // {"block": true, "reason": ...} body) stops the call before the
    // harness runs; the reason is returned to the model. Fail-open
    // otherwise — timeouts and crashes are recorded, never blocking.
    if (hooksConfig) {
      const pre = await runPreToolHooks({ workspaceRoot: this.#workspaceRoot, hooks: hooksConfig, tool: tool.name, args: call.args });
      for (const execution of pre.executions) {
        emitEvent(target, taskId, turnId, 'HOOK_EXECUTED', { ...execution });
      }
      if (pre.blocked) {
        return {
          call_id: call.id,
          status: 'denied',
          output: `blocked by project hook (${pre.command ?? 'pre_tool'}): ${pre.reason ?? 'blocked'}`,
          truncated: false,
          meta: { tool: tool.name, mutating: tool.mutating, hook_blocked: true, hook_command: pre.command },
        };
      }
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

    let output = result.output;
    if (result.status === 'ok' && (tool.name === 'write_file' || tool.name === 'edit_file' || tool.name === 'edit_search_replace') && typeof args.path === 'string') {
      const effectivePath = typeof result.meta?.path === 'string' ? result.meta.path : args.path;
      // Checkpoint: persist the pre-mutation content captured before
      // execution (`before`); TaskStore keeps the first record per path, so a
      // later restore rewinds to the state before this task touched the file.
      // Skipped when the tool resolved the edit to a different file than the
      // one whose "before" was read, so a backup can never hold wrong content.
      if (effectivePath === args.path) {
        const relativePath = isAbsolute(effectivePath) ? relative(resolve(this.#workspaceRoot), effectivePath) : effectivePath;
        if (relativePath && !relativePath.startsWith('..') && !isAbsolute(relativePath)) {
          try {
            this.store.recordBackup(taskId, relativePath, before);
          } catch { /* checkpoints are best-effort; a failure must not fail the edit */ }
        }
      }
      // Edit guard: fast syntax/LSP feedback appended to the tool result so
      // the model can repair a bad write in the same turn. Fail-open.
      const guard = await guardEditedFile(
        { workspaceRoot: this.#workspaceRoot, enabled: this.#editGuardEnabled(), lsp: this.#activeLsp ?? null },
        effectivePath,
      );
      if (guard.note) output = `${output}\n${guard.note}`;
    }

    // Project hooks (post-tool): each matching hook's stdout (trimmed,
    // capped) rides along with the tool result as `hook: …` lines so the
    // model sees lint/format feedback in the same turn. Fail-open.
    if (hooksConfig) {
      const post = await runPostToolHooks({
        workspaceRoot: this.#workspaceRoot,
        hooks: hooksConfig,
        tool: tool.name,
        args: call.args,
        result: { ...result, output },
      });
      for (const execution of post.executions) {
        emitEvent(target, taskId, turnId, 'HOOK_EXECUTED', { ...execution });
      }
      for (const note of post.notes) output = output ? `${output}\nhook: ${note}` : `hook: ${note}`;
    }

    return { ...result, output, call_id: call.id, meta: { ...result.meta, tool: tool.name, mutating: tool.mutating } };
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