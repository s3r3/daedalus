#!/usr/bin/env -S node --experimental-strip-types
import { Command } from "commander";
import { createInterface, emitKeypressEvents } from "node:readline";
import { join } from "node:path";
import {
  McpManager,
  ProviderRegistryStore,
  TaskRunner,
  TaskStore,
  applyTaskWorktree,
  createProviderForConfig,
  exitCodeFor,
  loadAgents,
  loadLspConfig,
  loadMcpConfig,
  loadProjectRules,
  loadSettings,
  loadSkills,
  removeTaskWorktree,
  resolveDaedalusHome,
  createProviderFromSettings,
  reviewDiff,
  seedProviderFromSettings,
  unstagedDiff,
  workspaceAgentsDir,
  workspaceSkillsDir,
  VERSION,
  bold,
  dim,
  fg,
  palette,
  type AgentMode,
  type Event,
  type ExtensionStatus,
  type Message,
  type ModelStrategy,
  type PermissionKey,
} from "@daedalus/core";
import {
  ensureDaemon,
  fetchDaemonWorkspace,
  getDaemonStatus,
  openBrowser,
  runBareLauncher,
  runLauncherMenu,
  startForegroundServer,
  stopDaemon,
} from "./launcher.ts";
import { InteractiveSession } from "./interactive.ts";
import { TrayManager } from "./tray.ts";
import { formatSkillsListing, installBundledSkills, listSkills } from "./skills-bundled.ts";

const SPINNER_FRAMES = "⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏";
const SPINNER_INTERVAL_MS = 50;

/**
 * Generate a cycling gradient for the spinner (Crush-inspired)
 * Simulates Crush's working gradient animation in CLI.
 */
function cyclingGradient(char: string, frame: number, palette: typeof import("@daedalus/core").palette): string {
  if (!supportsColor()) return char;
  const [r1, g1, b1] = rgb(palette.workingFrom);
  const [r2, g2, b2] = rgb(palette.workingTo);
  const t = (frame % 20) / 20; // 20-frame cycle
  const r = Math.round(r1 + (r2 - r1) * t);
  const g = Math.round(g1 + (g2 - g1) * t);
  const b = Math.round(b1 + (b2 - b1) * t);
  return `\x1b[38;2;${r};${g};${b}m${char}\x1b[0m`;
}

function supportsColor(): boolean {
  if (process.env.NO_COLOR !== undefined) return false;
  if (process.env.FORCE_COLOR !== undefined) return true;
  return Boolean((process.stdout as { isTTY?: boolean }).isTTY);
}

function rgb(hex: string): [number, number, number] {
  const h = hex.replace(/^#/, '');
  const n = parseInt(h, 16);
  return [(n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff];
}

/** Wrap `s` in a hue foreground; falls back to plain text when color is disabled. */
const paint = (hex: string, s: string): string => {
  const f = fg(hex);
  return f.length === 0 ? s : `${f}${s}\x1b[0m`;
};

/**
 * SIGINT handler for a running task: cancel it, then exit with the conventional
 * 128 + SIGINT(2) code so scripts can distinguish a user abort from a failure.
 * Extracted so it can be asserted without spawning a real signal.
 */
export function makeSigintHandler(
  runner: { cancel: (taskId: string) => void },
  getTaskId: () => string | undefined,
  shouldReport: () => boolean,
): () => void {
  return () => {
    const taskId = getTaskId();
    if (taskId) {
      runner.cancel(taskId);
      if (shouldReport()) process.stderr.write(`\n${paint(palette.error, "Task cancelled by user (SIGINT).")}\n`);
    }
    process.exit(130);
  };
}

/** Parse a positive-integer CLI flag. Returns undefined when unset. */
export function parsePositiveInt(value: string | undefined, flag: string): number | undefined {
  if (value === undefined) return undefined;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${flag} expects a positive integer number of milliseconds, received "${value}"`);
  }
  return parsed;
}

/** Map a raw approval answer to a broker decision. Fails closed on anything unrecognised. */
export function parseApproval(answer: string): { decision: "grant" | "deny"; remember: boolean } {
  const a = answer.trim().toLowerCase();
  if (a.startsWith("r")) return { decision: "grant", remember: true };
  if (a.startsWith("a")) return { decision: "grant", remember: false };
  return { decision: "deny", remember: false };
}

const AGENT_MODES: AgentMode[] = ["ask", "manual", "auto", "plan", "orchestrator"];

export function parseMode(value: string | undefined): AgentMode | undefined {
  if (value === undefined) return undefined;
  const lowered = value.trim().toLowerCase();
  const normalized = (lowered === "code" ? "auto" : lowered) as AgentMode;
  if (!AGENT_MODES.includes(normalized)) {
    throw new Error(`--mode expects one of ${AGENT_MODES.join(", ")}, code, received "${value}"`);
  }
  return normalized;
}

/** Parse the --isolation flag; only git-worktree isolation exists. */
export function parseIsolation(value: string | undefined): "worktree" | undefined {
  if (value === undefined) return undefined;
  if (value.trim().toLowerCase() === "worktree") return "worktree";
  throw new Error(`--isolation expects "worktree", received "${value}"`);
}

export function parseModelList(value: string | undefined): string[] | undefined {
  if (value === undefined) return undefined;
  const models = [...new Set(value.split(",").map((model) => model.trim()).filter(Boolean))];
  if (models.length === 0) throw new Error("--models expects a comma-separated list of model ids");
  return models;
}

export function parseModelStrategy(value: string | undefined): ModelStrategy | undefined {
  if (value === undefined) return undefined;
  const normalized = value.trim().toLowerCase() as ModelStrategy;
  if (normalized !== "failover" && normalized !== "round-robin") {
    throw new Error(`--model-strategy expects failover or round-robin, received "${value}"`);
  }
  return normalized;
}

function askLine(rl: ReturnType<typeof createInterface>, prompt: string): Promise<string | null> {
  return new Promise((resolve) => {
    let settled = false;
    const done = (answer: string | null): void => {
      if (settled) return;
      settled = true;
      resolve(answer);
    };
    rl.once("close", () => done(null));
    rl.question(prompt, (answer) => done(answer));
  });
}

export function formatEvent(event: Omit<Event, "seq" | "ts">): string {
  switch (event.type) {
    case "TASK_STARTED": {
      const p = event.payload as { spec?: { goal?: string; title?: string } };
      return `${paint(palette.primary, "●")} ${bold("Task:")} ${p.spec?.title ? `${p.spec.title} — ` : ""}${p.spec?.goal ?? ""}\n`;
    }
    case "PLAN_CREATED": {
      const p = event.payload as { plan?: { steps?: Array<{ intent: string }> } };
      const steps = p.plan?.steps ?? [];
      return `${paint(palette.secondary, "✦")} Plan (${steps.length} steps):\n${steps.map((s, i) => `  ${i + 1}. ${s.intent}`).join("\n")}\n`;
    }
    case "THOUGHT": {
      const p = event.payload as { text?: string; source?: string };
      return p.text ? `${dim(`thinking · ${p.text}`)}\n` : "";
    }
    case "LOOP_WARNING": {
      const p = event.payload as { tool?: string; repeats?: number; suppressed?: boolean };
      return `${paint(palette.warning, "↻")} Loop warning: ${p.tool ?? "tool"} repeated ${p.repeats ?? 0}×${p.suppressed ? " — further repeats suppressed" : ""}\n`;
    }
    case "HOOK_EXECUTED": {
      const p = event.payload as { phase?: string; tool?: string; command?: string; outcome?: string; reason?: string };
      if (p.outcome === "blocked") return `${paint(palette.warning, "⚿")} Hook blocked ${p.tool ?? "tool"}: ${p.reason ?? "blocked"}\n`;
      if (p.outcome === "timeout" || p.outcome === "error") return `${paint(palette.warning, "⚿")} Hook ${p.outcome} (${p.phase ?? ""} ${p.tool ?? ""}): ${p.command ?? ""}\n`;
      return "";
    }
    case "TOOL_CALL_STARTED": {
      const p = event.payload as { call?: { tool: string; args: unknown } };
      return `  ${paint(palette.warning, "⠋")} ${dim(p.call?.tool ?? "")} ${JSON.stringify(p.call?.args ?? {})}\n`;
    }
    case "TOOL_CALL_FINISHED": {
      const p = event.payload as { call?: { tool: string }; result?: { status: string; output: string } };
      const ok = p.result?.status === "ok";
      const icon = ok ? paint(palette.success, "✔") : paint(palette.error, "✖");
      const snippet = (p.result?.output ?? "").trim().slice(0, 80);
      return `  ${icon} ${dim(`${p.call?.tool} -> ${snippet}`)}\n`;
    }
    case "VALIDATION_STARTED": {
      return `${paint(palette.info, "◆")} Running validation checks...\n`;
    }
    case "VALIDATION_PASSED": {
      return `${paint(palette.success, "✔")} Validation passed!\n`;
    }
    case "VALIDATION_FAILED": {
      const p = event.payload as { result?: { checks?: Array<{ name: string; status: string }> } };
      const fails = p.result?.checks?.filter((c) => c.status !== "pass") ?? [];
      return `${paint(palette.error, "✖")} Validation failed (${fails.map((f) => f.name).join(", ")})\n`;
    }
    case "RECOVERY_STARTED": {
      const p = event.payload as { reason?: string; strategy?: string; attempt?: number };
      return `${paint(palette.warning, "↻")} Recovery: ${p.strategy} (attempt ${p.attempt}) — ${p.reason}\n`;
    }
    case "APPROVAL_REQUESTED": {
      const p = event.payload as { key?: { tool: string; action: string; path?: string } };
      return `${paint(palette.warning, "▲")} Approval requested: ${p.key?.tool} [${p.key?.action}] ${p.key?.path ?? ""}\n`;
    }
    case "MODE_CHANGED": {
      const p = event.payload as { from?: string; to?: string; replan_required?: boolean };
      return `${paint(palette.secondary, "◆")} Mode changed: ${p.from ?? "?"} → ${p.to ?? "?"}${p.replan_required ? " (re-plan at turn boundary)" : ""}\n`;
    }
    case "PROVIDER_CHANGED": {
      const p = event.payload as { providerId?: string; provider_id?: string; model?: string };
      return `${paint(palette.info, "◆")} Provider/model: ${p.providerId ?? p.provider_id ?? "default"}${p.model ? `/${p.model}` : ""}\n`;
    }
    case "ATTACHMENT_ADDED": {
      const p = event.payload as { attachment?: { name?: string; kind?: string }; name?: string; kind?: string };
      const name = p.attachment?.name ?? p.name ?? "attachment";
      const kind = p.attachment?.kind ?? p.kind ?? "file";
      return `${paint(palette.info, "▣")} Attached ${kind}: ${name}\n`;
    }
    case "CHILD_TASK_STARTED": {
      const p = event.payload as { child?: { goal?: string } };
      return `${paint(palette.secondary, "▸")} Child task started: ${p.child?.goal ?? ""}\n`;
    }
    case "CHILD_TASK_FINISHED": {
      const p = event.payload as { child?: { goal?: string; status?: string; result_summary?: string } };
      return `${paint(palette.secondary, "▸")} Child task ${p.child?.status ?? "finished"}: ${p.child?.result_summary ?? p.child?.goal ?? ""}\n`;
    }
    case "SLASH_COMMAND_EXECUTED": {
      const p = event.payload as { command?: string; text?: string };
      return p.text ? `${p.text}\n` : `${paint(palette.info, "/")} ${p.command ?? "command"}\n`;
    }
    case "FILE_CHANGED": {
      const p = event.payload as { path?: string; operation?: string; added?: number; removed?: number; patch?: string };
      const header = `${paint(palette.success, "±")} ${p.operation ?? "changed"} ${p.path ?? ""} (+${p.added ?? 0}/-${p.removed ?? 0})\n`;
      return p.patch ? `${header}${dim(p.patch)}\n` : header;
    }
    case "COMMAND_STARTED": {
      const p = event.payload as { command?: string };
      return `  ${paint(palette.info, "$")} ${p.command ?? ""}\n`;
    }
    case "COMMAND_OUTPUT": {
      const p = event.payload as { chunk?: string };
      return p.chunk ?? "";
    }
    case "COMMAND_FINISHED": {
      const p = event.payload as { status?: string; exit_code?: number | null };
      return `  ${p.status === "ok" ? paint(palette.success, "✔") : paint(palette.error, "✖")} command ${p.status ?? ""} (exit ${p.exit_code ?? "?"})\n`;
    }
    case "TASK_COMPLETED": {
      const p = event.payload as { outcome?: string; reason?: string };
      const icon = p.outcome === "success"
        ? paint(palette.success, "✔")
        : paint(palette.error, "✖");
      return `\n${icon} ${bold(`Task ${p.outcome}: ${p.reason}`)}\n`;
    }
    default:
      return "";
  }
}

function colorizeScreen(screen: string): string {
  if (!supportsColor()) return screen;
  return screen.split("\n").map((line) => {
    if (line.includes("› /")) return `\x1b[48;2;107;80;255m\x1b[97m${line}\x1b[0m`;
    if (line.includes("DAEDALUS")) return paint(palette.secondary, line);
    if (line.startsWith("> ")) return paint(palette.success, line);
    if (line.includes("Modified Files") || line.includes("LSPs") || line.includes("MCPs") || line.includes("Skills")) return dim(line);
    if (line.includes("✔") || line.includes("Validation passed")) return paint(palette.success, line);
    if (line.includes("✖") || line.includes("failed")) return paint(palette.error, line);
    return line;
  }).join("\n");
}

type FullscreenRunner = {
  run: (input: Record<string, unknown>) => Promise<{ outcome: string; events: unknown[]; state: { steps: Array<{ intent: string; status: string }> }; report: { metrics: { files_changed?: number } } }>;
  cancel: (taskId: string) => void;
  approvals: { decide: (key: PermissionKey, decision: "grant" | "deny", remember: boolean) => void };
  extensionStatus?: ExtensionStatus;
};

/** Push the runner's live MCP/LSP/skills state into the sidebar. */
export function applyExtensionStatus(session: InteractiveSession, status: ExtensionStatus): void {
  if (status.mcp.length > 0) {
    session.setMcps(status.mcp.map((server) => ({
      name: server.name,
      detail: server.connected ? `connected · ${server.toolCount} tools` : `offline${server.error ? ` · ${server.error}` : ""}`,
    })));
  }
  if (status.lsp.length > 0) {
    session.setLsps(status.lsp.map((server) => ({
      name: server.name,
      detail: server.error ? `error · ${server.error}` : server.running ? `${server.extensions.join(" ")} · running` : `${server.extensions.join(" ")} · configured`,
    })));
  }
  if (status.skills.length > 0) {
    session.setSkills(status.skills.map((skill) => ({ name: skill.name, detail: skill.description || "skill" })));
  }
  if (status.agents.length > 0) {
    session.setAgents(status.agents.map((agent) => ({ name: agent.name, detail: agent.description || "subagent" })));
  }
}

async function runFullscreenChat(options: {
  session: InteractiveSession;
  runner: FullscreenRunner;
  setCurrentTaskId?: (taskId: string | undefined) => void;
}): Promise<void> {
  const { session, runner } = options;
  const stdin = process.stdin as NodeJS.ReadStream;
  const stdout = process.stdout as NodeJS.WriteStream;
  let input = "";
  let cursor = 0;
  let running = false;
  let closed = false;
  let currentTaskId: string | undefined;
  let pendingApproval: PermissionKey | undefined;

  let forceFullClear = true;
  let lastColumns = 0;
  let lastRows = 0;

  const draw = (): void => {
    if (closed) return;
    const columns = stdout.columns || 132;
    const rows = stdout.rows || 36;
    const screen = session.renderScreen({ input, cursor, columns, rows });
    // Deterministic full-frame repaint: cursor HOME (never counted line-ups),
    // every composed line is cell-truncated by renderScreen so nothing can
    // wrap or scroll the alternate screen, each line erases its own tail
    // (\x1b[K), and \x1b[J clears anything below the frame. A size change (or
    // the first frame) starts from a fully cleared screen so no ghost of a
    // previous geometry can survive.
    const sizeChanged = columns !== lastColumns || rows !== lastRows;
    lastColumns = columns;
    lastRows = rows;
    const painted = colorizeScreen(screen).split("\n").map((line) => `${line}\x1b[K`).join("\r\n");
    stdout.write(`${forceFullClear || sizeChanged ? "\x1b[2J" : ""}\x1b[H${painted}\x1b[J`);
    forceFullClear = false;
  };

  const onResize = (): void => {
    forceFullClear = true;
    draw();
  };

  const cleanup = (): void => {
    if (closed) return;
    closed = true;
    stdin.off("keypress", onKeypress);
    stdout.off("resize", onResize);
    stdin.setRawMode?.(false);
    stdin.pause();
    stdout.write("\x1b[?25h\x1b[?1049l");
  };

  const submit = async (): Promise<void> => {
    const line = input;
    input = "";
    cursor = 0;
    session.closeCommandPalette();
    if (!line.trim()) { draw(); return; }
    if (running) {
      session.addTranscript("Task is running. Press esc to cancel it, or wait for it to finish.");
      draw();
      return;
    }
    const handled = await session.handleInput(line);
    if (handled.kind === "empty") { draw(); return; }
    if (handled.kind === "slash") {
      if (handled.action === "exit") { cleanup(); return; }
      draw();
      return;
    }

    running = true;
    session.setStatus("running");
    draw();
    try {
      const result = await runner.run({
        goal: handled.text,
        mode: session.mode,
        autoApprove: session.autoApprove,
        thinking: session.thinking,
        attachments: session.attachments,
        ...(session.providerId ? { providerId: session.providerId } : {}),
        ...(session.model ? { model: session.model } : {}),
        ...(session.models.length > 1 ? { models: session.models, modelStrategy: session.modelStrategy } : {}),
        onEvent: (event: Event) => {
          currentTaskId = event.task_id;
          options.setCurrentTaskId?.(event.task_id);
          session.observeEvent(event);
          if (event.type === "PLAN_CREATED") {
            const plan = (event.payload as { plan?: { steps?: Array<{ intent: string; status?: string }> } }).plan;
            if (plan?.steps) session.setPlan(plan.steps.map((step, index) => `${index + 1}. [${step.status ?? "pending"}] ${step.intent}`).join("\n"));
          }
          if (event.type === "APPROVAL_REQUESTED") {
            const key = (event.payload as { key?: PermissionKey }).key;
            if (key) {
              pendingApproval = key;
              session.addTranscript(`Approval requested: ${key.tool} [${key.action}] ${key.path ?? ""} — press a approve · d deny · r remember`);
            }
            draw();
            return;
          }
          const formatted = formatEvent(event).trimEnd();
          if (formatted && event.type !== "THOUGHT") session.addTranscript(formatted);
          draw();
        },
      });
      session.setStatus(result.outcome);
      session.setPlan(result.state.steps.map((step, index) => `${index + 1}. [${step.status}] ${step.intent}`).join("\n"));
      session.addTranscript(`Outcome: ${result.outcome} · events ${result.events.length} · files changed ${result.report.metrics.files_changed ?? 0}`);
    } catch (error) {
      session.setStatus("failed");
      session.addTranscript(`Error: ${String(error)}`);
    } finally {
      running = false;
      pendingApproval = undefined;
      if (runner.extensionStatus) applyExtensionStatus(session, runner.extensionStatus);
      draw();
    }
  };

  const onKeypress = (str: string, key: { name?: string; sequence?: string; ctrl?: boolean; shift?: boolean; meta?: boolean } = {}): void => {
    if (closed) return;
    const name = key.name ?? "";

    if (pendingApproval) {
      const answer = (str || name).trim().toLowerCase();
      if (["a", "d", "r"].includes(answer)) {
        const parsed = parseApproval(answer);
        runner.approvals.decide(pendingApproval, parsed.decision, parsed.remember);
        session.addTranscript(`Approval ${parsed.decision === "grant" ? "granted" : "denied"}${parsed.remember ? " (remembered)" : ""}: ${pendingApproval.tool}`);
        pendingApproval = undefined;
      }
      draw();
      return;
    }

    if (key.ctrl && name === "c") {
      if (running && currentTaskId) {
        runner.cancel(currentTaskId);
        session.addTranscript(`Cancellation requested for task ${currentTaskId}.`);
        draw();
        return;
      }
      cleanup();
      return;
    }
    if (key.ctrl && name === "b") { session.toggleSidebar(); draw(); return; }
    if (session.isShiftTab(str, key)) { session.cycleMode(); draw(); return; }
    if (key.ctrl && name === "p") {
      if (!input.startsWith("/")) { input = "/"; cursor = 1; }
      session.openCommandPalette(input.slice(1));
      draw();
      return;
    }
    if (key.ctrl && name === "m") {
      input = "/models";
      cursor = input.length;
      session.closeCommandPalette();
      draw();
      return;
    }

    if (session.paletteOpen) {
      if (name === "escape") { session.closeCommandPalette(); draw(); return; }
      if (name === "up") { session.movePaletteSelection(-1); draw(); return; }
      if (name === "down" || (name === "tab" && !key.shift)) { session.movePaletteSelection(1); draw(); return; }
      if (name === "return" || name === "enter") {
        const typed = input.trim();
        const accepted = session.acceptPaletteSelection();
        if (!accepted) { void submit(); return; }
        const commandName = accepted.slice(1);
        const needsArgument = new Set(["mode", "auto-approve", "upload", "image"]);
        if (needsArgument.has(commandName) && !typed.includes(" ")) {
          input = `${accepted} `;
          cursor = input.length;
          draw();
          return;
        }
        if (!typed.includes(" ")) input = accepted;
        void submit();
        return;
      }
      if (name === "backspace") {
        if (cursor > 0) { input = `${input.slice(0, cursor - 1)}${input.slice(cursor)}`; cursor--; }
        if (input.startsWith("/") && !input.slice(1).includes(" ")) session.openCommandPalette(input.slice(1)); else session.closeCommandPalette();
        draw();
        return;
      }
      if (str && !key.ctrl && !key.meta && str >= " ") {
        input = `${input.slice(0, cursor)}${str}${input.slice(cursor)}`;
        cursor += str.length;
        if (input.startsWith("/") && !input.slice(1).includes(" ")) session.openCommandPalette(input.slice(1)); else session.closeCommandPalette();
        draw();
        return;
      }
    }

    if (name === "escape") {
      if (running && currentTaskId) {
        runner.cancel(currentTaskId);
        session.addTranscript(`Cancellation requested for task ${currentTaskId}.`);
      }
      draw();
      return;
    }
    if (name === "return" || name === "enter") {
      if (key.shift) {
        input = `${input.slice(0, cursor)}\n${input.slice(cursor)}`;
        cursor++;
        draw();
        return;
      }
      void submit();
      return;
    }
    if (name === "backspace") {
      if (cursor > 0) { input = `${input.slice(0, cursor - 1)}${input.slice(cursor)}`; cursor--; }
      draw();
      return;
    }
    if (name === "delete") {
      if (cursor < input.length) input = `${input.slice(0, cursor)}${input.slice(cursor + 1)}`;
      draw();
      return;
    }
    if (name === "left") { cursor = Math.max(0, cursor - 1); draw(); return; }
    if (name === "right") { cursor = Math.min(input.length, cursor + 1); draw(); return; }
    if (name === "home") { cursor = 0; draw(); return; }
    if (name === "end") { cursor = input.length; draw(); return; }
    if (str && !key.ctrl && !key.meta && str >= " ") {
      const wasEmpty = input.length === 0;
      input = `${input.slice(0, cursor)}${str}${input.slice(cursor)}`;
      cursor += str.length;
      if (wasEmpty && input === "/") session.openCommandPalette();
      else if (input.startsWith("/") && !input.slice(1).includes(" ")) session.openCommandPalette(input.slice(1));
      draw();
    }
  };

  stdin.setRawMode?.(true);
  emitKeypressEvents(stdin);
  stdin.resume();
  stdout.write("\x1b[?1049h\x1b[2J\x1b[?25l");
  stdin.on("keypress", onKeypress);
  stdout.on("resize", onResize);
  draw();
  await new Promise<void>((resolve) => {
    const timer = setInterval(() => { if (closed) { clearInterval(timer); resolve(); } }, 50);
  });
}

export async function runInteractiveChat(options: {
  cwd: string;
  mode?: AgentMode;
  yolo?: boolean;
  maxIterations?: number;
  thinking?: boolean;
}): Promise<void> {
  const workspaceRoot = options.cwd;
  const settings = loadSettings();
  const providerStore = new ProviderRegistryStore(resolveDaedalusHome(settings.daedalusHome, workspaceRoot));
  await providerStore.load(seedProviderFromSettings(settings));

  const session = new InteractiveSession({
    workspaceRoot,
    initialMode: options.mode ?? "auto",
    autoApprove: options.yolo === true,
    providerRegistry: providerStore.registry,
    providerId: settings.llm.model || settings.llm.models.length > 0 ? "nine-router" : undefined,
    model: settings.llm.model || settings.llm.models[0] || undefined,
    models: settings.llm.models,
    modelStrategy: settings.llm.modelStrategy,
    thinking: options.thinking ?? settings.session.thinking,
  });

  // Extension systems (MCP / LSP / skills) come from the same core loaders
  // the runner uses, so the sidebar shows real state: MCP servers are
  // actually connected here for display, and the runner reconnects its own
  // set per run from the same `.daedalus/` config files.
  const mcpConfig = await loadMcpConfig(workspaceRoot);
  const lspConfig = await loadLspConfig(workspaceRoot);
  const skillRegistry = await loadSkills([workspaceSkillsDir(workspaceRoot)]);
  const displayMcp = new McpManager(mcpConfig.servers);
  if (mcpConfig.servers.length > 0) await displayMcp.connectAll();
  session.setMcps(displayMcp.status().map((status) => ({
    name: status.name,
    detail: status.connected ? `connected · ${status.toolCount} tools` : `offline${status.error ? ` · ${status.error}` : ""}`,
  })));
  session.setLsps(lspConfig.servers.map((server) => ({
    name: server.name,
    detail: `${server.extensions.join(" ") || "no extensions"} · configured`,
  })));
  session.setSkills(skillRegistry.list().map((skill) => ({ name: skill.name, detail: skill.description || "skill" })));

  // File-defined subagents (.daedalus/agents/<name>.md) for /agents + sidebar.
  const agentRegistry = await loadAgents([workspaceAgentsDir(workspaceRoot)]);
  session.setAgents(agentRegistry.list().map((agent) => ({ name: agent.name, detail: agent.description || "subagent" })));

  // Project rules the core will inject into every run's system prompt.
  const projectRules = await loadProjectRules(workspaceRoot);
  session.setRulesFiles(projectRules.files);

  const runner = new TaskRunner({
    workspaceRoot,
    settings,
    providerRegistry: providerStore.registry,
    modeController: session.controller,
    approvalPolicy: options.yolo ? "auto" : "ask",
    maxIterations: options.maxIterations ?? 25,
    models: settings.llm.models,
    modelStrategy: settings.llm.modelStrategy,
    thinking: options.thinking ?? settings.session.thinking,
  });

  let currentTaskId: string | undefined;
  session.setCallbacks({
    cancel: async () => {
      if (!currentTaskId) return { text: "No running task to cancel.", action: "cancel" };
      runner.cancel(currentTaskId);
      return { text: `Cancellation requested for task ${currentTaskId}.`, action: "cancel" };
    },
    listAgents: async () => {
      const agents = (await loadAgents([workspaceAgentsDir(workspaceRoot)])).list();
      if (agents.length === 0) return "No subagents defined. Add .md files under .daedalus/agents/ in the workspace.";
      return agents
        .map((agent) => `${agent.name} — ${agent.description}${agent.mode ? ` · mode ${agent.mode}` : ""}${agent.model ? ` · model ${agent.model}` : ""}${agent.tools ? ` · tools: ${agent.tools.join(", ")}` : " · tools: all"}`)
        .join("\n");
    },
    review: async () => {
      const report = currentTaskId ? runner.store.loadReport<{ diff?: string }>(currentTaskId) : undefined;
      let taskDiff = report?.diff && report.diff.trim().length > 0 ? report.diff : "";
      let source: "task-diff" | "unstaged" = "task-diff";
      if (!taskDiff) {
        taskDiff = await unstagedDiff(workspaceRoot);
        source = "unstaged";
      }
      if (!taskDiff.trim()) {
        return { text: "Nothing to review yet: no recorded task diff and no unstaged changes in the workspace.", action: "review" };
      }
      const config = providerStore.registry.listInternal().find((provider) => provider.id === session.providerId && provider.enabled)
        ?? providerStore.registry.listInternal().find((provider) => provider.enabled);
      const model = session.model ?? config?.defaultModel ?? config?.models[0] ?? settings.llm.model;
      if (!model) {
        return { text: "No model configured for review. Pick one with /models or set LLM_MODEL.", action: "review" };
      }
      const provider = config ? createProviderForConfig(config, model) : createProviderFromSettings(settings);
      const rules = await loadProjectRules(workspaceRoot, { globalHome: resolveDaedalusHome(settings.daedalusHome, workspaceRoot) });
      try {
        const result = await reviewDiff({ provider, diff: taskDiff, rulesText: rules.text ? rules.text : undefined, source });
        const header = source === "task-diff" ? `Review of the current task's diff:` : "Review of unstaged changes:";
        return { text: `${header}\n${result.raw}`, action: "review", data: result };
      } catch (error) {
        return { text: `Review failed: ${String(error)}`, action: "review" };
      }
    },
    validate: async () => {
      if (!currentTaskId) return "No task has run yet. Validation runs automatically before a task is marked complete.";
      const report = runner.store.loadReport<{ outcome?: string; evidence?: string[]; metrics?: { checks_passed?: number; checks_failed?: number } }>(currentTaskId);
      if (!report) return "No validation record found for the current task yet.";
      const checks = (report.evidence ?? []).filter((line) => /: (pass|fail|error|skipped) \(/.test(line));
      const summary = `Validation for task ${currentTaskId}: ${report.metrics?.checks_passed ?? 0} passed, ${report.metrics?.checks_failed ?? 0} failed (outcome ${report.outcome ?? "unknown"}).`;
      return checks.length ? `${summary}\n${checks.join("\n")}` : `${summary}\nNo command checks were recorded for this task.`;
    },
    diff: async () => {
      if (!currentTaskId) return "No task has run yet.";
      const report = runner.store.loadReport<{ diff?: string }>(currentTaskId);
      return report?.diff ? report.diff : "No file diff recorded for the current task.";
    },
    rewind: async () => {
      if (!currentTaskId) return { text: "No task has run yet, so there is nothing to rewind.", action: "rewind" };
      try {
        const { restored, deleted } = runner.store.restoreTask(currentTaskId, workspaceRoot);
        if (restored.length === 0 && deleted.length === 0) {
          return { text: `Task ${currentTaskId} recorded no file checkpoints; nothing to rewind.`, action: "rewind" };
        }
        const lines = [
          ...restored.map((path) => `restored ${path}`),
          ...deleted.map((path) => `deleted ${path}`),
        ];
        return { text: `Rewound task ${currentTaskId}:\n${lines.join("\n")}`, action: "rewind", data: { restored, deleted } };
      } catch (error) {
        return { text: `Rewind failed: ${String(error)}`, action: "rewind" };
      }
    },
  });

  if ((process.stdin as { isTTY?: boolean }).isTTY && (process.stdout as { isTTY?: boolean }).isTTY) {
    await runFullscreenChat({
      session,
      runner: runner as unknown as FullscreenRunner,
      setCurrentTaskId: (taskId) => { currentTaskId = taskId; },
    });
    await displayMcp.closeAll();
    return;
  }

  const rl = createInterface({
    input: process.stdin,
    output: process.stdout,
    completer: (line: string, callback: (error: null, result: [string[], string]) => void) => {
      const suggestions = session.suggestions(line).map((command) => `/${command.name}`);
      const hits = suggestions.filter((suggestion) => suggestion.startsWith(line));
      callback(null, [hits.length ? hits : suggestions, line]);
    },
  });

  if ((process.stdin as { isTTY?: boolean }).isTTY) {
    emitKeypressEvents(process.stdin);
    process.stdin.on("keypress", (str: string, key: { name?: string; shift?: boolean; ctrl?: boolean }) => {
      const handledKey = session.handleKey(str, key);
      if (handledKey.action === "cycle_mode") {
        process.stdout.write(`\n${handledKey.text ?? ""}\n${session.statusBar()}\n`);
        rl.prompt();
      } else if (handledKey.action === "toggle_sidebar") {
        process.stdout.write(`\n${session.renderLayout({ columns: process.stdout.columns })}\n`);
        rl.prompt();
      } else if (handledKey.action === "open_commands") {
        process.stdout.write(`\n${session.renderCommandPalette()}\n`);
        rl.prompt();
      } else if (handledKey.action === "open_models") {
        void session.handleInput("/models").then((result) => {
          process.stdout.write(`\n${result.text}\n`);
          rl.prompt();
        });
      } else if (handledKey.action === "cancel" && currentTaskId) {
        runner.cancel(currentTaskId);
        process.stdout.write(`\nCancellation requested for task ${currentTaskId}.\n`);
        rl.prompt();
      } else if (handledKey.action === "palette_up" || handledKey.action === "palette_down") {
        process.stdout.write(`\n${session.renderCommandPalette()}\n`);
        rl.prompt();
      }
    });
  }

  const promptApproval = async (key: PermissionKey): Promise<void> => {
    const answer = await askLine(
      rl,
      `${paint(palette.warning, "▲ Approval requested: ")} ${bold(key.tool)} ${dim(`[${key.action}] ${key.path ?? ""}`)}\n  approve (a) / deny (d) / remember (r)? `,
    );
    if (answer === null) return;
    const parsed = parseApproval(answer);
    runner.approvals.decide(key, parsed.decision, parsed.remember);
  };

  process.stdout.write(`${paint(palette.primary, "Daedalus interactive CLI")}\n`);
  process.stdout.write(`Type a goal, /help for commands, Shift+Tab to cycle modes, /exit to leave.\n`);
  if ((process.stdout as { isTTY?: boolean }).isTTY) {
    process.stdout.write(`${session.renderLayout({ columns: process.stdout.columns })}\n`);
  }

  try {
    for (;;) {
      process.stdout.write(`\n${dim(session.statusBar())}\n${session.renderInputBox()}\n`);
      const line = await askLine(rl, "│ > ");
      if (line === null) break;
      const handled = await session.handleInput(line);
      if (handled.kind === "empty") continue;
      if (handled.kind === "slash") {
        process.stdout.write(`${handled.text}\n`);
        if (handled.action === "exit") break;
        continue;
      }

      session.setStatus("running");
      try {
        const result = await runner.run({
          goal: handled.text,
          mode: session.mode,
          autoApprove: session.autoApprove,
          thinking: session.thinking,
          attachments: session.attachments,
          ...(session.providerId ? { providerId: session.providerId } : {}),
          ...(session.model ? { model: session.model } : {}),
          ...(session.models.length > 1 ? { models: session.models, modelStrategy: session.modelStrategy } : {}),
          onEvent: (event: Event) => {
            currentTaskId = event.task_id;
            session.observeEvent(event);
            if (event.type === "PLAN_CREATED") {
              const plan = (event.payload as { plan?: { steps?: Array<{ intent: string; status?: string }> } }).plan;
              if (plan?.steps) session.setPlan(plan.steps.map((step, index) => `${index + 1}. [${step.status ?? "pending"}] ${step.intent}`).join("\n"));
            }
            if (event.type === "APPROVAL_REQUESTED") {
              const key = (event.payload as { key?: PermissionKey }).key;
              if (key) void promptApproval(key);
              return;
            }
            const formatted = formatEvent(event);
            if (formatted) process.stdout.write(formatted);
          },
        });
        session.setStatus(result.outcome);
        applyExtensionStatus(session, runner.extensionStatus);
        session.setPlan(result.state.steps.map((step, index) => `${index + 1}. [${step.status}] ${step.intent}`).join("\n"));
        session.addTranscript(`Outcome: ${result.outcome} · events ${result.events.length} · files changed ${result.report.metrics.files_changed ?? 0}`);
        process.stdout.write(`\nOutcome: ${result.outcome} · events ${result.events.length} · files changed ${result.report.metrics.files_changed ?? 0}\n`);
        if ((process.stdout as { isTTY?: boolean }).isTTY) process.stdout.write(`${session.renderLayout({ columns: process.stdout.columns })}\n`);
      } catch (error) {
        session.setStatus("failed");
        process.stderr.write(`${paint(palette.error, `Error: ${String(error)}`)}\n`);
      }
    }
  } finally {
    rl.close();
  }
  await displayMcp.closeAll();
}

export type CliProgramDeps = {
  ensureDaemon?: typeof ensureDaemon;
  openBrowser?: typeof openBrowser;
  runInteractiveChat?: (options: { cwd: string }) => Promise<void>;
  readChoice?: () => Promise<string | null>;
  print?: (text: string) => void;
};

/** One-key-at-a-time reader for the arrow-key launcher menu. */
function createLauncherKeyReader(stdin: NodeJS.ReadStream): { readKey: () => Promise<string>; setSuspended: (value: boolean) => void; close: () => void } {
  const buffered: string[] = [];
  const waiters: Array<(key: string) => void> = [];
  let suspended = false;
  emitKeypressEvents(stdin);
  stdin.setRawMode?.(true);
  stdin.resume();
  const onKeypress = (str: string, key: { name?: string; ctrl?: boolean } = {}): void => {
    if (suspended) return;
    let token: string | undefined;
    if (key.ctrl && key.name === "c") token = "escape";
    else if (key.name === "up") token = "up";
    else if (key.name === "down") token = "down";
    else if (key.name === "return" || key.name === "enter") token = "enter";
    else if (key.name === "escape") token = "escape";
    else if (str) token = str;
    if (!token) return;
    const waiter = waiters.shift();
    if (waiter) waiter(token);
    else buffered.push(token);
  };
  stdin.on("keypress", onKeypress);
  return {
    readKey: () => new Promise<string>((resolveKey) => {
      const ready = buffered.shift();
      if (ready !== undefined) resolveKey(ready);
      else waiters.push(resolveKey);
    }),
    setSuspended: (value: boolean) => { suspended = value; },
    close: () => {
      stdin.off("keypress", onKeypress);
      stdin.setRawMode?.(false);
      stdin.pause();
    },
  };
}

export function buildProgram(deps: CliProgramDeps = {}): Command {
  const program = new Command();

  program
    .name("daedalus")
    .description("Daedalus — a web-based agentic coding framework powered by large language models")
    .version(VERSION, "-v, --version", "print the Daedalus version");

  program.action(async () => {
    const print = deps.print ?? ((text: string) => process.stdout.write(text));
    // Workspace anchoring: the invocation directory is the workspace for
    // both interfaces; a daemon started here anchors its session there.
    const cwd = process.cwd();
    const ensured = await (deps.ensureDaemon ?? ensureDaemon)({ cwd });
    // A healthy daemon started from another directory is reused, never
    // restarted or re-anchored — but it keeps serving ITS workspace, so say
    // which one. The CLI below still chats in this directory.
    if (!ensured.started && ensured.status.healthy) {
      const daemonWorkspace = ensured.status.workspace ?? (await fetchDaemonWorkspace(ensured.status.server_url));
      if (daemonWorkspace && daemonWorkspace !== cwd) {
        print(`A Daedalus server from ${daemonWorkspace} is already running at ${ensured.status.server_url}; it stays anchored there. Chatting here still uses ${cwd}.\n`);
      }
    }
    const openCli = async (): Promise<void> => {
      await (deps.runInteractiveChat ?? runInteractiveChat)({ cwd });
    };
    const openWeb = async (): Promise<void> => {
      const browser = (deps.openBrowser ?? openBrowser)(ensured.status.server_url);
      print(`Opening Web with ${browser.command}: ${ensured.status.server_url}\n`);
    };
    const hideToTray = async (): Promise<void> => {
      // Honest background mode: no native tray backend is bundled, so this
      // just reports that state (the tray slot in the frame already shows
      // it) and leaves the daemon as the only background process.
      await new TrayManager().start();
    };

    const stdin = process.stdin as NodeJS.ReadStream;
    const stdout = process.stdout as NodeJS.WriteStream;
    const isTTY = Boolean(stdin.isTTY && stdout.isTTY);
    if (isTTY) {
      const keys = createLauncherKeyReader(stdin);
      let drawnLines = 0;
      try {
        await runLauncherMenu({
          status: ensured.status,
          print,
          openCli: async () => {
            keys.setSuspended(true);
            try {
              await openCli();
            } finally {
              keys.setSuspended(false);
            }
          },
          openWeb,
          hideToTray,
          render: (frame: string) => {
            if (drawnLines > 0) stdout.write(`\x1b[${drawnLines}A`);
            stdout.write(`\x1b[J${frame}\n`);
            drawnLines = frame.split("\n").length;
          },
          readKey: keys.readKey,
        });
      } finally {
        keys.close();
      }
      return;
    }

    await runBareLauncher({
      ensureDaemon: async () => ensured,
      readChoice: deps.readChoice ?? (async () => {
        const rl = createInterface({ input: process.stdin, output: process.stdout });
        try {
          return await askLine(rl, "Choose: ");
        } finally {
          rl.close();
        }
      }),
      print,
      openCli,
      openWeb: async () => {
        await openWeb();
      },
      hideToTray,
    });
  });

  program
    .command("health")
    .description("check that the Daedalus core is importable and report configuration")
    .option("--url <url>", "server base URL override")
    .action(async (options: { url?: string }) => {
      const settings = loadSettings();
      const base = options.url ?? `http://${settings.server.host}:${settings.server.port}`;
      try {
        const res = await fetch(new URL("/health", base), { signal: AbortSignal.timeout(3000) });
        const body = (await res.json()) as unknown;
        process.stdout.write(JSON.stringify({ core: "ok", server: body }, null, 2) + "\n");
      } catch (error) {
        process.stderr.write(`core ok, server unreachable at ${base}: ${String(error)}\n`);
        process.exitCode = 1;
      }
    });

  program
    .command("run")
    .description("execute a task autonomously through Daedalus Core")
    .argument("<task>", "natural language software engineering goal")
    .option("--cwd <path>", "target workspace directory", process.cwd())
    .option("--json", "emit JSON events and final report", false)
    .option("--yolo", "auto-approve all mutating tool actions", false)
    .option("--max-iterations <number>", "max agent loop iterations", "25")
    .option("--model <name>", "override the model from settings (LLM_MODEL)")
    .option("--models <list>", "comma-separated model pool for failover/round-robin (LLM_MODELS)")
    .option("--model-strategy <strategy>", "model pool strategy: failover or round-robin")
    .option("--provider <name>", "override the provider endpoint (LLM_BASE_URL)")
    .option("--provider-id <id>", "use a saved provider from the provider registry")
    .option("--mode <mode>", "agent mode: ask, code, plan, orchestrator, or manual")
    .option("--no-thinking", "do not emit THOUGHT events for provider reasoning text")
    .option("--ci", "CI mode: implies --json, never prompts, mutating approvals auto-deny unless --yolo", false)
    .option("--isolation <mode>", "run the task in an isolated git worktree (worktree)", undefined)
    .option("--timeout <ms>", "per-request model timeout in milliseconds (LLM_TIMEOUT_MS)")
    .option("--verbose", "also stream the raw JSON event line for every event", false)
    .action(async (
      task: string,
      options: { cwd: string; json?: boolean; yolo?: boolean; maxIterations?: string; model?: string; models?: string; modelStrategy?: string; provider?: string; providerId?: string; mode?: string; thinking?: boolean; ci?: boolean; isolation?: string; timeout?: string; verbose?: boolean },
    ) => {
      const workspaceRoot = options.cwd;
      const ci = options.ci === true;
      const json = ci || options.json === true;
      const isolation = parseIsolation(options.isolation);
      const mode = parseMode(options.mode) ?? (options.yolo ? "auto" : "auto");
      // CI never prompts: the ask policy becomes deny-on-missing, so a
      // mutating call that would need approval is denied outright (unless
      // --yolo was passed deliberately). Piped stdin closes are irrelevant.
      const approvalPolicy = options.yolo ? "auto" : ci ? "deny" : "ask";
      const maxIterations = parseInt(options.maxIterations ?? "25", 10);
      const tty = process.stdout.isTTY && !json;

      const modelTimeoutMs = parsePositiveInt(options.timeout, "--timeout");

      const settings = loadSettings();
      const models = parseModelList(options.models);
      const modelStrategy = parseModelStrategy(options.modelStrategy);
      if (options.model !== undefined || options.provider !== undefined || models !== undefined || modelStrategy !== undefined) {
        settings.llm.model = options.model ?? settings.llm.model;
        settings.llm.baseUrl = options.provider ?? settings.llm.baseUrl;
        if (models !== undefined) {
          settings.llm.models = models;
          settings.llm.model = options.model ?? models[0] ?? settings.llm.model;
        }
        if (modelStrategy !== undefined) settings.llm.modelStrategy = modelStrategy;
      }

      let providerRegistry;
      if (options.providerId !== undefined) {
        const providerStore = new ProviderRegistryStore(resolveDaedalusHome(settings.daedalusHome, workspaceRoot));
        await providerStore.load(seedProviderFromSettings(settings));
        providerRegistry = providerStore.registry;
      }

      const runner = new TaskRunner({
        workspaceRoot,
        approvalPolicy,
        maxIterations,
        settings,
        mode,
        autoApprove: options.yolo === true,
        ...(providerRegistry ? { providerRegistry } : {}),
        ...(options.providerId !== undefined ? { providerId: options.providerId } : {}),
        ...(models !== undefined ? { models } : {}),
        ...(modelStrategy !== undefined ? { modelStrategy } : {}),
        ...(options.thinking === false ? { thinking: false } : {}),
        ...(modelTimeoutMs === undefined ? {} : { modelTimeoutMs }),
      });

      let currentTaskId: string | undefined;
      let stopSpinner: (() => void) | undefined;
      let rl: ReturnType<typeof createInterface> | undefined;

      const promptApproval = async (key: PermissionKey): Promise<void> => {
        rl ??= createInterface({ input: process.stdin });
        const answer = await new Promise<string>((resolve) => rl!.question(
          `${paint(palette.warning, "▲ Approval requested: ")} ${bold(key.tool)} ${dim(`[${key.action}] ${key.path ?? ""}`)}\n  approve (a) / deny (d) / remember (r)? `,
          resolve,
        ));
        const { decision, remember } = parseApproval(answer);
        runner.approvals.decide(key, decision, remember);
      };

      const startSpinner = (label: string): void => {
        if (!tty || stopSpinner) return;
        let frame = 0;
        const tick = () => {
          const glyph = SPINNER_FRAMES[frame % SPINNER_FRAMES.length] ?? "";
          const colored = supportsColor()
            ? cyclingGradient(glyph, frame, palette)
            : glyph;
          process.stdout.write(`\r${colored} ${dim(label)}`);
          frame++;
        };
        tick();
        const timer = setInterval(tick, SPINNER_INTERVAL_MS);
        stopSpinner = () => {
          clearInterval(timer);
          stopSpinner = undefined;
          process.stdout.write("\r\x1b[2K");
        };
      };

      const sigintHandler = makeSigintHandler(runner, () => currentTaskId, () => !json);
      process.on("SIGINT", sigintHandler);

      try {
        const result = await runner.run({
          goal: task,
          mode,
          autoApprove: options.yolo === true,
          ...(isolation ? { isolation } : {}),
          ...(options.providerId !== undefined ? { providerId: options.providerId } : {}),
          ...(options.model !== undefined ? { model: options.model } : {}),
          ...(models !== undefined ? { models } : {}),
          ...(modelStrategy !== undefined ? { modelStrategy } : {}),
          ...(options.thinking === false ? { thinking: false } : {}),
          onEvent: (event: Event) => {
            currentTaskId = event.task_id;
            // --verbose adds the raw event line alongside the human-readable
            // rendering; --json remains the exclusive machine-readable mode.
            if (options.verbose) process.stderr.write(JSON.stringify(event) + "\n");
            if (json) {
              process.stdout.write(JSON.stringify(event) + "\n");
            } else if (tty) {
              if (event.type === "APPROVAL_REQUESTED") {
                stopSpinner?.();
                stopSpinner = undefined;
                const key = (event.payload as { key?: PermissionKey }).key;
                // CI mode never prompts (policy already denies); the guard
                // keeps even a stray request from touching stdin.
                if (key && !ci) void promptApproval(key);
              } else {
                stopSpinner?.();
                stopSpinner = undefined;
                const formatted = formatEvent(event);
                if (formatted) process.stdout.write(formatted);
                if (event.type === "MODEL_REQUEST_STARTED") startSpinner("thinking...");
                if (event.type === "TOOL_CALL_STARTED") startSpinner("working...");
              }
            } else {
              const formatted = formatEvent(event);
              if (formatted) process.stdout.write(formatted);
            }
          },
        });

        stopSpinner?.();
        stopSpinner = undefined;

        if (ci) {
          // CI contract: outcome + mapped exit code on the final line; the
          // report carries title/validation_source/worktree when present.
          process.stdout.write(JSON.stringify({ outcome: result.outcome, exit_code: exitCodeFor(result.outcome), report: result.report }) + "\n");
        } else if (json) {
          process.stdout.write(JSON.stringify({ report: result.report, outcome: result.outcome }) + "\n");
        }

        const code = exitCodeFor(result.outcome);
        process.exitCode = code;
      } catch (error) {
        stopSpinner?.();
        stopSpinner = undefined;
        if (json) {
          process.stdout.write(JSON.stringify({ error: String(error), ...(ci ? { exit_code: 1 } : {}) }) + "\n");
        } else {
          process.stderr.write(`${paint(palette.error, `Error: ${String(error)}`)}\n`);
        }
        process.exitCode = 1;
      } finally {
        stopSpinner?.();
        process.removeListener("SIGINT", sigintHandler);
        rl?.close();
      }
    });

  program
    .command("serve")
    .description("run the Daedalus background server in the foreground")
    .option("--host <host>", "server host")
    .option("--port <port>", "server port")
    .option("--daemon", "start or reuse the background daemon and return", false)
    .action(async (options: { host?: string; port?: string; daemon?: boolean }) => {
      const settings = loadSettings();
      const port = options.port === undefined ? settings.server.port : parsePositiveInt(options.port, "--port");
      const host = options.host ?? settings.server.host;
      const tray = new TrayManager();
      const trayStatus = await tray.start();
      if (options.daemon) {
        const ensured = await ensureDaemon({ host, port });
        process.stdout.write(`Daedalus server ${ensured.started ? "started" : "already running"} at ${ensured.status.server_url} (pid ${ensured.status.pid ?? "unknown"})\n`);
        process.stdout.write(`Tray: ${ensured.status.tray.reason}\n`);
        return;
      }
      process.stdout.write(`Daedalus server starting at http://${host}:${port}\n`);
      process.stdout.write(`Tray: ${trayStatus.reason}\n`);
      const code = await startForegroundServer({ host, port });
      await tray.stop();
      if (code !== 0) process.exitCode = code;
    });

  program
    .command("status")
    .description("show background server status")
    .option("--json", "emit JSON", false)
    .action(async (options: { json?: boolean }) => {
      const status = await getDaemonStatus();
      if (options.json) {
        process.stdout.write(JSON.stringify(status, null, 2) + "\n");
        return;
      }
      process.stdout.write(`Server: ${status.server_url}\n`);
      process.stdout.write(`Healthy: ${status.healthy ? "yes" : "no"}\n`);
      process.stdout.write(`Running: ${status.running ? "yes" : "no"}\n`);
      process.stdout.write(`Workspace: ${status.workspace ?? process.cwd()}\n`);
      if (status.pid) process.stdout.write(`PID: ${status.pid}\n`);
      if (status.started_at) process.stdout.write(`Started: ${status.started_at}\n`);
      process.stdout.write(`Tray: ${status.tray.reason}\n`);
      process.stdout.write(`Tray icon: ${status.tray.icon} (placeholder "D")\n`);
      if (status.reason) process.stdout.write(`Note: ${status.reason}\n`);
    });

  program
    .command("stop")
    .description("stop the background Daedalus server")
    .action(async () => {
      const result = await stopDaemon();
      process.stdout.write(`${result.reason}${result.pid ? ` (pid ${result.pid})` : ""}\n`);
      if (!result.stopped && result.status.healthy) process.exitCode = 1;
    });

  program
    .command("chat")
    .description("open the interactive Daedalus CLI")
    .option("--cwd <path>", "target workspace directory", process.cwd())
    .option("--mode <mode>", "agent mode: ask, code, plan, orchestrator, or manual")
    .option("--yolo", "auto-approve mutating tool actions where the mode allows it", false)
    .option("--no-thinking", "hide provider THOUGHT events for this chat session")
    .option("--max-iterations <number>", "max agent loop iterations", "25")
    .action(async (options: { cwd: string; mode?: string; yolo?: boolean; thinking?: boolean; maxIterations?: string }) => {
      await runInteractiveChat({
        cwd: options.cwd,
        mode: parseMode(options.mode),
        yolo: options.yolo === true,
        thinking: options.thinking,
        maxIterations: parseInt(options.maxIterations ?? "25", 10),
      });
    });

  program
    .command("cancel")
    .description("request cancellation of an active task by its id")
    .argument("<task-id>", "id of the task to cancel")
    .action((taskId: string) => {
      const settings = loadSettings();
      const store = new TaskStore(settings.daedalusHome);
      store.requestCancel(taskId);
      process.stdout.write(`Cancellation requested for task ${taskId}\n`);
    });

  program
    .command("restore")
    .description("rewind a task's file changes from the checkpoints it recorded")
    .argument("<task-id>", "id of the task to rewind")
    .option("--cwd <path>", "target workspace directory", process.cwd())
    .action((taskId: string, options: { cwd: string }) => {
      const settings = loadSettings();
      const store = new TaskStore(resolveDaedalusHome(settings.daedalusHome, options.cwd));
      try {
        const { restored, deleted } = store.restoreTask(taskId, options.cwd);
        if (restored.length === 0 && deleted.length === 0) {
          process.stdout.write(`No checkpoints recorded for task ${taskId}; nothing to restore.\n`);
          return;
        }
        for (const path of restored) process.stdout.write(`restored ${path}\n`);
        for (const path of deleted) process.stdout.write(`deleted ${path}\n`);
        process.stdout.write(`Task ${taskId} rewound: ${restored.length} restored, ${deleted.length} deleted.\n`);
      } catch (error) {
        process.stderr.write(`${paint(palette.error, `Error: ${String(error)}`)}\n`);
        process.exitCode = 1;
      }
    });

  program
    .command("apply")
    .description("apply an isolated (worktree) task's changes to the main workspace, then remove the worktree")
    .argument("<task-id>", "id of the worktree task to apply")
    .option("--cwd <path>", "main workspace directory", process.cwd())
    .action(async (taskId: string, options: { cwd: string }) => {
      const settings = loadSettings();
      const store = new TaskStore(resolveDaedalusHome(settings.daedalusHome, options.cwd));
      const record = store.loadWorktreeRecord(taskId);
      if (!record) {
        process.stderr.write(`${paint(palette.error, `Error: task ${taskId} has no worktree record (was it run with --isolation worktree?)`)}\n`);
        process.exitCode = 1;
        return;
      }
      try {
        const { applied } = await applyTaskWorktree({ workspaceRoot: options.cwd, record });
        if (applied.length === 0) {
          process.stdout.write(`Task ${taskId} changed no files in its worktree; nothing to apply.\n`);
        } else {
          for (const path of applied) process.stdout.write(`applied ${path}\n`);
          process.stdout.write(`Applied ${applied.length} file(s) from branch ${record.branch} to ${options.cwd}.\n`);
        }
        await removeTaskWorktree({ workspaceRoot: options.cwd, record });
        process.stdout.write(`Worktree ${record.path} and branch ${record.branch} removed.\n`);
      } catch (error) {
        process.stderr.write(`${paint(palette.error, `Error: ${String(error)}`)}\n`);
        process.exitCode = 1;
      }
    });

  const skillsCommand = program
    .command("skills")
    .description("list bundled starter skills and skills installed in a workspace");

  const printSkills = async (cwd: string): Promise<void> => {
    const listing = await listSkills({ workspaceRoot: cwd });
    process.stdout.write(`${formatSkillsListing(listing)}\n`);
  };

  skillsCommand.action(async () => {
    await printSkills(process.cwd());
  });

  skillsCommand
    .command("list")
    .description("show bundled starter skills and workspace-installed skills")
    .option("--cwd <path>", "workspace directory", process.cwd())
    .action(async (options: { cwd: string }) => {
      await printSkills(options.cwd);
    });

  skillsCommand
    .command("install")
    .description("copy bundled starter skills into <workspace>/.daedalus/skills/")
    .argument("[names...]", "bundled skill names to install")
    .option("--all", "install every bundled skill", false)
    .option("--force", "overwrite an already-installed skill with the same name", false)
    .option("--cwd <path>", "workspace directory", process.cwd())
    .action(async (names: string[], options: { all?: boolean; force?: boolean; cwd: string }) => {
      try {
        const result = await installBundledSkills({
          workspaceRoot: options.cwd,
          names,
          all: options.all === true,
          force: options.force === true,
        });
        for (const name of result.installed) process.stdout.write(`installed ${name}\n`);
        for (const skipped of result.skipped) process.stdout.write(`skipped ${skipped.name}: ${skipped.reason}\n`);
        if (result.installed.length === 0 && result.skipped.length > 0) process.exitCode = 1;
      } catch (error) {
        process.stderr.write(`${paint(palette.error, `Error: ${String(error)}`)}\n`);
        process.exitCode = 1;
      }
    });

  program
    .command("ask")
    .description("send a prompt to the configured LLM provider (gated by DAEDALUS_LIVE_LLM=1)")
    .argument("<prompt>", "message to send")
    .action((prompt: string) => {
      if (process.env.DAEDALUS_LIVE_LLM !== "1") {
        process.stderr.write("DAEDALUS_LIVE_LLM=1 is required to send live prompts; set it and retry\n");
        process.exitCode = 1;
        return;
      }
      const settings = loadSettings();
      if (!settings.llm.model) {
        process.stderr.write("LLM_MODEL is required\n");
        process.exitCode = 1;
        return;
      }
      const provider = createProviderFromSettings(settings);
      const messages: Message[] = [{ role: "user", content: prompt }];
      provider
        .chat(messages)
        .then((res) => {
          process.stdout.write(`${res.message.content}\n`);
        })
        .catch((error: unknown) => {
          process.stderr.write(String(error) + "\n");
          process.exitCode = 1;
        });
    });

  return program;
}

const invokedDirectly =
  import.meta.url === `file://${process.argv[1] ?? ""}` ||
  (process.argv[1] ?? "").endsWith("/daedalus") ||
  (process.argv[1] ?? "").endsWith("cli/src/index.ts");

if (invokedDirectly) {
  buildProgram().parseAsync(process.argv).catch((error: unknown) => {
    process.stderr.write(String(error) + "\n");
    process.exitCode = 1;
  });
}
