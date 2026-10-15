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
  isClarifyResponse,
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
  transcript: [], // {kind: 'user'|'turn'|'clarify'|'error', ...}
  serverUrl: "http://127.0.0.1:3080",
  pendingMessage: null, // work command waiting for a workspace pick
  pendingOverride: null,
  wfFilter: "all", // antrean filter: all|running|approval|done|failed
  connected: false, // event-stream/HTTP health (honest pill + header status)
  seenEvents: new Map(), // task_id -> max seq applied (dedupe on reconnect)
  wsSubscribed: false, // wildcard WS subscription done once per workspace
  approvalOpen: false, // latch: auto-expand once per approval batch
};

// ---------------------------------------------------------------------------
// Views
// ---------------------------------------------------------------------------

function showView(name) {
  for (const v of ["main", "workflow", "settings", "workspace", "setup", "boot"]) {
    $("view-" + v).classList.toggle("hidden", v !== name);
  }
  if (name === "workflow") renderWorkflowView();
  if (name === "settings") loadSettingsView();
  if (name === "workspace") { renderWorkspaceStatus(); }
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
          <div class="approval-header">Butuh jawaban</div>
          <div class="title">${escapeHtml(engineLabel(turn.engine))} bertanya — jawab di sini:</div>
          <div class="row">
            <input class="answer-input" type="text" placeholder="Tulis jawaban…" style="flex:1">
            <button class="primary-btn">Kirim</button>
          </div>`;
        const send = () => answerCardQuestion(turn.task_id, q, card);
        card.querySelector("button").onclick = send;
        card.querySelector(".answer-input").addEventListener("keydown", (e) => {
          if (e.key === "Enter") send();
        });
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

/** Answer a pending question inline — no more dead-end "open the Web UI". */
async function answerCardQuestion(taskId, question, card) {
  const input = card.querySelector(".answer-input");
  const answer = (input?.value ?? "").trim();
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
 * Live activity block for a chat turn: thinking (collapsible) + tool-call
 * chips, mirroring the web panel's THINKING view. Returns null when empty.
 */
function renderTurnActivity(activity) {
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
      list.appendChild(row);
    }
    wrap.appendChild(list);
  }
  return wrap;
}

function renderTranscript() {  const box = $("transcript");
  box.innerHTML = "";
  for (const m of state.transcript.slice(-30)) {
    const el = document.createElement("div");
    if (m.kind === "user") {
      el.className = "bubble user";
      el.innerHTML = `<div class="body">${escapeHtml(m.text)}</div>`;
    } else if (m.kind === "turn" || m.kind === "assistant") {
      el.className = "bubble assistant";
      const who = m.kind === "assistant" ? "Dae Captain" : engineLabel(m.engine);
      const arts = formatResolvedArtifacts(m.resolved);
      // Assistant chat messages render Markdown; turn goals stay plain.
      const bodyHtml = m.kind === "assistant" ? renderMarkdown(m.text) : escapeHtml(m.goal);
      el.innerHTML = `
        <div class="who">${escapeHtml(who)}</div>
        <div class="body">${bodyHtml}</div>
        ${m.staged ? `<div class="note">Staged — menunggu gate di Web UI / aplikasi.</div>` : ""}
        ${arts.length ? `<div class="artifacts"></div>` : ""}`;
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
      const act = renderTurnActivity(m.activity);
      if (act) el.appendChild(act);
    } else if (m.kind === "clarify") {
      el.className = "bubble assistant clarify";
      el.innerHTML = `<div class="who">Dae Captain</div><div class="body">${escapeHtml(m.text)}</div><div class="opt-row"></div>`;
      const btnBox = el.querySelector(".opt-row");
      for (const opt of m.options) {
        const b = document.createElement("button");
        b.className = "ghost-btn";
        b.textContent = engineLabel(opt);
        b.onclick = () => sendChat(m.original, opt);
        btnBox.appendChild(b);
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
      }
    }
    box.appendChild(el);
  }
  box.scrollTop = box.scrollHeight;
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

async function sendChat(message, override) {
  const text = (message ?? $("chat-input").value).trim();
  if (!text) return;
  $("chat-input").value = "";
  state.transcript.push({ kind: "user", text });
  renderTranscript();
  try {
    const res = await state.api.workflowChat(
      chatRequestBody({
        message: text,
        runId: state.runId,
        workspaceRoot: state.workspaceRoot,
        engineOverride: override ?? state.engineOverride,
      })
    );
    if (isClarifyResponse(res)) {
      state.runId = res.run_id ?? state.runId;
      state.transcript.push({ kind: "clarify", text: res.message, options: res.options, original: text });
    } else if (res.kind === "chat") {
      // Chat-first: a conversational reply, no engine, no task.
      state.runId = res.run_id ?? state.runId;
      state.transcript.push({ kind: "assistant", text: res.text });
    } else if (res.kind === "need_workspace") {
      // Workspace on-demand: the command needs a folder. Remember the
      // original message, show the picker, retry after the user picks.
      state.runId = res.run_id ?? state.runId;
      state.pendingMessage = text;
      state.pendingOverride = override ?? state.engineOverride;
      state.transcript.push({ kind: "assistant", text: res.message ?? "Pilih folder workspace dulu." });
      renderTranscript();
      showView("workspace");
      renderRecentWorkspaces();
      return;
    } else {
      state.runId = res.run_id ?? state.runId;
      state.transcript.push({
        kind: "turn",
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
  } catch (e) {
    state.transcript.push({ kind: "error", text: errText(e) });
  }
  renderTranscript();
  await refreshRuns();
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
  stop.classList.toggle("hidden", !running);
  send.classList.toggle("hidden", running);
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
    const provSel = $("set-provider");
    provSel.innerHTML = "";
    for (const p of providers.providers ?? []) {
      const o = document.createElement("option");
      o.value = p.id;
      o.textContent = `${p.name ?? p.id}${p.enabled === false ? " (nonaktif)" : ""}`;
      provSel.appendChild(o);
    }
    const current = s.session?.providerId ?? s.session?.provider_id ?? "";
    if (current) provSel.value = current;
    await loadModels(provSel.value);
    const curModel = s.session?.model ?? "";
    if (curModel) $("set-model").value = curModel;
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
  const sel = $("set-model");
  if (!sel) return;
  sel.innerHTML = "";
  if (!providerId) return;
  try {
    const data = await state.api.getModels(providerId);
    for (const m of data.models ?? []) {
      const o = document.createElement("option");
      o.value = m.model;
      o.textContent = m.model;
      sel.appendChild(o);
    }
  } catch {
    /* daftar model opsional — user bisa ketik manual nanti */
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
      state.pendingMessage = null;
      state.pendingOverride = null;
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
  bindGuarded("chat-input", "keydown", (e) => { if (e.key === "Enter") sendChat(); });
  bindGuarded("chat-stop", "click", async () => {
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
    try {
      await state.api.updateSettings({ providerId: $("set-provider").value, model: $("set-model").value });
      status.className = "status-line ok";
      status.textContent = "Tersimpan — berlaku untuk semua engine.";
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
