import assert from "node:assert/strict";
import test from "node:test";
import {
  contextItemMatchesAccept,
  hasDraggedFiles,
} from "./contextItems.ts";

test("recognizes browser file drag payloads without intercepting text drags", () => {
  assert.equal(hasDraggedFiles(["text/plain", "Files"]), true);
  assert.equal(hasDraggedFiles(["text/plain"]), false);
});

test("matches HTML presentation files by extension or MIME type", () => {
  const accept = ".ppt,.pptx,.html,.pdf";
  assert.equal(contextItemMatchesAccept({ name: "deck.HTML", mimeType: "" }, accept), true);
  assert.equal(contextItemMatchesAccept({ name: "deck", mimeType: "text/html" }, "text/html"), true);
  assert.equal(contextItemMatchesAccept({ name: "notes.txt", mimeType: "text/plain" }, accept), false);
});
