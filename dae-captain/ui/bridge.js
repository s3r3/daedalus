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
