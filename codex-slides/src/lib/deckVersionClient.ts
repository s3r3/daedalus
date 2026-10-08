import type { DeckVersionDetail, DeckVersionSummary, Project } from "@/lib/types";

function baseUrl(projectId: string) {
  return `/api/projects/${encodeURIComponent(projectId)}/versions`;
}

async function json<T>(response: Response): Promise<T> {
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);
  return data as T;
}

export async function fetchDeckVersions(projectId: string): Promise<DeckVersionSummary[]> {
  const response = await fetch(baseUrl(projectId), { cache: "no-store" });
  const data = await json<{ versions?: DeckVersionSummary[] }>(response);
  return data.versions ?? [];
}

export async function fetchDeckVersion(projectId: string, versionId: string): Promise<DeckVersionDetail> {
  const response = await fetch(`${baseUrl(projectId)}/${encodeURIComponent(versionId)}`, { cache: "no-store" });
  return json<DeckVersionDetail>(response);
}

export async function restoreDeckVersionRequest(
  projectId: string,
  versionId: string,
): Promise<{ project: Project; version: DeckVersionSummary }> {
  const response = await fetch(`${baseUrl(projectId)}/${encodeURIComponent(versionId)}/restore`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({}),
  });
  return json<{ project: Project; version: DeckVersionSummary }>(response);
}

export function deckVersionSlideUrl(projectId: string, versionId: string, imageName?: string): string {
  if (!imageName) return "";
  return `${baseUrl(projectId)}/${encodeURIComponent(versionId)}/slides/${encodeURIComponent(imageName)}`;
}

export function deckVersionExportUrl(projectId: string, versionId: string, format: "pdf" | "pptx"): string {
  return `${baseUrl(projectId)}/${encodeURIComponent(versionId)}/export?format=${format}`;
}

