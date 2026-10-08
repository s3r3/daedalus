import assert from "node:assert/strict";
import test from "node:test";
import { shouldSubmitTextarea } from "./keyboard.ts";

test("plain Enter submits", () => {
  assert.equal(shouldSubmitTextarea({ key: "Enter", shiftKey: false }), true);
});

test("Shift+Enter stays available for a newline", () => {
  assert.equal(shouldSubmitTextarea({ key: "Enter", shiftKey: true }), false);
});

test("IME candidate confirmation never submits", () => {
  assert.equal(
    shouldSubmitTextarea({ key: "Enter", shiftKey: false, isComposing: true }),
    false,
  );
});

test("WebKit IME keyCode fallback never submits", () => {
  assert.equal(
    shouldSubmitTextarea({ key: "Enter", shiftKey: false, keyCode: 229 }),
    false,
  );
});

test("other keys do not submit", () => {
  assert.equal(shouldSubmitTextarea({ key: "a", shiftKey: false }), false);
});
