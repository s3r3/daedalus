import type {
  ArtifactKind,
  ArtifactRef,
  RunContext,
  RunTurnStatus,
  WorkflowEngine,
} from "./types.ts";
import type { TimelineEvent, TimelineEventPayload } from "./timeline.ts";
import { routeByRules } from "./router.ts";

/**
 * Dae Captain continuation classifier (v2, Fase 3A).
 *
 * Design source: "Dae Captain - Master Design.md", Arsitektur Global #2.4
 * (Kontinuasi). A new user message is classified against the run's event
 * timeline — deterministic rules, zero model calls:
 *
 *   continue   – reference words ("itu", "tadi", "yang X", "-nya",
 *                "slide 3", "bab 2") or a topic still connected to the
 *                recent tasks. DEFAULT: continuation by design principle.
 *   new_topic  – clearly different topic, no reference, no overlap.
 *   resume     – "balik ke X" / "kembali ke X" / "lanjutkan yang tadi":
 *                reactivate an older task/deck/file found in the timeline.
 *   interrupt  – "stop" / "ganti" / "batalkan" / "jangan": stop the current
 *                work and redirect.
 *
 * Ambiguity ("ubah yang itu" with two matching candidates) never blocks:
 * the highest-scoring referent wins and the rest ride along as
 * `alternatives`, so the UI can offer Undo / a picker instead of asking.
 */

/** Classification of one user message against the active run. */
export type ContinuationKind = "continue" | "new_topic" | "resume" | "interrupt";

/** "stop, ganti template" — checked AFTER resume so "stop, balik ke X" resumes. */
export const INTERRUPT_RE =
  /\b(stop|cancel|batal(?:kan)?|ganti|jangan|hentikan|urungkan)\b/i;

/** "balik ke presentasi tadi" / "lanjutkan yang tadi". */
export const RESUME_RE =
  /\b(balik\s+(lagi\s+)?ke|kembali\s+ke|lanjutkan\s+yang\s+tadi|teruskan\s+yang\s+tadi)\b/i;

/**
 * Reference signals: pronouns ("itu", "tadi", "tersebut"), the "-nya"
 * clitic ("css-nya", "warnanya" — "hanya"/"tanya" excluded), "yang X"
 * noun phrases, ordinals ("slide 3", "bab 2"), and continuation verbs
 * carried over from the router's layer-A rules.
 */
export const REFERENCE_RE = new RegExp(
  [
    String.raw`\b(tadi|itu|tersebut|terakhir|kemarin|sebelumnya|barusan)\b`,
    // "-nya" clitic; excludes "hanya" (only) and "tanya" (ask)
    String.raw`\b(?!(?:hanya|tanya)\b)[a-z]+-?nya\b`,
    String.raw`\byang\s+[a-z0-9][a-z0-9-]*\b`,
    String.raw`\b(slide|bab|bagian|sheet|halaman|file|versi|nomor|no\.?|sumber|klaim|temuan|langkah)\s*\d+\b`,
    String.raw`\b(lanjutkan|lanjut|teruskan|perbaiki|betulkan|revisi|update|ubah|tambahin|tambahkan|tambah|edit)\b`,
  ].join("|"),
  "i",
);

/** A factoid question with zero overlap ("siapa windah basudara?"). */
const QUESTION_LEAD_RE =
  /^\s*(apa|apakah|siapa|kenapa|mengapa|bagaimana|gimana|kapan|dimana|di\s*mana|berapa|jelaskan|what|why|who|when|where|how|which|can you explain|explain)\b/i;
const QUESTION_TAIL_RE = /\?\s*$/;

/** Latest state of one task, rebuilt from the timeline's task_start/task_end pairs. */
export type TaskEntry = {
  taskId: string;
  engine: WorkflowEngine;
  goal: string;
  status: RunTurnStatus;
  artifacts: ArtifactRef[];
  note?: string;
  startedAt: string;
  endedAt?: string;
};

/**
 * Rebuild per-task latest state from the run timeline (single source).
 * Chronological by task start; a later task_end overrides the status and
 * artifacts of its task_id.
 */
export function getTaskEntries(run: RunContext | undefined): TaskEntry[] {
  if (!run) return [];
  const starts = new Map<string, TimelineEvent<"task_start">>();
  const ends = new Map<string, TimelineEvent<"task_end">>();
  for (const e of run.events) {
    if (e.type === "task_start") {
      starts.set(
        (e.payload as TimelineEventPayload["task_start"]).task_id,
        e as TimelineEvent<"task_start">,
      );
    } else if (e.type === "task_end") {
      ends.set(
        (e.payload as TimelineEventPayload["task_end"]).task_id,
        e as TimelineEvent<"task_end">,
      );
    }
  }
  const entries: TaskEntry[] = [];
  for (const start of starts.values()) {
    const sp = start.payload;
    const end = ends.get(sp.task_id);
    const ep = end?.payload as TimelineEventPayload["task_end"] | undefined;
    entries.push({
      taskId: sp.task_id,
      engine: sp.engine,
      goal: sp.goal,
      status: ep?.status ?? "running",
      artifacts: ep?.artifacts ?? [],
      ...(ep?.note ?? sp.note ? { note: ep?.note ?? sp.note } : {}),
      startedAt: start.timestamp,
      ...(end ? { endedAt: end.timestamp } : {}),
    });
  }
  entries.sort((a, b) => a.startedAt.localeCompare(b.startedAt));
  return entries;
}

const STOPWORDS = new Set(
  [
    "yang", "dan", "dari", "untuk", "dengan", "pada", "ini", "itu", "tersebut",
    "tadi", "ada", "adalah", "ke", "di", "tidak", "nggak", "gak", "tak",
    "saya", "kamu", "aku", "anda", "kita", "kami", "mereka", "dia", "beliau",
    "mau", "bisa", "dapat", "sudah", "udah", "akan", "belum", "masih", "lagi",
    "juga", "atau", "tapi", "tetapi", "karena", "dalam", "oleh", "sebagai",
    "lebih", "kurang", "sangat", "banyak", "semua", "setiap", "antara",
    "jika", "kalau", "agar", "supaya", "tolong", "mohon", "ya", "dong",
    "aja", "saja", "pun", "kah", "lah", "kan", "kok", "sih", "nih", "tuh",
    "dah", "yuk", "mari", "coba", "silakan", "harap", "buat", "buatkan",
    "buatlah", "bikin", "bikinlah", "tentang", "kemarin", "barusan",
    "sekarang", "nanti", "dulu", "kembali", "tanpa", "pakai", "memakai",
    "the", "and", "for", "with", "this", "that", "you", "your", "please",
  ],
);

/**
 * Content tokens of a message: lowercase, length >= 3, stopwords removed.
 * A "-nya" clitic also contributes its stem ("hasilnya" -> "hasil").
 */
export function tokenize(text: string): string[] {
  const out: string[] = [];
  for (const raw of text.toLowerCase().split(/[^a-z0-9]+/)) {
    if (raw.length < 3 || STOPWORDS.has(raw)) continue;
    out.push(raw);
    if (raw.length > 5 && raw.endsWith("nya")) {
      const stem = raw.slice(0, -3);
      if (stem.length >= 3 && !STOPWORDS.has(stem)) out.push(stem);
    }
  }
  return out;
}

/**
 * Classify a new user message against the run's timeline.
 *
 * Order matters: resume beats interrupt ("stop, balik ke yang tadi" goes
 * back), explicit reference signals beat the topic check, and an empty
 * timeline (nothing to continue) is always a new topic.
 */
export function classify(
  message: string,
  run: RunContext | undefined,
): ContinuationKind {
  const text = message.trim();
  if (!text) return "new_topic";
  if (RESUME_RE.test(text)) return "resume";
  if (INTERRUPT_RE.test(text)) return "interrupt";
  if (REFERENCE_RE.test(text)) return "continue";

  const tasks = getTaskEntries(run);
  if (tasks.length === 0) return "new_topic";

  const recent = tasks.slice(-3);
  const ctxText = recent
    .map(
      (t) =>
        `${t.goal} ${t.artifacts.map((a) => `${a.label} ${a.path ?? ""} ${a.export_path ?? ""}`).join(" ")}`,
    )
    .join(" ")
    .toLowerCase();
  if (tokenize(text).some((tok) => ctxText.includes(tok))) return "continue";

  // Clearly different topic, no reference: a factoid question, or a work
  // request routed confidently to an engine none of the recent tasks used.
  if (QUESTION_LEAD_RE.test(text) || QUESTION_TAIL_RE.test(text)) {
    return "new_topic";
  }
  const routed = routeByRules(message);
  if (
    routed.confidence >= 0.6 &&
    recent.every((t) => t.engine !== routed.engine)
  ) {
    return "new_topic";
  }

  // Design principle: continuation by default.
  return "continue";
}

// ---------------------------------------------------------------------------
// Referent resolution — which task/deck/file does "itu"/"tadi" mean?
// ---------------------------------------------------------------------------

/** Pending (still-running) task → artifact kind, for "tadi" references. */
const PENDING_KIND: Record<WorkflowEngine, ArtifactKind> = {
  coding: "files",
  slide: "deck",
  dokumen: "document",
  spreadsheet: "workbook",
  research: "research_report",
};

const ENGINE_KEYWORDS: Array<{ engine: WorkflowEngine; re: RegExp }> = [
  { engine: "slide", re: /\bslide\b|\bdeck\b|\bpptx?\b|\bpresentasi\b/ },
  { engine: "spreadsheet", re: /\bspreadsheet\b|\bexcel\b|\bworkbook\b|\bxlsx?\b/ },
  { engine: "dokumen", re: /\bdokumen\b|\bpdf\b|\bdocx?\b|\bsurat\b|\bmakalah\b/ },
  { engine: "research", re: /\briset\b|\bresearch\b|\bjurnal\b|\bliteratur\b/ },
  { engine: "coding", re: /\bkode\b|\bcode\b|\bcoding\b|\blanding\s*page\b/ },
];

export type ReferentCandidate = {
  taskId: string;
  engine: WorkflowEngine;
  goal: string;
  status: RunTurnStatus;
  /** Deterministic score — highest wins, rest become `alternatives`. */
  score: number;
  hasArtifacts: boolean;
  /** Artifacts, or a synthesized pending ref when the task is still running. */
  refs: ArtifactRef[];
};

function refsFor(t: TaskEntry): ArtifactRef[] {
  if (t.artifacts.length > 0) return t.artifacts;
  return [
    {
      kind: PENDING_KIND[t.engine],
      label: `${t.goal} (masih berjalan)`,
      task_id: t.taskId,
    },
  ];
}

/**
 * Score every recent task as a referent for the message. Signals:
 * recency (newest +6, decaying), engine keyword mention (+8, +12 for the
 * LAST engine named — "dari slide tadi catat di spreadsheet" targets the
 * spreadsheet), "yang X" keyword hits (+3), ordinal number hits (+4),
 * delivered artifacts (+2), finished status (+1).
 */
export function scoreReferents(
  message: string,
  run: RunContext | undefined,
): ReferentCandidate[] {
  const text = message.toLowerCase();
  const tasks = getTaskEntries(run).slice(-8);
  if (tasks.length === 0) return [];

  const mentions: Array<{ engine: WorkflowEngine; index: number }> = [];
  for (const k of ENGINE_KEYWORDS) {
    const m = k.re.exec(text);
    if (m) mentions.push({ engine: k.engine, index: m.index });
  }
  mentions.sort((a, b) => a.index - b.index);
  const lastMention = mentions[mentions.length - 1];

  const yangWords = [...text.matchAll(/\byang\s+([a-z0-9][a-z0-9-]*)/g)].map(
    (m) => m[1]!,
  );
  const ordinals = [
    ...text.matchAll(
      /\b(slide|bab|bagian|sheet|halaman|file|versi|nomor|no\.?|sumber|klaim|temuan)\s*(\d+)\b/g,
    ),
  ].map((m) => m[2]!);

  const scored = tasks.map((t, i) => {
    let score = Math.max(0, 6 - (tasks.length - 1 - i));
    const candText =
      `${t.goal} ${t.artifacts.map((a) => `${a.label} ${a.path ?? ""}`).join(" ")}`.toLowerCase();
    if (t.artifacts.length > 0) score += 2;
    if (t.status === "done") score += 1;
    for (const m of mentions) {
      if (m.engine === t.engine) score += m === lastMention ? 12 : 8;
    }
    for (const w of yangWords) {
      if (candText.includes(w)) score += 3;
    }
    for (const num of ordinals) {
      if (new RegExp(`\\b${num}\\b`).test(candText)) score += 4;
    }
    return {
      taskId: t.taskId,
      engine: t.engine,
      goal: t.goal,
      status: t.status,
      score,
      hasArtifacts: t.artifacts.length > 0,
      refs: refsFor(t),
    } satisfies ReferentCandidate;
  });
  scored.sort((a, b) => b.score - a.score);
  return scored;
}

/** Score margin under which the runner-up counts as a real ambiguity. */
export const AMBIGUITY_MARGIN = 2;

export type ResumeTarget = {
  taskId: string;
  engine: WorkflowEngine;
  goal: string;
  status: RunTurnStatus;
  refs: ArtifactRef[];
};

function toResumeTarget(t: TaskEntry): ResumeTarget {
  return {
    taskId: t.taskId,
    engine: t.engine,
    goal: t.goal,
    status: t.status,
    refs: refsFor(t),
  };
}

/**
 * "balik ke X": find task/deck/file X in the timeline and return it as the
 * reactivated context. X is matched by keyword overlap against task goals
 * and artifact labels (newest wins ties); bare "lanjutkan yang tadi"
 * returns the most recent finished task.
 */
export function resolveResumeTarget(
  message: string,
  run: RunContext | undefined,
): ResumeTarget | undefined {
  const tasks = getTaskEntries(run);
  if (tasks.length === 0) return undefined;
  const m = message.match(
    /\b(?:balik|kembali)\s+(?:lagi\s+)?ke\s+(.+?)(?:[.!?]|$)/i,
  );
  const x = m?.[1] ? tokenize(m[1]) : [];
  if (x.length === 0) {
    const finished =
      [...tasks].reverse().find((t) => t.status !== "running") ??
      tasks[tasks.length - 1]!;
    return toResumeTarget(finished);
  }
  let best = tasks[tasks.length - 1]!;
  let bestScore = -1;
  for (let i = 0; i < tasks.length; i++) {
    const t = tasks[i]!;
    const candText =
      `${t.goal} ${t.artifacts.map((a) => `${a.label} ${a.path ?? ""}`).join(" ")}`.toLowerCase();
    const hits = x.filter((w) => candText.includes(w)).length;
    const score = hits * 3 + Math.max(0, 3 - (tasks.length - 1 - i));
    if (score > bestScore) {
      bestScore = score;
      best = t;
    }
  }
  return toResumeTarget(best);
}

export type ReferentResolution = {
  kind: ContinuationKind;
  /** The chosen referent's artifact refs (what the old router returned). */
  referents: ArtifactRef[];
  /** Winning candidate, when one was resolved. */
  best?: ReferentCandidate;
  /** True when a runner-up scored within AMBIGUITY_MARGIN. */
  ambiguous: boolean;
  /** Runner-ups, best first (max 3) — the UI shows Undo / a picker. */
  alternatives: ReferentCandidate[];
  /**
   * Always false: ambiguity is resolved by best + alternatives, never by
   * blocking the user with "maksudnya yang mana?".
   */
  needsConfirm: false;
  /** Set when kind === "resume". */
  resumeTarget?: ResumeTarget;
};

/**
 * Full reference resolution for one user message. Never blocks on
 * ambiguity: the top scorer is chosen and the rest are returned as
 * `alternatives`.
 */
export function resolveReferents(
  message: string,
  run: RunContext | undefined,
): ReferentResolution {
  const kind = classify(message, run);
  const empty: ReferentResolution = {
    kind,
    referents: [],
    ambiguous: false,
    alternatives: [],
    needsConfirm: false,
  };
  if (kind === "new_topic" || !run || run.events.length === 0) return empty;
  if (kind === "resume") {
    const resumeTarget = resolveResumeTarget(message, run);
    return {
      ...empty,
      referents: resumeTarget?.refs ?? [],
      ...(resumeTarget ? { resumeTarget } : {}),
    };
  }
  // Referent lookup needs an explicit reference signal ("itu", "tadi",
  // "-nya", "slide 3", ...). A plain continue-by-default carries no
  // referent to resolve — the old router contract ("no continuation word
  // -> no refs") is preserved.
  if (!REFERENCE_RE.test(message)) return empty;
  const candidates = scoreReferents(message, run);
  if (candidates.length === 0) return empty;
  const best = candidates[0]!;
  const ambiguous =
    candidates.length > 1 &&
    candidates[1]!.score >= best.score - AMBIGUITY_MARGIN;
  return {
    kind,
    referents: best.refs,
    best,
    ambiguous,
    alternatives: candidates.slice(1, 4),
    needsConfirm: false,
  };
}
