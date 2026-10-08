import assert from "node:assert/strict";
import test from "node:test";
import {
  extractCitationSources,
  extractWebSearchSignals,
} from "./researchSignals.ts";

test("extracts query arrays and source URLs from completed web search items", () => {
  const signals = extractWebSearchSignals({
    type: "response.output_item.done",
    item: {
      id: "ws_123",
      type: "web_search_call",
      status: "completed",
      action: {
        type: "search",
        queries: ["market size", "recent launches"],
        sources: [{ type: "url", url: "https://example.com/report" }],
      },
    },
  });
  assert.deepEqual(signals, [{
    callId: "ws_123",
    queries: ["market size", "recent launches"],
    state: "complete",
    urls: ["https://example.com/report"],
  }]);
});

test("extracts titled URL citations and the surrounding report sentence", () => {
  const markdown = "# Findings\n\nThe market doubled in 2025 according to the annual report [1].";
  const sources = extractCitationSources({
    type: "response.output_text.annotation.added",
    annotation: {
      type: "url_citation",
      url: "https://example.com/report",
      title: "Annual market report",
      start_index: markdown.length - 4,
      end_index: markdown.length - 1,
    },
  }, markdown);
  assert.equal(sources[0].title, "Annual market report");
  assert.match(sources[0].snippet, /market doubled/);
});
