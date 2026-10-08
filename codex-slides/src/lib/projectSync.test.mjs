import assert from "node:assert/strict";
import test from "node:test";
import {
  ACTIVE_PROJECT_POLL_MS,
  IDLE_PROJECT_POLL_MS,
  checkpointSignature,
  editableProjectSignature,
  projectResponseEtag,
  slideImageVersion,
} from "./projectSync.ts";

function project(overrides = {}) {
  return {
    id: "deck-a",
    title: "Deck A",
    createdAt: "2026-07-12T00:00:00.000Z",
    updatedAt: "2026-07-12T01:00:00.000Z",
    config: { requirement: "Demo", aspect: "16:9", pages: 1, language: "en", resolution: "2K", engine: "codex" },
    pages: [],
    outline: [],
    workflow: { stage: "deck", updatedAt: 100, queuedRequests: [] },
    ...overrides,
  };
}

test("checkpoint identity ignores recovery timestamps but preserves workflow content", () => {
  const first = checkpointSignature({ title: "Deck", workflow: { stage: "deck", updatedAt: 1 } });
  const second = checkpointSignature({ title: "Deck", workflow: { stage: "deck", updatedAt: 99 } });
  const changed = checkpointSignature({ title: "Deck", workflow: { stage: "outline", updatedAt: 99 } });
  assert.equal(first, second);
  assert.notEqual(first, changed);
});

test("project PATCH no-op identity ignores only persistence timestamps", () => {
  const base = project();
  assert.equal(
    editableProjectSignature(base),
    editableProjectSignature(project({
      updatedAt: "2026-07-12T02:00:00.000Z",
      workflow: { ...base.workflow, updatedAt: 999 },
    })),
  );
  assert.notEqual(
    editableProjectSignature(base),
    editableProjectSignature(project({ workflow: { ...base.workflow, queuedRequests: [{ message: "Update" }] } })),
  );
});

test("slide image versions are per-image and legacy fallbacks stay stable", () => {
  assert.equal(slideImageVersion(project(), { imageUpdatedAt: 42 }), 42);
  assert.equal(slideImageVersion(project(), {}), Date.parse("2026-07-12T00:00:00.000Z"));
});

test("project validators and polling cadence are deterministic", () => {
  assert.equal(projectResponseEtag(project()), projectResponseEtag(project()));
  assert.ok(IDLE_PROJECT_POLL_MS >= ACTIVE_PROJECT_POLL_MS * 4);
});
