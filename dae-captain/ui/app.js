// Dae Captain island — DOM wiring. Pure DOM + Tauri invoke bridge.
// All server communication goes through api.js; all decisions through logic.js.

import { createApiClient } from "./api.js";
import { createEventStream } from "./events.js";
import { createInvoker, WINDOW_SET_SIZE_CMD, setSizePayload } from "./bridge.js";
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
  if (name === "workspace") { renderWorkspaceStatus(); }
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
}

function collapse() {
  if (!state.expanded) return;
  state.expanded = false;
  $("panel").classList.add("hidden");
  $("pill").classList.remove("hidden");
  setWindowSize(COMPACT.w, COMPACT.h);
}

// ---------------------------------------------------------------------------
// Pill + engine pills + approvals rendering
// ---------------------------------------------------------------------------

function renderPill() {
  const agg = aggregateStatus(state.runs);
  const pill = $("pill");
  if (!pill) return;
  pill.className = "pill status-" + statusColor(agg.status);
  const label = $("pill-text");
  if (!label) return;
  // Pill and main window share the SAME state.runs (one task state).
  // Connection is explicit — never a fake idle pill while disconnected.
  if (!state.connected && agg.status === "idle") {
    label.textContent = "offline";
    pill.setAttribute("aria-label", "Dae Captain — terputus, klik untuk membuka");
  } else {
    label.textContent = activityLabel(state.runs, agg);
    pill.setAttribute("aria-label", agg.status === "attention"
      ? "Dae Captain — butuh persetujuan, klik untuk membuka"
      : agg.status === "working"
        ? "Dae Captain — " + activityLabel(state.runs, agg) + ", klik untuk membuka"
        : "Dae Captain — klik untuk membuka");
  }
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
  if (thoughts.length) {
    const det = document.createElement("details");
    det.className = "thinking";
    det.open = true;
    const sum = document.createElement("summary");
    sum.className = "thinking-header";
    sum.textContent = `THINKING · ${steps} langkah`;
    det.appendChild(sum);
    for (const t of thoughts.slice(-3)) {
      const p = document.createElement("div");
      p.className = "thought";
      p.textContent = t;
      det.appendChild(p);
    }
    wrap.appendChild(det);
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
    wrap.appendChild(list);
  }
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
    if (m.kind === "user") {
      el.className = "bubble user";
      const when = fmtTime(m.ts);
      el.innerHTML = `<div class="body">${escapeHtml(m.text)}</div>${when ? `<div class="msg-time">${escapeHtml(when)}</div>` : ""}`;
      if (m.attachments?.length) {
        const chips = document.createElement("div");
        chips.className = "msg-attachments";
        for (const a of m.attachments) {
          const chip = document.createElement("span");
          chip.className = "attach-chip static";
          chip.textContent = `${a.kind === "image" ? "🖼" : "📄"} ${a.name}`;
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
      // Assistant chat messages render Markdown; turn goals stay plain.
      const bodyHtml = m.kind === "assistant"
        ? (m.streaming ? escapeHtml(m.text) + `<span class="stream-caret">▍</span>` : renderMarkdown(m.text))
        : escapeHtml(m.goal);
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
    renderRecentWorkspaces();
  } else {
    state.runId = res.run_id ?? state.runId;
    state.transcript.push({
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
    });
    updateStopButton();
  }
}

function chatBody(text, override, attachments, extra) {
  const body = chatRequestBody({
    message: text,
    runId: state.runId,
    workspaceRoot: state.workspaceRoot,
    engineOverride: override ?? state.engineOverride,
  });
  if (attachments?.length) {
    body.attachments = attachments.map((a) => ({
      name: a.name,
      mime: a.mime,
      ...(a.data_url ? { data_url: a.data_url } : {}),
      ...(a.text ? { text: a.text } : {}),
    }));
  }
  return { ...body, ...(extra ?? {}) };
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
  state.transcript.push({ kind: "user", text, attachments, ts: Date.now() });
  renderTranscript();
  // Live placeholder: fills token-by-token while the server streams, then
  // becomes the final message (or is dropped for dispatch outcomes).
  const live = { kind: "assistant", text: "", streaming: true };
  state.transcript.push(live);
  renderTranscript();
  updateStopButton();
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
  const box = $("attach-chips");
  if (!box) return;
  box.innerHTML = "";
  state.pendingAttachments.forEach((a, i) => {
    const chip = document.createElement("span");
    chip.className = "attach-chip";
    chip.innerHTML = `<span>${escapeHtml(a.kind === "image" ? "🖼" : "📄")} ${escapeHtml(a.name)}</span>`;
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
    if (kind === "image") reader.readAsDataURL(file);
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
        check.kind === "image"
          ? { name: file.name, mime: check.mime, kind: "image", data_url: String(raw) }
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
  if (pending.length > 0 && !state.approvalOpen) {
    state.approvalOpen = true;
    expand(); // approval baru → island mekar (once per batch)
  } else if (pending.length === 0) {
    state.approvalOpen = false;
  }
  await refreshTurnActivity();
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
    if (lastEvent?.type === "TASK_COMPLETED" || lastEvent?.type === "TASK_FAILED") {
      turn.activityDone = true;
      updateStopButton();
    }
  }
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
  if (pending.length > 0 && !state.approvalOpen) {
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

async function loadSettingsView() {
  const status = $("set-status");
  status.className = "status-line";
  status.textContent = "";
  try {
    const [s, providers] = await Promise.all([state.api.getSettings(), state.api.getProviders()]);
    const list = providers.providers ?? [];
    const provSel = $("set-provider");
    provSel.innerHTML = "";
    for (const p of list) {
      const o = document.createElement("option");
      o.value = p.id;
      o.textContent = `${p.name ?? p.id}${p.enabled === false ? " (nonaktif)" : ""}`;
      provSel.appendChild(o);
    }
    // Empty registry: say so with the real storage path instead of a
    // dead dropdown. Providers live per workspace-home, so a list added
    // under another workspace legitimately shows up empty here.
    const emptyNote = $("set-prov-empty");
    if (emptyNote) {
      if (list.length === 0) {
        emptyNote.textContent = "Belum ada provider di workspace ini. Pilih preset di bawah atau isi manual, lalu Test koneksi.";
        emptyNote.className = "status-line error";
      } else {
        emptyNote.textContent = "";
        emptyNote.className = "status-line hidden";
      }
    }
    renderProviderPresets(providers.presets ?? []);
    const homeHint = $("prov-home");
    if (homeHint && providers.home) {
      homeHint.textContent = `Kunci API tersimpan di server (${providers.home}) dan tidak pernah ditampilkan kembali — sama seperti Web/CLI.`;
    }
    const current = s.session?.providerId ?? s.session?.provider_id ?? "";
    if (current) provSel.value = current;
    await loadModels(provSel.value);
    const curModel = s.session?.model ?? "";
    if (curModel) $("set-model").value = curModel;
    // The approval buttons reflect the LIVE server session, not just the
    // last thing this panel wrote — another client may have changed it.
    state.prefs = { ...state.prefs, auto_approve: s.session?.autoApprove === true };
    await invoke("set_prefs", { prefs: state.prefs }).catch(() => {});
    await loadEngineToggles();
    // Show current workspace
    const ws = $("set-workspace");
    if (ws) ws.value = state.workspaceRoot || "";
    // Update approval buttons
    updateApprovalButtons();
  } catch (e) {
    status.className = "status-line error";
    status.textContent = "Gagal memuat pengaturan: " + errText(e);
  }
}

/** Update approval mode button states. */
function updateApprovalButtons() {
  const auto = state.prefs?.auto_approve === true;
  $("approve-ask").className = auto ? "ghost-btn" : "primary-btn";
  $("approve-auto").className = auto ? "primary-btn" : "ghost-btn";
}

/** Set approval mode (ask every time / auto-approve). */
async function setApprovalMode(mode) {
  const auto = mode === "auto";
  state.prefs = { ...state.prefs, auto_approve: auto };
  await invoke("set_prefs", { prefs: state.prefs }).catch(() => {});
  if (state.api) {
    try {
      await state.api.updateSettings({ session: { autoApprove: auto } });
    } catch {}
  }
  updateApprovalButtons();
}

/**
 * Connection & diagnostics: real facts only — server health + the workspace
 * the server is actually serving, plus whether the pill is layer-shell
 * pinned (compositor_info). Surfaces failures instead of hiding them.
 */
async function runDiagnostics() {
  const out = $("set-diag");
  if (!out) return;
  out.className = "status-line";
  out.textContent = "Memeriksa…";
  const lines = [];
  let ok = true;
  try {
    const health = await invoke("server_health");
    const served = health.workspace_root ?? "(tak diketahui)";
    const matches = state.workspaceRoot && sameWorkspace(health.workspace_root ?? "", state.workspaceRoot);
    lines.push(health.healthy ? "Server: aktif" : "Server: tidak merespons");
    lines.push("Server melayani: " + served);
    if (health.healthy) {
      if (state.workspaceRoot && !matches) {
        ok = false;
        lines.push("≠ workspace UI (" + state.workspaceRoot + ")");
      } else {
        lines.push("Workspace sinkron");
      }
    } else ok = false;
    try {
      const comp = await invoke("compositor_info");
      lines.push("Layer-shell pinned: " + (comp?.layer_shell_pinned ? "ya" : "tidak (panel mengapung)"));
    } catch { /* optional command */ }
    lines.push("Stream: " + (state.connected ? "terhubung" : "terputus"));
  } catch (e) {
    ok = false;
    lines.push("Gagal memeriksa: " + errText(e));
  }
  out.className = "status-line " + (ok ? "ok" : "error");
  out.textContent = "• " + lines.join("  ·  ");
}

/**
 * One-click preset fill: ID/name/URL from the server's real preset list.
 * The key is still typed by hand, then Test koneksi proves it for real.
 */
function renderProviderPresets(presets) {
  const box = $("prov-presets");
  if (!box) return;
  box.innerHTML = "";
  for (const preset of presets.filter((p) => p.id !== "custom")) {
    const b = document.createElement("button");
    b.className = "ghost-btn small";
    b.textContent = preset.name ?? preset.id;
    b.title = preset.baseUrl ?? "";
    b.onclick = () => {
      $("prov-id").value = preset.id;
      $("prov-name").value = preset.name ?? preset.id;
      $("prov-url").value = preset.baseUrl ?? "";
      $("prov-key").focus?.();
    };
    box.appendChild(b);
  }
}

/** Test provider connection (real server round-trip, no fake success). */
async function testConnection() {
  const status = $("set-conn-status");
  if (!status) return;
  status.textContent = "Menghubungi…";
  status.className = "status-line";
  try {
    const providerId = ($("set-provider")?.value ?? "").trim();
    if (!providerId) throw new Error("Pilih provider dulu.");
    const res = await state.api.testProvider(providerId);
    status.className = "status-line " + (res.ok ? "ok" : "error");
    status.textContent = res.message ?? (res.ok ? "Koneksi OK." : "Koneksi gagal.");
  } catch (e) {
    status.textContent = "Gagal: " + errText(e);
    status.className = "status-line error";
  }
}

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
    status.className = "status-line ok";
    status.textContent = `${engineLabel(engine)} ${enabled ? "diaktifkan" : "dinonaktifkan"}.`;
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

async function loadModels(providerId) {
  // Free-text input + datalist suggestions: known models are one click
  // away, but a custom/brand-new model id is always typeable — even when
  // the provider is unreachable and the list comes back empty.
  const list = $("set-model-list");
  if (!list) return;
  list.innerHTML = "";
  if (!providerId) return;
  try {
    const data = await state.api.getModels(providerId);
    for (const m of data.models ?? []) {
      const o = document.createElement("option");
      o.value = m.model;
      list.appendChild(o);
    }
  } catch {
    /* suggestions are best-effort; the input stays usable regardless */
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
// Workspace
// ---------------------------------------------------------------------------

function renderRecentWorkspaces() {
  const box = $("ws-recent");
  box.innerHTML = "";
  for (const w of state.prefs.recent_workspaces ?? []) {
    const b = document.createElement("button");
    b.textContent = w;
    b.onclick = () => setWorkspace(w);
    box.appendChild(b);
  }
  if (!box.children.length) box.innerHTML = `<span class="hint">Belum ada.</span>`;
}

/**
 * Real workspace status: is the folder valid, and is the server actually
 * anchored to it (via server_health.workspace_root from PR #102)?
 */
async function renderWorkspaceStatus() {
  const el = $("ws-health");
  el.className = "status-line";
  el.textContent = "Mengecek…";
  const path = ((($("ws-path")?.value ?? "") || state.workspaceRoot)).trim();
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
    el.textContent = `● Folder valid, tapi server melayani workspace lain (${health.workspace_root}). Klik "Pilih Folder" untuk re-anchor.`;
  } else {
    el.className = "status-line";
    el.textContent = "● Folder valid — server belum jalan.";
  }
}

/** "Buat folder baru" — creates the typed path, then uses it as workspace. */
async function createWorkspace(folderName) {
  const status = $("ws-status");
  // New mockup: folder name input; old: full path input.
  const nameInput = $("ws-new-name");
  const name = (folderName ?? (nameInput ? nameInput.value.trim() : "")).trim();
  const base = state.workspaceRoot || (($("ws-path")?.value ?? "").trim());
  const path = name ? (base ? base.replace(/\/+$/, "") + "/" + name : name) : (($("ws-path")?.value ?? "").trim());
  if (!path) {
    status.className = "status-line error";
    status.textContent = "Isi folder dulu.";
    return;
  }
  try {
    const created = await invoke("create_dir", { path });
    status.className = "status-line ok";
    status.textContent = created ? "Folder dibuat." : "Folder sudah ada — dipakai.";
    await setWorkspace(path);
  } catch (e) {
    status.className = "status-line error";
    status.textContent = "Gagal: " + errText(e);
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
    const serverOk = await ensureServer((t, e) => {
      status.className = "status-line" + (e ? " error" : "");
      status.textContent = t;
    });
    if (!serverOk) {
      renderRecentWorkspaces();
      return;
    }
    status.className = "status-line ok";
    status.textContent = "Workspace aktif: " + path;
    renderRecentWorkspaces();
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
  // this is a 10s safety net for missed events.
  setInterval(refreshRuns, 10000);
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

  bindGuarded("pill", "click", expand);
  bindGuarded("pill", "keydown", (e) => { if (e.key === "Enter" || e.key === " ") expand(); });
  bindGuarded("btn-collapse", "click", collapse);
  bindGuarded("btn-settings", "click", () => { loadSettingsView(); showView("settings"); });
  bindGuarded("set-back", "click", () => showView("main"));
  // Approval mode buttons (mockup: Tanya setiap kali / Setujui otomatis)
  bindGuarded("approve-ask", "click", () => setApprovalMode("ask"));
  bindGuarded("approve-auto", "click", () => setApprovalMode("auto"));
  // API key show/hide
  bindGuarded("set-showkey", "click", () => {
    const inp = $("set-apikey");
    if (!inp) return;
    const show = inp.type === "password";
    inp.type = show ? "text" : "password";
    const _sk = $("set-showkey"); if (_sk) _sk.textContent = show ? "Sembunyikan" : "Tampilkan";
  });
  // Test connection
  bindGuarded("set-test", "click", testConnection);
  // Connection & diagnostics
  bindGuarded("set-diag-refresh", "click", runDiagnostics);
  // Workspace picker from settings
  bindGuarded("set-pick-workspace", "click", () => showView("workspace"));
  bindGuarded("btn-workspace", "click", () => { const p = $("ws-path"); if (p) p.value = state.workspaceRoot; const st = $("ws-status"); if (st) st.textContent = ""; showView("workspace"); });
  bindGuarded("ws-back", "click", () => showView("main"));
  bindGuarded("ws-use", "click", async () => {
    // Native folder picker (Tauri dialog)
    try {
      const picked = await invoke("pick_folder");
      if (picked) {
        if ($("ws-path")) $("ws-path").value = picked;
        await setWorkspace(picked);
      }
    } catch (e) {
      // Fallback to manual path input
      const path = (($("ws-path")?.value ?? "").trim());
      if (path) await setWorkspace(path);
    }
  });
  bindGuarded("ws-create", "click", () => {
    const name = (($("ws-new-name")?.value ?? "").trim());
    if (name) createWorkspace(name);
  });

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

  bindGuarded("set-provider", "change", (e) => loadModels(e.target.value));
  // Approval mode (ask/auto) and engine toggles cover the permission model;
  // the legacy trust/thinking selects were dropped in the mockup redesign.
  bindGuarded("set-save", "click", async () => {
    const status = $("set-status");
    const providerId = ($("set-provider").value ?? "").trim();
    const model = ($("set-model").value ?? "").trim();
    const key = $("set-apikey").value ?? "";
    try {
      // The key field used to be silently discarded here. A non-empty key
      // rotates the selected provider's secret (partial update — base URL,
      // models, and name are preserved server-side); an empty field leaves
      // the stored key untouched.
      let keyNote = "";
      if (key && providerId) {
        await state.api.updateProvider(providerId, { apiKey: key });
        $("set-apikey").value = "";
        keyNote = " Kunci diperbarui.";
      } else if (key && !providerId) {
        throw new Error("Pilih provider dulu untuk menyimpan kunci.");
      }
      await state.api.updateSettings({ providerId, model });
      status.className = "status-line ok";
      status.textContent = "Tersimpan — berlaku untuk semua engine." + keyNote;
    } catch (e) {
      status.className = "status-line error";
      status.textContent = "Gagal: " + errText(e);
    }
  });
  bindGuarded("prov-test", "click", async () => {
    const status = $("set-status");
    const id = $("prov-id").value.trim();
    if (!id) { status.textContent = "Isi ID dulu."; return; }
    try {
      // simpan dulu (upsert), lalu test — pola yang sama dipakai Web UI
      await state.api.createProvider({
        id,
        name: $("prov-name").value.trim() || id,
        baseUrl: $("prov-url").value.trim(),
        apiKey: $("prov-key").value,
      });
      const res = await state.api.testProvider(id);
      status.className = "status-line " + (res.ok ? "ok" : "error");
      status.textContent = res.message ?? (res.ok ? "Koneksi OK." : "Koneksi gagal.");
      if (res.ok) { $("prov-key").value = ""; loadSettingsView(); }
    } catch (e) {
      status.className = "status-line error";
      status.textContent = "Gagal: " + errText(e);
    }
  });
  bindGuarded("prov-save", "click", async () => {
    const status = $("set-status");
    try {
      await state.api.createProvider({
        id: $("prov-id").value.trim(),
        name: $("prov-name").value.trim() || $("prov-id").value.trim(),
        baseUrl: $("prov-url").value.trim(),
        apiKey: $("prov-key").value,
      });
      $("prov-key").value = "";
      status.className = "status-line ok";
      status.textContent = "Provider tersimpan. Kunci tidak pernah ditampilkan kembali.";
      loadSettingsView();
    } catch (e) {
      status.className = "status-line error";
      status.textContent = "Gagal: " + errText(e);
    }
  });

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
