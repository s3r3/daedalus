// Entry point used by the installed plugin cache. Codex copies local plugins
// into a versioned cache, where pnpm's top-level symlinks may not survive.
// Repair missing runtime dependencies before importing the stdio MCP server.

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const CACHED_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const manifest = JSON.parse(readFileSync(join(CACHED_ROOT, ".codex-plugin", "plugin.json"), "utf8"));

function usablePluginRoot(candidate) {
  try {
    const root = realpathSync(resolve(candidate));
    return existsSync(join(root, ".codex-plugin", "plugin.json"))
      && existsSync(join(root, "mcp", "server.mjs"))
      && existsSync(join(root, "package.json"))
      ? root
      : null;
  } catch {
    return null;
  }
}

// A personal marketplace normally points at ~/plugins/<name>. Prefer that
// stable source checkout over Codex's versioned cache so app data and builds
// stay durable across plugin upgrades. Remote/archive installs fall back to
// their cached root and bootstrap dependencies there once.
const ROOT = usablePluginRoot(process.env.CODEX_SLIDES_PLUGIN_SOURCE || join(homedir(), "plugins", manifest.name))
  || CACHED_ROOT;
const REQUIRED = [
  "@modelcontextprotocol/sdk",
  "next",
  "pdf-lib",
  "pptxgenjs",
  "react",
  "react-dom",
  "zod",
];

function packageDir(name) {
  return join(ROOT, "node_modules", ...name.split("/"));
}

const missing = REQUIRED.filter((name) => !existsSync(packageDir(name)));
if (missing.length) {
  const command = process.platform === "win32" ? "cmd.exe" : "npm";
  const args = process.platform === "win32"
    ? ["/d", "/s", "/c", "npm", "install", "--no-audit", "--no-fund"]
    : ["install", "--no-audit", "--no-fund"];
  process.stderr.write(`Preparing Codex Slides MCP dependencies (${missing.join(", ")})…\n`);
  const result = spawnSync(command, args, {
    cwd: ROOT,
    env: { ...process.env, FORCE_COLOR: "0" },
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.stdout) process.stderr.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`npm install failed while preparing Codex Slides MCP (exit ${result.status}).`);
  }
}

process.chdir(ROOT);
await import(pathToFileURL(join(ROOT, "mcp", "server.mjs")).href);
