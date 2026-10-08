import assert from "node:assert/strict";
import test from "node:test";
import { normalizeGeneratedSpeakerNotes } from "./speakerNotesData.ts";

test("normalizes agent speaker-note JSON and preserves requested slide order", () => {
  assert.deepEqual(
    normalizeGeneratedSpeakerNotes({ notes: [
      { index: 3, note: "  Third note  " },
      { index: 1, speakerNotes: "First note" },
    ] }, [1, 3]),
    [
      { index: 1, note: "First note" },
      { index: 3, note: "Third note" },
    ],
  );
});

test("uses requested indexes for string arrays and ignores invented slides", () => {
  assert.deepEqual(
    normalizeGeneratedSpeakerNotes([
      "Opening note",
      { index: 99, note: "Invented" },
      { index: 4, note: "Closing note" },
    ], [2, 4]),
    [
      { index: 2, note: "Opening note" },
      { index: 4, note: "Closing note" },
    ],
  );
});
