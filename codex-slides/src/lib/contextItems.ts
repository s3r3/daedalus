export type ContextItemKind = "image" | "file";

/** A staged user attachment shown in a composer and consumed by the model. */
export interface ContextItem {
  id: string;
  name: string;
  url: string;
  kind: ContextItemKind;
  mimeType: string;
  size: number;
}

export const CONTEXT_ITEM_ACCEPT = [
  "image/png",
  "image/jpeg",
  "image/webp",
  "image/gif",
  ".pdf",
  ".txt",
  ".md",
  ".json",
  ".html",
  ".xml",
  ".doc",
  ".docx",
  ".rtf",
  ".odt",
  ".ppt",
  ".pptx",
  ".csv",
  ".tsv",
  ".xls",
  ".xlsx",
  ".js",
  ".jsx",
  ".ts",
  ".tsx",
  ".py",
  ".java",
  ".c",
  ".cpp",
  ".h",
  ".go",
  ".rs",
  ".rb",
  ".php",
  ".css",
  ".yaml",
  ".yml",
  ".toml",
  ".sql",
  ".sh",
].join(",");

export interface ContextUploadResult {
  items: ContextItem[];
  errors: string[];
}

export interface ArchivedContextReference {
  path: string;
  relativePath: string;
  name: string;
  kind?: "document" | "image" | "data" | "code" | "other";
}

export function hasDraggedFiles(types: Iterable<string>): boolean {
  return Array.from(types).some((type) => type.toLocaleLowerCase() === "files");
}

export function contextItemMatchesAccept(item: Pick<ContextItem, "name" | "mimeType">, accept: string): boolean {
  const name = item.name.toLocaleLowerCase();
  const mime = item.mimeType.toLocaleLowerCase();
  return accept.split(",").some((raw) => {
    const token = raw.trim().toLocaleLowerCase();
    if (!token) return false;
    if (token.startsWith(".")) return name.endsWith(token);
    if (token.endsWith("/*")) return mime.startsWith(token.slice(0, -1));
    return mime === token;
  });
}

/** Upload files one at a time so one rejected item does not discard the rest. */
export async function uploadContextItems(files: Iterable<File>): Promise<ContextUploadResult> {
  const items: ContextItem[] = [];
  const errors: string[] = [];
  for (const file of Array.from(files)) {
    try {
      const form = new FormData();
      form.append("file", file);
      const response = await fetch("/api/materials", { method: "POST", body: form });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);
      items.push(data as ContextItem);
    } catch (error: any) {
      errors.push(`${file.name}: ${String(error?.message ?? error)}`);
    }
  }
  return { items, errors };
}

/** Move staged composer items into a project's Design Files immediately before
 * the turn is sent. The returned absolute paths are the durable agent context. */
export async function archiveContextItems(
  projectId: string,
  items: ContextItem[],
): Promise<ArchivedContextReference[]> {
  if (!items.length) return [];
  const response = await fetch(`/api/projects/${encodeURIComponent(projectId)}/files`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ materialIds: items.map((item) => item.id) }),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);
  const references = Array.isArray(data.references) ? data.references : [];
  if (!references.length) throw new Error("The uploaded files were not added to Design Files.");
  if (typeof window !== "undefined") {
    window.dispatchEvent(new CustomEvent("codex-slides:design-files-changed", {
      detail: { projectId },
    }));
  }
  return references as ArchivedContextReference[];
}

export function mergeContextItems(current: ContextItem[], incoming: ContextItem[]): ContextItem[] {
  const next = [...current];
  for (const item of incoming) {
    if (!next.some((existing) => existing.id === item.id)) next.push(item);
  }
  return next;
}
