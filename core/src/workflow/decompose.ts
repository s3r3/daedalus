import { randomUUID } from "node:crypto";
import { appendEvent } from "./timeline.ts";
import {
  emitCompositeVerify,
  runWithRetry,
  verifyComposite,
  VerifyGate,
} from "./verify.ts";
import type {
  VerifyContext,
  VerifyFailure,
  VerifyGateResult,
  VerifyRunOptions,
} from "./verify.ts";
import { routeByRules } from "./router.ts";
import { resolveReferents } from "./continuation.ts";
import type { ArtifactRef, RunContext, WorkflowEngine } from "./types.ts";

/**
 * Dae Captain task decomposition (v2, Fase 3B).
 *
 * Design source: "Dae Captain - Master Design.md", Arsitektur Global #2.5
 * (Dekomposisi). A multi-engine or multi-step goal is split into sub-tasks
 * with dependencies; independent sub-tasks run in parallel (max 3); every
 * sub-task passes through Fase 2's `runWithRetry` verify gate; one failure
 * never stops the others; the combined outcome is a `verifyComposite()`.
 *
 * Splitting is deterministic (string rules, no model):
 *   - >1 engine OR >3 big steps  -> split into sub-tasks, plan card shown
 *     for multi-engine plans.
 *   - single-engine simple goal   -> ONE sub-task, no plan card.
 *
 * Dependency inference (also deterministic):
 *   - explicit: "dari hasil no.2" / "hasil 1" -> depends on s2 / s1.
 *   - generic:  "dari hasil ..." / "berdasarkan ..." / "pakai data ..."
 *               -> depends on all earlier sub-tasks.
 *   - consumer-after-producer: a slide/dokumen sub-task after a
 *     spreadsheet/research source task depends on that source
 *     ("analisis datanya, bikin slide presentasi" -> slide after analysis).
 *
 * Deeper (implicit, LLM-judged) dependencies are Fase 4's job; Fase 3 only
 * wires what the text states. The plan card lets the user edit order or
 * drop sub-tasks, per the design doc.
 */

/** One sub-task inside a decomposed plan. */
export type SubTask = {
  /** Plan-scoped id: "s1", "s2", ... (stable for "hasil no.2" mapping). */
  id: string;
  engine: WorkflowEngine;
  /** Engine mode, e.g. spreadsheet "analis"/"susun" when known. */
  mode?: string;
  goal: string;
  /** Sub-task ids that must finish (ok or not) before this one starts. */
  dependsOn: string[];
  /** Convenience: first entry of dependsOn, whose result feeds this task. */
  inputFrom?: string;
};

export type TaskPlan = {
  id: string;
  goal: string;
  tasks: SubTask[];
  /**
   * True -> the UI shows the plan card ([Jalankan]). False -> a single
   * task runs directly, no card. Multi-engine plans always show the card;
   * same-engine multi-step plans run silently.
   */
  showPlanCard: boolean;
  /** Artifacts referenced by the goal ("dari X tadi"), from the timeline. */
  contextRefs: ArtifactRef[];
  createdAt: string;
};

// ---------------------------------------------------------------------------
// planTask: goal -> TaskPlan
// ---------------------------------------------------------------------------

const ANALYSIS_RE = /\b(analisis|analisa|analyse|statistik|tren|korelasi)\b/i;
const DATA_WORD_RE =
  /\b(data|dataset|penjualan|angka|keuangan|statistik|invoice)\b/i;
const SUMMARY_WORD_RE = /\b(ringkasan|ringkas|ikhtisar)/i;

/** Fragment routing: layer-A router plus decomposition-specific overrides. */
function routeFragment(fragment: string): {
  engine: WorkflowEngine;
  confidence: number;
  mode?: string;
} {
  const lower = fragment.toLowerCase();
  // "analisis datanya" -> spreadsheet Analis (the router's layer-A verbs do
  // not cover "analisis"; decomposition must, per the Q3 design example).
  if (ANALYSIS_RE.test(lower) && DATA_WORD_RE.test(lower)) {
    return { engine: "spreadsheet", confidence: 0.85, mode: "analis" };
  }
  if (SUMMARY_WORD_RE.test(lower)) {
    return { engine: "dokumen", confidence: 0.8 };
  }
  const r = routeByRules(fragment);
  return {
    engine: r.engine,
    confidence: r.confidence,
    ...(r.engine === "spreadsheet" ? { mode: "susun" } : {}),
  };
}

/** Imperative verbs that start a new clause after a comma. */
const CLAUSE_VERB_RE =
  /^(bikin|buat|buatkan|tulis|tuliskan|tambah|tambahkan|ubah|analisis|analisa|riset|ekstrak|bandingkan|hitung|hapus|ganti|perbaiki)\b/i;
const CONJUNCTION_RE =
  /\s+(?:dan|serta|plus|sama|lalu|terus|trus|kemudian|&|\+)\s+/i;

/** Split conjunction-joined clauses only when they route to different engines. */
function splitConjunctions(part: string): string[] {
  const clauses = part
    .split(CONJUNCTION_RE)
    .map((c) => c.replace(/^(?:dan|serta|sama|lalu|terus|trus|kemudian)\s+/i, "").trim())
    .filter((c) => c.length >= 4);
  if (clauses.length < 2) return [part];
  const engines = new Set(clauses.map((c) => routeFragment(c).engine));
  return engines.size > 1 ? clauses : [part];
}

/**
 * Split a goal into candidate sub-task fragments: numbered/bullet lists,
 * semicolons, newlines, comma+imperative clauses, and engine-diverging
 * conjunctions. Exported for tests; `planTask` decides whether to split.
 */
export function splitGoalFragments(goal: string): string[] {
  let parts: string[];
  const lines = goal.split(/\n/);
  if (lines.some((l) => /^\s*(?:\d+[.)]|[-•*])\s+\S/.test(l))) {
    parts = lines
      .map((l) => l.replace(/^\s*(?:\d+[.)]|[-•*])\s+/, "").trim())
      .filter((l) => l.length > 0);
  } else {
    parts = goal.split(/;/).map((s) => s.trim()).filter((s) => s.length > 0);
  }
  const out: string[] = [];
  for (const part of parts) {
    // "analisis datanya, bikin slide presentasi" -> two fragments when the
    // post-comma clause starts with an imperative verb.
    const commaSplit = part
      .split(/,(?=\s*[a-z])/i)
      .map((c) => c.trim())
      .filter((c) => c.length > 0);
    const glued: string[] = [];
    let current = "";
    for (const c of commaSplit) {
      if (current && CLAUSE_VERB_RE.test(c)) {
        glued.push(current);
        current = c;
      } else {
        current = current ? `${current}, ${c}` : c;
      }
    }
    if (current) glued.push(current);
    for (const g of glued) out.push(...splitConjunctions(g));
  }
  return out.map((f) => f.replace(/[,\s]+$/, "").trim()).filter((f) => f.length > 0);
}

/** "dari hasil no.2" / "hasil 1" — explicit numbered dependency. */
const NUMBERED_DEP_RE =
  /(?:dari\s+hasil|hasil|dari\s+no|no\.?)\s*(\d+)/gi;
/** "dari hasil ..." / "berdasarkan ..." / "pakai data ..." — generic dependency. */
const GENERIC_DEP_RE =
  /\b(dari|berdasarkan|pakai|memakai|menggunakan|dengan\s+memakai)\b[^.!?]{0,48}\b(hasil|data|analisis|analisa|temuan|riset|output|dokumen|dataset)\b/i;

const PRODUCER_ENGINES: ReadonlySet<WorkflowEngine> = new Set([
  "spreadsheet",
  "research",
]);
const CONSUMER_ENGINES: ReadonlySet<WorkflowEngine> = new Set([
  "slide",
  "dokumen",
]);

function inferDeps(
  task: SubTask,
  index: number,
  tasks: SubTask[],
): string[] {
  const deps = new Set<string>();
  const earlier = tasks.slice(0, index);

  // Explicit numbered refs: "dari hasil no.2" -> s2.
  NUMBERED_DEP_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = NUMBERED_DEP_RE.exec(task.goal)) !== null) {
    const id = `s${m[1]}`;
    if (id !== task.id && tasks.some((t) => t.id === id)) deps.add(id);
  }

  // Generic cross-refs: "berdasarkan analisis ..." -> all earlier tasks.
  if (GENERIC_DEP_RE.test(task.goal)) {
    for (const e of earlier) deps.add(e.id);
  }

  // Consumer-after-producer: slide/dokumen after a spreadsheet/research
  // source task depends on that source.
  if (CONSUMER_ENGINES.has(task.engine)) {
    for (const e of earlier) {
      if (PRODUCER_ENGINES.has(e.engine)) deps.add(e.id);
    }
  }

  return [...deps];
}

/**
 * Split a goal into an executable plan. Single-engine simple goals come
 * back as ONE sub-task with `showPlanCard: false` (no card, no ceremony).
 */
export function planTask(goal: string, timeline?: RunContext): TaskPlan {
  const planId = randomUUID();
  const fragments = splitGoalFragments(goal);
  const routed = fragments.map((fragment) => ({
    fragment,
    ...routeFragment(fragment),
  }));
  const engines = new Set(routed.map((r) => r.engine));
  const needsSplit =
    routed.length > 1 && (engines.size > 1 || routed.length > 3);

  if (!needsSplit) {
    const single = routeFragment(goal);
    return {
      id: planId,
      goal,
      tasks: [
        {
          id: "s1",
          engine: single.engine,
          ...(single.mode ? { mode: single.mode } : {}),
          goal,
          dependsOn: [],
        },
      ],
      showPlanCard: false,
      contextRefs: resolveReferents(goal, timeline).referents,
      createdAt: new Date().toISOString(),
    };
  }

  const tasks: SubTask[] = routed.map((r, i) => ({
    id: `s${i + 1}`,
    engine: r.engine,
    ...(r.mode ? { mode: r.mode } : {}),
    goal: r.fragment,
    dependsOn: [],
  }));
  for (let i = 0; i < tasks.length; i++) {
    const deps = inferDeps(tasks[i]!, i, tasks);
    tasks[i]!.dependsOn = deps;
    if (deps.length > 0) tasks[i]!.inputFrom = deps[0];
  }
  return {
    id: planId,
    goal,
    tasks,
    showPlanCard: engines.size > 1,
    contextRefs: resolveReferents(goal, timeline).referents,
    createdAt: new Date().toISOString(),
  };
}

// ---------------------------------------------------------------------------
// executePlan: run a plan through the verify gate
// ---------------------------------------------------------------------------

/** What one engine execution hands back. */
export type SubTaskExecution = {
  /**
   * Engine-specific verify payload merged into the VerifyContext built
   * from this sub-task's result, e.g. `{ coding: { files: [...] } }`.
   */
  verifyData?: Partial<
    Omit<VerifyContext, "engine" | "workspaceRoot" | "taskId" | "run">
  >;
  /** Opaque result handed to dependent sub-tasks. */
  data?: unknown;
  /** Artifact refs recorded on the task_end timeline event. */
  artifacts?: ArtifactRef[];
};

/** One engine's executor for sub-tasks routed to it. */
export type SubTaskExecutor = {
  engine: WorkflowEngine;
  execute(
    subtask: SubTask,
    deps: ReadonlyMap<string, SubTaskResult>,
  ): Promise<SubTaskExecution>;
  fix?(
    subtask: SubTask,
    failures: VerifyFailure[],
    deps: ReadonlyMap<string, SubTaskResult>,
  ): Promise<void>;
};

export type SubTaskResult = {
  ok: boolean;
  /** Total execute() calls (Fase 2 retry accounting). */
  attempts: number;
  /** Last verify gate outcome for this sub-task. */
  verify: VerifyGateResult;
  /** Failures from the last attempt (empty when ok). */
  failures: VerifyFailure[];
  data?: unknown;
  /** Human error summary when !ok. */
  error?: string;
};

export type PlanProgress = {
  done: number;
  total: number;
  failed: number;
  pending: number;
};

/** Combined progress for chat + pill. */
export function getPlanProgress(
  plan: TaskPlan,
  results: ReadonlyMap<string, SubTaskResult>,
): PlanProgress {
  let done = 0;
  let failed = 0;
  for (const r of results.values()) {
    if (r.ok) done++;
    else failed++;
  }
  return {
    done,
    total: plan.tasks.length,
    failed,
    pending: plan.tasks.length - results.size,
  };
}

export type PlanExecutionOptions = {
  /** Run whose timeline receives task_start/task_end/verify events. */
  run?: RunContext;
  /** Workspace root for file-scoped verify checks. */
  workspaceRoot?: string;
  /** Parallel cap for independent sub-tasks (design: max 3). */
  maxParallel?: number;
  /** Fase 2 self-repair retries per sub-task (default 2). */
  maxRetries?: number;
  /** Progress callback for chat/pill. */
  onProgress?: (p: PlanProgress) => void;
};

export type PlanExecution = {
  planId: string;
  results: Map<string, SubTaskResult>;
  failures: Array<{ taskId: string; failures: VerifyFailure[]; error?: string }>;
  composite: VerifyGateResult;
  ok: boolean;
  progress: PlanProgress;
};

/** Design cap: at most 3 sub-tasks run at the same time. */
export const MAX_PARALLEL = 3;

/** Records the last gate outcome so executePlan can build the composite. */
class RecordingGate extends VerifyGate {
  lastResult?: VerifyGateResult;
  private readonly inner: VerifyGate;
  constructor(inner: VerifyGate) {
    super();
    this.inner = inner;
  }
  override async run(
    engine: WorkflowEngine,
    ctx: VerifyContext,
    opts?: VerifyRunOptions,
  ): Promise<VerifyGateResult> {
    const r = await this.inner.run(engine, ctx, opts);
    this.lastResult = r;
    return r;
  }
}

const EMPTY_VERIFY: VerifyGateResult = {
  ok: false,
  passed: [],
  skipped: [],
  failures: [],
};

function asExecutors(
  executors: Record<WorkflowEngine, SubTaskExecutor> | SubTaskExecutor[],
): Map<WorkflowEngine, SubTaskExecutor> {
  if (Array.isArray(executors)) {
    return new Map(executors.map((e) => [e.engine, e]));
  }
  return new Map(
    (Object.keys(executors) as WorkflowEngine[]).map((k) => [k, executors[k]!]),
  );
}

/**
 * Execute a plan: sub-tasks run in dependency order; independent ones run
 * in parallel (max 3). Every sub-task goes through `runWithRetry` with a
 * VerifyContext filled from that sub-task's own execution result, and
 * lands `task_start` / `task_end` / `verify` events on the timeline.
 *
 * One sub-task failing never stops the others — failures are collected and
 * the combined outcome is a `verifyComposite()`.
 */
export async function executePlan(
  plan: TaskPlan,
  executors: Record<WorkflowEngine, SubTaskExecutor> | SubTaskExecutor[],
  gate: VerifyGate,
  opts: PlanExecutionOptions = {},
): Promise<PlanExecution> {
  const byEngine = asExecutors(executors);
  const maxParallel = Math.max(
    1,
    Math.min(opts.maxParallel ?? MAX_PARALLEL, MAX_PARALLEL),
  );
  const maxRetries = opts.maxRetries ?? 2;
  const workspaceRoot = opts.workspaceRoot ?? opts.run?.workspace_root ?? "";
  const results = new Map<string, SubTaskResult>();
  const pending = new Set(plan.tasks.map((t) => t.id));
  const report = (p: PlanProgress) => opts.onProgress?.(p);

  const runOne = async (sub: SubTask): Promise<SubTaskResult> => {
    const executor = byEngine.get(sub.engine);
    if (!executor) {
      return {
        ok: false,
        attempts: 0,
        verify: EMPTY_VERIFY,
        failures: [],
        error: `tidak ada executor untuk engine "${sub.engine}"`,
      };
    }
    if (opts.run) {
      appendEvent(opts.run, "task_start", {
        engine: sub.engine,
        task_id: sub.id,
        goal: sub.goal,
        note: `rencana ${plan.id}`,
      });
    }
    const ctx: VerifyContext = {
      engine: sub.engine,
      workspaceRoot,
      taskId: sub.id,
      ...(opts.run ? { run: opts.run } : {}),
    };
    let exec: SubTaskExecution = {};
    const recording = new RecordingGate(gate);
    let retryReport: { ok: boolean; attempts: number; failures: VerifyFailure[] };
    try {
      retryReport = await runWithRetry(
        recording,
        sub.engine,
        ctx,
        {
          execute: async () => {
            exec = await executor.execute(sub, results);
            // The verify context is filled FROM this sub-task's result.
            Object.assign(ctx, exec.verifyData ?? {});
          },
          fix: async (failures) => {
            await executor.fix?.(sub, failures, results);
          },
        },
        maxRetries,
      );
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      const failed: SubTaskResult = {
        ok: false,
        attempts: 0,
        verify: EMPTY_VERIFY,
        failures: [],
        error,
      };
      if (opts.run) {
        appendEvent(opts.run, "task_end", {
          engine: sub.engine,
          task_id: sub.id,
          goal: sub.goal,
          status: "failed",
          note: error,
        });
      }
      return failed;
    }
    const verify = recording.lastResult ?? {
      ...EMPTY_VERIFY,
      failures: retryReport.failures,
      ok: retryReport.ok,
    };
    const result: SubTaskResult = {
      ok: retryReport.ok,
      attempts: retryReport.attempts,
      verify,
      failures: retryReport.failures,
      ...(exec.data !== undefined ? { data: exec.data } : {}),
      ...(!retryReport.ok
        ? {
            error: retryReport.failures
              .map((f) => `${f.check}: ${f.reason}`)
              .join("; "),
          }
        : {}),
    };
    if (opts.run) {
      appendEvent(opts.run, "task_end", {
        engine: sub.engine,
        task_id: sub.id,
        goal: sub.goal,
        status: result.ok ? "done" : "failed",
        ...(exec.artifacts ? { artifacts: exec.artifacts } : {}),
        ...(result.error ? { note: result.error } : {}),
      });
    }
    return result;
  };

  // Kahn-style scheduling: every round runs all dependency-satisfied
  // sub-tasks, up to maxParallel. A failed sub-task still "satisfies"
  // dependents — one failure never stops the others. Unresolvable
  // dependencies (unknown ids, cycles) fail the stuck tasks honestly.
  while (pending.size > 0) {
    const ready = plan.tasks.filter(
      (t) => pending.has(t.id) && t.dependsOn.every((d) => results.has(d)),
    );
    if (ready.length === 0) {
      for (const t of plan.tasks.filter((t) => pending.has(t.id))) {
        const missing = t.dependsOn.filter(
          (d) => !results.has(d) && !plan.tasks.some((x) => x.id === d),
        );
        results.set(t.id, {
          ok: false,
          attempts: 0,
          verify: EMPTY_VERIFY,
          failures: [],
          error:
            missing.length > 0
              ? `dependensi tidak dikenal: ${missing.join(", ")}`
              : "dependensi sirkular — tidak bisa dijadwalkan",
        });
        pending.delete(t.id);
      }
      break;
    }
    const batch = ready.slice(0, maxParallel);
    const settled = await Promise.all(
      batch.map(async (t) => ({ t, r: await runOne(t) })),
    );
    for (const { t, r } of settled) {
      pending.delete(t.id);
      results.set(t.id, r);
    }
    report(getPlanProgress(plan, results));
  }

  const composite = verifyComposite(
    plan.tasks.map((t) => ({
      engine: t.engine,
      label: t.id,
      result: results.get(t.id)?.verify ?? EMPTY_VERIFY,
    })),
  );
  if (opts.run) {
    emitCompositeVerify(opts.run, `rencana ${plan.id}`, composite, plan.id);
  }
  const failures = plan.tasks
    .filter((t) => !results.get(t.id)?.ok)
    .map((t) => {
      const r = results.get(t.id)!;
      return {
        taskId: t.id,
        failures: r.failures,
        ...(r.error ? { error: r.error } : {}),
      };
    });
  const progress = getPlanProgress(plan, results);
  return {
    planId: plan.id,
    results,
    failures,
    composite,
    ok: composite.ok,
    progress,
  };
}
