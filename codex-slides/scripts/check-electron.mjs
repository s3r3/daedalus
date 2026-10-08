#!/usr/bin/env node

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const read = (file) => readFileSync(join(root, file), "utf8");
const pkg = JSON.parse(read("package.json"));
const desktopPkg = JSON.parse(read("electron/package.json"));
const nextConfig = read("next.config.mjs");
const main = read("electron/main.cjs");
const preload = read("electron/preload.cjs");
const dev = read("electron/dev.cjs");
const builder = read("electron-builder.yml");
const devBuilder = read("electron-builder.dev.yml");
const release = read(".github/workflows/release-desktop.yml");
const prepareStandalone = read("scripts/prepare-standalone.mjs");
const buildDesktop = read("scripts/build-desktop.mjs");
const icon = readFileSync(join(root, "public/brand/codex-slides-mark.png"));
const macIcon = readFileSync(join(root, "public/brand/codex-slides-app-icon.png"));

assert.equal(pkg.main, "electron/main.cjs");
assert.equal(pkg.productName, "Codex Slides");
assert.equal(desktopPkg.main, "main.cjs");
assert.equal(desktopPkg.name, "codex-slides-desktop");
assert.equal(desktopPkg.productName, pkg.productName);
assert.equal(desktopPkg.version, pkg.version);
assert.ok(pkg.scripts["electron:dev"]);
assert.ok(pkg.scripts["dev:web"]);
assert.ok(pkg.scripts["dev:desktop"]);
assert.match(pkg.scripts.dev, /electron\/dev\.cjs/);
assert.match(pkg.scripts["dev:web"], /electron\/dev\.cjs web/);
assert.match(pkg.scripts["dev:desktop"], /electron\/dev\.cjs desktop/);
assert.match(pkg.scripts["electron:dev"], /electron\/dev\.cjs desktop/);
assert.ok(pkg.scripts["dev:start"]);
assert.ok(pkg.scripts["dev:stop"]);
assert.ok(pkg.scripts["dev:restart"]);
assert.ok(pkg.scripts["dev:status"]);
assert.ok(pkg.scripts["dev:logs"]);
assert.match(pkg.scripts["dev:start"], /electron\/dev\.cjs start/);
assert.match(pkg.scripts["dev:stop"], /electron\/dev\.cjs stop/);
assert.match(pkg.scripts["dev:restart"], /electron\/dev\.cjs restart/);
assert.match(pkg.scripts["dev:status"], /electron\/dev\.cjs status/);
assert.match(pkg.scripts["dev:logs"], /electron\/dev\.cjs logs/);
assert.match(dev, /new Set\(\["all", "web", "desktop"\]\)/);
assert.match(dev, /new Set\(\["run", "start", "stop", "restart", "status", "logs"\]\)/);
assert.match(dev, /dev-runtime/);
assert.match(dev, /spawnDaemon/);
assert.match(dev, /next\/dist\/bin\/next/);
assert.match(dev, /--web-port/);
assert.match(dev, /CODEX_SLIDES_DIST_DIR:\s*distDir/);
assert.match(dev, /CODEX_SLIDES_TSCONFIG_PATH:\s*tsConfigPath/);
assert.match(dev, /\.next-dev\/port-/);
assert.match(dev, /Reusing Web service/);
assert.match(dev, /ELECTRON_RUN_AS_NODE/);
assert.match(dev, /electronBuilderCli/);
assert.match(dev, /Preparing branded macOS Desktop shell/);
assert.ok(pkg.scripts["electron:dist"]);
assert.ok(pkg.scripts["build:desktop"]);
assert.match(nextConfig, /output:\s*"standalone"/);
assert.match(nextConfig, /outputFileTracingExcludes/);
assert.match(nextConfig, /CODEX_SLIDES_TSCONFIG_PATH/);
assert.match(nextConfig, /images:\s*\{\s*unoptimized:\s*true\s*\}/);
assert.match(nextConfig, /"\.\/data\/\*\*\/\*"/);
assert.match(main, /CODEX_SLIDES_DATA_DIR/);
// The packaged server must run under utilityProcess: a spawned
// ELECTRON_RUN_AS_NODE child shows a second "exec" Dock icon on macOS and
// depends on the runAsNode fuse staying enabled.
assert.match(main, /utilityProcess\.fork/);
assert.doesNotMatch(main, /ELECTRON_RUN_AS_NODE/);
assert.match(main, /server exited during startup/);
// Dev shells must not share the production profile: same userData means the
// same single-instance lock, and the dev watchdog then kills installed apps.
assert.match(main, /CODEX_SLIDES_USER_DATA_DIR/);
assert.match(dev, /CODEX_SLIDES_USER_DATA_DIR:\s*path\.join\(RUNTIME_DIR, "desktop-user-data"\)/);
assert.match(main, /app\.setName\(PRODUCT_NAME\)/);
assert.match(main, /app\.dock\.setIcon\(resolveDesktopIconPath\(\)\)/);
assert.match(main, /codex-slides-app-icon\.png/);
assert.match(main, /app\.setAppUserModelId\(APP_ID\)/);
assert.match(main, /contextIsolation:\s*true/);
assert.match(main, /nodeIntegration:\s*false/);
assert.match(main, /sandbox:\s*true/);
assert.match(main, /frameName\.startsWith\("codex-slides-presenter-"\)/);
assert.match(main, /presenterWindowOptions\(\)/);
assert.match(main, /ipcMain\.handle\("codex-slides:copy-text"/);
assert.match(main, /clipboard\.writeText\(value\)/);
assert.match(preload, /ipcRenderer\.invoke\("codex-slides:copy-text"/);
assert.match(builder, /target:\s*dmg/);
assert.match(builder, /target:\s*nsis/);
assert.match(builder, /target:\s*AppImage/);
assert.match(builder, /appId:\s*io\.nexu\.codex-slides/);
assert.match(builder, /productName:\s*Codex Slides/);
assert.match(builder, /mac:\s*\n\s*icon:\s*public\/brand\/codex-slides-app-icon\.png/);
assert.match(builder, /win:\s*\n\s*icon:\s*public\/brand\/codex-slides-mark\.png/);
assert.match(builder, /linux:\s*\n\s*icon:\s*public\/brand\/codex-slides-mark\.png/);
assert.match(devBuilder, /appId:\s*io\.nexu\.codex-slides\.dev/);
assert.match(devBuilder, /output:\s*\.tmp\/electron-dev-build/);
assert.match(devBuilder, /from:\s*public\/brand\/codex-slides-app-icon\.png/);
assert.match(devBuilder, /to:\s*codex-slides-app-icon\.png/);
assert.match(devBuilder, /target:\s*dir/);
assert.match(builder, /app:\s*electron/);
assert.match(builder, /npmRebuild:\s*false/);
assert.match(builder, /!node_modules/);
assert.match(builder, /from:\s*\.next-desktop\/standalone\/node_modules/);
assert.match(builder, /to:\s*next\/\.next-desktop\/static/);
assert.match(prepareStandalone, /get-metadata-route/);
assert.match(prepareStandalone, /Unsafe local directory/);
assert.match(prepareStandalone, /rmSync\(join\(standalone, "dist"\)/);
assert.match(prepareStandalone, /webpack-runtime\.js/);
assert.match(buildDesktop, /CODEX_SLIDES_DIST_DIR:\s*"\.next-desktop"/);
assert.match(buildDesktop, /smoke-server\.mjs/);
// The root package must stay CommonJS: "type": "module" makes Next emit an
// ESM standalone server whose CJS chunks then fail to parse, and poisons
// output file tracing. next.config must never exclude the active dist dir.
assert.equal(pkg.type, undefined);
assert.match(nextConfig, /staleBuildDirExcludes/);
assert.match(nextConfig, /entry\.name !== activeDistDir/);
assert.match(release, /macos-latest/);
assert.match(release, /windows-latest/);
assert.match(release, /ubuntu-latest/);
// Both release paths must stay wired: tag push and Actions-UI dispatch (which
// bumps versions via set-version.mjs, pushes the tag itself, and gates every
// upload/publish step on the resolved release context).
assert.match(release, /workflow_dispatch/);
assert.match(release, /set-version\.mjs/);
assert.match(release, /is_release/);
assert.match(release, /smoke-server\.mjs --packaged/);
assert.equal(icon.readUInt32BE(16), 1024);
assert.equal(icon.readUInt32BE(20), 1024);
assert.equal(icon.readUInt8(25), 6);
assert.equal(macIcon.readUInt32BE(16), 1024);
assert.equal(macIcon.readUInt32BE(20), 1024);
assert.equal(macIcon.readUInt8(25), 6);

process.stdout.write("Codex Slides Electron contract passed: branded shell, standalone server, macOS/Windows/Linux packaging.\n");
