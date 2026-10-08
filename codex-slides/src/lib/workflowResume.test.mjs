import assert from "node:assert/strict";
import test from "node:test";
import { shouldResumeResearch } from "./workflowResume.ts";

const baseProject = {
  id: "project-resume",
  createdAt: "2026-07-12T00:00:00.000Z",
  updatedAt: "2026-07-12T00:00:00.000Z",
  config: { requirement: "Deck", mode: "direct" },
  agent: "codex",
  title: "Deck",
  outline: [],
  pages: [],
};

test("legacy launch context restores deep research during clarification", () => {
  const project = {
    ...baseProject,
    chat: [{
      role: "user",
      content: "Deck",
      contextOptions: [{ id: "research", kind: "research", label: "Deep research" }],
    }],
  };
  assert.equal(shouldResumeResearch(project, project.config, { stage: "clarify" }), true);
});

test("explicit workflow toggle wins over legacy chat context", () => {
  const project = {
    ...baseProject,
    chat: [{
      role: "user",
      content: "Deck",
      contextOptions: [{ id: "research", kind: "research", label: "Deep research" }],
    }],
  };
  assert.equal(shouldResumeResearch(project, project.config, {
    stage: "clarify",
    researchMode: false,
  }), false);
});

test("persisted research config restores the research step", () => {
  assert.equal(shouldResumeResearch(baseProject, {
    ...baseProject.config,
    mode: "research",
  }, { stage: "outlining" }), true);
});
