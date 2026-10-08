#!/usr/bin/env node

// Boots the production server payload exactly as the desktop shell does and
// fails the build when core routes do not answer 200. Run it against the
// standalone build output (default) or against every unpacked electron-builder
// app in dist/ (--packaged), so "works in dev, broken after packaging" bugs
// stop at CI instead of on a user's machine.

import { spawn } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import net from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const distDir = process.env.CODEX_SLIDES_DIST_DIR || ".next-desktop";
const PROBES = ["/", "/api/agents"];
const READY_TIMEOUT_MS = 60_000;

function freePort() {
  return new Promise((resolvePort, reject) => {
    const server = net.createServer();
    server.unref();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close(() => resolvePort(port));
    });
  });
}

function findPackagedServerRoots() {
  const dist = join(root, "dist");
  if (!existsSync(dist)) return [];
  const roots = [];
  for (const entry of readdirSync(dist, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const unpacked = join(dist, entry.name);
    if (entry.name.startsWith("mac")) {
      for (const bundle of readdirSync(unpacked)) {
        if (!bundle.endsWith(".app")) continue;
        const serverRoot = join(unpacked, bundle, "Contents", "Resources", "next");
        if (existsSync(join(serverRoot, "server.js"))) roots.push(serverRoot);
      }
    } else if (entry.name.endsWith("-unpacked")) {
      const serverRoot = join(unpacked, "resources", "next");
      if (existsSync(join(serverRoot, "server.js"))) roots.push(serverRoot);
    }
  }
  return roots;
}

async function smoke(serverRoot) {
  const entry = join(serverRoot, "server.js");
  if (!existsSync(entry)) throw new Error(`server.js is missing under ${serverRoot}`);
  const port = await freePort();
  const dataDir = await mkdtemp(join(tmpdir(), "codex-slides-smoke-"));
  const output = [];
  const child = spawn(process.execPath, [entry], {
    cwd: serverRoot,
    env: {
      ...process.env,
      NODE_ENV: "production",
      HOSTNAME: "127.0.0.1",
      PORT: String(port),
      NEXT_TELEMETRY_DISABLED: "1",
      CODEX_SLIDES_DATA_DIR: join(dataDir, "data"),
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.on("data", (chunk) => output.push(chunk));
  child.stderr.on("data", (chunk) => output.push(chunk));
  const exited = new Promise((_, reject) => {
    child.once("exit", (code) => reject(new Error(`Server exited early (${code}).`)));
  });

  try {
    const deadline = Date.now() + READY_TIMEOUT_MS;
    for (const probe of PROBES) {
      const url = `http://127.0.0.1:${port}${probe}`;
      for (;;) {
        let status = null;
        try {
          const response = await Promise.race([fetch(url), exited]);
          status = response.status;
          if (status === 200) break;
        } catch (error) {
          if (error.message.startsWith("Server exited early")) throw error;
        }
        if (Date.now() >= deadline) {
          throw new Error(`${url} did not return 200 in time (last status: ${status ?? "no response"}).`);
        }
        await new Promise((resolveDelay) => setTimeout(resolveDelay, 350));
      }
      process.stdout.write(`  ok ${probe}\n`);
    }
  } catch (error) {
    process.stderr.write(`\n--- server output (${serverRoot}) ---\n${Buffer.concat(output).toString("utf8").slice(-4000)}\n`);
    throw error;
  } finally {
    child.kill();
    await rm(dataDir, { recursive: true, force: true });
  }
}

const packaged = process.argv.includes("--packaged");
const targets = packaged
  ? findPackagedServerRoots()
  : [join(root, distDir, "standalone")];
if (packaged && targets.length === 0) {
  throw new Error("No unpacked packaged app with a bundled server was found in dist/.");
}
for (const target of targets) {
  process.stdout.write(`Smoke testing ${target}\n`);
  await smoke(target);
}
process.stdout.write(`Server smoke passed for ${targets.length} runtime${targets.length === 1 ? "" : "s"}.\n`);
