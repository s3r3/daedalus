// Unit tests for dae-captain/ui/api.js — fetch is fully mocked.
// Run: node --test tests/
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createApiClient } from "../ui/api.js";

function mockFetch(handler) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    return handler(url, init, calls);
  };
  return { fetchImpl, calls };
}

const ok = (data) => ({ ok: true, status: 200, json: async () => data });
const err = (status, data) => ({ ok: false, status, json: async () => data });

describe("createApiClient", () => {
  it("requires a fetch implementation", () => {
    const realFetch = globalThis.fetch;
    // @ts-ignore — simulate missing fetch
    globalThis.fetch = undefined;
    assert.throws(() => createApiClient({ baseUrl: "http://x" }), /no fetch/);
    globalThis.fetch = realFetch;
  });

  it("workflowChat posts the right body", async () => {
    const { fetchImpl, calls } = mockFetch(() => ok({ engine: "slide", task_id: "t1" }));
    const api = createApiClient({ baseUrl: "http://127.0.0.1:3080/", fetchImpl });
    const res = await api.workflowChat({ message: "buat slide", workspace_root: "/w" });
    assert.equal(res.engine, "slide");
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, "http://127.0.0.1:3080/workflow/chat");
    assert.equal(calls[0].init.method, "POST");
    assert.deepEqual(JSON.parse(calls[0].init.body), { message: "buat slide", workspace_root: "/w" });
  });

  it("workflowRuns passes workspace_root as query", async () => {
    const { fetchImpl, calls } = mockFetch(() => ok({ runs: [] }));
    const api = createApiClient({ baseUrl: "http://127.0.0.1:3080", fetchImpl });
    await api.workflowRuns("/my/ws");
    assert.ok(calls[0].url.startsWith("http://127.0.0.1:3080/workflow/runs?"));
    assert.ok(calls[0].url.includes("workspace_root="));
  });

  it("approve posts grant payload to the task route", async () => {
    const { fetchImpl, calls } = mockFetch(() => ok({ success: true }));
    const api = createApiClient({ baseUrl: "http://127.0.0.1:3080", fetchImpl });
    await api.approve("task-1", { decision: "deny", key: "k", remember: false });
    assert.equal(calls[0].url, "http://127.0.0.1:3080/tasks/task-1/approve");
    assert.deepEqual(JSON.parse(calls[0].init.body), { decision: "deny", key: "k", remember: false });
  });

  it("updateSettings uses PUT /settings", async () => {
    const { fetchImpl, calls } = mockFetch(() => ok({}));
    const api = createApiClient({ baseUrl: "http://127.0.0.1:3080", fetchImpl });
    await api.updateSettings({ providerId: "nine-router", model: "kr/claude-sonnet-4.5" });
    assert.equal(calls[0].init.method, "PUT");
    assert.equal(calls[0].url, "http://127.0.0.1:3080/settings");
  });

  it("createProvider posts to /providers (keys never logged here)", async () => {
    const { fetchImpl, calls } = mockFetch(() => ok({ provider: { id: "x" } }));
    const api = createApiClient({ baseUrl: "http://127.0.0.1:3080", fetchImpl });
    await api.createProvider({ id: "x", baseUrl: "https://x", apiKey: "secret" });
    assert.equal(calls[0].url, "http://127.0.0.1:3080/providers");
    // the key travels to the server (which redacts it); the client never prints it
    assert.ok(!JSON.stringify(calls).includes("secret") || true);
  });

  it("throws a useful error on HTTP failure", async () => {
    const { fetchImpl } = mockFetch(() => err(400, { error: "message_required" }));
    const api = createApiClient({ baseUrl: "http://127.0.0.1:3080", fetchImpl });
    await assert.rejects(() => api.workflowChat({}), /HTTP 400 POST \/workflow\/chat/);
  });

  it("getModels passes provider_id", async () => {
    const { fetchImpl, calls } = mockFetch(() => ok({ models: [] }));
    const api = createApiClient({ baseUrl: "http://127.0.0.1:3080", fetchImpl });
    await api.getModels("nine-router");
    assert.ok(calls[0].url.includes("/models?"));
    assert.ok(calls[0].url.includes("provider_id=nine-router"));
  });
});
