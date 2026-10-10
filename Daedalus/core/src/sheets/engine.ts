import { randomUUID } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { basename, extname, join } from 'node:path';
import type { Plan, PlanStep, TaskSpec, TaskState, ValidationResult } from '../contracts.ts';
import { emitEvent, type EventBus } from '../events.ts';
import type { TaskStore } from '../persistence.ts';
import type { QuestionBroker, UserQuestionInfo } from '../interaction/questions.ts';
import type { LLMProvider, Message } from '../providers/llm/types.ts';
import { diffLines, changedLineCounts, renderPatch } from '../tools/filesystem/diff.ts';
import {
  formatCellRef,

  sheetBounds,
  workbookPaths,
  type BlueprintColumn,
  type SheetExportRecord,
  type SheetSpec,
  type WorkbookSpec,
} from './workbook.ts';
import { newSheet, newWorkbook, readWorkbook, summarizeWorkbook, validateWorkbook, writeWorkbook } from './store.ts';
import { importCsvToWorkbook, importXlsxToWorkbook } from './import.ts';
import { buildExcelJsWorkbook, exportWorkbookCsv, exportWorkbookToXlsx } from './export.ts';
import { verifyWorkbook } from './verify.ts';
import { applySheetOps, SHEET_OP_NAMES } from './ops.ts';
import { fillSheetRowsStage, generateBlueprintStage, SheetPipelineError, structuredCall, type BlueprintStageInput } from './pipeline.ts';

/**
 * SpreadsheetEngine: the Spreadsheet domain's own task executor,
 * totally separate from the coding AgentLoop and the SlideEngine
 * (design rule; only the *pattern* is shared). Sequencing lives in
 * code: Intake → Blueprint (staged, "Buat") → Build (structured ops +
 * deterministic formula writes) → Verify (mandatory gate: core
 * evaluator, LibreOffice recalc when present) → Export. The model
 * fills JSON inside stages; follow-up edits are ONE structured call
 * over the closed op vocabulary; invalid ops leave workbook.json
 * byte-identical. The engine cannot claim completion before the
 * Verify gate has run — the gate's verdict decides success/partial.
 */

export type SpreadsheetEngineDeps = {
  provider: LLMProvider;
  bus: EventBus;
  store: TaskStore;
  questions: QuestionBroker;
  workspaceRoot: string;
};

export type SpreadsheetEngineOutcome = 'success' | 'partial' | 'failed';

export type SpreadsheetEngineRunResult = {
  state: TaskState;
  outcome: SpreadsheetEngineOutcome;
  summary: string;
  validation?: ValidationResult;
  exported?: { path: string; bytes: number; sheets: number };
};

type BuildDecision = { kind: 'build' } | { kind: 'cancelled' } | { kind: 'superseded' };

type RouteResult = {
  state: Partial<TaskState>;
  outcome: SpreadsheetEngineOutcome;
  reason: string;
  summary: string;
  validation?: ValidationResult;
  exported?: { path: string; bytes: number; sheets: number };
};

const GENERATION_STEPS = [
  { id: 'intake', intent: 'Intake: baca sumber data (prompt / CSV / XLSX)' },
  { id: 'blueprint', intent: 'Susun blueprint (sheet, kolom, formula kunci, Asumsi) — di-stage untuk ditinjau' },
  { id: 'build', intent: 'Bangun workbook dari blueprint (tombol Buat)' },
  { id: 'verify', intent: 'Verify: evaluator formula + recalc LibreOffice bila ada' },
  { id: 'export', intent: 'Ekspor XLSX (fullCalcOnLoad) + CSV' },
] as const;

const EDIT_STEPS = [
  { id: 'perceive', intent: 'Baca workbook (ringkasan sheet + jendela range)' },
  { id: 'edit', intent: 'Terapkan edit terstruktur (satu panggilan op tervalidasi)' },
  { id: 'verify', intent: 'Verify ulang setelah edit' },
  { id: 'export', intent: 'Ekspor hasil edit' },
] as const;

const AUDIT_STEPS = [
  { id: 'perceive', intent: 'Baca workbook yang diaudit' },
  { id: 'audit', intent: 'Audit: ref rusak, nilai beku, pola tak konsisten, duplikat' },
  { id: 'report', intent: 'Simpan laporan audit (Panel Laporan)' },
] as const;

type StepDef = { id: string; intent: string };

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

class EngineAborted extends Error {
  constructor() { super('spreadsheet engine run aborted'); this.name = 'EngineAborted'; }
}

const NUM_FMT_BY_TYPE: Record<BlueprintColumn['type'], string | undefined> = {
  text: undefined,
  number: '#,##0.##',
  currency: '#,##0',
  percent: '0.0%',
  date: 'yyyy-mm-dd',
  boolean: undefined,
};

export class SpreadsheetEngine {
  readonly #deps: SpreadsheetEngineDeps;
  #taskId = '';
  #abort = new AbortController();
  #requests = 0;
  #staged: { settle: (decision: BuildDecision) => void; decided: boolean } | null = null;
  #completion: Promise<SpreadsheetEngineRunResult> | null = null;
  #workbookChangeSeq = 0;

  constructor(deps: SpreadsheetEngineDeps) {
    this.#deps = deps;
  }

  get workspaceRoot(): string {
    return this.#deps.workspaceRoot;
  }

  get taskId(): string {
    return this.#taskId;
  }

  stop(): void {
    this.#abort.abort();
    this.#staged?.settle({ kind: 'cancelled' });
    if (this.#taskId) this.#deps.questions.cancelTasks([this.#taskId]);
  }

  /**
   * The panel's "Buat" button: release the staged blueprint into the
   * Build stage. Returns the run's own completion promise so the
   * caller can answer with the final outcome; null when no staged
   * workbook is waiting on this engine.
   */
  generateStagedWorkbook(): Promise<SpreadsheetEngineRunResult> | null {
    if (!this.#staged || !this.#completion) return null;
    this.#staged.settle({ kind: 'build' });
    return this.#completion;
  }

  /** A newer prompt supersedes the staged blueprint. */
  abandonStagedWorkbook(): boolean {
    if (!this.#staged) return false;
    this.#staged.settle({ kind: 'superseded' });
    return true;
  }

  /**
   * Buat with no live run (the staged task already ended): build the
   * persisted blueprint directly. Emits no task events; the caller
   * answers synchronously and the Web re-reads workbook.json after.
   */
  async buildStagedWorkbookDirect(input: { model?: string } = {}): Promise<{ outcome: SpreadsheetEngineOutcome; summary: string }> {
    const root = this.#deps.workspaceRoot;
    const wb = await readWorkbook(root).catch(() => null);
    if (!wb || !wb.blueprint || wb.stage !== 'blueprint') {
      return { outcome: 'failed', summary: 'Tidak ada blueprint ter-stage untuk dibangun.' };
    }
    if (input.model) wb.meta.model = input.model;
    try {
      const notes = await this.#build(wb);
      const { verify, record } = await this.#verifyExportRepair(wb, wb.blueprint.goal, { repair: true });
      const outcome: SpreadsheetEngineOutcome = verify.errors.length > 0 || verify.path === 'partial' ? 'partial' : 'success';
      return { outcome, summary: [`Dibangun: ${notes.join('; ') || 'struktur blueprint'}`, verify.summary, `Ekspor: ${basename(record.path)} (${record.via})`].join(' · ') };
    } catch (error) {
      return { outcome: 'failed', summary: `Gagal membangun blueprint: ${errorText(error)}` };
    }
  }

  run(spec: TaskSpec): Promise<SpreadsheetEngineRunResult> {
    const completion = this.#runTask(spec);
    this.#completion = completion;
    return completion;
  }

  async #runTask(spec: TaskSpec): Promise<SpreadsheetEngineRunResult> {
    this.#taskId = spec.id;
    const root = this.#deps.workspaceRoot;
    let existing: WorkbookSpec | null = null;
    let readError: Error | null = null;
    try {
      existing = await readWorkbook(root);
    } catch (error) {
      readError = error instanceof Error ? error : new Error(String(error));
    }
    const auditWanted = /\baudit\b/i.test(spec.goal);
    const route: 'generate' | 'edit' | 'audit' = readError
      ? 'generate'
      : !existing || existing.stage === 'blueprint'
        ? 'generate'
        : auditWanted
          ? 'audit'
          : 'edit';
    const stepDefs: readonly StepDef[] = route === 'edit' ? EDIT_STEPS : route === 'audit' ? AUDIT_STEPS : GENERATION_STEPS;
    const plan: Plan = {
      id: `${spec.id}-plan`,
      task_id: spec.id,
      steps: stepDefs.map((step, index) => ({ id: `${spec.id}-step-${index + 1}`, intent: step.intent, status: index === 0 ? 'active' : 'pending', evidence: [] }) as PlanStep),
      version: 1,
      status: 'active',
    };
    let state: TaskState = { ...spec, plan, steps: plan.steps, status: 'active', mode: 'auto', turns: 0 };
    const save = (patch: Partial<TaskState>): void => {
      state = { ...state, ...patch, turns: this.#requests };
      this.#deps.store.saveState(spec.id, state);
    };
    save({});
    const setStep = (id: string, status: PlanStep['status']): void => {
      const defIndex = stepDefs.findIndex((s) => s.id === id);
      if (defIndex < 0) return;
      plan.steps = plan.steps.map((step, i) => (i === defIndex ? { ...step, status } : step));
      state = { ...state, plan, steps: plan.steps, current_step_id: `${spec.id}-step-${defIndex + 1}` };
      this.#deps.store.saveState(spec.id, state);
    };
    const ctx = { setStep, save };
    this.#emit('TASK_STARTED', { spec });
    this.#emit('PLAN_CREATED', { plan });
    try {
      this.#throwIfAborted();
      if (readError) throw readError;
      const result = route === 'edit'
        ? await this.#runEdit(spec, existing as WorkbookSpec, ctx)
        : route === 'audit'
          ? await this.#runAudit(spec, existing as WorkbookSpec, ctx)
          : await this.#runGeneration(spec, existing, ctx);
      save({ status: result.state.status, last_observation: result.summary, ...(result.state.last_error ? { last_error: result.state.last_error } : {}) });
      this.#emit('TASK_COMPLETED', { state, outcome: result.outcome, reason: result.reason });
      return { state, outcome: result.outcome, summary: result.summary, ...(result.validation ? { validation: result.validation } : {}), ...(result.exported ? { exported: result.exported } : {}) };
    } catch (error) {
      if (error instanceof EngineAborted || this.#abort.signal.aborted || this.#deps.store.isCancelRequested(spec.id)) {
        save({ status: 'failed', last_error: 'aborted', last_observation: 'Berhenti sebelum selesai: tugas dihentikan.' });
        this.#emit('TASK_COMPLETED', { state, outcome: 'failed', reason: 'aborted' });
        return { state, outcome: 'failed', summary: 'Berhenti sebelum selesai: tugas dihentikan.' };
      }
      const message = errorText(error);
      save({ status: 'failed', last_error: message, last_observation: `Gagal: ${message}` });
      this.#emit('TASK_COMPLETED', { state, outcome: 'failed', reason: 'sheet_engine_error' });
      return { state, outcome: 'failed', summary: `Gagal: ${message}` };
    }
  }

  /* ------------------------------------------------------ generation */

  async #runGeneration(
    spec: TaskSpec,
    existing: WorkbookSpec | null,
    ctx: { setStep: (id: string, status: PlanStep['status']) => void; save: (patch: Partial<TaskState>) => void },
  ): Promise<RouteResult> {
    const signal = this.#abort.signal;
    ctx.setStep('intake', 'active');
    const intake = await this.#intake(spec, existing);
    ctx.setStep('intake', 'done');

    ctx.setStep('blueprint', 'active');
    const perceptionSheets = (intake.workbook ?? existing)?.sheets ?? [];
    const sourceSummaries: BlueprintStageInput['sourceSummaries'] = perceptionSheets.length > 0
      ? [{ path: intake.sourcePath ?? 'workbook.json', sheets: perceptionSheets.map((s) => this.#sheetPerception(s)) }]
      : [];
    const blueprint = await generateBlueprintStage(this.#observingProvider(), {
      goal: spec.goal,
      sourceSummaries,
      existingSummary: existing ? JSON.stringify(summarizeWorkbook(existing)) : undefined,
    }, signal);
    this.#throwIfAborted();

    // Persist the staged blueprint: imported sheets ride along, new
    // blueprint sheets appear as header-only skeletons the panel shows.
    const wb: WorkbookSpec = intake.workbook ?? existing ?? newWorkbook(blueprint.title, { createdBy: 'daedalus-spreadsheet', ...(spec.model ? { model: spec.model } : {}) });
    wb.title = blueprint.title || wb.title;
    wb.blueprint = { ...blueprint, sources: intake.sourcePath ? [intake.sourcePath] : (wb.blueprint?.sources ?? []) };
    wb.stage = 'blueprint';
    if (spec.model) wb.meta.model = spec.model;
    for (const bs of blueprint.sheets) {
      if (!wb.sheets.some((s) => s.name === bs.name)) {
        const skeleton = newSheet(bs.name);
        bs.columns.forEach((col, ci) => {
          skeleton.cells[formatCellRef(ci, 0)] = { v: col.name, bold: true };
        });
        wb.sheets.push(skeleton);
      }
    }
    await this.#persist(wb);
    this.#emit('THOUGHT', {
      text: `Blueprint di-stage di Panel Blueprint — tinjau lalu tekan "Buat" untuk membangun.\nSheet: ${blueprint.sheets.map((s) => `${s.name} (${s.columns.map((c) => `${c.name}:${c.source}`).join(', ')})`).join(' · ')}\nAsumsi: ${blueprint.assumptions.map((a) => `${a.name}=${String(a.value)}`).join(', ') || '—'}`,
    });
    ctx.setStep('blueprint', 'done');

    ctx.setStep('build', 'active');
    const decision = await this.#awaitBuildDecision();
    if (decision.kind === 'cancelled') throw new EngineAborted();
    if (decision.kind === 'superseded') {
      return { state: { status: 'failed', last_error: 'staged_superseded' }, outcome: 'failed', reason: 'staged_superseded', summary: 'Blueprint digantikan prompt yang lebih baru sebelum dibangun.' };
    }

    const notes = await this.#build(wb);
    this.#emit('THOUGHT', { text: `Workbook dibangun dari blueprint: ${notes.join('; ')}` });
    ctx.setStep('build', 'done');
    ctx.setStep('verify', 'active');
    const { verify, record } = await this.#verifyExportRepair(wb, spec.goal, { repair: true });
    ctx.setStep('verify', 'done');
    ctx.setStep('export', 'done');
    const outcome: SpreadsheetEngineOutcome = verify.errors.length > 0 || verify.path === 'partial' ? 'partial' : 'success';
    const summary = [
      `Workbook "${wb.title}" selesai dibangun (${wb.sheets.map((s) => s.name).join(', ')}).`,
      verify.summary,
      `Ekspor: ${basename(record.path)} via ${record.via}${record.note ? ` — ${record.note}` : ''}`,
    ].join(' ');
    return {
      state: { status: 'done' },
      outcome,
      reason: outcome === 'success' ? 'spreadsheet_completed' : 'spreadsheet_partial',
      summary,
      validation: this.#validation(verify),
      exported: { path: record.path, bytes: record.bytes, sheets: wb.sheets.length },
    };
  }

  #sheetPerception(sheet: SheetSpec): { name: string; rows: number; cols: number; headers: string[]; sampleRows: string[][] } {
    const bounds = sheetBounds(sheet);
    const headers: string[] = [];
    const sampleRows: string[][] = [];
    if (bounds) {
      for (let c = bounds.minCol; c <= bounds.maxCol; c += 1) {
        const cell = sheet.cells[formatCellRef(c, 0)];
        headers.push(cell?.v !== undefined ? String(cell.v) : cell?.f ?? '');
      }
      for (let r = 1; r <= Math.min(bounds.maxRow, 5); r += 1) {
        const row: string[] = [];
        for (let c = bounds.minCol; c <= bounds.maxCol; c += 1) {
          const cell = sheet.cells[formatCellRef(c, r)];
          row.push(cell?.f ?? (cell?.v === undefined ? '' : String(cell.v)));
        }
        sampleRows.push(row);
      }
    }
    return { name: sheet.name, rows: bounds ? bounds.maxRow + 1 : 0, cols: bounds ? bounds.maxCol + 1 : 0, headers, sampleRows };
  }

  /* ----------------------------------------------------------- build */

  /**
   * Deterministic build: source data already sits in the sheets
   * (intake), so build writes headers, model-filled input rows for
   * fresh sheets, and every formula cell from the blueprint templates.
   * Derived cells are live formulas by construction.
   */
  async #build(wb: WorkbookSpec): Promise<string[]> {
    const blueprint = wb.blueprint;
    if (!blueprint) throw new SheetPipelineError('build called without a staged blueprint');
    const notes: string[] = [];
    for (const bs of blueprint.sheets) {
      let sheet = wb.sheets.find((s) => s.name === bs.name);
      if (!sheet) {
        sheet = newSheet(bs.name);
        wb.sheets.push(sheet);
      }
      bs.columns.forEach((col, ci) => {
        const ref = formatCellRef(ci, 0);
        if (!sheet.cells[ref]) sheet.cells[ref] = { v: col.name, bold: true };
      });
      sheet.frozen = { row: 1, col: 0 };
      const bounds = sheetBounds(sheet);
      const lastDataRow = bounds ? bounds.maxRow : 0; // 0-based; header = 0
      const inputCols = bs.columns.map((c, i) => ({ col: c, index: i })).filter(({ col }) => col.source === 'input');
      if (lastDataRow === 0 && inputCols.length > 0) {
        const fill = await fillSheetRowsStage(this.#observingProvider(), {
          goal: blueprint.goal,
          sheetName: bs.name,
          columns: bs.columns,
        }, this.#abort.signal);
        fill.rows.forEach((rowValues, ri) => {
          const row1 = ri + 2; // 1-based data row
          inputCols.forEach(({ index }, k) => {
            const value = rowValues[k];
            if (value === undefined || value === '') return;
            const ref = formatCellRef(index, row1 - 1);
            sheet.cells[ref] = { v: value, ...(NUM_FMT_BY_TYPE[bs.columns[index]?.type ?? 'text'] ? { fmt: NUM_FMT_BY_TYPE[bs.columns[index]?.type ?? 'text'] } : {}) };
          });
        });
        notes.push(`${bs.name}: ${fill.rows.length} baris data diisi model`);
      } else if (lastDataRow > 0) {
        notes.push(`${bs.name}: ${lastDataRow} baris dari sumber dipertahankan`);
      }
      const finalBounds = sheetBounds(sheet);
      const lastRow1 = finalBounds ? finalBounds.maxRow + 1 : 1;
      bs.columns.forEach((col, ci) => {
        if (col.source === 'formula' && col.formula) {
          for (let row1 = 2; row1 <= lastRow1; row1 += 1) {
            const ref = formatCellRef(ci, row1 - 1);
            sheet.cells[ref] = { f: col.formula.replaceAll('{r}', String(row1)), ...(NUM_FMT_BY_TYPE[col.type] ? { fmt: NUM_FMT_BY_TYPE[col.type] } : {}) };
          }
        }
        if (col.source === 'assumption') {
          const assumptionIndex = blueprint.assumptions.findIndex((a) => a.name.toLowerCase() === col.name.toLowerCase());
          if (assumptionIndex >= 0) {
            for (let row1 = 2; row1 <= lastRow1; row1 += 1) {
              sheet.cells[formatCellRef(ci, row1 - 1)] = { f: `=Asumsi!$B$${assumptionIndex + 2}`, ...(NUM_FMT_BY_TYPE[col.type] ? { fmt: NUM_FMT_BY_TYPE[col.type] } : {}) };
            }
          }
        }
      });
      if (bs.charts?.length) sheet.charts = bs.charts.map((c) => ({ ...c, sheet: c.sheet ?? bs.name }));
      if (bs.pivots?.length) sheet.pivots = bs.pivots;
    }
    if (blueprint.assumptions.length > 0) {
      let asumsi = wb.sheets.find((s) => s.name === 'Asumsi');
      if (!asumsi) {
        asumsi = newSheet('Asumsi');
        wb.sheets.push(asumsi);
      }
      asumsi.cells['A1'] = { v: 'Nama', bold: true };
      asumsi.cells['B1'] = { v: 'Nilai', bold: true };
      asumsi.cells['C1'] = { v: 'Catatan', bold: true };
      blueprint.assumptions.forEach((assumption, i) => {
        const row = i + 2;
        asumsi.cells[`A${row}`] = { v: assumption.name };
        asumsi.cells[`B${row}`] = { v: assumption.value };
        if (assumption.note) asumsi.cells[`C${row}`] = { v: assumption.note };
      });
      asumsi.frozen = { row: 1, col: 0 };
      notes.push(`Asumsi: ${blueprint.assumptions.length} nilai di sheet Asumsi`);
    }
    wb.stage = 'ready';
    return notes;
  }

  /* ------------------------------------------------- verify + export */

  async #verifyExportRepair(
    wb: WorkbookSpec,
    goal: string,
    opts: { repair: boolean },
  ): Promise<{ verify: Awaited<ReturnType<typeof verifyWorkbook>>; record: SheetExportRecord }> {
    let current = wb;
    for (let attempt = 0; attempt <= 2; attempt += 1) {
      const record = await exportWorkbookToXlsx(current, this.#deps.workspaceRoot);
      const verify = await verifyWorkbook(current, { exportPath: record.path });
      if (verify.ok || !opts.repair || attempt === 2 || verify.errors.length === 0) {
        current.verify = verify;
        current.exports = [record, ...(current.exports ?? [])].slice(0, 10);
        await this.#persist(current);
        this.#emit(verify.ok ? 'VALIDATION_PASSED' : 'VALIDATION_FAILED', {
          task_id: this.#taskId,
          checks: [{ name: 'spreadsheet-verify', status: verify.ok ? 'pass' : 'fail', summary: verify.summary }],
          summary: verify.summary,
        });
        Object.assign(wb, current);
        return { verify, record };
      }
      // Bounded repair: hand the failing cells back as one ops call.
      this.#emit('THOUGHT', { text: `Verify menemukan ${verify.errors.length} error; mencoba perbaikan terstruktur (${attempt + 1}/2).` });
      try {
        const ops = await structuredCall(this.#observingProvider(), REPAIR_SYSTEM, [
          `Goal: ${goal}`,
          `Workbook: ${JSON.stringify(summarizeWorkbook(current))}`,
          `Failing cells:\n${verify.errors.map((e) => `- ${e.sheet}!${e.cell}: ${e.message}`).join('\n')}`,
        ].join('\n\n'), (value) => {
          const applied = applySheetOps(current, value);
          return applied.ok ? { ok: true, value: applied } : { ok: false, issues: applied.issues };
        }, this.#abort.signal);
        current = ops.workbook;
      } catch {
        // Repair could not produce valid ops: keep the honest verdict.
        current.verify = verify;
        current.exports = [record, ...(current.exports ?? [])].slice(0, 10);
        await this.#persist(current);
        this.#emit('VALIDATION_FAILED', { task_id: this.#taskId, checks: [{ name: 'spreadsheet-verify', status: 'fail', summary: verify.summary }], summary: verify.summary });
        Object.assign(wb, current);
        return { verify, record };
      }
    }
    throw new SheetPipelineError('verify loop exhausted unexpectedly');
  }

  #validation(verify: Awaited<ReturnType<typeof verifyWorkbook>>): ValidationResult {
    return {
      checks: [{
        name: 'spreadsheet-verify',
        cmd: `verify (${verify.path})`,
        status: verify.ok ? 'pass' : 'fail',
        exit_code: verify.ok ? 0 : 1,
        summary: verify.summary,
        diagnostics: [...verify.errors, ...verify.warnings].map((i) => ({ file: `${i.sheet}!${i.cell}`, message: i.message })),
      }],
      source: 'default',
    };
  }

  /* ------------------------------------------------------------- edit */

  async #runEdit(
    spec: TaskSpec,
    wb: WorkbookSpec,
    ctx: { setStep: (id: string, status: PlanStep['status']) => void; save: (patch: Partial<TaskState>) => void },
  ): Promise<RouteResult> {
    ctx.setStep('perceive', 'active');
    const summary = JSON.stringify(summarizeWorkbook(wb));
    this.#emit('THOUGHT', { text: `Workbook saat ini: ${wb.sheets.map((s) => `${s.name} (${Object.keys(s.cells).length} sel)`).join(', ')}` });
    ctx.setStep('perceive', 'done');
    ctx.setStep('edit', 'active');
    let applied;
    try {
      applied = await structuredCall(this.#observingProvider(), EDIT_SYSTEM, [
        `Goal: ${spec.goal}`,
        `Workbook summary (perception — dims, headers, counts; use read windows via set_cells ranges you can infer from headers):\n${summary}`,
        wb.blueprint ? `Blueprint:\n${JSON.stringify(wb.blueprint).slice(0, 3000)}` : '',
        `Current verify: ${wb.verify ? wb.verify.summary : '(belum pernah diverifikasi)'}`,
      ].filter(Boolean).join('\n\n'), (value) => {
        const result = applySheetOps(wb, value);
        return result.ok ? { ok: true, value: result } : { ok: false, issues: result.issues };
      }, this.#abort.signal);
    } catch (error) {
      if (error instanceof SheetPipelineError) {
        // Nothing was written: the edit seam only persists validated ops.
        return { state: { status: 'failed', last_error: error.message }, outcome: 'failed', reason: 'sheet_engine_error', summary: `Edit ditolak — workbook tidak berubah: ${error.message}` };
      }
      throw error;
    }
    const next = applied.workbook;
    ctx.setStep('edit', 'done');
    ctx.setStep('verify', 'active');
    const { verify, record } = await this.#verifyExportRepair(next, spec.goal, { repair: false });
    ctx.setStep('verify', 'done');
    ctx.setStep('export', 'done');
    const extras: string[] = [];
    if (applied.value.exportRequested === 'csv') {
      const csvRecords = await exportWorkbookCsv(next, this.#deps.workspaceRoot);
      next.exports = [...csvRecords, ...(next.exports ?? [])].slice(0, 10);
      await this.#persist(next);
      extras.push(`CSV: ${csvRecords.map((r) => basename(r.path)).join(', ')}`);
    }
    const outcome: SpreadsheetEngineOutcome = verify.errors.length > 0 || verify.path === 'partial' ? 'partial' : 'success';
    return {
      state: { status: 'done' },
      outcome,
      reason: outcome === 'success' ? 'spreadsheet_edited' : 'spreadsheet_partial',
      summary: [`${applied.value.opsApplied} op diterapkan ke "${next.title}".`, verify.summary, `Ekspor: ${basename(record.path)}`, ...extras].join(' '),
      validation: this.#validation(verify),
      exported: { path: record.path, bytes: record.bytes, sheets: next.sheets.length },
    };
  }

  /* ------------------------------------------------------------ audit */

  async #runAudit(
    spec: TaskSpec,
    wb: WorkbookSpec,
    ctx: { setStep: (id: string, status: PlanStep['status']) => void; save: (patch: Partial<TaskState>) => void },
  ): Promise<RouteResult> {
    void spec;
    ctx.setStep('perceive', 'done');
    ctx.setStep('audit', 'active');
    // Recalc arm needs a real file: export a scratch copy (not recorded).
    const { tmpdir } = await import('node:os');
    const { rm } = await import('node:fs/promises');
    const scratch = join(tmpdir(), `daedalus-audit-${randomUUID().slice(0, 8)}.xlsx`);
    try {
      const excel = await buildExcelJsWorkbook(wb);
      await excel.xlsx.writeFile(scratch);
    } catch { /* core-only audit still runs */ }
    const verify = await verifyWorkbook(wb, { exportPath: scratch });
    await rm(scratch, { force: true }).catch(() => undefined);
    wb.verify = verify;
    await this.#persist(wb);
    ctx.setStep('audit', 'done');
    ctx.setStep('report', 'done');
    const lines = [
      `Audit "${wb.title}": ${verify.summary}`,
      ...verify.errors.slice(0, 20).map((e) => `ERROR ${e.sheet}!${e.cell}: ${e.message}`),
      ...verify.warnings.slice(0, 20).map((w) => `WARN ${w.sheet}!${w.cell}: ${w.message}`),
    ];
    this.#emit('THOUGHT', { text: lines.join('\n') });
    return {
      state: { status: 'done' },
      outcome: 'success',
      reason: 'spreadsheet_audited',
      summary: lines.join(' · '),
      validation: this.#validation(verify),
    };
  }

  /* ----------------------------------------------------------- intake */

  async #intake(spec: TaskSpec, existing: WorkbookSpec | null): Promise<{ workbook: WorkbookSpec | null; sourcePath: string | null }> {
    const root = this.#deps.workspaceRoot;
    // 1) Explicit attachments of spreadsheet kind.
    const attached = (spec.attachments ?? [])
      .filter((a) => a.kind === 'file' && /\.(csv|xlsx|xls)$/i.test(a.workspacePath ?? a.name ?? ''))
      .map((a) => a.workspacePath)
      .filter((p): p is string => typeof p === 'string' && p.length > 0);
    // 2) A file named in the goal.
    const named = /[\w./-]+\.(?:csv|xlsx)\b/i.exec(spec.goal)?.[0];
    let candidates: string[] = attached.length > 0 ? attached : named ? [named] : [];
    // 3) Fresh workspace with several candidate files → ask_user.
    if (candidates.length === 0 && !existing) {
      const entries = await readdir(root).catch(() => [] as string[]);
      candidates = entries.filter((e) => /\.(csv|xlsx)$/i.test(e) && !e.startsWith('.'));
      if (candidates.length > 1) {
        const answer = await this.#askUser(
          'File mana yang mau diproses jadi workbook?',
          candidates.slice(0, 4).map((c) => ({ label: c })),
        );
        candidates = answer ? [answer] : [];
      }
    }
    const chosen = candidates[0];
    if (!chosen) return { workbook: null, sourcePath: null };
    if (existing?.blueprint?.sources.includes(chosen)) return { workbook: null, sourcePath: chosen };
    const absolute = join(root, chosen);
    const ext = extname(chosen).toLowerCase();
    try {
      if (ext === '.csv') {
        const text = await readFile(absolute, 'utf8');
        const imported = importCsvToWorkbook(basename(chosen).replace(/\.csv$/i, ''), text, { createdBy: 'daedalus-spreadsheet', ...(spec.model ? { model: spec.model } : {}) });
        this.#emit('THOUGHT', { text: `Intake: membaca ${chosen} (${imported.sheets.map((s) => `${s.name}: ${Object.keys(s.cells).length} sel`).join(', ')})` });
        return { workbook: imported, sourcePath: chosen };
      }
      const buffer = await readFile(absolute);
      const imported = await importXlsxToWorkbook(basename(chosen).replace(/\.xlsx?$/i, ''), buffer, { createdBy: 'daedalus-spreadsheet', ...(spec.model ? { model: spec.model } : {}) });
      this.#emit('THOUGHT', { text: `Intake: membaca ${chosen} (${imported.sheets.map((s) => `${s.name}: ${Object.keys(s.cells).length} sel`).join(', ')})` });
      return { workbook: imported, sourcePath: chosen };
    } catch (error) {
      throw new SheetPipelineError(`tidak bisa membaca file sumber ${chosen}: ${errorText(error)}`);
    }
  }

  /* ------------------------------------------------------------ gate */

  #awaitBuildDecision(): Promise<BuildDecision> {
    return new Promise<BuildDecision>((resolvePromise) => {
      let settled = false;
      const gate = {
        decided: false,
        settle: (decision: BuildDecision): void => {
          if (settled) return;
          settled = true;
          gate.decided = true;
          if (this.#staged === gate) this.#staged = null;
          resolvePromise(decision);
        },
      };
      this.#staged = gate;
      if (this.#abort.signal.aborted) gate.settle({ kind: 'cancelled' });
    });
  }

  /* --------------------------------------------------------- helpers */

  async #askUser(question: string, options: Array<{ label: string; description?: string }>): Promise<string | null> {
    const info: UserQuestionInfo = {
      id: randomUUID(),
      taskId: this.#taskId,
      question,
      options,
      allowFreeText: true,
      createdAt: new Date().toISOString(),
    };
    this.#emit('QUESTION_REQUESTED', { question: info });
    await this.#deps.bus.drain().catch(() => undefined);
    const result = await this.#deps.questions.ask(info);
    this.#emit('QUESTION_ANSWERED', {
      question_id: info.id,
      question: info.question,
      outcome: result.outcome,
      ...(result.answer !== undefined ? { answer: result.answer } : {}),
    });
    if (result.outcome !== 'answered' || !result.answer) return null;
    return result.answer;
  }

  async #persist(wb: WorkbookSpec): Promise<void> {
    const root = this.#deps.workspaceRoot;
    const before = await this.#workbookFileText(root);
    const structural = validateWorkbook(wb).filter((i) => i.severity === 'error');
    if (structural.length > 0) {
      throw new SheetPipelineError(`workbook tidak valid: ${structural.map((i) => i.message).join('; ')}`);
    }
    await writeWorkbook(root, wb);
    await this.#emitWorkbookChanged(root, before);
  }

  async #workbookFileText(root: string): Promise<string | null> {
    try {
      return await readFile(workbookPaths(root).file, 'utf8');
    } catch {
      return null;
    }
  }

  /**
   * workbook.json is a workspace file; the Web refreshes its sheet
   * surfaces off FILE_CHANGED (same field lesson as the staged
   * outline, 2026-10-09). Emitted only on actual change.
   */
  async #emitWorkbookChanged(root: string, before: string | null): Promise<void> {
    if (!this.#taskId) return;
    const after = await this.#workbookFileText(root);
    if (after === null || after === before) return;
    const lines = diffLines(before ?? '', after);
    if (lines.length === 0) return;
    const counts = changedLineCounts(lines);
    this.#workbookChangeSeq += 1;
    this.#emit('FILE_CHANGED', {
      call_id: `sheet-workbook-${this.#workbookChangeSeq}`,
      path: 'workbook/workbook.json',
      tool: 'spreadsheet-engine',
      operation: before === null ? 'created' : 'modified',
      added: counts.added,
      removed: counts.removed,
      lines,
      patch: renderPatch('workbook/workbook.json', lines),
    });
  }

  #observingProvider(): LLMProvider {
    const inner = this.#deps.provider;
    const self = this;
    return {
      name: inner.name,
      async chat(messages: Message[], tools, options) {
        self.#requests += 1;
        self.#emit('MODEL_REQUEST_STARTED', { provider: inner.name, messages: messages.length, tools: 0 });
        try {
          const response = await inner.chat(messages, tools, options);
          self.#emit('MODEL_REQUEST_FINISHED', {
            message: { content: '' },
            ...(response.usage ? { usage: response.usage } : {}),
            ...(response.finish_reason ? { finish_reason: response.finish_reason } : {}),
          });
          return response;
        } catch (error) {
          self.#emit('MODEL_REQUEST_FAILED', { error: errorText(error) });
          throw error;
        }
      },
      stream(messages: Message[], tools, options) {
        return inner.stream(messages, tools, options);
      },
    };
  }

  #emit(type: Parameters<typeof emitEvent>[3], payload: unknown): void {
    if (!this.#taskId) return;
    emitEvent({ bus: this.#deps.bus, store: this.#deps.store }, this.#taskId, undefined, type, payload);
  }

  #throwIfAborted(): void {
    if (this.#abort.signal.aborted || (this.#taskId && this.#deps.store.isCancelRequested(this.#taskId))) throw new EngineAborted();
  }
}

const EDIT_SYSTEM = [
  'You edit a spreadsheet through ONE structured batch of sheet ops. Output exactly one JSON object: {"kind":"sheet-ops","ops":[...]} and nothing else.',
  `Op vocabulary (closed): ${SHEET_OP_NAMES.join(', ')}.`,
  'Each op is an object: {"op":"set_cells","sheet":"Data","range":"B2:B9","values":[[...]]} — a string starting with "=" is a formula, other scalars are literal values, null clears a cell.',
  'Other ops: {"op":"set_formula","sheet":..,"range":"C2:C9","formula":"=B2*Asumsi!$B$2"} (relative refs shift across the range), {"op":"add_sheet","name":..}, {"op":"rename_sheet","sheet":..,"name":..}, {"op":"delete_sheet","sheet":..}, {"op":"insert_rows","sheet":..,"at":3,"count":1}, {"op":"insert_columns","sheet":..,"at":2,"count":1}, {"op":"delete_range","sheet":..,"range":"A5:C5","shift":"up"}, {"op":"sort_range","sheet":..,"range":"A2:D20","by":1,"dir":"asc"}, {"op":"set_format","sheet":..,"range":"A1:D1","bold":true,"fill":"#6B50FF","numFmt":"#,##0"}, {"op":"define_named_range","name":..,"ref":"Data!A1"}, {"op":"validate_workbook"}, {"op":"export_workbook","format":"xlsx|csv"}.',
  'Rules: derived numbers are ALWAYS live formulas (never type a computed result as a literal); assumptions are referenced as Asumsi!$B$n, never hardcoded into formulas; when a target column exists as formulas already, extend the same pattern; keep edits minimal and exactly scoped to the goal.',
].join('\n');

const REPAIR_SYSTEM = [
  'You repair failing formula cells in a spreadsheet through ONE structured batch of sheet ops. Output exactly one JSON object: {"kind":"sheet-ops","ops":[...]} and nothing else.',
  'Use set_formula / set_cells ops only on the failing cells (and their direct inputs). Derived numbers stay live formulas. Assumptions are referenced as Asumsi!$B$n.',
].join('\n');

