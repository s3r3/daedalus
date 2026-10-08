import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const read = (relative) => fs.readFileSync(path.join(root, relative), "utf8");

test("every rendered-deck mutation surface records a version", () => {
  const routeFiles = [
    "src/app/api/projects/[id]/design-system/route.ts",
    "src/app/api/projects/[id]/mark/route.ts",
    "src/app/api/projects/[id]/regenerate/route.ts",
    "src/app/api/projects/[id]/route.ts",
    "src/app/api/projects/[id]/slides/route.ts",
    "src/app/api/projects/[id]/slides/[index]/image/route.ts",
    "src/app/api/projects/[id]/speaker-notes/route.ts",
  ];

  for (const route of routeFiles) {
    const source = read(route);
    assert.match(
      source,
      /await captureDeckVersion\(/,
      `${route} must await deck version capture after a persisted edit`,
    );
    assert.doesNotMatch(
      source,
      /captureDeckVersion\([\s\S]{0,300}?\.catch\s*\(/,
      `${route} must not hide a failed deck version capture`,
    );
  }

  const projectPatch = read("src/app/api/projects/[id]/route.ts");
  assert.match(projectPatch, /beforeDeckSignature\s*=\s*currentDeckVersionSignature\(project\)/);
  assert.match(projectPatch, /deckChanged\s*=\s*currentDeckVersionSignature\(project\)\s*!==\s*beforeDeckSignature/);

  const pipeline = read("src/lib/pipeline.ts");
  assert.match(pipeline, /await ensureCurrentDeckVersion\(project/);
  const projectRuns = read("src/lib/projectRuns.ts");
  assert.match(projectRuns, /await ensureCurrentDeckVersion\(latest/);
});

test("explicit checkpoints append while automatic ensures deduplicate", () => {
  const route = read("src/app/api/projects/[id]/versions/route.ts");
  assert.match(route, /await ensureCurrentDeckVersion\(project/);
  assert.match(route, /await captureDeckVersion\(project,[\s\S]*?force:\s*true/);
});

test("Design Files stays viewport-bound and scrolls inside its content panes", () => {
  const css = read("src/app/globals.css");
  assert.match(css, /\.ws\.project-ws\s*\{[\s\S]*?grid-template-rows:\s*minmax\(0,\s*1fr\)/);
  assert.match(css, /\.project-ws\s*>\s*\.deckpane[\s\S]*?overflow:\s*hidden[\s\S]*?\.project-ws\s*>\s*\.deckpane\s*\{[\s\S]*?max-height:\s*100%/);
  assert.match(css, /\.design-files-body\s*\{[\s\S]*?min-height:\s*0[\s\S]*?overflow:\s*hidden/);
  assert.match(css, /\.design-file-viewer-frame\s*\{[\s\S]*?min-height:\s*0[\s\S]*?overflow:\s*hidden/);
  assert.match(css, /\.design-file-content\s*\{[\s\S]*?overflow:\s*auto[\s\S]*?overscroll-behavior:\s*contain/);
});
