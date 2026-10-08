import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function source(relativePath) {
  return fs.readFileSync(path.join(root, relativePath), "utf8");
}

test("home rendering is handed to the durable project run API", () => {
  const home = source("app/page.tsx");
  const deckEdit = source("lib/deckEdit.ts");
  assert.match(home, /startProjectRun as startDetachedProjectRun/);
  assert.match(home, /await startDetachedProjectRun\(projectId, \{\s*kind: "render"/s);
  assert.doesNotMatch(home, /await streamRender\(/);
  assert.match(deckEdit, /\/runs`, \{[\s\S]*?method: "POST",[\s\S]*?keepalive: true,/);
});

test("interrupted rendering is adopted and resumes from persisted pages", () => {
  const deckView = source("components/DeckView.tsx");
  const pipeline = source("lib/pipeline.ts");
  assert.match(deckView, /const wasInterrupted = project\.status === "rendering"/);
  assert.match(deckView, /void startBackgroundRun\(\{\s*kind: "render"/s);
  assert.match(pipeline, /if \(page\.status === "rendered"\) return;/);
  assert.match(pipeline, /const pending = project\.pages\.filter\(\(p\) => p\.status !== "rendered"\)/);
});
