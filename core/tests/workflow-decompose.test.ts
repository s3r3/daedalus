import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import {
  MAX_PARALLEL,
  executePlan,
  getPlanProgress,
  planTask,
  splitGoalFragments,
  VerifyGate,
  createWorkflowRun,
} from "../src/workflow/index.ts";
import type {
  AnyTimelineEvent,
  SubTask,
  SubTaskExecutor,
  SubTaskResult,
  TaskPlan,
  TimelineEvent,
  WorkflowEngine,
} from "../src/workflow/index.ts";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "dae-captain-decompose-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Gate whose checks always pass — records outcomes without failing. */
function passingGate(): VerifyGate {
  const gate = new VerifyGate();
  for (const e of ["coding", "slide", "dokumen", "spreadsheet", "research"] as const) {
    gate.register(e, [{ name: "always-ok", quick: true, run: async () => ({ ok: true }) }]);
  }
  return gate;
}

function okExecutor(
  engine: WorkflowEngine,
  hooks: {
    onExecute?: (sub: SubTask, active: { n: number }) => void | Promise<void>;
  } = {},
): SubTaskExecutor {
  return {
    engine,
    execute: async (sub) => {
      await hooks.onExecute?.(sub, { n: 0 });
      return { data: `hasil ${sub.id}` };
    },
  };
}

function planOf(...tasks: SubTask[]): TaskPlan {
  return {
    id: "plan-test",
    goal: "test",
    tasks,
    showPlanCard: false,
    contextRefs: [],
    createdAt: new Date().toISOString(),
  };
}

function independentTasks(n: number, engine: WorkflowEngine = "coding"): SubTask[] {
  return Array.from({ length: n }, (_, i) => ({
    id: `s${i + 1}`,
    engine,
    goal: `task ${i + 1}`,
    dependsOn: [],
  }));
}

// ---------------------------------------------------------------------------
// planTask
// ---------------------------------------------------------------------------

describe("planTask", () => {
  test("single-engine simple goal -> one sub-task, no plan card", () => {
    const plan = planTask("buatkan landing page portfolio pakai next.js");
    expect(plan.tasks).toHaveLength(1);
    expect(plan.tasks[0]!.engine).toBe("coding");
    expect(plan.tasks[0]!.goal).toBe("buatkan landing page portfolio pakai next.js");
    expect(plan.showPlanCard).toBe(false);
  });

  test("same-engine conjunctions do NOT split", () => {
    const plan = planTask("buatkan API dan buatkan dokumentasinya");
    expect(plan.tasks).toHaveLength(1);
    expect(plan.showPlanCard).toBe(false);
  });

  test("multi-engine Q3 example -> 3 sub-tasks with dependencies", () => {
    const plan = planTask(
      "buatkan laporan penjualan Q3: analisis datanya, bikin slide presentasi, sama tulis ringkasannya",
    );
    expect(plan.tasks).toHaveLength(3);
    expect(plan.tasks.map((t) => t.engine)).toEqual([
      "spreadsheet",
      "slide",
      "dokumen",
    ]);
    expect(plan.tasks[0]!.mode).toBe("analis");
    // consumer-after-producer: slide + dokumen depend on the analysis
    expect(plan.tasks[1]!.dependsOn).toContain("s1");
    expect(plan.tasks[2]!.dependsOn).toContain("s1");
    // ...but not on each other -> they run in parallel
    expect(plan.tasks[1]!.dependsOn).not.toContain("s3");
    expect(plan.tasks[2]!.dependsOn).not.toContain("s2");
    expect(plan.showPlanCard).toBe(true);
  });

  test(">3 big steps split even on one engine", () => {
    const plan = planTask("1. setup proyek\n2. tulis kode\n3. tulis test\n4. jalankan build");
    expect(plan.tasks).toHaveLength(4);
    expect(plan.showPlanCard).toBe(false);
  });

  test('explicit "dari hasil no.N" wires the dependency', () => {
    const plan = planTask(
      "1. riset framework A\n2. buatkan slide dari hasil no.1",
    );
    expect(plan.tasks).toHaveLength(2);
    expect(plan.tasks[1]!.dependsOn).toContain("s1");
  });

  test('generic "berdasarkan ..." depends on earlier tasks', () => {
    const plan = planTask(
      "analisis data penjualan; buatkan slide berdasarkan analisis tersebut",
    );
    expect(plan.tasks).toHaveLength(2);
    expect(plan.tasks[1]!.dependsOn).toContain("s1");
  });

  test("sub-task ids are stable s1..sN", () => {
    const plan = planTask("analisis data penjualan; buatkan slide presentasi");
    expect(plan.tasks.map((t) => t.id)).toEqual(["s1", "s2"]);
  });
});

describe("splitGoalFragments", () => {
  test("comma + imperative clause splits", () => {
    expect(
      splitGoalFragments("analisis datanya, bikin slide presentasi"),
    ).toEqual(["analisis datanya", "bikin slide presentasi"]);
  });
  test("plain sentence stays whole", () => {
    expect(splitGoalFragments("buatkan landing page portfolio")).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// executePlan
// ---------------------------------------------------------------------------

describe("executePlan", () => {
  test("independent tasks run in parallel, capped at MAX_PARALLEL", async () => {
    expect(MAX_PARALLEL).toBe(3);
    let active = 0;
    let maxActive = 0;
    const executor: SubTaskExecutor = {
      engine: "coding",
      execute: async () => {
        active++;
        maxActive = Math.max(maxActive, active);
        await sleep(25);
        active--;
        return {};
      },
    };
    const plan = planOf(...independentTasks(4));
    const exec = await executePlan(plan, [executor], passingGate(), {
      workspaceRoot: dir,
    });
    expect(exec.ok).toBe(true);
    expect(exec.results.size).toBe(4);
    expect(maxActive).toBe(3);
    expect(maxActive).toBeLessThanOrEqual(MAX_PARALLEL);
  });

  test("dependencies are respected: s2 starts after s1 finishes", async () => {
    const order: string[] = [];
    const mk = (engine: WorkflowEngine): SubTaskExecutor => ({
      engine,
      execute: async (sub, deps) => {
        order.push(`start ${sub.id}`);
        await sleep(10);
        // dependent sees the dependency's result
        if (sub.id === "s2") {
          expect(deps.get("s1")?.ok).toBe(true);
          expect(deps.get("s1")?.data).toBe("hasil s1");
        }
        order.push(`end ${sub.id}`);
        return { data: `hasil ${sub.id}` };
      },
    });
    const plan = planOf(
      { id: "s1", engine: "coding", goal: "analisis", dependsOn: [] },
      { id: "s2", engine: "slide", goal: "slide", dependsOn: ["s1"], inputFrom: "s1" },
    );
    const exec = await executePlan(
      plan,
      [mk("coding"), mk("slide")],
      passingGate(),
      { workspaceRoot: dir },
    );
    expect(exec.ok).toBe(true);
    expect(order.indexOf("start s2")).toBeGreaterThan(order.indexOf("end s1"));
  });

  test("one failure does not stop the others; failures are collected", async () => {
    const ran: string[] = [];
    const executors: SubTaskExecutor[] = [
      {
        engine: "coding",
        execute: async (sub) => {
          ran.push(sub.id);
          return {};
        },
      },
      {
        engine: "slide",
        execute: async (sub) => {
          ran.push(sub.id);
          throw new Error("slide engine meledak");
        },
      },
      {
        engine: "dokumen",
        execute: async (sub) => {
          ran.push(sub.id);
          return {};
        },
      },
    ];
    const plan = planOf(...independentTasks(1, "coding"), ...[
      { id: "s2", engine: "slide" as WorkflowEngine, goal: "slide", dependsOn: [] as string[] },
      { id: "s3", engine: "dokumen" as WorkflowEngine, goal: "dokumen", dependsOn: [] as string[] },
    ]);
    const exec = await executePlan(plan, executors, passingGate(), {
      workspaceRoot: dir,
    });
    expect(exec.ok).toBe(false);
    expect(ran).toContain("s1");
    expect(ran).toContain("s2");
    expect(ran).toContain("s3");
    expect(exec.failures).toHaveLength(1);
    expect(exec.failures[0]!.taskId).toBe("s2");
    expect(exec.failures[0]!.error).toContain("meledak");
    expect(exec.results.get("s1")!.ok).toBe(true);
    expect(exec.results.get("s3")!.ok).toBe(true);
    expect(exec.composite.ok).toBe(false);
  });

  test("verify failure retries via runWithRetry (2 fixes, 3 attempts)", async () => {
    let fixes = 0;
    const gate = new VerifyGate().register("coding", [
      {
        name: "always-fails",
        quick: true,
        run: async () => ({ ok: false, reason: "tetap gagal" }),
      },
    ]);
    const executor: SubTaskExecutor = {
      engine: "coding",
      execute: async () => ({}),
      fix: async () => {
        fixes++;
      },
    };
    const plan = planOf(...independentTasks(1));
    const exec = await executePlan(plan, [executor], gate, {
      workspaceRoot: dir,
      maxRetries: 2,
    });
    const r = exec.results.get("s1")!;
    expect(r.ok).toBe(false);
    expect(r.attempts).toBe(3);
    expect(fixes).toBe(2);
    expect(r.failures[0]!.reason).toBe("tetap gagal");
  });

  test("timeline gets task_start / task_end / verify events per sub-task", async () => {
    const run = createWorkflowRun(dir);
    const plan = planOf(...independentTasks(2));
    await executePlan(plan, [okExecutor("coding")], passingGate(), { run });
    const types = run.events.map((e: AnyTimelineEvent) => e.type);
    expect(types.filter((t) => t === "task_start")).toHaveLength(2);
    expect(types.filter((t) => t === "task_end")).toHaveLength(2);
    // one verify event per gate run (2) + one composite
    expect(types.filter((t) => t === "verify").length).toBeGreaterThanOrEqual(3);
    const ends = run.events.filter(
      (e): e is TimelineEvent<"task_end"> => e.type === "task_end",
    );
    expect(ends.every((e) => e.payload.status === "done")).toBe(true);
  });

  test("unresolvable dependency fails the stuck task honestly", async () => {
    const plan = planOf({
      id: "s1",
      engine: "coding",
      goal: "x",
      dependsOn: ["s9"],
    });
    const exec = await executePlan(plan, [okExecutor("coding")], passingGate(), {
      workspaceRoot: dir,
    });
    expect(exec.ok).toBe(false);
    expect(exec.results.get("s1")!.error).toContain("s9");
  });

  test("onProgress reports combined progress", async () => {
    const seen: Array<{ done: number; total: number }> = [];
    const plan = planOf(...independentTasks(2));
    await executePlan(plan, [okExecutor("coding")], passingGate(), {
      workspaceRoot: dir,
      onProgress: (p) => seen.push({ done: p.done, total: p.total }),
    });
    expect(seen.length).toBeGreaterThanOrEqual(1);
    const last = seen[seen.length - 1]!;
    expect(last.done).toBe(2);
    expect(last.total).toBe(2);
  });
});

describe("getPlanProgress", () => {
  test("{ done, total } from results", () => {
    const plan = planOf(...independentTasks(3));
    const results = new Map<string, SubTaskResult>([
      ["s1", { ok: true, attempts: 1, verify: { ok: true, passed: ["x"], skipped: [], failures: [] }, failures: [] }],
      ["s2", { ok: false, attempts: 3, verify: { ok: false, passed: [], skipped: [], failures: [{ check: "c", reason: "r" }] }, failures: [{ check: "c", reason: "r" }] }],
    ]);
    const p = getPlanProgress(plan, results);
    expect(p.done).toBe(1);
    expect(p.total).toBe(3);
    expect(p.failed).toBe(1);
    expect(p.pending).toBe(1);
  });
});
