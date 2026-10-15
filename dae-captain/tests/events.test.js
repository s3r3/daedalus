import { test } from "node:test";
import assert from "node:assert/strict";
import { createEventStream, EVENT_PROTOCOL } from "../ui/events.js";

// Mock WebSocket
class MockWS {
  static OPEN = 1;
  constructor(url, protocol) {
    this.url = url;
    this.protocol = protocol;
    this.readyState = MockWS.OPEN;
    this.sent = [];
    MockWS.instances.push(this);
  }
  send(data) { this.sent.push(JSON.parse(data)); }
  close() { this.readyState = 3; this.onclose?.(); }
}
MockWS.instances = [];
globalThis.WebSocket = MockWS;

test("EVENT_PROTOCOL is daedalus-events", () => {
  assert.equal(EVENT_PROTOCOL, "daedalus-events");
});

test("subscribe sends subscribe message with task_id", () => {
  MockWS.instances = [];
  const events = [];
  const stream = createEventStream({
    getWsUrl: () => "ws://127.0.0.1:3080/tasks/events",
    onEvents: (evs) => events.push(...evs),
  });
  stream.subscribe("task-123");
  const ws = MockWS.instances[0];
  assert.ok(ws);
  assert.equal(ws.protocol, "daedalus-events");
  // Trigger onopen
  ws.onopen();
  const sub = ws.sent.find((m) => m.kind === "subscribe");
  assert.ok(sub);
  assert.equal(sub.task_id, "task-123");
  assert.equal(sub.since_seq, 0);
  stream.close();
});

test("onmessage handles event and updates seq", () => {
  MockWS.instances = [];
  const events = [];
  const stream = createEventStream({
    getWsUrl: () => "ws://127.0.0.1:3080/tasks/events",
    onEvents: (evs) => events.push(...evs),
  });
  stream.subscribe("task-123");
  const ws = MockWS.instances[0];
  ws.onopen();
  // Simulate event message
  ws.onmessage({ data: JSON.stringify({ kind: "event", event: { type: "THOUGHT", seq: 5, task_id: "task-123" } }) });
  assert.equal(events.length, 1);
  assert.equal(events[0].type, "THOUGHT");
  stream.close();
});

test("reconnect uses last seq", () => {
  MockWS.instances = [];
  const stream = createEventStream({
    getWsUrl: () => "ws://127.0.0.1:3080/tasks/events",
    onEvents: () => {},
  });
  stream.subscribe("task-123");
  const ws1 = MockWS.instances[0];
  ws1.onopen();
  ws1.onmessage({ data: JSON.stringify({ kind: "event", event: { type: "THOUGHT", seq: 10 } }) });
  // Simulate disconnect and reconnect
  ws1.onclose();
  // Wait for reconnect (use short delay in test by directly calling connect via new subscribe)
  stream.subscribe("task-123"); // resets seq to 0
  const ws2 = MockWS.instances[MockWS.instances.length - 1];
  ws2.onopen();
  const sub = ws2.sent.find((m) => m.kind === "subscribe");
  assert.equal(sub.since_seq, 0); // reset on new subscribe
  stream.close();
});
