// Dae Captain island — DOM wiring. Pure DOM + Tauri invoke bridge.
// All server communication goes through api.js; all decisions through logic.js.

import { createApiClient } from "./api.js";
import { createEventStream } from "./events.js";
import { createInvoker, listenEvent, WINDOW_SET_SIZE_CMD, setSizePayload } from "./bridge.js";
import { PillController } from "./pill.js";
import { renderCard, renderVerifyFail, slideTitle } from "./cards.js";
import {
  ENGINES,
  aggregateStatus,
  statusColor,
  pillText,
  turnSummary,
  formatResolvedArtifacts,
  approvalPayload,
  approvalTitle,
  chatRequestBody,
  sameWorkspace,
  pendingApprovals,
  errText,
  spawnServerArgs,
  engineLabel,
  enabledEngines,
  canDisableEngine,
  queueRows,
  summarizeTaskEvents,
  renderMarkdown,
  activityLabel,
  completionLabel,
  parseSlashCommand,
  freshConversation,
  runHistoryLine,
  questionOptions,
  questionText,
  questionAllowsFreeText,
  validateAttachmentPick,
  CHAT_ATTACH_LIMITS,
  formatUsage,
  summarizeChanges,
  fmtTime,
  parseProgressFraction,
  turnPhaseText,
  SLASH_COMMANDS,
  THINKING_LEVELS,
} from "./logic.js";

const $ = (id) => document.getElementById(id);
const COMPACT = { w: 480, h: 76 };
const EXPANDED = { w: 480, h: 640 };

// ---------------------------------------------------------------------------
// Tauri bridge (Tauri v2: window.__TAURI_INTERNALS__.invoke; see bridge.js)
// ---------------------------------------------------------------------------

const invoke = createInvoker(globalThis.window);

async function setWindowSize(w, h) {
  try {
    await invoke(WINDOW_SET_SIZE_CMD, setSizePayload(w, h));
  } catch {
    /* non-Tauri context or missing capability: ignore */
  }
}

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

const state = {
  api: null,
  eventStream: null, // WebSocket event stream for live task updates
  prefs: null,
  workspaceRoot: "",
  runId: null,
  workflowRunId: null, // run shown in the workflow queue view
  engineOverride: null, // null = auto
  expanded: false,
  runs: [],
  transcript: [], // {kind: 'user'|'turn'|'assistant'|'error', ...}
  serverUrl: "http://127.0.0.1:3080",
  pendingMessage: null, // work command waiting for a workspace pick
  pendingOverride: null,
  pendingAttachments: [], // queued composer attachments (cleared on send/clear)
  providersCache: [], // last GET /providers list (key state, manage buttons)
  modelsVision: { loaded: false, set: new Set() }, // vision-capable models of the picked provider
  wfFilter: "all", // antrean filter: all|running|approval|done|failed
  connected: false, // event-stream/HTTP health (honest pill + header status)
  seenEvents: new Map(), // task_id -> max seq applied (dedupe on reconnect)
  wsSubscribed: false, // wildcard WS subscription done once per workspace
  approvalOpen: false, // latch: auto-expand once per approval batch
  historyList: [], // run_ids from the last /history listing (for /resume index)
  slashIndex: -1, // suggestion-menu selection (-1 = none)
  stick: true, // auto-scroll pinned to bottom (false while reading history)
  viewLimit: 30, // rendered transcript window (grows via "load more")
  streamAbort: null, // AbortController for the active chat stream, if any
  pill: null, // PillController (Fase 6) — owns the dynamic-island pill
  // ---- Dae Captain v2 Fase 7: chat cards ----
  seenTimelineEvents: new Set(), // v2 timeline event ids already applied (verify bubbles)
  captainFilePaths: new Set(), // workspace-relative paths from timeline `file` events (Workspace ✨)
  lastTimelineEventId: "", // pagination cursor for GET /captain/runs/:id/timeline
  timelinePolling: false, // re-entrancy guard for the timeline poll
  cardWatchers: new Map(), // taskId -> { stop() } staged-artifact watchers
  turnDoneCache: new Map(), // taskId -> last known status (deliverable cards)
};

// ---------------------------------------------------------------------------
// Views
// ---------------------------------------------------------------------------

function showView(name) {
  for (const v of ["main", "workflow", "crew", "settings", "workspace", "setup", "boot"]) {
    $("view-" + v).classList.toggle("hidden", v !== name);
  }
  if (name === "workflow") renderWorkflowView();
  if (name === "crew") loadCrewView();
  if (name === "settings") loadSettingsView();
  if (name === "workspace") { loadWorkspaceView(); }
}

/**
 * Crew view: agents, skills, and connections the captain commands.
 * Strictly read-only — the same live inventory the Web UI renders.
 */
async function loadCrewView() {
  const box = $("crew-box");
  const status = $("crew-status");
  if (!box) return;
  box.innerHTML = "";
  if (status) {
    status.className = "status-line";
    status.textContent = "Memuat…";
  }
  try {
    const data = await state.api.extensionsStatus(state.workspaceRoot);
    const groups = [
      ["Agen", (data.agents ?? []).map((a) => ({ title: a.name, sub: a.description ?? "" }))],
      ["Skills", (data.skills ?? []).map((s) => ({ title: s.name, sub: `${s.origin ?? ""}${s.disabled ? " · nonaktif" : ""}` }))],
      ["MCP", (data.mcp ?? []).map((m) => ({ title: m.name, sub: `${m.connected ? "terhubung" : "terputus"} · ${m.toolCount ?? 0} tools${m.error ? ` · ${m.error}` : ""}` }))],
      ["LSP", (data.lsp ?? []).map((l) => ({ title: l.name, sub: (l.extensions ?? []).join(", ") }))],
    ];
    let empty = true;
    for (const [heading, rows] of groups) {
      if (!rows.length) continue;
      empty = false;
      const h = document.createElement("h3");
      h.className = "section-header";
      h.textContent = `${heading} (${rows.length})`;
      box.appendChild(h);
      for (const row of rows.slice(0, 30)) {
        const el = document.createElement("div");
        el.className = "crew-row";
        el.innerHTML = `<span class="wf-engine">${escapeHtml(row.title)}</span> <span class="hint">${escapeHtml(row.sub)}</span>`;
        box.appendChild(el);
      }
    }
    if (empty) box.innerHTML = `<span class="hint">Tidak ada agen/skill/koneksi terdaftar di workspace ini.</span>`;
    if ((data.problems ?? []).length) {
      const warn = document.createElement("div");
      warn.className = "hint";
      warn.textContent = "Masalah: " + data.problems.join("; ");
      box.appendChild(warn);
    }
    if (status) {
      status.className = "status-line ok";
      status.textContent = "Aktif — " + (data.root ?? state.workspaceRoot);
    }
  } catch (e) {
    if (status) {
      status.className = "status-line error";
      status.textContent = "Gagal memuat kru: " + errText(e);
    }
  }
}

/** Export the active session to a Markdown file in the workspace. */
async function exportCurrentSession() {
  const status = $("action-status");
  const runId = state.runId ?? state.workflowRunId;
  if (!runId) {
    if (status) status.textContent = "Belum ada sesi untuk diekspor.";
    return;
  }
  if (status) status.textContent = "Mengekspor…";
  try {
    const out = await state.api.exportConversation(runId, state.workspaceRoot);
    state.transcript.push({
      kind: "assistant",
      text: "Percakapan diekspor — file tersimpan di workspace.",
      ts: Date.now(),
      resolved: [{ kind: "export", label: "Ekspor percakapan", path: out.path, absolute_path: out.absolute_path }],
    });
    if (status) {
      status.className = "action-status ok";
      status.textContent = "Ekspor selesai ✓";
    }
  } catch (e) {
    if (status) {
      status.className = "action-status error";
      status.textContent = "Gagal mengekspor: " + errText(e);
    }
  }
  renderTranscript();
}

function expand() {
  if (state.expanded) return;
  state.expanded = true;
  $("pill").classList.add("hidden");
  $("panel").classList.remove("hidden");
  setWindowSize(EXPANDED.w, EXPANDED.h);
  void moveIslandToCorner();
}

function collapse() {
  if (!state.expanded) return;
  state.expanded = false;
  $("panel").classList.add("hidden");
  $("pill").classList.remove("hidden");
  setWindowSize(COMPACT.w, COMPACT.h);
  void moveIslandToCorner();
}

/**
 * Dae Captain v2 Fase 8: rest the island on the configured pill corner
 * (Settings → Pill → Posisi). No-op for the default top-center and in
 * plain-browser dev (the Rust command is Tauri-only).
 */
async function moveIslandToCorner() {
  const corner = state.prefs?.island_corner ?? "top-center";
  if (corner === "top-center") return;
  try {
    await invoke("position_island", { corner, expanded: state.expanded === true });
  } catch {
    /* non-Tauri context: ignore */
  }
}

// ---------------------------------------------------------------------------
// Pill + engine pills + approvals rendering
// ---------------------------------------------------------------------------

/**
 * Create the PillController (Fase 6) and wire every control to a real
 * operation. Called once during boot, before the first refreshRuns().
 */
function initPill() {
  if (state.pill) return;
  const root = $("pill");
  if (!root) return;
  state.pill = new PillController({
    root,
    onAction: (action, payload) => handlePillAction(action, payload),
  });
}

/**
 * Every pill control does something real:
 * - cancel → POST /tasks/:id/cancel (the existing cancel API)
 * - pause → POST /tasks/:id/pause (cooperative engine pause)
 * - resume → POST /tasks/:id/resume
 * - view/click → smart navigation (approval card / progress / chat)
 */
async function handlePillAction(action, payload = {}) {
  const status = $("action-status");
  const say = (text, cls) => {
    if (!status) return;
    status.className = "action-status" + (cls ? " " + cls : "");
    status.textContent = text;
  };
  if ((action === "cancel" || action === "pause" || action === "resume") && !state.api) {
    say("Belum terhubung ke server.", "error");
    return;
  }
  try {
    if (action === "cancel" && payload.taskId) {
      const res = await state.api.cancelTask(payload.taskId);
      say(res?.cancelled ? "Task dibatalkan." : "Permintaan batal tercatat.", res?.cancelled ? "ok" : "");
      await refreshRuns();
    } else if (action === "pause" && payload.taskId) {
      await state.api.pauseTask(payload.taskId);
      say("Task dijeda — klik pill untuk lanjut.", "ok");
      await refreshRuns();
    } else if (action === "resume" && payload.taskId) {
      await state.api.resumeTask(payload.taskId);
      say("Task dilanjutkan.", "ok");
      await refreshRuns();
    } else if (action === "view" || action === "click") {
      smartPillClick(payload.status);
    }
  } catch (e) {
    say("Gagal: " + errText(e), "error");
  }
}

/**
 * Smart click: jump to the relevant context.
 * - waiting_approval → expand + scroll to the approval card
 * - error → expand (chat shows what failed)
 * - working/verifying/fixing → expand (progress is visible in chat)
 * - paused → resume is handled by the controller; expand to chat
 * - idle/queued/done → expand to chat
 */
function smartPillClick(status) {
  const wasCollapsed = !state.expanded;
  expand();
  showView("main");
  if (!wasCollapsed && status !== "waiting_approval") return;
  // Jump to the approval card when one is pending.
  requestAnimationFrame(() => {
    const card = document.querySelector("#approvals .approval-card");
    if (card) {
      card.scrollIntoView({ behavior: "smooth", block: "center" });
      card.classList.add("flash");
      setTimeout(() => card.classList.remove("flash"), 1600);
    } else {
      const box = $("transcript");
      if (box) box.scrollTop = box.scrollHeight;
    }
  });
}

function renderPill() {
  // The PillController owns the pill DOM (9 statuses, ring, buttons).
  // Connection honesty stays here: never show a fake idle pill while
  // disconnected.
  if (!state.pill) initPill();
  if (!state.connected) {
    state.pill.setStatus("idle", "offline");
    const pill = $("pill");
    pill?.classList.add("pill-offline");
    return;
  }
  $("pill")?.classList.remove("pill-offline");
  state.pill.update(state.runs);
}

function renderEnginePills() {
  const box = $("chat-engine-pills");
  if (!box) return;
  box.innerHTML = "";
  const turns = [];
  for (const run of state.runs) for (const t of run.turns ?? []) turns.push(t);
  if (turns.length === 0) {
    box.innerHTML = `<span class="hint">Tidak ada agent berjalan — kirim perintah di bawah.</span>`;
    return;
  }
  for (const t of turns.slice(-8)) {
    const s = turnSummary(t);
    const dot = t.status === "running" ? (t.pending_approvals?.length || t.pending_questions?.length ? "amber" : "green") : "blue";
    const el = document.createElement("span");
    el.className = "engine-pill";
    el.title = s.goal;
    el.innerHTML = `<span class="dot ${dot}"></span> ${escapeHtml(s.label)} <small>${escapeHtml(s.detail)}</small>`;
    box.appendChild(el);
  }
}

function renderApprovals() {
  const box = $("approvals");
  if (!box) return;
  box.innerHTML = "";
  for (const run of state.runs) {
    for (const turn of run.turns ?? []) {
      for (const ap of turn.pending_approvals ?? []) {
        const card = document.createElement("div");
        card.className = "approval-card";
        card.innerHTML = `
          <div class="approval-header">Butuh persetujuan</div>
          <div class="title">${escapeHtml(approvalTitle(turn.task_id, turn, ap))}</div>
          <div class="row">
            <button class="primary-btn" data-act="grant">Allow</button>
            <button class="deny-btn" data-act="deny">Deny</button>
          </div>`;
        card.querySelector('[data-act="grant"]').onclick = () => decideCardApproval(turn.task_id, ap, "grant", card);
        card.querySelector('[data-act="deny"]').onclick = () => decideCardApproval(turn.task_id, ap, "deny", card);
        box.appendChild(card);
      }
      for (const q of turn.pending_questions ?? []) {
        const card = document.createElement("div");
        card.className = "approval-card";
        card.innerHTML = `
          <div class="approval-header">Agent bertanya</div>
          <div class="title">${escapeHtml(questionText(q))}</div>
          <div class="opt-list"></div>
          ${questionAllowsFreeText(q) ? `<div class="row">
            <input class="answer-input" type="text" placeholder="Atau tulis jawaban sendiri…" style="flex:1">
            <button class="primary-btn">Kirim</button>
          </div>` : `<div class="hint">Pilih salah satu jawaban di atas.</div>`}`;
        // Numbered option buttons (1, 2, 3…): clicking answers with the
        // option's label verbatim — the server maps it back to the option.
        const list = card.querySelector(".opt-list");
        questionOptions(q).forEach((opt, i) => {
          const b = document.createElement("button");
          b.className = "ghost-btn opt-btn";
          b.innerHTML = `<span class="opt-num">${i + 1}</span> <span>${escapeHtml(opt.label ?? "")}${opt.description ? ` <small>${escapeHtml(opt.description)}</small>` : ""}</span>`;
          b.onclick = () => answerCardQuestion(turn.taskId, q, card, opt.label);
          list.appendChild(b);
        });
        if (questionAllowsFreeText(q)) {
          const send = () => answerCardQuestion(turn.taskId, q, card);
          card.querySelector(".primary-btn").onclick = send;
          card.querySelector(".answer-input").addEventListener("keydown", (e) => {
            if (e.key === "Enter") send();
          });
        }
        box.appendChild(card);
      }
    }
  }
}
async function decideApproval(taskId, approval, decision) {
  // Prefer the id-addressed route: it searches every active runner, so a
  // pending card still resolves after the server restarted mid-run. The
  // key-addressed route requires the task's own runner and 404s.
  if (approval && typeof approval.id === "string" && approval.id) {
    await state.api.decideApproval(taskId, approval.id, { decision });
    return;
  }
  await state.api.approve(taskId, approvalPayload(approval, decision));
}

/**
 * Answer a pending question inline. `answerOverride` is an option label
 * (from the 1-4 buttons); otherwise the free-text input is read.
 */
async function answerCardQuestion(taskId, question, card, answerOverride) {
  const input = card.querySelector(".answer-input");
  const answer = (answerOverride ?? input?.value ?? "").trim();
  if (!answer) return;
  const btns = card.querySelectorAll("button, input");
  btns.forEach((b) => (b.disabled = true));
  try {
    await state.api.answerQuestion(taskId, question.id, answer);
    card.querySelector(".title").textContent += " — terjawab ✓";
    await refreshRuns();
  } catch (e) {
    btns.forEach((b) => (b.disabled = false));
    card.querySelector(".title").textContent = "Gagal menjawab: " + errText(e);
  }
}

async function decideCardApproval(taskId, approval, decision, card) {
  try {
    await decideApproval(taskId, approval, decision);
    card.querySelectorAll("button").forEach((b) => (b.disabled = true));
    card.querySelector(".title").textContent += decision === "grant" ? " — diizinkan ✓" : " — ditolak ✕";
    await refreshRuns();
  } catch (e) {
    card.querySelector(".title").textContent = "Gagal: " + errText(e);
  }
}

/** Grant every pending approval across all runs. */
async function approveAll() {
  const btn = $("btn-approve-all");
  const status = $("action-status");
  if (!status) return;
  const list = pendingApprovals(state.runs);
  if (!list.length) {
    status.className = "action-status";
    status.textContent = "Tidak ada approval tertunda.";
    return;
  }
  btn.disabled = true;
  status.className = "action-status";
  status.textContent = `Menyetujui ${list.length}…`;
  let ok = 0;
  let fail = 0;
  for (const { taskId, approval } of list) {
    try {
      await decideApproval(taskId, approval, "grant");
      ok++;
    } catch {
      fail++;
    }
  }
  await refreshRuns();
  btn.disabled = false;
  status.className = "action-status " + (fail ? "error" : "ok");
  status.textContent = fail ? `${ok} diizinkan, ${fail} gagal.` : `${ok} approval diizinkan ✓`;
}

// ---------------------------------------------------------------------------
// Transcript + chat
// ---------------------------------------------------------------------------

function escapeHtml(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

/**
 * Strip raw <tool_call>/<tool_response> blocks from user-visible chat text.
 * These leak when a weak model uses the text-protocol format instead of
 * proper function calling — the user should see the result, not the XML.
 */
function stripToolTags(text) {
  return String(text ?? "")
    .replace(/<tool_call>[\s\S]*?<\/tool_call>/g, "")
    .replace(/<tool_response>[\s\S]*?<\/tool_response>/g, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** Resolve a tool-result image (workspace-relative) to a data URL for inline view. */
async function loadToolImage(path) {
  const data = await state.api.workspaceFile(state.workspaceRoot, path);
  if (data?.kind === "image" && typeof data?.src === "string" && data.src) return data.src;
  throw new Error("bukan gambar");
}

/**
 * Live activity block for a chat turn: thinking (collapsible) + tool-call
 * chips, mirroring the web panel's THINKING view. Returns null when empty.
 * `imageLoader(path)` resolves a tool-result image to a data URL on demand —
 * pictures the agent saw (screenshot/view_image) render inline here.
 */
function renderTurnActivity(activity, imageLoader) {
  if (!activity) return null;
  const thoughts = activity.thoughts ?? [];
  const tools = activity.tools ?? [];
  if (!thoughts.length && !tools.length) return null;
  const wrap = document.createElement("div");
  wrap.className = "turn-activity";
  // THINKING header (mockup style): "THINKING · N langkah"
  const steps = thoughts.length + tools.length;
  // Everything (thoughts + tool rows) goes inside one collapsed <details>.
  // Chat-first: internal activity hidden by default, expandable if curious.
  const det = document.createElement("details");
  det.className = "thinking";
  det.open = false;
  const sum = document.createElement("summary");
  sum.className = "thinking-header";
  sum.textContent = `Aktivitas · ${steps} langkah`;
  det.appendChild(sum);
  if (thoughts.length) {
    for (const t of thoughts.slice(-3)) {
      const p = document.createElement("div");
      p.className = "thought";
      p.textContent = t;
      det.appendChild(p);
    }
  }
  // Tool rows (mockup style): card per tool with status badge
  if (tools.length) {
    const list = document.createElement("div");
    list.className = "tool-rows";
    for (const t of tools.slice(-8)) {
      const row = document.createElement("div");
      row.className = "tool-row";
      const badge = t.status === "ok" ? "OK" : t.status === "running" ? "…" : t.status.toUpperCase();
      const badgeClass = t.status === "ok" ? "ok" : t.status === "running" ? "running" : "bad";
      row.innerHTML = `<span class="tool-name">${escapeHtml(t.tool)}</span> <span class="tool-badge ${badgeClass}">${escapeHtml(badge)}</span> <span class="tool-args">${escapeHtml(t.args ?? "")}</span>`;
      if (t.image?.path && imageLoader) {
        const viewBtn = document.createElement("button");
        viewBtn.className = "ghost-btn small";
        viewBtn.textContent = "Lihat gambar";
        viewBtn.onclick = async () => {
          viewBtn.disabled = true;
          viewBtn.textContent = "Memuat…";
          try {
            const src = await imageLoader(t.image.path);
            const img = document.createElement("img");
            img.className = "tool-image";
            img.src = src;
            img.alt = t.image.path;
            img.loading = "lazy";
            row.appendChild(img);
            viewBtn.remove();
          } catch {
            viewBtn.textContent = "Gagal memuat";
            viewBtn.disabled = false;
          }
        };
        row.appendChild(viewBtn);
      }
      list.appendChild(row);
    }
    det.appendChild(list);
  }
  wrap.appendChild(det);
  return wrap;
}

/** Streaming fast path: touch only the live bubble, never rebuild the list. */
function renderLive() {
  const box = $("transcript");
  const turn = [...state.transcript].reverse().find((m) => m.streaming);
  const body = box?.querySelector(".bubble.live .body");
  if (!box || !body || !turn) {
    renderTranscript();
    return;
  }
  body.innerHTML = escapeHtml(turn.text) + `<span class="stream-caret">▍</span>`;
  if (state.stick) box.scrollTop = box.scrollHeight;
}

function renderTranscript() {  const box = $("transcript");
  if (!box) return;
  box.innerHTML = "";
  // Older messages stay out of the DOM until asked for (long resumed
  // sessions must not silently truncate, but must not freeze either).
  const hidden = Math.max(0, state.transcript.length - state.viewLimit);
  if (hidden > 0) {
    const more = document.createElement("button");
    more.className = "load-more-btn";
    more.textContent = `Muat ${hidden} pesan sebelumnya`;
    more.onclick = () => {
      const oldHeight = box.scrollHeight;
      state.viewLimit += 50;
      renderTranscript();
      box.scrollTop = box.scrollHeight - oldHeight;
    };
    box.appendChild(more);
  }
  const visible = state.transcript.slice(-state.viewLimit);
  // Regenerate is offered on the latest in-session chat answer only —
  // resumed history has no attachment bytes and tasks have their own flow.
  let lastAssistantIdx = -1;
  visible.forEach((m, i) => {
    if (m.kind === "assistant" && m.session && !m.streaming) lastAssistantIdx = i;
  });
  visible.forEach((m, i) => {
    const el = document.createElement("div");
    if (m.kind === "card") {
      // Dae Captain v2 Fase 7: structured action card from server data.
      el.className = "bubble assistant card-bubble";
      el.innerHTML = `<div class="who">Dae Captain</div>`;
      try {
        el.appendChild(renderCard(m.cardKind, m.cardData, cardCtx({ taskId: m.taskId, retryGoal: m.retryGoal })));
      } catch (e) {
        const err = document.createElement("p");
        err.className = "dc-error";
        err.textContent = "Gagal merender kartu: " + errText(e);
        el.appendChild(err);
      }
    } else if (m.kind === "verify-fail") {
      // Verify gate failed: a chat bubble ("…saya perbaiki dulu…").
      // Success stays silent — no bubble at all.
      el.appendChild(renderVerifyFail(m.text));
      el.className = "verify-fail-wrap";
    } else if (m.kind === "user") {
      el.className = "bubble user";
      const when = fmtTime(m.ts);
      el.innerHTML = `<div class="body">${escapeHtml(m.text)}</div>${when ? `<div class="msg-time">${escapeHtml(when)}</div>` : ""}`;
      if (m.attachments?.length) {
        const chips = document.createElement("div");
        chips.className = "msg-attachments";
        for (const a of m.attachments) {
          const chip = document.createElement("span");
          chip.className = "attach-chip static";
          chip.textContent = `${a.kind === "image" ? "🖼" : a.kind === "file" ? "📊" : "📄"} ${a.name}`;
          if (/\.(csv|xlsx)$/i.test(a.name ?? "")) {
            const ds = document.createElement("button");
            ds.className = "chip-dataset";
            ds.textContent = "Jadikan dataset";
            ds.title = "Jadikan dataset spreadsheet";
            ds.onclick = (ev) => {
              ev.stopPropagation();
              void makeAttachmentDataset(a);
            };
            chip.appendChild(ds);
          }
          chips.appendChild(chip);
        }
        el.appendChild(chips);
      }
    } else if (m.kind === "turn" || m.kind === "assistant") {
      el.className = "bubble assistant" + (m.streaming ? " live" : "");
      const who = m.kind === "assistant" ? "Dae Captain" : engineLabel(m.engine);
      const when = fmtTime(m.ts);
      const arts = formatResolvedArtifacts(m.resolved);
      // Streaming answers render as plain text with a caret (cheap per
      // delta); the Markdown pass runs once the stream finishes.
      // Assistant chat messages render Markdown; turn goals are NOT echoed
      // (the user's message is already visible above) — the turn shows
      // engine activity instead.
      const bodyHtml = m.kind === "assistant"
        ? (m.streaming ? escapeHtml(stripToolTags(m.text)) + `<span class="stream-caret">▍</span>` : renderMarkdown(stripToolTags(m.text)))
        : `<span class="turn-hint">Mengerjakan…</span>`;
      el.innerHTML = `
        <div class="who">${escapeHtml(who)}${when ? ` <span class="msg-time">${escapeHtml(when)}</span>` : ""}</div>
        <div class="body">${bodyHtml}</div>
        ${m.staged ? `<div class="note">Staged — menunggu gate di Web UI / aplikasi.</div>` : ""}
        ${arts.length ? `<div class="artifacts"></div>` : ""}`;
      if (m.stopped) {
        const hint = document.createElement("div");
        hint.className = "hint";
        hint.textContent = "Dihentikan — respons tidak lengkap.";
        el.appendChild(hint);
      }
      if (m.clipped) {
        const hint = document.createElement("div");
        hint.className = "hint";
        hint.textContent = "Konteks awal sesi melebihi batas dan tidak ikut terkirim.";
        el.appendChild(hint);
      }
      if (m.kind === "assistant" && !m.streaming) {
        const actions = document.createElement("div");
        actions.className = "msg-actions";
        const copy = document.createElement("button");
        copy.className = "ghost-btn small";
        copy.textContent = "Salin jawaban";
        copy.onclick = async () => {
          try {
            await navigator.clipboard.writeText(m.text);
            copy.textContent = "Disalin!";
            setTimeout(() => { copy.textContent = "Salin jawaban"; }, 1500);
          } catch {}
        };
        actions.appendChild(copy);
        if (i === lastAssistantIdx) {
          const regen = document.createElement("button");
          regen.className = "ghost-btn small regen-btn";
          regen.textContent = "↻ Coba lagi";
          regen.title = "Minta jawaban baru untuk pesan ini";
          regen.onclick = () => regenerateAssistant(m);
          actions.appendChild(regen);
        }
        el.appendChild(actions);
      }
      if (m.kind === "assistant" && m.usage && !m.streaming) {
        const usage = document.createElement("div");
        usage.className = "hint";
        usage.textContent = formatUsage(m.usage);
        el.appendChild(usage);
      }
      if (m.kind === "turn" && m.taskId) {
        const row = document.createElement("div");
        row.className = "msg-actions";
        // Retry: re-dispatch the same goal as a brand-new turn (new task
        // id, honest history) — only for turns the backend marked failed.
        if (findRunTurn(m.taskId)?.status === "failed") {
          const retry = document.createElement("button");
          retry.className = "ghost-btn small";
          retry.textContent = "↻ Coba lagi";
          retry.title = "Jalankan lagi sebagai task baru";
          retry.onclick = () => {
            retry.disabled = true;
            sendChat(m.goal);
          };
          row.appendChild(retry);
        }
        // In-place review: which files changed, with counts and patches.
        const changesBtn = document.createElement("button");
        changesBtn.className = "ghost-btn small";
        changesBtn.textContent = "Lihat perubahan";
        const changesBox = document.createElement("div");
        changesBox.className = "changes-box hidden";
        let changesLoaded = false;
        changesBtn.onclick = async () => {
          changesBox.classList.toggle("hidden");
          if (changesBox.classList.contains("hidden") || changesLoaded) return;
          changesBox.textContent = "Memuat…";
          try {
            const data = await state.api.taskChanges(m.taskId);
            const fileRows = summarizeChanges(data.changes);
            changesBox.innerHTML = fileRows.length ? "" : "Tidak ada perubahan file tercatat.";
            for (const fileRow of fileRows.slice(0, 20)) {
              const entry = document.createElement("div");
              entry.className = "change-row";
              const head = document.createElement("div");
              head.className = "change-head";
              head.innerHTML = `<span class="mono">${escapeHtml(fileRow.path)}</span> <span class="hint">${escapeHtml(fileRow.operation)} +${fileRow.added}/-${fileRow.removed}</span>`;
              entry.appendChild(head);
              if (fileRow.patch) {
                const details = document.createElement("details");
                details.className = "patch-details";
                const summary = document.createElement("summary");
                summary.textContent = "Patch";
                details.appendChild(summary);
                const pre = document.createElement("pre");
                pre.className = "patch-box";
                const lines = fileRow.patch.split("\n");
                pre.textContent = (lines.length > 80 ? lines.slice(0, 80).join("\n") + `\n… (${lines.length - 80} baris disembunyikan)` : fileRow.patch);
                details.appendChild(pre);
                entry.appendChild(details);
              }
              changesBox.appendChild(entry);
            }
            changesLoaded = true;
          } catch (e) {
            changesBox.textContent = "Gagal memuat: " + errText(e);
          }
        };
        row.appendChild(changesBtn);
        el.appendChild(row);
        el.appendChild(changesBox);
      }
      // Render artifact cards with Open/Reveal actions. Only entries that
      // carry a real path or URL get a card — no fake download cards.
      if (arts.length) {
        const artBox = el.querySelector(".artifacts");
        for (const art of arts) {
          if (!art.path && !art.url) continue;
          const card = document.createElement("div");
          card.className = "artifact-card";
          const shown = art.displayPath || art.path || "";
          const base = shown.split("/").pop() || art.label;
          const ext = (base.split(".").pop() || "").toLowerCase();
          const icon = ext === "pptx" || ext === "ppt" ? "📊" : ext === "docx" || ext === "doc" ? "📄" : ext === "xlsx" || ext === "csv" ? "📈" : ext === "html" ? "🌐" : "📁";
          card.innerHTML = `
            <span class="artifact-icon">${icon}</span>
            <span class="artifact-name">${escapeHtml(base)}</span>
            <span class="artifact-path" title="${escapeHtml(art.path ?? shown)}">${escapeHtml(art.label)}</span>
            <div class="artifact-actions"></div>`;
          const actions = card.querySelector(".artifact-actions");
          if (art.path) {
            const openBtn = document.createElement("button");
            openBtn.className = "ghost-btn small";
            openBtn.textContent = "Buka";
            openBtn.onclick = () => invoke("open_file", { path: art.path }).catch((e) => {
              console.error("open_file failed:", errText(e));
            });
            actions.appendChild(openBtn);
            const revealBtn = document.createElement("button");
            revealBtn.className = "ghost-btn small";
            revealBtn.textContent = "Lihat di folder";
            revealBtn.onclick = () => invoke("reveal_in_folder", { path: art.path }).catch((e) => {
              console.error("reveal_in_folder failed:", errText(e));
            });
            actions.appendChild(revealBtn);
          } else if (art.url) {
            const openBtn = document.createElement("button");
            openBtn.className = "ghost-btn small";
            openBtn.textContent = "Buka";
            openBtn.onclick = () => invoke("open_web", { url: art.url }).catch(() => {});
            actions.appendChild(openBtn);
          }
          artBox.appendChild(card);
        }
      }
      // Wire up copy buttons in code blocks
      for (const btn of el.querySelectorAll(".copy-btn")) {
        btn.onclick = async () => {
          try {
            await navigator.clipboard.writeText(decodeURIComponent(btn.dataset.code));
            btn.textContent = "Disalin!";
            setTimeout(() => { btn.textContent = "Salin"; }, 1500);
          } catch {}
        };
      }
      const act = renderTurnActivity(m.activity, loadToolImage);
      if (act) el.appendChild(act);
      // Dae Captain v2 Fase 7: live progress card for running turns
      // (mockup: progress bar + 8/12 + ✕ ⏸), fed by the run's own
      // last_event_text — never a fabricated number.
      if (m.kind === "turn" && m.taskId && !m.activityDone) {
        try {
          const runTurn = findRunTurn(m.taskId);
          const prog = renderCard("progress", {
            taskId: m.taskId,
            phase: runTurn ? turnPhaseText(runTurn) : "Bekerja…",
            fraction: runTurn ? parseProgressFraction(runTurn.last_event_text) : null,
            status: runTurn?.paused ? "paused" : "running",
          }, cardCtx({ taskId: m.taskId }));
          el.appendChild(prog);
        } catch {
          /* progress is a nicety — the turn bubble still stands */
        }
      }
    } else if (m.kind === "error") {
      el.className = "bubble assistant error";
      if (m.taskStopped) {
        // TASK BERHENTI card (mockup): reason + suggestion + actions.
        el.innerHTML = `
          <div class="task-stopped">TASK BERHENTI</div>
          <div class="body">${escapeHtml(m.text)}</div>
          ${m.suggestion ? `<div class="suggestion">Saran: ${escapeHtml(m.suggestion)}</div>` : ""}
          <div class="row">
            <button class="primary-btn retry-btn">Coba lagi</button>
            <button class="ghost-btn model-btn">Ganti model</button>
          </div>`;
        const retry = el.querySelector(".retry-btn");
        if (retry && m.retryMessage) {
          retry.onclick = () => sendChat(m.retryMessage, m.retryOverride ?? null);
        }
        const modelBtn = el.querySelector(".model-btn");
        if (modelBtn) modelBtn.onclick = () => showView("settings");
      } else {
        el.innerHTML = `<div class="who">Dae Captain</div><div class="body">Gagal: ${escapeHtml(m.text)}</div>`;
        if (m.retryMessage) {
          const retry = document.createElement("button");
          retry.className = "ghost-btn small";
          retry.textContent = "Kirim ulang";
          retry.onclick = () => sendChat(m.retryMessage, m.retryOverride ?? null);
          el.appendChild(retry);
        }
      }
    }
    box.appendChild(el);
  });
  // Sticky scroll: follow the bottom only while the user is already there.
  // Reading history during a stream must not yank the view on every delta.
  const jump = $("chat-jump");
  if (state.stick) {
    box.scrollTop = box.scrollHeight;
    jump?.classList.add("hidden");
  } else {
    jump?.classList.remove("hidden");
  }
}

function renderEngineChips() {
  const box = $("engine-chips");
  box.innerHTML = "";
  const disabled = state.prefs?.disabled_engines ?? [];
  const mk = (value, label) => {
    const b = document.createElement("button");
    b.textContent = label;
    b.className = state.engineOverride === value ? "active" : "";
    b.onclick = () => {
      state.engineOverride = state.engineOverride === value ? null : value;
      renderEngineChips();
    };
    box.appendChild(b);
  };
  mk(null, "Auto");
  for (const e of enabledEngines(disabled)) mk(e, engineLabel(e));
}

/** True while a chat answer is still streaming in. */
function isStreaming() {
  return state.transcript.some((m) => m.streaming);
}

/** Map one chat-route response onto transcript entries (shared by send/regenerate). */
async function handleChatResponse(res, { text, override, attachments }) {
  if (res.kind === "chat") {
    // Chat-first: a conversational reply, no engine, no task.
    state.runId = res.run_id ?? state.runId;
    state.transcript.push({ kind: "assistant", text: res.text, session: true, ts: Date.now(), clipped: res.clipped === true, usage: res.usage });
  } else if (res.kind === "need_workspace") {
    // Workspace on-demand: the command needs a folder. Remember the
    // original message, show the picker, retry after the user picks.
    state.runId = res.run_id ?? state.runId;
    state.pendingMessage = text;
    state.pendingOverride = override ?? state.engineOverride;
    state.pendingAttachments = attachments;
    state.transcript.push({ kind: "assistant", text: res.message ?? "Pilih folder workspace dulu." });
    renderTranscript();
    showView("workspace");
  } else {
    state.runId = res.run_id ?? state.runId;
    // Natural acknowledgment before the turn — human-like, per engine.
    const ack = {
      coding: "Siap. Aku cek workspace dan siapkan pengerjaannya.",
      slide: "Siap. Aku siapkan outline slide-nya dulu.",
      dokumen: "Siap. Aku cek dokumennya dulu.",
      spreadsheet: "Siap. Aku siapkan spreadsheet-nya.",
      research: "Siap. Aku susun rencana risetnya.",
    }[res.engine] ?? "Siap. Aku kerjakan.";
    state.transcript.push({ kind: "assistant", text: ack, ts: Date.now() });
    const turnEntry = {
      kind: "turn",
      ts: Date.now(),
      engine: res.engine,
      goal: text,
      router: res.router,
      resolved: res.resolved_artifacts,
      staged: res.staged === true,
      taskId: res.task_id ?? null,
      turnId: res.turn_id ?? null,
      activity: null,
      activityKey: "",
      activityDone: false,
    };
    state.transcript.push(turnEntry);
    updateStopButton();
    onDispatchResponse(res, turnEntry);
  }
}

/**
 * Dae Captain v2 Fase 7: map a dispatch response onto chat cards.
 * - plan staged (multi-engine) → task-plan card (decompose.ts via server).
 * - research staged → research-plan card (depth + [Mulai Riset]).
 * - slide/dokumen/spreadsheet → watch staged artifacts → outline/
 *   blueprint/extraction cards; turn-done → deliverable card.
 */
async function onDispatchResponse(res, turnEntry) {
  const taskId = res.task_id ?? null;
  // Multi-engine plan card (staged by the server via planTask).
  if (res.plan_id && res.plan) {
    turnEntry.activityDone = true;
    updateStopButton();
    pushCard("task-plan", { plan_id: res.plan_id, plan: res.plan }, { taskId: res.plan_id });
    renderTranscript();
    return;
  }
  // Research: staged plan → card with depth + [Mulai Riset].
  if (res.engine === "research" && res.staged === true && res.plan_id) {
    turnEntry.activityDone = true;
    updateStopButton();
    try {
      const staged = await state.api.researchPlanGet(res.plan_id);
      pushCard("research-plan", {
        planId: res.plan_id,
        plan: staged?.plan,
        question: staged?.question,
        depth: staged?.depth ?? "standar",
      }, { taskId: res.plan_id });
    } catch (e) {
      pushAssistant("Rencana riset siap, tapi gagal dimuat: " + errText(e));
    }
    renderTranscript();
    return;
  }
  if (!taskId) return;
  // Staged-artifact watchers → outline/blueprint/extraction cards.
  if (res.engine === "slide") watchSlideOutline(taskId);
  else if (res.engine === "dokumen") watchDokumenState(taskId);
  else if (res.engine === "spreadsheet") watchSheetsState(taskId);
  // Turn-done → deliverable card (all engines incl. coding).
  if (["slide", "dokumen", "spreadsheet", "research", "coding"].includes(res.engine)) {
    state.cardWatchers.set("gen:" + taskId, { stop: watchTurnDone(taskId, res.engine) });
  }
}

// ---------------------------------------------------------------------------
// Dae Captain v2 Fase 7 — chat cards
// ---------------------------------------------------------------------------

/** Transient status line under the action row (cards' notify channel). */
function actionStatus(text) {
  const el = $("action-status");
  if (!el) return;
  el.textContent = text;
  clearTimeout(actionStatus._t);
  actionStatus._t = setTimeout(() => {
    if (el.textContent === text) el.textContent = "";
  }, 6000);
}

/** Build the ctx object cards need. extra: { taskId, retryGoal }. */
function cardCtx(extra = {}) {
  return {
    api: state.api,
    invoke,
    workspaceRoot: state.workspaceRoot,
    taskId: extra.taskId ?? null,
    runId: state.runId,
    notify: actionStatus,
    say: (text) => pushAssistant(text),
    sendChat: (text) => sendChat(text),
    openPreview: (info) => openPreviewOverlay(info),
    onDeliverable: (info) => pushDeliverableCard(info),
    onGenerated: (engine, ref) => onCardGenerated(engine, ref, extra.taskId),
    retryGoal: extra.retryGoal ?? null,
  };
}

/** Push a structured card into the transcript. */
function pushCard(kind, data, extra = {}) {
  const entry = {
    kind: "card",
    cardKind: kind,
    cardData: data,
    taskId: extra.taskId ?? null,
    retryGoal: extra.retryGoal ?? null,
    ts: Date.now(),
  };
  state.transcript.push(entry);
  if (isChatViewVisible()) renderTranscript();
  return entry;
}

/** A card produced a file → render the deliverable card. */
function pushDeliverableCard(info) {
  pushCard("deliverable", info, { taskId: info.taskId ?? null, retryGoal: info.retryGoal ?? null });
}

/** A card started generation → the turn watcher/progress takes over. */
function onCardGenerated(engine, ref, taskId) {
  // The existing turn machinery (events + refreshRuns) drives progress;
  // ensure a watcher exists so the deliverable card appears on completion.
  if (taskId && !state.cardWatchers.has("gen:" + taskId)) {
    const stop = watchTurnDone(taskId, engine);
    state.cardWatchers.set("gen:" + taskId, { stop });
  }
  refreshRuns();
}

/**
 * Watch one task until it leaves "running", then push the right card.
 * Returns a stop function. The watch ends on completion, failure, or
 * after ~30 minutes.
 */
function watchTurnDone(taskId, engine) {
  let stopped = false;
  const deadline = Date.now() + 30 * 60 * 1000;
  const timer = setInterval(async () => {
    if (stopped || Date.now() > deadline) {
      clearInterval(timer);
      return;
    }
    try {
      await refreshRunsQuiet();
      const turn = findRunTurn(taskId);
      if (!turn || turn.status !== "running") {
        clearInterval(timer);
        if (turn) await maybePushDeliverableCard(turn);
      }
    } catch {
      /* keep watching; the next tick retries */
    }
  }, 4000);
  return () => {
    stopped = true;
    clearInterval(timer);
  };
}

/**
 * A turn just finished → push the engine's deliverable card (slide pptx,
 * dokumen export, spreadsheet xlsx, research report, coding file summary).
 * Failures stay silent here (the error bubble already explains).
 */
async function maybePushDeliverableCard(runTurn) {
  const taskId = String(runTurn.task_id ?? "");
  if (!taskId || state.turnDoneCache.get(taskId) === "carded") return;
  state.turnDoneCache.set(taskId, "carded");
  const engine = runTurn.engine;
  const ctx = cardCtx({ taskId, retryGoal: runTurn.goal });
  try {
    if (engine === "slide") {
      let label = "Presentasi";
      try {
        const deck = (await state.api.slideDeck(state.workspaceRoot))?.deck;
        if (deck?.title) label = deck.title;
      } catch {
        /* label fallback */
      }
      pushCard("deliverable", {
        name: label + ".pptx",
        label,
        kind: "pptx",
        engine: "slide",
        taskId,
        url: state.api.slideDownloadUrl(state.workspaceRoot),
        preview: { kind: "pptx" },
      }, { taskId, retryGoal: runTurn.goal });
    } else if (engine === "dokumen") {
      const doc = (await state.api.dokumenDocument(state.workspaceRoot))?.document;
      const exports = Array.isArray(doc?.exports) ? doc.exports : [];
      const latest = exports[exports.length - 1];
      if (latest?.path) {
        pushCard("deliverable", {
          name: latest.path.split("/").pop(),
          label: doc?.title ?? "Dokumen",
          path: latest.path,
          kind: latest.format ?? "docx",
          engine: "dokumen",
          taskId,
        }, { taskId, retryGoal: runTurn.goal });
      } else {
        // Fallback: outline staged tapi watcher tidak menangkap —
        // tampilkan kartu outline langsung agar user bisa klik "Buat Makalah".
        const stagedSections = (doc?.sections ?? []).some((s) => s.status === "staged");
        if (stagedSections) {
          pushCard("dokumen-outline", { document: doc }, { taskId, retryGoal: runTurn.goal });
        }
      }
    } else if (engine === "spreadsheet") {
      pushCard("deliverable", {
        name: "workbook.xlsx",
        label: "Workbook",
        kind: "xlsx",
        engine: "spreadsheet",
        taskId,
        url: state.api.sheetsExportUrl(state.workspaceRoot),
        preview: { kind: "xlsx" },
      }, { taskId, retryGoal: runTurn.goal });
    } else if (engine === "research") {
      const artifacts = runTurn.artifacts ?? [];
      const rep = artifacts.find((a) => a.kind === "research_report" && a.report_id);
      if (rep?.report_id) {
        const report = (await state.api.researchReport(rep.report_id))?.report;
        if (report) pushCard("research-report", { report }, { taskId });
      }
    } else if (engine === "coding") {
      // Coding: "Jadi." + file summary card per user flow.
      // Jangan echo goal mentah — buat kalimat natural.
      const artifacts = runTurn.artifacts ?? [];
      const files = artifacts.filter((a) => a.kind === "files" && a.path);
      const count = files.length;
      if (count > 0) {
        const firstPath = files[0].path;
        const folderHint = firstPath.includes("/")
          ? firstPath.split("/").slice(0, -1).join("/") + "/"
          : "";
        const desc = count === 1
          ? `File ${firstPath.split("/").pop()} sudah dibuat`
          : `${count} file sudah dibuat${folderHint ? ` di ${folderHint}` : ""}`;
        pushAssistant(`Jadi. ${desc}.`);
        pushCard("deliverable", {
          name: count === 1 ? firstPath.split("/").pop() : `${count} file`,
          label: folderHint ? `${count} file di ${folderHint}` : `${count} file dibuat`,
          kind: "files",
          engine: "coding",
          taskId,
          path: firstPath,
        }, { taskId, retryGoal: runTurn.goal });
      } else {
        // No file artifacts tracked — generic but natural.
        pushAssistant("Jadi. Sudah selesai.");
      }
    }
  } catch (e) {
    // A failed card fetch must never hide the completion itself.
    state.turnDoneCache.delete(taskId);
    actionStatus("Gagal memuat kartu hasil: " + errText(e));
  }
}

// ---- Staged-artifact watchers: outline/blueprint cards ----

/** Poll until the slide engine stages its outline skeleton, then card it. */
function watchSlideOutline(taskId) {
  if (state.cardWatchers.has(taskId)) return;
  let stopped = false;
  const deadline = Date.now() + 10 * 60 * 1000;
  const timer = setInterval(async () => {
    if (stopped || Date.now() > deadline) {
      clearInterval(timer);
      state.cardWatchers.delete(taskId);
      return;
    }
    try {
      const deck = (await state.api.slideDeck(state.workspaceRoot))?.deck;
      const slides = deck?.slides ?? [];
      const skeleton = slides.filter((s) => s.status === "skeleton");
      if (deck && slides.length > 0 && skeleton.length > 0) {
        clearInterval(timer);
        state.cardWatchers.delete(taskId);
        const [templates, imported] = await Promise.all([
          state.api.builtinTemplates().catch(() => ({ templates: [] })),
          state.api.pptTemplates(state.workspaceRoot).catch(() => ({ templates: [] })),
        ]);
        pushCard("slide-outline", {
          deck,
          templates: templates?.templates ?? [],
          importedTemplates: imported?.templates ?? [],
        }, { taskId });
      } else if (deck && slides.length > 0 && skeleton.length === 0) {
        // Already filled (fast path / resumed): stop watching, the
        // deliverable card comes from the turn-done path.
        clearInterval(timer);
        state.cardWatchers.delete(taskId);
      }
    } catch {
      /* deck not staged yet — keep polling */
    }
  }, 3000);
  state.cardWatchers.set(taskId, { stop: () => { stopped = true; clearInterval(timer); } });
}

/** Poll the dokumen document: staged kerangka → outline card; records → extraction card. */
function watchDokumenState(taskId) {
  if (state.cardWatchers.has(taskId)) return;
  let stopped = false;
  let carded = null;
  const deadline = Date.now() + 10 * 60 * 1000;
  const timer = setInterval(async () => {
    if (stopped || Date.now() > deadline) {
      clearInterval(timer);
      state.cardWatchers.delete(taskId);
      return;
    }
    try {
      const doc = (await state.api.dokumenDocument(state.workspaceRoot))?.document;
      if (!doc) return;
      const stagedSections = (doc.sections ?? []).some((s) => s.status === "staged");
      if (stagedSections && carded !== "outline") {
        carded = "outline";
        pushCard("dokumen-outline", { document: doc }, { taskId });
      } else if ((doc.records ?? []).length > 0 && carded !== "extraction") {
        carded = "extraction";
        pushCard("dokumen-extraction", { document: doc }, { taskId });
        clearInterval(timer);
        state.cardWatchers.delete(taskId);
      }
    } catch {
      /* not ready yet */
    }
  }, 3000);
  state.cardWatchers.set(taskId, { stop: () => { stopped = true; clearInterval(timer); } });
}

/** Poll the workbook: staged blueprint → blueprint card. */
function watchSheetsState(taskId) {
  if (state.cardWatchers.has(taskId)) return;
  let stopped = false;
  const deadline = Date.now() + 10 * 60 * 1000;
  const timer = setInterval(async () => {
    if (stopped || Date.now() > deadline) {
      clearInterval(timer);
      state.cardWatchers.delete(taskId);
      return;
    }
    try {
      const wb = (await state.api.sheetsWorkbook(state.workspaceRoot))?.workbook;
      if (wb?.stage === "blueprint" && wb?.blueprint) {
        clearInterval(timer);
        state.cardWatchers.delete(taskId);
        pushCard("sheets-blueprint", { workbook: wb }, { taskId });
      } else if (wb?.stage === "ready") {
        clearInterval(timer);
        state.cardWatchers.delete(taskId);
      }
    } catch {
      /* not ready yet */
    }
  }, 3000);
  state.cardWatchers.set(taskId, { stop: () => { stopped = true; clearInterval(timer); } });
}

/** Stop every card watcher (new conversation / workspace switch). */
function stopCardWatchers() {
  for (const [, w] of state.cardWatchers) {
    try {
      w.stop();
    } catch {
      /* ignore */
    }
  }
  state.cardWatchers.clear();
}

// ---- v2 timeline poll: verify-fail bubbles (success stays silent) ----

/**
 * Poll GET /captain/runs/:id/timeline for new v2 events. A `verify` event
 * with result=fail becomes a chat bubble ("…saya perbaiki dulu…");
 * successes stay silent per the design. Runs on the existing 10s
 * refresh cycle plus after task events.
 */
async function pollCaptainTimeline() {
  if (!state.api || state.timelinePolling || !state.runId) return;
  state.timelinePolling = true;
  try {
    const res = await state.api.captainTimeline(state.runId, state.workspaceRoot, state.lastTimelineEventId);
    const events = res?.events ?? [];
    if (events.length) {
      state.lastTimelineEventId = events[events.length - 1].id ?? state.lastTimelineEventId;
    }
    let changed = false;
    for (const e of events) {
      if (!e?.id || state.seenTimelineEvents.has(e.id)) continue;
      state.seenTimelineEvents.add(e.id);
      if (e.type === "file" && e.payload?.path) state.captainFilePaths.add(e.payload.path);
      if (e.type === "verify" && e.payload?.result === "fail") {
        const reason = e.payload?.reason ?? "verifikasi gagal";
        state.transcript.push({ kind: "verify-fail", text: reason, ts: Date.now() });
        changed = true;
      }
    }
    if (changed && isChatViewVisible()) renderTranscript();
  } catch {
    /* timeline unavailable (older server) — cards still work */
  } finally {
    state.timelinePolling = false;
  }
}

// ---------------------------------------------------------------------------
// Preview overlay (Dae Captain v2 Fase 7 — [👁️ Preview])
// ---------------------------------------------------------------------------

function closePreviewOverlay() {
  $("preview-overlay")?.remove();
}

/**
 * Preview a deliverable in an overlay (never a new page/window).
 * - pptx/xlsx/docx: server-rendered page images (Pratinjau Asli pipeline).
 * - pdf: embedded viewer. csv/md/txt/json: rendered inline.
 * - research-report: HTML report + print → PDF.
 */
function openPreviewOverlay(info) {
  closePreviewOverlay();
  const overlay = document.createElement("div");
  overlay.id = "preview-overlay";
  overlay.className = "preview-overlay";
  const head = document.createElement("div");
  head.className = "preview-head";
  const title = document.createElement("span");
  title.textContent = info?.name ?? "Preview";
  const headBtns = document.createElement("span");
  const printBtn = document.createElement("button");
  printBtn.className = "icon-btn";
  printBtn.textContent = "🖨";
  printBtn.title = "Cetak / simpan PDF";
  printBtn.onclick = () => window.print();
  const closeBtn = document.createElement("button");
  closeBtn.className = "icon-btn";
  closeBtn.textContent = "✕";
  closeBtn.title = "Tutup";
  closeBtn.onclick = closePreviewOverlay;
  headBtns.append(printBtn, closeBtn);
  head.append(title, headBtns);
  const box = document.createElement("div");
  box.className = "preview-box";
  const body = document.createElement("div");
  body.className = "preview-body";
  body.innerHTML = `<p class="hint">Memuat…</p>`;
  box.append(head, body);
  overlay.appendChild(box);
  overlay.addEventListener("click", (e) => {
    if (e.target === overlay) closePreviewOverlay();
  });
  document.body.appendChild(overlay);
  void renderPreviewBody(body, info ?? {}).catch((e) => {
    body.innerHTML = `<p class="dc-error">Preview gagal: ${escapeHtml(errText(e))}</p>`;
  });
}

function previewImg(src, alt) {
  const img = document.createElement("img");
  img.className = "preview-page";
  img.loading = "lazy";
  img.alt = alt ?? "";
  img.src = src;
  return img;
}

/** Poll a page-image preview until ready, then append the pages. */
async function renderPagePreview(body, getStatus, doRender, label) {
  for (let i = 0; i < 20; i++) {
    const st = await getStatus();
    if (st?.status === "ready" && Array.isArray(st?.pageUrls) && st.pageUrls.length) {
      body.innerHTML = "";
      for (const [n, u] of st.pageUrls.entries()) {
        body.appendChild(previewImg(state.api.baseUrl + u, `${label} ${n + 1}`));
      }
      return;
    }
    if (st?.status === "error") throw new Error(st.error ?? "render gagal");
    if (st?.status === "unavailable") throw new Error("preview tidak tersedia di mesin ini");
    if ((st?.status === "idle" || st?.status === "stale") && doRender) {
      await doRender().catch(() => {});
    }
    body.innerHTML = `<p class="hint">Merender ${escapeHtml(label)}…</p>`;
    await new Promise((r) => setTimeout(r, 3000));
  }
  throw new Error("render terlalu lama — coba lagi nanti");
}

async function renderPreviewBody(body, info) {
  const kind = info.kind ?? "";
  const root = state.workspaceRoot;
  if (kind === "pptx") {
    await renderPagePreview(
      body,
      () => state.api.slidePreview(root),
      () => state.api.slidePreviewRender({ root }),
      "slide",
    );
    return;
  }
  if (kind === "xlsx") {
    await renderPagePreview(
      body,
      () => state.api.sheetsPreview(root),
      () => state.api.sheetsPreviewRender({ root }),
      "sheet",
    );
    return;
  }
  if (kind === "docx") {
    await renderPagePreview(
      body,
      () => state.api.dokumenPreview(root),
      null,
      "halaman",
    );
    return;
  }
  if (kind === "research-report" && info.report) {
    body.innerHTML = "";
    body.appendChild(renderReportHtml(info.report));
    return;
  }
  if (kind === "pdf" || kind === "png" || kind === "jpg" || kind === "jpeg" || kind === "gif" || kind === "webp") {
    const url = info.url ?? (info.path ? state.api.captainDownloadUrl(root, info.path) : null);
    if (!url) throw new Error("tidak ada sumber preview");
    body.innerHTML = "";
    if (kind === "pdf") {
      const emb = document.createElement("embed");
      emb.className = "preview-embed";
      emb.type = "application/pdf";
      emb.src = url;
      body.appendChild(emb);
    } else {
      body.appendChild(previewImg(url, info.name));
    }
    return;
  }
  if (info.path && ["csv", "md", "txt", "json", "bib"].includes(kind)) {
    const file = await state.api.workspaceFile(root, info.path);
    const text = typeof file?.content === "string" ? file.content : "";
    body.innerHTML = "";
    if (kind === "csv") {
      body.appendChild(renderCsvTable(text));
    } else if (kind === "md") {
      const div = document.createElement("div");
      div.className = "preview-md";
      div.innerHTML = renderMarkdown(text);
      body.appendChild(div);
    } else {
      const pre = document.createElement("pre");
      pre.className = "preview-pre";
      pre.textContent = text.slice(0, 20000);
      body.appendChild(pre);
    }
    return;
  }
  // Fallback: honest download button instead of a fake preview.
  body.innerHTML = "";
  const p = document.createElement("p");
  p.className = "hint";
  p.textContent = "Preview tidak tersedia untuk tipe ini — unduh untuk melihat.";
  const dl = document.createElement("button");
  dl.className = "card-btn";
  dl.textContent = "📥 Download";
  dl.onclick = async () => {
    const url = info.url ?? (info.path ? state.api.captainDownloadUrl(root, info.path) : null);
    if (!url) return;
    await state.api.downloadFile(url, info.name ?? "download");
  };
  body.append(p, dl);
}

/** Simple CSV → table (first 50 rows). */
function renderCsvTable(text) {
  const table = document.createElement("table");
  table.className = "md-table preview-table";
  const rows = String(text).split("\n").slice(0, 50);
  rows.forEach((line, i) => {
    if (!line.trim()) return;
    const tr = document.createElement("tr");
    for (const cell of line.split(",")) {
      const td = document.createElement(i === 0 ? "th" : "td");
      td.textContent = cell.trim().replace(/^"|"$/g, "");
      tr.appendChild(td);
    }
    table.appendChild(tr);
  });
  return table;
}

/** Research report → printable HTML for the preview overlay. */
function renderReportHtml(report) {
  const wrap = document.createElement("div");
  wrap.className = "preview-report";
  const h1 = document.createElement("h2");
  h1.textContent = report.question ?? "Laporan riset";
  wrap.appendChild(h1);
  if (report.summary) {
    const p = document.createElement("p");
    p.textContent = report.summary;
    wrap.appendChild(p);
  }
  for (const section of report.sections ?? []) {
    const h2 = document.createElement("h3");
    h2.textContent = section.title ?? "";
    wrap.appendChild(h2);
    for (const claim of (report.claims ?? []).filter((c) => (section.claimIds ?? []).includes(c.id))) {
      const p = document.createElement("p");
      p.textContent = "• " + claim.text;
      wrap.appendChild(p);
    }
  }
  const h2 = document.createElement("h3");
  h2.textContent = "Sumber";
  wrap.appendChild(h2);
  const ol = document.createElement("ol");
  for (const s of report.sources ?? []) {
    const li = document.createElement("li");
    li.textContent = `${s.title ?? s.url} — ${s.url}`;
    ol.appendChild(li);
  }
  wrap.appendChild(ol);
  return wrap;
}

function chatBody(text, override, attachments, extra) {
  const body = chatRequestBody({
    message: text,
    runId: state.runId,
    workspaceRoot: state.workspaceRoot,
    engineOverride: override ?? state.engineOverride,
  });
  if (attachments?.length) {
    // kind "file" (xlsx) never rides the chat payload — the server only
    // accepts image/text. Dataset flows go through /uploads +
    // /sheets/workbook/open or the analyze-plan API ([Jadikan dataset]).
    body.attachments = attachments
      .filter((a) => a.kind !== "file")
      .map((a) => ({
        name: a.name,
        mime: a.mime,
        ...(a.data_url ? { data_url: a.data_url } : {}),
        ...(a.text ? { text: a.text } : {}),
      }));
    if (!body.attachments.length) delete body.attachments;
  }
  return { ...body, ...(extra ?? {}) };
}

/**
 * Dae Captain v2 Fase 7 — route analysis requests with a dataset to the
 * Analis plan card. Returns true when it handled the message (caller must
 * not dispatch it as a chat turn). The plan card's [Setujui & Jalankan]
 * runs the real analysis pipeline.
 */
const ANALYSIS_INTENT_RE = /\b(analisis|analisa|analisislah|analyze|tren|trend|rata-rata|rata2|average|total|jumlah|sum\b|bandingkan|perbandingan|statistik|statistic|insight|pola|pattern|korelasi|grafik|chart|visualisasi|ringkas)/i;

async function maybeAnalyzeFromChat(text, attachments) {
  if (!state.api || !ANALYSIS_INTENT_RE.test(text)) return false;
  let dataset = null;
  const dataFile = (attachments ?? []).find((a) => /\.(csv|xlsx)$/i.test(a.name ?? ""));
  if (dataFile) {
    if (/\.csv$/i.test(dataFile.name)) {
      if (!dataFile.text) return false;
      dataset = { kind: "csv", text: dataFile.text, name: dataFile.name };
    } else {
      const comma = String(dataFile.data_url ?? "").indexOf(",");
      const base64 = comma >= 0 ? String(dataFile.data_url).slice(comma + 1) : "";
      if (!base64) return false;
      dataset = { kind: "xlsx", base64, name: dataFile.name };
    }
  } else {
    // No attachment: the ready workbook (from [Jadikan dataset]) is the dataset.
    try {
      const wb = (await state.api.sheetsWorkbook(state.workspaceRoot))?.workbook;
      if (!wb || wb.stage !== "ready") return false;
      dataset = { kind: "workbook", key: state.workspaceRoot };
    } catch {
      return false;
    }
  }
  if (!dataset) return false;
  state.transcript.push({ kind: "user", text, attachments, ts: Date.now() });
  const thinking = { kind: "assistant", text: "Menyiapkan rencana analisis…", streaming: true };
  state.transcript.push(thinking);
  renderTranscript();
  try {
    const staged = await state.api.sheetsAnalyzePlan({
      question: text,
      dataset,
      root: state.workspaceRoot,
    });
    const i = state.transcript.indexOf(thinking);
    if (i >= 0) state.transcript.splice(i, 1);
    if (!staged?.planId) throw new Error("server tidak mengembalikan plan");
    pushCard("sheets-analyze-plan", {
      planId: staged.planId,
      plan: staged.plan,
      profiles: staged.profiles,
      question: text,
      complexity: staged.complexity,
    });
  } catch (e) {
    const i = state.transcript.indexOf(thinking);
    if (i >= 0) state.transcript.splice(i, 1);
    state.transcript.push({ kind: "error", text: "Gagal menyiapkan rencana analisis: " + errText(e) });
  }
  renderTranscript();
  await refreshRuns();
  return true;
}

async function sendChat(message, override) {
  const text = (message ?? $("chat-input").value).trim();
  if (!text) return;
  resetComposer();
  hideSlashMenu();
  // Local control commands never reach the model as user messages.
  const cmd = parseSlashCommand(text);
  if (cmd) {
    await handleSlashCommand(cmd);
    renderTranscript();
    return;
  }
  if (isStreaming()) return; // one answer at a time — typed text stays put
  const attachments = takeQueuedAttachments();
  // Dae Captain v2 Fase 7: analysis requests with a dataset go straight to
  // the Analis plan card (the card IS the analysis UX) instead of a Susun
  // engine task that would do the wrong thing.
  if (await maybeAnalyzeFromChat(text, attachments)) return;
  state.transcript.push({ kind: "user", text, attachments, ts: Date.now() });
  renderTranscript();
  // Live placeholder: fills token-by-token while the server streams, then
  // becomes the final message (or is dropped for dispatch outcomes).
  const live = { kind: "assistant", text: "", streaming: true };
  state.transcript.push(live);
  renderTranscript();
  updateStopButton();
  // Pill langsung tunjukkan "working" — jangan tunggu polling 10 detik.
  state.pill?.setStatus("working", "Memproses…");
  const controller = new AbortController();
  state.streamAbort = controller;
  const dropLive = () => {
    const i = state.transcript.indexOf(live);
    if (i >= 0) state.transcript.splice(i, 1);
  };
  const finishStream = () => {
    if (state.streamAbort === controller) state.streamAbort = null;
    updateStopButton();
  };
  try {
    const res = await state.api.workflowChatStream(
      chatBody(text, override, attachments),
      (delta) => {
        live.text += delta;
        renderLive();
      },
      controller.signal,
    );
    finishStream();
    dropLive();
    await handleChatResponse(res, { text, override, attachments });
  } catch (e) {
    finishStream();
    dropLive();
    if (e?.name === "AbortError") {
      // User-pressed stop: keep the partial answer, marked as cut off.
      if (live.text) {
        state.transcript.push({ kind: "assistant", text: live.text, session: true, ts: Date.now(), stopped: true });
      }
      renderTranscript();
      await refreshRuns();
      return;
    }
    if (e?.partial) {
      // The server streamed half an answer, then failed: keep what the
      // user already saw, labelled honestly, instead of failing blank.
      state.transcript.push({ kind: "assistant", text: e.partial, session: true, ts: Date.now() });
      state.transcript.push({ kind: "error", text: "Respons terputus: " + errText(e) });
      renderTranscript();
      await refreshRuns();
      return;
    }
    // Fallback: plain non-streaming endpoint (older server, SSE-blocking proxy).
    try {
      const res = await state.api.workflowChat(chatBody(text, override, attachments));
      await handleChatResponse(res, { text, override, attachments });
    } catch (e2) {
      // Keep the failed message one click away from resending.
      state.transcript.push({ kind: "error", text: errText(e2), retryMessage: text, retryOverride: override ?? null });
    }
  }
  renderTranscript();
  await refreshRuns();
}

/**
 * Regenerate the last in-session assistant answer: same prompt (history
 * minus that answer, same attachments), fresh completion. Resumed history
 * has no attachment bytes, so only live-session answers offer this.
 */
async function regenerateAssistant(entry) {
  if (isStreaming()) return;
  const idx = state.transcript.indexOf(entry);
  const userEntry = [...state.transcript.slice(0, idx)].reverse().find((m) => m.kind === "user");
  if (!userEntry || entry.streaming) return;
  const oldText = entry.text;
  const oldClipped = entry.clipped;
  entry.text = "";
  entry.streaming = true;
  entry.stopped = false;
  renderTranscript();
  updateStopButton();
  const controller = new AbortController();
  state.streamAbort = controller;
  const finishStream = () => {
    if (state.streamAbort === controller) state.streamAbort = null;
    updateStopButton();
  };
  const body = chatBody(userEntry.text, null, userEntry.attachments ?? [], { regenerate: true });
  try {
    const res = await state.api.workflowChatStream(body, (delta) => {
      entry.text += delta;
      renderLive();
    }, controller.signal);
    entry.streaming = false;
    finishStream();
    if (res?.kind === "chat") {
      state.runId = res.run_id ?? state.runId;
      entry.text = res.text;
      entry.clipped = res.clipped === true;
      entry.usage = res.usage;
    } else {
      // Same words re-routed to work (e.g. toggled engine): restore the
      // old answer and say so instead of swapping in a task silently.
      entry.text = oldText;
      entry.clipped = oldClipped;
      state.transcript.push({ kind: "error", text: "Regenerate dialihkan ke task — jawaban lama dipertahankan." });
    }
  } catch (e) {
    entry.streaming = false;
    finishStream();
    if (e?.name === "AbortError") {
      entry.stopped = true; // partial answer stays, marked cut off
      renderTranscript();
      await refreshRuns();
      return;
    }
    try {
      const res = await state.api.workflowChat(body);
      if (res?.kind === "chat") {
        state.runId = res.run_id ?? state.runId;
        entry.text = res.text;
        entry.clipped = res.clipped === true;
        entry.usage = res.usage;
      } else {
        entry.text = oldText;
        entry.clipped = oldClipped;
        state.transcript.push({ kind: "error", text: "Regenerate dialihkan ke task — jawaban lama dipertahankan." });
      }
    } catch (e2) {
      entry.text = oldText;
      entry.clipped = oldClipped;
      state.transcript.push({ kind: "error", text: "Regenerate gagal: " + errText(e2) });
    }
  }
  renderTranscript();
  await refreshRuns();
}

// ---------------------------------------------------------------------------
// Slash commands (local control — never sent to the model)
// ---------------------------------------------------------------------------

function pushAssistant(text) {
  state.transcript.push({ kind: "assistant", text, ts: Date.now() });
}

/** Reset the composer box (text + auto-grown height). */
function resetComposer() {
  const input = $("chat-input");
  if (!input) return;
  input.value = "";
  input.style.height = "auto";
}

/** Grow the composer textarea with its content, up to the CSS cap. */
function autogrowComposer() {
  const input = $("chat-input");
  if (!input) return;
  input.style.height = "auto";
  input.style.height = Math.min(input.scrollHeight, 110) + "px";
}

async function handleSlashCommand({ name, args }) {
  // Echo the typed command so the transcript shows what ran — except
  // clear/new, which wipe the view by definition.
  if (name !== "clear" && name !== "new") {
    state.transcript.push({ kind: "user", text: "/" + name + (args ? " " + args : "") });
  }
  switch (name) {
    case "help":
      pushAssistant("Perintah yang tersedia:\n" + SLASH_COMMANDS.map((c) => `${c.usage} — ${c.description}`).join("\n"));
      break;
    case "clear":
    case "new":
      clearConversation();
      break;
    case "history":
      await showHistory();
      break;
    case "resume":
      await resumeConversation(args);
      break;
    case "status":
      showStatus();
      break;
    case "stop":
      await stopConversationTask();
      break;
    default:
      state.transcript.push({ kind: "error", text: `Perintah tidak dikenal: /${name} — ketik /help untuk daftar perintah.` });
      break;
  }
  updateStopButton();
}

/**
 * Start a genuinely fresh conversation: new server run on the next message
 * (runId null → the server creates a run with zero turns, so no old
 * transcript, artifacts, or reasoning can leak into the new model context).
 * Workspace, settings, engine override, stored runs, files, and running
 * tasks are all preserved — a new chat is NOT a task cancel.
 */
function clearConversation() {
  const running = state.transcript.filter((m) => m.kind === "turn" && m.taskId && !m.activityDone);
  const fresh = freshConversation();
  state.runId = fresh.runId;
  state.workflowRunId = fresh.workflowRunId;
  state.transcript = fresh.transcript;
  state.pendingMessage = null;
  state.pendingOverride = null;
  state.pendingAttachments = [];
  renderAttachChips();
  state.historyList = [];
  state.stick = true;
  state.viewLimit = 30;
  // Dae Captain v2 Fase 7: staged-artifact watchers belong to the old
  // conversation; timeline cursors reset with the new run.
  stopCardWatchers();
  state.seenTimelineEvents.clear();
  state.lastTimelineEventId = "";
  state.turnDoneCache.clear();
  let text = "Percakapan baru dimulai. Workspace dan pengaturan tetap sama; riwayat lama tersimpan dan bisa dibuka via /history.";
  if (running.length) {
    text += ` ${running.length} task masih berjalan di latar dan TIDAK dibatalkan — pantau di Antrean atau hentikan via /stop.`;
  }
  pushAssistant(text);
}

/** List previous workflow runs (real backend data, newest first). */
async function showHistory() {
  await refreshRuns();
  const runs = (state.runs ?? []).slice(0, 10);
  state.historyList = runs.map((r) => r.run_id);
  if (!runs.length) {
    pushAssistant("Belum ada percakapan tersimpan di workspace ini.");
    return;
  }
  const lines = runs.map((r) => runHistoryLine(r, state.historyList.indexOf(r.run_id) + 1));
  pushAssistant("Percakapan sebelumnya (pakai /resume <nomor|id>):\n" + lines.join("\n"));
}

/**
 * Resume a previous run explicitly. The run's turns reload as transcript
 * history and the next message continues in that same run — nothing is
 * resubmitted or restarted.
 */
async function resumeConversation(args) {
  await refreshRuns();
  const runs = state.runs ?? [];
  let run = null;
  if (!args) {
    pushAssistant("Pilih targetnya: /history dulu, lalu /resume <nomor> — mis. /resume 1.");
    return;
  }
  const byIndex = /^\d+$/.test(args) ? runs[Number(args) - 1] : null;
  const matches = runs.filter((r) => r.run_id.startsWith(args));
  run = byIndex ?? (matches.length === 1 ? matches[0] : null);
  if (!run) {
    const detail = !byIndex && matches.length > 1
      ? ` — "${args}" cocok dengan ${matches.length} sesi, tulis id lebih lengkap.`
      : !byIndex ? ` — tidak ada sesi berawalan "${args}".` : ` — hanya ada ${runs.length} sesi tersimpan.`;
    state.transcript.push({ kind: "error", text: "Tidak bisa resume" + detail + " Lihat /history." });
    return;
  }
  try {
    const data = await state.api.workflowRun(run.run_id, state.workspaceRoot);
    const full = data.run;
    state.runId = full.run_id;
    state.workflowRunId = full.run_id;
    state.historyList = [];
    state.transcript = [];
    // Merge engine turns and chat exchanges chronologically. Restored
    // messages are marked resumed: visible and continuous for the model
    // (the server kept them), but without regenerate (no attachment bytes).
    const items = [];
    for (const t of full.turns ?? []) {
      items.push({
        ts: t.created_at ?? t.updated_at ?? "",
        entry: {
          kind: "turn",
          ts: t.created_at ? Date.parse(t.created_at) : undefined,
          engine: t.engine,
          goal: t.goal,
          resolved: t.artifacts,
          staged: false,
          taskId: t.task_id ?? null,
          turnId: t.turn_id ?? null,
          activity: null,
          activityKey: "",
          activityDone: t.status !== "running",
          resumed: true,
        },
      });
    }
    for (const c of full.chat ?? []) {
      items.push({
        ts: c.ts ?? "",
        entry: {
          kind: c.role === "user" ? "user" : "assistant",
          text: c.text,
          ts: c.ts ? Date.parse(c.ts) : undefined,
          ...(c.role === "user" ? {} : { resumed: true }),
        },
      });
    }
    items.sort((a, b) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : 0));
    for (const item of items) state.transcript.push(item.entry);
    const loaded = items.length;
    pushAssistant(`Membuka percakapan ${full.run_id.slice(0, 8)} — ${loaded} pesan dimuat. Pesan berikutnya lanjut di sesi ini.`);
  } catch (e) {
    state.transcript.push({ kind: "error", text: "Gagal membuka sesi: " + errText(e) });
  }
}

/** Current workspace, session, and real task/connection state. */
function showStatus() {
  const runs = state.runs ?? [];
  let running = 0;
  let attention = 0;
  for (const r of runs) {
    for (const t of r.turns ?? []) {
      if (t.status === "running") running++;
      attention += (t.pending_approvals ?? []).length + (t.pending_questions ?? []).length;
    }
  }
  pushAssistant(
    `Status:\n- Workspace: ${state.workspaceRoot || "(belum dipilih)"}\n` +
    `- Sesi: ${state.runId ? state.runId.slice(0, 8) : "(baru — belum ada pesan)"}\n` +
    `- Koneksi: ${state.connected ? "terhubung" : "terputus"}\n` +
    `- Sesi tersimpan: ${runs.length}, task berjalan: ${running}, butuh perhatian: ${attention}`
  );
}

/**
 * Cancel the running task(s) of THIS conversation via the real
 * POST /tasks/:id/cancel endpoint. Reports each outcome honestly —
 * never claims a cancel that failed, and never touches other runs.
 */
async function stopConversationTask() {
  const turns = [...state.transcript].reverse().filter(
    (m) => m.kind === "turn" && m.taskId && !m.activityDone
  );
  if (!turns.length) {
    pushAssistant("Tidak ada task berjalan di percakapan ini. (Ini bukan clear chat — pakai /clear untuk sesi baru.)");
    return;
  }
  const results = [];
  for (const t of turns) {
    try {
      const res = await state.api.cancelTask(t.taskId);
      // 200 = the cancel marker is recorded (a live runner is also
      // signalled when present); either way the task will not continue.
      t.activityDone = true;
      results.push(`${engineLabel(t.engine)}: ${res?.cancelled ? "dibatalkan" : "permintaan batal tercatat"}`);
    } catch (e) {
      results.push(`${engineLabel(t.engine)}: gagal (${errText(e)})`);
    }
  }
  pushAssistant("Stop:\n- " + results.join("\n- "));
  await refreshRuns();
}

// ---------------------------------------------------------------------------
// Slash suggestion menu (compact, island-style)
// ---------------------------------------------------------------------------

function hideSlashMenu() {
  state.slashIndex = -1;
  $("slash-menu")?.classList.add("hidden");
}

function matchingSlashCommands(prefix) {
  const p = (prefix ?? "").toLowerCase();
  return SLASH_COMMANDS.filter((c) => c.name.startsWith(p));
}

function renderSlashMenu() {
  const box = $("slash-menu");
  const input = $("chat-input");
  if (!box || !input) return;
  const m = /^\s*\/([a-z]*)$/i.exec(input.value);
  if (!m || document.activeElement !== input) {
    hideSlashMenu();
    return;
  }
  const list = matchingSlashCommands(m[1]);
  if (!list.length) {
    hideSlashMenu();
    return;
  }
  if (state.slashIndex < 0 || state.slashIndex >= list.length) state.slashIndex = 0;
  box.innerHTML = "";
  list.forEach((c, i) => {
    const el = document.createElement("button");
    el.className = "slash-item" + (i === state.slashIndex ? " active" : "");
    el.innerHTML = `<span class="slash-name">/${escapeHtml(c.name)}</span> <span class="hint">${escapeHtml(c.description)}</span>`;
    el.onmousedown = (e) => {
      e.preventDefault(); // keep focus so Enter still sends
      applySlashCompletion(c.name);
    };
    box.appendChild(el);
  });
  box.classList.remove("hidden");
}

function applySlashCompletion(name) {
  const input = $("chat-input");
  if (!input) return;
  input.value = "/" + name + " ";
  hideSlashMenu();
  input.focus();
}

// ---------------------------------------------------------------------------
// Composer attachments (images → vision, text files → inline excerpt)
// ---------------------------------------------------------------------------

function renderAttachChips() {
  updateAttachVisionWarn();
  const box = $("attach-chips");
  if (!box) return;
  box.innerHTML = "";
  state.pendingAttachments.forEach((a, i) => {
    const chip = document.createElement("span");
    chip.className = "attach-chip";
    chip.innerHTML = `<span>${escapeHtml(a.kind === "image" ? "🖼" : a.kind === "file" ? "📊" : "📄")} ${escapeHtml(a.name)}</span>`;
    // Dae Captain v2 Fase 7: [Jadikan dataset] on csv/xlsx attachments.
    if (/\.(csv|xlsx)$/i.test(a.name ?? "")) {
      const ds = document.createElement("button");
      ds.className = "chip-dataset";
      ds.textContent = "Jadikan dataset";
      ds.title = "Jadikan dataset spreadsheet";
      ds.onclick = (ev) => {
        ev.stopPropagation();
        void makeAttachmentDataset(a);
      };
      chip.appendChild(ds);
    }
    const x = document.createElement("button");
    x.className = "chip-x";
    x.textContent = "✕";
    x.title = "Hapus lampiran";
    x.onclick = () => {
      state.pendingAttachments.splice(i, 1);
      renderAttachChips();
    };
    chip.appendChild(x);
    box.appendChild(chip);
  });
}

/**
 * Dae Captain v2 Fase 7 — [Jadikan dataset]: upload the attachment bytes
 * to the workspace, then import as the editable workbook
 * (POST /sheets/workbook/open). Real API calls, honest row counts.
 */
async function makeAttachmentDataset(a) {
  if (!state.api) return;
  actionStatus("Menjadikan dataset…");
  try {
    let contentBase64 = "";
    if (a.kind === "text" && typeof a.text === "string") {
      contentBase64 = btoa(unescape(encodeURIComponent(a.text)));
    } else if (typeof a.data_url === "string") {
      const comma = a.data_url.indexOf(",");
      contentBase64 = comma >= 0 ? a.data_url.slice(comma + 1) : "";
    }
    if (!contentBase64) throw new Error("lampiran kosong");
    const up = await state.api.uploadJson({
      root: state.workspaceRoot,
      files: [{ name: a.name, contentBase64, mimeType: a.mime }],
    });
    const stored = up?.files?.[0]?.path ?? up?.attachments?.[0]?.workspacePath;
    if (!stored) throw new Error("upload tidak mengembalikan path");
    const opened = await state.api.sheetsWorkbookOpen({
      root: state.workspaceRoot,
      path: stored,
    });
    const wb = opened?.workbook;
    const sheets = Array.isArray(wb?.sheets) ? wb.sheets.length : 0;
    pushAssistant(`Dataset siap: **${a.name}** → workbook (${sheets} sheet). Tanya apa saja soal datanya — mis. "analisis tren penjualan".`);
    renderTranscript();
    actionStatus("Dataset siap.");
  } catch (e) {
    actionStatus("Jadikan dataset gagal: " + errText(e));
  }
}

/** Take (and clear) the queued attachments for one send. */
function takeQueuedAttachments() {
  const out = [...state.pendingAttachments];
  state.pendingAttachments = [];
  renderAttachChips();
  const fileInput = $("chat-file");
  if (fileInput) fileInput.value = "";
  return out;
}

function readFileAs(kind, file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error("gagal membaca file"));
    reader.onload = () => resolve(reader.result);
    if (kind === "image" || kind === "file") reader.readAsDataURL(file);
    else reader.readAsText(file);
  });
}

async function queuePickedFiles(files) {
  for (const file of files ?? []) {
    if (state.pendingAttachments.length >= CHAT_ATTACH_LIMITS.maxFiles) {
      state.transcript.push({ kind: "error", text: `Maksimal ${CHAT_ATTACH_LIMITS.maxFiles} lampiran per pesan.` });
      renderTranscript();
      break;
    }
    const check = validateAttachmentPick({ name: file.name, mime: file.type, sizeBytes: file.size });
    if (!check.ok) {
      state.transcript.push({ kind: "error", text: `Lampiran "${file.name}" ditolak: ${check.reason}.` });
      renderTranscript();
      continue;
    }
    try {
      const raw = await readFileAs(check.kind, file);
      state.pendingAttachments.push(
        check.kind === "image" || check.kind === "file"
          ? { name: file.name, mime: check.mime, kind: check.kind, data_url: String(raw) }
          : { name: file.name, mime: check.mime, kind: "text", text: String(raw).slice(0, CHAT_ATTACH_LIMITS.textMaxChars) },
      );
    } catch (e) {
      state.transcript.push({ kind: "error", text: `Lampiran "${file.name}" gagal dibaca: ${errText(e)}.` });
      renderTranscript();
    }
  }
  renderAttachChips();
}

function slashMenuOpen() {
  return !!$("slash-menu") && !$("slash-menu").classList.contains("hidden");
}

function stepSlashMenu(delta) {
  const m = /^\s*\/([a-z]*)$/i.exec($("chat-input")?.value ?? "");
  const list = matchingSlashCommands(m?.[1] ?? "");
  if (!list.length) return;
  state.slashIndex = ((state.slashIndex < 0 ? 0 : state.slashIndex) + delta + list.length) % list.length;
  renderSlashMenu();
}

// ---------------------------------------------------------------------------
// Polling
// ---------------------------------------------------------------------------

function renderHeaderStatus() {
  const el = $("header-status");
  if (!el) return;
  const ws = state.workspaceRoot ? state.workspaceRoot.replace(/\/+$/, "").split("/").pop() : "";
  const agg = aggregateStatus(state.runs);
  const wsName = state.workspaceRoot ? state.workspaceRoot.replace(/\/+$/, "").split("/").pop() : "";
  const done = completionLabel(state.runs);
  const what = (!state.connected && agg.status === "idle")
    ? "terputus"
    : agg.status === "attention"
      ? agg.attention + " butuh perhatian"
      : agg.status === "working"
        ? activityLabel(state.runs, agg)
        : (done || "siap");
  el.textContent = (wsName ? wsName + " • " : "") + what;
}

/** Status view: live engine pills + per-run cards. All data from polling. */
const WF_BADGES = {
  progress: ["In Progress", "blue"],
  approval: ["Butuh persetujuan", "amber"],
  done: ["Done", "green"],
  failed: ["Failed", "red"],
  cancelled: ["Cancelled", "gray"],
};

/** Workflow queue view: one run's turns as task rows (all real data). */
async function renderWorkflowView() {
  const runId = state.workflowRunId ?? state.runId;
  const box = $("wf-rows");
  const statusEl = $("wf-status");
  box.innerHTML = "";
  statusEl.textContent = "";
  $("wf-cancel").classList.add("hidden");
  // Filter chips
  const filter = state.wfFilter ?? "all";
  for (const b of document.querySelectorAll("#wf-filters .filter-chip")) {
    b.classList.toggle("active", b.dataset.filter === filter);
  }
  if (!runId) {
    $("wf-prompt").textContent = "Belum ada run — kirim perintah dulu dari Chat.";
    $("wf-count").textContent = "";
    return;
  }
  let run;
  try {
    const data = await state.api.workflowRun(runId, state.workspaceRoot);
    run = data.run;
  } catch (e) {
    $("wf-prompt").textContent = "Gagal memuat run: " + errText(e);
    $("wf-count").textContent = "";
    return;
  }
  const rows = queueRows(run);
  // Apply status filter (filter var already declared above for chips)
  const filtered = rows.filter((r) => {
    if (filter === "all") return true;
    if (filter === "running") return r.status === "running";
    if (filter === "approval") return (r.approvals?.length ?? 0) > 0 || (r.questions?.length ?? 0) > 0;
    if (filter === "done") return r.status === "done";
    if (filter === "failed") return r.status === "failed";
    return true;
  });
  $("wf-prompt").textContent = rows.length ? rows[0].goal : "Run kosong.";
  $("wf-count").textContent = filtered.length
    ? `Menampilkan ${filtered.length} dari ${rows.length} task`
    : rows.length ? "Tidak ada task yang cocok dengan filter." : "";
  const running = rows.filter((r) => r.status === "running");
  if (running.length) $("wf-cancel").classList.remove("hidden");
  for (const row of filtered) {
    const [badgeText, badgeClass] = WF_BADGES[row.badge] ?? ["?", "gray"];
    const card = document.createElement("div");
    card.className = "wf-row";
    const head = document.createElement("div");
    head.className = "wf-head";
    head.innerHTML = `
      <span class="wf-engine">${escapeHtml(row.label)}</span>
      <span class="badge ${badgeClass}">${escapeHtml(badgeText)}</span>`;
    card.appendChild(head);
    const goal = document.createElement("div");
    goal.className = "wf-goal";
    goal.textContent = row.goal;
    card.appendChild(goal);
    if (row.lastEvent) {
      const logs = document.createElement("div");
      logs.className = "wf-logs";
      logs.textContent = "Logs: " + row.lastEvent;
      card.appendChild(logs);
    }
    if (row.note) {
      const note = document.createElement("div");
      note.className = "hint";
      note.textContent = row.note;
      card.appendChild(note);
    }
    // Pending approvals → working [Approve]/[Deny] (same API as chat cards).
    for (const ap of row.approvals) {
      const apRow = document.createElement("div");
      apRow.className = "row";
      apRow.innerHTML = `<span class="hint">${escapeHtml(ap.tool ?? "approval")} menunggu keputusan</span>`;
      const grant = document.createElement("button");
      grant.className = "primary-btn";
      grant.textContent = "Approve";
      grant.onclick = () => decideRowApproval(row.taskId, ap, "grant", statusEl);
      const deny = document.createElement("button");
      deny.className = "deny-btn";
      deny.textContent = "Deny";
      deny.onclick = () => decideRowApproval(row.taskId, ap, "deny", statusEl);
      apRow.append(grant, deny);
      card.appendChild(apRow);
    }
    // Live feed: real event log for running tasks.
    if (row.status === "running") {
      const feedBtn = document.createElement("button");
      feedBtn.className = "ghost-btn";
      feedBtn.textContent = "View Live Feed";
      const feedBox = document.createElement("div");
      feedBox.className = "wf-feed hidden";
      let loaded = false;
      feedBtn.onclick = async () => {
        feedBox.classList.toggle("hidden");
        if (feedBox.classList.contains("hidden") || loaded) return;
        feedBox.textContent = "Memuat…";
        try {
          const data = await state.api.taskEvents(row.taskId);
          const events = (data.events ?? []).slice(-15).reverse();
          feedBox.innerHTML = events.length
            ? events.map((e) => `<div class="wf-event"><span class="mono">${escapeHtml(String(e.type ?? "?"))}</span> <span class="hint">${escapeHtml(String(e.ts ?? "").slice(11, 19))}</span></div>`).join("")
            : `<span class="hint">Belum ada event.</span>`;
          loaded = true;
        } catch (e) {
          feedBox.textContent = "Gagal memuat feed: " + errText(e);
        }
      };
      card.appendChild(feedBtn);
      card.appendChild(feedBox);
    }
    box.appendChild(card);
  }
}

async function decideRowApproval(taskId, approval, decision, statusEl) {
  try {
    await decideApproval(taskId, approval, decision);
    statusEl.className = "status-line ok";
    statusEl.textContent = decision === "grant" ? "Disetujui ✓" : "Ditolak.";
    await refreshRuns();
    renderWorkflowView();
  } catch (e) {
    statusEl.className = "status-line error";
    statusEl.textContent = "Gagal: " + errText(e);
  }
}

/** Cancel every running turn in the displayed run (real per-task cancel). */
async function cancelWorkflow() {
  const statusEl = $("wf-status");
  const runId = state.workflowRunId ?? state.runId;
  if (!runId) return;
  const btn = $("wf-cancel");
  btn.disabled = true;
  try {
    const data = await state.api.workflowRun(runId, state.workspaceRoot);
    const running = (data.run?.turns ?? []).filter((t) => t.status === "running");
    let ok = 0;
    for (const t of running) {
      try { await state.api.cancelTask(t.task_id); ok++; } catch { /* lanjutkan sisanya */ }
    }
    statusEl.className = "status-line ok";
    statusEl.textContent = ok ? `${ok} task dibatalkan.` : "Tidak ada task berjalan.";
    await refreshRuns();
    renderWorkflowView();
  } catch (e) {
    statusEl.className = "status-line error";
    statusEl.textContent = "Gagal: " + errText(e);
  }
  btn.disabled = false;
}

async function refreshRuns() {
  if (!state.api) return;
  try {
    const data = await state.api.workflowRuns(state.workspaceRoot);
    state.runs = data.runs ?? [];
    state.connected = true;
  } catch {
    // Keep last-known runs: a transient failure must not flash the pill
    // to idle or hide approvals.
    state.connected = false;
    renderPill();
    renderHeaderStatus();
    return;
  }
  renderPill();
  renderHeaderStatus();
  renderChatEnginePills();
  const pending = pendingApprovals(state.runs);
  // Do-not-disturb: approvals stay queued, the pill stays quiet — no
  // auto-expand, no pulse. (Fase 8 adds the settings toggle; the
  // controller already exposes setDoNotDisturb().)
  const dnd = state.pill?.isDoNotDisturb() === true;
  if (pending.length > 0 && !state.approvalOpen && !dnd) {
    state.approvalOpen = true;
    expand(); // approval baru → island mekar (once per batch)
  } else if (pending.length === 0) {
    state.approvalOpen = false;
  }
  await refreshTurnActivity();
  // Dae Captain v2 Fase 7: v2 timeline → verify-fail bubbles in chat.
  void pollCaptainTimeline();
  if (!state.expanded) return;
  const wf = $("view-workflow");
  if (wf && !wf.classList.contains("hidden")) {
    renderWorkflowView();
  } else {
    renderApprovals();
  }
}

/** Find a workflow turn across runs by its task id. */
function findRunTurn(taskId) {
  for (const run of state.runs ?? []) {
    for (const t of run.turns ?? []) {
      if (t.task_id === taskId) return t;
    }
  }
  return null;
}

function isChatViewVisible() {
  const main = $("view-main");
  if (!main) return false;
  return state.expanded && !main.classList.contains("hidden");
}

/**
 * Live activity for the latest chat turn (thinking + tool calls, like the
 * web panel). Polls task events while the turn is running; stops when the
 * turn leaves "running". Re-renders the transcript only on change.
 */
/** Show the Stop button only while a chat task is running. */
function updateStopButton() {
  const stop = $("chat-stop");
  const send = $("chat-send");
  if (!stop || !send) return;
  const running = [...state.transcript].reverse().some(
    (m) => m.kind === "turn" && m.taskId && !m.activityDone
  );
  // Streaming answers are stoppable too — and sending is locked while one
  // flows, otherwise two live bubbles would trade each other's deltas.
  const busy = running || isStreaming();
  stop.classList.toggle("hidden", !busy);
  send.classList.toggle("hidden", busy);
  stop.title = isStreaming() && !running ? "Hentikan jawaban" : "Hentikan task";
}

/**
 * Engine status pills at the top of chat (mockup): 5 engines with colored
 * dots — green=working, amber=needs approval, blue=idle/done, red=failed.
 */
function renderChatEnginePills() {
  const box = $("chat-engine-pills");
  if (!box) return;
  box.innerHTML = "";
  const engines = ["coding", "slide", "dokumen", "spreadsheet", "research"];
  const statusByEngine = {};
  for (const run of state.runs ?? []) {
    for (const t of run.turns ?? []) {
      if (!t.engine) continue;
      const dot = t.status === "running"
        ? (t.pending_approvals?.length ? "amber" : "green")
        : t.status === "failed" ? "red" : "blue";
      // Running/approval takes precedence over idle.
      const rank = { green: 3, amber: 3, red: 2, blue: 1 }[dot] ?? 0;
      if (rank >= (statusByEngine[t.engine]?.rank ?? 0)) {
        statusByEngine[t.engine] = { dot, rank };
      }
    }
  }
  for (const e of engines) {
    const dot = statusByEngine[e]?.dot ?? "gray";
    const el = document.createElement("span");
    el.className = "chat-engine-pill";
    el.innerHTML = `<span class="dot ${dot}"></span> ${escapeHtml(engineLabel(e))}`;
    box.appendChild(el);
  }
}

async function refreshTurnActivity() {
  if (!state.api) return;
  const turn = [...state.transcript].reverse().find(
    (m) => m.kind === "turn" && m.taskId && !m.activityDone
  );
  if (!turn) return;
  // Wildcard subscription covers every running turn at once. Subscribing
  // per-turn reset since_seq to 0 each poll cycle (replay storm) and hid
  // events from all but the latest turn — subscribe once, keyed by flag.
  if (state.eventStream && !state.wsSubscribed) {
    state.eventStream.subscribe("*");
    state.wsSubscribed = true;
  }
  const runTurn = findRunTurn(turn.taskId);
  if (runTurn && runTurn.status !== "running") {
    turn.activityDone = true;
    updateStopButton();
  }
}

/** Handle live task events from WebSocket (or polling fallback). */
function handleTaskEvents(events) {
  if (!events?.length) return;
  // Dedupe on reconnect: the server replays from since_seq, but poll
  // fallback and resubscribes can redeliver — apply each (task, seq) once.
  const fresh = events.filter((e) => {
    const id = e.task_id ?? e.taskId;
    const seq = typeof e.seq === "number" ? e.seq : -1;
    if (!id || seq < 0) return true;
    const seen = state.seenEvents.get(id) ?? 0;
    if (seq <= seen) return false;
    state.seenEvents.set(id, seq);
    return true;
  });
  if (!fresh.length) return;
  const taskIds = new Set(fresh.map((e) => e.task_id ?? e.taskId).filter(Boolean));
  for (const taskId of taskIds) {
    const turn = [...state.transcript].reverse().find(
      (m) => m.kind === "turn" && m.taskId === taskId && !m.activityDone
    );
    if (!turn) continue;
    turn.eventBuffer = turn.eventBuffer ?? [];
    turn.eventBuffer.push(...fresh.filter((e) => (e.task_id ?? e.taskId) === taskId));
    const summary = summarizeTaskEvents(turn.eventBuffer);
    const key = JSON.stringify(summary);
    if (key !== turn.activityKey) {
      turn.activityKey = key;
      turn.activity = summary;
      if (isChatViewVisible()) renderTranscript();
    }
    const lastEvent = fresh[fresh.length - 1];
    if (lastEvent?.type === "TASK_COMPLETED" || lastEvent?.type === "TASK_FAILED" || lastEvent?.type === "TASK_CANCELLED") {
      turn.activityDone = true;
      updateStopButton();
    }
  }
  // Dae Captain v2 Fase 7: task events may coincide with v2 timeline
  // verify events — poll for the fail bubbles.
  void pollCaptainTimeline();
  refreshRunsQuiet();
}

/** Refresh runs without triggering activity refresh (for event-driven updates). */
async function refreshRunsQuiet() {
  if (!state.api) return;
  try {
    const data = await state.api.workflowRuns(state.workspaceRoot);
    state.runs = data.runs ?? [];
    state.connected = true;
  } catch {
    state.connected = false;
    renderPill();
    renderHeaderStatus();
    return;
  }
  renderPill();
  renderHeaderStatus();
  renderChatEnginePills();
  const pending = pendingApprovals(state.runs);
  const dnd = state.pill?.isDoNotDisturb() === true;
  if (pending.length > 0 && !state.approvalOpen && !dnd) {
    state.approvalOpen = true;
    expand();
  } else if (pending.length === 0) {
    state.approvalOpen = false;
  }
  if (!state.expanded) return;
  const wf = $("view-workflow");
  if (wf && !wf.classList.contains("hidden")) {
    renderWorkflowView();
  } else {
    renderApprovals();
  }
}


// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// i18n — static UI chrome (Dae Captain v2 Fase 8, Settings → Umum → Bahasa).
// Covers the island's static labels via data-i18n attributes; agent chat
// text and dynamic status lines stay in Indonesian (documented scope).
// ---------------------------------------------------------------------------

const I18N = {
  id: {
    "common.back": "← Kembali",
    "nav.workspace": "Pilih workspace",
    "nav.settings": "Pengaturan",
    "nav.collapse": "Kecilkan",
    "nav.quit": "Keluar",
    "chat.jump": "↓ pesan baru",
    "chat.approveAll": "Approve All",
    "chat.queue": "Antrean",
    "chat.crew": "Kru",
    "chat.export": "Ekspor",
    "chat.attach": "Lampirkan gambar/teks",
    "chat.inputPh": "Tanya Dae Captain sesuatu… (Enter kirim, Shift+Enter baris baru)",
    "chat.stop": "Hentikan task",
    "chat.send": "Kirim",
    "wf.title": "Antrean",
    "wf.all": "Semua",
    "wf.running": "Jalan",
    "wf.approval": "Butuh approval",
    "wf.done": "Selesai",
    "wf.failed": "Gagal",
    "wf.cancel": "Cancel Workflow",
    "crew.title": "Kru",
    "crew.hint": "Agen, skills, dan koneksi yang dikendalikan captain — baca saja, tidak bisa diubah dari sini.",
    "ws.title": "Workspace",
    "ws.activeFolder": "Folder aktif",
    "ws.change": "Ganti",
    "ws.recent": "Terbaru",
    "ws.allFiles": "Semua file",
    "ws.searchPh": "🔍 Cari file...",
    "ws.hint": 'Ganti workspace lewat chat: "pindah workspace ke ~/tesis"',
    "set.title": "Pengaturan",
    "set.saved": "✓ tersimpan",
    "set.provider": "Provider",
    "set.addProvider": "＋ Tambah Provider",
    "set.provFormAdd": "Tambah provider",
    "set.provFormEdit": "Ubah provider",
    "set.provName": "Nama",
    "set.provType": "Tipe",
    "set.provTypeOpenAI": "OpenAI-compatible",
    "set.provTypeOther": "Lainnya",
    "set.provKeyOpt": "(opsional)",
    "set.testConn": "Tes Koneksi",
    "set.saveProv": "Simpan",
    "set.testRequired": "Tes koneksi wajib lolos sebelum Simpan aktif.",
    "set.modelRoles": "Model per Peran",
    "set.globalModel": "Model global (semua peran)",
    "set.tierStrong": "Tier Kuat",
    "set.tierLight": "Tier Ringan",
    "set.lightEmpty": "Kosongkan tier ringan untuk pakai 1 model global.",
    "set.pillPosition": "Posisi",
    "set.posTopCenter": "Tengah atas",
    "set.posTopLeft": "Kiri atas",
    "set.posTopRight": "Kanan atas",
    "set.posBottomLeft": "Kiri bawah",
    "set.posBottomRight": "Kanan bawah",
    "set.pillNotify": "Notifikasi",
    "set.notifyPulse": "Denyut",
    "set.notifySound": "Suara",
    "set.notifyOff": "Mati",
    "set.pillDnd": "Jangan ganggu",
    "set.approval": "Approval",
    "set.askAll": "Tanya semua",
    "set.autoAll": "Otomatis semua",
    "set.memory": "Memori",
    "set.memoryHint": "Dae Captain mengingat preferensi dan polamu antar sesi.",
    "set.memoryShow": "Lihat yang diingat",
    "set.memoryClear": "Hapus semua",
    "set.reminders": "Pengingat",
    "set.general": "Umum",
    "set.language": "Bahasa",
    "set.theme": "Tema",
    "set.themeDark": "Gelap",
    "set.themeLight": "Terang",
    "set.thinking": "Berpikir (reasoning effort)",
    "set.thinkOff": "Mati — tercepat, tanpa penalaran",
    "set.thinkLow": "Rendah — cepat",
    "set.thinkMedium": "Sedang — seimbang",
    "set.thinkHigh": "Tinggi — paling teliti",
    "set.temperature": "Kreativitas (temperature 0–2)",
    "set.engines": "Engine aktif",
  },
  en: {
    "common.back": "← Back",
    "nav.workspace": "Choose workspace",
    "nav.settings": "Settings",
    "nav.collapse": "Collapse",
    "nav.quit": "Quit",
    "chat.jump": "↓ new messages",
    "chat.approveAll": "Approve All",
    "chat.queue": "Queue",
    "chat.crew": "Crew",
    "chat.export": "Export",
    "chat.attach": "Attach image/text",
    "chat.inputPh": "Ask Dae Captain anything… (Enter to send, Shift+Enter for new line)",
    "chat.stop": "Stop task",
    "chat.send": "Send",
    "wf.title": "Queue",
    "wf.all": "All",
    "wf.running": "Running",
    "wf.approval": "Needs approval",
    "wf.done": "Done",
    "wf.failed": "Failed",
    "wf.cancel": "Cancel Workflow",
    "crew.title": "Crew",
    "crew.hint": "Agents, skills, and connections the captain commands — read-only, cannot be changed here.",
    "ws.title": "Workspace",
    "ws.activeFolder": "Active folder",
    "ws.change": "Change",
    "ws.recent": "Recent",
    "ws.allFiles": "All files",
    "ws.searchPh": "🔍 Search files...",
    "ws.hint": 'Switch workspace via chat: "move workspace to ~/thesis"',
    "set.title": "Settings",
    "set.saved": "✓ saved",
    "set.provider": "Provider",
    "set.addProvider": "＋ Add Provider",
    "set.provFormAdd": "Add provider",
    "set.provFormEdit": "Edit provider",
    "set.provName": "Name",
    "set.provType": "Type",
    "set.provTypeOpenAI": "OpenAI-compatible",
    "set.provTypeOther": "Other",
    "set.provKeyOpt": "(optional)",
    "set.testConn": "Test Connection",
    "set.saveProv": "Save",
    "set.testRequired": "The connection test must pass before Save is enabled.",
    "set.modelRoles": "Model per Role",
    "set.globalModel": "Global model (all roles)",
    "set.tierStrong": "Strong Tier",
    "set.tierLight": "Light Tier",
    "set.lightEmpty": "Leave the light tier empty to use 1 global model.",
    "set.pillPosition": "Position",
    "set.posTopCenter": "Top center",
    "set.posTopLeft": "Top left",
    "set.posTopRight": "Top right",
    "set.posBottomLeft": "Bottom left",
    "set.posBottomRight": "Bottom right",
    "set.pillNotify": "Notifications",
    "set.notifyPulse": "Pulse",
    "set.notifySound": "Sound",
    "set.notifyOff": "Off",
    "set.pillDnd": "Do not disturb",
    "set.approval": "Approval",
    "set.askAll": "Ask everything",
    "set.autoAll": "Auto everything",
    "set.memory": "Memory",
    "set.memoryHint": "Dae Captain remembers your preferences and patterns across sessions.",
    "set.memoryShow": "See what's remembered",
    "set.memoryClear": "Forget all",
    "set.reminders": "Reminders",
    "set.general": "General",
    "set.language": "Language",
    "set.theme": "Theme",
    "set.themeDark": "Dark",
    "set.themeLight": "Light",
    "set.thinking": "Thinking (reasoning effort)",
    "set.thinkOff": "Off — fastest, no reasoning",
    "set.thinkLow": "Low — fast",
    "set.thinkMedium": "Medium — balanced",
    "set.thinkHigh": "High — most thorough",
    "set.temperature": "Creativity (temperature 0–2)",
    "set.engines": "Active engines",
  },
};

/** Translate a static-chrome key; falls back to Indonesian, then the key. */
function t(key) {
  const lang = state.prefs?.language === "en" ? "en" : "id";
  return I18N[lang][key] ?? I18N.id[key] ?? key;
}

/** Apply the language to every [data-i18n] element in the static chrome. */
function applyLanguage(lang) {
  const l = lang === "en" ? "en" : "id";
  document.documentElement.lang = l;
  for (const el of document.querySelectorAll("[data-i18n]")) {
    el.textContent = t(el.getAttribute("data-i18n"));
  }
  for (const el of document.querySelectorAll("[data-i18n-ph]")) {
    el.placeholder = t(el.getAttribute("data-i18n-ph"));
  }
  for (const el of document.querySelectorAll("[data-i18n-title]")) {
    el.title = t(el.getAttribute("data-i18n-title"));
  }
}

/** Apply the theme: body[data-theme="light"] switches the token set. */
function applyTheme(theme) {
  document.body.dataset.theme = theme === "light" ? "light" : "dark";
}

// ---------------------------------------------------------------------------
// Settings (Dae Captain v2 Fase 8).
// Auto-save: every change persists immediately + the "✓ tersimpan"
// indicator flashes. No Save button anywhere.
// ---------------------------------------------------------------------------

let saveFlashTimer = null;

/** Flash the "✓ tersimpan" indicator after a successful auto-save. */
function flashSaved() {
  const el = $("set-saved");
  if (!el) return;
  el.classList.remove("hidden");
  clearTimeout(saveFlashTimer);
  saveFlashTimer = setTimeout(() => el.classList.add("hidden"), 1800);
}

function setSettingsStatus(text, cls) {
  const el = $("set-status");
  if (!el) return;
  el.className = "status-line" + (cls ? " " + cls : "");
  el.textContent = text ?? "";
}

async function loadSettingsView() {
  setSettingsStatus("", "");
  try {
    const s = await state.api.getSettings();
    const activeId = s.session?.providerId ?? s.session?.provider_id ?? "";
    state.activeProviderId = activeId;
    // The approval radios reflect the LIVE server session, not just the
    // last thing this panel wrote — another client may have changed it.
    state.prefs = { ...state.prefs, auto_approve: s.session?.autoApprove === true };
    await invoke("set_prefs", { prefs: state.prefs }).catch(() => {});
    await loadProviderSection(activeId);
    await loadModelSection(s);
    loadPillSection();
    // Mirror resolveApprovalTypes(): legacy global auto-approve = all auto.
    renderApprovalTypes(s.session?.autoApprove === true
      ? { newFile: "auto", modifyFile: "auto", command: "auto" }
      : (s.session?.approvalTypes ?? { newFile: "auto", modifyFile: "ask", command: "ask" }));
    await loadReminderSection();
    loadGeneralSection(s);
    await loadEngineToggles();
  } catch (e) {
    setSettingsStatus("Gagal memuat pengaturan: " + errText(e), "error");
  }
}

// ---- 1. Provider ----

/**
 * Provider list: live status dot per row (real /models round-trip in the
 * background), one radio = the active provider, per-row key/edit, enable
 * toggle, and two-step delete. API keys are never shown — "••••••••" when
 * a secret is stored, nothing otherwise.
 */
async function loadProviderSection(activeId) {
  const box = $("set-provider-list");
  if (!box) return;
  box.innerHTML = `<p class="hint">Memuat…</p>`;
  let providers = [];
  try {
    const data = await state.api.getProviders();
    providers = data.providers ?? [];
  } catch (e) {
    box.innerHTML = `<p class="status-line error">Gagal memuat provider: ${escapeHtml(errText(e))}</p>`;
    return;
  }
  state.providersCache = providers;
  box.innerHTML = "";
  if (!providers.length) {
    box.innerHTML = `<p class="hint">Belum ada provider. Tambah satu di bawah.</p>`;
  }
  for (const p of providers) {
    const row = document.createElement("div");
    row.className = "prov-row";
    const disabled = p.enabled === false;
    const dot = document.createElement("span");
    dot.className = "status-dot prov-status";
    dot.dataset.prov = p.id;
    dot.title = "Mengecek…";
    const radio = document.createElement("input");
    radio.type = "radio";
    radio.name = "prov-active";
    radio.checked = p.id === activeId;
    radio.disabled = disabled;
    radio.title = disabled ? "Aktifkan dulu untuk memakai provider ini" : "Jadikan provider aktif";
    radio.onchange = () => setActiveProvider(p.id);
    const info = document.createElement("span");
    info.className = "prov-info";
    info.innerHTML =
      `<span class="prov-name">${escapeHtml(p.name ?? p.id)}${disabled ? ' <span class="conf">(nonaktif)</span>' : ""}</span>` +
      `<span class="url">${escapeHtml(p.baseUrl ?? "")}</span>`;
    const key = document.createElement("span");
    key.className = "prov-key";
    key.innerHTML = p.hasApiKey ? "••••••••" : '<span class="conf">tanpa kunci</span>';
    const actions = document.createElement("span");
    actions.className = "prov-actions";
    const editBtn = document.createElement("button");
    editBtn.className = "ghost-btn small";
    editBtn.textContent = "🔑";
    editBtn.title = "Ubah kunci / URL";
    editBtn.onclick = () => openProviderForm("edit", p);
    const toggleBtn = document.createElement("button");
    toggleBtn.className = "ghost-btn small";
    toggleBtn.textContent = disabled ? "Aktifkan" : "Nonaktif";
    toggleBtn.onclick = () => toggleProviderEnabled(p.id, !disabled);
    const delBtn = document.createElement("button");
    delBtn.className = "deny-btn small";
    delBtn.textContent = "Hapus";
    delBtn.onclick = () => deleteProvider(p.id, delBtn);
    actions.append(editBtn, toggleBtn, delBtn);
    row.append(dot, radio, info, key, actions);
    box.appendChild(row);
  }
  // Live dots: test every provider concurrently; a slow one never blocks the rest.
  void refreshProviderStatuses(providers);
}

async function refreshProviderStatuses(providers) {
  await Promise.all(
    providers.map(async (p) => {
      let dot = null;
      try {
        dot = document.querySelector(`.prov-status[data-prov="${CSS.escape(p.id)}"]`);
      } catch {
        return;
      }
      if (!dot) return;
      try {
        const res = await state.api.testProvider(p.id);
        dot.classList.toggle("dot-green", res.ok === true);
        dot.classList.toggle("dot-red", res.ok !== true);
        dot.title = res.message ?? (res.ok ? "OK" : "Gagal");
      } catch (e) {
        dot.classList.add("dot-red");
        dot.title = errText(e);
      }
    }),
  );
}

/** Switch the active provider — real session change, models follow. */
async function setActiveProvider(id) {
  try {
    await state.api.updateSettings({ providerId: id });
    state.activeProviderId = id;
    flashSaved();
    await loadProviderSection(id);
    await loadModelSection(await state.api.getSettings());
  } catch (e) {
    setSettingsStatus("Gagal mengganti provider: " + errText(e), "error");
  }
}

async function toggleProviderEnabled(id, currentlyEnabled) {
  try {
    await state.api.setProviderEnabled(id, !currentlyEnabled);
    flashSaved();
    await loadSettingsView();
  } catch (e) {
    setSettingsStatus("Gagal: " + errText(e), "error");
  }
}

async function deleteProvider(id, btn) {
  // Two-step confirm (no modal in the island): first click arms, second executes.
  if (btn?.dataset.armed !== "1") {
    if (btn) {
      btn.dataset.armed = "1";
      const old = btn.textContent;
      btn.textContent = `Yakin?`;
      setTimeout(() => {
        if (btn.dataset.armed === "1") {
          btn.dataset.armed = "";
          btn.textContent = old;
        }
      }, 5000);
    }
    return;
  }
  if (btn) btn.dataset.armed = "";
  try {
    await state.api.deleteProvider(id);
    flashSaved();
    await loadSettingsView();
  } catch (e) {
    setSettingsStatus("Gagal menghapus provider: " + errText(e), "error");
  }
}

// ---- Add / edit provider form: [Tes Koneksi] is MANDATORY before [Simpan]. ----

let provFormMode = "add";
let provEditId = null;
let provTestOk = false;

function openProviderForm(mode, provider) {
  provFormMode = mode;
  provEditId = provider?.id ?? null;
  provTestOk = false;
  $("prov-form-title").textContent = mode === "edit" ? `${t("set.provFormEdit")} — ${provider?.name ?? provider?.id}` : t("set.provFormAdd");
  $("set-prov-form").classList.remove("hidden");
  $("prov-name").value = provider?.name ?? "";
  $("prov-url").value = provider?.baseUrl ?? "";
  $("prov-key").value = "";
  $("prov-save").disabled = true;
  const st = $("prov-test-status");
  st.className = "status-line";
  st.textContent = "";
  // Any edit invalidates the previous test — Simpan locks again.
  for (const id of ["prov-name", "prov-url", "prov-key"]) {
    $(id).oninput = () => {
      provTestOk = false;
      $("prov-save").disabled = true;
      st.className = "status-line";
      st.textContent = "";
    };
  }
  for (const r of document.querySelectorAll('input[name="prov-type"]')) {
    r.onchange = () => {
      provTestOk = false;
      $("prov-save").disabled = true;
      st.className = "status-line";
      st.textContent = "";
    };
  }
  $("prov-name").focus?.();
}

function slugifyProviderId(name) {
  const slug = String(name ?? "").toLowerCase().trim().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  return slug || "provider";
}

/**
 * Mandatory connection test: fetches /models against the TYPED base URL +
 * key via POST /providers/test-input — nothing is persisted. Only a
 * passing test enables Simpan.
 */
async function testProviderForm() {
  const st = $("prov-test-status");
  const baseUrl = ($("prov-url").value ?? "").trim();
  const apiKey = ($("prov-key").value ?? "").trim();
  if (!baseUrl || !/^https?:\/\//i.test(baseUrl)) {
    st.className = "status-line error";
    st.textContent = "Base URL harus diawali http:// atau https://.";
    return;
  }
  st.className = "status-line";
  st.textContent = "Menghubungi…";
  try {
    const type = document.querySelector('input[name="prov-type"]:checked')?.value === "other" ? "other" : "openai";
    const res = await state.api.testProviderInput({ baseUrl, type, ...(apiKey ? { apiKey } : {}) });
    if (res.ok) {
      provTestOk = true;
      $("prov-save").disabled = false;
      st.className = "status-line ok";
      const n = (res.models ?? []).length;
      st.textContent = type === "other" ? `✅ ${res.message ?? "Terjangkau."}` : `✅ ${n} model ditemukan.`;
    } else {
      provTestOk = false;
      $("prov-save").disabled = true;
      st.className = "status-line error";
      st.textContent = "Gagal: " + (res.message ?? "koneksi gagal");
    }
  } catch (e) {
    provTestOk = false;
    $("prov-save").disabled = true;
    st.className = "status-line error";
    st.textContent = "Gagal: " + errText(e);
  }
}

async function saveProviderForm() {
  if (!provTestOk) return; // Simpan is disabled until the test passes.
  const name = ($("prov-name").value ?? "").trim();
  const baseUrl = ($("prov-url").value ?? "").trim();
  const apiKey = ($("prov-key").value ?? "").trim();
  const st = $("prov-test-status");
  try {
    if (provFormMode === "edit" && provEditId) {
      await state.api.updateProvider(provEditId, {
        ...(name ? { name } : {}),
        baseUrl,
        ...(apiKey ? { apiKey } : {}),
      });
    } else {
      const id = slugifyProviderId(name);
      await state.api.createProvider({
        id,
        name: name || id,
        baseUrl,
        ...(apiKey ? { apiKey } : {}),
      });
    }
    $("prov-key").value = "";
    $("set-prov-form").classList.add("hidden");
    flashSaved();
    await loadSettingsView();
    // loadSettingsView wipes set-status — restore the confirmation after it.
    setSettingsStatus("Provider tersimpan. Kunci tidak pernah ditampilkan kembali.", "ok");
  } catch (e) {
    st.className = "status-line error";
    st.textContent = "Gagal menyimpan: " + errText(e);
  }
}

// ---- 2. Model per peran (2 tier) ----

/**
 * Tier dropdowns + global model, populated from the ACTIVE provider's
 * /models. Role labels come from core listRoles() via
 * GET /captain/model-roles. Every change auto-saves to
 * settings.modelRoles (PUT /settings).
 */
async function loadModelSection(settingsData) {
  let roles = [];
  let tierLabels = { strong: "🧠 Kuat", light: "⚡ Ringan" };
  try {
    const data = await state.api.captainModelRoles();
    roles = data.roles ?? [];
    for (const tl of data.tiers ?? []) tierLabels[tl.tier] = tl.label;
  } catch {
    /* labels fall back to the built-ins above */
  }
  const byTier = { strong: [], light: [] };
  for (const r of roles) if (byTier[r.tier]) byTier[r.tier].push(r.label);
  const hint = (labels) => (labels.length ? "— " + labels.slice(0, 4).join(", ") + (labels.length > 4 ? ", …" : "") : "");
  $("set-strong-roles").textContent = hint(byTier.strong);
  $("set-light-roles").textContent = hint(byTier.light);

  const stored = settingsData?.settings?.modelRoles ?? {};
  const globalInput = $("set-model-global");
  globalInput.value = stored.default ?? settingsData?.settings?.llm?.model ?? settingsData?.session?.model ?? "";

  // Model options from the active provider.
  const providerId = state.activeProviderId;
  const strongSel = $("set-model-strong");
  const lightSel = $("set-model-light");
  const list = $("set-model-list");
  // Inputs: clear value (datalist options rebuilt below).
  for (const el of [strongSel, lightSel]) if (el) el.value = "";
  if (list) list.innerHTML = "";
  state.modelsVision = { loaded: false, set: new Set() };
  if (providerId) {
    try {
      const data = await state.api.getModels(providerId);
      const models = (data.models ?? []).map((m) => m.model).filter(Boolean);
      const vision = new Set();
      for (const m of data.models ?? []) if (m.supportsVision && m.model) vision.add(m.model);
      state.modelsVision = { loaded: true, set: vision };
      for (const m of models) {
        const o = document.createElement("option");
        o.value = m;
        if (list) list.appendChild(o.cloneNode());
      }
    } catch {
      /* suggestions are best-effort; the inputs stay usable regardless */
    }
  }
  // Tier inputs: text + datalist (bisa ketik manual jika daftar kosong).
  const strongVal = (stored.strong ?? "").trim();
  const lightVal = (stored.light ?? "").trim();
  strongSel.value = strongVal;
  lightSel.value = lightVal;
  updateAttachVisionWarn();
}

function readModelRolesForm() {
  return {
    default: ($("set-model-global").value ?? "").trim(),
    strong: ($("set-model-strong").value ?? "").trim(),
    light: ($("set-model-light").value ?? "").trim(),
  };
}

async function saveModelRoles() {
  try {
    await state.api.updateSettings({ modelRoles: readModelRolesForm() });
    flashSaved();
  } catch (e) {
    setSettingsStatus("Gagal menyimpan model: " + errText(e), "error");
  }
}

// ---- 3. Pill ----

function loadPillSection() {
  const pos = $("set-pill-position");
  if (pos) pos.value = state.prefs.island_corner ?? "top-center";
  const mode = state.pill?.getNotificationMode() ?? "pulse";
  const radio = document.querySelector(`input[name="pill-notify"][value="${mode}"]`);
  if (radio) radio.checked = true;
  const dnd = $("set-pill-dnd");
  if (dnd) dnd.checked = state.pill?.isDoNotDisturb() === true;
}

/**
 * Move the island to a screen corner for real (Rust `position_island` —
 * also persists the pref). Falls back to persisting the pref only when
 * the backend command is unavailable (plain-browser dev).
 */
async function setPillPosition(corner) {
  state.prefs = { ...state.prefs, island_corner: corner };
  try {
    await invoke("position_island", { corner, expanded: state.expanded === true });
  } catch {
    await invoke("set_prefs", { prefs: state.prefs });
  }
  flashSaved();
}

function setNotifyMode(mode) {
  try {
    state.pill?.setNotificationMode(mode);
    state.prefs = { ...state.prefs, notify_mode: mode };
    invoke("set_prefs", { prefs: state.prefs }).catch(() => {});
    flashSaved();
  } catch (e) {
    setSettingsStatus("Gagal: " + errText(e), "error");
  }
}

function setPillDnd(on) {
  // Wired straight into Fase 6's PillController: approvals stay queued,
  // the pill stays quiet (no pulse, no auto-expand).
  state.pill?.setDoNotDisturb(on === true);
  flashSaved();
}

// ---- 4. Approval: radio auto/tanya per jenis ----

const APPROVAL_TYPE_ROWS = [
  ["newFile", "📄 File baru", "file yang belum ada — dibuat baru"],
  ["modifyFile", "✏️ Ubah / hapus file", "file existing yang diubah atau dihapus"],
  ["command", "⌨️ Jalankan perintah", "perintah terminal (run_command)"],
];

function renderApprovalTypes(current) {
  const box = $("set-approval-types");
  if (!box) return;
  box.innerHTML = "";
  for (const [key, label, sub] of APPROVAL_TYPE_ROWS) {
    const row = document.createElement("div");
    row.className = "approval-row";
    const lab = document.createElement("span");
    lab.className = "approval-label";
    lab.innerHTML = `${label}<span class="conf">${escapeHtml(sub)}</span>`;
    const radios = document.createElement("span");
    radios.className = "approval-radios";
    for (const val of ["auto", "ask"]) {
      const l = document.createElement("label");
      l.className = "radio";
      const input = document.createElement("input");
      input.type = "radio";
      input.name = `approval-${key}`;
      input.value = val;
      input.checked = (current?.[key] ?? "ask") === val;
      input.onchange = () => saveApprovalTypes();
      l.append(input, document.createTextNode(val === "auto" ? "Auto" : "Tanya"));
      radios.appendChild(l);
    }
    row.append(lab, radios);
    box.appendChild(row);
  }
}

function readApprovalTypes() {
  const out = {};
  for (const [key] of APPROVAL_TYPE_ROWS) {
    const sel = document.querySelector(`input[name="approval-${key}"]:checked`);
    out[key] = sel?.value === "auto" ? "auto" : "ask";
  }
  return out;
}

/**
 * Persist per-type prefs. The legacy global auto-approve goes OFF when a
 * per-type choice is made — the types are the source of truth from here.
 * The server applies them in the runner's harness policyFor (real effect:
 * new-file writes skip the card when "auto", modify/delete and commands
 * ask when "tanya").
 */
async function saveApprovalTypes() {
  try {
    await state.api.updateSettings({ session: { autoApprove: false }, approvalTypes: readApprovalTypes() });
    state.prefs = { ...state.prefs, auto_approve: false };
    invoke("set_prefs", { prefs: state.prefs }).catch(() => {});
    flashSaved();
  } catch (e) {
    setSettingsStatus("Gagal menyimpan approval: " + errText(e), "error");
  }
}

/** Quick presets: all-ask / all-auto (the old global buttons, kept honest). */
async function setApprovalPreset(all) {
  const types = { newFile: all, modifyFile: all, command: all };
  renderApprovalTypes(types);
  try {
    await state.api.updateSettings({ session: { autoApprove: all === "auto" }, approvalTypes: types });
    state.prefs = { ...state.prefs, auto_approve: all === "auto" };
    invoke("set_prefs", { prefs: state.prefs }).catch(() => {});
    flashSaved();
  } catch (e) {
    setSettingsStatus("Gagal: " + errText(e), "error");
  }
}

// ---- 5. Memori ----

/** "Apa yang kamu ingat tentang saya?" — everything, via GET /captain/memory. */
async function showMemories() {
  const box = $("set-memory-list");
  if (!box) return;
  box.innerHTML = `<p class="hint">Memuat…</p>`;
  try {
    const data = await state.api.captainMemory();
    renderMemories(box, data.memories ?? {});
  } catch (e) {
    box.innerHTML = `<p class="status-line error">Gagal memuat memori: ${escapeHtml(errText(e))}</p>`;
  }
}

function renderMemories(box, m) {
  box.innerHTML = "";
  const groups = [
    ["Preferensi", Object.entries(m.preferences ?? {})],
    ["Fakta", Object.entries(m.facts ?? {})],
    ["Pola koreksi", (m.patterns ?? []).map((p) => [`${p.kind}: ${p.pattern}`, p.value])],
  ];
  let any = false;
  for (const [title, entries] of groups) {
    if (!entries.length) continue;
    any = true;
    const h = document.createElement("h4");
    h.className = "memory-group";
    h.textContent = title;
    box.appendChild(h);
    for (const [k, v] of entries) {
      const row = document.createElement("div");
      row.className = "memory-row";
      const key = document.createElement("span");
      key.className = "memory-key";
      key.textContent = k;
      const val = document.createElement("span");
      val.className = "memory-val";
      val.textContent = typeof v === "string" ? v : JSON.stringify(v);
      row.append(key, val);
      box.appendChild(row);
    }
  }
  if (!any) box.innerHTML = `<p class="hint">Belum ada yang diingat.</p>`;
}

/** "Hapus semua" — two-step confirm, then DELETE /captain/memory for real. */
async function clearMemories(btn) {
  if (btn?.dataset.armed !== "1") {
    if (btn) {
      btn.dataset.armed = "1";
      const old = btn.textContent;
      btn.textContent = "Yakin hapus semua? Klik lagi.";
      setTimeout(() => {
        if (btn.dataset.armed === "1") {
          btn.dataset.armed = "";
          btn.textContent = old;
        }
      }, 5000);
    }
    return;
  }
  if (btn) {
    btn.dataset.armed = "";
    btn.textContent = t("set.memoryClear");
  }
  try {
    await state.api.captainForgetMemory();
    const box = $("set-memory-list");
    if (box) box.innerHTML = `<p class="hint">Memori dihapus.</p>`;
    flashSaved();
  } catch (e) {
    setSettingsStatus("Gagal menghapus memori: " + errText(e), "error");
  }
}

// ---- 6. Pengingat (read-only list + cancel; creation stays in chat) ----

async function loadReminderSection() {
  const box = $("set-reminder-list");
  if (!box) return;
  box.innerHTML = `<p class="hint">Memuat…</p>`;
  try {
    const data = await state.api.captainReminders();
    const list = data.reminders ?? [];
    box.innerHTML = "";
    if (!list.length) {
      box.innerHTML = `<p class="hint">Tidak ada pengingat aktif. Buat lewat chat: "ingatkan saya …"</p>`;
      return;
    }
    for (const r of list) {
      const row = document.createElement("div");
      row.className = "reminder-row";
      const msg = document.createElement("span");
      msg.className = "reminder-msg";
      msg.textContent = `⏰ ${r.message}`;
      const when = document.createElement("span");
      when.className = "conf";
      let whenText = "";
      try {
        whenText = new Date(r.deliverAt).toLocaleString("id-ID");
      } catch {
        whenText = String(r.deliverAt);
      }
      when.textContent = whenText + (r.repeat ? ` · ${r.repeat}` : "");
      const btn = document.createElement("button");
      btn.className = "ghost-btn small";
      btn.textContent = "Batalkan";
      btn.onclick = async () => {
        try {
          await state.api.captainCancelReminder(r.id);
          flashSaved();
          await loadReminderSection();
        } catch (e) {
          setSettingsStatus("Gagal membatalkan: " + errText(e), "error");
        }
      };
      row.append(msg, when, btn);
      box.appendChild(row);
    }
  } catch (e) {
    box.innerHTML = `<p class="status-line error">Gagal memuat pengingat: ${escapeHtml(errText(e))}</p>`;
  }
}

// ---- 7. Umum ----

function loadGeneralSection(settingsData) {
  const lang = $("set-language");
  if (lang) lang.value = state.prefs.language ?? "id";
  const theme = $("set-theme");
  if (theme) theme.value = state.prefs.theme ?? "dark";
  const thinking = settingsData?.session?.thinkingLevel ?? settingsData?.settings?.session?.thinkingLevel ?? "medium";
  const thinkSel = $("set-thinking");
  if (thinkSel) thinkSel.value = ["off", "low", "medium", "high"].includes(thinking) ? thinking : "medium";
  const temp = settingsData?.settings?.llm?.temperature;
  const tempInput = $("set-temperature");
  if (tempInput) tempInput.value = typeof temp === "number" ? String(temp) : "";
}

async function setLanguage(lang) {
  state.prefs = { ...state.prefs, language: lang };
  try {
    await invoke("set_prefs", { prefs: state.prefs });
  } catch {
    /* non-Tauri: language still applies to this session */
  }
  applyLanguage(lang);
  flashSaved();
}

async function setTheme(theme) {
  state.prefs = { ...state.prefs, theme };
  try {
    await invoke("set_prefs", { prefs: state.prefs });
  } catch {
    /* non-Tauri: theme still applies to this session */
  }
  applyTheme(theme);
  flashSaved();
}

async function saveThinking() {
  try {
    await state.api.updateSettings({ session: { thinkingLevel: $("set-thinking").value } });
    flashSaved();
  } catch (e) {
    setSettingsStatus("Gagal: " + errText(e), "error");
  }
}

let tempSaveTimer = null;
function saveTemperatureSoon() {
  clearTimeout(tempSaveTimer);
  tempSaveTimer = setTimeout(async () => {
    const raw = ($("set-temperature").value ?? "").trim();
    try {
      if (raw === "") {
        setSettingsStatus("Isi 0–2, atau biarkan kosong untuk default.", "");
        return;
      }
      const num = Number(raw);
      if (!Number.isFinite(num) || num < 0 || num > 2) throw new Error("temperature harus 0–2");
      await state.api.updateSettings({ llm: { temperature: num } });
      flashSaved();
    } catch (e) {
      setSettingsStatus("Gagal: " + errText(e), "error");
    }
  }, 600);
}

// ---- 8. Engine aktif (existing — kept) ----

/** Agentic Systems toggles — persisted to Tauri prefs AND the live server. */
async function loadEngineToggles() {
  const box = $("engine-toggles");
  if (!box) return;
  box.innerHTML = "";
  const disabled = state.prefs.disabled_engines ?? [];
  for (const e of ENGINES) {
    const on = !disabled.includes(e);
    const row = document.createElement("div");
    row.className = "engine-toggle-row";
    row.innerHTML = `<span class="wf-engine">${escapeHtml(engineLabel(e))}</span>`;
    const btn = document.createElement("button");
    btn.className = "toggle " + (on ? "on" : "off");
    btn.textContent = on ? "On" : "Off";
    btn.setAttribute("aria-label", `${engineLabel(e)} ${on ? "aktif" : "nonaktif"}`);
    btn.onclick = () => setEngineEnabled(e, !on);
    row.appendChild(btn);
    box.appendChild(row);
  }
}

async function setEngineEnabled(engine, enabled) {
  const status = $("set-status");
  let disabled = [...(state.prefs.disabled_engines ?? [])];
  if (enabled) {
    disabled = disabled.filter((e) => e !== engine);
  } else {
    if (!canDisableEngine(engine, disabled)) {
      status.className = "status-line error";
      status.textContent = "Tidak bisa menonaktifkan engine terakhir — minimal satu harus aktif.";
      return;
    }
    disabled.push(engine);
  }
  try {
    state.prefs = { ...state.prefs, disabled_engines: disabled };
    await invoke("set_prefs", { prefs: state.prefs });
    // Server-side too: the router must skip disabled engines (additive API).
    await state.api.updateSettings({ session: { disabledEngines: disabled } });
    // A picked override for a now-disabled engine is no longer valid.
    if (!enabled && state.engineOverride === engine) state.engineOverride = null;
    flashSaved();
    loadEngineToggles();
    renderEngineChips();
  } catch (e) {
    status.className = "status-line error";
    status.textContent = "Gagal: " + errText(e);
  }
}

/** Push persisted engine toggles to a freshly (re)started server. */
async function pushDisabledEngines() {
  const disabled = state.prefs.disabled_engines ?? [];
  if (!disabled.length) return;
  try {
    await state.api.updateSettings({ session: { disabledEngines: disabled } });
  } catch { /* server restart pick-up; non-fatal */ }
}

/** Warn when a queued image meets a model known to lack vision. */
function updateAttachVisionWarn() {
  const warn = $("attach-warn");
  if (!warn) return;
  const hasImage = state.pendingAttachments.some((a) => a.kind === "image");
  const model = ($("set-model-global")?.value ?? "").trim() || null;
  const known = state.modelsVision.loaded && model;
  if (hasImage && known && !state.modelsVision.set.has(model)) {
    warn.textContent = `Model ${model} tampaknya tidak mendukung gambar — jawaban bisa gagal.`;
    warn.classList.remove("hidden");
  } else {
    warn.textContent = "";
    warn.classList.add("hidden");
  }
}

async function openWebUI() {
  try {
    await invoke("open_web", { url: state.serverUrl });
  } catch (e) {
    // fallback jujur: tampilkan URL-nya
    state.transcript.push({ kind: "error", text: "Tidak bisa membuka browser otomatis — buka manual: " + state.serverUrl });
    renderTranscript();
  }
}

// ---------------------------------------------------------------------------
// Workspace (Dae Captain v2 Fase 8) — secondary file browser per the mockup:
// search, active path + Ganti, 🕐 Terbaru (✨ = from Dae Captain), tree with
// git badges, click → overlay preview. No delete/rename here, ever.
// ---------------------------------------------------------------------------

let wsFlatFiles = null; // [{path, type}] from GET /workspace/files
let wsTreeNodes = null; // nested tree built from wsFlatFiles
let wsRecentFiles = null; // [{path, mtimeMs, size}] from GET /workspace/recent
let wsGitMap = null; // path -> git status kind
let wsGitBranch = null;
let wsGitIsRepo = false;
let wsSearchQuery = "";
const wsOpenDirs = new Set();

/** Relative time in Indonesian: "10 mnt lalu", "2 jam lalu", "3 hri lalu". */
function relTime(mtimeMs) {
  const mins = Math.max(0, Math.round((Date.now() - mtimeMs) / 60000));
  if (mins < 1) return "baru saja";
  if (mins < 60) return `${mins} mnt lalu`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours} jam lalu`;
  return `${Math.floor(hours / 24)} hri lalu`;
}

async function loadWorkspaceView() {
  const root = state.workspaceRoot;
  const pathEl = $("ws-path");
  if (pathEl) pathEl.value = root ?? "";
  await renderWorkspaceHealth();
  const treeBox = $("ws-tree");
  const recentBox = $("ws-recent-list");
  if (!root) {
    if (treeBox) treeBox.innerHTML = `<p class="hint">Pilih workspace dulu.</p>`;
    if (recentBox) recentBox.innerHTML = "";
    return;
  }
  if (treeBox) treeBox.innerHTML = `<p class="hint">Memuat…</p>`;
  if (recentBox) recentBox.innerHTML = `<p class="hint">Memuat…</p>`;
  try {
    const [flat, recent, git] = await Promise.all([
      state.api.workspaceFiles(root).catch((e) => { throw new Error("daftar file: " + errText(e)); }),
      state.api.workspaceRecent(root, 24).catch(() => ({ files: [] })),
      state.api.workspaceGitStatus(root).catch(() => null),
    ]);
    wsFlatFiles = flat.files ?? [];
    wsRecentFiles = recent.files ?? [];
    wsGitIsRepo = git?.isRepo === true;
    wsGitBranch = git?.branch ?? null;
    wsGitMap = new Map();
    if (wsGitIsRepo) {
      for (const f of git.files ?? []) wsGitMap.set(f.path, f.status);
    }
    // ✨ markers: file events from the current run's timeline (Dae Captain's
    // own writes), fetched whole — not just the poll cursor.
    if (state.runId) {
      try {
        const tl = await state.api.captainTimeline(state.runId, root);
        for (const e of tl?.events ?? []) {
          if (e?.type === "file" && e.payload?.path) state.captainFilePaths.add(e.payload.path);
        }
      } catch {
        /* timeline unavailable — recent list still renders, without ✨ */
      }
    }
    wsTreeNodes = buildWsTree(wsFlatFiles);
    renderWorkspaceTree();
    renderRecentList();
    renderWsGitHead();
  } catch (e) {
    const msg = `<p class="status-line error">Gagal memuat workspace: ${escapeHtml(errText(e))}</p>`;
    if (treeBox) treeBox.innerHTML = msg;
    if (recentBox) recentBox.innerHTML = "";
  }
}

/** Build a sorted nested tree (dirs first) from the flat file index. */
function buildWsTree(files) {
  const root = { name: "", path: "", type: "dir", children: [] };
  for (const f of files ?? []) {
    const parts = f.path.split("/");
    let node = root;
    for (let i = 0; i < parts.length; i++) {
      const isLast = i === parts.length - 1;
      const partPath = parts.slice(0, i + 1).join("/");
      let child = node.children.find((c) => c.name === parts[i]);
      if (!child) {
        child = { name: parts[i], path: partPath, type: isLast ? f.type : "dir", children: [] };
        node.children.push(child);
      }
      node = child;
    }
  }
  const sort = (n) => {
    n.children.sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name) : a.type === "dir" ? -1 : 1));
    n.children.forEach(sort);
  };
  sort(root);
  return root.children;
}

function gitBadge(path) {
  const kind = wsGitMap?.get(path);
  if (!kind) return "";
  if (kind === "untracked") return `<span class="git-u" title="untracked">+</span>`;
  return `<span class="git-m" title="${escapeHtml(kind)}">●</span>`;
}

function wsFileRow(path, depth) {
  const row = document.createElement("div");
  row.className = "ws-item ws-file";
  row.style.paddingLeft = `${12 + depth * 18}px`;
  const name = path.split("/").pop() ?? path;
  row.innerHTML =
    `<span class="ws-file-icon">📄</span> ` +
    `<span class="ws-file-name">${escapeHtml(name)}</span>` +
    gitBadge(path);
  row.title = path;
  row.onclick = () => previewWorkspaceFile(path);
  return row;
}

function renderWsNode(node, depth) {
  if (node.type !== "dir") return wsFileRow(node.path, depth);
  const wrap = document.createElement("div");
  const head = document.createElement("div");
  head.className = "ws-item ws-dir";
  head.style.paddingLeft = `${12 + depth * 18}px`;
  const open = wsOpenDirs.has(node.path);
  head.innerHTML = `<span class="ws-caret">${open ? "▾" : "▸"}</span> <span class="ws-file-icon">📁</span> <span class="ws-file-name">${escapeHtml(node.name)}/</span>`;
  head.title = node.path;
  head.onclick = () => {
    if (wsOpenDirs.has(node.path)) wsOpenDirs.delete(node.path);
    else wsOpenDirs.add(node.path);
    renderWorkspaceTree();
  };
  wrap.appendChild(head);
  if (open) for (const c of node.children) wrap.appendChild(renderWsNode(c, depth + 1));
  return wrap;
}

/** Tree, filtered live by the search box. With a query: flat matches. */
function renderWorkspaceTree() {
  const box = $("ws-tree");
  if (!box) return;
  box.innerHTML = "";
  const q = wsSearchQuery.trim().toLowerCase();
  if (q) {
    const matches = (wsFlatFiles ?? []).filter((f) => f.type === "file" && f.path.toLowerCase().includes(q));
    if (!matches.length) {
      box.innerHTML = `<p class="hint">Tidak ada file yang cocok dengan "${escapeHtml(wsSearchQuery.trim())}".</p>`;
      return;
    }
    const shown = matches.slice(0, 200);
    for (const f of shown) box.appendChild(wsFileRow(f.path, 0));
    if (matches.length > shown.length) {
      const more = document.createElement("p");
      more.className = "hint";
      more.textContent = `…dan ${matches.length - shown.length} lainnya.`;
      box.appendChild(more);
    }
    return;
  }
  const nodes = wsTreeNodes ?? [];
  if (!nodes.length) {
    box.innerHTML = `<p class="hint">Workspace kosong.</p>`;
    return;
  }
  for (const n of nodes) box.appendChild(renderWsNode(n, 0));
}

/** 🕐 Terbaru: files changed today, newest first; ✨ = written by Dae Captain. */
function renderRecentList() {
  const box = $("ws-recent-list");
  if (!box) return;
  box.innerHTML = "";
  const files = wsRecentFiles ?? [];
  if (!files.length) {
    box.innerHTML = `<p class="hint">Belum ada file yang diubah hari ini.</p>`;
    return;
  }
  for (const f of files.slice(0, 12)) {
    const row = document.createElement("div");
    row.className = "ws-item ws-file";
    const name = f.path.split("/").pop() ?? f.path;
    const star = state.captainFilePaths.has(f.path)
      ? `<span class="tag-cap" title="Ditulis oleh Dae Captain">✨</span>`
      : "";
    row.innerHTML =
      `<span class="ws-file-icon">📄</span> ` +
      `<span class="ws-file-name">${escapeHtml(name)}</span>` +
      star +
      `<span class="meta">${escapeHtml(relTime(f.mtimeMs))}</span>`;
    row.title = f.path;
    row.onclick = () => previewWorkspaceFile(f.path);
    box.appendChild(row);
  }
}

/** Git head: branch + changed-file count, or nothing outside a repo. */
function renderWsGitHead() {
  const el = $("ws-git");
  if (!el) return;
  if (!wsGitIsRepo) {
    el.textContent = "";
    return;
  }
  const n = wsGitMap?.size ?? 0;
  el.textContent = n ? `⎇ ${wsGitBranch ?? "?"} · ${n} berubah` : `⎇ ${wsGitBranch ?? "?"}`;
}

/**
 * Click a file → overlay preview (never a new page). Reuses the Fase 7
 * preview overlay: images/pdf embed, md/csv/text render inline, office
 * files get the honest download fallback (the Fase 7 renderers are
 * deck/workbook-specific, so they must NOT run on arbitrary files).
 */
function previewWorkspaceFile(path) {
  const ext = (path.split(".").pop() ?? "").toLowerCase();
  const name = path.split("/").pop() ?? path;
  let kind = "other";
  if (["png", "jpg", "jpeg", "gif", "webp"].includes(ext)) kind = ext;
  else if (ext === "pdf") kind = "pdf";
  else if (ext === "csv") kind = "csv";
  else if (ext === "md") kind = "md";
  else if (["txt", "json", "bib", "log", "yaml", "yml", "toml", "xml", "html", "css", "js", "ts", "tsx", "jsx", "py", "rs", "go", "sh", "sql", "mdx"].includes(ext)) kind = "txt";
  openPreviewOverlay({ kind, path, name });
}

/**
 * Real workspace status: is the folder valid, and is the server actually
 * anchored to it (via server_health.workspace_root from PR #102)?
 */
async function renderWorkspaceHealth() {
  const el = $("ws-health");
  if (!el) return;
  el.className = "status-line";
  el.textContent = "Mengecek…";
  const path = state.workspaceRoot;
  if (!path) {
    el.textContent = "Belum ada workspace dipilih.";
    return;
  }
  const valid = await invoke("validate_workspace", { path }).catch(() => false);
  if (!valid) {
    el.className = "status-line error";
    el.textContent = "● Folder tidak valid: " + path;
    return;
  }
  const health = await invoke("server_health").catch(() => null);
  if (health?.healthy && health.workspace_root && sameWorkspace(health.workspace_root, path)) {
    el.className = "status-line ok";
    el.textContent = "● Aktif — server melayani workspace ini.";
  } else if (health?.healthy && health.workspace_root) {
    el.className = "status-line error";
    el.textContent = `● Folder valid, tapi server melayani workspace lain (${health.workspace_root}). Klik "Ganti" untuk re-anchor.`;
  } else {
    el.className = "status-line";
    el.textContent = "● Folder valid — server belum jalan.";
  }
}

async function setWorkspace(path) {
  const status = $("ws-status");
  try {
    const ok = await invoke("validate_workspace", { path });
    if (!ok) {
      status.className = "status-line error";
      status.textContent = "Bukan folder yang valid: " + path;
      return;
    }
    state.workspaceRoot = path;
    const recent = [path, ...(state.prefs.recent_workspaces ?? []).filter((w) => w !== path)].slice(0, 8);
    state.prefs = { ...state.prefs, workspace_root: path, recent_workspaces: recent };
    await invoke("set_prefs", { prefs: state.prefs });
    state.seenEvents.clear(); // new workspace = new event history
    state.wsSubscribed = false;
    state.approvalOpen = false;
    state.captainFilePaths.clear();
    wsOpenDirs.clear();
    wsSearchQuery = "";
    const searchEl = $("ws-search");
    if (searchEl) searchEl.value = "";
    const serverOk = await ensureServer((t, e) => {
      status.className = "status-line" + (e ? " error" : "");
      status.textContent = t;
    });
    if (!serverOk) {
      return;
    }
    status.className = "status-line ok";
    status.textContent = "Workspace aktif: " + path;
    await loadWorkspaceView();
    await refreshRuns();
    // Retry a work command that was waiting for a workspace.
    if (state.pendingMessage) {
      const msg = state.pendingMessage;
      const ov = state.pendingOverride;
      const atts = state.pendingAttachments ?? [];
      state.pendingMessage = null;
      state.pendingOverride = null;
      state.pendingAttachments = [];
      state.pendingAttachments.push(...atts);
      showView("main");
      await sendChat(msg, ov);
    }
  } catch (e) {
    status.className = "status-line error";
    status.textContent = "Gagal: " + errText(e);
  }
}


// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

function bootStatus(text, isError = false) {
  const el = $("boot-status");
  el.textContent = text;
  el.className = "status-line" + (isError ? " error" : "");
}

/**
 * Ensure a server is up AND anchored to state.workspaceRoot.
 * A healthy server anchored elsewhere answers chat with HTTP 403, so:
 * our sidecar gets respawned for the new workspace, a foreign server gets
 * a clear instruction instead of silent breakage.
 * Returns true when the server is usable.
 */
async function ensureServer(statusFn) {
  let health = await invoke("server_health").catch(() => ({ healthy: false, url: "" }));
  state.serverUrl = health.url || state.serverUrl;
  if (
    health.healthy &&
    health.workspace_root &&
    !sameWorkspace(health.workspace_root, state.workspaceRoot)
  ) {
    const managed = await invoke("server_managed").catch(() => false);
    if (!managed) {
      statusFn(
        "Port 3080 dipakai server Daedalus lain (workspace: " + health.workspace_root + "). Jalankan `daedalus stop`, lalu restart aplikasi.",
        true,
      );
      return false;
    }
    statusFn("Workspace berubah — me-restart server…");
    await invoke("stop_server").catch(() => {});
    await new Promise((r) => setTimeout(r, 800));
    health = { healthy: false, url: state.serverUrl };
  }
  if (!health.healthy) {
    statusFn("Server belum jalan — menjalankan sebagai sidecar…");
    try {
      const info = await invoke("spawn_server", spawnServerArgs(state.prefs.repo_root, state.workspaceRoot));
      state.serverUrl = info.url;
      statusFn(info.started ? `Server jalan (pid ${info.pid}).` : "Server sudah jalan.");
    } catch (e) {
      statusFn("Gagal menjalankan server: " + errText(e), true);
      return false;
    }
  }
  return true;
}

async function boot() {
  showView("boot");
  expand();
  $("boot-title").textContent = "Menyiapkan Dae Captain…";

  let prefs;
  try {
    prefs = await invoke("get_prefs");
  } catch (e) {
    bootStatus("Gagal membaca preferensi: " + errText(e) + " — pastikan berjalan di aplikasi Tauri.", true);
    return;
  }
  state.prefs = prefs;
  // Dae Captain v2 Fase 8: apply saved theme + language before anything renders.
  applyTheme(prefs.theme);
  applyLanguage(prefs.language);

  if (!prefs.repo_root) {
    showView("setup");
    return;
  }
  const repoOk = await invoke("validate_repo_root", { path: prefs.repo_root }).catch(() => false);
  if (!repoOk) {
    $("setup-repo").value = prefs.repo_root;
    $("setup-ws").value = prefs.workspace_root;
    bootStatus("");
    showView("setup");
    $("setup-status").textContent = "Repo root tidak valid — perbaiki di bawah.";
    $("setup-status").className = "status-line error";
    return;
  }

  state.workspaceRoot = prefs.workspace_root || "";
  // Workspace is on-demand: boot to chat even without one. The server asks
  // for a folder (kind: "need_workspace") only when a work command arrives.

  bootStatus("Mengecek node…");
  const nodeOk = await invoke("node_available").catch(() => false);
  if (!nodeOk) {
    bootStatus("node tidak ditemukan di PATH — install Node.js dulu, lalu restart aplikasi.", true);
    return;
  }

  bootStatus("Menghubungi server…");
  const serverOk = await ensureServer((t, e) => bootStatus(t, e));
  if (!serverOk) return;

  state.api = createApiClient({
    baseUrl: state.serverUrl,
    getToken: () => invoke("daemon_token", { workspace: state.workspaceRoot || null }).catch(() => null),
  });
  // WebSocket event stream for live task updates (replaces polling).
  state.eventStream = createEventStream({
    getWsUrl: () => state.serverUrl.replace(/^http/, "ws") + "/tasks/events",
    onEvents: handleTaskEvents,
    onConnect: () => { state.connected = true; renderPill(); renderHeaderStatus(); },
    onDisconnect: () => { state.connected = false; renderPill(); renderHeaderStatus(); },
  });
  // HTTP polling fallback if WebSocket unavailable. The wildcard WS
  // subscription covers all turns, so the fallback polls the latest
  // running chat turn directly (taskId arg is ignored).
  state.eventStream.setPollFn(async (_taskId, sinceSeq) => {
    const turn = [...state.transcript].reverse().find(
      (m) => m.kind === "turn" && m.taskId && !m.activityDone
    );
    if (!turn) return [];
    try {
      const data = await state.api.taskEvents(turn.taskId);
      const events = data.events ?? [];
      return sinceSeq ? events.filter((e) => (e.seq ?? 0) > sinceSeq) : events;
    } catch {
      return [];
    }
  });
  state.eventStream.subscribe("*");
  state.wsSubscribed = true;
  try {
    await state.api.health();
  } catch (e) {
    bootStatus("Server tidak menjawab di " + state.serverUrl + ": " + errText(e), true);
    return;
  }
  // Persisted engine toggles survive app restarts (Tauri prefs) but the
  // server is process-local — push them to every freshly booted server.
  await pushDisabledEngines();

  bootStatus("Siap.");
  showView("main");
  // Fresh conversation by default: the transcript is memory-only and runId
  // is never restored from prefs, so reopening the app never resumes an
  // old session, resubmits a task, or injects old history into the model.
  // refreshRuns() below only loads MONITORING state (past runs stay visible
  // in Antrean / /history; vanished tasks reconcile as failed, never restart).
  // Use /history + /resume to explicitly reopen a previous session.
  if (!state.transcript.length) {
    state.transcript.push({
      kind: "assistant",
      text: "Halo! Ada yang bisa kubantu? Kirim perintah — aku teruskan ke engine yang tepat (Coding, Slide, Dokumen, Spreadsheet, Research).",
    });
  }
  renderEngineChips();
  renderTranscript();
  renderHeaderStatus();
  await refreshRuns();
  // Runs list: WebSocket events are primary (via refreshRunsQuiet);
  // adaptive polling: 2s saat ada task berjalan, 10s saat idle.
  // Ini safety net untuk event yang terlewat + update pill yang responsif.
  setInterval(async () => {
    const hasRunning = (state.runs ?? []).some((r) =>
      (r.turns ?? []).some((t) => t?.status === "running")
    );
    await refreshRuns();
    // Jika ada yang berjalan, poll lagi lebih cepat untuk update pill
    if (hasRunning) {
      setTimeout(() => refreshRuns(), 2000);
    }
  }, 10000);
  // A1: Reminder delivery poll — check for fired reminders every 30s.
  setInterval(pollDueReminders, 30_000);
  // Check once shortly after boot too.
  setTimeout(pollDueReminders, 5000);
}

/**
 * A1: Poll for fired reminders. For each: pulse the pill + push a chat
 * message with [Tunda 1 jam] [Selesai] actions.
 */
async function pollDueReminders() {
  try {
    const res = await state.api.captainRemindersDue();
    const due = Array.isArray(res?.reminders) ? res.reminders : [];
    for (const r of due) {
      // Pulse the pill (respects DND).
      try { state.pill?.notifyReminder?.(); } catch { /* ignore */ }
      // Chat message with actions.
      pushAssistant(`⏰ Waktunya: ${r.message}`);
      pushCard("reminder-due", {
        id: r.id,
        message: r.message,
        repeat: r.repeat ?? null,
      }, {});
      renderTranscript();
    }
  } catch {
    /* server down or no reminders — silent */
  }
}

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

function bindEvents() {
  const bindGuarded = (id, evt, fn) => {
    const el = $(id);
    if (!el) return; // HTML/JS drift must never crash boot.
    if (evt === "change") el.onchange = fn;
    else if (evt === "keydown") el.onkeydown = fn;
    else el.onclick = fn;
  };

  // Global hotkey Ctrl+Shift+D (registered in Rust via
  // tauri-plugin-global-shortcut): the backend shows + focuses the window
  // and emits "dae-captain-hotkey"; here we toggle pill <-> chat.
  // A local keydown fallback covers plain-browser dev (non-global).
  const toggleIsland = () => {
    if (state.expanded) collapse();
    else { expand(); showView("main"); }
  };
  listenEvent(window, "dae-captain-hotkey", toggleIsland).catch(() => {
    /* non-Tauri context: the keydown fallback below still works */
  });
  window.addEventListener("keydown", (e) => {
    if (e.ctrlKey && e.shiftKey && (e.key === "D" || e.key === "d") && !e.altKey && !e.metaKey) {
      // In the Tauri app the Rust global shortcut already toggles (via the
      // event above) — the local fallback is for plain-browser dev only.
      if (typeof window.__TAURI_INTERNALS__?.invoke === "function") return;
      // Don't hijack typing in inputs.
      const tag = (e.target?.tagName ?? "").toLowerCase();
      if (tag === "input" || tag === "textarea") return;
      e.preventDefault();
      toggleIsland();
    }
  });

  bindGuarded("btn-collapse", "click", collapse);
  bindGuarded("btn-settings", "click", () => { loadSettingsView(); showView("settings"); });
  bindGuarded("set-back", "click", () => showView("main"));
  // ---- Dae Captain v2 Fase 8: Settings bindings (auto-save, no Save button) ----
  bindGuarded("set-prov-add", "click", () => openProviderForm("add"));
  bindGuarded("prov-test", "click", testProviderForm);
  bindGuarded("prov-save", "click", saveProviderForm);
  bindGuarded("set-model-global", "change", saveModelRoles);
  bindGuarded("set-model-strong", "change", saveModelRoles);
  bindGuarded("set-model-light", "change", saveModelRoles);
  bindGuarded("set-model-global", "input", updateAttachVisionWarn);
  bindGuarded("set-pill-position", "change", (e) => setPillPosition(e.target.value));
  for (const r of document.querySelectorAll('input[name="pill-notify"]')) {
    r.addEventListener("change", (e) => { if (e.target.checked) setNotifyMode(e.target.value); });
  }
  bindGuarded("set-pill-dnd", "change", (e) => setPillDnd(e.target.checked));
  bindGuarded("approve-ask-all", "click", () => setApprovalPreset("ask"));
  bindGuarded("approve-auto-all", "click", () => setApprovalPreset("auto"));
  bindGuarded("set-memory-show", "click", showMemories);
  bindGuarded("set-memory-clear", "click", (e) => clearMemories(e.target));
  bindGuarded("set-language", "change", (e) => setLanguage(e.target.value));
  bindGuarded("set-theme", "change", (e) => setTheme(e.target.value));
  bindGuarded("set-thinking", "change", saveThinking);
  bindGuarded("set-temperature", "change", saveTemperatureSoon);
  // ---- Workspace bindings ----
  bindGuarded("btn-workspace", "click", () => { showView("workspace"); });
  bindGuarded("ws-back", "click", () => showView("main"));
  bindGuarded("ws-change", "click", async () => {
    // Native folder picker (Tauri dialog) — the existing picker, not a new one.
    try {
      const picked = await invoke("pick_folder");
      if (picked) await setWorkspace(picked);
    } catch (e) {
      const st = $("ws-status");
      if (st) {
        st.className = "status-line error";
        st.textContent = "Gagal membuka pemilih folder: " + errText(e);
      }
    }
  });
  const wsSearch = $("ws-search");
  if (wsSearch) {
    wsSearch.addEventListener("input", (e) => {
      wsSearchQuery = e.target.value ?? "";
      renderWorkspaceTree();
    });
  }

  bindGuarded("chat-send", "click", () => sendChat());
  bindGuarded("chat-attach", "click", () => $("chat-file")?.click());
  {
    const fi = $("chat-file");
    fi?.addEventListener("change", () => {
      queuePickedFiles(fi.files);
      fi.value = "";
    });
  }
  bindGuarded("chat-input", "keydown", (e) => {
    // Shift+Enter is always a newline — never a send, never a completion.
    if (e.key === "Enter" && e.shiftKey) return;
    if (slashMenuOpen()) {
      if (e.key === "ArrowDown") { e.preventDefault(); stepSlashMenu(1); return; }
      if (e.key === "ArrowUp") { e.preventDefault(); stepSlashMenu(-1); return; }
      if (e.key === "Escape") { e.preventDefault(); hideSlashMenu(); return; }
      if (e.key === "Tab" || e.key === "Enter") {
        const m = /^\s*\/([a-z]*)$/i.exec($("chat-input")?.value ?? "");
        const list = matchingSlashCommands(m?.[1] ?? "");
        // Tab always completes; Enter completes a partial prefix,
        // and sends only when a full command is already typed.
        if (e.key === "Tab" || (m && m[1] && !list.some((c) => c.name === m[1].toLowerCase()))) {
          e.preventDefault();
          const pick = list[state.slashIndex] ?? list[0];
          if (pick) applySlashCompletion(pick.name);
          return;
        }
      }
    }
    // Plain Enter sends; Shift+Enter keeps its newline (multi-line composer).
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      sendChat();
    }
  });
  // Slash suggestion menu (separate listener so it never clobbers keydown).
  {
    const ci = $("chat-input");
    ci?.addEventListener("input", () => {
      autogrowComposer();
      renderSlashMenu();
    });
    ci?.addEventListener("blur", () => setTimeout(hideSlashMenu, 120));
    ci?.addEventListener("focus", renderSlashMenu);
  }
  // Sticky scroll: track whether the user sits at the bottom. New renders
  // (including stream deltas) only follow when pinned.
  {
    const box = $("transcript");
    box?.addEventListener("scroll", () => {
      state.stick = box.scrollHeight - box.scrollTop - box.clientHeight < 60;
      if (state.stick) $("chat-jump")?.classList.add("hidden");
    });
  }
  bindGuarded("chat-jump", "click", () => {
    state.stick = true;
    const box = $("transcript");
    if (box) box.scrollTop = box.scrollHeight;
    $("chat-jump")?.classList.add("hidden");
  });
  bindGuarded("chat-stop", "click", async () => {
    // A streaming answer stops first (aborts its fetch); task cancel stays
    // one more click away so one press never kills two things at once.
    if (state.streamAbort) {
      state.streamAbort.abort();
      return;
    }
    const turn = [...state.transcript].reverse().find(
      (m) => m.kind === "turn" && m.taskId && !m.activityDone
    );
    if (!turn || !state.api) return;
    try {
      await state.api.cancelTask(turn.taskId);
      state.transcript.push({ kind: "assistant", text: "Task dihentikan." });
    } catch (e) {
      state.transcript.push({ kind: "error", text: "Gagal menghentikan: " + errText(e) });
    }
    renderTranscript();
    updateStopButton();
  });

  bindGuarded("btn-approve-all", "click", approveAll);
  bindGuarded("btn-goto-chat", "click", () => { showView("main"); const ci = $("chat-input"); if (ci) ci.focus(); });
  bindGuarded("btn-goto-workflow", "click", () => showView("workflow"));
  bindGuarded("btn-goto-crew", "click", () => showView("crew"));
  bindGuarded("btn-export", "click", exportCurrentSession);
  bindGuarded("crew-back", "click", () => showView("main"));
  bindGuarded("wf-back", "click", () => showView("main"));
  for (const b of document.querySelectorAll("#wf-filters .filter-chip")) {
    b.onclick = () => { state.wfFilter = b.dataset.filter; renderWorkflowView(); };
  }
  bindGuarded("wf-cancel", "click", cancelWorkflow);

  bindGuarded("setup-save", "click", async () => {
    const status = $("setup-status");
    const repo = $("setup-repo").value.trim();
    const ws = $("setup-ws").value.trim();
    const repoOk = await invoke("validate_repo_root", { path: repo }).catch(() => false);
    const wsOk = await invoke("validate_workspace", { path: ws }).catch(() => false);
    if (!repoOk) { status.className = "status-line error"; status.textContent = "Repo root tidak valid (harus berisi server/src/main.ts dan cli/src/index.ts)."; return; }
    if (!wsOk) { status.className = "status-line error"; status.textContent = "Workspace bukan folder yang valid."; return; }
    state.prefs = { ...state.prefs, repo_root: repo, workspace_root: ws, recent_workspaces: [ws] };
    await invoke("set_prefs", { prefs: state.prefs });
    boot();
  });

  bindGuarded("btn-quit", "click", async () => {
    const managed = await invoke("server_managed").catch(() => false);
    if (!managed) { invoke("quit_app"); return; }
    if (state.prefs.keep_alive === "keep") { invoke("quit_app"); return; }
    if (state.prefs.keep_alive === "stop") { await invoke("stop_server").catch(() => {}); invoke("quit_app"); return; }
    $("quit-dialog").classList.remove("hidden");
  });
  const quitWith = async (keep) => {
    if ($("quit-remember").checked) {
      state.prefs = { ...state.prefs, keep_alive: keep ? "keep" : "stop" };
      await invoke("set_prefs", { prefs: state.prefs }).catch(() => {});
    }
    if (!keep) await invoke("stop_server").catch(() => {});
    invoke("quit_app");
  };
  bindGuarded("quit-keep", "click", () => quitWith(true));
  bindGuarded("quit-stop", "click", () => quitWith(false));
}

bindEvents();
boot();
