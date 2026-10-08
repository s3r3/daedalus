#!/usr/bin/env -S node --experimental-strip-types
import { Command } from "commander";
import { createInterface, emitKeypressEvents } from "node:readline";
import { join } from "node:path";
import {
  McpManager,
  ProviderRegistryStore,
  TaskRunner,
  TaskStore,
  answerConversational,
  answerQuestion,
  applyTaskWorktree,
  conversationalFallbackReply,
  questionFallbackReply,
  createProviderForConfig,
  exitCodeFor,
  loadAgents,
  loadLspConfig,
  withDefaultLspServers,
  loadMcpConfig,
  loadProjectRules,
  loadSettings,
  loadSkills,
  removeTaskWorktree,
  resolveDaedalusHome,
  resolveSkillSearchDirs,
  createProviderFromSettings,
  reviewDiff,
  seedProviderFromSettings,
  unstagedDiff,
  workspaceAgentsDir,
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
  type UserQuestionInfo,
} from "@daedalus/core";
import {
  createInPlaceFrameRenderer,
  ensureDaemon,
  fetchDaemonWorkspace,
  getDaemonStatus,
  joinServerUrl,
  openBrowser,
  runBareLauncher,
  runLauncherMenu,
  startForegroundServer,
  stopDaemon,
} from "./launcher.ts";

/** Skills a handled interactive line carries into its task (explicit `/skill` invocations), as a run-ready spread. */

/** `--skill a,b` → ['a', 'b'] (trimmed, non-empty). */
function runSkillNames(value: string | undefined): string[] {
  return (value ?? "")
    .split(",")
    .map((name) => name.trim())
    .filter((name) => name.length > 0);
}
import { TrayManager } from "./tray.ts";
import { DeltaSuffixTracker, formatCount, scrambleText, spinnerGlyph, tokenSummary } from "./live-render.ts";
import { formatSkillsListing, installBundledSkills, listSkills, setSkillDisabledForWorkspace } from "./skills-bundled.ts";

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

/**
 * Map a typed answer line to a user-question answer (ask_user): a bare
 * number inside the option range selects that option's label; anything
 * else is the user's own words, delivered verbatim. Empty input abstains
 * (null) so the caller can re-prompt instead of answering with noise.
 */
export function parseQuestionAnswer(line: string, options: Array<{ label: string }>): string | null {
  const text = line.trim();
  if (!text) return null;
  const n = Number(text);
  if (Number.isInteger(n) && n >= 1 && n <= options.length) return options[n - 1]?.label ?? text;
  return text;
}

/** The question block every CLI surface shows: question, numbered options, how to answer. */
export function questionPromptText(info: {
  question: string;
  options: Array<{ label: string; description?: string }>;
  allowFreeText?: boolean;
}): string {
  const options = info.options
    .map((option, index) => `  ${index + 1}. ${option.label}${option.description ? ` — ${option.description}` : ""}`)
    .join("\n");
  const hint = info.allowFreeText === false ? "reply with a number" : "reply with a number, or type your own answer";
  return `${paint(palette.info, "?")} ${bold("The agent asks:")} ${info.question}\n${options}\n${dim(`  ${hint}`)}`;
}

/**
 * One-line terminal rendering of an approval preview so the CLI shows the
 * exact artifact being approved (verbatim command; path + size for writes;
 * the patch, capped, for edits) instead of just a tool name.
 */
export function approvalPreviewLine(payload: {
  approval?: { preview?: { kind: string; command?: string; path?: string; content?: string; patch?: string; args?: unknown } };
  key?: { tool: string; path?: string };
}): string | undefined {
  const preview = payload.approval?.preview;
  if (!preview) return undefined;
  if (preview.kind === "command" && preview.command !== undefined) return `$ ${preview.command}`;
  if (preview.kind === "write" && preview.path !== undefined) {
    return `write ${preview.path} (${(preview.content ?? "").length} chars)`;
  }
  if (preview.kind === "edit" && preview.path !== undefined) {
    const lines = (preview.patch ?? "").split("\n").filter((line) => line.trim());
    const shown = lines.slice(0, 24).join("\n");
    return `edit ${preview.path}\n${shown}${lines.length > 24 ? `\n… (${lines.length - 24} more lines)` : ""}`;
  }
  if (preview.kind === "args") {
    return `${payload.key?.tool ?? "tool"} ${JSON.stringify(preview.args ?? {})}`;
  }
  return undefined;
}

const AGENT_MODES: AgentMode[] = ["ask", "manual", "auto", "plan"];

export function parseMode(value: string | undefined): AgentMode | undefined {
  if (value === undefined) return undefined;
  const lowered = value.trim().toLowerCase();
  // `code` is the display alias for auto; the retired `orchestrator` mode
  // maps to auto (delegation is the spawn_subagent tool now).
  const normalized = (lowered === "code" || lowered === "orchestrator" ? "auto" : lowered) as AgentMode;
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
      if (!p.text) return "";
      const collapsed = p.text.replace(/\s+/g, " ").trim();
      const shown = collapsed.length > 240 ? `${collapsed.slice(0, 240)} …` : collapsed;
      return `${dim(`thinking · ${shown}`)}\n`;
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
      const args = JSON.stringify(p.call?.args ?? {});
      const shortArgs = args.length > 64 ? `${args.slice(0, 61)}…` : args;
      return `${paint(palette.warning, "⚙")} ${p.call?.tool ?? ""} ${dim(shortArgs)}\n`;
    }
    case "TOOL_CALL_FINISHED": {
      const p = event.payload as { call?: { tool: string }; result?: { status: string; output: string } };
      const ok = p.result?.status === "ok";
      const icon = ok ? paint(palette.success, "✔") : paint(palette.error, "✖");
      const outputLines = (p.result?.output ?? "").trim().split(/\r?\n/).filter((line) => line.trim().length > 0);
      const first = (outputLines[0] ?? "").slice(0, 100);
      const more = outputLines.length > 1 ? ` … (${outputLines.length - 1} more lines)` : "";
      return `  ↳ ${icon} ${dim(`${p.call?.tool ?? ""} -> ${first}${more}`)}\n`;
    }
    case "SKILL_LOADED": {
      const p = event.payload as { name?: string; origin?: string; via?: string };
      const who = p.via === "user" ? "invoked by you" : "loaded by agent";
      return `${paint(palette.secondary, "✦")} Skill loaded: ${p.name ?? "unknown"} (${p.origin ?? "unknown"} — ${who})\n`;
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
      const p = event.payload as {
        key?: { tool: string; action: string; path?: string };
        approval?: Parameters<typeof approvalPreviewLine>[0]["approval"];
      };
      const preview = approvalPreviewLine(p);
      return `${paint(palette.warning, "▲")} Approval requested: ${p.key?.tool} [${p.key?.action}] ${p.key?.path ?? ""}${preview ? `\n  ${preview.split("\n").join("\n  ")}` : ""}\n`;
    }
    case "QUESTION_REQUESTED": {
      const p = event.payload as {
        question?: { question?: string; options?: Array<{ label: string; description?: string }>; allowFreeText?: boolean };
      };
      if (!p.question?.question) return "";
      return `${questionPromptText({ question: p.question.question, options: p.question.options ?? [], allowFreeText: p.question.allowFreeText })}\n`;
    }
    case "QUESTION_ANSWERED": {
      const p = event.payload as { answer?: string; timed_out?: boolean; cancelled?: boolean };
      if (p.timed_out) return `${paint(palette.warning, "?")} No answer arrived — the agent continues with stated assumptions.\n`;
      if (p.cancelled) return `${paint(palette.warning, "?")} Question cancelled.\n`;
      return `${paint(palette.success, "?")} You answered: ${p.answer ?? ""}\n`;
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
    case "ORCHESTRATION_SKIPPED": {
      const p = event.payload as { reason?: string; decomposed_children?: number };
      return `${paint(palette.info, "◆")} Orchestrator: single path (${p.reason ?? "single_path"}) — running one agent loop directly instead of ${p.decomposed_children ?? 0} child task(s)\n`;
    }
    case "CHILD_TASK_STARTED": {
      const p = event.payload as { child?: { goal?: string } };
      return `${paint(palette.secondary, "▸")} Child task started: ${p.child?.goal ?? ""}\n`;
    }
    case "CHILD_TASK_FINISHED": {
      const p = event.payload as { child?: { goal?: string; status?: string; result_summary?: string; usage?: { total_tokens?: number } } };
      const tokens = typeof p.child?.usage?.total_tokens === "number" ? ` · ${formatCount(p.child.usage.total_tokens)} tokens` : "";
      return `${paint(palette.secondary, "▸")} Child task ${p.child?.status ?? "finished"}: ${p.child?.result_summary ?? p.child?.goal ?? ""}${tokens}\n`;
    }
    case "REPLAN_CREATED": {
      const p = event.payload as { plan?: { steps?: Array<unknown> }; reason?: string };
      return `${paint(palette.secondary, "✦")} Replan (${p.reason ?? "revised"}): ${p.plan?.steps?.length ?? 0} steps\n`;
    }
    case "REVIEW_COMPLETED": {
      const p = event.payload as { findings?: Array<unknown>; blocking?: number; model?: string };
      const findings = p.findings?.length ?? 0;
      return `${paint(palette.info, "◆")} Review by ${p.model ?? "reviewer"}: ${findings} finding${findings === 1 ? "" : "s"}${p.blocking ? ` (${p.blocking} blocking)` : ""}\n`;
    }
    case "TAILOR_ESCALATED": {
      const p = event.payload as { reason?: string; from_model?: string; to_model?: string; model?: string };
      return `${paint(palette.warning, "↯")} Escalated to stronger model${p.to_model ?? p.model ? ` (${p.to_model ?? p.model})` : ""}: ${p.reason ?? "loop detected"}\n`;
    }
    case "MODEL_REQUEST_FAILED": {
      const p = event.payload as { error?: string; error_kind?: string; model?: string };
      return `${paint(palette.error, "✖")} Model request failed${p.model ? ` (${p.model})` : ""}${p.error_kind ? ` [${p.error_kind}]` : ""}: ${p.error ?? "unknown error"}\n`;
    }
    case "MODEL_TEXT_DELTA":
      // Streamed text is rendered by the live surfaces (fullscreen chat
      // preview, `run` TTY increments); formatEvent stays silent so the
      // text can never print twice.
      return "";
    case "MODEL_REQUEST_STARTED":
    case "MODEL_REQUEST_FINISHED":
    case "APPROVAL_DECIDED":
      // Lifecycle bookkeeping: spinners, the usage tracker, and the
      // approval prompt itself already surface these.
      return "";
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
    case "JOB_STARTED": {
      const p = event.payload as { job_id?: string; command?: string };
      return `  ${paint(palette.info, "⧗")} background job ${p.job_id ?? "job"} started: ${p.command ?? ""}\n`;
    }
    case "JOB_FINISHED": {
      const p = event.payload as { job_id?: string; state?: string; exit_code?: number | null };
      const ok = p.state === "exited";
      return `  ${ok ? paint(palette.success, "✔") : paint(palette.error, "✖")} background job ${p.job_id ?? "job"} ${p.state ?? "finished"}${p.exit_code !== null && p.exit_code !== undefined ? ` (exit ${p.exit_code})` : ""}\n`;
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

export type CliProgramDeps = {
  ensureDaemon?: typeof ensureDaemon;
  stopDaemon?: typeof stopDaemon;
  openBrowser?: typeof openBrowser;
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
        print(`A Daedalus server from ${daemonWorkspace} is already running at ${ensured.status.server_url}; it stays anchored there and its Web UI keeps that workspace.\n`);
      }
    }
    const openWeb = async (targetUrl: string): Promise<void> => {
      const browser = (deps.openBrowser ?? openBrowser)(targetUrl);
      print(`Opening Web with ${browser.command}: ${targetUrl}\n`);
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
    // Exit in the launcher shuts the daemon down through the exact same
    // mechanism as `daedalus stop`, anchored at this invocation directory.
    const stopServer = async (): Promise<{ stopped: boolean; pid?: number; reason: string }> => {
      const result = await (deps.stopDaemon ?? stopDaemon)({ cwd });
      return { stopped: result.stopped, pid: result.pid, reason: result.reason };
    };
    if (isTTY) {
      const keys = createLauncherKeyReader(stdin);
      const renderer = createInPlaceFrameRenderer({
        write: (text) => {
          stdout.write(text);
        },
        columns: () => stdout.columns ?? 80,
      });
      try {
        await runLauncherMenu({
          status: ensured.status,
          // Close the in-place frame before anything prints, so messages
          // land below the one clean menu copy left in the scrollback.
          print: (text) => {
            renderer.close();
            print(text);
          },
          openWeb: async (path: string) => {
            renderer.close();
            await openWeb(joinServerUrl(ensured.status.server_url, path));
          },
          hideToTray,
          stopServer,
          render: renderer.paint,
          readKey: keys.readKey,
        });
      } finally {
        renderer.close();
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
      openWeb: async (url: string) => {
        await openWeb(url);
      },
      hideToTray,
      stopServer,
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
    .option("--mode <mode>", "agent mode: ask, code, plan, or manual")
    .option("--skill <names>", "comma-separated skill names to force-load into the task (same as /skill <name> in interactive chat; disabled/unknown names fail the run visibly)")
    .option("--no-thinking", "do not emit THOUGHT events for provider reasoning text")
    .option("--ci", "CI mode: implies --json, never prompts, mutating approvals auto-deny unless --yolo", false)
    .option("--isolation <mode>", "run the task in an isolated git worktree (worktree)", undefined)
    .option("--timeout <ms>", "per-request model timeout in milliseconds (LLM_TIMEOUT_MS)")
    .option("--verbose", "also stream the raw JSON event line for every event", false)
    .action(async (
      task: string,
      options: { cwd: string; json?: boolean; yolo?: boolean; maxIterations?: string; model?: string; models?: string; modelStrategy?: string; provider?: string; providerId?: string; mode?: string; skill?: string; thinking?: boolean; ci?: boolean; isolation?: string; timeout?: string; verbose?: boolean },
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
        // TTY humans get streamed model text (rendered incrementally
        // below); --json/--ci output stays exactly as before.
        ...(tty ? { streamText: true } : {}),
      });

      let currentTaskId: string | undefined;
      let stopSpinner: (() => void) | undefined;
      let rl: ReturnType<typeof createInterface> | undefined;
      const deltaTracker = new DeltaSuffixTracker();
      let streamOpen = false;

      const promptApproval = async (key: PermissionKey, preview?: string): Promise<void> => {
        rl ??= createInterface({ input: process.stdin });
        const answer = await new Promise<string>((resolve) => rl!.question(
          `${paint(palette.warning, "▲ Approval requested: ")} ${bold(key.tool)} ${dim(`[${key.action}] ${key.path ?? ""}`)}${preview ? `\n  ${preview.split("\n").join("\n  ")}` : ""}\n  approve (a) / deny (d) / remember (r)? `,
          resolve,
        ));
        const { decision, remember } = parseApproval(answer);
        runner.approvals.decide(key, decision, remember);
      };

      const promptQuestion = async (info: UserQuestionInfo): Promise<void> => {
        rl ??= createInterface({ input: process.stdin });
        const answer = await new Promise<string>((resolve) => rl!.question(
          `${questionPromptText(info)}\n  answer: `,
          resolve,
        ));
        const parsed = parseQuestionAnswer(answer, info.options);
        if (parsed !== null) runner.questions.answer(info.id, parsed);
      };

      const startSpinner = (label: string): void => {
        if (!tty || stopSpinner) return;
        let frame = 0;
        const startedAt = Date.now();
        const tick = () => {
          const glyph = spinnerGlyph(frame);
          const colored = supportsColor()
            ? cyclingGradient(glyph, frame, palette)
            : glyph;
          // Same working line as the fullscreen chat: gradient glyph,
          // the label decoding into place, then elapsed seconds.
          const elapsed = Math.floor((Date.now() - startedAt) / 1000);
          process.stdout.write(`\r${colored} ${dim(`${scrambleText(label.replace(/\.+$/, ""), frame)} · ${elapsed}s`)}`);
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
          ...(runSkillNames(options.skill).length > 0 ? { skills: runSkillNames(options.skill) } : {}),
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
              if (event.type === "MODEL_TEXT_DELTA") {
                // Streamed model text: print only the new suffix. The
                // turn's own lines (thinking, tool calls) close the
                // stream line when they arrive — no doubles.
                stopSpinner?.();
                stopSpinner = undefined;
                const suffix = deltaTracker.push(event);
                if (suffix) {
                  process.stdout.write(suffix);
                  streamOpen = true;
                }
              } else if (event.type === "APPROVAL_REQUESTED") {
                stopSpinner?.();
                stopSpinner = undefined;
                if (streamOpen) {
                  process.stdout.write("\n");
                  streamOpen = false;
                  deltaTracker.reset();
                }
                const payload = event.payload as {
                  key?: PermissionKey;
                  approval?: Parameters<typeof approvalPreviewLine>[0]["approval"];
                };
                // CI mode never prompts (policy already denies); the guard
                // keeps even a stray request from touching stdin.
                if (payload.key && !ci) void promptApproval(payload.key, approvalPreviewLine(payload));
              } else if (event.type === "QUESTION_REQUESTED") {
                stopSpinner?.();
                stopSpinner = undefined;
                if (streamOpen) {
                  process.stdout.write("\n");
                  streamOpen = false;
                  deltaTracker.reset();
                }
                const payload = event.payload as { question?: UserQuestionInfo };
                // Same CI guard as approvals: never touch stdin there; the
                // question settles on its own timeout with assumptions.
                if (payload.question && !ci) void promptQuestion(payload.question);
              } else {
                stopSpinner?.();
                stopSpinner = undefined;
                if (streamOpen) {
                  process.stdout.write("\n");
                  streamOpen = false;
                  deltaTracker.reset();
                }
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
        if (streamOpen) {
          process.stdout.write("\n");
          streamOpen = false;
          deltaTracker.reset();
        }

        if (ci) {
          // CI contract: outcome + mapped exit code on the final line; the
          // report carries title/validation_source/worktree when present.
          process.stdout.write(JSON.stringify({ outcome: result.outcome, exit_code: exitCodeFor(result.outcome), report: result.report }) + "\n");
        } else if (json) {
          process.stdout.write(JSON.stringify({ report: result.report, outcome: result.outcome }) + "\n");
        }

        if (!json) {
          // The Web's per-task token line, at last also in `run`.
          const tokens = tokenSummary(result.report.metrics);
          if (tokens) process.stdout.write(`${tokens}\n`);
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
    .description("list bundled starter skills and every detected skill (workspace + global)");

  const printSkills = async (cwd: string): Promise<void> => {
    const listing = await listSkills({ workspaceRoot: cwd });
    process.stdout.write(`${formatSkillsListing(listing)}\n`);
  };

  skillsCommand.action(async () => {
    await printSkills(process.cwd());
  });

  skillsCommand
    .command("list")
    .description("show bundled starter skills, all detected skills with their origin, and the directories searched")
    .option("--cwd <path>", "workspace directory", process.cwd())
    .action(async (options: { cwd: string }) => {
      await printSkills(options.cwd);
    });

  skillsCommand
    .command("install")
    .description("copy bundled starter skills into <workspace>/.daedalus/skills/ (or the global skills directory with --global)")
    .argument("[names...]", "bundled skill names to install")
    .option("--all", "install every bundled skill", false)
    .option("--global", "install into the global skills directory (~/.daedalus/skills) so the skills are available in every workspace", false)
    .option("--force", "overwrite an already-installed skill with the same name", false)
    .option("--cwd <path>", "workspace directory", process.cwd())
    .action(async (names: string[], options: { all?: boolean; global?: boolean; force?: boolean; cwd: string }) => {
      try {
        const result = await installBundledSkills({
          workspaceRoot: options.cwd,
          names,
          all: options.all === true,
          global: options.global === true,
          force: options.force === true,
        });
        for (const name of result.installed) process.stdout.write(`installed ${name} -> ${result.targetDir}\n`);
        for (const skipped of result.skipped) process.stdout.write(`skipped ${skipped.name}: ${skipped.reason}\n`);
        if (result.installed.length === 0 && result.skipped.length > 0) process.exitCode = 1;
      } catch (error) {
        process.stderr.write(`${paint(palette.error, `Error: ${String(error)}`)}\n`);
        process.exitCode = 1;
      }
    });

  skillsCommand
    .command("enable")
    .description("enable a skill for this workspace (writes .daedalus/skills.json, shared with the Web)")
    .argument("<name>", "skill name to enable")
    .option("--cwd <path>", "workspace directory", process.cwd())
    .action(async (name: string, options: { cwd: string }) => {
      try {
        const result = await setSkillDisabledForWorkspace(options.cwd, name, false);
        process.stdout.write(`skill "${result.name}" enabled for ${options.cwd} (disabled now: ${result.disabledSkills.join(", ") || "none"})\n`);
      } catch (error) {
        process.stderr.write(`${paint(palette.error, `Error: ${String(error)}`)}\n`);
        process.exitCode = 1;
      }
    });

  skillsCommand
    .command("disable")
    .description("disable a skill for this workspace (writes .daedalus/skills.json, shared with the Web)")
    .argument("<name>", "skill name to disable")
    .option("--cwd <path>", "workspace directory", process.cwd())
    .action(async (name: string, options: { cwd: string }) => {
      try {
        const result = await setSkillDisabledForWorkspace(options.cwd, name, true);
        process.stdout.write(`skill "${result.name}" disabled for ${options.cwd} (disabled now: ${result.disabledSkills.join(", ") || "none"})\n`);
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
