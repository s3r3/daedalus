import { mkdirSync, readFileSync, readdirSync, rmSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { writeFileAtomicSync } from "./fs-atomic.ts";
import { dirname, join, resolve, sep } from "node:path";
import type { Event, EventType } from "./contracts.ts";
import type { WorktreeRecord } from "./worktree.ts";

/**
 * Per-task persistence per ADR-0003:
 *   .daedalus/tasks/<task_id>/events.jsonl   append-only, replayable
 *   .daedalus/tasks/<task_id>/state.json     current task state snapshot
 * No database dependency (Phases 0–3).
 */
/**
 * Best-effort human text from a task event payload (THOUGHT.text,
 * MODEL deltas excluded — too noisy). Used for the pill's phase line.
 */
function eventText(payload: unknown): string {
  if (!payload || typeof payload !== "object") return "";
  const p = payload as Record<string, unknown>;
  for (const key of ["text", "message", "summary", "detail"]) {
    const v = p[key];
    if (typeof v === "string" && v.trim()) return v.trim().replace(/\s+/g, " ");
  }
  return "";
}

export class TaskStore {
  readonly root: string;

  constructor(root: string) {
    this.root = root;
  }

  /** Id task = satu segmen path. Pemisah path / `..` / NUL ditolak agar id dari URL tak bisa keluar dari `tasks/`. */
  taskDir(taskId: string): string {
    if (!taskId || taskId === "." || taskId === ".." || /[\\/\0]/.test(taskId)) {
      throw new Error(`invalid task id: ${JSON.stringify(taskId)}`);
    }
    return join(this.root, "tasks", taskId);
  }

  // Cache nomor urut per task, divalidasi dengan ukuran file: emitEvent dulu memanggil
  // replay() (parse SELURUH log) untuk SETIAP event → O(n²) per task. Kalau ukuran file
  // berubah di luar jalur append() (proses lain), cache otomatis dihitung ulang.
  #seq = new Map<string, { size: number; count: number }>();

  append(taskId: string, event: Event): void {
    const dir = this.taskDir(taskId);
    mkdirSync(dir, { recursive: true });
    const file = join(dir, "events.jsonl");
    const line = JSON.stringify(event) + "\n";
    let before = 0;
    try {
      before = statSync(file).size;
    } catch {
      /* file belum ada */
    }
    writeFileSync(file, line, { encoding: "utf8", flag: "a" });
    const cached = this.#seq.get(taskId);
    if (cached && cached.size === before) {
      cached.size = before + Buffer.byteLength(line);
      cached.count += 1;
    }
  }

  /**
   * Nomor seq berikutnya untuk task (1-based). Amortized O(1); menghitung ulang dari file
   * hanya bila cache kosong atau ukuran file tak cocok.
   */
  nextSeq(taskId: string): number {
    const file = join(this.taskDir(taskId), "events.jsonl");
    let size = 0;
    try {
      size = statSync(file).size;
    } catch {
      this.#seq.delete(taskId);
      return 1;
    }
    const cached = this.#seq.get(taskId);
    if (cached && cached.size === size) return cached.count + 1;
    let count = 0;
    try {
      const raw = readFileSync(file, "utf8");
      for (const line of raw.split("\n")) if (line.trim().length > 0) count++;
      size = Buffer.byteLength(raw);
    } catch {
      return 1;
    }
    this.#seq.set(taskId, { size, count });
    return count + 1;
  }

  /**
   * Replay all events for a task in file (seq) order. Baris rusak (mis. terpotong karena
   * proses mati saat menulis) dilewati — dulu SATU baris rusak membuat seluruh log "kosong".
   */
  replay(taskId: string): Event[] {
    let raw: string;
    try {
      raw = readFileSync(join(this.taskDir(taskId), "events.jsonl"), "utf8");
    } catch {
      return [];
    }
    const events: Event[] = [];
    for (const line of raw.split("\n")) {
      if (line.trim().length === 0) continue;
      try {
        events.push(JSON.parse(line) as Event);
      } catch {
        /* baris rusak: lewati */
      }
    }
    return events;
  }

  /** True when the task has any recorded events (cheap stat, no file read). */
  hasEvents(taskId: string): boolean {
    try {
      return statSync(join(this.taskDir(taskId), "events.jsonl")).size > 0;
    } catch {
      return false;
    }
  }

  /**
   * Cheap event-log summary for task lists/monitoring: how many events,
   * plus the first/last events' seq/type/ts — parsed from ONLY the
   * first and last lines. `replay()` JSON-parses every line ever
   * recorded; at ~200 historical tasks that made each GET /tasks poll
   * re-parse the whole history (seconds per poll on a busy machine).
   * This keeps the summary O(lines counted, 2 parsed) instead.
   */
  eventStats(taskId: string): TaskEventStats {
    const empty: TaskEventStats = { count: 0, firstTs: null, lastSeq: 0, lastType: null, lastTs: null };
    let raw: string;
    try {
      raw = readFileSync(join(this.taskDir(taskId), "events.jsonl"), "utf8");
    } catch {
      return empty;
    }
    const lines = raw.split("\n").filter((line) => line.trim().length > 0);
    if (lines.length === 0) return empty;
    const meta = (line: string): { seq: number; type: string | null; ts: string | null } => {
      try {
        const event = JSON.parse(line) as Partial<Event>;
        return {
          seq: typeof event.seq === "number" ? event.seq : 0,
          type: typeof event.type === "string" ? event.type : null,
          ts: typeof event.ts === "string" ? event.ts : null,
        };
      } catch {
        return { seq: 0, type: null, ts: null };
      }
    };
    const first = meta(lines[0]!);
    const last = meta(lines[lines.length - 1]!);
    return { count: lines.length, firstTs: first.ts, lastSeq: last.seq, lastType: last.type, lastTs: last.ts };
  }

  saveState(taskId: string, state: unknown): void {
    const dir = this.taskDir(taskId);
    mkdirSync(dir, { recursive: true });
    writeFileAtomicSync(join(dir, "state.json"), JSON.stringify(state, null, 2));
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
    writeFileAtomicSync(join(dir, "report.json"), JSON.stringify(report, null, 2));
  }

  loadReport<T>(taskId: string): T | undefined {
    try {
      return JSON.parse(readFileSync(join(this.taskDir(taskId), "report.json"), "utf8")) as T;
    } catch {
      return undefined;
    }
  }

  /** Persist where an isolated task's worktree lives so `daedalus apply` can find it later. */
  saveWorktreeRecord(taskId: string, record: WorktreeRecord): void {
    const dir = this.taskDir(taskId);
    mkdirSync(dir, { recursive: true });
    writeFileAtomicSync(join(dir, "worktree.json"), JSON.stringify(record, null, 2));
  }

  loadWorktreeRecord(taskId: string): WorktreeRecord | undefined {
    try {
      return JSON.parse(readFileSync(join(this.taskDir(taskId), "worktree.json"), "utf8")) as WorktreeRecord;
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

  /**
   * Cooperative pause (Dae Captain pill ⏸): `POST /tasks/:id/pause` writes
   * a marker; every engine polls it at its next safe checkpoint and blocks
   * there until `POST /tasks/:id/resume` clears the marker. Unlike cancel,
   * the task keeps all its state and continues from the checkpoint.
   */
  requestPause(taskId: string): void {
    const dir = this.taskDir(taskId);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "pause.request"), new Date().toISOString(), "utf8");
  }

  clearPause(taskId: string): void {
    try {
      unlinkSync(join(this.taskDir(taskId), "pause.request"));
    } catch {
      /* not paused — nothing to clear */
    }
  }

  isPauseRequested(taskId: string): boolean {
    try {
      readFileSync(join(this.taskDir(taskId), "pause.request"), "utf8");
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Block while the pause marker exists. Engines await this at their safe
   * checkpoints (loop-top, stage boundaries) — the task suspends without
   * losing state and resumes from the same checkpoint. Resolves immediately
   * when the task is not paused.
   */
  async waitWhilePaused(taskId: string): Promise<void> {
    if (!this.isPauseRequested(taskId)) return;
    // BUG-1 fix: also break on cancel — otherwise pause → stop leaves the
    // task stuck in waitWhilePaused forever (cancel never clears the pause).
    while (this.isPauseRequested(taskId) && !this.isCancelRequested(taskId)) {
      await new Promise((resolve) => setTimeout(resolve, 400));
    }
  }

  /** Count events of one type in a task's log (cheap line scan, no full replay). */
  countEventType(taskId: string, type: string): number {
    let raw: string;
    try {
      raw = readFileSync(join(this.taskDir(taskId), "events.jsonl"), "utf8");
    } catch {
      return 0;
    }
    let count = 0;
    for (const line of raw.split("\n")) {
      if (!line.trim()) continue;
      try {
        const event = JSON.parse(line) as { type?: unknown };
        if (event.type === type) count++;
      } catch {
        /* corrupt line — skip */
      }
    }
    return count;
  }

  /** Short human text of the task's latest event payload (THOUGHT etc.), for the pill's phase line. Empty when none. */
  lastEventText(taskId: string, maxChars = 90): string {
    let raw: string;
    try {
      raw = readFileSync(join(this.taskDir(taskId), "events.jsonl"), "utf8");
    } catch {
      return "";
    }
    const lines = raw.split("\n").filter((line) => line.trim().length > 0);
    for (let i = lines.length - 1; i >= 0 && i >= lines.length - 6; i--) {
      try {
        const event = JSON.parse(lines[i]!) as { payload?: unknown };
        const text = eventText(event.payload);
        if (text) return text.length > maxChars ? text.slice(0, maxChars - 1) + "…" : text;
      } catch {
        /* corrupt line — try an older one */
      }
    }
    return "";
  }

  // --- Checkpoints -------------------------------------------------------
  // Before a task mutates a workspace file for the first time, the runner
  // records the pre-mutation content here (or a "created" marker when the
  // file did not exist). `restoreTask` can then rewind the workspace to the
  // task's starting state, touching only files the task itself recorded.

  backupsDir(taskId: string): string {
    return join(this.taskDir(taskId), "backups");
  }

  #manifestPath(taskId: string): string {
    return join(this.backupsDir(taskId), "index.json");
  }

  #readManifest(taskId: string): BackupEntry[] {
    try {
      const parsed = JSON.parse(readFileSync(this.#manifestPath(taskId), "utf8")) as unknown;
      if (!Array.isArray(parsed)) return [];
      return parsed.filter((entry): entry is BackupEntry =>
        typeof entry === "object" && entry !== null
        && typeof (entry as BackupEntry).path === "string"
        && typeof (entry as BackupEntry).created === "boolean");
    } catch {
      return [];
    }
  }

  /**
   * Record the pre-mutation state of one workspace file. The first record
   * for a path wins; later mutations in the same task keep the original.
   * `content === null` means the file did not exist before the task.
   */
  recordBackup(taskId: string, relativePath: string, content: string | null): void {
    const entries = this.#readManifest(taskId);
    if (entries.some((entry) => entry.path === relativePath)) return;
    const dir = this.backupsDir(taskId);
    mkdirSync(dir, { recursive: true });
    if (content !== null) {
      const target = join(dir, relativePath);
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, content, "utf8");
    }
    entries.push({ path: relativePath, created: content === null });
    writeFileAtomicSync(this.#manifestPath(taskId), JSON.stringify(entries, null, 2));
  }

  /** Files this task can rewind: each entry is a workspace-relative path. */
  listBackups(taskId: string): Array<{ path: string; created: boolean }> {
    return this.#readManifest(taskId).map(({ path, created }) => ({ path, created }));
  }

  /**
   * Rewind the workspace to the state recorded by `recordBackup`: backed-up
   * files are overwritten with their original content and files the task
   * created are deleted. Only recorded files are touched. Every target is
   * validated to stay inside the workspace root before anything is written;
   * a single escaping path refuses the whole restore.
   */
  restoreTask(taskId: string, workspaceRoot?: string): { restored: string[]; deleted: string[] } {
    const entries = this.#readManifest(taskId);
    if (entries.length === 0) return { restored: [], deleted: [] };
    const state = this.loadState<{ repo_path?: string }>(taskId);
    const base = workspaceRoot ?? state?.repo_path;
    if (!base) throw new Error(`cannot restore task ${taskId}: workspace root unknown (no recorded repo_path)`);
    const root = resolve(base);
    const targets = entries.map((entry) => {
      const target = resolve(root, entry.path);
      if (target === root || !target.startsWith(root + sep)) {
        throw new Error(`refusing to restore ${entry.path}: escapes workspace root`);
      }
      return { entry, target };
    });
    const restored: string[] = [];
    const deleted: string[] = [];
    for (const { entry, target } of targets) {
      if (entry.created) {
        try {
          if (statSync(target).isDirectory()) continue;
        } catch { /* already gone */ }
        rmSync(target, { force: true });
        deleted.push(entry.path);
        continue;
      }
      let content: string;
      try {
        content = readFileSync(join(this.backupsDir(taskId), entry.path), "utf8");
      } catch {
        throw new Error(`cannot restore task ${taskId}: backup content missing for ${entry.path}`);
      }
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, content, "utf8");
      restored.push(entry.path);
    }
    return { restored, deleted };
  }
}

type BackupEntry = { path: string; created: boolean };

/** First/last-line summary of a task's event log (see TaskStore.eventStats). */
export type TaskEventStats = {
  count: number;
  firstTs: string | null;
  lastSeq: number;
  lastType: string | null;
  lastTs: string | null;
};

export type { EventType };
