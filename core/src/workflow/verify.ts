import { appendEvent } from "./timeline.ts";
import type { RunContext, WorkflowEngine } from "./types.ts";

/**
 * Dae Captain deterministic verify gate (v2, Fase 2).
 *
 * Design source: "Dae Captain - Master Design.md", Arsitektur Global #2
 * (Verifikasi Deterministik). The rules, verbatim:
 *
 * - The LLM may NOT say "jadi" before the verify gate passes. The gate is
 *   checked by CODE, never by the model.
 * - One framework: the same `VerifyCheck` interface everywhere; each engine
 *   fills in its own checklist.
 * - Success = silent: no "verifikasi lolos" spam. Failure = honest report.
 * - 2x retry for the SAME error on every engine. A different error is a new
 *   step (counter resets).
 * - Tiered verify: cheap `quick` checks first, expensive deep checks only
 *   after every quick check passes.
 * - Every gate result lands in the run timeline as a `verify` event.
 * - Composite verify for cross-engine tasks (research -> slide: report
 *   exists + slides exist + citations carried over).
 *
 * This file is the framework only. Built-in checklists per engine live in
 * `./verify-checks.ts` (`createDefaultVerifyGate()`). Nothing here changes
 * engine runtime behavior — Fase 3 wires the gate into engine execution.
 *
 * Naming note: the master design calls the check outcome `VerifyResult`,
 * but `timeline.ts` already exports `VerifyResult = "ok" | "fail"` (the
 * event payload union, re-exported by `core/src/index.ts`), so the
 * outcome object is named `VerifyCheckResult` here to avoid the clash.
 */

/** Outcome of one deterministic check. */
export type VerifyCheckResult = {
  ok: boolean;
  /** Human-readable failure reason — REQUIRED when ok === false. */
  reason?: string;
  /** Structured detail for debugging / Fase 3 wiring. */
  details?: unknown;
  /**
   * True when the check could not run at all (missing tooling or context).
   * A skipped check does NOT fail the gate; it is recorded separately.
   */
  skipped?: boolean;
};

/** One deterministic check. Checks are pure code — never the model. */
export type VerifyCheck = {
  /** Unique within its engine's checklist, e.g. "slide-pptx-exists". */
  name: string;
  /**
   * Cheap check — runs in the first tier. Deep checks (quick not true) run
   * only after EVERY quick check passes. Mark cheap checks `quick: true`;
   * anything expensive or dependent defaults to the deep tier.
   */
  quick?: boolean;
  run(ctx: VerifyContext): Promise<VerifyCheckResult>;
};

/** One failed check, as reported to fixers and retries. */
export type VerifyFailure = {
  check: string;
  reason: string;
};

/** Aggregated outcome of one `VerifyGate.run()`. */
export type VerifyGateResult = {
  ok: boolean;
  /** Names of checks that passed (skipped checks are NOT listed here). */
  passed: string[];
  /** Names of checks that could not run and were skipped. */
  skipped: string[];
  failures: VerifyFailure[];
};

// ---------------------------------------------------------------------------
// VerifyContext: what each engine hands the gate (filled by Fase 3 wiring).
// ---------------------------------------------------------------------------

export type CodingVerifyData = {
  /** Workspace-relative paths of deliverables that must exist and be non-empty. */
  files: string[];
};

export type SlideVerifyData = {
  /** Workspace-relative .pptx path (default "deck.pptx"). */
  pptxPath?: string;
  /** Workspace-relative deck.json path (default "deck.json"). */
  deckPath?: string;
  /** Expected slide count; when set, the deck must match exactly. */
  expectedSlides?: number;
  /** Max total text chars per slide before the overflow check fails (default 1500). */
  maxCharsPerSlide?: number;
};

export type DokumenVerifyData = {
  /** Extracted fields with per-field confidence (0..1). */
  fields?: Array<{ name: string; confidence: number }>;
  /** Workspace-relative output file path. */
  outputPath?: string;
  /** Minimum accepted confidence (default 0.70, per master design). */
  minConfidence?: number;
};

export type SpreadsheetVerifyData = {
  /** Workspace-relative .xlsx path. */
  xlsxPath?: string;
  /**
   * Flag from the spreadsheet engine's own deterministic verify gate
   * (Analis mode). Fase 2 TRUSTS this flag — it never recomputes numbers.
   */
  numbersVerified?: boolean;
};

export type ResearchVerifyData = {
  /** Report claims; every claim must reference >= 1 source. */
  claims?: Array<{ id: string; sourceIds: string[] }>;
  /**
   * Flag from the research engine's deterministic 7-rule verify gate.
   * Fase 2 checks the flag; the 7 rules stay inside the engine.
   */
  sourcesVerified?: boolean;
};

/**
 * Everything a check may read. `engine` selects the checklist;
 * `workspaceRoot` scopes all file reads; `run` (optional) receives the
 * `verify` timeline events — Fase 3 always sets it.
 */
export type VerifyContext = {
  engine: WorkflowEngine;
  workspaceRoot: string;
  taskId?: string;
  /** Run whose timeline receives `verify` events. */
  run?: RunContext;
  coding?: CodingVerifyData;
  slide?: SlideVerifyData;
  dokumen?: DokumenVerifyData;
  spreadsheet?: SpreadsheetVerifyData;
  research?: ResearchVerifyData;
};

// ---------------------------------------------------------------------------
// VerifyGate
// ---------------------------------------------------------------------------

export type VerifyRunOptions = {
  /**
   * Append the outcome as a `verify` event to `ctx.run`'s timeline.
   * Default true when `ctx.run` is set.
   */
  emitEvent?: boolean;
};

export class VerifyGate {
  private checks = new Map<WorkflowEngine, VerifyCheck[]>();

  /** Register (or replace) the checklist for one engine. Chainable. */
  register(engine: WorkflowEngine, checks: VerifyCheck[]): this {
    const names = new Set<string>();
    for (const c of checks) {
      if (!c.name || typeof c.name !== "string") {
        throw new Error("VerifyCheck.name must be a non-empty string");
      }
      if (names.has(c.name)) {
        throw new Error(`duplicate verify check name "${c.name}" for engine "${engine}"`);
      }
      names.add(c.name);
    }
    this.checks.set(engine, [...checks]);
    return this;
  }

  /** The registered checklist for an engine (empty when none). */
  registered(engine: WorkflowEngine): readonly VerifyCheck[] {
    return this.checks.get(engine) ?? [];
  }

  /**
   * Run the engine's checklist tiered: quick checks first (in registration
   * order), deep checks only if every quick check passes. A throwing check
   * becomes a failure, never a crash. The outcome is appended to the run
   * timeline as a `verify` event when `ctx.run` is set.
   */
  async run(
    engine: WorkflowEngine,
    ctx: VerifyContext,
    opts?: VerifyRunOptions,
  ): Promise<VerifyGateResult> {
    const checks = this.registered(engine);
    const result: VerifyGateResult = { ok: true, passed: [], skipped: [], failures: [] };
    const quick = checks.filter((c) => c.quick === true);
    const deep = checks.filter((c) => c.quick !== true);

    for (const tier of [quick, deep]) {
      for (const check of tier) {
        let r: VerifyCheckResult;
        try {
          r = await check.run(ctx);
        } catch (err) {
          r = { ok: false, reason: `check "${check.name}" error: ${errText(err)}` };
        }
        if (r.skipped) {
          result.skipped.push(check.name);
          continue;
        }
        if (r.ok) {
          result.passed.push(check.name);
        } else {
          result.ok = false;
          result.failures.push({
            check: check.name,
            reason: r.reason ?? `check "${check.name}" gagal tanpa alasan`,
          });
        }
      }
      // Stop before the deep tier when any quick check failed.
      if (!result.ok) break;
    }

    if (opts?.emitEvent !== false && ctx.run) {
      this.emit(ctx, engine, result);
    }
    return result;
  }

  /** Append one `verify` event for a gate outcome. */
  private emit(ctx: VerifyContext, engine: WorkflowEngine, result: VerifyGateResult): void {
    const reason = result.ok
      ? `semua ${result.passed.length} cek lolos (${engine})` +
        (result.skipped.length > 0 ? `; dilewati: ${result.skipped.join(", ")}` : "")
      : result.failures.map((f) => `${f.check}: ${f.reason}`).join("; ");
    appendEvent(ctx.run as RunContext, "verify", {
      result: result.ok ? "ok" : "fail",
      reason,
      ...(ctx.taskId ? { task_id: ctx.taskId } : {}),
    });
  }
}

// ---------------------------------------------------------------------------
// runWithRetry: execute -> verify -> fix, max 2 retries per SAME error.
// ---------------------------------------------------------------------------

/** A task the gate can verify and ask to repair. */
export type RetryableTask = {
  /** Run the task once (an engine execution in Fase 3). */
  execute(): Promise<void>;
  /** Attempt to repair the listed failures before the next attempt. */
  fix(failures: VerifyFailure[]): Promise<void>;
};

export type RetryReport = {
  ok: boolean;
  /** Total execute() calls. */
  attempts: number;
  /** Total fix() calls. */
  fixes: number;
  /** Failures from the last attempt (empty when ok). */
  failures: VerifyFailure[];
};

/** Stable signature of a failure set: same failing checks + same reasons. */
export function failureSignature(failures: VerifyFailure[]): string {
  return failures
    .map((f) => `${f.check}::${f.reason}`)
    .sort()
    .join(" || ");
}

/**
 * Run a task through the verify gate with self-repair.
 *
 * Loop: execute -> gate.run -> ok? done : fix -> again. The SAME error
 * (identical failing checks and reasons) may be retried at most
 * `maxRetries` times (default 2); a DIFFERENT error is a new step and
 * resets the counter. When retries are exhausted, the honest failures are
 * returned — the caller reports them, never claims "jadi".
 */
export async function runWithRetry(
  gate: VerifyGate,
  engine: WorkflowEngine,
  ctx: VerifyContext,
  task: RetryableTask,
  maxRetries = 2,
): Promise<RetryReport> {
  let attempts = 0;
  let fixes = 0;
  let lastSignature: string | null = null;
  let consecutiveSame = 0;
  let lastFailures: VerifyFailure[] = [];

  for (;;) {
    attempts += 1;
    await task.execute();
    const result = await gate.run(engine, ctx);
    if (result.ok) {
      return { ok: true, attempts, fixes, failures: [] };
    }
    lastFailures = result.failures;
    const sig = failureSignature(lastFailures);
    consecutiveSame = sig === lastSignature ? consecutiveSame + 1 : 0;
    lastSignature = sig;
    if (consecutiveSame >= maxRetries) {
      return { ok: false, attempts, fixes, failures: lastFailures };
    }
    await task.fix(lastFailures);
    fixes += 1;
  }
}

// ---------------------------------------------------------------------------
// verifyComposite: cross-engine verify (research -> slide, ...).
// ---------------------------------------------------------------------------

/** One verified sub-task inside a composite verify. */
export type CompositePart = {
  engine: WorkflowEngine | string;
  /** Short label for prefixed check names, e.g. "riset" or "slide". */
  label: string;
  result: VerifyGateResult;
};

/**
 * Combine sub-task verify results for cross-engine work. Fails when ANY
 * part fails; check names are prefixed with the part label so failures stay
 * attributable (e.g. "slide/slide-pptx-exists").
 *
 * A part whose `ok` is false but that contributed no failure entries (e.g.
 * the executor crashed before the gate ran) still fails the composite: a
 * synthetic "<label>/task" failure is added so `ok` never claims success
 * for a part that did not pass.
 */
export function verifyComposite(parts: CompositePart[]): VerifyGateResult {
  const out: VerifyGateResult = { ok: true, passed: [], skipped: [], failures: [] };
  for (const part of parts) {
    out.passed.push(...part.result.passed.map((n) => `${part.label}/${n}`));
    out.skipped.push(...part.result.skipped.map((n) => `${part.label}/${n}`));
    out.failures.push(
      ...part.result.failures.map((f) => ({
        check: `${part.label}/${f.check}`,
        reason: f.reason,
      })),
    );
    if (!part.result.ok && part.result.failures.length === 0) {
      out.failures.push({
        check: `${part.label}/task`,
        reason: "sub-task gagal sebelum verifikasi selesai",
      });
    }
  }
  out.ok = out.failures.length === 0;
  return out;
}

/**
 * Append one `verify` event for a composite result (cross-engine task).
 * Like single-engine emits: ok stays silent in chat, fail reports honestly.
 */
export function emitCompositeVerify(
  run: RunContext,
  label: string,
  composite: VerifyGateResult,
  taskId?: string,
): void {
  const reason = composite.ok
    ? `verify gabungan "${label}" lolos (${composite.passed.length} cek)`
    : `verify gabungan "${label}" gagal: ` +
      composite.failures.map((f) => `${f.check}: ${f.reason}`).join("; ");
  appendEvent(run, "verify", {
    result: composite.ok ? "ok" : "fail",
    reason,
    ...(taskId ? { task_id: taskId } : {}),
  });
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
