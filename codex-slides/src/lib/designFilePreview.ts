import type { ProjectFileRecord } from "./types";

export type WorkflowArtifactId = "questions" | "outline" | "research" | "inspiration";
export type DesignFilePreviewKind = WorkflowArtifactId | "markdown" | "json" | "html" | "image" | "embed";
export type DesignFileViewerMode = "preview" | "source";

const WORKFLOW_PATHS: Record<string, WorkflowArtifactId> = {
  "generated/brief.md": "questions",
  "generated/outline.md": "outline",
  "generated/research.md": "research",
  "generated/inspiration.json": "inspiration",
};

export function workflowArtifactIdForPath(filePath: string): WorkflowArtifactId | null {
  return WORKFLOW_PATHS[filePath.replace(/^[/\\]+/, "")] ?? null;
}

/**
 * Small renderer registry inspired by Open Design's artifact dispatch: durable
 * files reopen in preview mode by type, while source remains an explicit tab.
 */
export function designFilePreviewKind(
  file: ProjectFileRecord,
  availableWorkflowArtifacts: ReadonlySet<string> = new Set(),
): DesignFilePreviewKind | null {
  const workflowArtifact = workflowArtifactIdForPath(file.path);
  if (workflowArtifact && availableWorkflowArtifacts.has(workflowArtifact)) return workflowArtifact;

  const extension = file.name.toLowerCase().match(/\.[^.]+$/)?.[0] ?? "";
  if (extension === ".html" || extension === ".htm") return "html";
  if (extension === ".md" || extension === ".markdown") return "markdown";
  if (extension === ".json") return "json";
  if (file.kind === "image") return "image";
  if (!file.editable && file.kind === "document") return "embed";
  return null;
}

export function defaultDesignFileViewerMode(previewKind: DesignFilePreviewKind | null): DesignFileViewerMode {
  return previewKind ? "preview" : "source";
}
