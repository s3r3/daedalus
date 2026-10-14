// Dae Captain UI — HTTP client for the Daedalus server API.
// `fetchImpl` is injectable so unit tests run without a server.
// Never logs or stores API keys; the server redacts them.

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
    workflowRuns: (workspaceRoot) =>
      req("GET", "/workflow/runs", undefined, { workspace_root: workspaceRoot }),
    workflowRun: (id, workspaceRoot) =>
      req("GET", `/workflow/runs/${encodeURIComponent(id)}`, undefined, {
        workspace_root: workspaceRoot,
      }),
    approve: (taskId, payload) =>
      req("POST", `/tasks/${encodeURIComponent(taskId)}/approve`, payload),
    cancelTask: (taskId) =>
      req("POST", `/tasks/${encodeURIComponent(taskId)}/cancel`),
    taskEvents: (taskId) =>
      req("GET", `/tasks/${encodeURIComponent(taskId)}/events`),
    getSettings: () => req("GET", "/settings"),
    updateSettings: (patch) => req("PUT", "/settings", patch),
    getProviders: () => req("GET", "/providers"),
    createProvider: (input) => req("POST", "/providers", input),
    testProvider: (id) => req("POST", `/providers/${encodeURIComponent(id)}/test`),
    getModels: (providerId) => req("GET", "/models", undefined, { provider_id: providerId }),
  };
}
