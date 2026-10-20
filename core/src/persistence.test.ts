// Unit tests for TaskStore pause markers (Dae Captain pill ⏸, Fase 6).
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TaskStore } from "./persistence.ts";

describe("TaskStore pause markers", () => {
  let dir: string;
  let store: TaskStore;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "pause-test-"));
    store = new TaskStore(dir);
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("not paused by default", () => {
    expect(store.isPauseRequested("task-1")).toBe(false);
  });

  it("requestPause / isPauseRequested / clearPause round-trip", () => {
    store.requestPause("task-1");
    expect(store.isPauseRequested("task-1")).toBe(true);
    store.clearPause("task-1");
    expect(store.isPauseRequested("task-1")).toBe(false);
  });

  it("clearPause on a non-paused task does not throw", () => {
    expect(() => store.clearPause("task-1")).not.toThrow();
  });

  it("pause markers are per-task", () => {
    store.requestPause("task-1");
    expect(store.isPauseRequested("task-2")).toBe(false);
  });

  it("waitWhilePaused resolves immediately when not paused", async () => {
    const start = Date.now();
    await store.waitWhilePaused("task-1");
    expect(Date.now() - start).toBeLessThan(200);
  });

  it("waitWhilePaused blocks until clearPause", async () => {
    store.requestPause("task-1");
    let resolved = false;
    const p = store.waitWhilePaused("task-1").then(() => {
      resolved = true;
    });
    await new Promise((r) => setTimeout(r, 900));
    expect(resolved).toBe(false);
    expect(store.isPauseRequested("task-1")).toBe(true);
    store.clearPause("task-1");
    await p;
    expect(resolved).toBe(true);
  });

  it("lastEventText reads the latest narration", () => {
    // No events file → empty, never throws.
    expect(store.lastEventText("task-1")).toBe("");
  });
});
