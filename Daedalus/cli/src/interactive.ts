import { randomUUID } from 'node:crypto';
import { readdir, stat } from 'node:fs/promises';
import { basename, join, relative } from 'node:path';
import {
  ModeController,
  ProviderRegistry,
  SlashCommandRegistry,
  classifyChatIntent,
  conversationalFallbackReply,
  questionFallbackReply,
  modeAccent,
  type AgentMode,
  type Attachment,
  type Event,
  type Message,
  type ModelStrategy,
  type ProviderConfigPublic,
  type SlashCommand,
  type SlashCommandResult,
} from '@daedalus/core';
import { formatCount, scrambleText, spinnerGlyph } from './live-render.ts';

export type InteractiveCallbacks = {
  runTask?: (goal: string) => Promise<string>;
  /**
   * Answer one conversational (non-task) chat line. The session passes the
   * raw input plus its recent chat history; the host wires this to the
   * configured provider. Without it, a friendly local fallback is used.
   */
  chatReply?: (request: { input: string; history: Message[] }) => Promise<string>;
  /**
   * Answer one information-seeking question ("repo ini tentang apa?") with
   * the grounded fast Q&A path. Runs in every mode: modes govern tasks,
   * never questions. Without it, a friendly local fallback is used.
   */
  questionReply?: (request: { input: string; history: Message[] }) => Promise<string>;
  validate?: () => Promise<string> | string;
  diff?: () => Promise<string> | string;
  rewind?: () => Promise<SlashCommandResult> | SlashCommandResult;
  cancel?: () => Promise<SlashCommandResult> | SlashCommandResult;
  newTask?: () => Promise<SlashCommandResult> | SlashCommandResult;
  listAgents?: () => Promise<string> | string;
  review?: () => Promise<SlashCommandResult> | SlashCommandResult;
};

export type InteractiveHandleResult = {
  kind: 'empty' | 'slash' | 'task' | 'chat' | 'question';
  text: string;
  action?: string;
  data?: unknown;
};

export type InteractiveKey = {
  name?: string;
  sequence?: string;
  ctrl?: boolean;
  shift?: boolean;
  meta?: boolean;
};

export type InteractiveKeyAction = {
  action: 'none' | 'cancel' | 'quit' | 'toggle_sidebar' | 'cycle_mode' | 'open_commands' | 'open_models' | 'focus_chat' | 'newline' | 'palette_up' | 'palette_down' | 'palette_accept' | 'palette_close' | 'model_up' | 'model_down' | 'model_accept' | 'model_close' | 'model_filter';
  text?: string;
  command?: string;
  data?: unknown;
};

/** One selectable model in the interactive model picker overlay. */
export type ModelPickerItem = {
  providerId: string;
  model: string;
};

export type ModifiedFile = {
  path: string;
  operation?: string;
  added?: number;
  removed?: number;
  tool?: string;
};

/** One real extension-system entry (MCP server, language server, or skill). */
export type ExtensionEntry = {
  name: string;
  detail: string;
};

export type CommandPaletteItem = {
  command: SlashCommand;
  group: 'System' | 'Workspace';
  shortcut?: string;
};

const SYSTEM_COMMANDS = new Set(['help', 'mode', 'models', 'providers', 'settings', 'auto-approve', 'new', 'clear', 'status', 'cancel', 'exit']);

/** CLI display label for a mode: the autonomous coding mode is shown as Code. */
export function modeLabel(mode: AgentMode): string {
  return mode === 'auto' ? 'Code' : titleCase(mode);
}

export function normalizeModeName(value: string): AgentMode | undefined {
  const normalized = value.trim().toLowerCase();
  // `code` displays auto; the retired `orchestrator` maps to auto as well.
  if (normalized === 'code' || normalized === 'orchestrator') return 'auto';
  return ['ask', 'manual', 'auto', 'plan'].includes(normalized) ? normalized as AgentMode : undefined;
}
const COMMAND_SHORTCUTS: Record<string, string> = {
  mode: 'shift+tab',
  models: 'ctrl+m',
  cancel: 'esc',
  exit: 'ctrl+c',
};

export class InteractiveSession {
  readonly controller: ModeController;
  readonly commands = new SlashCommandRegistry();
  readonly workspaceRoot: string;
  providerRegistry?: ProviderRegistry;

  #providerId?: string;
  #model?: string;
  #models: string[] = [];
  #modelStrategy: ModelStrategy = 'failover';
  #activePoolModel?: string;
  #plan = '(no active plan yet — run a task or use /plan after one starts)';
  #status = 'idle';
  #attachments: Attachment[] = [];
  #callbacks: InteractiveCallbacks;
  #transcript: string[] = [];
  /** Streamed text of the in-flight turn: a live preview only, never committed as-is. */
  #liveTurnText: string | undefined;
  /** A finished text-only turn awaiting its THOUGHT (or task end) before it joins the transcript as the reply. */
  #pendingReply: string | undefined;
  /** Working phase of the running task ('thinking' | 'working' | 'validating'), undefined when idle. */
  #activityLabel: string | undefined;
  /** Animation tick for the spinner/scramble; advanced by the shell's timer, never by rendering. */
  #activityFrame = 0;
  /** When the running task started (elapsed display), ms epoch. */
  #activityStartedAt: number | undefined;
  /** Provider-reported tokens so far (status bar), accumulated from MODEL_REQUEST_FINISHED. */
  #usageTotal = 0;
  /** Recent casual-chat exchanges (user/assistant), capped at 6 turns. */
  #chatHistory: Message[] = [];
  #modifiedFiles = new Map<string, ModifiedFile>();
  #lsps: ExtensionEntry[] = [];
  #mcps: ExtensionEntry[] = [];
  #skills: ExtensionEntry[] = [];
  /** Skill names this workspace disabled (.daedalus/skills.json); surfaced for /skills + /skill honesty. */
  #disabledSkills = new Set<string>();
  /** Skills staged via `/skill <name>`; force-loaded into the next task. */
  #invokedSkills: string[] = [];
  #agents: ExtensionEntry[] = [];
  #sidebarVisible = true;
  #thinking = true;
  #contextPercent?: number;
  #rulesFiles: string[] = [];
  #palette = { open: false, filter: '', selectedIndex: 0 };
  /** Wrapped transcript lines hidden below the viewport (0 = pinned to bottom). */
  #scrollOffset = 0;
  /** Content rows of the most recent fullscreen render; the scroll page size. */
  #lastContentRows = 12;
  #modelPicker: { open: boolean; filter: string; selectedIndex: number; items: ModelPickerItem[]; loading: boolean } = {
    open: false,
    filter: '',
    selectedIndex: 0,
    items: [],
    loading: false,
  };
  #modelPickerRefresh: Promise<void> | undefined;
  #modelPickerListener: (() => void) | undefined;

  constructor(options: {
    workspaceRoot: string;
    initialMode?: AgentMode;
    autoApprove?: boolean;
    providerRegistry?: ProviderRegistry;
    providerId?: string;
    model?: string;
    models?: string[];
    modelStrategy?: ModelStrategy;
    thinking?: boolean;
    callbacks?: InteractiveCallbacks;
  }) {
    this.workspaceRoot = options.workspaceRoot;
    this.controller = new ModeController(options.initialMode ?? 'auto', options.autoApprove ?? false);
    this.providerRegistry = options.providerRegistry;
    this.#providerId = options.providerId;
    this.#model = options.model;
    this.#models = [...new Set((options.models ?? []).map((model) => model.trim()).filter(Boolean))];
    this.#modelStrategy = options.modelStrategy ?? 'failover';
    this.#activePoolModel = options.model ?? this.#models[0];
    this.#thinking = options.thinking !== false;
    this.#callbacks = options.callbacks ?? {};
  }

  get mode(): AgentMode {
    return this.controller.mode;
  }

  get autoApprove(): boolean {
    return this.controller.autoApprove;
  }

  get thinking(): boolean {
    return this.#thinking;
  }

  get providerId(): string | undefined {
    return this.#providerId;
  }

  get model(): string | undefined {
    return this.#model;
  }

  get models(): string[] {
    return [...this.#models];
  }

  get modelStrategy(): ModelStrategy {
    return this.#modelStrategy;
  }

  get activePoolModel(): string | undefined {
    return this.#activePoolModel ?? this.#model;
  }

  get sidebarVisible(): boolean {
    return this.#sidebarVisible;
  }

  get modifiedFiles(): ModifiedFile[] {
    return [...this.#modifiedFiles.values()];
  }

  get transcript(): string[] {
    return [...this.#transcript];
  }

  get paletteOpen(): boolean {
    return this.#palette.open;
  }

  get status(): string {
    return this.#status;
  }

  get paletteFilter(): string {
    return this.#palette.filter;
  }

  get modelPickerOpen(): boolean {
    return this.#modelPicker.open;
  }

  get modelPickerFilter(): string {
    return this.#modelPicker.filter;
  }

  get modelPickerLoading(): boolean {
    return this.#modelPicker.loading;
  }

  /** Total (unfiltered) models currently known to the picker. */
  get modelPickerTotal(): number {
    return this.#modelPicker.items.length;
  }

  get attachments(): Attachment[] {
    return [...this.#attachments];
  }

  get lsps(): ExtensionEntry[] {
    return [...this.#lsps];
  }

  get mcps(): ExtensionEntry[] {
    return [...this.#mcps];
  }

  get skills(): ExtensionEntry[] {
    return [...this.#skills];
  }

  get agents(): ExtensionEntry[] {
    return [...this.#agents];
  }

  setCallbacks(callbacks: InteractiveCallbacks): void {
    this.#callbacks = { ...this.#callbacks, ...callbacks };
  }

  setPlan(plan: string): void {
    this.#plan = plan;
  }

  /** Replace the sidebar's language-server entries with real status. */
  setLsps(entries: ExtensionEntry[]): void {
    this.#lsps = entries.map((entry) => ({ ...entry }));
  }

  /** Replace the sidebar's MCP entries with real connection status. */
  setMcps(entries: ExtensionEntry[]): void {
    this.#mcps = entries.map((entry) => ({ ...entry }));
  }

  /** Replace the sidebar's skill entries with the skills found on disk. */
  setSkills(entries: ExtensionEntry[]): void {
    this.#skills = entries.map((entry) => ({ ...entry }));
  }

  /** Record which skill names this workspace disables (for /skills and /skill feedback). */
  setDisabledSkills(names: string[]): void {
    this.#disabledSkills = new Set(names);
  }

  /** Skill names staged for force-load into the next task (via /skill). */
  get invokedSkills(): string[] {
    return [...this.#invokedSkills];
  }

  /** Replace the sidebar's subagent entries with the agents defined on disk. */
  setAgents(entries: ExtensionEntry[]): void {
    this.#agents = entries.map((entry) => ({ ...entry }));
  }

  setStatus(status: string): void {
    this.#status = status;
  }

  /** Latest context-window usage reported by the core on MODEL_REQUEST_* events. */
  get contextPercent(): number | undefined {
    return this.#contextPercent;
  }

  get rulesFiles(): string[] {
    return [...this.#rulesFiles];
  }

  /** Record which project-rules files the core loaded for this workspace. */
  setRulesFiles(files: string[]): void {
    this.#rulesFiles = [...files];
  }

  setModelSelection(selection: string): SlashCommandResult {
    const trimmed = selection.trim();
    if (!trimmed) return { text: 'Usage: /models <provider>/<model>, /models <model>, or /models <model-a,model-b>', action: 'models' };
    if (trimmed.includes(',')) {
      const models = [...new Set(trimmed.split(',').map((model) => model.trim()).filter(Boolean))];
      if (models.length === 0) return { text: 'Usage: /models <model-a,model-b>', action: 'models' };
      this.#models = models;
      this.#model = models[0];
      this.#activePoolModel = models[0];
      return {
        text: `Model pool set to ${models.join(', ')} (${this.#modelStrategy}; applies at the next turn boundary).`,
        action: 'models',
        data: { providerId: this.#providerId, model: this.#model, models, modelStrategy: this.#modelStrategy },
      };
    }
    const slash = trimmed.indexOf('/');
    if (slash > 0) {
      this.#providerId = trimmed.slice(0, slash);
      this.#model = trimmed.slice(slash + 1);
    } else {
      this.#model = trimmed;
    }
    this.#activePoolModel = this.#model;
    return {
      text: `Model set to ${this.#providerId ? `${this.#providerId}/` : ''}${this.#model} (applies at the next turn boundary).`,
      action: 'models',
      data: { providerId: this.#providerId, model: this.#model },
    };
  }

  setModelPool(models: string[], strategy: ModelStrategy = this.#modelStrategy): SlashCommandResult {
    this.#models = [...new Set(models.map((model) => model.trim()).filter(Boolean))];
    this.#modelStrategy = strategy;
    this.#model = this.#model ?? this.#models[0];
    this.#activePoolModel = this.#model;
    return {
      text: this.#models.length > 1
        ? `Model pool set to ${this.#models.join(', ')} (${strategy}; applies at the next turn boundary).`
        : 'Model pool cleared.',
      action: 'models',
      data: { models: this.models, modelStrategy: strategy, model: this.#model },
    };
  }

  cycleMode(): SlashCommandResult {
    const change = this.controller.cycle();
    return {
      text: `Mode: ${modeLabel(change.from)} → ${modeLabel(change.to)}. Applies at the next turn boundary${change.replanRequired ? '; re-plan required' : ''}.`,
      action: 'mode',
      data: change,
    };
  }

  handleShiftTab(): SlashCommandResult {
    return this.cycleMode();
  }

  setMode(mode: AgentMode): SlashCommandResult {
    const normalized = normalizeModeName(mode as string) ?? mode;
    const change = this.controller.set(normalized);
    return {
      text: `Mode: ${modeLabel(change.from)} → ${modeLabel(change.to)}. Applies at the next turn boundary${change.replanRequired ? '; re-plan required' : ''}.`,
      action: 'mode',
      data: change,
    };
  }

  setAutoApprove(value: boolean): SlashCommandResult {
    this.controller.setAutoApprove(value);
    return { text: `Auto-approve ${value ? 'on' : 'off'}. Mutations in Manual mode still ask.`, action: 'auto-approve', data: { autoApprove: value } };
  }

  setThinking(value: boolean): SlashCommandResult {
    this.#thinking = value;
    return {
      text: `Thinking ${value ? 'on' : 'off'}. ${value ? 'Provider thought text will be shown dimmed in the transcript when a model supplies it.' : 'THOUGHT events stay in the local event log but are hidden from this transcript.'}`,
      action: 'settings',
      data: { thinking: value },
    };
  }

  /** Shift+Tab arrives as ESC[Z or as a readline key named tab+shift. */
  isShiftTab(input: string, key?: { name?: string; shift?: boolean }): boolean {
    return input === '\u001b[Z' || (key?.name === 'tab' && key.shift === true);
  }

  statusBar(): string {
    return [
      `Daedalus`,
      `mode ${this.mode}`,
      `accent ${modeAccent(this.mode)}`,
      `provider ${this.#providerId ?? 'default'}`,
      `model ${this.#model ?? 'default'}`,
      ...(this.#models.length > 1 ? [`pool ${this.#modelStrategy}: ${this.#models.join(',')} active ${this.activePoolModel ?? 'default'}`] : []),
      `workspace ${this.workspaceRoot}`,
      `auto-approve ${this.autoApprove ? 'on' : 'off'}`,
      `thinking ${this.#thinking ? 'on' : 'off'}`,
      ...(this.#contextPercent !== undefined ? [`ctx ${this.#contextPercent}%`] : []),
      ...(this.#usageTotal > 0 ? [`tokens ${formatCount(this.#usageTotal)}`] : []),
      ...(this.#rulesFiles.length ? [`rules ${this.#rulesFiles.join(', ')}`] : []),
      `attachments ${this.#attachments.length}`,
      `status ${this.#status}`,
    ].join(' · ');
  }

  renderInputBox(value = ''): string {
    const content = `> ${value}`;
    const width = Math.max(28, Math.min(100, content.length + 4));
    const top = `╭${'─'.repeat(width - 2)}╮`;
    const middle = `│ ${content.padEnd(width - 4, ' ')} │`;
    const bottom = `╰${'─'.repeat(width - 2)}╯`;
    return [top, middle, bottom].join('\n');
  }

  addTranscript(text: string): void {
    for (const line of text.split(/\r?\n/)) this.#transcript.push(line);
    if (this.#transcript.length > 200) this.#transcript.splice(0, this.#transcript.length - 200);
  }

  /**
   * Transcript entry kinds, visually distinct like the reference TUIs:
   * the user speaks as "You ›", the assistant's answer as "Daedalus ›",
   * thinking stays "thinking ·" (dimmed), tool calls are compact "⚙"
   * lines with indented "↳" results, and system/status lines carry "·".
   * The fullscreen shell colors each kind by its prefix.
   */
  addUserLine(text: string): void {
    this.addTranscript(`You › ${text}`);
  }

  addAssistantLine(text: string): void {
    const lines = text.split(/\r?\n/);
    lines.forEach((line, index) => this.addTranscript(index === 0 ? `Daedalus › ${line}` : line));
  }

  addSystemLine(text: string): void {
    const lines = text.split(/\r?\n/);
    lines.forEach((line, index) => this.addTranscript(index === 0 ? `· ${line}` : line));
  }

  /** Wrapped lines currently scrolled out of view at the bottom (0 = at bottom). */
  get scrollOffset(): number {
    return this.#scrollOffset;
  }

  get isTranscriptScrolled(): boolean {
    return this.#scrollOffset > 0;
  }

  /** Scroll the transcript: positive delta moves toward older lines. Clamped at render. */
  scrollTranscript(deltaLines: number): void {
    this.#scrollOffset = Math.max(0, this.#scrollOffset + deltaLines);
  }

  /** Page through the transcript using the last rendered page size. */
  scrollTranscriptPage(direction: 1 | -1): void {
    this.scrollTranscript(direction * Math.max(1, this.#lastContentRows - 1));
  }

  jumpTranscriptToBottom(): void {
    this.#scrollOffset = 0;
  }

  jumpTranscriptToTop(): void {
    this.#scrollOffset = Number.MAX_SAFE_INTEGER;
  }

  /** The in-flight turn's streamed text, while it is still a preview. */
  get liveTurnText(): string | undefined {
    return this.#liveTurnText;
  }

  /** Current animation tick (the shell's colorizer gradients by it). */
  get activityFrame(): number {
    return this.#activityFrame;
  }

  /** Advance the working animation one tick; the shell timer owns the cadence. */
  tickActivity(): void {
    if (this.#activityLabel) this.#activityFrame += 1;
  }

  #setActivity(label: string): void {
    if (this.#activityLabel !== label) {
      this.#activityLabel = label;
      this.#activityFrame = 0;
    }
    this.#activityStartedAt ??= Date.now();
  }

  #clearActivity(): void {
    this.#activityLabel = undefined;
    this.#activityFrame = 0;
    this.#activityStartedAt = undefined;
  }

  /** Stop the working animation (shell calls this when a run ends without TASK_COMPLETED). */
  stopActivity(): void {
    this.#clearActivity();
  }

  /**
   * The working line: spinner glyph (painted with the working
   * gradient by the shell), the phase label scrambling into place,
   * and elapsed seconds — e.g. "⠹ thinking · 12s". Present only
   * while a task runs; the streamed text, when there is any, follows
   * below it as the live preview.
   */
  #activityDisplayLine(): string[] {
    if (!this.#activityLabel) return [];
    const elapsed = this.#activityStartedAt ? Math.max(0, Math.floor((Date.now() - this.#activityStartedAt) / 1000)) : 0;
    return [`${spinnerGlyph(this.#activityFrame)} ${scrambleText(this.#activityLabel, this.#activityFrame)} · ${elapsed}s`];
  }

  #flushPendingReply(): void {
    if (!this.#pendingReply) return;
    this.addAssistantLine(this.#pendingReply);
    this.#pendingReply = undefined;
  }

  observeEvent(event: Event): void {
    if (event.type === 'TASK_STARTED') this.#setActivity('thinking');
    if (event.type === 'MODEL_REQUEST_STARTED') this.#setActivity('thinking');
    if (event.type === 'TOOL_CALL_STARTED') this.#setActivity('working');
    if (event.type === 'VALIDATION_STARTED') this.#setActivity('validating');
    if (event.type === 'MODEL_TEXT_DELTA') {
      // Cumulative streamed text: keep it as a live preview. It joins
      // the transcript only when the turn resolves as the reply.
      const payload = event.payload as { text?: string };
      if (payload.text) this.#liveTurnText = payload.text;
      return;
    }
    if (event.type === 'MODEL_REQUEST_FINISHED') {
      // The streamed turn resolves here. Prose that accompanied tool
      // calls was a preamble — drop it. A text-only turn IS the reply:
      // stash it so this turn's THOUGHT still prints first.
      const payload = event.payload as { message?: { tool_calls?: unknown[] }; usage?: { total_tokens?: unknown } };
      if (this.#liveTurnText) {
        if (!payload.message?.tool_calls?.length) this.#pendingReply = this.#liveTurnText;
        this.#liveTurnText = undefined;
      }
      if (typeof payload.usage?.total_tokens === 'number') this.#usageTotal += payload.usage.total_tokens;
    }
    if (event.type === 'TASK_COMPLETED') {
      this.#flushPendingReply();
      this.#liveTurnText = undefined;
      this.#clearActivity();
    }
    if (event.type === 'MODEL_REQUEST_STARTED' || event.type === 'MODEL_REQUEST_FINISHED') {
      const payload = event.payload as { context_percent?: number };
      if (typeof payload.context_percent === 'number') this.#contextPercent = payload.context_percent;
      return;
    }
    if (event.type === 'THOUGHT') {
      if (!this.#thinking) return;
      const payload = event.payload as { text?: string };
      if (payload.text) {
        // Collapsed like the reference TUI's thinking block: a few dimmed
        // lines at most, with the hidden remainder counted, never a wall.
        const lines = payload.text.split(/\r?\n/).map((line) => line.trimEnd()).filter((line) => line.trim().length > 0);
        const shown = lines.slice(0, 3);
        shown.forEach((line, index) => this.addTranscript(index === 0 ? `thinking · ${line}` : `  ${line}`));
        if (lines.length > shown.length) this.addTranscript(`thinking · … (${lines.length - shown.length} more lines)`);
      }
      // The reply this thinking produced joins right below it.
      this.#flushPendingReply();
      return;
    }
    if (event.type === 'FILE_CHANGED') {
      const payload = event.payload as { path?: string; operation?: string; added?: number; removed?: number; tool?: string };
      if (payload.path) {
        this.#modifiedFiles.set(payload.path, {
          path: payload.path,
          operation: payload.operation,
          added: payload.added,
          removed: payload.removed,
          tool: payload.tool,
        });
        this.addSystemLine(`file ${payload.operation ?? 'changed'} ${payload.path}`);
      }
      return;
    }
    if (event.type === 'PROVIDER_CHANGED') {
      const payload = event.payload as { to_model?: string; model?: string; to?: string; provider_id?: string };
      const nextModel = payload.to_model ?? payload.model ?? payload.to;
      if (nextModel) {
        this.#activePoolModel = nextModel;
        this.#model = nextModel;
      }
      if (payload.provider_id) this.#providerId = payload.provider_id;
      this.addSystemLine(`provider changed → ${nextModel ?? 'unknown model'}`);
      return;
    }
    if (event.type === 'PLAN_CREATED') {
      const plan = (event.payload as { plan?: { steps?: Array<{ intent: string; status?: string }> } }).plan;
      if (plan?.steps) this.setPlan(plan.steps.map((step, index) => `${index + 1}. [${step.status ?? 'pending'}] ${step.intent}`).join('\n'));
    }
  }

  toggleSidebar(): boolean {
    this.#sidebarVisible = !this.#sidebarVisible;
    return this.#sidebarVisible;
  }

  renderHintBar(): string {
    return 'esc cancel · tab focus chat · shift+tab mode · / commands · ctrl+p commands · ctrl+b sidebar · ctrl+c quit';
  }

  renderSidebar(width = 34): string[] {
    const w = Math.max(26, width);
    const inner = w - 4;
    const lines: string[] = [];
    const push = (text = '') => lines.push(`│ ${fit(text, inner)} │`);
    lines.push(`╭${'─'.repeat(w - 2)}╮`);
    push('◇ Daedalus');
    push(`session ${this.#status}`);
    push(`workspace ${this.workspaceRoot}`);
    push(`mode ${this.mode} · auto-approve ${this.autoApprove ? 'on' : 'off'}`);
    push(`thinking ${this.#thinking ? 'on' : 'off'}`);
    push(`provider ${this.#providerId ?? 'default'}`);
    push(`model ${this.#model ?? 'default'}`);
    if (this.#models.length > 1) {
      push(`pool ${this.#modelStrategy} (${this.#models.length})`);
      push(`active ${this.activePoolModel ?? 'default'}`);
      push(this.#models.map((model) => `${model === this.activePoolModel ? '●' : '○'} ${model}`).join(' '));
    }
    push(`context ${contextSummary(this.#plan)} · attachments ${this.#attachments.length}`);
    push('');
    push('Modified Files');
    if (this.#modifiedFiles.size === 0) push('None');
    else for (const file of this.#modifiedFiles.values()) push(`${file.operation ?? 'changed'} ${file.path} (+${file.added ?? 0}/-${file.removed ?? 0})`);
    push('');
    push('LSPs');
    if (this.#lsps.length === 0) push('None (not configured)');
    else for (const entry of this.#lsps.slice(0, 6)) push(`${entry.name} · ${entry.detail}`);
    push('');
    push('MCPs');
    if (this.#mcps.length === 0) push('None (not configured)');
    else for (const entry of this.#mcps.slice(0, 6)) push(`${entry.name} · ${entry.detail}`);
    push('');
    push('Skills');
    if (this.#skills.length === 0) push('None (not configured)');
    else for (const entry of this.#skills.slice(0, 6)) push(`${entry.name} · ${entry.detail}`);
    push('');
    push('Subagents');
    if (this.#agents.length === 0) push('None (not configured)');
    else for (const entry of this.#agents.slice(0, 6)) push(`${entry.name} · ${entry.detail}`);
    lines.push(`╰${'─'.repeat(w - 2)}╯`);
    return lines;
  }

  /** The live preview's visible tail: last lines of the in-flight turn's streamed text. */
  #liveDisplayLines(): string[] {
    if (!this.#liveTurnText) return [];
    const lines = this.#liveTurnText.split(/\r?\n/).map((line) => line.trimEnd()).filter((line) => line.trim().length > 0);
    return lines.slice(-3).map((line, index) => (index === 0 ? `thinking · live · ${line}` : `  ${line}`));
  }

  renderLayout(options: { transcript?: string[]; input?: string; columns?: number } = {}): string {
    const columns = Math.max(40, Math.min(180, options.columns ?? 110));
    const transcript = options.transcript ?? this.#transcript;
    const leftBase = [
      'Daedalus',
      ...(transcript.length ? transcript.slice(-18) : ['No messages yet. Type a goal, or / for commands.']),
      ...this.#activityDisplayLine(),
      ...this.#liveDisplayLines(),
      '',
      `> ${options.input ?? ''}`,
    ];
    if (!this.#sidebarVisible || columns < 72) {
      return [...leftBase, '', this.statusBar(), this.renderHintBar()].join('\n');
    }
    const sidebarWidth = Math.max(28, Math.min(38, Math.floor(columns * 0.32)));
    const mainWidth = columns - sidebarWidth - 1;
    const left = leftBase.map((line) => fit(line, mainWidth).padEnd(mainWidth, ' '));
    const right = this.renderSidebar(sidebarWidth);
    const rows = Math.max(left.length, right.length);
    const combined: string[] = [];
    for (let i = 0; i < rows; i++) {
      combined.push(`${(left[i] ?? ''.padEnd(mainWidth, ' ')).padEnd(mainWidth, ' ')} ${right[i] ?? ''}`.trimEnd());
    }
    return [...combined, this.renderHintBar()].join('\n');
  }

  openCommandPalette(filter = ''): CommandPaletteItem[] {
    this.closeModelPicker();
    this.#palette.open = true;
    this.#palette.filter = filter.replace(/^\//, '').toLowerCase();
    this.#palette.selectedIndex = 0;
    return this.paletteItems();
  }

  updateCommandPalette(input: string): CommandPaletteItem[] {
    if (!input.startsWith('/')) {
      this.#palette.open = false;
      return [];
    }
    const items = this.openCommandPalette(input.slice(1));
    return items;
  }

  paletteItems(): CommandPaletteItem[] {
    const commands = this.commands.suggestions(`/${this.#palette.filter}`);
    return commands.map((command) => ({
      command,
      group: SYSTEM_COMMANDS.has(command.name) ? 'System' as const : 'Workspace' as const,
      shortcut: COMMAND_SHORTCUTS[command.name],
    }));
  }

  selectedPaletteItem(): CommandPaletteItem | undefined {
    const items = this.paletteItems();
    if (items.length === 0) return undefined;
    const index = Math.min(this.#palette.selectedIndex, items.length - 1);
    return items[index];
  }

  movePaletteSelection(delta: number): CommandPaletteItem | undefined {
    const items = this.paletteItems();
    if (items.length === 0) return undefined;
    this.#palette.selectedIndex = (this.#palette.selectedIndex + delta + items.length) % items.length;
    return this.selectedPaletteItem();
  }

  acceptPaletteSelection(): string | undefined {
    const item = this.selectedPaletteItem();
    if (!item) return undefined;
    this.#palette.open = false;
    return `/${item.command.name}`;
  }

  closeCommandPalette(): void {
    this.#palette.open = false;
  }

  /** Notified (fullscreen shell) when async model discovery updates the picker. */
  setModelPickerListener(listener: (() => void) | undefined): void {
    this.#modelPickerListener = listener;
  }

  /** Models known locally without any network discovery: configured provider models, the session model, and the pool. */
  localModelItems(): ModelPickerItem[] {
    const items: ModelPickerItem[] = [];
    const seen = new Set<string>();
    const add = (providerId: string, model: string) => {
      const cleanModel = model.trim();
      if (!cleanModel) return;
      const key = `${providerId}/${cleanModel}`;
      if (seen.has(key)) return;
      seen.add(key);
      items.push({ providerId, model: cleanModel });
    };
    const providers = this.providerRegistry?.list().filter((provider) => provider.enabled) ?? [];
    for (const provider of providers) {
      if (this.#providerId && provider.id !== this.#providerId) continue;
      for (const model of provider.models) add(provider.id, model);
    }
    if (this.#model) add(this.#providerId ?? providers[0]?.id ?? 'default', this.#model);
    for (const model of this.#models) add(this.#providerId ?? providers[0]?.id ?? 'default', model);
    return items;
  }

  /**
   * Open the model picker overlay with the locally known models, then refresh
   * from provider discovery in the background (a provider can expose hundreds
   * of models; the picker stays filterable while discovery runs).
   */
  async openModelPicker(): Promise<ModelPickerItem[]> {
    this.closeCommandPalette();
    const items = this.localModelItems();
    this.#modelPicker.open = true;
    this.#modelPicker.filter = '';
    this.#modelPicker.items = items;
    this.#modelPicker.loading = Boolean(this.providerRegistry);
    const current = items.findIndex((item) => item.model === this.#model && (item.providerId === this.#providerId || !this.#providerId));
    this.#modelPicker.selectedIndex = current >= 0 ? current : 0;
    void this.refreshModelPicker();
    return this.modelPickerItems();
  }

  /** Re-run provider model discovery and merge the result into the open picker. */
  refreshModelPicker(): Promise<void> {
    if (this.#modelPickerRefresh) return this.#modelPickerRefresh;
    if (!this.providerRegistry) {
      this.#modelPicker.loading = false;
      return Promise.resolve();
    }
    const registry = this.providerRegistry;
    const run = (async () => {
      try {
        const discovered = await registry.listModels(this.#providerId);
        if (this.#modelPicker.open && discovered.length > 0) {
          const merged: ModelPickerItem[] = [];
          const seen = new Set<string>();
          for (const item of [...this.#modelPicker.items, ...discovered]) {
            const key = `${item.providerId}/${item.model}`;
            if (seen.has(key)) continue;
            seen.add(key);
            merged.push({ providerId: item.providerId, model: item.model });
          }
          this.#modelPicker.items = merged;
          const filtered = this.modelPickerItems();
          if (this.#modelPicker.selectedIndex >= filtered.length) this.#modelPicker.selectedIndex = Math.max(0, filtered.length - 1);
        }
      } catch {
        // Discovery is best-effort; the locally known models stay selectable.
      } finally {
        this.#modelPicker.loading = false;
        this.#modelPickerListener?.();
      }
    })();
    this.#modelPickerRefresh = run;
    void run.finally(() => {
      if (this.#modelPickerRefresh === run) this.#modelPickerRefresh = undefined;
    });
    return run;
  }

  /** Models matching the current picker filter (substring, case-insensitive). */
  modelPickerItems(): ModelPickerItem[] {
    const filter = this.#modelPicker.filter.trim().toLowerCase();
    if (!filter) return [...this.#modelPicker.items];
    return this.#modelPicker.items.filter((item) => `${item.providerId}/${item.model}`.toLowerCase().includes(filter));
  }

  selectedModelPickerItem(): ModelPickerItem | undefined {
    const items = this.modelPickerItems();
    if (items.length === 0) return undefined;
    return items[Math.min(this.#modelPicker.selectedIndex, items.length - 1)];
  }

  moveModelPickerSelection(delta: number): ModelPickerItem | undefined {
    const items = this.modelPickerItems();
    if (items.length === 0) return undefined;
    this.#modelPicker.selectedIndex = (this.#modelPicker.selectedIndex + delta + items.length) % items.length;
    return this.selectedModelPickerItem();
  }

  setModelPickerFilter(filter: string): ModelPickerItem[] {
    this.#modelPicker.filter = filter;
    this.#modelPicker.selectedIndex = 0;
    return this.modelPickerItems();
  }

  /**
   * Apply the highlighted model to the session and close the picker. Adds a
   * single confirmation line to the transcript — never the model list.
   */
  acceptModelPickerSelection(): SlashCommandResult | undefined {
    const item = this.selectedModelPickerItem();
    if (!item) return undefined;
    this.closeModelPicker();
    const result = !item.providerId || item.providerId === 'default'
      ? this.setModelSelection(item.model)
      : this.setModelSelection(`${item.providerId}/${item.model}`);
    this.addSystemLine(result.text);
    return result;
  }

  closeModelPicker(): void {
    this.#modelPicker.open = false;
    this.#modelPicker.loading = false;
  }

  /** Crush-style centered "Switch Model" modal: filter line, provider right-aligned, highlighted selection bar. */
  renderModelPicker(width = 72, maxVisible = 12): string {
    if (!this.#modelPicker.open) return '';
    const w = Math.max(46, Math.min(88, width));
    const inner = w - 4;
    const cap = Math.max(3, maxVisible);
    const items = this.modelPickerItems();
    const total = this.#modelPicker.items.length;
    const filterText = this.#modelPicker.filter || 'Type to filter';
    const lines = [
      `╭${'─'.repeat(w - 2)}╮`,
      `│ ${padVisibleEnd(`Switch Model  ${items.length}/${total}${this.#modelPicker.loading ? ' · loading…' : ''}`, inner)} │`,
      `│ ${padVisibleEnd(`> ${filterText}`, inner)} │`,
      `│ ${'─'.repeat(inner)} │`,
    ];
    if (items.length === 0) {
      lines.push(`│ ${padVisibleEnd(this.#modelPicker.loading ? 'Loading models…' : total === 0 ? 'No models available — configure a provider, or set one with /models <provider>/<model>' : `No models match "${this.#modelPicker.filter}"`, inner)} │`);
    } else {
      const selected = Math.min(this.#modelPicker.selectedIndex, items.length - 1);
      const start = Math.max(0, Math.min(selected - Math.floor(cap / 2), items.length - cap));
      const visible = items.slice(start, start + cap);
      for (const [offset, item] of visible.entries()) {
        const index = start + offset;
        const isSelected = index === selected;
        const current = item.model === this.#model && (item.providerId === this.#providerId || !this.#providerId);
        // The selected row is a full-width bar ([ … ]) inside the box; other
        // rows keep the same inner width so the borders never shift.
        const body = inner - (isSelected ? 2 : 0);
        const label = `${isSelected ? '›' : ' '} ${item.model}${current ? ' ●' : ''}`;
        const provider = item.providerId;
        const labelBudget = Math.max(8, body - visibleWidth(provider) - 1);
        const row = `${padVisibleEnd(fit(label, labelBudget), labelBudget)} ${fit(provider, body - labelBudget - 1)}`;
        lines.push(isSelected ? `│ [${row}] │` : `│ ${padVisibleEnd(row, inner)} │`);
      }
      if (start + visible.length < items.length) lines.push(`│ ${padVisibleEnd(`… ${items.length - (start + visible.length)} more — type to filter`, inner)} │`);
      if (start > 0) lines.push(`│ ${padVisibleEnd(`… ${start} above`, inner)} │`);
    }
    lines.push(`│ ${'─'.repeat(inner)} │`);
    lines.push(`│ ${padVisibleEnd('↑/↓ choose · enter confirm · esc exit · type to filter', inner)} │`);
    lines.push(`╰${'─'.repeat(w - 2)}╯`);
    return lines.join('\n');
  }

  renderCommandPalette(width = 72): string {
    if (!this.#palette.open) return '';
    const w = Math.max(46, Math.min(88, width));
    const inner = w - 4;
    const filterLabel = this.#palette.filter ? `/${this.#palette.filter}` : '';
    const filterText = this.#palette.filter || 'Type to filter';
    const lines = [
      `╭${'─'.repeat(w - 2)}╮`,
      `│ ${fit(`Commands ${filterLabel}  //////////////////  ● System  ○ Workspace`, inner)} │`,
      `│ ${fit(`> ${filterText}`, inner)} │`,
      `│ ${'─'.repeat(inner)} │`,
    ];
    const items = this.paletteItems();
    if (items.length === 0) {
      lines.push(`│ ${fit('No matching commands', inner)} │`);
    } else {
      const maxVisible = 14;
      const selected = Math.min(this.#palette.selectedIndex, items.length - 1);
      const start = Math.max(0, Math.min(selected - 6, items.length - maxVisible));
      const visible = items.slice(start, start + maxVisible);
      let lastGroup = '';
      for (const [offset, item] of visible.entries()) {
        const index = start + offset;
        if (item.group !== lastGroup) {
          lastGroup = item.group;
          lines.push(`│ ${fit(lastGroup, inner)} │`);
        }
        const marker = index === selected ? '›' : ' ';
        const shortcut = item.shortcut ?? '';
        const label = `${marker} ${commandTitle(item.command.name)}  /${item.command.name}`;
        const available = Math.max(8, inner - shortcut.length - 1);
        lines.push(`│ ${padVisibleEnd(fit(label, available), available)}${shortcut ? ` ${fit(shortcut, inner - available - 1)}` : ''} │`);
      }
      if (start + visible.length < items.length) lines.push(`│ ${fit(`… ${items.length - (start + visible.length)} more`, inner)} │`);
    }
    lines.push(`│ ${'─'.repeat(inner)} │`);
    lines.push(`│ ${fit('tab switch selection · ↑/↓ choose · enter confirm · esc cancel', inner)} │`);
    lines.push(`╰${'─'.repeat(w - 2)}╯`);
    return lines.join('\n');
  }

  renderSidebarLines(width = 36): string[] {
    const w = Math.max(26, width);
    const lines: string[] = [];
    const push = (text = '') => lines.push(fit(text, w));
    const section = (title: string) => {
      push('');
      push(title);
      push('─'.repeat(Math.min(w, Math.max(8, title.length + 6))));
    };
    push('◇ DAEDALUS  v0.1.0');
    push('Agentic coding workspace');
    push('─'.repeat(w));
    push('');
    push(this.#status === 'idle' ? 'New Session' : `Session · ${this.#status}`);
    push(basename(this.workspaceRoot) || this.workspaceRoot);
    push('');
    push('Model');
    push(`◇ ${this.activePoolModel ?? this.#model ?? 'default model'}`);
    push(`  via ${this.#providerId ?? 'default provider'}`);
    push(`  ${modeLabel(this.mode)} mode · auto-approve ${this.autoApprove ? 'on' : 'off'}`);
    push(`  thinking ${this.#thinking ? 'on' : 'off'}`);
    if (this.#contextPercent !== undefined) push(`  ctx ${this.#contextPercent}% of context window`);
    if (this.#models.length > 1) push(`  pool ${this.#modelStrategy} · ${this.#models.length} models`);
    push(`  ${this.#attachments.length} attachments`);
    section('Plan');
    if (!this.#plan || this.#plan.startsWith('(no active plan')) {
      push('No active plan');
    } else {
      const steps = this.#plan.split(/\r?\n/).filter((line) => line.trim().length > 0).slice(0, 6);
      for (const step of steps) {
        const icon = step.includes('[done]') ? '✓' : step.includes('[active]') ? '▶' : '○';
        push(`${icon} ${step.replace(/^\d+\.\s*/, '')}`);
      }
    }
    section('Modified Files');
    if (this.#modifiedFiles.size === 0) push('None');
    else for (const file of this.#modifiedFiles.values()) push(`${file.operation ?? 'changed'}  ${file.path}  +${file.added ?? 0} -${file.removed ?? 0}`);
    section('LSPs');
    if (this.#lsps.length === 0) push('None (not configured)');
    else for (const entry of this.#lsps.slice(0, 6)) push(`${entry.name}  ${entry.detail}`);
    section('MCPs');
    if (this.#mcps.length === 0) push('None (not configured)');
    else for (const entry of this.#mcps.slice(0, 6)) push(`${entry.name}  ${entry.detail}`);
    section('Skills');
    if (this.#skills.length === 0) push('None (not configured)');
    else for (const entry of this.#skills.slice(0, 6)) push(`${entry.name}  ${entry.detail}`);
    section('Subagents');
    if (this.#agents.length === 0) push('None (not configured)');
    else for (const entry of this.#agents.slice(0, 6)) push(`${entry.name}  ${entry.detail}`);
    return lines;
  }

  renderScreen(options: { transcript?: string[]; input?: string; cursor?: number; columns?: number; rows?: number } = {}): string {
    const columns = Math.max(40, Math.min(220, options.columns ?? 132));
    const rows = Math.max(18, Math.min(80, options.rows ?? 36));
    const showSidebar = this.#sidebarVisible && columns >= 92;
    const sidebarWidth = showSidebar ? Math.max(30, Math.min(40, Math.floor(columns * 0.27))) : 0;
    const mainWidth = showSidebar ? columns - sidebarWidth - 4 : columns;
    const rawInput = options.input ?? '';
    const cursor = Math.max(0, Math.min(rawInput.length, options.cursor ?? rawInput.length));
    const shownInput = sanitizeTerminalText(`${rawInput.slice(0, cursor)}█${rawInput.slice(cursor)}`.replace(/[\r\n]+/g, ' '));
    const composerWidth = Math.max(32, columns - 2);
    const composerLabel = ` Daedalus · ${modeLabel(this.mode)} · ${this.#providerId ?? 'default'}/${this.activePoolModel ?? this.#model ?? 'default'} `;
    const composerTitle = fit(composerLabel, composerWidth - 2);
    const footerLines = [
      `╭${composerTitle}${'─'.repeat(Math.max(0, composerWidth - 2 - visibleWidth(composerTitle)))}╮`,
      `│ > ${padVisibleEnd(shownInput, composerWidth - 6)} │`,
      `╰${'─'.repeat(composerWidth - 2)}╯`,
      'pgup/pgdn scroll · shift+tab mode · / or ctrl+p commands · ctrl+m models · ctrl+b toggle sidebar · shift+enter newline · ctrl+c quit',
    ];
    const contentRows = Math.max(6, rows - footerLines.length);
    this.#lastContentRows = contentRows;
    const transcript = options.transcript ?? this.#transcript;
    const displayTranscript = [...(transcript.length ? transcript : ['Type a goal below, or press / for commands.']), ...this.#activityDisplayLine(), ...this.#liveDisplayLines()]
      .map((line) => sanitizeTerminalText(line));
    const wrapped: string[] = [];
    for (const line of displayTranscript) {
      wrapped.push(...wrapText(line, Math.max(20, mainWidth - 4)));
    }
    // Scroll window: offset counts wrapped lines hidden below the viewport.
    // New output never yanks a scrolled view back to the bottom; submitting
    // or pressing End calls jumpTranscriptToBottom instead.
    const maxOffset = Math.max(0, wrapped.length - contentRows);
    const offset = Math.min(this.#scrollOffset, maxOffset);
    this.#scrollOffset = offset;
    const windowEnd = wrapped.length - offset;
    const visible = wrapped.slice(Math.max(0, windowEnd - contentRows), windowEnd);
    while (visible.length < contentRows) visible.push('');
    if (offset > 0) visible[contentRows - 1] = '▲ scrolled — End to jump back';
    const sidebar = showSidebar ? this.renderSidebarLines(sidebarWidth) : [];
    const screen: string[] = [];
    for (let i = 0; i < contentRows; i++) {
      const left = padVisibleEnd(`  ${visible[i] ?? ''}`, mainWidth);
      const right = showSidebar ? padVisibleEnd(sidebar[i] ?? '', sidebarWidth) : '';
      screen.push(truncateVisible(showSidebar ? `${left} │ ${right}` : left, columns));
    }
    if (this.#palette.open || this.#modelPicker.open) {
      const overlayLines = this.#modelPicker.open
        ? this.renderModelPicker(Math.max(48, Math.min(84, mainWidth - 8, columns - 16)), Math.max(4, Math.min(16, contentRows - 10))).split('\n')
        : this.renderCommandPalette(Math.max(48, Math.min(76, mainWidth - 8, columns - 16))).split('\n');
      const overlayWidth = Math.max(...overlayLines.map((line) => visibleWidth(line)), 0);
      const startRow = Math.max(1, Math.floor((contentRows - overlayLines.length) / 2));
      const startCol = Math.max(1, Math.floor((mainWidth - overlayWidth) / 2) + 1);
      const clearFrom = Math.max(0, startCol - 2);
      const clearTo = Math.min(columns, startCol + overlayWidth + 2);
      for (let row = Math.max(0, startRow - 1); row < Math.min(contentRows, startRow + overlayLines.length + 1); row++) {
        const base = screen[row] ?? '';
        screen[row] = truncateVisible(`${padVisibleEnd(sliceVisible(base, 0, clearFrom), clearFrom)}${' '.repeat(clearTo - clearFrom)}${sliceVisible(base, clearTo)}`, columns);
      }
      for (let i = 0; i < overlayLines.length && startRow + i < contentRows; i++) {
        const base = screen[startRow + i] ?? '';
        const overlay = overlayLines[i] ?? '';
        screen[startRow + i] = truncateVisible(`${padVisibleEnd(sliceVisible(base, 0, startCol), startCol)}${overlay}${sliceVisible(base, startCol + visibleWidth(overlay))}`, columns);
      }
    }
    screen.push(...footerLines);
    // Final guarantee: no composed line ever exceeds the terminal width, so a
    // repaint can never wrap, scroll the alternate screen, or leave ghosts.
    return screen.slice(0, rows).map((line) => truncateVisible(line, columns)).join('\n');
  }

  handleKey(input: string, key: InteractiveKey = {}): InteractiveKeyAction {
    const name = key.name ?? '';
    if (this.#modelPicker.open) {
      if (name === 'escape' || input === '\u001b') { this.closeModelPicker(); return { action: 'model_close' }; }
      if (name === 'up' || (key.ctrl && name === 'p')) { this.moveModelPickerSelection(-1); return { action: 'model_up' }; }
      if (name === 'down' || (key.ctrl && name === 'n')) { this.moveModelPickerSelection(1); return { action: 'model_down' }; }
      if (name === 'enter' || name === 'return') {
        const result = this.acceptModelPickerSelection();
        return result ? { action: 'model_accept', text: result.text, data: result } : { action: 'none' };
      }
      if (name === 'backspace') {
        this.setModelPickerFilter(this.#modelPicker.filter.slice(0, -1));
        return { action: 'model_filter', text: this.#modelPicker.filter };
      }
      if (input && !key.ctrl && !key.meta && input >= ' ') {
        this.setModelPickerFilter(this.#modelPicker.filter + input);
        return { action: 'model_filter', text: this.#modelPicker.filter };
      }
    }
    if (this.#palette.open) {
      if (name === 'escape' || input === '\u001b') { this.closeCommandPalette(); return { action: 'palette_close' }; }
      if (name === 'up') return { action: 'palette_up', command: this.movePaletteSelection(-1)?.command.name };
      if (name === 'down') return { action: 'palette_down', command: this.movePaletteSelection(1)?.command.name };
      if (name === 'enter' || name === 'return' || name === 'tab') {
        const command = this.acceptPaletteSelection();
        return command ? { action: 'palette_accept', command } : { action: 'palette_close' };
      }
    }
    if (key.ctrl && name === 'c') return { action: 'quit' };
    if (key.ctrl && name === 'b') return { action: 'toggle_sidebar', text: `Sidebar ${this.toggleSidebar() ? 'shown' : 'hidden'}.` };
    if (key.ctrl && name === 'p') { this.openCommandPalette(); return { action: 'open_commands' }; }
    if (key.ctrl && name === 'm') return { action: 'open_models', command: '/models' };
    if (name === 'escape' || input === '\u001b') return { action: this.#status === 'running' ? 'cancel' : 'palette_close' };
    if (this.isShiftTab(input, key)) {
      const result = this.cycleMode();
      return { action: 'cycle_mode', text: result.text };
    }
    if (name === 'tab') return { action: 'focus_chat' };
    if ((name === 'return' || name === 'enter') && key.shift) return { action: 'newline' };
    if (input === '/') { this.openCommandPalette(); return { action: 'open_commands' }; }
    return { action: 'none' };
  }

  suggestions(input: string): SlashCommand[] {
    if (!input.startsWith('/')) {
      this.#palette.open = false;
      return [];
    }
    this.updateCommandPalette(input);
    return this.commands.suggestions(input);
  }

  async handleInput(input: string): Promise<InteractiveHandleResult> {
    const trimmed = input.trim();
    if (!trimmed) return { kind: 'empty', text: '' };
    if (this.isShiftTab(input)) {
      const result = this.cycleMode();
      return { kind: 'slash', text: result.text, action: result.action, data: result.data };
    }
    if (trimmed.startsWith('/')) {
      const parsed = this.commands.parse(trimmed);
      // Bare /models opens the interactive picker overlay instead of dumping
      // the (potentially hundreds-long) model list into the transcript.
      if (parsed?.name === 'models' && parsed.args.length === 0) {
        const items = await this.openModelPicker();
        this.addUserLine(trimmed);
        return { kind: 'slash', text: '', action: 'models', data: { picker: true, count: items.length } };
      }
      // `/skill <name> <task…>` is a task with a forced skill load, not a
      // registry command: validate the name first (unknown/disabled warn
      // visibly and submit nothing), then hand the host a task carrying
      // the skill names alongside any staged invocations.
      if (parsed?.name === 'skill' && parsed.args.length >= 2) {
        const name = parsed.args[0]!;
        const problem = this.#skillProblem(name);
        this.closeCommandPalette();
        this.addUserLine(trimmed);
        if (problem) {
          this.addSystemLine(problem);
          return { kind: 'slash', text: problem, action: 'skill' };
        }
        const skills = [name, ...this.#invokedSkills.filter((entry) => entry !== name)];
        this.#invokedSkills = [];
        return { kind: 'task', text: parsed.args.slice(1).join(' '), data: { skills } };
      }
      const result = await this.commands.execute(trimmed, this.#slashContext());
      this.closeCommandPalette();
      this.addUserLine(trimmed);
      if (result.text) this.addSystemLine(result.text);
      if (result.action === 'exit') this.#status = 'closed';
      return { kind: 'slash', text: result.text, action: result.action, data: result.data };
    }
    this.addUserLine(trimmed);
    const intent = classifyChatIntent(trimmed);
    if (intent === 'conversational' || intent === 'question') {
      // Chat and questions are answered directly — never planned, never a
      // task, in every mode. Modes govern tasks only; a question is just
      // the model replying, like in the reference agents.
      const reply = intent === 'question'
        ? await this.#questionReply(trimmed)
        : await this.#conversationalReply(trimmed);
      this.#chatHistory.push(
        { role: 'user', content: trimmed },
        { role: 'assistant', content: reply },
      );
      if (this.#chatHistory.length > 12) this.#chatHistory.splice(0, this.#chatHistory.length - 12);
      this.addAssistantLine(reply);
      this.#status = 'idle';
      return { kind: intent === 'question' ? 'question' : 'chat', text: reply };
    }
    // A plain task inherits any staged `/skill` invocations (then clears them).
    const staged = [...this.#invokedSkills];
    this.#invokedSkills = [];
    return { kind: 'task', text: trimmed, ...(staged.length > 0 ? { data: { skills: staged } } : {}) };
  }

  /** Why `/skill <name>` cannot be honored here, or null when it can. Unknown to the loaded list, or disabled for this workspace. */
  #skillProblem(name: string): string | null {
    if (this.#skills.length > 0 && !this.#skills.some((entry) => entry.name === name)) {
      return `Unknown skill "${name}" — no skill with that name is available here. Run /skills to see names. It was not invoked.`;
    }
    if (this.#disabledSkills.has(name)) {
      return `Skill "${name}" is disabled for this workspace (.daedalus/skills.json). Re-enable it with \`daedalus skills enable ${name}\` to invoke it. It was not invoked.`;
    }
    return null;
  }

  /** Recent casual-chat history (oldest first), for hosts and tests. */
  get chatHistory(): Message[] {
    return [...this.#chatHistory];
  }

  /**
   * The session's turns rendered as bounded prior-context for a task, so a
   * follow-up task in this CLI session starts with the same memory the
   * chat replies already see. Undefined while the session is fresh.
   */
  priorContext(): string | undefined {
    const lines = this.#chatHistory.slice(-12).map((message) => {
      const raw = typeof message.content === 'string' ? message.content : '';
      const text = raw.replace(/\s*\n\s*/g, ' ').slice(0, 1_200);
      return `${message.role === 'user' ? 'User' : 'Daedalus'}: ${text}`;
    });
    if (lines.length === 0) return undefined;
    return [
      "Earlier in this conversation (most recent last) — the user's follow-ups refer to this; continue from it instead of starting cold:",
      ...lines,
    ].join('\n');
  }

  /** Record a finished task as one exchange so later tasks/chat see it. */
  recordTaskExchange(goal: string, summary: string): void {
    this.#chatHistory.push(
      { role: 'user', content: goal },
      { role: 'assistant', content: summary },
    );
    if (this.#chatHistory.length > 12) this.#chatHistory.splice(0, this.#chatHistory.length - 12);
  }

  async #conversationalReply(input: string): Promise<string> {
    if (!this.#callbacks.chatReply) return conversationalFallbackReply();
    try {
      const reply = await this.#callbacks.chatReply({ input, history: [...this.#chatHistory] });
      return reply.trim() ? reply : conversationalFallbackReply();
    } catch {
      return 'Maaf, saya gagal menjawab barusan (provider error). Coba lagi ya — atau langsung jelaskan tugas coding-nya kalau ada.';
    }
  }

  async #questionReply(input: string): Promise<string> {
    if (!this.#callbacks.questionReply) return questionFallbackReply();
    try {
      const reply = await this.#callbacks.questionReply({ input, history: [...this.#chatHistory] });
      return reply.trim() ? reply : questionFallbackReply();
    } catch {
      return 'Maaf, saya gagal menjawab pertanyaan itu barusan (provider error). Coba tanya lagi ya.';
    }
  }

  async runTask(goal: string): Promise<string> {
    if (!this.#callbacks.runTask) return 'No task runner is attached to this session yet.';
    this.#status = 'running';
    try {
      const text = await this.#callbacks.runTask(goal);
      this.#status = 'idle';
      return text;
    } catch (error) {
      this.#status = 'failed';
      throw error;
    }
  }

  #slashContext() {
    return {
      getMode: () => this.mode,
      setMode: (mode: AgentMode) => this.setMode(mode),
      cycleMode: () => this.cycleMode(),
      getAutoApprove: () => this.autoApprove,
      setAutoApprove: (value: boolean) => this.setAutoApprove(value),
      listModels: async () => {
        if (this.providerRegistry) return this.providerRegistry.listModels();
        return this.#model ? [{ providerId: this.#providerId ?? 'default', model: this.#model }] : [];
      },
      listProviders: async (): Promise<ProviderConfigPublic[]> => this.providerRegistry?.list() ?? [],
      getCurrentModel: () => ({ providerId: this.#providerId, model: this.#model }),
      setModel: (selection: string) => this.setModelSelection(selection),
      testProvider: async (id?: string) => {
        if (!this.providerRegistry) return { text: 'Provider testing is unavailable until a provider registry is attached.' };
        const providerId = id ?? this.#providerId;
        if (!providerId) return { text: 'Usage: /providers test <id>' };
        const result = await this.providerRegistry.testConnection(providerId);
        return { text: result.message, action: 'providers', data: result };
      },
      getSettings: async () => ({
        mode: this.mode,
        autoApprove: this.autoApprove,
        thinking: this.#thinking,
        providerId: this.#providerId,
        model: this.#model,
        workspace: this.workspaceRoot,
        providers: this.providerRegistry?.list() ?? [],
      }),
      setSetting: async (key: string, value: string) => {
        if (key === 'mode') {
          const mode = normalizeModeName(value);
          return mode ? this.setMode(mode) : { text: `Unknown mode: ${value}` };
        }
        if (key === 'model') return this.setModelSelection(value);
        if (key === 'provider') {
          this.#providerId = value;
          return { text: `Provider set to ${value}.`, action: 'settings' };
        }
        if (key === 'auto-approve') return this.setAutoApprove(value === 'on' || value === 'true');
        if (key === 'thinking') {
          if (!['on', 'off', 'true', 'false'].includes(value.trim().toLowerCase())) return { text: 'Usage: /settings thinking on|off' };
          return this.setThinking(value === 'on' || value === 'true');
        }
        return { text: `Unknown setting: ${key}` };
      },
      getPlan: async () => this.#plan,
      getWorkspace: async () => `${this.workspaceRoot}\nMode: ${this.mode}\nAttachments: ${this.#attachments.length}`,
      listFiles: async () => this.#listFiles(),
      getDiff: async () => this.#callbacks.diff ? this.#callbacks.diff() : 'No diff yet. File changes appear in the task timeline and final report.',
      validate: async () => this.#callbacks.validate ? this.#callbacks.validate() : 'Validation runs automatically before a task is marked complete.',
      rewind: async () => this.#callbacks.rewind ? this.#callbacks.rewind() : { text: 'Rewind is unavailable until a task runner is attached.', action: 'rewind' },
      upload: async (args: string[]) => this.#attach(args, 'file'),
      image: async (args: string[]) => this.#attach(args, 'image'),
      newTask: async () => {
        if (this.#callbacks.newTask) return this.#callbacks.newTask();
        this.#plan = '(no active plan yet — run a task or use /plan after one starts)';
        this.#status = 'idle';
        this.#modifiedFiles.clear();
        this.#transcript = [];
        return { text: 'New task session ready. Type a goal or a slash command.', action: 'new' };
      },
      clear: async () => {
        this.#attachments = [];
        this.#status = 'idle';
        this.#transcript = [];
        this.closeCommandPalette();
        return { text: 'Conversation view cleared. Workspace files were not changed.', action: 'clear' };
      },
      status: async () => this.statusBar(),
      getMcpStatus: async () => this.#mcps.length
        ? this.#mcps.map((entry) => `${entry.name}: ${entry.detail}`).join('\n')
        : 'No MCP servers configured. Add servers to .daedalus/mcp.json in the workspace.',
      listSkills: async () => this.#skills.length
        ? this.#skills.map((entry) => `${entry.name}: ${entry.detail}${this.#disabledSkills.has(entry.name) ? ' [disabled for this workspace]' : ''}`).join('\n')
        : 'No skills found. Add skill folders with a SKILL.md under .daedalus/skills/ in the workspace.',
      invokeSkill: async (name: string) => {
        // `/skill <name>` with no task text: stage it; the next task in
        // this session force-loads its body into its prompt.
        const problem = this.#skillProblem(name);
        if (problem) return { text: problem, action: 'skill' };
        if (!this.#invokedSkills.includes(name)) this.#invokedSkills.push(name);
        return {
          text: `Skill "${name}" will be force-loaded into the next task. Type the task, or /skill <name> <task> to run one directly.`,
          action: 'skill',
        };
      },
      listAgents: async () => {
        if (this.#callbacks.listAgents) return this.#callbacks.listAgents();
        return this.#agents.length
          ? this.#agents.map((entry) => `${entry.name}: ${entry.detail}`).join('\n')
          : 'No subagents defined. Add .md definitions under .daedalus/agents/ in the workspace.';
      },
      review: async () => this.#callbacks.review ? this.#callbacks.review() : { text: 'Review is unavailable until a task runner is attached.', action: 'review' },
      getLspStatus: async () => this.#lsps.length
        ? this.#lsps.map((entry) => `${entry.name}: ${entry.detail}`).join('\n')
        : 'No language servers configured. Add servers to .daedalus/lsp.json in the workspace.',
      cancel: async () => this.#callbacks.cancel ? this.#callbacks.cancel() : { text: 'No running task to cancel.', action: 'cancel' },
      exit: async () => ({ text: 'Goodbye.', action: 'exit' }),
    };
  }

  async #listFiles(): Promise<string> {
    const entries = await readdir(this.workspaceRoot, { withFileTypes: true }).catch(() => []);
    if (!entries.length) return '(workspace is empty)';
    return entries
      .filter((entry) => !['node_modules', '.git'].includes(entry.name))
      .slice(0, 100)
      .map((entry) => `${entry.name}${entry.isDirectory() ? '/' : ''}`)
      .join('\n');
  }

  async #attach(args: string[], kind: 'file' | 'image'): Promise<SlashCommandResult> {
    const target = args.join(' ').trim();
    if (!target) return { text: `Usage: /${kind === 'image' ? 'image' : 'upload'} <path>`, action: kind };
    const absolute = join(this.workspaceRoot, target);
    const info = await stat(absolute).catch(() => undefined);
    if (!info) return { text: `File not found inside workspace: ${target}`, action: kind };
    if (!info.isFile()) return { text: `Not a file: ${target}`, action: kind };
    const attachment: Attachment = {
      id: randomUUID(),
      workspacePath: relative(this.workspaceRoot, absolute) || basename(absolute),
      name: basename(absolute),
      kind,
      size: info.size,
      createdAt: new Date().toISOString(),
      path: absolute,
    };
    this.#attachments.push(attachment);
    return {
      text: `Attached ${kind} ${attachment.workspacePath} (${attachment.size} bytes).${kind === 'image' ? ' It will only be sent to the model when the selected model supports vision.' : ''}`,
      action: kind,
      data: attachment,
    };
  }
}

function fit(text: string, width: number): string {
  return truncateVisible(collapseSpaces(text), width);
}

/** Collapse newlines/whitespace runs the way single-line frame text needs. */
function collapseSpaces(text: string): string {
  return text.replace(/[\r\n]+/g, ' ').replace(/\s+/g, ' ').trimEnd();
}

const ANSI_PATTERN = /\x1b\[[0-9;:?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[@-Z\\-_]/g;

/**
 * Remove ANSI escape sequences and terminal control characters from text that
 * is about to be composed into a frame line. A stray `\r` or a half-sliced
 * escape sequence inside a repainted frame overwrites painted text and breaks
 * every following frame, so frame content is always rendered as plain text;
 * coloring is applied to whole composed lines afterwards by the caller.
 */
export function sanitizeTerminalText(text: string): string {
  return text
    .replace(ANSI_PATTERN, '')
    .replace(/\t/g, '  ')
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, '');
}

/** Terminal cell width of one code point (combining = 0, East Asian wide/fullwidth and emoji = 2). */
function charCellWidth(codePoint: number): number {
  if (codePoint === 0) return 0;
  if (codePoint < 0x20 || (codePoint >= 0x7f && codePoint < 0xa0)) return 0;
  if (codePoint >= 0x0300 && codePoint <= 0x036f) return 0; // combining diacriticals
  if (
    (codePoint >= 0x1100 && codePoint <= 0x115f) // Hangul Jamo
    || (codePoint >= 0x2e80 && codePoint <= 0xa4cf) // CJK radicals, kana, han
    || (codePoint >= 0xac00 && codePoint <= 0xd7a3) // Hangul syllables
    || (codePoint >= 0xf900 && codePoint <= 0xfaff) // CJK compatibility ideographs
    || (codePoint >= 0xfe30 && codePoint <= 0xfe6f) // CJK compatibility forms
    || (codePoint >= 0xff00 && codePoint <= 0xff60) // fullwidth forms
    || (codePoint >= 0xffe0 && codePoint <= 0xffe6) // fullwidth signs
    || (codePoint >= 0x1f300 && codePoint <= 0x1faff) // emoji and pictographs
    || (codePoint >= 0x20000 && codePoint <= 0x2fffd) // CJK extension planes
    || (codePoint >= 0x30000 && codePoint <= 0x3fffd)
  ) return 2;
  return 1;
}

/** Visible terminal-cell width of `text`, ignoring ANSI escapes and control bytes. */
export function visibleWidth(text: string): number {
  let width = 0;
  for (const ch of sanitizeTerminalText(text)) width += charCellWidth(ch.codePointAt(0) ?? 0);
  return width;
}

/**
 * Truncate `text` to at most `width` terminal cells (ellipsis when cut).
 * Escape sequences are stripped rather than sliced, so the result can never
 * contain a partial escape or exceed the cell budget on a real terminal.
 */
export function truncateVisible(text: string, width: number): string {
  if (width <= 0) return '';
  const clean = sanitizeTerminalText(text.replace(/[\r\n]+/g, ' '));
  if (visibleWidth(clean) <= width) return clean;
  if (width === 1) return '…';
  const budget = width - 1;
  let used = 0;
  let out = '';
  for (const ch of clean) {
    const w = charCellWidth(ch.codePointAt(0) ?? 0);
    if (used + w > budget) break;
    used += w;
    out += ch;
  }
  return `${out.trimEnd()}…`;
}

/** Truncate to `width` cells, then pad with spaces to exactly `width` visible cells. */
export function padVisibleEnd(text: string, width: number): string {
  if (width <= 0) return '';
  const truncated = truncateVisible(text, width);
  const gap = width - visibleWidth(truncated);
  return gap > 0 ? `${truncated}${' '.repeat(gap)}` : truncated;
}

/** Slice `text` by visible-cell offsets [start, end). Wide glyphs straddling a cut become nothing. */
export function sliceVisible(text: string, start: number, end?: number): string {
  const clean = sanitizeTerminalText(text);
  const limit = end ?? Number.POSITIVE_INFINITY;
  let col = 0;
  let out = '';
  for (const ch of clean) {
    const w = charCellWidth(ch.codePointAt(0) ?? 0);
    if (col >= start && col + w <= limit) out += ch;
    col += w;
    if (col >= limit) break;
  }
  return out;
}

function titleCase(value: string): string {
  return value.length === 0 ? value : `${value[0]!.toUpperCase()}${value.slice(1)}`;
}

function commandTitle(name: string): string {
  const titles: Record<string, string> = {
    help: 'Help',
    mode: 'Switch Mode',
    models: 'Switch Model',
    providers: 'Providers',
    settings: 'Settings',
    'auto-approve': 'Toggle Auto-Approve',
    plan: 'Plan',
    workspace: 'Workspace',
    files: 'Files',
    upload: 'Upload File',
    image: 'Attach Image',
    diff: 'View Diff',
    validate: 'Validate',
    rewind: 'Rewind Task Changes',
    new: 'New Session',
    clear: 'Clear Conversation',
    status: 'Status',
    cancel: 'Cancel Task',
    mcp: 'MCP Servers',
    skills: 'Skills',
    agents: 'Subagents',
    review: 'Review Diff',
    lsp: 'Language Servers',
    exit: 'Quit',
  };
  return titles[name] ?? titleCase(name.replace(/-/g, ' '));
}

function wrapText(text: string, width: number): string[] {
  const clean = sanitizeTerminalText(text);
  if (visibleWidth(clean) === 0) return [''];
  const lines: string[] = [];
  let rest = clean;
  while (visibleWidth(rest) > width) {
    const chars = [...rest];
    // Walk to the last cell that still fits, remembering the last space seen.
    let used = 0;
    let fitCount = 0;
    let lastSpaceIndex = -1;
    for (const ch of chars) {
      const w = charCellWidth(ch.codePointAt(0) ?? 0);
      if (used + w > width) break;
      used += w;
      fitCount++;
      if (ch === ' ') lastSpaceIndex = fitCount - 1;
    }
    if (fitCount === 0) break; // a single glyph wider than the budget
    if (lastSpaceIndex >= Math.floor(width * 0.45)) {
      lines.push(chars.slice(0, lastSpaceIndex).join('').trimEnd());
      rest = chars.slice(lastSpaceIndex + 1).join('').trimStart();
    } else {
      lines.push(chars.slice(0, fitCount).join('').trimEnd());
      rest = chars.slice(fitCount).join('').trimStart();
    }
  }
  if (rest) lines.push(rest);
  return lines.length ? lines : [''];
}

function contextSummary(plan: string): string {
  if (!plan || plan.startsWith('(no active plan')) return 'no active plan';
  const steps = plan.split(/\r?\n/).filter((line) => line.trim().length > 0).length;
  return `${steps} plan step${steps === 1 ? '' : 's'}`;
}
