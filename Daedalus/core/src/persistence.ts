import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Event, EventType } from "./contracts.ts";

/**
 * Per-task persistence per ADR-0003:
 *   .daedalus/tasks/<task_id>/events.jsonl   append-only, replayable
 *   .daedalus/tasks/<task_id>/state.json     current task state snapshot
 * No database dependency (Phases 0–3).
 */
export class TaskStore {
  readonly root: string;

  constructor(root: string) {
    this.root = root;
  }

  taskDir(taskId: string): string {
    return join(this.root, "tasks", taskId);
  }

  append(taskId: string, event: Event): void {
    const dir = this.taskDir(taskId);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "events.jsonl"), JSON.stringify(event) + "\n", {
      encoding: "utf8",
      flag: "a",
    });
  }

  /** Replay all events for a task in file (seq) order. */
  replay(taskId: string): Event[] {
    try {
      const raw = readFileSync(join(this.taskDir(taskId), "events.jsonl"), "utf8");
      return raw
        .split("\n")
        .filter((line) => line.trim().length > 0)
        .map((line) => JSON.parse(line) as Event);
    } catch {
      return [];
    }
  }

  saveState(taskId: string, state: unknown): void {
    const dir = this.taskDir(taskId);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "state.json"), JSON.stringify(state, null, 2), "utf8");
  }

  loadState<T>(taskId: string): T | undefined {
    try {
      return JSON.parse(
        readFileSync(join(this.taskDir(taskId), "state.json"), "utf8"),
      ) as T;
    } catch {
      return undefined;
    }
  }

  listTasks(): string[] {
    try {
      return readdirSync(join(this.root, "tasks"));
    } catch {
      return [];
    }
  }

  /** Final report per task, so interfaces can render it without rerunning the task. */
  saveReport(taskId: string, report: unknown): void {
    const dir = this.taskDir(taskId);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "report.json"), JSON.stringify(report, null, 2), "utf8");
  }

  loadReport<T>(taskId: string): T | undefined {
    try {
      return JSON.parse(readFileSync(join(this.taskDir(taskId), "report.json"), "utf8")) as T;
    } catch {
      return undefined;
    }
  }

  /** Cross-process cancellation: `daedalus cancel <id>` writes a marker the runner polls. */
  requestCancel(taskId: string): void {
    const dir = this.taskDir(taskId);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "cancel.request"), new Date().toISOString(), "utf8");
  }

  isCancelRequested(taskId: string): boolean {
    try {
      readFileSync(join(this.taskDir(taskId), "cancel.request"), "utf8");
      return true;
    } catch {
      return false;
    }
  }
}

export type { EventType };
