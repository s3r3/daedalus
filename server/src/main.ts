import { loadSettings } from "@daedalus/core";
import { attachWebSocket, createContext, createApp, ensureProvidersLoaded } from "./app.ts";
import { WorkflowRunStore } from "@daedalus/core/workflow/store.ts";
import { resolveDaedalusHome } from "@daedalus/core";

const settings = loadSettings();
const ctx = createContext();
await ensureProvidersLoaded(ctx);

// Clean up stale "running" turns from a previous server process.
// A restart means those turns can never complete — mark them interrupted
// so the UI doesn't show phantom active tasks.
try {
  const store = new WorkflowRunStore(resolveDaedalusHome(settings.daedalusHome, process.cwd()));
  const marked = store.markStaleRunningInterrupted();
  if (marked > 0) ctx.log.info("marked stale running turns as interrupted", { count: marked });
} catch (e) {
  ctx.log.warn("stale task cleanup failed", { error: String(e) });
}

const server = createApp(ctx);
const channel = attachWebSocket(ctx, server);

server.listen(settings.server.port, settings.server.host, () => {
  ctx.log.info("server listening", {
    host: settings.server.host,
    port: settings.server.port,
    health: `http://${settings.server.host}:${settings.server.port}/health`,
    ws: `ws://${settings.server.host}:${settings.server.port}/tasks/events`,
  });
});

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    ctx.log.info("shutting down", { signal });
    ctx.terminals.dispose();
    channel.close();
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 1000).unref();
  });
}
