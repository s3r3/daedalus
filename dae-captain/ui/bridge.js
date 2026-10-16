// Dae Captain UI — Tauri v2 IPC bridge.
//
// The Tauri 2 webview injects `window.__TAURI_INTERNALS__.invoke(cmd, payload)`
// (see the `tauri` crate's `scripts/core.js`). The old Tauri v1 global
// `window.__TAURI__` does NOT exist in Tauri 2 — detecting it always fails,
// which silently disabled every invoke() and left the app broken downstream
// (chat "state.api is null", empty settings dropdowns, dead test-connection,
// "Tauri bridge unavailable" on workspace validation).
//
// `win` is injectable so unit tests can simulate the real webview shape.

export function detectBridge(win) {
  const internals = win?.__TAURI_INTERNALS__ ?? null;
  const invoke = internals?.invoke;
  if (!internals || typeof invoke !== "function") return null;
  return { invoke: invoke.bind(internals) };
}

export function createInvoker(win) {
  const bridge = detectBridge(win);
  return async function invoke(cmd, args = {}) {
    if (!bridge) {
      throw new Error(
        `Tauri bridge unavailable (command ${cmd}) — jalankan di aplikasi Dae Captain`
      );
    }
    return bridge.invoke(cmd, args);
  };
}

// Window resize via the core window plugin, the same way Tauri's own
// injected scripts do it (`window/scripts/drag.js`).
export const WINDOW_SET_SIZE_CMD = "plugin:window|set_size";

export function setSizePayload(w, h) {
  return { value: { Logical: { width: w, height: h } } };
}

/**
 * Minimal Tauri v2 event listener without @tauri-apps/api.
 * Uses window.__TAURI_INTERNALS__.transformCallback to register the JS
 * handler, then invokes plugin:event|listen (target Any). Resolves to the
 * event id; rejects when the Tauri bridge is unavailable (plain browser).
 */
export async function listenEvent(win, eventName, handler) {
  const internals = win?.__TAURI_INTERNALS__ ?? null;
  if (!internals || typeof internals.invoke !== "function" || typeof internals.transformCallback !== "function") {
    throw new Error(`Tauri bridge unavailable (event ${eventName}) — jalankan di aplikasi Dae Captain`);
  }
  const handlerId = internals.transformCallback((event) => {
    try {
      handler(event?.payload, event);
    } catch (e) {
      console.error("event handler failed:", e);
    }
  });
  return internals.invoke("plugin:event|listen", {
    event: eventName,
    target: { kind: "Any" },
    handler: handlerId,
  });
}
