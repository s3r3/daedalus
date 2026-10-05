import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";
import {
  EventBus,
  TaskStore,
  TaskRunner,
  createLogger,
  loadSettings,
  type Event,
  type FinalReport,
  type PermissionKey,
} from "@daedalus/core";
import { collectRoots, listDirectory, buildTree, resolveInside, MAX_FILE_BYTES } from "./workspace.ts";

/**
 * REST + WebSocket gateway (PLAN.md §3.0, §3.6). Commands and reads only —
 * no agent, tool, or LLM logic lives here; the core owns execution.
 */

export type AppContext = {
  bus: EventBus;
  store: TaskStore;
  log: ReturnType<typeof createLogger>;
  startedAt: number;
  cwd: string;
  activeRunners: Map<string, TaskRunner>;
};

export function createContext(overrides: Partial<AppContext> = {}): AppContext {
  const settings = loadSettings();
  return {
    bus: overrides.bus ?? new EventBus(),
    store: overrides.store ?? new TaskStore(settings.daedalusHome),
    log: overrides.log ?? createLogger({ base: { service: "daedalus-server" } }),
    startedAt: overrides.startedAt ?? Date.now(),
    cwd: overrides.cwd ?? process.cwd(),
    activeRunners: overrides.activeRunners ?? new Map<string, TaskRunner>(),
  };
}

const CORS_HEADERS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, POST, PUT, DELETE, OPTIONS",
  "access-control-allow-headers": "content-type, authorization",
};

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const data = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "content-length": Buffer.byteLength(data), ...CORS_HEADERS });
  res.end(data);
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolveBody, rejectBody) => {
    let body = "";
    req.on("data", (chunk: Buffer) => {
      body += chunk.toString("utf8");
    });
    req.on("end", () => resolveBody(body));
    req.on("error", rejectBody);
  });
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown> | undefined> {
  try {
    const parsed: unknown = JSON.parse((await readBody(req)) || "{}");
    return typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}

export function createApp(ctx: AppContext) {
  return createServer((req, res) => {
    const requestId = crypto.randomUUID();
    const url = new URL(req.url ?? "/", "http://localhost");
    const method = req.method ?? "GET";

    if (method === "OPTIONS") {
      res.writeHead(204, CORS_HEADERS);
      res.end();
      return;
    }

    if (method === "GET" && url.pathname === "/health") {
      sendJson(res, 200, {
        status: "ok",
        service: "daedalus-server",
        uptime_ms: Date.now() - ctx.startedAt,
        active_tasks: ctx.activeRunners.size,
        request_id: requestId,
      });
      return;
    }

    if (method === "GET" && url.pathname === "/tasks") {
      const tasks = ctx.store.listTasks().map((id) => summarize(ctx, id));
      sendJson(res, 200, { tasks, count: tasks.length });
      return;
    }

    if (method === "POST" && url.pathname === "/tasks") {
      void (async () => {
        const parsed = await readJson(req);
        if (!parsed) {
          sendJson(res, 400, { error: "invalid_json", request_id: requestId });
          return;
        }
        const goal = typeof parsed.goal === "string" ? parsed.goal.trim() : "";
        if (goal === "") {
          sendJson(res, 400, { error: "goal_required", request_id: requestId });
          return;
        }

        const taskId = crypto.randomUUID();
        const repoPath = typeof parsed.repo_path === "string" && parsed.repo_path.length > 0 ? resolveInside(ctx.cwd, parsed.repo_path) : ctx.cwd;
        const autoApprove = parsed.auto_approve === true;
        const maxIterations = typeof parsed.max_iterations === "number" ? parsed.max_iterations : 25;

        const runner = new TaskRunner({
          workspaceRoot: repoPath,
          approvalPolicy: autoApprove ? "auto" : "ask",
          maxIterations,
          bus: ctx.bus,
          store: ctx.store,
        });
        ctx.activeRunners.set(taskId, runner);

        const task = {
          id: taskId,
          goal,
          repo_path: repoPath,
          constraints: stringList(parsed.constraints),
          done_criteria: stringList(parsed.done_criteria),
          created_at: new Date().toISOString(),
        };
        ctx.store.saveState(taskId, {
          ...task,
          plan: { id: `${taskId}-plan`, task_id: taskId, steps: [], version: 0, status: "draft" },
          steps: [],
          status: "created",
        });
        ctx.log.info("task created", { task_id: taskId, request_id: requestId, repo_path: repoPath });

        runner
          .run({ goal, taskId })
          .then((result) => ctx.log.info("task finished", { task_id: taskId, outcome: result.outcome }))
          .catch((error: unknown) => ctx.log.error("task run error", { task_id: taskId, error: String(error) }))
          .finally(() => ctx.activeRunners.delete(taskId));

        sendJson(res, 201, task);
      })();
      return;
    }

    const approveMatch = /^\/tasks\/([^/]+)\/approve$/.exec(url.pathname);
    if (method === "POST" && approveMatch?.[1] !== undefined) {
      void (async () => {
        const taskId = approveMatch[1] as string;
        const parsed = await readJson(req);
        if (!parsed) {
          sendJson(res, 400, { error: "invalid_json" });
          return;
        }
        const decision = parsed.decision === "grant" ? "grant" : "deny";
        const remember = parsed.remember === true;
        const runner = ctx.activeRunners.get(taskId);
        if (!runner) {
          sendJson(res, 404, { error: "runner_not_found" });
          return;
        }
        const key = parsed.key as PermissionKey | undefined;
        if (key) {
          const success = runner.approvals.decide(key, decision, remember);
          sendJson(res, 200, { success, decision, remember, key });
          return;
        }
        const pending = runner.approvals.pending(taskId)[0];
        if (!pending) {
          sendJson(res, 200, { success: false, reason: "no_pending_approval" });
          return;
        }
        const success = runner.approvals.decide(pending.key, decision, remember);
        sendJson(res, 200, { success, decision, remember, key: pending.key });
      })();
      return;
    }

    const cancelMatch = /^\/tasks\/([^/]+)\/cancel$/.exec(url.pathname);
    if (method === "POST" && cancelMatch?.[1] !== undefined) {
      const taskId = cancelMatch[1] as string;
      const runner = ctx.activeRunners.get(taskId);
      ctx.store.requestCancel(taskId);
      runner?.cancel(taskId);
      sendJson(res, 200, { cancelled: runner !== undefined, task_id: taskId });
      return;
    }

    const reportMatch = /^\/tasks\/([^/]+)\/report$/.exec(url.pathname);
    if (method === "GET" && reportMatch?.[1] !== undefined) {
      const report = ctx.store.loadReport<FinalReport>(reportMatch[1] as string);
      if (!report) {
        sendJson(res, 404, { error: "report_not_found" });
        return;
      }
      sendJson(res, 200, { report });
      return;
    }

    const changesMatch = /^\/tasks\/([^/]+)\/changes$/.exec(url.pathname);
    if (method === "GET" && changesMatch?.[1] !== undefined) {
      const changes = ctx.store
        .replay(changesMatch[1] as string)
        .filter((event) => event.type === "FILE_CHANGED")
        .map((event) => event.payload);
      sendJson(res, 200, { changes, count: changes.length });
      return;
    }

    const taskMatch = /^\/tasks\/([^/]+)$/.exec(url.pathname);
    if (method === "GET" && taskMatch?.[1] !== undefined) {
      const taskId = taskMatch[1] as string;
      const state = ctx.store.loadState(taskId);
      if (state === undefined) {
        sendJson(res, 404, { error: "not_found", request_id: requestId });
        return;
      }
      sendJson(res, 200, {
        state,
        events: ctx.store.replay(taskId),
        report: ctx.store.loadReport<FinalReport>(taskId) ?? null,
        running: ctx.activeRunners.has(taskId),
      });
      return;
    }

    if (method === "GET" && url.pathname === "/workspace/roots") {
      sendJson(res, 200, { roots: collectRoots(ctx.cwd, recordedRoots(ctx)), cwd: ctx.cwd });
      return;
    }

    if (method === "GET" && url.pathname === "/workspace/tree") {
      const root = url.searchParams.get("root") || ctx.cwd;
      const path = url.searchParams.get("path") || ".";
      const depth = clampDepth(url.searchParams.get("depth"));
      try {
        sendJson(res, 200, buildTree(root, path, depth));
      } catch (error) {
        sendJson(res, 400, { error: errorMessage(error) });
      }
      return;
    }

    if (method === "GET" && url.pathname === "/workspace/list") {
      const root = url.searchParams.get("root") || ctx.cwd;
      const path = url.searchParams.get("path") || ".";
      try {
        sendJson(res, 200, { path, items: listDirectory(root, path) });
      } catch (error) {
        sendJson(res, 400, { error: errorMessage(error) });
      }
      return;
    }

    if (method === "GET" && url.pathname === "/workspace/file") {
      const root = url.searchParams.get("root") || ctx.cwd;
      const targetRel = url.searchParams.get("path") || "";
      if (!targetRel) {
        sendJson(res, 400, { error: "path_required" });
        return;
      }
      try {
        const absolute = resolveInside(root, targetRel);
        const stat = statSync(absolute);
        if (stat.isDirectory()) {
          sendJson(res, 400, { error: "path_is_directory" });
          return;
        }
        if (stat.size > MAX_FILE_BYTES) {
          sendJson(res, 413, { error: "file_too_large", size: stat.size, limit: MAX_FILE_BYTES });
          return;
        }
        sendJson(res, 200, { path: targetRel, content: readFileSync(absolute, "utf8"), size: stat.size });
      } catch (error) {
        sendJson(res, 404, { error: errorMessage(error) });
      }
      return;
    }

    sendJson(res, 404, { error: "not_found", request_id: requestId });
  });
}

function summarize(ctx: AppContext, taskId: string): Record<string, unknown> {
  const state = ctx.store.loadState<Record<string, unknown>>(taskId);
  const events = ctx.store.replay(taskId);
  const last = events.at(-1);
  return {
    id: taskId,
    goal: typeof state?.goal === "string" ? state.goal : (state?.spec as { goal?: string } | undefined)?.goal,
    repo_path: state?.repo_path ?? (state?.spec as { repo_path?: string } | undefined)?.repo_path,
    status: typeof state?.status === "string" ? state.status : "unknown",
    event_count: events.length,
    last_seq: last?.seq ?? 0,
    last_event: last?.type ?? null,
    updated_at: last?.ts ?? null,
    running: ctx.activeRunners.has(taskId),
  };
}

function recordedRoots(ctx: AppContext): string[] {
  return ctx.store
    .listTasks()
    .map((id) => {
      const state = ctx.store.loadState<Record<string, unknown>>(id);
      const direct = state?.repo_path;
      const nested = (state?.spec as { repo_path?: string } | undefined)?.repo_path;
      return typeof direct === "string" ? direct : typeof nested === "string" ? nested : undefined;
    })
    .filter((value): value is string => typeof value === "string");
}

function stringList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function clampDepth(value: string | null): number {
  const parsed = Number.parseInt(value ?? "2", 10);
  if (Number.isNaN(parsed)) return 2;
  return Math.min(4, Math.max(1, parsed));
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export { attachWebSocket } from "./events.ts";
export type { Event } from "@daedalus/core";