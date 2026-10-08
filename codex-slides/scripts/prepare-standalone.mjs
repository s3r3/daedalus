#!/usr/bin/env node

import { existsSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const distDir = process.env.CODEX_SLIDES_DIST_DIR || ".next-desktop";
const standalone = join(root, distDir, "standalone");
const server = join(standalone, "server.js");
if (!existsSync(server)) throw new Error("Next standalone server was not produced.");

const rootPackage = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const standalonePackageFile = join(standalone, "package.json");
const standalonePackage = JSON.parse(readFileSync(standalonePackageFile, "utf8"));
const runtimeDependencies = ["next", "react", "react-dom", "pdf-lib", "pptxgenjs"];
standalonePackage.main = "server.js";
standalonePackage.scripts = {};
standalonePackage.dependencies = Object.fromEntries(
  runtimeDependencies.map((name) => [name, rootPackage.dependencies[name]]),
);
delete standalonePackage.devDependencies;
writeFileSync(standalonePackageFile, `${JSON.stringify(standalonePackage, null, 2)}\n`, "utf8");

// Next 14's pnpm trace can contain package files without the corresponding
// pnpm links. Prefer the already-downloaded production runtime, while allowing
// pnpm to fetch a missing store tarball on clean or partially-pruned builders.
rmSync(join(standalone, "node_modules"), { recursive: true, force: true });
const pnpm = process.platform === "win32" ? "pnpm.cmd" : "pnpm";
const installArgs = [
  "install",
  "--dir", standalone,
  "--prod",
  "--prefer-offline",
  "--ignore-scripts",
  "--ignore-workspace",
  "--no-lockfile",
];
const pnpmCli = process.env.npm_execpath;
const install = spawnSync(
  pnpmCli ? process.execPath : pnpm,
  pnpmCli ? [pnpmCli, ...installArgs] : installArgs,
  { cwd: root, stdio: "inherit", shell: process.platform === "win32" && !pnpmCli },
);
if (install.status !== 0) throw new Error(`Standalone production install failed (${install.status ?? "unknown"}).`);

const destinationNext = realpathSync(join(standalone, "node_modules", "next"));

// A repeated local packaging run can otherwise feed the previous Electron
// output back into Next's trace. It is generated state, never app input.
rmSync(join(standalone, "dist"), { recursive: true, force: true });

for (const unsafe of ["data", ".next-dev", ".claude", ".claude-sessions"]) {
  if (existsSync(join(standalone, unsafe))) {
    throw new Error(`Unsafe local directory was traced into standalone: ${unsafe}`);
  }
}

// The server's own compiled runtime must ship next to the manifests. When the
// output-file-tracing excludes accidentally cover the active dist dir, Next
// silently drops these and every route 500s only in packaged builds.
for (const requiredServerFile of [
  join(distDir, "server", "webpack-runtime.js"),
  join(distDir, "server", "chunks"),
]) {
  if (!existsSync(join(standalone, requiredServerFile))) {
    throw new Error(`Standalone output is missing ${requiredServerFile}; check outputFileTracingExcludes.`);
  }
}

const standaloneRequire = createRequire(server);
for (const dependency of runtimeDependencies) {
  const resolved = standaloneRequire.resolve(dependency);
  if (!resolved.startsWith(`${standalone}${sep}`)) {
    throw new Error(`${dependency} escaped the standalone runtime: ${resolved}`);
  }
}

const nextRequire = createRequire(join(destinationNext, "package.json"));
const styledJsx = nextRequire.resolve("styled-jsx/package.json");
if (!styledJsx.startsWith(`${standalone}${sep}`)) {
  throw new Error(`styled-jsx escaped the standalone runtime: ${styledJsx}`);
}
const metadataHelper = nextRequire.resolve("next/dist/lib/metadata/get-metadata-route");
process.stdout.write(
  `Standalone runtime ready: ${relative(standalone, metadataHelper)}; local project data excluded.\n`,
);
