import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import {
  WorkflowRunStore,
  appendTurn,
  createWorkflowRun,
  lastTurn,
  updateTurn,
} from "../src/workflow/store.ts";

let dir: string;
let store: WorkflowRunStore;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "dae-captain-store-"));
  store = new WorkflowRunStore(dir);
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("WorkflowRunStore", () => {
  test("save → load round-trips a run with turns", () => {
    const run = createWorkflowRun("/ws");
    const turn = appendTurn(run, {
      engine: "coding",
      task_id: "t1",
      goal: "buat landing page",
      status: "running",
    });
    store.saveRun(run);

    const loaded = store.loadRun(run.run_id);
    expect(loaded?.run_id).toBe(run.run_id);
    expect(loaded?.workspace_root).toBe("/ws");
    expect(loaded?.turns).toHaveLength(1);
    expect(loaded?.turns[0]?.turn_id).toBe(turn.turn_id);
    expect(loaded?.turns[0]?.status).toBe("running");
  });

  test("loadRun returns undefined for unknown or corrupt ids", () => {
    expect(store.loadRun("nope")).toBeUndefined();
    expect(store.loadRun("../evil")).toBeUndefined();
  });

  test("listRuns returns newest first and skips corrupt files", () => {
    const a = createWorkflowRun("/ws");
    store.saveRun(a);
    const b = createWorkflowRun("/ws");
    store.saveRun(b);
    // saveRun stamps updated_at at write time, so force b to be newest by
    // rewriting its file with a later timestamp (post-save).
    const bFile = join(dir, "workflow", "runs", `${b.run_id}.json`);
    const bRaw = JSON.parse(readFileSync(bFile, "utf8"));
    bRaw.updated_at = new Date(Date.now() + 60_000).toISOString();
    writeFileSync(bFile, JSON.stringify(bRaw, null, 2), "utf8");
    // Corrupt file must be skipped, never thrown.
    writeFileSync(join(dir, "workflow", "runs", "corrupt.json"), "{nope", "utf8");

    const ids = store.listRuns().map((r) => r.run_id);
    expect(ids).toContain(a.run_id);
    expect(ids).toContain(b.run_id);
    expect(ids).not.toContain("corrupt");
    expect(ids[0]).toBe(b.run_id);
  });

  test("listRuns breaks timestamp ties deterministically", () => {
    const mk = () => {
      const r = createWorkflowRun("/ws");
      store.saveRun(r);
      return r;
    };
    const runs = [mk(), mk(), mk(), mk(), mk()];
    // Force identical timestamps on all files.
    const stamp = new Date("2026-10-14T00:00:00.000Z").toISOString();
    for (const r of runs) {
      const f = join(dir, "workflow", "runs", `${r.run_id}.json`);
      const raw = JSON.parse(readFileSync(f, "utf8"));
      raw.updated_at = stamp;
      raw.created_at = stamp;
      writeFileSync(f, JSON.stringify(raw, null, 2), "utf8");
    }
    const first = store.listRuns().map((r) => r.run_id);
    const second = store.listRuns().map((r) => r.run_id);
    expect(first).toEqual(second);
    expect(first).toHaveLength(5);
    // Tiebreak is run_id descending.
    expect(first).toEqual([...first].sort((x, y) => y.localeCompare(x)));
  });

  test("updateTurn patches status/artifacts/note", () => {
    const run = createWorkflowRun("/ws");
    const turn = appendTurn(run, {
      engine: "slide",
      task_id: "t2",
      goal: "deck",
      status: "running",
    });
    const updated = updateTurn(run, turn.turn_id, {
      status: "done",
      artifacts: [{ kind: "deck", label: "deck", path: "deck/deck.json" }],
      note: "selesai",
    });
    expect(updated?.status).toBe("done");
    expect(updated?.artifacts).toHaveLength(1);
    expect(updated?.note).toBe("selesai");
    expect(updateTurn(run, "missing", { status: "done" })).toBeUndefined();
  });

  test("lastTurn returns the most recent turn", () => {
    const run = createWorkflowRun("/ws");
    expect(lastTurn(run)).toBeUndefined();
    appendTurn(run, { engine: "coding", task_id: "t1", goal: "a", status: "done" });
    const second = appendTurn(run, { engine: "slide", task_id: "t2", goal: "b", status: "running" });
    expect(lastTurn(run)?.turn_id).toBe(second.turn_id);
  });
});
