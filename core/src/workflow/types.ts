import type { TaskDomain } from "../contracts.ts";

/**
 * Dae Captain workflow types (PR1).
 *
 * The workflow layer is orchestration-only: it routes chat messages to one
 * of the five agentic engines, remembers per-run artifact references so
 * "tadi" can be resolved, and never calls engine classes directly.
 */

/** The five agentic engines Dae Captain can route to. */
export type WorkflowEngine = TaskDomain;

export const WORKFLOW_ENGINES: readonly WorkflowEngine[] = [
  "coding",
  "slide",
  "dokumen",
  "spreadsheet",
  "research",
] as const;

export function isWorkflowEngine(value: unknown): value is WorkflowEngine {
  return (
    typeof value === "string" &&
    (WORKFLOW_ENGINES as readonly string[]).includes(value)
  );
}

export type ArtifactKind =
  | "files"
  | "deck"
  | "workbook"
  | "document"
  | "research_report"
  | "url"
  | "export";

export type ArtifactRef = {
  kind: ArtifactKind;
  /** Human label, e.g. "landing page Vue" or "deck presentasi bisnis". */
  label: string;
  /** Workspace-relative path (deck.json, workbook.json, ...). */
  path?: string;
  /** Workspace-relative export path (.pptx / .pdf / .xlsx). */
  export_path?: string;
  /** Research report id. */
  report_id?: string;
  /** Dev / preview URL. */
  url?: string;
};

export type RunTurnStatus = "running" | "done" | "failed" | "cancelled";

export type RunTurn = {
  turn_id: string;
  engine: WorkflowEngine;
  /** Engine task id — or the staged research plan id for research turns. */
  task_id: string;
  goal: string;
  status: RunTurnStatus;
  artifacts: ArtifactRef[];
  /** Extra human note, e.g. "rencana riset staged — menunggu 'Jalankan riset'". */
  note?: string;
  created_at: string;
  updated_at: string;
};

export type RunContext = {
  run_id: string;
  workspace_root: string;
  turns: RunTurn[];
  created_at: string;
  updated_at: string;
};
