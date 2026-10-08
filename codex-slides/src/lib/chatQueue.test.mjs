import assert from "node:assert/strict";
import test from "node:test";
import {
  chatQueueStorageKey,
  createQueuedChatRequest,
  loadQueuedChatRequests,
  parseQueuedChatRequests,
  prioritizeQueuedChatRequest,
  reorderConversationQueue,
  saveQueuedChatRequests,
  updateQueuedChatRequest,
} from "./chatQueue.ts";

function attachment(id, kind = "file") {
  return {
    id,
    name: `${id}.txt`,
    url: `/api/files/${id}`,
    kind,
    mimeType: kind === "image" ? "image/png" : "text/plain",
    size: 12,
  };
}

function request(message, id = message) {
  return {
    message,
    attachments: [attachment(id)],
    designFiles: [{
      path: `/project/${id}.md`,
      relativePath: `${id}.md`,
      name: `${id}.md`,
      kind: "document",
    }],
    context: { slideIndex: 2, title: "Second slide" },
  };
}

test("queued turns snapshot text, slide context, images/files, and Design Files", () => {
  const source = request("Refine this", "source");
  const queued = createQueuedChatRequest("conversation-a", source, { id: "queue-a", now: 10 });

  source.attachments[0].name = "mutated.txt";
  source.designFiles[0].name = "mutated.md";
  source.context.title = "mutated";

  assert.equal(queued.message, "Refine this");
  assert.equal(queued.attachments[0].name, "source.txt");
  assert.equal(queued.designFiles[0].name, "source.md");
  assert.equal(queued.context.title, "Second slide");
  assert.equal(queued.createdAt, 10);
  assert.equal(queued.updatedAt, 10);
});

test("editing replaces the entire composer snapshot without changing queue identity", () => {
  const queued = createQueuedChatRequest("conversation-a", request("Before"), { id: "queue-a", now: 10 });
  const edited = updateQueuedChatRequest(queued, request("After", "new-file"), 20);

  assert.equal(edited.id, "queue-a");
  assert.equal(edited.conversationId, "conversation-a");
  assert.equal(edited.createdAt, 10);
  assert.equal(edited.updatedAt, 20);
  assert.equal(edited.message, "After");
  assert.equal(edited.attachments[0].id, "new-file");
});

test("reorder and prioritize stay scoped to one conversation", () => {
  const a1 = createQueuedChatRequest("a", request("a1"), { id: "a1", now: 1 });
  const b1 = createQueuedChatRequest("b", request("b1"), { id: "b1", now: 2 });
  const a2 = createQueuedChatRequest("a", request("a2"), { id: "a2", now: 3 });
  const b2 = createQueuedChatRequest("b", request("b2"), { id: "b2", now: 4 });
  const a3 = createQueuedChatRequest("a", request("a3"), { id: "a3", now: 5 });

  const reordered = reorderConversationQueue([a1, b1, a2, b2, a3], "a", ["a3", "a1", "a2"]);
  assert.deepEqual(reordered.map((item) => item.id), ["a3", "b1", "a1", "b2", "a2"]);

  const prioritized = prioritizeQueuedChatRequest(reordered, "a2");
  assert.deepEqual(prioritized.map((item) => item.id), ["a2", "b1", "a3", "b2", "a1"]);
});

test("project queue persists and reloads valid attachment snapshots", () => {
  const values = new Map();
  const storage = {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
    removeItem: (key) => values.delete(key),
  };
  const item = createQueuedChatRequest("conversation-a", request("Persist me"), { id: "queue-a", now: 10 });

  saveQueuedChatRequests("project-a", [item], storage);
  assert.equal(values.has(chatQueueStorageKey("project-a")), true);
  assert.deepEqual(loadQueuedChatRequests("project-a", storage), [item]);

  saveQueuedChatRequests("project-a", [], storage);
  assert.equal(values.has(chatQueueStorageKey("project-a")), false);
});

test("malformed persisted records are ignored instead of blocking the queue", () => {
  const parsed = parseQueuedChatRequests(JSON.stringify([
    null,
    { id: "missing-conversation", message: "bad", createdAt: 1, updatedAt: 1 },
    {
      id: "valid",
      conversationId: "conversation-a",
      message: "good",
      createdAt: 1,
      updatedAt: 2,
      attachments: [{ id: "x", name: "x.png", url: "/x", kind: "image", mimeType: "image/png", size: 2 }],
    },
  ]));

  assert.equal(parsed.length, 1);
  assert.equal(parsed[0].id, "valid");
  assert.equal(parsed[0].attachments[0].kind, "image");
});
