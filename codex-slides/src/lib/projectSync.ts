import type { Project, SlidePage } from "./types";

/** Active runs need near-live progress; idle projects only need a periodic
 * cross-process safety net because focus/visibility changes also refresh them. */
export const ACTIVE_PROJECT_POLL_MS = 1_500;
export const IDLE_PROJECT_POLL_MS = 12_000;

type CheckpointLike = {
  config?: unknown;
  title?: string;
  researchDoc?: string;
  workflow?: Record<string, unknown>;
};

function workflowWithoutTimestamp(workflow: Record<string, unknown> | undefined) {
  if (!workflow) return undefined;
  const { updatedAt: _updatedAt, ...content } = workflow;
  return content;
}

/** Client checkpoints add a wall-clock timestamp for local recovery. It must
 * never turn an otherwise identical checkpoint into a server mutation. */
export function checkpointSignature(patch: CheckpointLike): string {
  return JSON.stringify({
    config: patch.config,
    title: patch.title,
    researchDoc: patch.researchDoc,
    workflow: workflowWithoutTimestamp(patch.workflow),
  });
}

/** Fields writable by the project PATCH route. Project/workflow timestamps are
 * transport metadata, not user-visible content, so they are deliberately
 * excluded from no-op detection. */
export function editableProjectSignature(project: Project): string {
  return JSON.stringify({
    title: project.title,
    researchDoc: project.researchDoc,
    research: project.research,
    config: project.config,
    materials: project.materials ?? [],
    workflow: workflowWithoutTimestamp(project.workflow as unknown as Record<string, unknown> | undefined),
  });
}

/** A cheap conditional-request validator shared by the server route and the
 * hydrated client. `updatedAt` changes on every real persisted mutation. */
export function projectResponseEtag(project: Pick<Project, "updatedAt">): string {
  const version = String(project.updatedAt || "0").replace(/[^A-Za-z0-9._:-]/g, "");
  return `W/"ppt-${version || "0"}"`;
}

/** Legacy decks predate per-slide versions. Their creation time is a stable
 * fallback, while every image written by current code receives its own version. */
export function slideImageVersion(
  project: Pick<Project, "createdAt">,
  slide: Pick<SlidePage, "imageUpdatedAt">,
): number | undefined {
  if (Number.isFinite(slide.imageUpdatedAt) && Number(slide.imageUpdatedAt) > 0) {
    return Number(slide.imageUpdatedAt);
  }
  const createdAt = new Date(project.createdAt).getTime();
  return Number.isFinite(createdAt) ? createdAt : undefined;
}

export function jsonEqual(left: unknown, right: unknown): boolean {
  return left === right || JSON.stringify(left) === JSON.stringify(right);
}
