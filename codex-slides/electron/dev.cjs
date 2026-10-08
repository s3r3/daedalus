const { spawn, spawnSync } = require("node:child_process");
const crypto = require("node:crypto");
const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");
const electronBinary = require("electron");

const PRODUCT_NAME = "Codex Slides";
const PROJECT_ROOT = path.resolve(__dirname, "..");
const DEFAULT_URL = "http://127.0.0.1:4311";
const TARGETS = new Set(["all", "web", "desktop"]);
const COMMANDS = new Set(["run", "start", "stop", "restart", "status", "logs"]);
const RUNTIME_DIR = path.join(PROJECT_ROOT, ".tmp", "dev-runtime");
const desktopBuilderConfig = path.join(PROJECT_ROOT, "electron-builder.dev.yml");
const electronBuilderCli = require.resolve("electron-builder/cli.js");
const nextBinary = require.resolve("next/dist/bin/next");

let web = null;
let desktop = null;
let ownsWeb = false;
let closing = false;
let shutdownPromise = null;
let generatedTsConfigPath = null;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function printHelp() {
  process.stdout.write(`${PRODUCT_NAME} development runner

Usage:
  pnpm dev [command] [all|web|desktop] [options]

Commands:
  run [target]        Start in the foreground and stream logs (default)
  start [target]      Start in the background (daemon); logs go to .tmp/dev-runtime
  stop [target]       Stop background services
  restart [target]    Restart background services (stop then start)
  status [target]     Show background service status
  logs [target]       Tail background service logs

Targets:
  all                 Web + Desktop (default)
  web                 Web service only
  desktop             Desktop and its Web dependency

Options:
  --web-port <port>   Override the port from CODEX_SLIDES_URL
  --json              Machine-readable output (status)
  -f, --follow        Follow log output (logs)
  -h, --help          Show this help

Examples:
  pnpm dev                     Foreground Web + Desktop
  pnpm dev:web                 Foreground Web only
  pnpm dev:start               Background Web + Desktop
  pnpm dev:start web           Background Web only
  pnpm dev:status              Show what is running
  pnpm dev:logs web -f         Follow the Web daemon log
  pnpm dev:restart             Restart everything
  pnpm dev:stop                Stop everything
`);
}

function parsePort(value) {
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error("--web-port must be an integer between 1 and 65535");
  }
  return port;
}

function parseArgs(argv) {
  let command = "run";
  let commandSet = false;
  let target = null;
  let webPort = null;
  let json = false;
  let follow = false;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--") continue;
    if (arg === "-h" || arg === "--help") {
      return { help: true, command, target: target ?? "all", webPort, json, follow };
    }
    if (arg === "--json") {
      json = true;
      continue;
    }
    if (arg === "-f" || arg === "--follow") {
      follow = true;
      continue;
    }
    if (arg === "--web-port") {
      const value = argv[index + 1];
      if (value == null) throw new Error("--web-port requires a value");
      webPort = parsePort(value);
      index += 1;
      continue;
    }
    if (arg.startsWith("--web-port=")) {
      webPort = parsePort(arg.slice("--web-port=".length));
      continue;
    }
    if (!arg.startsWith("-") && !commandSet && COMMANDS.has(arg)) {
      command = arg;
      commandSet = true;
      continue;
    }
    if (!arg.startsWith("-") && target == null && TARGETS.has(arg)) {
      target = arg;
      continue;
    }
    throw new Error(`Unknown development runner argument: ${arg}`);
  }

  return { help: false, command, target: target ?? "all", webPort, json, follow };
}

function resolveAppUrl(webPort) {
  let appUrl;
  try {
    appUrl = new URL(process.env.CODEX_SLIDES_URL || DEFAULT_URL);
  } catch {
    throw new Error("CODEX_SLIDES_URL must be a valid absolute URL");
  }
  if (appUrl.protocol !== "http:") {
    throw new Error("The development runner requires an http:// CODEX_SLIDES_URL");
  }
  if (appUrl.username || appUrl.password) {
    throw new Error("CODEX_SLIDES_URL must not contain credentials");
  }
  if (webPort != null) appUrl.port = String(webPort);
  return appUrl;
}

function displayUrl(appUrl) {
  return appUrl.toString().replace(/\/$/, "");
}

function healthUrl(appUrl) {
  return new URL("/api/agents", appUrl);
}

function isCodexSlidesHealthPayload(value) {
  return Boolean(value && typeof value === "object" && Array.isArray(value.agents));
}

function probeDevServer(appUrl, timeoutMs = 1_500) {
  return new Promise((resolve) => {
    let settled = false;
    let body = "";
    const finish = (ready) => {
      if (settled) return;
      settled = true;
      resolve(ready);
    };
    const request = http.get(healthUrl(appUrl), { headers: { accept: "application/json" } }, (response) => {
      response.setEncoding("utf8");
      response.on("data", (chunk) => {
        body += chunk;
        if (body.length > 1_000_000) {
          response.destroy();
          finish(false);
        }
      });
      response.once("end", () => {
        if (response.statusCode !== 200) {
          finish(false);
          return;
        }
        try {
          finish(isCodexSlidesHealthPayload(JSON.parse(body)));
        } catch {
          finish(false);
        }
      });
      response.once("error", () => finish(false));
    });
    request.setTimeout(timeoutMs, () => {
      request.destroy();
      finish(false);
    });
    request.once("error", () => finish(false));
  });
}

async function waitForDevServer(appUrl, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  while (!closing && Date.now() < deadline) {
    if (await probeDevServer(appUrl)) return;
    await sleep(300);
  }
  if (closing) throw new Error("Web service stopped before becoming ready");
  throw new Error(`Web service did not start at ${displayUrl(appUrl)}`);
}

function activeChild(child) {
  return Boolean(child?.pid && child.exitCode == null && child.signalCode == null);
}

function stopChild(child, signal = "SIGTERM") {
  if (!activeChild(child)) return;
  if (process.platform === "win32") {
    const killer = spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], {
      stdio: "ignore",
      windowsHide: true,
    });
    killer.unref();
    return;
  }
  try {
    process.kill(-child.pid, signal);
  } catch {
    child.kill(signal);
  }
}

function waitForChild(child) {
  if (!activeChild(child)) return Promise.resolve();
  return new Promise((resolve) => child.once("exit", resolve));
}

function shutdown(code = 0) {
  if (shutdownPromise) {
    if (code !== 0) process.exitCode = code;
    return shutdownPromise;
  }

  closing = true;
  process.exitCode = code;
  const children = [desktop, ownsWeb ? web : null].filter(activeChild);
  const exits = children.map(waitForChild);

  shutdownPromise = (async () => {
    try {
      for (const child of children) stopChild(child);
      if (children.length === 0) return;

      let forceTimer;
      await Promise.race([
        Promise.all(exits),
        new Promise((resolve) => {
          forceTimer = setTimeout(() => {
            for (const child of children) stopChild(child, "SIGKILL");
            resolve();
          }, 3_000);
        }),
      ]);
      if (forceTimer) clearTimeout(forceTimer);
    } finally {
      if (generatedTsConfigPath) fs.rmSync(generatedTsConfigPath, { force: true });
      generatedTsConfigPath = null;
    }
  })();

  return shutdownPromise;
}

function localBindHost(appUrl) {
  if (appUrl.hostname === "localhost") return "127.0.0.1";
  if (appUrl.hostname === "127.0.0.1" || appUrl.hostname === "[::1]") {
    return appUrl.hostname.replaceAll("[", "").replaceAll("]", "");
  }
  throw new Error(
    `No reusable Web service found at ${displayUrl(appUrl)}. Automatic startup requires a loopback CODEX_SLIDES_URL.`,
  );
}

function effectivePort(appUrl) {
  return appUrl.port || "80";
}

function devDistDir(appUrl) {
  const configured = process.env.CODEX_SLIDES_DIST_DIR?.trim();
  if (configured) return configured;
  return `.next-dev/port-${effectivePort(appUrl)}`;
}

function prepareDevTsConfig(appUrl, distDir) {
  const fileName = `tsconfig.next-dev-${effectivePort(appUrl)}.json`;
  const base = JSON.parse(fs.readFileSync(path.join(PROJECT_ROOT, "tsconfig.json"), "utf8"));
  const include = Array.isArray(base.include) ? base.include : ["next-env.d.ts", "**/*.ts", "**/*.tsx"];
  const nextTypes = `${distDir}/types/**/*.ts`;
  const config = {
    ...base,
    include: [...new Set([...include, nextTypes])],
  };
  const fullPath = path.join(PROJECT_ROOT, fileName);
  fs.writeFileSync(fullPath, `${JSON.stringify(config, null, 2)}\n`, "utf8");
  return { fileName, fullPath };
}

async function startWebService(appUrl) {
  const host = localBindHost(appUrl);
  const port = effectivePort(appUrl);
  const distDir = devDistDir(appUrl);
  const { fileName: tsConfigPath, fullPath } = prepareDevTsConfig(appUrl, distDir);
  generatedTsConfigPath = fullPath;
  let startupSettled = false;
  let rejectStartup;
  const startupFailure = new Promise((_, reject) => {
    rejectStartup = reject;
  });

  ownsWeb = true;
  process.stdout.write(`[codex-slides] Starting Web service at ${displayUrl(appUrl)}\n`);
  web = spawn(process.execPath, [nextBinary, "dev", "-H", host, "-p", port], {
    detached: process.platform !== "win32",
    stdio: "inherit",
    env: {
      ...process.env,
      CODEX_SLIDES_URL: displayUrl(appUrl),
      CODEX_SLIDES_DIST_DIR: distDir,
      CODEX_SLIDES_TSCONFIG_PATH: tsConfigPath,
    },
  });
  web.once("error", (error) => {
    if (!startupSettled) rejectStartup(new Error(`Web service failed: ${error.message}`));
    else if (!closing) void shutdown(1);
  });
  web.once("exit", (code, signal) => {
    if (closing) return;
    const detail = signal || code || 0;
    if (!startupSettled) rejectStartup(new Error(`Web service exited before becoming ready (${detail})`));
    else void shutdown(code || 1);
  });

  await Promise.race([waitForDevServer(appUrl), startupFailure]);
  startupSettled = true;
  process.stdout.write(`[codex-slides] Web service ready at ${displayUrl(appUrl)}\n`);
}

async function ensureWebServer(appUrl) {
  if (await probeDevServer(appUrl, 700)) {
    process.stdout.write(`[codex-slides] Reusing Web service at ${displayUrl(appUrl)}\n`);
    return;
  }
  await startWebService(appUrl);
}

function desktopEnvironment(appUrl) {
  const env = {
    ...process.env,
    CODEX_SLIDES_URL: displayUrl(appUrl),
    // Isolate the dev shell's profile. It otherwise shares the production
    // app's userData directory, so the two fight over the same
    // single-instance lock and dev sessions kill an installed Codex Slides
    // (or the other way round).
    CODEX_SLIDES_USER_DATA_DIR: path.join(RUNTIME_DIR, "desktop-user-data"),
  };
  for (const key of Object.keys(env)) {
    if (key.toUpperCase() === "ELECTRON_RUN_AS_NODE") delete env[key];
  }
  return env;
}

function desktopShellFingerprint() {
  const hash = crypto.createHash("sha256");
  for (const file of [
    path.join(PROJECT_ROOT, "electron", "main.cjs"),
    path.join(PROJECT_ROOT, "electron", "preload.cjs"),
    path.join(PROJECT_ROOT, "electron", "package.json"),
    path.join(PROJECT_ROOT, "public", "brand", "codex-slides-app-icon.png"),
    desktopBuilderConfig,
  ]) {
    hash.update(file);
    hash.update(fs.readFileSync(file));
  }
  hash.update(electronBinary);
  return hash.digest("hex");
}

function findMacDesktopBinary(outputRoot) {
  for (const directory of ["mac-arm64", "mac", "mac-x64"]) {
    const executable = path.join(outputRoot, directory, `${PRODUCT_NAME}.app`, "Contents", "MacOS", PRODUCT_NAME);
    if (fs.existsSync(executable)) return executable;
  }
  return null;
}

function ensureMacDesktopBinary() {
  if (process.platform !== "darwin") return electronBinary;

  const outputRoot = path.join(PROJECT_ROOT, ".tmp", "electron-dev-build");
  const markerPath = path.join(outputRoot, "codex-slides-dev-shell.json");
  const fingerprint = desktopShellFingerprint();
  const existing = findMacDesktopBinary(outputRoot);
  if (existing && fs.existsSync(markerPath)) {
    try {
      if (fs.readFileSync(markerPath, "utf8") === fingerprint) return existing;
    } catch {
      // Rebuild the generated shell below.
    }
  }

  process.stdout.write("[codex-slides] Preparing branded macOS Desktop shell\n");
  const built = spawnSync(process.execPath, [
    electronBuilderCli,
    "--mac",
    "--dir",
    "--config",
    desktopBuilderConfig,
    "--publish",
    "never",
  ], {
    cwd: PROJECT_ROOT,
    env: { ...process.env, CSC_IDENTITY_AUTO_DISCOVERY: "false" },
    stdio: "inherit",
  });
  if (built.status !== 0) {
    throw new Error(`Could not build branded macOS desktop shell (exit ${built.status ?? "unknown"})`);
  }

  const executable = findMacDesktopBinary(outputRoot);
  if (!executable) throw new Error(`Branded macOS desktop shell was not produced in ${outputRoot}`);
  fs.writeFileSync(markerPath, fingerprint, "utf8");
  return executable;
}

function startDesktop(appUrl) {
  process.stdout.write(`[codex-slides] Starting Desktop against ${displayUrl(appUrl)}\n`);
  desktop = spawn(ensureMacDesktopBinary(), [PROJECT_ROOT], {
    detached: process.platform !== "win32",
    stdio: "inherit",
    env: desktopEnvironment(appUrl),
  });
  desktop.once("error", (error) => {
    process.stderr.write(`[codex-slides] Desktop failed: ${error.message}\n`);
    void shutdown(1);
  });
  desktop.once("exit", (code) => {
    if (!closing) void shutdown(code ?? 0);
  });
}

// --- Background daemon lifecycle -------------------------------------------

function ensureRuntimeDir() {
  fs.mkdirSync(RUNTIME_DIR, { recursive: true });
}

function stateFile(target) {
  return path.join(RUNTIME_DIR, `${target}.json`);
}

function logFile(target) {
  return path.join(RUNTIME_DIR, `${target}.log`);
}

function readState(target) {
  try {
    const state = JSON.parse(fs.readFileSync(stateFile(target), "utf8"));
    return state && typeof state === "object" ? state : null;
  } catch {
    return null;
  }
}

function writeState(target, state) {
  ensureRuntimeDir();
  fs.writeFileSync(stateFile(target), `${JSON.stringify(state, null, 2)}\n`, "utf8");
}

function clearState(target) {
  fs.rmSync(stateFile(target), { force: true });
}

function label(target) {
  return target === "web" ? "Web daemon" : "Desktop daemon";
}

function isPidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === "EPERM";
  }
}

function killPidGroup(pid, signal = "SIGTERM") {
  if (!Number.isInteger(pid) || pid <= 0) return;
  if (process.platform === "win32") {
    const killer = spawn("taskkill", ["/pid", String(pid), "/T", "/F"], {
      stdio: "ignore",
      windowsHide: true,
    });
    killer.unref();
    return;
  }
  try {
    process.kill(-pid, signal);
  } catch {
    try {
      process.kill(pid, signal);
    } catch {
      // Process already gone.
    }
  }
}

async function waitForPidExit(pid, timeoutMs = 3_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isPidAlive(pid)) return true;
    await sleep(120);
  }
  return !isPidAlive(pid);
}

function spawnDaemon(command, argv, { env, logPath }) {
  ensureRuntimeDir();
  const fd = fs.openSync(logPath, "a");
  try {
    const child = spawn(command, argv, {
      cwd: PROJECT_ROOT,
      detached: process.platform !== "win32",
      stdio: ["ignore", fd, fd],
      env,
      windowsHide: true,
    });
    child.unref();
    return { pid: child.pid, pgid: child.pid };
  } finally {
    fs.closeSync(fd);
  }
}

async function waitForDaemonHealth(appUrl, pid, target, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isPidAlive(pid)) {
      throw new Error(`Web service exited before becoming ready (see ${logFile(target)})`);
    }
    if (await probeDevServer(appUrl)) return;
    await sleep(300);
  }
  throw new Error(`Web service did not start at ${displayUrl(appUrl)} (see ${logFile(target)})`);
}

async function startWebDaemon(appUrl) {
  const existing = readState("web");
  if (existing && isPidAlive(existing.pid)) {
    process.stdout.write(`[codex-slides] Web daemon already running (pid ${existing.pid}) at ${existing.url}\n`);
    return;
  }
  if (await probeDevServer(appUrl, 700)) {
    process.stdout.write(`[codex-slides] Reusing Web service at ${displayUrl(appUrl)}\n`);
    return;
  }

  const host = localBindHost(appUrl);
  const port = effectivePort(appUrl);
  const distDir = devDistDir(appUrl);
  const { fileName: tsConfigPath, fullPath: tsConfigFullPath } = prepareDevTsConfig(appUrl, distDir);
  const logPath = logFile("web");

  process.stdout.write(`[codex-slides] Starting Web daemon at ${displayUrl(appUrl)}\n`);
  const { pid, pgid } = spawnDaemon(process.execPath, [nextBinary, "dev", "-H", host, "-p", port], {
    env: {
      ...process.env,
      CODEX_SLIDES_URL: displayUrl(appUrl),
      CODEX_SLIDES_DIST_DIR: distDir,
      CODEX_SLIDES_TSCONFIG_PATH: tsConfigPath,
    },
    logPath,
  });
  writeState("web", {
    target: "web",
    pid,
    pgid,
    port,
    url: displayUrl(appUrl),
    mode: "web",
    startedAt: Date.now(),
    logPath,
    tsConfigPath: tsConfigFullPath,
    distDir,
  });

  try {
    await waitForDaemonHealth(appUrl, pid, "web");
  } catch (error) {
    killPidGroup(pgid, "SIGTERM");
    fs.rmSync(tsConfigFullPath, { force: true });
    clearState("web");
    throw error;
  }
  process.stdout.write(`[codex-slides] Web daemon ready at ${displayUrl(appUrl)} (pid ${pid}, logs: ${logPath})\n`);
}

async function startDesktopDaemon(appUrl) {
  const existing = readState("desktop");
  if (existing && isPidAlive(existing.pid)) {
    process.stdout.write(`[codex-slides] Desktop daemon already running (pid ${existing.pid})\n`);
    return;
  }

  // Desktop depends on a healthy Web service: reuse an external one or start our own daemon.
  await startWebDaemon(appUrl);

  const logPath = logFile("desktop");
  const binary = ensureMacDesktopBinary();
  process.stdout.write(`[codex-slides] Starting Desktop daemon against ${displayUrl(appUrl)}\n`);
  const { pid, pgid } = spawnDaemon(binary, [PROJECT_ROOT], {
    env: desktopEnvironment(appUrl),
    logPath,
  });
  writeState("desktop", {
    target: "desktop",
    pid,
    pgid,
    port: effectivePort(appUrl),
    url: displayUrl(appUrl),
    mode: "desktop",
    startedAt: Date.now(),
    logPath,
  });
  process.stdout.write(`[codex-slides] Desktop daemon started (pid ${pid}, logs: ${logPath})\n`);
}

function clearDaemonArtifacts(state) {
  if (state?.tsConfigPath) fs.rmSync(state.tsConfigPath, { force: true });
  if (state?.target) clearState(state.target);
}

function startTargets(target) {
  return target === "all" ? ["web", "desktop"] : [target];
}

function stopTargets(target) {
  return target === "all" ? ["desktop", "web"] : [target];
}

async function stopDaemon(target) {
  const state = readState(target);
  if (!state || !isPidAlive(state.pid)) {
    if (state) clearDaemonArtifacts(state);
    process.stdout.write(`[codex-slides] ${label(target)} is not running\n`);
    return;
  }

  const groupPid = state.pgid ?? state.pid;
  process.stdout.write(`[codex-slides] Stopping ${label(target)} (pid ${state.pid})\n`);
  killPidGroup(groupPid, "SIGTERM");
  const exited = await waitForPidExit(groupPid, 3_000);
  if (!exited) killPidGroup(groupPid, "SIGKILL");
  clearDaemonArtifacts(state);
  process.stdout.write(`[codex-slides] ${label(target)} stopped\n`);
}

async function statusOf(target) {
  const state = readState(target);
  if (!state) return { target, state: "not-running" };
  if (!isPidAlive(state.pid)) {
    clearDaemonArtifacts(state);
    return { target, state: "stale", pid: state.pid };
  }
  let healthy = null;
  if (target === "web" && state.url) {
    try {
      healthy = await probeDevServer(new URL(state.url), 700);
    } catch {
      healthy = false;
    }
  }
  return {
    target,
    state: "running",
    pid: state.pid,
    url: state.url,
    port: state.port,
    uptimeMs: typeof state.startedAt === "number" ? Date.now() - state.startedAt : null,
    healthy,
    logPath: state.logPath,
  };
}

function formatUptime(ms) {
  if (typeof ms !== "number" || !Number.isFinite(ms) || ms < 0) return "-";
  const totalSeconds = Math.floor(ms / 1_000);
  const hours = Math.floor(totalSeconds / 3_600);
  const minutes = Math.floor((totalSeconds % 3_600) / 60);
  const seconds = totalSeconds % 60;
  if (hours) return `${hours}h${minutes}m`;
  if (minutes) return `${minutes}m${seconds}s`;
  return `${seconds}s`;
}

function tailLog(target, lines, prefix) {
  const file = logFile(target);
  let content;
  try {
    content = fs.readFileSync(file, "utf8");
  } catch {
    process.stdout.write(`${prefix}(no log yet at ${file})\n`);
    return;
  }
  const tail = content.split("\n").slice(-lines - 1).join("\n");
  process.stdout.write(prefix ? tail.replace(/^/gm, prefix) : tail);
  if (!tail.endsWith("\n")) process.stdout.write("\n");
}

function followLogs(targets) {
  const multi = targets.length > 1;
  const offsets = new Map();
  for (const target of targets) {
    const file = logFile(target);
    let size = 0;
    try {
      size = fs.statSync(file).size;
    } catch {
      size = 0;
    }
    offsets.set(target, size);
    fs.watchFile(file, { interval: 300 }, () => {
      let current;
      try {
        current = fs.statSync(file).size;
      } catch {
        return;
      }
      let from = offsets.get(target) ?? 0;
      if (current < from) from = 0; // truncated or rotated
      if (current <= from) {
        offsets.set(target, current);
        return;
      }
      const fd = fs.openSync(file, "r");
      const buffer = Buffer.alloc(current - from);
      fs.readSync(fd, buffer, 0, buffer.length, from);
      fs.closeSync(fd);
      offsets.set(target, current);
      const text = buffer.toString("utf8");
      process.stdout.write(multi ? text.replace(/^/gm, `[${target}] `) : text);
    });
  }
  process.stdout.write(`[codex-slides] Following logs (Ctrl+C to stop)\n`);
  const stop = () => {
    for (const target of targets) fs.unwatchFile(logFile(target));
    process.exit(0);
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
  return new Promise(() => {});
}

// --- Command handlers ------------------------------------------------------

async function cmdRun(options) {
  process.on("SIGINT", () => void shutdown());
  process.on("SIGTERM", () => void shutdown());
  const appUrl = resolveAppUrl(options.webPort);
  await ensureWebServer(appUrl);
  if (options.target === "web" || closing) return;
  startDesktop(appUrl);
}

async function cmdStart(options) {
  const appUrl = resolveAppUrl(options.webPort);
  for (const target of startTargets(options.target)) {
    if (target === "web") await startWebDaemon(appUrl);
    else await startDesktopDaemon(appUrl);
  }
}

async function cmdStop(options) {
  for (const target of stopTargets(options.target)) {
    await stopDaemon(target);
  }
}

async function cmdRestart(options) {
  await cmdStop(options);
  await cmdStart(options);
}

async function cmdStatus(options) {
  const report = [];
  for (const target of startTargets(options.target)) {
    report.push(await statusOf(target));
  }
  if (options.json) {
    process.stdout.write(`${JSON.stringify({ targets: report }, null, 2)}\n`);
    return;
  }
  for (const entry of report) {
    if (entry.state === "running") {
      const health = entry.healthy == null ? "" : entry.healthy ? "  healthy" : "  unhealthy";
      const where = entry.url ? `  ${entry.url}` : "";
      process.stdout.write(
        `[codex-slides] ${label(entry.target)}: running  pid ${entry.pid}${where}  up ${formatUptime(entry.uptimeMs)}${health}\n`,
      );
    } else if (entry.state === "stale") {
      process.stdout.write(`[codex-slides] ${label(entry.target)}: stale (pid ${entry.pid} not alive, cleaned)\n`);
    } else {
      process.stdout.write(`[codex-slides] ${label(entry.target)}: not running\n`);
    }
  }
}

async function cmdLogs(options) {
  const targets = startTargets(options.target);
  const multi = targets.length > 1;
  for (const target of targets) {
    if (multi) process.stdout.write(`===== ${label(target)} (${logFile(target)}) =====\n`);
    tailLog(target, 200, "");
  }
  if (options.follow) await followLogs(targets);
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    printHelp();
    return;
  }

  switch (options.command) {
    case "run":
      return cmdRun(options);
    case "start":
      return cmdStart(options);
    case "stop":
      return cmdStop(options);
    case "restart":
      return cmdRestart(options);
    case "status":
      return cmdStatus(options);
    case "logs":
      return cmdLogs(options);
    default:
      throw new Error(`Unknown development runner command: ${options.command}`);
  }
}

void main().catch(async (error) => {
  if (closing) return;
  process.stderr.write(`${error instanceof Error ? error.message : error}\n`);
  await shutdown(1);
});
