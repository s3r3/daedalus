/**
 * FASE E: Tests for research follow-up actions.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  buildDeepenQuestion,
  compareSources,
  getUpdateCutoff,
  buildUpdateQuery,
} from "../src/research/followup.ts";

const mockReport = {
  reportId: "r1",
  question: "Apakah AI menggantikan programmer?",
  sources: [
    { id: "s1", title: "AI in Software Engineering", authors: ["Smith, J."], year: 2023, url: "https://example.com/1", credibility: { tier: "scopus-q1", verified: true } },
    { id: "s2", title: "The Future of Coding", authors: ["Doe, A."], year: 2024, url: "https://example.com/2", credibility: { tier: "sinta2", verified: true } },
    { id: "s3", title: "AI Tools Survey 2025", authors: ["Lee, K."], year: 2025, url: "https://example.com/3", credibility: { tier: "web", verified: false } },
  ],
  claims: [
    { id: "c1", text: "AI meningkatkan produktivitas 30%", sourceIds: ["s1", "s2"], confidence: "high", status: "verified" },
    { id: "c2", text: "AI tidak menggantikan kreativitas", sourceIds: ["s2"], confidence: "moderate", status: "verified" },
  ],
  conflicts: [
    { description: "s1 klaim 30%, s3 klaim 15%", sourceIds: ["s1", "s3"] },
  ],
};

describe("FASE E: research followup", () => {
  it("buildDeepenQuestion creates a focused question from a claim", () => {
    const q = buildDeepenQuestion(mockReport.claims[0], mockReport.question);
    assert.ok(q.includes(mockReport.claims[0].text));
    assert.ok(q.includes("Dalami"));
  });

  it("compareSources returns sources with their findings", () => {
    const result = compareSources(mockReport, ["s1", "s2"]);
    assert.equal(result.sources.length, 2);
    assert.ok(result.findings.has("s1"));
    assert.ok(result.findings.get("s1").includes("AI meningkatkan produktivitas 30%"));
  });

  it("compareSources includes conflict summary", () => {
    const result = compareSources(mockReport, ["s1", "s3"]);
    assert.ok(result.summary.includes("30%"));
  });

  it("getUpdateCutoff returns max year", () => {
    assert.equal(getUpdateCutoff(mockReport), 2025);
  });

  it("buildUpdateQuery targets newer sources", () => {
    const q = buildUpdateQuery(mockReport);
    assert.ok(q.includes("2025"));
    assert.ok(q.includes(mockReport.question));
  });
});
