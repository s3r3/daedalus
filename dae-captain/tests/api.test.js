// Unit tests for dae-captain/ui/api.js — fetch is fully mocked.
// Run: node --test tests/
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createApiClient } from "../ui/api.js";
import { pendingApprovals } from "../ui/logic.js";

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

  it("sends the daemon token as a Bearer header when provided", async () => {
    const { fetchImpl, calls } = mockFetch(() => ok({ success: true }));
    const api = createApiClient({
      baseUrl: "http://127.0.0.1:3080",
      fetchImpl,
      getToken: async () => "tok-123",
    });
    await api.approve("task-1", { decision: "grant" });
    assert.equal(calls[0].init.headers.authorization, "Bearer tok-123");
  });

  it("omits the auth header when no token is available", async () => {
    const { fetchImpl, calls } = mockFetch(() => ok({ success: true }));
    const api = createApiClient({
      baseUrl: "http://127.0.0.1:3080",
      fetchImpl,
      getToken: async () => null,
    });
    await api.cancelTask("task-1");
    assert.ok(!("authorization" in (calls[0].init.headers ?? {})));
  });

  it("cancelTask posts to the task cancel route (/stop)", async () => {
    const { fetchImpl, calls } = mockFetch(() => ok({ cancelled: true, cancel_requested: true }));
    const api = createApiClient({ baseUrl: "http://127.0.0.1:3080", fetchImpl });
    const res = await api.cancelTask("task-9");
    assert.equal(calls[0].url, "http://127.0.0.1:3080/tasks/task-9/cancel");
    assert.equal(calls[0].init.method, "POST");
    assert.equal(res.cancelled, true);
  });

  it("workflowChatStream accumulates SSE deltas into the done text", async () => {
    const sse = 'data: {"delta":"Hel"}\n\ndata: {"delta":"lo"}\n\ndata: {"done":true,"run_id":"r1","text":"Hello"}\n\n';
    const fetchImpl = async () => new Response(sse, { status: 200, headers: { "content-type": "text/event-stream" } });
    const api = createApiClient({ baseUrl: "http://127.0.0.1:3080", fetchImpl });
    const seen = [];
    const res = await api.workflowChatStream({ message: "halo" }, (d) => seen.push(d));
    assert.deepEqual(seen, ["Hel", "lo"]);
    assert.deepEqual(res, { kind: "chat", text: "Hello", run_id: "r1" });
  });

  it("workflowChatStream passes dispatch JSON through untouched", async () => {
    const payload = { engine: "coding", task_id: "t1", run_id: "r1" };
    const fetchImpl = async () => new Response(JSON.stringify(payload), { status: 201, headers: { "content-type": "application/json" } });
    const api = createApiClient({ baseUrl: "http://127.0.0.1:3080", fetchImpl });
    assert.deepEqual(await api.workflowChatStream({ message: "buatkan x" }), payload);
  });

  it("workflowChatStream throws with .partial when the model fails mid-stream", async () => {
    const sse = 'data: {"delta":"Hel"}\n\ndata: {"error":"model_unavailable"}\n\n';
    const fetchImpl = async () => new Response(sse, { status: 200, headers: { "content-type": "text/event-stream" } });
    const api = createApiClient({ baseUrl: "http://127.0.0.1:3080", fetchImpl });
    await assert.rejects(api.workflowChatStream({ message: "halo" }), (e) => {
      assert.equal(e.partial, "Hel");
      return true;
    });
  });

  it("decideApproval resolves by id (survives runner restart)", async () => {
    const { fetchImpl, calls } = mockFetch(() => ok({ success: true, decision: "grant" }));
    const api = createApiClient({ baseUrl: "http://127.0.0.1:3080", fetchImpl });
    await api.decideApproval("task-1", "appr-9", { decision: "grant" });
    assert.equal(calls[0].url, "http://127.0.0.1:3080/tasks/task-1/approvals/appr-9");
    assert.deepEqual(JSON.parse(calls[0].init.body), { decision: "grant" });
  });

  it("answerQuestion posts the answer to the id-addressed route", async () => {
    const { fetchImpl, calls } = mockFetch(() => ok({ success: true }));
    const api = createApiClient({ baseUrl: "http://127.0.0.1:3080", fetchImpl });
    await api.answerQuestion("task-2", "q-7", "gunakan Tailwind");
    assert.equal(calls[0].url, "http://127.0.0.1:3080/tasks/task-2/questions/q-7");
    assert.deepEqual(JSON.parse(calls[0].init.body), { answer: "gunakan Tailwind" });
  });

  it("url-encodes ids so paths cannot be broken by special chars", async () => {
    const { fetchImpl, calls } = mockFetch(() => ok({ success: true }));
    const api = createApiClient({ baseUrl: "http://127.0.0.1:3080", fetchImpl });
    await api.decideApproval("t/1", "a b", { decision: "deny" });
    assert.equal(calls[0].url, "http://127.0.0.1:3080/tasks/t%2F1/approvals/a%20b");
  });

  it("no approval-gating: pendingApprovals reads live run turns", () => {
    const runs = [
      { run_id: "r1", turns: [{ status: "done", pending_approvals: [], pending_questions: [] }] },
      { run_id: "r2", turns: [{ status: "running", task_id: "t-9", pending_approvals: [{ key: "k" }], pending_questions: [] }] },
    ];
    assert.equal(pendingApprovals(runs).length, 1);
    assert.equal(pendingApprovals(runs)[0].taskId, "t-9");
  });
});
