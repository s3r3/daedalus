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
  engineLabel,
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
  for (const v of ["main", "settings", "workspace", "setup", "boot"]) {
    $("view-" + v).classList.toggle("hidden", v !== name);
  }
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
  let any = false;
  for (const run of state.runs) {
    for (const turn of run.turns ?? []) {
      for (const ap of turn.pending_approvals ?? []) {
        any = true;
        const card = document.createElement("div");
        card.className = "approval-card";
        card.innerHTML = `
          <div class="title">${escapeHtml(approvalTitle(turn.task_id, turn, ap))}</div>
          <div class="row">
            <button class="primary-btn" data-act="grant">Allow</button>
            <button class="deny-btn" data-act="deny">Deny</button>
          </div>`;
        card.querySelector('[data-act="grant"]').onclick = () => decideApproval(turn.task_id, ap, "grant", card);
        card.querySelector('[data-act="deny"]').onclick = () => decideApproval(turn.task_id, ap, "deny", card);
        box.appendChild(card);
      }
      for (const q of turn.pending_questions ?? []) {
        any = true;
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
  if (any && !state.expanded) expand(); // approval baru → island mekar
}

async function decideApproval(taskId, approval, decision, card) {
  try {
    await state.api.approve(taskId, approvalPayload(approval, decision));
    card.querySelectorAll("button").forEach((b) => (b.disabled = true));
    card.querySelector(".title").textContent += decision === "grant" ? " — diizinkan ✓" : " — ditolak ✕";
    await refreshRuns();
  } catch (e) {
    card.querySelector(".title").textContent = "Gagal: " + e.message;
  }
}

// ---------------------------------------------------------------------------
// Transcript + chat
// ---------------------------------------------------------------------------

function escapeHtml(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

function renderTranscript() {
  const box = $("transcript");
  box.innerHTML = "";
  for (const m of state.transcript.slice(-20)) {
    const el = document.createElement("div");
    if (m.kind === "user") {
      el.className = "turn";
      el.innerHTML = `<div class="meta"><b>Kamu</b></div><div class="goal">${escapeHtml(m.text)}</div>`;
    } else if (m.kind === "turn") {
      el.className = "turn";
      const arts = formatResolvedArtifacts(m.resolved);
      el.innerHTML = `
        <div class="meta"><span class="engine-chip">→ ${escapeHtml(engineLabel(m.engine))}</span>
        <span class="hint">${escapeHtml(m.router?.layer ?? "")} · ${escapeHtml(m.goal)}</span></div>
        ${m.staged ? `<div class="note">Staged — menunggu gate di Web UI / aplikasi.</div>` : ""}
        ${arts.length ? `<div class="artifacts">Mengambil:<br>${arts.map((a) => "• " + escapeHtml(a)).join("<br>")}</div>` : ""}`;
    } else if (m.kind === "clarify") {
      el.className = "turn clarify";
      el.innerHTML = `<div class="meta"><b>Dae Captain</b></div><div>${escapeHtml(m.text)}</div><div></div>`;
      const btnBox = el.lastElementChild;
      for (const opt of m.options) {
        const b = document.createElement("button");
        b.className = "ghost-btn";
        b.textContent = engineLabel(opt);
        b.onclick = () => sendChat(m.original, opt);
        btnBox.appendChild(b);
      }
    } else if (m.kind === "error") {
      el.className = "turn";
      el.innerHTML = `<div class="note">Gagal: ${escapeHtml(m.text)}</div>`;
    }
    box.appendChild(el);
  }
  box.scrollTop = box.scrollHeight;
}

function renderEngineChips() {
  const box = $("engine-chips");
  box.innerHTML = "";
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
  for (const e of ENGINES) mk(e, engineLabel(e));
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
      });
    }
  } catch (e) {
    state.transcript.push({ kind: "error", text: e.message });
  }
  renderTranscript();
  await refreshRuns();
}

// ---------------------------------------------------------------------------
// Polling
// ---------------------------------------------------------------------------

async function refreshRuns() {
  if (!state.api) return;
  try {
    const data = await state.api.workflowRuns(state.workspaceRoot);
    state.runs = data.runs ?? [];
  } catch {
    state.runs = [];
  }
  renderPill();
  if (state.expanded) {
    renderEnginePills();
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
    const ci = await invoke("compositor_info").catch(() => null);
    if (ci) {
      $("compositor-info").textContent =
        `Kompositor: ${ci.desktop} (${ci.session_type}) — island: panel mengambang; ` +
        `layer-shell pinning: ${ci.layer_shell_pinned ? "aktif" : "follow-up (lihat BUILD.md)"}.`;
    }
  } catch (e) {
    status.className = "status-line error";
    status.textContent = "Gagal memuat pengaturan: " + e.message;
  }
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
    status.className = "status-line ok";
    status.textContent = "Workspace aktif: " + path;
    renderRecentWorkspaces();
    await refreshRuns();
  } catch (e) {
    status.className = "status-line error";
    status.textContent = "Gagal: " + e.message;
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

async function boot() {
  showView("boot");
  expand();
  $("boot-title").textContent = "Menyiapkan Dae Captain…";

  let prefs;
  try {
    prefs = await invoke("get_prefs");
  } catch (e) {
    bootStatus("Gagal membaca preferensi: " + e.message + " — pastikan berjalan di aplikasi Tauri.", true);
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
  let health = await invoke("server_health").catch(() => ({ healthy: false, url: "" }));
  state.serverUrl = health.url || state.serverUrl;
  if (!health.healthy) {
    bootStatus("Server belum jalan — menjalankan sebagai sidecar…");
    try {
      const info = await invoke("spawn_server", { repoRoot: prefs.repo_root, workspace: state.workspaceRoot });
      state.serverUrl = info.url;
      bootStatus(info.started ? `Server jalan (pid ${info.pid}).` : "Server sudah jalan.");
    } catch (e) {
      bootStatus("Gagal menjalankan server: " + e.message, true);
      return;
    }
  }

  state.api = createApiClient({ baseUrl: state.serverUrl });
  try {
    await state.api.health();
  } catch (e) {
    bootStatus("Server tidak menjawab di " + state.serverUrl + ": " + e.message, true);
    return;
  }

  bootStatus("Siap.");
  showView("main");
  renderEngineChips();
  renderTranscript();
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
  $("btn-settings").onclick = () => { showView("settings"); loadSettingsView(); };
  $("set-back").onclick = () => showView("main");
  $("btn-workspace").onclick = () => { showView("workspace"); $("ws-path").value = state.workspaceRoot; $("ws-status").textContent = ""; renderRecentWorkspaces(); };
  $("ws-back").onclick = () => showView("main");
  $("ws-use").onclick = () => setWorkspace($("ws-path").value.trim());

  $("chat-send").onclick = () => sendChat();
  $("chat-input").onkeydown = (e) => { if (e.key === "Enter") sendChat(); };

  $("set-provider").onchange = (e) => loadModels(e.target.value);
  $("set-save").onclick = async () => {
    const status = $("set-status");
    try {
      await state.api.updateSettings({ providerId: $("set-provider").value, model: $("set-model").value });
      status.className = "status-line ok";
      status.textContent = "Tersimpan — berlaku untuk semua engine.";
    } catch (e) {
      status.className = "status-line error";
      status.textContent = "Gagal: " + e.message;
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
      status.textContent = "Gagal: " + e.message;
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
      status.textContent = "Gagal: " + e.message;
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

  // Intercept window close → quit flow above (Tauri close-requested).
  try {
    tauriWindow?.getCurrentWindow?.()?.onCloseRequested?.((e) => {
      e.preventDefault();
      $("btn-quit").onclick();
    });
  } catch { /* non-Tauri: ignore */ }
}

bindEvents();
boot();
