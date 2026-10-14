// Dae Captain island — DOM wiring. Pure DOM + Tauri invoke bridge.
// All server communication goes through api.js; all decisions through logic.js.

import { createApiClient } from "./api.js";
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
  trustToAutoApprove,
  autoApproveToTrust,
  queueRows,
  summarizeTaskEvents,
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
  prefs: null,
  workspaceRoot: "",
  runId: null,
  workflowRunId: null, // run shown in the workflow queue view
  engineOverride: null, // null = auto
  expanded: false,
  runs: [],
  transcript: [], // {kind: 'user'|'turn'|'clarify'|'error', ...}
  serverUrl: "http://127.0.0.1:3080",
};

// ---------------------------------------------------------------------------
// Views
// ---------------------------------------------------------------------------

function showView(name) {
  for (const v of ["main", "status", "workflow", "settings", "workspace", "setup", "boot"]) {
    $("view-" + v).classList.toggle("hidden", v !== name);
  }
  if (name === "status") renderStatusView();
  if (name === "workflow") renderWorkflowView();
  if (name === "settings") loadSettingsView();
  if (name === "workspace") { renderWorkspaceStatus(); renderPresets(); }
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
  pill.className = "pill status-" + statusColor(agg.status);
  $("pill-text").textContent = pillText(agg);
}

function renderEnginePills() {
  const box = $("engine-pills");
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
  box.innerHTML = "";
  for (const run of state.runs) {
    for (const turn of run.turns ?? []) {
      for (const ap of turn.pending_approvals ?? []) {
        const card = document.createElement("div");
        card.className = "approval-card";
        card.innerHTML = `
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
          <div class="title">${escapeHtml(engineLabel(turn.engine))} bertanya — butuh jawabanmu</div>
          <div class="row"><button class="primary-btn">Buka Web UI</button></div>`;
        card.querySelector("button").onclick = () => openWebUI();
        box.appendChild(card);
      }
    }
  }
}
async function decideApproval(taskId, approval, decision) {
  await state.api.approve(taskId, approvalPayload(approval, decision));
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
  if (thoughts.length) {
    const det = document.createElement("details");
    det.className = "thinking";
    const sum = document.createElement("summary");
    sum.textContent = `💭 thinking (${thoughts.length})`;
    det.appendChild(sum);
    for (const t of thoughts.slice(-3)) {
      const p = document.createElement("div");
      p.className = "thought";
      p.textContent = t;
      det.appendChild(p);
    }
    wrap.appendChild(det);
  }
  if (tools.length) {
    const row = document.createElement("div");
    row.className = "tool-chips";
    for (const t of tools.slice(-8)) {
      const chip = document.createElement("span");
      chip.className = `tool-chip ${t.status === "ok" ? "ok" : t.status === "running" ? "running" : "bad"}`;
      chip.textContent = `${t.tool} ${t.status === "ok" ? "OK" : t.status === "running" ? "…" : t.status.toUpperCase()}`;
      row.appendChild(chip);
    }
    wrap.appendChild(row);
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
      el.innerHTML = `
        <div class="who">${escapeHtml(who)}</div>
        <div class="body">${escapeHtml(m.kind === "assistant" ? m.text : m.goal)}</div>
        ${m.staged ? `<div class="note">Staged — menunggu gate di Web UI / aplikasi.</div>` : ""}
        ${arts.length ? `<div class="artifacts">Mengambil:<br>${arts.map((a) => "• " + escapeHtml(a)).join("<br>")}</div>` : ""}`;
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
      el.innerHTML = `<div class="who">Dae Captain</div><div class="body">Gagal: ${escapeHtml(m.text)}</div>`;
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
  const ws = state.workspaceRoot ? state.workspaceRoot.replace(/\/+$/, "").split("/").pop() : "";
  const agg = aggregateStatus(state.runs);
  const what = agg.status === "attention"
    ? `${agg.attention} butuh persetujuan`
    : agg.status === "working"
      ? `${agg.running} agent berjalan`
      : "siap";
  el.textContent = (ws ? ws + " • " : "") + what;
}

/** Status view: live engine pills + per-run cards. All data from polling. */
function renderStatusView() {
  renderEnginePills();
  const box = $("runs-list");
  box.innerHTML = "";
  if (!state.runs.length) {
    box.innerHTML = `<span class="hint">Belum ada run di workspace ini.</span>`;
    return;
  }
  for (const run of state.runs.slice(-10).reverse()) {
    const card = document.createElement("div");
    card.className = "run-card";
    const turns = run.turns ?? [];
    const head = document.createElement("div");
    head.className = "run-head";
    head.innerHTML = `<span class="dot ${turns.some((t) => t.status === "running") ? "green" : "blue"}"></span>
      run <span class="mono">${escapeHtml(String(run.run_id ?? "").slice(0, 8))}</span>
      <span class="hint">${turns.length} turn</span>`;
    const openBtn = document.createElement("button");
    openBtn.className = "ghost-btn";
    openBtn.textContent = "Detail →";
    openBtn.onclick = () => { state.workflowRunId = run.run_id; showView("workflow"); };
    head.appendChild(openBtn);
    card.appendChild(head);
    for (const t of turns.slice(-6)) {
      const attn = (t.pending_approvals ?? []).length + (t.pending_questions ?? []).length;
      const row = document.createElement("div");
      row.className = "run-turn";
      const dot = t.status === "running" ? (attn ? "amber" : "green") : "blue";
      row.innerHTML = `<span class="dot ${dot}"></span>
        <div><div class="goal"><b>${escapeHtml(engineLabel(t.engine))}</b> — ${escapeHtml(turnSummary(t).goal)}</div>
        <div class="detail">${escapeHtml(turnSummary(t).detail)}</div>
        ${attn ? `<div class="attn">${attn} menunggu keputusanmu</div>` : ""}</div>`;
      card.appendChild(row);
    }
    box.appendChild(card);
  }
}

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
  $("wf-prompt").textContent = rows.length ? rows[0].goal : "Run kosong.";
  $("wf-count").textContent = rows.length
    ? `Workflow: ${rows.length} task${rows.length > 1 ? "s" : ""}`
    : "";
  const running = rows.filter((r) => r.status === "running");
  if (running.length) $("wf-cancel").classList.remove("hidden");
  for (const row of rows) {
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
  } catch {
    state.runs = [];
  }
  renderPill();
  renderHeaderStatus();
  if (pendingApprovals(state.runs).length > 0) expand(); // approval baru → island mekar
  await refreshTurnActivity();
  if (!state.expanded) return;
  if (!$("view-status").classList.contains("hidden")) {
    renderStatusView();
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
  return state.expanded && !$("view-main").classList.contains("hidden");
}

/**
 * Live activity for the latest chat turn (thinking + tool calls, like the
 * web panel). Polls task events while the turn is running; stops when the
 * turn leaves "running". Re-renders the transcript only on change.
 */
async function refreshTurnActivity() {
  if (!state.api) return;
  const turn = [...state.transcript].reverse().find(
    (m) => m.kind === "turn" && m.taskId && !m.activityDone
  );
  if (!turn) return;
  const runTurn = findRunTurn(turn.taskId);
  try {
    const data = await state.api.taskEvents(turn.taskId);
    const summary = summarizeTaskEvents(data.events ?? []);
    const key = JSON.stringify(summary);
    if (key !== turn.activityKey) {
      turn.activityKey = key;
      turn.activity = summary;
      if (isChatViewVisible()) renderTranscript();
    }
  } catch {
    /* events unavailable — keep last activity */
  }
  if (runTurn && runTurn.status !== "running") {
    turn.activityDone = true;
    if (runTurn.note && !turn.noteShown) {
      turn.noteShown = true;
      // Surface the failure reason in chat too, not just the workflow view.
      state.transcript.push({ kind: "error", text: runTurn.note });
      if (isChatViewVisible()) renderTranscript();
    }
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
    const ci = await invoke("compositor_info").catch(() => null);
    if (ci) {
      $("compositor-info").textContent =
        `Kompositor: ${ci.desktop} (${ci.session_type}) — island: panel mengambang; ` +
        `layer-shell pinning: ${ci.layer_shell_pinned ? "aktif" : "follow-up (lihat BUILD.md)"}.`;
    }
    await loadEngineToggles();
    await loadTrustLevel();
    await loadThinkingLevel();
  } catch (e) {
    status.className = "status-line error";
    status.textContent = "Gagal memuat pengaturan: " + errText(e);
  }
}

/** Sidebar navigation for the settings view. */
function selectSettingsSection(sec) {
  for (const b of document.querySelectorAll(".settings-nav button")) {
    b.classList.toggle("active", b.dataset.sec === sec);
  }
  for (const s of ["general", "systems", "chat"]) {
    $("set-sec-" + s).classList.toggle("hidden", s !== sec);
  }
}

/** Agentic Systems toggles — persisted to Tauri prefs AND the live server. */
async function loadEngineToggles() {
  const box = $("engine-toggles");
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

/** Trust & Approval — honest 2-state mapping of the boolean autoApprove. */
async function loadTrustLevel() {
  try {
    const s = await state.api.getSettings();
    $("trust-level").value = autoApproveToTrust(s.session?.autoApprove);
  } catch { /* biarkan default */ }
}

async function loadThinkingLevel() {
  try {
    const s = await state.api.getSettings();
    const lvl = s.session?.thinkingLevel ?? "medium";
    $("think-level").value = THINKING_LEVELS.includes(lvl) ? lvl : "medium";
  } catch { /* biarkan default */ }
}

async function loadModels(providerId) {
  const sel = $("set-model");
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
  const path = ($("ws-path").value || state.workspaceRoot).trim();
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

/** Named workspace shortcuts, persisted in Tauri prefs. */
function getPresets() {
  return state.prefs.workspace_presets ?? [];
}

function renderPresets() {
  const sel = $("ws-preset");
  sel.innerHTML = "";
  const presets = getPresets();
  if (!presets.length) {
    const o = document.createElement("option");
    o.value = "";
    o.textContent = "— belum ada preset —";
    sel.appendChild(o);
    return;
  }
  for (const p of presets) {
    const o = document.createElement("option");
    o.value = p.name;
    o.textContent = `${p.name} — ${p.path}`;
    sel.appendChild(o);
  }
}

async function savePreset(name, path) {
  const presets = getPresets().filter((p) => p.name !== name);
  presets.push({ name, path });
  state.prefs = { ...state.prefs, workspace_presets: presets };
  await invoke("set_prefs", { prefs: state.prefs });
  renderPresets();
  $("ws-preset").value = name;
}

async function deletePreset(name) {
  if (!name) return;
  state.prefs = {
    ...state.prefs,
    workspace_presets: getPresets().filter((p) => p.name !== name),
  };
  await invoke("set_prefs", { prefs: state.prefs });
  renderPresets();
}

/** Scan Directory — real top-level listing via the list_dir command. */
async function scanWorkspace() {
  const out = $("ws-scan-out");
  const status = $("ws-status");
  const path = ($("ws-path").value || state.workspaceRoot).trim();
  out.innerHTML = "";
  if (!path) {
    status.className = "status-line error";
    status.textContent = "Isi folder dulu.";
    return;
  }
  try {
    const entries = await invoke("list_dir", { path });
    if (!entries.length) {
      out.innerHTML = `<span class="hint">Folder kosong.</span>`;
      return;
    }
    out.innerHTML = entries
      .map((e) => `<div class="scan-entry">${e.is_dir ? "📁" : "📄"} ${escapeHtml(e.name)}</div>`)
      .join("");
    status.className = "status-line ok";
    status.textContent = `${entries.length} entri di ${path}.`;
  } catch (e) {
    status.className = "status-line error";
    status.textContent = "Gagal memindai: " + errText(e);
  }
}

/** "Buat folder baru" — creates the typed path, then uses it as workspace. */
async function createWorkspace() {
  const status = $("ws-status");
  const path = $("ws-path").value.trim();
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
  if (!state.workspaceRoot) {
    showView("workspace");
    renderRecentWorkspaces();
    return;
  }

  bootStatus("Mengecek node…");
  const nodeOk = await invoke("node_available").catch(() => false);
  if (!nodeOk) {
    bootStatus("node tidak ditemukan di PATH — install Node.js dulu, lalu restart aplikasi.", true);
    return;
  }

  bootStatus("Menghubungi server…");
  const serverOk = await ensureServer((t, e) => bootStatus(t, e));
  if (!serverOk) return;

  state.api = createApiClient({ baseUrl: state.serverUrl });
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
  setInterval(refreshRuns, 2500);
}

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

function bindEvents() {
  $("pill").onclick = expand;
  $("pill").onkeydown = (e) => { if (e.key === "Enter" || e.key === " ") expand(); };
  $("btn-collapse").onclick = collapse;
  $("btn-settings").onclick = () => showView("settings");
  $("set-back").onclick = () => showView("main");
  for (const b of document.querySelectorAll(".settings-nav button")) {
    b.onclick = () => selectSettingsSection(b.dataset.sec);
  }
  $("btn-workspace").onclick = () => { $("ws-path").value = state.workspaceRoot; $("ws-status").textContent = ""; $("ws-scan-out").innerHTML = ""; showView("workspace"); };
  $("ws-back").onclick = () => showView("main");
  $("ws-use").onclick = () => setWorkspace($("ws-path").value.trim());
  $("ws-create").onclick = createWorkspace;
  $("ws-scan").onclick = scanWorkspace;
  $("ws-preset").onchange = (e) => {
    const p = getPresets().find((x) => x.name === e.target.value);
    if (p) { $("ws-path").value = p.path; setWorkspace(p.path); }
  };
  $("ws-preset-save").onclick = async () => {
    const status = $("ws-status");
    const name = $("ws-preset-name").value.trim();
    const path = ($("ws-path").value || state.workspaceRoot).trim();
    if (!name || !path) {
      status.className = "status-line error";
      status.textContent = "Isi nama preset dan folder dulu.";
      return;
    }
    try {
      await savePreset(name, path);
      $("ws-preset-name").value = "";
      status.className = "status-line ok";
      status.textContent = `Preset "${name}" tersimpan.`;
    } catch (e) {
      status.className = "status-line error";
      status.textContent = "Gagal: " + errText(e);
    }
  };
  $("ws-preset-del").onclick = async () => {
    try {
      await deletePreset($("ws-preset").value);
    } catch (e) {
      $("ws-status").className = "status-line error";
      $("ws-status").textContent = "Gagal: " + errText(e);
    }
  };

  $("chat-send").onclick = () => sendChat();
  $("chat-input").onkeydown = (e) => { if (e.key === "Enter") sendChat(); };

  $("btn-approve-all").onclick = approveAll;
  $("btn-goto-chat").onclick = () => { showView("main"); $("chat-input").focus(); };
  $("btn-goto-status").onclick = () => showView("status");
  $("status-back").onclick = () => showView("main");
  $("status-open-web").onclick = openWebUI;
  $("wf-back").onclick = () => showView("status");
  $("wf-cancel").onclick = cancelWorkflow;

  $("set-provider").onchange = (e) => loadModels(e.target.value);
  $("trust-level").onchange = async (e) => {
    const status = $("set-status");
    try {
      await state.api.updateSettings({ session: { autoApprove: trustToAutoApprove(e.target.value) } });
      status.className = "status-line ok";
      status.textContent = "Tersimpan — berlaku untuk semua engine.";
    } catch (err) {
      status.className = "status-line error";
      status.textContent = "Gagal: " + errText(err);
      loadTrustLevel();
    }
  };
  $("think-level").onchange = async (e) => {
    const status = $("set-status");
    try {
      await state.api.updateSettings({ session: { thinkingLevel: e.target.value } });
      status.className = "status-line ok";
      status.textContent = "Tersimpan — berlaku untuk semua engine.";
    } catch (err) {
      status.className = "status-line error";
      status.textContent = "Gagal: " + errText(err);
      loadThinkingLevel();
    }
  };
  $("set-save").onclick = async () => {
    const status = $("set-status");
    try {
      await state.api.updateSettings({ providerId: $("set-provider").value, model: $("set-model").value });
      status.className = "status-line ok";
      status.textContent = "Tersimpan — berlaku untuk semua engine.";
    } catch (e) {
      status.className = "status-line error";
      status.textContent = "Gagal: " + errText(e);
    }
  };
  $("prov-test").onclick = async () => {
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
  };
  $("prov-save").onclick = async () => {
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
  };

  $("setup-save").onclick = async () => {
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
  };

  $("btn-quit").onclick = async () => {
    const managed = await invoke("server_managed").catch(() => false);
    if (!managed) { invoke("quit_app"); return; }
    if (state.prefs.keep_alive === "keep") { invoke("quit_app"); return; }
    if (state.prefs.keep_alive === "stop") { await invoke("stop_server").catch(() => {}); invoke("quit_app"); return; }
    $("quit-dialog").classList.remove("hidden");
  };
  const quitWith = async (keep) => {
    if ($("quit-remember").checked) {
      state.prefs = { ...state.prefs, keep_alive: keep ? "keep" : "stop" };
      await invoke("set_prefs", { prefs: state.prefs }).catch(() => {});
    }
    if (!keep) await invoke("stop_server").catch(() => {});
    invoke("quit_app");
  };
  $("quit-keep").onclick = () => quitWith(true);
  $("quit-stop").onclick = () => quitWith(false);
}

bindEvents();
boot();
