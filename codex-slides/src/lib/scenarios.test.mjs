import assert from "node:assert/strict";
import test from "node:test";
import { PRESENTATION_SCENARIOS } from "./scenarios.ts";

test("every presentation-capable scenario slot also accepts HTML", () => {
  const deckSlots = PRESENTATION_SCENARIOS.flatMap((scenario) =>
    scenario.slots
      .filter((slot) => slot.accept.includes(".ppt") || slot.accept.includes(".pptx"))
      .map((slot) => ({ scenario: scenario.id, slot })),
  );
  assert.ok(deckSlots.length > 0);
  for (const { scenario, slot } of deckSlots) {
    assert.ok(
      slot.accept.includes(".html"),
      `${scenario}/${slot.id} accepts a deck but not HTML`,
    );
  }
});

test("deck-specific upload placeholders tell the user HTML is supported", () => {
  const deckSlotIds = new Set(["source-deck", "template"]);
  const visibleDeckSlots = PRESENTATION_SCENARIOS.flatMap((scenario) =>
    scenario.slots
      .filter((slot) => deckSlotIds.has(slot.id) && slot.accept.includes(".html"))
      .map((slot) => ({ scenario: scenario.id, slot })),
  );
  for (const { scenario, slot } of visibleDeckSlots) {
    assert.match(slot.detail.en, /HTML/, `${scenario}/${slot.id} hides HTML support`);
    assert.match(slot.detail["zh-CN"], /HTML/, `${scenario}/${slot.id} hides HTML support in Chinese`);
    assert.match(slot.detail.ja, /HTML/, `${scenario}/${slot.id} hides HTML support in Japanese`);
  }
});
