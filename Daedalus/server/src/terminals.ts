import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import type { Event } from "@daedalus/core";

/**
 * Interactive terminal sessions for the Web control plane.
 *
 * Two kinds share one tab strip:
 *  - `user` sessions are the human's own shells, spawned by the human and
 *    written to only by the human. A long-running process (`npm run dev`)
 *    stays alive indefinitely; nothing the agent does can write into,
 *    signal, or kill one of these.
 *  - `agent` sessions are read-only display sinks, one per workspace root.
 *    The harness' COMMAND_* events are mirrored into the buffer (`$ cmd`,
 *    streamed output, `[exit n]`) so the agent's command history survives
 *    across tasks. There is no process to write to, signal, or kill — the
 *    agent's commands keep their own harness timeouts; only user sessions
 *    are unbounded.
 *
 * Processes are pipe-mode children of the user's shell (no native PTY
 * dependency): line-based tools and dev servers work; full-screen TUIs
 * (vim, top) will not behave. Sessions live in the server process — they
 * survive Web page reloads and die on server shutdown.
 */

export const TERMINAL_BUFFER_CAP = 200_000;
const TRUNCATION_MARKER = "\n…[earlier terminal output truncated]\n";
const KILL_GRACE_MS = 1_500;

export type TerminalKind = "user" | "agent";
export type TerminalStatus = "running" | "exited";

export type TerminalSessionInfo = {
  id: string;
  kind: TerminalKind;
  title: string;
  /** Workspace root the session is anchored to (its cwd at spawn). */
  cwd: string;
  status: TerminalStatus;
  exitCode: number | null;
  pid: number | null;
  createdAt: string;
};

export type TerminalWireMessage =
  | { kind: "terminal_output"; session_id: string; data: string; replay?: boolean }
  | { kind: "terminal_status"; session: TerminalSessionInfo };

/** Endpoint failures with an HTTP status the route can pass through. */
export class TerminalError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = "TerminalError";
    this.status = status;
  }
}

type Session = TerminalSessionInfo & {
  buffer: string;
  child?: ChildProcess;
  killTimer?: ReturnType<typeof setTimeout>;
  /** Closed via DELETE: process killed, session forgotten, no more broadcasts. */
  forgotten?: boolean;
};

export function shellCommand(): string {
  return process.env.SHELL || "bash";
}

/** Keep the newest output under the cap, marking where the head was dropped. */
export function capTerminalBuffer(buffer: string, cap = TERMINAL_BUFFER_CAP): string {
  if (buffer.length <= cap) return buffer;
  return TRUNCATION_MARKER + buffer.slice(-(cap - TRUNCATION_MARKER.length));
}

export class TerminalManager {
  #sessions = new Map<string, Session>();
  #agentByRoot = new Map<string, string>();
  #userCounter = new Map<string, number>();
  #listeners = new Set<(message: TerminalWireMessage) => void>();
  #attachedBus: object | null = null;

  /** Live session/output feed — the WS channel forwards these to browsers. */
  onMessage(listener: (message: TerminalWireMessage) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  /** All sessions for a workspace root, agent first; ensures the agent sink exists. */
  list(root: string): TerminalSessionInfo[] {
    const agent = this.ensureAgent(root);
    const mine = [...this.#sessions.values()].filter((session) => session.cwd === root);
    mine.sort((a, b) => (a.id === agent.id ? -1 : b.id === agent.id ? 1 : a.createdAt.localeCompare(b.createdAt)));
    return mine.map(toInfo);
  }

  get(id: string): TerminalSessionInfo | undefined {
    const session = this.#sessions.get(id);
    return session ? toInfo(session) : undefined;
  }

  /** Buffered output for replay (tab reopen, WS subscribe, tests). */
  output(id: string): string | undefined {
    return this.#sessions.get(id)?.buffer;
  }

  /** The read-only per-workspace agent sink, created lazily and reused. */
  ensureAgent(root: string): TerminalSessionInfo {
    const known = this.#agentByRoot.get(root);
    if (known) {
      const existing = this.#sessions.get(known);
      if (existing) return toInfo(existing);
    }
    const session: Session = {
      id: randomUUID(),
      kind: "agent",
      title: "agent",
      cwd: root,
      status: "running",
      exitCode: null,
      pid: null,
      createdAt: new Date().toISOString(),
      buffer: "",
    };
    this.#sessions.set(session.id, session);
    this.#agentByRoot.set(root, session.id);
    this.#broadcastStatus(session);
    return toInfo(session);
  }

  create(input: { root: string; kind?: TerminalKind; title?: string }): TerminalSessionInfo {
    if (input.kind === "agent") return this.ensureAgent(input.root);
    const n = (this.#userCounter.get(input.root) ?? 0) + 1;
    this.#userCounter.set(input.root, n);
    const shell = shellCommand();
    const child = spawn(shell, [], {
      cwd: input.root,
      env: { ...process.env, TERM: "xterm-256color", FORCE_COLOR: "1" },
      stdio: ["pipe", "pipe", "pipe"],
      detached: true,
    });
    const session: Session = {
      id: randomUUID(),
      kind: "user",
      title: input.title?.trim() || `shell ${n}`,
      cwd: input.root,
      status: "running",
      exitCode: null,
      pid: child.pid ?? null,
      createdAt: new Date().toISOString(),
      buffer: "",
      child,
    };
    this.#sessions.set(session.id, session);
    const consume = (chunk: Buffer): void => this.#append(session, chunk.toString());
    child.stdout?.on("data", consume);
    child.stderr?.on("data", consume);
    child.on("error", (error) => {
      this.#append(session, `\n[failed to start shell: ${String(error)}]\n`);
      this.#markExited(session, null);
    });
    child.on("close", (code) => this.#markExited(session, code));
    this.#broadcastStatus(session);
    return toInfo(session);
  }

  /**
   * Write raw input (a submitted line, a pasted block) to a user session.
   * The line is echoed into the buffer first — a pipe has no tty echo, and
   * the replayed history should read like a terminal transcript.
   */
  writeInput(id: string, data: string): TerminalSessionInfo {
    const session = this.#require(id);
    if (session.kind === "agent") throw new TerminalError(403, "agent terminal is read-only");
    if (session.status !== "running" || !session.child?.stdin?.writable) {
      throw new TerminalError(409, "terminal session has exited");
    }
    this.#append(session, data);
    session.child.stdin.write(data);
    return toInfo(session);
  }

  signal(id: string, signal: "SIGINT" | "SIGTERM"): TerminalSessionInfo {
    const session = this.#require(id);
    if (session.kind === "agent") throw new TerminalError(403, "agent terminal is read-only");
    if (session.status !== "running" || !session.child) throw new TerminalError(409, "terminal session has exited");
    signalProcess(session, signal);
    return toInfo(session);
  }

  /**
   * DELETE: kill a user session (SIGTERM, then SIGKILL after a grace) and
   * forget it — a closed tab never comes back. The response reports the
   * session as exited; natural exits instead stay listed as `exited` so
   * the human can restart them.
   */
  kill(id: string): TerminalSessionInfo {
    const session = this.#require(id);
    if (session.kind === "agent") throw new TerminalError(403, "agent terminal is read-only");
    this.#sessions.delete(id);
    session.forgotten = true;
    this.#terminate(session);
    return { ...toInfo(session), status: "exited" };
  }

  /** Mirror one harness command lifecycle into the workspace's agent sink. */
  agentCommandStarted(root: string, command: string): void {
    const session = this.#agentSession(root);
    if (session) this.#append(session, `$ ${command}\n`);
  }

  agentCommandOutput(root: string, chunk: string): void {
    const session = this.#agentSession(root);
    if (session) this.#append(session, chunk);
  }

  agentCommandFinished(root: string, exitCode: number | null, status: string): void {
    const session = this.#agentSession(root);
    if (!session) return;
    const prefix = session.buffer.length > 0 && !session.buffer.endsWith("\n") ? "\n" : "";
    this.#append(session, `${prefix}[exit ${exitCode ?? status}]\n`);
  }

  /**
   * Tap the core event bus: COMMAND_* events become the agent sink's
   * transcript. `resolveRoot` maps a task id to its workspace root (event
   * payloads do not carry it). Idempotent per bus so re-wiring an app on
   * the same context never double-mirrors.
   */
  attach(bus: { on: (type: "*", handler: (event: Event) => void) => unknown }, resolveRoot: (taskId: string) => string | undefined): void {
    if (this.#attachedBus === bus) return;
    this.#attachedBus = bus;
    bus.on("*", (event) => {
      if (event.type !== "COMMAND_STARTED" && event.type !== "COMMAND_OUTPUT" && event.type !== "COMMAND_FINISHED") return;
      const root = resolveRoot(event.task_id);
      if (!root) return;
      const payload = (event.payload ?? {}) as { command?: unknown; chunk?: unknown; exit_code?: unknown; status?: unknown };
      if (event.type === "COMMAND_STARTED" && typeof payload.command === "string") this.agentCommandStarted(root, payload.command);
      if (event.type === "COMMAND_OUTPUT" && typeof payload.chunk === "string") this.agentCommandOutput(root, payload.chunk);
      if (event.type === "COMMAND_FINISHED") {
        this.agentCommandFinished(root, typeof payload.exit_code === "number" ? payload.exit_code : null, typeof payload.status === "string" ? payload.status : "done");
      }
    });
  }

  /** Server shutdown: no session outlives the process. */
  dispose(): void {
    for (const session of [...this.#sessions.values()]) this.#terminate(session);
    this.#sessions.clear();
    this.#agentByRoot.clear();
    this.#listeners.clear();
  }

  #agentSession(root: string): Session | undefined {
    const info = this.ensureAgent(root);
    return this.#sessions.get(info.id);
  }

  #require(id: string): Session {
    const session = this.#sessions.get(id);
    if (!session) throw new TerminalError(404, "terminal session not found");
    return session;
  }

  #append(session: Session, data: string): void {
    if (data.length === 0) return;
    session.buffer = capTerminalBuffer(session.buffer + data);
    if (session.forgotten) return;
    const message: TerminalWireMessage = { kind: "terminal_output", session_id: session.id, data };
    for (const listener of [...this.#listeners]) listener(message);
  }

  #broadcastStatus(session: Session): void {
    if (session.forgotten) return;
    const message: TerminalWireMessage = { kind: "terminal_status", session: toInfo(session) };
    for (const listener of [...this.#listeners]) listener(message);
  }

  #markExited(session: Session, exitCode: number | null): void {
    if (session.status === "exited") return;
    session.status = "exited";
    session.exitCode = exitCode;
    if (session.killTimer) clearTimeout(session.killTimer);
    this.#append(session, `\n[process exited${exitCode === null ? "" : ` with code ${exitCode}`}]\n`);
    this.#broadcastStatus(session);
  }

  #terminate(session: Session): void {
    if (!session.child || session.status !== "running") return;
    signalProcess(session, "SIGTERM");
    session.killTimer = setTimeout(() => {
      if (session.status === "running") signalProcess(session, "SIGKILL");
    }, KILL_GRACE_MS);
    session.killTimer.unref?.();
  }
}

function toInfo(session: Session): TerminalSessionInfo {
  return {
    id: session.id,
    kind: session.kind,
    title: session.title,
    cwd: session.cwd,
    status: session.status,
    exitCode: session.exitCode,
    pid: session.pid,
    createdAt: session.createdAt,
  };
}

/** Signal the whole process group (dev servers spawn children of their own). */
function signalProcess(session: Session, signal: NodeJS.Signals): void {
  const pid = session.child?.pid;
  try {
    if (pid && process.platform !== "win32") process.kill(-pid, signal);
    else session.child?.kill(signal);
  } catch {
    try {
      session.child?.kill(signal);
    } catch {
      /* process already gone */
    }
  }
}
