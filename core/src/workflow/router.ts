import type { ArtifactKind, ArtifactRef, RunContext, RunTurn, WorkflowEngine } from "./types.ts";
import { isWorkflowEngine, WORKFLOW_ENGINES } from "./types.ts";

/** Pending (still-running) turn → artifact kind, for "tadi" references. */
const PENDING_KIND: Record<WorkflowEngine, ArtifactKind> = {
  coding: "files",
  slide: "deck",
  dokumen: "document",
  spreadsheet: "workbook",
  research: "research_report",
};

/**
 * Dae Captain router — chat message → engine (layer A: deterministic rules).
 *
 * Precedent: `classifyChatIntent` (core/src/agent/conversation.ts) and
 * `classifyWebIntent` (server/src/fast-path.ts) — pure string rules, zero
 * model calls, fully testable. Layer B (a single cheap LLM call) lives in
 * the server and only runs when the rule confidence is below threshold.
 */

export type RuleRouteResult = {
  engine: WorkflowEngine;
  /** 0..1 — below RULE_CONFIDENCE_THRESHOLD the server tries layer B. */
  confidence: number;
  matchedRule: string;
};

export const RULE_CONFIDENCE_THRESHOLD = 0.6;

export type RouteOptions = {
  /** Explicit engine chip override from the composer — always wins. */
  engineOverride?: WorkflowEngine;
  /** Engine of the run's most recent turn (for "tadi" continuation). */
  previousEngine?: WorkflowEngine;
};

const lower = (s: string): string => s.toLowerCase();

/**
 * Explicit no-modification request — always conversational, even when the
 * message names code ("Jelaskan kode ini tanpa mengubahnya").
 */
const NO_MODIFY_RE =
  /\b(tanpa\s+(mengubah|merubah|diubah|modifikasi)|jangan\s+(diubah|mengubah|merubah)|hanya\s+jelaskan|cuma\s+jelaskan|tanpa\s+menulis\s+file|do\s+not\s+(modify|change|edit)|without\s+(modifying|changing|editing))\b/;

/**
 * Leading execution imperatives ("Buatkan … di folder huhu",
 * "Perbaiki bug pada project ini"). When present the message is work even
 * if it ends with "?" — a trailing question mark alone is not a chat signal.
 */
const EXEC_LEAD_RE =
  /^\s*(buatkan|buatin|buat|tolong\s+(buatkan|buatin|buatkan?)?|perbaiki|betulkan|refactor|refaktor|deploy|tulis|tuliskan|catat|rekap|riset|telaah|research|analisis|analisa|analyse|fix|create|generate|build)\b/;

/** Leading question words (ID + EN) — explanatory, not execution. */
const QUESTION_LEAD_RE =
  /^\s*(apa|apakah|siapa|kenapa|mengapa|bagaimana|gimana|kapan|dimana|di\s*mana|berapa|jelaskan|tolong\s+jelaskan|what|why|who|when|where|how|which|can you explain|explain)\b/;

/** Trailing-? question markers ("1 + 1 berapa?", "Apa perbedaan React dan Vue?"). */
const QUESTION_TAIL_RE =
  /\b(berapa|siapa|apa|kenapa|mengapa|bagaimana|perbedaan|jelaskan|apakah|kapan|dimana)\b[^?.!]{0,80}\?\s*$/;

/**
 * Conversational-first guard for POST /workflow/chat.
 *
 * Returns true when the message is an ordinary question or explanation
 * request that must NOT launch the agentic runtime — even when it names a
 * domain verb ("Bagaimana cara membuat landing page?", "Apa perbedaan
 * React dan Vue?", "Jelaskan kode ini tanpa mengubahnya").
 *
 * An explicit engine override (composer chip) bypasses this guard; the
 * caller checks the override first.
 */
export function isConversationalMessage(message: string): boolean {
  const text = lower(message).trim();
  if (!text) return true;
  if (NO_MODIFY_RE.test(text)) return true;
  if (EXEC_LEAD_RE.test(text)) return false;
  if (QUESTION_LEAD_RE.test(text)) return true;
  if (QUESTION_TAIL_RE.test(text)) return true;
  return false;
}

/** "dari <engine> tadi" — explicit engine mention with a continuation word. */
const ENGINE_MENTION: Array<{ engine: WorkflowEngine; re: RegExp }> = [
  { engine: "slide", re: /\bslide\b/ },
  { engine: "spreadsheet", re: /\bspreadsheet\b|\bexcel\b/ },
  { engine: "dokumen", re: /\bdokumen\b|\bpdf\b/ },
  { engine: "research", re: /\briset\b|\bresearch\b/ },
  { engine: "coding", re: /\bkode\b|\bcode\b|\bcoding\b/ },
];

const CONTINUATION_RE =
  /\b(tadi|itu|tersebut|lanjutkan|lanjut|teruskan|perbaiki|betulkan|revisi|update|ubah|tambahin|tambahkan)\b/;

type DomainVerbs = { engine: WorkflowEngine; re: RegExp };

/**
 * Priority order matters: the first matching engine wins on a single hit.
 * (slide, spreadsheet, research, dokumen, coding) mirrors the design doc.
 */
const DOMAIN_VERBS: DomainVerbs[] = [
  {
    engine: "slide",
    re: /\b(slide|slides|presentasi|deck|pptx?|powerpoint)\b/,
  },
  {
    engine: "spreadsheet",
    re: /\b(spreadsheet|excel|workbook|pemasukan|pengeluaran|tabel|kolom|baris|rumus|formula|csv|xlsx?|anggaran|rekap)\b/,
  },
  {
    engine: "research",
    re: /\b(riset|research|telaah|literatur|jurnal|paper|kajian|benchmarking)\b|\bapakah\b.{0,48}\b(benar|betul|bagus|baik|valid|akurat)\b/,
  },
  {
    engine: "dokumen",
    re: /\b(dokumen|document|pdf|docx?|surat|kontrak|makalah)\b|\blaporan tertulis\b/,
  },
  {
    engine: "coding",
    re: /\b(kode|code|coding|bug|error|refactor|fungsi|function|landing ?page|vue|react|angular|svelte|html|css|javascript|typescript|folder|file|repo|git|npm|deploy|server|api|database|program|aplikasi|script|web|website|component|komponen|terminal|command)\b/,
  },
];

/**
 * Deterministic layer-A routing. Never calls a model.
 */
export function routeByRules(
  message: string,
  options: RouteOptions = {},
): RuleRouteResult {
  const text = lower(message);

  if (options.engineOverride && isWorkflowEngine(options.engineOverride)) {
    return {
      engine: options.engineOverride,
      confidence: 1,
      matchedRule: "engine_override",
    };
  }

  // "dari <X> tadi <verb> <Y>" — the target is the LAST engine named
  // ("dari slide tadi catat di spreadsheet" → spreadsheet, the new
  // intent; "dari landing page tadi buatkan slide" → slide).
  if (CONTINUATION_RE.test(text)) {
    let last: { engine: WorkflowEngine; index: number } | undefined;
    for (const mention of ENGINE_MENTION) {
      const m = mention.re.exec(text);
      if (m && m.index >= (last?.index ?? -1)) {
        last = { engine: mention.engine, index: m.index };
      }
    }
    if (last) {
      return {
        engine: last.engine,
        confidence: 0.9,
        matchedRule: "engine_mention_continuation",
      };
    }
    if (options.previousEngine) {
      return {
        engine: options.previousEngine,
        confidence: 0.75,
        matchedRule: "continuation",
      };
    }
  }

  // A leading research imperative ("riset X", "telaah Y") is unambiguous:
  // the verb is the action, later nouns are just its object.
  if (/^(riset|research|telaah)\b/.test(text)) {
    return {
      engine: "research",
      confidence: 0.9,
      matchedRule: "leading_research_verb",
    };
  }

  const hits = DOMAIN_VERBS.filter((entry) => entry.re.test(text));
  if (hits.length === 1) {
    return {
      engine: hits[0]!.engine,
      confidence: 0.85,
      matchedRule: "domain_verb",
    };
  }
  if (hits.length > 1) {
    // Genuinely ambiguous ("presentasi dari data spreadsheet") — let
    // layer B or the user decide instead of guessing.
    return {
      engine: hits[0]!.engine,
      confidence: 0.55,
      matchedRule: "domain_verb_multi",
    };
  }

  return { engine: "coding", confidence: 0.4, matchedRule: "default" };
}

/**
 * Resolve "tadi" / "itu" style references against the run's turns.
 * Returns the artifact refs the user most likely means; the caller shows
 * them before dispatch ("Mengambil: ...") so a wrong guess is visible.
 *
 * Artifact-carrying turns win; when the referenced turn is still running
 * (no artifacts yet) a pending ref synthesized from its goal is returned
 * instead of nothing — the client can show "landing page (masih jalan)".
 */
export function resolveReferences(
  message: string,
  run: RunContext | undefined,
): ArtifactRef[] {
  if (!run || run.turns.length === 0) return [];
  const text = lower(message);
  if (!CONTINUATION_RE.test(text)) return [];

  const pendingRef = (turn: RunTurn): ArtifactRef => ({
    kind: PENDING_KIND[turn.engine],
    label: `${turn.goal} (masih berjalan)`,
    task_id: turn.task_id,
  });

  // "dari <engine> tadi" → that engine's latest turn, artifacts preferred.
  for (const mention of ENGINE_MENTION) {
    if (mention.re.test(text)) {
      const turns = [...run.turns]
        .reverse()
        .filter((t) => t.engine === mention.engine);
      const done = turns.find((t) => t.artifacts.length > 0);
      if (done) return done.artifacts;
      if (turns[0]) return [pendingRef(turns[0])];
    }
  }

  // Bare "tadi" → latest turn with artifacts, else the latest turn outright.
  const done = [...run.turns].reverse().find((t) => t.artifacts.length > 0);
  if (done) return done.artifacts;
  const latest = run.turns[run.turns.length - 1];
  return latest ? [pendingRef(latest)] : [];
}

/** Render resolved refs as context appended to the dispatched goal. */
export function formatResolvedForGoal(refs: ArtifactRef[]): string {
  if (refs.length === 0) return "";
  const lines = refs.map((ref) => {
    const where = ref.path ?? ref.export_path ?? ref.url ?? ref.report_id ?? "";
    return `- ${ref.label}${where ? ` (${where})` : ""}`;
  });
  return [
    "",
    "Konteks — artifact dari langkah sebelumnya (jangan dibuat ulang, pakai sebagai acuan):",
    ...lines,
  ].join("\n");
}

// ---------------------------------------------------------------------------
// Layer B — single cheap LLM call (executed by the server, which owns the
// provider). Core only builds the prompt and parses the closed JSON answer.
// ---------------------------------------------------------------------------

const LAYER_B_ENGINES = WORKFLOW_ENGINES.join(", ");

export function buildLayerBPrompt(message: string): {
  system: string;
  user: string;
} {
  return {
    system: [
      'Kamu adalah router untuk asisten multi-engine "Dae Captain".',
      "Pilih SATU engine yang paling cocok untuk perintah user.",
      `Engine: ${LAYER_B_ENGINES}.`,
      "- coding: pemrograman, file/folder, bug/error, web/landing page, terminal",
      "- slide: presentasi, deck, PPT",
      "- dokumen: dokumen tertulis, PDF, surat",
      "- spreadsheet: tabel, Excel, data/angka, pemasukan",
      "- research: riset, literatur/jurnal, verifikasi klaim",
      'Balas HANYA dengan JSON valid: {"engine": "<salah satu dari lima>", "confidence": 0.0-1.0, "needs_clarify": true/false}.',
      "needs_clarify=true bila perintah terlalu ambigu untuk diputuskan.",
    ].join("\n"),
    user: message,
  };
}

export type LayerBResult = {
  engine: WorkflowEngine;
  confidence: number;
  needs_clarify: boolean;
};

/** Parse the closed JSON answer. Returns undefined on any malformed output. */
export function parseLayerBResponse(text: string): LayerBResult | undefined {
  let parsed: unknown;
  try {
    const start = text.indexOf("{");
    const end = text.lastIndexOf("}");
    if (start < 0 || end <= start) return undefined;
    parsed = JSON.parse(text.slice(start, end + 1));
  } catch {
    return undefined;
  }
  if (typeof parsed !== "object" || parsed === null) return undefined;
  const record = parsed as Record<string, unknown>;
  if (!isWorkflowEngine(record["engine"])) return undefined;
  const confidence =
    typeof record["confidence"] === "number"
      ? Math.min(1, Math.max(0, record["confidence"]))
      : 0.5;
  return {
    engine: record["engine"],
    confidence,
    needs_clarify: record["needs_clarify"] === true,
  };
}
