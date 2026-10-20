import { mkdtempSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import {
  MAX_UNDO_SNAPSHOT_BYTES,
  UndoStore,
  classifyAction,
  clearPendingApprovals,
  denyApproval,
  getPendingApproval,
  grantApproval,
  listPendingApprovals,
  recordUndo,
  requestApproval,
  createWorkflowRun,
  getEvents,
} from "../src/workflow/index.ts";
import type {
  Action,
  AnyTimelineEvent,
  TimelineEvent,
} from "../src/workflow/index.ts";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "dae-captain-approval-"));
  clearPendingApprovals();
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  clearPendingApprovals();
});

const act = (overrides: Partial<Action> = {}): Action => ({
  type: "edit_file",
  engine: "coding",
  summary: "ubah file",
  ...overrides,
});

function approvalEvents(run: ReturnType<typeof createWorkflowRun>): TimelineEvent<"approval">[] {
  return getEvents(run).filter(
    (e: AnyTimelineEvent): e is TimelineEvent<"approval"> => e.type === "approval",
  );
}

// ---------------------------------------------------------------------------
// classifyAction
// ---------------------------------------------------------------------------

describe("classifyAction", () => {
  test("destructive -> ask", () => {
    for (const type of ["delete_file", "delete_deck", "delete_dataset", "delete_workbook", "delete_report"]) {
      const c = classifyAction(act({ type }));
      expect(c.kind).toBe("destructive");
      expect(c.treatment).toBe("ask");
      expect(c.needsApproval).toBe(true);
    }
  });

  test("reversible -> auto", () => {
    for (const type of ["edit_file", "edit_slide", "edit_cell", "change_theme", "create_file"]) {
      const c = classifyAction(act({ type }));
      expect(c.kind).toBe("reversible");
      expect(c.treatment).toBe("auto");
      expect(c.needsApproval).toBe(false);
    }
  });

  test("explicit -> button", () => {
    for (const type of ["start_research", "run_analysis_plan", "create_workbook", "generate_document", "create_deck"]) {
      const c = classifyAction(act({ type }));
      expect(c.kind).toBe("explicit");
      expect(c.treatment).toBe("button");
      expect(c.needsApproval).toBe(true);
    }
  });

  test("dangerous run_command is destructive", () => {
    const c = classifyAction(act({ type: "run_command", detail: "rm -rf dist" }));
    expect(c.kind).toBe("destructive");
    expect(c.needsApproval).toBe(true);
  });

  test("ordinary run_command is reversible", () => {
    const c = classifyAction(act({ type: "run_command", detail: "npm test" }));
    expect(c.kind).toBe("reversible");
    expect(c.needsApproval).toBe(false);
  });

  test("unknown types default to reversible (chat-first, never bureaucratic)", () => {
    const c = classifyAction(act({ type: "preview_file" }));
    expect(c.kind).toBe("reversible");
    expect(c.needsApproval).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// request / grant / deny
// ---------------------------------------------------------------------------

describe("approval lifecycle", () => {
  test("requestApproval appends a requested event", () => {
    const run = createWorkflowRun(dir);
    const p = requestApproval(run, act({ type: "delete_file", summary: "hapus index.html" }));
    expect(p.status).toBe("requested");
    expect(p.kind).toBe("destructive");
    const events = approvalEvents(run);
    expect(events).toHaveLength(1);
    expect(events[0]!.payload.decision).toBe("requested");
    expect(events[0]!.payload.summary).toContain("hapus index.html");
    expect(getPendingApproval(p.approvalId)).toBe(p);
  });

  test("grantApproval appends granted and clears the pending entry", () => {
    const run = createWorkflowRun(dir);
    const p = requestApproval(run, act({ type: "delete_deck" }));
    const settled = grantApproval(run, p.approvalId);
    expect(settled.status).toBe("granted");
    const events = approvalEvents(run);
    expect(events.map((e) => e.payload.decision)).toEqual(["requested", "granted"]);
    expect(getPendingApproval(p.approvalId)).toBeUndefined();
    expect(listPendingApprovals()).toHaveLength(0);
  });

  test("denyApproval appends denied", () => {
    const run = createWorkflowRun(dir);
    const p = requestApproval(run, act({ type: "delete_file" }));
    denyApproval(run, p.approvalId);
    const events = approvalEvents(run);
    expect(events.map((e) => e.payload.decision)).toEqual(["requested", "denied"]);
  });

  test("unknown approval id throws", () => {
    const run = createWorkflowRun(dir);
    expect(() => grantApproval(run, "tidak-ada")).toThrow("tidak dikenal");
  });

  test("double settle throws", () => {
    const run = createWorkflowRun(dir);
    const p = requestApproval(run, act({ type: "delete_file" }));
    grantApproval(run, p.approvalId);
    expect(() => grantApproval(run, p.approvalId)).toThrow();
  });

  test("task_id is carried into the event when set", () => {
    const run = createWorkflowRun(dir);
    requestApproval(run, act({ type: "delete_file", taskId: "s2" }));
    const events = approvalEvents(run);
    expect(events[0]!.payload.task_id).toBe("s2");
  });
});

// ---------------------------------------------------------------------------
// UndoStore
// ---------------------------------------------------------------------------

describe("UndoStore", () => {
  const action = (type = "edit_file"): Action =>
    act({ type, summary: "edit", target: "a.txt" });

  test("small snapshot stays inline", () => {
    const store = new UndoStore();
    const entry = store.record("run-1", action(), {
      target: "a.txt",
      content: "konten lama",
    });
    expect(entry.snapshot.kind).toBe("content");
    if (entry.snapshot.kind === "content") {
      expect(entry.snapshot.content).toBe("konten lama");
    }
    expect(store.has(entry.undoId)).toBe(true);
    expect(store.get(entry.undoId)).toBe(entry);
  });

  test("oversized snapshot without backupDir is rejected, never unbounded", () => {
    const store = new UndoStore({ maxBytes: 10 });
    expect(() =>
      store.record("run-1", action(), {
        target: "big.bin",
        content: "x".repeat(100),
      }),
    ).toThrow("melebihi batas");
    expect(store.size).toBe(0);
  });

  test("oversized snapshot spills to a backup file", () => {
    const backupDir = join(dir, "undo-backup");
    const store = new UndoStore({ maxBytes: 10, backupDir });
    const big = "y".repeat(100);
    const entry = store.record("run-1", action(), {
      target: "big.txt",
      content: big,
    });
    expect(entry.snapshot.kind).toBe("backup_path");
    if (entry.snapshot.kind === "backup_path") {
      expect(existsSync(entry.snapshot.backupPath)).toBe(true);
      expect(readFileSync(entry.snapshot.backupPath, "utf8")).toBe(big);
    }
    // nothing large lives in memory: the entry holds a path, not content
    expect(JSON.stringify(entry).length).toBeLessThan(1000);
  });

  test("default cap is 1 MB", () => {
    expect(MAX_UNDO_SNAPSHOT_BYTES).toBe(1024 * 1024);
  });

  test("discard removes the snapshot", () => {
    const store = new UndoStore();
    const entry = store.record("run-1", action(), {
      target: "a.txt",
      content: "x",
    });
    expect(store.discard(entry.undoId)).toBe(true);
    expect(store.has(entry.undoId)).toBe(false);
    expect(store.discard(entry.undoId)).toBe(false);
  });

  test("recordUndo links the run and stamps action.undoId", () => {
    const store = new UndoStore();
    const run = createWorkflowRun(dir);
    const a = action();
    const entry = recordUndo(store, run, a, { target: "a.txt", content: "lama" });
    expect(entry.runId).toBe(run.run_id);
    expect(a.undoId).toBe(entry.undoId);
  });

  test("binary content goes through backupDir", () => {
    const backupDir = join(dir, "undo-bin");
    const store = new UndoStore({ backupDir });
    const bytes = new Uint8Array(3_000_000);
    bytes.fill(7);
    const entry = store.record("run-1", action(), {
      target: "data.bin",
      content: bytes,
    });
    expect(entry.snapshot.kind).toBe("backup_path");
    if (entry.snapshot.kind === "backup_path") {
      expect(entry.snapshot.bytes).toBe(3_000_000);
      expect(existsSync(entry.snapshot.backupPath)).toBe(true);
    }
  });
});
