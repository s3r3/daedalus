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
  };
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
