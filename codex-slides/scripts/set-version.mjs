#!/usr/bin/env node

// Sets the release version in package.json and electron/package.json — the
// desktop contract (check-electron.mjs) requires the two to stay equal. Used
// by scripts/release.mjs locally and by the release workflow's
// workflow_dispatch path on CI.

import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const version = process.argv[2];

if (!version || !/^\d+\.\d+\.\d+$/.test(version)) {
  process.stderr.write("set-version: usage: node scripts/set-version.mjs <major.minor.patch>\n");
  process.exit(1);
}

for (const file of ["package.json", "electron/package.json"]) {
  const path = join(root, file);
  const pkg = JSON.parse(readFileSync(path, "utf8"));
  pkg.version = version;
  writeFileSync(path, `${JSON.stringify(pkg, null, 2)}\n`, "utf8");
}
process.stdout.write(`Version set to ${version} in package.json and electron/package.json.\n`);
