import assert from "node:assert/strict";
import test from "node:test";
import { chatBottomDistance, isNearChatBottom } from "./chatScroll.ts";

test("chat follows only when the reader is already near the latest message", () => {
  assert.equal(chatBottomDistance({ scrollHeight: 1_000, scrollTop: 700, clientHeight: 300 }), 0);
  assert.equal(isNearChatBottom({ scrollHeight: 1_000, scrollTop: 640, clientHeight: 300 }), true);
  assert.equal(isNearChatBottom({ scrollHeight: 1_000, scrollTop: 500, clientHeight: 300 }), false);
});

