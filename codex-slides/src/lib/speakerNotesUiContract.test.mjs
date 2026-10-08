import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";

const component = fs.readFileSync(
  fileURLToPath(new URL("../components/SpeakerNotesPanel.tsx", import.meta.url)),
  "utf8",
);

test("every slide exposes a debounced, serialized speaker-notes editor", () => {
  assert.match(component, /<textarea/);
  assert.doesNotMatch(component, /note\.trim\(\)\s*\?\s*\(/);
  assert.match(component, /setTimeout\(\(\) => \{ void queueSave\(slide\.index, draft\); \}, 700\)/);
  assert.match(component, /pendingRef\.current\.set\(index, value\)/);
  assert.match(component, /writingRef\.current\.set\(pendingIndex, pendingValue\)/);
  assert.match(component, /previousIndex !== slide\.index/);
});

test("reverting while a note write is in flight queues the final value", () => {
  assert.match(component, /writingValue === value && pendingValue === undefined/);
  assert.match(component, /savedValuesRef\.current\.get\(index\) === value && pendingValue === undefined && writingValue === undefined/);
});
