import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import {
  WorkflowRunStore,
  appendEvent,
  appendTurn,
  buildModelContext,
  createEvent,
  createWorkflowRun,
  getEvents,
  getRecentEvents,
  isTimelineEventType,
  lastTurn,
  loadTimeline,
  persistTimeline,
  syncTurns,
  updateTurn,
} from "../src/workflow/index.ts";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "dae-captain-timeline-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("timeline events", () => {
  test("appendEvent stamps id/timestamp/run_id and preserves order", () => {
    const run = createWorkflowRun("/ws");
    const a = appendEvent(run, "user", { text: "buatkan slide" });
    const b = appendEvent(run, "agent", { text: "siap" });
    expect(a.id).toBeTruthy();
    expect(a.run_id).toBe(run.run_id);
    expect(a.timestamp).toBeTruthy();
    expect(b.timestamp >= a.timestamp).toBe(true);
    expect(getEvents(run).map((e) => e.type)).toEqual(["user", "agent"]);
  });

  test("getRecentEvents returns the last n oldest-first; n<=0 is []", () => {
    const run = createWorkflowRun("/ws");
    for (let i = 0; i < 5; i++) appendEvent(run, "user", { text: `m${i}` });
    expect(getRecentEvents(run, 2).map((e) => e.payload.text)).toEqual([
      "m3",
      "m4",
    ]);
    expect(getRecentEvents(run, 99)).toHaveLength(5);
    expect(getRecentEvents(run, 0)).toEqual([]);
    expect(getRecentEvents(run, -3)).toEqual([]);
  });

  test("isTimelineEventType accepts the 8 approved types only", () => {
    for (const t of [
      "user",
      "agent",
      "task_start",
      "task_end",
      "file",
      "verify",
      "approval",
      "workspace",
      "error",
    ]) {
      expect(isTimelineEventType(t)).toBe(true);
    }
    expect(isTimelineEventType("tool_call")).toBe(false);
    expect(isTimelineEventType(undefined)).toBe(false);
  });

  test("createEvent carries a typed payload per event type", () => {
    const run = createWorkflowRun("/ws");
    const ev = createEvent(run.run_id, "file", {
      action: "created",
      path: "deck.json",
      name: "deck.json",
    });
    expect(ev.type).toBe("file");
    expect(ev.payload.action).toBe("created");
  });
});

describe("persist / load", () => {
  test("persist → load round-trips ALL events (isolated temp dir)", () => {
    const run = createWorkflowRun("/ws");
    appendEvent(run, "user", { text: "buatkan slide skripsi" });
    appendEvent(run, "task_start", {
      engine: "slide",
      task_id: "t1",
      goal: "deck skripsi",
    });
    appendEvent(run, "file", {
      action: "created",
      path: "deck.json",
      name: "deck.json",
    });
    appendEvent(run, "verify", { result: "ok", reason: "12 slides valid" });
    persistTimeline(dir, run);

    const loaded = loadTimeline(dir, run.run_id);
    expect(loaded).toBeDefined();
    expect(loaded?.run_id).toBe(run.run_id);
    expect(loaded?.events).toHaveLength(4);
    expect(loaded?.events.map((e) => e.type)).toEqual([
      "user",
      "task_start",
      "file",
      "verify",
    ]);
    expect(loaded?.events[0]?.payload).toEqual({ text: "buatkan slide skripsi" });
    // Deprecated turns view is synced on load.
    expect(loaded?.turns).toHaveLength(1);
    expect(loaded?.turns[0]?.goal).toBe("deck skripsi");
  });

  test("load returns undefined for unknown ids and drops corrupt entries", () => {
    expect(loadTimeline(dir, "nope")).toBeUndefined();
    expect(loadTimeline(dir, "../evil")).toBeUndefined();
    const run = createWorkflowRun("/ws");
    appendEvent(run, "user", { text: "ok" });
    persistTimeline(dir, run);
    const f = join(dir, "workflow", "runs", `${run.run_id}.json`);
    const raw = JSON.parse(readFileSync(f, "utf8"));
    raw.events.push({ bogus: true }, null, "x");
    writeFileSync(f, JSON.stringify(raw), "utf8");
    const loaded = loadTimeline(dir, run.run_id);
    expect(loaded?.events).toHaveLength(1);
  });

  test("WorkflowRunStore.saveRun/loadRun carry the timeline too", () => {
    const store = new WorkflowRunStore(dir);
    const run = createWorkflowRun("/ws");
    appendEvent(run, "workspace", {
      change: "pindah workspace",
      workspace_root: "/ws2",
    });
    store.saveRun(run);
    const loaded = store.loadRun(run.run_id);
    expect(loaded?.events).toHaveLength(1);
    expect(loaded?.events[0]?.type).toBe("workspace");
  });

  test("legacy run files (turns only) are backfilled into events on load", () => {
    const store = new WorkflowRunStore(dir);
    const run = createWorkflowRun("/ws");
    const turn = appendTurn(run, {
      engine: "coding",
      task_id: "t9",
      goal: "landing page",
      status: "running",
    });
    updateTurn(run, turn.turn_id, { status: "done", note: "build ok" });
    store.saveRun(run);
    // Simulate a pre-timeline file: strip events, keep turns.
    const f = join(dir, "workflow", "runs", `${run.run_id}.json`);
    const raw = JSON.parse(readFileSync(f, "utf8"));
    delete raw.events;
    writeFileSync(f, JSON.stringify(raw), "utf8");

    const loaded = store.loadRun(run.run_id);
    expect(loaded?.events.length).toBeGreaterThan(0);
    expect(loaded?.events.map((e) => e.type)).toContain("task_start");
    expect(loaded?.events.map((e) => e.type)).toContain("task_end");
    // Deprecated view still works after backfill.
    expect(loaded?.turns).toHaveLength(1);
    expect(loaded?.turns[0]?.status).toBe("done");
    expect(loaded?.turns[0]?.note).toBe("build ok");
  });
});

describe("buildModelContext", () => {
  test("25 events → 20 verbatim + one-paragraph deterministic summary", () => {
    const run = createWorkflowRun("/ws");
    appendEvent(run, "user", { text: "buatkan landing page portfolio pakai next.js" });
    appendEvent(run, "task_start", {
      engine: "coding",
      task_id: "t1",
      goal: "landing page portfolio",
    });
    for (let i = 0; i < 6; i++) {
      appendEvent(run, "file", {
        action: "created",
        path: `app/page-${i}.tsx`,
        name: `page-${i}.tsx`,
      });
    }
    appendEvent(run, "verify", { result: "fail", reason: "build error: missing import" });
    appendEvent(run, "error", { message: "npm install timeout" });
    appendEvent(run, "approval", { decision: "granted", summary: "buat 4 file baru" });
    for (let i = 0; i < 14; i++) appendEvent(run, "agent", { text: `progress ${i}` });
    // 1 + 1 + 6 + 1 + 1 + 1 + 14 = 25 events
    expect(getEvents(run)).toHaveLength(25);

    const ctx = buildModelContext(run);
    expect(ctx.recent).toHaveLength(20);
    // Verbatim: last 20, oldest first, full payloads intact.
    expect(ctx.recent[0]?.type).toBe("file");
    expect(ctx.recent[ctx.recent.length - 1]?.type).toBe("agent");
    expect(JSON.stringify(ctx.recent)).toContain("progress 13");
    // Summary covers exactly the 5 older events, in ONE paragraph.
    expect(ctx.summary).not.toContain("\n");
    expect(ctx.summary).toContain("5 events");
    expect(ctx.summary).toContain("1 user message");
    expect(ctx.summary).toContain("1 task started");
    expect(ctx.summary).toContain("landing page portfolio");
    expect(ctx.summary).toContain("page-0.tsx");
  });

  test("summary is empty when everything fits in the verbatim window", () => {
    const run = createWorkflowRun("/ws");
    appendEvent(run, "user", { text: "halo" });
    const ctx = buildModelContext(run);
    expect(ctx.recent).toHaveLength(1);
    expect(ctx.summary).toBe("");
  });

  test("recentCount option is honored", () => {
    const run = createWorkflowRun("/ws");
    for (let i = 0; i < 10; i++) appendEvent(run, "user", { text: `m${i}` });
    const ctx = buildModelContext(run, { recentCount: 3 });
    expect(ctx.recent).toHaveLength(3);
    expect(ctx.recent[0]?.payload).toEqual({ text: "m7" });
    expect(ctx.summary).toContain("7 events");
  });

  test("task_end status wins in the summary; workspace moves named", () => {
    const run = createWorkflowRun("/ws");
    // Meaningful events FIRST so they fall into the older-events window.
    appendEvent(run, "task_start", {
      engine: "slide",
      task_id: "t2",
      goal: "deck skripsi",
    });
    appendEvent(run, "task_end", {
      engine: "slide",
      task_id: "t2",
      goal: "deck skripsi",
      status: "done",
    });
    appendEvent(run, "workspace", {
      change: "pindah workspace",
      workspace_root: "/tesis",
    });
    for (let i = 0; i < 25; i++) appendEvent(run, "agent", { text: `filler ${i}` });
    const ctx = buildModelContext(run);
    // recent = last 20 → the 3 meaningful events are in the older window
    expect(ctx.summary).toContain('slide: "deck skripsi" (done)');
    expect(ctx.summary).toContain("workspace: /tesis");
  });
});

describe("deprecated turns view (derived from timeline)", () => {
  test("appendTurn → task_start event; updateTurn → task_end event", () => {
    const run = createWorkflowRun("/ws");
    expect(run.events).toHaveLength(0);
    const turn = appendTurn(run, {
      engine: "slide",
      task_id: "t1",
      goal: "deck",
      status: "running",
    });
    expect(run.events.map((e) => e.type)).toEqual(["task_start"]);
    expect(turn.status).toBe("running");
    expect(turn.turn_id).toBe(run.events[0]?.id);

    const updated = updateTurn(run, turn.turn_id, {
      status: "done",
      artifacts: [{ kind: "deck", label: "deck", path: "deck/deck.json" }],
      note: "selesai",
    });
    expect(run.events.map((e) => e.type)).toEqual(["task_start", "task_end"]);
    expect(updated?.status).toBe("done");
    expect(updated?.artifacts).toHaveLength(1);
    expect(updated?.note).toBe("selesai");
    expect(updateTurn(run, "missing", { status: "done" })).toBeUndefined();
  });

  test("lastTurn returns the most recent turn", () => {
    const run = createWorkflowRun("/ws");
    expect(lastTurn(run)).toBeUndefined();
    appendTurn(run, { engine: "coding", task_id: "t1", goal: "a", status: "done" });
    const second = appendTurn(run, {
      engine: "slide",
      task_id: "t2",
      goal: "b",
      status: "running",
    });
    expect(lastTurn(run)?.turn_id).toBe(second.turn_id);
  });

  test("turns survive save → load as a derived view", () => {
    const store = new WorkflowRunStore(dir);
    const run = createWorkflowRun("/ws");
    const turn = appendTurn(run, {
      engine: "coding",
      task_id: "t1",
      goal: "buat landing page",
      status: "running",
    });
    store.saveRun(run);
    const loaded = store.loadRun(run.run_id);
    expect(loaded?.turns).toHaveLength(1);
    expect(loaded?.turns[0]?.turn_id).toBe(turn.turn_id);
    expect(loaded?.turns[0]?.status).toBe("running");
  });

  test("syncTurns is idempotent and ignores non-task events", () => {
    const run = createWorkflowRun("/ws");
    appendEvent(run, "user", { text: "hi" });
    appendEvent(run, "verify", { result: "ok", reason: "fine" });
    syncTurns(run);
    syncTurns(run);
    expect(run.turns).toHaveLength(0);
  });
});
