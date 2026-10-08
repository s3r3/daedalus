// User context items: images become both multimodal text context and slide-image
// references; documents are preserved as original input_file items for Responses.
// Everything is staged before a project exists, then copied into that project.

import fs from "node:fs";
import path from "node:path";
import { DATA_ROOT } from "./dataPaths";
import { projectDir } from "./store";
import type { CodexInputAttachment } from "./codex-text";
import type { MaterialRecord } from "./types";

export const STAGING_DIR = path.join(DATA_ROOT, "materials-staging");

const ID_RE = /^[\w.-]+$/;
const IMAGE_EXT_RE = /\.(png|jpe?g|webp|gif)$/i;
const SUPPORTED_EXTENSIONS = new Set([
  ".png", ".jpg", ".jpeg", ".webp", ".gif",
  ".pdf", ".txt", ".md", ".json", ".html", ".xml",
  ".doc", ".docx", ".rtf", ".odt", ".ppt", ".pptx",
  ".csv", ".tsv", ".xls", ".xlsx",
  ".js", ".jsx", ".ts", ".tsx", ".py", ".java", ".c", ".cpp", ".h",
  ".go", ".rs", ".rb", ".php", ".css", ".yaml", ".yml", ".toml", ".sql", ".sh",
]);

export const MAX_CONTEXT_ITEM_BYTES = 20 * 1024 * 1024;

interface StagedMaterialInfo {
  id: string;
  name: string;
  kind: "image" | "file";
  mimeType: string;
  size: number;
}

function ensureDir(p: string) {
  fs.mkdirSync(p, { recursive: true });
}

function relativeDesignFilePath(projectId: string, absolutePath: string): string {
  return path.relative(path.join(projectDir(projectId), "files"), absolutePath).split(path.sep).join("/");
}

function sameFile(left: string, right: string): boolean {
  if (!fs.existsSync(left) || !fs.existsSync(right)) return false;
  const leftStat = fs.statSync(left);
  const rightStat = fs.statSync(right);
  if (!leftStat.isFile() || !rightStat.isFile() || leftStat.size !== rightStat.size) return false;
  return fs.readFileSync(left).equals(fs.readFileSync(right));
}

/** Copy one staged item into the user-visible Design Files upload folder.
 * Identical retries reuse the first copy; same-name files with different bytes
 * receive a numeric suffix. */
function archiveStagedMaterial(projectId: string, stagedId: string): string | null {
  const source = stagedPath(stagedId);
  if (!source) return null;
  const info = readStagedMaterialInfo(stagedId);
  const visibleDir = path.join(projectDir(projectId), "files", "uploaded");
  ensureDir(visibleDir);
  const visibleName = info?.name ?? stagedId;
  const ext = path.extname(visibleName);
  const stem = path.basename(visibleName, ext);
  let visiblePath = path.join(visibleDir, visibleName);
  let duplicate = 2;
  while (fs.existsSync(visiblePath) && !sameFile(source, visiblePath)) {
    visiblePath = path.join(visibleDir, `${stem}-${duplicate++}${ext}`);
  }
  if (!fs.existsSync(visiblePath)) fs.copyFileSync(source, visiblePath);
  return relativeDesignFilePath(projectId, visiblePath);
}

/** Persist staged composer items as ordinary project Design Files without
 * turning them into always-on deck materials. Returns validated relative paths
 * that can be resolved into agent-readable references for the current turn. */
export function archiveStagedMaterialsToDesignFiles(
  projectId: string,
  stagedIds: string[],
): string[] {
  const paths: string[] = [];
  for (const stagedId of Array.from(new Set(stagedIds))) {
    const archived = archiveStagedMaterial(projectId, stagedId);
    if (archived && !paths.includes(archived)) paths.push(archived);
  }
  return paths;
}

function extFromName(name: string): string {
  const ext = path.extname(name).toLowerCase();
  return SUPPORTED_EXTENSIONS.has(ext) ? ext : ".bin";
}

function cleanName(name: string): string {
  return path.basename(name).replace(/[\u0000-\u001f\u007f]/g, "").slice(0, 180) || "context-item";
}

function isImage(name: string, mimeType = ""): boolean {
  return /^image\/(png|jpe?g|webp|gif)$/i.test(mimeType) || IMAGE_EXT_RE.test(name);
}

function normalizedMimeType(name: string, mimeType = ""): string {
  if (mimeType && mimeType !== "application/octet-stream") return mimeType;
  switch (path.extname(name).toLowerCase()) {
    case ".png": return "image/png";
    case ".jpg":
    case ".jpeg": return "image/jpeg";
    case ".webp": return "image/webp";
    case ".gif": return "image/gif";
    case ".pdf": return "application/pdf";
    case ".txt": return "text/plain";
    case ".md": return "text/markdown";
    case ".json": return "application/json";
    case ".html": return "text/html";
    case ".xml": return "application/xml";
    case ".csv": return "text/csv";
    case ".tsv": return "text/tab-separated-values";
    default: return mimeType || "application/octet-stream";
  }
}

function metadataPath(id: string): string {
  return path.join(STAGING_DIR, `${id}.json`);
}

export function isSupportedContextItem(name: string, mimeType = ""): boolean {
  const ext = path.extname(name).toLowerCase();
  return SUPPORTED_EXTENSIONS.has(ext) || isImage(name, mimeType);
}

export function newMaterialId(name: string): string {
  const stamp = new Date().toISOString().replace(/[-:T.]/g, "").slice(0, 17);
  const rand = Math.random().toString(36).slice(2, 6);
  return `${stamp}-${rand}${extFromName(name)}`;
}

/** Stage an uploaded context item (no project yet), preserving display metadata. */
export function saveStagedMaterial(
  bytes: Buffer,
  name: string,
  mimeType = "application/octet-stream",
): StagedMaterialInfo {
  ensureDir(STAGING_DIR);
  const safeName = cleanName(name);
  const id = newMaterialId(safeName);
  const normalizedMime = normalizedMimeType(safeName, mimeType);
  const info: StagedMaterialInfo = {
    id,
    name: safeName,
    kind: isImage(safeName, normalizedMime) ? "image" : "file",
    mimeType: normalizedMime,
    size: bytes.length,
  };
  fs.writeFileSync(path.join(STAGING_DIR, id), bytes);
  fs.writeFileSync(metadataPath(id), JSON.stringify(info), "utf8");
  return info;
}

export function stagedPath(id: string): string | null {
  if (!ID_RE.test(id)) return null;
  const p = path.join(STAGING_DIR, id);
  return fs.existsSync(p) ? p : null;
}

export function readStagedMaterial(id: string): Buffer | null {
  const p = stagedPath(id);
  return p ? fs.readFileSync(p) : null;
}

export function readStagedMaterialInfo(id: string): StagedMaterialInfo | null {
  if (!ID_RE.test(id)) return null;
  try {
    const raw = JSON.parse(fs.readFileSync(metadataPath(id), "utf8"));
    return {
      id,
      name: cleanName(String(raw.name ?? id)),
      kind: raw.kind === "file" ? "file" : "image",
      mimeType: normalizedMimeType(String(raw.name ?? id), String(raw.mimeType ?? "")),
      size: Number(raw.size) || fs.statSync(path.join(STAGING_DIR, id)).size,
    };
  } catch {
    const source = stagedPath(id);
    if (!source) return null;
    return {
      id,
      name: id,
      kind: isImage(id) ? "image" : "file",
      mimeType: normalizedMimeType(id),
      size: fs.statSync(source).size,
    };
  }
}

/** Copy staged materials into a project dir; returns records for Project.materials. */
export function attachMaterialsToProject(
  projectId: string,
  stagedIds: string[],
): MaterialRecord[] {
  const dir = path.join(projectDir(projectId), "materials");
  ensureDir(dir);
  const records: MaterialRecord[] = [];
  for (const sid of stagedIds) {
    const src = stagedPath(sid);
    if (!src) continue;
    const info = readStagedMaterialInfo(sid);
    const file = `mat-${sid}`;
    fs.copyFileSync(src, path.join(dir, file));
    const designFilePath = archiveStagedMaterial(projectId, sid) ?? undefined;
    records.push({
      id: sid,
      name: info?.name ?? sid,
      file,
      designFilePath,
      kind: info?.kind ?? (isImage(sid) ? "image" : "file"),
      mimeType: info?.mimeType ?? normalizedMimeType(sid),
      size: info?.size,
    });
  }
  return records;
}

/** Load a project's material images as buffers (for use as refImages). */
export function loadProjectMaterialBuffers(
  projectId: string,
  records: MaterialRecord[] | undefined,
): Buffer[] {
  if (!records?.length) return [];
  const dir = path.join(projectDir(projectId), "materials");
  const out: Buffer[] = [];
  for (const r of records) {
    if (r.kind === "file" || (!r.kind && !isImage(r.file, r.mimeType))) continue;
    if (!ID_RE.test(r.file)) continue;
    const p = path.join(dir, r.file);
    if (fs.existsSync(p)) out.push(fs.readFileSync(p));
  }
  return out;
}

function toInputAttachment(bytes: Buffer, sourcePath: string, record: MaterialRecord): CodexInputAttachment {
  return {
    kind: record.kind ?? (isImage(record.file, record.mimeType) ? "image" : "file"),
    name: record.name || record.file,
    mimeType: normalizedMimeType(record.name || record.file, record.mimeType),
    bytes,
    path: sourcePath,
  };
}

/** Load staged originals for the initial outline request. */
export function loadStagedInputAttachments(ids: string[] | undefined): CodexInputAttachment[] {
  if (!ids?.length) return [];
  const out: CodexInputAttachment[] = [];
  for (const id of ids) {
    const source = stagedPath(id);
    const info = readStagedMaterialInfo(id);
    if (!source || !info) continue;
    out.push(toInputAttachment(fs.readFileSync(source), source, {
      id,
      name: info.name,
      file: id,
      kind: info.kind,
      mimeType: info.mimeType,
      size: info.size,
    }));
  }
  return out;
}

/** Load persisted originals for text/vision context during chat and regeneration. */
export function loadProjectInputAttachments(
  projectId: string,
  records: MaterialRecord[] | undefined,
): CodexInputAttachment[] {
  if (!records?.length) return [];
  const dir = path.join(projectDir(projectId), "materials");
  const out: CodexInputAttachment[] = [];
  for (const record of records) {
    if (!ID_RE.test(record.file)) continue;
    const materialSource = path.join(dir, record.file);
    const designSource = record.designFilePath
      ? path.resolve(path.join(projectDir(projectId), "files"), record.designFilePath)
      : null;
    const filesRoot = path.resolve(path.join(projectDir(projectId), "files"));
    const safeDesignSource = designSource
      && (designSource === filesRoot || designSource.startsWith(`${filesRoot}${path.sep}`))
      && fs.existsSync(designSource)
      ? designSource
      : null;
    const source = safeDesignSource ?? materialSource;
    if (!fs.existsSync(source)) continue;
    out.push(toInputAttachment(fs.readFileSync(source), source, record));
  }
  return out;
}

export function readProjectMaterial(projectId: string, file: string): Buffer | null {
  if (!ID_RE.test(file)) return null;
  const p = path.join(projectDir(projectId), "materials", file);
  return fs.existsSync(p) ? fs.readFileSync(p) : null;
}
