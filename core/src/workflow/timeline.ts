import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type {
  ArtifactRef,
  RunContext,
  RunTurn,
  RunTurnStatus,
  WorkflowEngine,
} from "./types.ts";

/**
 * Dae Captain event timeline (v2, Fase 1).
 *
 * ONE timeline per run replaces the separate chat history and task-turn
 * history. Eight event types, no per-tool-call noise:
 *
 *   user        – a message from the user
 *   agent       – a message from Dae Captain
 *   task_start  – a task dispatched to one of the five engines
 *   task_end    – that task finished (done / failed / cancelled)
 *   file        – a file was created / modified / deleted (path + name only)
 *   verify      – a deterministic verify gate ran (ok / fail + reason)
 *   approval    – an approval was requested / granted / denied
 *   workspace   – the active workspace changed
 *   error       – something failed outside a task
 *
 * Every event is persisted as JSON (cheap), so the timeline survives
 * restarts. Consumers feeding a model call `buildModelContext()`: the last
 * 20 events verbatim plus a deterministic one-paragraph summary of the
 * older events (template-built — no LLM involved).
 */

export const TIMELINE_EVENT_TYPES = [
  "user",
  "agent",
  "task_start",
  "task_end",
  "file",
  "verify",
  "approval",
  "workspace",
  "error",
] as const;

export type TimelineEventType = (typeof TIMELINE_EVENT_TYPES)[number];

export function isTimelineEventType(value: unknown): value is TimelineEventType {
  return (
    typeof value === "string" &&
    (TIMELINE_EVENT_TYPES as readonly string[]).includes(value)
  );
}

export type FileAction = "created" | "modified" | "deleted";
export type VerifyResult = "ok" | "fail";
export type TimelineApprovalDecision = "requested" | "granted" | "denied";

export type TimelineEventPayload = {
  user: { text: string };
  agent: {
    text: string;
    /**
     * Optional machine-readable marker. Fase 4 reminders reuse the `agent`
     * type so the 8-type schema stays fixed: `reminder_created` when a
     * reminder is scheduled, `reminder_due` when it fires. Unset for
     * ordinary agent messages.
     */
    kind?: "reminder_created" | "reminder_due";
    /** Reminder id this event refers to (set when `kind` is set). */
    reminderId?: string;
  };
  task_start: {
    engine: WorkflowEngine;
    task_id: string;
    goal: string;
    note?: string;
  };
  task_end: {
    engine: WorkflowEngine;
    task_id: string;
    goal: string;
    status: RunTurnStatus;
    artifacts?: ArtifactRef[];
    note?: string;
  };
  file: { action: FileAction; path: string; name: string };
  verify: { result: VerifyResult; reason: string; task_id?: string };
  approval: { decision: TimelineApprovalDecision; summary: string; task_id?: string };
  workspace: { change: string; workspace_root?: string };
  error: { message: string; task_id?: string };
};

export type TimelineEvent<T extends TimelineEventType = TimelineEventType> = {
  id: string;
  timestamp: string;
  run_id: string;
  type: T;
  payload: TimelineEventPayload[T];
};

/** Any one timeline event — the discriminated union over all 8 types. */
export type AnyTimelineEvent = {
  [K in TimelineEventType]: TimelineEvent<K>;
}[TimelineEventType];

/** Runtime shape check for one event; corrupt entries are dropped on load. */
export function isTimelineEvent(value: unknown): value is AnyTimelineEvent {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.id === "string" &&
    typeof v.timestamp === "string" &&
    typeof v.run_id === "string" &&
    isTimelineEventType(v.type) &&
    typeof v.payload === "object" &&
    v.payload !== null
  );
}

/** Build one event (not appended). Timestamps are caller-settable for migration. */
export function createEvent<T extends TimelineEventType>(
  runId: string,
  type: T,
  payload: TimelineEventPayload[T],
  opts?: { id?: string; timestamp?: string },
): TimelineEvent<T> {
  return {
    id: opts?.id ?? randomUUID(),
    timestamp: opts?.timestamp ?? new Date().toISOString(),
    run_id: runId,
    type,
    payload,
  };
}

/**
 * Append an event to a run's timeline. Returns the appended event.
 * Keeps the deprecated `run.turns` view in sync when task events change.
 */
export function appendEvent<T extends TimelineEventType>(
  run: RunContext,
  type: T,
  payload: TimelineEventPayload[T],
): TimelineEvent<T> {
  const event = createEvent(run.run_id, type, payload);
  // T is one of the 8 types at runtime; the cast bridges the generic.
  run.events.push(event as AnyTimelineEvent);
  if (type === "task_start" || type === "task_end") syncTurns(run);
  run.updated_at = event.timestamp;
  return event;
}

/** All events in order (oldest first). Returns a copy. */
export function getEvents(run: RunContext): AnyTimelineEvent[] {
  return [...run.events];
}

/** The last `n` events in order (oldest first). `n` <= 0 returns []. */
export function getRecentEvents(run: RunContext, n: number): AnyTimelineEvent[] {
  if (n <= 0) return [];
  return run.events.slice(-n);
}

// ---------------------------------------------------------------------------
// Model context: last N verbatim + deterministic summary of the rest.
// ---------------------------------------------------------------------------

/** How many recent events ride verbatim into the model prompt. */
export const MODEL_CONTEXT_RECENT_DEFAULT = 20;

export type ModelContext = {
  /** The most recent events, verbatim, oldest first. */
  recent: AnyTimelineEvent[];
  /**
   * Deterministic one-paragraph summary of the events older than `recent`.
   * Empty string when there is nothing older.
   */
  summary: string;
};

/**
 * Build what the model sees: the last `recentCount` events verbatim plus a
 * template-built summary of everything older. The summary counts events per
 * type and names the important tasks and files — never calls an LLM.
 */
export function buildModelContext(
  run: RunContext,
  opts?: { recentCount?: number },
): ModelContext {
  const recentCount = Math.max(0, opts?.recentCount ?? MODEL_CONTEXT_RECENT_DEFAULT);
  const recent = getRecentEvents(run, recentCount);
  const older =
    recentCount === 0 ? getEvents(run) : run.events.slice(0, -recentCount);
  return { recent, summary: summarizeEvents(older) };
}

const PLURAL: Record<TimelineEventType, [string, string]> = {
  user: ["user message", "user messages"],
  agent: ["agent reply", "agent replies"],
  task_start: ["task started", "tasks started"],
  task_end: ["task ended", "tasks ended"],
  file: ["file change", "file changes"],
  verify: ["verification", "verifications"],
  approval: ["approval", "approvals"],
  workspace: ["workspace change", "workspace changes"],
  error: ["error", "errors"],
};

function plural(type: TimelineEventType, count: number): string {
  const [one, many] = PLURAL[type];
  return `${count} ${count === 1 ? one : many}`;
}

/** One deterministic paragraph describing `events` (already oldest-first). */
function summarizeEvents(events: AnyTimelineEvent[]): string {
  if (events.length === 0) return "";
  const counts = new Map<TimelineEventType, number>();
  for (const e of events) counts.set(e.type, (counts.get(e.type) ?? 0) + 1);
  const parts: string[] = [
    `Earlier in this run (${events.length} events):`,
  ];
  for (const type of TIMELINE_EVENT_TYPES) {
    const c = counts.get(type);
    if (c) parts.push(plural(type, c));
  }

  // Name the important tasks (latest state wins).
  const taskState = new Map<string, { engine: string; goal: string; status: string }>();
  for (const e of events) {
    if (e.type === "task_start") {
      const p = e.payload as TimelineEventPayload["task_start"];
      taskState.set(p.task_id, { engine: p.engine, goal: p.goal, status: "running" });
    } else if (e.type === "task_end") {
      const p = e.payload as TimelineEventPayload["task_end"];
      taskState.set(p.task_id, { engine: p.engine, goal: p.goal, status: p.status });
    }
  }
  if (taskState.size > 0) {
    const named = [...taskState.values()]
      .slice(0, 5)
      .map((t) => `${t.engine}: "${short(t.goal)}" (${t.status})`);
    parts.push(
      `tasks: ${named.join("; ")}${taskState.size > 5 ? ` (+${taskState.size - 5} more)` : ""}`,
    );
  }

  // Name files that changed (name only, capped).
  const files = events
    .filter((e) => e.type === "file")
    .map((e) => {
      const p = e.payload as TimelineEventPayload["file"];
      return `${p.action} ${p.name}`;
    });
  if (files.length > 0) {
    parts.push(
      `files: ${files.slice(0, 5).join(", ")}${files.length > 5 ? ` (+${files.length - 5} more)` : ""}`,
    );
  }

  // Surface failed verifications and errors with their reasons.
  const fails = events
    .filter(
      (e) =>
        e.type === "verify" &&
        (e.payload as TimelineEventPayload["verify"]).result === "fail",
    )
    .map((e) => short((e.payload as TimelineEventPayload["verify"]).reason));
  if (fails.length > 0) {
    parts.push(`verification failures: ${fails.slice(0, 3).join("; ")}`);
  }
  const errors = events
    .filter((e) => e.type === "error")
    .map((e) => short((e.payload as TimelineEventPayload["error"]).message));
  if (errors.length > 0) {
    parts.push(`errors: ${errors.slice(0, 3).join("; ")}`);
  }

  // Workspace moves.
  const moves = events
    .filter((e) => e.type === "workspace")
    .map((e) => (e.payload as TimelineEventPayload["workspace"]).workspace_root)
    .filter((w): w is string => !!w);
  if (moves.length > 0) {
    parts.push(`workspace: ${moves[moves.length - 1]}`);
  }

  return parts.join(" ");
}

function short(text: string, max = 80): string {
  const oneLine = text.replace(/\s+/g, " ").trim();
  return oneLine.length > max ? `${oneLine.slice(0, max - 1)}…` : oneLine;
}

// ---------------------------------------------------------------------------
// Persistence: one JSON file per run, same directory pattern as
// WorkflowRunStore — <root>/workflow/runs/<run_id>.json.
// ---------------------------------------------------------------------------

function dir(root: string): string {
  return join(root, "workflow", "runs");
}

function file(root: string, runId: string): string {
  return join(dir(root), `${runId}.json`);
}

/**
 * Persist a run's FULL event timeline as JSON. The whole RunContext is
 * written (events included) so `load` round-trips everything; `saveRun` in
 * store.ts delegates here after syncing the deprecated turns view.
 */
export function persist(root: string, run: RunContext): void {
  mkdirSync(dir(root), { recursive: true });
  writeFileSync(
    file(root, run.run_id),
    JSON.stringify({ ...run, updated_at: new Date().toISOString() }, null, 2),
    "utf8",
  );
}

/**
 * Load a run by id. Corrupt or unknown ids return undefined; corrupt event
 * entries inside an otherwise readable file are dropped.
 */
export function load(root: string, runId: string): RunContext | undefined {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(file(root, runId), "utf8"));
  } catch {
    return undefined;
  }
  if (typeof raw !== "object" || raw === null) return undefined;
  const r = raw as Record<string, unknown>;
  if (r.run_id !== runId) return undefined;
  const events = Array.isArray(r.events)
    ? (r.events as unknown[]).filter(isTimelineEvent)
    : [];
  // Backfill: runs saved before the timeline existed carry only `turns`.
  const legacyTurns = Array.isArray(r.turns) ? (r.turns as RunTurn[]) : [];
  const filled =
    events.length > 0 || legacyTurns.length === 0
      ? events
      : backfillEventsFromTurns(runId, legacyTurns);
  const run: RunContext = {
    run_id: runId,
    workspace_root: typeof r.workspace_root === "string" ? r.workspace_root : "",
    events: filled,
    turns: [],
    created_at: typeof r.created_at === "string" ? r.created_at : new Date().toISOString(),
    updated_at: typeof r.updated_at === "string" ? r.updated_at : new Date().toISOString(),
  };
  syncTurns(run);
  return run;
}

/**
 * Rebuild the deprecated `run.turns` array from the timeline's
 * task_start/task_end event pairs. This is the ONLY writer of `turns` —
 * timeline stays the single source of history.
 */
export function syncTurns(run: RunContext): void {
  run.turns = rebuildTurns(run.events);
}

function rebuildTurns(events: AnyTimelineEvent[]): RunTurn[] {
  const starts = new Map<string, TimelineEvent<"task_start">>();
  const ends = new Map<string, TimelineEvent<"task_end">>();
  for (const e of events) {
    if (e.type === "task_start") starts.set(e.id, e);
    else if (e.type === "task_end") {
      const p = e.payload as TimelineEventPayload["task_end"];
      ends.set(p.task_id, e);
    }
  }
  const turns: RunTurn[] = [];
  for (const start of starts.values()) {
    const sp = start.payload as TimelineEventPayload["task_start"];
    const end = ends.get(sp.task_id);
    const ep = end?.payload as TimelineEventPayload["task_end"] | undefined;
    turns.push({
      turn_id: start.id,
      engine: sp.engine,
      task_id: sp.task_id,
      goal: sp.goal,
      status: ep?.status ?? "running",
      artifacts: ep?.artifacts ?? [],
      ...(ep?.note ?? sp.note ? { note: ep?.note ?? sp.note } : {}),
      created_at: start.timestamp,
      updated_at: end?.timestamp ?? start.timestamp,
    });
  }
  // Keep chronological order.
  turns.sort((a, b) => a.created_at.localeCompare(b.created_at));
  return turns;
}

/**
 * One-time migration for run files saved before the timeline existed:
 * each legacy RunTurn becomes a task_start event (+ task_end when the turn
 * had already finished). Original timestamps are preserved.
 */
function backfillEventsFromTurns(runId: string, turns: RunTurn[]): AnyTimelineEvent[] {
  const events: AnyTimelineEvent[] = [];
  for (const turn of turns) {
    if (
      typeof turn !== "object" ||
      turn === null ||
      typeof turn.task_id !== "string" ||
      typeof turn.goal !== "string"
    ) {
      continue;
    }
    const start = createEvent(
      runId,
      "task_start",
      {
        engine: turn.engine,
        task_id: turn.task_id,
        goal: turn.goal,
        ...(turn.note ? { note: turn.note } : {}),
      },
      {
        timestamp:
          typeof turn.created_at === "string" ? turn.created_at : undefined,
      },
    );
    events.push(start);
    if (turn.status && turn.status !== "running") {
      events.push(
        createEvent(
          runId,
          "task_end",
          {
            engine: turn.engine,
            task_id: turn.task_id,
            goal: turn.goal,
            status: turn.status,
            artifacts: Array.isArray(turn.artifacts) ? turn.artifacts : [],
            ...(turn.note ? { note: turn.note } : {}),
          },
          {
            timestamp:
              typeof turn.updated_at === "string" ? turn.updated_at : undefined,
          },
        ),
      );
    }
  }
  events.sort((a, b) => a.timestamp.localeCompare(b.timestamp));
  return events;
}
