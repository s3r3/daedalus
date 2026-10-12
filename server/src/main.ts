import { loadSettings } from "@daedalus/core";
import { attachWebSocket, createContext, createApp, ensureProvidersLoaded } from "./app.ts";

const settings = loadSettings();
const ctx = createContext();
await ensureProvidersLoaded(ctx);
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
