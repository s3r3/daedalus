import assert from "node:assert/strict";
import test from "node:test";
import {
  defaultDesignFileViewerMode,
  designFilePreviewKind,
  workflowArtifactIdForPath,
} from "./designFilePreview.ts";

function file(overrides = {}) {
  return {
    path: "generated/brief.md",
    absolutePath: "/tmp/brief.md",
    name: "brief.md",
    kind: "document",
    source: "generated",
    size: 100,
    updatedAt: "2026-07-12T00:00:00.000Z",
    editable: true,
    ...overrides,
  };
}

test("persisted workflow files retain their semantic preview after reopen", () => {
  const available = new Set(["questions", "outline", "research", "inspiration"]);
  assert.equal(designFilePreviewKind(file(), available), "questions");
  assert.equal(designFilePreviewKind(file({ path: "generated/outline.md", name: "outline.md" }), available), "outline");
  assert.equal(designFilePreviewKind(file({ path: "generated/research.md", name: "research.md" }), available), "research");
  assert.equal(designFilePreviewKind(file({ path: "generated/inspiration.json", name: "inspiration.json", kind: "data" }), available), "inspiration");
  assert.equal(workflowArtifactIdForPath("/generated/brief.md"), "questions");
});

test("markdown, JSON, and HTML open in preview mode even though source is editable", () => {
  for (const [name, kind] of [["notes.md", "markdown"], ["data.json", "json"], ["artifact.html", "html"]]) {
    const previewKind = designFilePreviewKind(file({ path: `uploaded/${name}`, name, kind: "document" }));
    assert.equal(previewKind, kind);
    assert.equal(defaultDesignFileViewerMode(previewKind), "preview");
  }
});

test("plain code remains source-first", () => {
  const previewKind = designFilePreviewKind(file({ path: "uploaded/app.ts", name: "app.ts", kind: "code" }));
  assert.equal(previewKind, null);
  assert.equal(defaultDesignFileViewerMode(previewKind), "source");
});
