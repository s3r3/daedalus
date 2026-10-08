import assert from "node:assert/strict";
import test from "node:test";

import { isAbortError, withRetry } from "./retry.ts";

const noBackoff = () => 0;

test("withRetry recovers a flaky op that fails then succeeds", async () => {
  let calls = 0;
  const retried = [];
  const result = await withRetry(
    async () => {
      calls += 1;
      if (calls < 3) throw new Error(`transient ${calls}`);
      return "ok";
    },
    { attempts: 3, backoffMs: noBackoff, onRetry: (attempt) => retried.push(attempt) },
  );
  assert.equal(result, "ok");
  assert.equal(calls, 3);
  // onRetry fires before each RE-attempt: after try 1 and try 2 failed, not after success.
  assert.deepEqual(retried, [1, 2]);
});

test("withRetry throws the last error once all attempts are spent", async () => {
  let calls = 0;
  await assert.rejects(
    () => withRetry(async () => { calls += 1; throw new Error("always"); }, { attempts: 3, backoffMs: noBackoff }),
    /always/,
  );
  assert.equal(calls, 3);
});

test("withRetry never retries an abort — it propagates immediately", async () => {
  let calls = 0;
  await assert.rejects(
    () => withRetry(
      async () => { calls += 1; const e = new Error("aborted"); throw e; },
      { attempts: 5, backoffMs: noBackoff },
    ),
    /aborted/,
  );
  assert.equal(calls, 1, "an abort must not be retried");
});

test("withRetry short-circuits when the signal is already aborted", async () => {
  const controller = new AbortController();
  controller.abort();
  let calls = 0;
  await assert.rejects(
    () => withRetry(async () => { calls += 1; return "unreached"; }, { attempts: 3, signal: controller.signal, backoffMs: noBackoff }),
    /aborted/,
  );
  assert.equal(calls, 0, "an already-aborted signal must not run the op");
});

test("withRetry stops retrying once the signal aborts mid-flight", async () => {
  const controller = new AbortController();
  let calls = 0;
  await assert.rejects(
    () => withRetry(
      async () => { calls += 1; controller.abort(); throw new Error("network blip"); },
      { attempts: 5, signal: controller.signal, backoffMs: noBackoff },
    ),
  );
  // First call runs and aborts the signal; the loop's pre-attempt guard then stops.
  assert.equal(calls, 1);
});

test("isAbortError recognizes cancels but not ordinary failures", () => {
  assert.equal(isAbortError(new Error("aborted")), true);
  assert.equal(isAbortError(Object.assign(new Error("x"), { name: "AbortError" })), true);
  assert.equal(isAbortError(new Error("HTTP 500")), false);
  const live = new AbortController();
  assert.equal(isAbortError(new Error("anything"), live.signal), false);
  live.abort();
  assert.equal(isAbortError(new Error("anything"), live.signal), true);
});
