import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import type { ArtifactRef, WorkflowEngine } from "./types.ts";

/**
 * Dae Captain artifact translators (PR1).
 *
 * This is the ONLY new code that knows about all five engines — and it
 * only READS their standard outputs when a turn completes. It never
 * touches an engine pipeline. Every lookup is defensive: anything
 * unreadable yields no artifacts, never a throw.
 */

export type EngineCompletionInput = {
  engine: WorkflowEngine;
  /** Short human goal, used for labels. */
  goal: string;
  /** Absolute workspace root. */
  workspaceRoot: string;
  report?: {
    diff?: string;
    evidence?: string[];
    target_dir?: string;
    title?: string;
  } | null;
  /** Filled by the server for research turns (report store is server-side). */
  researchReport?: { reportId: string; title?: string } | null;
};

const MAX_FILES = 20;

function shortGoal(goal: string): string {
  const oneLine = goal.replace(/\s+/g, " ").trim();
  return oneLine.length > 60 ? `${oneLine.slice(0, 57)}...` : oneLine;
}

/** Extract `path` from unified-diff `+++ b/<path>` headers. */
function filesFromDiff(diff: string | undefined): string[] {
  if (!diff) return [];
  const files: string[] = [];
  for (const line of diff.split("\n")) {
    const match = /^\+\+\+ b\/(.+)$/.exec(line.trim());
    if (match && match[1] && match[1] !== "/dev/null") files.push(match[1]!);
  }
  return [...new Set(files)].slice(0, MAX_FILES);
}

function translateCoding(input: EngineCompletionInput): ArtifactRef[] {
  const refs: ArtifactRef[] = [];
  const files = filesFromDiff(input.report?.diff);
  if (files.length > 0) {
    refs.push({
      kind: "files",
      label: shortGoal(input.goal),
      path: files.length === 1 ? files[0] : undefined,
    });
  }
  return refs;
}

function exists(root: string, rel: string): boolean {
  try {
    return existsSync(join(root, rel));
  } catch {
    return false;
  }
}

function translateSlide(input: EngineCompletionInput): ArtifactRef[] {
  if (!exists(input.workspaceRoot, join("deck", "deck.json"))) return [];
  return [
    {
      kind: "deck",
      label: shortGoal(input.goal),
      path: join("deck", "deck.json"),
    },
  ];
}

function translateSpreadsheet(input: EngineCompletionInput): ArtifactRef[] {
  if (!exists(input.workspaceRoot, join("workbook", "workbook.json"))) {
    return [];
  }
  return [
    {
      kind: "workbook",
      label: shortGoal(input.goal),
      path: join("workbook", "workbook.json"),
    },
  ];
}

function translateDokumen(input: EngineCompletionInput): ArtifactRef[] {
  // Documents live at .daedalus/documents/<id>/document.json — pick the
  // most recently modified one. Read-only scan, failures yield nothing.
  try {
    const base = join(input.workspaceRoot, ".daedalus", "documents");
    const ids = readdirSync(base);
    let best: { id: string; mtime: number } | undefined;
    for (const id of ids) {
      const file = join(base, id, "document.json");
      try {
        const mtime = statSync(file).mtimeMs;
        if (!best || mtime > best.mtime) best = { id, mtime };
      } catch {
        /* skip */
      }
    }
    if (!best) return [];
    return [
      {
        kind: "document",
        label: shortGoal(input.goal),
        path: join(".daedalus", "documents", best.id, "document.json"),
      },
    ];
  } catch {
    return [];
  }
}

function translateResearch(input: EngineCompletionInput): ArtifactRef[] {
  const report = input.researchReport;
  if (!report) return [];
  return [
    {
      kind: "research_report",
      label: report.title ?? shortGoal(input.goal),
      report_id: report.reportId,
    },
  ];
}

export function translateArtifacts(
  input: EngineCompletionInput,
): ArtifactRef[] {
  try {
    switch (input.engine) {
      case "coding":
        return translateCoding(input);
      case "slide":
        return translateSlide(input);
      case "spreadsheet":
        return translateSpreadsheet(input);
      case "dokumen":
        return translateDokumen(input);
      case "research":
        return translateResearch(input);
    }
  } catch {
    return [];
  }
}
