// Detect local coding-agent CLIs on PATH and drive them non-interactively.
// Ported/trimmed from nexu-io/html-anything (cli/src/agents-detect.ts +
// agents-invoke.ts): pure filesystem PATH scan (no --version spawn), plus a
// per-agent argv builder for headless, permission-bypassed invocation.

import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AgentToolCall } from "./agentActivity";
import type { DetectedAgent, Engine } from "./types";

interface AgentDef {
  id: string;
  label: string;
  bin: string;
  fallbackBins?: string[];
  envOverride?: string;
  vendor: string;
  /** engine id used by the pipeline to drive text stages via this CLI */
  engine: Engine;
}

// Only the three stdin/argv agents this app supports as orchestrators.
export const AGENTS: AgentDef[] = [
  { id: "codex", label: "Codex", bin: "codex", envOverride: "CODEX_BIN", vendor: "OpenAI", engine: "codex-cli" },
  { id: "claude", label: "Claude Code", bin: "claude", fallbackBins: ["openclaude"], envOverride: "CLAUDE_BIN", vendor: "Anthropic", engine: "claude-cli" },
  { id: "gemini", label: "Gemini CLI", bin: "gemini", envOverride: "GEMINI_BIN", vendor: "Google", engine: "gemini-cli" },
];

// Agent executables are runtime inputs, not application dependencies. Resolve
// existsSync indirectly so Next's standalone tracer does not try to copy every
// build-runner toolchain directory (which also breaks across Windows drives).
const existsAtRuntime = (candidate: string): boolean => {
  const existsSync = Reflect.get(fs, "existsSync") as (path: fs.PathLike) => boolean;
  return existsSync(candidate);
};

function userToolchainDirs(): string[] {
  const home = os.homedir();
  const dirs = [
    process.env.VP_HOME && path.join(process.env.VP_HOME, "bin"),
    process.env.NPM_CONFIG_PREFIX && path.join(process.env.NPM_CONFIG_PREFIX, "bin"),
    path.join(home, ".local", "bin"),
    path.join(home, ".bun", "bin"),
    path.join(home, ".volta", "bin"),
    path.join(home, ".asdf", "shims"),
    path.join(home, "Library", "pnpm"),
    path.join(home, ".cargo", "bin"),
    path.join(home, ".npm-global", "bin"),
    path.join(home, ".claude", "local"),
    path.join(home, ".superset", "bin"),
    "/opt/homebrew/bin",
    "/usr/local/bin",
  ].filter(Boolean) as string[];
  return dirs;
}

export function resolveOnPath(bin: string): string | null {
  const isWin = process.platform === "win32";
  const exts = isWin ? (process.env.PATHEXT ?? ".EXE;.CMD;.BAT").split(";") : [""];
  const pathDirs = (process.env.PATH ?? "").split(path.delimiter).filter(Boolean);
  const dirs = Array.from(new Set([...pathDirs, ...userToolchainDirs()]));
  for (const dir of dirs) {
    for (const ext of exts) {
      const candidate = path.join(dir, bin + ext);
      try {
        if (existsAtRuntime(candidate)) return candidate;
      } catch {
        /* ignore */
      }
    }
  }
  return null;
}

function resolveAgent(def: AgentDef): { path: string | null } {
  if (def.envOverride && process.env[def.envOverride]) {
    const override = process.env[def.envOverride]!;
    if (existsAtRuntime(override)) return { path: override };
    const r = resolveOnPath(override);
    if (r) return { path: r };
  }
  for (const bin of [def.bin, ...(def.fallbackBins ?? [])]) {
    const r = resolveOnPath(bin);
    if (r) return { path: r };
  }
  return { path: null };
}

export function detectAgents(): DetectedAgent[] {
  return AGENTS.map((def) => {
    const { path: p } = resolveAgent(def);
    return {
      id: def.id,
      label: def.label,
      vendor: def.vendor,
      bin: def.bin,
      available: Boolean(p),
      path: p ?? undefined,
      supported: true,
    };
  });
}

export function agentForEngine(engine: Engine): AgentDef | undefined {
  return AGENTS.find((a) => a.engine === engine);
}

// ---- non-interactive invocation ----------------------------------------

function buildArgv(def: AgentDef, prompt: string, model?: string): string[] {
  const m = model ? [] : []; // model selection left to CLI defaults for the MVP
  switch (def.id) {
    case "claude":
      return ["-p", prompt, "--output-format", "json", "--permission-mode", "bypassPermissions", ...m];
    case "codex":
      return [
        "exec",
        "--json",
        "--skip-git-repo-check",
        "--sandbox",
        "workspace-write",
        "-c",
        "sandbox_workspace_write.network_access=true",
        ...m,
        prompt,
      ];
    case "gemini":
      return ["--output-format", "json", "--yolo", "-p", prompt, ...m];
    default:
      return [prompt];
  }
}

function extractTextFromStdout(agentId: string, stdout: string): string {
  const lines = stdout.split("\n").map((l) => l.trim()).filter(Boolean);
  if (agentId === "claude") {
    // single JSON object with a `result` string
    for (const raw of lines) {
      try {
        const o = JSON.parse(raw);
        if (typeof o?.result === "string" && o.result.trim()) return o.result.trim();
      } catch {
        /* not this line */
      }
    }
  }
  if (agentId === "gemini") {
    for (const raw of lines) {
      try {
        const o = JSON.parse(raw);
        const t = o?.response ?? o?.result ?? o?.text;
        if (typeof t === "string" && t.trim()) return t.trim();
      } catch {
        /* ignore */
      }
    }
  }
  if (agentId === "codex") {
    // JSONL stream — take the last non-empty assistant/agent message text
    let text = "";
    for (const raw of lines) {
      let o: any;
      try {
        o = JSON.parse(raw);
      } catch {
        continue;
      }
      const item = o?.item ?? o?.msg ?? o;
      const candidates = [
        item?.text,
        item?.message,
        o?.item?.text,
        o?.msg?.message,
      ];
      const type = item?.type ?? o?.type ?? "";
      if (/assistant_message|agent_message/.test(String(type))) {
        for (const c of candidates) if (typeof c === "string" && c.trim()) text = c.trim();
      }
    }
    if (text) return text;
  }
  // Fallback: whole stdout if it does not look like JSON noise
  const joined = stdout.trim();
  if (joined && !joined.startsWith("{") && !joined.startsWith("[")) return joined;
  return "";
}

function compactJson(value: unknown): string | undefined {
  if (value == null || value === "") return undefined;
  let text: string;
  if (typeof value === "string") text = value;
  else {
    try {
      text = JSON.stringify(value, null, 2);
    } catch {
      text = String(value);
    }
  }
  return text.length > 24_000 ? `${text.slice(0, 24_000)}\n…` : text;
}

/** Capture the CLI's real tool events so the chat can render Bash/read/edit rows. */
export function extractToolActivities(agentId: string, stdout: string): AgentToolCall[] {
  if (agentId !== "codex") return [];
  const activities = new Map<string, AgentToolCall>();
  const lines = stdout.split("\n").map((line) => line.trim()).filter(Boolean);

  for (let index = 0; index < lines.length; index += 1) {
    let event: any;
    try {
      event = JSON.parse(lines[index]);
    } catch {
      continue;
    }
    const item = event?.item ?? event?.msg;
    const itemType = String(item?.type ?? "").toLowerCase();
    if (!itemType) continue;
    const id = String(item?.id ?? `${itemType}-${index}`);
    const completed = /completed|done/.test(String(event?.type ?? ""))
      || /completed|done|success|failed/.test(String(item?.status ?? ""));
    const exitCode = Number.isFinite(Number(item?.exit_code)) ? Number(item.exit_code) : undefined;
    const state: AgentToolCall["state"] = exitCode != null && exitCode !== 0
      ? "error"
      : completed
        ? "complete"
        : "running";

    if (/command_execution|shell_command|terminal/.test(itemType)) {
      const command = Array.isArray(item?.command)
        ? item.command.join(" ")
        : String(item?.command ?? item?.input?.command ?? "").trim();
      activities.set(id, {
        id,
        name: "bash",
        kind: "bash",
        label: "Run command",
        detail: exitCode == null ? undefined : `exit ${exitCode}`,
        command: command || undefined,
        output: compactJson(item?.aggregated_output ?? item?.output),
        state,
      });
      continue;
    }

    if (/file_change|file_edit|apply_patch/.test(itemType)) {
      const changes = Array.isArray(item?.changes) ? item.changes : [];
      const firstPath = String(changes[0]?.path ?? item?.path ?? "").trim();
      activities.set(id, {
        id,
        name: itemType,
        kind: "edit",
        label: "Edit files",
        detail: changes.length ? `${changes.length} file${changes.length === 1 ? "" : "s"}` : undefined,
        path: firstPath || undefined,
        output: compactJson(changes.length ? changes : item?.output),
        state,
      });
      continue;
    }

    if (/web_search|search/.test(itemType)) {
      activities.set(id, {
        id,
        name: itemType,
        kind: "search",
        label: "Search",
        detail: String(item?.query ?? item?.input?.query ?? "").trim() || undefined,
        output: compactJson(item?.output ?? item?.results),
        state,
      });
      continue;
    }

    if (/todo|task_list/.test(itemType)) {
      const rawTodos = Array.isArray(item?.todos) ? item.todos : Array.isArray(item?.items) ? item.items : [];
      activities.set(id, {
        id,
        name: itemType,
        kind: "todo",
        label: "Task list",
        todos: rawTodos.map((todo: any, todoIndex: number) => ({
          id: String(todo?.id ?? `todo-${todoIndex}`),
          content: String(todo?.content ?? todo?.text ?? todo?.title ?? ""),
          status: ["pending", "in_progress", "complete", "error"].includes(todo?.status)
            ? todo.status
            : "pending",
        })),
        state,
      });
      continue;
    }

    if (/tool_call|mcp/.test(itemType)) {
      activities.set(id, {
        id,
        name: String(item?.name ?? item?.tool_name ?? itemType),
        kind: "tool",
        label: "Use tool",
        detail: compactJson(item?.input ?? item?.arguments),
        output: compactJson(item?.output ?? item?.result),
        state,
      });
    }
  }

  // The process has already exited when this parser runs; incomplete rows are
  // historical rather than genuinely live, so settle them as completed.
  return Array.from(activities.values()).map((activity) => (
    activity.state === "running" ? { ...activity, state: "complete" as const } : activity
  ));
}

export interface CliRunResult {
  text: string;
  agentPath: string;
  activities: AgentToolCall[];
}

/** Run a detected agent CLI with a prompt, returning its text output. */
export function runCliAgentText(
  engine: Engine,
  prompt: string,
  opts: { signal?: AbortSignal; timeoutMs?: number } = {},
): Promise<CliRunResult> {
  const def = agentForEngine(engine);
  if (!def) return Promise.reject(new Error(`Unknown engine: ${engine}`));
  const resolved = resolveAgent(def);
  if (!resolved.path) {
    return Promise.reject(new Error(`${def.label} (${def.bin}) not found on PATH`));
  }
  const argv = buildArgv(def, prompt);
  const { signal, timeoutMs = 240_000 } = opts;

  return new Promise<CliRunResult>((resolve, reject) => {
    const child = spawn(resolved.path!, argv, {
      env: { ...process.env, GEMINI_CLI_TRUST_WORKSPACE: "true" },
      stdio: ["ignore", "pipe", "pipe"],
      signal,
    });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
    child.stdout.on("data", (d) => (stdout += d.toString()));
    child.stderr.on("data", (d) => (stderr += d.toString()));
    child.on("error", (e) => {
      clearTimeout(timer);
      reject(e);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      const text = extractTextFromStdout(def.id, stdout);
      if (text) return resolve({
        text,
        agentPath: resolved.path!,
        activities: extractToolActivities(def.id, stdout),
      });
      reject(
        new Error(
          `${def.label} produced no usable text (exit ${code}). stderr: ${stderr.slice(0, 300)}`,
        ),
      );
    });
  });
}
