import type { AgentMode, Attachment, ChildTask, ChildTaskErrorReason, Event, FinalReport, ModelStrategy, ProviderConfig, TaskSpec, TaskState, ToolCall, ToolResult, ValidationResult } from './contracts.ts';
import { EventBus, emitEvent } from './events.ts';
import { TaskStore } from './persistence.ts';
import { AgentLoop } from './agent/agent-loop.ts';
import type { ToolOutputLimits } from './agent/tool-output.ts';
import { DefaultContextManager } from './agent/context.ts';
import { interpretTask } from './agent/interpreter.ts';
import { loadProjectRules } from './agent/rules.ts';
import { guardEditedFile } from './agent/edit-guard.ts';
import { loadHooksConfig, runPostToolHooks, runPreToolHooks, type HooksConfig } from './agent/hooks.ts';
import { loadAgents, workspaceAgentsDir, type AgentDefinition } from './agents/index.ts';
import { createTaskWorktree, worktreeChangedFiles } from './worktree.ts';
import { createDefaultRegistry, editSearchReplaceTool } from './tools/index.ts';
import { pathInWorkspace } from './tools/filesystem/index.ts';
import type { ToolDefinition } from './tools/registry.ts';
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { changedLineCounts, diffLines, renderPatch } from './tools/filesystem/diff.ts';
import { ApprovalBroker, ExecutionHarness, commandLineOf, resolveApprovalTimeoutMs, type ApprovalDecision, type ApprovalPolicy, type HarnessConfig } from './execution/index.ts';
import { CommandValidator, type ValidationCommand, type Validator } from './validation/index.ts';
import { createProviderFromSettings } from './providers/index.ts';
import { OpenAICompatProvider } from './providers/llm/openai-compat.ts';
import { ModelPoolProvider, asModelController, normalizeModelList } from './providers/llm/model-pool.ts';
import { resolvePromptFamily } from './agent/prompt-dialects.ts';
import {
  BOOTSTRAP_PROBE_TOOLS,
  creationCompletionRefusal,
  detectCreationGoal,
  detectScaffoldRequest,
  detectUnsupportedFramework,
  pathInsideTarget,
  probeToolchains,
  renderScaffoldPlaybook,
  renderUnsupportedPlaybook,
  scaffoldApprovalChain,
  scaffoldChainStepFor,
  scaffoldMarkerPresent,
  summarizeCommandFailure,
  workspaceRelativePath,
  type ScaffoldChainStep,
  type ToolchainProbe,
} from './agent/scaffold.ts';
import { BackgroundJobManager } from './tools/terminal/jobs.ts';
import { run as runToolchainProbe } from './tools/terminal/index.ts';
import { reviewDiff } from './agent/review.ts';
import { loadPins } from './pins.ts';
import type { EditFormat, ModelTier, PromptFamily, PromptFamilySetting, ReviewGateReport } from './contracts.ts';
import { TextProtocolProvider, type ProtocolSwitchInfo } from './providers/llm/text-protocol.ts';
import { ModeController, isPlanDocumentPath, normalizeAgentMode, restrictMode } from './interaction/modes.ts';
import { QuestionBroker, createAskUserTool, questionResultOutput, resolveQuestionTimeoutMs, type UserQuestionInfo } from './interaction/questions.ts';
import { hasPlanDocument, parseTasksDocument, planDecisionsFromEvents, planSlugFromGoal, renderAssembledPlanDocuments, PLAN_DOCUMENT_FILES } from './interaction/plans.ts';
import { replan as defaultReplan } from './agent/planner.ts';
import type { Planner } from './agent/types.ts';
import { randomUUID } from 'node:crypto';
import { ProviderRegistry } from './interaction/providers.ts';
import { childTaskFromInput, distillChildSummary, type ChildFileChange } from './interaction/orchestrator.ts';
import { backgroundFinishedNotice, createSpawnSubagentTool, type SpawnDispatch, type SpawnSubagentInput } from './interaction/subagents.ts';
import { McpManager, loadMcpConfig, type McpServerConfig, type McpServerStatus } from './mcp/index.ts';
import { LspManager, loadLspConfig, type LspServerConfig, type LspServerStatus } from './lsp/index.ts';
import {
  SkillRegistry,
  createReadSkillTool,
  loadSkillConfig,
  loadSkillInventory,
  loadSkills,
  renderSkillBody,
  resolveSkillSearchDirs,
  type SkillInventoryEntry,
  type SkillLoadedPayload,
  type SkillSearchDir,
} from './skills/index.ts';
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
  /** Shared approval broker (worktree re-dispatch reuses the parent's so decisions reach child runs). */
  approvalBroker?: ApprovalBroker;
  /** Shared question broker (worktree re-dispatch reuses the parent's so answers reach child runs). */
  questionBroker?: QuestionBroker;
  /** How long a user question (ask_user) may wait for an answer before the agent proceeds on stated assumptions. Defaults to DAEDALUS_QUESTION_TIMEOUT_MS / 15 minutes. */
  questionTimeoutMs?: number;
  /**
   * Opt-in approval wait cap. By default there is NONE: an approval the
   * user has not answered stays pending until answered or the task is
   * stopped (stopping settles it as a decline). Set a positive value (or
   * DAEDALUS_APPROVAL_TIMEOUT_MS) only if you want an unanswered
   * approval to auto-decline after that long.
   */
  approvalTimeoutMs?: number;
  /**
   * Shared remembered-approval store (pattern key → decision). Inject one
   * Map to make "Allow & remember" session-scoped across runners; in-memory
   * only, so a process restart forgets every remembered grant.
   */
  approvalMemory?: Map<string, ApprovalDecision>;
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
  /** RTK-style compression of run_command output for the model context. Defaults to settings.outputCompression (on). */
  outputCompression?: boolean;
  /** Pre-build question gate for creation-shaped underspecified briefs. Defaults to settings.questionGate (on). */
  questionGate?: boolean;
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
  /** Tailor early-trigger on loop warning/stall. Defaults to settings.tailor.earlyEscalation (on). */
  earlyEscalation?: boolean;
  /** Per-task input-token budget; 0 disables. Defaults to settings.context.inputTokenBudget (100k). */
  inputTokenBudget?: number;
  /** Hard-pause decision seam (tests); production asks the user via the question broker. */
  onLoopHardPause?: (info: { taskId: string; tool: string; repeats: number; signature: string }) => Promise<'continue' | 'stop'>;
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
  /**
   * Full skill inventory (winners + shadowed copies), each flagged
   * `disabled` from the workspace's `.daedalus/skills.json`. Disabled and
   * shadowed entries never load; they are listed so UIs can show what
   * exists and offer to re-enable.
   */
  skills: SkillInventoryEntry[];
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
  /** Execute the plan an earlier (plan-mode) task recorded: its steps are carried into this task's context. */
  planTaskId?: string;
  /**
   * Prior conversation context (Web chat sessions): recent turns of the
   * conversation this task belongs to, pre-rendered and capped by the
   * caller. Carried into the prompt's constraints exactly like the
   * plan-task steps above, so a follow-up task starts session-aware.
   */
  priorContext?: string;
  /** Chat conversation id this task belongs to; recorded on the spec/state so task listings can point back at the session. */
  conversationId?: string;
  /**
   * Skills explicitly invoked for this task (Web `/skill <name>`, CLI
   * `/skill`, `run --skill`): each named skill's body is force-loaded into
   * the task context, marked as user-invoked, with a SKILL_LOADED event.
   * Unknown or workspace-disabled names are refused visibly (an error
   * result naming them; the CLI/server surfaces refuse before the run) —
   * never silently dropped. Children spawned from this run do not inherit
   * the invocation; it belongs to this task.
   */
  skills?: string[];
  /** Name of a file-defined subagent (.daedalus/agents/<name>.md) running this task. */
  agentName?: string;
  /** Subagent definition already resolved by a parent run (worktree re-dispatch); set automatically. */
  agentDefinition?: AgentDefinition;
  /** Tool allowlist override; intersected with the mode's visible tools. Undefined = mode decides. */
  toolAllowlist?: string[];
  /** Run this task in its own git worktree (overrides TaskRunnerOptions.isolation). */
  isolation?: 'worktree';
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

/**
 * Plan documents a run actually wrote, from its FILE_CHANGED evidence:
 * normalized `.daedalus/plans/**` paths to a member of the plan document
 * set (plan.md, PRD.md, architecture.md, design.md, tasks.md),
 * deduplicated, in set order (plan.md first). Paths are reported as the
 * model wrote them (workspace relative), which is what the Web links and
 * the follow-up goal quotes.
 */
export function planDocumentsFromEvents(events: Event[]): string[] {
  const seen = new Set<string>();
  for (const event of events) {
    if (event.type !== 'FILE_CHANGED') continue;
    const path = (event.payload as { path?: unknown }).path;
    if (typeof path !== 'string' || !isPlanDocumentPath(path)) continue;
    const segments = path.replace(/\\/g, '/').split('/').filter((segment) => segment.length > 0 && segment !== '.');
    const clean = segments.join('/');
    const name = segments[segments.length - 1];
    if (name !== undefined && (PLAN_DOCUMENT_FILES as readonly string[]).includes(name)) seen.add(clean);
  }
  const rank = (path: string): number => PLAN_DOCUMENT_FILES.indexOf(path.split('/').at(-1) as typeof PLAN_DOCUMENT_FILES[number]);
  return [...seen].sort((a, b) => rank(a) - rank(b) || a.localeCompare(b));
}

const PLAN_DOCUMENT_PIN_CAP_CHARS = 6_000;

function capPlanDocument(text: string): string {
  return text.length > PLAN_DOCUMENT_PIN_CAP_CHARS
    ? `${text.slice(0, PLAN_DOCUMENT_PIN_CAP_CHARS)}\n[…document truncated for context]`
    : text;
}

/**
 * Planner whose steps ARE the approved tasks.md checklist (the
 * execute-the-plan step-lock): the follow-up executor works the
 * document's items in order instead of deriving a fresh checklist.
 */
function tasksDocumentPlanner(taskSteps: string[]): Planner {
  return {
    createPlan: async (spec) => ({
      id: randomUUID(),
      task_id: spec.id,
      version: 1,
      status: 'active',
      steps: taskSteps.map((intent, index) => ({
        id: `${spec.id}-step-${index + 1}`,
        intent,
        status: index === 0 ? ('active' as const) : ('pending' as const),
        evidence: [],
      })),
    }),
    replan: defaultReplan,
  };
}

/**
 * Latest change per path from a child run's FILE_CHANGED events, in
 * first-appearance order — the distilled "what this child touched" input for
 * its summary (the child's full diff stays in its own log and report).
 */
function childFileChanges(events: Event[]): ChildFileChange[] {
  const byPath = new Map<string, ChildFileChange>();
  for (const event of events) {
    if (event.type !== 'FILE_CHANGED') continue;
    const payload = event.payload as { path?: unknown; added?: unknown; removed?: unknown };
    if (typeof payload.path !== 'string' || payload.path.length === 0) continue;
    byPath.set(payload.path, {
      path: payload.path,
      ...(typeof payload.added === 'number' ? { added: payload.added } : {}),
      ...(typeof payload.removed === 'number' ? { removed: payload.removed } : {}),
    });
  }
  return [...byPath.values()];
}

/**
 * Roll provider-reported token usage out of a run's collected events
 * (its own turns plus its spawned children's, which share the bus).
 * `reported` counts only requests whose provider actually returned a
 * usage block — totals are never fabricated from estimates.
 */
function accumulateUsage(events: Event[]): { requests: number; reported: number; input_tokens: number; output_tokens: number; total_tokens: number } {
  let requests = 0;
  let reported = 0;
  let input = 0;
  let output = 0;
  let total = 0;
  for (const event of events) {
    if (event.type !== 'MODEL_REQUEST_FINISHED') continue;
    requests++;
    const usage = (event.payload as { usage?: { prompt_tokens?: unknown; completion_tokens?: unknown; total_tokens?: unknown } }).usage;
    if (typeof usage?.prompt_tokens === 'number' && typeof usage?.completion_tokens === 'number' && typeof usage?.total_tokens === 'number') {
      reported++;
      input += usage.prompt_tokens;
      output += usage.completion_tokens;
      total += usage.total_tokens;
    }
  }
  return { requests, reported, input_tokens: input, output_tokens: output, total_tokens: total };
}

/**
 * Split a lineage change ledger into changes inside vs outside the
 * task's declared target directory (completion gate v2). Paths are
 * normalized against the run's workspace root; a path that cannot be
 * normalized (escapes the root) counts as outside.
 */
function splitTargetChanges(workspaceRoot: string, changedPaths: Set<string>, targetDir: string): { inside: number; outside: string[] } {
  let inside = 0;
  const outside: string[] = [];
  for (const path of changedPaths) {
    const rel = workspaceRelativePath(workspaceRoot, path);
    if (rel === undefined) outside.push(path);
    else if (pathInsideTarget(rel, targetDir)) inside++;
    else outside.push(rel);
  }
  return { inside, outside };
}

/** Tools whose execution is a process → COMMAND_* events for the terminal surface. */
const COMMAND_TOOLS = new Set(['run_command', 'git_status', 'git_diff']);
/** Tools that target a workspace file → FILE_CHANGED diff evidence. */
const FILE_TOOLS = new Set(['read_file', 'write_file', 'edit_file', 'edit_search_replace', 'create_dir']);

/**
 * Live subagent tooling of one top-level run: the spawn_subagent tool plus
 * the drains the runtime needs at turn boundaries (notices) and at task
 * end (background results). Created per run by #createSubagentTooling.
 */
type SubagentTooling = {
  tool: ToolDefinition;
  drainNotices: () => string[];
  /** Wait for every background child and return the finished ones (report evidence). */
  settleBackground: () => Promise<ChildTask[]>;
  /** Refuse new spawns and cancel running background children (task Stop). */
  stop: () => void;
};

export class TaskRunner {
  readonly bus: EventBus;
  readonly store: TaskStore;
  readonly approvals: ApprovalBroker;
  readonly questions: QuestionBroker;
  readonly harness: ExecutionHarness;
  readonly validator: Validator;
  readonly modeController: ModeController;
  readonly providerRegistry?: ProviderRegistry;
  readonly #settings: Settings;
  readonly #workspaceRoot: string;
  readonly #options: TaskRunnerOptions;
  readonly #activeLoops = new Map<string, AgentLoop>();
  /** Child task id → orchestrator parent task id, for approval surfacing. */
  readonly #taskParents = new Map<string, string>();
  /** Parent task id → its live subagent tooling, so cancel() can stop background children. */
  readonly #spawners = new Map<string, SubagentTooling>();
  /** Task id → its background job manager, so cancel() can stop running jobs with the task. */
  readonly #jobManagers = new Map<string, BackgroundJobManager>();
  /**
   * Declared scaffold command chains per in-flight task (recipe id +
   * steps), registered by run() while the task owns a scaffold playbook
   * and read by the harness' scaffoldChainFor. Task-scoped by
   * construction: the entry dies with the run.
   */
  readonly #scaffoldChains = new Map<string, { chainId: string; steps: ScaffoldChainStep[] }>();
  #extensionStatus: ExtensionStatus = { mcp: [], lsp: [], skills: [], agents: [] };
  /** Language servers of the in-flight run, used by the edit guard. */
  #activeLsp: LspManager | undefined;

  constructor(options: TaskRunnerOptions) {
    this.#options = options;
    this.#settings = options.settings ?? loadSettings();
    this.#workspaceRoot = options.workspaceRoot;
    this.bus = options.bus ?? new EventBus();
    this.store = options.store ?? new TaskStore(resolveDaedalusHome(this.#settings.daedalusHome, options.workspaceRoot));
    this.approvals = options.approvalBroker ?? new ApprovalBroker({ timeoutMs: resolveApprovalTimeoutMs(options.approvalTimeoutMs) });
    this.questions = options.questionBroker ?? new QuestionBroker({ timeoutMs: resolveQuestionTimeoutMs(options.questionTimeoutMs) });
    this.modeController = options.modeController ?? new ModeController(options.mode ?? 'auto', options.autoApprove ?? options.approvalPolicy === 'auto');
    if (options.autoApprove !== undefined) this.modeController.setAutoApprove(options.autoApprove);
    this.providerRegistry = options.providerRegistry;
    const userPolicyFor = options.harness?.policyFor;
    this.harness = new ExecutionHarness(
      {
        defaultApprovalPolicy: options.approvalPolicy ?? 'ask',
        ...options.harness,
        approvalMemory: options.approvalMemory ?? options.harness?.approvalMemory,
        modeFor: () => this.modeController.mode,
        parentTaskIdFor: (taskId) => this.#taskParents.get(taskId),
        approvalTaskIds: (key) => {
          const parent = this.#taskParents.get(key.taskId);
          return parent ? [key.taskId, parent] : [key.taskId];
        },
        policyFor: (key, tool) => {
          // Call-aware: the Plan mode carve-out allows plan documents and
          // denies every other mutating path, per call.
          const modePolicy = this.modeController.approvalForCall(tool.name, key.path);
          if (!modePolicy.visible) return 'deny';
          if (modePolicy.approval === 'deny') return 'deny';
          if (key.action === 'read') return 'auto';
          if (options.approvalPolicy === 'deny') return 'deny';
          if (userPolicyFor) return userPolicyFor(key, tool);
          return modePolicy.approval;
        },
        scaffoldChainFor: (key, call) => {
          // One approval covers a scaffold recipe's declared chain for
          // the task that owns the playbook (registered in run()).
          // Children and non-scaffold tasks have no chain.
          if (call.tool !== 'run_command') return undefined;
          const entry = this.#scaffoldChains.get(key.taskId);
          if (!entry) return undefined;
          const line = commandLineOf((call.args ?? {}) as Record<string, unknown>);
          if (!line) return undefined;
          const step = scaffoldChainStepFor(entry.steps, line);
          return step ? { chainId: entry.chainId, step: step.step, covers: entry.steps.map((s) => s.label) } : undefined;
        },
      },
      { bus: this.bus, store: this.store },
    );
    this.harness.setApprovalCallback((info) => this.approvals.request(info));
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
    // Per-workspace skill state (.daedalus/skills.json): disabled names
    // are excluded by the loader before the prompt index or read_skill
    // ever see them, freeing index slots for enabled skills. The
    // inventory (with disabled + shadowed copies) is kept for UIs.
    const skillConfig = await loadSkillConfig(this.#workspaceRoot);
    const skills = await loadSkills(skillDirs, { disabledNames: skillConfig.disabled });
    const skillInventory = await loadSkillInventory(skillDirs, { disabledNames: skillConfig.disabled });
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

    this.#extensionStatus = { mcp: mcp.status(), lsp: lsp.status(), skills: skillInventory, agents: agents.list() };

    return {
      tools,
      skills,
      lsp,
      close: async () => {
        await mcp.closeAll().catch(() => undefined);
        await lsp.closeAll().catch(() => undefined);
        this.#extensionStatus = { mcp: mcp.status(), lsp: lsp.status(), skills: skillInventory, agents: agents.list() };
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

  /**
   * One scaffold-preflight probe (`<tool> --version`, 5s cap): the first
   * output line as the version string, or MISSING. Never throws — a probe
   * failure only informs the playbook, it never blocks the task.
   */
  async #probeToolchain(tool: string): Promise<ToolchainProbe> {
    try {
      // nvm is a shell function, not a binary: presence is the ~/.nvm
      // install on disk, probed directly instead of spawned.
      if (tool === 'nvm' && existsSync(join(homedir(), '.nvm', 'nvm.sh'))) {
        return { tool, ok: true, version: 'nvm (shell function)' };
      }
      const result = await runToolchainProbe(tool, ['--version'], this.#workspaceRoot, { timeoutMs: 5_000 });
      const version = result.output
        .split('\n')
        .map((line) => line.trim())
        .find((line) => line.length > 0)
        ?.slice(0, 80);
      return result.status === 'ok' && version ? { tool, ok: true, version } : { tool, ok: false };
    } catch {
      return { tool, ok: false };
    }
  }

  /** `uid:gid` of this process for the scaffold container route (--user). */
  #hostUidGid(): string {
    const uid = process.getuid?.();
    const gid = process.getgid?.();
    return typeof uid === 'number' && typeof gid === 'number' ? `${uid}:${gid}` : '1000:1000';
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
    if (state.status === 'failed' && state.last_error === 'provider_timeout') {
      return 'provider_timeout: the model provider timed out on two consecutive requests, so the run stopped instead of resending the same request again — try a smaller task, a shorter prompt, or another model';
    }
    return undefined;
  }

  /** Evidence lines for a validation result: profile warning first, then one line per check. */
  #validationEvidence(validation: ValidationResult | undefined): string[] {
    if (!validation) return [];
    return [
      ...(validation.warning ? [`validation profile warning: ${validation.warning}`] : []),
      ...(validation.checks.length === 0
        ? [validation.note ? `validation skipped: ${validation.note}` : 'validation skipped: no validation commands configured for this workspace']
        : []),
      ...(validation.note && validation.checks.length > 0 ? [`validation note: ${validation.note}`] : []),
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
    // Background jobs belong to the task: a stopped run leaves no
    // install or server process running behind it.
    this.#jobManagers.get(taskId)?.killAll(taskId);
    // Background subagents belong to the task: refuse new spawns and stop
    // the running children with it (their loops are in #activeLoops too,
    // but a child between turns settles through its run, not the loop).
    this.#spawners.get(taskId)?.stop();
    // A pending approval is a wait, not work: stopping the task settles it
    // as a decline (never an allow) so the blocked loop can observe the
    // cancellation instead of hanging on a card nobody will answer.
    this.approvals.cancelTasks([taskId]);
    // Same for a pending user question: it settles as cancelled and the
    // tool returns a denial the stopping loop can unwind on.
    this.questions.cancelTasks([taskId]);
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
    // The retired Orchestrator mode maps to Auto before anything records
    // it: legacy persisted tasks/settings load and run (with the
    // spawn_subagent tool available) instead of fanning out or failing.
    const requestedMode = options.mode ?? agent?.mode;
    const effectiveMode = requestedMode === undefined ? undefined : normalizeAgentMode(requestedMode);
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
    if (options.parentTaskId) this.#taskParents.set(spec.id, options.parentTaskId);
    // Plan continuity (Cline-style: context carries across the mode switch,
    // unlike Cursor's fresh context per mode): "execute the plan" loads the
    // steps an earlier plan-mode task recorded and hands them to this task
    // as a constraint, verbatim. The approved plan DOCUMENTS ride along
    // too (see #readPlanDocuments): PRD.md + tasks.md are pinned into the
    // context verbatim and tasks.md becomes the executor's step-lock, so
    // the follow-up builds against what the user approved instead of
    // re-deriving requirements from the chat.
    let pinnedPlanDocuments: { pin: string; taskSteps: string[] } | undefined;
    if (options.planTaskId && options.planTaskId !== spec.id) {
      spec.plan_task_id = options.planTaskId;
      const prior = this.store.loadState<TaskState>(options.planTaskId);
      const steps = prior?.plan?.steps ?? prior?.steps ?? [];
      pinnedPlanDocuments = await this.#readPlanDocuments(options.planTaskId);
      if (!pinnedPlanDocuments && steps.length > 0) {
        const listing = steps.map((step, index) => `${index + 1}. ${step.intent}`).join('\n');
        spec.constraints = [
          ...spec.constraints,
          `Execute the plan drafted earlier in plan mode (task ${options.planTaskId}); follow these steps:\n${listing}`,
        ];
      }
      if (pinnedPlanDocuments) {
        spec.constraints = [...spec.constraints, pinnedPlanDocuments.pin];
      }
    }
    // Prior conversation (chat sessions): the recent turns ride into the
    // prompt as one constraint, the same carriage as the plan steps above.
    if (options.priorContext && options.priorContext.trim().length > 0) {
      spec.constraints = [...spec.constraints, options.priorContext];
    }
    if (options.conversationId) spec.conversation_id = options.conversationId;
    // Scaffold playbook (agent/scaffold.ts): a goal that asks to create a
    // NEW project of a recipe-backed framework gets the official-generator
    // recipe plus a one-time toolchain preflight injected into the prompt,
    // so the model runs the generator instead of exploring in circles and
    // claiming success over an empty folder. The preflight also probes
    // the bootstrap routes (docker, mise/fnm/nvm): a missing toolchain is
    // no longer a dead end — the playbook offers the official container
    // image or a user-level version manager before the honest STOP.
    // Named-but-unsupported technologies (Kotlin/Android and embedded
    // SQLite) get the honesty playbook instead — no recipe, no fake
    // skeleton. Never fatal: the preflight only informs the prompt.
    const scaffoldMatch = detectScaffoldRequest([spec.goal, ...spec.done_criteria].join('\n'));
    const unsupportedFramework = scaffoldMatch ? undefined : detectUnsupportedFramework(spec.goal);
    const scaffoldProbes: ToolchainProbe[] = scaffoldMatch
      ? await probeToolchains([...scaffoldMatch.recipe.toolchains, ...BOOTSTRAP_PROBE_TOOLS], (tool) => this.#probeToolchain(tool))
      : [];
    const scaffoldPlaybook = scaffoldMatch
      ? renderScaffoldPlaybook(scaffoldMatch, scaffoldProbes, { workspaceRoot: this.#workspaceRoot, uidGid: this.#hostUidGid() })
      : unsupportedFramework
        ? renderUnsupportedPlaybook(unsupportedFramework)
        : undefined;
    const collected: Event[] = [];
    // User-invoked skill activations resolved later in this run; flushed
    // as SKILL_LOADED events the moment TASK_STARTED lands so the log
    // order reads prompt → skill → work (see the resolution below).
    const pendingInvocations: SkillLoadedPayload[] = [];
    // The subagent pool is debited by the parent's own model turns too:
    // parent turns + child iterations together never exceed the task's
    // max_iterations (see #createSubagentTooling).
    let parentModelTurns = 0;
    const listener = (event: Event): void => {
      // Mirrored child FILE_CHANGED events (see #emitFileChanged) exist for
      // the parent's persisted log and the Web's diff view; this run's own
      // metrics/diff accounting already sees the child's original event, so
      // counting the mirror too would double every orchestrated change.
      if ((event.payload as { mirrored?: unknown } | undefined)?.mirrored === true) return;
      if (event.task_id === spec.id && event.type === 'MODEL_REQUEST_FINISHED') parentModelTurns++;
      if (event.task_id === spec.id && event.type === 'TASK_STARTED') {
        for (const payload of pendingInvocations.splice(0)) {
          emitEvent({ bus: this.bus, store: this.store }, spec.id, undefined, 'SKILL_LOADED', payload);
        }
      }
      // Only events of this run (itself + spawned descendants) feed its
      // report: with parallel subagents, a sibling's events must not leak
      // into a child's metrics, diff, or validation.
      if (this.#belongsToRun(spec.id, event.task_id)) collected.push(event);
      options.onEvent?.(event);
    };
    this.bus.on('*', listener);

    const isolation = options.isolation ?? this.#options.isolation;
    if (isolation === 'worktree') {
      return this.#runInWorktree(options, spec, agent);
    }

    const extensions = await this.#prepareExtensions();
    this.#activeLsp = extensions.lsp;
    // Explicit skill invocations for this task (Web/CLI `/skill <name>`):
    // resolve each name against the run's registry. A hit force-loads the
    // body into the context (rendered exactly like a read_skill result)
    // and is recorded with a SKILL_LOADED event; a miss — unknown name,
    // or a name the workspace disabled — refuses the run fast with a
    // visible error, so the task never silently runs without the skill
    // the user explicitly asked for.
    const invokedSkills: Array<{ name: string; origin: SkillLoadedPayload['origin']; text: string }> = [];
    const invocationProblems: string[] = [];
    for (const name of [...new Set((options.skills ?? []).map((entry) => entry.trim()).filter(Boolean))]) {
      const skill = extensions.skills.get(name);
      if (skill) {
        invokedSkills.push({ name: skill.name, origin: skill.origin, text: renderSkillBody(skill).text });
        pendingInvocations.push({ name: skill.name, origin: skill.origin, via: 'user', source: skill.source });
      } else if (extensions.skills.isDisabled(name)) {
        invocationProblems.push(
          `skill "${name}" is disabled for this workspace (.daedalus/skills.json) — re-enable it (Web Settings → Extensions, or \`daedalus skills enable ${name}\`) to invoke it`,
        );
      } else {
        invocationProblems.push(`unknown skill "${name}" — no skill with that name was found in this workspace or the global skill directories`);
      }
    }
    if (invocationProblems.length > 0) {
      await extensions.close().catch(() => undefined);
      throw new Error(invocationProblems.join('; '));
    }
    const registry = createDefaultRegistry();
    for (const tool of extensions.tools) {
      try {
        registry.register(tool);
      } catch {
        // A name collision with a built-in tool is skipped, never fatal.
      }
    }
    // The interactive question tool (Plan mode's ask_user): one instance
    // per run, bound to this task and the runner's shared question broker.
    try {
      registry.register(createAskUserTool({
        questions: this.questions,
        bus: this.bus,
        store: this.store,
        taskId: spec.id,
        modeFor: () => this.modeController.mode,
        ...(options.parentTaskId ? { parentTaskId: options.parentTaskId } : {}),
        questionTimeoutMs: resolveQuestionTimeoutMs(this.#options.questionTimeoutMs),
      }));
    } catch {
      // Already registered (e.g. a future default): keep the existing one.
    }
    // The subagent delegation tool (spawn_subagent): top-level runs only.
    // Child runs are built WITHOUT it, so subagents can never delegate
    // further (depth 1 hard stop, by construction rather than by check).
    let subagentTooling: SubagentTooling | undefined;
    if (!options.parentTaskId) {
      subagentTooling = this.#createSubagentTooling({
        spec,
        options,
        parentModelTurns: () => parentModelTurns,
      });
      try {
        registry.register(subagentTooling.tool);
      } catch {
        // Already registered (e.g. a future default): keep the existing one.
      }
      this.#spawners.set(spec.id, subagentTooling);
    }
    // Tailor suite, resolved once per run from runner options < provider
    // config < settings: capability tiers (pool routing + escalation),
    // the edit dialect, the prompt-dialect family for the primary model,
    // and the user's pinned workspace paths for the prompt overview.
    const selection = this.#providerSelection(effectiveOptions);
    const tiers = this.#tiersFor(effectiveOptions);
    const qualityEscalation = this.#options.qualityEscalation ?? (this.#settings.tailor?.qualityEscalation !== false);
    const earlyEscalation = this.#options.earlyEscalation ?? (this.#settings.tailor?.earlyEscalation !== false);
    const inputTokenBudget = this.#options.inputTokenBudget ?? this.#settings.context?.inputTokenBudget ?? 100_000;
    const questionGate = this.#options.questionGate ?? (this.#settings.questionGate !== false);
    // Loop-breaker hard pause: ask the user (question card) whether the
    // stuck task should continue differently or stop. Any non-answer
    // (timeout, cancel, other option) means stop — a stuck task that
    // nobody is watching should end as partial, not burn more turns.
    const onLoopHardPause = this.#options.onLoopHardPause ?? (async (info: { taskId: string; tool: string; repeats: number }): Promise<'continue' | 'stop'> => {
      const question: UserQuestionInfo = {
        id: `loop-pause-${info.taskId}-${Date.now()}`,
        taskId: info.taskId,
        question: `The agent looks stuck: ${info.tool} was repeated ${info.repeats} times without progress. Continue with a different approach, or stop the task?`,
        options: [
          { label: 'Continue a different way', description: 'The repeated call is re-armed; the agent must change approach.' },
          { label: 'Stop the task' },
        ],
        allowFreeText: false,
        createdAt: new Date().toISOString(),
      };
      try {
        emitEvent({ bus: this.bus, store: this.store }, info.taskId, undefined, 'QUESTION_REQUESTED', { question });
        const result = await this.questions.ask(question);
        // The card must close when the wait resolves — answered, timed
        // out, or cancelled. A missing QUESTION_ANSWERED keeps the Web
        // rendering the loop-pause card after the task has moved on or
        // ended, so pressing it then fails with a bare
        // question_not_pending behind a live-looking card (live bug,
        // 2026-10-07). Same payload shape as the ask_user tool's own
        // closing event.
        const formatted = questionResultOutput(question, result);
        emitEvent({ bus: this.bus, store: this.store }, info.taskId, undefined, 'QUESTION_ANSWERED', {
          question_id: question.id,
          question: question.question,
          outcome: result.outcome,
          ...(result.answer !== undefined ? { answer: result.answer } : {}),
          ...(formatted.optionIndex !== undefined ? { option_index: formatted.optionIndex } : {}),
          ...(result.outcome === 'timeout' ? { timed_out: true } : {}),
          ...(result.outcome === 'cancelled' ? { cancelled: true } : {}),
        });
        await this.bus.drain();
        return result.outcome === 'answered' && /continue/i.test(result.answer ?? '') ? 'continue' : 'stop';
      } catch {
        return 'stop';
      }
    });
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
    // Vision capability of the selected model(s), resolved once: the
    // context manager uses it to hold back image attachments, and the
    // tool context uses it so view_image can refuse honestly on a
    // text-only model instead of silently dropping the picture.
    const visionEnabled = this.#visionEnabledFor(effectiveOptions);
    const provider = this.#options.provider ?? this.#providerFor(effectiveOptions, spec.id);
    const loop = new AgentLoop({
      provider,
      bus: this.bus,
      store: this.store,
      context: new DefaultContextManager({
        workspaceRoot: this.#workspaceRoot,
        visionEnabled,
        skills: extensions.skills.list(),
        ...(invokedSkills.length > 0 ? { invokedSkills } : {}),
        rules: rules.text ? rules.text : undefined,
        rulesFiles: rules.files,
        agentInstructions: agent?.instructions,
        agentName: agent?.name,
        promptFamily,
        pins,
        ...(scaffoldPlaybook ? { scaffoldPlaybook } : {}),
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
      outputCompression: this.#options.outputCompression ?? this.#settings.outputCompression,
      modelTiers: tiers,
      qualityEscalation,
      earlyEscalation,
      inputTokenBudget,
      questionGate,
      // Execute-the-plan step-lock: with an approved tasks.md pinned,
      // the executor's checklist IS the document's items, in order.
      ...(pinnedPlanDocuments && pinnedPlanDocuments.taskSteps.length > 0
        ? { planner: tasksDocumentPlanner(pinnedPlanDocuments.taskSteps) }
        : {}),
      onLoopHardPause,
      ...(subagentTooling
        ? { noticesFor: (taskId: string) => (taskId === spec.id ? subagentTooling.drainNotices() : []) }
        : {}),
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
        return this.#executeWithObservability(call, tool, spec.id, call.turn_id || undefined, hooksConfig, visionEnabled);
      },
    });

    // Background jobs of this run: one manager, owned by the task. The
    // tools reach it through the tool context (see #executeWithObservability);
    // its output mirrors into COMMAND_OUTPUT tagged with the job id, and
    // each job's end lands as JOB_FINISHED. Task end (finally below) and
    // cancel() kill whatever is still running.
    const jobManager = new BackgroundJobManager({
      onOutput: (job, chunk) => {
        emitEvent({ bus: this.bus, store: this.store }, job.taskId, undefined, 'COMMAND_OUTPUT', { call_id: job.id, job_id: job.id, chunk });
      },
      onFinish: (job) => {
        emitEvent({ bus: this.bus, store: this.store }, job.taskId, undefined, 'JOB_FINISHED', {
          job_id: job.id,
          command: [job.command, ...job.args].join(' '),
          cwd: job.cwd,
          state: job.state,
          exit_code: job.exitCode,
          killed: job.state === 'killed',
        });
      },
    });
    this.#jobManagers.set(spec.id, jobManager);

    // The task owns a scaffold playbook: register its declared command
    // chain so one approval covers generator → install → build for this
    // task (see ExecutionHarness). Removed when the run ends, below.
    if (scaffoldMatch) {
      this.#scaffoldChains.set(spec.id, {
        chainId: scaffoldMatch.recipe.id,
        steps: scaffoldApprovalChain(scaffoldMatch, { workspaceRoot: this.#workspaceRoot, uidGid: this.#hostUidGid() }),
      });
    }

    let state: TaskState;
    this.#activeLoops.set(spec.id, loop);
    try {
      state = await loop.run(spec);
    } finally {
      this.#activeLoops.delete(spec.id);
      this.#scaffoldChains.delete(spec.id);
      // A question still pending at task end (natural finish, error,
      // provider failure, harness throw — or an asker whose wait was
      // abandoned) settles as cancelled, so it can never outlive the
      // task as an un-answerable card. The waiters emit their own
      // QUESTION_ANSWERED when the broker settles them (the ask_user
      // tool; the loop-pause handler above), which is what clears the
      // card in the Web.
      this.questions.cancelTasks([spec.id]);
      // The task is over: its background jobs die with it.
      jobManager.killAll(spec.id);
      this.#jobManagers.delete(spec.id);
      this.#activeLsp = undefined;
      await extensions.close();
      this.bus.on('*', listener); // no-op keeps handler identity stable for GC
    }

    // Background subagents: the parent may only finish once its background
    // children have settled (their results join the report below; results
    // that landed mid-run were already delivered as turn notices). The wait
    // is bounded by the children's own budgets and approval/question
    // timeouts — a background child never outlives the task record.
    const backgroundChildren = subagentTooling ? await subagentTooling.settleBackground() : [];
    if (subagentTooling) this.#spawners.delete(spec.id);

    // Plan mode's deliverables are files: when the run wrote plan documents
    // under .daedalus/plans/, a closing PLAN_CREATED names them so the Web
    // can link the documents and offer Approve & Execute. The steps ride
    // along unchanged, so plan consumers keep reading the same payload.
    let assembledPlanDocument: string | undefined;
    if (spec.mode === 'plan') {
      let documents = planDocumentsFromEvents(collected);
      if (!hasPlanDocument(documents, 'plan.md')) {
        // Plan-document guarantee, second half: the loop already spent its
        // one repair turn and the model STILL wrote no approval document
        // (Farid's live weak-model run: questions answered, task
        // "success", no plan.md anywhere). Assemble the document SET
        // deterministically from the structured steps + recorded Q&A and
        // write the missing members through the normal file-change path
        // — honestly labeled in the report below, never disguised as the
        // model's own writing. A model-written document is never
        // overwritten (only missing members are written).
        // Missing members land NEXT TO the documents the model did
        // write — the set must live in one folder, never scattered
        // between the model's folder and the goal-slug folder. The slug
        // folder is only the home when the model wrote nothing at all.
        const folder = documents.length > 0
          ? documents[0]!.split('/').slice(0, -1).join('/')
          : `.daedalus/plans/${planSlugFromGoal(spec.goal)}`;
        const present = new Set(documents.map((path) => path.split('/').at(-1)));
        let wroteAny = false;
        for (const doc of renderAssembledPlanDocuments({
          goal: spec.goal,
          plan: state.plan,
          decisions: planDecisionsFromEvents(collected),
        })) {
          if (present.has(doc.name)) continue;
          const relativePath = `${folder}/${doc.name}`;
          const absolutePath = join(this.#workspaceRoot, ...relativePath.split('/'));
          await mkdir(dirname(absolutePath), { recursive: true });
          await writeFile(absolutePath, doc.content, 'utf8');
          const contentLines = doc.content.split('\n');
          const planPayload = {
            call_id: `harness-plan-document-${spec.id}-${doc.name}`,
            path: relativePath,
            tool: 'write_file',
            operation: 'created',
            added: contentLines.length,
            removed: 0,
            lines: contentLines.map((text) => ({ kind: 'add', text })),
            meta: { harness_assembled_plan: true },
          };
          emitEvent({ bus: this.bus, store: this.store }, spec.id, undefined, 'FILE_CHANGED', planPayload);
          this.#mirrorFileChanged(spec.id, undefined, planPayload);
          if (doc.name === 'plan.md') assembledPlanDocument = relativePath;
          wroteAny = true;
        }
        if (wroteAny) {
          await this.bus.drain();
          documents = planDocumentsFromEvents(collected);
        }
      }
      if (documents.length > 0) {
        emitEvent({ bus: this.bus, store: this.store }, spec.id, undefined, 'PLAN_CREATED', { plan: state.plan, mode: 'plan', documents });
        await this.bus.drain();
      }
    }

    const validation = this.#lastValidation(collected, spec.id);
    // Cross-model review gate (tailor suite, default off): a strong-model
    // read of the diff before completion is declared. Report-only — a
    // blocking verdict demotes success to partial; it never blocks the
    // run itself (fail-open inside the gate).
    const review = await this.#reviewGate(effectiveOptions, spec, state, provider, collected, rules.text ? rules.text : undefined);
    let outcome = this.#outcome(state, validation);
    if (review?.blocking && outcome === 'success') outcome = 'partial';
    // Creation completion gate, lineage level (the loop gates its own
    // ledger before finishing; this layer exists because a delegating
    // parent's own ledger is empty by design — only here do the
    // children's events count): a creation-shaped run with zero creation
    // evidence may not report success. When the loop already refused
    // (last_error no_files_created), this only adds the evidence line.
    const creationGateEvidence: string[] = [];
    const loopRefusedCreation = state.status === 'failed' && state.last_error === 'no_files_created';
    if (outcome === 'success' || loopRefusedCreation) {
      const creationGoal = detectCreationGoal(spec.goal, spec.done_criteria);
      if (creationGoal.creation) {
        // The change ledger, mirrored from the loop's own bookkeeping so
        // the two layers agree by construction: file-tool diffs PLUS
        // mutating tool results carrying a path (a created folder emits
        // no FILE_CHANGED — directories have no content to diff — but it
        // IS a change), plus successful commands. Children's events are
        // in `collected`, so delegated work counts here.
        const changedPaths = new Set<string>();
        let commandsSucceeded = 0;
        let lastCommandFailure: string | undefined;
        for (const event of collected) {
          if (event.type === 'FILE_CHANGED') {
            const path = (event.payload as { path?: unknown }).path;
            if (typeof path === 'string') changedPaths.add(path);
          } else if (event.type === 'TOOL_CALL_FINISHED') {
            const payload = event.payload as {
              call?: { tool?: unknown; args?: { path?: unknown; command?: unknown; args?: unknown } };
              result?: { status?: unknown; output?: unknown; meta?: { mutating?: unknown } };
            };
            const path = payload.call?.args?.path;
            if (payload.result?.meta?.mutating === true && typeof path === 'string') changedPaths.add(path);
            if (payload.call?.tool === 'run_command' && payload.result?.status !== 'ok' && payload.result?.status !== undefined) {
              const commandParts: string[] = [];
              if (typeof payload.call.args?.command === 'string') commandParts.push(payload.call.args.command);
              if (Array.isArray(payload.call.args?.args)) {
                for (const arg of payload.call.args.args) if (typeof arg === 'string') commandParts.push(arg);
              }
              lastCommandFailure = summarizeCommandFailure(
                commandParts.join(' ') || 'run_command',
                typeof payload.result.output === 'string' ? payload.result.output : '',
              );
            }
          } else if (event.type === 'COMMAND_FINISHED' && (event.payload as { exit_code?: unknown }).exit_code === 0) {
            commandsSucceeded++;
          }
        }
        const markerPresent = creationGoal.scaffold ? scaffoldMarkerPresent(this.#workspaceRoot, creationGoal.scaffold) : false;
        const refusal = creationCompletionRefusal(
          creationGoal,
          { filesChanged: changedPaths.size, commandsSucceeded, delegated: collected.some((event) => event.type === 'CHILD_TASK_STARTED'), lastCommandFailure },
          markerPresent,
        );
        if (refusal) {
          if (outcome === 'success') outcome = 'partial';
          creationGateEvidence.push(
            `no files were created: ${refusal.detail}; the run ended after ${state.turns ?? 0} turn(s), ${collected.filter((event) => event.type === 'TOOL_CALL_FINISHED').length} tool call(s), ${commandsSucceeded} successful command(s) and ${changedPaths.size} file change(s) — a creation-shaped goal must produce files on disk before it can report success`,
          );
        }
        // Completion gate v2, lineage level: an anchored creation run
        // may not report success on outside-only changes — the incident
        // shape, where the requested page landed in an unrelated file
        // and validation's "outside the project's packages" skip turned
        // it into TASK SUCCESS. The loop gates its own ledger; this is
        // the same rule over the whole lineage (children included).
        // When the loop already refused, this only adds the explicit
        // evidence line. Unanchored runs keep PR #21 semantics exactly.
        const targetDir = state.target_dir ?? creationGoal.scaffold?.targetDir;
        if (targetDir && changedPaths.size > 0) {
          const split = splitTargetChanges(this.#workspaceRoot, changedPaths, targetDir);
          if (split.inside === 0) {
            if (outcome === 'success') outcome = 'partial';
            creationGateEvidence.push(
              `no files were created inside the task target "${targetDir}/": every changed file (${split.outside.slice(0, 5).join(', ')}${split.outside.length > 5 ? ', …' : ''}) is outside it — a creation task anchored to ${targetDir}/ reports success only when at least one changed file is inside the target`,
            );
          }
        }
      }
    }
    const modelFailureEvidence = this.#modelFailureEvidence(collected, state);
    // Token accounting: provider-reported usage over this run's lineage
    // (own turns + spawned children). Token fields appear only when at
    // least one request actually reported usage — never fabricated.
    const usageTotals = accumulateUsage(collected);
    // Output-compression accounting: TOOL_CALL_FINISHED events carry the
    // additive compression flags (raw → compressed chars), so the final
    // report can state exactly what the filters saved this run.
    const compressedOutputs = collected.filter(
      (e) => e.type === 'TOOL_CALL_FINISHED' && (e.payload as { output_compressed?: unknown }).output_compressed === true,
    );
    const sumEventChars = (key: 'output_raw_chars' | 'output_compressed_chars'): number =>
      compressedOutputs.reduce((sum, e) => {
        const value = (e.payload as Record<string, unknown>)[key];
        return sum + (typeof value === 'number' && Number.isFinite(value) ? value : 0);
      }, 0);
    const report: FinalReport = {
      task_id: spec.id,
      outcome: outcome === 'success' ? 'success' : outcome === 'partial' ? 'partial' : 'failed',
      diff: this.#aggregateDiff(collected),
      evidence: [
        ...(modelFailureEvidence ? [`model failure: ${modelFailureEvidence}`] : []),
        ...(state.target_dir ? [`target_dir: ${state.target_dir}`] : []),
        ...(state.target_exceptions?.length ? state.target_exceptions.map((path) => `target exception: ${path} (approved via ask_user)`) : []),
        ...(state.clarifying_answers?.length
          ? state.clarifying_answers.map((qa) => `clarifying answer: ${qa.question} → ${qa.answer}`)
          : []),
        ...creationGateEvidence,
        ...collected
          .filter((e) => e.type === 'TAILOR_ESCALATED' && e.task_id === spec.id)
          .map((e) => {
            const payload = e.payload as { reason?: string; from_model?: string; to_model?: string };
            return `tailor early escalation: ${payload.reason ?? 'loop'} — pinned to strong model ${payload.to_model ?? 'unknown'} for the rest of the task${payload.from_model ? ` (from ${payload.from_model})` : ''}`;
          }),
        ...(outcome === 'partial' && ['no_progress', 'loop_hard_pause', 'input_token_budget'].includes(state.last_error ?? '') && state.last_observation
          ? [state.last_observation]
          : []),
        ...this.#validationEvidence(validation),
        ...(assembledPlanDocument
          ? [`plan document assembled by the harness (${assembledPlanDocument}): the model finished plan mode without writing a plan file, so the harness wrote it from the plan steps and the recorded Q&A decisions — review it before executing`]
          : []),
        ...this.#fileChangeEvidence(collected),
        ...(backgroundChildren.length > 0
          ? backgroundChildren.map((child) => `background subagent "${child.label ?? 'subagent'}" (${child.id}) ${child.status}: ${child.result_summary ?? child.status}`)
          : []),
        ...(review ? [
          `review by ${review.model}: ${review.blocking ? 'blocking issues found' : 'no blocking issues'} (${review.findings.length} finding${review.findings.length === 1 ? '' : 's'})`,
          ...review.findings.map((finding) => `review [${finding.severity}] ${finding.file}${finding.line ? `:${finding.line}` : ''} — ${finding.message}`),
        ] : []),
      ],
      ...(review ? { review } : {}),
      ...(spec.title ? { title: spec.title } : {}),
      ...(spec.rules_files?.length ? { rules_files: spec.rules_files } : {}),
      ...(validation?.source ? { validation_source: validation.source } : {}),
      ...(state.target_dir ? { target_dir: state.target_dir } : {}),
      metrics: {
        turns: collected.filter((e) => e.type === 'TOOL_CALL_FINISHED').length,
        tool_calls: collected.filter((e) => e.type === 'TOOL_CALL_STARTED').length,
        events: collected.length,
        commands: collected.filter((e) => e.type === 'COMMAND_FINISHED').length,
        files_changed: collected.filter((e) => e.type === 'FILE_CHANGED').length,
        recoveries: collected.filter((e) => e.type === 'RECOVERY_STARTED').length,
        replans: collected.filter((e) => e.type === 'REPLAN_CREATED').length,
        approvals: collected.filter((e) => e.type === 'APPROVAL_REQUESTED').length,
        child_tasks: collected.filter((e) => e.type === 'CHILD_TASK_STARTED').length,
        child_tasks_done: collected.filter((e) => e.type === 'CHILD_TASK_FINISHED' && (e.payload as { child?: { status?: string } }).child?.status === 'done').length,
        child_tasks_failed: collected.filter((e) => e.type === 'CHILD_TASK_FINISHED' && (e.payload as { child?: { status?: string } }).child?.status === 'failed').length,
        checks_passed: validation?.checks.filter((c) => c.status === 'pass').length ?? 0,
        checks_failed: validation?.checks.filter((c) => c.status !== 'pass').length ?? 0,
        model_requests: usageTotals.requests,
        ...(usageTotals.reported > 0
          ? {
              tokens_input: usageTotals.input_tokens,
              tokens_output: usageTotals.output_tokens,
              tokens_total: usageTotals.total_tokens,
              token_requests_reported: usageTotals.reported,
            }
          : {}),
        review_findings: review?.findings.length ?? 0,
        review_blocking: review?.blocking ? 1 : 0,
        ...(compressedOutputs.length > 0
          ? {
              compressed_outputs: compressedOutputs.length,
              output_chars_before_compression: sumEventChars('output_raw_chars'),
              output_chars_after_compression: sumEventChars('output_compressed_chars'),
            }
          : {}),
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
  /**
   * Read the approved plan documents an earlier plan-mode task wrote,
   * for pinning into an execute-the-plan follow-up: PRD.md + tasks.md,
   * falling back to plan.md alone (older plans predate the document
   * set). Returns the pin text plus the parsed tasks.md steps (the
   * executor's step-lock). Undefined when the plan task wrote nothing
   * readable — the caller then falls back to the recorded plan steps.
   */
  async #readPlanDocuments(planTaskId: string): Promise<{ pin: string; taskSteps: string[] } | undefined> {
    const documents = planDocumentsFromEvents(this.store.replay(planTaskId));
    if (documents.length === 0) return undefined;
    const folder = documents[0]!.split('/').slice(0, -1).join('/');
    const read = async (name: string): Promise<string | undefined> => {
      try {
        return await readFile(await pathInWorkspace(this.#workspaceRoot, `${folder}/${name}`), 'utf8');
      } catch {
        return undefined;
      }
    };
    const prd = await read('PRD.md');
    const tasks = await read('tasks.md');
    const sections: string[] = [];
    if (prd) sections.push(`--- PRD.md ---\n${capPlanDocument(prd)}`);
    if (tasks) sections.push(`--- tasks.md ---\n${capPlanDocument(tasks)}`);
    if (sections.length === 0) {
      const plan = await read('plan.md');
      if (plan) sections.push(`--- plan.md ---\n${capPlanDocument(plan)}`);
    }
    if (sections.length === 0) return undefined;
    return {
      pin: `Approved plan documents from plan task ${planTaskId} — the user reviewed and approved these; build against them, do not re-derive the requirements, and work tasks.md in order:\n\n${sections.join('\n\n')}`,
      taskSteps: tasks ? parseTasksDocument(tasks) : [],
    };
  }

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
      // The inner run shares the approval channel: a decision made on the
      // outer surface must reach a worktree task blocked on its card.
      approvalBroker: this.approvals,
      // …and the question channel, for the same reason.
      questionBroker: this.questions,
      questionTimeoutMs: this.#options.questionTimeoutMs,
      approvalMemory: this.#options.approvalMemory,
      approvalTimeoutMs: this.#options.approvalTimeoutMs,
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
      outputCompression: this.#options.outputCompression,
      questionGate: this.#options.questionGate,
      modelTiers: this.#options.modelTiers,
      modelRouting: this.#options.modelRouting,
      qualityEscalation: this.#options.qualityEscalation,
      earlyEscalation: this.#options.earlyEscalation,
      inputTokenBudget: this.#options.inputTokenBudget,
      onLoopHardPause: this.#options.onLoopHardPause,
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

  /**
   * Build the subagent tooling for one top-level run: the spawn_subagent
   * tool, its iteration pool, and the background-child bookkeeping.
   *
   * Pool semantics: the pool equals the parent task's own max_iterations.
   * It is debited by the parent's model turns AND by every child's actual
   * iterations, so parent turns + child iterations together never exceed
   * it. Each spawn reserves a slice up front (floor 8 turns or an even
   * share of what remains, whichever is larger, never more than remains);
   * the reservation is settled to actual usage when the child finishes,
   * which keeps accounting exact under parallel spawns. A spawn that finds
   * the pool spent is refused with an explanation, never queued.
   */
  #createSubagentTooling(input: { spec: TaskSpec; options: RunOptions; parentModelTurns: () => number }): SubagentTooling {
    const { spec, options } = input;
    const parentId = spec.id;
    const poolTotal = options.maxIterations ?? this.#options.maxIterations ?? 25;
    const childMaxErrors = options.maxErrors ?? 5;
    // Inheritance rule: a child may tighten the parent's posture, never
    // loosen it — and never become a delegator itself (no nesting).
    const childMode = restrictMode(spec.mode ?? 'auto', 'auto');
    let usedIterations = 0;
    let reservedIterations = 0;
    let stopped = false;
    const notices: string[] = [];
    const background = new Map<string, Promise<ChildTask>>();
    const backgroundFinished: ChildTask[] = [];

    const allocateSlice = (): number | undefined => {
      const remaining = poolTotal - input.parentModelTurns() - usedIterations - reservedIterations;
      if (remaining <= 0) return undefined;
      return Math.max(1, Math.min(remaining, Math.max(8, Math.floor(remaining / 2))));
    };

    const executeChild = async (child: ChildTask): Promise<ChildTask> => {
      child.status = 'running';
      emitEvent({ bus: this.bus, store: this.store }, parentId, undefined, 'CHILD_TASK_STARTED', { child: { ...child } });
      await this.bus.drain();
      try {
        const childResult = await this.run({
          goal: child.goal,
          taskId: child.id,
          mode: childMode,
          parentTaskId: parentId,
          providerId: options.providerId,
          model: options.model,
          models: options.models ?? this.#options.models,
          modelStrategy: options.modelStrategy ?? this.#options.modelStrategy,
          attachments: options.attachments,
          thinking: options.thinking ?? this.#options.thinking ?? settingsThinking(this.#settings),
          autoApprove: options.autoApprove,
          maxIterations: child.budget?.max_iterations,
          maxErrors: child.budget?.max_errors,
        });
        child.status = childResult.state.status === 'done' ? 'done' : childResult.state.status === 'failed' ? 'failed' : 'cancelled';
        if (child.status !== 'done') {
          child.error_reason = (childResult.state.last_error === 'max_iterations' || childResult.state.last_error === 'max_errors'
            ? 'budget_exceeded'
            : childResult.state.status === 'failed'
              ? 'child_failed'
              : 'cancelled') as ChildTaskErrorReason;
        }
        child.result_summary = distillChildSummary({
          status: child.status,
          ...(child.error_reason ? { errorReason: child.error_reason } : {}),
          // The raw last observation rides along only as the distiller's
          // closing-line candidate (it drops tool-output dumps); the
          // structured fields are what the summary is built from.
          summary: childResult.state.last_observation ?? childResult.state.last_error ?? childResult.outcome,
          filesChanged: childFileChanges(childResult.events),
          evidence: childResult.report.evidence.slice(0, 4),
        });
        child.iterations_used = childResult.report.metrics.turns;
        // Token roll-up: the child's own usage rides its record so the
        // parent's live accounting includes subagent iterations too.
        const childMetrics = childResult.report.metrics;
        child.usage = {
          requests: childMetrics.model_requests ?? 0,
          reported: childMetrics.token_requests_reported ?? 0,
          ...(typeof childMetrics.tokens_total === 'number'
            ? { input_tokens: childMetrics.tokens_input ?? 0, output_tokens: childMetrics.tokens_output ?? 0, total_tokens: childMetrics.tokens_total }
            : {}),
        };
      } catch (error) {
        child.status = 'failed';
        child.error_reason = 'child_failed';
        child.result_summary = distillChildSummary({ status: 'failed', errorReason: 'child_failed', summary: String(error) });
        child.iterations_used = 1;
      }
      emitEvent({ bus: this.bus, store: this.store }, parentId, undefined, 'CHILD_TASK_FINISHED', { child: { ...child } });
      await this.bus.drain();
      return child;
    };

    const spawn = async (spawnInput: SpawnSubagentInput, signal?: AbortSignal): Promise<SpawnDispatch> => {
      if (stopped) {
        return { kind: 'error', output: 'cannot spawn a subagent: this task is stopping. Finish the remaining work yourself or report partial progress.' };
      }
      const slice = allocateSlice();
      if (slice === undefined) {
        return {
          kind: 'error',
          output: `cannot spawn a subagent: the task iteration budget (${poolTotal} iterations, shared between this task and its subagents) is exhausted. Do the remaining work yourself or report partial progress instead of delegating.`,
        };
      }
      reservedIterations += slice;
      const child = childTaskFromInput(parentId, {
        goal: spawnInput.goal,
        label: spawnInput.description,
        mode: childMode,
        budget: { max_iterations: slice, max_errors: childMaxErrors },
      });
      const finish = async (): Promise<ChildTask> => {
        const finished = await executeChild(child);
        reservedIterations -= slice;
        usedIterations += finished.iterations_used ?? 1;
        return finished;
      };
      if (signal && !spawnInput.background) {
        // A stopped parent (harness abort) takes its foreground child
        // with it instead of leaving the child running unattended.
        const onAbort = (): void => { this.cancel(child.id); };
        if (signal.aborted) onAbort();
        else signal.addEventListener('abort', onAbort, { once: true });
      }
      if (spawnInput.background) {
        const promise = finish().then((finished) => {
          backgroundFinished.push(finished);
          notices.push(backgroundFinishedNotice(finished));
          return finished;
        });
        background.set(child.id, promise);
        return { kind: 'background', child };
      }
      const finished = await finish();
      return { kind: 'completed', child: finished };
    };

    return {
      tool: createSpawnSubagentTool({ spawn }),
      drainNotices: () => notices.splice(0, notices.length),
      settleBackground: async () => {
        await Promise.all([...background.values()].map((promise) => promise.catch(() => undefined)));
        return backgroundFinished;
      },
      stop: () => {
        stopped = true;
        for (const childId of background.keys()) this.cancel(childId);
      },
    };
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
    visionEnabled?: boolean,
  ): Promise<ToolResult> {
    const target = { bus: this.bus, store: this.store };
    const isCommand = COMMAND_TOOLS.has(tool.name);
    const args = (call.args ?? {}) as Record<string, unknown>;
    // A background start is not a foreground command lifecycle: no
    // COMMAND_STARTED/COMMAND_FINISHED brackets — JOB_STARTED after the
    // dispatch (job id known) and JOB_FINISHED from the job manager own
    // its story, with output still flowing through COMMAND_OUTPUT.
    const backgroundStart = tool.name === 'run_command' && args.background === true;
    const commandLine = isCommand
      ? `${typeof args.command === 'string' ? args.command : tool.name} ${Array.isArray(args.args) ? (args.args as string[]).join(' ') : ''}`.trim()
      : undefined;
    const before = FILE_TOOLS.has(tool.name) && typeof args.path === 'string' ? await this.#readIfPresent(args.path) : null;

    if (isCommand && !backgroundStart) {
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
      ...(visionEnabled !== undefined ? { visionEnabled } : {}),
      ...(this.#jobManagers.get(taskId) ? { jobs: this.#jobManagers.get(taskId) } : {}),
      onOutput: (chunk: string) => {
        emitEvent(target, taskId, turnId, 'COMMAND_OUTPUT', { call_id: call.id, chunk });
      },
    });

    if (backgroundStart) {
      // A refused start (denied/unavailable) has no job: the tool result
      // itself carries the refusal, and no job lifecycle is opened.
      if (typeof result.meta.job_id === 'string') {
        emitEvent(target, taskId, turnId, 'JOB_STARTED', {
          job_id: result.meta.job_id,
          call_id: call.id,
          command: commandLine,
          cwd: typeof args.cwd === 'string' ? args.cwd : this.#workspaceRoot,
          background: true,
        });
      }
    } else if (isCommand) {
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
    if (result.status === 'ok' && (tool.name === 'write_file' || tool.name === 'edit_file' || tool.name === 'edit_search_replace' || tool.name === 'create_dir') && typeof args.path === 'string') {
      const effectivePath = typeof result.meta?.path === 'string' ? result.meta.path : args.path;
      // Checkpoint: persist the pre-mutation content captured before
      // execution (`before`); TaskStore keeps the first record per path, so a
      // later restore rewinds to the state before this task touched the file.
      // Skipped when the tool resolved the edit to a different file than the
      // one whose "before" was read, so a backup can never hold wrong content.
      // create_dir has no file content to checkpoint — it only joins the
      // edit guard below (a directory has no diagnostics, so the guard
      // stays silent; the coverage keeps all four file tools on one path).
      if (tool.name !== 'create_dir' && effectivePath === args.path) {
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
    const payload = {
      call_id: callId,
      path,
      tool,
      operation: before === null ? 'created' : 'modified',
      added: counts.added,
      removed: counts.removed,
      lines,
      patch: renderPatch(path, lines),
    };
    emitEvent({ bus: this.bus, store: this.store }, taskId, turnId, 'FILE_CHANGED', payload);
    this.#mirrorFileChanged(taskId, turnId, payload);
  }

  /**
   * Mirror an orchestrator child's file change onto the parent's log (the
   * approval events set this precedent): the parent is the task the user
   * watches, and its Files-changed/Diff views read only its own log —
   * without the mirror, orchestrated work looked like it changed nothing.
   * The copy is tagged with both ids and `mirrored`, so the child's own
   * view (which reads the child's log) never double-counts and core's
   * run accounting skips it (the child's original already counted).
   */
  #mirrorFileChanged(taskId: string, turnId: string | undefined, payload: Record<string, unknown>): void {
    const parentTaskId = this.#taskParents.get(taskId);
    if (!parentTaskId || parentTaskId === taskId) return;
    emitEvent({ bus: this.bus, store: this.store }, parentTaskId, turnId, 'FILE_CHANGED', {
      ...payload,
      parent_task_id: parentTaskId,
      child_task_id: taskId,
      mirrored: true,
    });
  }

  async #readIfPresent(path: string): Promise<string | null> {
    try {
      return await readFile(await pathInWorkspace(this.#workspaceRoot, path), 'utf8');
    } catch {
      return null;
    }
  }

  /**
   * Whether an event belongs to a run's lineage: the task itself or one of
   * its spawned descendants (walked via the runner's task-parent map).
   * Collected events are scoped this way so a run's report never absorbs a
   * parallel sibling's usage, diff, or validation.
   */
  #belongsToRun(rootTaskId: string, taskId: string | undefined): boolean {
    let current = taskId;
    while (current !== undefined) {
      if (current === rootTaskId) return true;
      current = this.#taskParents.get(current);
    }
    return false;
  }

  #lastValidation(events: Event[], taskId?: string): ValidationResult | undefined {
    for (let i = events.length - 1; i >= 0; i--) {
      const event = events[i];
      // A task's report quotes its OWN validation; subagent children
      // validate themselves and report through their distilled summaries.
      if (taskId && event && event.task_id !== taskId) continue;
      if (event?.type !== 'VALIDATION_PASSED' && event?.type !== 'VALIDATION_FAILED') continue;
      const payload = event.payload as { result?: ValidationResult };
      return payload.result;
    }
    return undefined;
  }

  #outcome(state: TaskState, validation: ValidationResult | undefined): RunOutcome {
    if (state.status === 'done') return 'success';
    if (state.status === 'failed') {
      // Harness hard stops (stall backstop, hard-pause stop, input-token
      // budget): the task stopped before burning more turns — partial
      // with the stop detail as evidence, never a plain failure.
      if (['no_progress', 'loop_hard_pause', 'input_token_budget'].includes(state.last_error ?? '')) return 'partial';
      return state.last_error !== undefined && STOP_REASONS.has(state.last_error) ? 'stopped' : 'failed';
    }
    return validation !== undefined ? 'partial' : 'stopped';
  }
}
