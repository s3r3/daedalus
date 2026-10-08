import type { PptConfig, Project, ProjectWorkflowState } from "./types";

/** Older clarify-stage projects stored the deep-research choice only on the
 * launch chat turn. Read that durable context as a compatibility fallback;
 * newer projects also persist workflow.researchMode explicitly. */
export function projectHasResearchContext(project: Project): boolean {
  const messages = [
    ...(project.chat ?? []),
    ...(project.conversations ?? []).flatMap((conversation) => conversation.messages ?? []),
  ];
  return messages.some((message) => message.contextOptions?.some((option) => (
    option.kind === "research" || option.id === "research"
  )));
}

export function shouldResumeResearch(
  project: Project,
  config: PptConfig,
  workflow: Partial<ProjectWorkflowState>,
): boolean {
  if (typeof workflow.researchMode === "boolean") return workflow.researchMode;
  return config.mode === "research" || projectHasResearchContext(project);
}
