import { readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadSettings, resolveDaedalusHome } from "@daedalus/core";
import {
  attachWebSocket,
  createApp,
  createContext,
  ensureProvidersLoaded,
  sweepStaleWorkflowRuns,
} from "./app.ts";

const settings = loadSettings();
const ctx = createContext();

let server: ReturnType<typeof createApp> | undefined;
let channel: ReturnType<typeof attachWebSocket> | undefined;
let shuttingDown = false;

async function shutdown(reason: string, code = 0): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  ctx.log.info("shutting down", { reason, active_tasks: ctx.activeRunners.size });
  const hard = setTimeout(() => process.exit(code), 5_000); // batas keras
  hard.unref();
  try {
    channel?.close();
  } catch {
    /* sudah tertutup */
  }
  try {
    server?.close();
    server?.closeIdleConnections?.();
  } catch {
    /* belum listen */
  }
  // Task yang sedang jalan sengaja dibiarkan: boot berikutnya menutupnya jujur
  // (reconcileInterruptedTasks + sweepStaleWorkflowRuns).
  try {
    await ctx.terminals.disposeAndWait();
  } catch {
    /* best effort */
  }
  process.exit(code);
}

// Jaring pengaman: satu promise yang lupa di-catch tidak boleh membunuh server beserta semua task.
process.on("unhandledRejection", (reason) => {
  ctx.log.error("unhandled rejection", {
    error: reason instanceof Error ? (reason.stack ?? reason.message) : String(reason),
  });
});
process.on("uncaughtException", (error) => {
  ctx.log.error("uncaught exception", { error: error.stack ?? error.message });
  void shutdown("uncaughtException", 1); // state tidak bisa dipercaya lagi: berhenti dengan bersih
});

// Provider yang gagal dimuat (file rusak/belum ada) TIDAK boleh mencegah server naik: pengguna harus tetap bisa
// membuka Settings dan membetulkannya. ensureProvidersLoaded tidak men-cache kegagalan, jadi request berikutnya
// mencoba lagi dengan sendirinya.
try {
  await ensureProvidersLoaded(ctx);
} catch (error) {
  ctx.log.warn("providers failed to load at startup — server tetap dijalankan; akan dicoba lagi saat dibutuhkan", {
    error: String(error),
  });
}

// Turn "running" dari proses sebelumnya tidak mungkin selesai → tutup di SEMUA home yang dikenal
// (bukan hanya process.cwd(), yang bisa berbeda dari workspace saat dijalankan oleh Tauri).
try {
  const marked = sweepStaleWorkflowRuns(ctx);
  if (marked > 0) ctx.log.info("marked stale running turns as interrupted", { count: marked });
} catch (error) {
  ctx.log.warn("stale task cleanup failed", { error: String(error) });
}

/** Pastikan daemon.json di disk memuat token yang dipegang proses ini (lawan race dengan sidecar Tauri). */
function syncDaemonToken(): void {
  try {
    const token = ctx.daemonToken;
    if (!token) return;
    const home = resolveDaedalusHome(settings.daedalusHome, ctx.session.workspaceRoot || ctx.cwd);
    const path = join(home, "daemon.json");
    let doc: Record<string, unknown> = {};
    try {
      const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
      if (parsed && typeof parsed === "object") doc = parsed as Record<string, unknown>;
    } catch {
      /* belum ada / rusak: tulis baru */
    }
    if (doc.token === token) return;
    const tmp = `${path}.tmp`;
    writeFileSync(tmp, JSON.stringify({ ...doc, token }, null, 2) + "\n");
    renameSync(tmp, path);
  } catch (error) {
    ctx.log.warn("daemon token sync failed", { error: String(error) });
  }
}

server = createApp(ctx);
channel = attachWebSocket(ctx, server);

server.on("error", (error: NodeJS.ErrnoException) => {
  const hint = error.code === "EADDRINUSE" ? ` — port ${settings.server.port} sudah dipakai proses lain` : "";
  ctx.log.error(`server error${hint}`, { error: String(error) });
  void shutdown("server_error", 1);
});

server.listen(settings.server.port, settings.server.host, () => {
  ctx.log.info("server listening", {
    host: settings.server.host,
    port: settings.server.port,
    health: `http://${settings.server.host}:${settings.server.port}/health`,
    ws: `ws://${settings.server.host}:${settings.server.port}/tasks/events`,
  });
  syncDaemonToken();
  setTimeout(syncDaemonToken, 2_000).unref(); // sidecar Tauri menulis daemon.json sesaat setelah spawn
});

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => void shutdown(signal));
}
