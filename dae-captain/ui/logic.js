// Dae Captain UI — pure logic (no DOM, no Tauri globals).
// Unit-tested with node:test; safe to import in Node.

export const ENGINES = ["coding", "slide", "dokumen", "spreadsheet", "research"];

export const ENGINE_LABELS = {
  coding: "Coding",
  slide: "Slide",
  dokumen: "Dokumen",
  spreadsheet: "Spreadsheet",
  research: "Research",
};

export function engineLabel(engine) {
  return ENGINE_LABELS[engine] ?? engine;
}

/**
 * Aggregate island status from workflow runs.
 * - "attention": any pending approval/question (amber) — highest priority
 * - "working": any turn running (green)
 * - "idle": nothing (blue)
 */
export function aggregateStatus(runs) {
  let running = 0;
  let attention = 0;
  for (const run of runs ?? []) {
    for (const turn of run.turns ?? []) {
      if (turn.status === "running") running += 1;
      attention += (turn.pending_approvals ?? []).length;
      attention += (turn.pending_questions ?? []).length;
    }
  }
  if (attention > 0) return { status: "attention", running, attention };
  if (running > 0) return { status: "working", running, attention };
  return { status: "idle", running: 0, attention: 0 };
}

export function statusColor(status) {
  return status === "attention" ? "amber" : status === "working" ? "green" : "blue";
}

/** Compact pill text: "!" when attention needed, else running count. */
export function pillText(agg) {
  if (agg.status === "attention") return "!";
  if (agg.status === "working") return String(agg.running);
  return "";
}

/** One-line summary for a turn, for the engine pills row. */
export function turnSummary(turn) {
  const label = engineLabel(turn.engine);
  const goal = typeof turn.goal === "string" && turn.goal.length > 42
    ? turn.goal.slice(0, 42) + "…"
    : turn.goal ?? "";
  const detail = turn.live === "staged_awaiting_gate"
    ? "menunggu gate"
    : turn.last_event ?? turn.status;
  return { label, goal, detail, status: turn.status };
}

/** Human-readable lines for resolved artifacts shown before dispatch. */
export function formatResolvedArtifacts(resolved) {
  if (!Array.isArray(resolved) || resolved.length === 0) return [];
  return resolved.map((a) => {
    const label = a.label ?? a.kind ?? "artifact";
    const where = a.path ?? a.export_path ?? (a.report_id ? `report ${a.report_id}` : a.url ?? "");
    return where ? `${label} — ${where}` : label;
  });
}

/** Build the POST /tasks/:id/approve payload. Never invents a key. */
export function approvalPayload(approval, decision, remember = false) {
  if (decision !== "grant" && decision !== "deny") {
    throw new Error("decision must be grant|deny");
  }
  const payload = { decision, remember: remember === true };
  if (approval && typeof approval.key === "string" && approval.key) {
    payload.key = approval.key;
  }
  return payload;
}

/** Title line for an approval card. */
export function approvalTitle(taskId, turn, approval) {
  const engine = turn ? engineLabel(turn.engine) : "task";
  const tool = approval.tool ?? "approval";
  const key = approval.key ? ` · ${approval.key}` : "";
  return `${engine} · ${tool}${key} (task ${String(taskId).slice(0, 8)})`;
}

/** Chat message → POST /workflow/chat body. */
export function chatRequestBody({ message, runId, workspaceRoot, engineOverride }) {
  const body = { message, workspace_root: workspaceRoot };
  if (runId) body.run_id = runId;
  if (engineOverride) body.engine_override = engineOverride;
  return body;
}

/** Validate a chat response enough for the UI to render it. */
export function isClarifyResponse(res) {
  return res != null && res.needs_clarify === true && Array.isArray(res.options);
}

/**
 * Compare workspace paths the way the server does: the server resolves and
 * the UI may carry a trailing slash (e.g. from the folder picker).
 * Used to detect "server healthy but anchored to another workspace" (HTTP 403).
 */
export function normalizeWorkspacePath(p) {
  return String(p || "").replace(/\/+$/, "");
}

export function sameWorkspace(a, b) {
  const na = normalizeWorkspacePath(a);
  const nb = normalizeWorkspacePath(b);
  return na !== "" && na === nb;
}

/**
 * Render a caught rejection as text. Tauri's invoke() rejects with the RAW
 * error value (a plain string for Rust `Err(String)`), NOT an Error object —
 * so `e.message` is undefined and every message was swallowed. fetch-based
 * API calls reject with real Errors. Handle both.
 */
export function errText(e) {
  if (e == null) return "unknown error";
  if (typeof e === "string") return e || "unknown error";
  if (typeof e.message === "string" && e.message) return e.message;
  try {
    const j = JSON.stringify(e);
    return j && j !== "{}" ? j : String(e);
  } catch {
    return String(e);
  }
}

/**
 * Flatten every pending approval across runs into
 * [{ taskId, turn, approval }]. Used by "Approve All".
 */
export function pendingApprovals(runs) {
  const out = [];
  for (const run of runs ?? []) {
    for (const turn of run.turns ?? []) {
      for (const approval of turn.pending_approvals ?? []) {
        out.push({ taskId: turn.task_id, turn, approval });
      }
    }
  }
  return out;
}

/** Thinking-level tiers supported by PUT /settings (server THINKING_LEVELS). */
export const THINKING_LEVELS = ["off", "low", "medium", "high"];

/** Engines minus the disabled ones — drives the composer chips. */
export function enabledEngines(disabled) {
  const off = new Set(disabled ?? []);
  return ENGINES.filter((e) => !off.has(e));
}

/**
 * Whether `engine` may be switched off. Re-enabling is always fine;
 * switching off is blocked only when it would strand the user with zero
 * enabled engines (the router would clarify to an empty list).
 */
export function canDisableEngine(engine, disabled) {
  const off = new Set(disabled ?? []);
  if (!off.has(engine)) off.add(engine);
  else off.delete(engine);
  return enabledEngines([...off]).length > 0;
}

/** Trust dropdown value → session.autoApprove boolean (the backend is boolean-only). */
export function trustToAutoApprove(value) {
  return value === "auto";
}

export function autoApproveToTrust(autoApprove) {
  return autoApprove === true ? "auto" : "ask";
}

const QUEUE_BADGES = {
  running: "progress",
  done: "done",
  failed: "failed",
  cancelled: "cancelled",
};

/**
 * Queue row view-model for one workflow turn. Pure — the workflow view
 * renders rows from this. A running turn with pending approvals gets the
 * "approval" badge so its [Approve]/[Deny] buttons render.
 */
export function queueRow(turn) {
  const status = turn.status ?? "running";
  const approvals = turn.pending_approvals ?? [];
  const questions = turn.pending_questions ?? [];
  const badge = status === "running" && (approvals.length || questions.length)
    ? "approval"
    : (QUEUE_BADGES[status] ?? "progress");
  return {
    engine: turn.engine,
    label: engineLabel(turn.engine),
    goal: turn.goal ?? "",
    status,
    badge,
    approvals,
    questions,
    lastEvent: turn.last_event ?? null,
    note: turn.note ?? null,
    taskId: turn.task_id,
  };
}

/** Rows for every turn in a run, newest last (queue order). */
export function queueRows(run) {
  return (run?.turns ?? []).map(queueRow);
}

/**
 * Args for the Tauri `spawn_server` command.
 * NOTE: Tauri's #[tauri::command] maps argument names to camelCase BY DEFAULT,
 * so the Rust `repo_root: String` param must be sent as `repoRoot`.
 * (A previous "fix" sent `repo_root` and broke spawning — do not change back.)
 */
export function spawnServerArgs(repoRoot, workspace) {
  return { repoRoot, workspace };
}

/**
 * Summarize task events for the chat's live-activity view (thinking +
 * tool calls, like the web panel). Pure — the chat renders from this.
 * Returns { thoughts: string[], tools: [{ tool, status }] } in event order.
 */
export function summarizeTaskEvents(events) {
  const thoughts = [];
  const tools = new Map();
  for (const e of events ?? []) {
    const p = e?.payload ?? {};
    if (e?.type === "THOUGHT" && typeof p.text === "string" && p.text.trim()) {
      thoughts.push(p.text.trim().slice(0, 500));
    } else if (e?.type === "TOOL_CALL_STARTED" && p.call?.id) {
      tools.set(p.call.id, { tool: p.call.tool ?? "tool", status: "running" });
    } else if (e?.type === "TOOL_CALL_FINISHED" && p.call?.id) {
      const t = tools.get(p.call.id) ?? { tool: p.call.tool ?? "tool" };
      t.status = p.result?.status ?? "ok";
      tools.set(p.call.id, t);
    }
  }
  return { thoughts, tools: [...tools.values()] };
}
