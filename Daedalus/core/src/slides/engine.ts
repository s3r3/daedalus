import { randomUUID } from 'node:crypto';
import type { Plan, PlanStep, TaskSpec, TaskState, ValidationResult } from '../contracts.ts';
import { emitEvent, type EventBus } from '../events.ts';
import type { TaskStore } from '../persistence.ts';
import type { QuestionBroker, UserQuestionInfo } from '../interaction/questions.ts';
import type { LLMProvider, Message } from '../providers/llm/types.ts';
import type { SlideTaskParams } from '../agent/context.ts';
import type { DeckSpec, Slide } from './deck.ts';
import { readDeck, newSlideId, validateDeck, writeDeck } from './store.ts';
import { DeckValidator } from './deck-validator.ts';
import { getLayout, LAYOUTS } from './layouts.ts';
import { getSlideTemplate, SLIDE_TEMPLATES } from './templates.ts';
import { exportDeckToPptx } from './export-pptx.ts';
import {
  fillDeckSlidesStage,
  generateDeckOutlineStage,
  structuredCall,
  SlidePipelineError,
  type DeckBrief,
  type OutlineItem,
} from './pipeline.ts';

/**
 * SlideEngine: the Slide domain's own task executor. Slide tasks never
 * enter the agentic-coding machinery — no AgentLoop, no tool registry
 * or mode policy, no loop completion gate (Farid's mandate: "desain
 * saja bukan backend" — Slide borrows Agentic Coding's design, none of
 * its systems). Sequencing lives here and in slides/pipeline.ts:
 * generation runs the code-sequenced stages, edits run ONE structured
 * model call returning a closed vocabulary of deck ops, and completion
 * is the engine's own verdict (exported file, or valid applied ops).
 *
 * The engine speaks the event contract the Web already renders
 * (TASK_STARTED, PLAN_CREATED, THOUGHT, MODEL_REQUEST events,
 * QUESTION events, VALIDATION events, TASK_COMPLETED — same payload
 * shapes), so the
 * chat, question cards, validation lines, and token accounting work
 * unchanged. Token usage is the provider's own, relayed per call —
 * never estimated.
 */

export type SlideEngineDeps = {
  provider: LLMProvider;
  bus: EventBus;
  store: TaskStore;
  questions: QuestionBroker;
  workspaceRoot: string;
};

export type SlideEngineOutcome = 'success' | 'partial' | 'failed';

export type SlideEngineRunResult = {
  state: TaskState;
  outcome: SlideEngineOutcome;
  /** Plain-language closing line (the task's final observation). */
  summary: string;
  validation?: ValidationResult;
  exported?: { path: string; bytes: number; slides: number };
};

type StageStep = { id: string; intent: string };

const GENERATION_STEPS: StageStep[] = [
  { id: 'outline', intent: 'Generate the deck outline with the slide pipeline (skeleton deck persisted)' },
  { id: 'checkpoint', intent: 'Confirm the design direction (template) at the checkpoint' },
  { id: 'fill', intent: 'Fill every slide with the pipeline (resumable per slide)' },
  { id: 'validate', intent: 'Validate the deck' },
  { id: 'export', intent: 'Export the .pptx' },
];

const EDIT_STEPS: StageStep[] = [
  { id: 'ops', intent: 'Compute and apply the deck edit operations' },
  { id: 'validate', intent: 'Validate the deck' },
  { id: 'export', intent: 'Export the .pptx when requested' },
];

class EngineAborted extends Error {
  constructor() {
    super('aborted');
    this.name = 'EngineAborted';
  }
}

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function clone<T>(v: T): T {
  return JSON.parse(JSON.stringify(v)) as T;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export class SlideEngine {
  readonly #deps: SlideEngineDeps;
  readonly #abort = new AbortController();
  #taskId = '';
  #provider: LLMProvider;
  #requests = 0;

  constructor(deps: SlideEngineDeps) {
    this.#deps = deps;
    this.#provider = this.#observingProvider(deps.provider);
  }

  /** Stop the run: in-flight provider calls abort and any pending checkpoint question settles as cancelled. */
  stop(): void {
    this.#abort.abort();
    if (this.#taskId) this.#deps.questions.cancelTasks([this.#taskId]);
  }

  /**
   * The run's provider, observed: every chat is relayed as a
   * MODEL_REQUEST_STARTED/FINISHED pair (usage passed through verbatim
   * when the provider reports it) so the Web's token accounting reads
   * engine runs exactly like loop runs. Message content stays empty —
   * stage JSON is not chat text; the human summary rides THOUGHT and
   * the final state instead.
   */
  #observingProvider(inner: LLMProvider): LLMProvider {
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
    emitEvent({ bus: this.#deps.bus, store: this.#deps.store }, this.#taskId, undefined, type, payload);
  }

  #throwIfAborted(): void {
    if (this.#abort.signal.aborted || this.#deps.store.isCancelRequested(this.#taskId)) throw new EngineAborted();
  }

  async run(spec: TaskSpec, slide?: SlideTaskParams): Promise<SlideEngineRunResult> {
    this.#taskId = spec.id;
    const root = this.#deps.workspaceRoot;
    const existing = await readDeck(root).catch(() => null);
    const route: 'generate' | 'resume' | 'edit' =
      !existing || existing.slides.length === 0 ? 'generate' : existing.slides.some((s) => s.status === 'skeleton') ? 'resume' : 'edit';
    const stepDefs = route === 'edit' ? EDIT_STEPS : GENERATION_STEPS;
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

    this.#emit('TASK_STARTED', { spec });
    this.#emit('PLAN_CREATED', { plan });

    try {
      this.#throwIfAborted();
      const result =
        route === 'edit'
          ? await this.#runEdit(spec, { setStep, save })
          : await this.#runGeneration(spec, slide, route, { setStep, save });
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
      this.#emit('TASK_COMPLETED', { state, outcome: 'failed', reason: 'slide_engine_error' });
      return { state, outcome: 'failed', summary: `Gagal: ${message}` };
    }
  }

  /* ------------------------------------------------------ generation */

  async #runGeneration(
    spec: TaskSpec,
    slide: SlideTaskParams | undefined,
    route: 'generate' | 'resume',
    ctx: { setStep: (id: string, status: PlanStep['status']) => void; save: (patch: Partial<TaskState>) => void },
  ): Promise<{ state: Partial<TaskState>; outcome: SlideEngineOutcome; reason: string; summary: string; validation?: ValidationResult; exported?: { path: string; bytes: number; slides: number } }> {
    const root = this.#deps.workspaceRoot;
    const signal = this.#abort.signal;
    const brief: DeckBrief = {
      topic: spec.goal,
      ...(slide?.slideCount ? { slideCount: slide.slideCount } : {}),
      ...(slide?.language ? { language: slide.language } : {}),
      ...(slide?.templateId ? { templateId: slide.templateId } : {}),
    };
    let outline: OutlineItem[] = [];

    if (route === 'generate') {
      ctx.setStep('outline', 'active');
      const outlineResult = await generateDeckOutlineStage(this.#provider, root, brief, { signal });
      outline = outlineResult.outline;
      ctx.setStep('outline', 'done');
      this.#emit('THOUGHT', {
        text: `Outline tersusun (${outline.length} slide) dan tersimpan sebagai deck kerangka:\n${outline.map((item, i) => `${i + 1}. [${item.layoutId}] ${item.title}`).join('\n')}`,
      });
      this.#throwIfAborted();

      const generation = slide?.generation ?? 'standard';
      if (generation === 'smart') {
        ctx.setStep('checkpoint', 'skipped');
      } else if (slide?.templateId) {
        ctx.setStep('checkpoint', 'done');
        this.#emit('THOUGHT', { text: `Template sudah dipilih di composer (${slide.templateId}) — checkpoint desain dilewati.` });
      } else {
        ctx.setStep('checkpoint', 'active');
        const chosen = await this.#askDesign(spec.id, outline);
        ctx.setStep('checkpoint', 'done');
        if (chosen) brief.templateId = chosen;
        this.#throwIfAborted();
      }
    } else {
      ctx.setStep('outline', 'done');
      ctx.setStep('checkpoint', 'done');
      const deck = await readDeck(root);
      this.#emit('THOUGHT', {
        text: `Deck sebelumnya ditemukan (${deck?.slides.length ?? 0} slide, sebagian masih kerangka) — pengisian dilanjutkan dari slide yang belum terisi; slide yang sudah diedit tidak ditimpa.`,
      });
    }

    ctx.setStep('fill', 'active');
    const fill = await fillDeckSlidesStage(this.#provider, root, {
      ...(brief.language ? { language: brief.language } : {}),
      ...(brief.templateId ? { templateId: brief.templateId } : {}),
      signal,
    });
    ctx.setStep('fill', fill.failures.length === 0 ? 'done' : 'active');
    this.#throwIfAborted();

    ctx.setStep('validate', 'active');
    const validation = await this.#validateAndEmit();
    const passed = validation.checks.every((check) => check.status === 'pass');
    ctx.setStep('validate', passed ? 'done' : 'active');

    if (fill.exported) {
      ctx.setStep('export', 'done');
      const summary = `done: ${fill.exported.slides} slide selesai dan ter-export ke ${fill.exported.path} (${Math.round(fill.exported.bytes / 1024)} KB) — deck valid, file .pptx bisa diunduh dari deck workspace.`;
      this.#emit('THOUGHT', { text: summary });
      return { state: { status: 'done' }, outcome: 'success', reason: 'completed', summary, validation, exported: fill.exported };
    }
    if (fill.exportError) {
      const summary = `Deck valid tapi export gagal: ${fill.exportError}. Deck tersimpan di deck/deck.json — jalankan export lagi dari panel deck.`;
      return { state: { status: 'failed', last_error: 'export_failed' }, outcome: 'failed', reason: 'export_failed', summary, validation };
    }
    const failedList = fill.failures.map((f) => `- ${f.slideId} [${f.layout}] "${f.title}": ${f.issues.join('; ')}`).join('\n');
    const summary = `Sebagian deck belum selesai (${fill.deck.slides.length - fill.failures.length}/${fill.deck.slides.length} slide terisi) dan BELUM ter-export — deck parsial tidak pernah dilaporkan selesai. Slide yang gagal:\n${failedList}\nKerangka deck tersimpan; kirim prompt lanjutan untuk melanjutkan pengisian slide tersebut.`;
    this.#emit('THOUGHT', { text: summary });
    return { state: { status: 'failed', last_error: 'slide_partial' }, outcome: 'partial', reason: 'slide_partial', summary, validation };
  }

  /**
   * The Standard checkpoint: one question card (same QUESTION_* shapes
   * ask_user emits) offering the bundled templates. The answer picks
   * the theme the fill stage applies; a timeout proceeds without a
   * template and says so; a cancel aborts the run.
   */
  async #askDesign(taskId: string, outline: OutlineItem[]): Promise<string | undefined> {
    const info: UserQuestionInfo = {
      id: randomUUID(),
      taskId,
      question: `Pilih arah desain untuk deck "${outline[0]?.title ?? 'presentasi'}" ini:`,
      options: SLIDE_TEMPLATES.map((template) => ({ label: template.name, description: template.description })),
      allowFreeText: true,
      createdAt: new Date().toISOString(),
    };
    this.#emit('QUESTION_REQUESTED', { question: info });
    await this.#deps.bus.drain();
    const result = await new Promise<{ outcome: 'answered' | 'timeout' | 'cancelled'; answer?: string }>((resolvePromise) => {
      let settled = false;
      const done = (value: { outcome: 'answered' | 'timeout' | 'cancelled'; answer?: string }): void => {
        if (settled) return;
        settled = true;
        resolvePromise(value);
      };
      void this.#deps.questions.ask(info).then(done);
      if (this.#abort.signal.aborted) done({ outcome: 'cancelled' });
      else this.#abort.signal.addEventListener('abort', () => done({ outcome: 'cancelled' }), { once: true });
    });
    const optionIndex = result.answer !== undefined ? info.options.findIndex((option) => option.label === result.answer) : -1;
    this.#emit('QUESTION_ANSWERED', {
      question_id: info.id,
      question: info.question,
      outcome: result.outcome,
      ...(result.answer !== undefined ? { answer: result.answer } : {}),
      ...(optionIndex >= 0 ? { option_index: optionIndex } : {}),
      ...(result.outcome === 'timeout' ? { timed_out: true } : {}),
      ...(result.outcome === 'cancelled' ? { cancelled: true } : {}),
    });
    await this.#deps.bus.drain();
    if (result.outcome === 'cancelled') throw new EngineAborted();
    if (result.outcome === 'timeout' || result.answer === undefined) {
      this.#emit('THOUGHT', { text: 'Checkpoint desain tidak dijawab — lanjut tanpa template (tema bawaan deck).' });
      return undefined;
    }
    const answer = result.answer.trim().toLowerCase();
    const match = SLIDE_TEMPLATES.find((template) => template.name.toLowerCase() === answer || template.id.toLowerCase() === answer);
    if (match) return match.id;
    this.#emit('THOUGHT', { text: `Jawaban checkpoint "${result.answer}" tidak cocok dengan template bawaan — lanjut tanpa mengganti tema.` });
    return undefined;
  }

  /* ------------------------------------------------------------ edit */

  async #runEdit(
    spec: TaskSpec,
    ctx: { setStep: (id: string, status: PlanStep['status']) => void; save: (patch: Partial<TaskState>) => void },
  ): Promise<{ state: Partial<TaskState>; outcome: SlideEngineOutcome; reason: string; summary: string; validation?: ValidationResult; exported?: { path: string; bytes: number; slides: number } }> {
    const root = this.#deps.workspaceRoot;
    const signal = this.#abort.signal;
    const deck = await readDeck(root);
    if (!deck) throw new SlidePipelineError('no deck exists in this workspace (deck/deck.json) — nothing to edit yet');

    ctx.setStep('ops', 'active');
    const system = [
      'You are the EDIT stage of a slide engine. Answer with ONLY a JSON object — no prose, no markdown fences: {"ops": [ ... ]}.',
      'Each op is one object from this closed vocabulary (no other ops exist):',
      '- {"op":"update_slide","slide_id":"<id>","content":{...partial content fields to merge...},"layout":"<optional layout id>"}',
      '- {"op":"add_slide","layout":"<layout id>","content":{...},"index":<optional 0-based position>}',
      '- {"op":"delete_slide","slide_id":"<id>"}',
      '- {"op":"move_slide","slide_id":"<id>","to_index":<0-based position>}',
      '- {"op":"set_theme","templateId":"<bundled template id>"}',
      '- {"op":"export"} — include when the user asks for the .pptx / export / download.',
      'Rules: change ONLY what the instruction asks; every other slide stays byte-identical. Use the exact slide ids from the deck summary. Content must satisfy the target layout schema. Never invent facts beyond what the instruction and the existing deck support.',
      `Layout ids: ${LAYOUTS.map((layout) => layout.id).join(', ')}.`,
      `Bundled template ids: ${SLIDE_TEMPLATES.map((t) => t.id).join(', ')}.`,
    ].join('\n');
    const summarySlides = deck.slides.map((s, i) => ({ n: i + 1, id: s.id, layout: s.layout, status: s.status, content: s.content }));
    const user = [
      `instruction: ${spec.goal}`,
      ...(spec.constraints.length > 0 ? [`constraints: ${spec.constraints.join(' | ')}`] : []),
      `current deck (title: ${deck.title}):`,
      JSON.stringify({ slides: summarySlides }, null, 1),
      'Return {"ops":[...]} now.',
    ].join('\n');

    let exportRequested = /(export|ekspor|pptx|powerpoint|unduh|download)/i.test(spec.goal);
    const next = await structuredCall(
      this.#provider,
      system,
      user,
      (value) => {
        const applied = applyDeckOps(deck, value);
        if (!applied.ok) return applied;
        if (applied.value.exportRequested) exportRequested = true;
        const errors = validateDeck(applied.value.deck, { root }).filter((issue) => issue.severity === 'error');
        if (errors.length > 0) return { ok: false, issues: errors.map((issue) => issue.message) };
        return applied;
      },
      signal,
    );
    this.#throwIfAborted();

    await writeDeck(root, next.deck);
    ctx.setStep('ops', 'done');
    this.#emit('THOUGHT', { text: `Perubahan diterapkan ke deck (${next.opsApplied} operasi, ${next.deck.slides.length} slide) dan tersimpan di deck/deck.json.` });

    ctx.setStep('validate', 'active');
    const validation = await this.#validateAndEmit();
    const passed = validation.checks.every((check) => check.status === 'pass');
    ctx.setStep('validate', passed ? 'done' : 'active');
    if (!passed) {
      const summary = 'Deck tersimpan tapi validasi deck gagal — lihat isu validasi di atas; deck tidak diubah lebih lanjut dan tidak di-export.';
      return { state: { status: 'failed', last_error: 'deck_validation_failed' }, outcome: 'failed', reason: 'deck_validation_failed', summary, validation };
    }

    if (exportRequested) {
      ctx.setStep('export', 'active');
      try {
        const fresh = (await readDeck(root)) ?? next.deck;
        const result = await exportDeckToPptx(fresh, root);
        ctx.setStep('export', 'done');
        const exported = { path: result.relativePath, bytes: result.bytes, slides: result.slideCount };
        const summary = `done: perubahan diterapkan (${next.opsApplied} operasi) dan deck ter-export ke ${exported.path} (${exported.slides} slide).`;
        this.#emit('THOUGHT', { text: summary });
        return { state: { status: 'done' }, outcome: 'success', reason: 'completed', summary, validation, exported };
      } catch (error) {
        const summary = `Perubahan diterapkan dan deck valid, tapi export gagal: ${errorText(error)}. Deck tersimpan di deck/deck.json — jalankan export lagi dari panel deck.`;
        return { state: { status: 'failed', last_error: 'export_failed' }, outcome: 'failed', reason: 'export_failed', summary, validation };
      }
    }
    ctx.setStep('export', 'skipped');
    const summary = `done: perubahan diterapkan ke deck (${next.opsApplied} operasi, ${next.deck.slides.length} slide) dan tersimpan. Export .pptx belum diminta — tombol Export .pptx di panel deck selalu tersedia.`;
    this.#emit('THOUGHT', { text: summary });
    return { state: { status: 'done' }, outcome: 'success', reason: 'completed', summary, validation };
  }

  async #validateAndEmit(): Promise<ValidationResult> {
    this.#emit('VALIDATION_STARTED', { task_id: this.#taskId });
    const result = await new DeckValidator().validate({ workspaceRoot: this.#deps.workspaceRoot });
    const passed = result.checks.every((check) => check.status === 'pass');
    this.#emit(passed ? 'VALIDATION_PASSED' : 'VALIDATION_FAILED', { result });
    return result;
  }
}

/* -------------------------------------------------------- deck ops */

type AppliedOps = { deck: DeckSpec; opsApplied: number; exportRequested: boolean };

function slideIndexOf(deck: DeckSpec, id: unknown, opIndex: number, issues: string[]): number {
  if (typeof id !== 'string' || id.length === 0) {
    issues.push(`op ${opIndex + 1}: slide_id must be a non-empty string`);
    return -1;
  }
  const index = deck.slides.findIndex((slide) => slide.id === id);
  if (index < 0) issues.push(`op ${opIndex + 1}: slide_id "${id}" does not exist in this deck`);
  return index;
}

/**
 * Apply the closed op vocabulary to a CLONE of the deck. Any invalid
 * op invalidates the whole batch (issues returned verbatim for the
 * retry): the real deck is written only from a fully validated clone,
 * so a bad edit round leaves the deck byte-identical.
 */
export function applyDeckOps(deck: DeckSpec, value: unknown): { ok: true; value: AppliedOps } | { ok: false; issues: string[] } {
  if (!isObj(value) || !Array.isArray(value.ops)) {
    return { ok: false, issues: ['output must be a JSON object {"ops":[...]} with a non-empty ops array'] };
  }
  if (value.ops.length === 0) return { ok: false, issues: ['ops array is empty — return at least one operation'] };
  const issues: string[] = [];
  const next = clone(deck);
  let exportRequested = false;
  let applied = 0;
  value.ops.forEach((raw, opIndex) => {
    if (!isObj(raw) || typeof raw.op !== 'string') {
      issues.push(`op ${opIndex + 1}: each op must be an object with an "op" field`);
      return;
    }
    switch (raw.op) {
      case 'update_slide': {
        const index = slideIndexOf(next, raw.slide_id, opIndex, issues);
        if (index < 0) return;
        const slide = next.slides[index]!;
        if (raw.layout !== undefined) {
          if (typeof raw.layout !== 'string' || !getLayout(raw.layout)) {
            issues.push(`op ${opIndex + 1}: unknown layout "${String(raw.layout)}"`);
            return;
          }
          slide.layout = raw.layout;
        }
        if (!isObj(raw.content)) {
          issues.push(`op ${opIndex + 1}: update_slide needs a "content" object (partial fields merged into the slide)`);
          return;
        }
        slide.content = { ...slide.content, ...clone(raw.content) };
        slide.status = 'filled';
        applied += 1;
        return;
      }
      case 'add_slide': {
        if (typeof raw.layout !== 'string' || !getLayout(raw.layout)) {
          issues.push(`op ${opIndex + 1}: add_slide needs a valid "layout" id`);
          return;
        }
        const layout = getLayout(raw.layout)!;
        const content = isObj(raw.content) ? { ...clone(layout.defaults), ...clone(raw.content) } : clone(layout.defaults);
        const slide: Slide = { id: newSlideId(), layout: raw.layout, content, status: 'filled' };
        const at = typeof raw.index === 'number' && Number.isFinite(raw.index) ? Math.max(0, Math.min(next.slides.length, Math.floor(raw.index))) : next.slides.length;
        next.slides = [...next.slides.slice(0, at), slide, ...next.slides.slice(at)];
        applied += 1;
        return;
      }
      case 'delete_slide': {
        const index = slideIndexOf(next, raw.slide_id, opIndex, issues);
        if (index < 0) return;
        next.slides = next.slides.filter((_, i) => i !== index);
        applied += 1;
        return;
      }
      case 'move_slide': {
        const index = slideIndexOf(next, raw.slide_id, opIndex, issues);
        if (index < 0) return;
        const toRaw = typeof raw.to_index === 'number' && Number.isFinite(raw.to_index) ? Math.floor(raw.to_index) : index;
        const to = Math.max(0, Math.min(next.slides.length - 1, toRaw));
        const [slide] = next.slides.splice(index, 1);
        next.slides.splice(to, 0, slide!);
        applied += 1;
        return;
      }
      case 'set_theme': {
        const template = typeof raw.templateId === 'string' ? getSlideTemplate(raw.templateId) : undefined;
        if (!template) {
          issues.push(`op ${opIndex + 1}: set_theme needs a bundled templateId (${SLIDE_TEMPLATES.map((t) => t.id).join(', ')})`);
          return;
        }
        next.theme = { ...template.theme, templateId: template.id };
        applied += 1;
        return;
      }
      case 'export': {
        exportRequested = true;
        applied += 1;
        return;
      }
      default:
        issues.push(`op ${opIndex + 1}: unknown op "${raw.op}" — allowed: update_slide, add_slide, delete_slide, move_slide, set_theme, export`);
    }
  });
  if (issues.length > 0) return { ok: false, issues };
  return { ok: true, value: { deck: next, opsApplied: applied, exportRequested } };
}
