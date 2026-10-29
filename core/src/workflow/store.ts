import { randomUUID } from "node:crypto";
import { readdirSync } from "node:fs";
import { join } from "node:path";
import type {
  RunContext,
  RunTurn,
  RunTurnStatus,
  WorkflowEngine,
} from "./types.ts";
import {
  appendEvent,
  load as loadTimelineRun,
  persist as persistTimelineRun,
  syncTurns,
} from "./timeline.ts";
import type { TimelineEventPayload } from "./timeline.ts";

/**
 * Dae Captain run persistence (PR1, migrated to the v2 event timeline).
 *
 * Same file pattern as ADR-0003 TaskStore:
 *   <daedalus-home>/workflow/runs/<run_id>.json   one file per run
 * No database dependency. Synchronous fs like TaskStore.
 *
 * The timeline (`run.events`) is the single source of history. `run.turns`
 * is a deprecated view derived from the task_start/task_end event pairs —
 * `syncTurns()` is the only writer, called on every mutation, save, and
 * load. Legacy run files saved with only `turns` are backfilled into events
 * on load (see timeline.ts).
 */
export class WorkflowRunStore {
  readonly root: string;

  constructor(root: string) {
    this.root = root;
  }

  private dir(): string {
    return join(this.root, "workflow", "runs");
  }

  saveRun(run: RunContext): void {
    syncTurns(run);
    persistTimelineRun(this.root, run);
  }

  loadRun(runId: string): RunContext | undefined {
    const run = loadTimelineRun(this.root, runId);
    if (!run) return undefined;
    syncTurns(run);
    return run;
  }

  /** All runs, newest first. Corrupt files are skipped, never thrown. */
  listRuns(): RunContext[] {
    let files: string[];
    try {
      files = readdirSync(this.dir());
    } catch {
      return [];
    }
    const runs: RunContext[] = [];
    for (const file of files) {
      if (!file.endsWith(".json")) continue;
      const run = this.loadRun(file.slice(0, -".json".length));
      if (run) runs.push(run);
    }
    // Total order: newest first; ties (same-millisecond writes are common)
    // break deterministically by created_at, then run_id.
    runs.sort(
      (a, b) =>
        b.updated_at.localeCompare(a.updated_at) ||
        b.created_at.localeCompare(a.created_at) ||
        b.run_id.localeCompare(a.run_id),
    );
    return runs;
  }

  /**
   * Tutup semua turn yang masih "running" sebagai "failed" (catatan: terputus).
   * Dipanggil sekali saat server start — restart berarti proses yang
   * menjalankan turn itu sudah tiada, jadi turn tak mungkin selesai.
   * Mengembalikan jumlah turn yang ditutup.
   *
   * PENTING: `run.turns` hanyalah tampilan turunan dari event timeline —
   * `saveRun()` memanggil `syncTurns()` yang membangunnya ulang dari `events`.
   * Versi lama mengubah `turn.status` langsung, sehingga perubahan itu
   * DIBUANG saat disimpan (sapuan boot jadi no-op dan task menjadi phantom
   * "running" selamanya). Satu-satunya cara yang bertahan adalah menambah
   * event `task_end` lewat `updateTurn()`.
   */
  markStaleRunningInterrupted(keepRunning?: (turn: RunTurn) => boolean): number {
    let marked = 0;
    for (const run of this.listRuns()) {
      let dirty = false;
      for (const turn of [...(run.turns ?? [])]) {
        if (turn?.status !== "running") continue;
        // Turn yang masih bisa diselesaikan tanpa proses lama (mis. riset yang laporannya sudah tersimpan di disk)
        // dibiarkan: reconcile saat poll pertama yang menutupnya sebagai selesai.
        if (keepRunning?.(turn)) continue;
        const updated = updateTurn(run, turn.turn_id, {
          status: "failed",
          note: "terputus: server berhenti saat task berjalan",
        });
        if (updated) {
          dirty = true;
          marked++;
        }
      }
      if (dirty) this.saveRun(run);
    }
    return marked;
  }
}

export function createWorkflowRun(workspaceRoot: string): RunContext {
  const now = new Date().toISOString();
  return {
    run_id: randomUUID(),
    workspace_root: workspaceRoot,
    events: [],
    turns: [],
    created_at: now,
    updated_at: now,
  };
}

/**
 * Start a task: appends a `task_start` event and returns the derived turn.
 * The turn's `turn_id` is the start event's id (stable across save/load).
 */
export function appendTurn(
  run: RunContext,
  turn: {
    engine: WorkflowEngine;
    task_id: string;
    goal: string;
    status: RunTurnStatus;
    note?: string;
  },
): RunTurn {
  const start = appendEvent(run, "task_start", {
    engine: turn.engine,
    task_id: turn.task_id,
    goal: turn.goal,
    ...(turn.note ? { note: turn.note } : {}),
  });
  // A freshly started task is "running" unless the caller says otherwise.
  if (turn.status !== "running") {
    updateTurn(run, start.id, { status: turn.status });
  }
  const derived = run.turns.find((t) => t.turn_id === start.id);
  if (!derived) throw new Error("timeline: turn missing after appendTurn");
  return derived;
}

/**
 * Record a task update: appends a `task_end` event carrying the merged state
 * (status / artifacts / note; anything not patched keeps its previous
 * value) and returns the derived turn. Append-only — the timeline never
 * mutates past events. Returns undefined when no task matches `turnId`.
 */
export function updateTurn(
  run: RunContext,
  turnId: string,
  patch: Partial<Pick<RunTurn, "status" | "artifacts" | "note">>,
): RunTurn | undefined {
  const start = run.events.find(
    (e) => e.type === "task_start" && e.id === turnId,
  );
  if (!start) return undefined;
  const sp = start.payload as TimelineEventPayload["task_start"];
  const prev = [...run.events]
    .reverse()
    .find(
      (e) =>
        e.type === "task_end" &&
        (e.payload as TimelineEventPayload["task_end"]).task_id === sp.task_id,
    );
  const prevPayload = prev?.payload as
    | TimelineEventPayload["task_end"]
    | undefined;
  const note = patch.note ?? prevPayload?.note ?? sp.note;
  appendEvent(run, "task_end", {
    engine: sp.engine,
    task_id: sp.task_id,
    goal: sp.goal,
    status: patch.status ?? prevPayload?.status ?? "running",
    artifacts: patch.artifacts ?? prevPayload?.artifacts ?? [],
    ...(note ? { note } : {}),
  });
  return run.turns.find((t) => t.turn_id === start.id);
}

/** Most recent turn (any status), or undefined for an empty run. */
export function lastTurn(run: RunContext): RunTurn | undefined {
  return run.turns.length > 0 ? run.turns[run.turns.length - 1] : undefined;
}
