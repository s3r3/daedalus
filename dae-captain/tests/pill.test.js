// Unit tests for dae-captain/ui pill v2 (Fase 6) — run: node --test tests/
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  PILL_STATUSES,
  PILL_DOT_COLORS,
  PILL_BUTTONS,
  parseProgressFraction,
  turnPhaseText,
  taskChip,
  derivePillState,
  acknowledgePillErrors,
} from "../ui/logic.js";

const run = (turns) => [{ run_id: "r1", turns }];

describe("PILL_STATUSES", () => {
  it("has exactly the 9 approved statuses", () => {
    assert.deepEqual(PILL_STATUSES, [
      "idle", "working", "verifying", "fixing", "waiting_approval",
      "paused", "queued", "done", "error",
    ]);
  });

  it("dot colors match the mockup", () => {
    assert.equal(PILL_DOT_COLORS.idle, "green");
    assert.equal(PILL_DOT_COLORS.working, "blue");
    assert.equal(PILL_DOT_COLORS.verifying, "purple");
    assert.equal(PILL_DOT_COLORS.fixing, "yellow");
    assert.equal(PILL_DOT_COLORS.waiting_approval, "yellow");
    assert.equal(PILL_DOT_COLORS.paused, "gray");
    assert.equal(PILL_DOT_COLORS.queued, "gray");
    assert.equal(PILL_DOT_COLORS.done, "green");
    assert.equal(PILL_DOT_COLORS.error, "red");
  });

  it("working shows cancel+pause, waiting_approval/error show view", () => {
    assert.deepEqual(PILL_BUTTONS.working, ["cancel", "pause"]);
    assert.deepEqual(PILL_BUTTONS.verifying, ["cancel"]);
    assert.deepEqual(PILL_BUTTONS.waiting_approval, ["view"]);
    assert.deepEqual(PILL_BUTTONS.error, ["view"]);
    assert.deepEqual(PILL_BUTTONS.idle, []);
    assert.deepEqual(PILL_BUTTONS.paused, []);
  });
});

describe("parseProgressFraction", () => {
  it("parses engine narration fractions", () => {
    assert.deepEqual(parseProgressFraction("Mengisi slide 8/12: Judul"), { current: 8, total: 12 });
    assert.deepEqual(parseProgressFraction("8/12"), { current: 8, total: 12 });
  });

  it("takes the last fraction (stale narration first)", () => {
    assert.deepEqual(parseProgressFraction("slide 3/12 lalu 8/12"), { current: 8, total: 12 });
  });

  it("returns null when there is no fraction", () => {
    assert.equal(parseProgressFraction("Berpikir…"), null);
    assert.equal(parseProgressFraction(""), null);
    assert.equal(parseProgressFraction(null), null);
  });

  it("rejects degenerate fractions", () => {
    assert.equal(parseProgressFraction("slide 5/0"), null);
    assert.equal(parseProgressFraction("x/y"), null);
  });

  it("clamps overruns instead of fabricating", () => {
    assert.deepEqual(parseProgressFraction("slide 15/12"), { current: 12, total: 12 });
  });
});

describe("turnPhaseText", () => {
  it("prefers the engine's own narration, pill-sized", () => {
    const t = { engine: "slide", last_event_text: "Mengisi slide 8/12: Tinjauan Pustaka" };
    assert.equal(turnPhaseText(t), "Mengisi slide 8/12: Tinjauan Pustaka");
  });

  it("truncates long narration", () => {
    const t = { engine: "slide", last_event_text: "x".repeat(100) };
    assert.ok(turnPhaseText(t).length <= 44);
    assert.ok(turnPhaseText(t).endsWith("…"));
  });

  it("maps validation start to verifying", () => {
    assert.equal(turnPhaseText({ engine: "coding", last_event: "VALIDATION_STARTED" }), "Memverifikasi…");
  });

  it("falls back to per-engine generics", () => {
    assert.equal(turnPhaseText({ engine: "slide" }), "Membuat slide…");
    assert.equal(turnPhaseText({ engine: "dokumen" }), "Menyiapkan dokumen…");
    assert.equal(turnPhaseText({ engine: "research" }), "Menjalankan riset…");
  });
});

describe("derivePillState", () => {
  it("idle when nothing runs", () => {
    const s = derivePillState(run([]), {});
    assert.equal(s.status, "idle");
    assert.equal(s.label, "Dae Captain");
    assert.deepEqual(s.buttons, []);
  });

  it("working with the engine's phase text and cancel+pause", () => {
    const s = derivePillState(run([
      { turn_id: "t1", task_id: "k1", engine: "slide", status: "running", last_event_text: "Mengisi slide 8/12: X" },
    ]), {});
    assert.equal(s.status, "working");
    assert.equal(s.label, "Mengisi slide 8/12: X");
    assert.deepEqual(s.buttons, ["cancel", "pause"]);
    assert.equal(s.cancelTaskId, "k1");
    assert.equal(s.pauseTaskId, "k1");
    assert.deepEqual(s.progress, { current: 8, total: 12 });
  });

  it("verifying on VALIDATION_STARTED", () => {
    const s = derivePillState(run([
      { turn_id: "t1", task_id: "k1", engine: "slide", status: "running", last_event: "VALIDATION_STARTED" },
    ]), {});
    assert.equal(s.status, "verifying");
    assert.equal(s.label, "Memverifikasi…");
    assert.deepEqual(s.buttons, ["cancel"]);
  });

  it("fixing on VALIDATION_FAILED with the attempt count", () => {
    const s = derivePillState(run([
      { turn_id: "t1", task_id: "k1", engine: "slide", status: "running", last_event: "VALIDATION_FAILED", validation_failures: 1 },
    ]), {});
    assert.equal(s.status, "fixing");
    assert.equal(s.label, "Memperbaiki (1/2)");
  });

  it("waiting_approval outranks working", () => {
    const s = derivePillState(run([
      { turn_id: "t1", task_id: "k1", engine: "coding", status: "running", pending_approvals: [{ id: "a1" }] },
      { turn_id: "t2", task_id: "k2", engine: "slide", status: "running", last_event_text: "Mengisi slide 2/12" },
    ]), {});
    assert.equal(s.status, "waiting_approval");
    assert.equal(s.label, "⚠ Perlu persetujuan");
    assert.equal(s.pulse, true);
    assert.deepEqual(s.buttons, ["view"]);
  });

  it("dnd demotes waiting_approval to a quiet display", () => {
    const s = derivePillState(run([
      { turn_id: "t1", task_id: "k1", engine: "coding", status: "running", pending_approvals: [{ id: "a1" }] },
    ]), {}, { dnd: true });
    assert.notEqual(s.status, "waiting_approval");
    assert.equal(s.pulse, false);
    assert.equal(s.approvalCount, 1); // still queued in the data
  });

  it("paused shows click-to-resume", () => {
    const s = derivePillState(run([
      { turn_id: "t1", task_id: "k1", engine: "slide", status: "running", paused: true },
    ]), {});
    assert.equal(s.status, "paused");
    assert.equal(s.label, "⏸ Dijeda — klik untuk lanjut");
    assert.equal(s.resumeTaskId, "k1");
    assert.equal(s.pauseTaskId, null);
  });

  it("queued shows the queue count", () => {
    const s = derivePillState(run([
      { turn_id: "t1", task_id: "k1", engine: "slide", status: "running", queued: true },
      { turn_id: "t2", task_id: "k2", engine: "slide", status: "running", queued: true },
    ]), {});
    assert.equal(s.status, "queued");
    assert.equal(s.label, "Antrian: 2 task");
  });

  it("multi-task working summarizes all tasks", () => {
    const s = derivePillState(run([
      { turn_id: "t1", task_id: "k1", engine: "slide", status: "running", last_event_text: "Mengisi slide 8/12" },
      { turn_id: "t2", task_id: "k2", engine: "research", status: "running", last_event_text: "Membaca sumber 3/8" },
    ]), {});
    assert.equal(s.status, "working");
    assert.equal(s.label, "2 task: slide 8/12 + research 3/8");
    assert.equal(s.tasks.length, 2);
  });

  it("done flashes on a fresh running->done transition", () => {
    const mem = {};
    const running = run([{ turn_id: "t1", task_id: "k1", engine: "slide", status: "running" }]);
    derivePillState(running, mem);
    const done = run([{ turn_id: "t1", task_id: "k1", engine: "slide", status: "done", updated_at: new Date().toISOString() }]);
    const s = derivePillState(done, mem);
    assert.equal(s.status, "done");
    assert.equal(s.label, "✓ Selesai");
    assert.equal(s.pulse, true);
  });

  it("no done flash for turns already done on first sight", () => {
    const s = derivePillState(run([
      { turn_id: "t1", task_id: "k1", engine: "slide", status: "done", updated_at: new Date().toISOString() },
    ]), {});
    assert.equal(s.status, "idle");
  });

  it("error shows for recent failures", () => {
    const s = derivePillState(run([
      { turn_id: "t1", task_id: "k1", engine: "slide", status: "failed", updated_at: new Date().toISOString() },
    ]), {});
    assert.equal(s.status, "error");
    assert.equal(s.label, "✕ Gagal — lihat chat");
    assert.deepEqual(s.buttons, ["view"]);
  });

  it("error outranks working but not waiting_approval", () => {
    const failed = { turn_id: "t1", task_id: "k1", engine: "slide", status: "failed", updated_at: new Date().toISOString() };
    const working = { turn_id: "t2", task_id: "k2", engine: "coding", status: "running" };
    assert.equal(derivePillState(run([failed, working]), {}).status, "error");
    const approval = { turn_id: "t3", task_id: "k3", engine: "coding", status: "running", pending_approvals: [{ id: "a" }] };
    assert.equal(derivePillState(run([failed, approval]), {}).status, "waiting_approval");
  });

  it("acknowledgePillErrors clears the error display", () => {
    const mem = {};
    const runs = run([
      { turn_id: "t1", task_id: "k1", engine: "slide", status: "failed", updated_at: new Date().toISOString() },
    ]);
    assert.equal(derivePillState(runs, mem).status, "error");
    acknowledgePillErrors(runs, mem);
    assert.equal(derivePillState(runs, mem).status, "idle");
  });

  it("taskChip renders engine + fraction", () => {
    assert.equal(taskChip({ engine: "slide", last_event_text: "Mengisi slide 8/12" }), "slide 8/12");
    assert.equal(taskChip({ engine: "coding" }), "coding");
  });
});
