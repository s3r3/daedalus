import assert from "node:assert/strict";
import test from "node:test";
import {
  createResearchProgress,
  reduceResearchProgress,
  researchSourceId,
} from "./researchProgress.ts";

test("research progress streams calls, citations, markdown, and completion", () => {
  let progress = createResearchProgress(2, 1);
  progress = reduceResearchProgress(progress, { type: "research", phase: "planning", round: 1, totalRounds: 2 }, 2);
  progress = reduceResearchProgress(progress, {
    type: "research",
    phase: "searching",
    round: 1,
    callId: "ws-1",
    detail: "agent-native presentation market",
    state: "running",
  }, 3);
  progress = reduceResearchProgress(progress, {
    type: "research",
    phase: "searching",
    round: 1,
    callId: "ws-1",
    detail: "agent-native presentation market",
    state: "complete",
  }, 4);
  progress = reduceResearchProgress(progress, {
    type: "research",
    phase: "source",
    round: 1,
    source: { id: researchSourceId("https://example.com/report"), url: "https://example.com/report", title: "example.com" },
  }, 5);
  progress = reduceResearchProgress(progress, {
    type: "research",
    phase: "source",
    round: 1,
    source: { id: researchSourceId("https://example.com/report"), url: "https://example.com/report", title: "Market report", snippet: "Key market evidence." },
  }, 6);
  progress = reduceResearchProgress(progress, { type: "research", phase: "writing", round: 1 }, 7);
  progress = reduceResearchProgress(progress, { type: "research", phase: "delta", round: 1, delta: "# Report\n" }, 8);
  progress = reduceResearchProgress(progress, { type: "research", phase: "complete", round: 2, markdown: "# Final report" }, 9);

  assert.equal(progress.searchCount, 1);
  assert.equal(progress.sources.length, 1);
  assert.equal(progress.sources[0].title, "Market report");
  assert.equal(progress.sources[0].snippet, "Key market evidence.");
  assert.equal(progress.markdown, "# Final report");
  assert.equal(progress.status, "complete");
  assert.ok(progress.activities.every((activity) => activity.state === "complete"));
});

test("a new synthesis round replaces the visible draft instead of duplicating it", () => {
  let progress = createResearchProgress(2, 1);
  progress = reduceResearchProgress(progress, { type: "research", phase: "delta", round: 1, delta: "first" }, 2);
  progress = reduceResearchProgress(progress, { type: "research", phase: "delta", round: 2, delta: "improved" }, 3);
  assert.equal(progress.markdown, "improved");
  assert.equal(progress.draftRound, 2);
});
