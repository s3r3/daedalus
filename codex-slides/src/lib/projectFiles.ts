import fs from "node:fs";
import path from "node:path";
import { projectDir } from "./store";
import type { CodexInputAttachment } from "./codex-text";
import type { DesignFileReference, ProjectFileRecord } from "./types";

const TEXT_EXTENSIONS = new Set([".md", ".txt", ".json", ".csv", ".tsv", ".html", ".htm", ".css", ".js", ".mjs", ".jsx", ".ts", ".tsx", ".yaml", ".yml", ".xml"]);
const IMAGE_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".webp", ".gif", ".svg"]);

export function filesDir(projectId: string) { return path.join(projectDir(projectId), "files"); }

export function safeProjectFile(projectId: string, relativePath: string): string | null {
  const root = path.resolve(filesDir(projectId));
  const resolved = path.isAbsolute(relativePath)
    ? path.resolve(relativePath)
    : path.resolve(root, relativePath.replace(/^[/\\]+/, ""));
  return resolved === root || resolved.startsWith(`${root}${path.sep}`) ? resolved : null;
}

function mimeTypeFor(name: string): string {
  switch (path.extname(name).toLowerCase()) {
    case ".png": return "image/png";
    case ".jpg":
    case ".jpeg": return "image/jpeg";
    case ".webp": return "image/webp";
    case ".gif": return "image/gif";
    case ".svg": return "image/svg+xml";
    case ".pdf": return "application/pdf";
    case ".md": return "text/markdown";
    case ".txt": return "text/plain";
    case ".json": return "application/json";
    case ".csv": return "text/csv";
    case ".tsv": return "text/tab-separated-values";
    case ".html":
    case ".htm": return "text/html";
    case ".css": return "text/css";
    case ".js":
    case ".mjs":
    case ".jsx": return "text/javascript";
    case ".ts":
    case ".tsx": return "text/typescript";
    case ".yaml":
    case ".yml": return "application/yaml";
    case ".xml": return "application/xml";
    default: return "application/octet-stream";
  }
}

function kindFor(name: string): ProjectFileRecord["kind"] {
  const ext = path.extname(name).toLowerCase();
  if (IMAGE_EXTENSIONS.has(ext)) return "image";
  // HTML is a presentation-native source format in Codex Slides. Keep it with
  // decks/documents in Design Files instead of presenting it as source code.
  if ([".md", ".txt", ".html", ".htm", ".pdf", ".doc", ".docx", ".ppt", ".pptx"].includes(ext)) return "document";
  if ([".json", ".csv", ".tsv", ".yaml", ".yml", ".xml"].includes(ext)) return "data";
  if ([".css", ".js", ".mjs", ".jsx", ".ts", ".tsx"].includes(ext)) return "code";
  return "other";
}

export function listProjectFiles(projectId: string): ProjectFileRecord[] {
  const root = filesDir(projectId);
  if (!fs.existsSync(root)) return [];
  const records: ProjectFileRecord[] = [];
  function visit(dir: string) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const absolute = path.join(dir, entry.name);
      if (entry.isDirectory()) visit(absolute);
      else if (entry.isFile()) {
        const stat = fs.statSync(absolute);
        const relative = path.relative(root, absolute).split(path.sep).join("/");
        records.push({
          path: relative,
          absolutePath: absolute,
          name: entry.name,
          kind: kindFor(entry.name),
          source: relative.startsWith("uploaded/") ? "uploaded" : "generated",
          size: stat.size,
          updatedAt: stat.mtime.toISOString(),
          editable: TEXT_EXTENSIONS.has(path.extname(entry.name).toLowerCase()) && stat.size <= 2 * 1024 * 1024,
        });
      }
    }
  }
  visit(root);
  return records.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

/**
 * Resolve user-selected Design Files paths against this project only. The
 * returned references keep absolute paths for local agents, while Responses
 * models receive the same selected files as input attachments.
 */
export function loadProjectFileReferences(
  projectId: string,
  requestedPaths: string[],
): { references: DesignFileReference[]; attachments: CodexInputAttachment[] } {
  const knownFiles = listProjectFiles(projectId);
  const byAbsolutePath = new Map(knownFiles.map((file) => [path.resolve(file.absolutePath), file]));
  const byRelativePath = new Map(knownFiles.map((file) => [file.path, file]));
  const references: DesignFileReference[] = [];
  const attachments: CodexInputAttachment[] = [];
  const seen = new Set<string>();
  let totalBytes = 0;

  for (const requested of requestedPaths.slice(0, 12)) {
    const raw = String(requested ?? "").trim();
    if (!raw) continue;
    const resolved = safeProjectFile(projectId, raw);
    const record = (resolved ? byAbsolutePath.get(path.resolve(resolved)) : undefined)
      ?? byRelativePath.get(raw.replace(/^[/\\]+/, ""));
    if (!record || seen.has(record.absolutePath)) continue;
    seen.add(record.absolutePath);

    const reference: DesignFileReference = {
      path: record.absolutePath,
      relativePath: record.path,
      name: record.name,
      kind: record.kind,
    };
    references.push(reference);

    // Keep the Responses request bounded. Local CLI agents still receive every
    // validated absolute path in the prompt and can read larger files directly.
    if (record.size > 20 * 1024 * 1024 || totalBytes + record.size > 40 * 1024 * 1024) continue;
    const bytes = fs.readFileSync(record.absolutePath);
    totalBytes += bytes.length;
    attachments.push({
      kind: record.kind === "image" ? "image" : "file",
      name: record.name,
      mimeType: mimeTypeFor(record.name),
      bytes,
      path: record.absolutePath,
    });
  }

  return { references, attachments };
}

export function uniqueUploadPath(projectId: string, originalName: string) {
  const clean = path.basename(originalName).replace(/[\u0000-\u001f\u007f]/g, "").slice(0, 180) || "upload";
  const dir = path.join(filesDir(projectId), "uploaded");
  fs.mkdirSync(dir, { recursive: true });
  let candidate = path.join(dir, clean);
  const ext = path.extname(clean); const stem = path.basename(clean, ext); let i = 2;
  while (fs.existsSync(candidate)) candidate = path.join(dir, `${stem}-${i++}${ext}`);
  return candidate;
}
