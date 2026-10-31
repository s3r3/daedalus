// Dae Captain UI — pure logic (no DOM, no Tauri globals).
// Unit-tested with node:test; safe to import in Node.

export const ENGINES = ["coding", "slide", "dokumen", "spreadsheet", "research"];

export const ENGINE_LABELS = {
  coding: "Coding",
  slide: "Slide",
  dokumen: "Dokumen",
  spreadsheet: "Spreadsheet",
  research: "Research",
};

export function engineLabel(engine) {
  return ENGINE_LABELS[engine] ?? engine;
}

/**
 * Aggregate island status from workflow runs.
 * - "attention": any pending approval/question (amber) — highest priority
 * - "working": any turn running (green)
 * - "idle": nothing (blue)
 */
export function aggregateStatus(runs) {
  let running = 0;
  let attention = 0;
  for (const run of runs ?? []) {
    for (const turn of run.turns ?? []) {
      if (turn.status === "running") running += 1;
      attention += (turn.pending_approvals ?? []).length;
      attention += (turn.pending_questions ?? []).length;
    }
  }
  if (attention > 0) return { status: "attention", running, attention };
  if (running > 0) return { status: "working", running, attention };
  return { status: "idle", running: 0, attention: 0 };
}

export function statusColor(status) {
  return status === "attention" ? "amber" : status === "working" ? "green" : "blue";
}

/**
 * Truthful short label for the working state, derived from real run
 * data — never a fabricated percentage. Maps the server's last event type
 * and any pending item onto a plain-language activity word.
 */
export function activityLabel(runs, agg) {
  if (agg.status === "attention") {
    const approvals = (runs ?? []).flatMap((r) => (r.turns ?? []).flatMap((t) => t.pending_approvals ?? [])).length;
    const questions = (runs ?? []).flatMap((r) => (r.turns ?? []).flatMap((t) => t.pending_questions ?? [])).length;
    if (approvals > 0) return approvals > 1 ? approvals + " butuh izin" : "Butuh izin";
    if (questions > 0) return questions > 1 ? questions + " pertanyaan" : "Ada pertanyaan";
    return "Butuh perhatian";
  }
  if (agg.status === "working") {
    const last = (runs ?? [])
      .flatMap((r) => (r.turns ?? []))
      .filter((t) => t.status === "running")
      .map((t) => t.last_event ?? "")
      .sort()
      .at(-1) ?? "";
    if (/TOOL_CALL_STARTED/i.test(last)) return "Menjalankan alat";
    if (/FILE_CHANGED/i.test(last)) return "Mengubah file";
    if (/COMMAND|TEST/i.test(last)) return "Menjalankan tes";
    if (/THOUGHT|MODEL|LLM/i.test(last)) return "Berpikir";
    if (last) return "Bekerja";
    return agg.running > 1 ? agg.running + " agent berjalan" : "Bekerja";
  }
  return "Siap";
}

/** Status text for a finished run: done/failed/cancelled from real status. */
export function completionLabel(runs) {
  let failed = 0;
  let done = 0;
  for (const run of runs ?? []) {
    for (const t of run.turns ?? []) {
      if (t.status === "failed") failed++;
      else if (t.status === "done") done++;
    }
  }
  if (failed > 0) return failed > 1 ? failed + " gagal" : "Gagal";
  if (done > 0) return done > 1 ? done + " selesai" : "Selesai";
  return "";
}

/**
 * Options of a pending ask-user question, safe for old server payloads
 * that only carried { id, task_id }. Never throws, never undefined.
 */
export function questionOptions(q) {
  return Array.isArray(q?.options) ? q.options : [];
}

/** Question text with a fallback for option-less legacy payloads. */
export function questionText(q) {
  return typeof q?.question === "string" && q.question.trim()
    ? q.question
    : "Agent meminta masukan:";
}

/** Format a message timestamp (epoch ms or ISO string) as HH.MM. Empty when unknown. */
export function fmtTime(ts) {
  if (ts === null || ts === undefined || ts === "") return "";
  const d = ts instanceof Date ? ts : new Date(ts);
  const t = d.getTime();
  if (!Number.isFinite(t)) return "";
  const p = (n) => String(n).padStart(2, "0");
  return `${p(d.getHours())}.${p(d.getMinutes())}`;
}

/** Whether the card offers a free-text answer next to the option buttons. */
export function questionAllowsFreeText(q) {
  return q?.allow_free_text !== false;
}

/**
 * Attachment limits shared with the server (server/src/app.ts), which
 * re-validates every byte — the client check is only for fast feedback.
 */
export const CHAT_ATTACH_LIMITS = {
  maxFiles: 4,
  imageMaxBytes: 5 * 1024 * 1024,
  textMaxChars: 100 * 1024,
  imageMimes: ["image/png", "image/jpeg", "image/gif", "image/webp"],
  textMimes: [
    "text/plain", "text/markdown", "text/csv", "application/json",
    "text/html", "text/css", "text/javascript", "application/javascript",
    "text/x-python", "application/x-python", "text/yaml", "application/yaml",
    "application/toml", "text/xml", "application/xml", "text/x-sh",
  ],
  // Dae Captain v2 Fase 7: spreadsheet files attachable for [Jadikan dataset].
  // They never ride the chat payload (the server only takes image/text);
  // the dataset flows go through /uploads + /sheets/workbook/open or the
  // analyze-plan API directly.
  fileMimes: ["application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"],
  fileMaxBytes: 5 * 1024 * 1024,
  imageExts: { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp" },
  fileExts: { xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" },
  textExts: {
    txt: "text/plain", md: "text/markdown", markdown: "text/markdown", csv: "text/csv",
    json: "application/json", log: "text/plain", html: "text/html", css: "text/css",
    js: "text/javascript", ts: "text/javascript", py: "text/x-python", sh: "text/x-sh",
    yaml: "text/yaml", yml: "text/yaml", toml: "application/toml", xml: "text/xml",
    java: "text/plain", c: "text/plain", h: "text/plain", rs: "text/plain", go: "text/plain",
  },
};

function mimeForPick(name, mime) {
  const m = String(mime ?? "").toLowerCase();
  if (m && m !== "application/octet-stream") return m;
  const ext = String(name ?? "").split(".").pop()?.toLowerCase() ?? "";
  return CHAT_ATTACH_LIMITS.imageExts[ext] ?? CHAT_ATTACH_LIMITS.textExts[ext] ?? CHAT_ATTACH_LIMITS.fileExts[ext] ?? m;
}

/**
 * Validate a picked file before reading it. Pure — tested, and the server
 * enforces the same limits again on the bytes it actually receives.
 */
export function validateAttachmentPick({ name, mime, sizeBytes }) {
  if (!name || /[/\\]/.test(name) || name.includes("..") || name.length > 120) {
    return { ok: false, reason: "nama file tidak valid" };
  }
  const m = mimeForPick(name, mime);
  if (CHAT_ATTACH_LIMITS.imageMimes.includes(m)) {
    if ((sizeBytes ?? 0) > CHAT_ATTACH_LIMITS.imageMaxBytes) {
      return { ok: false, reason: "gambar melebihi 5 MB" };
    }
    return { ok: true, kind: "image", mime: m };
  }
  if (CHAT_ATTACH_LIMITS.textMimes.includes(m)) {
    if ((sizeBytes ?? 0) > CHAT_ATTACH_LIMITS.textMaxChars) {
      return { ok: false, reason: "file teks melebihi 100 KB" };
    }
    return { ok: true, kind: "text", mime: m };
  }
  if (CHAT_ATTACH_LIMITS.fileMimes.includes(m)) {
    if ((sizeBytes ?? 0) > CHAT_ATTACH_LIMITS.fileMaxBytes) {
      return { ok: false, reason: "file melebihi 5 MB" };
    }
    return { ok: true, kind: "file", mime: m };
  }
  return { ok: false, reason: "tipe file belum didukung (gambar, teks, atau xlsx)" };
}

/**
 * Parse one SSE line from POST /workflow/chat/stream. Returns null for
 * keep-alives and garbage — the reader skips them, never crashes on them.
 */
export function parseStreamLine(line) {
  const text = String(line ?? "");
  const at = text.indexOf("data:");
  if (at < 0) return null;
  const payload = text.slice(at + 5).trim();
  if (!payload || payload === "[DONE]") return { done: true };
  let obj;
  try {
    obj = JSON.parse(payload);
  } catch {
    return null;
  }
  if (!obj || typeof obj !== "object") return null;
  if (obj.done === true) return { done: true, run_id: obj.run_id, text: obj.text };
  if (typeof obj.error === "string") return { error: obj.error, partial: obj.partial };
  if (typeof obj.delta === "string") return { delta: obj.delta };
  return null;
}

/** One-line summary for a turn, for the engine pills row. */
export function turnSummary(turn) {
  const label = engineLabel(turn.engine);
  const goal = typeof turn.goal === "string" && turn.goal.length > 42
    ? turn.goal.slice(0, 42) + "…"
    : turn.goal ?? "";
  const detail = turn.live === "staged_awaiting_gate"
    ? "menunggu gate"
    : turn.last_event ?? turn.status;
  return { label, goal, detail, status: turn.status };
}

/** Human-readable lines for resolved artifacts shown before dispatch. */
export function formatResolvedArtifacts(resolved) {
  if (!Array.isArray(resolved) || resolved.length === 0) return [];
  return resolved.map((a) => {
    const label = a.label ?? a.kind ?? "artifact";
    // absolute_path wins: it is the only form open_file/reveal_in_folder can
    // actually act on. A bare relative path would silently do nothing.
    const path = a.absolute_path ?? a.path ?? a.export_path ?? null;
    const url = a.url ?? null;
    const where = path ?? (a.report_id ? `report ${a.report_id}` : url ?? "");
    return {
      label,
      path,
      url,
      // Relative form (when available) is nicer to read than a long absolute.
      displayPath: a.path ?? a.absolute_path ?? a.export_path ?? "",
      display: where ? `${label} — ${where}` : label,
    };
  });
}

/** Build the POST /tasks/:id/approve payload. Never invents a key. */
export function approvalPayload(approval, decision, remember = false) {
  if (decision !== "grant" && decision !== "deny") {
    throw new Error("decision must be grant|deny");
  }
  const payload = { decision, remember: remember === true };
  if (approval && typeof approval.key === "string" && approval.key) {
    payload.key = approval.key;
  }
  return payload;
}

/** Title line for an approval card. */
export function approvalTitle(taskId, turn, approval) {
  const engine = turn ? engineLabel(turn.engine) : "task";
  const tool = approval.tool ?? "approval";
  const key = approval.key ? ` · ${approval.key}` : "";
  return `${engine} · ${tool}${key} (task ${String(taskId).slice(0, 8)})`;
}

/** Chat message → POST /workflow/chat body. */
export function chatRequestBody({ message, runId, workspaceRoot, engineOverride }) {
  const body = { message, workspace_root: workspaceRoot };
  if (runId) body.run_id = runId;
  if (engineOverride) body.engine_override = engineOverride;
  return body;
}

/** Validate a chat response enough for the UI to render it. */
export function isClarifyResponse(res) {
  return res != null && res.needs_clarify === true && Array.isArray(res.options);
}

/**
 * Compare workspace paths the way the server does: the server resolves and
 * the UI may carry a trailing slash (e.g. from the folder picker).
 * Used to detect "server healthy but anchored to another workspace" (HTTP 403).
 */
export function normalizeWorkspacePath(p) {
  return String(p || "").replace(/\/+$/, "");
}

export function sameWorkspace(a, b) {
  const na = normalizeWorkspacePath(a);
  const nb = normalizeWorkspacePath(b);
  return na !== "" && na === nb;
}

/**
 * Render a caught rejection as text. Tauri's invoke() rejects with the RAW
 * error value (a plain string for Rust `Err(String)`), NOT an Error object —
 * so `e.message` is undefined and every message was swallowed. fetch-based
 * API calls reject with real Errors. Handle both.
 */
export function errText(e) {
  if (e == null) return "unknown error";
  if (typeof e === "string") return e || "unknown error";
  if (typeof e.message === "string" && e.message) return e.message;
  try {
    const j = JSON.stringify(e);
    return j && j !== "{}" ? j : String(e);
  } catch {
    return String(e);
  }
}

/**
 * Flatten every pending approval across runs into
 * [{ taskId, turn, approval }]. Used by "Approve All".
 */
export function pendingApprovals(runs) {
  const out = [];
  for (const run of runs ?? []) {
    for (const turn of run.turns ?? []) {
      for (const approval of turn.pending_approvals ?? []) {
        out.push({ taskId: turn.task_id, turn, approval });
      }
    }
  }
  return out;
}

/** Thinking-level tiers supported by PUT /settings (server THINKING_LEVELS). */
export const THINKING_LEVELS = ["off", "low", "medium", "high"];

/** Engines minus the disabled ones — drives the composer chips. */
export function enabledEngines(disabled) {
  const off = new Set(disabled ?? []);
  return ENGINES.filter((e) => !off.has(e));
}

/**
 * Whether `engine` may be switched off. Re-enabling is always fine;
 * switching off is blocked only when it would strand the user with zero
 * enabled engines (the router would clarify to an empty list).
 */
export function canDisableEngine(engine, disabled) {
  const off = new Set(disabled ?? []);
  if (!off.has(engine)) off.add(engine);
  else off.delete(engine);
  return enabledEngines([...off]).length > 0;
}

/** Trust dropdown value → session.autoApprove boolean (the backend is boolean-only). */
export function trustToAutoApprove(value) {
  return value === "auto";
}

export function autoApproveToTrust(autoApprove) {
  return autoApprove === true ? "auto" : "ask";
}

const QUEUE_BADGES = {
  running: "progress",
  done: "done",
  failed: "failed",
  cancelled: "cancelled",
};

/**
 * Queue row view-model for one workflow turn. Pure — the workflow view
 * renders rows from this. A running turn with pending approvals gets the
 * "approval" badge so its [Approve]/[Deny] buttons render.
 */
export function queueRow(turn) {
  const status = turn.status ?? "running";
  const approvals = turn.pending_approvals ?? [];
  const questions = turn.pending_questions ?? [];
  const badge = status === "running" && (approvals.length || questions.length)
    ? "approval"
    : (QUEUE_BADGES[status] ?? "progress");
  return {
    engine: turn.engine,
    label: engineLabel(turn.engine),
    goal: turn.goal ?? "",
    status,
    badge,
    approvals,
    questions,
    lastEvent: turn.last_event ?? null,
    note: turn.note ?? null,
    taskId: turn.task_id,
  };
}

/** Rows for every turn in a run, newest last (queue order). */
export function queueRows(run) {
  return (run?.turns ?? []).map(queueRow);
}

/**
 * Args for the Tauri `spawn_server` command.
 * NOTE: Tauri's #[tauri::command] maps argument names to camelCase BY DEFAULT,
 * so the Rust `repo_root: String` param must be sent as `repoRoot`.
 * (A previous "fix" sent `repo_root` and broke spawning — do not change back.)
 */
export function spawnServerArgs(repoRoot, workspace) {
  return { repoRoot, workspace };
}

/**
 * Summarize task events for the chat's live-activity view (thinking +
 * tool calls, like the web panel). Pure — the chat renders from this.
 * Returns { thoughts: string[], tools: [{ tool, status }] } in event order.
 */
export function summarizeTaskEvents(events) {
  const thoughts = [];
  const tools = new Map();
  for (const e of events ?? []) {
    const p = e?.payload ?? {};
    if (e?.type === "THOUGHT" && typeof p.text === "string" && p.text.trim()) {
      thoughts.push(p.text.trim().slice(0, 500));
    } else if (e?.type === "TOOL_CALL_STARTED" && p.call?.id) {
      const args = summarizeArgs(p.call.tool, p.call.args);
      tools.set(p.call.id, { tool: p.call.tool ?? "tool", status: "running", args });
    } else if (e?.type === "TOOL_CALL_FINISHED" && p.call?.id) {
      const t = tools.get(p.call.id) ?? { tool: p.call.tool ?? "tool" };
      t.status = p.result?.status ?? "ok";
      if (!t.args) t.args = summarizeArgs(p.call.tool, p.call.args);
      // Image-producing tools (view_image, screenshot) record their file
      // here; the chat renders it inline instead of hiding the picture.
      const meta = p.result?.meta;
      if (meta?.image_attached === true && typeof meta?.image_path === "string" && meta.image_path) {
        t.image = { path: meta.image_path };
      }
      tools.set(p.call.id, t);
    }
  }
  return { thoughts, tools: [...tools.values()] };
}

/**
 * Compact token-usage line for one chat answer ("tok 12,4k→3,1k").
 * Empty string when there is nothing real to show — never a guess.
 */
export function formatUsage(usage) {
  const prompt = Number(usage?.prompt_tokens);
  const completion = Number(usage?.completion_tokens);
  if (!Number.isFinite(prompt) && !Number.isFinite(completion)) return "";
  const short = (n) => {
    if (!Number.isFinite(n)) return "?";
    return n >= 1000 ? `${String(Math.round(n / 100) / 10).replace(".", ",")}k` : String(n);
  };
  return `tok ${short(prompt)}→${short(completion)}`;
}

/**
 * FILE_CHANGED payloads → per-file review rows. Pure — the island renders
 * path, operation, and +added/-removed counts plus the patch text on demand.
 */
export function summarizeChanges(changes) {
  if (!Array.isArray(changes)) return [];
  return changes
    .filter((c) => c && typeof c.path === "string")
    .map((c) => ({
      path: c.path,
      operation: c.operation ?? "modified",
      added: Number(c.added) || 0,
      removed: Number(c.removed) || 0,
      patch: typeof c.patch === "string" ? c.patch : "",
    }));
}

/**
 * Slash commands (local control commands — never sent to the model).
 * Handlers live in app.js; this table drives /help and the suggestion menu.
 */
export const SLASH_COMMANDS = [
  { name: "help", usage: "/help", description: "Tampilkan daftar perintah." },
  { name: "clear", usage: "/clear", description: "Mulai percakapan baru (riwayat tersimpan, task jalan terus)." },
  { name: "new", usage: "/new", description: "Sama seperti /clear — sesi baru yang terisolasi." },
  { name: "history", usage: "/history", description: "Tampilkan percakapan sebelumnya." },
  { name: "resume", usage: "/resume <nomor|id>", description: "Buka lagi percakapan sebelumnya." },
  { name: "status", usage: "/status", description: "Workspace, sesi, dan status task saat ini." },
  { name: "stop", usage: "/stop", description: "Hentikan task yang berjalan (bukan clear chat)." },
];

/**
 * Parse a slash command. Returns null for ordinary messages — including
 * sentences that merely MENTION a slash ("What does /clear mean?", "a / b").
 * Only a leading "/name" (after trimming) counts as a command.
 */
export function parseSlashCommand(input) {
  const m = /^\s*\/([A-Za-z]+)(?:\s+([\s\S]*))?\s*$/.exec(input ?? "");
  if (!m) return null;
  return { name: m[1].toLowerCase(), args: (m[2] ?? "").trim() };
}

/** Fresh client conversation: new server run on next message, empty view. */
export function freshConversation() {
  return { runId: null, workflowRunId: null, transcript: [] };
}

/** One-line summary of a workflow run for the /history listing. */
export function runHistoryLine(run, index) {
  const turns = run?.turns ?? [];
  const chatTurns = run?.chat_turns ?? 0;
  if (turns.length === 0 && chatTurns > 0) {
    return `${index}. (obrolan) — ${chatTurns} pesan`;
  }
  const firstGoal = turns[0]?.goal ?? "(obrolan)";
  const running = turns.filter((t) => t.status === "running").length;
  const failed = turns.filter((t) => t.status === "failed").length;
  const state = running > 0 ? "jalan" : failed > 0 ? "gagal" : turns.length ? "selesai" : "kosong";
  return `${index}. ${firstGoal} — ${turns.length} task, ${state}`;
}

/** Short human-readable arg summary for a tool call (mockup: "./", "package.json"). */
function summarizeArgs(tool, args) {
  if (!args || typeof args !== "object") return "";
  const a = args;
  const pick = a.path ?? a.file ?? a.dir ?? a.command ?? a.cmd ?? "";
  if (typeof pick === "string" && pick) return pick.length > 40 ? "…" + pick.slice(-39) : pick;
  return "";
}

/**
 * Minimal Markdown renderer (no dependencies).
 * Supports: code blocks (```), inline code, bold, italic, strikethrough,
 * headers, unordered/ordered lists, pipe tables, horizontal rules, links,
 * paragraphs. Returns HTML string.
 * Code blocks get a copy button (wired up by the caller).
 */
export function renderMarkdown(text) {
  if (!text) return "";
  const lines = String(text).split("\n");
  const isTableRow = (line) => /^\s*\|.*\|\s*$/.test(line);
  const isDelimiterRow = (line) =>
    /^\s*\|(\s*:?-+:?\s*\|)+\s*$/.test(line) && line.replace(/[^:-]/g, "").includes("--");
  const splitRow = (line) =>
    line.trim().replace(/^\||\|$/g, "").split("|").map((cell) => cell.trim());
  let html = "";
  let inCode = false;
  let codeLang = "";
  let codeBuf = [];
  let listStack = []; // [{ type: "ul"|"ol", indent }], indent = leading spaces

  const esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  // Attribute-safe URL: only http(s) and image data URLs ride along.
  // javascript:/data:text payloads degrade to their visible label.
  const attrUrl = (url) => {
    const u = String(url ?? "").trim();
    if (!/^(https?:\/\/|data:image\/)/i.test(u)) return null;
    return esc(u).replace(/"/g, "&quot;");
  };

  const inline = (s) => {
    // Inline code first (protect from other replacements)
    const codes = [];
    s = s.replace(/`([^`]+)`/g, (_, c) => {
      codes.push(`<code class="inline-code">${esc(c)}</code>`);
      return ` ${codes.length - 1} `;
    });
    s = esc(s);
    // Restore inline code
    s = s.replace(/ (\d+) /g, (_, i) => codes[Number(i)]);
    // Images before links (the link pattern would eat the [alt](url) half).
    s = s.replace(/!\[([^\]]*)\]\(([^)]+)\)/g, (_, alt, url) => {
      const safe = attrUrl(url);
      return safe ? `<img src="${safe}" alt="${esc(alt).replace(/"/g, "&quot;")}" loading="lazy" class="md-img">` : esc(alt);
    });
    // Bold, italic, strikethrough, links
    s = s.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
    s = s.replace(/(^|[^*])\*([^*\n]+)\*/g, "$1<em>$2</em>");
    s = s.replace(/~~([^~]+)~~/g, "<del>$1</del>");
    s = s.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_, label, url) => {
      const safe = attrUrl(url);
      return safe ? `<a href="${safe}" target="_blank" rel="noopener">${label}</a>` : label;
    });
    return s;
  };

  const closeList = () => {
    while (listStack.length) {
      html += listStack.pop().type === "ol" ? "</ol>" : "</ul>";
    }
  };

  // letter-only placeholder tags (digits would trip the number tokenizer)
  const tagOf = (i) => `QX${i.toString(36).replace(/[0-9]/g, (d) => "ABCDEFGHIJ"[Number(d)])}ZQ`;
  const CODE_KEYWORDS = [
    "const", "let", "var", "function", "return", "if", "else", "for", "while",
    "do", "switch", "case", "break", "continue", "import", "from", "export",
    "default", "class", "extends", "new", "try", "catch", "finally", "throw",
    "async", "await", "def", "lambda", "fn", "struct", "impl", "pub", "use",
    "mod", "match", "elif", "print", "echo", "type", "interface", "enum",
    "static", "public", "private", "void", "int", "string", "bool", "true",
    "false", "null", "nil", "then", "end", "select", "where",
  ];

  /** Tiny generic code highlighter (comments/strings/keywords/numbers). */
  function highlightCode(src) {
    const parts = [];
    const stash = (html) => {
      parts.push(html);
      return tagOf(parts.length - 1);
    };
    let s = esc(src);
    // Strings first (comment markers inside strings must survive).
    s = s.replace(/("(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*'|`(?:[^`\\]|\\.)*`)/g, (str) =>
      stash(`<span class="tok-str">${str}</span>`));
    // Comments (C/JS, shell/Python, SQL, C-style blocks).
    s = s.replace(/(\/\/[^\n]*|#[^\n]*|\/\*[\s\S]*?\*\/|--[^\n]*)/g, (com) =>
      stash(`<span class="tok-com">${com}</span>`));
    s = s.replace(new RegExp(`\\b(${CODE_KEYWORDS.join("|")})\\b`, "g"), `<span class="tok-kw">$1</span>`);
    s = s.replace(/\b\d[\d_]*(?:\.\d+)?\b/g, `<span class="tok-num">$&</span>`);
    parts.forEach((part, i) => {
      s = s.split(tagOf(i)).join(part);
    });
    return s;
  }

  for (let li = 0; li < lines.length; li++) {
    const line = lines[li];
    // Pipe table: header row + delimiter row + body rows.
    if (isTableRow(line) && li + 1 < lines.length && isDelimiterRow(lines[li + 1])) {
      closeList();
      const head = splitRow(line);
      html += `<table class="md-table"><thead><tr>${head.map((c) => `<th>${inline(c)}</th>`).join("")}</tr></thead><tbody>`;
      li += 2;
      while (li < lines.length && isTableRow(lines[li]) && !isDelimiterRow(lines[li])) {
        html += `<tr>${splitRow(lines[li]).map((c) => `<td>${inline(c)}</td>`).join("")}</tr>`;
        li++;
      }
      html += "</tbody></table>";
      li--;
      continue;
    }
    // Horizontal rule
    if (/^\s*(---|\*\*\*|___)\s*$/.test(line)) {
      closeList();
      html += `<hr class="md-hr">`;
      continue;
    }
    // Code block fence
    const fence = line.match(/^```(\w*)\s*$/);
    if (fence) {
      if (!inCode) {
        inCode = true;
        codeLang = fence[1] || "";
        codeBuf = [];
        closeList();
      } else {
        inCode = false;
        const code = highlightCode(codeBuf.join("\n"));
        html += `<div class="code-block"><div class="code-head"><span>${esc(codeLang)}</span><button class="copy-btn" data-code="${encodeURIComponent(codeBuf.join("\n"))}">Salin</button></div><pre><code>${code}</code></pre></div>`;
      }
      continue;
    }
    if (inCode) {
      codeBuf.push(line);
      continue;
    }
    // Headers
    const h = line.match(/^(#{1,4})\s+(.*)$/);
    if (h) {
      closeList();
      const level = h[1].length;
      html += `<h${level + 2} class="md-h">${inline(h[2])}</h${level + 2}>`;
      continue;
    }
    // Unordered / ordered list, indent-aware (two spaces per level).
    const um = line.match(/^(\s*)[-*]\s+(.*)$/);
    const om = line.match(/^(\s*)\d+\.\s+(.*)$/);
    const item = um
      ? { type: "ul", indent: um[1].replace(/\t/g, "  ").length, text: um[2] }
      : om
        ? { type: "ol", indent: om[1].replace(/\t/g, "  ").length, text: om[2] }
        : null;
    if (item) {
      while (listStack.length && listStack[listStack.length - 1].indent > item.indent) {
        html += listStack.pop().type === "ol" ? "</ol>" : "</ul>";
      }
      const top = listStack[listStack.length - 1];
      if (!top || top.indent < item.indent) {
        html += `<${item.type} class="md-list${listStack.length ? " sub" : ""}">`;
        listStack.push({ type: item.type, indent: item.indent });
      } else if (top.type !== item.type) {
        listStack.pop();
        html += `${top.type === "ol" ? "</ol>" : "</ul"}<${item.type} class="md-list${listStack.length ? " sub" : ""}">`;
        listStack.push({ type: item.type, indent: item.indent });
      }
      html += `<li>${inline(item.text)}</li>`;
      continue;
    }
    // Blank line
    if (!line.trim()) {
      closeList();
      continue;
    }
    // Paragraph
    closeList();
    html += `<p class="md-p">${inline(line)}</p>`;
  }
  closeList();
  // Unclosed code block
  if (inCode) {
    const code = highlightCode(codeBuf.join("\n"));
    html += `<div class="code-block"><div class="code-head"><span>${esc(codeLang)}</span><button class="copy-btn" data-code="${encodeURIComponent(codeBuf.join("\n"))}">Salin</button></div><pre><code>${code}</code></pre></div>`;
  }
  return html;
}



/**
 * Parse a progress fraction from engine narration ("Mengisi slide 8/12…").
 * Returns { current, total } or null. The numbers come from the engine's
 * own progress text — never fabricated. Only the LAST x/y in the text
 * counts (earlier ones are stale narration).
 */
export function parseProgressFraction(text) {
  const matches = String(text ?? "").match(/(\d+)\s*\/\s*(\d+)/g);
  if (!matches) return null;
  const last = /(\d+)\s*\/\s*(\d+)/.exec(matches[matches.length - 1]);
  if (!last) return null;
  const current = Number(last[1]);
  const total = Number(last[2]);
  if (!Number.isFinite(current) || !Number.isFinite(total) || total <= 0 || current < 0) return null;
  return { current: Math.min(current, total), total };
}

const GENERIC_PHASE = {
  slide: "Membuat slide…",
  dokumen: "Menyiapkan dokumen…",
  spreadsheet: "Menyiapkan spreadsheet…",
  research: "Menjalankan riset…",
  coding: "Bekerja…",
};

/**
 * Phase line for one running turn. Prefers the engine's own latest
 * narration (last_event_text, e.g. "Mengisi slide 8/12: Judul…"),
 * shortened to label size; falls back to last_event mapping, then a
 * per-engine generic. Never invents numbers.
 */
export function turnPhaseText(turn) {
  const narration = typeof turn?.last_event_text === "string" ? turn.last_event_text.trim().replace(/\s+/g, " ") : "";
  if (narration) return narration.length > 44 ? narration.slice(0, 43) + "…" : narration;
  const last = String(turn?.last_event ?? "");
  if (/VALIDATION_STARTED/i.test(last)) return "Memverifikasi…";
  if (/TOOL_CALL_STARTED/i.test(last)) return "Menjalankan alat…";
  if (/FILE_CHANGED/i.test(last)) return "Mengubah file…";
  if (/COMMAND|TEST/i.test(last)) return "Menjalankan perintah…";
  if (/THOUGHT|MODEL|LLM/i.test(last)) return "Berpikir…";
  return GENERIC_PHASE[turn?.engine] ?? "Bekerja…";
}

/** Compact per-task chip for the multi-task label: "slide 8/12". */
export function taskChip(turn) {
  const engine = String(turn?.engine ?? "").toLowerCase() || "?";
  const frac = parseProgressFraction(turn?.last_event_text);
  return frac ? `${engine} ${frac.current}/${frac.total}` : engine;
}

/**
 * Primary task for the chat window's task controls: the first running
 * turn, else the first paused turn, else null. Pure; the window UI
 * renders Jeda/Lanjut/Batal from it.
 */
export function primaryTask(runs) {
  let paused = null;
  for (const run of runs ?? []) {
    for (const t of run.turns ?? []) {
      if (!t?.task_id) continue;
      if (t.status === "running") return { taskId: String(t.task_id), engine: t.engine ?? "", status: "running" };
      if (t.paused === true && !paused) paused = { taskId: String(t.task_id), engine: t.engine ?? "", status: "paused" };
    }
  }
  return paused;
}
