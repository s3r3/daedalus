#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { rmSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);
const env = {
  ...process.env,
  NODE_ENV: "production",
  CODEX_SLIDES_DIST_DIR: ".next-desktop",
};

function run(command, args) {
  const result = spawnSync(command, args, { cwd: root, env, stdio: "inherit" });
  if (result.status !== 0) process.exit(result.status ?? 1);
}

// A prior standalone install can contain pnpm project-store symlinks that point
// back into the generated output. Remove the build tree without following those
// links before Next performs its own recursive cleanup.
rmSync(join(root, ".next-desktop"), { recursive: true, force: true });
// Stale packaged output would otherwise survive into the next electron-builder
// run (and into `smoke-server.mjs --packaged`, which scans every dist/ app).
rmSync(join(root, "dist"), { recursive: true, force: true });
run(process.execPath, [require.resolve("next/dist/bin/next"), "build"]);
run(process.execPath, [join(root, "scripts", "prepare-standalone.mjs")]);
// Boot the exact runtime the desktop shell will start and require 200s from
// core routes, so a broken standalone can never reach packaging.
run(process.execPath, [join(root, "scripts", "smoke-server.mjs")]);
