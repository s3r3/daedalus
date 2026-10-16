import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { appendEvent } from "./timeline.ts";
import type { RunContext, WorkflowEngine } from "./types.ts";

/**
 * Dae Captain unified approval (v2, Fase 3C).
 *
 * Design source: "Dae Captain - Master Design.md", Arsitektur Global #2.6
 * (Approval Terpadu). One policy for all five engines:
 *
 *   destructive -> "ask"     hapus file/deck/dataset: minta konfirmasi
 *   reversible  -> "auto"     edit file/slide/cell: jalan + dukung Undo
 *   explicit    -> "button"   Buat/Jalankan/Mulai Riset: via tombol di kartu
 *
 * Requests, grants, and denials all land on the run timeline as `approval`
 * events. Undo snapshots are bounded: inline content up to 1 MB per
 * snapshot, larger data spills to a backup file (backupDir) instead of
 * living in memory without limit.
 */

export type ActionKind = "destructive" | "reversible" | "explicit";
export type ApprovalTreatment = "ask" | "auto" | "button";

/** Kind -> treatment. The default matches the master design table. */
export type ApprovalPolicy = Record<ActionKind, ApprovalTreatment>;

export const DEFAULT_APPROVAL_POLICY: ApprovalPolicy = {
  destructive: "ask",
  reversible: "auto",
  explicit: "button",
};

/** Reversible actions also ask — for cautious workspaces. */
export const STRICT_APPROVAL_POLICY: ApprovalPolicy = {
  destructive: "ask",
  reversible: "ask",
  explicit: "button",
};

/** One proposed action. The engine/server builds these; core classifies them. */
export type Action = {
  /** Canonical type, e.g. "delete_file", "edit_slide", "start_research". */
  type: string;
  engine: WorkflowEngine;
  /** Human summary shown in the approval card / chat. */
  summary: string;
  /** Target description: path, deck name, dataset id... */
  target?: string;
  /** Engine task id, carried into the timeline event. */
  taskId?: string;
  /** Free detail, e.g. the command text for "run_command". */
  detail?: string;
  /** Undo entry id, set after recordUndo(). */
  undoId?: string;
};

export type ActionClassification = {
  kind: ActionKind;
  treatment: ApprovalTreatment;
  /**
   * True when the action must NOT run without user involvement:
   * a confirmation for destructive, the card button for explicit.
   */
  needsApproval: boolean;
};

/** Explicit actions only ever run after the user presses the card button. */
const EXPLICIT_TYPES = new Set([
  "create_deck",
  "generate_deck",
  "generate_slides",
  "start_research",
  "run_research",
  "run_analysis_plan",
  "approve_analysis_plan",
  "create_workbook",
  "generate_workbook",
  "generate_document",
  "create_document",
  "confirm_plan",
  "start_plan",
]);

const DESTRUCTIVE_TYPES = new Set([
  "delete_file",
  "delete_files",
  "delete_deck",
  "delete_document",
  "delete_workbook",
  "delete_dataset",
  "delete_report",
  "delete_source",
  "drop_table",
  "truncate_table",
  "reset_workspace",
]);

const REVERSIBLE_TYPES = new Set([
  "create_file",
  "edit_file",
  "write_file",
  "modify_file",
  "edit_slide",
  "edit_slides",
  "restyle_deck",
  "change_theme",
  "edit_cell",
  "edit_sheet",
  "add_sheet",
  "update_field",
  "correct_field",
  "run_command",
  "install_package",
  "scaffold",
]);

/** Commands that are destructive no matter who runs them. */
const DANGEROUS_COMMAND_RE =
  /\b(rm\s+(-[a-z]*r[a-z]*|--recursive)\b|del\s+\/[fsq]|rmdir\s+\/s|format\s+[a-z]:|mkfs|:?\(\s*\)\s*\{[^}]*\}\s*;?|git\s+(clean\s+-fd|reset\s+--hard)|drop\s+table|truncate\s+table)\b/i;

/**
 * Classify one action. Unknown types default to reversible (auto + Undo) —
 * chat-first, not bureaucratic; anything matching the destructive sets, or
 * a dangerous command, asks first. Safety-critical new actions should be
 * registered in the sets above explicitly.
 */
export function classifyAction(
  action: Action,
  policy: ApprovalPolicy = DEFAULT_APPROVAL_POLICY,
): ActionClassification {
  const t = action.type.toLowerCase().trim();
  let kind: ActionKind;
  if (EXPLICIT_TYPES.has(t)) {
    kind = "explicit";
  } else if (
    DESTRUCTIVE_TYPES.has(t) ||
    (t === "run_command" && DANGEROUS_COMMAND_RE.test(action.detail ?? ""))
  ) {
    kind = "destructive";
  } else if (REVERSIBLE_TYPES.has(t) || t === "") {
    kind = "reversible";
  } else {
    kind = "reversible";
  }
  const treatment = policy[kind];
  return { kind, treatment, needsApproval: treatment !== "auto" };
}

// ---------------------------------------------------------------------------
// Approval lifecycle: request -> grant | deny (timeline-backed)
// ---------------------------------------------------------------------------

export type PendingApproval = {
  approvalId: string;
  action: Action;
  kind: ActionKind;
  treatment: ApprovalTreatment;
  status: "requested" | "granted" | "denied";
  requestedAt: string;
};

/**
 * In-process registry of requested-but-undecided approvals. The timeline
 * is the durable record (decision events); this map holds the action
 * payloads the UI needs to render the approval card.
 */
const pendingApprovals = new Map<string, PendingApproval>();

/**
 * Ask for approval: registers the request and appends an `approval`
 * (requested) event to the run timeline.
 */
export function requestApproval(
  run: RunContext,
  action: Action,
  opts?: { policy?: ApprovalPolicy },
): PendingApproval {
  const c = classifyAction(action, opts?.policy);
  const pending: PendingApproval = {
    approvalId: randomUUID(),
    action,
    kind: c.kind,
    treatment: c.treatment,
    status: "requested",
    requestedAt: new Date().toISOString(),
  };
  pendingApprovals.set(pending.approvalId, pending);
  appendEvent(run, "approval", {
    decision: "requested",
    summary: `${action.summary} [${c.kind}]`,
    ...(action.taskId ? { task_id: action.taskId } : {}),
  });
  return pending;
}

function settle(
  run: RunContext,
  approvalId: string,
  decision: "granted" | "denied",
): PendingApproval {
  const p = pendingApprovals.get(approvalId);
  if (!p) throw new Error(`approval tidak dikenal: ${approvalId}`);
  if (p.status !== "requested") {
    throw new Error(`approval ${approvalId} sudah ${p.status}`);
  }
  p.status = decision;
  appendEvent(run, "approval", {
    decision,
    summary: p.action.summary,
    ...(p.action.taskId ? { task_id: p.action.taskId } : {}),
  });
  pendingApprovals.delete(approvalId);
  return p;
}

/** The user approved: appends an `approval` (granted) event. */
export function grantApproval(
  run: RunContext,
  approvalId: string,
): PendingApproval {
  return settle(run, approvalId, "granted");
}

/** The user declined: appends an `approval` (denied) event. */
export function denyApproval(
  run: RunContext,
  approvalId: string,
): PendingApproval {
  return settle(run, approvalId, "denied");
}

export function getPendingApproval(
  approvalId: string,
): PendingApproval | undefined {
  return pendingApprovals.get(approvalId);
}

export function listPendingApprovals(): PendingApproval[] {
  return [...pendingApprovals.values()];
}

/** Test/maintenance helper: drop all undecided approvals. */
export function clearPendingApprovals(): void {
  pendingApprovals.clear();
}

// ---------------------------------------------------------------------------
// Undo: bounded snapshots for reversible actions
// ---------------------------------------------------------------------------

/** Inline content is capped; larger snapshots spill to a backup file. */
export const MAX_UNDO_SNAPSHOT_BYTES = 1024 * 1024; // 1 MB

export type UndoSnapshot =
  | { kind: "content"; target: string; bytes: number; content: string }
  | { kind: "backup_path"; target: string; bytes: number; backupPath: string };

export type UndoEntry = {
  undoId: string;
  runId: string;
  actionType: string;
  engine: WorkflowEngine;
  summary: string;
  snapshot: UndoSnapshot;
  createdAt: string;
};

/** The pre-change data an undo needs: what changed + its old content. */
export type UndoData = {
  /** What was changed: file path, deck id, cell range... */
  target: string;
  /** Old content (utf8-safe text; binary data must use backupDir). */
  content: string | Uint8Array;
};

export type UndoStoreOptions = {
  /** Inline cap per snapshot (default 1 MB). */
  maxBytes?: number;
  /**
   * Directory for backup files when a snapshot exceeds maxBytes.
   * Without it, oversized snapshots are rejected with a clear error —
   * never silently truncated, never unbounded in memory.
   */
  backupDir?: string;
};

/**
 * Bounded store of undo snapshots. The actual undo execution stays in the
 * engines (they know how to restore); core only guarantees the old data
 * is retrievable and never grows memory without bound.
 */
export class UndoStore {
  private entries = new Map<string, UndoEntry>();
  private readonly opts: UndoStoreOptions;

  constructor(opts: UndoStoreOptions = {}) {
    this.opts = opts;
  }

  record(
    runId: string,
    action: Action,
    data: UndoData,
  ): UndoEntry {
    const bytes =
      typeof data.content === "string"
        ? Buffer.byteLength(data.content, "utf8")
        : data.content.byteLength;
    const max = this.opts.maxBytes ?? MAX_UNDO_SNAPSHOT_BYTES;
    let snapshot: UndoSnapshot;
    if (bytes <= max) {
      snapshot = {
        kind: "content",
        target: data.target,
        bytes,
        content:
          typeof data.content === "string"
            ? data.content
            : Buffer.from(data.content).toString("utf8"),
      };
    } else if (this.opts.backupDir) {
      mkdirSync(this.opts.backupDir, { recursive: true });
      const backupPath = join(this.opts.backupDir, `${randomUUID()}.bak`);
      writeFileSync(backupPath, data.content);
      snapshot = { kind: "backup_path", target: data.target, bytes, backupPath };
    } else {
      throw new Error(
        `snapshot ${bytes} bytes melebihi batas ${max} tanpa backupDir — ` +
          `set backupDir untuk data besar, bukan memori tanpa batas`,
      );
    }
    const entry: UndoEntry = {
      undoId: randomUUID(),
      runId,
      actionType: action.type,
      engine: action.engine,
      summary: action.summary,
      snapshot,
      createdAt: new Date().toISOString(),
    };
    this.entries.set(entry.undoId, entry);
    return entry;
  }

  get(undoId: string): UndoEntry | undefined {
    return this.entries.get(undoId);
  }

  has(undoId: string): boolean {
    return this.entries.has(undoId);
  }

  /** Drop one snapshot; returns true when it existed. */
  discard(undoId: string): boolean {
    return this.entries.delete(undoId);
  }

  list(): UndoEntry[] {
    return [...this.entries.values()];
  }

  get size(): number {
    return this.entries.size;
  }

  clear(): void {
    this.entries.clear();
  }
}

/**
 * Record an undo snapshot for a reversible action: stores the pre-change
 * data in `store`, links the run, and stamps `action.undoId`. Returns the
 * entry; the engines perform the actual restore later.
 */
export function recordUndo(
  store: UndoStore,
  run: RunContext,
  action: Action,
  data: UndoData,
): UndoEntry {
  const entry = store.record(run.run_id, action, data);
  action.undoId = entry.undoId;
  return entry;
}
