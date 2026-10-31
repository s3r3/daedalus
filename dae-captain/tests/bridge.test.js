// Unit tests for dae-captain/ui/bridge.js — run: node --test tests/
//
// Regression coverage for the Tauri v2 bridge bug: the frontend detected the
// old Tauri v1 global `window.__TAURI__`, which does not exist in Tauri 2
// webviews, so every invoke() threw and the whole app (chat, settings,
// workspace) broke downstream while the unit tests kept passing on a v1 mock.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  detectBridge,
  createInvoker,
} from "../ui/bridge.js";

const tauri2Window = (invokeImpl) => ({
  __TAURI_INTERNALS__: {
    invoke: invokeImpl ?? (async (cmd, args) => ({ cmd, args })),
  },
});

describe("detectBridge", () => {
  it("finds the real Tauri 2 bridge", () => {
    const bridge = detectBridge(tauri2Window());
    assert.ok(bridge, "expected a bridge object");
    assert.equal(typeof bridge.invoke, "function");
  });

  it("rejects the old Tauri v1 shape (__TAURI__.core)", () => {
    const v1Window = {
      __TAURI__: { core: { invoke: async () => ({}) }, window: {} },
    };
    assert.equal(detectBridge(v1Window), null);
  });

  it("rejects missing/empty globals", () => {
    assert.equal(detectBridge({}), null);
    assert.equal(detectBridge(undefined), null);
    assert.equal(detectBridge(null), null);
    assert.equal(detectBridge({ __TAURI_INTERNALS__: {} }), null);
  });
});

describe("createInvoker", () => {
  it("forwards cmd and args to __TAURI_INTERNALS__.invoke", async () => {
    const seen = [];
    const invoke = createInvoker(
      tauri2Window(async (cmd, args) => {
        seen.push([cmd, args]);
        return "ok";
      })
    );
    const result = await invoke("server_health", { a: 1 });
    assert.equal(result, "ok");
    assert.deepEqual(seen, [["server_health", { a: 1 }]]);
  });

  it("defaults args to {}", async () => {
    const seen = [];
    const invoke = createInvoker(
      tauri2Window(async (cmd, args) => {
        seen.push([cmd, args]);
      })
    );
    await invoke("node_available");
    assert.deepEqual(seen, [["node_available", {}]]);
  });

  it("throws the friendly bridge error when unavailable", async () => {
    const invoke = createInvoker({});
    await assert.rejects(
      () => invoke("server_health"),
      /Tauri bridge unavailable \(command server_health\)/
    );
  });
});

