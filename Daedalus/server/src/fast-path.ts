import {
  answerConversational,
  answerQuestion,
  classifyChatIntent,
  conversationalFallbackReply,
  createProviderForConfig,
  emitEvent,
  questionFallbackReply,
  type LLMProvider,
  type TaskStore,
} from "@daedalus/core";
import type { AppContext } from "./app.ts";

/**
 * Direct-answer fast paths for the Web composer (the Crush/Cline message
 * pattern: a plain message goes straight to the model and the reply IS the
 * result — no manufactured implementation plan, no tool loop, no
 * validation gate).
 *
 * Core's classifier decides 'conversational' | 'question' | 'task' and core
 * supplies the single-call answer helpers; this module only detects any
 * pure-question line an older core build might still call a task, resolves
 * the composer's provider/model selection, and records the exchange in the
 * same event log the Chat panel renders.
 */

export type WebIntent = "conversational" | "question" | "task";

/** Imperative work verbs: any of these makes the line a task, question or not. */
const ACTION_VERB_PATTERN =
  /\b(fix|repair|debug|refactor|implement|create|generate|build|compile|deploy|install|uninstall|run|execute|add|remove|delete|update|upgrade|edit|change|modify|write|rewrite|rename|move|copy|migrate|optimize|perbaiki|benerin|buatkan|bikin(kan)?|tambah(kan)?|hapus(kan)?|ubah(i)?|ganti|jalankan|tulis(kan)?|sunting|pindah(kan)?|salin|buang|pasang|lepas|kerjakan|kerjain|selesaikan)\b/i;

/** Failure/problem reports belong to the investigative task path, not Q&A. */
const PROBLEM_PATTERN = /\b(error|errors|gagal|rusak|crash|bug|exception|stack ?trace|fail(ed|ure)?|tidak jalan|nggak jalan|ga jalan|berantakan)\b/i;

const QUESTION_SIGNAL_PATTERN =
  /(\?|^(apa|apakah|siapa|kenapa|mengapa|bagaimana|gimana|kapan|berapa|dimana|di mana|apa itu|what|who|why|how|when|which|whose)\b|\b(tentang apa|siapa (kamu|saya|aku|dia)|repo ini tentang|proyek ini tentang|project ini tentang)\b)/i;

/**
 * A pure information-seeking line: it asks something and requests no change,
 * creation, run, or investigation. Bias stays toward 'task' — anything with
 * an action verb or a problem report keeps the full runner semantics.
 */
export function isPureQuestion(input: string): boolean {
  const text = input.trim();
  if (!text || text.length > 600) return false;
  if (ACTION_VERB_PATTERN.test(text)) return false;
  if (PROBLEM_PATTERN.test(text)) return false;
  return QUESTION_SIGNAL_PATTERN.test(text);
}

export function classifyWebIntent(goal: string): WebIntent {
  const intent: string = classifyChatIntent(goal);
  if (intent === "conversational") return "conversational";
  if (intent === "question") return "question";
  if (isPureQuestion(goal)) return "question";
  return "task";
}

export type FastPathSelection = {
  providerId?: string;
  model?: string;
  poolModels: string[];
};

/**
 * Resolve the provider for a fast path exactly like the composer expects:
 * the selected provider config (or the first enabled one), the selected
 * model (or the pool's first entry, or the config default). Returns
 * undefined when nothing is configured — callers fall back gracefully.
 */
export function resolveFastPathProvider(ctx: AppContext, selection: FastPathSelection): LLMProvider | undefined {
  const registry = ctx.providerStore.registry;
  const config = (selection.providerId ? registry.get(selection.providerId) : undefined) ?? registry.listInternal().find((provider) => provider.enabled);
  const model = selection.model || selection.poolModels[0] || config?.defaultModel || config?.models[0] || ctx.settings.llm.model;
  if (config) return createProviderForConfig(config, model);
  if (ctx.settings.llm.baseUrl) return createProviderForConfig({ baseUrl: ctx.settings.llm.baseUrl, apiKey: ctx.settings.llm.apiKey }, model);
  return undefined;
}

export type FastPathRun = {
  ctx: AppContext;
  store: TaskStore;
  taskId: string;
  goal: string;
  mode: string;
  repoPath: string;
  intent: Exclude<WebIntent, "task">;
  thinking: boolean;
  selection: FastPathSelection;
};

/**
 * Run a conversational/question task as a single provider call recorded in
 * the same event log the Chat panel already renders: TASK_STARTED (the
 * user's line) → MODEL_REQUEST_* → the assistant reply → TASK_COMPLETED.
 * No plan, no tools, no validation. Fire-and-forget like the task runner;
 * every failure still lands as a terminal TASK_COMPLETED so the panel
 * never spins forever.
 */
export function executeFastPath(run: FastPathRun): void {
  const { ctx, store, taskId, goal, intent, repoPath } = run;
  const target = { bus: ctx.bus, store };
  void (async () => {
    const provider = resolveFastPathProvider(ctx, run.selection);
    emitEvent(target, taskId, undefined, "MODEL_REQUEST_STARTED", {
      provider: provider?.name ?? "none",
      model: run.selection.model || run.selection.poolModels[0] || null,
      intent,
      messages: intent === "question" ? 2 : 1,
    });
    let reply: string;
    try {
      if (!provider) {
        reply = intent === "conversational" ? conversationalFallbackReply() : questionFallbackReply();
      } else if (intent === "conversational") {
        reply = await answerConversational(provider, goal);
      } else {
        reply = await answerQuestion(provider, goal, { workspaceDir: repoPath });
      }
    } catch (error) {
      emitEvent(target, taskId, undefined, "MODEL_REQUEST_FAILED", { error: String(error), intent });
      reply =
        intent === "conversational"
          ? "Maaf, saya lagi nggak bisa nyambung ke model barusan. Coba lagi sebentar, atau jelaskan tugas coding-nya langsung."
          : "Maaf, pertanyaan itu belum bisa saya jawab — koneksi ke model barusan gagal. Coba lagi sebentar.";
      ctx.log.error("fast path provider error", { task_id: taskId, intent, error: String(error) });
    }
    if (store.isCancelRequested(taskId)) {
      persistTerminal(run, "failed", "aborted");
      emitEvent(target, taskId, undefined, "TASK_COMPLETED", { outcome: "failed", reason: "aborted", intent });
      return;
    }
    emitEvent(target, taskId, undefined, "MODEL_REQUEST_FINISHED", {
      message: { role: "assistant", content: reply },
      finish_reason: "stop",
      intent,
    });
    persistTerminal(run, "done", undefined);
    emitEvent(target, taskId, undefined, "TASK_COMPLETED", { outcome: "success", reason: intent, intent });
  })().catch((error: unknown) => {
    ctx.log.error("fast path run error", { task_id: taskId, error: String(error) });
    try {
      persistTerminal(run, "failed", "fast_path_error");
      emitEvent(target, taskId, undefined, "TASK_COMPLETED", { outcome: "failed", reason: "fast_path_error", intent });
    } catch {
      /* the log line above is the record of last resort */
    }
  });
}

function persistTerminal(run: FastPathRun, status: "done" | "failed", lastError?: string): void {
  const previous = run.store.loadState<Record<string, unknown>>(run.taskId) ?? {};
  run.store.saveState(run.taskId, {
    ...previous,
    status,
    ...(lastError ? { last_error: lastError } : {}),
    updated_at: new Date().toISOString(),
  });
}
