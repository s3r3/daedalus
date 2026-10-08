import assert from "node:assert/strict";
import test from "node:test";
import { fileMentionAtCursor, replaceFileMention } from "./designFileMentions.ts";

test("matches an @ file query at a word boundary", () => {
  assert.deepEqual(fileMentionAtCursor("请参考 @out", 8), { start: 4, query: "out" });
});

test("does not treat an email address as a file mention", () => {
  assert.equal(fileMentionAtCursor("me@example.com", 14), null);
});

test("replaces only the active query and preserves following text", () => {
  assert.deepEqual(
    replaceFileMention("Use @outnext", 8, { start: 4, query: "out" }, "outline.md"),
    { value: "Use @outline.md next", cursor: 16 },
  );
});

test("file names with spaces remain one selected reference", () => {
  assert.deepEqual(
    replaceFileMention("@br", 3, { start: 0, query: "br" }, "brand brief.pdf"),
    { value: "@brand brief.pdf", cursor: 16 },
  );
});
