#!/usr/bin/env node

// One-command release: `pnpm release 0.2.0` (see docs/RELEASING.md).
//
// Bumps the version in package.json and electron/package.json, runs the fast
// local gates, commits, tags v<version>, and pushes. The pushed tag triggers
// .github/workflows/release-desktop.yml, which builds, smoke tests, and
// publishes the GitHub Release. Use --dry-run to rehearse without touching
// git state.

import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const dryRun = process.argv.includes("--dry-run");
const version = process.argv.slice(2).find((arg) => !arg.startsWith("-"));

function fail(message) {
  process.stderr.write(`release: ${message}\n`);
  process.exit(1);
}

function run(command, args, { capture = false, mutates = false } = {}) {
  if (dryRun && mutates) {
    process.stdout.write(`[dry-run] ${command} ${args.join(" ")}\n`);
    return "";
  }
  const result = spawnSync(command, args, {
    cwd: root,
    stdio: capture ? ["ignore", "pipe", "inherit"] : "inherit",
    encoding: "utf8",
  });
  if (result.status !== 0) fail(`\`${command} ${args.join(" ")}\` failed.`);
  return capture ? result.stdout.trim() : "";
}

if (!version || !/^\d+\.\d+\.\d+$/.test(version)) {
  fail("usage: pnpm release <major.minor.patch> [--dry-run]  (example: pnpm release 0.2.0)");
}

const packageFiles = ["package.json", "electron/package.json"].map((file) => join(root, file));
const current = JSON.parse(readFileSync(packageFiles[0], "utf8")).version;
const toParts = (value) => value.split(".").map(Number);
const [curParts, nextParts] = [toParts(current), toParts(version)];
const newer = nextParts[0] - curParts[0] || nextParts[1] - curParts[1] || nextParts[2] - curParts[2];
if (newer <= 0) fail(`version ${version} must be greater than the current ${current}.`);

if (run("git", ["status", "--porcelain"], { capture: true }) !== "") {
  fail("working tree is not clean; commit or stash changes first.");
}
run("git", ["fetch", "origin", "--tags"]);
if (run("git", ["tag", "--list", `v${version}`], { capture: true }) !== "") {
  fail(`tag v${version} already exists.`);
}

run(process.execPath, [join(root, "scripts", "set-version.mjs"), version], { mutates: true });
process.stdout.write(`${dryRun ? "Would bump" : "Bumped"} ${current} -> ${version}\n`);

// Fast local gates; the workflow re-runs the full set on every platform.
run("pnpm", ["electron:check"]);
run("pnpm", ["test"]);
run("pnpm", ["typecheck"]);

run("git", ["add", "package.json", "electron/package.json"], { mutates: true });
run("git", ["commit", "-m", `release: v${version}`], { mutates: true });
run("git", ["tag", "-a", `v${version}`, "-m", `Codex Slides ${version}`], { mutates: true });
run("git", ["push", "origin", "HEAD", `refs/tags/v${version}`], { mutates: true });

const remote = run("git", ["remote", "get-url", "origin"], { capture: true });
const repoPath = remote.replace(/^git@github\.com:/, "").replace(/^https:\/\/github\.com\//, "").replace(/\.git$/, "");
process.stdout.write(
  dryRun
    ? `Dry run complete; no git state was changed.\n`
    : `Pushed v${version}. Watch the release build at https://github.com/${repoPath}/actions\n`,
);
