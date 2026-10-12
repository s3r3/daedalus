import { randomUUID } from "node:crypto";
import { createProviderForConfig } from "@daedalus/core";
import type {
  EventBus,
  LLMProvider,
  TaskStore,
  WorkbookSpec,
} from "@daedalus/core";
// Contract types from the parallel core worker (core/src/sheets/analysis-*).
// Type-only imports: erased at runtime, so the missing modules break
// typecheck (expected until the core worker lands) but never break
// runtime or tests. Value access goes through the lazy dynamic imports
// in defaultAnalysisHooks() below.
import type { AnalysisPlan } from "@daedalus/core/sheets/analysis-plan.ts";
import type { DatasetProfile } from "@daedalus/core/sheets/analysis-profile.ts";
import type { InsightReport } from "@daedalus/core/sheets/insight-report.ts";
import type { AppContext } from "./app.ts";

/**
 * Mode Analis (Agentic Spreadsheet) — server-side staging + run plumbing.
 *
 * The design (Desain-Agentic-Spreadsheet-Analis-v1.md) puts exactly ONE
 * confirmation gate in the flow, at the plan: POST /sheets/analyze/plan
 * stages the analysis plan for review, and the user pressing
 * "Jalankan analisis" calls POST /sheets/analyze/run. After the gate,
 * compute → verify → report is deterministic machinery, not a user
 * decision. Every number in the report has passed the Verify gate —
 * a verify failure surfaces as 422 and no report is ever returned
 * with unverified numbers.
 *
 * Hard boundary (check.sh): this file must never import the coding
 * agent loop, a provider class, or the tool registry directly. All LLM
 * access flows through @daedalus/core — provider objects are built with
 * the core's createProviderForConfig (the same pattern as the
 * /diff/review route), and the engine itself is constructed from the
 * core's SpreadsheetEngine via the AnalysisCoreHooks seam.
 */

/** Dataset descriptor the staged plan carries into the engine run. */
export type AnalysisDataset =
  | { kind: "csv"; text: string; name?: string }
  | { kind: "xlsx"; base64: string; name?: string }
  | { kind: "workbook"; key: string };

/**
 * Intent routing verdict (call 1 of the two-call planner). Shape mirrors
 * the core contract: routing + complexity estimate → retry budget.
 */
export type AnalysisIntent = {
  kind: string;
  complexity: "simple" | "moderate" | "complex";
  retryBudget: number;
};

/** Result of engine.runAnalysis per the core contract. */
export type AnalysisRunResult = {
  workbook: WorkbookSpec;
  verify: { ok: boolean; summary: string; errors: unknown[]; warnings: unknown[] };
  report: InsightReport;
  exported?: { path: string; bytes: number };
};

/** Engine surface the server needs (provided by core's SpreadsheetEngine.runAnalysis). */
export type AnalysisEngine = {
  runAnalysis(args: {
    question: string;
    /** Already-ingested workbook — the engine analyzes this directly. */
    dataset: WorkbookSpec;
    plan: AnalysisPlan;
    provider: LLMProvider;
  }): Promise<AnalysisRunResult>;
};

/**
 * Seam between the HTTP layer and the core contract. Production uses
 * defaultAnalysisHooks() (lazy dynamic imports of the core contract
 * modules); tests inject fakes through AppContext.analysisHooks.
 */
export type AnalysisCoreHooks = {
  importCsv(title: string, text: string, opts: { createdBy: string }): WorkbookSpec | Promise<WorkbookSpec>;
  importXlsx(title: string, buffer: Buffer, opts: { createdBy: string }): Promise<WorkbookSpec> | WorkbookSpec;
  profileWorkbook(workbook: WorkbookSpec): Promise<DatasetProfile[]>;
  classifyIntent(args: {
    question: string;
    profiles: DatasetProfile[];
    provider: LLMProvider;
  }): Promise<AnalysisIntent>;
  generatePlan(args: {
    question: string;
    profiles: DatasetProfile[];
    intent: AnalysisIntent;
    provider: LLMProvider;
  }): Promise<AnalysisPlan>;
  createEngine(deps: {
    provider: LLMProvider;
    bus: EventBus;
    store: TaskStore;
    workspaceRoot: string;
  }): Promise<AnalysisEngine>;
};

/**
 * Production hooks: every value import is lazy so that requiring this
 * module never touches the core contract modules — they are only loaded
 * when a real (non-test) request flows through without injected fakes.
 */
export function defaultAnalysisHooks(): AnalysisCoreHooks {
  return {
    importCsv: async (title, text, opts) => {
      const mod = await import("@daedalus/core/sheets/import.ts");
      return mod.importCsvToWorkbook(title, text, opts);
    },
    importXlsx: async (title, buffer, opts) => {
      const mod = await import("@daedalus/core/sheets/import.ts");
      return mod.importXlsxToWorkbook(title, buffer, opts);
    },
    profileWorkbook: async (workbook) => {
      const mod = await import("@daedalus/core/sheets/analysis-profile.ts");
      return mod.profileWorkbook(workbook);
    },
    classifyIntent: async ({ question, profiles, provider }) => {
      const [mod, pipeline] = await Promise.all([
        import("@daedalus/core/sheets/analysis-plan.ts"),
        import("@daedalus/core/sheets/pipeline.ts"),
      ]);
      // Core signature is positional (provider, question, profiles);
      // retry budget = MAX_STAGE_ATTEMPTS per the final decision.
      const { complexity } = await mod.classifyAnalysisIntent(provider, question, profiles);
      return { kind: "analysis", complexity, retryBudget: pipeline.MAX_STAGE_ATTEMPTS };
    },
    generatePlan: async ({ question, profiles, provider }) => {
      const mod = await import("@daedalus/core/sheets/analysis-plan.ts");
      return mod.generateAnalysisPlan(provider, question, profiles);
    },
    createEngine: async ({ provider, bus, store, workspaceRoot }) => {
      const [{ SpreadsheetEngine }, core] = await Promise.all([
        import("@daedalus/core/sheets/engine.ts"),
        import("@daedalus/core"),
      ]);
      const engine = new SpreadsheetEngine({
        provider,
        bus,
        store,
        questions: new core.QuestionBroker(),
        workspaceRoot,
      });
      // runAnalysis() is the parallel core worker's new entry point;
      // the cast keeps this file compiling against the contract shape
      // until the method lands in core.
      return engine as unknown as AnalysisEngine;
    },
  };
}

export async function resolveAnalysisHooks(ctx: AppContext): Promise<AnalysisCoreHooks> {
  return ctx.analysisHooks ?? defaultAnalysisHooks();
}

/**
 * Provider resolution for Analis requests — the same pattern as the
 * /diff/review route: explicit provider_id/model in the body, then the
 * session selection, then the registry's enabled provider, finally the
 * legacy settings baseUrl. Returns undefined when nothing is configured
 * (the caller answers 400 no_provider_configured).
 */
export function analysisProviderFromRequest(
  ctx: AppContext,
  parsed: Record<string, unknown>,
): LLMProvider | undefined {
  const registry = ctx.providerStore.registry;
  const providerId =
    typeof parsed.provider_id === "string"
      ? parsed.provider_id
      : typeof parsed.providerId === "string"
        ? parsed.providerId
        : ctx.session.providerId;
  const config =
    (providerId ? registry.get(providerId) : undefined) ??
    registry.listInternal().find((provider) => provider.enabled);
  const model =
    typeof parsed.model === "string"
      ? parsed.model
      : (ctx.session.model ?? config?.defaultModel ?? config?.models[0] ?? ctx.settings.llm.model);
  if (!config && !ctx.settings.llm.baseUrl) return undefined;
  const providerOptions = { defaultTimeoutMs: ctx.settings.llm.timeoutMs ?? undefined };
  return config
    ? createProviderForConfig(config, model, providerOptions)
    : createProviderForConfig(
        { baseUrl: ctx.settings.llm.baseUrl, apiKey: ctx.settings.llm.apiKey },
        model,
        providerOptions,
      );
}

/** One staged analysis plan — the single confirmation gate's state. */
export type StagedAnalysisPlan = {
  planId: string;
  question: string;
  /** Workspace root the dataset was ingested under; the engine runs here. */
  workspaceRoot: string;
  dataset: AnalysisDataset;
  /** Ingested workbook: ground truth the engine analyzes. */
  workbook: WorkbookSpec;
  plan: AnalysisPlan;
  profiles: DatasetProfile[];
  complexity: AnalysisIntent["complexity"];
  createdAt: number;
};

/** Staged plans live 30 minutes; a periodic sweep drops the expired ones. */
export const STAGED_PLAN_TTL_MS = 30 * 60 * 1000;
const STAGED_PLAN_SWEEP_MS = 5 * 60 * 1000;

const stagedPlans = new Map<string, StagedAnalysisPlan>();
let sweepTimer: ReturnType<typeof setInterval> | undefined;

function ensureSweepRunning(): void {
  if (sweepTimer) return;
  sweepTimer = setInterval(() => {
    sweepStagedAnalysisPlans();
  }, STAGED_PLAN_SWEEP_MS);
  // Never keep the server process alive for the sweep alone.
  sweepTimer.unref();
}

/** Drop every staged plan older than the TTL. Exported for tests. */
export function sweepStagedAnalysisPlans(now: number = Date.now()): number {
  let dropped = 0;
  for (const [planId, staged] of stagedPlans) {
    if (now - staged.createdAt >= STAGED_PLAN_TTL_MS) {
      stagedPlans.delete(planId);
      dropped += 1;
    }
  }
  return dropped;
}

export function stageAnalysisPlan(input: Omit<StagedAnalysisPlan, "planId" | "createdAt">): StagedAnalysisPlan {
  ensureSweepRunning();
  const staged: StagedAnalysisPlan = {
    ...input,
    planId: randomUUID(),
    createdAt: Date.now(),
  };
  stagedPlans.set(staged.planId, staged);
  return staged;
}

/** Read without consuming (GET /sheets/analyze/plan/:planId). */
export function peekStagedAnalysisPlan(planId: string): StagedAnalysisPlan | undefined {
  const staged = stagedPlans.get(planId);
  if (!staged) return undefined;
  if (Date.now() - staged.createdAt >= STAGED_PLAN_TTL_MS) {
    stagedPlans.delete(planId);
    return undefined;
  }
  return staged;
}

/**
 * Consume the staged plan for a run (single-use gate). Returns undefined
 * when the plan is missing or expired — the caller answers 410.
 */
export function takeStagedAnalysisPlan(planId: string): StagedAnalysisPlan | undefined {
  const staged = peekStagedAnalysisPlan(planId);
  if (staged) stagedPlans.delete(planId);
  return staged;
}

/**
 * A verify-gate failure inside engine.runAnalysis must surface as 422.
 * Convention with the core worker: the thrown error carries
 * code === "verify_failed" (or name "AnalysisVerifyError") plus an
 * `issues` array. Anything else is an unexpected failure and keeps its
 * own status. Returns the issues array, or null when the error is not
 * a verify failure.
 */
export function analysisVerifyIssues(error: unknown): unknown[] | null {
  if (typeof error !== "object" || error === null) return null;
  const record = error as Record<string, unknown>;
  const code = typeof record.code === "string" ? record.code : "";
  const name = typeof record.name === "string" ? record.name : "";
  if (code !== "verify_failed" && name !== "AnalysisVerifyError") return null;
  return Array.isArray(record.issues) ? record.issues : [];
}

/** Test-only: force a staged plan to expire. Not used by routes. */
export function expireStagedAnalysisPlanForTest(planId: string): boolean {
  const staged = stagedPlans.get(planId);
  if (!staged) return false;
  staged.createdAt = Date.now() - STAGED_PLAN_TTL_MS - 1;
  return true;
}
