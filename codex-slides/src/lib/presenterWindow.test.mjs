import assert from "node:assert/strict";
import test from "node:test";
import { buildPresenterWindowHtml } from "./presenterWindow.ts";

const labels = {
  windowTitle: "Presenter view",
  notesTitle: "Speaker notes",
  pause: "Pause",
  resume: "Resume",
  reset: "Reset",
  previous: "Previous",
  next: "Next",
  empty: "No notes",
  slide: "Slide {current} / {total}",
  save: "Save",
  saved: "Saved",
  saveFailed: "Save failed",
};

test("presenter window contains synchronized stage, filmstrip, timer, and notes editor", () => {
  const html = buildPresenterWindowHtml({
    title: "Demo",
    channelId: "channel-1",
    projectId: "project-1",
    initialIndex: 1,
    labels,
    slides: [
      { index: 1, url: "https://example.test/01.png", title: "One", speakerNotes: "First" },
      { index: 2, url: "https://example.test/02.png", title: "Two", speakerNotes: "Second" },
    ],
  });

  assert.match(html, /id="timer"/);
  assert.match(html, /id="current"/);
  assert.match(html, /id="previous-section"/);
  assert.match(html, /id="next-section"/);
  assert.match(html, /id="notes-body"/);
  assert.match(html, /codex-slides:presenter-go/);
  assert.match(html, /codex-slides:presenter-notes-save/);
  assert.match(html, /codex-slides:presenter-state/);
});

test("presenter data cannot terminate its JSON script block", () => {
  const html = buildPresenterWindowHtml({
    title: "Safe",
    channelId: "channel-2",
    projectId: "project-2",
    initialIndex: 0,
    labels,
    slides: [{
      index: 1,
      url: "https://example.test/01.png",
      title: "</script><script>alert(1)</script>",
      speakerNotes: "</script><script>alert(2)</script>",
    }],
  });
  const dataBlock = html.match(/<script type="application\/json" id="presenter-data">([\s\S]*?)<\/script>/)?.[1] ?? "";
  assert.doesNotMatch(dataBlock, /<script>/i);
  assert.match(dataBlock, /\\u003c\/script>/);
});
