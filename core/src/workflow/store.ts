import { randomUUID } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type {
  RunContext,
  RunTurn,
  RunTurnStatus,
  WorkflowEngine,
} from "./types.ts";

/**
 * Dae Captain run persistence (PR1).
 *
 * Follows the ADR-0003 pattern from TaskStore:
 *   <daedalus-home>/workflow/runs/<run_id>.json   one file per run
 * No database dependency. Synchronous fs like TaskStore.
 */
export class WorkflowRunStore {
  readonly root: string;

  constructor(root: string) {
    this.root = root;
  }

  private dir(): string {
    return join(this.root, "workflow", "runs");
  }

  private file(runId: string): string {
    return join(this.dir(), `${runId}.json`);
  }

  saveRun(run: RunContext): void {
    mkdirSync(this.dir(), { recursive: true });
    writeFileSync(
      this.file(run.run_id),
      JSON.stringify({ ...run, updated_at: new Date().toISOString() }, null, 2),
      "utf8",
    );
  }

  loadRun(runId: string): RunContext | undefined {
    try {
      const raw = JSON.parse(
        readFileSync(this.file(runId), "utf8"),
      ) as RunContext;
      if (!raw || raw.run_id !== runId || !Array.isArray(raw.turns)) {
        return undefined;
      }
      return raw;
    } catch {
      return undefined;
    }
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
}

export function createWorkflowRun(workspaceRoot: string): RunContext {
  const now = new Date().toISOString();
  return {
    run_id: randomUUID(),
    workspace_root: workspaceRoot,
    turns: [],
    created_at: now,
    updated_at: now,
  };
}

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
  const now = new Date().toISOString();
  const full: RunTurn = {
    turn_id: randomUUID(),
    engine: turn.engine,
    task_id: turn.task_id,
    goal: turn.goal,
    status: turn.status,
    artifacts: [],
    ...(turn.note ? { note: turn.note } : {}),
    created_at: now,
    updated_at: now,
  };
  run.turns.push(full);
  run.updated_at = now;
  return full;
}

export function updateTurn(
  run: RunContext,
  turnId: string,
  patch: Partial<Pick<RunTurn, "status" | "artifacts" | "note">>,
): RunTurn | undefined {
  const turn = run.turns.find((t) => t.turn_id === turnId);
  if (!turn) return undefined;
  if (patch.status !== undefined) turn.status = patch.status;
  if (patch.artifacts !== undefined) turn.artifacts = patch.artifacts;
  if (patch.note !== undefined) turn.note = patch.note;
  turn.updated_at = new Date().toISOString();
  run.updated_at = turn.updated_at;
  return turn;
}

/** Most recent turn (any status), or undefined for an empty run. */
export function lastTurn(run: RunContext): RunTurn | undefined {
  return run.turns.length > 0 ? run.turns[run.turns.length - 1] : undefined;
}
