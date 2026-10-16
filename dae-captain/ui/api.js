// Dae Captain UI — HTTP client for the Daedalus server API.
// `fetchImpl` is injectable so unit tests run without a server.
// Never logs or stores API keys; the server redacts them.

import { parseStreamLine } from "./logic.js";

export function createApiClient({ baseUrl, fetchImpl, getToken }) {
  const fetchFn = fetchImpl ?? globalThis.fetch?.bind(globalThis);
  if (!fetchFn) throw new Error("no fetch implementation available");

  async function req(method, path, body, query) {
    let url = baseUrl.replace(/\/+$/, "") + path;
    if (query) {
      const qs = new URLSearchParams();
      for (const [k, v] of Object.entries(query)) {
        if (v !== undefined && v !== null && v !== "") qs.set(k, String(v));
      }
      const s = qs.toString();
      if (s) url += "?" + s;
    }
    const headers = body !== undefined ? { "content-type": "application/json" } : {};
    // Local daemon token for sensitive endpoints (approve/cancel).
    if (getToken) {
      try {
        const token = await getToken();
        if (token) headers["authorization"] = "Bearer " + token;
      } catch {
        /* no token — server may still allow (no daemon.json yet) */
      }
    }
    const res = await fetchFn(url, {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    let data = null;
    try {
      data = await res.json();
    } catch {
      data = null;
    }
    if (!res.ok) {
      const err = new Error(`HTTP ${res.status} ${method} ${path}`);
      err.status = res.status;
      err.data = data;
      throw err;
    }
    return data;
  }

  return {
    baseUrl,
    health: () => req("GET", "/health"),
    workflowChat: (body) => req("POST", "/workflow/chat", body),
    /**
     * Streaming chat: true token deltas via SSE. Dispatch outcomes come
     * back as the identical JSON shape (non-SSE content-type) so the
     * caller handles them exactly like workflowChat responses. Throws on
     * transport failure; a mid-stream model error throws with `.partial`
     * carrying whatever the user already saw.
     */
    workflowChatStream: (body, onDelta, signal) => streamChat({ baseUrl, fetchImpl, getToken }, body, onDelta, signal),
    workflowRuns: (workspaceRoot) =>
      req("GET", "/workflow/runs", undefined, { workspace_root: workspaceRoot }),
    workflowRun: (id, workspaceRoot) =>
      req("GET", `/workflow/runs/${encodeURIComponent(id)}`, undefined, {
        workspace_root: workspaceRoot,
      }),
    approve: (taskId, payload) =>
      req("POST", `/tasks/${encodeURIComponent(taskId)}/approve`, payload),
    decideApproval: (taskId, approvalId, payload) =>
      req("POST", `/tasks/${encodeURIComponent(taskId)}/approvals/${encodeURIComponent(approvalId)}`, payload),
    answerQuestion: (taskId, questionId, answer) =>
      req("POST", `/tasks/${encodeURIComponent(taskId)}/questions/${encodeURIComponent(questionId)}`, { answer }),
    cancelTask: (taskId) =>
      req("POST", `/tasks/${encodeURIComponent(taskId)}/cancel`),
    /** Cooperative pause (Dae Captain pill ⏸): the engine suspends at its
     * next safe checkpoint; resume continues from the same checkpoint. */
    pauseTask: (taskId) =>
      req("POST", `/tasks/${encodeURIComponent(taskId)}/pause`),
    resumeTask: (taskId) =>
      req("POST", `/tasks/${encodeURIComponent(taskId)}/resume`),
    taskEvents: (taskId) =>
      req("GET", `/tasks/${encodeURIComponent(taskId)}/events`),
    taskChanges: (taskId) =>
      req("GET", `/tasks/${encodeURIComponent(taskId)}/changes`),
    workspaceFile: (root, path) =>
      req("GET", "/workspace/file", undefined, { root, path }),
    /** Flat file index for the Workspace page tree. */
    workspaceFiles: (root) =>
      req("GET", "/workspace/files", undefined, { root }),
    /** Files modified within the last `hours` hours, newest first (Workspace "Terbaru"). */
    workspaceRecent: (root, hours = 24) =>
      req("GET", "/workspace/recent", undefined, { root, hours }),
    /** git status: ● modified, + untracked (Workspace page). */
    workspaceGitStatus: (root) =>
      req("GET", "/workspace/git-status", undefined, { root }),
    extensionsStatus: (root) =>
      req("GET", "/extensions/status", undefined, { root }),
    exportConversation: (runId, workspaceRoot) =>
      req("POST", "/workflow/export", { run_id: runId, workspace_root: workspaceRoot }),
    getSettings: () => req("GET", "/settings"),
    updateSettings: (patch) => req("PUT", "/settings", patch),
    getProviders: () => req("GET", "/providers"),
    getProvider: (id) =>
      req("GET", `/providers/${encodeURIComponent(id)}`),
    createProvider: (input) => req("POST", "/providers", input),
    updateProvider: (id, patch) =>
      req("PUT", `/providers/${encodeURIComponent(id)}`, patch),
    setProviderEnabled: (id, enabled) =>
      req("PUT", `/providers/${encodeURIComponent(id)}/enabled`, { enabled }),
    deleteProvider: (id) =>
      req("DELETE", `/providers/${encodeURIComponent(id)}`),
    testProvider: (id) => req("POST", `/providers/${encodeURIComponent(id)}/test`),
    getModels: (providerId) => req("GET", "/models", undefined, { provider_id: providerId }),

    // ---- Dae Captain v2 Fase 7: chat cards ----
    // Slide
    slideDeck: (root) =>
      req("GET", "/slides/deck", undefined, { root }),
    slideUpdate: (body) => req("POST", "/slides/deck/slide/update", body),
    slideTheme: (body) => req("POST", "/slides/deck/theme", body),
    slideGenerate: (body) => req("POST", "/slides/deck/generate", body),
    slideRegenerate: (body) => req("POST", "/slides/deck/regenerate", body),
    slideDownloadUrl: (root) =>
      baseUrl.replace(/\/+$/, "") + "/slides/deck/download?root=" + encodeURIComponent(root),
    slidePreview: (root) =>
      req("GET", "/slides/deck/preview", undefined, { root }),
    slidePreviewRender: (body) => req("POST", "/slides/deck/preview", body),
    sheetsPreview: (root) =>
      req("GET", "/sheets/workbook/preview", undefined, { root }),
    sheetsPreviewRender: (body) => req("POST", "/sheets/workbook/preview", body),
    dokumenPreview: (root) =>
      req("GET", "/dokumen/preview", undefined, { root }),
    builtinTemplates: () => req("GET", "/slides/builtin-templates"),
    pptTemplates: (root) =>
      req("GET", "/slides/ppt-templates", undefined, { root }),
    importPptTemplate: (root, file) =>
      uploadMultipart("/slides/ppt-templates", { root }, file),
    slideArchive: (root) =>
      req("GET", "/slides/deck/archive", undefined, { root }),
    slideArchiveRestore: (body) =>
      req("POST", "/slides/deck/archive/restore", body),
    // Dokumen
    dokumenDocument: (root) =>
      req("GET", "/dokumen/document", undefined, { root }),
    dokumenOutline: (body) => req("POST", "/dokumen/outline", body),
    dokumenSection: (body) => req("POST", "/dokumen/section", body),
    dokumenExportData: (body) => req("POST", "/dokumen/export-data", body),
    dokumenExportDocument: (body) => req("POST", "/dokumen/export-document", body),
    // Spreadsheet
    sheetsWorkbook: (root) =>
      req("GET", "/sheets/workbook", undefined, { root }),
    sheetsWorkbookSave: (body) => req("POST", "/sheets/workbook", body),
    sheetsGenerate: (body) => req("POST", "/sheets/workbook/generate", body),
    sheetsCheckpoints: (root) =>
      req("GET", "/sheets/workbook/checkpoints", undefined, { root }),
    sheetsRestore: (body) => req("POST", "/sheets/workbook/restore", body),
    sheetsExportUrl: (root) =>
      baseUrl.replace(/\/+$/, "") + "/sheets/workbook/download?root=" + encodeURIComponent(root),
    sheetsAnalyzePlan: (body) => req("POST", "/sheets/analyze/plan", body),
    sheetsAnalyzePlanGet: (planId) =>
      req("GET", `/sheets/analyze/plan/${encodeURIComponent(planId)}`),
    sheetsAnalyzeRun: (body) => req("POST", "/sheets/analyze/run", body),
    sheetsWorkbookOpen: (body) => req("POST", "/sheets/workbook/open", body),
    uploadJson: (body) => req("POST", "/uploads", body),
    // Research
    researchPlan: (body) => req("POST", "/research/plan", body),
    researchPlanGet: (planId) =>
      req("GET", `/research/plan/${encodeURIComponent(planId)}`),
    researchRun: (body) => req("POST", "/research/run", body),
    researchRunStatus: (planId) =>
      req("GET", `/research/run-status/${encodeURIComponent(planId)}`),
    researchProgress: (planId) =>
      req("GET", `/research/progress/${encodeURIComponent(planId)}`),
    researchReport: (reportId) =>
      req("GET", `/research/report/${encodeURIComponent(reportId)}`),
    researchReportDocxUrl: (reportId) =>
      baseUrl.replace(/\/+$/, "") +
      `/captain/research/report/${encodeURIComponent(reportId)}/export?format=docx`,
    // Task plans (decompose.ts via server)
    captainPlan: (body) => req("POST", "/captain/plans", body),
    captainPlanGet: (planId) =>
      req("GET", `/captain/plans/${encodeURIComponent(planId)}`),
    captainPlanExecute: (planId) =>
      req("POST", `/captain/plans/${encodeURIComponent(planId)}/execute`),
    // Approval UndoStore
    captainUndoList: (runId, workspaceRoot) =>
      req("GET", "/captain/undo", undefined, { run_id: runId, workspace_root: workspaceRoot }),
    captainUndoApply: (body) => req("POST", "/captain/undo/apply", body),
    // v2 run timeline (verify/agent events for the chat)
    captainTimeline: (runId, workspaceRoot, after) =>
      req("GET", `/captain/runs/${encodeURIComponent(runId)}/timeline`, undefined, {
        workspace_root: workspaceRoot,
        ...(after ? { after } : {}),
      }),
    /** Raw-bytes download URL for any workspace-relative file. */
    captainDownloadUrl: (root, path) =>
      baseUrl.replace(/\/+$/, "") +
      "/captain/download?root=" + encodeURIComponent(root) +
      "&path=" + encodeURIComponent(path),
    // ---- Dae Captain v2 Fase 8: Workspace + Settings ----
    /** Tier labels + role list (labels Indonesia) from core listRoles(). */
    captainModelRoles: () => req("GET", "/captain/model-roles"),
    /** "Apa yang kamu ingat tentang saya?" — everything remembered. */
    captainMemory: () => req("GET", "/captain/memory"),
    /** Wipe all long-term memory (confirmed in the UI first). */
    captainForgetMemory: () => req("DELETE", "/captain/memory"),
    /** Active reminders, soonest first. */
    captainReminders: () => req("GET", "/captain/reminders"),
    /** Cancel one reminder by id. */
    captainCancelReminder: (id) =>
      req("POST", `/captain/reminders/${encodeURIComponent(id)}/cancel`),
    /**
     * Test an UNSAVED provider config (the add-provider form): fetches
     * /models against the given base URL + key without persisting.
     * Returns { ok, models, message } — the form's Simpan stays disabled
     * until ok is true. Never logs or stores the key.
     */
    testProviderInput: (input) => req("POST", "/providers/test-input", input),
    /**
     * Download a file URL to the user's downloads: fetch bytes (with the
     * daemon token when present), then trigger a real browser download.
     * Throws with a clear message when the server refuses.
     */
    downloadFile: async (url, filename) => {
      const headers = {};
      if (getToken) {
        try {
          const token = await getToken();
          if (token) headers["authorization"] = "Bearer " + token;
        } catch {
          /* no token */
        }
      }
      const res = await fetchFn(url, { headers });
      if (!res.ok) {
        let detail = "";
        try {
          const data = await res.json();
          detail = data?.message ?? data?.error ?? "";
        } catch {
          /* not json */
        }
        throw new Error(`Download gagal (HTTP ${res.status})${detail ? ": " + detail : ""}`);
      }
      const blob = await res.blob();
      const objectUrl = URL.createObjectURL(blob);
      try {
        const a = document.createElement("a");
        a.href = objectUrl;
        a.download = filename || "download";
        document.body.appendChild(a);
        a.click();
        a.remove();
      } finally {
        setTimeout(() => URL.revokeObjectURL(objectUrl), 5000);
      }
      return true;
    },
  };

  /** Multipart upload for endpoints that require it (template import). */
  async function uploadMultipart(path, fields, file) {
    const url = baseUrl.replace(/\/+$/, "") + path;
    const form = new FormData();
    for (const [k, v] of Object.entries(fields ?? {})) {
      if (v !== undefined && v !== null) form.set(k, String(v));
    }
    form.set("file", file, file?.name ?? "upload.bin");
    const headers = {};
    if (getToken) {
      try {
        const token = await getToken();
        if (token) headers["authorization"] = "Bearer " + token;
      } catch {
        /* no token */
      }
    }
    const res = await fetchFn(url, { method: "POST", headers, body: form });
    let data = null;
    try {
      data = await res.json();
    } catch {
      data = null;
    }
    if (!res.ok) {
      const err = new Error(`HTTP ${res.status} POST ${path}`);
      err.status = res.status;
      err.data = data;
      throw err;
    }
    return data;
  }
}

async function streamChat({ baseUrl, fetchImpl, getToken }, body, onDelta, signal) {
  const fetchFn = fetchImpl ?? globalThis.fetch?.bind(globalThis);
  if (!fetchFn) throw new Error("no fetch implementation available");
  const headers = { "content-type": "application/json" };
  if (getToken) {
    try {
      const token = await getToken();
      if (token) headers["authorization"] = "Bearer " + token;
    } catch {
      /* no token — server may still allow (no daemon.json yet) */
    }
  }
  const url = baseUrl.replace(/\/+$/, "") + "/workflow/chat/stream";
  const res = await fetchFn(url, { method: "POST", headers, body: JSON.stringify(body), ...(signal ? { signal } : {}) });
  const contentType = res.headers?.get("content-type") ?? "";
  if (!contentType.includes("text/event-stream")) {
    let data = null;
    try {
      data = await res.json();
    } catch {
      data = null;
    }
    if (!res.ok) {
      const err = new Error(`HTTP ${res.status} POST /workflow/chat/stream`);
      err.status = res.status;
      err.data = data;
      throw err;
    }
    return data;
  }
  if (!res.ok || !res.body) {
    throw new Error(`HTTP ${res.status} POST /workflow/chat/stream`);
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let text = "";
  let runId;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      const ev = parseStreamLine(line);
      if (!ev) continue;
      if ("delta" in ev && typeof ev.delta === "string" && ev.delta) {
        text += ev.delta;
        try {
          onDelta?.(ev.delta);
        } catch {
          /* caller rendering must never break the stream */
        }
      } else if ("done" in ev && ev.done) {
        if (ev.run_id !== undefined) runId = ev.run_id;
        return { kind: "chat", text: typeof ev.text === "string" ? ev.text : text, run_id: runId };
      } else if ("error" in ev && typeof ev.error === "string") {
        const err = new Error(ev.error);
        err.partial = text;
        throw err;
      }
    }
  }
  // The socket closed without a done frame: return what arrived rather
  // than failing an answer the user already read.
  return { kind: "chat", text, run_id: runId };
}
