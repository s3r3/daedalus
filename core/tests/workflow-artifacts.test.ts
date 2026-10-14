import { mkdtempSync, mkdirSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { translateArtifacts } from "../src/workflow/artifacts.ts";

let ws: string;

beforeEach(() => {
  ws = mkdtempSync(join(tmpdir(), "dae-captain-artifacts-"));
});

afterEach(() => {
  rmSync(ws, { recursive: true, force: true });
});

const DIFF = [
  "diff --git a/index.html b/index.html",
  "+++ b/index.html",
  "diff --git a/src/app.ts b/src/app.ts",
  "+++ b/src/app.ts",
].join("\n");

describe("translateArtifacts", () => {
  test("coding: files parsed from the report diff", () => {
    const refs = translateArtifacts({
      engine: "coding",
      goal: "buat landing page",
      workspaceRoot: ws,
      report: { diff: DIFF },
    });
    expect(refs).toHaveLength(1);
    expect(refs[0]!.kind).toBe("files");
    expect(refs[0]!.label).toContain("landing page");
  });

  test("coding: no diff → no artifacts (never throws)", () => {
    expect(
      translateArtifacts({ engine: "coding", goal: "x", workspaceRoot: ws }),
    ).toEqual([]);
  });

  test("slide: deck.json detected", () => {
    mkdirSync(join(ws, "deck"), { recursive: true });
    writeFileSync(join(ws, "deck", "deck.json"), "{}");
    const refs = translateArtifacts({
      engine: "slide",
      goal: "deck presentasi",
      workspaceRoot: ws,
    });
    expect(refs).toEqual([
      { kind: "deck", label: "deck presentasi", path: "deck/deck.json" },
    ]);
  });

  test("slide: missing deck.json → no artifacts", () => {
    expect(
      translateArtifacts({ engine: "slide", goal: "x", workspaceRoot: ws }),
    ).toEqual([]);
  });

  test("spreadsheet: workbook.json detected", () => {
    mkdirSync(join(ws, "workbook"), { recursive: true });
    writeFileSync(join(ws, "workbook", "workbook.json"), "{}");
    const refs = translateArtifacts({
      engine: "spreadsheet",
      goal: "rekap pemasukan",
      workspaceRoot: ws,
    });
    expect(refs[0]).toMatchObject({
      kind: "workbook",
      path: join("workbook", "workbook.json"),
    });
  });

  test("dokumen: newest document.json picked", () => {
    const d1 = join(ws, ".daedalus", "documents", "aaa");
    const d2 = join(ws, ".daedalus", "documents", "bbb");
    mkdirSync(d1, { recursive: true });
    mkdirSync(d2, { recursive: true });
    writeFileSync(join(d1, "document.json"), "{}");
    writeFileSync(join(d2, "document.json"), "{}");
    // Force mtime order: bbb is newest.
    const past = new Date(Date.now() - 60_000);
    const now = new Date();
    utimesSync(join(d1, "document.json"), past, past);
    utimesSync(join(d2, "document.json"), now, now);
    const refs = translateArtifacts({
      engine: "dokumen",
      goal: "surat penawaran",
      workspaceRoot: ws,
    });
    expect(refs).toHaveLength(1);
    expect(refs[0]!.path).toContain("bbb");
  });

  test("research: report id carried through", () => {
    const refs = translateArtifacts({
      engine: "research",
      goal: "riset landing page",
      workspaceRoot: ws,
      researchReport: { reportId: "r-123", title: "Audit landing page" },
    });
    expect(refs).toEqual([
      { kind: "research_report", label: "Audit landing page", report_id: "r-123" },
    ]);
  });

  test("research: no report yet → no artifacts", () => {
    expect(
      translateArtifacts({ engine: "research", goal: "x", workspaceRoot: ws }),
    ).toEqual([]);
  });
});
